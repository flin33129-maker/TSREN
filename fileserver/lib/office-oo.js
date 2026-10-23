'use strict';
/**
 * ONLYOFFICE Document Server 接入层
 *
 * 解决三个问题：
 *  1) DS 在容器里，访问工作站不能带 Cookie → 用 HMAC 签名 token 做临时授权
 *  2) 编辑器配置必须 JWT 签名（DS 默认开启 JWT）
 *  3) 保存回调用 callback 下发新文件，需要落回原路径
 *
 * 对外路由（挂在 server.js）：
 *   GET  /api/office/oo/config?disk=&path=   → 返回签名好的编辑器配置
 *   GET  /api/office/oo/file?token=          → 无 Cookie，凭 token 出流（DS 拉文件）
 *   POST /api/office/oo/callback?token=      → DS 保存回调，下载并覆盖原文件
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

/* ------------------------------------------------------------------
 * R9-OP-1：JWT 密钥曾被硬编码成 'station-oo-secret'
 *   这串字面量在源码里（也在 git 历史里），任何拿到源码的人都能自己
 *   签一个合法 token，从而伪造 DS 回调 → 服务端把任意 URL 的内容
 *   写进任意文件（配合 R9-OP-2 的 SSRF 就是任意写 + 任意读内网）。
 *   现在：密钥运行时生成并持久化到 dataDir/oo-secret（0600），
 *   重启后保持不变 —— DS 容器侧必须用同一把，否则在线编辑的回调全废。
 *   opts.jwtSecret 优先（Lead 侧从 dataDir/oo-jwt.key 读）。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
 * R9-OP-2：DS 回调 URL 造成 SSRF → 任意文件写
 *   旧代码把请求体里的 url 直接 fetch 下来写进目标文件（还把
 *   host.docker.internal 替换成 127.0.0.1），攻击者只要能触发一次
 *   DS 回调，就能让服务端去拉云元数据（169.254.169.254）或内网任意
 *   地址，并把内容落到磁盘 —— 之前已经因此把整盘写满过一次。
 *   现在：URL 必须命中可信主机白名单；私网/环回地址默认拒绝；
 *   云元数据地址绝对拒绝（白名单也救不回来）；不跟随重定向（防 302 绕过）。
 * ------------------------------------------------------------------ */

/** 单次回写体积上限（默认 256MB，可由 opts.maxSaveBytes 覆盖） */
const DEFAULT_MAX_SAVE_BYTES = 256 * 1024 * 1024;
/** 下载超时（毫秒） */
const DOWNLOAD_TIMEOUT_MS = 120000;

/**
 * 绝对禁止的目标：云元数据 / 无效地址。
 * 与「白名单」不同，这里即便运维显式加了白名单也拒绝 ——
 * 元数据端点只可能意味着有人在探云凭据。
 */
const HARD_DENY_HOSTS = new Set([
  '0.0.0.0', '::', '[::]',
  '169.254.169.254',   // AWS / GCP / 阿里云元数据
  '169.254.170.2',    // AWS ECS 任务元数据
  '100.100.100.200',  // 阿里云元数据
  'metadata.google.internal',
  'metadata.goog',
]);

const OFFICE_EXT = {
  docx: 'word', doc: 'word', odt: 'word', rtf: 'word', txt: 'word',
  xlsx: 'cell', xls: 'cell', ods: 'cell', csv: 'cell',
  pptx: 'slide', ppt: 'slide', odp: 'slide',
};
const MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
};

/* ------------------------------ 主机判定工具 ------------------------------ */

/** 归一化主机名：去括号、去尾点、转小写 */
function normHost(h) {
  let s = String(h || '').trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

/** 是否 IPv4 字面量 */
function isIPv4(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    if (m[i].length > 1 && m[i][0] === '0') return false; // 拒绝 010.0.0.1 这种八进制歧义写法
  }
  return true;
}

/**
 * 私网 / 环回 / 链路本地 / CGNAT 判定。
 * 白名单之外的地址一律按「不可信」处理；这里给出精确原因，便于日志与断言。
 */
function isPrivateHost(h) {
  const host = normHost(h);
  if (!host) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // IPv4 映射的 IPv6（::ffff:127.0.0.1）必须按 IPv4 判，否则是绕过口子
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (host.startsWith('::ffff:')) return true;
  if (isIPv4(host)) return isPrivateIPv4(host);
  return false;
}

/** IPv4 私网段判定 */
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  const [a, b] = p;
  if (a === 0) return true;            // 0.0.0.0/8 「本网络」
  if (a === 10) return true;           // 10/8
  if (a === 127) return true;          // 127/8 环回
  if (a === 169 && b === 254) return true;  // 169.254/16 链路本地（含元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;  // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

/** 把 host:port / [v6]:port 拆成 {host, port} */
function splitHostPort(entry) {
  let s = String(entry || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return null;
    const host = s.slice(1, end);
    const rest = s.slice(end + 1);
    const port = rest.startsWith(':') ? rest.slice(1) : '';
    return { host: normHost(host), port: /^\d+$/.test(port) ? port : '' };
  }
  const idx = s.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(s.slice(idx + 1))) {
    return { host: normHost(s.slice(0, idx)), port: s.slice(idx + 1) };
  }
  return { host: normHost(s), port: '' };
}

/** 读密钥文件：内容必须是足够长的单行字符串 */
function readSecretFile(f) {
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s.length >= 16 && !/[\r\n]/.test(s)) return s;
  } catch { /* 不存在 */ }
  return '';
}

/** 写密钥文件：0600 + 显式 chmod（umask 会影响 writeFileSync 的 mode） */
function writeSecretFile(f, secret) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, secret, { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch { /* Windows 上 chmod 语义有限 */ }
    return true;
  } catch {
    return false;
  }
}

class OfficeOO {
  constructor(dataDir, opts) {
    opts = opts || {};
    this.dataDir = dataDir;
    this.secretFile = path.join(dataDir, 'oo-secret');    // 既有密钥文件（勿删，兼容旧部署）
    this.jwtKeyFile = path.join(dataDir, 'oo-jwt.key');   // Lead 侧约定的 JWT 密钥文件
    this.publicBase = opts.publicBase || '';   // 例如 http://192.168.8.122
    this.dsBase = opts.dsBase || '/onlyoffice'; // 反向代理前缀
    this.maxSaveBytes = Number(opts.maxSaveBytes) > 0 ? Number(opts.maxSaveBytes) : DEFAULT_MAX_SAVE_BYTES;

    const secrets = this._loadSecrets(opts);
    this.secret = secrets.token;     // 文件下载 token 的 HMAC 密钥
    this.jwtSecret = secrets.jwt;    // DS 配置 / 回调 token 的 JWT 密钥

    this.allowedHosts = this._resolveAllowedHosts(opts);
    /* R9：容器名 → 宿主机可达地址的改写表。
       DS 回调里的 url 用的是**容器自己的主机名**（如 onlyoffice 或容器 id），
       宿主机解析不了这个名字 —— 不改写就必然下载失败（不是安全问题，是功能问题）。
       白名单校验针对的是**原始主机名**（防伪造），改写只发生在校验通过之后。 */
    this.hostRewrite = (opts && opts.hostRewrite && typeof opts.hostRewrite === 'object') ? opts.hostRewrite : {};
    this.sessions = new Map(); // key -> {abs, disk, path, uid}
  }

  /**
   * R9-OP-1：解析并持久化密钥。
   * 优先级：opts.jwtSecret → <dataDir>/oo-jwt.key → <dataDir>/oo-secret → 随机生成。
   * 兼容既有 data/oo-secret：文件存在就复用（内容不改），让两处密钥保持一致。
   */
  _loadSecrets(opts) {
    const fileSecret = readSecretFile(this.secretFile);
    const keyFileSecret = readSecretFile(this.jwtKeyFile);

    let jwt = '';
    if (opts.jwtSecret && String(opts.jwtSecret).trim().length >= 16) jwt = String(opts.jwtSecret).trim();
    else if (keyFileSecret) jwt = keyFileSecret;
    else if (fileSecret) jwt = fileSecret;

    let token = fileSecret;

    if (!jwt) {
      /* 三个来源都没有 → 运行时生成一把，落盘到 oo-secret（并同步 oo-jwt.key） */
      jwt = crypto.randomBytes(32).toString('hex');
      writeSecretFile(this.secretFile, jwt);
      writeSecretFile(this.jwtKeyFile, jwt);
      token = jwt;
    } else if (!token) {
      /* 只有 JWT 密钥来源 → 让 oo-secret 与之同值，避免两处密钥打架 */
      token = jwt;
      writeSecretFile(this.secretFile, jwt);
    } else if (!keyFileSecret && opts.jwtSecret) {
      /* 磁盘上没有 oo-jwt.key 但调用方给了密钥 → 同步落盘，方便下次启动复用 */
      writeSecretFile(this.jwtKeyFile, jwt);
    }
    return { token, jwt };
  }

  /**
   * R9-OP-2：可信主机白名单。
   * 顺序：opts.allowedHosts → 环境变量 OO_ALLOWED_HOSTS → 由 publicBase 推导。
   * 推导出的 host.docker.internal 额外等价于 127.0.0.1（与既有改写逻辑一致）。
   */
  _resolveAllowedHosts(opts) {
    let list = [];
    const src = opts.allowedHosts != null ? opts.allowedHosts : process.env.OO_ALLOWED_HOSTS;
    if (Array.isArray(src)) list = src.slice();
    else if (typeof src === 'string') list = src.split(/[,\s]+/);
    if (!list.length) {
      const h = this._hostOfBase(this.publicBase);
      if (h) list.push(h);
    }
    /* host.docker.internal 在宿主机上就是回环地址（DS 容器常用这个名字回调），
       显式加白名单时同样要带上，否则改写后的 127.0.0.1 会被私网规则拦下 */
    if (list.some((x) => normHost(x) === 'host.docker.internal') && !list.some((x) => normHost(x) === '127.0.0.1')) {
      list.push('127.0.0.1');
    }
    return list.map((x) => String(x || '').trim()).filter(Boolean);
  }

  /** 从 base url 里取主机名 */
  _hostOfBase(base) {
    try { return normHost(new URL(String(base)).hostname); } catch { return ''; }
  }

  /** 白名单匹配：支持 'host' 与 'host:port' 两种写法 */
  _matchHost(host, port) {
    const h = normHost(host);
    if (!h) return null;
    for (const entry of this.allowedHosts) {
      const p = splitHostPort(entry);
      if (!p || p.host !== h) continue;
      if (p.port && String(port || '') !== p.port) continue;
      return p;
    }
    return null;
  }

  /**
   * R9-OP-2：校验回调 URL 是否可信。
   * @returns {{ok:boolean, error?:string, url?:URL, host?:string}}
   */
  checkUrl(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl || '')); } catch { return { ok: false, error: '回调 URL 非法' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: '回调仅允许 http/https，收到 ' + u.protocol };
    }
    const host = normHost(u.hostname);
    if (!host) return { ok: false, error: '回调 URL 缺少主机名' };

    /* 既有约定：DS 容器用 host.docker.internal 回调，宿主机上要换成回环地址 */
    const eff = host === 'host.docker.internal' ? '127.0.0.1' : host;
    /* URL 会把默认端口归一化成空串，白名单里写 ':80'/':443' 时要按默认端口比 */
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');

    if (HARD_DENY_HOSTS.has(host) || HARD_DENY_HOSTS.has(eff)) {
      return { ok: false, error: '禁止访问该地址（云元数据 / 非法目标）：' + host };
    }
    const m = this._matchHost(host, port) || this._matchHost(eff, port);
    if (!m) {
      return { ok: false, error: '回调主机不在白名单：' + host + '（当前白名单：' + (this.allowedHosts.join(',') || '空') + '）' };
    }
    /* 白名单之外一律拒绝私网；白名单命中说明运维显式信任该地址（DS 容器就在局域网里） */
    if (isPrivateHost(eff) && !this._matchHost(eff, port)) {
      return { ok: false, error: '拒绝私网/环回地址：' + eff };
    }
    /* R9：把容器名改写成宿主机上真实可达的地址（校验通过之后才改写）。
       - host.docker.internal → 127.0.0.1（既有约定）
       - 容器名（onlyoffice 等）→ 宿主机上 DS 的发布端口 127.0.0.1:8090 */
    const rw = this.hostRewrite[host] || (host === 'host.docker.internal' ? '127.0.0.1' : '');
    if (rw) {
      const rp = splitHostPort(rw);
      if (rp && rp.host) {
        try {
          u.hostname = rp.host;
          if (rp.port) u.port = rp.port;
        } catch (e) { /* 改写失败就按原样返回，交给 fetch 去报错 */ }
      }
    }
    return { ok: true, url: u, host: eff };
  }

  /** 签名 token：base64url(payload).hmac */
  sign(payload, ttlSec) {
    const body = {
      d: payload.disk,
      p: payload.path,
      u: payload.uid || '',
      n: payload.name || '',
      e: Math.floor(Date.now() / 1000) + (ttlSec || 3600),
    };
    const p = Buffer.from(JSON.stringify(body)).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(p).digest('base64url');
    return p + '.' + sig;
  }

  verify(token) {
    if (!token || typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i <= 0) return null;
    const p = token.slice(0, i);
    const sig = token.slice(i + 1);
    const want = crypto.createHmac('sha256', this.secret).update(p).digest('base64url');
    if (sig.length !== want.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    let body;
    try { body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (e) { return null; }
    if (!body || body.e < Math.floor(Date.now() / 1000)) return null;
    return body;
  }

  /** HS256 JWT，用于 DS 配置签名 */
  jwt(payload) {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const s = crypto.createHmac('sha256', this.jwtSecret).update(h + '.' + p).digest('base64url');
    return h + '.' + p + '.' + s;
  }

  supported(filePath) {
    const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
    return !!OFFICE_EXT[ext];
  }

  /** 生成编辑器配置 */
  buildConfig(abs, disk, relPath, user, host) {
    const ext = path.extname(abs).slice(1).toLowerCase();
    const docType = OFFICE_EXT[ext];
    if (!docType) return null;
    const st = fs.statSync(abs);
    const base = this.publicBase || ('http://' + (host || '127.0.0.1'));
    const token = this.sign({ disk, path: relPath, uid: user && user.id, name: user && user.username }, 3600);
    // key 随内容变化，避免 DS 复用旧缓存
    const key = crypto.createHash('md5').update(abs + ':' + st.mtimeMs + ':' + st.size).digest('hex');
    this.sessions.set(key, { abs, disk, path: relPath, uid: user && user.id });

    const cfg = {
      documentType: docType,
      document: {
        fileType: ext,
        key,
        title: path.basename(abs),
        url: base + '/api/office/oo/file?token=' + encodeURIComponent(token),
        permissions: { edit: true, download: true, print: true, review: true, comment: true },
      },
      editorConfig: {
        mode: 'edit',
        lang: 'zh-CN',
        callbackUrl: base + '/api/office/oo/callback?token=' + encodeURIComponent(token) + '&key=' + key,
        user: {
          id: String((user && user.id) || 'guest'),
          name: String((user && (user.nickname || user.username)) || '访客'),
        },
        customization: {
          autosave: true,
          forcesave: true,
          compactHeader: false,
          toolbarNoTabs: false,
          chat: true,
          comments: true,
          plugins: false,
          uiTheme: 'theme-dark',
        },
      },
    };
    cfg.token = this.jwt(cfg);
    return { cfg, ext, docType, key };
  }

  /** 调用 DS CommandService（forcesave 等），用于让"保存"变成可控动作 */
  async command(c, key) {
    const payload = { c, key };
    const jwt = this.jwt(payload);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch('http://127.0.0.1:8090/coauthoring/CommandService.ashx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const j = await r.json().catch(() => ({}));
      return j;
    } catch (e) {
      return { error: 'request failed: ' + String(e.message || e).slice(0, 80) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * R9-OP-2：流式下载到临时文件，超限即中止，随后原子替换目标文件。
   * 失败路径必须「先 destroy 写流再 unlink」——否则已删除文件仍被 fd 占住，
   * 空间不回收（这台机器已经因此整盘写满过一次）。
   */
  async _downloadTo(rawUrl, destAbs, maxBytes) {
    const limit = Number(maxBytes) > 0 ? Number(maxBytes) : this.maxSaveBytes;
    const chk = this.checkUrl(rawUrl);
    if (!chk.ok) return { ok: false, error: chk.error };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
    const tmp = destAbs + '.oo-tmp-' + crypto.randomBytes(6).toString('hex');
    let ws = null;
    try {
      /* redirect:'manual' —— 302 会被当成普通响应拒绝，防止跳转绕过白名单 */
      const r = await fetch(chk.url.toString(), { signal: ac.signal, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400) throw new Error('拒绝跟随重定向（HTTP ' + r.status + '）');
      if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
      const len = Number(r.headers.get('content-length') || 0);
      if (len && len > limit) throw new Error('文件超过体积上限（' + len + ' > ' + limit + ' 字节）');
      if (!r.body) throw new Error('响应没有内容');

      const body = Readable.fromWeb(r.body);
      ws = fs.createWriteStream(tmp, { mode: 0o600 });
      let size = 0;

      await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (e) => {
          if (settled) return;
          settled = true;
          try { body.destroy(); } catch { /* 已断 */ }
          try { ws.destroy(); } catch { /* 已断 */ }
          reject(e);
        };
        body.on('data', (c) => {
          if (settled) return;
          size += c.length;
          if (size > limit) { fail(new Error('文件超过体积上限（>' + limit + ' 字节）')); return; }
          if (!ws.write(c)) body.pause();
        });
        ws.on('drain', () => body.resume());
        body.on('error', fail);
        body.on('end', () => { try { ws.end(); } catch { /* 已断 */ } });
        ws.on('error', fail);
        ws.on('finish', () => { if (settled) return; settled = true; resolve(); });
        body.resume();
      });

      if (!size) throw new Error('空响应体');
      fs.renameSync(tmp, destAbs);   // 同目录临时文件 → 原子替换
      return { ok: true, bytes: size };
    } catch (e) {
      /* 先 destroy 写流再 unlink：否则 fd 仍占着已删除文件的空间 */
      try { ac.abort(); } catch { /* 已断 */ }
      try {
        if (ws) {
          ws.destroy();
          /* 等写流真正关闭（Windows 上句柄未释放时 unlink 会失败） */
          await new Promise((r) => {
            if (ws.closed) return r();
            ws.once('close', r);
            setTimeout(r, 1000);
          });
        }
      } catch { /* 忽略 */ }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      return { ok: false, error: String((e && e.message) || e || '下载失败').slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 用 DS 给出的 url 覆盖目标文件（不依赖内存 session） */
  async applySave(abs, url) {
    const r = await this._downloadTo(url, abs, this.maxSaveBytes);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, saved: true, bytes: r.bytes };
  }

  /** callback：DS 保存完成，下载新版本覆盖原文件 */
  async handleCallback(query, body, readJson) {
    const t = this.verify(query.token);
    if (!t) return { code: 403, body: { error: 'bad token' } };
    const data = readJson || {};
    const status = Number(data.status);
    if (status === 2 || status === 6) {
      if (!data.url) return { code: 400, body: { error: 'no url' } };
      const abs = await this._resolveFromSession(query.key, t);
      if (!abs) return { code: 404, body: { error: 'session lost' } };
      const r = await this._downloadTo(data.url, abs, this.maxSaveBytes);
      if (!r.ok) return { code: 500, body: { error: 1, message: r.error } };
      return { code: 200, body: { error: 0, saved: true, bytes: r.bytes } };
    }
    return { code: 200, body: { error: 0 } };
  }

  _resolveFromSession(key, t) {
    const s = this.sessions.get(String(key || ''));
    if (s && fs.existsSync(s.abs)) return s.abs;
    return null;
  }
}

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  const http = require('http');
  let fail = 0;
  let pass = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`✓  ${name}`); }
    else { fail++; console.log(`✗  ${name}${extra ? '  →  ' + extra : ''}`); }
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ootest-'));
  const cleanup = () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ } };

  (async () => {
    /* ---------- R9-OP-1：密钥 ---------- */
    const d1 = path.join(tmpRoot, 'd1');
    fs.mkdirSync(d1, { recursive: true });
    const a1 = new OfficeOO(d1, {});
    const a2 = new OfficeOO(d1, {});
    check('JWT 密钥不再是硬编码旧值', a1.jwtSecret !== 'station-oo-secret', a1.jwtSecret);
    check('两次实例密钥一致（持久化）', a1.jwtSecret === a2.jwtSecret);
    check('密钥已落盘到 oo-secret', fs.existsSync(path.join(d1, 'oo-secret')));
    check('落盘内容与内存一致', fs.readFileSync(path.join(d1, 'oo-secret'), 'utf8').trim() === a1.jwtSecret);
    if (process.platform === 'win32') {
      console.log('·  （Windows 不支持 POSIX 权限位，跳过 mode 0600 断言）');
    } else {
      check('oo-secret 权限 0600', (fs.statSync(path.join(d1, 'oo-secret')).mode & 0o777) === 0o600);
    }

    /* 既有 oo-secret 必须继续可用（向后兼容），且不被覆盖 */
    const d2 = path.join(tmpRoot, 'd2');
    fs.mkdirSync(d2, { recursive: true });
    const legacy = 'a'.repeat(64);
    fs.writeFileSync(path.join(d2, 'oo-secret'), legacy);
    const a3 = new OfficeOO(d2, {});
    check('既有 oo-secret 被复用且内容未变', a3.jwtSecret === legacy && fs.readFileSync(path.join(d2, 'oo-secret'), 'utf8').trim() === legacy);
    check('既有 oo-secret 未被覆盖（向后兼容）', fs.readFileSync(path.join(d2, 'oo-secret'), 'utf8').trim() === legacy);

    /* opts.jwtSecret 优先 */
    const a4 = new OfficeOO(d2, { jwtSecret: 'b'.repeat(64) });
    check('opts.jwtSecret 优先于文件', a4.jwtSecret === 'b'.repeat(64));

    /* token 签名/验签仍可用 */
    const tok = a1.sign({ disk: 'public', path: 'x.docx', uid: 'u1' }, 60);
    check('token 签发/验签可用', !!a1.verify(tok));

    /* ---------- R9-OP-2：SSRF ---------- */
    let body = Buffer.from('hello-oo');
    const srv = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
      if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.alloc(64 * 1024, 0x41)); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(body);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const base = 'http://127.0.0.1:' + port;

    const target = path.join(tmpRoot, 'target.bin');
    fs.writeFileSync(target, 'ORIGINAL');

    /* 默认（无白名单）→ 127.0.0.1 必须被拒 */
    const noList = new OfficeOO(d1, { publicBase: '' });
    const r1 = await noList.applySave(target, base + '/x');
    check('127.0.0.1 默认被拒（未加白名单）', !r1.ok && /白名单|私网|环回/.test(r1.error || ''), JSON.stringify(r1));

    /* 非白名单主机被拒 */
    const r2 = await noList.applySave(target, 'http://example.com/x');
    check('非白名单主机被拒', !r2.ok, JSON.stringify(r2));

    /* 云元数据地址：即便加进白名单也绝对拒绝 */
    const withMeta = new OfficeOO(d1, { allowedHosts: ['169.254.169.254', '127.0.0.1'] });
    const r3 = await withMeta.applySave(target, 'http://169.254.169.254/latest/meta-data/');
    check('云元数据地址被拒（白名单也救不回来）', !r3.ok, JSON.stringify(r3));

    /* 白名单主机 + 正常内容 → 成功 */
    const ok = new OfficeOO(d1, { allowedHosts: ['127.0.0.1'] });
    const r4 = await ok.applySave(target, base + '/x');
    check('白名单主机回写成功', r4.ok && r4.bytes === body.length, JSON.stringify(r4));
    check('目标文件内容已更新', fs.readFileSync(target, 'utf8') === 'hello-oo');

    /* 重定向被拒 */
    const r5 = await ok.applySave(target, base + '/redirect');
    check('重定向被拒（防 302 绕过）', !r5.ok && /重定向/.test(r5.error || ''), JSON.stringify(r5));

    /* 体积超限被拒，且不留临时文件 */
    const small = new OfficeOO(d1, { allowedHosts: ['127.0.0.1'], maxSaveBytes: 1024 });
    const before = fs.readFileSync(target, 'utf8');
    const r6 = await small.applySave(target, base + '/big');
    const leftovers = fs.readdirSync(tmpRoot).filter((f) => f.includes('.oo-tmp-'));
    check('超过体积上限被拒', !r6.ok && /上限/.test(r6.error || ''), JSON.stringify(r6));
    check('超限后目标文件未被破坏', fs.readFileSync(target, 'utf8') === before);
    check('超限后无临时文件残留', leftovers.length === 0, leftovers.join(','));

    /* 非 http(s) 协议被拒 */
    const r7 = await ok.applySave(target, 'file:///etc/passwd');
    check('非 http/https 协议被拒', !r7.ok, JSON.stringify(r7));

    /* 白名单带端口：端口必须对上 */
    const withPort = new OfficeOO(d1, { allowedHosts: ['127.0.0.1:' + port] });
    const r8 = await withPort.applySave(target, base + '/x');
    check('白名单 host:port 命中', r8.ok, JSON.stringify(r8));
    const otherPort = new OfficeOO(d1, { allowedHosts: ['127.0.0.1:1'] });
    const r9 = await otherPort.applySave(target, base + '/x');
    check('白名单端口不匹配被拒', !r9.ok, JSON.stringify(r9));

    srv.close();
    cleanup();
    console.log(`\n断言 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
    if (fail) { console.log('自测未通过'); process.exit(1); }
    console.log('自测全部通过');
    process.exit(0);
  })().catch((e) => {
    console.error('✗  自测异常:', e);
    try { cleanup(); } catch { /* 忽略 */ }
    process.exit(1);
  });
}

module.exports = { OfficeOO, OFFICE_EXT, MIME, DEFAULT_MAX_SAVE_BYTES, HARD_DENY_HOSTS, isPrivateHost, normHost };

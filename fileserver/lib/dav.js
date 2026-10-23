'use strict';

/* =====================================================================
   lib/dav.js — WebDAV Class 1+2（映射到 FileServer 的盘符体系）
   挂载点: http://<ip>:<port>/dav/<disk>/<path>
     <disk> = public | private | ext:XXXX-XXXX
   认证   : HTTP Basic → UserStore（游客仅公共盘只读）
   特性   : PROPFIND(depth 0/1/infinity封顶) / PROPPATCH / MKCOL
            GET/HEAD(Range) / PUT(流式+版本存档) / DELETE(回收站)
            COPY / MOVE（含跨盘） / LOCK / UNLOCK（Windows Office 需要）

   安全基线（本次加固）
   ------------------------------------------------------------------
   ① PUT 改为**边收边计配额**：原先只按 content-length 预检，
      而 chunked 传输（没有 content-length）会带着 0 字节通过预检，
      等于可以绕过 64GB 公共盘硬上限。现在按实际收到的字节累计，
      超出即刻中断并清理临时文件（先 destroy 写流再 unlink）。
   ② COPY / MOVE 增加目标盘配额预检：复制大文件同样会占空间，
      原先完全没有配额判断。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readBody, mimeOf } = require('./util');

const DAV_PREFIX = '/dav';
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';
const MAX_INFINITY_ENTRIES = 8000;

/* ---------- 小工具 ---------- */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function encodeHref(p) {
  // RFC 4918 要求 href 必须是 URI，但本服务对中文走「UTF-8 原文」（历史验证：
  // 对 CJK 做百分号编码会让部分客户端把名字显示成 %E6%96%B0 这样的字面串）。
  // 然而有三个字符必须转义，否则整条链会静默损坏：
  //   % -> 客户端当作残缺转义 -> url.Parse 失败 -> **文件整个消失**（rclone 报
  //        invalid URL escape "%.j"，用户侧表现是文件不存在且不报错）
  //   # -> 客户端当作 URI fragment 分隔符 -> **文件名被截断**（
  //        110kV青施二#0069塔.jpg 会只剩 110kV青施二，扩展名一起丢）
  //   ? -> 同属查询串分隔符，与 # 同类
  // 其余字符一律原样输出（中文、空格、& + ; @ = ' 等均已实测正常）。
  // 注意顺序：% 必须先替换，否则我们引入的 %23 / %3F 里的 % 会被二次转义。
  return String(p)
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}
function parseBasic(h) {
  if (!h || !/^basic\s+/i.test(h)) return null;
  try {
    const dec = Buffer.from(h.replace(/^basic\s+/i, '').trim(), 'base64').toString('utf8');
    const idx = dec.indexOf(':');
    if (idx < 0) return null;
    return { username: dec.slice(0, idx), password: dec.slice(idx + 1) };
  } catch { return null; }
}
function parseTimeout(h) {
  if (!h) return 600;
  const m = /Second-(\d+)/i.exec(h);
  if (!m) return 600;
  return Math.min(Math.max(parseInt(m[1], 10) || 600, 60), 24 * 3600);
}
function parseDepth(req) {
  const d = (req.headers.depth || 'infinity').toLowerCase();
  if (d === '0') return 0;
  if (d === '1') return 1;
  return Infinity; // infinity
}

/* ---------- WebDAV 主体 ---------- */
class Dav {
  /** @param {import('../server')} srv FileServer 实例 */
  constructor(srv) {
    this.srv = srv;
    this.locks = new Map(); // absPath -> { token, owner, expires, timeout }
    // 定期清理过期锁
    this._timer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.locks) if (v.expires < now) this.locks.delete(k);
    }, 60 * 1000);
    if (this._timer.unref) this._timer.unref();
  }

  /* ============ 入口 ============ */
  async handle(req, res, pathname) {
    const m = req.method;

    /* OPTIONS：能力声明 */
    if (m === 'OPTIONS') {
      res.writeHead(200, {
        DAV: '1, 2',
        'MS-Author-Via': 'DAV',
        Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK',
        'Content-Length': 0,
      });
      return res.end();
    }

    /* Basic 认证（Windows WebClient 先发 NTLM Negotiate，此处引导降级为 Basic） */
    let user = null;
    const authz = req.headers.authorization || '';
    if (authz && !/^basic\s+/i.test(authz)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Files-DAV", charset="UTF-8"', 'Content-Length': 0 });
      return res.end();
    }
    const basic = parseBasic(authz);
    if (basic) {
      user = this.srv.users.verify(basic.username, basic.password) || null;
      if (!user) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Files-DAV", charset="UTF-8"', 'Content-Length': 0 });
        return res.end();
      }
    }

    /* 解析 /dav/<disk>/<rest> */
    const rest = pathname.slice(DAV_PREFIX.length).replace(/^\/+/, '');
    const slash = rest.indexOf('/');
    const diskPart = slash < 0 ? rest : rest.slice(0, slash);
    const relPath = slash < 0 ? '' : rest.slice(slash + 1).replace(/^\/+/, '');

    try {
      switch (m) {
        case 'PROPFIND':  return await this.propfind(req, res, diskPart, relPath, user);
        case 'PROPPATCH': return await this.proppatch(req, res, diskPart, relPath, user);
        case 'GET':
        case 'HEAD':      return this.get(req, res, diskPart, relPath, user, m === 'HEAD');
        case 'PUT':       return await this.put(req, res, diskPart, relPath, user);
        case 'DELETE':    return await this.del(req, res, diskPart, relPath, user);
        case 'MKCOL':     return await this.mkcol(req, res, diskPart, relPath, user);
        case 'COPY':
        case 'MOVE':      return await this.copyMove(req, res, diskPart, relPath, user, m === 'MOVE');
        case 'LOCK':      return await this.lock(req, res, diskPart, relPath, user);
        case 'UNLOCK':    return await this.unlock(req, res, diskPart, relPath, user);
        default:
          res.writeHead(405, { Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK', 'Content-Length': 0 });
          return res.end();
      }
    } catch (err) {
      console.error('[dav]', m, pathname, err);
      try { res.writeHead(500, { 'Content-Length': 0 }); res.end(); } catch { /* closed */ }
    }
  }

  /* ============ 目标解析（带缓存） ============ */
  target(diskPart, relPath, user, write) {
    if (!diskPart) return { virtualRoot: true };           // /dav 根：虚拟目录
    const disk = this.unaliasDisk(diskPart);
    const t = this.srv.resolveTarget({ disk, path: relPath, _write: !!write }, user);
    if (t.error) return { error: t.error, code: t.code };
    return t;
  }

  /**
   * 盘符别名解析（双向兼容）：
   * 展示名 公共/私人/4T ←→ 实际盘符 public/private/ext:<UUID>
   * 兼容旧式 public/private/ext-XXXX 与原生 ext:XXXX 写法
   */
  unaliasDisk(name) {
    if (name === '公共') return 'public';
    if (name === '私人') return 'private';
    if (name === 'public' || name === 'private') return name;
    let m = /^ext-(.+)$/.exec(name);                        // 旧式 ext-UUID（冒号的 Windows 安全写法）
    if (m) return 'ext:' + m[1];
    m = /^(\d+(?:\.\d+)?)T$/i.exec(name);                   // 4T → 按容量匹配外置盘
    if (m) {
      const want = parseFloat(m[1]);
      const hit = this.srv.scanExternal().find((e) => Math.round((e.total || 0) / 1099511627776) === want);
      if (hit) return 'ext:' + hit.label;
    }
    /* ⚠️ 用户自定义显示名（data/disk-labels.json 里的卷标，如 K1 / NF-G1）也必须能反查。
       只加显示侧不加这里，会出现「目录列得出来、点进去报句柄无效」——
       因为 /K1/ 解析不到磁盘，resolveTarget 拿不到根目录。
       ⚠️⚠️ 必须走 findDiskByTitle（纯查缓存表）；直接调 scanExternal() 会给
       "每个请求"都加上一轮 U 盘写删探针，把目录列举拖到 I/O 超时。 */
    const byTitle = this.srv.findDiskByTitle ? this.srv.findDiskByTitle(name) : null;
    if (byTitle) return byTitle;
    return name;                                            // 原样（含 ext:XXXX 直接写法）
  }

  /** 盘符的 WebDAV 展示名（挂载后即资源管理器里的文件夹名） */
  davDiskName(d) {
    if (d.id === 'public') return '公共';
    if (d.id === 'private') return '私人';
    if (d.id.startsWith('ext:')) {
      /* 优先用用户设定的显示名（data/disk-labels.json，通常是磁盘的真实卷标）。
         没有才回退到「容量名 / ext-UUID」这套历史规则。 */
      if (d.title) return d.title;
      const tb = (d.quota || 0) / 1099511627776;            // listDisks 把外置盘总容量放在 quota
      if (tb >= 0.5) return Math.round(tb) + 'T';           // 4000769372160 → 4T
      return 'ext-' + d.id.slice(4);                        // 容量未知时回退稳定名
    }
    return d.id;
  }
  denyWrite(user, res) {
    const deny = this.srv.requireWrite(user);
    if (!deny) return false;
    const code = deny.code || 401;
    const h = { 'Content-Length': 0 };
    if (code === 401) h['WWW-Authenticate'] = 'Basic realm="Files-DAV", charset="UTF-8"';
    res.writeHead(code, h);
    res.end();
    return true;
  }

  /* ============ XML 生成 ============ */
  responseXml(href, isDir, st, locks) {
    let x = '<D:response><D:href>' + esc(encodeHref(href)) + '</D:href><D:propstat><D:prop>';
    x += '<D:displayname>' + esc(path.posix.basename(href.replace(/\/$/, '')) || '/') + '</D:displayname>';
    if (st) {
      x += '<D:getcontentlength>' + (isDir ? 0 : st.size) + '</D:getcontentlength>';
      x += '<D:getlastmodified>' + new Date(st.mtimeMs).toUTCString() + '</D:getlastmodified>';
      x += '<D:creationdate>' + new Date(st.ctimeMs).toISOString() + '</D:creationdate>';
      x += '<D:getcontenttype>' + esc(isDir ? 'httpd/unix-directory' : mimeOf(href)) + '</D:getcontenttype>';
      x += '<D:getetag>&quot;' + (st.size + '-' + Math.floor(st.mtimeMs / 1000)).toString(16) + '&quot;</D:getetag>';
    }
    x += isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
    x += '<D:supportedlock>'
      + '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>'
      + '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>'
      + '</D:supportedlock>';
    if (locks && locks.length) {
      x += '<D:lockdiscovery>';
      for (const L of locks) x += this.activeLockXml(L);
      x += '</D:lockdiscovery>';
    } else x += '<D:lockdiscovery/>';
    x += '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
    return x;
  }
  activeLockXml(L) {
    return '<D:activelock>'
      + '<D:locktype><D:write/></D:locktype>'
      + '<D:lockscope><D:exclusive/></D:lockscope>'
      + '<D:depth>0</D:depth>'
      + '<D:owner>' + esc(L.owner || '') + '</D:owner>'
      + '<D:timeout>Second-' + Math.max(0, Math.floor((L.expires - Date.now()) / 1000)) + '</D:timeout>'
      + '<D:locktoken><D:href>' + esc(L.token) + '</D:href></D:locktoken>'
      + '</D:activelock>';
  }
  send207(res, body) {
    const buf = Buffer.from(XML_HEAD + '<D:multistatus xmlns:D="DAV:">' + body + '</D:multistatus>', 'utf8');
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  }

  /* ============ PROPFIND ============ */
  async propfind(req, res, diskPart, relPath, user) {
    await readBody(req, 1024 * 1024).catch(() => Buffer.alloc(0)); // 丢弃请求体
    const depth = parseDepth(req);

    /* 虚拟根：列出可用盘 */
    if (!diskPart) {
      let body = this.responseXml(DAV_PREFIX + '/', true, null, []);
      if (depth >= 1) {
        const disks = this.srv.listDisks(user);
        const usedNames = new Set();
        for (const d of disks) {
          let nm = this.davDiskName(d);
          if (usedNames.has(nm)) nm += '-' + d.id.slice(-4);  // 同容量盘去重（如两块 4T）
          usedNames.add(nm);
          const href = DAV_PREFIX + '/' + nm + '/';
          body += this.responseXml(href, true, null, []);
        }
      }
      return this.send207(res, body);
    }

    const t = this.target(diskPart, relPath, user, false);
    if (t.error) { res.writeHead(t.code || 400, { 'Content-Length': 0 }); return res.end(); }

    let st;
    try { st = fs.statSync(t.abs); } catch {
      res.writeHead(404, { 'Content-Length': 0 }); return res.end();
    }

    const baseHref = DAV_PREFIX + '/' + diskPart + '/' + relPath;
    const isDir = st.isDirectory();
    const locks = this.locksFor(t.abs);
    let body = this.responseXml(isDir ? baseHref.replace(/\/?$/, '/') : baseHref, isDir, st, locks);

    if (depth >= 1 && isDir) {
      const walk = (dir, hrefBase, depthLeft) => {
        if (depthLeft < 0) return true;
        let names;
        try { names = fs.readdirSync(dir); } catch { return true; }
        for (const name of names) {
          if (name === '.recycle' || name === '.versions' || name === '.snapshots' || name.startsWith('.davtmp')) continue;
          const full = path.join(dir, name);
          let s2;
          try { s2 = fs.statSync(full); } catch { continue; }
          const sub = s2.isDirectory();
          body += this.responseXml(hrefBase + name + (sub ? '/' : ''), sub, s2, this.locksFor(full));
          if (sub) {
            if (depthLeft === Infinity && body.length < 4 * 1024 * 1024) {
              if (!walk(full, hrefBase + name + '/', depthLeft)) return false;
            }
          }
        }
        return true;
      };
      walk(t.abs, baseHref.replace(/\/?$/, '/') || '/', depth === Infinity ? Infinity : depth - 1);
    }
    return this.send207(res, body);
  }
  locksFor(abs) {
    const now = Date.now();
    const out = [];
    for (const [k, v] of this.locks) {
      if (v.expires < now) { this.locks.delete(k); continue; }
      if (k === abs) out.push(v);
    }
    return out;
  }

  /* ============ PROPPATCH（接受但忽略存储——文件系统无扩展属性需求） ============ */
  async proppatch(req, res, diskPart, relPath, user) {
    const raw = await readBody(req, 1024 * 1024).catch(() => Buffer.alloc(0));
    if (this.denyWrite(user, res)) return;
    const t = this.target(diskPart, relPath, user, true);
    if (t.error) { res.writeHead(t.code || 400, { 'Content-Length': 0 }); return res.end(); }
    if (!fs.existsSync(t.abs)) { res.writeHead(404, { 'Content-Length': 0 }); return res.end(); }

    // 提取 body 里的属性名，逐个回 200 OK
    const props = [...raw.toString('utf8').matchAll(/<(?:\w+:)?(displayname|getcontenttype|[A-Za-z0-9_-]+)>/g)]
      .map((mm) => mm[1]).slice(0, 32);
    let body = '<D:response><D:href>' + esc(encodeHref(DAV_PREFIX + '/' + diskPart + '/' + relPath)) + '</D:href>';
    for (const p of props || ['x-dummy']) {
      body += '<D:propstat><D:prop><D:' + p + '/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>';
    }
    body += '</D:response>';
    return this.send207(res, body);
  }

  /* ============ GET / HEAD（含 Range） ============ */
  get(req, res, diskPart, relPath, user, headOnly) {
    if (!diskPart) { res.writeHead(403, { 'Content-Length': 0 }); return res.end(); }
    const t = this.target(diskPart, relPath, user, false);
    if (t.error) { res.writeHead(t.code || 400, { 'Content-Length': 0 }); return res.end(); }

    let st;
    try { st = fs.statSync(t.abs); } catch { res.writeHead(404, { 'Content-Length': 0 }); return res.end(); }
    if (st.isDirectory()) { res.writeHead(403, { 'Content-Length': 0 }); return res.end(); }

    const headers = {
      'Content-Type': mimeOf(t.abs),
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      ETag: '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs / 1000).toString(16) + '"',
    };

    const range = req.headers.range;
    let start = 0, end = st.size - 1, code = 200;
    if (range) {
      const mm = /bytes=(\d*)-(\d*)/.exec(range);
      if (mm) {
        if (mm[1]) start = parseInt(mm[1], 10);
        if (mm[2]) end = parseInt(mm[2], 10);
        if (Number.isNaN(start) || start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
          return res.end();
        }
        if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
        code = 206;
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      }
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (headOnly) return res.end();

    const stream = fs.createReadStream(t.abs, { start, end, highWaterMark: 1 << 20 });
    stream.on('error', () => { try { res.destroy(); } catch {} });
    stream.pipe(res);
  }

  /* ============ PUT（流式落盘 + 版本存档） ============ */
  async put(req, res, diskPart, relPath, user) {
    console.error('[dav][put][enter]', JSON.stringify({ m: 'PUT', diskPart, relPath, clen: req.headers['content-length'], ifh: (req.headers['if'] || '').slice(0, 60), lt: (req.headers['lock-token'] || '').slice(0, 60), ua: (req.headers['user-agent'] || '').slice(0, 40) }));
    if (this.denyWrite(user, res)) return;
    if (!relPath) { res.writeHead(400, { 'Content-Length': 0 }); return res.end(); }
    const t = this.target(diskPart, relPath, user, true);
    if (t.error) { console.error('[dav][put][reject]', JSON.stringify({ diskPart, relPath, err: t.error, code: t.code, clen: req.headers['content-length'], locked: this.locksFor(t.abs || '').length })); res.writeHead(t.code || 400, { 'Content-Length': 0 }); return res.end(); }

    /* 锁校验 */
    if (!this.checkLockOk(req, t.abs)) { res.writeHead(423, { 'Content-Length': 0 }); return res.end(); }

    /* R3-9：公共盘配额校验（Content-Length 已知时预检，防止协议写路径绕过配额） */
    const clen = parseInt(req.headers['content-length'], 10);
    if (!this.srv.quotaOk(t.disk, t.root, Number.isFinite(clen) ? clen : 0)) {
      res.writeHead(507, { 'Content-Length': 0 });   // 507 Insufficient Storage
      return res.end();
    }

    if (fs.existsSync(t.abs) && fs.statSync(t.abs).isDirectory()) {
      res.writeHead(405, { 'Content-Length': 0 }); return res.end();
    }
    if (!fs.existsSync(path.dirname(t.abs))) {
      res.writeHead(409, { 'Content-Length': 0 }); return res.end(); // 父目录不存在
    }

    const tmp = t.abs + '.davtmp-' + crypto.randomBytes(4).toString('hex');
    await new Promise((resolve) => {
      const ws = fs.createWriteStream(tmp, { flags: 'wx', highWaterMark: 1 << 20 });
      let done = false;
      /* R3-9 补丁：边收边计配额。
         上面的预检只认 content-length —— 用 chunked 传输（没有 content-length）
         的上传会带着 0 字节通过预检，从而**绕过 64GB 公共盘硬上限**。
         这里按实际收到的字节数累计，每 1MB 复查一次，超了立刻中断并清理。 */
      let written = 0;
      let nextQuotaCheck = 1024 * 1024;
      /* 失败路径：**必须先关写流再 unlink**。
         只 unlink 不 destroy 时，fd 仍持有已删除文件的空间 —— Linux 下
         该块直到最后一个 fd 关闭才归还，于是"文件在目录里消失了、磁盘却没释放"，
         反复中断上传会累积成句柄泄漏（实测单次泄漏约 1.4GB）。 */
      const fail = (code) => {
        if (done) return; done = true;
        try { ws.destroy(); } catch {}
        try { fs.unlinkSync(tmp); } catch {}
        try { res.writeHead(code, { 'Content-Length': 0 }); res.end(); } catch {}
        resolve();
      };
      const fin = () => {
        if (done) return; done = true;
        // 覆盖前存版本
        try {
          if (fs.existsSync(t.abs)) this.srv.versionArchive(t.root, path.relative(t.root, t.abs), user);
          fs.renameSync(tmp, t.abs);
        } catch (e) { try { ws.destroy(); } catch {} try { fs.unlinkSync(tmp); } catch {} }
        this.srv.invalidateSizeCache();
        this.srv.audit({ userObj: user, action: 'dav-put', disk: t.disk, path: relPath, ip: req.socket.remoteAddress });
        res.writeHead(201, { 'Content-Length': 0 });
        res.end();
        resolve();
      };
      req.on('error', () => fail(500));
      req.on('aborted', () => fail(499));
      ws.on('error', () => fail(500));
      ws.on('finish', fin);
      /* 兜底：客户端中途取消上传（网断/点取消）时，req 的 error/aborted 未必触发，
         但 close 一定会。用 req.complete 区分"正常收完"与"中途断线"。 */
      req.on('close', () => { if (!done && !req.complete) fail(499); });
      /* 计数钩子：与 pipe 并存（pipe 自己也会挂 data 监听，两者都能收到同一批数据） */
      req.on('data', (c) => {
        if (done) return;
        written += c.length;
        if (written >= nextQuotaCheck) {
          nextQuotaCheck = written + 1024 * 1024;
          let over = false;
          try { over = !this.srv.quotaOk(t.disk, t.root, written); } catch { over = false; }
          if (over) fail(507);   // 507 Insufficient Storage：超配额 → 中断并清理
        }
      });
      req.pipe(ws);
    });
  }

  /* ============ DELETE（走回收站） ============ */
  async del(req, res, diskPart, relPath, user) {
    if (this.denyWrite(user, res)) return;
    if (!relPath) { res.writeHead(403, { 'Content-Length': 0 }); return res.end(); } // 不许删盘根
    const t = this.target(diskPart, relPath, user, true);
    if (t.error) { res.writeHead(t.code || 400, { 'Content-Length': 0 }); return res.end(); }
    if (!fs.existsSync(t.abs)) { res.writeHead(404, { 'Content-Length': 0 }); return res.end(); }
    if (!this.checkLockOk(req, t.abs)) { res.writeHead(423, { 'Content-Length': 0 }); return res.end(); }

    const r = this.srv.recycleMove(t.root, t.abs, user);
    if (!r.ok) { res.writeHead(500, { 'Content-Length': 0 }); return res.end(); }
    this.locks.delete(t.abs);
    this.srv.invalidateSizeCache();
    this.srv.audit({ userObj: user, action: 'dav-delete', disk: t.disk, path: relPath, ip: req.socket.remoteAddress, detail: 'recycle' });
    res.writeHead(204, { 'Content-Length': 0 });
    res.end();
  }

  /* ============ MKCOL ============ */
  async mkcol(req, res, diskPart, relPath, user) {
    const raw = await readBody(req, 64 * 1024).catch(() => Buffer.alloc(0));
    if (this.denyWrite(user, res)) return;
    if (!relPath) { res.writeHead(405, { 'Content-Length': 0 }); return res.end(); }
    const t = this.target(diskPart, relPath, user, true);
    if (t.error) { res.writeHead(t.code || 400, { 'Content-Length': 0 }); return res.end(); }
    if (fs.existsSync(t.abs)) { res.writeHead(405, { 'Content-Length': 0 }); return res.end(); }
    if (!fs.existsSync(path.dirname(t.abs))) { res.writeHead(409, { 'Content-Length': 0 }); return res.end(); }
    try {
      fs.mkdirSync(t.abs);
      this.srv.invalidateSizeCache();
      this.srv.audit({ userObj: user, action: 'dav-mkdir', disk: t.disk, path: relPath, ip: req.socket.remoteAddress });
      res.writeHead(201, { 'Content-Length': 0 }); return res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Length': 0 }); return res.end();
    }
  }

  /* ============ COPY / MOVE ============ */
  async copyMove(req, res, diskPart, relPath, user, isMove) {
    if (this.denyWrite(user, res)) return;
    const destHeader = req.headers.destination;
    if (!destHeader) { res.writeHead(400, { 'Content-Length': 0 }); return res.end(); }
    let destPath;
    try {
      destPath = decodeURIComponent(new URL(destHeader, 'http://dav.local').pathname);
    } catch { res.writeHead(400, { 'Content-Length': 0 }); return res.end(); }
    if (!destPath.startsWith(DAV_PREFIX + '/')) { res.writeHead(502, { 'Content-Length': 0 }); return res.end(); }
    const destRest = destPath.slice(DAV_PREFIX.length).replace(/^\/+/, '');
    const ds = destRest.indexOf('/');
    const dDisk = ds < 0 ? destRest : destRest.slice(0, ds);
    const dRel = ds < 0 ? '' : destRest.slice(ds + 1).replace(/^\/+/, '');
    if (!dRel) { res.writeHead(403, { 'Content-Length': 0 }); return res.end(); } // 不能覆盖盘根

    const src = this.target(diskPart, relPath, user, false);
    const dst = this.target(dDisk, dRel, user, true);
    if (src.error || dst.error) { res.writeHead(400, { 'Content-Length': 0 }); return res.end(); }
    if (!fs.existsSync(src.abs)) { res.writeHead(404, { 'Content-Length': 0 }); return res.end(); }
    if (!this.checkLockOk(req, src.abs) || !this.checkLockOk(req, dst.abs)) {
      res.writeHead(423, { 'Content-Length': 0 }); return res.end();
    }
    const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';
    if (fs.existsSync(dst.abs)) {
      if (!overwrite) { res.writeHead(412, { 'Content-Length': 0 }); return res.end(); }
      try { this.srv.storage.remove(dst.abs); } catch {}
    }
    if (!fs.existsSync(path.dirname(dst.abs))) { res.writeHead(409, { 'Content-Length': 0 }); return res.end(); }

    /* 配额预检：COPY 会让**目标盘**多占一份源文件的大小（原先完全没查，
       等于"复制大文件"就能绕过 64GB 公共盘硬上限）。
       MOVE 跨盘时同样是往目标盘搬数据，一并按源大小预检。 */
    let srcSize = 0;
    try { const ss = fs.statSync(src.abs); srcSize = ss.isDirectory() ? 0 : ss.size; } catch { srcSize = 0; }
    if (srcSize > 0 && !this.srv.quotaOk(dst.t.disk, dst.t.root, srcSize)) {
      res.writeHead(507, { 'Content-Length': 0 });   // 507 Insufficient Storage
      return res.end();
    }

    try {
      if (isMove) {
        try {
          fs.renameSync(src.abs, dst.abs);
        } catch (e) {
          if (e.code === 'EXDEV') { fs.cpSync(src.abs, dst.abs, { recursive: true }); this.srv.storage.remove(src.abs); }
          else throw e;
        }
        this.locks.delete(src.abs);
      } else {
        fs.cpSync(src.abs, dst.abs, { recursive: true });
      }
      this.srv.invalidateSizeCache();
      this.srv.audit({ userObj: user, action: isMove ? 'dav-move' : 'dav-copy', disk: dDisk, path: dRel, ip: req.socket.remoteAddress, detail: 'from ' + diskPart + '/' + relPath });
      res.writeHead(fs.existsSync(dst.abs) ? 201 : 204, { 'Content-Length': 0 });
      res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Length': 0 }); return res.end();
    }
  }

  /* ============ LOCK / UNLOCK（Windows/Office 必需） ============ */
  async lock(req, res, diskPart, relPath, user) {
    if (this.denyWrite(user, res)) return;
    if (!relPath) { res.writeHead(400, { 'Content-Length': 0 }); return res.end(); }
    const t = this.target(diskPart, relPath, user, true);
    if (t.error) { res.writeHead(t.code || 400, { 'Content-Length': 0 }); return res.end(); }

    const timeout = parseTimeout(req.headers.timeout);
    const ifHeader = req.headers['if'] || '';

    /* 刷新已有锁 */
    const refreshMatch = /<([^>]+)>/.exec(ifHeader);
    if (refreshMatch) {
      const token = refreshMatch[1].replace(/^<?|>?$/g, '');
      for (const [k, v] of this.locks) {
        if (v.token === token) {
          v.expires = Date.now() + timeout * 1000;
          return this.sendLockRes(res, v, 200);
        }
      }
      res.writeHead(412, { 'Content-Length': 0 }); return res.end();
    }

    /* 新建锁：资源不存在则创建空文件（Office 的 LOCK-then-PUT 模式） */
    if (!fs.existsSync(t.abs)) {
      if (!fs.existsSync(path.dirname(t.abs))) { res.writeHead(409, { 'Content-Length': 0 }); return res.end(); }
      try { fs.writeFileSync(t.abs, Buffer.alloc(0)); } catch { res.writeHead(500, { 'Content-Length': 0 }); return res.end(); }
    } else if (fs.statSync(t.abs).isDirectory()) {
      res.writeHead(405, { 'Content-Length': 0 }); return res.end();
    }

    let owner = user ? user.username : 'dav';
    const raw = await readBody(req, 1024 * 1024).catch(() => Buffer.alloc(0));
    const om = /<(?:\w+:)?owner[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/i.exec(raw.toString('utf8'));
    if (om) owner = om[1].replace(/<[^>]+>/g, '').trim() || owner;

    const L = {
      token: 'opaquelocktoken:' + crypto.randomUUID(),
      owner, timeout,
      expires: Date.now() + timeout * 1000,
    };
    this.locks.set(t.abs, L);
    this.srv.audit({ userObj: user, action: 'dav-lock', disk: t.disk, path: relPath, ip: req.socket.remoteAddress });
    return this.sendLockRes(res, L, 200);
  }
  sendLockRes(res, L, code) {
    const body = XML_HEAD
      + '<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>'
      + '<D:locktype><D:write/></D:locktype>'
      + '<D:lockscope><D:exclusive/></D:lockscope>'
      + '<D:depth>0</D:depth>'
      + '<D:owner>' + esc(L.owner) + '</D:owner>'
      + '<D:timeout>Second-' + Math.max(0, Math.floor((L.expires - Date.now()) / 1000)) + '</D:timeout>'
      + '<D:locktoken><D:href>' + esc(L.token) + '</D:href></D:locktoken>'
      + '</D:activelock></D:lockdiscovery></D:prop>';
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(code, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': buf.length,
      'Lock-Token': '<' + L.token + '>',
    });
    res.end(buf);
  }

  async unlock(req, res, diskPart, relPath, user) {
    if (this.denyWrite(user, res)) return;
    const lt = (req.headers['lock-token'] || '').replace(/[<>]/g, '');
    if (!lt) { res.writeHead(400, { 'Content-Length': 0 }); return res.end(); }
    let removed = false;
    for (const [k, v] of this.locks) {
      if (v.token === lt) { this.locks.delete(k); removed = true; }
    }
    if (!removed) { res.writeHead(409, { 'Content-Length': 0 }); return res.end(); }
    this.srv.audit({ userObj: user, action: 'dav-unlock', disk: diskPart, path: relPath, ip: req.socket.remoteAddress });
    res.writeHead(204, { 'Content-Length': 0 });
    res.end();
  }

  /* 写操作锁校验：有锁时必须带 If/Lock-Token 匹配 */
  checkLockOk(req, abs) {
    const locks = this.locksFor(abs);
    if (!locks.length) return true;
    const ifH = req.headers['if'] || '';
    const ltH = (req.headers['lock-token'] || '').replace(/[<>]/g, '');
    return locks.some((L) => ifH.includes(L.token) || ltH.includes(L.token));
  }
}

module.exports = { Dav, DAV_PREFIX };

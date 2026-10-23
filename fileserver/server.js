'use strict';

/**
 * 局域网私有文件服务器（零依赖，仅使用 Node 内置模块）
 *
 * 启动： node server.js
 * 配置： config.json 或环境变量 PORT / HOST / STORAGE_DIR / MAX_UPLOAD_MB / TLS / AUTO_START
 *
 * v2 特性：
 *  - HTTPS (TLS1.3, 自签名零依赖证书, IP 变化自动重建)
 *  - HTTP/2 多路复用（同一连接并发多请求不再队头阻塞）
 *  - /api/chunk-init | /api/chunk-data | /api/chunk-complete 分块上传（超 64MB 走此路径）
 *  - /api/upload 整体上传（小文件，一次 multipart）
 *  - server.keepAliveTimeout=75s + maxRequestsPerSocket 不限 → 连接复用
 *  - HTTP/2 单连接 stream 数限制 128
 */

const http = require('http');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  parseCookies, parseQuery, sendJSON, sendText,
  readBody, getLocalIPs, mimeOf, contentDisposition, formatSize,
} = require('./lib/util');
const { UserStore, SessionStore, hashPasswordAsync } = require('./lib/auth');
const { Storage } = require('./lib/storage');
const { getBoundary, parseMultipart } = require('./lib/multipart');
const { ensureCertificates } = require('./lib/tls');
const { Dav, DAV_PREFIX } = require('./lib/dav');
const { S3Gateway } = require('./lib/s3');
/* R11：SMB 账号（工作站账户 = Samba 账户，见 lib/smb-users.js） */
const { Docs } = require('./lib/docs');
const smbUsers = require('./lib/smb-users');
/* R15: 可插拔 API 路由层（lib/routes/*.js）—— 新接口只加文件，不改本文件 */
const extRoutes = require('./lib/routes');
const { FtpServer } = require('./lib/ftp');
const { NfsServer } = require('./lib/nfs');
const { Dlna } = require('./lib/dlna');
const { MdnsResponder } = require('./lib/mdns');
const { Monitor } = require('./lib/monitor');
const { Notifier } = require('./lib/notify');
const { createLimiterFromCfg } = require('./lib/ratelimit');
const { ApiV1 } = require('./lib/apidoc');
const aclStore = require('./lib/acl');
const quotaStore = require('./lib/quota');
const snapshots = require('./lib/snapshot');
const scrubStore = require('./lib/scrub');
const classifyStore = require('./lib/classify');
const totpLib = require('./lib/totp');
const thumbsStore = require('./lib/thumbs');
const { HashIndex } = require('./lib/hashindex');
/* v4：局域网工作站（实时事件中枢 + 在线设备 + 任务中心 + 协同板） */
const { Hub } = require('./lib/hub');
const { Presence } = require('./lib/presence');
const { TaskCenter } = require('./lib/tasks');
const { Remote } = require('./lib/remote');
const { Sync } = require('./lib/sync');
const { Pairing } = require('./lib/pair');
const { Share } = require('./lib/share');
const { Board } = require('./lib/board');
const { DiskVisibility } = require('./lib/disk-visibility');

/* 图形验证码（内存，2 分钟 TTL，一次性）*/
const _captchas = new Map();
function _genCaptcha() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const code = String(Math.floor(1000 + Math.random() * 9000));
  _captchas.set(id, { code, exp: Date.now() + 120000 });
  if (_captchas.size > 500) { for (const [k, v] of _captchas) if (v.exp < Date.now()) _captchas.delete(k); }
  const lines = Array.from({ length: 5 }, () => '<line x1="' + ((Math.random()*120)|0) + '" y1="0" x2="' + ((Math.random()*120)|0) + '" y2="44" stroke="rgba(124,110,250,.35)" stroke-width="1"/>').join('');
  const chars = code.split('').map((c, i) => '<text x="' + (18 + i*27) + '" y="' + (24 + ((Math.random()*8)|0)) + '" font-size="26" font-family="monospace" font-weight="700" fill="#7C6EFA" transform="rotate(' + (((Math.random()*20)|0)-10) + ' ' + (18+i*27) + ' 26)">' + c + '</text>').join('');
  const dots = Array.from({ length: 24 }, () => '<circle cx="' + ((Math.random()*120)|0) + '" cy="' + ((Math.random()*44)|0) + '" r="' + (Math.random()*1.5).toFixed(1) + '" fill="rgba(200,200,255,.45)"/>').join('');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="44" viewBox="0 0 120 44"><rect width="120" height="44" rx="8" fill="#15151f"/>' + lines + chars + dots + '</svg>';
  return { id, svg };
}
function _verifyCaptcha(id, code) {
  if (!id) return true;               /* 兼容未接验证码的旧前端 */
  const c = _captchas.get(String(id));
  if (!c) return false;
  _captchas.delete(String(id));       /* 一次性 */
  if (c.exp < Date.now()) return false;
  return c.code === String(code || '');
}

/* v4.2：内置 AI 助手中转（后端可切，支持流式） */
const { AI } = require('./lib/ai');
/* v4.3：AI 工具层 —— 让模型真正读写 NAS 上的文件（复用 storage/ACL 守护） */
const { AITools } = require('./lib/ai-tools');
const { JEV } = require('./lib/jev');
const { OfficeOO, MIME: OO_MIME } = require('./lib/office-oo');
const { IM } = require('./lib/im');

const DEFAULTS = {
  port: 8443,
  host: '0.0.0.0',
  dataDir: path.join(__dirname, 'data'),
  storageDir: null,      // 默认 <dataDir>/storage
  maxUploadMB: 512,       // 单次整体上传体积上限
  sessionCookie: 'fsid',
  tls: true,              // HTTPS 开关
  http2: true,             // HTTP/2（h2 + h2c prior knowledge）
  chunkThresholdMB: 64,   // 超过此大小前端自动走分块上传
  versionHistory: true,   // 覆盖写入前把旧文件存入 .versions
};

/** 公共盘配额：64GB */
const PUBLIC_QUOTA = 64 * 1024 * 1024 * 1024;
/* R9：审计日志轮转阈值（8MB）。超过就转成 audit.log.1，只保留一代。 */
const AUDIT_MAX_BYTES = 8 * 1024 * 1024;
/* R9：同一 IP 每小时最多注册几个账号（批量造号的兜底闸门，见 registerRateCheck） */
const REGISTER_MAX_PER_HOUR = 5;

/* ---------------- ZIP（store 模式）打包工具：批量下载 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf, crc = 0) {
  crc ^= -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function dosDateTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
/** 生成一个文件条目的 local header（UTF-8 文件名，store 模式） */
function zipLocalHeader(nameBytes, crc, size, dt) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);          // version
  h.writeUInt16LE(0x0800, 6);      // flags: UTF-8 文件名
  h.writeUInt16LE(0, 8);           // method: store
  h.writeUInt16LE(dt.time, 10);
  h.writeUInt16LE(dt.date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(size, 18);       // compressed = size（store）
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(nameBytes.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, nameBytes]);
}
function zipCentralEntry(nameBytes, crc, size, dt, offset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(0, 10);
  h.writeUInt16LE(dt.time, 12); h.writeUInt16LE(dt.date, 14);
  h.writeUInt32LE(crc, 16); h.writeUInt32LE(size, 20); h.writeUInt32LE(size, 24);
  h.writeUInt16LE(nameBytes.length, 28);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, nameBytes]);
}
function zipEOCD(count, centralSize, centralOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(count, 8); h.writeUInt16LE(count, 10);
  h.writeUInt32LE(centralSize, 12); h.writeUInt32LE(centralOffset, 16);
  return h;
}

/** EOCD 固定 22 字节（无注释） */
const ZIP_EOCD_SIZE = 22;

/**
 * 把待打包条目写成 zip 流（自研实现，零依赖）。
 * @param {Writable} out        任意可写流：http res 或 fs.WriteStream
 * @param {Array} entries       [{ abs, zipPath, size, mtime }]
 * @param {Function} [onProgress] (done, total, entry) => void
 * @returns {Promise<{count:number, bytes:number}>}
 */
async function writeZipToStream(out, entries, onProgress) {
  const dt = dosDateTime();
  const central = [];
  let offset = 0;
  const writeBuf = (buf) => new Promise((r) => { out.write(buf) ? r() : out.once('drain', r); });

  let done = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(String(entry.zipPath).replace(/^\/+/, ''), 'utf8');
    const headerOffset = offset;
    const header = zipLocalHeader(nameBytes, 0, entry.size, dt);
    central.push(zipCentralEntry(nameBytes, 0, entry.size, dt, headerOffset));
    const idx = central.length - 1;
    offset += header.length + entry.size;
    await writeBuf(header);

    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(entry.abs, { highWaterMark: 1 << 20 });
      let crc = 0;
      rs.on('data', (d) => {
        crc = crc32(d, crc);
        if (!out.write(d)) { rs.pause(); out.once('drain', () => rs.resume()); }
      });
      rs.on('end', () => {
        central[idx] = zipCentralEntry(nameBytes, crc >>> 0, entry.size, dt, headerOffset);
        resolve();
      });
      rs.on('error', reject);
    });

    done++;
    if (onProgress) { try { onProgress(done, entries.length, entry); } catch { /* 忽略回调异常 */ } }
  }

  const centralBuf = Buffer.concat(central);
  await writeBuf(centralBuf);
  await writeBuf(zipEOCD(central.length, centralBuf.length, offset));
  return { count: central.length, bytes: offset + centralBuf.length + ZIP_EOCD_SIZE };
}

/**
 * 收集待打包条目。返回 [{ abs, zipPath, size, mtime }]
 * @param {object} storage  Storage 实例（用其 safeResolve 做越权防护）
 * @param {string} root     已鉴权的根目录绝对路径
 * @param {Array<string>} paths 相对路径列表
 * @param {number} [limit]  文件数上限
 */
function collectZipEntries(storage, root, paths, limit = 2000) {
  const entries = [];
  /* R2-2-10：除文件数上限外增加总字节上限（20GB）—— 防单次打包拖垮磁盘/内存/时长 */
  const MAX_ZIP_BYTES = 20 * 1024 * 1024 * 1024;
  let totalBytes = 0;
  const walk = (absPath, zipPath) => {
    if (entries.length >= limit) return;
    let st;
    try { st = fs.statSync(absPath); } catch { return; }
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(absPath); } catch { return; }
      for (const n of names) walk(path.join(absPath, n), zipPath + '/' + n);
    } else if (st.isFile()) {
      if (totalBytes + st.size > MAX_ZIP_BYTES) return;   // 超总量的文件跳过（不打断已收集部分）
      totalBytes += st.size;
      entries.push({ abs: absPath, zipPath, size: st.size, mtime: st.mtime });
    }
  };
  for (const p of paths.slice(0, 500)) {
    if (entries.length >= limit) break;
    const abs = storage.safeResolve(root, String(p));
    if (!abs) continue;
    walk(abs, path.basename(String(p)));
  }
  return entries;
}

/**
 * 递归计算目录下所有文件的 sha256，生成可批量校验的清单。
 * @param {Function} [onProgress] (done, total, relPath) => void
 */
async function hashScanDir(root, opt = {}) {
  const limit = Math.max(1, Math.min(50000, Number(opt.limit) || 20000));
  const files = [];
  const walk = (dir, rel) => {
    if (files.length >= limit) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (files.length >= limit) break;
      const abs = path.join(dir, n);
      const r = rel ? rel + '/' + n : n;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) files.push({ abs, rel: r, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(root, '');

  const items = [];
  let totalBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const hex = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(f.abs, { highWaterMark: 1 << 20 })
          .on('data', (d) => h.update(d))
          .on('end', () => resolve(h.digest('hex')))
          .on('error', reject);
      });
      items.push({ p: f.rel, size: f.size, mtimeMs: Math.floor(f.mtimeMs), sha256: hex });
      totalBytes += f.size;
    } catch (e) {
      items.push({ p: f.rel, size: f.size, mtimeMs: Math.floor(f.mtimeMs), error: e.code || 'read-error' });
    }
    if (opt.onProgress) { try { opt.onProgress(i + 1, files.length, f.rel); } catch { /* 忽略 */ } }
  }

  // 整树指纹：排序后的 sha256 序列再哈希一次，方便"两张清单是否一致"一次比对
  const fingerprint = crypto.createHash('sha256')
    .update(items.map((x) => x.p + '|' + (x.sha256 || '')).sort().join('\n'))
    .digest('hex');

  return { count: items.length, totalBytes, fingerprint, truncated: files.length >= limit, items };
}

function loadConfig() {
  const cfg = { ...DEFAULTS };
  const cfgFile = path.join(__dirname, 'config.json');
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch { /* 无配置文件 */ }

  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.STORAGE_DIR) cfg.storageDir = process.env.STORAGE_DIR;
  if (process.env.DATA_DIR) cfg.dataDir = process.env.DATA_DIR;
  if (process.env.MAX_UPLOAD_MB) cfg.maxUploadMB = Number(process.env.MAX_UPLOAD_MB);
  if (process.env.TLS) cfg.tls = !/^(0|false|no|off)$/i.test(process.env.TLS);
  if (process.env.HTTP2) cfg.http2 = !/^(0|false|no|off)$/i.test(process.env.HTTP2);

  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.storageDir = path.resolve(cfg.storageDir || path.join(cfg.dataDir, 'storage'));
  return cfg;
}

/** 排空请求体（避免提前响应导致客户端 RST） */
function drainRequest(req) {
  return new Promise((resolve) => {
    if (req.destroyed || req.complete || req.readableEnded) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    req.resume();
    req.on('end', finish);
    req.on('close', finish);
    req.on('error', finish);
    setTimeout(finish, 3000);
  });
}

/** 从请求中重建普通 http.IncomingMessage 风格的 headers/method（兼容 h2 伪头） */
function normalizeH2(req) {
  return {
    method: (req.method || 'GET').toUpperCase(),
    url: req.url || '/',
    headers: req.headers,
  };
}

/**
 * R9：ONLYOFFICE 的 JWT 密钥解析。
 *
 * 原来写死 'station-oo-2026' —— 这串字面量在源码里（还在 git 历史里），
 * 任何拿到源码的人都能自己签一个合法 token，从而伪造 DS 回调，
 * 让服务端把任意 URL 的内容写进任意文件。
 *
 * 现在：环境变量 OO_JWT_SECRET 优先 → 没有就读写 <dataDir>/oo-jwt.key →
 * 再没有就随机生成并落盘。
 * **必须持久化**：DS 容器要用同一个密钥签/验 token，
 * 每次重启都换新密钥会让在线编辑的回调全部失效。
 * 注意：DS 容器侧也要配成同一个值（部署时同步，见部署清单）。
 */
function resolveOOSecret(dataDir) {
  const env = process.env.OO_JWT_SECRET;
  if (env && String(env).length >= 16) return String(env);
  const f = path.join(dataDir, 'oo-jwt.key');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch { /* 没有就生成 */ }
  const gen = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(f, gen, { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch (e) {}
  } catch (e) {
    console.warn('[oo] 警告：无法持久化 JWT 密钥到', f, '—— 进程重启后在线编辑会失效');
  }
  return gen;
}

class FileServer {
  constructor(cfg) {
    this.cfg = cfg;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    this.users = new UserStore(cfg.dataDir);
    this.diskVis = new DiskVisibility(cfg.dataDir);
    this.jev = new JEV(cfg.dataDir);
    this.oo = new OfficeOO(cfg.dataDir, {
      jwtSecret: resolveOOSecret(cfg.dataDir),
      publicBase: process.env.OO_PUBLIC_BASE || 'http://host.docker.internal',
      dsBase: '/onlyoffice',
      /* R9：DS 回调的 URL 白名单。DS 容器用**自己的主机名**回调
         （onlyoffice / 容器 id），宿主机上要能解析并连上它。
         hostRewrite 把容器名映射到宿主机上真实可达的发布端口。 */
      allowedHosts: (process.env.OO_ALLOWED_HOSTS || 'onlyoffice,host.docker.internal,127.0.0.1').split(/[,\s]+/).filter(Boolean),
      hostRewrite: Object.assign(
        { 'onlyoffice': process.env.OO_DS_ADDR || '127.0.0.1:8090' },
        (() => { try { return JSON.parse(process.env.OO_HOST_REWRITE || '{}'); } catch { return {}; } })()
      ),
    });
    this.im = new IM(cfg.dataDir);
    this.sessions = new SessionStore(cfg.dataDir);
    this.storage = new Storage(cfg.storageDir);
    this.publicDir = path.join(__dirname, 'public');
    this._gzCache = new Map();      // 静态资源 gzip 缓存：绝对路径 → {buf,size,mtimeMs}
    this.uploads = new Map(); // chunk 会话: uploadId -> {abs, size, chunkSize, totalChunks, received, startTime, handle}
    this.hashIndex = new HashIndex(cfg.dataDir);  // 秒传：sha256 → 已存在文件
    this.tls = null;          // {key, cert, regenerated}
    this.dav = new Dav(this); // WebDAV 协议层
    /* v3 扩展：协议网关 / 运维 / 安全 / 智能 */
    this.s3 = new S3Gateway(this);
    this.apiv1 = new ApiV1(this);
    this.monitor = new Monitor();
    this.notifier = new Notifier(this);
    this.dlna = new Dlna(this);
    this.limiter = null;      // 限速器（start 时按 limit.json 创建）
    this._wd = null;          // 看门狗状态
    this.svcs = {};           // 已启动附属服务表
    /* v4：工作站四件套 —— 这是「文件站」升级为「局域网工作站」的核心 */
    this.hub = new Hub(this);          // 实时事件中枢（SSE）
    this.presence = new Presence(this); // 设备在线注册中心
    this.tasks = new TaskCenter(this);  // 实时任务中心
    this.board = new Board(this);       // 跨设备协同板
    this.docs = new Docs(this);          // 办公工作区（文档/表格/看板）
    this.docClients = new Set();         // SSE：文档变更订阅者
    /* v4.1：补齐的三个能力层 —— 远程控制 / 数据同步 / 设备信任 */
    this.pairing = new Pairing(this);   // 设备配对与信任
    this.remote = new Remote(this);     // 远程控制中枢（依赖 presence + pairing + hub）
    this.sync = new Sync(this);         // 数据同步引擎
    this.share = new Share(this);       // 限时分享链接（免登录取件）
    /* v4.2：内置 AI 助手（转发到局域网内的推理后端） */
    this.ai = new AI(cfg.dataDir);
    /* v4.3：把「手和眼」交给 AI —— 服务端执行工具，模型只负责决策 */
    this.ai.setTools(new AITools(this));
    /* 开机问一次后端的真实上下文窗口（llama.cpp /props 的 n_ctx），
       上下文守卫据此决定每轮能塞多少内容。拿不到就沿用默认值，不阻塞启动。 */
    this.ai.detectContext().catch(() => {});
    /* R1-1-10：登录/注册暴力破解防护 —— per-IP 失败计数滑动窗口。
       10 次/5 分钟失败 → 锁 5 分钟（成功登录不清零：防"间歇试错"绕过）。
       家用场景单 IP 高频失败只有两种解释：主人忘了密码在重试（锁 5 分钟可接受），
       或有人在爆破（正好该锁）。 */
    this._loginFails = new Map(); // ip -> [ts, ...]
    /* R9：注册频率计数（ip -> [ts, ...]）。替代「强制验证码」来挡住批量注册。 */
    this._registerHits = new Map();
  }

  /** R1-1-10：登录尝试限速。返回 null（放行）或 {code, error}（拒绝） */
  loginRateCheck(ip) {
    const now = Date.now();
    const WINDOW = 5 * 60 * 1000, MAX_FAILS = 10, LOCK_MS = 5 * 60 * 1000;
    const list = this._loginFails.get(ip) || [];
    const recent = list.filter((t) => now - t < WINDOW);
    // 已在锁定期：即使 recent 不足也拒绝（锁从最后一次失败起算）
    if (recent.length >= MAX_FAILS && now - recent[recent.length - 1] < LOCK_MS) {
      return { code: 429, error: '尝试次数过多，请 5 分钟后再试' };
    }
    this._loginFails.set(ip, recent);   // 顺带清掉过期项
    return null;
  }
  /** 记录一次登录失败（成功登录不调用 —— 防间歇试探绕过） */
  loginRateFail(ip) {
    const list = this._loginFails.get(ip) || [];
    list.push(Date.now());
    if (list.length > 60) list.splice(0, list.length - 60);   // 有界
    this._loginFails.set(ip, list);
  }

  /**
   * R9：注册限速（按 IP，每小时最多 REGISTER_MAX_PER_HOUR 个账号）。
   *
   * 为什么不是「直接强制验证码」：public/index.html 是 React 19 的**构建产物**，
   * 它的登录/注册请求根本不带 captchaId（只有独立的 public/auth.html 带），
   * 而前端源码不在仓库里 —— 强行要求验证码会让现网 SPA 直接无法登录/注册。
   * 所以这里用**频率**补偿：验证码管「是不是机器」，频率管「这台机器能不能批量造号」。
   * 两者缺一不可 —— 只有验证码（现状）挡不住脚本，只有频率挡不住一次性大批量。
   *
   * 前端源码找回后，应当在 /api/register 补上 captchaId + 验证码输入框，
   * 然后把这里的限速阈值调回宽松值即可（两者并存不冲突）。
   */
  registerRateCheck(ip) {
    const now = Date.now();
    const HOUR = 3600 * 1000;
    const list = (this._registerHits.get(ip) || []).filter((t) => now - t < HOUR);
    this._registerHits.set(ip, list);           // 顺带清掉过期项
    if (list.length >= REGISTER_MAX_PER_HOUR) {
      return {
        code: 429,
        error: `注册过于频繁：同一网络每小时最多注册 ${REGISTER_MAX_PER_HOUR} 个账号，请 1 小时后再试`,
      };
    }
    return null;
  }
  /** 记一次成功注册（只有成功才计数 —— 失败的注册不该消耗额度） */
  /** 图形验证码校验（供 lib/routes/* 扩展模块复用；一次性、2 分钟过期） */
  verifyCaptcha(id, code) {
    return _verifyCaptcha(id, code);
  }

  registerRateHit(ip) {
    const list = this._registerHits.get(ip) || [];
    list.push(Date.now());
    if (list.length > 200) list.splice(0, list.length - 200);   // 有界
    this._registerHits.set(ip, list);
  }

  /** 是否管理员（用于配对码、信任管理等敏感操作） */
  isAdmin(user) {
    return !!(user && (user.role === 'admin' || user.isAdmin));
  }

  /** 广播「文件已变化」，让其他在线设备即时刷新目录（乐观刷新用） */
  notifyFilesChanged(action, detail) {
    try {
      this.hub.publish('files', 'files.changed', {
        action: action || 'change',
        disk: (detail && detail.disk) || '',
        path: (detail && detail.path) || '',
        by: (detail && detail.user) || '',
        at: Date.now(),
      });
    } catch { /* 推送失败不影响主流程 */ }
  }

  /* ------------------------------ 会话与鉴权 ------------------------------ */

  currentUser(req) {
    const sid = parseCookies(req.headers.cookie)[this.cfg.sessionCookie];
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    return this.users.findById(s.userId) || null;
  }

  /**
   * 会话 Cookie。
   *
   * R16.1：默认仍是 `SameSite=Lax`（CSRF 防线之一）。只有同时满足
   *   ① 设了 STATION_EMBED_OK=1（演示/预览模式）
   *   ② 这次请求确实走的是 https（TLS 或反代 X-Forwarded-Proto）
   * 才放宽成 `SameSite=None; Secure` —— 因为嵌入到别的站点（iframe）里时，
   * Lax 的 Cookie 不会被带上，登录会「看似成功、刷新即掉」。
   * 这个开关刻意只在演示环境开，正式部署不要加。
   */
  _embedMode() {
    return /^(1|true|yes|on)$/i.test(String(process.env.STATION_EMBED_OK || ''));
  }

  _isHttpsReq(req) {
    if (this.cfg.tls) return true;
    const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
  }

  setSessionCookie(res, sid, req) {
    const maxAge = 7 * 24 * 3600;
    /* R1-1-7：TLS 模式下补 Secure，防止 cookie 经 http:// 明文旁路泄漏 */
    const https = this._isHttpsReq(req);
    const crossSite = this._embedMode() && https;
    const secure = https ? '; Secure' : '';
    const sameSite = crossSite ? 'None' : 'Lax';
    res.setHeader('Set-Cookie',
      `${this.cfg.sessionCookie}=${sid}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`);
  }

  clearSessionCookie(req, res) {
    const sid = parseCookies(req.headers.cookie)[this.cfg.sessionCookie];
    if (sid) this.sessions.destroy(sid);
    res.setHeader('Set-Cookie',
      `${this.cfg.sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  /* ------------------------------ 证书与 HTTP/2 ------------------------------ */

  initTLS() {
    if (!this.cfg.tls) return;
    const ips = getLocalIPs();
    ips.push('127.0.0.1');
    const { key, cert, regenerated } = ensureCertificates(path.join(this.cfg.dataDir, 'tls'), { ips, dns: ['localhost'] });
    this.tls = { key, cert, regenerated };
    if (regenerated) console.log('  [TLS] 已生成自签名证书（IP 变化或首次启动）');
  }

  /* -------------------------------- 数据保护：回收站 / 版本 / 审计 ------------------------------- */

  /* ---------------- R11：SMB 密码 ↔ 网页登录密码 同步 ----------------
     网页端口令是 scrypt 单向哈希，服务端永远拿不回明文；但用户每次登录都会把
     明文交上来，所以「同步」只能在登录那一刻做：verify 通过后把同一个密码写给 Samba。
     为免每次登录都起一次 smbpasswd（150~400ms），存一个 HMAC 指纹判断密码变没变：
        fp = HMAC-SHA256(本机随机密钥, 用户名 \\0 明文)
     指纹没变 → 跳过；变了 → 重设。密钥/指纹都在 data/ 下、0600，不进 git。 */

  /** 本机随机密钥（首次使用时生成，落盘 0600） */
  _smbKey() {
    if (this.__smbKey) return this.__smbKey;
    const f = path.join(this.cfg.dataDir, '.smb-key');
    try {
      const k = fs.readFileSync(f, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(k)) {
        this.__smbKey = Buffer.from(k, 'hex');
        return this.__smbKey;
      }
    } catch { /* 没有 → 下面新建 */ }
    const k = crypto.randomBytes(32);
    try { fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 }); } catch (e) {
      console.warn('[smb] 写密钥失败：' + (e && e.message));
    }
    this.__smbKey = k;
    return k;
  }

  _smbFpFile() { return path.join(this.cfg.dataDir, 'smb-sync.json'); }

  _smbFpLoad() {
    try { return JSON.parse(fs.readFileSync(this._smbFpFile(), 'utf8')) || {}; } catch { return {}; }
  }

  _smbFpSave(obj) {
    try {
      fs.writeFileSync(this._smbFpFile(), JSON.stringify(obj), { mode: 0o600 });
    } catch (e) {
      console.warn('[smb] 写同步指纹失败：' + (e && e.message));
    }
  }

  _smbFp(uname, password) {
    return crypto.createHmac('sha256', this._smbKey())
      .update(String(uname)).update('\u0000').update(String(password)).digest('hex');
  }

  /**
   * 把网页密码同步到 SMB 账号（登录时调用）。
   * @returns {Promise<{synced:boolean, reason?:string, created?:boolean, error?:string}>}
   */
  async syncSmbAccount(user, password) {
    const uname = String((user && user.username) || '');
    const pw = String(password || '');
    if (!smbUsers.NAME_RE.test(uname)) return { synced: false, reason: 'name' };
    /* Samba 默认最短路口令是 5，但界面上我们要求 8 —— 老账号可能有更短的，
       这类就别硬同步，让用户在设置页单独设一个（别因此挡住登录）。 */
    if (pw.length < smbUsers.MIN_PASS) return { synced: false, reason: 'short' };
    const fp = this._smbFp(uname, pw);
    const store = this._smbFpLoad();
    if (store[uname] === fp && smbUsers.smbUserExists(uname)) {
      return { synced: false, reason: 'uptodate' };
    }
    const made = smbUsers.ensureSmbUser(uname, pw);
    if (!made.ok) return { synced: false, reason: 'error', error: made.error };
    const acl = smbUsers.addUserToShares(uname);
    if (acl.ok && acl.changed) smbUsers.reloadSamba();
    store[uname] = fp;
    this._smbFpSave(store);
    return { synced: true, created: !!made.created };
  }

  /**
   * 给用户看的局域网访问地址。
   * 不能直接用 cfg.host —— 那是监听地址（0.0.0.0），
   * 让用户去别的电脑输 \\0.0.0.0\公共盘 毫无意义。
   */
  smbHost() {
    try {
      const ips = getLocalIPs() || [];
      const pick = ips.find((ip) => /^192\.168\./.test(ip))
        || ips.find((ip) => /^10\./.test(ip))
        || ips.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
        || ips[0];
      if (pick) return pick;
    } catch { /* 回落 */ }
    return this.cfg.host && this.cfg.host !== '0.0.0.0' ? this.cfg.host : '192.168.99.1';
  }

  audit(rec) {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        ip: rec.ip || '',
        user: rec.user || (rec.userObj && rec.userObj.username) || 'anonymous',
        action: rec.action,
        disk: rec.disk || '',
        path: rec.path || '',
        ok: rec.ok !== false,
        detail: rec.detail || '',
      });
      const f = path.join(this.cfg.dataDir, 'audit.log');
      /* R9：审计日志原来只增不减 —— 长期运行会把根分区写满（这台机器
         根分区只有 98G，而且公共盘/外置盘都在同一块盘上）。
         超过阈值就轮转一代（保留 .1），保证「近期可查 + 占用有界」。
         readAudit 一次性把整个文件读进内存，轮转同时也顺手限制了它的内存占用。 */
      try {
        if (this._auditSize == null) {
          try { this._auditSize = fs.statSync(f).size; } catch { this._auditSize = 0; }
        }
        const bytes = Buffer.byteLength(line) + 1;
        this._auditSize += bytes;
        if (this._auditSize > AUDIT_MAX_BYTES) {
          try { fs.renameSync(f, f + '.1'); } catch (e) { /* 轮转失败就继续追加 */ }
          this._auditSize = bytes;
        }
      } catch (e) { /* 统计失败不影响审计本身 */ }
      fs.appendFileSync(f, line + '\n');
    } catch { /* 审计失败不影响主流程 */ }
  }
  readAudit(limit = 300) {
    const f = path.join(this.cfg.dataDir, 'audit.log');
    if (!fs.existsSync(f)) return [];
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; }
    return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  recycleDir(root) { return path.join(root, '.recycle'); }
  recycleIndex(root) {
    try { return JSON.parse(fs.readFileSync(path.join(this.recycleDir(root), 'index.json'), 'utf8')); } catch { return []; }
  }
  recycleSave(root, list) {
    const d = this.recycleDir(root);
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
    try { fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(list)); } catch {}
  }
  recycleMove(root, abs, user) {
    const d = this.recycleDir(root);
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { return { ok: false, error: '回收站不可写：' + e.message }; }
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    let size = 0, isDir = false;
    try { const st = fs.statSync(abs); isDir = st.isDirectory(); if (!isDir) size = st.size; } catch {}
    try {
      fs.renameSync(abs, path.join(d, id));
    } catch (e) {
      return { ok: false, error: '移入回收站失败：' + e.message };
    }
    const list = this.recycleIndex(root);
    list.push({
      id, name: path.basename(abs), original: path.relative(root, abs),
      deletedAt: Date.now(), deletedBy: user ? user.username : 'anonymous',
      size, isDir,
    });
    this.recycleSave(root, list.slice(-5000));
    return { ok: true, id, size };
  }
  recycleRestore(root, id) {
    const list = this.recycleIndex(root);
    const item = list.find((x) => x.id === id);
    if (!item) return { ok: false, error: '回收站中没有该项' };
    const dest = path.join(root, item.original);
    /* R2-2-9（P2）：还原目标已存在时 Linux renameSync 会静默覆盖（用户数据丢失）。
       改为：目标存在则还原到「原名 (还原时间戳)」副本，不覆盖任何现有文件。 */
    let finalDest = dest;
    if (fs.existsSync(dest)) {
      const ext = path.extname(item.original);
      const stem = item.original.slice(0, item.original.length - ext.length);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      finalDest = path.join(path.dirname(dest), `${stem} (还原 ${stamp})${ext}`);
    }
    try {
      fs.mkdirSync(path.dirname(finalDest), { recursive: true });
      fs.renameSync(path.join(this.recycleDir(root), item.id), finalDest);
    } catch (e) { return { ok: false, error: '还原失败：' + e.message }; }
    this.recycleSave(root, list.filter((x) => x.id !== id));
    return { ok: true, restored: path.relative(root, finalDest) };
  }
  recyclePurge(root, days) {
    const list = this.recycleIndex(root);
    const cutoff = days ? Date.now() - days * 86400000 : Infinity;
    let removed = 0;
    const keep = [];
    for (const item of list) {
      if (item.deletedAt < cutoff) {
        try { this.storage.remove(path.join(this.recycleDir(root), item.id)); removed++; } catch {}
      } else keep.push(item);
    }
    this.recycleSave(root, keep);
    return { ok: true, removed };
  }

  versionArchive(root, relPath, user) {
    if (!this.cfg.versionHistory) return null;
    const abs = this.storage.safeResolve(root, relPath);
    if (!abs) return null;
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    const vDir = path.join(root, '.versions', relPath);
    try { fs.mkdirSync(vDir, { recursive: true }); } catch { return null; }
    const vName = new Date(st.mtime).toISOString().replace(/[:.]/g, '-') + '_' + path.basename(relPath);
    try {
      fs.renameSync(abs, path.join(vDir, vName));
      /* 新归档立刻让「整盘版本占用」缓存失效，否则面板要等 60 秒才更新 */
      try { if (this._verUsage) this._verUsage.delete(root); } catch (e) {}
      return vName;
    } catch { return null; }
  }
  /* -------------------------------- 共享链接 -------------------------------- */
  sharesLoad() {
    try { return JSON.parse(fs.readFileSync(path.join(this.cfg.dataDir, 'shares.json'), 'utf8')); } catch { return []; }
  }
  sharesSave(list) {
    try { fs.writeFileSync(path.join(this.cfg.dataDir, 'shares.json'), JSON.stringify(list)); } catch (e) {}
  }
  shareFind(token) {
    const s = this.sharesLoad().find((x) => x.token === token);
    if (!s) return null;
    if (s.expires && Date.now() > s.expires) return null;
    if (s.maxHits && s.hits >= s.maxHits) return null;
    return s;
  }
  shareHit(s) {
    const list = this.sharesLoad();
    const i = list.findIndex((x) => x.token === s.token);
    if (i >= 0) { list[i].hits = (list[i].hits || 0) + 1; this.sharesSave(list); }
  }

  /* -------------------------------- 定时任务 -------------------------------- */
  jobsLoad() {
    try { return JSON.parse(fs.readFileSync(path.join(this.cfg.dataDir, 'jobs.json'), 'utf8')); } catch { return []; }
  }
  jobsSave(list) {
    /* R9：原子写 —— 原来直接覆写 jobs.json，写一半断电会留下半个 JSON，
         下次启动 jobsLoad 直接 catch 掉 → 全部定时任务静默消失。 */
    try {
      const final = path.join(this.cfg.dataDir, 'jobs.json');
      const tmp = final + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list));
      fs.renameSync(tmp, final);
    } catch (e) {}
  }
  /** 目录镜像：src → dst（按 size/mtime 增量，默认不删除目标多余文件） */
  async jobRun(job) {
    /* v3 扩展任务类型：snapshot=目录快照；scrub=完整性巡检；默认=目录镜像 */
    if (job.type === 'snapshot') {
      const r = await snapshots.snapshotDisk(this, job.srcDisk, null, { keep: job.keep || 7 });
      return { ok: !!r.ok, copied: r.entries || 0, skipped: 0, bytes: 0, error: r.error };
    }
    if (job.type === 'scrub') {
      const r = await scrubStore.verifyManifest(this, job.srcDisk, null);
      return { ok: true, copied: r.checked || 0, skipped: (r.corrupted || []).length, bytes: 0, error: r.error };
    }
    const src = this.resolveTarget({ disk: job.srcDisk, path: job.srcPath || '', _acl: false });
    const dst = this.resolveTarget({ disk: job.dstDisk, path: job.dstPath || '', _acl: false });
    if (src.error || dst.error) return { ok: false, error: '源或目标不可用' };
    let copied = 0, skipped = 0, bytes = 0;
    const walk = async (rel) => {
      const sAbs = path.join(src.abs, rel);
      const dAbs = path.join(dst.abs, rel);
      let names = [];
      try { names = fs.readdirSync(sAbs); } catch { return; }
      for (const n of names) {
        const sFile = path.join(sAbs, n);
        const dFile = path.join(dAbs, n);
        let st = null;
        try { st = fs.statSync(sFile); } catch { continue; }
        if (st.isDirectory()) {
          try { fs.mkdirSync(dFile, { recursive: true }); } catch (e) {}
          await walk(rel ? rel + '/' + n : n);
          continue;
        }
        let need = true;
        try {
          const d = fs.statSync(dFile);
          if (d.size === st.size && Math.abs(d.mtimeMs - st.mtimeMs) < 2000) need = false;
        } catch (e) {}
        if (need) {
          try {
            fs.mkdirSync(path.dirname(dFile), { recursive: true });
            await fs.promises.copyFile(sFile, dFile);
            copied++; bytes += st.size;
          } catch (e) {}
        } else skipped++;
      }
    };
    try { fs.mkdirSync(dst.abs, { recursive: true }); } catch (e) {}
    await walk('');
    return { ok: true, copied, skipped, bytes };
  }
  jobsTick() {
    const list = this.jobsLoad();
    const now = Date.now();
    let changed = false;
    /* R9：① 防重入 —— jobRun 是异步的（目录镜像可能跑几分钟），
       10 分钟的定时器再触发一次就会并发跑同一个任务，
       两个进程同时往同一目标目录写 → 结果不可预测。
       ② 跳过上次还没跑完的任务：原来 j.running 只写不清，
       下一轮 tick 完全不看它。 */
    if (this._jobsTicking) return;
    this._jobsTicking = true;
    try {
      for (const j of list) {
        const interval = { hourly: 3600e3, daily: 86400e3, weekly: 6048e5 }[j.schedule] || 86400e3;
        if (j.running) continue;                     // 上一轮还没结束
        if (!j.lastRun || now - j.lastRun >= interval) {
          j.running = true;
          this.jobsSave(list);
          this.jobRun(j).then((r) => {
            const l2 = this.jobsLoad();
            const jj = l2.find((x) => x.id === j.id);
            if (jj) {
              jj.running = false;
              jj.lastRun = Date.now();
              jj.lastStatus = r.ok ? `复制 ${r.copied} 个（跳过 ${r.skipped}）` : ('失败：' + r.error);
            }
            this.jobsSave(l2);
          }).catch((e) => {
            const l2 = this.jobsLoad();
            const jj = l2.find((x) => x.id === j.id);
            if (jj) { jj.running = false; jj.lastStatus = '失败：' + ((e && e.message) || e); }
            this.jobsSave(l2);
          });
          changed = true;
        }
      }
      if (changed) this.jobsSave(list);
    } finally {
      this._jobsTicking = false;
    }
  }

  /* -------------------------------- 健康检查 -------------------------------- */
  health() {
    const out = {
      ts: Date.now(),
      uptime: Math.round(process.uptime()),
      mem: process.memoryUsage(),
      node: process.version,
      load: null, hardlink: null, smartctl: null, battery: null, thermal: null,
      cpuUsedPct: null, loadSupported: false,
      cpuSupported: false, netSupported: false,
      disks: [], alerts: [],
    };
    /* ⚠️ 别再用 `require('os').loadavg()` 直接当 load 返回：**Windows 上它恒返回
       [0,0,0]** —— 不是读不到，是明确的全零，前端把 0 当 falsy 就渲染成「—」；
       更要命的是按 `load.length` 判空会命中 `[0,0,0].length === 3` 这个真值，
       渲染出「0.00 / 0.00 / 0.00」这种**看起来很真、实际是假**的数据。
       同理别用 `process.platform === 'linux'` 判能力：本机部署目标（Termux/Android）
       platform 是 `'android'`，会因为这一刀切而丢掉**真实可用**的 os.loadavg()
       （实测手机上它返回 [10.98, 10.63, 10.5]，是货真价实的负载）。
       统一交给 monitor.snapshot()：它按**数据源实测可用性**给出 loadavg 与三个
       *Supported 能力位，本函数只做透传。 */
    try {
      /* cpuKey='health'：与 /api/station 的 'sample' 基线分开。
         共用一份的话两边会互相重置采样窗口，cpuUsedPct 恒为 null（实测踩到）。 */
      const snap = this.monitor.snapshot('health');
      out.load = snap.loadavg || null;
      out.cpuUsedPct = snap.cpuUsedPct;
      out.loadSupported = snap.loadSupported === true;
      out.cpuSupported = snap.cpuSupported === true;
      out.netSupported = snap.netSupported === true;
    } catch (e) { /* 取不到就保持 null/false，前端会显示「当前环境不支持」 */ }
    // 硬链接能力探测
    try {
      const d = path.join(this.cfg.dataDir, '.hltest');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(d + '/a', 'x');
      try { fs.unlinkSync(d + '/b'); } catch (e) {}
      fs.linkSync(d + '/a', d + '/b');
      out.hardlink = true;
      try { fs.unlinkSync(d + '/b'); fs.unlinkSync(d + '/a'); } catch (e) {}
    } catch (e) { out.hardlink = false; }
    // sysfs 探测（无 root 常读不到，尽力）
    const probe = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return null; } };
    out.battery = probe('/sys/class/power_supply/battery/capacity');
    out.thermal = probe('/sys/class/thermal/thermal_zone0/temp');
    try {
      const { execFileSync } = require('child_process');
      execFileSync('smartctl', ['--version'], { timeout: 3000 });
      out.smartctl = true;
    } catch (e) { out.smartctl = false; }

    // 各盘状态
    const pubRoot = this.resolvePublicRoot().root;
    for (const d of this.listDisks(null)) {
      const isExt = d.kind === 'external';
      const root = isExt ? (this.scanExternal().find((e) => d.id.endsWith(e.label)) || {}).root : pubRoot;
      let st = null;
      try { st = root ? fs.statfsSync(root) : null; } catch (e) {}
      const total = st ? st.blocks * st.bsize : (d.quota || 0);
      const free = st ? st.bavail * st.bsize : 0;
      const usedPct = total ? Math.round(((total - free) / total) * 100) : 0;
      out.disks.push({ id: d.id, name: d.name, writable: d.writable, total, free, usedPct });
      if (total && usedPct >= 90) out.alerts.push(`${d.name} 容量已用 ${usedPct}%`);
      if (isExt && !d.writable) out.alerts.push(`${d.name} 变为只读，请检查供电与文件系统`);
    }
    return out;
  }

  /* v3：看门狗 —— 盘掉线 / 容量阈值 / 只读降级 → 通知 */
  watchdogTick() {
    const out = this.health();
    const now = new Set(out.disks.filter((d) => d.id.startsWith('ext:')).map((d) => d.id));
    if (this._wd && Array.isArray(this._wd.ext)) {
      for (const id of this._wd.ext) {
        if (!now.has(id)) {
          Promise.resolve(this.notifier.send('diskOffline', '外置硬盘掉线', id + ' 已从系统消失（供电/线材/休眠？）')).catch(() => {});
        }
      }
    }
    for (const a of out.alerts) {
      const hard = out.disks.some((d) => a.includes(d.name) && d.usedPct >= 95);
      Promise.resolve(this.notifier.send(hard ? 'quotaHard' : 'quotaSoft', 'NAS 告警', a)).catch(() => {});
    }
    this._wd = { ext: [...now] };
  }

  /* -------------------------------- API Key -------------------------------- */
  keysLoad() {
    /* R1-1-4：每个 API 请求都同步读盘核对 key —— 热路径 IO。
       改为 mtime 缓存：文件没变不重复读；变了（新增/撤销 key）自动失效。 */
    const file = path.join(this.cfg.dataDir, 'keys.json');
    try {
      const st = fs.statSync(file);
      if (!this._keysCache || this._keysCache.mtime !== st.mtimeMs || this._keysCache.size !== st.size) {
        this._keysCache = { mtime: st.mtimeMs, size: st.size, list: JSON.parse(fs.readFileSync(file, 'utf8')) };
      }
      return this._keysCache.list;
    } catch (e) {
      this._keysCache = null;
      return [];
    }
  }
  keysSave(list) {
    /* R1-1-8：与 users/sessions 一致 —— 原子写（.tmp + rename），失败必须留痕。
       此前静默吞错且直接覆写：写一半断电会留下损坏的 keys.json。
       R9：keys.json 里存的是**明文 token**（拿到即等于该用户的身份），
       必须 0600 —— writeFile 的 mode 只在创建时生效，所以还要显式 chmod。 */
    try {
      const final = path.join(this.cfg.dataDir, 'keys.json');
      fs.mkdirSync(path.dirname(final), { recursive: true });
      const tmp = final + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch (e) {}
      fs.renameSync(tmp, final);
      try { fs.chmodSync(final, 0o600); } catch (e) {}
      this._keysCache = null;   // 缓存失效，下次重读
    } catch (e) { console.error('[keys] 保存失败:', e.message); }
  }
  keyCheck(v) {
    if (!v) return null;
    /* R1-1-4：token 比对从 === 改为常量时间（timingSafeEqual），
       消除按字节早退的时序侧信道。长度不匹配走同代价路径（对齐到最长）。 */
    const list = this.keysLoad();
    for (const k of list) {
      const a = Buffer.from(String(k.token || ''), 'utf8');
      const b = Buffer.from(String(v), 'utf8');
      if (a.length !== b.length) continue;   // 长度不同直接跳过（长度本身不敏感）
      try { if (crypto.timingSafeEqual(a, b)) return k; } catch { continue; }
    }
    return null;
  }

  /* -------------------------------- 全文检索 -------------------------------- */
  searchOpen() {
    if (this._db) return this._db;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(this.cfg.dataDir, 'search.db'));
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path, content, tokenize='trigram')");
      this._db = db;
      return db;
    } catch (e) { this._dbErr = e.message; return null; }
  }
  /** 遍历索引：仅文本类（txt/md/csv/log/json/代码/ini/yml/xml/html） */
  async indexBuild(roots) {
    const db = this.searchOpen();
    if (!db) return { ok: false, error: 'sqlite 不可用：' + (this._dbErr || '') };
    db.exec('DELETE FROM docs');
    const TEXT = new Set(['txt','md','csv','log','json','js','ts','css','html','htm','xml','yml','yaml','ini','conf','sh','py','rs','go','java','c','h','cpp','sql','toml']);
    let n = 0;
    const walk = (dir, relBase, rootName) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const nm of names) {
        if (nm.startsWith('.')) continue;
        const full = path.join(dir, nm);
        const rel = relBase ? relBase + '/' + nm : nm;
        let st = null;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.isDirectory()) { walk(full, rel, rootName); continue; }
        if (st.size > 2 * 1024 * 1024) continue;
        const ext = (nm.split('.').pop() || '').toLowerCase();
        if (!TEXT.has(ext)) continue;
        try {
          const text = fs.readFileSync(full, 'utf8').slice(0, 300000);
          db.prepare('INSERT INTO docs(path, content) VALUES(?, ?)').run(rootName + '/' + rel, text);
          n++;
        } catch (e) {}
      }
    };
    for (const r of roots) walk(r.dir, '', r.name);
    return { ok: true, indexed: n };
  }
  searchContent(q, limit = 50) {
    const db = this.searchOpen();
    if (!db) return { ok: false, error: 'sqlite 不可用' };
    try {
      const rows = db.prepare('SELECT path, snippet(docs, 1, "[", "]", "…", 24) AS s FROM docs WHERE docs MATCH ? LIMIT ?').all(q, limit);
      return { ok: true, results: rows };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /* ---------------------------------- 去重 ---------------------------------- */
  dedupScan(root) {
    const bySize = new Map();
    const walk = (dir, rel) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const n of names) {
        if (n.startsWith('.')) continue;
        const full = path.join(dir, n);
        const r = rel ? rel + '/' + n : n;
        let st = null;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.isDirectory()) { walk(full, r); continue; }
        if (st.size === 0) continue;
        if (!bySize.has(st.size)) bySize.set(st.size, []);
        bySize.get(st.size).push(r);
      }
    };
    walk(root, '');
    const groups = [];
    /* R2-2-10：超大文件（>256MB）只按 size 分组不读内容（原实现整文件 readFileSync 会 OOM）；
       常规文件读入上限 64MB（再大者也降级为 size 分组）。 */
    const HASH_CAP = 64 * 1024 * 1024;
    const SKIP_HASH = 256 * 1024 * 1024;
    for (const [size, list] of bySize) {
      if (list.length < 2) continue;
      if (size > SKIP_HASH) {
        groups.push({ hash: null, size, files: list });   // 仅按大小疑似重复，交人工确认
        continue;
      }
      const byHash = new Map();
      for (const rel of list) {
        try {
          const buf = fs.readFileSync(path.join(root, rel));
          const h = crypto.createHash('sha256').update(buf).digest('hex');
          if (!byHash.has(h)) byHash.set(h, []);
          byHash.get(h).push(rel);
        } catch (e) {}
      }
      if (size > HASH_CAP) { groups.push({ hash: null, size, files: list }); continue; }
      for (const [h, files] of byHash) {
        if (files.length > 1) groups.push({ hash: h, size, files });
      }
    }
    return groups;
  }

  /* ------------------------- 媒体元数据（JPEG/MP4 手写解析） ------------------------- */
  metaOf(abs) {
    const out = {};
    let fd = null;
    try {
      const buf = Buffer.alloc(Math.min(fs.statSync(abs).size, 512 * 1024));
      fd = fs.openSync(abs, 'r');
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd); fd = null;
      if (buf[0] === 0xff && buf[1] === 0xd8) {
        out.type = 'jpeg';
        const dims = this._jpegSize(buf);
        if (dims) { out.width = dims.w; out.height = dims.h; }
        const exif = this._jpegExif(buf);
        if (exif) Object.assign(out, exif);
      } else if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
        out.type = 'mp4';
        const m = this._mp4Info(buf);
        if (m) Object.assign(out, m);
      }
    } catch (e) {}
    return out;
  }
  _jpegSize(buf) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
    return null;
  }
  _jpegExif(buf) {
    try {
      let i = 2;
      while (i < buf.length - 4) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xe1) {
          const len = buf.readUInt16BE(i + 2);
          const seg = buf.slice(i + 4, i + 2 + len);
          if (seg.slice(0, 4).toString('ascii') === 'Exif') {
            const tiff = seg.slice(6);
            const le = tiff.slice(0, 2).toString('ascii') === 'II';
            const ifd = tiff.readUInt32LE ? (le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4)) : 0;
            const count = le ? tiff.readUInt16LE(ifd) : tiff.readUInt16BE(ifd);
            const out = {};
            for (let e = 0; e < Math.min(count, 64); e++) {
              const off = ifd + 2 + e * 12;
              if (off + 12 > tiff.length) break;
              const tag = le ? tiff.readUInt16LE(off) : tiff.readUInt16BE(off);
              const type = le ? tiff.readUInt16LE(off + 2) : tiff.readUInt16BE(off + 2);
              const valOff = off + 8;
              let val = null;
              if (type === 2) {
                const size = le ? tiff.readUInt32LE(off + 4) : tiff.readUInt32BE(off + 4);
                const start = size > 4 ? (le ? tiff.readUInt32LE(valOff) : tiff.readUInt32BE(valOff)) : valOff;
                if (start + size <= tiff.length) val = tiff.slice(start, start + size).toString('ascii').replace(/\0+$/, '').trim();
              } else if (type === 3 || type === 4) {
                val = le ? tiff.readUInt16LE(valOff) : tiff.readUInt16BE(valOff);
              }
              if (tag === 0x010f && val) out.cameraMake = val;
              if (tag === 0x0110 && val) out.cameraModel = val;
              if (tag === 0x0132 && val) out.shotAt = val;
              if (tag === 0x0112 && val != null) out.orientation = val;
            }
            return out;
          }
        }
        if (marker === 0xda) break;
        const len = buf.readUInt16BE(i + 2);
        i += 2 + len;
      }
    } catch (e) {}
    return null;
  }
  _mp4Info(buf) {
    try {
      const s = buf.toString('latin1');
      const i = s.indexOf('tkhd');
      if (i < 0) return null;
      const ver = buf[i + 4];
      const off = i + 4 + (ver === 1 ? 32 : 20);
      const w = buf.readUInt32BE(off + 52) / 65536;
      const h = buf.readUInt32BE(off + 56) / 65536;
      const out = { width: Math.round(w), height: Math.round(h) };
      const mi = s.indexOf('mvhd');
      if (mi >= 0) {
        const v2 = buf[mi + 4];
        const ts = v2 === 1 ? Number(buf.readBigUInt64BE(mi + 28)) : buf.readUInt32BE(mi + 20);
        const dur = v2 === 1 ? Number(buf.readBigUInt64BE(mi + 36)) : buf.readUInt32BE(mi + 24);
        if (ts && dur) out.duration = Math.round(dur / ts);
      }
      return out;
    } catch (e) { return null; }
  }

  /* R11：整盘版本占用统计。
     版本是按文件看的，谁也说不清整盘 .versions 吃了多少 —— 于是没人知道
     该不该清。这里从版本根目录 walk 一遍，按 root 缓存 60 秒。 */
  versionUsage(root) {
    const now = Date.now();
    this._verUsage = this._verUsage || new Map();
    const hit = this._verUsage.get(root);
    if (hit && now - hit.ts < 60 * 1000) return hit.data;
    const vRoot = path.join(root, '.versions');
    const out = { bytes: 0, count: 0, dirs: 0, top: [] };
    const walk = (dir, rel, depth) => {
      if (depth > 8) return null;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return null; }
      let local = 0, localCount = 0;
      for (const n of names) {
        const full = path.join(dir, n);
        let st = null;
        try { st = fs.lstatSync(full); } catch { continue; }
        if (st.isDirectory()) {
          out.dirs++;
          const sub = walk(full, rel ? rel + '/' + n : n, depth + 1);
          if (sub) { local += sub.bytes; localCount += sub.count; }
        } else if (st.isFile()) {
          out.bytes += st.size; out.count++; local += st.size; localCount++;
        }
      }
      return { bytes: local, count: localCount, rel };
    };
    walk(vRoot, '', 0);
    /* 只留占得最多的前 8 个路径，够用户判断"谁在吃空间" */
    const tops = [];
    const collect = (dir, rel, depth) => {
      if (depth > 8) return 0;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return 0; }
      let sum = 0, cnt = 0;
      for (const n of names) {
        const full = path.join(dir, n);
        let st = null;
        try { st = fs.lstatSync(full); } catch { continue; }
        if (st.isDirectory()) {
          const sub = collect(full, rel ? rel + '/' + n : n, depth + 1);
          sum += sub.bytes; cnt += sub.count;
        } else if (st.isFile()) { sum += st.size; cnt++; }
      }
      if (rel) tops.push({ path: rel, bytes: sum, count: cnt });
      return { bytes: sum, count: cnt };
    };
    collect(vRoot, '', 0);
    out.top = tops.sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    this._verUsage.set(root, { ts: now, data: out });
    return out;
  }

  versionList(root, relPath) {
    const vDir = path.join(root, '.versions', relPath);
    if (!fs.existsSync(vDir)) return [];
    try {
      return fs.readdirSync(vDir).map((n) => {
        let st = null;
        try { st = fs.statSync(path.join(vDir, n)); } catch {}
        return { name: n, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
      }).sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
  }

  /* -------------------------------- 工具方法 ------------------------------- */

  /** 公共盘根目录：固定应用内存储（256G 空间池，64G 配额限制），跨运行上下文行为一致 */
  resolvePublicRoot() {
    if (this._publicRoot) return this._publicRoot;
    const app = path.join(this.cfg.dataDir, 'storage', 'public');
    fs.mkdirSync(app, { recursive: true });
    this._publicRoot = { root: app, location: 'app' };
    return this._publicRoot;
  }

  /**
   * 扫描外置硬盘。安卓 FUSE 下 /storage 顶层禁止 readdir（EACCES），
   * 但已知卷路径可直接访问 → 改从 /proc/self/mountinfo 解析挂载点。
   */
  /**
   * 扫描外置卷（U 盘 / 移动硬盘 / SD 卡）。
   *
   * ⚠️ 重要：Termux 访问 /storage/<UUID> 需要「所有文件访问权限」
   *    (MANAGE_EXTERNAL_STORAGE)。权限被拒时 statSync 抛 EACCES，
   *    旧实现静默 catch 掉，导致「盘明明插着却在界面消失」且无任何提示。
   *    现在把失败原因记进 this._extErrors，由 /api/disks 与 /api/health 上报。
   */
  scanExternal() {
    const out = [];
    const failures = [];
    const BUILTIN = /^(emulated|self|sdcard\d+)$/;
    let mounts = '';
    try { mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8'); }
    catch { try { mounts = fs.readFileSync('/proc/mounts', 'utf8'); } catch { return out; } }

    const seen = new Set();
    for (const line of mounts.split('\n')) {
      // mountinfo: 第5字段为挂载点；兼容 /proc/mounts 格式
      const m = /\s(\/storage\/[^\s]+)\s/.exec(line);
      if (!m) continue;
      const root = m[1];
      const name = root.slice('/storage/'.length);
      // 只取顶层卷：名字不含 /（排除 Android/data 等嵌套伪挂载），排除内置卷
      if (!name || name.includes('/') || BUILTIN.test(name)) continue;
      seen.add(name);
      try {
        if (!fs.statSync(root).isDirectory()) continue;
        let writable = false;
        try {
          const probe = path.join(root, '.fs-probe');
          fs.writeFileSync(probe, 'x');
          fs.unlinkSync(probe);
          writable = true;
        } catch {}
        let total = 0, free = 0;
        try {
          const s = fs.statfsSync(root);
          total = s.blocks * s.bsize;
          free = s.bavail * s.bsize;
        } catch {}
        out.push({ id: 'ext:' + name, label: name, title: this._diskTitle(name), root, writable, total, free });
      } catch (e) {
        // 关键：EACCES = 存储权限缺失，必须让上层看得见
        failures.push({
          label: name,
          root,
          code: e && e.code ? e.code : 'UNKNOWN',
          reason: (e && e.code === 'EACCES')
            ? 'Termux 缺少「所有文件访问权限」(MANAGE_EXTERNAL_STORAGE)，无法读取 U 盘'
            : '无法访问该挂载点',
        });
      }
    }
    this._extErrors = failures;
    if (failures.length) {
      const tag = failures.map((f) => f.label + ':' + f.code).join(', ');
      console.warn('[disk] 检测到 ' + failures.length + ' 个挂载点不可访问 → ' + tag);
    }
    return out;
  }

  /* ------------------------------------------------------------------
     外置盘「显示名」。
     背景：Android 把 U 盘挂到 /storage/<卷UUID>，所以盘名天然是一串 UUID
     （ext-3958C42896D9CFFD 这种），用户完全认不出哪块是哪块。

     理论上应该直接读卷标，但实测这条路走不通：
       · dumpsys mount 里确实有 fsLabel（真实卷标），可它需要
         android.permission.DUMP —— Termux 身份被拒（uid 10235）；
       · 裸设备 /dev/block/vold/… 对 Termux 是 Permission denied（不在 media_rw 组）；
       · Termux 自带没有 blkid/busybox。
     所以改为「配置文件 + 允许用户自己改名」：data/disk-labels.json 里
     UUID → 显示名。首次由管理员用真机读到的卷标播种，之后可在界面上改。

     ⚠️ 注意：**绝不能改 ext.label** —— server.js 里
     `find((e) => d.id.endsWith(e.label))` 靠 label 反查磁盘根目录。
     所以显示名单独放在 title 字段，label 永远保持 UUID 原样。
     ------------------------------------------------------------------ */

  /** 读取 UUID → 显示名 的映射（按 mtime 缓存，避免每次请求都读盘） */
  _diskTitleMap() {
    const f = path.join(this.cfg.dataDir, 'disk-labels.json');
    try {
      const st = fs.statSync(f);
      if (this._dtitleCache && this._dtitleMtime === st.mtimeMs) return this._dtitleCache;
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      const clean = {};
      for (const [k, v] of Object.entries(obj || {})) {
        if (typeof v === 'string' && v.trim()) clean[String(k)] = v.trim();
      }
      this._dtitleCache = clean;
      this._dtitleMtime = st.mtimeMs;
      return clean;
    } catch {
      // 文件不存在/损坏都静默当作"没有自定义名"，退回原规则
      this._dtitleCache = {};
      this._dtitleMtime = null;
      return this._dtitleCache;
    }
  }

  /** 某块外置盘的自定义显示名；没有则返回 null（调用方回退到容量名/ext-UUID） */
  _diskTitle(uuid) { return this._diskTitleMap()[uuid] || null; }

  /**
   * 按显示名反查盘符（给 dav/ftp/merge 的反向解析用）。
   *
   * ⚠️ 这里**只能查缓存表**，绝不能调 scanExternal()：
   * 那个函数会对每块盘做 stat + 真实写入探针(.fs-probe) + unlink + statfs，
   * 一旦放进"每个请求都要走"的反查路径上，等于每次请求都去 U 盘写删一遍 ——
   * 实测会把目录列举拖到 I/O 超时（2026-09-16 踩过：进盘报 Input/output error）。
   * 返回 null 表示不是自定义名，调用方继续走原有别名规则。
   */
  findDiskByTitle(name) {
    if (!name) return null;
    const m = this._diskTitleMap();
    for (const uuid of Object.keys(m)) if (m[uuid] === name) return 'ext:' + uuid;
    return null;
  }

  /** 设置/清除某块外置盘的显示名（title 为空表示清除，回退默认规则） */
  setDiskTitle(uuid, title) {
    const key = String(uuid || '').replace(/^ext:/, '').trim();
    if (!key) throw new Error('缺少磁盘标识');
    const t = String(title == null ? '' : title).trim().slice(0, 24);
    const f = path.join(this.cfg.dataDir, 'disk-labels.json');
    let obj = {};
    try { obj = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { /* 首次创建 */ }
    if (t) obj[key] = t; else delete obj[key];
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
    this._dtitleMtime = null;            // 失效缓存，下次立即重读
    this._dtitleCache = null;
    return t || null;
  }

  /** 外置盘扫描失败详情（供 /api/disks 附带，前端可提示用户去授权） */
  externalErrors() { return this._extErrors || []; }

  /** 目录占用字节数（15s 缓存） */
  usedBytes(dir) {
    const now = Date.now();
    if (this._sizeCache && this._sizeCache.dir === dir && now - this._sizeCache.ts < 15000) {
      return this._sizeCache.used;
    }
    let used = 0;
    const walk = (d) => {
      let names = [];
      try { names = fs.readdirSync(d); } catch { return; }
      for (const n of names) {
        const full = path.join(d, n);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full);
        else used += st.size;
      }
    };
    walk(dir);
    this._sizeCache = { dir, used, ts: now };
    return used;
  }

  invalidateSizeCache() { this._sizeCache = null; }

  /**
   * R3-9（P2）：写入前配额校验（供 WebDAV/S3/FTP/NFS 等协议写路径复用）。
   * 原实现只有 chunk-init / upload 检查 PUBLIC_QUOTA，协议写路径只记账不拦截。
   * @param {string} disk 盘符
   * @param {string} root 盘根绝对路径
   * @param {number} addBytes 本次要写入的字节数（未知传 0/NaN → 放行）
   * @returns {boolean} true = 允许写入
   */
  quotaOk(disk, root, addBytes) {
    if (disk !== 'public') return true;
    if (!Number.isFinite(addBytes) || addBytes <= 0) return true;
    try { return this.usedBytes(root) + addBytes <= PUBLIC_QUOTA; } catch { return true; }
  }

  /** 盘符列表（外置盘/私人盘信息由调用方决定是否对游客脱敏，见 /api/disks 分级披露） */
  listDisks(user) {
    const pub = this.resolvePublicRoot();
    const disks = [{
      id: 'public',
      name: '公共盘',
      kind: 'builtin',
      writable: true,
      used: this.usedBytes(pub.root),
      quota: PUBLIC_QUOTA,
      location: pub.location,
    }];
    if (user) {
      const dir = path.join(this.cfg.storageDir, 'users', user.id);
      fs.mkdirSync(dir, { recursive: true });
      disks.push({
        id: 'private', name: '私人空间', kind: 'builtin',
        writable: true, used: this.usedBytes(dir), quota: null, location: 'app',
      });
    }
    const exts = this.scanExternal();
    exts.forEach((ext, i) => {
      disks.push({
        id: ext.id,
        /* title 来自 data/disk-labels.json（用户可改）；没有就用老的
           「外置硬盘 N (UUID前4位)」。三个协议层的显示名函数都会优先取 title。 */
        title: ext.title || null,
        name: ext.title || `外置硬盘 ${i + 1} (${ext.label.slice(0, 4)})`,
        kind: 'external',
        writable: ext.writable,
        used: ext.total ? ext.total - ext.free : 0,
        quota: ext.total || null,
        free: ext.free,
        location: 'usb',
      });
    });
    try {
      if (!this.isAdmin(user)) return disks.filter((d) => !this.diskVis.isHidden(d.id));
    } catch (e) {}
    return disks;
  }

  /**
   * 解析盘符 + 相对路径 → 绝对路径（兼容旧 scope 参数）
   * 盘符：public | private | ext:XXXX-XXXX
   */
  resolveTarget(query, user) {
    const disk = query.disk || query.scope || 'public';
    let root = null, kind = disk;

    /* ACL 盘级权限。判定异常时**拒绝**而不是放行 ——
       「配置读不出来」不等于「有权限」。fail-open 会让一次配置损坏
       把整个外置硬盘变成匿名可读（R9 要消灭的正是这类事故）。
       内部调用（定时任务镜像、快照索引）传 _acl:false 显式旁路。 */
    if (query._acl !== false) {
      try {
        const perm = aclStore.checkPerm(this, user, disk, !!query._write);
        if (!perm.ok) return { error: 'ACL 拒绝访问该盘符', code: 403 };
      } catch (e) {
        console.error('[acl] 权限判定异常，已拒绝访问:', (e && e.message) || e);
        return { error: '权限判定异常，已拒绝访问', code: 403 };
      }
    }

    if (query._acl !== false && !this.isAdmin(user)) {
      try {
        if (this.diskVis && this.diskVis.isHidden(disk)) return { error: 'storage disk not shared', code: 403 };
      } catch (e) {}
    }
    if (disk === 'public') {
      root = this.resolvePublicRoot().root;
    } else if (disk === 'private') {
      if (!user) return { error: '私人空间需要登录后访问', code: 401 };
      root = path.join(this.cfg.storageDir, 'users', user.id);
      fs.mkdirSync(root, { recursive: true });
    } else if (disk.startsWith('ext:')) {
      const label = disk.slice(4);
      const ext = this.scanExternal().find((e) => e.label === label);
      if (!ext) return { error: '外置硬盘不在线（可点盘符栏刷新）', code: 404 };
      if (!ext.writable && (query._write || false)) return { error: '该外置硬盘为只读', code: 403 };
      root = ext.root;
      kind = 'ext';
    } else {
      return { error: '未知盘符: ' + disk, code: 400 };
    }

    const abs = this.storage.safeResolve(root, query.path || '');
    if (!abs) return { error: '非法路径', code: 400 };
    /* R2-2-6（P1）：回收站/版本历史/快照属于系统内部目录，外部请求一律不得直接访问。
       原实现只在 storage.list 的「当前目录层」过滤，path=.recycle 可绕过，
       download/search/zip 更是完全不过滤 → 游客可读已删文件。
       统一在 resolveTarget 拦截（内部逻辑用 _sysDir:true 显式豁免，如回收站还原）。 */
    if (query._sysDir !== true) {
      const rel = path.relative(root, abs);
      if (rel === '.recycle' || rel === '.versions' || rel === '.snapshots' ||
          rel.startsWith('.recycle' + path.sep) || rel.startsWith('.versions' + path.sep) ||
          rel.startsWith('.snapshots' + path.sep)) {
        return { error: '系统目录不可访问', code: 403 };
      }
    }
    return { root, abs, scope: disk === 'private' ? 'private' : disk, disk };
  }

  requireWrite(user) {
    if (!user) return { error: '需要登录后才能执行写操作', code: 401 };
    return null;
  }

  /**
   * 把用户加入 ACL 的某个用户组（幂等）。
   * 为什么需要：收紧后的 ACL 用「组」表达「登录用户」的权限
   * （public: guest=ro / group:users=rw）。新注册用户若不进组，
   * 登录后仍然什么都看不到 —— 那是「安全收紧顺带制造的功能性回归」，
   * 不是安全收益。组不存在时视为无权（resolvePerm 对无命中返回 none）。
   */
  aclEnsureGroupMember(username, group) {
    const name = String(username || '').trim();
    if (!name || !group) return false;
    try {
      const data = aclStore.loadAcl(this);
      if (!data.groups || typeof data.groups !== 'object') data.groups = {};
      const list = Array.isArray(data.groups[group]) ? data.groups[group] : [];
      if (list.includes(name)) return false;
      list.push(name);
      data.groups[group] = list;
      aclStore.saveAcl(this, data);
      return true;
    } catch (e) {
      console.error('[acl] 加入用户组失败:', (e && e.message) || e);
      return false;
    }
  }

  /* --------------------------------- 路由 --------------------------------- */

  async handle(req, res) {
    /* 规整请求路径后再解析绝对 URL：
       - 形如 "//?x=1" 的请求会让 new URL(raw, base) 抛 ERR_INVALID_URL
       - 该抛点若在 try 之外，会直接崩掉整个进程（任何客户端发一个 // 即可 DoS）
       这里统一折叠重复斜杠并补齐前导斜杠，保证 URL 构造必然合法。 */
    let rawUrl = String(req.url || '/');
    if (!rawUrl.startsWith('/')) rawUrl = '/' + rawUrl;
    rawUrl = rawUrl.replace(/\/{2,}(?=[/?#]|$)/g, '/');
    if (rawUrl.startsWith('//')) rawUrl = '/' + rawUrl.replace(/^\/+/, '');

    let url;
    try {
      url = new URL(rawUrl, 'http://' + (req.headers.host || 'localhost'));
    } catch (e) {
      return sendText(res, 400, 'Bad Request');
    }
    const pathname = (() => { try { return decodeURIComponent(url.pathname); } catch { return url.pathname; } })();
    const query = parseQuery(rawUrl);

    req.setTimeout(0);

    try {
      // WebDAV 协议（挂载映射 / rclone / 手机文件管理器）
      if (pathname === DAV_PREFIX || pathname.startsWith(DAV_PREFIX + '/')) {
        return await this.dav.handle(req, res, pathname);
      }
      // S3 兼容对象存储（SigV4 / Multipart / ListObjectsV2）—— 前缀独占，网关必回响应
      if (pathname === '/s3' || pathname.startsWith('/s3/')) {
        await this.s3.handle(req, res, pathname, query);
        return;
      }
      // DLNA（设备描述 XML + ContentDirectory SOAP）
      if (pathname.startsWith('/dlna/')) {
        await this.dlna.handle(req, res, pathname);
        return;
      }
      // REST API v1 + 文档页（自带 Key 鉴权）
      if (pathname === '/api/doc' || pathname.startsWith('/api/v1/') || pathname === '/api/v1') {
        await this.apiv1.handle(req, res, pathname, query);
        return;
      }
      if (pathname.startsWith('/api/')) return await this.handleApi(req, res, pathname, query);
      // v4.1：限时分享链接（免登录、凭 token 取件，凭据在创建时已固化权限）
      if (pathname.startsWith('/s/')) return await this.serveShare(req, res, pathname.slice(3), query);
      return this.handleStatic(req, res, pathname);
    } catch (err) {
      if (err && err.code === 'PAYLOAD_TOO_LARGE') {
        return sendJSON(res, 413, { error: `上传体积超过上限 ${this.cfg.maxUploadMB} MB` });
      }
      /* R7-7-3：路由里大量 JSON.parse(body) —— 非 JSON 请求体（如跨站表单 POST）
         原先直接冒成 500 并打堆栈。语法错误属客户端问题，回 400 更准确，
         也避免把内部堆栈写进日志（减少噪声与信息面）。 */
      if (err instanceof SyntaxError) {
        return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
      }
      console.error('[error]', err);
      try { sendJSON(res, 500, { error: '服务器内部错误' }); } catch { /* 连接已断 */ }
    }
  }

  async handleApi(req, res, pathname, query) {
    let user = this.currentUser(req);
    const m = req.method;

    /* R15-EXT-ROUTES：可插拔扩展路由（lib/routes/*.js）优先于下面这条巨大的
       if-else 链。模块返回 true 表示已完整处理（响应已发出），直接 return。
       这样每个功能模块都能在自己的文件里加接口，避免并行改造时改同一行。 */
    try {
      if (await extRoutes.handle({
        req, res, app: this, user, pathname, method: m, query,
        sendJSON, sendText, readBody,
      })) return;
    } catch (e) {
      console.error('[routes]', e);
      try { if (!res.headersSent) sendJSON(res, 500, { error: '服务器内部错误（扩展路由）' }); } catch { /* 已断 */ }
      return;
    }

    /* 真机性能上报（public/games/_perfprobe.js 探针专用）。
       手机浏览器无法开 CDP，这是唯一能拿到**真机**帧率数字的通道。
       匿名可写是刻意的：探针要在未登录的游客态下也能上报；
       风险面仅限往一个 jsonl 追加数据，故限制单条体积并只允许白名单 kind。 */
    if (pathname === '/api/perf-report' && m === 'POST') {
      try {
        const raw = await readBody(req);
        const txt = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
        if (txt.length > 64 * 1024) return sendJSON(res, 413, { error: '上报体积过大' });
        let obj;
        try { obj = JSON.parse(txt); } catch { return sendJSON(res, 400, { error: '不是合法 JSON' }); }
        /* R11：ui-storm = 前端 DOM 变异风暴（疑似自激循环）上报。
           这类故障不抛异常、接口全绿，只能靠页面自己量出来。 */
        const ALLOWED = new Set(['fps', 'fps-error', 'fps-done', 'fps-wait', 'fps-battle',
          'fps-nobattle', 'ui-storm']);
        if (!obj || !ALLOWED.has(obj.kind)) return sendJSON(res, 400, { error: 'kind 不在白名单' });
        const line = JSON.stringify({
          at: new Date().toISOString(),
          ip: String(req.socket && req.socket.remoteAddress || ''),
          ...obj,
        });
        const dir = path.join(__dirname, 'data');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        fs.appendFileSync(path.join(dir, 'perf-reports.jsonl'), line + '\n');
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        return sendJSON(res, 500, { error: '写入失败: ' + (e && e.message) });
      }
    }

    /* 读回真机性能上报（只读诊断用）。
       刻意要求管理员：里面含上报者 IP 与 UA，匿名可读没必要。
       默认只回最近 N 条并按时间倒序，便于我直接看最新一轮结果。 */
    if (pathname === '/api/perf-reports' && m === 'GET') {
      if (!user || (user.role !== 'admin' && !user.isAdmin)) {
        return sendJSON(res, 403, { error: '需要管理员权限' });
      }
      const file = path.join(__dirname, 'data', 'perf-reports.jsonl');
      let rows = [];
      try {
        rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      } catch { /* 文件还没生成 */ }
      const limit = Math.min(parseInt(query.limit || '80', 10) || 80, 500);
      const items = rows.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      items.reverse();
      const want = String(query.kind || '');
      const filtered = want ? items.filter((r) => r.kind === want) : items;
      return sendJSON(res, 200, { total: rows.length, count: filtered.length, items: filtered });
    }

    /* R8-P0-2（审计代理 R7 报告）：API Key 合成用户原先**硬编码 role:'admin'** ——
       而建 key 只要求登录，不要求管理员 ⇒ 任意普通用户建一个 key 即可越权到管理员
       （实测：普通用户的 key 调 /api/admin/users 返回 200、/api/me 显示 role=admin）。
       修法：角色一律取 key 属主的**真实角色/状态**；属主被删或禁用则 key 失效。 */
    if (!user) {
      const kv = req.headers['x-api-key'] || query.apikey;
      if (kv) {
        const k = this.keyCheck(kv);
        if (k) {
          const owner = this.users.findByName(String(k.owner || ''));
          if (owner && !owner.disabled) {
            user = {
              id: 'api:' + k.id, username: k.owner,
              role: owner.role === 'admin' ? 'admin' : 'user',
              viaKey: true,
            };
          }
        }
      }
    }

    /* ----- 认证 ----- */
    /* R1-1-10：register/login 都过 per-IP 限速（注册同样可被爆破/刷号） */
    if (pathname === '/api/captcha' && m === 'GET') {
      const c = _genCaptcha();
      return sendJSON(res, 200, { id: c.id, svg: c.svg, ttl: 120 });
    }

    if (pathname === '/api/register' && m === 'POST') {
      const rl = this.loginRateCheck(req.socket.remoteAddress);
      if (rl) return sendJSON(res, rl.code, { error: rl.error });
      /* R9：注册频率闸门（替代无法在前端强制实施的验证码，见 registerRateCheck 注释） */
      const rr = this.registerRateCheck(req.socket.remoteAddress);
      if (rr) return sendJSON(res, rr.code, { error: rr.error });
      const body = await readBody(req, 64 * 1024);
      const parsed = JSON.parse(body.toString('utf8') || '{}');
      const { username, password } = parsed;
      if (!_verifyCaptcha(parsed.captchaId, parsed.captchaCode)) return sendJSON(res, 400, { error: '图形验证码错误或已过期' });
      /* 客户端没带验证码（现网 SPA 就是这样）→ 记一笔，便于发现批量注册 */
      if (!parsed.captchaId) {
        this.audit({ action: 'register-no-captcha', detail: String(username || ''), ip: req.socket.remoteAddress, ok: false });
      }
      /* R9：口令下限提到 10（模块默认仍为 6，以免作废既有账号）；
         scrypt 走**异步**版 —— 同步 scrypt(N=16384) 每次 50-150ms 且独占事件循环，
         并发登录/DAV 认证足以把 WebDAV、静态资源、SSE 一起卡住。 */
      const r = await this.users.createAsync(username, password, { minLength: 10 });
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      this.registerRateHit(req.socket.remoteAddress);
      /* 新注册用户自动进入 ACL 的 users 组。
         否则收紧后的默认 ACL（public: guest=ro / group:users=rw）
         会让新注册的同事「登录了却什么都看不到」。 */
      this.aclEnsureGroupMember(r.user.username, 'users');
      /* R11：注册即开通同名 SMB 账号（可读可写）。
         明文口令只在这一刻可用 —— 存库的是 scrypt 哈希，之后再也推不出来。 */
      let smbReady = false;
      try {
        if (smbUsers.NAME_RE.test(String(r.user.username || ''))) {
          const made = smbUsers.ensureSmbUser(r.user.username, password);
          if (made.ok) {
            smbUsers.addUserToShares(r.user.username);
            smbUsers.reloadSamba();
            smbReady = true;
            /* 记下指纹：首次登录时就不必再把同一个密码写一遍 */
            const fpStore = this._smbFpLoad();
            fpStore[r.user.username] = this._smbFp(r.user.username, password);
            this._smbFpSave(fpStore);
          } else {
            console.warn('[smb] 注册时开通共享失败：' + made.error);
          }
        }
      } catch (e) {
        console.warn('[smb] 注册时开通共享异常：' + (e && e.message));
      }
      const s = this.sessions.create(r.user.id);
      this.setSessionCookie(res, s.id, req);
      return sendJSON(res, 200, {
        ok: true,
        user: this.users.publicUser(r.user),
        isAdmin: r.user.role === 'admin',
        smb: smbReady ? { username: r.user.username, host: '\\\\' + this.smbHost() } : null,
      });
    }

    /* 分享链接（无需登录，只读）
       R15.1：这一条通配写法会**先于**末尾的 /api/share/create|list|revoke 命中，
       把 /api/share/list 当成 token=\"list\" 去查，前端「我的分享」永远 404。
       这里显式排除管理类子路径，让它们落到各自的处理分支。 */
    const SHARE_MANAGE = ['/api/share/create', '/api/share/list', '/api/share/revoke'];
    if (pathname.indexOf('/api/share/') === 0 && m === 'GET' && !SHARE_MANAGE.includes(pathname)) {
      const token = decodeURIComponent(pathname.slice('/api/share/'.length));
      const r = this.docs.getShare(token);
      if (!r.ok) return sendJSON(res, 404, { error: r.error });
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/login' && m === 'POST') {
      const rl = this.loginRateCheck(req.socket.remoteAddress);
      if (rl) return sendJSON(res, rl.code, { error: rl.error });
      const body = await readBody(req, 64 * 1024);
      const parsedL = JSON.parse(body.toString('utf8') || '{}');
      const { username, password, totp: totpCode } = parsedL;
      if (!_verifyCaptcha(parsedL.captchaId, parsedL.captchaCode)) return sendJSON(res, 400, { error: '图形验证码错误或已过期' });
      /* v4：禁用账号给出明确提示（verify 对禁用一律 null，这里提前区分） */
      const du = this.users.findByName(String(username || ''));
      if (du && du.disabled) {
        this.loginRateFail(req.socket.remoteAddress);
        this.audit({ action: 'login-fail', detail: username + ' (disabled)', ip: req.socket.remoteAddress, ok: false });
        return sendJSON(res, 403, { error: '账号已被管理员禁用' });
      }
      /* R9：异步 scrypt，避免独占事件循环（见注册端点注释）。 */
      const u = await this.users.verifyAsync(username || '', password || '');
      if (!u) {
        this.loginRateFail(req.socket.remoteAddress);
        this.audit({ action: 'login-fail', detail: username, ip: req.socket.remoteAddress, ok: false });
        return sendJSON(res, 401, { error: '用户名或密码错误' });
      }
      /* v3：2FA（TOTP，按用户可选启用） */
      if (u.totpEnabled) {
        if (!totpCode) return sendJSON(res, 200, { need2fa: true });
        /* R9：把「该用户已用过的最大时间步」交给库内判定（opts.counter）。
           原先由 server 侧比较 tv.counter <= u.totpLastCounter —— 而旧版 verify()
           **根本不返回 counter**，那个分支恒不成立：重放保护是死代码，
           同一个验证码在 90 秒窗口内可无限次复用（截获一次即可二次登录）。
           现在库内直接比对并区分「码错」与「重放」。 */
        const tv = totpLib.verify(u.totpSecret, String(totpCode).trim(), { counter: u.totpLastCounter });
        if (!tv.ok) {
          this.loginRateFail(req.socket.remoteAddress);
          this.audit({ action: 'login-fail', detail: username + (tv.stale ? ' (2FA 重放)' : ' (2FA)'), ip: req.socket.remoteAddress, ok: false });
          return sendJSON(res, 401, {
            error: tv.stale ? '该动态验证码已被使用，请等下一个码' : '动态验证码错误',
            need2fa: true,
          });
        }
        if (Number.isFinite(tv.counter)) {
          u.totpLastCounter = tv.counter;
          try { this.users.save(); } catch { /* 落盘失败不阻塞登录 */ }
        }
      }
      /* R11：登录即把 SMB 密码同步成网页密码。
         密码没改过时只是一次 HMAC 比较（零子进程），改过才真去写 Samba。 */
      try {
        const sr = await this.syncSmbAccount(u, password || '');
        if (sr.synced) {
          this.audit({ userObj: u, action: 'smb-sync', ok: true,
            detail: sr.created ? '新建 SMB 账号并同步密码' : '密码已同步' });
        }
      } catch (e) {
        console.warn('[smb] 登录同步异常：' + (e && e.message));
      }
      this.audit({ userObj: u, action: 'login', ip: req.socket.remoteAddress });
      const s = this.sessions.create(u.id);
      this.setSessionCookie(res, s.id, req);
      return sendJSON(res, 200, { ok: true, user: this.users.publicUser(u) });
    }

    if (pathname === '/api/logout' && m === 'POST') {
      this.clearSessionCookie(req, res);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && m === 'GET') {
      /* R1-1-9：注册人数只对登录用户可见（给游客暴露用户规模属信息泄漏） */
      return sendJSON(res, 200, {
        user: this.users.publicUser(user),
        guest: !user,
        canWrite: !!user,
        registeredUsers: user ? this.users.count : undefined,
      });
    }

    /* =================================================================
       R11：文件共享（SMB）自助开通
       ------------------------------------------------------------------
       用户的困惑是真实的：SMB 有独立的账号库（smbpasswd），和网页登录、
       SSH 账号都不是一回事。原来服务器上只有 Dozin / dav 两个 Samba 账户，
       网页注册的账号在 SMB 侧根本不存在，输什么密码都连不上。

       这里让每个工作站账户都能给自己开一个同名 SMB 账号：
         · 需要同名 Linux 账户（Samba 的硬性要求），lib/smb-users 会补建
           nologin、无家目录的系统账户；
         · 网页端口令是 scrypt 单向哈希，**推不出明文**，所以密码必须由
           本人在这里重新设一次（注册那一刻例外，请求里本来就有明文）。
       ================================================================= */
    if (pathname === '/api/smb/account' && (m === 'GET' || m === 'POST')) {
      if (!user) return sendJSON(res, 401, { error: '需要登录后才能开通文件共享' });
      const uname = String(user.username || '');
      if (m === 'GET') {
        let enabled = false;
        try { enabled = smbUsers.smbUserExists(uname); } catch { enabled = false; }
        return sendJSON(res, 200, {
          ok: true,
          enabled,
          username: uname,
          host: '\\\\' + this.smbHost(),
          shares: smbUsers.shareList().map((x) => x.name),
          minPassword: smbUsers.MIN_PASS,
          /* 用户名含中文/空格时 Samba 侧会变形，提前说清楚比让他反复试密码好 */
          nameOk: smbUsers.NAME_RE.test(uname),
        });
      }
      const body = await readBody(req, 16 * 1024);
      let parsed = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { parsed = {}; }
      const pw = String(parsed.password || '');
      if (pw.length < smbUsers.MIN_PASS) {
        return sendJSON(res, 400, { error: `SMB 密码至少 ${smbUsers.MIN_PASS} 位。` });
      }
      if (!smbUsers.NAME_RE.test(uname)) {
        return sendJSON(res, 400, {
          error: '当前用户名含 SMB 不支持的字符（只允许字母、数字、_ . - @），'
            + '无法直接作为共享账号；请联系管理员改用英文用户名。',
        });
      }
      const made = smbUsers.ensureSmbUser(uname, pw);
      if (!made.ok) {
        this.audit({ action: 'smb-enable', disk: '', path: '', ip: req.socket.remoteAddress,
          user: uname, ok: false, detail: made.error });
        return sendJSON(res, 500, { error: made.error });
      }
      const acl = smbUsers.addUserToShares(uname);
      if (!acl.ok) {
        return sendJSON(res, 500, { error: acl.error });
      }
      const rl = smbUsers.reloadSamba();
      this.audit({ action: 'smb-enable', disk: '', path: '', ip: req.socket.remoteAddress,
        user: uname, ok: true, detail: made.created ? '新建账号' : '更新密码' });
      return sendJSON(res, 200, {
        ok: true,
        created: !!made.created,
        username: uname,
        host: '\\\\' + this.smbHost(),
        shares: smbUsers.shareList().map((x) => x.name),
        reloaded: !!rl.ok,
      });
    }

    /* =================================================================
       v4：局域网工作站 API
       核心思路：一条 SSE 长连接（/api/events）承载全部实时性，
                 其余端点只做「注册 / 查询 / 投递」。
       ================================================================= */

    const peerIp = (req.socket && req.socket.remoteAddress) || '';

    /* --- 实时事件流：GET /api/events?channels=tasks,devices,board ---
       R1-1-3：要求登录。files.changed 等事件携带路径与操作者，
       任何游客都能开一条 SSE 全站监听是不可接受的（实测曾未登录 200）。 */
    if (pathname === '/api/events' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录后才能订阅事件流' });
      const chRaw = query.channels || query.ch || '';
      const channels = chRaw ? String(chRaw).split(/[,\s]+/).filter(Boolean) : null;
      this.hub.start();
      this.presence.start();
      if (query.device) this.presence.touch(String(query.device));
      this.hub.subscribe(req, res, { channels, user, deviceId: String(query.device || '') });
      return;   // 响应已被 SSE 长连接接管，不可再写
    }

    /* --- 工作站总览：一次拿全（中枢/设备/任务/协同板/负载/磁盘） ---
       R1-1-1：要求登录。此端点聚合了 SSE 客户端清单（内网 IP+用户名）、
       任务、协同板、远程执行统计、设备清单 —— 实测未登录 200，全量泄漏。 */
    if (pathname === '/api/station' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      let monitor = null;
      try { monitor = await this.monitor.sample(); } catch { /* 非 Termux 环境读不到 */ }
      /* 给 monitor 补能力位：面板要据此区分「系统不让读」和「值为 0」。
         Android 上 cpuPct/netRxBps 恒为 null（/proc/stat、/proc/net/dev 均 EACCES），
         不带上能力位前端只能显示 --% / 0.0，用户以为是坏的。 */
      if (monitor && typeof monitor === 'object') {
        try {
          const cap = this.monitor.snapshot('station');
          monitor.cpuSupported = cap.cpuSupported === true;
          monitor.netSupported = cap.netSupported === true;
          monitor.loadSupported = cap.loadSupported === true;
          monitor.platform = process.platform;
        } catch { /* 取不到就不带能力位，前端回落到旧表现 */ }
      }
      let disks = [];
      try { disks = this.listDisks(user); } catch { /* 忽略 */ }
      const dev = this.presence.list();
      // 给每台设备补上「可信 / 封禁」标记，前端据此显示徽章
      /* R9：这里是**纯展示**（设备是否在受信名单里），用 isPaired()。
         isTrusted() 新签名要求配对令牌，而这个接口拿不到令牌，
         若用 isTrusted 会让所有徽章全灰。 */
      const decorateTrust = (list) => (list || []).map((d) => ({
        ...d,
        trusted: this.pairing.isPaired(d.id),
        blocked: this.pairing.isBlocked(d.id),
      }));
      return sendJSON(res, 200, {
        ok: true,
        serverTime: Date.now(),
        version: 'v4.1-workstation',
        hub: this.hub.stats(),
        devices: { ...dev, online: decorateTrust(dev.online), offline: decorateTrust(dev.offline) },
        capabilities: this.presence.capabilities(),
        presenceStats: this.presence.stats(),
        tasks: { stats: this.tasks.stats(), items: this.tasks.list({ limit: 40 }) },
        board: { stats: this.board.stats(), items: this.board.list(40) },
        remote: { stats: this.remote.stats(), recent: this.remote.log({ limit: 12 }) },
        sync: this.sync.stats(),
        pairing: this.pairing.stats(),
        monitor,
        disks,
        events: this.hub.recent(30),
        user: user ? this.users.publicUser(user) : null,
        guest: !user,
        canWrite: !!user,
        isAdmin: !!(user && (user.role === 'admin' || user.isAdmin)),
      });
    }

    /* --- 设备注册 / 心跳 --- */
    if (pathname === '/api/devices/register' && m === 'POST') {
      const body = await readBody(req, 16 * 1024);
      const info = JSON.parse(body.toString('utf8') || '{}');

      // 封禁设备直接拒绝接入
      if (this.pairing.isBlocked(String(info.id || ''))) {
        return sendJSON(res, 403, { error: '该设备已被管理员封禁' });
      }

      const r = this.presence.register(info, { ip: peerIp, user: user ? user.username : '' });
      if (!r.ok) return sendJSON(res, 400, { error: r.error });

      // 信任判定：必须在受信名单里**且**持有该设备的配对令牌
      /* R9：原写法 isTrusted(info.id) 只比对名单里的 id —— 而设备 id 是客户端
         自报的字符串，不是什么秘密。谁知道一个受信设备的 id，谁就能自称是它。
         新签名 isTrusted(id, token) 会校验令牌；纯展示场景用 isPaired()。 */
      const trusted = this.pairing.isTrusted(info.id, info.token);
      this.hub.start();
      this.presence.start();
      this.remote.start();
      return sendJSON(res, 200, {
        ok: true,
        device: { ...r.device, trusted },
        isNew: r.isNew,
        ttlMs: 90000,
        trusted,
        requirePairing: this.pairing.requirePairing,
      });
    }
    if (pathname === '/api/devices' && m === 'GET') {
      /* R5-5-2：设备发现清单（id/名称/型号/平台/能力/最后在线）与 /api/station 同类 ——
         R1 修掉后者却漏了这里，游客仍可枚举全站设备 → 统一要求登录 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, {
        ...this.presence.list(),
        capabilities: this.presence.capabilities(),
        stats: this.presence.stats(),
      });
    }
    if (pathname === '/api/devices/rename' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { id, name } = JSON.parse(body.toString('utf8') || '{}');
      const r = this.presence.rename(id, name);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, { ok: true, device: r.device });
    }
    if (pathname === '/api/devices/remove' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      const r = this.presence.remove(id);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, { ok: true });
    }

    /* --- 实时任务中心 --- */
    if (pathname === '/api/tasks' && m === 'GET') {
      /* R5-5-2：任务清单含任务名/路径/状态 → 登录后可见 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, {
        stats: this.tasks.stats(),
        items: this.tasks.list({ limit: Number(query.limit) || 60, activeOnly: query.active === '1' }),
      });
    }
    if (pathname === '/api/tasks/create' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const o = JSON.parse(body.toString('utf8') || '{}');
      const t = this.tasks.create({ ...o, user: user.username, device: o.device || '' });
      return sendJSON(res, 200, { ok: true, task: t });
    }
    if (pathname === '/api/tasks/progress' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { id, ...p } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.tasks.progress(id, p);
      if (!t) return sendJSON(res, 404, { error: '任务不存在' });
      return sendJSON(res, 200, { ok: true, task: t });
    }
    if (pathname === '/api/tasks/finish' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { id, ok, error, result } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.tasks.finish(id, { ok: ok !== false, error: error || '', result });
      if (!t) return sendJSON(res, 404, { error: '任务不存在' });
      return sendJSON(res, 200, { ok: true, task: t });
    }
    if (pathname === '/api/tasks/cancel' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      /* R8-8-7（审计代理 R5 报告 #9）：取消任务限**属主或管理员** ——
         原先任何登录用户都能取消别人的任务。 */
      const t0 = this.tasks.get(String(id || ''));
      if (t0 && !this.isAdmin(user) && t0.user && user && t0.user !== user.username) {
        return sendJSON(res, 403, { error: '只能取消自己创建的任务' });
      }
      const r = this.tasks.cancel(id);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/tasks/clear' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      return sendJSON(res, 200, this.tasks.clearFinished());
    }
    if (pathname === '/api/tasks/remove' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      /* R8-8-7：删除任务记录同样限属主或管理员 */
      const t0 = this.tasks.get(String(id || ''));
      if (t0 && !this.isAdmin(user) && t0.user && user && t0.user !== user.username) {
        return sendJSON(res, 403, { error: '只能删除自己创建的任务' });
      }
      const r = this.tasks.remove(id);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }

    /* --- 跨设备协同板（共享剪贴板） --- */
    /* ===== 办公工作区：文档 / 表格 / 看板 ===== */
    if (pathname === '/api/docs/presence' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const body = await readBody(req, 4 * 1024);
      const { cid, id } = JSON.parse(body.toString('utf8') || '{}');
      let hit = null;
      this.docClients.forEach((c) => { if (c.user === user.username && c.cid === String(cid || '')) hit = c; });
      if (hit) { hit.docId = String(id || ''); hit.broadcastPresence(); }
      return sendJSON(res, 200, { ok: !!hit });
    }

    if (pathname === '/api/docs/share' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 16 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      return sendJSON(res, 200, this.docs.createShare(user.username, id));
    }
    if (pathname === '/api/docs/unshare' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 16 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      return sendJSON(res, 200, this.docs.revokeShare(user.username, id));
    }
    /* 文档变更 SSE 订阅 */
    if (pathname === '/api/docs/events' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const client = { user: user.username, res, cid: String(query.cid || ''), docId: null };
      this.docClients.add(client);
      client.broadcastPresence = () => {
        const docId = client.docId;
        if (!docId) return;
        const seen = new Set();
        this.docClients.forEach((c) => {
          if (c.user === client.user && c.docId === docId && c.cid) seen.add(c.cid);
        });
        this.docClients.forEach((c) => {
          if (c.user !== client.user) return;
          try { c.res.write('data: ' + JSON.stringify({ type: 'presence', id: docId, count: seen.size }) + '\n\n'); } catch (e) {}
        });
      };
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
      req.on('close', () => { clearInterval(ping); this.docClients.delete(client); });
      return;
    }

    if (pathname === '/api/docs' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, { items: this.docs.list(user.username, query) });
    }
    if (pathname === '/api/docs/item' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const it = this.docs.get(user.username, String(query.id || ''));
      if (!it) return sendJSON(res, 404, { error: '文档不存在' });
      return sendJSON(res, 200, { item: it });
    }
    if (pathname === '/api/docs/save' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 1024 * 1024);
      const o = JSON.parse(body.toString('utf8') || '{}');
      const r = this.docs.upsert(user.username, o);
      this.docClients.forEach((c) => {
        if (c.user !== user.username) return;
        try { c.res.write('data: ' + JSON.stringify({ id: r.item.id, updatedAt: r.item.updatedAt }) + '\n\n'); } catch (e) {}
      });
      this.audit({ userObj: user, action: 'docs-save', detail: (o.type || '') + ':' + String(o.title || '').slice(0, 60), ip: peerIp });
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/docs/remove' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 16 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      return sendJSON(res, 200, this.docs.remove(user.username, id));
    }

    if (pathname === '/api/board' && m === 'GET') {
      /* R5-5-2：协同板内容（用户留言/便签）→ 登录后可见 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, {
        stats: this.board.stats(),
        items: this.board.list(Number(query.limit) || 60),
      });
    }
    if (pathname === '/api/board/post' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 32 * 1024);
      const o = JSON.parse(body.toString('utf8') || '{}');
      const r = this.board.post({
        text: o.text,
        kind: o.kind,
        pinned: o.pinned,
        device: o.device || '',
        deviceName: o.deviceName || '',
        user: user.username,
      });
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      this.audit({ userObj: user, action: 'board-post', detail: (o.kind || '') + ':' + String(r.item.text).slice(0, 60), ip: peerIp });
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/board/remove' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      const r = this.board.remove(id, user.username);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/board/pin' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { id, pinned } = JSON.parse(body.toString('utf8') || '{}');
      const r = this.board.pin(id, pinned);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/board/clear' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      return sendJSON(res, 200, this.board.clear(user.username));
    }

    /* =================================================================
       v4.1 能力层：远程控制 / 数据同步 / 设备信任 / 限时分享 / 长任务 / 自检
       设计：lib/*.js 保持纯逻辑，本段只做「鉴权 + 参数整形 + 转发」
       ================================================================= */

    /* ------------------------------ 远程控制 ------------------------------ */

    // 动作清单（前端据此渲染可下发的指令）
    if (pathname === '/api/remote/actions' && m === 'GET') {
      /* R4-4E：动作清单会暴露 exec 白名单与开关状态 → 要求登录 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const st = this.remote.stats();
      return sendJSON(res, 200, {
        ok: true,
        actions: st.actions,
        execEnabled: st.execEnabled,
        execAllow: this.remote.execAllow,
      });
    }

    // 可作为目标的下发设备（在线、非自己、按能力算出各自支持哪些动作）
    if (pathname === '/api/remote/targets' && m === 'GET') {
      /* R4-4C：设备清单（id/名称/型号/平台/能力/最后在线/信任状态）此前游客可读 ——
         与 R1 修掉的 /api/station 同一类信息泄漏 → 要求登录 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const selfId = String(query.device || '');
      const online = this.presence.list({ includeOffline: false }).online || [];
      const actions = this.remote.stats().actions;
      const targets = online.filter((d) => d.id !== selfId).map((d) => {
        const caps = d.capabilities || [];
        const supported = actions
          .filter((a) => !a.cap || caps.includes(a.cap))
          .filter((a) => a.action !== 'exec' || this.remote.execEnabled)
          .map((a) => a.action);
        return {
          id: d.id, name: d.name, type: d.type, platform: d.platform,
          capabilities: caps, supported,
          trusted: this.pairing.isPaired(d.id),
          blocked: this.pairing.isBlocked(d.id),
          lastSeen: d.lastSeen, ageS: d.ageS,
        };
      });
      return sendJSON(res, 200, { ok: true, targets, execEnabled: this.remote.execEnabled });
    }

    // 下发指令
    if (pathname === '/api/remote/send' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 16 * 1024);
      const o = JSON.parse(body.toString('utf8') || '{}');
      /* R4-4A：exec 属高危动作 —— 普通登录用户不得下发（原先只要登录即可，
         等于任一低权限账号都能让别人的设备执行命令）。其余动作维持登录可用。 */
      if (String(o.action || '') === 'exec' && !this.isAdmin(user)) {
        return sendJSON(res, 403, { error: '远程执行命令需要管理员权限' });
      }
      const r = this.remote.send(
        { target: o.target, action: o.action, args: o.args },
        {
          deviceId: o.from || String(query.device || ''),
          deviceName: o.fromName || '',
          user: user.username,
        }
      );
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, { ok: true, cmd: r.cmd });
    }

    // 目标设备拉取待执行指令（SSE 掉线时的轮询兜底）
    if (pathname === '/api/remote/inbox' && m === 'GET') {
      const dev = String(query.device || '');
      if (!dev) return sendJSON(res, 400, { error: '缺少 device 参数' });
      /* R8-8-6（审计代理 R5 报告 #3）：原先只校验「该设备号是否在受信表里」，
         设备号可被任意人自报 —— 知道别人设备号即可读它的待执行指令（含 exec 命令与参数）。
         修法：未登录者必须出示该设备自己的 token（matchToken 常量时间比对）；
         登录用户（本机 UI）继续可用。 */
      if (!user && !this.pairing.matchToken(dev, String(query.token || req.headers['x-device-token'] || ''))) {
        return sendJSON(res, 401, { error: '设备未配对或令牌无效' });
      }
      this.presence.touch(dev);
      return sendJSON(res, 200, this.remote.inbox(dev, { limit: Number(query.limit) || 20 }));
    }

    // 目标确认收到并开始执行
    if (pathname === '/api/remote/ack' && m === 'POST') {
      const body = await readBody(req, 8 * 1024);
      const { id, device, token } = JSON.parse(body.toString('utf8') || '{}');
      /* R8-8-6：同 inbox —— 未登录者须出示设备 token（原先只认"设备号在受信表里"） */
      if (!user && !this.pairing.matchToken(String(device || ''), String(token || req.headers['x-device-token'] || ''))) {
        return sendJSON(res, 401, { error: '设备未配对或令牌无效' });
      }
      const r = this.remote.ack(id, String(device || ''));
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }

    // 目标回报执行结果
    if (pathname === '/api/remote/result' && m === 'POST') {
      const body = await readBody(req, 32 * 1024);
      const { id, device, ok, error, data, token } = JSON.parse(body.toString('utf8') || '{}');
      /* R8-8-6：伪造 result 可污染指令状态与审计 → 同样要求设备令牌 */
      if (!user && !this.pairing.matchToken(String(device || ''), String(token || req.headers['x-device-token'] || ''))) {
        return sendJSON(res, 401, { error: '设备未配对或令牌无效' });
      }
      const r = this.remote.result(id, { ok, error, data }, String(device || ''));
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }

    // 取消在途指令
    if (pathname === '/api/remote/cancel' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      const r = this.remote.cancel(id);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }

    // 指令历史 / 在途
    if (pathname === '/api/remote/log' && m === 'GET') {
      /* R4-4D：历史含 clipboard_set 文本、exec 命令与结果 → 游客可读属泄漏，要求登录。
         （不设 admin-only：站点控制台是家庭 NAS 的常规功能，主账号可能非 admin） */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, {
        ok: true,
        stats: this.remote.stats(),
        inflight: this.remote.list({ limit: Number(query.limit) || 50, target: query.target || '' }),
        history: this.remote.log({ limit: Number(query.limit) || 50, target: query.target || '' }),
      });
    }

    /* ------------------------------ 数据同步 ------------------------------ */

    // 生成清单
    if (pathname === '/api/sync/manifest' && m === 'GET') {
      /* R5-5-2：整盘遍历清单（批量枚举，且外部盘也在内）→ 登录后可见；
         访客要读公共盘目录本就有 /api/list 的既定通道 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const t = this.resolveTarget({ disk: query.disk, scope: query.scope, path: query.path || '' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const r = await this.sync.manifestAsync(t.abs, { depth: Number(query.depth) || 4 });
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, {
        ok: true, disk: t.disk, path: query.path || '',
        fingerprint: r.fingerprint, count: r.count, files: r.files,
        totalBytes: r.totalBytes, truncated: r.truncated,
        entries: r.entries,
      });
    }

    // 带基线比对：客户端只拉差异
    if (pathname === '/api/sync/check' && m === 'POST') {
      /* R8-8-8（审计代理 R5 报告 #5）：差分比对可提交任意 base 清单 → 泄漏磁盘侧指纹与
         文件元数据，且吃 8MB 请求体。与 manifest/state 同口径：要求登录。 */
      if (!user) { await drainRequest(req); return sendJSON(res, 401, { error: '需要登录' }); }
      const body = await readBody(req, 8 * 1024 * 1024);
      const o = JSON.parse(body.toString('utf8') || '{}');
      const t = this.resolveTarget({ disk: o.disk, scope: o.scope, path: o.path || '' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const r = await this.sync.compareAsync(t.abs, o.base, {
        depth: Number(o.depth) || 4,
        baseFingerprint: o.baseFingerprint || '',
      });
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, { ok: true, disk: t.disk, path: o.path || '', ...r });
    }

    // 记录本设备同步游标
    if (pathname === '/api/sync/mark' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const o = JSON.parse(body.toString('utf8') || '{}');
      const r = this.sync.saveState(o.device || String(query.device || ''), o);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/sync/state' && m === 'GET') {
      /* R5-5-2：跨设备同步游标（含 deviceId 与会话游标）→ 登录后可见 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, { ok: true, state: this.sync.getState(String(query.device || '')) });
    }
    if (pathname === '/api/sync/list' && m === 'GET') {
      return sendJSON(res, 200, { ok: true, stats: this.sync.stats(), items: this.sync.list() });
    }
    if (pathname === '/api/sync/forget' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { device } = JSON.parse(body.toString('utf8') || '{}');
      return sendJSON(res, 200, this.sync.forget(device));
    }

    /* ------------------------------ 内置 AI 助手（v4.2） ------------------------------ */

    // 配置视图（含候选后端、当前生效项、生成参数）
    if (pathname === '/api/ai/config' && m === 'GET') {
      /* 附带 isAdmin：右栏的「添加后端 / 生成参数 / 能力开关」都是管理操作，
         前端不必再等 /api/station 才知道自己能不能改。
         否则登录后配置区要等下一次整站刷新才出现（实测就是这样）。
         R4-5-2：游客可用 AI 是设计（t-enhance 即以访客实测对话），但**后端内网地址**
         与 **system prompt** 无需暴露给匿名者 → 游客视图脱敏这两个字段。 */
      const v = this.ai.view();
      if (!user) {
        /* R9：游客视图再脱一层 —— **模型文件路径**也要抹掉。
           原来只清了 system（提示词）与后端内网地址，但 backends[].model /
           activeModel 仍是服务器绝对路径（如 /opt/station/models/xxx.gguf），
           等于把磁盘布局与模型文件名一起送给了匿名者。
           保留 name（"服务器本机 llama.cpp"）够面板显示，路径不给。 */
        return sendJSON(res, 200, {
          ok: true, isAdmin: false,
          ...v,
          backends: (v.backends || []).map((b) => ({ id: b.id, name: b.name, model: '', active: b.active })),
          activeModel: '',
          system: '',
          // 游客本来就写不了、也出不了网，能力开关一律显示为关，免得误导
          allowWrite: false,
          allowWeb: false,
        });
      }
      return sendJSON(res, 200, { ok: true, isAdmin: this.isAdmin(user), ...v });
    }

    // 新增 / 更新后端
    if (pathname === '/api/ai/backend' && m === 'POST') {
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '仅管理员可修改 AI 后端' });
      const body = await readBody(req, 16 * 1024);
      let o = {};
      try { o = JSON.parse(body.toString('utf8') || '{}'); } catch { /* 忽略 */ }
      try {
        const rec = this.ai.upsertBackend(o);
        this.audit({ userObj: user, action: 'ai-backend', detail: '保存 AI 后端 ' + rec.url, ip: peerIp });
        return sendJSON(res, 200, { ok: true, backend: rec, isAdmin: this.isAdmin(user), ...this.ai.view() });
      } catch (e) {
        return sendJSON(res, 400, { error: String(e.message || e) });
      }
    }

    // 删除后端
    if (pathname === '/api/ai/backend/remove' && m === 'POST') {
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '仅管理员可删除 AI 后端' });
      const body = await readBody(req, 8 * 1024);
      let o = {};
      try { o = JSON.parse(body.toString('utf8') || '{}'); } catch { /* 忽略 */ }
      try {
        this.ai.removeBackend(String(o.id || ''));
        return sendJSON(res, 200, { ok: true, isAdmin: this.isAdmin(user), ...this.ai.view() });
      } catch (e) {
        return sendJSON(res, 400, { error: String(e.message || e) });
      }
    }

    /* 读取当前生效的 AI 后端（只读）。
       为什么要有 GET：新面板（React 单文件版）的 aiBackend() 用 GET /api/ai/active
       读"当前后端是哪个"，而这里原本只有 POST（切换）。契约对不上 → 面板 404，
       AI 页拿不到后端名/地址。补一个 GET 让它与 POST 共用同一个 view()，
       返回形状完全一致（ok / isAdmin / active / backends / ctx…），前端无需特判。 */
    if (pathname === '/api/ai/active' && m === 'GET') {
      const v = this.ai.view();
      /* active：把"当前生效后端"额外**多给一份对象**。
         为什么需要它：view() 原本给的是 backends[] + activeId + activeModel/activeName，
         而新面板（React 版）AI 页读的是 `backend.active.model`（见 AI.tsx 推理连接弹窗）
         → 取不到 active 就退到文案「尚未配置」，实际模型好端端的。
         这不是替换旧字段，是**并行多给一个形状**：老前端继续用 activeId/activeModel 不受影响。
         ⚠️ 游客不在此分支补齐（走下面脱敏分支），避免经此泄露内网 url。 */
      const activeObj = (() => {
        const a = (v.backends || []).find((b) => b.id === v.activeId);
        return a ? { id: a.id, name: a.name, url: a.url, model: a.model, note: a.note || '' } : null;
      })();
      if (!user) {
        /* 与 /api/ai/config 同口径：游客不给内网地址、也不给模型文件路径。 */
        return sendJSON(res, 200, {
          ok: true, isAdmin: false,
          active: v.active ? { name: v.active.name, model: '' } : null,
          backends: (v.backends || []).map((b) => ({ id: b.id, name: b.name, model: '', active: b.active })),
          ctx: v.ctx,
        });
      }
      return sendJSON(res, 200, { ok: true, isAdmin: this.isAdmin(user), active: activeObj, ...v });
    }

    // 切换生效后端
    if (pathname === '/api/ai/active' && m === 'POST') {
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '仅管理员可切换 AI 后端' });
      const body = await readBody(req, 8 * 1024);
      let o = {};
      try { o = JSON.parse(body.toString('utf8') || '{}'); } catch { /* 忽略 */ }
      try {
        this.ai.setActive(String(o.id || ''));
        return sendJSON(res, 200, { ok: true, isAdmin: this.isAdmin(user), ...this.ai.view() });
      } catch (e) {
        return sendJSON(res, 400, { error: String(e.message || e) });
      }
    }

    // 生成参数
    if (pathname === '/api/ai/params' && m === 'POST') {
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '仅管理员可修改生成参数' });
      const body = await readBody(req, 16 * 1024);
      let o = {};
      try { o = JSON.parse(body.toString('utf8') || '{}'); } catch { /* 忽略 */ }
      this.ai.setParams(o);
      /* R4-5-4：这里能开关 allowWrite / allowWeb（等于放行 AI 写盘与联网），
         属权限面变更 —— 补审计留痕（原先无任何记录） */
      try {
        const touched = ['allowWrite', 'allowWeb', 'allowTools'].filter((k) => o[k] != null).map((k) => k + '=' + !!o[k]);
        if (touched.length) this.audit({ userObj: user, action: 'ai-params', detail: touched.join(' '), ip: peerIp });
      } catch { /* 审计失败不影响主流程 */ }
      return sendJSON(res, 200, { ok: true, isAdmin: this.isAdmin(user), ...this.ai.view() });
    }

    /* R11：提示词称重。CPU 预填充只有 ~18 tok/s，多 500 token 就是多等 28 秒，
       所以每一段都要有真实数字，而不是靠读代码估。只回数字和开头 60 字。 */
    if (pathname === '/api/ai/diag' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const tok = async (text) => {
        try {
          const r = await fetch('http://127.0.0.1:8080/tokenize', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: String(text || '') }),
          });
          const j = await r.json();
          return Array.isArray(j.tokens) ? j.tokens.length : 0;
        } catch { return -1; }
      };
      const cwd = String(query.cwd || '');
      const msgs = this.ai._sys({ cwd });
      const parts = [];
      let sysTotal = 0;
      for (const msg of msgs) {
        const text = String(msg.content || '');
        const n = await tok(text);
        if (n > 0) sysTotal += n;
        parts.push({ role: msg.role, tokens: n, chars: text.length, head: text.slice(0, 60) });
      }
      /* 工具声明：开启时 append 在第一条 system 之后，同样属于前缀，改一个字节就全部重算 */
      let toolSpecTokens = 0;
      let toolNames = [];
      try {
        const specs = this.ai.tools.specs({ allowWeb: true, allowWrite: true });
        toolSpecTokens = await tok(JSON.stringify(specs));
        toolNames = specs.map((t) => (t && t.function && t.function.name) || '?');
      } catch { /* 工具未装配时忽略 */ }
      return sendJSON(res, 200, {
        ok: true, cwd, parts, sysTotal, toolSpecTokens, toolNames,
        cfg: { system: this.ai.cfg.system, location: this.ai.cfg.location, temperature: this.ai.cfg.temperature, maxTokens: this.ai.cfg.maxTokens, contextTokens: this.ai.cfg.contextTokens },
      });
    }

    // 健康探测：切目标前先确认对方活着
    if (pathname === '/api/ai/probe' && m === 'GET') {
      /* R4-4F：探测会触发服务端对外请求（后端是管理员配置的，故非 SSRF），
         但属运营动作 —— 游客无需使用，要求登录 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const id = query.id;
      const b = id ? this.ai.cfg.backends.find((x) => x.id === id) : null;
      const r = await this.ai.probe(b || undefined);
      return sendJSON(res, r.ok ? 200 : 502, r);
    }

    // 对话（支持 stream=1 走 SSE；v4.3 起模型可调用工具读写文件）
    if (pathname === '/api/ai/chat' && m === 'POST') {
      /* R9：原来完全无登录检查 —— 任何人（哪怕同网段访客设备）都能驱动本机
         反复调用推理后端：既是算力/带宽的免费通道，也会把服务端配置、
         系统提示词、模型名一并暴露。AI 是登录后才有的能力，这里补上。 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const body = await readBody(req, 512 * 1024);
      let o = {};
      try { o = JSON.parse(body.toString('utf8') || '{}'); } catch {
        return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
      }
      const wantStream = !!o.stream;
      /* 工具执行上下文：带上登录用户，ACL 与路径越界守卫照常生效 */
      const ctx = { user, cwd: String(o.cwd || ''), peerIp };
      /* 对话级选项：模型后端、单次权限、场景模式、计划模式（由 ai.js 服务端强制）
         R9：allowWeb/allowWrite 必须**严格布尔**。
         原来写 !!o.allowWrite：body 里传字符串 "false" 会被当成 true
         （!!"false" === true）—— 请求反而把权限**打开**了。 */
      /* R11：请求级生成参数（温度/最大长度）。与 allowWeb/allowWrite 同一口径 ——
         只认数字，字符串不认；越界由 ai.js 的 _normGen 丢弃。 */
      const genOverride = {};
      if (o.temperature !== undefined && o.temperature !== null) genOverride.temperature = o.temperature;
      if (o.maxTokens !== undefined && o.maxTokens !== null) genOverride.maxTokens = o.maxTokens;
      /* 与 ai.js 内部同一套归一逻辑：界面显示的就是真正发给模型的数值 */
      const genNorm = this.ai._normGen(genOverride);
      const effGenSettings = {
        temperature: genNorm.temperature != null ? genNorm.temperature : this.ai.cfg.temperature,
        maxTokens: genNorm.maxTokens != null ? genNorm.maxTokens : this.ai.cfg.maxTokens,
        contextTokens: this.ai.cfg.contextTokens,
      };
      const chatOpts = {
        gen: genNorm,
        backendId: o.backendId === undefined ? undefined : String(o.backendId),
        allowWeb: o.allowWeb === undefined ? undefined : o.allowWeb === true,
        allowWrite: o.allowWrite === undefined ? undefined : o.allowWrite === true,
        mode: o.mode === undefined ? undefined : String(o.mode),
        plan: o.plan === undefined ? undefined : o.plan === true,
        planText: o.planText === undefined ? undefined : String(o.planText),
      };
      /* 纵深防御：匿名永远没有写权限（ai.js 的 _policy 已保证，这里是第二道）。 */
      if (!user) chatOpts.allowWrite = false;

      if (!wantStream) {
        try {
          const r = await this.ai.chat({ messages: o.messages, stream: false, ctx, cwd: o.cwd, ...chatOpts });
          /* R11：把本次真正生效的生成参数回给界面，前端据此显示「实际使用」，
             而不是显示界面上那个可能有越界/被丢弃的值。 */
          return sendJSON(res, 200, { ok: true, ...r, settings: effGenSettings });
        } catch (e) {
          return sendJSON(res, 502, { error: String(e.message || e) });
        }
      }

      /* SSE：逐字推给浏览器 */
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const sse = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      try {
        const r = await this.ai.chat({
          messages: o.messages,
          stream: true,
          ctx,
          cwd: o.cwd,
          ...chatOpts,
          onDelta: (d) => sse({ delta: d }),
          onTool: (t) => sse({ tool: t }),
        });
        sse({
          done: true,
          text: r.text,
          backend: r.backend,
          backendName: r.backendName,
          model: r.model,
          usage: r.usage,
          toolLog: r.toolLog,
          notes: r.notes,
          settings: effGenSettings,
        });
      } catch (e) {
        sse({ error: String(e.message || e) });
      }
      return res.end();
    }

    /* ------------------------------ 设备配对与信任 ------------------------------ */

    // 生成配对码（管理员）
    if (pathname === '/api/devices/pair/new' && m === 'POST') {
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '仅管理员可生成配对码' });
      const body = await readBody(req, 8 * 1024);
      let o = {};
      try { o = JSON.parse(body.toString('utf8') || '{}'); } catch { /* 允许空体 */ }
      const r = this.pairing.newCode({ ttlMs: o.ttlMs, by: user.username, label: o.label });
      this.audit({ userObj: user, action: 'pair-newcode', detail: '生成配对码', ip: peerIp });
      return sendJSON(res, 200, r);
    }

    // 设备用配对码换取信任令牌（无需登录——这正是配对码存在的意义）
    if (pathname === '/api/devices/pair/claim' && m === 'POST') {
      /* R8-8-2（审计代理 R7 报告 P1）：配对码是 6 位数字（~20bit），原先 claim 无任何
         尝试限制 —— 局域网内可在 10 分钟有效期内暴力穷举领取设备信任。
         修法：按来源 IP 限速（独立计数键，不污染登录限速桶）。 */
      const ipKey = 'pair:' + peerIp;
      const rl = this.loginRateCheck(ipKey);
      if (rl) { await drainRequest(req); return sendJSON(res, rl.code, { error: '配对尝试次数过多，请稍后再试' }); }
      const body = await readBody(req, 16 * 1024);
      const o = JSON.parse(body.toString('utf8') || '{}');
      const r = this.pairing.claim(o.code, {
        id: o.id, name: o.name, type: o.type, platform: o.platform,
      }, { ip: peerIp, user: user ? user.username : '' });
      if (!r.ok) {
        this.loginRateFail(ipKey);
        return sendJSON(res, 400, { error: r.error });
      }
      this.audit({ userObj: user, action: 'pair-claim', detail: (o.name || o.id) + ' 配对成功', ip: peerIp });
      return sendJSON(res, 200, { ok: true, token: r.token, device: { id: r.device.id, name: r.device.name, level: r.device.level } });
    }

    // 信任表
    if (pathname === '/api/devices/trust' && m === 'GET') {
      /* R8-P0-1（审计代理 R7 报告）：原先无任何鉴权，而 pairing.list() 返回
         · codes：**有效配对码明文**（拿到即可 claim 领取设备信任）
         · trusted：每台受信设备的 **token 明文**（拿到即可冒充受信设备）
         实测游客 GET 返回 200。修法：本端点仅管理员可用（与 POST 对齐）。 */
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '仅管理员可查看设备信任状态' });
      return sendJSON(res, 200, { ok: true, ...this.pairing.list() });
    }
    if (pathname === '/api/devices/trust' && m === 'POST') {
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '仅管理员可管理设备信任' });
      const body = await readBody(req, 8 * 1024);
      const { id, op, name, reason } = JSON.parse(body.toString('utf8') || '{}');
      if (!id) return sendJSON(res, 400, { error: '缺少设备号' });
      if (op === 'untrust') return sendJSON(res, 200, this.pairing.untrust(id));
      if (op === 'block') return sendJSON(res, 200, this.pairing.block(id, reason || ''));
      if (op === 'unblock') return sendJSON(res, 200, this.pairing.unblock(id));
      const r = this.pairing.trust(id, { name, by: user.username });
      this.audit({ userObj: user, action: 'device-trust', detail: id + ' → ' + (op || 'trust'), ip: peerIp });
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/devices/policy' && m === 'POST') {
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '仅管理员可修改配对策略' });
      const body = await readBody(req, 8 * 1024);
      const { requirePairing } = JSON.parse(body.toString('utf8') || '{}');
      const r = this.pairing.setRequire(requirePairing);
      this.audit({ userObj: user, action: 'pair-policy', detail: 'requirePairing=' + r.requirePairing, ip: peerIp });
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/devices/codes' && m === 'GET') {
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '仅管理员可查看配对码' });
      return sendJSON(res, 200, { ok: true, codes: this.pairing.listCodes(), ttlMs: 600000 });
    }

    /* ------------------------------ 限时分享 ------------------------------ */

    if (pathname === '/api/share/create' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 16 * 1024);
      const o = JSON.parse(body.toString('utf8') || '{}');
      // 创建时校验权限（之后凭 token 取件，权限在生成瞬间固化）
      /* 分享 = 把读取权限授予一个免登录的 token，所以创建方必须对目标有**写**权限：
         否则一个只读用户可以给任意文件发免登录链接 —— 那等于绕过 ACL 造后门。 */
      const t = this.resolveTarget({ disk: o.disk, scope: o.scope, path: o.path || '', _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      let st;
      try { st = fs.statSync(t.abs); } catch { return sendJSON(res, 404, { error: '文件不存在' }); }
      const r = this.share.create({
        disk: t.disk, path: o.path || '', name: path.basename(t.abs),
        abs: t.abs, size: st.size, isDir: st.isDirectory(),
        /* R9：maxUses 必须落在 [1, 50]。lib/share.js 的默认已是 1，
           这里再 clamp 一次：显式传 0（= 不限次）不能变成一个
           「可无限取件的免登录凭据」，前端传 999 也不能无限。 */
        ttlMs: o.ttlMs, maxUses: Math.max(1, Math.min(50, Number(o.maxUses) || 1)), label: o.label,
      }, { user: user.username, deviceId: o.device || '', deviceName: o.deviceName || '' });
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      this.audit({ userObj: user, action: 'share-create', detail: (t.disk + ':' + (o.path || '')) + ' ttl=' + Math.round(r.link.ttlMs / 1000) + 's', ip: peerIp });
      this.notifyFilesChanged('share', { disk: t.disk, path: o.path || '', user: user.username });
      return sendJSON(res, 200, { ok: true, link: r.link, url: r.url });
    }
    if (pathname === '/api/share/list' && m === 'GET') {
      /* R5-5-1（P0）：原先无鉴权 —— 游客可直接列出全部有效链接，返回体里含 token（即取件凭据）、
         绝对路径 abs 与创建者用户名；实测游客拿到 token 后 /s/<token> 即可下载内容，
         彻底击穿「限时分享仅持链者可访问」的模型。
         修法：要求登录；非管理员只列自己的分享；一律剔除 abs 等内部字段。 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const mine = this.isAdmin(user) ? undefined : user.username;
      const raw = this.share.list({ limit: Number(query.limit) || 100, includeExpired: query.all === '1', mine });
      const items = raw.map((l) => {
        const { abs, ...rest } = l;   // 不对外暴露服务器绝对路径
        return rest;
      });
      return sendJSON(res, 200, {
        ok: true,
        stats: this.share.stats(),
        items,
      });
    }
    if (pathname === '/api/share/revoke' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { token, remove } = JSON.parse(body.toString('utf8') || '{}');
      const r = remove ? this.share.remove(token) : this.share.revoke(token);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }

    /* ------------------------------ 长任务入队执行 ------------------------------ */
    /**
     * 把已有的长耗时服务端能力接入任务中心：
     *   scrub-build  校验清单构建（可能跑几分钟）
     *   scrub-verify 校验比对
     *   index-build  全文索引
     *   dedup-scan   重复文件扫描
     * 统一：先建任务 → 执行 → 进度/结果写回 → 广播。
     */
    if (pathname === '/api/tasks/run' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const o = JSON.parse(body.toString('utf8') || '{}');
      const op = String(o.op || '');
      const OPS = {
        'scrub-build': '构建校验清单',
        'scrub-verify': '校验文件完整性',
        'index-build': '重建全文索引',
        'dedup-scan': '扫描重复文件',
        'zip-build': '打包为 ZIP',
        'hash-scan': '生成 SHA256 清单',
      };
      if (!OPS[op]) return sendJSON(res, 400, { error: '不支持的作业类型：' + op + '（可用：' + Object.keys(OPS).join(' / ') + '）' });

      const disk = o.disk || 'public';
      const t = this.resolveTarget({ disk, scope: o.scope, path: '' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });

      const task = this.tasks.create({
        name: OPS[op] + '（' + t.disk + '）',
        type: op.split('-')[0],
        disk: t.disk,
        path: '',
        unit: 'percent',
        total: 100,
        device: o.device || String(query.device || ''),
        user: user.username,
        meta: { op, disk: t.disk },
      });
      this.tasks.start(task.id);

      // 异步执行，立即返回任务 id（前端靠 SSE 看进度）
      (async () => {
        const t0 = Date.now();
        /* R9：所有作业分支共用的取消检查点（之前 isCancelled() 从没被调用过） */
        if (!this.tasks.guard(task.id)) return;
        try {
          this.tasks.progress(task.id, { progress: 5, detail: '开始执行' });
          let result;
          if (op === 'scrub-build') {
            result = await scrubStore.buildManifest(this, t.disk, user);
          } else if (op === 'scrub-verify') {
            result = await scrubStore.verifyManifest(this, t.disk, user);
          } else if (op === 'index-build') {
            const roots = [{ dir: this.resolvePublicRoot().root, name: '公共盘' }];
            for (const e of this.scanExternal()) roots.push({ dir: e.root, name: e.label.slice(0, 4) });
            this.tasks.progress(task.id, { progress: 20, detail: '扫描目录' });
            result = await this.indexBuild(roots);
          } else if (op === 'zip-build') {
            /* 打包到服务端磁盘（不是下载流），产物落在 data/exports/ 下，可直接生成分享链接 */
            const rel = String(o.path || '').replace(/^\/+/, '') || '.';
            const targets = Array.isArray(o.paths) && o.paths.length ? o.paths.map(String) : [rel];
            const entries = collectZipEntries(this.storage, t.root, targets);
            if (!entries.length) throw new Error('没有可打包的文件');
            if (entries.length > 2000) throw new Error('打包内容超过 2000 个文件');
            const year = new Date().getFullYear();
            /* 产物必须放在「盘根」之内，否则 /api/download 与 /s/<token> 都够不到它，
               也就没法直接分享给别的设备。故落在 <盘根>/_exports/<年>/ 下。 */
            const exportsDir = path.join(t.root, '_exports', String(year));
            fs.mkdirSync(exportsDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const zipName = (o.name ? String(o.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) : 'export') + '-' + stamp + '.zip';
            const zipAbs = path.join(exportsDir, zipName);
            const zipRel = path.relative(t.root, zipAbs).split(path.sep).join('/');
            this.tasks.progress(task.id, { progress: 15, detail: '收集 ' + entries.length + ' 个文件' });
            const ws = fs.createWriteStream(zipAbs);
            let cancelled = false;
            const zipInfo = await writeZipToStream(ws, entries, (done, total) => {
              /* R9：任务取消检查点 —— 之前 isCancelled() 从没被调用过，
                 「取消」只改界面、实际打包照跑到底（等于假取消）。 */
              if (!this.tasks.guard(task.id)) {
                cancelled = true;
                try { ws.destroy(); } catch (e) {}
                return;
              }
              const p = 15 + Math.round((done / total) * 80);
              this.tasks.progress(task.id, {
                progress: Math.min(95, p),
                detail: '打包 ' + done + '/' + total,
              });
            });
            if (cancelled) {
              try { ws.destroy(); } catch (e) {}
              try { fs.unlinkSync(zipAbs); } catch (e) {}
              return;   // 终态已由 tasks.finish(cancelled) 记录
            }
            await new Promise((resolve, reject) => {
              ws.on('finish', resolve);
              ws.on('error', reject);
              ws.end();
            });
            const totalBytes = entries.reduce((a, e) => a + e.size, 0);
            result = {
              ok: true,
              file: zipName,
              bytes: zipInfo.bytes,
              files: zipInfo.count,
              rawBytes: totalBytes,
              // 样本太小时头部开销会压过收益，比值没有参考意义，故低于 4KB 不报
              ratio: totalBytes >= 4096 ? Number((zipInfo.bytes / totalBytes).toFixed(3)) : null,
              disk: t.disk,
              path: zipRel,
            };
          } else if (op === 'hash-scan') {
            /* 目录级 sha256 清单：可与另一台设备的清单直接比对，判断内容是否一致 */
            const rel = String(o.path || '').replace(/^\/+/, '');
            const root = rel ? this.storage.safeResolve(t.root, rel) : t.root;
            if (!root) throw new Error('路径不合法');
            let st;
            try { st = fs.statSync(root); } catch { throw new Error('路径不存在'); }
            const scanRoot = st.isDirectory() ? root : path.dirname(root);
            this.tasks.progress(task.id, { progress: 6, detail: '统计文件数' });
            const scan = await hashScanDir(scanRoot, {
              limit: Number(o.limit) || 20000,
              onProgress: (done, total, rel2) => {
                const p = 6 + Math.round((done / Math.max(1, total)) * 88);
                this.tasks.progress(task.id, {
                  progress: Math.min(94, p),
                  detail: 'SHA256 ' + done + '/' + total + ' · ' + String(rel2).slice(-32),
                });
              },
            });
            const year = new Date().getFullYear();
            const manifestsDir = path.join(t.root, '_manifests', String(year));
            fs.mkdirSync(manifestsDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const mfName = 'sha256-' + (t.disk || 'public') + '-' + stamp + '.json';
            const mfAbs = path.join(manifestsDir, mfName);
            const mfRel = path.relative(t.root, mfAbs).split(path.sep).join('/');
            fs.writeFileSync(mfAbs, JSON.stringify({
              disk: t.disk,
              root: rel || '.',
              createdAt: new Date().toISOString(),
              count: scan.count,
              totalBytes: scan.totalBytes,
              truncated: scan.truncated,
              fingerprint: scan.fingerprint,
              items: scan.items,
            }, null, 2));
            result = {
              ok: true,
              file: mfName,
              count: scan.count,
              totalBytes: scan.totalBytes,
              truncated: scan.truncated,
              fingerprint: scan.fingerprint,
              errors: scan.items.filter((x) => x.error).length,
              disk: t.disk,
              path: mfRel,
            };
          } else {
            this.tasks.progress(task.id, { progress: 20, detail: '分组比对' });
            const groups = this.dedupScan(t.root);
            result = {
              ok: true,
              groups: groups.length,
              waste: groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0),
              top: groups.slice(0, 50),
            };
          }
          const ok = !(result && result.ok === false);
          this.tasks.finish(task.id, {
            ok,
            error: ok ? '' : (result && result.error) || '执行失败',
            result: { ...(result || {}), seconds: ((Date.now() - t0) / 1000).toFixed(2) },
          });
        } catch (e) {
          this.tasks.finish(task.id, { ok: false, error: (e && e.message) || String(e) });
        }
      })();

      return sendJSON(res, 202, { ok: true, task });
    }

    // 任务详情（含 meta.result）
    if (pathname === '/api/tasks/detail' && m === 'GET') {
      /* R5-5-2：任务详情含路径与执行输出 → 登录后可见 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const t = this.tasks.get(String(query.id || ''));
      if (!t) return sendJSON(res, 404, { error: '任务不存在' });
      return sendJSON(res, 200, { ok: true, task: t });
    }

    /* ------------------------------ 站内通知（接入事件总线） ------------------------------ */

    if (pathname === '/api/notify/broadcast' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 8 * 1024);
      const { text, level, device } = JSON.parse(body.toString('utf8') || '{}');
      if (!text || !String(text).trim()) return sendJSON(res, 400, { error: '内容不能为空' });
      const payload = {
        text: String(text).slice(0, 400),
        level: ['info', 'warn', 'error', 'ok'].includes(level) ? level : 'info',
        from: user.username,
        device: device || '',
        at: Date.now(),
      };
      this.hub.publish('system', 'notify.message', payload);   // 在线设备实时收到
      return sendJSON(res, 200, { ok: true, delivered: this.hub.stats().clients, payload });
    }

    /* ------------------------------ 工作站自检 ------------------------------ */

    if (pathname === '/api/station/selfcheck' && m === 'GET') {
      /* R5-5-2（并更正 R2 注释）：自检报告含 Node 版本/平台/运行时长/盘根绝对路径/
         各服务端口与配置状态，游客可读属侦察面 → 要求登录 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail == null ? '' : detail) });

      add('事件中枢', this.hub.clients.size >= 0 && !!this.hub.seq >= 0, 'seq=' + this.hub.seq + ' clients=' + this.hub.clients.size);
      const dl = this.listDisks(user);
      add('存储盘', Array.isArray(dl) && dl.length > 0, (Array.isArray(dl) ? dl.length : 0) + ' 个盘符');
      let writable = false;
      try {
        const pr = this.resolvePublicRoot();
        fs.accessSync(pr.root, fs.constants.W_OK);
        writable = true;
      } catch { /* 只读或不存 */ }
      add('公共盘可写', writable, this.resolvePublicRoot().root);

      const st = this.tasks.stats();
      add('任务中心', true, `${st.running} 运行中 / ${st.total} 累计`);
      add('设备发现', true, this.presence.stats().online + ' 台在线');
      add('设备配对', !this.pairing.requirePairing || this.pairing.stats().trusted > 0,
        this.pairing.requirePairing ? '严格模式（已信任 ' + this.pairing.stats().trusted + ' 台）' : '宽松模式');
      add('数据同步', true, this.sync.stats().devices + ' 台设备有游标');
      add('限时分享', true, this.share.stats().active + ' 条有效链接');
      add('远程控制', true, this.remote.execEnabled ? 'exec 已开启' : 'exec 关闭（安全默认）');
      add('HTTPS', !!this.tls, this.tls ? '已启用（剪贴板 API 可用）' : '未启用（剪贴板受浏览器限制，已提供兼容复制）');

      const pass = checks.filter((c) => c.ok).length;
      return sendJSON(res, 200, {
        ok: true,
        version: 'v4.1-workstation',
        pass, total: checks.length, allPass: pass === checks.length,
        checks,
        runtime: { node: process.version, platform: process.platform, uptimeS: Math.round(process.uptime()) },
      });
    }

    /* ----- v3：2FA（TOTP）状态 / 准备 / 启用 / 停用 ----- */
    if (pathname === '/api/totp/status' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, { enabled: !!user.totpEnabled });
    }
    if (pathname === '/api/totp/setup' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      if (user.totpEnabled) return sendJSON(res, 400, { error: '2FA 已启用' });
      const secret = totpLib.generateSecret(20);
      user.totpSecret = secret;
      user.totpEnabled = false;
      this.users.save();
      return sendJSON(res, 200, {
        ok: true, secret,
        otpauth: totpLib.otpauthURI({ label: user.username, secret, issuer: 'LAN-NAS' }),
      });
    }
    if (pathname === '/api/totp/enable' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const body = await readBody(req, 4 * 1024);
      const { code } = JSON.parse(body.toString('utf8') || '{}');
      if (!user.totpSecret) return sendJSON(res, 400, { error: '请先获取密钥（setup）' });
      const tvSetup = totpLib.verify(user.totpSecret, String(code || '').trim());
      if (!tvSetup.ok) {
        return sendJSON(res, 400, { error: '验证码不对，请重试' });
      }
      /* R8-8-3：启用时用掉的码也记账 —— 否则刚启用的那一个码还能拿去登录 */
      if (Number.isFinite(tvSetup.counter)) user.totpLastCounter = tvSetup.counter;
      user.totpEnabled = true;
      this.users.save();
      this.audit({ userObj: user, action: '2fa-enable', ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/totp/disable' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const body = await readBody(req, 4 * 1024);
      const { code } = JSON.parse(body.toString('utf8') || '{}');
      if (user.totpEnabled && !totpLib.verify(user.totpSecret, String(code || '').trim()).ok) {
        return sendJSON(res, 400, { error: '验证码不对' });
      }
      user.totpSecret = null;
      user.totpEnabled = false;
      this.users.save();
      this.audit({ userObj: user, action: '2fa-disable', ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true });
    }

    /* ----- 盘符列表（含外置硬盘热插拔识别） ----- */
    /* R1-1-5 修订（分级披露）：一刀切 401 会误伤访客态顶栏存储条
       （shell.js loadNasState 依赖本端点读公共盘水位）。
       改为：游客只返回公共盘（其容量对可匿名浏览公共盘的人本就可见），
       外置盘卷标/UUID/容量、私人盘与 diskErrors（含挂载点路径）仍要求登录。 */
    if (pathname === '/api/disks' && m === 'GET') {
      const all = this.listDisks(user);
      const disks = user ? all : all.filter((d) => d.id === 'public');
      const diskErrors = user ? this.externalErrors() : [];
      return sendJSON(res, 200, diskErrors.length ? { disks, diskErrors } : { disks });
    }

    /* ----- 回收站：列表 / 还原 / 清空 ----- */
    /* R2-2-6：回收站对未登录者 401 —— 已删除文件的历史内容不是公共盘的匿名可读面 */
    if (pathname === '/api/recycle' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const t = this.resolveTarget({ disk: query.disk, scope: query.scope, path: '' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      return sendJSON(res, 200, { items: this.recycleIndex(t.root) });
    }
    if (pathname === '/api/recycle/restore' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { disk, scope, id } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.resolveTarget({ disk, scope, path: '', _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const r = this.recycleRestore(t.root, id);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      this.audit({ userObj: user, action: 'restore', disk: t.disk, path: r.restored, ip: req.socket.remoteAddress });
      this.invalidateSizeCache();
      return sendJSON(res, 200, { ok: true, restored: r.restored });
    }
    if (pathname === '/api/recycle/purge' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { disk, scope, id } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.resolveTarget({ disk, scope, path: '', _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      if (id) {
        /* R2-2-1（P0）：id 未经校验直接 path.join → '..' 可逃逸 .recycle 删任意文件。
           修法：id 必须存在于本盘回收站索引（索引由服务端生成，天然白名单），
           且落点必须仍在 .recycle 内（防御性双重校验）。 */
        const item = this.recycleIndex(t.root).find((x) => x.id === id);
        if (!item) return sendJSON(res, 404, { error: '回收站中没有该项' });
        const target = this.storage.safeResolve(this.recycleDir(t.root), id);
        if (!target) return sendJSON(res, 400, { error: '非法回收站条目' });
        try { this.storage.remove(target); } catch (e) {}
        this.recycleSave(t.root, this.recycleIndex(t.root).filter((x) => x.id !== id));
      } else {
        this.recyclePurge(t.root, 0);
      }
      this.audit({ userObj: user, action: 'purge', disk: t.disk, path: id || '*', ip: req.socket.remoteAddress });
      this.invalidateSizeCache();
      return sendJSON(res, 200, { ok: true });
    }

    /* ----- 版本历史 ----- */
    if (pathname === '/api/versions' && m === 'GET') {
      /* R9：原来无登录检查 —— 游客可对公共盘任意路径枚举版本历史
         （历史文件名 + 时间 + 大小），等于一份公开的变更台账。 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const t = this.resolveTarget(query, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      return sendJSON(res, 200, { versions: this.versionList(t.root, query.path || '') });
    }

    /* 整盘版本占用统计（R11）：给「历史版本」面板和运维排查用 */
    if (pathname === '/api/version-usage' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      /* 不传 disk 时统计所有可见盘；传了只统计那个 */
      const want = String(query.disk || '');
      const roots = [];
      if (want) {
        const t = this.resolveTarget({ disk: want, path: '' }, user);
        if (t.error) return sendJSON(res, t.code, { error: t.error });
        roots.push({ disk: t.disk, root: t.root });
      } else {
        try { roots.push({ disk: 'public', root: this.resolvePublicRoot().root }); } catch (e) {}
        try { for (const e of this.scanExternal()) roots.push({ disk: e.disk || ('ext:' + e.name), root: e.root }); } catch (e) {}
      }
      const per = roots.map((r) => {
        const u = this.versionUsage(r.root);
        return { disk: r.disk, bytes: u.bytes, count: u.count, dirs: u.dirs, top: u.top };
      });
      const total = per.reduce((a, b) => ({ bytes: a.bytes + b.bytes, count: a.count + b.count }),
        { bytes: 0, count: 0 });
      return sendJSON(res, 200, { ok: true, total, disks: per });
    }

    /* ----- 版本取回 / 恢复（R11）-----
       原来只有 /api/versions 列表：版本存了却既看不到也拿不回来，是个只进不出的黑洞。
       这里补上"取回"和"恢复"两个动作。 */
    const _verSafe = (n) => {
      const v = String(n || '');
      if (!v || v.includes('/') || v.includes('\\') || v.includes('..') || v.startsWith('.')) return null;
      return v;
    };

    /* ----- 版本删除 / 清理（R11）-----
       .versions 只增不减：一个被反复覆盖的大文件能攒出几十份，
       而界面只能看/取/恢复 —— 想腾空间只能 ssh 进来 rm。这里补上删除。
       两个动作都要写权限校验 + 版本名沙箱校验（_verSafe）。 */
    if ((pathname === '/api/version-delete' || pathname === '/api/version-prune') && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const vbody = await readBody(req, 64 * 1024);
      let vrq = {};
      try { vrq = JSON.parse(vbody.toString('utf8') || '{}'); } catch { return sendJSON(res, 400, { error: '参数错误' }); }
      const vrel = String(vrq.path || '');
      const vt = this.resolveTarget({ disk: vrq.disk, path: vrel, _write: true }, user);
      if (vt.error) return sendJSON(res, vt.code, { error: vt.error });
      const vDir = path.join(vt.root, '.versions', vrel);
      if (!fs.existsSync(vDir)) return sendJSON(res, 404, { error: '该文件没有历史版本' });
      const removed = [];
      if (pathname === '/api/version-delete') {
        const vName = _verSafe(vrq.name);
        if (!vName) return sendJSON(res, 400, { error: '版本名非法' });
        const vAbs = path.join(vDir, vName);
        let vst = null;
        try { vst = fs.statSync(vAbs); } catch { return sendJSON(res, 404, { error: '版本不存在' }); }
        if (!vst.isFile()) return sendJSON(res, 404, { error: '版本不存在' });
        try { fs.unlinkSync(vAbs); } catch (e) {
          return sendJSON(res, 500, { error: '删除失败：' + (e && e.message) });
        }
        removed.push(vName);
      } else {
        /* 清理：保留最新 keep 个（默认 1），其余删掉 */
        let keep = Number.isFinite(Number(vrq.keep)) ? Math.floor(Number(vrq.keep)) : 1;
        keep = Math.max(0, Math.min(50, keep));
        const vlist = this.versionList(vt.root, vrel);
        for (const v of vlist.slice(keep)) {
          try { fs.unlinkSync(path.join(vDir, v.name)); removed.push(v.name); } catch { /* 单个失败不中断 */ }
        }
      }
      /* 空目录留着会攒出一堆空壳；顺手清掉 */
      try { if (!fs.readdirSync(vDir).length) fs.rmdirSync(vDir); } catch { /* 非空/忙就算了 */ }
      try { if (this._verUsage) this._verUsage.delete(vt.root); } catch (e) {}
      this.invalidateSizeCache();
      this.audit({ userObj: user,
        action: pathname === '/api/version-prune' ? 'version-prune' : 'version-delete',
        disk: vt.disk, path: vrel, ip: req.socket.remoteAddress,
        detail: '删除 ' + removed.length + ' 个版本' });
      return sendJSON(res, 200, { ok: true, removed: removed.length, names: removed.slice(0, 20) });
    }
    if (pathname === '/api/version-get' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const t = this.resolveTarget(query, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const vName = _verSafe(query.name);
      if (!vName) return sendJSON(res, 400, { error: '版本名非法' });
      const vAbs = path.join(t.root, '.versions', query.path || '', vName);
      let vst = null;
      try { vst = fs.statSync(vAbs); } catch { return sendJSON(res, 404, { error: '版本不存在' }); }
      if (!vst.isFile()) return sendJSON(res, 404, { error: '版本不存在' });
      /* 版本文件名形如 2026-10-21T03-00-00-000Z_原文件名，取回时还原成原始文件名 */
      const orig = vName.replace(/^\d{4}-\d{2}-\d{2}T[^_]*_/, '') || vName;
      res.writeHead(200, {
        'Content-Type': mimeOf(orig),
        'Content-Length': vst.size,
        'Content-Disposition': contentDisposition(orig),
      });
      return fs.createReadStream(vAbs, { highWaterMark: 1 << 20 }).pipe(res);
    }

    if (pathname === '/api/version-restore' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      let req2 = {};
      try { req2 = JSON.parse(body.toString('utf8') || '{}'); } catch { return sendJSON(res, 400, { error: '参数错误' }); }
      const relPath = String(req2.path || '');
      const vName = _verSafe(req2.name);
      if (!vName) return sendJSON(res, 400, { error: '版本名非法' });
      const t = this.resolveTarget({ disk: req2.disk, path: relPath, _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const vAbs = path.join(t.root, '.versions', relPath, vName);
      let vst = null;
      try { vst = fs.statSync(vAbs); } catch { return sendJSON(res, 404, { error: '版本不存在' }); }
      if (!vst.isFile()) return sendJSON(res, 404, { error: '版本不存在' });
      /* 恢复前先把当前文件也归档 —— 恢复本身也应该是可反悔的操作。
         注意方法名是 versionArchive(root, relPath, user)；之前写成 archiveVersion，
         外面还套了空 catch，静默失效（实测恢复后当前版本没了）。 */
      try {
        if (fs.existsSync(t.abs) && fs.statSync(t.abs).isFile()) this.versionArchive(t.root, relPath, user);
      } catch (e) {
        console.warn('[version] 恢复前归档失败：' + (e && e.message));
      }
      const tmp = t.abs + '.vrestore-' + Date.now();
      try {
        fs.copyFileSync(vAbs, tmp);
        fs.renameSync(tmp, t.abs);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        return sendJSON(res, 500, { error: '恢复失败：' + e.message });
      }
      try { fs.unlinkSync(vAbs); } catch (e) {}
      this.invalidateSizeCache();
      this.notifyFilesChanged('restore', { disk: t.disk, path: relPath, user: user.username });
      this.audit({ userObj: user, action: 'restore-version', disk: t.disk, path: relPath + ' ← ' + vName, ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true, restored: vName });
    }

    /* ----- 审计日志 ----- */
    if (pathname === '/api/audit' && m === 'GET') {
      /* R9：原来只要登录就能读**全站**审计日志 —— 含他人用户名、来源 IP、
         操作路径。审计是安全边界数据，只给管理员。 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '需要管理员权限' });
      return sendJSON(res, 200, { items: this.readAudit(Math.min(+query.limit || 300, 1000)) });
    }

    /* ----- SHA-256 校验值（文件信息面板用，带缓存） ----- */
    if (pathname === '/api/checksum' && m === 'GET') {
      const t = this.resolveTarget(query, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      let st;
      try { st = fs.statSync(t.abs); } catch { return sendJSON(res, 404, { error: '文件不存在' }); }
      if (!st.isFile()) return sendJSON(res, 400, { error: '不是文件' });
      if (!this._hashCache) this._hashCache = new Map();
      const key = t.abs + '|' + st.size + '|' + Math.floor(st.mtimeMs);
      let hex = this._hashCache.get(key);
      if (!hex) {
        hex = await new Promise((resolve, reject) => {
          const h = crypto.createHash('sha256');
          fs.createReadStream(t.abs, { highWaterMark: 1 << 20 })
            .on('data', (d) => h.update(d))
            .on('end', () => resolve(h.digest('hex')))
            .on('error', reject);
        });
        if (this._hashCache.size > 64) this._hashCache.clear();
        this._hashCache.set(key, hex);
      }
      return sendJSON(res, 200, { sha256: hex, size: st.size });
    }

    /* ----- 批量下载：多文件/目录打包 ZIP（store 模式，流式输出） ----- */
    if (pathname === '/api/zip' && m === 'POST') {
      /* R2-2-8（P2）：原代码 requireWrite 结果被 `if (deny && false)` 死代码丢弃 ——
         打包本质是读操作，游客本可参与；但 deny 永不生效属意图不明。
         现明确语义：zip 是读操作，不做登录要求（与 /api/download 一致），
         ACL 检查已由 resolveTarget 完成（404/403），下面这行删除。 */
      const body = await readBody(req, 1024 * 1024);
      const { disk, paths } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.resolveTarget({ disk: disk || 'public', path: '' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      if (!Array.isArray(paths) || !paths.length) return sendJSON(res, 400, { error: '未选择文件' });
      if (paths.length > 500) return sendJSON(res, 400, { error: '一次最多打包 500 项' });

      const entries = collectZipEntries(this.storage, t.root, paths);
      if (!entries.length) return sendJSON(res, 400, { error: '没有可打包的文件' });
      if (entries.length > 2000) return sendJSON(res, 400, { error: '打包内容超过 2000 个文件' });

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition('Files-' + Date.now() + '.zip'),
      });
      try {
        await writeZipToStream(res, entries);
        res.end();
      } catch (e) {
        console.error('[zip]', e.message);
        try { res.end(); } catch { /* 已断开 */ }
      }
      return;
    }

    /* R2-2-2（P0）：原 /api/debug-probe 临时诊断端点已移除 ——
       未鉴权 + GET 带写副作用（写/删 .fsp 探针文件）+ 泄漏 /storage 结构。
       诊断需求由 /api/station/selfcheck（需登录）覆盖。 */

    /* ----- 上传模式协商（前端启动时探测能力） ----- */
    if (pathname === '/api/capabilities' && m === 'GET') {
      /* svcs：附属协议服务的**真实运行状态**。
         为什么放这里：新面板（React 版）的「系统设置 → 连接服务」读的是本接口的
         svcs/services 字段，而本接口原本只回 6 个传输能力位 → 面板 6 行全显「未获取」，
         用户以为是功能缺失，实际服务都在跑（实测手机上 WebDAV/S3/FTP/NFS/DLNA/mDNS 全活）。
         ⚠️ 只回布尔/端口，**不回内网地址**：本接口对任意登录用户开放（含非管理员），
         地址信息由前端用同源 location.origin 自己拼，与游客脱敏口径保持一致。
         · dav/s3 挂主端口、有各自鉴权 → 恒可用，不看 this.svcs
         · ftp/nfs/dlna/mdns 由启动期容错拉起，**成功才登记**进 this.svcs
         · sshd 是安全默认关闭项，需显式 autoSshd:true，未开就回 false（不是"未获取"） */
      const s = this.svcs || {};
      return sendJSON(res, 200, {
        http2: !!this.cfg.http2,
        tls: !!this.cfg.tls,
        chunkUpload: true,
        chunkThresholdMB: this.cfg.chunkThresholdMB,
        maxUploadMB: this.cfg.maxUploadMB,
        recommendedThreads: 64,
        services: {
          dav: true,                      // WebDAV 恒挂主端口
          s3: true,                       // S3 网关恒挂主端口
          ftp: s.ftp || false,            // 2121
          nfs: s.nfs || false,            // 2049
          dlna: s.dlna === true,
          mdns: s.mdns === true,
          /* R10：SMB 共享状态。smbd 是系统级服务，不由本进程拉起，因此不在 this.svcs 里，
             面板那一行一直显示"未获取"，用户误以为没有 SMB。实际服务器上 smbd active、
             445/139 在监听、smb.conf 有多个共享。
             判活：先读 pid 文件（可能残留）再 kill(pid, 0) 验活，避免"文件在、进程没了"。
             兼容 Android：/run/samba 不存在 → 直接 false，不抛异常。 */
          smb: (() => {
            try {
              const pidFile = fs.existsSync('/run/samba/smbd.pid')
                ? '/run/samba/smbd.pid'
                : (fs.existsSync('/var/run/samba/smbd.pid') ? '/var/run/samba/smbd.pid' : null);
              if (!pidFile) return false;
              const pid = parseInt(String(fs.readFileSync(pidFile, 'utf8')).trim(), 10);
              if (!pid) return false;
              try {
                process.kill(pid, 0);
                return true;
              } catch (e) {
                /* R10：smbd 是 root 进程，站点进程是 tokenllm → kill(0) 抛 EPERM。
                   EPERM 说明"进程存在但没权限发信号"，等于活着；只有 ESRCH 才是真的没了。 */
                return !!(e && e.code === 'EPERM');
              }
            } catch { return false; }
          })(),
          sshd: this.cfg.autoSshd === true ? 8022 : false,
        },
        /* 共享名只回名字、不回路径；10 秒缓存，避免每次探测都读配置。
           前端可以据此显示"公共盘 / 办公 / 备份"，比一句"已启用"更有用。 */
        smbShares: (() => {
          const now = Date.now();
          if (this._smbSharesCache && now - this._smbSharesCache.at < 10000) return this._smbSharesCache.names;
          const names = [];
          const seen = new Set();
          const readConf = (fp, depth) => {
            if (depth > 3) return;
            let txt = '';
            try { txt = fs.readFileSync(fp, 'utf8'); } catch { return; }
            for (const rawLine of txt.split('\n')) {
              const line = rawLine.trim();
              const inc = /^include\s*=\s*(.+)$/i.exec(line);
              if (inc) {
                /* include 可以写通配；展开后再读，否则真实共享（station-shares.conf）会被漏掉 */
                const target = inc[1].trim();
                let list = [target];
                if (target.indexOf('*') >= 0) {
                  try { list = typeof fs.globSync === 'function' ? fs.globSync(target) : []; } catch { list = []; }
                }
                for (const t of list) readConf(t, depth + 1);
                continue;
              }
              const sec = /^\[([^\]]+)\]$/.exec(line);
              if (!sec) continue;
              const nm = sec[1].trim();
              const low = nm.toLowerCase();
              if (low === 'global' || low === 'printers' || low === 'print$') continue;
              if (seen.has(low)) continue;
              seen.add(low);
              names.push(nm);
            }
          };
          readConf('/etc/samba/smb.conf', 0);
          this._smbSharesCache = { at: now, names: names.slice(0, 16) };
          return this._smbSharesCache.names;
        })(),
        /* 平台能力位：让前端能区分「服务没开」和「系统不让读」。
           Android 上 /proc/stat 与 /proc/net/dev 均 EACCES，os.cpus() 为空数组
           → cpu/net 无从采集。面板据此显示「系统限制」而不是干巴巴的 --% / 0.0。 */
        platform: process.platform,
        monitor: (() => {
          try {
            const snap = this.monitor.snapshot('caps');
            return {
              cpuSupported: snap.cpuSupported === true,
              netSupported: snap.netSupported === true,
              loadSupported: snap.loadSupported === true,
            };
          } catch (e) {
            return { cpuSupported: false, netSupported: false, loadSupported: false };
          }
        })(),
      });
    }

    /* ----- 文件操作 ----- */
    if (pathname === '/api/list' && m === 'GET') {
      const t = this.resolveTarget(query, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      if (!fs.existsSync(t.abs)) return sendJSON(res, 404, { error: '目录不存在' });
      if (!fs.statSync(t.abs).isDirectory()) return sendJSON(res, 400, { error: '路径不是目录' });
      const rel = t.abs === t.root ? '' : path.relative(t.root, t.abs).split(path.sep).join('/');
      /* R13：?type=doc,sheet 这类过滤（数据层筛选，避免前端过滤误伤）。
         不带 type 时行为完全不变。 */
      let entries = this.storage.list(t.abs);
      const wantType = String(query.type || '').trim().toLowerCase();
      if (wantType) {
        const TYPE_RE = {
          doc: /\.(docx?|odt|rtf|md|txt|pdf)$/i,
          sheet: /\.(xlsx?|csv|ods)$/i,
          slide: /\.(pptx?|odp|key)$/i,
          image: /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i,
          video: /\.(mp4|mkv|mov|avi|webm)$/i,
          audio: /\.(mp3|flac|wav|m4a|ogg)$/i,
          archive: /\.(zip|7z|rar|tar|gz|xz)$/i,
        };
        const set = wantType.split(',').map((x) => x.trim()).filter(Boolean);
        const known = set.filter((k) => TYPE_RE[k]);
        entries = entries.filter((e) => {
          if (e.isDir) return set.includes('dir');
          return known.some((k) => TYPE_RE[k].test(e.name || ''));
        });
      }
      return sendJSON(res, 200, {
        scope: t.scope, path: rel,
        parent: rel === '' ? null : (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''),
        type: wantType || null,
        entries,
      });
    }

    if (pathname === '/api/search' && m === 'GET') {
      const t = this.resolveTarget(query, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const results = this.storage.search(t.abs, query.q || '', { maxResults: 300 });
      return sendJSON(res, 200, { scope: t.scope, keyword: query.q || '', results });
    }

    if (pathname === '/api/download' && m === 'GET') {
      const t = this.resolveTarget(query, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      if (!fs.existsSync(t.abs) || !fs.statSync(t.abs).isFile()) {
        return sendJSON(res, 404, { error: '文件不存在' });
      }
      const name = path.basename(t.abs);
      const st = fs.statSync(t.abs);
      const total = st.size;
      const mime = mimeOf(name);
      const disposition = contentDisposition(name);
      const baseHeaders = {
        'Content-Disposition': disposition,
        'Accept-Ranges': 'bytes',
      };

      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          let start = m[1] === '' ? null : parseInt(m[1], 10);
          let end = m[2] === '' ? null : parseInt(m[2], 10);
          if (start === null && end !== null) {
            start = Math.max(0, total - end);
            end = total - 1;
          } else if (start !== null && end === null) {
            end = total - 1;
          }
          if (start !== null && end !== null && start >= 0 && end < total && start <= end) {
            const chunk = end - start + 1;
            res.writeHead(206, {
              ...baseHeaders,
              'Content-Type': mime,
              'Content-Length': chunk,
              'Content-Range': `bytes ${start}-${end}/${total}`,
            });
            return fs.createReadStream(t.abs, { start, end, highWaterMark: 1 << 20 }).pipe(res);
          }
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
      }

      res.writeHead(200, {
        ...baseHeaders,
        'Content-Type': mime,
        'Content-Length': total,
      });
      const rs = fs.createReadStream(t.abs, { highWaterMark: 1 << 20 });
      if (this.limiter) {
        /* v3：全局限速（limit.json downloadKBps > 0 时启用） */
        rs.on('data', (chunk) => {
          rs.pause();
          /* R9：按客户端分桶限速 —— 原来是一个**全局**桶，
             一个客户端就能吃光全站带宽（其它客户端直接被拖成 0 速）。
             传第二个参数（客户端 IP）后每个客户端各自享有一份配额。 */
          Promise.resolve(this.limiter.take(chunk.length, req.socket.remoteAddress)).then(() => {
            if (res.writableEnded) return;
            if (!res.write(chunk)) res.once('drain', () => rs.resume());
            else rs.resume();
          }).catch(() => rs.resume());
        });
        rs.on('end', () => res.end());
        rs.on('error', () => { try { res.destroy(); } catch {} });
      } else {
        rs.pipe(res);
      }
      return;
    }

    /* ----- 分块上传（大文件） ----- */

    // 1) 初始化：前端 POST /api/chunk-init {scope, path, name, size, chunkSize}
    if (pathname === '/api/chunk-init' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { scope, disk, path: relPath, name, size, chunkSize } = JSON.parse(body.toString('utf8') || '{}');

      const t = this.resolveTarget({ disk, scope, path: relPath, _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      if (!this.storage.validateName(name)) return sendJSON(res, 400, { error: '非法文件名' });
      if (!Number.isInteger(size) || size <= 0) return sendJSON(res, 400, { error: '非法文件大小' });
      if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > 64 * 1024 * 1024) {
        return sendJSON(res, 400, { error: '非法分块大小' });
      }
      /* R10：path 语义是「目标目录」，name 才是文件名。但有的客户端把完整路径
         （含文件名）塞进 path，此时 t.abs 指向一个不存在的目录，后面 open 会 ENOENT
         并被兜成 500「服务器内部错误」，用户根本看不出是参数问题。
         这里做一次归一：末段等于 name 就退到父目录；然后强制校验目录存在。 */
      let dirAbs = t.abs;
      if (name && path.basename(dirAbs) === path.basename(String(name))) {
        dirAbs = path.dirname(dirAbs);
      }
      let dirStat = null;
      try { dirStat = fs.statSync(dirAbs); } catch (e) { dirStat = null; }
      if (!dirStat || !dirStat.isDirectory()) {
        return sendJSON(res, 400, {
          error: '目标目录不存在',
          detail: 'path 字段应传目录（可为空），文件名请放在 name 字段',
        });
      }

      // 公共盘 64GB 配额
      if (t.disk === 'public') {
        const used = this.usedBytes(t.root);
        if (used + size > PUBLIC_QUOTA) {
          return sendJSON(res, 400, { error: `公共盘 64GB 配额已满（已用 ${formatSize(used)}，需再 ${formatSize(size)}）` });
        }
      }
      /* R9：用户级配额此前只在 S3 路径生效，Web 上传两条路径都不查 ——
         配了额度的用户照样能把私人空间撑爆。判定用 quotaStore.quotaOk 的
         enforce 模式：超限即拒绝（判定失败也按拒绝处理，fail-closed）。 */
      {
        const uq = quotaStore.quotaOk(this, user, size, { enforce: true });
        if (!uq.ok) {
          return sendJSON(res, 507, { error: uq.error || '用户存储配额不足' });
        }
      }
      // 外置盘剩余空间检查
      if (t.disk && t.disk.startsWith('ext:')) {
        const ext = this.scanExternal().find((e) => t.disk.endsWith(e.label));
        if (ext && ext.free && size > ext.free) {
          return sendJSON(res, 400, { error: `外置硬盘空间不足（剩余 ${formatSize(ext.free)}）` });
        }
      }

      const totalChunks = Math.ceil(size / chunkSize);
      if (totalChunks > 100000) return sendJSON(res, 400, { error: '分块数过多' });

      /* ---- 秒传：命中哈希索引则直接复制，跳过全部传输 ---- */
      const { sha256 } = JSON.parse(body.toString('utf8') || '{}');
      if (sha256) {
        const hit = this.hashIndex.lookup(sha256, size);
        if (hit) {
          const finalAbs = path.join(dirAbs, name);
          try {
            if (hit.abs === finalAbs) {
              // 目标就是同一文件，直接算完成
              return sendJSON(res, 200, { ok: true, instant: true, uploadId: null, reason: '目标已存在' });
            }
            if (fs.existsSync(finalAbs)) this.versionArchive(dirAbs, name, user);
            fs.copyFileSync(hit.abs, finalAbs);
            this.invalidateSizeCache();
            this.audit({ user, action: 'instant-upload', path: name, detail: 'sha256 命中，跳过传输' });
            return sendJSON(res, 200, {
              ok: true, instant: true, uploadId: null,
              reason: `秒传命中（${formatSize(size)} 未传输）`,
            });
          } catch (e) {
            /* 复制失败则退回正常分片上传流程 */
          }
        }
      }

      /* ---- R11 断点续传 ----
         原来 uploadId 是随机的、会话只在内存，于是断网重试/关页面/重启进程
         之前的传输全部作废，1GB 文件得从头再来。现在：
           · uploadId = 确定性哈希（同一用户 + 同一目标 + 同一大小 + 同一分片大小）；
           · 已收分片集合落盘 `.uploading-<id>.map`；
           · 重新上传同一个文件时，chunk-init 直接告诉前端哪几片已经有了。
         id 里带 user.id 是为了隔离：两个用户传同一目标不会撞同一个临时文件
         （否则会被属主校验 403）；同一用户重新登录仍可续传，因为 user.id 稳定。 */
      const resumeKey = `${(user && user.id) || 0}|${t.disk}|${dirAbs}|${name}|${size}|${chunkSize}`;
      const uploadId = crypto.createHash('sha256').update(resumeKey).digest('hex').slice(0, 24);
      const tmpName = `.uploading-${uploadId}`;
      const tmpAbs = path.join(dirAbs, tmpName);
      const mapAbs = `${tmpAbs}.map`;

      /* 内存里这个会话还活着（同一页面点重试）—— 直接回报已收分片 */
      const live = this.uploads.get(uploadId);
      if (live && live.owner === (user ? user.id : null)) {
        return sendJSON(res, 200, {
          ok: true, uploadId, chunkSize, totalChunks,
          received: Array.from(live.received).sort((a, b) => a - b),
          resumed: live.received.size,
        });
      }

      /* 位图读回：只有大小/分片大小都对得上、且临时文件确实够长时才算数，
         否则一律当全新上传（坏位图不能把上传卡死）。 */
      let prevReceived = [];
      try {
        const mj = JSON.parse(await fs.promises.readFile(mapAbs, 'utf8'));
        if (mj && mj.size === size && mj.chunkSize === chunkSize && Array.isArray(mj.received)) {
          prevReceived = mj.received
            .filter((n) => Number.isInteger(n) && n >= 0 && n < totalChunks);
        }
      } catch (e) { prevReceived = []; }
      const reuse = new Set();
      if (prevReceived.length) {
        try {
          const st = fs.statSync(tmpAbs);
          const maxIdx = prevReceived.reduce((m, n) => (n > m ? n : m), -1);
          const need = Math.min(size, (maxIdx + 1) * chunkSize);
          if (st.size >= need) prevReceived.forEach((n) => reuse.add(n));
        } catch (e) { /* 临时文件没了 → 全新传 */ }
      }

      // 打开文件句柄（后续分块直接 pwrite 定位写入）
      /* R10：磁盘满、权限不足、目录被删都会在这里失败 —— 给 4xx/5xx 带原因，
         不要让原始 ENOENT/EACCES 冒泡成「服务器内部错误」。
         R11：续传时用 'r+' 保留已写入的分片；全新上传才用 'w' 截断。 */
      let handle;
      try {
        handle = await fs.promises.open(tmpAbs, reuse.size ? 'r+' : 'w');
      } catch (e) {
        return sendJSON(res, e && (e.code === 'ENOSPC' || e.code === 'EACCES') ? 507 : 400, {
          error: '无法创建上传临时文件',
          detail: String((e && e.message) || e).slice(0, 160),
        });
      }
      /* R2-2-4b/2-15：会话补 owner（属主校验用）与 disk（事件广播/秒传索引用）。
         原实现缺这两个字段：任何登录用户拿到 uploadId 即可接管他人上传会话。 */
      if (process.env.ST_DEBUG_CHUNK) {
        console.log(`[chunk] init ${name} size=${size} mode=${reuse.size ? 'r+' : 'w'} reuse=${reuse.size}/${totalChunks} tmp=${path.basename(tmpAbs)}`);
      }
      this.uploads.set(uploadId, {
        abs: tmpAbs, mapAbs, finalName: name, finalDir: dirAbs,
        size, chunkSize, totalChunks, disk: t.disk,
        received: reuse, handle, startTime: Date.now(),
        owner: user ? user.id : null,
      });

      return sendJSON(res, 200, {
        ok: true, uploadId, chunkSize, totalChunks,
        received: Array.from(reuse).sort((a, b) => a - b),
        resumed: reuse.size,
      });
    }

    // 2) 数据块：PUT /api/chunk-data?uploadId=&index=   body=原始字节
    if (pathname === '/api/chunk-data' && (m === 'PUT' || m === 'POST')) {
      const deny = this.requireWrite(user);
      if (deny) { await drainRequest(req); return sendJSON(res, deny.code, { error: deny.error }); }

      const up = this.uploads.get(query.uploadId);
      if (!up) return sendJSON(res, 404, { error: '上传会话不存在或已过期' });
      /* R2-2-4b：会话属主校验 —— 只允许创建者本人续传 */
      if (up.owner !== (user ? user.id : null)) {
        await drainRequest(req);
        return sendJSON(res, 403, { error: '不能操作其他用户的上传会话' });
      }
      const index = parseInt(query.index, 10);
      if (!Number.isInteger(index) || index < 0 || index >= up.totalChunks) {
        await drainRequest(req);
        return sendJSON(res, 400, { error: '非法分块序号' });
      }
      if (up.received.has(index)) {
        await drainRequest(req);
        return sendJSON(res, 200, { ok: true, duplicate: true });
      }

      // 流式写入到正确偏移（pwrite 风格），不占内存
      const offset = index * up.chunkSize;
      const expected = Math.min(up.chunkSize, up.size - offset);
      const buf = await readBody(req, expected + 64 * 1024); // 允许少量头部冗余
      if (buf.length !== expected) {
        return sendJSON(res, 400, { error: `分块 ${index} 大小不符（期望 ${expected}，收到 ${buf.length}）` });
      }
      await up.handle.write(buf, 0, buf.length, offset);
      up.received.add(index);
      /* R11：位图落盘（8MB 才写一次，开销可忽略）。失败不影响本次响应，
         下次续传最多重传一片。 */
      if (up.mapAbs) {
        fs.promises.writeFile(up.mapAbs, JSON.stringify({
          size: up.size, chunkSize: up.chunkSize,
          received: Array.from(up.received),
        })).catch(() => {});
      }

      const done = up.received.size;
      return sendJSON(res, 200, {
        ok: true,
        index, received: done, total: up.totalChunks,
        progress: Math.round((done / up.totalChunks) * 100),
      });
    }

    // 3) 完成：POST /api/chunk-complete {uploadId}
    if (pathname === '/api/chunk-complete' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { uploadId, sha256 } = JSON.parse(body.toString('utf8') || '{}');
      const up = this.uploads.get(uploadId);
      if (!up) return sendJSON(res, 404, { error: '上传会话不存在' });
      /* R2-2-4b：完成阶段同样校验属主 */
      if (up.owner !== (user ? user.id : null)) {
        return sendJSON(res, 403, { error: '不能操作其他用户的上传会话' });
      }
      if (up.received.size !== up.totalChunks) {
        return sendJSON(res, 400, { error: `分块不完整（${up.received.size}/${up.totalChunks}）` });
      }
      await up.handle.close();

      // 可选 sha256 校验（前端算完整文件 hash 传入）
      if (sha256) {
        const h = crypto.createHash('sha256');
        await new Promise((resolve, reject) => {
          fs.createReadStream(up.abs, { highWaterMark: 1 << 20 })
            .on('data', (d) => h.update(d))
            .on('end', resolve)
            .on('error', reject);
        });
        const actual = h.digest('hex');
        if (actual !== String(sha256).toLowerCase()) {
          fs.unlink(up.abs, () => {});
          if (up.mapAbs) fs.unlink(up.mapAbs, () => {});
          this.uploads.delete(uploadId);
          return sendJSON(res, 400, { error: 'SHA256 校验失败，文件已丢弃' });
        }
      }

      const finalAbs = path.join(up.finalDir, up.finalName);
      try {
        // 覆盖前存档旧版本
        if (fs.existsSync(finalAbs)) {
          /* R2-2-4（P1）：原代码引用未定义变量 t_abs_root（ReferenceError → catch → 500），
             导致「覆盖已有文件」的分块上传必然失败。versionArchive 只需相对 finalDir 的 rel。 */
          const rel = path.relative(up.finalDir, finalAbs);
          this.versionArchive(up.finalDir, rel, user);
        }
        fs.renameSync(up.abs, finalAbs);
        if (process.env.ST_DEBUG_CHUNK) console.log(`[chunk] complete ${up.finalName} → ${finalAbs}`);
        if (up.mapAbs) fs.unlink(up.mapAbs, () => {});   // R11：位图与临时文件同生共死
        this.invalidateSizeCache();
        /* 记录哈希索引，供后续同内容文件秒传 */
        if (sha256) this.hashIndex.record(sha256, finalAbs, up.size, up.disk || '', up.finalName);
      } catch (e) {
        fs.unlinkSync(up.abs);
        this.uploads.delete(uploadId);
        return sendJSON(res, 500, { error: '落盘失败：' + e.message });
      }
      this.uploads.delete(uploadId);
      const elapsed = ((Date.now() - up.startTime) / 1000).toFixed(2);
      this.notifyFilesChanged('upload', { disk: up.disk, path: up.finalName, user: user.username });
      return sendJSON(res, 200, { ok: true, name: up.finalName, size: up.size, seconds: elapsed });
    }

    // 4) 取消：POST /api/chunk-cancel {uploadId}
    if (pathname === '/api/chunk-cancel' && m === 'POST') {
      const body = await readBody(req, 64 * 1024);
      const { uploadId } = JSON.parse(body.toString('utf8') || '{}');
      const up = this.uploads.get(uploadId);
      if (up) {
        if (process.env.ST_DEBUG_CHUNK) console.log(`[chunk] cancel ${up.finalName}`);
        try { await up.handle.close(); } catch {}
        fs.unlink(up.abs, () => {});
        if (up.mapAbs) fs.unlink(up.mapAbs, () => {});
        this.uploads.delete(uploadId);
      }
      return sendJSON(res, 200, { ok: true });
    }

    // 5) 状态：GET /api/chunk-status?uploadId=
    if (pathname === '/api/chunk-status' && m === 'GET') {
      const up = this.uploads.get(query.uploadId);
      if (!up) return sendJSON(res, 404, { error: '上传会话不存在' });
      return sendJSON(res, 200, {
        received: up.received.size, total: up.totalChunks,
        missing: [...Array(up.totalChunks).keys()].filter((i) => !up.received.has(i)).slice(0, 100),
      });
    }

    /* ----- 整体上传（小文件） ----- */
    if (pathname === '/api/upload' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) {
        await drainRequest(req);
        return sendJSON(res, deny.code, { error: deny.error });
      }

      const ct = req.headers['content-type'] || '';
      if (!/^multipart\/form-data/i.test(ct)) {
        return sendJSON(res, 400, { error: '请使用 multipart/form-data 上传' });
      }
      const buf = await readBody(req, this.cfg.maxUploadMB * 1024 * 1024);
      const { fields, files } = parseMultipart(buf, getBoundary(ct));

      const t = this.resolveTarget({ disk: fields.disk, scope: fields.scope, path: fields.path, _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      if (!fs.existsSync(t.abs)) fs.mkdirSync(t.abs, { recursive: true });

      /* R2-2-7（P1）：小文件上传原来完全不查配额（只有 chunk-init 查）→ 可绕过 64GB 限制填满磁盘 */
      if (t.disk === 'public') {
        const used = this.usedBytes(t.root);
        const incoming = files.reduce((a, f) => a + (f.data ? f.data.length : 0), 0);
        if (used + incoming > PUBLIC_QUOTA) {
          return sendJSON(res, 400, { error: `公共盘 64GB 配额已满（已用 ${formatSize(used)}，本次需 ${formatSize(incoming)}）` });
        }
      }
      /* R9：补上用户级配额（与 chunk-init 对齐） */
      {
        const incoming = files.reduce((a, f) => a + (f.data ? f.data.length : 0), 0);
        const uq = quotaStore.quotaOk(this, user, incoming, { enforce: true });
        if (!uq.ok) {
          return sendJSON(res, 507, { error: uq.error || '用户存储配额不足' });
        }
      }

      const uploaded = [];
      const failed = [];
      for (const f of files) {
        if (!this.storage.validateName(f.filename)) {
          failed.push({ name: f.filename, error: '非法文件名' });
          continue;
        }
        const dest = path.join(t.abs, f.filename);
        try {
          fs.writeFileSync(dest, f.data);
          uploaded.push({ name: f.filename, size: f.data.length });
          this.invalidateSizeCache();
        } catch (e) {
          failed.push({ name: f.filename, error: e.message });
        }
      }
      if (uploaded.length) this.notifyFilesChanged('upload', { disk: t.disk, path: fields.path || '', user: user.username });
      return sendJSON(res, 200, { ok: true, uploaded, failed });
    }

    if (pathname === '/api/mkdir' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { scope, path: relPath, name } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.resolveTarget({ scope, path: relPath, _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const r = this.storage.mkdir(t.root, relPath || '', name || '');
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      this.notifyFilesChanged('mkdir', { disk: t.disk, path: relPath || '', user: user.username });
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/rename' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { scope, path: relPath, name } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.resolveTarget({ scope, path: relPath, _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const r = this.storage.rename(t.root, relPath || '', name || '');
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      this.notifyFilesChanged('rename', { disk: t.disk, path: relPath || '', user: user.username });
      return sendJSON(res, 200, { ok: true });
    }

    /* 复制 / 移动：目标用完整相对路径（支持跨目录），供批量操作使用 */
    if ((pathname === '/api/copy' || pathname === '/api/move') && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { scope, path: relFrom, dest } = JSON.parse(body.toString('utf8') || '{}');
      if (!relFrom || !dest) return sendJSON(res, 400, { error: '缺少 path 或 dest' });
      const t = this.resolveTarget({ scope, path: '', _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const fn = pathname === '/api/copy' ? 'copy' : 'move';
      const r = this.storage[fn](t.root, relFrom, dest);
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      this.audit({ action: fn === 'copy' ? 'copy' : 'move', detail: relFrom + ' → ' + dest, user: user && user.username, ip: req.socket.remoteAddress });
      this.notifyFilesChanged(fn, { disk: t.disk, path: relFrom, user: user.username });
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/delete' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { scope, disk, path: relPath, permanent } = JSON.parse(body.toString('utf8') || '{}');
      if (!relPath) return sendJSON(res, 400, { error: '缺少路径' });
      const t = this.resolveTarget({ disk, scope, path: relPath, _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      if (t.abs === t.root) return sendJSON(res, 400, { error: '不能删除根目录' });
      if (!fs.existsSync(t.abs)) return sendJSON(res, 404, { error: '目标不存在' });
      if (permanent) {
        this.storage.remove(t.abs);
      } else {
        const r = this.recycleMove(t.root, t.abs, user);
        if (!r.ok) return sendJSON(res, 500, { error: r.error });
        this.audit({ userObj: user, action: 'delete', disk: t.disk, path: relPath, ip: req.socket.remoteAddress, detail: 'recycle' });
      }
      this.invalidateSizeCache();
      this.notifyFilesChanged(permanent ? 'purge' : 'delete', { disk: t.disk, path: relPath, user: user.username });
      /* R2-2-3（P1）：原代码此处无 return/sendJSON —— 删除成功后 fall-through 到
         路由尾部 404「接口不存在」，前端把成功当失败（列表回滚已删文件）。 */
      return sendJSON(res, 200, { ok: true, permanent: !!permanent });
    }

    /* ----- 管理员 ----- */
    if (pathname === '/api/admin/users' && m === 'GET') {
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: '需要管理员权限' });
      return sendJSON(res, 200, { users: this.users.users.map((u) => this.users.publicUser(u)) });
    }

    /* ================= v4：管理员后台端点（全部要求 admin 角色） ================= */
    const adminOnly = () => {
      if (!user || user.role !== 'admin') { sendJSON(res, 403, { error: '需要管理员权限' }); return false; }
      return true;
    };

    /* GenOffice 文档预览：任意格式 -> PDF 内联返回 */
    /* v5.1 · ONLYOFFICE 在线编辑（签名 token 让 DS 容器能拉取/回写） */
    if (pathname === '/api/office/oo/config' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const dk = query.disk || 'public';
      const rp = query.path || '';
      const t = this.resolveTarget({ disk: dk, path: rp }, user);
      if (t.error) return sendJSON(res, t.code || 400, { error: t.error });
      if (!fs.existsSync(t.abs)) return sendJSON(res, 404, { error: 'file not found' });
      if (!this.oo.supported(t.abs)) return sendJSON(res, 400, { error: 'unsupported file type' });
      const host = String(req.headers.host || '127.0.0.1').split(':')[0];
      const built = this.oo.buildConfig(t.abs, dk, rp, user, host);
      if (!built) return sendJSON(res, 400, { error: 'unsupported file type' });
      return sendJSON(res, 200, { ok: true, config: built.cfg, ext: built.ext, docType: built.docType, key: built.key, dsBase: this.oo.dsBase });
    }
    if (pathname === '/api/office/oo/file' && m === 'GET') {
      const tt = this.oo.verify(query.token);
      if (!tt) return sendJSON(res, 403, { error: 'bad or expired token' });
      const t = this.resolveTarget({ disk: tt.d, path: tt.p, _acl: false }, user);
      if (t.error) return sendJSON(res, t.code || 400, { error: t.error });
      if (!fs.existsSync(t.abs)) return sendJSON(res, 404, { error: 'not found' });
      const ext = path.extname(t.abs).toLowerCase();
      const st = fs.statSync(t.abs);
      res.writeHead(200, {
        'Content-Type': OO_MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(t.abs).pipe(res);
    }
    if (pathname === '/api/office/oo/callback' && (m === 'POST' || m === 'HEAD')) {
      const tk = this.oo.verify(query.token);
      if (!tk) return sendJSON(res, 403, { error: 'bad or expired token' });
      const raw = await readBody(req, 4 * 1024 * 1024).catch(() => Buffer.alloc(0));
      let body = {};
      try { body = JSON.parse(String(raw || '{}')); } catch (e) { body = {}; }
      const st = Number(body.status);
      /* status 2/6 = 可以保存；用 token 内的 disk/path 定位（不依赖内存 session，进程重启也不丢） */
      if ((st === 2 || st === 6) && body.url) {
        const target = this.resolveTarget({ disk: tk.d, path: tk.p, _acl: false }, null);
        if (target.error) return sendJSON(res, 404, { error: target.error });
        const rr = await this.oo.applySave(target.abs, body.url);
        return sendJSON(res, rr.ok ? 200 : 500, { error: rr.ok ? 0 : 1, ...rr });
      }
      return sendJSON(res, 200, { error: 0, status: st });
    }
    /* 轻量 IM：频道 + 消息（增量拉取） */
    if (pathname === '/api/im/state' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const since = Number(query.since) || 0;
      const bucket = this.users || {};
      const usersOf = (uid) => {
        const arr = Array.isArray(bucket) ? bucket : (bucket.users || []);
        return arr.find((u) => String(u.id) === String(uid)) || null;
      };
      return sendJSON(res, 200, this.im.state(since, user, usersOf));
    }
    if (pathname === '/api/im/send' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 256 * 1024);
      let o = {}; try { o = JSON.parse(String(raw || '{}')); } catch (e) { o = {}; }
      const out = this.im.send(String(o.ch || 'general'), user, String(o.text || ''), o.file || null);
      return sendJSON(res, out.error ? 400 : 200, out);
    }
    if (pathname === '/api/im/channel' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 64 * 1024);
      let o = {}; try { o = JSON.parse(String(raw || '{}')); } catch (e) { o = {}; }
      const out = this.im.createChannel(String(o.name || ''), user);
      return sendJSON(res, out.error ? 400 : 200, out);
    }
    /* 可聊天用户列表（普通用户也能读，只暴露非敏感字段） */
    if (pathname === '/api/im/users' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const bucket = this.users || {};
      const arr = Array.isArray(bucket) ? bucket : (bucket.users || []);
      const out = arr.map((u) => ({
        id: String(u.id),
        username: u.username,
        nickname: u.nickname || u.username,
        status: u.status || 'offline',
        bio: u.bio || '',
        avatar: u.avatar || '',
        role: u.role,
        isMe: String(u.id) === String(user.id),
      }));
      return sendJSON(res, 200, { ok: true, users: out });
    }
    /* 打开（或创建）与某人的私聊 */
    if (pathname === '/api/im/dm' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 64 * 1024);
      let o = {}; try { o = JSON.parse(String(raw || '{}')); } catch (e) { o = {}; }
      const peer = String(o.uid || '');
      if (!peer) return sendJSON(res, 400, { error: '缺少对方 id' });
      if (peer === String(user.id)) return sendJSON(res, 400, { error: '不能和自己聊天' });
      const ch = this.im.ensureDm(user.id, peer);
      return sendJSON(res, 200, { ok: true, channel: ch });
    }
    /* 建群 */
    if (pathname === '/api/im/group' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 128 * 1024);
      let o = {}; try { o = JSON.parse(String(raw || '{}')); } catch (e) { o = {}; }
      const out = this.im.createGroup(o.name, o.members, user);
      return sendJSON(res, out.error ? 400 : 200, out);
    }
    /* 联系人关系：读取全部备注/星标/黑名单 */
    if (pathname === '/api/im/contacts' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      return sendJSON(res, 200, { ok: true, rels: this.im.allRels(String(user.id)) });
    }
    /* 更新单个联系人的备注/星标/黑名单/删除 */
    if (pathname === '/api/im/contact' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 32 * 1024);
      let o = {}; try { o = JSON.parse(String(raw || '{}')); } catch (e) { o = {}; }
      const peer = String(o.uid || '');
      if (!peer) return sendJSON(res, 400, { error: '缺少对方 id' });
      const out = this.im.setRel(String(user.id), peer, {
        remark: o.remark, starred: o.starred, blocked: o.blocked, deleted: o.deleted
      });
      return sendJSON(res, 200, out);
    }
    if (pathname === '/api/im/read' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 64 * 1024);
      let o = {}; try { o = JSON.parse(String(raw || '{}')); } catch (e) { o = {}; }
      this.im.markRead(String(o.ch || 'general'), user);
      return sendJSON(res, 200, { ok: true });
    }
    /* GenOffice：格式转换（需虚拟显示，Electron 引擎） */
    if (pathname === '/api/office/go/convert' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 128 * 1024);
      let o = {}; try { o = JSON.parse(String(raw || '{}')); } catch (e) { o = {}; }
      const dk = o.disk || 'public';
      const rp = o.path || '';
      const to = String(o.to || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const ALLOW = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'html', 'csv', 'png'];
      if (!ALLOW.includes(to)) return sendJSON(res, 400, { error: 'unsupported target: ' + to });
      const t = this.resolveTarget({ disk: dk, path: rp }, user);
      if (t.error) return sendJSON(res, t.code || 400, { error: t.error });
      if (!fs.existsSync(t.abs)) return sendJSON(res, 404, { error: 'file not found' });
      /* R15.1：原来写死 /opt/station/fileserver/data/storage/public/_convert。
         换机器/换存储目录后转换产物会写到不存在（或只读）的地方，接口直接 500。
         改为跟随当前公共盘根目录，并做可写兜底。 */
      const outDir = path.join(this.resolvePublicRoot().root, '_convert');
      fs.mkdirSync(outDir, { recursive: true });
      const stem = path.basename(t.abs, path.extname(t.abs));
      const outPath = path.join(outDir, stem + '.' + to);
      const { execFile } = require('child_process');
      const env = Object.assign({}, process.env, { DISPLAY: process.env.GO_DISPLAY || ':77', ELECTRON_DISABLE_SANDBOX: '1' });
      const run = (bin, args) => new Promise((resolve) => {
        execFile(bin, args, { timeout: 150000, env, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => {
          resolve({ err, so: String(so || ''), se: String(se || '') });
        });
      });
      let r;
      if (to === 'png') {
        const pngDir = path.join(outDir, stem + '_png');
        fs.mkdirSync(pngDir, { recursive: true });
        r = await run('/usr/bin/genoffice', ['render', t.abs, '--out', pngDir, '--scale', '2']);
        if (r.err) return sendJSON(res, 500, { error: (r.se || r.err.message || '').slice(0, 300) });
        const pngs = fs.readdirSync(pngDir).filter((f) => f.endsWith('.png'));
        if (!pngs.length) return sendJSON(res, 500, { error: 'no png produced' });
        return sendJSON(res, 200, { ok: true, disk: 'public', path: '_convert/' + stem + '_png/' + pngs[0], pages: pngs.length });
      }
      r = await run('/usr/bin/genoffice', ['convert', t.abs, '--to', to, '--out', outPath, '--force']);
      if (r.err || !fs.existsSync(outPath)) {
        return sendJSON(res, 500, { error: (r.se || (r.err && r.err.message) || 'convert failed').slice(0, 300) });
      }
      const st = fs.statSync(outPath);
      return sendJSON(res, 200, { ok: true, disk: 'public', path: '_convert/' + path.basename(outPath), name: path.basename(outPath), size: st.size });
    }
    /* 最近 Office 文件：扫常见盘 3 层，按 mtime 取最新的若干条 */
    if (pathname === '/api/office/oo/recent' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const limit = Math.min(60, Math.max(4, Number(query.limit) || 24));
      const exts = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.csv', '.rtf']);
      const diskIds = ['public', 'ext:办公', 'ext:数据', 'ext:K1', 'ext:Q21', 'ext:备份'];
      const found = [];
      const deadline = Date.now() + 2500;
      const walk = (dir, disk, rel, depth) => {
        if (found.length > 400 || Date.now() > deadline || depth > 3) return;
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
          if (found.length > 400 || Date.now() > deadline) return;
          if (e.name.startsWith('.') || e.name === 'System Volume Information' || e.name === '$RECYCLE.BIN') continue;
          const abs = path.join(dir, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) { walk(abs, disk, r, depth + 1); continue; }
          const ext = path.extname(e.name).toLowerCase();
          if (!exts.has(ext)) continue;
          if (e.name.charAt(0) === '~') continue;  /* Office 临时锁文件 */
          let st; try { st = fs.statSync(abs); } catch (e2) { continue; }
          found.push({ disk, name: e.name, path: r, size: st.size, mtime: st.mtimeMs, ext: ext.slice(1) });
        }
      };
      for (const dk of diskIds) {
        const t = this.resolveTarget({ disk: dk, path: '', _acl: false }, user);
        if (t.error || !fs.existsSync(t.abs)) continue;
        walk(t.abs, dk, '', 1);
      }
      found.sort((a, b) => b.mtime - a.mtime);
      const disks = this.listDisks(user).map((d) => ({ id: d.id, name: d.name }));
      return sendJSON(res, 200, { ok: true, files: found.slice(0, limit), total: found.length, disks });
    }
    /* 新建一个真正的 Office 文件（复制 DS 自带空白模板），供 /office/ 的"文字/表格/演示"直接使用 */
    if (pathname === '/api/office/oo/new' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 64 * 1024);
      let o = {}; try { o = JSON.parse(String(raw || '{}')); } catch (e) { o = {}; }
      const kind = String(o.kind || 'word');
      const ext = kind === 'cell' ? 'xlsx' : kind === 'slide' ? 'pptx' : 'docx';
      const label = kind === 'cell' ? '表格' : kind === 'slide' ? '演示' : '文档';
      const tplDir = process.env.OO_TEMPLATE_DIR || this.cfg.ooTemplateDir || '/opt/station/onlyoffice/templates';
      const tpl = path.join(tplDir, 'tpl.' + ext);
      /* R15.1：没装 OnlyOffice 模板时不再直接 500 —— 用内置 OOXML 生成器造一个空白文件，
         保证「新建文档/表格/演示」在任何部署下都能用。 */
      let tplBuf = null;
      if (fs.existsSync(tpl)) {
        try { tplBuf = fs.readFileSync(tpl); } catch (e) { tplBuf = null; }
      }
      if (!tplBuf) {
        try {
          const conv = require('./lib/dsoffice/convert');
          const blank = { kind: ext === 'xlsx' ? 'sheet' : ext === 'pptx' ? 'slide' : 'doc',
            title: label, content: ext === 'xlsx' ? { cells: {}, rows: 40, cols: 16 } : ext === 'pptx' ? { slides: [{ title: label, body: '' }] } : { text: '' } };
          tplBuf = ext === 'xlsx' ? conv.xlsxOf(blank) : ext === 'docx' ? conv.docxOf(blank) : null;
        } catch (e) { tplBuf = null; }
        if (!tplBuf && ext === 'pptx') return sendJSON(res, 500, { error: '演示模板需要安装 OnlyOffice 或 LibreOffice（其余类型已支持内置生成）' });
        if (!tplBuf) return sendJSON(res, 500, { error: 'template missing: ' + tpl });
      }
      const disk = o.disk || 'public';
      const dir = String(o.path || '');
      /* 新建文档 = 写操作 → 需要写权限（原来只查读权限） */
      const t = this.resolveTarget({ disk, path: dir, _write: true }, user);
      if (t.error) return sendJSON(res, t.code || 400, { error: t.error });
      if (!fs.existsSync(t.abs) || !fs.statSync(t.abs).isDirectory()) return sendJSON(res, 400, { error: 'target not a directory' });
      const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ').replace(':', '');
      const baseName = label + '-' + stamp;
      let abs = path.join(t.abs, baseName + '.' + ext);
      let i = 2;
      while (fs.existsSync(abs)) abs = path.join(t.abs, baseName + '-' + (i++) + '.' + ext);
      /* 有官方模板就复制模板，没有就用上面内置生成的空白包 */
      if (fs.existsSync(tpl)) fs.copyFileSync(tpl, abs);
      else fs.writeFileSync(abs, tplBuf);
      try { fs.chmodSync(abs, 0o644); } catch (e) {}
      const rel = (dir ? dir.replace(/\/+$/, '') + '/' : '') + path.basename(abs);
      return sendJSON(res, 200, { ok: true, disk, path: rel, name: path.basename(abs), ext });
    }
    if (pathname === '/api/office/oo/forcesave' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 64 * 1024);
      let o = {}; try { o = JSON.parse(String(raw || '{}')); } catch (e) { o = {}; }
      const dk = o.disk || 'public';
      const rp = o.path || '';
      /* 强制保存 = DS 侧会回写这个文件 → 属于写操作 */
      const t = this.resolveTarget({ disk: dk, path: rp, _write: true }, user);
      if (t.error) return sendJSON(res, t.code || 400, { error: t.error });
      if (!fs.existsSync(t.abs)) return sendJSON(res, 404, { error: 'file not found' });
      const st = fs.statSync(t.abs);
      const key = require('crypto').createHash('md5').update(t.abs + ':' + st.mtimeMs + ':' + st.size).digest('hex');
      const r = await this.oo.command('forcesave', key);
      return sendJSON(res, 200, { ok: true, ds: r, key });
    }
    if (pathname === '/api/office/oo/probe' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      let ds = 'unknown';
      try {
        const r = await fetch('http://127.0.0.1:8090/healthcheck', { signal: AbortSignal.timeout(3000) });
        ds = r.ok ? 'ok' : 'http ' + r.status;
      } catch (e) { ds = 'down'; }
      return sendJSON(res, 200, { ok: true, ds, dsBase: this.oo.dsBase, supported: Object.keys(require('./lib/office-oo').OFFICE_EXT) });
    }

    if (pathname === '/api/office/preview' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const dk = query.disk || 'public';
      const rp = query.path || '';
      const t2 = this.resolveTarget({ disk: dk, path: rp }, user);
      if (t2.error) return sendJSON(res, t2.code || 400, { error: t2.error });
      if (!fs.existsSync(t2.abs)) return sendJSON(res, 404, { error: 'file not found' });
      const ext2 = path.extname(t2.abs).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext2)) {
        const ctype = ext2 === '.jpg' || ext2 === '.jpeg' ? 'image/jpeg' : 'image/' + ext2.slice(1);
        res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'private, max-age=600' });
        return res.end(fs.readFileSync(t2.abs));
      }
      if (ext2 === '.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=600' });
        return res.end(fs.readFileSync(t2.abs));
      }
      const md5 = require('crypto').createHash('md5');
      md5.update(t2.abs + ':' + fs.statSync(t2.abs).mtimeMs);
      const h = md5.digest('hex');
      /* R10：只对真正需要转换的 Office 格式动手，其它类型直接 415。
         原来任何文件都会去启动 soffice（压缩包、二进制也喂），白等一分钟再报 500。 */
      const CONVERTIBLE = ['.doc', '.docx', '.docm', '.dot', '.dotx', '.odt', '.rtf', '.wps',
        '.xls', '.xlsx', '.xlsm', '.xlsb', '.ods', '.et',
        '.ppt', '.pptx', '.pptm', '.odp', '.dps'];
      if (!CONVERTIBLE.includes(ext2)) {
        return sendJSON(res, 415, { error: '该格式不支持在线预览，请下载后用本地应用打开', ext: ext2 });
      }
      const od = '/tmp/go-preview';
      fs.mkdirSync(od, { recursive: true });
      const out = path.join(od, h + '.pdf');
      if (!fs.existsSync(out)) {
        const { execFile } = require('child_process');
        const baseName = path.basename(t2.abs, path.extname(t2.abs));
        const loDir = path.join(od, 'lo-' + h);
        /* R10：缓存瘦身（只在真要转换时做，几乎零成本）：
           超过 7 天或总量 >512MB 就把最旧的 PDF 清掉，防止 /tmp 被预览缓存吃满。 */
        try {
          const entries = fs.readdirSync(od)
            .map((f) => { try { const fp = path.join(od, f); return { f, fp, st: fs.statSync(fp) }; } catch { return null; } })
            .filter(Boolean);
          const now2 = Date.now();
          let total = 0;
          for (const e of entries) total += e.st.size;
          for (const e of entries) {
            const tooOld = !e.st.isDirectory() && now2 - e.st.mtimeMs > 7 * 24 * 3600 * 1000;
            if (tooOld || total > 512 * 1024 * 1024) {
              try { fs.rmSync(e.fp, { recursive: true, force: true }); total -= e.st.size; } catch {}
            }
          }
        } catch {}
        /* 兜底：清掉 1 天前的孤儿配置目录（进程被 kill 时来不及走下面的 cleanProf）。 */
        try {
          const now3 = Date.now();
          for (const f of fs.readdirSync('/tmp')) {
            if (!f.startsWith('lo-prof-')) continue;
            try {
              const st3 = fs.statSync('/tmp/' + f);
              if (st3.isDirectory() && now3 - st3.mtimeMs > 24 * 3600 * 1000) {
                fs.rmSync('/tmp/' + f, { recursive: true, force: true });
              }
            } catch {}
          }
        } catch {}
        /* R10：soffice 的 -env:UserInstallation 每次都会新建一个 ~290KB 的配置目录，
           原来只清了输出目录，配置目录从没人删（慢性磁盘泄漏）。这里显式清干净。 */
        const profDir = '/tmp/lo-prof-' + h;
        const cleanProf = () => { try { fs.rmSync(profDir, { recursive: true, force: true }); } catch {} };
        const job = () => new Promise((resolve) => {
          try { fs.rmSync(loDir, { recursive: true, force: true }); } catch {}
          fs.mkdirSync(loDir, { recursive: true });
          execFile('/usr/bin/soffice', ['--headless', '--norestore', '-env:UserInstallation=file://' + profDir, '--convert-to', 'pdf', '--outdir', loDir, t2.abs],
            { timeout: 300000, maxBuffer: 8 * 1024 * 1024, env: Object.assign({}, process.env, { HOME: '/home/tokenllm' }) },
            (err) => { cleanProf(); resolve(err || null); });
        });
        /* R10：串行队列。本机 i5-6200U 只有 2 核 4 线程，soffice 自己就会开多线程；
           两个文档并发转换会把 CPU 抢干净，两边一起超时。这里全局只允许一个转换在跑，
           后来的请求排队等前一个结束（超时上限 300 秒，覆盖 3.3MB 复杂表格）。 */
        this._loQueue = (this._loQueue || Promise.resolve()).then(job, job);
        const cerr = await this._loQueue;
        try {
          if (cerr) {
            /* R10：失败必须清临时目录 —— 原来只在成功分支 rm，
               一次大文件超时就在 /tmp/go-preview 留下一个 lo-<hash>/。 */
            try { fs.rmSync(loDir, { recursive: true, force: true }); } catch {}
            return sendJSON(res, 500, {
              error: 'libreoffice 转换失败（文档可能过大或已损坏）',
              detail: String(cerr && cerr.message || cerr).slice(0, 200),
            });
          }
          const produced = path.join(loDir, baseName + '.pdf');
          if (!fs.existsSync(produced)) {
            try { fs.rmSync(loDir, { recursive: true, force: true }); } catch {}
            return sendJSON(res, 500, { error: '转换没有产出文件（文档可能已损坏）' });
          }
          fs.renameSync(produced, out);
          try { fs.rmSync(loDir, { recursive: true, force: true }); } catch {}
        } catch (e) {
          try { fs.rmSync(loDir, { recursive: true, force: true }); } catch {}
          return sendJSON(res, 500, { error: '转换后处理失败' });
        }
      }
      if (!fs.existsSync(out)) return sendJSON(res, 500, { error: 'convert produced no file' });
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=300' });
      return res.end(fs.readFileSync(out));
    }

    /* profile APIs: nickname/avatar/bio/status */
    /* v5 · JEV-System1：联合嵌入向量决策（不生成文本，毫秒级） */
    if ((pathname === '/api/ai/systemone' || pathname === '/v1/systemone') && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 512 * 1024);
      let o; try { o = JSON.parse(String(raw || '{}')); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const out = await this.jev.decideAsync(String(o.query || ''), Array.isArray(o.options) ? o.options : [], {
        temperature: o.temperature, context: Array.isArray(o.context) ? o.context : [],
      });
      if (out.error) return sendJSON(res, 400, out);
      return sendJSON(res, 200, out);
    }
    if (pathname === '/api/ai/systemone/feedback' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req, 256 * 1024);
      let o; try { o = JSON.parse(String(raw || '{}')); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const out = this.jev.feedback(String(o.query || ''), Array.isArray(o.options) ? o.options : [], Number(o.chosen));
      return sendJSON(res, out.ok ? 200 : 400, out);
    }
    if (pathname === '/api/ai/systemone/stats' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      return sendJSON(res, 200, this.jev.stats());
    }

    if (pathname === '/api/me/profile' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      return sendJSON(res, 200, { profile: { username: user.username, nickname: user.nickname || user.username, avatar: user.avatar || null, bio: user.bio || '', status: user.status || 'online' } });
    }
    if (pathname === '/api/me/profile' && m === 'PUT') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req);
      let o; try { o = JSON.parse(String(raw || '{}')); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      if (o.nickname !== undefined) user.nickname = String(o.nickname).slice(0, 24);
      if (o.bio !== undefined) user.bio = String(o.bio).slice(0, 140);
      if (o.status !== undefined && ['online','busy','away','dnd'].includes(String(o.status))) user.status = String(o.status);
      this.users.save();
      return sendJSON(res, 200, { ok: true, profile: { username: user.username, nickname: user.nickname || user.username, avatar: user.avatar || null, bio: user.bio || '', status: user.status || 'online' } });
    }
    if (pathname === '/api/me/avatar' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: 'need login' });
      const raw = await readBody(req);
      let o; try { o = JSON.parse(String(raw || '{}')); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const b64 = String(o.dataUrl || '').replace(/^data:image\/(png|jpeg|webp);base64,/, '');
      if (!b64) return sendJSON(res, 400, { error: 'no image' });
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 2 * 1024 * 1024) return sendJSON(res, 413, { error: 'too large (max 2MB)' });
      const dir = path.join(this.cfg.dataDir, 'avatars');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, user.id + '.png'), buf);
      user.avatar = '/api/me/avatar/' + user.id + '.png';
      this.users.save();
      return sendJSON(res, 200, { ok: true, avatar: user.avatar });
    }
    if (pathname.startsWith('/api/me/avatar/') && m === 'GET') {
      const aid = pathname.slice('/api/me/avatar/'.length).replace(/\.png$/, '');
      const af = path.join(this.cfg.dataDir, 'avatars', aid + '.png');
      if (!fs.existsSync(af)) return sendJSON(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(af));
    }

    if (pathname === '/api/admin/disks' && m === 'GET') {
      if (!adminOnly()) return;
      const all = this.listDisks(user);
      return sendJSON(res, 200, { disks: all.map((d) => ({ id: d.id, name: d.name, kind: d.kind, hidden: this.diskVis.isHidden(d.id) })) });
    }
    if (pathname === '/api/admin/disks/visibility' && m === 'POST') {
      if (!adminOnly()) return;
      const raw = await readBody(req);
      let o; try { o = JSON.parse(String(raw || '{}')); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
      const diskId = String(o.diskId || '');
      if (!diskId) return sendJSON(res, 400, { error: 'diskId required' });
      if (diskId === 'public' || diskId === 'private') return sendJSON(res, 400, { error: 'builtin disk cannot be hidden' });
      const hidden = this.diskVis.set(diskId, !!o.hidden, user.username);
      return sendJSON(res, 200, { ok: true, diskId, hidden });
    }

    if (pathname === '/api/admin/overview' && m === 'GET') {
      if (!adminOnly()) return;
      const disks = this.listDisks(null).map((d) => {
        let total = d.quota || 0, free = d.free || 0;
        try {
          if (d.kind === 'builtin') { const s = fs.statfsSync(this.resolvePublicRoot().root); total = s.blocks * s.bsize; free = s.bavail * s.bsize; }
        } catch (e) {}
        const usedPct = total ? Math.round(((total - free) / total) * 100) : 0;
        return { id: d.id, name: d.name, total, free, usedPct, level: usedPct >= 95 ? 'red' : usedPct >= 80 ? 'yellow' : 'ok' };
      });
      const users = this.users.users.map((u) => this.users.publicUser(u));
      return sendJSON(res, 200, {
        uptime: Math.round(process.uptime()),
        users: { total: users.length, disabled: users.filter((u) => u.disabled).length, admins: users.filter((u) => u.role === 'admin').length },
        counts: { shares: this.sharesLoad().length, jobs: this.jobsLoad().length, keys: this.keysLoad().length },
        disks,
        services: this.svcs || {},
        auditTail: this.readAudit(60),
      });
    }

    if (pathname === '/api/admin/users/create' && m === 'POST') {
      if (!adminOnly()) return;
      const body = await readBody(req, 16 * 1024);
      const { username, password, role } = JSON.parse(body.toString('utf8') || '{}');
      /* R9：异步 scrypt + 口令下限 10（与注册端点一致）。
         同步 scrypt 会独占事件循环 ~100ms，管理员批量建号时会卡住全站。 */
      const r = await this.users.createAsync(String(username || ''), String(password || ''), { minLength: 10 });
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      if (role === 'admin') r.user.role = 'admin';
      this.users.save();
      /* 新账号自动进 users 组，否则收紧后的 ACL 下它登录后什么都看不到 */
      if (r.user.role !== 'admin') this.aclEnsureGroupMember(r.user.username, 'users');
      this.audit({ userObj: user, action: 'admin-user-create', detail: r.user.username + (role === 'admin' ? ' (admin)' : ''), ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true, user: this.users.publicUser(r.user) });
    }

    if (pathname === '/api/admin/users/setpass' && m === 'POST') {
      if (!adminOnly()) return;
      const body = await readBody(req, 16 * 1024);
      const { username, password } = JSON.parse(body.toString('utf8') || '{}');
      const u = this.users.findByName(String(username || ''));
      if (!u) return sendJSON(res, 404, { error: '用户不存在' });
      if (String(password || '').length < 10) return sendJSON(res, 400, { error: '密码长度需为 10-128 位' });
      u.salt = crypto.randomBytes(16).toString('hex');
      /* R9：异步 scrypt —— 同步版独占事件循环 50-150ms，
         管理员改密时整站（WebDAV / SSE / 静态资源）都会卡一下。 */
      u.hash = await hashPasswordAsync(String(password), u.salt);
      this.users.save();
      /* R7-7-1：重置口令后必须踢掉该用户全部会话 ——
         否则「因口令泄漏而重置」这个动作毫无意义：攻击者的旧会话还能用满 7 天。
         与 disable/delete 路径同一处理（补上原先遗漏的一处）。 */
      let kicked = 0;
      for (const [sid, s] of [...this.sessions.sessions]) {
        if (s.userId === u.id) { this.sessions.destroy(sid); kicked++; }
      }
      this.audit({ userObj: user, action: 'admin-user-setpass', detail: u.username + (kicked ? '（已注销 ' + kicked + ' 个会话）' : ''), ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true, sessionsRevoked: kicked });
    }

    if (pathname === '/api/admin/users/toggle' && m === 'POST') {
      if (!adminOnly()) return;
      const body = await readBody(req, 16 * 1024);
      const { username, disabled } = JSON.parse(body.toString('utf8') || '{}');
      const u = this.users.findByName(String(username || ''));
      if (!u) return sendJSON(res, 404, { error: '用户不存在' });
      if (u.role === 'admin' && disabled) return sendJSON(res, 400, { error: '不能禁用管理员账号' });
      if (u.username === 'dav') return sendJSON(res, 400, { error: 'dav 是系统桥接专用账号（Z:/SMB/WebDAV 凭据），不允许禁用' });
      if (user.username === u.username && disabled) return sendJSON(res, 400, { error: '不能禁用自己' });
      u.disabled = !!disabled;
      this.users.save();
      /* 禁用即踢下线：销毁该用户全部会话 */
      if (u.disabled) {
        for (const [sid, s] of [...this.sessions.sessions]) {
          if (s.userId === u.id) this.sessions.destroy(sid);
        }
      }
      this.audit({ userObj: user, action: u.disabled ? 'admin-user-disable' : 'admin-user-enable', detail: u.username, ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true, disabled: u.disabled });
    }

    if (pathname === '/api/admin/users/delete' && m === 'POST') {
      if (!adminOnly()) return;
      const body = await readBody(req, 16 * 1024);
      const { username } = JSON.parse(body.toString('utf8') || '{}');
      const u = this.users.findByName(String(username || ''));
      if (!u) return sendJSON(res, 404, { error: '用户不存在' });
      if (u.role === 'admin') return sendJSON(res, 400, { error: '管理员账号不允许通过后台删除（可禁用）' });
      if (u.username === 'dav') return sendJSON(res, 400, { error: 'dav 是系统桥接专用账号（Z:/SMB/WebDAV 凭据），不允许删除' });
      if (user.username === u.username) return sendJSON(res, 400, { error: '不能删除自己' });
      this.users.users = this.users.users.filter((x) => x.id !== u.id);
      this.users.reindex();
      this.users.save();
      for (const [sid, s] of [...this.sessions.sessions]) {
        if (s.userId === u.id) this.sessions.destroy(sid);
      }
      this.audit({ userObj: user, action: 'admin-user-delete', detail: u.username, ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/shares' && m === 'GET') {
      if (!adminOnly()) return;
      return sendJSON(res, 200, {
        shares: this.sharesLoad().map((s) => ({ ...s, url: '/s/' + s.token })),
      });
    }

    if (pathname === '/api/admin/audit' && m === 'GET') {
      if (!adminOnly()) return;
      return sendJSON(res, 200, { items: this.readAudit(Math.min(+query.limit || 300, 2000)) });
    }

    /* ----- 共享链接 ----- */
    if (pathname === '/api/shares' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const list = this.sharesLoad().filter((s) => s.createdBy === user.username);
      return sendJSON(res, 200, { shares: list.map((s) => ({ ...s, url: '/s/' + s.token })) });
    }
    if (pathname === '/api/shares' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { disk, path: relPath, mode, hours, password, maxHits } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.resolveTarget({ disk: disk || 'public', path: relPath || '' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const list = this.sharesLoad();
      const s = {
        id: crypto.randomBytes(6).toString('hex'),
        token: crypto.randomBytes(9).toString('base64url'),
        disk: t.disk, path: relPath || '',
        mode: mode === 'write' ? 'write' : 'read',
        password: password ? crypto.createHash('sha256').update(password).digest('hex') : '',
        expires: hours ? Date.now() + hours * 3600e3 : 0,
        maxHits: maxHits || 0,
        hits: 0,
        createdBy: user.username,
        createdAt: Date.now(),
      };
      list.push(s);
      this.sharesSave(list);
      this.audit({ userObj: user, action: 'share', disk: s.disk, path: relPath, ip: req.socket.remoteAddress, detail: s.mode });
      return sendJSON(res, 200, { ok: true, url: '/s/' + s.token, token: s.token });
    }
    if (pathname === '/api/shares/delete' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      this.sharesSave(this.sharesLoad().filter((s) => s.id !== id));
      return sendJSON(res, 200, { ok: true });
    }
    // 免登录访问共享（/api/s/<token>/list | /download）
    if (pathname.startsWith('/api/s/')) {
      const parts = pathname.split('/');
      const token = parts[3];
      const act = parts[4];
      const s = this.shareFind(token);
      if (!s) return sendJSON(res, 404, { error: '链接无效或已过期' });
      if (s.password && query.pw !== s.password &&
          crypto.createHash('sha256').update(String(query.pw || '')).digest('hex') !== s.password) {
        return sendJSON(res, 401, { error: '需要密码', needPassword: true });
      }
      const t = this.resolveTarget({ disk: s.disk, path: '', _acl: false }, null);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const base = s.path ? path.join(t.root, s.path) : t.root;
      if (act === 'list') {
        const sub = (query.path || '').replace(/^\/+/, '');
        const target = this.storage.safeResolve(base, sub);
        if (!target) return sendJSON(res, 400, { error: '非法路径' });
        let st = null;
        try { st = fs.statSync(target); } catch (e) { return sendJSON(res, 404, { error: '不存在' }); }
        if (st.isFile()) return sendJSON(res, 200, { file: { name: path.basename(target), size: st.size } });
        const entries = this.storage.list(target);
        this.shareHit(s);
        return sendJSON(res, 200, { entries, mode: s.mode });
      }
      if (act === 'download') {
        const target = this.storage.safeResolve(base, (query.path || '').replace(/^\/+/, ''));
        if (!target) return sendJSON(res, 400, { error: '非法路径' });
        let st = null;
        try { st = fs.statSync(target); } catch (e) { return sendJSON(res, 404, { error: '不存在' }); }
        if (st.isDirectory()) return sendJSON(res, 400, { error: '目录请用打包下载' });
        this.shareHit(s);
        const name = path.basename(target);
        const total = st.size;
        const baseHeaders = {
          'Content-Disposition': contentDisposition(name),
          'Accept-Ranges': 'bytes',
          'Content-Type': mimeOf(name),
        };
        const range = req.headers.range;
        if (range) {
          const mm = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (mm) {
            let start = mm[1] === '' ? null : parseInt(mm[1], 10);
            let end = mm[2] === '' ? null : parseInt(mm[2], 10);
            if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1; }
            else if (start !== null && end === null) { end = total - 1; }
            if (start !== null && end !== null && start >= 0 && end < total && start <= end) {
              res.writeHead(206, {
                ...baseHeaders,
                'Content-Length': end - start + 1,
                'Content-Range': `bytes ${start}-${end}/${total}`,
              });
              return fs.createReadStream(target, { start, end, highWaterMark: 1 << 20 }).pipe(res);
            }
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            return res.end();
          }
        }
        res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
        fs.createReadStream(target, { highWaterMark: 1 << 20 }).pipe(res);
        return;
      }
      return sendJSON(res, 400, { error: '未知操作' });
    }

    /* ----- 定时任务 ----- */
    if (pathname === '/api/jobs' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, { jobs: this.jobsLoad() });
    }
    if (pathname === '/api/jobs' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { name, type, srcDisk, srcPath, dstDisk, dstPath, schedule, keep } = JSON.parse(body.toString('utf8') || '{}');
      const list = this.jobsLoad();
      const job = {
        id: crypto.randomBytes(5).toString('hex'),
        name: name || (type === 'snapshot' ? '快照任务' : type === 'scrub' ? '巡检任务' : '同步任务'),
        type: type || 'mirror',
        srcDisk: srcDisk || 'public', srcPath: srcPath || '',
        dstDisk: dstDisk || 'public', dstPath: dstPath || '',
        schedule: schedule || 'daily',
        keep: Number(keep) || 7,
        lastRun: 0, lastStatus: '',
        createdBy: user.username,
      };
      list.push(job);
      this.jobsSave(list);
      this.audit({ userObj: user, action: 'job-create', detail: job.name, ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true, job });
    }
    if (pathname === '/api/jobs/run' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      const job = this.jobsLoad().find((x) => x.id === id);
      if (!job) return sendJSON(res, 404, { error: '任务不存在' });
      const r = await this.jobRun(job);
      const list = this.jobsLoad();
      const j = list.find((x) => x.id === id);
      if (j) { j.lastRun = Date.now(); j.lastStatus = r.ok ? `复制 ${r.copied}（跳过 ${r.skipped}）` : '失败：' + r.error; }
      this.jobsSave(list);
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/jobs/delete' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      this.jobsSave(this.jobsLoad().filter((x) => x.id !== id));
      return sendJSON(res, 200, { ok: true });
    }

    /* ----- 健康检查 -----
       R1-1-2：系统指标（Node 版本/内存/磁盘容量）只对登录用户开放。
       局域网内任意设备 curl /api/health 即可侦察，属免费情报。 */
    if (pathname === '/api/health' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, this.health());
    }

    /* ----- API Key ----- */
    if (pathname === '/api/keys' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, { keys: this.keysLoad().filter((k) => k.owner === user.username) });
    }
    if (pathname === '/api/keys' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const body = await readBody(req, 64 * 1024);
      const { name } = JSON.parse(body.toString('utf8') || '{}');
      const list = this.keysLoad();
      const k = {
        id: crypto.randomBytes(4).toString('hex'),
        name: name || 'API Key',
        token: crypto.randomBytes(14).toString('base64url'),
        owner: user.username,
        createdAt: Date.now(),
      };
      list.push(k);
      this.keysSave(list);
      return sendJSON(res, 200, { ok: true, key: k });
    }
    if (pathname === '/api/keys/delete' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const body = await readBody(req, 64 * 1024);
      const { id } = JSON.parse(body.toString('utf8') || '{}');
      this.keysSave(this.keysLoad().filter((k) => k.id !== id || k.owner !== user.username));
      return sendJSON(res, 200, { ok: true });
    }

    /* ----- 全文检索 ----- */
    if (pathname === '/api/index/build' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const roots = [{ dir: this.resolvePublicRoot().root, name: '公共盘' }];
      for (const e of this.scanExternal()) roots.push({ dir: e.root, name: e.label.slice(0, 4) });
      const r = await this.indexBuild(roots);
      return sendJSON(res, 200, r);
    }
    if (pathname === '/api/search-content' && m === 'GET') {
      /* R2-2-13：全文索引含文本文件内容片段，匿名可查属信息泄漏 → 要求登录
         （前端 panelSearch 在系统面板内，登录态使用，不受影响） */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const q = (query.q || '').trim();
      if (!q) return sendJSON(res, 400, { error: '缺少关键词' });
      return sendJSON(res, 200, this.searchContent(q));
    }

    /* ----- 去重 ----- */
    if (pathname === '/api/dedup/scan' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const t = this.resolveTarget({ disk: query.disk, scope: query.scope, path: '' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const groups = this.dedupScan(t.root);
      return sendJSON(res, 200, {
        ok: true,
        groups: groups.slice(0, 200),
        waste: groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0),
        hardlink: this.health().hardlink,
      });
    }
    if (pathname === '/api/dedup/link' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 1024 * 1024);
      const { disk, files } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.resolveTarget({ disk, path: '' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      // files[0] 保留，其余替换为硬链接
      if (!Array.isArray(files) || files.length < 2) return sendJSON(res, 400, { error: '至少两个文件' });
      /* R2-2-5（P1）：原实现 path.join(root, files[i]) 未过 safeResolve ——
         files[i] 含 '..' 即可 unlink 任意路径（越权删除）。全部改走 safeResolve。 */
      const safeFiles = files.map((f) => this.storage.safeResolve(t.root, String(f)));
      if (safeFiles.some((p) => !p)) return sendJSON(res, 400, { error: '非法路径' });
      let done = 0;
      const keep = safeFiles[0];
      for (let i = 1; i < safeFiles.length; i++) {
        const f = safeFiles[i];
        try {
          fs.unlinkSync(f);
          fs.linkSync(keep, f);
          done++;
        } catch (e) {}
      }
      this.audit({ userObj: user, action: 'dedup', disk, path: files[0], ip: req.socket.remoteAddress, detail: 'link ' + done });
      return sendJSON(res, 200, { ok: true, linked: done });
    }

    /* ----- 媒体元数据 ----- */
    if (pathname === '/api/meta' && m === 'GET') {
      const t = this.resolveTarget(query, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      try {
        if (!fs.statSync(t.abs).isFile()) return sendJSON(res, 400, { error: '不是文件' });
      } catch (e) { return sendJSON(res, 404, { error: '不存在' }); }
      return sendJSON(res, 200, { meta: this.metaOf(t.abs) });
    }

    /* ================= v3 扩展：安全 / 运维 / 智能 ================= */

    /* ----- ACL 与用户组 ----- */
    if (pathname === '/api/acl' && m === 'GET') {
      /* R9：原来任何登录用户都能读走全部用户名单 + ACL 配置。
         用户名是后续撞库/社工的第一手素材，ACL 配置本身也是攻击面地图。 */
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      if (!this.isAdmin(user)) return sendJSON(res, 403, { error: '需要管理员权限' });
      return sendJSON(res, 200, { data: aclStore.loadAcl(this), users: this.users.users.map((u) => u.username) });
    }
    if (pathname === '/api/acl' && m === 'POST') {
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: '需要管理员权限' });
      const body = await readBody(req, 256 * 1024);
      const { data } = JSON.parse(body.toString('utf8') || '{}');
      if (!data || typeof data !== 'object') return sendJSON(res, 400, { error: '数据格式不对' });
      aclStore.saveAcl(this, data);
      this.audit({ userObj: user, action: 'acl-save', ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true });
    }

    /* ----- 配额 ----- */
    if (pathname === '/api/quota' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const qcfg = quotaStore.loadQuotaCfg(this);
      const disks = this.listDisks(null).map((d) => {
        const th = quotaStore.checkDiskThreshold(this, d.id);
        return { id: d.id, name: d.name, usedPct: th.usedPct, level: th.level };
      });
      return sendJSON(res, 200, { cfg: qcfg, disks });
    }
    if (pathname === '/api/quota' && m === 'POST') {
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: '需要管理员权限' });
      const body = await readBody(req, 64 * 1024);
      const { username, mb } = JSON.parse(body.toString('utf8') || '{}');
      const r = quotaStore.setUserQuota(this, user, String(username || ''), Number(mb) || 0);
      this.audit({ userObj: user, action: 'quota-set', detail: username + '=' + mb, ip: req.socket.remoteAddress });
      return sendJSON(res, 200, { ok: true, r });
    }

    /* ----- 目录快照（硬链接增量） ----- */
    /* R9：原来这四个端点全部传 _acl:false 旁路 ACL —— 等于「登录即可对任意盘符
       （含外置硬盘）做快照/还原/巡检/自动分类」。而 classify 的 apply 会**搬动文件**，
       是一次真实的写操作，却完全不受 ACL 约束。现在统一走 ACL：
       读操作要求读权限，写操作要求写权限。 */
    if (pathname === '/api/snapshots' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const t = this.resolveTarget({ disk: query.disk, path: '' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      return sendJSON(res, 200, { snapshots: snapshots.listSnapshots(this, t.disk) });
    }
    if (pathname === '/api/snapshots' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { disk, action, name, path: relPath, keep } = JSON.parse(body.toString('utf8') || '{}');
      const t = this.resolveTarget({ disk, path: '', _write: true }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      if (action === 'restore') {
        const r = await snapshots.restoreSnapshot(this, t.disk, String(name || ''), user, { path: relPath || '' });
        this.invalidateSizeCache();
        Promise.resolve(this.notifier.send('snapshot', '快照恢复', t.disk + ' ← ' + name)).catch(() => {});
        return sendJSON(res, r.ok ? 200 : 400, r);
      }
      const r = await snapshots.snapshotDisk(this, t.disk, user, { keep: Number(keep) || 7 });
      Promise.resolve(this.notifier.send('snapshot', '快照完成', t.disk + ' → ' + (r.name || '') + '（' + (r.entries || 0) + ' 项）')).catch(() => {});
      return sendJSON(res, r.ok ? 200 : 500, r);
    }

    /* ----- 完整性巡检 ----- */
    if (pathname === '/api/scrub' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, { reports: scrubStore.getReports(this) });
    }
    if (pathname === '/api/scrub' && m === 'POST') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const body = await readBody(req, 64 * 1024);
      const { disk, action } = JSON.parse(body.toString('utf8') || '{}');
      // build 会写清单文件（需要写权限），verify 只读（需要读权限）
      const t = this.resolveTarget({ disk, path: '', _write: action === 'build' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      if (action === 'build') {
        const deny = this.requireWrite(user);
        if (deny) return sendJSON(res, deny.code, { error: deny.error });
        const r = await scrubStore.buildManifest(this, t.disk, user);
        return sendJSON(res, r.ok ? 200 : 500, r);
      }
      const r = await scrubStore.verifyManifest(this, t.disk, user);
      if (r.corrupted && r.corrupted.length) {
        Promise.resolve(this.notifier.send('scrubFail', '巡检发现异常', t.disk + '：' + r.corrupted.length + ' 个损坏/缺失')).catch(() => {});
      }
      return sendJSON(res, 200, r);
    }

    /* ----- 自动分类 ----- */
    if (pathname === '/api/classify' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) return sendJSON(res, deny.code, { error: deny.error });
      const body = await readBody(req, 64 * 1024);
      const { disk, action } = JSON.parse(body.toString('utf8') || '{}');
      // plan 只读；apply 会真的搬动文件 → 必须有写权限
      const t = this.resolveTarget({ disk, path: '', _write: action === 'apply' }, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      const plan = await classifyStore.planClassification(this, t.disk, {});
      if (action === 'apply') {
        const r = await classifyStore.applyClassification(this, t.disk, plan, user);
        this.invalidateSizeCache();
        return sendJSON(res, 200, { ok: true, moved: r.moved, failed: r.failed, plan: plan.moves.slice(0, 200) });
      }
      return sendJSON(res, 200, { ok: true, plan: plan.moves.slice(0, 500), skipped: plan.skipped });
    }

    /* ----- 资源监控 ----- */
    if (pathname === '/api/monitor' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      const s = await this.monitor.sample();
      return sendJSON(res, 200, s);
    }

    /* ----- 通知（Webhook 多通道） ----- */
    if (pathname === '/api/notify' && m === 'GET') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' });
      return sendJSON(res, 200, { cfg: this.notifier.loadCfg(), recent: this.notifier.listRecent(20) });
    }
    if (pathname === '/api/notify' && m === 'POST') {
      if (!user || user.role !== 'admin') return sendJSON(res, 403, { error: '需要管理员权限' });
      const body = await readBody(req, 64 * 1024);
      const { data, action, title, msg } = JSON.parse(body.toString('utf8') || '{}');
      if (action === 'test') {
        const r = await this.notifier.test(title || 'NAS 测试通知', msg || '这是一条测试消息');
        return sendJSON(res, 200, { ok: true, r });
      }
      if (data && typeof data === 'object') {
        this.notifier.saveCfg(data);
        this.audit({ userObj: user, action: 'notify-save', ip: req.socket.remoteAddress });
      }
      return sendJSON(res, 200, { ok: true });
    }

    /* ----- 缩略图缓存（前端 Canvas 生成 WebP 上传，服务端存取） ----- */
    if (pathname === '/api/thumbs' && m === 'GET') {
      const key = String(query.key || '');
      if (!/^[0-9a-f]{40}$/.test(key)) return sendJSON(res, 400, { error: '非法 key' });
      const buf = thumbsStore.getThumb(this, key);
      if (!buf) return sendJSON(res, 404, { error: '无缩略图' });
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=604800',
      });
      return res.end(buf);
    }
    if (pathname === '/api/thumbs' && m === 'POST') {
      const deny = this.requireWrite(user);
      if (deny) { await drainRequest(req); return sendJSON(res, deny.code, { error: deny.error }); }
      const key = String(query.key || '');
      if (!/^[0-9a-f]{40}$/.test(key)) { await drainRequest(req); return sendJSON(res, 400, { error: '非法 key' }); }
      const buf = await readBody(req, 256 * 1024);
      const r = thumbsStore.saveThumb(this, key, buf);
      return sendJSON(res, r ? 200 : 400, { ok: !!r });
    }

    /* ----- v3：按需转码（浏览器放不了的格式；需 Termux 安装 ffmpeg，实时流转输出） ----- */
    if (pathname === '/api/transcode' && m === 'GET') {
      const t = this.resolveTarget(query, user);
      if (t.error) return sendJSON(res, t.code, { error: t.error });
      let st = null;
      try { st = fs.statSync(t.abs); } catch { return sendJSON(res, 404, { error: '文件不存在' }); }
      if (!st.isFile()) return sendJSON(res, 400, { error: '不是文件' });
      let ff = null;
      try { ff = require('child_process').spawnSync('ffmpeg', ['-version'], { timeout: 3000 }); } catch (e) {}
      if (!ff || ff.error || ff.status !== 0) {
        return sendJSON(res, 501, { error: '服务器未安装 ffmpeg（Termux 执行: pkg install ffmpeg）' });
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': contentDisposition(path.basename(t.abs, path.extname(t.abs)) + '.720p.mp4'),
      });
      const child = require('child_process').spawn('ffmpeg', [
        '-threads', '2', '-i', t.abs,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-vf', 'scale=-2:720',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.pipe(res);
      child.on('error', () => { try { res.destroy(); } catch {} });
      res.on('close', () => { try { child.kill('KILL'); } catch {} });
      this.audit({ userObj: user, action: 'transcode', disk: t.disk, path: query.path || '', ip: req.socket.remoteAddress });
      return;
    }

    return sendJSON(res, 404, { error: '接口不存在' });
  }

  /**
   * v4.1：限时分享取件 /s/<token>
   * 权限在「创建链接」那一刻已校验并固化，此处只认 token + 有效期 + 次数。
   */
  async serveShare(req, res, token, query) {
    /* R9：① 传入客户端 IP → 分享按 IP 限速生效（原来任何人都能无限次取件）；
           ② 用 resolve() 返回的 realAbs 开流 —— 它已做 realpath 回校，
              文件被换成符号链接也读不出树外的东西。 */
    const r = this.share.resolve(token, req.socket.remoteAddress);
    if (!r.ok) {
      if (r.rateLimited) {
        res.setHeader('Retry-After', String(Math.ceil((r.retryAfterMs || 1000) / 1000)));
        return sendText(res, 429, '请求过于频繁，请稍后再试');
      }
      return sendText(res, 410, '链接不可用：' + r.error);
    }
    const l = r.link;
    /* 拿的是 realAbs（已解析符号链接），不存在则文件已被移动/删除 */
    const abs = r.realAbs || l.abs;
    try {
      if (l.isDir) return sendText(res, 400, '目录暂不支持分享下载，请分享其中的文件');
      const st = fs.statSync(abs);
      const name = l.name || path.basename(abs);
      const disp = encodeURIComponent(name);
      const range = req.headers.range;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + disp);
      res.setHeader('Content-Type', mimeOf(abs));
      res.setHeader('Cache-Control', 'no-store');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          const start = m[1] ? Number(m[1]) : 0;
          const end = m[2] ? Number(m[2]) : st.size - 1;
          if (start <= end && end < st.size) {
            res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
            return fs.createReadStream(abs, { start, end, highWaterMark: 1 << 20 }).pipe(res);
          }
        }
      }
      res.writeHead(200, { 'Content-Length': st.size });
      fs.createReadStream(abs, { highWaterMark: 1 << 20 }).pipe(res);
    } catch (e) {
      /* 下载没真正开始（文件已删/不可读）→ 把占用的取件次数还回去，
         否则用户会白白损失一次取件机会。 */
      try { this.share.release(token); } catch (e2) {}
      try { sendText(res, 500, '读取失败'); } catch { /* 已断 */ }
    }
  }

  /** 静态资源（仅 public 目录） */
  /**
   * 静态资源（仅 public 目录）。
   *
   * R15.1 三处增强（都是用户能直接感知的）：
   *   ① **gzip**：public/app 的主 JS 有 845KB，手机走 WiFi 首次打开要等几秒；
   *      文本资源按 Accept-Encoding 压缩后体积降到 ~25%，gzip 结果按
   *      「路径 + mtime + size」缓存，第二次起是内存直出。
   *   ② **ETag / 304**：主界面每次刷新都会重新下载 845KB JS。加了弱 ETag 后，
   *      浏览器带着 If-None-Match 再来就是 304，局域网里几乎瞬开。
   *   ③ **流式发送**：超过 2MB 的文件不再 readFileSync 整个读进内存
   *      （旧实现每次请求都整份进内存，多人同时下载大文件会顶高 RSS）。
   */
  handleStatic(req, res, pathname) {
    /* 折叠重复斜杠：//index.html、///app.js 一律归一，避免出现
       pathname="//" 导致浏览器把 <base> 视作协议相对地址，
       使 src="/xxx.js" 解析成 //xxx.js（跨域）而全部拒绝执行 */
    let p = String(pathname || '/').replace(/\/{2,}/g, '/');
    let rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    if (rel === '') rel = 'index.html';
    let file = path.resolve(this.publicDir, rel);
    /* 目录回退：/v2/ 或 /v2 → /v2/index.html。 */
    try {
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        file = path.join(file, 'index.html');
      }
    } catch { /* 读不了就当普通 404 处理 */ }
    const base = path.resolve(this.publicDir);
    if (file !== base && !file.startsWith(base + path.sep)) {
      return sendText(res, 403, 'Forbidden');
    }
    let stat = null;
    try { stat = fs.statSync(file); } catch { /* 不存在 */ }
    if (!stat || !stat.isFile()) {
      /* 带扩展名的资源缺失就是 404；不带扩展名的路径交给前端路由（hash 路由本身
         不需要，但 /files、/office 这类深链刷新时不该白屏）→ 回 index.html。
         静态子站（/games/、/apps/、/office/、/assets/ …）必须排除：它们下面
         缺文件是真的缺，回落到主界面会把 404 伪装成 200，排查时极具误导性。 */
      const STATIC_NS = /^(?:games|apps|office|assets|vendor|admin|legacy|v2|app|_covers)\//i;
      if (!/\.(?:[a-z0-9]{1,8})$/i.test(rel) && !STATIC_NS.test(rel)
        && fs.existsSync(path.join(this.publicDir, 'index.html'))) {
        file = path.join(this.publicDir, 'index.html');
        try { stat = fs.statSync(file); } catch { stat = null; }
      }
      if (!stat) return sendText(res, 404, 'Not Found');
    }

    const ext = path.extname(file).toLowerCase();
    const mime = mimeOf(file);
    const etag = 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
    const hashed = /(?:[.-][0-9a-zA-Z_-]{8,})\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|webp|svg|avif)$/i.test(file);
    const cacheControl = hashed ? 'public, max-age=31536000, immutable' : 'no-cache';

    /* 条件请求：命中就回 304，连 body 都不用读 */
    const inm = req.headers['if-none-match'];
    if (inm && String(inm).split(/\s*,\s*/).includes(etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
      return res.end();
    }

    /* 真机性能探针注入：仅当请求带 ?perfprobe 且目标是游戏 HTML 时生效。
       动机：手机端开不了 CDP，只能让页面自己把帧率报回来（见 public/games/_perfprobe.js）。
       刻意放在服务端而不改游戏源码 —— 探针可随时摘除，不污染第三方游戏文件。 */
    const wantProbe = /\?[^#]*\bperfprobe=/.test(req.url || '') && /\.html?$/i.test(rel);
    if (wantProbe) {
      const body0 = fs.readFileSync(file);
      let body = body0;
      const probeAbs = path.join(this.publicDir, 'games', '_perfprobe.js');
      if (fs.existsSync(probeAbs)) {
        const tag = '\n<script src="/games/_perfprobe.js"></script>\n';
        const html = body0.toString('utf8');
        const at = html.lastIndexOf('</body>');
        body = Buffer.from(at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag, 'utf8');
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        ETag: etag,
      });
      return res.end(body);
    }

    /* 压缩：只压文本类，且必须有收益（体积 > 1KB） */
    const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|xhtml\+xml|manifest\+json)|image\/svg\+xml)/i;
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const canGzip = acceptsGzip && stat.size > 1024 && COMPRESSIBLE.test(mime) && !/\.(?:zip|gz|br|7z|png|jpe?g|webp|mp4|mp3|woff2?)$/i.test(ext);
    const head = {
      'Content-Type': mime,
      'Cache-Control': cacheControl,
      ETag: etag,
      Vary: 'Accept-Encoding',
    };

    if (canGzip) {
      const hit = this._gzCache.get(file);
      if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
        res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': hit.buf.length });
        return res.end(hit.buf);
      }
      try {
        const raw = fs.readFileSync(file);
        const gz = require('zlib').gzipSync(raw, { level: 6 });
        /* 缓存上限 32 项 / 64MB，避免把内存当磁盘用 */
        if (gz.length < raw.length) {
          this._gzCache.set(file, { buf: gz, size: stat.size, mtimeMs: stat.mtimeMs });
          if (this._gzCache.size > 32) {
            const first = this._gzCache.keys().next().value;
            this._gzCache.delete(first);
          }
          res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
          return res.end(gz);
        }
        res.writeHead(200, { ...head, 'Content-Length': raw.length });
        return res.end(raw);
      } catch (e) {
        /* 压缩失败退回明文（下面继续走普通路径） */
      }
    }

    /* 大文件流式发送；小文件直接读（少一次 fs 打开开销） */
    if (stat.size > 2 * 1024 * 1024) {
      res.writeHead(200, { ...head, 'Content-Length': stat.size });
      const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
      rs.on('error', () => { try { res.destroy(); } catch { /* 已断 */ } });
      return rs.pipe(res);
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { ...head, 'Content-Length': body.length });
    return res.end(body);
  }

  /* --------------------------------- 启动 --------------------------------- */

  /** 用 HTTP/2 兼容模式跑在 TLS 上，未协商 h2 的老设备自动回落 HTTP/1.1 */
  start() {
    const { port, host } = this.cfg;
    /* R9：S3 凭据强度闸门 —— 弱凭据（旧版硬编码的 nas-s3-2026 之类）直接拒绝启动。
       S3 网关的凭据就是**站点管理员身份**（首个 admin），泄漏 = 全站沦陷；
       与其带着弱口令上线，不如起不来（fail-closed）。
       应急放宽：config.json 里 {"station":{"s3":{"allowWeakCredentials":true}}}。 */
    try { this.s3.assertCredentials(); } catch (e) {
      console.error('[s3] 凭据不合规，拒绝启动：', (e && e.message) || e);
      process.exit(1);
    }
    /* R9：启动时清理超过 24h 的缩略图临时文件残留（幂等，lib/thumbs.js 提供）。 */
    try { thumbsStore.initThumbs(this); } catch (e) {}
    /* 请求级兜底：单个请求的异常绝不拖垮整个进程。
       历史上 handle() 内一处 URL 解析异常曾导致进程直接退出。 */
    const handler = (req, res) => {
      /* R9：基础安全响应头。
         只加**不会影响渲染**的几个：
           - nosniff：禁止浏览器猜测 Content-Type（.txt 被当 HTML 执行的老套路）
           - SAMEORIGIN：防点击劫持
           - Referrer-Policy：防止 /s/<token> 分享链接出现在外链的 Referer 里
         CSP 只声明 object-src 与 base-uri —— CSP 是**增量**的，
         未列出的指令等于不限制，所以这两条既生效又不会误伤页面。
         完整 CSP（script-src 哈希/nonce）需要前端源码来算，
         而 public/index.html 是构建产物、源码不在仓库里 → 本轮不做。 */
      try {
        const embedOk = /^(1|true|yes|on)$/i.test(String(process.env.STATION_EMBED_OK || ''));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        /* 默认禁止被别的站点 iframe 嵌入（点击劫持防线）。
           演示/预览时（STATION_EMBED_OK=1）改为「允许被嵌入」：
           平台会把站点放进跨域 iframe，SAMEORIGIN 会让预览直接白屏。
           正式部署请勿设置该变量。 */
        if (!embedOk) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Content-Security-Policy',
          "object-src 'none'; base-uri 'self'" + (embedOk ? '; frame-ancestors *' : ''));
      } catch (e) { /* 头写不进去不影响主流程 */ }
      try {
        const r = this.handle(req, res);
        if (r && typeof r.catch === 'function') {
          r.catch((err) => {
            try { console.error('[req]', req.method, req.url, err && err.message); } catch (e) {}
            try { if (!res.headersSent) sendText(res, 500, '内部错误'); else res.end(); } catch (e) {}
          });
        }
      } catch (err) {
        try { console.error('[req]', req.method, req.url, err && err.message); } catch (e) {}
        try { if (!res.headersSent) sendText(res, 500, '内部错误'); else res.end(); } catch (e) {}
      }
    };

    // 后台维护：回收站过期清理（6h）+ 定时任务巡检（10min）
    setTimeout(() => {
      try {
        const roots = [this.resolvePublicRoot().root];
        for (const e of this.scanExternal()) roots.push(e.root);
        for (const r of roots) { try { this.recyclePurge(r, 30); } catch (e) {} }
      } catch (e) {}
    }, 15000);
    setInterval(() => {
      try {
        const roots = [this.resolvePublicRoot().root];
        for (const e of this.scanExternal()) roots.push(e.root);
        for (const r of roots) { try { this.recyclePurge(r, 30); } catch (e) {} }
      } catch (e) {}
    }, 6 * 3600 * 1000);
    setInterval(() => { try { this.jobsTick(); } catch (e) {} }, 10 * 60 * 1000);

    /* 上传临时文件孤儿清理。
       历史事故：WebDAV PUT 中断时只 unlink 未关写流 → fd 泄漏，
       文件在目录里消失但空间被锁（实测累积 193GB，手机整盘写满、adb 都连不上）。
       这里兜底回收两类残骸：
         ① 启动时 —— 上一进程崩溃/被杀留下的 .davtmp-/.s3part-/.s3tmp-
         ② 运行中（每 6h）—— 超过 24h 的陈旧残骸（正在上传的不会被误删）
       正常上传的临时文件寿命只有秒级，24h 阈值不会碰到活跃传输。

       🔴 必须是**异步**扫描并定期让出事件循环。
       第一版写成同步递归（readdirSync/lstatSync 全树遍历），在手机上直接
       把事件循环堵死几十秒 —— TCP 能连上（内核 accept 队列）但 0 字节响应，
       表现为「服务假死」，实测门户 100% 超时。手机存储文件多、IO 慢，
       同步全树扫描是致命的。这里每处理一批就 await setImmediate 让出。 */
    const sweepUploadTmp = async (startup) => {
      const roots = [this.resolvePublicRoot().root];
      try { for (const e of this.scanExternal()) roots.push(e.root); } catch (e) {}
      const cut = Date.now() - 24 * 3600 * 1000;
      let n = 0, bytes = 0, seen = 0;
      const stack = roots.map((r) => [r, 0]);
      while (stack.length) {
        const [dir, depth] = stack.pop();
        if (depth > 8) continue;
        let names;
        try { names = await fs.promises.readdir(dir); } catch (e) { continue; }
        for (const name of names) {
          if (name === '.recycle' || name === '.versions' || name === '.snapshots') continue;
          const full = path.join(dir, name);
          let st;
          try { st = await fs.promises.lstat(full); } catch (e) { continue; }
          if (st.isDirectory()) { stack.push([full, depth + 1]); continue; }
          /* R11：补上 .uploading-（分片上传 chunk-init 的临时文件名，见 tmpName）。
             之前只认 davtmp/s3part/s3tmp，于是失败的分片上传永久占盘 ——
             实测公共盘根目录里躺着 211MB 的 .uploading-* 残骸。 */
          const isChunkTmp = /^\.uploading-/.test(name);
          if (!isChunkTmp && !/\.(davtmp|s3part|s3tmp)-/.test(name)) continue;
          if (isChunkTmp) {
            /* 又一处 R11 冲突：分片临时文件现在**带位图、可续传**，
               不能再像上一版那样"启动就全删"，否则跨重启的续传被自己杀掉。
               规则：有配对位图且 7 天内动过 → 留（等用户回来接着传）；
               没有位图（旧版残骸）或超过 7 天 → 删，位图跟随临时文件一起删。 */
            const keepMs = 7 * 24 * 3600 * 1000;
            const isMap = /\.map$/.test(name);
            const baseAbs = isMap ? full.slice(0, -4) : full;
            const mapAbs = baseAbs + '.map';
            const hasPair = fs.existsSync(isMap ? baseAbs : mapAbs);
            const fresh = Date.now() - st.mtimeMs < keepMs;
            if (hasPair && fresh) continue;                       // 可续传，留着
            if (!startup && st.mtimeMs > cut) continue;           // 运行中：24h 内先不动
          } else if (st.mtimeMs > cut) {
            continue;                                             // 其它类型：24h 规则
          }
          try {
            await fs.promises.unlink(full); n++; bytes += st.size;
            if (process.env.ST_DEBUG_CHUNK) console.log(`[cleanup] 删 ${name} ${st.size}B 龄 ${Math.round((Date.now() - st.mtimeMs) / 1000)}s`);
          } catch (e) {}
        }
        /* 每处理完一个目录就让出事件循环，保证 HTTP 请求不被饿死 */
        if (++seen % 8 === 0) await new Promise((r) => setImmediate(r));
      }
      if (n) {
        try { this.invalidateSizeCache(); } catch (e) {}
        console.log('  [cleanup] 回收上传残骸 ' + n + ' 个 / ' + Math.round(bytes / 1048576) + ' MB');
      }
    };
    /* R11：版本归档保留策略。原来 .versions 只进不出 —— 覆盖写入 / 删除文件都会把
       旧文件存进去，但代码里没有任何清理逻辑（实测 19 个条目就占 82MB，且"永久删除"
       的文件旧版本仍在盘上）。这里给它有进有出：
         · 原文件还在   → 每个文件只保留最近 3 个版本
         · 原文件已删除 → 整个版本目录再留 7 天（留反悔余地），之后回收
         · 顺带清掉变空的目录
       walking 时每处理一批就 await setImmediate 让出，避免大目录把事件循环堵死
       （和 sweepUploadTmp 同样的理由：手机端门户会假死）。 */
    const VERSION_KEEP = 3;
    const VERSION_ORPHAN_MS = 7 * 24 * 3600 * 1000;
    const sweepVersions = async () => {
      const roots = [];
      try { roots.push(this.resolvePublicRoot().root); } catch (e) {}
      try { for (const e of this.scanExternal()) roots.push(e.root); } catch (e) {}
      let files = 0, dirs = 0, freed = 0;
      for (const root of roots) {
        const vRoot = path.join(root, '.versions');
        let vst = null;
        try { vst = await fs.promises.stat(vRoot); } catch (e) { continue; }
        if (!vst.isDirectory()) continue;
        const walk = async (dir, depth) => {
          if (depth > 8) return;
          let names = [];
          try { names = await fs.promises.readdir(dir); } catch (e) { return; }
          const subDirs = [], vfiles = [];
          for (const name of names) {
            const full = path.join(dir, name);
            let st2 = null;
            try { st2 = await fs.promises.lstat(full); } catch (e) { continue; }
            if (st2.isDirectory()) subDirs.push(full);
            else vfiles.push({ full, st: st2 });
          }
          if (vfiles.length) {
            const rel = path.relative(vRoot, dir);
            let originIsFile = false;
            try { originIsFile = (await fs.promises.stat(path.join(root, rel))).isFile(); } catch (e) {}
            vfiles.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
            if (originIsFile) {
              for (const f of vfiles.slice(VERSION_KEEP)) {
                try { await fs.promises.unlink(f.full); files++; freed += f.st.size; } catch (e) {}
              }
            } else if (Date.now() - vfiles[0].st.mtimeMs > VERSION_ORPHAN_MS) {
              /* 原文件没了，且超了保留期 —— 整个目录回收 */
              for (const f of vfiles) {
                try { await fs.promises.unlink(f.full); files++; freed += f.st.size; } catch (e) {}
              }
              if (process.env.ST_DEBUG_CHUNK) console.log('[cleanup] 版本归档整目录回收 ' + rel);
              /* 文件删光了还得把目录也删掉 —— 否则留下一个空壳目录，
                 父级的空目录清理轮不到子目录（实测就卡在这）。 */
              try { await fs.promises.rmdir(dir); dirs++; } catch (e) {}
              await new Promise((r) => setImmediate(r));
              return;
            }
          }
          for (const d of subDirs) await walk(d, depth + 1);
          if (dir !== vRoot) {
            try {
              const left = await fs.promises.readdir(dir);
              if (!left.length) { await fs.promises.rmdir(dir); dirs++; }
            } catch (e) {}
          }
          await new Promise((r) => setImmediate(r));
        };
        await walk(vRoot, 0);
      }
      if (files || dirs) {
        console.log('[cleanup] 版本归档回收 ' + files + ' 个文件 / ' + dirs + ' 个空目录 / ' +
          Math.round(freed / 1048576) + ' MB（每文件保留最近 ' + VERSION_KEEP + ' 版）');
      }
    };

    /* 延后到启动 30s 再跑：避开启动高峰（附属服务拉起 + 首次目录扫描） */
    setTimeout(() => {
      sweepUploadTmp(true).catch(() => {});
      sweepVersions().catch(() => {});
    }, 30000);
    setInterval(() => {
      sweepUploadTmp().catch(() => {});
      sweepVersions().catch(() => {});
    }, 6 * 3600 * 1000);

    /* v3：通知看门狗（盘掉线 / 容量阈值 / 只读降级 → Webhook） */
    try { this.notifier.loadCfg(); } catch (e) {}
    const wdTick = () => { try { this.watchdogTick(); } catch (e) {} };
    setTimeout(wdTick, 25000);
    setInterval(wdTick, 5 * 60 * 1000);

    /* v3：限速器（limit.json downloadKBps > 0 时生效） */
    try { this.limiter = createLimiterFromCfg(this); } catch (e) {}

    /* v3：附属协议服务（全部容错启动，端口占用不影响主服务） */
    try {
      new FtpServer(this).listen(2121).catch((e) => console.error('  [FTP] 启动失败:', e.message));
      this.svcs.ftp = 2121;
    } catch (e) { console.error('  [FTP] 启动失败:', e.message); }
    try {
      this.nfs = new NfsServer(this);
      this.nfs.listen({ tcpPort: 2049, udpPort: 2049, mountTcpPort: 42000, mountUdpPort: 42000 });
      this.svcs.nfs = 2049;
    } catch (e) { console.error('  [NFS] 启动失败:', e.message); }
    try { this.dlna.start({}); this.svcs.dlna = true; } catch (e) { console.error('  [DLNA] 启动失败:', e.message); }
    try {
      this.mdns = new MdnsResponder(this);
      this.mdns.start({ hostname: 'nas-k50' });
      this.svcs.mdns = true;
    } catch (e) { console.error('  [mDNS] 启动失败:', e.message); }

    /* R3-5（P1）：无认证/弱认证协议一律跟随 cfg.host（默认 0.0.0.0）暴露。
       这里显式列出暴露面，便于用户判断是否需要改成 bind 127.0.0.1 或关闭某协议。 */
    try {
      if (this.cfg.host === '0.0.0.0' || !this.cfg.host) {
        console.log('  [安全提示] 监听 0.0.0.0，以下服务对局域网可达：');
        console.log('             FTP:2121(匿名只读) · NFS:2049(游客权限,已不导出 private) · DLNA(只读) · rsync:873(只读,限私网) · mDNS:5353(仅发现)');
        console.log('             如需仅本机访问：设置 host: "127.0.0.1"。WebDAV/S3 走主端口并有各自鉴权。');
      }
    } catch { /* 提示失败不影响启动 */ }

    /* R7-7-2：空库时首个注册者自动成为管理员 —— 若服务先于主人注册就暴露在局域网，
       任何能访问该端口的人都能抢先拿到管理员。部署时给出显式提醒。 */
    try {
      if (!this.users || (this.users.count | 0) === 0) {
        console.log('');
        console.log('  ⚠ [首次部署提醒] 当前没有任何账号：**第一个注册的账号将成为管理员**。');
        console.log('     请立刻在本机浏览器打开 http://127.0.0.1:' + port + ' 完成主账号注册，再对外提供服务。');
        console.log('');
      }
    } catch { /* 忽略 */ }

    /* v3：Termux 原生服务（已安装则拉起，未安装静默跳过） */
    try {
      const { spawn } = require('child_process');
      /* rsync daemon（873，模块 public/ext 见 ~/rsyncd.conf，缺配置自动生成） */
      try {
        const home = process.env.HOME || '/data/data/com.termux/files/home';
        const conf = path.join(home, 'rsyncd.conf');
        if (!fs.existsSync(conf)) {
          /* R3-1（P0）：原生成配置为 read only = no 且无 auth users / hosts allow，
             rsync --daemon 默认绑 0.0.0.0:873 → 局域网任意主机可匿名读写 public/ext。
             改为：默认只读 + 仅私网可连；确需写入时由用户显式配置认证。 */
          const lines = ['use chroot = no', 'max connections = 4',
            'hosts allow = 127.0.0.1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16',
            'hosts deny = *',
            'pid file = ' + path.join(this.cfg.dataDir, 'rsyncd.pid'),
            'log file = ' + path.join(this.cfg.dataDir, 'rsyncd.log'), '',
            'lock file = ' + path.join(this.cfg.dataDir, 'rsyncd.lock'), '',
            '# 安全默认：只读 + 仅私网。如需可写，请在模块内加：',
            '#   auth users = <用户名>',
            '#   secrets file = <口令文件(600)>',
            '# 再把 read only 改为 yes(有认证时)',
            '[public]', '    path = ' + this.resolvePublicRoot().root, '    read only = yes', ''];
          for (const e of this.scanExternal()) lines.push('[' + e.label.slice(0, 8) + ']', '    path = ' + e.root, '    read only = yes', '');
          fs.writeFileSync(conf, lines.join('\n'));
        } else {
          /* 用户已有自定义配置：不改文件，但风险提示 */
          try {
            const txt = fs.readFileSync(conf, 'utf8');
            if (/read\s+only\s*=\s*no/i.test(txt) && !/auth\s+users/i.test(txt)) {
              console.warn('  [rsync] 警告：~/rsyncd.conf 有可写模块且未配置 auth users —— 局域网可匿名写入，建议加认证或改 read only = yes');
            }
          } catch { /* 读不到不阻塞 */ }
        }
        spawn('rsync', ['--daemon', '--config=' + conf], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      } catch (e) {}
      /* sshd（Termux 实际监听 8022，SFTP 走同端口）
         R3-10（P2）：不再无条件自动拉起 —— sshd 认证取决于 Termux sshd_config，
         若为弱/空口令等于对外暴露远程 Shell。需要时显式设置 autoSshd: true。 */
      if (this.cfg.autoSshd === true) {
        try { spawn('sshd', [], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch (e) {}
      } else {
        console.log('  [sshd] 未自动拉起（安全默认）。如需 SFTP：设置 autoSshd: true 并确保已配置密钥或强口令。');
      }
    } catch (e) {}

    let server;

    if (this.cfg.tls) {
      this.initTLS();
      server = http2.createSecureServer(
        { key: this.tls.key, cert: this.tls.cert, allowHTTP1: true },
        handler
      );
      server.on('session', (session) => {
        session.settings({ maxConcurrentStreams: 256 });
      });
    } else {
      server = http.createServer(handler);
    }

    // 连接复用：拉长 keep-alive，避免每次传输都重新握手/TLS
    server.keepAliveTimeout = 75 * 1000;
    server.headersTimeout = 80 * 1000;
    /* 🔴 requestTimeout 必须显式放宽，否则用 Node 默认 300s（5 分钟）。
       事故背景（2026-09-20）：rclone 挂载（--vfs-cache-mode writes）上传一个
       5.2GB 固件包，局域网实测吞吐撑不到 5 分钟传完 → 服务端每 5 分钟回 408，
       rclone 无限重试（日志里 "failed to upload try #6, will retry in 5m0s"），
       每次失败都留下一个 .davtmp 残骸，累积 193GB 把手机整盘写满。
       注意 headersTimeout(80s) 只管请求头，**不管 body**；大文件 PUT 的时长
       由 requestTimeout 决定。这里放宽到 30 分钟，覆盖 GB 级慢速上传。
       真正的防线是 lib/dav.js 的失败清理 + sweepUploadTmp，这条只是别误杀。 */
    server.requestTimeout = 30 * 60 * 1000;
    if ('maxRequestsPerSocket' in server) server.maxRequestsPerSocket = 0; // 0 = 不限

    /* 传输性能：关闭 Nagle 算法。局域网小分片传输时，Nagle 会把小包攒起来
       等待 ACK，实测在高延迟 WiFi 上会显著增加传输时间。大文件流式传输
       同样受益（避免 40ms 级延迟累积）。 */
    server.on('connection', (socket) => {
      try { socket.setNoDelay(true); } catch {}
      try { socket.setKeepAlive(true, 30000); } catch {}
    });
    /* 并发连接数上限：手机端资源有限，避免海量连接把内存打满 */
    server.maxConnections = 512;

    // PID 文件
    try {
      const pidFile = path.join(__dirname, 'server.pid');
      fs.writeFileSync(pidFile, String(process.pid));
      const cleanup = () => { try { fs.unlinkSync(pidFile); } catch {} };
      process.on('exit', cleanup);
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    } catch {}

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n[错误] 端口 ${port} 已被占用。`);
        console.error('       换一个端口： PORT=8444 node server.js\n');
        process.exit(1);
      }
      throw err;
    });

    server.listen(port, host, () => {
      const ips = getLocalIPs();
      const line = '='.repeat(56);
      const scheme = this.cfg.tls ? 'https' : 'http';
      console.log('\n' + line);
      console.log('  局域网私有文件服务器已启动 (v2)');
      console.log(line);
      console.log(`  监听地址   : ${host}:${port}`);
      console.log(`  协议       : ${this.cfg.tls ? 'HTTPS' : 'HTTP'}${this.cfg.http2 && this.cfg.tls ? ' + HTTP/2 多路复用' : ''}`);
      console.log(`  本机访问   : ${scheme}://127.0.0.1:${port}`);
      if (ips.length) {
        console.log('  局域网访问 :');
        for (const ip of ips) console.log(`      ${scheme}://${ip}:${port}`);
      }
      if (this.cfg.tls) {
        console.log(`  证书       : ${this.tls.regenerated ? '本次新生成（首次/IP 变化）' : '沿用已有'}，10 年期自签名`);
        console.log('  信任提示   : 浏览器首次访问会告警，点「高级 → 继续访问」即可；');
        console.log('               需免告警可把 data/tls/cert.pem 导入系统受信任根证书');
      }
      console.log(`  存储目录   : ${this.cfg.storageDir}`);
      console.log(`  数据目录   : ${this.cfg.dataDir}`);
      console.log(`  上传上限   : ${this.cfg.maxUploadMB} MB / 次（超过 ${this.cfg.chunkThresholdMB} MB 自动分块）`);
      console.log(`  注册用户   : ${this.users.count}`);
      console.log(`  附属服务   : FTP:2121  NFS:2049(mount:42000)  S3:/s3  API文档:/api/doc`);
      console.log(`             DLNA(SSDP alive)  mDNS(nas-k50.local)  WebDAV:/dav`);
      console.log(`  工作站 v4.1: 实时事件流 /api/events（SSE）· 设备在线 · 任务中心 · 协同板`);
      console.log(`             远程控制 /api/remote/* · 数据同步 /api/sync/* · 限时分享 /s/<token>`);
      console.log(`             设备配对 ${this.pairing.requirePairing ? '【严格模式】' : '（宽松模式）'} · 已信任 ${this.pairing.stats().trusted} 台`);
      console.log(line + '\n');
    });

    /* v4.1：把能力层后台任务挂到主循环上（心跳/超时/失效清理） */
    try { this.hub.start(); this.presence.start(); this.remote.start(); this.share.start(); } catch { /* 非致命 */ }

    const shutdown = () => {
      console.log('\n正在停止服务…');
      /* R9：会话落盘改成了防抖（200ms 窗口），退出时必须强制刷一次，
         否则进程在窗口内被停掉会丢掉刚建立的会话。 */
      try { this.sessions.flush(); } catch (e) {}
      /* 关闭所有未完成的上传会话。
         R11：有位图（可续传）的**必须保留**临时文件与位图 —— 否则重启就把用户
         已经传上去的几百 MB 白扔了（实测：重启后 160MB 临时文件消失，只剩下位图，
         再被清理器当孤儿收走，跨重启续传直接失效）。没位图的仍照旧删掉，
         保持"别留垃圾"的原意。保留的那部分由 7 天清理规则兜底。 */
      for (const [id, up] of this.uploads) {
        try { up.handle.close(); } catch {}
        const resumable = up.mapAbs && fs.existsSync(up.mapAbs);
        if (!resumable) fs.unlink(up.abs, () => {});
        if (process.env.ST_DEBUG_CHUNK) {
          console.log(`[chunk] shutdown ${up.finalName} ${resumable ? '保留（可续传）' : '删除（无位图）'}`);
        }
      }
      this.uploads.clear();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    /* exit 钩子里的 flush 是同步的，安全。SIGKILL 无法捕获 ——
       那种情况下最多丢 200ms 内的会话，用户重新登录即可。 */
    process.on('exit', () => { try { this.sessions.flush(); } catch (e) {} });
  }
}

if (require.main === module) {
  const cfg = loadConfig();
  new FileServer(cfg).start();
}

module.exports = { FileServer, loadConfig };

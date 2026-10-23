'use strict';

const os = require('os');
const crypto = require('crypto');

/** 生成随机十六进制串 */
function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/* 单次解析的 cookie 数量 / 单个值长度上限：畸形请求头不能把解析成本无限放大 */
const MAX_COOKIES = 64;
const MAX_COOKIE_VALUE = 8192;

/**
 * 解析 Cookie 头。
 *
 * R9-UTIL-1：旧实现对每个 cookie 值直接 decodeURIComponent，
 * 遇到畸形百分号编码（'%'、'%zz'、截断的 UTF-8 序列）会抛 URIError ——
 * 而这个函数在请求处理链上，异常一路冒到最外层就是整个请求 500，
 * 一个畸形的 Cookie 头就能把服务打成 500（可被当作 DoS 用）。
 * 现在：逐个 cookie 单独 try/catch，坏的那个跳过，其余照常解析。
 */
function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  const raw = String(header);
  if (raw.length > 64 * 1024) return out;   // 超长 Cookie 头直接放弃（不可能是正常会话）
  let n = 0;
  for (const part of raw.split(';')) {
    if (n >= MAX_COOKIES) break;
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    let v = part.slice(idx + 1).trim();
    if (v.length > MAX_COOKIE_VALUE) v = v.slice(0, MAX_COOKIE_VALUE);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      /* 百分号编码坏了就跳过这一个 cookie：不能因为一个坏 cookie 让整个请求 500 */
      continue;
    }
    n++;
  }
  return out;
}

/** 解析查询串，返回 { key: string } */
function parseQuery(url) {
  const q = url.indexOf('?');
  const out = Object.create(null);
  if (q < 0) return out;
  for (const [k, v] of new URLSearchParams(url.slice(q + 1))) out[k] = v;
  return out;
}

function sendJSON(res, code, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

/**
 * 读取请求体，带大小限制。
 * @returns {Promise<Buffer>} reject 时 err.code = 'PAYLOAD_TOO_LARGE'
 */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 枚举本机可用的局域网 IPv4 地址 */
function getLocalIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed', '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk': 'application/vnd.android.package-archive',
  /* 🔴 WebAssembly 必须是 application/wasm —— 缺这一条会回落成 octet-stream，
     浏览器随即拒绝 WebAssembly.instantiateStreaming()（不是降级，是直接报错）。
     js-dos / Emscripten 一类的 WASM 产物全靠它，且 .wasm 走的是 handleStatic()。 */
  '.wasm': 'application/wasm',
  /* ESM：js-dos 的 emulators 里有 .mjs（如 webrtcnet.mjs），
     必须是 JS MIME 才能被 import 进来。 */
  '.mjs': 'application/javascript; charset=utf-8',
  /* .jsdos 就是 ZIP（内含 .jsdos/dosbox.conf 与游戏文件）。
     js-dos 走 fetch + arrayBuffer 拿它，理论上不看 MIME，
     但按真实类型下发更正确，也让「服务端契约」可被脚本断言。 */
  '.jsdos': 'application/zip',
};

function mimeOf(filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/**
 * 构造 Content-Disposition，兼容中文文件名（RFC 5987）
 * 同时提供 ASCII 回退，保证老浏览器可用。
 */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

module.exports = {
  randomId, parseCookies, parseQuery, sendJSON, sendText,
  readBody, getLocalIPs, formatSize, mimeOf, contentDisposition,
};

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  let fail = 0;
  let pass = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`✓  ${name}`); }
    else { fail++; console.log(`✗  ${name}${extra ? '  →  ' + extra : ''}`); }
  };
  const noThrow = (fn) => { try { fn(); return true; } catch (e) { return e; } };

  try {
    /* ---- 正常解析 ---- */
    const c = parseCookies('sid=abc; theme=dark; name=%E4%B8%AD%E6%96%87');
    check('正常 cookie 解析', c.sid === 'abc' && c.theme === 'dark');
    check('百分号编码被解码', c.name === '中文', String(c.name));
    check('空头返回空对象', Object.keys(parseCookies('')).length === 0);
    check('null 头不抛异常', noThrow(() => parseCookies(null)) === true);

    /* ---- R9-UTIL-1：畸形 Cookie 不得抛 URIError ---- */
    const bad = ['%', 'a=%', 'a=%zz', 'a=%E4', 'a=%E4%B8', '=%', 'a=1; b=%; c=3', 'x=%GG%GG'];
    let threw = null;
    for (const b of bad) {
      const r = noThrow(() => parseCookies(b));
      if (r !== true) { threw = b + ' → ' + (r && r.name) + ': ' + (r && r.message); break; }
    }
    check('畸形 Cookie 不抛异常', threw === null, String(threw));

    const mixed = parseCookies('sid=abc; bad=%zz; theme=dark');
    check('坏 cookie 被跳过', mixed.bad === undefined, String(mixed.bad));
    check('其余 cookie 照常解析', mixed.sid === 'abc' && mixed.theme === 'dark', JSON.stringify(mixed));

    /* 超长输入 */
    const long = 'k=' + 'x'.repeat(200000);
    const rLong = noThrow(() => parseCookies(long));
    check('超长 Cookie 头不抛异常', rLong === true, String(rLong && rLong.message));
    const many = Array.from({ length: 500 }, (_, i) => 'c' + i + '=' + i).join('; ');
    const rMany = noThrow(() => parseCookies(many));
    check('超多 cookie 不抛异常', rMany === true, String(rMany && rMany.message));
    check('超多 cookie 时数量有界', Object.keys(parseCookies(many)).length <= 64, String(Object.keys(parseCookies(many)).length));

    /* ---- 其它工具函数冒烟 ---- */
    check('parseQuery 正常', parseQuery('/a?x=1&y=2').x === '1');
    check('parseQuery 无查询串', Object.keys(parseQuery('/a')).length === 0);
    check('formatSize 正常', formatSize(1024) === '1.0 KB', formatSize(1024));
    check('mimeOf 正常', mimeOf('a.png') === 'image/png');
    check('mimeOf 未知类型', mimeOf('a.zzz') === 'application/octet-stream');
    check('contentDisposition 含中文编码', contentDisposition('测.txt').includes("filename*=UTF-8''"));
    check('randomId 长度正确', randomId(8).length === 16);

    console.log(`\n断言 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
    if (fail) { console.log('自测未通过'); process.exit(1); }
    console.log('自测全部通过');
    process.exit(0);
  } catch (e) {
    console.error('✗  自测异常:', e);
    process.exit(1);
  }
}

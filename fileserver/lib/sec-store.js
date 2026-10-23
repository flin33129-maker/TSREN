'use strict';

/* =====================================================================
   lib/sec-store.js — P0「数据与安全」模块的公共基础设施
   ---------------------------------------------------------------------
   这里只做四件事，全部是为了后面几个 sec-*.js 不重复造轮子：
     1. data/ 下的 JSON 状态文件读写（原子写 + 0600，读失败 fail-open）；
     2. 安全配置的版本化与审计字段（updatedAt / updatedBy）；
     3. 真实客户端 IP 的判定（nginx 反代场景）；
     4. 共用的时间 / 大小格式化。

   设计原则（与 README-TEAM.md 一致）：
     · 任何新状态文件都放 data/，绝不放 public/（不随前端发布、不进 git）；
     · 状态文件读不出来时**不抛异常**，调用方拿到默认值继续工作——
       安全模块自己不能成为全站单点故障；
     · 写盘失败只打日志，不阻断主流程（除密码策略这种必须落盘的除外，
       由调用方自己判断）。
   ===================================================================== */

const fs = require('fs');
const path = require('path');

/* 安全状态文件统一前缀，便于运维一眼认出「这是安全模块的数据」 */
const PREFIX = 'sec-';

function dataDir(app) {
  return (app && app.cfg && app.cfg.dataDir) || path.join(__dirname, '..', 'data');
}

/** data/sec-xxx.json 绝对路径 */
function fileOf(app, name) {
  return path.join(dataDir(app), PREFIX + name + '.json');
}

/** 读 JSON：不存在 / 损坏 / 无权限一律返回 fallback（fail-open） */
function loadJSON(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch {
    return fallback;
  }
}

/** 原子写 JSON：tmp(0600) → rename，避免半截文件让下一次读取失败 */
function saveJSON(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* 某些文件系统不支持 */ }
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* 同上 */ }
    return true;
  } catch (e) {
    console.error('[sec-store] 写入 ' + file + ' 失败：' + ((e && e.message) || e));
    return false;
  }
}

/** 安全状态对象外壳：{ version, updatedAt, updatedBy, ...payload } */
function envelope(payload, who) {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: who || 'system',
    ...payload,
  };
}

/* ------------------------------ 客户端 IP ------------------------------ */

/** 规整 IP：去掉 IPv4-mapped 前缀、去端口、去空白 */
function normalizeIp(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('::ffff:')) s = s.slice(7);
  // [::1]:1234 / 1.2.3.4:80 之类的形式（socket.remoteAddress 不带端口，但 header 里可能带）
  const m = /^\[([0-9a-fA-F:]+)\](?::\d+)?$/.exec(s);
  if (m) return m[1].toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) return s.split(':')[0];
  return s.toLowerCase();
}

function isLoopback(ip) {
  const s = normalizeIp(ip);
  return s === '::1' || s === '127.0.0.1' || /^127\./.test(s);
}

/**
 * 真实客户端 IP。
 *
 * 背景：现网所有网页流量都是 nginx(80/8443) → node(127.0.0.1:8081)，
 * 所以 req.socket.remoteAddress 恒为 127.0.0.1。nginx 在 server 级
 * 设置了 `proxy_set_header X-Real-IP $remote_addr`（会覆盖客户端自带值），
 * 因此：**只有当 TCP 对端是本机回环时**才信任 X-Real-IP；
 * 其它情况（有人直连 8081）一律用 socket 地址，避免伪造头绕过白名单。
 */
function clientIp(req) {
  const peer = normalizeIp(req && req.socket && req.socket.remoteAddress);
  if (isLoopback(peer)) {
    const xr = normalizeIp(req.headers && req.headers['x-real-ip']);
    if (xr) return xr;
    const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0];
    const first = normalizeIp(xff);
    if (first) return first;
  }
  return peer || 'unknown';
}

/** 请求是否经 HTTPS 入口进来（nginx 的 X-Forwarded-Proto） */
function isHttps(req) {
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '').toLowerCase();
  if (proto) return proto.split(',')[0].trim() === 'https';
  // 没有反代头（直连 8081）：只有 TLS socket 才算 https
  return !!(req && req.socket && req.socket.encrypted);
}

/* -------------------------------- 杂项 -------------------------------- */

function nowIso() { return new Date().toISOString(); }

function fmtMB(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return Math.round(n / 1048576 * 10) / 10 + ' MB';
}

/** 截断字符串（审计 detail 列防爆） */
function clip(s, n = 200) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 简单内存缓存：ttl 内同一文件不重复读盘（按文件分槽，多文件互不挤占） */
const _cache = new Map();
function cachedFile(file, fallback, ttlMs = 1500) {
  const now = Date.now();
  const hit = _cache.get(file);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = loadJSON(file, fallback);
  _cache.set(file, { at: now, value });
  if (_cache.size > 32) {
    // 有界：清掉最旧的几个
    const keys = [..._cache.keys()].slice(0, _cache.size - 24);
    for (const k of keys) _cache.delete(k);
  }
  return value;
}

/** 外部写盘后主动失效（避免缓存脏读） */
function invalidate(file) {
  if (file) _cache.delete(file);
  else _cache.clear();
}

module.exports = {
  dataDir, fileOf, loadJSON, saveJSON, envelope,
  normalizeIp, isLoopback, clientIp, isHttps,
  nowIso, fmtMB, clip, cachedFile, invalidate,
};

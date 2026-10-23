'use strict';

/* =====================================================================
   lib/sec-ctx.js — 请求级上下文（AsyncLocalStorage）
   ---------------------------------------------------------------------
   为什么需要它：
     server.js 的扩展路由 ctx 里没有 session id；早先的实现把「当前会话」
     记在 app.__secCurrentSid 这种**进程级全局变量**上 —— 并发请求会互相
     覆盖：A 用户的改密请求可能读到 B 请求写进去的 sid，从而把 A 的
     当前会话当成「其它会话」踢掉（实测出现过一次，表现为改密后自己 401）。
     这里用 AsyncLocalStorage 把 (req, ip, https, sid) 绑到异步调用链上，
     并发请求互不干扰。
   ===================================================================== */

const { AsyncLocalStorage } = require('async_hooks');
const { parseCookies } = require('./util');

const als = new AsyncLocalStorage();

function sidOf(req, app) {
  try {
    const name = (app && app.cfg && app.cfg.sessionCookie) || 'fsid';
    const cookies = parseCookies((req && req.headers && req.headers.cookie) || '');
    return cookies[name] || '';
  } catch {
    return '';
  }
}

/** 在请求上下文里执行 fn */
function run(ctx, fn) {
  return als.run(ctx, fn);
}

function get() {
  return als.getStore() || null;
}

/** 当前请求的会话 id（未登录 / 未经门禁时为空串） */
function sid() {
  const c = get();
  return (c && c.sid) || '';
}

function ip() {
  const c = get();
  return (c && c.ip) || '';
}

/** 为某个 req 组装上下文（IP 由调用方传，避免重复解析） */
function make(app, req, clientIp, https) {
  return { req, ip: clientIp, https: !!https, sid: sidOf(req, app) };
}

module.exports = { run, get, sid, ip, make, sidOf };

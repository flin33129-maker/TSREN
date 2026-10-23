'use strict';

/* =====================================================================
   lib/routes/security-gate.js — 安全门禁（全量预筛，先于业务路由执行）
   ---------------------------------------------------------------------
   为什么单独一个文件：
     有些安全能力必须作用在**所有** /api 请求上，而不是某几个路径：
       · IP 白名单（非白名单 IP 的登录/访问一律拒绝）
       · 应用层强制 HTTPS
       · 口令过期后强制改密（除白名单页面外一律 403）
       · 会话台账（IP / UA / 最后活跃）与审计来源 IP 补强
     扩展路由层按文件名排序挂载，`security-gate.js` 排在 `security.js` 之前；
     prefixes 为空数组 = 每个请求都会问一次（这是刻意的，门禁必须全覆盖）。

   安全底线：
     本模块自身任何异常都 **fail-open**（返回 false 交回原链路）——
       安全模块写错了不能把整个工作站变成不可用。
   ===================================================================== */

const store = require('../sec-store');
const secCtx = require('../sec-ctx');
const ipMod = require('../sec-ip');
const policyMod = require('../sec-policy');
const sessionMod = require('../sec-session-meta');

/* 口令过期后仍然放行的路径（否则用户连改密页面/登录态都拿不到） */
const EXEMPT_WHEN_EXPIRED = new Set([
  '/api/security/status',
  '/api/security/password/change',
  '/api/security/password/check',
  '/api/security/password/policy',
  '/api/security/totp/status',
  '/api/me',
  '/api/login',
  '/api/logout',
]);

/**
 * 只在第一个 API 请求时打补丁：
 *  1) 用 AsyncLocalStorage 包住 app.handleApi —— 请求全链路都能拿到
 *     真实来源 IP 与 session id（并发安全，不互相覆盖）；
 *  2) 包住 app.audit，把 legacy 代码写下的 127.0.0.1 换成真实客户端 IP，
 *     并补 UA —— 这样「登录日志」里不再是清一色 127.0.0.1。
 * 补丁本身失败不影响主流程。
 */
function ensurePatched(app) {
  if (!app || app.__secPatched) return;
  app.__secPatched = true;

  try {
    const orig = app.handleApi;
    if (typeof orig === 'function') {
      app.handleApi = function patchedHandleApi(req, res, pathname, query) {
        let ctx = null;
        try {
          ctx = secCtx.make(app, req, store.clientIp(req), store.isHttps(req));
        } catch { ctx = null; }
        if (!ctx) return orig.call(this, req, res, pathname, query);
        return secCtx.run(ctx, () => orig.call(this, req, res, pathname, query));
      };
    }
  } catch (e) {
    console.error('[sec-gate] handleApi 补丁失败：' + ((e && e.message) || e));
  }

  try {
    const origAudit = app.audit.bind(app);
    app.audit = function patchedAudit(rec) {
      try {
        const ctx = secCtx.get();
        if (rec && ctx) {
          const ip = String(rec.ip || '');
          let next = rec;
          if (!ip || store.isLoopback(ip)) next = { ...next, ip: ctx.ip };
          if (!next.ua && ctx.req && ctx.req.headers) {
            next = { ...next, ua: store.clip(String(ctx.req.headers['user-agent'] || ''), 180) };
          }
          rec = next;
        }
      } catch { /* 补丁失败按原样记录 */ }
      return origAudit(rec);
    };
  } catch (e) {
    console.error('[sec-gate] audit 补丁失败：' + ((e && e.message) || e));
  }
}

/** 被拒访问的审计（同一 IP 30 秒只记一条，防止刷日志把审计写爆） */
function auditDenied(app, req, user, ip, pathname, dec, code) {
  try {
    if (!app.__secDeniedLog) app.__secDeniedLog = new Map();
    const key = ip + '|' + code;
    const now = Date.now();
    const last = app.__secDeniedLog.get(key) || 0;
    if (now - last < 30000) return;
    app.__secDeniedLog.set(key, now);
    if (app.__secDeniedLog.size > 500) {
      for (const [k, ts] of app.__secDeniedLog) if (now - ts > 600000) app.__secDeniedLog.delete(k);
    }
    app.audit({
      action: 'access-denied',
      userObj: user || null,
      user: user ? user.username : 'anonymous',
      ip,
      ok: false,
      detail: code + ' ' + (pathname || '') + ' reason=' + ((dec && dec.reason) || ''),
    });
  } catch { /* 审计失败不影响拒绝 */ }
}

const mod = {
  name: 'security-gate',
  /* 空数组 = 不预筛，所有 /api 请求都经过本门禁（刻意为之） */
  prefixes: [],

  async handle(ctx) {
    try {
      const { app, req, res, pathname, sendJSON, user } = ctx;
      if (!app) return false;
      ensurePatched(app);

      /* 第一个请求尚未被 ALS 包裹：用当前 req 兜底算一次 sid */
      const sid = secCtx.sid() || secCtx.sidOf(req, app);
      if (user && sid) sessionMod.touch(app, sid, user, req);

      const cfg = ipMod.loadConfig(app);
      const ip = secCtx.ip() || store.clientIp(req);

      // ── 1) IP 白名单 ────────────────────────────────────────────────
      const dec = ipMod.decide(app, ip, cfg);
      if (!dec.allowed) {
        auditDenied(app, req, user, ip, pathname, dec, 'IP_BLOCKED');
        sendJSON(res, 403, {
          error: '来源 IP 不在白名单：' + ip
            + '（管理员可在「数据与安全 → IP 白名单」调整；'
            + '应急放开：在服务器上执行 sudo touch /opt/station/fileserver/data/sec-ip-bypass）',
          code: 'IP_BLOCKED',
          ip,
          matched: dec.matched,
          reason: dec.reason,
        });
        return true;
      }

      // ── 2) 应用层强制 HTTPS ─────────────────────────────────────────
      if (cfg.forceHttps && !store.isHttps(req) && !store.isLoopback(ip)) {
        auditDenied(app, req, user, ip, pathname, { reason: 'https-required' }, 'HTTPS_REQUIRED');
        sendJSON(res, 403, {
          error: '已开启强制 HTTPS：请改用 https://<主机>:8443/app/ 访问（当前为明文 http）',
          code: 'HTTPS_REQUIRED',
        });
        return true;
      }

      // ── 3) 口令过期强制改密 ─────────────────────────────────────────
      if (user && !EXEMPT_WHEN_EXPIRED.has(pathname)) {
        const st = policyMod.stateOf(app, user);
        if (st.expired) {
          sendJSON(res, 403, {
            error: '口令已过期（' + (st.daysLeft != null ? Math.abs(st.daysLeft) : '?') + ' 天前到期），请先修改口令后再使用工作站',
            code: 'PASSWORD_EXPIRED',
            expiresAt: st.expiresAt,
          });
          return true;
        }
      }

      return false;
    } catch (e) {
      /* 门禁自身异常 → 放行（fail-open），但留下日志 */
      console.error('[routes:security-gate] ' + ((e && e.stack) || e));
      return false;
    }
  },
};

module.exports = mod;

'use strict';

/**
 * R15 P0：AI 网关路由的公共小工具。
 * 不放 lib/routes/ 里是因为路由层会把该目录下每个 .js 当模块加载，
 * 纯工具文件放在 lib/ 根下更明确（文件名仍属 ai-* 所有权范围）。
 */

function isAdmin(ctx) {
  const u = ctx && ctx.user;
  if (!u) return false;
  if (u.role === 'admin') return true;
  try {
    return typeof ctx.app.isAdmin === 'function' && ctx.app.isAdmin(u);
  } catch {
    return false;
  }
}

function requireUser(ctx) {
  if (!ctx.user) {
    ctx.sendJSON(ctx.res, 401, { ok: false, error: '需要登录', code: 'UNAUTHORIZED' });
    return false;
  }
  return true;
}

function requireAdmin(ctx) {
  if (!requireUser(ctx)) return false;
  if (!isAdmin(ctx)) {
    ctx.sendJSON(ctx.res, 403, { ok: false, error: '仅管理员可操作', code: 'FORBIDDEN' });
    return false;
  }
  return true;
}

async function readJson(ctx, limit) {
  const raw = await ctx.readBody(ctx.req, limit || 256 * 1024);
  const txt = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (!txt.trim()) return {};
  const obj = JSON.parse(txt);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400, code: 'BAD_JSON' });
  }
  return obj;
}

/** 统一异常出口：网关错误带 status/code，其余按 500 打日志 */
function fail(ctx, e) {
  const status = (e && e.status) || 500;
  const code = (e && e.code) || 'INTERNAL';
  if (status >= 500) console.error('[ai-gw] ' + ((e && e.stack) || e));
  if (ctx.res.headersSent) return;
  try {
    ctx.sendJSON(ctx.res, status, { ok: false, error: String((e && e.message) || e), code });
  } catch { /* 连接已断 */ }
}

/** 路径是否命中（精确或前缀），用于各模块快速排除 */
function matched(pathname, exact, prefix) {
  if (Array.isArray(exact) && exact.includes(pathname)) return true;
  if (Array.isArray(prefix)) {
    for (const p of prefix) {
      if (pathname === p || pathname.startsWith(p + '/')) return true;
    }
  }
  return false;
}

module.exports = { isAdmin, requireUser, requireAdmin, readJson, fail, matched };

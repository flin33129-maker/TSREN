'use strict';

/**
 * R15 第 6 轮：AI 记忆（memory）路由。
 *
 *   GET  /api/ai/gw/memory         我的记忆列表 {ok, items, max, used, inject}
 *   POST /api/ai/gw/memory         新增 {text, tags?, pinned?}
 *   POST /api/ai/gw/memory/update  修改 {id, text?, tags?, pinned?}
 *   POST /api/ai/gw/memory/delete  删除 {id}
 *   POST /api/ai/gw/memory/clear   清空 {confirm:true}
 *
 * 隔离口径与其它 AI 接口一致：只按 ctx.user.id 定位 data/ai-gw/memory/<user.id>.json，
 * 跨用户拿 id → 404；接口不接受客户端 uid。
 */

const gw = require('../ai-gateway');
const util = require('../ai-gw-util');

const mod = {
  name: 'ai-gw-memory',
  prefixes: ['/api/ai/gw'],

  async handle(ctx) {
    const { pathname, method, res } = ctx;
    if (!pathname.startsWith('/api/ai/gw/memory')) return false;
    if (!util.requireUser(ctx)) return true;

    const G = gw.getGateway(ctx.app);
    const M = G.memory();

    try {
      if (pathname === '/api/ai/gw/memory' && method === 'GET') {
        return ctx.sendJSON(res, 200, M.list(ctx.user)), true;
      }

      if (pathname === '/api/ai/gw/memory' && method === 'POST') {
        const body = await util.readJson(ctx, 16 * 1024);
        const r = M.add(ctx.user, body);
        G._audit(ctx.user, 'memory-add', r.item.id + ' ' + r.item.text.slice(0, 40));
        return ctx.sendJSON(res, 200, r), true;
      }

      if (pathname === '/api/ai/gw/memory/update' && method === 'POST') {
        const body = await util.readJson(ctx, 16 * 1024);
        const r = M.update(ctx.user, body);
        G._audit(ctx.user, 'memory-update', String(body.id || ''));
        return ctx.sendJSON(res, 200, r), true;
      }

      if (pathname === '/api/ai/gw/memory/delete' && method === 'POST') {
        const body = await util.readJson(ctx, 16 * 1024);
        const r = M.remove(ctx.user, body);
        G._audit(ctx.user, 'memory-delete', String(body.id || ''));
        return ctx.sendJSON(res, 200, r), true;
      }

      if (pathname === '/api/ai/gw/memory/clear' && method === 'POST') {
        const body = await util.readJson(ctx, 16 * 1024);
        const r = M.clear(ctx.user, body);
        G._audit(ctx.user, 'memory-clear', 'cleared=' + r.cleared);
        return ctx.sendJSON(res, 200, r), true;
      }

      return false;
    } catch (e) {
      util.fail(ctx, e);
      return true;
    }
  },
};

module.exports = mod;

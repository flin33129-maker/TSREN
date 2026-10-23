'use strict';

/**
 * R15 P0：AI 网关 —— 会话与历史（隔离 / 列表 / 详情 / 改名 / 删除 / 导出）
 *
 * 接口：
 *   GET  /api/ai/gw/sessions              我的会话列表（按更新时间倒序）
 *   POST /api/ai/gw/sessions/new          新建会话
 *   GET  /api/ai/gw/sessions/get?id=      会话详情（含全部消息）
 *   POST /api/ai/gw/sessions/get          同上（部分前端只用 POST）
 *   POST /api/ai/gw/sessions/rename       改名 {id,title}
 *   POST /api/ai/gw/sessions/delete       删除 {id}
 *   GET  /api/ai/gw/sessions/export?id=&format=markdown|json   导出（附件下载）
 *
 * 权限口径：所有读写都先按 ctx.user 定位到 data/ai-gw/users/<user.id>/sessions.json，
 * 从不接受客户端传 uid —— 拿别人的会话 id 也只会 404（不存在于自己的文件里）。
 * 验收脚本会用两个账号交叉访问来证明这一点。
 */

const gw = require('../ai-gateway');
const util = require('../ai-gw-util');

const mod = {
  name: 'ai-gw-sessions',
  prefixes: ['/api/ai/gw'],

  async handle(ctx) {
    const { pathname, method, res } = ctx;
    if (!pathname.startsWith('/api/ai/gw/sessions')) return false;

    const G = gw.getGateway(ctx.app);
    const q = ctx.query || {};

    try {
      if (pathname === '/api/ai/gw/sessions' && method === 'GET') {
        if (!util.requireUser(ctx)) return true;
        return ctx.sendJSON(res, 200, G.listSessions(ctx.user)), true;
      }

      if (pathname === '/api/ai/gw/sessions/new' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx, 32 * 1024);
        const r = G.createSession(ctx.user, body);
        G._audit(ctx.user, 'session-new', r.session.id);
        return ctx.sendJSON(res, 200, r), true;
      }

      if (pathname === '/api/ai/gw/sessions/get' && (method === 'GET' || method === 'POST')) {
        if (!util.requireUser(ctx)) return true;
        let id = String(q.id || '');
        if (method === 'POST') {
          const body = await util.readJson(ctx, 32 * 1024);
          id = String(body.id || id);
        }
        return ctx.sendJSON(res, 200, G.getSession(ctx.user, id)), true;
      }

      if (pathname === '/api/ai/gw/sessions/rename' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx, 32 * 1024);
        const r = G.renameSession(ctx.user, String(body.id || ''), body.title);
        G._audit(ctx.user, 'session-rename', String(body.id || ''));
        return ctx.sendJSON(res, 200, r), true;
      }

      if (pathname === '/api/ai/gw/sessions/delete' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx, 32 * 1024);
        const r = G.deleteSession(ctx.user, String(body.id || ''));
        G._audit(ctx.user, 'session-delete', String(body.id || ''));
        return ctx.sendJSON(res, 200, r), true;
      }

      if (pathname === '/api/ai/gw/sessions/export' && method === 'GET') {
        if (!util.requireUser(ctx)) return true;
        const out = G.exportSession(ctx.user, String(q.id || ''), String(q.format || 'markdown'));
        const body = Buffer.from(out.body, 'utf8');
        res.writeHead(200, {
          'Content-Type': out.contentType,
          'Content-Disposition': 'attachment; filename="' + out.filename.replace(/[^\w.-]/g, '_') + '"',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
        G._audit(ctx.user, 'session-export', String(q.id || '') + ' ' + out.format);
        return true;
      }

      return false;
    } catch (e) {
      util.fail(ctx, e);
      return true;
    }
  },
};

module.exports = mod;

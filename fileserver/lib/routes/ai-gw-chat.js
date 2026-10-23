'use strict';

/**
 * R15 P0：AI 网关 —— 对话流式路由（SSE）+ 取消 + diag
 *
 * 接口：
 *   POST /api/ai/gw/chat         对话。默认 SSE；body.stream=false 时走 JSON 一次性返回
 *   POST /api/ai/gw/chat/cancel  取消自己的进行中请求 {requestId}
 *   GET  /api/ai/gw/diag         诊断：最近请求的 TTFT/上游 payload/生效参数（脱敏）
 *   GET  /api/ai/gw/health       匿名健康检查（不含任何配置细节）
 *
 * SSE 帧契约（data: <JSON>，见报告「接口契约」）：
 *   queued / started / retry / token / heartbeat / done / error / timeout / canceled
 *
 * 取消链路：POST cancel → gateway._abort → AbortController.abort() → 关掉到
 * llama-server 的 socket。不然 CPU 会继续把整段答案算完（本机 2 核，实测
 * 一次 128 token 生成要 30s，白算很贵）。
 */

const gw = require('../ai-gateway');
const util = require('../ai-gw-util');

const mod = {
  name: 'ai-gw-chat',
  /* /api/ai/stream 是给验收用例（E1）的兼容别名；它不落在 /api/ai/gw 前缀下，
     必须一起写进 prefixes，否则路由层根本不会把请求转进来（实测会 404）。 */
  prefixes: ['/api/ai/gw', '/api/ai/stream'],

  async handle(ctx) {
    const { pathname, method, res } = ctx;
    /* 兼容别名：团队验收用例（r15/plan/04-验收测试用例.md E1）写的是
       POST /api/ai/stream；这里指向同一个 SSE 实现，两套路径都通。 */
    const path = pathname === '/api/ai/stream' ? '/api/ai/gw/chat'
      : pathname === '/api/ai/stream/cancel' ? '/api/ai/gw/chat/cancel'
        : pathname;
    if (path !== '/api/ai/gw/chat'
      && path !== '/api/ai/gw/chat/cancel'
      && path !== '/api/ai/gw/diag'
      && path !== '/api/ai/gw/health') return false;

    const G = gw.getGateway(ctx.app);

    try {
      if (path === '/api/ai/gw/health') {
        /* 匿名可读，只给「活着」和版本，不给模型地址/提示词/密钥 */
        return ctx.sendJSON(res, 200, {
          ok: true,
          service: 'ai-gateway',
          version: gw.GW_VERSION,
          uptime_s: Math.round(process.uptime()),
          models_enabled: G.models.models.filter((m) => m.enabled !== false).length,
        }), true;
      }

      if (path === '/api/ai/gw/chat' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx, 1024 * 1024);
        /* 网关自己写 SSE / JSON，handleChat 返回值固定为 true */
        await G.handleChat({ ...ctx, body });
        return true;
      }

      if (path === '/api/ai/gw/chat/cancel' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx);
        const r = G.cancel(ctx.user, String(body.requestId || ''));
        return ctx.sendJSON(res, r.ok ? 200 : (r.code === 'FORBIDDEN' ? 403 : 404), r), true;
      }

      if (path === '/api/ai/gw/diag' && method === 'GET') {
        if (!util.requireUser(ctx)) return true;
        const all = String((ctx.query && ctx.query.all) || '') === '1';
        const d = G.diag(ctx.user, { all: all && util.isAdmin(ctx) });
        return ctx.sendJSON(res, 200, d), true;
      }

      return false;
    } catch (e) {
      util.fail(ctx, e);
      return true;
    }
  },
};

module.exports = mod;

'use strict';

/**
 * R15 P0：AI 网关 —— 每用户生成参数 + 系统提示词（多套 / 按场景 / 恢复默认）
 *
 * 接口：
 *   GET  /api/ai/gw/params              登录：我的参数（存档值 + 生效值 + 上限说明）
 *   PUT  /api/ai/gw/params              登录：保存我的参数（只影响自己）
 *   POST /api/ai/gw/params              同 PUT（部分前端只会用 POST）
 *   POST /api/ai/gw/params/reset        登录：恢复默认参数
 *   GET  /api/ai/gw/prompts             登录：我的提示词（含内置默认项）
 *   POST /api/ai/gw/prompts/save        登录：新增 / 更新一套提示词
 *   POST /api/ai/gw/prompts/delete      登录：删除自建提示词（内置不可删）
 *   POST /api/ai/gw/prompts/activate    登录：设当前使用的提示词
 *   POST /api/ai/gw/prompts/reset       登录：内置项恢复默认内容（可只恢复一个）
 *   GET  /api/ai/gw/settings            登录：全局默认值 + 是否允许自选模型
 *   POST /api/ai/gw/settings            管理员：改全局默认参数 / 自选开关
 *
 * 隔离证明（验收脚本 test_isolation 会跑）：
 *   A、B 两个账号各自 PUT 参数、save 提示词，A 写入的字符串在 B 的接口里
 *   永远查不到；B 的 params 版本号/更新时间和 A 互不影响。
 */

const gw = require('../ai-gateway');
const util = require('../ai-gw-util');

const PARAM_KEYS = Object.keys(gw.PARAM_DEFAULTS);

const mod = {
  name: 'ai-gw-params',
  prefixes: ['/api/ai/gw'],

  async handle(ctx) {
    const { pathname, method, res } = ctx;
    const p = pathname;
    const isMine = p === '/api/ai/gw/params' || p.startsWith('/api/ai/gw/params/')
      || p === '/api/ai/gw/prompts' || p.startsWith('/api/ai/gw/prompts/')
      || p === '/api/ai/gw/settings';
    if (!isMine) return false;

    const G = gw.getGateway(ctx.app);

    try {
      /* ---------------- 参数 ---------------- */
      if (p === '/api/ai/gw/params' && (method === 'GET' || method === 'PUT' || method === 'POST')) {
        if (!util.requireUser(ctx)) return true;
        if (method === 'GET') {
          const stored = G.getUserParams(ctx.user);
          return ctx.sendJSON(res, 200, {
            ok: true,
            user: ctx.user.username,
            params: stored,
            effective: G.effectiveParams(ctx.user),
            defaults: Object.assign({}, gw.PARAM_DEFAULTS, G.settings.defaults || {}),
            limits: gw.PARAM_LIMITS,
            keys: PARAM_KEYS,
            note: '参数按 user.id 独立存盘；PUT 只影响自己。timeout_ms=等首 token，total_timeout_ms=单请求全程硬上限，idle_timeout_ms=流中停滞。',
          }), true;
        }
        const body = await util.readJson(ctx, 64 * 1024);
        const next = G.setUserParams(ctx.user, body);
        G._audit(ctx.user, 'params-save', Object.keys(body).join(','));
        return ctx.sendJSON(res, 200, { ok: true, user: ctx.user.username, params: next, effective: G.effectiveParams(ctx.user) }), true;
      }

      if (p === '/api/ai/gw/params/reset' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const next = G.resetUserParams(ctx.user);
        G._audit(ctx.user, 'params-reset', ctx.user.username);
        return ctx.sendJSON(res, 200, { ok: true, params: next, effective: G.effectiveParams(ctx.user) }), true;
      }

      /* ---------------- 提示词 ---------------- */
      if (p === '/api/ai/gw/prompts' && method === 'GET') {
        if (!util.requireUser(ctx)) return true;
        const list = G.listPrompts(ctx.user);
        const params = G.getUserParams(ctx.user);
        return ctx.sendJSON(res, 200, {
          ok: true,
          ...list,
          selectedId: params.system_prompt_id || list.activeId,
          scenarios: gw.SCENARIOS,
        }), true;
      }

      if (p === '/api/ai/gw/prompts/save' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx, 64 * 1024);
        const item = G.savePrompt(ctx.user, body);
        G._audit(ctx.user, 'prompt-save', item.id + ' ' + item.name);
        return ctx.sendJSON(res, 200, { ok: true, prompt: item, ...G.listPrompts(ctx.user) }), true;
      }

      if (p === '/api/ai/gw/prompts/delete' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx);
        const r = G.deletePrompt(ctx.user, String(body.id || ''));
        G._audit(ctx.user, 'prompt-delete', String(body.id || ''));
        return ctx.sendJSON(res, 200, { ok: true, ...r, ...G.listPrompts(ctx.user) }), true;
      }

      if (p === '/api/ai/gw/prompts/activate' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx);
        const r = G.activatePrompt(ctx.user, String(body.id || ''));
        G._audit(ctx.user, 'prompt-activate', r.activeId);
        return ctx.sendJSON(res, 200, { ok: true, ...r }), true;
      }

      if (p === '/api/ai/gw/prompts/reset' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx);
        const r = G.resetPrompt(ctx.user, body.id ? String(body.id) : '');
        G._audit(ctx.user, 'prompt-reset', body.id ? String(body.id) : 'all-builtin');
        return ctx.sendJSON(res, 200, r), true;
      }

      /* ---------------- 全局设置 ---------------- */
      if (p === '/api/ai/gw/settings' && method === 'GET') {
        if (!util.requireUser(ctx)) return true;
        return ctx.sendJSON(res, 200, { ok: true, ...G.getSettings(), isAdmin: util.isAdmin(ctx) }), true;
      }

      if (p === '/api/ai/gw/settings' && method === 'POST') {
        if (!util.requireAdmin(ctx)) return true;
        const body = await util.readJson(ctx, 64 * 1024);
        /* 透传全部字段：除 allowUserModelSelect/defaults 外，还包含 P2 RAG 的
           embedUrl/embedModel/chunkChars/topK/minScore 等（setModelPolicy 内部逐个校验）。 */
        const r = G.setModelPolicy(body);
        G._audit(ctx.user, 'settings-save', Object.keys(body).join(','));
        return ctx.sendJSON(res, 200, { ok: true, ...r }), true;
      }

      return false;
    } catch (e) {
      util.fail(ctx, e);
      return true;
    }
  },
};

module.exports = mod;

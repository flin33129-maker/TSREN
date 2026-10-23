'use strict';

/**
 * R15 P0：AI 网关 —— 模型设置路由（注册 / 探活 / 默认 / 切换 / 列表）
 *
 * 接口：
 *   GET  /api/ai/gw/models            登录：模型列表（apiKey 只回掩码）
 *   POST /api/ai/gw/models            管理员：注册或更新模型（本地/API 同构）
 *   POST /api/ai/gw/models/remove     管理员：删除模型
 *   POST /api/ai/gw/models/probe      登录：探活（GET /v1/models，本地再问 /props 拿 n_ctx）
 *   POST /api/ai/gw/models/default    管理员：设默认模型
 *   POST /api/ai/gw/models/select     登录：用户选择自己的模型（若被允许）
 *   POST /api/ai/gw/models/policy     管理员：全局策略（是否允许用户自选模型）
 *
 * 为什么模型表要独立于旧 /api/ai/config：
 *   旧表是「全局唯一激活后端」，A 切换会影响所有人。这里 defaultId 是管理员
 *   默认值，用户可在 allowUserSelect 的模型里自选，选择落在自己的 params.json，
 *   彼此隔离；API key 加密后只以掩码形式回显。
 */

const gw = require('../ai-gateway');
const util = require('../ai-gw-util');

const mod = {
  name: 'ai-gw-models',
  prefixes: ['/api/ai/gw'],

  async handle(ctx) {
    const { pathname, method, res } = ctx;
    const isModelsPath = pathname === '/api/ai/gw/models' || pathname.startsWith('/api/ai/gw/models/');
    if (!isModelsPath) return false;

    const G = gw.getGateway(ctx.app);

    try {
      /* ---- 列表 ---- */
      if (pathname === '/api/ai/gw/models' && method === 'GET') {
        if (!util.requireUser(ctx)) return true;
        return ctx.sendJSON(res, 200, G.listModels(ctx.user, { admin: util.isAdmin(ctx) })), true;
      }

      /* ---- 注册 / 更新 ---- */
      if (pathname === '/api/ai/gw/models' && method === 'POST') {
        if (!util.requireAdmin(ctx)) return true;
        const body = await util.readJson(ctx, 64 * 1024);
        const rec = G.upsertModel(body);
        G._audit(ctx.user, 'model-upsert', rec.id + ' ' + rec.name + ' ' + rec.baseUrl + (rec.apiKeyEnc ? ' (key已配置)' : ''));
        return ctx.sendJSON(res, 200, {
          ok: true,
          model: G.listModels(ctx.user, { admin: true }).models.find((m) => m.id === rec.id),
          ...G.listModels(ctx.user, { admin: true }),
        }), true;
      }

      /* ---- 删除 ---- */
      if (pathname === '/api/ai/gw/models/remove' && method === 'POST') {
        if (!util.requireAdmin(ctx)) return true;
        const body = await util.readJson(ctx);
        const r = G.removeModel(String(body.id || ''));
        G._audit(ctx.user, 'model-remove', String(body.id || ''));
        return ctx.sendJSON(res, 200, { ok: true, ...r, ...G.listModels(ctx.user, { admin: true }) }), true;
      }

      /* ---- 探活 ---- */
      if (pathname === '/api/ai/gw/models/probe' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx);
        const r = await G.probeModel(String(body.id || ''));
        return ctx.sendJSON(res, r.ok ? 200 : 502, { ok: r.ok, probe: r }), true;
      }

      /* ---- 设默认 ---- */
      if (pathname === '/api/ai/gw/models/default' && method === 'POST') {
        if (!util.requireAdmin(ctx)) return true;
        const body = await util.readJson(ctx);
        const r = G.setDefaultModel(String(body.id || ''));
        G._audit(ctx.user, 'model-default', String(body.id || ''));
        return ctx.sendJSON(res, 200, { ok: true, ...r, ...G.listModels(ctx.user, { admin: true }) }), true;
      }

      /* ---- 用户自选 ---- */
      if (pathname === '/api/ai/gw/models/select' && method === 'POST') {
        if (!util.requireUser(ctx)) return true;
        const body = await util.readJson(ctx);
        const id = String(body.id || '');
        const m = G.findModel(id);
        if (!m) return ctx.sendJSON(res, 404, { ok: false, error: '模型不存在', code: 'NO_MODEL' }), true;
        if (m.enabled === false) return ctx.sendJSON(res, 400, { ok: false, error: '模型已禁用', code: 'MODEL_DISABLED' }), true;
        if (!util.isAdmin(ctx) && m.allowUserSelect === false) {
          return ctx.sendJSON(res, 403, { ok: false, error: '该模型不允许用户自选', code: 'FORBIDDEN' }), true;
        }
        if (!util.isAdmin(ctx) && G.settings.allowUserModelSelect === false) {
          return ctx.sendJSON(res, 403, { ok: false, error: '管理员已关闭用户自选模型', code: 'FORBIDDEN' }), true;
        }
        const params = G.setUserParams(ctx.user, { model_id: id });
        G._audit(ctx.user, 'model-select', id);
        return ctx.sendJSON(res, 200, { ok: true, selectedId: id, params }), true;
      }

      /* ---- 全局策略 ---- */
      if (pathname === '/api/ai/gw/models/policy' && method === 'POST') {
        if (!util.requireAdmin(ctx)) return true;
        const body = await util.readJson(ctx);
        const r = G.setModelPolicy({ allowUserModelSelect: body.allowUserModelSelect });
        G._audit(ctx.user, 'model-policy', 'allowUserModelSelect=' + r.allowUserModelSelect);
        return ctx.sendJSON(res, 200, { ok: true, ...r }), true;
      }

      /* 其他 /api/ai/gw/models/* 未定义：交给后面的模块或旧链路 */
      return false;
    } catch (e) {
      util.fail(ctx, e);
      return true;
    }
  },
};

module.exports = mod;

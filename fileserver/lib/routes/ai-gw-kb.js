'use strict';

/**
 * R15 P2：知识库（KB / RAG）路由
 *
 *   GET  /api/ai/gw/kb                 我的知识库列表（只含自己）
 *   POST /api/ai/gw/kb                 新建 {name}
 *   GET  /api/ai/gw/kb/get?id=         详情（含文档状态/失败原因）
 *   POST /api/ai/gw/kb/rename          重命名 {id,name}
 *   POST /api/ai/gw/kb/delete          删除 {id}（连同向量目录）
 *   POST /api/ai/gw/kb/ingest          入库 {kbId, files:[{scope,path}], text?, name?} → {jobId}
 *   GET  /api/ai/gw/kb/job?id=         入库进度/失败原因
 *   POST /api/ai/gw/kb/docs/remove     删除单个文档 {kbId,docId}
 *   POST /api/ai/gw/kb/search          纯检索 {kb_ids,query,top_k}（验收/调试用）
 *   GET  /api/ai/gw/kb/health          embedding 服务探活
 *
 * 隔离口径与其它 AI 接口一致：只按 ctx.user.id 定位 data/ai-gw/kb/<user.id>/，
 * 跨用户拿 kb id → 404（含 chat 的 kb_ids 校验，见 ai-gateway.js handleChat）。
 *
 * 入库取文件走主服务的 app.resolveTarget()：ACL/私有区/盘符都由主服务判定，
 * 本模块不自己拼绝对路径，避免把「越权读文件」当成顺手实现。
 */

const fs = require('fs');
const path = require('path');
const gw = require('../ai-gateway');
const util = require('../ai-gw-util');

const MAX_INGEST_ITEMS = 20;
const MAX_INLINE_TEXT = 600000;
const MAX_FILE_MB = 20;

const mod = {
  name: 'ai-gw-kb',
  prefixes: ['/api/ai/gw'],

  async handle(ctx) {
    const { pathname, method, res } = ctx;
    if (!pathname.startsWith('/api/ai/gw/kb')) return false;
    if (!util.requireUser(ctx)) return true;

    const G = gw.getGateway(ctx.app);
    const KB = G.kb(ctx.user);
    const q = ctx.query || {};

    try {
      /* ---------------- 探活 ---------------- */
      if (pathname === '/api/ai/gw/kb/health' && method === 'GET') {
        const probe = await KB.probe();
        return ctx.sendJSON(res, probe.ok ? 200 : 502, { ok: probe.ok, probe }), true;
      }

      /* ---------------- 列表 / 新建 ---------------- */
      if (pathname === '/api/ai/gw/kb' && method === 'GET') {
        const r = KB.list(ctx.user);
        return ctx.sendJSON(res, 200, { ...r, rag: G.ragSettings(), embed: await safeProbe(KB) }), true;
      }
      if (pathname === '/api/ai/gw/kb' && method === 'POST') {
        const body = await util.readJson(ctx, 32 * 1024);
        const r = KB.create(ctx.user, body.name);
        G._audit(ctx.user, 'kb-create', r.kb.id + ' ' + r.kb.name);
        return ctx.sendJSON(res, 200, r), true;
      }

      /* ---------------- 详情 / 改名 / 删除 ---------------- */
      if (pathname === '/api/ai/gw/kb/get' && method === 'GET') {
        return ctx.sendJSON(res, 200, KB.get(ctx.user, String(q.id || ''))), true;
      }
      if (pathname === '/api/ai/gw/kb/rename' && method === 'POST') {
        const body = await util.readJson(ctx, 32 * 1024);
        const r = KB.rename(ctx.user, String(body.id || ''), body.name);
        G._audit(ctx.user, 'kb-rename', String(body.id || ''));
        return ctx.sendJSON(res, 200, r), true;
      }
      if (pathname === '/api/ai/gw/kb/delete' && method === 'POST') {
        const body = await util.readJson(ctx, 32 * 1024);
        const r = KB.remove(ctx.user, String(body.id || ''));
        G._audit(ctx.user, 'kb-delete', String(body.id || ''));
        return ctx.sendJSON(res, 200, r), true;
      }
      if (pathname === '/api/ai/gw/kb/docs/remove' && method === 'POST') {
        const body = await util.readJson(ctx, 32 * 1024);
        const r = KB.removeDoc(ctx.user, String(body.kbId || body.id || ''), String(body.docId || ''));
        G._audit(ctx.user, 'kb-doc-remove', String(body.kbId || '') + '/' + String(body.docId || ''));
        return ctx.sendJSON(res, 200, r), true;
      }

      /* ---------------- 入库 ---------------- */
      if (pathname === '/api/ai/gw/kb/ingest' && method === 'POST') {
        const body = await util.readJson(ctx, 2 * 1024 * 1024);
        const kbId = String(body.kbId || '');
        const items = [];
        for (const f of Array.isArray(body.files) ? body.files.slice(0, MAX_INGEST_ITEMS) : []) {
          const scope = String(f.scope || 'private');
          if (!(scope === 'private' || scope === 'public' || scope.startsWith('ext:'))) {
            return ctx.sendJSON(res, 400, { ok: false, error: '不支持的 scope：' + scope, code: 'BAD_SCOPE' }), true;
          }
          const t = ctx.app.resolveTarget({ scope, path: String(f.path || '') }, ctx.user);
          if (t.error) {
            return ctx.sendJSON(res, t.code || 400, { ok: false, error: '文件不可读：' + t.error + '（' + (f.path || '') + '）', code: 'FILE_ACCESS' }), true;
          }
          let st;
          try { st = fs.statSync(t.abs); } catch { return ctx.sendJSON(res, 404, { ok: false, error: '文件不存在：' + (f.path || ''), code: 'FILE_NOT_FOUND' }), true; }
          if (!st.isFile()) return ctx.sendJSON(res, 400, { ok: false, error: '不是文件：' + (f.path || ''), code: 'NOT_FILE' }), true;
          if (st.size > MAX_FILE_MB * 1024 * 1024) {
            return ctx.sendJSON(res, 400, { ok: false, error: '文件超过 ' + MAX_FILE_MB + 'MB：' + (f.path || ''), code: 'FILE_TOO_LARGE' }), true;
          }
          items.push({
            kind: 'file', abs: t.abs,
            name: String(body.name || path.basename(t.abs)).slice(0, 120),
            size: st.size,
            source: { scope, path: String(f.path || '') },
          });
        }
        if (body.text != null && String(body.text).trim()) {
          items.push({
            kind: 'text',
            text: String(body.text).slice(0, MAX_INLINE_TEXT),
            name: String(body.name || '粘贴文本.txt').slice(0, 120),
            size: Buffer.byteLength(String(body.text), 'utf8'),
            source: { type: 'text' },
          });
        }
        /* 一次提交多段粘贴文本（批量入库；同一 job 内串行 embed，避免多任务并发打爆 CPU） */
        if (Array.isArray(body.texts)) {
          for (const t of body.texts.slice(0, MAX_INGEST_ITEMS)) {
            if (!t || !String(t.text || '').trim()) continue;
            items.push({
              kind: 'text',
              text: String(t.text).slice(0, MAX_INLINE_TEXT),
              name: String(t.name || ('粘贴文本-' + (items.length + 1) + '.txt')).slice(0, 120),
              size: Buffer.byteLength(String(t.text), 'utf8'),
              source: { type: 'text' },
            });
          }
        }
        if (!items.length) {
          return ctx.sendJSON(res, 400, { ok: false, error: '没有要入库的文件（files 或 text 至少给一个）', code: 'NO_FILES' }), true;
        }
        const r = KB.startIngest(ctx.user, kbId, items);
        G._audit(ctx.user, 'kb-ingest', kbId + ' docs=' + items.length + ' job=' + r.job.id);
        return ctx.sendJSON(res, 200, r), true;
      }

      if (pathname === '/api/ai/gw/kb/job' && method === 'GET') {
        return ctx.sendJSON(res, 200, KB.getJob(ctx.user, String(q.id || q.jobId || ''))), true;
      }

      /* ---------------- 检索（调试/验收） ---------------- */
      if (pathname === '/api/ai/gw/kb/search' && method === 'POST') {
        const body = await util.readJson(ctx, 64 * 1024);
        const ids = Array.isArray(body.kb_ids) ? body.kb_ids.map(String) : [];
        const owned = KB.ownedKbIds(ctx.user, ids);
        const missing = ids.filter((id) => !owned.includes(id));
        if (missing.length) {
          return ctx.sendJSON(res, 404, { ok: false, error: '知识库不存在或不属于当前用户', code: 'KB_NOT_FOUND', missing }), true;
        }
        const r = await KB.search(ctx.user, ids, String(body.query || ''), {
          topK: body.top_k != null ? body.top_k : undefined,
        });
        return ctx.sendJSON(res, 200, r), true;
      }

      return false;
    } catch (e) {
      util.fail(ctx, e);
      return true;
    }
  },
};

async function safeProbe(KB) {
  try { return await KB.probe(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

module.exports = mod;

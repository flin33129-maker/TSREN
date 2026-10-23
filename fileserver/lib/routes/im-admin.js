'use strict';

/**
 * R15-IM 管理扩展路由（第 8 轮）
 *
 * 背景：IM 数据（data/im.json）没有删除接口，多轮 UI 验收产生了大量
 * `R15-IM-测试群-*` 残留会话，把聊天页/测试的选择器越挤越乱。
 * 本文件用可插拔扩展路由（lib/routes/*.js）接管 /api/im/purge，
 * **不改 server.js**，只在管理员显式确认时清理测试数据。
 *
 * 接口：
 *   GET  /api/im/purge?prefix=...&keep=N       管理员：只预览，不删除
 *   POST /api/im/purge {prefix, confirm:true, keep?}  管理员：删除匹配前缀的群 + 消息
 *
 * 安全约束：
 *   - 仅管理员（user.role==='admin' 或 app.isAdmin(user)）
 *   - POST 必须带 confirm:true，prefix 至少 2 个字符，拒绝 '*' / '' / 'general'
 *   - 只删 type==='group' 且 name 以 prefix 开头的频道；消息/已读戳一并清理
 *   - 可选 keep：保留最新 N 个匹配群（“保留最近 2 个群作证据”）
 */
const MAX_BODY = 16 * 1024;

const isAdminUser = (app, user) => {
  if (!user) return false;
  if (user.role === 'admin' || user.isAdmin === true) return true;
  try {
    return !!(app && typeof app.isAdmin === 'function' && app.isAdmin(user));
  } catch {
    return false;
  }
};

/**
 * 纯函数：从 app.im 的内存数据里删除匹配前缀的群频道与其消息。
 * 抽出来便于单元测试（不需要起 HTTP 服务）。
 * @returns {{ok:boolean,error?:string,before?:object,after?:object,removed?:object,kept?:object}}
 */
function purgeIm(app, opts) {
  const im = app && app.im;
  if (!im || !im.data || !Array.isArray(im.data.channels)) {
    return { ok: false, error: 'IM 数据未初始化' };
  }
  const prefix = String((opts && opts.prefix) || '');
  const rawKeep = opts && opts.keep;
  const keep = Math.max(0, Math.min(50, Number.isFinite(Number(rawKeep)) ? Math.floor(Number(rawKeep)) : 0));
  if (prefix.length < 2) return { ok: false, error: 'prefix 至少 2 个字符' };
  if (prefix === '*' || prefix === 'general' || prefix === '/') return { ok: false, error: '拒绝危险 prefix' };

  const data = im.data;
  const channels = data.channels;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const readAt = data.readAt && typeof data.readAt === 'object' ? data.readAt : {};

  const matched = channels.filter((c) => c && c.type === 'group' && String(c.name || '').startsWith(prefix));
  const newestFirst = matched.slice().sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
  const keepIds = new Set(newestFirst.slice(0, keep).map((c) => c.id));
  const removeChannels = matched.filter((c) => !keepIds.has(c.id));
  const removeIds = new Set(removeChannels.map((c) => c.id));

  const before = { channels: channels.length, messages: messages.length, readAt: Object.keys(readAt).length };
  if (!removeIds.size) {
    return {
      ok: true, before, after: before,
      removed: { channels: [], messages: 0, readAt: 0 },
      kept: newestFirst.slice(0, keep).map((c) => ({ id: c.id, name: c.name })),
      matched: matched.length,
      note: '没有需要删除的频道',
    };
  }

  data.channels = channels.filter((c) => !removeIds.has(c.id));
  data.messages = messages.filter((m) => !removeIds.has(m && m.ch));
  let readAtRemoved = 0;
  for (const key of Object.keys(readAt)) {
    const chId = String(key).split('|')[0];
    if (removeIds.has(chId)) {
      delete readAt[key];
      readAtRemoved += 1;
    }
  }
  try {
    if (typeof im._flush === 'function') im._flush();
  } catch {
    /* 落盘失败不影响内存清理；下一次 IM 写会重试 */
  }

  return {
    ok: true,
    before,
    after: { channels: data.channels.length, messages: data.messages.length, readAt: Object.keys(readAt).length },
    removed: {
      channels: removeChannels.map((c) => ({ id: c.id, name: c.name, members: (c.members || []).length })),
      messages: messages.length - data.messages.length,
      readAt: readAtRemoved,
    },
    kept: newestFirst.slice(0, keep).map((c) => ({ id: c.id, name: c.name })),
    matched: matched.length,
  };
}

function readJsonBody(ctx) {
  return (async () => {
    const raw = await ctx.readBody(ctx.req, MAX_BODY);
    const txt = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    if (!txt.trim()) return {};
    return JSON.parse(txt);
  })();
}

async function handle(ctx) {
  if (ctx.pathname !== '/api/im/purge') return false;
  const { res, user, method, query, sendJSON, app } = ctx;

  if (!user) {
    sendJSON(res, 401, { error: '需要登录' });
    return true;
  }
  if (!isAdminUser(app, user)) {
    sendJSON(res, 403, { error: '仅管理员可清理 IM 测试数据' });
    return true;
  }

  const prefix = String((query && query.prefix) || '');

  /* 只读预览：GET /api/im/purge?prefix=...&keep=N */
  if (method === 'GET') {
    const im = app && app.im;
    if (!im || !im.data || !Array.isArray(im.data.channels)) {
      sendJSON(res, 500, { ok: false, error: 'IM 数据未初始化' });
      return true;
    }
    const pre = String(prefix || '');
    const keep = Math.max(0, Math.min(50, Number((query && query.keep) || 0) || 0));
    const matched = im.data.channels.filter((c) => c && c.type === 'group' && String(c.name || '').startsWith(pre));
    const sorted = matched.slice().sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
    sendJSON(res, 200, {
      ok: true,
      prefix: pre,
      keep,
      matched: matched.length,
      candidates: sorted.slice(keep).map((c) => ({ id: c.id, name: c.name, members: (c.members || []).length, created: c.created })),
      willKeep: sorted.slice(0, keep).map((c) => ({ id: c.id, name: c.name })),
      hint: 'POST /api/im/purge {prefix, confirm:true, keep?} 才会真正删除',
    });
    return true;
  }

  if (method !== 'POST') {
    sendJSON(res, 405, { error: '仅支持 GET(预览) / POST(删除)' });
    return true;
  }

  let body;
  try {
    body = await readJsonBody(ctx);
  } catch {
    sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    return true;
  }
  if (body.confirm !== true) {
    sendJSON(res, 400, { error: '需要 confirm:true 才会执行删除' });
    return true;
  }
  const bodyPrefix = String(body.prefix || prefix || '');
  if (!bodyPrefix || bodyPrefix.length < 2) {
    sendJSON(res, 400, { error: '缺少 prefix（至少 2 个字符）' });
    return true;
  }

  const out = purgeIm(app, { prefix: bodyPrefix, keep: body.keep });
  if (!out.ok) {
    sendJSON(res, 400, out);
    return true;
  }
  try {
    if (app && typeof app.audit === 'function') {
      app.audit({
        action: 'im-purge',
        userObj: user,
        ok: true,
        ip: String((ctx.req && ctx.req.socket && ctx.req.socket.remoteAddress) || ''),
        detail: '清理 IM 测试数据：prefix=' + bodyPrefix + '，删除 ' + out.removed.channels.length
          + ' 个群/' + out.removed.messages + ' 条消息；保留 ' + out.kept.length + ' 个',
      });
    }
  } catch {
    /* 审计失败不影响清理结果 */
  }
  sendJSON(res, 200, out);
  return true;
}

module.exports = {
  name: 'im-admin',
  prefixes: ['/api/im/purge'],
  handle,
  /* 导出给单元测试/运维脚本复用（不是 HTTP 契约） */
  _purgeIm: purgeIm,
};

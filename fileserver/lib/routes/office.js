'use strict';

/**
 * 办公工作区 API（R15 P0 · office 模块）
 *
 * 挂载：lib/routes/index.js 自动扫描 + server.js 在旧 if-else 链之前调用，
 * 所以本文件拿到的是「所有 /api/office* 与 /api/notify 请求的第一处置权」。
 *
 * 与旧接口的关系：
 *   · 旧 /api/docs（data/docs/<user>.json）继续服务老页面 /work.html，不动它；
 *     本模块初始化时**一次性迁移**旧文档到新模型（标记文件 .migrated-v1），
 *     所以新页面第一次打开就能看到历史文档。
 *   · /api/office/oo/*（OnlyOffice）、/api/office/preview、/api/office/go/*
 *     属于老实现的文档服务：本模块对这些前缀一律 return false 放行，
 *     保证在线编辑 Word/Excel 那条链路不被拦断。
 *
 * 接口清单见文件末尾 routes 注释 / GET /api/office/capability。
 */

const fs = require('fs');
const path = require('path');
/* R15.1：依赖原来是 `/opt/station/dsoffice/lib/*`（外部实现，没有随仓库发布），
   在别的机器/重新部署时这里直接 throw，导致整组 /api/office/* 404。
   现改为优先用仓库内重建版 lib/dsoffice/，仅当它不存在时才回退到旧路径 ——
   既保证可部署，也不破坏已经装了老版本 dsoffice 的机器。 */
function requireOfficeDep(name) {
  const local = require.resolve('../dsoffice/' + name);
  try {
    require.resolve(local);
    return require(local);
  } catch (e) {
    return require('/opt/station/dsoffice/lib/' + name);
  }
}
const { OfficeStore, cellName } = requireOfficeDep('store.js');
const { LiveHub, colorOf } = requireOfficeDep('live.js');
const convert = requireOfficeDep('convert.js');
const templates = requireOfficeDep('templates.js');

const MAX_IMPORT_BYTES = 45 * 1024 * 1024;
const MAX_JSON_BODY = 8 * 1024 * 1024;
const LEGACY_PASSTHROUGH = ['/api/office/oo', '/api/office/preview', '/api/office/go'];

let store = null;
let hub = null;
let appRef = null;

function ensure(app) {
  if (!store) {
    appRef = app;
    store = new OfficeStore(app);
    hub = new LiveHub(app, store);
    setInterval(() => hub.reap(), 60 * 1000).unref();
    console.log('[office] 文档库就绪：' + store.index.length + ' 篇（' + store.base + '）');
  }
  return { store, hub };
}

function json(res, code, obj, ctx) {
  if (ctx && typeof ctx.sendJSON === 'function') return ctx.sendJSON(res, code, obj);
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function needUser(ctx, res) {
  if (!ctx.user) {
    json(res, 401, { error: '需要登录' }, ctx);
    return false;
  }
  return true;
}

function isAdmin(user) {
  return !!user && user.role === 'admin';
}

function canManage(user, doc) {
  return isAdmin(user) || (doc && doc.owner === user.username);
}

function clientIp(ctx) {
  const req = ctx.req;
  return (req.socket && req.socket.remoteAddress) || '';
}

function audit(ctx, action, detail, ok) {
  try {
    if (appRef && typeof appRef.audit === 'function') {
      appRef.audit({ action, userObj: ctx.user, ok: ok !== false, detail, ip: clientIp(ctx) });
    }
  } catch (e) {
    /* 审计失败不影响主流程 */
  }
}

function parseBody(ctx, limit) {
  return ctx
    .readBody(ctx.req, limit || MAX_JSON_BODY)
    .then((buf) => JSON.parse(String(buf || '{}')))
    .catch(() => null);
}

async function readRawBody(ctx, limit) {
  const buf = await ctx.readBody(ctx.req, limit || MAX_IMPORT_BYTES);
  return Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
}

function contentDisposition(filename) {
  const ascii = String(filename || 'download').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''` + encodeURIComponent(String(filename || 'download'));
}

function mentionsOf(text) {
  const out = new Set();
  const re = /@([A-Za-z0-9_\u4e00-\u9fa5.-]{1,32})/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.add(m[1]);
  return [...out];
}

/**
 * 读取文档：优先取协同房间里的内存态（最新），回退到磁盘。
 * 为什么不直接用 store.getDoc：落盘有 400ms 防抖，紧跟一次 op 的
 * GET/导出如果读盘就会拿到旧内容（实测 D9 公式"写了却导不出"）。
 */
function liveDoc(st, hb, id) {
  const room = hb.rooms.get(String(id || ''));
  if (room && room.doc && room.doc.id === String(id)) return room.doc;
  return st.getDoc(String(id || ''));
}

/** 把内存态刷到磁盘（改元信息/删除/版本前调用，避免用旧盘内容覆盖新内存） */
function syncDown(st, hb, id) {
  const room = hb.rooms.get(String(id || ''));
  if (!room || !room.doc) return;
  try {
    st.flush(room.doc);
  } catch (e) {
    /* 忽略 */
  }
}

/* ── SSE ───────────────────────────────────────────────────────────────── */

function sseHandler(ctx, st, hb) {
  const { req, res, query } = ctx;
  const docId = String(query.doc || '');
  const cid = String(query.cid || '').slice(0, 40) || 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const doc = st.getDoc(docId);
  if (!doc) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '文档不存在' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected ' + new Date().toISOString() + '\n\n');
  const client = {
    cid,
    user: ctx.user.username,
    color: colorOf(ctx.user.username),
    res,
    cursor: null,
    at: Date.now(),
    joinedAt: Date.now(),
  };
  const room = hb.join(docId, client);
  if (!room) {
    try {
      res.end();
    } catch (e) {
      /* 忽略 */
    }
    return;
  }
  const ping = setInterval(() => {
    try {
      res.write(': ping ' + Date.now() + '\n\n');
    } catch (e) {
      /* 连接可能已断，close 事件会清理 */
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    hb.leave(room, cid);
  });
  req.on('error', () => {
    clearInterval(ping);
    hb.leave(room, cid);
  });
}

/* ── 导出 ──────────────────────────────────────────────────────────────── */

async function exportHandler(ctx, st, hb, format) {
  const id = String(ctx.query.id || '');
  const doc = liveDoc(st, hb, id);
  if (!doc) return json(ctx.res, 404, { error: '文档不存在' }, ctx);
  if (doc.kind === 'image') {
    const name = doc.content && doc.content.name;
    const file = name ? st.attachmentPath(String(id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.' + name.split('.').pop()) : null;
    const data = doc.content && doc.content.data ? Buffer.from(doc.content.data, 'base64') : file ? fs.readFileSync(file) : null;
    if (!data) return json(ctx.res, 404, { error: '附件已丢失' }, ctx);
    const srcExt = String((name || '').split('.').pop() || 'png').toLowerCase().replace('jpeg', 'jpg');
    const want = String(format || '').toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg');
    const mime = convert.MIME[want] || (want === 'jpg' ? 'image/jpeg' : '');
    // 图片文档：导出同格式时直接给原图；png/jpg/webp/gif 之间用 ImageMagick 真转换
    if (!want || want === srcExt || (want === 'jpg' && srcExt === 'jpeg')) {
      ctx.res.writeHead(200, {
        'Content-Type': (doc.content && doc.content.mime) || mime || 'image/png',
        'Content-Length': data.length,
        'Content-Disposition': contentDisposition(convert.safeName(doc.title, srcExt === 'jpg' ? 'jpg' : srcExt)),
        'Cache-Control': 'private, max-age=60',
        'X-Office-Engine': 'original',
      });
      return ctx.res.end(data);
    }
    if (!['png', 'jpg', 'webp', 'gif'].includes(want)) {
      return json(ctx.res, 400, { error: '图片文档只支持导出 png/jpg/webp/gif（收到 ' + want + '）' }, ctx);
    }
    const conv = await convert.convertImage(data, srcExt, want);
    if (!conv.ok) {
      audit(ctx, 'office-export', id + ':image:' + want + ':' + conv.error, false);
      return json(ctx.res, 400, { error: conv.error }, ctx);
    }
    audit(ctx, 'office-export', id + ':image->' + want + ':' + conv.buf.length + 'B', true);
    ctx.res.writeHead(200, {
      'Content-Type': convert.MIME[want] || 'image/' + want,
      'Content-Length': conv.buf.length,
      'Content-Disposition': contentDisposition(convert.safeName(doc.title, want)),
      'Cache-Control': 'private, max-age=60',
      'X-Office-Engine': 'imagemagick',
    });
    return ctx.res.end(conv.buf);
  }
  if (doc.kind === 'pdf') {
    const name = doc.content && doc.content.name;
    const file = name ? st.attachmentPath(String(id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.' + name.split('.').pop()) : null;
    const mime = 'application/pdf';
    const data = doc.content && doc.content.data ? Buffer.from(doc.content.data, 'base64') : file ? fs.readFileSync(file) : null;
    if (!data) return json(ctx.res, 404, { error: '附件已丢失' }, ctx);
    const want = String(format || 'pdf').toLowerCase().replace(/^\./, '');
    if (want !== 'pdf' && want !== 'original') {
      return json(ctx.res, 400, { error: 'PDF 只有只读预览；需要文字版请用“另存为文字文档”（/api/office/pdf/to-doc）' }, ctx);
    }
    ctx.res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': data.length,
      'Content-Disposition': contentDisposition(convert.safeName(doc.title, 'pdf')),
      'Cache-Control': 'private, max-age=60',
      'X-Office-Engine': 'original',
    });
    return ctx.res.end(data);
  }
  const out = await convert.exportDoc(doc, format);
  if (!out.ok) {
    audit(ctx, 'office-export', id + ':' + format + ':' + out.error, false);
    return json(ctx.res, 400, { error: out.error }, ctx);
  }
  audit(ctx, 'office-export', id + ':' + format + ':' + out.buf.length + 'B:' + out.ms + 'ms', true);
  ctx.res.writeHead(200, {
    'Content-Type': out.mime,
    'Content-Length': out.buf.length,
    'Content-Disposition': contentDisposition(out.filename),
    'X-Office-Engine': out.engine,
    'X-Office-Ms': String(out.ms),
    'Cache-Control': 'no-store',
  });
  return ctx.res.end(out.buf);
}

/* ── 主处理 ────────────────────────────────────────────────────────────── */

module.exports = {
  name: 'office',
  prefixes: ['/api/office', '/api/notify'],

  async handle(ctx) {
    const { req, res, pathname, method, query } = ctx;
    // 老 OnlyOffice 链路放行
    for (const p of LEGACY_PASSTHROUGH) {
      if (pathname === p || pathname.startsWith(p + '/')) return false;
    }
    const { store: st, hub: hb } = ensure(ctx.app);

    /* ---------- 消息中心合并（GET /api/notify） ---------- */
    if (pathname === '/api/notify' && (method === 'GET' || method === 'HEAD')) {
      if (!ctx.user) {
        json(res, 401, { error: '需要登录' }, ctx);
        return true;
      }
      const items = st.notifications(ctx.user);
      const payload = {
        items,
        entries: items,
        unread: items.filter((n) => !n.read).length,
      };
      // 兼容旧接口形状（旧前端/设置页读 cfg、recent 两个字段）
      try {
        if (ctx.app.notifier) {
          payload.cfg = ctx.app.notifier.loadCfg ? ctx.app.notifier.loadCfg() : undefined;
          payload.recent = ctx.app.notifier.listRecent ? ctx.app.notifier.listRecent(20) : undefined;
        }
      } catch (e) {
        /* 老接口不可用时只回新形状 */
      }
      json(res, 200, payload, ctx);
      return true;
    }
    if (pathname === '/api/notify' && method === 'POST') {
      // 同时承担两种语义：
      //   {ids:[...], action:'read'}   → 消息中心标记已读（R15 前端）
      //   {data:{...}} / {action:'test'} → 旧 Webhook 多通道配置（老设置页）
      // 两种都在这里实现，避免出现"接了新消息中心、把老配置弄丢"的回归。
      if (!ctx.user) {
        json(res, 401, { error: '需要登录' }, ctx);
        return true;
      }
      const body = (await parseBody(ctx, 256 * 1024)) || {};
      if (body.action === 'read' || Array.isArray(body.ids)) {
        const n = st.markNotifyRead(ctx.user, Array.isArray(body.ids) ? body.ids : null);
        json(res, 200, { ok: true, marked: n }, ctx);
        return true;
      }
      if (body.action === 'test' || (body.data && typeof body.data === 'object')) {
        if (!isAdmin(ctx.user)) return json(res, 403, { error: '需要管理员权限' }, ctx) || true;
        const notifier = ctx.app.notifier;
        if (!notifier) return json(res, 500, { error: '通知服务不可用' }, ctx) || true;
        if (body.action === 'test') {
          const r = await notifier.test(body.title || 'NAS 测试通知', body.msg || '这是一条测试消息');
          json(res, 200, { ok: true, r }, ctx);
          return true;
        }
        if (typeof notifier.saveCfg === 'function') notifier.saveCfg(body.data);
        audit(ctx, 'notify-save', 'webhook-cfg', true);
        json(res, 200, { ok: true }, ctx);
        return true;
      }
      json(res, 200, { ok: true }, ctx);
      return true;
    }

    if (!pathname.startsWith('/api/office')) return false;
    if (!needUser(ctx, res)) return true;

    /* ---------- 基础 ---------- */
    if (pathname === '/api/office/health' && method === 'GET') {
      json(res, 200, {
        ok: true,
        docs: st.index.length,
        trash: st.trash.length,
        comments: Object.keys(st.comments).length,
        rooms: hb.rooms.size,
        online: [...hb.rooms.values()].map((r) => ({ doc: r.docId, users: hb.presenceList(r) })),
        dataDir: st.base,
        now: Date.now(),
      }, ctx);
      return true;
    }
    if (pathname === '/api/office/capability' && method === 'GET') {
      const cap = convert.capability();
      json(res, 200, {
        ok: true,
        matrix: cap,
        engines: cap.engines,
        kinds: ['doc', 'sheet', 'board', 'mind', 'note', 'slide', 'flow', 'form', 'poster', 'pdf', 'image'],
        formats: Object.keys(convert.MIME),
      }, ctx);
      return true;
    }

    /* ---------- 办公模板（P2）：只读模板库 + 一键创建独立副本 ---------- */
    if (pathname === '/api/office/templates' && method === 'GET') {
      json(res, 200, { ok: true, items: templates.list(), total: templates.TEMPLATE_IDS.length }, ctx);
      return true;
    }
    if (pathname === '/api/office/templates/use' && method === 'POST') {
      const body = await parseBody(ctx);
      const tpl = templates.materialize(String((body && body.id) || ''));
      if (!tpl) return json(res, 404, { error: '模板不存在' }, ctx) || true;
      const d = new Date();
      const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const title = String((body && body.title) || tpl.name + ' · ' + stamp).slice(0, 80);
      const folder = String((body && body.folder) || '我的文档').slice(0, 40);
      const doc = st.create(ctx.user, { kind: tpl.kind, title, folder });
      doc.content = tpl.content; // materialize 已深拷贝，与模板数据彻底隔离
      doc.rev = 2;
      doc.updatedAt = Date.now();
      doc.updatedBy = ctx.user.username;
      doc.templateId = tpl.id;
      st.flush(doc);
      st.snapshot(doc, ctx.user.username, 'template:' + tpl.id);
      audit(ctx, 'office-template-use', tpl.id + '->' + doc.id, true);
      json(res, 200, { ok: true, doc, template: { id: tpl.id, name: tpl.name, kind: tpl.kind, group: tpl.group } }, ctx);
      return true;
    }

    /* ---------- 格式转换产物隐藏：_convert/ 移到 .convert/ ----------
     * server.js 的 GenOffice 接口把产物写在 public/_convert/（历史约定），
     * 会出现在「最近文件」里。转换完成后前端调用本接口，把单个产物（或 PNG 整页目录）
     * 原子移动到以点开头的 .convert/；最近文件扫描跳过 . 开头的目录，不再污染列表。
     * 旧目录若为空则顺手删除；不覆盖同名旧文件（冲突时加时间戳后缀）。
     */
    if (pathname === '/api/office/convert/promote' && method === 'POST') {
      const body = await parseBody(ctx);
      const disk = String((body && body.disk) || 'public');
      const srcRel = String((body && body.path) || '').replace(/^\/+/, '');
      if (disk !== 'public' || !/^_convert\/[^/]/.test(srcRel)) {
        return json(res, 400, { error: '仅支持隐藏 public/_convert 下的转换产物' }, ctx) || true;
      }
      const t = ctx.app.resolveTarget({ disk, path: srcRel, _write: true }, ctx.user);
      if (!t || t.error) return json(res, (t && t.code) || 400, { error: (t && t.error) || '路径不可写' }, ctx) || true;
      if (!fs.existsSync(t.abs)) return json(res, 404, { error: '转换产物不存在' }, ctx) || true;
      const root = t.root || path.dirname(path.dirname(t.abs));
      const outDir = path.join(root, '.convert');
      fs.mkdirSync(outDir, { recursive: true });
      // PNG 产物是 _convert/<stem>_png/<page>.png：整个页目录一起移动
      const parentRel = path.posix.dirname(srcRel);
      let destRel;
      if (parentRel !== '_convert') {
        const dirName = path.basename(parentRel);
        let targetDir = path.join(outDir, dirName);
        if (fs.existsSync(targetDir)) targetDir = path.join(outDir, dirName + '-' + Date.now().toString(36));
        fs.renameSync(path.dirname(t.abs), targetDir);
        destRel = '.convert/' + path.basename(targetDir) + '/' + path.basename(t.abs);
      } else {
        let target = path.join(outDir, path.basename(t.abs));
        if (fs.existsSync(target)) {
          const ext = path.extname(target);
          target = path.join(outDir, path.basename(target, ext) + '-' + Date.now().toString(36) + ext);
        }
        fs.renameSync(t.abs, target);
        destRel = '.convert/' + path.basename(target);
      }
      try {
        fs.rmdirSync(path.join(root, '_convert'));
      } catch (e) {
        /* 目录不空（并发转换/旧文件）就保留，下一次再清理 */
      }
      audit(ctx, 'office-convert-hide', srcRel + '->' + destRel, true);
      json(res, 200, { ok: true, disk: 'public', path: destRel, name: path.basename(destRel) }, ctx);
      return true;
    }
    if (pathname === '/api/office/relay' && method === 'GET') {
      // 探测既有 Yjs 中继（单独 systemd unit，8082）是否在线；本模块不依赖它，仅展示
      try {
        const http = require('http');
        const info = await new Promise((resolve) => {
          const r = http.get({ host: '127.0.0.1', port: 8082, path: '/api/ping', timeout: 1200 }, (resp) => {
            let raw = '';
            resp.on('data', (c) => (raw += c));
            resp.on('end', () => {
              try {
                resolve({ ok: true, status: resp.statusCode, body: JSON.parse(raw) });
              } catch (e) {
                resolve({ ok: true, status: resp.statusCode, raw: raw.slice(0, 200) });
              }
            });
          });
          r.on('timeout', () => {
            r.destroy();
            resolve({ ok: false, error: '超时' });
          });
          r.on('error', (e) => resolve({ ok: false, error: e.message }));
        });
        json(res, 200, { ok: true, relay: info, note: '既有 Yjs 中继（station-office.service, 8082）探活；本模块实时通道为同源 SSE' }, ctx);
      } catch (e) {
        json(res, 200, { ok: true, relay: { ok: false, error: e.message } }, ctx);
      }
      return true;
    }

    /* ---------- 文档列表 / 搜索 ---------- */
    if (pathname === '/api/office/docs' && method === 'GET') {
      const items = st.list({ scope: String(query.scope || 'active'), kind: String(query.kind || ''), folder: String(query.folder || ''), q: String(query.q || '') });
      const counts = {};
      for (const it of items) counts[it.id] = (st.comments[it.id] || []).filter((c) => !c.resolved).length;
      json(res, 200, { ok: true, items: items.map((it) => ({ ...it, comments: counts[it.id] || 0, online: hb.usersOf(it.id).length })), folders: st.folders(), total: items.length }, ctx);
      return true;
    }
    if (pathname === '/api/office/doc' && method === 'GET') {
      const id = String(query.id || '');
      const doc = liveDoc(st, hb, id);
      if (!doc) return json(res, 404, { error: '文档不存在' }, ctx) || true;
      json(res, 200, {
        ok: true,
        doc,
        users: hb.usersOf(id),
        comments: st.commentsOf(id),
        versions: st.versions(id).slice(0, 5),
      }, ctx);
      return true;
    }

    /* ---------- 新建 ---------- */
    if (pathname === '/api/office/doc/create' && method === 'POST') {
      const body = await parseBody(ctx);
      if (!body) return json(res, 400, { error: '请求体不是合法 JSON' }, ctx) || true;
      const doc = st.create(ctx.user, { kind: body.kind, title: body.title, folder: body.folder, template: body.template });
      audit(ctx, 'office-create', doc.kind + ':' + doc.title, true);
      json(res, 200, { ok: true, doc }, ctx);
      return true;
    }

    /* ---------- 保存全量（低频/兜底，如版本恢复前的显式保存） ---------- */
    if (pathname === '/api/office/doc/save' && method === 'POST') {
      const body = await parseBody(ctx);
      if (!body || !body.id) return json(res, 400, { error: '缺少 id' }, ctx) || true;
      const doc = liveDoc(st, hb, String(body.id));
      if (!doc) return json(res, 404, { error: '文档不存在' }, ctx) || true;
      if (body.title != null) doc.title = String(body.title).trim().slice(0, 80) || doc.title;
      if (body.folder != null) doc.folder = String(body.folder).trim().slice(0, 40);
      if (body.content && typeof body.content === 'object') doc.content = body.content;
      doc.rev = (doc.rev || 1) + 1;
      doc.updatedAt = Date.now();
      doc.updatedBy = ctx.user.username;
      // 先走 persistDoc（同步更新 index 里的 title/updatedAt/rev），再落盘
      st.persistDoc(doc);
      st.flush(doc);
      st.snapshot(doc, ctx.user.username, 'save');
      const room = hb.rooms.get(doc.id);
      if (room) {
        room.doc = doc;
        room.rev = doc.rev;
        hb.broadcast(room, 'saved', { rev: doc.rev, at: doc.updatedAt });
      }
      audit(ctx, 'office-save', doc.id + ':' + doc.rev, true);
      json(res, 200, { ok: true, doc: { id: doc.id, rev: doc.rev, updatedAt: doc.updatedAt, title: doc.title, folder: doc.folder } }, ctx);
      return true;
    }

    /* ---------- 实时操作 ---------- */
    if (pathname === '/api/office/op' && method === 'POST') {
      const body = await parseBody(ctx);
      if (!body || !body.id) return json(res, 400, { error: '缺少 id' }, ctx) || true;
      const r = hb.apply(String(body.id), Number(body.base) || 0, body.op, ctx.user, String(body.cid || ''));
      if (!r.ok) return json(res, 400, { error: r.error || '操作失败' }, ctx) || true;
      json(res, 200, { ok: true, rev: r.rev, op: r.op, conflict: !!r.conflict }, ctx);
      return true;
    }
    if (pathname === '/api/office/presence' && method === 'POST') {
      const body = await parseBody(ctx, 64 * 1024);
      if (!body || !body.id) return json(res, 400, { error: '缺少 id' }, ctx) || true;
      hb.setPresence(String(body.id), String(body.cid || ''), body.cursor || null);
      json(res, 200, { ok: true, users: hb.usersOf(String(body.id)) }, ctx);
      return true;
    }
    if (pathname === '/api/office/presence' && method === 'GET') {
      const id = String(query.id || '');
      json(res, 200, { ok: true, users: hb.usersOf(id) }, ctx);
      return true;
    }

    /* ---------- SSE 事件流 ---------- */
    if (pathname === '/api/office/events' && method === 'GET') {
      sseHandler(ctx, st, hb);
      return true;
    }

    /* ---------- 元信息（改名/移动/收藏） ---------- */
    if (pathname === '/api/office/doc/meta' && method === 'POST') {
      const body = await parseBody(ctx);
      if (!body || !body.id) return json(res, 400, { error: '缺少 id' }, ctx) || true;
      const doc = liveDoc(st, hb, String(body.id));
      if (!doc) return json(res, 404, { error: '文档不存在' }, ctx) || true;
      if (!canManage(ctx.user, doc) && (body.title != null || body.folder != null)) {
        return json(res, 403, { error: '只有文档所有者或管理员可以改名/移动' }, ctx) || true;
      }
      syncDown(st, hb, String(body.id));
      const r = st.updateMeta(ctx.user, String(body.id), body);
      if (!r.ok) return json(res, 400, { error: r.error }, ctx) || true;
      const room = hb.rooms.get(String(body.id));
      if (room) {
        if (body.title != null) hb.broadcast(room, 'title', { title: r.doc.title, by: ctx.user.username });
        const fresh = st.getDoc(String(body.id));
        if (fresh) room.doc = { ...room.doc, title: fresh.title, folder: fresh.folder, fav: fresh.fav };
      }
      json(res, 200, { ok: true, doc: r.doc }, ctx);
      return true;
    }

    /* ---------- 删除 → 回收站 ---------- */
    if (pathname === '/api/office/doc/remove' && method === 'POST') {
      const body = await parseBody(ctx);
      const doc = liveDoc(st, hb, String((body && body.id) || ''));
      if (!doc) return json(res, 404, { error: '文档不存在' }, ctx) || true;
      if (!canManage(ctx.user, doc)) return json(res, 403, { error: '只有文档所有者或管理员可以删除' }, ctx) || true;
      syncDown(st, hb, doc.id);
      const r = st.remove(ctx.user, doc.id);
      if (!r.ok) return json(res, 400, { error: r.error }, ctx) || true;
      audit(ctx, 'office-remove', doc.id + ':' + doc.title, true);
      json(res, 200, { ok: true, trashed: true, item: r.item, note: '已移入回收站，可在回收站恢复' }, ctx);
      return true;
    }
    if (pathname === '/api/office/trash/restore' && method === 'POST') {
      const body = await parseBody(ctx);
      const r = st.restore(ctx.user, String((body && body.id) || ''));
      if (!r.ok) return json(res, 400, { error: r.error }, ctx) || true;
      audit(ctx, 'office-restore', r.doc.id + ':' + r.doc.title, true);
      json(res, 200, { ok: true, doc: r.doc }, ctx);
      return true;
    }
    if (pathname === '/api/office/trash/purge' && method === 'POST') {
      if (!isAdmin(ctx.user)) return json(res, 403, { error: '只有管理员可以彻底删除' }, ctx) || true;
      const body = await parseBody(ctx);
      const r = body && body.all ? st.emptyTrash() : st.purge(String((body && body.id) || ''));
      if (!r.ok) return json(res, 400, { error: r.error }, ctx) || true;
      audit(ctx, 'office-purge', String((body && body.id) || 'all'), true);
      json(res, 200, { ok: true, removed: r.removed || 1 }, ctx);
      return true;
    }

    /* ---------- 版本 ---------- */
    if (pathname === '/api/office/versions' && method === 'GET') {
      const id = String(query.id || '');
      json(res, 200, { ok: true, versions: st.versions(id) }, ctx);
      return true;
    }
    if (pathname === '/api/office/version/snapshot' && method === 'POST') {
      const body = await parseBody(ctx);
      const doc = liveDoc(st, hb, String((body && body.id) || ''));
      if (!doc) return json(res, 404, { error: '文档不存在' }, ctx) || true;
      syncDown(st, hb, doc.id);
      const v = st.snapshot(doc, ctx.user.username, String((body && body.reason) || 'manual'));
      audit(ctx, 'office-snapshot', doc.id + ':r' + (v && v.rev), true);
      json(res, 200, { ok: true, version: v ? { rev: v.rev, at: v.at, reason: v.reason } : null }, ctx);
      return true;
    }
    if (pathname === '/api/office/version/restore' && method === 'POST') {
      const body = await parseBody(ctx);
      if (!body || !body.id) return json(res, 400, { error: '缺少 id' }, ctx) || true;
      const doc = liveDoc(st, hb, String(body.id));
      if (!doc) return json(res, 404, { error: '文档不存在' }, ctx) || true;
      syncDown(st, hb, doc.id);
      const r = st.restoreVersion(ctx.user, doc.id, Number(body.rev));
      if (!r.ok) return json(res, 400, { error: r.error }, ctx) || true;
      const room = hb.rooms.get(doc.id);
      if (room) {
        room.doc = r.doc;
        room.rev = r.doc.rev;
        hb.broadcast(room, 'saved', { rev: r.doc.rev, at: r.doc.updatedAt, restore: true });
        hb.broadcast(room, 'reload', { rev: r.doc.rev, reason: '版本回滚' });
      }
      audit(ctx, 'office-version-restore', doc.id + ':r' + body.rev, true);
      json(res, 200, { ok: true, doc: r.doc, restoredFrom: r.restoredFrom }, ctx);
      return true;
    }
    if (pathname === '/api/office/version/get' && method === 'GET') {
      const v = st.versionGet(String(query.id || ''), Number(query.rev));
      if (!v) return json(res, 404, { error: '版本不存在' }, ctx) || true;
      json(res, 200, { ok: true, version: v }, ctx);
      return true;
    }

    /* ---------- 评论 ---------- */
    if (pathname === '/api/office/comments' && method === 'GET') {
      json(res, 200, { ok: true, comments: st.commentsOf(String(query.id || '')) }, ctx);
      return true;
    }
    if (pathname === '/api/office/comments/add' && method === 'POST') {
      const body = await parseBody(ctx);
      if (!body || !body.id || !String(body.text || '').trim()) return json(res, 400, { error: '缺少文档或内容' }, ctx) || true;
      const doc = liveDoc(st, hb, String(body.id));
      if (!doc) return json(res, 404, { error: '文档不存在' }, ctx) || true;
      const mentions = Array.isArray(body.mentions) && body.mentions.length ? body.mentions.map(String) : mentionsOf(body.text);
      const r = st.addComment(ctx.user, doc.id, { text: body.text, parent: body.parent || null, mentions });
      if (!r.ok) return json(res, 400, { error: r.error }, ctx) || true;
      const room = hb.rooms.get(doc.id);
      if (room) hb.broadcast(room, 'comment', { action: 'add', comment: r.comment, docId: doc.id, by: ctx.user.username });
      // @提醒：落消息中心 + 若对方正在看这篇文档，实时推过去
      const made = [];
      for (const to of mentions) {
        const item = st.addNotify({
          title: ctx.user.username + ' 在《' + doc.title + '》里提到了你',
          body: String(body.text).slice(0, 200),
          to,
          docId: doc.id,
          docTitle: doc.title,
          from: ctx.user.username,
        });
        made.push(item);
        // 全站消息中心由 lead 的 lib/routes/messages.js 直接聚合 data/office/notify.json
        // （按 to 精确投递），因此这里不再写 board.json，避免一条提醒出现两次。
        if (room) {
          for (const c of room.clients.values()) {
            if (c.user !== to) continue;
            try {
              c.res.write('event: notify\ndata: ' + JSON.stringify({ item }) + '\n\n');
            } catch (e) {
              /* 忽略 */
            }
          }
        }
      }
      // 任务分配：评论里可以顺手"指派给某人"→ 写一条 kind=task 的消息
      // （全站消息中心按 to 精确投递；被指派者若正在看这篇文档，SSE 立即推送）
      let assigned = null;
      const assignee = String((body && body.assignee) || '').trim().slice(0, 40);
      if (assignee && assignee !== ctx.user.username) {
        assigned = st.addNotify({
          kind: 'task',
          title: ctx.user.username + ' 在《' + doc.title + '》里指派任务给 ' + assignee,
          body: String(body.text).slice(0, 200),
          to: assignee,
          docId: doc.id,
          docTitle: doc.title,
          from: ctx.user.username,
          assignee,
        });
        if (room) {
          for (const c of room.clients.values()) {
            if (c.user !== assignee) continue;
            try {
              c.res.write('event: notify\ndata: ' + JSON.stringify({ item: assigned }) + '\n\n');
            } catch (e) {
              /* 忽略 */
            }
          }
        }
      }
      json(res, 200, { ok: true, comment: r.comment, notified: made.map((m) => m.to), assigned: assigned ? { id: assigned.id, to: assignee } : null }, ctx);
      return true;
    }
    if (pathname === '/api/office/comments/resolve' && method === 'POST') {
      const body = await parseBody(ctx);
      const r = st.resolveComment(String((body && body.id) || ''), String((body && body.cid) || ''), !!(body && body.resolved));
      if (!r.ok) return json(res, 400, { error: r.error }, ctx) || true;
      const room = hb.rooms.get(String(body.id));
      if (room) hb.broadcast(room, 'comment', { action: 'resolve', comment: r.comment, docId: body.id });
      json(res, 200, { ok: true, comment: r.comment }, ctx);
      return true;
    }
    if (pathname === '/api/office/comments/remove' && method === 'POST') {
      const body = await parseBody(ctx);
      const r = st.deleteComment(String((body && body.id) || ''), String((body && body.cid) || ''), ctx.user);
      if (!r.ok) return json(res, 400, { error: r.error }, ctx) || true;
      const room = hb.rooms.get(String(body.id));
      if (room) hb.broadcast(room, 'comment', { action: 'remove', cid: body.cid, docId: body.id });
      json(res, 200, { ok: true }, ctx);
      return true;
    }

    /* ---------- 办公消息（@提醒） ---------- */
    if (pathname === '/api/office/notify' && method === 'GET') {
      const items = st.notifications(ctx.user);
      json(res, 200, { ok: true, items, unread: items.filter((n) => !n.read).length }, ctx);
      return true;
    }
    if (pathname === '/api/office/notify/read' && method === 'POST') {
      const body = await parseBody(ctx, 128 * 1024);
      const n = st.markNotifyRead(ctx.user, body && Array.isArray(body.ids) ? body.ids : null);
      json(res, 200, { ok: true, marked: n }, ctx);
      return true;
    }

    /* ---------- 导入 ---------- */
    if (pathname === '/api/office/import' && method === 'POST') {
      const name = String(query.name || req.headers['x-file-name'] || 'import.txt');
      const buf = await readRawBody(ctx, MAX_IMPORT_BYTES);
      const r = convert.importBuffer(buf, name);
      if (!r.ok) {
        audit(ctx, 'office-import', name + ':' + r.error, false);
        return json(res, 400, { error: r.error }, ctx) || true;
      }
      const doc = st.create(ctx.user, { kind: r.kind, title: r.title, folder: String(query.folder || '导入') });
      doc.content = r.content;
      doc.rev = 2;
      doc.updatedAt = Date.now();
      if (r.kind === 'image' || r.kind === 'pdf') {
        const ext = String(name.split('.').pop() || 'bin').toLowerCase();
        const payload = r.content && r.content.data ? Buffer.from(r.content.data, 'base64') : buf;
        doc.content = { ...r.content, file: st.saveAttachment(doc.id, ext, payload) };
        if (r.kind === 'image') {
          // 图片：补真实宽高（ImageMagick identify），预览/导出时用得上
          const info = await convert.imageInfo(payload, ext);
          if (info) doc.content = { ...doc.content, width: info.width, height: info.height };
        } else {
          // PDF：补真实页数（LibreOffice 转 FODG 数 draw:page）；失败则保持未知，前端显示“多页”
          const pages = await convert.pdfPageCount(payload);
          if (pages) doc.content = { ...doc.content, pages };
        }
      }
      st.flush(doc);
      st.snapshot(doc, ctx.user.username, 'import');
      audit(ctx, 'office-import', name + '->' + doc.id + ':' + buf.length + 'B', true);
      json(res, 200, { ok: true, doc, note: r.note, bytes: buf.length }, ctx);
      return true;
    }

    /* ---------- 附件下载（导入的图片/PDF） ---------- */
    if (pathname === '/api/office/attachment' && method === 'GET') {
      const name = String(query.name || '');
      const p = st.attachmentPath(name);
      if (!p) return json(res, 404, { error: '附件不存在' }, ctx) || true;
      const ext = String(name.split('.').pop() || '').toLowerCase();
      const mime = convert.MIME[ext] || 'application/octet-stream';
      const data = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=300' });
      res.end(data);
      return true;
    }

    /* ---------- 导出 ---------- */
    if (pathname === '/api/office/export' && method === 'GET') {
      await exportHandler(ctx, st, hb, String(query.format || 'docx'));
      return true;
    }

    /* ---------- PDF：只读预览 + 另存为文字文档（真实抽文字，非假按钮） ---------- */
    if (pathname === '/api/office/pdf/to-doc' && method === 'POST') {
      const body = await parseBody(ctx);
      const src = liveDoc(st, hb, String((body && body.id) || ''));
      if (!src || src.kind !== 'pdf') return json(res, 400, { error: '不是 PDF 文档' }, ctx) || true;
      const name = src.content && src.content.name;
      const file = name ? st.attachmentPath(String(src.id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.' + name.split('.').pop()) : null;
      const data = src.content && src.content.data ? Buffer.from(src.content.data, 'base64') : file ? fs.readFileSync(file) : null;
      if (!data) return json(res, 404, { error: 'PDF 附件已丢失' }, ctx) || true;
      const ex = await convert.pdfToMarkdown(data);
      const extracted = !!(ex.ok && ex.text && ex.text.trim());
      const text = extracted
        ? ex.text
        : '> 该 PDF 可能是扫描件或使用了嵌入字体，未能抽取文字。\n> 原 PDF 仍可预览；如需编辑请先用带 OCR 的工具转换后再导入。\n';
      const nd = st.create(ctx.user, { kind: 'doc', title: String(src.title || 'PDF') + ' 文字版', folder: src.folder || '导入' });
      nd.content = { text };
      nd.rev = 2;
      nd.updatedAt = Date.now();
      nd.updatedBy = ctx.user.username;
      st.flush(nd);
      st.snapshot(nd, ctx.user.username, 'pdf-to-doc');
      audit(ctx, 'office-pdf-to-doc', src.id + '->' + nd.id + ':' + (extracted ? (ex.chars || 0) + 'chars' : 'no-text'), extracted);
      json(res, 200, { ok: true, doc: nd, extracted, chars: extracted ? ex.chars || 0 : 0, note: extracted ? '已抽取文字并另存为文字文档' : '未抽取到文字（扫描件/嵌入字体），已留空白文档说明' }, ctx);
      return true;
    }

    /* ---------- PDF 首页缩略图（浏览器无内置 PDF 插件时的兜底，无头环境也能看到内容） ---------- */
    if (pathname === '/api/office/pdf/thumb' && method === 'GET') {
      const src = liveDoc(st, hb, String(query.id || ''));
      if (!src || src.kind !== 'pdf') return json(res, 404, { error: 'PDF 文档不存在' }, ctx) || true;
      const name = src.content && src.content.name;
      const file = name ? st.attachmentPath(String(src.id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.' + name.split('.').pop()) : null;
      const data = src.content && src.content.data ? Buffer.from(src.content.data, 'base64') : file ? fs.readFileSync(file) : null;
      if (!data) return json(res, 404, { error: 'PDF 附件已丢失' }, ctx) || true;
      const r = await convert.pdfThumb(data);
      if (!r.ok) return json(res, 500, { error: r.error }, ctx) || true;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': r.buf.length, 'Cache-Control': 'private, max-age=300' });
      res.end(r.buf);
      return true;
    }
    if (pathname === '/api/office/task/assign' && method === 'POST') {
      const body = await parseBody(ctx);
      const doc = liveDoc(st, hb, String((body && body.docId) || ''));
      if (!doc) return json(res, 404, { error: '文档不存在' }, ctx) || true;
      const to = String((body && body.assignee) || '').trim().slice(0, 40);
      if (!to) return json(res, 400, { error: '缺少被指派人' }, ctx) || true;
      if (to === ctx.user.username) return json(res, 400, { error: '不能把任务指派给自己' }, ctx) || true;
      const taskTitle = String((body && body.title) || doc.title || '未命名任务').slice(0, 80);
      const item = st.addNotify({
        kind: 'task',
        title: ctx.user.username + ' 指派任务：' + taskTitle,
        body: String((body && body.note) || '来自文档《' + doc.title + '》').slice(0, 300),
        to,
        docId: doc.id,
        docTitle: doc.title,
        from: ctx.user.username,
        assignee: to,
        due: String((body && body.due) || '').slice(0, 20),
      });
      const room = hb.rooms.get(doc.id);
      if (room) {
        for (const c of room.clients.values()) {
          if (c.user !== to) continue;
          try {
            c.res.write('event: notify\ndata: ' + JSON.stringify({ item }) + '\n\n');
          } catch (e) {
            /* 忽略 */
          }
        }
      }
      audit(ctx, 'office-task-assign', doc.id + '->' + to + ':' + taskTitle, true);
      json(res, 200, { ok: true, task: item }, ctx);
      return true;
    }

    /* ---------- 我的任务（kind=task 的提醒） ---------- */
    if (pathname === '/api/office/tasks' && method === 'GET') {
      const items = st.notifyList.filter((n) => n.kind === 'task' && (!n.to || n.to === ctx.user.username)).slice(0, 100);
      json(res, 200, { ok: true, items }, ctx);
      return true;
    }

    /* ---------- 兼容：按老接口形状取列表（新页面不用，方便对照验收） ---------- */
    if (pathname === '/api/office/docs/compat' && method === 'GET') {
      json(res, 200, { ok: true, items: st.list({ scope: 'active' }) }, ctx);
      return true;
    }

    return false;
  },
};

/**
 * 接口一览（供验收报告引用）
 *   GET  /api/office/health                 运行状态（文档数/房间/在线）
 *   GET  /api/office/capability             导入导出能力矩阵（真实探测 soffice）
 *   GET  /api/office/relay                  既有 Yjs 中继探活
 *   GET  /api/office/docs?scope=&kind=&q=   文档列表（active/fav/trash）
 *   GET  /api/office/doc?id=                文档全文 + 在线名单 + 评论 + 最近版本
 *   POST /api/office/doc/create             {kind,title,folder,template}
 *   POST /api/office/doc/save               {id,title?,folder?,content?} 全量保存（+版本）
 *   POST /api/office/doc/meta               {id,title?,folder?,fav?} 改名/移动/收藏
 *   POST /api/office/doc/remove             {id} 删除→回收站（owner/admin）
 *   POST /api/office/trash/restore|purge    {id} / {all:true}
 *   GET  /api/office/versions?id=           版本列表
 *   POST /api/office/version/snapshot|restore  {id,rev}
 *   GET  /api/office/events?doc=&cid=       SSE：op/presence/comment/notify/title/saved
 *   POST /api/office/op                     {id,base,op} 实时操作（OT/LWW）
 *   GET/POST /api/office/presence           {id,cid,cursor}
 *   GET  /api/office/comments?id=           评论列表
 *   POST /api/office/comments/add|resolve|remove
 *   GET  /api/office/notify                 @提醒消息
 *   POST /api/office/import?name=           原始文件体 → 新文档
 *   GET  /api/office/export?id=&format=     docx/xlsx/pptx/pdf/csv/md/txt/html/json
 *   GET  /api/office/attachment?name=       导入的原文件
 *   GET  /api/notify                        消息中心（合并 @提醒，兼容旧 cfg/recent）
 */

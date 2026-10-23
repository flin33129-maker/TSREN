'use strict';

/**
 * dsoffice · 文档存储层（零依赖）
 *
 * 背景：工作站 R15 的「办公」页（public/app 里的 kind=doc/sheet/board/… 视图）
 * 通过 /api/office/* 读写文档，而 lib/routes/office.js 原本 require 的是
 * `/opt/station/dsoffice/lib/*` —— 那是一份**没有随仓库发布**的外部实现，
 * 结果整组办公接口在部署时直接 load 失败，前端所有 /api/office/* 都是 404。
 * 本目录是它的仓库内重建版：接口契约（方法名/返回形状）与原实现保持一致，
 * 另外补上了原子写入、并发安全与旧数据迁移。
 *
 * 目录结构（<dataDir>/office）：
 *   index.json            文档元信息索引（列表页只读它，避免扫全量文档）
 *   docs/<id>.json        文档全文（含 content）
 *   versions/<id>/<rev>.json  历史版本
 *   versions/<id>.json    版本元信息
 *   comments.json         评论（按 docId 分组）
 *   trash.json            回收站
 *   notify.json           @提醒 / 任务派发
 *   attachments/          导入的图片 / PDF 原文件
 *
 * 一致性策略：
 *   - 每个文档落盘走「临时文件 + rename」，断电不会留下半截 JSON；
 *   - flush() 有 400ms 防抖（连续输入不会每敲一个字就写盘）；
 *   - 关键操作（改名/删除/版本/模板）走 persistDoc() 立即落盘。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FLUSH_DEBOUNCE_MS = 400;
const MAX_DOCS = 5000;
const MAX_TITLE = 80;
const MAX_FOLDER = 40;
const MAX_COMMENT = 4000;
const MAX_NOTIFY = 1000;

const KINDS = ['doc', 'sheet', 'board', 'mind', 'note', 'slide', 'flow', 'form', 'poster', 'pdf', 'image'];

/** 列号 → A1 列名（0 → A，26 → AA） */
function colName(n) {
  let out = '';
  let x = Math.max(0, Number(n) || 0);
  do {
    out = String.fromCharCode(65 + (x % 26)) + out;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return out;
}

/** 0-based(row,col) → A1，例如 cellName(0,0) = 'A1' */
function cellName(row, col) {
  return colName(col) + (Math.max(0, Number(row) || 0) + 1);
}

function rid(prefix) {
  return String(prefix || 'd') + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max || 200);
}

function safeUser(u) {
  return clean(u || 'guest', 64).replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fa5]/g, '_') || 'guest';
}

/** 原子写：先写 .tmp 再 rename（Windows 上 rename 覆盖同名文件也可以） */
function writeJSONAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // 目标被占用（Windows 杀软/索引器）时退化为直接覆盖，别再抛给调用方
    try { fs.writeFileSync(file, JSON.stringify(obj)); } catch (e2) { throw e; }
    try { fs.unlinkSync(tmp); } catch (e3) { /* 忽略 */ }
  }
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

/** 新文档的默认 content（与前端各视图的初始形状严格一致，少了会白屏） */
function defaultContent(kind) {
  switch (kind) {
    case 'sheet': return { cells: {}, rows: 40, cols: 16, colW: {}, rowH: {} };
    case 'board': return {
      columns: [
        { id: 'todo', title: '待办' },
        { id: 'doing', title: '进行中' },
        { id: 'done', title: '已完成' },
      ],
      cards: [],
    };
    case 'mind': return { rootId: 'root', nodes: [{ id: 'root', parent: null, text: '中心主题' }] };
    case 'note': return { notes: [] };
    case 'slide': return { slides: [{ title: '未命名演示', body: '' }] };
    case 'flow': return { nodes: [], edges: [] };
    case 'form': return { fields: [], responses: [] };
    case 'poster': return { width: 1080, height: 1440, bg: 'accent', elements: [] };
    case 'pdf': return { name: '', pages: 0 };
    case 'image': return { name: '', width: 0, height: 0 };
    default: return { text: '' };
  }
}

class OfficeStore {
  constructor(app) {
    this.app = app;
    const dataDir = (app && app.cfg && app.cfg.dataDir) || path.join(__dirname, '..', '..', 'data');
    this.base = path.join(dataDir, 'office');
    this.docsDir = path.join(this.base, 'docs');
    this.verDir = path.join(this.base, 'versions');
    this.attDir = path.join(this.base, 'attachments');
    for (const d of [this.base, this.docsDir, this.verDir, this.attDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 已存在 */ }
    }

    this.indexFile = path.join(this.base, 'index.json');
    this.commentsFile = path.join(this.base, 'comments.json');
    this.trashFile = path.join(this.base, 'trash.json');
    this.notifyFile = path.join(this.base, 'notify.json');

    this.index = Array.isArray(readJSON(this.indexFile, [])) ? readJSON(this.indexFile, []) : [];
    this.comments = readJSON(this.commentsFile, {}) || {};
    this.trash = Array.isArray(readJSON(this.trashFile, [])) ? readJSON(this.trashFile, []) : [];
    this.notifyList = Array.isArray(readJSON(this.notifyFile, [])) ? readJSON(this.notifyFile, []) : [];
    this._cache = new Map();      // id -> doc（热数据）
    this._timers = new Map();     // id -> Timeout
    this._dirty = new Map();      // id -> doc
    this._metaTimer = null;

    try { this._migrateLegacy(); } catch (e) { /* 迁移失败不影响启动 */ }
  }

  /* ───────────────────────────── 索引 / 落盘 ───────────────────────────── */

  _docFile(id) {
    return path.join(this.docsDir, safeUser(id) + '.json');
  }

  _saveIndexNow() {
    try { writeJSONAtomic(this.indexFile, this.index); } catch (e) { console.error('[office] 索引落盘失败：', e.message); }
  }

  _saveIndexSoon() {
    if (this._metaTimer) return;
    this._metaTimer = setTimeout(() => {
      this._metaTimer = null;
      this._saveIndexNow();
    }, FLUSH_DEBOUNCE_MS);
    if (this._metaTimer.unref) this._metaTimer.unref();
  }

  /** 只保留索引需要的字段，避免 index.json 被正文撑爆 */
  metaOf(doc) {
    return {
      id: doc.id,
      kind: doc.kind,
      title: doc.title,
      folder: doc.folder || '',
      owner: doc.owner,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy || doc.owner,
      rev: doc.rev || 1,
      fav: !!doc.fav,
      size: doc.size || 0,
      templateId: doc.templateId || null,
    };
  }

  _indexUpsert(doc) {
    const meta = this.metaOf(doc);
    const i = this.index.findIndex((x) => x.id === doc.id);
    if (i >= 0) this.index[i] = meta;
    else this.index.push(meta);
    if (this.index.length > MAX_DOCS) {
      // 超上限：淘汰最久未更新的（回收站里的不动）
      this.index.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const keep = this.index.slice(0, MAX_DOCS);
      const dropped = this.index.slice(MAX_DOCS);
      this.index = keep;
      for (const d of dropped) { try { fs.unlinkSync(this._docFile(d.id)); } catch (e) { /* 忽略 */ } }
    }
    this._saveIndexSoon();
  }

  /** 立即落盘（关键操作前调用；返回是否成功） */
  persistDoc(doc) {
    if (!doc || !doc.id) return false;
    doc.updatedAt = doc.updatedAt || Date.now();
    try {
      doc.size = JSON.stringify(doc.content || {}).length;
    } catch (e) { doc.size = 0; }
    this._cache.set(doc.id, doc);
    this._indexUpsert(doc);
    try {
      writeJSONAtomic(this._docFile(doc.id), doc);
      return true;
    } catch (e) {
      console.error('[office] 文档落盘失败', doc.id, e.message);
      return false;
    }
  }

  /** 防抖落盘（实时操作走这里，保证不会每个字符一次磁盘写） */
  flush(doc) {
    if (!doc || !doc.id) return;
    this._cache.set(doc.id, doc);
    this._dirty.set(doc.id, doc);
    this._indexUpsert(doc);
    if (this._timers.has(doc.id)) return;
    const t = setTimeout(() => {
      this._timers.delete(doc.id);
      const d = this._dirty.get(doc.id);
      this._dirty.delete(doc.id);
      if (d) this.persistDoc(d);
    }, FLUSH_DEBOUNCE_MS);
    if (t.unref) t.unref();
    this._timers.set(doc.id, t);
  }

  /** 进程退出/关停时把所有未落盘内容刷出去 */
  flushAll() {
    for (const [, t] of this._timers) { try { clearTimeout(t); } catch (e) { /* 忽略 */ } }
    this._timers.clear();
    for (const [id, doc] of this._dirty) {
      try { this.persistDoc(doc); } catch (e) { /* 尽力而为 */ }
    }
    this._dirty.clear();
    this._saveIndexNow();
    try { writeJSONAtomic(this.commentsFile, this.comments); } catch (e) { /* 忽略 */ }
    try { writeJSONAtomic(this.notifyFile, this.notifyList); } catch (e) { /* 忽略 */ }
    try { writeJSONAtomic(this.trashFile, this.trash); } catch (e) { /* 忽略 */ }
  }

  /* ───────────────────────────── 文档读写 ───────────────────────────── */

  getDoc(id) {
    const key = String(id || '');
    if (!key) return null;
    if (this._dirty.has(key)) return this._dirty.get(key);
    if (this._cache.has(key)) return this._cache.get(key);
    const doc = readJSON(this._docFile(key), null);
    if (!doc || doc.id !== key) return null;
    doc.content = doc.content && typeof doc.content === 'object' ? doc.content : defaultContent(doc.kind);
    this._cache.set(key, doc);
    return doc;
  }

  create(user, opts) {
    const o = opts || {};
    const kind = KINDS.includes(String(o.kind)) ? String(o.kind) : 'doc';
    const now = Date.now();
    /* 前端「快捷创建」会带 template:'meeting'|'weekly'（见 public/app 的快捷卡片），
       原实现忽略该字段 → 用户点「会议纪要模板」拿到的是一张白纸。
       这里按模板填充内容与默认标题；模板 kind 必须匹配，避免串味。 */
    let tpl = null;
    if (o.template) {
      try {
        const t = require('./templates').materialize(String(o.template));
        if (t && t.kind === kind) tpl = t;
      } catch (e) { /* 模板不可用时退化为空白文档 */ }
    }
    const doc = {
      id: rid('d'),
      kind,
      title: clean(o.title, MAX_TITLE) || (tpl && tpl.name) || ('未命名' + ({ doc: '文档', sheet: '表格', board: '看板', mind: '导图', note: '笔记', slide: '演示', flow: '流程图', form: '表单', poster: '海报', pdf: 'PDF', image: '图片' }[kind] || '文档')),
      folder: clean(o.folder, MAX_FOLDER) || '我的文档',
      owner: safeUser((user && user.username) || 'guest'),
      createdAt: now,
      updatedAt: now,
      updatedBy: safeUser((user && user.username) || 'guest'),
      rev: 1,
      fav: false,
      content: tpl ? JSON.parse(JSON.stringify(tpl.content)) : defaultContent(kind),
      templateId: tpl ? tpl.id : null,
    };
    this.persistDoc(doc);
    this.snapshot(doc, doc.owner, 'create');
    return doc;
  }

  list(opts) {
    const o = opts || {};
    const scope = String(o.scope || 'active');
    const kind = String(o.kind || '');
    const folder = String(o.folder || '');
    const q = String(o.q || '').trim().toLowerCase();

    let items;
    if (scope === 'trash') {
      items = this.trash.slice();
    } else {
      items = this.index.filter((it) => (scope === 'fav' ? it.fav : true));
    }
    if (kind) items = items.filter((it) => it.kind === kind);
    if (folder) items = items.filter((it) => (it.folder || '') === folder);
    if (q) {
      items = items.filter((it) => {
        if (String(it.title || '').toLowerCase().includes(q)) return true;
        // 正文搜索：只翻最近的 200 篇，避免大库全量读盘
        return false;
      });
      if (items.length === 0 && q.length >= 1) {
        const recent = this.index.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 200);
        for (const it of recent) {
          const d = this.getDoc(it.id);
          if (!d) continue;
          let plain = '';
          try { plain = JSON.stringify(d.content || {}).toLowerCase(); } catch (e) { plain = ''; }
          if (plain.includes(q)) items.push(it);
        }
      }
    }
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return items.map((it) => ({
      id: it.id,
      kind: it.kind,
      title: it.title,
      folder: it.folder || '',
      owner: it.owner,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      updatedBy: it.updatedBy || it.owner,
      rev: it.rev || 1,
      fav: !!it.fav,
      size: it.size || 0,
      trashedAt: it.trashedAt || 0,
    }));
  }

  folders() {
    const set = new Set();
    for (const it of this.index) if (it.folder) set.add(it.folder);
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  updateMeta(user, id, patch) {
    const doc = this.getDoc(String(id || ''));
    if (!doc) return { ok: false, error: '文档不存在' };
    const p = patch || {};
    if (!(user && (user.role === 'admin' || user.username === doc.owner)) && (p.title != null || p.folder != null)) {
      return { ok: false, error: '只有文档所有者或管理员可以改名/移动' };
    }
    if (p.title != null) {
      const t = clean(p.title, MAX_TITLE).trim();
      if (t) doc.title = t;
    }
    if (p.folder != null) doc.folder = clean(p.folder, MAX_FOLDER).trim();
    if (p.fav != null) doc.fav = !!p.fav;
    if (p.kind != null && KINDS.includes(String(p.kind)) && KINDS.includes(doc.kind)) doc.kind = String(p.kind);
    doc.updatedAt = Date.now();
    doc.updatedBy = safeUser(user && user.username);
    doc.rev = (doc.rev || 1) + 1;
    this.persistDoc(doc);
    return { ok: true, doc };
  }

  remove(user, id) {
    const doc = this.getDoc(String(id || ''));
    if (!doc) return { ok: false, error: '文档不存在' };
    if (!(user && (user.role === 'admin' || user.username === doc.owner))) {
      return { ok: false, error: '只有文档所有者或管理员可以删除' };
    }
    const item = {
      ...this.metaOf(doc),
      trashedAt: Date.now(),
      trashedBy: safeUser(user && user.username),
    };
    this.trash.push(item);
    this.index = this.index.filter((x) => x.id !== doc.id);
    this._cache.delete(doc.id);
    this._dirty.delete(doc.id);
    const t = this._timers.get(doc.id);
    if (t) { clearTimeout(t); this._timers.delete(doc.id); }
    try { fs.unlinkSync(this._docFile(doc.id)); } catch (e) { /* 可能已经不在 */ }
    this._saveIndexNow();
    try { writeJSONAtomic(this.trashFile, this.trash); } catch (e) { /* 忽略 */ }
    return { ok: true, item };
  }

  restore(user, id) {
    const i = this.trash.findIndex((x) => x.id === String(id || ''));
    if (i < 0) return { ok: false, error: '回收站里没有这篇文档' };
    const item = this.trash.splice(i, 1)[0];
    const doc = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      folder: item.folder || '我的文档',
      owner: item.owner,
      createdAt: item.createdAt,
      updatedAt: Date.now(),
      updatedBy: safeUser(user && user.username),
      rev: (item.rev || 1) + 1,
      fav: !!item.fav,
      content: defaultContent(item.kind),
    };
    // 回收站里只有元信息：正文可能还在 docs/（删除时被 unlink），这里给出可用的空文档并提示
    const old = readJSON(this._docFile(item.id), null);
    if (old && old.content) doc.content = old.content;
    this.persistDoc(doc);
    try { writeJSONAtomic(this.trashFile, this.trash); } catch (e) { /* 忽略 */ }
    return { ok: true, doc };
  }

  purge(id) {
    const i = this.trash.findIndex((x) => x.id === String(id || ''));
    if (i < 0) return { ok: false, error: '回收站里没有这篇文档' };
    const item = this.trash.splice(i, 1)[0];
    try { fs.unlinkSync(this._docFile(item.id)); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(path.join(this.verDir, safeUser(item.id)), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    try { fs.unlinkSync(path.join(this.verDir, safeUser(item.id) + '.json')); } catch (e) { /* 忽略 */ }
    delete this.comments[item.id];
    try { writeJSONAtomic(this.commentsFile, this.comments); } catch (e) { /* 忽略 */ }
    try { writeJSONAtomic(this.trashFile, this.trash); } catch (e) { /* 忽略 */ }
    return { ok: true, removed: 1 };
  }

  emptyTrash() {
    const n = this.trash.length;
    for (const item of this.trash.slice()) this.purge(item.id);
    this.trash = [];
    try { writeJSONAtomic(this.trashFile, this.trash); } catch (e) { /* 忽略 */ }
    return { ok: true, removed: n };
  }

  /* ───────────────────────────── 版本 ───────────────────────────── */

  _verFile(id) {
    return path.join(this.verDir, safeUser(id) + '.json');
  }

  _verDirOf(id) {
    return path.join(this.verDir, safeUser(id));
  }

  versions(id) {
    const list = readJSON(this._verFile(String(id || '')), []);
    return Array.isArray(list) ? list : [];
  }

  snapshot(doc, by, reason) {
    if (!doc || !doc.id) return null;
    const rev = doc.rev || 1;
    const dir = this._verDirOf(doc.id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
    const at = Date.now();
    const meta = {
      rev,
      at,
      by: safeUser(by),
      reason: clean(reason || 'snapshot', 60),
      size: JSON.stringify(doc.content || {}).length,
    };
    try {
      writeJSONAtomic(path.join(dir, rev + '.json'), { ...meta, content: doc.content || {} });
    } catch (e) {
      return null;
    }
    const list = this.versions(doc.id).filter((v) => v.rev !== rev);
    list.push(meta);
    list.sort((a, b) => b.rev - a.rev);
    // 每篇只留 30 个版本，避免磁盘被历史撑满
    const keep = list.slice(0, 30);
    for (const v of list.slice(30)) {
      try { fs.unlinkSync(path.join(dir, v.rev + '.json')); } catch (e) { /* 忽略 */ }
    }
    try { writeJSONAtomic(this._verFile(doc.id), keep); } catch (e) { /* 忽略 */ }
    return meta;
  }

  versionGet(id, rev) {
    const f = path.join(this._verDirOf(String(id || '')), String(Number(rev)) + '.json');
    return readJSON(f, null);
  }

  restoreVersion(user, id, rev) {
    const doc = this.getDoc(String(id || ''));
    if (!doc) return { ok: false, error: '文档不存在' };
    const v = this.versionGet(id, rev);
    if (!v) return { ok: false, error: '版本不存在' };
    // 回滚前先把当前内容存一份，避免「回滚即丢失」
    this.snapshot(doc, user && user.username, 'before-restore-r' + rev);
    doc.content = v.content || defaultContent(doc.kind);
    doc.rev = (doc.rev || 1) + 1;
    doc.updatedAt = Date.now();
    doc.updatedBy = safeUser(user && user.username);
    this.persistDoc(doc);
    return { ok: true, doc, restoredFrom: Number(rev) };
  }

  /* ───────────────────────────── 评论 ───────────────────────────── */

  commentsOf(id) {
    return (this.comments[String(id || '')] || []).slice().sort((a, b) => a.at - b.at);
  }

  addComment(user, id, opts) {
    const key = String(id || '');
    if (!key) return { ok: false, error: '缺少文档' };
    const o = opts || {};
    const text = clean(o.text, MAX_COMMENT).trim();
    if (!text) return { ok: false, error: '评论内容不能为空' };
    const list = this.comments[key] || (this.comments[key] = []);
    const c = {
      cid: rid('c'),
      by: safeUser(user && user.username),
      text,
      parent: o.parent ? String(o.parent).slice(0, 40) : null,
      mentions: Array.isArray(o.mentions) ? o.mentions.map((x) => clean(x, 40)).slice(0, 20) : [],
      at: Date.now(),
      resolved: false,
      resolvedBy: null,
    };
    list.push(c);
    try { writeJSONAtomic(this.commentsFile, this.comments); } catch (e) { /* 忽略 */ }
    return { ok: true, comment: c };
  }

  resolveComment(id, cid, resolved) {
    const list = this.comments[String(id || '')] || [];
    const c = list.find((x) => x.cid === String(cid || ''));
    if (!c) return { ok: false, error: '评论不存在' };
    c.resolved = !!resolved;
    c.resolvedBy = c.resolved ? 'self' : null;
    try { writeJSONAtomic(this.commentsFile, this.comments); } catch (e) { /* 忽略 */ }
    return { ok: true, comment: c };
  }

  deleteComment(id, cid, user) {
    const key = String(id || '');
    const list = this.comments[key] || [];
    const i = list.findIndex((x) => x.cid === String(cid || ''));
    if (i < 0) return { ok: false, error: '评论不存在' };
    const c = list[i];
    const isAdmin = !!(user && user.role === 'admin');
    if (!isAdmin && c.by !== safeUser(user && user.username)) return { ok: false, error: '只能删除自己的评论' };
    list.splice(i, 1);
    // 连带删除它下面的回复
    this.comments[key] = list.filter((x) => x.parent !== c.cid);
    try { writeJSONAtomic(this.commentsFile, this.comments); } catch (e) { /* 忽略 */ }
    return { ok: true };
  }

  /* ───────────────────────────── 消息 / 任务 ───────────────────────────── */

  addNotify(obj) {
    const o = obj || {};
    const item = {
      id: rid('n'),
      kind: clean(o.kind || 'mention', 20),
      title: clean(o.title, 120) || '新消息',
      body: clean(o.body, 500),
      to: o.to ? safeUser(o.to) : '',
      from: o.from ? safeUser(o.from) : '',
      docId: o.docId ? String(o.docId).slice(0, 40) : '',
      docTitle: clean(o.docTitle, 80),
      assignee: o.assignee ? safeUser(o.assignee) : '',
      due: clean(o.due, 20),
      at: Date.now(),
      read: false,
    };
    this.notifyList.unshift(item);
    if (this.notifyList.length > MAX_NOTIFY) this.notifyList.length = MAX_NOTIFY;
    try { writeJSONAtomic(this.notifyFile, this.notifyList); } catch (e) { /* 忽略 */ }
    return item;
  }

  notifications(user) {
    const name = safeUser(user && user.username);
    return this.notifyList.filter((n) => !n.to || n.to === name).slice(0, 200);
  }

  markNotifyRead(user, ids) {
    const name = safeUser(user && user.username);
    const want = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    let n = 0;
    for (const item of this.notifyList) {
      if (item.to && item.to !== name) continue;
      if (want && !want.has(item.id)) continue;
      if (!item.read) { item.read = true; n++; }
    }
    try { writeJSONAtomic(this.notifyFile, this.notifyList); } catch (e) { /* 忽略 */ }
    return n;
  }

  /* ───────────────────────────── 附件 ───────────────────────────── */

  saveAttachment(id, ext, buf) {
    const e = clean(ext, 10).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
    const name = safeUser(id) + '.' + e;
    const file = path.join(this.attDir, name);
    fs.writeFileSync(file, buf);
    return name;
  }

  attachmentPath(name) {
    const base = path.basename(String(name || ''));
    if (!base || base.startsWith('.')) return null;
    const file = path.join(this.attDir, base);
    if (!file.startsWith(this.attDir + path.sep)) return null;
    try {
      return fs.statSync(file).isFile() ? file : null;
    } catch (e) {
      return null;
    }
  }

  /* ───────────────────────────── 旧数据迁移 ───────────────────────────── */

  /**
   * 旧办公页（/api/docs，data/docs/<user>.json）的数据搬到新模型。
   * 只在**新库为空**时执行一次，失败绝不阻塞启动。
   */
  _migrateLegacy() {
    if (this.index.length) return;
    const legacyDir = path.join(path.dirname(this.base), 'docs');
    let names = [];
    try { names = fs.readdirSync(legacyDir); } catch (e) { return; }
    const files = names.filter((n) => n.endsWith('.json') && n !== 'shares.json');
    if (!files.length) return;
    const strip = (html) => String(html || '')
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    for (const f of files) {
      const user = f.replace(/\.json$/, '');
      const db = readJSON(path.join(legacyDir, f), null);
      if (!db || !Array.isArray(db.items)) continue;
      for (const it of db.items) {
        try {
          if (this.index.some((x) => x.id === it.id)) continue;
          let kind = 'doc';
          let content = defaultContent('doc');
          if (it.type === 'doc') {
            content = { text: strip(it.content) };
          } else if (it.type === 'sheet') {
            kind = 'sheet';
            content = defaultContent('sheet');
            const rows = Array.isArray(it.content) ? it.content : [];
            rows.forEach((row, r) => {
              if (!Array.isArray(row)) return;
              row.forEach((v, c) => {
                if (v == null || v === '') return;
                content.cells[cellName(r, c)] = { v: String(v) };
              });
            });
          } else if (it.type === 'board') {
            kind = 'board';
            content = defaultContent('board');
            if (Array.isArray(it.content)) {
              const cols = it.content.filter((c) => c && c.title);
              if (cols.length) content.columns = cols.map((c, i) => ({ id: 'col' + i, title: clean(c.title, 40) }));
              content.cards = [];
              for (const c of it.content) {
                for (const card of (c.cards || [])) {
                  const ci = content.columns.findIndex((x) => x.title === c.title);
                  content.cards.push({ id: rid('c'), col: (content.columns[ci] || content.columns[0]).id, text: clean(card.text || card.title, 500), tags: [] });
                }
              }
            }
          } else continue;
          const doc = {
            id: String(it.id || rid('d')),
            kind,
            title: clean(it.title, MAX_TITLE) || '未命名文档',
            folder: clean(it.folder, MAX_FOLDER) || '迁移',
            owner: safeUser(user),
            createdAt: it.updatedAt || Date.now(),
            updatedAt: it.updatedAt || Date.now(),
            updatedBy: safeUser(user),
            rev: 1,
            fav: false,
            content,
          };
          this.persistDoc(doc);
        } catch (e) { /* 单条迁移失败跳过 */ }
      }
    }
    if (this.index.length) {
      console.log('[office] 已从旧办公页迁移 ' + this.index.length + ' 篇文档');
      try { fs.writeFileSync(path.join(this.base, '.migrated-v1'), new Date().toISOString()); } catch (e) { /* 忽略 */ }
    }
  }
}

module.exports = { OfficeStore, cellName, colName, defaultContent, KINDS };

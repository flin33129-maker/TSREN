'use strict';

/* =====================================================================
   lib/docs.js — 办公工作区存储（文档 / 表格 / 看板）
   按用户分文件：<dataDir>/docs/<username>.json
   结构：{ items: [{ id, type, title, content, updatedAt }] }
   type: doc(富文本 HTML) | sheet(二维数组 JSON) | board(三列看板 JSON)
   上限 300 条，超出淘汰最旧；写盘 500ms 合并。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 300;
const SAVE_DEBOUNCE_MS = 500;
const MAX_CONTENT = 512 * 1024;

class Docs {
  constructor(srv) {
    this.srv = srv;
    this.dir = path.join(srv.cfg.dataDir, 'docs');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) {}
    this.timers = new Map();
    this.shareFile = path.join(this.dir, 'shares.json');
  }

  file(user) {
    const safe = String(user || 'guest').replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.dir, safe + '.json');
  }

  load(user) {
    try {
      const raw = fs.readFileSync(this.file(user), 'utf8');
      const j = JSON.parse(raw);
      if (Array.isArray(j.items)) return j;
    } catch (e) {}
    return { items: [] };
  }

  save(user) {
    const db = this.load(user);
    return this.write(user, db);
  }

  write(user, db) {
    const file = this.file(user);
    fs.writeFileSync(file + '.tmp', JSON.stringify(db));
    fs.renameSync(file + '.tmp', file);
    return db;
  }

  schedule(user) {
    if (this.timers.has(user)) return;
    this.timers.set(user, setTimeout(() => {
      this.timers.delete(user);
      try { this.write(user, this.load(user)); } catch (e) {}
    }, SAVE_DEBOUNCE_MS));
  }

  list(user, opts) {
    const db = this.load(user);
    const type = (opts && opts.type) || '';
    return db.items
      .filter((it) => !type || it.type === type)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((it) => ({ id: it.id, type: it.type, title: it.title, folder: it.folder || '', updatedAt: it.updatedAt }));
  }

  folders(user) {
    const set = new Set();
    this.load(user).items.forEach((it) => { if (it.folder) set.add(it.folder); });
    return [...set].sort();
  }

  get(user, id) {
    const db = this.load(user);
    return db.items.find((it) => it.id === id) || null;
  }

  upsert(user, o) {
    const db = this.load(user);
    const now = Date.now();
    let item = o.id ? db.items.find((it) => it.id === o.id) : null;
    const content = typeof o.content === 'string' ? o.content.slice(0, MAX_CONTENT) : '';
    if (!item) {
      item = {
        id: crypto.randomBytes(9).toString('hex'),
        type: o.type || 'doc',
        title: '',
        content: '',
        updatedAt: now,
      };
      db.items.unshift(item);
    }
    if (o.type) item.type = o.type;
    if (typeof o.title === 'string' && o.title.trim()) item.title = o.title.trim().slice(0, 120);
    if (typeof o.folder === 'string') item.folder = o.folder.trim().slice(0, 40);
    if (typeof o.comments === 'string') item.comments = o.comments.slice(0, 20000);
    item.content = content;
    item.updatedAt = now;
    if (db.items.length > MAX_ITEMS) db.items = db.items.slice(0, MAX_ITEMS);
    this.write(user, db);
    return { ok: true, item };
  }

  remove(user, id) {
    const db = this.load(user);
    const i = db.items.findIndex((it) => it.id === id);
    if (i < 0) return { ok: false, error: '不存在' };
    const [item] = db.items.splice(i, 1);
    this.write(user, db);
    return { ok: true, item };
  }
}

Docs.prototype.createShare = function (user, id) {
  const it = this.get(user, id);
  if (!it) return { ok: false, error: '文档不存在' };
  let db = {};
  try { db = JSON.parse(fs.readFileSync(this.shareFile, 'utf8')); } catch (e) {}
  const token = crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16);
  db[token] = { user, id, createdAt: Date.now() };
  fs.writeFileSync(this.shareFile, JSON.stringify(db));
  return { ok: true, token, url: '/work.html?share=' + token };
};

Docs.prototype.getShare = function (token) {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(this.shareFile, 'utf8')); } catch (e) {}
  const rec = db[String(token || '')];
  if (!rec) return { ok: false, error: '分享不存在或已失效' };
  const it = this.get(rec.user, rec.id);
  if (!it) return { ok: false, error: '文档已被删除' };
  return { ok: true, item: { title: it.title, type: it.type, content: it.content, updatedAt: it.updatedAt } };
};

Docs.prototype.revokeShare = function (user, id) {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(this.shareFile, 'utf8')); } catch (e) {}
  let n = 0;
  Object.keys(db).forEach((k) => { if (db[k].user === user && db[k].id === id) { delete db[k]; n++; } });
  fs.writeFileSync(this.shareFile, JSON.stringify(db));
  return { ok: true, revoked: n };
};

module.exports = { Docs };

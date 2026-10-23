'use strict';

/* =====================================================================
   lib/board.js — 跨设备协同板（共享剪贴板 + 消息板）
   手机复制一段链接，PC 立刻能粘贴——这是「工作站」最直观的价值。

   能力：
     - 文本/链接/路径条目，带来源设备与操作人
     - 10s 内相同内容去重（手机端重复点击不发两条）
     - 上限 200 条，自动淘汰最老
     - kind: text | link | path | note
     - 事件：board.item / board.remove / board.clear（经 hub 广播）
   落盘：<dataDir>/board.json（1s 合并写）
   零依赖。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 200;
const DEDUP_MS = 10 * 1000;
const SAVE_DEBOUNCE_MS = 1000;
const MAX_TEXT = 8192;

class Board {
  constructor(srv) {
    this.srv = srv;
    this.file = path.join(srv.cfg.dataDir, 'board.json');
    this.items = [];             // 旧 → 新
    this._saveTimer = null;
    this._load();
  }

  /* ------------------------------ 落盘 ------------------------------ */

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) this.items = raw.filter((x) => x && x.id).slice(-MAX_ITEMS);
    } catch { /* 首次启动 */ }
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2)); } catch { /* 忽略 */ }
  }

  /* ------------------------------ 写入 ------------------------------ */

  /**
   * 投一条内容到协同板。
   * @param {object} o { text, kind, device, deviceName, user, pinned }
   * @returns {{ok:boolean, item?:object, duplicate?:boolean, error?:string}}
   */
  post(o = {}) {
    let text = String(o.text == null ? '' : o.text);
    if (!text.trim()) return { ok: false, error: '内容不能为空' };
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

    const kind = normKind(o.kind) || autoKind(text);
    const now = Date.now();

    // 去重：同内容 10s 内只留一条（改为刷新时间戳，避免重复噪声）
    const dup = this.items.find(
      (x) => x.text === text && now - x.ts < DEDUP_MS && (x.device || '') === String(o.device || '')
    );
    if (dup) { dup.ts = now; this._saveSoon(); return { ok: true, item: dup, duplicate: true }; }

    const item = {
      id: crypto.randomBytes(5).toString('hex'),
      text,
      kind,
      device: String(o.device || ''),
      deviceName: String(o.deviceName || ''),
      user: String(o.user || ''),
      pinned: !!o.pinned,
      ts: now,
    };
    this.items.push(item);
    this._trim();
    this._saveSoon();
    this._publish('board.item', item);
    return { ok: true, item };
  }

  remove(id, byUser) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: '条目不存在' };
    const [item] = this.items.splice(i, 1);
    this._saveSoon();
    this._publish('board.remove', { id, by: byUser || '' });
    return { ok: true, item };
  }

  clear(byUser) {
    const n = this.items.length;
    this.items = [];
    this._saveSoon();
    this._publish('board.clear', { removed: n, by: byUser || '' });
    return { ok: true, removed: n };
  }

  pin(id, pinned) {
    const item = this.items.find((x) => x.id === id);
    if (!item) return { ok: false, error: '条目不存在' };
    item.pinned = pinned === undefined ? !item.pinned : !!pinned;
    this._saveSoon();
    this._publish('board.item', item);
    return { ok: true, item };
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 置顶优先，其余按时间倒序 */
  list(limit = 60) {
    const sorted = [...this.items].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.ts - a.ts;
    });
    return sorted.slice(0, Math.max(1, Number(limit) || 60));
  }

  /** 最近一条（手机端轮询兜底用） */
  latest() { return this.items.length ? this.items[this.items.length - 1] : null; }

  stats() {
    const kinds = {};
    for (const x of this.items) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
    return {
      count: this.items.length,
      max: MAX_ITEMS,
      pinned: this.items.filter((x) => x.pinned).length,
      kinds,
      latest: this.items.length ? this.items[this.items.length - 1].ts : 0,
    };
  }

  /* ------------------------------ 内部 ------------------------------ */

  _trim() {
    if (this.items.length <= MAX_ITEMS) return;
    // 置顶的尽量留，先淘汰最老的未置顶项
    const overflow = this.items.length - MAX_ITEMS;
    let removed = 0;
    for (let i = 0; i < this.items.length && removed < overflow; i++) {
      if (!this.items[i].pinned) { this.items.splice(i, 1); i--; removed++; }
    }
    if (removed < overflow) this.items.splice(0, overflow - removed);
  }

  _publish(type, data) {
    if (this.srv && this.srv.hub) {
      try { this.srv.hub.publish('board', type, data); } catch { /* 忽略 */ }
    }
  }
}

/* ------------------------------ 工具 ------------------------------ */

const KINDS = ['text', 'link', 'path', 'note'];

function normKind(k) {
  const v = String(k || '').toLowerCase().trim();
  return KINDS.includes(v) ? v : '';
}

/** 无 kind 时按内容猜：URL → link，绝对路径 → path，多行 → note */
function autoKind(text) {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return 'link';
  if (/^(\/|[A-Za-z]:\\|\/data\/|\/storage\/)\S*$/.test(t) && !t.includes('\n')) return 'path';
  if (t.includes('\n')) return 'note';
  return 'text';
}

module.exports = { Board, MAX_ITEMS };

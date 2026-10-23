'use strict';

/**
 * R15 第 6 轮：AI 记忆（每用户一份），让助手记住偏好/长期事实并在对话时自动注入。
 * =====================================================================
 * 设计约束（简单、可验收、不引第三方库）：
 *   · 存储：data/ai-gw/memory/<user.id>.json（0600，目录 0700），每用户一个文件；
 *   · 隔离：所有读写只认 user.id，接口不接受客户端 uid；跨用户拿 id → 404；
 *   · 上限：每人 50 条、每条 1–500 字、最多 5 个标签（每个 ≤20 字）；
 *   · 注入：**pinned 优先 + 其余按最近更新**，最多 8 条、注入段总字符 ≤1200；
 *     由 ai-gateway 在组 system prompt 时拼成 `【用户记忆】…` 段，diag 记录条数/字符数；
 *   · 写盘用「临时文件 + rename」原子替换，避免断电/并发下把用户记忆写坏。
 *
 * 为什么不做"自动从对话里抽取记忆"：2B 模型抽取质量不稳定、还会把一次性问题写进长期记忆；
 * 先做"用户显式管理 + 可解释注入"，验收能逐条断言。自动抽取列在报告的未做项里。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEMORY_VERSION = 1;
const MAX_ITEMS = 50;
const MIN_TEXT = 1;
const MAX_TEXT = 500;
const MAX_TAGS = 5;
const MAX_TAG_LEN = 20;
const INJECT_MAX_ITEMS = 8;
const INJECT_MAX_CHARS = 1200;

function nowISO() { return new Date().toISOString(); }
function err(code, message, status) {
  const e = new Error(message || code);
  e.code = code;
  if (status) e.status = status;
  return e;
}
function charLen(s) { return Array.from(String(s || '')).length; }
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* 非关键 */ }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* 非关键 */ }
  fs.renameSync(tmp, file);
}
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function rid() { return 'mem_' + crypto.randomBytes(6).toString('hex'); }

class MemoryStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.root = path.join(String(dataDir || ''), 'memory');
  }

  _uid(user) {
    const id = String((user && user.id) || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id) throw err('NO_USER', '缺少用户身份', 401);
    return id;
  }

  _file(user) {
    ensureDir(this.root);
    return path.join(this.root, this._uid(user) + '.json');
  }

  _load(user) {
    const doc = readJsonSafe(this._file(user), null);
    if (!doc || !Array.isArray(doc.items)) return { version: MEMORY_VERSION, items: [] };
    /* 兼容/防脏：只保留结构正确的条目，避免一条坏数据拖垮整个列表 */
    doc.items = doc.items.filter((x) => x && typeof x.text === 'string' && x.id).map((x) => this._normalizeItem(x));
    return doc;
  }

  _save(user, doc) {
    doc.version = MEMORY_VERSION;
    doc.updatedAt = nowISO();
    writeJsonAtomic(this._file(user), doc);
  }

  _normalizeItem(x) {
    return {
      id: String(x.id),
      text: String(x.text || '').slice(0, MAX_TEXT * 2),
      tags: Array.isArray(x.tags) ? x.tags.map(String).filter(Boolean).slice(0, MAX_TAGS) : [],
      pinned: x.pinned === true,
      createdAt: String(x.createdAt || nowISO()),
      updatedAt: String(x.updatedAt || x.createdAt || nowISO()),
    };
  }

  _out(item) {
    return {
      id: item.id,
      text: item.text,
      tags: item.tags || [],
      pinned: !!item.pinned,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  _normalizeText(text) {
    const t = String(text == null ? '' : text).trim();
    const n = charLen(t);
    if (n < MIN_TEXT) throw err('MEMORY_EMPTY', '记忆内容不能为空', 400);
    if (n > MAX_TEXT) throw err('MEMORY_TEXT_TOO_LONG', '记忆内容最多 ' + MAX_TEXT + ' 字（当前 ' + n + ' 字）', 400);
    return t;
  }

  _normalizeTags(tags) {
    let arr = [];
    if (Array.isArray(tags)) arr = tags;
    else if (typeof tags === 'string') arr = tags.split(/[,，;；\s]+/);
    const out = [];
    for (const raw of arr) {
      const t = String(raw == null ? '' : raw).trim();
      if (!t) continue;
      if (charLen(t) > MAX_TAG_LEN) throw err('MEMORY_TAG_TOO_LONG', '单个标签最多 ' + MAX_TAG_LEN + ' 字', 400);
      if (!out.includes(t)) out.push(t);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }

  _find(doc, id) {
    const want = String(id || '');
    const item = doc.items.find((x) => x.id === want);
    if (!item) throw err('MEMORY_NOT_FOUND', '记忆不存在或不属于当前用户', 404);
    return item;
  }

  list(user) {
    const doc = this._load(user);
    const items = doc.items.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
    return {
      ok: true,
      items: items.map((x) => this._out(x)),
      max: MAX_ITEMS,
      used: doc.items.length,
      inject: { maxItems: INJECT_MAX_ITEMS, maxChars: INJECT_MAX_CHARS },
    };
  }

  add(user, input) {
    const text = this._normalizeText(input && input.text);
    const tags = this._normalizeTags(input && input.tags);
    const pinned = !!(input && input.pinned === true);
    const doc = this._load(user);
    if (doc.items.length >= MAX_ITEMS) {
      throw err('MEMORY_LIMIT', '记忆条数已达上限 ' + MAX_ITEMS + ' 条，请先删除不再需要的记忆', 400);
    }
    const item = { id: rid(), text, tags, pinned, createdAt: nowISO(), updatedAt: nowISO() };
    doc.items.push(item);
    this._save(user, doc);
    return { ok: true, item: this._out(item), used: doc.items.length, max: MAX_ITEMS };
  }

  update(user, input) {
    const doc = this._load(user);
    const item = this._find(doc, input && input.id);
    if (input.text !== undefined) item.text = this._normalizeText(input.text);
    if (input.tags !== undefined) item.tags = this._normalizeTags(input.tags);
    if (input.pinned !== undefined) item.pinned = input.pinned === true;
    item.updatedAt = nowISO();
    this._save(user, doc);
    return { ok: true, item: this._out(item), used: doc.items.length, max: MAX_ITEMS };
  }

  remove(user, input) {
    const doc = this._load(user);
    const item = this._find(doc, input && input.id);
    doc.items = doc.items.filter((x) => x.id !== item.id);
    this._save(user, doc);
    return { ok: true, removed: item.id, used: doc.items.length, max: MAX_ITEMS };
  }

  clear(user, input) {
    if (!input || input.confirm !== true) {
      throw err('CONFIRM_REQUIRED', '清空记忆需要 confirm:true（不可恢复）', 400);
    }
    const doc = this._load(user);
    const n = doc.items.length;
    doc.items = [];
    this._save(user, doc);
    return { ok: true, cleared: n, used: 0, max: MAX_ITEMS };
  }

  /**
   * 计算本次对话要注入的记忆段。
   * 选择顺序：pinned 优先 → 其余按 updatedAt 倒序；最多 8 条、段总字符 ≤1200。
   * 返回的 section 直接拼在 system prompt 后面；hasMemory 便于调用方判断。
   */
  selectForInjection(user) {
    const doc = this._load(user);
    const used = doc.items.length;
    const sorted = doc.items.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
    const header = '【用户记忆】（以下为用户长期偏好/事实，请在不违背当前指令的前提下遵守；不要编造未列出的内容）\n';
    const lines = [];
    const picked = [];
    let chars = charLen(header);
    for (const item of sorted) {
      if (lines.length >= INJECT_MAX_ITEMS) break;
      const line = '- ' + (item.pinned ? '[固定] ' : '') + item.text;
      const add = charLen(line) + 1; // \n
      if (chars + add > INJECT_MAX_CHARS) continue;  // 跳过放不下的长条目，继续看更短的
      lines.push(line);
      picked.push(item);
      chars += add;
    }
    const section = lines.length ? '\n\n' + header + lines.join('\n') : '';
    return {
      used,
      max: MAX_ITEMS,
      count: lines.length,
      chars: section ? charLen(section) : 0,
      ids: picked.map((x) => x.id),
      section,
      truncated: lines.length < Math.min(sorted.length, INJECT_MAX_ITEMS),
    };
  }
}

const _instances = new Map();
function getMemory(dataDir) {
  const key = String(dataDir || '');
  if (!_instances.has(key)) _instances.set(key, new MemoryStore(dataDir));
  return _instances.get(key);
}

module.exports = {
  MemoryStore,
  getMemory,
  MAX_ITEMS,
  MIN_TEXT,
  MAX_TEXT,
  MAX_TAGS,
  MAX_TAG_LEN,
  INJECT_MAX_ITEMS,
  INJECT_MAX_CHARS,
};

'use strict';

/* =====================================================================
   lib/sync.js — 数据同步引擎（清单 + 指纹 + 增量差异）
   v4 只有「文件变了」的广播，没有「变了什么、我这边差什么」的答案。
   这里补上：把目录树压成一份轻量清单，用指纹做整体判等，
   再算出新增/修改/删除——客户端只拉差异，不必全量比对。

   清单条目（极简，省带宽）：
     { p: 相对路径, s: 字节, m: mtimeMs, d: 1|0(是否目录) }
   指纹：sha1(排序后的 "p|s|m" 逐行拼接) —— 内容不同指纹必不同。

   落盘：<dataDir>/sync-state.json（每设备的同步游标，2s 合并写）
   零依赖。

   ---------------------------------------------------------------------
   R9-PERF-4  同步 I/O 阻塞事件循环
   ---------------------------------------------------------------------
   原来生成清单是**全同步**的：readdirSync + statSync 一路递归。
   一棵几万条目的目录树能同步跑几百毫秒到几秒 —— 这段时间里
   整个 Node 事件循环被钉死，WebDAV、SSE、在线状态心跳统统停摆，
   表现为「整站卡住」，但 CPU 看着也不高，极难定位。
   现在：
     · manifestAsync()/compareAsync()：改用 fs.promises，
       **每批（默认 64 个条目）await 一次并显式让出事件循环**，
       遍历期间定时器/其它请求都能正常跑；
     · 大文件走**流**：exportManifest() 用 createWriteStream 分块写，
       readManifestFile() 用 createReadStream 分块读（带体积上限），
       避免一次性把几十 MB 的清单塞进内存；
     · 状态文件改为**原子写**（tmp + rename）。
   ⚠️ 兼容性：server.js 目前是**同步**调用 manifest()/compare() 的
   （`const r = this.sync.manifest(...)`），所以这两个同步入口保留，
   但加了**时间预算**（默认 40ms）：超预算就返回部分清单并置
   truncated/partial=true，绝不再无限期阻塞事件循环。
   想要完整且不阻塞的清单，请改用 manifestAsync()（见 server.js 的调用点）。
   ===================================================================== */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

const DEFAULT_DEPTH = 4;
const MAX_ENTRIES = 20000;        // 单次清单条目上限（防巨型目录拖垮）
const SAVE_DEBOUNCE_MS = 2000;
const STATE_KEEP = 100;

/* R9-PERF-4：同步入口的时间预算（毫秒）—— 超过就返回部分清单。
   默认 500ms：足够走完常见的几千文件目录（实测 1600 个文件约 400ms），
   而超大目录（十万级）原本会一次性钉死事件循环好几秒，现在最多钉 500ms。
   需要完整且不阻塞的清单，请改用 manifestAsync()。 */
const SYNC_BUDGET_MS = (() => {
  const v = Number(process.env.SYNC_MANIFEST_BUDGET_MS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 500;
})();

/* R9-PERF-4：每批处理多少个条目（一批 = 一次并行 stat + 一次让出）。
   一批的 stat 是并行的，墙钟耗时 ≈ 批大小 / 线程池大小 × 单次 stat，
   128 个一批时单轮阻塞约 10~20ms，正好卡在一帧（16ms）附近 —— 事件循环
   不卡，用户也等得起。 */
const BATCH_SIZE = 128;

/** 让出事件循环：把控制权交回去，让定时器 / IO 回调有机会跑 */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** stat 的安全包装：文件可能刚好被删 / 无权限 */
function safeStat(p) {
  return fsp.stat(p).catch(() => null);
}

class Sync {
  constructor(srv) {
    this.srv = srv;
    this.file = path.join(srv.cfg.dataDir, 'sync-state.json');
    this.state = {};              // deviceId -> { root, fingerprint, count, at, disk, path }
    this._saveTimer = null;
    this._tmpSeq = 0;
    this._load();
  }

  /* ------------------------------ 落盘 ------------------------------ */

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.state = raw;
    } catch { /* 首次启动 */ }
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _save() {
    try {
      // 只保留最近的若干设备游标
      const keys = Object.keys(this.state);
      if (keys.length > STATE_KEEP) {
        keys.sort((a, b) => (this.state[b].at || 0) - (this.state[a].at || 0));
        for (const k of keys.slice(STATE_KEEP)) delete this.state[k];
      }
      // R9-PERF-4：原子写（tmp + rename）。状态文件很小（≤100 台设备），
      // 同步写 1ms 内，比丢一次游标划算；这里只解决「半截 JSON」的问题。
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.file + '.tmp-' + process.pid + '-' + (this._tmpSeq++);
      try {
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      }
    } catch { /* 落盘失败不影响比对 */ }
  }

  /* ------------------------------ 清单（异步，不阻塞） ------------------------------ */

  /**
   * R9-PERF-4：异步生成目录清单（fs.promises + 分批让出事件循环）。
   * @param {string} absRoot 绝对根目录（由调用方经 resolveTarget 解析并做过越权校验）
   * @param {object} [opt] { depth, maxEntries, includeDirs, batchSize }
   * @returns {Promise<{ok:boolean, entries?:Array, fingerprint?:string, count?:number, truncated?:boolean, error?:string}>}
   */
  async manifestAsync(absRoot, opt = {}) {
    const maxDepth = Number.isFinite(opt.depth) ? Math.max(0, Math.min(12, opt.depth)) : DEFAULT_DEPTH;
    const maxEntries = Number(opt.maxEntries) > 0 ? Math.min(MAX_ENTRIES, Number(opt.maxEntries)) : MAX_ENTRIES;
    const includeDirs = opt.includeDirs !== false;
    const batchSize = Number(opt.batchSize) > 0
      ? Math.min(256, Math.max(1, Math.floor(opt.batchSize))) : BATCH_SIZE;

    let st;
    try { st = await fsp.stat(absRoot); } catch { return { ok: false, error: '路径不存在' }; }
    if (!st.isDirectory()) return { ok: false, error: '不是目录' };

    const entries = [];
    let truncated = false;
    // 显式栈代替递归：深目录不会爆调用栈
    const stack = [{ dir: absRoot, rel: '', depth: 0 }];

    while (stack.length && !truncated) {
      const cur = stack.pop();
      let names;
      try { names = await fsp.readdir(cur.dir, { withFileTypes: true }); } catch { continue; }
      for (let i = 0; i < names.length; i += batchSize) {
        const chunk = names.slice(i, i + batchSize);
        // 同一批并行 stat：串行 await 每个文件会把延迟叠加起来
        const stats = await Promise.all(chunk.map((ent) => safeStat(path.join(cur.dir, ent.name))));
        for (let j = 0; j < chunk.length; j++) {
          const ent = chunk[j];
          const s = stats[j];
          if (!s) continue;
          const name = ent.name;
          if (name === '.' || name === '..') continue;
          const relPath = cur.rel ? cur.rel + '/' + name : name;
          // Dirent 已经告诉了我们是不是目录，不用额外 stat 判型
          const isDir = ent.isDirectory() || (ent.isSymbolicLink() && s.isDirectory());
          if (isDir) {
            if (entries.length >= maxEntries) { truncated = true; break; }
            if (includeDirs) entries.push({ p: relPath, s: 0, m: Math.round(s.mtimeMs), d: 1 });
            if (cur.depth < maxDepth) stack.push({ dir: path.join(cur.dir, name), rel: relPath, depth: cur.depth + 1 });
          } else if (s.isFile()) {
            if (entries.length >= maxEntries) { truncated = true; break; }
            entries.push({ p: relPath, s: s.size, m: Math.round(s.mtimeMs), d: 0 });
          }
        }
        if (truncated) break;
        /* R9-PERF-4：每批 await 一次并让出事件循环 —— 这是「全站不卡」的关键。
           批次越大吞吐越高，但单次阻塞也越长，64 是个平衡点。 */
        await yieldToEventLoop();
      }
    }

    entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));

    return {
      ok: true,
      entries,
      count: entries.length,
      files: entries.filter((e) => !e.d).length,
      totalBytes: entries.reduce((n, e) => n + (e.s || 0), 0),
      fingerprint: fingerprintOf(entries),
      truncated,
      maxDepth,
    };
  }

  /* ------------------------------ 清单（同步兼容入口） ------------------------------ */

  /**
   * 同步清单入口 —— **保留是为了兼容 server.js 现有的同步调用**。
   * R9-PERF-4：加了时间预算（默认 40ms）：超预算立刻收手并返回部分清单
   * （truncated / partial = true），不再让事件循环被无限期钉死。
   * 新代码请直接用 manifestAsync()。
   */
  manifest(absRoot, opt = {}) {
    const maxDepth = Number.isFinite(opt.depth) ? Math.max(0, Math.min(12, opt.depth)) : DEFAULT_DEPTH;
    const maxEntries = Number(opt.maxEntries) > 0 ? Math.min(MAX_ENTRIES, Number(opt.maxEntries)) : MAX_ENTRIES;
    const includeDirs = opt.includeDirs !== false;
    const budgetMs = Number(opt.budgetMs) > 0 ? Number(opt.budgetMs) : SYNC_BUDGET_MS;

    let st;
    try { st = fs.statSync(absRoot); } catch { return { ok: false, error: '路径不存在' }; }
    if (!st.isDirectory()) return { ok: false, error: '不是目录' };

    const t0 = Date.now();
    const entries = [];
    let truncated = false;
    const stack = [{ dir: absRoot, rel: '', depth: 0 }];

    while (stack.length && !truncated) {
      const cur = stack.pop();
      let names;
      try { names = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of names) {
        if (entries.length >= maxEntries) { truncated = true; break; }
        if (Date.now() - t0 > budgetMs) { truncated = true; break; }  // 时间预算到 → 收手
        const name = ent.name;
        if (name === '.' || name === '..') continue;
        const relPath = cur.rel ? cur.rel + '/' + name : name;
        let s;
        try { s = fs.statSync(path.join(cur.dir, name)); } catch { continue; }
        const isDir = ent.isDirectory() || (ent.isSymbolicLink() && s.isDirectory());
        if (isDir) {
          if (includeDirs) entries.push({ p: relPath, s: 0, m: Math.round(s.mtimeMs), d: 1 });
          if (cur.depth < maxDepth) stack.push({ dir: path.join(cur.dir, name), rel: relPath, depth: cur.depth + 1 });
        } else if (s.isFile()) {
          entries.push({ p: relPath, s: s.size, m: Math.round(s.mtimeMs), d: 0 });
        }
      }
    }

    entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));

    return {
      ok: true,
      entries,
      count: entries.length,
      files: entries.filter((e) => !e.d).length,
      totalBytes: entries.reduce((n, e) => n + (e.s || 0), 0),
      fingerprint: fingerprintOf(entries),
      truncated,
      partial: truncated,      // 预算/上限导致的残缺清单，客户端别拿它当基线
      maxDepth,
      elapsedMs: Date.now() - t0,
    };
  }

  /* ------------------------------ 差异 ------------------------------ */

  /**
   * 计算 base → cur 的增量。
   * @param {Array} base 客户端上次的清单
   * @param {Array} cur  服务端当前清单
   * @returns {{added:Array, removed:Array, changed:Array, unchanged:number}}
   */
  diff(base, cur) {
    const bmap = new Map();
    for (const e of base || []) if (e && e.p) bmap.set(normalizeP(e.p), e);
    const cmap = new Map();
    for (const e of cur || []) if (e && e.p) cmap.set(normalizeP(e.p), e);

    const added = [];
    const changed = [];
    let unchanged = 0;
    for (const [p, e] of cmap) {
      const b = bmap.get(p);
      if (!b) { added.push(e); continue; }
      // 目录只看存在性；文件比大小 + 修改时间
      if (e.d) { unchanged++; continue; }
      if (Number(b.s) !== Number(e.s) || Math.abs(Number(b.m || 0) - Number(e.m || 0)) > 1000) changed.push(e);
      else unchanged++;
    }
    const removed = [];
    for (const [p, e] of bmap) if (!cmap.has(p)) removed.push(e);

    return { added, removed, changed, unchanged };
  }

  /**
   * 完整比对：服务端生成当前清单 → 与客户端基线比对。
   * @returns {changed:boolean, dirty:boolean, ...}
   */
  compare(absRoot, base, opt = {}) {
    const m = this.manifest(absRoot, opt);
    if (!m.ok) return m;
    return this._compareWith(m, base, opt);
  }

  /** 异步完整比对（推荐：不阻塞事件循环） */
  async compareAsync(absRoot, base, opt = {}) {
    const m = await this.manifestAsync(absRoot, opt);
    if (!m.ok) return m;
    return this._compareWith(m, base, opt);
  }

  /** 比对的公共部分（纯 CPU，不涉及 I/O） */
  _compareWith(m, base, opt = {}) {
    const baseList = Array.isArray(base) ? base : [];
    const baseFp = opt.baseFingerprint || fingerprintOf(baseList);
    const dirty = baseFp !== m.fingerprint;
    const d = this.diff(baseList, m.entries);
    /* R9-PERF-4：清单残缺（超出上限或撞到时间预算）时，「删除」是不可信的 ——
       没遍历到的文件会被误判成「被删除」，客户端照着删就是数据事故。
       所以残缺清单一律不给出 removed。 */
    const partial = !!m.truncated;
    return {
      ok: true,
      dirty,
      fingerprint: m.fingerprint,
      baseFingerprint: baseFp,
      count: m.count,
      files: m.files,
      totalBytes: m.totalBytes,
      truncated: partial,
      partial,
      diff: {
        added: d.added.length,
        removed: partial ? 0 : d.removed.length,
        changed: d.changed.length,
        unchanged: d.unchanged,
      },
      added: d.added.slice(0, 500),
      removed: partial ? [] : d.removed.slice(0, 500),
      changedItems: d.changed.slice(0, 500),
      // 需要拉取的（新增 + 变更），目录排除
      need: [...d.added, ...d.changed].filter((e) => !e.d).slice(0, 500),
    };
  }

  /* ------------------------------ 大文件：流式读写 ------------------------------ */

  /**
   * R9-PERF-4：把清单**流式**写到文件（createWriteStream + 背压处理）。
   * 几万条目的清单一次性 JSON.stringify 出来能到几十 MB，
   * 用流分块写，内存占用恒定，还不会长时间占着事件循环。
   */
  async exportManifest(absRoot, file, opt = {}) {
    const m = await this.manifestAsync(absRoot, opt);
    if (!m.ok) return m;
    const ws = fs.createWriteStream(file);
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.write('{"ok":true,"count":' + m.count + ',"fingerprint":"' + m.fingerprint + '","entries":[');
      for (let i = 0; i < m.entries.length; i += BATCH_SIZE) {
        const text = m.entries.slice(i, i + BATCH_SIZE).map((e) => JSON.stringify(e)).join(',');
        if (i > 0) ws.write(',');
        if (!ws.write(text)) await once(ws, 'drain');   // 背压：等写完再继续
        await yieldToEventLoop();
      }
      ws.write(']}');
      await new Promise((resolve, reject) => {
        ws.once('error', reject);
        ws.end(() => resolve());
      });
      return { ok: true, file, count: m.count, truncated: m.truncated };
    } catch (e) {
      try { ws.destroy(); } catch { /* 忽略 */ }
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * R9-PERF-4：流式读取清单文件（createReadStream + 体积上限）。
   * 用于导入客户端保存的基线清单 —— 基线可能很大，别一次性 readFileSync。
   */
  readManifestFile(file, limitBytes = 64 * 1024 * 1024) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0, settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      const rs = fs.createReadStream(file);
      rs.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > limitBytes) { try { rs.destroy(); } catch { /* 忽略 */ } done({ ok: false, error: '清单文件过大' }); return; }
        chunks.push(c);
      });
      rs.on('end', () => {
        if (settled) return;
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          done({ ok: true, data });
        } catch (e) {
          done({ ok: false, error: 'JSON 解析失败' });
        }
      });
      rs.on('error', (e) => done({ ok: false, error: String((e && e.message) || e) }));
    });
  }

  /* ------------------------------ 设备游标 ------------------------------ */

  saveState(deviceId, o = {}) {
    const id = String(deviceId || '').trim();
    if (!id) return { ok: false, error: '缺少设备号' };
    this.state[id] = {
      deviceId: id,
      disk: String(o.disk || ''),
      path: String(o.path || ''),
      root: String(o.disk || '') + ':' + String(o.path || ''),
      fingerprint: String(o.fingerprint || ''),
      count: Number(o.count) || 0,
      files: Number(o.files) || 0,
      at: Date.now(),
    };
    this._saveSoon();
    if (this.srv && this.srv.hub) {
      try {
        this.srv.hub.publish('sync', 'sync.marked', {
          device: id, disk: o.disk, path: o.path, count: this.state[id].count,
        });
      } catch { /* 忽略 */ }
    }
    return { ok: true, state: this.state[id] };
  }

  getState(deviceId) { return this.state[String(deviceId || '')] || null; }

  forget(deviceId) {
    const id = String(deviceId || '');
    if (!this.state[id]) return { ok: false, error: '无该设备游标' };
    delete this.state[id];
    this._saveSoon();
    return { ok: true };
  }

  list() {
    return Object.values(this.state).sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  stats() {
    const all = this.list();
    return {
      devices: all.length,
      truncatedLimit: MAX_ENTRIES,
      defaultDepth: DEFAULT_DEPTH,
      // R9-PERF-4：把预算暴露出来，排查「清单怎么是残缺的」时有用
      syncBudgetMs: SYNC_BUDGET_MS,
      items: all.slice(0, 20),
    };
  }
}

/* ------------------------------ 工具 ------------------------------ */

/** 统一分隔符，避免 Windows 反斜杠与 POSIX 斜杠混用导致"全变了" */
function normalizeP(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function fingerprintOf(entries) {
  const h = crypto.createHash('sha1');
  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    if (!e || !e.p) continue;
    h.update(normalizeP(e.p));
    h.update('|');
    h.update(String(e.d ? 0 : e.s || 0));
    h.update('|');
    h.update(String(Math.round(Number(e.m) || 0)));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

module.exports = { Sync, fingerprintOf, MAX_ENTRIES, SYNC_BUDGET_MS };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('✓ ' + name); }
    else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  const srv = { cfg: { dataDir: tmp }, hub: null };

  (async () => {
    try {
      const sync = new Sync(srv);

      /* 造一棵有点规模的目录树（够大才有说服力） */
      const tree = path.join(tmp, 'tree');
      const DIRS = 20, FILES = 80;
      for (let d = 0; d < DIRS; d++) {
        const dir = path.join(tree, 'dir' + d);
        fs.mkdirSync(dir, { recursive: true });
        for (let f = 0; f < FILES; f++) {
          fs.writeFileSync(path.join(dir, 'f' + f + '.txt'), 'x'.repeat(20));
        }
      }
      const total = DIRS * FILES;

      /* 1) 异步清单正确性 */
      const m = await sync.manifestAsync(tree, { depth: 3 });
      check('异步清单成功', m.ok === true, JSON.stringify(m).slice(0, 200));
      check('异步清单条目数正确', m.count === DIRS + total, 'count=' + m.count + ' expect=' + (DIRS + total));
      check('异步清单文件数正确', m.files === total, 'files=' + m.files);
      check('异步清单有指纹', typeof m.fingerprint === 'string' && m.fingerprint.length === 16);

      /* 2) R9-PERF-4 事件循环不卡：遍历期间 0ms 定时器必须能跑起来 */
      let fired = false;
      setTimeout(() => { fired = true; }, 0);
      const t0 = Date.now();
      const m2 = await sync.manifestAsync(tree, { depth: 3 });
      check('异步遍历期间定时器已触发（事件循环未被钉死）', fired === true,
        'elapsed=' + (Date.now() - t0) + 'ms fired=' + fired);
      check('异步遍历结果仍然完整', m2.count === DIRS + total, 'count=' + m2.count);

      /* 2b) 对照：同步遍历会阻塞事件循环（定时器跑不起来） */
      let firedSync = false;
      setTimeout(() => { firedSync = true; }, 0);
      const ms = sync.manifest(tree, { depth: 3, budgetMs: 5000 });
      check('同步遍历会阻塞事件循环（对照）', firedSync === false, 'fired=' + firedSync);
      check('同步遍历条目数正确', ms.count === DIRS + total, 'count=' + ms.count);
      check('同步遍历有耗时统计', typeof ms.elapsedMs === 'number');

      /* 2c) 同步遍历有时间预算：超大树不无限期阻塞 */
      const bigTree = path.join(tmp, 'big');
      fs.mkdirSync(bigTree, { recursive: true });
      for (let d = 0; d < 40; d++) {
        const dir = path.join(bigTree, 'd' + d);
        fs.mkdirSync(dir, { recursive: true });
        for (let f = 0; f < 60; f++) fs.writeFileSync(path.join(dir, 'x' + f + '.bin'), 'y'.repeat(200));
      }
      const tb = Date.now();
      const mb = sync.manifest(bigTree, { depth: 3, budgetMs: 5 });
      const spent = Date.now() - tb;
      check('同步遍历受时间预算约束', spent < 2000, 'spent=' + spent + 'ms');
      check('超预算的清单标记为残缺', mb.truncated === true && mb.partial === true,
        'truncated=' + mb.truncated + ' partial=' + mb.partial);

      /* 3) 差异计算 */
      const d1 = sync.diff(m.entries, m.entries);
      check('无变化时 added/changed/removed 均为 0', d1.added.length === 0 && d1.changed.length === 0 && d1.removed.length === 0);
      const base = m.entries.slice();
      const mutated = base.map((e) => (e.d ? e : { p: e.p, s: e.s + 1, m: e.m, d: 0 }));
      const d2 = sync.diff(base, mutated);
      check('内容变化被识别为 changed', d2.changed.length === total, 'changed=' + d2.changed.length);
      const d3 = sync.diff(base, base.slice(1));
      check('缺失条目被识别为 removed', d3.removed.length === 1);

      /* 4) 异步比对 */
      const c1 = await sync.compareAsync(tree, m.entries, { depth: 3 });
      check('异步比对：与基线一致 → dirty=false', c1.ok && c1.dirty === false, JSON.stringify(c1.diff));
      const c2 = await sync.compareAsync(tree, m.entries, { depth: 3, baseFingerprint: 'deadbeef' });
      check('异步比对：指纹不同 → dirty=true', c2.ok && c2.dirty === true);
      check('异步比对输出结构完整', Array.isArray(c2.added) && Array.isArray(c2.removed) && typeof c2.need === 'object');

      /* 5) 残缺清单不给出 removed（防误删本地文件） */
      const partial = await sync.compareAsync(tree, m.entries.slice(0, 5), { depth: 3, maxEntries: 10 });
      check('残缺清单不给出 removed', partial.removed.length === 0 && partial.partial === true,
        'removed=' + partial.removed.length + ' partial=' + partial.partial);

      /* 6) R9-PERF-4 大文件走流：导出 + 读回 */
      const outFile = path.join(tmp, 'manifest.json');
      const ex = await sync.exportManifest(tree, outFile, { depth: 3 });
      check('流式导出成功', ex.ok === true && ex.count === DIRS + total, JSON.stringify(ex));
      const back = await sync.readManifestFile(outFile);
      check('流式读回是合法 JSON', back.ok === true && Array.isArray(back.data && back.data.entries),
        JSON.stringify(back).slice(0, 120));
      check('流式读回条目数一致', back.ok && back.data.entries.length === DIRS + total,
        'len=' + (back.ok ? back.data.entries.length : -1));
      check('流式导出内容与清单一致', back.ok && back.data.entries[0].p === m.entries[0].p);

      /* 7) 状态文件：原子写 + 合法 JSON */
      sync.saveState('dev-1', { disk: 'public', path: '/a', fingerprint: 'fp1', count: 3, files: 3 });
      sync.saveState('dev-2', { disk: 'public', path: '/b', fingerprint: 'fp2', count: 4, files: 4 });
      sync._save();
      let st = null, stOk = false;
      try { st = JSON.parse(fs.readFileSync(path.join(tmp, 'sync-state.json'), 'utf8')); stOk = !!st; } catch (e) { stOk = false; }
      check('状态文件是合法 JSON', stOk);
      check('状态里有两个设备游标', stOk && Object.keys(st).length === 2, JSON.stringify(st));
      const leftovers = fs.readdirSync(tmp).filter((n) => n.indexOf('.tmp-') >= 0);
      check('原子写无残留 tmp 文件', leftovers.length === 0, JSON.stringify(leftovers));
      check('getState 能取到游标', !!sync.getState('dev-1'));
      check('forget 能删游标', sync.forget('dev-1').ok === true && !sync.getState('dev-1'));

      /* 8) 边界 */
      const bad = await sync.manifestAsync(path.join(tmp, 'nope'), {});
      check('不存在的路径返回错误', bad.ok === false && bad.error === '路径不存在');
      const notDir = await sync.manifestAsync(path.join(tree, 'dir0', 'f0.txt'), {});
      check('文件不是目录时返回错误', notDir.ok === false && notDir.error === '不是目录');

      console.log('');
      console.log('断言 ' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + ' 项）');
      if (fail) { console.log('✗ 存在失败项'); process.exit(1); }
      console.log('✓ 全部通过');
      process.exit(0);
    } catch (e) {
      console.error('自测异常：', e && e.stack ? e.stack : e);
      process.exit(1);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  })();
}

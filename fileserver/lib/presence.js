'use strict';

/* =====================================================================
   lib/presence.js — 设备在线注册中心
   工作站里的「谁在线、能干什么」。手机、平板、PC、电视各自注册一条记录，
   90s 没心跳即判离线（移动端切后台/锁屏会断，阈值不宜太短）。

   能力矩阵（capabilities）示例：
     ['upload','download','preview','cast','clipboard','exec']

   落盘：<dataDir>/devices.json（2s 合并写，避免高频心跳刷盘）
   事件：devices.online / devices.offline / devices.update（经 hub 广播）
   零依赖。
   ===================================================================== */

const fs = require('fs');
const path = require('path');

const TTL_MS = 90 * 1000;          // 心跳有效期
const SWEEP_MS = 20 * 1000;        // 离线扫描间隔
/* ------------------------------------------------------------------
   R9-PERF-2  设备表上限：可配置 + LRU 淘汰（原来硬上限 8 台）
   ------------------------------------------------------------------
   曾经设备表硬上限 8 台，而且**超限直接丢新设备**：第 9 台设备注册完
   立刻被扔掉，用户在设备页上永远看不到它（更糟的是 _save() 只落盘
   slice(0, 8)，第 9 台连磁盘上都进不去，重启后彻底消失，且毫无提示）。
   现在：
     · 上限可配置，默认 64 台（局域网实际也就十几台，64 足够富余）；
     · 超限不丢新设备，而是**按 LRU 淘汰最久未心跳的那台** —— 丢新的
       等于把刚上线的设备踢下线，丢旧的才符合直觉；
     · 离线记录带过期清理（OFFLINE_TTL_MS），离线设备不再永久占位；
     · 淘汰次数记在 stats().evicted 里，排查时能直接看到。
   ------------------------------------------------------------------ */
const DEFAULT_MAX_DEVICES = 64;        // 设备表总上限（在线 + 离线）
/* 离线记录保留条数 —— 只影响「最近设备」列表的展示，**与设备表总上限是两回事**。
   保持 8：这是 2026-09-16 定的值（同一台 PC 因 deviceId 每次刷新都变，
   一次会话能塞进十几条「Win 电脑 · XXXX」），配合 _pruneOffline() 按机器身份
   去重，8 条足够展示，又不会把设备页撑爆。
   ⚠️ 曾经的 bug：_save() 里也用了这个 8 来截断**全部**设备（含在线），
   于是第 9 台设备永远落不了盘 —— 那是本次要修的核心问题。 */
const OFFLINE_KEEP = 8;               // 离线记录保留条数（展示用）
const OFFLINE_TTL_MS = 30 * 60 * 1000; // 离线记录最长保留时长：心跳过期后清理
const SAVE_DEBOUNCE_MS = 2000;

class Presence {
  constructor(srv) {
    this.srv = srv;
    this.file = path.join(srv.cfg.dataDir, 'devices.json');
    this.devices = new Map();        // deviceId -> device
    this._saveTimer = null;
    this._sweepTimer = null;
    this._tmpSeq = 0;
    // R9-PERF-2：上限可配置 —— 配置文件 srv.cfg.presenceMaxDevices 优先，
    // 其次环境变量 PRESENCE_MAX_DEVICES，最后内置默认 64。
    this.maxDevices = this._resolveMaxDevices(srv);
    this.offlineKeep = Math.max(1, Math.min(this.maxDevices, OFFLINE_KEEP));
    this.evicted = 0;                // 因超限被 LRU 淘汰的设备数（排查用）
    this.lastSweep = { dropped: 0, expired: 0 };
    this._seq = 0;                   // 注册序号：lastSeen 同毫秒时的确定性排序依据
    this._load();
  }

  /** R9-PERF-2：解析设备表上限（非法值一律退回默认，绝不因为配置写错就变成 0） */
  _resolveMaxDevices(srv) {
    const fromCfg = Number(srv && srv.cfg ? srv.cfg.presenceMaxDevices : 0);
    if (Number.isFinite(fromCfg) && fromCfg >= 1) return Math.floor(fromCfg);
    const fromEnv = Number(process.env.PRESENCE_MAX_DEVICES);
    if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.floor(fromEnv);
    return DEFAULT_MAX_DEVICES;
  }

  /* ------------------------------ 落盘 ------------------------------ */

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) {
        for (const d of raw) {
          if (d && d.id) {
            d.online = false;          // 重启后一律先离线，等心跳复活
            d.lastSeen = Number(d.lastSeen) || 0;
            d.seq = Number(d.seq) || 0;
            if (d.seq > this._seq) this._seq = d.seq;
            // 存量数据净化：历史遗留的「电脑 · 73」式名字在启动时即被重写
            if (LEGACY_AUTO_NAME.test(String(d.name || '').trim())) {
              d.name = autoName(d.id, d.type, d.platform);
            }
            this.devices.set(d.id, d);
          }
        }
      }
    } catch { /* 首次启动无文件 */ }
    /* 启动即修剪一次：_pruneOffline 原本只在有设备掉线时跑，而脏数据是
       「已经攒好了」的 —— 如果一直没设备掉线，那些记录就会一直挂在设备页上。
       ⚠️ 修剪后**必须立刻落盘**，否则只清了内存：磁盘上还是那份脏数据，
       下次重启又被原样读回来（白修一次，且看不出任何异常）。 */
    try {
      const before = this.devices.size;
      this._pruneOffline();
      /* R9-PERF-2：磁盘上的设备数可能超过新上限（改小了 maxDevices），
         按 lastSeen 由新到旧保留最近的，淘汰最久未心跳的。 */
      this._trimToLimit();
      if (this.devices.size !== before) this._save();
    } catch { /* 修剪失败不影响启动 */ }
  }

  /** R9-PERF-2：把设备表裁到 maxDevices 以内（淘汰最久未心跳的） */
  _trimToLimit() {
    let removed = 0;
    while (this.devices.size > this.maxDevices) {
      if (!this._evictOldest()) break;
      removed++;
    }
    return removed;
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _save() {
    try {
      // 数据目录可能还不存在（首次启动/新装）：没有它 writeFileSync 会直接
      // 抛 ENOENT，被 catch 吞掉 → 设备表永远落不了盘（原实现就有这个坑）。
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      /* R9-PERF-2：这里原来写的是 slice(0, OFFLINE_KEEP=8) —— 也就是说
         **在线设备也只有前 8 台能落盘**，第 9 台注册完在磁盘上根本不存在，
         重启后凭空消失且毫无提示。现在按 maxDevices 落盘全部设备。
         排序仍按 lastSeen 倒序：最近的排在前面，人工看文件也顺眼。 */
      const list = [...this.devices.values()]
        .sort((a, b) => (b.lastSeen - a.lastSeen) || ((b.seq || 0) - (a.seq || 0)))
        .slice(0, this.maxDevices);
      // 原子写：tmp + rename —— 写一半掉电不会留下半截 JSON 把下次启动读崩
      const tmp = this.file + '.tmp-' + process.pid + '-' + (this._tmpSeq++);
      try {
        fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
        fs.renameSync(tmp, this.file);
      } catch {
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      }
    } catch { /* 落盘失败不影响在线功能 */ }
  }

  /* ------------------------------ 注册 / 心跳 ------------------------------ */

  /**
   * 注册或刷新一台设备。同一 deviceId 反复调用即心跳。
   * @param {object} info { id, name, type, platform, capabilities, version, app }
   * @param {object} [ctx] { ip, user }
   * @returns {{ok:boolean, device?:object, error?:string, isNew?:boolean}}
   */
  register(info = {}, ctx = {}) {
    const id = String(info.id || '').trim();
    if (!id) return { ok: false, error: '缺少设备号 id' };
    if (id.length > 64) return { ok: false, error: '设备号过长' };

    const now = Date.now();
    let d = this.devices.get(id);
    const isNew = !d;

    if (!d) {
      /* R9-PERF-2：超限时先腾位置 —— 淘汰「最久未心跳」的那台，
         绝不丢新设备（丢新设备会让刚上线的机器凭空消失，用户完全看不懂）。 */
      while (this.devices.size >= this.maxDevices) {
        if (!this._evictOldest()) break;
      }
      d = {
        id,
        name: sanitizeName(info.name, id, info.type, info.platform),
        type: normType(info.type),
        platform: String(info.platform || '').trim() || 'unknown',
        capabilities: normCaps(info.capabilities),
        version: String(info.version || '').trim(),
        app: String(info.app || '').trim() || 'web',
        firstSeen: now,
        lastSeen: now,
        seq: ++this._seq,             // 同一毫秒注册的设备靠它分出先后
        online: true,
        ip: ctx.ip || '',
        user: ctx.user || '',
        heartbeatCount: 0,
      };
      this.devices.set(id, d);
    } else {
      // 字段以最新上报为准（用户可能改了设备名）；遗留自动名会被净化掉
      if (info.name) d.name = sanitizeName(info.name, id, info.type || d.type, info.platform || d.platform);
      if (info.type) d.type = normType(info.type);
      if (info.platform) d.platform = String(info.platform).trim();
      if (info.capabilities) d.capabilities = normCaps(info.capabilities);
      if (info.version) d.version = String(info.version).trim();
      if (info.app) d.app = String(info.app).trim();
      if (ctx.ip) d.ip = ctx.ip;
      if (ctx.user) d.user = ctx.user;
      d.heartbeatCount = (d.heartbeatCount || 0) + 1;
    }

    const wasOffline = !d.online;
    d.lastSeen = now;
    d.online = true;

    this._saveSoon();

    // 只在上线瞬间广播，心跳不广播（否则每 25s 一条噪音事件）
    if (isNew || wasOffline) {
      this._publish(isNew ? 'devices.online' : 'devices.rejoin', d);
    }
    return { ok: true, device: d, isNew };
  }

  /**
   * R9-PERF-2：LRU 淘汰 —— 挑「最久未心跳（lastSeen 最小）」的设备踢掉。
   * lastSeen 相同时优先淘汰已离线的（离线的本来就是僵尸记录）。
   * @returns {object|null} 被淘汰的设备
   */
  _evictOldest() {
    let victim = null;
    for (const d of this.devices.values()) {
      if (!victim) { victim = d; continue; }
      if (d.lastSeen < victim.lastSeen) { victim = d; continue; }
      if (d.lastSeen === victim.lastSeen) {
        // 同一毫秒：按注册序号（后注册的更“新”）再比一次
        if ((d.seq || 0) < (victim.seq || 0)) { victim = d; continue; }
        if ((d.seq || 0) === (victim.seq || 0) && !d.online && victim.online) victim = d;
      }
    }
    if (!victim) return null;
    this.devices.delete(victim.id);
    this.evicted++;
    this._publish('devices.remove', { id: victim.id, reason: 'evicted' });
    return victim;
  }

  rename(id, name) {
    const d = this.devices.get(id);
    if (!d) return { ok: false, error: '设备不存在' };
    const n = String(name || '').trim();
    if (!n) return { ok: false, error: '名称不能为空' };
    d.name = n.slice(0, 40);
    this._saveSoon();
    this._publish('devices.update', d);
    return { ok: true, device: d };
  }

  remove(id) {
    const d = this.devices.get(id);
    if (!d) return { ok: false, error: '设备不存在' };
    this.devices.delete(id);
    this._saveSoon();
    this._publish('devices.remove', { id });
    return { ok: true };
  }

  /* ------------------------------ 查询 ------------------------------ */

  touch(id) {
    const d = this.devices.get(id);
    if (d) { d.lastSeen = Date.now(); d.online = true; }
  }

  get(id) { return this.devices.get(id) || null; }

  /** @param {object} [opt] { includeOffline=true, ttl } */
  list(opt = {}) {
    const ttl = opt.ttl || TTL_MS;
    const now = Date.now();
    const all = [...this.devices.values()].map((d) => decorate(d, now, ttl));
    const online = all.filter((d) => d.online);
    online.sort((a, b) => b.lastSeen - a.lastSeen);
    const offline = all.filter((d) => !d.online).sort((a, b) => b.lastSeen - a.lastSeen);
    if (opt.includeOffline === false) return { online, offline: [], total: online.length };
    return { online, offline, total: online.length, known: all.length };
  }

  /** 在线设备的能力并集 —— 让前端知道「这个局域网现在能做什么」 */
  capabilities() {
    const set = new Set();
    for (const d of this.devices.values()) {
      if (!d.online) continue;
      for (const c of d.capabilities || []) set.add(c);
    }
    return [...set].sort();
  }

  stats() {
    const l = this.list();
    return {
      online: l.total,
      known: l.known,
      offline: l.offline.length,
      capabilities: this.capabilities(),
      ttlMs: TTL_MS,
      // R9-PERF-2：把上限 / 淘汰数暴露出来，排查「设备不见了」时一目了然
      maxDevices: this.maxDevices,
      offlineKeep: this.offlineKeep,
      offlineTtlMs: OFFLINE_TTL_MS,
      evicted: this.evicted,
      lastSweep: this.lastSweep,
    };
  }

  /* ------------------------------ 离线扫描 ------------------------------ */

  start() {
    if (this._sweepTimer) return this;
    this._sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
    return this;
  }

  stop() {
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; this._save(); }
  }

  /** 扫描超时设备，标记离线并广播；返回本次掉线条数 */
  sweep() {
    const now = Date.now();
    let dropped = 0;
    for (const d of this.devices.values()) {
      if (d.online && now - d.lastSeen > TTL_MS) {
        d.online = false;
        dropped++;
        this._publish('devices.offline', d);
      }
    }
    /* R9-PERF-2：心跳过期清理 —— 离线超过 OFFLINE_TTL_MS 的记录直接删除。
       原来离线设备只是被标个 offline 就一直挂在表里（还占着 8 条的名额），
       离线设备永久占位，新设备挤不进来。 */
    let expired = 0;
    for (const d of [...this.devices.values()]) {
      if (!d.online && now - d.lastSeen > OFFLINE_TTL_MS) {
        this.devices.delete(d.id);
        expired++;
      }
    }
    this.lastSweep = { dropped, expired };
    if (dropped || expired) {
      // 清理过老的离线记录
      this._pruneOffline();
      this._saveSoon();
    }
    return dropped;
  }

  /* ---------------- 离线记录修剪（数量上限 + 同机去重） ----------------
   * 为什么需要去重：deviceId 由前端生成，浏览器清缓存/换内核/无痕窗口都会
   * 造出一个新 id，于是**同一台 PC**在服务端成了几十条互不相干的记录。
   * 「同一台机器」的判据只能是稳定特征：ip + platform + type。
   * 同组里只保留 lastSeen 最新的那条。
   * ⚠️ 在线设备一律不碰 —— 去重只针对离线历史，否则会把正在用的设备踢掉。 */
  _pruneOffline() {
    const offline = [...this.devices.values()]
      .filter((d) => !d.online)
      .sort((a, b) => (b.lastSeen - a.lastSeen) || ((b.seq || 0) - (a.seq || 0)));
    const seen = new Set();
    const keep = [];
    for (const d of offline) {
      /* 身份键。ip 为空时退化成按 id 分组（不至于把无关设备合掉）——
         NAS 内网场景 ip 必填，所以正常路径总能命中。 */
      const key = d.ip
        ? [d.ip, d.platform || '', d.type || ''].join('|')
        : 'id:' + d.id;
      if (seen.has(key)) continue;   // 同机旧记录，丢弃
      seen.add(key);
      keep.push(d);
    }
    /* R9-PERF-2：离线记录的数量上限不能挤掉在线设备 ——
       真正吃额度的是「在线 + 离线」的总数，离线最多占
       min(offlineKeep, maxDevices - 在线数) 个位置。 */
    const onlineCount = this.devices.size - offline.length;
    const keepOffline = Math.max(0, Math.min(this.offlineKeep, this.maxDevices - onlineCount));
    const survivors = new Set(keep.slice(0, keepOffline).map((d) => d.id));
    let removed = 0;
    for (const d of offline) {
      if (!survivors.has(d.id)) { this.devices.delete(d.id); removed++; }
    }
    return removed;
  }

  /* ------------------------------ 内部 ------------------------------ */

  _publish(type, d) {
    if (this.srv && this.srv.hub) {
      try { this.srv.hub.publish('devices', type, decorate(d, Date.now(), TTL_MS)); } catch { /* 推送失败不影响注册 */ }
    }
  }
}

/* ------------------------------ 工具 ------------------------------ */

const TYPES = ['phone', 'tablet', 'pc', 'laptop', 'tv', 'nas', 'unknown'];

function normType(t) {
  const v = String(t || '').toLowerCase().trim();
  return TYPES.includes(v) ? v : 'unknown';
}

function normCaps(c) {
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const x of c) {
    const v = String(x || '').trim().slice(0, 24);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 24) break;
  }
  return out;
}

function guessName(type) {
  const map = { phone: '手机', tablet: '平板', pc: '台式机', laptop: '笔记本', tv: '电视', nas: 'NAS', unknown: '未知设备' };
  return map[normType(type)] || '未知设备';
}

/* ---------- 默认命名：与前端 public/station.js 算法逐字保持一致 ----------
   名字 = 平台可读名 + 设备号派生的 4 位短码。短码来自 FNV-1a(id)，
   同一设备号恒定、不同设备几乎不碰撞，所以不会再出现「所有机器同名」。 */

const NAME_LABELS = { phone: '手机', tablet: '平板', pc: '电脑', laptop: '笔记本', tv: '电视', nas: 'NAS', unknown: '设备' };

function shortCode(id) {
  const s = String(id || '');
  let n = 2166136261;
  for (let i = 0; i < s.length; i++) { n ^= s.charCodeAt(i); n = Math.imul(n, 16777619) >>> 0; }
  return n.toString(36).toUpperCase().padStart(6, '0').slice(-4);
}

function platformLabel(type, platform) {
  const t = normType(type);
  const p = String(platform || '');
  if (p === 'Android') return t === 'tablet' ? '安卓平板' : '安卓手机';
  if (p === 'iOS') return t === 'tablet' ? 'iPad' : 'iPhone';
  if (p === 'Windows') return t === 'laptop' ? 'Win 笔记本' : 'Win 电脑';
  if (p === 'macOS') return t === 'laptop' ? 'MacBook' : 'Mac';
  if (p === 'Linux') return t === 'laptop' ? 'Linux 笔记本' : 'Linux 电脑';
  return NAME_LABELS[t] || '设备';
}

function autoName(id, type, platform) {
  return platformLabel(type, platform) + ' · ' + shortCode(id);
}

/* 历史遗留的「主机名末段」式自动名，例如「电脑 · 73」。
   它由旧版 defaultName(location.hostname 末段) 产生 —— 所有人访问同一个 IP，
   于是每台机器都叫「电脑 · 73」。这类名字一律视为「未命名」，
   由服务端按设备号重新派生，防止旧缓存页面继续把脏名字写回设备列表。 */
const LEGACY_AUTO_NAME = /^(电脑|手机|平板|笔记本|电视|PC|设备)\s*·\s*\d{1,3}$/;

function sanitizeName(raw, id, type, platform) {
  const n = String(raw || '').trim();
  if (!n || LEGACY_AUTO_NAME.test(n)) return autoName(id, type, platform);
  return n.slice(0, 40);
}

function decorate(d, now, ttl) {
  const online = !!(d.online && now - d.lastSeen <= ttl);
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    platform: d.platform,
    capabilities: d.capabilities || [],
    version: d.version,
    app: d.app,
    ip: d.ip,
    user: d.user,
    firstSeen: d.firstSeen,
    lastSeen: d.lastSeen,
    ageS: Math.round((now - d.lastSeen) / 1000),
    online,
  };
}

module.exports = { Presence, TTL_MS, DEFAULT_MAX_DEVICES, OFFLINE_TTL_MS };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('✓ ' + name); }
    else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-test-'));
  const mkSrv = (dir, extra) => ({ cfg: Object.assign({ dataDir: dir }, extra || {}), hub: null });
  try {
    /* 1) 默认上限是 64（不再是 8） */
    const p0 = new Presence(mkSrv(path.join(tmp, 'd0')));
    check('默认设备上限为 64', p0.maxDevices === 64, 'max=' + p0.maxDevices);

    /* 2) 上限可配置 */
    const pCfg = new Presence(mkSrv(path.join(tmp, 'd1'), { presenceMaxDevices: 5 }));
    check('设备上限可通过配置调整', pCfg.maxDevices === 5, 'max=' + pCfg.maxDevices);

    /* 3) R9-PERF-2① 超过上限时总数被限制住 */
    const p = new Presence(mkSrv(path.join(tmp, 'd2'), { presenceMaxDevices: 10 }));
    for (let i = 0; i < 25; i++) {
      p.register({ id: 'dev-' + i, name: '设备' + i, type: 'pc', platform: 'Windows' }, { ip: '192.168.1.' + i });
    }
    check('设备总数被限制在上限内', p.devices.size <= 10, 'size=' + p.devices.size);
    check('超限有淘汰计数', p.stats().evicted > 0, 'evicted=' + p.stats().evicted);
    check('新设备不会被丢弃（第 25 台在线）', !!p.get('dev-24'), '最后注册的不在了');
    check('最早注册的设备被淘汰', !p.get('dev-0'), 'dev-0 还在');

    /* 4) R9-PERF-2① 淘汰的是「最久未心跳」的那台 */
    const pLru = new Presence(mkSrv(path.join(tmp, 'd3'), { presenceMaxDevices: 3 }));
    pLru.register({ id: 'A', type: 'pc' }, { ip: '10.0.0.1' });
    pLru.register({ id: 'B', type: 'pc' }, { ip: '10.0.0.2' });
    pLru.register({ id: 'C', type: 'pc' }, { ip: '10.0.0.3' });
    const base = Date.now();
    pLru.get('A').lastSeen = base - 30000;   // A 最久没心跳
    pLru.get('B').lastSeen = base - 20000;
    pLru.get('C').lastSeen = base - 10000;
    pLru.register({ id: 'D', type: 'pc' }, { ip: '10.0.0.4' });
    check('淘汰的是最久未心跳的设备', !pLru.get('A') && !!pLru.get('B') && !!pLru.get('C') && !!pLru.get('D'),
      'A=' + !!pLru.get('A') + ' B=' + !!pLru.get('B') + ' C=' + !!pLru.get('C') + ' D=' + !!pLru.get('D'));

    /* 5) R9-PERF-2② 心跳过期清理：离线且超时的记录被删除 */
    const pSweep = new Presence(mkSrv(path.join(tmp, 'd4'), { presenceMaxDevices: 10 }));
    pSweep.register({ id: 'old-1', type: 'pc' }, { ip: '10.0.1.1' });
    pSweep.register({ id: 'old-2', type: 'pc' }, { ip: '10.0.1.2' });
    pSweep.get('old-1').lastSeen = Date.now() - 5 * 60 * 1000;        // 超过 TTL(90s) → 离线
    pSweep.get('old-2').lastSeen = Date.now() - 2 * 60 * 60 * 1000;    // 超过 OFFLINE_TTL → 直接回收
    const dropped = pSweep.sweep();
    check('心跳超时的设备被标记离线', dropped >= 1, 'dropped=' + dropped);
    check('过期离线设备被清理', !pSweep.get('old-2'), 'old-2 还在');
    check('刚掉线的设备仍保留（可展示）', !!pSweep.get('old-1'), 'old-1 被清了');
    check('过期清理有计数', pSweep.lastSweep.expired >= 1, JSON.stringify(pSweep.lastSweep));

    /* 6) 落盘：所有设备都写进去（原来只写 8 台，第 9 台直接消失） */
    const dir6 = path.join(tmp, 'd5');
    const p6 = new Presence(mkSrv(dir6, { presenceMaxDevices: 64 }));
    for (let i = 0; i < 12; i++) p6.register({ id: 'keep-' + i, type: 'phone' }, { ip: '10.1.0.' + i });
    p6._save();
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(path.join(dir6, 'devices.json'), 'utf8')); } catch (e) { saved = []; }
    check('落盘是合法 JSON 且条数完整', Array.isArray(saved) && saved.length === 12, 'len=' + saved.length);
    check('第 9 台之后的设备没有被丢弃', saved.some((d) => d && d.id === 'keep-11'));
    check('在线设备数不受 8 条限制', p6.list({ includeOffline: false }).total === 12,
      'online=' + p6.list({ includeOffline: false }).total);

    /* 7) 重载后：离线历史按展示上限收敛（既有策略），但最近的在、文件仍合法 */
    const p7 = new Presence(mkSrv(dir6, { presenceMaxDevices: 64 }));
    check('重启后离线历史按展示上限收敛', p7.devices.size <= 8, 'size=' + p7.devices.size);
    check('重启后最近的设备仍在', !!p7.get('keep-11'));
    p7._save();
    let saved2 = [];
    try { saved2 = JSON.parse(fs.readFileSync(path.join(dir6, 'devices.json'), 'utf8')); } catch (e) { saved2 = []; }
    check('重启后落盘仍是合法 JSON', Array.isArray(saved2) && saved2.length === p7.devices.size);

    /* 8) 原子写无残留 tmp */
    const leftovers = fs.readdirSync(dir6).filter((n) => n.indexOf('.tmp-') >= 0);
    check('落盘无残留 tmp 文件', leftovers.length === 0, JSON.stringify(leftovers));

    /* 9) 同机去重仍生效（只针对离线记录，在线设备一律不碰） */
    const dir9 = path.join(tmp, 'd9');
    const p9 = new Presence(mkSrv(dir9, { presenceMaxDevices: 64 }));
    p9.register({ id: 'x1', type: 'pc', platform: 'Windows' }, { ip: '10.2.0.1' });
    p9.register({ id: 'x2', type: 'pc', platform: 'Windows' }, { ip: '10.2.0.1' });
    p9.get('x1').online = false;          // 掉线（去重只处理离线历史）
    p9.get('x2').online = false;
    p9.get('x1').lastSeen = Date.now() - 1000;
    p9._pruneOffline();
    check('同机旧记录被去重', !p9.get('x1') && !!p9.get('x2'), 'x1=' + !!p9.get('x1') + ' x2=' + !!p9.get('x2'));

    /* 10) 离线展示列表的上限仍是 8（与设备表总上限是两回事，别改混了） */
    const dir10 = path.join(tmp, 'd10');
    const p10 = new Presence(mkSrv(dir10, { presenceMaxDevices: 64 }));
    for (let i = 0; i < 20; i++) {
      p10.register({ id: 'o' + i, type: 'pc', platform: 'Windows' }, { ip: '10.3.0.' + i });
      p10.get('o' + i).online = false;      // 全部掉线
    }
    p10._pruneOffline();
    check('离线展示列表上限仍是 8', p10.offlineKeep === 8 && p10.devices.size === 8,
      'keep=' + p10.offlineKeep + ' size=' + p10.devices.size);

    for (const inst of [p0, pCfg, p, pLru, pSweep, p6, p7, p9, p10]) { try { inst.stop(); } catch { /* 忽略 */ } }

    console.log('');
    console.log('断言 ' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + ' 项）');
    if (fail) { console.log('✗ 存在失败项'); process.exit(1); }
    console.log('✓ 全部通过');
    process.exit(0);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

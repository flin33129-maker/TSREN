'use strict';

/* =====================================================================
   lib/ratelimit.js — 限速（下载限速 + 匿名接口请求频率）
   模型：桶容量 capacityBytes，固定速率 refillBytesPerSec 补充令牌，
         take(bytes) 令牌不足时排队等待（Promise），水位上限即桶容量。
   性能：令牌按**经过时间惰性补充**（不靠高频定时器），take() 本身 O(1) 入队，
         绝不 busy-loop；定时器 unref 不阻止进程退出。
   配置：<dataDir>/limit.json {"downloadKBps": 0}，0 = 不限速（返回 null）

   R9-P1-12：原先是**全局单桶** —— 一个客户端就能把全站下载配额吃光，
   其它客户端只能干等。现在改为**按客户端键（IP / 用户）分桶**：
   每个客户端有自己的令牌桶，互不抢配额；
   同时设客户端桶数量上限（maxClients），超了淘汰最久未用的，
   防止攻击者用海量伪造 IP 把内存打满。
   兼容性：take(bytes) 不传客户端键时走共享桶（= 旧的全局行为），
           take(bytes, clientKey) 才是按客户端分桶。
   ===================================================================== */

const fs = require('fs');
const path = require('path');

const REFILL_INTERVAL_MS = 200;   // 补充周期：粒度越小限速越平滑
const DEFAULT_MAX_CLIENTS = 256;  // 客户端分桶上限（防内存膨胀）

class TokenBucket {
  /**
   * @param {object} opts
   * @param {number} opts.capacityBytes      桶容量（突发上限，字节）
   * @param {number} opts.refillBytesPerSec  每秒补充令牌（限速值，字节/秒）
   */
  constructor({ capacityBytes, refillBytesPerSec }) {
    this.capacity = Math.max(1024, Math.floor(capacityBytes || 0));
    this.rate = Math.max(1, Math.floor(refillBytesPerSec || 0));
    this.tokens = this.capacity;      // 初始满桶，允许首个突发
    this._waiters = [];               // FIFO 等待队列 [{bytes, resolve, done}]
    this._last = Date.now();          // 上次补充时刻（惰性补充用）
    this.lastUsed = this._last;       // 供 LRU 淘汰使用
  }

  /**
   * 按经过的时间惰性补充令牌。
   * 不用「每个桶一个 200ms 定时器」：分桶后可能是几百个桶，
   * 几百个定时器本身就够拖垮进程。
   */
  refill(now = Date.now()) {
    const dt = now - this._last;
    if (dt <= 0) return;
    this._last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (this.rate * dt) / 1000);
  }

  /**
   * 取走 bytes 个令牌；不足则等待（按入队顺序发放）。
   * 单次请求量超过桶容量时按桶容量截断（保证有限时间内可完成）。
   * @returns {Promise<void>} 拿到令牌时 resolve
   */
  take(bytes) {
    return new Promise((resolve) => {
      let need = Math.max(0, Math.floor(Number(bytes) || 0));
      if (need === 0) return resolve();
      if (need > this.capacity) need = this.capacity;
      const w = { bytes: need, resolve, done: false };
      this._waiters.push(w);
      this.refill();
      this._drain();
    });
  }

  /** 从队首开始发放：令牌够就扣减并唤醒，不够就停（后面的继续等） */
  _drain() {
    while (this._waiters.length) {
      const w = this._waiters[0];
      if (w.done) { this._waiters.shift(); continue; }
      if (w.bytes <= this.tokens) {
        this.tokens -= w.bytes;
        w.done = true;
        this._waiters.shift();
        try { w.resolve(); } catch { /* 唤醒失败不影响队列 */ }
      } else {
        break;   // 令牌不足，等下一个补充周期
      }
    }
  }

  /** 销毁：拒绝所有等待者（立即放行，调用方负责停止使用） */
  destroy() {
    for (const w of this._waiters.splice(0)) {
      if (!w.done) { w.done = true; try { w.resolve(); } catch {} }
    }
    this.tokens = 0;
  }
}

/**
 * R9-P1-12：按客户端键分桶的限速器。
 * 每个客户端一个 TokenBucket，互不抢配额；桶数量有上限，超出按 LRU 淘汰。
 * @param {object} opts
 * @param {number} opts.capacityBytes      每客户端桶容量
 * @param {number} opts.refillBytesPerSec  每客户端每秒补充
 * @param {number} [opts.maxClients]       客户端桶数量上限
 */
class ClientLimiter {
  constructor({ capacityBytes, refillBytesPerSec, maxClients = DEFAULT_MAX_CLIENTS }) {
    this.capacity = Math.max(1024, Math.floor(capacityBytes || 0));
    this.rate = Math.max(1, Math.floor(refillBytesPerSec || 0));
    this.maxClients = Math.max(1, Math.floor(maxClients || DEFAULT_MAX_CLIENTS));
    this.buckets = new Map();          // clientKey -> TokenBucket
    this._shared = new TokenBucket({ capacityBytes, refillBytesPerSec });  // 未指定客户端键时使用
    // 一个定时器统一给所有桶补充令牌并唤醒等待者（避免每桶一个定时器）
    this._timer = setInterval(() => this._tick(), REFILL_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  _tick() {
    const now = Date.now();
    try { this._shared.refill(now); this._shared._drain(); } catch { /* 定时器内绝不抛出 */ }
    for (const b of this.buckets.values()) {
      try { b.refill(now); b._drain(); } catch { /* 同上 */ }
    }
  }

  /** 取（必要时创建）某客户端的桶；超过上限时淘汰最久未用的那个 */
  _bucket(key) {
    const k = String(key || '');
    let b = this.buckets.get(k);
    if (b) { b.lastUsed = Date.now(); return b; }
    if (this.buckets.size >= this.maxClients) this._evict();
    b = new TokenBucket({ capacityBytes: this.capacity, refillBytesPerSec: this.rate });
    b.lastUsed = Date.now();
    this.buckets.set(k, b);
    return b;
  }

  /** LRU 淘汰一个桶（防止伪造海量 IP 撑爆内存） */
  _evict() {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, b] of this.buckets) {
      const t = b.lastUsed || 0;
      if (t < oldest) { oldest = t; oldestKey = k; }
    }
    if (oldestKey != null) {
      const b = this.buckets.get(oldestKey);
      this.buckets.delete(oldestKey);
      try { if (b) b.destroy(); } catch { /* 忽略 */ }
    }
  }

  /**
   * 取令牌。
   * @param {number} bytes
   * @param {string} [clientKey] 客户端键（IP / 用户名）。**省略则走共享桶**，
   *        即旧的全局限速行为 —— 保持既有调用点兼容。
   * @returns {Promise<void>}
   */
  take(bytes, clientKey) {
    if (clientKey == null || clientKey === '') return this._shared.take(bytes);
    return this._bucket(clientKey).take(bytes);
  }

  stats() {
    return {
      clients: this.buckets.size,
      maxClients: this.maxClients,
      rate: this.rate,
      capacity: this.capacity,
    };
  }

  destroy() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const b of this.buckets.values()) { try { b.destroy(); } catch { /* 忽略 */ } }
    this.buckets.clear();
    try { this._shared.destroy(); } catch { /* 忽略 */ }
  }
}

/**
 * R9-P1-12：按客户端键的**请求频率**限制（滑动窗口计数）。
 * 用于匿名可打的接口（如分享链接取件）：单个 IP 短时间内反复试 token。
 * 内存同样有上限（maxClients），超了清掉最早的一批。
 */
class RequestLimiter {
  constructor({ windowMs = 60000, max = 30, maxClients = 4096 } = {}) {
    this.windowMs = Math.max(1000, Math.floor(windowMs || 0));
    this.max = Math.max(1, Math.floor(max || 0));
    this.maxClients = Math.max(1, Math.floor(maxClients || 0));
    this.hits = new Map();   // clientKey -> number[]（时间戳队列）
  }

  /**
   * 记一次命中并判断是否超限。
   * @param {string} key 客户端键（IP）
   * @returns {{ok:boolean, remaining:number, retryAfterMs:number}}
   */
  check(key) {
    const k = String(key || 'unknown');
    const now = Date.now();
    let arr = this.hits.get(k);
    if (!arr) {
      if (this.hits.size >= this.maxClients) this._evict();
      arr = [];
      this.hits.set(k, arr);
    }
    const cutoff = now - this.windowMs;
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (arr.length >= this.max) {
      return { ok: false, remaining: 0, retryAfterMs: Math.max(0, arr[0] + this.windowMs - now) };
    }
    arr.push(now);
    return { ok: true, remaining: this.max - arr.length, retryAfterMs: 0 };
  }

  /** 内存保护：条目过多时清掉最早的一批 */
  _evict() {
    const drop = Math.max(1, Math.ceil(this.maxClients / 4));
    let n = 0;
    for (const k of [...this.hits.keys()]) {
      if (n++ >= drop) break;
      this.hits.delete(k);
    }
  }

  reset(key) {
    if (key == null) this.hits.clear();
    else this.hits.delete(String(key));
  }

  stats() {
    return { clients: this.hits.size, maxClients: this.maxClients, max: this.max, windowMs: this.windowMs };
  }
}

/**
 * 从服务器配置构造下载限速器（**按客户端分桶**）。
 * 读 <dataDir>/limit.json {"downloadKBps": 0, "maxClients": 256}：
 *   downloadKBps 0 或缺省 = 不限速 → null；
 *   非 0 → ClientLimiter（每客户端容量 = max(64KB, 1s 配额)，速率 = 配额/s）。
 * @returns {ClientLimiter|null}
 */
function createLimiterFromCfg(srv) {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(srv.cfg.dataDir, 'limit.json'), 'utf8')); } catch { return null; }
  const kbps = Number(cfg && cfg.downloadKBps) || 0;
  if (kbps <= 0) return null;   // 0 = 不限
  const bytesPerSec = Math.floor(kbps * 1024);
  return new ClientLimiter({
    capacityBytes: Math.max(64 * 1024, bytesPerSec),   // 至少 64KB 突发，避免小文件被卡死
    refillBytesPerSec: bytesPerSec,
    maxClients: Math.max(1, Number(cfg && cfg.maxClients) || DEFAULT_MAX_CLIENTS),
  });
}

module.exports = { TokenBucket, ClientLimiter, RequestLimiter, createLimiterFromCfg, DEFAULT_MAX_CLIENTS };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    /* R9-P1-12：按客户端分桶 —— 一个客户端耗尽配额不能影响别人 */
    const cl = new ClientLimiter({ capacityBytes: 1024, refillBytesPerSec: 1, maxClients: 4 });
    await cl.take(1024, 'A');                       // A 拿空自己的桶
    let aDone = false, bDone = false;
    cl.take(1024, 'A').then(() => { aDone = true; });
    cl.take(1024, 'B').then(() => { bDone = true; });
    await sleep(60);
    check('A 超出配额被限速', aDone, false);
    check('B 不受 A 影响', bDone, true);
    // 不传客户端键 → 走共享桶（旧的全局行为，兼容既有调用点）
    let sharedDone = false;
    cl.take(1024).then(() => { sharedDone = true; });
    await sleep(60);
    check('共享桶可用（兼容旧签名）', sharedDone, true);
    check('stats 报告客户端数', cl.stats().clients >= 2, true);
    cl.destroy();

    /* 客户端桶上限：桶数量必须有界，防伪造海量 IP */
    const cl2 = new ClientLimiter({ capacityBytes: 1024, refillBytesPerSec: 1024, maxClients: 4 });
    for (let i = 0; i < 50; i++) await cl2.take(1, 'ip-' + i);
    check('客户端桶数量有上限', cl2.buckets.size <= 4, true);
    cl2.destroy();

    /* RequestLimiter：按 IP 的请求频率限制 */
    const rl = new RequestLimiter({ windowMs: 1000, max: 3, maxClients: 4 });
    check('第 1 次允许', rl.check('1.2.3.4').ok, true);
    check('第 2 次允许', rl.check('1.2.3.4').ok, true);
    check('第 3 次允许', rl.check('1.2.3.4').ok, true);
    check('第 4 次拒绝', rl.check('1.2.3.4').ok, false);
    check('超限返回重试时间', rl.check('1.2.3.4').retryAfterMs > 0, true);
    check('其它 IP 不受影响', rl.check('5.6.7.8').ok, true);
    for (let i = 0; i < 50; i++) rl.check('10.0.0.' + i);
    check('跟踪的客户端数有上限', rl.hits.size <= 4, true);

    /* TokenBucket 基本行为 */
    const tb = new TokenBucket({ capacityBytes: 2048, refillBytesPerSec: 1024 });
    await tb.take(0);
    let tbDone = false;
    tb.take(1024).then(() => { tbDone = true; });
    await sleep(30);
    check('令牌桶可取令牌', tbDone, true);
    tb.destroy();

    console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}

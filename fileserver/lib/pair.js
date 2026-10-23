'use strict';

/* =====================================================================
   lib/pair.js — 设备配对与信任
   v4 的设备注册一度是「谁报什么 id 就是谁」——任意设备都能冒充任意身份，
   这在局域网里是个实打实的空洞（同网段任何机器都能伪装成你的 PC）。

   机制：
     1) 管理员生成 6 位配对码（默认 10 分钟有效、一次性）
     2) 新设备提交配对码 → 换取长期「设备令牌」（32 位 hex）
     3) 之后注册时带上令牌 → 判定为已信任
     4) 严格模式（requirePairing）开启后：未信任设备不接受远程指令

   R9-P1-10：信任判定**必须**同时满足「在受信名单里」+「持有该设备绑定的
   有效令牌」。此前 isTrusted(deviceId) 只看 id，于是「知道受信设备 id」
   就等于「自称受信」—— 上面第 3 步的令牌校验形同虚设。
   现在 isTrusted(deviceId, token) 缺 token 时降级为「不受信」（不报错，
   旧客户端仍能正常注册，只是不再自动获得信任标记）。

   配对码用 crypto 随机（非 Math.random），且**校验后即失效**。
   落盘：<dataDir>/trusted.json
   零依赖。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;   // 配对码有效期
const MAX_CODES = 20;                 // 同时存在的配对码上限
const SAVE_DEBOUNCE_MS = 1500;

class Pairing {
  constructor(srv) {
    this.srv = srv;
    this.file = path.join(srv.cfg.dataDir, 'trusted.json');

    const st = (srv.cfg && srv.cfg.station) || {};
    this.requirePairing = !!st.requirePairing;

    this.trusted = new Map();     // deviceId -> { id, name, level, token, at, by, ip }
    this.blocked = new Map();     // deviceId -> { id, at, by, reason }
    this.codes = new Map();       // code -> { code, expiresAt, by, at, usedBy }
    this._saveTimer = null;
    this._load();
  }

  /* ------------------------------ 落盘 ------------------------------ */

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      if (typeof raw.require === 'boolean') this.requirePairing = raw.require;
      if (Array.isArray(raw.devices)) {
        for (const d of raw.devices) if (d && d.id) this.trusted.set(d.id, d);
      }
      if (Array.isArray(raw.blocked)) {
        for (const d of raw.blocked) if (d && d.id) this.blocked.set(d.id, d);
      }
    } catch { /* 首次启动 */ }
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _save() {
    try {
      const out = {
        require: this.requirePairing,
        devices: [...this.trusted.values()],
        blocked: [...this.blocked.values()],
      };
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
    } catch { /* 忽略 */ }
  }

  /* ------------------------------ 配对码 ------------------------------ */

  /**
   * 生成一个一次性配对码。
   * @param {object} [o] { ttlMs, by, label }
   * @returns {{ok:boolean, code?:string, expiresAt?:number, ttlMs?:number}}
   */
  newCode(o = {}) {
    this.pruneCodes();
    if (this.codes.size >= MAX_CODES) {
      // 淘汰最老的
      const oldest = [...this.codes.values()].sort((a, b) => a.at - b.at)[0];
      if (oldest) this.codes.delete(oldest.code);
    }
    const ttl = Math.max(30 * 1000, Math.min(60 * 60 * 1000, Number(o.ttlMs) || CODE_TTL_MS));
    // 6 位数字，用 crypto 保证不可预测
    const n = crypto.randomInt(0, 1000000);
    const code = String(n).padStart(6, '0');
    const rec = {
      code,
      at: Date.now(),
      expiresAt: Date.now() + ttl,
      by: String(o.by || ''),
      label: String(o.label || '').slice(0, 60),
      usedBy: '',
    };
    this.codes.set(code, rec);
    return { ok: true, code, expiresAt: rec.expiresAt, ttlMs: ttl };
  }

  /** 校验配对码（只读，不消费） */
  peek(code) {
    const c = this.codes.get(String(code || '').trim());
    if (!c) return { ok: false, error: '配对码无效' };
    if (Date.now() > c.expiresAt) return { ok: false, error: '配对码已过期' };
    if (c.usedBy) return { ok: false, error: '配对码已被使用' };
    return { ok: true, rec: c };
  }

  /**
   * 设备用配对码换取信任令牌。
   * @param {string} code
   * @param {object} dev { id, name, type, platform }
   * @param {object} [ctx] { ip, user }
   */
  claim(code, dev = {}, ctx = {}) {
    const v = this.peek(code);
    if (!v.ok) return v;
    const id = String(dev.id || '').trim();
    if (!id) return { ok: false, error: '缺少设备号' };
    if (this.blocked.has(id)) return { ok: false, error: '该设备已被封禁' };

    const token = crypto.randomBytes(16).toString('hex');
    const rec = {
      id,
      name: String(dev.name || '').slice(0, 60),
      type: String(dev.type || 'unknown'),
      platform: String(dev.platform || ''),
      level: 'trusted',
      token,
      at: Date.now(),
      by: v.rec.by || (ctx.user || ''),
      ip: ctx.ip || '',
      viaCode: v.rec.code,
    };
    this.trusted.set(id, rec);

    v.rec.usedBy = id;
    this.codes.delete(v.rec.code);      // 一次性：立刻作废

    this._saveSoon();
    this._publish('devices.paired', { id, name: rec.name, by: rec.by });
    return { ok: true, token, device: rec };
  }

  pruneCodes() {
    const now = Date.now();
    let n = 0;
    for (const [k, c] of this.codes) {
      if (now > c.expiresAt || c.usedBy) { this.codes.delete(k); n++; }
    }
    return n;
  }

  listCodes() {
    const now = Date.now();
    return [...this.codes.values()]
      .filter((c) => now <= c.expiresAt && !c.usedBy)
      .map((c) => ({ code: c.code, expiresAt: c.expiresAt, leftS: Math.round((c.expiresAt - now) / 1000), by: c.by }));
  }

  /* ------------------------------ 信任判定 ------------------------------ */

  /**
   * R9-P1-10：判定设备是否「已配对**且**持有有效令牌」。
   * 信任不能只凭 id —— 知道受信设备 id 的人就能自称是它。
   * 必须同时满足：① 在受信表里 ② 提供的令牌与该设备绑定的一致。
   * token 缺失 → 降级为「不受信」（不抛错，旧客户端仍可正常注册）。
   * @param {string} deviceId
   * @param {string} [token] 设备令牌（X-Device-Token / 请求体 token）
   */
  isTrusted(deviceId, token) {
    const id = String(deviceId || '');
    if (!id) return false;
    if (!this.trusted.has(id)) return false;
    if (!token) return false;               // 没有令牌 → 不给信任（降级，不报错）
    return this.matchToken(id, token);
  }

  /**
   * 仅判断「是否在受信名单里」（**不**校验令牌）。
   * 只用于展示（前端徽章 / 设备清单），**不可**用作授权判定 ——
   * 授权一律走 isTrusted(id, token)。
   */
  isPaired(deviceId) {
    return this.trusted.has(String(deviceId || ''));
  }

  isBlocked(deviceId) { return this.blocked.has(String(deviceId || '')); }

  /** 令牌比对（常数时间，防时序侧信道） */
  matchToken(deviceId, token) {
    const rec = this.trusted.get(String(deviceId || ''));
    if (!rec || !rec.token || !token) return false;
    const a = Buffer.from(String(rec.token));
    const b = Buffer.from(String(token));
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch { return false; }
  }

  trust(deviceId, meta = {}) {
    const id = String(deviceId || '').trim();
    if (!id) return { ok: false, error: '缺少设备号' };
    this.blocked.delete(id);
    const old = this.trusted.get(id) || {};
    const rec = {
      id,
      name: String(meta.name || old.name || '').slice(0, 60),
      type: String(meta.type || old.type || 'unknown'),
      platform: String(meta.platform || old.platform || ''),
      level: 'trusted',
      token: old.token || crypto.randomBytes(16).toString('hex'),
      at: old.at || Date.now(),
      by: String(meta.by || old.by || ''),
      ip: String(meta.ip || old.ip || ''),
      manual: true,
    };
    this.trusted.set(id, rec);
    this._saveSoon();
    this._publish('devices.paired', { id, name: rec.name, by: rec.by, manual: true });
    return { ok: true, device: rec };
  }

  untrust(deviceId) {
    const id = String(deviceId || '');
    if (!this.trusted.has(id)) return { ok: false, error: '该设备未被信任' };
    this.trusted.delete(id);
    this._saveSoon();
    this._publish('devices.unpaired', { id });
    return { ok: true };
  }

  block(deviceId, reason = '') {
    const id = String(deviceId || '').trim();
    if (!id) return { ok: false, error: '缺少设备号' };
    this.trusted.delete(id);
    this.blocked.set(id, { id, at: Date.now(), reason: String(reason).slice(0, 120), by: '' });
    this._saveSoon();
    this._publish('devices.blocked', { id, reason });
    return { ok: true };
  }

  unblock(deviceId) {
    const id = String(deviceId || '');
    if (!this.blocked.has(id)) return { ok: false, error: '该设备未被封禁' };
    this.blocked.delete(id);
    this._saveSoon();
    return { ok: true };
  }

  setRequire(on) {
    this.requirePairing = !!on;
    this._saveSoon();
    this._publish('devices.policy', { requirePairing: this.requirePairing });
    return { ok: true, requirePairing: this.requirePairing };
  }

  list() {
    return {
      requirePairing: this.requirePairing,
      trusted: [...this.trusted.values()].sort((a, b) => (b.at || 0) - (a.at || 0)),
      blocked: [...this.blocked.values()].sort((a, b) => (b.at || 0) - (a.at || 0)),
      codes: this.listCodes(),
    };
  }

  stats() {
    return {
      requirePairing: this.requirePairing,
      trusted: this.trusted.size,
      blocked: this.blocked.size,
      activeCodes: this.listCodes().length,
    };
  }

  _publish(type, data) {
    if (this.srv && this.srv.hub) {
      try { this.srv.hub.publish('devices', type, data); } catch { /* 忽略 */ }
    }
  }
}

module.exports = { Pairing, CODE_TTL_MS };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairtest-'));
  const p = new Pairing({ cfg: { dataDir: tmpDir } });

  // 配对码 → 设备令牌
  const code = p.newCode({ by: 'admin' });
  const claimed = p.claim(code.code, { id: 'dev-1', name: '我的PC' }, { ip: '127.0.0.1' });
  check('配对成功', claimed.ok, true);
  const token = claimed.token;

  /* R9-P1-10：持有有效令牌才受信；只报 id 不再能冒充 */
  check('持有效令牌 → 受信', p.isTrusted('dev-1', token), true);
  check('只报 id → 不受信', p.isTrusted('dev-1'), false);
  check('错误令牌 → 不受信', p.isTrusted('dev-1', 'deadbeef'), false);
  check('空令牌 → 不受信', p.isTrusted('dev-1', ''), false);
  check('未知设备 → 不受信', p.isTrusted('dev-x', token), false);
  check('matchToken 正常', p.matchToken('dev-1', token), true);
  check('matchToken 拒绝错令牌', p.matchToken('dev-1', 'deadbeef'), false);

  // 展示用的 isPaired 只看名单
  check('isPaired 命中', p.isPaired('dev-1'), true);
  check('isPaired 未命中', p.isPaired('dev-x'), false);

  // 管理员手动信任：同样需要令牌
  p.trust('dev-2', { name: '手动信任' });
  const t2 = p.trusted.get('dev-2').token;
  check('手动信任有令牌', !!t2, true);
  check('手动信任持令牌受信', p.isTrusted('dev-2', t2), true);
  check('手动信任无令牌不受信', p.isTrusted('dev-2'), false);

  // 封禁设备立刻失去信任
  p.block('dev-1', '测试');
  check('封禁后不受信', p.isTrusted('dev-1', token), false);
  check('封禁后 isPaired 为假', p.isPaired('dev-1'), false);

  // 配对码一次性
  const c2 = p.newCode({});
  const first = p.claim(c2.code, { id: 'dev-3' }, {});
  const second = p.claim(c2.code, { id: 'dev-4' }, {});
  check('配对码一次性（第二次失败）', second.ok, false);
  check('首次配对成功', first.ok, true);

  console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

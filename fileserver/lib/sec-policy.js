'use strict';

/* =====================================================================
   lib/sec-policy.js — 口令策略（服务端强制）与口令历史
   ---------------------------------------------------------------------
   需求（P0 第 2 项）：最小长度、复杂度、有效期、历史不可重用。
   「服务端强制」的含义是：**不依赖前端提示**，凡是经过本模块的
   设密入口（自助改密 / 管理员建号 / 管理员重置口令 / 注册拦截）
   都会用同一份校验函数把关；弱口令直接 400。

   落地方式（为什么不改 server.js）：
     · 自助改密走本模块自己的 `/api/security/password/change`；
     · 建号/重置口令在扩展路由层**优先接管** `/api/admin/users/create`
       与 `/api/admin/users/setpass`（扩展路由先于 server.js 的 if-else 链）；
     · 注册在扩展路由层接管 `/api/register`（现网前端本来就不发验证码，
       接管后行为一致，但套上了完整策略）。
   历史与有效期存在 data/sec-policy.json（0600），只存 HMAC 指纹，不存明文。
   ===================================================================== */

const crypto = require('crypto');
const store = require('./sec-store');

const POLICY_DEFAULTS = {
  enabled: true,
  minLength: 12,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: true,
  maxAgeDays: 90,
  historyCount: 5,
  blockCommon: true,
};

/* 常见弱口令（小写比较）。只用于即时校验与「弱口令扫描」，不含任何站点真实口令。 */
const COMMON_WEAK = [
  '123456', '12345678', '123456789', 'password', 'password1', 'passw0rd',
  'qwerty', 'qwerty123', 'abc123', '111111', '000000', 'iloveyou',
  'admin', 'admin123', 'administrator', 'letmein', 'welcome', 'welcome1',
  'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  'master', 'shadow', 'superman', 'batman', 'trustno1', '123123',
  '666666', '888888', '5201314', 'woaini1314', 'a123456', 'qwe123',
  '1qaz2wsx', '1q2w3e4r', 'asdfghjkl', 'zxcvbnm', 'changeme', 'secret',
];

function policyFile(app) { return store.fileOf(app, 'policy'); }

/** 读取策略 + 用户口令元数据；坏文件 fail-open 成默认策略（仍然可用） */
function load(app) {
  const raw = store.cachedFile(policyFile(app), null);
  const out = {
    version: 1,
    policy: { ...POLICY_DEFAULTS },
    users: {},
    baselineAt: null,
    updatedAt: null,
    updatedBy: null,
  };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.policy && typeof raw.policy === 'object') {
    for (const k of Object.keys(POLICY_DEFAULTS)) {
      if (raw.policy[k] !== undefined) out.policy[k] = raw.policy[k];
    }
    // 数值项兜底
    out.policy.minLength = clampInt(out.policy.minLength, 6, 128, POLICY_DEFAULTS.minLength);
    out.policy.maxAgeDays = clampInt(out.policy.maxAgeDays, 0, 3650, POLICY_DEFAULTS.maxAgeDays);
    out.policy.historyCount = clampInt(out.policy.historyCount, 0, 20, POLICY_DEFAULTS.historyCount);
  }
  if (raw.users && typeof raw.users === 'object') out.users = raw.users;
  out.baselineAt = raw.baselineAt || null;
  out.updatedAt = raw.updatedAt || null;
  out.updatedBy = raw.updatedBy || null;
  return out;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function save(app, data, who) {
  const out = {
    version: 1,
    policy: data.policy,
    users: data.users,
    baselineAt: data.baselineAt || null,
    updatedAt: store.nowIso(),
    updatedBy: who || 'system',
  };
  const ok = store.saveJSON(policyFile(app), out);
  if (ok) store.invalidate(policyFile(app));
  return ok;
}

/**
 * 口令强度校验（策略的唯一权威实现）。
 * @param {string} password
 * @param {object} policy
 * @param {{username?:string, history?:Array<{hash:string}>}} [opts]
 * @returns {{ok:boolean, errors:string[], score:number, labels:string[]}}
 */
function evaluate(password, policyIn, opts = {}) {
  const policy = { ...POLICY_DEFAULTS, ...(policyIn || {}) };
  const pw = String(password == null ? '' : password);
  const errors = [];
  const labels = [];

  if (!policy.enabled) {
    // 策略关闭时只保留一个绝对下限，避免把空口令写进系统
    if (pw.length < 6) errors.push('口令至少 6 位');
    return { ok: errors.length === 0, errors, score: 0, labels: ['策略已关闭'] };
  }

  if (pw.length < policy.minLength) errors.push('长度至少 ' + policy.minLength + ' 位（当前 ' + pw.length + ' 位）');
  if (pw.length > 128) errors.push('长度不能超过 128 位');

  const hasUpper = /[A-Z]/.test(pw);
  const hasLower = /[a-z]/.test(pw);
  const hasDigit = /[0-9]/.test(pw);
  const hasSymbol = /[^A-Za-z0-9]/.test(pw);
  if (policy.requireUpper && !hasUpper) errors.push('需要包含大写字母');
  if (policy.requireLower && !hasLower) errors.push('需要包含小写字母');
  if (policy.requireDigit && !hasDigit) errors.push('需要包含数字');
  if (policy.requireSymbol && !hasSymbol) errors.push('需要包含符号（!@#$%^&* 等）');

  // 字符种类 ≥ 3 才算「复杂度达标」（比单条更贴近真实口令强度）
  const classes = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
  if (policy.enabled && classes < 3) errors.push('至少包含大写/小写/数字/符号中的 3 类');

  const lower = pw.toLowerCase();
  if (policy.blockCommon && COMMON_WEAK.includes(lower)) errors.push('这是常见弱口令，已被禁止');
  if (/^(.)\1{5,}$/.test(pw)) errors.push('不能是重复字符');
  if (/^(012345|123456|654321|abcdef|qwerty)/i.test(pw)) errors.push('不能是连续序列');
  if (opts.username && lower.includes(String(opts.username).toLowerCase()) && String(opts.username).length >= 3) {
    errors.push('不能包含用户名');
  }

  // 历史口令不可重用（opts.key 由调用方提供：lib 不在这里读盘，保持纯函数）
  if (opts.key && Array.isArray(opts.history) && opts.history.length) {
    const h = fingerprint(opts.key, opts.username || '', pw);
    for (const item of opts.history.slice(0, Math.max(1, policy.historyCount))) {
      if (item && item.hash && safeEqualHex(item.hash, h)) {
        errors.push('最近 ' + policy.historyCount + ' 次用过的口令不可重复使用');
        break;
      }
    }
  }

  // 粗粒度强度分（仅用于 UI 展示，不参与放行判定）
  let score = Math.min(40, pw.length * 2);
  if (hasUpper) score += 10;
  if (hasLower) score += 10;
  if (hasDigit) score += 10;
  if (hasSymbol) score += 15;
  if (/[^\x00-\x7f]/.test(pw)) score += 5;
  score = Math.max(0, Math.min(100, score));
  if (pw.length >= policy.minLength) labels.push('长度达标');
  if (classes >= 3) labels.push('复杂度达标');
  if (COMMON_WEAK.includes(lower)) labels.push('常见弱口令');

  return { ok: errors.length === 0, errors, score, labels };
}

/* ---------------------------- 历史指纹 ---------------------------- */

function historyKeyFile(app) { return store.fileOf(app, 'policy-key'); }

/** 本机随机密钥（首次使用时生成，0600），密钥丢失时历史校验自动降级为「无历史」 */
function historyKey(app) {
  const f = historyKeyFile(app);
  const raw = store.loadJSON(f, null);
  if (raw && typeof raw.key === 'string' && /^[0-9a-f]{64}$/.test(raw.key)) return Buffer.from(raw.key, 'hex');
  const key = crypto.randomBytes(32);
  store.saveJSON(f, { key: key.toString('hex'), createdAt: store.nowIso() });
  return key;
}

function fingerprint(key, username, password) {
  return crypto.createHmac('sha256', key)
    .update(String(username || '').toLowerCase())
    .update('\u0000')
    .update(String(password == null ? '' : password))
    .digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 该用户的历史记录数组（新→旧） */
function historyOf(data, username) {
  const rec = data.users[String(username || '').toLowerCase()];
  return (rec && Array.isArray(rec.history)) ? rec.history : [];
}

/**
 * 记录一次成功的口令变更：更新 changedAt，并把新指纹压进历史。
 * @returns {boolean} 是否落盘成功
 */
function recordPassword(app, username, password, who) {
  const data = load(app);
  const name = String(username || '').toLowerCase();
  const key = historyKey(app);
  const rec = data.users[name] || { changedAt: null, history: [] };
  rec.changedAt = store.nowIso();
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  rec.history.unshift({ hash: fingerprint(key, name, password), at: rec.changedAt });
  const cap = Math.max(1, Number(data.policy.historyCount) || 5);
  rec.history = rec.history.slice(0, cap);
  data.users[name] = rec;
  if (!data.baselineAt) data.baselineAt = store.nowIso();
  return save(app, data, who || username);
}

/**
 * 策略上线基线：给所有**未记录**的既有账号写入 changedAt=基线时间。
 * 目的：有效期从策略上线开始计算，不会一上线就把存量账号全部判过期（锁死全站）。
 * 只会补空记录，不会覆盖真实变更时间。
 */
function ensureBaseline(app) {
  const data = load(app);
  const users = (app.users && app.users.users) || [];
  let dirty = false;
  const now = store.nowIso();
  for (const u of users) {
    const name = String(u.username || '').toLowerCase();
    if (!name) continue;
    if (!data.users[name]) {
      data.users[name] = { changedAt: now, history: [], baseline: true };
      dirty = true;
    }
  }
  if (!data.baselineAt) { data.baselineAt = now; dirty = true; }
  if (dirty) return save(app, data, 'baseline');
  return true;
}

/**
 * 某个账号的口令状态（有效期判定）。
 * @returns {{known:boolean, changedAt:string|null, expiresAt:string|null, daysLeft:number|null, expired:boolean, maxAgeDays:number}}
 */
function stateOf(app, user, dataIn) {
  const data = dataIn || load(app);
  const name = String((user && user.username) || '').toLowerCase();
  const rec = data.users[name];
  const maxAgeDays = Number(data.policy.maxAgeDays) || 0;
  const out = {
    known: !!(rec && rec.changedAt),
    changedAt: (rec && rec.changedAt) || null,
    expiresAt: null,
    daysLeft: null,
    expired: false,
    maxAgeDays,
    historyCount: rec && Array.isArray(rec.history) ? rec.history.length : 0,
  };
  if (!out.changedAt || !maxAgeDays) return out;
  const changed = Date.parse(out.changedAt);
  if (!Number.isFinite(changed)) return out;
  const expires = changed + maxAgeDays * 86400000;
  out.expiresAt = new Date(expires).toISOString();
  out.daysLeft = Math.ceil((expires - Date.now()) / 86400000);
  out.expired = data.policy.enabled === true && Date.now() > expires;
  return out;
}

/** 从用户变更请求里拿出原始口令（兼容 password / newPassword） */
function pickPassword(body) {
  if (!body || typeof body !== 'object') return '';
  return String(body.password != null ? body.password : (body.newPassword != null ? body.newPassword : ''));
}

/**
 * 删除账号时清掉该用户的口令历史/有效期记录。
 * 为什么必须做：口令历史是按用户名存的，删号后同名重建会继承旧历史，
 * 「新建一个账号」却被提示「最近 5 次用过的口令不可重复使用」——实测踩到过。
 */
function clearHistory(app, username) {
  const data = load(app);
  const name = String(username || '').toLowerCase();
  if (!data.users[name]) return true;
  delete data.users[name];
  return save(app, data, 'user-delete');
}

module.exports = {
  POLICY_DEFAULTS, COMMON_WEAK,
  load, save, evaluate, historyKey, fingerprint,
  historyOf, recordPassword, ensureBaseline, stateOf, pickPassword,
  clearHistory,
  policyFile,
};

'use strict';

/* =====================================================================
   lib/auth.js — 用户库 + 会话库（口令哈希 / 会话签发）
   安全要点（历史审计编号）：
     R9-P0-2  空库时首个注册者自动成为管理员（此前硬编码 'user'，
              而全仓唯一提权入口要求已有 admin → 空库后无人能成 admin）
     R9-P0-4  users.json / sessions.json 落盘权限收紧到 0600
              （会话 ID = 可直接接管会话的凭据，口令哈希同理）
     R9-P1-5  用户名枚举防护：用户不存在时也走等价 scrypt + 常量时间比较
     R9-P1-6  提供异步 scrypt（同步版会阻塞整个事件循环）
     R9-P1-7  会话落盘改为防抖 + 原子写，退出前可 flush()
     R9-P1-8  会话清理完整 + 每用户会话数上限
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomId } = require('./util');

// scrypt 参数：兼顾安全性与手机 CPU 性能
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

/* R9-P0-4：存有口令哈希 / 会话凭据的文件必须仅属主可读写。
   注意 fs.writeFileSync 的 mode 只在**创建**文件时生效，已存在的文件
   不会被改权限 —— 所以落盘后还要显式 chmod 修正。 */
const SECRET_FILE_MODE = 0o600;

/* R9-P1-5：注册口令长度下限（可被调用方按需提高，但不得低于 6 —— 
   现网既有用户是按 6 位注册的，收紧会直接锁死他们） */
const DEFAULT_MIN_PASSWORD_LEN = 6;

/* R9-P1-5：用户名枚举防护用的哑元盐（固定值）与哑元口令。
   固定盐保证每次算出来的哑元哈希一致，可与预计算值做常量时间比较；
   但**只比较预计算哈希是不够的** —— 真实路径的耗时几乎全在 scrypt 上，
   漏掉这一步 scrypt 就等于没做防护。 */
const DUMMY_SALT = '9f2c4a7be1d06358ac4f1e0b7d39562a';
const DUMMY_PASSWORD = 'dsh-dummy-password-never-matches';

/* R9-P1-7：会话落盘防抖窗口与最长延迟上限 */
const SESSION_SAVE_DEBOUNCE_MS = 200;
const SESSION_SAVE_MAX_WAIT_MS = 2000;

/* R9-P1-8：每个用户允许同时存在的会话数上限（可配置） */
const DEFAULT_MAX_SESSIONS_PER_USER = 20;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  }).toString('hex');
}

/**
 * R9-P1-6：异步版口令哈希。
 * scryptSync 会**阻塞整个事件循环**（WebDAV 认证、静态资源、SSE 全部卡住），
 * 并发 DAV 认证即可把服务打满；新代码路径请优先用这个版本。
 * @param {string} password
 * @param {string} salt
 * @returns {Promise<string>} hex 哈希
 */
function hashPasswordAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, SCRYPT.keylen, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
    }, (err, key) => {
      if (err) return reject(err);
      resolve(key.toString('hex'));
    });
  });
}

/**
 * R9-P1-6：异步版口令校验（常量时间比较）。
 * @param {string} hash 库里的 hex 哈希
 * @param {string} password 明文
 * @param {string} salt 该用户的盐
 * @returns {Promise<boolean>}
 */
async function verifyPasswordAsync(hash, password, salt) {
  const calc = await hashPasswordAsync(password, salt);
  return safeEqual(hash, calc);
}

/** 常量时间比较，防时序攻击 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* 预计算的哑元哈希：模块加载时算一次（成本约 50-150ms，仅此一次），
   供「用户不存在」的登录路径做常量时间比较，避免多算一遍 scrypt。 */
const DUMMY_HASH = (() => {
  try { return hashPassword(DUMMY_PASSWORD, DUMMY_SALT); }
  catch { return null; }
})();

class UserStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json');
    this.users = [];
    this.byId = new Map();
    this.byName = new Map();
    this._loadError = false;      // users.json 存在但读不出来（损坏）
    this._pendingRegs = 0;        // 正在注册中的请求数（防止并发抢管理员）
    this.load();
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._loadError = false;
    } catch (e) {
      this.users = [];
      // 文件不存在 = 全新空库（正常）；文件存在但解析失败 = 损坏
      this._loadError = !!(e && e.code !== 'ENOENT');
      if (this._loadError) {
        console.error('[auth] 警告：users.json 存在但无法解析（' + (e && e.message) + '）——已按空库处理，且**不会**把管理员权限授予首个注册者');
      }
      this.reindex();
      this._tightenPerms();
      return;
    }
    this.users = Array.isArray(raw.users) ? raw.users : [];
    this.reindex();
    this._tightenPerms();
  }

  /** R9-P0-4：启动即把已存在的 0644 文件收紧到 0600（不等下一次写入） */
  _tightenPerms() {
    try {
      const st = fs.statSync(this.file);
      if ((st.mode & 0o777) !== SECRET_FILE_MODE) fs.chmodSync(this.file, SECRET_FILE_MODE);
    } catch { /* 文件不存在或无权修改：忽略 */ }
  }

  reindex() {
    this.byId.clear();
    this.byName.clear();
    for (const u of this.users) {
      this.byId.set(u.id, u);
      this.byName.set(u.username.toLowerCase(), u);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 2), {
      encoding: 'utf8', mode: SECRET_FILE_MODE,
    });
    try { fs.chmodSync(tmp, SECRET_FILE_MODE); } catch { /* 某些文件系统不支持 */ }
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, SECRET_FILE_MODE); } catch { /* 同上 */ }
  }

  get count() { return this.users.length; }

  findByName(username) { return this.byName.get(String(username).toLowerCase()) || null; }
  findById(id) { return this.byId.get(id) || null; }

  /**
   * R9-P0-2：新用户的角色判定。
   * 只依据**真实存储状态**（库里确实一个用户都没有）才给管理员，
   * 绝不接受请求参数里的 role —— 提权只能走要求已登录管理员的
   * /api/admin/users/create 路径。users.json 损坏时也不发放管理员
   * （否则「把库写坏」就等于「凭空造一个管理员」）。
   */
  _roleForNewUser() {
    if (this._loadError) return 'user';
    if (this.users.length !== 0) return 'user';
    if (this._pendingRegs > 1) return 'user';  // 并发注册：只有第一个是管理员
    return 'admin';
  }

  /** 注册参数校验（同步/异步注册共用） */
  _validate(username, password, opts) {
    username = String(username || '').trim();
    if (!/^[\w一-龥-]{2,32}$/.test(username)) {
      return { ok: false, error: '用户名需为 2-32 位字母、数字、下划线、连字符或中文' };
    }
    // R9-P1-5：下限可配置（默认保持 6，不破坏现网既有用户）
    const minLength = Math.max(DEFAULT_MIN_PASSWORD_LEN, Number(opts && opts.minLength) || DEFAULT_MIN_PASSWORD_LEN);
    if (typeof password !== 'string' || password.length < minLength || password.length > 128) {
      return { ok: false, error: `密码长度需为 ${minLength}-128 位` };
    }
    if (this.findByName(username)) return { ok: false, error: '该用户名已被注册' };
    return { ok: true, username };
  }

  /**
   * 注册用户（同步版，保留给既有同步调用点）。
   * @param {string} username
   * @param {string} password
   * @param {object} [opts] { minLength } —— 注意：**不接受** role，角色只由存储状态决定
   * @returns {{ok:true,user:object}|{ok:false,error:string}}
   */
  create(username, password, opts = {}) {
    const v = this._validate(username, password, opts);
    if (!v.ok) return v;
    // 同步占位：与 createAsync 共用同一个并发闸门，避免同步/异步混用时抢管理员
    this._pendingRegs++;
    try {
      const salt = randomId(16);
      const user = {
        id: randomId(8),
        username: v.username,
        // 首个注册者自动成为管理员（空库时才有管理员，否则全站无法配置）
        role: this._roleForNewUser(),
        salt,
        hash: hashPassword(password, salt),
        createdAt: new Date().toISOString(),
      };
      return this._commit(user);
    } finally {
      this._pendingRegs--;
    }
  }

  /**
   * R9-P1-6：注册用户（异步版）—— 口令哈希走异步 scrypt，不阻塞事件循环。
   * @returns {Promise<{ok:true,user:object}|{ok:false,error:string}>}
   */
  async createAsync(username, password, opts = {}) {
    const v = this._validate(username, password, opts);
    if (!v.ok) return v;
    // 同步占位：并发注册时只有第一个请求能拿到管理员角色
    this._pendingRegs++;
    try {
      const salt = randomId(16);
      const user = {
        id: randomId(8),
        username: v.username,
        role: this._roleForNewUser(),
        salt,
        hash: await hashPasswordAsync(password, salt),
        createdAt: new Date().toISOString(),
      };
      // await 期间可能已有同名用户注册成功
      if (this.findByName(user.username)) return { ok: false, error: '该用户名已被注册' };
      return this._commit(user);
    } finally {
      this._pendingRegs--;
    }
  }

  /** 落库并返回 */
  _commit(user) {
    this.users.push(user);
    this.reindex();
    this.save();
    return { ok: true, user };
  }

  verify(username, password) {
    const u = this.findByName(username);
    if (!u) {
      /* R9-P1-5：用户不存在时也要走一遍**同参数**的 scrypt + 常量时间比较。
         此前直接 return null，毫秒级返回与「存在但密码错（几十毫秒）」
         的时序差就是一个现成的用户名枚举器。 */
      const dh = hashPassword(password, DUMMY_SALT);
      if (DUMMY_HASH) safeEqual(DUMMY_HASH, dh);
      return null;
    }
    const calc = hashPassword(password, u.salt);
    if (!safeEqual(u.hash, calc)) return null;
    if (u.disabled) return null; // v4：管理员禁用的账号拒绝登录
    return u;
  }

  /**
   * R9-P1-6：异步版登录校验（时序防护与同步版一致）。
   * @returns {Promise<object|null>} 校验通过返回用户，否则 null
   */
  async verifyAsync(username, password) {
    const u = this.findByName(username);
    if (!u) {
      const dh = await hashPasswordAsync(password, DUMMY_SALT);
      if (DUMMY_HASH) safeEqual(DUMMY_HASH, dh);
      return null;
    }
    const calc = await hashPasswordAsync(password, u.salt);
    if (!safeEqual(u.hash, calc)) return null;
    if (u.disabled) return null;
    return u;
  }

  publicUser(u) {
    if (!u) return null;
    return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, disabled: !!u.disabled };
  }
}

class SessionStore {
  /**
   * @param {string} dataDir
   * @param {object} [opts] { maxPerUser } 每用户会话数上限（缺省 20）
   */
  constructor(dataDir, opts = {}) {
    this.file = path.join(dataDir, 'sessions.json');
    this.sessions = new Map();
    this._saveTimer = null;
    this._dirtySince = 0;
    // R9-P1-8：每用户最大会话数（可配置；也可用环境变量 DSH_SESSION_MAX_PER_USER）
    this.maxPerUser = Math.max(1, Math.floor(
      Number(opts && opts.maxPerUser) || Number(process.env.DSH_SESSION_MAX_PER_USER) || DEFAULT_MAX_SESSIONS_PER_USER,
    ));
    this.load();
    this.cleanup();
    // 每小时清理一次过期会话
    this.timer = setInterval(() => this.cleanup(), 3600 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const s of Array.isArray(raw.sessions) ? raw.sessions : []) {
        this.sessions.set(s.id, s);
      }
    } catch { /* 首次运行无文件 */ }
    // R9-P0-4：启动即把 0644 的 sessions.json 收紧到 0600
    try {
      const st = fs.statSync(this.file);
      if ((st.mode & 0o777) !== SECRET_FILE_MODE) fs.chmodSync(this.file, SECRET_FILE_MODE);
    } catch { /* 文件不存在：忽略 */ }
  }

  /**
   * R9-P1-7：请求落盘（**防抖**）——同一时间窗内的多次变更只写一次，
   * 避免每次登录/登出都全量同步重写整个 sessions.json。
   */
  save() {
    const now = Date.now();
    if (!this._dirtySince) this._dirtySince = now;
    if (this._saveTimer) {
      // 已有待写任务：若已等太久则立即落盘，防止会话长时间不落盘
      if (now - this._dirtySince >= SESSION_SAVE_MAX_WAIT_MS) this.flush();
      return;
    }
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._write(); }, SESSION_SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /**
   * R9-P1-7：立即同步落盘（原子写）。**进程退出前应调用**，
   * 否则防抖窗口内的新会话会丢（下次登录重新签发即可，但会话数会漂移）。
   */
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._write();
  }

  /** 原子写：临时文件（0600）→ rename；rename 后权限随 inode 一起生效 */
  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()] }, null, 2), {
        encoding: 'utf8', mode: SECRET_FILE_MODE,
      });
      try { fs.chmodSync(tmp, SECRET_FILE_MODE); } catch { /* 某些文件系统不支持 */ }
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, SECRET_FILE_MODE); } catch { /* 同上 */ }
      this._dirtySince = 0;
    } catch { /* 会话持久化失败不影响主流程 */ }
  }

  create(userId) {
    const now = Date.now();
    const s = { id: randomId(24), userId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
    this.sessions.set(s.id, s);
    // R9-P1-8：超过每用户上限时淘汰最旧的会话
    this._evictForUser(userId);
    this.save();
    return s;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(id);
      // R9-P1-8：删除过期会话后必须落盘，否则过期凭据仍留在文件里
      this.save();
      return null;
    }
    return s;
  }

  destroy(id) {
    this.sessions.delete(id);
    this.save();
  }

  /** R9-P1-8：淘汰某用户超出上限的最旧会话 */
  _evictForUser(userId) {
    const mine = [...this.sessions.values()].filter((s) => s.userId === userId);
    if (mine.length <= this.maxPerUser) return 0;
    mine.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const drop = mine.slice(0, mine.length - this.maxPerUser);
    for (const s of drop) this.sessions.delete(s.id);
    return drop.length;
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (now > s.expiresAt) { this.sessions.delete(id); changed = true; }
    }
    // 过期清理后统一按用户收敛到上限
    const byUser = new Map();
    for (const s of this.sessions.values()) {
      if (!byUser.has(s.userId)) byUser.set(s.userId, []);
      byUser.get(s.userId).push(s);
    }
    for (const userId of byUser.keys()) {
      if (this._evictForUser(userId)) changed = true;
    }
    if (changed) this.save();
  }
}

module.exports = {
  UserStore, SessionStore,
  hashPassword, hashPasswordAsync, verifyPasswordAsync,
  SESSION_TTL_MS, SECRET_FILE_MODE, DEFAULT_MAX_SESSIONS_PER_USER,
};

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authtest-'));

  /* R9-P0-2：空库注册 → 管理员；已有用户时注册 → 普通用户 */
  const s1 = new UserStore(tmpDir);
  const r1 = s1.create('admin1', 'secret123');
  check('空库首个用户为 admin', r1.ok && r1.user.role, 'admin');
  const r2 = s1.create('user1', 'secret123');
  check('已有用户后注册为 user', r2.ok && r2.user.role, 'user');
  check('重复用户名被拒', s1.create('admin1', 'secret123').ok, false);
  // role 不能由调用参数提升
  const r3 = s1.create('sneaky', 'secret123', { role: 'admin' });
  check('调用参数无法提权', r3.ok && r3.user.role, 'user');

  /* R9-P1-5：口令长度下限可配置，但不得低于 6 */
  check('默认 6 位下限拒绝 5 位', s1.create('shorty', '12345').ok, false);
  check('默认 6 位下限接受 6 位', s1.create('ok6', '123456').ok, true);
  check('minLength=10 拒绝 8 位', s1.create('shorty2', '12345678', { minLength: 10 }).ok, false);
  check('minLength=10 接受 12 位', s1.create('longok', '123456789012', { minLength: 10 }).ok, true);

  /* R9-P1-5 / P1-6：登录校验 */
  check('正确口令可登录', !!s1.verify('admin1', 'secret123'), true);
  check('错误口令拒绝', s1.verify('admin1', 'wrongpass'), null);
  check('用户不存在返回 null', s1.verify('nobody', 'whatever'), null);
  check('禁用账号拒绝', (() => { const u = s1.findByName('user1'); u.disabled = true; const r = s1.verify('user1', 'secret123'); u.disabled = false; return r; })(), null);

  /* R9-P0-4：users.json 权限必须是 0600
     （Windows 的 chmod 只能表达「只读」标志，无法表示 0600，
       因此权限断言仅在 POSIX（生产环境）生效，Windows 上只报告实际值） */
  const posix = process.platform !== 'win32';
  const modeOf = (f) => fs.statSync(f).mode & 0o777;
  const uFile = path.join(tmpDir, 'users.json');
  console.log(`      users.json 实际权限 = 0${modeOf(uFile).toString(8)}`);
  check('users.json 权限 0600', posix ? modeOf(uFile) : 'skip-win32', posix ? 0o600 : 'skip-win32');

  /* R9-P1-7 / P1-8：会话 */
  const sStore = new SessionStore(tmpDir, { maxPerUser: 3 });
  const a = sStore.create('u1');
  check('会话可取回', sStore.get(a.id) && sStore.get(a.id).userId, 'u1');
  for (let i = 0; i < 5; i++) sStore.create('u1');
  check('每用户会话数受限', [...sStore.sessions.values()].filter((x) => x.userId === 'u1').length <= 3, true);
  check('最旧会话被淘汰', sStore.get(a.id), null);
  sStore.flush();
  const sFile = path.join(tmpDir, 'sessions.json');
  console.log(`      sessions.json 实际权限 = 0${modeOf(sFile).toString(8)}`);
  check('sessions.json 权限 0600', posix ? modeOf(sFile) : 'skip-win32', posix ? 0o600 : 'skip-win32');
  const reread = new SessionStore(tmpDir);
  check('flush 后可从磁盘恢复', reread.sessions.size > 0, true);
  // 过期会话必须被清掉并落盘
  const exp = sStore.create('u2');
  exp.expiresAt = Date.now() - 1000;
  sStore.cleanup();
  check('过期会话被清理', sStore.get(exp.id), null);
  sStore.flush();
  const reread2 = new SessionStore(tmpDir);
  check('过期会话不残留磁盘', [...reread2.sessions.values()].some((x) => x.id === exp.id), false);

  /* 异步版（不依赖返回值，只验证接口可用且结果一致） */
  (async () => {
    const salt = 'a1b2c3d4e5f6a7b8';
    const h = await hashPasswordAsync('secret123', salt);
    check('异步哈希与同步一致', h, hashPassword('secret123', salt));
    check('异步校验通过', await verifyPasswordAsync(h, 'secret123', salt), true);
    check('异步校验拒绝', await verifyPasswordAsync(h, 'nope', salt), false);
    const u = s1.findByName('admin1');
    check('异步登录成功', !!(await s1.verifyAsync('admin1', 'secret123')), true);
    check('异步登录用户不存在', await s1.verifyAsync('nobody', 'x'), null);

    console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}

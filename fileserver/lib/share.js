'use strict';

/* =====================================================================
   lib/share.js — 限时分享链接（免登录、可撤销、次数限制）
   为什么需要它：
     「把文件推给电视 / 访客手机」时，对方设备没登录过工作站，
     也就拿不到下载权限。分享链接把这个缺口补上——生成时校验一次
     权限，之后凭 token 取件，窗口期结束自动失效。

   安全设计：
     - token 用 crypto 随机（24 字节 hex），不可枚举
     - 创建时**校验创建者的读权限**，之后不再复检（权限在生成瞬间固化）
     - 有效期 + 最大下载次数双限制
     - 可随时撤销；服务重启后从落盘恢复

   R9-P1-11（四处加固）：
     1) 取件前用 realpath **回校路径仍在原目录内** —— 只 existsSync 是不够的：
        源文件被换成符号链接后，createReadStream 会跟随，读出树外文件。
     2) maxUses 默认由 0（不限次）改为 1：分享链接是免登录凭据，
        不限次 = 永久公开。
     3) 计数改到「下载开始」时占位，且 check+自增在同一段同步代码内完成
        （Node 单线程、中间无 await），并发请求无法绕过次数上限。
     4) 按 IP 限速：匿名取件接口必须能挡住单个 IP 的暴力试 token。

   落盘：<dataDir>/share-links.json（含 token 与绝对路径，权限 0600）
   零依赖。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RequestLimiter } = require('./ratelimit');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;   // 默认 24 小时
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 最长 30 天
const DEFAULT_MAX_USES = 1;                   // R9-P1-11：默认只允许下载 1 次（此前 0 = 不限次）
const KEEP = 500;
const SAVE_DEBOUNCE_MS = 1500;
const SECRET_FILE_MODE = 0o600;               // share-links.json 存着取件凭据

class Share {
  constructor(srv) {
    this.srv = srv;
    this.file = path.join(srv.cfg.dataDir, 'share-links.json');
    this.links = new Map();     // token -> link
    this._saveTimer = null;
    this._timer = null;
    this._hits = 0;
    this._warnedNoIp = false;
    // R9-P1-11：按 IP 限速（cfg.station 现网不存在 → 全部走默认值）
    const st = (srv.cfg && srv.cfg.station) || {};
    this._ipLimitMax = Math.max(1, Number(st.shareRatePerMin) || 60);
    this._ipLimitWindowMs = Math.max(1000, Number(st.shareRateWindowMs) || 60000);
    this._ipLimiter = new RequestLimiter({
      windowMs: this._ipLimitWindowMs, max: this._ipLimitMax, maxClients: 4096,
    });
    this._load();
  }

  /* ------------------------------ 落盘 ------------------------------ */

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) {
        for (const l of raw) {
          if (!l || !l.token) continue;
          // R9-P1-11：现网存在 maxUses=0（不限次）的旧链接，一并收紧为 1 次
          if (!Number.isFinite(Number(l.maxUses)) || Number(l.maxUses) < 1) l.maxUses = DEFAULT_MAX_USES;
          this.links.set(l.token, l);
        }
      }
    } catch { /* 首次启动 */ }
    this.prune();
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _save() {
    try {
      const list = [...this.links.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, KEEP);
      // 原子写（tmp + rename）+ 0600：文件里存着可直接取件的 token
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: SECRET_FILE_MODE });
      try { fs.chmodSync(tmp, SECRET_FILE_MODE); } catch { /* 某些文件系统不支持 */ }
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, SECRET_FILE_MODE); } catch { /* 同上 */ }
    } catch { /* 忽略 */ }
  }

  /* ------------------------------ 创建与取用 ------------------------------ */

  /**
   * 创建一条分享链接（调用方需已完成权限校验并给出绝对路径）。
   * @param {object} o { disk, path, name, abs, size, isDir, ttlMs, maxUses, label }
   * @param {object} [actor] { user, deviceId, deviceName }
   */
  create(o = {}, actor = {}) {
    const abs = String(o.abs || '');
    if (!abs) return { ok: false, error: '缺少文件绝对路径' };

    const ttl = Math.max(60 * 1000, Math.min(MAX_TTL_MS, Number(o.ttlMs) || DEFAULT_TTL_MS));
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();

    const link = {
      token,
      disk: String(o.disk || 'public'),
      path: String(o.path || ''),
      name: String(o.name || '').slice(0, 200) || path.basename(abs),
      abs,
      size: Number(o.size) || 0,
      isDir: !!o.isDir,
      label: String(o.label || '').slice(0, 80),
      at: now,
      expiresAt: now + ttl,
      ttlMs: ttl,
      uses: 0,
      // R9-P1-11：默认 1 次（此前 0 = 不限次）；显式传 0 也按 1 处理，
      // 即「不再提供不限次的分享链接」——免登录凭据不该能永久公开。
      maxUses: Math.max(1, Math.floor(Number(o.maxUses) || DEFAULT_MAX_USES)),
      by: String(actor.user || ''),
      fromDevice: String(actor.deviceId || ''),
      fromName: String(actor.deviceName || ''),
      revoked: false,
    };
    this.links.set(token, link);

    // 上限保护
    if (this.links.size > KEEP) {
      const old = [...this.links.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
      for (const l of old.slice(0, this.links.size - KEEP)) this.links.delete(l.token);
    }

    this._saveSoon();
    this._publish('share.created', { token, name: link.name, disk: link.disk, path: link.path });
    return { ok: true, link, url: '/s/' + token };
  }

  /**
   * R9-P1-11：回校取件路径仍在**原目录内**。
   * 只用 existsSync 判断是不够的：链接创建之后，源文件可能被换成符号链接，
   * createReadStream 会跟随符号链接，于是「分享一个文件」能读出树外的任意文件。
   * 做法：realpath(文件) 必须落在 realpath(原目录) 之内，否则直接拒绝。
   * @returns {{realFile?:string, error?:string}}
   */
  _safeRealPath(l) {
    const abs = String((l && l.abs) || '');
    if (!abs) return { error: '链接缺少路径' };
    let realFile = '';
    let realDir = '';
    try { realFile = fs.realpathSync(abs); }
    catch { return { error: '源文件已不存在' }; }
    try { realDir = fs.realpathSync(path.dirname(abs)); }
    catch { return { error: '源目录不可访问' }; }
    if (realFile !== realDir && !realFile.startsWith(realDir + path.sep)) {
      return { error: '源文件路径异常（疑似符号链接越界）' };
    }
    return { realFile };
  }

  /**
   * 凭 token 取件（免登录）。返回链接记录并**占位**一次下载次数。
   * @param {string} token
   * @param {string} [clientIp] 客户端 IP —— 用于按 IP 限速（server.js 需传入）
   */
  resolve(token, clientIp) {
    const t = String(token || '').trim();
    if (!t || t.length < 16) return { ok: false, error: '链接无效' };

    // R9-P1-11：按 IP 限速。匿名取件接口必须挡得住单个 IP 的暴力试 token。
    if (clientIp) {
      const rl = this._ipLimiter.check(clientIp);
      if (!rl.ok) {
        return { ok: false, error: '请求过于频繁，请稍后再试', rateLimited: true, retryAfterMs: rl.retryAfterMs };
      }
    } else if (!this._warnedNoIp) {
      this._warnedNoIp = true;
      console.warn('[share] 提示：resolve() 未收到客户端 IP，按 IP 限速未生效（server.js 需传 req.socket.remoteAddress）');
    }

    const l = this.links.get(t);
    if (!l) return { ok: false, error: '链接不存在或已撤销' };
    if (l.revoked) return { ok: false, error: '链接已撤销' };
    if (Date.now() > l.expiresAt) { this.links.delete(t); this._saveSoon(); return { ok: false, error: '链接已过期' }; }
    if (l.maxUses > 0 && l.uses >= l.maxUses) return { ok: false, error: '链接已达下载次数上限' };

    // R9-P1-11：回校路径仍在线内（防符号链接越界读文件）
    const safe = this._safeRealPath(l);
    if (safe.error) return { ok: false, error: safe.error };

    /* R9-P1-11：计数在**下载开始**时占位，且「检查 + 自增」在同一段同步代码里
       完成 —— Node 单线程、其间没有 await，因此并发请求不可能插进来
       把次数上限绕过去（此前的 check 在前、++ 在后，中间夹着 existsSync，
       逻辑上是原子的，但计数发生在「取件」而非「下载」）。 */
    l.uses++;
    l.lastUsedAt = Date.now();
    this._hits++;
    this._saveSoon();
    return { ok: true, link: l, realAbs: safe.realFile, reserved: true };
  }

  /**
   * R9-P1-11：下载**没有真正开始**时归还已占用的次数。
   * resolve() 先占位（保证次数上限不被并发绕过），
   * 若随后开流失败（文件被删、客户端立刻断开），调用方应调用本方法归还。
   */
  release(token) {
    const l = this.links.get(String(token || ''));
    if (!l) return { ok: false, error: '链接不存在' };
    if (l.uses > 0) l.uses--;
    this._saveSoon();
    return { ok: true };
  }

  revoke(token) {
    const l = this.links.get(String(token || ''));
    if (!l) return { ok: false, error: '链接不存在' };
    l.revoked = true;
    this._saveSoon();
    this._publish('share.revoked', { token: l.token, name: l.name });
    return { ok: true };
  }

  remove(token) {
    const t = String(token || '');
    if (!this.links.has(t)) return { ok: false, error: '链接不存在' };
    this.links.delete(t);
    this._saveSoon();
    return { ok: true };
  }

  /** 只列有效链接，附剩余时间 */
  list(opt = {}) {
    const now = Date.now();
    let list = [...this.links.values()].filter((l) => !l.revoked && now <= l.expiresAt);
    if (opt.includeExpired) list = [...this.links.values()];
    if (opt.mine) list = list.filter((l) => l.by === opt.mine);
    list.sort((a, b) => (b.at || 0) - (a.at || 0));
    return list.slice(0, Math.max(1, Number(opt.limit) || 100)).map((l) => ({
      ...l,
      leftS: Math.max(0, Math.round((l.expiresAt - now) / 1000)),
      url: '/s/' + l.token,
    }));
  }

  /* ------------------------------ 维护 ------------------------------ */

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => this.prune(), 60000);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; this._save(); }
  }

  prune() {
    const now = Date.now();
    let n = 0;
    for (const [k, l] of this.links) {
      const dead = l.revoked || now > l.expiresAt || (l.maxUses > 0 && l.uses >= l.maxUses);
      // 失效链接保留 1 小时便于前端提示，之后彻底清掉
      if (dead && now - (l.lastUsedAt || l.at) > 3600 * 1000) { this.links.delete(k); n++; }
    }
    if (n) this._saveSoon();
    return n;
  }

  stats() {
    const now = Date.now();
    const all = [...this.links.values()];
    return {
      total: all.length,
      active: all.filter((l) => !l.revoked && now <= l.expiresAt && !(l.maxUses > 0 && l.uses >= l.maxUses)).length,
      revoked: all.filter((l) => l.revoked).length,
      hits: this._hits,
    };
  }

  _publish(type, data) {
    if (this.srv && this.srv.hub) {
      try { this.srv.hub.publish('files', type, data); } catch { /* 忽略 */ }
    }
  }
}

module.exports = { Share, DEFAULT_TTL_MS, DEFAULT_MAX_USES };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharetest-'));
  const shareDir = path.join(tmpDir, 'share');
  const outDir = path.join(tmpDir, 'outside');
  fs.mkdirSync(shareDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const goodFile = path.join(shareDir, 'a.txt');
  const secretFile = path.join(outDir, 'secret.txt');
  fs.writeFileSync(goodFile, 'hello');
  fs.writeFileSync(secretFile, 'TOP SECRET');

  const srv = { cfg: { dataDir: tmpDir, station: {} } };
  const sh = new Share(srv);

  /* R9-P1-11：maxUses 默认 1（此前 0 = 不限次） */
  const l1 = sh.create({ disk: 'public', path: 'a.txt', abs: goodFile, size: 5 });
  check('默认 maxUses 为 1', l1.link.maxUses, 1);
  const l0 = sh.create({ disk: 'public', path: 'a.txt', abs: goodFile, size: 5, maxUses: 0 });
  check('显式 0 也被收紧为 1', l0.link.maxUses, 1);
  const l5 = sh.create({ disk: 'public', path: 'a.txt', abs: goodFile, size: 5, maxUses: 5 });
  check('显式次数被保留', l5.link.maxUses, 5);

  /* 取件：占用一次 + 达到上限后拒绝 */
  const r1 = sh.resolve(l1.link.token);
  check('首次取件成功', r1.ok, true);
  check('取件后 uses=1', l1.link.uses, 1);
  check('返回 realAbs', r1.realAbs, fs.realpathSync(goodFile));
  const r2 = sh.resolve(l1.link.token);
  check('超过次数上限被拒', r2.ok, false);
  check('超限错误信息', r2.error, '链接已达下载次数上限');

  /* release：下载未开始时归还次数 */
  const l3 = sh.create({ disk: 'public', path: 'a.txt', abs: goodFile, size: 5, maxUses: 2 });
  sh.resolve(l3.link.token);
  check('占用后 uses=1', l3.link.uses, 1);
  sh.release(l3.link.token);
  check('release 后 uses=0', l3.link.uses, 0);
  check('归还后可再次取件', sh.resolve(l3.link.token).ok, true);

  /* 过期 / 撤销 */
  const lExp = sh.create({ disk: 'public', path: 'a.txt', abs: goodFile, size: 5, ttlMs: 60 * 1000 });
  lExp.link.expiresAt = Date.now() - 1000;
  check('过期链接被拒', sh.resolve(lExp.link.token).ok, false);
  const lRev = sh.create({ disk: 'public', path: 'a.txt', abs: goodFile, size: 5 });
  sh.revoke(lRev.link.token);
  check('已撤销链接被拒', sh.resolve(lRev.link.token).ok, false);

  /* R9-P1-11：符号链接越界必须被拒（源文件被换成指向树外的链接） */
  let symlinkOk = true;
  try {
    const linkPath = path.join(shareDir, 'link.txt');
    try { fs.unlinkSync(linkPath); } catch { /* 不存在 */ }
    fs.symlinkSync(secretFile, linkPath);
    const lSym = sh.create({ disk: 'public', path: 'link.txt', abs: linkPath, size: 10 });
    const rSym = sh.resolve(lSym.link.token);
    check('符号链接越界被拒', rSym.ok, false);
    check('越界错误信息', rSym.error, '源文件路径异常（疑似符号链接越界）');
  } catch (e) {
    symlinkOk = false;
    console.log(`      [跳过] 符号链接用例：${e.message}（Windows 需开发者模式/管理员）`);
  }

  /* 打桩验证「越界即拒」的判定逻辑（Windows 上建不了符号链接，用打桩覆盖同一条分支） */
  {
    const origReal = fs.realpathSync;
    const target = path.join(shareDir, 'a.txt');
    try {
      fs.realpathSync = (p) => (String(p) === target ? secretFile : origReal(p));  // 模拟符号链接指向树外
      const lStub = sh.create({ disk: 'public', path: 'a.txt', abs: target, size: 5 });
      const rStub = sh.resolve(lStub.link.token);
      check('打桩：越界路径被拒', rStub.ok, false);
      check('打桩：越界错误信息', rStub.error, '源文件路径异常（疑似符号链接越界）');
    } finally {
      fs.realpathSync = origReal;
    }
  }

  /* R9-P1-11：按 IP 限速 */
  const rl = sh.create({ disk: 'public', path: 'a.txt', abs: goodFile, size: 5, maxUses: 999 });
  let limited = false;
  for (let i = 0; i < 200; i++) {
    const rr = sh.resolve(rl.link.token, '10.1.1.1');
    if (rr.rateLimited) { limited = true; break; }
  }
  check('同 IP 连续取件被限速', limited, true);
  const other = sh.resolve(rl.link.token, '10.1.1.2');
  check('其它 IP 不受影响', !!other.rateLimited, false);

  /* 源文件被删除 → 拒绝 */
  const gone = path.join(shareDir, 'gone.txt');
  const lGone = sh.create({ disk: 'public', path: 'gone.txt', abs: gone, size: 1 });
  const rGone = sh.resolve(lGone.link.token);
  check('源文件不存在被拒', rGone.ok, false);
  check('源文件不存在错误信息', rGone.error, '源文件已不存在');

  /* 落盘文件权限（Windows 无法表达 0600，仅 POSIX 断言） */
  sh._save();
  const posix = process.platform !== 'win32';
  const mode = fs.statSync(path.join(tmpDir, 'share-links.json')).mode & 0o777;
  console.log(`      share-links.json 实际权限 = 0${mode.toString(8)}`);
  check('share-links.json 权限 0600', posix ? mode : 'skip-win32', posix ? 0o600 : 'skip-win32');

  console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

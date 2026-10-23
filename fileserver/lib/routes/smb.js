'use strict';

/**
 * R15-P0：SMB / 连接服务路由（可插拔路由层模块）
 *
 * 前缀：/api/smb
 *   GET  /api/smb/status     本人共享、认证状态、最近失败次数、fail2ban 锁定状态
 *   GET  /api/smb/account    （兼容旧页面）连接服务状态：enabled=true + 共享清单
 *   POST /api/smb/account    （兼容旧页面）设置本人 SMB 密码
 *   POST /api/smb/rotate     本人改 SMB 密码（可带 currentPassword 校验，改完长期有效）
 *   GET  /api/smb/users      管理员：全部账号的 Linux/Samba/家目录/共享权限
 *   GET  /api/smb/config     管理员：只读预览即将生成的配置（不写盘）
 *   POST /api/smb/apply      管理员：重建配置（幂等；默认写盘 + reload smbd）
 *   GET  /api/smb/audit      本人/管理员：SMB 认证失败审计（来自 data/audit.log）
 *
 * 鉴权自己做：ctx.user 为 null → 401；管理员 = user.role === 'admin'
 * 或 acl.json groups.admins 成员（见 smb-accounts.roleOf）。
 * 所有写操作都写审计。
 */

const accounts = require('../smb-accounts');

const PREFIX = '/api/smb';
const DEFAULT_HOST = '192.168.99.1';

/* 90 秒自动应用：账号增删/禁用/ACL 变化后自动重建配置并 reload（幂等，无变化不产生特权调用） */
let appRef = null;
let watchStarted = false;

/**
 * ⚠️ 2026-10-22 事故修复（R15）：
 *   原实现是 `accounts.watchTick(appRef).catch(...)`，但 watchTick 是**同步函数**，
 *   返回值是普通对象、没有 .catch —— 于是 setInterval 回调每 90 秒抛一次
 *   `TypeError: accounts.watchTick(...).catch is not a function`，且因为发生在
 *   timer 回调里，属于未捕获异常，直接把整个 node 进程打崩（systemd 反复重启，
 *   journalctl 里能看到每 ~2 分钟一条 Started）。
 *   修法三条，缺一不可：
 *     ① 不再假设返回 Promise：只有真的返回 thenable 才挂 .catch；
 *     ② 整段包 try/catch：定时任务出任何错都不许影响主服务；
 *     ③ 参数按 watchTick(app, opts) 的真实签名传，别再把自己的 app 当 opts。
 */
function safeWatchTick() {
  try {
    const r = accounts.watchTick(appRef, { dataDir: dataDirOf(appRef) });
    if (r && typeof r.then === 'function') {
      r.catch((e) => console.warn('[smb] watchTick 异步失败（忽略）:', e && e.message));
    }
  } catch (e) {
    console.warn('[smb] watchTick 异常（已忽略，不影响服务）:', (e && e.message) || e);
  }
}

function startWatcher() {
  if (watchStarted) return;
  watchStarted = true;
  const timer = setInterval(safeWatchTick, 90 * 1000);
  if (timer.unref) timer.unref();
  /* 启动 15 秒后先对一次账（避开启动瞬间的磁盘/权限抖动） */
  const kick = setTimeout(safeWatchTick, 15 * 1000);
  if (kick.unref) kick.unref();
}

/* 服务启动即自愈：不依赖第一次请求。20 秒后做一次状态对账，
   账号被误删/被停用/配置被外部还原都会自动修复（无漂移时零写操作）。 */
const bootHeal = setTimeout(safeWatchTick, 20 * 1000);
if (bootHeal.unref) bootHeal.unref();

function dataDirOf(app) {
  return (app && app.cfg && app.cfg.dataDir) || undefined;
}
function hostOf(app) {
  try {
    if (app && typeof app.smbHost === 'function') return app.smbHost();
  } catch { /* 回落 */ }
  return DEFAULT_HOST;
}
function isAdmin(app, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  try { return accounts.roleOf(user, dataDirOf(app)) === 'admin'; } catch { return false; }
}
function cliIp(req) {
  return String((req && req.socket && req.socket.remoteAddress) || '');
}

/* ───────── 其他连接服务协议的真实探活（SMB 页面的"其他协议"卡片用） ─────────
   只做 127.0.0.1 的 TCP/HTTP 探测，不外联；15 秒缓存，避免刷新一次打一堆连接。 */

const net = require('net');
const http = require('http');
const PROTO_CACHE_MS = 15000;
let _protoCache = { at: 0, data: null };

function tcpProbe(port, host, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 已断 */ }
      resolve(ok);
    };
    const sock = net.connect({ port, host: host || '127.0.0.1' });
    sock.setTimeout(timeoutMs || 900, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

function httpProbe(port, path, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs || 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

async function probeProtocols(app) {
  if (_protoCache.data && Date.now() - _protoCache.at < PROTO_CACHE_MS) return _protoCache.data;
  const svcs = (app && app.svcs) || {};
  const cfg = (app && app.cfg) || {};
  /* 端口一律从运行时配置取：主服务可能被 PORT 改过，FTP/NFS 也可能被顺延
     （见 server.js 的 _auxPort）。写死 8081/2049 会让「连接服务」页在非默认端口的
     部署里整页飘红——明明服务好着。 */
  const web = Number(cfg.port) || 8081;
  const ftpPort = Number(svcs.ftp) || Number(cfg.ftpPort) || 2121;
  const nfsPort = Number(svcs.nfs) || Number(cfg.nfsPort) || 2049;
  const mountPort = Number(svcs.nfsMount) || Number(cfg.nfsMountPort) || 42000;
  const [davCode, s3Code, officeCode, officeTcp, ftp, nfs, rsync, ssh, smbPort] = await Promise.all([
    httpProbe(web, '/dav'),
    httpProbe(web, '/s3'),
    httpProbe(mountPort, '/'),
    tcpProbe(mountPort),
    tcpProbe(ftpPort), tcpProbe(nfsPort), tcpProbe(873), tcpProbe(22), tcpProbe(445),
  ]);
  const officeUp = officeCode > 0 || officeTcp;
  const list = [
    { id: 'smb', name: 'SMB / CIFS', endpoint: '\\\\<host>\\<共享>', port: 445, active: smbPort, detail: '个人账号认证 · 无 guest · SMB3' },
    { id: 'dav', name: 'WebDAV', endpoint: '/dav', port: web, active: davCode > 0, detail: davCode ? ('HTTP ' + davCode + '（需登录）') : '无响应' },
    { id: 's3', name: 'S3 网关', endpoint: '/s3', port: web, active: s3Code > 0, detail: s3Code ? ('HTTP ' + s3Code) : '无响应' },
    { id: 'ftp', name: 'FTP', endpoint: 'ftp://<host>:' + ftpPort, port: ftpPort, active: ftp, detail: '匿名只读（历史兼容）' },
    { id: 'nfs', name: 'NFS', endpoint: '<host>:/storage', port: nfsPort, active: nfs, detail: '游客权限（已不导出 private）' + (nfsPort !== 2049 ? ' · 非标准端口 ' + nfsPort : '') },
    { id: 'rsync', name: 'rsync', endpoint: 'rsync://<host>/', port: 873, active: rsync, detail: '只读 · 限私网' },
    { id: 'dlna', name: 'DLNA', endpoint: '/dlna/description.xml', port: web, active: svcs.dlna === true || davCode > 0, detail: '只读媒体发现' },
    { id: 'mdns', name: 'mDNS', endpoint: '_station._tcp', port: 5353, active: svcs.mdns === true, detail: '仅发现' },
    { id: 'office', name: '办公协同 relay', endpoint: 'ws://<host>:' + mountPort, port: mountPort, active: officeUp, detail: officeTcp ? ('TCP ' + mountPort + ' 监听' + (officeCode ? ' · HTTP ' + officeCode : '')) : '无响应' },
    { id: 'ssh', name: 'SSH / SFTP', endpoint: 'ssh://<host>:22', port: 22, active: ssh, detail: '管理员通道' },
  ];
  const data = { at: new Date().toISOString(), activeCount: list.filter((x) => x.active).length, total: list.length, protocols: list };
  _protoCache = { at: Date.now(), data };
  return data;
}

async function readJsonBody(readBody, req, limit) {
  const raw = await readBody(req, limit || 32 * 1024);
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new Error('请求体不是合法 JSON'); }
}

/** 改密失败限流（内存）：同一账号 5 分钟内最多 5 次校验失败 */
const rotateFails = new Map();
function rotateLocked(username) {
  const rec = rotateFails.get(username);
  if (!rec) return false;
  if (Date.now() > rec.until) { rotateFails.delete(username); return false; }
  return rec.count >= 5;
}
function rotateFail(username) {
  const rec = rotateFails.get(username) || { count: 0, until: 0 };
  if (Date.now() > rec.until) { rec.count = 0; rec.until = Date.now() + 5 * 60 * 1000; }
  rec.count++;
  rotateFails.set(username, rec);
}
function rotateOk(username) { rotateFails.delete(username); }

/**
 * 网页密码校验（用于 rotate 的二次确认）。
 * @returns {Promise<boolean>}
 */
async function verifyWebPassword(app, username, password) {
  try {
    if (app && app.users && typeof app.users.verifyAsync === 'function') {
      const u = await app.users.verifyAsync(username, password);
      return !!u;
    }
    if (app && app.users && typeof app.users.verify === 'function') {
      return !!app.users.verify(username, password);
    }
  } catch { /* 校验异常按失败处理 */ }
  return false;
}

/**
 * 把"当前网页密码"的 HMAC 指纹记为已同步，避免下一次登录把刚改的 SMB 密码覆盖回旧值。
 * 只在用户提供了 currentPassword 且校验通过时调用。
 */
function rememberLoginFingerprint(app, username, webPassword) {
  try {
    if (!app || typeof app._smbFp !== 'function' || typeof app._smbFpLoad !== 'function' || typeof app._smbFpSave !== 'function') return false;
    const store = app._smbFpLoad() || {};
    store[username] = app._smbFp(username, webPassword);
    app._smbFpSave(store);
    return true;
  } catch { return false; }
}

function serviceSummary(app, user) {
  const dataDir = dataDirOf(app);
  const svc = accounts.serviceState();
  const pdb = accounts.listSmbUsers();
  const flags = accounts.pdbFlags();
  const myFlags = flags.has(user.username) ? String(flags.get(user.username) || '') : null;
  const sambaDisabled = myFlags != null && myFlags.indexOf('D') >= 0;
  const shareList = accounts.shareList();
  const nameOk = accounts.NAME_RE.test(user.username);
  const names = shareList.map((s) => s.name);
  /* 本人私有共享也放进清单（旧页面只展示团队共享，新页面需要 [用户名]） */
  if (nameOk && names.indexOf(user.username) < 0) names.push(user.username);
  return {
    ok: true,
    enabled: svc.smbd.active,
    serviceEnabled: svc.smbd.active && svc.smbd.enabled,
    defaultOn: true,
    username: user.username,
    /* ready = passdb 存在且未被 D 标志停用（禁用→启用后若未恢复会显示 false 并提示重新同步） */
    accountReady: pdb.includes(user.username) && !sambaDisabled,
    sambaDisabled,
    host: '\\\\' + hostOf(app),
    hostIp: hostOf(app),
    shares: names,
    shareDetails: accounts.sharesForUser(user, dataDir),
    minPassword: accounts.MIN_PASS,
    nameOk,
    smbd: svc.smbd,
    nmbd: svc.nmbd,
    guestAllowed: false,
  };
}

const mod = {
  name: 'smb-connection',
  prefixes: [PREFIX],

  async handle(ctx) {
    const { req, res, app, user, pathname, method, sendJSON, readBody } = ctx;
    if (pathname !== PREFIX && pathname.indexOf(PREFIX + '/') !== 0) return false;
    appRef = app || appRef;
    startWatcher();
    const dataDir = dataDirOf(app);
    const host = hostOf(app);
    const ip = cliIp(req);

    try {
      /* ───────────── 本人状态 ───────────── */
      if (pathname === PREFIX + '/status' && method === 'GET') {
        if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
        const st = accounts.statusFor(user, { dataDir, host, app });
        /* 其他连接服务的真实状态（SMB 页面下方"其他协议"卡片） */
        try {
          const proto = await probeProtocols(app);
          st.protocols = proto.protocols;
          st.protocolSummary = { active: proto.activeCount, total: proto.total, at: proto.at };
        } catch { st.protocols = []; }
        return sendJSON(res, 200, st), true;
      }

      /* ───────────── 兼容旧「连接服务」卡片 ───────────── */
      if (pathname === PREFIX + '/account' && method === 'GET') {
        if (!user) return sendJSON(res, 401, { error: '需要登录后才能开通文件共享' }), true;
        const st = serviceSummary(app, user);
        return sendJSON(res, 200, st), true;
      }

      if (pathname === PREFIX + '/account' && method === 'POST') {
        if (!user) return sendJSON(res, 401, { error: '需要登录后才能开通文件共享' }), true;
        const body = await readJsonBody(readBody, req, 16 * 1024);
        const pw = String(body.password || '');
        const v = accounts.validateAccount(user.username, pw);
        if (!v.ok) return sendJSON(res, 400, { error: v.error }), true;
        const made = accounts.ensureSmbUser(user.username, pw);
        if (!made.ok) {
          app && app.audit && app.audit({ action: 'smb-enable', userObj: user, ok: false, detail: made.error, ip });
          return sendJSON(res, 500, { error: made.error }), true;
        }
        const ap = accounts.addUserToShares(user.username);
        const rl = accounts.reloadSamba();
        app && app.audit && app.audit({
          action: 'smb-enable', userObj: user, ok: true, ip,
          detail: (made.created ? '新建 SMB 账号' : '更新 SMB 密码') + '；配置' + (ap.ok ? (ap.changed ? '已重建' : '无变化') : '重建失败'),
        });
        return sendJSON(res, 200, {
          ok: true,
          created: !!made.created,
          username: user.username,
          host: '\\\\' + host,
          shares: accounts.shareList().map((s) => s.name),
          reloaded: !!rl.ok,
          enabled: true,
          defaultOn: true,
          accountReady: true,
        }), true;
      }

      /* ───────────── 本人改 SMB 密码 ───────────── */
      if (pathname === PREFIX + '/rotate' && method === 'POST') {
        if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
        if (rotateLocked(user.username)) {
          app && app.audit && app.audit({ action: 'smb-rotate', userObj: user, ok: false, detail: '尝试过于频繁，已临时限流', ip });
          return sendJSON(res, 429, { error: '尝试过于频繁，请 5 分钟后再试' }), true;
        }
        const body = await readJsonBody(readBody, req, 16 * 1024);
        const newPw = String(body.newPassword != null ? body.newPassword : (body.password || ''));
        const curPw = body.currentPassword != null ? String(body.currentPassword) : '';
        const v = accounts.validateAccount(user.username, newPw);
        if (!v.ok) return sendJSON(res, 400, { error: v.error }), true;
        let verified = false;
        if (curPw) {
          verified = await verifyWebPassword(app, user.username, curPw);
          if (!verified) {
            rotateFail(user.username);
            app && app.audit && app.audit({ action: 'smb-rotate', userObj: user, ok: false, detail: '当前网页密码校验失败', ip });
            return sendJSON(res, 403, { error: '当前密码不正确' }), true;
          }
        }
        const made = accounts.ensureSmbUser(user.username, newPw);
        if (!made.ok) {
          app && app.audit && app.audit({ action: 'smb-rotate', userObj: user, ok: false, detail: made.error, ip });
          return sendJSON(res, 500, { error: made.error }), true;
        }
        /* 家目录/账号状态顺带补齐（幂等；首次 rotate 时也保证家目录存在） */
        const ap = accounts.addUserToShares(user.username);
        let fpRemembered = false;
        if (verified) fpRemembered = rememberLoginFingerprint(app, user.username, curPw);
        rotateOk(user.username);
        app && app.audit && app.audit({
          action: 'smb-rotate', userObj: user, ok: true, ip,
          detail: 'SMB 密码已更新；' + (verified ? '已校验当前网页密码' : '未校验当前密码（旧版入口）')
            + (fpRemembered ? '；已冻结同步指纹（下次登录不会覆盖）' : ''),
        });
        return sendJSON(res, 200, {
          ok: true,
          username: user.username,
          accountReady: true,
          reloaded: !!ap.ok,
          fingerprintFrozen: fpRemembered,
          note: fpRemembered
            ? 'SMB 密码已单独设置；若之后修改网页密码，下次登录会同步为新的网页密码。'
            : 'SMB 密码已设置；下次网页登录会用网页密码覆盖（旧版入口的既有行为）。',
        }), true;
      }

      /* ───────────── 失败登录审计 ───────────── */
      if (pathname === PREFIX + '/audit' && method === 'GET') {
        if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
        const admin = isAdmin(app, user);
        let entries = [];
        try {
          if (app && typeof app.readAudit === 'function') entries = app.readAudit(400);
        } catch { entries = []; }
        entries = entries
          .filter((e) => e && (String(e.action || '').indexOf('smb') === 0))
          .filter((e) => admin || e.user === user.username || e.user === 'anonymous' || !e.user);
        const limit = Math.min(200, Math.max(1, parseInt((ctx.query && ctx.query.limit) || '50', 10) || 50));
        return sendJSON(res, 200, { ok: true, entries: entries.slice(0, limit), admin }), true;
      }

      /* ───────────── 管理员 ───────────── */
      if (pathname === PREFIX + '/users' && method === 'GET') {
        if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
        if (!isAdmin(app, user)) return sendJSON(res, 403, { error: '仅管理员可查看全部 SMB 账号' }), true;
        return sendJSON(res, 200, accounts.listUsersDetail({ dataDir })), true;
      }

      if (pathname === PREFIX + '/config' && method === 'GET') {
        if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
        if (!isAdmin(app, user)) return sendJSON(res, 403, { error: '仅管理员可预览共享配置' }), true;
        const pv = accounts.previewConfig({ dataDir });
        return sendJSON(res, 200, {
          ok: true,
          changed: pv.changed,
          configHash: pv.configHash,
          sources: pv.sources,
          warnings: pv.plan.warnings,
          shares: pv.plan.shares.map((s) => ({ name: s.name, path: s.path, acl: s.acl, readonly: s.readOnly, validUsers: s.validUsers, readUsers: s.readUsers, writeUsers: s.writeUsers })),
          homes: pv.plan.homes.map((h) => h.username),
          sharesConf: pv.sharesText,
          smbConf: pv.smbConfText,
        }), true;
      }

      if (pathname === PREFIX + '/apply' && method === 'POST') {
        if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
        if (!isAdmin(app, user)) return sendJSON(res, 403, { error: '仅管理员可重建共享配置' }), true;
        const body = await readJsonBody(readBody, req, 8 * 1024);
        const dryRun = body.dryRun === true || body.dryRun === '1';
        if (dryRun) {
          const pv = accounts.previewConfig({ dataDir });
          return sendJSON(res, 200, {
            ok: true, dryRun: true, changed: pv.changed, configHash: pv.configHash,
            sources: pv.sources, warnings: pv.plan.warnings,
            shares: pv.plan.shares.map((s) => ({ name: s.name, path: s.path, readonly: s.readOnly, validUsers: s.validUsers, writeUsers: s.writeUsers })),
            homes: pv.plan.homes.map((h) => h.username),
            sharesConf: pv.sharesText, smbConf: pv.smbConfText,
          }), true;
        }
        const r = accounts.applyConfig({
          dataDir, reason: 'api-apply', actor: user.username, forcePerms: body.forcePerms === true,
        });
        app && app.audit && app.audit({
          action: 'smb-apply', userObj: user, ok: r.ok !== false, ip,
          detail: '重建 SMB 共享配置：' + (r.ok ? ('changed=' + !!(r.changed === 1 || r.changed === true) + ' reloaded=' + !!(r.reloaded === 1 || r.reloaded === true) + ' shares=' + (r.shares ? r.shares.length : '?') + ' users=' + (r.users ? r.users.length : '?')) : ('失败：' + (r.error || r.stage || '未知'))),
        });
        const code = r.ok === false ? 500 : 200;
        return sendJSON(res, code, r), true;
      }

      /* ───────────── 管理员：账号/共享自愈对账（第 5 轮） ───────────── */
      if (pathname === PREFIX + '/reconcile' && method === 'GET') {
        if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
        if (!isAdmin(app, user)) return sendJSON(res, 403, { error: '仅管理员可查看对账状态' }), true;
        return sendJSON(res, 200, accounts.reconcileState({ dataDir, fresh: true })), true;
      }

      if (pathname === PREFIX + '/resync' && method === 'POST') {
        if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
        if (!isAdmin(app, user)) return sendJSON(res, 403, { error: '仅管理员可重新同步 SMB 账号' }), true;
        let body = {};
        try { body = await readJsonBody(readBody, req, 8 * 1024); } catch { body = {}; }
        const r = accounts.resync({
          dataDir, reason: 'api-resync', actor: user.username, forcePerms: body.forcePerms === true,
        });
        const before = r.before || {};
        const after = r.after || {};
        app && app.audit && app.audit({
          action: 'smb-resync', userObj: user, ok: r.ok !== false, ip,
          detail: 'SMB 账号/共享自愈：修复前漂移=' + (before.drift ? before.reasons.slice(0, 3).join('；') : '无')
            + '；修复后=' + (after.drift ? after.reasons.slice(0, 3).join('；') : '已对齐')
            + '；enabled=' + ((r.applied && r.applied.accountSync && r.applied.accountSync.enabled) || 0)
            + ' missing=' + (((r.applied && r.applied.accountSync && r.applied.accountSync.missing) || []).join(',') || '无'),
        });
        return sendJSON(res, r.ok ? 200 : 500, r), true;
      }

      return false;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      try { if (!res.headersSent) sendJSON(res, 400, { error: msg }); } catch { /* 已断 */ }
      return true;
    }
  },
};

module.exports = mod;

'use strict';

/* =====================================================================
   lib/routes/security.js — P0「数据与安全」模块的全部 HTTP 接口
   ---------------------------------------------------------------------
   这是本轮的**唯一新增入口**：不改 server.js，只加可插拔路由模块。
   接口分三类：
     A. 接管（改写）既有安全敏感入口，套上口令策略：
        POST /api/register                注册（策略 + 限速 + 建会话）
        POST /api/admin/users/create      管理员建号（策略 + 角色）
        POST /api/admin/users/setpass     管理员重置口令（策略 + 踢会话）
     B. 新接口（前端「数据与安全」页使用）：/api/security/*
     C. 只读状态采集（加密/风险/审计），不修改任何系统配置。

   统一约定（与 README-TEAM §3 一致）：
     · 未登录一律 401；需要管理员的 403（实测跨用户访问的证据就来自这里）；
     · 错误形状 {error:'中文原因'}；
     · 敏感操作全部写审计（app.audit），审计里带真实客户端 IP。
   ===================================================================== */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const store = require('../sec-store');
const secCtx = require('../sec-ctx');
const ipMod = require('../sec-ip');
const policyMod = require('../sec-policy');
const sessionMod = require('../sec-session-meta');
const riskMod = require('../sec-risk');
const cryptoMod = require('../sec-crypto');
const exportMod = require('../sec-export');
const qrMod = require('../sec-qr');
const totpLib = require('../totp');
const aclStore = require('../acl');
const snapshots = require('../snapshot');
const { hashPasswordAsync } = require('../auth');

const ISSUER = 'DeepSpace';
const MAX_BODY = 512 * 1024;

/* ------------------------------ 小工具 ------------------------------ */

function isAdmin(user) {
  return !!(user && (user.role === 'admin' || user.isAdmin));
}

function audit(app, req, user, action, detail, ok = true) {
  try {
    app.audit({
      userObj: user || null,
      user: user ? user.username : 'anonymous',
      action,
      detail: store.clip(detail, 400),
      ok: ok !== false,
      ip: store.clientIp(req),
    });
  } catch { /* 审计失败不影响主流程 */ }
}

/** 读 JSON body；失败返回 {ok:false}，由调用方回 400 */
async function readJson(ctx) {
  try {
    const buf = await ctx.readBody(ctx.req, MAX_BODY);
    if (!buf || !buf.length) return { ok: true, data: {} };
    const txt = buf.toString('utf8');
    if (!txt.trim()) return { ok: true, data: {} };
    const data = JSON.parse(txt);
    return (data && typeof data === 'object') ? { ok: true, data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** 简易节流：同一 key 在 windowMs 内最多 max 次 */
function throttle(app, key, max, windowMs) {
  try {
    if (!app.__secThrottle) app.__secThrottle = new Map();
    const now = Date.now();
    const list = (app.__secThrottle.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      app.__secThrottle.set(key, list);
      return false;
    }
    list.push(now);
    app.__secThrottle.set(key, list);
    return true;
  } catch {
    return true;
  }
}

/** 策略基线（只做一次，避免每个请求都读用户库） */
function ensureBaseline(app) {
  if (app.__secBaselineDone) return;
  app.__secBaselineDone = true;
  try { policyMod.ensureBaseline(app); } catch (e) {
    console.error('[routes:security] 策略基线失败：' + ((e && e.message) || e));
  }
}

/** 用当前策略校验口令（带历史比对） */
function evaluatePassword(app, password, username) {
  const data = policyMod.load(app);
  let history = [];
  let key = null;
  try {
    history = policyMod.historyOf(data, username);
    key = policyMod.historyKey(app);
  } catch { /* 历史不可用时不阻断主校验 */ }
  return policyMod.evaluate(password, data.policy, { username, history, key });
}

function policyErrorsText(res) {
  return (res.errors || []).join('；');
}

/* ------------------------------ 恢复码 ------------------------------ */

function recoveryFile(app) { return store.fileOf(app, 'recovery'); }

function recoveryData(app) {
  const raw = store.loadJSON(recoveryFile(app), null);
  if (!raw || typeof raw !== 'object' || !raw.users) return { version: 1, users: {} };
  return raw;
}

function hashRecovery(username, code) {
  const clean = String(code || '').replace(/[-\s]/g, '').toUpperCase();
  return crypto.createHash('sha256')
    .update(String(username || '').toLowerCase())
    .update('\u0000')
    .update(clean)
    .digest('hex');
}

/** 生成 8 个一次性恢复码（返回明文，只此一次；库里只存 sha256） */
function issueRecoveryCodes(app, username) {
  const codes = [];
  for (let i = 0; i < 8; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5, 10));
  }
  const data = recoveryData(app);
  data.users[String(username).toLowerCase()] = {
    createdAt: store.nowIso(),
    codes: codes.map((c) => ({ h: hashRecovery(username, c), usedAt: null })),
  };
  store.saveJSON(recoveryFile(app), data);
  return codes;
}

function consumeRecoveryCode(app, username, code) {
  const data = recoveryData(app);
  const rec = data.users[String(username).toLowerCase()];
  if (!rec || !Array.isArray(rec.codes)) return false;
  const h = hashRecovery(username, code);
  const hit = rec.codes.find((c) => c.h === h && !c.usedAt);
  if (!hit) return false;
  hit.usedAt = store.nowIso();
  store.saveJSON(recoveryFile(app), data);
  return true;
}

function clearRecoveryCodes(app, username) {
  const data = recoveryData(app);
  if (data.users[String(username).toLowerCase()]) {
    delete data.users[String(username).toLowerCase()];
    store.saveJSON(recoveryFile(app), data);
  }
}

function recoveryStatus(app, username) {
  const rec = recoveryData(app).users[String(username || '').toLowerCase()];
  if (!rec || !Array.isArray(rec.codes)) return { count: 0, remaining: 0, createdAt: null };
  return {
    count: rec.codes.length,
    remaining: rec.codes.filter((c) => !c.usedAt).length,
    createdAt: rec.createdAt || null,
  };
}

/* ------------------------------ TOTP 工具 ------------------------------ */

function otpauthOf(user, secret) {
  return totpLib.otpauthURI({ label: user.username, secret, issuer: ISSUER });
}

function qrPayload(uri) {
  try {
    const qr = qrMod.encode(uri);
    return { ok: true, version: qr.version, size: qr.size, mask: qr.mask, matrix: qr.matrix };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* ------------------------------ 响应工具 ------------------------------ */

function attachment(res, filename, contentType, buf) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function svgOut(res, svg) {
  const buf = Buffer.from(svg, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/* =====================================================================
   路由主体
   ===================================================================== */

const mod = {
  name: 'security',
  prefixes: ['/api/security', '/api/register', '/api/admin/users'],

  async handle(ctx) {
    const { app, req, res, user, pathname, method, sendJSON } = ctx;
    if (!app) return false;
    ensureBaseline(app);

    /* ── A. 接管口令敏感入口（策略强制） ───────────────────────────── */
    if (pathname === '/api/register' && method === 'POST') return this.register(ctx);
    if (pathname === '/api/admin/users/create' && method === 'POST') return this.adminCreateUser(ctx);
    if (pathname === '/api/admin/users/setpass' && method === 'POST') return this.adminSetpass(ctx);

    /* ── B. /api/security/* ───────────────────────────────────────── */
    if (!pathname.startsWith('/api/security')) return false;

    /* 所有 /api/security 接口都要求登录（匿名一律 401） */
    if (!user) {
      sendJSON(res, 401, { error: '需要登录' });
      return true;
    }

    const key = method + ' ' + pathname;
    switch (key) {
      /* 概览 */
      case 'GET /api/security/status': return this.status(ctx);
      case 'GET /api/security/overview': return this.status(ctx);

      /* 账号与 2FA */
      case 'GET /api/security/totp/status': return this.totpStatus(ctx);
      case 'POST /api/security/totp/setup': return this.totpSetup(ctx);
      case 'POST /api/security/totp/enable': return this.totpEnable(ctx);
      case 'POST /api/security/totp/disable': return this.totpDisable(ctx);
      case 'GET /api/security/totp/qr': return this.totpQr(ctx);

      /* 口令策略与改密 */
      case 'GET /api/security/password/policy': return this.getPolicy(ctx);
      case 'POST /api/security/password/policy': return this.savePolicy(ctx);
      case 'POST /api/security/password/check': return this.checkPassword(ctx);
      case 'POST /api/security/password/change': return this.changePassword(ctx);

      /* 会话 / 设备 */
      case 'GET /api/security/sessions': return this.getSessions(ctx);
      case 'POST /api/security/sessions/kick': return this.kickSession(ctx);
      case 'POST /api/security/sessions/kick-others': return this.kickOthers(ctx);
      case 'POST /api/security/devices/remove': return this.removeDevice(ctx);

      /* 审计 */
      case 'GET /api/security/audit': return this.getAudit(ctx);
      case 'GET /api/security/audit/meta': return this.auditMeta(ctx);
      case 'GET /api/security/audit/export': return this.exportAudit(ctx);

      /* 角色与权限 */
      case 'GET /api/security/users': return this.getUsers(ctx);
      case 'POST /api/security/users/role': return this.setRole(ctx);
      case 'POST /api/security/users/2fa-reset': return this.resetUser2fa(ctx);
      case 'POST /api/security/users/toggle': return this.toggleUser(ctx);
      case 'POST /api/security/users/delete': return this.deleteUser(ctx);
      case 'GET /api/security/acl': return this.getAcl(ctx);
      case 'POST /api/security/acl': return this.saveAcl(ctx);
      case 'POST /api/security/acl/group': return this.editAclGroup(ctx);

      /* IP 白名单 */
      case 'GET /api/security/ip': return this.getIp(ctx);
      case 'POST /api/security/ip': return this.saveIp(ctx);
      case 'POST /api/security/ip/reset': return this.resetIp(ctx);
      case 'POST /api/security/ip/simulate': return this.simulateIp(ctx);
      case 'POST /api/security/ip/bypass': return this.bypassIp(ctx);

      /* 备份与快照 */
      case 'GET /api/security/backup/info': return this.backupInfo(ctx);
      case 'GET /api/security/backup/snapshots': return this.listSnaps(ctx);
      case 'POST /api/security/backup/snapshot': return this.createSnap(ctx);
      case 'POST /api/security/backup/restore': return this.restoreSnap(ctx);
      case 'GET /api/security/backup/fixture': return this.fixtureInfo(ctx);
      case 'POST /api/security/backup/fixture': return this.fixtureOp(ctx);

      /* 传输与存储加密 */
      case 'GET /api/security/crypto': return this.getCrypto(ctx);
      case 'POST /api/security/crypto/toggle': return this.toggleCrypto(ctx);

      /* 风险检测 */
      case 'GET /api/security/risk': return this.getRisk(ctx);
      case 'GET /api/security/risk/scan': return this.getScan(ctx);
      case 'POST /api/security/risk/scan': return this.runScan(ctx);

      /* 数据导出与注销 */
      case 'GET /api/security/export': return this.exportData(ctx);
      case 'POST /api/security/account/delete': return this.deleteAccount(ctx);

      default:
        return false;
    }
  },

  /* ================= A. 口令敏感入口接管 ================= */

  /** POST /api/register —— 注册（策略 + 限速 + 自动建会话） */
  async register(ctx) {
    const { app, req, res, sendJSON } = ctx;
    const ip = store.clientIp(req);
    const rl = app.loginRateCheck(ip);
    if (rl) { sendJSON(res, rl.code, { error: rl.error }); return true; }
    const rr = app.registerRateCheck(ip);
    if (rr) { sendJSON(res, rr.code, { error: rr.error }); return true; }

    const body = await readJson(ctx);
    if (!body.ok) { sendJSON(res, 400, { error: '请求体不是合法 JSON' }); return true; }
    const username = String(body.data.username || '').trim();
    const password = policyMod.pickPassword(body.data);

    const judged = evaluatePassword(app, password, username);
    if (!judged.ok) {
      audit(app, req, null, 'register-policy-reject', username + '：' + policyErrorsText(judged), false);
      sendJSON(res, 400, {
        error: '口令不符合工作站密码策略：' + policyErrorsText(judged),
        errors: judged.errors,
        code: 'WEAK_PASSWORD',
      });
      return true;
    }
    /* 图形验证码：新前端（含已下线的旧前端）都会带 captchaId/captchaCode。
       之前这里没校验，等于验证码形同虚设（填错也能注册）——现在强制校验。
       注意放在口令策略之后：弱口令直接返回，不消耗一次性验证码。 */
    if (typeof app.verifyCaptcha === 'function') {
      if (!body.data.captchaId) {
        audit(app, req, null, 'register-captcha-missing', username, false);
        sendJSON(res, 400, { error: '需要图形验证码，请刷新页面后重试', code: 'CAPTCHA_REQUIRED' });
        return true;
      }
      if (!app.verifyCaptcha(body.data.captchaId, body.data.captchaCode)) {
        audit(app, req, null, 'register-captcha-reject', username, false);
        sendJSON(res, 400, { error: '图形验证码错误或已过期，请点击验证码换一张', code: 'CAPTCHA_INVALID' });
        return true;
      }
    }

    const r = await app.users.createAsync(username, password, { minLength: 1 });
    if (!r.ok) { sendJSON(res, 400, { error: r.error }); return true; }
    app.registerRateHit(ip);
    try { app.aclEnsureGroupMember(r.user.username, 'users'); } catch { /* 组不存在时忽略 */ }
    let smbReady = false;
    try {
      const smbUsers = require('../smb-users');
      if (smbUsers.NAME_RE.test(String(r.user.username))) {
        const made = smbUsers.ensureSmbUser(r.user.username, password);
        if (made.ok) {
          smbUsers.addUserToShares(r.user.username);
          smbUsers.reloadSamba();
          smbReady = true;
          try {
            const fpStore = app._smbFpLoad();
            fpStore[r.user.username] = app._smbFp(r.user.username, password);
            app._smbFpSave(fpStore);
          } catch { /* 指纹失败不影响注册 */ }
        }
      }
    } catch (e) {
      console.warn('[security] 注册时开通 SMB 失败：' + ((e && e.message) || e));
    }
    try { policyMod.recordPassword(app, r.user.username, password, 'register'); } catch { /* 忽略 */ }
    const s = app.sessions.create(r.user.id);
    app.setSessionCookie(res, s.id);
    audit(app, req, r.user, 'register', '策略强制通过（' + (smbReady ? '已开通 SMB' : '未开通 SMB') + '）');
    sendJSON(res, 200, {
      ok: true,
      user: app.users.publicUser(r.user),
      isAdmin: r.user.role === 'admin',
      policy: { minLength: policyMod.load(app).policy.minLength, enforced: true },
      smb: smbReady ? { username: r.user.username, host: '\\\\' + app.smbHost() } : null,
    });
    return true;
  },

  /** POST /api/admin/users/create —— 管理员建号（策略 + 角色） */
  async adminCreateUser(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    if (!body.ok) { sendJSON(res, 400, { error: '请求体不是合法 JSON' }); return true; }
    const username = String(body.data.username || '').trim();
    const password = policyMod.pickPassword(body.data);
    const role = body.data.role === 'admin' ? 'admin' : 'user';

    const judged = evaluatePassword(app, password, username);
    if (!judged.ok) {
      audit(app, req, user, 'admin-user-create-reject', username + '：' + policyErrorsText(judged), false);
      sendJSON(res, 400, {
        error: '口令不符合工作站密码策略：' + policyErrorsText(judged),
        errors: judged.errors,
        code: 'WEAK_PASSWORD',
      });
      return true;
    }
    const r = await app.users.createAsync(username, password, { minLength: 1 });
    if (!r.ok) { sendJSON(res, 400, { error: r.error }); return true; }
    if (role === 'admin') r.user.role = 'admin';
    app.users.save();
    if (r.user.role !== 'admin') {
      try { app.aclEnsureGroupMember(r.user.username, 'users'); } catch { /* 忽略 */ }
    }
    try { policyMod.recordPassword(app, r.user.username, password, user.username); } catch { /* 忽略 */ }
    audit(app, req, user, 'admin-user-create', r.user.username + (role === 'admin' ? ' (admin)' : '') + ' [策略强制]');
    sendJSON(res, 200, { ok: true, user: app.users.publicUser(r.user) });
    return true;
  },

  /** POST /api/admin/users/setpass —— 管理员重置口令（策略 + 历史 + 踢会话） */
  async adminSetpass(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    if (!throttle(app, 'setpass:' + user.username, 20, 60000)) {
      sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' });
      return true;
    }
    const body = await readJson(ctx);
    if (!body.ok) { sendJSON(res, 400, { error: '请求体不是合法 JSON' }); return true; }
    const username = String(body.data.username || '');
    const password = policyMod.pickPassword(body.data);
    const target = app.users.findByName(username);
    if (!target) { sendJSON(res, 404, { error: '用户不存在' }); return true; }

    const judged = evaluatePassword(app, password, target.username);
    if (!judged.ok) {
      audit(app, req, user, 'admin-user-setpass-reject', target.username + '：' + policyErrorsText(judged), false);
      sendJSON(res, 400, {
        error: '口令不符合工作站密码策略：' + policyErrorsText(judged),
        errors: judged.errors,
        code: 'WEAK_PASSWORD',
      });
      return true;
    }
    target.salt = crypto.randomBytes(16).toString('hex');
    target.hash = await hashPasswordAsync(password, target.salt);
    app.users.save();
    let kicked = 0;
    for (const [sid, s] of [...app.sessions.sessions]) {
      if (s.userId === target.id) { app.sessions.destroy(sid); sessionMod.forget(app, sid); kicked++; }
    }
    try { policyMod.recordPassword(app, target.username, password, user.username); } catch { /* 忽略 */ }
    audit(app, req, user, 'admin-user-setpass', target.username + '（已注销 ' + kicked + ' 个会话）[策略强制]');
    sendJSON(res, 200, { ok: true, sessionsRevoked: kicked });
    return true;
  },

  /* ================= B1. 概览 ================= */

  async status(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    ensureBaseline(app);
    const policyData = policyMod.load(app);
    const pstate = policyMod.stateOf(app, user, policyData);
    const cfg = ipMod.loadConfig(app);
    const ip = store.clientIp(req);
    const dec = ipMod.decide(app, ip, cfg);
    const sess = (() => { try { return sessionMod.list(app, secCtx.sid(), user.id); } catch { return { sessions: [], devices: { online: [], offline: [] }, count: 0, onlineCount: 0 }; } })();
    const users = (app.users && app.users.users) || [];
    const isAdm = isAdmin(user);
    let cryptoQuick = null;
    try {
      const p = await cryptoMod.posture(app, req);
      cryptoQuick = {
        https: !!(p.tls && p.tls.enabled),
        httpsProbe: p.tls && p.tls.probe,
        plainHttp: !!(p.plainHttp && p.plainHttp.enabled),
        smbSigning: p.smb && p.smb.signing,
        s3Signature: 'SigV4 强制',
        storageEncrypted: !!(p.storage && p.storage.encryptedAtRest),
        forceHttps: !!(p.toggles && p.toggles.forceHttps),
      };
    } catch (e) {
      cryptoQuick = { error: (e && e.message) || String(e) };
    }
    sendJSON(res, 200, {
      ok: true,
      at: store.nowIso(),
      user: { id: user.id, username: user.username, role: user.role },
      isAdmin: isAdm,
      totp: {
        enabled: !!user.totpEnabled,
        pending: !!user.totpSecret && !user.totpEnabled,
        recovery: recoveryStatus(app, user.username),
      },
      password: {
        ...pstate,
        minLength: policyData.policy.minLength,
        policyEnabled: policyData.policy.enabled !== false,
      },
      policy: isAdm ? policyData.policy : {
        enabled: policyData.policy.enabled,
        minLength: policyData.policy.minLength,
        maxAgeDays: policyData.policy.maxAgeDays,
      },
      ip: {
        current: ip,
        https: store.isHttps(req),
        enabled: cfg.enabled,
        forceHttps: cfg.forceHttps,
        allow: isAdm ? cfg.allow : undefined,
        allowed: dec.allowed,
        matched: dec.matched,
        reason: dec.reason,
        emergencyBypass: ipMod.bypassActive(app),
        updatedAt: cfg.updatedAt,
        updatedBy: cfg.updatedBy,
      },
      counts: {
        users: users.length,
        admins: users.filter((u) => u.role === 'admin').length,
        sessions: sess.count,
        sessionsOnline: sess.onlineCount,
        devicesOnline: (sess.devices.online || []).length,
        devicesOffline: (sess.devices.offline || []).length,
        mySessions: sess.sessions.filter((s) => s.userId === user.id).length,
      },
      cryptoQuick,
      endpoints: {
        audit: '/api/security/audit',
        sessions: '/api/security/sessions',
        snapshots: '/api/security/backup/snapshots',
      },
    });
    return true;
  },

  /* ================= B2. 账号与 2FA ================= */

  async totpStatus(ctx) {
    const { app, res, user, sendJSON } = ctx;
    const out = {
      ok: true,
      enabled: !!user.totpEnabled,
      pending: !!user.totpSecret && !user.totpEnabled,
      recovery: recoveryStatus(app, user.username),
      issuer: ISSUER,
    };
    if (out.pending) {
      out.secret = user.totpSecret;
      out.otpauth = otpauthOf(user, user.totpSecret);
      out.qr = qrPayload(out.otpauth);
      out.qrUrl = '/api/security/totp/qr';
    }
    sendJSON(res, 200, out);
    return true;
  },

  async totpSetup(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (user.totpEnabled) { sendJSON(res, 400, { error: '2FA 已启用；如需更换请先停用' }); return true; }
    if (!throttle(app, 'totp-setup:' + user.username, 10, 60000)) {
      sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' });
      return true;
    }
    const secret = totpLib.generateSecret(20);
    user.totpSecret = secret;
    user.totpEnabled = false;
    app.users.save();
    const otpauth = otpauthOf(user, secret);
    const qr = qrPayload(otpauth);
    audit(app, req, user, '2fa-setup', '生成 TOTP 密钥');
    sendJSON(res, 200, {
      ok: true,
      secret,
      otpauth,
      qr,
      qrUrl: '/api/security/totp/qr',
      steps: [
        '用 Google Authenticator / Microsoft Authenticator / 1Password 等扫码（或手输密钥）',
        '输入 App 上当前 6 位动态验证码并点「启用」',
        '启用成功后保存 8 个备用恢复码（只显示一次）',
      ],
    });
    return true;
  },

  async totpEnable(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (user.totpEnabled) { sendJSON(res, 400, { error: '2FA 已启用' }); return true; }
    if (!user.totpSecret) { sendJSON(res, 400, { error: '请先生成密钥（setup）' }); return true; }
    if (!throttle(app, 'totp-enable:' + user.username, 10, 60000)) {
      sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' });
      return true;
    }
    const body = await readJson(ctx);
    const code = String((body.data && body.data.code) || '').trim();
    const tv = totpLib.verify(user.totpSecret, code);
    if (!tv.ok) {
      audit(app, req, user, '2fa-enable-fail', '验证码错误', false);
      sendJSON(res, 400, { error: '动态验证码不对，请核对手机时间后重试', code: 'BAD_TOTP' });
      return true;
    }
    if (Number.isFinite(tv.counter)) user.totpLastCounter = tv.counter;
    user.totpEnabled = true;
    app.users.save();
    const recoveryCodes = issueRecoveryCodes(app, user.username);
    audit(app, req, user, '2fa-enable', '已启用 TOTP（重放保护 counter=' + tv.counter + '）');
    sendJSON(res, 200, {
      ok: true,
      enabled: true,
      recoveryCodes,
      warning: '备用恢复码只显示这一次，请离线保存；每个码只能用一次。',
    });
    return true;
  },

  async totpDisable(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!user.totpEnabled) { sendJSON(res, 400, { error: '2FA 未启用' }); return true; }
    if (!throttle(app, 'totp-disable:' + user.username, 10, 60000)) {
      sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' });
      return true;
    }
    const body = await readJson(ctx);
    const code = String((body.data && body.data.code) || '').trim();
    const recoveryCode = String((body.data && body.data.recoveryCode) || '').trim();
    let via = '';
    if (recoveryCode) {
      if (!consumeRecoveryCode(app, user.username, recoveryCode)) {
        audit(app, req, user, '2fa-disable-fail', '恢复码无效或已用过', false);
        sendJSON(res, 400, { error: '恢复码无效或已被使用', code: 'BAD_RECOVERY' });
        return true;
      }
      via = 'recovery-code';
    } else {
      const tv = totpLib.verify(user.totpSecret, code);
      if (!tv.ok) {
        audit(app, req, user, '2fa-disable-fail', '验证码错误', false);
        sendJSON(res, 400, { error: '动态验证码不对', code: 'BAD_TOTP' });
        return true;
      }
      if (Number.isFinite(tv.counter)) user.totpLastCounter = tv.counter;
      via = 'totp';
    }
    user.totpSecret = null;
    user.totpEnabled = false;
    user.totpLastCounter = null;
    app.users.save();
    clearRecoveryCodes(app, user.username);
    audit(app, req, user, '2fa-disable', '已停用 TOTP（via ' + via + '）');
    sendJSON(res, 200, { ok: true, enabled: false, via });
    return true;
  },

  async totpQr(ctx) {
    const { res, user, sendJSON } = ctx;
    if (!user.totpSecret) { sendJSON(res, 404, { error: '尚未生成 2FA 密钥' }); return true; }
    const uri = otpauthOf(user, user.totpSecret);
    let qr;
    try { qr = qrMod.encode(uri); } catch (e) {
      sendJSON(res, 500, { error: '二维码生成失败：' + ((e && e.message) || e) });
      return true;
    }
    /* 二维码必须是白底黑块（扫码器识读要求），这是全项目唯一允许写死颜色的地方 */
    svgOut(res, qrMod.toSvg(qr, { scale: 4, border: 4 }));
    return true;
  },

  /* ================= B3. 口令策略与改密 ================= */

  async getPolicy(ctx) {
    const { app, res, user, sendJSON } = ctx;
    const data = policyMod.load(app);
    const users = (app.users && app.users.users) || [];
    const rows = users.map((u) => {
      const st = policyMod.stateOf(app, u, data);
      return {
        username: u.username,
        role: u.role,
        disabled: !!u.disabled,
        changedAt: st.changedAt,
        expiresAt: st.expiresAt,
        daysLeft: st.daysLeft,
        expired: st.expired,
        known: st.known,
        historyCount: st.historyCount,
      };
    });
    sendJSON(res, 200, {
      ok: true,
      isAdmin: isAdmin(user),
      policy: isAdmin(user) ? data.policy : {
        enabled: data.policy.enabled,
        minLength: data.policy.minLength,
        maxAgeDays: data.policy.maxAgeDays,
      },
      defaults: policyMod.POLICY_DEFAULTS,
      baselineAt: data.baselineAt,
      updatedAt: data.updatedAt,
      updatedBy: data.updatedBy,
      stats: {
        total: rows.length,
        expired: rows.filter((r) => r.expired).length,
        unknown: rows.filter((r) => !r.known).length,
        rows: isAdmin(user) ? rows : rows.filter((r) => r.username === user.username),
      },
      commonWeakCount: policyMod.COMMON_WEAK.length,
    });
    return true;
  },

  async savePolicy(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    if (!body.ok) { sendJSON(res, 400, { error: '请求体不是合法 JSON' }); return true; }
    const input = body.data.policy || body.data;
    const data = policyMod.load(app);
    const next = { ...data.policy };
    const boolKeys = ['enabled', 'requireUpper', 'requireLower', 'requireDigit', 'requireSymbol', 'blockCommon'];
    for (const k of boolKeys) if (input[k] !== undefined) next[k] = !!input[k];
    const numRanges = { minLength: [6, 128], maxAgeDays: [0, 3650], historyCount: [0, 20] };
    for (const [k, range] of Object.entries(numRanges)) {
      if (input[k] === undefined) continue;
      const n = Number(input[k]);
      if (!Number.isFinite(n) || n < range[0] || n > range[1]) {
        sendJSON(res, 400, { error: k + ' 取值需在 ' + range[0] + '~' + range[1] + ' 之间' });
        return true;
      }
      next[k] = Math.round(n);
    }
    const saved = policyMod.save(app, { ...data, policy: next }, user.username);
    if (!saved) { sendJSON(res, 500, { error: '策略落盘失败' }); return true; }
    audit(app, req, user, 'password-policy', 'minLength=' + next.minLength
      + ' classes=' + ['requireUpper', 'requireLower', 'requireDigit', 'requireSymbol'].filter((k) => next[k]).length
      + ' maxAgeDays=' + next.maxAgeDays + ' history=' + next.historyCount);
    sendJSON(res, 200, { ok: true, policy: next, savedAt: store.nowIso() });
    return true;
  },

  async checkPassword(ctx) {
    const { app, res, user, sendJSON } = ctx;
    const body = await readJson(ctx);
    const password = policyMod.pickPassword(body.data);
    const judged = policyMod.evaluate(password, policyMod.load(app).policy, { username: user.username });
    sendJSON(res, 200, { ok: judged.ok, errors: judged.errors, score: judged.score, labels: judged.labels });
    return true;
  },

  async changePassword(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!throttle(app, 'pwchange:' + user.username, 5, 10 * 60 * 1000)) {
      sendJSON(res, 429, { error: '改密尝试过于频繁，请 10 分钟后再试' });
      return true;
    }
    const body = await readJson(ctx);
    if (!body.ok) { sendJSON(res, 400, { error: '请求体不是合法 JSON' }); return true; }
    const oldPassword = String(body.data.oldPassword != null ? body.data.oldPassword : (body.data.old || ''));
    const newPassword = policyMod.pickPassword(body.data);
    let verified = null;
    try { verified = await app.users.verifyAsync(user.username, oldPassword); } catch { verified = null; }
    if (!verified) {
      audit(app, req, user, 'password-change-fail', '当前口令错误', false);
      sendJSON(res, 400, { error: '当前口令不正确', code: 'BAD_OLD_PASSWORD' });
      return true;
    }
    if (oldPassword === newPassword) {
      sendJSON(res, 400, { error: '新口令不能与当前口令相同', code: 'WEAK_PASSWORD' });
      return true;
    }
    const judged = evaluatePassword(app, newPassword, user.username);
    if (!judged.ok) {
      audit(app, req, user, 'password-change-reject', policyErrorsText(judged), false);
      sendJSON(res, 400, {
        error: '新口令不符合策略：' + policyErrorsText(judged),
        errors: judged.errors,
        score: judged.score,
        code: 'WEAK_PASSWORD',
      });
      return true;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPasswordAsync(newPassword, salt);
    user.salt = salt;
    user.hash = hash;
    app.users.save();
    try { policyMod.recordPassword(app, user.username, newPassword, user.username); } catch { /* 忽略 */ }
    /* 改密后踢掉其它会话（保留当前），符合「口令泄漏后重置」的语义 */
    const currentSid = secCtx.sid();
    let kicked = 0;
    for (const [sid, s] of [...app.sessions.sessions]) {
      /* currentSid 为空（极端情况）时一个都不踢：宁可少踢，也不能把操作者自己踢下线 */
      if (s.userId === user.id && currentSid && sid !== currentSid) {
        app.sessions.destroy(sid);
        sessionMod.forget(app, sid);
        kicked++;
      }
    }
    audit(app, req, user, 'password-change', '口令已更新（注销其它会话 ' + kicked + ' 个）');
    sendJSON(res, 200, { ok: true, sessionsRevoked: kicked, changedAt: store.nowIso() });
    return true;
  },

  /* ================= B4. 会话与设备 ================= */

  async getSessions(ctx) {
    const { app, res, user, sendJSON } = ctx;
    let data;
    try { data = sessionMod.list(app, secCtx.sid(), user.id); } catch (e) {
      sendJSON(res, 500, { error: '会话台账读取失败：' + ((e && e.message) || e) });
      return true;
    }
    const isAdm = isAdmin(user);
    const sessions = isAdm ? data.sessions : data.sessions.filter((s) => s.userId === user.id);
    const devices = isAdm ? data.devices : {
      online: (data.devices.online || []).filter((d) => !d.user || d.user === user.username),
      offline: (data.devices.offline || []).filter((d) => !d.user || d.user === user.username),
    };
    sendJSON(res, 200, {
      ok: true,
      isAdmin: isAdm,
      currentSid: secCtx.sid(),
      sessions,
      devices,
      stats: {
        total: sessions.length,
        online: sessions.filter((s) => s.active).length,
        devicesOnline: devices.online.length,
        devicesOffline: devices.offline.length,
      },
      note: '「踢出」= 立即销毁服务端会话，下一次请求该 Cookie 返回 401；设备移除只移除在线注册记录。',
    });
    return true;
  },

  async kickSession(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    const body = await readJson(ctx);
    const sid = String((body.data && body.data.sid) || '').trim();
    if (!sid) { sendJSON(res, 400, { error: '缺少会话 id' }); return true; }
    const s = app.sessions.get(sid);
    if (!s) { sendJSON(res, 404, { error: '会话不存在或已过期' }); return true; }
    const target = app.users.findById(s.userId);
    if (!isAdmin(user) && s.userId !== user.id) {
      sendJSON(res, 403, { error: '只能踢出自己的会话' });
      return true;
    }
    if (sid === secCtx.sid()) {
      sendJSON(res, 400, { error: '不能踢出当前会话；如需退出请用「退出登录」' });
      return true;
    }
    app.sessions.destroy(sid);
    sessionMod.forget(app, sid);
    audit(app, req, user, 'session-kick', (target ? target.username : s.userId) + ' sid=' + sid.slice(0, 8));
    sendJSON(res, 200, { ok: true, sid, username: target ? target.username : '' });
    return true;
  },

  async kickOthers(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    const body = await readJson(ctx);
    const except = String((body.data && body.data.except) || secCtx.sid() || '');
    let kicked = 0;
    for (const [sid, s] of [...app.sessions.sessions]) {
      if (s.userId !== user.id) continue;
      if (sid === except) continue;
      app.sessions.destroy(sid);
      sessionMod.forget(app, sid);
      kicked++;
    }
    audit(app, req, user, 'session-kick-others', '注销自己的其它会话 ' + kicked + ' 个');
    sendJSON(res, 200, { ok: true, kicked });
    return true;
  },

  async removeDevice(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const id = String((body.data && body.data.id) || '').trim();
    if (!id) { sendJSON(res, 400, { error: '缺少设备 id' }); return true; }
    let r = { ok: false, error: 'presence 不可用' };
    try { r = app.presence.remove(id); } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    if (!r.ok) { sendJSON(res, 400, { error: r.error || '移除失败' }); return true; }
    audit(app, req, user, 'device-remove', id);
    sendJSON(res, 200, { ok: true, id });
    return true;
  },

  /* ================= B5. 登录日志与访问审计 ================= */

  /** 把 query 变成过滤函数（审计页 / CSV 共用） */
  _auditFilter(ctx) {
    const q = ctx.query || {};
    const parseTime = (v, endOfDay) => {
      const s = String(v || '').trim();
      if (!s) return null;
      let t = Date.parse(s);
      if (!Number.isFinite(t)) return null;
      if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) t += 86400000 - 1;
      return t;
    };
    const from = parseTime(q.from, false);
    const to = parseTime(q.to, true);
    const fUser = String(q.user || '').trim();
    const fAction = String(q.action || '').trim();
    const fOk = String(q.ok || '').trim();
    const fQ = String(q.q || '').trim().toLowerCase();
    const isAdm = isAdmin(ctx.user);
    const selfOnly = isAdm ? '' : String(ctx.user.username || '');
    return {
      isAdmin: isAdm,
      selfOnly,
      from, to,
      apply(e) {
        const ts = Date.parse(e && e.ts ? e.ts : '') || 0;
        if (!ts) return false;
        if (from != null && ts < from) return false;
        if (to != null && ts > to) return false;
        const user = String(e.user || '');
        if (selfOnly && user !== selfOnly) return false;
        if (fUser && user !== fUser) return false;
        if (fAction && String(e.action || '') !== fAction) return false;
        if (fOk === '1' && e.ok === false) return false;
        if (fOk === '0' && e.ok !== false) return false;
        if (fQ) {
          const hay = [e.user, e.action, e.ip, e.disk, e.path, e.detail, e.ua].map((x) => String(x == null ? '' : x).toLowerCase()).join(' ');
          if (!hay.includes(fQ)) return false;
        }
        return true;
      },
    };
  },

  _readAuditEntries(app) {
    try { return app.readAudit(100000) || []; } catch { return []; }
  },

  async getAudit(ctx) {
    const { app, res, sendJSON } = ctx;
    const q = ctx.query || {};
    const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
    const pageSize = Math.min(300, Math.max(10, parseInt(q.pageSize || '50', 10) || 50));
    const filter = this._auditFilter(ctx);
    const all = this._readAuditEntries(app);
    const filtered = all.filter((e) => filter.apply(e));
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const entries = filtered.slice(start, start + pageSize);
    sendJSON(res, 200, {
      ok: true,
      total,
      page,
      pageSize,
      pages,
      selfOnly: !filter.isAdmin,
      entries,
      filters: { from: q.from || '', to: q.to || '', user: q.user || '', action: q.action || '', ok: q.ok || '', q: q.q || '' },
    });
    return true;
  },

  async auditMeta(ctx) {
    const { app, res, sendJSON } = ctx;
    const filter = this._auditFilter(ctx);
    const all = this._readAuditEntries(app);
    const filtered = all.filter((e) => filter.apply(e));
    const actions = new Map();
    const users = new Map();
    let oldest = null;
    let newest = null;
    let failed = 0;
    for (const e of filtered) {
      const a = String(e.action || '');
      actions.set(a, (actions.get(a) || 0) + 1);
      const u = String(e.user || '');
      users.set(u, (users.get(u) || 0) + 1);
      const ts = Date.parse(e.ts || '') || 0;
      if (ts) {
        if (oldest == null || ts < oldest) oldest = ts;
        if (newest == null || ts > newest) newest = ts;
      }
      if (e.ok === false) failed++;
    }
    sendJSON(res, 200, {
      ok: true,
      total: filtered.length,
      failed,
      failureRate: filtered.length ? Math.round((failed / filtered.length) * 1000) / 10 : 0,
      oldest: oldest ? new Date(oldest).toISOString() : null,
      newest: newest ? new Date(newest).toISOString() : null,
      actions: [...actions.entries()].sort((a, b) => b[1] - a[1]).map(([action, count]) => ({ action, count })),
      users: [...users.entries()].sort((a, b) => b[1] - a[1]).map(([username, count]) => ({ username, count })),
      selfOnly: !filter.isAdmin,
      auditFile: 'data/audit.log',
    });
    return true;
  },

  async exportAudit(ctx) {
    const { app, res, user } = ctx;
    /* 审计导出属管理员能力（普通用户要导出自己的记录请用 /api/security/export，
       那条路径只导出本人数据，权限边界更清楚） */
    if (!isAdmin(user)) {
      ctx.sendJSON(res, 403, { error: '需要管理员权限' });
      return true;
    }
    const filter = this._auditFilter(ctx);
    const all = this._readAuditEntries(app).filter((e) => filter.apply(e));
    const cap = 20000;
    const rows = all.slice(0, cap).map((e) => ({
      ts: e.ts, action: e.action, user: e.user, ip: e.ip, ok: e.ok, disk: e.disk, path: e.path, detail: e.detail,
    }));
    const csv = exportMod.toCsv(rows);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    audit(app, ctx.req, user, 'audit-export', '导出 ' + rows.length + ' 条' + (all.length > cap ? '（上限 ' + cap + '）' : ''));
    attachment(res, 'audit-' + stamp + '.csv', 'text/csv; charset=utf-8', Buffer.from(csv, 'utf8'));
    return true;
  },

  /* ================= B6. 角色与权限 ================= */

  async getUsers(ctx) {
    const { app, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const data = policyMod.load(app);
    const sessByUser = new Map();
    for (const s of app.sessions.sessions.values()) sessByUser.set(s.userId, (sessByUser.get(s.userId) || 0) + 1);
    const devicesByUser = new Map();
    try {
      const list = app.presence.list() || {};
      for (const d of [...(list.online || []), ...(list.offline || [])]) {
        if (!d.user) continue;
        devicesByUser.set(d.user, (devicesByUser.get(d.user) || 0) + 1);
      }
    } catch { /* 忽略 */ }
    const rows = ((app.users && app.users.users) || []).map((u) => {
      const st = policyMod.stateOf(app, u, data);
      return {
        id: u.id,
        username: u.username,
        role: u.role,
        disabled: !!u.disabled,
        createdAt: u.createdAt || null,
        totpEnabled: !!u.totpEnabled,
        recovery: recoveryStatus(app, u.username),
        password: { changedAt: st.changedAt, expiresAt: st.expiresAt, daysLeft: st.daysLeft, expired: st.expired, known: st.known, historyCount: st.historyCount },
        sessions: sessByUser.get(u.id) || 0,
        devices: devicesByUser.get(u.username) || 0,
        isSelf: u.id === user.id,
      };
    });
    sendJSON(res, 200, {
      ok: true,
      users: rows,
      roles: [
        { id: 'admin', name: '管理员', desc: '可管理用户/角色/ACL/IP 白名单/审计与备份；绕过盘级 ACL' },
        { id: 'user', name: '普通用户', desc: '按 ACL 组获得盘级读写权限；看不到管理员项' },
      ],
      stats: { total: rows.length, admins: rows.filter((r) => r.role === 'admin').length, disabled: rows.filter((r) => r.disabled).length, no2fa: rows.filter((r) => r.role === 'admin' && !r.totpEnabled).length },
    });
    return true;
  },

  async setRole(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const username = String((body.data && body.data.username) || '');
    const role = String((body.data && body.data.role) || '');
    if (!['admin', 'user'].includes(role)) { sendJSON(res, 400, { error: '角色只能是 admin / user' }); return true; }
    const target = app.users.findByName(username);
    if (!target) { sendJSON(res, 404, { error: '用户不存在' }); return true; }
    const admins = app.users.users.filter((u) => u.role === 'admin');
    if (target.username === 'dav') { sendJSON(res, 400, { error: 'dav 是系统桥接专用账号，不能改角色' }); return true; }
    if (target.role === 'admin' && role !== 'admin') {
      if (admins.length <= 1) { sendJSON(res, 400, { error: '必须至少保留一个管理员' }); return true; }
      if (target.id === user.id) { sendJSON(res, 400, { error: '不能取消自己的管理员权限（请让另一个管理员操作）' }); return true; }
    }
    const before = target.role;
    target.role = role;
    app.users.save();
    audit(app, req, user, 'user-role', target.username + '：' + before + ' → ' + role);
    sendJSON(res, 200, { ok: true, username: target.username, role, before });
    return true;
  },

  async resetUser2fa(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const username = String((body.data && body.data.username) || '');
    const target = app.users.findByName(username);
    if (!target) { sendJSON(res, 404, { error: '用户不存在' }); return true; }
    const was = !!target.totpEnabled;
    target.totpEnabled = false;
    target.totpSecret = null;
    target.totpLastCounter = null;
    app.users.save();
    clearRecoveryCodes(app, target.username);
    audit(app, req, user, '2fa-reset-admin', target.username + '（原状态 ' + (was ? '已启用' : '未启用') + '，已清除恢复码）');
    sendJSON(res, 200, { ok: true, username: target.username, wasEnabled: was });
    return true;
  },

  async toggleUser(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const username = String((body.data && body.data.username) || '');
    const disabled = body.data.disabled === true;
    const target = app.users.findByName(username);
    if (!target) { sendJSON(res, 404, { error: '用户不存在' }); return true; }
    if (target.role === 'admin' && disabled) { sendJSON(res, 400, { error: '不能禁用管理员账号' }); return true; }
    if (target.username === 'dav') { sendJSON(res, 400, { error: 'dav 是系统桥接专用账号，不允许禁用' }); return true; }
    if (target.id === user.id && disabled) { sendJSON(res, 400, { error: '不能禁用自己' }); return true; }
    target.disabled = disabled;
    app.users.save();
    let kicked = 0;
    if (disabled) {
      for (const [sid, s] of [...app.sessions.sessions]) {
        if (s.userId === target.id) { app.sessions.destroy(sid); sessionMod.forget(app, sid); kicked++; }
      }
    }
    audit(app, req, user, disabled ? 'admin-user-disable' : 'admin-user-enable', target.username + (kicked ? '（注销 ' + kicked + ' 个会话）' : ''));
    sendJSON(res, 200, { ok: true, disabled: target.disabled, sessionsRevoked: kicked });
    return true;
  },

  async deleteUser(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const username = String((body.data && body.data.username) || '');
    const target = app.users.findByName(username);
    if (!target) { sendJSON(res, 404, { error: '用户不存在' }); return true; }
    if (target.role === 'admin') { sendJSON(res, 400, { error: '管理员账号不允许通过后台删除（可禁用）' }); return true; }
    if (target.username === 'dav') { sendJSON(res, 400, { error: 'dav 是系统桥接专用账号，不允许删除' }); return true; }
    if (target.id === user.id) { sendJSON(res, 400, { error: '不能删除自己' }); return true; }
    app.users.users = app.users.users.filter((x) => x.id !== target.id);
    app.users.reindex();
    app.users.save();
    let kicked = 0;
    for (const [sid, s] of [...app.sessions.sessions]) {
      if (s.userId === target.id) { app.sessions.destroy(sid); sessionMod.forget(app, sid); kicked++; }
    }
    clearRecoveryCodes(app, target.username);
    try { policyMod.clearHistory(app, target.username); } catch { /* 清历史失败不阻断删除 */ }
    audit(app, req, user, 'admin-user-delete', target.username + '（会话 ' + kicked + '；文件数据保留）');
    sendJSON(res, 200, { ok: true, sessionsRevoked: kicked, filesKept: true });
    return true;
  },

  async getAcl(ctx) {
    const { app, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    let data;
    try { data = aclStore.loadAcl(app); } catch (e) {
      sendJSON(res, 500, { error: 'ACL 读取失败：' + ((e && e.message) || e) });
      return true;
    }
    const disks = (() => {
      try { return (app.listDisks(user) || []).map((d) => ({ id: d.id, name: d.name, kind: d.kind })); } catch { return []; }
    })();
    const subjects = new Set(['*', 'guest']);
    for (const members of Object.values(data.groups || {})) {
      if (Array.isArray(members)) for (const m of members) subjects.add('user:' + m);
    }
    for (const rule of Object.values(data.acl || {})) {
      if (rule && typeof rule === 'object') for (const k of Object.keys(rule)) subjects.add(k);
    }
    sendJSON(res, 200, {
      ok: true,
      acl: data,
      groups: data.groups || {},
      rules: data.acl || {},
      disks,
      users: ((app.users && app.users.users) || []).map((u) => u.username),
      subjects: [...subjects].sort(),
      levels: [
        { id: 'none', name: '禁止', desc: '看不到该盘' },
        { id: 'ro', name: '只读', desc: '可浏览/下载，不可写入' },
        { id: 'rw', name: '读写', desc: '可上传/修改/删除' },
      ],
      myPerms: Object.fromEntries(disks.map((d) => [d.id, aclStore.resolvePerm(data, d.id, user)])),
      file: path.join((app.cfg && app.cfg.dataDir) || 'data', 'acl.json'),
      note: '管理员绕过 ACL；其余主体按「user:名 > group:组 > guest/*」取最严的一条。',
    });
    return true;
  },

  _sanitizeAcl(input) {
    const out = { groups: {}, acl: {} };
    const groups = (input && input.groups) || {};
    for (const [k, v] of Object.entries(groups)) {
      if (!/^[\w.-]{1,64}$/.test(k)) continue;
      if (!Array.isArray(v)) continue;
      out.groups[k] = v.map((x) => String(x)).filter((x) => x && x.length < 64).slice(0, 500);
    }
    const acl = (input && input.acl) || {};
    const LEVELS = new Set(['none', 'ro', 'rw']);
    for (const [disk, rules] of Object.entries(acl)) {
      if (!/^(public|private|ext(:[A-Za-z0-9-]+)?)$/.test(disk)) continue;
      if (!rules || typeof rules !== 'object') continue;
      out.acl[disk] = {};
      for (const [subject, level] of Object.entries(rules)) {
        if (!/^(\*|guest|user:[\w.-]{1,64}|group:[\w.-]{1,64})$/.test(subject)) continue;
        if (!LEVELS.has(level)) continue;
        out.acl[disk][subject] = level;
      }
    }
    return out;
  },

  async saveAcl(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const raw = body.data.acl || body.data.data || body.data;
    if (!raw || typeof raw !== 'object') { sendJSON(res, 400, { error: '数据格式不对' }); return true; }
    const clean = this._sanitizeAcl(raw);
    aclStore.saveAcl(app, clean);
    audit(app, req, user, 'acl-save', 'groups=' + Object.keys(clean.groups).length + ' disks=' + Object.keys(clean.acl).length);
    sendJSON(res, 200, { ok: true, acl: clean });
    return true;
  },

  async editAclGroup(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const group = String((body.data && body.data.group) || '').trim();
    const username = String((body.data && body.data.username) || '').trim();
    const op = String((body.data && body.data.op) || 'add');
    if (!/^[\w.-]{1,64}$/.test(group)) { sendJSON(res, 400, { error: '用户组名非法' }); return true; }
    if (!username) { sendJSON(res, 400, { error: '缺少用户名' }); return true; }
    const data = aclStore.loadAcl(app);
    if (!data.groups || typeof data.groups !== 'object') data.groups = {};
    let list = Array.isArray(data.groups[group]) ? data.groups[group] : [];
    if (op === 'remove') list = list.filter((x) => x !== username);
    else if (!list.includes(username)) list.push(username);
    data.groups[group] = list;
    aclStore.saveAcl(app, data);
    audit(app, req, user, 'acl-group', group + '：' + op + ' ' + username);
    sendJSON(res, 200, { ok: true, group, members: list });
    return true;
  },

  /* ================= B7. IP 白名单 ================= */

  async getIp(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    const cfg = ipMod.loadConfig(app);
    const ip = store.clientIp(req);
    const dec = ipMod.decide(app, ip, cfg);
    sendJSON(res, 200, {
      ok: true,
      isAdmin: isAdmin(user),
      config: isAdmin(user) ? cfg : { enabled: cfg.enabled, forceHttps: cfg.forceHttps },
      current: { ip, https: store.isHttps(req), allowed: dec.allowed, matched: dec.matched, reason: dec.reason },
      defaults: ipMod.DEFAULT_ALLOW,
      pinned: ipMod.PINNED,
      emergency: {
        bypassActive: ipMod.bypassActive(app),
        bypassFile: path.join((app.cfg && app.cfg.dataDir) || 'data', 'sec-ip-bypass'),
        commands: [
          'sudo touch /opt/station/fileserver/data/sec-ip-bypass      # 应急放开（立即生效，无需重启）',
          'sudo rm /opt/station/fileserver/data/sec-ip-bypass         # 恢复白名单',
          'sudo systemctl restart station                             # 若改坏了配置，重启后按 data/sec-ip.json 重新加载（不存在则白名单关闭）',
          'sudo mv /opt/station/fileserver/data/sec-ip.json /root/sec-ip.json.bak  # 彻底删除配置（读取失败 = fail-open）',
        ],
        note: '白名单只拦 HTTP/API；SSH 不受影响（团队纪律：不许关 SSH）。应急文件存在时一律放行。',
      },
      testedAt: store.nowIso(),
    });
    return true;
  },

  async saveIp(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const data = body.data;
    const cur = ipMod.loadConfig(app);
    const allow = Array.isArray(data.allow) ? data.allow : cur.allow;
    const enabled = data.enabled !== undefined ? data.enabled === true : cur.enabled;
    const forceHttps = data.forceHttps !== undefined ? data.forceHttps === true : cur.forceHttps;
    const saved = ipMod.saveConfig(app, { allow, enabled, forceHttps }, user.username);
    if (!saved.ok) { sendJSON(res, 400, { error: saved.error }); return true; }
    cryptoMod.invalidate();
    const myIp = store.clientIp(req);
    const dec = ipMod.decide(app, myIp, saved.config);
    audit(app, req, user, 'ip-whitelist', 'enabled=' + enabled + ' allow=' + saved.config.allow.join(','), true);
    sendJSON(res, 200, {
      ok: true,
      config: saved.config,
      self: { ip: myIp, allowed: dec.allowed, matched: dec.matched },
      warning: dec.allowed ? null
        : '注意：当前 IP ' + myIp + ' 已不在新白名单内，下一个请求将被拒绝。'
          + '应急：在服务器执行 sudo touch /opt/station/fileserver/data/sec-ip-bypass',
    });
    return true;
  },

  async resetIp(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const r = ipMod.resetConfig(app, user.username);
    if (!r.ok) { sendJSON(res, 500, { error: r.error || '重置失败' }); return true; }
    cryptoMod.invalidate();
    audit(app, req, user, 'ip-whitelist-reset', '恢复默认（关闭白名单 + 默认网段）');
    sendJSON(res, 200, { ok: true, config: r.config });
    return true;
  },

  async simulateIp(ctx) {
    const { app, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const ip = String((body.data && body.data.ip) || '').trim();
    if (!ip) { sendJSON(res, 400, { error: '缺少 ip' }); return true; }
    const candidates = Array.isArray(body.data.allow) ? body.data.allow : null;
    let cfg = null;
    if (candidates) {
      const parsed = [];
      for (const c of candidates) {
        const p = ipMod.parseCidr(c);
        if (!p.ok) { sendJSON(res, 400, { error: '网段非法：' + c }); return true; }
        parsed.push(p.text);
      }
      cfg = { enabled: body.data.enabled !== false, allow: parsed };
    }
    const dec = ipMod.decide(app, ip, cfg);
    sendJSON(res, 200, {
      ok: true,
      ip: store.normalizeIp(ip),
      allowed: dec.allowed,
      matched: dec.matched,
      reason: dec.reason,
      against: cfg ? 'proposed' : 'current',
    });
    return true;
  },

  async bypassIp(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const action = String((body.data && body.data.action) || 'clear');
    if (action === 'clear') {
      try { fs.unlinkSync(ipMod.bypassFile(app)); } catch { /* 不存在也无所谓 */ }
      audit(app, req, user, 'ip-bypass-clear', '清除应急放行文件');
      sendJSON(res, 200, { ok: true, bypassActive: ipMod.bypassActive(app) });
      return true;
    }
    sendJSON(res, 400, { error: '不支持的操作（仅支持 clear）' });
    return true;
  },

  /* ================= B8. 备份与快照 ================= */

  async backupInfo(ctx) {
    const { app, res, user, sendJSON } = ctx;
    const disks = [];
    for (const disk of ['private', 'public']) {
      try {
        const t = app.resolveTarget({ disk, path: '' }, user);
        if (t.error) continue;
        const snapRoot = path.join(t.root, '.snapshots');
        let size = 0;
        let count = 0;
        try {
          const names = fs.readdirSync(snapRoot).filter((n) => !n.startsWith('.'));
          count = names.length;
          for (const n of names) {
            try {
              const st = fs.statSync(path.join(snapRoot, n));
              if (st.isDirectory()) size += 0;   // 硬链接快照本身几乎不占空间
            } catch { /* 忽略 */ }
          }
        } catch { /* 没有快照目录 */ }
        let diskUsed = 0;
        try {
          const st = fs.statSync(t.root);
          diskUsed = st.size;
        } catch { /* 忽略 */ }
        disks.push({
          id: disk,
          root: t.root,
          snapRoot,
          snapshots: count,
          lastSnapshots: (() => {
            try { return snapshots.listSnapshots(app, disk, user).slice(0, 5); } catch { return []; }
          })(),
          type: disk === 'private' ? '个人私人空间（只有自己能看）' : '公共盘（全组可读写，17GB+，快照为硬链接增量）',
          note: disk === 'public' ? '公共盘快照/恢复仅管理员可操作（会覆盖其他人的文件）' : '',
        });
      } catch (e) {
        disks.push({ id: disk, error: (e && e.message) || String(e) });
      }
    }
    sendJSON(res, 200, {
      ok: true,
      disks,
      method: '硬链接增量快照（lib/snapshot.js）：同一 inode，几乎不占额外空间；恢复为「覆盖同名 + 补齐缺失」，不删除新文件。',
      drill: {
        fixturePath: '_restore_drill/restore-test.txt',
        steps: [
          '1. 生成演练文件（私人空间）',
          '2. 创建快照',
          '3. 删除演练文件（走文件管理 API，进回收站）',
          '4. 从快照恢复指定路径',
          '5. 校验文件内容 SHA-256 与创建时一致',
        ],
      },
    });
    return true;
  },

  _snapDisk(ctx, raw) {
    const disk = String(raw || 'private');
    if (!['private', 'public'].includes(disk)) return { error: '只能操作 private / public 盘' };
    if (disk === 'public' && !isAdmin(ctx.user)) return { error: '公共盘快照/恢复需要管理员权限' };
    return { disk };
  },

  async listSnaps(ctx) {
    const { app, res, user, sendJSON } = ctx;
    const picked = this._snapDisk(ctx, ctx.query && ctx.query.disk);
    if (picked.error) { sendJSON(res, 403, { error: picked.error }); return true; }
    let list;
    try { list = snapshots.listSnapshots(app, picked.disk, user); } catch (e) {
      sendJSON(res, 500, { error: '快照列表读取失败：' + ((e && e.message) || e) });
      return true;
    }
    sendJSON(res, 200, { ok: true, disk: picked.disk, snapshots: list, at: store.nowIso() });
    return true;
  },

  async createSnap(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!throttle(app, 'snapshot:' + user.username, 6, 5 * 60 * 1000)) {
      sendJSON(res, 429, { error: '快照创建过于频繁（6 次/5 分钟）' });
      return true;
    }
    const body = await readJson(ctx);
    const picked = this._snapDisk(ctx, body.data && body.data.disk);
    if (picked.error) { sendJSON(res, 403, { error: picked.error }); return true; }
    const keep = Math.max(1, Math.min(30, Number(body.data && body.data.keep) || 7));
    const t0 = process.hrtime.bigint();
    let r;
    try {
      r = await snapshots.snapshotDisk(app, picked.disk, user, { keep });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    if (!r.ok) {
      audit(app, req, user, 'backup-snapshot', picked.disk + ' 失败：' + (r.error || ''), false);
      sendJSON(res, r.code || 500, { error: r.error || '快照失败', durationMs });
      return true;
    }
    audit(app, req, user, 'backup-snapshot', picked.disk + ' → ' + r.name + '（' + (r.entries || 0) + ' 项，' + durationMs + 'ms）');
    sendJSON(res, 200, { ok: true, disk: picked.disk, name: r.name, entries: r.entries, linkFallback: r.linkFallback || 0, durationMs });
    return true;
  },

  async restoreSnap(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    const body = await readJson(ctx);
    const picked = this._snapDisk(ctx, body.data && body.data.disk);
    if (picked.error) { sendJSON(res, 403, { error: picked.error }); return true; }
    const name = String((body.data && body.data.name) || '');
    const relPath = String((body.data && body.data.path) || '');
    if (!name) { sendJSON(res, 400, { error: '缺少快照名称' }); return true; }
    const t0 = process.hrtime.bigint();
    let r;
    try {
      r = await snapshots.restoreSnapshot(app, picked.disk, name, user, { path: relPath });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    if (!r.ok) {
      audit(app, req, user, 'backup-restore', picked.disk + ' ← ' + name + ' 失败：' + (r.error || ''), false);
      sendJSON(res, r.code || 500, { error: r.error || '恢复失败', durationMs });
      return true;
    }
    try { app.invalidateSizeCache(); } catch { /* 忽略 */ }
    audit(app, req, user, 'backup-restore', picked.disk + ' ← ' + name + (relPath ? '/' + relPath : '（整盘）') + '，恢复 ' + (r.restored || 0) + ' 项，' + durationMs + 'ms');
    sendJSON(res, 200, { ok: true, disk: picked.disk, name, path: relPath, restored: r.restored || 0, durationMs });
    return true;
  },

  _fixtureFile(ctx) {
    const app = ctx.app || ctx;
    const user = ctx.user;
    const t = app.resolveTarget({ disk: 'private', path: '' }, user);
    if (t.error) return { error: t.error };
    const rel = path.join('_restore_drill', 'restore-test.txt');
    return { root: t.root, rel, abs: path.join(t.root, rel) };
  },

  async fixtureInfo(ctx) {
    const { app, res, user, sendJSON } = ctx;
    const f = (() => {
      try {
        const t = app.resolveTarget({ disk: 'private', path: '' }, user);
        if (t.error) return { error: t.error };
        const rel = path.join('_restore_drill', 'restore-test.txt');
        return { root: t.root, rel, abs: path.join(t.root, rel) };
      } catch (e) { return { error: (e && e.message) || String(e) }; }
    })();
    if (f.error) { sendJSON(res, 400, { error: f.error }); return true; }
    let st = null;
    try { st = fs.statSync(f.abs); } catch { st = null; }
    sendJSON(res, 200, {
      ok: true,
      exists: !!st,
      relPath: f.rel.split(path.sep).join('/'),
      size: st ? st.size : null,
      mtime: st ? new Date(st.mtimeMs).toISOString() : null,
      content: st && st.size < 8192 ? (() => { try { return fs.readFileSync(f.abs, 'utf8'); } catch { return null; } })() : null,
    });
    return true;
  },

  async fixtureOp(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    const body = await readJson(ctx);
    const action = String((body.data && body.data.action) || 'create');
    let t;
    try { t = app.resolveTarget({ disk: 'private', path: '' }, user); } catch (e) {
      sendJSON(res, 500, { error: (e && e.message) || String(e) });
      return true;
    }
    if (t.error) { sendJSON(res, 400, { error: t.error }); return true; }
    const rel = path.join('_restore_drill', 'restore-test.txt');
    const abs = path.join(t.root, rel);
    if (action === 'create') {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const content = '深空工作站 · 快照恢复演练\n生成时间：' + store.nowIso() + '\n随机校验串：' + crypto.randomBytes(8).toString('hex') + '\n';
      fs.writeFileSync(abs, content, 'utf8');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      audit(app, req, user, 'backup-drill-create', rel + ' sha256=' + sha256.slice(0, 16));
      sendJSON(res, 200, { ok: true, action, relPath: rel.split(path.sep).join('/'), size: Buffer.byteLength(content), sha256, content });
      return true;
    }
    if (action === 'delete') {
      try { fs.unlinkSync(abs); } catch (e) {
        sendJSON(res, e && e.code === 'ENOENT' ? 404 : 500, { error: '删除失败：' + ((e && e.message) || e) });
        return true;
      }
      audit(app, req, user, 'backup-drill-delete', rel);
      sendJSON(res, 200, { ok: true, action, relPath: rel.split(path.sep).join('/'), exists: false });
      return true;
    }
    sendJSON(res, 400, { error: 'action 只能是 create / delete' });
    return true;
  },

  /* ================= B9. 传输与存储加密 ================= */

  async getCrypto(ctx) {
    const { app, req, res, sendJSON } = ctx;
    try {
      const p = await cryptoMod.posture(app, req);
      sendJSON(res, 200, { ok: true, ...p, isAdmin: isAdmin(ctx.user) });
    } catch (e) {
      sendJSON(res, 500, { error: '加密状态采集失败：' + ((e && e.message) || e) });
    }
    return true;
  },

  async toggleCrypto(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const body = await readJson(ctx);
    const key = String((body.data && body.data.key) || '');
    const value = body.data && body.data.value === true;
    const cfg = ipMod.loadConfig(app);
    if (key === 'forceHttps') {
      const r = ipMod.saveConfig(app, { allow: cfg.allow, enabled: cfg.enabled, forceHttps: value }, user.username);
      if (!r.ok) { sendJSON(res, 400, { error: r.error }); return true; }
      cryptoMod.invalidate();
      audit(app, req, user, 'crypto-toggle', 'forceHttps=' + value);
      sendJSON(res, 200, {
        ok: true,
        key,
        value,
        config: { forceHttps: r.config.forceHttps, enabled: r.config.enabled },
        note: value
          ? '已开启：来自非回环地址的明文 http 请求会被 403（HTTPS 8443 不受影响）。'
          : '已关闭：http 与 https 入口都可用。',
      });
      return true;
    }
    if (key === 'ipWhitelist') {
      const r = ipMod.saveConfig(app, { allow: cfg.allow, enabled: value, forceHttps: cfg.forceHttps }, user.username);
      if (!r.ok) { sendJSON(res, 400, { error: r.error }); return true; }
      cryptoMod.invalidate();
      audit(app, req, user, 'crypto-toggle', 'ipWhitelist=' + value);
      sendJSON(res, 200, { ok: true, key, value, config: { forceHttps: r.config.forceHttps, enabled: r.config.enabled } });
      return true;
    }
    sendJSON(res, 400, {
      error: '该加密项不可由本模块开关（属 nginx / Samba / 磁盘层）：' + key,
      toggleable: ['forceHttps', 'ipWhitelist'],
    });
    return true;
  },

  /* ================= B10. 风险检测 ================= */

  async getRisk(ctx) {
    const { app, req, res, sendJSON } = ctx;
    try {
      const r = await riskMod.checks(app, req);
      sendJSON(res, 200, { ok: true, isAdmin: isAdmin(ctx.user), ...r });
    } catch (e) {
      sendJSON(res, 500, { error: '风险检测失败：' + ((e && e.message) || e) });
    }
    return true;
  },

  async getScan(ctx) {
    const { app, res, sendJSON } = ctx;
    sendJSON(res, 200, { ok: true, scan: riskMod.scanStatus(app), isAdmin: isAdmin(ctx.user) });
    return true;
  },

  async runScan(ctx) {
    const { app, res, user, sendJSON } = ctx;
    if (!isAdmin(user)) { sendJSON(res, 403, { error: '需要管理员权限' }); return true; }
    const status = riskMod.scanStatus(app);
    if (status && status.status === 'running') {
      sendJSON(res, 200, { ok: true, started: false, scan: status, note: '扫描已在进行中' });
      return true;
    }
    const job = riskMod.runWeakScan(app);
    audit(app, ctx.req, user, 'weak-password-scan', '开始扫描 ' + (job.totalUsers || 0) + ' 个账号');
    sendJSON(res, 200, { ok: true, started: true, scan: job });
    return true;
  },

  /* ================= B11. 数据导出与注销 ================= */

  async exportData(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    const format = String((ctx.query && ctx.query.format) || 'json').toLowerCase();
    if (!['json', 'zip'].includes(format)) { sendJSON(res, 400, { error: 'format 只能是 json / zip' }); return true; }
    let payload;
    try {
      payload = exportMod.build(app, user, secCtx.sid());
    } catch (e) {
      sendJSON(res, 500, { error: '导出数据组装失败：' + ((e && e.message) || e) });
      return true;
    }
    audit(app, req, user, 'data-export', format + '（会话 ' + (payload.sessions || []).length + '，审计 ' + (payload.audit || []).length + ' 条）');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    if (format === 'zip') {
      let buf;
      try { buf = exportMod.buildZip(payload); } catch (e) {
        sendJSON(res, 500, { error: 'ZIP 打包失败：' + ((e && e.message) || e) });
        return true;
      }
      attachment(res, 'my-data-' + stamp + '.zip', 'application/zip', buf);
      return true;
    }
    const json = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    attachment(res, 'my-data-' + stamp + '.json', 'application/json; charset=utf-8', json);
    return true;
  },

  async deleteAccount(ctx) {
    const { app, req, res, user, sendJSON } = ctx;
    if (isAdmin(user)) {
      sendJSON(res, 403, {
        error: '管理员账号禁止注销：这是工作站唯一的管理入口，注销后将无人能管理用户与权限。'
          + '如确实要离开，请先由另一位管理员把你的角色改为普通用户。',
        code: 'ADMIN_CANNOT_DELETE',
      });
      return true;
    }
    /* 注销账号 = 会被「口令猜测」尝试的敏感接口：10 分钟窗口内最多 5 次。
       注意它是按用户名计数的；验收脚本因此每次用一个唯一测试账号，
       避免连续两次验收在同一个窗口里互相触发 429（团队联调时踩到过）。 */
    if (!throttle(app, 'selfdelete:' + user.username, 5, 10 * 60 * 1000)) {
      sendJSON(res, 429, { error: '操作过于频繁' });
      return true;
    }
    const body = await readJson(ctx);
    const password = String((body.data && body.data.password) || '');
    const confirm = String((body.data && body.data.confirm) || '');
    if (confirm !== user.username) {
      sendJSON(res, 400, { error: '二次确认失败：请完整输入你的用户名「' + user.username + '」', code: 'CONFIRM_REQUIRED' });
      return true;
    }
    let verified = null;
    try { verified = await app.users.verifyAsync(user.username, password); } catch { verified = null; }
    if (!verified) {
      audit(app, req, user, 'account-delete-fail', '口令错误', false);
      sendJSON(res, 400, { error: '口令不正确，账号未注销', code: 'BAD_PASSWORD' });
      return true;
    }
    const name = user.username;
    audit(app, req, user, 'account-delete', name + '（保留文件数据，仅删除账号）');
    app.users.users = app.users.users.filter((x) => x.id !== user.id);
    app.users.reindex();
    app.users.save();
    for (const [sid, s] of [...app.sessions.sessions]) {
      if (s.userId === user.id) { app.sessions.destroy(sid); sessionMod.forget(app, sid); }
    }
    clearRecoveryCodes(app, name);
    try { policyMod.clearHistory(app, name); } catch { /* 清历史失败不阻断注销 */ }
    try { app.clearSessionCookie(req, res); } catch { /* 忽略 */ }
    sendJSON(res, 200, { ok: true, deleted: name, filesKept: true, note: '账号已注销，私人空间文件按团队纪律保留（未删除用户数据）。' });
    return true;
  },
};

module.exports = mod;

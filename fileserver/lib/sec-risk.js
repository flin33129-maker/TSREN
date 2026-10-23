'use strict';

/* =====================================================================
   lib/sec-risk.js — 风险检测（真实数据，不做「假绿」）
   ---------------------------------------------------------------------
   需求（P0 第 9 项）：弱密码账号、过期未改密、异常登录 IP、审计失败率、
   未开 2FA 的管理员 —— 给出当前真实结果列表。

   数据来源全部是现网真实状态：
     · 用户库 data/users.json（经 app.users）
     · 口令元数据 data/sec-policy.json（本模块写入）
     · 审计日志 data/audit.log（app.readAudit，已被本模块的 IP 补丁增强）
     · 会话/设备台账、IP 白名单、加密状态（sec-*.js）
   弱口令扫描是**真的用候选口令逐条做 scrypt 比对**（异步 scrypt，不阻塞
   事件循环），扫描在后台跑、页面轮询结果，扫描结果落 data/sec-risk.json。
   ===================================================================== */

const store = require('./sec-store');
const policyMod = require('./sec-policy');
const ipMod = require('./sec-ip');
const sessionMod = require('./sec-session-meta');
const { hashPasswordAsync } = require('./auth');

function fileOf(app) { return store.fileOf(app, 'risk'); }

/* 候选弱口令：通用弱口令 + 用户名变体。刻意**不放**任何站点真实口令。 */
const COMMON = policyMod.COMMON_WEAK;

function candidatesFor(username) {
  const u = String(username || '');
  const list = COMMON.slice(0, 24);
  if (u.length >= 2) {
    list.push(u.toLowerCase(), u + '123', u + '123456', u + '2026', u + '@123');
  }
  list.push('httpserver', 'nas123456', 'station123');
  return Array.from(new Set(list));
}

function loadState(app) {
  const raw = store.loadJSON(fileOf(app), null);
  return {
    weakScan: (raw && raw.weakScan) || null,
    lastCheckAt: (raw && raw.lastCheckAt) || null,
  };
}

function saveState(app, st) {
  store.saveJSON(fileOf(app), { version: 1, ...st, updatedAt: store.nowIso() });
}

/* --------------------------- 弱口令扫描（后台） --------------------------- */

function scanStatus(app) {
  const live = app.__secWeakScan;
  if (live) return live;
  const state = loadState(app);
  const s = state.weakScan;
  if (!s) return { status: 'idle', weakUsers: [], checkedUsers: 0 };
  /* 单进程内存里没有任务、但落盘状态还是 running → 一定是进程重启把它中断了。
     直接判「可重跑」，否则页面会一直显示扫描中（5 分钟阈值也会让人白等）。 */
  if (s.status === 'running') {
    return {
      ...s,
      status: 'error',
      error: '上一次扫描未完成（服务重启或进程中断），可重新运行',
    };
  }
  return s;
}

function runWeakScan(app) {
  if (app.__secWeakScan && app.__secWeakScan.status === 'running') return scanStatus(app);
  const started = Date.now();
  const job = {
    status: 'running',
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    durationMs: null,
    checkedUsers: 0,
    totalUsers: 0,
    candidatesPerUser: 0,
    weakUsers: [],
    error: null,
  };
  app.__secWeakScan = job;
  (async () => {
    try {
      const users = (app.users && app.users.users) || [];
      job.totalUsers = users.length;
      job.candidatesPerUser = candidatesFor('').length;
      let lastSave = 0;
      const touchSave = () => {
        const now = Date.now();
        if (now - lastSave > 1200) {
          lastSave = now;
          job.durationMs = now - started;
          saveState(app, { weakScan: job, lastCheckAt: store.nowIso() });
        }
      };
      /* 并发按用户跑（每个用户的候选口令仍串行）：13 个账号在 i5 上 ~3-6 秒完成，
         串行在并行改造期间（其他模块也在压 CPU）可能超过 90 秒 —— 实测踩过。 */
      await Promise.all(users.map(async (u) => {
        if (!u || !u.hash || !u.salt) return;
        const cand = candidatesFor(u.username);
        let hit = false;
        for (const pw of cand) {
          let h;
          try { h = await hashPasswordAsync(pw, u.salt); } catch { break; }
          if (h === u.hash) { hit = true; break; }
        }
        job.checkedUsers++;
        if (hit) job.weakUsers.push({ username: u.username, role: u.role, disabled: !!u.disabled });
        touchSave();
      }));
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - started;
      saveState(app, { weakScan: job, lastCheckAt: store.nowIso() });
    } catch (e) {
      job.status = 'error';
      job.error = (e && e.message) || String(e);
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - started;
      try { saveState(app, { weakScan: job, lastCheckAt: store.nowIso() }); } catch { /* 忽略 */ }
    }
  })();
  return job;
}

/* ------------------------------ 审计分析 ------------------------------ */

let auditCache = { at: 0, entries: null };
function auditEntries(app) {
  const now = Date.now();
  if (auditCache.entries && now - auditCache.at < 10000) return auditCache.entries;
  let entries = [];
  try { entries = app.readAudit(100000) || []; } catch { entries = []; }
  auditCache = { at: now, entries };
  return entries;
}

function parseTs(e) {
  const t = Date.parse(e && e.ts ? e.ts : '');
  return Number.isFinite(t) ? t : 0;
}

/** 登录 IP 画像：每个账号的成功登录 IP、失败爆发 */
function loginIpAnalysis(app) {
  const entries = auditEntries(app);
  const now = Date.now();
  const dayAgo = now - 86400000;
  const weekAgo = now - 7 * 86400000;
  const byUser = new Map();
  const failsByIp = new Map();
  let total = 0;
  let failed = 0;
  for (const e of entries) {
    const ts = parseTs(e);
    if (!ts || ts < weekAgo) continue;
    total++;
    if (e.ok === false) failed++;
    const action = String(e.action || '');
    if (action === 'login' && e.ok !== false) {
      const user = String(e.user || '');
      if (!byUser.has(user)) byUser.set(user, []);
      byUser.get(user).push({ ip: String(e.ip || ''), ts });
    }
    if ((action === 'login-fail' || action === 'login-web-fail') && e.ok === false) {
      const key = String(e.ip || '');
      if (!failsByIp.has(key)) failsByIp.set(key, []);
      failsByIp.get(key).push(ts);
    }
  }
  const ips = [];
  for (const [user, list] of byUser) {
    const ipMap = new Map();
    for (const it of list) {
      if (!ipMap.has(it.ip)) ipMap.set(it.ip, { ip: it.ip, count: 0, first: it.ts, last: it.ts });
      const rec = ipMap.get(it.ip);
      rec.count++;
      rec.first = Math.min(rec.first, it.ts);
      rec.last = Math.max(rec.last, it.ts);
    }
    for (const rec of ipMap.values()) {
      ips.push({
        user,
        ip: rec.ip,
        count: rec.count,
        firstSeen: new Date(rec.first).toISOString(),
        lastSeen: new Date(rec.last).toISOString(),
        newIn24h: rec.first >= dayAgo,
        loopback: rec.ip === '127.0.0.1' || rec.ip === '::1',
      });
    }
  }
  ips.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));

  // 失败爆发：同 IP 10 分钟内 ≥5 次失败
  const bursts = [];
  for (const [ip, tsList] of failsByIp) {
    const sorted = tsList.slice().sort((a, b) => a - b);
    let start = 0;
    for (let i = 0; i < sorted.length; i++) {
      while (sorted[i] - sorted[start] > 10 * 60 * 1000) start++;
      if (i - start + 1 >= 5) {
        bursts.push({
          ip,
          count: i - start + 1,
          windowFrom: new Date(sorted[start]).toISOString(),
          windowTo: new Date(sorted[i]).toISOString(),
        });
        break;
      }
    }
  }
  return { ips, bursts, total, failed, failureRate: total ? Math.round((failed / total) * 1000) / 10 : 0 };
}

/* ------------------------------- 检测项 ------------------------------- */

function levelOf(sev) { return sev; }

async function checks(app, req) {
  const users = (app.users && app.users.users) || [];
  const policyData = policyMod.load(app);
  const cfg = ipMod.loadConfig(app);
  const out = [];
  const login = loginIpAnalysis(app);
  const scan = scanStatus(app);

  /* 1. 弱口令账号 */
  const weak = Array.isArray(scan.weakUsers) ? scan.weakUsers : [];
  out.push({
    id: 'weak-password',
    title: '弱口令账号',
    severity: scan.status === 'done' ? (weak.length ? 'high' : 'ok') : 'info',
    summary: scan.status === 'done'
      ? (weak.length ? weak.length + ' 个账号命中常见弱口令字典' : '已扫描 ' + scan.checkedUsers + ' 个账号，未发现常见弱口令')
      : (scan.status === 'running' ? '弱口令扫描进行中…' : '尚未扫描（点「运行弱口令扫描」，真实逐条比对 scrypt 哈希）'),
    items: weak.map((x) => ({ label: x.username, detail: '命中常见弱口令（不显示具体口令）', user: x.username })),
    fix: '在「账号与 2FA」里改密，或由管理员重置为符合策略的强口令。',
    meta: scan.status === 'done' ? { at: scan.finishedAt, durationMs: scan.durationMs, checkedUsers: scan.checkedUsers } : null,
  });

  /* 2. 过期未改密 */
  const expired = [];
  const unknown = [];
  for (const u of users) {
    const st = policyMod.stateOf(app, u, policyData);
    if (st.expired) expired.push({ label: u.username, detail: '已于 ' + st.expiresAt + ' 到期（' + st.maxAgeDays + ' 天）', user: u.username });
    else if (!st.known) unknown.push({ label: u.username, detail: '无口令变更记录（策略基线外账号）', user: u.username });
  }
  out.push({
    id: 'expired-password',
    title: '口令有效期',
    severity: expired.length ? 'high' : (unknown.length ? 'low' : 'ok'),
    summary: policyData.policy.maxAgeDays
      ? (expired.length ? expired.length + ' 个账号口令已过期' : '全部账号在 ' + policyData.policy.maxAgeDays + ' 天有效期内' + (unknown.length ? '（' + unknown.length + ' 个账号缺变更记录，按基线日计算）' : ''))
      : '未启用有效期策略',
    items: [...expired, ...unknown],
    fix: '开启/调整有效期策略后，过期账号在登录后被强制引导改密（见「密码策略」）。',
    meta: { maxAgeDays: policyData.policy.maxAgeDays, baselineAt: policyData.baselineAt },
  });

  /* 3. 异常登录 IP */
  const abnormal = [];
  for (const ip of login.ips) {
    const isLocal = /^127\.|^::1$|^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip.ip);
    if (!isLocal) {
      abnormal.push({ label: ip.ip, detail: ip.user + ' 从公网/非私网地址登录 ' + ip.count + ' 次（最后 ' + ip.lastSeen + '）', user: ip.user });
    }
  }
  for (const b of login.bursts) {
    abnormal.push({ label: b.ip, detail: '10 分钟内 ' + b.count + ' 次登录失败（' + b.windowFrom + ' ~ ' + b.windowTo + '）' });
  }
  out.push({
    id: 'abnormal-login',
    title: '异常登录 IP',
    severity: abnormal.length ? 'high' : 'ok',
    summary: abnormal.length
      ? abnormal.length + ' 条可疑记录（非私网登录 / 暴力尝试）'
      : '最近 7 天 ' + login.ips.length + ' 个登录来源均为内网地址，无失败爆发',
    items: abnormal.slice(0, 50),
    fix: '确认是否为本人；若非本人立即改密并在「设备与会话」踢出该会话。',
    meta: { window: '7d', sources: login.ips.slice(0, 50), bursts: login.bursts },
  });

  /* 4. 审计失败率 */
  const rate = login.failureRate;
  out.push({
    id: 'audit-failure',
    title: '审计失败率（7 天）',
    severity: rate > 30 ? 'high' : rate > 10 ? 'medium' : 'ok',
    summary: '最近 7 天 ' + login.total + ' 条审计，失败 ' + login.failed + ' 条（' + rate + '%）',
    items: [],
    fix: '失败率偏高通常是密码错误/权限被拒；持续偏高需检查是否有人在探测。',
    meta: { total: login.total, failed: login.failed, rate },
  });

  /* 5. 未开 2FA 的管理员 */
  const admins = users.filter((u) => u.role === 'admin');
  const adminsNo2fa = admins.filter((u) => !u.totpEnabled);
  out.push({
    id: 'admin-2fa',
    title: '管理员 2FA',
    severity: adminsNo2fa.length ? 'high' : 'ok',
    summary: adminsNo2fa.length
      ? adminsNo2fa.length + '/' + admins.length + ' 个管理员未启用 2FA'
      : admins.length + ' 个管理员均已启用 2FA',
    items: adminsNo2fa.map((u) => ({ label: u.username, detail: '管理员账号未启用动态口令' , user: u.username })),
    fix: '用管理员本人账号在「账号与 2FA」里扫码启用；启用后登录需动态验证码。',
    meta: { admins: admins.map((u) => u.username) },
  });

  /* 6. IP 白名单状态 */
  out.push({
    id: 'ip-whitelist',
    title: 'IP 白名单',
    severity: cfg.enabled ? 'ok' : 'medium',
    summary: cfg.enabled
      ? '已启用，允许 ' + cfg.allow.length + ' 个网段' + (ipMod.bypassActive(app) ? '（当前处于应急放行状态）' : '')
      : '未启用（任何能访问 192.168.99.1 的设备都可尝试登录）',
    items: cfg.allow.map((a) => ({ label: a, detail: '允许' })),
    fix: '在「IP 白名单」里开启；务必保留 192.168.99.0/24 与 127.0.0.0/8。',
    meta: { enabled: cfg.enabled, allow: cfg.allow, bypass: ipMod.bypassActive(app) },
  });

  /* 7. 明文 HTTP 入口 */
  out.push({
    id: 'plain-http',
    title: '明文 HTTP 入口',
    severity: cfg.forceHttps ? 'ok' : 'medium',
    summary: cfg.forceHttps
      ? '已开启应用层强制 HTTPS（http 入口的 API 请求会被拒绝）'
      : 'http://192.168.99.1/ 仍可用（局域网内明文传输口令与 Cookie）',
    items: [],
    fix: '在「传输与存储加密」里开启「强制 HTTPS」，或直接改用 https://192.168.99.1:8443/app/。',
    meta: { forceHttps: cfg.forceHttps },
  });

  const high = out.filter((c) => c.severity === 'high').length;
  const medium = out.filter((c) => c.severity === 'medium').length;
  const low = out.filter((c) => c.severity === 'low').length;
  const score = Math.max(0, 100 - high * 20 - medium * 8 - low * 2);
  return {
    at: store.nowIso(),
    score,
    summary: { high, medium, low, ok: out.filter((c) => c.severity === 'ok').length, total: out.length },
    checks: out,
    login,
    weakScan: scan,
    sessions: (() => { try { const s = sessionMod.list(app); return { count: s.count, onlineCount: s.onlineCount }; } catch { return null; } })(),
    client: { ip: store.clientIp(req) },
  };
}

module.exports = { checks, runWeakScan, scanStatus, candidatesFor, loginIpAnalysis, fileOf, loadState };

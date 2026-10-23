'use strict';

/**
 * R15：平台自检路由（扩展路由层的第一个模块，同时是这层的活体证明）。
 *
 * 为什么要它：
 *   改造过程中会不断加模块。没有一处「现在到底装了什么」的机器可读视图，
 *   验收就只能靠人眼翻页面。这里把版本、扩展模块、关键子系统的真实状态
 *   一次性吐出来，验收脚本据此断言。
 *
 * 接口：
 *   GET /api/r15/health        基础信息（匿名可读，不含任何敏感配置）
 *   GET /api/r15/modules       扩展模块清单（需要登录）
 *   GET /api/r15/diagnostics   关键子系统探活（需要登录）
 */

const registry = require('./index');

function sysInfo() {
  const os = require('os');
  const m0 = os.loadavg ? os.loadavg() : [0, 0, 0];
  return {
    node: process.version,
    platform: process.platform + ' ' + process.arch,
    uptimeSec: Math.round(process.uptime()),
    load1: Math.round(m0[0] * 100) / 100,
    memUsedMB: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  };
}

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  let ok = false;
  let detail = '';
  try {
    const r = await fn();
    ok = r !== false;
    if (typeof r === 'string') detail = r;
  } catch (e) {
    ok = false;
    detail = (e && e.message) || String(e);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ok, ms: Math.round(ms * 10) / 10, detail };
}

const mod = {
  name: 'platform-health',
  prefixes: ['/api/r15'],

  async handle(ctx) {
    const { pathname, method, res, sendJSON, user, app } = ctx;
    if (method !== 'GET') return false;

    if (pathname === '/api/r15/health') {
      sendJSON(res, 200, {
        ok: true,
        service: 'deep-space-workstation',
        version: 'r15',
        pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        sys: sysInfo(),
        routes: registry.modules.map((m) => ({ name: m.name, prefixes: m.prefixes })),
        loadError: registry.list().loadError,
      });
      return true;
    }

    if (pathname === '/api/r15/modules') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
      sendJSON(res, 200, registry.list());
      return true;
    }

    if (pathname === '/api/r15/diagnostics') {
      if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;
      const checks = {};
      /* optional: true 的项「不可用」只算警告，不影响整体 ok。
         原因：Samba / Yjs 中继 / 外部 AI 后端都是**可选增强**，没装不代表站坏了；
         之前把 samba 写进必检项，导致任何非 Samba 部署打开诊断页都是红的。 */
      checks.storage = await timed(async () => {
        const root = app && app.cfg && app.cfg.storageDir;
        const fs = require('fs');
        if (!root) return false;
        fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
        const st = fs.statfsSync ? fs.statfsSync(root) : null;
        return st ? 'freeGB=' + Math.round((st.bavail * st.bsize) / 1073741824) : 'ok';
      });
      checks.hub = await timed(() => {
        if (!app || !app.hub) return false;
        return 'clients=' + (app.hub.clients ? app.hub.clients.size : 'n/a');
      });
      checks.docs = await timed(() => (app && app.docs ? true : false));
      checks.ai = await timed(async () => {
        if (!app || !app.ai) return false;
        const cfg = app.ai.cfg || {};
        const list = Array.isArray(cfg.backends) ? cfg.backends : [];
        return 'backends=' + list.length;
      });
      checks.sambDb = await timed(async () => {
        const { execFileSync } = require('child_process');
        const out = execFileSync('sh', ['-c', 'test -e /etc/samba/smb.conf && echo ok'], { encoding: 'utf8' });
        return out.trim();
      });
      /* 办公文档库：能读能写、索引条数（新增项，直接对应「办公页打不开」这类事故） */
      checks.office = await timed(async () => {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join((app && app.cfg && app.cfg.dataDir) || '', 'office');
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
        const idx = JSON.parse(fs.existsSync(path.join(dir, 'index.json')) ? fs.readFileSync(path.join(dir, 'index.json'), 'utf8') : '[]');
        return 'docs=' + (Array.isArray(idx) ? idx.length : 0);
      });
      checks.officeRelay = await timed(async () => {
        /* Yjs relay（station-office.service）默认在 8082。原来这里连的是 42000，
           那是 NFS mount 端口 —— 探活结果和真实中继状态完全无关。 */
        const net = require('net');
        const port = Number(process.env.OFFICE_RELAY_PORT) || 8082;
        return await new Promise((resolve) => {
          const sock = net.connect({ host: '127.0.0.1', port });
          const done = (v, detail) => {
            try { sock.destroy(); } catch {}
            resolve(v ? detail : false);
          };
          sock.setTimeout(1500, () => done(false));
          sock.on('connect', () => done(true, 'tcp ok :' + port));
          sock.on('error', () => done(false));
        });
      });
      const OPTIONAL = new Set(['sambDb', 'officeRelay']);
      const failed = Object.entries(checks).filter(([k, c]) => !c.ok && !OPTIONAL.has(k));
      const warned = Object.entries(checks).filter(([k, c]) => !c.ok && OPTIONAL.has(k));
      for (const [k, c] of Object.entries(checks)) if (OPTIONAL.has(k)) c.optional = true;
      sendJSON(res, 200, {
        ok: failed.length === 0,
        checks,
        failed: failed.map(([k]) => k),
        warnings: warned.map(([k]) => k),
        at: new Date().toISOString(),
      });
      return true;
    }

    return false;
  },
};

module.exports = mod;

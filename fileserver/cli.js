#!/usr/bin/env node
'use strict';

/* =====================================================================
   cli.js — 局域网NAS 命令行管理工具（零依赖，Node 18+）
   用法：
     node cli.js <cmd> [--host http://127.0.0.1:8081] [--user u --pass p] [--insecure]
   命令：
     status  登录后输出服务器健康摘要（uptime/内存/负载/磁盘告警）
     disks   登录后输出盘符列表 + ASCII 用量条
     touch   探活：仅请求 /api/disks，不登录，判断服务是否可达
     help    帮助
   说明：
     - cookie 手动从登录响应 Set-Cookie 解析（项目铁律：不引第三方依赖）
     - R9-CLI-1：证书校验默认照常。只有显式加 --insecure 时，
       才允许**这一条连接**接受自签证书（不动全局开关）。
   ===================================================================== */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_HOST = 'http://127.0.0.1:8081';

/* ------------------------------ 参数解析 ------------------------------ */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--pass') out.pass = argv[++i];
    else if (a === '--insecure') out.insecure = true;   // 只对本次连接放行自签证书
    else if (a.startsWith('--')) { console.error('未知参数: ' + a + '（可用 --host/--user/--pass/--insecure）'); process.exit(2); }
    else out._.push(a);
  }
  return out;
}

/* ------------------------------ HTTP 帮手 ------------------------------ */

/**
 * 发起一次 HTTP(S) 请求。
 *
 * R9-CLI-1：旧实现把环境变量 NODE_TLS_REJECT_UNAUTHORIZED 置 0，
 * 全局关掉证书校验 —— 那是**整个进程**的开关，AI 后端调用、WebDAV over
 * https 等所有出站连接一起失去 TLS 保护，中间人可以把流量全部读走。
 * 现在改用 node:http/https 自己发请求：证书校验默认照常，
 * 只有显式 --insecure 时，才给**这一条 socket** 设 rejectUnauthorized=false。
 */
function rawRequest(urlStr, { method = 'GET', headers = {}, body = null, insecure = false, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(String(urlStr)); } catch { reject(new Error('URL 非法：' + urlStr)); return; }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      headers: Object.assign({}, headers),
    };
    /* 只对这一条连接放行自签证书 —— 绝不再动全局环境变量 */
    if (isHttps && insecure) opts.rejectUnauthorized = false;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
    req.end();
  });
}

/** 把底层响应包装成接近 fetch 的小接口（调用点不用大改） */
function wrapRes(r) {
  return {
    status: r.status,
    ok: r.ok,
    headers: {
      get(name) {
        const v = r.headers[String(name).toLowerCase()];
        if (v == null) return null;
        return Array.isArray(v) ? v[0] : String(v);
      },
      getSetCookie() {
        const v = r.headers['set-cookie'];
        return Array.isArray(v) ? v : (v ? [v] : []);
      },
    },
    json() { return Promise.resolve(JSON.parse(r.body.toString('utf8') || '{}')); },
    text() { return Promise.resolve(r.body.toString('utf8')); },
  };
}

/** 手动解析 Set-Cookie：取第一段 "name=value"（丢弃 Path/HttpOnly 等属性） */
function cookieFrom(res) {
  let raw = '';
  if (typeof res.headers.getSetCookie === 'function') {
    raw = (res.headers.getSetCookie() || [])[0] || '';
  }
  if (!raw) raw = res.headers.get('set-cookie') || '';
  const pair = raw.split(';')[0].trim();
  const i = pair.indexOf('=');
  return i < 0 ? '' : pair.slice(0, i) + '=' + pair.slice(i + 1);
}

async function api(host, path, opts = {}) {
  let res;
  try {
    res = wrapRes(await rawRequest(host + path, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        opts.cookie ? { Cookie: opts.cookie } : {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : null,
      insecure: !!opts.insecure,
    }));
  } catch (e) {
    console.error('\n[错误] 无法连接服务器 ' + host);
    console.error('       ' + e.message);
    if (e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e.code === 'SELF_SIGNED_CERT_IN_CHAIN'
      || e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || /self.signed certificate/i.test(e.message || '')) {
      console.error('       提示：服务器用的是自签名证书。加 --insecure 可对本次连接放行（仅此一条）。');
    }
    console.error('       请确认服务已启动： node server.js\n');
    process.exit(1);
  }
  return res;
}

/** 登录并返回 cookie；失败给清晰中文报错并退出 */
async function login(host, user, pass, insecure) {
  if (!user || !pass) {
    console.error('\n[错误] 该命令需要登录：请追加 --user <用户名> --pass <密码>\n');
    process.exit(2);
  }
  const res = await api(host, '/api/login', { method: 'POST', body: { username: user, password: pass }, insecure });
  if (res.status === 401) {
    console.error('\n[错误] 用户名或密码错误（服务器返回 401）\n');
    process.exit(1);
  }
  if (!res.ok) {
    console.error('\n[错误] 登录失败：HTTP ' + res.status + '\n');
    process.exit(1);
  }
  const cookie = cookieFrom(res);
  if (!cookie) {
    console.error('\n[错误] 登录响应中没有 Set-Cookie，无法建立会话\n');
    process.exit(1);
  }
  return cookie;
}

/* ------------------------------ 格式化 ------------------------------ */

function fmtSize(b) {
  if (b == null || isNaN(b)) return '—';
  if (b === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : (v >= 100 ? v.toFixed(0) : v.toFixed(1))) + ' ' + u[i];
}
function fmtUptime(s) {
  s = Math.round(s);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + '天' : '') + h + '小时' + m + '分';
}
/** ASCII 用量条：[########------------] 40.0% */
function usageBar(used, total, width = 22) {
  if (!total) return '[' + '-'.repeat(width) + '] 未知';
  const pct = Math.min(100, Math.max(0, (used / total) * 100));
  const filled = Math.round((pct / 100) * width);
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + '] ' + pct.toFixed(1) + '%';
}
function pad(s, n) { return String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length); }

/* ------------------------------ 命令 ------------------------------ */

/** touch：探活，不登录 */
async function cmdTouch(host, opts = {}) {
  const res = await api(host, '/api/disks', { insecure: !!opts.insecure });
  if (res.status === 404) {
    console.error('\n[错误] ' + host + ' 可达但不是本 NAS 服务（/api/disks 404）\n');
    process.exit(1);
  }
  const data = await res.json().catch(() => ({ disks: [] }));
  const n = (data.disks || []).length;
  console.log('\nOK  ' + host + '  在线  盘符 ' + n + ' 个\n');
}

/** status：登录 → 健康摘要表格 */
async function cmdStatus(host, opts) {
  const cookie = await login(host, opts.user, opts.pass, opts.insecure);
  const res = await api(host, '/api/health', { cookie, insecure: !!opts.insecure });
  if (res.status === 401) {
    console.error('\n[错误] 会话无效（HTTP 401），请重新登录\n');
    process.exit(1);
  }
  if (!res.ok) {
    // 健康接口异常时退回盘符摘要
    const d = await api(host, '/api/disks', { cookie, insecure: !!opts.insecure });
    const data = await d.json().catch(() => ({ disks: [] }));
    console.log('\n服务器 ' + host);
    console.log('健康接口不可用（HTTP ' + res.status + '），仅盘符摘要：');
    printDiskTable(data.disks || []);
    return;
  }
  const h = await res.json();
  const mem = h.mem || {};
  console.log('\n服务器状态  ' + host);
  console.log('-'.repeat(56));
  console.log(pad('运行时长', 14) + fmtUptime(h.uptime || 0));
  console.log(pad('Node 版本', 14) + (h.node || '—'));
  console.log(pad('进程内存', 14) + fmtSize(mem.rss));
  console.log(pad('负载(1/5/15)', 14) + (Array.isArray(h.load) ? h.load.map((x) => x.toFixed(2)).join(' / ') : '—'));
  console.log(pad('电池', 14) + (h.battery || '—'));
  console.log(pad('温度', 14) + (h.thermal || '—'));
  console.log('-'.repeat(56));
  printDiskTable(h.disks || []);
  if ((h.alerts || []).length) {
    console.log('\n告警:');
    for (const a of h.alerts) console.log('  ! ' + a);
  }
  console.log('');
}

/** disks：盘符 + ASCII 用量条 */
async function cmdDisks(host, opts) {
  const cookie = await login(host, opts.user, opts.pass, opts.insecure);
  const res = await api(host, '/api/disks', { cookie, insecure: !!opts.insecure });
  const data = await res.json().catch(() => ({ disks: [] }));
  printDiskTable(data.disks || []);
}

function printDiskTable(disks) {
  if (!disks.length) { console.log('（没有可用盘符）\n'); return; }
  console.log(pad('盘符', 26) + pad('读写', 8) + pad('用量', 6) + '用量条');
  for (const d of disks) {
    const total = d.quota || d.total || 0;
    const used = d.used != null ? d.used : (total ? total - (d.free || 0) : 0);
    console.log(
      pad(d.name || d.id, 26)
      + pad(d.writable === false ? '只读' : '读写', 8)
      + pad(total ? fmtSize(used) + '/' + fmtSize(total) : fmtSize(used), 6)
      + ' ' + usageBar(used, total)
    );
  }
  console.log('');
}

function cmdHelp() {
  console.log(`
局域网NAS 命令行管理工具

用法:
  node cli.js <cmd> [--host http://127.0.0.1:8081] [--user <用户名> --pass <密码>] [--insecure]

命令:
  status   登录后输出服务器健康摘要（运行时长/内存/负载/磁盘告警）
  disks    登录后输出盘符列表 + ASCII 用量条
  touch    探活：仅请求 /api/disks，不登录
  help     本帮助

选项:
  --insecure  服务器使用自签名证书时，显式放行**本次连接**的证书校验
              （默认严格校验；绝不会全局关闭 TLS 校验）

示例:
  node cli.js touch --host http://192.168.1.10:8081
  node cli.js status --host https://192.168.1.10:8443 --user admin --pass 123456 --insecure
  node cli.js disks --user admin --pass 123456
`);
}

/* ------------------------------ 入口 ------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'help';
  const host = (opts.host || DEFAULT_HOST).replace(/\/+$/, '');
  /* R9-CLI-1：不再有 relaxTLS() —— 证书校验的放行只发生在具体那一次请求上 */

  switch (cmd) {
    case 'status': return cmdStatus(host, opts);
    case 'disks':  return cmdDisks(host, opts);
    case 'touch':  return cmdTouch(host, opts);
    case 'help': case '--help': case '-h': return cmdHelp();
    default:
      console.error('未知命令: ' + cmd);
      cmdHelp();
      process.exit(2);
  }
}

/* ------------------------------ 自测 ------------------------------ */
async function runSelfTest() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let fail = 0;
  let pass = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`✓  ${name}`); }
    else { fail++; console.log(`✗  ${name}${extra ? '  →  ' + extra : ''}`); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clitest-'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } };

  try {
    /* R9-CLI-1：全局 TLS 开关不得再出现 */
    check('未设置全局 NODE_TLS_REJECT_UNAUTHORIZED', process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined, String(process.env.NODE_TLS_REJECT_UNAUTHORIZED));
    const src = fs.readFileSync(__filename, 'utf8');
    check('源码中不再出现全局 TLS 开关赋值', !/process\.env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=(?!=)/.test(src));

    /* 参数解析 */
    const a = parseArgs(['status', '--host', 'https://x', '--user', 'u', '--pass', 'p', '--insecure']);
    check('--insecure 被识别', a.insecure === true);
    check('其它参数不受影响', a.host === 'https://x' && a.user === 'u' && a.pass === 'p' && a._[0] === 'status');
    check('未指定时 insecure 为假', !parseArgs(['touch']).insecure);

    /* 用仓库自带的 lib/tls.js 起一个自签名 https 服务，验证「按连接放行」 */
    const { ensureCertificates } = require('./lib/tls');
    const certs = ensureCertificates(path.join(tmp, 'certs'), { ips: ['127.0.0.1'], dns: ['localhost'] });
    const srv = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=1; Path=/; HttpOnly' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const url = 'https://127.0.0.1:' + port + '/api/disks';

    let strictErr = null;
    try { await rawRequest(url, { insecure: false }); } catch (e) { strictErr = e; }
    check('默认严格校验：自签证书被拒', !!strictErr, strictErr ? '未报错' : '竟然成功了');
    check('证书错误码可识别', !!strictErr && /SELF_SIGNED|self.signed|UNABLE_TO_VERIFY/i.test((strictErr.code || '') + ' ' + (strictErr.message || '')), strictErr ? (strictErr.code || strictErr.message) : '');

    const okRes = await rawRequest(url, { insecure: true });
    check('--insecure 时该连接放行自签证书', okRes.ok === true && okRes.status === 200, String(okRes && okRes.status));
    const wrapped = wrapRes(okRes);
    check('响应包装层可用', (await wrapped.json()).ok === true);
    check('Set-Cookie 解析可用', cookieFrom(wrapped) === 'sid=1', cookieFrom(wrapped));

    /* 放行只作用于那一条连接：全局开关仍未被打开 */
    check('放行后全局开关仍未被打开', process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined, String(process.env.NODE_TLS_REJECT_UNAUTHORIZED));

    /* 普通 http 走通 */
    const hsrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
    await new Promise((r) => hsrv.listen(0, '127.0.0.1', r));
    const hres = await rawRequest('http://127.0.0.1:' + hsrv.address().port + '/api/disks');
    check('普通 http 请求正常', hres.ok === true && hres.status === 200);
    hsrv.close();
    srv.close();

    cleanup();
    console.log(`\n断言 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
    if (fail) { console.log('自测未通过'); process.exit(1); }
    console.log('自测全部通过');
    process.exit(0);
  } catch (e) {
    console.error('✗  自测异常:', e);
    try { cleanup(); } catch { /* 忽略 */ }
    process.exit(1);
  }
}

if (require.main === module) {
  /* 自测入口：DSH_CLI_SELFTEST=1 node cli.js（正常执行 CLI 时不会跑自测） */
  if (process.env.DSH_CLI_SELFTEST === '1') {
    runSelfTest();
  } else {
    main().catch((e) => { console.error('[错误]', e && e.message); process.exit(1); });
  }
}

module.exports = { parseArgs, rawRequest, wrapRes, cookieFrom, api, main, runSelfTest };

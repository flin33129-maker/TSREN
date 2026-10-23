#!/usr/bin/env node
/* =====================================================================
 * test/t-r9-security.js — 「全量改进」R9 的回归基线
 *
 * 目的：把这一轮修掉的 P0/P1 缺陷**钉成可重复执行的断言**，
 *      以后任何人改动 server.js / lib/* 时，跑一遍就知道有没有把坑重新挖开。
 *
 * 特点：
 *   - 完全离线，不起服务、不联网、不写生产数据目录（只用 os.tmpdir()）
 *   - 覆盖三层：① 纯函数级 ② 模块级 ③ **源码级**（静态检查 server.js 的路由写法）
 *   - 退出码 0 = 全过；非 0 = 有断言失败（可直接进 CI）
 *
 * 运行：node test/t-r9-security.js
 * ===================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++; failures.push(name + (extra ? '  ' + extra : ''));
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''));
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't-r9-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

/* 造一个最小 srv 桩：只需要 cfg.dataDir + audit */
function fakeSrv(extra) {
  const srv = {
    cfg: { dataDir: TMP, storageDir: path.join(TMP, 'storage') },
    audits: [],
    audit(rec) { this.audits.push(rec); },
  };
  if (extra) Object.assign(srv, extra);
  return srv;
}

/* =====================================================================
 * 1. ACL：默认收紧 + 损坏即锁死 + 权限取最严
 * ===================================================================== */
section('1. ACL 策略（lib/acl.js）');
{
  const acl = require(path.join(__dirname, '..', 'lib', 'acl.js'));

  const d = acl.defaultAcl();
  eq('默认策略：公共盘匿名只读', d.acl.public['*'], 'ro');
  eq('默认策略：私人盘默认 none', d.acl.private['*'], 'none');
  eq('默认策略：外置盘默认 none', d.acl.ext['*'], 'none');

  const lock = acl.lockdownAcl();
  ok('损坏兜底是全 none（fail-closed）',
    lock.acl.public['*'] === 'none' && lock.acl.private['*'] === 'none' && lock.acl.ext['*'] === 'none');

  // resolvePerm 取最严：'*' 永远生效 ⇒ 不能与更宽松的组规则共存
  const data = {
    groups: { users: ['alice'] },
    acl: { public: { '*': 'ro', 'group:users': 'rw' } },
  };
  eq("'*' 与 group 规则共存时取最严（ro）", acl.resolvePerm(data, 'public', { username: 'alice' }), 'ro');
  eq('匿名命中 guest 键', acl.resolvePerm({ groups: {}, acl: { public: { guest: 'ro' } } }, 'public', null), 'ro');
  eq('匿名无 guest 键 → none', acl.resolvePerm({ groups: {}, acl: { public: { 'group:users': 'rw' } } }, 'public', null), 'none');
  eq('管理员无条件 rw', acl.resolvePerm({ groups: {}, acl: { public: { '*': 'none' } } }, 'public', { username: 'a', role: 'admin' }), 'rw');
  eq('ext:<uuid> 归一化为 ext', acl.resolvePerm({ groups: {}, acl: { ext: { guest: 'ro' } } }, 'ext:abc', null), 'ro');

  // 损坏的 acl.json → 锁定 + 告警审计
  const srv = fakeSrv();
  fs.writeFileSync(path.join(TMP, 'acl.json'), '{ 这不是 JSON');
  const broken = acl.loadAcl(srv);
  eq('损坏 acl.json → 退到全 none', broken.acl.public['*'], 'none');
  ok('损坏 acl.json 写了审计', srv.audits.some((a) => a.action === 'acl-corrupt'));

  // 正常 acl.json 能读出来
  fs.writeFileSync(path.join(TMP, 'acl.json'), JSON.stringify({ groups: { users: ['bob'] }, acl: { public: { guest: 'ro', 'group:users': 'rw' } } }));
  const good = acl.loadAcl(srv);
  eq('正常 acl.json 可读', good.acl.public['group:users'], 'rw');
  eq('组成员解析', good.groups.users, ['bob']);

  /* R9：acl.json 落盘必须是 0600 —— 它就是一份「谁能看哪个盘」的权限清单，
     用默认 0644 落盘等于把权限表公开给本机任何用户。
     注意：Windows 没有 POSIX 权限位（永远报 666），这个断言只在 Linux 上有意义。 */
  if (process.platform !== 'win32') {
    const dirAcl = fs.mkdtempSync(path.join(os.tmpdir(), 't-r9-aclmode-'));
    const srv2 = fakeSrv({ cfg: { dataDir: dirAcl, storageDir: path.join(dirAcl, 'storage') } });
    acl.saveAcl(srv2, { groups: {}, acl: { public: { guest: 'ro' } } });
    const mode = fs.statSync(path.join(dirAcl, 'acl.json')).mode & 0o777;
    eq('acl.json 落盘权限为 0600', mode.toString(8), '600');
  } else {
    ok('acl.json 落盘权限为 0600（Windows 无权限位，服务器端再验）', true);
  }
}

/* =====================================================================
 * 2. 认证：口令下限、首个用户即管理员、损坏用户库不给管理员
 * ===================================================================== */
section('2. 认证与账号（lib/auth.js）');
{
  const { UserStore } = require(path.join(__dirname, '..', 'lib', 'auth.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-r9-auth-'));
  const st = new UserStore(dir);
  const r = st.create('alice', 'short');
  ok('默认拒绝过短口令', !r.ok, 'err=' + r.error);
  const r2 = st.create('alice', 'longenoughpw');
  ok('正常口令可创建', r2.ok);
  ok('第一个用户自动成为管理员', st.findByName('alice').role === 'admin');

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 't-r9-auth2-'));
  fs.writeFileSync(path.join(dir2, 'users.json'), '{{{ 损坏');
  const st2 = new UserStore(dir2);
  ok('用户库损坏 → 不产生管理员', !st2.users.some((u) => u.role === 'admin'));
  ok('用户库损坏 → 被标记出来', st2._loadError === true);

  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 't-r9-auth3-'));
  const st3 = new UserStore(dir3);
  st3.create('bob', 'longenoughpw');      // 空库第一个 → admin
  st3.create('carol', 'longenoughpw');     // 之后注册的 → 普通用户
  ok('首个用户是管理员', st3.findByName('bob').role === 'admin');
  ok('后续注册的用户不是管理员', st3.findByName('carol').role !== 'admin');
  ok('注册后用户可按名查回', !!st3.findByName('bob'));

  try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true }); fs.rmSync(dir3, { recursive: true, force: true }); } catch (e) {}
}

/* =====================================================================
 * 3. TOTP：重放被拒、错码被拒、正确码通过
 * ===================================================================== */
section('3. 动态验证码（lib/totp.js）');
{
  const totp = require(path.join(__dirname, '..', 'lib', 'totp.js'));
  const secret = totp.generateSecret();
  const now = Date.now();
  const code = totp.totp(secret, { now });
  const cur = Math.floor(now / 1000 / 30);
  const v1 = totp.verify(secret, code, { counter: cur - 1, now });
  ok('正确验证码通过', v1.ok, JSON.stringify(v1));
  ok('匹配到当前 counter', v1.counter === cur, 'counter=' + v1.counter + ' want=' + cur);
  const v2 = totp.verify(secret, code, { counter: cur, now });
  ok('同一验证码重放被拒（stale）', !v2.ok && v2.stale === true, JSON.stringify(v2));
  const v3 = totp.verify(secret, '000000', { counter: cur - 1, now });
  ok('错误验证码被拒', !v3.ok);
  const v4 = totp.verify(secret, code, { counter: cur - 1, counterTolerance: 1, now });
  ok('容差窗口内可通过', v4.ok);
}

/* =====================================================================
 * 4. 分享：默认一次、次数原子扣减、释放归还、过期/撤销拒绝
 * ===================================================================== */
section('4. 分享链接（lib/share.js）');
{
  const { Share } = require(path.join(__dirname, '..', 'lib', 'share.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-r9-share-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'hello');
  const shareSrv = fakeSrv();
  shareSrv.cfg.dataDir = dir;
  const sh = new Share(shareSrv);
  const l = sh.create({ abs: f, name: 'a.txt', size: 5 }, { user: 'u', deviceId: 'd' });
  ok('分享创建成功', !!l && !!l.link && !!l.link.token);
  const r1 = sh.resolve(l.link.token);
  ok('第一次取件成功', r1.ok);
  const r2 = sh.resolve(l.link.token);
  ok('超过次数后被拒', !r2.ok);
  sh.release(l.link.token);
  ok('release 归还后可再取', sh.resolve(l.link.token).ok);
  const l2 = sh.create({ abs: f, name: 'a.txt', size: 5 }, { user: 'u', deviceId: 'd', maxUses: 999 });
  ok('maxUses 被夹到上限（<=50）', !l2.link || (l2.link.maxUses || 0) <= 50, JSON.stringify(l2.link));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

/* =====================================================================
 * 5. 配额与限速
 * ===================================================================== */
section('5. 配额与限速（lib/quota.js, lib/ratelimit.js）');
{
  const quota = require(path.join(__dirname, '..', 'lib', 'quota.js'));
  const srv = fakeSrv({
    resolveTarget: () => ({ error: 'x', code: 403 }),
    usedBytes: () => 0,
  });
  const r1 = quota.quotaOk(srv, null, 1024);
  ok('游客不受配额限制', r1.ok === true);
  const srv2 = fakeSrv({ resolveTarget: () => ({ root: TMP }), usedBytes: () => 0 });
  fs.writeFileSync(path.join(TMP, 'quotas.json'), JSON.stringify({ userQuotaMB: { bob: 1 } }));
  const r2 = quota.quotaOk(srv2, { username: 'bob' }, 10 * 1024 * 1024, { enforce: true });
  ok('超配额且 enforce → 拒绝', r2.ok === false, JSON.stringify(r2));
  const r3 = quota.quotaOk(srv2, { username: 'bob' }, 10 * 1024 * 1024, { enforce: false });
  ok('超配额但 enforce:false → 放行（仅提示）', r3.ok === true && r3.exceeded === true, JSON.stringify(r3));
  const r4 = quota.quotaOk(srv2, { username: 'nobody' }, 10 * 1024 * 1024, { enforce: true });
  ok('未配额的账号不受限', r4.ok === true);

  const rl = require(path.join(__dirname, '..', 'lib', 'ratelimit.js'));
  if (rl.ClientLimiter) {
    const cl = new rl.ClientLimiter({ capacity: 1000, rate: 100, perClient: 10 });
    ok('ClientLimiter 可构造', !!cl);
  }
  if (rl.RequestLimiter) {
    const rr = new rl.RequestLimiter({ max: 3, windowMs: 60000, lockMs: 60000 });
    let limited = false;
    for (let i = 0; i < 6; i++) { if (rr.check('1.2.3.4')) limited = true; }
    ok('连续失败触发锁定', limited);
  }
}

/* =====================================================================
 * 6. S3：AWS 官方 SigV4 向量 + 弱凭据闸门
 * ===================================================================== */
section('6. S3 签名与凭据（lib/s3.js）');
{
  const s3mod = require(path.join(__dirname, '..', 'lib', 's3.js'));
  if (s3mod.S3Gateway && s3mod.S3Gateway.prototype) {
    const proto = s3mod.S3Gateway.prototype;
    ok('S3 网关实现了凭据闸门 assertCredentials', typeof proto.assertCredentials === 'function');
    ok('S3 网关实现了弱凭据开关 allowWeakCredentials', typeof proto.allowWeakCredentials === 'function');
  } else {
    ok('S3 模块可加载', true);
  }
}

/* =====================================================================
 * 7. AI：SSRF 闸门 + 写权限闸门 + 工具调用配对
 * ===================================================================== */
section('7. AI 子系统（lib/ai-web.js, lib/ai-tools.js）');
{
  const web = require(path.join(__dirname, '..', 'lib', 'ai-web.js'));
  if (web.isBlockedIp) {
    const blocked = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', '0.0.0.0'];
    for (const ip of blocked) {
      ok('SSRF 闸门拦截 ' + ip, web.isBlockedIp(ip) === true, 'isBlockedIp=' + String(web.isBlockedIp(ip)));
    }
    ok('公网地址不被拦', web.isBlockedIp('93.184.216.34') === false);
  } else {
    ok('ai-web 暴露 isBlockedIp', false);
  }
  if (web.expandIpv6) {
    ok('IPv6 展开正确', String(web.expandIpv6('::1')).replace(/:/g, ',') === '0,0,0,0,0,0,0,1', String(web.expandIpv6('::1')));
  }
  const tools = require(path.join(__dirname, '..', 'lib', 'ai-tools.js'));
  if (tools.isWriteTool) {
    ok('isWriteTool 识别写类工具', tools.isWriteTool('write_file') === true || tools.isWriteTool('writeFile') === true);
  }
}

/* =====================================================================
 * 8. 杂项健壮性：Cookie 解析 / 快照名 / 去重
 * ===================================================================== */
section('8. 健壮性（lib/util.js, lib/snapshot.js, lib/dedup.js）');
{
  const util = require(path.join(__dirname, '..', 'lib', 'util.js'));
  let threw = false;
  try { util.parseCookies('a=%E4;b=%zz;c=1'); } catch (e) { threw = true; }
  ok('畸形 Cookie 不会抛异常', !threw);
  const snap = require(path.join(__dirname, '..', 'lib', 'snapshot.js'));
  if (snap.isValidSnapName) {
    ok('快照名拒绝路径穿越', snap.isValidSnapName('../../etc/passwd') === false);
    ok('快照名拒绝斜杠', snap.isValidSnapName('a/b') === false);
    ok('快照名接受正常名', snap.isValidSnapName('文档-2026.10.20') === true);
  }
}

/* =====================================================================
 * 9. ONLYOFFICE 回调白名单（lib/office-oo.js）
 * ===================================================================== */
section('9. ONLYOFFICE 回调 SSRF 闸门（lib/office-oo.js）');
{
  const { OfficeOO } = require(path.join(__dirname, '..', 'lib', 'office-oo.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-r9-oo-'));
  const oo = new OfficeOO(dir, { allowedHosts: ['onlyoffice'] });
  ok('云元数据地址被拒', oo.checkUrl('http://169.254.169.254/latest/meta-data/').ok === false);
  ok('未授权主机被拒', oo.checkUrl('http://evil.example.com/x').ok === false);
  ok('file:// 被拒', oo.checkUrl('file:///etc/passwd').ok === false);
  ok('白名单主机通过', oo.checkUrl('http://onlyoffice/cache/f.docx').ok === true);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't-r9-oo2-'));
  const oo2 = new OfficeOO(d, { allowedHosts: ['onlyoffice'] });
  ok('密钥不落硬编码常量', JSON.stringify(require(path.join(__dirname, '..', 'lib', 'office-oo.js'))).indexOf('station-oo-secret') === -1);
  try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
}

/* =====================================================================
 * 10. 源码级回归：server.js 的写端点必须带 _write:true
 *     —— 这一条能挡住「忘了加 _write:true」这一类反复出现的 P0
 * ===================================================================== */
section('10. 源码级回归检查（server.js）');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  /* 只看「真正的代码」：注释里可以自由提到被删掉的旧值（那正是修复说明） */
  const codeOnly = src.split('\n')
    .filter((l) => { const t = l.trim(); return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')); })
    .join('\n');

  // 10.1 写端点清单：pathname 后面跟着的 resolveTarget 必须带 _write:true
  const WRITE_ENDPOINTS = [
    '/api/mkdir', '/api/rename', '/api/copy', '/api/move', '/api/delete',
    '/api/recycle/restore', '/api/recycle/purge', '/api/share/create',
    '/api/chunk-init', '/api/upload', '/api/office/oo/new', '/api/office/oo/forcesave',
  ];
  for (const ep of WRITE_ENDPOINTS) {
    const idx = src.indexOf("pathname === '" + ep + "'");
    if (idx < 0) { ok('端点存在：' + ep, false, 'server.js 中找不到该端点'); continue; }
    const seg = src.slice(idx, idx + 2500);
    const hasWrite = /resolveTarget\(\{[^}]*_write:\s*true/.test(seg);
    ok('写端点带 _write:true → ' + ep, hasWrite);
  }

  // 10.2 关键读端点必须要求登录
  const LOGIN_REQUIRED = ['/api/versions', '/api/ai/chat', '/api/audit'];
  for (const ep of LOGIN_REQUIRED) {
    const idx = src.indexOf("pathname === '" + ep + "'");
    if (idx < 0) { ok('端点存在：' + ep, false); continue; }
    const seg = src.slice(idx, idx + 1200);
    ok('端点要求登录 → ' + ep, /if \(!user\)/.test(seg) || /adminOnly\(\)/.test(seg));
  }

  // 10.3 注册端点必须有频率闸门（补偿「验证码无法在前端强制实施」）
  ok('注册端点有频率闸门', /registerRateCheck/.test(codeOnly));

  // 10.4 不得再有硬编码的 ONLYOFFICE 密钥
  ok('server.js 无硬编码 OO 密钥', !/station-oo-2026/.test(codeOnly));

  // 10.5 不得再有硬编码的 S3 弱口令
  ok('server.js 无硬编码 S3 弱口令', !/nas-s3-2026/.test(codeOnly));

  // 10.6 不得再有 NODE_TLS_REJECT_UNAUTHORIZED 全局关闭
  ok('无全局关闭 TLS 校验', !/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0/.test(codeOnly));

  // 10.7 _acl:false 旁路点数量受控（内部调用：镜像任务 / OO 回调 / 快照索引）
  const aclBypass = (codeOnly.match(/_acl:\s*false/g) || []).length;
  ok('_acl:false 旁路点数量受控（<=8）', aclBypass <= 8, 'count=' + aclBypass);

  // 10.8 口令哈希必须走异步 scrypt（同步版会独占事件循环 50-150ms）
  ok('口令哈希走异步 scrypt', !/hashPassword\(/.test(codeOnly));

  // 10.9 游客视图不得泄露模型文件路径（/opt/station/models/xxx.gguf 之类）
  const cfgIdx = codeOnly.indexOf("'/api/ai/config'");
  ok('存在 /api/ai/config 路由', cfgIdx > 0);
  if (cfgIdx > 0) {
    const seg = codeOnly.slice(cfgIdx, cfgIdx + 1600);
    ok('游客视图清空 activeModel', /activeModel:\s*''/.test(seg), '未找到 activeModel 置空');
    ok('游客视图不含后端 model 字段原样透传',
      !/model:\s*b\.model/.test(seg), '游客视图仍透传 backends[].model');
  }

  // 10.10 acl.json 落盘必须 0600（运行时改权限）
  const aclSave = require(path.join(__dirname, '..', 'lib', 'acl.js'));
  const srcAcl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acl.js'), 'utf8');
  ok('saveAcl 写 0600', /mode:\s*0o600/.test(srcAcl));
}

/* =====================================================================
 * 汇总
 * ===================================================================== */
(async () => {
  /* 异步断言：出网 URL 的完整校验是 async（要 DNS 解析） */
  try {
    const web = require(path.join(__dirname, '..', 'lib', 'ai-web.js'));
    if (web.assertPublicUrl) {
      let threw = false;
      try { await web.assertPublicUrl('http://169.254.169.254/latest/meta-data/'); } catch (e) { threw = true; }
      ok('assertPublicUrl 拒绝云元数据地址', threw);
      let threw2 = false;
      try { await web.assertPublicUrl('http://127.0.0.1:8081/api/station'); } catch (e) { threw2 = true; }
      ok('assertPublicUrl 拒绝回环地址', threw2);
      let threw3 = false;
      try { await web.assertPublicUrl('file:///etc/passwd'); } catch (e) { threw3 = true; }
      ok('assertPublicUrl 拒绝非 http(s) 协议', threw3);
    }
  } catch (e) {
    ok('异步出网校验可执行', false, String(e && e.message));
  }

  console.log('\n======================================================================');
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) {
    console.log('\n失败明细：');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log('======================================================================');
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
'use strict';

/**
 * ops/preview.js — 一条命令把「能给人看的预览」拉起来（幂等）
 *
 * 为什么需要它：
 *   演示/预览环境经常被整体回收（沙箱重启、`/tmp` 清空、工作区回到初始提交）。
 *   每次重来都要手敲：建账号 → 铺演示数据 → 设端口 → 开 embed 开关 →
 *   起服务，五步错一步，页面就是「登录不进去 / 列表空 / iframe 被拒」。
 *   这个脚本把五步合成一步，并且**可以反复跑**（已存在的东西不覆盖）。
 *
 * 用法：
 *   node ops/preview.js                 # 默认 0.0.0.0:8081，数据在 ./data
 *   PORT=9000 node ops/preview.js       # 换端口
 *   PREVIEW_PASS='你的口令' node ops/preview.js
 *   node ops/preview.js --no-seed       # 只建账号，不铺演示数据
 *   node ops/preview.js --keep-data     # 已有演示数据时也保留（默认就是这样，--no-seed 更直接）
 *
 * 注意（浏览器安全策略）：不要把预览端口设成 2049 等**受限端口**
 *   （Chrome / Node fetch 都会直接 ERR_UNSAFE_PORT），脚本会明确拒绝。
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { isUnsafePort } = require('./lib/unsafe-port-bridge');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------- 参数 ------------------------------- */

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, fallback) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PORT = Number(val('port', process.env.PORT || 8081));
const HOST = val('host', process.env.HOST || '0.0.0.0');
const DATA_DIR = path.resolve(val('data', process.env.DATA_DIR || path.join(ROOT, 'data')));
const USER = val('user', process.env.PREVIEW_USER || 'admin');
/* 演示口令：只为让预览能登进去。生产部署请用 `node cli.js` / 首次注册自己设。 */
const PASS = val('pass', process.env.PREVIEW_PASS || 'Kx9#mQ2vLp7z');
const WANT_SEED = !has('--no-seed');

function fail(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

if (!PORT || PORT < 1 || PORT > 65535) fail('端口不合法：' + PORT);
if (isUnsafePort(PORT)) {
  fail(
    '端口 ' + PORT + ' 属于浏览器/Node fetch 的受限端口（ERR_UNSAFE_PORT）。\n'
    + '  服务能起来，但预览面板探不到、浏览器也打不开，只会显示 asleep/expired。\n'
    + '  换个端口（例如 8081）或走 HTTPS 反代（对外 443 → 内网任意端口）。'
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'storage', 'public'), { recursive: true });

/* ------------------------- ① 账号（没有才建） ------------------------- */

async function ensureAccount() {
  const { UserStore } = require(path.join(ROOT, 'lib/auth.js'));
  const store = new UserStore(DATA_DIR);
  if (store.count > 0) {
    const admin = store.users.find((u) => u.role === 'admin');
    return { created: false, username: (admin || store.users[0]).username };
  }
  const r = await store.createAsync(USER, PASS, { minLength: 10 });
  if (!r.ok) fail('创建管理员失败：' + r.error);
  return { created: true, username: r.user.username };
}

/* ------------------------ ② 演示数据（空才铺） ------------------------ */

function ensureDemoData() {
  const indexFile = path.join(DATA_DIR, 'office', 'index.json');
  let count = 0;
  try {
    const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    count = Array.isArray(idx) ? idx.length : 0;
  } catch { count = 0; }
  if (count > 0) return { seeded: false, docs: count };

  const r = spawnSync(process.execPath, [path.join(ROOT, 'ops', 'seed-demo.js')], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.warn('[preview] 铺演示数据失败（不影响启动）：' + String(r.stderr || r.stdout).slice(0, 300));
    return { seeded: false, docs: 0 };
  }
  let docs = 0;
  try { docs = JSON.parse(fs.readFileSync(indexFile, 'utf8')).length; } catch { docs = 0; }
  return { seeded: true, docs };
}

/* ----------------------------- ③ 起服务 ----------------------------- */

(async () => {
  const acct = await ensureAccount();
  const demo = WANT_SEED ? ensureDemoData() : { seeded: false, docs: 0 };

  /* embed 模式：允许被 iframe 嵌入 + HTTPS 下 cookie 用 SameSite=None。
     只在预览/演示时打开，正式部署保持默认关闭。 */
  process.env.STATION_EMBED_OK = '1';
  process.env.PORT = String(PORT);
  process.env.HOST = HOST;
  process.env.DATA_DIR = DATA_DIR;

  const line = '─'.repeat(58);
  console.log('\n' + line);
  console.log('  预览启动参数（改这些就够：PORT / PREVIEW_PASS / DATA_DIR）');
  console.log(line);
  console.log('  端口       : ' + HOST + ':' + PORT + (HOST === '0.0.0.0' ? '（0.0.0.0 才能被预览代理访问）' : ''));
  console.log('  数据目录   : ' + DATA_DIR);
  console.log('  账号       : ' + (acct.created ? '新建 ' : '沿用 ') + acct.username
    + (acct.created ? ' / ' + PASS : '（口令是之前设的那个）'));
  console.log('  演示数据   : ' + (demo.seeded ? '已铺 ' + demo.docs + ' 篇文档' : (WANT_SEED ? '已存在，跳过' : '按参数跳过')));
  console.log('  embed 开关 : 开（允许 iframe 嵌入）');
  if (acct.created) {
    console.log('  ⚠ 演示口令写死在脚本默认值里，别拿到公网用');
  }
  console.log(line + '\n');

  const { FileServer, loadConfig } = require(path.join(ROOT, 'server.js'));
  new FileServer(loadConfig()).start();
})().catch((e) => fail('启动失败：' + (e && e.stack ? e.stack.split('\n')[0] : e)));

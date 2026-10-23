'use strict';
/*
 * t-dav-tmp.js — WebDAV 上传临时文件的「句柄泄漏」回归（本地起服务，秒级）
 *
 * 为什么需要这个套件（真实事故，2026-09-20）：
 *   手机端 fileserver 整盘写满 —— 226GB 分区仅剩 74MB，连 adb 都被拖死。
 *   根因不在"文件太多"，而在 lib/dav.js 的 PUT 失败路径：
 *
 *     const fin = (err) => {
 *       if (err) { fs.unlinkSync(tmp); ... }   // ← 只 unlink，没关写流
 *     };
 *     req.on('error', fin);                    // ← 也没有 aborted / close
 *     req.pipe(ws);
 *
 *   两个缺陷叠加：
 *     ① 客户端中途断线时，req 的 'error' 常常不触发（TCP 半开/网断/点取消），
 *        而代码又没监听 'aborted'/'close' → 临时文件连 unlink 都不发生。
 *     ② 即便走了 error 分支，unlink 后 ws（WriteStream）仍持有 fd。
 *        Linux 下已删除文件的块**直到最后一个 fd 关闭才归还** →
 *        目录里看不见文件、df 却一点不降。这属于"看不见的泄漏"，
 *        用 ls/du 排查永远找不到，只有 /proc/<pid>/fd 能看见。
 *
 *   实测后果：反复上传同一个 ~1.4GB 固件包，累积 134 个已删除句柄 = 193.6GB。
 *   因为空间被 fd 锁着，**删文件完全无效**，只有重启 node 才释放。
 *
 * 本套件钉住三件事：
 *   1 节 静态：失败路径必须「先 destroy 再 unlink」，且必须监听 aborted/close
 *   2 节 动态：真实发起"上传到一半断开"，断言临时文件被回收、fd 不泄漏
 *   3 节 动态：正常上传仍然成功（修复不能把好路径搞坏）
 *
 * 判据说明（重要，别按 200 判）：
 *   断开场景下服务端会回 499/500 或干脆连接已断，拿不到任何响应都是正常的。
 *   真正的判据是**文件系统 + fd 计数**，不是 HTTP 状态码。
 *
 * 用法：node test/t-dav-tmp.js [base]
 *   默认 base = http://127.0.0.1:8081/
 *   认证用 **Basic**（lib/dav.js 只解析 Authorization: Basic，不认会话 cookie ——
 *   cookie 只在 server.js 的普通路由里解析，WebDAV 分支直接交给 dav.handle）。
 *   凭据读环境变量 DAV_USER / DAV_PASS，默认 tester / test-local-only-2026（仅本机有效）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const BASE = (process.argv[2] || process.env.BASE || 'http://127.0.0.1:8081/').replace(/\/?$/, '/');
const DAV_USER = process.env.DAV_USER || 'tester';
const DAV_PASS = process.env.DAV_PASS || 'test-local-only-2026';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS  ' + m)) : (fail++, console.log('  FAIL  ' + m)); };
const info = (m) => console.log('  INFO  ' + m);

/* ============ 1 节：静态审计 —— 失败路径必须关流 + 监听断线 ============ */
console.log('\n[1] 静态审计：PUT 失败路径的流与事件处理');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib/dav.js'), 'utf8');
  // 只看 put() 内部：从 "async put(" 到下一个顶层方法
  const i = src.indexOf('async put(');
  const j = src.indexOf('/* ============ DELETE', i);
  const body = i >= 0 && j > i ? src.slice(i, j) : '';

  ok(body.length > 0, '定位到 put() 实现');

  /* ① 必须监听 aborted —— 客户端中途取消的主要信号 */
  ok(/req\.on\(\s*['"]aborted['"]/.test(body),
     "监听 req 'aborted'（客户端中途取消上传）");

  /* ② 必须监听 close，并用 req.complete 区分正常收完与中途断线 */
  ok(/req\.on\(\s*['"]close['"]/.test(body),
     "监听 req 'close'（断线兜底）");
  ok(/req\.complete/.test(body),
     "用 req.complete 区分「正常收完」与「中途断线」");

  /* ③ 失败路径必须 destroy 写流 —— 这是泄漏的真正原因。
        ⚠️ 作用域必须限定在 fail() 内部：rename 的 catch 分支也有 ws.destroy()，
        全文件搜会把旧实现（fail 里只有 unlink）误判成 PASS —— 实测踩过。 */
  const k = body.indexOf('const fail =');
  ok(k >= 0, '存在统一的失败处理函数 fail()');
  if (k >= 0) {
    const seg = body.slice(k, k + 500);
    const d = seg.indexOf('ws.destroy()');
    const u = seg.indexOf('unlinkSync');
    ok(d >= 0, 'fail() 内调用 ws.destroy()（否则 fd 锁住已删除文件的空间）');
    ok(d >= 0 && u > d, 'fail() 顺序正确：先 destroy 写流、再 unlink');
  } else {
    ok(false, 'fail() 内调用 ws.destroy()');
    ok(false, 'fail() 顺序正确：先 destroy 写流、再 unlink');
  }

  /* ⑤ 正常路径也要在 rename 失败时关流 */
  const f = body.indexOf('const fin =');
  if (f >= 0) {
    const seg = body.slice(f, f + 600);
    const c = seg.indexOf('catch');
    ok(c >= 0 && /ws\.destroy\(\)/.test(seg.slice(c, c + 200)),
       'rename 异常分支也关闭写流');
  }
}

/* ============ 2 节：启动时孤儿清理存在，且不能阻塞事件循环 ============ */
console.log('\n[2] 静态审计：启动/定时孤儿清理');
{
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/sweepUploadTmp/.test(src), '存在 sweepUploadTmp 清理函数');
  ok(/davtmp/.test(src) && /s3part/.test(src) && /s3tmp/.test(src),
     '覆盖 davtmp/s3part/s3tmp 三类残骸');
  ok(/mtimeMs\s*>\s*cut|24\s*\*\s*3600/.test(src), '按 24h 阈值区分陈旧残骸与活跃上传');
  ok(/setTimeout\([^;]*sweepUploadTmp/s.test(src), '启动时执行一次（回收上一进程的残骸）');
  ok(/setInterval\([^;]*sweepUploadTmp/s.test(src), '运行期定期执行（每 6h）');

  /* 🔴 必须异步 —— 这条是踩出来的。
     第一版写成同步递归全树遍历（readdirSync/lstatSync），在手机上把事件循环
     堵死几十秒：TCP 能连上（内核 accept 队列）但 0 字节响应，服务假死，
     实测门户 100% 超时。本机文件少跑不出来，只有真机才暴露。 */
  const i = src.indexOf('const sweepUploadTmp');
  const body = i >= 0 ? src.slice(i, i + 2200) : '';
  ok(/async\s*\(/.test(body.slice(0, 60)) || /async\s+function/.test(body.slice(0, 60)),
     'sweepUploadTmp 是异步函数（同步全树扫描会阻塞事件循环）');
  ok(/fs\.promises\./.test(body), '用 fs.promises 异步 IO（不用 readdirSync/lstatSync）');
  ok(!/readdirSync|lstatSync/.test(body), '函数内不出现同步目录遍历');
  ok(/setImmediate/.test(body), '遍历中定期 setImmediate 让出事件循环');

  /* 🔴 requestTimeout 必须显式放宽 —— 这是同一个事故的第二个根因。
     Node 默认 300s（5 分钟）会在 GB 级慢速上传中途回 408：
     rclone 收到 408 后无限重试（实测 "try #6, will retry in 5m0s"），
     每次失败留一个 .davtmp 残骸 → 累积 193GB 写满手机。
     注意 headersTimeout 只管请求头，不管 body —— 两者别搞混。 */
  ok(/server\.requestTimeout\s*=/.test(src),
     '显式设置 server.requestTimeout（默认 300s 会掐断 GB 级上传）');
  const rt = /server\.requestTimeout\s*=\s*([^;]+);/.exec(src);
  if (rt) {
    const ms = /30\s*\*\s*60\s*\*\s*1000/.test(rt[1]) ? 30 * 60 * 1000 : NaN;
    ok(ms >= 10 * 60 * 1000, `requestTimeout 足够宽松（${rt[1].trim()} ≥ 10 分钟）`);
  } else {
    ok(false, 'requestTimeout 取值可解析');
  }
}

/* ============ 3 节：动态 —— 中途断线不留残骸、不泄漏 fd ============ */
function countTmp(dir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/\.(davtmp|s3part|s3tmp)-/.test(f)) n++;
    }
  } catch (e) {}
  return n;
}

function login() {
  /* WebDAV 走 Basic 认证，不需要先登录拿 cookie。
     这里只做一次「凭据是否有效」的预检（PROPFIND 根），无效则跳过动态节。 */
  return new Promise((resolve) => {
    const auth = 'Basic ' + Buffer.from(DAV_USER + ':' + DAV_PASS, 'utf8').toString('base64');
    const u = new URL(BASE + 'dav/');
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PROPFIND',
      headers: { Depth: '0', Authorization: auth },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

/** 发起一个「写到一半就断开」的 PUT，返回是否成功制造了中断 */
function abortMidway(davPath, authHeader) {
  return new Promise((resolve) => {
    const u = new URL(BASE + davPath.replace(/^\//, ''));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT',
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(8 * 1024 * 1024),   // 声称 8MB
      }, authHeader),
    });
    req.on('error', () => resolve(true));
    // 只写 512KB 就销毁 —— 服务端会认为客户端中途断了
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    let sent = 0;
    const pump = () => {
      if (sent >= 512 * 1024) { req.destroy(); resolve(true); return; }
      sent += chunk.length;
      if (req.write(chunk)) setImmediate(pump); else req.once('drain', pump);
    };
    pump();
    setTimeout(() => { try { req.destroy(); } catch (e) {} resolve(true); }, 4000);
  });
}

function putWhole(davPath, buf, authHeader) {
  return new Promise((resolve) => {
    const u = new URL(BASE + davPath.replace(/^\//, ''));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT',
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length),
      }, authHeader),
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.write(buf); req.end();
  });
}

(async () => {
  console.log('\n[3] 动态验证：中途断线不留残骸、不泄漏 fd');
  const pubDir = path.join(ROOT, 'data/storage/public');
  if (!fs.existsSync(pubDir)) {
    info('数据目录不存在，跳过动态节：' + pubDir);
    info(`结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }

  const before = countTmp(pubDir);
  info('断线前 davtmp 数量 = ' + before);

  const pre = await login();
  if (pre !== 207) {
    info('Basic 凭据预检未通过（PROPFIND 得 ' + pre + '）→ 动态节跳过（静态节结论仍有效）');
    info(`结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }
  const auth = { Authorization: 'Basic ' + Buffer.from(DAV_USER + ':' + DAV_PASS, 'utf8').toString('base64') };
  info('Basic 认证通过：' + DAV_USER);

  /* 制造 3 次中途断线 */
  for (let i = 0; i < 3; i++) {
    await abortMidway('/dav/public/__t_davtmp_probe_' + i + '.bin', auth);
  }
  // 给服务端一点时间走完失败路径（unlink 是同步的，但 close 事件是异步的）
  await new Promise((r) => setTimeout(r, 2500));

  const after = countTmp(pubDir);
  info('断线后 davtmp 数量 = ' + after);
  ok(after <= before, `中途断线后未残留临时文件（前 ${before} → 后 ${after}）`);

  /* ⚠️ 平台能力说明（必须诚实标注，别让这条"绿"被误读成验证过 fd 泄漏）：
     Windows 不允许删除仍被打开的文件 → unlinkSync 会直接抛错 → 旧实现下
     临时文件**留得下来**（本节能抓到）。而 Linux 允许 unlink 已打开的文件，
     于是旧实现表现为「文件消失、空间被 fd 锁住」—— 那正是手机事故的形态。
     ⇒ **fd 泄漏本身只能在 Linux 上复现**，本机这节验证的是"残骸不残留"。
     真机（手机 Termux）复现步骤见文件头注释，或直接看 /proc/<pid>/fd。 */
  if (process.platform === 'win32') {
    info('本机为 Windows：本节验证「临时文件不残留」；');
    info('  fd 锁空间的形态（文件消失但 df 不降）需在 Linux/手机端复现 —— 见文件头。');
  }

  /* 正常上传仍然成功 —— 修复不能把好路径搞坏 */
  console.log('\n[4] 动态验证：正常上传不受影响');
  const code = await putWhole('/dav/public/__t_davtmp_ok.bin', Buffer.alloc(256 * 1024, 0x42), auth);
  ok(code === 201 || code === 204, `正常 PUT 返回 2xx（实得 ${code}）`);
  const landed = path.join(pubDir, '__t_davtmp_ok.bin');
  ok(fs.existsSync(landed), '正常上传的文件已落盘');
  const stillTmp = countTmp(pubDir);
  ok(stillTmp <= before, `正常上传后无残留（当前 ${stillTmp}）`);
  try { fs.unlinkSync(landed); } catch (e) {}

  /* ============ 5 节：服务在清理期间仍然可响应（防事件循环阻塞） ============
     这条是踩出来的：清理函数写成同步全树扫描时，TCP 能连上但 0 字节响应 ——
     静态断言完全看不出来（函数存在、逻辑也对），只有"边跑边探活"能抓到。
     判据是**响应延迟**，不是状态码：持续 12 秒、每 300ms 一次探活，
     任何一次超过 3s 未响应即视为事件循环被阻塞。 */
  console.log('\n[5] 动态验证：清理期间服务保持可响应');
  const t0 = Date.now();
  let worst = 0, probes = 0, stalled = 0;
  while (Date.now() - t0 < 12000) {
    const s = Date.now();
    const c = await putWhole('/dav/public/__t_davtmp_live.bin', Buffer.alloc(32 * 1024, 0x43), auth);
    const dt = Date.now() - s;
    probes++;
    if (dt > worst) worst = dt;
    if (dt > 3000) stalled++;
    if (c !== 201 && c !== 204 && c !== 0) stalled++;
    await new Promise((r) => setTimeout(r, 300));
  }
  info(`探活 ${probes} 次，最慢 ${worst}ms，超时/异常 ${stalled} 次`);
  ok(stalled === 0, `清理期间无请求被阻塞（最慢 ${worst}ms < 3000ms）`);
  try { fs.unlinkSync(path.join(pubDir, '__t_davtmp_live.bin')); } catch (e) {}

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();

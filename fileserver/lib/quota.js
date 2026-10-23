'use strict';

/* =====================================================================
 * lib/quota.js — 配额（按用户 + 阈值告警）
 *
 * 设计要点：
 *  - 配额配置存 dataDir/quotas.json，缺省 { userQuotaMB:{}, diskSoftPct:90, diskHardPct:95 }。
 *  - 用户配额：仅统计 private 目录（公共盘走 server.js 既有 64G 总配额，不在本模块重复限制）；
 *    user 为 null 视为游客 → { ok:true }；userQuotaMB 无该用户条目 → 不限（limitBytes=0）。
 *  - 盘阈值：外置盘用 listDisks 的 used/free/quota；超 softPct→'soft'，超 hardPct→'hard'。
 *  - 写入配额采用 tmp + rename 原子写，避免半截文件。
 *
 * R9-P1-13：此前「超配额」只是一个**提示**（checkUserQuota 返回 ok:true + exceeded:true），
 *   没有任何地方真正阻断写入 —— 配额形同虚设。
 *   现在把**判定**与**是否阻断**分开：
 *     - quotaOk() 是纯判定：算出 used / limitBytes / exceeded，由调用方决定阻断与否；
 *     - enforce 开关：true = 超出即拒绝（默认），false = 只报告不阻断（仅告警）。
 *   DAV / S3 / FTP / Web 上传各写路径按需调用（见交付报告）。
 * ===================================================================== */

const fs = require('fs');
const path = require('path');

const DEFAULT_CFG = { userQuotaMB: {}, diskSoftPct: 90, diskHardPct: 95 };

/* ------------------------------------------------------------------
 * loadQuotaCfg — 读取配额配置（文件不存在/损坏返回默认值，不抛）
 * ------------------------------------------------------------------ */
function loadQuotaCfg(srv) {
  const f = path.join(srv.cfg.dataDir, 'quotas.json');
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      userQuotaMB: obj.userQuotaMB || {},
      diskSoftPct: typeof obj.diskSoftPct === 'number' ? obj.diskSoftPct : DEFAULT_CFG.diskSoftPct,
      diskHardPct: typeof obj.diskHardPct === 'number' ? obj.diskHardPct : DEFAULT_CFG.diskHardPct,
    };
  } catch {
    return { ...DEFAULT_CFG, userQuotaMB: {} };
  }
}

/* ------------------------------------------------------------------
 * checkUserQuota — 检查某用户已用 / 限额
 *   addBytes: 预估即将新增的字节（用于上传前预检）。返回 { ok, used, limitBytes }；
 *   额外附带 exceeded 标志。limitBytes=0 表示不限。
 *   user 为 null → { ok:true }（游客不限制）。
 * ------------------------------------------------------------------ */
function checkUserQuota(srv, user, addBytes = 0) {
  if (!user) return { ok: true }; // 游客跳过

  const cfg = loadQuotaCfg(srv);
  const username = user.username;
  const mb = cfg.userQuotaMB[username];

  // 未配置该用户 → 不限
  if (mb === undefined || mb === null) {
    // 仍回报当前 private 占用，便于前端展示
    let used = 0;
    try {
      const t = srv.resolveTarget({ disk: 'private', path: '' }, user);
      if (!t.error) used = srv.usedBytes(t.root);
    } catch {}
    return { ok: true, used, limitBytes: 0, exceeded: false };
  }

  const limitBytes = mb * 1024 * 1024;
  let used = 0;
  try {
    const t = srv.resolveTarget({ disk: 'private', path: '' }, user);
    if (!t.error) used = srv.usedBytes(t.root); // 仅统计 private 目录
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const projected = used + (addBytes > 0 ? addBytes : 0);
  return { ok: true, used, limitBytes, exceeded: projected > limitBytes };
}

/* ------------------------------------------------------------------
 * quotaOk — 用户配额的**纯判定**（是否阻断由调用方决定）
 *   checkUserQuota 只负责「算出用了多少 / 限了多少 / 超没超」，
 *   本函数把判定结果整理成调用方可直接使用的结构：
 *     - enforce（默认 true）：超限 → ok=false，调用方应当拒绝这次写入；
 *     - enforce:false         ：超限 → ok=true，仅作提示（老行为）。
 *   判定本身失败（读不到 private 用量）时按 fail-closed 处理：
 *   无法确认是否超限就不放行（enforce:false 时仍然放行）。
 *   @param {object} srv
 *   @param {object|null} user  null = 游客（不限制）
 *   @param {number} addBytes 本次将写入的字节数
 *   @param {object} [opts] { enforce }
 *   @returns {{ok:boolean, enforce:boolean, exceeded:boolean, used:number,
 *             limitBytes:number, reason:string, error?:string}}
 * ------------------------------------------------------------------ */
function quotaOk(srv, user, addBytes = 0, opts = {}) {
  const enforce = opts.enforce !== false;
  const r = checkUserQuota(srv, user, addBytes);
  if (!r.ok) {
    return {
      ok: !enforce, enforce, exceeded: true,
      used: r.used || 0, limitBytes: r.limitBytes || 0,
      reason: 'check-failed', error: r.error,
    };
  }
  const exceeded = !!r.exceeded;
  return {
    ok: exceeded ? !enforce : true,
    enforce,
    exceeded,
    used: r.used || 0,
    limitBytes: r.limitBytes || 0,
    reason: exceeded ? 'user-quota' : '',
    error: exceeded ? '用户存储配额已超出' : undefined,
  };
}

/* ------------------------------------------------------------------
 * diskOk — 盘容量阈值的**纯判定**（soft 只提示，hard 可阻断）
 *   @param {object} srv
 *   @param {string} disk 盘符
 *   @param {object} [opts] { enforce } enforce=true 时 hard 级也拒绝（默认只提示）
 * ------------------------------------------------------------------ */
function diskOk(srv, disk, opts = {}) {
  const enforce = !!opts.enforce;
  const r = checkDiskThreshold(srv, disk);
  if (!r.ok) return { ok: true, enforce, level: 'ok', usedPct: 0, reason: 'check-failed', error: r.error };
  const hard = r.level === 'hard';
  return {
    ok: hard && enforce ? false : true,
    enforce,
    exceeded: hard,
    level: r.level,
    usedPct: r.usedPct,
    reason: hard ? 'disk-hard' : (r.level === 'soft' ? 'disk-soft' : ''),
    error: hard && enforce ? '目标磁盘空间不足' : undefined,
  };
}

/* ------------------------------------------------------------------
 * checkDiskThreshold — 盘容量阈值告警
 *   返回 { ok, usedPct, level:'ok'|'soft'|'hard' }
 *   level: ok < softPct；softPct..hardPct → 'soft'；>= hardPct → 'hard'
 * ------------------------------------------------------------------ */
function checkDiskThreshold(srv, disk) {
  const cfg = loadQuotaCfg(srv);
  const entry = srv.listDisks(null).find((d) => d.id === disk);
  if (!entry) return { ok: false, error: '盘符不存在' };

  // 计算总容量与已用
  let total = entry.quota || 0;
  if (!total && typeof entry.free === 'number') total = (entry.used || 0) + entry.free;
  const used = entry.used || 0;
  const usedPct = total ? Math.round((used / total) * 1000) / 10 : 0; // 一位小数

  let level = 'ok';
  if (usedPct >= cfg.diskHardPct) level = 'hard';
  else if (usedPct >= cfg.diskSoftPct) level = 'soft';

  return { ok: true, usedPct, level };
}

/* ------------------------------------------------------------------
 * setUserQuota — 设置某用户配额（MB），写回 quotas.json
 *   原子写：tmp 文件 + rename。返回 { ok } 或 { ok:false, error }
 * ------------------------------------------------------------------ */
function setUserQuota(srv, adminUser, username, mb) {
  const f = path.join(srv.cfg.dataDir, 'quotas.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { cfg = { ...DEFAULT_CFG, userQuotaMB: {} }; }
  if (!cfg.userQuotaMB) cfg.userQuotaMB = {};

  cfg.userQuotaMB[username] = mb;

  // 原子写：先写临时文件再 rename
  const tmp = f + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: '写入配额失败：' + e.message };
  }
  return { ok: true };
}

module.exports = { loadQuotaCfg, checkUserQuota, checkDiskThreshold, quotaOk, diskOk, setUserQuota, DEFAULT_CFG };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotatest-'));
  const fakeSrv = {
    cfg: { dataDir: tmpDir },
    resolveTarget: (q) => ({ root: path.join(tmpDir, 'private'), error: null }),
    usedBytes: () => 5 * 1024 * 1024,     // 已用 5MB
    listDisks: () => [{ id: 'ext:1', used: 95, free: 5, quota: 100 }],
  };
  const user = { username: 'dav', id: 'u1' };

  // 未配置配额 → 不限
  const none = quotaOk(fakeSrv, user, 1024);
  check('未配置配额不超限', none.exceeded, false);
  check('未配置配额 ok', none.ok, true);
  check('未配置配额 limitBytes=0', none.limitBytes, 0);

  // 游客不限制
  check('游客不受限', quotaOk(fakeSrv, null, 1024).ok, true);

  // 配置 1MB 配额 → 已用 5MB 已超
  setUserQuota(fakeSrv, { username: 'admin' }, 'dav', 1);
  const over = quotaOk(fakeSrv, user, 0);
  check('超配额被判定 exceeded', over.exceeded, true);
  check('超配额 enforce 默认阻断', over.ok, false);
  check('超配额给出原因', over.reason, 'user-quota');
  check('超配额错误信息', over.error, '用户存储配额已超出');
  const soft = quotaOk(fakeSrv, user, 0, { enforce: false });
  check('enforce=false 时不阻断', soft.ok, true);
  check('enforce=false 仍报告 exceeded', soft.exceeded, true);

  // 配额内
  setUserQuota(fakeSrv, { username: 'admin' }, 'dav', 100);
  const inQuota = quotaOk(fakeSrv, user, 1024);
  check('配额内不超限', inQuota.exceeded, false);
  check('配额内 ok', inQuota.ok, true);

  // 预判写入量：已用 5MB + 写入 200MB > 100MB 限额
  const projected = quotaOk(fakeSrv, user, 200 * 1024 * 1024);
  check('预判写入后超限', projected.exceeded, true);

  // 盘阈值
  const d = diskOk(fakeSrv, 'ext:1');
  check('盘 hard 级被判定', d.level, 'hard');
  check('默认不阻断（只提示）', d.ok, true);
  check('enforce=true 时阻断', diskOk(fakeSrv, 'ext:1', { enforce: true }).ok, false);

  console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

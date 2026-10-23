'use strict';

/* =====================================================================
   lib/acl.js — 用户组 + 盘级 ACL（访问控制列表，零依赖）
   持久化于 <dataDir>/acl.json：
     {
       "groups": { "admins": ["管理员"] },          // 组名 -> 用户名数组
       "acl":    { "public": { "*": "rw" }, ... }   // 盘键 -> { 主体: 权限 }
     }
   盘键：public | private | ext（ext:<UUID> 统一归一化为 ext）
   主体：user:<名> | group:<组> | "guest"（匿名） | "*"
   权限：'rw' | 'ro' | 'none'

   R9-P0-3（默认策略收紧 + fail-closed）：
     - 默认策略由「全盘全 rw」改为 public=ro / private=none / ext=none。
       此前匿名能读**外置硬盘**（含私人移动硬盘里的照片/文档），这是最直接的
       信息泄漏；收紧后匿名只能读公共盘。
     - acl.json 损坏时**不再**回退到宽松策略：损坏 → 记审计 + 退到最保守（全 none）。
       「配置坏了就当没配」是典型的 fail-open，必须反过来。
   ===================================================================== */

const fs = require('fs');
const path = require('path');

/**
 * 默认策略：公共盘匿名只读，私人盘与外置盘默认不开放。
 * 为什么不默认给 rw：家用 NAS 上「默认全 rw」意味着任何能连到端口的人
 * （包括同网段的访客设备、流氓设备）都能读写外置硬盘。
 * 管理员的 rw 不走这里 —— resolvePerm 对 admin 无条件放行。
 */
function defaultAcl() {
  return {
    groups: { admins: ['管理员'] },
    acl: { public: { '*': 'ro' }, private: { '*': 'none' }, ext: { '*': 'none' } },
  };
}

/**
 * 最保守策略（fail-closed）：acl.json 损坏 / 读不出来时使用。
 * 所有盘对所有非管理员主体一律 none —— 宁可全站不可用，
 * 也不能在配置损坏时把权限放大成「默认全 rw」。
 */
function lockdownAcl() {
  return {
    groups: { admins: ['管理员'] },
    acl: { public: { '*': 'none' }, private: { '*': 'none' }, ext: { '*': 'none' } },
  };
}

/** 盘键归一化：ext:<UUID> → ext */
function normalizeDisk(disk) {
  const d = String(disk || '');
  return d.startsWith('ext:') ? 'ext' : d;
}

/* 损坏告警只报一次：loadAcl 在**每个**路径解析时都会被调用，
   不加这个闸门会刷屏，把真正的告警淹掉。 */
let _corruptNotified = false;

/** 写审计（优先用服务实例的 audit；没有就自己追加一行） */
function _audit(srv, detail) {
  try {
    if (srv && typeof srv.audit === 'function') {
      srv.audit({ action: 'acl-corrupt', detail, ok: false });
      return;
    }
    const dir = srv && srv.cfg && srv.cfg.dataDir;
    if (!dir) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(), ip: '', user: 'system', action: 'acl-corrupt',
      disk: '', path: '', ok: false, detail,
    });
    fs.appendFileSync(path.join(dir, 'audit.log'), line + '\n');
  } catch { /* 审计失败不影响主流程 */ }
}

/**
 * acl.json 损坏 / 读不出来时的兜底：**最保守策略**（全 none）+ 告警 + 审计。
 * @param {object} srv
 * @param {string} file
 * @param {Error} err
 * @param {object} [opts] { onCorrupt } 供调用方感知异常（可选，缺省不影响）
 */
function _corruptFallback(srv, file, err, opts = {}) {
  const detail = 'acl.json 损坏（' + ((err && err.message) || String(err)) + '），已按最保守策略（全 none）处理：' + file;
  if (!_corruptNotified) {
    _corruptNotified = true;
    console.error('[acl] 警告：' + detail);
    _audit(srv, detail);
  }
  // 回调每次损坏都会触发：它是「本次调用感知到异常」的钩子，不受告警节流影响
  if (opts && typeof opts.onCorrupt === 'function') {
    try { opts.onCorrupt(err); } catch { /* 回调异常不影响兜底 */ }
  }
  return lockdownAcl();
}

/**
 * 加载 acl.json。
 * 返回结构保持不变（{ groups, acl }），既有调用点无需改动。
 * - 文件不存在 → 收紧后的默认策略（不自动落盘，首次保存时写入）
 * - 文件损坏 / 读不出来 → **最保守策略**（全 none）+ 告警 + 审计（不再回退到宽松策略）
 * @param {object} srv
 * @param {object} [opts] { onCorrupt } 可选回调，用于让调用方感知到「ACL 配置损坏」
 */
function loadAcl(srv, opts = {}) {
  const file = path.join(srv.cfg.dataDir, 'acl.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return defaultAcl();  // 首次运行：没有 acl.json
    return _corruptFallback(srv, file, e, opts);
  }
  try {
    const raw = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) throw new Error('格式错误');
    _corruptNotified = false;
    return {
      groups: (typeof raw.groups === 'object' && raw.groups) || defaultAcl().groups,
      acl: (typeof raw.acl === 'object' && raw.acl) || defaultAcl().acl,
    };
  } catch (e) {
    return _corruptFallback(srv, file, e, opts);
  }
}

/** 原子保存：先写 .tmp 再 rename，避免写一半损坏 */
function saveAcl(srv, data) {
  const file = path.join(srv.cfg.dataDir, 'acl.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  /* R9：acl.json 里写着"谁能看哪个盘"，等于一份权限清单 → 0600。
     之前用默认 0644 落盘，任何本地用户都能读（改用默认 umask 还会更松）。 */
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* 某些文件系统不支持 */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 同上 */ }
}

/**
 * 查询某用户对某盘的最终权限。
 * 命中优先级：user:<名> > group:<组>（多组时取组内最严） > guest/*；
 * 同一主体命中多条时取最严：none > ro > rw。
 * @param {object} aclData loadAcl 返回的结构
 * @param {{username?:string, role?:string}|null} user null 表示游客
 * @param {string} disk 盘符（public/private/ext:<UUID>）
 */
function resolvePerm(aclData, disk, user) {
  // 管理员绕过一切 ACL
  if (user && user.role === 'admin') return 'rw';

  const dKey = normalizeDisk(disk);
  const rules = (aclData.acl && aclData.acl[dKey]) || {};
  const name = user && user.username ? String(user.username) : null;

  const RANK = { none: 0, ro: 1, rw: 2 };
  const stricter = (a, b) => {
    if (a == null) return b;
    if (b == null) return a;
    return RANK[a] <= RANK[b] ? a : b; // 同级冲突取最严
  };

  let perm = null;
  // 1) 具名用户规则（优先级最高，取最严的那条）
  if (name && rules['user:' + name] != null) perm = stricter(perm, rules['user:' + name]);
  // 2) 组规则（用户所属的所有组，取最严）
  if (name) {
    for (const g of groupsOf(aclData, name)) {
      const p = rules['group:' + g];
      if (p != null) perm = stricter(perm, p);
    }
  }
  // 3) 游客键（user=null 专属），否则回退通配
  if (!name && rules.guest != null) perm = stricter(perm, rules.guest);
  // 4) 通配符
  if (rules['*'] != null) perm = stricter(perm, rules['*']);

  return perm || 'none'; // 无任何命中 → 拒绝
}

/** 检查用户对某盘是否满足权限要求；needWrite=true 时必须 rw */
function checkPerm(srv, user, disk, needWrite) {
  const aclData = loadAcl(srv);
  const perm = resolvePerm(aclData, disk, user);
  const ok = needWrite ? perm === 'rw' : (perm === 'rw' || perm === 'ro');
  return { ok, perm };
}

/**
 * 判断用户是否属于某组（组不存在 → false）。
 * 注意：resolvePerm 走的是 groupsOf（多组时取组内最严），本函数只判**单个**组，
 * 全仓没有生产调用点（仅自测使用）—— 留着是为了给「是否属于某组」提供便捷查询，
 * 但**不要**用它替代 groupsOf 做权限判定（会漏掉其它组的更严规则）。
 */
function isMember(aclData, user, group) {
  const list = aclData.groups && aclData.groups[group];
  if (!Array.isArray(list)) return false;
  const name = user && user.username ? String(user.username) : null;
  return !!name && list.includes(name);
}

/** 返回用户所属的全部组名 */
function groupsOf(aclData, user) {
  const name = user && user.username ? String(user.username) : (typeof user === 'string' ? user : null);
  const out = [];
  if (!name) return out;
  for (const [group, list] of Object.entries(aclData.groups || {})) {
    if (Array.isArray(list) && list.includes(name)) out.push(group);
  }
  return out;
}

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)}`);
  };

  const acl = defaultAcl();
  const admin = { username: '管理员', role: 'admin' };
  const alice = { username: 'alice', role: 'user' };

  check('admin 恒 rw', resolvePerm(acl, 'public', admin), 'rw');
  /* R9-P0-3：默认策略收紧后，public 匿名只读，private/ext 一律 none */
  check('默认 public（登录用户）只读', resolvePerm(acl, 'public', alice), 'ro');
  check('默认 public（游客）只读', resolvePerm(acl, 'public', null), 'ro');
  check('默认 private 为 none', resolvePerm(acl, 'private', alice), 'none');
  check('默认 ext 为 none', resolvePerm(acl, 'ext:1234-ABCD', alice), 'none');
  check('默认 ext 游客为 none', resolvePerm(acl, 'ext', null), 'none');
  check('ext:<UUID> 归一化', resolvePerm(acl, 'ext:1234-ABCD', alice), 'none');
  check('未知盘拒绝', resolvePerm(acl, 'usb-stick', alice), 'none');
  check('admin 对 ext 仍 rw', resolvePerm(acl, 'ext', admin), 'rw');

  // 组 + 具名用户优先级与最严合并
  acl.groups.friends = ['alice', 'bob'];
  acl.acl.public = { '*': 'ro', 'group:friends': 'ro', 'user:alice': 'none', guest: 'none' };
  check('user 规则覆盖组与通配', resolvePerm(acl, 'public', alice), 'none');
  check('组规则覆盖通配', resolvePerm(acl, 'public', { username: 'bob', role: 'user' }), 'ro');
  check('游客走 guest 键', resolvePerm(acl, 'public', null), 'none');
  check('其他登录用户走通配', resolvePerm(acl, 'public', { username: 'carol', role: 'user' }), 'ro');
  // 同主体多条取最严：admins 组内出现两条同名用户规则
  acl.groups.dups = ['carol'];
  acl.acl.public['group:dups'] = 'rw';
  acl.acl.public['*'] = 'rw';   // 冲突用例里把通配放宽，专测「组规则 vs 通配」取最严
  check('组间冲突取最严', resolvePerm(acl, 'public', { username: 'carol', role: 'user' }), 'rw');
  acl.acl.public['group:dups'] = 'ro';
  check('组间冲突取最严(ro)', resolvePerm(acl, 'public', { username: 'carol', role: 'user' }), 'ro');

  check('isMember 命中', isMember(acl, alice, 'friends'), true);
  check('isMember 未命中', isMember(acl, { username: 'dave', role: 'user' }, 'friends'), false);
  check('groupsOf', groupsOf(acl, alice), ['friends']);

  // 磁盘级持久化自测（用临时目录模拟 srv）
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acltest-'));
  const fakeSrv = { cfg: { dataDir: tmpDir } };
  check('loadAcl 缺省回默认', loadAcl(fakeSrv), defaultAcl());
  saveAcl(fakeSrv, acl);
  check('saveAcl/loadAcl 回读', loadAcl(fakeSrv), acl);
  /* R9-P0-3：acl.json 损坏时**不能**回退到宽松策略（全 rw），
     必须是 fail-closed 的最保守策略（全 none） */
  fs.writeFileSync(path.join(tmpDir, 'acl.json'), '{broken');
  const broken = loadAcl(fakeSrv);
  check('loadAcl 损坏回退为最保守策略', broken, lockdownAcl());
  check('损坏后 ext 不是 rw', resolvePerm(broken, 'ext', alice), 'none');
  check('损坏后 private 不是 rw', resolvePerm(broken, 'private', alice), 'none');
  check('损坏后 public 不是 rw', resolvePerm(broken, 'public', alice), 'none');
  check('损坏后 admin 仍 rw', resolvePerm(broken, 'public', admin), 'rw');
  // 损坏回调可被调用方感知（可选，不传也不报错）
  let notified = 0;
  fs.writeFileSync(path.join(tmpDir, 'acl.json'), '{broken2');
  loadAcl(fakeSrv, { onCorrupt: () => { notified++; } });
  check('onCorrupt 回调被调用', notified >= 1, true);
  // 修复后恢复正常读取
  saveAcl(fakeSrv, acl);
  check('修复后读回正常', loadAcl(fakeSrv), acl);

  console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

module.exports = { loadAcl, saveAcl, resolvePerm, checkPerm, isMember, groupsOf, defaultAcl, lockdownAcl, normalizeDisk };

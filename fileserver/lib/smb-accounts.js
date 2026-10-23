'use strict';

/**
 * R15-P0：SMB 连接服务核心（ACL 驱动 + 幂等配置生成 + 个人账号/家目录）
 *
 * 这个文件取代旧的 lib/smb-users.js 实现（旧文件保留为薄壳，见下方 module.exports）。
 * 解决的三个根本问题：
 *
 *  ① 默认开启：网页注册即建同名 Linux + Samba 账号，并立刻进入 valid users；
 *     登录时把网页密码同步到 SMB（沿用 R11 的登录同步钩子）。
 *  ② 个人账号认证：security = user / map to guest = never / restrict anonymous = 2，
 *     每个共享 guest ok = no；不再有匿名会话可列共享。
 *  ③ 权限隔离：每个用户一个私有共享 [<用户名>] → /srv/station/users/<用户名>（0700），
 *     共享级权限由 data/acl.json 逐用户解析成 valid users / read list / write list；
 *     **不再对任何共享 force user = tokenllm**，SMB 会话以本人 Linux uid 落盘，
 *     文件系统层面天然区分 A/B 用户。
 *
 * 生成逻辑的幂等性：输出只依赖 (users.json + acl.json + 共享目录清单)，不含时间戳；
 * 内容不变时不写盘、不 reload；apply 前后可用 ops/smb/apply.js --dry-run 对比。
 *
 * 权限模型（与网页端 lib/acl.js 保持一致，直接复用其 resolvePerm）：
 *   - role === 'admin' 或 acl.json groups.admins 成员 → 所有共享 rw
 *   - 其余用户按 acl.json 的 user:<名> / group:<组> / guest / '*' 规则取最严
 *   - acl.json 损坏 → fail-closed：非管理员一律 none（不放大权限）
 *   - 共享清单里标 readonly 的共享（乱七八糟：NTFS fuseblk 无 Unix 属主映射）
 *     对所有人只读，避免用 force user 换取写权限而重新引入越权
 *
 * 所有需要 root 的动作走 sudo -n systemd-run --wait --pipe（原因见旧 smb-users.js
 * 的注释：station.service 的 CapabilityBoundingSet 会拦住直接 sudo useradd）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/* ────────────────────────────── 常量 ────────────────────────────── */

const DATA_DIR_DEFAULT = path.resolve(__dirname, '..', 'data');
const SHARES_CONF = '/etc/samba/station-shares.conf';
const SMB_CONF = '/etc/samba/smb.conf';
const SHARES_CATALOG_FILE = '/etc/samba/station-smb-shares.json';
const HOMES_ROOT = '/srv/station/users';
const STAMP_DIR = '/var/lib/station-smb';
const PERMS_STAMP = '/var/lib/station-smb/perms-stamp.json';
const STATE_FILE = 'smb-state.json';           // <dataDir>/smb-state.json
const AUDIT_STATE_FILE = 'smb-auth-audit.json';
const LOG_DIR = '/var/log/samba';

/** SMB 用户名允许字符：中文/空格会在 Windows 与 Samba 之间变形，直接拒绝并说明 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,31}$/;
/** SMB 密码下限 8 位（Windows 客户端兼容性最好） */
const MIN_PASS = 8;
/** 受管 global 段标记（smb.conf 里只认这一块，手改会被覆盖） */
const MANAGED_BEGIN = '# >>> station-smb managed (r15) — 由 lib/smb-accounts.js 自动生成，手改会被覆盖 >>>';
const MANAGED_END = '# <<< station-smb managed (r15) <<<';

/**
 * 共享目录清单（可被 /etc/samba/station-smb-shares.json 覆盖）。
 *   acl      : 对应 data/acl.json 的盘键（public/private/ext），决定谁能读、谁能写
 *   readonly : 共享级只读（true 时 ACL 只决定"谁能看"，所有人不能写）
 *   fixPerms : 是否修正目录的组权限（文件系统层给 users 组读写；fuseblk 必须 false）
 */
const CATALOG_FALLBACK = [
  { name: '公共盘', path: '/opt/station/fileserver/data/storage/public', acl: 'public', readonly: false, fixPerms: true, comment: '团队共享 · 公共盘' },
  { name: '办公', path: '/storage/办公', acl: 'private', readonly: false, fixPerms: true, comment: '团队共享 · 办公' },
  { name: '备份', path: '/storage/备份', acl: 'private', readonly: false, fixPerms: true, comment: '团队共享 · 备份' },
  { name: '数据', path: '/storage/数据', acl: 'private', readonly: false, fixPerms: true, comment: '团队共享 · 数据' },
  { name: 'Getea', path: '/storage/Getea', acl: 'private', readonly: false, fixPerms: true, comment: '团队共享 · Getea' },
  { name: 'K%', path: '/storage/K%', acl: 'private', readonly: false, fixPerms: true, comment: '团队共享 · K%' },
  { name: 'K1', path: '/storage/K1', acl: 'private', readonly: false, fixPerms: true, comment: '团队共享 · K1' },
  { name: 'Q21', path: '/storage/Q21', acl: 'private', readonly: false, fixPerms: true, comment: '团队共享 · Q21' },
  {
    name: '乱七八糟', path: '/storage/乱七八糟', acl: 'private', readonly: true, fixPerms: false,
    comment: '只读共享 · E 盘（NTFS fuseblk 无 Unix 属主映射，为保证用户间独立 uid 故 SMB 只读）',
  },
];

/* ────────────────────────────── 特权执行 ────────────────────────────── */

/**
 * 跑 root 命令。服务进程受 CapabilityBoundingSet 限制，必须走
 * systemd-run 起独立 oneshot；以 root 直接跑（CLI 场景）则不再套 sudo。
 */
function runPrivArgs(cmd, args, opts = {}) {
  const useSudo = process.getuid && process.getuid() !== 0;
  const bin = useSudo ? 'sudo' : cmd;
  const realArgs = useSudo
    ? ['-n', 'systemd-run', '--quiet', '--collect', '--wait', '--pipe', '--property=Type=oneshot', '--', cmd, ...args]
    : args;
  const r = spawnSync(bin, realArgs, {
    input: opts.input == null ? '' : opts.input,
    encoding: 'utf8',
    timeout: opts.timeout || 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim() || (r.error && r.error.message) || '',
  };
}

/** 跑一段 bash 脚本（root），用于 apply 这类多点操作 */
function runPrivScript(script, timeout) {
  const useSudo = process.getuid && process.getuid() !== 0;
  const bin = useSudo ? 'sudo' : '/bin/bash';
  const args = useSudo
    ? ['-n', 'systemd-run', '--quiet', '--collect', '--wait', '--pipe', '--property=Type=oneshot', '--', '/bin/bash', '-s']
    : ['-s'];
  const r = spawnSync(bin, args, {
    input: script,
    encoding: 'utf8',
    timeout: timeout || 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    out: String(r.stdout || ''),
    err: String(r.stderr || '') || (r.error && r.error.message) || '',
  };
}

function nonRootExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', timeout: opts.timeout || 8000, maxBuffer: 1024 * 1024,
  });
  return { ok: r.status === 0, status: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJson(file) {
  try {
    let txt = fs.readFileSync(file, 'utf8');
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    return JSON.parse(txt);
  } catch { return null; }
}

function writeJson(file, obj, mode) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: mode || 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * 账号缺失时清掉"登录同步指纹"：server.js 在下一次网页登录时看到指纹不一致，
 * 会重新调用 ensureSmbUser 把网页密码写进新建的 Samba 账号 —— 这是账密无法反推时
 * 唯一安全的自动恢复路径（不会伪造/覆盖成随机密码）。
 */
function dropLoginFingerprints(dataDir, names) {
  const f = path.join(dataDir || DATA_DIR_DEFAULT, 'smb-sync.json');
  const store = readJson(f);
  if (!store || typeof store !== 'object') return [];
  const dropped = [];
  for (const n of names) {
    if (Object.prototype.hasOwnProperty.call(store, n)) {
      delete store[n];
      dropped.push(n);
    }
  }
  if (dropped.length) writeJson(f, store, 0o600);
  return dropped;
}

let _aclLib = null;
function aclLib() {
  if (_aclLib !== null) return _aclLib || null;
  try { _aclLib = require('./acl'); } catch { _aclLib = false; }
  return _aclLib || null;
}

/* ────────────────────────────── 共享清单 / 状态加载 ────────────────────────────── */

function normalizeCatalogEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const p = String(raw.path || '').trim();
  if (!name || !p || /[\[\]]/.test(name)) return null;
  return {
    name,
    path: p,
    acl: String(raw.acl || 'private'),
    readonly: raw.readonly === true,
    fixPerms: raw.fixPerms !== false,
    comment: String(raw.comment || ''),
    note: String(raw.note || ''),
  };
}

/** 读共享清单：/etc/samba/station-smb-shares.json 优先，读不到用内置清单 */
function loadCatalog() {
  const raw = readJson(SHARES_CATALOG_FILE);
  const list = raw && (Array.isArray(raw) ? raw : raw.shares);
  if (Array.isArray(list) && list.length) {
    const out = list.map(normalizeCatalogEntry).filter(Boolean);
    if (out.length) return { shares: out, source: SHARES_CATALOG_FILE };
  }
  return { shares: CATALOG_FALLBACK.map(normalizeCatalogEntry).filter(Boolean), source: 'builtin' };
}

/**
 * 读取 users.json + acl.json。
 * acl.json 损坏时 fail-closed（保留空 acl → 非管理员无任何共享权限），
 * 与 lib/acl.js 的 R9 策略一致；绝不回退到"默认全 rw"。
 */
function loadState(dataDir) {
  const dir = dataDir || DATA_DIR_DEFAULT;
  const warnings = [];

  let users = [];
  try {
    let txt = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    const raw = JSON.parse(txt);
    users = (Array.isArray(raw.users) ? raw.users : []).filter((u) => u && typeof u.username === 'string');
  } catch (e) {
    warnings.push('users.json 读取失败，按空用户库处理：' + ((e && e.message) || e));
  }

  let aclOk = true;
  let acl = { groups: { admins: [], users: [] }, acl: {} };
  try {
    let txt = fs.readFileSync(path.join(dir, 'acl.json'), 'utf8');
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    const raw = JSON.parse(txt);
    if (!raw || typeof raw !== 'object') throw new Error('不是对象');
    acl = {
      groups: (raw.groups && typeof raw.groups === 'object') ? raw.groups : { admins: [], users: [] },
      acl: (raw.acl && typeof raw.acl === 'object') ? raw.acl : {},
    };
  } catch (e) {
    aclOk = false;
    warnings.push('acl.json 读取/解析失败，按 fail-closed（非管理员全部拒绝）处理：' + ((e && e.message) || e));
  }

  return { dataDir: dir, users, acl, aclOk, warnings };
}

function isAdminUser(user, aclData) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const list = aclData && aclData.groups && aclData.groups.admins;
  return Array.isArray(list) && list.includes(user.username);
}

/** 单用户对某盘键的最终权限；管理员恒 rw（fail-closed 时也是） */
function userPerm(aclData, aclKey, user, admin) {
  if (admin) return 'rw';
  const lib = aclLib();
  if (lib && typeof lib.resolvePerm === 'function') {
    try { return lib.resolvePerm(aclData, aclKey, { username: user.username, role: user.role }); } catch { return 'none'; }
  }
  /* 兜底（不应发生）：只认 group:users / user: / '*' */
  const rules = (aclData.acl && aclData.acl[aclKey]) || {};
  const rank = { none: 0, ro: 1, rw: 2 };
  let out = null;
  const stricter = (a, b) => (a == null ? b : b == null ? a : (rank[a] <= rank[b] ? a : b));
  const groups = Object.keys(aclData.groups || {}).filter((g) => Array.isArray(aclData.groups[g]) && aclData.groups[g].includes(user.username));
  groups.forEach((g) => { if (rules['group:' + g] != null) out = stricter(out, rules['group:' + g]); });
  if (rules['user:' + user.username] != null) out = stricter(out, rules['user:' + user.username]);
  if (rules['*'] != null) out = stricter(out, rules['*']);
  return out || 'none';
}

function smbUsers(state) {
  return state.users
    .filter((u) => NAME_RE.test(String(u.username || '')))
    .map((u) => ({ username: String(u.username), role: u.role || 'user', disabled: u.disabled === true }))
    .sort((a, b) => (a.username.toLowerCase() < b.username.toLowerCase() ? -1 : a.username.toLowerCase() > b.username.toLowerCase() ? 1 : 0));
}

/* ───────── 文件系统能力探测：NTFS/fuseblk 等无法映射 Unix 属主 ───────── */

const UNMAPPABLE_FS = /^(fuseblk|ntfs|ntfs3|exfat|vfat|msdos|cifs|smbfs|nfs|nfs4)$/i;
let _mountCache = { at: 0, list: null };

/** 解析 /proc/mounts（含 \040 等八进制转义） */
function mounts() {
  if (_mountCache.list && Date.now() - _mountCache.at < 5000) return _mountCache.list;
  const list = [];
  try {
    const txt = fs.readFileSync('/proc/mounts', 'utf8');
    for (const ln of txt.split('\n')) {
      const f = ln.split(' ');
      if (f.length < 3) continue;
      const unesc = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
      list.push({ dev: unesc(f[0]), mountpoint: unesc(f[1]), fstype: f[2] });
    }
  } catch { /* 非 Linux 环境（本地自测）没有 /proc/mounts */ }
  list.sort((a, b) => b.mountpoint.length - a.mountpoint.length);
  _mountCache = { at: Date.now(), list };
  return list;
}

/** 路径所在挂载点的文件系统类型（取最长前缀匹配） */
function fsTypeForPath(p) {
  const abs = String(p || '');
  for (const m of mounts()) {
    if (m.mountpoint === '/' || abs === m.mountpoint || abs.startsWith(m.mountpoint.replace(/\/$/, '') + '/')) {
      return { fstype: m.fstype, mountpoint: m.mountpoint };
    }
  }
  return { fstype: 'unknown', mountpoint: '' };
}

function invalidUsers(state) {
  return state.users
    .filter((u) => !NAME_RE.test(String(u.username || '')))
    .map((u) => String(u.username || ''));
}

/**
 * 计算完整配置计划（纯函数，不做任何写操作）。
 * @returns {{shares:Array, homes:Array, warnings:string[], users:Array, disabled:Array, source:string}}
 */
function planShares(state, catalogArg) {
  const catalog = catalogArg || loadCatalog();
  const warnings = state.warnings.slice();
  const all = smbUsers(state);
  const active = all.filter((u) => !u.disabled);
  const disabled = all.filter((u) => u.disabled);
  const bad = invalidUsers(state);
  if (bad.length) warnings.push('以下用户名含 SMB 不支持字符，已跳过（不改名无法作为 SMB 账号）：' + bad.join(', '));

  const shares = [];
  for (const c of catalog.shares) {
    /* 文件系统能力：NTFS/fuseblk/exfat 等把整盘映射成一个固定 uid，无法按 SMB 用户
       原子隔离属主。这种盘若强行可写就只能 force user=tokenllm（所有人同一 uid），
       正是本轮要消灭的越权；因此自动降级为 SMB 只读，写入仍可走网页端。 */
    const fsInfo = fsTypeForPath(c.path);
    const unmappable = UNMAPPABLE_FS.test(fsInfo.fstype);
    const readonly = c.readonly || unmappable;
    if (unmappable && !c.readonly) {
      warnings.push('共享「' + c.name + '」位于 ' + fsInfo.fstype + ' 挂载（' + fsInfo.mountpoint + '）：无法映射每个用户的 Unix 属主，SMB 侧自动降级为只读（避免用 force user 共用一个 uid 的越权；写入可走网页端）。');
    }
    const permMap = new Map();
    for (const u of active) {
      const admin = isAdminUser(u, state.acl);
      const base = userPerm(state.acl, c.acl, u, admin);
      const perm = readonly ? (base === 'none' ? 'none' : 'ro') : base;
      if (perm !== 'none' && perm != null) permMap.set(u.username, perm);
    }
    const validUsers = active.filter((u) => permMap.has(u.username)).map((u) => u.username);
    if (!validUsers.length) {
      warnings.push('共享「' + c.name + '」没有任何用户具备访问权限（acl.json 未授权），已跳过生成');
      continue;
    }
    const readUsers = validUsers.slice();
    const writeUsers = readonly ? [] : validUsers.filter((n) => permMap.get(n) === 'rw');
    shares.push({
      name: c.name,
      path: c.path,
      acl: c.acl,
      readonly,
      readOnly: readonly || writeUsers.length === 0,
      fsType: fsInfo.fstype,
      comment: c.comment,
      note: c.note,
      fixPerms: c.fixPerms !== false && !unmappable,
      validUsers,
      readUsers,
      writeUsers,
    });
  }

  const homes = active.map((u) => ({ username: u.username, path: HOMES_ROOT + '/' + u.username }));
  return { shares, homes, users: active, disabled, warnings, source: catalog.source, catalog: catalog.shares };
}

/* ────────────────────────────── 配置渲染 ────────────────────────────── */

function renderSharesConf(plan) {
  const L = [];
  L.push('###############################################################################');
  L.push('# 工作站 SMB 共享配置（自动生成，不要手改）');
  L.push('#');
  L.push('# 生成器: /opt/station/fileserver/lib/smb-accounts.js');
  L.push('# 输入  : data/users.json（账号/角色/禁用） + data/acl.json（共享级权限）');
  L.push('#         ' + SHARES_CATALOG_FILE + '（共享目录清单，可选）');
  L.push('# 规则  : admin 恒 rw；普通用户按 acl.json 的 user:/group:/guest/* 取最严；');
  L.push('#         每个共享的 valid users / read list / write list 都由角色推导；');
  L.push('#         无 force user —— SMB 会话以本人 Linux uid 落盘，用户间文件系统隔离；');
  L.push('#         每个用户一个私有共享 [<用户名>] → ' + HOMES_ROOT + '/<用户名>（0700）。');
  L.push('# 应用  : POST /api/smb/apply 或 node ops/smb/apply.js（幂等，内容不变不写盘）');
  L.push('###############################################################################');
  L.push('');

  for (const s of plan.shares) {
    L.push('[' + s.name + ']');
    if (s.comment) L.push('   comment = ' + s.comment);
    L.push('   path = ' + s.path);
    L.push('   browseable = yes');
    L.push('   guest ok = no');
    L.push('   read only = ' + (s.readOnly ? 'yes' : 'no'));
    L.push('   valid users = ' + s.validUsers.join(' '));
    if (s.readUsers.length) L.push('   read list = ' + s.readUsers.join(' '));
    if (!s.readOnly && s.writeUsers.length) L.push('   write list = ' + s.writeUsers.join(' '));
    L.push('   create mask = 0664');
    L.push('   directory mask = 0775');
    if (s.note) L.push('   # ' + s.note);
    if (s.readonly) L.push('   # 只读共享：ACL 仅决定可见性，写操作一律拒绝（避免 force user 越权）');
    L.push('   hide files = /.recycle/.snapshots/.versions/');
    L.push('   veto files = /.recycle/.snapshots/.versions/.uploading-*/');
    L.push('');
  }

  L.push('###############################################################################');
  L.push('# 个人私有共享：每人一个，仅本人 valid user；目录 0700，文件 0600。');
  L.push('###############################################################################');
  for (const h of plan.homes) {
    L.push('[' + h.username + ']');
    L.push('   comment = ' + h.username + ' 的私人空间（仅本人可读写）');
    L.push('   path = ' + h.path);
    L.push('   browseable = no');
    L.push('   guest ok = no');
    L.push('   read only = no');
    L.push('   valid users = ' + h.username);
    L.push('   create mask = 0600');
    L.push('   directory mask = 0700');
    L.push('');
  }
  return L.join('\n');
}

function stripManagedBlock(lines) {
  const out = [];
  let skipping = false;
  for (const ln of lines) {
    if (!skipping && ln.indexOf('station-smb managed (r15)') >= 0) { skipping = true; continue; }
    if (skipping) {
      if (ln.indexOf('station-smb managed (r15)') >= 0 && ln.indexOf('<<<') >= 0) skipping = false;
      continue;
    }
    out.push(ln);
  }
  return out;
}

/** smb.conf 里受本模块管理的 global 参数（会先删旧行再统一写进 managed 块） */
const MANAGED_GLOBAL_RE = /^\s*(security|map to guest|restrict anonymous|null passwords|debug prefix timestamp|log level|access based share enum)\s*=/i;
/**
 * 生成新的 smb.conf 文本：保留 [global] 其余配置与所有非本模块的共享段，
 * 只重写受管 global 段并在 include 前插入（幂等）。
 * @param {string} currentText 当前 smb.conf
 * @param {{includePath?:string}} opts includePath 用于生成 testparm 校验版（临时路径）
 */
function buildSmbConf(currentText, opts) {
  const includePath = (opts && opts.includePath) || SHARES_CONF;
  let lines = String(currentText || '').split('\n');
  lines = stripManagedBlock(lines);
  lines = lines.filter((ln) => !MANAGED_GLOBAL_RE.test(ln));

  let gStart = lines.findIndex((ln) => /^\s*\[global\]\s*$/i.test(ln));
  if (gStart < 0) {
    lines.unshift('[global]');
    gStart = 0;
  }
  let gEnd = lines.length;
  for (let i = gStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) { gEnd = i; break; }
  }

  /* include 指向共享配置文件；不存在则补一行 */
  let includeIdx = -1;
  for (let i = gStart + 1; i < gEnd; i++) {
    if (/^\s*include\s*=\s*\S*station-shares\.conf\s*$/i.test(lines[i])) { includeIdx = i; break; }
  }
  if (includeIdx < 0) {
    lines.splice(gEnd, 0, '   include = ' + includePath);
    includeIdx = gEnd;
    gEnd++;
  } else {
    lines[includeIdx] = '   include = ' + includePath;
  }

  const block = [
    '   ' + MANAGED_BEGIN,
    '   security = user',
    '   map to guest = never',
    '   restrict anonymous = 2',
    '   debug prefix timestamp = yes',
    '   log level = 1 auth:3 auth_audit:3',
    '   access based share enum = yes',
    '   ' + MANAGED_END,
  ];
  lines.splice(includeIdx, 0, ...block);

  /* 规整空行：连续 3+ 空行压成 2 行 */
  const out = [];
  let blank = 0;
  for (const ln of lines) {
    if (ln.trim() === '') {
      blank++;
      if (blank > 2) continue;
    } else blank = 0;
    out.push(ln);
  }
  return out.join('\n').trimEnd() + '\n';
}

/* ────────────────────────────── apply 脚本 ────────────────────────────── */

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** shell 单引号转义（用于把任意文本安全嵌进脚本） */
function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function heredoc(name, text) {
  return 'cat > "$TMPD/' + name + '" <<\'R15_EOF\'\n' + String(text).replace(/\n$/, '') + '\nR15_EOF\n';
}

/**
 * 生成 root 侧 apply 脚本。做五件事：
 *   ① 补 Linux 账号（nologin、主组 users）并把现有账号加入 users 组；
 *   ② 建/修个人家目录 0700；
 *   ③ 账号对账：active 用户的 Samba 账号被停用（D 标志）→ smbpasswd -e 恢复；
 *      账号缺失 → 输出 WARN 交给 Node 侧清登录同步指纹（下次网页登录重建）；
 *      disabled 用户 → smbpasswd -d（禁用 ≠ 删除）；
 *   ④ 修共享目录的组权限（rw 共享 chgrp users + g+rwX + setgid；递归只在首次/清单变化时做）；
 *   ⑤ 校验并安装 station-shares.conf + smb.conf（内容不变不写、不 reload），最后写幂等戳。
 */
function buildApplyScript(plan, conf, opts) {
  const opts2 = opts || {};
  const names = plan.users.concat(plan.disabled).map((u) => u.username);
  const activeNames = plan.users.map((u) => u.username);
  const homes = plan.homes;
  const rwShares = plan.shares.filter((s) => !s.readOnly && s.fixPerms);
  const disabled = plan.disabled.map((u) => u.username);
  const doRecursive = opts2.doRecursive === true;
  const stampHash = opts2.stampHash || '';
  const S = [];
  const P = (s) => S.push(s);

  P('set -u');
  P('export LC_ALL=C.UTF-8');
  P('TS=$(date +%Y%m%d-%H%M%S)');
  P('TMPD=$(mktemp -d /tmp/station-smb-apply.XXXXXX)');
  P('trap \'rm -rf "$TMPD"\' EXIT');
  P('mkdir -p ' + STAMP_DIR + ' ' + HOMES_ROOT);
  P('chmod 0711 ' + HOMES_ROOT);
  P('SHARE_COUNT=0; USER_COUNT=0; HOME_COUNT=0; CHANGED=0; RELOADED=0; RECURSIVE=' + (doRecursive ? '1' : '0'));
  P('ENABLED_COUNT=0; MISSING_ACCOUNTS=""');

  /* 账号 + 家目录 */
  P('for u in ' + (names.length ? names.map(shellQuote).join(' ') : '') + '; do');
  P('  [ -n "$u" ] || continue');
  P('  if ! id -u "$u" >/dev/null 2>&1; then');
  P('    if useradd -M -N -g users -s /usr/sbin/nologin -c "Deep Space station SMB user" "$u" 2>/dev/null; then');
  P('      echo "R15 account-created $u"');
  P('    else');
  P('      echo "R15 WARN useradd-failed $u"');
  P('    fi');
  P('  fi');
  P('  usermod -aG users "$u" 2>/dev/null || true');
  P('  USER_COUNT=$((USER_COUNT+1))');
  P('done');
  P('for h in ' + (homes.length ? homes.map((x) => shellQuote(x.username)).join(' ') : '') + '; do');
  P('  [ -n "$h" ] || continue');
  P('  install -d -m 0700 -o "$h" -g users ' + shellQuote(HOMES_ROOT) + '/"$h" 2>/dev/null || { mkdir -p ' + shellQuote(HOMES_ROOT) + '/"$h"; chown "$h":users ' + shellQuote(HOMES_ROOT) + '/"$h"; chmod 0700 ' + shellQuote(HOMES_ROOT) + '/"$h"; }');
  P('  HOME_COUNT=$((HOME_COUNT+1))');
  P('done');
  P('for u in ' + (disabled.length ? disabled.map(shellQuote).join(' ') : '') + '; do');
  P('  [ -n "$u" ] || continue');
  P('  if pdbedit -L 2>/dev/null | cut -d: -f1 | grep -qx "$u"; then smbpasswd -d "$u" >/dev/null 2>&1 || true; fi');
  P('done');
  /* 账号对账（启用恢复）：禁用 ≠ 删除。active 用户的 Samba 账号若仍带 D 标志（历史禁用），
     每次 apply 都 smbpasswd -e 恢复；账号不存在则记录，交由 Node 侧清同步指纹、下次登录重建。 */
  P('for u in ' + (activeNames.length ? activeNames.map(shellQuote).join(' ') : '') + '; do');
  P('  [ -n "$u" ] || continue');
  P('  if pdbedit -L 2>/dev/null | cut -d: -f1 | grep -qx "$u"; then');
  P('    smbpasswd -e "$u" >/dev/null 2>&1 || true');
  P('    ENABLED_COUNT=$((ENABLED_COUNT+1))');
  P('  else');
  P('    echo "R15 WARN smb-account-missing $u"');
  P('    MISSING_ACCOUNTS="$MISSING_ACCOUNTS $u"');
  P('  fi');
  P('done');
  /* 账号生命周期：users.json 里已删除的 Samba 账号 → 停用（只断 SMB 访问，Linux 账户和家目录数据保留，避免误删数据）。
     只在 users.json 读取成功且确实有用户时执行，防止配置损坏时把所有账号停掉。 */
  if (names.length) {
    const pattern = names.map((n) => n).join('|');
    P('ORPHANS=""');
    P('for u in $(pdbedit -L 2>/dev/null | cut -d: -f1); do');
    P('  case "$u" in ' + pattern + ') ;; *) ORPHANS="$ORPHANS $u"; smbpasswd -d "$u" >/dev/null 2>&1 || true ;; esac');
    P('done');
    P('if [ -n "$ORPHANS" ]; then echo "R15 disabled-orphans:$ORPHANS"; fi');
  }

  /* 共享目录组权限：本机 root 文件系统上的目录，给 users 组读写 */
  P('for p in ' + (rwShares.length ? rwShares.map((s) => shellQuote(s.path)).join(' ') : '') + '; do');
  P('  [ -n "$p" ] && [ -d "$p" ] || continue');
  P('  chgrp users "$p" 2>/dev/null || true');
  P('  chmod 2775 "$p" 2>/dev/null || true');
  P('  SHARE_COUNT=$((SHARE_COUNT+1))');
  P('done');
  P('if [ "$RECURSIVE" = "1" ]; then');
  P('  for p in ' + (rwShares.length ? rwShares.map((s) => shellQuote(s.path)).join(' ') : '') + '; do');
  P('    [ -n "$p" ] && [ -d "$p" ] || continue');
  P('    chgrp -R users "$p" 2>/dev/null || echo "R15 WARN chgrp-recursive $p"');
  P('    chmod -R g+rwX "$p" 2>/dev/null || echo "R15 WARN chmod-recursive $p"');
  P('  done');
  P('fi');
  /* 公共盘在 data/ 下：让 users 组能穿透（只给 x，不给读列表） */
  P('chmod 0711 ' + shellQuote('/opt/station/fileserver/data') + ' ' + shellQuote('/opt/station/fileserver/data/storage') + ' 2>/dev/null || true');

  /* 候选配置：install 版（真实 include）与 test 版（@TMPD@ 占位，供 testparm 校验） */
  P(heredoc('station-shares.conf.new', conf.sharesText));
  P(heredoc('smb.conf.new', conf.smbConfText));
  P(heredoc('smb.conf.test', conf.smbConfTest));
  P('sed "s#@TMPD@#$TMPD#g" "$TMPD/smb.conf.test" > "$TMPD/smb-test.conf"');
  P('if ! testparm -s "$TMPD/smb-test.conf" >"$TMPD/testparm.out" 2>&1; then');
  P("  echo 'R15SMB_RESULT {\"ok\":false,\"stage\":\"validate-candidate\"}'");
  P('  sed -n "1,40p" "$TMPD/testparm.out"');
  P('  exit 3');
  P('fi');

  /* 安装（只有内容变化才写，保留备份） */
  P('SHARES_BACKUP=""; SMB_BACKUP=""');
  P('if ! cmp -s "$TMPD/station-shares.conf.new" ' + shellQuote(SHARES_CONF) + '; then');
  P('  cp -a ' + shellQuote(SHARES_CONF) + ' ' + shellQuote(SHARES_CONF) + '.bak-$TS 2>/dev/null || true');
  P('  install -m 0644 -o root -g root "$TMPD/station-shares.conf.new" ' + shellQuote(SHARES_CONF) + ' || exit 4');
  P('  SHARES_BACKUP=' + shellQuote(SHARES_CONF) + '.bak-$TS');
  P('  CHANGED=1');
  P('fi');
  P('if ! cmp -s "$TMPD/smb.conf.new" ' + shellQuote(SMB_CONF) + '; then');
  P('  cp -a ' + shellQuote(SMB_CONF) + ' ' + shellQuote(SMB_CONF) + '.bak-$TS 2>/dev/null || true');
  P('  install -m 0644 -o root -g root "$TMPD/smb.conf.new" ' + shellQuote(SMB_CONF) + ' || exit 4');
  P('  SMB_BACKUP=' + shellQuote(SMB_CONF) + '.bak-$TS');
  P('  CHANGED=1');
  P('fi');
  P('if [ "$CHANGED" = "1" ]; then');
  P('  if ! testparm -s >/dev/null 2>&1; then');
  P('    [ -n "$SHARES_BACKUP" ] && cp -a "$SHARES_BACKUP" ' + shellQuote(SHARES_CONF) + ' 2>/dev/null || true');
  P('    [ -n "$SMB_BACKUP" ] && cp -a "$SMB_BACKUP" ' + shellQuote(SMB_CONF) + ' 2>/dev/null || true');
  P('    echo ' + sq('R15SMB_RESULT {"ok":false,"stage":"validate-installed","changed":1}'));
  P('    exit 5');
  P('  fi');
  P('  smbcontrol all reload-config >/dev/null 2>&1 || systemctl reload smbd >/dev/null 2>&1 || systemctl restart smbd >/dev/null 2>&1 || true');
  P('  RELOADED=1');
  P('fi');
  P('printf ' + sq('{"hash":"%s","at":"%s","shares":%s}') + ' ' + sq(stampHash) + ' "$(date -Iseconds)" "$SHARE_COUNT" > ' + sq(PERMS_STAMP));
  P('echo >> ' + sq(PERMS_STAMP));
  P('printf ' + sq('R15SMB_RESULT {"ok":true,"changed":%s,"reloaded":%s,"shares":%s,"users":%s,"homes":%s,"recursive":%s,"enabled":%s,"missing":"%s","sharesBackup":"%s","smbBackup":"%s"}') + ' "$CHANGED" "$RELOADED" "$SHARE_COUNT" "$USER_COUNT" "$HOME_COUNT" "$RECURSIVE" "$ENABLED_COUNT" "$MISSING_ACCOUNTS" "$SHARES_BACKUP" "$SMB_BACKUP"');
  P('echo');
  return S.join('\n') + '\n';
}

/* ────────────────────────────── 应用 / 预览 ────────────────────────────── */

function configStamp(plan) {
  return sha256(JSON.stringify(plan.shares.map((s) => [s.name, s.path, s.readonly, s.readOnly]))).slice(0, 24);
}

function parseApplyOutput(out) {
  const lines = String(out || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (ln.startsWith('R15SMB_RESULT ')) {
      try { return JSON.parse(ln.slice('R15SMB_RESULT '.length)); } catch { return null; }
    }
  }
  return null;
}

function previewConfig(opts) {
  const o = opts || {};
  const state = loadState(o.dataDir);
  const catalog = o.catalog ? { shares: o.catalog, source: 'argv' } : loadCatalog();
  const plan = planShares(state, catalog);
  const currentSmb = readText(SMB_CONF) || '[global]\n';
  const sharesText = renderSharesConf(plan);
  const smbConfText = buildSmbConf(currentSmb, { includePath: SHARES_CONF });
  const smbConfTest = buildSmbConf(currentSmb, { includePath: '@TMPD@/station-shares.conf.new' });
  const currentShares = readText(SHARES_CONF) || '';
  return {
    ok: true,
    dryRun: true,
    dataDir: state.dataDir,
    plan,
    sharesText,
    smbConfText,
    smbConfTest,
    changed: sharesText !== currentShares || smbConfText !== currentSmb,
    configHash: sha256(sharesText + '\n' + smbConfText).slice(0, 24),
    sources: { catalog: catalog.source },
  };
}

/**
 * 幂等应用：重建 /etc/samba/station-shares.conf + smb.conf 受管段，
 * 补齐账号/家目录/共享目录组权限，必要时 reload smbd。
 * @param {{dataDir?:string, reason?:string, actor?:string, forcePerms?:boolean}} opts
 */
function applyConfig(opts) {
  const o = opts || {};
  const t0 = Date.now();
  const preview = previewConfig({ dataDir: o.dataDir });
  if (!preview.ok) return preview;
  const plan = preview.plan;

  const stampHash = configStamp(plan);
  const prevStamp = readJson(PERMS_STAMP);
  const doRecursive = o.forcePerms === true || !prevStamp || prevStamp.hash !== stampHash;

  const script = buildApplyScript(plan, {
    sharesText: preview.sharesText,
    smbConfText: preview.smbConfText,
    smbConfTest: preview.smbConfTest,
  }, { doRecursive, stampHash });
  const r = runPrivScript(script);
  const parsed = parseApplyOutput(r.out) || parseApplyOutput(r.err);
  const result = parsed || {
    ok: false, stage: 'apply-script', exit: r.status,
    stdoutTail: String(r.out || '').slice(-1200), stderrTail: String(r.err || '').slice(-1200),
  };
  /* 账号缺失（passdb 里没有）→ 清登录同步指纹，让下一次网页登录自动重建；不伪造密码 */
  const missingAccounts = String(result.missing || '').trim().split(/\s+/).filter(Boolean);
  const fingerprintsDropped = missingAccounts.length ? dropLoginFingerprints(preview.dataDir, missingAccounts) : [];
  const pendingAccounts = missingAccounts.filter((n) => !fingerprintsDropped.includes(n));
  const out = {
    ...result,
    ok: result.ok === true && r.ok,
    reason: o.reason || 'manual',
    actor: o.actor || 'system',
    durationMs: Date.now() - t0,
    warnings: plan.warnings,
    accountSync: {
      enabled: Number(result.enabled || 0),
      missing: missingAccounts,
      pending: pendingAccounts,
      fingerprintsDropped,
    },
    shares: plan.shares.map((s) => ({
      name: s.name, path: s.path, acl: s.acl, readonly: s.readonly, fsType: s.fsType,
      validUsers: s.validUsers, readUsers: s.readUsers, writeUsers: s.writeUsers,
    })),
    users: plan.users.map((u) => u.username),
    homes: plan.homes.map((h) => h.username),
    configHash: preview.configHash,
    sources: preview.sources,
  };
  if (out.ok) {
    writeJson(path.join(preview.dataDir, STATE_FILE), {
      at: new Date().toISOString(),
      reason: out.reason,
      actor: out.actor,
      changed: out.changed === 1 || out.changed === true,
      reloaded: out.reloaded === 1 || out.reloaded === true,
      configHash: out.configHash,
      inputHash: inputFingerprint(preview.plan),
      shares: out.shares.length,
      users: out.users.length,
      warnings: out.warnings.slice(0, 10),
    });
  }
  return out;
}

/**
 * 调试/验收用：只生成 apply 脚本（不执行），便于 `bash -n` 做语法检查。
 */
function previewApplyScript(opts) {
  const pv = previewConfig(opts);
  const plan = pv.plan;
  const stampHash = configStamp(plan);
  const prevStamp = readJson(PERMS_STAMP);
  const doRecursive = (opts && opts.forcePerms === true) || !prevStamp || prevStamp.hash !== stampHash;
  const script = buildApplyScript(plan, {
    sharesText: pv.sharesText, smbConfText: pv.smbConfText, smbConfTest: pv.smbConfTest,
  }, { doRecursive, stampHash });
  return { ok: true, script, preview: pv };
}

/* ────────────────────────────── 账号操作 ────────────────────────────── */

function linuxUserExists(name) {
  return nonRootExec('id', ['-u', String(name)]).ok;
}

function linuxUsersAll() {
  try {
    const txt = fs.readFileSync('/etc/passwd', 'utf8');
    const set = new Set();
    for (const ln of txt.split('\n')) {
      const f = ln.split(':');
      if (f[0]) set.add(f[0]);
    }
    return set;
  } catch { return new Set(); }
}

let _smbUsersCache = { at: 0, names: null };
function listSmbUsersRaw() {
  const r = runPrivArgs('pdbedit', ['-L']);
  if (!r.ok) return [];
  return r.out.split('\n').map((l) => l.split(':')[0]).filter(Boolean);
}

function listSmbUsers() {
  if (_smbUsersCache.names && Date.now() - _smbUsersCache.at < 10000) return _smbUsersCache.names;
  const names = listSmbUsersRaw();
  _smbUsersCache = { at: Date.now(), names };
  return names;
}

function smbUserExists(name) {
  return listSmbUsers().includes(String(name));
}

function validateAccount(username, password) {
  const name = String(username == null ? '' : username).trim();
  if (!NAME_RE.test(name)) {
    return { ok: false, error: '用户名含 SMB 不支持的字符（只允许字母、数字、_ . - @），请改个用户名或用管理员账号设置。' };
  }
  if (password != null) {
    const pw = String(password);
    if (pw.length < MIN_PASS) return { ok: false, error: 'SMB 密码至少 ' + MIN_PASS + ' 位。' };
    if (/[\r\n]/.test(pw)) return { ok: false, error: 'SMB 密码不能包含换行符。' };
  }
  return { ok: true, name };
}

/**
 * 确保 Linux + Samba 账号存在，并把密码设为 password。
 * @returns {{ok:true, created:boolean} | {ok:false, error:string}}
 */
function ensureSmbUser(username, password) {
  const v = validateAccount(username, password);
  if (!v.ok) return v;
  const name = v.name;
  let created = false;
  if (!linuxUserExists(name)) {
    const r = runPrivArgs('useradd', ['-M', '-N', '-g', 'users', '-s', '/usr/sbin/nologin', '-c', 'Deep Space station SMB user', name]);
    if (!r.ok && !/already exists/i.test(r.err)) {
      return { ok: false, error: '创建系统账户失败：' + (r.err || r.out || '未知错误') };
    }
    created = true;
  }
  /* 确保在 users 组（老账号 dav/Dozin 主组是私有组，需要补进来才能读写共享目录） */
  runPrivArgs('usermod', ['-aG', 'users', name]);
  const pw = String(password);
  const set = runPrivArgs('smbpasswd', ['-s', '-a', name], { input: pw + '\n' + pw + '\n' });
  if (!set.ok) return { ok: false, error: '设置 SMB 密码失败：' + (set.err || set.out || '未知错误') };
  runPrivArgs('smbpasswd', ['-e', name]);
  _smbUsersCache = { at: 0, names: null };
  return { ok: true, created: created || !smbUserExists(name) ? true : created };
}

/** 只改密码（账号不存在则创建） */
function setSmbPassword(username, password) {
  return ensureSmbUser(username, password);
}

function disableSmbUser(username) {
  const v = validateAccount(username);
  if (!v.ok) return v;
  const r = runPrivArgs('smbpasswd', ['-d', v.name]);
  _smbUsersCache = { at: 0, names: null };
  return { ok: r.ok, error: r.ok ? '' : (r.err || r.out) };
}

function reloadSamba() {
  const a = runPrivArgs('smbcontrol', ['all', 'reload-config']);
  if (a.ok) return { ok: true, via: 'smbcontrol' };
  const b = runPrivArgs('systemctl', ['reload', 'smbd']);
  return { ok: b.ok, via: 'systemctl', error: b.ok ? '' : (b.err || a.err) };
}

/**
 * 旧接口兼容：server.js 在注册/登录时调用 addUserToShares(username)。
 * 新实现不再"追加到所有共享"，而是重建整份配置（幂等 + ACL 驱动）。
 */
function addUserToShares(username) {
  const r = applyConfig({ reason: 'user-apply:' + String(username || '') });
  return { ok: r.ok, changed: r.changed === 1 || r.changed === true, error: r.ok ? '' : (r.error || 'apply failed'), detail: r };
}

/* ────────────────────────────── 查询 / 状态 ────────────────────────────── */

function serviceState() {
  const state = {};
  for (const unit of ['smbd', 'nmbd']) {
    state[unit] = {
      active: nonRootExec('systemctl', ['is-active', unit]).out === 'active',
      enabled: ['enabled', 'enabled-runtime', 'static', 'indirect'].includes(nonRootExec('systemctl', ['is-enabled', unit]).out),
    };
  }
  return state;
}

function shareList() {
  const state = loadState();
  const plan = planShares(state);
  return plan.shares.map((s) => ({ name: s.name, path: s.path, readonly: s.readOnly, acl: s.acl }));
}

/** 当前用户可见的共享（含个人私有共享） */
function sharesForUser(user, dataDir) {
  const state = loadState(dataDir);
  const plan = planShares(state);
  const uname = user && user.username ? String(user.username) : '';
  const out = [];
  for (const s of plan.shares) {
    if (!uname || !s.validUsers.includes(uname)) continue;
    const perm = s.readonly ? 'ro' : (s.writeUsers.includes(uname) ? 'rw' : 'ro');
    out.push({ name: s.name, kind: 'team', perm, readonly: s.readOnly, acl: s.acl, note: s.note });
  }
  const home = plan.homes.find((h) => h.username === uname);
  if (home) out.push({ name: uname, kind: 'home', perm: 'rw', readonly: false, path: home.path });
  return out;
}

function roleOf(user, dataDir) {
  const state = loadState(dataDir);
  const u = state.users.find((x) => x.username === user.username) || user;
  return isAdminUser(u, state.acl) ? 'admin' : (u.role || 'user');
}

function extractUserFromAuthLine(line) {
  let m = /user \[[^\]]*\]\\\[([^\]]+)\]/.exec(line);
  if (m) return m[1];
  m = /user \[([^\]]+)\]/.exec(line);
  return m ? m[1] : '';
}

const AUTH_RE = /^\[(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})(?:[.,]\d+)?[^\]]*\]\s+Auth: .*status \[(NT_STATUS_[A-Z0-9_]+)\].*remote host \[ipv4:([0-9a-fA-F.:]+):\d+\]/;

function logFiles() {
  const files = [];
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^log(\.|$)/.test(f)) continue;
      const full = path.join(LOG_DIR, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || st.size === 0 || st.size > 8 * 1024 * 1024) continue;
      files.push({ file: f, full, size: st.size, mtime: st.mtimeMs });
    }
  } catch { /* 无日志目录 */ }
  return files;
}

function parseAuthLine(line) {
  const m = AUTH_RE.exec(line);
  if (!m) return null;
  if (m[2] === 'NT_STATUS_OK') return null;
  const [y, mo, d] = m[1].slice(0, 10).split('/').map(Number);
  const time = m[1].slice(11);
  const [hh, mm, ss] = time.split(':').map(Number);
  const dt = new Date(y, mo - 1, d, hh, mm, ss);
  return { ts: dt.toISOString(), tsMs: dt.getTime(), status: m[2], ip: m[3].replace(/^::ffff:/, ''), user: extractUserFromAuthLine(line) };
}

let _failCache = { at: 0, data: null };
function recentAuthFailures(opts) {
  const o = opts || {};
  const freshMs = o.freshMs == null ? 8000 : o.freshMs;
  if (_failCache.data && Date.now() - _failCache.at < freshMs) return _failCache.data;
  const max = o.max || 80;
  const since = Date.now() - (o.maxAgeMs || 24 * 3600 * 1000);
  const seen = new Set();
  const entries = [];
  for (const f of logFiles()) {
    let txt;
    try { txt = fs.readFileSync(f.full, 'latin1'); } catch { continue; }
    for (const ln of txt.split('\n')) {
      const e = parseAuthLine(ln);
      if (!e || e.tsMs < since) continue;
      const key = e.ts + '|' + e.user + '|' + e.ip;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(e);
    }
  }
  entries.sort((a, b) => b.tsMs - a.tsMs);
  const data = { entries: entries.slice(0, max), total: entries.length, parsedAt: new Date().toISOString() };
  _failCache = { at: Date.now(), data };
  return data;
}

/**
 * 把 Samba 认证失败增量写进站点审计（data/audit.log），满足"失败登录进 audit"。
 * 用偏移量文件记录已读位置，避免重复写；日志被截断/轮转时自动从头。
 */
function syncAuthFailures(app, opts) {
  if (!app || typeof app.audit !== 'function') return { ok: false, error: '无审计接口' };
  const o = opts || {};
  const dataDir = o.dataDir || DATA_DIR_DEFAULT;
  const statePath = path.join(dataDir, AUDIT_STATE_FILE);
  const st = readJson(statePath) || { files: {} };
  if (!st.files || typeof st.files !== 'object') st.files = {};
  let added = 0;
  for (const f of logFiles()) {
    const prev = Number(st.files[f.file] || 0);
    let from = prev;
    if (from > f.size) from = 0;
    if (from === f.size) continue;
    let buf;
    try {
      const fd = fs.openSync(f.full, 'r');
      buf = Buffer.alloc(f.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
    } catch { continue; }
    const lines = buf.toString('latin1').split('\n');
    let count = 0;
    for (const ln of lines) {
      const e = parseAuthLine(ln);
      if (!e) continue;
      if (count >= 50) break;
      count++;
      added++;
      try {
        app.audit({
          action: 'smb-auth-fail', user: e.user || 'unknown', ok: false,
          ip: e.ip || '', detail: 'SMB 认证失败：' + e.status + '（' + e.ts + '）',
        });
      } catch { /* 审计失败不影响主流程 */ }
    }
    st.files[f.file] = f.size;
  }
  writeJson(statePath, st);
  return { ok: true, added };
}

let _f2bCache = { at: 0, data: null };
function fail2banStatus(opts) {
  const freshMs = (opts && opts.freshMs) || 15000;
  if (_f2bCache.data && Date.now() - _f2bCache.at < freshMs) return _f2bCache.data;
  const cfg = readText('/etc/fail2ban/jail.local') || '';
  const sec = (cfg.split('[station-smb]')[1] || '').split('\n[')[0];
  const pick = (k) => {
    const m = new RegExp('^\\s*' + k + '\\s*=\\s*(\\S+)', 'm').exec(sec);
    return m ? Number(m[1]) : null;
  };
  const base = {
    installed: !!sec, jail: 'station-smb', maxretry: pick('maxretry'), findtime: pick('findtime'), bantime: pick('bantime'),
  };
  const r = runPrivArgs('fail2ban-client', ['status', 'station-smb'], { timeout: 15000 });
  if (!r.ok) {
    const data = { ...base, active: false, currentlyBanned: 0, bannedIps: [], error: (r.err || r.out || 'fail2ban-client 不可用').slice(0, 300) };
    _f2bCache = { at: Date.now(), data };
    return data;
  }
  const txt = r.out;
  const num = (re) => { const m = re.exec(txt); return m ? Number(m[1]) : 0; };
  const bannedLine = (/Banned IP list:\s*(.*)$/m.exec(txt) || [])[1] || '';
  const data = {
    ...base,
    active: true,
    currentlyFailed: num(/Currently failed:\s*(\d+)/),
    totalFailed: num(/Total failed:\s*(\d+)/),
    currentlyBanned: num(/Currently banned:\s*(\d+)/),
    totalBanned: num(/Total banned:\s*(\d+)/),
    bannedIps: bannedLine.trim() ? bannedLine.trim().split(/\s+/) : [],
  };
  _f2bCache = { at: Date.now(), data };
  return data;
}

function lastApplied(dataDir) {
  return readJson(path.join(dataDir || DATA_DIR_DEFAULT, STATE_FILE));
}

/**
 * 给 /api/smb/status 的完整状态。
 */
function statusFor(user, opts) {
  const o = opts || {};
  const dataDir = o.dataDir || DATA_DIR_DEFAULT;
  const state = loadState(dataDir);
  const plan = planShares(state);
  const uname = String(user.username);
  const svc = serviceState();
  const enabled = svc.smbd.active && svc.smbd.enabled;
  const shares = sharesForUser(user, dataDir);
  const home = plan.homes.find((h) => h.username === uname) || null;
  let homeExists = false, homeMode = null;
  if (home) {
    try {
      const st = fs.statSync(home.path);
      homeExists = st.isDirectory();
      homeMode = '0' + (st.mode & 0o777).toString(8);
    } catch { homeExists = false; }
  }
  const fails = recentAuthFailures({ max: 200 });
  const myFails = fails.entries.filter((e) => e.user && e.user.toLowerCase() === uname.toLowerCase());
  const f2b = fail2banStatus();
  const audit = syncAuthFailures(o.app, { dataDir });
  const pdb = listSmbUsers();
  const flags = pdbFlags();
  const myFlags = flags.has(uname) ? String(flags.get(uname) || '') : null;
  const sambaDisabled = myFlags != null && myFlags.indexOf('D') >= 0;
  /* ready 必须同时满足"存在 + 未被 D 标志停用"；历史 bug 是存在但被停用仍报 ready */
  const accountReady = pdb.includes(uname) && !sambaDisabled;
  const rec = reconcileState({ dataDir });
  return {
    ok: true,
    service: {
      name: 'SMB/CIFS',
      enabled,
      defaultOn: true,
      smbd: svc.smbd,
      nmbd: svc.nmbd,
      minProtocol: 'SMB3_00',
      host: o.host || '192.168.99.1',
      uncRoot: '\\\\' + (o.host || '192.168.99.1'),
      guestAllowed: false,
      anonymousEnumAllowed: false,
      forceUserUsed: false,
    },
    account: {
      username: uname,
      role: roleOf(user, dataDir),
      ready: accountReady,
      sambaDisabled,
      nameOk: NAME_RE.test(uname),
      minPassword: MIN_PASS,
      passwordSync: '注册时写入；之后每次网页登录自动同步为网页密码（改网页密码后下次登录生效）',
    },
    homeShare: home
      ? { name: uname, path: home.path, exists: homeExists, mode: homeMode, owner: uname }
      : null,
    shares,
    auth: {
      recentFailures: fails.total,
      myRecentFailures: myFails.length,
      lastFailureAt: fails.entries[0] ? fails.entries[0].ts : null,
      failures: fails.entries.slice(0, 20).map((e) => ({ ts: e.ts, user: e.user, ip: e.ip, status: e.status })),
      lock: {
        locked: f2b.currentlyBanned > 0,
        fail2ban: f2b,
      },
      auditSync: { ok: audit.ok === true, added: audit.added || 0 },
    },
    /* 自愈对账结果：drift=true 表示实际状态与期望不一致（页面可提示"重新同步"） */
    reconcile: {
      drift: rec.drift,
      reasons: rec.reasons,
      details: rec.details,
      pendingAccounts: rec.pendingAccounts || [],
      at: rec.at,
      last: _lastReconcile,
    },
    applied: lastApplied(dataDir),
    warnings: plan.warnings,
    at: new Date().toISOString(),
  };
}

/** 管理员视图：账号/Linux/Samba/家目录/各共享权限 */
function listUsersDetail(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || DATA_DIR_DEFAULT;
  const state = loadState(dataDir);
  const plan = planShares(state);
  const passwd = linuxUsersAll();
  const pdb = listSmbUsers();
  const flags = pdbFlags();
  const users = state.users.map((u) => {
    const uname = String(u.username);
    const nameOk = NAME_RE.test(uname);
    const admin = isAdminUser(u, state.acl);
    const sambaDisabled = flags.has(uname) && String(flags.get(uname) || '').indexOf('D') >= 0;
    const home = plan.homes.find((h) => h.username === uname) || null;
    let homeExists = false, homeMode = null, homeOwner = null;
    if (home) {
      try {
        const st = fs.statSync(home.path);
        homeExists = st.isDirectory();
        homeMode = '0' + (st.mode & 0o777).toString(8);
        /* 家目录由 apply 脚本 chown <用户名>:users，属主即本人；stat.uid 是数字，前端要名字 */
        homeOwner = homeExists ? uname : null;
      } catch { /* 不存在 */ }
    }
    const perms = {};
    for (const s of plan.shares) {
      if (!nameOk) { perms[s.name] = 'none'; continue; }
      if (s.readOnly) perms[s.name] = s.validUsers.includes(uname) ? 'ro' : 'none';
      else perms[s.name] = s.writeUsers.includes(uname) ? 'rw' : (s.readUsers.includes(uname) ? 'ro' : 'none');
    }
    return {
      username: uname,
      role: u.role || 'user',
      admin,
      disabled: u.disabled === true,
      nameOk,
      linux: passwd.has(uname),
      samba: pdb.includes(uname),
      sambaDisabled,
      home: home ? { path: home.path, exists: homeExists, mode: homeMode, owner: homeOwner } : null,
      shares: perms,
    };
  });
  const known = new Set(users.map((u) => u.username));
  return {
    ok: true,
    users,
    sambaOnly: pdb.filter((n) => !known.has(n)),
    invalidNames: invalidUsers(state),
    totals: {
      users: users.length,
      linux: users.filter((u) => u.linux).length,
      samba: users.filter((u) => u.samba).length,
      admins: users.filter((u) => u.admin).length,
      disabled: users.filter((u) => u.disabled).length,
      sambaDisabled: users.filter((u) => u.sambaDisabled).length,
      shares: plan.shares.length,
      homes: plan.homes.length,
    },
    reconcile: (() => {
      const rec = reconcileState({ dataDir });
      return { drift: rec.drift, reasons: rec.reasons, details: rec.details, at: rec.at };
    })(),
    applied: lastApplied(dataDir),
    warnings: plan.warnings,
    at: new Date().toISOString(),
  };
}

/* ────────────────────────────── 账号对账 / 自愈 ────────────────────────────── */

let _pdbFlagCache = { at: 0, map: null };
/** pdbedit -Lv 的账号标志位：{name -> flags}（D 表示 disabled，U 表示 user） */
function pdbFlags() {
  if (_pdbFlagCache.map && Date.now() - _pdbFlagCache.at < 15000) return _pdbFlagCache.map;
  const r = runPrivArgs('pdbedit', ['-L', '-v']);
  const map = new Map();
  if (r.ok) {
    let cur = null;
    for (const ln of r.out.split('\n')) {
      const m = /^Unix username:\s+(\S+)/.exec(ln);
      if (m) { cur = m[1]; if (!map.has(cur)) map.set(cur, ''); continue; }
      const f = /^Account Flags:\s*\[([^\]]*)\]/.exec(ln);
      if (f && cur) map.set(cur, f[1].trim());
    }
  }
  _pdbFlagCache = { at: Date.now(), map };
  return map;
}

let _reconcileCache = { at: 0, key: '', data: null };

/**
 * 只读对账：把"期望状态"（users.json + acl.json + 生成配置）与"实际状态"
 * （station-shares.conf / smb.conf / passdb 标志 / Linux 账号 / 家目录）逐项比较。
 *
 * 这是第 5 轮修复的核心：watchTick 不再只依赖"账号指纹是否变化"，而是每次都做
 * 实际状态对账 —— 任何原因造成的漂移（误删账号、flags 被置 D、配置被外部还原、
 * 上次 apply 失败）都会被检测到并自动修复。
 *
 * @returns {{ok:boolean, drift:boolean, reasons:string[], details:object, users:string[], at:string}}
 */
function reconcileState(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || DATA_DIR_DEFAULT;
  const cacheKey = dataDir;
  if (!o.fresh && _reconcileCache.data && _reconcileCache.key === cacheKey && Date.now() - _reconcileCache.at < 15000) {
    return _reconcileCache.data;
  }
  const state = loadState(dataDir);
  const plan = planShares(state);
  const pv = previewConfig({ dataDir });
  const reasons = [];
  const details = {
    config: 'ok', smbConf: 'ok',
    linuxMissing: [], smbMissing: [], smbDisabled: [], smbPending: [],
    homeMissing: [], homeBadMode: [], orphanEnabled: [],
  };
  /* 有"登录同步指纹"= 该账号曾经把网页密码同步到 SMB；指纹存在但账号没了 → 需要恢复；
     从没有指纹 = 用户注册后还没登录过，Samba 账号等待首次登录创建，属于正常待激活状态。 */
  const fpStore = readJson(path.join(dataDir, 'smb-sync.json')) || {};
  const fingerprinted = new Set(Object.keys(fpStore));
  const curShares = readText(SHARES_CONF) || '';
  const curSmb = readText(SMB_CONF) || '';
  if (pv.sharesText !== curShares) {
    details.config = 'drift';
    reasons.push('共享配置与期望不一致（可能被外部还原/手改/上次 apply 失败）');
  }
  if (pv.smbConfText !== curSmb) {
    details.smbConf = 'drift';
    reasons.push('smb.conf 受管段与期望不一致');
  }
  const flags = pdbFlags();
  const passwd = linuxUsersAll();
  for (const u of plan.users) {
    const n = u.username;
    if (!passwd.has(n)) {
      details.linuxMissing.push(n);
      reasons.push('Linux 账号缺失：' + n);
    }
    const f = flags.has(n) ? flags.get(n) : undefined;
    if (f === undefined) {
      if (fingerprinted.has(n)) {
        details.smbMissing.push(n);
        reasons.push('Samba 账号缺失（有历史登录指纹，等待下次网页登录重建）：' + n);
      } else {
        /* 从未登录过：Samba 密码无法从 scrypt 反推，等首次网页登录时自动创建；不算漂移 */
        details.smbPending.push(n);
      }
    } else if (f.indexOf('D') >= 0) {
      details.smbDisabled.push(n);
      reasons.push('Samba 账号被停用（启用未恢复）：' + n);
    }
    const hp = HOMES_ROOT + '/' + n;
    try {
      const st = fs.statSync(hp);
      if (!st.isDirectory()) {
        details.homeMissing.push(n);
        reasons.push('家目录不是目录：' + n);
      } else if ((st.mode & 0o777) !== 0o700) {
        details.homeBadMode.push(n);
        reasons.push('家目录权限不是 0700：' + n + '（0' + (st.mode & 0o777).toString(8) + '）');
      }
    } catch {
      details.homeMissing.push(n);
      reasons.push('家目录缺失：' + n);
    }
  }
  const known = new Set(plan.users.concat(plan.disabled).map((u) => u.username));
  for (const [n, f] of flags) {
    if (known.has(n)) continue;
    if (String(f || '').indexOf('D') < 0) {
      details.orphanEnabled.push(n);
      reasons.push('已删除用户的 Samba 账号仍未停用：' + n);
    }
  }
  const data = {
    ok: true,
    drift: reasons.length > 0,
    reasons,
    details,
    users: plan.users.map((u) => u.username),
    disabledUsers: plan.disabled.map((u) => u.username),
    /* 待首次登录激活的 Samba 账号（无密码可写，不计入漂移；登录 syncSmbAccount 会自动创建） */
    pendingAccounts: details.smbPending,
    configMatches: details.config === 'ok',
    at: new Date().toISOString(),
  };
  _reconcileCache = { at: Date.now(), key: cacheKey, data };
  return data;
}

let _lastReconcile = null;

/**
 * 自愈：对账 → apply（含 smbpasswd -e 恢复、家目录/配置修复）→ 再对账确认。
 * 管理员「重新同步」按钮 / CLI ops/smb/resync.cjs / 启动自检 都走这里。
 */
function resync(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || DATA_DIR_DEFAULT;
  const before = reconcileState({ dataDir, fresh: true });
  const result = applyConfig({
    dataDir,
    reason: o.reason || 'resync',
    actor: o.actor || 'manual',
    forcePerms: o.forcePerms === true,
  });
  const after = reconcileState({ dataDir, fresh: true });
  const out = {
    ok: before.ok && result.ok && !after.drift,
    before: { drift: before.drift, reasons: before.reasons, details: before.details },
    after: { drift: after.drift, reasons: after.reasons, details: after.details },
    applied: result,
    fixed: before.drift && !after.drift,
    at: new Date().toISOString(),
  };
  _lastReconcile = { at: out.at, before: out.before, after: out.after, fixed: out.fixed, ok: out.ok };
  return out;
}

/* ────────────────────────────── 自动应用（用户增删/禁用） ────────────────────────────── */

function inputFingerprint(plan) {
  const users = plan.users.map((u) => [u.username, u.role, !!u.disabled]).sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1));
  return sha256(JSON.stringify({ users, shares: plan.shares.map((s) => [s.name, s.validUsers, s.writeUsers]) })).slice(0, 32);
}

let _watchBusy = false;
let _watchLast = 0;
/**
 * 定时 watcher（90s）：**实际状态对账驱动**，而不是只看 users.json 指纹。
 *  - 账号/ACL 变化 → 重建配置
 *  - 禁用→启用后 Samba 账号 flags 仍为 D → apply 脚本 smbpasswd -e 恢复
 *  - Samba 账号/家目录/配置被误删或被外部还原 → 自动补齐/重写
 *  - 已删除用户 → 从共享摘除 + 孤儿账号停用
 * 全绿时不做任何写操作（幂等，不产生特权调用）。
 */
function watchTick(app, opts) {
  if (_watchBusy) return { ok: true, skipped: 'busy' };
  _watchBusy = true;
  try {
    const o = opts || {};
    const dataDir = o.dataDir || DATA_DIR_DEFAULT;
    const prev = lastApplied(dataDir);
    const rec = reconcileState({ dataDir, fresh: true });
    if (!rec.drift && prev) return { ok: true, skipped: 'in-sync', reasons: [] };
    if (!rec.drift && !prev && !o.force) {
      /* 首次启动且没有 apply 记录：不擅自改配置，交给显式 apply/部署脚本 */
      return { ok: true, skipped: 'no-state' };
    }
    const r = applyConfig({ dataDir, reason: 'watcher', actor: 'watcher' });
    const after = reconcileState({ dataDir, fresh: true });
    _lastReconcile = {
      at: Date.now(), before: { drift: rec.drift, reasons: rec.reasons, details: rec.details },
      after: { drift: after.drift, reasons: after.reasons, details: after.details },
      fixed: rec.drift && !after.drift, ok: r.ok && !after.drift,
    };
    if (app && typeof app.audit === 'function') {
      try {
        app.audit({
          action: 'smb-auto-apply', ok: r.ok && !after.drift,
          detail: '状态对账触发重建：' + (rec.reasons.slice(0, 4).join('；') || '账号/ACL 变化')
            + (after.drift ? '；仍有未修复项：' + after.reasons.join('；') : '；已对齐')
            + '（changed=' + !!(r.changed === 1 || r.changed === true) + '）',
        });
      } catch { /* 忽略 */ }
    }
    _watchLast = Date.now();
    return {
      ok: r.ok && !after.drift,
      applied: true,
      changed: r.changed,
      driftBefore: rec.reasons,
      driftAfter: after.reasons,
      accountSync: r.accountSync,
      error: r.ok ? (after.drift ? after.reasons.join('; ') : '') : r.error,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    _watchBusy = false;
  }
}

/* ────────────────────────────── 导出（兼容旧 smb-users API） ────────────────────────────── */

module.exports = {
  /* 常量 */
  SHARES_CONF, SMB_CONF, SHARES_CATALOG_FILE, HOMES_ROOT, MIN_PASS, NAME_RE,
  /* 配置 */
  loadCatalog, loadState, planShares, renderSharesConf, buildSmbConf, previewConfig, previewApplyScript, applyConfig,
  /* 账号 */
  validateAccount, ensureSmbUser, setSmbPassword, disableSmbUser, addUserToShares, reloadSamba,
  /* 查询 */
  shareList, sharesForUser, roleOf, statusFor, listUsersDetail, serviceState,
  listSmbUsers, smbUserExists, linuxUserExists,
  recentAuthFailures, syncAuthFailures, fail2banStatus, watchTick, lastApplied,
  /* 对账 / 自愈（第 5 轮） */
  reconcileState, resync, pdbFlags, dropLoginFingerprints,
  /* 工具 */
  runPrivArgs, runPrivScript, shellQuote, mounts, fsTypeForPath,
};

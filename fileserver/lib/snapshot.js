'use strict';

/* =====================================================================
 * lib/snapshot.js — 硬链接增量快照（目录级 + 回滚）
 *
 * 设计要点：
 *  - 快照存储位置：<盘根>/.snapshots/<YYYYMMDD-HHmmss[-tag]>/，与源同文件系统，
 *    因此 fs.linkSync 能真正省空间（硬链接共享 inode，只占一份数据）。
 *  - 硬链接降级：安卓 FUSE / 某些 NTFS 挂载对 link 返回 EXDEV / EPERM，
 *    此时退化为 fs.cpSync 真复制，并计入 linkFallback，不中断整体流程。
 *  - 单文件容错：每个文件/目录独立 try/catch，EACCES 等不影响其余条目。
 *  - 保留份数：超额删最老的（按目录名时间戳排序即为时间序）。
 *  - 跳过目录：.recycle（回收站）.versions（版本）.snapshots（快照自身）.fs-probe（探测文件）。
 * ===================================================================== */

const fs = require('fs');
const path = require('path');

/** 快照/巡检通用：需要跳过的系统目录与探测文件 */
const HIDDEN = new Set(['.recycle', '.versions', '.snapshots', '.fs-probe']);

/* ------------------------------------------------------------------
 * R9-OP-3：快照名路径穿越
 *   快照名（tag / 还原时传入的 name）来自用户输入，旧代码直接
 *   path.join(root, '.snapshots', name) —— 名字里带 '../' 就能把快照
 *   写到 dataDir 之外（配合 server.js 的快照路由就是任意写）。
 *   现在：名字必须过白名单式校验（只允许 字母/数字/汉字/._-，限长），
 *   且最终路径必须仍在 <盘根>/.snapshots 之内（path.relative 前缀判断）。
 * ------------------------------------------------------------------ */

/** 快照目录名长度上限 */
const SNAP_NAME_MAX = 64;
/** 快照 tag 长度上限 */
const SNAP_TAG_MAX = 32;
/** 安全字符集：Unicode 字母 / 数字 / 下划线 / 连字符 / 点 */
const SNAP_NAME_RE = /^[\p{L}\p{N}._-]+$/u;

/** 校验快照目录名（与 storage.validateName 同级：禁 / \ .. 控制字符，限长） */
function isValidSnapName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.length > SNAP_NAME_MAX) return false;
  if (name === '.' || name === '..') return false;
  if (name !== name.trim()) return false;       // 首尾空白
  if (name.endsWith('.')) return false;         // Windows 不允许以点结尾
  if (!SNAP_NAME_RE.test(name)) return false;   // 含 / \ 控制字符等一律拒绝
  return true;
}

/** 校验快照 tag（比目录名更短） */
function isValidSnapTag(tag) {
  if (typeof tag !== 'string' || !tag) return false;
  if (tag.length > SNAP_TAG_MAX) return false;
  if (tag !== tag.trim()) return false;
  if (!SNAP_NAME_RE.test(tag)) return false;
  return true;
}

/** 确认 child 仍在 parent 之内（path.relative 前缀判断，防路径穿越） */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (!rel) return false;                        // 同一个路径
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/** 取 <盘根>/.snapshots 目录 */
function snapRootOf(root) {
  return path.resolve(root, '.snapshots');
}

/* ------------------------------------------------------------------
 * walkFiles — 通用递归遍历工具，供本模块及其它模块复用
 *   cb(full, rel, isDir, st) 对每个条目回调；HIDDEN 内名称自动跳过。
 *   任一目录 readdir 失败仅跳过该目录，不抛出。
 * ------------------------------------------------------------------ */
function walkFiles(dir, cb, skip = HIDDEN) {
  const walk = (cur, relPrefix) => {
    let names;
    try { names = fs.readdirSync(cur); } catch { return; } // 单目录失败不拖累整体
    for (const name of names) {
      if (skip.has(name)) continue;
      const full = path.join(cur, name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; } // 单文件 stat 失败跳过
      const rel = relPrefix ? relPrefix + '/' + name : name;
      const isDir = st.isDirectory();
      cb(full, rel, isDir, st);
      if (isDir) walk(full, rel);
    }
  };
  walk(dir, '');
}

/* ------------------------------------------------------------------
 * 生成快照目录名（时间戳 + 可选 tag）
 * ------------------------------------------------------------------ */
function snapNameNow(tag) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const base =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return tag ? `${base}-${tag}` : base;
}

/* ------------------------------------------------------------------
 * 裁剪：仅保留最近 keep 份快照（目录名时间戳字典序即时间序）
 * ------------------------------------------------------------------ */
function pruneSnapshots(root, keep) {
  const dir = path.join(root, '.snapshots');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const snaps = names
    .filter((n) => {
      try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch { return false; }
    })
    .sort(); // 升序：最老在前
  while (snaps.length > keep) {
    const old = snaps.shift();
    try { fs.rmSync(path.join(dir, old), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/* ------------------------------------------------------------------
 * snapshotDisk — 对整盘做一次硬链接快照
 *   opts: { keep: 7, tag: '' }
 *   返回 { ok, name, entries, linkFallback } 或 { ok:false, error, code }
 * ------------------------------------------------------------------ */
async function snapshotDisk(srv, disk, user, opts = {}) {
  const keep = typeof opts.keep === 'number' ? opts.keep : 7;
  const tag = typeof opts.tag === 'string' ? opts.tag : '';

  // 需写权限（ext 只读盘会在此被拦截）
  const t = srv.resolveTarget({ disk, path: '', _write: true }, user);
  if (t.error) return { ok: false, error: t.error, code: t.code };
  const root = t.root;

  /* R9-OP-3：tag 来自用户输入，含 ../ 或 / 一律拒绝 */
  if (tag && !isValidSnapTag(tag)) {
    return { ok: false, error: '快照名称非法', code: 400 };
  }

  const name = snapNameNow(tag);
  const snapRoot = snapRootOf(root);
  const snapDir = path.resolve(snapRoot, name);
  /* 双保险：名字合法 + 最终路径仍落在 .snapshots 之内 */
  if (!isValidSnapName(name) || !isInside(snapRoot, snapDir)) {
    return { ok: false, error: '快照名称非法', code: 400 };
  }
  try { fs.mkdirSync(snapDir, { recursive: true }); } catch (e) {
    return { ok: false, error: '无法创建快照目录：' + e.message };
  }

  let entries = 0;
  let linkFallback = 0;

  walkFiles(root, (full, rel, isDir) => {
    if (isDir) {
      // 空目录也要在快照中存在，便于原样还原结构
      try { fs.mkdirSync(path.join(snapDir, rel), { recursive: true }); } catch { /* 忽略 */ }
      return;
    }
    const dst = path.join(snapDir, rel);
    try { fs.mkdirSync(path.dirname(dst), { recursive: true }); } catch { /* 忽略 */ }
    try {
      fs.linkSync(full, dst); // 首选：硬链接（零额外空间）
    } catch (e) {
      // EXDEV(跨文件系统) / EPERM(FUSE 不支持) / 其它 → 真复制降级
      try {
        fs.cpSync(full, dst);
        linkFallback++;
      } catch (e2) {
        // 复制也失败（如 EACCES）则跳过该文件，不中断快照
      }
    }
    entries++;
  });

  // 写元数据
  const meta = { time: Date.now(), disk, name, entries, linkFallback };
  try {
    fs.writeFileSync(path.join(snapDir, '_snapshot.json'), JSON.stringify(meta));
  } catch { /* 元数据失败不致命 */ }

  // 超额裁剪
  try { pruneSnapshots(root, keep); } catch { /* 忽略 */ }

  srv.audit({ userObj: user, action: 'snapshot', disk, path: name });
  return { ok: true, name, entries, linkFallback };
}

/* ------------------------------------------------------------------
 * listSnapshots — 列出某盘全部快照
 *   user 仅 private 盘需要；缺失时 private 盘解析会失败返回空列表。
 *   返回 [{ name, time, entries, linkFallback }]
 * ------------------------------------------------------------------ */
function listSnapshots(srv, disk, user = null) {
  const t = srv.resolveTarget({ disk, path: '' }, user);
  if (t.error) return [];
  const dir = snapRootOf(t.root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (n === '_snapshot.json') continue;
    /* R9-OP-3：目录名异常（不合法字符）一律跳过，别让它进入还原流程 */
    if (!isValidSnapName(n)) continue;
    const full = path.join(dir, n);
    if (!isInside(dir, full)) continue;
    let isDir = false;
    try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    // 优先读元数据
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(full, '_snapshot.json'), 'utf8')); } catch { /* 无元数据 */ }
    if (meta) {
      /* 元数据里的 name 同样要校验，防止被篡改成穿越串 */
      const mname = isValidSnapName(meta.name) ? meta.name : n;
      out.push({ name: mname, time: meta.time, entries: meta.entries, linkFallback: meta.linkFallback || 0 });
    } else {
      // 无元数据：从目录名推断时间
      const m = /^(\d{8})-(\d{6})/.exec(n);
      let time = null;
      if (m) {
        const dt = new Date(
          +m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8),
          +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6)
        );
        time = dt.getTime();
      }
      out.push({ name: n, time, entries: null, linkFallback: 0 });
    }
  }
  out.sort((a, b) => (b.time || 0) - (a.time || 0)); // 新在前
  return out;
}

/* ------------------------------------------------------------------
 * restoreSnapshot — 把快照内容复制回盘根
 *   规则：仅处理快照里存在的文件——覆盖现盘同名文件，补齐快照有而现盘无的文件；
 *         不删除现盘有而快照无的文件（安全回滚，不会误删新数据）。
 *   opts: { path: '' } 指定只恢复某子路径（相对盘根），其余不动。
 *   返回 { ok, restored } 或 { ok:false, error, code }
 * ------------------------------------------------------------------ */
async function restoreSnapshot(srv, disk, name, user, opts = {}) {
  const t = srv.resolveTarget({ disk, path: '', _write: true }, user);
  if (t.error) return { ok: false, error: t.error, code: t.code };
  const root = t.root;

  /* R9-OP-3：name 来自请求参数，必须先过白名单校验，再确认路径仍在 .snapshots 内 */
  const rawName = String(name || '');
  if (!isValidSnapName(rawName)) {
    return { ok: false, error: '快照名称非法', code: 400 };
  }
  const snapRoot = snapRootOf(root);
  const snapDir = path.resolve(snapRoot, rawName);
  if (!isInside(snapRoot, snapDir)) {
    return { ok: false, error: '快照名称非法', code: 400 };
  }
  if (!fs.existsSync(snapDir)) return { ok: false, error: '快照不存在', code: 404 };

  const onlyPath = String(opts.path || '').replace(/^\/+|\/+$/g, '');
  /* 子路径同样是用户输入：含 .. 一律拒绝（它只用于筛选，但别留隐患） */
  if (onlyPath && (onlyPath.includes('..') || onlyPath.includes('\0'))) {
    return { ok: false, error: '还原路径非法', code: 400 };
  }

  let restored = 0;
  walkFiles(snapDir, (full, rel) => {
    if (rel === '_snapshot.json') return; // 跳过元数据
    if (onlyPath && rel !== onlyPath && !rel.startsWith(onlyPath + '/')) return; // 仅子路径
    const dst = path.join(root, rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(full, dst, { recursive: true }); // 覆盖已存在 / 补齐缺失
      restored++;
    } catch (e) {
      /* 快照是硬链接，源与目标可能是同一个 inode —— cpSync 会报 EINVAL。
         这种情况内容本就一致（原地改写会同时改到快照），算「已还原」。 */
      try {
        if (e && e.code === 'ERR_FS_CP_EINVAL'
          && fs.statSync(full).ino === fs.statSync(dst).ino) restored++;
      } catch { /* 单文件失败忽略，继续其余 */ }
    }
  });

  srv.audit({
    userObj: user, action: 'snapshot-restore', disk,
    path: rawName + (onlyPath ? '/' + onlyPath : ''),
  });
  return { ok: true, restored };
}

module.exports = {
  snapshotDisk, listSnapshots, restoreSnapshot, walkFiles, HIDDEN,
  isValidSnapName, isValidSnapTag, isInside, snapNameNow, SNAP_NAME_MAX,
};

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let fail = 0;
  let pass = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`✓  ${name}`); }
    else { fail++; console.log(`✗  ${name}${extra ? '  →  ' + extra : ''}`); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snaptest-'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } };
  const root = path.join(tmp, 'storage');
  fs.mkdirSync(root, { recursive: true });
  const audits = [];
  const fakeSrv = {
    cfg: { dataDir: tmp },
    resolveTarget(q) { return { root, abs: path.join(root, q.path || ''), disk: q.disk || 'public' }; },
    audit(rec) { audits.push(rec); },
  };

  (async () => {
    /* ---- 名字校验 ---- */
    check('正常名可用', isValidSnapName('20240101-120000-daily'));
    check('中文名可用', isValidSnapName('20240101-120000-每日备份'));
    check('../../evil 被拒', !isValidSnapName('../../evil'));
    check('a/b 被拒', !isValidSnapName('a/b'));
    check('.. 被拒', !isValidSnapName('..'));
    check('. 被拒', !isValidSnapName('.'));
    check('反斜杠被拒', !isValidSnapName('a\\b'));
    check('超长名被拒', !isValidSnapName('x'.repeat(SNAP_NAME_MAX + 1)));
    check('控制字符被拒', !isValidSnapName('a\u0001b'));
    check('首尾空格被拒', !isValidSnapName(' abc '));
    check('以点结尾被拒', !isValidSnapName('abc.'));

    /* ---- 落盘：非法 tag 不得在 .snapshots 之外落地 ---- */
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    const bad1 = await snapshotDisk(fakeSrv, 'public', null, { tag: '../../evil' });
    check('tag 含 ../ 被拒', !bad1.ok && bad1.code === 400, JSON.stringify(bad1));
    const bad2 = await snapshotDisk(fakeSrv, 'public', null, { tag: 'a/b' });
    check('tag 含 / 被拒', !bad2.ok, JSON.stringify(bad2));
    const bad3 = await snapshotDisk(fakeSrv, 'public', null, { tag: 'x'.repeat(SNAP_TAG_MAX + 1) });
    check('tag 超长被拒', !bad3.ok, JSON.stringify(bad3));
    const bad4 = await snapshotDisk(fakeSrv, 'public', null, { tag: 'a\u0001b' });
    check('tag 含控制字符被拒', !bad4.ok, JSON.stringify(bad4));
    check('盘根外无新建目录', !fs.existsSync(path.join(tmp, 'evil')) && !fs.existsSync(path.join(root, '..', 'evil')));

    /* ---- 正常快照 ---- */
    const okSnap = await snapshotDisk(fakeSrv, 'public', null, { tag: 'daily' });
    check('正常快照成功', okSnap.ok && !!okSnap.name, JSON.stringify(okSnap));
    check('快照落在 .snapshots 内', fs.existsSync(path.join(root, '.snapshots', okSnap.name)));
    check('快照元数据已写', fs.existsSync(path.join(root, '.snapshots', okSnap.name, '_snapshot.json')));

    const list = listSnapshots(fakeSrv, 'public');
    check('列表含新快照', list.length === 1 && list[0].name === okSnap.name, JSON.stringify(list));

    /* ---- 还原：非法名必须拒绝，且不得写到盘外 ---- */
    /* 用「临时文件 + rename」改写：这样 inode 变了，快照里的旧内容还在
       （硬链接快照对原地改写无能为力，这是设计如此，不是缺陷）。 */
    const staged = path.join(root, 'a.txt.new');
    fs.writeFileSync(staged, 'CHANGED');
    fs.renameSync(staged, path.join(root, 'a.txt'));
    const evilDir = path.join(tmp, 'evil');
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, 'x.txt'), 'PWNED');
    const rBad = await restoreSnapshot(fakeSrv, 'public', '../../evil', null, {});
    check('还原穿越名被拒', !rBad.ok && rBad.code === 400, JSON.stringify(rBad));
    check('穿越还原未改动盘外文件', fs.readFileSync(path.join(evilDir, 'x.txt'), 'utf8') === 'PWNED');
    const rBad2 = await restoreSnapshot(fakeSrv, 'public', '..', null, {});
    check('还原 .. 被拒', !rBad2.ok, JSON.stringify(rBad2));
    check('非法还原后原文件未被覆盖', fs.readFileSync(path.join(root, 'a.txt'), 'utf8') === 'CHANGED');

    /* ---- 正常还原 ---- */
    const rOk = await restoreSnapshot(fakeSrv, 'public', okSnap.name, null, {});
    check('正常还原成功', rOk.ok && rOk.restored >= 1, JSON.stringify(rOk));
    check('还原后内容回到快照版本', fs.readFileSync(path.join(root, 'a.txt'), 'utf8') === 'A');
    check('审计记录已写', audits.some((x) => x.action === 'snapshot-restore'));

    /* ---- 子路径非法 ---- */
    const rBad3 = await restoreSnapshot(fakeSrv, 'public', okSnap.name, null, { path: '../..' });
    check('还原子路径穿越被拒', !rBad3.ok, JSON.stringify(rBad3));

    cleanup();
    console.log(`\n断言 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
    if (fail) { console.log('自测未通过'); process.exit(1); }
    console.log('自测全部通过');
    process.exit(0);
  })().catch((e) => {
    console.error('✗  自测异常:', e);
    try { cleanup(); } catch { /* 忽略 */ }
    process.exit(1);
  });
}

'use strict';

/* =====================================================================
   lib/classify.js — 自动分类整理（按扩展名归类到 分类/YYYY-MM/ 目录）
   ─────────────────────────────────────────────────────────────────────
   安全边界（重要）：
   1. 默认只整理「盘根第一层」散落的文件（onlyRoot=true / maxDepth=1），
      不递归动用户已组织好的子目录，杜绝误移动嵌套资料；
   2. .recycle / .versions / .snapshots 等系统目录与所有点开头隐藏项
      一律跳过；分类目录本身（图片/视频/音频/文档/归档）也不再进入；
   3. 规则表是「扩展名 → 分类目录」的白名单，不在表内的文件不动；
   4. 目标已存在同名文件时跳过（绝不覆盖）；跨设备(EXDEV) 时放弃
      rename 并计入 failed，绝不做"删除+复制"式的危险回退；
   5. plan（预演）与 apply（执行）分离：前端可先展示移动清单再确认。
   ===================================================================== */

const fs = require('fs');
const path = require('path');

/** 分类目录名（同时用作跳过清单，避免整理后再被翻动） */
const CATEGORY_NAMES = ['图片', '视频', '音频', '文档', '归档'];

/** 系统目录：永不进入、永不移动 */
const SYSTEM_DIRS = new Set(['.recycle', '.versions', '.snapshots']);

/** 默认规则：扩展名(小写) → 分类目录 */
const DEFAULT_RULES = (() => {
  const map = {};
  for (const e of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic']) map[e] = '图片';
  for (const e of ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv']) map[e] = '视频';
  for (const e of ['mp3', 'flac', 'wav', 'm4a', 'ogg']) map[e] = '音频';
  for (const e of ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'md', 'txt', 'csv']) map[e] = '文档';
  for (const e of ['zip', 'rar', '7z', 'tar', 'gz']) map[e] = '归档';
  return map;
})();

/** 取文件扩展名（小写，无扩展名返回 ''） */
function extOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** 按文件 mtime 生成目标子目录：分类/YYYY-MM/ */
function targetDirFor(stat, category) {
  const d = new Date(stat.mtimeMs);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return path.posix.join(category, ym);
}

/**
 * 生成分类计划（预演，不做任何改动）
 * @param {object} srv FileServer 实例（用 resolveTarget / cfg）
 * @param {string} disk 盘符 public | private | ext:<UUID>
 * @param {object} opts {rules?, onlyRoot=true, maxDepth=1, user?}
 * @returns {{moves:Array<{from:string,to:string}>, skipped:number}}
 */
function planClassification(srv, disk, opts = {}) {
  const rules = opts.rules || DEFAULT_RULES;
  const onlyRoot = opts.onlyRoot !== false;
  const maxDepth = Math.max(1, opts.maxDepth || 1);
  const moves = [];
  let skipped = 0;

  const t = srv.resolveTarget({ disk, path: '' }, opts.user || null);
  if (t.error) return { moves, skipped, error: t.error };
  const root = t.root;

  // 深度受限遍历（depth=1 即盘根第一层）
  const walk = (dir, rel, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || SYSTEM_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        // 已是分类目录的内容不再规划（防重复整理/自搬自）
        if (depth === 1 && CATEGORY_NAMES.includes(name)) continue;
        if (!onlyRoot && depth < maxDepth) walk(full, rel ? rel + '/' + name : name, depth + 1);
        continue;
      }
      if (depth !== 1 && !rel) continue;                       // 只处理文件
      const category = rules[extOf(name)];
      if (!category) { skipped++; continue; }                  // 无规则不动
      const to = targetDirFor(st, category) + '/' + name;
      if ((rel ? rel + '/' + name : name) === to) { skipped++; continue; } // 已在目标位置
      // 目标已存在同名文件 → 跳过（绝不覆盖）
      try { if (fs.existsSync(path.join(root, to))) { skipped++; continue; } } catch { continue; }
      moves.push({ from: rel ? rel + '/' + name : name, to });
    }
  };
  walk(root, '', 1);
  return { moves, skipped };
}

/**
 * 执行分类计划：逐条 renameSync，EXDEV/目标占用等失败计入 failed，不中断
 * @returns {{moved:number, failed:number}}
 */
function applyClassification(srv, disk, plan, user) {
  const moved = [];
  const failed = [];
  const t = srv.resolveTarget({ disk, path: '' }, user || null);
  if (t.error) return { moved, failed, error: t.error };
  const root = t.root;

  for (const mv of (plan && plan.moves) || []) {
    const from = String(mv.from || '');
    const to = String(mv.to || '');
    // 路径安全校验：相对路径、不许越出盘根、不许指向系统目录
    if (!from || !to || from.includes('..') || to.includes('..') ||
        from.startsWith('/') || to.startsWith('/') ||
        to.split('/')[0].startsWith('.')) {
      failed.push({ from, to, error: '非法路径' });
      continue;
    }
    const srcAbs = path.join(root, from);
    const dstAbs = path.join(root, to);
    try {
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      try { fs.renameSync(srcAbs, dstAbs); }                   // 同盘 rename，O(1)
      catch (e) {
        if (e.code === 'EXDEV') { failed.push({ from, to, error: '跨设备，已跳过' }); continue; }
        throw e;
      }
      moved.push({ from, to });
      srv.audit({ userObj: user, action: 'classify', disk: t.disk, path: from, detail: '→ ' + to });
    } catch (e) {
      failed.push({ from, to, error: e.message });
    }
  }
  if (moved.length) { try { srv.invalidateSizeCache && srv.invalidateSizeCache(); } catch { /* 忽略 */ } }
  return { moved, failed };
}

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  let fail = 0;
  const check = (name, cond, extra) => {
    if (!cond) fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  };
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clstest-'));
  const fakeSrv = {
    cfg: { dataDir: tmp },
    resolveTarget(q) { return { root: path.join(tmp, 'storage'), abs: path.join(tmp, 'storage', q.path || ''), disk: q.disk }; },
    audit(rec) { audits.push(rec); },
    invalidateSizeCache() {},
  };
  const audits = [];
  const root = path.join(tmp, 'storage');
  fs.mkdirSync(root, { recursive: true });

  // 摆放测试文件：散落文件 / 无规则文件 / 已分类文件 / 系统目录 / 子目录
  fs.writeFileSync(path.join(root, 'holiday.jpg'), 'x');
  fs.writeFileSync(path.join(root, 'song.mp3'), 'x');
  fs.writeFileSync(path.join(root, 'data.xyz'), 'x');          // 无规则
  fs.mkdirSync(path.join(root, '图片', '2020-01'), { recursive: true });
  fs.writeFileSync(path.join(root, '图片', '2020-01', 'old.jpg'), 'x'); // 已分类
  fs.mkdirSync(path.join(root, '.recycle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.recycle', 'trash.jpg'), 'x');
  fs.mkdirSync(path.join(root, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'subdir', 'nested.png'), 'x'); // 默认不动子目录
  // 指定 mtime 便于断言年月
  const past = new Date('2024-03-15T10:00:00Z');
  try { fs.utimesSync(path.join(root, 'holiday.jpg'), past, past); } catch { /*个别 FS 不支持则用当前时间*/ }

  const plan = planClassification(fakeSrv, 'public');
  const mv = Object.fromEntries(plan.moves.map((m) => [m.from, m.to]));
  // 期望目录按 holiday.jpg 实际 mtime 推导（utimes 失败时仍可断言）
  const jm = fs.statSync(path.join(root, 'holiday.jpg')).mtime;
  const ym = `${jm.getFullYear()}-${String(jm.getMonth() + 1).padStart(2, '0')}`;
  check('散落 jpg 入图片/YYYY-MM', mv['holiday.jpg'] === `图片/${ym}/holiday.jpg`, JSON.stringify(plan.moves));
  check('mp3 入音频', !!mv['song.mp3'] && mv['song.mp3'].startsWith('音频/'));
  check('无规则文件跳过', !mv['data.xyz'] && plan.skipped >= 1);
  check('已分类文件不再动', !plan.moves.some((m) => m.to.includes('old.jpg')));
  check('系统目录跳过', !plan.moves.some((m) => m.from.includes('.recycle')));
  check('子目录默认不动', !plan.moves.some((m) => m.from.startsWith('subdir')));

  const r = applyClassification(fakeSrv, 'public', plan, { username: '测试员' });
  check('执行移动数一致', r.moved.length === plan.moves.length && r.failed.length === 0, JSON.stringify(r));
  check('文件实际落位', fs.existsSync(path.join(root, '图片', ym, 'holiday.jpg')));
  check('原位置已空', !fs.existsSync(path.join(root, 'holiday.jpg')));
  check('审计 classify', audits.length === r.moved.length && audits[0].action === 'classify');

  // 重复执行：全部 skipped（目标已存在同名 → 跳过；无残留）
  const plan2 = planClassification(fakeSrv, 'public');
  check('二次规划无移动', plan2.moves.length === 0, JSON.stringify(plan2));

  // 恶意路径拒绝
  const bad = applyClassification(fakeSrv, 'public', { moves: [{ from: '../../etc/passwd', to: '图片/x' }] }, null);
  check('路径穿越拒绝', bad.failed.length === 1 && bad.moved.length === 0);

  console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

module.exports = { DEFAULT_RULES, CATEGORY_NAMES, planClassification, applyClassification, extOf };

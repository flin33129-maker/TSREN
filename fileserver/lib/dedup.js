'use strict';

/* =====================================================================
   lib/dedup.js — 重复文件查找 + 硬链接合并（零依赖，流式省内存）
   ─────────────────────────────────────────────────────────────────────
   三级漏斗，避免全量读大文件：
     1. size 分组       —— 大小不同必不重复（stat，零 IO 内容）
     2. 头 64KB 预分组  —— 大小相同但头部不同必不重复（每文件只读 64KB）
     3. 全文件 sha256   —— 仅对头部分组后的候选做完整哈希
   合并策略：保留 keepPath，把其余重复文件替换为指向它的硬链接
   （同一 inode，物理只存一份，两个路径都可访问）。合并前用
   statSync().dev 校验同一文件系统（硬链接不能跨文件系统），失败时
   绝不删除原文件，只计入 failed。不做任何删除——unlink 前提是
   link 已成功，数据始终至少有一个目录项持有。
   系统目录 .recycle/.versions/.snapshots 与点开头隐藏项跳过。

   R9-OP-4（大文件截断哈希 → 数据丢失）
     旧实现对超过 1GB 的文件只哈希前 1GB，**不同的两个大文件可能撞出
     同一个键**，随后合并时互相覆盖 —— 直接丢数据。
     现在：作为「键」的哈希一律是**完整 SHA-256**（流式算，不截断）；
     索引记录带大小；合并前先校验大小一致（不一致宁可不合并，也不丢数据）；
     合并走「临时硬链接 + 原子 rename」，任何一步失败原文件都完好。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 头部预读字节数 */
const HEAD_BYTES = 64 * 1024;
/**
 * 大文件阈值（1GB）：超过它的文件**必须**用完整 SHA-256 做键。
 * 保留这个常量是为了兼容既有调用方，并作为自测的注入口。
 */
const MAX_HASH_BYTES = 1024 * 1024 * 1024;

const SYSTEM_DIRS = new Set(['.recycle', '.versions', '.snapshots']);

/** sha256（流式读取文件，limit 只用于「头部预筛」这种非键用途） */
function hashFile(abs, limit) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(abs, { highWaterMark: 1 << 20, end: limit ? limit - 1 : undefined });
    rs.on('data', (d) => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

/**
 * R9-OP-4：完整 SHA-256（**绝不截断**）。
 * 去重键只能用这个 —— 截断哈希会让两个不同的超大文件撞键，合并即丢数据。
 */
function hashFileFull(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(abs, { highWaterMark: 1 << 20 });
    rs.on('data', (d) => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

/**
 * 查找重复文件
 * @param {object} srv FileServer 实例（用 resolveTarget）
 * @param {string} disk 盘符
 * @param {object} opts {minSize=1MB, maxFiles=20000, maxHashBytes=1GB}
 * @returns {{groups:Array<Array<{path,size,sha256}>>, scanned:number, bytes:number}}
 *          groups 每组为 ≥2 个内容相同的文件（相对盘根路径）
 */
async function findDuplicates(srv, disk, opts = {}) {
  const minSize = opts.minSize != null ? opts.minSize : 1048576;
  const maxFiles = opts.maxFiles || 20000;
  /* 大文件阈值：超过它必须用完整 SHA-256（这里只是策略阈值，键一律是完整哈希） */
  const maxHashBytes = opts.maxHashBytes != null ? Number(opts.maxHashBytes) : MAX_HASH_BYTES;
  const out = { groups: [], scanned: 0, bytes: 0 };

  const t = srv.resolveTarget({ disk, path: '' }, opts.user || null);
  if (t.error) { out.error = t.error; return out; }
  const root = t.root;

  // ---- 第 1 级：size 分组（递归全盘，跳过系统/隐藏目录） ----
  const bySize = new Map();
  let truncated = false;
  const walk = (dir, rel) => {
    if (truncated) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (truncated) return;
      if (name.startsWith('.') || SYSTEM_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const r = rel ? rel + '/' + name : name;
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, r); continue; }
      if (!st.isFile() || st.size < minSize) continue;         // 小文件不值得去重
      if (out.scanned >= maxFiles) { truncated = true; return; } // 上限保护
      out.scanned++;
      if (!bySize.has(st.size)) bySize.set(st.size, []);
      bySize.get(st.size).push({ rel: r, abs: full, size: st.size, dev: st.dev, ino: st.ino });
    }
  };
  walk(root, '');

  for (const [size, list] of bySize) {
    if (list.length < 2) continue;

    // 同一 inode（已是硬链接）只保留一个代表，不重复扫描
    const seenIno = new Set();
    const uniq = list.filter((f) => (seenIno.has(f.ino) ? false : (seenIno.add(f.ino), true)));
    if (uniq.length < 2) continue;

    // ---- 第 2 级：头 64KB 预分组 ----
    const byHead = new Map();
    for (const f of uniq) {
      let head = null;
      try { head = await hashFile(f.abs, Math.min(HEAD_BYTES, size)); } catch { continue; }
      const key = head;
      if (!byHead.has(key)) byHead.set(key, []);
      byHead.get(key).push(f);
    }

    // ---- 第 3 级：全文件 sha256 终分组 ----
    for (const candidates of byHead.values()) {
      if (candidates.length < 2) continue;
      const byFull = new Map();                                // 'hex:size' -> [{rel,size,abs}]
      for (const f of candidates) {
        let hex;
        /* R9-OP-4：键必须是**完整** SHA-256。
           旧实现对 > 1GB 的文件只哈希前 1GB，两个不同的大文件会撞同一个键，
           合并时互相覆盖 → 丢数据。宁可多算一遍，也不能丢数据。 */
        try { hex = await hashFileFull(f.abs); } catch { continue; }
        /* 键里带上大小：大小不一致本就不是重复，双保险 */
        const key = hex + ':' + f.size;
        if (!byFull.has(key)) byFull.set(key, []);
        byFull.get(key).push(f);
      }
      for (const [key, files] of byFull) {
        if (files.length < 2) continue;
        const hex = key.slice(0, key.lastIndexOf(':'));
        out.bytes += size * (files.length - 1);                // 可节省的空间
        out.groups.push(files.map((f) => ({
          path: f.rel,
          size: f.size,
          sha256: hex,
          big: f.size > maxHashBytes,                          // 超过阈值：键来自完整 SHA-256
        })));
      }
    }
  }
  return out;
}

/**
 * 硬链接合并：keepPath 保留，dupPaths 逐个替换为指向它的硬链接
 * @returns {{linked:number, copied:number, failed:number}}
 */
async function mergeGroup(srv, disk, keepPath, dupPaths, user) {
  const result = { linked: 0, copied: 0, failed: 0, sizeMismatch: 0, hashMismatch: 0 };
  const t = srv.resolveTarget({ disk, path: '' }, user || null);
  if (t.error) { result.error = t.error; return result; }
  const root = t.root;

  const safe = (p) => {
    const rel = String(p || '');
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) return null;
    const abs = path.join(root, rel);
    if (!abs.startsWith(root + path.sep) && abs !== root) return null;
    return abs;
  };

  const keepAbs = safe(keepPath);
  if (!keepAbs) { result.error = '非法保留路径'; return result; }
  let keepSt = null;
  try { keepSt = fs.statSync(keepAbs); } catch { result.error = '保留文件不存在'; return result; }

  /* R9-OP-4：保留文件的内容哈希只算一次（完整 SHA-256，不截断） */
  let keepHash = '';
  const hashOf = async (abs, size) => {
    try { return await hashFileFull(abs); } catch { return ''; }
  };

  for (const dup of Array.isArray(dupPaths) ? dupPaths : []) {
    const dupAbs = safe(dup);
    if (!dupAbs || dupAbs === keepAbs) { result.failed++; continue; }
    try {
      const dupSt = fs.statSync(dupAbs);
      // 校验：同为文件、同文件系统(dev)、内容相同（同 inode 则本就是硬链接）
      if (!dupSt.isFile()) { result.failed++; continue; }
      if (dupSt.dev !== keepSt.dev) { result.failed++; continue; }  // 跨文件系统，硬链接不可行
      if (dupSt.ino === keepSt.ino) { result.linked++; continue; }  // 已是同一 inode
      /* R9-OP-4：大小必须一致 —— 不一致就拒绝合并（宁可重复也不丢数据） */
      if (dupSt.size !== keepSt.size) { result.failed++; result.sizeMismatch++; continue; }
      if (!keepHash) keepHash = await hashOf(keepAbs, keepSt.size);
      const dupHash = await hashOf(dupAbs, dupSt.size);
      if (!keepHash || !dupHash) { result.failed++; continue; }
      if (dupHash !== keepHash) { result.failed++; result.hashMismatch++; continue; }  // 内容已变，放弃
      /* 先建临时硬链接再原子换名：任何一步失败原文件都完好 */
      const tmpLink = dupAbs + '.dedup-' + crypto.randomBytes(6).toString('hex');
      try {
        fs.linkSync(keepAbs, tmpLink);
        /* 临时链接的大小必须与保留文件一致，否则说明 stat 与实际不符，宁可放弃 */
        if (fs.statSync(tmpLink).size !== keepSt.size) throw new Error('size mismatch');
        try { fs.renameSync(tmpLink, dupAbs); } catch (e) { fs.unlinkSync(tmpLink); throw e; }
        result.linked++;
        srv.audit({ userObj: user, action: 'dedup-merge', disk: t.disk, path: String(dup), detail: '→ 硬链接至 ' + keepPath });
      } catch { result.failed++; }
    } catch { result.failed++; }
  }
  if (result.linked) { try { srv.invalidateSizeCache && srv.invalidateSizeCache(); } catch { /* 忽略 */ } }
  return result;
}

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  let fail = 0;
  let pass = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`✓  ${name}`); }
    else { fail++; console.log(`✗  ${name}${extra ? '  →  ' + extra : ''}`); }
  };
  (async () => {
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deduptest-'));
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } };
    const audits = [];
    const fakeSrv = {
      cfg: { dataDir: tmp },
      resolveTarget(q) { return { root: path.join(tmp, 'storage'), abs: path.join(tmp, 'storage', q.path || ''), disk: q.disk }; },
      audit(rec) { audits.push(rec); },
      invalidateSizeCache() {},
    };
    const root = path.join(tmp, 'storage');
    fs.mkdirSync(root, { recursive: true });

    // 造数据：a/b 内容相同(>1MB)，c 内容不同但同大小，d 小文件不扫，e/f 已互为硬链接
    const big1 = crypto.randomBytes(1.5 * 1024 * 1024);
    fs.writeFileSync(path.join(root, 'a.bin'), big1);
    fs.writeFileSync(path.join(root, 'b.bin'), big1);
    const sameSizeDiff = Buffer.from(big1); sameSizeDiff[0] ^= 0xff;
    fs.writeFileSync(path.join(root, 'c.bin'), sameSizeDiff);
    fs.writeFileSync(path.join(root, 'small.bin'), crypto.randomBytes(1024)); // 低于 minSize
    fs.writeFileSync(path.join(root, 'e.bin'), big1);
    try { fs.linkSync(path.join(root, 'e.bin'), path.join(root, 'f.bin')); } catch { /* 平台不支持也不影响其余用例 */ }
    fs.mkdirSync(path.join(root, '.recycle'), { recursive: true });
    fs.writeFileSync(path.join(root, '.recycle', 'a.bin'), big1);   // 系统目录跳过

    const r = await findDuplicates(fakeSrv, 'public', { minSize: 1024 * 1024 });
    check('只发现 1 组重复', r.groups.length === 1, JSON.stringify(r.groups.map((g) => g.map((f) => f.path))));
    const g = r.groups[0] || [];
    const paths = g.map((f) => f.path).sort();
    check('组内含 a/b 不含 c', paths.includes('a.bin') && paths.includes('b.bin') && !paths.includes('c.bin'), paths.join(','));
    check('e/f 同 inode 只计一次', !paths.includes('f.bin'), paths.join(','));
    check('小文件不扫描', !r.scanned.toString().includes('small') && !paths.includes('small.bin'));
    check('系统目录跳过', !paths.some((p) => p.includes('.recycle')));
    check('sha256 已填充', g.length > 0 && /^[0-9a-f]{64}$/.test(g[0].sha256 || ''));
    check('记录带大小', g.length > 0 && g[0].size === big1.length);
    check('可节省字节统计', r.bytes >= 1.5 * 1024 * 1024);

    // 合并：保留 a，b 替换为硬链接
    const m = await mergeGroup(fakeSrv, 'public', 'a.bin', ['b.bin', '不存在.bin'], { username: '测试员' });
    check('合并 linked=1 failed=1', m.linked === 1 && m.failed === 1, JSON.stringify(m));
    const sa = fs.statSync(path.join(root, 'a.bin'));
    const sb = fs.statSync(path.join(root, 'b.bin'));
    check('b 已成为 a 的硬链接', sa.ino === sb.ino && sa.nlink >= 2);
    check('审计 dedup-merge', audits.some((x) => x.action === 'dedup-merge'));
    check('合并后无临时文件残留', !fs.readdirSync(root).some((f) => f.includes('.dedup-')));

    // 路径穿越拒绝
    const m2 = await mergeGroup(fakeSrv, 'public', '../../etc/passwd', [], null);
    check('非法保留路径拒绝', !!m2.error);

    // 再次扫描：b 已并入 a 的 inode；e/f 同 inode 只计一次 → 仅剩 [a.bin, e.bin] 一组
    const r2 = await findDuplicates(fakeSrv, 'public', { minSize: 1024 * 1024 });
    check('合并后仅剩一组且不含 b/f',
      r2.groups.length === 1 &&
      r2.groups[0].map((f) => f.path).sort().join(',') === 'a.bin,e.bin',
      JSON.stringify(r2.groups.map((x) => x.map((f) => f.path))));

    /* ---- R9-OP-4：大文件键冲突（截断哈希会撞键 → 合并即丢数据） ----
       用可注入的小阈值模拟「>1GB 的文件」：两个文件头部完全相同、
       尾部不同 —— 旧实现只哈希前 1GB，会把它们判成同一份并互相覆盖。 */
    const TH = 1024;                       // 注入阈值：超过它的文件算「大文件」
    const head = crypto.randomBytes(8 * 1024);
    const tailA = crypto.randomBytes(4 * 1024);
    const tailB = crypto.randomBytes(4 * 1024);
    fs.writeFileSync(path.join(root, 'big1.bin'), Buffer.concat([head, tailA]));
    fs.writeFileSync(path.join(root, 'big2.bin'), Buffer.concat([head, tailB]));
    const rBig = await findDuplicates(fakeSrv, 'public', { minSize: 1024, maxHashBytes: TH });
    const bigPaths = rBig.groups.flat().map((f) => f.path);
    check('大文件头部相同但尾部不同不被判为重复', !(bigPaths.includes('big1.bin') && bigPaths.includes('big2.bin')), bigPaths.join(','));
    check('超阈值记录标记为 big', rBig.groups.flat().some((f) => f.big === true));

    // 即便有人强行要求合并，也必须因为内容不同而拒绝
    const before1 = fs.readFileSync(path.join(root, 'big1.bin'));
    const before2 = fs.readFileSync(path.join(root, 'big2.bin'));
    const mBig = await mergeGroup(fakeSrv, 'public', 'big1.bin', ['big2.bin'], null);
    check('键冲突的大文件拒绝合并', mBig.linked === 0 && mBig.hashMismatch === 1, JSON.stringify(mBig));
    check('被拒合并后内容分毫未动',
      fs.readFileSync(path.join(root, 'big1.bin')).equals(before1) &&
      fs.readFileSync(path.join(root, 'big2.bin')).equals(before2));

    /* ---- 大小不一致必须拒绝合并 ---- */
    fs.writeFileSync(path.join(root, 's1.bin'), Buffer.concat([head, tailA]));
    fs.writeFileSync(path.join(root, 's2.bin'), Buffer.concat([head, tailA, Buffer.from('X')]));
    const mSize = await mergeGroup(fakeSrv, 'public', 's1.bin', ['s2.bin'], null);
    check('大小不一致拒绝合并', mSize.linked === 0 && mSize.sizeMismatch === 1, JSON.stringify(mSize));
    check('大小不一致时两文件都还在',
      fs.existsSync(path.join(root, 's1.bin')) && fs.existsSync(path.join(root, 's2.bin')));

    /* ---- 同内容同大小可以正常合并 ---- */
    const same = crypto.randomBytes(64 * 1024);
    fs.writeFileSync(path.join(root, 'd1.bin'), same);
    fs.writeFileSync(path.join(root, 'd2.bin'), same);
    const mOk = await mergeGroup(fakeSrv, 'public', 'd1.bin', ['d2.bin'], null);
    check('同内容同大小合并成功', mOk.linked === 1 && mOk.failed === 0, JSON.stringify(mOk));
    const d1 = fs.statSync(path.join(root, 'd1.bin'));
    const d2 = fs.statSync(path.join(root, 'd2.bin'));
    check('合并后同一 inode', d1.ino === d2.ino);
    check('合并后内容不变', fs.readFileSync(path.join(root, 'd2.bin')).equals(same));

    cleanup();
    console.log(`\n断言 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
    if (fail) { console.log('自测未通过'); process.exit(1); }
    console.log('自测全部通过');
    process.exit(0);
  })().catch((e) => {
    console.error('✗  自测异常:', e);
    process.exit(1);
  });
}

module.exports = { findDuplicates, mergeGroup, HEAD_BYTES, MAX_HASH_BYTES, hashFileFull };

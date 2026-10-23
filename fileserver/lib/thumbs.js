'use strict';

/* =====================================================================
   lib/thumbs.js — 缩略图缓存（零依赖）
   ─────────────────────────────────────────────────────────────────────
   架构说明（为何「前端生成 WebP 上传、服务端只存取」）：
   本服务器跑在 Android Termux 的 Node 环境且严格零依赖，Node 原生
   无法解码 JPEG/PNG/HEIC 等图像——没有 libvips/sharp，也没有 Canvas；
   在手机 CPU 上用纯 JS 软解大图既慢又耗电，Termux 编译原生库更是
   需要完整工具链且极易失败。因此解码与压缩交由前端浏览器完成
   （Canvas → canvas.toBlob('image/webp')，移动端浏览器硬件加速、
   效果最好），服务端只负责：键值生成 → 存取 → 过期清理。
   缓存目录：<dataDir>/thumbs/<key>.webp，key 绑定 mtime，文件一变
   缓存即自然失效，无需主动淘汰。

   ---------------------------------------------------------------------
   R9-PERF-3  临时文件残留 / 并发无上限
   ---------------------------------------------------------------------
   原来落盘用「固定名字的临时文件」+「失败时才 unlink」：
     · tmp 名只带 pid → **同进程内并发写同一个 key 会互相覆盖**，
       A 正在写的 tmp 被 B rename 走，落盘出来的是半截数据；
     · 进程被 kill / 断电时 tmp 留在磁盘上，**没有任何回收机制**，
       翻页几百次就攒出一堆几十 KB 的垃圾，把存储盘塞满；
     · 一次翻页会同时请求几十张缩略图，服务端来多少接多少，
       内存峰值没有闸门。
   现在：
     · tmp 名带 pid + 序号 + 随机串 → 并发互不干扰；
     · try/finally 保证「临时文件一定被删」（成功 rename 掉、失败 unlink 掉）；
     · 启动时清理**超过 24 小时**的残留 tmp（只看符合本模块命名规则的文件，
       按 mtime 判断，绝不会误删用户文件或正常的 .webp 缓存）；
     · 并发闸门（信号量）：同一时刻最多处理 N 张缩略图，
       避免一次翻页把内存打满。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 单张缩略图体积上限（WebP 小图通常 < 50KB，200KB 留足余量） */
const MAX_THUMB_BYTES = 200 * 1024;

/** R9-PERF-3：同时处理的缩略图数量上限（内存闸门） */
const MAX_CONCURRENT_THUMBS = (() => {
  const v = Number(process.env.THUMBS_MAX_CONCURRENCY);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 8;
})();

/** R9-PERF-3：启动清理阈值 —— 只删超过 24 小时的残留临时文件 */
const STALE_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/* R9-PERF-3：本模块的临时文件命名规则：<key>.webp.tmp-<pid>-<seq>-<rand>
   清理时**只认这个规则**，绝不动其它文件（用户文件、其他模块的 tmp 都不匹配）。 */
const TMP_NAME_RE = /^[0-9a-f]{4,64}\.webp\.tmp-[\w-]+$/i;

let tmpSeq = 0;

/**
 * 生成一个唯一的临时文件路径。
 * 为什么要唯一：原来只带 pid，同进程并发写同一个 key 时，
 * 两个调用会写同一个 tmp 文件 → rename 时互相吃掉对方的数据。
 */
function tmpPathFor(p) {
  tmpSeq = (tmpSeq + 1) % 1000000;
  const rand = crypto.randomBytes(4).toString('hex');
  return p + '.tmp-' + process.pid + '-' + tmpSeq + '-' + rand;
}

/* ------------------------------ R9-PERF-3 并发闸门 ------------------------------ */

/**
 * 极简信号量（计数信号量，无第三方依赖）。
 * 作用：限制同一时刻在飞的缩略图处理数。
 * 一次翻页可能同时来几十个缩略图请求，全部并行处理会让内存峰值不可控；
 * 排队处理只是把峰值削平，总耗时不变。
 */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Math.floor(Number(limit)) || 1);
    this.active = 0;
    this.peak = 0;        // 历史峰值（自测/观测用）
    this.total = 0;       // 累计放行数
    this._q = [];
  }
  acquire() {
    if (this.active < this.limit) {
      this.active++;
      this.total++;
      if (this.active > this.peak) this.peak = this.active;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._q.push(() => {
        this.active++;
        this.total++;
        if (this.active > this.peak) this.peak = this.active;
        resolve();
      });
    });
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this._q.shift();
    if (next) next();
  }
  /** 在信号量保护下执行 fn（无论成功失败都会释放） */
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
  stats() {
    return { limit: this.limit, active: this.active, peak: this.peak, total: this.total, waiting: this._q.length };
  }
}

/** 模块级共享闸门（所有调用方共用一个上限） */
const thumbGate = new Semaphore(MAX_CONCURRENT_THUMBS);

/**
 * 生成缩略图缓存键：sha1('disk|rel|mtimeMs')
 * mtime 参与哈希保证源文件变更后键变化（旧缓存自然失效）
 */
function thumbKey(disk, relPath, mtimeMs) {
  return crypto.createHash('sha1')
    .update(String(disk) + '|' + String(relPath) + '|' + String(mtimeMs))
    .digest('hex');
}

/** 缓存文件的绝对路径 <dataDir>/thumbs/<key>.webp */
function thumbPath(srv, key) {
  // key 只应是十六进制哈希，防御路径穿越
  if (!/^[0-9a-f]{4,64}$/i.test(String(key))) throw new Error('非法缩略图键');
  return path.join(srv.cfg.dataDir, 'thumbs', key.toLowerCase() + '.webp');
}

/** 读取缓存缩略图；不存在或损坏返回 null */
function getThumb(srv, key) {
  try {
    const p = thumbPath(srv, key);
    const buf = fs.readFileSync(p);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * 保存缩略图（>200KB 拒绝；tmp+rename 原子落盘），返回是否成功。
 * R9-PERF-3：tmp 名字唯一 + try/finally 保证临时文件一定被清掉。
 */
function saveThumb(srv, key, buf) {
  let p;
  try { p = thumbPath(srv, key); } catch { return false; }
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_THUMB_BYTES) return false;
  const tmp = tmpPathFor(p);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, p);       // 成功：临时文件被「消费」掉了
    return true;
  } catch {
    return false;
  } finally {
    /* R9-PERF-3：走到这里说明 rename 没成功（或根本没走到），
       临时文件必须删掉 —— 否则磁盘上会越攒越多垃圾。
       rename 成功时文件已不存在，unlink 会抛 ENOENT，忽略即可。 */
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

/**
 * R9-PERF-3：保存缩略图（异步，走并发闸门）。
 * 服务端批量落盘时用这个，避免一次翻页把内存打满。
 */
async function saveThumbAsync(srv, key, buf, gate) {
  const g = gate || thumbGate;
  return g.run(async () => saveThumb(srv, key, buf));
}

/**
 * R9-PERF-3：清理残留的临时文件（只删超过 maxAgeMs 的，且只认本模块命名规则）。
 * @param {object} srv
 * @param {number} [maxAgeMs] 默认 24 小时
 * @returns {{removed:number, kept:number, scanned:number}}
 */
function cleanupStaleTemp(srv, maxAgeMs) {
  const age = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : STALE_TMP_MAX_AGE_MS;
  const dir = path.join(srv.cfg.dataDir, 'thumbs');
  const cutoff = Date.now() - age;
  let removed = 0, kept = 0, scanned = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { removed, kept, scanned }; }
  for (const n of names) {
    if (!TMP_NAME_RE.test(n)) continue;   // 只认自己的 tmp 命名，绝不误删
    scanned++;
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) { kept++; continue; }
      if (st.mtimeMs < cutoff) { fs.unlinkSync(p); removed++; } else kept++;
    } catch { kept++; /* 单个失败不中断 */ }
  }
  return { removed, kept, scanned };
}

/**
 * R9-PERF-3：启动初始化 —— 清理超龄残留临时文件。
 * 建议在服务启动时调用一次（幂等，重复调用无副作用）。
 */
function initThumbs(srv) {
  const r = cleanupStaleTemp(srv);
  return r;
}

/** 清理超过 maxAgeDays 未访问（mtime）的缩略图，返回删除数量 */
function pruneThumbs(srv, maxAgeDays = 90) {
  const dir = path.join(srv.cfg.dataDir, 'thumbs');
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.webp')) continue;
    const p = path.join(dir, n);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
    } catch { /* 单个失败不中断 */ }
  }
  return removed;
}

/**
 * 批量缓存探测：keys → { hit: [命中的key], miss: [未命中的key] }
 * 供前端一次请求判断哪些缩略图可直接取、哪些需要本地生成后上传
 */
function filterThumbs(srv, keys) {
  const hit = [], miss = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    if (getThumb(srv, k)) hit.push(k); else miss.push(k);
  }
  return { hit, miss };
}

/**
 * R9-PERF-3：批量缓存探测（异步，走并发闸门）。
 * 与同步版结果一致，只是并发受限、不会把内存峰值拉高。
 */
async function filterThumbsAsync(srv, keys, gate) {
  const g = gate || thumbGate;
  const list = Array.isArray(keys) ? keys : [];
  const results = await Promise.all(list.map((k) => g.run(async () => !!getThumb(srv, k))));
  const hit = [], miss = [];
  list.forEach((k, i) => { if (results[i]) hit.push(k); else miss.push(k); });
  return { hit, miss };
}

module.exports = {
  thumbKey, thumbPath, getThumb, saveThumb, saveThumbAsync, pruneThumbs, filterThumbs,
  filterThumbsAsync, cleanupStaleTemp, initThumbs, Semaphore, thumbGate,
  MAX_THUMB_BYTES, MAX_CONCURRENT_THUMBS, STALE_TMP_MAX_AGE_MS,
};

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('✓ ' + name); }
    else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
  };
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbtest-'));
  const fakeSrv = { cfg: { dataDir: tmpDir } };
  const thumbDir = path.join(tmpDir, 'thumbs');
  const listDir = () => { try { return fs.readdirSync(thumbDir); } catch { return []; } };
  const tmpFiles = () => listDir().filter((n) => n.indexOf('.tmp-') >= 0);

  (async () => {
    try {
      /* 键：mtime 变化 → 键变化；同输入稳定 */
      const k1 = thumbKey('public', 'a.jpg', 1000);
      const k2 = thumbKey('public', 'a.jpg', 2000);
      const k3 = thumbKey('public', 'a.jpg', 1000);
      check('键长度=sha1(40位hex)', /^[0-9a-f]{40}$/.test(k1));
      check('mtime 变化键变化', k1 !== k2);
      check('同输入键稳定', k1 === k3);

      /* 存取回环 */
      const buf = Buffer.from('RIFF0000WEBPVP8 fake');
      check('保存成功', saveThumb(fakeSrv, k1, buf) === true);
      check('读取回环', getThumb(fakeSrv, k1).equals(buf));
      check('未命中为 null', getThumb(fakeSrv, k2) === null);

      /* 超限拒绝 */
      check('超 200KB 拒绝', saveThumb(fakeSrv, k1, Buffer.alloc(201 * 1024)) === false);
      check('空 buffer 拒绝', saveThumb(fakeSrv, k1, Buffer.alloc(0)) === false);
      check('非法键拒绝', saveThumb(fakeSrv, '../evil', buf) === false);

      /* 批量探测 */
      const r = filterThumbs(fakeSrv, [k1, k2]);
      check('filterThumbs hit/miss', r.hit.length === 1 && r.hit[0] === k1 && r.miss.length === 1 && r.miss[0] === k2);

      /* R9-PERF-3 保存失败后无残留临时文件 */
      // 造一个「目标是目录」的现场：rename 必然失败 → 走 finally 清理分支
      const kFail = thumbKey('public', 'fail.jpg', 4242);
      const failPath = thumbPath(fakeSrv, kFail);
      fs.mkdirSync(failPath, { recursive: true });
      const okFail = saveThumb(fakeSrv, kFail, buf);
      check('写入失败时返回 false', okFail === false);
      check('写入失败后无残留临时文件', tmpFiles().length === 0, JSON.stringify(tmpFiles()));
      try { fs.rmSync(failPath, { recursive: true, force: true }); } catch { /* 忽略 */ }

      /* R9-PERF-3 并发保存同一个 key：tmp 名唯一，互不打架 */
      const kRace = thumbKey('public', 'race.jpg', 777);
      const results = await Promise.all([
        saveThumbAsync(fakeSrv, kRace, Buffer.from('A')),
        saveThumbAsync(fakeSrv, kRace, Buffer.from('B')),
        saveThumbAsync(fakeSrv, kRace, Buffer.from('C')),
      ]);
      check('并发保存全部成功', results.every((x) => x === true));
      check('并发保存后无残留临时文件', tmpFiles().length === 0, JSON.stringify(tmpFiles()));
      const raced = getThumb(fakeSrv, kRace);
      check('并发保存后内容完整', !!raced && ['A', 'B', 'C'].includes(raced.toString()));

      /* R9-PERF-3 启动清理：只删超龄且符合命名规则的 tmp */
      const staleName = k1 + '.webp.tmp-999-1-deadbeef';
      const freshName = k2 + '.webp.tmp-999-2-cafe';
      fs.writeFileSync(path.join(thumbDir, staleName), 'x');
      fs.writeFileSync(path.join(thumbDir, freshName), 'x');
      const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(path.join(thumbDir, staleName), past, past);
      const cleanup = cleanupStaleTemp(fakeSrv);
      check('启动清理删掉了超龄残留', cleanup.removed === 1, JSON.stringify(cleanup));
      check('超龄残留确实没了', !fs.existsSync(path.join(thumbDir, staleName)));
      check('新鲜临时文件被保留', fs.existsSync(path.join(thumbDir, freshName)));
      check('正常缓存文件未被误删', fs.existsSync(thumbPath(fakeSrv, k1)));

      /* 无关文件绝不能被删（防误删） */
      const alien = path.join(thumbDir, 'not-ours.txt');
      fs.writeFileSync(alien, 'x');
      fs.utimesSync(alien, past, past);
      cleanupStaleTemp(fakeSrv);
      check('无关文件不被清理', fs.existsSync(alien));

      /* R9-PERF-3 并发闸门：同时在飞的数量不超过上限 */
      const gate = new Semaphore(3);
      let inFlight = 0, maxInFlight = 0;
      await Promise.all(Array.from({ length: 20 }, () => gate.run(async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
      })));
      check('并发上限生效', maxInFlight <= 3, 'maxInFlight=' + maxInFlight);
      check('并发任务全部完成', gate.stats().total === 20, JSON.stringify(gate.stats()));

      /* 模块级闸门同样有上限 */
      const g2 = new Semaphore(1);
      let order = [];
      await Promise.all([
        g2.run(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 5)); order.push('a-end'); }),
        g2.run(async () => { order.push('b-start'); order.push('b-end'); }),
      ]);
      check('信号量串行化同限任务', order.join(',') === 'a-start,a-end,b-start,b-end', order.join(','));

      /* 过期清理 */
      check('未过期不删', pruneThumbs(fakeSrv, 90) === 0);
      const old = thumbPath(fakeSrv, k1);
      const past2 = Date.now() - 100 * 86400000;
      fs.utimesSync(old, new Date(past2), new Date(past2));
      check('过期删除 1 个', pruneThumbs(fakeSrv, 90) === 1);
      check('删除后未命中', getThumb(fakeSrv, k1) === null);

      /* 异步批量探测 */
      const kKeep = thumbKey('public', 'keep.jpg', 5);
      saveThumb(fakeSrv, kKeep, buf);
      const ar = await filterThumbsAsync(fakeSrv, [kKeep, k2]);
      check('filterThumbsAsync hit/miss', ar.hit.length === 1 && ar.hit[0] === kKeep && ar.miss.length === 1);

      console.log('');
      console.log('断言 ' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + ' 项）');
      if (fail) { console.log('✗ 存在失败项'); process.exit(1); }
      console.log('✓ 全部通过');
      process.exit(0);
    } catch (e) {
      console.error('自测异常：', e && e.stack ? e.stack : e);
      process.exit(1);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  })();
}

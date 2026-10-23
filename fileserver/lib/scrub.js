'use strict';

/* =====================================================================
 * lib/scrub.js — 完整性巡检（SHA-256 清单 + 静默损坏检测）
 *
 * 设计要点：
 *  - buildManifest：流式计算每块文件 SHA-256（64KB 分块读，避免大文件占内存），
 *    清单写 dataDir/scrub/<安全盘名>.json。
 *  - verifyManifest：对照清单重算，区分 missing（清单有盘上无）与 corrupted（哈希不符，
 *    即静默损坏），并统计盘上新增（清单未覆盖）文件的字节数 newSize。报告追加写
 *    dataDir/scrub/<盘名>.report.json（保留最近 1 份＝覆盖写）。
 *  - 跳过 .recycle / .versions / .snapshots（与系统目录约定一致）。
 *  - 单文件容错：stat/hash 失败的文件跳过，不中断整体巡检。
 * ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HIDDEN = new Set(['.recycle', '.versions', '.snapshots', '.fs-probe']);
const CHUNK = 64 * 1024; // 64KB 分块

/* ---------- 安全盘名：盘符可能含 ':'（ext:UUID）需转义 ---------- */
function safeDiskName(disk) {
  return String(disk).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/* ---------- 流式 SHA-256（Promise 封装） ---------- */
function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(abs, { highWaterMark: CHUNK });
    rs.on('data', (d) => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

/* ------------------------------------------------------------------
 * buildManifest — 构建全盘 SHA-256 清单
 *   返回 { ok, files, bytes } 或 { ok:false, error, code }
 * ------------------------------------------------------------------ */
async function buildManifest(srv, disk, user) {
  const t = srv.resolveTarget({ disk, path: '', _write: false }, user);
  if (t.error) return { ok: false, error: t.error, code: t.code };
  const root = t.root;

  const files = {};
  let bytes = 0;

  const walk = async (dir, relPrefix) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (HIDDEN.has(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const rel = relPrefix ? relPrefix + '/' + name : name;
      if (st.isDirectory()) { await walk(full, rel); continue; }
      try {
        const hash = await sha256File(full);
        files[rel] = { size: st.size, sha256: hash };
        bytes += st.size;
      } catch (e) {
        // 读取失败（EACCES 等）跳过该文件
      }
    }
  };

  await walk(root, '');

  const outDir = path.join(srv.cfg.dataDir, 'scrub');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {
    return { ok: false, error: '无法写入清单目录：' + e.message };
  }
  const meta = { time: Date.now(), disk, files };
  try {
    fs.writeFileSync(path.join(outDir, safeDiskName(disk) + '.json'), JSON.stringify(meta));
  } catch (e) {
    return { ok: false, error: '清单写入失败：' + e.message };
  }
  return { ok: true, files: Object.keys(files).length, bytes };
}

/* ------------------------------------------------------------------
 * verifyManifest — 对照清单巡检静默损坏
 *   返回 { ok, checked, missing:[], corrupted:[], newSize }
 *     missing   : 清单有、盘上无（可能已被删/搬走）
 *     corrupted : 哈希不符（文件被静默改坏）——size 不符直接判 corrupted
 *     newSize   : 盘上新增（清单未覆盖）文件的字节总量（增量监控）
 *   报告写 dataDir/scrub/<盘名>.report.json（覆盖＝保留最近 1 份）
 * ------------------------------------------------------------------ */
async function verifyManifest(srv, disk, user) {
  const outDir = path.join(srv.cfg.dataDir, 'scrub');
  const manifestPath = path.join(outDir, safeDiskName(disk) + '.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, error: '清单不存在或读取失败：' + e.message }; }

  const t = srv.resolveTarget({ disk, path: '', _write: false }, user);
  if (t.error) return { ok: false, error: t.error, code: t.code };
  const root = t.root;

  const manifestFiles = manifest.files || {};
  const manifestRels = new Set(Object.keys(manifestFiles));
  const seen = new Set();

  const missing = [];
  const corrupted = [];
  let checked = 0;
  let newSize = 0;

  const walk = async (dir, relPrefix) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (HIDDEN.has(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const rel = relPrefix ? relPrefix + '/' + name : name;
      if (st.isDirectory()) { await walk(full, rel); continue; }

      seen.add(rel);
      if (manifestRels.has(rel)) {
        const rec = manifestFiles[rel];
        // size 不符直接判损坏（无需重算 hash）
        if (rec.size !== st.size) { corrupted.push(rel); continue; }
        try {
          const hash = await sha256File(full);
          if (hash === rec.sha256) checked++;
          else corrupted.push(rel);
        } catch (e) {
          // 读取失败按损坏登记，提示需关注
          corrupted.push(rel);
        }
      } else {
        // 清单未覆盖的新文件
        newSize += st.size;
      }
    }
  };

  await walk(root, '');

  // 清单里有、盘上没见到的 → 缺失
  for (const rel of manifestRels) {
    if (!seen.has(rel)) missing.push(rel);
  }

  // 写报告（覆盖＝保留最近 1 份）
  const report = {
    time: Date.now(), disk,
    checked, missing, corrupted, newSize,
    missingCount: missing.length, corruptedCount: corrupted.length,
  };
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, safeDiskName(disk) + '.report.json'), JSON.stringify(report));
  } catch { /* 报告写入失败不致命 */ }

  srv.audit({ userObj: user, action: 'scrub', disk, path: String(disk) });

  return { ok: true, checked, missing, corrupted, newSize };
}

/* ------------------------------------------------------------------
 * getReports — 最近巡检报告汇总
 *   读取 dataDir/scrub 下全部 *.report.json，返回 [{ disk, time, checked,
 *   missingCount, corruptedCount, newSize }]，按时间倒序。
 * ------------------------------------------------------------------ */
function getReports(srv) {
  const outDir = path.join(srv.cfg.dataDir, 'scrub');
  let names = [];
  try { names = fs.readdirSync(outDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.report.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(outDir, n), 'utf8'));
      out.push({
        disk: r.disk,
        time: r.time,
        checked: r.checked,
        missingCount: r.missingCount ?? (r.missing ? r.missing.length : 0),
        corruptedCount: r.corruptedCount ?? (r.corrupted ? r.corrupted.length : 0),
        newSize: r.newSize,
      });
    } catch { /* 单个坏报告忽略 */ }
  }
  out.sort((a, b) => (b.time || 0) - (a.time || 0));
  return out;
}

module.exports = { buildManifest, verifyManifest, getReports, safeDiskName };

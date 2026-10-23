'use strict';

/* =====================================================================
 * lib/merge.js — 跨盘聚合视图（统一命名空间）
 *
 * 取舍说明（重要）：
 *  - 本模块做的是「按盘聚合的统一入口」：把每块盘在聚合根下呈现为一个同名目录项
 *    （公共盘→"公共"，私人空间→"私人"，外置盘→"4T" 这类容量名），用户进入某盘目录
 *     即看到该盘真实内容。这解决了「多盘分散、需要来回切换盘符」的痛点。
 *  - 同盘符同名目录的「真合并」（mergerfs 全等价：把两块盘的同名目录内容合并到一处、
 *     写时按策略落盘）标注为后续增强，本期未实现。原因：真合并需要写时路由策略
 *     （first/free/fpfs 等）、去重视图与跨盘删除语义，复杂度高且与现有单盘
 *     resolveTarget 模型冲突。本期聚合视图「进入即落在单盘」，语义清晰、零风险。
 *  - 显示名逻辑与 lib/dav.js 的 davDiskName 保持一致（不 import dav，自行实现同款），
 *    保证 WebDAV 挂载名与聚合视图名一致。
 * ===================================================================== */

const fs = require('fs');
const path = require('path');

const TB = 1099511627776; // 2^40，外置盘容量推导用

/* ---------- 盘显示名（与 dav.js::davDiskName 同款） ---------- */
function davDiskName(d) {
  if (d.id === 'public') return '公共';
  if (d.id === 'private') return '私人';
  if (d.id.startsWith('ext:')) {
    if (d.title) return d.title;                        // 用户设定的显示名优先
    const tb = (d.quota || 0) / TB;
    if (tb >= 0.5) return Math.round(tb) + 'T';         // 4000769372160 → 4T
    return 'ext-' + d.id.slice(4);                      // 容量未知回退稳定名
  }
  return d.id;
}

/* ---------- 构造 显示名→盘id 的反查表（含两块同容量盘去重） ---------- */
function buildNameMap(srv, user) {
  const disks = srv.listDisks(user);
  const used = new Set();
  const map = {};
  for (const d of disks) {
    let nm = davDiskName(d);
    if (used.has(nm)) nm += '-' + d.id.slice(-4);        // 同容量盘加 UUID 尾缀去重
    used.add(nm);
    map[nm] = d.id;
  }
  return map;
}

/* ------------------------------------------------------------------
 * listMergeRoot — 聚合根：每块盘一个同名目录项
 *   返回 [{ name, disk, kind:'disk' }]
 * ------------------------------------------------------------------ */
function listMergeRoot(srv, user) {
  const map = buildNameMap(srv, user);
  return Object.keys(map).map((name) => ({ name, disk: map[name], kind: 'disk' }));
}

/* ------------------------------------------------------------------
 * resolveMerge — 解析聚合视图相对路径
 *   relPath 首段是盘显示名（或盘符别名）→ 反查真实 disk，其余为盘内相对路径。
 *   找不到返回 { error:'聚合视图中无此路径', code:404 }
 *   成功返回 { disk, rel, target }（target = 解析后的绝对路径）
 * ------------------------------------------------------------------ */
function resolveMerge(srv, user, relPath, write) {
  const rel = String(relPath || '').replace(/^\/+/, '').replace(/\/+$/g, '');
  if (!rel) return { error: '聚合视图中无此路径', code: 404 };

  const seg = rel.split('/');
  const first = decodeURIComponent(seg[0]);
  const rest = seg.slice(1).join('/');

  // 1) 显示名表
  let disk = buildNameMap(srv, user)[first];

  // 2) 别名兼容：公共/私人/public/private/ext-UUID/4T/ext:UUID
  if (!disk) {
    if (first === '公共') disk = 'public';
    else if (first === '私人') disk = 'private';
    else if (first === 'public' || first === 'private') disk = first;
    else {
      const m = /^ext-(.+)$/.exec(first);                // 旧式 ext-UUID
      if (m) disk = 'ext:' + m[1];
      else if (first.startsWith('ext:')) disk = first;   // 直接写法
      else {
        const mt = /^(\d+(?:\.\d+)?)T$/i.exec(first);    // 4T → 按容量匹配
        if (mt) {
          const want = parseFloat(mt[1]);
          const hit = srv.listDisks(user)
            .find((d) => d.id.startsWith('ext:') && Math.round((d.quota || 0) / TB) === want);
          if (hit) disk = hit.id;
        }
      }
    }
  }

  if (!disk) return { error: '聚合视图中无此路径', code: 404 };

  const t = srv.resolveTarget({ disk, path: rest, _write: !!write }, user);
  if (t.error) return { error: '聚合视图中无此路径', code: 404 };
  return { disk, rel: rest, target: t.abs };
}

/* ------------------------------------------------------------------
 * listMergedDir — 单盘目录列表（隐藏系统目录）
 *   成功返回条目数组 [{ name, isDir, size, mtime }]；
 *   解析失败返回 { error, code }（调用方用 Array.isArray 区分）。
 * ------------------------------------------------------------------ */
function listMergedDir(srv, user, disk) {
  const t = srv.resolveTarget({ disk, path: '', _write: false }, user);
  if (t.error) return { error: t.error, code: t.code };

  const HIDE = new Set(['.recycle', '.versions', '.snapshots', '.fs-probe']);
  let names = [];
  try { names = fs.readdirSync(t.abs); } catch (e) { return { error: e.message }; }

  const entries = [];
  for (const name of names) {
    if (HIDE.has(name)) continue;
    let st;
    try { st = fs.statSync(path.join(t.abs, name)); } catch { continue; }
    entries.push({
      name,
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
    });
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return entries;
}

module.exports = { listMergeRoot, resolveMerge, listMergedDir, davDiskName, TB };

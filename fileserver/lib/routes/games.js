'use strict';

/**
 * P1 游戏中心 · 可插拔路由模块（/api/games/*）
 *
 * 设计目标（对应验收要求）：
 *   1. 合规目录由 games-catalog.js 提供（构建脚本从 catalog.json 生成，含 License/来源/树哈希）；
 *   2. 收藏 / 评分 / 最近游玩按**用户隔离**，落 data/games.json（0600，原子写）；
 *   3. 安装 / 更新 / 卸载是**真实文件操作**：
 *        games-lib/<id>        ← 只读本地仓库（部署时上传，不对外静态服务）
 *        public/games/<id>     ← 静态目录（安装 = 从 lib 复制，卸载 = 删除该目录）
 *      安装标记 .p1-install.json 记录版本/树哈希，用于“更新可用”判断；
 *   4. /api/games/sw.js 提供 Service Worker（只接管 /games/ 同源静态资源，缓存优先），
 *      用来对比“首次加载 vs 缓存命中后加载”；
 *   5. 旧接口 /api/games 不存在（实测 404），本模块同时接管 /api/games 作为 list 别名，不冲突。
 *
 * 安全：
 *   - 所有写操作要求登录；卸载/同步要求管理员；
 *   - id 必须是目录白名单（正则 + catalog 双重校验），从根源避免路径穿越；
 *   - 错误统一 { error: '中文原因' }。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const catalog = require('./games-catalog');
const { mimeOf } = require('../util');

const ROOT = path.resolve(__dirname, '..', '..'); // /opt/station/fileserver
const LIB_DIR = path.join(ROOT, 'games-lib');
const PUB_DIR = path.join(ROOT, 'public', 'games');
const COVERS_DIR = path.join(PUB_DIR, '_covers');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const GAMES = new Map(catalog.games.map((g) => [g.id, g]));
const ORDER = new Map(catalog.games.map((g, i) => [g.id, i]));
const CATEGORIES = catalog.categories || [];
const CAT_LABEL = new Map(CATEGORIES.map((c) => [c.id, c.label]));
const STATE_VERSION = 1;
const MAX_BODY = 64 * 1024;

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function dataFile(app) {
  const dir = (app && app.cfg && app.cfg.dataDir) || path.join(ROOT, 'data');
  return path.join(dir, 'games.json');
}

function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, games: {}, users: {} };
}

function normalizeState(raw) {
  const st = emptyState();
  if (!raw || typeof raw !== 'object') return st;
  st.updatedAt = Number(raw.updatedAt) || 0;
  if (raw.games && typeof raw.games === 'object') {
    for (const id of Object.keys(raw.games)) {
      if (!GAMES.has(id)) continue;
      const rec = raw.games[id];
      if (!rec || typeof rec !== 'object') continue;
      st.games[id] = {
        version: String(rec.version || ''),
        treeHash: String(rec.treeHash || ''),
        bytes: Number(rec.bytes) || 0,
        installedAt: Number(rec.installedAt) || 0,
        installedBy: String(rec.installedBy || ''),
      };
    }
  }
  if (raw.users && typeof raw.users === 'object') {
    for (const uid of Object.keys(raw.users)) {
      const rec = raw.users[uid];
      if (!rec || typeof rec !== 'object') continue;
      const favorites = Array.isArray(rec.favorites)
        ? rec.favorites.filter((id) => GAMES.has(id)) : [];
      const ratings = {};
      if (rec.ratings && typeof rec.ratings === 'object') {
        for (const id of Object.keys(rec.ratings)) {
          const n = Number(rec.ratings[id]);
          if (GAMES.has(id) && Number.isFinite(n) && n >= 1 && n <= 5) ratings[id] = Math.round(n);
        }
      }
      const recent = Array.isArray(rec.recent)
        ? rec.recent.filter((r) => r && GAMES.has(String(r.id))).slice(0, 20).map((r) => ({
          id: String(r.id), at: Number(r.at) || 0, count: Number(r.count) || 1,
        }))
        : [];
      st.users[uid] = { favorites, ratings, recent };
    }
  }
  return st;
}

function loadState(app) {
  const file = dataFile(app);
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return normalizeState(JSON.parse(txt));
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.error('[games] 读取 games.json 失败:', e.message);
    return emptyState();
  }
}

function saveState(app, state) {
  const file = dataFile(app);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  state.updatedAt = Date.now();
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const body = JSON.stringify(state, null, 2) + '\n';
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* 文件系统不支持时忽略 */ }
  return file;
}

function userKey(user) {
  if (!user) return null;
  return String(user.id || user.username || '');
}

function userRecord(state, user) {
  const key = userKey(user);
  if (!key) return null;
  if (!state.users[key]) state.users[key] = { favorites: [], ratings: {}, recent: [] };
  return state.users[key];
}

function gameOf(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return GAMES.get(id) || null;
}

function pubDirOf(id) {
  const dir = path.join(PUB_DIR, id);
  // 双保险：解析后的路径必须严格等于 PUB_DIR/<id>
  const resolved = path.resolve(dir);
  if (resolved !== path.resolve(PUB_DIR, id)) return null;
  return resolved;
}

function libDirOf(id) {
  const resolved = path.resolve(path.join(LIB_DIR, id));
  if (resolved !== path.resolve(LIB_DIR, id)) return null;
  return resolved;
}

function existsEntry(id, entry) {
  try {
    return fs.statSync(path.join(PUB_DIR, id, entry || 'index.html')).isFile();
  } catch (e) {
    return false;
  }
}

function readMarker(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PUB_DIR, id, '.p1-install.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeMarker(id, info) {
  const dir = pubDirOf(id);
  if (!dir) return;
  try {
    fs.writeFileSync(path.join(dir, '.p1-install.json'),
      JSON.stringify(info, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
  } catch (e) {
    console.error('[games] 写安装标记失败:', id, e.message);
  }
}

function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const item of list) {
      const p = path.join(d, item.name);
      if (item.isDirectory()) walk(p);
      else if (item.isFile()) {
        files++;
        try { bytes += fs.statSync(p).size; } catch (e) { /* 忽略 */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, force: true, preserveTimestamps: true });
}

function ratingStats(state) {
  const sum = new Map();
  const cnt = new Map();
  for (const uid of Object.keys(state.users)) {
    const r = state.users[uid].ratings || {};
    for (const id of Object.keys(r)) {
      sum.set(id, (sum.get(id) || 0) + r[id]);
      cnt.set(id, (cnt.get(id) || 0) + 1);
    }
  }
  return { sum, cnt };
}

function playStats(state) {
  const plays = new Map();
  for (const uid of Object.keys(state.users)) {
    for (const r of state.users[uid].recent || []) {
      plays.set(r.id, (plays.get(r.id) || 0) + (r.count || 1));
    }
  }
  return plays;
}

function installedInfo(id) {
  const g = GAMES.get(id);
  const installed = !!g && existsEntry(id, g.entry);
  const marker = installed ? readMarker(id) : null;
  return {
    installed,
    marker,
    updateAvailable: !!installed && (!marker || marker.treeHash !== g.treeHash ||
      String(marker.version || '') !== String(g.version || '')),
  };
}

function viewOf(g, state, user, rstats, pstats) {
  const { installed, marker, updateAvailable } = installedInfo(g.id);
  const rec = user ? (state.users[userKey(user)] || null) : null;
  const myRating = rec && rec.ratings[g.id] ? rec.ratings[g.id] : null;
  const favorite = !!(rec && rec.favorites.includes(g.id));
  const recent = rec ? rec.recent.find((r) => r.id === g.id) : null;
  const cnt = rstats.cnt.get(g.id) || 0;
  const avg = cnt ? Math.round((rstats.sum.get(g.id) / cnt) * 10) / 10 : 0;
  let cover = null;
  try {
    if (fs.statSync(path.join(COVERS_DIR, g.id + '.png')).isFile()) cover = '/games/_covers/' + g.id + '.png';
  } catch (e) { /* 无封面 */ }
  const entryEnc = String(g.entry || 'index.html').split('/').map(encodeURIComponent).join('/');
  return {
    id: g.id,
    name: g.name,
    nameEn: g.nameEn,
    category: g.category,
    categoryLabel: CAT_LABEL.get(g.category) || g.category,
    tags: g.tags || [],
    desc: g.desc,
    author: g.author,
    license: g.license,
    source: g.source,
    version: g.version,
    entry: g.entry,
    sizeBytes: g.sizeBytes,
    fileCount: g.fileCount,
    treeHash: g.treeHash,
    modifications: g.modifications || [],
    installed,
    installedVersion: marker ? marker.version : null,
    updateAvailable,
    cover,
    playUrl: installed ? '/games/' + g.id + '/' + entryEnc : null,
    /* HTTP 缓存加速入口：路径带版本号（更新后 URL 变化），响应 immutable，
       浏览器在非安全上下文（http 内网）下也能命中磁盘缓存；是 SW 不可用时的等价方案。 */
    cacheUrl: installed ? '/api/games/asset/' + encodeURIComponent(String(g.version)) + '/' +
      g.id + '/' + entryEnc : null,
    licenseUrl: g.license && g.license.url,
    ratingAvg: avg,
    ratingCount: cnt,
    myRating,
    favorite,
    lastPlayedAt: recent ? recent.at : null,
    playCount: pstats.get(g.id) || 0,
  };
}

function parseBody(ctx) {
  return ctx.readBody(ctx.req, MAX_BODY).then((raw) => {
    let txt = '';
    if (Buffer.isBuffer(raw)) txt = raw.toString('utf8');
    else if (typeof raw === 'string') txt = raw;
    else if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw; // 已解析
    if (!txt) return {};
    try {
      return JSON.parse(txt);
    } catch (e) {
      const err = new Error('请求体不是合法 JSON');
      err.status = 400;
      throw err;
    }
  });
}

function requireUser(ctx, res) {
  if (!ctx.user) {
    ctx.sendJSON(res, 401, { error: '需要登录后再操作' });
    return null;
  }
  return ctx.user;
}

function requireAdmin(ctx, res) {
  const u = requireUser(ctx, res);
  if (!u) return null;
  if (u.role !== 'admin' && !u.isAdmin) {
    ctx.sendJSON(res, 403, { error: '需要管理员权限' });
    return null;
  }
  return u;
}

function audit(ctx, action, detail, ok) {
  try {
    ctx.app.audit({
      action, detail: String(detail || '').slice(0, 200), ok: ok !== false,
      userObj: ctx.user, ip: ctx.req.socket && ctx.req.socket.remoteAddress,
    });
  } catch (e) { /* 审计失败不阻断业务 */ }
}

/* ── Service Worker 源码（通过接口下发，用 Service-Worker-Allowed: / 放开作用域） ── */

const SW_SRC = [
  "/* P1 游戏中心 Service Worker：仅缓存 /games/ 同源静态资源，其余请求不接管 */",
  "const CACHE = 'p1-games-v1';",
  "self.addEventListener('install', () => self.skipWaiting());",
  "self.addEventListener('activate', (event) => {",
  "  event.waitUntil((async () => {",
  "    const keys = await caches.keys();",
  "    await Promise.all(keys.filter((k) => k.indexOf('p1-games-') === 0 && k !== CACHE)",
  "      .map((k) => caches.delete(k)));",
  "    await self.clients.claim();",
  "  })());",
  "});",
  "function report(pathname, hit, failed) {",
  "  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {",
  "    const msg = { __p1games: true, kind: 'sw-fetch', path: pathname, hit: !!hit, failed: !!failed, at: Date.now() };",
  "    cs.forEach((c) => { try { c.postMessage(msg); } catch (e) {} });",
  "  }).catch(() => {});",
  "}",
  "async function handle(req, url) {",
  "  const cache = await caches.open(CACHE);",
  "  const hit = await cache.match(req);",
  "  if (hit) { report(url.pathname, true, false); return hit; }",
  "  try {",
  "    const resp = await fetch(req);",
  "    if (resp && resp.status === 200 && resp.type === 'basic') {",
  "      cache.put(req, resp.clone()).catch(() => {});",
  "    }",
  "    report(url.pathname, false, false);",
  "    return resp;",
  "  } catch (e) {",
  "    report(url.pathname, false, true);",
  "    return new Response('游戏资源暂时不可用', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });",
  "  }",
  "}",
  "self.addEventListener('fetch', (event) => {",
  "  const req = event.request;",
  "  if (req.method !== 'GET') return;",
  "  const url = new URL(req.url);",
  "  if (url.origin !== self.location.origin) return;",
  "  if (url.pathname.indexOf('/games/') !== 0) return;",
  "  if (url.pathname.indexOf('/games/_covers/') === 0) return;",
  "  event.respondWith(handle(req, url));",
  "});",
].join('\n');

/* ── 路由 ─────────────────────────────────────────────────────────────── */

module.exports = {
  name: 'games',
  prefixes: ['/api/games'],

  async handle(ctx) {
    const { req, res, app, user, pathname, method, query, sendJSON, sendText } = ctx;

    /* 无扩展名路径归一：/api/games/ → /api/games */
    const p = pathname.replace(/\/+$/, '') || '/api/games';

    /* Service Worker：必须是独立脚本响应（不能用 JSON） */
    if (p === '/api/games/sw.js' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Service-Worker-Allowed': '/',
        'Content-Length': Buffer.byteLength(SW_SRC),
      });
      res.end(SW_SRC);
      return true;
    }

    const state = loadState(app);
    const rstats = ratingStats(state);
    const pstats = playStats(state);

    /* ── 列表 ── */
    if ((p === '/api/games' || p === '/api/games/list') && method === 'GET') {
      let list = catalog.games.map((g) => viewOf(g, state, user, rstats, pstats));
      const q = String(query.q || '').trim().toLowerCase();
      const cat = String(query.category || 'all');
      const fav = String(query.fav || '') === '1';
      const installedOnly = String(query.installed || '') === '1';
      if (cat && cat !== 'all') list = list.filter((g) => g.category === cat);
      if (fav) list = list.filter((g) => g.favorite);
      if (installedOnly) list = list.filter((g) => g.installed);
      if (q) {
        list = list.filter((g) => [
          g.id, g.name, g.nameEn, g.desc, g.author, g.categoryLabel,
          (g.tags || []).join(' '), g.license && g.license.spdx, g.source && g.source.repo,
        ].join(' ').toLowerCase().indexOf(q) >= 0);
      }
      const sort = String(query.sort || 'default');
      const collator = new Intl.Collator('zh-Hans-CN');
      if (sort === 'rating') {
        list.sort((a, b) => (b.ratingCount ? b.ratingAvg : -1) - (a.ratingCount ? a.ratingAvg : -1) ||
          collator.compare(a.name, b.name));
      } else if (sort === 'name') {
        list.sort((a, b) => collator.compare(a.name, b.name));
      } else if (sort === 'new') {
        list.sort((a, b) => String(b.source && b.source.date).localeCompare(String(a.source && a.source.date)));
      } else if (sort === 'plays') {
        list.sort((a, b) => b.playCount - a.playCount || collator.compare(a.name, b.name));
      } else {
        list.sort((a, b) => (ORDER.get(a.id) || 0) - (ORDER.get(b.id) || 0));
      }
      const catCount = {};
      for (const g of catalog.games) catCount[g.category] = (catCount[g.category] || 0) + 1;
      const myRec = user ? (state.users[userKey(user)] || null) : null;
      sendJSON(res, 200, {
        ok: true,
        games: list,
        categories: CATEGORIES.map((c) => Object.assign({}, c, {
          count: c.id === 'all' ? catalog.games.length : (catCount[c.id] || 0),
        })),
        stats: {
          total: catalog.games.length,
          installed: catalog.games.filter((g) => installedInfo(g.id).installed).length,
          favorites: myRec ? myRec.favorites.length : 0,
          rated: myRec ? Object.keys(myRec.ratings).length : 0,
          plays: user ? pstats.size : 0,
        },
        user: user ? { id: user.id, username: user.username, role: user.role } : null,
        generatedAt: catalog.generatedAt,
        serverTime: Date.now(),
      });
      return true;
    }

    /* ── 最近游玩 ── */
    if (p === '/api/games/recent' && method === 'GET') {
      const limit = Math.min(Math.max(parseInt(query.limit || '10', 10) || 10, 1), 20);
      const rec = user ? (state.users[userKey(user)] || null) : null;
      const items = (rec ? rec.recent : []).slice(0, limit).map((r) => {
        const g = GAMES.get(r.id);
        return Object.assign(viewOf(g, state, user, rstats, pstats), {
          lastPlayedAt: r.at, myPlayCount: r.count,
        });
      });
      sendJSON(res, 200, { ok: true, items, total: rec ? rec.recent.length : 0 });
      return true;
    }

    /* ── 评分 ── */
    if (p === '/api/games/rating' && method === 'POST') {
      const u = requireUser(ctx, res);
      if (!u) return true;
      let body;
      try { body = await parseBody(ctx); } catch (e) { return sendJSON(res, 400, { error: e.message }), true; }
      const g = gameOf(body.id);
      if (!g) return sendJSON(res, 404, { error: '游戏不存在' }), true;
      const stars = Number(body.stars);
      if (!Number.isInteger(stars) || stars < 0 || stars > 5) {
        return sendJSON(res, 400, { error: '评分必须是 0~5 的整数（0 = 清除评分）' }), true;
      }
      const rec = userRecord(state, u);
      if (stars === 0) delete rec.ratings[g.id];
      else rec.ratings[g.id] = stars;
      saveState(app, state);
      const fresh = ratingStats(state);
      const cnt = fresh.cnt.get(g.id) || 0;
      const avg = cnt ? Math.round((fresh.sum.get(g.id) / cnt) * 10) / 10 : 0;
      sendJSON(res, 200, { ok: true, id: g.id, myRating: stars || null, ratingAvg: avg, ratingCount: cnt });
      return true;
    }

    /* ── 收藏 ── */
    if (p === '/api/games/favorite' && method === 'POST') {
      const u = requireUser(ctx, res);
      if (!u) return true;
      let body;
      try { body = await parseBody(ctx); } catch (e) { return sendJSON(res, 400, { error: e.message }), true; }
      const g = gameOf(body.id);
      if (!g) return sendJSON(res, 404, { error: '游戏不存在' }), true;
      const rec = userRecord(state, u);
      const has = rec.favorites.includes(g.id);
      const want = typeof body.favorite === 'boolean' ? body.favorite : !has;
      if (want && !has) rec.favorites.push(g.id);
      if (!want && has) rec.favorites = rec.favorites.filter((x) => x !== g.id);
      saveState(app, state);
      sendJSON(res, 200, { ok: true, id: g.id, favorite: want });
      return true;
    }

    /* ── 记录一次启动（最近游玩） ── */
    if (p === '/api/games/play' && method === 'POST') {
      const u = requireUser(ctx, res);
      if (!u) return true;
      let body;
      try { body = await parseBody(ctx); } catch (e) { return sendJSON(res, 400, { error: e.message }), true; }
      const g = gameOf(body.id);
      if (!g) return sendJSON(res, 404, { error: '游戏不存在' }), true;
      const rec = userRecord(state, u);
      const now = Date.now();
      const idx = rec.recent.findIndex((r) => r.id === g.id);
      let count = 1;
      if (idx >= 0) {
        count = (rec.recent[idx].count || 1) + 1;
        rec.recent.splice(idx, 1);
      }
      rec.recent.unshift({ id: g.id, at: now, count });
      rec.recent = rec.recent.slice(0, 20);
      saveState(app, state);
      sendJSON(res, 200, { ok: true, id: g.id, at: now, count });
      return true;
    }

    /* ── 安装 ── */
    if (p === '/api/games/install' && method === 'POST') {
      const u = requireUser(ctx, res);
      if (!u) return true;
      let body;
      try { body = await parseBody(ctx); } catch (e) { return sendJSON(res, 400, { error: e.message }), true; }
      const g = gameOf(body.id);
      if (!g) return sendJSON(res, 404, { error: '游戏不存在' }), true;
      const lib = libDirOf(g.id);
      if (!lib || !fs.existsSync(path.join(lib, g.entry))) {
        return sendJSON(res, 409, { error: '本地仓库缺少该游戏，请先部署 games-lib' }), true;
      }
      const dst = pubDirOf(g.id);
      const t0 = Date.now();
      let stats;
      try {
        copyDir(lib, dst);
        stats = dirStats(dst);
        writeMarker(g.id, {
          id: g.id, version: g.version, treeHash: g.treeHash, bytes: stats.bytes,
          files: stats.files, installedAt: Date.now(), installedBy: u.username,
        });
      } catch (e) {
        console.error('[games] 安装失败', g.id, e);
        return sendJSON(res, 500, { error: '安装失败：' + (e && e.message) }), true;
      }
      const rec = state.games[g.id] = {
        version: g.version, treeHash: g.treeHash, bytes: stats.bytes,
        installedAt: Date.now(), installedBy: u.username,
      };
      saveState(app, state);
      audit(ctx, 'games-install', g.id + ' ' + stats.files + ' files ' + stats.bytes + 'B', true);
      sendJSON(res, 200, {
        ok: true, id: g.id, installed: true, installedVersion: g.version,
        files: stats.files, bytes: stats.bytes, ms: Date.now() - t0,
        path: '/games/' + g.id + '/', record: rec,
      });
      return true;
    }

    /* ── 卸载（危险操作：要求管理员 + 前端二次确认） ── */
    if (p === '/api/games/uninstall' && method === 'POST') {
      const u = requireAdmin(ctx, res);
      if (!u) return true;
      let body;
      try { body = await parseBody(ctx); } catch (e) { return sendJSON(res, 400, { error: e.message }), true; }
      const g = gameOf(body.id);
      if (!g) return sendJSON(res, 404, { error: '游戏不存在' }), true;
      if (body.confirm !== g.id) {
        return sendJSON(res, 400, { error: '确认参数不匹配（confirm 必须等于游戏 id）' }), true;
      }
      const dst = pubDirOf(g.id);
      if (!dst || !fs.existsSync(dst)) {
        return sendJSON(res, 409, { error: '该游戏当前未安装' }), true;
      }
      const before = dirStats(dst);
      const t0 = Date.now();
      try {
        fs.rmSync(dst, { recursive: true, force: true });
      } catch (e) {
        return sendJSON(res, 500, { error: '卸载失败：' + (e && e.message) }), true;
      }
      delete state.games[g.id];
      saveState(app, state);
      audit(ctx, 'games-uninstall', g.id + ' 删除 ' + before.files + ' files ' + before.bytes + 'B', true);
      sendJSON(res, 200, {
        ok: true, id: g.id, installed: false, removedFiles: before.files,
        removedBytes: before.bytes, ms: Date.now() - t0,
        libKept: path.join('games-lib', g.id),
      });
      return true;
    }

    /* ── 更新（用 games-lib 覆盖已安装目录） ── */
    if (p === '/api/games/update' && method === 'POST') {
      const u = requireUser(ctx, res);
      if (!u) return true;
      let body;
      try { body = await parseBody(ctx); } catch (e) { return sendJSON(res, 400, { error: e.message }), true; }
      const g = gameOf(body.id);
      if (!g) return sendJSON(res, 404, { error: '游戏不存在' }), true;
      const lib = libDirOf(g.id);
      if (!lib || !fs.existsSync(path.join(lib, g.entry))) {
        return sendJSON(res, 409, { error: '本地仓库缺少该游戏' }), true;
      }
      const dst = pubDirOf(g.id);
      const old = readMarker(g.id);
      const t0 = Date.now();
      const stats = (() => {
        copyDir(lib, dst);
        const s = dirStats(dst);
        writeMarker(g.id, {
          id: g.id, version: g.version, treeHash: g.treeHash, bytes: s.bytes,
          files: s.files, installedAt: Date.now(), installedBy: u.username,
        });
        return s;
      })();
      state.games[g.id] = {
        version: g.version, treeHash: g.treeHash, bytes: stats.bytes,
        installedAt: Date.now(), installedBy: u.username,
      };
      saveState(app, state);
      audit(ctx, 'games-update', g.id + ' ' + (old ? old.version : '?') + ' → ' + g.version, true);
      sendJSON(res, 200, {
        ok: true, id: g.id, updated: !old || old.treeHash !== g.treeHash,
        fromVersion: old ? old.version : null, toVersion: g.version,
        files: stats.files, bytes: stats.bytes, ms: Date.now() - t0,
      });
      return true;
    }

    /* ── 同步安装标记（部署后用管理员跑一次；真删假删都以文件系统为准） ── */
    if (p === '/api/games/sync' && method === 'POST') {
      const u = requireAdmin(ctx, res);
      if (!u) return true;
      const report = [];
      for (const g of catalog.games) {
        const dst = pubDirOf(g.id);
        if (!dst || !existsEntry(g.id, g.entry)) {
          report.push({ id: g.id, installed: false });
          delete state.games[g.id];
          continue;
        }
        const stats = dirStats(dst);
        writeMarker(g.id, {
          id: g.id, version: g.version, treeHash: g.treeHash, bytes: stats.bytes,
          files: stats.files, installedAt: Date.now(), installedBy: u.username,
        });
        state.games[g.id] = {
          version: g.version, treeHash: g.treeHash, bytes: stats.bytes,
          installedAt: Date.now(), installedBy: u.username,
        };
        report.push({ id: g.id, installed: true, files: stats.files, bytes: stats.bytes });
      }
      saveState(app, state);
      audit(ctx, 'games-sync', report.filter((r) => r.installed).length + ' 款已安装', true);
      sendJSON(res, 200, { ok: true, installed: report.filter((r) => r.installed).length, report });
      return true;
    }

    /* ── 自检 ── */
    if (p === '/api/games/health' && method === 'GET') {
      const file = dataFile(app);
      let fileInfo = { path: file, exists: false, mode: null, bytes: 0 };
      try {
        const st = fs.statSync(file);
        fileInfo = { path: file, exists: true, mode: (st.mode & 0o777).toString(8), bytes: st.size };
      } catch (e) { /* 尚未创建 */ }
      let libGames = 0;
      let libBytes = 0;
      try {
        for (const name of fs.readdirSync(LIB_DIR)) {
          const d = path.join(LIB_DIR, name);
          if (!fs.statSync(d).isDirectory()) continue;
          libGames++;
          libBytes += dirStats(d).bytes;
        }
      } catch (e) { /* games-lib 未部署 */ }
      sendJSON(res, 200, {
        ok: true,
        module: 'games',
        catalogGeneratedAt: catalog.generatedAt,
        catalogGames: catalog.games.length,
        installed: catalog.games.filter((g) => installedInfo(g.id).installed).length,
        pendingUpdate: catalog.games.filter((g) => installedInfo(g.id).updateAvailable).length,
        dirs: { lib: LIB_DIR, pub: PUB_DIR, covers: COVERS_DIR, data: fileInfo },
        lib: { games: libGames, bytes: libBytes },
        sw: { url: '/api/games/sw.js', scope: '/', cache: 'p1-games-v1' },
        node: process.version,
        serverTime: Date.now(),
      });
      return true;
    }

    /* ── 带强缓存头的静态资源通道（HTTP 下的等价缓存方案） ────────────────
       背景：Service Worker / CacheStorage 只在安全上下文（https 或 localhost）可用；
       本工作站以 http://192.168.99.1 提供服务，浏览器不会暴露 navigator.serviceWorker。
       因此提供 /api/games/asset/<version>/<id>/<path>：路径带版本号（更新后 URL 变化），
       响应 Cache-Control: immutable，让浏览器磁盘缓存接管二次加载。
       同时保留 /games/<id>/ 直连通道与 SW（若将来启用 HTTPS 自动生效）。 */
    if (p.startsWith('/api/games/asset/') && (method === 'GET' || method === 'HEAD')) {
      const rest = p.slice('/api/games/asset/'.length).split('/');
      const ver = rest.shift() || '';
      const id = rest.shift() || '';
      const g = gameOf(id);
      if (!g) return sendText(res, 404, 'Not Found'), true;
      if (!existsEntry(id, g.entry)) return sendText(res, 404, 'Not Found'), true;
      const base = pubDirOf(id);
      let rel = rest.join('/');
      let target = path.resolve(base, rel || g.entry);
      try {
        if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      } catch (e) { /* 交给下面 404 */ }
      if (!target.startsWith(path.resolve(base) + path.sep)) {
        return sendJSON(res, 403, { error: '非法资源路径' }), true;
      }
      let st;
      try { st = fs.statSync(target); } catch (e) { st = null; }
      if (!st || !st.isFile()) return sendText(res, 404, 'Not Found'), true;
      const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
      const headers = {
        'Content-Type': mimeOf(target),
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': etag,
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      };
      /* 允许浏览器用 304 复核（immutable 时基本不会发生，兼容旧缓存策略） */
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag, 'Cache-Control': headers['Cache-Control'] });
        res.end();
        return true;
      }
      res.writeHead(200, headers);
      if (method === 'HEAD') { res.end(); return true; }
      const stream = fs.createReadStream(target);
      stream.on('error', () => { try { res.destroy(); } catch (e) { /* 已断 */ } });
      stream.pipe(res);
      return true;
    }

    /* 未知的 /api/games/* → 明确 404，避免落到 legacy 链 */
    if (p.startsWith('/api/games/')) {
      sendJSON(res, 404, { error: '接口不存在：' + p });
      return true;
    }
    return false;
  },
};

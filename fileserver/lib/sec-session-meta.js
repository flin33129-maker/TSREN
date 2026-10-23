'use strict';

/* =====================================================================
   lib/sec-session-meta.js — 会话/设备台账（让「是谁、从哪、什么时候」可见）
   ---------------------------------------------------------------------
   现网 SessionStore 只存 { id, userId, createdAt, expiresAt } —— 没有 IP、
   没有 UA、没有最后活跃时间。所以旧页面上「在线设备」只能是一段说明文字。
   本模块在安全门禁里顺路记账（每请求 touch），把「踢出某会话」变成
   可验证的操作：destroy 之后该 cookie 立刻 401。

   存储：data/sec-sessions.json（0600，防抖 2s 落盘，进程退出前 flush）
   上限：400 条；超过或已不在 SessionStore 里的记录自动淘汰。
   ===================================================================== */

const store = require('./sec-store');
const path = require('path');

const MAX_ENTRIES = 400;
const SAVE_DEBOUNCE_MS = 2000;
const STALE_MS = 8 * 24 * 3600 * 1000;

function fileOf(app) { return path.join(store.dataDir(app), 'sec-sessions.json'); }

function stateOf(app) {
  if (!app.__secSessMeta) {
    const raw = store.loadJSON(fileOf(app), null);
    app.__secSessMeta = {
      sessions: (raw && raw.sessions && typeof raw.sessions === 'object') ? raw.sessions : {},
      updatedAt: (raw && raw.updatedAt) || null,
    };
  }
  return app.__secSessMeta;
}

function flush(app) {
  if (!app.__secSessMeta) return;
  if (app.__secSessSaveTimer) { clearTimeout(app.__secSessSaveTimer); app.__secSessSaveTimer = null; }
  app.__secSessMeta.updatedAt = store.nowIso();
  store.saveJSON(fileOf(app), app.__secSessMeta);
}

function scheduleSave(app) {
  if (app.__secSessSaveTimer) return;
  app.__secSessSaveTimer = setTimeout(() => {
    app.__secSessSaveTimer = null;
    try { flush(app); } catch { /* 落盘失败不影响请求 */ }
  }, SAVE_DEBOUNCE_MS);
  if (app.__secSessSaveTimer.unref) app.__secSessSaveTimer.unref();
}

function uaOf(req) {
  return store.clip(String((req && req.headers && req.headers['user-agent']) || ''), 180);
}

/** 每个带会话的请求调用：更新 IP / UA / 最后活跃时间 */
function touch(app, sid, user, req) {
  if (!app || !sid || !user) return;
  const st = stateOf(app);
  const now = Date.now();
  let rec = st.sessions[sid];
  if (!rec) {
    rec = { sid, userId: user.id, username: user.username, firstSeen: now, lastSeen: now, ip: '', ua: '', hits: 0 };
    st.sessions[sid] = rec;
  }
  rec.userId = user.id;
  rec.username = user.username;
  rec.lastSeen = now;
  rec.ip = store.clientIp(req);
  rec.ua = uaOf(req);
  rec.hits = (rec.hits || 0) + 1;
  scheduleSave(app);
}

function forget(app, sid) {
  const st = stateOf(app);
  if (st.sessions[sid]) {
    delete st.sessions[sid];
    scheduleSave(app);
  }
}

/** 清理：已不在 SessionStore、或超过 8 天没动的记录 */
function prune(app) {
  const st = stateOf(app);
  const live = new Set(app.sessions ? app.sessions.sessions.keys() : []);
  const now = Date.now();
  let changed = false;
  for (const [sid, rec] of Object.entries(st.sessions)) {
    if (!live.has(sid) || now - (rec.lastSeen || 0) > STALE_MS) {
      delete st.sessions[sid];
      changed = true;
    }
  }
  const keys = Object.keys(st.sessions);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (st.sessions[a].lastSeen || 0) - (st.sessions[b].lastSeen || 0));
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete st.sessions[k];
      changed = true;
    }
  }
  if (changed) scheduleSave(app);
  return st;
}

/**
 * 会话清单（含当前会话标记）。
 * @param {object} app
 * @param {string} [currentSid]  当前请求的会话 id
 * @param {string} [currentUserId] 当前请求的用户 id
 * @returns {{sessions:Array, devices:Array, count:number, onlineCount:number}}
 */
function list(app, currentSid, currentUserId) {
  const st = prune(app);
  const users = (app.users && app.users.users) || [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const items = [];
  for (const [sid, raw] of (app.sessions ? app.sessions.sessions : new Map())) {
    const u = byId.get(raw.userId);
    if (!u) continue;
    const meta = st.sessions[sid] || {};
    const ageMs = Date.now() - (meta.lastSeen || raw.createdAt || 0);
    items.push({
      sid,
      shortId: String(sid).slice(0, 8),
      userId: raw.userId,
      username: u.username,
      role: u.role,
      createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
      expiresAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : null,
      lastSeen: meta.lastSeen ? new Date(meta.lastSeen).toISOString() : null,
      ip: meta.ip || '',
      ua: meta.ua || '',
      hits: meta.hits || 0,
      active: ageMs < 5 * 60 * 1000,
      current: !!currentSid && sid === currentSid,
      mine: !!currentUserId && raw.userId === currentUserId,
    });
  }
  items.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return Date.parse(b.lastSeen || b.createdAt || 0) - Date.parse(a.lastSeen || a.createdAt || 0);
  });

  // 设备来自 presence（在线心跳表），与「会话」是两套东西，页面上分开列
  let devices = { online: [], offline: [] };
  try {
    if (app.presence && typeof app.presence.list === 'function') {
      const raw = app.presence.list() || {};
      const deco = (listIn) => (Array.isArray(listIn) ? listIn : []).map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        platform: d.platform,
        version: d.version,
        online: !!d.online,
        ip: d.ip || '',
        user: d.user || '',
        lastSeen: d.lastSeen || null,
        trusted: !!(app.pairing && app.pairing.isPaired && app.pairing.isPaired(d.id)),
      }));
      devices = { online: deco(raw.online), offline: deco(raw.offline) };
    }
  } catch (e) {
    console.error('[sec-session] 设备清单读取失败：' + ((e && e.message) || e));
  }

  return {
    sessions: items,
    devices,
    count: items.length,
    onlineCount: items.filter((x) => x.active).length,
  };
}

module.exports = { touch, forget, list, prune, flush, fileOf, stateOf };

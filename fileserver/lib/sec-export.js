'use strict';

/* =====================================================================
   lib/sec-export.js — 个人数据导出（JSON / ZIP）与最小 ZIP 打包器
   ---------------------------------------------------------------------
   需求（P0 第 10 项）：导出自己的数据（json/zip）。
   导出内容只包含**本人**可见的数据，不下发任何他人隐私或服务器内部路径：
     · 账号资料（profile）
     · 安全状态（2FA 是否开启、口令保质期、IP 白名单判定）
     · 我的会话（含 IP/UA/最后活跃）
     · 我的审计记录（只含 user=本人）
     · 我的 API Key（**不含 token**，只给名称/创建时间）
     · 我的共享链接（不含 token，只给路径与有效期）
     · 我的 ACL 组与盘权限
   ZIP 用自研 store 模式实现（与 server.js 的 /api/zip 同思路），零依赖。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const store = require('./sec-store');
const policyMod = require('./sec-policy');
const ipMod = require('./sec-ip');
const sessionMod = require('./sec-session-meta');

/* ------------------------------ CRC32 / ZIP ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zipLocal(nameBytes, crc, size, dt) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0x0800, 6);       // UTF-8 文件名
  h.writeUInt16LE(0, 8);            // store
  h.writeUInt16LE(dt.time, 10);
  h.writeUInt16LE(dt.date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(size, 18);
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(nameBytes.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, nameBytes]);
}

function zipCentral(nameBytes, crc, size, dt, offset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(dt.time, 12);
  h.writeUInt16LE(dt.date, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(size, 20);
  h.writeUInt32LE(size, 24);
  h.writeUInt16LE(nameBytes.length, 28);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, nameBytes]);
}

function zipEOCD(count, centralSize, centralOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(centralSize, 12);
  h.writeUInt32LE(centralOffset, 16);
  return h;
}

/**
 * 打包成 zip Buffer
 * @param {Array<{name:string, data:Buffer|string}>} entries
 */
function makeZip(entries) {
  const dt = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const nameBytes = Buffer.from(String(e.name).replace(/^\/+/, ''), 'utf8');
    const crc = crc32(data);
    const local = zipLocal(nameBytes, crc, data.length, dt);
    parts.push(local, data);
    central.push(zipCentral(nameBytes, crc, data.length, dt, offset));
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = zipEOCD(central.length, centralBuf.length, offset);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

/* ------------------------------ 导出内容 ------------------------------ */

/**
 * 组装「我的数据」对象。
 * @param {object} app
 * @param {object} user
 * @param {string} sid 当前会话 id（用于标记）
 */
function build(app, user, sid) {
  const policyData = policyMod.load(app);
  const pstate = policyMod.stateOf(app, user, policyData);
  const cfg = ipMod.loadConfig(app);
  const now = store.nowIso();
  const uname = String(user.username || '');

  let sessions = [];
  try {
    sessions = sessionMod.list(app).sessions
      .filter((s) => s.userId === user.id)
      .map((s) => ({
        shortId: s.shortId,
        current: s.sid === sid,
        ip: s.ip,
        ua: s.ua,
        createdAt: s.createdAt,
        lastSeen: s.lastSeen,
        expiresAt: s.expiresAt,
      }));
  } catch { /* 台账读不到不影响导出 */ }

  let audit = [];
  try {
    audit = (app.readAudit(100000) || [])
      .filter((e) => String(e.user || '') === uname)
      .slice(0, 2000)
      .map((e) => ({ ts: e.ts, action: e.action, ip: e.ip, ok: e.ok, disk: e.disk, path: e.path, detail: e.detail }));
  } catch { /* 忽略 */ }

  let keys = [];
  try {
    keys = (app.keysLoad() || [])
      .filter((k) => k.owner === uname)
      .map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt ? new Date(k.createdAt).toISOString() : null }));
  } catch { /* 忽略 */ }

  let shares = [];
  try {
    shares = (app.sharesLoad() || [])
      .filter((s) => s.createdBy === uname)
      .map((s) => ({ id: s.id, disk: s.disk, path: s.path, mode: s.mode, expires: s.expires || null, hits: s.hits || 0 }));
  } catch { /* 忽略 */ }

  let acl = null;
  try {
    const aclStore = require('./acl');
    const data = aclStore.loadAcl(app);
    const groups = [];
    for (const [name, members] of Object.entries(data.groups || {})) {
      if (Array.isArray(members) && members.includes(uname)) groups.push(name);
    }
    acl = { groups, permissions: data.disks || {} };
  } catch { /* 忽略 */ }

  return {
    exportedAt: now,
    exporter: '深空工作站 · 数据与安全模块（R15）',
    account: {
      id: user.id,
      username: uname,
      role: user.role,
      createdAt: user.createdAt || null,
      nickname: user.nickname || uname,
      bio: user.bio || '',
      status: user.status || 'online',
      disabled: !!user.disabled,
    },
    security: {
      totpEnabled: !!user.totpEnabled,
      totpLastCounter: user.totpLastCounter == null ? null : user.totpLastCounter,
      password: pstate,
      ipWhitelist: {
        enabled: cfg.enabled,
        forceHttps: cfg.forceHttps,
        allow: cfg.allow,
        emergencyBypass: ipMod.bypassActive(app),
      },
    },
    sessions,
    audit,
    apiKeys: keys,
    shares,
    acl,
    notes: [
      '本文件只包含你自己的账号数据，不含他人信息与服务器内部绝对路径。',
      'API Key 与分享链接的 token 属于可直接使用的凭据，导出中刻意不含。',
      '口令不会以任何形式导出（服务端只存 scrypt 哈希，无法还原）。',
    ],
  };
}

/** 生成 ZIP：data.json + audit.csv + README.txt */
function buildZip(payload) {
  const csv = toCsv(payload.audit || []);
  const readme = [
    '深空工作站 · 个人数据导出包',
    '导出时间：' + payload.exportedAt,
    '账号：' + payload.account.username,
    '',
    'data.json  —— 账号资料 / 安全状态 / 会话 / API Key 元数据 / 共享链接 / ACL',
    'audit.csv  —— 最近 2000 条与本人相关的审计记录',
    'README.txt —— 本说明',
    '',
    '说明：不含口令、不含 API Key/分享链接的 token、不含他人数据。',
  ].join('\n');
  return makeZip([
    { name: 'data.json', data: JSON.stringify(payload, null, 2) },
    { name: 'audit.csv', data: csv },
    { name: 'README.txt', data: readme },
  ]);
}

/* -------------------------------- CSV -------------------------------- */

const CSV_COLS = ['ts', 'action', 'user', 'ip', 'ok', 'disk', 'path', 'detail'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 审计条目 → CSV（带 UTF-8 BOM，Excel 直接打开不乱码） */
function toCsv(entries) {
  const cols = CSV_COLS;
  const lines = [cols.join(',')];
  for (const e of entries || []) {
    lines.push(cols.map((c) => csvCell(e[c])).join(','));
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

module.exports = { build, buildZip, makeZip, toCsv, crc32 };

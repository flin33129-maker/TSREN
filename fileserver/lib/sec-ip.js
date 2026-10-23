'use strict';

/* =====================================================================
   lib/sec-ip.js — IP 白名单（CIDR）与「强制 HTTPS」门禁判定
   ---------------------------------------------------------------------
   需求（P0 第 6 项）：
     · 可配置允许网段；非白名单 IP 的登录/访问被拒绝；
     · **不能把自己锁在外面**：192.168.99.0/24 默认放行，并且必须有
       应急放开机制（fail-open）+ 可回滚。
   实现要点：
     1. 配置存在 data/sec-ip.json，enabled 默认 **false**（安全默认 = 不拦，
        由管理员在页面上显式开启；避免升级瞬间把全站挡在外面）；
     2. 默认允许表：127.0.0.0/8、::1/128、192.168.99.0/24；
     3. 应急：
        a) `data/sec-ip-bypass` 文件存在 → 无论配置如何一律放行（kill switch）；
        b) 配置读不出来/解析失败 → 放行（fail-open）；
        c) `POST /api/security/ip/reset` 重置为默认表；
        d) 命令行：`sudo touch /opt/station/fileserver/data/sec-ip-bypass`
           —— 这条写进了验收报告，是最坏情况下的救命命令；
     4. 配置里把 192.168.99.0/24 删掉是被允许的（否则无法做「拒绝」实测），
        但页面会给出强提示，且应急文件/SSH 始终可用。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const store = require('./sec-store');

/* 默认允许：本机回环 + 工作站所在网段。
   这两个网段不写死在代码里做「只能加不能删」的硬约束（那会让「拒绝实测」无法进行），
   而是作为默认值与「一键重置」的目标。 */
const DEFAULT_ALLOW = ['127.0.0.0/8', '::1/128', '192.168.99.0/24'];
const PINNED = ['127.0.0.0/8', '::1/128'];   // 回环永远允许，删不掉

/* ------------------------------ CIDR 运算 ------------------------------ */

/** IPv4 → 32 位无符号整数；失败返回 null */
function ipv4ToInt(ip) {
  const s = String(ip || '').trim();
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** IPv6 → BigInt（支持 :: 缩写与嵌入 IPv4）；失败返回 null */
function ipv6ToBigInt(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (!s || s.indexOf(':') < 0) return null;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // 末尾可能是 IPv4 形式（::ffff:192.168.1.1）
  let tailV4 = null;
  const tailMatch = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tailMatch) {
    tailV4 = ipv4ToInt(tailMatch[1]);
    if (tailV4 == null) return null;
    s = s.slice(0, -tailMatch[1].length) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parsePart = (part) => (part ? part.split(':').map((x) => {
    if (!/^[0-9a-f]{1,4}$/.test(x)) return null;
    return parseInt(x, 16);
  }) : []);
  const head = parsePart(halves[0]);
  const tail = halves.length === 2 ? parsePart(halves[1]) : [];
  if (head.includes(null) || tail.includes(null)) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) out = (out << 16n) | BigInt(g);
  if (tailV4 != null) {
    out = (out & ~0xffffffffn) | BigInt(tailV4);
  }
  return out;
}

/** 解析一条 CIDR。返回 {ok, family:'v4'|'v6', text, base, prefix} 或 {ok:false} */
function parseCidr(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: '空网段' };
  const slash = raw.indexOf('/');
  const ipPart = slash >= 0 ? raw.slice(0, slash) : raw;
  const isV6 = ipPart.indexOf(':') >= 0;
  const family = isV6 ? 'v6' : 'v4';
  const maxBits = isV6 ? 128 : 32;
  let prefix = maxBits;
  if (slash >= 0) {
    const p = Number(raw.slice(slash + 1));
    if (!Number.isInteger(p) || p < 0 || p > maxBits) {
      return { ok: false, error: '前缀长度非法：' + raw };
    }
    prefix = p;
  }
  if (isV6) {
    const base = ipv6ToBigInt(ipPart);
    if (base == null) return { ok: false, error: 'IPv6 地址非法：' + raw };
    return { ok: true, family, text: canonCidr(raw, ipPart, prefix), base, prefix };
  }
  const v4 = ipv4ToInt(ipPart);
  if (v4 == null) return { ok: false, error: 'IPv4 地址非法：' + raw };
  return { ok: true, family, text: canonCidr(raw, ipPart, prefix), base: BigInt(v4), prefix };
}

function canonCidr(raw, ipPart, prefix) {
  const isV6 = ipPart.indexOf(':') >= 0;
  return (isV6 ? ipPart : ipPart) + '/' + prefix;
}

function maskOf(prefixBits, family) {
  const max = family === 'v6' ? 128 : 32;
  if (prefixBits <= 0) return 0n;
  return ((1n << BigInt(prefixBits)) - 1n) << BigInt(max - prefixBits);
}

/** ip 是否落在 cidr 内 */
function inCidr(ip, cidr) {
  if (!cidr || !cidr.ok) return false;
  const isV6 = String(ip || '').indexOf(':') >= 0;
  if (isV6 !== (cidr.family === 'v6')) {
    // 允许 ::ffff:x.x.x.x 视作 v4 的调用方自己做 normalize（sec-store 已做）
    return false;
  }
  let val;
  if (isV6) {
    val = ipv6ToBigInt(ip);
    if (val == null) return false;
    const mask = maskOf(cidr.prefix, 'v6');
    return (val & mask) === (cidr.base & mask);
  }
  const v4 = ipv4ToInt(ip);
  if (v4 == null) return false;
  const mask = maskOf(cidr.prefix, 'v4');
  return (BigInt(v4) & mask) === (cidr.base & mask);
}

/* ------------------------------ 配置读写 ------------------------------ */

function bypassFile(app) {
  return path.join(store.dataDir(app), 'sec-ip-bypass');
}

function bypassActive(app) {
  try { return fs.existsSync(bypassFile(app)); } catch { return false; }
}

function configFile(app) { return store.fileOf(app, 'ip'); }

const DEFAULTS = () => ({
  version: 1,
  enabled: false,
  allow: DEFAULT_ALLOW.slice(),
  forceHttps: false,
  updatedAt: null,
  updatedBy: null,
});

/** 读取并规整配置（永远返回可用对象，坏数据 fail-open 成 enabled:false） */
function loadConfig(app) {
  const raw = store.cachedFile(configFile(app), null);
  if (!raw || typeof raw !== 'object') return DEFAULTS();
  const cfg = DEFAULTS();
  cfg.enabled = raw.enabled === true;
  cfg.forceHttps = raw.forceHttps === true;
  cfg.updatedAt = raw.updatedAt || null;
  cfg.updatedBy = raw.updatedBy || null;
  const list = Array.isArray(raw.allow) ? raw.allow : DEFAULT_ALLOW;
  const seen = new Set();
  cfg.allow = [];
  for (const item of list) {
    const c = parseCidr(item);
    if (!c.ok) continue;
    const key = c.family + ':' + c.base + '/' + c.prefix;
    if (seen.has(key)) continue;
    seen.add(key);
    cfg.allow.push(c.text);
  }
  // 回环永远在允许表里（删不掉）：这是最后一道自救通道
  for (const pin of PINNED) {
    if (!cfg.allow.some((x) => {
      const c = parseCidr(x);
      return c.ok && c.family === parseCidr(pin).family && c.prefix === parseCidr(pin).prefix
        && c.base === parseCidr(pin).base;
    })) cfg.allow.push(pin);
  }
  return cfg;
}

/**
 * 保存配置。
 * @returns {{ok:boolean, error?:string, config?:object}}
 */
function saveConfig(app, input, who) {
  const allowIn = Array.isArray(input && input.allow) ? input.allow : DEFAULT_ALLOW;
  const allow = [];
  const seen = new Set();
  for (const item of allowIn) {
    const c = parseCidr(item);
    if (!c.ok) return { ok: false, error: c.error };
    const key = c.family + ':' + c.base + '/' + c.prefix;
    if (seen.has(key)) continue;
    seen.add(key);
    allow.push(c.text);
  }
  if (!allow.length) return { ok: false, error: '允许网段不能为空（至少保留 127.0.0.0/8）' };
  for (const pin of PINNED) {
    const c = parseCidr(pin);
    const key = c.family + ':' + c.base + '/' + c.prefix;
    if (!seen.has(key)) { seen.add(key); allow.push(pin); }
  }
  const cfg = {
    version: 1,
    enabled: input && input.enabled === true,
    allow,
    forceHttps: input && input.forceHttps === true,
    updatedAt: store.nowIso(),
    updatedBy: who || 'system',
  };
  if (!store.saveJSON(configFile(app), cfg)) {
    return { ok: false, error: '配置落盘失败（检查 data/ 权限）' };
  }
  store.invalidate(configFile(app));   // 让下一次读拿到新值
  return { ok: true, config: cfg };
}

function resetConfig(app, who) {
  return saveConfig(app, { enabled: false, allow: DEFAULT_ALLOW.slice(), forceHttps: false }, who);
}

/* ------------------------------ 判定入口 ------------------------------ */

/**
 * 判定一个 IP 是否被允许。纯函数，便于「模拟」接口与单测。
 * @returns {{allowed:boolean, matched:string|null, reason:string}}
 */
function decide(app, ip, cfgIn) {
  const cfg = cfgIn || loadConfig(app);
  if (bypassActive(app)) return { allowed: true, matched: 'emergency-bypass', reason: 'emergency-bypass' };
  if (!cfg.enabled) return { allowed: true, matched: null, reason: 'disabled' };
  const clean = store.normalizeIp(ip);
  for (const item of cfg.allow) {
    const c = parseCidr(item);
    if (c.ok && inCidr(clean, c)) return { allowed: true, matched: item, reason: 'whitelist' };
  }
  return { allowed: false, matched: null, reason: 'not-in-whitelist' };
}

module.exports = {
  DEFAULT_ALLOW, PINNED,
  parseCidr, inCidr, ipv4ToInt, ipv6ToBigInt,
  configFile, loadConfig, saveConfig, resetConfig,
  bypassFile, bypassActive, decide,
};

'use strict';

/* =====================================================================
   lib/s3.js — S3 兼容对象存储网关（映射到 FileServer 的盘符体系）
   挂载点: http://<ip>:<port>/s3/<bucket>/<key...>
     桶配置: <dataDir>/s3.json
       {"accessKeyId":"nas","secretAccessKey":"<强随机密钥>",
        "buckets":{"nas-public":{"disk":"public"},"nas-ext":{"disk":"ext"}}}
     disk:"ext" = 解析为第一块在线外置盘（scanExternal()[0].label）
   认证   : AWS SigV4（Authorization 头）+ presigned 查询串（X-Amz-*）
   支持   : ListBuckets / ListObjectsV2 / PUT / GET / HEAD / DELETE
            Multipart Upload（uploadId 内存 Map + 持久化 s3-mpu.json）
   零依赖 : 仅 Node 内置模块；类在 require 时不产生任何副作用

   ---- 安全基线（本次加固） ----------------------------------------------
   1. SigV4 严格对齐 AWS 规范：canonical headers 块必须以 '\n' 结尾
      （AWS SigV4 规范原文 / botocore / aws-cli / rclone / s3cmd 全部按此计算；
      少了这个换行，boto3 一律 SignatureDoesNotMatch）。
      为兼容历史客户端，验证时**两种变体都试**（规范变体优先），任一命中即放行。
   2. 请求体完整性：x-amz-content-sha256 是客户端对 body 的"承诺"，
      服务端必须实际算一遍 SHA-256 并比对，否则"签一个 hash、传另一个 body"
      没有任何拦截（AWS 语义下这是严重的完整性缺失）→ 不一致返回
      400 XAmzContentSHA256Mismatch。
   3. 凭据强度闸门：secretAccessKey 必须有足够等效熵（默认 ≥128 位），
      否则网关**拒绝服务**（fail-closed），而不是降级放行。
   4. 写路径接入配额（server.js 的公共盘 64GB + lib/quota.js 的用户/盘阈值），
      且是"边收边计数"——chunked 传输（无 content-length）同样无法绕过。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { readBody, mimeOf } = require('./util');
const { checkUserQuota, checkDiskThreshold } = require('./quota');

const S3_PREFIX = '/s3';
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';
const BIG_PUT_THRESHOLD = 8 * 1024 * 1024;          // 超过 8MB 用 .s3part- 临时文件
const MPU_DIR = 's3-mpu';                            // <dataDir>/s3-mpu/<uploadId>/
const MPU_FILE = 's3-mpu.json';                      // uploadId 持久化文件
const MPU_PART_MIN = 5 * 1024 * 1024;                // S3 规范：非最后分片 ≥ 5MB
const MD5_CACHE_MAX = 512;                           // ETag(md5) 缓存上限
const WALK_MAX = 200000;                             // 列举条目安全上限
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SECRET_MIN_BITS = 128;                         // secret 至少 16 字节等效熵
const SECRET_MIN_LEN = 16;                           // 且至少 16 个字符
const QUOTA_STEP = 1024 * 1024;                       // 边收边计数：每 1MB 复查一次配额
const DISK_LEVEL_TTL = 30 * 1000;                    // 盘水位缓存 30s（listDisks 很贵）

/* ---------- 小工具 ---------- */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * AWS SigV4 uri-encode：保留 A-Za-z0-9-._~（'/' 按需保留），其余按 UTF-8 字节转 %XX 大写
 * 输入约定为「已解码」字符串（server.js 对 pathname 做过 decodeURIComponent）
 */
function uriEncode(str, encodeSlash) {
  let out = '';
  for (const ch of String(str)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/') out += encodeSlash ? '%2F' : '/';
    else {
      for (const b of Buffer.from(ch, 'utf8')) {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

/** 规范化查询串：按 key/value 字节序排序后重新编码（排除 X-Amz-Signature） */
function canonicalQuery(query, excludeSig) {
  const items = [];
  for (const k of Object.keys(query)) {
    if (excludeSig && k === 'X-Amz-Signature') continue;
    const v = query[k] === undefined || query[k] === null ? '' : String(query[k]);
    items.push([k, v]);
  }
  items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return items.map(([k, v]) => uriEncode(k, true) + '=' + uriEncode(v, true)).join('&');
}

/* ---------- AWS SigV4 规范补充件（本次加固） ---------- */

/**
 * 从原始请求行里取出 { path, query }（一个字符都不改）。
 * 为什么用原始请求行而不是 server.js 传进来的 pathname：
 * AWS 客户端（botocore 的 S3 实现）签的是**线上那串**路径与查询串 ——
 * 不做路径归一化、不做二次编码。我们把解码后的路径再按 AWS 规则编码回去，
 * 在非规范编码（%7e、小写十六进制）上会与客户端产生分歧。
 */
function rawTarget(req) {
  let u = String((req && req.url) || '/');
  /* 绝对形式的请求目标（http://host/path?x=1） */
  if (/^https?:\/\//i.test(u)) {
    try {
      const p = new URL(u);
      u = p.pathname + p.search;
    } catch { /* 解析失败就按原样处理 */ }
  }
  const q = u.indexOf('?');
  if (q < 0) return { path: u, query: '' };
  return { path: u.slice(0, q), query: u.slice(q + 1) };
}

/**
 * AWS 规范的 canonical query string（与 botocore 的 _canonical_query_string_url 一致）：
 * 把原始查询串按 '&' 拆开、按第一个 '=' 分键值，**按原始（已编码）键名**排序，
 * 同名再按值排序，最后用 '&' / '=' 拼回去。
 * 为什么不解码再编码：客户端签的是线上那串查询串，解码再编码会在
 * 非规范编码上与客户端分歧（'+' 还会被 URLSearchParams 吃成空格）。
 */
function canonicalQuerySpec(rawQuery, excludeSig) {
  if (!rawQuery) return '';
  const items = [];
  for (const part of String(rawQuery).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? '' : part.slice(eq + 1);
    if (excludeSig && k === 'X-Amz-Signature') continue;
    items.push([k, v]);
  }
  items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return items.map(([k, v]) => k + '=' + v).join('&');
}

/**
 * 估算 secret 的等效熵（bit）。
 * 思路：按实际用到的字符类推算字符集大小 → 每字符 log2(字符集)，再乘以长度
 * （随机串的熵主要来自长度而不是字符种类）；字符种类过于单一时按"不同字符数"封顶。
 */
function secretEntropyBits(secret) {
  const s = String(secret || '');
  if (!s.length) return 0;
  let alphabet = 0;
  if (/[a-z]/.test(s)) alphabet += 26;
  if (/[A-Z]/.test(s)) alphabet += 26;
  if (/[0-9]/.test(s)) alphabet += 10;
  if (/[^A-Za-z0-9]/.test(s)) alphabet += 33;
  const perChar = Math.log2(Math.max(2, alphabet));
  let bits = s.length * perChar;
  const uniq = new Set(s).size;
  if (uniq < 8) bits = Math.min(bits, uniq * perChar);   // 重复字符不产生新熵
  return Math.round(bits);
}

/** 一眼可见的弱口令模式（常见默认值 / 纯重复 / 顺序串） */
const WEAK_SECRET_PATTERNS = [
  /^(?:nas|admin|root|user|test|demo|default|pass|password|secret|changeme|letmein|welcome|123456)/i,
  /^(.)\1{3,}$/,                                   // 同一字符重复
  /^(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i,
];

/** 判定 secret 是否属于"一眼可见的弱口令" */
function looksWeakSecret(secret) {
  const s = String(secret || '');
  if (!s) return true;
  for (const re of WEAK_SECRET_PATTERNS) if (re.test(s)) return true;
  return false;
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
/** 常量时间比较两个 hex 签名 */
function sigEqual(a, b) {
  const ba = Buffer.from(String(a).toLowerCase(), 'utf8');
  const bb = Buffer.from(String(b).toLowerCase(), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
/** 'YYYYMMDDTHHMMSSZ' → epoch ms（非法返回 NaN） */
function parseAmzDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * 按 AWS SigV4 计算一个请求的签名（网关与自测共用同一份实现）。
 *
 * AWS 规范原文：
 *   CanonicalRequest = HTTPRequestMethod + '\n'
 *                    + CanonicalURI + '\n'
 *                    + CanonicalQueryString + '\n'
 *                    + CanonicalHeaders + '\n'
 *                    + SignedHeaders + '\n'
 *                    + HexEncode(Hash(RequestPayload))
 *   CanonicalHeaders 是 "name:value\n" 的序列（**每行自带尾随 \n**），
 *   模板再拼一个 '\n' → 头块与 SignedHeaders 之间是**空行**。
 *
 * @param {object} o
 * @param {string} o.secret   secretAccessKey
 * @param {string} o.scope    credential scope（date/region/service/aws4_request）
 * @param {string} o.amzDate  'YYYYMMDDTHHMMSSZ'
 * @param {string} o.method   HTTP 方法
 * @param {string} o.uri      canonical URI
 * @param {string} o.query    canonical query string
 * @param {string[]} o.headers 形如 'host:example.com' 的头列表（按签名顺序）
 * @param {string} o.signed   SignedHeaders
 * @param {string} o.payload  payload hash
 * @param {boolean} [o.legacy] true = 历史变体（头块**不**带尾随 '\n'）
 * @returns {{signature:string, canonicalRequest:string, stringToSign:string}}
 */
function signRequest(o) {
  const headerBlock = o.legacy ? o.headers.join('\n') : o.headers.join('\n') + '\n';
  const canonicalRequest = [
    o.method, o.uri, o.query, headerBlock, o.signed, o.payload,
  ].join('\n');
  const [scopeDate, scopeRegion, scopeService, scopeTerm] = String(o.scope).split('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256', o.amzDate, o.scope, sha256hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac('AWS4' + o.secret, scopeDate);
  const kRegion = hmac(kDate, scopeRegion || '');
  const kService = hmac(kRegion, scopeService || 's3');
  const kSigning = hmac(kService, scopeTerm || 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return { signature, canonicalRequest, stringToSign };
}

/* ---------- S3 网关主体 ---------- */
class S3Gateway {
  /** @param {import('../server')} srv FileServer 实例 */
  constructor(srv) {
    this.srv = srv;
    this._cfg = null;          // s3.json 内容（懒加载 + mtime 变更重读）
    this._cfgMtime = -1;
    this._mpu = null;          // Map<uploadId, {uploadId,bucket,key,disk,initiated,parts[]}>
    this._md5 = new Map();     // abs -> { md5, size, mtime } ETag 缓存
    this._diskLevel = null;    // 盘水位缓存（listDisks 很贵，30s 一次足够）
    /* 网关内部身份不再永久缓存：用户被删除 / 改角色后必须重新解析，
       否则旧对象引用会继续把 private 盘解析成"已删除用户"的目录。 */
    this._gwUser = null;
  }

  /* ============ 配置与身份 ============ */

  /** 读取 s3.json（懒加载，文件 mtime 变化自动重读） */
  config() {
    const file = path.join(this.srv.cfg.dataDir, 's3.json');
    try {
      const st = fs.statSync(file);
      if (!this._cfg || this._cfgMtime !== st.mtimeMs) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        /* 凭据只认文件里的值 —— 绝不内置任何默认 AK/SK。
           旧实现把 accessKeyId 默认成 'nas'，等于"文件写坏了就退回弱默认凭据"。 */
        raw.accessKeyId = String(raw.accessKeyId == null ? '' : raw.accessKeyId).trim();
        raw.secretAccessKey = String(raw.secretAccessKey == null ? '' : raw.secretAccessKey);
        raw.buckets = raw.buckets && typeof raw.buckets === 'object' ? raw.buckets : {};
        this._cfg = raw;
        this._cfgMtime = st.mtimeMs;
      }
      return this._cfg;
    } catch {
      this._cfg = null;
      this._cfgMtime = -1;
      return null;
    }
  }

  /**
   * 弱凭据开关：config.json 里 station.s3.allowWeakCredentials=true，
   * 或环境变量 STATION_S3_ALLOW_WEAK=1。默认关闭（不放行弱凭据）。
   * 注意：这是"临时应急"，用完必须把密钥轮换掉。
   */
  allowWeakCredentials() {
    if (process.env.STATION_S3_ALLOW_WEAK
      && !/^(0|false|no|off)$/i.test(process.env.STATION_S3_ALLOW_WEAK)) return true;
    const cfg = (this.srv && this.srv.cfg) || {};
    const station = cfg.station || {};
    const s3 = station.s3 || {};
    return s3.allowWeakCredentials === true;
  }

  /**
   * 凭据强度闸门。返回 { ok:true, weak? } 或 { ok:false, message }。
   * message 是给管理员看的中文说明（含修复方法）。
   */
  credentialCheck() {
    const cfg = this.config();
    if (!cfg) return { ok: true, reason: 'not-configured' };   // 没有 s3.json = 功能未开启，不算弱凭据
    const problems = [];
    const akid = cfg.accessKeyId;
    const sk = cfg.secretAccessKey;

    if (!akid) {
      problems.push('缺少 accessKeyId');
    } else {
      if (akid.length > 128) problems.push('accessKeyId 过长（>128 字符）');
      if (/[\s\x00-\x1f]/.test(akid)) problems.push('accessKeyId 含空白或控制字符');
      if (akid === sk) problems.push('accessKeyId 与 secretAccessKey 相同');
    }
    if (!sk) {
      problems.push('缺少 secretAccessKey');
    } else {
      if (sk.length < SECRET_MIN_LEN) {
        problems.push('secretAccessKey 太短（' + sk.length + ' 字符 < ' + SECRET_MIN_LEN + '）');
      }
      const bits = secretEntropyBits(sk);
      if (bits < SECRET_MIN_BITS) {
        problems.push('secretAccessKey 等效熵不足（约 ' + bits + ' 位 < ' + SECRET_MIN_BITS
          + ' 位 = 16 字节）');
      }
      if (looksWeakSecret(sk)) problems.push('secretAccessKey 是常见弱口令/默认值');
    }

    if (!problems.length) return { ok: true };

    const msg = 'S3 凭据不合规：' + problems.join('；')
      + '。请编辑 ' + path.join(this.srv.cfg.dataDir, 's3.json')
      + '，用 `openssl rand -hex 24` 生成新 secret（≥16 字节等效熵），并把文件权限设为 600（chmod 600）。'
      + '临时放宽：config.json 里设置 {"station":{"s3":{"allowWeakCredentials":true}}}。';
    if (this.allowWeakCredentials()) return { ok: true, weak: msg };
    return { ok: false, message: msg };
  }

  /**
   * 启动期断言：凭据不合规直接抛错（由 server.js 的启动流程调用 → 进程拒绝启动）。
   * 语义是"弱凭据 = 不启动"，而不是"降级放行"。
   */
  assertCredentials() {
    const chk = this.credentialCheck();
    if (!chk.ok) throw new Error('[s3] ' + chk.message);
    if (chk.weak) console.warn('[s3] ' + chk.weak);
    return true;
  }

  /**
   * 网关内部身份：S3 用 accessKey 认证，但 resolveTarget 的 private 盘需要 user 对象。
   * 约定取第一个管理员（无管理员则第一个用户）；无用户时为 null（只能映射 public/ext）。
   * ⚠️ 每次都重新解析：用户被删除 / 降级后，缓存下来的旧对象会让 private 盘
   *    继续按"老管理员"的口径放行（越权）。
   */
  gatewayUser() {
    const users = (this.srv.users && this.srv.users.users) || [];
    if (!users.length) return null;
    return users.find((u) => u && !u.disabled && u.role === 'admin')
      || users.find((u) => u && !u.disabled)
      || null;
  }

  /** 桶名 → {disk}；disk:'ext' 解析为第一块在线外置盘，不在线按 NoSuchBucket */
  bucketDisk(name) {
    const cfg = this.config();
    const b = cfg && cfg.buckets && cfg.buckets[name];
    if (!b || !b.disk) return { error: 'NoSuchBucket' };
    let disk = String(b.disk);
    if (disk === 'ext') {
      const ext = this.srv.scanExternal()[0];
      if (!ext) return { error: 'NoSuchBucket' };
      disk = 'ext:' + ext.label;
    }
    return { disk };
  }

  /* ============ 入口 ============ */

  /**
   * 挂载在主 HTTP 服务 /s3/ 前缀下。
   * @returns {Promise<boolean>} true = 已处理；false = 不归本网关管
   */
  async handle(req, res, pathname, query) {
    if (pathname !== S3_PREFIX && !pathname.startsWith(S3_PREFIX + '/')) return false;
    try {
      /* SigV4 校验（全部请求必须带有效签名） */
      const v = this.verify(req, pathname, query);
      if (!v.ok) return this.sendError(res, v.status || 403, v.code, v.message);

      /* 请求体完整性校验器：handler 消费 body 时顺手喂数据，最后比对摘要 */
      const guard = this.makePayloadGuard(v.payloadHash);
      req._s3Guard = guard;

      /* GET/HEAD/DELETE 本应无请求体：把体排空并核对客户端声明的摘要
         （声明了却发别的内容 → 400 XAmzContentSHA256Mismatch） */
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') {
        const bad = await this.drainAndCheck(req, guard);
        if (bad) {
          return this.sendError(res, 400, bad, '请求体 SHA-256 与 x-amz-content-sha256 声明不一致');
        }
      }

      const rest = pathname.slice(S3_PREFIX.length).replace(/^\/+/, '');
      const slash = rest.indexOf('/');
      const bucket = slash < 0 ? rest : rest.slice(0, slash);
      const key = slash < 0 ? '' : rest.slice(slash + 1).replace(/^\/+/, '');

      /* GET /s3/ = ListBuckets */
      if (!bucket) {
        if (req.method === 'GET' || req.method === 'HEAD') return this.listBuckets(req, res);
        return this.sendError(res, 405, 'MethodNotAllowed', '该路径不支持此 HTTP 方法');
      }

      switch (req.method) {
        case 'GET':
        case 'HEAD':
          if (key) return this.getObject(req, res, bucket, key, req.method === 'HEAD');
          return this.listBucket(req, res, bucket, query, req.method === 'HEAD');
        case 'PUT':
          if (key) return this.putObject(req, res, bucket, key);
          return this.sendError(res, 405, 'MethodNotAllowed', '暂不支持创建桶（桶由 s3.json 配置）');
        case 'DELETE':
          if (key) return this.deleteObject(req, res, bucket, key, query);
          return this.sendError(res, 405, 'MethodNotAllowed', '暂不支持删除桶');
        case 'POST':
          if (key) return this.postObject(req, res, bucket, key, query);
          return this.sendError(res, 405, 'MethodNotAllowed', '该路径不支持 POST');
        default:
          return this.sendError(res, 405, 'MethodNotAllowed', '不支持的 HTTP 方法');
      }
    } catch (err) {
      console.error('[s3]', req.method, pathname, err);
      try { this.sendError(res, 500, 'InternalError', '服务器内部错误'); } catch { /* closed */ }
    }
    return true;
  }

  /* ============ 响应工具 ============ */

  sendXml(res, code, body, extra) {
    const buf = Buffer.from(XML_HEAD + body, 'utf8');
    res.writeHead(code, Object.assign({
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': buf.length,
    }, extra || {}));
    res.end(buf);
  }

  sendError(res, status, code, message) {
    this.sendXml(res, status, '<Error><Code>' + esc(code) + '</Code><Message>'
      + esc(message || code) + '</Message></Error>');
  }

  /* ============ 请求体完整性（payload hash 校验） ============ */

  /**
   * 构造请求体 SHA-256 校验器。
   *
   * 为什么必须有：x-amz-content-sha256 是客户端对 body 的"承诺"（这个值参与签名）。
   * 服务端若只读头、不与实际 body 比对，等于"签一个 hash、传另一个 body"没有任何拦截 ——
   * 这在 AWS 语义下是严重的完整性缺失。
   *
   * 校验器**不消费请求流**（若在 handler 接管前挂 'data' 监听器，
   * 请求会提前进入 flowing 模式，中间到达的数据可能被丢掉），
   * 而是由各 handler 在**已有的** data 回调里顺手喂进来。
   */
  makePayloadGuard(declared) {
    const d = String(declared == null ? '' : declared).trim();
    /* UNSIGNED-PAYLOAD / STREAMING-AWS4-HMAC-SHA256-PAYLOAD（aws-chunked）
       客户端没有承诺具体的 body 摘要，无从校验 —— 与 AWS 行为一致，放行。 */
    const skip = !d || d === 'UNSIGNED-PAYLOAD' || d.startsWith('STREAMING-');
    return {
      declared: d,
      skip,
      hash: skip ? null : crypto.createHash('sha256'),
      bytes: 0,
      update(chunk) {
        this.bytes += chunk.length;
        if (this.hash) this.hash.update(chunk);
      },
      /** @returns {string|null} null = 通过；否则是 S3 错误码 */
      check() {
        if (this.skip) return null;
        const got = this.hash.digest('hex');
        return got === this.declared.toLowerCase() ? null : 'XAmzContentSHA256Mismatch';
      },
    };
  }

  /**
   * 排空请求体并核对声明的 payload hash。
   * 用于 GET/HEAD/DELETE 这类"本应无体"的请求：客户端声明了 body 摘要
   * 却发了别的内容，同样必须拦（400 XAmzContentSHA256Mismatch）。
   */
  async drainAndCheck(req, guard) {
    if (guard.skip) { req.resume(); return null; }
    await new Promise((resolve) => {
      let settled = false;
      const fin = () => { if (!settled) { settled = true; resolve(); } };
      req.on('data', (c) => guard.update(c));
      req.on('end', fin);
      req.on('error', fin);
      req.on('aborted', fin);
      req.on('close', fin);
      if (req.readableEnded) fin();     // 已经读完（不会再有 end 事件）
    });
    return guard.check();
  }

  /* ============ 写路径配额 ============ */

  /**
   * 写入配额判定：把 server.js 的公共盘 64GB 硬配额与 lib/quota.js 的
   * 用户配额 / 盘水位阈值串起来。
   * S3 原先完全不查配额 → 可以绕过 64GB 公共盘上限（DAV 有预检，FTP 没有）。
   *
   * @param {string} disk  盘符（public / ext:XXX）
   * @param {string} root  盘根绝对路径
   * @param {number} addBytes 本次要写入的字节数（未知传 0）
   * @param {object|null} user 写入者（用于用户配额）
   */
  quotaCheck(disk, root, addBytes, user) {
    const add = Number.isFinite(addBytes) && addBytes > 0 ? addBytes : 0;
    try {
      if (this.srv.quotaOk && !this.srv.quotaOk(disk, root, add)) {
        return { ok: false, status: 507, code: 'EntityTooLarge',
          message: '存储配额不足（公共盘 64GB 上限）' };
      }
    } catch { /* 配额模块异常不阻塞主流程 */ }
    try {
      const uq = checkUserQuota(this.srv, user, add);
      if (uq && uq.exceeded) {
        return { ok: false, status: 507, code: 'EntityTooLarge',
          message: '存储配额不足（用户配额上限）' };
      }
    } catch { /* 同上 */ }
    try {
      if (this.diskLevel(disk) === 'hard') {
        return { ok: false, status: 507, code: 'EntityTooLarge',
          message: '磁盘空间不足（已达硬阈值）' };
      }
    } catch { /* 同上 */ }
    return { ok: true };
  }

  /**
   * 盘水位（ok/soft/hard）。
   * listDisks 会触发 scanExternal()（读 /proc/self/mountinfo + 逐盘写删探针），
   * 代价很高 —— 这里缓存 30s，避免每个上传都去探一遍 U 盘。
   */
  diskLevel(disk) {
    const now = Date.now();
    if (this._diskLevel && this._diskLevel.disk === disk
      && now - this._diskLevelAt < DISK_LEVEL_TTL) return this._diskLevel.level;
    let level = 'ok';
    try {
      const dt = checkDiskThreshold(this.srv, disk);
      if (dt && dt.level) level = dt.level;
    } catch { level = 'ok'; }
    this._diskLevel = { disk, level };
    this._diskLevelAt = now;
    return level;
  }

  /* ============ SigV4 签名校验 ============ */

  /**
   * 校验 Authorization 头（AWS4-HMAC-SHA256）或 presigned 查询串（X-Amz-*）。
   *
   * 两个签名变体（规范优先、旧的兜底）：
   *   ① 规范变体：canonical headers 块带尾随 '\n'，canonical URI / query 取
   *      **原始请求行**（与 botocore 的 S3 行为一致：不二次编码、不做路径归一化）。
   *   ② 旧变体  ：头块不带尾随 '\n'，URI/query 用解码后再编码的方式 ——
   *      保持本网关历史行为，让已按旧变体签名的客户端继续可用。
   *
   * UNSIGNED-PAYLOAD / STREAMING-*（aws-chunked）不做请求体校验（客户端没承诺具体值）。
   *
   * @returns {{ok:true,payloadHash:string,variant:string}
   *          |{ok:false,status:number,code:string,message:string}}
   */
  verify(req, pathname, query) {
    const cfg = this.config();
    if (!cfg || !cfg.secretAccessKey) {
      return { ok: false, status: 403, code: 'AccessDenied', message: 'S3 网关未配置（缺少 s3.json）' };
    }

    /* 凭据强度闸门：弱凭据 → 网关拒绝服务（fail-closed），不是"降级放行"。
       运行时改弱 s3.json 也会被这里挡住（config() 按 mtime 热重载）。 */
    const cred = this.credentialCheck();
    if (!cred.ok) {
      return { ok: false, status: 503, code: 'InvalidAccessKeyId', message: cred.message };
    }

    const auth = req.headers.authorization || '';
    const presigned = query['X-Amz-Algorithm'] === 'AWS4-HMAC-SHA256';
    if (!/^AWS4-HMAC-SHA256/i.test(auth) && !presigned) {
      return { ok: false, status: 403, code: 'AccessDenied', message: '缺少 AWS SigV4 凭证' };
    }

    let accessKey, scope, signedList, givenSig, amzDate, payloadHash;
    let querySpec, queryLegacy;

    if (presigned) {
      /* ---- presigned 查询串模式 ---- */
      const cred2 = String(query['X-Amz-Credential'] || '');
      const parts = cred2.split('/');
      if (parts.length < 5) return { ok: false, status: 403, code: 'AccessDenied', message: 'X-Amz-Credential 格式非法' };
      accessKey = parts[0];
      scope = parts.slice(-4).join('/');
      /* SignedHeaders 必须是**小写**（AWS 规范）；Node 的 req.headers 键也全小写 */
      signedList = String(query['X-Amz-SignedHeaders'] || 'host').toLowerCase();
      givenSig = String(query['X-Amz-Signature'] || '');
      amzDate = String(query['X-Amz-Date'] || '');
      payloadHash = String(query['X-Amz-Content-Sha256'] || 'UNSIGNED-PAYLOAD');
      /* 规范变体用原始查询串（去掉 X-Amz-Signature）；旧变体沿用解析后的对象 */
      querySpec = canonicalQuerySpec(rawTarget(req).query, true);
      queryLegacy = canonicalQuery(query, true);

      /* 有效期校验：X-Amz-Date + X-Amz-Expires */
      const ts = parseAmzDate(amzDate);
      if (Number.isNaN(ts)) return { ok: false, status: 403, code: 'AccessDenied', message: 'X-Amz-Date 非法' };
      let expires = parseInt(query['X-Amz-Expires'], 10);
      if (!Number.isFinite(expires) || expires < 0) expires = 86400;
      expires = Math.min(expires, 7 * 86400);
      if (Date.now() > ts + expires * 1000) {
        return { ok: false, status: 403, code: 'AccessDenied', message: '预签名 URL 已过期' };
      }
    } else {
      /* ---- Authorization 头模式 ---- */
      const m = /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+)\s*,\s*SignedHeaders=([^,\s]+)\s*,\s*Signature=([0-9a-fA-F]+)\s*$/.exec(auth);
      if (!m) return { ok: false, status: 403, code: 'SignatureDoesNotMatch', message: 'Authorization 头格式非法' };
      const credParts = m[1].split('/');
      if (credParts.length < 5) return { ok: false, status: 403, code: 'AccessDenied', message: 'Credential 格式非法' };
      accessKey = credParts[0];
      scope = credParts.slice(-4).join('/');
      signedList = m[2].toLowerCase();
      givenSig = m[3];
      amzDate = String(req.headers['x-amz-date'] || '');
      if (!amzDate) return { ok: false, status: 403, code: 'AccessDenied', message: '缺少 x-amz-date 头' };
      payloadHash = String(req.headers['x-amz-content-sha256'] || 'UNSIGNED-PAYLOAD');
      querySpec = canonicalQuerySpec(rawTarget(req).query, false);
      queryLegacy = canonicalQuery(query, false);
    }

    /* accessKeyId 匹配 */
    if (accessKey !== cfg.accessKeyId) {
      return { ok: false, status: 403, code: 'InvalidAccessKeyId', message: 'AccessKeyId 不存在' };
    }

    /* 规范请求头：只取 SignedHeaders 列出的头，小写、trim、内部空白折叠 */
    const signedHeaders = signedList.split(';').filter(Boolean);
    const canonHeaders = [];
    for (const h of signedHeaders) {
      let val;
      if (h === 'host') val = req.headers.host || '';
      else val = req.headers[h];
      if (val === undefined) {
        return { ok: false, status: 403, code: 'SignatureDoesNotMatch', message: '签名包含缺失的请求头: ' + h };
      }
      canonHeaders.push(h + ':' + String(val).trim().replace(/\s+/g, ' '));
    }
    const signedHeaderStr = signedHeaders.join(';');

    /* ---- 变体①：AWS 规范（优先） ----
       canonical URI / query 取**原始请求行**：与 botocore 的 S3 行为一致
       （S3 不做路径归一化、不做二次编码），非 ASCII key 也能对上。 */
    const scopeParts = scope.split('/');
    const scopeOk = scopeParts.length === 4 && scopeParts[0] && scopeParts[3] === 'aws4_request';
    if (scopeOk) {
      const target = rawTarget(req);
      const spec = signRequest({
        secret: cfg.secretAccessKey, scope, amzDate,
        method: req.method, uri: target.path, query: querySpec,
        headers: canonHeaders, signed: signedHeaderStr, payload: payloadHash,
      });
      if (sigEqual(spec.signature, givenSig)) {
        return { ok: true, payloadHash, variant: 'aws' };
      }
    }

    /* ---- 变体②：历史变体（兜底，保证老客户端不断） ---- */
    const legacy = signRequest({
      secret: cfg.secretAccessKey, scope, amzDate,
      method: req.method, uri: uriEncode(pathname, false), query: queryLegacy,
      headers: canonHeaders, signed: signedHeaderStr, payload: payloadHash,
      legacy: true,
    });
    if (sigEqual(legacy.signature, givenSig)) {
      return { ok: true, payloadHash, variant: 'legacy' };
    }

    return { ok: false, status: 403, code: 'SignatureDoesNotMatch', message: '签名不匹配' };
  }

  /* ============ ListBuckets ============ */

  listBuckets(req, res) {
    const cfg = this.config();
    const now = new Date().toISOString();
    let buckets = '';
    for (const name of Object.keys(cfg.buckets)) {
      /* ext 桶只有在线时才列出 */
      const bd = this.bucketDisk(name);
      if (bd.error) continue;
      buckets += '<Bucket><Name>' + esc(name) + '</Name><CreationDate>' + now + '</CreationDate></Bucket>';
    }
    const body = '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + '<Owner><ID>nas</ID><DisplayName>nas</DisplayName></Owner>'
      + '<Buckets>' + buckets + '</Buckets></ListAllMyBucketsResult>';
    this.sendXml(res, 200, body);
  }

  /* ============ ListObjectsV2 ============ */

  /**
   * 递归收集盘内全部对象 key（跳过隐藏/临时文件）。
   * 目录本身不作为对象返回（S3 无目录概念，由 key 前缀表达）。
   */
  collectKeys(root, prefix) {
    const out = [];
    const skip = (name) => /^\./.test(name) || /\.s3part-/.test(name) || /\.s3tmp-/.test(name) || /\.davtmp-/.test(name);
    const walk = (dir, rel) => {
      if (out.length >= WALK_MAX) return;
      let names;
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (skip(name)) continue;
        const full = path.join(dir, name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const key = rel ? rel + '/' + name : name;
        if (st.isDirectory()) walk(full, key);
        else out.push(key);
        if (out.length >= WALK_MAX) return;
      }
    };
    walk(root, '');
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  async listBucket(req, res, bucket, query, headOnly) {
    const bd = this.bucketDisk(bucket);
    if (bd.error) return this.sendError(res, 404, 'NoSuchBucket', '桶不存在: ' + bucket);
    /* GET /<bucket>?location 兼容（rclone 等客户端探测用） */
    if (query.location !== undefined) {
      if (headOnly) { res.writeHead(200, { 'Content-Length': 0 }); return res.end(); }
      return this.sendXml(res, 200,
        '<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');
    }
    if (headOnly) { res.writeHead(200, { 'Content-Length': 0 }); return res.end(); }

    const t = this.srv.resolveTarget({ disk: bd.disk, path: '' }, this.gatewayUser());
    if (t.error) return this.sendError(res, t.code === 404 ? 404 : 403, bd.error || 'NoSuchBucket', t.error);

    const prefix = String(query.prefix || '');
    const delimiter = String(query.delimiter || '');
    let maxKeys = parseInt(query['max-keys'], 10);
    if (!Number.isFinite(maxKeys) || maxKeys < 0) maxKeys = 1000;
    maxKeys = Math.min(maxKeys, 100000);

    /* continuation-token = 上一页最后一个 key 的 base64 */
    let lastKey = '';
    if (query['continuation-token']) {
      try { lastKey = Buffer.from(String(query['continuation-token']), 'base64').toString('utf8'); } catch { lastKey = ''; }
    }

    const all = this.collectKeys(t.root, prefix);
    const contents = [];
    const commonPrefixes = [];
    let truncated = false;
    let nextToken = '';
    let seenLast = !lastKey;
    let count = 0;
    const cpSet = new Set();

    for (const key of all) {
      if (!seenLast) {
        if (key === lastKey) seenLast = true;
        continue;
      }
      if (count >= maxKeys) { truncated = true; break; }

      /* delimiter 分组：prefix 之后首次出现 delimiter 的位置 → CommonPrefix */
      let cp = '';
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) cp = prefix + rest.slice(0, idx + delimiter.length);
      }
      if (cp) {
        if (!cpSet.has(cp)) {
          cpSet.add(cp);
          commonPrefixes.push(cp);
          count++;
        }
      } else {
        contents.push(key);
        count++;
      }
      /* 分页游标以"最后一次处理的 key"为准（Contents 与 CommonPrefix 均可） */
      nextToken = Buffer.from(key, 'utf8').toString('base64');
    }

    let x = '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">';
    x += '<Name>' + esc(bucket) + '</Name>';
    x += '<Prefix>' + esc(prefix) + '</Prefix>';
    if (delimiter) x += '<Delimiter>' + esc(delimiter) + '</Delimiter>';
    x += '<MaxKeys>' + maxKeys + '</MaxKeys>';
    x += '<KeyCount>' + (contents.length + commonPrefixes.length) + '</KeyCount>';
    x += '<IsTruncated>' + (truncated ? 'true' : 'false') + '</IsTruncated>';
    if (query['continuation-token']) x += '<ContinuationToken>' + esc(query['continuation-token']) + '</ContinuationToken>';
    if (truncated) x += '<NextContinuationToken>' + esc(nextToken) + '</NextContinuationToken>';
    for (const key of contents) {
      let st = null;
      try { st = fs.statSync(path.join(t.root, key)); } catch { continue; }
      /* ⚠️ 非标准 ETag（size-mtime 摘要），**不是** MD5。
         为什么不用真 MD5：真 ETag 必须是对象内容的 MD5，而列举要扫全桶，
         每个对象全量读盘算 MD5 在 NAS 上是灾难（几十万个对象）。
         口径约定（客户端须知）：
           - 列举（ListObjectsV2）的 ETag = 伪 ETag（size-mtime），随大小/修改时间变化；
           - GET/HEAD 的 ETag = 真实 MD5（rclone / aws-cli 的完整性校验依赖它）。
         所以**不要**拿列举得到的 ETag 去做 If-Match 条件请求（口径不同，必然 412）。
         响应头 x-amz-meta-etag-algorithm 标明当前响应里 ETag 的算法。 */
      const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs / 1000).toString(16) + '"';
      x += '<Contents><Key>' + esc(key) + '</Key>'
        + '<LastModified>' + new Date(st.mtimeMs).toISOString() + '</LastModified>'
        + '<ETag>' + esc(etag) + '</ETag>'
        + '<Size>' + st.size + '</Size>'
        + '<StorageClass>STANDARD</StorageClass></Contents>';
    }
    for (const cp of commonPrefixes) {
      x += '<CommonPrefixes><Prefix>' + esc(cp) + '</Prefix></CommonPrefixes>';
    }
    x += '</ListBucketResult>';
    this.sendXml(res, 200, x, { 'x-amz-meta-etag-algorithm': 'pseudo-size-mtime' });
  }

  /* ============ ETag（md5，带缓存） ============ */

  md5CacheSet(abs, md5hex, st) {
    if (this._md5.size >= MD5_CACHE_MAX) {
      this._md5.delete(this._md5.keys().next().value); // Map 保持插入序，淘汰最早一条
    }
    this._md5.set(abs, { md5: md5hex, size: st.size, mtime: st.mtimeMs });
  }

  /** 异步计算文件 md5（GET/HEAD 时流式计算，不阻塞事件循环），结果缓存 */
  async md5Of(abs, st) {
    const c = this._md5.get(abs);
    if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.md5;
    const md5hex = await new Promise((resolve, reject) => {
      const h = crypto.createHash('md5');
      fs.createReadStream(abs, { highWaterMark: 1 << 20 })
        .on('data', (d) => h.update(d))
        .on('end', () => resolve(h.digest('hex')))
        .on('error', reject);
    });
    this.md5CacheSet(abs, md5hex, st);
    return md5hex;
  }

  /* ============ GET / HEAD object ============ */

  async getObject(req, res, bucket, key, headOnly) {
    const bd = this.bucketDisk(bucket);
    if (bd.error) return this.sendError(res, 404, 'NoSuchBucket', '桶不存在: ' + bucket);
    const t = this.srv.resolveTarget({ disk: bd.disk, path: key }, this.gatewayUser());
    if (t.error) return this.sendError(res, t.code === 404 ? 404 : 403, 'NoSuchKey', t.error);

    let st;
    try { st = fs.statSync(t.abs); } catch {
      return this.sendError(res, 404, 'NoSuchKey', '对象不存在: ' + key);
    }
    if (!st.isFile()) return this.sendError(res, 404, 'NoSuchKey', '对象不存在: ' + key);

    /* ETag = 真实 MD5（与 AWS 单段上传对象的 ETag 语义一致，rclone 会用它做完整性校验）。
       注意：列举接口给的是"伪 ETag"（size-mtime），两者口径不同 ——
       因此响应头里标明算法，避免客户端拿列举的 ETag 做 If-Match（必然 412）。 */
    const etag = '"' + (await this.md5Of(t.abs, st)) + '"';
    const headers = {
      'Content-Type': mimeOf(t.abs),
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      ETag: etag,
      'x-amz-meta-etag-algorithm': 'md5',
      'x-amz-request-id': crypto.randomBytes(8).toString('hex'),
    };

    /* Range 解析：bytes=a-b / bytes=a- / bytes=-n；非法 → 416 */
    let start = 0, end = st.size - 1, code = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m && (m[1] || m[2])) {
        if (!m[1] && m[2]) {                    // 后缀范围 -n：取最后 n 字节
          const n = parseInt(m[2], 10);
          start = n > 0 ? Math.max(0, st.size - n) : st.size;
          end = st.size - 1;
        } else {
          start = parseInt(m[1], 10) || 0;
          if (m[2]) end = parseInt(m[2], 10);
          if (Number.isNaN(end)) end = st.size - 1;
        }
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
          return res.end();
        }
        if (end >= st.size) end = st.size - 1;
        code = 206;
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      }
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (headOnly) return res.end();

    const stream = fs.createReadStream(t.abs, { start, end, highWaterMark: 1 << 20 });
    stream.on('error', () => { try { res.destroy(); } catch { /* closed */ } });
    stream.pipe(res);
  }

  /* ============ PUT object（流式落盘 + md5 + 完整性 + 配额） ============ */

  putObject(req, res, bucket, key) {
    const bd = this.bucketDisk(bucket);
    if (bd.error) return this.sendError(res, 404, 'NoSuchBucket', '桶不存在: ' + bucket);
    const t = this.srv.resolveTarget({ disk: bd.disk, path: key, _write: true }, this.gatewayUser());
    if (t.error) return this.sendError(res, t.code === 404 ? 404 : 403, 'AccessDenied', t.error);
    if (fs.existsSync(t.abs) && fs.statSync(t.abs).isDirectory()) {
      return this.sendError(res, 409, 'InvalidArgument', '同名目录已存在');
    }

    /* S3 语义：key 的父目录隐式创建 */
    try { fs.mkdirSync(path.dirname(t.abs), { recursive: true }); } catch {
      return this.sendError(res, 500, 'InternalError', '无法创建父目录');
    }

    /* 配额预检：Content-Length 已知时先查一次；
       长度未知（chunked）则靠下面"边收边计数"兜住（否则 chunked 可绕过配额）。 */
    const len = parseInt(req.headers['content-length'], 10);
    const knownLen = Number.isFinite(len) ? len : 0;
    const qc = this.quotaCheck(t.disk, t.root, knownLen, this.gatewayUser());
    if (!qc.ok) return this.sendError(res, qc.status, qc.code, qc.message);

    /* 大于 8MB（或长度未知/chunked）→ .s3part- 临时文件；小文件 → .s3tmp-；完成后 rename */
    const big = !Number.isFinite(len) || len > BIG_PUT_THRESHOLD;
    const rand = crypto.randomBytes(4).toString('hex');
    const tmp = t.abs + (big ? '.s3part-' : '.s3tmp-') + rand;

    /* 请求体完整性校验器（handle() 里挂好；直接调用本方法时退化为不校验） */
    const guard = req._s3Guard || this.makePayloadGuard('UNSIGNED-PAYLOAD');
    const hash = crypto.createHash('md5');
    const ws = fs.createWriteStream(tmp, { flags: 'wx', highWaterMark: 1 << 20 });
    let done = false;
    let written = 0;        // 已落盘字节数（配额边收边计数用）
    let nextCheck = QUOTA_STEP;

    /* 失败路径：**先 destroy 写流再 unlink**。
       只 unlink 不关流，fd 仍持有已删除文件的空间（Linux 下块不归还），
       反复中断上传会累积成句柄泄漏 —— 见 test/t-dav-tmp.js 记录的事故。 */
    const failHttp = (status, code, message) => {
      if (done) return;
      done = true;
      try { ws.destroy(); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      try { this.sendError(res, status, code, message); } catch { /* closed */ }
    };
    const failConn = () => {
      if (done) return;
      done = true;
      try { ws.destroy(); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      try { res.destroy(); } catch { /* closed */ }
    };

    const finish = (err) => {
      if (done) return;
      if (err) return failConn();
      /* 完整性闸门：实际 body 的 SHA-256 必须与签名时声明的一致。
         不一致 = "签一个 hash、传另一个 body"，临时文件必须丢弃。 */
      const mismatch = guard.check();
      if (mismatch) {
        return failHttp(400, mismatch, '请求体 SHA-256 与 x-amz-content-sha256 声明不一致');
      }
      done = true;
      try {
        fs.renameSync(tmp, t.abs);
      } catch (e) {
        /* Windows/跨设备兜底：copy + 删临时 */
        try { fs.copyFileSync(tmp, t.abs); fs.unlinkSync(tmp); } catch (e2) {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          return this.sendError(res, 500, 'InternalError', '写入失败: ' + e2.message);
        }
      }
      this.srv.invalidateSizeCache();
      this.srv.audit({
        userObj: this.gatewayUser(), action: 's3-put', disk: t.disk, path: key,
        ip: req.socket.remoteAddress, detail: bucket,
      });
      res.writeHead(200, {
        ETag: '"' + hash.digest('hex') + '"',
        'Content-Length': 0,
        'x-amz-meta-etag-algorithm': 'md5',
      });
      res.end();
    };

    req.on('data', (c) => {
      if (done) return;                       // 已经失败/完成，不再处理后续数据
      hash.update(c);
      guard.update(c);
      written += c.length;
      /* 边收边计数：chunked（无 content-length）上传同样不能突破配额。
         每 1MB 复查一次，超限立刻中断并清理临时文件。 */
      if (written >= nextCheck) {
        nextCheck = written + QUOTA_STEP;
        let over = false;
        try { over = !this.srv.quotaOk(t.disk, t.root, written); } catch { over = false; }
        if (over) {
          failHttp(507, 'EntityTooLarge', '存储配额不足（公共盘 64GB 上限）');
          try { req.pause(); } catch { /* ignore */ }
        }
      }
    });
    req.on('error', () => finish(new Error('request aborted')));
    req.on('aborted', () => finish(new Error('request aborted')));
    ws.on('error', (e) => finish(e));
    ws.on('finish', () => finish(null));
    req.pipe(ws);
  }

  /* ============ DELETE object（硬删，不走回收站） ============ */

  async deleteObject(req, res, bucket, key, query) {
    /* DELETE ?uploadId=X = 中止 Multipart Upload */
    if (query.uploadId) return this.mpuAbort(req, res, query.uploadId);

    const bd = this.bucketDisk(bucket);
    if (bd.error) return this.sendError(res, 404, 'NoSuchBucket', '桶不存在: ' + bucket);
    const t = this.srv.resolveTarget({ disk: bd.disk, path: key, _write: true }, this.gatewayUser());
    if (t.error) return this.sendError(res, t.code === 404 ? 404 : 403, 'AccessDenied', t.error);

    let st = null;
    try { st = fs.statSync(t.abs); } catch { /* 不存在也返回 204（S3 幂等语义） */ }

    if (st) {
      try {
        // S3 协议没有回收站概念：这里直接硬删（unlink/rmdir），不进 .recycle
        if (st.isDirectory()) {
          fs.rmdirSync(t.abs); // 目录仅允许删空目录（客户端通常逐个删 key）
        } else {
          fs.unlinkSync(t.abs);
          this._md5.delete(t.abs);
        }
      } catch (e) {
        return this.sendError(res, 500, 'InternalError', '删除失败: ' + e.message);
      }
      this.srv.invalidateSizeCache();
      this.srv.audit({
        userObj: this.gatewayUser(), action: 's3-delete', disk: t.disk, path: key,
        ip: req.socket.remoteAddress, detail: bucket + '（硬删，不走回收站）',
      });
    }
    res.writeHead(204, { 'Content-Length': 0 });
    res.end();
  }

  /* ============ Multipart Upload ============ */

  /** uploadId 状态：内存 Map + 持久化 <dataDir>/s3-mpu.json（防重启丢失） */
  mpuState() {
    if (this._mpu) return this._mpu;
    this._mpu = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.srv.cfg.dataDir, MPU_FILE), 'utf8'));
      for (const u of Array.isArray(raw.uploads) ? raw.uploads : []) this._mpu.set(u.uploadId, u);
    } catch { /* 首次运行无文件 */ }
    return this._mpu;
  }

  mpuSave() {
    try {
      const file = path.join(this.srv.cfg.dataDir, MPU_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ uploads: [...this.mpuState().values()] }), 'utf8');
      fs.renameSync(tmp, file);
    } catch { /* 持久化失败不影响主流程（仅重启后丢上传会话） */ }
  }

  mpuTmpDir(uploadId) {
    return path.join(this.srv.cfg.dataDir, MPU_DIR, String(uploadId).replace(/[^\w-]/g, ''));
  }

  /** POST /<bucket>/<key>?uploads → InitiateMultipartUpload */
  async mpuInitiate(req, res, bucket, key) {
    /* 发起分片上传的请求体通常是空的，但仍要按声明值核对（完整性口径一致） */
    const body = await readBody(req, 1024 * 1024).catch(() => Buffer.alloc(0));
    const guard = req._s3Guard || this.makePayloadGuard('UNSIGNED-PAYLOAD');
    guard.update(body);
    const bad = guard.check();
    if (bad) {
      return this.sendError(res, 400, bad, '请求体 SHA-256 与 x-amz-content-sha256 声明不一致');
    }
    const bd = this.bucketDisk(bucket);
    if (bd.error) return this.sendError(res, 404, 'NoSuchBucket', '桶不存在: ' + bucket);
    const t = this.srv.resolveTarget({ disk: bd.disk, path: key, _write: true }, this.gatewayUser());
    if (t.error) return this.sendError(res, t.code === 404 ? 404 : 403, 'AccessDenied', t.error);

    const uploadId = crypto.randomBytes(16).toString('hex');
    try { fs.mkdirSync(this.mpuTmpDir(uploadId), { recursive: true }); } catch {
      return this.sendError(res, 500, 'InternalError', '无法创建分片临时目录');
    }
    this.mpuState().set(uploadId, {
      uploadId, bucket, key, disk: bd.disk,
      initiated: Date.now(), parts: [],
    });
    this.mpuSave();
    this.srv.audit({
      userObj: this.gatewayUser(), action: 's3-mpu-init', disk: t.disk, path: key,
      ip: req.socket.remoteAddress, detail: uploadId,
    });
    this.sendXml(res, 200,
      '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + '<Bucket>' + esc(bucket) + '</Bucket><Key>' + esc(key) + '</Key>'
      + '<UploadId>' + esc(uploadId) + '</UploadId></InitiateMultipartUploadResult>');
  }

  /** PUT /<bucket>/<key>?partNumber=N&uploadId=X → 上传分片到临时目录 */
  async mpuPutPart(req, res, bucket, key, query) {
    const uploadId = String(query.uploadId || '');
    const num = parseInt(query.partNumber, 10);
    const entry = this.mpuState().get(uploadId);
    if (!entry || entry.bucket !== bucket || entry.key !== key) {
      return this.sendError(res, 404, 'NoSuchUpload', '上传会话不存在: ' + uploadId);
    }
    if (!Number.isInteger(num) || num < 1 || num > 10000) {
      return this.sendError(res, 400, 'InvalidArgument', 'partNumber 必须为 1-10000');
    }

    const partFile = path.join(this.mpuTmpDir(uploadId), 'part-' + num);
    try { fs.mkdirSync(path.dirname(partFile), { recursive: true }); } catch {
      return this.sendError(res, 500, 'InternalError', '无法创建分片临时目录');
    }

    /* 分片也要计入配额：已上传分片 + 本片 不得超过目标盘剩余额度。
       （分片暂存在 dataDir/s3-mpu/ 下，不占目标盘；但合并后会落到目标盘，
        所以这里按"合并后总量"预检，避免绕过后再在 Complete 时才失败。） */
    const already = (entry.parts || []).reduce((s, p) => s + (p.size || 0), 0);
    const lenHint = parseInt(req.headers['content-length'], 10);
    const tDisk = this.srv.resolveTarget({ disk: entry.disk, path: '' }, this.gatewayUser());
    if (!tDisk.error) {
      const qc = this.quotaCheck(entry.disk, tDisk.root,
        already + (Number.isFinite(lenHint) ? lenHint : 0), this.gatewayUser());
      if (!qc.ok) return this.sendError(res, qc.status, qc.code, qc.message);
    }

    const hash = crypto.createHash('md5');
    const guard = req._s3Guard || this.makePayloadGuard('UNSIGNED-PAYLOAD');
    const ws = fs.createWriteStream(partFile, { flags: 'w' });
    let size = 0;
    const done = await new Promise((resolve) => {
      let finished = false;
      const fin = (err) => { if (!finished) { finished = true; resolve(err || null); } };
      req.on('data', (c) => { hash.update(c); guard.update(c); size += c.length; });
      req.on('error', () => fin(new Error('request aborted')));
      req.on('aborted', () => fin(new Error('request aborted')));
      ws.on('error', fin);
      ws.on('finish', () => fin(null));
      req.pipe(ws);
    });

    if (done) {
      try { ws.destroy(); } catch { /* ignore */ }
      try { fs.unlinkSync(partFile); } catch { /* ignore */ }
      return this.sendError(res, 500, 'InternalError', '分片写入失败');
    }

    /* 完整性：分片实际内容的 SHA-256 必须与签名时声明的一致 */
    const mismatch = guard.check();
    if (mismatch) {
      try { fs.unlinkSync(partFile); } catch { /* ignore */ }
      return this.sendError(res, 400, mismatch, '请求体 SHA-256 与 x-amz-content-sha256 声明不一致');
    }

    const etag = hash.digest('hex');
    entry.parts = entry.parts.filter((p) => p.n !== num);
    entry.parts.push({ n: num, file: partFile, size, etag });
    this.mpuSave();
    res.writeHead(200, { ETag: '"' + etag + '"', 'Content-Length': 0, 'x-amz-meta-etag-algorithm': 'md5' });
    res.end();
  }

  /** POST /<bucket>/<key>?uploadId=X → CompleteMultipartUpload：按分片序号顺序拼接 */
  async mpuComplete(req, res, bucket, key, query) {
    const uploadId = String(query.uploadId || '');
    const entry = this.mpuState().get(uploadId);
    if (!entry || entry.bucket !== bucket || entry.key !== key) {
      return this.sendError(res, 404, 'NoSuchUpload', '上传会话不存在: ' + uploadId);
    }

    /* 解析请求体中的 Part 列表（客户端未列时容错为全部已传分片） */
    const raw = await readBody(req, 4 * 1024 * 1024).catch(() => Buffer.alloc(0));
    /* 完整性：Complete 的请求体（XML 分片清单）同样要核对声明的摘要 */
    const guard = req._s3Guard || this.makePayloadGuard('UNSIGNED-PAYLOAD');
    guard.update(raw);
    const bad = guard.check();
    if (bad) {
      return this.sendError(res, 400, bad, '请求体 SHA-256 与 x-amz-content-sha256 声明不一致');
    }
    const xml = raw.toString('utf8');
    const want = [...xml.matchAll(/<PartNumber>\s*(\d+)\s*<\/PartNumber>/g)].map((m) => parseInt(m[1], 10));

    let ordered;
    if (want.length) {
      want.sort((a, b) => a - b);
      ordered = [];
      for (const n of want) {
        const p = entry.parts.find((x) => x.n === n);
        if (!p) return this.sendError(res, 400, 'InvalidPart', '分片不存在或未上传: ' + n);
        ordered.push(p);
      }
    } else {
      ordered = entry.parts.slice().sort((a, b) => a.n - b.n);
    }
    if (!ordered.length) return this.sendError(res, 400, 'InvalidPart', '没有可合并的分片');
    for (let i = 0; i < ordered.length - 1; i++) {
      if (ordered[i].n >= ordered[i + 1].n) {
        return this.sendError(res, 400, 'InvalidPartOrder', 'PartNumber 列表必须升序');
      }
    }
    /* S3 规范：除最后一个分片外，其余 ≥ 5MB */
    for (let i = 0; i < ordered.length - 1; i++) {
      if ((ordered[i].size || 0) < MPU_PART_MIN) {
        return this.sendError(res, 400, 'EntityTooSmall',
          '分片 ' + ordered[i].n + ' 小于 5MB（仅最后一片允许）');
      }
    }
    /* 重启恢复场景：临时分片文件必须仍然存在 */
    for (const p of ordered) {
      if (!fs.existsSync(p.file)) return this.sendError(res, 400, 'InvalidPart', '分片文件已丢失: ' + p.n);
    }

    const t = this.srv.resolveTarget({ disk: entry.disk, path: key, _write: true }, this.gatewayUser());
    if (t.error) return this.sendError(res, t.code === 404 ? 404 : 403, 'AccessDenied', t.error);
    try { fs.mkdirSync(path.dirname(t.abs), { recursive: true }); } catch { /* 后续写入再报错 */ }

    /* 合并后的总大小要计入配额（分片阶段已预检，这里是落地前的最后一道闸） */
    const total = ordered.reduce((s, p) => s + (p.size || 0), 0);
    const qc = this.quotaCheck(t.disk, t.root, total, this.gatewayUser());
    if (!qc.ok) return this.sendError(res, qc.status, qc.code, qc.message);

    /* 顺序拼接：逐片 createReadStream → 同一写流（end:false），同时累计 md5
       临时文件名带**随机后缀**：两个并发上传同一 key 时，
       固定名 ".s3part-mpu" 会互相覆盖（后一个把前一个的中间结果冲掉）。 */
    const finalTmp = t.abs + '.s3part-mpu-' + crypto.randomBytes(6).toString('hex');
    const hash = crypto.createHash('md5');
    let ws = null;
    try {
      ws = fs.createWriteStream(finalTmp, { flags: 'w' });
      for (const p of ordered) {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(p.file);
          rs.on('data', (d) => hash.update(d));
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(ws, { end: false });
        });
      }
      await new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('close', resolve);
        ws.end();
      });
      try { fs.renameSync(finalTmp, t.abs); } catch (e) {
        fs.copyFileSync(finalTmp, t.abs);
        fs.unlinkSync(finalTmp);
      }
    } catch (e) {
      /* 失败路径：先 destroy 写流再删临时文件（否则 fd 仍锁着已删除文件的空间） */
      try { if (ws) ws.destroy(); } catch { /* ignore */ }
      try { fs.unlinkSync(finalTmp); } catch { /* ignore */ }
      return this.sendError(res, 500, 'InternalError', '合并分片失败: ' + e.message);
    }

    /* 清理会话（内存 + 临时目录 + 持久化） */
    this.mpuState().delete(uploadId);
    this.mpuSave();
    try { fs.rmSync(this.mpuTmpDir(uploadId), { recursive: true, force: true }); } catch { /* ignore */ }
    this.srv.invalidateSizeCache();
    this.srv.audit({
      userObj: this.gatewayUser(), action: 's3-mpu-complete', disk: t.disk, path: key,
      ip: req.socket.remoteAddress, detail: uploadId + '（' + ordered.length + ' 片）',
    });

    this.sendXml(res, 200,
      '<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + '<Location>/' + esc(bucket) + '/' + esc(key) + '</Location>'
      + '<Bucket>' + esc(bucket) + '</Bucket><Key>' + esc(key) + '</Key>'
      + '<ETag>&quot;' + hash.digest('hex') + '&quot;</ETag>'
      + '</CompleteMultipartUploadResult>');
  }

  /** DELETE /<bucket>/<key>?uploadId=X → AbortMultipartUpload */
  async mpuAbort(req, res, uploadId) {
    const entry = this.mpuState().get(uploadId);
    if (!entry) return this.sendError(res, 404, 'NoSuchUpload', '上传会话不存在: ' + uploadId);
    this.mpuState().delete(uploadId);
    this.mpuSave();
    try { fs.rmSync(this.mpuTmpDir(uploadId), { recursive: true, force: true }); } catch { /* ignore */ }
    this.srv.audit({
      userObj: this.gatewayUser(), action: 's3-mpu-abort', disk: entry.disk, path: entry.key,
      ip: req.socket.remoteAddress, detail: uploadId,
    });
    res.writeHead(204, { 'Content-Length': 0 });
    res.end();
  }

  /** POST /<bucket>/<key> 的分派（?uploads / ?uploadId=X） */
  async postObject(req, res, bucket, key, query) {
    if (query.uploads !== undefined) return this.mpuInitiate(req, res, bucket, key);
    if (query.uploadId) return this.mpuComplete(req, res, bucket, key, query);
    return this.sendError(res, 405, 'MethodNotAllowed', '该路径不支持 POST');
  }
}

module.exports = { S3Gateway, S3_PREFIX, selftest, signRequest };

/* =====================================================================
   自测：node lib/s3.js 直接跑（也可 require 后调用 selftest()）
   ---------------------------------------------------------------------
   覆盖：
     1. AWS 官方 SigV4 test suite 的 get-vanilla 向量（证明"真的符合规范"）
     2. 历史变体（向后兼容路径）仍然自洽
     3. canonical query string 的排序与排除规则
     4. 凭据强度闸门（弱凭据 fail-closed）
     5. 端到端 verify()：规范签名 / 旧签名 / 篡改签名
     6. 请求体摘要守卫
   ===================================================================== */

/** 构造一个最小的 srv 替身（自测用，不依赖真实 FileServer） */
function mockSrv(dataDir) {
  const storage = path.join(dataDir, 'storage');
  return {
    cfg: { dataDir, storageDir: storage },
    users: { users: [{ id: 'u1', username: 'admin', role: 'admin', disabled: false }] },
    audit() { },
    invalidateSizeCache() { },
    usedBytes() { return 0; },
    quotaOk() { return true; },
    scanExternal() { return []; },
    listDisks() { return [{ id: 'public', name: '公共盘', used: 0, quota: 0 }]; },
    resolveTarget(q) {
      const root = q.disk === 'public'
        ? storage
        : path.join(storage, String(q.disk || 'x').replace(/[^\w]/g, ''));
      return { root, abs: path.join(root, q.path || ''), disk: q.disk || 'public', scope: q.disk || 'public' };
    },
  };
}

function selftest() {
  const results = [];
  const t = (name, actual, expected) => {
    const ok = String(actual) === String(expected);
    results.push({ name, ok, actual: String(actual), expected: String(expected) });
    return ok;
  };
  const tbool = (name, cond) => {
    results.push({ name, ok: !!cond, actual: String(!!cond), expected: 'true' });
    return !!cond;
  };

  /* ---- 1. AWS 官方 SigV4 test suite：get-vanilla ----
     凭据 AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
     scope  20150830/us-east-1/service/aws4_request
     期望签名 5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31
     这个用例同时钉死了"canonical headers 块以 \n 结尾"——少一个换行签名就不同。 */
  const VEC = {
    secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    scope: '20150830/us-east-1/service/aws4_request',
    amzDate: '20150830T123600Z',
    method: 'GET', uri: '/', query: '',
    headers: ['host:example.amazonaws.com', 'x-amz-date:20150830T123600Z'],
    signed: 'host;x-amz-date',
    payload: EMPTY_SHA256,
    expect: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  };
  const spec = signRequest(VEC);
  t('AWS SigV4 test suite/get-vanilla：规范变体签名一致', spec.signature, VEC.expect);
  t('规范变体 canonical request 摘要',
    sha256hex(spec.canonicalRequest),
    'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
  tbool('canonical headers 块以 \\n 结尾（头块与 SignedHeaders 之间是空行）',
    spec.canonicalRequest.indexOf('\n\nhost;x-amz-date\n') >= 0);

  /* ---- 2. 历史变体（向后兼容路径） ---- */
  const legacyVec = Object.assign({}, VEC, { legacy: true });
  const legacy = signRequest(legacyVec);
  tbool('旧变体签名与规范变体不同（修复点确实是头块尾随换行）',
    legacy.signature !== spec.signature);
  t('旧变体 canonical request 摘要（历史行为回归锚点）',
    sha256hex(legacy.canonicalRequest),
    '46610ed656d1c982861911b0a4aeeb28411982e91a110760c8c51c2340da90d7');

  /* ---- 3. canonical query string ---- */
  t('canonical query：按 key 排序', canonicalQuerySpec('b=2&a=1', false), 'a=1&b=2');
  t('canonical query：同名按 value 排序', canonicalQuerySpec('a=2&a=1', false), 'a=1&a=2');
  t('canonical query：排除 X-Amz-Signature',
    canonicalQuerySpec('X-Amz-Signature=aa&a=1', true), 'a=1');

  /* ---- 4./5./6. 需要真实网关实例（临时目录，不碰生产数据） ---- */
  const weakDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-selftest-weak-'));
  const okDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-selftest-ok-'));
  try {
    /* 4. 凭据强度闸门 */
    fs.writeFileSync(path.join(weakDir, 's3.json'), JSON.stringify({
      accessKeyId: 'nas', secretAccessKey: 'nas-s3-2026', buckets: { b: { disk: 'public' } },
    }), 'utf8');
    const gwWeak = new S3Gateway(mockSrv(weakDir));
    const weakCheck = gwWeak.credentialCheck();
    tbool('弱 secret（nas-s3-2026）被闸门判为不合规', weakCheck.ok === false);
    tbool('弱凭据的错误信息含修复方法', /openssl rand/.test(String(weakCheck.message || '')));
    const weakVerify = gwWeak.verify({ method: 'GET', url: '/s3', headers: { host: 'x' } }, '/s3', {});
    t('弱凭据时 verify 直接拒绝', weakVerify.ok, false);
    t('弱凭据时返回 503（fail-closed，不是 403 放行）', weakVerify.status, 503);

    const strong = 'a3f9' + crypto.randomBytes(24).toString('hex');   // 52 位十六进制
    fs.writeFileSync(path.join(okDir, 's3.json'), JSON.stringify({
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: strong, buckets: { b: { disk: 'public' } },
    }), 'utf8');
    const gw = new S3Gateway(mockSrv(okDir));
    tbool('强 secret 通过闸门', gw.credentialCheck().ok === true);

    /* 5. 端到端 verify() */
    const amzDate = '20150830T123600Z';
    const scope = '20150830/us-east-1/s3/aws4_request';
    const signedList = 'host;x-amz-content-sha256;x-amz-date';
    const headVec = {
      secret: strong, scope, amzDate, method: 'GET', uri: '/s3', query: '',
      headers: ['host:127.0.0.1:8081', 'x-amz-content-sha256:' + EMPTY_SHA256, 'x-amz-date:' + amzDate],
      signed: signedList, payload: EMPTY_SHA256,
    };
    const mkAuth = (sig) => 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/' + scope
      + ', SignedHeaders=' + signedList + ', Signature=' + sig;
    const mkReq = (auth) => ({
      method: 'GET', url: '/s3', socket: { remoteAddress: '127.0.0.1' },
      headers: {
        host: '127.0.0.1:8081', 'x-amz-date': amzDate,
        'x-amz-content-sha256': EMPTY_SHA256, authorization: auth,
      },
    });

    const vAws = gw.verify(mkReq(mkAuth(signRequest(headVec).signature)), '/s3', {});
    tbool('端到端：规范签名通过（variant=aws）', vAws.ok === true && vAws.variant === 'aws');
    const vLegacy = gw.verify(mkReq(mkAuth(signRequest(Object.assign({}, headVec, { legacy: true })).signature)), '/s3', {});
    tbool('端到端：旧签名仍然通过（variant=legacy，向后兼容）', vLegacy.ok === true && vLegacy.variant === 'legacy');
    const vBad = gw.verify(mkReq(mkAuth('0'.repeat(64))), '/s3', {});
    t('端到端：伪造签名被拒', vBad.ok, false);
    t('端到端：伪造签名返回 SignatureDoesNotMatch', vBad.code, 'SignatureDoesNotMatch');

    /* 6. 请求体摘要守卫 */
    const gBad = gw.makePayloadGuard(EMPTY_SHA256);
    gBad.update(Buffer.from('hello'));
    t('请求体与声明摘要不符 → XAmzContentSHA256Mismatch', gBad.check(), 'XAmzContentSHA256Mismatch');
    const gEmpty = gw.makePayloadGuard(EMPTY_SHA256);
    t('空请求体摘要通过', gEmpty.check(), null);
    const gUnsign = gw.makePayloadGuard('UNSIGNED-PAYLOAD');
    gUnsign.update(Buffer.from('whatever'));
    t('UNSIGNED-PAYLOAD 跳过校验', gUnsign.check(), null);
  } finally {
    try { fs.rmSync(weakDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(okDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const pass = results.filter((r) => r.ok).length;
  return { results, pass, fail: results.length - pass };
}

if (require.main === module) {
  const r = selftest();
  for (const x of r.results) {
    console.log((x.ok ? '  PASS  ' : '  FAIL  ') + x.name);
    if (!x.ok) console.log('          期望: ' + x.expected + '\n          实际: ' + x.actual);
  }
  console.log('\n结果：' + r.pass + ' 通过 / ' + r.fail + ' 失败');
  process.exit(r.fail ? 1 : 0);
}

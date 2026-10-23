'use strict';

/* =====================================================================
   lib/sec-crypto.js — 传输与存储加密「真实状态」采集
   ---------------------------------------------------------------------
   需求（P0 第 8 项）：列出真实状态（TLS 证书 / HTTPS 端口 / SMB 签名与加密 /
   S3 签名），能开关的要能开关，不能做的写清原因。

   本模块只做**只读探测** + 一个我们自己的开关（强制 HTTPS，见 sec-ip.js）。
   刻意不碰 nginx / Samba 主配置：
     · nginx 主配置属主线（READM-TEAM §5 明确只允许 lead 改）；
     · Samba 属 smb-sec 团队范围。
   所以 TLS / SMB / S3 的开关能力以「状态 + 变更路径 + 影响」呈现，
   我们真正能落地的开关是「应用层强制 HTTPS」与「IP 白名单」。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const store = require('./sec-store');
const ipMod = require('./sec-ip');

const NGINX_CONF = '/etc/nginx/sites-enabled/station';
const NGINX_CERT = '/etc/nginx/ssl/station.crt';

let cache = { at: 0, value: null };
const CACHE_MS = 15000;

function run(cmd, args, timeout = 3000) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out || '').trim() };
  } catch (e) {
    return { ok: false, out: '', error: (e && e.message) || String(e) };
  }
}

function sudoRun(cmd, args, timeout = 3000) {
  return run('sudo', ['-n', cmd, ...args], timeout);
}

/** 发一个本地请求，拿状态码（用于证明「HTTPS 端口真的在服务」） */
function probe(url, timeout = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const isHttps = url.startsWith('https:');
      const mod = isHttps ? https : http;
      const req = mod.get(url, { timeout, rejectUnauthorized: false }, (res) => {
        res.resume();
        finish({ ok: true, status: res.statusCode });
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, error: 'timeout' }); });
      req.on('error', (e) => finish({ ok: false, error: (e && e.message) || String(e) }));
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

/* ------------------------------- TLS ------------------------------- */

function tlsPosture() {
  const conf = sudoRun('cat', [NGINX_CONF]);
  const cert = sudoRun('openssl', ['x509', '-in', NGINX_CERT, '-noout', '-subject', '-dates', '-fingerprint', '-sha256']);
  const out = {
    role: 'nginx（TLS 终结在反代，node 只监听 127.0.0.1:8081 明文）',
    enabled: false,
    ports: [],
    httpPorts: [],
    cert: null,
    protocols: [],
    configFile: NGINX_CONF,
    note: '',
  };
  if (conf.ok) {
    for (const line of conf.out.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('listen ')) continue;
      const m = /^listen\s+([^\s;]+)(\s+ssl)?/.exec(t);
      if (!m) continue;
      const port = m[1];
      if (m[2]) { if (!out.ports.includes(port)) out.ports.push(port); }
      else if (!out.httpPorts.includes(port)) out.httpPorts.push(port);
    }
    const proto = /ssl_protocols\s+([^;]+);/.exec(conf.out);
    if (proto) out.protocols = proto[1].trim().split(/\s+/);
    out.enabled = out.ports.length > 0;
  } else {
    out.note = '读取 nginx 配置失败（需要 sudo -n cat 权限）：' + (conf.error || '');
  }
  if (cert.ok) {
    const subject = /subject\s*=\s*(.+)/.exec(cert.out);
    const notBefore = /notBefore\s*=\s*(.+)/.exec(cert.out);
    const notAfter = /notAfter\s*=\s*(.+)/.exec(cert.out);
    const fp = /Fingerprint=([0-9A-Fa-f:]+)/.exec(cert.out);
    let daysLeft = null;
    if (notAfter) {
      const t = Date.parse(notAfter[1]);
      if (Number.isFinite(t)) daysLeft = Math.ceil((t - Date.now()) / 86400000);
    }
    out.cert = {
      path: NGINX_CERT,
      subject: subject ? subject[1].trim() : '',
      notBefore: notBefore ? notBefore[1].trim() : '',
      notAfter: notAfter ? notAfter[1].trim() : '',
      fingerprintSha256: fp ? fp[1] : '',
      daysLeft,
      selfSigned: true,
    };
  } else {
    out.cert = { path: NGINX_CERT, error: cert.error || '读取失败' };
  }
  out.toggleable = false;
  out.toggleReason = '开关 HTTPS 需要改 nginx 主配置（本模块按团队纪律不改主线配置）；'
    + '页面只展示状态与变更路径。需要关闭：注释 nginx 中 `listen 8443 ssl` 后 nginx -t && systemctl reload nginx。';
  return out;
}

/* ------------------------------- SMB ------------------------------- */

function smbPosture() {
  const out = {
    service: false,
    signing: 'unknown',
    signingRequired: false,
    encryption: 'unknown',
    minProtocol: '',
    configFile: '/etc/samba/smb.conf',
    toggleable: false,
    note: 'SMB 配置由 smb-sec 团队负责（README-TEAM §5）；本模块只读展示。',
  };
  const active = run('systemctl', ['is-active', 'smbd']);
  out.service = active.ok && /^active/.test(active.out);
  const tp = run('testparm', ['-s']);
  if (tp.ok) {
    const lines = tp.out.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (/^server signing\s*=/.test(line)) {
        out.signing = line.split('=')[1].trim();
      } else if (/^smb encrypt\s*=/.test(line)) {
        out.encryption = line.split('=')[1].trim();
      } else if (/^(server )?min protocol\s*=/.test(line)) {
        out.minProtocol = line.split('=')[1].trim();
      }
    }
    out.signingRequired = out.signing === 'mandatory' || out.signing === 'required';
    if (out.encryption === 'unknown') out.encryption = 'off（未配置 smb encrypt，局域网明文）';
  } else {
    out.note = 'testparm 不可用：' + (tp.error || '');
  }
  out.signingLabel = out.signing === 'if_required' ? 'if_required（可降级，未强制）'
    : out.signing === 'mandatory' ? 'mandatory（强制）' : out.signing;
  out.changePath = '强制签名：smb.conf [global] server signing = mandatory → testparm -s && systemctl reload smbd';
  return out;
}

/* -------------------------------- S3 -------------------------------- */

function s3Posture(app) {
  const out = {
    enabled: false,
    signature: 'unknown',
    authModes: [],
    buckets: [],
    accessKeyIdMasked: '',
    unsignedProbe: null,
    toggleable: false,
    note: '签名强制实现在 lib/s3.js（SigV4），属既有安全默认；本模块不改它，只验证。',
  };
  const file = path.join(store.dataDir(app), 's3.json');
  const cfg = store.loadJSON(file, null);
  if (cfg && typeof cfg === 'object') {
    out.enabled = true;
    out.buckets = Object.keys(cfg.buckets || {});
    const ak = String(cfg.accessKeyId || '');
    out.accessKeyIdMasked = ak ? ak.slice(0, 4) + '****' + ak.slice(-2) : '';
  }
  out.authModes = ['AWS SigV4（Authorization 头）', 'Presigned 查询串（X-Amz-*）'];
  return out;
}

async function s3ProbeAsync(app) {
  const r = await probe('http://127.0.0.1:8081/s3/nas-public/', 2500);
  return r.ok
    ? { unsignedStatus: r.status, expectDenied: r.status === 403, note: r.status === 403 ? '未签名请求被拒绝（403）' : '未签名请求返回 ' + r.status }
    : { unsignedStatus: null, expectDenied: false, note: '探测失败：' + (r.error || '') };
}

/* ----------------------------- 存储加密 ----------------------------- */

function storagePosture() {
  const out = {
    encryptedAtRest: false,
    rootSource: '',
    rootFs: '',
    luksDevices: [],
    mounts: [],
    note: '',
    toggleable: false,
    toggleReason: '磁盘加密需要在安装期做 LUKS 全盘加密，或新建加密卷后迁移数据；'
      + '在线给已用 17GB 的根盘加 LUKS 需要重装/离线迁移，属高风险运维，本模块不做。',
  };
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
    for (const line of mounts) {
      const p = line.split(/\s+/);
      if (p[0] && /^\/dev\/(mapper\/)?/.test(p[0])) {
        if (p[1] === '/' || p[1] === '/opt' || p[1] === '/home') out.mounts.push({ source: p[0], mount: p[1], fs: p[2] });
      }
    }
    const rootLine = out.mounts.find((m) => m.mount === '/') || out.mounts[0];
    if (rootLine) { out.rootSource = rootLine.source; out.rootFs = rootLine.fs; }
    out.encryptedAtRest = /dm-crypt|crypt/i.test(out.rootSource) || /crypto/i.test(out.rootFs);
  } catch { /* 读不到 */ }
  const lsblk = run('lsblk', ['-o', 'NAME,FSTYPE']);
  if (lsblk.ok) {
    out.luksDevices = lsblk.out.split('\n').filter((l) => /crypto_LUKS|dm-crypt/.test(l)).map((l) => l.trim());
    out.encryptedAtRest = out.encryptedAtRest || out.luksDevices.length > 0;
  }
  out.note = out.encryptedAtRest
    ? '检测到块设备加密'
    : '根盘（LVM 逻辑卷）未做 LUKS 加密；文件系统为 ext4，数据在磁盘上以明文存储。'
      + '缓解措施：口令落盘用 scrypt 哈希、会话/密钥文件 0600、审计日志 0600、备份走快照。';
  return out;
}

/* ------------------------------ 其他门禁 ------------------------------ */

function edgePosture() {
  const out = {};
  const f2b = run('systemctl', ['is-active', 'fail2ban']);
  out.fail2ban = { active: f2b.ok && /^active/.test(f2b.out), jails: [] };
  const st = sudoRun('fail2ban-client', ['status']);
  if (st.ok) {
    const m = /Jail list:\s*(.+)/.exec(st.out);
    out.fail2ban.jails = m ? m[1].split(/[,\s]+/).filter(Boolean) : [];
  }
  const ssh = run('systemctl', ['is-active', 'ssh']);
  out.ssh = { active: ssh.ok && /^active/.test(ssh.out), note: '本模块不触碰 SSH（团队纪律：不许关 SSH）' };
  out.loginRate = {
    maxFails: 10,
    windowSec: 300,
    lockSec: 300,
    note: '登录限速实现在 server.js loginRateCheck（10 次/5 分钟锁 5 分钟）；本模块只读展示，不修改。',
  };
  return out;
}

/* -------------------------------- 汇总 -------------------------------- */

async function posture(app, req) {
  const now = Date.now();
  if (cache.value && now - cache.at < CACHE_MS) {
    return { ...cache.value, cached: true, ttlMs: CACHE_MS - (now - cache.at) };
  }
  const cfg = ipMod.loadConfig(app);
  const tls = tlsPosture();
  const [npm, httpsProbe] = await Promise.all([
    Promise.resolve(null),
    probe('https://127.0.0.1:8443/api/r15/health').catch((e) => ({ ok: false, error: String(e) })),
  ]);
  const s3 = s3Posture(app);
  s3.unsignedProbe = await s3ProbeAsync(app);
  const value = {
    at: new Date().toISOString(),
    tls: {
      ...tls,
      probe: httpsProbe.ok
        ? { url: 'https://127.0.0.1:8443/api/r15/health', status: httpsProbe.status, ok: httpsProbe.status === 200 }
        : { url: 'https://127.0.0.1:8443/api/r15/health', ok: false, error: httpsProbe.error },
    },
    plainHttp: {
      ports: tls.httpPorts,
      enabled: tls.httpPorts.includes('80'),
      note: '主入口仍是 http://192.168.99.1/（nginx 80，明文）；HTTPS 在 8443。',
    },
    smb: smbPosture(),
    s3,
    storage: storagePosture(),
    edge: edgePosture(),
    toggles: {
      forceHttps: cfg.forceHttps === true,
      ipWhitelist: cfg.enabled === true,
      note: '本模块可实时开关：强制 HTTPS（应用层）、IP 白名单。其余项属 nginx/Samba/磁盘层，'
        + '按团队纪律只展示状态与变更命令。',
    },
    client: {
      ip: store.clientIp(req),
      https: store.isHttps(req),
    },
    unused: npm,
  };
  delete value.unused;
  cache = { at: now, value };
  return value;
}

function invalidate() { cache = { at: 0, value: null }; }

module.exports = { posture, invalidate, tlsPosture, smbPosture, s3Posture, storagePosture, edgePosture, probe };

'use strict';

/**
 * 零依赖 TLS 证书工具：用 Node 内置 crypto 直接构建 DER/X.509 自签名证书。
 * 不依赖 openssl 二进制（Termux 默认不带），首次启动自动生成 10 年期证书，
 * 局域网 IP 变化时自动重建（SAN 覆盖当前所有网卡地址）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------------- DER 基础编码 ---------------- */

function derLenBytes(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  bytes.unshift(0x80 | bytes.length);
  return Buffer.from(bytes);
}

/** TLV：tag + length + content */
function tlv(tag, ...parts) {
  const content = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([Buffer.from([tag]), derLenBytes(content.length), content]);
}

/** INTEGER（正数，输入为原始大端字节） */
function derInt(buf) {
  let b = Buffer.from(buf);
  if (!b.length) b = Buffer.from([0]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]); // 保证正数
  return tlv(0x02, b);
}

/** OID，如 '2.5.29.17' */
function derOID(s) {
  const parts = s.split('.').map(Number);
  const body = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const seg = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { seg.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    body.push(...seg);
  }
  return tlv(0x06, Buffer.from(body));
}

const utf8Str = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const nullVal = () => Buffer.from([0x05, 0x00]);

function fmtX509Time(d, yearDigits) {
  const p = (n) => String(n).padStart(2, '0');
  // UTCTime 只允许 2 位年份（00-49 → 2000-2049）；GeneralizedTime 用 4 位
  const y = yearDigits === 2
    ? String(d.getUTCFullYear()).slice(-2)
    : String(d.getUTCFullYear());
  return `${y}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
const utctime = (d) => tlv(0x17, Buffer.from(fmtX509Time(d, 2)));
const gentime = (d) => tlv(0x18, Buffer.from(fmtX509Time(d, 4)));

/** BIT STRING（data + 前导未用位数） */
const bitstring = (data, unusedBits) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), data]));

/** [n] EXPLICIT 包装（constructed context tag） */
const ctxExplicit = (n, inner) => tlv(0xa0 + n, inner);

/** Name (X.501 RDN)：仅 CN */
function nameCN(cn) {
  const cnSeq = tlv(0x30, derOID('2.5.4.3'), utf8Str(cn));
  return tlv(0x30, tlv(0x31, cnSeq));
}

function pem(der, label) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/* ---------------- 证书扩展 ---------------- */

/** subjectAltName 2.5.29.17：DNS [2] + IPv4 [7] */
function sanExtension(dns, ips) {
  const names = [];
  for (const d of dns) {
    if (typeof d === 'string' && d.length) names.push(tlv(0x82, Buffer.from(d, 'ascii')));
  }
  for (const ip of ips) {
    const oct = String(ip).split('.').map(Number);
    if (oct.length === 4 && oct.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      names.push(tlv(0x87, Buffer.from(oct)));
    }
  }
  const value = tlv(0x30, ...names);
  return tlv(0x30, derOID('2.5.29.17'), tlv(0x04, value));
}

/** basicConstraints 2.5.29.19：CA:TRUE（便于导入系统信任区） */
function basicConstraintsExtension() {
  const value = tlv(0x30, tlv(0x01, Buffer.from([0xff]))); // SEQ { BOOLEAN TRUE }
  return tlv(0x30, derOID('2.5.29.19'), tlv(0x04, value));
}

/** keyUsage 2.5.29.15：digitalSignature + keyEncipherment（critical） */
function keyUsageExtension() {
  // bit0 digitalSignature=1, bit2 keyEncipherment=1 → 0b10100000 = 0xA0，未用 5 位
  const kuValue = tlv(0x30, bitstring(Buffer.from([0xa0]), 5));
  return tlv(0x30, derOID('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, kuValue));
}

/* ---------------- 证书构建 ---------------- */

function buildCertificate(privateKey, spkiDer, { ips, dns, cname, days }) {
  const sigAlg = tlv(0x30, derOID('1.2.840.113549.1.1.11'), nullVal()); // sha256WithRSAEncryption

  const notBefore = new Date(Date.now() - 5 * 60 * 1000); // 容忍 5 分钟时钟偏差
  const notAfter = new Date(notBefore.getTime() + days * 86400 * 1000);

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;

  const name = nameCN(cname);
  const extensions = tlv(0x30, basicConstraintsExtension(), keyUsageExtension(), sanExtension(dns, ips));

  const tbs = tlv(0x30,
    ctxExplicit(0, derInt(Buffer.from([0x02]))), // version v3
    derInt(serial),
    sigAlg,
    name,                                      // issuer
    tlv(0x30, utctime(notBefore), gentime(notAfter)), // validity
    name,                                      // subject（自签名：相同）
    spkiDer,                                   // SubjectPublicKeyInfo（node 导出完整 DER）
    ctxExplicit(3, extensions),                // [3] extensions
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  return tlv(0x30, tbs, sigAlg, bitstring(signature, 0));
}

/**
 * 确保证书可用：存在且未过期且 SAN 覆盖当前 IP → 复用；否则重新生成。
 * @param {string} dir 证书目录（建议放在 data/ 下，随数据一起备份）
 * @param {{ips?:string[], dns?:string[], cname?:string, days?:number}} opts
 * @returns {{key:string, cert:string, regenerated:boolean}}
 */
function ensureCertificates(dir, opts = {}) {
  const {
    ips = [],
    dns = ['localhost'],
    cname = 'LAN FileServer',
    days = 3650,
  } = opts;

  /* R9-TLS-1：私钥必须只有属主可读。
     旧实现直接 writeFileSync(keyFile, key) —— 默认 0644，同组/其它用户
     都能读到私钥，等于把 HTTPS 身份的钥匙挂在门口。目录也一并收紧到 0700。 */
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 已存在 */ }
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows 上语义有限 */ }

  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  const metaFile = path.join(dir, 'meta.json');

  const want = {
    ips: [...new Set(ips.filter(Boolean))].sort(),
    dns: [...new Set(dns.filter(Boolean))].sort(),
  };

  // 尝试复用现有证书
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const key = fs.readFileSync(keyFile, 'utf8');
    const cert = fs.readFileSync(certFile, 'utf8');
    const covered = want.ips.every((ip) => (meta.ips || []).includes(ip));
    if (covered && meta.expiresAt > Date.now() + 30 * 86400 * 1000) {
      /* 复用的老私钥也可能是 0644 落盘的 —— 顺手收紧权限 */
      try { fs.chmodSync(keyFile, 0o600); } catch { /* Windows 上语义有限 */ }
      return { key, cert, regenerated: false };
    }
  } catch { /* 任一文件缺失/损坏 → 重新生成 */ }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const certDer = buildCertificate(privateKey, spkiDer, { ips: want.ips, dns: want.dns, cname, days });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const cert = pem(certDer, 'CERTIFICATE');

  // 自校验（防止 DER 拼装错误导致证书无效）
  const x = new crypto.X509Certificate(cert);
  if (!x.verify(publicKey)) throw new Error('生成的证书自校验失败');

  fs.writeFileSync(certFile, cert, { mode: 0o644 });
  /* 私钥：0600，并显式 chmod（writeFileSync 的 mode 会被 umask 影响） */
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  try { fs.chmodSync(keyFile, 0o600); } catch { /* Windows 上语义有限 */ }
  fs.writeFileSync(metaFile, JSON.stringify({
    ips: want.ips, dns: want.dns,
    createdAt: Date.now(), expiresAt: Date.now() + days * 86400 * 1000,
  }, null, 2), { mode: 0o644 });

  return { key, cert, regenerated: true };
}

module.exports = { ensureCertificates };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let fail = 0;
  let pass = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`✓  ${name}`); }
    else { fail++; console.log(`✗  ${name}${extra ? '  →  ' + extra : ''}`); }
  };
  const posix = process.platform !== 'win32';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlstest-'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } };
  const dir = path.join(tmp, 'certs');

  try {
    const r = ensureCertificates(dir, { ips: ['127.0.0.1', '192.168.1.10'], dns: ['localhost', 'nas.local'] });
    check('证书已生成', !!r.key && !!r.cert && r.regenerated === true);

    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    check('私钥文件已落盘', fs.existsSync(keyFile));
    check('证书文件已落盘', fs.existsSync(certFile));

    const x = new crypto.X509Certificate(r.cert);
    check('证书可被 X509 解析', !!x.subject);
    check('SAN 含 IPv4', String(x.subjectAltName || '').includes('127.0.0.1'), String(x.subjectAltName || ''));
    check('SAN 含 DNS', String(x.subjectAltName || '').includes('nas.local'), String(x.subjectAltName || ''));

    if (posix) {
      const km = fs.statSync(keyFile).mode & 0o777;
      check('私钥权限 0600', km === 0o600, '0' + km.toString(8));
      const dm = fs.statSync(dir).mode & 0o777;
      check('证书目录权限 0700', dm === 0o700, '0' + dm.toString(8));
      const cm = fs.statSync(certFile).mode & 0o777;
      check('公钥证书权限 0644（可读）', cm === 0o644, '0' + cm.toString(8));
    } else {
      console.log('·  （Windows 不支持 POSIX 权限位，跳过 mode 断言）');
    }

    /* 复用路径：老私钥权限被放宽后要自动收紧 */
    if (posix) {
      try { fs.chmodSync(keyFile, 0o644); } catch { /* 忽略 */ }
    }
    const r2 = ensureCertificates(dir, { ips: ['127.0.0.1', '192.168.1.10'], dns: ['localhost', 'nas.local'] });
    check('复用现有证书（未重新生成）', r2.regenerated === false && r2.key === r.key);
    if (posix) {
      const km2 = fs.statSync(keyFile).mode & 0o777;
      check('复用时私钥权限被收紧回 0600', km2 === 0o600, '0' + km2.toString(8));
    }

    /* IP 变化 → 重新生成 */
    const r3 = ensureCertificates(dir, { ips: ['127.0.0.1', '192.168.1.11'], dns: ['localhost', 'nas.local'] });
    check('IP 变化时重建证书', r3.regenerated === true);

    cleanup();
    console.log(`\n断言 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
    if (fail) { console.log('自测未通过'); process.exit(1); }
    console.log('自测全部通过');
    process.exit(0);
  } catch (e) {
    console.error('✗  自测异常:', e);
    try { cleanup(); } catch { /* 忽略 */ }
    process.exit(1);
  }
}

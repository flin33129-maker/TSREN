'use strict';

/* =====================================================================
 * lib/mdns.js — 零依赖 mDNS / DNS-SD 服务发现（零配置）
 * ---------------------------------------------------------------------
 * 设计取舍（重要）：
 *   1. 端口：5353 > 1024，Termux 无 root 可正常 bind，不像 SSDP 1900 受限。
 *   2. QU 应答：mDNS 允许「单播应答」（查询 QCLASS 最高位为 1 表示期望单播
 *      回包）。本实现识别该位——置位时单播回查询源，否则走 224.0.0.251 组播。
 *   3. 名字压缩：手写报文编解码**不做名字压缩**（每条记录里的名字都展开写）。
 *      不压缩在 DNS/mDNS 中完全合法，且实现简单、不易出错；代价是报文略大。
 *   4. 服务声明（诚实边界）：
 *        - _http / _webdav 是真实可用的（主服务 8081、WebDAV /dav/）。
 *        - _sftp-ssh(8022) / _nfs(2049) / _ftp(2121) 仅做「发现广告」，本机
 *          不一定运行对应守护进程；用于在网络里暴露 NAS 能力位。
 *        - _adisk._tcp 是 Time Machine 广告位（TXT: sys=waMa=0, adVF=0x100），
 *          但真实 TM 备份依赖 SMB 桥（在 PC 侧）且其不支持 fruit 扩展属性，
 *          故**仅做发现、不保证可实际备份**。这是诚实的能力边界。
 *
 * 安全基线（本次加固）
 * ---------------------------------------------------------------------
 *  名字压缩指针原本**没有跳转上限**：恶意报文放一个自指的压缩指针
 *  （偏移指向自己），解析就会永远转圈 —— mDNS 是 UDP 广播口，
 *  **一个包就能把整个事件循环卡死**（NAS 全站假死，不止 mDNS）。
 *  现在：跳转次数、label 数量、名字总长、label 长度、指针越界全部有上限，
 *  解析器保证"要么解出名字、要么安全放弃"，绝不挂住。
 * ===================================================================== */

const dgram = require('dgram');
const os = require('os');

const MDNS_PORT = 5353;
const MDNS_GROUP = '224.0.0.251';
const TTL = 4500; // 资源记录 TTL（秒）

/* --- 名字解析的安全上限（防压缩指针死循环 / 超长名字） --- */
const MDNS_MAX_PTR_JUMPS = 16;   // 压缩指针最多跳 16 次
const MDNS_MAX_LABELS = 128;     // 一个名字最多 128 个 label
const MDNS_MAX_NAME = 255;       // 名字总长最多 255 字节

/* ----------------------------- 服务声明表 ----------------------------- */
// 服务实例名统一为 <hostname>（如 nas-k50）。
// 这些服务类型与端口：
const SERVICES = [
  { type: '_http._tcp.local', port: 8081, txt: ['path=/'] },
  { type: '_webdav._tcp.local', port: 8081, txt: ['path=/dav/'] },
  { type: '_sftp-ssh._tcp.local', port: 8022, txt: [] }, // 仅发现广告，守护进程可能未运行
  { type: '_nfs._tcp.local', port: 2049, txt: [] },      // 仅发现广告
  { type: '_ftp._tcp.local', port: 2121, txt: [] },      // 仅发现广告
  // Time Machine 广告位（诚实边界见文件头注释）
  { type: '_adisk._tcp.local', port: 8081, txt: ['sys=waMa=0', 'adVF=0x100'] },
];

/* ----------------------------- 报文编解码 ----------------------------- */

/** 把域名编码为 labels（不压缩：每个名字都完整展开） */
function encodeName(name) {
  const labels = String(name).split('.').filter((l) => l.length > 0);
  const parts = [];
  for (const label of labels) {
    const b = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0])); // 终止符
  return Buffer.concat(parts);
}

/**
 * 从 buf 的 offset 处解析域名（兼容压缩指针，但本实现不主动压缩）
 *
 * ⚠️ 安全要点：压缩指针必须**限制跳转次数**。
 *   压缩指针的偏移可以指向报文里的任意位置，**包括它自己**。
 *   一个自指指针（offset=12 处的指针指向 12）在没有上限时会让本函数
 *   永远转圈 —— mDNS 是局域网广播口，一个 UDP 包就能卡死整个事件循环
 *   （NAS 全站假死，不止 mDNS 服务）。截断的指针（末字节是 0xc0）同样
 *   会让偏移算成 NaN，落进同一个死循环。
 *   因此这里对跳转次数、label 数量、名字总长、label 长度、指针越界
 *   全部设上限，宁可解不出名字也不挂住。
 */
function decodeName(buf, offset) {
  const labels = [];
  let i = offset;
  let ptrEnd = -1;   // 遇到压缩指针后，原始流里指针之后的位置
  let jumped = false;
  let jumps = 0;
  let total = 0;     // 名字占用的字节数
  for (;;) {
    if (!(i >= 0 && i < buf.length)) break;   // 越界/NaN 都安全退出
    if (jumps > MDNS_MAX_PTR_JUMPS) break;     // 指针跳转次数上限（防自指死循环）
    const len = buf[i];
    if (len === 0) {
      i += 1;
      if (!jumped) ptrEnd = i;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      // 压缩指针：高 2 位 11，后 14 位为偏移
      if (i + 1 >= buf.length) break;          // 指针被截断（末尾只有 1 个字节）
      const ptr = ((len & 0x3f) << 8) | buf[i + 1];
      if (!jumped) ptrEnd = i + 2;
      jumped = true;
      jumps++;
      if (ptr >= buf.length) break;            // 指针指向报文之外
      i = ptr;
      continue;
    }
    if (len > 63) break;                       // label 长度非法（0x40-0xbf 为保留值）
    if (i + 1 + len > buf.length) break;       // label 被截断
    const label = buf.slice(i + 1, i + 1 + len).toString('utf8');
    labels.push(label);
    total += len + 1;
    if (labels.length > MDNS_MAX_LABELS || total > MDNS_MAX_NAME) break;
    i += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), next: ptrEnd < 0 ? i : ptrEnd };
}

/** 资源记录：A（IPv4 地址）。flush=true 时设 cache-flush 位。 */
function rrA(name, ip, flush) {
  const nameBuf = encodeName(name);
  const meta = Buffer.alloc(8);
  meta.writeUInt16BE(1, 0);                       // TYPE = A
  meta.writeUInt16BE((flush ? 0x8000 : 0) | 1, 2); // CLASS = IN (+cache-flush)
  meta.writeUInt32BE(TTL, 4);
  const rd = Buffer.from(ip.split('.').map((x) => Number(x) & 0xff));
  const rdlen = Buffer.alloc(2); rdlen.writeUInt16BE(rd.length, 0);
  return Buffer.concat([nameBuf, meta, rdlen, rd]);
}

/** 资源记录：PTR（指向另一个域名） */
function rrPtr(name, target, flush) {
  const nameBuf = encodeName(name);
  const rdata = encodeName(target);
  const meta = Buffer.alloc(8);
  meta.writeUInt16BE(12, 0);                      // TYPE = PTR
  meta.writeUInt16BE((flush ? 0x8000 : 0) | 1, 2);
  meta.writeUInt32BE(TTL, 4);
  const rdlen = Buffer.alloc(2); rdlen.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([nameBuf, meta, rdlen, rdata]);
}

/** 资源记录：TXT（多个字符串，每个 <len><bytes>） */
function rrTxt(name, pairs, flush) {
  const nameBuf = encodeName(name);
  const parts = [];
  if (!pairs.length) {
    parts.push(Buffer.from([0])); // 空 TXT = 单个零长度串
  } else {
    for (const p of pairs) {
      const b = Buffer.from(p, 'utf8');
      parts.push(Buffer.from([b.length]), b);
    }
  }
  const rdata = Buffer.concat(parts);
  const meta = Buffer.alloc(8);
  meta.writeUInt16BE(16, 0);                      // TYPE = TXT
  meta.writeUInt16BE((flush ? 0x8000 : 0) | 1, 2);
  meta.writeUInt32BE(TTL, 4);
  const rdlen = Buffer.alloc(2); rdlen.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([nameBuf, meta, rdlen, rdata]);
}

/** 资源记录：SRV（priority/weight/port + target 名） */
function rrSrv(name, priority, weight, port, target, flush) {
  const targetBuf = encodeName(target);
  const rdata = Buffer.alloc(6 + targetBuf.length);
  rdata.writeUInt16BE(priority, 0);
  rdata.writeUInt16BE(weight, 2);
  rdata.writeUInt16BE(port, 4);
  targetBuf.copy(rdata, 6);
  const nameBuf = encodeName(name);
  const meta = Buffer.alloc(8);
  meta.writeUInt16BE(33, 0);                      // TYPE = SRV
  meta.writeUInt16BE((flush ? 0x8000 : 0) | 1, 2);
  meta.writeUInt32BE(TTL, 4);
  const rdlen = Buffer.alloc(2); rdlen.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([nameBuf, meta, rdlen, rdata]);
}

/** 组装响应报文（QR=1, AA=1）。id 为查询的事务 ID（announce 时为 0） */
function buildResponse(id, answers, additionals) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0x8400, 2);   // QR=1, OPCODE=0, AA=1, RD=0, RA=0, RCODE=0
  header.writeUInt16BE(0, 4);        // QDCOUNT = 0（应答不重复问题）
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);        // NSCOUNT = 0
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([header].concat(answers, additionals));
}

/* ------------------------------ 类 ------------------------------ */
class MdnsResponder {
  /**
   * @param {object} srv FileServer 实例（仅用于取 cfg 信息；本模块主要依赖 os）
   */
  constructor(srv) {
    this.srv = srv;
    this.hostname = 'nas-k50';
    this.sock = null;
    this.running = false;
  }

  /** 本机非 internal IPv4 列表（多条 A 记录） */
  _ips() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const net of ifaces[name] || []) {
        if (net.family === 'IPv4' && !net.internal) out.push(net.address);
      }
    }
    return out.length ? out : ['127.0.0.1'];
  }
  get hostFqdn() { return this.hostname + '.local'; }
  _instance(svcType) { return this.hostname + '.' + svcType; }

  /* ============================ 启动 / 停止 ============================ */

  start(opts = {}) {
    if (this.running) return;
    this.hostname = opts.hostname || 'nas-k50';
    this.running = true;

    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', (e) => { /* 端口冲突等：静默，尝试继续 */ if (e && e.code !== 'EACCES') {/* noop */} });

    this.sock.on('message', (msg, rinfo) => this._onQuery(msg, rinfo));

    this.sock.bind(MDNS_PORT, () => {
      try { this.sock.addMembership(MDNS_GROUP); } catch { /* ignore */ }
      try { this.sock.setMulticastTTL(255); } catch { /* ignore */ }
      try { this.sock.setMulticastLoopback(false); } catch { /* ignore */ }
      // 启动即主动发一轮组播 announce（目的 224.0.0.251:5353）
      this._announce();
      // 标准做法：再补一轮（1s 后），提升被缓存的概率
      setTimeout(() => { if (this.running) this._announce(); }, 1000);
    });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.sock) {
      try {
        // 礼貌下线：发一轮 goodbye（TTL=0 的 announce）
        this._announce(true);
      } catch { /* ignore */ }
      try { this.sock.close(); } catch { /* ignore */ }
      this.sock = null;
    }
  }

  /* ============================ Announce ============================ */

  /** 主动组播宣告本机所有服务（goodbye=true 时 TTL=0） */
  _announce(goodbye) {
    if (!this.sock) return;
    const ips = this._ips();
    const answers = [];
    // 服务类型枚举（_services._dns-sd._udp.local PTR → 各服务类型）
    for (const s of SERVICES) {
      answers.push(rrPtr('_services._dns-sd._udp.local', s.type, false));
    }
    // 每个服务：PTR(type→instance) + SRV + TXT（SRV/TXT 设 cache-flush）
    for (const s of SERVICES) {
      const inst = this._instance(s.type);
      answers.push(rrPtr(s.type, inst, false));                       // PTR 不刷缓存（共享记录）
      answers.push(rrSrv(inst, 0, 0, s.port, this.hostFqdn, true));   // cache-flush
      answers.push(rrTxt(inst, s.txt, true));                        // cache-flush
    }
    // 主机 A 记录（cache-flush），每条 IP 一条
    for (const ip of ips) answers.push(rrA(this.hostFqdn, ip, true));

    const buf = buildResponse(0, answers, []);
    // 全局 TTL 覆盖：goodbye 时所有记录 TTL=0
    if (goodbye) setTtlZero(buf);
    try {
      this.sock.send(buf, 0, buf.length, MDNS_PORT, MDNS_GROUP, () => {});
    } catch { /* ignore */ }
  }

  /* ============================ 查询响应 ============================ */

  _onQuery(msg, rinfo) {
    let parsed;
    try { parsed = parseMessage(msg); } catch { return; }
    if (!parsed.questions.length) return;

    const ips = this._ips();
    const answers = [];
    const additionals = [];
    let responded = false;
    let qu = false; // 任意问题带 QU 位则单播应答（mDNS 允许多问题，取并集）

    for (const q of parsed.questions) {
      const ip = q.name.toLowerCase();
      if ((q.qclass & 0x8000) !== 0) qu = true; // 期望单播应答

      // 1) 服务枚举查询：_services._dns-sd._udp.local
      if (ip === '_services._dns-sd._udp.local' && (q.qtype === 12 || q.qtype === 255)) {
        for (const s of SERVICES) answers.push(rrPtr('_services._dns-sd._udp.local', s.type, false));
        responded = true;
        continue;
      }
      // 2) 主机 A 查询：<hostname>.local
      if (ip === this.hostFqdn && (q.qtype === 1 || q.qtype === 255 || q.qtype === 28)) {
        if (q.qtype !== 28) { // AAAA 不提供
          for (const a of ips) answers.push(rrA(this.hostFqdn, a, true));
        }
        responded = true;
        continue;
      }
      // 3) 服务类型 PTR 查询：_http._tcp.local 等 → 返回实例 PTR + SRV + TXT + A
      const svc = SERVICES.find((s) => s.type === ip);
      if (svc && (q.qtype === 12 || q.qtype === 255)) {
        const inst = this._instance(svc.type);
        answers.push(rrPtr(svc.type, inst, false));
        additionals.push(rrSrv(inst, 0, 0, svc.port, this.hostFqdn, true));
        additionals.push(rrTxt(inst, svc.txt, true));
        for (const a of ips) additionals.push(rrA(this.hostFqdn, a, true));
        responded = true;
        continue;
      }
      // 4) 服务实例查询：nas-k50._http._tcp.local 等（SRV / TXT / ANY）
      const svc2 = SERVICES.find((s) => this._instance(s.type) === ip);
      if (svc2 && (q.qtype === 33 || q.qtype === 16 || q.qtype === 255)) {
        const inst = this._instance(svc2.type);
        if (q.qtype === 33 || q.qtype === 255) additionals.push(rrSrv(inst, 0, 0, svc2.port, this.hostFqdn, true));
        if (q.qtype === 16 || q.qtype === 255) additionals.push(rrTxt(inst, svc2.txt, true));
        for (const a of ips) additionals.push(rrA(this.hostFqdn, a, true));
        responded = true;
        continue;
      }
      // 5) 其它：静默忽略（不响应）
    }

    if (!responded || (!answers.length && !additionals.length)) return;

    const buf = buildResponse(parsed.id, answers, additionals);
    try {
      if (qu) {
        // QU：单播回查询源
        this.sock.send(buf, 0, buf.length, rinfo.port, rinfo.address, () => {});
      } else {
        // 否则组播
        this.sock.send(buf, 0, buf.length, MDNS_PORT, MDNS_GROUP, () => {});
      }
    } catch { /* ignore */ }
  }
}

/* ----------------------------- 报文解析 ----------------------------- */
function parseMessage(buf) {
  if (buf.length < 12) return { id: 0, questions: [] };
  const id = buf.readUInt16BE(0);
  /* qdcount 是攻击者可控的（最大 65535）。每个问题至少要占 5 字节，
     报文本身又不超过 UDP 的 64KB，所以真正的上限是报文长度；
     这里再取个更小的上限，并保证每轮解析**必须推进**（否则死循环）。 */
  const qdcount = Math.min(buf.readUInt16BE(4), 256);
  let off = 12;
  const questions = [];
  for (let q = 0; q < qdcount; q++) {
    const { name, next } = decodeName(buf, off);
    if (next + 4 > buf.length) break;
    if (next <= off) break;        // 没有推进 → 放弃（防死循环）
    const qtype = buf.readUInt16BE(next);
    const qclass = buf.readUInt16BE(next + 2);
    questions.push({ name, qtype, qclass });
    off = next + 4;
  }
  return { id, questions };
}

/** 把报文中所有记录的 TTL 字段置 0（goodbye 报文） */
function setTtlZero(buf) {
  // 头部后逐个 RR：NAME(变长) + TYPE(2) + CLASS(2) + TTL(4) + RDLENGTH(2) + RDATA(变长)
  let off = 12;
  // 读取计数
  const an = buf.readUInt16BE(6);
  const ar = buf.readUInt16BE(10);
  const total = an + ar;
  for (let i = 0; i < total; i++) {
    const nameEnd = decodeName(buf, off).next;
    if (nameEnd + 10 > buf.length) break;   // 越界就停（不越界读）
    const rdlen = buf.readUInt16BE(nameEnd + 8); // RDLENGTH 位于 NAME 后 TYPE(2)+CLASS(2)+TTL(4)=8 字节
    buf.writeUInt32BE(0, nameEnd + 4);           // TTL 位于 NAME 后 4 字节
    off = nameEnd + 10 + rdlen;                  // 跳到下一个 RR（NAME+RDLENGTH(2) 之后的 RDATA 末尾）
  }
}

module.exports = { MdnsResponder, selftest };

/* =====================================================================
   自测：node lib/mdns.js 直接跑（也可 require 后调用 selftest()）
   ---------------------------------------------------------------------
   重点：压缩指针死循环（一个 UDP 包卡死整个事件循环）的回归防护。
   ===================================================================== */
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

  /* ① 自指压缩指针：offset 0x0000 指向自己 → 旧实现会无限循环 */
  {
    const buf = Buffer.alloc(16);
    buf[0] = 0xc0; buf[1] = 0x00;   // 指针 → offset 0（自己）
    const t0 = Date.now();
    let r = null;
    try { r = decodeName(buf, 0); } catch (e) { r = { name: 'EXC:' + e.message }; }
    const dt = Date.now() - t0;
    tbool('自指压缩指针不会挂死（' + dt + 'ms 内返回）', dt < 500);
    tbool('自指压缩指针返回空名字', r && r.name === '');
  }

  /* ② 两个指针互相指向（12 ↔ 14） */
  {
    const buf = Buffer.alloc(16);
    buf[0] = 0xc0; buf[1] = 0x0e;   // → 14
    buf[14] = 0xc0; buf[15] = 0x00; // → 0
    const t0 = Date.now();
    let okR = true;
    try { decodeName(buf, 0); } catch { okR = false; }
    tbool('互相指向的压缩指针不会挂死（' + (Date.now() - t0) + 'ms）', okR && Date.now() - t0 < 500);
  }

  /* ③ 截断的指针（末字节 0xc0，后面没有第二个字节） */
  {
    const buf = Buffer.from([0x03, 0x61, 0x62, 0x63, 0xc0]);
    let okR = true;
    try { decodeName(buf, 0); } catch { okR = false; }
    tbool('截断的压缩指针不抛异常', okR);
  }

  /* ④ 指针越界 */
  {
    const buf = Buffer.from([0xc0, 0xff]);
    let okR = true;
    try { decodeName(buf, 0); } catch { okR = false; }
    tbool('越界指针不抛异常', okR);
  }

  /* ⑤ 正常名字：encode → decode 往返一致 */
  {
    const name = 'nas-k50._http._tcp.local';
    const enc = encodeName(name);
    const dec = decodeName(enc, 0);
    t('名字编解码往返一致', dec.name, name);
    t('解码后 next 指向名字末尾', dec.next, enc.length);
  }

  /* ⑥ 正常查询报文能解析出正确的问题 */
  {
    const qname = Buffer.concat([encodeName('_http._tcp.local')]);
    const q = Buffer.alloc(12 + qname.length + 4);
    q.writeUInt16BE(0x1234, 0);
    q.writeUInt16BE(0x0000, 2);
    q.writeUInt16BE(1, 4);            // QDCOUNT = 1
    qname.copy(q, 12);
    q.writeUInt16BE(12, 12 + qname.length);   // QTYPE = PTR
    q.writeUInt16BE(1, 12 + qname.length + 2); // QCLASS = IN
    const parsed = parseMessage(q);
    t('解析出 1 个问题', parsed.questions.length, 1);
    t('问题名正确', parsed.questions[0] ? parsed.questions[0].name : '', '_http._tcp.local');
    t('问题类型正确', parsed.questions[0] ? parsed.questions[0].qtype : -1, 12);
  }

  /* ⑦ 恶意 qdcount（65535）+ 垃圾内容 → 解析必须快速返回且不越界 */
  {
    const q = Buffer.alloc(64);
    q.writeUInt16BE(0, 0);
    q.writeUInt16BE(0xffff, 4);   // QDCOUNT = 65535
    const t0 = Date.now();
    let okR = true;
    try { parseMessage(q); } catch { okR = false; }
    tbool('伪造 qdcount 不会挂死或越界（' + (Date.now() - t0) + 'ms）', okR && Date.now() - t0 < 500);
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

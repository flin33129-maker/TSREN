'use strict';

/* =====================================================================
 * lib/nfs.js — 纯 Node 零依赖 NFS v3 + MOUNT v3 服务器（局域网 NAS 专用）
 * ---------------------------------------------------------------------
 * 设计取舍（务必知悉）：
 *  1) 无 portmapper(111)。NFS 固定监听 TCP+UDP 2049（program 100003 v3），
 *     MOUNT 固定监听 TCP+UDP 42000（program 100005 v3）。客户端必须显式
 *     指定 mountport（如 `mount -o port=2049,mountport=42000`），这是已知
 *     取舍：Android Termux 无 root → 端口必须 >1024，而 111 是特权端口。
 *  2) AUTH 信任模型：统一接受 AUTH_NULL 与 AUTH_SYS，但不校验 uid/gid。
 *     局域网受信任环境，伪造身份不在此模块防御范围（等同 WebDAV 游客写）。
 *  3) 文件句柄格式（v4，满足 RFC1813 FHSIZE3=64 硬上限）：
 *     'N4'(2 字节 magic) + diskId(1) + md5(disk + '/' + rel)(16) = 共 19 字节。
 *     hash → (disk, rel) 的映射持久化在 data/.nfs-fhmap.json；首次出现即登记。
 *     解析未命中（如服务重启后客户端持旧句柄访问深路径）时按磁盘懒扫描重建。
 *     旧 'N3' 长句柄仍可解析（兼容重启前已挂载的客户端），但新签发一律 v4。
 *  4) 删除类操作（REMOVE/RMDIR/RENAME）直接落盘，不做回收站（与 WebDAV 不同）。
 *
 * 安全基线（本次加固）
 * ---------------------------------------------------------------------
 *  TCP 记录标记（RFC 5531）的分片长度原本**无上限**：
 *    攻击者只要发 4 个字节声明一个 2GB 的分片，服务端就会一直缓冲 ——
 *    而 NFS 是**未认证**的，任何人都能触发（内存耗尽型 DoS）；
 *    加上原来的 Buffer.concat 每收一块就整段重拷（O(n²)），越慢越吃 CPU。
 *  现在：
 *    ① 分片长度上限 1MB（实际 NFS 的 READ/WRITE 也就 1MB 以内），超限直接断开；
 *    ② 收包改为分块列表 + 预分配，不再反复整体拷贝；
 *    ③ 空闲超时 / 连接最长寿命 / 单连接累计字节上限（慢连接 slowloris 防护）；
 *    ④ 单个监听端口的并发连接数上限（连接洪泛防护）；
 *    ⑤ 每条 RPC 的 [RPCDBG] 调试日志改为**按环境变量开关**（原本每次调用都刷屏）。
 * ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const dgram = require('dgram');

/* ----------------------------- 常量 ----------------------------- */

const NFS_PROGRAM = 100003;
const MOUNT_PROGRAM = 100005;

/* --- TCP 传输层防护参数（见文件头"安全基线"） --- */
const NFS_MAX_RECORD = 1024 * 1024;        // 单个 RPC 记录上限 1MB
const NFS_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 空闲 10 分钟即断开（客户端会发 NULL ping 保活）
const NFS_CONN_MAX_AGE_MS = 12 * 3600 * 1000; // 单连接最长存活 12 小时
const NFS_MAX_CONN_BYTES = 8 * 1024 * 1024 * 1024; // 单连接累计读取上限 8GB
const NFS_MAX_CONNS = 128;                 // 单个监听端口的并发连接数上限

const AUTH_NULL = 0;
const AUTH_SYS = 1;

// NFS3 错误码（仅列出用到的）
const NFS3ERR_PERM = 1;
const NFS3ERR_NOENT = 2;
const NFS3ERR_IO = 5;
const NFS3ERR_ACCES = 13;
const NFS3ERR_EXIST = 17;
const NFS3ERR_NOTDIR = 20;
const NFS3ERR_ISDIR = 21;
const NFS3ERR_BADHANDLE = 10003;
const NFS3ERR_NOTSUPP = 10004;
const NFS3ERR_NOTEMPTY = 66;
const NFS3ERR_ROFS = 30;
const NFS3ERR_BADXDR = 10001;
const NFS3ERR_SERVERFAULT = 10006;

// 固定校验值（8 字节），NFS 规范用于让客户端识别写是否在同一次会话
const WRITEVERF = Buffer.from([0x4E, 0x46, 0x53, 0x33, 0x57, 0x52, 0x49, 0x54]); // "NFS3WRIT"
const COOKIEVERF = Buffer.alloc(8, 0); // READDIR cookie 校验固定为 0

/* ----------------------------- XDR 编解码 ----------------------------- */

/** 简单的 XDR 写入器：所有多字节字段大端、4 字节对齐零填充 */
class XdrWriter {
  constructor() { this.chunks = []; this.len = 0; }
  u32(v) {
    const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0);
    this.chunks.push(b); this.len += 4; return this;
  }
  i32(v) {
    const b = Buffer.alloc(4); b.writeInt32BE(v | 0, 0);
    this.chunks.push(b); this.len += 4; return this;
  }
  /** uint64：支持 Number（<2^53）或 [hi, lo] 数组，写入 hi.lo */
  u64(n) {
    let hi, lo;
    if (Array.isArray(n)) { hi = n[0] >>> 0; lo = n[1] >>> 0; }
    else { hi = Math.floor(n / 0x100000000) >>> 0; lo = (n >>> 0); }
    return this.u32(hi).u32(lo);
  }
  bool(v) { return this.u32(v ? 1 : 0); }
  enum(v) { return this.u32(v); }
  /** 带长度前缀的 opaque（string/buffer），自动补 0 对齐 */
  opaque(buf) {
    if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
    const len = buf.length;
    this.u32(len);
    this.chunks.push(buf); this.len += len;
    const pad = (4 - (len % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.len += pad; }
    return this;
  }
  /** 定长 opaque（无长度前缀），不足补 0，多余截断 */
  fixed(buf, size) {
    if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
    const b = Buffer.alloc(size);
    buf.copy(b, 0, 0, Math.min(buf.length, size));
    this.chunks.push(b); this.len += size; return this;
  }
  /** 直接拼接已对齐的裸字节 */
  raw(buf) { this.chunks.push(buf); this.len += buf.length; return this; }
  /** 文件名 / 路径：本质就是带长度前缀的 opaque */
  str(s) { return this.opaque(Buffer.from(s, 'utf8')); }
  bytes() { return Buffer.concat(this.chunks); }
}

/** 简单的 XDR 读取器 */
class XdrReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u32() { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  i32() { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  u64() { const hi = this.u32(); const lo = this.u32(); return hi * 0x100000000 + lo; }
  bool() { return this.u32() !== 0; }
  enum() { return this.u32(); }
  opaque() {
    const len = this.u32();
    const b = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    this.pos += (4 - (len % 4)) % 4; // 跳过填充
    return b;
  }
  fixed(size) { const b = this.buf.slice(this.pos, this.pos + size); this.pos += size; return b; }
  str() { return this.opaque().toString('utf8'); }
  skip(n) { this.pos += n; }
}

/* ----------------------------- 文件句柄 ----------------------------- */

/**
 * 短文件句柄映射（v4）
 * ---------------------------------------------------------------------
 * fh = 'N4'(2) + diskId(1) + md5hex(16 字节二进制)。总 19 字节 ≤ FHSIZE3(64)。
 * hashKey = md5(disk + '/' + rel) 的十六进制（32 字符）。
 * 映射 hashKey → { d: disk, p: rel }，持久化到 data 目录，重启不丢。
 * 未命中时按磁盘全盘扫描重建（懒加载，每个磁盘至多一次）。
 */
const FH_MAGIC = Buffer.from('N4');
const DISK_TO_ID = { public: 1, private: 2 };
const ID_TO_DISK = { 1: 'public', 2: 'private' };

const fhState = {
  dataDir: path.join(__dirname, '..', 'data'),
  mapFile: null,
  map: new Map(),       // hashKey(hex) -> { d, p }
  loaded: false,
  loading: null,
  scanDone: new Set(),
  saveTimer: null,
};

function fhHash(disk, rel) {
  return crypto.createHash('md5').update(disk + '/' + (rel || '')).digest('hex');
}

function fhLoad() {
  if (fhState.loaded) return;
  if (!fhState.mapFile) fhState.mapFile = path.join(fhState.dataDir, '.nfs-fhmap.json');
  try {
    const raw = JSON.parse(fs.readFileSync(fhState.mapFile, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.d === 'string') fhState.map.set(k, { d: v.d, p: v.p || '' });
      }
    }
  } catch { /* 首次无文件，忽略 */ }
  fhState.loaded = true;
}

function fhSave() {
  // 合并落盘（去抖，避免高频写）
  if (fhState.saveTimer) clearTimeout(fhState.saveTimer);
  fhState.saveTimer = setTimeout(() => {
    try {
      const obj = {};
      for (const [k, v] of fhState.map) obj[k] = v;
      const tmp = fhState.mapFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, fhState.mapFile);
    } catch { /* 映射可重建，落盘失败不致命 */ }
  }, 500);
}

function fhPut(disk, rel) {
  fhLoad();
  const key = fhHash(disk, rel);
  if (!fhState.map.has(key)) {
    fhState.map.set(key, { d: disk, p: rel || '' });
    fhSave();
  }
  return key;
}

function fhGet(key) {
  fhLoad();
  return fhState.map.get(key) || null;
}

/** 扫描某磁盘根目录，重建全部 hash → rel 映射 */
function fhScanDisk(disk) {
  if (fhState.scanDone.has(disk)) return;
  const root = path.join(fhState.dataDir, 'storage', disk);
  let added = 0;
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const key = fhHash(disk, childRel);
      if (!fhState.map.has(key)) { fhState.map.set(key, { d: disk, p: childRel }); added++; }
      if (e.isDirectory()) {
        try { walk(path.join(dir, e.name), childRel); } catch {}
      }
    }
  };
  // 根目录自身（rel=''）
  const rootKey = fhHash(disk, '');
  if (!fhState.map.has(rootKey)) { fhState.map.set(rootKey, { d: disk, p: '' }); added++; }
  try { walk(root, ''); } catch {}
  fhState.scanDone.add(disk);
  if (added) fhSave();
}

/** 签发短文件句柄（v4），同时登记映射。总长度 19 字节。 */
function packFh(disk, rel) {
  const diskId = DISK_TO_ID[disk] || 0; // 未知磁盘（ext:* 等）给 0，仅靠 hash + 映射
  const key = fhPut(disk, rel);        // hex 32 字符
  const hashBuf = Buffer.from(key, 'hex'); // 16 字节
  const out = Buffer.alloc(FH_MAGIC.length + 1 + 16);
  FH_MAGIC.copy(out, 0);
  out.writeUInt8(diskId & 0xff, FH_MAGIC.length);
  hashBuf.copy(out, FH_MAGIC.length + 1);
  return out;
}

/** 解包句柄：优先 v4 短句柄；回退旧 N3 长句柄。非法返回 null。 */
function unpackFh(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;
  // v4: 'N4' + 1 + 16 = 19
  if (buf.length === 19 && buf[0] === 0x4E && buf[1] === 0x34) {
    const diskId = buf.readUInt8(2);
    const key = buf.slice(3, 19).toString('hex');
    let hit = fhGet(key);
    if (!hit) {
      const disk = ID_TO_DISK[diskId];
      if (disk) { fhScanDisk(disk); hit = fhGet(key); }
    }
    if (hit) return { disk: hit.d, rel: hit.p };
    return null;
  }
  // 旧 v3 长句柄（兼容）
  const s = buf.toString('utf8');
  if (s.slice(0, 2) === 'N3') {
    try {
      const json = Buffer.from(s.slice(2), 'base64url').toString('utf8');
      const o = JSON.parse(json);
      if (o && typeof o.d === 'string') return { disk: o.d, rel: o.p || '' };
    } catch { return null; }
  }
  return null;
}

/* ----------------------------- 工具 ----------------------------- */

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }

/** errno 字符串 → NFS3 错误码 */
function errnoToNfs(code) {
  switch (code) {
    case 'EACCES': case 'EPERM': return NFS3ERR_ACCES;
    case 'ENOENT': return NFS3ERR_NOENT;
    case 'EEXIST': return NFS3ERR_EXIST;
    case 'ENOTDIR': return NFS3ERR_NOTDIR;
    case 'EISDIR': return NFS3ERR_ISDIR;
    case 'ENOTEMPTY': case 'EEXIST': return NFS3ERR_NOTEMPTY;
    case 'EXDEV': return NFS3ERR_NOTSUPP; // 跨文件系统，按 NOTSUPP 处理
    case 'EROFS': return NFS3ERR_ACCES;
    default: return NFS3ERR_IO;
  }
}

/** 相对路径拼接：处理 '.' 与 '..'（不能越过盘根） */
function childRel(rel, name) {
  if (name === '.') return rel;
  if (name === '..') {
    if (rel === '') return '';
    const i = rel.lastIndexOf('/');
    return i < 0 ? '' : rel.slice(0, i);
  }
  return rel === '' ? name : rel + '/' + name;
}

/* =====================================================================
 * NfsServer
 * ===================================================================== */
class NfsServer {
  constructor(srv) {
    if (!srv) throw new Error('NfsServer 需要一个 srv（FileServer 实例）');
    this.srv = srv;
    /* R9：NFS 是**未认证**的局域网服务（MOUNT 不带凭据），所以它用合成用户解析路径。
       原来只给 private 盘用合成用户，public/ext 用 guest —— 收紧 ACL 后
       guest 对 ext 是 none，NFS 的 /ext 导出会直接 ACCESS 失败（功能回归）。
       现在统一用合成用户：**写操作依然全被 ROFS 挡住**（见 resolveFh），
       读权限与收紧前一致。NFS 的信任边界是「局域网」，不在这轮 Web ACL 的范围内。 */
    this._nfsUser = { id: 'nfs', username: 'nfs', role: 'admin' };
    this._fsid = 0x4E465300; // 固定 fsid（uint64 低 32 位）
    this._servers = [];
    this._sockets = [];
  }

  /**
   * 启动监听。类不自动监听，需显式调用。
   * NFS  → TCP+UDP 2049（program 100003 v3）
   * MOUNT→ TCP+UDP 42000（program 100005 v3）
   */
  listen(opts = {}) {
    const o = Object.assign(
      { tcpPort: 2049, udpPort: 2049, mountTcpPort: 42000, mountUdpPort: 42000, host: '0.0.0.0' },
      opts
    );
    this._startTcp(o.host, o.tcpPort, 'NFS');
    this._startUdp(o.host, o.udpPort, 'NFS');
    this._startTcp(o.host, o.mountTcpPort, 'MOUNT');
    this._startUdp(o.host, o.mountUdpPort, 'MOUNT');
    return this;
  }

  /** 关闭所有监听（便于测试后清理） */
  close() {
    for (const s of this._servers) try { s.close(); } catch {}
    for (const s of this._sockets) try { s.close(); } catch {}
    this._servers = []; this._sockets = [];
  }

  /* -------- 传输层：TCP（RFC 5531 record marking） -------- */
  _startTcp(host, port, tag) {
    let conns = 0;   // 本监听端口的当前连接数
    const server = net.createServer((sock) => {
      /* ④ 连接洪泛防护：并发连接数有上限，超了直接拒（连上就断） */
      if (conns >= NFS_MAX_CONNS) {
        try { sock.destroy(); } catch { /* ignore */ }
        return;
      }
      conns++;
      const peer = (sock.remoteAddress || '?') + ':' + (sock.remotePort || 0);

      /* 未收齐记录的数据块（分块列表，避免 Buffer.concat 的 O(n²) 拷贝） */
      let parts = [];
      let partsLen = 0;
      let frag = null;       // 正在收齐的**分片**数据
      let fragNeed = 0;      // 该分片还差多少字节
      let fragLast = true;   // 该分片是不是最后一片
      let msgParts = [];     // 一条记录（record）由若干分片组成
      let msgLen = 0;
      let total = 0;         // 本连接累计读取字节
      let broken = false;

      const drop = (why) => {
        if (broken) return;
        broken = true;
        clearTimeout(ageTimer);
        conns = Math.max(0, conns - 1);
        try { sock.destroy(); } catch { /* ignore */ }
        /* 断连原因只记 debug：避免被用来刷日志 */
        if (process.env.NFS_DEBUG) console.error('[nfs] 断开 ' + peer + '：' + why);
      };

      /* ③ 慢连接防护：空闲超时 / 存活时长上限 */
      sock.setTimeout(NFS_IDLE_TIMEOUT_MS, () => { drop('空闲超时'); });
      const ageTimer = setTimeout(() => { drop('连接存活超时'); }, NFS_CONN_MAX_AGE_MS);
      if (ageTimer.unref) ageTimer.unref();

      /** 从 parts 里取走 n 字节（跨块时拼接） */
      const take = (n) => {
        const out = Buffer.allocUnsafe(n);
        let got = 0;
        while (got < n && parts.length) {
          const p = parts[0];
          const k = Math.min(p.length, n - got);
          p.copy(out, got, 0, k);
          got += k;
          if (k === p.length) parts.shift();
          else parts[0] = p.subarray(k);
        }
        partsLen -= got;
        return out;
      };

      sock.on('data', (d) => {
        if (broken) return;
        total += d.length;
        if (total > NFS_MAX_CONN_BYTES) return drop('累计字节超限');
        parts.push(d); partsLen += d.length;
        for (;;) {
          if (!frag) {
            if (partsLen < 4) return;                       // 分片头没收齐
            const hdr = take(4).readUInt32BE(0);
            const last = (hdr & 0x80000000) !== 0;
            const len = hdr & 0x7fffffff;
            /* ① 分片长度上限：RFC 5531 里的 2^31-1 是理论值，实际 NFS 读写
               都在 1MB 以内。不设限 = 未认证即可让服务端缓冲 2GB（内存耗尽 DoS）。
               多分片组成的整条记录同样不能超过上限（否则又是一个绕过口）。 */
            if (len > NFS_MAX_RECORD) return drop('分片长度超限');
            if (msgLen + len > NFS_MAX_RECORD) return drop('记录总长超限');
            frag = Buffer.allocUnsafe(len);
            fragNeed = len;
            fragLast = last;
          }
          if (fragNeed > 0) {
            if (partsLen === 0) return;                     // 分片没收齐，等更多数据
            const k = Math.min(fragNeed, partsLen);
            const chunk = take(k);
            chunk.copy(frag, frag.length - fragNeed);
            fragNeed -= k;
            if (fragNeed > 0) return;
          }
          /* 分片收齐：拼进当前记录（RFC 5531 的一条 record 可由多个 fragment 组成） */
          msgParts.push(frag);
          msgLen += frag.length;
          const isLast = fragLast;
          frag = null;
          if (!isLast) continue;
          const msg = msgParts.length === 1 ? msgParts[0] : Buffer.concat(msgParts);
          msgParts = [];
          msgLen = 0;
          let reply = null;
          try { reply = this.processCall(msg); } catch (e) { console.error('[nfs] tcp 处理异常', e); }
          if (reply && reply.length) {
            const rh = Buffer.alloc(4);
            rh.writeUInt32BE((0x80000000 + reply.length) >>> 0, 0); // 单分片、最后分片（高位 bit=1）
            try { sock.write(Buffer.concat([rh, reply])); } catch {}
          }
        }
      });
      sock.on('error', () => { drop('socket 错误'); });
      sock.on('close', () => {
        if (!broken) { broken = true; clearTimeout(ageTimer); conns = Math.max(0, conns - 1); }
      });
    });
    server.on('error', (e) => console.error(`[nfs] TCP ${tag}@${port} 错误:`, e.message));
    server.listen(port, host, () => console.log(`  [NFS] ${tag} TCP 监听 ${host}:${port}`));
    this._servers.push(server);
  }

  /* -------- 传输层：UDP（整包即一个 RPC） -------- */
  _startUdp(host, port, tag) {
    const sock = dgram.createSocket('udp4');
    sock.on('error', (e) => console.error(`[nfs] UDP ${tag}@${port} 错误:`, e.message));
    sock.on('message', (msg, rinfo) => {
      let reply = null;
      try { reply = this.processCall(msg); } catch (e) { console.error('[nfs] udp 处理异常', e); }
      if (reply && reply.length) {
        try { sock.send(reply, rinfo.port, rinfo.address); } catch {}
      }
    });
    sock.bind(port, host, () => console.log(`  [NFS] ${tag} UDP 监听 ${host}:${port}`));
    this._sockets.push(sock);
  }

  /* -------- RPC 报文处理（解析 CALL → 构造 REPLY） -------- */
  processCall(msg) {
    if (!Buffer.isBuffer(msg) || msg.length < 24) return null;
    const r = new XdrReader(msg);
    const xid = r.u32();
    const mtype = r.u32();
    if (mtype !== 0) return null; // 非 CALL，忽略
    const rpcvers = r.u32();
    if (rpcvers !== 2) return null;
    const prog = r.u32();
    const vers = r.u32();
    const proc = r.u32();
    // 跳过 cred / verf（opaque_auth：flavor + body）
    const _cf = r.u32(); const _cb = r.opaque();
    const _vf = r.u32(); const _vb = r.opaque();
    const args = msg.slice(r.pos);
    /* ⑤ 调试日志改为按开关输出：原本每条 RPC 都 console.error，
       挂载一多就是日志刷屏（还能被用来刷爆磁盘/拖慢 I/O）。 */
    if (process.env.NFS_DEBUG) {
      try { console.error('[RPCDBG] prog=' + prog + ' vers=' + vers + ' proc=' + proc + ' credflavor=' + _cf + ' credlen=' + _cb.length + ' verflen=' + _vb.length + ' argslen=' + args.length); } catch { /* ignore */ }
    }

    const w = new XdrWriter();
    w.u32(xid);
    w.u32(1);            // REPLY
    w.u32(0);            // MSG_ACCEPTED
    w.u32(AUTH_NULL); w.u32(0); // verf: AUTH_NULL

    // 程序级校验
    if (prog !== NFS_PROGRAM && prog !== MOUNT_PROGRAM) {
      w.u32(1); // PROG_UNAVAIL
      return w.bytes();
    }
    if (vers !== 3) {
      w.u32(2); // PROG_MISMATCH
      w.u32(3); w.u32(3);
      return w.bytes();
    }

    let resW = null;
    try {
      if (prog === NFS_PROGRAM) resW = this.dispatchNfs(proc, args);
      else resW = this.dispatchMount(proc, args);
    } catch (e) {
      console.error('[nfs] 分发异常', e);
      w.u32(4); // GARBAGE_ARGS
      return w.bytes();
    }

    if (resW === null) { w.u32(3); return w.bytes(); } // PROC_UNAVAIL

    /* SUCCESS：accepted_reply 的 results 是**记录剩余字节本身**，
       不能再包一层 u32 长度前缀 —— 标准客户端（Linux 内核 mountd、
       libtirpc）会把这 4 字节误读成过程状态码（实测 MNT 被读成 52→EACCES）。
       记录边界由 TCP record marking / UDP 数据报界定。 */
    w.u32(0);
    w.raw(resW.bytes());
    return w.bytes();
  }

  /* ===================================================================
   * NFS v3 分发（program 100003）
   * =================================================================== */
  dispatchNfs(proc, args) {
    const r = new XdrReader(args);
    const w = new XdrWriter();
    switch (proc) {
      case 0: return w;                                  // NULL
      case 1: return this.nfsGetattr(r, w);
      case 2: return this.nfsSetattr(r, w);
      case 3: return this.nfsLookup(r, w);
      case 4: return this.nfsAccess(r, w);
      case 5: return this.nfsReadlink(r, w);
      case 6: return this.nfsRead(r, w);
      case 7: return this.nfsWrite(r, w);
      case 8: return this.nfsCreate(r, w);
      case 9: return this.nfsMkdir(r, w);
      case 10: return this.nfsSymlink(r, w);
      case 11: return this.nfsMknod(r, w);
      case 12: return this.nfsRemove(r, w);
      case 13: return this.nfsRmdir(r, w);
      case 14: return this.nfsRename(r, w);
      case 15: return this.nfsLink(r, w);
      case 16: return this.nfsReaddir(r, w, false);
      case 17: return this.nfsReaddir(r, w, true);
      case 18: return this.nfsFsstat(r, w);
      case 19: return this.nfsFsinfo(r, w);
      case 20: return this.nfsPathconf(r, w);
      case 21: return this.nfsCommit(r, w);
      default: return null;                              // PROC_UNAVAIL
    }
  }

  /** 句柄 → 绝对路径（含 root），失败回错误码 */
  resolveFh(fhBuf, write) {
    const h = unpackFh(fhBuf);
    if (!h) return { error: NFS3ERR_BADHANDLE };
    /* NFS 当前对局域网只导出 public 且为**游客只读**（启动横幅与 MOUNT
       导出一致），private 盘不导出。NFS v3 不带 Web 层的登录会话，
       不能用合成 admin 身份放行写——否则游客可经 NFS 绕过只读策略。
       任何写/改/删类操作一律回 NFS3ERR_ROFS（只读文件系统）。 */
    if (write) return { error: NFS3ERR_ROFS };
    const user = this._nfsUser;
    const t = this.srv.resolveTarget(
      { disk: h.disk, path: h.rel, _write: false }, user
    );
    if (t.error) {
      // 把 srv 的错误码翻译成 NFS3 错误
      const c = t.code;
      if (c === 404 || c === 400) return { error: NFS3ERR_NOENT };
      if (c === 401 || c === 403) return { error: NFS3ERR_ACCES };
      return { error: NFS3ERR_IO };
    }
    return { abs: t.abs, root: t.root, disk: h.disk, rel: h.rel };
  }

  /* -------- fattr3 属性写入 -------- */
  writeTime(w, date) {
    const ms = date.getTime();
    w.u32(Math.floor(ms / 1000) >>> 0);
    w.u32(((ms % 1000) * 1e6) >>> 0);
  }

  writeFattr(w, st, abs) {
    const isDir = st.isDirectory();
    w.u32(isDir ? 2 : 1);                 // ftype3: NF3DIR=2 / NF3REG=1
    w.u32(isDir ? 0o40755 : 0o100644);    // mode（含类型位）
    w.u32(isDir ? 2 : 1);                 // nlink
    w.u32(10235);                         // uid（固定）
    w.u32(10235);                         // gid（固定）
    w.u64(st.size);                       // size
    w.u64(st.size);                       // used（按 size 近似）
    w.u32(0); w.u32(0);                   // rdev specdata1/2
    w.u64([0, this._fsid]);               // fsid（uint64，低 32 位固定）
    // fileid = path 的 md5 前 4 字节（uint32，放在 uint64 低位）
    const h = crypto.createHash('md5').update(abs).digest();
    w.u64([0, h.readUInt32BE(0)]);
    this.writeTime(w, st.atime);
    this.writeTime(w, st.mtime);
    this.writeTime(w, st.ctime);
  }

  /** post_op_attr：bool + (true 时 fattr3) */
  writePostOpAttr(w, st, abs) {
    if (!st) { w.bool(false); return; }
    w.bool(true);
    this.writeFattr(w, st, abs);
  }

  /** pre_op_attr = switch(bool){ 0:void | 1:wcc_attr{size u64, ctime, mtime} }
   * 旧实现缺 bool、缺 size，absent 还多写零 —— 每个 wcc_data 都错位，
   * 直接表现为以 wcc 开头的 WRITE/REMOVE/SETATTR 应答被内核判 EIO。 */
  writePreOpAttr(w, st) {
    if (!st) { w.bool(false); return; }
    w.bool(true);
    w.u64(st.size);
    this.writeTime(w, st.ctime);
    this.writeTime(w, st.mtime);
  }

  /** wcc_data：pre_op_attr + post_op_attr */
  writeWcc(w, beforeSt, beforeAbs, afterSt, afterAbs) {
    this.writePreOpAttr(w, beforeSt);
    this.writePostOpAttr(w, afterSt, afterAbs);
  }

  /** post_op_fh3：bool + (true 时 fhandle3) */
  writePostOpFh(w, fhBuf) {
    if (!fhBuf) { w.bool(false); return; }
    w.bool(true);
    w.opaque(fhBuf);
  }

  /** 解析 sattr3（consume 全部字节，返回捕获到的 size 以便 SETATTR 应用） */
  readSattr(r) {
    const out = {};
    if (r.bool()) r.u32();                 // set_mode
    if (r.bool()) r.u32();                 // set_uid
    if (r.bool()) r.u32();                 // set_gid
    if (r.bool()) out.size = r.u64();      // set_size
    if (r.enum() === 2) { r.u32(); r.u32(); } // set_atime = SET_TO_CLIENT_TIME
    if (r.enum() === 2) { r.u32(); r.u32(); } // set_mtime
    return out;
  }

  /* -------- 各 proc 实现 -------- */

  // 1 GETATTR
  nfsGetattr(r, w) {
    const fhBuf = r.opaque();
    const res = this.resolveFh(fhBuf, false);
    if (res.error) { w.u32(res.error); return w; }
    const st = safeStat(res.abs);
    if (!st) { w.u32(NFS3ERR_NOENT); return w; }
    w.u32(0);
    this.writeFattr(w, st, res.abs);
    return w;
  }

  // 2 SETATTR（局域网信任模型：忽略 mode/uid/gid，仅可选应用 size）
  nfsSetattr(r, w) {
    const fhBuf = r.opaque();
    const sattr = this.readSattr(r);
    const guard = r.bool();
    if (guard) { r.u32(); r.u32(); } // sattrguard3：obj_ctime
    const res = this.resolveFh(fhBuf, true);
    if (res.error) { w.u32(res.error); this.writeWcc(w, null, null, null, null); return w; }
    const before = safeStat(res.abs);
    if (!before) { w.u32(NFS3ERR_NOENT); this.writeWcc(w, null, null, null, null); return w; }
    let after = before;
    try {
      if (sattr.size !== undefined) fs.truncateSync(res.abs, sattr.size);
      after = safeStat(res.abs) || before;
      w.u32(0);
      this.writeWcc(w, before, res.abs, after, res.abs);
    } catch (e) {
      w.u32(errnoToNfs(e.code));
      this.writeWcc(w, before, res.abs, null, null);
    }
    return w;
  }

  // 3 LOOKUP
  nfsLookup(r, w) {
    const dirFh = r.opaque();
    const name = r.str();
    const dir = this.resolveFh(dirFh, false);
    if (dir.error) { w.u32(dir.error); return w; }
    const dirSt = safeStat(dir.abs);
    if (!dirSt) { w.u32(NFS3ERR_NOENT); return w; }
    if (!dirSt.isDirectory()) { w.u32(NFS3ERR_NOTDIR); return w; }
    const cRel = childRel(dir.rel, name);
    const user = this._nfsUser;
    const t = this.srv.resolveTarget({ disk: dir.disk, path: cRel }, user);
    if (t.error) { w.u32(NFS3ERR_NOENT); this.writePostOpAttr(w, dirSt, dir.abs); return w; }
    const st = safeStat(t.abs);
    if (!st) { w.u32(NFS3ERR_NOENT); this.writePostOpAttr(w, dirSt, dir.abs); return w; }
    w.u32(0);
    /* RFC1813 LOOKUP3resok：
       nfs_fh3 object; post_op_attr obj_attributes; post_op_attr dir_attributes;
       注意 dir_attributes 是**单纯的 post_op_attr（bool+fattr），没有
       post_op_fh3** —— 旧实现误加了一个父目录 fh，导致整个响应在 fh 之后
       字段错位（内核把 dir fattr 错读成 fileid，报 fileid changed / ESTALE）。 */
    w.opaque(packFh(dir.disk, cRel));
    this.writePostOpAttr(w, st, t.abs);
    this.writePostOpAttr(w, dirSt, dir.abs);
    return w;
  }

  // 4 ACCESS
  nfsAccess(r, w) {
    const fhBuf = r.opaque();
    r.u32(); // requested access（服务端按实际能力给，不依赖请求位）
    const res = this.resolveFh(fhBuf, false);
    if (res.error) { w.u32(res.error); return w; }
    const st = safeStat(res.abs);
    if (!st) { w.u32(NFS3ERR_NOENT); return w; }
    w.u32(0);
    this.writePostOpAttr(w, st, res.abs);
    let access = 0;
    const C = fs.constants;
    let canR = false, canW = false, canX = false;
    try { fs.accessSync(res.abs, C.R_OK); canR = true; } catch {}
    try { fs.accessSync(res.abs, C.W_OK); canW = true; } catch {}
    try { fs.accessSync(res.abs, C.X_OK); canX = true; } catch {}
    const isDir = st.isDirectory();
    if (isDir) {
      if (canR) access |= (1 | 2);   // READ + LOOKUP
      if (canW) access |= (4 | 8 | 16); // MODIFY + EXTEND + DELETE
      if (canX) access |= 32;
    } else {
      if (canR) access |= 1;
      if (canW) access |= (4 | 8);
      if (canX) access |= 32;
    }
    w.u32(access);
    return w;
  }

  // 5 READLINK（不支持符号链接）
  nfsReadlink(r, w) {
    const fhBuf = r.opaque();
    const res = this.resolveFh(fhBuf, false);
    if (res.error) { w.u32(res.error); return w; }
    w.u32(NFS3ERR_NOTSUPP); // 本项目仅普通文件/目录，符号链接不支持
    return w;
  }

  // 6 READ
  nfsRead(r, w) {
    const fhBuf = r.opaque();
    const offset = r.u64();
    let count = r.u32();
    count = Math.min(count, 1024 * 1024); // clamp 到 1MB
    const res = this.resolveFh(fhBuf, false);
    if (res.error) { w.u32(res.error); return w; }
    const st = safeStat(res.abs);
    if (!st) { w.u32(NFS3ERR_NOENT); return w; }
    if (st.isDirectory()) { w.u32(NFS3ERR_ISDIR); this.writePostOpAttr(w, st, res.abs); return w; }
    const total = st.size;
    const start = Math.min(offset, total);
    const toRead = Math.max(0, Math.min(count, total - start));
    let data = Buffer.alloc(0);
    try {
      if (toRead > 0) {
        const fd = fs.openSync(res.abs, 'r');
        data = Buffer.alloc(toRead);
        fs.readSync(fd, data, 0, toRead, start);
        fs.closeSync(fd);
      }
      const after = safeStat(res.abs) || st;
      w.u32(0);
      this.writePostOpAttr(w, after, res.abs);
      w.u32(toRead);
      w.bool(start + toRead >= total); // eof
      w.opaque(data);
    } catch (e) {
      w.u32(errnoToNfs(e.code));
      this.writePostOpAttr(w, st, res.abs);
    }
    return w;
  }

  // 7 WRITE（先写临时文件再 rename 覆盖，保证原子落盘；stable 一律当 FILE_SYNC）
  nfsWrite(r, w) {
    const fhBuf = r.opaque();
    const offset = r.u64();
    const count = r.u32();
    r.u32(); // stable enum（忽略，全部按 FILE_SYNC 落盘）
    const data = r.opaque();
    const res = this.resolveFh(fhBuf, true);
    if (res.error) { w.u32(res.error); this.writeWcc(w, null, null, null, null); return w; }
    const before = safeStat(res.abs);
    const parent = path.dirname(res.abs);
    if (!fs.existsSync(parent)) {
      w.u32(NFS3ERR_NOENT); this.writeWcc(w, before, res.abs, null, null); return w;
    }
    try {
      const tmp = res.abs + '.nfs-' + crypto.randomBytes(4).toString('hex');
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, data, 0, data.length, offset);
      fs.closeSync(fd);
      fs.renameSync(tmp, res.abs); // 原子覆盖
      const after = safeStat(res.abs);
      w.u32(0);
      this.writeWcc(w, before, res.abs, after, res.abs);
      w.u32(data.length); // count
      w.u32(2);           // stable = FILE_SYNC
      w.fixed(WRITEVERF, 8);
    } catch (e) {
      w.u32(errnoToNfs(e.code));
      this.writeWcc(w, before, res.abs, null, null);
    }
    return w;
  }

  // 8 CREATE
  nfsCreate(r, w) {
    const dirFh = r.opaque();
    const name = r.str();
    const how = r.enum(); // UNCHECKED=0 / GUARDED=1 / EXCLUSIVE=2
    if (how === 0 || how === 1) this.readSattr(r);
    else if (how === 2) r.fixed(8); // EXCLUSIVE verifier
    else { w.u32(NFS3ERR_BADXDR); this.writeWcc(w, null, null, null, null); return w; }

    const dir = this.resolveFh(dirFh, true);
    if (dir.error) { w.u32(dir.error); this.writeWcc(w, null, null, null, null); return w; }
    const dirSt = safeStat(dir.abs);
    if (!dirSt) { w.u32(NFS3ERR_NOENT); this.writeWcc(w, null, null, null, null); return w; }
    const cRel = childRel(dir.rel, name);
    const user = this._nfsUser;
    const t = this.srv.resolveTarget({ disk: dir.disk, path: cRel, _write: true }, user);
    if (t.error) { w.u32(NFS3ERR_ACCES); this.writeWcc(w, dirSt, dir.abs, null, null); return w; }

    if (fs.existsSync(t.abs)) {
      if (how === 1) { w.u32(NFS3ERR_EXIST); this.writeWcc(w, dirSt, dir.abs, null, null); return w; }
      // UNCHECKED：保留已有文件
    } else {
      try { fs.writeFileSync(t.abs, Buffer.alloc(0)); }
      catch (e) { w.u32(errnoToNfs(e.code)); this.writeWcc(w, dirSt, dir.abs, null, null); return w; }
    }
    const st = safeStat(t.abs);
    w.u32(0);
    this.writePostOpFh(w, packFh(dir.disk, cRel));
    this.writePostOpAttr(w, st, t.abs);
    this.writeWcc(w, dirSt, dir.abs, safeStat(dir.abs), dir.abs);
    return w;
  }

  // 9 MKDIR
  nfsMkdir(r, w) {
    const dirFh = r.opaque();
    const name = r.str();
    this.readSattr(r);
    const dir = this.resolveFh(dirFh, true);
    if (dir.error) { w.u32(dir.error); this.writeWcc(w, null, null, null, null); return w; }
    const dirSt = safeStat(dir.abs);
    if (!dirSt) { w.u32(NFS3ERR_NOENT); this.writeWcc(w, null, null, null, null); return w; }
    const cRel = childRel(dir.rel, name);
    const user = this._nfsUser;
    const t = this.srv.resolveTarget({ disk: dir.disk, path: cRel, _write: true }, user);
    if (t.error) { w.u32(NFS3ERR_ACCES); this.writeWcc(w, dirSt, dir.abs, null, null); return w; }
    if (fs.existsSync(t.abs)) { w.u32(NFS3ERR_EXIST); this.writeWcc(w, dirSt, dir.abs, null, null); return w; }
    try { fs.mkdirSync(t.abs); }
    catch (e) { w.u32(errnoToNfs(e.code)); this.writeWcc(w, dirSt, dir.abs, null, null); return w; }
    const st = safeStat(t.abs);
    w.u32(0);
    this.writePostOpFh(w, packFh(dir.disk, cRel));
    this.writePostOpAttr(w, st, t.abs);
    this.writeWcc(w, dirSt, dir.abs, safeStat(dir.abs), dir.abs);
    return w;
  }

  // 10 SYMLINK（不支持）
  nfsSymlink(r, w) {
    r.opaque(); r.str(); this.readSattr(r); // consume args
    w.u32(NFS3ERR_NOTSUPP);
    this.writeWcc(w, null, null, null, null);
    return w;
  }

  // 11 MKNOD（不支持）
  nfsMknod(r, w) {
    r.opaque(); r.str(); r.u32(); r.u32(); r.u32(); this.readSattr(r); // consume
    w.u32(NFS3ERR_NOTSUPP);
    this.writeWcc(w, null, null, null, null);
    return w;
  }

  // 12 REMOVE（直接删，不进回收站）
  nfsRemove(r, w) {
    const dirFh = r.opaque();
    const name = r.str();
    const dir = this.resolveFh(dirFh, true);
    if (dir.error) { w.u32(dir.error); this.writeWcc(w, null, null, null, null); return w; }
    const before = safeStat(dir.abs);
    const cRel = childRel(dir.rel, name);
    const user = this._nfsUser;
    const t = this.srv.resolveTarget({ disk: dir.disk, path: cRel, _write: true }, user);
    if (t.error) { w.u32(NFS3ERR_ACCES); this.writeWcc(w, before, dir.abs, null, null); return w; }
    // 命中目录则拒绝（应用 RMDIR）
    const st = safeStat(t.abs);
    if (st && st.isDirectory()) { w.u32(NFS3ERR_ISDIR); this.writeWcc(w, before, dir.abs, safeStat(dir.abs), dir.abs); return w; }
    try {
      fs.unlinkSync(t.abs);
      w.u32(0);
      this.writeWcc(w, before, dir.abs, safeStat(dir.abs), dir.abs);
    } catch (e) {
      w.u32(errnoToNfs(e.code));
      this.writeWcc(w, before, dir.abs, null, null);
    }
    return w;
  }

  // 13 RMDIR
  nfsRmdir(r, w) {
    const dirFh = r.opaque();
    const name = r.str();
    const dir = this.resolveFh(dirFh, true);
    if (dir.error) { w.u32(dir.error); this.writeWcc(w, null, null, null, null); return w; }
    const before = safeStat(dir.abs);
    const cRel = childRel(dir.rel, name);
    const user = this._nfsUser;
    const t = this.srv.resolveTarget({ disk: dir.disk, path: cRel, _write: true }, user);
    if (t.error) { w.u32(NFS3ERR_ACCES); this.writeWcc(w, before, dir.abs, null, null); return w; }
    const st = safeStat(t.abs);
    if (st && !st.isDirectory()) { w.u32(NFS3ERR_NOTDIR); this.writeWcc(w, before, dir.abs, safeStat(dir.abs), dir.abs); return w; }
    try {
      fs.rmdirSync(t.abs);
      w.u32(0);
      this.writeWcc(w, before, dir.abs, safeStat(dir.abs), dir.abs);
    } catch (e) {
      w.u32(errnoToNfs(e.code));
      this.writeWcc(w, before, dir.abs, null, null);
    }
    return w;
  }

  // 14 RENAME（跨文件系统回退 copy+delete）
  nfsRename(r, w) {
    const fromFh = r.opaque();
    const fromName = r.str();
    const toFh = r.opaque();
    const toName = r.str();
    const from = this.resolveFh(fromFh, true);
    if (from.error) { w.u32(from.error); this.writeWcc(w, null, null, null, null); this.writeWcc(w, null, null, null, null); return w; }
    const to = this.resolveFh(toFh, true);
    if (to.error) { w.u32(to.error); this.writeWcc(w, null, null, null, null); this.writeWcc(w, null, null, null, null); return w; }
    const fRel = childRel(from.rel, fromName);
    const tRel = childRel(to.rel, toName);
    const fu = this._nfsUser;
    const tu = this._nfsUser;
    const ft = this.srv.resolveTarget({ disk: from.disk, path: fRel, _write: true }, fu);
    const tt = this.srv.resolveTarget({ disk: to.disk, path: tRel, _write: true }, tu);
    const fromBefore = safeStat(from.abs);
    const toBefore = safeStat(to.abs);
    if (ft.error || tt.error) {
      w.u32(NFS3ERR_ACCES);
      this.writeWcc(w, fromBefore, from.abs, null, null);
      this.writeWcc(w, toBefore, to.abs, null, null);
      return w;
    }
    try {
      fs.renameSync(ft.abs, tt.abs);
    } catch (e) {
      if (e.code === 'EXDEV') {
        try {
          fs.cpSync(ft.abs, tt.abs, { recursive: true });
          fs.rmSync(ft.abs, { recursive: true, force: true });
        } catch (e2) {
          w.u32(NFS3ERR_IO);
          this.writeWcc(w, fromBefore, from.abs, null, null);
          this.writeWcc(w, toBefore, to.abs, null, null);
          return w;
        }
      } else {
        w.u32(errnoToNfs(e.code));
        this.writeWcc(w, fromBefore, from.abs, null, null);
        this.writeWcc(w, toBefore, to.abs, null, null);
        return w;
      }
    }
    w.u32(0);
    this.writeWcc(w, fromBefore, from.abs, safeStat(from.abs), from.abs);
    this.writeWcc(w, toBefore, to.abs, safeStat(to.abs), to.abs);
    return w;
  }

  // 15 LINK（尽力实现：硬链接）
  nfsLink(r, w) {
    const fileFh = r.opaque();   // 已存在文件
    const linkDirFh = r.opaque(); // 链接所在目录
    const linkName = r.str();
    const file = this.resolveFh(fileFh, false);
    if (file.error) { w.u32(file.error); this.writePostOpAttr(w, null, null); this.writeWcc(w, null, null, null, null); return w; }
    const dir = this.resolveFh(linkDirFh, true);
    if (dir.error) { w.u32(dir.error); this.writePostOpAttr(w, safeStat(file.abs), file.abs); this.writeWcc(w, null, null, null, null); return w; }
    const dirBefore = safeStat(dir.abs);
    const fileSt = safeStat(file.abs);
    const cRel = childRel(dir.rel, linkName);
    const du = this._nfsUser;
    const lt = this.srv.resolveTarget({ disk: dir.disk, path: cRel, _write: true }, du);
    if (lt.error) { w.u32(NFS3ERR_ACCES); this.writePostOpAttr(w, fileSt, file.abs); this.writeWcc(w, dirBefore, dir.abs, null, null); return w; }
    try {
      fs.linkSync(file.abs, lt.abs);
      w.u32(0);
      this.writePostOpAttr(w, safeStat(file.abs), file.abs);
      this.writeWcc(w, dirBefore, dir.abs, safeStat(dir.abs), dir.abs);
    } catch (e) {
      w.u32(errnoToNfs(e.code));
      this.writePostOpAttr(w, fileSt, file.abs);
      this.writeWcc(w, dirBefore, dir.abs, null, null);
    }
    return w;
  }

  // 16/17 READDIR / READDIRPLUS
  nfsReaddir(r, w, plus) {
    const dirFh = r.opaque();
    const cookie = r.u64();
    r.fixed(8); // cookieverf（忽略，用固定值）
    const countBytes = r.u32();                 // READDIR: 应答总预算
    const dirCountBytes = plus ? r.u32() : 0;   // READDIRPLUS: 名字区预算
    /* RFC1813：maxcount=整个应答的字节上限，dircount=仅 fileid+name+cookie
       名字部分的上限；二者是约束关系，不能相加。 */
    const maxBytes = plus ? dirCountBytes : countBytes;
    const maxTotal = plus ? countBytes : countBytes;
    const dir = this.resolveFh(dirFh, false);
    if (dir.error) { w.u32(dir.error); this.writePostOpAttr(w, null, null); return w; }
    const dirSt = safeStat(dir.abs);
    if (!dirSt) { w.u32(NFS3ERR_NOENT); this.writePostOpAttr(w, null, null); return w; }
    if (!dirSt.isDirectory()) { w.u32(NFS3ERR_NOTDIR); this.writePostOpAttr(w, dirSt, dir.abs); return w; }
    let names;
    try {
      names = fs.readdirSync(dir.abs)
        .filter((n) => n !== '.' && n !== '..')
        /* 系统内部目录对 NFS 客户端不可见（Web/DAV 层同样隐藏）；
           旧实现会列出它们但 GETATTR 又拒绝，客户端只看到一串 ???? 条目。 */
        .filter((n) => n !== '.recycle' && n !== '.versions' && n !== '.snapshots');
    }
    catch (e) { w.u32(errnoToNfs(e.code)); this.writePostOpAttr(w, dirSt, dir.abs); return w; }

    /* cookie = 该条目自己的索引+2；续传请求带最后收到的 cookie，
       返回的是它**之后**的条目。 */
    let startIdx = (cookie <= 1) ? 0 : (cookie - 1);
    if (startIdx < 0) startIdx = 0;
    const total = names.length;
    const returned = names.slice(startIdx);
    const user = this._nfsUser;

    /* fileid 与 fattr3.fileid 保持同一算法（abs 的 md5 高 4 字节，低 32 位），
       且 READDIRPLUS 内核会校验 entry.fileid == fattr.fileid。 */
    const fileIdOf = (abs) => {
      const h = crypto.createHash('md5').update(abs).digest();
      return [0, h.readUInt32BE(0)];
    };

    /* dirlist3 是 XDR 链表：post_op_attr + cookieverf，
       然后每个条目以「是否还有下一条」的 bool 结尾，**没有 count**，
       链表结束后再跟一个 eof bool。 */
    w.u32(0);
    this.writePostOpAttr(w, dirSt, dir.abs);
    w.fixed(COOKIEVERF, 8);     // cookieverf

    /* 尊重客户端字节预算（dircount+maxcount / count）：旧实现一次返回全部，
       大目录超出内核初始缓冲会被整批丢弃，客户端只看到空目录。
       先计算每条大小、决定本批切片，再按 XDR 链表输出；eof=false 时
       客户端用最后一条的 cookie 续读。 */
    const HEADER_RESERVE = 128;
    let budget = Math.max(256, maxTotal - HEADER_RESERVE);
    let nameBudget = plus ? Math.max(64, maxBytes - 32) : budget;
    const prepared = [];
    let acc = 0, nameAcc = 0;
    for (let j = 0; j < returned.length; j++) {
      const i = startIdx + j;
      const name = returned[j];
      const cRel = childRel(dir.rel, name);
      const t = this.srv.resolveTarget({ disk: dir.disk, path: cRel }, user);
      const st = (t.error) ? null : safeStat(t.abs);
      const fhBuf = t.error ? null : packFh(dir.disk, cRel);
      const abs = t.error ? null : t.abs;
      const nameBytes = Buffer.byteLength(name, 'utf8');
      const nameBlock = 8 + (4 + nameBytes + ((4 - nameBytes % 4) % 4)) + 8; // fileid+name+cookie
      let need = nameBlock + 4; // +nextentry bool
      if (plus) need += (4 + 84) + (4 + (fhBuf ? fhBuf.length + ((4 - fhBuf.length % 4) % 4) : 0));
      if (prepared.length > 0 && (acc + need > budget || nameAcc + nameBlock > nameBudget)) break;
      prepared.push({ name, st, fhBuf, abs, need });
      acc += need; nameAcc += nameBlock;
    }
    const endIdx = startIdx + prepared.length; // 已覆盖到的条目边界（exclusive）
    const eof = endIdx >= total;

    w.bool(prepared.length > 0); // 链表头指针
    for (let k = 0; k < prepared.length; k++) {
      const e = prepared[k];
      const cookie = (startIdx + k) + 2;
      w.u64(fileIdOf(e.abs || path.join(dir.abs, e.name)));
      w.str(e.name);
      w.u64(cookie);
      if (plus) {
        this.writePostOpAttr(w, e.st, e.abs || path.join(dir.abs, e.name));
        this.writePostOpFh(w, e.fhBuf);
      }
      w.bool(k < prepared.length - 1); // nextentry 链表指针
    }
    w.bool(eof);
    return w;
  }

  // 18 FSSTAT
  nfsFsstat(r, w) {
    const fhBuf = r.opaque();
    const res = this.resolveFh(fhBuf, false);
    if (res.error) { w.u32(res.error); return w; }
    const st = safeStat(res.abs);
    if (!st) { w.u32(NFS3ERR_NOENT); return w; }
    let fsInfo = null;
    try { fsInfo = fs.statfsSync(res.root); } catch {}
    w.u32(0);
    this.writePostOpAttr(w, st, res.abs);
    if (fsInfo) {
      const b = fsInfo.bsize;
      w.u64(fsInfo.blocks * b);
      w.u64(fsInfo.bfree * b);
      w.u64(fsInfo.bavail * b);
    } else {
      w.u64(0); w.u64(0); w.u64(0);
    }
    w.u64(0); w.u64(0); w.u64(0); // tfiles/ffiles/afiles（近似填 0）
    w.u32(0);                     // invarsec
    return w;
  }

  // 19 FSINFO
  nfsFsinfo(r, w) {
    const fhBuf = r.opaque();
    const res = this.resolveFh(fhBuf, false);
    if (res.error) { w.u32(res.error); return w; }
    const st = safeStat(res.abs);
    if (!st) { w.u32(NFS3ERR_NOENT); return w; }
    const MB = 1024 * 1024;
    w.u32(0);
    this.writePostOpAttr(w, st, res.abs);
    w.u32(MB);  // rtmax
    w.u32(MB);  // rtpref
    w.u32(4096); // rtmult
    w.u32(MB);  // wtmax
    w.u32(MB);  // wtpref
    w.u32(4096); // wtmult
    w.u32(4096); // dtpref
    w.u64(0, 0x200000); // maxfilesize（2TB，低位）
    w.u32(1); w.u32(0); // time_delta = 1s
    // properties：HOMOGENEOUS(0x0008) | LINK(0x0001)；不声明 CANSETTIME（set_it=0）
    w.u32(0x0009);
    return w;
  }

  // 20 PATHCONF
  nfsPathconf(r, w) {
    const fhBuf = r.opaque();
    const res = this.resolveFh(fhBuf, false);
    if (res.error) { w.u32(res.error); return w; }
    const st = safeStat(res.abs);
    if (!st) { w.u32(NFS3ERR_NOENT); return w; }
    w.u32(0);
    this.writePostOpAttr(w, st, res.abs);
    w.u32(0);     // linkmax
    w.u32(255);   // name_max
    w.u32(1);     // no_trunc
    w.u32(0);     // chown_restricted
    w.u32(0);     // case_insensitive
    w.u32(1);     // case_preserving
    return w;
  }

  // 21 COMMIT（写已同步落盘，直接回成功）
  nfsCommit(r, w) {
    const fhBuf = r.opaque();
    r.u64(); r.u32(); // offset / count（忽略）
    const res = this.resolveFh(fhBuf, false);
    if (res.error) { w.u32(res.error); this.writeWcc(w, null, null, null, null); return w; }
    const before = safeStat(res.abs);
    const after = safeStat(res.abs);
    w.u32(0);
    this.writeWcc(w, before, res.abs, after, res.abs);
    w.fixed(WRITEVERF, 8);
    return w;
  }

  /* ===================================================================
   * MOUNT v3 分发（program 100005）
   * =================================================================== */
  dispatchMount(proc, args) {
    const r = new XdrReader(args);
    const w = new XdrWriter();
    switch (proc) {
      case 0: return w;                         // NULL
      case 1: return this.mountMnt(r, w);
      case 2: return this.mountDump(r, w);
      case 3: return w;                         // UMNT（void）
      case 4: return w;                         // UMNTALL（void）
      case 5: return this.mountExport(r, w);
      default: return null;                     // PROC_UNAVAIL
    }
  }

  /** 把导出路径映射为 disk 标识；/ext 映射到第一块在线外置盘 */
  _exportToDisk(dirpath) {
    if (dirpath === '/public') return { disk: 'public' };
    if (dirpath === '/private') return { disk: 'private' };
    if (dirpath === '/ext') {
      const exts = this.srv.scanExternal();
      if (!exts.length) return null; // 离线 → MNT 失败
      return { disk: exts[0].id };
    }
    return undefined; // 未知导出
  }

  // 1 MNT
  mountMnt(r, w) {
    let dirpath = r.str();
    if (dirpath.length > 1 && dirpath.endsWith('/')) dirpath = dirpath.slice(0, -1);
    const m = this._exportToDisk(dirpath);
    if (m === undefined) { w.u32(2); w.u32(2); return w; } // 未知导出 → denied
    if (m === null) { w.u32(2); w.u32(2); return w; }        // /ext 离线 → ENOENT/denied
    const fh = packFh(m.disk, '');
    w.u32(0);              // MNT_OK
    w.opaque(fh);          // fhandle3
    w.u32(2);              // auth_flavors 数量
    w.u32(AUTH_NULL);
    w.u32(AUTH_SYS);
    return w;
  }

  // 2 DUMP（未跟踪挂载，返回空列表）
  mountDump(r, w) {
    w.u32(0); // mlist 数量 = 0
    return w;
  }

  // 5 EXPORT（固定返回 /public /private /ext 三条）
  mountExport(r, w) {
    const exports = ['/public', '/private', '/ext'];
    w.u32(exports.length);
    for (const e of exports) {
      w.str(e);          // ex_dir
      w.bool(true);      // ex_groups 存在
      w.str('*');        // groupnode: 通配（所有主机）
      w.bool(false);     // gr_next = null
    }
    return w;
  }
}

module.exports = { NfsServer, packFh, unpackFh, XdrWriter, XdrReader };

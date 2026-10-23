'use strict';

/* =====================================================================
   lib/ftp.js — FTP 服务器（虚拟多盘根目录，映射到 FileServer 的盘符体系）
   端口   : 控制连接 listen(port=2121, pasvMin=4021, pasvMax=4040, host)
   数据   : 仅 PASV 被动模式（端口范围内取用，用完即关；每连接同时只占一个）
   根目录 : 虚拟多盘 —— / 下列出该用户可见盘（公共 / 私人 / 4T，与 dav 层命名一致）
   匿名   : anonymous / 任意密码 = 游客（user=null，只见公共盘、只读）
   命令   : USER PASS SYST FEAT OPTS PWD TYPE PASV EPSV PORT LIST NLST MLSD
            CWD CDUP RETR STOR DELE MKD RMD RNFR RNTO SIZE MDTM QUIT NOOP REST
   编码   : 控制连接每命令一行响应（UTF-8）；TYPE I/A 统一按二进制传原字节
   零依赖 : 仅 Node 内置模块；类在 require 时不产生任何副作用

   安全基线（本次加固）
   ------------------------------------------------------------------
   ① 写操作一律带 _write:true —— 原先 STOR/DELE/MKD/RMD/RNTO 走的
      resolveTarget 没有 _write，于是"只读外置盘"的拦截被绕过（DAV/S3 有带）。
   ② USER 切换身份时清空上一身份的全部状态（cwd/renameFrom/数据通道/
      断点偏移/传输类型）—— 否则新身份会继承上一身份的路径与待办操作。
   ③ 登录失败计数 + 锁定 + 尝试频率闸 —— FTP 明文口令且 USER/PASS 可无限重试，
      没有节流就能暴力爆破（scrypt 校验的算力成本落在服务端）。
   ④ FEAT 只通告**已实现**的能力（原通告 STREAM / MLST，两者都没实现，
      客户端按 FEAT 选了却拿不到预期行为）。
   ===================================================================== */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { RequestLimiter } = require('./ratelimit');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TB = 1099511627776; // 2^40，外置盘按容量命名（4T）与 dav 层一致
const PASV_WAIT_MS = 15000;   // 等待客户端连入被动数据通道的超时
const CMD_BUF_MAX = 8192;     // 控制连接单行上限（防恶意超长行）
const IDLE_TIMEOUT_MS = 600000; // 控制连接空闲超时 10 分钟
/* 登录节流：尝试频率闸（固定窗口，超限直接拒，不排队） */
const LOGIN_RATE_WINDOW_MS = 10000; // 10 秒一个窗口
const LOGIN_RATE_MAX = 20;          // 每 IP 每窗口最多 20 次登录尝试
/* 为什么要留到 20：同一个 NAT 出口后面可能有几十个用户同时登录，
   阈值太低会把正常用户挡掉；而 10 秒 20 次 = 2 次/秒 的持续速率
   对暴力破解来说依然低到没有意义（真正兜底的是下面的失败锁定）。 */
const LOGIN_RATE_MAX_IPS = 4096;    // 跟踪的 IP 数上限（防伪造海量 IP 撑爆内存）
/* 登录节流：失败计数与锁定 */
const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000; // 5 分钟窗口
const LOGIN_FAIL_MAX = 10;                  // 窗口内最多 10 次失败
const LOGIN_LOCK_MS = 5 * 60 * 1000;        // 超限后锁定 5 分钟

/* ---------- 小工具 ---------- */
function pad2(n) { return String(n).padStart(2, '0'); }

/** LIST 行的日期列：半年内 'MMM DD HH:MM'，更早 'MMM DD  YYYY' */
function ftpDate(ms) {
  const d = new Date(ms);
  const md = MONTHS[d.getMonth()] + ' ' + pad2(d.getDate());
  if (Math.abs(Date.now() - ms) < 182 * 86400e3) {
    return md + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  return md + '  ' + d.getFullYear();
}

/** MDTM / MLSD 的 modify 时间戳（UTC）：YYYYMMDDHHMMSS */
function ftpTimestamp(ms) {
  const d = new Date(ms);
  return '' + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
    + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds());
}

/** 取本机非 internal 的 IPv4（被动模式通告 IP） */
function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const netInf of ifaces[name] || []) {
      if (netInf.family === 'IPv4' && !netInf.internal) return netInf.address;
    }
  }
  return null;
}

/* ---------- FTP 服务器主体 ---------- */
class FtpServer {
  /** @param {import('../server')} srv FileServer 实例 */
  constructor(srv) {
    this.srv = srv;
    this.server = null;        // 控制连接监听
    this.sessions = new Set(); // 全部活跃会话（close 时统一清理）
    this.pasvMin = 4021;
    this.pasvMax = 4040;
    this.host = '0.0.0.0';
    this.port = 2121;
    /* 登录节流状态（按 IP） */
    this.loginRate = new Map();    // ip → { start, n }：尝试频率闸（固定窗口）
    this.loginFails = new RequestLimiter({   // 失败计数（滑动窗口）
      windowMs: LOGIN_FAIL_WINDOW_MS, max: LOGIN_FAIL_MAX, maxClients: 4096,
    });
    this.loginLock = new Map();   // ip → 锁定截止时间戳
  }

  /**
   * 启动监听（显式调用，require 无副作用；端口必须 >1024，无 root 环境）
   * @returns {Promise<net.Server>}
   */
  listen(port = 2121, pasvMin = 4021, pasvMax = 4040, host = '0.0.0.0') {
    if (!(port > 1024)) return Promise.reject(new Error('FTP 端口必须 >1024（无 root 环境）'));
    if (!(pasvMin > 1024 && pasvMax > 1024 && pasvMax >= pasvMin)) {
      return Promise.reject(new Error('被动端口范围必须 >1024 且 max >= min'));
    }
    this.port = port;
    this.pasvMin = pasvMin;
    this.pasvMax = pasvMax;
    this.host = host;
    return new Promise((resolve, reject) => {
      const s = net.createServer((sock) => this.onConnect(sock));
      s.once('error', reject);
      s.listen(port, host, () => {
        this.server = s;
        console.log(`  [FTP] ftp://${lanIp() || host}:${port}（被动端口 ${pasvMin}-${pasvMax}）`);
        resolve(s);
      });
    });
  }

  /** 停止服务并清理全部会话与数据连接 */
  close() {
    for (const sess of [...this.sessions]) {
      try { sess.sock.destroy(); } catch { /* ignore */ }
      this.sessionCleanup(sess);
    }
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
    }
    this.loginRate.clear();
    this.loginLock.clear();
    try { this.loginFails.reset(); } catch { /* ignore */ }
  }

  /* ============ 控制连接 ============ */

  onConnect(sock) {
    const sess = {
      sock,
      user: null,        // FileServer 用户对象；游客为 null
      anon: false,       // 匿名（游客）标记
      pendingName: '',   // USER 后待 PASS 校验的用户名
      cwd: '/',          // 虚拟当前目录
      type: 'I',         // 传输类型（I/A 都按二进制处理）
      renameFrom: null,  // RNFR 暂存 {vpath, r}
      restOffset: 0,     // REST 断点偏移（RETR/STOR 用后即清）
      dataSock: null,    // 当前被动数据连接
      pasvServer: null,  // 本次 PASV 的监听
      dataResolve: null, // takeData 等待者
      dataTimer: null,
      buf: '',
      closed: false,
    };
    this.sessions.add(sess);
    sock.setNoDelay(true);
    sock.setTimeout(IDLE_TIMEOUT_MS, () => {
      try { sock.write('421 idle timeout, closing\r\n'); } catch { /* ignore */ }
      sock.end();
    });
    sock.on('data', (chunk) => this.onControlData(sess, chunk));
    sock.on('error', () => { /* 客户端异常断开 */ });
    sock.on('close', () => this.sessionCleanup(sess));
    this.reply(sess, 220, 'NAS FTP server ready');
  }

  onControlData(sess, chunk) {
    sess.buf += chunk.toString('utf8');
    if (sess.buf.length > CMD_BUF_MAX) { sess.buf = ''; try { sess.sock.destroy(); } catch { /* ignore */ } return; }
    let idx;
    while ((idx = sess.buf.indexOf('\r\n')) >= 0) {
      const line = sess.buf.slice(0, idx);
      sess.buf = sess.buf.slice(idx + 2);
      this.dispatch(sess, line);
      if (sess.closed) return;
    }
  }

  reply(sess, code, text) {
    if (sess.closed) return;
    try { sess.sock.write(code + ' ' + text + '\r\n'); } catch { /* closed */ }
  }

  sessionCleanup(sess) {
    if (sess.closed) return;
    sess.closed = true;
    this.releaseData(sess);
    this.sessions.delete(sess);
  }

  /* ============ 命令分派 ============ */

  dispatch(sess, line) {
    const sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).trim().toUpperCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
    try {
      switch (cmd) {
        case 'USER':  return this.cmdUser(sess, arg);
        case 'PASS':  return this.cmdPass(sess, arg);
        case 'SYST':  return this.reply(sess, 215, 'UNIX Type: L8');
        case 'FEAT':  return this.cmdFeat(sess);
        case 'OPTS':  return this.reply(sess, /^OPTS\s+UTF8\s+ON$/i.test(cmd + ' ' + arg) ? 200 : 200, 'OK');
        case 'PWD':
        case 'XPWD':  return this.reply(sess, 257, '"' + sess.cwd.replace(/"/g, '""') + '" is the current directory');
        case 'TYPE':  return this.reply(sess, 200, 'Type set to ' + (arg || 'I')); // I/A 都按二进制
        case 'PASV':  return this.cmdPasv(sess);
        case 'EPSV':  return this.reply(sess, 522, 'Network protocol not supported, use PASV');
        case 'PORT':  return this.reply(sess, 501, 'Active mode not supported, use PASV');
        case 'LIST':  return this.cmdList(sess, arg, 'list').catch((e) => this.listFail(sess, e));
        case 'NLST':  return this.cmdList(sess, arg, 'nlst').catch((e) => this.listFail(sess, e));
        case 'MLSD':  return this.cmdList(sess, arg, 'mlsd').catch((e) => this.listFail(sess, e));
        case 'CWD':   return this.cmdCwd(sess, arg);
        case 'CDUP':  return this.cmdCwd(sess, '..');
        case 'RETR':  return this.cmdRetr(sess, arg);
        case 'STOR':  return this.cmdStor(sess, arg, 'w');
        case 'APPE':  return this.cmdStor(sess, arg, 'a'); // 追加 = REST 的便捷形式
        case 'DELE':  return this.cmdDelete(sess, arg);
        case 'MKD':
        case 'XMKD':  return this.cmdMkd(sess, arg);
        case 'RMD':
        case 'XRMD':  return this.cmdRmd(sess, arg);
        case 'RNFR':  return this.cmdRnfr(sess, arg);
        case 'RNTO':  return this.cmdRnto(sess, arg);
        case 'SIZE':  return this.cmdSize(sess, arg);
        case 'MDTM':  return this.cmdMdtm(sess, arg);
        case 'REST':  {
          const n = parseInt(arg, 10);
          if (!Number.isFinite(n) || n < 0) return this.reply(sess, 501, 'Invalid restart offset');
          sess.restOffset = n;
          return this.reply(sess, 350, 'Restarting at ' + n + '. Send STORE or RETRIEVE.');
        }
        case 'NOOP':  return this.reply(sess, 200, 'NOOP ok');
        case 'QUIT':
          this.reply(sess, 221, 'Goodbye');
          sess.closed = true; // 先置位避免 cleanup 抢先
          try { sess.sock.end(); } catch { /* ignore */ }
          this.releaseData(sess);
          this.sessions.delete(sess);
          return;
        case 'HELP':  return this.reply(sess, 214,
          /* 只列**已实现**的命令；EPSV/PORT 未实现（分别回 522/501），不列 */
          'USER PASS SYST FEAT OPTS PWD TYPE PASV LIST NLST MLSD CWD CDUP RETR STOR APPE DELE MKD RMD RNFR RNTO SIZE MDTM REST NOOP QUIT');
        default:      return this.reply(sess, 502, 'Command not implemented: ' + cmd);
      }
    } catch (err) {
      console.error('[ftp]', cmd, err);
      this.reply(sess, 451, 'Requested action aborted: local error');
    }
  }

  listFail(sess) {
    this.reply(sess, 451, 'Listing failed');
    this.releaseData(sess);
  }

  /* ============ 认证 ============ */

  /**
   * 登录尝试频率闸（按 IP 的固定窗口计数器）。
   * 为什么不用 TokenBucket.take()：它会**排队等待**，攻击者可以在一条连接上
   * 连发几百条 PASS，把等待队列撑大（内存放大）。这里改成"超限直接拒绝"。
   * @returns {boolean} true = 允许这次尝试
   */
  loginRateOk(ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    let st = this.loginRate.get(key);
    if (!st || now - st.start >= LOGIN_RATE_WINDOW_MS) {
      st = { start: now, n: 0 };
      this.loginRate.set(key, st);
      this.pruneLoginRate(now);
    }
    st.n++;
    return st.n <= LOGIN_RATE_MAX;
  }

  /** 清理过期的频率闸条目（同时给内存封顶） */
  pruneLoginRate(now) {
    if (this.loginRate.size <= LOGIN_RATE_MAX_IPS) {
      for (const [k, v] of this.loginRate) {
        if (now - v.start >= LOGIN_RATE_WINDOW_MS) this.loginRate.delete(k);
      }
      return;
    }
    /* 条目过多：先删过期项，还多就删最早的一半 */
    for (const [k, v] of this.loginRate) {
      if (now - v.start >= LOGIN_RATE_WINDOW_MS) this.loginRate.delete(k);
    }
    while (this.loginRate.size > LOGIN_RATE_MAX_IPS) {
      const first = this.loginRate.keys().next();
      if (first.done) break;
      this.loginRate.delete(first.value);
    }
  }

  /** 该 IP 是否处于登录锁定期；返回剩余毫秒（0 = 未锁定） */
  loginLocked(ip) {
    const key = String(ip || 'unknown');
    const until = this.loginLock.get(key);
    if (!until) return 0;
    if (until > Date.now()) return until - Date.now();
    this.loginLock.delete(key);
    try { this.loginFails.reset(key); } catch { /* ignore */ }
    return 0;
  }

  /** 记一次登录失败；超阈值则锁定该 IP，返回剩余锁定毫秒 */
  noteLoginFail(ip) {
    const key = String(ip || 'unknown');
    const r = this.loginFails.check(key);
    if (!r.ok) {
      const until = Date.now() + LOGIN_LOCK_MS;
      this.loginLock.set(key, until);
      return LOGIN_LOCK_MS;
    }
    return 0;
  }

  /**
   * USER：切换身份。
   *
   * ⚠️ 切换身份必须**清空上一身份的全部状态**，否则新身份会继承旧身份的
   * 路径与待办操作（典型攻击：先用 guest 身份 CWD 到某目录，再 USER 成
   * 另一个账号，RNFR/RNTO 就带着旧身份的相对路径去改新身份能改的地方）。
   * 要清的状态：cwd（虚拟当前目录）、renameFrom（RNFR 暂存）、
   * restOffset（断点续传偏移）、type（传输类型）、
   * 以及数据通道相关（dataSock/pasvServer/dataResolve/dataTimer）。
   */
  cmdUser(sess, name) {
    /* ① 断开上一身份遗留的数据通道（否则新身份会往旧连接发数据） */
    this.releaseData(sess);
    /* ② 清空上一身份的状态 */
    sess.user = null;
    sess.anon = false;
    sess.cwd = '/';
    sess.renameFrom = null;
    sess.restOffset = 0;
    sess.type = 'I';
    sess.dataSock = null;
    sess.pasvServer = null;
    sess.dataResolve = null;
    sess.dataTimer = null;
    /* ③ 记下新身份 */
    sess.pendingName = String(name || '').trim();
    if (/^anonymous$/i.test(sess.pendingName)) return this.reply(sess, 331, 'Anonymous login, send any password');
    if (!sess.pendingName) return this.reply(sess, 501, '需要用户名');
    return this.reply(sess, 331, 'Password required for ' + sess.pendingName);
  }

  cmdPass(sess, pass) {
    if (!sess.pendingName) return this.reply(sess, 503, 'Login with USER first');
    const ip = sess.sock.remoteAddress;
    /* ① 暴力破解锁定：同 IP 短时间内失败超阈值 → 直接拒，不再消耗 scrypt 算力 */
    const locked = this.loginLocked(ip);
    if (locked > 0) {
      return this.reply(sess, 530, 'Too many failed logins, try again in '
        + Math.ceil(locked / 1000) + ' seconds');
    }
    /* ② 尝试频率闸：即便还没失败过，疯狂重试也要挡住（挡住的是 CPU） */
    if (!this.loginRateOk(ip)) {
      return this.reply(sess, 421, 'Too many login attempts, try again later');
    }
    if (/^anonymous$/i.test(sess.pendingName)) {
      /* 匿名 = 游客（user=null），只见公共盘、只读 */
      sess.anon = true;
      sess.user = null;
      sess.cwd = '/';
      sess.pendingName = '';
      this.srv.audit({ userObj: null, action: 'ftp-login', detail: 'anonymous', ip: sess.sock.remoteAddress });
      return this.reply(sess, 230, 'Logged in as anonymous (read-only guest)');
    }
    const u = this.srv.users.verify(sess.pendingName, pass);
    if (!u) {
      this.noteLoginFail(ip);
      return this.reply(sess, 530, 'Login incorrect');
    }
    sess.user = u;
    sess.cwd = '/';
    sess.pendingName = '';   // 已登录：清掉待校验用户名，避免再发一条 PASS 就能换人
    try { this.loginFails.reset(ip); } catch { /* ignore */ }
    this.srv.audit({ userObj: u, action: 'ftp-login', ip: sess.sock.remoteAddress });
    return this.reply(sess, 230, 'User ' + u.username + ' logged in');
  }

  /**
   * FEAT：只通告**真正实现**的能力。
   * 原先通告了 STREAM（RFC 3659）与 MLST，但两者都没实现 ——
   * 客户端按 FEAT 协商后拿不到预期行为（要么报错要么静默降级）。
   * 现在只列：UTF8 / REST（断点续传）/ MLSD（机器可读目录）/ SIZE / MDTM / PASV。
   * EPSV、PORT 未实现（分别回 522 / 501），APPE 不是 FEAT 关键字，均不在此通告。
   */
  cmdFeat(sess) {
    const feats = [
      '211-Features:',
      ' UTF8',
      ' REST',
      ' MLSD',
      ' SIZE',
      ' MDTM',
      ' PASV',
      '211 End',
    ];
    if (sess.closed) return;
    try { sess.sock.write(feats.join('\r\n') + '\r\n'); } catch { /* closed */ }
  }

  /* ============ 虚拟路径解析 ============ */

  /** 词法规范化（处理 . / ..，不做磁盘访问）：相对路径基于 cwd */
  normalizeV(cwd, p) {
    let full = String(p || '');
    if (!full.startsWith('/')) full = (cwd === '/' ? '/' : cwd + '/') + full;
    const out = [];
    for (const seg of full.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return '/' + out.join('/');
  }

  /** 展示名 → listDisks 里的盘对象（命名规则与 dav 层一致） */
  findDisk(sess, name) {
    const disks = this.srv.listDisks(sess.user);
    if (name === '公共') return disks.find((d) => d.id === 'public') || null;
    if (name === '私人') return disks.find((d) => d.id === 'private') || null;
    if (name === 'public' || name === 'private') return disks.find((d) => d.id === name) || null;
    if (name.startsWith('ext:')) return disks.find((d) => d.id === name) || null;
    let m = /^ext-(.+)$/.exec(name);
    if (m) return disks.find((d) => d.id === 'ext:' + m[1]) || null;
    m = /^(\d+(?:\.\d+)?)T$/i.exec(name); // 4T → 按容量匹配外置盘
    if (m) {
      const want = parseFloat(m[1]);
      return disks.find((d) => d.id.startsWith('ext:') && Math.round((d.quota || 0) / TB) === want) || null;
    }
    /* 用户自定义显示名（data/disk-labels.json 里的卷标）也要能反查 —— 与 dav 层一致。
       走 findDiskByTitle（查缓存表），不要为此再调一次 scanExternal()。 */
    const t = this.srv.findDiskByTitle ? this.srv.findDiskByTitle(name) : null;
    if (t) return disks.find((d) => d.id === t) || null;
    return null;
  }

  /**
   * 虚拟路径 → {root:true} | {vpath, diskObj, rel, t} | {error}
   *
   * @param {boolean} [write] 是否是写操作。写操作必须带 _write:true ——
   *        resolveTarget 只有在 _write 为真时才检查"该外置硬盘为只读"，
   *        不带就会绕过只读盘的保护（DAV 与 S3 都带）。
   */
  resolveVPath(sess, vpath, write) {
    const np = this.normalizeV(sess.cwd, vpath);
    if (np === '/') return { root: true, vpath: np };
    const slash = np.indexOf('/', 1);
    const diskName = slash < 0 ? np.slice(1) : np.slice(1, slash);
    const rel = slash < 0 ? '' : np.slice(slash + 1);
    const diskObj = this.findDisk(sess, diskName);
    if (!diskObj) return { error: '盘符不存在或不可见' };
    const t = this.srv.resolveTarget(
      { disk: diskObj.id, path: rel, _write: write === true }, sess.user);
    if (t.error) return { error: t.error };
    return { vpath: np, diskObj, rel, t };
  }

  /** 盘符展示名（供根目录 LIST）：公共 / 私人 / 自定义卷标 / 4T（回退 ext-UUID） */
  diskDisplayName(d, usedNames) {
    let nm;
    if (d.id === 'public') nm = '公共';
    else if (d.id === 'private') nm = '私人';
    /* 用户设定的显示名优先（data/disk-labels.json，通常是磁盘真实卷标） */
    else if (d.title) nm = d.title;
    else {
      const tb = (d.quota || 0) / TB;
      nm = tb >= 0.5 ? Math.round(tb) + 'T' : 'ext-' + d.id.slice(4);
    }
    if (usedNames.has(nm)) nm += '-' + d.id.slice(-4); // 同名多盘去重
    usedNames.add(nm);
    return nm;
  }

  guestWriteDenied(sess) {
    // 匿名会话 user=null，所有写操作一律 550
    return !sess.user;
  }

  /* ============ 被动数据通道 ============ */

  cmdPasv(sess) {
    this.releaseData(sess); // 每连接同一时间只占一个数据通道
    const ip = lanIp();
    if (!ip) return this.reply(sess, 425, '无法确定本机局域网 IP');

    const tryListen = (p) => new Promise((resolve) => {
      const listener = net.createServer();
      let settled = false;
      listener.once('error', () => { if (!settled) { settled = true; resolve(null); } });
      listener.listen(p, this.host, () => { if (!settled) { settled = true; resolve(listener); } });
    });

    (async () => {
      let listener = null, port = 0;
      for (let p = this.pasvMin; p <= this.pasvMax; p++) {
        listener = await tryListen(p);
        if (listener) { port = p; break; }
      }
      if (!listener) return this.reply(sess, 425, '被动端口范围内无可用端口');
      if (sess.closed) { try { listener.close(); } catch { /* ignore */ } return; }

      sess.pasvServer = listener;
      listener.on('connection', (dsock) => {
        /* R3-8（P2）：PASV 数据连接必须来自控制连接同一 IP ——
           否则第三方可在端口窗口期内抢先连入数据通道，劫持/注入传输内容。 */
        const norm = (a) => String(a || '').replace(/^::ffff:/, '');
        const ctrlIp = norm(sess.sock && sess.sock.remoteAddress);
        if (ctrlIp && dsock.remoteAddress && norm(dsock.remoteAddress) !== ctrlIp) {
          try { dsock.destroy(); } catch { /* ignore */ }
          return;
        }
        if (sess.dataSock) { try { dsock.destroy(); } catch { /* ignore */ } return; } // 多余连接直接关
        sess.dataSock = dsock;
        dsock.setTimeout(0);
        dsock.on('error', () => { /* 数据连接错误由传输方处理 */ });
        dsock.on('close', () => {
          if (sess.dataSock === dsock) sess.dataSock = null;
          if (sess.dataResolve) {
            const r = sess.dataResolve;
            sess.dataResolve = null;
            r(null);
          }
        });
        if (sess.dataResolve) {
          const r = sess.dataResolve;
          sess.dataResolve = null;
          r(dsock);
        }
      });

      const parts = ip.split('.').map(Number);
      this.reply(sess, 227,
        'Entering Passive Mode (' + parts.join(',') + ',' + Math.floor(port / 256) + ',' + (port % 256) + ')');
    })();
  }

  /** 取一条已建立（或 15s 内到达）的被动数据连接；无监听/超时返回 null */
  takeData(sess) {
    return new Promise((resolve) => {
      if (sess.dataSock) return resolve(sess.dataSock);
      if (!sess.pasvServer) return resolve(null);
      sess.dataResolve = resolve;
      sess.dataTimer = setTimeout(() => {
        if (sess.dataResolve === resolve) {
          sess.dataResolve = null;
          resolve(null);
        }
      }, PASV_WAIT_MS);
    });
  }

  /** 传输结束后清理数据通道（socket + 被动监听 + 等待定时器） */
  releaseData(sess) {
    if (sess.dataTimer) { clearTimeout(sess.dataTimer); sess.dataTimer = null; }
    sess.dataResolve = null;
    if (sess.dataSock) { try { sess.dataSock.destroy(); } catch { /* ignore */ } sess.dataSock = null; }
    if (sess.pasvServer) {
      try { sess.pasvServer.close(); } catch { /* ignore */ }
      sess.pasvServer = null;
    }
  }

  /* ============ 目录列举（LIST / NLST / MLSD） ============ */

  listLine(sess, name, st, mode) {
    const isDir = !st || st.isDirectory();
    if (mode === 'nlst') return name;
    if (mode === 'mlsd') {
      const facts = 'type=' + (isDir ? 'dir' : 'file')
        + ';size=' + (isDir ? 0 : st.size)
        + ';modify=' + ftpTimestamp(st ? st.mtimeMs : Date.now()) + ';';
      return facts + ' ' + name;
    }
    /* Unix 风格：-rw-r--r--   1 ftp  ftp   12345 Sep 09 12:34 name */
    const perm = isDir ? 'drwxr-xr-x' : '-rw-r--r--';
    const size = isDir ? 0 : st.size;
    return perm + '   1 ftp      ftp      ' + String(size).padStart(12) + ' ' + ftpDate(st ? st.mtimeMs : Date.now()) + ' ' + name;
  }

  async cmdList(sess, arg, mode) {
    /* 剥离 "LIST -la /path" 之类的选项标志 */
    let target = String(arg || '').replace(/^-\w+\s*/, '');
    const r = this.resolveVPath(sess, target || sess.cwd);
    if (r.error) return this.reply(sess, 550, r.error);

    const lines = [];
    if (r.root) {
      /* 虚拟根：列出该用户可见盘（目录名与 dav 层一致） */
      const used = new Set();
      for (const d of this.srv.listDisks(sess.user)) {
        const nm = this.diskDisplayName(d, used);
        lines.push(this.listLine(sess, nm, null, mode === 'list' ? 'list' : 'mlsd-dir'));
        if (mode === 'mlsd') lines[lines.length - 1] = 'type=dir;size=0;modify=' + ftpTimestamp(Date.now()) + '; ' + nm;
        else if (mode === 'list') lines[lines.length - 1] = 'drwxr-xr-x   1 ftp      ftp      ' + String(0).padStart(12) + ' ' + ftpDate(Date.now()) + ' ' + nm;
      }
    } else {
      let st;
      try { st = fs.statSync(r.t.abs); } catch { return this.reply(sess, 550, '路径不存在'); }
      if (st.isFile()) {
        lines.push(this.listLine(sess, path.basename(r.vpath), st, mode === 'mlsd' ? 'mlsd' : mode));
      } else if (st.isDirectory()) {
        let names = [];
        try { names = fs.readdirSync(r.t.abs); } catch { return this.reply(sess, 550, '目录不可读'); }
        for (const name of names) {
          // 隐藏系统条目与临时文件不进 FTP 列表（.recycle/.versions/.davtmp-/.s3part-）
          if (/^\./.test(name) || /\.davtmp-/.test(name) || /\.s3part-/.test(name) || /\.s3tmp-/.test(name)) continue;
          let st2;
          try { st2 = fs.statSync(path.join(r.t.abs, name)); } catch { continue; }
          lines.push(this.listLine(sess, name, st2, mode === 'mlsd' ? 'mlsd' : mode));
        }
      } else {
        return this.reply(sess, 550, '不是目录');
      }
    }

    const dsock = await this.takeData(sess);
    if (!dsock) return this.reply(sess, 425, '未建立数据连接（先 PASV）');
    this.reply(sess, 150, 'Opening BINARY mode data connection for file list');
    let done = false;
    dsock.on('error', () => { if (!done) { done = true; this.reply(sess, 426, '数据连接中断'); this.releaseData(sess); } });
    dsock.end(lines.join('\r\n') + (lines.length ? '\r\n' : ''), () => {
      if (!done) {
        done = true;
        this.reply(sess, 226, lines.length + ' entries sent');
        this.releaseData(sess);
      }
    });
  }

  /* ============ 目录导航 ============ */

  cmdCwd(sess, arg) {
    const r = this.resolveVPath(sess, arg || '/');
    if (r.error) return this.reply(sess, 550, r.error);
    if (r.root) { sess.cwd = '/'; return this.reply(sess, 250, 'Directory changed to /'); }
    let st;
    try { st = fs.statSync(r.t.abs); } catch { return this.reply(sess, 550, '路径不存在'); }
    if (!st.isDirectory()) return this.reply(sess, 550, '不是目录');
    sess.cwd = r.vpath;
    return this.reply(sess, 250, 'Directory changed to ' + r.vpath);
  }

  /* ============ 下载（RETR，支持 REST 断点续传） ============ */

  async cmdRetr(sess, arg) {
    if (!arg) return this.reply(sess, 501, '需要文件路径');
    const r = this.resolveVPath(sess, arg);
    if (r.error || r.root) return this.reply(sess, 550, '路径不存在');
    let st;
    try { st = fs.statSync(r.t.abs); } catch { return this.reply(sess, 550, '文件不存在'); }
    if (!st.isFile()) return this.reply(sess, 550, '不是文件');

    const dsock = await this.takeData(sess);
    if (!dsock) return this.reply(sess, 425, '未建立数据连接（先 PASV）');

    const start = Math.min(sess.restOffset, st.size); // 断点续传：从 REST 偏移流式读取
    sess.restOffset = 0;
    this.reply(sess, 150, 'Opening BINARY mode data connection for ' + path.basename(r.vpath));

    let done = false;
    const fin = (code, text) => {
      if (done) return;
      done = true;
      this.reply(sess, code, text);
      this.releaseData(sess);
    };
    const rs = fs.createReadStream(r.t.abs, { start });
    rs.on('error', () => { try { dsock.destroy(); } catch { /* ignore */ } fin(451, '读取失败'); });
    dsock.on('error', () => { try { rs.destroy(); } catch { /* ignore */ } fin(426, '数据连接中断'); });
    dsock.on('close', () => { if (!done) { try { rs.destroy(); } catch { /* ignore */ } fin(426, '数据连接中断'); } });
    rs.on('end', () => { dsock.end(); }); // pipe 会自动结束 dsock，end 事件兜底
    rs.pipe(dsock);
    dsock.on('finish', () => fin(226, 'Transfer complete'));
    this.srv.audit({ userObj: sess.user, action: 'ftp-retr', disk: r.t.disk, path: r.rel, ip: sess.sock.remoteAddress });
  }

  /* ============ 上传（STOR，支持 REST 断点续传；匿名 550） ============ */

  async cmdStor(sess, arg, mode) {
    if (!arg) return this.reply(sess, 501, '需要文件路径');
    if (this.guestWriteDenied(sess)) return this.reply(sess, 550, '匿名只读，禁止上传');
    const r = this.resolveVPath(sess, arg, true);
    if (r.error || r.root) return this.reply(sess, 550, r.error || '不能写在根目录');

    const dsock = await this.takeData(sess);
    if (!dsock) return this.reply(sess, 425, '未建立数据连接（先 PASV）');

    const offset = mode === 'a' ? (() => { try { return fs.statSync(r.t.abs).size; } catch { return 0; } })() : sess.restOffset;
    sess.restOffset = 0;
    try { fs.mkdirSync(path.dirname(r.t.abs), { recursive: true }); } catch { /* 打开时再报错 */ }

    // REST>0 时需以 r+ 在指定偏移续写（文件必须已存在）
    let ws;
    try {
      ws = fs.createWriteStream(r.t.abs, { flags: offset > 0 ? 'r+' : 'w', start: offset });
    } catch (e) {
      this.releaseData(sess);
      return this.reply(sess, 550, '无法打开文件: ' + e.message);
    }
    this.reply(sess, 150, 'Opening BINARY mode data connection for ' + path.basename(r.vpath));

    let done = false;
    const fin = (code, text) => {
      if (done) return;
      done = true;
      this.reply(sess, code, text);
      this.releaseData(sess);
    };
    ws.on('error', () => { try { dsock.destroy(); } catch { /* ignore */ } fin(451, '写入失败'); });
    dsock.on('error', () => { try { ws.destroy(); } catch { /* ignore */ } fin(426, '数据连接中断'); });
    dsock.on('close', () => { if (!done) { try { ws.destroy(); } catch { /* ignore */ } fin(426, '数据连接中断'); } });
    dsock.pipe(ws);
    ws.on('finish', () => {
      this.srv.invalidateSizeCache();
      this.srv.audit({ userObj: sess.user, action: 'ftp-stor', disk: r.t.disk, path: r.rel, ip: sess.sock.remoteAddress });
      fin(226, 'Transfer complete');
    });
  }

  /* ============ 文件/目录操作（写操作匿名一律 550） ============ */

  cmdDelete(sess, arg) {
    if (!arg) return this.reply(sess, 501, '需要文件路径');
    if (this.guestWriteDenied(sess)) return this.reply(sess, 550, '匿名只读，禁止删除');
    const r = this.resolveVPath(sess, arg, true);
    if (r.error || r.root) return this.reply(sess, 550, r.error || '路径不存在');
    let st;
    try { st = fs.statSync(r.t.abs); } catch { return this.reply(sess, 550, '文件不存在'); }
    if (!st.isFile()) return this.reply(sess, 550, '不是文件');
    try { fs.unlinkSync(r.t.abs); } catch (e) { return this.reply(sess, 550, '删除失败: ' + e.message); }
    this.srv.invalidateSizeCache();
    this.srv.audit({ userObj: sess.user, action: 'ftp-delete', disk: r.t.disk, path: r.rel, ip: sess.sock.remoteAddress });
    return this.reply(sess, 250, 'File deleted');
  }

  cmdMkd(sess, arg) {
    if (!arg) return this.reply(sess, 501, '需要目录名');
    if (this.guestWriteDenied(sess)) return this.reply(sess, 550, '匿名只读，禁止创建');
    const r = this.resolveVPath(sess, arg, true);
    if (r.error || r.root) return this.reply(sess, 550, r.error || '路径非法');
    try {
      fs.mkdirSync(r.t.abs, { recursive: true });
    } catch (e) {
      return this.reply(sess, 550, '创建失败: ' + e.message);
    }
    this.srv.invalidateSizeCache();
    this.srv.audit({ userObj: sess.user, action: 'ftp-mkdir', disk: r.t.disk, path: r.rel, ip: sess.sock.remoteAddress });
    return this.reply(sess, 257, '"' + r.vpath.replace(/"/g, '""') + '" created');
  }

  cmdRmd(sess, arg) {
    if (!arg) return this.reply(sess, 501, '需要目录名');
    if (this.guestWriteDenied(sess)) return this.reply(sess, 550, '匿名只读，禁止删除');
    const r = this.resolveVPath(sess, arg, true);
    if (r.error || r.root) return this.reply(sess, 550, r.error || '不能删除盘根');
    try { fs.rmdirSync(r.t.abs); } catch (e) { return this.reply(sess, 550, '删除失败（目录必须为空）: ' + e.message); }
    this.srv.invalidateSizeCache();
    this.srv.audit({ userObj: sess.user, action: 'ftp-rmdir', disk: r.t.disk, path: r.rel, ip: sess.sock.remoteAddress });
    return this.reply(sess, 250, 'Directory removed');
  }

  cmdRnfr(sess, arg) {
    if (!arg) return this.reply(sess, 501, '需要源路径');
    if (this.guestWriteDenied(sess)) return this.reply(sess, 550, '匿名只读，禁止重命名');
    const r = this.resolveVPath(sess, arg, true);
    if (r.error || r.root) return this.reply(sess, 550, r.error || '路径不存在');
    if (!fs.existsSync(r.t.abs)) return this.reply(sess, 550, '路径不存在');
    sess.renameFrom = r;
    return this.reply(sess, 350, 'Ready for RNTO');
  }

  cmdRnto(sess, arg) {
    if (!sess.renameFrom) return this.reply(sess, 503, 'RNFR required first');
    if (!arg) { sess.renameFrom = null; return this.reply(sess, 501, '需要目标路径'); }
    const src = sess.renameFrom;
    sess.renameFrom = null;
    const dst = this.resolveVPath(sess, arg, true);
    if (dst.error || dst.root) return this.reply(sess, 550, dst.error || '目标路径非法');
    try { fs.renameSync(src.t.abs, dst.t.abs); } catch (e) { return this.reply(sess, 550, '重命名失败: ' + e.message); }
    this.srv.invalidateSizeCache();
    this.srv.audit({
      userObj: sess.user, action: 'ftp-rename', disk: dst.t.disk, path: dst.rel,
      ip: sess.sock.remoteAddress, detail: 'from ' + src.vpath,
    });
    return this.reply(sess, 250, 'Rename successful');
  }

  cmdSize(sess, arg) {
    if (!arg) return this.reply(sess, 501, '需要文件路径');
    const r = this.resolveVPath(sess, arg);
    if (r.error || r.root) return this.reply(sess, 550, r.error || '路径不存在');
    let st;
    try { st = fs.statSync(r.t.abs); } catch { return this.reply(sess, 550, '文件不存在'); }
    if (!st.isFile()) return this.reply(sess, 550, '不是文件'); // SIZE 仅对文件有意义
    return this.reply(sess, 213, String(st.size));
  }

  cmdMdtm(sess, arg) {
    if (!arg) return this.reply(sess, 501, '需要文件路径');
    const r = this.resolveVPath(sess, arg);
    if (r.error || r.root) return this.reply(sess, 550, r.error || '路径不存在');
    let st;
    try { st = fs.statSync(r.t.abs); } catch { return this.reply(sess, 550, '文件不存在'); }
    return this.reply(sess, 213, ftpTimestamp(st.mtimeMs));
  }
}

module.exports = { FtpServer };

/* =====================================================================
   自测：node lib/ftp.js 直接跑（也可 require 后调用 selftest()）
   ---------------------------------------------------------------------
   覆盖：
     1. USER 切换身份 → 上一身份的状态被彻底清空（P1-8 核心场景）
     2. 写操作带 _write:true，读操作不带（P1-7）
     3. 登录失败计数 → 锁定；尝试频率闸生效（P1-9）
     4. FEAT 只通告已实现的能力（P1-10）
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

  /* --- 替身 srv：记录 resolveTarget 的入参，便于验证 _write 是否带上 --- */
  const resolveCalls = [];
  const srv = {
    users: {
      verify: (name, pass) => (name === 'bob' && pass === 'pw' ? { username: 'bob', role: 'user' } : null),
    },
    audit() { },
    invalidateSizeCache() { },
    listDisks: () => [{ id: 'public', name: '公共盘', quota: 0 }],
    findDiskByTitle: () => null,
    resolveTarget(q) {
      resolveCalls.push(q);
      if (q._write && q.disk === 'ro') return { error: '该外置硬盘为只读', code: 403 };
      return { abs: '/tmp/' + (q.path || ''), root: '/tmp', disk: q.disk, scope: q.disk };
    },
  };
  const ftp = new FtpServer(srv);
  const out = [];
  const mkSess = (over) => Object.assign({
    sock: { write: (s) => { out.push(String(s).trim()); }, remoteAddress: '10.0.0.9' },
    user: null, anon: false, pendingName: '', cwd: '/', type: 'I',
    renameFrom: null, restOffset: 0, dataSock: null, pasvServer: null,
    dataResolve: null, dataTimer: null, buf: '', closed: false,
  }, over || {});

  /* --- 1. USER 切换身份清空上一身份状态 --- */
  {
    let destroyed = false;
    const sess = mkSess({
      user: { username: 'alice' }, anon: false, pendingName: 'alice',
      cwd: '/公共/私密', type: 'A', renameFrom: { vpath: '/公共/x' }, restOffset: 4096,
      dataSock: { destroy() { destroyed = true; } },
      pasvServer: { close() { destroyed = true; } },
      dataResolve: () => { }, dataTimer: { unref() { } },
    });
    ftp.cmdUser(sess, 'bob');
    t('USER 后 user 被清空', sess.user, 'null');
    t('USER 后 anon 被清空', sess.anon, 'false');
    t('USER 后 cwd 复位到根', sess.cwd, '/');
    t('USER 后 renameFrom 被清空', sess.renameFrom, 'null');
    t('USER 后 restOffset 复位', sess.restOffset, '0');
    t('USER 后 type 复位', sess.type, 'I');
    t('USER 后 dataSock 被清空', sess.dataSock, 'null');
    t('USER 后 pasvServer 被清空', sess.pasvServer, 'null');
    t('USER 后 dataResolve 被清空', sess.dataResolve, 'null');
    t('USER 后 dataTimer 被清空', sess.dataTimer, 'null');
    t('USER 后 pendingName 记为新用户', sess.pendingName, 'bob');
    tbool('USER 时旧数据通道被释放', destroyed);
  }

  /* --- 1b. 切换身份后旧身份不能继续用 RNFR 改名 --- */
  {
    const sess = mkSess({ renameFrom: { vpath: '/公共/x', t: { abs: '/tmp/x' } } });
    ftp.cmdUser(sess, 'bob');
    out.length = 0;
    ftp.cmdRnto(sess, '/公共/y');
    tbool('切换身份后 RNTO 无源可改（503）', out.join(' ').indexOf('503') >= 0);
  }

  /* --- 2. 写操作带 _write:true --- */
  {
    resolveCalls.length = 0;
    const sess = mkSess({ user: { username: 'bob' } });
    ftp.cmdMkd(sess, '/公共/newdir');
    t('MKD 走 resolveTarget 时带 _write', resolveCalls.length ? resolveCalls[0]._write : 'none', 'true');
    resolveCalls.length = 0;
    ftp.cmdSize(sess, '/公共/f.txt');
    t('SIZE（读操作）不带 _write', resolveCalls.length ? resolveCalls[0]._write : 'none', 'false');
    resolveCalls.length = 0;
    ftp.cmdDelete(sess, '/公共/f.txt');
    t('DELE 带 _write', resolveCalls.length ? resolveCalls[0]._write : 'none', 'true');
    resolveCalls.length = 0;
    ftp.cmdRnfr(sess, '/公共/f.txt');
    t('RNFR 带 _write', resolveCalls.length ? resolveCalls[0]._write : 'none', 'true');
  }

  /* --- 3. 登录节流 --- */
  {
    /* 3a. 失败计数超阈值 → 锁定（直接驱动计数器：自测里不必等 10 秒窗口） */
    const ftp2 = new FtpServer(srv);
    for (let i = 0; i < 11; i++) ftp2.noteLoginFail('10.0.0.9');
    const sess = mkSess({});
    out.length = 0;
    ftp2.cmdUser(sess, 'bob');
    ftp2.cmdPass(sess, 'pw');
    tbool('失败超阈值后进入锁定期（正确口令也被拒）', /Too many failed logins/.test(out.join(' ')));

    /* 3b. 锁定只针对该 IP，其它 IP 不受影响 */
    const ftp2b = new FtpServer(srv);
    for (let i = 0; i < 11; i++) ftp2b.noteLoginFail('10.0.0.9');
    const sessB = mkSess({ sock: { write: (s) => { out.push(String(s).trim()); }, remoteAddress: '10.0.0.55' } });
    out.length = 0;
    ftp2b.cmdUser(sessB, 'bob');
    ftp2b.cmdPass(sessB, 'pw');
    tbool('锁定只影响该 IP，其它 IP 正常登录', /230/.test(out.join(' ')));

    /* 3c. 频率闸：同一 IP 短时间内连续尝试，超出窗口配额就被挡（挡的是 CPU）
       这里用**正确**口令，避免先撞上失败锁定（那属于 3a 的场景） */
    const ftp3 = new FtpServer(srv);
    const sess3 = mkSess({ sock: { write: (s) => { out.push(String(s).trim()); }, remoteAddress: '10.0.0.77' } });
    let rateBlocked = false;
    for (let i = 0; i < 40; i++) {
      out.length = 0;
      ftp3.cmdUser(sess3, 'bob');
      ftp3.cmdPass(sess3, 'pw');
      if (/Too many login attempts/.test(out.join(' '))) { rateBlocked = true; break; }
    }
    tbool('登录尝试频率闸生效', rateBlocked);

    /* 3d. 正常登录仍然可用 */
    const ftp4 = new FtpServer(srv);
    const sess4 = mkSess({});
    out.length = 0;
    ftp4.cmdUser(sess4, 'bob');
    ftp4.cmdPass(sess4, 'pw');
    tbool('正确口令可正常登录', /230/.test(out.join(' ')));
    t('登录后 pendingName 清空', sess4.pendingName, '');
  }

  /* --- 4. FEAT 只通告已实现的能力 --- */
  {
    const sess = mkSess({});
    out.length = 0;
    ftp.cmdFeat(sess);
    const feat = out.join('\n');
    tbool('FEAT 不通告 STREAM（未实现）', feat.indexOf('STREAM') < 0);
    tbool('FEAT 不通告 MLST（未实现）', feat.indexOf('MLST') < 0);
    tbool('FEAT 通告 MLSD（已实现）', feat.indexOf('MLSD') >= 0);
    tbool('FEAT 通告 REST（已实现）', feat.indexOf('REST') >= 0);
    tbool('FEAT 通告 SIZE/MDTM/PASV/UTF8', /SIZE/.test(feat) && /MDTM/.test(feat) && /PASV/.test(feat) && /UTF8/.test(feat));
    tbool('FEAT 以 211 End 收尾', /211 End/.test(feat));
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

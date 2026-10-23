'use strict';

/* =====================================================================
   lib/monitor.js — 手机资源监控（Android/Termux，无 root）
   数据源：/proc/stat、/proc/meminfo、/proc/net/dev、/proc/loadavg、
           /proc/uptime、/sys/class/thermal、/sys/class/power_supply
   约定：
     - sample()  带差值计算（CPU 占用、网速），两次采样间隔 <500ms 直接返回上次
     - snapshot() 无差值即时量（负载/运行时长/温度/电池）+ CPU 占用（跨平台）
     - 全部 try/catch 容错：字段读不到一律给 null（温度给空数组）
     - 零依赖，require 无副作用
   ===================================================================== */

const fs = require('fs');
const os = require('os');

/* =====================================================================
   平台能力判定 —— **按数据源实测可用性，不按平台名猜**（2026-09-16 重写）

   踩过的坑：原先写 `IS_LINUX = process.platform === 'linux'`，用它决定
   「有没有负载 / 有没有网速」。但**这台部署目标（Redmi K50 / Termux）的
   `process.platform` 是 `'android'`，不是 `'linux'`** —— 判定直接为 false，
   于是手机上健康页 CPU 一片「—」，而后端明明有能力拿到数据。
   （断言里写 `platform==='linux'` 的测试全在 PC 上绿，正好掩盖了它。）

   实测各数据源的真实可用性：

     数据源             Android(SELinux)   Windows     真 Linux
     /proc/loadavg      ✗ EACCES           ✗ 不存在     ✓
     /proc/stat         ✗ EACCES           ✗ 不存在     ✓
     /proc/net/dev      ✗ EACCES           ✗ 不存在     ✓
     /proc/meminfo      ✓ 可读             ✗ 不存在     ✓
     os.loadavg()       ✓ **真实值**       ✗ 恒 [0,0,0] ✓
     os.cpus()          ✗ **空数组**       ✓ 可用       ✓

   所以三个平台各有各的路，必须分别探测：
     · 负载类：/proc/loadavg 可读 → 用它；否则 os.loadavg() 非全零 → 用它
     · 占用率：/proc/stat 可读 → 差值；否则 os.cpus() 非空 → 差值
     · 网速：只有 /proc/net/dev 一条路（Node 无跨平台网卡字节计数 API）
   ===================================================================== */

/** /proc/loadavg 是否可读（Android 上被 SELinux 拒，读得到才是真 Linux） */
function probeLoadavgFile() {
  const raw = readText('/proc/loadavg');
  if (!raw) return false;
  const parts = raw.trim().split(/\s+/).slice(0, 3).map(Number);
  return parts.length === 3 && parts.every((n) => !Number.isNaN(n));
}

/** os.loadavg() 是否有真实值 —— Windows 恒返回 [0,0,0]，全零视为不可用 */
function probeOsLoadavg() {
  try {
    const la = os.loadavg();
    if (!Array.isArray(la) || la.length < 3) return false;
    return la.some((n) => Number.isFinite(n) && n > 0);
  } catch { return false; }
}

/** os.cpus() 是否给出了可用的 times（Android/Termux 上返回空数组） */
function probeOsCpus() {
  try {
    const cs = os.cpus();
    if (!Array.isArray(cs) || !cs.length) return false;
    return !!(cs[0] && cs[0].times);
  } catch { return false; }
}

/** /proc/net/dev 是否可读（唯一能拿网卡字节计数的来源） */
function probeNetFile() {
  const raw = readText('/proc/net/dev');
  return !!raw && /:\s*\d/.test(raw);
}

/** 读文本文件，失败返回 null（/proc、/sys 节点在部分系统上不存在） */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/* 能力表：模块加载时探测一次（这些能力在进程生命周期内不会变）。
   判定逻辑单独抽成 computeCapability()，好在测试里喂三平台矩阵 ——
   真实环境的探测结果只反映「跑测试的这台机器」，覆盖不到 Android 场景。 */
function computeCapability(p) {
  return {
    platform: p.platform,
    loadavgFile: !!p.loadavgFile,   // /proc/loadavg 可读（真 Linux）
    loadavgOs: !!p.loadavgOs,       // os.loadavg() 有非零值（Android；Windows 全零 → false）
    cpusOs: !!p.cpusOs,             // os.cpus() 有 times（Android 空数组 → false）
    netFile: !!p.netFile,           // /proc/net/dev 可读（唯一网速来源）

    /* 「系统负载」是否可用：/proc/loadavg 或 os.loadavg() 任一能走就行。
       ⚠️ **绝不能用 `platform === 'linux'` 判定** —— Android 的 platform 是
          'android'，一刀切会把真实可用的 os.loadavg() 丢掉（实测手机上它返回
          [10.98, 10.63, 10.5]，是货真价实的负载），健康页就成「不支持」了。 */
    get loadSupported() { return this.loadavgFile || this.loadavgOs; },
    /* 「CPU 占用率」是否可用：/proc/stat 差值 或 os.cpus() 差值。
       注意 Android 上**两条都不通**（前者 EACCES、后者空数组），
       所以 android 的 cpuSupported 就是 false —— 这是诚实的结果，
       此时前端改显 loadSupported 提供的负载值。 */
    get cpuSupported() { return this.loadavgFile || this.cpusOs; },
    /* 网速可用性：Node 没有任何跨平台网卡字节计数 API，只有 /proc/net/dev 一条路 */
    get netSupported() { return this.netFile; },
  };
}

const CAP = computeCapability({
  platform: process.platform,
  loadavgFile: probeLoadavgFile(),
  loadavgOs: probeOsLoadavg(),
  cpusOs: probeOsCpus(),
  netFile: probeNetFile(),
});

class Monitor {
  constructor() {
    this.lastSample = null;   // 上次 sample() 完整结果（间隔过短时复用）
    this.lastSampleTs = 0;
    this.lastCpu = null;      // 上次 /proc/stat 首行 cpu 各列数值
    this.lastCpuTs = 0;
    this.lastNet = null;      // 上次网卡累计字节数 { rx, tx }
    this.lastNetTs = 0;
    /* ---- 跨平台 CPU 占用基线（见 _cpuUsedPct 注释）----
       **每个消费方一份**，键是调用方给的名字（'health' / 'station' / 'sample'）。
       为什么不能共用一份：/api/health 与 /api/station 是两条独立的请求流，
       各自刷新基线会把对方的采样窗口打碎 —— 实测现象是两个端点互相踩，
       谁都在 500ms 窗口内被对方重置，cpuUsedPct **恒为 null**，
       也就是修完仍然显示不出来（这是真踩到的坑，不是理论担忧）。 */
    this._cpuStates = new Map();

    /* ---- 基线预热：让每个已知 key 的基线始终"热" ----
       差值法要求两次采样间隔 ≥500ms，所以**任何 key 的第一次访问必然拿不到值**
       （只能返回 null → 前端显示「采样中…」）。低频端点更糟：
       /api/monitor 是用户手点刷新，两次间隔可能几分钟，永远攒不出基线。
       解决办法是后台每 2 秒静默推一次所有 key 的基线，
       这样无论请求何时到来，都有 ≤2s 的新鲜参照，第一次就能出数。
       定时器 unref() —— 不阻止进程正常退出。 */
    this._cpuStates.set('health', { base: this._cpuTotals(), baseTs: Date.now(), last: null });
    this._cpuStates.set('sample', { base: this._cpuTotals(), baseTs: Date.now(), last: null });
    this._cpuStates.set('snapshot', { base: this._cpuTotals(), baseTs: Date.now(), last: null });
    try {
      const t = setInterval(() => {
        /* 只刷新**已存在**的 key，不无中生有 —— 避免为一次性调用方长期占内存 */
        for (const [k, st] of this._cpuStates) {
          try { this._cpuUsedPct(k); } catch { /* 单次失败不影响其它 key */ }
        }
      }, 2000);
      if (t && typeof t.unref === 'function') t.unref();
      this._cpuWarmTimer = t;
    } catch { /* 环境不支持定时器：退化为按需采样，功能不受影响 */ }
  }

  /* 取某个消费方的基线状态，没有就现建一份（并在建时立刻采一次基线） */
  _cpuState(key) {
    let st = this._cpuStates.get(key);
    if (!st) {
      st = { base: this._cpuTotals(), baseTs: Date.now(), last: null };
      this._cpuStates.set(key, st);
    }
    return st;
  }

  /* ---------- /proc/loadavg：0.52 0.58 0.59 1/467 12345 → [0.52, 0.58, 0.59] ---------- */
  _readLoadavgFile() {
    const raw = readText('/proc/loadavg');
    if (!raw) return null;
    const parts = raw.trim().split(/\s+/).slice(0, 3).map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
    return parts;
  }

  /* ---------- CPU 累计计数聚合：返回 { idle, total } ----------
   * （jiffies 累积计数，单位不重要 —— 只看两次采样的差值。）
   *
   * ⚠️ 取数口必须**按能力择优**，不能想当然用 os.cpus()：
   *    · Android/Termux：os.cpus() 返回**空数组** → 这条路彻底不通
   *    · Windows/macOS：没有 /proc/stat → 只能走 os.cpus()
   *    · 真 Linux：两条都能走，优先 /proc/stat（口径与 loadavg 一致）
   * 返回 null 表示「本平台确实拿不到」，调用方据此兜底。 */
  _cpuTotals() {
    /* 优先 /proc/stat（真 Linux）：格式与 _cpuTimes() 一致，一列都不少 */
    if (CAP.loadavgFile) {
      const cols = this._cpuTimes();
      if (cols && cols.length > 4) {
        let total = 0;
        for (const n of cols) total += n;
        const idle = (cols[3] || 0) + (cols[4] || 0);   // idle + iowait
        if (total > 0) return { idle, total };
      }
    }
    /* 回退 os.cpus()（Windows/macOS，以及真 Linux 上 /proc/stat 临时读不到时） */
    if (!CAP.cpusOs) return null;
    try {
      let idle = 0, total = 0;
      for (const c of os.cpus()) {
        for (const k in c.times) {
          total += c.times[k];
          if (k === 'idle') idle += c.times[k];
        }
      }
      return total > 0 ? { idle, total } : null;
    } catch { return null; }
  }

  /* ---------- 跨平台 CPU 占用率（%）----------
   * 为什么需要它：Windows / macOS 上没有 /proc/stat，_cpuTimes() 恒 null，
   * monitor.cpuPct 于是恒为 null → 前端渲染成「—」。
   *
   * ⚠️ 为什么不用 os.loadavg()：**Windows 上 Node 的 os.loadavg() 恒返回 [0,0,0]**
   *    （不是「负载为空」，是明确的三个零）。前端把 0 当 falsy，
   *    照样渲染成「—」。所以负载这条路在 Windows 上根本走不通，只能算占用率。
   *
   * 差值法：隔一段时间取两次累计计数，usage = (1 - Δidle / Δtotal) * 100。
   * 本方法是**有状态**的（每次调用推进基线），因此只在 snapshot() 里被调一次。
   *
   * 采样窗口：必须 ≥ 500ms。窗口太短时只要有一个 tick 的抖动，
   * Δidle/Δtotal 就会贴近 1 或 0，算出 0% / 100% 这种假数据 ——
   * 而 **0 是 falsy，前端又会渲染回「—」**，等于这次修复原地失败。
   * （实测：同一个毫秒内连调两次 snapshot()，曾在 Windows 上算出
   *  dTotal=1、used=0，正是这个坑。）
   *
   * 新鲜度保护：差值法的物理含义是「这段时间内 CPU 的平均占用率」——
   * 间隔越长结果越**平滑**（趋近长期均值），并不会失真。所以上限**不能太严**：
   * 像 /api/monitor（用户手点刷新）和 watchdog（5 分钟一次）这类低频端点，
   * 间隔天然远超 2 秒，窗口上限卡 2000ms 会让它们**永远**拿不到值，
   * 面板上恒显「采样中…」——等于白修（这是实测踩到的，不是理论担忧）。
   * 真正要防的是「基线陈旧到毫无意义」（如服务被挂起后 resume），
   * 故上限放到 15s，超过则重建基线、沿用上次结果。
   *
   * key：消费方标识。不同端点各留一份基线，互不干扰 ——
   * 共用一份的话，/api/station 的轮询会不断重置 /api/health 的采样窗口，
   * 实测结果是两边互相踩、cpuUsedPct 恒为 null（修完仍显示不出来）。 */
  _cpuUsedPct(key) {
    const now = Date.now();
    const st = this._cpuState(key || 'default');
    const cur = this._cpuTotals();
    if (!cur) return st.last;                   // 取不到计数（极罕见）：沿用上次
    const prev = st.base;
    const age = now - st.baseTs;
    if (!prev) {                                // 首次调用：建立基线，还没有上一样本
      st.base = cur;
      st.baseTs = now;
      return st.last;
    }
    /* 基线太陈旧（服务被挂起 / 长时间无请求）→ 重建基线，沿用上次结果。
       注意**不返回 null**：重建后下一次调用就能算出值。 */
    if (age > 15000) {
      st.base = cur;
      st.baseTs = now;
      return st.last;
    }
    /* 窗口太短算不准（一个 tick 的抖动会让 Δidle/Δtotal 贴近 1 或 0，
       算出 0% / 100% 这种假数据，而 0 是 falsy，前端又渲染回「—」）
       → 不推进基线，沿用上次结果。 */
    if (age < 500) return st.last;
    const dTotal = cur.total - prev.total;
    const dIdle = cur.idle - prev.idle;
    if (!(dTotal > 0)) return st.last;
    let used = (1 - dIdle / dTotal) * 100;
    if (!Number.isFinite(used)) return st.last;
    used = Math.min(100, Math.max(0, Math.round(used * 10) / 10));
    st.base = cur;
    st.baseTs = now;
    st.last = used;
    return used;
  }

  /* ---------- /proc/stat 首行：cpu user nice system idle iowait irq softirq steal ... ---------- */
  _cpuTimes() {
    const raw = readText('/proc/stat');
    if (!raw) return null;
    const first = raw.split('\n')[0] || '';
    if (!/^cpu\s/.test(first)) return null;
    const cols = first.trim().split(/\s+/).slice(1).map(Number);
    if (!cols.length || cols.some((n) => Number.isNaN(n))) return null;
    return cols;
  }

  /* ---------- /proc/net/dev：汇总各网卡收发字节（排除 lo 回环） ---------- */
  _netBytes() {
    const raw = readText('/proc/net/dev');
    if (!raw) return null;
    let rx = 0, tx = 0, found = false;
    for (const line of raw.split('\n').slice(2)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const name = line.slice(0, i).trim();
      if (!name || name === 'lo') continue;
      const cols = line.slice(i + 1).trim().split(/\s+/).map(Number);
      if (cols.length < 9) continue;
      rx += cols[0] || 0;   // receive bytes
      tx += cols[8] || 0;   // transmit bytes
      found = true;
    }
    return found ? { rx, tx } : null;
  }

  /* ---------- /proc/meminfo：MemTotal / MemAvailable ----------
   * ⚠️ 非 Linux（Windows / macOS）没有 /proc/meminfo，原先直接返回三个 null，
   * 前端就渲染成「内存 —」。回退到 Node 的 os.totalmem()/os.freemem()：
   * 口径与 /proc 略不同（free 比 available 保守，会显得占用偏高），
   * 但**有真实数字远好过一个破折号**，且这是跨平台唯一稳定来源。
   * Android 上 /proc/meminfo 可读，正常路径不受影响。 */
  _mem() {
    const out = { memUsedPct: null, memTotal: null, memAvailable: null };
    const raw = readText('/proc/meminfo');
    if (raw) {
      let total = null, avail = null;
      for (const line of raw.split('\n')) {
        let m = /^MemTotal:\s+(\d+)/.exec(line);
        if (m) total = Number(m[1]) * 1024;
        m = /^MemAvailable:\s+(\d+)/.exec(line);
        if (m) avail = Number(m[1]) * 1024;
      }
      if (total && avail != null) {
        out.memTotal = total;
        out.memAvailable = avail;
        out.memUsedPct = Math.round(((total - avail) / total) * 1000) / 10;
      }
      return out;
    }
    try {
      const total = os.totalmem();
      const free = os.freemem();
      if (total > 0) {
        out.memTotal = total;
        out.memAvailable = free;
        out.memUsedPct = Math.round(((total - free) / total) * 1000) / 10;
      }
    } catch { /* 保持 null */ }
    return out;
  }

  /* ---------- 无差值即时量：loadavg / CPU 占用 / uptime / 温度 / 电池 ----------
   * cpuKey：CPU 占用基线的消费方标识（默认 'snapshot'）。见 _cpuUsedPct()。
   *         /api/health 与 /api/station 必须传不同 key，否则互相踩窗口。 */
  snapshot(cpuKey) {
    const out = {
      loadavg: null, uptimeS: null, temps: [], battery: null,
      /* 跨平台能力字段（2026-09-16 起**按数据源实测可用性**给出，不按平台名猜）：
         cpuUsedPct    0-100 占用率。任何平台都可能为 null（首次无基线 / 本平台确实
                       没有可用计数源）。前端拿它当 loadavg 的回退显示源。
         loadSupported 「系统负载」是否可用。**注意别再用平台名判断** ——
                       Android 上 process.platform 是 'android' 而非 'linux'，
                       但 os.loadavg() 其实返回**真实值**（实测 [10.63, 10.55, 10.46]），
                       按平台名一刀切会让手机健康页明明是 Linux 内核却显示「不支持」。
         cpuSupported  占用率是否可用（/proc/stat 或 os.cpus() 至少一条通）。
         netSupported  网速是否可用：只有 /proc/net/dev 一条路，Node 没有跨平台
                       网卡字节计数 API（os.networkInterfaces() 只给地址不给流量）。
                       不可用时前端显示「当前环境不支持」而不是孤零零的「—」。 */
      cpuUsedPct: null, loadSupported: CAP.loadSupported,
      cpuSupported: CAP.cpuSupported, netSupported: CAP.netSupported,
      platform: CAP.platform,
    };

    /* 负载：优先 /proc/loadavg（真 Linux，格式 0.52 0.58 0.59 1/467 12345）；
       Android 上该文件被 SELinux 拒（EACCES），但 os.loadavg() 有真实值 → 用它。
       ⚠️ Windows 的 os.loadavg() 恒返回 [0,0,0]：**不是「负载为空」而是明确的三个零**，
          前端把 0 当 falsy 会渲染成「—」。所以全零**必须视为不可用**，
          由 probeOsLoadavg() 判掉，绝不能把 [0,0,0] 当数据返回。 */
    if (CAP.loadavgFile) {
      const parts = (this._readLoadavgFile() || []);
      if (parts.length === 3) out.loadavg = parts;
    }
    if (!out.loadavg && CAP.loadavgOs) {
      try {
        const la = os.loadavg().slice(0, 3).map((n) => Math.round(n * 100) / 100);
        if (la.length === 3 && la.some((n) => n > 0)) out.loadavg = la;
      } catch { /* 保持 null */ }
    }
    /* CPU 占用率：/proc/stat 或 os.cpus() 的差值（见 _cpuTotals 的能力择优）。
       两个计数源都没有时 _cpuTotals() 返回 null，这里会是 null —— 前端显示
       「当前环境不支持」而不是「采样中」，区分得开。 */
    try { out.cpuUsedPct = this._cpuUsedPct(cpuKey || 'snapshot'); } catch { /* 保持 null */ }

    // 运行时长（秒）：12345.67 23456.78
    const up = readText('/proc/uptime');
    if (up) {
      const v = parseFloat(up.split(/\s+/)[0]);
      if (!Number.isNaN(v)) out.uptimeS = v;
    }

    // 温度：/sys/class/thermal/thermal_zone*/temp（毫摄氏度 ÷1000）
    try {
      const zones = fs.readdirSync('/sys/class/thermal');
      for (const z of zones) {
        if (!/^thermal_zone\d+$/.test(z)) continue;
        const mv = parseFloat(readText('/sys/class/thermal/' + z + '/temp'));
        if (!Number.isNaN(mv)) out.temps.push({ zone: z, celsius: Math.round(mv / 10) / 100 });
      }
    } catch { out.temps = []; }

    // 电池：capacity（百分比）+ status（Charging/Discharging/Full/...）
    const cap = parseInt(readText('/sys/class/power_supply/battery/capacity'), 10);
    const status = (readText('/sys/class/power_supply/battery/status') || '').trim();
    if (!Number.isNaN(cap) || status) {
      out.battery = { capacity: Number.isNaN(cap) ? null : cap, status: status || null };
    }

    return out;
  }

  /* ---------- 采样：即时量 + 差值量合并 ---------- */
  async sample() {
    const now = Date.now();
    if (this.lastSample && now - this.lastSampleTs < 500) return this.lastSample;

    const result = {
      ts: now,
      cpuPct: null,        // 与上次差值计算的 CPU 占用（%），首次为 null
      memUsedPct: null, memTotal: null, memAvailable: null,
      netRxBps: null, netTxBps: null,   // 与上次差值计算的网速（字节/秒），首次为 null
      diskRx: null,        // 磁盘 IO 判定可略：Termux 无 root 读不到可靠块设备计数
      ...this.snapshot('sample'),
    };

    // CPU 占用：busy/(busy+idle) 列差值
    try {
      const cpu = this._cpuTimes();
      if (cpu) {
        if (this.lastCpu && now > this.lastCpuTs) {
          let busy = 0, idle = 0;
          for (const i of [0, 1, 2, 5, 6, 7]) busy += (cpu[i] || 0) - (this.lastCpu[i] || 0); // user nice system irq softirq steal
          for (const i of [3, 4]) idle += (cpu[i] || 0) - (this.lastCpu[i] || 0);             // idle iowait
          const total = busy + idle;
          if (total > 0) result.cpuPct = Math.round((busy / total) * 1000) / 10;
        }
        this.lastCpu = cpu;
        this.lastCpuTs = now;
      }
    } catch { /* 保持 null */ }

    // 网速：字节累计差值 / 时间差
    try {
      const net = this._netBytes();
      if (net) {
        if (this.lastNet && now > this.lastNetTs) {
          const dt = (now - this.lastNetTs) / 1000;
          result.netRxBps = Math.max(0, Math.round((net.rx - this.lastNet.rx) / dt));
          result.netTxBps = Math.max(0, Math.round((net.tx - this.lastNet.tx) / dt));
        }
        this.lastNet = net;
        this.lastNetTs = now;
      }
    } catch { /* 保持 null */ }

    // 内存
    try { Object.assign(result, this._mem()); } catch { /* 保持 null */ }

    this.lastSample = result;
    this.lastSampleTs = now;
    return result;
  }
}

module.exports = { Monitor, CAP, computeCapability };

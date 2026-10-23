'use strict';

/* =====================================================================
   lib/remote.js — 远程控制中枢（跨设备指令通道）
   v4 只在能力矩阵里「声明」了 cast/exec，却没有执行端 —— 这里把它补上。

   模型：A 设备下发指令 → 中枢排队 → B 设备（目标）通过 SSE 实时收到
        → 执行 → 回报结果。B 掉线时可用 /api/remote/inbox 轮询兜底。

   安全设计（三层门禁）：
     1) 目标必须**在线且已接入工作站**
     2) 动作用**白名单**（ACTIONS），且目标必须声明该动作所需**能力**
     3) exec 需要服务端显式开启（config.json → station.allowExec）
        且命令**首词白名单**（station.execAllow）

   指令生命周期：
     pending → delivered → acked → done | error | timeout | cancelled
   事件：remote.invoke / remote.ack / remote.result / remote.timeout
   落盘：<dataDir>/remote-log.json（保留最近 200 条，1.5s 合并写）
   零依赖。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PENDING = 200;          // 单目标待执行队列上限
const CMD_TTL_MS = 120 * 1000;    // 未收到回执即超时（2 分钟）
const HISTORY_KEEP = 200;         // 历史保留条数
const SAVE_DEBOUNCE_MS = 1500;
const MAX_ARGS_JSON = 8 * 1024;   // 参数体积上限

/* 动作白名单 -----------------------------------------------------------
   cap    : 目标设备必须具备的能力（'' = 无要求）
   label  : 中文名
   desc   : 说明
   ---------------------------------------------------------------------- */
const ACTIONS = {
  toast:         { cap: '',          label: '显示提示',   desc: '在目标设备弹出一条提示' },
  notify:        { cap: '',          label: '系统通知',   desc: '在目标设备发一条系统通知' },
  open_url:      { cap: 'preview',   label: '打开链接',   desc: '在目标设备浏览器打开一个网址' },
  open_path:     { cap: 'download',  label: '打开目录',   desc: '让目标设备跳转到工作站某个目录' },
  play_media:    { cap: 'preview',   label: '播放媒体',   desc: '在目标设备播放音视频' },
  clipboard_set: { cap: 'clipboard', label: '写入剪贴板', desc: '把一段文本写入目标设备剪贴板' },
  download:      { cap: 'download',  label: '推送文件',   desc: '让目标设备下载工作站上的一个文件' },
  cast:          { cap: 'cast',      label: '投屏播放',   desc: '让大屏设备播放指定内容' },
  exec:          { cap: 'exec',      label: '执行命令',   desc: '在目标设备执行 shell 命令（需服务端开启）' },
};

/* 需要 URL 的动作，且只允许 http/https（防 file:// 与 javascript:） */
const URL_ACTIONS = new Set(['open_url', 'play_media', 'cast']);

class Remote {
  constructor(srv) {
    this.srv = srv;
    this.file = path.join(srv.cfg.dataDir, 'remote-log.json');

    const st = (srv.cfg && srv.cfg.station) || {};
    this.execEnabled = !!st.allowExec;
    this.execAllow = Array.isArray(st.execAllow) && st.execAllow.length
      ? st.execAllow.map((x) => String(x))
      : ['ls', 'df', 'du', 'uptime', 'free', 'date', 'whoami', 'pwd', 'uname', 'ps'];

    this.pending = new Map();     // deviceId -> [cmd]（待该设备拉取）
    this.byId = new Map();        // id -> cmd（全部在途）
    this.history = [];            // 已结束（旧 → 新）
    this._seq = 0;
    this._timer = null;
    this._saveTimer = null;
    this._sentCount = 0;
    this._doneCount = 0;
    this._errCount = 0;
    this._load();
  }

  /* ------------------------------ 落盘 ------------------------------ */

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) this.history = raw.filter((x) => x && x.id).slice(-HISTORY_KEEP);
    } catch { /* 首次启动 */ }
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.history.slice(-HISTORY_KEEP), null, 2));
    } catch { /* 落盘失败不影响通道 */ }
  }

  /* ------------------------------ 下发 ------------------------------ */

  /**
   * 下发一条远程指令。
   * @param {object} o { target, action, args }
   * @param {object} actor { deviceId, deviceName, user }
   * @returns {{ok:boolean, cmd?:object, error?:string}}
   */
  send(o = {}, actor = {}) {
    const target = String(o.target || '').trim();
    const action = String(o.action || '').trim();

    if (!target) return { ok: false, error: '缺少目标设备' };
    if (!action) return { ok: false, error: '缺少动作' };
    if (target === actor.deviceId) return { ok: false, error: '不能给自己下发指令' };

    const presence = this.srv.presence;
    const dev = presence ? presence.get(target) : null;
    if (!dev) return { ok: false, error: '目标设备不存在（需先接入工作站）' };

    const now = Date.now();
    const online = !!dev.online && (now - (dev.lastSeen || 0) <= 90000);
    if (!online) return { ok: false, error: '目标设备不在线（' + (dev.name || target) + '）' };

    // 封禁设备不可被控制
    if (this.srv.pairing && this.srv.pairing.isBlocked(target)) {
      return { ok: false, error: '目标设备已被封禁' };
    }

    const def = ACTIONS[action];
    if (!def) {
      return { ok: false, error: '不支持的动作：' + action + '（可用：' + Object.keys(ACTIONS).join(' / ') + '）' };
    }

    // 能力门禁
    const caps = dev.capabilities || [];
    if (def.cap && !caps.includes(def.cap)) {
      return { ok: false, error: '目标设备未声明「' + def.cap + '」能力，无法执行「' + def.label + '」' };
    }

    /* 严格模式：未配对设备不接受远程指令
       R9：这里判的是「被控**目标**设备是否已配对」，不是「这次调用者是否可信」。
       调用者身份由 server.js 侧的 matchToken 单独校验；目标设备的令牌此刻拿不到，
       所以必须用只看名单的 isPaired()。若改用 isTrusted(target) 会因缺令牌恒为 false，
       开启严格模式后所有远程指令都会被拒。 */
    if (this.srv.pairing && this.srv.pairing.requirePairing && !this.srv.pairing.isPaired(target)) {
      return { ok: false, error: '目标设备未配对（严格模式已开启）' };
    }

    // 参数规范化与校验
    let args = o.args && typeof o.args === 'object' ? o.args : {};
    const v = this._validateArgs(action, args);
    if (!v.ok) return { ok: false, error: v.error };
    args = v.args;

    let json = '';
    try { json = JSON.stringify(args); } catch { return { ok: false, error: '参数无法序列化' }; }
    if (json.length > MAX_ARGS_JSON) return { ok: false, error: '参数过大（上限 8KB）' };

    // 队列上限
    const q = this.pending.get(target) || [];
    if (q.length >= MAX_PENDING) return { ok: false, error: '目标设备待执行指令过多，请稍后再试' };

    const cmd = {
      id: 'r' + (++this._seq).toString(36) + crypto.randomBytes(3).toString('hex'),
      target,
      targetName: dev.name || '',
      action,
      actionLabel: def.label,
      args,
      from: String(actor.deviceId || ''),
      fromName: String(actor.deviceName || ''),
      user: String(actor.user || ''),
      status: 'pending',
      createdAt: now,
      deliveredAt: 0,
      ackedAt: 0,
      endedAt: 0,
      error: '',
      result: null,
    };

    q.push(cmd);
    this.pending.set(target, q);
    this.byId.set(cmd.id, cmd);
    this._sentCount++;

    this._saveSoon();
    this._publish('remote.invoke', cmd);      // 目标设备 SSE 秒收

    if (this.srv.audit) {
      try {
        this.srv.audit({
          action: 'remote-send',
          detail: action + ' → ' + (dev.name || target) + ' ' + json.slice(0, 120),
          user: actor.user,
        });
      } catch { /* 审计失败不影响下发 */ }
    }
    return { ok: true, cmd };
  }

  /** 动作参数校验（返回规范化后的 args） */
  _validateArgs(action, args) {
    const a = { ...args };
    const str = (k, max) => String(a[k] == null ? '' : a[k]).slice(0, max || 500);
    const num = (k) => Number(a[k]) || 0;

    if (action === 'toast' || action === 'notify') {
      const text = str('text', 400);
      if (!text.trim()) return { ok: false, error: '缺少 args.text' };
      return { ok: true, args: { text, title: str('title', 80), level: str('level', 12) || 'info' } };
    }

    if (action === 'clipboard_set') {
      const text = String(a.text == null ? '' : a.text).slice(0, 8192);
      if (!text) return { ok: false, error: '缺少 args.text' };
      return { ok: true, args: { text } };
    }

    if (URL_ACTIONS.has(action)) {
      const url = str('url', 2000);
      if (!url) return { ok: false, error: '缺少 args.url' };
      if (!/^https?:\/\//i.test(url)) {
        // 允许工作站内部相对路径
        if (!url.startsWith('/')) return { ok: false, error: 'url 只允许 http/https 或站内相对路径' };
      }
      return { ok: true, args: { url, title: str('title', 120), autoplay: a.autoplay !== false } };
    }

    if (action === 'open_path') {
      return { ok: true, args: { disk: str('disk', 40) || 'public', path: str('path', 600) } };
    }

    if (action === 'download') {
      const p = str('path', 600);
      const url = str('url', 2000);
      if (!p && !url) return { ok: false, error: 'download 需要 args.path 或 args.url' };
      return {
        ok: true,
        args: {
          disk: str('disk', 40) || 'public',
          path: p,
          url,
          name: str('name', 200),
          size: num('size'),
        },
      };
    }

    if (action === 'exec') {
      if (!this.execEnabled) return { ok: false, error: '服务端未开启远程执行（config.json → station.allowExec）' };
      const cmd = String(a.cmd == null ? '' : a.cmd).slice(0, 500).trim();
      if (!cmd) return { ok: false, error: '缺少 args.cmd' };
      const base = cmd.split(/\s+/)[0];
      // 去掉可能的路径前缀，只看命令名
      const name = base.split(/[\\/]/).pop();
      if (!this.execAllow.includes(name)) {
        return { ok: false, error: '命令「' + name + '」不在服务端白名单内' };
      }
      if (/[;|&`$><\n]/.test(cmd)) {
        return { ok: false, error: '命令包含 shell 连接符，已拒绝' };
      }
      return { ok: true, args: { cmd } };
    }

    return { ok: true, args: a };
  }

  /* ------------------------------ 目标侧：拉取 / 回执 ------------------------------ */

  /** 目标设备拉取待执行指令（SSE 掉线时的轮询兜底） */
  inbox(deviceId, opt = {}) {
    const id = String(deviceId || '').trim();
    if (!id) return { ok: false, error: '缺少 device' };
    const q = this.pending.get(id) || [];
    const limit = Math.max(1, Math.min(50, Number(opt.limit) || 20));
    const out = [];
    let changed = false;
    for (const c of q) {
      if (c.status !== 'pending' && !opt.includeAcked) continue;
      out.push(c);
      if (c.status === 'pending') { c.status = 'delivered'; c.deliveredAt = Date.now(); changed = true; }
      if (out.length >= limit) break;
    }
    if (changed) this._saveSoon();
    return { ok: true, items: out, count: out.length };
  }

  /** 目标确认收到并开始执行 */
  ack(id, deviceId) {
    const c = this.byId.get(String(id || ''));
    if (!c) return { ok: false, error: '指令不存在' };
    if (deviceId && c.target !== deviceId) return { ok: false, error: '指令不属于该设备' };
    if (c.status === 'pending' || c.status === 'delivered') {
      c.status = 'acked';
      c.ackedAt = Date.now();
      this._saveSoon();
      this._publish('remote.ack', c);
    }
    return { ok: true, cmd: c };
  }

  /** 目标回报执行结果 */
  result(id, r = {}, deviceId) {
    const c = this.byId.get(String(id || ''));
    if (!c) return { ok: false, error: '指令不存在' };
    if (deviceId && c.target !== deviceId) return { ok: false, error: '指令不属于该设备' };
    if (c.status === 'done' || c.status === 'error' || c.status === 'cancelled') {
      return { ok: true, cmd: c, duplicate: true };
    }

    const ok = r.ok !== false;
    c.status = ok ? 'done' : 'error';
    c.endedAt = Date.now();
    c.durationMs = c.endedAt - c.createdAt;
    if (!ok) c.error = String(r.error || '执行失败').slice(0, 300);
    if (r.data !== undefined && r.data !== null) {
      try {
        const s = JSON.stringify(r.data);
        c.result = s.length > 4096 ? { truncated: true, preview: s.slice(0, 4096) } : r.data;
      } catch { c.result = null; }
    }

    this._finish(c);
    if (ok) this._doneCount++; else this._errCount++;
    return { ok: true, cmd: c };
  }

  /* ------------------------------ 控制侧：查看 / 取消 ------------------------------ */

  get(id) { return this.byId.get(String(id || '')) || null; }

  /** 在途指令（可按设备过滤） */
  list(opt = {}) {
    let list = [...this.byId.values()];
    if (opt.target) list = list.filter((c) => c.target === opt.target);
    if (opt.from) list = list.filter((c) => c.from === opt.from);
    list.sort((a, b) => b.createdAt - a.createdAt);
    return list.slice(0, Math.max(1, Number(opt.limit) || 50));
  }

  /** 历史（含已结束），新在前 */
  log(opt = {}) {
    let list = this.history.slice();
    if (opt.target) list = list.filter((c) => c.target === opt.target);
    if (opt.status) list = list.filter((c) => c.status === opt.status);
    list.sort((a, b) => b.createdAt - a.createdAt);
    return list.slice(0, Math.max(1, Number(opt.limit) || 50));
  }

  cancel(id, reason = '发起方取消') {
    const c = this.byId.get(String(id || ''));
    if (!c) return { ok: false, error: '指令不存在' };
    if (c.status === 'done' || c.status === 'error' || c.status === 'cancelled' || c.status === 'timeout') {
      return { ok: false, error: '指令已结束' };
    }
    c.status = 'cancelled';
    c.error = reason;
    c.endedAt = Date.now();
    this._finish(c);
    return { ok: true, cmd: c };
  }

  /** 目标设备离线时，清掉它的待执行队列 */
  dropTarget(deviceId) {
    const q = this.pending.get(deviceId);
    if (!q || !q.length) return 0;
    let n = 0;
    for (const c of q) {
      if (c.status === 'pending' || c.status === 'delivered' || c.status === 'acked') {
        c.status = 'timeout';
        c.error = '目标设备离线';
        c.endedAt = Date.now();
        this._finish(c, true);
        n++;
      }
    }
    this.pending.delete(deviceId);
    return n;
  }

  /* ------------------------------ 超时扫描 ------------------------------ */

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => this.sweep(), 15000);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; this._save(); }
  }

  /** 超时清理：120s 未完成即判 timeout；目标已离线则立即判失败 */
  sweep() {
    const now = Date.now();
    let n = 0;
    const presence = this.srv && this.srv.presence;
    for (const [tid, q] of this.pending) {
      const dev = presence ? presence.get(tid) : null;
      const offline = !dev || !dev.online || (now - (dev.lastSeen || 0) > 90000);
      const keep = [];
      for (const c of q) {
        if (now - c.createdAt > CMD_TTL_MS) {
          c.status = 'timeout';
          c.error = '目标设备未在 2 分钟内响应';
          c.endedAt = now;
          this._finish(c, true);
          n++;
        } else if (offline) {
          // 目标掉线，在途指令不可能被执行，立刻了结（避免用户空等 2 分钟）
          c.status = 'timeout';
          c.error = '目标设备已离线';
          c.endedAt = now;
          this._finish(c, true);
          n++;
        } else if (c.status !== 'done' && c.status !== 'error' && c.status !== 'cancelled' && c.status !== 'timeout') {
          keep.push(c);
        }
      }
      if (keep.length) this.pending.set(tid, keep);
      else this.pending.delete(tid);
    }
    if (n) this._saveSoon();
    return n;
  }

  stats() {
    const inflight = [...this.byId.values()];
    const byStatus = {};
    for (const c of inflight) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    return {
      inflight: inflight.length,
      byStatus,
      history: this.history.length,
      sent: this._sentCount,
      done: this._doneCount,
      failed: this._errCount,
      targets: this.pending.size,
      execEnabled: this.execEnabled,
      actions: Object.keys(ACTIONS).map((k) => ({ action: k, ...ACTIONS[k] })),
    };
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 指令结束：移出队列 → 进历史 → 广播 */
  _finish(c, fromSweep) {
    const q = this.pending.get(c.target);
    if (q) {
      const i = q.indexOf(c);
      if (i >= 0) q.splice(i, 1);
      if (!q.length) this.pending.delete(c.target);
    }
    this.byId.delete(c.id);
    this.history.push(c);
    if (this.history.length > HISTORY_KEEP) this.history.splice(0, this.history.length - HISTORY_KEEP);
    this._saveSoon();
    if (!fromSweep) this._publish('remote.result', c);
    else this._publish('remote.timeout', c);
  }

  _publish(type, cmd) {
    if (this.srv && this.srv.hub) {
      try { this.srv.hub.publish('remote', type, cmd); } catch { /* 推送失败不影响通道 */ }
    }
  }
}

module.exports = { Remote, ACTIONS };

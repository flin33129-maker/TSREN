'use strict';

/* =====================================================================
   lib/tasks.js — 实时任务中心
   与 server.js 里既有的「定时同步任务(jobs)」不同：
     jobs  = 周期性计划（daily/weekly，落 jobs.json）
     tasks = 一次性实时作业（上传/打包/校验/转码/复制），带进度与取消

   生命周期：queued → running → done | error | cancelled
   事件：task.created / task.progress / task.done / task.error / task.cancelled
   落盘：<dataDir>/tasks.json（2s 合并写，保留最近 200 条）
   零依赖。
   ===================================================================== */

const fs = require('fs');
const path = require('path');

const KEEP = 200;                 // 保留条数
const SAVE_DEBOUNCE_MS = 1500;
const PROGRESS_THROTTLE_MS = 250; // 同一任务进度广播最小间隔（防止刷屏）

const STATUS = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  error: '失败',
  cancelled: '已取消',
};

class TaskCenter {
  constructor(srv) {
    this.srv = srv;
    this.file = path.join(srv.cfg.dataDir, 'tasks.json');
    this.tasks = new Map();       // id -> task
    this.order = [];              // id 顺序（旧→新）
    this.cancelled = new Set();   // 已请求取消的 id（供执行体轮询）
    this._cancelHooks = new Map();// id -> [fn]（取消时回调，用于中断长任务）
    this._saveTimer = null;
    this._lastPush = new Map();   // id -> ts（进度节流）
    this._load();
  }

  /* ------------------------------ 落盘 ------------------------------ */

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) {
        for (const t of raw) {
          if (!t || !t.id) continue;
          // 重启后未完成的作业一律判为中断（没有守护进程能续跑）
          if (t.status === 'running' || t.status === 'queued') {
            t.status = 'error';
            t.error = '服务重启，任务中断';
            t.endedAt = t.endedAt || Date.now();
          }
          this.tasks.set(t.id, t);
          this.order.push(t.id);
        }
      }
    } catch { /* 首次启动 */ }
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._save(); }, SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _save() {
    try {
      const list = this.order.map((id) => this.tasks.get(id)).filter(Boolean).slice(-KEEP);
      fs.writeFileSync(this.file, JSON.stringify(list, null, 2));
    } catch { /* 落盘失败不影响内存态 */ }
  }

  /* ------------------------------ 创建 / 推进 ------------------------------ */

  /**
   * 新建任务。
   * @param {object} o { name, type, disk, path, total, unit, meta, user, device }
   * @returns {object} task
   */
  create(o = {}) {
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const task = {
      id,
      name: String(o.name || '').trim() || '未命名任务',
      type: String(o.type || 'generic'),        // upload/download/zip/copy/move/scrub/transcode/index
      disk: String(o.disk || ''),
      path: String(o.path || ''),
      status: 'queued',
      progress: 0,
      total: Number(o.total) || 0,              // 0 = 未知总量
      done: 0,
      unit: String(o.unit || 'bytes'),          // bytes | items | percent
      speed: null,                              // 字节/秒（前端可算）
      detail: '',
      error: '',
      meta: o.meta && typeof o.meta === 'object' ? o.meta : {},
      user: String(o.user || ''),
      device: String(o.device || ''),
      createdAt: Date.now(),
      startedAt: 0,
      endedAt: 0,
    };
    this.tasks.set(id, task);
    this.order.push(id);
    this._trim();
    this._saveSoon();
    this._publish('task.created', task);
    return task;
  }

  start(id) {
    const t = this.tasks.get(id);
    if (!t) return null;
    /* R9-TSK-1：已请求取消的任务不得再被拉回「进行中」 */
    if (this.isCancelled(id)) { t.status = 'cancelled'; return t; }
    t.status = 'running';
    t.startedAt = Date.now();
    this._saveSoon();
    this._publish('task.progress', t);
    return t;
  }

  /**
   * 更新进度（自动节流广播）。
   * @param {string} id
   * @param {object} p { done, total, progress, speed, detail, status }
   */
  progress(id, p = {}) {
    const t = this.tasks.get(id);
    if (!t) return t;
    /* R9-TSK-1：任务已取消 → 不再推进任何状态（进度/详情/状态都不动） */
    if (this.isCancelled(id)) return t;
    if (p.done != null) t.done = Number(p.done) || 0;
    if (p.total != null) t.total = Number(p.total) || 0;
    if (p.speed != null) t.speed = Number(p.speed) || 0;
    if (p.detail != null) t.detail = String(p.detail).slice(0, 200);
    if (p.status && STATUS[p.status]) t.status = p.status;
    // 首次上报有实际进展 → 自动从「排队」转为「进行中」（调用方无需显式 start）
    if (t.status === 'queued' && (t.done > 0 || (t.progress || 0) > 0)) {
      t.status = 'running';
      if (!t.startedAt) t.startedAt = Date.now();
    }

    if (p.progress != null) {
      t.progress = clampPct(p.progress);
    } else if (t.total > 0) {
      t.progress = clampPct((t.done / t.total) * 100);
    }

    const now = Date.now();
    const last = this._lastPush.get(id) || 0;
    // 关键节点（0/100）必推，其余节流
    if (now - last >= PROGRESS_THROTTLE_MS || t.progress === 0 || t.progress >= 100) {
      this._lastPush.set(id, now);
      this._publish('task.progress', t);
    }
    return t;
  }

  /** 完成（ok=true → done，否则 error） */
  finish(id, { ok = true, error = '', result = null } = {}) {
    const t = this.tasks.get(id);
    if (!t) return null;
    /* R9-TSK-1：终态保护 —— 任务已取消时，finish 不能把它改写成 done/error。
       旧实现无条件覆盖状态，执行体在取消后仍会走到 finish，
       于是「已取消」的任务在界面上变成「已完成」，用户以为白等一场。 */
    if (this.isCancelled(id)) {
      t.status = 'cancelled';
      t.endedAt = t.endedAt || Date.now();
      if (!t.startedAt) t.startedAt = t.createdAt;
      t.durationMs = t.startedAt ? t.endedAt - t.startedAt : 0;
      if (error) t.error = String(error).slice(0, 300);
      this._saveSoon();
      /* 不再广播 task.done —— 终态是 cancelled，不是 done */
      return t;
    }
    t.status = ok ? 'done' : 'error';
    t.progress = ok ? 100 : t.progress;
    t.endedAt = Date.now();
    if (!t.startedAt) t.startedAt = t.createdAt;   // 未显式 start 时用创建时间兜底，保证时长有意义
    t.durationMs = t.startedAt ? t.endedAt - t.startedAt : 0;
    if (error) t.error = String(error).slice(0, 300);
    if (result !== null && result !== undefined) t.meta = { ...t.meta, result };
    this.cancelled.delete(id);
    this._lastPush.delete(id);
    this._saveSoon();
    this._publish(ok ? 'task.done' : 'task.error', t);
    return t;
  }

  cancel(id, reason = '用户取消') {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') {
      return { ok: false, error: '任务已结束，无法取消' };
    }
    this.cancelled.add(id);
    t.status = 'cancelled';
    t.error = reason;
    t.endedAt = Date.now();
    t.progress = clampPct(t.progress);
    this._saveSoon();
    this._publish('task.cancelled', t);
    /* R9-TSK-1：通知执行体（长任务靠它真正停下来） */
    this._fireCancel(id, reason);
    return { ok: true, task: t };
  }

  /**
   * R9-TSK-1：执行体轮询：是否已被请求取消。
   * 旧实现只看 cancelled 集合，而 finish() 会把集合里的 id 删掉 ——
   * 于是「已取消」在执行体眼里又变回 false，任务继续跑到底。
   * 现在同时看任务终态，取消是不可逆的。
   */
  isCancelled(id) {
    if (this.cancelled.has(id)) return true;
    const t = this.tasks.get(id);
    return !!(t && t.status === 'cancelled');
  }

  /**
   * 检查点：执行循环每一步调用它，返回 false 表示「已取消，别再推进」。
   * 用法：if (!this.tasks.guard(id)) break;
   */
  guard(id) { return !this.isCancelled(id); }

  /**
   * 注册取消回调（长任务用来中断自己的循环/中断 AbortController）。
   * @returns {function} 注销函数
   */
  onCancel(id, fn) {
    if (!id || typeof fn !== 'function') return () => {};
    if (!this._cancelHooks.has(id)) this._cancelHooks.set(id, []);
    this._cancelHooks.get(id).push(fn);
    return () => {
      const arr = this._cancelHooks.get(id);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length) this._cancelHooks.delete(id);
    };
  }

  _fireCancel(id, reason) {
    const arr = this._cancelHooks.get(id);
    if (!arr || !arr.length) return;
    this._cancelHooks.delete(id);
    for (const fn of arr.slice()) {
      try { fn(reason); } catch { /* 回调异常不影响取消流程 */ }
    }
  }

  /** 清空已结束的任务（保留进行中的） */
  clearFinished() {
    const kept = [];
    let removed = 0;
    for (const id of this.order) {
      const t = this.tasks.get(id);
      if (!t) continue;
      if (t.status === 'running' || t.status === 'queued') { kept.push(id); continue; }
      this.tasks.delete(id);
      this.cancelled.delete(id);
      this._cancelHooks.delete(id);
      this._lastPush.delete(id);
      removed++;
    }
    this.order = kept;
    this._saveSoon();
    if (removed) this._publish('task.cleared', { removed });
    return { ok: true, removed };
  }

  remove(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    this.tasks.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.cancelled.delete(id);
    this._cancelHooks.delete(id);
    this._saveSoon();
    this._publish('task.removed', { id });
    return { ok: true };
  }

  /* ------------------------------ 查询 ------------------------------ */

  get(id) { return this.tasks.get(id) || null; }

  list(opt = {}) {
    const limit = Number(opt.limit) || 60;
    let list = this.order.map((id) => this.tasks.get(id)).filter(Boolean);
    if (opt.activeOnly) list = list.filter((t) => t.status === 'running' || t.status === 'queued');
    list = list.slice(-limit).reverse();
    return list;
  }

  stats() {
    const all = [...this.tasks.values()];
    const count = (s) => all.filter((t) => t.status === s).length;
    return {
      total: all.length,
      running: count('running'),
      queued: count('queued'),
      done: count('done'),
      error: count('error'),
      cancelled: count('cancelled'),
      active: count('running') + count('queued'),
    };
  }

  /* ------------------------------ 内部 ------------------------------ */

  _trim() {
    while (this.order.length > KEEP) {
      const id = this.order.shift();
      if (id) { this.tasks.delete(id); this.cancelled.delete(id); this._cancelHooks.delete(id); this._lastPush.delete(id); }
    }
  }

  _publish(type, t) {
    if (this.srv && this.srv.hub) {
      try { this.srv.hub.publish('tasks', type, t); } catch { /* 推送失败不影响任务 */ }
    }
  }
}

function clampPct(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

module.exports = { TaskCenter, STATUS };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  let fail = 0;
  let pass = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`✓  ${name}`); }
    else { fail++; console.log(`✗  ${name}${extra ? '  →  ' + extra : ''}`); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktest-'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } };
  const events = [];
  const fakeSrv = {
    cfg: { dataDir: tmp },
    hub: { publish(ch, type, data) { events.push({ ch, type, id: data && data.id }); } },
  };
  const tc = new TaskCenter(fakeSrv);

  try {
    /* ---- 基本流程 ---- */
    const t = tc.create({ name: '测试任务', type: 'copy', user: 'tester' });
    check('任务已创建', !!t.id && t.status === 'queued');
    tc.start(t.id);
    check('任务进入进行中', tc.get(t.id).status === 'running');
    tc.progress(t.id, { progress: 50, detail: '一半' });
    check('进度已更新', tc.get(t.id).progress === 50);

    /* ---- R9-TSK-1：取消必须真的生效 ---- */
    const c = tc.create({ name: '长任务', type: 'copy' });
    tc.start(c.id);
    tc.progress(c.id, { progress: 10 });
    const r = tc.cancel(c.id);
    check('取消成功', r.ok === true);
    check('取消后状态为 cancelled', tc.get(c.id).status === 'cancelled');
    check('isCancelled 为真', tc.isCancelled(c.id) === true);
    check('guard 返回 false（检查点应停止）', tc.guard(c.id) === false);

    /* 取消后不得再推进 */
    tc.progress(c.id, { progress: 80, detail: '还在跑' });
    check('取消后进度不再推进', tc.get(c.id).progress === 10, String(tc.get(c.id).progress));
    check('取消后 detail 不再更新', tc.get(c.id).detail !== '还在跑');

    /* 取消回调 */
    let hookCalled = false;
    tc.onCancel(c.id, () => { hookCalled = true; });
    const c2 = tc.create({ name: '长任务2' });
    tc.start(c2.id);
    tc.onCancel(c2.id, () => { hookCalled = true; });
    tc.cancel(c2.id);
    check('取消回调被触发', hookCalled === true);

    /* finish 不能覆盖 cancelled 终态 */
    tc.finish(c.id, { ok: true });
    check('finish 不覆盖 cancelled 终态', tc.get(c.id).status === 'cancelled', tc.get(c.id).status);
    tc.finish(c.id, { ok: false, error: '执行失败' });
    check('再次 finish 仍是 cancelled', tc.get(c.id).status === 'cancelled');
    check('cancelled 任务不会被广播成 done', !events.some((e) => e.type === 'task.done' && e.id === c.id));

    /* 取消后不能再 start */
    const c3 = tc.create({ name: '长任务3' });
    tc.cancel(c3.id);
    tc.start(c3.id);
    check('取消后 start 不会改回 running', tc.get(c3.id).status === 'cancelled', tc.get(c3.id).status);

    /* 未取消的任务照常完成 */
    tc.finish(t.id, { ok: true });
    check('正常任务终态为 done', tc.get(t.id).status === 'done');
    check('done 任务被广播', events.some((e) => e.type === 'task.done' && e.id === t.id));

    /* 统计 */
    const st = tc.stats();
    check('统计含 cancelled 计数', st.cancelled >= 3, JSON.stringify(st));
    check('统计含 done 计数', st.done === 1, JSON.stringify(st));

    /* 落盘与重启 */
    tc._save();
    check('任务已落盘', fs.existsSync(path.join(tmp, 'tasks.json')));
    const tc2 = new TaskCenter(fakeSrv);
    const t2 = tc2.get(t.id);
    check('重启后任务仍在', !!t2 && t2.status === 'done');
    const c2b = tc2.get(c.id);
    check('重启后 cancelled 终态保留', !!c2b && c2b.status === 'cancelled', c2b && c2b.status);

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

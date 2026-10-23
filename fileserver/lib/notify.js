'use strict';

/* =====================================================================
   lib/notify.js — 通知告警（Webhook 多通道 + 节流 + 本地留痕）
   通道：Bark / 企业微信机器人 / 钉钉机器人（加签）/ 自定义 Webhook
   配置：<dataDir>/notify.json（不存在则用默认值，可由外部写盘更新）
   节流：同一 eventKey 10 分钟内不重复发送（force=true 绕过），
         状态持久化 <dataDir>/notify-state.json
   留痕：最近 100 条 <dataDir>/notify-log.json
   铁律：通道失败只 console 不抛异常，绝不影响主流程；零依赖

   ---------------------------------------------------------------------
   R9-PERF-5  并发竞态 + 状态文件非原子写
   ---------------------------------------------------------------------
   原实现 send() 是「读状态 → 判断要不要发 → 发 → 写状态」，
   这四步**没有任何互斥**：两块硬盘同时掉线 → 两个 send 并发进入 →
   双方都读到「上次发送时间 = 很久以前」→ 两条一模一样的告警都发了出去。
   反过来，状态文件用的是 writeFileSync 直接覆盖写：写一半掉电，
   留下半截 JSON，下次启动 parse 失败 → 节流状态全丢 → 重复轰炸。
   现在：
     · 同一 eventKey 的通知**按 key 串行化**（排队，不并发重入）：
       临界区覆盖「判重 → 发送 → 落盘」全过程，后到的那个必然看到
       已被占用的窗口而被跳过 —— 既不重复发，也不丢发。
     · 不同 eventKey 仍然并行，互不拖累。
     · 新增**去重窗口**（默认 30 秒，按「事件 + 内容签名」判定）：
       这是内存态的，不依赖磁盘，状态文件写失败时依然拦得住重复告警。
       原有的 10 分钟节流是持久态的，跨重启依然有效。两者互补。
     · 状态文件与留痕文件改为**原子写**（tmp + rename），写一半掉电
       最多留一个 .tmp，不会留下半截 JSON 把节流状态弄丢。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const THROTTLE_MS = 10 * 60 * 1000;   // 同一事件节流窗口：10 分钟（持久态）
const DEDUPE_MS = 30 * 1000;          // R9-PERF-5 去重窗口：30 秒（内存态）
const HTTP_TIMEOUT_MS = 5 * 1000;     // 单通道请求超时
const LOG_MAX = 100;                  // 留痕条数上限

/** 默认配置（合并用户配置时作为底版） */
function defaultCfg() {
  return {
    bark: { key: '' },
    wecom: { webhook: '' },
    dingtalk: { webhook: '', secret: '' },
    custom: [],                       // 自定义 Webhook URL 数组，POST {event,title,body}
    events: {
      diskOffline: true,   // 外置硬盘离线/只读
      quotaSoft: true,     // 容量软告警（如 >80%）
      quotaHard: true,     // 容量硬告警（如 >90%）
      scrubFail: true,     // 校验/巡检失败
      snapshot: false,     // 快照完成（默认静默）
      classify: false,     // 整理任务（默认静默）
    },
  };
}

/** R9-PERF-5：事件内容签名 —— 同一个 key 但内容不同算两个事件（反之算重复） */
function signature(eventKey, title, body) {
  const h = crypto.createHash('sha1');
  h.update(String(eventKey || ''));
  h.update('\n');
  h.update(String(title == null ? '' : title));
  h.update('\n');
  h.update(String(body == null ? '' : body));
  return h.digest('hex');
}

class Notifier {
  /** @param {object} srv FileServer 实例（用到 srv.cfg.dataDir） */
  constructor(srv) {
    this.srv = srv;
    this.cfgFile = path.join(srv.cfg.dataDir, 'notify.json');
    this.stateFile = path.join(srv.cfg.dataDir, 'notify-state.json');
    this.logFile = path.join(srv.cfg.dataDir, 'notify-log.json');
    this._tmpSeq = 0;
    this._queues = new Map();     // eventKey -> Promise（同一 key 的发送队列）
    this._lastSent = new Map();   // 签名 -> 发送时刻（内存态去重窗口）
    this._state = null;           // 节流状态（内存态权威，异步落盘）
    this._log = null;             // 留痕（内存态权威，异步落盘）
  }

  /* ------------------------------ 配置 ------------------------------ */

  loadCfg() {
    const cfg = defaultCfg();
    try {
      const saved = JSON.parse(fs.readFileSync(this.cfgFile, 'utf8'));
      if (saved && typeof saved === 'object') {
        for (const k of ['bark', 'wecom', 'dingtalk']) {
          if (saved[k] && typeof saved[k] === 'object') Object.assign(cfg[k], saved[k]);
        }
        if (Array.isArray(saved.custom)) cfg.custom = saved.custom.filter((u) => typeof u === 'string' && u);
        if (saved.events && typeof saved.events === 'object') Object.assign(cfg.events, saved.events);
      }
    } catch { /* 无配置文件或损坏 → 用默认值 */ }
    return cfg;
  }

  saveCfg(data) {
    const cfg = defaultCfg();
    if (data && typeof data === 'object') {
      for (const k of ['bark', 'wecom', 'dingtalk']) {
        if (data[k] && typeof data[k] === 'object') Object.assign(cfg[k], data[k]);
      }
      if (Array.isArray(data.custom)) cfg.custom = data.custom.filter((u) => typeof u === 'string' && u);
      if (data.events && typeof data.events === 'object') Object.assign(cfg.events, data.events);
    }
    try {
      fs.mkdirSync(path.dirname(this.cfgFile), { recursive: true });
      fs.writeFileSync(this.cfgFile, JSON.stringify(cfg, null, 2));
    } catch (e) { console.error('[notify] 保存配置失败:', e.message); }
    return cfg;
  }

  /* ------------------------------ 节流状态 ------------------------------ */

  _loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) || {}; } catch { return {}; }
  }

  /**
   * R9-PERF-5：节流状态以**内存为权威**（并发写不会互相覆盖），
   * 落盘走原子写（tmp + rename）。
   */
  _ensureState() {
    if (!this._state) this._state = this._loadState();
    return this._state;
  }

  _saveState(state) {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.stateFile + '.tmp-' + process.pid + '-' + (this._tmpSeq++);
      try {
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, this.stateFile);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      }
    } catch { /* 留痕失败不影响发送 */ }
  }

  /* ------------------------------ 通道 HTTP 基础 ------------------------------ */

  /** 发一个 HTTP(S) 请求，5s 超时，永不 reject（结果 {ok,status,error}） */
  _request(method, urlStr, bodyObj) {
    return new Promise((resolve) => {
      let u;
      try { u = new URL(urlStr); } catch { return resolve({ ok: false, error: 'URL 无效' }); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ ok: false, error: '仅支持 http/https' });
      const mod = u.protocol === 'https:' ? https : http;
      const payload = bodyObj == null ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };

      const req = mod.request({
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: payload ? {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': payload.length,
        } : {},
      }, (res) => {
        res.on('data', () => {});   // 排空响应体
        res.on('end', () => done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
        res.on('error', (e) => done({ ok: false, status: res.statusCode, error: e.message }));
      });
      req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('超时 ' + HTTP_TIMEOUT_MS + 'ms')));
      req.on('error', (e) => done({ ok: false, error: e.message }));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** 钉钉加签：HMAC-SHA256(secret, "timestamp\nsecret") → base64 → urlEncode */
  _dingtalkSign(secret) {
    const ts = Date.now();
    const hmac = crypto.createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64');
    return { ts, sign: encodeURIComponent(hmac) };
  }

  /* ------------------------------ 发送 ------------------------------ */

  /**
   * R9-PERF-5：按 key 串行化。
   * 同一 eventKey 的 send 排队执行；不同 key 互不阻塞。
   * 队列尾巴吞掉异常，避免 unhandledRejection 把进程带崩。
   */
  _enqueue(key, fn) {
    const prev = this._queues.get(key) || Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(() => {}, () => {});
    this._queues.set(key, tail);
    tail.then(() => {
      // 队列空了就把 key 摘掉，避免 _queues 变成新的无界增长点
      if (this._queues.get(key) === tail) this._queues.delete(key);
    });
    return run;
  }

  /**
   * 发送告警。eventKey 在 cfg.events 中显式为 false 时静默跳过。
   * 同一 eventKey 10 分钟内不重复发（force=true 绕过节流与开关）。
   * @returns {Promise<{ok:boolean, skipped?:string, channels?:Array}>}
   */
  async send(eventKey, title, body, { force = false } = {}) {
    const key = String(eventKey || 'unknown');
    // R9-PERF-5：同一目标的通知排队，杜绝并发重入造成的「重复发 / 丢发」
    return this._enqueue(key, () => this._sendNow(key, title, body, { force }));
  }

  /** 临界区：判重 → 发送 → 落盘（同一 key 串行执行） */
  async _sendNow(eventKey, title, body, { force }) {
    const cfg = this.loadCfg();

    // 事件开关：显式 false 关闭（force 仍可发，用于测试/手动重发）
    if (!force && cfg.events && cfg.events[eventKey] === false) {
      return { ok: false, skipped: 'disabled' };
    }

    const sig = signature(eventKey, title, body);
    const now = Date.now();

    if (!force) {
      /* ① 去重窗口（内存态，不依赖磁盘）：同一事件内容在 DEDUPE_MS 内只发一次。
         放在最前面判，因为它不依赖状态文件 —— 状态文件写失败/被删时
         它依然拦得住重复告警。 */
      const lastSig = Number(this._lastSent.get(sig)) || 0;
      if (now - lastSig < DEDUPE_MS) return { ok: false, skipped: 'duplicate' };
      /* ② 节流窗口（持久态，10 分钟）：同一 eventKey 跨重启也不重复发。 */
      const state = this._ensureState();
      const last = Number(state[eventKey]) || 0;
      if (now - last < THROTTLE_MS) return { ok: false, skipped: 'throttled' };
    }

    const text = title + (body ? '\n' + body : '');
    const channels = [];
    const record = (name, r) => channels.push({ name, ok: !!r.ok, status: r.status, error: r.error });

    // 1) Bark（iOS 推送）：GET https://api.day.app/<key>/<title>/<body>
    if (cfg.bark && cfg.bark.key) {
      const url = 'https://api.day.app/' + encodeURIComponent(cfg.bark.key)
        + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body || '');
      record('bark', await this._request('GET', url));
    }

    // 2) 企业微信机器人
    if (cfg.wecom && cfg.wecom.webhook) {
      record('wecom', await this._request('POST', cfg.wecom.webhook, {
        msgtype: 'text',
        text: { content: text },
      }));
    }

    // 3) 钉钉机器人（secret 存在时加签）
    if (cfg.dingtalk && cfg.dingtalk.webhook) {
      let url = cfg.dingtalk.webhook;
      if (cfg.dingtalk.secret) {
        const { ts, sign } = this._dingtalkSign(cfg.dingtalk.secret);
        url += (url.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + sign;
      }
      record('dingtalk', await this._request('POST', url, {
        msgtype: 'text',
        text: { content: text },
      }));
    }

    // 4) 自定义 Webhook：POST {event,title,body}
    for (const url of cfg.custom || []) {
      record('custom', await this._request('POST', url, { event: eventKey, title, body: body || '' }));
    }

    // 节流/去重状态更新（仅真实发送时）—— 原子写，且在串行临界区内
    if (!force) {
      this._lastSent.set(sig, Date.now());
      const state = this._ensureState();
      state[eventKey] = Date.now();
      this._saveState(state);
    }

    const ok = channels.length > 0 && channels.some((c) => c.ok);
    if (!ok) console.error('[notify] 事件 ' + eventKey + ' 无可用通道或全部失败:', channels);

    this._appendLog({ time: new Date().toISOString(), event: eventKey, title, body: body || '', ok, channels });
    return { ok, channels };
  }

  /** 发送测试通知（force，不走开关与节流） */
  async test(title, body) {
    return this.send('test', title || 'NAS 测试通知', body || '如果你看到这条消息，说明通知通道已配置成功。', { force: true });
  }

  /* ------------------------------ 留痕与查询 ------------------------------ */

  /**
   * R9-PERF-5：留痕以内存为权威（并发 append 不会互相覆盖），落盘走原子写。
   */
  _ensureLog() {
    if (!this._log) {
      try { this._log = JSON.parse(fs.readFileSync(this.logFile, 'utf8')) || []; } catch { this._log = []; }
      if (!Array.isArray(this._log)) this._log = [];
    }
    return this._log;
  }

  _appendLog(entry) {
    try {
      const list = this._ensureLog();
      list.push(entry);
      if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX);
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.logFile + '.tmp-' + process.pid + '-' + (this._tmpSeq++);
      try {
        fs.writeFileSync(tmp, JSON.stringify(list));
        fs.renameSync(tmp, this.logFile);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      }
    } catch (e) { console.error('[notify] 写日志失败:', e.message); }
  }

  /** 最近 n 条通知记录（新在前） */
  listRecent(n = 20) {
    try {
      const list = this._ensureLog();
      return list.slice(-Math.max(1, n)).reverse();
    } catch { return []; }
  }
}

module.exports = { Notifier, THROTTLE_MS, DEDUPE_MS };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('✓ ' + name); }
    else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-test-'));

  (async () => {
    let server = null;
    try {
      /* 本地 HTTP 接收端：统计真实到达的请求数（零依赖，用 node 自带 http） */
      let hits = 0;
      const seen = [];
      server = http.createServer((req, res) => {
        hits++;
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          seen.push({ url: req.url, body });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":1}');
        });
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const hook = 'http://127.0.0.1:' + port + '/hook';

      const srv = { cfg: { dataDir: tmp }, hub: null };
      const n = new Notifier(srv);
      n.saveCfg({ custom: [hook] });

      /* 1) R9-PERF-5 并发同一 key：只能真正发出去一次 */
      const results = await Promise.all(
        Array.from({ length: 10 }, () => n.send('diskOffline', '外置硬盘掉线', 'disk1 已从系统消失'))
      );
      check('并发 10 次只发出 1 次', hits === 1, 'hits=' + hits);
      const skipped = results.filter((r) => r && r.skipped).length;
      check('其余 9 次被跳过', skipped === 9, 'skipped=' + skipped);
      check('跳过原因明确（duplicate/throttled）',
        results.every((r) => !r.skipped || r.skipped === 'duplicate' || r.skipped === 'throttled'),
        JSON.stringify(results.map((r) => r.skipped)));

      /* 2) 不同 key 互不影响（仍能发出去） */
      hits = 0;
      await n.send('quotaSoft', 'NAS 告警', '容量 85%');
      check('不同事件 key 不被误拦', hits === 1, 'hits=' + hits);

      /* 3) 相同 key、窗口内：被节流 */
      hits = 0;
      const again = await n.send('diskOffline', '外置硬盘掉线', 'disk1 已从系统消失');
      check('窗口内同一事件被节流', hits === 0 && again.skipped, 'hits=' + hits + ' skipped=' + again.skipped);

      /* 4) force 绕过节流（手动重发必须能发出去） */
      hits = 0;
      await n.send('diskOffline', '外置硬盘掉线', 'disk1 已从系统消失', { force: true });
      check('force 可绕过节流重发', hits === 1, 'hits=' + hits);

      /* 5) 状态文件是合法 JSON（原子写） */
      let stateOk = false, stateObj = null;
      try { stateObj = JSON.parse(fs.readFileSync(path.join(tmp, 'notify-state.json'), 'utf8')); stateOk = !!stateObj; } catch (e) { stateOk = false; }
      check('节流状态文件是合法 JSON', stateOk);
      check('状态里记下了已发送的事件', stateOk && Number(stateObj.diskOffline) > 0, JSON.stringify(stateObj));

      /* 6) 留痕文件是合法 JSON，且并发写不丢条目 */
      let log = null, logOk = false;
      try { log = JSON.parse(fs.readFileSync(path.join(tmp, 'notify-log.json'), 'utf8')); logOk = Array.isArray(log); } catch (e) { logOk = false; }
      check('留痕文件是合法 JSON', logOk);
      check('留痕条目完整（并发不丢）', logOk && log.length >= 3, 'len=' + (log ? log.length : -1));

      /* 7) 原子写无残留 tmp */
      const leftovers = fs.readdirSync(tmp).filter((x) => x.indexOf('.tmp-') >= 0);
      check('原子写无残留 tmp 文件', leftovers.length === 0, JSON.stringify(leftovers));

      /* 8) 队列不残留（同一 key 串行化后队列会被清空） */
      check('发送队列执行后被清空', n._queues.size === 0, 'size=' + n._queues.size);

      /* 9) 窗口过后可以再发（清掉窗口状态后应恢复发送能力） */
      n._lastSent.clear();
      n._state = {};
      n._saveState(n._state);
      hits = 0;
      await n.send('diskOffline', '外置硬盘掉线', 'disk1 已从系统消失');
      check('窗口状态清空后可再次发送', hits === 1, 'hits=' + hits);

      /* 10) 开关关闭的事件静默跳过 */
      n.saveCfg({ custom: [hook], events: { scrubFail: false } });
      hits = 0;
      const off = await n.send('scrubFail', '巡检发现异常', 'x');
      check('事件开关关闭时静默跳过', hits === 0 && off.skipped === 'disabled', 'hits=' + hits + ' skipped=' + off.skipped);

      console.log('');
      console.log('断言 ' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + ' 项）');
      if (fail) { console.log('✗ 存在失败项'); process.exit(1); }
      console.log('✓ 全部通过');
      process.exit(0);
    } catch (e) {
      console.error('自测异常：', e && e.stack ? e.stack : e);
      process.exit(1);
    } finally {
      try { if (server) server.close(); } catch { /* 忽略 */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  })();
}

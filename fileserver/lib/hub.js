'use strict';

/* =====================================================================
   lib/hub.js — 实时事件中枢（SSE 传输层）
   这是「文件站 → 工作站」的命脉：没有它，设备之间互相不可见。

   能力：
     - 多频道订阅（channel: system/files/tasks/devices/board/*）
     - 单连接多频道：subscribe(req,res,{channels:['tasks','devices']})
     - 心跳保活：默认 20s 发一行注释（防中间层/移动网络掐连接）
     - 断线回放：Last-Event-ID 头 → 从环形缓冲补发丢失事件
     - 背压保护：客户端积压超阈值直接踢（弱网手机不拖垮服务端）
     - 客户端上限 + 最老淘汰（防单机占满句柄）
     - 零依赖；写失败一律吞掉，绝不影响主流程

   事件格式（标准 SSE）：
     id: 123
     event: task.progress
     data: {"id":"ab12","progress":42}
     <空行>
   ===================================================================== */

const DEFAULT_CHANNELS = ['system', 'files', 'tasks', 'devices', 'board', 'remote', 'sync'];

class Hub {
  /**
   * @param {object} srv FileServer 实例（当前仅用于日志/兼容，可不依赖）
   * @param {object} [opt]
   * @param {number} [opt.heartbeatMs=20000] 心跳间隔
   * @param {number} [opt.bufferSize=200]    环形缓冲条数（回放上限）
   * @param {number} [opt.maxClients=64]     并发客户端上限
   * @param {number} [opt.maxBacklogBytes]   单客户端积压上限（默认 1MB）
   * @param {string[]} [opt.allowOrigins]    额外允许的跨源白名单（精确匹配 origin）
   */
  constructor(srv, opt = {}) {
    this.srv = srv;
    this.heartbeatMs = opt.heartbeatMs || 20000;
    this.bufferSize = opt.bufferSize || 200;
    this.maxClients = opt.maxClients || 64;
    this.maxBacklogBytes = opt.maxBacklogBytes || 1024 * 1024;
    this.allowOrigins = Array.isArray(opt.allowOrigins) ? opt.allowOrigins.map(String) : [];
    this.clients = new Map();   // id -> client
    this.buffer = [];           // 环形缓冲 [{ seq, channel, type, data, ts }]
    this.seq = 0;               // 单调递增事件号
    this._timer = null;
    this._startedAt = Date.now();
    this._published = 0;
    this._dropped = 0;
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => this._heartbeat(), this.heartbeatMs);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const c of this.clients.values()) {
      try { c.res.end(); } catch { /* 已断 */ }
    }
    this.clients.clear();
  }

  /* ------------------------------ 订阅 ------------------------------ */

  /**
   * 建立一条 SSE 长连接。调用后本响应即被接管，不可再走 sendJSON。
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {object} [opt]
   * @param {string[]} [opt.channels] 订阅频道，['*'] 表示全部
   * @param {object}   [opt.user]     当前用户（用于台账）
   * @param {string}   [opt.deviceId] 上报的设备号
   */
  subscribe(req, res, opt = {}) {
    const channels = normalizeChannels(opt.channels);
    const lastId = Number(req.headers['last-event-id'] || 0) || 0;

    // 上限保护：踢掉最老的客户端（移动端切前后台容易留下僵尸连接）
    if (this.clients.size >= this.maxClients) {
      let oldest = null;
      for (const c of this.clients.values()) if (!oldest || c.at < oldest.at) oldest = c;
      if (oldest) this._evict(oldest, 'max-clients');
    }

    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',        // 让 nginx/网关别缓冲
    }, this._corsHeaders(req)));
    if (res.flushHeaders) { try { res.flushHeaders(); } catch { /* h2 兼容 */ } }

    const client = {
      id, res, req,
      channels,
      user: opt.user ? (opt.user.username || opt.user.id) : 'guest',
      deviceId: opt.deviceId || '',
      ip: (req.socket && req.socket.remoteAddress) || '',
      at: Date.now(),
      pending: 0,
      alive: true,
    };
    this.clients.set(id, client);

    // 首帧：告诉浏览器重连退避时间 + 当前游标
    this._write(client, `retry: 3000\n\n`);
    this._write(client, `event: hello\ndata: ${JSON.stringify({
      clientId: id, channels, seq: this.seq, serverTime: Date.now(),
    })}\n\n`);

    // 断线回放：只补该客户端订阅的频道
    if (lastId > 0 && lastId < this.seq) {
      const missed = this.buffer.filter((e) => e.seq > lastId && channelMatch(client.channels, e.channel));
      if (missed.length) {
        this._write(client, `event: replay\ndata: ${JSON.stringify({ from: lastId, count: missed.length })}\n\n`);
        for (const e of missed) this._emitTo(client, e);
      }
    }

    const cleanup = () => this._remove(client, 'closed');
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    return id;
  }

  /* ------------------------------ 发布 ------------------------------ */

  /**
   * 发布事件。
   * @param {string} channel 频道（system/files/tasks/devices/board…）
   * @param {string} type    事件名（如 task.progress）
   * @param {object} [data]  载荷
   */
  publish(channel, type, data) {
    const event = {
      seq: ++this.seq,
      channel: channel || 'system',
      type: type || 'message',
      data: data === undefined ? null : data,
      ts: Date.now(),
    };

    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    this._published++;

    for (const client of this.clients.values()) {
      if (!channelMatch(client.channels, event.channel)) continue;
      this._emitTo(client, event);
    }
    return event.seq;
  }

  /** 同时向多个频道推同一事件（便捷） */
  publishAll(channels, type, data) {
    let last = 0;
    for (const ch of channels) last = this.publish(ch, type, data);
    return last;
  }

  /* ------------------------------ 内部 ------------------------------ */

  /**
   * R9-HUB-1：SSE 的 CORS 头。
   * 旧实现固定回 'Access-Control-Allow-Origin: *' ——
   * 一是带凭据（Cookie）的请求浏览器会直接拒收，二是等于把设备事件流
   * 对任意网站开放（别人的页面挂个 EventSource 就能读你的文件变更）。
   * 现在：只回显「本站 origin」（同源策略），非同源干脆不发这个头。
   */
  _corsHeaders(req) {
    const origin = String((req && req.headers && req.headers.origin) || '').trim();
    if (!origin) return {};                       // 非跨站请求，不需要 CORS 头
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch { return {}; }
    const host = String((req && req.headers && req.headers.host) || '').toLowerCase();
    /* 同源：origin 的 host:port 与 Host 头完全一致 */
    if (host && originHost === host) {
      return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }
    /* 运维显式放行的跨源（精确匹配） */
    if (this.allowOrigins.indexOf(origin) >= 0) {
      return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }
    return {};                                     // 不同源：不发 ACAO
  }

  _emitTo(client, event) {
    const line = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({
      channel: event.channel, ts: event.ts, payload: event.data,
    })}\n\n`;
    this._write(client, line);
  }

  _write(client, chunk) {
    if (!client.alive) return;
    // 背压：积压过大说明对端不读（弱网/僵尸），直接踢，别把内存拖爆
    if (client.pending > this.maxBacklogBytes) return this._evict(client, 'backlog');
    try {
      client.pending += chunk.length;
      client.res.write(chunk, () => { client.pending = Math.max(0, client.pending - chunk.length); });
    } catch {
      this._evict(client, 'write-error');
    }
  }

  _heartbeat() {
    const now = Date.now();
    for (const client of this.clients.values()) {
      // 写注释行：客户端 EventSource 会忽略，但能把 NAT/中间层保持活跃
      this._write(client, `: ping ${now}\n\n`);
    }
    // 心跳顺带清理：写不进去的客户端已经在 _write 里被踢
  }

  _evict(client, reason) {
    if (!client.alive) return;
    client.alive = false;
    try { client.res.end(); } catch { /* 已断 */ }
    if (reason === 'backlog' || reason === 'max-clients') this._dropped++;
    this.clients.delete(client.id);
  }

  _remove(client, reason) {
    if (client.alive) {
      client.alive = false;
      this.clients.delete(client.id);
    }
  }

  /* ------------------------------ 查询 ------------------------------ */

  stats() {
    const byChannel = {};
    for (const c of this.clients.values()) {
      for (const ch of c.channels) byChannel[ch] = (byChannel[ch] || 0) + 1;
    }
    return {
      clients: this.clients.size,
      maxClients: this.maxClients,
      seq: this.seq,
      published: this._published,
      dropped: this._dropped,
      buffered: this.buffer.length,
      bufferSize: this.bufferSize,
      heartbeatMs: this.heartbeatMs,
      uptimeS: Math.round((Date.now() - this._startedAt) / 1000),
      byChannel,
      list: [...this.clients.values()].map((c) => ({
        id: c.id, user: c.user, ip: c.ip, deviceId: c.deviceId,
        channels: c.channels, since: c.at,
      })),
    };
  }

  /** 最近 n 条事件（新在前），用于 UI 初次渲染 */
  recent(n = 30, channel) {
    const list = channel ? this.buffer.filter((e) => e.channel === channel) : this.buffer;
    return list.slice(-Math.max(1, n)).reverse();
  }
}

/* ------------------------------ 工具 ------------------------------ */

function normalizeChannels(ch) {
  if (!ch || !ch.length) return [...DEFAULT_CHANNELS];
  const out = [];
  for (const c of ch) {
    const v = String(c || '').trim();
    if (!v) continue;
    if (v === '*' || v === 'all') return ['*'];
    if (!out.includes(v)) out.push(v);
  }
  return out.length ? out : [...DEFAULT_CHANNELS];
}

function channelMatch(subscribed, channel) {
  if (subscribed.includes('*')) return true;
  return subscribed.includes(channel);
}

module.exports = { Hub, DEFAULT_CHANNELS };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  let fail = 0;
  let pass = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`✓  ${name}`); }
    else { fail++; console.log(`✗  ${name}${extra ? '  →  ' + extra : ''}`); }
  };

  /* 假 req/res：只要能接住 writeHead 的头即可 */
  const mkRes = () => ({
    headers: null,
    writeHead(code, headers) { this.headers = headers || {}; this.code = code; },
    flushHeaders() {},
    write() { return true; },
    end() {},
    on() {},
  });
  const mkReq = (headers) => ({
    headers: headers || {},
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
  });

  try {
    /* R9-HUB-1：ACAO 不得为 '*' */
    const hub = new Hub(null, { heartbeatMs: 3600000 });

    const same = mkRes();
    hub.subscribe(mkReq({ host: '192.168.1.10:8081', origin: 'http://192.168.1.10:8081' }), same, { channels: ['tasks'] });
    const acao1 = same.headers && same.headers['Access-Control-Allow-Origin'];
    check('同源请求回显本站 origin', acao1 === 'http://192.168.1.10:8081', String(acao1));
    check('ACAO 不等于 *', acao1 !== '*');
    check('回显时带 Vary: Origin', same.headers.Vary === 'Origin');

    const evil = mkRes();
    hub.subscribe(mkReq({ host: '192.168.1.10:8081', origin: 'http://evil.example.com' }), evil, { channels: ['tasks'] });
    const acao2 = evil.headers && evil.headers['Access-Control-Allow-Origin'];
    check('跨源请求不发 ACAO', acao2 === undefined, String(acao2));
    check('跨源时 ACAO 不等于 *', acao2 !== '*');

    const noOrigin = mkRes();
    hub.subscribe(mkReq({ host: '192.168.1.10:8081' }), noOrigin, { channels: ['tasks'] });
    check('无 Origin 头时不发 ACAO', (noOrigin.headers || {})['Access-Control-Allow-Origin'] === undefined);

    const otherPort = mkRes();
    hub.subscribe(mkReq({ host: '192.168.1.10:8081', origin: 'http://192.168.1.10:9999' }), otherPort, { channels: ['tasks'] });
    check('同主机不同端口视为跨源', (otherPort.headers || {})['Access-Control-Allow-Origin'] === undefined);

    /* 运维显式放行的跨源 */
    const hub2 = new Hub(null, { heartbeatMs: 3600000, allowOrigins: ['http://portal.example.com'] });
    const allowed = mkRes();
    hub2.subscribe(mkReq({ host: '192.168.1.10:8081', origin: 'http://portal.example.com' }), allowed, { channels: ['tasks'] });
    check('白名单跨源被放行', allowed.headers['Access-Control-Allow-Origin'] === 'http://portal.example.com');

    /* 事件流本身仍要能发布/统计 */
    const seq = hub.publish('tasks', 'task.progress', { id: 'x' });
    check('发布事件正常', seq > 0);
    check('统计里有客户端', hub.stats().clients >= 4, String(hub.stats().clients));

    hub.stop();
    hub2.stop();
    console.log(`\n断言 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
    if (fail) { console.log('自测未通过'); process.exit(1); }
    console.log('自测全部通过');
    process.exit(0);
  } catch (e) {
    console.error('✗  自测异常:', e);
    process.exit(1);
  }
}

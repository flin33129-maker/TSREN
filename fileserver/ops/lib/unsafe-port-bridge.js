'use strict';

/**
 * ops/lib/unsafe-port-bridge.js — 让回归脚本能打「浏览器/Node fetch 拒绝的端口」
 *
 * 背景（R16.2 实测踩到）：
 *   Chrome 与 Node 内置的 undici fetch 都有一份「受限端口」名单（ERR_UNSAFE_PORT），
 *   2049、6000、6667 等都在里面——因为这些端口历史上属于 IRC/ NFS 之类的非 HTTP 协议，
 *   浏览器干脆禁止发起 HTTP 请求，避免「用网页去打本机服务」的跨协议攻击。
 *   结果就是：服务真的监听在 2049 上，`curl` 一切正常，但 `fetch()` 直接
 *   `TypeError: fetch failed (bad port)` —— 回归脚本会整组假失败。
 *
 * 做法：
 *   在 127.0.0.1 上开一个**透明 TCP 转发**（随机高端口）→ 目标端口，
 *   之后所有 fetch / SSE 都走这个本地转发端口，语义完全不变（就是条 TCP 管道）。
 *   curl 能做的事，脚本就能做。
 *
 * 用法：
 *   const { safeBase } = require('./lib/unsafe-port-bridge');
 *   const BASE = await safeBase(process.env.BASE || 'http://127.0.0.1:8081');
 *   // BASE 可能被换成 http://127.0.0.1:54321（仅当原端口在受限名单里）
 */

const net = require('net');

/* 与 Chrome / undici 一致的受限端口名单（同源实现，够用即可） */
const UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

function isUnsafePort(port) {
  return UNSAFE_PORTS.has(Number(port));
}

/**
 * 返回一个「fetch 能用」的 base URL。
 * 端口安全 → 原样返回；端口受限 → 起本地转发并返回转发后的 URL。
 */
async function safeBase(baseUrl, log) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!isUnsafePort(port)) return baseUrl;

  const bridge = await startBridge(url.hostname || '127.0.0.1', port);
  const next = url.protocol + '//' + url.hostname + ':' + bridge.port;
  if (typeof log === 'function') {
    log('[bridge] ' + port + ' 属于浏览器/Node fetch 的受限端口，脚本改走本地转发 '
      + bridge.port + '（curl 不受影响，浏览器直接开 http://host:' + port + ' 会被拦截）');
  } else {
    console.log('[bridge] ' + port + ' 是受限端口，脚本改走本地转发 ' + bridge.port + ' → 目标服务');
  }
  /* 脚本退出时自动关掉 */
  process.on('exit', () => { try { bridge.server.close(); } catch { /* 已关 */ } });
  return next;
}

/** 起一个 TCP 转发，返回 { port, server } */
function startBridge(host, targetPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host, port: targetPort });
      client.on('error', () => { try { upstream.destroy(); } catch { /* ignore */ } });
      upstream.on('error', () => { try { client.destroy(); } catch { /* ignore */ } });
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, server });
    });
  });
}

module.exports = { safeBase, isUnsafePort, startBridge, UNSAFE_PORTS };

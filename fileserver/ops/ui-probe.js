#!/usr/bin/env node
'use strict';

/**
 * ops/ui-probe.js — 用 jsdom 把**真实前端产物**跑起来，逐路由检查渲染
 *
 * 为什么需要它：
 *   服务端冒烟（ops/smoke-r16.js）只能证明接口返回 200，证明不了「页面能用」。
 *   R16 里办公页白屏两次都是**后端字段形状变了**、前端 `x.y.slice()` 直接崩，
 *   接口本身全是 200 —— 只有真跑一遍前端才能发现。
 *   （那两个 bug 就是靠这个脚本抓到的：capability 缺 export 子表、评论缺 user 字段。）
 *
 * 依赖（可选）：jsdom。项目本体仍然零依赖，这个脚本只在开发机上用。
 *    npm i -D jsdom
 *
 * 用法：
 *   BASE=http://127.0.0.1:8081 USER=admin PASS=xxxx node ops/ui-probe.js
 *   BASE=... node ops/ui-probe.js --routes=/home,/files,/office,/security
 *
 * 退出码：0 全部路由无渲染错误，1 有错误。
 */

const path = require('path');

const RAW_BASE = (process.env.BASE || 'http://127.0.0.1:8081').replace(/\/$/, '');
/* 受限端口（如 2049）会被 Node fetch / 浏览器拒绝：脚本内部改走本地 TCP 转发 */
let BASE = RAW_BASE;
const USER = process.env.USER || 'admin';
const PASS = process.env.PASS || '';
const routeArg = process.argv.find((a) => a.startsWith('--routes='));
/* 路由 id 来自各页面 meta.id，无效 id 会被前端回落到工作台（那就验证不到东西了） */
const ROUTES_ALL = '/home,/files,/assistant,/messages,/im,/meet,/office,/tasks,/services,/status,/security,/devices,/admin-users,/notify,/settings,/games';
const ROUTES = (routeArg ? routeArg.slice(9) : ROUTES_ALL).split(',').filter(Boolean);

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require(require.resolve('jsdom', { paths: [process.cwd(), __dirname, path.join(__dirname, '..')] })));
} catch (e) {
  console.error('需要 jsdom：npm i -D jsdom（项目本体不依赖它，仅本脚本需要）');
  process.exit(2);
}

const realFetch = globalThis.fetch;
let jar = '';
const calls = [];

/** 带 cookie 的 fetch：前端请求的是相对路径，这里补成绝对地址并维护会话 */
async function api(url, opt) {
  const u = typeof url === 'string' && url.startsWith('/') ? BASE + url : url;
  calls.push(((opt && opt.method) || 'GET') + ' ' + String(u).replace(BASE, ''));
  const o = { ...(opt || {}) };
  o.headers = { ...((opt && opt.headers) || {}), ...(jar ? { cookie: jar } : {}) };
  const r = await realFetch(u, o);
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) jar = sc.map((c) => c.split(';')[0]).join('; ');
  return r;
}

/** 最小 EventSource（jsdom 没有），真正解析 SSE 帧 */
function makeEventSource() {
  return class MiniEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this._l = {};
      this._ab = new AbortController();
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;
      this._go();
    }
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
    removeEventListener(t, fn) { this._l[t] = (this._l[t] || []).filter((x) => x !== fn); }
    close() { try { this._ab.abort(); } catch { /* 已关 */ } this.readyState = 2; }
    _emit(t, data) {
      const ev = { type: t, data };
      if (t === 'open' && this.onopen) this.onopen(ev);
      if (t === 'message' && this.onmessage) this.onmessage(ev);
      for (const fn of this._l[t] || []) fn(ev);
    }
    async _go() {
      try {
        const r = await api(this.url, { headers: { accept: 'text/event-stream' }, signal: this._ab.signal });
        if (!r.ok || !r.body) throw new Error('SSE ' + r.status);
        this.readyState = 1;
        this._emit('open', '');
        const rd = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let name = 'message';
            const data = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trim());
            }
            if (!/^:/.test(frame.trim())) this._emit(name, data.join('\n'));
          }
        }
      } catch (e) {
        if (!this._ab.signal.aborted) this._emit('error', String((e && e.message) || e));
      }
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(route) {
  const html = await (await realFetch(BASE + '/')).text();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/getContext|Not implemented/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...a) => {
    const full = a.map((x) => (typeof x === 'string' ? x : (x && x.stack) || '')).join(' ');
    if (/Error:/.test(full) && !/Download the React DevTools/.test(full)) errors.push(full.slice(0, 400));
  });

  const dom = new JSDOM(html, { url: BASE + '/' + (route ? '#' + route : ''), pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const g = globalThis;
  for (const k of ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver',
    'getComputedStyle', 'DOMParser', 'Image', 'matchMedia']) {
    if (w[k] === undefined) continue;
    const v = typeof w[k] === 'function' && k !== 'fetch' ? w[k].bind(w) : w[k];
    /* Node 20+ 自带 getter-only 的 navigator 等全局，直接赋值会 TypeError */
    try {
      Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
    } catch (e) {
      try { g[k] = v; } catch (e2) { /* 改不了就跳过，浏览器桩不是每条都必需 */ }
    }
  }
  g.window = w;
  g.self = w;
  g.Node = w.Node;
  g.fetch = api;
  w.fetch = api;
  w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  g.requestAnimationFrame = w.requestAnimationFrame;
  g.cancelAnimationFrame = w.cancelAnimationFrame;
  /* jsdom 缺这几个浏览器 API，用空实现顶上（不影响我们要验的渲染逻辑） */
  g.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  g.PerformanceObserver = w.PerformanceObserver || class { observe() {} disconnect() {} };
  g.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  const ES = makeEventSource();
  g.EventSource = ES;
  w.EventSource = ES;
  w.HTMLElement.prototype.scrollTo = () => {};
  /* jsdom 没有 matchMedia；设置页用它读系统深色模式偏好 */
  if (!w.matchMedia) {
    w.matchMedia = (q) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  }
  w.Element.prototype.scrollIntoView = () => {};

  const main = await (await realFetch(BASE + '/app/assets/index--2yckYOw.js', { method: 'HEAD' })).status;
  if (main !== 200) {
    /* 产物哈希变了：从 index.html 里解析真实入口，落到临时文件再 import */
    await loadEntryFromHtml(html);
  } else {
    await loadEntryFromHtml(html);
  }
  return { w, errors };
}

/**
 * 把主界面产物下载到临时目录，供 Node 的 ESM loader 用 `file://` 加载。
 * Node 不支持 `import('http://...')`，而 chunk 之间是相对 import，
 * 所以要把整张依赖图一起抓下来、保持文件名不变（否则相对 import 404）。
 */
async function loadEntryFromHtml(html) {
  const fs = require('fs');
  const os = require('os');
  const m = /src="(\/app\/assets\/[^"]+\.js)"/.exec(html);
  if (!m) throw new Error('index.html 里找不到主界面入口脚本');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ui-'));
  const seen = new Set();
  const queue = [m[1]];
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await realFetch(BASE + url);
    if (!r.ok) continue;
    const code = await r.text();
    fs.writeFileSync(path.join(dir, url.split('/').pop()), code);
    for (const ref of code.matchAll(/["'](?:\.\/|\/app\/assets\/)([\w.-]+\.js)["']/g)) {
      queue.push('/app/assets/' + ref[1]);
    }
  }
  /* 注意：不要加 `?t=` 之类的查询串。chunk 内部 `import './index-xxx.js'` 指回主包，
     带查询串会导致主包被加载第二份 —— 两份 React 同一个页面里跑，
     立刻报 "Invalid hook call"（minified #321）。每次进程用新的临时目录即可隔离。 */
  const entry = path.join(dir, m[1].split('/').pop());
  await import('file://' + entry);
}

/**
 * 每个路由必须在**独立进程**里跑：ESM 模块图有缓存，同一进程第二次 import 会复用
 * 上一次的 React/DOM 绑定，页面会串（实测 /ai 渲染出 /home 的内容）。
 */
const oneArg = process.argv.find((a) => a.startsWith('--one='));

async function probeOne(route) {
  const { w, errors } = await boot(route);
  await sleep(3500);
  const doc = w.document;
  const mainEl = doc.getElementById('main') || doc.querySelector('main');
  const text = (mainEl ? mainEl.textContent : doc.getElementById('root').textContent || '').replace(/\s+/g, ' ').trim();
  const pageErrors = (w.__r15Errors || []).slice();
  const rendered = text.length > 40 && !/正在载入深空工作站/.test(text);
  const crashed = /页面渲染出错/.test(text);
  const bad = errors.length || pageErrors.length || !rendered || crashed;
  console.log('\n' + (bad ? '✗' : '✓') + ' ' + route);
  console.log('   渲染: ' + (rendered ? 'OK' : '未渲染内容') + (crashed ? '（React 错误边界已接管）' : ''));
  console.log('   文本: ' + text.slice(0, 140));
  console.log('   接口: ' + [...new Set(calls)].slice(0, 8).join('  '));
  if (errors.length) console.log('   运行时错误: ' + JSON.stringify(errors.slice(0, 3)));
  if (pageErrors.length) console.log('   页面错误: ' + JSON.stringify(pageErrors.slice(0, 3)));
  w.close();
  process.exit(bad ? 1 : 0);
}

async function login() {
  if (!PASS) return true;
  const r = await api('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  return r.ok;
}

(async () => {
  const { safeBase } = require('./lib/unsafe-port-bridge');
  BASE = await safeBase(RAW_BASE);
  if (!(await login())) { console.error('登录失败（检查 USER/PASS）'); process.exit(1); }
  if (oneArg) return probeOne(oneArg.slice(6));

  console.log('UI 探针 → ' + BASE + '  路由: ' + ROUTES.join(' '));
  const { spawnSync } = require('child_process');
  let failed = 0;
  for (const route of ROUTES) {
    const r = spawnSync(process.execPath, [__filename, '--one=' + route], {
      stdio: 'inherit',
      env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '' },
    });
    if (r.status !== 0) failed++;
  }
  console.log('\n' + (failed ? '有 ' + failed + ' 个路由异常' : '全部路由渲染正常'));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('探针异常：', e);
  process.exit(1);
});

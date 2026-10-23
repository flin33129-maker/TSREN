'use strict';

/**
 * R15：可插拔 API 路由层。
 *
 * 背景（为什么要做这件事）：
 *   server.js 是一个 5600 行的 if-else 路由链，所有接口都在这一个文件里靠
 *   `if (pathname === '/api/xxx' && m === 'GET')` 排下去。多人（多个并行改造
 *   任务）同时加接口时必然互相改行、冲突、互相覆盖。这一层把「新接口」从
 *   server.js 里解耦出来：每个功能模块一个文件（lib/routes/<模块>.js），
 *   加接口 = 加文件。
 *
 * 模块契约（务必照此实现，否则这里不会挂载它）：
 *   module.exports = {
 *     name: 'smb',                          // 唯一名，用于 /api/r15/health 展示
 *     prefixes: ['/api/smb'],               // 前缀预筛，命中才会调用 handle（性能）
 *     async handle(ctx) { ... }             // 返回 true = 已处理（响应已发出）
 *   }
 *
 * ctx（由 server.js 提供）：
 *   req, res                 Node 原始对象
 *   app                      服务器实例（this），可访问 app.storage / app.users / app.audit ...
 *   user                     当前登录用户对象或 null（server.js 已解析会话）
 *   pathname, method, query  已解析的路径/方法/查询串
 *   sendJSON(res, code, obj) 、 readBody(req, limit)、 sendText(res, code, text)
 *
 * 安全约定（这层是网关，不做兜底鉴权，模块必须自己做）：
 *   ① 任何写操作必须先判 `ctx.user`，越权直接 401/403；
 *   ② 模块内部异常不要吞，让 registry 打日志并回 500；
 *   ③ 响应必须走 ctx.sendJSON / sendText，别自己 writeHead 后又不 end。
 */

const fs = require('fs');
const path = require('path');

/** 已加载模块（启动时一次性加载，运行时不变） */
const modules = [];
let loadError = null;

/** 前缀预筛：无 prefixes 的模块每次都会被调用（慎用） */
function interested(mod, pathname) {
  if (!mod.prefixes.length) return true;
  for (const p of mod.prefixes) {
    // '/api/smb' 同时覆盖 '/api/smb' 与 '/api/smb/account'
    if (pathname === p || pathname.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * 依次询问各模块是否处理本次请求。
 * @returns {Promise<boolean>} true = 已处理并已发出响应
 */
async function handle(ctx) {
  for (const mod of modules) {
    if (!interested(mod, ctx.pathname)) continue;
    let r;
    try {
      r = await mod.handle(ctx);
    } catch (e) {
      console.error('[routes:' + mod.name + '] ' + (e && e.stack || e));
      if (!ctx.res.headersSent) {
        try { ctx.sendJSON(ctx.res, 500, { error: '服务器内部错误（' + mod.name + '）' }); } catch { /* 已断 */ }
      }
      return true;
    }
    if (r === true) return true;
  }
  return false;
}

/** 供 /api/r15/health 与运维页展示 */
function list() {
  return {
    loadError,
    dir: __dirname,
    modules: modules.map((m) => ({ name: m.name, prefixes: m.prefixes })),
  };
}

/* 先导出再加载模块：模块文件可能 require('./index') 反查注册表（如 health），
   若导出晚于 load()，环形 require 拿到的是空对象。 */
module.exports = { handle, list, modules };

function load() {
  let files = [];
  try {
    files = fs.readdirSync(__dirname)
      .filter((f) => f.endsWith('.js') && f !== 'index.js')
      .sort();
  } catch (e) {
    loadError = e && e.message;
    return;
  }
  for (const f of files) {
    const full = path.join(__dirname, f);
    try {
      const mod = require(full);
      if (!mod || typeof mod.handle !== 'function') {
        /* 同名目录下也可能放**纯数据模块**（如 games-catalog.js 是游戏目录数据，
           被 games.js require）。这类文件没有 handle() 是正常的，不该在启动日志里
           刷一条“加载失败”式的告警 —— 真正写错契约的模块（声明了 prefixes 却没有
           handle）才提示。 */
        if (!mod || (!mod.prefixes && !mod.name)) continue;
        console.warn('[routes] 跳过 ' + f + '：缺少 handle()');
        continue;
      }
      mod.name = mod.name || path.basename(f, '.js');
      mod.prefixes = Array.isArray(mod.prefixes) ? mod.prefixes : [];
      modules.push(mod);
    } catch (e) {
      console.error('[routes] 加载 ' + f + ' 失败：' + (e && e.stack || e));
    }
  }
  console.log('[routes] 已挂载 ' + modules.length + ' 个扩展模块：' + modules.map((m) => m.name).join(', '));
}

load();

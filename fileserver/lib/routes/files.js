'use strict';

/**
 * R15 · 文件管理扩展路由（模块：files）
 *
 * 为什么要有这个文件：
 *   server.js 里已有 list/upload/chunk/download/move/copy/rename/delete/recycle/share 等
 *   成熟接口，但它们缺三样新前端真正需要的东西：
 *     1) 「选中目录的总大小」—— 5000 条目多选时前端不能自己递归（会卡死浏览器）；
 *     2) 「预览」—— /api/download 一律 attachment，PDF/图片没法内联显示；
 *        /api/files/raw 提供 inline + Range（视频/PDF 可拖动进度）；
 *     3) 「带密码 / 只读可编辑 / 可控有效期」的分享落地页 —— 旧 /s/<token> 只有
 *        ttl + 次数，没有密码与编辑，也没有给人看的页面；
 *   还顺手补了收藏（服务端持久化，换设备也在）、批量进回收站（返回 id 供撤销）、
 *   模块自检 /api/files/health（验收证据用）。
 *
 * 约定：
 *   · 挂载由 lib/routes/index.js 自动扫描，本文件不改 server.js / index.js；
 *   · 鉴权自己做：读操作走 app.resolveTarget（内部含 ACL/隐藏盘/路径沙箱判定），
 *     写操作额外要求登录 + _write:true（与 server.js 的 requireWrite 语义一致）；
 *   · 分享落地页 /api/files/s/<token> 必须免登录（收件人没有工作站账号），
 *     这是本文件里唯一不要求 ctx.user 的入口，用 token + 有效期 + 密码自证身份。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mimeOf, contentDisposition, formatSize } = require('../util');

const PREFIX = '/api/files';
const STATE_FILE = 'r15-files.json';
const MAX_PATHS = 500;
const SUM_BUDGET_ENTRIES = 200000;
const SUM_BUDGET_MS = 8000;
const PREVIEW_MAX_BYTES = 256 * 1024;
/* ── 压缩传输（下载侧）─────────────────────────────────────────────────
   复用 nginx 的 gzip（level 4 / gzip_proxied any / min_length 1024），Node 不重复压缩：
   · 可压缩：文本类扩展名，且 1KB ≤ size ≤ 8MB、非 Range 请求；
   · >8MB 的文本：Content-Type 降级为 application/octet-stream，避免 nginx 对 i5 打满 CPU
     （实测 20MB 文本 nginx gzip 会额外占用约 0.2~0.4s CPU，而大文件 gzip 收益/耗时比不划算）；
   · .md/.csv 在 nginx 的 gzip_types 里没有，这里映射成 text/plain 让它也能被压缩。 */
const GZIP_TEXT_EXT = new Set([
  'txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'css', 'js',
]);
const GZIP_MIN_BYTES = 1024;
const GZIP_MAX_BYTES = 8 * 1024 * 1024;

/** 让 nginx gzip_types 命中的 Content-Type（.md/.csv 等映射成 text/plain） */
function gzipMimeOf(name) {
  const ext = extOf(name);
  if (ext === 'json') return 'application/json; charset=utf-8';
  if (ext === 'html' || ext === 'htm') return 'text/html; charset=utf-8';
  if (ext === 'xml') return 'text/xml; charset=utf-8';
  if (ext === 'css') return 'text/css; charset=utf-8';
  if (ext === 'js') return 'application/javascript; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

/** 该文件是否走"压缩传输"，返回 {mode, mime, reason} */
function gzipPlan(name, size, opts) {
  const ext = extOf(name);
  /* gzip=0 用于验收对比：必须让 nginx 也放弃压缩 -> 用 octet-stream（只影响 MIME，不影响文件名） */
  if (opts && opts.gzip === '0') return { mode: 'off', mime: 'application/octet-stream', reason: 'client-off' };
  if (opts && opts.range) return { mode: 'off', mime: mimeOf(name), reason: 'range' };
  if (!GZIP_TEXT_EXT.has(ext)) return { mode: 'off', mime: mimeOf(name), reason: 'not-text' };
  if (size < GZIP_MIN_BYTES) return { mode: 'off', mime: mimeOf(name), reason: 'too-small' };
  if (size > GZIP_MAX_BYTES) {
    /* 大于阈值：用 octet-stream 让 nginx 放弃 gzip，避免 i5 上大文本压缩拖慢下载 */
    return { mode: 'skipped-large', mime: 'application/octet-stream', reason: 'large-file-cpu-guard' };
  }
  const ae = String((opts && opts.acceptEncoding) || '');
  if (!/\bgzip\b/i.test(ae)) return { mode: 'off', mime: gzipMimeOf(name), reason: 'client-no-accept-encoding' };
  return { mode: 'gzip', mime: gzipMimeOf(name), reason: 'nginx-gzip' };
}
const SHARE_TTL_MIN = 2 * 1000;
const SHARE_TTL_MAX = 30 * 24 * 60 * 60 * 1000;
const SHARE_PASS_MIN = 4;
const SHARE_PASS_MAX = 64;
const KEEP_SHARES = 500;

/* ── 文本 / 预览类型 ────────────────────────────────────────────────── */

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss',
  'html', 'htm', 'xml', 'svg', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'toml', 'log', 'csv',
  'tsv', 'py', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'c', 'h', 'cpp', 'hpp', 'java', 'go',
  'rs', 'rb', 'php', 'sql', 'env', 'gitignore', 'dockerfile', 'makefile', 'properties',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'heic']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v']);

function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
}

function kindOf(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'binary';
}

/** 供测试/前端判断「这个扩展名能不能内联预览」 */
function isPreviewable(name) {
  if (kindOf(name) === 'binary') return false;
  return true;
}

/* ── 内存在场状态（收藏 / 扩展分享） ────────────────────────────────── */

const stateCache = new WeakMap();

function statePath(app) {
  return path.join(app.cfg.dataDir, STATE_FILE);
}

function loadState(app) {
  if (stateCache.has(app)) return stateCache.get(app);
  const st = { favorites: {}, shares: [], v: 1 };
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(app), 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.favorites && typeof raw.favorites === 'object') st.favorites = raw.favorites;
      if (Array.isArray(raw.shares)) st.shares = raw.shares;
      st.v = raw.v || 1;
    }
  } catch (e) { /* 首次启动 / 文件损坏：按空状态处理，不影响主流程 */ }
  st._timer = null;
  stateCache.set(app, st);
  return st;
}

function saveStateSoon(app, st) {
  if (st._timer) return;
  st._timer = setTimeout(() => {
    st._timer = null;
    try {
      const data = { v: st.v, favorites: st.favorites, shares: st.shares };
      const file = statePath(app);
      const tmp = file + '.tmp';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch (e) {}
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error('[files] 状态落盘失败：' + ((e && e.message) || e));
    }
  }, 300);
  if (st._timer.unref) st._timer.unref();
}

function favList(st, user) {
  const key = user ? user.username : '';
  const list = st.favorites[key];
  return Array.isArray(list) ? list : [];
}

/* ── 请求体 / 响应工具 ──────────────────────────────────────────────── */

async function readJson(ctx, limit) {
  const buf = await ctx.readBody(ctx.req, limit || 256 * 1024);
  try {
    const obj = JSON.parse(buf.toString('utf8') || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return null;
  }
}

function fail(ctx, code, error, extra) {
  ctx.sendJSON(ctx.res, code, Object.assign({ error }, extra || {}));
}

function clientIp(req) {
  try { return req.socket.remoteAddress; } catch (e) { return ''; }
}

/** 读操作统一入口：ACL / 隐藏盘 / 系统目录 / 路径沙箱都由 server.js 的 resolveTarget 判定 */
function targetOf(ctx, body, write) {
  const scope = String((body && (body.scope || body.disk)) || 'public');
  const rel = body && typeof body.path === 'string' ? body.path : '';
  const t = ctx.app.resolveTarget({ scope, path: rel, _write: !!write }, ctx.user);
  return t;
}

function needLogin(ctx) {
  if (ctx.user) return false;
  fail(ctx, 401, '需要登录');
  return true;
}

function audit(ctx, action, detail, extra) {
  try {
    ctx.app.audit(Object.assign({
      action,
      userObj: ctx.user,
      detail: String(detail || '').slice(0, 500),
      ip: clientIp(ctx.req),
      ok: true,
    }, extra || {}));
  } catch (e) { /* 审计失败不影响业务 */ }
}

/* ── 流式输出（Range / inline） ─────────────────────────────────────── */

function streamFile(ctx, abs, opts) {
  const { req, res } = ctx;
  const inline = !!(opts && opts.inline);
  const name = (opts && opts.name) || path.basename(abs);
  let st;
  try { st = fs.statSync(abs); } catch (e) { return fail(ctx, 404, '文件不存在'); }
  if (!st.isFile()) return fail(ctx, 400, '不是文件');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeOf(name));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', inline
    ? "inline; filename*=UTF-8''" + encodeURIComponent(name)
    : contentDisposition(name));

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1; }
      else if (start !== null && end === null) end = st.size - 1;
      if (start !== null && end !== null && start >= 0 && end < st.size && start <= end) {
        res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
        fs.createReadStream(abs, { start, end, highWaterMark: 1 << 20 }).pipe(res);
        return true;
      }
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      res.end();
      return true;
    }
  }
  res.writeHead(200, { 'Content-Length': st.size });
  fs.createReadStream(abs, { highWaterMark: 1 << 20 }).pipe(res);
  return true;
}

/* ── 目录递归大小（选中目录的"总大小"） ─────────────────────────────── */

const sumCache = new Map(); // abs -> {at, size, files, dirs, truncated}

function dirSum(abs, deadline) {
  const cached = sumCache.get(abs);
  if (cached && Date.now() - cached.at < 15000) return Object.assign({}, cached, { cached: true });
  let size = 0;
  let files = 0;
  let dirs = 0;
  let budget = SUM_BUDGET_ENTRIES;
  let truncated = false;
  const stack = [abs];
  while (stack.length) {
    if (budget-- <= 0 || Date.now() > deadline) { truncated = true; break; }
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      if (ent.name === '.recycle' || ent.name === '.versions' || ent.name === '.snapshots') continue;
      if (ent.isSymbolicLink()) continue;
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) { dirs++; stack.push(p); continue; }
      if (!ent.isFile()) continue;
      try { size += fs.statSync(p).size; files++; } catch (e) { /* 竞态删除忽略 */ }
      if (budget-- <= 0 || Date.now() > deadline) { truncated = true; break; }
    }
    if (truncated) break;
  }
  const out = { at: Date.now(), size, files, dirs, truncated };
  if (!truncated) {
    if (sumCache.size > 400) sumCache.clear();
    sumCache.set(abs, out);
  }
  return Object.assign({}, out, { cached: false });
}

/* ── 分享子系统（在旧 /api/share 之外补：密码 / 只读可编辑 / 落地页） ── */

function hashPass(password, salt) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(password)).digest('hex');
}

function verifyPass(rec, password) {
  if (!rec.passHash) return true;
  const got = hashPass(password || '', rec.passSalt || '');
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(rec.passHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function findShare(app, token) {
  const st = loadState(app);
  return st.shares.find((s) => s.token === token) || null;
}

/**
 * 校验分享可用性。
 * @returns {{ok:true,rec:object}|{ok:false,code:number,error:string,needPassword?:boolean}}
 */
function checkShare(app, token, password) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return { ok: false, code: 404, error: '链接不存在' };
  const rec = findShare(app, token);
  if (!rec) return { ok: false, code: 404, error: '链接不存在或已被清理' };
  if (rec.revoked) return { ok: false, code: 410, error: '链接已被撤销' };
  if (Date.now() > rec.expiresAt) return { ok: false, code: 410, error: '链接已过期' };
  if (rec.maxUses > 0 && rec.uses >= rec.maxUses) return { ok: false, code: 410, error: '链接使用次数已用完' };
  if (rec.passHash && !verifyPass(rec, password)) return { ok: false, code: 401, error: '需要访问密码', needPassword: true };
  if (!fs.existsSync(rec.abs)) return { ok: false, code: 410, error: '文件已被移动或删除' };
  return { ok: true, rec };
}

function sharePublicView(rec) {
  return {
    token: rec.token,
    name: rec.name,
    size: rec.size,
    mode: rec.mode,
    hasPassword: !!rec.passHash,
    expiresAt: rec.expiresAt,
    ttlMs: rec.ttlMs,
    maxUses: rec.maxUses,
    uses: rec.uses,
    by: rec.by,
    label: rec.label || '',
    createdAt: rec.at,
  };
}

/** 免登录分享落地页（系统色板，无外部资源，无硬编码色值） */
function sharePageHtml() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>文件分享 · 深空工作站</title>',
    '<style>',
    ':root{color-scheme:light dark}',
    '*{box-sizing:border-box}',
    'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;',
    'font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
    'background:Canvas;color:CanvasText}',
    '.card{width:min(680px,100%);padding:28px;border:1px solid ButtonBorder;border-radius:14px;',
    'background:Canvas;box-shadow:0 12px 32px color-mix(in srgb,CanvasText 12%,transparent)}',
    'h1{font-size:18px;margin:0 0 4px}',
    '.sub{font-size:12px;color:GrayText;margin-bottom:18px}',
    '.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}',
    '.kv{font-size:12px;color:GrayText}.kv b{display:block;font-size:14px;color:CanvasText;font-weight:600;margin-top:2px}',
    '.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
    'button,.btn{font:inherit;font-size:13px;padding:8px 16px;border-radius:8px;',
    'border:1px solid ButtonBorder;background:ButtonFace;color:ButtonText;cursor:pointer;text-decoration:none}',
    'button:hover,.btn:hover{background:color-mix(in srgb,ButtonFace 88%,CanvasText)}',
    'button[disabled]{opacity:.5;cursor:not-allowed}',
    'input,textarea{font:inherit;font-size:13px;padding:8px 10px;border-radius:8px;',
    'border:1px solid ButtonBorder;background:Field;color:FieldText;width:100%}',
    'textarea{min-height:260px;font-family:ui-monospace,Consolas,monospace;line-height:1.5}',
    '.err{color:LinkText;font-size:13px;margin:10px 0}',
    '.hint{font-size:12px;color:GrayText;margin-top:10px}',
    '.preview{max-width:100%;max-height:60vh;margin:12px 0;border-radius:8px;border:1px solid ButtonBorder}',
    'iframe.preview{width:100%;height:60vh}',
    '.hide{display:none !important}',
    '</style></head><body>',
    '<main class="card">',
    '<h1 id="title">文件分享</h1>',
    '<div class="sub" id="by">深空工作站 · 限时分享</div>',
    '<div id="err" class="err" role="alert"></div>',
    '<section id="meta" class="meta hide"></section>',
    '<section id="preview"></section>',
    '<section id="pw" class="hide">',
    '<label class="sub" for="password">该链接需要访问密码</label>',
    '<div class="row"><input id="password" type="password" autocomplete="off" style="max-width:260px">',
    '<button id="pwbtn">打开</button></div>',
    '</section>',
    '<section id="actions" class="row hide" style="margin-top:16px">',
    '<a class="btn" id="dl" href="#">下载文件</a>',
    '<span class="sub" id="uses"></span>',
    '</section>',
    '<section id="edit" class="hide" style="margin-top:16px">',
    '<label class="sub" for="content">可编辑分享：直接修改并保存（每次保存自动归档旧版本）</label>',
    '<textarea id="content" spellcheck="false"></textarea>',
    '<div class="row" style="margin-top:10px"><button id="save">保存修改</button>',
    '<span class="sub" id="savemsg"></span></div>',
    '</section>',
    '<div class="hint">链接会在有效期结束时自动失效；涉及隐私的文件请勿转发到公开渠道。</div>',
    '</main>',
    '<script>',
    '(function(){',
    '  var token=(location.pathname.split("/").filter(Boolean).pop()||"");',
    '  var pw="";',
    '  var info=null;',
    '  var $=function(id){return document.getElementById(id)};',
    '  function fmt(n){if(n==null||isNaN(n))return "-";var u=["B","KB","MB","GB","TB"],i=0,v=Number(n);',
    '    while(v>=1024&&i<u.length-1){v/=1024;i++}return (v>=100?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2))+" "+u[i]}',
    '  function dt(t){try{return new Date(t).toLocaleString("zh-CN")}catch(e){return "-"}}',
    '  function api(p){var q="token="+encodeURIComponent(token)+(pw?"&password="+encodeURIComponent(pw):"");',
    '    return fetch("/api/files/"+p+"?"+q,{credentials:"same-origin"}).then(function(r){',
    '      return r.json().then(function(j){return {status:r.status,body:j||{}}})});}',
    '  function showErr(msg){$("err").textContent=msg||""}',
    '  function render(){',
    '    if(!info)return;',
    '    $("title").textContent=info.name;',
    '    $("by").textContent=(info.by?info.by+" 分享 · ":"")+"有效期至 "+dt(info.expiresAt);',
    '    $("meta").classList.remove("hide");',
    '    $("meta").innerHTML="";',
    '    var rows=[["大小",fmt(info.size)],["权限",info.mode==="edit"?"可编辑":"只读"],',
    '      ["下载次数",(info.uses||0)+(info.maxUses>0?" / "+info.maxUses:" / 不限")],',
    '      ["剩余有效",Math.max(0,Math.round((info.expiresAt-Date.now())/60000))+" 分钟"]];',
    '    rows.forEach(function(kv){var d=document.createElement("div");d.className="kv";',
    '      var b=document.createElement("b");b.textContent=kv[1];d.textContent=kv[0];d.appendChild(b);',
    '      $("meta").appendChild(d)});',
    '    var dl=$("dl");dl.classList.remove("hide");',
    '    dl.href="/api/files/share-dl?"+("token="+encodeURIComponent(token)+(pw?"&password="+encodeURIComponent(pw):""));',
    '    $("actions").classList.remove("hide");',
    '    $("uses").textContent="";',
    '    if(info.preview&&info.preview.kind==="text"&&info.preview.text!=null){',
    '      $("preview").innerHTML="";var pre=document.createElement("pre");pre.className="preview";',
    '      pre.style.padding="14px";pre.style.overflow="auto";pre.textContent=info.preview.text;',
    '      $("preview").appendChild(pre);',
    '    } else if(info.preview&&info.preview.kind==="image"){',
    '      $("preview").innerHTML="";var img=document.createElement("img");img.className="preview";',
    '      img.src=dl.href+"&inline=1";$("preview").appendChild(img);',
    '    } else if(info.preview&&info.preview.kind==="pdf"){',
    '      $("preview").innerHTML="";var fr=document.createElement("iframe");fr.className="preview";',
    '      fr.src=dl.href+"&inline=1";$("preview").appendChild(fr);',
    '    }',
    '    if(info.mode==="edit"&&info.preview&&info.preview.text!=null){',
    '      $("edit").classList.remove("hide");$("content").value=info.preview.text||"";',
    '    }',
    '  }',
    '  function load(){',
    '    api("share-get").then(function(r){',
    '      if(r.status===401&&r.body.needPassword){$("pw").classList.remove("hide");showErr("");return}',
    '      if(r.status!==200){showErr(r.body.error||"链接不可用");return}',
    '      info=r.body;$("pw").classList.add("hide");showErr("");render();',
    '    }).catch(function(){showErr("网络错误，无法连接工作站")});',
    '  }',
    '  $("pwbtn").onclick=function(){pw=$("password").value;load()};',
    '  $("password").addEventListener("keydown",function(e){if(e.key==="Enter"){$("pwbtn").click()}});',
    '  $("save").onclick=function(){',
    '    $("savemsg").textContent="保存中…";',
    '    fetch("/api/files/share-save?token="+encodeURIComponent(token)+(pw?"&password="+encodeURIComponent(pw):""),',
    '      {method:"POST",credentials:"same-origin",headers:{"Content-Type":"text/plain; charset=utf-8"},',
    '       body:$("content").value}).then(function(r){return r.json().then(function(j){return {s:r.status,b:j}})})',
    '      .then(function(x){if(x.s!==200){$("savemsg").textContent=x.b.error||"保存失败";return}',
    '        $("savemsg").textContent="已保存 · "+dt(Date.now());info.preview.text=$("content").value;})',
    '      .catch(function(){$("savemsg").textContent="网络错误"};',
    '  };',
    '  load();',
    '})();',
    '</script></body></html>',
  ].join('');
}

/* ── 路由主体 ───────────────────────────────────────────────────────── */

module.exports = {
  name: 'files',
  prefixes: [PREFIX],

  async handle(ctx) {
    const { req, res, app, user, pathname, method, query } = ctx;
    if (!pathname.startsWith(PREFIX)) return false;
    const sub = pathname.slice(PREFIX.length) || '/';
    const ip = clientIp(req);

    /* ═══ 1) 免登录：分享落地页 / 取件 / 保存 ═══════════════════════════ */
    if (sub.startsWith('/s/') && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(sharePageHtml());
      return true;
    }

    if (sub === '/share-get' && method === 'GET') {
      const r = checkShare(app, query.token, query.password);
      if (!r.ok) {
        return ctx.sendJSON(res, r.code, { error: r.error, needPassword: !!r.needPassword }), true;
      }
      const rec = r.rec;
      const kind = rec.isDir ? 'dir' : kindOf(rec.name);
      const out = Object.assign(sharePublicView(rec), { ok: true, kind, preview: { kind } });
      if (kind === 'text' && fs.existsSync(rec.abs)) {
        try {
          const st = fs.statSync(rec.abs);
          const take = Math.min(st.size, PREVIEW_MAX_BYTES);
          const fd = fs.openSync(rec.abs, 'r');
          const buf = Buffer.alloc(take);
          const n = fs.readSync(fd, buf, 0, take, 0);
          fs.closeSync(fd);
          out.preview = { kind: 'text', text: buf.slice(0, n).toString('utf8'), truncated: st.size > take };
        } catch (e) { out.preview = { kind: 'text', text: '', truncated: false, error: '读取失败' }; }
      }
      return ctx.sendJSON(res, 200, out), true;
    }

    if (sub === '/share-dl' && method === 'GET') {
      const r = checkShare(app, query.token, query.password);
      if (!r.ok) return ctx.sendJSON(res, r.code, { error: r.error, needPassword: !!r.needPassword }), true;
      const rec = r.rec;
      if (rec.isDir) return fail(ctx, 400, '目录分享暂不支持下载'), true;
      /* 次数只在真正开始下载时占用（与 lib/share.js 的语义一致） */
      if (rec.maxUses > 0) { rec.uses += 1; rec.lastUseAt = Date.now(); saveStateSoon(app, loadState(app)); }
      audit(ctx, 'files-share-download', rec.name + ' token=' + rec.token.slice(0, 8) + '…', { ok: true });
      return streamFile(ctx, rec.abs, { inline: query.inline === '1', name: rec.name }), true;
    }

    if (sub === '/share-save' && method === 'POST') {
      const r = checkShare(app, query.token, query.password);
      if (!r.ok) return ctx.sendJSON(res, r.code, { error: r.error, needPassword: !!r.needPassword }), true;
      const rec = r.rec;
      if (rec.mode !== 'edit') return fail(ctx, 403, '该分享为只读，不能保存修改'), true;
      if (rec.isDir) return fail(ctx, 400, '目录分享暂不支持在线编辑'), true;
      let buf;
      try { buf = await ctx.readBody(req, 32 * 1024 * 1024); } catch (e) { return fail(ctx, 413, '内容过大'), true; }
      try {
        const relDir = path.dirname(rec.abs);
        const base = path.basename(rec.abs);
        try { if (fs.existsSync(rec.abs)) app.versionArchive(relDir, base, user); } catch (e) {}
        const tmp = rec.abs + '.share-save-' + Date.now();
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, rec.abs);
      } catch (e) {
        return fail(ctx, 500, '保存失败：' + ((e && e.message) || e)), true;
      }
      rec.size = buf.length;
      rec.updatedAt = Date.now();
      rec.uses += 1;
      saveStateSoon(app, loadState(app));
      try { app.invalidateSizeCache && app.invalidateSizeCache(); } catch (e) {}
      audit(ctx, 'files-share-save', rec.name + ' ' + formatSize(buf.length), { ok: true });
      return ctx.sendJSON(res, 200, { ok: true, size: buf.length }), true;
    }

    /* ═══ 2) 以下全部需要登录 ═══════════════════════════════════════════ */
    if (needLogin(ctx)) return true;

    /* 2.1 模块自检（验收证据） */
    if (sub === '/health' && method === 'GET') {
      const st = loadState(app);
      return ctx.sendJSON(res, 200, {
        ok: true,
        module: 'files',
        version: 'p0-1',
        node: process.version,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        stateFile: statePath(app),
        shares: st.shares.length,
        favorites: Object.keys(st.favorites).length,
        capabilities: {
          sum: true, preview: true, rawRange: true, favorite: true,
          trashUndo: true, sharePassword: true, shareEdit: true,
          maxPathsPerBatch: MAX_PATHS,
        },
        endpoints: [
          'GET /api/files/health', 'GET /api/files/scopes', 'POST /api/files/sum',
          'GET /api/files/preview', 'GET /api/files/raw', 'POST /api/files/verify',
          'GET /api/files/favorites', 'POST /api/files/favorite',
          'POST /api/files/trash', 'POST /api/files/restore',
          'POST /api/files/share', 'GET /api/files/shares', 'POST /api/files/share-revoke',
          'GET /api/files/s/<token>', 'GET /api/files/share-get',
          'GET /api/files/share-dl', 'POST /api/files/share-save',
        ],
      }), true;
    }

    /* 2.2 可见盘符（逐个跑 resolveTarget → 只返回当前用户 ACL 真正可读的盘） */
    if (sub === '/scopes' && method === 'GET') {
      let disks = [];
      try { disks = app.listDisks(user) || []; } catch (e) { disks = []; }
      const visible = [];
      for (const d of disks) {
        if (!d || !d.id) continue;
        const t = app.resolveTarget({ scope: d.id, path: '' }, user);
        if (t && !t.error) {
          visible.push({
            id: d.id, name: d.name, title: d.title || null, kind: d.kind,
            writable: !!d.writable, used: d.used, quota: d.quota, free: d.free,
            location: d.location,
          });
        }
      }
      return ctx.sendJSON(res, 200, { disks: visible }), true;
    }

    /* 2.3 选中项大小汇总：文件直接 stat，目录递归（带预算与缓存） */
    if (sub === '/sum' && method === 'POST') {
      const body = await readJson(ctx, 1024 * 1024);
      if (!body) return fail(ctx, 400, '请求体不是合法 JSON'), true;
      const t = app.resolveTarget({ scope: body.scope, path: '', _write: false }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (!paths.length) return ctx.sendJSON(res, 200, { items: [], totalSize: 0, totalFiles: 0 }), true;
      if (paths.length > MAX_PATHS) return fail(ctx, 400, `一次最多 ${MAX_PATHS} 项`), true;
      const started = Date.now();
      const deadline = started + SUM_BUDGET_MS;
      const items = [];
      let totalSize = 0;
      let totalFiles = 0;
      let totalDirs = 0;
      let truncated = false;
      for (const rel of paths) {
        if (typeof rel !== 'string' || !rel) continue;
        const abs = app.storage.safeResolve(t.root, rel);
        if (!abs) { items.push({ path: rel, error: '非法路径', size: 0 }); continue; }
        let st;
        try { st = fs.lstatSync(abs); } catch (e) { items.push({ path: rel, error: '不存在', size: 0 }); continue; }
        if (st.isSymbolicLink()) { items.push({ path: rel, error: '符号链接不统计', size: 0 }); continue; }
        if (st.isFile()) {
          totalSize += st.size; totalFiles += 1;
          items.push({ path: rel, isDir: false, size: st.size, files: 1, dirs: 0, truncated: false });
          continue;
        }
        const r = dirSum(abs, deadline);
        totalSize += r.size; totalFiles += r.files; totalDirs += r.dirs;
        if (r.truncated) truncated = true;
        items.push({ path: rel, isDir: true, size: r.size, files: r.files, dirs: r.dirs, truncated: r.truncated, cached: r.cached });
      }
      return ctx.sendJSON(res, 200, {
        items, totalSize, totalFiles, totalDirs, truncated,
        ms: Date.now() - started,
      }), true;
    }

    /* 2.4 预览：文本内联返回、其它返回 raw 地址 */
    if (sub === '/preview' && method === 'GET') {
      const t = app.resolveTarget({ scope: query.scope, path: query.path || '' }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      let st;
      try { st = fs.statSync(t.abs); } catch (e) { return fail(ctx, 404, '文件不存在'), true; }
      if (!st.isFile()) return fail(ctx, 400, '目录不能预览'), true;
      const name = path.basename(t.abs);
      const kind = kindOf(name);
      const rawUrl = PREFIX + '/raw?' + new URLSearchParams({
        scope: t.scope, path: String(query.path || ''), inline: '1',
      }).toString();
      const out = { ok: true, name, size: st.size, mtime: st.mtimeMs, kind, mime: mimeOf(name), rawUrl, previewable: isPreviewable(name) };
      if (kind === 'text') {
        const take = Math.min(st.size, PREVIEW_MAX_BYTES);
        try {
          const fd = fs.openSync(t.abs, 'r');
          const buf = Buffer.alloc(take);
          const n = fs.readSync(fd, buf, 0, take, 0);
          fs.closeSync(fd);
          const hasNul = buf.slice(0, n).includes(0);
          if (hasNul) { out.kind = 'binary'; }
          else {
            out.text = buf.slice(0, n).toString('utf8');
            out.truncated = st.size > take;
          }
        } catch (e) {
          out.kind = 'binary';
          out.readError = String((e && e.message) || e);
        }
      }
      return ctx.sendJSON(res, 200, out), true;
    }

    /* 2.5 原始流（inline/Range）：图片、PDF、音视频预览都走这里 */
    if (sub === '/raw' && method === 'GET') {
      const t = app.resolveTarget({ scope: query.scope, path: query.path || '' }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      return streamFile(ctx, t.abs, { inline: query.inline === '1', name: path.basename(t.abs) }), true;
    }

    /* 2.5b 带压缩传输的下载（文本类走 nginx gzip：Content-Encoding: gzip）
       - 默认自适应：客户端 Accept-Encoding 含 gzip 且是 1KB~8MB 的文本 → nginx 压缩；
       - ?gzip=0 强制明文（验收对比用）；Range 请求一律明文；
       - 响应头 X-Files-Gzip 明确告诉调用方/测试发生了什么（enabled/off/skipped-large/…） */
    if (sub === '/download' && method === 'GET') {
      const t = app.resolveTarget({ scope: query.scope, path: query.path || '' }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      let st;
      try { st = fs.statSync(t.abs); } catch (e) { return fail(ctx, 404, '文件不存在'), true; }
      if (!st.isFile()) return fail(ctx, 400, '不是文件'), true;
      const name = path.basename(t.abs);
      const plan = gzipPlan(name, st.size, {
        gzip: query.gzip, range: req.headers.range, acceptEncoding: req.headers['accept-encoding'],
      });
      const headers = {
        'Content-Disposition': contentDisposition(name),
        'Cache-Control': 'no-store',
        'X-Files-Gzip': plan.mode,
        'X-Files-Gzip-Reason': plan.reason,
        'X-Files-Size': String(st.size),
      };
      if (plan.mode === 'gzip') {
        headers['Content-Type'] = plan.mime;
        headers['Vary'] = 'Accept-Encoding';
      } else if (plan.mode === 'skipped-large') {
        headers['Content-Type'] = 'application/octet-stream';
      } else {
        headers['Content-Type'] = plan.mime;
      }
      headers['Accept-Ranges'] = 'bytes';
      /* Range 请求：保持与 /api/download 一致的 206 语义（压缩与 Range 不混用） */
      const range = req.headers.range;
      if (range && plan.mode === 'off') {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          let start = m[1] === '' ? null : parseInt(m[1], 10);
          let end = m[2] === '' ? null : parseInt(m[2], 10);
          if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1; }
          else if (start !== null && end === null) end = st.size - 1;
          if (start !== null && end !== null && start >= 0 && end < st.size && start <= end) {
            res.writeHead(206, Object.assign({}, headers, {
              'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`,
            }));
            fs.createReadStream(t.abs, { start, end, highWaterMark: 1 << 20 }).pipe(res);
            return true;
          }
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          res.end();
          return true;
        }
      }
      res.writeHead(200, Object.assign({}, headers, { 'Content-Length': st.size }));
      fs.createReadStream(t.abs, { highWaterMark: 1 << 20 }).pipe(res);
      return true;
    }

    /* 2.5c 批量打包下载（ZIP）：/api/files/zip
       为什么不用 server.js 的 /api/zip：老接口是 STORE 模式（不压缩），且"选中多个不同目录
       里的单个文件"时会用 basename 归置（同名会撞）。这里按「选中路径的完整相对路径」写 zip，
       文本类 ≤8MB 用 deflate(level=4) 真正压缩，其它（已压缩格式/大文件）保持 STORE，
       避免对 i5 做负优化。流式输出：STORE 走数据描述符单遍读写，不把大文件读进内存。 */
    if (sub === '/zip' && method === 'POST') {
      const body = await readJson(ctx, 2 * 1024 * 1024);
      if (!body) return fail(ctx, 400, '请求体不是合法 JSON'), true;
      const t = app.resolveTarget({ scope: body.scope || body.disk, path: '', _write: false }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      const paths = Array.isArray(body.paths) ? body.paths.filter((x) => typeof x === 'string' && x) : [];
      if (!paths.length) return fail(ctx, 400, '未选择文件'), true;
      if (paths.length > 500) return fail(ctx, 400, '一次最多打包 500 项'), true;
      const wantCompress = body.compress !== false && body.compress !== 0;
      const entries = [];
      let totalBytes = 0;
      const skipTop = new Set(['.recycle', '.versions', '.snapshots']);
      const walk = (abs, rel) => {
        if (entries.length >= 2000) return;
        let st;
        try { st = app.storage.lstatSync ? app.storage.lstatSync(abs) : fs.lstatSync(abs); } catch (e) { return; }
        if (st.isSymbolicLink()) return;
        if (st.isDirectory()) {
          let names = [];
          try { names = fs.readdirSync(abs); } catch (e) { return; }
          for (const n of names) {
            if (skipTop.has(n)) continue;
            walk(path.join(abs, n), rel ? rel + '/' + n : n);
          }
          return;
        }
        if (!st.isFile()) return;
        if (st.size > 0xfffffffe) return;   // ZIP32 单文件上限 4GB，超过直接跳过（不产出坏包）
        if (totalBytes + st.size > 20 * 1024 * 1024 * 1024) return;
        totalBytes += st.size;
        entries.push({ abs, name: String(rel).replace(/^\/+/, ''), size: st.size, mtime: st.mtime });
      };
      for (const rel of paths) {
        const abs = app.storage.safeResolve(t.root, rel);
        if (!abs) continue;
        walk(abs, String(rel));
      }
      if (!entries.length) return fail(ctx, 400, '没有可打包的文件'), true;
      const seen = new Set();
      const uniq = entries.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
      const fileName = 'Files-' + Date.now() + '.zip';
      const compressible = (e) => wantCompress && e.size >= 1024 && e.size <= GZIP_MAX_BYTES && GZIP_TEXT_EXT.has(extOf(e.name));
      const deflateCount = uniq.filter(compressible).length;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(fileName),
        'Cache-Control': 'no-store',
        'X-Files-Zip-Entries': String(uniq.length),
        'X-Files-Zip-Bytes': String(totalBytes),
        'X-Files-Zip-Deflate': String(deflateCount),
      });
      try {
        await writeZipEntries(res, uniq, { compressible });
      } catch (e) {
        console.error('[files] zip 失败：' + ((e && e.message) || e));
      }
      try { res.end(); } catch (e2) {}
      return true;
    }

    /* 2.6 SHA-256 校验（上传后校验 / 秒传证据） */
    if (sub === '/verify' && (method === 'POST' || method === 'GET')) {
      const body = method === 'GET' ? { scope: query.scope, path: query.path } : await readJson(ctx, 64 * 1024);
      if (!body) return fail(ctx, 400, '请求体不是合法 JSON'), true;
      const t = app.resolveTarget({ scope: body.scope, path: body.path || '' }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      let st;
      try { st = fs.statSync(t.abs); } catch (e) { return fail(ctx, 404, '文件不存在'), true; }
      if (!st.isFile()) return fail(ctx, 400, '不是文件'), true;
      const started = Date.now();
      const hex = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(t.abs, { highWaterMark: 1 << 20 })
          .on('data', (d) => h.update(d))
          .on('end', () => resolve(h.digest('hex')))
          .on('error', reject);
      });
      const expect = String(body.sha256 || '').toLowerCase();
      return ctx.sendJSON(res, 200, {
        ok: true, sha256: hex, size: st.size, match: expect ? expect === hex : null,
        ms: Date.now() - started,
      }), true;
    }

    /* 2.7 收藏（服务端持久化，按用户名隔离） */
    if (sub === '/favorites' && method === 'GET') {
      const scope = String(query.scope || '');
      const items = favList(loadState(app), user).filter((f) => !scope || f.scope === scope);
      return ctx.sendJSON(res, 200, { items }), true;
    }
    if (sub === '/favorite' && method === 'POST') {
      const body = await readJson(ctx, 64 * 1024);
      if (!body) return fail(ctx, 400, '请求体不是合法 JSON'), true;
      const scope = String(body.scope || 'public');
      const rel = String(body.path || '');
      if (!rel) return fail(ctx, 400, '缺少 path'), true;
      const t = app.resolveTarget({ scope, path: rel }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      const st = loadState(app);
      const key = user.username;
      const list = (st.favorites[key] || []).filter((f) => !(f.scope === scope && f.path === rel));
      if (body.on !== false) list.unshift({ scope, path: rel, name: path.basename(rel), at: Date.now() });
      st.favorites[key] = list.slice(0, 2000);
      saveStateSoon(app, st);
      return ctx.sendJSON(res, 200, { ok: true, favorite: body.on !== false, count: st.favorites[key].length }), true;
    }

    /* 2.8 批量进回收站：返回每项 recycle id（撤销 Toast 靠它精确还原） */
    if (sub === '/trash' && method === 'POST') {
      const body = await readJson(ctx, 1024 * 1024);
      if (!body) return fail(ctx, 400, '请求体不是合法 JSON'), true;
      const scope = String(body.scope || 'public');
      const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === 'string' && p) : [];
      if (!paths.length) return fail(ctx, 400, '未选择文件'), true;
      if (paths.length > MAX_PATHS) return fail(ctx, 400, `一次最多 ${MAX_PATHS} 项`), true;
      const t = app.resolveTarget({ scope, path: '', _write: true }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      const items = [];
      for (const rel of paths) {
        const abs = app.storage.safeResolve(t.root, rel);
        if (!abs) { items.push({ path: rel, ok: false, error: '非法路径' }); continue; }
        if (abs === t.root) { items.push({ path: rel, ok: false, error: '不能删除根目录' }); continue; }
        if (!fs.existsSync(abs)) { items.push({ path: rel, ok: false, error: '不存在' }); continue; }
        const r = app.recycleMove(t.root, abs, user);
        if (!r.ok) { items.push({ path: rel, ok: false, error: r.error }); continue; }
        items.push({ path: rel, ok: true, id: r.id, size: r.size });
      }
      const okCount = items.filter((x) => x.ok).length;
      try { app.invalidateSizeCache && app.invalidateSizeCache(); } catch (e) {}
      try { app.notifyFilesChanged && app.notifyFilesChanged('delete', { disk: t.disk || scope, path: '', user: user.username }); } catch (e) {}
      audit(ctx, 'files-trash', `删除 ${okCount}/${items.length} 项（进回收站）`, { disk: t.disk || scope, path: scope });
      return ctx.sendJSON(res, 200, { ok: okCount === items.length, items, trashed: okCount }), true;
    }

    /* 2.9 从回收站还原（支持批量） */
    if (sub === '/restore' && method === 'POST') {
      const body = await readJson(ctx, 1024 * 1024);
      if (!body) return fail(ctx, 400, '请求体不是合法 JSON'), true;
      const scope = String(body.scope || 'public');
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string' && x) : [];
      if (!ids.length) return fail(ctx, 400, '未选择回收站条目'), true;
      const t = app.resolveTarget({ scope, path: '', _write: true }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      const items = [];
      for (const id of ids) {
        const r = app.recycleRestore(t.root, id);
        items.push(r.ok ? { id, ok: true, restored: r.restored } : { id, ok: false, error: r.error });
      }
      try { app.invalidateSizeCache && app.invalidateSizeCache(); } catch (e) {}
      audit(ctx, 'files-restore', `还原 ${items.filter((x) => x.ok).length}/${ids.length} 项`);
      return ctx.sendJSON(res, 200, { ok: items.every((x) => x.ok), items }), true;
    }
    if (sub === '/purge' && method === 'POST') {
      const body = await readJson(ctx, 1024 * 1024);
      if (!body) return fail(ctx, 400, '请求体不是合法 JSON'), true;
      const scope = String(body.scope || 'public');
      const t = app.resolveTarget({ scope, path: '', _write: true }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string' && x) : [];
      if (!ids.length) return fail(ctx, 400, '未选择要彻底删除的条目'), true;
      const index = app.recycleIndex(t.root);
      let removed = 0;
      const items = [];
      for (const id of ids) {
        const item = index.find((x) => x.id === id);
        if (!item) { items.push({ id, ok: false, error: '回收站中没有该项' }); continue; }
        const target = app.storage.safeResolve(app.recycleDir(t.root), id);
        if (!target) { items.push({ id, ok: false, error: '非法条目' }); continue; }
        try { app.storage.remove(target); removed += 1; items.push({ id, ok: true }); } catch (e) { items.push({ id, ok: false, error: e.message }); }
        app.recycleSave(t.root, app.recycleIndex(t.root).filter((x) => x.id !== id));
      }
      try { app.invalidateSizeCache && app.invalidateSizeCache(); } catch (e) {}
      audit(ctx, 'files-purge', `彻底删除 ${removed}/${ids.length} 项`);
      return ctx.sendJSON(res, 200, { ok: true, removed, items }), true;
    }

    /* 2.10 扩展分享：创建 / 列表 / 撤销 */
    if (sub === '/share' && method === 'POST') {
      const body = await readJson(ctx, 64 * 1024);
      if (!body) return fail(ctx, 400, '请求体不是合法 JSON'), true;
      const t = app.resolveTarget({ scope: body.scope, path: body.path || '', _write: true }, user);
      if (t.error) return ctx.sendJSON(res, t.code, { error: t.error }), true;
      let st;
      try { st = fs.statSync(t.abs); } catch (e) { return fail(ctx, 404, '文件不存在'), true; }
      if (st.isDirectory()) return fail(ctx, 400, '暂不支持分享文件夹（请分享其中的文件）'), true;
      const mode = body.mode === 'edit' ? 'edit' : 'read';
      const password = String(body.password || '');
      if (password && (password.length < SHARE_PASS_MIN || password.length > SHARE_PASS_MAX)) {
        return fail(ctx, 400, `密码长度需为 ${SHARE_PASS_MIN}-${SHARE_PASS_MAX} 位`), true;
      }
      const ttlMs = Math.max(SHARE_TTL_MIN, Math.min(SHARE_TTL_MAX, Number(body.ttlMs) || 24 * 3600 * 1000));
      let maxUses = Math.floor(Number(body.maxUses) || 0);
      if (maxUses < 0) maxUses = 0;
      if (maxUses > 1000) maxUses = 1000;
      const token = crypto.randomBytes(24).toString('hex');
      const now = Date.now();
      const rec = {
        token, disk: t.disk || String(body.scope || 'public'), path: String(body.path || ''),
        abs: t.abs, name: path.basename(t.abs), size: st.size, isDir: false,
        at: now, expiresAt: now + ttlMs, ttlMs, maxUses, uses: 0,
        passHash: password ? hashPass(password, crypto.randomBytes(16).toString('hex')) : '',
        passSalt: '',
        mode, by: user.username, label: String(body.label || '').slice(0, 80), revoked: false,
      };
      if (password) {
        rec.passSalt = crypto.randomBytes(16).toString('hex');
        rec.passHash = hashPass(password, rec.passSalt);
      }
      const state = loadState(app);
      state.shares.unshift(rec);
      if (state.shares.length > KEEP_SHARES) state.shares.length = KEEP_SHARES;
      saveStateSoon(app, state);
      const host = String(req.headers.host || '127.0.0.1');
      const relUrl = PREFIX + '/s/' + token;
      audit(ctx, 'files-share-create', `${rec.name} ttl=${Math.round(ttlMs / 1000)}s mode=${mode} pw=${password ? 'yes' : 'no'}`);
      return ctx.sendJSON(res, 200, {
        ok: true,
        token,
        url: relUrl,
        absUrl: 'http://' + host + relUrl,
        expiresAt: rec.expiresAt,
        ttlMs,
        maxUses,
        mode,
        hasPassword: !!password,
        name: rec.name,
        size: rec.size,
      }), true;
    }

    if (sub === '/shares' && method === 'GET') {
      const st = loadState(app);
      const mine = user.role === 'admin' ? st.shares : st.shares.filter((s) => s.by === user.username);
      const now = Date.now();
      const items = mine.slice(0, 200).map((s) => Object.assign(sharePublicView(s), {
        revoked: !!s.revoked,
        expired: now > s.expiresAt,
        url: PREFIX + '/s/' + s.token,
      }));
      return ctx.sendJSON(res, 200, { items }), true;
    }

    if (sub === '/share-revoke' && method === 'POST') {
      const body = await readJson(ctx, 8 * 1024);
      if (!body) return fail(ctx, 400, '请求体不是合法 JSON'), true;
      const token = String(body.token || '');
      const st = loadState(app);
      const rec = st.shares.find((s) => s.token === token);
      if (!rec) return fail(ctx, 404, '链接不存在'), true;
      if (user.role !== 'admin' && rec.by !== user.username) return fail(ctx, 403, '只能撤销自己创建的分享'), true;
      rec.revoked = true;
      saveStateSoon(app, st);
      audit(ctx, 'files-share-revoke', rec.name);
      return ctx.sendJSON(res, 200, { ok: true }), true;
    }

    return false;
  },
};

/* ── ZIP 写入工具（R15 第4轮：支持 deflate + 数据描述符，零依赖） ───────── */

let _crcTable = null;
function crc32Of(buf, seed) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[n] = c >>> 0;
    }
  }
  let crc = ((seed || 0) ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) crc = _crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDT(d) {
  const dt = d instanceof Date ? d : new Date();
  return {
    time: ((dt.getHours() & 0x1f) << 11) | ((dt.getMinutes() & 0x3f) << 5) | ((Math.floor(dt.getSeconds() / 2)) & 0x1f),
    date: (((dt.getFullYear() - 1980) & 0x7f) << 9) | (((dt.getMonth() + 1) & 0xf) << 5) | (dt.getDate() & 0x1f),
  };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

/**
 * 流式写 ZIP：可压缩项（文本小文件）在内存 deflate；其余 STORE 单遍流式 + 数据描述符。
 * @returns {Promise<{entries:number, bytes:number}>}
 */
async function writeZipEntries(out, entries, opts) {
  const central = [];
  let offset = 0;
  const write = (buf) => new Promise((resolve) => { out.write(buf) ? resolve() : out.once('drain', resolve); });
  const compressible = (opts && opts.compressible) || (() => false);
  const zlibLib = require('zlib');

  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8');
    const dt = dosDT(e.mtime);
    const deflate = compressible(e);
    if (deflate) {
      let buf;
      try { buf = await fs.promises.readFile(e.abs); } catch (err) { continue; }
      const comp = zlibLib.deflateRawSync(buf, { level: 4 });
      const crc = crc32Of(buf, 0);
      const local = Buffer.concat([
        u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(dt.time), u16(dt.date),
        u32(crc), u32(comp.length), u32(buf.length), u16(nameBytes.length), u16(0), nameBytes,
      ]);
      await write(local);
      await write(comp);
      central.push(Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(dt.time), u16(dt.date),
        u32(crc), u32(comp.length), u32(buf.length), u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), nameBytes,
      ]));
      offset += local.length + comp.length;
    } else {
      const local = Buffer.concat([
        u32(0x04034b50), u16(20), u16(0x0808), u16(0), u16(dt.time), u16(dt.date),
        u32(0), u32(0), u32(0), u16(nameBytes.length), u16(0), nameBytes,
      ]);
      await write(local);
      const headerOffset = offset;
      const dataOffset = headerOffset + local.length;
      let crc = 0;
      let size = 0;
      const rs = fs.createReadStream(e.abs, { highWaterMark: 1 << 20 });
      for await (const chunk of rs) {
        crc = crc32Of(chunk, crc);
        size += chunk.length;
        await write(chunk);
      }
      const descriptor = Buffer.concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]);
      await write(descriptor);
      central.push(Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(0), u16(dt.time), u16(dt.date),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(headerOffset), nameBytes,
      ]));
      offset += local.length + size + descriptor.length;
    }
  }
  const centralBuf = Buffer.concat(central);
  await write(centralBuf);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  await write(eocd);
  return { entries: central.length, bytes: offset + centralBuf.length + eocd.length };
}

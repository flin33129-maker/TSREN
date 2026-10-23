'use strict';

/* ============================ 状态 ============================ */
const state = {
  disk: 'public',
  disks: [],
  path: '',
  user: null,
  entries: [],
  searching: false,
  capabilities: null,
  view: localStorage.getItem('fs.view') || 'list',
  sort: { col: 'name', dir: 1 },
  typeFilter: 'all',          // 类型筛选：all/image/video/audio/doc/archive
  selected: new Set(),
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};

/* =====================================================================
   就绪标记（2026-09-16 界面收敛）
   ---------------------------------------------------------------------
   新前端「系统 → 工具」用 iframe 嵌 /legacy/index.html，靠
   contentWindow.panelXxx() 跨帧拉起面板。但 panels.js 的 openPanel 依赖
   本文件的 `el` —— 脚本顺序是 panels.js(317) → shell.js(319) → app.js(320)，
   iframe load 那一刻 panels.js 已执行完（函数存在），app.js 却还没跑，
   于是调用直接炸 `ReferenceError: el is not defined`。
   （手机端实测踩到；本机因为时序略快没复现 —— 典型的竞态。）

   这个标记必须由**本文件**设，不能在 panels.js 里写 `window.el = el`：
   两个经典脚本的顶层 const 互不可见，那样写会立刻炸同一个错误。

   同时把 el 显式挂到 window，让跨帧调用方（以及旧的 console 调试习惯）
   能用同一个构造器，不必各自 document.createElement。
   ===================================================================== */
window.el = el;
window.__legacyPanelsReady = true;

/* ============================ 图标 ============================ */
const ICONS = {
  eye: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  dl: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v12m0 0l-4-4m4 4l4-4"/><path d="M4 18v1a1 1 0 001 1h14a1 1 0 001-1v-1"/></svg>',
  info: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
  pen: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 3a2.8 2.8 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  trash: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/><path d="M10 11v6m4-6v6"/></svg>',
  list: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  grid: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  sun: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/></svg>',
  scan: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 012-2h2m8 0h2a2 2 0 012 2v2m0 8v2a2 2 0 01-2 2h-2m-8 0H5a2 2 0 01-2-2v-2"/><path d="M3 12h18"/></svg>',
};
const icon = (name) => ICONS[name] || '';

/* ============================ 工具 ============================ */
function fmtSize(b) {
  if (b == null || isNaN(b)) return '—';
  if (b === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : (v >= 100 ? v.toFixed(0) : v.toFixed(1))) + ' ' + u[i];
}
function fmtSpeed(bps) { return bps ? fmtSize(bps) + '/s' : '—'; }
function fmtETA(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  if (sec < 60) return sec + '秒';
  if (sec < 3600) return Math.floor(sec / 60) + '分' + (sec % 60 ? (sec % 60) + '秒' : '');
  return Math.floor(sec / 3600) + '时' + (Math.floor((sec % 3600) / 60) || '') + '分';
}
function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EXT_MAP = {
  png:'🖼',jpg:'🖼',jpeg:'🖼',gif:'🖼',webp:'🖼',svg:'🖼',bmp:'🖼',ico:'🖼',avif:'🖼',
  mp4:'🎬',webm:'🎬',mkv:'🎬',avi:'🎬',mov:'🎬',m4v:'🎬',
  mp3:'🎵',wav:'🎵',flac:'🎵',ogg:'🎵',m4a:'🎵',aac:'🎵',opus:'🎵',
  pdf:'📕',doc:'📘',docx:'📘',xls:'📗',xlsx:'📗',ppt:'📙',pptx:'📙',
  zip:'🗜',rar:'🗜','7z':'🗜',gz:'🗜',tar:'🗜',
  txt:'📄',md:'📝',log:'📄',csv:'📊',
  apk:'📦',exe:'⚙',msi:'⚙',
  js:'📜',json:'📜',html:'📜',htm:'📜',css:'📜',ts:'📜',py:'📜',rs:'📜',go:'📜',sh:'📜',sql:'📜',xml:'📜',yml:'📜',yaml:'📜',
  iso:'💿',img:'💿',
};
function extOf(name) { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }
function typeClass(name) {
  const e = extOf(name);
  if (IMAGE_EXTS.has(e)) return 'img';
  if (VIDEO_EXTS.has(e)) return 'vid';
  if (AUDIO_EXTS.has(e)) return 'aud';
  if (PDF_EXTS.has(e) || DOC_EXTS.has(e)) return 'doc';
  if (ARCHIVE_EXTS.has(e)) return 'arc';
  return '';
}
function iconOf(entry) {
  if (entry.isDir) return '📁';
  return EXT_MAP[extOf(entry.name)] || '📄';
}

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif']);
const VIDEO_EXTS = new Set(['mp4','webm','m4v','mov']);
const AUDIO_EXTS = new Set(['mp3','wav','flac','ogg','m4a','aac','opus']);
const PDF_EXTS = new Set(['pdf']);
const DOC_EXTS = new Set(['doc','docx','xls','xlsx','ppt','pptx']);
const ARCHIVE_EXTS = new Set(['zip','rar','7z','gz','tar','apk']);
const TEXT_EXTS = new Set(['txt','log','json','js','ts','jsx','tsx','css','html','htm','xml','yml','yaml','ini','conf','sh','py','rs','go','java','c','h','cpp','sql','toml','bat','ps1','gitignore','env']);
const MD_EXTS = new Set(['md','markdown']);
const CSV_EXTS = new Set(['csv','tsv']);
const ZIPLIKE_EXTS = new Set(['zip','jar','apk','docx','xlsx','pptx','epub']);

function previewKind(entry) {
  if (entry.isDir) return null;
  const e = extOf(entry.name);
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (PDF_EXTS.has(e)) return 'pdf';
  if (MD_EXTS.has(e)) return 'md';
  if (CSV_EXTS.has(e)) return 'csv';
  if (e === 'docx') return 'docx';
  if (e === 'xlsx' || e === 'xlsm') return 'xlsx';
  if (e === 'pptx') return 'pptx';
  if (e === 'doc') return 'doc';
  if (e === 'epub') return 'epub';
  if (['ttf','otf','woff','woff2'].includes(e)) return 'font';
  if (ZIPLIKE_EXTS.has(e)) return 'zip';
  if (TEXT_EXTS.has(e)) return 'text';
  return null;
}

let toastTimer = null;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('fade');
    setTimeout(() => { t.hidden = true; t.classList.remove('fade'); }, 320);
  }, 2400);
}

async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
}
function jsonPost(url, body) {
  return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/* 按需加载脚本（P1 加载优化）
   office.js / netdiag.js 只在特定功能首次使用时才需要，
   不再进首屏 —— 首屏少两个请求、约 1000 行代码不参与初始解析。
   同一个 src 只加载一次，返回的 Promise 被缓存。 */
const _ensured = Object.create(null);
function ensure(src) {
  if (_ensured[src]) return _ensured[src];
  _ensured[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(src);
    s.onerror = () => { delete _ensured[src]; reject(new Error('加载失败 ' + src)); };
    document.head.appendChild(s);
  });
  return _ensured[src];
}

/* ============================ 主题 ============================ */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const ic = t === 'dark' ? icon('sun') : icon('moon');
  for (const id of ['themeBtn']) { const b = $(id); if (b) b.innerHTML = ic; }
  localStorage.setItem('fs.theme', t);
}
function initTheme() {
  /* 深海工业风为默认主题：无用户偏好时一律深海深色（不再跟随系统浅色） */
  const saved = localStorage.getItem('fs.theme');
  applyTheme(saved === 'light' ? 'light' : 'dark');
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

/* ============================ 弹窗系统（替代 prompt/confirm） ============================ */
function uiPrompt(title, def = '', placeholder = '') {
  return new Promise((resolve) => {
    $('promptTitle').textContent = title;
    const inp = $('promptInput');
    inp.value = def;
    inp.placeholder = placeholder;
    $('promptErr').textContent = '';
    $('promptModal').hidden = false;
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const done = (val) => {
      $('promptModal').hidden = true;
      $('promptOk').onclick = $('promptCancel').onclick = null;
      inp.onkeydown = null;
      resolve(val);
    };
    $('promptOk').onclick = () => {
      const v = inp.value.trim();
      if (!v) { $('promptErr').textContent = '不能为空'; return; }
      done(v);
    };
    $('promptCancel').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') $('promptOk').click(); };
  });
}
function uiConfirm(title, msg, okText = '确定') {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent = msg;
    $('confirmOk').textContent = okText;
    $('confirmModal').hidden = false;
    const done = (val) => {
      $('confirmModal').hidden = true;
      $('confirmOk').onclick = $('confirmCancel').onclick = null;
      resolve(val);
    };
    $('confirmOk').onclick = () => done(true);
    $('confirmCancel').onclick = () => done(false);
  });
}

/* ============================ 任务中心 ============================ */
const taskbar = $('taskbar');
const taskBody = $('taskBody');
let taskUid = 0;
const tasks = new Map();

function refreshTaskCount() {
  const n = tasks.size;
  $('taskCount').textContent = n;
  taskbar.hidden = n === 0;
}
function addTask(title, kind) {
  const uid = ++taskUid;
  const box = document.createElement('div');
  box.className = `task kind-${kind}`;
  box.innerHTML = `
    <div class="task-head">
      <span class="task-kind">${kind === 'upload' ? '上传' : '下载'}</span>
      <span class="task-title"></span>
      <button class="task-x">×</button>
    </div>
    <div class="task-bar"><div class="task-fill"></div></div>
    <div class="task-info"><span class="pct">0%</span><span class="meta">准备中…</span></div>`;
  const task = {
    uid, kind, title, box,
    fill: box.querySelector('.task-fill'),
    pct: box.querySelector('.pct'),
    meta: box.querySelector('.meta'),
    controllers: [], xhrs: [],
    total: 0, loaded: 0, speedAvg: 0, lastLoaded: 0, lastTick: 0,
    cancelled: false, finalised: false,
  };
  box.querySelector('.task-title').textContent = title;
  box.querySelector('.task-x').onclick = () => cancelTask(task);
  taskBody.appendChild(box);
  tasks.set(uid, task);
  refreshTaskCount();
  /* v4：同步登记到跨设备任务中心（其他设备可见 / 可取消） */
  task.sidP = (window.Workstation && kind === 'upload')
    ? Workstation.beginTask({ name: title, type: kind, disk: state.disk, path: state.path })
    : Promise.resolve(null);
  return task;
}
function cancelTask(task) {
  if (task.finalised) return;
  task.cancelled = true;
  for (const x of task.xhrs) { try { x.abort(); } catch {} }
  for (const c of task.controllers) { try { c.abort(); } catch {} }
  finishTask(task, 'cancelled', '已取消');
}
function finishTask(task, cls, meta) {
  if (task.finalised) return;
  task.finalised = true;
  task.box.classList.add('finalised');
  task.box.classList.remove('indeterminate');
  task.box.classList.add(cls);
  task.pct.textContent = cls === 'done' ? '✓' : cls === 'err' ? '失败' : '已取消';
  task.meta.textContent = meta || '';
  if (cls === 'done') { task.fill.style.width = '100%'; task.fill.style.transition = 'width .3s'; }
  /* v4：同步结束跨设备任务中心里的对应任务 */
  if (task.sidP) {
    task.sidP.then((id) => {
      if (!id || !window.Workstation) return;
      if (cls === 'cancelled') Workstation.endTask(id, { ok: false, error: '已取消' });
      else Workstation.endTask(id, { ok: cls === 'done', error: cls === 'err' ? (meta || '失败') : '' });
    }).catch(() => {});
  }
  setTimeout(() => {
    task.box.remove();
    tasks.delete(task.uid);
    refreshTaskCount();
  }, cls === 'done' ? 2200 : 3600);
}
function updateTask(task, loaded, total) {
  task.loaded = loaded;
  if (total != null) task.total = total;
  const now = performance.now();
  if (task.lastTick) {
    const dt = (now - task.lastTick) / 1000;
    const dL = task.loaded - task.lastLoaded;
    if (dt > 0.05) {
      const inst = dL / dt;
      task.speedAvg = task.speedAvg ? (task.speedAvg * 0.72 + inst * 0.28) : inst;
      task.lastTick = now; task.lastLoaded = task.loaded;
    }
  } else { task.lastTick = now; task.lastLoaded = task.loaded; }
  const pct = task.total ? Math.min(100, (task.loaded / task.total) * 100) : 0;
  task.fill.style.width = pct.toFixed(1) + '%';
  task.pct.textContent = pct < 0.1 ? '0%' : (pct >= 99.95 ? '99%' : pct.toFixed(0) + '%');
  const eta = task.speedAvg > 0 && task.total ? (task.total - task.loaded) / task.speedAvg : NaN;
  task.meta.textContent =
    fmtSize(task.loaded) + (task.total ? ' / ' + fmtSize(task.total) : '') +
    ' · ' + fmtSpeed(task.speedAvg) + (isFinite(eta) && eta > 1 ? ' · 余' + fmtETA(eta) : '');
  /* v4：推送到跨设备任务中心（内部已节流） */
  if (task.sidP) {
    task.sidP.then((id) => {
      if (id && window.Workstation) {
        Workstation.progressTask(id, { done: task.loaded, total: task.total || 0, speed: Math.round(task.speedAvg || 0) });
      }
    }).catch(() => {});
  }
}
class Semaphore {
  constructor(n) { this.n = n; this.queue = []; }
  async acquire() { if (this.n > 0) { this.n--; return; } await new Promise((r) => this.queue.push(r)); this.n--; }
  release() { this.n++; const r = this.queue.shift(); if (r) r(); }
}

/* ============================ 盘符（侧栏 + 移动横滚 双渲染） ============================ */
function diskMetaHTML(d) {
  const total = d.quota || d.total;
  let html = `<div class="d-name">${d.name}</div>`;
  if (total) {
    html += `<div class="d-sub">${fmtSize(d.used || 0)} / ${fmtSize(total)}</div>`;
    const pct = Math.min(100, ((d.used || 0) / total) * 100);
    html += `<div class="d-bar"><i class="${pct > 92 ? 'full' : ''}" style="width:${pct.toFixed(1)}%"></i></div>`;
  } else {
    html += `<div class="d-sub">${fmtSize(d.used || 0)}</div>`;
  }
  return html;
}
async function loadDisks() {
  try { state.disks = (await api('/api/disks')).disks || []; } catch { state.disks = []; }
  renderDisks();
}
function renderDisks() {
  // 侧栏
  const sb = $('diskBar');
  sb.innerHTML = '';
  const icons = { public: '📡', private: '🔒', external: '💽' };
  for (const d of state.disks) {
    const item = el('button', 'disk-item' + (state.disk === d.id ? ' active' : ''));
    item.innerHTML = `<span class="d-ic">${icons[d.kind] || '💽'}</span>`;
    const body = el('span', 'd-body');
    body.innerHTML = diskMetaHTML(d);
    item.appendChild(body);
    item.onclick = () => switchDisk(d.id);
    sb.appendChild(item);
  }
  const scan = el('button', 'disk-scan');
  scan.innerHTML = `${icon('scan')}<span>扫描外接硬盘</span>`;
  scan.onclick = rescanDisks;
  sb.appendChild(scan);

  // 移动端横滚
  const m = $('diskBarM');
  m.innerHTML = '';
  for (const d of state.disks) {
    const pill = el('button', 'disk-pill' + (state.disk === d.id ? ' active' : ''));
    const total = d.quota || d.total;
    let inner = `<div class="dp-name"><span class="dp-ic">${icons[d.kind] || '💽'}</span><span>${d.name}</span>`;
    if (d.kind === 'external') inner += `<span class="dp-tag${d.writable ? '' : ' ro'}">${d.writable ? '外接' : '只读'}</span>`;
    inner += '</div>';
    if (total) {
      inner += `<div class="dp-usage">${fmtSize(d.used || 0)} / ${fmtSize(total)}</div>`;
      const pct = Math.min(100, ((d.used || 0) / total) * 100);
      inner += `<div class="dp-bar"><i style="width:${pct.toFixed(1)}%"></i></div>`;
    } else {
      inner += `<div class="dp-usage">${fmtSize(d.used || 0)}</div>`;
    }
    pill.innerHTML = inner;
    pill.onclick = () => switchDisk(d.id);
    m.appendChild(pill);
  }
  const scanP = el('button', 'disk-scan-p');
  scanP.innerHTML = `${icon('scan')}<span>扫描</span>`;
  scanP.onclick = rescanDisks;
  m.appendChild(scanP);
}
async function rescanDisks() {
  await loadDisks();
  toast(state.disks.some(d => d.kind === 'external') ? '检测到外置硬盘' : '未发现新设备', 'ok');
}
function switchDisk(id) {
  if (id === 'private' && !state.user) { toast('私人空间需要登录', 'bad'); openAuth('login'); return; }
  state.disk = id;
  state.path = '';
  state.searching = false;
  state.selected.clear();
  updateBulkBar();
  $('searchInput').value = '';
  renderDisks();
  loadList();
}

/* ============================ 认证（双容器渲染） ============================ */
async function loadMe() {
  try { state.user = (await api('/api/me')).user; } catch { state.user = null; }
  renderUserArea();
}
function userInitial() { return state.user ? state.user.username[0].toUpperCase() : '?'; }
function renderUserArea() {
  const sb = $('userArea');          /* v5：顶栏 .tn-side 内的唯一用户区 */
  if (!sb) return;
  sb.innerHTML = '';
  if (state.user) {
    const who = el('div', 'who');
    who.innerHTML = `<span class="avatar">${userInitial()}</span><span>${state.user.username}</span>` +
      (state.user.role === 'admin' ? '<span class="badge">管理员</span>' : '');
    const out = el('button', 'out', '退出');
    out.onclick = async () => {
      await api('/api/logout', { method: 'POST' });
      state.user = null;
      toast('已退出登录', 'ok');
      renderUserArea();
      loadDisks();
      if (state.disk === 'private') switchDisk('public');
      else loadList();
    };
    who.appendChild(out);
    sb.appendChild(who);
  } else {
    const login = el('button', 'login-btn', '登录 / 注册');
    login.onclick = () => openAuth('login');
    sb.appendChild(login);
  }
}
function openAuth(tab) { $('authModal').hidden = false; setTab(tab); }
function closeAuth() { $('authModal').hidden = true; }
function setTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('authSubmit').textContent = tab === 'login' ? '登录' : '注册';
  $('authForm').dataset.mode = tab;
  $('authErr').textContent = '';
}

/* ============================ 列表 ============================ */
/* ---- 类型筛选条状态同步 ---- */
function syncTypeBar() {
  const bar = $('typeBar');
  if (!bar) return;
  bar.querySelectorAll('.tchip').forEach((b) => {
    b.classList.toggle('on', b.dataset.type === (state.typeFilter || 'all'));
  });
  const cnt = $('typeCount');
  if (cnt) {
    if (state.typeFilter && state.typeFilter !== 'all') {
      const n = sortedEntries().length;
      cnt.textContent = `${n} 项`;
      cnt.hidden = false;
    } else {
      cnt.textContent = '';
      cnt.hidden = true;
    }
  }
}

function sortedEntries() {
  const { col, dir } = state.sort;
  let list = state.entries;
  /* 类型筛选（纯前端过滤当前目录，不请求后端） */
  const f = state.typeFilter;
  if (f && f !== 'all') {
    list = list.filter((it) => {
      if (it.isDir) return false;               // 筛选时只显示文件
      const e = extOf(it.name);
      if (f === 'image') return IMAGE_EXTS.has(e);
      if (f === 'video') return VIDEO_EXTS.has(e);
      if (f === 'audio') return AUDIO_EXTS.has(e);
      if (f === 'doc') return PDF_EXTS.has(e) || DOC_EXTS.has(e) || MD_EXTS.has(e) || TEXT_EXTS.has(e) || CSV_EXTS.has(e);
      if (f === 'archive') return ARCHIVE_EXTS.has(e);
      return true;
    });
  }
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let r = 0;
    if (col === 'name') r = a.name.localeCompare(b.name, 'zh-Hans-CN');
    else if (col === 'size') r = (a.size || 0) - (b.size || 0);
    else r = (a.mtime || 0) - (b.mtime || 0);
    return r * dir;
  });
}
async function loadList() {
  state.searching = false;
  try {
    const d = await api(`/api/list?disk=${encodeURIComponent(state.disk)}&path=${encodeURIComponent(state.path)}`);
    state.entries = d.entries || [];
    state.selected = new Set([...state.selected].filter((n) => state.entries.some((e) => e.name === n)));
    renderBreadcrumb(state.path);
    renderSortIndicators();
    renderList();
  } catch (e) {
    if (state.disk === 'private' && /登录|unauthor|401/i.test(e.message)) {
      toast('私人空间需要登录', 'bad');
      openAuth('login');
      switchDisk('public');
      return;
    }
    toast(e.message, 'bad');
    state.entries = [];
    renderList();
  }
}
function renderBreadcrumb(p) {
  const bc = $('breadcrumb');
  bc.innerHTML = '';
  const diskObj = state.disks.find((d) => d.id === state.disk);
  const rootBtn = el('button', '', diskObj ? diskObj.name : '根目录');
  rootBtn.onclick = () => { state.path = ''; loadList(); };
  bc.appendChild(rootBtn);
  if (p) {
    const segs = p.split('/').filter(Boolean);
    let acc = '';
    segs.forEach((s, i) => {
      bc.appendChild(el('span', 'sep', '/'));
      acc = acc ? acc + '/' + s : s;
      if (i === segs.length - 1) bc.appendChild(el('span', 'cur', s));
      else {
        const b = el('button', '', s);
        const target = acc;
        b.onclick = () => { state.path = target; loadList(); };
        bc.appendChild(b);
      }
    });
  }
}
function renderSortIndicators() {
  document.querySelectorAll('.list-head .sort').forEach((th) => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.sort === state.sort.col) th.classList.add(state.sort.dir > 0 ? 'asc' : 'desc');
  });
}
/* ============================ 右键上下文菜单 ============================ */
let ctxMenu = null;

function closeCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }

function openCtxMenu(x, y, it) {
  closeCtxMenu();
  const m = el('div', 'ctx-menu');
  const canWrite = !!state.user;
  const add = (label, ic, fn, disabled = false, danger = false) => {
    const b = el('button', 'ctx-item' + (danger ? ' danger' : '') + (disabled ? ' disabled' : ''));
    b.innerHTML = `<span class="ctx-ic">${ic}</span><span>${label}</span>`;
    if (disabled) { b.disabled = true; b.title = '需登录后使用'; }
    else b.onclick = () => { closeCtxMenu(); fn(); };
    m.appendChild(b);
  };
  const sep = () => m.appendChild(el('div', 'ctx-sep'));

  if (it.isDir) {
    add('打开', '📂', () => navigate(it));
  } else {
    add('预览', '👁', () => openPreview(it));
    add('下载', '⬇', () => download(it));
  }
  add('复制路径', '📋', () => {
    const p = `${state.disk}/${entryRel(it)}`;
    if (navigator.clipboard) navigator.clipboard.writeText(p).then(() => toast('路径已复制：' + p, 'ok'));
    else toast(p, 'ok');
  });
  add('复制直链', '🔗', () => {
    const u = location.origin + entryUrl(it);
    if (navigator.clipboard) navigator.clipboard.writeText(u).then(() => toast('直链已复制', 'ok'));
    else toast(u, 'ok');
  });
  if (!it.isDir) add('新窗口打开', '↗', () => window.open(entryUrl(it), '_blank'));
  sep();
  add('重命名', '✎', () => rename(it), !canWrite);
  add('删除', '🗑', () => remove(it), !canWrite, true);

  document.body.appendChild(m);
  ctxMenu = m;
  /* 视口边界修正 */
  const r = m.getBoundingClientRect();
  const nx = Math.min(x, window.innerWidth - r.width - 8);
  const ny = Math.min(y, window.innerHeight - r.height - 8);
  m.style.left = Math.max(8, nx) + 'px';
  m.style.top = Math.max(8, ny) + 'px';
}

/* ============================ 概览仪表盘 ============================ */
/** 仅在盘根目录展示：容量条 + 文件统计 + 类型分布 + 最近修改 */
function renderDash() {
  const dash = $('dash');
  if (!dash) return;
  /* 只在根目录显示，子目录里让位给文件列表 */
  const show = !state.path && !state.searching && state.entries.length > 0;
  dash.hidden = !show;
  if (!show) return;

  const disk = state.disks.find((d) => d.id === state.disk) || {};
  const files = state.entries.filter((e) => !e.isDir);
  const dirs = state.entries.filter((e) => e.isDir);
  const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);

  /* 类型分布：按扩展名大类归并 */
  const buckets = { 图片: 0, 视频: 0, 音频: 0, 文档: 0, 压缩包: 0, 其他: 0 };
  for (const f of files) {
    const e = extOf(f.name);
    if (IMAGE_EXTS.has(e)) buckets['图片']++;
    else if (VIDEO_EXTS.has(e)) buckets['视频']++;
    else if (AUDIO_EXTS.has(e)) buckets['音频']++;
    else if (PDF_EXTS.has(e) || DOC_EXTS.has(e) || TEXT_EXTS.has(e) || MD_EXTS.has(e) || CSV_EXTS.has(e)) buckets['文档']++;
    else if (ARCHIVE_EXTS.has(e)) buckets['压缩包']++;
    else buckets['其他']++;
  }
  const recent = [...files].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 4);

  const grid = $('dashGrid');
  grid.innerHTML = '';

  /* 卡 1：磁盘容量（字段：used / quota，free 可能缺失需自行推算） */
  const total = disk.quota || disk.total || 0;
  const used = disk.used || 0;
  const free = disk.free != null ? disk.free : Math.max(0, total - used);
  const cap = total ? Math.round((used / total) * 100) : 0;
  const capLevel = cap >= 95 ? 'bad' : cap >= 80 ? 'warn' : 'ok';
  const c1 = el('div', 'dcard dcard-cap');
  c1.innerHTML = `
    <div class="dc-label">${escHTML(disk.name || state.disk)} 容量</div>
    <div class="dc-big">${total ? fmtSize(used) + ' <span>/ ' + fmtSize(total) + '</span>' : '—'}</div>
    <div class="dc-bar"><i class="${capLevel}" style="width:${Math.min(cap, 100)}%"></i></div>
    <div class="dc-sub">${total ? cap + '% 已用 · 剩余 ' + fmtSize(free) : '容量信息不可用'}</div>`;
  grid.appendChild(c1);

  /* 卡 2：文件统计 */
  const c2 = el('div', 'dcard');
  c2.innerHTML = `
    <div class="dc-label">当前目录</div>
    <div class="dc-big">${files.length + dirs.length} <span>项</span></div>
    <div class="dc-sub">${files.length} 个文件 · ${dirs.length} 个文件夹 · 共 ${fmtSize(totalSize)}</div>`;
  grid.appendChild(c2);

  /* 卡 3：类型分布（横条） */
  const c3 = el('div', 'dcard');
  const rows = Object.entries(buckets).filter(([, v]) => v > 0);
  const maxV = Math.max(1, ...rows.map(([, v]) => v));
  c3.innerHTML = `<div class="dc-label">类型分布</div>` +
    (rows.length
      ? `<div class="dc-dist">${rows.map(([k, v]) =>
          `<div class="dd-row"><span class="dd-k">${k}</span><span class="dd-bar"><i style="width:${(v / maxV) * 100}%"></i></span><span class="dd-v">${v}</span></div>`
        ).join('')}</div>`
      : `<div class="dc-sub">暂无文件</div>`);
  grid.appendChild(c3);

  /* 卡 4：最近修改 */
  const c4 = el('div', 'dcard dcard-recent');
  c4.innerHTML = `<div class="dc-label">最近修改</div>` +
    (recent.length
      ? `<div class="dc-recent">${recent.map((f) =>
          `<div class="dr-row" title="${escHTML(f.name)}"><span class="dr-ic">${iconOf(f)}</span><span class="dr-nm">${escHTML(f.name)}</span><span class="dr-t">${fmtTime(f.mtime)}</span></div>`
        ).join('')}</div>`
      : `<div class="dc-sub">暂无文件</div>`);
  grid.appendChild(c4);

  /* 概览收起状态持久化 */
  const collapsed = localStorage.getItem('fs.dash') === 'off';
  dash.classList.toggle('collapsed', collapsed);
  const tg = $('dashToggle');
  if (tg) tg.textContent = collapsed ? '展开' : '收起';
}

function updateBulkBar() {
  const n = state.selected.size;
  $('bulkCount').textContent = n;
  $('bulkBar').hidden = n === 0;
  const all = $('selAll');
  if (all) all.checked = n > 0 && n >= state.entries.filter((e) => !e.isDir).length;
}

function entryRel(it) { return it.path || (state.path ? state.path + '/' + it.name : it.name); }
function entryUrl(it) {
  return `/api/download?disk=${encodeURIComponent(state.disk)}&path=${encodeURIComponent(entryRel(it))}`;
}

function renderList() {
  const tb = $('fileList');
  const empty = $('empty');
  tb.innerHTML = '';
  tb.className = 'list-body ' + (state.view === 'grid' ? 'grid' : 'list');
  const items = sortedEntries();
  if (!items.length) {
    empty.hidden = false;
    /* 区分四种空态：搜索无结果 / 类型筛选无匹配 / 目录为空 / 私人盘未登录 */
    if (state.searching) {
      $('emptyText').textContent = '没有匹配「' + $('searchInput').value.trim() + '」的内容';
      $('empty').dataset.kind = 'search';
    } else if (state.typeFilter && state.typeFilter !== 'all') {
      $('emptyText').textContent = '当前目录没有该类型的文件';
      $('empty').dataset.kind = 'filter';
    } else if (state.disk === 'private' && !state.user) {
      $('emptyText').textContent = '私人空间需要登录后访问';
      $('empty').dataset.kind = 'auth';
    } else {
      $('emptyText').textContent = '这个目录还是空的';
      $('empty').dataset.kind = 'empty';
    }
    syncTypeBar();
    return;
  }
  empty.hidden = true;
  for (const it of items) {
    const checked = state.selected.has(it.name);
    tb.appendChild(state.view === 'grid' ? renderGridItem(it, checked) : renderListItem(it, checked));
  }
  updateBulkBar();
  renderDash();
}

function makeCheckbox(it, row) {
  const cell = el('div', 'cell-check');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = state.selected.has(it.name);
  cb.onchange = () => {
    if (cb.checked) state.selected.add(it.name);
    else state.selected.delete(it.name);
    row.classList.toggle('checked', cb.checked);
    updateBulkBar();
  };
  cell.appendChild(cb);
  return cell;
}
function makeOps(it) {
  const cell = el('div', 'cell-ops');
  const ops = el('div', 'ops');
  const canWrite = !!state.user;
  const mk = (iconName, tip, fn, cls = '', disabled = false) => {
    const b = el('button', 'op-btn ' + cls);
    b.innerHTML = icon(iconName);
    /* 禁用态给出可读原因，而不是让用户对着灰按钮猜 */
    const label = disabled && !canWrite ? tip + '（需登录）' : tip;
    b.dataset.tip = label;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    ops.appendChild(b);
  };
  if (!it.isDir) mk('eye', '预览', () => openPreview(it));
  mk('dl', '下载', () => download(it));
  mk('info', '信息', () => openPreview(it, true));
  mk('pen', '重命名', () => rename(it), '', !canWrite);
  mk('trash', '删除', () => remove(it), 'del', !canWrite);
  cell.appendChild(ops);
  return cell;
}
function navigate(it) {
  if (it.isDir) {
    state.path = state.path ? state.path + '/' + it.name : it.name;
    state.selected.clear();
    loadList();
  } else openPreview(it);
}

function renderListItem(it, checked) {
  const row = el('div', 'row' + (checked ? ' checked' : ''));
  row.dataset.name = it.name;
  row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openCtxMenu(e.clientX, e.clientY, it); };
  row.appendChild(it.isDir ? el('div', 'cell-check') : makeCheckbox(it, row));

  const nameCell = el('div', 'cell-name');
  const nm = el('div', 'nm');
  const tc = it.isDir ? 'dir' : typeClass(it.name);
  const isImg = !it.isDir && IMAGE_EXTS.has(extOf(it.name));
  if (isImg && it.size < 8 * 1024 * 1024) {
    const img = el('img', 'thumb-s');
    img.loading = 'lazy';
    img.onerror = () => { img.replaceWith(el('span', 'fic ' + tc, iconOf(it))); };
    if (window.nasThumb) window.nasThumb(img, it, () => el('span', 'fic ' + tc, iconOf(it)));
    else img.src = entryUrl(it);
    nm.appendChild(img);
  } else {
    nm.appendChild(el('span', 'fic ' + tc, iconOf(it)));
  }
  const meta = el('div', 'meta');
  meta.appendChild(el('div', 'txt', it.name));
  if (!it.isDir) {
    const TYPE_NAMES = { docx: 'Word 文档', doc: 'Word 文档', xlsx: 'Excel 表格', xls: 'Excel 表格', pptx: 'PPT 演示', ppt: 'PPT 演示', pdf: 'PDF 文档', zip: 'ZIP 压缩包', rar: 'RAR 压缩包', '7z': '7Z 压缩包', txt: '文本文件', md: 'Markdown', csv: 'CSV 数据', eml: '邮件文件', apk: '安卓应用', jpg: '图片', jpeg: '图片', png: '图片', gif: '图片', webp: '图片', mp4: '视频', mkv: '视频', mov: '视频', mp3: '音频', wav: '音频', flac: '音频' };
    const ext2 = extOf(it.name);
    const tname = TYPE_NAMES[ext2] || (ext2 ? ext2.toUpperCase() + ' 文件' : '文件');
    meta.appendChild(el('div', 'sub', tname + ' · ' + fmtSize(it.size) + ' · ' + fmtTime(it.mtime)));
  }
  nm.appendChild(meta);
  nm.onclick = () => navigate(it);
  nameCell.appendChild(nm);
  row.appendChild(nameCell);

  row.appendChild(el('div', 'cell-size', it.isDir ? '—' : fmtSize(it.size)));
  row.appendChild(el('div', 'cell-time', fmtTime(it.mtime)));
  row.appendChild(makeOps(it));
  return row;
}

function renderGridItem(it, checked) {
  const row = el('div', 'row' + (checked ? ' checked' : ''));
  row.dataset.name = it.name;
  row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openCtxMenu(e.clientX, e.clientY, it); };
  row.appendChild(it.isDir ? el('div', 'cell-check') : makeCheckbox(it, row));
  const tc = it.isDir ? 'dir' : typeClass(it.name);
  const isImg = !it.isDir && IMAGE_EXTS.has(extOf(it.name));
  const thumb = el('div', 'thumb');
  if (it.isDir) thumb.appendChild(el('span', 'big-ic', '📁'));
  else if (isImg && it.size < 20 * 1024 * 1024) {
    const img = el('img');
    img.loading = 'lazy';
    img.onerror = () => { img.replaceWith(el('span', 'big-ic', iconOf(it))); };
    if (window.nasThumb) window.nasThumb(img, it, () => el('span', 'big-ic', iconOf(it)));
    else img.src = entryUrl(it);
    thumb.appendChild(img);
  } else {
    const fic = el('span', 'fic ' + tc, iconOf(it));
    fic.style.cssText = 'width:56px;height:56px;font-size:26px;border-radius:14px';
    thumb.appendChild(fic);
  }
  thumb.onclick = () => navigate(it);
  row.appendChild(thumb);
  const label = el('div', 'g-label', it.name);
  label.onclick = () => navigate(it);
  row.appendChild(label);
  return row;
}

/* ============================ 在线预览 ============================ */
let pvCleanup = [];
let pvEntry = null;

async function openPreview(it, showInfo = false) {
  pvEntry = it;
  pvCleanup.forEach((f) => { try { f(); } catch {} });
  pvCleanup = [];
  $('previewModal').hidden = false;
  $('pvName').textContent = it.name;
  $('pvSub').textContent = `${fmtSize(it.size)} · ${fmtTime(it.mtime)}`;
  $('pvIcon').textContent = iconOf(it);
  $('pvDownload').href = entryUrl(it);
  $('pvInfoBox').hidden = !showInfo;
  renderInfoPanel(it);

  const body = $('pvBody');
  body.innerHTML = '';
  const kind = previewKind(it);
  const url = entryUrl(it);
  const loading = el('div', 'txt-view', '加载中…');
  body.appendChild(loading);
  const done = () => { try { loading.remove(); } catch {} };

  if (kind === 'image') {
    const img = el('img');
    img.src = url;
    img.onload = () => { done(); pvEntry._dims = `${img.naturalWidth}×${img.naturalHeight}`; if (!$('pvInfoBox').hidden) renderInfoPanel(pvEntry); };
    img.onerror = () => { done(); body.innerHTML = ''; body.appendChild(unsupported('图片加载失败')); };
    body.appendChild(img);
  } else if (kind === 'video') {
    const v = el('video');
    v.src = url; v.controls = true; v.preload = 'metadata';
    v.onloadedmetadata = () => {
      done();
      pvEntry._media = fmtDuration(v.duration) + (v.videoWidth ? ` · ${v.videoWidth}×${v.videoHeight}` : '');
      if (!$('pvInfoBox').hidden) renderInfoPanel(pvEntry);
    };
    v.onerror = () => { done(); body.innerHTML = ''; body.appendChild(unsupported('此视频编码浏览器不支持（如 hevc），可下载后播放')); };
    body.appendChild(v);
  } else if (kind === 'audio') {
    const a = el('audio');
    a.src = url; a.controls = true;
    a.onloadedmetadata = () => { done(); pvEntry._media = fmtDuration(a.duration); if (!$('pvInfoBox').hidden) renderInfoPanel(pvEntry); };
    body.appendChild(a); done();
  } else if (kind === 'pdf') {
    body.appendChild(el('iframe', '', '')); 
    body.querySelector('iframe').src = url;
    done();
  } else if (kind === 'text' || kind === 'md' || kind === 'csv') {
    if (it.size > 8 * 1024 * 1024) { done(); body.innerHTML = ''; body.appendChild(unsupported('文件过大（>8MB），请下载查看')); return; }
    fetch(url, { credentials: 'same-origin' })
      .then((r) => r.text())
      .then((text) => {
        done(); body.innerHTML = '';
        if (kind === 'csv') body.appendChild(renderCSV(text, extOf(it.name) === 'tsv' ? '\t' : ','));
        else if (kind === 'md') body.appendChild(renderMD(text));
        else body.appendChild(el('div', 'txt-view', text.slice(0, 2 * 1024 * 1024)));
      })
      .catch(() => { done(); body.innerHTML = ''; body.appendChild(unsupported('加载失败')); });
  } else if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'doc' || kind === 'epub' || kind === 'font') {
    /* office.js（747 行）只在预览 Office 文件时需要 → 按需加载，不进首屏 */
    try { await ensure('/office.js'); } catch { /* 下面按函数缺失处理 */ }
    const fn = typeof renderDOCX === 'function'
      ? { docx: renderDOCX, xlsx: renderXLSX, pptx: renderPPTX, doc: renderDOC, epub: renderEPUB, font: renderFONT }[kind]
      : null;
    if (!fn) {
      body.innerHTML = '';
      body.appendChild(unsupported('预览组件加载失败，请检查网络后重试'));
      return;
    }
    done();
    fn(it, body).catch((e) => {
      body.innerHTML = '';
      body.appendChild(unsupported('预览失败：' + e.message));
    });
  } else if (kind === 'zip') {
    done();
    renderZipView(it, body);
  } else {
    done(); body.innerHTML = '';
    const ext = extOf(it.name).toUpperCase() || '';
    const box = unsupported(ext ? `.${ext} 格式暂不支持在线预览` : '此文件不支持在线预览');
    const tip = el('div', '', '可下载后本地打开，或点 ⓘ 查看文件信息');
    tip.style.marginTop = '8px';
    box.appendChild(tip);
    body.appendChild(box);
  }
}
function closePreview() {
  $('previewModal').hidden = true;
  $('pvBody').innerHTML = '';
  pvCleanup.forEach((f) => { try { f(); } catch {} });
  pvCleanup = [];
}
function unsupported(msg) {
  const d = el('div', 'unsupported');
  d.appendChild(el('div', 'u-ic', '📦'));
  d.appendChild(el('div', '', msg));
  return d;
}
function fmtDuration(sec) {
  if (!isFinite(sec)) return '';
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}

function renderInfoPanel(it) {
  const box = $('pvInfoBox');
  box.innerHTML = '';
  const rows = [];
  const add = (k, v, clickable) => {
    const row = el('div', 'info-row');
    row.appendChild(el('span', 'k', k));
    const vv = el('span', 'v' + (clickable ? ' clickable' : ''), v);
    if (clickable) vv.onclick = () => navigator.clipboard.writeText(v).then(() => toast('已复制', 'ok'));
    row.appendChild(vv);
    box.appendChild(row);
    rows.push(vv);
  };
  add('类型', it.isDir ? '文件夹' : ((extOf(it.name).toUpperCase() || '文件') + ' 文件'));
  add('大小', fmtSize(it.size) + ` (${it.size.toLocaleString()} 字节)`);
  add('修改时间', fmtTime(it.mtime));
  add('路径', '/' + entryRel(it), true);
  if (it._dims) add('分辨率', it._dims);
  if (it._media) add('时长/规格', it._media);
  add('SHA-256', '计算中…');
  api(`/api/checksum?disk=${encodeURIComponent(state.disk)}&path=${encodeURIComponent(entryRel(it))}`)
    .then((d) => { if (pvEntry === it) rows[rows.length - 1].textContent = d.sha256; })
    .catch(() => { if (pvEntry === it) rows[rows.length - 1].textContent = '计算失败'; });
}

/* ----- Markdown / CSV / ZIP ----- */
/* HTML 转义。R6-6-1：原先只转义 & < > —— 但本函数被用在**属性上下文**
   （如 app.js:661 的 title="${escHTML(f.name)}"、netdiag 的 option value），
   文件名里一个双引号就能逃出属性、注入事件处理器（x" onmouseover="alert(1)）。
   补上 " 与 ' 的转义后，属性/文本两种上下文都安全。 */
function escHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderMD(src) {
  const div = el('div', 'md-view');
  let html = '', inCode = false, inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  const inline = (s) => escHTML(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  for (const line of src.split('\n')) {
    if (line.startsWith('```')) { closeList(); html += inCode ? '</code></pre>' : '<pre><code>'; inCode = !inCode; continue; }
    if (inCode) { html += escHTML(line) + '\n'; continue; }
    const h = /^(#{1,6})\s+(.*)/.exec(line);
    if (h) { closeList(); const l = Math.min(h[1].length, 4); html += `<h${l}>${inline(h[2])}</h${l}>`; continue; }
    if (/^\s*[-*+]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`; continue;
    }
    closeList();
    if (!line.trim()) { html += '<br>'; continue; }
    if (line.startsWith('> ')) { html += `<blockquote>${inline(line.slice(2))}</blockquote>`; continue; }
    html += inline(line) + '<br>';
  }
  if (inCode) html += '</code></pre>';
  closeList();
  div.innerHTML = html;
  return div;
}
function parseCSVLine(line, sep) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function renderCSV(text, sep) {
  const div = el('div', 'csv-view');
  const table = el('table');
  text.split('\n').filter((l) => l !== '').slice(0, 2000).forEach((line, i) => {
    const tr = el('tr');
    for (const cell of parseCSVLine(line, sep)) tr.appendChild(el(i === 0 ? 'th' : 'td', '', cell));
    table.appendChild(tr);
  });
  div.appendChild(table);
  return div;
}

async function renderZipView(entry, body) {
  /* offZipOpen 来自 office.js —— 按需加载（zip 预览才用得到） */
  try { await ensure('/office.js'); } catch { /* 下面按缺失处理 */ }
  const view = el('div', 'zip-view');
  view.appendChild(el('div', '', '解析压缩包目录…'));
  body.innerHTML = '';
  body.appendChild(view);
  try {
    const zf = await offZipOpen(entry);  // 复用统一读取器（GBK/UTF-8 文件名自适应）
    const records = zf.list();
    view.innerHTML = '';
    view.appendChild(el('div', '', `${records.length} 个条目 · 点击文本/图片文件可直接预览内容`));
    for (const r of records) {
      if (r.name.endsWith('/')) continue;
      const row = el('div', 'z-row');
      row.appendChild(el('span', '', EXT_MAP[extOf(r.name)] || '📄'));
      row.appendChild(el('span', 'z-name', r.name));
      row.appendChild(el('span', 'z-size', fmtSize(r.size)));
      row.onclick = () => previewZipInner(entry, r).catch((e) => toast('解压失败：' + e.message + '（请重试）', 'bad'));
      view.appendChild(row);
    }
    entry._zip = zf;
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(unsupported('解析失败：' + e.message));
  }
}
async function fetchRange(url, start, end) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: 'same-origin' });
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } catch (e) {
      lastErr = e;
      await new Promise((r2) => setTimeout(r2, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}
async function previewZipInner(entry, record) {
  const body = $('pvBody');
  const url = entryUrl(entry);
  // local header（30B + 文件名 + extra）
  const head = new Uint8Array(await fetchRange(url, record.lho, record.lho + 29));
  const hdv = new DataView(head.buffer);
  if (hdv.getUint32(0, true) !== 0x04034b50) throw new Error('local header 损坏');
  const dataStart = record.lho + 30 + hdv.getUint16(26, true) + hdv.getUint16(28, true);
  const raw = await fetchRange(url, dataStart, dataStart + record.csize - 1);
  let bytes;
  if (record.method === 0) bytes = raw;
  else if (record.method === 8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压');
    bytes = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  } else throw new Error('压缩方法 ' + record.method + ' 不支持');

  const ext = extOf(record.name);
  const keep = $('pvName').textContent;
  if (ext === 'eml') {
    body.innerHTML = '';
    await renderEMLBytes(bytes, body);
    return;
  }
  if (IMAGE_EXTS.has(ext)) {
    const img = el('img');
    img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/' + (ext === 'svg' ? 'svg+xml' : ext) }));
    pvCleanup.push(() => URL.revokeObjectURL(img.src));
    body.innerHTML = ''; body.appendChild(img);
  } else if (TEXT_EXTS.has(ext) || MD_EXTS.has(ext) || CSV_EXTS.has(ext) || !ext) {
    const text = new TextDecoder().decode(bytes.slice(0, 1024 * 1024));
    body.innerHTML = '';
    if (MD_EXTS.has(ext)) body.appendChild(renderMD(text));
    else if (CSV_EXTS.has(ext)) body.appendChild(renderCSV(text, ext === 'tsv' ? '\t' : ','));
    else body.appendChild(el('div', 'txt-view', text));
  } else {
    body.innerHTML = '';
    body.appendChild(unsupported(`压缩包内 .${ext} 文件不支持在线预览`));
  }
  $('pvName').textContent = keep + ' → ' + record.name;
}

/* ============================ 下载引擎 ============================ */
const DL_DIRECT_LIMIT = 8 * 1024 * 1024;
const DL_CHUNK = 4 * 1024 * 1024;

/* ---------------------------------------------------------------------
   下载断点续传缓存（IndexedDB）
   记录已完成分片，中断后重新下载同文件可跳过已下载部分。
   键：`${disk}:${path}`；值：{ size, mtime, chunkSize, chunks: {idx: ArrayBuffer}, ts }
   --------------------------------------------------------------------- */
const DL_RESUME = (() => {
  const DB = 'fs-resume';
  const STORE = 'parts';
  const TTL = 3 * 24 * 3600 * 1000;   // 3 天过期
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbp;
  };
  const tx = async (mode) => {
    const db = await open();
    if (!db) return null;
    try { return db.transaction(STORE, mode).objectStore(STORE); } catch (e) { return null; }
  };
  return {
    async get(key) {
      const st = await tx('readonly');
      if (!st) return null;
      return new Promise((resolve) => {
        try {
          const r = st.get(key);
          r.onsuccess = () => {
            const v = r.result;
            if (!v || (Date.now() - (v.ts || 0) > TTL)) return resolve(null);
            resolve(v);
          };
          r.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    },
    async put(key, val) {
      const st = await tx('readwrite');
      if (!st) return;
      try { st.put(val, key); } catch (e) {}
    },
    async del(key) {
      const st = await tx('readwrite');
      if (!st) return;
      try { st.delete(key); } catch (e) {}
    },
    /** 清理全部过期条目 */
    async prune() {
      const st = await tx('readwrite');
      if (!st) return;
      try {
        st.openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (!c) return;
          if (Date.now() - (c.value.ts || 0) > TTL) c.delete();
          c.continue();
        };
      } catch (e) {}
    },
  };
})();

/* ---------------------------------------------------------------------
   传输调优（实测结论，勿随意调大）：
   本机到手机的链路为 2.4GHz WiFi，实测吞吐：
     1 并发 = 1.7 MB/s · 2 并发 = 2.2 MB/s（峰值）· 4 并发 = 1.1 · 6 并发 = 0.7
   即 HTTP/1.1 单域 6 连接上限 + WiFi 竞争导致并发越高越慢。
   因此并发数必须自适应，不能硬编码 64。
   --------------------------------------------------------------------- */
const NET = {
  threads: 2,          // 自适应并发（初值保守，探测后调整）
  maxThreads: 6,       // 上限：浏览器 HTTP/1.1 单域限制
  probed: false,
};

/** 探测最优并发：短时试跑 1/2/4 并发，取吞吐最高者（结果缓存一次会话） */
async function probeThreads(url, size) {
  if (NET.probed || size < 32 * 1024 * 1024) return;
  NET.probed = true;
  const probeSize = 2 * 1024 * 1024;
  const test = async (n) => {
    const t0 = performance.now();
    const jobs = [];
    for (let i = 0; i < n; i++) {
      const off = 1024 * 1024 + i * 4 * 1024 * 1024;
      jobs.push(fetch(url, {
        headers: { Range: `bytes=${off}-${off + probeSize - 1}` },
        credentials: 'same-origin',
      }).then((r) => r.arrayBuffer()).catch(() => new ArrayBuffer(0)));
    }
    const bufs = await Promise.all(jobs);
    const ms = performance.now() - t0;
    const bytes = bufs.reduce((s, b) => s + b.byteLength, 0);
    return bytes / 1048576 / (ms / 1000);   // MB/s
  };
  try {
    const r1 = await test(1);
    const r2 = await test(2);
    const r4 = await test(4);
    const best = Math.max(r1, r2, r4);
    NET.threads = best === r1 ? 1 : best === r2 ? 2 : 4;
    console.debug(`[NAS] 并发探测: 1=${r1.toFixed(1)} 2=${r2.toFixed(1)} 4=${r4.toFixed(1)} MB/s → 采用 ${NET.threads}`);
  } catch { /* 探测失败保留保守值 */ }
}

async function download(entry) {
  const url = entryUrl(entry);
  const size = +entry.size || 0;
  if (!size || size <= DL_DIRECT_LIMIT) {
    const a = document.createElement('a');
    a.href = url; a.download = entry.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    return;
  }
  const task = addTask(entry.name, 'download');
  const resumeKey = `${state.disk}:${state.path || ''}/${entry.name}:${size}`;
  try {
    await probeThreads(url, size);
    /* 分片大小随文件自适应：小文件少分片，大文件 4MB 片 */
    const chunkSize = Math.min(DL_CHUNK, Math.max(512 * 1024, Math.ceil(size / 512)));
    const totalChunks = Math.ceil(size / chunkSize);
    const parts = new Array(totalChunks);

    /* ---- 断点续传：读取上次中断时的已下载分片 ---- */
    let resumed = 0;
    try {
      const saved = await DL_RESUME.get(resumeKey);
      if (saved && saved.chunkSize === chunkSize && saved.chunks) {
        for (const k of Object.keys(saved.chunks)) {
          const idx = +k;
          if (idx < totalChunks && saved.chunks[k] && saved.chunks[k].byteLength) {
            parts[idx] = saved.chunks[k];
            resumed += saved.chunks[k].byteLength;
          }
        }
        if (resumed) {
          task.meta.textContent = `续传：已恢复 ${fmtSize(resumed)}`;
        }
      }
    } catch (e) { /* 续传不可用则全量下载 */ }

    let loadedTotal = resumed;
    if (resumed) updateTask(task, loadedTotal, size);
    const sem = new Semaphore(Math.min(NET.threads, totalChunks));
    let issued = 0;
    /* 已完成分片计数，用于持久化节流 */
    let sinceSave = 0;
    const persist = async () => {
      const chunks = Object.create(null);
      for (let i = 0; i < totalChunks; i++) if (parts[i]) chunks[i] = parts[i];
      await DL_RESUME.put(resumeKey, { size, chunkSize, chunks, ts: Date.now() });
    };
    const worker = async () => {
      while (true) {
        const i = issued++;
        if (i >= totalChunks || task.cancelled) break;
        if (parts[i]) continue;                       // 续传：跳过已恢复分片
        await sem.acquire();
        try {
          const start = i * chunkSize;
          const end = Math.min(size, start + chunkSize) - 1;
          const len = end - start + 1;
          for (let attempt = 0; attempt <= 3 && !parts[i] && !task.cancelled; attempt++) {
            try {
              const controller = new AbortController();
              task.controllers.push(controller);
              const resp = await fetch(url, {
                headers: { Range: `bytes=${start}-${end}` },
                credentials: 'same-origin', signal: controller.signal,
              });
              if (!resp.ok && resp.status !== 206) throw new Error('HTTP ' + resp.status);
              const buf = await resp.arrayBuffer();
              if (buf.byteLength !== len) throw new Error('长度不符');
              parts[i] = buf;
              loadedTotal += len;
              updateTask(task, loadedTotal, size);
              /* 每 8 个分片持久化一次进度（避免频繁写 IndexedDB） */
              if (++sinceSave >= 8) { sinceSave = 0; persist(); }
            } catch (e) {
              if (task.cancelled) break;
              if (attempt === 3) throw e;
              await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
            }
          }
        } finally { sem.release(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(NET.threads, totalChunks) }, worker));
    if (task.cancelled) throw new Error('cancelled');
    task.meta.textContent = '合并中…';
    task.box.classList.add('indeterminate');
    await new Promise((r) => setTimeout(r, 30));
    saveBlob(new Blob(parts, { type: 'application/octet-stream' }), entry.name);
    task.box.classList.remove('indeterminate');
    DL_RESUME.del(resumeKey);   // 下载完成，清掉续传缓存
    finishTask(task, 'done', fmtSize(size) + ' · 完成' + (resumed ? `（续传 ${fmtSize(resumed)}）` : ''));
  } catch (e) {
    if (task.cancelled) {
      /* 取消时保留已下载分片，下次可续传 */
      finishTask(task, 'cancelled', '已取消（已保留进度，可续传）');
      return;
    }
    finishTask(task, 'err', '下载失败：' + (e.message || e));
  }
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

/* ============================ 上传引擎 ============================ */
const UP_CHUNK = 4 * 1024 * 1024;
/* 上传并发沿用下载探测结果（同一链路，吞吐特性一致） */
const upThreads = () => Math.max(1, Math.min(NET.threads, NET.maxThreads));

/**
 * 计算文件 SHA-256（优先 Web Crypto；>1GB 或不可用时返回空串，服务端跳过校验）
 * @param {File} file
 * @returns {Promise<string>} hex 或 ''
 */
async function sha256OfFile(file) {
  if (!crypto.subtle) return '';
  try {
    if (file.size <= 1024 * 1024 * 1024) {
      const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { /* 内存不足等情况退回空串 */ }
  return '';
}

async function uploadFiles(fileList) {
  if (!state.user) { toast('请先登录再上传', 'bad'); openAuth('login'); return; }
  if (!fileList || !fileList.length) return;
  const threshold = (state.capabilities && state.capabilities.chunkThresholdMB * 1024 * 1024) || UP_CHUNK;
  let ok = 0, bad = 0;
  await Promise.all(Array.from(fileList).map(async (f) => {
    try {
      if (f.size > threshold) await chunkUpload(f);
      else await simpleUpload(f);
      ok++;
    } catch (e) { if (!(e && e.cancelled)) bad++; }
  }));
  if (bad === 0 && ok) toast(`上传完成：${ok} 个文件`, 'ok');
  else if (bad) toast(`成功 ${ok}，失败 ${bad}`, 'bad');
  loadList();
}
function simpleUpload(file) {
  return new Promise((resolve, reject) => {
    const task = addTask(file.name, 'upload');
    task.total = file.size;
    const fd = new FormData();
    fd.append('disk', state.disk);
    fd.append('path', state.path);
    fd.append('files', file, file.name);
    const xhr = new XMLHttpRequest();
    task.xhrs.push(xhr);
    xhr.open('POST', '/api/upload', true);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) updateTask(task, e.loaded, e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && body && body.uploaded && body.uploaded.length) {
        finishTask(task, 'done', fmtSize(file.size) + ' · 完成'); resolve(true);
      } else {
        const msg = (body && body.error) || ('HTTP ' + xhr.status);
        finishTask(task, 'err', '失败：' + msg); reject(new Error(msg));
      }
    };
    xhr.onerror = () => { finishTask(task, 'err', '网络错误'); reject(new Error('网络错误')); };
    xhr.onabort = () => { finishTask(task, 'cancelled', '已取消'); reject({ cancelled: true }); };
    setTimeout(() => xhr.send(fd), 20);
  });
}
async function chunkUpload(file) {
  const task = addTask(file.name, 'upload');
  task.total = file.size;
  try {
    /* ---- 秒传预检：先算 SHA-256，命中服务端已有文件则跳过全部传输 ---- */
    let digest = null;
    try {
      task.meta.textContent = '计算指纹…';
      digest = await sha256OfFile(file);
      if (digest) task.meta.textContent = '指纹已生成';
    } catch (e) { digest = null; }

    const init = await jsonPost('/api/chunk-init', {
      disk: state.disk, path: state.path, name: file.name, size: file.size, chunkSize: UP_CHUNK,
      sha256: digest,
    });
    /* 秒传命中：服务端已复制完成，无需传输任何分片 */
    if (init.instant) {
      task.fill.style.width = '100%';
      task.pct.textContent = '100%';
      finishTask(task, 'done', `⚡ 秒传 · ${fmtSize(file.size)} 未传输`);
      toast(`⚡ 秒传：${file.name}（${fmtSize(file.size)} 未传输）`, 'ok');
      return;
    }
    const uploadId = init.uploadId;
    task.uploadId = uploadId;
    const totalChunks = Math.ceil(file.size / UP_CHUNK);
    const sem = new Semaphore(upThreads());
    let issued = 0, loadedTotal = 0;
    const worker = async () => {
      while (true) {
        const i = issued++;
        if (i >= totalChunks || task.cancelled) break;
        await sem.acquire();
        try {
          const blob = file.slice(i * UP_CHUNK, Math.min(file.size, (i + 1) * UP_CHUNK));
          const len = blob.size;
          for (let attempt = 0; attempt <= 3 && !task.cancelled; attempt++) {
            try {
              const r = await fetch(`/api/chunk-data?uploadId=${uploadId}&index=${i}`, {
                method: 'PUT', body: blob, credentials: 'same-origin',
                headers: { 'Content-Type': 'application/octet-stream' },
              });
              if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                throw new Error(e.error || ('HTTP ' + r.status));
              }
              loadedTotal += len;
              updateTask(task, loadedTotal, file.size);
              break;
            } catch (e) {
              if (task.cancelled) break;
              if (attempt === 3) throw e;
              await new Promise((r2) => setTimeout(r2, 300 * (attempt + 1)));
            }
          }
        } finally { sem.release(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(upThreads(), totalChunks) }, worker));
    if (task.cancelled) throw new Error('cancelled');
    task.meta.textContent = '校验中…';
    task.box.classList.add('indeterminate');
    const doneR = await jsonPost('/api/chunk-complete', { uploadId, sha256: digest });
    task.box.classList.remove('indeterminate');
    finishTask(task, 'done', `${fmtSize(file.size)} · ${doneR.seconds || ''}完成`);
  } catch (e) {
    if (task.cancelled) {
      try { await jsonPost('/api/chunk-cancel', { uploadId: task.uploadId }); } catch {}
      finishTask(task, 'cancelled', '已取消');
      throw { cancelled: true };
    }
    try { if (task.uploadId) await jsonPost('/api/chunk-cancel', { uploadId: task.uploadId }); } catch {}
    finishTask(task, 'err', '上传失败：' + (e.message || e));
    throw e;
  }
}
/* ============================ 批量操作 ============================ */
async function bulkZip() {
  const paths = [...state.selected];
  if (!paths.length) return;
  toast(`打包 ${paths.length} 项…`);
  try {
    const r = await fetch('/api/zip', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disk: state.disk, paths }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
    saveBlob(await r.blob(), `Files-${paths.length}项-${Date.now()}.zip`);
    toast('打包下载已开始', 'ok');
  } catch (e) { toast('打包失败：' + e.message, 'bad'); }
}
async function bulkDelete() {
  const paths = [...state.selected];
  if (!paths.length) return;
  if (!state.user) { toast('请先登录', 'bad'); openAuth('login'); return; }
  if (!(await uiConfirm('批量删除', `确定删除选中的 ${paths.length} 项？此操作不可恢复！`, '删除'))) return;
  let ok = 0, bad = 0;
  for (const p of paths) {
    try {
      await jsonPost('/api/delete', { disk: state.disk, path: state.path ? state.path + '/' + p : p });
      ok++;
    } catch { bad++; }
  }
  state.selected.clear();
  updateBulkBar();
  toast(`删除完成：成功 ${ok}${bad ? '，失败 ' + bad : ''}`, bad ? 'bad' : 'ok');
  loadList();
}

/* ============================ 批量移动 / 复制 ============================ */
/** 目标目录选择器：输入相对路径（支持斜杠分层），留空为当前盘根目录 */
async function bulkTransfer(mode) {
  const paths = [...state.selected];
  if (!paths.length) return;
  if (!state.user) { toast('请先登录', 'bad'); openAuth('login'); return; }
  const verb = mode === 'move' ? '移动' : '复制';
  const dest = await uiPrompt(
    `批量${verb}到`,
    state.path ? state.path : '',
    '目标目录（如 photos/2026，留空为根目录）'
  );
  if (dest === null) return;
  const target = dest.trim().replace(/^\/+|\/+$/g, '');
  /* 防呆：不能移动到自身所在目录 */
  if (target === state.path) { toast(`目标目录与当前目录相同，无需${verb}`, 'bad'); return; }

  let ok = 0, bad = 0, lastErr = '';
  for (const p of paths) {
    const from = state.path ? state.path + '/' + p : p;
    const to = target ? target + '/' + p : p;
    if (from === to) { bad++; lastErr = '目标与源相同'; continue; }
    try {
      await jsonPost(mode === 'move' ? '/api/move' : '/api/copy', { disk: state.disk, path: from, dest: to });
      ok++;
    } catch (e) { bad++; lastErr = e.message || ''; }
  }
  state.selected.clear();
  updateBulkBar();
  toast(`${verb}完成：成功 ${ok}${bad ? '，失败 ' + bad + (lastErr ? '（' + lastErr + '）' : '') : ''}`, bad ? 'bad' : 'ok');
  loadList();
}

/* ============================ 搜索 / 文件操作 ============================ */
let searchTimer = null;
let searchSeq = 0;

/** 搜索：防抖实时触发（300ms），带加载态与结果计数 */
function scheduleSearch() {
  clearTimeout(searchTimer);
  const kw = $('searchInput').value.trim();
  if (!kw) {
    state.searching = false;
    setSearchCount(0, '');
    loadList();
    return;
  }
  searchTimer = setTimeout(doSearch, 300);
}

async function doSearch() {
  const kw = $('searchInput').value.trim();
  if (!kw) { loadList(); return; }
  const seq = ++searchSeq;
  setListLoading(true);
  try {
    const d = await api(`/api/search?disk=${encodeURIComponent(state.disk)}&q=${encodeURIComponent(kw)}`);
    if (seq !== searchSeq) return;              // 竞态保护：丢弃过期响应
    state.entries = d.results || [];
    state.searching = true;
    renderBreadcrumb(state.path);
    const bc = $('breadcrumb');
    bc.appendChild(el('span', 'sep', '/'));
    bc.appendChild(el('span', 'cur', `搜索「${kw}」`));
    renderList();
    setSearchCount(state.entries.length, kw);
  } catch (e) {
    if (seq === searchSeq) toast(e.message, 'bad');
  } finally {
    if (seq === searchSeq) setListLoading(false);
  }
}

/** 搜索结果计数徽章 */
function setSearchCount(n, kw) {
  let badge = $('searchCount');
  if (!badge) {
    badge = el('div', 'search-count');
    badge.id = 'searchCount';
    document.querySelector('.toolbar').appendChild(badge);
  }
  if (!kw) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.textContent = n ? `找到 ${n} 项` : '无匹配';
  badge.className = 'search-count' + (n ? '' : ' none');
}

/** 列表加载骨架 */
function setListLoading(on) {
  const tb = $('fileList');
  if (on) {
    tb.setAttribute('aria-busy', 'true');
    if (!state.entries.length) {
      tb.innerHTML = '';
      for (let i = 0; i < 5; i++) tb.appendChild(el('div', 'skel-row'));
    } else {
      tb.classList.add('loading');
    }
  } else {
    tb.removeAttribute('aria-busy');
    tb.classList.remove('loading');
  }
}
async function rename(it) {
  const name = await uiPrompt('重命名', it.name, '输入新名称');
  if (name === null || name === it.name) return;
  jsonPost('/api/rename', { disk: state.disk, path: entryRel(it), name })
    .then(() => { toast('重命名成功', 'ok'); loadList(); })
    .catch((e) => toast(e.message, 'bad'));
}
async function remove(it) {
  const ok = await uiConfirm('删除' + (it.isDir ? '目录' : '文件'),
    it.isDir ? `将删除目录「${it.name}」及其全部内容，不可恢复！` : `将删除「${it.name}」，不可恢复！`, '删除');
  if (!ok) return;
  jsonPost('/api/delete', { disk: state.disk, path: entryRel(it) })
    .then(() => { toast('已删除', 'ok'); state.selected.delete(it.name); updateBulkBar(); loadList(); })
    .catch((e) => toast(e.message, 'bad'));
}
async function mkdir() {
  if (!state.user) { toast('请先登录', 'bad'); openAuth('login'); return; }
  const name = await uiPrompt('新建目录', '', '输入目录名称');
  if (name === null) return;
  jsonPost('/api/mkdir', { disk: state.disk, path: state.path, name })
    .then(() => { toast('目录已创建', 'ok'); loadList(); })
    .catch((e) => toast(e.message, 'bad'));
}
function updateHint() {
  $('hint').textContent = state.user
    ? '点文件名在线预览（图片/视频/音频/PDF/文本/MD/CSV/ZIP）；勾选后可批量打包下载。大文件自动 64 线程并发传输。'
    : '游客模式：可浏览、下载、预览公共盘。登录后可上传、管理文件并使用私人空间。';
}
function setupUrlHint() {
  const h = $('urlHint');
  if (!h) return;                     /* v5 外壳已无此元素，安全跳过 */
  const here = window.location.origin;
  const isTLS = location.protocol === 'https:';
  h.innerHTML = `${isTLS ? '🔒' : ''} ${here}`;
  h.hidden = false;
  h.title = '点击复制地址';
  h.onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText(here).then(() => toast('地址已复制', 'ok')); };
}

/* ============================ 事件绑定 ============================ */
function bind() {
  $('themeBtn').onclick = toggleTheme;

  document.querySelectorAll('.scope-btn').forEach((b) => { b.onclick = () => switchDisk(b.dataset.scope); });
  $('btnRefresh').onclick = () => {
    state.searching = false;
    state.typeFilter = 'all';
    $('searchInput').value = '';
    setSearchCount(0, '');
    syncTypeBar();
    loadList();
  };

  /* 类型快速筛选 chips */
  const typeBar = $('typeBar');
  if (typeBar) {
    typeBar.querySelectorAll('.tchip').forEach((b) => {
      b.onclick = () => {
        state.typeFilter = b.dataset.type;
        state.selected.clear();
        syncTypeBar();
        renderList();
      };
    });
  }
  $('btnMkdir').onclick = mkdir;
  $('btnUpload').onclick = () => {
    if (!state.user) { toast('请先登录', 'bad'); openAuth('login'); return; }
    $('fileInput').click();
  };
  $('fileInput').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };
  $('btnView').onclick = () => {
    state.view = state.view === 'list' ? 'grid' : 'list';
    localStorage.setItem('fs.view', state.view);
    $('btnView').innerHTML = icon(state.view === 'list' ? 'grid' : 'list');
    renderList();
  };
  $('btnView').innerHTML = icon(state.view === 'list' ? 'grid' : 'list');

  /* 高级功能菜单（panels.js）—— v5：挂到外壳主区，入口随当前模块可见 */
  const moreMenu = document.createElement('div');
  moreMenu.className = 'more-menu';
  moreMenu.hidden = true;
  (document.querySelector('.shell-main') || document.body).appendChild(moreMenu);
  const MORE_ITEMS = [
    ['🛰 工作站总览', () => window.Shell && Shell.go('#/')],
    ['🗑 回收站', panelRecycle],
    ['🕘 历史版本', () => panelVersions(null)],
    ['🔗 共享链接', () => panelShares(null)],
    ['⏱ 定时任务', panelJobs],
    ['❤ 系统健康', panelHealth],
    ['🔎 全文检索', panelSearch],
    ['🧬 重复文件', panelDedup],
    ['📜 操作审计', panelAudit],
    ['🛡 安全中心', () => window.panelSecurity && panelSecurity()],
    ['📡 运维监控', () => window.panelOps && panelOps()],
    ['🌐 网络诊断', () => window.panelNetDiag()],
  ];
  for (const [label, fn] of MORE_ITEMS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { moreMenu.hidden = true; fn(); };
    moreMenu.appendChild(b);
  }
  /* 菜单定位：默认右对齐（顶栏按钮）；align='left' 时贴锚点左侧（文件 rail 在左） */
  function toggleMore(anchorEl, align) {
    const r = anchorEl.getBoundingClientRect();
    moreMenu.style.top = (r.bottom + 6) + 'px';
    if (align === 'left') {
      moreMenu.style.right = 'auto';
      moreMenu.style.left = Math.max(8, r.left) + 'px';
    } else {
      moreMenu.style.left = 'auto';
      moreMenu.style.right = '16px';
    }
    moreMenu.hidden = !moreMenu.hidden;
  }
  $('btnMore').onclick = (e) => {
    e.stopPropagation();
    toggleMore($('btnMore'));           /* 行为与改动前完全一致 */
  };
  /* 文件模块左侧 rail 的「文件工具」按钮：此前零接线，点了没反应 */
  const railMore = $('railMore');
  if (railMore) {
    railMore.onclick = (e) => {
      e.stopPropagation();
      toggleMore(railMore, 'left');
    };
  }
  document.addEventListener('click', (e) => {
    if (!moreMenu.hidden && !moreMenu.contains(e.target)) moreMenu.hidden = true;
  });

  document.querySelectorAll('.list-head .sort').forEach((th) => {
    th.onclick = () => {
      const col = th.dataset.sort;
      if (state.sort.col === col) state.sort.dir *= -1;
      else state.sort = { col, dir: 1 };
      renderSortIndicators();
      renderList();
    };
  });
  $('selAll').onchange = (e) => {
    state.selected.clear();
    if (e.target.checked) for (const it of state.entries) if (!it.isDir) state.selected.add(it.name);
    renderList();
  };
  $('bulkZip').onclick = bulkZip;
  $('bulkMove').onclick = () => bulkTransfer('move');
  $('bulkCopy').onclick = () => bulkTransfer('copy');
  $('bulkDel').onclick = bulkDelete;
  $('bulkCancel').onclick = () => { state.selected.clear(); updateBulkBar(); renderList(); };

  /* 概览收起/展开 */
  const dashToggle = $('dashToggle');
  if (dashToggle) {
    dashToggle.onclick = () => {
      const d = $('dash');
      const off = !d.classList.contains('collapsed');
      d.classList.toggle('collapsed', off);
      localStorage.setItem('fs.dash', off ? 'off' : 'on');
      dashToggle.textContent = off ? '展开' : '收起';
    };
  }

  $('pvClose').onclick = closePreview;
  $('pvInfo').onclick = () => {
    const box = $('pvInfoBox');
    box.hidden = !box.hidden;
    if (!box.hidden && pvEntry) renderInfoPanel(pvEntry);
  };
  $('previewModal').onclick = (e) => { if (e.target === $('previewModal')) closePreview(); };

  $('searchInput').onkeydown = (e) => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); doSearch(); }
    if (e.key === 'Escape') { $('searchInput').value = ''; state.searching = false; setSearchCount(0, ''); loadList(); }
  };
  /* 实时搜索：输入即防抖触发，无需回车 */
  $('searchInput').oninput = () => scheduleSearch();
  $('searchInput').onsearch = () => { clearTimeout(searchTimer); doSearch(); };
  $('taskClear').onclick = () => {
    for (const t of [...tasks.values()]) {
      if (t.finalised) { t.box.remove(); tasks.delete(t.uid); }
      else cancelTask(t);
    }
    refreshTaskCount();
  };

  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setTab(t.dataset.tab); });
  $('closeAuth').onclick = closeAuth;
  $('guestBtn').onclick = () => { closeAuth(); switchDisk('public'); toast('游客模式：仅可浏览与下载'); };
  $('authForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const mode = $('authForm').dataset.mode || 'login';
    $('authErr').textContent = '';
    try {
      let d = await jsonPost(mode === 'login' ? '/api/login' : '/api/register', {
        username: $('authUser').value.trim(), password: $('authPass').value,
      });
      if (d.need2fa) {
        const code = await uiPrompt('两步验证', '', '输入 6 位动态验证码');
        if (!code) { $('authErr').textContent = '已取消：该账号开启了两步验证'; return; }
        d = await jsonPost('/api/login', {
          username: $('authUser').value.trim(), password: $('authPass').value, totp: code.trim(),
        });
      }
      state.user = d.user;
      closeAuth();
      renderUserArea();
      loadDisks();
      updateHint();
      toast(mode === 'login' ? `欢迎回来，${d.user.username}` : `注册成功，${d.user.username}`, 'ok');
      loadList();
    } catch (e) { $('authErr').textContent = e.message; }
  };

  const dz = $('dropzone');
  const layer = $('droplayer');
  let depth = 0;
  dz.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; layer.classList.add('on'); });
  dz.addEventListener('dragover', (e) => e.preventDefault());
  dz.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; layer.classList.remove('on'); } });
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; layer.classList.remove('on');
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    if (!state.user) return;
    const files = [];
    for (const item of (e.clipboardData && e.clipboardData.items) || []) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f.name.includes('.') ? f : new File([f], `clipboard-${Date.now()}.png`, { type: f.type }));
      }
    }
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });

  document.addEventListener('keydown', (e) => {
    const inField = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    /* Ctrl/Cmd + F 聚焦搜索 */
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('searchInput').focus(); $('searchInput').select(); return; }
    /* Ctrl/Cmd + A 全选文件 */
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !inField) {
      e.preventDefault();
      state.selected.clear();
      for (const it of state.entries) if (!it.isDir) state.selected.add(it.name);
      renderList();
      return;
    }
    /* Ctrl/Cmd + R 刷新（避免浏览器整页刷新） */
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); loadList(); return; }
    if (inField) return;
    if (e.key === 'Escape') {
      closeCtxMenu();
      closePreview(); $('authModal').hidden = true; $('promptModal').hidden = true; $('confirmModal').hidden = true;
    }
    if (e.key === 'Delete' && state.selected.size) bulkDelete();
    if (e.key === 'F2' && state.selected.size === 1) {
      const it = state.entries.find((x) => x.name === [...state.selected][0]);
      if (it && state.user) rename(it);
    }
    /* Backspace 返回上级目录 */
    if (e.key === 'Backspace' && state.path) {
      e.preventDefault();
      state.path = state.path.split('/').slice(0, -1).join('/');
      state.selected.clear();
      loadList();
    }
  });

  /* 点击空白处关闭右键菜单 */
  document.addEventListener('click', () => closeCtxMenu());
  document.addEventListener('scroll', () => closeCtxMenu(), true);

  window.addEventListener('beforeunload', () => { for (const t of tasks.values()) cancelTask(t); });
}

/* ============================ 全局错误兜底（P0） ============================
   此前没有 window.onerror / unhandledrejection：Promise 异常会静默失败，
   用户只看到"点了没反应"，排障只能靠猜。现在统一冒泡成 toast，
   并尽力上报到服务端（/api/log 不存在也不影响使用）。 */
function reportError(kind, msg, detail) {
  try {
    const line = '[' + kind + '] ' + msg;
    console.error(line, detail || '');
    /* 上报失败无所谓：接口可能不存在，忽略即可 */
    fetch('/api/log', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, msg, detail: String(detail || '').slice(0, 500), ua: navigator.userAgent, at: Date.now() }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
window.addEventListener('error', (e) => {
  const m = (e.message || '') + (e.filename ? ' @' + String(e.filename).split('/').pop() + ':' + e.lineno : '');
  reportError('error', m, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  reportError('promise', (r && r.message) || String(r), r && r.stack);
});

/* ============================ 启动 ============================ */
(async function init() {
  initTheme();
  bind();
  setupUrlHint();
  try { state.capabilities = await api('/api/capabilities'); } catch {}
  await loadMe();
  await loadDisks();
  setInterval(loadDisks, 15000);
  updateHint();
  await loadList();
})();

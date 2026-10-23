'use strict';

/* =====================================================================
   shell.js — 深空工作站 v5 应用外壳
   信息架构反转：工作站是主容器，NAS / AI / 协同 / 事件 / 系统 是一级模块。

   职责：
   - hash 路由：#/（总览） #/files #/ai #/collab #/events #/tools
   - 顶栏导航注入（桌面）/ 底部标签栏（移动）
   - 状态药丸：在线设备 + 进行中任务（供 station.js 更新）
   - 「系统」模块的工具卡片（回收站/审计/安全等面板入口，来自 panels*.js）
   - 兼容：旧 #/station 与 Workstation.open('over') → 跳 #/

   依赖 app.js 全局：el / api / jsonPost / toast / state
   依赖 panels.js：openPanel / panelXXX 系列
   依赖 station.js（后加载）：window.Workstation
   ===================================================================== */

(function () {
  const LS_ROUTE = 'shell.route';
  const LS_NAS_LAND = 'shell.landOnNas';

  /* ===================================================================
     NAS 定向适配（v5.1）
     这不是一个普通网站 —— 它是跑在局域网 NAS 上的文件中枢。差异点：
     1) 主要入口是文件（存储才是 NAS 的本体），不是「总览」仪表盘；
     2) 手机是最高频的访问终端，必须单手可达、输入框常驻；
     3) 存储余量是这个设备最该被随时看见的健康指标。
     这里做三件事：环境识别、手机端落地到文件、顶栏 NAS 存储条。
     =================================================================== */

  /* 环境识别：手机 / 是否安装为 PWA / 是否局域网直连 NAS */
  const ENV = (function () {
    const ua = navigator.userAgent || '';
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
      (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
    const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true;
    const hn = location.hostname || '';
    const lan = /^10\./.test(hn) || /^192\.168\./.test(hn) || /^172\.(1[6-9]|2\d|3[01])\./.test(hn);
    return { mobile, standalone, lan, host: hn };
  })();

  /* NAS 存储状态缓存（顶栏条用） */
  const nasState = { total: 0, free: 0, used: 0, pct: 0, ready: false, err: '' };

  /* 一级模块清单。hash → {标题, 顶栏文案, 容器id} */
  const MODULES = [
    { hash: '#/',         id: 'mod-home',   nav: '总览',  tab: '总览' },
    { hash: '#/files',     id: 'mod-files',  nav: '文件',  tab: '文件' },
    { hash: '#/ai',        id: 'mod-ai',     nav: 'AI 助手', tab: 'AI' },
    { hash: '#/collab',    id: 'mod-collab', nav: '协同',  tab: '协同' },
    { hash: '#/events',    id: 'mod-events', nav: '事件',  tab: null },   // 移动端并入「更多」
    { hash: '#/work',      id: 'mod-work',   nav: '作品',  tab: '作品' },
    { hash: '#/tools',     id: 'mod-tools',  nav: '系统',  tab: '系统' },
  ];

  /* 移动端底部 tab：6 个（事件并入「系统」页可达） */
  const TABBAR = ['/', '/files', '/ai', '/collab', '/work', '/tools'];

  let current = null;          // 当前模块 hash
  const hooks = {              // 模块进出钩子，station.js 可注册
    enter: {},                 // hash → fn()
    leave: {},                 // hash → fn()
  };

  function route() {
    const h = location.hash || '#/';
    return MODULES.some((m) => m.hash === h) ? h : '#/';
  }

  /* ---------------- 导航渲染 ---------------- */

  function buildNav() {
    const nav = document.getElementById('tnNav');
    if (!nav) return;
    nav.innerHTML = '';
    for (const m of MODULES) {
      const b = el('button', 'tn-link', m.nav);
      b.dataset.hash = m.hash;
      b.onclick = () => go(m.hash);
      nav.appendChild(b);
    }
    const tb = document.getElementById('tabbar');
    if (tb) {
      tb.innerHTML = '';
      for (const p of TABBAR) {
        const m = MODULES.find((x) => x.hash === '#' + p);
        if (!m) continue;
        const b = el('button', 'tab-item', m.tab || m.nav);
        b.dataset.hash = m.hash;
        b.onclick = () => go(m.hash);
        tb.appendChild(b);
      }
    }
    paint();
  }

  function paint() {
    const h = route();
    /* 顶栏激活态 */
    document.querySelectorAll('.tn-link').forEach((b) => {
      b.classList.toggle('on', b.dataset.hash === h);
    });
    paintDrawer();
    /* 底部 tab 激活态（#/events 归到「系统」组高亮不误亮） */
    document.querySelectorAll('.tab-item').forEach((b) => {
      b.classList.toggle('on', b.dataset.hash === h);
    });
    /* 模块显隐 */
    for (const m of MODULES) {
      const sec = document.getElementById(m.id);
      if (sec) sec.hidden = m.hash !== h;
    }
    document.title = ({
      '#/': '总览', '#/files': '文件', '#/ai': 'AI 助手',
      '#/collab': '协同', '#/events': '事件流', '#/work': '作品', '#/tools': '系统',
    })[h] + ' · 深空工作站';
    paintNasBar(h);
  }

  /* ---------------- NAS 存储条（顶栏右侧常驻指标） ----------------
     为什么放在顶栏：NAS 的存储余量是这台设备最该被随时看到的数字，
     不该藏在「总览」页里翻一层。桌面端显示为药丸，手机端并入顶栏不占位。 */
  function paintNasBar(h) {
    const host = document.getElementById('tnNas');
    if (!host) return;
    if (!nasState.ready) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const pct = Math.max(0, Math.min(100, nasState.pct));
    const level = pct >= 92 ? 'crit' : pct >= 78 ? 'warn' : 'ok';
    host.className = 'tn-nas ' + level;
    host.innerHTML =
      '<span class="ic-nas" aria-hidden="true">▤</span>' +
      '<span class="nas-num">' + fmtGB(nasState.free) + ' 可用</span>' +
      '<span class="nas-bar"><i style="width:' + pct.toFixed(1) + '%"></i></span>' +
      '<span class="nas-pct">' + pct.toFixed(0) + '%</span>';
    host.title = 'NAS 存储：已用 ' + fmtGB(nasState.used) + ' / 共 ' + fmtGB(nasState.total);
    host.onclick = () => go('#/files');
  }

  function fmtGB(bytes) {
    if (!bytes && bytes !== 0) return '—';
    const gb = bytes / 1073741824;
    if (gb >= 1024) return (gb / 1024).toFixed(1) + ' TB';
    if (gb >= 100) return gb.toFixed(0) + ' GB';
    if (gb >= 10) return gb.toFixed(1) + ' GB';
    return gb.toFixed(2) + ' GB';
  }

  /* 拉取存储水位（失败静默，不打扰用户 —— 顶栏条只是增益信息） */
  async function loadNasState() {
    try {
      if (typeof api !== 'function') return;
      const r = await api('/api/disks');
      const list = (r && r.disks) || [];
      if (!list.length) return;
      let used = 0, total = 0;
      for (const d of list) {
        used += Number(d.used) || 0;
        total += Number(d.quota) || 0;
      }
      if (!total) return;
      nasState.used = used;
      nasState.total = total;
      nasState.free = Math.max(0, total - used);
      nasState.pct = (used / total) * 100;
      nasState.ready = true;
      paintNasBar(route());
    } catch (e) {
      nasState.err = (e && e.message) || String(e);
    }
  }

  function go(hash) {
    if (location.hash === hash) { paint(); return; }
    /* 用 history.replaceState 而非 location.hash=：
       后者在「裸地址 + 已保存路由」时会触发一次整页刷新，
       刷新后 boot() 按 localStorage 恢复旧模块，
       于是地址栏显示 #/ 而界面停在系统页 —— 表现为「点了没反应」。
       这里只改 hash 不重载文档，由 apply() 统一渲染。 */
    try {
      history.replaceState(null, '', hash);
      apply();
    } catch (e) {
      location.hash = hash;
    }
  }

  function apply() {
    const h = route();
    if (h === current) return;
    if (current && hooks.leave[current]) { try { hooks.leave[current](); } catch (e) {} }
    current = h;
    localStorage.setItem(LS_ROUTE, h);
    paint();
    if (hooks.enter[h]) { try { hooks.enter[h](); } catch (e) {} }
    /* 通知 station.js 有模块切换（它管 AI/协同/事件的渲染时机） */
    if (window.Workstation && window.Workstation._onRoute) {
      try { window.Workstation._onRoute(h); } catch (e) {}
    }
  }

  /* ---------------- 状态药丸（顶栏右侧） ---------------- */

  function paintPill(online, running) {
    const box = document.getElementById('tnPill');
    if (!box) return;
    const live = online != null;
    box.innerHTML =
      '<span class="tn-pill' + (live ? ' live' : ' dead') + '">' +
      '<span class="dot"></span>' +
      (online != null ? '<b>' + online + '</b><span class="ws-hide-s"> 设备</span>' : '连接中') +
      (running ? '<span class="sep">·</span><b>' + running + '</b><span class="ws-hide-s"> 任务</span>' : '') +
      '</span>';
  }

  /* ---------------- 「系统」模块：工具卡片 ---------------- */

  function buildTools() {
    const host = document.getElementById('toolsHost');
    if (!host || host.childElementCount) return;
    const CARDS = [
      ['🎮 星陨大陆', '第一人称 3D 开放世界 RPG', () => window.playStellarfall && window.playStellarfall()],
      ['❤ 系统健康', 'CPU / 内存 / 磁盘 / 运行时长', () => window.panelHealth && panelHealth()],
      ['📜 操作审计', '谁在什么时候动了什么', () => window.panelAudit && panelAudit()],
      ['🛡 安全中心', '登录失败 · 封禁 · 会话', () => window.panelSecurity && panelSecurity()],
      ['📡 运维监控', '进程 · 端口 · 服务状态', () => window.panelOps && panelOps()],
      /* ⚠️ 这条卡片此前直接写 `ensure('/netdiag.js')` —— 裸标识符在本文件的
         IIFE 里不可见（ensure 在 app.js 的页面作用域），点了必然 ReferenceError。
         改走 window.panelNetDiag()，它带懒加载 + 转存真身 + 失败可重试。 */
      ['🌐 网络诊断', '连通性 · 接口 · 局域网扫描', () => window.panelNetDiag()],
      ['⏱ 定时任务', '文件管理的自动化作业', () => window.panelJobs && panelJobs()],
      ['🗑 回收站', '30 天暂存 · 可恢复', () => window.panelRecycle && panelRecycle()],
      ['🧬 重复文件', '扫描并清理重复占用', () => window.panelDedup && panelDedup()],
      ['🔎 全文检索', '内容级搜索', () => window.panelSearch && panelSearch()],
      ['🕘 历史版本', '文件的修改历史', () => window.panelVersions && panelVersions(null)],
      ['🔗 共享链接', '限时分享 /s/<token>', () => window.panelShares && panelShares(null)],
    ];
    const grid = el('div', 'tool-grid');
    for (const [title, sub, fn] of CARDS) {
      const c = el('button', 'tool-card');
      const t = el('div', 'tc-title', title);
      const s = el('div', 'tc-sub', sub);
      c.appendChild(t); c.appendChild(s);
      c.onclick = fn;
      grid.appendChild(c);
    }
    host.appendChild(grid);
  }

  /* ---------------- 「作品」模块：自研成品卡片 ----------------
     读取 /apps/manifest.json，渲染成品卡片网格。点击卡片（或其「打开」按钮）
     走 openApp()：与游戏同款的全屏覆盖层 + iframe，保证 WebGL/3D 吃满高、
     退出即释放上下文。⚠️ 只依赖静态文件 /apps/<slug>/index.html，server 无需改动。 */
  /* slug → manifest 记录。openApp() 靠它把 entry 查出来（见下方 appUrlOf 的 Bug 说明）。 */
  let APP_INDEX = {};

  function buildWork() {
    const host = document.getElementById('workBody');
    if (!host || host.childElementCount) return;
    host.innerHTML =
      '<div class="work-loading" style="color:var(--dim);font:13px system-ui;padding:8px 2px">' +
      '载入作品清单…</div>';
    fetch('/apps/manifest.json', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data) => {
        const apps = (data && data.apps) || [];
        APP_INDEX = {};
        for (const a of apps) if (a && a.slug) APP_INDEX[a.slug] = a;
        if (!apps.length) { host.innerHTML = '<div class="work-loading">暂无作品</div>'; return; }
        const grid = el('div', 'tool-grid work-grid');
        for (const a of apps) {
          const c = el('div', 'tool-card');
          c.appendChild(el('div', 'tc-title', a.title || a.slug));
          c.appendChild(el('div', 'tc-sub', a.desc || ''));
          if (a.tags && a.tags.length) {
            const tagWrap = el('div', 'app-tags');
            for (const tg of a.tags) tagWrap.appendChild(el('span', 'app-tag', tg));
            c.appendChild(tagWrap);
          }
          const open = el('button', 'btn primary app-open', '打开');
          open.type = 'button';
          open.onclick = (e) => { e.stopPropagation(); openApp(a); };
          c.appendChild(open);
          c.onclick = () => openApp(a);
          grid.appendChild(c);
        }
        host.innerHTML = '';
        host.appendChild(grid);
      })
      .catch((err) => {
        host.innerHTML =
          '<div class="work-loading" style="color:var(--bad)">作品清单加载失败：' +
          (err && err.message ? err.message : err) + '</div>';
      });
  }
  window.buildWork = buildWork;

  /* 全屏打开某个成品（#/work 的「打开」按钮调用）。
     openApp(app) → 覆盖层 + iframe。参数可以是 manifest 里的**对象**，也可以是 slug 字符串。
     复制 playStellarfall 的全屏覆盖 + 退出即销毁 iframe 模式。

     🔴 2026-09-16 修 Bug：原来只会拼 `/apps/<slug>/index.html`，**完全忽略 manifest 的
     `entry` 字段**，而 /apps/ 下压根没有 dos-doom / dos-cnc 这类目录 ——
     现象是「作品」页里 9 张 DOS 卡片点下去一片空白（iframe 里是 404），
     而 PC 上一直没人点过，e2e 又是直接照 entry 导航的，所以两边都没暴露。
     现在：entry 优先，没有 entry 才回落到 /apps/<slug>/index.html（stellarfall 等自托管作品）。 */
  function appUrlOf(recOrSlug) {
    const rec = (recOrSlug && typeof recOrSlug === 'object')
      ? recOrSlug
      : (APP_INDEX && APP_INDEX[recOrSlug]);
    if (rec && rec.entry) return rec.entry;
    const slug = rec ? rec.slug : recOrSlug;
    return '/apps/' + slug + '/index.html';
  }
  window.appUrlOf = appUrlOf;

  function openApp(recOrSlug) {
    if (!recOrSlug) return;
    const rec = (typeof recOrSlug === 'object') ? recOrSlug : (APP_INDEX && APP_INDEX[recOrSlug]);
    const slug = (rec && rec.slug) || String(recOrSlug);
    const id = 'appOverlay_' + slug;
    const old = document.getElementById(id);
    if (old) { old.hidden = false; return; }
    const wrap = el('div');
    wrap.id = id;
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:9000;background:#05060a;display:flex;flex-direction:column;';
    const bar = el('div');
    /* ⚠️ flex-wrap 必须有：手机视口仅 ~411px，品牌名 + 提示 + 退出按钮一行放不下时，
       不留换行余地会把「关闭」按钮挤成竖排并压住提示（同 playStellarfall 的教训）。 */
    bar.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:6px 10px;background:#0b0d14;' +
      'color:#9fb0c8;font:13px/1.4 system-ui;flex:0 0 auto;flex-wrap:wrap;';
    const brand = el('span', '', '🧪 ' + slug);
    brand.style.cssText = 'flex:0 0 auto;white-space:nowrap;';
    bar.appendChild(brand);
    const tip = el('span', '', '点此区域操作 · 退出即释放资源');
    tip.style.cssText = 'opacity:.55;font-size:12px;flex:1 1 auto;min-width:0;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    try {
      if (window.matchMedia && window.matchMedia('(max-width: 520px)').matches) tip.style.display = 'none';
    } catch (e) {}
    bar.appendChild(tip);
    const spacer = el('span');
    spacer.style.flex = '1';
    bar.appendChild(spacer);
    const exit = el('button', 'btn', '关闭');
    exit.type = 'button';
    exit.style.cssText = 'padding:4px 12px;font-size:12px;flex:0 0 auto;white-space:nowrap;';
    exit.onclick = () => closeApp(id);
    bar.appendChild(exit);
    const frameHolder = el('div');
    frameHolder.style.cssText = 'flex:1 1 auto;min-height:0;position:relative;';
    const frame = document.createElement('iframe');
    frame.src = appUrlOf(rec || slug);
    frame.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#05060a;';
    frame.setAttribute('allow', 'fullscreen; gamepad; xr-spatial-tracking; accelerometer; gyroscope;');
    frame.allowFullscreen = true;
    frameHolder.appendChild(frame);
    wrap.appendChild(bar);
    wrap.appendChild(frameHolder);
    document.body.appendChild(wrap);
    function closeApp() {
      const w = document.getElementById(id);
      if (!w) return;
      try { w.querySelector('iframe').src = 'about:blank'; } catch (e) {}
      w.remove();
    }
  }
  window.openApp = openApp;

  /* ---------------- 内嵌小游戏：星陨大陆（STELLARFALL） ----------------
     全屏覆盖层 + iframe，而不是塞进某个模块里 —— 原因：
     ① 模块容器有自己的滚动/布局约束，iframe 吃不满高，第一人称视角会挤成一条缝；
     ② 游戏要 Pointer Lock / 全键鼠，必须盖住顶栏与 tabbar，避免误触导航；
     ③ 退出即销毁 iframe，游戏内存（WebGL 上下文/粒子池）随之释放，比留着挂后台稳。
     ⚠️ 只依赖静态文件 /games/stellarfall/index.html，server 无需任何改动。 */
  function playStellarfall() {
    const old = document.getElementById('gameOverlay');
    if (old) { old.hidden = false; return; }
    const wrap = el('div');
    wrap.id = 'gameOverlay';
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:9000;background:#05060a;display:flex;flex-direction:column;';
    const bar = el('div');
    /* ⚠️ flex-wrap 必须有：手机 CSS 视口只有 ~411px，而这一行要放
       品牌名 + 一长串操作提示 + 退出按钮。不留换行余地时，提示文字不可收缩，
       会把「退出游戏」按钮压到只剩一个字宽 —— 文字逐字折行成竖排，
       并压住左侧提示（2026-09-15 截图事故）。 */
    bar.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:6px 10px;background:#0b0d14;' +
      'color:#9fb0c8;font:13px/1.4 system-ui;flex:0 0 auto;flex-wrap:wrap;';
    const brand = el('span', '', '🎮 星陨大陆：觉醒 · STELLARFALL');
    brand.style.cssText = 'flex:0 0 auto;white-space:nowrap;';
    bar.appendChild(brand);
    const tip = el('span', '', '点击画面锁定鼠标视角 · WASD 移动 · Esc 退出锁定');
    /* 提示是次要信息：允许它收缩并单行省略，绝不与按钮抢宽度 */
    tip.style.cssText = 'opacity:.55;font-size:12px;flex:1 1 auto;min-width:0;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    /* 窄屏（手机）下干脆不显示这条提示 —— 触屏本来也用不上 WASD 说明 */
    try {
      if (window.matchMedia && window.matchMedia('(max-width: 520px)').matches) {
        tip.style.display = 'none';
      }
    } catch (e) { /* 老浏览器忽略 */ }
    bar.appendChild(tip);
    const spacer = el('span');
    spacer.style.flex = '1';
    bar.appendChild(spacer);
    const exit = el('button', 'btn');
    exit.textContent = '退出游戏';
    exit.style.cssText = 'padding:4px 12px;font-size:12px;flex:0 0 auto;white-space:nowrap;';
    exit.onclick = closeStellarfall;
    bar.appendChild(exit);
    const frameHolder = el('div');
    frameHolder.style.cssText = 'flex:1 1 auto;min-height:0;position:relative;';
    const frame = document.createElement('iframe');
    /* 单文件版 game.html：24 脚本已内联、零网络请求 ——
       用它而不是多文件 index.html，省掉 27 次子请求，也不吃 SW 缓存换代。 */
    frame.src = '/games/stellarfall/dist/game.html';
    frame.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#05060a;';
    frame.setAttribute('allow', 'fullscreen');
    frame.allowFullscreen = true;
    frameHolder.appendChild(frame);
    wrap.appendChild(bar);
    wrap.appendChild(frameHolder);
    document.body.appendChild(wrap);
    /* 退出时彻底移除 DOM：iframe 的 WebGL 上下文与全部游戏状态随节点一起释放 */
    function closeStellarfall() {
      const w = document.getElementById('gameOverlay');
      if (!w) return;
      try { w.querySelector('iframe').src = 'about:blank'; } catch (e) {}
      w.remove();
    }
  }
  window.playStellarfall = playStellarfall;

  /* ---------------- 移动端导航抽屉（汉堡） ---------------- */
  /* 底部 tabbar 只有 5 项装不下 6 个模块（「事件」被挤掉），
     抽屉补齐全部模块入口；同时把原本零接线的汉堡按钮用起来。 */
  const BURGER_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

  let drawer = null;

  function buildDrawer() {
    if (drawer) return drawer;
    drawer = el('div', 'nav-drawer');
    const scrim = el('div', 'nd-scrim');
    scrim.onclick = closeDrawer;
    const panel = el('nav', 'nd-panel');
    panel.appendChild(el('div', 'nd-title', '工作站模块'));
    for (const m of MODULES) {
      const b = el('button', 'nd-link', m.nav);
      b.dataset.hash = m.hash;
      b.onclick = () => { closeDrawer(); go(m.hash); };
      panel.appendChild(b);
    }
    drawer.appendChild(scrim);
    drawer.appendChild(panel);
    document.body.appendChild(drawer);
    return drawer;
  }

  function openDrawer() {
    const d = buildDrawer();
    d.classList.add('open');
    paintDrawer();
  }
  function closeDrawer() {
    if (drawer) drawer.classList.remove('open');
  }
  function paintDrawer() {
    if (!drawer) return;
    const h = route();
    drawer.querySelectorAll('.nd-link').forEach((b) => {
      b.classList.toggle('on', b.dataset.hash === h);
    });
  }

  /* ---------------- 兼容旧入口 ---------------- */

  function compat() {
    /* 旧地址 #/station → 总览 */
    if (location.hash === '#/station' || location.pathname === '/station') {
      history.replaceState(null, '', '#/');
    }
    /* Workstation.open 不再弹面板，改为路由跳转（station.js 已适配，
       这里兜底：万一旧调用直接来，也能落到正确模块） */
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    compat();
    if (!location.hash) {
      /* 裸地址：恢复上次模块，但把地址栏同步成真实路由（replaceState 不刷新），
         否则会出现「地址栏 #/、界面停在系统页」的不一致。

         NAS 定向适配：首次从未访问过的手机打开时，直接落到「文件」——
         这台设备的本体是存储，不是仪表盘。只要用户手动切过模块，
         就尊重其选择（LS_NAS_LAND 记一次，避免反复劫持）。 */
      const saved = localStorage.getItem(LS_ROUTE);
      let target;
      if (saved && MODULES.some((m) => m.hash === saved)) {
        target = saved;
      } else if (ENV.mobile && !localStorage.getItem(LS_NAS_LAND)) {
        target = '#/files';
        try { localStorage.setItem(LS_NAS_LAND, '1'); } catch (e) {}
      } else {
        target = '#/';
      }
      try { history.replaceState(null, '', target); } catch (e) { location.hash = target; }
    }
    buildNav();
    buildTools();
    apply();
    /* NAS 存储水位（顶栏条） */
    loadNasState();
    setInterval(loadNasState, 60000);
    /* 让各模块也能读到环境判定（手机端做减法渲染） */
    document.documentElement.dataset.env =
      (ENV.mobile ? 'mobile' : 'desktop') + (ENV.standalone ? ' pwa' : '') + (ENV.lan ? ' lan' : '');
    /* 汉堡：填图标 + 接线（此前是零接线的空方块） */
    const burger = document.getElementById('tnBurger');
    if (burger) {
      burger.innerHTML = BURGER_ICON;
      burger.onclick = (e) => {
        e.stopPropagation();
        if (drawer && drawer.classList.contains('open')) closeDrawer();
        else openDrawer();
      };
    }
    /* Esc 关抽屉 */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDrawer();
    });
    window.addEventListener('hashchange', apply);
    /* 工具卡片懒构建：首次进 #/tools 时 */
    const t = document.getElementById('mod-tools');
    if (t) {
      const mo = new MutationObserver(() => { if (!t.hidden) buildTools(); });
      mo.observe(t, { attributes: true, attributeFilter: ['hidden'] });
    }
    /* 作品卡片懒构建：首次进 #/work 时 */
    const wsec = document.getElementById('mod-work');
    if (wsec) {
      const moW = new MutationObserver(() => { if (!wsec.hidden) buildWork(); });
      moW.observe(wsec, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  /* 网络诊断面板：/netdiag.js 是懒加载的（首屏不引），只有点这张卡时才加载。
     新前端 iframe 会直接调 contentWindow.panelNetDiag()，此时脚本可能还没加载，
     函数是 undefined ⇒「点了没反应」。这里提供幂等包装：先加载脚本、再调真身。

     ⚠️ 三个坑，都踩过（2026-09-16）：
     ① ensure 定义在 app.js 的**页面作用域**（app.js:149），不在本文件的 IIFE 里。
        直接写裸标识符会 ReferenceError，而它在 boot() 内 ⇒ 每次加载 shell.js 都抛错、
        整个 boot 中断（当时 15 套件挂了 9 套）。必须走 window.ensure。
     ② 绝不能在包装里调 window.panelNetDiag —— netdiag.js 正是把真身挂在这个名字上，
        包装覆盖了它，再调 window.panelNetDiag() 就是**调用自己**，无限递归爆栈。
        所以先存真身：netdiag.js 加载后会赋值 window.panelNetDiag，我们把它转存到
        __realPanelNetDiag，包装只认那个名字。
     ③ 加载失败要能重试：清掉缓存和转存，下次点击重新来。 */
  window.__realPanelNetDiag = null;
  window.panelNetDiag = function panelNetDiagLazy() {
    /* 真身已在（netdiag.js 之前加载过）：直接调，别绕 */
    if (typeof window.__realPanelNetDiag === 'function') return window.__realPanelNetDiag();

    var load;
    if (typeof window.ensure === 'function') {
      load = window.ensure('/netdiag.js');
    } else if (window.__ndLoad) {
      load = window.__ndLoad;
    } else {
      /* app.js 还没跑到（或将来 ensure 改名）：自己注入，同样幂等 */
      load = window.__ndLoad = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = '/netdiag.js';
        s.onload = function () { resolve(); };
        s.onerror = function () { window.__ndLoad = null; reject(new Error('加载失败 /netdiag.js')); };
        document.head.appendChild(s);
      });
    }
    return load.then(function () {
      /* netdiag.js 执行后会把真身写到 window.panelNetDiag 上（覆盖本包装）。
         把那个真身转存到 __realPanelNetDiag，之后一律走它 ——
         绝不能再调 window.panelNetDiag（那是本包装自己，会无限递归）。 */
      if (typeof window.panelNetDiag === 'function' && window.panelNetDiag !== panelNetDiagLazy) {
        window.__realPanelNetDiag = window.panelNetDiag;
      }
      if (typeof window.__realPanelNetDiag === 'function') return window.__realPanelNetDiag();
      if (typeof window.toast === 'function') window.toast('网络诊断组件未就绪', 'bad');
    }).catch(function () {
      window.__ndLoad = null;
      if (typeof window.toast === 'function') window.toast('网络诊断组件加载失败', 'bad');
    });
  };

  /* 对外 API */
  window.Shell = {
    go,
    route,
    paintPill,
    openDrawer,
    closeDrawer,
    on(h, ev, fn) { if (ev === 'enter' || ev === 'leave') hooks[ev][h] = fn; },
    MODULES,
    env: ENV,
    nasState,
    refreshNas: loadNasState,
    /* 让外部（station.js 拉到 AI 配置后 / 测试）能主动催一次 AI 视图重画 */
    refreshAi() {
      try {
        if (window.AIView && AIView.isMounted && AIView.isMounted()) AIView.refresh();
      } catch (e) { /* 视图未就绪时忽略 */ }
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

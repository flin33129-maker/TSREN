'use strict';

/* =====================================================================
   sw.js — Service Worker（最小可用）
   策略：
     - /api/ 与 /dav/ 一律网络直通（永不缓存，保证数据实时与写操作安全）
     - 其余 GET：缓存优先（命中立即返回），同时后台拉取更新（stale-while-revalidate）
     - install：逐个 precache 外壳资源，单个失败不整体失败
     - activate：清理旧版本缓存；skipWaiting + clientsClaim 立即接管
   ===================================================================== */

/* v21（2026-09-16 界面收敛 · HTML 改为网络优先）：
   根路径 "/" 的语义变了 —— 以前返回旧界面 index.html，现在返回新前端
   （旧界面退到 /legacy/index.html）。不升版本号的话，用户浏览器会一直吃
   v19 里的旧 "/" 缓存，表现为「改了没生效、还是旧界面」—— 这个坑真踩过。

   ⚠️ v21 修的是同一个坑的**第二层**：HTML 必须走 network-first。
   原先 fetch 对一切同源 GET 都是「缓存优先 + 后台更新」，而 / 与 *.html
   是被 precache 的。新前端的 JS/CSS 带内容哈希（index-DTWaaTwv.js），
   每次构建文件名都变 —— 这本来能自然避开旧缓存，但**前提是用户能拿到新 HTML**。
   HTML 若被缓存优先命中，用户手里就是旧 HTML → 里面写死的是旧哈希文件名
   → 加载的还是旧包，甚至旧包已被删则直接白屏（404）。
   所以 HTML 单独走网络优先，取不到时才回退缓存（保住离线可用）。

   v24（2026-09-16 作品页扩容）：
   /apps/manifest.json 不在 PRECACHE 里，走的是「缓存优先 + 后台更新」——
   于是它**第一次访问必然返回上一次的旧清单**，第二次才刷新。
   本次作品数从 4 项扩到 13 项（新增 9 款 DOS 经典游戏），
   用户点进作品页看到旧清单会以为没生效，故升版本号强制换缓存。
   v25：DOS 游戏在手机竖屏下画面只占约 26%，新增「点作品卡片即全屏+锁横屏」
   （在点击手势里做，否则浏览器拒绝全屏）；前端产物哈希随之变化，
   不升版本号的话旧 JS 会被缓存住，用户点了卡片还是老的窄画面。
   v26（2026-09-17 作品页扩容到 74 条）：4 个自研作品 + 70 款 DOS 里程碑大作。
   作品页新增「分组筛选条 + 搜索框 + 分组小标题」，JS 与 CSS 产物哈希都变了
   （index-DjQQY3SB.js → index-DN65tQ69.js、index-BlFa4pUd.css → index-Wg-I6Z0W.css）。
   同上：manifest.json 是"缓存优先 + 后台更新"，不升版本号第一次进作品页
   拿到的是旧的 27 条清单，用户会以为那 70 款游戏没接上。
   v27（2026-09-17 DOS 双端适配）：play.html 新增「操作说明」面板（右上角 ? 钮）——
   PC 讲键盘键位、手机讲包内虚拟按键，按布局类别分派。play.html 走 network-first，
   本来不缓存；但 70 个 .jsdos 包**整体重压缩**（1871MB → 1085MB，逐条目 md5 校验，
   内容不变），同名文件体积变了 —— 走缓存优先的旧副本会一直占着手机存储不清。
   升版本号 = 换缓存桶，旧包随之回收。 */
const CACHE = 'nas-shell-v30';   // R16：换桶清掉 R15 之前的旧外壳缓存

const PRECACHE = [
  '/',
  '/index.html',
  /* 旧界面：新前端「系统 → 工具」的 10 个功能面板靠 iframe 嵌它拉起，
     弱网/离线时也必须能起来。 */
  '/legacy/index.html',
  '/shell.js',
  '/app.js',
  '/style.css',
  '/station.css',
  '/station.js',
  '/aiview.js',
  '/panels.js',
  /* 安全中心 / 运维监控在 panels2.js，网络诊断在 netdiag.js ——
     原先漏了这两项，会导致对应面板离线时打不开。 */
  '/panels2.js',
  '/netdiag.js',
  '/office.js',
  '/i18n.js',
  '/icon.svg',
];

/* ------------------------------ install：预缓存外壳 ------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个 add 容错：任一资源 404/失败只跳过该项，不影响整体安装
    await Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

/* ------------------------------ activate：清旧缓存 ------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clientsClaim();
  })());
});

/* ------------------------------ fetch：HTML 网络优先 / 其余缓存优先 ------------------------------ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // 跨域不接手
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dav/')) return; // 网络直通

  const cacheReady = caches.open(CACHE);

  /* HTML（/ 、*.html）网络优先 —— 详见 CACHE 定义处的 v21 注释。
     理由：HTML 是「资源清单」，里面写死了带哈希的 JS/CSS 文件名。
     它一旦被缓存优先命中，用户就永远停在旧 HTML → 旧哈希 → 旧包（或被删则 404 白屏）。
     取不到网络时才回退缓存，保证离线仍能打开。 */
  const isHtml = req.mode === 'navigate'
    || url.pathname === '/'
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('/');
  if (isHtml) {
    event.respondWith((async () => {
      const cache = await cacheReady;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req);
        return hit || new Response('离线，且该页面未缓存', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  const hitReady = cacheReady.then((c) => c.match(req));

  // 后台更新：命中缓存也不阻塞响应
  const updateReady = fetch(req)
    .then((res) => {
      if (res && res.ok) cacheReady.then((c) => c.put(req, res.clone()));
      return res;
    })
    .catch(() => null);
  event.waitUntil(updateReady);

  event.respondWith(
    hitReady
      .then((hit) => hit || updateReady)
      .then((res) => res || new Response('离线，且该资源未缓存', { status: 503, statusText: 'Offline' }))
  );
});

/*
 * run-all.js — 一键回归：静态 → 布局 → 交互 → 增强
 *
 * 用法:
 *   node test/run-all.js                      # 本地 8081
 *   node test/run-all.js http://192.168.8.73:8081/
 *   node test/run-all.js --static-only        # 只跑秒级静态审计
 *   SKIP_LLM=1 node test/run-all.js <url>     # 跳过真实推理调用
 *
 * ⚠️ 不要并发跑两轮。每个套件都会起一个无头 Edge，并发时会互相抢资源，
 *    表现为「无法连接 CDP 调试端口」/「文档未在 xx s 内就绪」这类**假红**。
 *    下面的锁文件会替你拦住。
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const staticOnly = args.includes('--static-only');
const probeOnly = args.includes('--probe-only');
const base = args.find((a) => a.startsWith('http')) || 'http://127.0.0.1:8081/';
const skipLlm = !!process.env.SKIP_LLM;

/*
 * 并发锁（2026-09-10 事故）
 *
 * 当天手动起了一轮三套件回归，又同时起了一轮全量 —— 两轮各起无头 Edge 抢资源，
 * 全量里的 `t-ai-embed` 报「无法连接 CDP 调试端口 9265」、`t-nasdock` 报
 * 「文档未在 15s 内就绪」。**两个都是假红，代码一行没动。**
 * 这类红最贵的地方在于：它长得和真回归一模一样。
 */
const LOCK = path.join(os.tmpdir(), 'fileserver-regression.lock');
(function acquireLock() {
  if (probeOnly) return;   // 探针 1 秒就跑完，不参与互斥
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 40 * 60 * 1000) {
      console.log('\n⚠️  另有一轮回归正在跑（锁 ' + LOCK + '，' +
        Math.round((Date.now() - st.mtimeMs) / 1000) + 's 前创建）。');
      console.log('    并发跑会互相抢无头浏览器，产出「CDP 端口连不上」这类**假红**。');
      console.log('    要强行继续：删掉该锁文件后重跑。\n');
      process.exit(2);
    }
  } catch {}
  try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}
})();
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch {} };
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });

/*
 * 陈旧实例探针（2026-09-10 事故）
 *
 * 端口上躺着的**未必是你刚改的代码**。当天 18099 上同时有两个 12:51 / 13:51 启动的
 * 旧 `server.js` 实例，默认跑法得到「故障注入 2 红、NAS 停靠 1 红」——
 * 排查一轮才发现那些红是旧代码缺 `allowTools/allowWrite/contextTokens` 字段造成的，
 * 与当前改动毫无关系（换当前实例 11/11 全绿）。
 *
 * 陈旧实例的红不是回归，但会白烧一轮排查。所以让它自己喊出来：
 * 用「新版 AI 能力字段是否存在」当版本指纹。缺字段即代码陈旧。
 */
const CAP_FIELDS = ['allowTools', 'allowWrite', 'contextTokens', 'maxToolRounds'];
const PROBE = `
const u = process.argv[1];
require('http').get(u, (r) => {
  let s = ''; r.on('data', (d) => (s += d));
  r.on('end', () => process.stdout.write(s));
}).on('error', () => process.stdout.write('{}'));
`;

function probeStale(b) {
  if (!/^https?:/.test(b)) return;
  let out = '';
  try {
    const url = new URL('/api/ai/config', b).href;
    const r = spawnSync(process.execPath, ['-e', PROBE, url], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    out = (r.stdout || '').trim();
  } catch (e) {
    return;
  }
  let j = null;
  try {
    j = JSON.parse(out);
  } catch (e) {
    console.log('\n⚠️  探针拿不到该站点的 /api/ai/config —— 可能不是本题项目、或未登录。');
    return;
  }
  if (!j || typeof j !== 'object') return;
  const keys = Object.keys(j);
  if (!keys.length) return; // 空对象：探测失败，不误报
  if ('error' in j) {
    console.log(`\n⚠️  该站点未提供 AI 配置接口（${j.error}）—— 应是旧版本代码。`);
    console.log('    结论可能不代表当前代码，请确认 base 指向当前实例。');
    return;
  }
  const miss = CAP_FIELDS.filter((k) => !keys.includes(k));
  if (miss.length) {
    console.log('\n' + '!'.repeat(64));
    console.log(`⚠️  目标实例代码陈旧：/api/ai/config 缺字段 ${miss.join(', ')}`);
    console.log('    它不是你刚改的那份代码 —— 红项不代表回归。');
    console.log('    请让 base 指向当前实例后重跑（例：http://127.0.0.1:8081/）。');
    console.log('!'.repeat(64));
  }
}

if (!staticOnly) probeStale(base);
if (probeOnly) {
  console.log('（--probe-only：只做陈旧探针，不跑套件）');
  process.exit(0);
}

/* ⚠️ 界面收敛（2026-09-16）后有两套前端，测试必须分别指对地方：
     · 根路径 `/`        = 新前端（React 构建产物，无 .module/.mod-head 这类 DOM）
     · `/legacy/`        = 旧界面（.module 互斥、mod-head 栅格、AIView、工具卡都在这里）
   绝大多数既有套件断言的是**旧界面 DOM**（.module / mod-head / .aiv / AIView.mount /
   #/tools 工具卡 / playStellarfall）。它们原本打根路径，收敛后根路径换成新前端，
   于是全部对着 React 页面找 `.module` —— 找不到就一片红，且报错形态是
   「Cannot set properties of null」这种一眼看不出根因的。
   收敛前根路径就是旧界面，所以那时它们是对的；现在必须显式指向 /legacy/。
   新增的「旧界面面板契约」套件同理。 */
const legacyBase = base.replace(/\/+$/, '') + '/legacy/';

const suites = staticOnly
  ? [['静态审计', 't-static.js', []],
     /* DOS 包结构也是纯静态（读 ZIP + JSON，不起服务），--static-only 时一并跑：
        它能在秒级发现"点了没反应"的低级错，比真机 e2e 划算得多。 */
     ['DOS 包结构', 't-dos-packs.js', []],
     /* WebDAV 临时文件句柄泄漏（2026-09-20 手机整盘写满事故）。
         1~2 节纯静态（读源码断言失败路径关流 + 孤儿清理存在），
         3~4 节需要起服务做真实断线/正常上传 —— 静态节在这里也能跑。 */
     ['WebDAV 上传残骸泄漏', 't-dav-tmp.js', []]]
  : [
      ['静态审计', 't-static.js', []],
      /* 新前端守根路径（旧界面侧的套件全部指向 /legacy/，根路径否则无人守）。 */
      ['新前端根路径', 't-newroot.js', [base]],
      /* 应用中心 / 作品清单（2026-09-17 清单 27 → 75 条后新增的功能）。
         守的是清单**渲染契约**：manifest 每条都要出现在页面上（含 4 条**没有 entry
         字段**的自研作品，它们走 /apps/<slug>/index.html 回落）、分组集合与清单一致、
         分类筛选条齐全、不再出现兜底文案「工作站内置应用」。
         🔴 事故背景：面板曾读 item.name / item.description，而 manifest 的键是
         title / desc / tags / group —— 描述全线掉进兜底文案、分类整个丢失，
         正是用户截图质问「应用为什么都显示由原工作站提供？信息呢？分类呢？」的根因。 */
      ['应用中心作品清单', 'shot-apps.js', [base]],
      /* 游戏入口**可玩性**：manifest 里 71 条 /games/ 入口逐条 fetch 必须 200，
         页面游戏卡片数与清单一致，点分类条后筛出的集合必须精确等于该组清单。
         与 shot-apps 的分工：那份管「清单渲染对不对」，这份管「点得开吗」。 */
      ['应用中心游戏入口', 'verify-apps-games.js', [base]],
      /* ⛔ 已退役：旧「作品页分组/搜索」套件（t-work-groups.js）。
         它断言的是**过渡期那版 React 面板**的 DOM 锚点（data-chip / data-group /
         「打开」按钮）。2026-09-17 换成新面板后：
           - 新面板（根路径）不用这套锚点；
           - 旧界面（/legacy/）**压根没有分组/筛选**（shell.js 里 grep group 零命中）；
           - 那版过渡面板只剩备份 index-reactpanel-0917.html，作为薄壳在
             /legacy/ 下资源解析不到，起不来。
         即：它守的界面已经不存在了，继续挂在全量回归里只会稳定假红。
         覆盖它的是下面的 shot-apps.js —— 以新面板口径断言**更多**东西
         （75/75 条全渲染、分组集合一致、筛选条齐全、无兜底文案）。
         文件保留以便随时对照旧实现：node test/t-work-groups.js <base> */
      // ['作品页分组/搜索', 't-work-groups.js', [legacyBase]],
      ['布局回归', 't-layout.js', [legacyBase]],
      ['路由健壮性', 't-route.js', [legacyBase]],
      ['交互回归', 't-interact.js', [legacyBase]],
      ['AI 输入区', 't-compose.js', [legacyBase]],
      /* 纯本地、无模型依赖：自带假 OpenAI 后端，钉死"流式工具循环必须给出正文"。
         事故背景见 test/t-ai-loop.js 头部注释（工具成功但正文为空 → 前端「无输出·失败」）。 */
      ['AI 工具循环（流式）', 't-ai-loop.js', []],
      /* 纯本地、无模型依赖：钉死"用户能看到的字必须干净"——
         口头禅、协议残留、自我贬低的剥离与改写，以及"前端两处渲染点
         都必须接上清洗"（流式增量不经过后端 _clean）。
         事故背景见 test/t-ai-clean.js 头部注释。 */
      ['输出清洗/口头禅', 't-ai-clean.js', []],
      ['对话框停靠/NAS 适配', 't-nasdock.js', [legacyBase]],
      ['AI 深度嵌入', 't-ai-embed.js', [legacyBase]],
      ['读文件 token 预算', 't-tool-budget.js', []],
      ['故障注入/权限边界', 't-fault-inject.js', [base]],
      /* WebDAV 上传残骸泄漏（2026-09-20 手机整盘写满事故）。
         守的是 lib/dav.js PUT 失败路径：必须「先 destroy 写流再 unlink」并监听
         aborted/close，否则已删除文件的块被 fd 锁住、df 不降（实测累积 193GB，
         手机 226GB 分区仅剩 74MB，adb 都被拖死）。另外守 server.js 的孤儿清理。 */
      ['WebDAV 上传残骸泄漏', 't-dav-tmp.js', [base]],
      ['联网能力/SSRF', 't-web.js', [base]],
      ['估算器分词校验', 't-token-cal.js', []],
      /* 设备历史修剪（2026-09-16）：用户截图质问"我特么哪来的 50 台电脑"。
         OFFLINE_KEEP 上限 50 + deviceId 每次刷新都变 → 同一台 PC 堆成几十条。
         这里守：同 ip/平台/类型 归并成一条、上限生效、**在线设备绝不被误删**、
         脏数据不炸。纯本地无 HTTP 依赖，确定性断言。 */
      ['设备历史修剪', 't-presence-dedupe.js', []],
      /* 资源监控跨平台回退（2026-09-16 实测确认的 bug）：
         Windows 健康页 CPU 与网络速率恒显示「—」。根因是 monitor.js 只读 /proc/*，
         而 server.js 那行 os.loadavg() 在 Windows 上恒返回 [0,0,0]（0 是 falsy，
         前端照样渲染成「—」）。修法是 os.cpus() 差值法算 cpuUsedPct。
         本套件纯本地、不依赖 HTTP（除 CPU 采样窗口有 500ms 等待，约 5 秒跑完）。 */
      ['资源监控跨平台回退', 't-monitor-fallback.js', []],
      /* 内嵌小游戏（2026-09-11 接入）：工具卡 → 全屏 iframe → 游戏 boot 自检 → 退出即销毁。
         游戏本体是纯静态文件（public/games/stellarfall/dist/game.html，零网络请求），
         这里守的是外壳这层：卡片存在、iframe 挂载、游戏 13 项自检、退出不留内存。 */
      ['内嵌游戏「星陨大陆」', 't-game.js', [legacyBase]],
      /* 界面收敛（2026-09-16）：新前端占根路径，旧界面退到 /legacy/index.html。
         新前端的「系统 → 工具」用 iframe + contentWindow.panelXxx() 复用旧面板
         （重写 10 个已验证的面板不划算）。这里守那条跨帧链路的契约：
         旧界面可达、11 个面板函数是全局 function、工具卡 ≥12、真调一个面板
         必须渲染出非空内容。 */
      ['旧界面面板契约', 't-legacy-panels.js', [legacyBase]],
      /* DOS 经典游戏包结构（2026-09-17 第二批扩容到 23 款）：**纯静态、秒级、无浏览器**。
         守的是三份清单（play.html GAMES / manifest.json / packs/*.jsdos）双向对齐 +
         包内布局的合法性。下面几条只有静态能查、运行时只表现成"点不动"：
           ① 缺 .jsdos/jsdos.json → 手机上没有任何虚拟键
           ② 缺 .jsdos/dosbox.conf → 模拟器报 Broken bundle 直接起不来
           ③ 控件 row/col 越界（网格固定 10×7）→ 整个覆盖层不渲染
           ④ 摇杆邻域 3×3 有空格 → 那个方向推不动（键盘能走、摇杆不能走）
           ⑤ Key.mapTo 用了非 js-dos 枚举的键码（如小写 ASCII 119）→ 该键永远无效
         事故背景：rot/darkforces 的一处注入脚本缺陷让两者分别"没虚拟键"和
         "WASD 全废"，但页面能正常启动、控制台无报错 —— 只有这里能拦住。
         必须先跑本静态项再跑下面的真机项，否则白白等几分钟才知道包是坏的。 */
      ['DOS 包结构（静态）', 't-dos-packs.js', []],
      /* 「操作说明」面板的双端回归（2026-09-17）。为什么值得单列：
         PC 与手机要讲的是**两套完全不同的东西**（PC 讲键盘键位、手机讲包内虚拟按键），
         而键位文案是按 build-report.json 的 genre 分派的 —— 这条链
         （build-report → register-games.js → play.html 的 GAMES 表 → 面板）任何一环断了，
         症状都是"所有游戏都显示鼠标操作"，用户只会觉得说明没用，不会报错。
         ⚠️ 它专门覆盖一个踩过的坑：改了 register-games.js 却忘了重跑 →
         内存断言全绿、磁盘产物缺字段。所以那边自检改成**读回磁盘**。
         触屏分支靠 CDP Emulation.setTouchEmulationEnabled 在同一台 PC 上验，
         不必真机（真机再验一次链路即可）。7 款游戏各开一次，约 25 秒。 */
      ['DOS 操作说明（双端）', 't-dos-help.js', [base]],
      /* DOS 画面比例校正（2026-09-17）。为什么值得单列：
         js-dos 默认 renderAspect='AsIs' = 把像素缓冲 1:1 拉伸，而 DOS 像素不是方的
         （当年是 4:3 显示器，PAR = (4/3)/(缓冲比例)，320x200/640x400 都是 0.8333）
         → 横向放大 20%，圆变椭圆。这是"画质烂"里唯一的**真 bug**，其余是平台上限。
         ⚠️ 特意把 Quake（640x400 文本模式）留作第二个用例：曾经误判它该用 16/10，
         留着它那条错断言就回不来。另有一节守"用户在齿轮里改过比例就不许覆盖"。
         默认 2 款 + 幂等，约 110 秒；日常想快就 GAMES=doom 单跑一款。 */
      ['DOS 画面比例', 't-dos-aspect.js', [base]],
      /* DOS 经典游戏真机 e2e：作品页 23 款 js-dos 商业大作。
         这里守的是**模拟器真的能启动**这条链：js-dos 运行时加载 → wlibzip 解压 →
         wdosbox（DOSBox 本体）加载 → canvas 创建 → 截图里真有像素。
         ⚠️ 光断言"包下载成功"是不够的 —— 实测踩过一个假通过：
         bundle 已 fetch、页面零报错，却停在 pre-run 播放大按钮上（autoStart 缺失），
         所以判据必须落到 gotDosbox + 截图像素上。
         参数 [base] 指向根路径（播放器在 /games/dos/ 下，与新旧界面无关）。 */
      ['DOS 经典游戏', 'shot-dos-games.js', [base]],
      /* OpenArena（ioquake3 WebAssembly，2026-09-17 新增，2026-09-15 用户"要新的高画质"）。
         与 DOS 平台零共享代码（Emscripten + WebGL2 + 自带双摇杆触屏层），回归必须独立。
         守的是：12MB 资源拉齐 → WebGL2 上下文 → pk3 进虚拟文件系统 → 真出画面 →
         控制台无 webxdc 残留报错。
         ⚠️ 必须 ?nosound=1：无头 Chrome 没有音频设备，OpenAL/WebAudio 会在
         "LOADING SOUNDS" 阶段把 wasm 堆搞崩（memory access out of bounds）——
         真机（有真音频设备）不受影响，phone-openarena.js 单独验。 */
      ['OpenArena 3D', 'shot-openarena.js', [base]],
      /* 开源 3D 游戏 4 款（2026-09-17 用户指定 zip 里的"好玩的游戏"）。
         与 DOS / OpenArena 都零共享代码，独立成套件。
         守的是**"搬到外面就静默坏掉"的三类坑**（面板上只表现为点了没反应）：
           ① claude-of-tanks 内置 i18n 在中文浏览器上 location.replace('/cn'+path)
              → 缺 localStorage 补丁就 404；
           ② hexgl 的 6 个 bkcore.coffee/ 脚本上游**没打进发行包**，
              缺则 launch.js:45 抛错 → 整个菜单的 onclick 全没挂上；
           ③ hexgl 还需要 textures/(39)+audio/(6)，缺则 onError "Error loading hex."。
         这三类都不会在控制台留明显线索，只能靠本套件逐条 fetch + 真渲染断言。
         约 60 秒（4 款各开一次，claude-of-tanks 有 119 个 canvas 要 12 秒）。 */
      /* ⚠️ 带 `--deep`（等价 OSS_DEEP=1）：真的点 BATTLE 进战斗，约 +90s。
         为什么值得放进**默认**全量：B 类坑（发行包/源 zip **本身缺文件**）只有真跑才暴露 ——
         minimaps、props-models.bin-*.gz、audio/voice 全缺的时候，页面照样打开、
         控制台**一条错都没有**，只在你点 BATTLE 的瞬间 `[battle] entry failed`。
         2026-09-17 用户投诉「新加的游戏有的打不开」正是这一类，静态审计永远抓不到。
         若它因机器负载偶发超时（假红），单独重跑一次再判：
           OSS_DEEP=1 node test/verify-oss-games.js http://127.0.0.1:8081
         想跑快版就去掉 --deep。 */
      ['开源 3D 游戏 4 款', 'verify-oss-games.js', [base, '--deep']],
      /* 新面板（React 单文件版，2026-09-17 换上，用户指定的 modernizing-ma 工程）。
         整包替换根路径：611KB 单文件 index.html（vite-plugin-singlefile 内联 JS/CSS）。
         守的是「换面板没换坏」：真渲染（#root 非空）→ /api/me 判定成 real 而非
         静默降级 demo → 同源登录 → 关键 API 契约逐个对形状 → 带会话重载进主界面
         （而不是卡在登录页）→ 7 个功能分组都在 → 无未捕获异常。
         ⚠️ 断言时机是这里最容易写错的地方：控件数量/功能分组必须**在重载之后**断言，
         在登录页上断言会误报 FAIL（登录页只有 3 个控件）。 */
      ['新面板', 'shot-newpanel.js', [base]],
      /* 新面板「数据面」复核：8 张用户截图暴露的问题逐条钉死。
         与 shot-newpanel 的分工：那份管"壳子能起来"（渲染/不降级/分组在），
         这份管"里面填的是真数据"——连接服务 6 行有状态、设备在线数 > 0、
         AI 读得到模型名、不再出现「原工作站」措辞。
         ⚠️ 必须走同源登录 + **Page.reload**：fetch 登录只设 cookie，
         React store 不认，页面会退回登录页，误报成"页面坏了"。 */
      ['新面板数据面', 'spotcheck-fix.js', [base]],
      ['增强项回归', 't-enhance.js', skipLlm ? [legacyBase, '--no-llm'] : [legacyBase]],
    ];

const results = [];
for (const [name, file, extra] of suites) {
  console.log('\n\n' + '█'.repeat(60));
  console.log(`█ ${name}  (${file})`);
  console.log('█'.repeat(60));
  /* 两个 base 都通过环境变量下发：有的套件读 argv[2]，有的读 process.env.BASE。
     统一给足，避免「传了 argv 但套件只认 env」导致它悄悄打默认根路径 ——
     界面收敛后那就是新前端，旧界面的断言会一片红且看不出原因。
     LEGACY_BASE 供需要显式知道旧界面位置的套件使用。 */
  const suiteBase = extra.find((a) => typeof a === 'string' && a.startsWith('http')) || base;
  const r = spawnSync(process.execPath, [path.join(__dirname, file), ...extra], {
    stdio: 'inherit',
    env: { ...process.env, BASE: suiteBase, LEGACY_BASE: legacyBase },
  });
  results.push({ name, code: r.status === 0 ? 'PASS' : 'FAIL', status: r.status });
}

console.log('\n\n' + '='.repeat(60));
console.log('回归汇总');
console.log('='.repeat(60));
for (const r of results) console.log(`  ${r.code === 'PASS' ? '✅' : '❌'}  ${r.name}`);
const bad = results.filter((r) => r.status !== 0).length;
console.log('\n' + (bad ? `❌ ${bad}/${results.length} 套件失败` : `✅ 全部 ${results.length} 套件通过`));
console.log('目标站点: ' + base);
process.exit(bad ? 1 : 0);

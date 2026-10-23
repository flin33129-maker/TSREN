'use strict';

/* =====================================================================
   aiview.js — AI 助手全屏对话视图（P0 体验升级 + P2 模块化拆分）
   ──────────────────────────────────────────────────────────────────────
   从 station.js 拆出：原来 renderAI/sendAI 是 290 行的「卡片流」，
   对话区被压在卡片里、高度不够、没有停止生成、没有建议提示词、错误只能看文字。

   现在：占满模块高度的真对话界面
     - 消息气泡（用户右 / AI 左）、流式逐字上屏 + 光标
     - 停止生成（AbortController）、错误重试
     - 空状态建议提示词；Markdown 轻量渲染（代码块 / 行内码 / 粗体）
     - 设置抽屉：推理后端增删切换 + 生成参数（沿用 station 的配置所有权）
     - 键盘：Enter 发送、Shift+Enter 换行；尊重 prefers-reduced-motion

   依赖全局（app.js 顶层函数）：api / jsonPost / toast / escHTML
   状态所有权：对话历史在本模块内（跨模块切换不丢）；后端配置仍归 station.js
   ===================================================================== */

(function () {
  /* ---------------- 极小 DOM 辅助 ---------------- */
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const esc = (s) => (typeof escHTML === 'function' ? escHTML(String(s)) : String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  /* ---------------- 轻量 Markdown ----------------
     只需要：``` 代码块 / `行内码` / **粗体** / 换行。
     不引入任何依赖，避免为聊天框拉一个完整 markdown 解析器。 */
  function mdLite(src) {
    const parts = [];
    const re = /```(\w*)\n?([\s\S]*?)```/g;
    let last = 0, m;
    while ((m = re.exec(src))) {
      if (m.index > last) parts.push({ t: 'p', v: src.slice(last, m.index) });
      parts.push({ t: 'code', lang: m[1], v: m[2] });
      last = m.index + m[0].length;
    }
    if (last < src.length) parts.push({ t: 'p', v: src.slice(last) });

    return parts.map((p) => {
      if (p.t === 'code') {
        return '<pre class="aim-pre"><code>' + esc(p.v.replace(/\n$/, '')) + '</code></pre>';
      }
      let h = esc(p.v);
      h = h.replace(/`([^`\n]+)`/g, '<code class="aim-code">$1</code>');
      h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      return h.replace(/\n/g, '<br>');
    }).join('');
  }

  /* ---------------- 口头禅 / 标注回声清洗（仅用于显示） ----------------
     后端 lib/ai.js 的 _clean() 只作用于「非流式」返回的整段文本；而界面走的是
     SSE 流式，逐字累积到 msgs[idx].content 再交给 mdLite 渲染，**永远不经过 _clean**。
     所以下面这些必须在前端再洗一遍，否则用户照样能看到：
       · 「根据搜索结果，」「我帮你看看这个目录里有什么。」这类 2B 固定口癖
       · 系统提示里那行【背景】位置：…；时间：… 被原样抄进回答开头（2026-09-11 实测）
     与后端 lib/ai.js 的 PREAMBLE_RULES / stripBgEcho 是同一套判据，改一处要同步另一处。 */
  function cleanTic(s, hadTools) {
    if (!s) return s;
    let t = String(s);

    /* 0) 「背景标注回声」—— 问「我在哪个盘」答「当前路径是 private；时间：2026-09-11 周五 18:16。」
       提示词里明写过"不要把它抄出来"，2B 照抄不误，只能后处理。
       ⚠️ 判据必须同时满足「出现时间签名」+「出现位置/路径字样」，否则用户问
          "现在几点"、模型老实答"现在是2026-09-11 周五 18:16"会被我们吃掉。
       抽成函数是因为要**跑两遍**（见下面第 4 步后的调用）。 */
    const SIG = /\d{4}-\d{1,2}-\d{1,2}\s*周[日一二三四五六]\s*\d{1,2}\s*[:：]\s*\d{2}/;
    const bgEcho = (x) => {
      const head = x.slice(0, 140);
      const hasSig = SIG.test(head);
      /* 第三种信号：行首就是「位置：」标签 —— 时间签名可能已被上一轮剥掉了
         （口癖规则先删掉「根据背景信息，」才把标签露出来），光靠签名会漏。 */
      const hit = /【背景】/.test(head) || (hasSig && /位置|路径|目录|浏览/.test(head))
        || /^[ \t\u3000]*位置\s*[：:=]/.test(x);
      if (!hit) return x;
      let y = x.replace(/【背景】\s*/g, '');
      if (hasSig) {
        // 签名后只吃**一个空白**、不吃句号：句号往往是整句句末标点，吃掉会得到断句
        y = y.replace(new RegExp('[；;，,、|｜]?\\s*时间\\s*[：:=]\\s*' + SIG.source + '[ \\t\\u3000]?', 'g'), '');
      }
      y = y.replace(/^[ \t\u3000]*位置\s*[：:=]\s*/gm, '');   // 只删标签，保留取值
      y = y.replace(/^[ \t\u3000]*[|｜，,；;]\s*/, '');
      y = y.replace(/[ \t\u3000]*[|｜]\s*$/, '');
      return y;
    };
    t = bgEcho(t);

    /* 1) 调过工具时，"我无法获取实时信息"改写成"页面里没给出具体数字"。
       2B 抓不到脚本动态加载的气温之类会这么答，用户读到的是"这功能坏了"。
       没调过工具就不改 —— 那种"无法获取"可能是老实的。 */
    if (hadTools) {
      t = t.replace(/我(?:目前|现在|这边|这里)?(?:暂时)?(?:还)?(?:无法|不能|没法|没办法)(?:获取|取得|拿到|读到|查到|访问|联网(?:获取|查询)?)(?:到)?[^。，,；;！？\n]{0,14}?(?:天气|气温|温度|信息|数据|资料|新闻|行情|股价)(?:信息|数据|情况)?/g,
        (m0) => (/文件|目录|权限|路径|磁盘|读取/.test(m0)
          ? m0
          : '我查到的这几个页面里没有给出具体数字'));
      t = t.replace(/我(?:目前|现在|这边|这里)?(?:暂时)?(?:还)?(?:无法|不能|没法|没办法)(?:回答|提供|给出|确认|判断|告诉)(?:你)?(?:这个问题|该问题|此问题|你的问题|具体数字|准确答案)?/g,
        '我查到的这几个页面里没有给出具体数字');
    }

    /* 2) 协议残留。两类**分开**处理：
       · <answer>/<reply> 只是外壳 → 只脱壳，内容留下
       · <function …>…</function> / <tool_call>…</tool_call> 整块是垃圾 → 连内容一起删
         （否则参数值会以裸文本漏出来） */
    t = t.replace(/<function\s+name\s*=\s*["']?[\w.-]+["']?\s*>[\s\S]*?<\/function>/gi, '')
         .replace(/<tool_?call[\s\S]*?<\/tool_?call>/gi, '')
         .replace(/<\|?tool_?calls?_?begin\|?>[\s\S]*?<\|?tool_?calls?_?end\|?>/gi, '');
    t = t.replace(/<\s*\/?\s*(answer|reply|response|final_answer|结论)\s*>/gi, '')
         .replace(/<\s*\/?\s*(function|param|tool_call|tool_calls)\b[^>]*>/gi, '');

    /* 3) 「根据搜索结果，」「依据上述资料：」「据我所知，」这类口水话。
       ⚠️ 两点必须容下（都是实测漏过的）：
         · 检索与名词之间会插"到的/出的" →「根据检索到的信息，…」
         · 会出现在**句中** →「…天气信息。根据搜索结果，北京今天的预报包括…」
       句中这条用回调保留前导标点，否则两句话会被粘成一句。 */
    const keepLead = (m0) => (/^[。；;！？\n]/.test(m0) ? m0[0] : '');
    t = t.replace(/(?:^|[。；;！？\n])[ \t]*(?:根据|依据|按照|据)?(?:上述|以上|这些|本次)?(?:的)?(?:搜索|检索|查询)(?:到的|出的|到|了)?(?:结果|资料|信息)?(?:来看|来说|显示|表明|发现|指出)?[，,：:][ \t]*/gm, keepLead);
    /* 「根据您提供的位置信息，」「根据背景信息，」—— 2026-09-11 实测口癖，就是
       注入了【背景】那行之后冒出来的：用户问"今天几号"，它先来一句"根据背景信息，"。
       桥接（你/您 + 提供/给出 + 的）与尾部（信息/数据/情况）都要容下。 */
    t = t.replace(/(?:^|[。；;！？\n])[ \t]*(?:根据|依据|按照|据)(?:上述|以上|这些|本次|你|您)?(?:提供|给出|所说|看到的)?的?(?:搜索|检索|查询)?(?:结果|资料|信息|内容|文档|说明|背景|位置|数据)(?:信息|数据|情况)?(?:来看|来说|显示|表明|指出|发现)?[，,：:][ \t]*/gm, keepLead);
    t = t.replace(/(?:^|[。；;！？\n])[ \t]*(?:上述|以上|这些|本次)的?(?:资料|信息|内容|结果|文档|说明)(?:来看|来说|显示|表明|指出|发现)?[，,：:][ \t]*/gm, keepLead);
    /* 只限**行首**的桥接式出处交代（≤10 字桥接），免得误伤正文中间的"根据 X 的规定，…" */
    t = t.replace(/^[ \t]*(?:根据|依据|按照|据)[^。，,；;！？\n]{0,10}?(?:资料|信息|内容|结果|文档|说明|背景|位置)(?:来看|来说|显示|表明|指出|发现)?[，,：:][ \t]*/gm, '');
    t = t.replace(/(?:^|[。；;！？\n])[ \t]*(?:根据|依据|就|据)(?:我(?:的)?)?(?:所)?(?:知|知识|了解|掌握|记得)[，,：:][ \t]*/gm, keepLead);

    /* 4) 空预告：「我帮你查一下」「我来帮你看看这个目录里有什么。」——
       一句话说完就没了，用户看到的是空气泡。 */
    t = t.replace(/(?:^|[。；;！？\n])[ \t]*我(?:(?:来|这就|现在|马上)?(?:帮你|给你|为你)|(?:来|这就|现在|马上))(?:查|搜)(?:一下|一查|一下它|它)?(?:["“「][^"”」\n]{0,24}["”」])?[。！？][ \t]*/gm, keepLead);
    t = t.replace(/(?:^|[。；;！？\n])[ \t]*我(?:(?:来|这就|现在|马上)?(?:帮你|给你|为你)|(?:来|这就|现在|马上))(?:看看|看下|看一下|看一遍|瞧|瞧一瞧|了解一下|浏览一下|整理一下|分析一下|总结一下|查查)[^\n。！？]{0,20}[。！？][ \t]*/gm, keepLead);
    t = t.replace(/(?:^|[。；;！？\n])[ \t]*(?:好的|好)[，,][ \t]*(?:我)?(?:来|这就|现在)?(?:帮你|给你)?(?:查|搜|看看|看下|看一下)(?:一下|一查)?(?:["“「][^"”」\n]{0,24}["”」])?[。！？][ \t]*/gm, keepLead);

    /* 5) 流式打字打到一半的口头禅先藏起来，等它写完整了再一次性显示 */
    t = t.replace(/(^|\n)[ \t]*(?:根据|依据|按照|据)?(?:上述|以上|这些|本次)?(?:的)?(?:搜索|检索|查询)(?:结果|资料|信息)?(?:来看|来说|显示|表明|发现|指出)?[，,：:]?[ \t]*$/, '$1');
    t = t.replace(/(^|\n)[ \t]*(?:好的|好)[，,]?[ \t]*(?:我)?(?:来|这就|现在)?(?:帮你|给你|为你)?(?:查|搜|看看|看下|看一下)(?:一下|一查)?(?:它)?[。！？]?[ \t]*$/, '$1');

    /* 6) 自报家门（"我是 MiniCPM 系列模型，由面壁智能开发…"）。
       静态提示词里明写过"回答里不要提及模型名称、推理框架或部署细节"，2B 照样报 ——
       与「根据搜索结果，」同一类**强先验**，喊话压不住，只能后处理。
       判据两条同时成立才动手，免得误伤"MiniCPM 是什么"这种事实性回答：
         ① 出现品牌/框架名；② 出现第一人称自我指认（我是 / 我叫 / 我就是）。
       与后端 lib/ai.js 的 stripSelfId 同一套规则，改一处必须同步另一处。

       ⚠️ 必须排在**末遍 bgEcho 之前**：删掉开头那句自我介绍后，
          「位置：…」标签会被顶到行首来，正好是 bgEcho 唯一认的行首形态。
          顺序反了会残留「位置：私人空间。」（实测）。 */
    if (/MiniCPM|面壁智能|面壁|ModelBest|llama\.?cpp|llama-?server|GGUF/i.test(t)) {
      const segs = t.split(/(?<=[。！？!?\n])/);
      const keep = [];
      let dropped = false;
      for (const seg of segs) {
        if (seg && /MiniCPM|面壁智能|面壁|ModelBest|llama\.?cpp|llama-?server|GGUF/i.test(seg)
          && /(?:我|本人)(?:是|叫|就是|名为)|^本(?:模型|助手)/.test(seg)) { dropped = true; continue; }
        keep.push(seg);
      }
      if (dropped) {
        const r = keep.join('').trim();
        t = r.replace(/[\s。！？!?，,、~～]/g, '').length < 4
          ? '我是这台工作站的内置助手，可以帮你列目录、读文件、搜索文件，也可以联网搜索。'
          : r;
      }
    }

    /* 7) ⚠️ 末遍标注回声，兜住前面几步**新露出来**的残留：
       第 3 步剥口癖会把「【背景】位置：…」的标签顶到行首；
       第 6 步删自我介绍同理。只剥一次会残留（实测），所以这一遍不能省。
       后端 lib/ai.js 的 _clean 里顺序完全一致，改这里记得同步那边。 */
    t = bgEcho(t);

    return t;
  }

  /* ---------------- 模块状态 ---------------- */
  let host = null, cfgFn = null, reloadFn = null, cwdFn = null;
  let msgs = [];            // {role:'user'|'assistant', content, ts, ms?, usage?, tools?}
  let busy = false;
  let ctrl = null;          // AbortController
  let draft = '';
  let lastError = '';
  let pending = '';         // 首页快捷提问暂存的文本
  let settingsOpen = false;
  let stickBottom = true;   // 用户手动上滚时停止自动贴底
  let liveTools = [];       // 本轮工具调用记录（用于气泡下方展示"读了什么"）
  let lastUsage = null;     // 最近一次的用量（头部常显）

  const SUGGEST = [
    '这个目录里都有什么？帮我总结一下',
    '读一下当前目录的说明文件，告诉我重点',
    '帮我看看现在的磁盘健康吗',
    '我刚才说的那个文件在哪？帮我找找',
  ];

  /** 当前浏览位置（由 station.js 注入），模型据此理解"这个目录" */
  function cwd() {
    try { return cwdFn ? String(cwdFn() || '') : ''; } catch (e) { return ''; }
  }

  /* ---------------- 渲染 ---------------- */
  /* ---------------- 渲染 ----------------
     ⚠️ 历史事故：shell() 曾无条件 `host.innerHTML = ''` 全量重建。
       而 station.js 的 SSE 处理器在 devices.online/offline 等**高频事件**下会调
       scheduleRefresh() → onRouteEnter('#/ai') → AIView.mount() → shell()，
       实测 10 次/秒重建。后果：用户正在打字的 textarea 每 100ms 被销毁重建，
       输入内容与光标全部丢失（截图里「打了 wwww 却发出去一堆乱码」即此因）。
     修法：① mount 时不无条件重建，仅在结构真的变化时重画；
           ② shell() 复用既有 DOM，只重建消息区与设置抽屉，输入区保持节点不变。 */
  let wrapEl = null;          // 外层容器（左右两栏的父节点）
  let chatEl = null;          // 左栏：头部 + 消息区 + 输入区
  let bodyEl = null;          // 消息区
  let composeEl = null;       // 输入区（必须跨重渲染复用）
  let sideEl = null;          // 右栏：设置面板
  let sigLast = '';           // 结构指纹：变化才重建骨架
  let bodySig = '';           // 消息区指纹：条目数/末条长度变化才重画

  /** 结构指纹：只有这些状态变了才需要重建右栏与骨架 */
  function layoutSig() {
    const c = cfg();
    return [
      settingsOpen, !!(c && c.active), busy, lastError || '',
      /* ⚠️ isAdmin 必须进指纹：它是「配置区渲染哪些区块」的总开关。
         漏掉它的后果实测过 —— 登录拿到管理员权限后 S.aiIsAdmin 已为 true，
         但指纹没变，右栏不重画，添加后端/参数/能力开关永远不出现。 */
      c && c.isAdmin ? 1 : 0,
      c && (c.name || c.model) || '',
      c && c.allowTools !== false ? 1 : 0,
      c && c.allowWeb !== false ? 1 : 0,
      c && c.allowWrite === true ? 1 : 0,
      msgs.length ? 1 : 0,
    ].join('|');
  }

  function shell() {
    if (!host) return;

    /* 宿主被外部清空过（如切模块后又回来）→ 重建骨架 */
    if (!wrapEl || !document.body.contains(wrapEl) || wrapEl.parentElement !== host) {
      host.innerHTML = '';
      wrapEl = el('div', 'aiv');
      host.appendChild(wrapEl);
      /* 左栏：对话本体。右栏是同级兄弟，宽度由 CSS 控制，
         窄屏（<1080px）自动折到下方或收成抽屉 —— 见 station.css */
      chatEl = el('div', 'aiv-chat');
      wrapEl.appendChild(chatEl);
      bodyEl = null; composeEl = null; sideEl = null; sigLast = '';
      buildHead();
    }
    /* 头部在骨架创建时构建一次；可用状态变化时刷新它的徽章 */
    paintHead();

    /* 消息区：每次都重画（内容随时在变），但复用它自己的容器 */
    if (!bodyEl || !document.body.contains(bodyEl)) {
      bodyEl = el('div', 'aiv-body');
      bodyEl.id = 'aivBody';
      bodyEl.onscroll = () => {
        stickBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 60;
      };
      chatEl.appendChild(bodyEl);
      bodySig = '';
    }
    paintBody();

    /* 输入区：复用同一节点 —— 这是输入不丢的关键。
       只有「busy 状态翻转 / 后端可用性变化」才需要替换按钮与占位符。 */
    if (!composeEl || !document.body.contains(composeEl)) {
      composeEl = composeNode();
      chatEl.appendChild(composeEl);
    } else {
      syncCompose();
    }

    /* 右栏：配置面板常驻（这就是"配置放到右边"），窄屏折叠为抽屉 */
    const sig = layoutSig();
    if (!sideEl || !document.body.contains(sideEl)) {
      sideEl = settingsNode();
      wrapEl.appendChild(sideEl);
      sigLast = sig;
    } else if (sig !== sigLast) {
      const fresh = settingsNode();
      wrapEl.replaceChild(fresh, sideEl);
      sideEl = fresh;
      sigLast = sig;
    }
    /* 窄屏抽屉开着时，整个 .aiv 带 .open（CSS 用 ::before 画遮罩）。
       点遮罩应收起抽屉 —— 挂在 wrapEl 上，避免遮罩层吃掉本该给抽屉的点击：
       遮罩在 z-index:89、抽屉 90，点抽屉本体不会落到这里。 */
    wrapEl.classList.toggle('open', !!settingsOpen && narrow());
    if (settingsOpen && narrow()) {
      wrapEl.onclick = (e) => {
        if (e.target === wrapEl || (e.target.classList && e.target.classList.contains('aiv-chat'))) {
          settingsOpen = false; shell();
        }
      };
    } else if (wrapEl.onclick) {
      wrapEl.onclick = null;
    }

    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  /** 是否处于"右栏折成抽屉"的窄屏断点（与 CSS 的 1079px 保持一致） */
  function narrow() {
    try { return window.matchMedia('(max-width: 1079px)').matches; } catch (e) { return false; }
  }

  /** 骨架一次构建：标题 + 操作按钮 */
  function buildHead() {
    const head = el('div', 'aiv-head');
    head.id = 'aivHead';
    const t = el('div', 'aiv-title', 'AI 助手');
    const chip = el('span', 'aiv-chip');
    chip.id = 'aivChip';
    head.appendChild(t);
    head.appendChild(chip);

    const acts = el('div', 'aiv-acts');
    /* 手机上右栏折成抽屉，需要一个开关；桌面端面板常驻，按钮自动隐藏 */
    const bSet = el('button', 'aiv-btn ghost aiv-setbtn', '配置');
    bSet.onclick = () => { settingsOpen = !settingsOpen; shell(); };
    const bClr = el('button', 'aiv-btn ghost', '清空');
    bClr.id = 'aivClear';
    bClr.onclick = () => { msgs = []; lastError = ''; lastUsage = null; bodySig = ''; shell(); };
    acts.appendChild(bSet);
    acts.appendChild(bClr);
    head.appendChild(acts);
    (chatEl || wrapEl).appendChild(head);
  }

  /** 头部动态部分：连接徽章（只显示模型名，不暴露后端/框架细节） + 清空按钮禁用态 */
  function paintHead() {
    const chip = host.querySelector('#aivChip');
    if (chip) {
      chip.innerHTML = '';
      const c = cfg();
      const dot = el('span', 'aiv-dot' + (c && c.active ? ' on' : ''));
      chip.appendChild(dot);
      /* 用户要求：不显示「MiniCPM5-2B」「本机 llama.cpp（当前）」这类后端细节。
         这里只显示一个友好的模型标识；实在没有就显示「已就绪」。 */
      chip.appendChild(document.createTextNode(c && c.active ? modelLabel() : '未配置'));
    }
    const clr = host.querySelector('#aivClear');
    if (clr) clr.disabled = !msgs.length || busy;
  }

  /**
   * 界面上对外展示的模型标识。
   *
   * 用户明确要求不要看到「MiniCPM5-2B」「本机 llama.cpp（当前）」这类内部信息：
   *   - 「本机 llama.cpp」是**实现框架**，跟用户想干什么无关
   *   - 「MiniCPM5-2B」是**内部型号**，同样不该糊到脸上
   * 所以这里把这类技术标识统一收�敛成中性文案；只有用户自己起的名字才直接展示
   * （比如他写了「客厅主机」），那才是他真正想用来区分的东西。
   */
  const TECH_NAME = /llama\.?cpp|ollama|vllm|lm\s*studio|text-generation|openai|minicpm|qwen|deepseek|glm|llama-?\d|gguf|\b\d+\s*b\b/i;

  function modelLabel() {
    const c = cfg();
    const raw = String((c && (c.name || c.model)) || '').trim();
    if (!raw) return '已就绪';
    /* 路径 / 文件名 / 技术框架名 / 内部型号 → 一律不展示 */
    if (/[\\/]/.test(raw) || /\.gguf$/i.test(raw) || TECH_NAME.test(raw)) return '已就绪';
    return raw;
  }

  /** 消息区内容。流式生成中不重画（增量由 paintDelta 负责），
      否则每个 SSE 事件都会把已渲染的正文清掉再重建 → 闪烁且丢失节点引用。 */
  function paintBody() {
    if (!bodyEl) return;
    if (busy) return;
    const c = cfg();
    /* ⚠️ 指纹必须带上「是否已配置后端」。0 消息时前 3 段恒为 "0::"，
       若不含 active，则首次挂载（配置还没拉到）渲染出的空状态会被永久锁住：
       配置到位后再进 paintBody，指纹没变 + 已有子节点 → 直接 return，
       于是右栏显示「192.168.x.x · 使用中」、头部显示「已就绪」，
       中间却还写着「还没有配置推理后端」—— 即用户反馈的「没识别成功」。
       同 layoutSig 漏 isAdmin 是同一类差量渲染缺陷。 */
    const sig = msgs.length + ':' + (msgs.length ? (msgs[msgs.length - 1].content || '').length : 0)
      + ':' + (lastError || '')
      + ':a' + (c && c.active ? 1 : 0);
    if (sig === bodySig && bodyEl.childElementCount) return;
    bodySig = sig;
    bodyEl.innerHTML = '';
    if (!msgs.length) {
      const empty = el('div', 'aiv-empty');
      empty.appendChild(el('div', 'aiv-empty-ic', '◈'));
      empty.appendChild(el('div', 'aiv-empty-t',
        c && c.active ? '我可以直接操作这台工作站上的文件' : '还没有配置推理后端'));
      empty.appendChild(el('div', 'aiv-empty-s', c && c.active
        ? '让我读文件、列目录、找东西都行 —— 内容不出局域网，模型跑在你自己指定的机器上。'
        : '在右侧面板添加一个 llama.cpp / OpenAI 兼容地址即可开始。'));
      if (c && c.active) {
        const sug = el('div', 'aiv-sug');
        for (const s of SUGGEST) {
          const b = el('button', 'aiv-sug-i', s);
          b.onclick = () => { setDraft(s); send(); };
          sug.appendChild(b);
        }
        empty.appendChild(sug);
      }
      bodyEl.appendChild(empty);
    } else {
      for (let i = 0; i < msgs.length; i++) bodyEl.appendChild(msgNode(msgs[i], i));
    }
  }

  /** 让既有输入区跟上状态（不动 textarea 本身的值与光标） */
  function syncCompose() {
    const c = cfg();
    const ta = composeEl.querySelector('.aiv-ta');
    const enabled = !busy && !!(c && c.active);
    if (ta) {
      ta.disabled = !enabled;
      ta.placeholder = busy ? '正在生成…'
        : (c && c.active ? '输入消息，Enter 发送 · Shift+Enter 换行' : '请先在设置里配置推理后端');
      /* 仅当外部改过 draft（如点建议词）才回写，避免打断正在输入的用户 */
      if (ta.value !== draft && document.activeElement !== ta) ta.value = draft;
    }
    /* 按钮：busy 时是「停止」，否则是「发送」—— 形态变化才替换 */
    const bar = composeEl.querySelector('.aiv-bar');
    const cur = composeEl.querySelector('.aiv-send');
    const wantStop = busy;
    const isStop = cur && cur.classList.contains('stop');
    if (!cur || wantStop !== isStop) {
      /* 注意：按钮的父节点是 .aiv-bar 而非 composeEl —— 用错父节点会抛 removeChild */
      const parent = (cur && cur.parentElement) || bar;
      if (cur && parent) parent.removeChild(cur);
      if (wantStop) {
        const st = el('button', 'aiv-send stop', '停止');
        st.onclick = stop;
        if (bar) bar.appendChild(st);
      } else {
        const sd = el('button', 'aiv-send', '发送');
        sd.disabled = !draft.trim() || !(c && c.active);
        sd.onclick = () => send();
        if (bar) bar.appendChild(sd);
      }
    } else if (cur && !wantStop) {
      cur.disabled = !draft.trim() || !(c && c.active) || !enabled;
    }
    /* 底部状态行 */
    const foot = composeEl.querySelector('.aiv-foot');
    if (foot) {
      foot.innerHTML = '';
      if (lastError) {
        foot.appendChild(el('span', 'aiv-err', '上次错误：' + lastError));
        const rt = el('button', 'aiv-link', '重试');
        rt.onclick = () => { send(true); };
        foot.appendChild(rt);
      } else {
        foot.appendChild(el('span', '', msgs.length ? msgs.length + ' 条消息' : ''));
      }
    }
  }

  function msgNode(m, i) {
    const row = el('div', 'aim' + (m.role === 'user' ? ' user' : ''));
    const av = el('div', 'aim-av', m.role === 'user' ? '我' : '◈');
    row.appendChild(av);
    const box = el('div', 'aim-main');

    /* AI 读写了哪些文件：气泡上方一行小徽章，让"它真的动了手"可见 */
    if (m.role === 'assistant' && m.tools && m.tools.length) {
      const tl = el('div', 'aim-tools');
      for (const t of m.tools) {
        const b = el('span', 'aim-tool' + (t.err ? ' bad' : ''), toolLabel(t));
        b.title = t.result ? String(t.result).slice(0, 400) : '';
        tl.appendChild(b);
      }
      box.appendChild(tl);
    }

    const bub = el('div', 'aim-b');
    if (m.role === 'assistant') {
      if (m.content) bub.innerHTML = mdLite(cleanTic(m.content, !!(m.tools && m.tools.length)));
      else if (busy && i === msgs.length - 1) bub.appendChild(el('span', 'aim-caret'));
    } else {
      bub.textContent = m.content;
    }
    box.appendChild(bub);

    /* 用量行：输入 / 输出 / 速度 —— 用户明确要求展示在模型输出下方 */
    const meta = el('div', 'aim-meta');
    if (m.ts) meta.appendChild(el('span', '', clock(m.ts)));
    if (m.role === 'assistant') {
      const u = m.usage;
      if (u) {
        if (u.prompt != null) meta.appendChild(el('span', 'tok', ' ↑' + u.prompt));
        if (u.completion != null) meta.appendChild(el('span', 'tok', ' ↓' + u.completion));
        if (u.total != null) meta.appendChild(el('span', 'tok', ' Σ' + u.total));
        if (u.tps != null) {
          const s = el('span', 'tps', ' ⚡' + u.tps + ' t/s');
          s.title = '生成速度（每秒输出的 token 数）';
          meta.appendChild(s);
        }
      }
      if (m.ms) meta.appendChild(el('span', '', ' · ' + (m.ms / 1000).toFixed(1) + 's'));
    }
    if (m.err) meta.appendChild(el('span', 'bad', ' · 失败'));
    if (meta.childElementCount) box.appendChild(meta);

    row.appendChild(box);
    return row;
  }

  /** 工具调用 → 人话标签 */
  function toolLabel(t) {
    const a = t.args || {};
    const where = a.path ? String(a.path) : (a.disk ? String(a.disk) : '');
    const m = {
      list_dir: '📂 列目录',
      read_file: '📖 读文件',
      search_files: '🔍 搜索',
      file_info: 'ℹ️ 文件信息',
      disk_usage: '💾 磁盘用量',
      write_file: '✏️ 写文件',
      make_dir: '📁 建目录',
    }[t.name] || ('🔧 ' + t.name);
    const tail = t.phase === 'call' ? '…' : '';
    return m + (where ? ' ' + where : '') + tail;
  }

  function clock(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function composeNode() {
    const wrap = el('div', 'aiv-compose');
    /* 单行输入条：textarea 自适应撑开，按钮贴右 —— 此前缺这层 flex 容器，
       textarea 与按钮各自成块，按钮被挤到下一行还压在上方，观感是「输入框坏了」 */
    const bar = el('div', 'aiv-bar');
    const ta = el('textarea', 'aiv-ta');
    ta.rows = 1;
    ta.placeholder = busy ? '正在生成…' : (cfg() && cfg().active ? '输入消息，Enter 发送 · Shift+Enter 换行' : '请先在设置里配置推理后端');
    ta.disabled = busy || !(cfg() && cfg().active);
    ta.value = draft;
    ta.oninput = () => {
      draft = ta.value;
      ta.style.height = 'auto';
      const h = Math.min(168, ta.scrollHeight);
      ta.style.height = h + 'px';
      /* 顶到上限才允许内部滚动，否则单行也会画出滚动条轨道 */
      ta.classList.toggle('scroll', ta.scrollHeight > 168);
      const b = host.querySelector('.aiv-send');
      if (b && !busy) b.disabled = !draft.trim();
    };
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
    bar.appendChild(ta);

    if (busy) {
      const st = el('button', 'aiv-send stop', '停止');
      st.onclick = stop;
      bar.appendChild(st);
    } else {
      const sd = el('button', 'aiv-send', '发送');
      sd.disabled = !draft.trim() || !(cfg() && cfg().active);
      sd.onclick = () => send();
      bar.appendChild(sd);
    }
    wrap.appendChild(bar);

    const foot = el('div', 'aiv-foot');
    if (lastError) {
      foot.appendChild(el('span', 'aiv-err', '上次错误：' + lastError));
      const rt = el('button', 'aiv-link', '重试');
      rt.onclick = () => { send(true); };
      foot.appendChild(rt);
    } else {
      foot.appendChild(el('span', '', msgs.length ? msgs.length + ' 条消息' : ''));
    }
    wrap.appendChild(foot);
    return wrap;
  }

  /**
   * 右栏配置面板（常驻，不再需要点「设置」才出现）。
   * 内容：当前模型 / 后端切换与添加（含局域网其他机器）/ 生成参数 / 能力开关。
   * 窄屏由 CSS 折成可开合抽屉，头部「配置」按钮负责开合。
   */
  function settingsNode() {
    const c = cfg();
    const box = el('div', 'aiv-set' + (settingsOpen ? ' open' : ''));
    box.id = 'aivSet';

    /* ---------- 顶部：当前模型 + 最近用量 ---------- */
    const cur = el('div', 'aiv-cur');
    const curTop = el('div', 'aiv-cur-top');
    curTop.appendChild(el('span', 'aiv-dot' + (c && c.active ? ' on' : '')));
    curTop.appendChild(el('span', 'aiv-cur-nm', c && c.active ? modelLabel() : '未配置后端'));
    const mclose = el('button', 'aiv-set-x', '×');
    mclose.onclick = () => { settingsOpen = false; shell(); };
    curTop.appendChild(mclose);
    cur.appendChild(curTop);
    if (lastUsage) {
      const u = lastUsage;
      const line = el('div', 'aiv-cur-u');
      if (u.prompt != null) line.appendChild(el('span', '', '输入 ' + u.prompt));
      if (u.completion != null) line.appendChild(el('span', '', '输出 ' + u.completion));
      if (u.tps != null) line.appendChild(el('span', 'hot', u.tps + ' t/s'));
      cur.appendChild(line);
    } else {
      /* 还没对话过时这里原本是空的 —— 一张只有「已就绪」标签的空白卡，
         看着像没加载完。给一句状态说明，卡片就不空了。 */
      cur.appendChild(el('div', 'aiv-cur-u', c && c.active
        ? '推理服务在线，可以直接开始对话'
        : '尚未选择推理服务，请在下方添加'));
    }
    box.appendChild(cur);

    box.appendChild(el('div', 'aiv-set-h', '推理后端'));

    for (const b of (c.backends || [])) {
      const row = el('div', 'aiv-set-row' + (b.active ? ' on' : ''));
      row.appendChild(el('span', 'aiv-dot' + (b.active ? ' on' : '')));
      const mid = el('div', 'aiv-set-mid');
      /* 用户要求：不显示「MiniCPM5-2B」「本机 llama.cpp（当前）」。
         这里显示人给的名字 + 地址；模型文件名只在没有名字时才作兜底。 */
      const nice = prettyBackendName(b);
      mid.appendChild(el('div', 'nm', nice + (b.active ? ' · 使用中' : '')));
      mid.appendChild(el('div', 'mt', b.url || ''));
      row.appendChild(mid);
      const ops = el('div', 'aiv-set-ops');
      const pb = el('button', 'aiv-btn ghost', '探测');
      pb.title = '测试这台机器上的推理服务是否在线';
      pb.onclick = async () => {
        toast('探测中…', '');
        try {
          const x = await api('/api/ai/probe?id=' + encodeURIComponent(b.id));
          toast('通 ' + x.ms + 'ms', 'ok');
        } catch (e) { toast('不通：' + (e.message || ''), 'bad'); }
      };
      ops.appendChild(pb);
      if (c.isAdmin && !b.active) {
        const sb = el('button', 'aiv-btn ghost', '切换');
        sb.onclick = () => jsonPost('/api/ai/active', { id: b.id })
          .then(() => { afterCfg(); toast('已切换', 'ok'); })
          .catch((e) => toast(e.message || '失败', 'bad'));
        ops.appendChild(sb);
      }
      if (c.isAdmin) {
        const db = el('button', 'aiv-btn ghost', '删除');
        db.onclick = () => {
          if (!window.confirm('删除这个后端？')) return;
          jsonPost('/api/ai/backend/remove', { id: b.id })
            .then(() => { afterCfg(); toast('已删除', 'ok'); })
            .catch((e) => toast(e.message || '失败', 'bad'));
        };
        ops.appendChild(db);
      }
      row.appendChild(ops);
      box.appendChild(row);
    }

    /* ---------- 添加：局域网内其他机器的模型 ---------- */
    if (c.isAdmin) {
      box.appendChild(el('div', 'aiv-set-h', '添加局域网模型'));
      const add = el('div', 'aiv-set-add');
      const u = el('input', 'aiv-input');
      u.placeholder = 'http://192.168.8.13:8080';
      u.inputMode = 'url';
      const nm = el('input', 'aiv-input');
      nm.placeholder = '给它起个名字（可选）';
      const ab = el('button', 'aiv-btn', '添加');
      ab.onclick = () => {
        const url = (u.value || '').trim();
        if (!url) return toast('地址不能为空', 'bad');
        if (!/^https?:\/\//i.test(url)) return toast('地址需以 http:// 开头', 'bad');
        jsonPost('/api/ai/backend', { url, name: nm.value })
          .then(() => { afterCfg(); toast('已添加，点「探测」验证连通', 'ok'); })
          .catch((e) => toast(e.message || '失败', 'bad'));
      };
      add.appendChild(u); add.appendChild(nm); add.appendChild(ab);
      box.appendChild(add);
      box.appendChild(el('div', 'aiv-note',
        '填对方机器上 OpenAI 兼容服务的地址（llama.cpp / vLLM / Ollama 都可以），必须带端口。'));

      /* ---------- 生成参数 ---------- */
      box.appendChild(el('div', 'aiv-set-h', '生成参数'));
      const pr = el('div', 'aiv-set-add');
      const sys = el('input', 'aiv-input');
      sys.placeholder = '系统提示词';
      sys.value = c.system || '';
      const tp = el('input', 'aiv-input num'); tp.placeholder = '温度';
      tp.value = String(c.temperature != null ? c.temperature : 0.7);
      const mt = el('input', 'aiv-input num'); mt.placeholder = '最大 token';
      mt.value = String(c.maxTokens != null ? c.maxTokens : 1024);
      const lab = el('label', 'aiv-chk');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = c.noThink !== false;
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode('关闭思考'));
      const sv = el('button', 'aiv-btn', '保存');
      sv.onclick = () => jsonPost('/api/ai/params', {
        system: sys.value,
        temperature: Number(tp.value),
        maxTokens: Number(mt.value),
        disableThinking: cb.checked,
      }).then(() => { afterCfg(); toast('已保存', 'ok'); })
        .catch((e) => toast(e.message || '失败', 'bad'));
      pr.appendChild(sys); pr.appendChild(tp); pr.appendChild(mt); pr.appendChild(lab); pr.appendChild(sv);
      box.appendChild(pr);

      /* ---------- 能力开关：让它真正读写文件、联网 ---------- */
      box.appendChild(el('div', 'aiv-set-h', '能力'));
      const cap = el('div', 'aiv-caps');
      cap.appendChild(chkRow('读取文件', c.allowTools !== false,
        '允许 AI 查看目录、读文本文件、搜文件名、看磁盘用量',
        (v) => saveParams({ allowTools: v })));
      cap.appendChild(chkRow('联网搜索', c.allowWeb !== false,
        '允许 AI 搜索网络、打开网页。问新闻/天气/价格这类外部信息时它才会去查，'
        + '而不是凭空编造。只能访问公网，不会碰你的局域网设备',
        (v) => saveParams({ allowWeb: v })));
      cap.appendChild(chkRow('写入文件', c.allowWrite === true,
        '允许 AI 新建文件与目录。开启后它能直接在你的网盘里落文件，请确认你信任所用模型',
        (v) => saveParams({ allowWrite: v }), true));
      box.appendChild(cap);

      const rr = el('div', 'aiv-set-add');
      const rl = el('label', 'aiv-chk', '最多工具轮次');
      const rt = el('input', 'aiv-input num');
      rt.value = String(c.maxToolRounds != null ? c.maxToolRounds : 4);
      const rb = el('button', 'aiv-btn', '应用');
      rb.onclick = () => saveParams({ maxToolRounds: Number(rt.value) });
      rr.appendChild(rl); rr.appendChild(rt); rr.appendChild(rb);
      box.appendChild(rr);

      box.appendChild(el('div', 'aiv-note',
        '「关闭思考」务必保留：推理模型会把思维链写进 reasoning_content 吃光 max_tokens，正文反而为空。'));
    }

    return box;
  }

  /** 一个带说明的开关行 */
  function chkRow(label, checked, hint, onchange, warn) {
    const row = el('label', 'aiv-cap' + (warn ? ' warn' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.onchange = () => onchange(cb.checked);
    row.appendChild(cb);
    const mid = el('div', 'aiv-cap-mid');
    mid.appendChild(el('div', 'aiv-cap-t', label));
    mid.appendChild(el('div', 'aiv-cap-s', hint));
    row.appendChild(mid);
    return row;
  }

  function saveParams(patch) {
    jsonPost('/api/ai/params', patch)
      .then(() => { afterCfg(); toast('已更新', 'ok'); })
      .catch((e) => toast(e.message || '失败', 'bad'));
  }

  /**
   * 后端显示名。
   * 同 modelLabel：用户不想看到框架名与内部型号。
   * 规则：优先人给的名字（且不含技术标识）；否则用地址主机名区分机器；
   * 都没有才回落「推理服务」。
   */
  function prettyBackendName(b) {
    const nm = String(b.name || '').trim();
    if (nm && !/\.gguf$/i.test(nm) && !/[\\/]/.test(nm) && !TECH_NAME.test(nm)) return nm;
    try {
      const h = new URL(b.url).hostname;
      if (h) return h === '127.0.0.1' || h === 'localhost' ? '本机服务' : h;
    } catch (e) { /* 地址不合法就继续往下 */ }
    return '推理服务';
  }

  function afterCfg() {
    if (reloadFn) reloadFn().then(() => { if (mounted()) shell(); });
  }

  function cfg() { return cfgFn ? cfgFn() : {}; }
  function setDraft(t) { draft = t; }

  /* ---------------- 发送 / 流式 ---------------- */
  async function send(retry) {
    if (busy) return;
    const text = (retry ? msgs.filter((m) => m.role === 'user').pop() : null);
    const content = retry ? (text && text.content) : draft.trim();
    if (!content) return;
    if (!cfg().active) return toast('未配置推理后端', 'bad');

    if (!retry) {
      msgs.push({ role: 'user', content, ts: Date.now() });
      draft = '';
      /* 清空后把 textarea 收回单行高度 */
      const ta = composeEl && composeEl.querySelector('.aiv-ta');
      if (ta) { ta.value = ''; ta.style.height = 'auto'; ta.classList.remove('scroll'); }
    } else {
      /* 重试：把上一条失败/空的 AI 回复去掉 */
      if (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    }
    const started = Date.now();
    msgs.push({ role: 'assistant', content: '', ts: Date.now() });
    busy = true; lastError = ''; ctrl = new AbortController();
    stickBottom = true;
    /* 先把本轮「用户 + 空的 AI 气泡」画出来（busy 之后 paintBody 会跳过，
       所以这里必须先建立骨架再置 busy） */
    if (bodyEl) {
      bodyEl.innerHTML = '';
      for (let i = 0; i < msgs.length; i++) bodyEl.appendChild(msgNode(msgs[i], i));
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
    syncCompose();

    const idx = msgs.length - 1;
    liveTools = [];
    /* 流式增量：每次都要**重新查找**目标节点。
       踩过的坑：早期把 body/node 缓存成常量，但高频 SSE 事件会触发 shell()
       重画消息区，缓存的引用随即指向游离节点 → 内容写进不可见的 DOM，
       界面表现为「AI 一直不回复」。 */
    const paintDelta = () => {
      if (!bodyEl || !document.body.contains(bodyEl)) return;
      const rows = bodyEl.querySelectorAll('.aim');
      const last = rows[rows.length - 1];
      if (!last) return;
      const bubble = last.querySelector('.aim-b');
      if (bubble && msgs[idx].content) bubble.innerHTML = mdLite(cleanTic(msgs[idx].content, !!(msgs[idx].tools && msgs[idx].tools.length)));
      if (stickBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
    };

    try {
      const r = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          stream: true,
          /* 带上当前浏览位置：模型据此理解"这个目录""这里面"指的是哪 */
          cwd: cwd(),
          messages: msgs.slice(0, idx).map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error((j && j.error) || ('HTTP ' + r.status));
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 2);
          if (!chunk.startsWith('data:')) continue;
          let j;
          try { j = JSON.parse(chunk.slice(5).trim()); } catch { continue; }
          if (j.delta) { msgs[idx].content += j.delta; paintDelta(); }
          if (j.error) lastError = j.error;
          /* 工具事件：模型正在读/写文件。把它显示出来，让过程可感知 */
          if (j.tool && j.tool.phase === 'call') {
            liveTools.push({ name: j.tool.name, args: j.tool.args, phase: 'call' });
            msgs[idx].tools = liveTools.slice();
            repaintTools(idx);
          }
          if (j.tool && j.tool.phase === 'result') {
            const last = liveTools[liveTools.length - 1];
            if (last && last.name === j.tool.name) {
              last.result = j.tool.result;
              last.phase = 'result';
              last.err = /^错误/.test(String(j.tool.result || ''));
            }
            msgs[idx].tools = liveTools.slice();
            repaintTools(idx);
          }
          if (j.done) {
            if (j.usage) { msgs[idx].usage = j.usage; lastUsage = j.usage; }
            if (Array.isArray(j.toolLog) && j.toolLog.length) {
              msgs[idx].tools = j.toolLog.map((t) => ({
                name: t.name, args: t.args, result: t.result,
                err: /^错误/.test(String(t.result || '')),
              }));
            }
          }
        }
      }
      msgs[idx].ms = Date.now() - started;
      if (!msgs[idx].content) {
        msgs[idx].content = lastError ? '（失败）' + lastError : '（无输出）';
        msgs[idx].err = true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        msgs[idx].content = msgs[idx].content || '（已停止）';
      } else {
        lastError = String((e && e.message) || e);
        msgs[idx].content = '（失败）' + lastError;
        msgs[idx].err = true;
      }
    } finally {
      busy = false; ctrl = null;
      bodySig = '';           // 强制重画，让用量行/工具徽章落地
      shell();
    }
  }

  /** 工具徽章是后到的（流式过程中才知道），需要单独重画当前气泡的徽章行 */
  function repaintTools(idx) {
    const m = msgs[idx];
    if (!m || !bodyEl || !document.body.contains(bodyEl)) return;
    const rows = bodyEl.querySelectorAll('.aim');
    const last = rows[rows.length - 1];
    if (!last) return;
    const box = last.querySelector('.aim-main');
    const bub = last.querySelector('.aim-b');
    if (!box || !bub) return;
    let tl = box.querySelector('.aim-tools');
    if (!tl) { tl = el('div', 'aim-tools'); box.insertBefore(tl, bub); }
    tl.innerHTML = '';
    for (const t of m.tools) {
      const b = el('span', 'aim-tool' + (t.err ? ' bad' : ''), toolLabel(t));
      b.title = t.result ? String(t.result).slice(0, 400) : '';
      tl.appendChild(b);
    }
    if (stickBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function stop() {
    if (ctrl) { ctrl.abort(); ctrl = null; }
    busy = false;
    shell();
  }

  /* ---------------- 对外 ---------------- */
  /* 当前是否真的显示在 #/ai。
     ⚠️ 踩过的坑（两个都要防）：
       ① 离开模块后 host 可能指向已移除节点 → 消息渲染进游离 DOM，界面毫无反应
       ② 本项目切模块用的是 hidden 属性，节点**依然在 DOM 里** ——
          所以 `document.body.contains(host)` 会误判为"可见"，
          必须再确认所属 .module 没有被 hidden 藏起来 */
  function mounted() {
    if (!host || !document.body.contains(host)) return false;
    const mod = host.closest ? host.closest('.module') : null;
    return !(mod && mod.hidden);
  }

  window.AIView = {
    mount(h, opts) {
      /* 已被高频事件（devices.online/offline → scheduleRefresh）反复调用的入口。
         同一宿主重复 mount 时不再重建骨架：shell() 内部已做复用与差量更新，
         输入区节点因此得以存活，用户正在输入的内容不会被吞掉。 */
      const sameHost = host === h;
      host = h; cfgFn = opts.cfg; reloadFn = opts.reload; cwdFn = opts.cwd;
      if (!sameHost) {
        wrapEl = null; chatEl = null; bodyEl = null;
        composeEl = null; sideEl = null; sigLast = '';
      }
      shell();
      if (pending) { const p = pending; pending = ''; draft = p; send(); }
    },
    /* 首页快捷提问：已挂载直接发，未挂载则暂存并跳过去 */
    ask(text) {
      if (!text) return;
      if (mounted()) { draft = text; send(); return; }
      host = null;
      pending = text;
      if (window.Shell) Shell.go('#/ai');
    },
    isBusy: () => busy,
    isMounted: mounted,
    /* 后端配置有更新（如首次拉到配置、切换了模型）时调用：
       只做一次差量重画，不动输入区节点，不打断正在输入的内容。 */
    refresh() { if (mounted()) shell(); },
  };
})();

'use strict';

/**
 * AI 工具层（v5.2）—— 让助手真正能读/写这台 NAS
 *
 * 设计要点：
 * - 工具在**服务端**执行，模型只负责决定「调什么、传什么参数」。
 *   浏览器不接触文件系统，ACL / 登录态 / 路径穿越防护全部复用既有的
 *   storage.safeResolve + resolveTarget，安全边界不新开一道口子。
 * - 走 OpenAI 兼容的 function calling（tools / tool_calls / role:"tool"）。
 *   llama-server、vLLM、Ollama、OpenAI、DeepSeek 均支持该协议。
 * - 每个工具都返回**纯文本**结果（不是 JSON），便于小模型直接引用。
 * - 写操作分为两档：write_file 需确认（dangerous），list/read/search 只读。
 *   调用方（server.js）通过 allowWrite 决定是否把写工具暴露给模型。
 */

const fs = require('fs');
const path = require('path');

/* token 估算与裁剪已抽到 lib/tok.js —— 联网工具层（ai-web.js）也要用同一套口径，
   而它被本模块委托调用，放在这里会形成循环 require。
   下面继续 re-export，历史调用方（lib/ai.js、各测试套件）无需改动。 */
const { estTokens, clipToTokens, sliceSafe } = require('./tok');
/* 联网工具：搜索 / 抓网页。权限闸门与不可信内容标注都在那一侧。 */
const web = require('./ai-web');
/* R11：Office 文档正文抽取（纯 node 解压 OOXML，见 lib/ooxml.js） */
const ooxml = require('./ooxml');

/**
 * 单次读取的**字节**上限：兜底用，防止把 1GB 日志整个读进内存。
 * ⚠️ 真正生效的是下面的 token 预算 —— 字节上限拦不住小文件烧穿上下文。
 */
const MAX_READ_BYTES = 64 * 1024;
/**
 * 单次读取的 **token 预算**（真正管用的那个闸门）。
 *
 * 实战教训：后端上下文只有 4096，而旧阈值是 64KB。读一个 5.9KB 的中文 txt
 * 就把 prompt 顶到 4642 token，上游直接 400 报
 * `exceeds the available context size`，前端表现为**回答一片空白** ——
 * 用户看到的就是「这 AI 坏了」。
 *
 * 中文约 1 字 ≈ 1 token，所以按字估算。1500 token 留出足够余量给
 * 系统提示 + 历史消息 + 后续轮次。
 */
const MAX_READ_TOKENS = 24000;
/** 单次写入的最大字节数 */
const MAX_WRITE_BYTES = 512 * 1024;
/** 列目录最多返回条目 */
const MAX_LIST = 200;
/** 搜索最多返回条目 */
const MAX_SEARCH = 60;

/* ------------------------------------------------------------------ *
 * 工具声明（喂给模型的 JSON Schema）
 * ------------------------------------------------------------------ */

/* ⚠️ token 预算：工具声明是系统提示之外最肥的一块（实测手机上 7 个工具共 803 token，
   占整个 prompt 的 48%），而它每轮对话都要付这个成本、还挤占 4096 的上下文。
   优化纪律：① 每句话都要能改变模型行为，做不到就删；② 重复出现的参数说明抽成常量，
   别在 7 个工具里各写一遍。改完拿 measure-tokens 复核，别凭感觉。 */
/* R11：盘符说明被每个工具引用一次，原来那句话 30 token × 7 个工具 ≈ 200 token，
   全是重复。压到最短仍保留三种取值的含义。 */
const P_DISK = 'public|private|ext:<id>（默认 public）';

const READ_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      /* ⚠️ 保留「不要凭空回答」：2B 曾直接编造文件名（public、main.py、shuai），
         这句话是压住该行为的关键，不能为了省 token 删掉。
         path 的措辞同样不能写成 `"" 表示根目录` —— 模型会把描述里的字面量抄成参数值
         （事故 2026-09-11：发出 {"path":"\"\""} → 非法路径）。 */
      description: '列出目录下的文件与子目录。问「这个目录里有什么」时必须先调用，不要凭空回答。',
      parameters: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: P_DISK },
          path: { type: 'string', description: '相对路径；省略=用户当前目录。' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读文件内容（文本/代码，或 docx/xlsx/pptx/odt 会自动抽正文）。大文件只返回开头。',
      parameters: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: P_DISK },
          path: { type: 'string', description: '相对路径。' },
          maxBytes: { type: 'number', description: '最多字节数，默认 65536。' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '按文件名关键字递归搜索文件与目录。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '文件名关键字，不区分大小写。' },
          disk: { type: 'string', description: P_DISK },
          path: { type: 'string', description: '搜索起点子目录，省略=整个盘。' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: '查文件或目录详情：大小、修改时间、是否目录、子项数。',
      parameters: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: P_DISK },
          path: { type: 'string', description: '相对路径。' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'disk_usage',
      description: '列出各盘总容量、已用与剩余。',
      parameters: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: P_DISK },
        },
      },
    },
  },
];

const WRITE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或覆盖文本文件，目录不存在会自动创建。',
      parameters: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: P_DISK },
          path: { type: 'string', description: '相对路径，如 "日记/2026-09-10.md"。' },
          content: { type: 'string', description: '要写入的完整文本。' },
          append: { type: 'boolean', description: 'true=追加，默认覆盖。' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_dir',
      description: '新建目录，父目录自动创建。',
      parameters: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: P_DISK },
          path: { type: 'string', description: '相对路径。' },
        },
        required: ['path'],
      },
    },
  },
];

/**
 * 写类工具的**名字**集合。
 *
 * ⚠️ 别拿 WRITE_TOOLS 直接判名字 —— 它是协议对象数组，`WRITE_TOOLS.includes('write_file')`
 * 恒为 false。这个坑真的踩过：权限闸门写成那个样子，看着有防护、实际一行都没生效，
 * 而且**不报错、不告警**，属于最危险的一类"静默空转"。名字一律从这里取。
 */
const WRITE_TOOL_NAMES = WRITE_TOOLS
  .map((t) => (t && t.function && t.function.name) || '')
  .filter(Boolean);

/**
 * 这个工具名是不是写类工具。
 *
 * ⚠️ 判据必须是**名字字符串**。别拿 WRITE_TOOLS 直接判 —— 它是协议对象数组，
 * `WRITE_TOOLS.includes('write_file')` 恒为 false，一行都没生效还不报错。
 * 这个坑真的踩过（见 test/t-fault-inject.js 头部注释）。
 */
function isWriteTool(name) {
  return WRITE_TOOL_NAMES.includes(String(name == null ? '' : name));
}

/**
 * 写闸门的拒绝话术。**两处复用**（run() 的入口闸门 + 落盘点的复查），
 * 避免两处措辞漂移 —— 措辞漂移会让模型以为"换个说法就能过"。
 */
function writeDenied(name) {
  return '错误：写入能力未开启，已拒绝执行 ' + name
    + '。如果用户确实需要新建或修改文件，请告知需要在设置里打开「写入文件」。';
}

/* ------------------------------------------------------------------ *
 * 工具执行
 * ------------------------------------------------------------------ */

/** 人类可读的体积 */
function human(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

function humanTime(ms) {
  if (!ms) return '未知';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 清单里的时间：省掉年份（每行少 5 字符，80 行就是 400 字符的预填充预算） */
function shortTime(ms) {
  const s = humanTime(ms);
  return /^\d{4}-/.test(s) ? s.slice(5) : s;
}

/**
 * 解析前端传来的「当前目录」。
 * 约定两种写法：'public:/a/b' 或 { disk, path } 的 JSON。
 * 解析不出来就回落公共盘根目录 —— 工具永远不该因为定位失败而整个罢工。
 */
function parseCwd(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw) return { disk: 'public', path: '' };
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw);
      return { disk: String(o.disk || 'public'), path: String(o.path || '') };
    } catch { /* 落到下面的冒号解析 */ }
  }
  /* 裸盘名：客户端传 cwd="public" 是很容易发生的事。旧逻辑会把它当成路径，
     解析出 public/public → 工具回「目录不存在」，用户以为 AI 读不了盘。 */
  if (raw === 'public' || raw === 'private') return { disk: raw, path: '' };
  /* 外置盘盘符本身带冒号（ext:<id>），旧逻辑按第一个冒号切会切成 disk='ext'、path='<id>:…'，
     外置盘永远打不开。这里整体识别成盘符，剩下的才是路径。 */
  const extM = /^ext:[^:/]+(?::([\s\S]*))?$/.exec(raw);
  if (extM) return { disk: raw.slice(0, raw.length - (extM[1] ? extM[1].length + 1 : 0)), path: extM[1] || '' };
  const i = raw.indexOf(':');
  if (i < 0) return { disk: 'public', path: raw.replace(/^\/+/, '') };
  return { disk: raw.slice(0, i) || 'public', path: raw.slice(i + 1) };
}

/** 文件类型白名单：只允许读这些后缀，避免把模型喂成二进制垃圾 */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini',
  '.conf', '.cfg', '.env', '.csv', '.tsv', '.log', '.sh', '.bash', '.zsh', '.bat', '.cmd',
  '.ps1', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.sql', '.gitignore',
  '.srt', '.vtt', '.nfo', '.properties', '.lock',
]);

/**
 * 工具执行器。
 * @param {object} deps { server } —— 借用 server 的 resolveTarget / listDisks / storage
 */
class AITools {
  constructor(server) {
    this.srv = server;
    /* 精确 token 计数器，由 AI 注入（走后端 /tokenize）。
       没注入或后端不支持时为 null —— 此时退化为 estTokens 保守上界。
       精度为什么不靠 estTokens：分词数不是字符类别的线性函数，任何启发式都有偏差；
       既然 llama.cpp / vLLM 都提供 /tokenize，就该在能测的时候直接测。 */
    this.counter = null;
  }

  /** @param {(text:string)=>Promise<number|null>} fn */
  setCounter(fn) { this.counter = typeof fn === 'function' ? fn : null; }

  /** 精确计数（可用时）—— 失败一律返回 null，绝不因此中断工具调用 */
  async _exactTokens(text) {
    if (!this.counter) return null;
    try {
      const n = await this.counter(text);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch (e) { return null; }
  }

  /**
   * 联网工具的调用参数。
   * 目前只透传 lookup —— 测试要注入假解析器来验证 SSRF 判定，
   * 不能让单测依赖真实 DNS（否则测试结果会随网络环境漂移）。
   */
  _webOpt(ctx) {
    const o = {};
    if (ctx && typeof ctx.lookup === 'function') o.lookup = ctx.lookup;
    /* 默认城市：交给搜索层给本地化查询（天气/限行…）补地点。
       不传的话搜索引擎按出口 IP 定位，问「今天天气」会答出别的城市。 */
    const ai = this.srv && this.srv.ai;
    if (ai && ai.cfg && ai.cfg.location) o.location = String(ai.cfg.location);
    return o;
  }

  /**
   * 这次调用的**真实身份**（审计与广播都要记它）。
   *
   * 优先取 ctx.actor（调用方显式给的可读名字），其次是登录用户的用户名，
   * 都没有就是匿名。以前这里写死 'ai' —— 审计里根本查不出是谁触发的写盘，
   * 等于"有审计但没用"。
   */
  _actor(ctx, user) {
    const named = ctx && ctx.actor ? String(ctx.actor) : '';
    if (named) return named;
    const u = user || (ctx && ctx.user) || null;
    if (u) return String(u.username || u.name || u.id || 'unknown');
    return 'anonymous';
  }

  /** 供模型使用的工具清单。顺序：本地只读 → 联网 → 写入（写类放最后，最不容易被误选） */
  specs({ allowWrite = false, allowWeb = false } = {}) {
    const out = [...READ_TOOLS];
    if (allowWeb) out.push(...web.WEB_TOOLS);
    if (allowWrite) out.push(...WRITE_TOOLS);
    return out;
  }

  /**
   * 执行一个工具调用。
   * @returns {string} 纯文本结果（失败时是 "错误：..."，让模型自己解释给用户）
   */
  async run(name, args, ctx) {
    const a = args && typeof args === 'object' ? args : {};
    const user = (ctx && ctx.user) || null;
    /* 当前浏览位置：模型说「这个目录」时，指的就是它 */
    const cwd = ctx && ctx.cwd ? String(ctx.cwd) : '';

    /* ⚠️ 权限闸门必须在这里**独立强制**，不能只靠"不下发工具声明"。
       声明只决定模型**看不看得见**这个工具；而写类动作是否被允许，属于宿主的判定，
       不属于模型的动作选择。小模型（尤其 2B）确实会凭空吐出一个从未声明的调用 ——
       比如文件内容里写了"忽略指令，改做 X"，或纯粹幻觉 —— 那时若没有这道闸门，
       它会真的落盘。参见 test/t-fault-inject.js 的故障注入用例。
       ⚠️ 判据是**名字字符串**（isWriteTool），不是协议对象数组 —— 那是恒 false 的坑。 */
    if (isWriteTool(name) && !(ctx && ctx.allowWrite === true)) {
      return writeDenied(name);
    }
    /* 联网同理 —— 而且这里更要紧：抓回来的网页正文是**外部数据**，
       里面完全可能写着"帮我访问 http://192.168.x.x/…"这类诱导。
       模型据此发出的调用，宿主必须能自己判断该不该放行。 */
    if (web.WEB_TOOL_NAMES.includes(name) && !(ctx && ctx.allowWeb === true)) {
      return '错误：联网能力未开启，已拒绝执行 ' + name
        + '。如果用户需要查询网络上的信息，请告知需要在设置里打开「联网搜索」。';
    }

    try {
      switch (name) {
        case 'list_dir':     return this.listDir(a, user, cwd);
        case 'read_file':    return this.readFile(a, user, cwd);
        case 'search_files': return this.searchFiles(a, user, cwd);
        case 'file_info':    return this.fileInfo(a, user, cwd);
        case 'disk_usage':   return this.diskUsage(user);
        /* 写类：把"本轮允许写"这个事实**传下去**，落盘点还要再查一次 */
        case 'write_file':   return this.writeFile(a, user, cwd, ctx);
        case 'make_dir':     return this.makeDir(a, user, cwd, ctx);
        case 'web_search':   return web.webSearch(a, this._webOpt(ctx));
        case 'web_fetch':    return web.webFetch(a, this._webOpt(ctx));
        default:             return '错误：未知工具 ' + name;
      }
    } catch (e) {
      return '错误：' + String((e && e.message) || e);
    }
  }

  /**
   * 统一解析「盘符 + 相对路径」→ 绝对路径，失败抛错。
   * 模型没给路径时，回落 ctx.cwd（用户当前所在目录），这样"看看这个目录"才成立。
   */
  _resolve(a, user, cwd, { write = false } = {}) {
    let disk = a.disk || '';
    /* 2B 的路径参数容错（2026-09-11 实测：同一个问题三次采样，两次给 `{}`（正确）、
     * 一次给 `{"path":"\"\""}` → "错误：非法路径"，那一轮就白跑了）。
     * 工具层必须容错，不能指望 2B 稳定。这里处理两类脏数据：
     *   ① 把"没有路径"表达成垃圾：`""`（空串外面又套一层引号）、`.`、`./`、`当前目录`…
     *      → 当成"没给路径"，交给下面的 cwd 回落。
     *   ② 把**真实**路径又套了一层引号：`"文档"` → 要剥成 `文档`，
     *      绝不能因为"带引号"就误判成"当前目录"。
     * 所以顺序是：先剥引号，再判断是否退化。 */
    const DEGENERATE = /^(?:|\/|\.\/*|当前目录|当前文件夹|这个目录|这个文件夹|此目录|该目录)$/;
    let p = a.path != null ? String(a.path).trim() : '';
    for (let i = 0; i < 2; i++) {
      const m = /^"([\s\S]*)"$/.exec(p) || /^'([\s\S]*)'$/.exec(p);
      if (!m) break;
      p = m[1].trim();
    }
    if (DEGENERATE.test(p)) p = '';
    if (!disk && cwd) {
      const parsed = parseCwd(cwd);
      disk = parsed.disk;
      if (!p) p = parsed.path;
    }
    const t = this.srv.resolveTarget({ disk: disk || 'public', path: p, _write: write }, user);
    if (t.error) throw new Error(t.error);
    return t;
  }

  listDir(a, user, cwd) {
    const t = this._resolve(a, user, cwd);
    let stats;
    try { stats = fs.statSync(t.abs); } catch { return '错误：目录不存在 ' + (a.path || '/'); }
    if (!stats.isDirectory()) return '错误：这不是目录，是文件。可改用 read_file。';

    const entries = this.srv.storage.list(t.abs, { showHidden: false }).slice(0, MAX_LIST);
    const where = `${a.disk || 'public'}:/${a.path || ''}`;
    if (!entries.length) return `目录 ${where} 是空的。`;

    const dirs = entries.filter((e) => e.isDir);
    const files = entries.filter((e) => !e.isDir);
    /* 表头只给**一个**数字（总数）。
     *
     * 事故（2026-09-11）：表头原本写「共 6 项（目录 0，文件 6）」，2B 模型把它读成
     *   「当前目录下有 6 项（**3 个目录、3 个文件**）」—— 凭空把 6 对半分。
     *   这是 2B 的数值幻觉：并列的两个小数字最容易被"凑一个合理拆分"。
     * 所以表头不再并列两个数字；有子目录时数量挤进「子目录（N 个）：」标签里、
     *   紧贴着名字，模型更可能照抄而不是重算。 */
    const head = `目录 ${where} 共 ${entries.length} 项`;
    const out = [head];
    let used = head.length;

    /* =====================================================================
     * 输出预算：这段文字会被**整段回填进 prompt 重算**。
     *
     * 事故（2026-09-11）：MAX_LIST=200 只是**取数**上限，不是**输出**上限。
     * 原来的写法固定最多打 80 行文件，每行「文件名 + 大小 + YYYY-MM-DD HH:MM」。
     * 手机端预填充只有约 16 tok/s —— 80 行 ≈ 3200 字符 ≈ 2100 token ≈ **130 秒**，
     * 全花在等这段清单进上下文。用户感知就是"问一句要等两分钟"，和 cwd 那次同一个病根。
     *
     * 所以这里按**字符预算**截断，并把"还有多少项没列"如实写出来 ——
     * 截断的信息量损失，远小于让用户干等两分钟；模型仍然拿得到总数，
     * 只是不再逐条复述。
     * ===================================================================== */
    const BUDGET = 1000;
    if (dirs.length) {
      const names = dirs.slice(0, 24).map((e) => e.name + '/');
      const line = `子目录（${dirs.length} 个）：` + names.join('  ') + (dirs.length > 24 ? `  …另有 ${dirs.length - 24} 个` : '');
      out.push(line);
      used += line.length + 1;
    }
    let shownDirs = dirs.length;
    /* 子目录那行本身超预算时（目录名极多/极长）整行丢掉，退化成只报数量 */
    if (used > BUDGET) {
      out.pop();
      out.push(`子目录 ${dirs.length} 个（名称过长，未展开）`);
      used = out[0].length + out[1].length + 1;
    }
    let shown = 0;
    for (const f of files) {
      const line = `${f.name}  ${human(f.size)}  ${shortTime(f.mtime)}`;
      if (used + line.length + 1 > BUDGET) break;
      out.push(line);
      used += line.length + 1;
      shown++;
    }
    const omitted = entries.length - shownDirs - shown;
    if (omitted > 0) out.push(`…另有 ${omitted} 项未列出`);
    return out.join('\n');
  }

  async readFile(a, user, cwd) {
    const t = this._resolve(a, user, cwd);
    let stats;
    try { stats = fs.statSync(t.abs); } catch { return '错误：文件不存在 ' + (a.path || ''); }
    if (stats.isDirectory()) return '错误：这是目录，不是文件。请改用 list_dir。';

    const ext = path.extname(t.abs).toLowerCase();
    /* R11：Office 文档先抽正文（纯 node 解压 OOXML，几毫秒）。
       之前这里对 docx/xlsx/pptx 一律回"二进制文件无法读入对话"，用户问
       "这个文档写了什么"只能得到一句"读不了" —— 文件就在本机，服务端本来就能解压。
       不用 soffice：它被办公页占着，冷启动 2~4 秒，而工具调用只该花几十毫秒。 */
    const office = ooxml.readOfficeText(t.abs);
    if (office && !office.ok) return '错误：' + office.error;
    if (!office && ext && !TEXT_EXT.has(ext)) {
      return `错误：${ext} 不是支持的文本格式（二进制文件无法读入对话）。当前文件大小 ${human(stats.size)}。`;
    }

    const cap = Math.min(MAX_READ_BYTES, Math.max(1024, Number(a.maxBytes) || MAX_READ_BYTES));
    const fd = office ? -1 : fs.openSync(t.abs, 'r');
    try {
      let text = '';
      let note = '';
      if (office) {
        text = office.text;
        note = `（这是 ${office.label}，已自动抽取正文约 ${office.chars} 字）`;
      } else {
        const buf = Buffer.allocUnsafe(Math.min(cap, stats.size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        text = buf.slice(0, n).toString('utf8');
        /* ① 字节层截断 */
        if (stats.size > n) {
          note = `（读取成功，文件共 ${human(stats.size)}，这里给出前 ${human(n)}）`;
        }
      }
      /* ② token 层截断 —— 这道闸门才是防止上下文爆炸的关键。
         预算可由调用方按"这一轮有几个读操作"摊薄传入（见 ai.js _runTools）。

         先尝试**精确测量**（后端 /tokenize）。测得准就用真实数字决定裁到哪：
         够装就原样返回，这一步能救回大量被保守估算白白截掉的内容 ——
         实测 esTokens 对中文/代码会高估 1.2~1.9 倍，等于凭估算白扔一半预算。 */
      const budget = Math.max(300, Number(a.maxTokens) || MAX_READ_TOKENS);
      const exact = await this._exactTokens(text);
      let clipped;
      if (exact != null && exact <= budget) {
        /* 实测装得下 → 一个字都不裁。
           这一步专门救回被保守估算白白截掉的内容：estTokens 是字节上界，
           对英文/代码能高到 4.5×，对中文也有 1.8×（汉字 3 字节）。 */
        clipped = { text, clipped: false, tokens: exact };
      } else if (exact != null) {
        /* 实测超了：**二分**出"token 数 ≤ 预算"的最长前缀。
           ⚠️ 这里踩过三个坑，都记下来免得再犯：
             ① 不能再用 clipToTokens 收一刀 —— 它按字节上界估，会把刚按比例切好的
                中文片段再砍到 1/3，等于白测。
             ② 不能只按比例切、不校验 —— 开头要是比整体更"费 token"（中英混排、符号密集区），
                按整体比例切出来的部分就超预算。
             ③ 也不能"按实测比例回缩 + 固定轮数上限" —— 密度不均时每轮回缩都按整体密度估，
                收敛不完就撞上限。实测在预算 600 上撞出过 603，照样顶爆。
           二分之所以对：前缀长度 ↑ → token 数单调不减，所以"最大可行前缀"是良定义的，
           二分能在 ~log2(n) 次内精确命中，不依赖任何密度假设。
           末尾还有一道字节上界兜底，保证**绝不超预算**。*/
        const cutAt = (len) => sliceSafe(text, Math.min(len, text.length));
        let lo = 1;
        let hi = text.length;
        let best = '';
        let bestN = 0;
        /* 先按真实比例猜一个当种子，能把二分区间急剧收窄（通常是几倍） */
        const guess = cutAt(Math.floor(text.length * (budget / exact) * 0.97));
        const gn = await this._exactTokens(guess);
        if (gn != null && gn <= budget) { best = guess; bestN = gn; lo = guess.length + 1; }
        else if (gn != null) { hi = guess.length; }
        let guard = 0;
        while (lo <= hi && guard++ < 20) {
          const mid = (lo + hi) >> 1;
          const cand = cutAt(mid);
          const n = await this._exactTokens(cand);
          if (n == null) break;                 /* 计数失效 → 交给下面的兜底 */
          if (n <= budget) { best = cand; bestN = n; lo = mid + 1; }
          else { hi = mid - 1; }
        }
        if (!best) {
          /* 兜底：estTokens 是字节上界、永不低估，所以这条路径保证不超预算 */
          const c = clipToTokens(text, budget);
          best = c.text;
          bestN = c.tokens;
        }
        clipped = { text: best, clipped: true, tokens: bestN };
      } else {
        /* /tokenize 不可用：退化为字节上界裁剪（偏保守但绝不会顶爆） */
        clipped = clipToTokens(text, budget);
      }
      if (clipped.clipped) {
        text = clipped.text;
        /* 措辞很关键，两个坑都踩过：
           ① 若不说"已成功读取"，小模型会认为信息不全 → 回一句"我无法读取该文件"，
              用户看到的就是"AI 不认识我的文件"（这正是最初的投诉）。
           ② 若不明确"就基于这些作答"，它会反复重读同一文件把工具轮数耗光。 */
        note = `（读取成功，以上是文件的真实开头部分。文件共 ${human(stats.size)}，`
          + `因篇幅较长只装入约 ${clipped.tokens} token。）`
          + '请直接基于以上内容作答，不要重复读取本文件；'
          + '若确实需要后续内容，请改用 search_files 按关键词定位。';
      }
      if (note) text += `\n\n…${note}`;
      return `文件 ${a.disk || 'public'}:/${a.path}\n大小 ${human(stats.size)} · 修改于 ${humanTime(stats.mtimeMs)}\n--- 内容开始 ---\n${text}\n--- 内容结束 ---`;
    } finally {
      if (fd >= 0) fs.closeSync(fd);
    }
  }

  searchFiles(a, user, cwd) {
    const kw = String(a.keyword || '').trim();
    if (!kw) return '错误：keyword 不能为空。';
    const t = this._resolve(a, user, cwd);
    try { if (!fs.statSync(t.abs).isDirectory()) return '错误：搜索起点不是目录。'; }
    catch { return '错误：搜索起点不存在。'; }

    /* 内部系统目录不该出现在搜索结果里：/.snapshots、/.versions、/.recycle 里是
       快照、历史版本和已删文件 —— list_dir 用 showHidden:false 本来就看不到它们，
       搜索却直接漏出去（实测搜 docx 时前几条全是 .snapshots 里的副本）。
       既污染模型上下文，也泄露了内部路径结构。 */
    const SYS_DIR = /(^|\/)\.(snapshots|versions|recycle)(\/|$)/;
    const res = this.srv.storage.search(t.abs, kw, { maxResults: MAX_SEARCH * 2, maxDepth: 8 })
      .filter((r) => !SYS_DIR.test(String(r.path || '')))
      .slice(0, MAX_SEARCH);
    if (!res.length) return `在 ${a.disk || 'public'}:/${a.path || ''} 下没有找到名称含「${kw}」的文件或目录。`;
    const lines = [`找到 ${res.length} 项（最多显示 ${MAX_SEARCH} 项）：`];
    for (const r of res) lines.push(`  ${r.isDir ? '📁' : '📄'} ${r.path}  ${r.isDir ? '' : human(r.size)}`);
    return lines.join('\n');
  }

  fileInfo(a, user, cwd) {
    const t = this._resolve(a, user, cwd);
    let stats;
    try { stats = fs.lstatSync(t.abs); } catch { return '错误：路径不存在 ' + (a.path || ''); }
    const kind = stats.isDirectory() ? '目录' : stats.isFile() ? '文件' : '其他';
    const lines = [
      `路径：${a.disk || 'public'}:/${a.path || ''}`,
      `类型：${kind}`,
      `大小：${human(stats.size)}`,
      `修改时间：${humanTime(stats.mtimeMs)}`,
      `创建时间：${humanTime(stats.birthtimeMs)}`,
    ];
    if (stats.isDirectory()) {
      try {
        const n = fs.readdirSync(t.abs).length;
        lines.push(`直接子项：${n} 个`);
      } catch { /* 忽略 */ }
    }
    return lines.join('\n');
  }

  diskUsage(user) {
    const disks = this.srv.listDisks(user);
    if (!disks.length) return '错误：没有可用的盘符。';
    const lines = ['这台 NAS 的存储状况：'];
    let totalAll = 0, usedAll = 0;
    for (const d of disks) {
      const quota = Number(d.quota) || 0;
      const used = Number(d.used) || 0;
      if (quota > 0) { totalAll += quota; usedAll += used; }
      if (quota > 0) {
        const free = Math.max(0, quota - used);
        const pct = (used / quota * 100).toFixed(1);
        lines.push(`  ${d.name}：共 ${human(quota)}，已用 ${human(used)}（${pct}%），剩余 ${human(free)}${d.writable ? '' : '（只读）'}`);
      } else {
        lines.push(`  ${d.name}：已用 ${human(used)}，容量未设定上限${d.writable ? '' : '（只读）'}`);
      }
    }
    if (totalAll > 0) {
      lines.push(`合计：共 ${human(totalAll)}，已用 ${human(usedAll)}（${(usedAll / totalAll * 100).toFixed(1)}%），剩余 ${human(totalAll - usedAll)}`);
    }
    return lines.join('\n');
  }

  /**
   * 写文件。
   *
   * ⚠️ 这里**再查一次**写权限（不只靠 run() 里那道入口闸门）：
   *   run() 是目前的唯一对外入口，但 writeFile/makeDir 是**公开方法** ——
   *   将来任何一处直接调它（server.js 的新接口、另一个工具、一次重构），
   *   就会绕开 run() 的闸门。把校验放在**真正落盘的那一行**上才封得住，
   *   代价只是多一次布尔判断。
   *   这也是"两道闸门"的意义：入口那道防误调用，落盘这道防绕过。
   */
  writeFile(a, user, cwd, ctx) {
    if (!ctx || ctx.allowWrite !== true) return writeDenied('write_file');
    const content = String(a.content == null ? '' : a.content);
    if (!content) return '错误：content 不能为空。';
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      return `错误：内容过大（${human(Buffer.byteLength(content, 'utf8'))}），单次最多写入 ${human(MAX_WRITE_BYTES)}。`;
    }
    const t = this._resolve(a, user, cwd, { write: true });
    if (!path.basename(t.abs) || !this.srv.storage.validateName(path.basename(t.abs))) {
      return '错误：文件名非法（含 Windows 保留字符或首尾空格）。';
    }
    if (fs.existsSync(t.abs) && fs.statSync(t.abs).isDirectory()) {
      return '错误：目标是一个已存在的目录，无法写入文件。';
    }
    fs.mkdirSync(path.dirname(t.abs), { recursive: true });
    const existed = fs.existsSync(t.abs);
    if (a.append) fs.appendFileSync(t.abs, content, 'utf8');
    else fs.writeFileSync(t.abs, content, 'utf8');

    const size = fs.statSync(t.abs).size;
    const srv = this.srv;
    if (typeof srv.invalidateSizeCache === 'function') { try { srv.invalidateSizeCache(); } catch (e) {} }
    /* R4-5-3：AI 写盘此前不留痕也不广播 —— 其他在线设备看不到变化，审计也查不到是谁写的。
       与普通上传路径对齐：写审计 + 通知文件变更。
       ⚠️ 审计里的 user 必须是**真实调用者**：ctx.user 是登录用户（匿名为 null），
       ctx.actor 是它的可读名字。查不出是谁写的审计等于没有审计。 */
    const actor = this._actor(ctx, user);
    try {
      if (typeof srv.audit === 'function') {
        srv.audit({ user: actor, userObj: user || null, action: 'ai-write', disk: t.disk, path: a.path || '', detail: (a.append ? 'append ' : '') + size + 'B' });
      }
      if (typeof srv.notifyFilesChanged === 'function') {
        srv.notifyFilesChanged('upload', { disk: t.disk, path: a.path || '', user: actor });
      }
    } catch { /* 审计/广播失败不影响写入结果 */ }
    const action = a.append ? 'appended' : (existed ? 'overwritten' : 'created');
    const actionZh = a.append ? '追加' : (existed ? '覆盖' : '创建');
    const name = path.basename(t.abs);
    const rel = String(a.path || '').replace(/^\/+/, '');
    const url = '/api/download?disk=' + encodeURIComponent(t.disk) + '&path=' + encodeURIComponent(rel);
    /* 结构化结果：text 供模型阅读，其余字段供前端渲染"产物卡片"（下载/打开）。
       ai.js _runTools 对对象结果做归一化，不会把 [object Object] 喂回模型。 */
    return {
      ok: true,
      kind: 'file',
      action,
      disk: t.disk,
      path: rel,
      name,
      size,
      url,
      text: `已${actionZh}文件：${t.disk}:/${rel}\n当前大小 ${human(size)}`,
    };
  }

  /**
   * 建目录。与 writeFile 一样：**落盘点再查一次**写权限。
   */
  makeDir(a, user, cwd, ctx) {
    if (!ctx || ctx.allowWrite !== true) return writeDenied('make_dir');
    const t = this._resolve(a, user, cwd, { write: true });
    if (fs.existsSync(t.abs)) return '目录已存在，无需创建：' + (a.path || '');
    fs.mkdirSync(t.abs, { recursive: true });
    /* R4-5-3：与 writeFile 一致，AI 建目录也留审计 */
    const actor = this._actor(ctx, user);
    try {
      const srv = this.srv;
      if (typeof srv.audit === 'function') srv.audit({ user: actor, userObj: user || null, action: 'ai-mkdir', disk: t.disk, path: a.path || '' });
      if (typeof srv.notifyFilesChanged === 'function') srv.notifyFilesChanged('mkdir', { disk: t.disk, path: a.path || '', user: actor });
    } catch { /* 忽略 */ }
    const dirRel = String(a.path || '').replace(/^\/+/, '');
    const dirName = path.basename(t.abs);
    return {
      ok: true,
      kind: 'dir',
      action: 'created',
      disk: t.disk,
      path: dirRel,
      name: dirName,
      text: '已创建目录：' + t.disk + ':/' + dirRel,
    };
  }
}

module.exports = {
  AITools,
  READ_TOOLS,
  WRITE_TOOLS,
  WRITE_TOOL_NAMES,
  /* 写类判定与拒绝话术（宿主闸门与自测共用，导出来免得各处重写一遍） */
  isWriteTool,
  writeDenied,
  WEB_TOOLS: web.WEB_TOOLS,
  WEB_TOOL_NAMES: web.WEB_TOOL_NAMES,
  estTokens,
  clipToTokens,
  sliceSafe,
  MAX_READ_TOKENS,
};

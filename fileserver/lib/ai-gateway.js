'use strict';

/**
 * R15 P0：AI 统一网关（ai-gateway.js）
 * =====================================================================
 * 为什么需要这个文件（而不是改 lib/ai.js）：
 *   lib/ai.js 是 137KB 的单文件助手内核，里面混着「工具循环 / 网页搜索 /
 *   计划模式 / 历史压缩 / 上下文自校准」等重逻辑。任何一处改动都可能影响
 *   整站已有对话；而且它的系统提示 + 工具声明 ~1400 token，本机 CPU 预填充
 *   只有约 10–18 tok/s —— 实测旧 POST /api/ai/chat 非流式首包要 **95 秒**。
 *
 *   本网关是**独立的、可插拔的**轻量通道：只做「OpenAI 兼容上游 + 每用户
 *   参数/提示词 + 流式 + 超时取消重试 + 会话历史」。系统提示默认只有一行
 *   （约 20 token），前缀稳定可命中 llama.cpp 的 prompt cache，实测首 token
 *   1.4–2.0s。老接口原样保留，前端可灰度切换、也可并排对比（验收要用）。
 *
 * 设计要点（每条都是踩过的坑，别删）：
 *   ① 每用户数据按 user.id 隔离落盘：data/ai-gw/users/<id>/{params,prompts,sessions}.json
 *      —— 不用全局 ai.json，避免 A 改参数影响 B（旧 /api/ai/params 就是全局的）。
 *   ② 上游 payload 必须可审计：每次请求把**实际发出去的 body**（API key 永不入日志、
 *      消息内容只留前 120 字）记进 diag，验收靠它证明「参数真的进了 llama.cpp」。
 *   ③ 取消必须真的掐断上游：AbortController.abort() 会关闭到 llama-server 的
 *      socket，llama.cpp 检测到客户端断开就释放 slot 停止解码；只在前端停画
 *      等于 CPU 继续烧（本机 2 核，必须省）。
 *   ④ 超时分两层：timeout_ms（等首 token，默认 30s）+ total_timeout_ms（全程硬
 *      上限，默认 120s）+ idle_timeout_ms（流中停滞，默认 15s）。只有首 token
 *      阶段失败才重试 —— 已经吐出文字再重试会在前端造成重复内容。
 *   ⑤ 前缀要稳定：系统提示里**不放时间戳/随机数**，否则 llama.cpp 的 prompt
 *      cache 每次全部作废（旧代码注释里实测过 2s → 112s 的教训）。
 *   ⑥ API key 用 AES-256-GCM 加密存盘（密钥 data/ai-gw/secret.key，0600），
 *      接口只回掩码，明文永不出现在响应/日志/diag 里。
 *   ⑦ 终止优先级（对外契约）：**谁先触发谁定 phase**。total 定时器/取消/断开
 *      一旦 abort，就锁存 controller.signal.reason（带 phase）；返回途中即使上游
 *      同时抛错，终止帧仍按锁存的原因输出（timeout→phase=total 等），见 _run 的
 *      catch 注释。上游先自然结束时是 done，不会回填 timeout。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
/* P2 RAG：知识库引擎（ai-rag.js 零第三方依赖，见该文件头部说明） */
const { getRAG, RAG_DEFAULTS } = require('./ai-rag');
/* 第 6 轮：每用户 AI 记忆（注入 system prompt） */
const { getMemory } = require('./ai-memory');

const GW_VERSION = 1;
const MAX_SESSIONS = 100;
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_MESSAGE_CHARS = 20000;
const MAX_PROMPT_CHARS = 8000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_STOP_SEQ = 4;
const DIAG_KEEP = 200;
const DIAG_FILE_MAX = 2 * 1024 * 1024;
/* 第 5 轮：槽位看门狗。
   total_timeout_ms 到点已经会 abort；看门狗只在"abort 后仍不结束/没走统一出口"时兜底，
   阈值 = total_timeout_ms + 10s（要求），硬回收再等 2s。正常请求永远不会触发。
   两个 env 只给单测把时间压缩到秒级用（生产不设置，走默认 10s/2s）。 */
const WATCHDOG_GRACE_MS = Math.max(100, Number(process.env.AI_GW_WATCHDOG_GRACE_MS) || 10000);
const WATCHDOG_HARD_GRACE_MS = Math.max(50, Number(process.env.AI_GW_WATCHDOG_HARD_GRACE_MS) || 2000);

/* ------------------------------------------------------------------ *
 * 参数规范：默认值 / 范围。前端契约与归一逻辑都以此为准。
 * ------------------------------------------------------------------ */
const PARAM_DEFAULTS = Object.freeze({
  temperature: 0.7,        // 0–2
  top_p: 0.9,              // 0.01–1
  max_tokens: 192,         // 16–2048（本机 CPU ~4 tok/s，默认给「能感知到结束」的长度）
  context_tokens: 8192,    // 512–16384，用于历史裁剪（上游 llama-server 的 -c 是固定 32768）
  repeat_penalty: 1.05,    // 0.5–2，llama.cpp 专有字段
  timeout_ms: 30000,       // 等首 token 的超时（含排队+预填充）
  total_timeout_ms: 120000,// 单请求全程硬上限（含生成）
  idle_timeout_ms: 30000,  // 流中无新 token 的停滞超时（共享 CPU 上别的模块压测时会长停，别设太紧）
  retries: 2,              // 失败重试次数（0–5，指数退避，仅在未出首 token 时）
  fast_mode: true,         // 真：历史只带最近 8 条 + 强制 prompt cache（本机 CPU 提速）
  stop: [],                // 停止串（最多 4 条，每条 ≤64 字）
  model_id: '',            // 用户选定模型；空 = 用管理员默认
  system_prompt_id: 'general',
  early_stop_chars: 0,     // >0 时：文本达到该长度且落在句末标点上就提前收尾（0=关）
});

const PARAM_LIMITS = Object.freeze({
  temperature: [0, 2],
  top_p: [0.01, 1],
  max_tokens: [16, 2048],
  context_tokens: [512, 16384],
  repeat_penalty: [0.5, 2],
  timeout_ms: [1000, 180000],
  total_timeout_ms: [5000, 600000],
  idle_timeout_ms: [3000, 120000],
  retries: [0, 5],
  early_stop_chars: [0, 2000],
});

const BUILTIN_PROMPTS = Object.freeze([
  {
    id: 'general', name: '通用（默认）', scenario: 'general', builtin: true,
    /* ⚠️ 默认提示词刻意压到 15 字：本机 prompt 吞吐只有 ~10 tok/s，
       每多 10 token 冷启动就多等约 1 秒。需要更详细的风格请切 writing/code/qa。 */
    content: '你是深空助手，用中文简洁回答。',
  },
  {
    id: 'writing', name: '写作', scenario: 'writing', builtin: true,
    content: '你是深空工作站的中文写作助手。直接输出成稿，不要解释写作思路，不要复述用户的要求。',
  },
  {
    id: 'code', name: '代码', scenario: 'code', builtin: true,
    content: '你是深空工作站的编程助手。先给出可运行的代码（用 ``` 标注语言），再用两三句话说明关键点。',
  },
  {
    id: 'qa', name: '知识问答', scenario: 'qa', builtin: true,
    content: '你是深空工作站的知识问答助手。先给结论，再给必要依据；不确定就直说不知道，不要编造。',
  },
]);

const SCENARIOS = ['general', 'writing', 'code', 'qa'];

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 网关自己的错误类型：code / phase / retryable / status 都显式带出去 */
function gwError(code, message, extra) {
  const e = new Error(message || code);
  e.gw = true;
  e.code = code;
  Object.assign(e, extra || {});
  return e;
}

function clampNumber(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

/** 估算 token 数：中文按 1 字≈1 token，英文按 4 字≈1 token（保守上估） */
function estTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

function nowISO() {
  return new Date().toISOString();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || gwError('CANCELED', '已取消'));
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason || gwError('CANCELED', '已取消'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, mode: mode || 0o700 });
  try { fs.chmodSync(dir, mode || 0o700); } catch { /* 非关键 */ }
}

/** 原子写 JSON（0600）：先写临时文件再 rename，避免半截文件把配置读崩 */
function writeJsonAtomic(file, obj, mode) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const body = JSON.stringify(obj, null, 2);
  fs.writeFileSync(tmp, body, { mode: mode || 0o600 });
  try { fs.chmodSync(tmp, mode || 0o600); } catch { /* 非关键 */ }
  fs.renameSync(tmp, file);
}

/** 读 JSON；解析失败把坏文件改名留证再返回兜底值，绝不让一次坏写把模块打死 */
function readJsonSafe(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch { /* 非关键 */ }
    console.warn('[ai-gw] 配置损坏，已隔离：' + file + ' (' + (e && e.message) + ')');
    return fallback;
  }
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '***';
  return k.slice(0, 3) + '***' + k.slice(-4);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 每模型并发闸门：本机 llama-server 以 -np 1 运行，第二个请求会在上游排队。
 * 与其让用户盯着没反应的页面，不如网关自己排队并把 queued 事件/位次推给前端。
 */
class Gate {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.queue = [];
  }

  get position() {
    return this.queue.length;
  }

  acquire(signal, onQueued) {
    if (signal && signal.aborted) return Promise.reject(signal.reason || gwError('CANCELED', '已取消'));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this._releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal.reason || gwError('CANCELED', '已取消'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      waiter.cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
      this.queue.push(waiter);
      if (onQueued) onQueued(this.queue.length);
    });
  }

  _releaser() {
    /* 幂等释放：同一个 releaser 无论被调用几次（正常出口/finally/看门狗）都只生效一次。
       P0 复盘：槽位泄漏的根因就是某些出口没走到这里；现在由 _run 的统一出口保证必调。 */
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      this.active--;
      const next = this.queue.shift();
      if (next) {
        if (next.cleanup) next.cleanup();
        this.active++;
        next.resolve(this._releaser());
      }
      return true;
    };
  }

  /** diag 用：当前闸门占用快照 */
  snapshot() {
    return { limit: this.limit, active: this.active, queued: this.queue.length };
  }
}

/* ------------------------------------------------------------------ *
 * 网关主体
 * ------------------------------------------------------------------ */
class AIGateway {
  constructor(opts) {
    const o = opts || {};
    this.dataDir = o.dataDir || path.join(__dirname, '..', 'data', 'ai-gw');
    this.legacyAiJson = o.legacyAiJson || path.join(this.dataDir, '..', 'ai.json');
    this.auditFn = typeof o.audit === 'function' ? o.audit : null;

    this.models = null;      // { version, defaultId, models: [] }
    this.settings = null;    // { version, allowUserModelSelect, defaults: {...} }
    this.secret = null;
    this.gates = new Map();
    this.active = new Map(); // requestId -> { userId, controller, phase, startedAt, text }
    this.recent = [];        // diag 环形缓冲（内存），同时追加 data/ai-gw/diag.jsonl
    this.recentLoaded = false;
    this._init();
  }

  /* ---------------- 初始化 / 密钥 ---------------- */

  _init() {
    ensureDir(this.dataDir, 0o700);
    ensureDir(path.join(this.dataDir, 'users'), 0o700);
    this.secret = this._loadSecret();
    this._loadModels();
    this._loadSettings();
  }

  _loadSecret() {
    const f = path.join(this.dataDir, 'secret.key');
    try {
      const b = fs.readFileSync(f);
      if (b.length >= 32) return b.subarray(0, 32);
    } catch { /* 首次运行：生成 */ }
    const k = crypto.randomBytes(32);
    fs.writeFileSync(f, k, { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch { /* 非关键 */ }
    return k;
  }

  _encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.secret, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return 'enc:v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
  }

  _decrypt(enc) {
    const s = String(enc || '');
    if (!s.startsWith('enc:v1:')) return '';
    const parts = s.split(':');
    if (parts.length !== 5) return '';
    try {
      const iv = Buffer.from(parts[2], 'base64');
      const tag = Buffer.from(parts[3], 'base64');
      const ct = Buffer.from(parts[4], 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', this.secret, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch (e) {
      console.warn('[ai-gw] API key 解密失败（密钥被换过？）：' + (e && e.message));
      return '';
    }
  }

  _loadModels() {
    const f = path.join(this.dataDir, 'models.json');
    const loaded = readJsonSafe(f, null);
    if (loaded && Array.isArray(loaded.models)) {
      this.models = loaded;
      return;
    }
    /* 首次运行：从旧 data/ai.json 的后端表播种，保证「装好即能用」。
       旧配置只读不写 —— 不改别人的 ai.json。 */
    const legacy = readJsonSafe(this.legacyAiJson, {}) || {};
    const seeded = [];
    for (const b of Array.isArray(legacy.backends) ? legacy.backends : []) {
      if (!b || !b.url) continue;
      const id = slug(b.id || b.name) || 'm-' + seeded.length;
      seeded.push({
        id,
        name: String(b.name || id),
        kind: 'local',
        baseUrl: String(b.url).replace(/\/+$/, ''),
        model: String(b.model || ''),
        apiKeyEnc: '',
        enabled: true,
        allowUserSelect: true,
        maxConcurrent: 1,
        extraBody: { cache_prompt: true, chat_template_kwargs: { enable_thinking: false } },
        notes: String(b.note || ''),
        createdAt: nowISO(),
        updatedAt: nowISO(),
        lastProbe: null,
      });
      if (b.id === legacy.activeId || b.active === true) this._seedDefaultId = id;
    }
    if (!seeded.length) {
      /* 连旧配置都没有：按本机 llama.cpp 的实测端口补一条，别让模块空转 */
      seeded.push({
        id: 'server-local', name: '服务器本机 llama.cpp', kind: 'local',
        baseUrl: 'http://127.0.0.1:8080', model: 'MiniCPM5-2B',
        apiKeyEnc: '', enabled: true, allowUserSelect: true, maxConcurrent: 1,
        extraBody: { cache_prompt: true, chat_template_kwargs: { enable_thinking: false } },
        notes: '本机 CPU 推理', createdAt: nowISO(), updatedAt: nowISO(), lastProbe: null,
      });
    }
    this.models = {
      version: GW_VERSION,
      defaultId: this._seedDefaultId || (seeded[0] && seeded[0].id) || '',
      models: seeded,
    };
    delete this._seedDefaultId;
    writeJsonAtomic(f, this.models);
  }

  _loadSettings() {
    const f = path.join(this.dataDir, 'settings.json');
    const loaded = readJsonSafe(f, null);
    if (loaded && loaded.defaults) {
      /* 老 settings.json 没有 RAG 字段：合并默认值（不覆盖已有值），保证升级后可用 */
      let changed = false;
      for (const k of Object.keys(RAG_DEFAULTS)) {
        if (loaded[k] == null) { loaded[k] = RAG_DEFAULTS[k]; changed = true; }
      }
      this.settings = loaded;
      if (changed) writeJsonAtomic(f, this.settings);
      return;
    }
    this.settings = {
      version: GW_VERSION,
      allowUserModelSelect: true,
      defaults: Object.assign({}, PARAM_DEFAULTS),
      ...Object.assign({}, RAG_DEFAULTS),
      updatedAt: nowISO(),
    };
    writeJsonAtomic(f, this.settings);
  }

  _saveModels() { writeJsonAtomic(path.join(this.dataDir, 'models.json'), this.models); }
  _saveSettings() { writeJsonAtomic(path.join(this.dataDir, 'settings.json'), this.settings); }

  /* ---------------- 用户目录 / 按用户隔离 ---------------- */

  _userDir(user) {
    const id = String((user && user.id) || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id) throw gwError('NO_USER', '缺少用户身份', { status: 401 });
    const dir = path.join(this.dataDir, 'users', id);
    ensureDir(dir, 0o700);
    return dir;
  }

  _userFile(user, name) {
    return path.join(this._userDir(user), name);
  }

  /* ---------------- 模型注册表 ---------------- */

  _adminModels() {
    return this.models.models;
  }

  findModel(id) {
    return this._adminModels().find((m) => m.id === String(id || '')) || null;
  }

  _modelOut(m, opts) {
    const o = opts || {};
    const isDefault = this.models.defaultId === m.id;
    return {
      id: m.id,
      name: m.name,
      kind: m.kind,
      baseUrl: o.admin ? m.baseUrl : this._publicBase(m.baseUrl),
      model: m.model,
      enabled: m.enabled !== false,
      allowUserSelect: m.allowUserSelect !== false,
      isDefault,
      maxConcurrent: Number(m.maxConcurrent) || 1,
      hasApiKey: !!m.apiKeyEnc,
      apiKeyMask: m.apiKeyEnc ? maskKey(this._decrypt(m.apiKeyEnc)) : '',
      notes: m.notes || '',
      createdAt: m.createdAt || '',
      updatedAt: m.updatedAt || '',
      lastProbe: m.lastProbe || null,
    };
  }

  /** 非管理员视图：内网地址脱敏（与旧 /api/ai/config 的游客口径一致） */
  _publicBase(url) {
    try {
      const u = new URL(url);
      return u.protocol + '//' + u.hostname + (u.port ? ':' + u.port : '');
    } catch {
      return '';
    }
  }

  listModels(user, opts) {
    const isAdmin = !!(user && user.role === 'admin');
    const admin = isAdmin || !!(opts && opts.admin);
    const items = this._adminModels()
      .filter((m) => admin || m.enabled !== false)
      .map((m) => this._modelOut(m, { admin }));
    return {
      ok: true,
      allowUserModelSelect: this.settings.allowUserModelSelect !== false,
      defaultId: this.models.defaultId,
      selectedId: this._selectedModelId(user) || this.models.defaultId,
      isAdmin,
      models: items,
    };
  }

  _selectedModelId(user) {
    if (!user) return '';
    const p = readJsonSafe(this._userFile(user, 'params.json'), {}) || {};
    return String(p.model_id || '');
  }

  _normalizeModelInput(o, existing) {
    const src = o || {};
    const name = String(src.name || (existing && existing.name) || '').trim();
    if (name.length < 1 || name.length > 60) throw gwError('BAD_MODEL', '模型名称长度需为 1–60', { status: 400 });
    let baseUrl = String(src.baseUrl != null ? src.baseUrl : (existing && existing.baseUrl) || '').trim();
    baseUrl = baseUrl.replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw gwError('BAD_MODEL', 'baseUrl 必须是 http(s) 地址', { status: 400 });
    if (baseUrl.length > 300) throw gwError('BAD_MODEL', 'baseUrl 过长', { status: 400 });
    const kind = String(src.kind || (existing && existing.kind) || 'local');
    if (kind !== 'local' && kind !== 'api') throw gwError('BAD_MODEL', 'kind 只能是 local / api', { status: 400 });
    const model = String(src.model != null ? src.model : (existing && existing.model) || '').slice(0, 300);
    const extraBody = (src.extraBody !== undefined ? src.extraBody : (existing && existing.extraBody)) || {};
    if (typeof extraBody !== 'object' || Array.isArray(extraBody)) throw gwError('BAD_MODEL', 'extraBody 必须是对象', { status: 400 });
    const rec = {
      id: (existing && existing.id) || slug(src.id || name) || 'm-' + crypto.randomBytes(3).toString('hex'),
      name,
      kind,
      baseUrl,
      model,
      enabled: src.enabled === undefined ? (existing ? existing.enabled !== false : true) : src.enabled === true,
      allowUserSelect: src.allowUserSelect === undefined
        ? (existing ? existing.allowUserSelect !== false : true)
        : src.allowUserSelect === true,
      maxConcurrent: Math.max(1, Math.min(4, Math.floor(Number(src.maxConcurrent !== undefined ? src.maxConcurrent : (existing && existing.maxConcurrent)) || 1))),
      extraBody,
      notes: String(src.notes !== undefined ? src.notes : (existing && existing.notes) || '').slice(0, 300),
      createdAt: (existing && existing.createdAt) || nowISO(),
      updatedAt: nowISO(),
      lastProbe: (existing && existing.lastProbe) || null,
      apiKeyEnc: (existing && existing.apiKeyEnc) || '',
    };
    /* apiKey 语义：undefined=保留原值；''=清除；其它=加密保存（明文绝不落盘） */
    if (src.apiKey !== undefined) {
      const k = String(src.apiKey || '').trim();
      rec.apiKeyEnc = k ? this._encrypt(k) : '';
    }
    if (!rec.id || !/^[a-z0-9_-]{1,40}$/.test(rec.id)) throw gwError('BAD_MODEL', 'id 只能是小写字母/数字/-/_', { status: 400 });
    return rec;
  }

  upsertModel(input) {
    const src = input || {};
    const byId = src.id ? this.findModel(src.id) : null;
    const byName = !byId && src.name ? this._adminModels().find((m) => m.name === String(src.name)) : null;
    const existing = byId || byName || null;
    const rec = this._normalizeModelInput(src, existing);
    if (existing) {
      const i = this._adminModels().indexOf(existing);
      this._adminModels()[i] = rec;
    } else {
      if (this._adminModels().length >= 20) throw gwError('BAD_MODEL', '模型数量上限 20', { status: 400 });
      if (!rec.id || this.findModel(rec.id)) rec.id = 'm-' + crypto.randomBytes(3).toString('hex');
      this._adminModels().push(rec);
    }
    if (!this.models.defaultId || !this.findModel(this.models.defaultId)) this.models.defaultId = rec.id;
    this._saveModels();
    return rec;
  }

  removeModel(id) {
    const i = this._adminModels().findIndex((m) => m.id === String(id || ''));
    if (i < 0) throw gwError('NO_MODEL', '模型不存在', { status: 404 });
    const [rec] = this._adminModels().splice(i, 1);
    if (this.models.defaultId === rec.id) {
      const next = this._adminModels().find((m) => m.enabled !== false);
      this.models.defaultId = next ? next.id : '';
    }
    this.gates.delete(rec.id);
    this._saveModels();
    return { ok: true, removed: rec.id, defaultId: this.models.defaultId };
  }

  setDefaultModel(id) {
    const m = this.findModel(id);
    if (!m) throw gwError('NO_MODEL', '模型不存在', { status: 404 });
    if (m.enabled === false) throw gwError('MODEL_DISABLED', '模型已禁用，不能设为默认', { status: 400 });
    this.models.defaultId = m.id;
    this._saveModels();
    return { ok: true, defaultId: m.id };
  }

  setModelPolicy(patch) {
    if (patch && typeof patch.allowUserModelSelect === 'boolean') {
      this.settings.allowUserModelSelect = patch.allowUserModelSelect;
    }
    if (patch && patch.defaults && typeof patch.defaults === 'object') {
      this.settings.defaults = this._normalizeParams(patch.defaults, this.settings.defaults, { partial: true });
    }
    /* P2 RAG 全局参数（管理员）：embedding 地址/模型、分块、top-k、阈值。
       embedUrl 只允许 http(s)，避免把服务端变成任意地址探测器之外的用途。 */
    const RAG_NUM = { chunkChars: [100, 480], overlapChars: [0, 400], batchSize: [1, 8], topK: [1, 10], minScore: [0, 1], relScore: [0, 1] };
    if (patch && typeof patch.embedUrl === 'string') {
      const u = patch.embedUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s]+$/i.test(u)) throw gwError('BAD_EMBED_URL', 'embedUrl 必须是 http(s) 地址', { status: 400 });
      this.settings.embedUrl = u.slice(0, 300);
    }
    if (patch && typeof patch.embedModel === 'string') this.settings.embedModel = patch.embedModel.trim().slice(0, 120) || RAG_DEFAULTS.embedModel;
    for (const k of Object.keys(RAG_NUM)) {
      if (patch && patch[k] !== undefined && patch[k] !== null) {
        const n = clampNumber(patch[k], RAG_NUM[k][0], RAG_NUM[k][1]);
        if (n !== null) this.settings[k] = k === 'batchSize' || k === 'topK' || k === 'chunkChars' || k === 'overlapChars' ? Math.floor(n) : Math.round(n * 100) / 100;
      }
    }
    this.settings.updatedAt = nowISO();
    this._saveSettings();
    return {
      ok: true,
      allowUserModelSelect: this.settings.allowUserModelSelect !== false,
      defaults: this.settings.defaults,
      rag: this.ragSettings(),
    };
  }

  /** 给上层/RAG 引擎用的 embedding 相关配置（快照） */
  ragSettings() {
    const out = {};
    for (const k of Object.keys(RAG_DEFAULTS)) out[k] = this.settings[k] != null ? this.settings[k] : RAG_DEFAULTS[k];
    return out;
  }

  /** 取知识库引擎实例并同步配置（单例按 dataDir 缓存） */
  kb(user) {
    const rag = getRAG(this.dataDir);
    rag.configure(this.ragSettings());
    return rag;
  }

  /** 第 6 轮：每用户 AI 记忆库（data/ai-gw/memory/<user.id>.json） */
  memory() {
    return getMemory(this.dataDir);
  }

  async probeModel(id) {
    const m = this.findModel(id);
    if (!m) throw gwError('NO_MODEL', '模型不存在', { status: 404 });
    const url = this._endpoint(m, 'models');
    const headers = this._upstreamHeaders(m, false);
    const t0 = Date.now();
    let out;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(gwError('TIMEOUT', '探活超时')), 5000);
      let r;
      try {
        r = await fetch(url, { headers, signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
      const ms = Date.now() - t0;
      const txt = await r.text().catch(() => '');
      if (!r.ok) {
        out = { ok: false, ms, status: r.status, error: 'HTTP ' + r.status + ' ' + truncate(txt, 160) };
      } else {
        let models = [];
        try {
          const j = JSON.parse(txt);
          models = (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [])
            .map((x) => (x && (x.id || x.name || x.model)) || '').filter(Boolean).slice(0, 20);
        } catch { /* 有些后端 /v1/models 返回非 JSON，只要能 200 就算活 */ }
        let contextTokens = null;
        if (m.kind === 'local') {
          try {
            const ac2 = new AbortController();
            const t2 = setTimeout(() => ac2.abort(), 4000);
            const pr = await fetch(this._endpoint(m, 'props'), { signal: ac2.signal, headers });
            clearTimeout(t2);
            if (pr.ok) {
              const pj = await pr.json().catch(() => null);
              const n = pj && (pj.n_ctx || (pj.default_generation_settings && pj.default_generation_settings.n_ctx));
              if (Number(n) > 0) contextTokens = Number(n);
            }
          } catch { /* 探活失败不影响主判定 */ }
        }
        out = { ok: true, ms, models, contextTokens };
      }
    } catch (e) {
      out = { ok: false, ms: Date.now() - t0, error: String((e && e.name) === 'AbortError' ? '探活超时' : (e && e.message) || e) };
    }
    out.at = nowISO();
    m.lastProbe = out;
    m.updatedAt = nowISO();
    this._saveModels();
    this._diagAppend({
      type: 'probe', at: out.at, modelId: m.id, ok: out.ok, ms: out.ms,
      models: out.models || [], error: out.error || '', contextTokens: out.contextTokens || null,
    });
    return out;
  }

  /* ---------------- 参数（每用户隔离） ---------------- */

  getSettings() {
    return {
      ok: true,
      allowUserModelSelect: this.settings.allowUserModelSelect !== false,
      defaults: Object.assign({}, PARAM_DEFAULTS, this.settings.defaults || {}),
      rag: this.ragSettings(),
      updatedAt: this.settings.updatedAt || '',
    };
  }

  _normalizeParams(input, base, opts) {
    const o = opts || {};
    const out = Object.assign({}, base || {});
    const src = input || {};
    for (const k of Object.keys(PARAM_LIMITS)) {
      if (src[k] === undefined || src[k] === null) continue;
      const [lo, hi] = PARAM_LIMITS[k];
      const n = clampNumber(src[k], lo, hi);
      if (n === null) continue; // 非法值直接丢弃，不报错也不半生效
      out[k] = (k === 'temperature' || k === 'top_p' || k === 'repeat_penalty')
        ? Math.round(n * 100) / 100
        : Math.floor(n);
    }
    if (src.fast_mode !== undefined) out.fast_mode = src.fast_mode === true;
    if (src.stop !== undefined) {
      const arr = Array.isArray(src.stop) ? src.stop : [];
      out.stop = arr.map((s) => String(s)).filter((s) => s.length > 0).slice(0, MAX_STOP_SEQ).map((s) => s.slice(0, 64));
    }
    if (src.model_id !== undefined) out.model_id = String(src.model_id || '').slice(0, 40);
    if (src.system_prompt_id !== undefined) out.system_prompt_id = String(src.system_prompt_id || 'general').slice(0, 40);
    if (!o.partial || src.early_stop !== undefined) {
      if (src.early_stop && typeof src.early_stop === 'object') {
        out.early_stop_chars = Math.floor(clampNumber(src.early_stop.chars, 0, 2000) || 0);
        out.early_stop_punct_only = src.early_stop.punct_only !== false;
      }
    }
    return out;
  }

  /** 每用户参数文件（不存在就按默认建，互不影响） */
  getUserParams(user) {
    const f = this._userFile(user, 'params.json');
    const cur = readJsonSafe(f, null);
    if (cur && typeof cur === 'object') {
      return this._normalizeParams(cur, Object.assign({}, PARAM_DEFAULTS, this.settings.defaults || {}), { partial: true });
    }
    const init = this._normalizeParams({}, Object.assign({}, PARAM_DEFAULTS, this.settings.defaults || {}), { partial: true });
    writeJsonAtomic(f, Object.assign({}, init, { updatedAt: nowISO() }));
    return init;
  }

  setUserParams(user, patch) {
    const base = this.getUserParams(user);
    const next = this._normalizeParams(patch, base, { partial: true });
    next.updatedAt = nowISO();
    writeJsonAtomic(this._userFile(user, 'params.json'), next);
    return next;
  }

  resetUserParams(user) {
    const f = this._userFile(user, 'params.json');
    try { fs.unlinkSync(f); } catch { /* 本来就没有 */ }
    return this.getUserParams(user);
  }

  /** 生效参数 = 默认值 ← 全局设置 ← 用户存档 ← 本次请求覆盖 */
  effectiveParams(user, override) {
    const merged = Object.assign({}, PARAM_DEFAULTS, this.settings.defaults || {}, this.getUserParams(user));
    return this._normalizeParams(override, merged, { partial: true });
  }

  /* ---------------- 系统提示词（每用户多套 + 场景） ---------------- */

  _promptFile(user) { return this._userFile(user, 'prompts.json'); }

  getUserPrompts(user) {
    const f = this._promptFile(user);
    let doc = readJsonSafe(f, null);
    if (!doc || !Array.isArray(doc.items)) {
      doc = {
        version: GW_VERSION,
        activeId: 'general',
        items: BUILTIN_PROMPTS.map((p) => Object.assign({}, p, { updatedAt: nowISO() })),
      };
      writeJsonAtomic(f, doc);
    }
    /* 补齐内置项（模块升级后新增的场景要能出现） */
    for (const b of BUILTIN_PROMPTS) {
      if (!doc.items.find((x) => x.id === b.id)) {
        doc.items.push(Object.assign({}, b, { updatedAt: nowISO() }));
      }
    }
    if (!doc.items.find((x) => x.id === doc.activeId)) doc.activeId = 'general';
    return doc;
  }

  _promptOut(p) {
    return {
      id: p.id,
      name: p.name,
      scenario: p.scenario || 'general',
      content: p.content || '',
      builtin: p.builtin === true,
      chars: String(p.content || '').length,
      tokensEst: estTokens(p.content || ''),
      updatedAt: p.updatedAt || '',
    };
  }

  listPrompts(user) {
    const doc = this.getUserPrompts(user);
    return {
      ok: true,
      activeId: doc.activeId,
      scenarios: SCENARIOS,
      items: doc.items.map((p) => this._promptOut(p)),
      builtins: BUILTIN_PROMPTS.map((p) => ({ id: p.id, name: p.name, scenario: p.scenario, content: p.content })),
    };
  }

  savePrompt(user, input) {
    const src = input || {};
    const doc = this.getUserPrompts(user);
    const content = String(src.content == null ? '' : src.content);
    if (content.length > MAX_PROMPT_CHARS) throw gwError('BAD_PROMPT', '提示词长度上限 ' + MAX_PROMPT_CHARS + ' 字', { status: 400 });
    const scenario = SCENARIOS.includes(String(src.scenario)) ? String(src.scenario) : 'general';
    let item = src.id ? doc.items.find((x) => x.id === String(src.id)) : null;
    if (item) {
      if (item.builtin && !src.allowBuiltinEdit) {
        /* 内置项允许改内容（用户自己的副本），但保留 builtin 标记，便于一键恢复 */
      }
      if (src.name !== undefined) item.name = String(src.name).slice(0, 40) || item.name;
      if (src.content !== undefined) item.content = content;
      if (src.scenario !== undefined) item.scenario = scenario;
      item.updatedAt = nowISO();
    } else {
      if (doc.items.length >= 30) throw gwError('BAD_PROMPT', '提示词套数上限 30', { status: 400 });
      const id = slug(src.id || src.name) || 'p-' + crypto.randomBytes(3).toString('hex');
      if (doc.items.find((x) => x.id === id)) throw gwError('BAD_PROMPT', '提示词 id 已存在', { status: 400 });
      item = {
        id, name: String(src.name || '未命名').slice(0, 40), scenario, content,
        builtin: false, updatedAt: nowISO(),
      };
      doc.items.push(item);
    }
    writeJsonAtomic(this._promptFile(user), doc);
    return this._promptOut(item);
  }

  deletePrompt(user, id) {
    const doc = this.getUserPrompts(user);
    const i = doc.items.findIndex((x) => x.id === String(id || ''));
    if (i < 0) throw gwError('NO_PROMPT', '提示词不存在', { status: 404 });
    if (doc.items[i].builtin) throw gwError('BUILTIN_PROMPT', '内置提示词不能删除，可恢复默认', { status: 400 });
    const [removed] = doc.items.splice(i, 1);
    if (doc.activeId === removed.id) doc.activeId = 'general';
    writeJsonAtomic(this._promptFile(user), doc);
    return { ok: true, removed: removed.id, activeId: doc.activeId };
  }

  activatePrompt(user, id) {
    const doc = this.getUserPrompts(user);
    const item = doc.items.find((x) => x.id === String(id || ''));
    if (!item) throw gwError('NO_PROMPT', '提示词不存在', { status: 404 });
    doc.activeId = item.id;
    writeJsonAtomic(this._promptFile(user), doc);
    /* 同步写进 params.system_prompt_id：否则下次对话仍会读到旧的 system_prompt_id
       （PARAM_DEFAULTS 默认 'general'，不落盘就永远切换不过去） */
    this.setUserParams(user, { system_prompt_id: item.id });
    return { ok: true, activeId: item.id, prompt: this._promptOut(item) };
  }

  /** 恢复默认：指定内置 id 或全部内置项；用户自建项不动 */
  resetPrompt(user, id) {
    const doc = this.getUserPrompts(user);
    if (id) {
      const b = BUILTIN_PROMPTS.find((x) => x.id === String(id));
      const item = doc.items.find((x) => x.id === String(id));
      if (!b || !item) throw gwError('NO_PROMPT', '内置提示词不存在', { status: 404 });
      item.content = b.content;
      item.name = b.name;
      item.scenario = b.scenario;
      item.updatedAt = nowISO();
    } else {
      for (const b of BUILTIN_PROMPTS) {
        const item = doc.items.find((x) => x.id === b.id);
        if (item) {
          item.content = b.content;
          item.name = b.name;
          item.scenario = b.scenario;
          item.updatedAt = nowISO();
        }
      }
    }
    writeJsonAtomic(this._promptFile(user), doc);
    return this.listPrompts(user);
  }

  /** 解析本轮实际使用的系统提示：params.system_prompt_id → activeId → 兜底 general */
  resolveSystemPrompt(user, params) {
    const doc = this.getUserPrompts(user);
    const wanted = params.system_prompt_id || doc.activeId || 'general';
    let item = doc.items.find((x) => x.id === wanted);
    if (!item) item = doc.items.find((x) => x.id === doc.activeId);
    if (!item) item = doc.items.find((x) => x.id === 'general') || doc.items[0];
    const content = String((item && item.content) || '').trim()
      || '你是深空助手，用中文回答。回答简洁，先说结论，不重复问题。';
    return { id: item ? item.id : 'general', name: item ? item.name : '通用', content };
  }

  /* ---------------- 会话与历史（每用户隔离） ---------------- */

  _sessionFile(user) { return this._userFile(user, 'sessions.json'); }

  _loadSessions(user) {
    const doc = readJsonSafe(this._sessionFile(user), null);
    if (doc && Array.isArray(doc.sessions)) return doc;
    return { version: GW_VERSION, sessions: [] };
  }

  _saveSessions(user, doc) {
    /* 上限保护：会话数与会话内消息数都封顶，避免一个用户把磁盘写爆 */
    if (doc.sessions.length > MAX_SESSIONS) {
      doc.sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      doc.sessions = doc.sessions.slice(0, MAX_SESSIONS);
    }
    writeJsonAtomic(this._sessionFile(user), doc);
  }

  _sessionOut(s, withMessages) {
    const last = s.messages && s.messages.length ? s.messages[s.messages.length - 1] : null;
    const out = {
      id: s.id,
      title: s.title || '未命名会话',
      createdAt: s.createdAt || '',
      updatedAt: s.updatedAt || '',
      modelId: s.modelId || '',
      messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
      preview: last ? truncate(String(last.content || '').replace(/\s+/g, ' '), 80) : '',
    };
    if (withMessages) {
      out.messages = (s.messages || []).map((m) => ({
        role: m.role, content: m.content, at: m.at || '',
        usage: m.usage || null, ttft_ms: m.ttft_ms != null ? m.ttft_ms : null,
      }));
    }
    return out;
  }

  listSessions(user) {
    const doc = this._loadSessions(user);
    const items = doc.sessions
      .map((s) => this._sessionOut(s, false))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { ok: true, count: items.length, sessions: items };
  }

  getSession(user, id) {
    const doc = this._loadSessions(user);
    const s = doc.sessions.find((x) => x.id === String(id || ''));
    if (!s) throw gwError('NO_SESSION', '会话不存在或不属于当前用户', { status: 404 });
    return { ok: true, session: this._sessionOut(s, true) };
  }

  createSession(user, input) {
    const src = input || {};
    const doc = this._loadSessions(user);
    const s = {
      id: 's_' + crypto.randomBytes(8).toString('hex'),
      title: String(src.title || '新会话').slice(0, 60),
      modelId: String(src.modelId || '').slice(0, 40),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      messages: [],
    };
    doc.sessions.push(s);
    this._saveSessions(user, doc);
    return { ok: true, session: this._sessionOut(s, true) };
  }

  renameSession(user, id, title) {
    const doc = this._loadSessions(user);
    const s = doc.sessions.find((x) => x.id === String(id || ''));
    if (!s) throw gwError('NO_SESSION', '会话不存在或不属于当前用户', { status: 404 });
    s.title = String(title || '').trim().slice(0, 60) || s.title;
    s.updatedAt = nowISO();
    this._saveSessions(user, doc);
    return { ok: true, session: this._sessionOut(s, false) };
  }

  deleteSession(user, id) {
    const doc = this._loadSessions(user);
    const i = doc.sessions.findIndex((x) => x.id === String(id || ''));
    if (i < 0) throw gwError('NO_SESSION', '会话不存在或不属于当前用户', { status: 404 });
    const [removed] = doc.sessions.splice(i, 1);
    this._saveSessions(user, doc);
    return { ok: true, removed: removed.id, count: doc.sessions.length };
  }

  /** 追加消息（chat 成功后调用）；超上限从最老的非 system 消息开始丢 */
  appendToSession(user, sessionId, messages) {
    if (!sessionId) return null;
    const doc = this._loadSessions(user);
    const s = doc.sessions.find((x) => x.id === String(sessionId));
    if (!s) return null;
    for (const m of messages || []) {
      s.messages.push({
        role: m.role,
        content: String(m.content || '').slice(0, MAX_MESSAGE_CHARS),
        at: m.at || nowISO(),
        usage: m.usage || null,
        ttft_ms: m.ttft_ms != null ? m.ttft_ms : null,
      });
    }
    if (s.messages.length > MAX_MESSAGES_PER_SESSION) {
      s.messages = s.messages.slice(s.messages.length - MAX_MESSAGES_PER_SESSION);
    }
    if (!s.title || s.title === '新会话') {
      const firstUser = s.messages.find((m) => m.role === 'user');
      if (firstUser) s.title = truncate(String(firstUser.content).replace(/\s+/g, ' '), 24);
    }
    s.updatedAt = nowISO();
    this._saveSessions(user, doc);
    return s.id;
  }

  exportSession(user, id, format) {
    const doc = this._loadSessions(user);
    const s = doc.sessions.find((x) => x.id === String(id || ''));
    if (!s) throw gwError('NO_SESSION', '会话不存在或不属于当前用户', { status: 404 });
    const fmt = String(format || 'markdown').toLowerCase();
    if (fmt === 'json') {
      return {
        format: 'json',
        filename: 'session-' + s.id + '.json',
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
          modelId: s.modelId, exportedAt: nowISO(), exportedBy: user.username, messages: s.messages,
        }, null, 2),
      };
    }
    if (fmt !== 'markdown' && fmt !== 'md') {
      throw gwError('BAD_FORMAT', 'format 只支持 markdown / json', { status: 400 });
    }
    const lines = [];
    lines.push('# ' + (s.title || '会话'));
    lines.push('');
    lines.push('- 会话 ID：`' + s.id + '`');
    lines.push('- 创建时间：' + s.createdAt);
    lines.push('- 更新时间：' + s.updatedAt);
    lines.push('- 导出时间：' + nowISO());
    lines.push('- 导出用户：' + user.username);
    lines.push('');
    for (const m of s.messages || []) {
      lines.push('## ' + (m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role));
      lines.push('');
      lines.push(String(m.content || ''));
      lines.push('');
      const meta = [];
      if (m.ttft_ms != null) meta.push('首 token ' + Math.round(m.ttft_ms) + 'ms');
      if (m.usage && m.usage.completion_tokens) meta.push('生成 ' + m.usage.completion_tokens + ' tokens');
      if (m.at) meta.push(m.at);
      if (meta.length) {
        lines.push('> ' + meta.join(' · '));
        lines.push('');
      }
    }
    return {
      format: 'markdown',
      filename: 'session-' + s.id + '.md',
      contentType: 'text/markdown; charset=utf-8',
      body: lines.join('\n'),
    };
  }

  /* ---------------- 上游请求构造 / diag ---------------- */

  _endpoint(model, what) {
    const base = String(model.baseUrl || '').replace(/\/+$/, '');
    const hasV1 = /\/v1$/i.test(base);
    if (what === 'models') return (hasV1 ? base : base + '/v1') + '/models';
    if (what === 'props') return base + '/props';
    return (hasV1 ? base : base + '/v1') + '/chat/completions';
  }

  _upstreamHeaders(model, sse) {
    const h = { 'Content-Type': 'application/json' };
    if (sse) h.Accept = 'text/event-stream';
    if (model.apiKeyEnc) {
      const key = this._decrypt(model.apiKeyEnc);
      if (key) h.Authorization = 'Bearer ' + key;
    }
    return h;
  }

  /** 组装真正发给上游的 body —— 验收要证明「参数不是只存在面板里」 */
  buildPayload(model, messages, params) {
    const body = {
      model: model.model || 'local',
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: params.temperature,
      top_p: params.top_p,
      max_tokens: params.max_tokens,
    };
    if (params.stop && params.stop.length) body.stop = params.stop.slice(0, MAX_STOP_SEQ);
    if (model.kind === 'local') {
      /* llama.cpp 专有：prompt cache 命中是「首 token ≤3s」的关键；
         enable_thinking=false 防止 2B 模型把预算烧在思考标记上（旧 cfg 同口径） */
      body.repeat_penalty = params.repeat_penalty;
      body.cache_prompt = true;
      /* 默认关思考；模型 extraBody 若显式给了 chat_template_kwargs 会被下面的合并覆盖 */
      body.chat_template_kwargs = { enable_thinking: false };
    }
    /* 管理员可给模型补 extraBody（如 ollama 的 keep_alive、vLLM 的 top_k），
       但**不允许**覆盖 messages/model/stream —— 那是网关的契约，不能被配置改写 */
    const extra = model.extraBody && typeof model.extraBody === 'object' ? model.extraBody : null;
    if (extra) {
      for (const k of Object.keys(extra)) {
        if (k === 'messages' || k === 'model' || k === 'stream') continue;
        if (body[k] === undefined) body[k] = extra[k];
      }
    }
    return body;
  }

  /** diag 用脱敏 payload：key 永不出现，消息正文只留 120 字 */
  _sanitizePayload(payload, model) {
    const out = {
      url: this._endpoint(model, 'chat'),
      model: payload.model,
      stream: payload.stream,
      temperature: payload.temperature,
      top_p: payload.top_p,
      max_tokens: payload.max_tokens,
      repeat_penalty: payload.repeat_penalty,
      stop: payload.stop || undefined,
      cache_prompt: payload.cache_prompt,
      stream_options: payload.stream_options,
      chat_template_kwargs: payload.chat_template_kwargs,
      message_count: Array.isArray(payload.messages) ? payload.messages.length : 0,
      messages: (payload.messages || []).map((m) => ({
        role: m.role,
        chars: String(m.content || '').length,
        head: truncate(String(m.content || '').replace(/\s+/g, ' '), 120),
      })),
    };
    return out;
  }

  _diagAppend(rec) {
    try {
      rec.at = rec.at || nowISO();
      this.recent.push(rec);
      if (this.recent.length > DIAG_KEEP) this.recent = this.recent.slice(-DIAG_KEEP);
      const f = path.join(this.dataDir, 'diag.jsonl');
      try {
        const st = fs.statSync(f);
        if (st.size > DIAG_FILE_MAX) {
          try { fs.renameSync(f, f + '.1'); } catch { /* 轮转失败就继续追加 */ }
        }
      } catch { /* 文件不存在：首次写 */ }
      fs.appendFileSync(f, JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch (e) {
      console.warn('[ai-gw] diag 写入失败：' + (e && e.message));
    }
  }

  _loadRecent() {
    if (this.recentLoaded) return;
    this.recentLoaded = true;
    try {
      const f = path.join(this.dataDir, 'diag.jsonl');
      const buf = fs.readFileSync(f);
      const txt = buf.slice(Math.max(0, buf.length - 512 * 1024)).toString('utf8');
      const lines = txt.split('\n').filter(Boolean).slice(-DIAG_KEEP);
      for (const line of lines) {
        try { this.recent.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
    } catch { /* 没有历史 diag */ }
  }

  diag(user, opts) {
    const isAdmin = !!(user && user.role === 'admin');
    const all = isAdmin && !!(opts && opts.all);
    this._loadRecent();
    const own = this.recent.filter((r) => r.type !== 'probe' && (all || r.userId === (user && user.id)));
    const last = own.length ? own[own.length - 1] : null;
    const ttfts = own.map((r) => (r.metrics && r.metrics.ttft_ms)).filter((n) => Number.isFinite(n));
    const sorted = ttfts.slice().sort((a, b) => a - b);
    const pick = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);
    const recent = own.slice(-20).map((r) => stripForDiag(r));
    const params = user ? this.effectiveParams(user) : null;
    const prompt = user ? this.resolveSystemPrompt(user, params || {}) : null;
    return {
      ok: true,
      version: GW_VERSION,
      at: nowISO(),
      user: user ? { id: user.id, username: user.username, role: user.role } : null,
      scope: all ? 'all' : 'self',
      params,
      prompt,
      activeRequests: this.active.size,
      /** 每个用户的进行中请求数（排查"某账号永久 429"用） */
      activeByUser: (() => {
        const out = {};
        for (const rec of this.active.values()) {
          const k = rec.username || rec.userId;
          out[k] = (out[k] || 0) + 1;
        }
        return out;
      })(),
      /** 进行中请求明细：id/用户/phase/已运行时长（有泄漏时一眼看出卡在哪一步） */
      active: [...this.active.values()].map((rec) => ({
        id: rec.id,
        userId: rec.userId,
        username: rec.username || '',
        phase: rec.phase,
        elapsed_ms: rec.startedAt ? Date.now() - rec.startedAt : null,
        watchdog: !!rec.watchdog,
      })),
      /** 并发闸门快照：active/queue 数对不上 activeRequests 时说明闸门泄漏 */
      gates: [...this.gates.entries()].map(([id, g]) => ({ modelId: id, ...g.snapshot() })),
      stats: {
        count: ttfts.length,
        ttft_ms_min: sorted.length ? sorted[0] : null,
        ttft_ms_p50: pick(0.5),
        ttft_ms_p95: pick(0.95),
        ttft_ms_max: sorted.length ? sorted[sorted.length - 1] : null,
      },
      last: last ? stripForDiag(last) : null,
      recent,
      models: this.listModels(user, { admin: isAdmin }).models,
    };
  }

  /* ---------------- 聊天核心 ---------------- */

  _gateFor(model) {
    const id = model.id;
    if (!this.gates.has(id)) this.gates.set(id, new Gate(model.maxConcurrent || 1));
    return this.gates.get(id);
  }

  _resolveModel(user, requestedId) {
    const isAdmin = !!(user && user.role === 'admin');
    const stored = this.getUserParams(user).model_id;
    const want = String(requestedId || stored || '').trim();
    if (want) {
      const m = this.findModel(want);
      if (m && m.enabled !== false) {
        if (!isAdmin && m.allowUserSelect === false && want !== this.models.defaultId) return null;
        return m;
      }
      if (!stored && requestedId) return null;
    }
    const d = this.findModel(this.models.defaultId);
    if (d && d.enabled !== false) return d;
    return this._adminModels().find((m) => m.enabled !== false) || null;
  }

  /** 客户端消息白名单：只收 user/assistant；system/tool 一律丢弃（提示词由服务端注入） */
  _sanitizeInput(messages) {
    const out = [];
    const notes = [];
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m !== 'object') continue;
      const role = String(m.role || '');
      if (role !== 'user' && role !== 'assistant') {
        notes.push('丢弃 role=' + role);
        continue;
      }
      const content = typeof m.content === 'string' ? m.content : (m.content == null ? '' : String(m.content));
      if (!content) continue;
      out.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
    }
    let trimmed = out;
    if (out.length > MAX_HISTORY_MESSAGES) {
      notes.push('只保留最近 ' + MAX_HISTORY_MESSAGES + ' 条');
      trimmed = out.slice(-MAX_HISTORY_MESSAGES);
    }
    return { messages: trimmed, notes };
  }

  _buildMessages(systemPrompt, history, params) {
    let list = history.slice();
    if (params.fast_mode) list = list.slice(-8);
    let est = estTokens(systemPrompt);
    const kept = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const t = estTokens(m.content) + 4;
      if (est + t > params.context_tokens * 0.85 && kept.length) break;
      kept.unshift({ role: m.role, content: m.content });
      est += t;
    }
    const dropped = list.length - kept.length;
    return {
      messages: [{ role: 'system', content: systemPrompt }].concat(kept),
      estTokens: est,
      dropped,
    };
  }

  _inputMessages(body, session) {
    let list = Array.isArray(body && body.messages) ? body.messages : [];
    if (!list.length && session) list = session.messages || [];
    const { messages, notes } = this._sanitizeInput(list);
    return { messages, notes };
  }

  /**
   * 处理一次对话。stream=true 时通过 emit 推 SSE 事件；false 时收集后返回 JSON。
   * @returns {Promise<object>} 结果对象（也是 JSON 模式的响应体）
   */
  async handleChat(ctx) {
    const { res, user, body } = ctx;
    if (!user) return ctx.sendJSON(res, 401, { ok: false, error: '需要登录', code: 'UNAUTHORIZED' });

    /* 每用户并发上限：本机只有 2 核，一个人开 5 路流会把别人全卡死 */
    let mine = 0;
    for (const a of this.active.values()) if (a.userId === user.id) mine++;
    if (mine >= 2) {
      return ctx.sendJSON(res, 429, { ok: false, error: '该账号已有 2 个进行中的请求，请稍后再试', code: 'BUSY' });
    }

    const model = this._resolveModel(user, body && body.modelId);
    if (!model) {
      return ctx.sendJSON(res, 400, { ok: false, error: '没有可用模型：模型不存在、已禁用或未被允许选择', code: 'NO_MODEL' });
    }
    let session = null;
    if (body && body.sessionId) {
      try {
        session = this.getSession(user, body.sessionId).session;
      } catch (e) {
        if (!body.newSession) {
          return ctx.sendJSON(res, 404, { ok: false, error: '会话不存在或不属于当前用户', code: 'NO_SESSION' });
        }
      }
    }
    const { messages, notes } = this._inputMessages(body || {}, session);
    if (!messages.length) return ctx.sendJSON(res, 400, { ok: false, error: 'messages 为空', code: 'NO_MESSAGES' });
    if (messages[messages.length - 1].role !== 'user') {
      return ctx.sendJSON(res, 400, { ok: false, error: '最后一条消息必须是 user', code: 'BAD_MESSAGES' });
    }

    /* =====================================================================
     * P2 RAG：知识库检索（在 SSE 头写出之前完成）
     *   · 跨用户 kb id → 直接 404（不是静默忽略，否则隔离验收无法证伪）；
     *   · embedding 服务不可用 → 记 warning，按普通对话继续（"不可用不影响对话"）；
     *   · 检索命中 → 消息增强 + sources 事件；无命中 → 固定回复"知识库中未找到相关内容。"
     * ===================================================================== */
    const kbIds = Array.isArray(body && body.kb_ids)
      ? [...new Set(body.kb_ids.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 8)
      : [];
    const lastUserContent = messages[messages.length - 1].content;
    let rag = null;
    let kbWarn = null;
    if (kbIds.length) {
      const kb = this.kb(user);
      const owned = kb.ownedKbIds(user, kbIds);
      const missing = kbIds.filter((id) => !owned.includes(id));
      if (missing.length) {
        return ctx.sendJSON(res, 404, {
          ok: false, error: '知识库不存在或不属于当前用户', code: 'KB_NOT_FOUND', missing,
        });
      }
      try {
        rag = await kb.search(user, kbIds, lastUserContent, {
          topK: body && body.kb_top_k != null ? body.kb_top_k : undefined,
        });
      } catch (e) {
        rag = { ok: false, code: (e && e.code) || 'KB_ERROR', error: String((e && e.message) || e) };
      }
      if (rag && rag.ok === false) {
        kbWarn = {
          type: 'warning', code: rag.code || 'KB_UNAVAILABLE',
          message: '知识库检索不可用：' + (rag.error || '未知错误') + '；本次已按普通对话继续。',
          at: nowISO(),
        };
      }
    }

    const requestId = 'rq_' + crypto.randomBytes(6).toString('hex');
    const wantStream = !(body && body.stream === false);
    const t0 = Date.now();

    if (!wantStream) {
      const events = [];
      const result = await this._run({
        user, model, body: body || {}, messages, session, requestId, t0, notes,
        rag, kbWarn,
        emit: (ev) => { events.push(ev); },
        isClientGone: () => false,
      });
      const summary = {
        ok: result.ok === true,
        requestId,
        text: result.text || '',
        reasoning: result.reasoning || '',
        promoted_reasoning: !!result.promotedReasoning,
        finish: result.finish,
        error: result.error || '',
        code: result.code || '',
        model: result.model,
        usage: result.usage || null,
        metrics: result.metrics || null,
        sessionId: result.sessionId || null,
        messageId: result.messageId || null,
        early_stop: !!result.earlyStop,
        sources: result.sources || [],
        kb: result.kb || null,
        memory: result.memory || null,
        events: events.map((e) => (e.type === 'token' ? { type: 'token', index: e.index } : e)),
      };
      return ctx.sendJSON(res, result.ok ? 200 : (result.status || 502), summary);
    }

    /* ---------- SSE ---------- */
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let finished = false;
    const write = (ev) => {
      if (finished || res.writableEnded || res.destroyed) return false;
      try {
        res.write('data: ' + JSON.stringify(ev) + '\n\n');
        return true;
      } catch {
        return false;
      }
    };
    const heartbeat = setInterval(() => {
      write({ type: 'heartbeat', requestId, elapsed_ms: Date.now() - t0 });
    }, 8000);
    if (heartbeat.unref) heartbeat.unref();

    const onClose = () => {
      if (finished) return;
      this._abort(requestId, gwError('CANCELED', '客户端已断开', { phase: 'stream' }));
    };
    res.on('close', onClose);

    try {
      await this._run({
        user, model, body: body || {}, messages, session, requestId, t0, notes,
        rag, kbWarn,
        emit: write,
        isClientGone: () => finished || res.writableEnded || res.destroyed,
      });
    } catch (e) {
      /* _run 内部已把错误翻译成事件；这里兜底，保证连接一定收尾 */
      write({ type: 'error', requestId, error: String((e && e.message) || e), code: (e && e.code) || 'INTERNAL' });
    } finally {
      finished = true;
      clearInterval(heartbeat);
      res.removeListener('close', onClose);
      try { if (!res.writableEnded) res.end(); } catch { /* 已断 */ }
    }
    return true;
  }

  /** 取消：只允许取消自己的请求（管理员可取消任意） */
  cancel(user, requestId) {
    const rec = this.active.get(String(requestId || ''));
    if (!rec) return { ok: false, canceled: false, error: '请求不存在或已结束', code: 'NOT_FOUND' };
    if (!(user && (user.id === rec.userId || user.role === 'admin'))) {
      return { ok: false, canceled: false, error: '无权取消他人的请求', code: 'FORBIDDEN' };
    }
    this._abort(rec.id, gwError('CANCELED', '用户主动取消', { phase: 'user_cancel' }));
    return { ok: true, canceled: true, requestId: rec.id, phase: rec.phase };
  }

  _abort(requestId, reason) {
    const rec = this.active.get(String(requestId));
    if (!rec || !rec.controller) return false;
    try { rec.cancelReason = reason; } catch { /* 非关键 */ }
    try { rec.controller.abort(reason); } catch { /* 已中止 */ }
    return true;
  }

  /** 真正跑一次逻辑请求：排队 → 上游流式 → 重试 → 终止事件 */
  async _run(o) {
    const { user, model, messages, session, requestId, t0, body } = o;
    const rag = o.rag || null;
    const kbWarn = o.kbWarn || null;
    const emit = o.emit || (() => {});
    const params = this.effectiveParams(user, body && body.params);
    const prompt = this.resolveSystemPrompt(user, params);

    /* ---------- 第 6 轮：用户记忆注入 ----------
       pinned 优先 + 最近更新，最多 8 条 / 段总字符 ≤1200；拼在 system prompt 之后。
       读取失败不能阻断对话（记 memory.error，按无记忆继续）。 */
    const memSel = this._memoryFor(user);
    const systemContent = memSel.section ? prompt.content + memSel.section : prompt.content;
    const built = this._buildMessages(systemContent, messages, params);

    /* ---------- RAG 三种状态：命中 / 未命中 / 检索不可用 ---------- */
    const kbHits = rag && rag.ok && Array.isArray(rag.hits) ? rag.hits : [];
    const kbMiss = !!(rag && rag.ok === true && rag.miss === true);
    const memoryInfo = {
      used: memSel.used || 0,
      max: memSel.max || 50,
      injected: kbMiss ? 0 : (memSel.count || 0),
      chars: kbMiss ? 0 : (memSel.chars || 0),
      ids: kbMiss ? [] : (memSel.ids || []),
      truncated: !!memSel.truncated,
      skipped: kbMiss ? 'kb_miss' : '',
      error: memSel.error || '',
    };
    /* 命中的资料拼到最后一条 user 消息里（追加在历史之后，不破坏静态前缀的 KV cache） */
    const payloadMessages = kbHits.length ? this._augmentWithSources(built.messages, kbHits) : built.messages;

    const controller = new AbortController();
    const rec = { id: requestId, userId: user.id, username: user.username || '', controller, phase: 'queued', startedAt: t0, text: '' };
    this.active.set(requestId, rec);

    const metrics = {
      queued_ms: null,
      upstream_ttft_ms: null,
      ttft_ms: null,
      first_content_ms: null,
      gen_ms: null,
      total_ms: null,
      tok_per_s: null,
      attempts: 0,
      rag_ms: rag && rag.ms != null ? rag.ms : null,
    };
    let text = '';
    let reasoning = '';
    let promotedReasoning = false;
    let usage = null;
    let timings = null;
    let finishReason = '';
    let earlyStop = false;
    let finish = 'error';
    let lastError = null;
    let resultStatus = 502;
    let messageId = null;
    let payloadSanitized = null;

    const totalTimer = setTimeout(() => {
      this._abort(requestId, gwError('TIMEOUT', '单请求总时长超过 ' + params.total_timeout_ms + 'ms', { phase: 'total' }));
    }, params.total_timeout_ms);
    if (totalTimer.unref) totalTimer.unref();

    /* =====================================================================
     * 槽位生命周期（第 5 轮修复）：**所有出口只走 releaseSlot()**
     * ---------------------------------------------------------------------
     * 旧实现把 release()/active.delete() 写在 `else try` 的 finally 里，于是：
     *   ① kb-miss 分支（不调用 LLM）根本走不到那个 try → 槽位永不释放；
     *   ② 进入该 try 之前抛错的路径同样不释放。
     * 两个请求就能把账号钉死成 429（用户侧表现 = "AI 突然永久不可用"）。
     * 现在：releaseSlot 幂等（released 标记 + Gate releaser 幂等），
     * 由最外层 try/finally + 看门狗兜底，正常/错误/超时/取消/断连全覆盖。
     * ===================================================================== */
    let releaseGate = null;
    let released = false;
    let watchdogTimer = null;
    let watchdogFired = false;
    let diagRecorded = false;
    let endReason = 'running';

    const releaseSlot = () => {
      if (released) return false;
      released = true;
      try {
        if (releaseGate) releaseGate();   // Gate releaser 内部也幂等
      } catch { /* 释放失败不能影响收尾 */ }
      releaseGate = null;
      try { clearTimeout(totalTimer); } catch { /* 非关键 */ }
      if (watchdogTimer) { try { clearTimeout(watchdogTimer); } catch { /* 非关键 */ } }
      const had = this.active.delete(requestId);
      return had;
    };

    /* 看门狗：正常路径不该触发（total_timeout_ms 定时器会先 abort）；这是"永久不可用"的兜底 */
    watchdogTimer = setTimeout(() => {
      const recNow = this.active.get(requestId);
      if (!recNow) return;
      watchdogFired = true;
      recNow.watchdog = true;
      const elapsed = Date.now() - t0;
      this._diagAppend({
        type: 'leak-watchdog', at: nowISO(), id: requestId,
        userId: user.id, username: user.username, phase: recNow.phase,
        elapsed_ms: elapsed, total_timeout_ms: params.total_timeout_ms,
        over_ms: elapsed - params.total_timeout_ms,
        action: 'abort+release',
      });
      this._abort(requestId, gwError('WATCHDOG', '请求超过 total_timeout_ms+10s 未结束，看门狗强制回收槽位', { phase: 'watchdog' }));
      /* 不赌 abort 一定能让上游收尾：看门狗当场回收槽位（幂等），随后正常路径的 releaseSlot 自动 no-op */
      releaseSlot();
      /* 极端兜底：若期间又有别的路径把 requestId 塞回 active（正常不会），再强制清一次 */
      const hard = setTimeout(() => {
        if (!this.active.has(requestId)) return;
        const cur = this.active.get(requestId);
        this._diagAppend({
          type: 'leak-watchdog', at: nowISO(), id: requestId,
          userId: user.id, username: user.username, phase: (cur && cur.phase) || '',
          elapsed_ms: Date.now() - t0, action: 'hard-release',
        });
        releaseSlot();
      }, WATCHDOG_HARD_GRACE_MS);
      if (hard.unref) hard.unref();
    }, params.total_timeout_ms + WATCHDOG_GRACE_MS);
    if (watchdogTimer.unref) watchdogTimer.unref();

    try {
    emit({
      type: 'queued', requestId, at: nowISO(),
      model: { id: model.id, name: model.name, model: model.model },
      params: pickParams(params), prompt: { id: prompt.id, name: prompt.name, chars: prompt.content.length },
    });
    if (kbWarn) emit(kbWarn);
    if (kbHits.length || kbMiss || (rag && rag.ok === false)) {
      emit({
        type: 'sources', requestId, at: nowISO(),
        sources: kbHits,
        kb: this._kbInfo(rag, kbHits, kbMiss),
      });
    }

    const maxAttempts = Math.max(1, 1 + (params.retries || 0));
    let attempt = 0;
    if (kbMiss) {
      /* 知识库里没有命中：**不调用 LLM**，直接流式输出固定声明。
         为什么不做"让模型说未找到"：2B 模型在明确指令下仍可能编造；P0 的教训是
         "宁可说没有，也不能硬编"。这样行为也确定，验收可断言。 */
      finish = 'done';
      finishReason = 'kb_miss';
      endReason = 'done';
      text = '';
      rec.phase = 'kb_miss';
      for (const piece of ['知识库中未找到', '相关内容。']) {
        const now = Date.now();
        if (!rec.firstTokenAt) { rec.firstTokenAt = now; metrics.ttft_ms = now - t0; }
        rec.lastTokenAt = now;
        text += piece;
        rec.text = text;
        emit({ type: 'token', requestId, delta: piece, index: text.length });
      }
      metrics.upstream_ttft_ms = 0;
      metrics.gen_ms = rec.lastTokenAt && rec.firstTokenAt ? rec.lastTokenAt - rec.firstTokenAt : 0;
      metrics.tok_per_s = 0;
    } else try {
      releaseGate = await this._gateFor(model).acquire(controller.signal, (pos) => {
        emit({ type: 'queued', requestId, queue_position: pos, model: { id: model.id } });
      });
      metrics.queued_ms = Date.now() - t0;
      rec.phase = 'running';
      try {
        for (let i = 1; i <= maxAttempts; i++) {
          attempt = i;
          metrics.attempts = attempt;
          /* 每次尝试前都要看一眼总闸：取消/总超时可能在等待期间发生 */
          if (controller.signal.aborted) throw controller.signal.reason || gwError('CANCELED', '已取消');
          rec.phase = 'running';
          emit({
            type: 'started', requestId, attempt, attempts: maxAttempts, at: nowISO(),
            model: { id: model.id, name: model.name, model: model.model },
          });
          try {
            const r = await this._streamOnce({
              model, params, messages: payloadMessages, requestId, t0, controller, emit, rec,
              onPayload: (p) => { payloadSanitized = p; },
            });
            text = r.text;
            reasoning = r.reasoning || '';
            usage = r.usage;
            timings = r.timings;
            finishReason = r.finishReason;
            earlyStop = !!r.earlyStop;
            metrics.upstream_ttft_ms = r.upstreamTtftMs;
            metrics.ttft_ms = r.firstTokenAt ? r.firstTokenAt - t0 : null;
            metrics.first_content_ms = r.firstContentMs != null ? r.firstContentMs : null;
            metrics.gen_ms = r.genMs;
            /* 正文为空但攒了思考过程：整段提升为正文（否则前端看到「空回答」） */
            if (!text && reasoning) {
              text = reasoning;
              promotedReasoning = true;
            }
            finish = earlyStop ? 'done_early_stop' : 'done';
            endReason = 'done';
            break;
          } catch (e) {
            lastError = e;
            text = rec.text || text;
            /* 只有「还没出字」才允许重试：已经推给前端的文字再重试会重复一截 */
            const canRetry = !!(e && e.retryable) && !controller.signal.aborted && i < maxAttempts && !text;
            if (!canRetry) throw e;
            const delay = Math.min(8000, 400 * Math.pow(2, i - 1)) + Math.floor(Math.random() * 100);
            rec.phase = 'retry_wait';
            emit({
              type: 'retry', requestId, attempt: i, next_attempt: i + 1, delay_ms: delay,
              reason: (e && e.code) || 'UPSTREAM_ERROR',
              error: String((e && e.message) || e),
              phase: (e && e.phase) || '',
              at: nowISO(),
            });
            await sleep(delay, controller.signal);
            rec.phase = 'running';
          }
        }
      } finally {
        /* 上游尝试结束（成功/失败/取消都算）：立即释放闸门，排队者不必等 diag/落库 */
        releaseSlot();
      }
    } catch (rawErr) {
      /* =====================================================================
       * 终止优先级（对外契约，别改）：**谁先触发谁定 phase**。
       *
       * total_timeout / 用户取消 / 客户端断开 三条路径都会 abort 父 controller，
       * 并把原因挂在 controller.signal.reason 上（gwError 带 phase）。
       * 但上游此时可能刚好也在收尾 —— fetch/reader 抛出的往往只是 TypeError
       * 或 AbortError（没有 phase）。旧代码直接用了这个"上游错误对象"，于是
       * 出现「total 超时已触发、终止帧却是 type=timeout/phase=undefined」。
       *
       * 规则：
       *   ① 若 controller 已被 abort，且 reason 是网关自己的 gwError → 以 reason 为准；
       *   ② 否则用上游抛出的原始错误；
       *   ③ 上游先自然结束（[DONE]/reader done）时不会走到这里 —— 那是 done，
       *      即使 total 定时器在同一 tick 到期，也记为「上游先完成」，不回填 timeout。
       * ===================================================================== */
      const latched = controller.signal.aborted ? controller.signal.reason : null;
      const e = (latched && latched.gw) ? latched : rawErr;
      lastError = e;
      text = rec.text || text;
      const phase = (e && e.phase) || (latched && latched.phase) || '';
      if (e && e.code === 'CANCELED') {
        finish = 'canceled';
        endReason = phase === 'user_cancel' ? 'cancel' : 'client-abort';
        resultStatus = 499;
        emit({ type: 'canceled', requestId, phase: phase || rec.phase, text, text_chars: text.length, at: nowISO() });
      } else if (e && (e.code === 'TIMEOUT' || e.code === 'WATCHDOG')) {
        finish = 'timeout';
        endReason = e.code === 'WATCHDOG' ? 'watchdog' : 'timeout';
        resultStatus = 504;
        emit({
          type: 'timeout', requestId, phase: phase || 'request',
          timeout_ms: params.timeout_ms, total_timeout_ms: params.total_timeout_ms,
          watchdog: e.code === 'WATCHDOG',
          text, text_chars: text.length, attempts: metrics.attempts, at: nowISO(),
        });
      } else {
        finish = 'error';
        endReason = 'error';
        resultStatus = (e && e.status) || 502;
        emit({
          type: 'error', requestId, at: nowISO(),
          error: String((e && e.message) || e),
          code: (e && e.code) || 'UPSTREAM_ERROR',
          retryable: !!(e && e.retryable),
          status: (e && e.status) || null,
          attempts: metrics.attempts,
          text, text_chars: text.length,
        });
      }
    }
    } catch (fatal) {
      /* 兜底：_run 自身抛错（正常路径不该发生）也必须记录 + 释放，不能把槽位带走 */
      lastError = fatal;
      finish = 'error';
      endReason = 'error';
      resultStatus = 500;
      try {
        emit({
          type: 'error', requestId, at: nowISO(),
          error: String((fatal && fatal.message) || fatal),
          code: (fatal && fatal.code) || 'INTERNAL',
          attempts: metrics.attempts, text, text_chars: text.length,
        });
      } catch { /* 连接已断 */ }
    } finally {
      /* 唯一出口：正常 done / error / timeout / cancel / client-abort / kb-miss / fatal
         全部在这里释放槽位；重复调用无害（released 标记 + releaser 幂等）。 */
      releaseSlot();
    }

    const totalMs = Date.now() - t0;
    metrics.total_ms = totalMs;
    if (!metrics.ttft_ms && rec.firstTokenAt) metrics.ttft_ms = rec.firstTokenAt - t0;
    if (!metrics.gen_ms && rec.firstTokenAt && rec.lastTokenAt) metrics.gen_ms = rec.lastTokenAt - rec.firstTokenAt;
    const completion = usage && Number(usage.completion_tokens) > 0
      ? Number(usage.completion_tokens)
      : (text ? estTokens(text) : 0);
    if (timings && Number(timings.predicted_per_second) > 0) metrics.tok_per_s = Math.round(Number(timings.predicted_per_second) * 10) / 10;
    else if (completion && metrics.gen_ms > 0) metrics.tok_per_s = Math.round((completion / (metrics.gen_ms / 1000)) * 10) / 10;
    else if (completion && totalMs > 0) metrics.tok_per_s = Math.round((completion / (totalMs / 1000)) * 10) / 10;
    metrics.finish = finish;

    /* 会话落库：成功（含早停）才写；失败/取消的半截文本不污染历史 */
    if ((finish === 'done' || finish === 'done_early_stop') && text && (session || body.sessionId)) {
      let sid = session ? session.id : body.sessionId;
      if (sid) {
        const lastUser = messages[messages.length - 1];
        this.appendToSession(user, sid, [
          { role: 'user', content: lastUser.content, at: nowISO() },
          { role: 'assistant', content: text, at: nowISO(), usage: usage || null, ttft_ms: metrics.ttft_ms },
        ]);
        messageId = sid + ':' + Date.now();
      }
    }

    /* 成功终止事件：metrics 在会话落库之后才齐（messageId 要回给前端） */
    if (finish === 'done' || finish === 'done_early_stop') {
      emit({
        type: 'done', requestId, at: nowISO(),
        text,
        reasoning,
        promoted_reasoning: promotedReasoning,
        finish_reason: finishReason || (earlyStop ? 'early_stop' : 'stop'),
        early_stop: earlyStop,
        usage: usage || null,
        timings: timings || null,
        metrics,
        model: { id: model.id, name: model.name, model: model.model, kind: model.kind },
        sessionId: session ? session.id : (body.sessionId || null),
        messageId,
        attempts: metrics.attempts,
        sources: kbHits,
        kb: this._kbInfo(rag, kbHits, kbMiss),
        memory: memoryInfo,
      });
    }

    const record = {
      type: 'chat', id: requestId, at: nowISO(),
      userId: user.id, username: user.username,
      modelId: model.id, modelName: model.name, kind: model.kind,
      stream: true,
      attempts: metrics.attempts,
      params: pickParams(params),
      prompt: { id: prompt.id, name: prompt.name, chars: prompt.content.length },
      memory: memoryInfo,
      messages: payloadMessages.map((m) => ({ role: m.role, chars: String(m.content || '').length, head: truncate(String(m.content || '').replace(/\s+/g, ' '), 120) })),
      trim: { history_in: messages.length, history_kept: built.messages.length - 1, dropped: built.dropped, prompt_tokens_est: built.estTokens },
      payload: payloadSanitized,
      kb: this._kbInfo(rag, kbHits, kbMiss),
      usage: usage || null,
      timings: timings || null,
      metrics,
      finish,
      finish_reason: finishReason,
      early_stop: earlyStop,
      reasoning_chars: reasoning.length,
      promoted_reasoning: promotedReasoning,
      error: lastError ? String(lastError.message || lastError) : '',
      error_code: lastError && lastError.code ? lastError.code : '',
      text_chars: text.length,
      text_head: truncate(text.replace(/\s+/g, ' '), 200),
      /* 第 5 轮：槽位生命周期可观测字段 */
      end_reason: endReason,
      duration_ms: totalMs,
      watchdog: watchdogFired,
    };
    this._diagAppend(record);
    diagRecorded = true;

    return {
      ok: finish === 'done' || finish === 'done_early_stop',
      finish, status: resultStatus,
      text, reasoning, promotedReasoning, usage, timings, metrics,
      model: { id: model.id, name: model.name, model: model.model, kind: model.kind },
      sessionId: session ? session.id : (body.sessionId || null),
      messageId, earlyStop,
      sources: kbHits,
      kb: this._kbInfo(rag, kbHits, kbMiss),
      memory: memoryInfo,
      end_reason: endReason,
      watchdog: watchdogFired,
      diag_recorded: diagRecorded,
      error: lastError ? String(lastError.message || lastError) : '',
      code: lastError && lastError.code ? lastError.code : '',
    };
  }

  /** RAG 命中后把资料拼到本轮 user 消息里（放最后一条，保住静态前缀的 prompt cache） */
  _augmentWithSources(messages, hits) {
    /* CPU 机器上 prompt token 直接等于时间（~10–30 tok/s）：每条资料只带 180 字，
       总共 4 条 ≈ 720 字，避免"检索很准但首 token 等半分钟"。完整片段仍在 sources 事件里。 */
    const ctx = hits.map((h, i) => '[资料' + (i + 1) + '] ' + h.docName + '：' + truncate(String(h.text || ''), 180)).join('\n');
    const last = messages[messages.length - 1] || { role: 'user', content: '' };
    const content = '【知识库资料】\n' + ctx
      + '\n\n【问题】' + last.content
      + '\n（只依据以上资料回答；引用处标注 [资料n]；资料没有的不要编造。）';
    return messages.slice(0, -1).concat([{ role: 'user', content }]);
  }

  /** 第 6 轮：读取用户记忆并算出注入段；任何异常都降级为"无记忆"，不阻断对话 */
  _memoryFor(user) {
    try {
      return this.memory().selectForInjection(user);
    } catch (e) {
      return {
        used: 0, max: 50, count: 0, chars: 0, ids: [], section: '',
        truncated: false, error: String((e && e.message) || e),
      };
    }
  }

  /** 对外暴露的知识库使用摘要（done 事件 / diag / JSON 模式共用） */
  _kbInfo(rag, hits, miss) {    if (!rag) return null;
    const kbs = Array.isArray(rag.kbs) ? rag.kbs : [];
    return {
      ids: kbs.map((k) => k.id),
      names: kbs.map((k) => k.name),
      hits: (hits || []).length,
      miss: !!miss,
      retrieval_ms: rag.ms != null ? rag.ms : null,
      embed_ms: rag.embed_ms != null ? rag.embed_ms : null,
      top_k: rag.topK != null ? rag.topK : null,
      best_score: rag.best_score != null ? rag.best_score : null,
      pool: rag.pool != null ? rag.pool : null,
      error: rag.ok === false ? String(rag.error || '') : '',
      code: rag.ok === false ? String(rag.code || 'KB_ERROR') : '',
    };
  }

  /** 一次上游流式尝试（不含重试）。所有 abort 原因在这里翻译成统一错误。 */
  async _streamOnce(o) {
    const { model, params, messages, requestId, t0, controller, emit, rec, onPayload } = o;
    const payload = this.buildPayload(model, messages, params);
    if (onPayload) onPayload(this._sanitizePayload(payload, model));
    const url = this._endpoint(model, 'chat');

    const ac = new AbortController();
    let abortReason = null;
    let earlyStop = false;
    let firstTokenAt = 0;
    let firstContentAt = 0;
    let lastTokenAt = 0;
    let text = '';
    let reasoning = '';
    let usage = null;
    let timings = null;
    let finishReason = '';
    let startedAt = 0;

    const onParentAbort = () => {
      abortReason = abortReason || controller.signal.reason || gwError('CANCELED', '已取消');
      try { ac.abort(abortReason); } catch { /* 已中止 */ }
    };
    if (controller.signal.aborted) {
      throw controller.signal.reason || gwError('CANCELED', '已取消');
    }
    controller.signal.addEventListener('abort', onParentAbort, { once: true });

    /* 首 token 等待超时：从真正发请求开始算（排队时间另有 total 兜底） */
    const firstTimer = setTimeout(() => {
      abortReason = gwError('TIMEOUT', '等待首 token 超过 ' + params.timeout_ms + 'ms', { phase: 'first_token' });
      try { ac.abort(abortReason); } catch { /* 已中止 */ }
    }, params.timeout_ms);
    if (firstTimer.unref) firstTimer.unref();

    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortReason = gwError('TIMEOUT', '生成停滞超过 ' + params.idle_timeout_ms + 'ms', { phase: 'stream' });
        try { ac.abort(abortReason); } catch { /* 已中止 */ }
      }, params.idle_timeout_ms);
      if (idleTimer.unref) idleTimer.unref();
    };

    let reader = null;
    try {
      startedAt = Date.now();
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: this._upstreamHeaders(model, true),
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
      } catch (e) {
        throw this._translateAbort(abortReason, e, false, 'connect');
      }
      if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '');
        const err = gwError('UPSTREAM_HTTP', '「' + model.name + '」返回 HTTP ' + resp.status + '：' + truncate(errTxt, 240), {
          status: resp.status >= 500 ? 502 : 400,
          httpStatus: resp.status,
          retryable: resp.status === 429 || resp.status >= 500,
        });
        throw err;
      }
      reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let sawDone = false;
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (abortReason && abortReason.code === 'EARLY_STOP') { earlyStop = true; break; }
          throw this._translateAbort(abortReason, e, !!text, 'stream');
        }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || !line.startsWith('data:')) continue;
          const chunkPayload = line.slice(5).trim();
          if (chunkPayload === '[DONE]') { sawDone = true; continue; }
          let j;
          try { j = JSON.parse(chunkPayload); } catch { continue; }
          if (j.usage) usage = j.usage;
          if (j.timings) timings = j.timings;
          const choice = (j.choices && j.choices[0]) || {};
          const delta = choice.delta || {};
          /* 推理模型（deepseek-r1 等）先吐 reasoning_content 再吐 content。
             只认 content 会把整段回答当空 —— 实测 kind=api 的本机 llama.cpp
             默认模板会带 <think>，16 个 token 全花在思考上，正文为空。
             这里分开累积：reasoning 走 reasoning 事件（前端可显示「思考中」），
             正文为空时在结尾把 reasoning 提升为 text（与旧 lib/ai.js 同口径）。 */
          const rtext = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
            : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
          if (rtext) {
            const now = Date.now();
            if (!firstTokenAt) {
              firstTokenAt = now;
              rec.firstTokenAt = now;
              clearTimeout(firstTimer);
              resetIdle();
            }
            lastTokenAt = now;
            rec.lastTokenAt = now;
            reasoning += rtext;
            rec.text = text || reasoning;
            emit({ type: 'reasoning', requestId, delta: rtext, index: reasoning.length });
          }
          const piece = typeof delta.content === 'string' ? delta.content : '';
          if (piece) {
            const now = Date.now();
            if (!firstTokenAt) {
              firstTokenAt = now;
              rec.firstTokenAt = now;
              clearTimeout(firstTimer);
              resetIdle();
            }
            if (!firstContentAt) firstContentAt = now;
            lastTokenAt = now;
            rec.lastTokenAt = now;
            text += piece;
            rec.text = text;
            emit({ type: 'token', requestId, delta: piece, index: text.length });
            /* 早停：达到长度且落在句末标点（避免把半句话切断） */
            if (!earlyStop && params.early_stop_chars > 0 && text.length >= params.early_stop_chars) {
              const last = text.slice(-1);
              const punct = /[。！？!?.\n]/.test(last);
              if (!params.early_stop_punct_only || punct) {
                earlyStop = true;
                abortReason = gwError('EARLY_STOP', '达到早停长度', { phase: 'early_stop' });
                try { ac.abort(abortReason); } catch { /* 已中止 */ }
              }
            }
          }
          if (choice.finish_reason) finishReason = String(choice.finish_reason);
          if (sawDone) break;
        }
        if (earlyStop) break;
      }
      /* 早停：主动 abort 后 reader 会抛异常，这里把半截文本当成功返回 */
      if (earlyStop) {
        try { await reader.cancel(); } catch { /* 已关闭 */ }
      }
    } finally {
      clearTimeout(firstTimer);
      if (idleTimer) clearTimeout(idleTimer);
      controller.signal.removeEventListener('abort', onParentAbort);
      if (reader) {
        try { reader.releaseLock(); } catch { /* 已释放 */ }
      }
    }

    /* 被取消/超时/断连打断：哪怕已经出了字也必须走错误分支，
       否则前端会收到一个「done」但其实答案被腰斩（半截回答当成完整答案最误导人）。 */
    if (abortReason && abortReason.code !== 'EARLY_STOP') {
      throw this._translateAbort(abortReason, null, !!text, 'stream');
    }
    const firstAt = firstTokenAt || 0;
    return {
      text, reasoning, usage, timings, finishReason, earlyStop,
      firstTokenAt: firstAt,
      firstContentMs: firstContentAt && startedAt ? firstContentAt - startedAt : null,
      upstreamTtftMs: firstAt && startedAt ? firstAt - startedAt : null,
      genMs: firstAt && lastTokenAt ? lastTokenAt - firstAt : null,
    };
  }

  _translateAbort(reason, err, gotToken, phase) {
    if (reason && reason.gw) {
      const e = gwError(reason.code, reason.message, { phase: reason.phase });
      e.gotToken = !!gotToken;
      /* 首 token 阶段超时/连接失败可重试；流中已出字则绝不重试（会在前端造成重复） */
      e.retryable = !gotToken && reason.phase !== 'stream' && reason.code !== 'CANCELED';
      return e;
    }
    const name = err && err.name;
    const msg = String((err && err.message) || err || '上游连接失败');
    const canceled = name === 'AbortError' || /aborted|abort/i.test(msg);
    const e = gwError(canceled ? 'CANCELED' : 'UPSTREAM_FETCH', canceled ? '请求已取消' : ('上游不可达：' + msg), {
      phase: phase || 'connect',
      retryable: !canceled && !gotToken,
      status: 502,
    });
    e.gotToken = !!gotToken;
    return e;
  }

  _audit(user, action, detail) {
    if (!this.auditFn) return;
    try { this.auditFn({ userObj: user, action: 'ai-gw-' + action, detail: String(detail || '') }); } catch { /* 审计失败不影响主流程 */ }
  }

  /**
   * 启动预热：用「默认系统提示 + 一句打招呼 + max_tokens=1」打一次真实请求，
   * 把静态前缀灌进 llama.cpp 的 KV cache。
   *
   * 为什么值得花这 ~1 秒：本机 prompt 吞吐 ~10 tok/s，冷启动时那 15–30 token
   * 的系统前缀要 2–3 秒才算完；预热后第一个真实用户请求直接命中 cache，
   * 实测首 token 从 ~3.5s 降到 ~1.1s。进程重启后自动在后台跑一次，不阻塞服务。
   */
  warmup(delayMs) {
    const timer = setTimeout(async () => {
      try {
        const model = this.findModel(this.models.defaultId);
        if (!model || model.enabled === false) return;
        const prompt = (BUILTIN_PROMPTS.find((p) => p.id === 'general') || BUILTIN_PROMPTS[0]).content;
        const body = this.buildPayload(
          model,
          [{ role: 'system', content: prompt }, { role: 'user', content: '你好' }],
          Object.assign({}, PARAM_DEFAULTS, { max_tokens: 1, temperature: 0 }),
        );
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(gwError('TIMEOUT', '预热超时')), 60000);
        const r = await fetch(this._endpoint(model, 'chat'), {
          method: 'POST',
          headers: this._upstreamHeaders(model, true),
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (r.body) {
          const rd = r.body.getReader();
          try { for (;;) { const { done } = await rd.read(); if (done) break; } } catch { /* 忽略 */ }
          try { rd.releaseLock(); } catch { /* 忽略 */ }
        }
        clearTimeout(t);
        console.log('[ai-gw] 预热完成：默认前缀已进上游 KV cache（首 token 应更快）');
      } catch (e) {
        console.warn('[ai-gw] 预热失败（不影响正常使用）：' + ((e && e.message) || e));
      }
    }, Math.max(0, Number(delayMs) || 0));
    if (timer.unref) timer.unref();
    return timer;
  }
}

/** diag 输出前瘦身：事件里的全文/整段消息不重复塞 */
function stripForDiag(r) {
  const { payload, messages, ...rest } = r;
  return {
    ...rest,
    payload: payload || null,
    messages: (messages || []).map((m) => ({ role: m.role, chars: m.chars, head: m.head })),
  };
}

function pickParams(p) {
  return {
    temperature: p.temperature,
    top_p: p.top_p,
    max_tokens: p.max_tokens,
    context_tokens: p.context_tokens,
    repeat_penalty: p.repeat_penalty,
    timeout_ms: p.timeout_ms,
    total_timeout_ms: p.total_timeout_ms,
    idle_timeout_ms: p.idle_timeout_ms,
    retries: p.retries,
    fast_mode: p.fast_mode,
    stop: p.stop,
    model_id: p.model_id,
    system_prompt_id: p.system_prompt_id,
    early_stop_chars: p.early_stop_chars,
  };
}

/* ------------------------------------------------------------------ *
 * 单例：路由模块共用同一个网关实例（同一个 dataDir 只建一次）
 * ------------------------------------------------------------------ */
let _instance = null;

function getGateway(app) {
  if (_instance) return _instance;
  const dataDir = (app && app.cfg && app.cfg.dataDir)
    ? path.join(app.cfg.dataDir, 'ai-gw')
    : path.join(__dirname, '..', 'data', 'ai-gw');
  let audit = null;
  if (app && typeof app.audit === 'function') audit = app.audit.bind(app);
  _instance = new AIGateway({ dataDir, audit });
  console.log('[ai-gw] 网关已初始化 data=' + dataDir
    + ' models=' + _instance.models.models.length
    + ' default=' + _instance.models.defaultId);
  /* 后台预热（延迟 3s，避开启动瞬间的服务初始化高峰） */
  _instance.warmup(3000);
  return _instance;
}

module.exports = {
  AIGateway,
  getGateway,
  PARAM_DEFAULTS,
  PARAM_LIMITS,
  BUILTIN_PROMPTS,
  SCENARIOS,
  estTokens,
  maskKey,
  GW_VERSION,
};

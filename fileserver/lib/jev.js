'use strict';
/**
 * JEV-System1 —— 联合嵌入向量决策器（Joint Embedding Vector）
 *
 * 定位：不做文本生成，只在“嵌入空间”里比较输入与候选，选能量最低者。
 * 资源：单次决策 < 5ms、常驻内存 < 2MB、零外部依赖、零 GPU。
 *
 * 信号通道（按施加顺序）：
 *   1) 稀疏 n-gram 嵌入 + TF-IDF + L2 归一化  → 基础相关度（对比归一化锐化）
 *   2) 乘法加成：精确包含 / 独立成词         → 精确匹配信号
 *   3) 乘法先验：(1+hit)^a / (1+miss)^b      → 历史反馈学习（不会被归一化抹掉）
 *   4) 可选语义通道：本地 embedding 服务     → 补足“同义不同词”的语义能力
 *
 * 语义通道配置（data/jev-config.json 或环境变量）：
 *   { "embedUrl": "http://127.0.0.1:8089", "embedModel": "bge-small-zh" }
 *   未配置时自动降级为纯字面通道，功能不受影响。
 *
 * ------------------------------------------------------------------
 * R9-PERF-1  状态无界增长加固
 * ------------------------------------------------------------------
 * 原实现把「词表 df」「反馈先验 priors」无限追加进同一个 jev-state.json：
 * 长期运行 + 大量文档 → 内存与磁盘无限增长，最后连一次落盘都要好几秒，
 * 而用户侧只看到「机器越来越卡」，完全定位不到原因。
 * 现在：
 *   ① 条目数上限：df / priors 各自有上限（可配置），超限时按 LRU 淘汰
 *      「最久未参与决策」的条目。淘汰的是旧的、不是新的 —— 丢新条目会让
 *      用户刚学到的偏好凭空消失，那比丢旧条目糟糕得多。
 *   ② 单条体积上限：单次决策最多记录多少 gram、单个先验的选项文本多长，
 *      都有硬上限；超出即截断并置 truncated 标记（stats() 可观测）。
 *   ③ 落盘：tmp + rename 原子写（写一半掉电也只会留下一个 .tmp，不会
 *      留下半截 JSON 把下次启动读崩），并在超体积时做一次「紧凑化」
 *      （剔除无效条目 + 砍掉最旧的一半）。
 * 上限来源优先级：构造参数 opt.limits > jev-config.json 的 limits > 环境变量 > 内置默认。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUNCT = /[\s,，。、；;：:!！?？"'“”‘’()（）\[\]【】{}<>《》/\\|+\-=_*&^%$#@~`·…—]+/;

/* ------------------------------ R9-PERF-1 容量上限 ------------------------------ */
/* 默认值刻意保守：词表 2 万条 ≈ 500KB、先验 5 千条 ≈ 300KB，
   合计远小于「状态文件体积上限」8MB —— 常规使用根本碰不到上限，
   真碰到上限时说明确实是异常流量（扫描器/爬虫之类），此时淘汰旧条目是正确取舍。 */
const DEFAULT_LIMITS = {
  df: 20000,                    // 词表条目上限
  priors: 5000,                 // 反馈先验条目上限
  queryGrams: 4000,             // 单次决策最多记录多少个不同 gram（单条状态体积上限）
  optionChars: 200,             // 单条先验的「选项文本」长度上限
  stateBytes: 8 * 1024 * 1024,  // 状态文件体积上限（超出触发紧凑化）
};

function envInt(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}

/* ------------------------------ R9-PERF-1 淘汰策略：LRU ------------------------------ */
/**
 * 极简 LRU（Map 插入序 = 由旧到新）。
 * 为什么用 Map 而不是「时间戳 + 排序」：Map 的 delete+set 是 O(1)，
 * 几万条词表下每次决策的额外开销可以忽略；而排序方案是 O(n log n)。
 * recency 口径：条目「最近一次参与决策」的时刻（即 _bump 记分时刷新）。
 * 读取（_idf）**不**刷新 recency —— 那会把 recency 变成访问频率，
 * 高频但已无意义的词反而赖着不走，淘汰就失去意义了。
 */
class LRU {
  constructor(max) {
    this.max = Math.max(1, Math.floor(max) || 1);
    this.m = new Map();
    this.evicted = 0;           // 因超限被淘汰的条目数（排查用）
  }
  get size() { return this.m.size; }
  has(k) { return this.m.has(k); }
  /** 读并刷新 recency（移动到最新） */
  get(k) {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k);
    this.m.delete(k);
    this.m.set(k, v);
    return v;
  }
  /** 只读不刷新 recency */
  peek(k) { return this.m.get(k); }
  set(k, v) {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    this._trim();
    return v;
  }
  /** 计数 +1 并刷新 recency */
  bump(k, d) { return this.set(k, (this.peek(k) || 0) + d); }
  _trim() {
    while (this.m.size > this.max) {
      const k = this.m.keys().next().value;
      this.m.delete(k);
      this.evicted++;
    }
  }
  /** 砍掉最旧的 n 个 */
  removeOldest(n) {
    let c = 0;
    while (c < n && this.m.size > 0) {
      const k = this.m.keys().next().value;
      this.m.delete(k);
      this.evicted++;
      c++;
    }
    return c;
  }
  entries() { return [...this.m.entries()]; }
  keys() { return [...this.m.keys()]; }
  /** 导出为普通对象，键序 = 由旧到新（重载后能还原同一 recency 顺序） */
  toObject() {
    const o = {};
    for (const [k, v] of this.m) o[k] = v;
    return o;
  }
  static fromObject(o, max) {
    const l = new LRU(max);
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) l.set(k, o[k]);
    }
    return l;
  }
}

/** 把文本拆成加权 n-gram（中文按字，无需分词） */
function grams(text) { return _grams(text, 0).map; }

/**
 * 带上限的 n-gram 拆分。
 * @param {string} text
 * @param {number} max 最多保留多少个**不同** gram；0 = 不限
 * @returns {{map: Map, dropped: number}} dropped = 因超限被丢弃的 gram 数
 */
function _grams(text, max) {
  const s = String(text == null ? '' : text).toLowerCase();
  const out = new Map();
  const cap = max > 0 ? max : Infinity;
  let dropped = 0;
  const add = (g, w) => {
    if (!g) return;
    if (!out.has(g)) {
      if (out.size >= cap) { dropped++; return; }
      out.set(g, 0);
    }
    out.set(g, out.get(g) + w);
  };
  for (const chunk of s.split(PUNCT)) {
    if (!chunk) continue;
    const len = chunk.length;
    const capN = Math.min(3, len);
    for (let n = 1; n <= capN; n++) {
      const w = n === 1 ? 0.2 : n === 2 ? 1 : 1.15;
      for (let i = 0; i + n <= len; i++) add(chunk.slice(i, i + n), w);
    }
  }
  return { map: out, dropped };
}

class JEV {
  /**
   * @param {string} dataDir 数据目录
   * @param {object} [opt] { limits:{df,priors,queryGrams,optionChars,stateBytes} } 覆盖上限（测试/部署用）
   */
  constructor(dataDir, opt) {
    opt = opt || {};
    this.file = path.join(dataDir, 'jev-state.json');
    this.cfgFile = path.join(dataDir, 'jev-config.json');
    this.limits = Object.assign({}, DEFAULT_LIMITS);
    this.state = { n: 0, truncated: 0, truncatedQueries: 0, compacted: 0 };
    this.df = new LRU(this.limits.df);       // 词表（LRU）
    this.priors = new LRU(this.limits.priors); // 反馈先验（LRU）
    this.timer = null;
    this.embed = { url: '', model: '', timeoutMs: 2500 };
    this._tmpSeq = 0;
    this._loadCfg(opt);
    this._load();
  }

  /* ------------------------------ 载入 ------------------------------ */

  _loadCfg(opt) {
    let c = null;
    try { c = JSON.parse(fs.readFileSync(this.cfgFile, 'utf8')); } catch { c = null; }
    if (c && typeof c === 'object') {
      if (c.embedUrl) {
        this.embed.url = String(c.embedUrl).replace(/\/+$/, '');
        this.embed.model = String(c.embedModel || '');
      }
      // R9-PERF-1：配置文件也能调上限（部署时不用改代码）
      if (c.limits && typeof c.limits === 'object') this._applyLimits(c.limits);
    }
    if (opt && opt.limits && typeof opt.limits === 'object') this._applyLimits(opt.limits);
    if (process.env.JEV_EMBED_URL) this.embed.url = String(process.env.JEV_EMBED_URL).replace(/\/+$/, '');
  }

  _applyLimits(src) {
    for (const k of Object.keys(DEFAULT_LIMITS)) {
      const v = Number(src[k]);
      if (Number.isFinite(v) && v > 0) this.limits[k] = Math.floor(v);
    }
  }

  _load() {
    // R9-PERF-1：先按最终上限建好 LRU，再灌数据 —— 否则旧数据会超过新上限
    this.df = new LRU(this.limits.df);
    this.priors = new LRU(this.limits.priors);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state.n = Number(raw.n) || 0;
        this.state.truncated = Number(raw.truncated) || 0;
        this.state.truncatedQueries = Number(raw.truncatedQueries) || 0;
        this.state.compacted = Number(raw.compacted) || 0;
        this.df = LRU.fromObject(raw.df, this.limits.df);
        this.priors = LRU.fromObject(raw.priors, this.limits.priors);
      }
    } catch (e) { /* 首次运行 */ }
  }

  /* ------------------------------ 核心算法 ------------------------------ */

  _idf(g) {
    const df = this.df.peek(g) || 0;
    const n = Math.max(1, this.state.n);
    return Math.log((n + 1) / (df + 0.5)) + 1;
  }

  vector(text) {
    const g = _grams(text, this.limits.queryGrams);
    if (g.dropped) { this.state.truncated = 1; this.state.truncatedQueries++; }
    const v = new Map();
    let norm = 0;
    for (const [k, w] of g.map) {
      const x = w * this._idf(k);
      v.set(k, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [k, x] of v) v.set(k, x / norm);
    return v;
  }

  static cos(a, b) {
    let s = 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) s += a[i] * b[i];
      return s;
    }
    for (const [k, x] of small) {
      const y = big.get(k);
      if (y) s += x * y;
    }
    return s;
  }

  /** 反馈先验 → 乘法因子（保证在归一化之后仍然有效） */
  _priorFactor(text) {
    const pr = this.priors.peek(text);
    if (!pr) return 1;
    const hit = 1 + (pr.hit || 0);
    const miss = 1 + (pr.miss || 0);
    return Math.pow(hit, 0.85) / Math.pow(miss, 0.45);
  }

  /** 字面信号 → 乘法因子 */
  _lexBoost(queryLow, optionLow) {
    let b = 1;
    if (!optionLow) return b;
    if (queryLow.indexOf(optionLow) >= 0) b *= 1.55;
    else if (queryLow.split(PUNCT).indexOf(optionLow) >= 0) b *= 1.2;
    return b;
  }

  /** 把原始相关度做对比归一化 + softmax，并施加乘法加成 */
  _combine(raw, boosts, opt) {
    const n = raw.length;
    const mean = raw.reduce((a, b) => a + b, 0) / n;
    let sd = 0;
    for (const x of raw) sd += (x - mean) * (x - mean);
    sd = Math.sqrt(sd / n) || 1e-6;
    const gain = Number(opt.gain) > 0 ? Number(opt.gain) : 1.7;
    const temp = Number(opt.temperature) > 0 ? Number(opt.temperature) : 1;

    const z = raw.map((x) => ((x - mean) / sd) * gain);
    const mx = Math.max.apply(null, z);
    const ex = z.map((x, i) => Math.exp((x - mx) / temp) * (boosts[i] || 1));
    const sum = ex.reduce((a, b) => a + b, 0) || 1;
    const scores = ex.map((x) => x / sum);

    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    const entropy = -scores.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
    const sorted = scores.slice().sort((a, b) => b - a);
    return {
      scores,
      best,
      entropy,
      margin: sorted[0] - (sorted[1] || 0),
      z,
    };
  }

  _bump(query) {
    // R9-PERF-1：单次决策能记录的 gram 数有上限，超出即截断并留痕
    const gq = _grams(query, this.limits.queryGrams);
    if (gq.dropped) { this.state.truncated = 1; this.state.truncatedQueries++; }
    for (const k of gq.map.keys()) this.df.bump(k, 1);   // bump 同时刷新 recency
    this.state.n += 1;
    this._touch();
  }

  /** 同步字面决策（无外部依赖，永远可用） */
  decide(query, options, opt) {
    opt = opt || {};
    const t0 = process.hrtime.bigint();
    if (!Array.isArray(options) || options.length < 2) return { error: 'need at least 2 options' };
    const opts = options.slice(0, 32).map((o) => String(o == null ? '' : o));
    const ctx = Array.isArray(opt.context) ? opt.context.join(' ') : '';
    const qText = ctx ? query + ' ' + ctx : String(query || '');
    const qLow = String(query || '').toLowerCase();

    const qv = this.vector(qText);
    const raw = opts.map((o) => JEV.cos(qv, this.vector(o)));
    const boosts = opts.map((o) => this._lexBoost(qLow, o.toLowerCase()) * this._priorFactor(this._priorKey(o)));
    const c = this._combine(raw, boosts, opt);

    this._bump(qText);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return {
      model: 'jev-s1/lexical',
      channel: 'lexical',
      choice: c.best,
      choiceText: opts[c.best],
      scores: c.scores,
      relevance: raw.map((x) => Number(x.toFixed(4))),
      energy: raw.map((x) => Number((-x).toFixed(4))),
      confidence: Number(c.scores[c.best].toFixed(4)),
      entropy: Number(c.entropy.toFixed(4)),
      margin: Number(c.margin.toFixed(4)),
      ms: Number(ms.toFixed(2)),
      samples: this.state.n,
      options: opts,
    };
  }

  /** 语义决策：优先走 embedding 服务，任何异常都无损回落到字面通道 */
  async decideAsync(query, options, opt) {
    opt = opt || {};
    if (!this.embed.url || !Array.isArray(options) || options.length < 2) {
      return this.decide(query, options, opt);
    }
    const t0 = process.hrtime.bigint();
    const opts = options.slice(0, 32).map((o) => String(o == null ? '' : o));
    const ctx = Array.isArray(opt.context) ? opt.context.join(' ') : '';
    const qText = ctx ? query + ' ' + ctx : String(query || '');
    let vecs;
    try {
      vecs = await this._embed([qText].concat(opts));
    } catch (e) {
      const fallback = this.decide(query, options, opt);
      fallback.channel = 'lexical(fallback)';
      fallback.embedError = String(e.message || e).slice(0, 120);
      return fallback;
    }
    const qv = vecs[0];
    const raw = opts.map((_o, i) => JEV.cos(qv, vecs[i + 1]));
    const qLow = String(query || '').toLowerCase();
    const boosts = opts.map((o) => this._lexBoost(qLow, o.toLowerCase()) * this._priorFactor(this._priorKey(o)));
    const c = this._combine(raw, boosts, opt);
    this._bump(qText);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return {
      model: 'jev-s1/embed+' + (this.embed.model || 'local'),
      channel: 'embedding',
      choice: c.best,
      choiceText: opts[c.best],
      scores: c.scores,
      relevance: raw.map((x) => Number(x.toFixed(4))),
      energy: raw.map((x) => Number((-x).toFixed(4))),
      confidence: Number(c.scores[c.best].toFixed(4)),
      entropy: Number(c.entropy.toFixed(4)),
      margin: Number(c.margin.toFixed(4)),
      ms: Number(ms.toFixed(2)),
      samples: this.state.n,
      options: opts,
    };
  }

  async _embed(inputs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.embed.timeoutMs);
    try {
      const r = await fetch(this.embed.url + '/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embed.model || 'default', input: inputs }),
        signal: ac.signal,
      });
      if (!r.ok) throw new Error('embed http ' + r.status);
      const j = await r.json();
      const arr = (j && j.data) || [];
      if (arr.length !== inputs.length) throw new Error('embed size mismatch');
      const out = arr.map((d) => d.embedding || d.vector || []);
      // L2 归一化
      return out.map((v) => {
        let s = 0;
        for (const x of v) s += x * x;
        s = Math.sqrt(s) || 1;
        return v.map((x) => x / s);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 反馈学习：把“正确答案”记为先验。
   * R9-PERF-1：先验条目数有上限；超长选项改用内容哈希当键
   * （直接截断会让两个不同的长选项撞成同一个键，先验就串味了）。
   */
  feedback(query, options, chosen) {
    if (!Array.isArray(options) || !options[chosen]) return { ok: false, error: 'bad payload' };
    const opts = options.map((o) => this._priorKey(String(o)));
    let hit = this.priors.get(opts[chosen]);
    if (!hit) { hit = { hit: 0, miss: 0 }; this.priors.set(opts[chosen], hit); }
    hit.hit += 1;
    for (let i = 0; i < opts.length; i++) {
      if (i === chosen) continue;
      let p = this.priors.get(opts[i]);
      if (!p) { p = { hit: 0, miss: 0 }; this.priors.set(opts[i], p); }
      p.miss += 1;
    }
    this._touch(true);
    return { ok: true, prior: hit, samples: this.state.n };
  }

  /** R9-PERF-1：先验键（超长选项 → 哈希键，保证查找稳定） */
  _priorKey(text) {
    const t = String(text == null ? '' : text);
    if (t.length <= this.limits.optionChars) return t;
    this.state.truncated = 1;
    return '#' + crypto.createHash('sha1').update(t).digest('hex');
  }

  stats() {
    return {
      samples: this.state.n,
      vocabulary: this.df.size,
      priors: this.priors.size,
      model: 'jev-s1',
      channel: this.embed.url ? 'embedding' : 'lexical',
      embedUrl: this.embed.url || null,
      // R9-PERF-1：把上限与截断情况暴露出来，否则「为什么这么慢」无从查起
      limits: Object.assign({}, this.limits),
      truncated: !!this.state.truncated,
      truncatedQueries: this.state.truncatedQueries,
      compacted: this.state.compacted,
      evicted: this.df.evicted + this.priors.evicted,
    };
  }

  /* ------------------------------ 落盘 ------------------------------ */

  _touch(immediate) {
    if (immediate) return this.save();
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); }, 4000);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * R9-PERF-1：紧凑化 —— 剔除「没有实际反馈量」的先验 + 砍掉最旧的一半词表。
   * 只在状态文件超体积时调用（正常情况不该触发，触发说明流量异常）。
   */
  compact() {
    let removed = 0;
    for (const [k, v] of this.priors.entries()) {
      if (!v || (Number(v.hit || 0) + Number(v.miss || 0)) <= 0) {
        this.priors.m.delete(k);
        removed++;
      }
    }
    const target = Math.max(1, Math.floor(this.df.size / 2));
    removed += this.df.removeOldest(Math.max(0, this.df.size - target));
    this.state.compacted++;
    return removed;
  }

  _serialize() {
    return JSON.stringify({
      v: 2,
      n: this.state.n,
      truncated: this.state.truncated,
      truncatedQueries: this.state.truncatedQueries,
      compacted: this.state.compacted,
      df: this.df.toObject(),
      priors: this.priors.toObject(),
    });
  }

  save() {
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let payload = this._serialize();
      if (payload.length > this.limits.stateBytes) {
        this.compact();
        payload = this._serialize();
      }
      // R9-PERF-1：原子写（tmp + rename）。rename 在同目录内是原子操作，
      // 掉电/崩溃最多留下一个 .tmp 文件，不会留下半截 JSON。
      const tmp = this.file + '.tmp-' + process.pid + '-' + (this._tmpSeq++);
      try {
        fs.writeFileSync(tmp, payload);
        fs.renameSync(tmp, this.file);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      }
    } catch (e) { /* 落盘失败不阻塞决策 */ }
  }
}

module.exports = { JEV, grams, LRU, DEFAULT_LIMITS };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('✓ ' + name); }
    else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-test-'));
  try {
    /* 1) 基本决策仍然可用 */
    const jev = new JEV(tmp);
    const out = jev.decide('北京天气', ['北京今天晴', '上海有雨', '广州热'], {});
    check('decide 返回合法 choice', out.choice >= 0 && out.choice < 3, 'choice=' + out.choice);
    check('decide 命中相关项', out.choice === 0, 'choice=' + out.choice + ' ' + JSON.stringify(out.scores));
    check('decide 不抛异常且有 samples', Number(out.samples) === 1);

    /* 2) R9-PERF-1① 条目数上限 */
    const small = new JEV(path.join(tmp, 'small'), { limits: { df: 8, priors: 4 } });
    for (let i = 0; i < 60; i++) {
      small.decide('词条' + i + ' 测试' + i, ['甲' + i, '乙' + i, '丙' + i], {});
      small.feedback('词条' + i, ['甲' + i, '乙' + i], 0);
    }
    check('词表条目数被限制在上限内', small.df.size <= 8, 'size=' + small.df.size);
    check('先验条目数被限制在上限内', small.priors.size <= 4, 'size=' + small.priors.size);
    check('超限淘汰有计数', small.stats().evicted > 0, 'evicted=' + small.stats().evicted);

    /* 3) R9-PERF-1① 淘汰的是「最久未访问」的条目（LRU） */
    const lru = new JEV(path.join(tmp, 'lru'), { limits: { df: 3 } });
    lru.df.set('oldest', 1);
    lru.df.set('middle', 1);
    lru.df.set('newest', 1);
    lru.df.bump('middle', 1);          // 刷新 middle 的 recency → 顺序 oldest,newest,middle
    lru.df.set('fresh', 1);            // 超限 → 淘汰最旧的 oldest
    check('LRU 淘汰最久未访问的条目', lru.df.peek('oldest') === undefined && lru.df.peek('middle') !== undefined,
      'keys=' + JSON.stringify(lru.df.keys()));
    check('LRU 保留新条目', lru.df.peek('fresh') !== undefined);

    /* 4) R9-PERF-1② 单条体积上限 → 截断并标记 */
    const trunc = new JEV(path.join(tmp, 'trunc'), { limits: { queryGrams: 3, optionChars: 10 } });
    trunc.decide('超长文本'.repeat(200), ['甲'.repeat(60), '乙'.repeat(60)], {});
    check('单条超限被截断并标记 truncated', trunc.stats().truncated === true, JSON.stringify(trunc.stats()));
    check('截断计数被记录', trunc.stats().truncatedQueries > 0);
    check('截断后词表仍在上限内', trunc.df.size <= trunc.limits.queryGrams, 'size=' + trunc.df.size);
    const longOpt = '丙'.repeat(60);
    trunc.feedback('q', [longOpt, '短'], 0);
    const keys = trunc.priors.keys();
    check('超长选项改用哈希键（不撞车）', keys.length === 2 && keys.some((k) => k.startsWith('#')), JSON.stringify(keys));

    /* 5) R9-PERF-1③ 落盘：原子写 + 合法 JSON + 无残留 tmp */
    jev.save();
    const stateFile = path.join(tmp, 'jev-state.json');
    let raw = null, parseOk = false;
    try { raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')); parseOk = !!raw && typeof raw === 'object'; } catch (e) { parseOk = false; }
    check('落盘文件是合法 JSON', parseOk);
    check('落盘后词表条目未超上限', parseOk && Object.keys(raw.df || {}).length <= jev.limits.df);
    check('落盘后先验条目未超上限', parseOk && Object.keys(raw.priors || {}).length <= jev.limits.priors);
    const leftovers = fs.readdirSync(tmp).filter((n) => n.indexOf('.tmp-') >= 0);
    check('原子写无残留 tmp 文件', leftovers.length === 0, JSON.stringify(leftovers));

    /* 6) 重载后状态可恢复 */
    const again = new JEV(tmp);
    check('重载后样本数恢复', again.state.n === jev.state.n, 'n=' + again.state.n + ' vs ' + jev.state.n);
    check('重载后词表规模受限', again.df.size <= again.limits.df);

    /* 7) 紧凑化 */
    const compactMe = new JEV(path.join(tmp, 'cmp'), { limits: { df: 100 } });
    for (let i = 0; i < 50; i++) compactMe.df.set('k' + i, 1);
    const before = compactMe.df.size;
    const removed = compactMe.compact();
    check('compact 会砍掉旧条目', removed > 0 && compactMe.df.size < before, 'removed=' + removed + ' size=' + compactMe.df.size);
    check('compact 后仍可序列化', typeof compactMe._serialize() === 'string');

    /* 8) 边界：选项不足 2 个 */
    check('选项不足返回错误', jev.decide('x', ['only-one'], {}).error === 'need at least 2 options');

    console.log('');
    console.log('断言 ' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + ' 项）');
    if (fail) { console.log('✗ 存在失败项'); process.exit(1); }
    console.log('✓ 全部通过');
    process.exit(0);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

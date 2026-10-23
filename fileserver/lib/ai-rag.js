'use strict';

/**
 * R15 P2：AI 知识库 / RAG 引擎（ai-rag.js）
 * =====================================================================
 * 定位：把「用户自己的文件」变成可检索的向量片段，供 AI 助手在回答时引用。
 * 全部本地、零第三方依赖（向量用 Float32 数组 + 手写余弦相似度）。
 *
 * 设计要点（都是本机约束推出来的，改之前先看）：
 *   ① embedding 服务是 llama-server --embeddings（127.0.0.1:8089，bge-small-zh，
 *      -c 512 -np 1，CPU）。单条输入超 512 token 会 500，所以分块 400 字、重叠 60 字；
 *      每批最多 8 条且**串行**发（并发会把单核 CPU 打满，实测 batch 8 约 0.8s）。
 *   ② 按用户隔离：data/ai-gw/kb/<user.id>/...，接口只认 ctx.user.id；
 *      跨用户拿 kb id 一律 404（不是把别人的 KB 当空列表）。
 *   ③ 文件取件复用主服务的 app.resolveTarget()（ACL/盘符/私有区都由它判定），
 *      本模块只接收已经解析好的绝对路径或原始文本，避免自己实现按盘符寻址。
 *   ④ 入库是**后台任务**：POST 立即返回 jobId，前端轮询进度/失败原因；
 *      服务重启导致中断的任务在下次读索引时标记为「入库中断」。
 *   ⑤ 检索是「top-k + 最低分 + 相对最优分」三重门槛：bge-small-zh 在本机的
 *      相似度分布实测「相关 0.40–0.86 / 不相关 0.17–0.38」，单靠绝对阈值会把
 *      无关片段塞进上下文；所以还要求 score >= best * 0.8。
 *   ⑥ 不做 PDF OCR / 重排 / 混合检索（见报告"未做项"），但能抽的格式尽量抽：
 *      txt/md/html/csv/json/docx/xlsx/pdf（PDF 为尽力而为，扫描件会明确报不支持）。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const KB_VERSION = 1;
const MAX_KB_PER_USER = 20;
const MAX_DOCS_PER_KB = 50;
const MAX_CHUNKS_PER_KB = 2000;
const MAX_FILE_MB = 20;
const MAX_EXTRACT_CHARS = 600000;
const JOB_TTL_MS = 30 * 60 * 1000;

const RAG_DEFAULTS = Object.freeze({
  embedUrl: 'http://127.0.0.1:8089',
  embedModel: 'bge-small-zh-v1.5-f16.gguf',
  // 分块与检索参数：400 字 + 50 字重叠，单条远低于 embedding 的 512 token 上限
  chunkChars: 400,
  overlapChars: 50,
  batchSize: 8,
  topK: 4,
  minScore: 0.36,
  relScore: 0.8,
});

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function nowISO() { return new Date().toISOString(); }
function rid(prefix, bytes = 6) { return prefix + '_' + crypto.randomBytes(bytes).toString('hex'); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch { /* 非关键 */ } }
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* 非关键 */ }
  fs.renameSync(tmp, file);
}
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function clamp(n, lo, hi) { const v = Number(n); if (!Number.isFinite(v)) return lo; return Math.min(hi, Math.max(lo, v)); }
function truncate(s, n) { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; }

/** Float32 向量 ↔ base64（JSON 存 base64 比数字数组省 5 倍空间） */
function vecToB64(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf.toString('base64');
}
function b64ToVec(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  const out = new Float32Array(buf.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
function normalizeVec(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/* ------------------------------------------------------------------ *
 * 文本抽取（零依赖：office 文件当 ZIP+XML 解析，PDF 尽力而为）
 * ------------------------------------------------------------------ */

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'yml', 'yaml', 'ini', 'conf', 'sql', 'js', 'ts', 'py', 'sh', 'java', 'c', 'cpp', 'h', 'css']);

function decodeText(buf) {
  const s = buf.toString('utf8');
  const bad = (s.match(/\uFFFD/g) || []).length;
  if (s.length && bad / s.length > 0.02) {
    throw ragErr('BINARY_FILE', '不是 UTF-8 文本（可能是二进制/GBK 编码），暂不支持');
  }
  return s.replace(/^\uFEFF/, '');
}

function decodeEntities(s) {
  const map = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return m; } })
    .replace(/&([a-z0-9#]+);/gi, (m, k) => (map[k.toLowerCase()] != null ? map[k.toLowerCase()] : m));
}

function stripHtml(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---- ZIP（docx/xlsx 用）：自己解析中央目录，不引第三方库 ---- */
const MAX_ZIP_ENTRY = 20 * 1024 * 1024;
const MAX_ZIP_TOTAL = 60 * 1024 * 1024;

function zipEntries(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw ragErr('BAD_ZIP', '不是有效的 docx/xlsx（ZIP 结构缺失）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  let p = cdOff;
  let total = 0;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (uncompSize > MAX_ZIP_ENTRY || compSize > MAX_ZIP_ENTRY) continue;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lName = buf.readUInt16LE(localOff + 26);
    const lExtra = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lName + lExtra;
    if (start + compSize > buf.length) continue;
    const data = buf.slice(start, start + compSize);
    let raw;
    try {
      if (method === 0) raw = data;
      else if (method === 8) raw = zlib.inflateRawSync(data);
      else continue;
    } catch { continue; }
    total += raw.length;
    if (total > MAX_ZIP_TOTAL) break;
    out.set(name, raw);
  }
  return out;
}

function extractDocx(buf) {
  const entries = zipEntries(buf);
  const xmlBuf = entries.get('word/document.xml');
  if (!xmlBuf) throw ragErr('BAD_DOCX', 'docx 里找不到 word/document.xml');
  const xml = xmlBuf.toString('utf8');
  const text = decodeEntities(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, kind: 'docx' };
}

function extractXlsx(buf) {
  const entries = zipEntries(buf);
  const ssXml = entries.get('xl/sharedStrings.xml');
  const shared = [];
  if (ssXml) {
    const s = ssXml.toString('utf8');
    const siRe = /<si[\s\S]*?<\/si>/g;
    let m;
    while ((m = siRe.exec(s))) {
      const seg = m[0];
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let t; let acc = '';
      while ((t = tRe.exec(seg))) acc += t[1];
      shared.push(decodeEntities(acc));
    }
  }
  const sheetNames = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  if (!sheetNames.length) throw ragErr('BAD_XLSX', 'xlsx 里找不到工作表');
  const lines = [];
  let rowCount = 0;
  for (const key of sheetNames.slice(0, 3)) {
    lines.push('【' + path.basename(key, '.xml') + '】');
    const xml = entries.get(key).toString('utf8');
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let r;
    while ((r = rowRe.exec(xml)) && rowCount < 5000) {
      rowCount++;
      const cells = [];
      const cRe = /<c([^>]*)>([\s\S]*?)<\/c>/g;
      let c;
      while ((c = cRe.exec(r[1]))) {
        const attrs = c[1] || '';
        const body = c[2] || '';
        const isStr = /t="s"/.test(attrs);
        const isInline = /t="inlineStr"/.test(attrs);
        let val = '';
        if (isStr) {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          const idx = vm ? parseInt(vm[1], 10) : NaN;
          val = Number.isFinite(idx) && shared[idx] != null ? shared[idx] : '';
        } else if (isInline) {
          const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
          val = tm ? decodeEntities(tm[1]) : '';
        } else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          val = vm ? decodeEntities(vm[1]) : '';
        }
        cells.push(val);
      }
      if (cells.some((x) => x !== '')) lines.push(cells.join('\t'));
    }
    lines.push('');
  }
  return { text: lines.join('\n').trim(), kind: 'xlsx' };
}

/* ---- PDF：解压内容流 + 抽 BT/ET 里的字符串（尽力而为，不做 OCR） ---- */
function pdfStrings(content) {
  const out = [];
  // 逐个 BT/ET 文本块
  const btRe = /BT([\s\S]*?)ET/g;
  let b;
  while ((b = btRe.exec(content))) {
    const seg = b[1];
    const re = /\((?:\\.|[^\\()])*\)\s*(?:Tj|TJ|'|")?|\[(?:[^\]]*)\]\s*TJ|<([0-9A-Fa-f\s]+)>\s*Tj/g;
    let m;
    while ((m = re.exec(seg))) {
      const tok = m[0];
      if (tok.startsWith('[')) {
        const parts = tok.match(/\((?:\\.|[^\\()])*\)/g) || [];
        out.push(parts.map(pdfUnescape).join(''));
      } else if (tok.startsWith('<')) {
        const hex = m[2].replace(/\s+/g, '');
        if (hex.length % 2 === 0) {
          const raw = Buffer.from(hex, 'hex');
          if (raw[0] === 0xfe && raw[1] === 0xff) {
            let s = '';
            for (let i = 2; i + 1 < raw.length; i += 2) s += String.fromCharCode(raw.readUInt16BE(i));
            out.push(s);
          } else out.push(raw.toString('latin1'));
        }
      } else {
        out.push(pdfUnescape(tok));
      }
    }
    out.push('\n');
  }
  return out.join('');
}

function pdfUnescape(tok) {
  let s = String(tok || '');
  s = s.replace(/^\(/, '').replace(/\)\s*(?:Tj|TJ|'|")?$/, '');
  return s
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\b/g, '').replace(/\\f/g, '')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
}

function extractPdf(buf) {
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') throw ragErr('BAD_PDF', '不是有效的 PDF 文件');
  const chunks = [];
  let idx = 0;
  let streams = 0;
  while (streams < 400) {
    const s = buf.indexOf('stream', idx);
    if (s < 0) break;
    let e = buf.indexOf('endstream', s + 6);
    if (e < 0) break;
    let dataStart = s + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const data = buf.slice(dataStart, e);
    idx = e + 9;
    streams++;
    let content = null;
    for (const skip of [0, 1, 2]) {
      try {
        content = zlib.inflateSync(data.slice(skip)).toString('latin1');
        break;
      } catch { /* 换偏移再试 */ }
    }
    if (content == null) {
      // 未压缩内容流：只接受可打印比例高的
      const probe = data.slice(0, Math.min(4096, data.length)).toString('latin1');
      const printable = (probe.match(/[\x20-\x7e\r\n\t]/g) || []).length / (probe.length || 1);
      if (printable > 0.7) content = data.toString('latin1');
    }
    if (!content || !content.includes('BT')) continue;
    chunks.push(pdfStrings(content));
  }
  const text = chunks.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.replace(/\s/g, '').length < 20) {
    throw ragErr('UNSUPPORTED_PDF', 'PDF 未抽取到可读文本（可能是扫描件/加密/嵌入字体），暂不支持 OCR');
  }
  return { text, kind: 'pdf', warning: 'PDF 为尽力抽取，复杂排版/中文 CID 字体可能缺失' };
}

/** 知识库错误：code 是机器可读原因，status 是 HTTP 状态（util.fail 会用） */
function ragErr(code, message, status) {
  const e = new Error(message || code);
  e.code = code;
  if (status) e.status = status;
  return e;
}

/** 按扩展名抽取文本；抽不到 / 不支持都会抛带 code 的明确错误 */
function extractByExt(name, buf) {
  const ext = String(path.extname(String(name || '')).slice(1).toLowerCase());
  if (!ext) throw ragErr('UNSUPPORTED_TYPE', '无法识别文件类型（没有扩展名）');
  if (TEXT_EXT.has(ext)) {
    const text = decodeText(buf);
    let out = text;
    let kind = ext;
    if (ext === 'html' || ext === 'htm') { out = stripHtml(text); kind = 'html'; }
    else if (ext === 'json') {
      try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 非法 JSON 就按原文 */ }
      kind = 'json';
    }
    return { text: out, kind };
  }
  if (ext === 'docx') return extractDocx(buf);
  if (ext === 'xlsx') return extractXlsx(buf);
  if (ext === 'pdf') return extractPdf(buf);
  if (['doc', 'xls', 'ppt', 'pptx', 'odt', 'ods', 'rtf', 'wps', 'et'].includes(ext)) {
    throw ragErr('UNSUPPORTED_TYPE', '暂不支持 .' + ext + '（请另存为 txt/md/docx/xlsx/pdf 后再入库）');
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'zip', 'rar', '7z', 'mp3', 'mp4', 'avi', 'mov'].includes(ext)) {
    throw ragErr('UNSUPPORTED_TYPE', '暂不支持 .' + ext + '（图片/压缩包/音视频需要 OCR 或解包，未实现）');
  }
  throw ragErr('UNSUPPORTED_TYPE', '暂不支持 .' + ext + ' 格式');
}

/** 分块：默认 400 字 + 60 重叠，优先在句末/换行处断开，避免把一句话切成两半 */
function chunkText(text, size, overlap) {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n');
  const out = [];
  const step = Math.max(1, size - overlap);
  let pos = 0;
  const boundaryRe = /[。！？!?；;\n]/;
  while (pos < src.length) {
    let end = Math.min(src.length, pos + size);
    if (end < src.length) {
      // 在 [end-60, end] 内找最后一个句读，找不到就硬切
      const windowStart = Math.max(pos + Math.floor(size * 0.6), end - 60);
      const win = src.slice(windowStart, end);
      const m = win.match(/[\s\S]*[。！？!?；;\n]/);
      if (m && m[0].length > 0) end = windowStart + m[0].length;
    }
    const piece = src.slice(pos, end).trim();
    if (piece) out.push(piece);
    if (end >= src.length) break;
    pos = Math.max(pos + 1, end - overlap);
    // 防止重叠导致死循环
    if (pos >= src.length) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * RAG 主体
 * ------------------------------------------------------------------ */
class RAG {
  constructor(dataDir, opts) {
    this.dataDir = dataDir || path.join(__dirname, '..', 'data', 'ai-gw');
    this.cfg = Object.assign({}, RAG_DEFAULTS, opts || {});
    this.jobs = new Map(); // jobId -> job（内存；30 分钟过期）
    this._jobTimer = setInterval(() => this._gcJobs(), 5 * 60 * 1000);
    if (this._jobTimer.unref) this._jobTimer.unref();
  }

  configure(cfg) {
    const c = cfg || {};
    for (const k of Object.keys(RAG_DEFAULTS)) {
      if (c[k] != null) this.cfg[k] = c[k];
    }
    this.cfg.batchSize = clamp(this.cfg.batchSize, 1, 8);
    this.cfg.topK = clamp(this.cfg.topK, 1, 10);
    this.cfg.minScore = clamp(this.cfg.minScore, 0, 1);
    this.cfg.relScore = clamp(this.cfg.relScore, 0, 1);
    this.cfg.chunkChars = clamp(this.cfg.chunkChars, 100, 480);
    this.cfg.overlapChars = clamp(this.cfg.overlapChars, 0, this.cfg.chunkChars - 50);
  }

  _gcJobs() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (now - job.updatedAt > JOB_TTL_MS) this.jobs.delete(id);
    }
  }

  /* ---------------- 路径 / 索引 ---------------- */
  _userDir(user) {
    const uid = String((user && user.id) || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!uid) throw ragErr('NO_USER', '缺少用户身份');
    const dir = path.join(this.dataDir, 'kb', uid);
    ensureDir(dir);
    return dir;
  }
  _indexFile(user) { return path.join(this._userDir(user), 'index.json'); }
  _kbDir(user, kbId) {
    const id = String(kbId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!/^kb_[a-z0-9]{4,}$/.test(id)) throw ragErr('KB_NOT_FOUND', '知识库不存在');
    const dir = path.join(this._userDir(user), id);
    ensureDir(dir);
    return dir;
  }
  _chunksFile(user, kbId) { return path.join(this._kbDir(user, kbId), 'chunks.json'); }

  _loadIndex(user) {
    const doc = readJsonSafe(this._indexFile(user), null);
    if (!doc || !Array.isArray(doc.kbs)) return { version: KB_VERSION, kbs: [] };
    let changed = false;
    for (const kb of doc.kbs) {
      for (const d of kb.docs || []) {
        if (d.status === 'ingesting' || d.status === 'pending') {
          d.status = 'failed';
          d.error = '入库中断（服务重启），请重新入库';
          changed = true;
        }
      }
    }
    if (changed) this._saveIndex(user, doc);
    return doc;
  }
  _saveIndex(user, doc) { writeJsonAtomic(this._indexFile(user), doc); }

  _kbOut(kb) {
    const docs = kb.docs || [];
    return {
      id: kb.id,
      name: kb.name,
      createdAt: kb.createdAt || '',
      updatedAt: kb.updatedAt || '',
      docCount: docs.length,
      readyDocs: docs.filter((d) => d.status === 'ready').length,
      failedDocs: docs.filter((d) => d.status === 'failed').length,
      chunkCount: kb.chunkCount || 0,
      chars: kb.chars || 0,
    };
  }

  /* ---------------- 知识库管理 ---------------- */
  list(user) {
    const doc = this._loadIndex(user);
    const kbs = doc.kbs.map((k) => this._kbOut(k)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { ok: true, kbs, total: kbs.length };
  }

  create(user, name) {
    const nm = String(name || '').trim().slice(0, 40);
    if (!nm) throw ragErr('BAD_KB_NAME', '知识库名称不能为空', 400);
    const doc = this._loadIndex(user);
    if (doc.kbs.length >= MAX_KB_PER_USER) throw ragErr('TOO_MANY_KB', '知识库数量上限 ' + MAX_KB_PER_USER, 400);
    const kb = { id: rid('kb'), name: nm, createdAt: nowISO(), updatedAt: nowISO(), docs: [], chunkCount: 0, chars: 0 };
    doc.kbs.push(kb);
    this._saveIndex(user, doc);
    ensureDir(path.join(this._userDir(user), kb.id));
    writeJsonAtomic(this._chunksFile(user, kb.id), { version: KB_VERSION, dim: 0, model: '', chunks: [] });
    return { ok: true, kb: this._kbOut(kb) };
  }

  get(user, kbId) {
    const doc = this._loadIndex(user);
    const kb = doc.kbs.find((k) => k.id === String(kbId || ''));
    if (!kb) throw ragErr('KB_NOT_FOUND', '知识库不存在或不属于当前用户', 404);
    return {
      ok: true,
      kb: Object.assign(this._kbOut(kb), {
        docs: (kb.docs || []).map((d) => ({
          id: d.id, name: d.name, status: d.status, chunks: d.chunks || 0, chars: d.chars || 0,
          size: d.size || 0, error: d.error || '', at: d.at || '',
          source: d.source || null, kind: d.kind || '',
        })),
      }),
    };
  }

  rename(user, kbId, name) {
    const doc = this._loadIndex(user);
    const kb = doc.kbs.find((k) => k.id === String(kbId || ''));
    if (!kb) throw ragErr('KB_NOT_FOUND', '知识库不存在或不属于当前用户', 404);
    const nm = String(name || '').trim().slice(0, 40);
    if (!nm) throw ragErr('BAD_KB_NAME', '知识库名称不能为空', 400);
    kb.name = nm;
    kb.updatedAt = nowISO();
    this._saveIndex(user, doc);
    return { ok: true, kb: this._kbOut(kb) };
  }

  remove(user, kbId) {
    const doc = this._loadIndex(user);
    const i = doc.kbs.findIndex((k) => k.id === String(kbId || ''));
    if (i < 0) throw ragErr('KB_NOT_FOUND', '知识库不存在或不属于当前用户', 404);
    const [kb] = doc.kbs.splice(i, 1);
    this._saveIndex(user, doc);
    try { fs.rmSync(path.join(this._userDir(user), kb.id), { recursive: true, force: true }); } catch { /* 非关键 */ }
    return { ok: true, removed: kb.id };
  }

  removeDoc(user, kbId, docId) {
    const doc = this._loadIndex(user);
    const kb = doc.kbs.find((k) => k.id === String(kbId || ''));
    if (!kb) throw ragErr('KB_NOT_FOUND', '知识库不存在或不属于当前用户', 404);
    const idx = (kb.docs || []).findIndex((d) => d.id === String(docId || ''));
    if (idx < 0) throw ragErr('DOC_NOT_FOUND', '文档不存在', 404);
    const [removed] = kb.docs.splice(idx, 1);
    const store = readJsonSafe(this._chunksFile(user, kb.id), { chunks: [] });
    store.chunks = (store.chunks || []).filter((c) => c.docId !== removed.id);
    kb.chunkCount = store.chunks.length;
    kb.chars = (kb.docs || []).reduce((a, d) => a + (d.chars || 0), 0);
    kb.updatedAt = nowISO();
    writeJsonAtomic(this._chunksFile(user, kb.id), store);
    this._saveIndex(user, doc);
    return { ok: true, removed: removed.id, chunkCount: kb.chunkCount };
  }

  ownedKbIds(user, ids) {
    const doc = this._loadIndex(user);
    const wanted = new Set((ids || []).map(String));
    return doc.kbs.filter((k) => wanted.has(k.id)).map((k) => k.id);
  }

  /* ---------------- embedding 客户端 ---------------- */
  _embedUrl() { return String(this.cfg.embedUrl || '').replace(/\/+$/, ''); }

  async _embedBatch(texts) {
    const url = this._embedUrl().replace(/\/v1$/i, '') + '/v1/embeddings';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts, model: this.cfg.embedModel }),
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw ragErr('EMBED_UNAVAILABLE', 'embedding 服务不可用（' + url + '）：' + String((e && e.message) || e));
    }
    clearTimeout(timer);
    const txt = await r.text().catch(() => '');
    if (!r.ok) {
      if (/context|too many tokens|exceed/i.test(txt)) {
        throw ragErr('EMBED_CONTEXT', 'embedding 输入超过 512 token 上限（请把文档切得更碎）');
      }
      throw ragErr('EMBED_HTTP', 'embedding 服务返回 HTTP ' + r.status + '：' + truncate(txt, 200));
    }
    let j;
    try { j = JSON.parse(txt); } catch { throw ragErr('EMBED_BAD_JSON', 'embedding 响应不是 JSON'); }
    const data = Array.isArray(j.data) ? j.data : [];
    if (data.length !== texts.length) throw ragErr('EMBED_BAD_LEN', 'embedding 返回数量不匹配');
    const vectors = data.map((d) => normalizeVec(Float32Array.from(d.embedding || [])));
    return { vectors, dim: vectors[0] ? vectors[0].length : 0 };
  }

  /** 串行分批 embed（每批 ≤8），返回 {vectors, dim, ms, batches} */
  async embed(texts, onBatch) {
    const t0 = Date.now();
    const out = [];
    const batch = Math.max(1, Math.min(8, Number(this.cfg.batchSize) || 8));
    let dim = 0;
    let batches = 0;
    for (let i = 0; i < texts.length; i += batch) {
      const slice = texts.slice(i, i + batch);
      const r = await this._embedBatch(slice);
      out.push(...r.vectors);
      dim = r.dim || dim;
      batches++;
      if (onBatch) onBatch({ done: out.length, total: texts.length, batches });
    }
    return { vectors: out, dim, ms: Date.now() - t0, batches };
  }

  /** embedding 服务探活（/v1/models + 一条真实 embed） */
  async probe() {
    const t0 = Date.now();
    const url = this._embedUrl();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 4000);
      let models = [];
      try {
        const r = await fetch(url.replace(/\/v1$/i, '') + '/v1/models', { signal: ac.signal });
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          models = (Array.isArray(j.data) ? j.data : []).map((x) => x.id || x.name || '').filter(Boolean).slice(0, 5);
        }
      } catch { /* 探活失败由下面的真实 embed 判定 */ }
      clearTimeout(timer);
      const e = await this._embedBatch(['探活']);
      return { ok: true, ms: Date.now() - t0, url, model: this.cfg.embedModel, dim: e.dim, models };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, url, model: this.cfg.embedModel, error: String((e && e.message) || e), code: (e && e.code) || 'EMBED_ERROR' };
    }
  }

  /* ---------------- 入库任务 ---------------- */
  startIngest(user, kbId, items, meta) {
    const doc = this._loadIndex(user);
    const kb = doc.kbs.find((k) => k.id === String(kbId || ''));
    if (!kb) throw ragErr('KB_NOT_FOUND', '知识库不存在或不属于当前用户', 404);
    const list = Array.isArray(items) ? items : [];
    if (!list.length) throw ragErr('NO_FILES', '没有要入库的文件', 400);
    if ((kb.docs || []).length + list.length > MAX_DOCS_PER_KB) {
      throw ragErr('TOO_MANY_DOCS', '该知识库文档上限 ' + MAX_DOCS_PER_KB, 400);
    }
    const job = {
      id: rid('job'),
      kind: 'kb-ingest',
      userId: user.id,
      kbId: kb.id,
      kbName: kb.name,
      state: 'queued',
      total: list.length,
      done: 0,
      failed: 0,
      current: '',
      percent: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      docs: [],
      error: '',
      embed: meta && meta.embed ? meta.embed : null,
    };
    this.jobs.set(job.id, job);
    /* 先建 pending 文档记录，前端立刻能看到 */
    for (const it of list) {
      const d = {
        id: rid('doc'),
        name: String(it.name || it.path || '未命名').slice(0, 120),
        status: 'pending',
        chunks: 0,
        chars: 0,
        size: Number(it.size) || 0,
        error: '',
        at: nowISO(),
        source: it.source || null,
        kind: '',
      };
      kb.docs.push(d);
      job.docs.push({ docId: d.id, name: d.name, status: 'pending', error: '', chunks: 0, chars: 0, ms: 0 });
    }
    kb.updatedAt = nowISO();
    this._saveIndex(user, doc);
    setImmediate(() => this._runJob(job, user, kb.id, list).catch((e) => {
      job.state = 'failed';
      job.error = String((e && e.message) || e);
      job.updatedAt = Date.now();
    }));
    return { ok: true, job: this.jobOut(job) };
  }

  jobOut(job) {
    return {
      id: job.id, kbId: job.kbId, kbName: job.kbName, state: job.state,
      total: job.total, done: job.done, failed: job.failed, current: job.current,
      percent: job.percent, startedAt: job.startedAt, updatedAt: job.updatedAt,
      elapsed_ms: (job.finishedAt || Date.now()) - job.startedAt,
      error: job.error || '',
      docs: job.docs,
    };
  }

  getJob(user, jobId) {
    const job = this.jobs.get(String(jobId || ''));
    if (!job || job.userId !== user.id) throw ragErr('JOB_NOT_FOUND', '入库任务不存在', 404);
    return { ok: true, job: this.jobOut(job) };
  }

  async _runJob(job, user, kbId, items) {
    job.state = 'running';
    job.updatedAt = Date.now();
    const started = Date.now();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const name = String(it.name || it.path || '未命名').slice(0, 120);
      job.current = name;
      job.percent = Math.round((i / items.length) * 100);
      job.updatedAt = Date.now();
      const rec = job.docs[i];
      try {
        /* 1. 取文本 */
        const buf = it.kind === 'text'
          ? Buffer.from(String(it.text || ''), 'utf8')
          : fs.readFileSync(it.abs);
        if (buf.length > MAX_FILE_MB * 1024 * 1024) throw ragErr('FILE_TOO_LARGE', '文件超过 ' + MAX_FILE_MB + 'MB');
        const ex = extractByExt(name, buf);
        let text = String(ex.text || '').slice(0, MAX_EXTRACT_CHARS);
        if (!text.trim()) throw ragErr('EMPTY_TEXT', '未抽取到文本（可能为空文件或纯图片）');
        /* 2. 分块 */
        const pieces = chunkText(text, this.cfg.chunkChars, this.cfg.overlapChars);
        if (!pieces.length) throw ragErr('EMPTY_TEXT', '分块后为空');
        const kbForLimit = this._loadIndex(user).kbs.find((k) => k.id === kbId);
        if ((kbForLimit.chunkCount || 0) + pieces.length > MAX_CHUNKS_PER_KB) {
          throw ragErr('TOO_MANY_CHUNKS', '该知识库向量片段上限 ' + MAX_CHUNKS_PER_KB);
        }
        /* 3. 串行分批 embed */
        const emb = await this.embed(pieces);
        /* 4. 写向量 */
        const store = readJsonSafe(this._chunksFile(user, kbId), { version: KB_VERSION, dim: 0, model: '', chunks: [] });
        store.dim = emb.dim;
        store.model = this.cfg.embedModel;
        for (let k = 0; k < pieces.length; k++) {
          store.chunks.push({
            id: rid('c', 5),
            docId: rec.docId,
            docName: name,
            idx: k,
            text: pieces[k],
            vec: vecToB64(emb.vectors[k] || new Float32Array(0)),
          });
        }
        writeJsonAtomic(this._chunksFile(user, kbId), store);
        /* 5. 更新文档/库状态 */
        rec.status = 'ready';
        rec.chunks = pieces.length;
        rec.chars = text.length;
        rec.ms = Date.now() - started;
        const docNow = this._loadIndex(user);
        const kbNow = docNow.kbs.find((k) => k.id === kbId);
        const dNow = kbNow && (kbNow.docs || []).find((d) => d.id === rec.docId);
        if (dNow) {
          dNow.status = 'ready';
          dNow.chunks = pieces.length;
          dNow.chars = text.length;
          dNow.kind = ex.kind;
          dNow.error = '';
          if (ex.warning) dNow.warning = ex.warning;
        }
        if (kbNow) {
          kbNow.chunkCount = store.chunks.length;
          kbNow.chars = (kbNow.docs || []).reduce((a, d) => a + (d.chars || 0), 0);
          kbNow.updatedAt = nowISO();
        }
        this._saveIndex(user, docNow);
        job.docs[i].status = 'ready';
        job.docs[i].chunks = pieces.length;
        job.docs[i].chars = text.length;
        job.docs[i].char_kind = ex.kind;
        job.docs[i].warning = ex.warning || '';
        job.done++;
      } catch (e) {
        const msg = String((e && e.message) || e);
        rec.status = 'failed';
        rec.error = msg;
        rec.code = (e && e.code) || 'INGEST_ERROR';
        job.docs[i].status = 'failed';
        job.docs[i].error = msg;
        job.docs[i].code = rec.code;
        job.failed++;
        const docNow = this._loadIndex(user);
        const kbNow = docNow.kbs.find((k) => k.id === kbId);
        const dNow = kbNow && (kbNow.docs || []).find((d) => d.id === rec.docId);
        if (dNow) { dNow.status = 'failed'; dNow.error = msg; dNow.code = rec.code; }
        if (kbNow) kbNow.updatedAt = nowISO();
        this._saveIndex(user, docNow);
      }
      job.percent = Math.round(((i + 1) / items.length) * 100);
      job.updatedAt = Date.now();
    }
    job.finishedAt = Date.now();
    job.state = job.failed === 0 ? 'done' : (job.done === 0 ? 'failed' : 'partial');
    job.error = job.state === 'done' ? '' : (job.docs.find((d) => d.status === 'failed') || {}).error || '';
    job.current = '';
    job.percent = 100;
    job.updatedAt = Date.now();
  }

  /* ---------------- 检索 ---------------- */
  /** 纯检索：返回 hits / miss / 错误；供 chat 与 /kb/search 共用 */
  async search(user, kbIds, query, opts) {
    const o = opts || {};
    const t0 = Date.now();
    const ids = (kbIds || []).map(String);
    if (!ids.length) return { ok: true, hits: [], miss: true, ms: 0, embed_ms: 0, kbs: [] };
    const doc = this._loadIndex(user);
    const kbs = doc.kbs.filter((k) => ids.includes(k.id));
    const missing = ids.filter((id) => !kbs.find((k) => k.id === id));
    if (missing.length) return { ok: false, code: 'KB_NOT_FOUND', error: '知识库不存在或不属于当前用户：' + missing.join(','), ms: Date.now() - t0 };
    const pool = [];
    for (const kb of kbs) {
      const store = readJsonSafe(this._chunksFile(user, kb.id), { chunks: [] });
      for (const c of store.chunks || []) {
        pool.push({ kbId: kb.id, kbName: kb.name, docId: c.docId, docName: c.docName, idx: c.idx, text: c.text, vec: b64ToVec(c.vec) });
      }
    }
    const qText = String(query || '').trim();
    if (!pool.length || !qText) {
      return { ok: true, hits: [], miss: true, ms: Date.now() - t0, embed_ms: 0, kbs: kbs.map((k) => ({ id: k.id, name: k.name })), pool: 0 };
    }
    const e0 = Date.now();
    let qv;
    try {
      const emb = await this.embed([qText]);
      qv = emb.vectors[0];
    } catch (e) {
      return {
        ok: false, code: (e && e.code) || 'EMBED_ERROR',
        error: String((e && e.message) || e),
        ms: Date.now() - t0, embed_ms: Date.now() - e0,
        kbs: kbs.map((k) => ({ id: k.id, name: k.name })), pool: pool.length,
      };
    }
    const embedMs = Date.now() - e0;
    const topK = clamp(o.topK != null ? o.topK : this.cfg.topK, 1, 10);
    const minScore = o.minScore != null ? Number(o.minScore) : this.cfg.minScore;
    const scored = pool.map((c) => ({ c, score: dot(qv, c.vec) })).sort((a, b) => b.score - a.score);
    const best = scored.length ? scored[0].score : 0;
    const rel = best * this.cfg.relScore;
    const hits = [];
    for (const s of scored) {
      if (hits.length >= topK) break;
      if (s.score < minScore || s.score < rel) break; // 已排序：一旦低于门槛，后面都更低
      hits.push({
        index: hits.length + 1,
        kbId: s.c.kbId,
        kbName: s.c.kbName,
        docId: s.c.docId,
        docName: s.c.docName,
        chunk: s.c.idx,
        score: Math.round(s.score * 10000) / 10000,
        text: truncate(String(s.c.text || ''), 260),
      });
    }
    return {
      ok: true,
      hits,
      miss: hits.length === 0,
      ms: Date.now() - t0,
      embed_ms: embedMs,
      topK,
      minScore,
      best_score: Math.round(best * 10000) / 10000,
      kbs: kbs.map((k) => ({ id: k.id, name: k.name })),
      pool: pool.length,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 单例（按 dataDir 缓存）
 * ------------------------------------------------------------------ */
const _instances = new Map();
function getRAG(dataDir) {
  const key = String(dataDir || '');
  if (!_instances.has(key)) _instances.set(key, new RAG(dataDir));
  return _instances.get(key);
}

module.exports = {
  RAG,
  getRAG,
  RAG_DEFAULTS,
  extractByExt,
  chunkText,
  normalizeVec,
  vecToB64,
  b64ToVec,
  dot,
  zipEntries,
  ragErr,
};

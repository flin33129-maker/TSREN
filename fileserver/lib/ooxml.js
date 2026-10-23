'use strict';
/**
 * 零依赖的 Office 文档文本抽取（docx / xlsx / pptx / odt）
 *
 * 起因：用户问「文档-10-19 0722.docx 大概是什么内容」，AI 只回一句
 * 「二进制文件无法读入对话」—— 明明文件就在这台机器上，服务端也有解压能力。
 *
 * 为什么不用 soffice（机器上确实装了 LibreOffice）：
 *   · 它已经被办公页占着（ONLYOFFICE 那条链路），并发再看一个文档要排队，
 *     实测冷启动 2~4 秒，而 AI 一轮工具调用只该花几十毫秒；
 *   · 转换产物要落临时文件、还要清，多一处磁盘状态就多一处泄漏点。
 * 所以这里直接读 zip 里的 XML：一个 docx 正文抽取 ~5ms，且完全不碰进程外部状态。
 *
 * 取舍：只抽**纯文本**（Word 的段落、Excel 的单元格、PPT 的每页文字），
 * 不保留样式/图片/表格边框 —— 对话里要的是"内容是什么"，不是排版。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* 能抽文字的后缀。doc/xls/ppt（97-2003 二进制）不在此列，见下方说明。 */
const OFFICE_TEXT_EXT = new Set(['.docx', '.xlsx', '.pptx', '.odt']);

/** 单个文件解压前的体积上界：ZIP 炸弹/超大文档不该把内存吃光 */
const MAX_ZIP_BYTES = 80 * 1024 * 1024;
/** 抽取出的正文字数上界（后面还有 token 预算那一层，这里只防"一个 Excel 抽出 200 万字"） */
const MAX_TEXT_CHARS = 200 * 1000;

/* -------------------------------- zip 读取 -------------------------------- */

function findEocd(buf) {
  const sig = 0x06054b50;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

/** 读中央目录 → Map<条目名, {method, csize, lho}> */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 Office 文档（找不到 zip 中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    out.set(name, { method, csize, lho });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 取某个条目的解压后内容（局部头里的长度不可靠，用中央目录的 csize） */
function entryData(buf, e) {
  if (!e) return null;
  if (e.lho + 30 > buf.length) return null;
  const nameLen = buf.readUInt16LE(e.lho + 26);
  const extraLen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式 ' + e.method + '（该文档可能用了 zip64 或加密）');
}

/* -------------------------------- XML 小工具 -------------------------------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 把一段 XML 里所有指定标签的文字按出现顺序拼起来 */
function wordsIn(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'g');
  const parts = [];
  let m;
  while ((m = re.exec(xml))) {
    if (m[1]) parts.push(decodeEntities(m[1]));
  }
  return parts.join('');
}

/* -------------------------------- 各格式 -------------------------------- */

/** Word：段落按 </w:p> 切行，制表/换行保留 */
function docxText(buf, cd) {
  const data = entryData(buf, cd.get('word/document.xml'));
  if (!data) throw new Error('这个 docx 里找不到正文（word/document.xml）');
  const xml = data.toString('utf8');
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<\/w:p>/g;
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    const tok = m[0];
    if (tok === '</w:p>') out.push('\n');
    else if (m[1] !== undefined) out.push(decodeEntities(m[1]));
    else if (tok.startsWith('<w:tab')) out.push('\t');
    else out.push('\n');
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** Excel：每个工作表转成 TSV（单元格用制表符分隔，行用换行） */
function xlsxText(buf, cd) {
  /* 共享字符串表：单元格 t="s" 时值是这里的下标 */
  const shared = [];
  const ssData = entryData(buf, cd.get('xl/sharedStrings.xml'));
  if (ssData) {
    const xml = ssData.toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) shared.push(wordsIn(m[1], 't'));
  }
  /* 工作表清单与文件名的映射 */
  const relMap = new Map();
  const relData = entryData(buf, cd.get('xl/_rels/workbook.xml.rels'));
  if (relData) {
    const xml = relData.toString('utf8');
    const re = /<Relationship\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const id = /Id="([^"]*)"/.exec(attrs);
      const tg = /Target="([^"]*)"/.exec(attrs);
      if (id && tg) relMap.set(id[1], tg[1].replace(/^\.?\//, ''));
    }
  }
  const sheets = [];
  const wbData = entryData(buf, cd.get('xl/workbook.xml'));
  if (wbData) {
    const xml = wbData.toString('utf8');
    const re = /<sheet\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const nm = /name="([^"]*)"/.exec(attrs);
      const rid = /r:id="([^"]*)"/.exec(attrs);
      sheets.push({ name: nm ? decodeEntities(nm[1]) : '工作表', target: rid ? relMap.get(rid[1]) : null });
    }
  }
  if (!sheets.length) {
    /* 没有 workbook.xml 就按文件名兜底 */
    for (const [name] of cd) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) sheets.push({ name, target: name });
    }
  }
  const lines = [];
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  sheets.forEach((sh, si) => {
    const key = sh.target && cd.has('xl/' + sh.target) ? 'xl/' + sh.target : sh.target;
    const data = key ? entryData(buf, cd.get(key)) : null;
    if (!data) return;
    const xml = data.toString('utf8');
    lines.push(`【${sh.name || ('工作表' + (si + 1))}】`);
    let rows = 0;
    let rm;
    rowRe.lastIndex = 0;
    while ((rm = rowRe.exec(xml))) {
      if (rows >= 200) { lines.push('…（行数过多，已截断）'); break; }
      const cells = [];
      let cm;
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const tAttr = /\bt="([^"]*)"/.exec(attrs);
        const t = tAttr ? tAttr[1] : 'n';
        let v = '';
        if (t === 'inlineStr') v = wordsIn(inner, 't');
        else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          v = vm ? decodeEntities(vm[1]) : '';
          if (t === 's') v = shared[Number(v)] != null ? shared[Number(v)] : '';
          else if (t === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        }
        cells.push(String(v).replace(/[\t\n\r]+/g, ' '));
      }
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.trim()) { lines.push(line); rows++; }
    }
    lines.push('');
  });
  return lines.join('\n').trim();
}

/** PPT：每页一段，保留页号 */
function pptxText(buf, cd) {
  const slides = [];
  for (const [name] of cd) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (m) slides.push({ n: Number(m[1]), name });
  }
  slides.sort((a, b) => a.n - b.n);
  const out = [];
  for (const s of slides) {
    const data = entryData(buf, cd.get(s.name));
    if (!data) continue;
    const xml = data.toString('utf8');
    const re = /<a:t>([\s\S]*?)<\/a:t>|<\/a:p>/g;
    const parts = [];
    let m;
    while ((m = re.exec(xml))) {
      if (m[1] !== undefined) parts.push(decodeEntities(m[1]));
      else parts.push('\n');
    }
    const body = parts.join('').replace(/\n{2,}/g, '\n').trim();
    if (body) out.push(`【第 ${s.n} 页】\n${body}`);
  }
  return out.join('\n\n');
}

/** ODT：content.xml 去标签 */
function odtText(buf, cd) {
  const data = entryData(buf, cd.get('content.xml'));
  if (!data) throw new Error('这个 odt 里找不到 content.xml');
  let xml = data.toString('utf8');
  xml = xml.replace(/<\/text:p>/g, '\n').replace(/<text:tab\s*\/>/g, '\t');
  xml = xml.replace(/<[^>]+>/g, '');
  return decodeEntities(xml).replace(/\n{3,}/g, '\n\n').trim();
}

const LABEL = { '.docx': 'Word 文档', '.xlsx': 'Excel 表格', '.pptx': 'PPT 演示', '.odt': 'ODT 文档' };

/**
 * 抽取正文。
 * @returns {{ok:true, label:string, text:string, chars:number} | {ok:false, error:string} | null}
 *          null 表示"这个后缀不归我管"（调用方按原逻辑处理）
 */
function readOfficeText(absPath) {
  const ext = path.extname(String(absPath || '')).toLowerCase();
  if (!OFFICE_TEXT_EXT.has(ext)) return null;
  let buf;
  try {
    const st = fs.statSync(absPath);
    if (st.size > MAX_ZIP_BYTES) {
      return { ok: false, error: `文件太大（${Math.round(st.size / 1048576)} MB），不逐个解压；可先用 file_info 看大小。` };
    }
    buf = fs.readFileSync(absPath);
  } catch (e) {
    return { ok: false, error: '读取失败：' + (e && e.message) };
  }
  try {
    const cd = readCentralDirectory(buf);
    let text;
    if (ext === '.docx') text = docxText(buf, cd);
    else if (ext === '.xlsx') text = xlsxText(buf, cd);
    else if (ext === '.pptx') text = pptxText(buf, cd);
    else text = odtText(buf, cd);
    if (!text) return { ok: false, error: '文档里没有可抽取的文字（可能是纯图片/扫描件）。' };
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '\n…（正文过长，已截断）';
    return { ok: true, label: LABEL[ext] || 'Office 文档', text, chars: text.length };
  } catch (e) {
    return { ok: false, error: '解析失败：' + (e && e.message) };
  }
}

module.exports = { OFFICE_TEXT_EXT, readOfficeText };

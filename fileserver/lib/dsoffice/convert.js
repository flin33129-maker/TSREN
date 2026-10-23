'use strict';

/**
 * dsoffice · 导入 / 导出 / 格式转换（零依赖优先，外部工具可选）
 *
 * 设计原则：
 *   · **能自己干就自己干**：docx / xlsx 本质是 ZIP + XML，这里直接生成，
 *     不依赖 LibreOffice，装在哪都能用；
 *   · 外部工具（soffice / imagemagick / poppler）只作为增强：
 *     装了就用它做高质量转换（pptx、图片互转、PDF 缩略图），没装就明确报错，
 *     绝不假装成功；
 *   · capability() 返回的是**真实探测结果**，前端据此决定按钮是否可点。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, execFile } = require('child_process');
const { makeZip, readZip } = require('./zip');

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  zip: 'application/zip',
};

/** 文件名安全化：中文保留，路径分隔符/控制字符/引号一律替换 */
function safeName(title, ext) {
  const e = String(ext || 'bin').replace(/^\./, '').toLowerCase();
  const base = String(title || '未命名')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '未命名';
  return base + '.' + e;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function has(bin, args) {
  try {
    execFileSync(bin, args, { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch (e) {
    return false;
  }
}

/* ───────────────────────────── 能力探测 ───────────────────────────── */

let _cap = null;
/**
 * 能力矩阵。
 *
 * **返回结构必须和前端对得上**：public/app 的「导入 / 导出」弹窗读的是
 *   matrix.export[fmt] → true | 'image-only' | false
 * 少了 export 这一层，前端 `A.export[C]` 直接 TypeError，整个办公页白屏
 * （R16 用 jsdom 跑真前端时踩到的，不是猜的）。
 * 所以这里同时给出：engines（探测明细，供设置页/诊断展示）
 *                 import / export（前端消费的扁平矩阵）
 */
function capability() {
  if (_cap) return _cap;
  const soffice = ['soffice', 'libreoffice'].some((b) => has(b, ['--version']));
  const magick = has('magick', ['-version']) || has('convert', ['-version']);
  const pdftotext = has('pdftotext', ['-v']);
  const pdftoppm = has('pdftoppm', ['-v']);
  const engines = {
    soffice: { ok: soffice, note: soffice ? '可用：docx/xlsx/pptx/pdf 高质量转换' : '未安装：Office 格式改用内置生成器' },
    imagemagick: { ok: magick, note: magick ? '可用：图片格式互转' : '未安装：图片只能原样导出' },
    pdftotext: { ok: pdftotext, note: pdftotext ? '可用：PDF 抽文字' : '未安装：使用内置解析器（扫描件无效）' },
    pdftoppm: { ok: pdftoppm, note: pdftoppm ? '可用：PDF 封面缩略图' : '未安装：PDF 缩略图不可用' },
    builtin: { ok: true, note: '内置零依赖导出：md/txt/html/csv/json/docx/xlsx/pdf' },
  };
  const importMatrix = {
    docx: true, xlsx: true, xlsm: true, csv: true, tsv: true,
    md: true, markdown: true, txt: true, html: true, htm: true, json: true,
    pdf: true, image: true,
    png: true, jpg: true, jpeg: true, gif: true, webp: true, bmp: true,
  };
  const exportMatrix = {
    docx: true, xlsx: true, md: true, markdown: true, txt: true, html: true, json: true,
    csv: true, tsv: true,
    pdf: true,                                  // 内置排版始终可用，装了 soffice 自动升级
    pptx: soffice ? true : false,               // 只有 LibreOffice 能写 pptx
    png: 'image-only', jpg: 'image-only',
    webp: magick ? 'image-only' : false,
    gif: magick ? 'image-only' : false,
  };
  _cap = {
    engines,
    import: importMatrix,
    export: exportMatrix,
    /* 兼容旧字段：直接读 matrix.soffice.ok 的调用方还能用 */
    ...engines,
  };
  return _cap;
}

/** 探测结果缓存 10 分钟（装了新工具不用重启服务） */
setInterval(() => { _cap = null; }, 10 * 60 * 1000).unref();

/* ───────────────────────────── 文档 → 纯文本 / MD / HTML ───────────────────────────── */

function sheetMatrix(content) {
  const c = content || {};
  const rows = Math.max(1, Math.min(1000, Number(c.rows) || 40));
  const cols = Math.max(1, Math.min(100, Number(c.cols) || 16));
  const out = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    let any = false;
    for (let k = 0; k < cols; k++) {
      let letters = '';
      let x = k;
      do { letters = String.fromCharCode(65 + (x % 26)) + letters; x = Math.floor(x / 26) - 1; } while (x >= 0);
      const cell = (c.cells || {})[letters + (r + 1)] || {};
      const v = cell.v != null && cell.v !== '' ? String(cell.v) : cell.f ? String(cell.f) : '';
      if (v) any = true;
      line.push(v);
    }
    if (any) out.push(line);
  }
  return out;
}

function docToMarkdown(doc) {
  const c = doc.content || {};
  switch (doc.kind) {
    case 'sheet': {
      const m = sheetMatrix(c);
      if (!m.length) return '# ' + doc.title + '\n\n（空表格）\n';
      const cols = Math.max(...m.map((r) => r.length));
      const pad = (r) => { const x = r.slice(); while (x.length < cols) x.push(''); return x; };
      const clean = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const lines = [
        '| ' + pad(m[0]).map(clean).join(' | ') + ' |',
        '| ' + pad(m[0]).map(() => '---').join(' | ') + ' |',
        ...m.slice(1).map((r) => '| ' + pad(r).map(clean).join(' | ') + ' |'),
      ];
      return '# ' + doc.title + '\n\n' + lines.join('\n') + '\n';
    }
    case 'board': {
      const cols = c.columns || [];
      const cards = c.cards || [];
      const out = ['# ' + doc.title, ''];
      for (const col of cols) {
        out.push('## ' + (col.title || col.id));
        const list = cards.filter((x) => x.col === col.id);
        if (!list.length) out.push('_（空）_');
        for (const card of list) out.push('- [ ] ' + String(card.text || '').replace(/\n/g, ' ') + (card.assignee ? ' @' + card.assignee : ''));
        out.push('');
      }
      return out.join('\n');
    }
    case 'mind': {
      const nodes = c.nodes || [];
      const out = ['# ' + doc.title, ''];
      const walk = (id, depth) => {
        for (const n of nodes.filter((x) => (x.parent || null) === id)) {
          out.push('  '.repeat(depth) + '- ' + (n.text || ''));
          walk(n.id, depth + 1);
        }
      };
      walk(c.rootId || null, 0);
      if (out.length === 2) out.push('_（空导图）_');
      return out.join('\n') + '\n';
    }
    case 'note': {
      const out = ['# ' + doc.title, ''];
      for (const n of (c.notes || [])) out.push('- ' + String(n.text || '').replace(/\n/g, ' ') + '  _(' + (n.color || 'amber') + ')_');
      return out.join('\n') + '\n';
    }
    case 'slide': {
      const out = [];
      (c.slides || []).forEach((s, i) => {
        out.push('# ' + (s.title || '第 ' + (i + 1) + ' 页'));
        if (s.body) out.push('', String(s.body));
        out.push('');
      });
      return out.join('\n') || '# ' + doc.title + '\n';
    }
    case 'flow': {
      const out = ['# ' + doc.title, '', '```mermaid', 'flowchart TD'];
      for (const n of (c.nodes || [])) out.push('  ' + n.id + '["' + String(n.text || '').replace(/"/g, "'") + '"]');
      for (const e of (c.edges || [])) out.push('  ' + e.from + ' -->' + (e.label ? '|' + e.label + '|' : '') + ' ' + e.to);
      out.push('```');
      return out.join('\n') + '\n';
    }
    case 'form': {
      const out = ['# ' + doc.title, '', '共 ' + ((c.responses || []).length) + ' 份回复', ''];
      for (const f of (c.fields || [])) out.push('- **' + f.label + '**（' + f.type + (f.required ? '，必填' : '') + '）');
      return out.join('\n') + '\n';
    }
    case 'poster': {
      const out = ['# ' + doc.title, '', '> 画布 ' + (c.width || 1080) + '×' + (c.height || 1440), ''];
      for (const el of (c.elements || [])) {
        if (el.type === 'text') out.push('- ' + String(el.text || '').replace(/\n/g, ' '));
        else out.push('- [图片] ' + (el.src || '').slice(0, 120));
      }
      return out.join('\n') + '\n';
    }
    default:
      return String((c.text != null ? c.text : '') || '');
  }
}

function docToHtml(doc) {
  const md = docToMarkdown(doc);
  const body = esc(md).replace(/\n/g, '<br>\n');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(doc.title) + '</title>'
    + '<style>body{max-width:860px;margin:40px auto;padding:0 20px;'
    + 'font:16px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1c1f26;background:#fff}'
    + 'pre{white-space:pre-wrap;font:inherit}</style></head><body>'
    + '<pre>' + body + '</pre></body></html>';
}

/* ───────────────────────────── 内置 OOXML 写出 ───────────────────────────── */

function docxOf(doc) {
  const text = docToMarkdown(doc);
  const paras = text.split('\n').map((line) => {
    const isHeading = /^#{1,3}\s/.test(line);
    const content = line.replace(/^#{1,3}\s/, '');
    return '<w:p><w:pPr>' + (isHeading ? '<w:pStyle w:val="Heading1"/>' : '') + '</w:pPr>'
      + '<w:r><w:rPr>' + (isHeading ? '<w:b/><w:sz w:val="32"/>' : '') + '</w:rPr>'
      + '<w:t xml:space="preserve">' + esc(content) + '</w:t></w:r></w:p>';
  }).join('');

  const files = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'word/document.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + '<w:body>' + paras
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>'
        + '</w:body></w:document>',
    },
  ];
  return makeZip(files);
}

function xmlEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xlsxOf(doc) {
  const m = sheetMatrix(doc.content || {});
  const rows = m.length ? m : [['']];
  const rowXml = rows.map((r, ri) => {
    const cells = r.map((v, ci) => {
      if (v === '' || v == null) return '';
      let letters = '';
      let x = ci;
      do { letters = String.fromCharCode(65 + (x % 26)) + letters; x = Math.floor(x / 26) - 1; } while (x >= 0);
      const isNum = /^-?\d+(\.\d+)?$/.test(String(v).trim());
      return isNum
        ? '<c r="' + letters + (ri + 1) + '"><v>' + Number(v) + '</v></c>'
        : '<c r="' + letters + (ri + 1) + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
    }).join('');
    return '<row r="' + (ri + 1) + '">' + cells + '</row>';
  }).join('');

  const files = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets><sheet name="' + xmlEsc((doc.title || 'Sheet1').slice(0, 28)) + '" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<sheetData>' + rowXml + '</sheetData></worksheet>',
    },
  ];
  return makeZip(files);
}

/**
 * 内置 PDF：单列文本排版。
 * 用标准 CJK 字体 STSong-Light（UniGB-UCS2-H 编码）输出，中文无需嵌字体；
 * 阅读器缺该字体时会回退，但绝大多数桌面/移动阅读器都能显示。
 */
function pdfOf(doc) {
  const text = docToMarkdown(doc);
  const pageW = 595.28;
  const pageH = 841.89;
  const margin = 56;
  const fontSize = 11;
  const lineH = 17;
  const maxLines = Math.floor((pageH - margin * 2) / lineH);
  const maxChars = Math.floor((pageW - margin * 2) / (fontSize * 0.95));

  const lines = [];
  for (const raw of text.split('\n')) {
    const line = String(raw).replace(/\t/g, '    ');
    if (!line) { lines.push(''); continue; }
    // 按字符宽度硬折行（中日韩与西文混排都够用）
    let rest = line;
    while (rest.length > maxChars) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    lines.push(rest);
  }

  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) pages.push(lines.slice(i, i + maxLines));
  if (!pages.length) pages.push(['']);

  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };

  // 1 catalog, 2 pages, 3 font(s)
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H '
    + '/DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light '
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> '
    + '/DW 1000 >>] >>');

  const ucs2Hex = (s) => {
    let out = '';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (cp < 0x10000) out += cp.toString(16).toUpperCase().padStart(4, '0');
      else out += '003F'; // 辅助平面字符：用 ? 代替（CID 字体无对应字形）
    }
    return out;
  };

  const pageIds = [];
  for (const page of pages) {
    let stream = 'BT\n/F1 ' + fontSize + ' Tf\n' + lineH + ' TL\n' + margin + ' ' + (pageH - margin) + ' Td\n';
    for (const line of page) {
      stream += '<' + ucs2Hex(line) + '> Tj\nT*\n';
    }
    stream += 'ET';
    const contentId = add('<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream');
    const pageId = add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + pageW.toFixed(2) + ' ' + pageH.toFixed(2) + '] '
      + '/Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
    pageIds.push(pageId);
  }

  objs[catalogId - 1] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
  objs[pagesId - 1] = '<< /Type /Pages /Count ' + pageIds.length + ' /Kids [' + pageIds.map((i) => i + ' 0 R').join(' ') + '] >>';

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

/* ───────────────────────────── 导出入口 ───────────────────────────── */

function sofficeBin() {
  return has('soffice', ['--version']) ? 'soffice' : has('libreoffice', ['--version']) ? 'libreoffice' : null;
}

/**
 * @param {object} doc
 * @param {string} format docx|xlsx|pptx|pdf|md|txt|html|csv|tsv|json
 * @returns {Promise<{ok:true,buf:Buffer,mime:string,filename:string,engine:string,ms:number}|{ok:false,error:string}>}
 */
async function exportDoc(doc, format) {
  const t0 = Date.now();
  const want = String(format || '').toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg');
  const kind = doc.kind || 'doc';
  const finish = (buf, mime, ext, engine) => ({
    ok: true,
    buf,
    mime: mime || MIME[ext] || 'application/octet-stream',
    filename: safeName(doc.title, ext),
    engine,
    ms: Date.now() - t0,
  });

  if (want === 'json') {
    return finish(Buffer.from(JSON.stringify({
      id: doc.id, kind, title: doc.title, folder: doc.folder, rev: doc.rev,
      updatedAt: doc.updatedAt, content: doc.content,
    }, null, 2), 'utf8'), MIME.json, 'json', 'builtin');
  }
  if (want === 'md' || want === 'markdown') {
    return finish(Buffer.from(docToMarkdown(doc), 'utf8'), MIME.md, 'md', 'builtin');
  }
  if (want === 'txt') {
    return finish(Buffer.from(docToMarkdown(doc), 'utf8'), MIME.txt, 'txt', 'builtin');
  }
  if (want === 'html') {
    return finish(Buffer.from(docToHtml(doc), 'utf8'), MIME.html, 'html', 'builtin');
  }
  if (want === 'csv' || want === 'tsv') {
    if (kind !== 'sheet') return { ok: false, error: '只有表格可以导出 CSV/TSV' };
    const sep = want === 'csv' ? ',' : '\t';
    const cell = (v) => {
      const s = String(v == null ? '' : v);
      return want === 'csv' && /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = sheetMatrix(doc.content || {}).map((r) => r.map(cell).join(sep)).join('\r\n');
    // 带 BOM：Excel 打开中文不乱码
    return finish(Buffer.from('\uFEFF' + csv + '\r\n', 'utf8'), MIME[want], want, 'builtin');
  }
  if (want === 'docx') {
    return finish(docxOf(doc), MIME.docx, 'docx', 'builtin-ooxml');
  }
  if (want === 'xlsx') {
    if (kind !== 'sheet') return { ok: false, error: 'xlsx 导出仅支持表格文档（其它类型可导 docx/md）' };
    return finish(xlsxOf(doc), MIME.xlsx, 'xlsx', 'builtin-ooxml');
  }
  if (want === 'pdf') {
    const bin = sofficeBin();
    if (bin && kind !== 'pdf') {
      const r = await sofficeConvert(bin, doc, 'pdf');
      if (r) return finish(r, MIME.pdf, 'pdf', 'libreoffice');
      // 转换失败就继续走内置，别让用户拿不到文件
    }
    return finish(pdfOf(doc), MIME.pdf, 'pdf', 'builtin-pdf');
  }
  if (want === 'pptx') {
    if (kind !== 'slide') return { ok: false, error: 'pptx 导出仅支持演示文档' };
    const bin = sofficeBin();
    if (!bin) return { ok: false, error: '导出 .pptx 需要服务器安装 LibreOffice（soffice）；可先导出 PDF / Markdown' };
    const r = await sofficeConvert(bin, doc, 'pptx');
    if (!r) return { ok: false, error: 'LibreOffice 转换失败（请查看服务端日志）' };
    return finish(r, MIME.pptx, 'pptx', 'libreoffice');
  }
  return { ok: false, error: '不支持的导出格式：' + want };
}

/** 用 LibreOffice 转：先把中间 HTML 写到临时目录，再转成目标格式 */
function sofficeConvert(bin, doc, fmt) {
  return new Promise((resolve) => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsconv-'));
    const htmlFile = path.join(dir, 'in.html');
    try { fs.writeFileSync(htmlFile, docToHtml(doc)); } catch (e) { resolve(null); return; }
    execFile(bin, ['--headless', '--norestore', '--convert-to', fmt, '--outdir', dir, htmlFile],
      { timeout: 60000, env: { ...process.env, HOME: dir } }, (err) => {
        try {
          const target = path.join(dir, 'in.' + fmt);
          if (!err && fs.existsSync(target)) {
            const buf = fs.readFileSync(target);
            fs.rmSync(dir, { recursive: true, force: true });
            resolve(buf);
            return;
          }
        } catch (e) { /* 落到下面的失败分支 */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
        resolve(null);
      });
  });
}

/* ───────────────────────────── 导入 ───────────────────────────── */

function baseName(name) {
  return String(name || 'import').replace(/^.*[\\/]/, '').slice(0, 120);
}

function titleOf(name) {
  return baseName(name).replace(/\.[^.]+$/, '').slice(0, 80) || '导入文档';
}

function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

function cellsFromMatrix(rows) {
  const cells = {};
  const maxRows = Math.min(rows.length, 1000);
  let maxCols = 0;
  for (let r = 0; r < maxRows; r++) {
    const row = rows[r] || [];
    maxCols = Math.max(maxCols, row.length);
    for (let c = 0; c < Math.min(row.length, 100); c++) {
      const v = row[c];
      if (v == null || v === '') continue;
      let letters = '';
      let x = c;
      do { letters = String.fromCharCode(65 + (x % 26)) + letters; x = Math.floor(x / 26) - 1; } while (x >= 0);
      cells[letters + (r + 1)] = { v: String(v) };
    }
  }
  return { cells, rows: Math.max(40, maxRows + 4), cols: Math.max(16, Math.min(100, maxCols + 2)) };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 xlsx 里取第一张表（inlineStr 与 sharedStrings 都支持） */
function xlsxToMatrix(buf) {
  const files = readZip(buf, zlib);
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) {
    const txt = ss.toString('utf8');
    for (const m of txt.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]);
      shared.push(parts.join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    }
  }
  let sheetName = null;
  for (const n of files.keys()) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(n)) { sheetName = n; break; }
  }
  if (!sheetName) return [];
  const xml = files.get(sheetName).toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rIdx = parseInt(rm[1], 10) - 1;
    const row = rows[rIdx] || (rows[rIdx] = []);
    for (const cm of rm[2].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const ref = /r="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;
      let col = 0;
      for (const ch of ref[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      col -= 1;
      const isShared = /t="s"/.test(attrs);
      const isInline = /t="inlineStr"/.test(attrs);
      const vM = /<v>([\s\S]*?)<\/v>/.exec(cm[2]);
      const tM = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cm[2]);
      let val = '';
      if (isShared && vM) val = shared[Number(vM[1])] || '';
      else if (isInline && tM) val = tM[1];
      else if (vM) val = vM[1];
      row[col] = val;
    }
  }
  return rows;
}

function docxToText(buf) {
  const files = readZip(buf, zlib);
  const doc = files.get('word/document.xml');
  if (!doc) return '';
  const xml = doc.toString('utf8');
  return xml
    .replace(/<w:p[^>]*>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 导入原始文件。
 * @param {Buffer} buf
 * @param {string} name
 * @returns {{ok:true,kind:string,title:string,content:object,note:string}|{ok:false,error:string}}
 */
function importBuffer(buf, name) {
  const file = baseName(name);
  const ext = (file.split('.').pop() || '').toLowerCase();
  const title = titleOf(file);
  const tooBig = 45 * 1024 * 1024;
  if (buf.length > tooBig) return { ok: false, error: '导入文件超过 45MB 上限' };

  try {
    if (ext === 'csv' || ext === 'tsv') {
      const text = buf.toString('utf8').replace(/^\uFEFF/, '');
      const rows = parseDelimited(text, ext === 'tsv' ? '\t' : ',');
      if (!rows.length) return { ok: false, error: '文件里没有可导入的数据' };
      return { ok: true, kind: 'sheet', title, content: cellsFromMatrix(rows), note: '已按 ' + rows.length + ' 行导入为表格' };
    }
    if (ext === 'xlsx' || ext === 'xlsm') {
      const rows = xlsxToMatrix(buf);
      if (!rows.length) return { ok: false, error: '未在 xlsx 里找到工作表数据' };
      return { ok: true, kind: 'sheet', title, content: cellsFromMatrix(rows), note: '已导入 xlsx 第一张工作表' };
    }
    if (ext === 'docx') {
      const text = docxToText(buf);
      if (!text) return { ok: false, error: '未从 docx 中提取到文字' };
      return { ok: true, kind: 'doc', title, content: { text }, note: '已提取 docx 正文（' + text.length + ' 字）' };
    }
    if (ext === 'html' || ext === 'htm') {
      return { ok: true, kind: 'doc', title, content: { text: stripHtml(buf.toString('utf8')) }, note: '已把 HTML 转为纯文本' };
    }
    if (ext === 'json') {
      const raw = buf.toString('utf8');
      try {
        const j = JSON.parse(raw);
        if (Array.isArray(j) && j.length && Array.isArray(j[0])) {
          return { ok: true, kind: 'sheet', title, content: cellsFromMatrix(j), note: '二维数组已转为表格' };
        }
      } catch (e) { /* 非法 JSON 就当文本 */ }
      return { ok: true, kind: 'doc', title, content: { text: raw }, note: '已作为文本导入' };
    }
    if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'log' || ext === 'ini' || ext === 'yaml' || ext === 'yml') {
      return { ok: true, kind: 'doc', title, content: { text: buf.toString('utf8').replace(/^\uFEFF/, '') }, note: '已作为文字文档导入' };
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
      return {
        ok: true,
        kind: 'image',
        title,
        content: { name: file, mime: MIME[ext] || 'image/png', data: buf.toString('base64'), width: 0, height: 0 },
        note: '已导入图片',
      };
    }
    if (ext === 'pdf') {
      return {
        ok: true,
        kind: 'pdf',
        title,
        content: { name: file, mime: 'application/pdf', data: buf.toString('base64'), pages: 0 },
        note: '已导入 PDF（只读预览）',
      };
    }
    // 未知类型：当纯文本兜底（二进制会产生乱码，先判一下）
    const sample = buf.subarray(0, 4096).toString('utf8');
    if (/\u0000/.test(sample)) return { ok: false, error: '不支持的文件类型：.' + ext };
    return { ok: true, kind: 'doc', title, content: { text: buf.toString('utf8') }, note: '按纯文本导入' };
  } catch (e) {
    return { ok: false, error: '导入失败：' + (e && e.message || e) };
  }
}

/* ───────────────────────────── 图片 / PDF 辅助 ───────────────────────────── */

/** 纯 JS 读图片尺寸（PNG / JPEG / GIF / WebP / BMP），不依赖 imagemagick */
function imageInfo(buf, ext) {
  try {
    const e = String(ext || '').toLowerCase();
    if (e === 'png' || (buf[0] === 0x89 && buf[1] === 0x50)) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (e === 'gif' || (buf[0] === 0x47 && buf[1] === 0x49)) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (e === 'bmp' || (buf[0] === 0x42 && buf[1] === 0x4d)) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (e === 'webp' || (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')) {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (e === 'jpg' || e === 'jpeg' || (buf[0] === 0xff && buf[1] === 0xd8)) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15（排除 DHT 0xC4 / JPG 0xC8 / DAC 0xCC）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (e) { /* 解析失败返回 null */ }
  return null;
}

/** 图片格式互转：需要 imagemagick */
async function convertImage(buf, from, to) {
  const bin = has('magick', ['-version']) ? 'magick' : has('convert', ['-version']) ? 'convert' : null;
  if (!bin) return { ok: false, error: '服务器未安装 ImageMagick，无法转换图片格式（可原样下载）' };
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsimg-'));
  const src = path.join(dir, 'in.' + String(from || 'png').replace('jpeg', 'jpg'));
  const dst = path.join(dir, 'out.' + String(to).replace('jpeg', 'jpg'));
  try {
    fs.writeFileSync(src, buf);
    await new Promise((resolve, reject) => {
      execFile(bin, [src, dst], { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
    });
    const out = fs.readFileSync(dst);
    return { ok: true, buf: out };
  } catch (e) {
    return { ok: false, error: '图片转换失败：' + (e && e.message || e) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

/** PDF 页数：优先 pdfinfo，退化为解析 /Type /Page */
function pdfPageCount(buf) {
  if (has('pdfinfo', ['-v'])) {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dspdf-'));
    const f = path.join(dir, 'in.pdf');
    try {
      fs.writeFileSync(f, buf);
      const out = execFileSync('pdfinfo', [f], { timeout: 8000 }).toString('utf8');
      const m = /Pages:\s*(\d+)/.exec(out);
      if (m) return Number(m[1]);
    } catch (e) { /* 落到内置解析 */ } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  }
  try {
    const s = buf.toString('latin1');
    const count = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
    return count || null;
  } catch (e) {
    return null;
  }
}

/**
 * 内置 PDF 文字抽取（没有 poppler 时的兜底）
 *
 * 能处理：未压缩流 + FlateDecode 流里的 Tj/TJ/'/" 文本操作，
 * 以及大部分西文 PDF（简单字体 WinAnsi/MacRoman）。
 * 明确不处理：Type0/Identity-H（中文、日文等 CID 字体，字符串是字形 ID，
 * 没有内嵌 CMap 就无法还原成 Unicode）—— 这种情况返回 ok:false，
 * 让上层给出「需要 poppler / OCR」的准确提示，而不是吐一串乱码。
 */
function pdfTextBuiltin(buf) {
  try {
    const latin = buf.toString('latin1');
    if (/\/Subtype\s*\/Type0/.test(latin) && !/\/ToUnicode/.test(latin)) {
      return { ok: false, text: '', chars: 0, error: '该 PDF 使用 CID 字体且未内嵌 ToUnicode 映射（常见于中文/扫描件），需要 poppler-utils 或 OCR' };
    }
    const chunks = [];
    /* 逐个 stream 处理：/Filter 里含 FlateDecode 就解压 */
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(latin))) {
      const start = m.index + m[0].length;
      const end = latin.indexOf('endstream', start);
      if (end < 0) break;
      const dictStart = Math.max(0, latin.lastIndexOf('<<', m.index));
      const dict = latin.slice(dictStart, m.index);
      const raw = buf.subarray(start, end);
      let data = raw;
      if (/FlateDecode/.test(dict)) {
        try {
          data = zlib.inflateSync(raw);
        } catch (e) {
          try { data = zlib.inflateRawSync(raw); } catch (e2) { data = null; }
        }
      }
      if (data) chunks.push(data.toString('latin1'));
      re.lastIndex = end + 9;
    }
    const text = chunks.map(extractFromContentStream).filter(Boolean).join('\n');
    if (!text.trim()) return { ok: false, text: '', chars: 0, error: '未在该 PDF 中抽取到文字（可能是扫描件或图片型 PDF）' };
    return { ok: true, text: text.replace(/\n{3,}/g, '\n\n').trim() };
  } catch (e) {
    return { ok: false, text: '', chars: 0, error: '内置 PDF 解析失败：' + (e && e.message || e) };
  }
}

/** 从一段内容流里抽文本（BT…ET 之间的 Tj / TJ / ' / "） */
function extractFromContentStream(stream) {
  const lines = [];
  let line = '';
  const tokens = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\bT[dDmJj*]|\bET\b|[A-Za-z'"]+/g;
  let m;
  const decodePdfString = (raw) => {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch !== '\\') { out += ch; continue; }
      const nx = raw[++i];
      if (nx === undefined) break;
      if (nx === 'n') out += '\n';
      else if (nx === 'r') out += '\r';
      else if (nx === 't') out += '\t';
      else if (nx === 'b' || nx === 'f') out += ' ';
      else if (/[0-7]/.test(nx)) {
        let oct = nx;
        while (oct.length < 3 && /[0-7]/.test(raw[i + 1])) oct += raw[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else if (nx === '\n') { /* 续行 */ }
      else out += nx;
    }
    return out;
  };
  const decodeHex = (hex) => {
    const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
    let out = '';
    for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
    return out;
  };
  while ((m = tokens.exec(stream))) {
    const t = m[0];
    if (t[0] === '(') line += decodePdfString(t.slice(1, -1));
    else if (t[0] === '<') line += decodeHex(t);
    else if (t === 'Td' || t === 'TD' || t === 'T' || t === 'T*' || t === 'ET') {
      if (line.trim()) lines.push(line);
      line = '';
    }
    /* 其它操作符（Tf/Tj/TJ 等）不需要单独处理：
       字面量字符串本身已经在上面被收集进 line */
  }
  if (line.trim()) lines.push(line);
  return lines.join('\n');
}

/** PDF 抽文字 → Markdown */
async function pdfToMarkdown(buf) {
  if (!has('pdftotext', ['-v'])) {
    /* 没装 poppler 不等于一定抽不出字：简单 PDF（未压缩/Flate + 西文字体）
       用内置解析器就能拿到文字，比直接报错有用得多。 */
    const built = pdfTextBuiltin(buf);
    if (built.ok) return { ...built, engine: 'builtin' };
    const hint = /poppler/i.test(built.error) ? '' : '（可安装 poppler-utils 提升成功率）';
    return { ...built, engine: 'none', error: built.error + hint };
  }
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dspdf-'));
  const src = path.join(dir, 'in.pdf');
  const out = path.join(dir, 'out.txt');
  try {
    fs.writeFileSync(src, buf);
    await new Promise((resolve, reject) => {
      execFile('pdftotext', ['-layout', '-enc', 'UTF-8', src, out], { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
    });
    const text = fs.readFileSync(out, 'utf8').replace(/\r/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
    if (!text) {
      /* poppler 也抽不出（扫描件）→ 再用内置解析试一次，都不行才认输 */
      const built = pdfTextBuiltin(buf);
      return built.ok ? { ...built, engine: 'builtin' } : { ok: false, text: '', chars: 0, engine: 'none', error: built.error };
    }
    return { ok: true, text, chars: text.length, engine: 'poppler' };
  } catch (e) {
    return { ok: false, text: '', chars: 0, error: 'PDF 文字抽取失败：' + (e && e.message || e) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

/** PDF 首页缩略图 */
async function pdfThumb(buf) {
  if (!has('pdftoppm', ['-v'])) {
    return { ok: false, error: '服务器未安装 poppler-utils（pdftoppm），PDF 缩略图不可用' };
  }
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dspdf-'));
  const src = path.join(dir, 'in.pdf');
  const prefix = path.join(dir, 'p');
  try {
    fs.writeFileSync(src, buf);
    await new Promise((resolve, reject) => {
      execFile('pdftoppm', ['-png', '-f', '1', '-l', '1', '-r', '96', '-scale-to', '900', src, prefix],
        { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
    });
    const file = fs.readdirSync(dir).find((n) => n.startsWith('p') && n.endsWith('.png'));
    if (!file) return { ok: false, error: 'PDF 渲染失败（可能是加密文件）' };
    return { ok: true, buf: fs.readFileSync(path.join(dir, file)) };
  } catch (e) {
    return { ok: false, error: 'PDF 渲染失败：' + (e && e.message || e) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

module.exports = {
  MIME,
  safeName,
  capability,
  exportDoc,
  importBuffer,
  imageInfo,
  convertImage,
  pdfPageCount,
  pdfToMarkdown,
  pdfThumb,
  // 供单测/调试
  docToMarkdown,
  docToHtml,
  sheetMatrix,
  cellsFromMatrix,
  pdfOf,
  docxOf,
  xlsxOf,
};

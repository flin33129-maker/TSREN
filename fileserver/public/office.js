'use strict';

/* =====================================================================
   office.js — Office/EPUB/字体 在线预览扩展（零依赖，纯前端）
   依赖 app.js 的运行时辅助：el() / entryUrl() / fetchRange() / toast()
   DOCX/XLSX/PPTX/EPUB = zip 容器；DOC = OLE/CFB 二进制
   ===================================================================== */

/* ---------- 通用 zip 读取器（Range 按需取块） ---------- */
async function offZipOpen(entry) {
  if (entry._zf) return entry._zf;
  const url = entryUrl(entry);
  const tail = new Uint8Array(await offFetchRange(url, Math.max(0, entry.size - 65536), entry.size - 1));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('非标准 ZIP');
  const dv = new DataView(tail.buffer, tail.byteOffset);
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const cdBuf = new Uint8Array(await offFetchRange(url, cdOffset, cdOffset + cdSize - 1));
  const cdv = new DataView(cdBuf.buffer);
  const map = new Map();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cdBuf.length; i++) {
    if (cdv.getUint32(p, true) !== 0x02014b50) break;
    const method = cdv.getUint16(p + 10, true);
    const flag = cdv.getUint16(p + 8, true);
    const csize = cdv.getUint32(p + 20, true);
    const size = cdv.getUint32(p + 24, true);
    const nameLen = cdv.getUint16(p + 28, true);
    const extraLen = cdv.getUint16(p + 30, true);
    const commentLen = cdv.getUint16(p + 32, true);
    const lho = cdv.getUint32(p + 42, true);
    const nameBytes = cdBuf.subarray(p + 46, p + 46 + nameLen);
    // flag bit11 未置位时文件名为本地编码（中文 zip 通常是 GBK）
    let name;
    try {
      name = (flag & 0x0800) ? new TextDecoder('utf-8').decode(nameBytes)
                             : new TextDecoder('gbk').decode(nameBytes);
    } catch { name = new TextDecoder('utf-8').decode(nameBytes); }
    map.set(name, { method, csize, size, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const zf = {
    url,
    names: [...map.keys()],
    list: () => [...map.entries()].map(([name, r]) => ({ name, ...r })),
    has: (n) => map.has(n),
    async read(name) {
      const r = map.get(name);
      if (!r) throw new Error('zip 内不存在 ' + name);
      const head = new Uint8Array(await offFetchRange(url, r.lho, r.lho + 29));
      const hdv = new DataView(head.buffer);
      if (hdv.getUint32(0, true) !== 0x04034b50) throw new Error('local header 损坏');
      const dataStart = r.lho + 30 + hdv.getUint16(26, true) + hdv.getUint16(28, true);
      const raw = await offFetchRange(url, dataStart, dataStart + r.csize - 1);
      if (r.method === 0) return raw;
      if (r.method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压');
        return await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      }
      throw new Error('压缩方法 ' + r.method + ' 不支持');
    },
    async text(name) { return new TextDecoder('utf-8').decode(await this.read(name)); },
    async xml(name) { return new DOMParser().parseFromString(await this.text(name), 'text/xml'); },
  };
  entry._zf = zf;
  return zf;
}
async function offFetchRange(url, start, end) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: 'same-origin' });
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } catch (e) {
      lastErr = e;
      console.warn('[offFetchRange] retry', attempt + 1, start, e.message);
      await new Promise((r2) => setTimeout(r2, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}
/* XML 辅助：按 tagName（带前缀）取首个/全部 */
function xTags(node, tag) { return [...node.getElementsByTagName(tag)]; }
function xFirst(node, tag) { return node.getElementsByTagName(tag)[0] || null; }
function xText(node) {
  // 拼接节点下所有文本（w:t / a:t / t）
  let s = '';
  for (const t of node.getElementsByTagName('*')) {
    const n = t.tagName;
    if (n === 'w:t' || n === 'a:t' || n === 't') s += t.textContent;
  }
  return s;
}

/* =====================================================================
   DOCX 渲染：word/document.xml → 段落/标题/表格/列表
   ===================================================================== */
async function renderDOCX(entry, body) {
  const view = el('div', 'md-view');
  view.appendChild(el('div', '', '解析 Word 文档…'));
  body.innerHTML = '';
  body.appendChild(view);
  const zf = await offZipOpen(entry);
  const doc = await zf.xml('word/document.xml');
  view.innerHTML = '';

  const renderRun = (r) => {
    let html = '';
    const bold = xFirst(r, 'w:b') || (xFirst(r, 'w:rPr') && xFirst(xFirst(r, 'w:rPr'), 'w:b'));
    const italic = xFirst(r, 'w:i');
    let text = '';
    for (const t of r.getElementsByTagName('w:t')) text += t.textContent;
    if (!text) return '';
    text = escHTML(text).replace(/\n/g, '<br>');
    if (bold) html += '<b>' + text + '</b>';
    else if (italic) html += '<i>' + text + '</i>';
    else html += text;
    return html;
  };
  const renderPara = (p) => {
    const ppr = xFirst(p, 'w:pPr');
    let style = '';
    if (ppr) {
      const ps = xFirst(ppr, 'w:pStyle');
      if (ps) style = ps.getAttribute('w:val') || '';
    }
    const isList = ppr && xFirst(ppr, 'w:numPr');
    let inner = '';
    for (const r of p.getElementsByTagName('w:r')) inner += renderRun(r);
    if (!inner) return '';
    if (/^Heading(\d)/i.test(style) || /^(\d)$/.test(style)) {
      const lvl = Math.min(parseInt((RegExp.$1 || '1'), 10) || 1, 4);
      return `<h${lvl}>${inner}</h${lvl}>`;
    }
    if (/^Title$/i.test(style)) return `<h1>${inner}</h1>`;
    if (isList) return `<ul style="margin:4px 0 4px 26px"><li>${inner}</li></ul>`;
    return `<p style="margin:7px 0">${inner}</p>`;
  };
  const renderTable = (tbl) => {
    let html = '<table style="border-collapse:collapse">';
    for (const tr of tbl.getElementsByTagName('w:tr')) {
      html += '<tr>';
      for (const tc of tr.getElementsByTagName('w:tc')) {
        let cellText = '';
        for (const p of tc.getElementsByTagName('w:p')) cellText += (cellText ? '<br>' : '') + (renderPara(p) || '');
        html += `<td style="border:1px solid #99a;padding:4px 10px">${cellText || '&nbsp;'}</td>`;
      }
      html += '</tr>';
    }
    return html + '</table>';
  };

  const bodyEl = xFirst(doc, 'w:body') || doc;
  for (const node of bodyEl.childNodes) {
    if (node.nodeType !== 1) continue;
    if (node.tagName === 'w:p') { const h = renderPara(node); if (h) view.insertAdjacentHTML('beforeend', h); }
    else if (node.tagName === 'w:tbl') view.insertAdjacentHTML('beforeend', renderTable(node));
  }
  if (!view.innerHTML) view.appendChild(unsupported('文档为空或结构未识别'));
}

/* =====================================================================
   XLSX 渲染：sharedStrings + sheets → 多表格 + 标签切换
   ===================================================================== */
async function renderXLSX(entry, body) {
  const wrap = el('div', '', '');
  wrap.style.cssText = 'width:100%;align-self:stretch;overflow:auto;background:var(--panel)';
  body.innerHTML = '';
  body.appendChild(wrap);
  wrap.appendChild(el('div', '', '解析表格…'));

  const zf = await offZipOpen(entry);
  let shared = [];
  if (zf.has('xl/sharedStrings.xml')) {
    const ss = await zf.xml('xl/sharedStrings.xml');
    shared = xTags(ss, 'si').map((si) => xText(si));
  }
  const wb = await zf.xml('xl/workbook.xml');
  const sheetEls = xTags(wb, 'sheet');
  const sheets = [];
  for (let i = 0; i < sheetEls.length; i++) {
    const name = sheetEls[i].getAttribute('name') || ('Sheet' + (i + 1));
    const candidate = `xl/worksheets/sheet${i + 1}.xml`;
    if (!zf.has(candidate)) continue;
    sheets.push({ name, path: candidate });
  }
  wrap.innerHTML = '';

  const bar = el('div', '', '');
  bar.style.cssText = 'display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel-2);z-index:2;flex-wrap:wrap';
  const area = el('div', 'csv-view');
  wrap.appendChild(bar); wrap.appendChild(area);

  const show = async (idx) => {
    area.innerHTML = '<div style="padding:14px;color:var(--dim)">载入中…</div>';
    [...bar.children].forEach((c, i) => { c.style.background = i === idx ? 'var(--acc-grad)' : 'var(--panel-2)'; c.style.color = i === idx ? '#fff' : 'var(--txt-2)'; });
    const sh = await zf.xml(sheets[idx].path);
    area.innerHTML = '';
    const table = el('table');
    for (const row of xTags(sh, 'row')) {
      const tr = el('tr');
      for (const c of xTags(row, 'c')) {
        const t = c.getAttribute('t');
        let val = '';
        if (t === 's') {
          const v = xFirst(c, 'v');
          val = shared[+((v && v.textContent) || 0)] || '';
        } else if (t === 'inlineStr') {
          const is = xFirst(c, 'is');
          val = is ? xText(is) : '';
        } else {
          const v = xFirst(c, 'v');
          val = v ? v.textContent : '';
        }
        tr.appendChild(el('td', '', val));
      }
      table.appendChild(tr);
    }
    area.appendChild(table);
  };
  sheets.forEach((s, i) => {
    const b = el('button', '', s.name);
    b.style.cssText = 'padding:5px 14px;border-radius:8px;font-size:12px;font-weight:600;border:1px solid var(--line);cursor:pointer';
    b.onclick = () => show(i);
    bar.appendChild(b);
  });
  if (sheets.length) show(0);
  else { area.innerHTML = ''; area.appendChild(unsupported('未找到工作表')); }
}

/* =====================================================================
   PPTX 渲染：逐页提取文本
   ===================================================================== */
async function renderPPTX(entry, body) {
  const wrap = el('div', '', '');
  wrap.style.cssText = 'width:100%;align-self:stretch;overflow:auto;padding:16px 22px;background:var(--panel)';
  body.innerHTML = '';
  body.appendChild(wrap);
  wrap.appendChild(el('div', '', '解析幻灯片…'));

  const zf = await offZipOpen(entry);
  const slides = zf.names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0));
  wrap.innerHTML = '';
  if (!slides.length) { wrap.appendChild(unsupported('未找到幻灯片')); return; }
  let idx = 0;
  const head = el('div', '', '');
  head.style.cssText = 'font-size:12px;color:var(--dim);font-family:var(--mono);margin-bottom:10px';
  const card = el('div', '', '');
  card.style.cssText = 'background:var(--panel-2);border:1px solid var(--line);border-radius:14px;padding:26px 30px;min-height:300px;line-height:1.9';
  wrap.appendChild(head); wrap.appendChild(card);
  const show = async (i) => {
    head.textContent = `第 ${i + 1} 页 / 共 ${slides.length} 页`;
    card.innerHTML = '<span style="color:var(--dim)">载入中…</span>';
    const xml = await zf.xml(slides[i]);
    card.innerHTML = '';
    for (const p of xTags(xml, 'a:p')) {
      const text = xText(p);
      if (text.trim()) {
        const line = el('div', '', text);
        line.style.margin = '6px 0';
        card.appendChild(line);
      }
    }
    if (!card.innerHTML) card.appendChild(el('div', '', '（空白页）'));
  };
  const nav = el('div', '', '');
  nav.style.cssText = 'display:flex;gap:10px;margin-top:14px';
  const prev = el('button', 'btn', '← 上一页');
  const next = el('button', 'btn', '下一页 →');
  prev.onclick = () => { if (idx > 0) show(--idx); };
  next.onclick = () => { if (idx < slides.length - 1) show(++idx); };
  nav.appendChild(prev); nav.appendChild(next);
  wrap.appendChild(nav);
  await show(0);
}

/* =====================================================================
   DOC（OLE/CFB 二进制）→ piece table 文本提取
   ===================================================================== */
async function renderDOC(entry, body) {
  if (entry.size > 60 * 1024 * 1024) {
    body.innerHTML = '';
    body.appendChild(unsupported(`.doc 体积 ${fmtSize(entry.size)}（内嵌大量图片），在线解析内存压力大，请下载后打开`));
    return;
  }
  const view = el('div', 'txt-view');
  view.textContent = '解析 OLE 文档…';
  body.innerHTML = '';
  body.appendChild(view);

  const buf = new Uint8Array(await (await fetch(entryUrl(entry), { credentials: 'same-origin' })).arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!(dv.getUint32(0, true) === 0xe011cfd0 && dv.getUint32(4, true) === 0xe11ab1a1)) {
    throw new Error('不是 OLE 复合文档');
  }
  const ssz = 1 << dv.getUint16(0x1e, true);
  const msz = 1 << dv.getUint16(0x20, true);
  const firstDir = dv.getUint32(0x30, true);
  const firstMiniFAT = dv.getUint32(0x58, true);
  const nMiniFAT = dv.getUint32(0x5c, true);
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = dv.getUint32(0x4c + i * 4, true);
    if (s < 0xfffffffa) fatSectors.push(s);
  }
  let difat = dv.getUint32(0x44, true), guard = 0;
  while (difat < 0xfffffffa && guard++ < 10000) {
    const off = ssz + difat * ssz;
    if (off + ssz > buf.length) break;
    for (let i = 0; i < ssz / 4 - 1; i++) {
      const s = dv.getUint32(off + i * 4, true);
      if (s < 0xfffffffa) fatSectors.push(s);
    }
    difat = dv.getUint32(off + ssz - 4, true);
  }
  const fat = [];
  for (const fs of fatSectors) {
    const off = ssz + fs * ssz;
    if (off + ssz > buf.length) break;
    for (let i = 0; i < ssz / 4; i++) fat.push(dv.getUint32(off + i * 4, true));
  }
  const readChain = (start, size) => {
    const out = new Uint8Array(Math.max(0, size || 0));
    let s = start, o = 0, g = 0;
    while (s < 0xfffffffa && o < out.length && g++ < 1e7) {
      const off = ssz + s * ssz;
      const n = Math.min(ssz, out.length - o);
      out.set(buf.subarray(off, off + n), o);
      o += n; s = fat[s];
    }
    return out;
  };
  const dirData = readChain(firstDir, 0) || new Uint8Array(0);
  // 目录大小未知时按链长度读——readChain(start,0) 产出 0 长度，改用链扇区全读
  const dirChain = [];
  { let s = firstDir, g = 0; while (s < 0xfffffffa && g++ < 1e6) { dirChain.push(s); s = fat[s]; } }
  const dirAll = new Uint8Array(dirChain.length * ssz);
  { let o = 0; for (const s of dirChain) { const off = ssz + s * ssz; dirAll.set(buf.subarray(off, off + ssz), o); o += ssz; } }

  const entries = [];
  for (let off = 0; off + 128 <= dirAll.length; off += 128) {
    const nameLen = dirAll[off + 64] | (dirAll[off + 65] << 8);
    if (nameLen < 2) continue;
    const name = new TextDecoder('utf-16le').decode(dirAll.subarray(off, off + nameLen - 2));
    const u32at = (o) => (dirAll[o] | (dirAll[o + 1] << 8) | (dirAll[o + 2] << 16) | (dirAll[o + 3] << 24)) >>> 0;
    entries.push({
      name,
      type: dirAll[off + 66],
      start: u32at(off + 116),            // startSector @0x74
      size: u32at(off + 120),             // streamSize 低 32 位 @0x78
    });
  }
  const find = (name) => entries.find((e) => e.type === 2 && e.name === name) || null;
  const root = entries.find((e) => e.type === 5);
  const miniData = root ? readChain(root.start, root.size) : new Uint8Array(0);
  const mfData = readChain(firstMiniFAT, Math.min(nMiniFAT, 65536) * 4);
  const miniFAT = [];
  for (let i = 0; i + 4 <= mfData.length; i += 4) miniFAT.push((mfData[i] | (mfData[i + 1] << 8) | (mfData[i + 2] << 16) | (mfData[i + 3] << 24)) >>> 0);
  const readStream = (name) => {
    const e = find(name);
    if (!e) return null;
    if (e.size >= 0x1000) return readChain(e.start, e.size);
    const out = new Uint8Array(e.size);
    let s = e.start, o = 0, g = 0;
    while (s < 0xfffffffa && o < e.size && g++ < 1e7) {
      const off = s * msz;
      const n = Math.min(msz, e.size - o);
      out.set(miniData.subarray(off, off + n), o);
      o += n; s = miniFAT[s];
    }
    return out;
  };

  const word = readStream('WordDocument');
  if (!word) throw new Error('未找到 WordDocument 流');
  const wdv = new DataView(word.buffer, word.byteOffset, word.byteLength);
  const flags = wdv.getUint16(0x000a, true);
  const tableName = (flags & 0x0200) ? '1Table' : '0Table';
  let table = readStream(tableName);
  if (!table) table = readStream('1Table') || readStream('0Table');
  const fcClx = wdv.getUint32(0x01a2, true);
  const lcbClx = wdv.getUint32(0x01a6, true);
  let text = '';
  if (table && lcbClx && fcClx + lcbClx <= table.length) {
    const clx = table.subarray(fcClx, fcClx + lcbClx);
    let i = 0;
    while (i < clx.length && clx[i] === 1) { i++; const cb = clx[i] | (clx[i + 1] << 8); i += 2 + cb; }
    if (i < clx.length && clx[i] === 2) {
      i++;
      const lcb = (clx[i] | (clx[i + 1] << 8) | (clx[i + 2] << 16) | (clx[i + 3] << 24)) >>> 0;
      i += 4;
      const plc = clx.subarray(i, i + lcb);
      const n = Math.max(0, Math.floor((lcb - 4) / 12));
      const u32 = (arr, o) => (arr[o] | (arr[o + 1] << 8) | (arr[o + 2] << 16) | (arr[o + 3] << 24)) >>> 0;
      const cps = [];
      for (let k = 0; k <= n; k++) cps.push(u32(plc, k * 4));
      for (let k = 0; k < n; k++) {
        const fc = u32(plc, (n + 1) * 4 + k * 4);
        const cch = cps[k + 1] - cps[k];
        if (fc & 0x40000000) {
          const off = (fc & 0x7fffffff) / 2;
          for (let j = 0; j < cch; j++) text += String.fromCharCode(word[off + j]);
        } else {
          for (let j = 0; j < cch; j++) text += String.fromCharCode(word[fc + j * 2] | (word[fc + j * 2 + 1] << 8));
        }
      }
    }
  }
  if (!text) text = new TextDecoder('utf-16le').decode(word.subarray(0x800, Math.min(word.length, 0x800 + 200000)));
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x12\x14-\x1f]/g, '').replace(/\r/g, '\n');
  const printable = text.replace(/\s+/g, '').length;
  if (printable > 30) {
    view.textContent = text;
    return;
  }
  // 回退：WPS 等非标准 .doc 的文本常以 UTF-16LE 明文存于 WordDocument 流内，按可读游程扫描
  const isReadable = (u) => (u >= 0x20 && u < 0x7f) || (u >= 0x4e00 && u <= 0x9fff) ||
    (u >= 0x3000 && u <= 0x303f) || (u >= 0xff00 && u <= 0xffef) || u === 0x2014 || u === 0x2018 ||
    u === 0x2019 || u === 0x201c || u === 0x201d || u === 0x2026 || (u >= 0x0100 && u <= 0x024f);
  let out = '', run = '';
  for (let off = 0; off + 1 < word.length; off += 2) {
    const u = word[off] | (word[off + 1] << 8);
    if (isReadable(u)) {
      run += String.fromCharCode(u === 0x0d || u === 0x0b ? 0x0a : u);
    } else {
      if (run.length >= 4) out += run + '\n';
      run = '';
    }
  }
  if (run.length >= 4) out += run;
  text = out.replace(/\n{3,}/g, '\n\n').trim();
  view.textContent = text || '未能从该 .doc 提取出文本，请下载后用 Word/WPS 打开';
}

/* =====================================================================
   EPUB：container → OPF → spine 逐章渲染
   ===================================================================== */
async function renderEPUB(entry, body) {
  const wrap = el('div', '', '');
  wrap.style.cssText = 'width:100%;align-self:stretch;overflow:auto;background:var(--panel)';
  body.innerHTML = '';
  body.appendChild(wrap);
  wrap.appendChild(el('div', '', '解析电子书…'));
  const zf = await offZipOpen(entry);
  const container = await zf.xml('META-INF/container.xml');
  const opfPath = container.getElementsByTagName('rootfile')[0].getAttribute('full-path');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = await zf.xml(opfPath);
  const manifest = {};
  for (const it of xTags(opf, 'item')) manifest[it.getAttribute('id')] = it.getAttribute('href');
  const title = (xFirst(opf, 'title') || {}).textContent || entry.name;
  const spine = xTags(opf, 'itemref').map((ir) => manifest[ir.getAttribute('idref')]).filter(Boolean).map((h) => base + h);

  wrap.innerHTML = '';
  const head = el('div', '', '');
  head.style.cssText = 'padding:14px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel-2);z-index:2';
  head.innerHTML = `<b>${escHTML(title)}</b>`;
  const sel = el('select', '', '');
  sel.style.cssText = 'margin-top:8px;width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel-2);color:var(--txt);font-size:13px';
  spine.forEach((h, i) => {
    const o = el('option', '', `第 ${i + 1} 章`);
    o.value = String(i);
    sel.appendChild(o);
  });
  head.appendChild(sel);
  const chapter = el('div', 'md-view', '');
  wrap.appendChild(head); wrap.appendChild(chapter);

  const show = async (i) => {
    chapter.innerHTML = '<span style="color:var(--dim)">载入中…</span>';
    try {
      const html = await zf.text(spine[i]);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      chapter.innerHTML = doc.body ? doc.body.innerHTML : escHTML(html);
    } catch (e) { chapter.textContent = '章节加载失败：' + e.message; }
  };
  sel.onchange = () => show(+sel.value);
  await show(0);
}

/* =====================================================================
   字体预览：ttf/otf/woff/woff2
   ===================================================================== */
async function renderFONT(entry, body) {
  const wrap = el('div', '', '');
  wrap.style.cssText = 'width:100%;align-self:stretch;overflow:auto;padding:30px 36px;background:var(--panel)';
  body.innerHTML = '';
  body.appendChild(wrap);
  wrap.appendChild(el('div', '', '载入字体…'));
  const buf = await (await fetch(entryUrl(entry), { credentials: 'same-origin' })).arrayBuffer();
  let b64 = '';
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i += 0x8000) b64 += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  const fam = 'PvFont_' + Date.now();
  const fmt = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[extOf(entry.name)] || 'truetype';
  const style = document.createElement('style');
  style.textContent = `@font-face{font-family:'${fam}';src:url(data:font/${fmt};base64,${b64}) format('${fmt}');}`;
  document.head.appendChild(style);
  pvCleanup.push(() => style.remove());

  wrap.innerHTML = `
    <div style="font-family:'${fam}'">
      <div style="font-size:34px;font-weight:700">局域网文件服务器 LAN File Server</div>
      <div style="font-size:26px;margin-top:6px">窗前明月光，疑是地上霜 0123456789</div>
      <div style="font-size:19px;margin-top:14px;color:var(--txt-2)">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz</div>
      <div style="font-size:16px;margin-top:14px">The quick brown fox jumps over the lazy dog. 0123456789</div>
      <div style="font-size:15px;margin-top:18px">常规 Regular —— 时光荏苒，白驹过隙</div>
      <div style="font-size:15px;font-style:italic;margin-top:6px">斜体 Italic —— The quick brown fox</div>
      <div style="font-size:15px;font-weight:700;margin-top:6px">粗体 Bold —— 山高水长，来日方长</div>
    </div>`;
}

/* =====================================================================
   EML 邮件预览：RFC822 头 + RFC2047 编码头 + multipart + QP/Base64
   ===================================================================== */
function decodeRFC2047(s) {
  if (!s) return '';
  return s.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s*(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (m, cs, enc, data) {
      try {
        const charset = cs.toLowerCase().replace('gb2312', 'gbk');
        if (enc.toLowerCase() === 'b') {
          const bin = atob(data.replace(/\s+/g, ''));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder(charset).decode(bytes);
        }
        let qp = data.replace(/_/g, ' ');
        const bytes = new Uint8Array(qp.length);
        let n = 0;
        for (let i = 0; i < qp.length; i++) {
          if (qp[i] === '=' && /[0-9A-Fa-f]{2}/.test(qp.substr(i + 1, 2))) {
            bytes[n++] = parseInt(qp.substr(i + 1, 2), 16); i += 2;
          } else { bytes[n++] = qp.charCodeAt(i); }
        }
        return new TextDecoder(charset).decode(bytes.subarray(0, n));
      } catch (e) { return m; }
    });
}
function decodeQPBytes(text, charset) {
  const bytes = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '=' && /[0-9A-Fa-f]{2}/.test(text.substr(i + 1, 2))) {
      bytes[n++] = parseInt(text.substr(i + 1, 2), 16); i += 2;
    } else if (c === '=' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      if (text[i + 1] === '\r') i++; i++;
    } else { bytes[n++] = c.charCodeAt(0) & 0xff; }
  }
  try { return new TextDecoder(charset || 'utf-8').decode(bytes.subarray(0, n)); }
  catch (e) { return new TextDecoder('utf-8').decode(bytes.subarray(0, n)); }
}
function bytesToLatin1(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return s;
}
function latin1ToBytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}
function splitHeaders(block) {
  const headers = {};
  const lines = block.split(/\r?\n/);
  let lastKey = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && lastKey) { headers[lastKey] += ' ' + line.trim(); continue; }
    const i = line.indexOf(':');
    if (i > 0) {
      lastKey = line.slice(0, i).trim().toLowerCase();
      headers[lastKey] = line.slice(i + 1).trim();
    }
  }
  return headers;
}
function parseContentType(v) {
  const out = { type: 'text/plain', params: {} };
  if (!v) return out;
  const parts = v.split(';');
  out.type = parts[0].trim().toLowerCase();
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    const k = parts[i].slice(0, eq).trim().toLowerCase();
    let val = parts[i].slice(eq + 1).trim();
    if (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') val = val.slice(1, -1);
    out.params[k] = val;
  }
  return out;
}

async function renderEML(entry, body) {
  if (entry.size > 30 * 1024 * 1024) {
    body.innerHTML = '';
    body.appendChild(unsupported('邮件体积 ' + fmtSize(entry.size) + ' 过大，请下载后用邮件客户端打开'));
    return;
  }
  const bytes = new Uint8Array(await (await fetch(entryUrl(entry), { credentials: 'same-origin' })).arrayBuffer());
  body.innerHTML = '';
  await renderEMLBytes(bytes, body);
}
async function renderEMLBytes(bytes, body) {
  const wrap = el('div', '', '');
  wrap.style.cssText = 'width:100%;align-self:stretch;overflow:auto;padding:18px 24px;background:var(--panel);align-items:flex-start';
  body.innerHTML = '';
  body.appendChild(wrap);
  wrap.appendChild(el('div', '', '解析邮件…'));

  const raw = bytesToLatin1(bytes);
  const sep = raw.indexOf('\r\n\r\n');
  const sep2 = raw.indexOf('\n\n');
  let headEnd = raw.length;
  if (sep >= 0) headEnd = sep + 4;
  else if (sep2 >= 0) headEnd = sep2 + 2;
  const H = splitHeaders(raw.slice(0, headEnd));
  const bodyBlock = raw.slice(headEnd);

  // 裸头（无 RFC2047 编码但含高位字节）→ GBK 解码
  const decodeBare = (s) => {
    if (!s) return s;
    if (/[-ÿ]/.test(s)) {
      try {
        const bytes = new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff));
        return new TextDecoder('gbk').decode(bytes);
      } catch (e) { return s; }
    }
    return s;
  };
  const subject = decodeBare(decodeRFC2047(H.subject)) || '(无主题)';
  const from = decodeBare(decodeRFC2047(H.from));
  const to = decodeBare(decodeRFC2047(H.to));
  const date = H.date || '';
  const ct = parseContentType(H['content-type']);
  const charset = ct.params.charset || 'utf-8';

  const card = el('div', '', '');
  card.style.cssText = 'width:100%;max-width:900px;background:var(--panel-2);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-bottom:14px;font-size:13px';
  const row = (k, v) => '<div style="display:flex;gap:12px;padding:2px 0"><span style="color:var(--dim);width:56px;flex-shrink:0">' + k + '</span><span style="word-break:break-all"><b>' + escHTML(v) + '</b></span></div>';
  card.innerHTML = row('主题', subject) + row('发件人', from) + (to ? row('收件人', to) : '') + (date ? row('时间', escHTML(date)) : '');
  wrap.innerHTML = '';
  wrap.appendChild(card);

  const contents = [];
  const attachments = [];

  const decodeBody = (rawBody, encoding) => {
    if (/base64/i.test(encoding)) {
      try {
        const bin = atob(rawBody.replace(/\s+/g, ''));
        return { bytes: latin1ToBytes(bin), text: null };
      } catch (e) { return { bytes: null, text: rawBody }; }
    }
    if (/quoted-printable/i.test(encoding)) {
      return { bytes: latin1ToBytes(decodeQPBytes(rawBody, 'x-none')), text: null };
    }
    return { bytes: latin1ToBytes(rawBody), text: null };
  };
  const decodeText = (bytes, cs) => {
    try { return new TextDecoder(cs || 'utf-8').decode(bytes); }
    catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  };

  const handlePart = (headers, partBody, depth) => {
    const pct = parseContentType(headers['content-type']);
    const enc = headers['content-transfer-encoding'] || '';
    if (pct.type.indexOf('multipart/') === 0) {
      const boundary = pct.params.boundary;
      if (!boundary) return;
      const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const segs = partBody.split(new RegExp('(?:^|\\n)--' + esc + '(?:--)?[ \\t]*(?=\\r?\\n|$)'));
      for (let i = 1; i < segs.length; i++) {
        const s = segs[i];
        if (s === '' || s === '--') continue;
        const s2 = s.replace(/^\r?\n/, '');
        let subSep = s2.indexOf('\r\n\r\n');
        if (subSep >= 0) subSep += 4;
        else { subSep = s2.indexOf('\n\n'); if (subSep >= 0) subSep += 2; else subSep = s2.length; }
        const subH = splitHeaders(s2.slice(0, subSep));
        const subB = s2.slice(subSep).replace(/\r\n$/, '');
        handlePart(subH, subB, depth + 1);
      }
      return;
    }
    const fileName = decodeRFC2047(pct.params.name || '');
    const isAttachment = !!fileName || /^attachment/i.test(headers['content-disposition'] || '');
    if (isAttachment) {
      const db = decodeBody(partBody, enc);
      attachments.push({ name: fileName || 'attachment', size: db.bytes ? db.bytes.byteLength : partBody.length, bytes: db.bytes });
      return;
    }
    if (pct.type === 'text/html' && !contents.length) {
      const db = decodeBody(partBody, enc);
      contents.unshift({ type: 'html', text: decodeText(db.bytes, pct.params.charset) });
      return;
    }
    if (pct.type === 'text/plain') {
      const db = decodeBody(partBody, enc);
      contents.push({ type: 'text', text: decodeText(db.bytes, pct.params.charset) });
      return;
    }
  };

  handlePart(H, bodyBlock, 0);

  const bodyBox = el('div', '', '');
  bodyBox.style.cssText = 'width:100%;max-width:900px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;min-height:200px';
  if (contents.length && contents[0].type === 'html') {
    const f = el('iframe', '', '');
    f.style.cssText = 'width:100%;height:70vh;border:none;background:#fff';
    setTimeout(function () { f.srcdoc = contents[0].text; }, 30);
    bodyBox.appendChild(f);
  } else if (contents.length) {
    const pre = el('div', 'txt-view', contents.map(function (c) { return c.text; }).join('\n\n――――――\n\n'));
    pre.style.background = 'var(--panel)';
    bodyBox.appendChild(pre);
  } else {
    bodyBox.appendChild(unsupported('未解析出邮件正文'));
  }
  wrap.appendChild(bodyBox);

  if (attachments.length) {
    const list = el('div', '', '');
    list.style.cssText = 'width:100%;max-width:900px;margin-top:12px';
    list.appendChild(el('div', '', '附件 ' + attachments.length + ' 个（点击下载）'));
    for (const a of attachments) {
      const r = el('div', 'z-row');
      r.style.cssText = 'background:var(--panel-2);border:1px solid var(--line);border-radius:9px;margin-top:6px';
      r.appendChild(el('span', '', '📎'));
      r.appendChild(el('span', 'z-name', a.name || 'attachment'));
      r.appendChild(el('span', 'z-size', fmtSize(a.size)));
      r.onclick = function () { if (a.bytes) saveBlob(new Blob([a.bytes], { type: 'application/octet-stream' }), a.name || 'attachment'); };
      list.appendChild(r);
    }
    wrap.appendChild(list);
  }
}

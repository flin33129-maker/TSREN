'use strict';

/**
 * dsoffice · 实时协同中枢（零依赖 SSE）
 *
 * 职责：
 *   1. 维护「文档房间」（谁在看哪篇、光标在哪）；
 *   2. 接收前端发来的操作（op）并**在服务端同样应用一遍**，然后广播给房间内
 *      其它客户端 —— 服务端是唯一真相，客户端只是乐观更新；
 *   3. 处理正文增量（textSync）的合并与冲突标记。
 *
 * 为什么服务端也要跑一套 op 语义：
 *   客户端 public/app 里有一份 `applyOp`（用于本地乐观更新）。如果服务端只
 *   存不应用，刷新后内容就回到旧状态；两套语义必须**逐条对齐**，否则不同
 *   客户端看到的文档会长得不一样。本文件的 ops 实现与前端一一对应。
 *
 * 线上协议（SSE，event/data）：
 *   hello    {rev, users}                — 进房间时的初始状态
 *   op       {rev, op, by, cid}          — 有人提交了操作
 *   presence {users}                     — 在线名单变化 / 光标移动
 *   comment / notify / title / saved     — 由路由层调用 broadcast 触发
 */

const MAX_TEXT = 2 * 1024 * 1024;      // 单次正文同步上限 2MB
const MAX_ROOM_IDLE_MS = 30 * 60 * 1000;
const MAX_CLIENTS_PER_DOC = 64;
const AUTOSNAPSHOT_EVERY = 40;         // 每 40 个 rev 自动留一个版本

/** 稳定的用户配色：同一个名字永远同一个颜色 */
const PALETTE = ['#7c6efa', '#22a06b', '#e8833a', '#e5484d', '#0ea5e9', '#a855f7', '#eab308', '#14b8a6'];

function colorOf(name) {
  const s = String(name || 'guest');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ───────────────────────── 表格公式引用平移 ───────────────────────── */

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function colLetters(n) {
  let out = '';
  let x = Math.max(0, n);
  do {
    out = String.fromCharCode(65 + (x % 26)) + out;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return out;
}

/** 插入/删除行列后平移公式里的 A1 引用（与前端 eb() 完全一致） */
function shiftFormula(f, axis, at, n, del) {
  if (!f) return f;
  return String(f).replace(/(\$?)([A-Z]{1,2})(\$?)(\d{1,5})/g, (whole, d1, letters, d2, digits) => {
    const row = parseInt(digits, 10) - 1;
    const col = colIndex(letters);
    if (axis === 'row') {
      if (del) {
        if (row >= at && row < at + n) return '#REF!';
        if (row >= at + n) return d1 + letters + d2 + (row - n + 1);
        return whole;
      }
      return row >= at ? d1 + letters + d2 + (row + n + 1) : whole;
    }
    if (del) {
      if (col >= at && col < at + n) return '#REF!';
      if (col >= at + n) return d1 + colLetters(col - n) + d2 + digits;
      return whole;
    }
    return col >= at ? d1 + colLetters(col + n) + d2 + digits : whole;
  });
}

function clone(o) {
  return JSON.parse(JSON.stringify(o || {}));
}

/* ───────────────────────── 各 kind 的 op 应用 ───────────────────────── */

function applySheet(content, op) {
  const c = content;
  c.cells = c.cells || {};
  const act = String(op.act || '');

  if (op.t === 'cell') {
    const key = String(op.cell || '').toUpperCase();
    if (!/^[A-Z]{1,2}\d{1,5}$/.test(key)) return c;
    const cell = { ...(c.cells[key] || {}) };
    if (op.v !== undefined) cell.v = String(op.v);
    if (op.f !== undefined) cell.f = String(op.f || '');
    if (op.s !== undefined) {
      if (op.s) cell.s = { ...(cell.s || {}), ...op.s };
      else delete cell.s;
    }
    if ((cell.v == null || cell.v === '') && !cell.f && !cell.s) delete c.cells[key];
    else c.cells[key] = cell;
    return c;
  }

  if (op.t !== 'sheet') return c;

  if (act === 'rowIns' || act === 'colIns') {
    const n = Math.max(1, Math.min(50, Number(op.n) || 1));
    const at = Math.max(0, Number(op.at) || 0);
    const axis = act === 'rowIns' ? 'row' : 'col';
    const next = {};
    for (const [key, cell] of Object.entries(c.cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(key);
      if (!m) continue;
      let row = parseInt(m[2], 10) - 1;
      let col = colIndex(m[1]);
      if (axis === 'row' && row >= at) row += n;
      if (axis === 'col' && col >= at) col += n;
      next[colLetters(col) + (row + 1)] = cell.f ? { ...cell, f: shiftFormula(cell.f, axis, at, n, false) } : cell;
    }
    c.cells = next;
    if (axis === 'row') c.rows = (c.rows || 40) + n;
    else c.cols = (c.cols || 16) + n;
    return c;
  }

  if (act === 'rowDel' || act === 'colDel') {
    const n = Math.max(1, Math.min(50, Number(op.n) || 1));
    const at = Math.max(0, Number(op.at) || 0);
    const axis = act === 'rowDel' ? 'row' : 'col';
    const next = {};
    for (const [key, cell] of Object.entries(c.cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(key);
      if (!m) continue;
      const row0 = parseInt(m[2], 10) - 1;
      const col0 = colIndex(m[1]);
      if (axis === 'row' && row0 >= at && row0 < at + n) continue;
      if (axis === 'col' && col0 >= at && col0 < at + n) continue;
      let row = row0;
      let col = col0;
      if (axis === 'row' && row0 >= at + n) row = row0 - n;
      if (axis === 'col' && col0 >= at + n) col = col0 - n;
      next[colLetters(col) + (row + 1)] = cell.f ? { ...cell, f: shiftFormula(cell.f, axis, at, n, true) } : cell;
    }
    c.cells = next;
    if (axis === 'row') c.rows = Math.max(1, (c.rows || 40) - n);
    else c.cols = Math.max(1, (c.cols || 16) - n);
    return c;
  }

  if (act === 'freeze') {
    c.frozen = { r: Math.max(0, Number(op.r) || 0), c: Math.max(0, Number(op.c) || 0) };
    return c;
  }
  if (act === 'size') {
    if (op.colW) c.colW = { ...(c.colW || {}), ...op.colW };
    if (op.rowH) c.rowH = { ...(c.rowH || {}), ...op.rowH };
    if (op.rows) c.rows = Number(op.rows);
    if (op.cols) c.cols = Number(op.cols);
    return c;
  }
  if (act === 'note') {
    const key = String(op.cell || '').toUpperCase();
    c.cellNotes = c.cellNotes || {};
    if (op.text) c.cellNotes[key] = { text: String(op.text).slice(0, 2000), by: op.by || '', at: Date.now() };
    else delete c.cellNotes[key];
    return c;
  }
  if (act === 'replace' && op.content) return clone(op.content);
  return c;
}

function applyBoard(content, op) {
  const c = content;
  c.columns = c.columns || [];
  c.cards = c.cards || [];
  const act = String(op.act || '');
  if (act === 'card.add') {
    const card = op.card || {};
    c.cards.push({
      id: card.id || 'c' + Math.random().toString(36).slice(2, 9),
      col: card.col || (c.columns[0] && c.columns[0].id) || 'todo',
      text: String(card.text || '').slice(0, 2000),
      tags: Array.isArray(card.tags) ? card.tags.slice(0, 8) : [],
      assignee: card.assignee ? String(card.assignee).slice(0, 40) : '',
    });
    return c;
  }
  if (act === 'card.edit') {
    const card = c.cards.find((x) => x.id === op.id);
    if (card) {
      if (op.text !== undefined) card.text = String(op.text).slice(0, 2000);
      if (Array.isArray(op.tags)) card.tags = op.tags.slice(0, 8);
      if (op.assignee !== undefined) card.assignee = String(op.assignee).slice(0, 40);
    }
    return c;
  }
  if (act === 'card.move') {
    const card = c.cards.find((x) => x.id === op.id);
    if (card) {
      if (op.col) card.col = String(op.col);
      if (typeof op.index === 'number') {
        const rest = c.cards.filter((x) => x.id !== op.id);
        rest.splice(Math.max(0, Math.min(rest.length, op.index)), 0, card);
        c.cards = rest;
      }
    }
    return c;
  }
  if (act === 'card.del') {
    c.cards = c.cards.filter((x) => x.id !== op.id);
    return c;
  }
  if (act === 'col.add') {
    const col = op.col || {};
    if (col.id && !c.columns.some((x) => x.id === col.id)) c.columns.push({ id: String(col.id), title: String(col.title || '新分组').slice(0, 40) });
    return c;
  }
  if (act === 'col.rename') {
    const col = c.columns.find((x) => x.id === op.id);
    if (col) col.title = String(op.title || col.title).slice(0, 40);
    return c;
  }
  if (act === 'col.del') {
    c.columns = c.columns.filter((x) => x.id !== op.id);
    c.cards = c.cards.filter((x) => x.col !== op.id);
    return c;
  }
  if (act === 'replace' && op.content) return clone(op.content);
  return c;
}

function applyMind(content, op) {
  const c = content;
  c.nodes = c.nodes || [];
  const act = String(op.act || '');
  if (act === 'node.add') {
    const node = op.node || {};
    c.nodes.push({
      id: node.id || 'n' + Math.random().toString(36).slice(2, 9),
      parent: node.parent || c.rootId || null,
      text: String(node.text || '新节点').slice(0, 200),
    });
    return c;
  }
  if (act === 'node.edit') {
    const node = c.nodes.find((x) => x.id === op.id);
    if (node) node.text = String(op.text !== undefined ? op.text : node.text).slice(0, 200);
    return c;
  }
  if (act === 'node.del') {
    const dead = new Set([String(op.id)]);
    for (let again = true; again;) {
      again = false;
      for (const n of c.nodes) {
        if (n.parent && dead.has(n.parent) && !dead.has(n.id)) { dead.add(n.id); again = true; }
      }
    }
    c.nodes = c.nodes.filter((n) => !dead.has(n.id));
    return c;
  }
  if (act === 'replace' && op.content) return clone(op.content);
  return c;
}

function applyNote(content, op) {
  const c = content;
  c.notes = c.notes || [];
  const act = String(op.act || '');
  if (act === 'note.add') {
    const note = op.note || {};
    c.notes.push({
      id: note.id || 'n' + Math.random().toString(36).slice(2, 9),
      text: String(note.text || '').slice(0, 4000),
      color: note.color || 'amber',
    });
    return c;
  }
  if (act === 'note.edit') {
    const note = c.notes.find((x) => x.id === op.id);
    if (note) {
      if (op.text !== undefined) note.text = String(op.text).slice(0, 4000);
      if (op.color !== undefined) note.color = String(op.color);
    }
    return c;
  }
  if (act === 'note.del') {
    c.notes = c.notes.filter((x) => x.id !== op.id);
    return c;
  }
  if (act === 'replace' && op.content) return clone(op.content);
  return c;
}

function applySlide(content, op) {
  const c = content;
  c.slides = c.slides || [];
  const act = String(op.act || '');
  if (act === 'slide.edit') {
    const s = c.slides[Number(op.index)];
    if (s) {
      if (op.title !== undefined) s.title = String(op.title).slice(0, 200);
      if (op.body !== undefined) s.body = String(op.body).slice(0, 8000);
    }
    return c;
  }
  if (act === 'slide.add') {
    c.slides.splice(Math.max(0, Math.min(c.slides.length, Number(op.index) || 0)), 0, { title: '新页面', body: '' });
    return c;
  }
  if (act === 'slide.del') {
    if (c.slides.length > 1) c.slides.splice(Number(op.index) || 0, 1);
    return c;
  }
  if (act === 'replace' && op.content) return clone(op.content);
  return c;
}

function applyFlow(content, op) {
  const c = content;
  c.nodes = c.nodes || [];
  c.edges = c.edges || [];
  const act = String(op.act || '');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  const newId = (p) => p + Math.random().toString(36).slice(2, 9);
  if (act === 'node.add') {
    const n = op.node || {};
    c.nodes.push({
      id: n.id || newId('n'),
      x: clamp(n.x == null ? 80 : n.x, 0, 4000),
      y: clamp(n.y == null ? 80 : n.y, 0, 4000),
      text: String(n.text || '新节点').slice(0, 200),
      shape: n.shape || 'rect',
    });
    return c;
  }
  if (act === 'node.edit') {
    const n = c.nodes.find((x) => x.id === op.id);
    if (n) {
      if (op.text !== undefined) n.text = String(op.text).slice(0, 200);
      if (op.shape !== undefined) n.shape = String(op.shape);
    }
    return c;
  }
  if (act === 'node.move') {
    const n = c.nodes.find((x) => x.id === op.id);
    if (n) { n.x = clamp(op.x, 0, 4000); n.y = clamp(op.y, 0, 4000); }
    return c;
  }
  if (act === 'node.del') {
    c.nodes = c.nodes.filter((x) => x.id !== op.id);
    c.edges = c.edges.filter((e) => e.from !== op.id && e.to !== op.id);
    return c;
  }
  if (act === 'edge.add') {
    const e = op.edge || {};
    if (e.from && e.to && e.from !== e.to && c.nodes.some((n) => n.id === e.from) && c.nodes.some((n) => n.id === e.to)
      && !c.edges.some((x) => x.from === e.from && x.to === e.to)) {
      c.edges.push({ id: e.id || newId('e'), from: String(e.from), to: String(e.to), label: String(e.label || '').slice(0, 80) });
    }
    return c;
  }
  if (act === 'edge.del') {
    c.edges = c.edges.filter((x) => x.id !== op.id && !(x.from === op.from && x.to === op.to));
    return c;
  }
  if (act === 'replace' && op.content) return clone(op.content);
  return c;
}

function applyForm(content, op) {
  const c = content;
  c.fields = c.fields || [];
  c.responses = c.responses || [];
  const act = String(op.act || '');
  const newId = (p) => p + Math.random().toString(36).slice(2, 9);
  if (act === 'field.add') {
    const f = op.field || {};
    c.fields.push({
      id: f.id || newId('f'),
      label: String(f.label || '新字段').slice(0, 80),
      type: ['text', 'number', 'radio', 'checkbox', 'date', 'select', 'textarea'].includes(String(f.type)) ? f.type : 'text',
      required: !!f.required,
      options: Array.isArray(f.options) ? f.options.map(String).slice(0, 20) : [],
      placeholder: String(f.placeholder || '').slice(0, 100),
    });
    return c;
  }
  if (act === 'field.edit') {
    const f = c.fields.find((x) => x.id === op.id);
    if (f) {
      if (op.label !== undefined) f.label = String(op.label).slice(0, 80);
      if (op.type !== undefined) f.type = String(op.type);
      if (op.required !== undefined) f.required = !!op.required;
      if (Array.isArray(op.options)) f.options = op.options.map(String).slice(0, 20);
      if (op.placeholder !== undefined) f.placeholder = String(op.placeholder).slice(0, 100);
    }
    return c;
  }
  if (act === 'field.del') {
    c.fields = c.fields.filter((x) => x.id !== op.id);
    return c;
  }
  if (act === 'field.move') {
    const i = c.fields.findIndex((x) => x.id === op.id);
    if (i >= 0) {
      const [f] = c.fields.splice(i, 1);
      c.fields.splice(Math.max(0, Math.min(c.fields.length, Number(op.index) || 0)), 0, f);
    }
    return c;
  }
  if (act === 'submit') {
    c.responses.push({
      id: newId('r'),
      at: Date.now(),
      by: String(op.by || '').slice(0, 40),
      data: op.data && typeof op.data === 'object' ? op.data : {},
    });
    if (c.responses.length > 5000) c.responses.splice(0, c.responses.length - 5000);
    return c;
  }
  if (act === 'reset') { c.responses = []; return c; }
  if (act === 'replace' && op.content) return clone(op.content);
  return c;
}

function applyPoster(content, op) {
  const c = content;
  c.elements = c.elements || [];
  const act = String(op.act || '');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  if (act === 'size') {
    c.width = clamp(op.width, 320, 4096) || 1080;
    c.height = clamp(op.height, 320, 4096) || 1440;
    return c;
  }
  if (act === 'bg') { c.bg = String(op.bg || 'surface'); return c; }
  if (act === 'add') {
    const el = op.el || {};
    const item = {
      id: el.id || 'e' + Math.random().toString(36).slice(2, 9),
      type: el.type === 'image' ? 'image' : 'text',
      x: clamp(el.x, 0, 4096),
      y: clamp(el.y, 0, 4096),
      w: clamp(el.w, 20, 4096) || 400,
      h: clamp(el.h, 20, 4096) || 120,
    };
    if (item.type === 'image') item.src = String(el.src || '').slice(0, 5000);
    else {
      item.text = String(el.text || '文本').slice(0, 1000);
      item.fontSize = clamp(el.fontSize, 8, 300) || 32;
      item.weight = el.weight === 'bold' ? 'bold' : 'normal';
      item.color = String(el.color || 'text');
      item.align = ['left', 'center', 'right'].includes(String(el.align)) ? el.align : 'left';
    }
    c.elements.push(item);
    return c;
  }
  if (act === 'update') {
    const i = c.elements.findIndex((x) => x.id === op.id);
    if (i >= 0 && op.patch) c.elements[i] = { ...c.elements[i], ...op.patch };
    return c;
  }
  if (act === 'del') { c.elements = c.elements.filter((x) => x.id !== op.id); return c; }
  if (act === 'replace' && op.content) return clone(op.content);
  return c;
}

/** 把一条 op 应用到文档对象（就地修改），返回是否产生了实际变化 */
function applyOp(doc, op) {
  if (!doc || !op || typeof op !== 'object') return false;
  const kind = doc.kind || 'doc';
  const t = String(op.t || '');
  doc.content = doc.content && typeof doc.content === 'object' ? doc.content : {};

  if (t === 'cell' || (t === 'sheet' && kind === 'sheet')) {
    if (kind !== 'sheet') return false;
    const before = JSON.stringify(doc.content);
    applySheet(doc.content, op);
    return JSON.stringify(doc.content) !== before;
  }
  if (t === 'board' && kind === 'board') return changed(applyBoard(doc.content, op));
  if (t === 'mind' && kind === 'mind') return changed(applyMind(doc.content, op));
  if (t === 'note' && kind === 'note') return changed(applyNote(doc.content, op));
  if (t === 'slide' && kind === 'slide') return changed(applySlide(doc.content, op));
  if (t === 'flow' && kind === 'flow') return changed(applyFlow(doc.content, op));
  if (t === 'form' && kind === 'form') return changed(applyForm(doc.content, op));
  if (t === 'poster' && kind === 'poster') return changed(applyPoster(doc.content, op));
  return false;
}

function changed() {
  return true; // 各 applyX 都返回同一个对象；调用方关心的是「已处理」
}

/* ───────────────────────── 房间 / 广播 ───────────────────────── */

class LiveHub {
  constructor(app, store) {
    this.app = app;
    this.store = store;
    this.rooms = new Map();   // docId -> room
  }

  room(docId) {
    const key = String(docId || '');
    if (!key) return null;
    let room = this.rooms.get(key);
    if (room) return room;
    const doc = this.store.getDoc(key);
    if (!doc) return null;
    room = {
      docId: key,
      doc,
      rev: doc.rev || 1,
      clients: new Map(),     // cid -> {cid,user,color,res,cursor,at,joinedAt}
      createdAt: Date.now(),
      lastAt: Date.now(),
      ops: 0,
    };
    this.rooms.set(key, room);
    return room;
  }

  usersOf(docId) {
    const room = this.rooms.get(String(docId || ''));
    return room ? this.presenceList(room) : [];
  }

  presenceList(room) {
    return [...room.clients.values()].map((c) => ({
      cid: c.cid,
      user: c.user,
      color: c.color,
      cursor: c.cursor,
      at: c.at,
    }));
  }

  send(client, event, data) {
    try {
      client.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      return true;
    } catch (e) {
      return false;
    }
  }

  broadcast(room, event, data, exceptCid) {
    if (!room) return 0;
    let n = 0;
    for (const [cid, client] of room.clients) {
      if (exceptCid && cid === exceptCid) continue;
      if (this.send(client, event, data)) n++;
    }
    return n;
  }

  join(docId, client) {
    const room = this.room(docId);
    if (!room) return null;
    if (room.clients.size >= MAX_CLIENTS_PER_DOC) {
      // 房间满了：踢掉最久没动的那个（通常是关掉页面没断干净的连接）
      let oldest = null;
      for (const c of room.clients.values()) if (!oldest || c.at < oldest.at) oldest = c;
      if (oldest) {
        try { oldest.res.end(); } catch (e) { /* 已断 */ }
        room.clients.delete(oldest.cid);
      }
    }
    room.clients.set(client.cid, client);
    room.lastAt = Date.now();
    this.send(client, 'hello', { rev: room.rev, users: this.presenceList(room), docId: room.docId });
    this.broadcast(room, 'presence', { users: this.presenceList(room) }, client.cid);
    return room;
  }

  leave(room, cid) {
    if (!room) return;
    room.clients.delete(cid);
    room.lastAt = Date.now();
    this.broadcast(room, 'presence', { users: this.presenceList(room) });
    if (room.clients.size === 0) {
      // 最后一个用户离开：确保内存态落盘，再释放房间
      try { this.store.persistDoc(room.doc); } catch (e) { /* 忽略 */ }
      this.rooms.delete(room.docId);
    }
  }

  setPresence(docId, cid, cursor) {
    const room = this.room(docId);
    if (!room) return [];
    const client = room.clients.get(cid);
    if (client) {
      client.cursor = cursor == null ? null : cursor;
      client.at = Date.now();
      room.lastAt = Date.now();
    }
    const users = this.presenceList(room);
    this.broadcast(room, 'presence', { users });
    return users;
  }

  /**
   * 应用一条操作。
   * @returns {{ok:boolean, rev?:number, op?:object, conflict?:boolean, error?:string}}
   */
  apply(docId, base, op, user, cid) {
    const room = this.room(docId);
    if (!room) return { ok: false, error: '文档不存在' };
    const doc = room.doc;
    const by = (user && user.username) || 'guest';

    /* 正文增量：客户端带 baseText 来说明「我改之前是什么样」。
       服务端据此判断是否有人插队：
         - 相等 → 直接采用；
         - 不等 → 保留双方内容（新内容在前、对方在后）并标 conflict，
           绝不让任何一方的输入静默消失。 */
    if (op && op.t === 'textSync') {
      const incoming = String(op.text == null ? '' : op.text);
      if (incoming.length > MAX_TEXT) return { ok: false, error: '正文超过 2MB 上限' };
      const current = String((doc.content && doc.content.text) || '');
      let merged = incoming;
      let conflict = false;
      if (typeof op.baseText === 'string' && op.baseText !== current) {
        conflict = true;
        if (incoming !== current) {
          // 简单的三段合并：共同前缀 + 双方新增 + 共同后缀
          merged = threeWayMerge(String(op.baseText), current, incoming);
        }
      }
      doc.content = { ...(doc.content || {}), text: merged };
      doc.rev = (room.rev = (room.rev || 1) + 1);
      doc.updatedAt = Date.now();
      doc.updatedBy = by;
      this.store.flush(doc);
      const payload = { rev: room.rev, op: { t: 'textSync', text: merged }, by, cid: cid || '' };
      this.broadcast(room, 'op', payload, cid);
      this.autoSnapshot(room, by);
      return { ok: true, rev: room.rev, op: payload.op, conflict };
    }

    if (!op || typeof op !== 'object') return { ok: false, error: '操作格式不正确' };

    const accepted = applyOp(doc, op);
    if (!accepted) return { ok: false, error: '不支持的操作类型（kind=' + (doc.kind || 'doc') + ', t=' + String(op.t || '') + '）' };

    doc.rev = (room.rev = (room.rev || 1) + 1);
    doc.updatedAt = Date.now();
    doc.updatedBy = by;
    this.store.flush(doc);
    const payload = { rev: room.rev, op, by, cid: cid || '' };
    this.broadcast(room, 'op', payload, cid);
    this.autoSnapshot(room, by);
    return { ok: true, rev: room.rev, op, conflict: Number(base || 0) > 0 && Number(base) !== room.rev - 1 };
  }

  autoSnapshot(room, by) {
    if (room.rev % AUTOSNAPSHOT_EVERY !== 0) return;
    try { this.store.snapshot(room.doc, by, 'auto-r' + room.rev); } catch (e) { /* 忽略 */ }
  }

  /** 定时清理：关页面没断干净的连接 / 空房间 */
  reap() {
    const now = Date.now();
    for (const [docId, room] of this.rooms) {
      for (const [cid, client] of room.clients) {
        if (now - client.at > MAX_ROOM_IDLE_MS) {
          try { client.res.end(); } catch (e) { /* 已断 */ }
          room.clients.delete(cid);
        }
      }
      if (!room.clients.size) {
        try { this.store.persistDoc(room.doc); } catch (e) { /* 忽略 */ }
        this.rooms.delete(docId);
      }
    }
  }
}

/**
 * 三段合并：保留双方新增内容。
 * 只在「同一段落被两个人同时改」时退化为主张（A 在前、B 在后），
 * 保证任何一方的输入都不会丢。
 */
function threeWayMerge(base, theirs, mine) {
  if (base === theirs) return mine;
  if (base === mine) return theirs;
  // 共同前缀
  let p = 0;
  const max = Math.min(base.length, theirs.length, mine.length);
  while (p < max && base[p] === theirs[p] && base[p] === mine[p]) p++;
  let s = 0;
  while (s < max - p && base[base.length - 1 - s] === theirs[theirs.length - 1 - s] && base[base.length - 1 - s] === mine[mine.length - 1 - s]) s++;
  const head = base.slice(0, p);
  const tail = s ? base.slice(base.length - s) : '';
  const bMid = base.slice(p, base.length - s);
  const tMid = theirs.slice(p, theirs.length - s);
  const mMid = mine.slice(p, mine.length - s);
  if (tMid === bMid) return head + mMid + tail;
  if (mMid === bMid) return head + tMid + tail;
  return head + mMid + (mMid && tMid ? '\n' : '') + tMid + tail;
}

module.exports = { LiveHub, colorOf, applyOp, shiftFormula, threeWayMerge };

#!/usr/bin/env node
'use strict';

/**
 * ops/seed-demo.js — 铺一套**可演示**的初始数据
 *
 * 适用场景：给别人看效果、录屏、新机器首次启动、回归前把数据恢复成干净基线。
 * 只动 DATA_DIR 下的演示性数据，不碰账号（账号用 `node cli.js` 管理）。
 *
 *   DATA_DIR=./data node ops/seed-demo.js            # 铺演示数据（会清空现有办公文档）
 *   DATA_DIR=./data node ops/seed-demo.js --keep     # 只补缺失的，不删已有文档
 *
 * 铺完包含：
 *   data/office   7 篇办公文档（会议纪要 / 路线图 / 预算表 / 看板 / 演示 / 导图 / 复盘）
 *   public 盘    项目资料/、图片/、下载说明.txt
 *   消息中心     系统告警 / 操作记录 / 协同动态 + 一条 @提醒（都写进各自真实数据源）
 *
 * 注意：store 的索引写盘有 400ms 防抖，所以脚本最后必须 flushAll()，
 * 否则「文档写进去了、列表还是空」—— 这是 R16.1 真实踩过的坑。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const { OfficeStore } = require(path.join(ROOT, 'lib/dsoffice/store.js'));
const templates = require(path.join(ROOT, 'lib/dsoffice/templates.js'));

const KEEP = process.argv.includes('--keep');
const dataDir = path.resolve(process.env.DATA_DIR);
const admin = { username: 'admin', role: 'admin' };
const store = new OfficeStore({ cfg: { dataDir } });

function must(ok, msg) {
  if (!ok) throw new Error(msg);
}

/* ── 1. 办公文档 ───────────────────────────────────────────── */

const SEEDS = [
  {
    tpl: 'meeting', title: '周会纪要 · 10 月第 4 周', folder: '团队',
    edit: (t) => t
      .replace('- 时间：\n', '- 时间：2026-10-23 14:00\n')
      .replace('- 地点：\n', '- 地点：三楼小会议室\n')
      .replace('- 主持：\n', '- 主持：admin\n')
      .replace('- 参会：\n', '- 参会：全体 4 人\n')
      .replace('1. \n', '1. 办公工作区上线，文档 / 表格 / 看板可用\n2. 公共盘目录整理，历史资料归档\n')
      .replace('|  |  |  |', '| admin | 整理公共盘目录 | 10-30 |\n| 小李 | 补全预算表 10 月数据 | 10-28 |'),
  },
  {
    tpl: 'prd', title: '2026 产品路线图（草案）', folder: '团队',
    edit: (t) => t.replace('# 需求：', '# 需求：内网工具统一入口'),
  },
  {
    tpl: 'budget', title: '团队预算表 · 2026Q4', folder: '财务',
    cells: { B5: { f: '=SUM(B2:B4)' }, C5: { f: '=SUM(C2:C4)' }, D5: { f: '=SUM(D2:D4)' } },
  },
  { tpl: 'kanban', title: '迭代看板 · Sprint 12', folder: '团队' },
  { tpl: 'pitch', title: '方案汇报 · 办公协同', folder: '团队' },
  { tpl: 'plan', title: 'Q4 计划导图', folder: '团队' },
  { tpl: 'retro', title: '10 月项目复盘', folder: '团队' },
];

function seedOffice() {
  if (!KEEP) {
    for (const d of store.index.slice()) store.remove(admin, d.id);
    for (const t of store.trash.slice()) store.purge(t.id);
    /* 办公模块自己的 @提醒 队列（data/office/notify.json），和站内消息是两套 */
    store.notifyList.length = 0;
  }
  const existing = new Set(store.index.map((d) => d.title));
  let made = 0;
  for (const s of SEEDS) {
    if (existing.has(s.title)) continue;
    const t = templates.materialize(s.tpl);
    must(t && t.content, '模板缺失：' + s.tpl);
    const doc = store.create(admin, { kind: t.kind, title: s.title, folder: s.folder || '我的文档' });
    doc.content = JSON.parse(JSON.stringify(t.content));
    if (s.edit && typeof doc.content.text === 'string') doc.content.text = s.edit(doc.content.text);
    if (s.cells) doc.content.cells = Object.assign({}, doc.content.cells, s.cells);
    doc.rev = 2;
    store.persistDoc(doc);
    store.snapshot(doc, 'admin', 'seed');
    made++;
  }
  /* 给会议纪要挂两条评论：演示协作 / @提醒 / 解决状态 */
  const meeting = store.index.find((d) => d.title === '周会纪要 · 10 月第 4 周');
  if (meeting && !(store.comments[meeting.id] || []).length) {
    const c1 = store.addComment(admin, meeting.id, { text: '@admin 预算表那行还需要财务确认口径，先别锁版本。' });
    if (c1.ok) {
      store.addComment({ username: '小李' }, meeting.id, { text: '口径按「含税」算，我已更新到预算表 B5 公式。', parent: c1.comment.id });
    }
  }
  store.flushAll();
  return made;
}

/* ── 2. 公共盘演示文件 ─────────────────────────────────────── */

function seedPublic() {
  const pub = path.join(dataDir, 'storage', 'public');
  fs.mkdirSync(path.join(pub, '项目资料'), { recursive: true });
  fs.mkdirSync(path.join(pub, '图片'), { recursive: true });

  const put = (rel, body) => {
    const p = path.join(pub, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  put('项目资料/README.md', [
    '# 项目资料',
    '',
    '这个目录放团队的共享材料：需求、纪要、对外文档。',
    '',
    '- `2026-规划.md` — 明年的方向与里程碑',
    '- 上传规则：单个文件 512 MB 以内，超过 64 MB 自动分片',
    '- 回收站保留 30 天，误删可直接还原',
    '',
  ].join('\n'));

  put('项目资料/2026-规划.md', [
    '# 2026 规划',
    '',
    '## 一、目标',
    '把内网里的文件、办公、AI 助手统一到一个入口，数据始终留在自己的机器上。',
    '',
    '## 二、节奏',
    '| 季度 | 主题 | 关键结果 |',
    '| --- | --- | --- |',
    '| Q1 | 打好底座 | 文件 / 权限 / 审计可用 |',
    '| Q2 | 办公协同 | 文档、表格、看板在线协作 |',
    '| Q3 | AI 接入 | 本机模型可换、可停、可审计 |',
    '| Q4 | 体验打磨 | 移动端、快捷键、主题 |',
    '',
    '## 三、原则',
    '1. 数据不出内网',
    '2. 零第三方依赖，离线可跑',
    '3. 每个能力都要有失败兜底',
    '',
  ].join('\n'));

  put('下载说明.txt', [
    '公共盘下载说明',
    '',
    '1. 在「文件管理」里选中文件 → 下载，支持多选打包成 zip',
    '2. 大文件可以断点续传，浏览器关掉再打开会接着传',
    '3. 需要给外部的人看，用「分享管理」生成带密码的限时链接',
    '',
  ].join('\n'));

  /* 示例图：手写一张 320x200 的 PNG（零依赖，不引入图像库） */
  const png = makePng(320, 200);
  put('图片/示例图.png', png);
}

/** 生成一张渐变 + 斜纹的 PNG（用 zlib 手写 IDAT，项目要求零依赖） */
function makePng(w, h) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const stripe = (x + y) % 32 < 2 ? 26 : 0;
      raw[o++] = Math.min(255, Math.round(40 + 150 * t) + stripe);
      raw[o++] = Math.min(255, Math.round(70 + 90 * (1 - t)) + stripe);
      raw[o++] = Math.min(255, Math.round(140 + 90 * t) + stripe);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

/* ── 3. 消息中心数据源 ──────────────────────────────────────── */

/**
 * 消息中心（/messages）不是从一张表里读的，而是**三个真实数据源聚合**：
 *   系统    ← data/notify-log.json（Notifier 告警）
 *   操作    ← data/audit.log，只收 lib/routes/messages.js 里 AUDIT_MAP 登记过的动作
 *   协作    ← data/board.json（协同板）+ data/office/notify.json（办公 @提醒）
 * 所以铺演示数据必须按这些源写，写自己编的 data/notify.json 是没用的（R16.1 踩过）。
 */
function seedMessages() {
  const now = Date.now();
  const at = (min) => new Date(now - min * 60e3).toISOString();

  /* ① 系统告警 */
  fs.writeFileSync(path.join(dataDir, 'notify-log.json'), JSON.stringify([
    { event: 'startup', title: '工作站已就绪', body: '文件、办公、AI 助手、共享服务与安全审计都在这一台机器上运行。', time: at(42), ok: true },
    { event: 'backup', title: '每日备份完成', body: '公共盘与办公文档已增量备份，占用 12.4 MB。', time: at(180), ok: true },
  ], null, 2));

  /* ② 操作消息：往审计日志尾部补几条 AUDIT_MAP 里的动作（保留已有历史） */
  const auditFile = path.join(dataDir, 'audit.log');
  const extra = [
    { ts: at(15), ip: '127.0.0.1', user: 'admin', action: 'share-create', disk: 'public', path: '项目资料/2026-规划.md', ok: true, detail: '有效期 7 天' },
    { ts: at(95), ip: '127.0.0.1', user: 'admin', action: 'snapshot-create', disk: '', path: 'pre-upgrade', ok: true, detail: '升级前快照' },
    { ts: at(240), ip: '10.0.0.23', user: 'anonymous', action: 'login-fail', disk: '', path: '', ok: false, detail: '口令错误（第 1 次）' },
  ];
  let old = '';
  try { old = fs.readFileSync(auditFile, 'utf8'); } catch (e) { old = ''; }
  const lines = old.split('\n').filter((l) => l.trim());
  const seenTs = new Set(lines.map((l) => { try { return JSON.parse(l).ts; } catch (e) { return null; } }));
  const add = extra.filter((e) => !seenTs.has(e.ts)).map((e) => JSON.stringify(e));
  fs.writeFileSync(auditFile, lines.concat(add).join('\n') + '\n');

  /* ③ 协同板 + 办公 @提醒 */
  const boardFile = path.join(dataDir, 'board.json');
  const board = { items: [
    { id: 'seedb1', text: '周会纪要已更新，待办表补完了，大家看一下排期。', kind: 'text', device: '', deviceName: '', user: 'admin', pinned: false, ts: now - 25 * 60e3 },
    { id: 'seedb2', text: '预算表 B5 公式改成含税口径，已同步到团队。', kind: 'text', device: '', deviceName: '', user: '小李', pinned: false, ts: now - 12 * 60e3 },
  ] };
  try {
    const cur = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    if (Array.isArray(cur) ? cur.length : (cur.items || []).length) board.items = (Array.isArray(cur) ? cur : cur.items);
  } catch (e) { /* 没有就新建 */ }
  fs.writeFileSync(boardFile, JSON.stringify(board, null, 2));

  const meeting = store.index.find((d) => d.title === '周会纪要 · 10 月第 4 周');
  if (meeting) {
    store.notifyList.unshift({
      id: 'seedn1', kind: 'mention', title: '小李 在《周会纪要 · 10 月第 4 周》里提到了你',
      body: '@admin 预算表那行还需要财务确认口径，先别锁版本。',
      to: 'admin', from: '小李', docId: meeting.id, docTitle: meeting.title,
      assignee: '', due: '', at: now - 20 * 60e3, read: false,
    });
    store.flushAll();
  }
  return 2 + add.length + 1;
}

/* ── 运行 ─────────────────────────────────────────────────── */

try {
  const docs = seedOffice();
  seedPublic();
  const notes = seedMessages();
  store.flushAll();
  console.log('演示数据就绪：办公文档 ' + store.index.length + ' 篇（新增 ' + docs + '）· 站内消息 ' + notes + ' 条');
  console.log('公共盘：' + path.join(dataDir, 'storage', 'public'));
  console.log('账号仍由 cli.js 管理：node cli.js user:list');
} catch (e) {
  console.error('铺数据失败：', e.message);
  process.exit(1);
}

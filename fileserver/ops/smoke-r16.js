#!/usr/bin/env node
'use strict';

/**
 * ops/smoke-r16.js — 工作站回归冒烟（零依赖，Node 18+）
 *
 * 用法：
 *   BASE=http://127.0.0.1:8081 USER=admin PASS=你的密码 node ops/smoke-r16.js
 *   # 首次（还没有任何账号）：
 *   BASE=http://127.0.0.1:8081 node ops/smoke-r16.js --register
 *
 * 覆盖本轮（R16）修过的每一条，防止回归：
 *   1. 根路径能打开 R15 主界面（曾经 404，整站打不开）
 *   2. 静态资源 gzip / ETag 304 / 深链回落 / 真 404
 *   3. 办公后端全链路（创建 / 实时 op / 版本 / 评论 / 导出 / 导入 / 模板 / 回收站）
 *   4. 文件接口（上传 / 下载 / 重命名 / 复制 / 收藏 / 打包 / 回收站）
 *   5. 游客越权闸门
 *   6. 诊断接口不再把「可选服务缺失」算成故障
 *
 * 退出码：0 全过，1 有失败（可直接挂到 CI / cron）。
 */

const BASE = (process.env.BASE || 'http://127.0.0.1:8081').replace(/\/$/, '');
const USER = process.env.USER || 'admin';
const PASS = process.env.PASS || 'Kx9#mQ2vLp7z';
const DO_REGISTER = process.argv.includes('--register');

let cookie = '';
let pass = 0;
const fails = [];
const warnings = [];

function ok(cond, name, extra) {
  if (cond) { pass++; return true; }
  fails.push(name + (extra ? ' → ' + trim(extra) : ''));
  return false;
}

function trim(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return String(s == null ? '' : s).slice(0, 200);
}

async function req(p, opt = {}) {
  try {
    const r = await fetch(BASE + p, {
      ...opt,
      headers: { ...(opt.headers || {}), ...(cookie ? { cookie } : {}) },
    });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const buf = Buffer.from(await r.arrayBuffer());
    let j = null;
    try { j = JSON.parse(buf.toString('utf8')); } catch { /* 非 JSON */ }
    return { code: r.status, j, buf, h: r.headers };
  } catch (e) {
    return { code: 0, j: null, buf: Buffer.alloc(0), err: String(e && e.message || e) };
  }
}

const J = (p, body) => req(p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});

/* ───────────────────────────── 1. 登录 / 根路径 ───────────────────────────── */

async function stepBoot() {
  let r = await req('/api/me');
  if (DO_REGISTER && r.code === 200 && !r.j.user) {
    r = await req('/api/captcha');
    const svg = (r.j && r.j.svg) || '';
    // 验证码是 SVG 文本，直接从 <text> 里取数字，无需人眼
    const code = [...svg.matchAll(/>(\d)</g)].map((m) => m[1]).join('');
    r = await J('/api/register', { username: USER, password: PASS, captchaId: r.j.id, captchaCode: code });
    ok(r.code === 200 && r.j && r.j.ok, '注册首个管理员账号（' + USER + '）', r.j);
  } else {
    r = await J('/api/login', { username: USER, password: PASS });
    ok(r.code === 200 && r.j && r.j.ok, '登录', r.j);
  }

  r = await req('/');
  ok(r.code === 200 && /深空工作站/.test(r.buf.toString('utf8')), '根路径返回主界面（曾经 404）', { code: r.code });

  /* 主界面入口里声明的 JS 必须真实存在，否则页面白屏 */
  const html = r.buf.toString('utf8');
  const m = /src="(\/app\/assets\/[^"]+\.js)"/.exec(html);
  if (m) {
    const js = await req(m[1]);
    ok(js.code === 200 && js.buf.length > 10000, '主界面 JS 可访问', { path: m[1], code: js.code });
  }
}

/* ───────────────────────────── 2. 静态服务 ───────────────────────────── */

async function stepStatic() {
  const jsPath = '/app/assets/index--2yckYOw.js';
  let r = await req(jsPath);
  if (r.code !== 200) { warnings.push('主界面资源名已变（构建更新），跳过 gzip/304 用例'); return; }
  const plainLen = r.buf.length;

  r = await req(jsPath, { headers: { 'accept-encoding': 'gzip' } });
  ok(r.code === 200 && String(r.h.get('content-encoding') || '') === 'gzip', '文本资源返回 gzip', { code: r.code });
  /* 注意：Node 的 fetch 会自动解压，r.buf 拿到的仍是明文；
     真实传输体积看 Content-Length，别拿 buf.length 判断。 */
  const wire = Number(r.h.get('content-length') || 0);
  ok(wire > 0 && wire < plainLen * 0.6, 'gzip 体积显著下降', { plainLen, wire });

  const etag = r.h.get('etag');
  ok(!!etag, '静态资源带 ETag');
  if (etag) {
    r = await req(jsPath, { headers: { 'if-none-match': etag } });
    ok(r.code === 304, 'ETag 命中返回 304', { code: r.code });
  }

  r = await req('/files');
  ok(r.code === 200 && /text\/html/.test(String(r.h.get('content-type'))), '深链回落 index.html', { code: r.code });

  r = await req('/nope.js');
  ok(r.code === 404, '不存在的资源仍是 404（不被回落掩盖）', { code: r.code });

  r = await req('/games/not-installed/');
  ok(r.code === 404, '未安装的游戏目录不被回落成 200', { code: r.code });
}

/* ───────────────────────────── 3. 办公 ───────────────────────────── */

async function stepOffice() {
  let r = await req('/api/office/health');
  ok(r.code === 200 && r.j && r.j.ok, '办公健康检查（曾经整组 404）', { code: r.code, j: r.j });

  r = await req('/api/office/capability');
  ok(r.code === 200 && r.j && r.j.matrix, '导出能力矩阵');

  r = await req('/api/office/templates');
  ok(r.code === 200 && (r.j.items || []).length >= 10, '模板库');

  /* --- 文档：正文增量 + 并发合并 --- */
  r = await J('/api/office/doc/create', { kind: 'doc', title: '冒烟文档' });
  const docId = r.j && r.j.doc && r.j.doc.id;
  ok(!!docId, '创建文档', r.j);

  await J('/api/office/op', { id: docId, base: 0, op: { t: 'textSync', baseText: '', text: '# 标题\n正文 A' } });
  r = await J('/api/office/op', { id: docId, base: 0, op: { t: 'textSync', baseText: '', text: '并发 B' } });
  ok(r.code === 200, '并发写入不报错', r.j);
  r = await req('/api/office/doc?id=' + docId);
  const text = (r.j && r.j.doc && r.j.doc.content.text) || '';
  ok(text.includes('正文 A') && text.includes('并发 B'), '冲突合并后双方内容都在', text);

  r = await J('/api/office/doc/create', { kind: 'doc', template: 'meeting' });
  ok(r.code === 200 && /会议纪要/.test((r.j.doc.content.text || '')), '快捷创建套用模板（曾经是空白）', r.j && r.j.doc && r.j.doc.title);

  /* --- 表格：op → 行列平移 → 导出 --- */
  r = await J('/api/office/doc/create', { kind: 'sheet', title: '冒烟表格' });
  const sid = r.j.doc.id;
  await J('/api/office/op', { id: sid, base: 0, op: { t: 'cell', cell: 'A1', v: '名称' } });
  await J('/api/office/op', { id: sid, base: 0, op: { t: 'cell', cell: 'A2', v: '3' } });
  await J('/api/office/op', { id: sid, base: 0, op: { t: 'cell', cell: 'B2', v: '6', f: '=A2*2' } });
  r = await J('/api/office/op', { id: sid, base: 0, op: { t: 'sheet', act: 'rowIns', at: 1, n: 1 } });
  ok(r.j && r.j.ok, '插入行');
  r = await req('/api/office/doc?id=' + sid);
  ok((r.j.doc.content.cells.A3 || {}).v === '3', '插入行后单元格下移', r.j.doc.content.cells);
  ok((r.j.doc.content.cells.B3 || {}).f === '=A3*2', '公式引用随行插入平移', r.j.doc.content.cells.B3);

  for (const fmt of ['csv', 'xlsx', 'md', 'html', 'pdf']) {
    r = await req('/api/office/export?id=' + sid + '&format=' + fmt);
    ok(r.code === 200 && r.buf.length > 20, '表格导出 ' + fmt, { code: r.code, len: r.buf.length });
    if (fmt === 'xlsx') ok(r.buf.slice(0, 2).toString() === 'PK', 'xlsx 是合法 ZIP 容器');
  }
  r = await req('/api/office/export?id=' + docId + '&format=docx');
  ok(r.code === 200 && r.buf.slice(0, 2).toString() === 'PK', '文档导出 docx');

  /* --- 导入 --- */
  r = await req('/api/office/import?name=smoke.csv', {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: '城市,人口\n上海,2487\n北京,2185',
  });
  ok(r.code === 200 && r.j.doc.kind === 'sheet', '导入 CSV 生成表格', r.j);

  /* --- 其它 kind：创建 + 一条 op + 导出 md --- */
  const kinds = {
    board: { t: 'board', act: 'card.add', card: { text: '卡片', col: 'todo' } },
    mind: { t: 'mind', act: 'node.add', node: { text: '子节点' } },
    note: { t: 'note', act: 'note.add', note: { text: '便签' } },
    slide: { t: 'slide', act: 'slide.add', index: 1 },
    flow: { t: 'flow', act: 'node.add', node: { text: '开始', x: 10, y: 10 } },
    form: { t: 'form', act: 'field.add', field: { label: '姓名', type: 'text' } },
    poster: { t: 'poster', act: 'add', el: { type: 'text', text: '标题', x: 10, y: 10, w: 200, h: 80 } },
  };
  for (const [kind, op] of Object.entries(kinds)) {
    r = await J('/api/office/doc/create', { kind, title: '冒烟' + kind });
    const id = r.j && r.j.doc && r.j.doc.id;
    if (!ok(!!id, '创建 ' + kind, r.j)) continue;
    r = await J('/api/office/op', { id, base: 0, op });
    ok(r.code === 200 && r.j.ok, '操作 ' + kind, r.j);
    r = await req('/api/office/export?id=' + id + '&format=md');
    ok(r.code === 200 && r.buf.length > 10, '导出 ' + kind + ' md');
  }

  /* --- 评论 / 通知 / 版本 / 回收站 --- */
  r = await J('/api/office/comments/add', { id: docId, text: '@admin 冒烟评论' });
  ok(r.code === 200 && r.j.comment, '添加评论', r.j);
  r = await req('/api/office/comments?id=' + docId);
  ok((r.j.comments || []).length >= 1, '评论列表');

  r = await J('/api/office/version/snapshot', { id: docId, reason: 'smoke' });
  const rev = r.j && r.j.version && r.j.version.rev;
  ok(!!rev, '版本快照', r.j);
  r = await J('/api/office/version/restore', { id: docId, rev });
  ok(r.code === 200 && r.j.ok, '版本回滚', r.j);

  r = await J('/api/office/doc/meta', { id: docId, title: '冒烟改名', fav: true });
  ok(r.j && r.j.doc && r.j.doc.title === '冒烟改名', '改名', r.j);
  r = await req('/api/office/docs?scope=fav');
  ok((r.j.items || []).some((x) => x.id === docId), '收藏筛选');

  r = await J('/api/office/doc/remove', { id: docId });
  ok(r.j && r.j.trashed, '删除进回收站', r.j);
  r = await req('/api/office/docs?scope=trash');
  ok((r.j.items || []).some((x) => x.id === docId), '回收站列表');
  r = await J('/api/office/trash/restore', { id: docId });
  ok(r.code === 200 && r.j.ok, '回收站恢复', r.j);

  r = await req('/api/share/list');
  ok(r.code === 200, '分享列表（曾被 /api/share/<token> 抢先命中）', { code: r.code });
}

/* ───────────────────────────── 4. 文件 ───────────────────────────── */

async function stepFiles() {
  const dir = 'smoke-' + Date.now().toString(36);
  let r = await J('/api/mkdir', { scope: 'public', path: '', name: dir });
  ok(r.code === 200, '创建目录', r.j);

  const fd = new FormData();
  fd.append('scope', 'public');
  fd.append('path', dir);
  fd.append('files', new Blob(['hello smoke']), 'a.txt');
  r = await req('/api/upload', { method: 'POST', body: fd });
  ok(r.code === 200 && (r.j.uploaded || []).length === 1, 'multipart 上传', r.j);

  r = await req('/api/list?scope=public&path=' + dir);
  ok(r.code === 200 && (r.j.entries || []).some((e) => e.name === 'a.txt'), '列表', r.j);

  r = await req('/api/files/raw?scope=public&path=' + dir + '/a.txt&inline=1');
  ok(r.code === 200 && r.buf.toString() === 'hello smoke', '下载内容一致', { code: r.code });

  r = await J('/api/rename', { scope: 'public', path: dir + '/a.txt', name: 'b.txt' });
  ok(r.code === 200, '重命名', r.j);
  r = await J('/api/copy', { scope: 'public', path: dir + '/b.txt', dest: dir + '/c.txt' });
  ok(r.code === 200, '复制', r.j);
  r = await J('/api/files/favorite', { scope: 'public', path: dir + '/b.txt', on: true });
  ok(r.code === 200, '收藏', r.j);
  r = await J('/api/files/zip', { scope: 'public', paths: [dir] });
  ok(r.code === 200 && r.buf.slice(0, 2).toString() === 'PK', '批量打包', { code: r.code });
  r = await J('/api/files/share', { scope: 'public', path: dir + '/b.txt', hours: 1 });
  ok(r.code === 200 && (r.j.token || r.j.url), '创建分享', r.j);
  r = await J('/api/delete', { scope: 'public', path: dir + '/c.txt' });
  ok(r.code === 200, '删除（进回收站）', r.j);
  r = await req('/api/recycle?scope=public');
  ok(r.code === 200, '回收站列表', { code: r.code });
}

/* ───────────────────────────── 5. 安全 / 诊断 ───────────────────────────── */

async function stepGuard() {
  const saved = cookie;
  cookie = '';
  const list = ['/api/office/docs', '/api/office/notify', '/api/admin/users', '/api/security/users', '/api/smb/users', '/api/files/shares', '/api/r15/diagnostics'];
  for (const p of list) {
    const r = await req(p);
    ok([401, 403].includes(r.code), '游客拦截 ' + p, { code: r.code });
  }
  cookie = saved;

  const r = await req('/api/r15/diagnostics');
  ok(r.code === 200, '诊断接口');
  ok(r.j && r.j.checks && r.j.checks.office && r.j.checks.office.ok, '诊断包含办公文档库检查', r.j && r.j.checks);
  ok(!(r.j.failed || []).includes('sambDb'), 'Samba 缺失不再判为故障（可选项）', r.j && r.j.failed);
}

/* ───────────────────────────── main ───────────────────────────── */

(async () => {
  console.log('冒烟目标：' + BASE + '（用户 ' + USER + '）\n');
  await stepBoot();
  await stepStatic();
  await stepOffice();
  await stepFiles();
  await stepGuard();

  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (warnings.length) console.log('提示：\n  ' + warnings.join('\n  '));
  if (fails.length) {
    console.log('\n失败明细：');
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('\n✓ 全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('冒烟脚本异常：', e);
  process.exit(1);
});

'use strict';

/* =====================================================================
   lib/apidoc.js — API v1（API Key 认证）+ 自描述文档页
   挂载：/api/v1/*（数据端点，全部需 Key）与 /api/doc（文档页，免 Key）
   认证：请求头 X-API-Key 或查询串 ?apikey=；Key 首次访问自动生成，
         存于 <dataDir>/apikey.json {"key": "<32hex>"}，错误一律 401 JSON
   端点：GET health / disks / list / download / meta（meta 自描述）
   说明：不改动 server.js，路由层只需把 pathname 交给本类 handle()

   R9-P1-9：身份里**不得**硬编码 role:'admin'。
     此前用户级 Key 一律被赋予 admin 身份（虽然 this.user 当时无人读取，
     但这是个提权地雷：任何一处开始读它，就是一次完整提权）。
     现在角色一律取自真实用户记录，取不到就降级为普通用户。
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendJSON, mimeOf } = require('./util');

/** 隐藏的系统目录（对 API 不可见） */
const HIDDEN = new Set(['.recycle', '.versions', '.snapshots']);

/* R9-P0-4：apikey.json 里存的是「拿到即用」的凭据，文件必须 0600 */
const SECRET_FILE_MODE = 0o600;

class ApiV1 {
  /** @param {object} srv FileServer 实例（用到 srv.cfg.dataDir / resolveTarget / listDisks 等） */
  constructor(srv) {
    this.srv = srv;
    this.keyFile = path.join(srv.cfg.dataDir, 'apikey.json');
  }

  /* ------------------------------ API Key ------------------------------ */

  /** 读取 Key；文件不存在则首次自动生成 32 位 hex 并落盘 */
  loadKey() {
    try {
      const j = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
      if (j && typeof j.key === 'string' && j.key) return j.key;
    } catch { /* 首次 */ }
    const key = crypto.randomBytes(16).toString('hex');
    try {
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
      /* R9-P0-4：Key 文件必须 0600。writeFileSync 的 mode 只在**创建**时生效，
         文件已存在时不会改权限 —— 所以落盘后再 chmod 一次。 */
      fs.writeFileSync(this.keyFile, JSON.stringify({ key }, null, 2), { mode: SECRET_FILE_MODE });
      try { fs.chmodSync(this.keyFile, SECRET_FILE_MODE); } catch { /* 某些文件系统不支持 */ }
    } catch (e) { console.error('[apiv1] 写入 apikey.json 失败:', e.message); }
    return key;
  }

  /** 校验 X-API-Key 头或 ?apikey=；通过返回 true。
   *  v3：同时接受主站 /api/keys 签发的用户 Key（keys.json），身份映射为其 owner。
   *  R9-P1-9：身份里的 role 一律取自**真实用户记录**，绝不硬编码 admin。 */
  authed(req, query) {
    const v = req.headers['x-api-key'] || query.apikey || '';
    if (!v) return false;
    const key = this.loadKey();
    // 双 hash 常量时间比较，避免逐字符短路泄露前缀
    const a = crypto.createHash('sha256').update(String(v)).digest();
    const b = crypto.createHash('sha256').update(key).digest();
    if (crypto.timingSafeEqual(a, b)) {
      /* 主 Key 的身份是「机器账号」，role 为普通用户 —— 它不是管理员。
         注意：数据端点目前仍以匿名身份（resolveTarget(..., null)）解析路径，
         配合收紧后的默认 ACL，主 Key 只能读公共盘。
         「主 Key 应限定可访问盘/目录」需要 server.js 配合改造，
         详见交付报告（本次不扩大改动面）。 */
      this.user = { id: 'api:main', username: 'api-key', role: 'user', viaKey: true, master: true };
      return true;
    }
    // 兼容主站 API Key（keys.json：/api/keys 生成，token 字段）
    try {
      const k = this.srv.keyCheck(String(v));
      if (k) {
        /* R9-P1-9：角色必须来自真实用户记录；查不到用户就降级为普通用户，
           绝不因为「拿着一个 Key」就当成 admin。 */
        let role = 'user';
        try {
          const owner = this.srv.users && typeof this.srv.users.findByName === 'function'
            ? this.srv.users.findByName(String(k.owner || ''))
            : null;
          if (owner && owner.role === 'admin') role = 'admin';
        } catch { /* 用户库不可用 → 保持普通用户 */ }
        this.user = { id: 'api:' + k.id, username: k.owner, role, viaKey: true };
        return true;
      }
    } catch (e) { /* keys 系统不可用时忽略 */ }
    return false;
  }

  /* ------------------------------ 路由入口 ------------------------------ */

  /**
   * 处理 /api/v1/* 与 /api/doc；不属于自己的路径返回 false（由主路由继续）。
   * @returns {Promise<boolean>} 是否已接管响应
   */
  async handle(req, res, pathname, query) {
    // 文档页免 Key
    if (pathname === '/api/doc' && req.method === 'GET') {
      const buf = Buffer.from(DOC_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      res.end(buf);
      return true;
    }

    if (pathname !== '/api/v1' && !pathname.startsWith('/api/v1/')) return false;

    // 全部数据端点先验 Key
    if (!this.authed(req, query)) {
      sendJSON(res, 401, {
        error: '无效或缺失 API Key：请带请求头 X-API-Key，或查询参数 ?apikey=（Key 见 data/apikey.json）',
      });
      return true;
    }

    const m = req.method;

    if (pathname === '/api/v1/health' && m === 'GET') {
      sendJSON(res, 200, { ok: true, uptime: Math.round(process.uptime()), version: 'v1' });
      return true;
    }

    if (pathname === '/api/v1/disks' && m === 'GET') {
      sendJSON(res, 200, { disks: this.srv.listDisks(null) });
      return true;
    }

    if (pathname === '/api/v1/list' && m === 'GET') {
      return this.handleList(res, query);
    }

    if (pathname === '/api/v1/download' && m === 'GET') {
      return this.handleDownload(req, res, query);
    }

    if (pathname === '/api/v1/meta' && m === 'GET') {
      sendJSON(res, 200, {
        version: 'v1',
        auth: '请求头 X-API-Key 或查询参数 ?apikey=（Key 见服务器 data/apikey.json）',
        endpoints: [
          { method: 'GET', path: '/api/v1/health', desc: '健康检查：{ok,uptime,version}' },
          { method: 'GET', path: '/api/v1/disks', desc: '盘符列表：{disks:[...]}' },
          { method: 'GET', path: '/api/v1/list?disk=&path=', desc: '目录列表，disk=public|private|ext:<UUID>' },
          { method: 'GET', path: '/api/v1/download?disk=&path=', desc: '流式下载文件' },
          { method: 'GET', path: '/api/v1/meta', desc: '本接口自描述' },
        ],
      });
      return true;
    }

    sendJSON(res, 404, { error: '接口不存在，见 GET /api/v1/meta 或文档页 /api/doc' });
    return true;
  }

  /* ------------------------------ 目录列表 ------------------------------ */

  handleList(res, query) {
    const t = this.srv.resolveTarget({ disk: query.disk || 'public', path: query.path || '' }, null);
    if (t.error) return sendJSON(res, t.code || 400, { error: t.error });

    let st = null;
    try { st = fs.statSync(t.abs); } catch { return sendJSON(res, 404, { error: '目录不存在' }); }
    if (!st.isDirectory()) return sendJSON(res, 400, { error: '路径不是目录' });

    let names = [];
    try { names = fs.readdirSync(t.abs); } catch (e) { return sendJSON(res, 500, { error: e.message }); }

    const entries = [];
    for (const name of names.slice(0, 5000)) {
      if (HIDDEN.has(name)) continue;
      let s2 = null;
      try { s2 = fs.statSync(path.join(t.abs, name)); } catch { continue; }
      entries.push({
        name,
        isDir: s2.isDirectory(),
        size: s2.isDirectory() ? 0 : s2.size,
        mtime: Math.floor(s2.mtimeMs),
      });
    }
    // 目录在前，各自按名称排序
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : (a.isDir ? -1 : 1)));
    return sendJSON(res, 200, { disk: query.disk || 'public', path: query.path || '', entries });
  }

  /* ------------------------------ 流式下载 ------------------------------ */

  handleDownload(req, res, query) {
    const t = this.srv.resolveTarget({ disk: query.disk || 'public', path: query.path || '' }, null);
    if (t.error) return sendJSON(res, t.code || 400, { error: t.error });

    let st = null;
    try { st = fs.statSync(t.abs); } catch { return sendJSON(res, 404, { error: '文件不存在' }); }
    if (!st.isFile()) return sendJSON(res, 400, { error: '路径不是文件' });

    const name = path.basename(t.abs);
    res.writeHead(200, {
      'Content-Type': mimeOf(name),
      'Content-Length': st.size,
      // RFC 5987：filename* 携带 UTF-8 原名（主流浏览器均支持）
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
    });
    const stream = fs.createReadStream(t.abs, { highWaterMark: 1 << 20 });
    stream.on('error', () => { try { res.destroy(); } catch { /* 连接已断 */ } });
    stream.pipe(res);
  }
}

/* ============================== 文档页（内嵌 HTML，深色终端风） ============================== */
const DOC_HTML = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
  '<title>局域网NAS · API v1 文档</title>',
  '<style>',
  ':root{--bg:#0f1115;--panel:#161a22;--line:#262c38;--txt:#d6dde8;--dim:#7d8797;--acc:#5c9dff;--ok:#34d399;--warn:#fbbf24;}',
  '*{box-sizing:border-box;margin:0;padding:0}',
  'body{background:var(--bg);color:var(--txt);font:14px/1.7 ui-monospace,Consolas,"Cascadia Mono","Microsoft YaHei",monospace;padding:32px 16px;}',
  '.wrap{max-width:860px;margin:0 auto;}',
  'h1{font-size:20px;margin-bottom:4px;}',
  'h1::before{content:"$ ";color:var(--ok);}',
  '.sub{color:var(--dim);margin-bottom:24px;}',
  'section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:18px;}',
  'h2{font-size:14px;color:var(--acc);margin-bottom:10px;text-transform:uppercase;letter-spacing:1px;}',
  'table{width:100%;border-collapse:collapse;font-size:13px;}',
  'th,td{text-align:left;padding:6px 8px;border-bottom:1px dashed var(--line);vertical-align:top;}',
  'th{color:var(--dim);font-weight:normal;}',
  'code{background:#0b0e13;border:1px solid var(--line);border-radius:5px;padding:2px 6px;color:var(--ok);word-break:break-all;}',
  'pre{background:#0b0e13;border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:13px;line-height:1.8;}',
  'pre b{color:var(--warn);font-weight:normal;}',
  '.note{color:var(--dim);font-size:12.5px;margin-top:10px;}',
  '.m{color:var(--warn);}',
  '</style>',
  '</head>',
  '<body><div class="wrap">',
  '<h1>局域网NAS REST API v1</h1>',
  '<div class="sub">面向脚本 / 自动化的只读接口 · 全部返回 JSON（下载除外）</div>',

  '<section><h2>认证</h2>',
  '<p>除 <code>/api/doc</code> 外，所有端点均需携带 API Key：</p>',
  '<pre>请求头方式：  <b>X-API-Key: &lt;key&gt;</b>\n查询串方式：  <b>?apikey=&lt;key&gt;</b></pre>',
  '<p class="note">Key 为 32 位十六进制串，首次调用任意端点时自动生成，</p>',
  '<p class="note">保存在服务器 <code>data/apikey.json</code>（{"key":"..."}）。Key 丢失删除该文件重启即可重新生成。</p>',
  '</section>',

  '<section><h2>端点</h2>',
  '<table>',
  '<tr><th>方法</th><th>路径</th><th>说明</th></tr>',
  '<tr><td class="m">GET</td><td><code>/api/v1/health</code></td><td>健康检查，返回 {ok, uptime, version}</td></tr>',
  '<tr><td class="m">GET</td><td><code>/api/v1/disks</code></td><td>盘符列表（公共盘 / 外置硬盘，含用量）</td></tr>',
  '<tr><td class="m">GET</td><td><code>/api/v1/list?disk=public&amp;path=</code></td><td>目录列表；disk = public | ext:UUID（自动隐藏 .recycle/.versions/.snapshots）</td></tr>',
  '<tr><td class="m">GET</td><td><code>/api/v1/download?disk=public&amp;path=a.txt</code></td><td>流式下载文件（Content-Disposition: filename*）</td></tr>',
  '<tr><td class="m">GET</td><td><code>/api/v1/meta</code></td><td>接口自描述（机器可读的端点清单）</td></tr>',
  '<tr><td class="m">GET</td><td><code>/api/doc</code></td><td>本页（免 Key）</td></tr>',
  '</table>',
  '<p class="note">错误统一为 JSON：401 未认证 / 400 参数或路径不合法 / 404 不存在。</p>',
  '</section>',

  '<section><h2>curl 示例</h2>',
  '<pre># 健康检查\n',
  'curl -H "X-API-Key: <b>$KEY</b>" http://127.0.0.1:8081/api/v1/health\n\n',
  '# 列出盘符\n',
  'curl -H "X-API-Key: <b>$KEY</b>" http://127.0.0.1:8081/api/v1/disks\n\n',
  '# 列出公共盘根目录\n',
  'curl -H "X-API-Key: <b>$KEY</b>" "http://127.0.0.1:8081/api/v1/list?disk=public&amp;path="\n\n',
  '# 下载文件\n',
  'curl -H "X-API-Key: <b>$KEY</b>" -o out.txt "http://127.0.0.1:8081/api/v1/download?disk=public&amp;path=notes.txt"</pre>',
  '<p class="note">HTTPS 部署时加 -k 跳过自签名证书校验；$KEY 替换为 apikey.json 中的 key。</p>',
  '</section>',

  '</div></body>',
  '</html>',
].join('\n');

module.exports = { ApiV1 };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  let fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apidoctest-'));
  const mkSrv = (users, keyOwner) => ({
    cfg: { dataDir: tmpDir },
    users: { findByName: (n) => users.find((u) => u.username === n) || null },
    keyCheck: (v) => (v === 'userkey' ? { id: 'k1', owner: keyOwner || 'dav', token: 'userkey' } : null),
  });

  // 主 Key：身份不是 admin
  const srv1 = mkSrv([{ username: 'dav', role: 'user' }]);
  const api1 = new ApiV1(srv1);
  const mainKey = api1.loadKey();
  check('主 Key 认证通过', api1.authed({ headers: { 'x-api-key': mainKey } }, {}), true);
  check('主 Key 身份不是 admin', api1.user.role, 'user');

  // 用户级 Key：角色来自真实用户记录
  const srv2 = mkSrv([{ username: 'dav', role: 'user' }]);
  const api2 = new ApiV1(srv2);
  check('用户级 Key 认证通过', api2.authed({ headers: { 'x-api-key': 'userkey' } }, {}), true);
  check('用户级 Key 角色为 user', api2.user.role, 'user');

  const srv3 = mkSrv([{ username: 'Dozin', role: 'admin' }], 'Dozin');
  const api3 = new ApiV1(srv3);
  api3.authed({ headers: { 'x-api-key': 'userkey' } }, {});
  check('owner 是 admin 时角色为 admin', api3.user.role, 'admin');

  // 查不到 owner → 降级为普通用户（不得提权）
  const srv4 = mkSrv([]);
  const api4 = new ApiV1(srv4);
  api4.authed({ headers: { 'x-api-key': 'userkey' } }, {});
  check('owner 不存在时降级为 user', api4.user.role, 'user');

  // 错误 Key 不得通过
  const api5 = new ApiV1(mkSrv([]));
  check('错误 Key 被拒', api5.authed({ headers: { 'x-api-key': 'nope' } }, {}), false);

  // R9-P0-4：apikey.json 权限（Windows 只能表达只读标志，故仅 POSIX 断言）
  const posix = process.platform !== 'win32';
  const mode = fs.statSync(path.join(tmpDir, 'apikey.json')).mode & 0o777;
  console.log(`      apikey.json 实际权限 = 0${mode.toString(8)}`);
  check('apikey.json 权限 0600', posix ? mode : 'skip-win32', posix ? 0o600 : 'skip-win32');

  console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

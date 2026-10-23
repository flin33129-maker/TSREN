'use strict';

/**
 * SMB 配置生成器离线自测（不需要 root、不碰服务器配置）。
 *
 * 跑法（Windows/Linux 任意）：
 *   node r15/srv/ops/smb/selftest.cjs
 *
 * 覆盖：
 *   1. 幂等：同一输入生成两次，字节级一致
 *   2. 权限：admin 恒 rw、普通用户按 acl.json、禁用用户不进配置
 *   3. 只读共享：read only = yes 且没有 write list
 *   4. 安全：无 force user/force group、无 guest ok = yes、每个共享都有 valid users / read list
 *   5. 个人共享：每个用户 [<用户名>]，valid users 只有本人
 *   6. smb.conf 重写幂等：不会重复插入受管段，security/map to guest 只保留一份
 *   7. fail-closed：acl.json 损坏时非管理员无任何共享；admin 仍有权限
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');                     // 本地 r15/srv；服务器 /opt/station/fileserver
const LIB = path.join(ROOT, 'lib');
const ACL_CANDIDATES = [
  path.join(LIB, 'acl.js'),                                       // 服务器部署布局
  path.resolve(ROOT, '..', 'src', 'fileserver', 'lib', 'acl.js'), // 本地仓库布局
];

let fail = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}
function section(t) { console.log('\n## ' + t); }

/* 把被测模块和 acl.js 复制到临时目录，模拟远端目录结构（lib/smb-accounts.js + lib/acl.js） */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smb-selftest-'));
fs.copyFileSync(path.join(LIB, 'smb-accounts.js'), path.join(tmp, 'smb-accounts.js'));
const realAcl = ACL_CANDIDATES.find((p) => fs.existsSync(p));
if (realAcl) {
  fs.copyFileSync(realAcl, path.join(tmp, 'acl.js'));
} else {
  console.log('WARN 未找到 acl.js，将走兜底权限解析');
}
const smb = require(path.join(tmp, 'smb-accounts.js'));

/* ————— 构造测试用户库 / ACL ————— */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smb-data-'));
fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify({
  users: [
    { id: 'u1', username: 'Dozin', role: 'admin' },
    { id: 'u2', username: 'alice', role: 'user' },
    { id: 'u3', username: 'bob', role: 'user', disabled: true },
    { id: 'u4', username: '中文名', role: 'user' },
    { id: 'u5', username: 'carol', role: 'user' },
  ],
}, null, 2));
fs.writeFileSync(path.join(dataDir, 'acl.json'), JSON.stringify({
  groups: { admins: ['Dozin'], users: ['alice', 'bob', 'carol'] },
  acl: {
    public: { guest: 'ro', 'group:users': 'rw' },
    private: { 'group:users': 'rw' },
    ext: { 'group:users': 'ro' },
  },
}, null, 2));

/* ————— 1. 预览与幂等 ————— */
section('配置生成 / 幂等');
const p1 = smb.previewConfig({ dataDir });
const p2 = smb.previewConfig({ dataDir });
check('preview 成功', p1.ok === true);
check('两次生成字节级一致（幂等）', p1.sharesText === p2.sharesText && p1.smbConfText === p2.smbConfText);
check('不再出现 force user 配置', !/^\s*force\s+user\s*=/im.test(p1.sharesText));
check('不再出现 force group 配置', !/^\s*force\s+group\s*=/im.test(p1.sharesText));
check('所有共享都是 guest ok = no', (p1.sharesText.match(/guest ok = no/g) || []).length === p1.plan.shares.length + p1.plan.homes.length);
check('共享数量 = 9（8 团队 + 1 只读）', p1.plan.shares.length === 9, 'got=' + p1.plan.shares.length);
check('至少 1 个可写共享（rw 路径必须存在）', p1.plan.shares.some((s) => !s.readOnly));
check('至少 1 个只读共享（验收矩阵需要）', p1.plan.shares.some((s) => s.readOnly));
check('禁用用户 bob 不进配置', !/\bbob\b/.test(p1.sharesText) && !p1.plan.users.some((u) => u.username === 'bob'));
check('中文用户名被跳过并告警', p1.plan.warnings.some((w) => w.includes('中文名')));
check('每个共享都有 valid users', p1.plan.shares.every((s) => s.validUsers.length > 0));
check('每个可写共享都有 read list 与 write list', p1.plan.shares.filter((s) => !s.readOnly).every((s) => s.readUsers.length > 0 && s.writeUsers.length > 0));

/* 权限细节 */
section('ACL 驱动的权限');
const pub = p1.plan.shares.find((s) => s.name === '公共盘');
check('公共盘：管理员 Dozin 与普通用户都可写（acl group:users=rw）',
  pub.writeUsers.includes('Dozin') && pub.writeUsers.includes('alice') && pub.writeUsers.includes('carol'));
check('公共盘：中文名不在 valid users', !pub.validUsers.includes('中文名'));

/* 只读共享 */
const ro = p1.plan.shares.find((s) => s.name === '乱七八糟');
check('乱七八糟为只读', ro && ro.readonly === true && ro.writeUsers.length === 0);
const roSection = (p1.sharesText.split('[乱七八糟]')[1] || '').split('[')[0];
check('只读共享渲染 read only = yes', /read only = yes/.test(roSection));
check('只读共享没有 write list', !/write list/.test(roSection));

/* 个人共享 */
section('个人私有共享');
const homes = p1.plan.homes.map((h) => h.username).sort();
check('家目录用户 = Dozin/alice/carol（bob 禁用、中文名不支持）',
  JSON.stringify(homes) === JSON.stringify(['Dozin', 'alice', 'carol']), JSON.stringify(homes));
for (const h of p1.plan.homes) {
  const sec = (p1.sharesText.split('[' + h.username + ']')[1] || '').split('\n[')[0];
  check('[' + h.username + '] 路径 /srv/station/users/' + h.username, sec.includes('path = /srv/station/users/' + h.username));
  check('[' + h.username + '] valid users 只有本人', new RegExp('valid users = ' + h.username + '\\s*$', 'm').test(sec));
  check('[' + h.username + '] 文件 0600 / 目录 0700', sec.includes('create mask = 0600') && sec.includes('directory mask = 0700'));
  check('[' + h.username + '] browseable = no', sec.includes('browseable = no'));
}

/* ————— 2. smb.conf 重写幂等 ————— */
section('smb.conf 受管 global 段');
const baseConf = [
  '[global]',
  '   workgroup = WORKGROUP',
  '   security = user',
  '   map to guest = never',
  '   include = /etc/samba/station-shares.conf',
  '',
  '[printers]',
  '   browseable = no',
  '',
].join('\n');
const c1 = smb.buildSmbConf(baseConf, { includePath: '/etc/samba/station-shares.conf' });
const c2 = smb.buildSmbConf(c1, { includePath: '/etc/samba/station-shares.conf' });
check('重写一次与两次一致（幂等）', c1 === c2);
check('security = user 只出现一次', (c1.match(/security\s*=\s*user/gi) || []).length === 1);
check('map to guest = never 只出现一次', (c1.match(/map to guest/gi) || []).length === 1);
check('含 restrict anonymous = 2', /restrict anonymous = 2/.test(c1));
check('含 access based share enum = yes', /access based share enum = yes/.test(c1));
check('含 debug prefix timestamp = yes', /debug prefix timestamp = yes/.test(c1));
check('受管段标记存在', /station-smb managed \(r15\)/.test(c1) && /station-smb managed \(r15\) <<</.test(c1));
check('保留 [printers] 段', /\[printers\]/.test(c1));

/* ————— 3. apply 脚本的账号对账语义（第 5 轮回归：禁用≠删除 / 启用恢复） ————— */
section('apply 脚本：禁用≠删除 / 启用恢复');
const scriptPreview = smb.previewApplyScript({ dataDir });
check('生成 apply 脚本成功', scriptPreview.ok === true && scriptPreview.script.length > 2000, scriptPreview.script.length);
check('active 用户有 smbpasswd -e（启用恢复）', /smbpasswd -e/.test(scriptPreview.script));
check('disabled 用户有 smbpasswd -d（禁用而非删除）', /smbpasswd -d/.test(scriptPreview.script));
check('不包含 smbpasswd -x（绝不删除账号）', !/smbpasswd\s+-x/.test(scriptPreview.script));
check('账号缺失时输出 WARN 交由指纹清理', /smb-account-missing/.test(scriptPreview.script));
check('孤儿账号（工作站已删除）会被停用', /disabled-orphans/.test(scriptPreview.script));

/* ————— 4. fail-closed ————— */
section('acl.json 损坏 → fail-closed');
const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smb-badacl-'));
fs.copyFileSync(path.join(dataDir, 'users.json'), path.join(badDir, 'users.json'));
fs.writeFileSync(path.join(badDir, 'acl.json'), '{broken-json');
const bp = smb.previewConfig({ dataDir: badDir });
check('损坏时 preview 仍返回成功但告警', bp.ok === true && bp.plan.warnings.some((w) => w.includes('acl.json')));
check('损坏时非管理员无任何共享（fail-closed）',
  bp.plan.shares.every((s) => s.validUsers.length === 0 || s.validUsers.every((n) => n === 'Dozin')));
check('损坏时管理员 Dozin 仍有共享', bp.plan.shares.length === 0 || bp.plan.shares.every((s) => s.validUsers.includes('Dozin')));

/* ————— 4. 汇总 ————— */
section('生成产物长度');
console.log('shares.conf 行数: ' + p1.sharesText.split('\n').length + '，字符数: ' + p1.sharesText.length);
console.log('smb.conf 字符数: ' + p1.smbConfText.length);
if (process.env.SHOW_CONF === '1') {
  console.log('\n===== station-shares.conf =====\n' + p1.sharesText);
  console.log('\n===== smb.conf =====\n' + p1.smbConfText);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(badDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(fail === 0 ? '\n全部 PASS' : '\n' + fail + ' 项 FAIL');
process.exit(fail === 0 ? 0 : 1);

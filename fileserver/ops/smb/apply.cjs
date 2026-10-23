#!/usr/bin/env node
'use strict';

/**
 * 命令行入口：重建 SMB 共享配置（幂等）。
 *
 *   node ops/smb/apply.cjs --dry-run             # 只预览，不写盘、不 reload
 *   node ops/smb/apply.cjs --dry-run --stdout    # 打印将生成的 station-shares.conf / smb.conf
 *   node ops/smb/apply.cjs --print-script        # 打印 root 侧 apply 脚本（用于 bash -n 审查）
 *   sudo node ops/smb/apply.cjs                  # 真正应用（root 直接执行，不套 sudo）
 *   node ops/smb/apply.cjs --force-perms         # 强制递归修正共享目录组权限
 *
 * 数据源：<dataDir>/users.json + <dataDir>/acl.json + /etc/samba/station-smb-shares.json
 * 默认 dataDir = /opt/station/fileserver/data（可用 --data 覆盖）
 */

const path = require('path');
const accounts = require(path.resolve(__dirname, '..', '..', 'lib', 'smb-accounts.js'));

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run') || argv.includes('-n');
const stdout = argv.includes('--stdout');
const printScript = argv.includes('--print-script');
const forcePerms = argv.includes('--force-perms');
const dataIdx = argv.indexOf('--data');
const dataDir = dataIdx >= 0 ? argv[dataIdx + 1] : undefined;

function brief(plan, pv) {
  return {
    ok: true,
    dryRun: true,
    changed: pv.changed,
    configHash: pv.configHash,
    sources: pv.sources,
    warnings: plan.warnings,
    shares: plan.shares.map((s) => ({
      name: s.name, path: s.path, acl: s.acl, readOnly: s.readOnly,
      validUsers: s.validUsers, writeUsers: s.writeUsers,
    })),
    homes: plan.homes.map((h) => h.username),
    users: plan.users.map((u) => u.username),
  };
}

if (printScript) {
  const r = accounts.previewApplyScript({ dataDir, forcePerms });
  process.stdout.write(r.script);
  process.exit(0);
}

if (dryRun) {
  const pv = accounts.previewConfig({ dataDir });
  if (stdout) {
    console.log('===== /etc/samba/station-shares.conf =====\n' + pv.sharesText);
    console.log('\n===== /etc/samba/smb.conf =====\n' + pv.smbConfText);
  } else {
    console.log(JSON.stringify(brief(pv.plan, pv), null, 2));
  }
  process.exit(0);
}

const r = accounts.applyConfig({
  dataDir,
  reason: 'cli',
  actor: process.env.SUDO_USER || process.env.USER || 'cli',
  forcePerms,
});
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);

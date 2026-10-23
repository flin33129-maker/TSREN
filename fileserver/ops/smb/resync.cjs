#!/usr/bin/env node
'use strict';

/**
 * 自愈对账 CLI（第 5 轮新增）：对账 → 修复 → 再对账。
 *
 *   node ops/smb/resync.cjs               # 对账 + 自动修复（幂等）
 *   node ops/smb/resync.cjs --dry-run     # 只看对账结果，不修复
 *   node ops/smb/resync.cjs --force-perms # 同时递归修正共享目录组权限
 *
 * 修复内容：
 *   - 禁用→启用后 Samba 账号仍带 D 标志 → smbpasswd -e 恢复（禁用 ≠ 删除）
 *   - 被误删/缺失的 Linux 账号、私有家目录、共享配置 → 补齐/重写
 *   - 已删除用户的 Samba 孤儿账号 → smbpasswd -d
 *   - 账号缺失且无法反推密码时：清 smb-sync 指纹，下次网页登录自动重建密码
 *
 * 退出码：0 = 修复后无漂移；1 = 仍有未修复项（详情看 JSON）。
 */

const path = require('path');
const accounts = require(path.resolve(__dirname, '..', '..', 'lib', 'smb-accounts.js'));

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run') || argv.includes('-n');
const forcePerms = argv.includes('--force-perms');
const dataIdx = argv.indexOf('--data');
const dataDir = dataIdx >= 0 ? argv[dataIdx + 1] : undefined;

if (dryRun) {
  const rec = accounts.reconcileState({ dataDir, fresh: true });
  console.log(JSON.stringify(rec, null, 2));
  process.exit(rec.drift ? 1 : 0);
}

const r = accounts.resync({ dataDir, reason: 'cli-resync', actor: process.env.SUDO_USER || 'cli', forcePerms });
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);

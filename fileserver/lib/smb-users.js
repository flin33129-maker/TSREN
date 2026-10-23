'use strict';

/**
 * 兼容壳：旧 server.js 里 require('./lib/smb-users') 的所有调用点保持不变。
 *
 * R15-P0 起真正的实现搬到 ./smb-accounts.js：
 *   - 旧实现"把用户名追加到所有共享的 valid users + force user=tokenllm"已被淘汰；
 *   - ensureSmbUser / addUserToShares / reloadSamba / shareList / listSmbUsers ...
 *     这些旧 API 名在这里原样保留，内部走新的 ACL 驱动 + 幂等重建逻辑。
 *
 * 这样 server.js（共享文件，本轮不改）在注册/登录时调用的还是同名函数，
 * 但行为已经变成：注册即开通同名 SMB 账号 → 自动进入 ACL 允许的 valid users
 * → 重建 station-shares.conf → reload smbd。
 */

module.exports = require('./smb-accounts');

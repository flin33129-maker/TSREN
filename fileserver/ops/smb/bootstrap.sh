#!/bin/bash
# R15-P0：SMB 模块部署后自检 + 备份 + 安装共享清单（在服务器上以 tokenllm 身份跑）
#
#   用法： bash /opt/station/fileserver/ops/smb/bootstrap.sh
#
# 做的事：
#   ① 备份将被覆盖的关键文件（smb.conf / station-shares.conf / 旧 smb-users.js）
#   ② 安装共享目录清单到 /etc/samba/station-smb-shares.json
#   ③ node --check 三个 JS 文件 + 跑离线自测
#   ④ dry-run 生成配置（不写盘）
#   ⑤ 打印 root 侧 apply 脚本并用 bash -n 做语法检查
set -u
cd /opt/station/fileserver || exit 1
TS=$(date +%Y%m%d-%H%M%S)
echo "=== ① 备份 ==="
cp -a lib/smb-users.js "lib/smb-users.js.bak-r15-$TS" 2>/dev/null && echo "backup lib/smb-users.js.bak-r15-$TS" || true
sudo -n cp -a /etc/samba/smb.conf "/etc/samba/smb.conf.bak-r15-$TS"
sudo -n cp -a /etc/samba/station-shares.conf "/etc/samba/station-shares.conf.bak-r15-$TS"
echo "smb.conf.bak-r15-$TS / station-shares.conf.bak-r15-$TS"
echo "ROLLBACK: sudo -n cp -a /etc/samba/smb.conf.bak-r15-$TS /etc/samba/smb.conf && sudo -n cp -a /etc/samba/station-shares.conf.bak-r15-$TS /etc/samba/station-shares.conf && sudo -n systemctl restart smbd"

echo "=== ② 安装共享清单 ==="
sudo -n install -m 0644 -o root -g root ops/smb/shares.json /etc/samba/station-smb-shares.json
ls -l /etc/samba/station-smb-shares.json

echo "=== ③ 语法检查 + 离线自测 ==="
set -e
node --check lib/smb-accounts.js
node --check lib/smb-users.js
node --check lib/routes/smb.js
node ops/smb/selftest.cjs | tail -6
set +e

echo "=== ④ dry-run 配置生成 ==="
node ops/smb/apply.cjs --dry-run
echo "dryrun_rc=$?"

echo "=== ⑤ apply 脚本 bash -n ==="
node ops/smb/apply.cjs --print-script > /tmp/station-smb-apply.sh
bash -n /tmp/station-smb-apply.sh && echo "bash -n OK ($(wc -c </tmp/station-smb-apply.sh) bytes)"

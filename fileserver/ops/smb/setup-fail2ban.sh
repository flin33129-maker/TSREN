#!/bin/bash
# R15-P0：安装/更新 Samba 登录失败 jail（fail2ban），幂等，可重复执行。
#
#   用法： sudo bash r15/srv/ops/smb/setup-fail2ban.sh
#
# 依赖：smb.conf 受管段里的 `log level = 1 auth:3` 与 `debug prefix timestamp = yes`
#       （由 lib/smb-accounts.js 写入；没有这两项则日志里没有带时间戳的 Auth: 行，
#        本 filter 匹配不到——安装脚本会检查并提示）。
#
# 规则：同一来源 IP 10 分钟内认证失败 5 次 → 封禁该 IP 对 445/139 的连接 1 小时。
#       封禁记录可用 fail2ban-client status station-smb 查看；
#       /api/smb/status 会读出 Currently banned / Banned IP list 展示"锁定状态"。
set -u
TS=$(date +%Y%m%d-%H%M%S)
FILTER=/etc/fail2ban/filter.d/station-smb.conf
JAIL=/etc/fail2ban/jail.local

if ! grep -qE '^\s*log level\s*=\s*[^#]*auth:3' /etc/samba/smb.conf 2>/dev/null; then
  echo "WARN  /etc/samba/smb.conf 缺少 'log level = 1 auth:3'，filter 可能匹配不到失败日志。" >&2
  echo "      请先执行: node /opt/station/fileserver/ops/smb/apply.cjs" >&2
fi

[ -f "$FILTER" ] && cp -a "$FILTER" "$FILTER.bak-$TS"
cat > "$FILTER" <<'EOF'
# R15-P0：Samba 认证失败（配合 smb.conf 的 log level = 1 auth:3 + debug prefix timestamp = yes）
# 匹配形如：
#   [2026/10/22 05:12:33.123456,  2]   Auth: [SMB2,(null)] user [WORKGROUP]\[dav] at [...]
#     with [NTLMv2] status [NT_STATUS_WRONG_PASSWORD] workstation [...] remote host [ipv4:192.168.99.5:50000] ...
[Definition]

failregex = ^\[[^\]]+\]\s+Auth: .*status \[NT_STATUS_(?:WRONG_PASSWORD|LOGON_FAILURE|NO_SUCH_USER|ACCOUNT_LOCKED_OUT|ACCOUNT_DISABLED)\].*remote host \[ipv4:<HOST>:\d+\]

ignoreregex =
EOF

[ -f "$JAIL" ] && cp -a "$JAIL" "$JAIL.bak-$TS"
python3 - <<'PY'
import re
p = '/etc/fail2ban/jail.local'
try:
    s = open(p).read()
except FileNotFoundError:
    s = ''
# 去掉旧的 [station-smb] 段（幂等重装）
s = re.sub(r'\n?\[station-smb\][\s\S]*?(?=\n\[|\Z)', '', s)
if '[sshd]' not in s:
    s = '[sshd]\nenabled = true\nmaxretry = 5\nfindtime = 600\nbantime = 3600\n' + s
s = s.rstrip() + '''

[station-smb]
enabled = true
filter = station-smb
logpath = /var/log/samba/log.*
maxretry = 5
findtime = 600
bantime = 3600
action = iptables-multiport[name=station-smb, port="445,139", protocol=tcp]
'''
open(p, 'w').write(s)
print('jail.local 已更新（保留 sshd 配置）')
PY

if ! fail2ban-client -t >/tmp/f2b-test.out 2>&1; then
  echo "FAIL fail2ban 配置校验未通过：" >&2
  sed -n '1,40p' /tmp/f2b-test.out >&2
  [ -f "$JAIL.bak-$TS" ] && cp -a "$JAIL.bak-$TS" "$JAIL" && echo "已回滚 jail.local" >&2
  exit 1
fi
systemctl restart fail2ban
sleep 2
echo "fail2ban=$(systemctl is-active fail2ban)"
fail2ban-client status
echo '--- station-smb jail ---'
fail2ban-client status station-smb | sed -n '1,12p'

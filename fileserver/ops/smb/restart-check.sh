#!/bin/bash
# R15-P0：加锁重启 station 并验证路由/健康
set -u
sudo -n systemctl restart station
sleep 3
echo "station=$(systemctl is-active station)"
curl -s -m 6 -o /dev/null -w 'root=%{http_code}\n' http://127.0.0.1:8081/
echo "--- /api/r15/health ---"
curl -s -m 6 http://127.0.0.1:8081/api/r15/health | head -c 900; echo
echo "--- /api/smb/status（未登录应 401） ---"
curl -s -m 6 -o /tmp/smb-status-anon.json -w 'code=%{http_code}\n' http://127.0.0.1:8081/api/smb/status
cat /tmp/smb-status-anon.json; echo
echo "--- 路由挂载日志 ---"
journalctl -u station -n 30 --no-pager 2>/dev/null | grep -E '\[routes\]|扩展模块|error|Error' | tail -8

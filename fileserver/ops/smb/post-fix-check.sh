#!/bin/bash
# 第 5 轮修复后验证：自愈对账 + 账号恢复 + 禁用语义
set -u
cd /opt/station/fileserver || exit 1
echo "===== 1. resync（第一次，可能修复） ====="
sudo -n node ops/smb/resync.cjs > /tmp/r5-1.json 2>&1; echo "rc=$?"
python3 - /tmp/r5-1.json <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print('ok=%s fixed=%s' % (d.get('ok'), d.get('fixed')))
print('before: drift=%s reasons=%s' % (d['before']['drift'], d['before']['reasons'][:8]))
print('after : drift=%s reasons=%s pending=%s' % (d['after']['drift'], d['after']['reasons'][:8], d['after']['details'].get('smbPending')))
ap = d.get('applied') or {}
print('apply : ok=%s changed=%s reloaded=%s enabled=%s missing=%s droppedFp=%s' % (
    ap.get('ok'), ap.get('changed'), ap.get('reloaded'),
    (ap.get('accountSync') or {}).get('enabled'),
    (ap.get('accountSync') or {}).get('missing'),
    (ap.get('accountSync') or {}).get('fingerprintsDropped')))
PY

echo "===== 2. resync（第二次，应幂等无变更） ====="
sudo -n node ops/smb/resync.cjs > /tmp/r5-2.json 2>&1; echo "rc=$?"
python3 - /tmp/r5-2.json <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print('ok=%s fixed=%s before_drift=%s after_drift=%s apply_changed=%s apply_reloaded=%s' % (
    d.get('ok'), d.get('fixed'), d['before']['drift'], d['after']['drift'],
    (d.get('applied') or {}).get('changed'), (d.get('applied') or {}).get('reloaded')))
PY

echo "===== 3. 关键账号 flags（[U] = 启用；[DU] = 停用） ====="
sudo -n pdbedit -Lv 2>/dev/null | awk '
  /^Unix username:/{u=$3}
  /^Account Flags:/{line[u]=$0}
  END{for(n in line) if(n=="smbaccA"||n=="smbaccB"||n=="office2"||n=="files_tester"||n=="p0ai_a"||n=="p0ai_b") print n, line[n]}
' | sort

echo "===== 4. SMB 登录（测试账号原密码，不允许改密码） ====="
for pair in "smbaccA:Q7mZp2Lw9Rt4!" "smbaccB:K3vNx8Hs5Qb2!"; do
  u=${pair%%:*}; p=${pair#*:}
  smbclient -U "$u%$p" //127.0.0.1/公共盘 -c 'ls' >/tmp/r5-smb.out 2>&1
  echo "$u login_rc=$? $(grep -oE 'NT_STATUS_[A-Z_]+' /tmp/r5-smb.out | head -1)"
done
echo "office2（错误密码，期望 LOGON_FAILURE 而不是 ACCOUNT_DISABLED）:"
smbclient -U "office2%DefinitelyWrong-1!" //127.0.0.1/公共盘 -c 'ls' >/tmp/r5-smb.out 2>&1
grep -oE 'NT_STATUS_[A-Z_]+' /tmp/r5-smb.out | head -1

echo "===== 5. 配置断言 ====="
echo -n "sections="; grep -c '^\[' /etc/samba/station-shares.conf
echo -n "force_user="; grep -cE '^\s*force user\s*=' /etc/samba/station-shares.conf || true
echo -n "force_group="; grep -cE '^\s*force group\s*=' /etc/samba/station-shares.conf || true
echo -n "smbaccA_in_valid_users="; grep -c 'valid users = .*smbaccA' /etc/samba/station-shares.conf || true
echo -n "smbaccB_in_valid_users="; grep -c 'valid users = .*smbaccB' /etc/samba/station-shares.conf || true
echo -n "office2_in_valid_users="; grep -c 'valid users = .*office2' /etc/samba/station-shares.conf || true
testparm -s >/dev/null 2>&1; echo "testparm_rc=$?"

echo "===== 6. 离线自测（含禁用≠删除/启用恢复断言） ====="
node ops/smb/selftest.cjs 2>&1 | grep -E 'PASS  (active|disabled|不包含 smbpasswd|账号缺失|孤儿)|全部 PASS|项 FAIL'

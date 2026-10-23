#!/bin/bash
# R15-P0：应用配置并打印摘要（幂等；用于运维/验收）
#   sudo bash /opt/station/fileserver/ops/smb/apply-check.sh
set -u
cd /opt/station/fileserver || exit 1
OUT=/tmp/station-smb-apply.json
sudo -n node ops/smb/apply.cjs > "$OUT" 2>/tmp/station-smb-apply.err
RC=$?
echo "apply_rc=$RC"
python3 - "$OUT" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print('apply output not JSON:', e)
    sys.exit(0)
print('ok=%s changed=%s reloaded=%s recursive=%s durationMs=%s' % (
    d.get('ok'), d.get('changed'), d.get('reloaded'), d.get('recursive'), d.get('durationMs')))
print('backups: shares=%s smb=%s' % (d.get('sharesBackup') or '-', d.get('smbBackup') or '-'))
for w in d.get('warnings', []):
    print('WARN:', w)
for s in d.get('shares', []):
    print('%-10s readonly=%-5s fs=%-8s valid=%d write=%d' % (
        s['name'], s['readonly'], s.get('fsType', ''), len(s['validUsers']), len(s['writeUsers'])))
PY
echo "--- testparm ---"
testparm -s >/tmp/station-smb-testparm.out 2>&1; echo "testparm_rc=$?"
grep -cE '^\[[^]]+\]' /tmp/station-smb-testparm.out | sed 's/^/sections=/'

echo "--- reconcile（应用后的实际状态对账；drift=false 才算完全对齐） ---"
sudo -n node ops/smb/resync.cjs --dry-run >/tmp/station-smb-reconcile.json 2>/dev/null
echo "reconcile_rc=$?"
python3 - /tmp/station-smb-reconcile.json <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print('reconcile output not JSON:', e)
    sys.exit(0)
print('drift=%s reasons=%s' % (d.get('drift'), '；'.join(d.get('reasons') or []) or '无'))
print('accountSync enabled=%s' % ((d.get('accountSync') or {}).get('enabled')))
PY

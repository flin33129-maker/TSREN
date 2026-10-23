#!/bin/bash
# R15-P0（第 5 轮回归用例）：禁用 → 启用 后 SMB 必须仍可登录（禁用 ≠ 删除）
#
# 在服务器上跑：
#   bash /opt/station/fileserver/tests/smb/accept_disable_cycle.sh
#   SMB_TEST_USER_A=smbaccA SMB_TEST_PASS_A='Q7mZp2Lw9Rt4!' bash ...
#
# 复现的历史 bug：
#   管理员把账号 disabled=true 后 watcher 执行 smbpasswd -d（正常，禁用）；
#   再 disabled=false 时旧实现只重写共享配置，**没有 smbpasswd -e 恢复账号**，
#   于是 Samba 账号永远停留在 [D]，登录报 NT_STATUS_ACCOUNT_DISABLED。
#   第 5 轮修复：apply 脚本对 active 用户做 smbpasswd -e 对账恢复，watchTick 改为实际状态对账。
#
# 断言：
#   1. 初始状态 SMB 可登录
#   2. 禁用 + resync 后：SMB 登录失败（ACCOUNT_DISABLED/LOGON_FAILURE）、共享配置里没有该用户
#   3. 启用 + resync 后：SMB 恢复可登录、共享配置恢复该用户、passdb 的 D 标志消除
#   4. 密码保持不变（仍是原密码）
#   5. /api/smb/status 的 account.ready=true、reconcile.drift=false
set -u
BASE="${STATION_BASE:-http://127.0.0.1:8081}"
U="${SMB_TEST_USER_A:-smbaccA}"
P="${SMB_TEST_PASS_A:-Q7mZp2Lw9Rt4!}"
ADMIN_USER="${STATION_USER:-Dozin}"
ADMIN_PASS="${STATION_PASS:-DKY@4321}"
SHARES_CONF=/etc/samba/station-shares.conf
JAR=$(mktemp /tmp/smb-cycle.XXXXXX)
OUT=$(mktemp /tmp/smb-cycle-out.XXXXXX)
FAIL=0
trap 'rm -f "$JAR" "$OUT"' EXIT

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
check() { if eval "$2" >/dev/null 2>&1; then pass "$1"; else fail "$1"; fi; }

api_get() { curl -s -b "$JAR" "$BASE$1"; }
api_post() { curl -s -b "$JAR" -H 'Content-Type: application/json' -d "$2" "$BASE$1"; }

# 登录管理员拿 cookie
curl -s -c "$JAR" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\",\"user\":\"$ADMIN_USER\"}" \
  "$BASE/api/login" >"$OUT" 2>&1
if grep -q '"ok":true' "$OUT"; then pass "管理员登录"; else fail "管理员登录：$(head -c 200 "$OUT")"; fi

smblogin() {
  smbclient -U "$U%$P" "//127.0.0.1/公共盘" -c 'ls' >"$OUT" 2>&1
  echo $?
}
set_disabled() {
  api_post "/api/admin/users/toggle" "{\"username\":\"$U\",\"disabled\":$1}" >"$OUT" 2>&1
  grep -q '"ok":true' "$OUT"
}
resync() {
  api_post "/api/smb/resync" '{}' >"$OUT" 2>&1
  grep -q '"ok":true' "$OUT"
}
config_has_user() {
  grep -q "valid users = .*\b$U\b" "$SHARES_CONF"
}
account_flags() {
  sudo -n pdbedit -Lv 2>/dev/null | awk -v u="$U" '
    /^Unix username:/{cur=$3} /^Account Flags:/{if(cur==u){gsub(/[\[\] ]/,"",$0); print}}
  '
}

echo "===== 1. 初始状态：$U 可登录 ====="
if [ "$(smblogin)" = "0" ]; then pass "初始 SMB 登录成功"; else fail "初始 SMB 登录失败（先跑 accept_smb.sh 或检查密码）"; fi
if set_disabled false; then pass "先确保账号为启用状态"; else fail "启用接口失败"; fi
resync >/dev/null || true

echo "===== 2. 禁用 → 必须断开 SMB，但保留账号（不是删除） ====="
if set_disabled true; then pass "禁用接口 200"; else fail "禁用接口失败"; fi
if resync; then pass "禁用后 resync 成功"; else fail "禁用后 resync 失败"; fi
RC=$(smblogin)
[ "$RC" != "0" ] && pass "禁用后 SMB 登录失败（rc=$RC）" || fail "禁用后仍能登录"
grep -qE 'ACCOUNT_DISABLED|LOGON_FAILURE' "$OUT" && pass "失败原因明确（$(grep -oE 'NT_STATUS_[A-Z_]+' "$OUT" | head -1)）" || fail "失败原因不明确"
if config_has_user; then fail "禁用后共享配置仍包含 $U"; else pass "禁用后共享配置已摘除 $U"; fi
FLAGS=$(account_flags)
echo "  pdbedit flags: [$FLAGS]"
if echo "$FLAGS" | grep -q 'D'; then pass "Samba 账号仍存在但被禁用（D 标志，未删除）"; else fail "Samba 账号未按预期禁用（flags=[$FLAGS]）"; fi

echo "===== 3. 启用 → 必须自动恢复（本 bug 的核心回归） ====="
if set_disabled false; then pass "启用接口 200"; else fail "启用接口失败"; fi
if resync; then pass "启用后 resync 成功（包含 smbpasswd -e）"; else fail "启用后 resync 失败"; fi
RC=$(smblogin)
[ "$RC" = "0" ] && pass "启用后 SMB 恢复登录成功" || { fail "启用后仍无法登录（rc=$RC）"; head -3 "$OUT"; }
if config_has_user; then pass "共享配置恢复 $U 的 valid users"; else fail "共享配置未恢复 $U"; fi
FLAGS=$(account_flags)
echo "  pdbedit flags: [$FLAGS]"
if echo "$FLAGS" | grep -q 'D'; then fail "Samba 账号 D 标志未消除"; else pass "Samba 账号已恢复启用（无 D 标志）"; fi

echo "===== 4. 密码未变 + 状态接口对账一致 ====="
RC=$(smblogin)
[ "$RC" = "0" ] && pass "启用后仍可用原密码登录（密码未被改动）" || fail "原密码无法登录（可能被改过）"
STATUS=$(api_get "/api/smb/status")
echo "$STATUS" >"$OUT"
python3 - "$OUT" <<'PY' && pass "status: account.ready=true 且 reconcile.drift=false" || fail "status: ready/drift 不符"
import json, sys
d = json.load(open(sys.argv[1]))
assert d['account']['ready'] is True
assert d['reconcile']['drift'] is False
PY

echo
echo "===== 汇总 ====="
if [ "$FAIL" -eq 0 ]; then echo "RESULT: 全部 PASS"; exit 0; else echo "RESULT: $FAIL 项 FAIL"; exit 1; fi

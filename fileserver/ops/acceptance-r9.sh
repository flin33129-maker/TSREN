#!/bin/bash
# R9 验收脚本：把「全量改进」的验收点逐条跑一遍并打印 PASS/FAIL 证据。
# 用法：在仓库根目录执行  bash ops/acceptance-r9.sh
# 说明：脚本会重启一次 station（注册限速计数是内存态，重启才能从零验证），
#       并在末尾清理自己创建的临时账号。
# 取证脚本 v2：把「注册限速」也当成受控变量 —— 先重启服务清掉内存里的限速计数，
# 再注册临时账号做「登录后」验证；最后**故意**把限速打满，把限速本身也验成一条证据。
# ⚠️ 这里**不写死任何口令** —— 脚本要进版本库，硬编码口令等于又把凭据抄进 git 历史。
# 需要 root 的检查项走 sudo：免密就 sudo -n，需要口令就 SUDO_PW='xxx' bash ops/acceptance-r9.sh
SUDO_PW="${SUDO_PW:-}"
S() {
  if [ -n "$SUDO_PW" ]; then echo "$SUDO_PW" | sudo -S -p '' "$@";
  else sudo -n "$@"; fi
}
APP=/opt/station/fileserver
B=http://127.0.0.1:8081
cd "$APP" || exit 1
OK=0; NG=0
chk() {
  if [ "$2" = "$3" ]; then echo "  [PASS] $1 → $3"; OK=$((OK+1));
  else echo "  [FAIL] $1 → 期望 $2 实际 $3"; NG=$((NG+1)); fi
}

echo "########## 0. 清限速计数（重启，内存态） ##########"
S systemctl restart station
sleep 4
chk "重启后 station" "active" "$(systemctl is-active station)"

echo
echo "########## 1. 回归基线与测试 ##########"
R=$(node test/t-r9-security.js 2>&1 | grep -oE '[0-9]+ 通过' | head -1 | grep -oE '^[0-9]+')
F=$(node test/t-r9-security.js 2>&1 | grep -oE '[0-9]+ 失败' | head -1 | grep -oE '^[0-9]+')
chk "t-r9-security 通过数 ≥ 80" "1" "$([ "${R:-0}" -ge 80 ] && echo 1 || echo 0)"
chk "t-r9-security 失败数为 0" "0" "${F:-?}"
A=$(node test/t-ai-sec.js 2>&1 | grep -oE '[0-9]+ 项失败' | grep -oE '^[0-9]+'); chk "t-ai-sec 失败数为 0" "0" "${A:-?}"
D=$(node test/t-dav-tmp.js 2>&1 | grep -oE '[0-9]+ 失败' | head -1 | grep -oE '^[0-9]+'); chk "t-dav-tmp 失败数为 0" "0" "${D:-?}"
FI=$(node test/t-fault-inject.js 2>&1 | grep -oE '[0-9]+ 项失败' | grep -oE '^[0-9]+'); chk "t-fault-inject 失败数为 0" "0" "${FI:-?}"
MODFAIL=0
for f in lib/*.js; do
  OUT=$(node "$f" 2>&1 | tr -d '\r')
  BAD=$(echo "$OUT" | grep -E '✗|FAIL|失败 [1-9]|[1-9] 项失败' | grep -v 'linked=' | head -2)
  if [ -n "$BAD" ]; then echo "$BAD" | sed 's/^/      /'; MODFAIL=$((MODFAIL+1)); fi
done
chk "24 个模块自测无失败" "0" "$MODFAIL"

echo
echo "########## 2. 服务健康 ##########"
chk "station 服务" "active" "$(systemctl is-active station)"
chk "nginx 服务" "active" "$(systemctl is-active nginx)"
chk "octop-tunnel 服务" "active" "$(systemctl is-active octop-tunnel)"
chk "onlyoffice 容器" "healthy" "$(docker inspect -f '{{.State.Health.Status}}' onlyoffice 2>/dev/null)"
chk "grist 容器在跑" "1" "$(docker ps --filter name=grist -q | wc -l | tr -d ' ')"
chk "面板首页" "200" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)"
chk "站点首页" "200" "$(curl -s -o /dev/null -w '%{http_code}' $B/)"
chk "TLS 面板" "200" "$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/)"
chk "OnlyOffice 前端（此前 404）" "302" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/onlyoffice/)"
chk "公网隧道口" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 http://62.234.74.180:18088/)"
chk "响应安全头数量" "4" "$(curl -sI $B/ | grep -ciE 'x-content-type-options|x-frame-options|referrer-policy|content-security-policy')"

echo
echo "########## 3. 权限矩阵（匿名 / 普通用户） ##########"
CJ=/tmp/r9g.txt; rm -f $CJ
REG=$(curl -s -o /tmp/r9reg.json -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"username":"r9goal","password":"R9goal-2026!x"}' $B/api/register)
echo "  注册响应：$REG $(head -c 120 /tmp/r9reg.json)"
chk "注册成功" "200" "$REG"
LOG=$(curl -s -c $CJ -o /tmp/r9log.json -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"username":"r9goal","password":"R9goal-2026!x"}' $B/api/login)
echo "  登录响应：$LOG $(head -c 120 /tmp/r9log.json)"
chk "登录成功" "200" "$LOG"
chk "拿到会话 cookie" "1" "$(grep -c fsid $CJ)"
chk "匿名读公共盘（只读开放）" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/list?disk=public&path=")"
chk "匿名读私人盘（应拒）" "403" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/list?disk=private&path=")"
chk "匿名读外置盘（应拒）" "403" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/list?disk=ext:K1&path=")"
chk "匿名建目录（应拒）" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"disk":"public","path":"x"}' $B/api/mkdir)"
chk "匿名删文件（应拒）" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"disk":"public","path":"x"}' $B/api/delete)"
chk "匿名分享创建（应拒）" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"disk":"public","path":"x"}' $B/api/share/create)"
chk "匿名读历史版本（应拒）" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/versions")"
chk "匿名读审计（应拒）" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/audit")"
chk "匿名读权限表（应拒）" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/acl")"
chk "匿名 AI 对话（应拒）" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"messages":[]}' $B/api/ai/chat)"
chk "普通用户读审计（应拒）" "403" "$(curl -s -b $CJ -o /dev/null -w '%{http_code}' "$B/api/audit")"
chk "普通用户读权限表（应拒）" "403" "$(curl -s -b $CJ -o /dev/null -w '%{http_code}' "$B/api/acl")"
chk "普通用户读私人盘（自己的）" "200" "$(curl -s -b $CJ -o /dev/null -w '%{http_code}' "$B/api/list?disk=private&path=")"
chk "普通用户读历史版本" "200" "$(curl -s -b $CJ -o /dev/null -w '%{http_code}' "$B/api/versions")"
chk "游客视图不含模型路径" "0" "$(curl -s $B/api/ai/config | grep -c '/opt/station/models')"

echo
echo "########## 4. 凭据与权限 ##########"
chk "data 目录 700" "700" "$(stat -c %a $APP/data)"
chk "s3.json 600" "600" "$(stat -c %a $APP/data/s3.json)"
chk "users.json 600" "600" "$(stat -c %a $APP/data/users.json)"
chk "acl.json 600" "600" "$(stat -c %a $APP/data/acl.json)"
chk "oo-jwt.key 600" "600" "$(stat -c %a $APP/data/oo-jwt.key)"
CODEONLY=$(grep -vE '^[[:space:]]*(\*|//|/\*)' $APP/server.js)
chk "实码中无硬编码 OO 密钥" "0" "$(printf '%s' "$CODEONLY" | grep -c 'station-oo-2026')"
chk "实码中无硬编码 S3 弱口令" "0" "$(printf '%s' "$CODEONLY" | grep -c 'nas-s3-2026')"
chk "无全局关闭 TLS 校验" "0" "$(printf '%s' "$CODEONLY" | grep -c 'NODE_TLS_REJECT_UNAUTHORIZED')"
chk "OO 密钥来自密钥文件（≥60 字节）" "1" "$([ $(wc -c < $APP/data/oo-jwt.key) -ge 60 ] && echo 1 || echo 0)"
node /tmp/s3probe.js 2>&1 | grep -qE '新凭据.*-> 200' && { echo "  [PASS] S3 新凭据可用"; OK=$((OK+1)); } || { echo "  [FAIL] S3 新凭据"; NG=$((NG+1)); }
node /tmp/s3probe.js 2>&1 | grep -qE '旧弱凭据.*-> 403' && { echo "  [PASS] S3 旧弱凭据被拒"; OK=$((OK+1)); } || { echo "  [FAIL] S3 旧弱凭据仍可用"; NG=$((NG+1)); }

echo
echo "########## 5. 网络面 ##########"
chk "UFW 已启用" "active" "$(S ufw status | head -1 | awk '{print $2}')"
chk "默认拒绝入站" "1" "$(S ufw status verbose | grep -c 'Default: deny (incoming)')"
chk "默认允许出站" "1" "$(S ufw status verbose | grep -c 'allow (outgoing)')"
chk "面板 80 对公网放行" "1" "$(S ufw status verbose | grep -cE '^80/tcp +ALLOW IN +Anywhere +# panel http')"
chk "面板 8443 对公网放行" "1" "$(S ufw status verbose | grep -cE '^8443/tcp +ALLOW IN +Anywhere +# panel https')"
chk "内网 192.168.99.0/24 放行" "1" "$(S ufw status verbose | grep -c '192.168.99.0/24')"
chk "内网 192.168.8.0/24 放行" "1" "$(S ufw status verbose | grep -c '192.168.8.0/24')"
chk "SSH：127.0.0.1 段禁口令（隧道来源）" "no" "$(S sshd -T -C addr=127.0.0.1,user=tokenllm,host=localhost 2>/dev/null | grep -E '^passwordauthentication' | awk '{print $2}')"
chk "SSH：局域网仍可口令" "yes" "$(S sshd -T -C addr=192.168.99.132,user=tokenllm,host=lan 2>/dev/null | grep -E '^passwordauthentication' | awk '{print $2}')"
chk "127.0.0.1 口令登录被拒" "1" "$(timeout 15 ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1 tokenllm@127.0.0.1 true 2>&1 | grep -c 'Permission denied (publickey)')"
chk "onlyoffice 只绑本机" "1" "$(S docker ps --format '{{.Ports}}' --filter name=onlyoffice | grep -c '127.0.0.1:8090')"
chk "grist 只绑本机" "1" "$(S docker ps --format '{{.Ports}}' --filter name=grist | grep -c '127.0.0.1:8484')"
chk "隧道服务在跑" "active" "$(systemctl is-active octop-tunnel)"

echo
echo "########## 6. 版本库与备份 ##########"
chk "服务器工作区干净" "0" "$(git status --porcelain | wc -l | tr -d ' ')"
chk "提交数 ≥ 41" "1" "$([ $(git rev-list --count HEAD) -ge 41 ] && echo 1 || echo 0)"
# 本轮改动 = e0db3d3（本轮之前的基线）之后的全部提交
chk "本轮提交数 ≥ 12" "1" "$([ $(git rev-list --count e0db3d3..HEAD) -ge 12 ] && echo 1 || echo 0)"
# 再逐条核对关键主题（不看前缀 —— 前缀会变，内容才是承诺）
for t in "feat(security)" "feat(ai)" "feat(proto)" "feat(ops)" "feat(perf)" "fix(server)" "test(r9)" "chore:" "fix(privacy)" "ops:" "docs:"; do
  chk "提交含主题 $t" "1" "$(git log --oneline e0db3d3..HEAD | grep -cF "$t" | awk '{print ($1>=1)?1:0}')"
done
chk "备份盘有 bundle" "1" "$(ls /storage/备份/git/latest.bundle 2>/dev/null | wc -l | tr -d ' ')"
chk "备份定时器 active" "active" "$(S systemctl is-active station-repo-sync.timer)"
chk "备份包可校验（无 error）" "0" "$(S git bundle verify /storage/备份/git/latest.bundle 2>&1 | grep -c 'error')"
chk "完整报告在服务器上" "1" "$(ls /opt/station/backup/R9-改进报告.md 2>/dev/null | wc -l | tr -d ' ')"
chk "报告完整版含新凭据" "1" "$(grep -c '31f3edcc9e1a19d542d5' /opt/station/backup/R9-改进报告.md)"
chk "仓库版报告不含明文凭据" "0" "$(grep -c '31f3edcc9e1a19d542d5' $APP/docs/R9-改进报告.md)"

echo
echo "########## 7. 注册限速（补偿前端无验证码） ##########"
# 限速计数是**内存态**（this._registerHits），重启即清零。
# 这里先重启把计数归零，再从零开始打满，这样「第几次触发」才是可自证的。
S systemctl restart station
sleep 4
echo "  已重启服务清零限速计数，开始连续注册："
RL=0; LAST=0
for i in 1 2 3 4 5 6 7; do
  LAST=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d "{\"username\":\"r9rl$i\",\"password\":\"R9rl-2026!xx\"}" $B/api/register)
  echo "    第 $i 次 → $LAST"
  if [ "$LAST" = "429" ]; then RL=$i; break; fi
done
chk "注册限速在第 6 次触发（5 次/小时）" "6" "$RL"
chk "限速返回 429" "429" "$LAST"

# 清理所有临时账号与组记录
python3 - <<'PY'
import json, os, re
p='/opt/station/fileserver/data/users.json'; d=json.load(open(p,encoding='utf-8'))
u=d.get('users') if isinstance(d,dict) else d
before=len(u)
u[:]=[x for x in u if not re.match(r'^r9(rl\d+|goal|probe)', x.get('username') or '')]
json.dump(d,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2); os.chmod(p,0o600)
a='/opt/station/fileserver/data/acl.json'; ad=json.load(open(a,encoding='utf-8'))
for g,l in (ad.get('groups') or {}).items():
    ad['groups'][g]=[x for x in l if not re.match(r'^r9(rl\d+|goal|probe)', x or '')]
json.dump(ad,open(a,'w',encoding='utf-8'),ensure_ascii=False,indent=2); os.chmod(a,0o600)
print('  清理临时账号：%d → %d' % (before, len(u)))
PY
rm -f $CJ /tmp/r9reg.json /tmp/r9log.json

echo
echo "=================================================="
echo "  验收项：$OK 通过 / $NG 失败"
echo "=================================================="
[ $NG -eq 0 ] && echo "  结论：目标全部达成" || echo "  结论：仍有未达成项"

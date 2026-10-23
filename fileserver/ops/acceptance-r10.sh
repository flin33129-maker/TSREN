#!/bin/bash
# R10 最终验收：一次性把这一轮所有改动点重新验一遍
set -u
J=/tmp/acc.jar
BASE=http://127.0.0.1:8081
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
chk()  { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (期望 $3 实得 $2)"; fi; }

# 验收需要一个非管理员测试账号。口令不写进仓库（R9 的教训），
# 运行前由调用者提供：  ST_USER=uitest ST_PASS='...' bash ops/acceptance-r10.sh
: "${ST_USER:?请先 export ST_USER（测试账号用户名）}"
: "${ST_PASS:?请先 export ST_PASS（测试账号口令）}"
curl -s -c $J -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ST_USER\",\"password\":\"$ST_PASS\"}" $BASE/api/login > /dev/null

echo "【1】静态资源与清理"
chk "首页" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/)" "200"
chk "临时登录页已删" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/__uitest.html)" "404"
chk "压测脚本已删" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/games/_perfprobe.js)" "404"
chk "im.html" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/im.html)" "200"
chk "work.html" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/work.html)" "200"
chk "报告已入库" "$([ -f /opt/station/fileserver/docs/R10-改进报告.md ] && echo yes || echo no)" "yes"

echo "【2】服务与协议"
CAP=$(curl -s -b $J $BASE/api/capabilities)
for k in dav s3 dlna mdns; do
  if echo "$CAP" | grep -q "\"$k\":true"; then ok "$k 运行中"; else bad "$k 未运行"; fi
done
if echo "$CAP" | grep -q '"ftp":2121'; then ok "FTP 2121"; else bad "FTP"; fi
if echo "$CAP" | grep -q '"nfs":2049'; then ok "NFS 2049"; else bad "NFS"; fi
if echo "$CAP" | grep -q '"smb":true'; then ok "SMB 运行中"; else bad "SMB 未运行"; fi
SH=$(echo "$CAP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(' '.join(d.get('smbShares') or []))" 2>/dev/null)
echo "  共享名: ${SH:-（空）}"
if [ -n "$SH" ]; then ok "SMB 共享名非空（$(echo $SH | wc -w) 个）"; else bad "SMB 共享名为空"; fi

echo "【3】在线预览分流"
P1=$(curl -s -b $J -o /tmp/p1.pdf -w '%{http_code} %{content_type}' "$BASE/api/office/preview?disk=public&path=%E6%96%87%E6%A1%A3-10-19%200722.docx")
echo "  docx → $P1 ($(stat -c%s /tmp/p1.pdf 2>/dev/null) 字节)"
if echo "$P1" | grep -q '^200' && head -c4 /tmp/p1.pdf | grep -q '%PDF'; then ok "docx 转 PDF 成功"; else bad "docx 转换"; fi
python3 -c "import zipfile;zipfile.ZipFile('/tmp/__acc.zip','w').writestr('a.txt','hello')"
curl -s -b $J -F "disk=public" -F "path=" -F "files=@/tmp/__acc.zip;filename=__acc.zip" $BASE/api/upload > /dev/null
P2=$(curl -s -b $J -o /dev/null -w '%{http_code}' "$BASE/api/office/preview?disk=public&path=__acc.zip")
chk "非文档格式被拒" "$P2" "415"
curl -s -b $J -X POST -H 'Content-Type: application/json' -d '{"disk":"public","path":"__acc.zip","permanent":true}' $BASE/api/delete > /dev/null

echo "【4】分片上传"
head -c 33554432 /dev/urandom > /tmp/chunk.bin
SUM=$(sha256sum /tmp/chunk.bin | cut -d' ' -f1)
INIT=$(curl -s -b $J -X POST -H 'Content-Type: application/json' \
  -d '{"disk":"public","path":"","name":"__acc_chunk.bin","size":33554432,"chunkSize":8388608}' $BASE/api/chunk-init)
UPID=$(echo "$INIT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('uploadId',''))" 2>/dev/null)
TOT=$(echo "$INIT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('totalChunks',0))" 2>/dev/null)
if [ -n "$UPID" ]; then
  ok "chunk-init 返回 uploadId（$TOT 片）"
  split -b 8388608 -d /tmp/chunk.bin /tmp/part_
  i=0
  for p in /tmp/part_*; do
    curl -s -b $J -X PUT --data-binary "@$p" "$BASE/api/chunk-data?uploadId=$UPID&index=$i" > /dev/null
    i=$((i+1))
  done
  CMP=$(curl -s -b $J -X POST -H 'Content-Type: application/json' -d "{\"uploadId\":\"$UPID\",\"sha256\":\"$SUM\"}" $BASE/api/chunk-complete)
  echo "  complete: $(echo $CMP | head -c 120)"
  # 用真实 GET 取下载字节数（服务端不实现 HEAD，用 -I 只会拿回 27 字节的错误 JSON）
  SIZE=$(curl -s -b $J -o /dev/null -w '%{size_download}' "$BASE/api/download?disk=public&path=__acc_chunk.bin")
  chk "落盘大小" "$SIZE" "33554432"
  rm -f /tmp/part_*
else
  bad "chunk-init 失败: $(echo $INIT | head -c 120)"
fi

echo "【5】大文件下载"
curl -s -b $J -o /dev/null -w "  全量: HTTP %{http_code} %{size_download} 字节 %{speed_download} B/s\n" \
  "$BASE/api/download?disk=public&path=__acc_chunk.bin"
curl -s -b $J -H 'Range: bytes=0-1048575' -o /dev/null -w "  分段1MB: HTTP %{http_code} %{size_download}\n" \
  "$BASE/api/download?disk=public&path=__acc_chunk.bin"

echo "【6】应用中心"
MAN=$(curl -s $BASE/apps/manifest.json)
TOTAL=$(echo "$MAN" | python3 -c "import sys,json;d=json.load(sys.stdin);a=d.get('apps') or d;print(len(a))" 2>/dev/null)
DOSN=$(echo "$MAN" | grep -ci 'dos-' 2>/dev/null || true)
echo "  条目数: $TOTAL | dos- 关键词: $DOSN"
if [ "${TOTAL:-0}" -ge 19 ] 2>/dev/null; then ok "清单条目 $TOTAL 条"; else bad "清单条目 $TOTAL"; fi
if [ "${DOSN:-1}" = "0" ]; then ok "已无 DOS 老游戏"; else bad "仍有 $DOSN 处 dos 条目"; fi
BADURL=0
for u in $(echo "$MAN" | python3 -c "
import sys,json
d=json.load(sys.stdin); a=d.get('apps') or d
for x in a:
    print(x.get('entry') or x.get('url') or x.get('path') or '')
" 2>/dev/null); do
  [ -z "$u" ] && continue
  c=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$u")
  if [ "$c" != "200" ]; then BADURL=$((BADURL+1)); echo "    入口异常 $c $u"; fi
done
if [ "$BADURL" = "0" ]; then ok "全部入口可访问"; else bad "$BADURL 个入口异常"; fi

echo "【7】自研游戏"
for g in neon-2048 city-tetris lightning-snake void-sweeper; do
  c=$(curl -s -o /tmp/g.html -w '%{http_code}' "$BASE/games/$g/")
  sz=$(stat -c%s /tmp/g.html 2>/dev/null)
  if [ "$c" = "200" ] && [ "${sz:-0}" -gt 3000 ] 2>/dev/null; then ok "$g ($sz 字节)"; else bad "$g ($c/$sz)"; fi
done

echo "【8】即时消息"
ST=$(curl -s -b $J "$BASE/api/im/state?since=0")
if echo "$ST" | grep -q '"channels"'; then ok "state 返回会话列表"; else bad "state 异常"; fi
CH=$(echo "$ST" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('channels') or [{}])[0].get('id',''))" 2>/dev/null)
SND=$(curl -s -b $J -X POST -H 'Content-Type: application/json' -d "{\"ch\":\"$CH\",\"text\":\"验收消息 $(date +%s)\"}" $BASE/api/im/send)
if echo "$SND" | grep -q '"ok":true'; then ok "发消息成功（会话 $CH）"; else bad "发消息失败"; fi
curl -s -b $J -X POST -H 'Content-Type: application/json' -d "{\"ch\":\"$CH\"}" $BASE/api/im/read > /dev/null && ok "标记已读"
if curl -s -b $J "$BASE/api/im/users" | grep -q '"users"'; then ok "成员列表可读"; else bad "成员列表"; fi

echo "【9】前端补丁标记"
IDX=/opt/station/fileserver/public/index.html
mark() { if grep -q "$1" $IDX; then ok "$2"; else bad "$2 缺失"; fi; }
mark 'ma-accent' '外观：强调色'
mark 'ma-scale' '外观：界面缩放'
mark 'gb18030' '预览：编码嗅探'
mark 'r10-office-overlay' '办公：内嵌覆盖层'
mark 'chunk-init' '上传：分片'
mark 'ma-toolbar' 'AI：工具条样式'
mark 'smbShares' '连接：SMB 共享名'
mark '模式：默认' 'AI：模式下拉'

echo "【10】服务健康"
chk "station 服务" "$(systemctl is-active station)" "active"
chk "首页" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/)" "200"
echo "  Node RSS: $(ps -o rss= -C node | awk '{s+=$1} END {print int(s/1024)" MB"}')"
echo "  预览缓存: $(du -sh /tmp/go-preview 2>/dev/null | cut -f1) / PDF $(ls /tmp/go-preview/*.pdf 2>/dev/null | wc -l) 个"
echo "  残留 lo-prof 目录: $(ls -d /tmp/lo-prof-* 2>/dev/null | wc -l)"
echo "  残留 lo- 输出目录: $(ls -d /tmp/go-preview/lo-* 2>/dev/null | wc -l)"

echo "【11】清理验收产物"
curl -s -b $J -X POST -H 'Content-Type: application/json' -d '{"disk":"public","path":"__acc_chunk.bin","permanent":true}' $BASE/api/delete > /dev/null
rm -f /tmp/chunk.bin /tmp/p1.pdf /tmp/g.html /tmp/__acc.zip
ok "验收产物已删除"

echo
echo "================ 结果：PASS $PASS / FAIL $FAIL ================"

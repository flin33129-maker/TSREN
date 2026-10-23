#!/data/data/com.termux/files/usr/bin/bash
# 在 Termux 中安装并启动局域网文件服务器 v2
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:$PREFIX/bin/applets:$PATH
export LD_LIBRARY_PATH=$PREFIX/lib
export HOME=/data/data/com.termux/files/home
export TMPDIR=$PREFIX/tmp

SRC=/data/local/tmp/fileserver
DST=$HOME/projects/fileserver
PORT=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$SRC/config.json" 2>/dev/null | grep -o '[0-9]*$')
[ -z "$PORT" ] && PORT=8443

echo "===== 1. 拷贝项目（保留已有用户数据）====="
mkdir -p "$HOME/projects"
BACKUP=$PREFIX/tmp/fs_data_backup
if [ -d "$DST/data" ]; then
  rm -rf "$BACKUP"
  cp -r "$DST/data" "$BACKUP"
  echo "已备份用户数据到 $BACKUP"
fi
rm -rf "$DST"
cp -r "$SRC" "$DST"
if [ -d "$BACKUP" ]; then
  cp -r "$BACKUP" "$DST/data"
  echo "已恢复用户数据（含 TLS 证书）"
fi
chmod +x "$DST/server.js" "$DST/autostart.js" 2>/dev/null
echo "已安装到: $DST"

echo ""
echo "===== 2. 停止旧进程 ====="
PID_FILE="$DST/server.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && [ -d "/proc/$OLD_PID" ]; then
    kill -9 "$OLD_PID" 2>/dev/null
    echo "已停止旧进程 PID=$OLD_PID"
  fi
  rm -f "$PID_FILE"
fi
# 兜底：按端口杀占用者（旧版 8081 / 新版 8443）
fuser -k -9 8081/tcp 2>/dev/null
fuser -k -9 8443/tcp 2>/dev/null
# 再兜底：杀掉残留的 node server.js（排除自己）
for P in $(pgrep -f "node server.js" 2>/dev/null); do
  [ "$P" != "$$" ] && kill -9 "$P" 2>/dev/null
done
sleep 1

echo ""
echo "===== 3. 申请唤醒锁 ====="
termux-wake-lock 2>/dev/null && echo "wake-lock ok" || echo "wake-lock 跳过"

echo ""
echo "===== 4. 配置开机自启动 ====="
cd "$DST" && node autostart.js enable

echo ""
echo "===== 5. 启动服务 ====="
cd "$DST"
nohup node server.js > "$DST/server.log" 2>&1 &
sleep 4

echo ""
echo "===== 6. 启动日志 ====="
cat "$DST/server.log"

echo ""
echo "===== 7. 本机自检（HTTPS 自签名）====="
node -e "
const https = require('https');
https.get({host:'127.0.0.1',port:$PORT,path:'/api/capabilities',rejectUnauthorized:false},(r)=>{
  let d=''; r.on('data',c=>d+=c);
  r.on('end',()=>console.log('  HTTP', r.statusCode, d));
}).on('error',e=>console.error('  自检失败:', e.message));
"
echo ""

echo "FILESERVER_DONE"

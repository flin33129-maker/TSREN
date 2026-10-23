'use strict';

/**
 * 开机自启动管理器（零依赖，跨平台）
 *
 * 支持：
 *   - Windows : 注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Run
 *   - macOS   : ~/Library/LaunchAgents/com.lan-fileserver.plist (launchd)
 *   - Linux   : ~/.config/systemd/user/lan-fileserver.service (systemd user)
 *   - Termux  : ~/.termux/boot/start-fileserver.sh (Termux:Boot)
 *
 * 用法：
 *   node autostart.js enable   # 启用（会打印具体写入位置）
 *   node autostart.js disable  # 禁用
 *   node autostart.js status   # 查看当前状态
 *
 * 配置：config.json 中 "autoStart": true/false 也会在服务启动时自动应用
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const APP_ID = 'LanFileServer';
const PROJECT_DIR = __dirname;
const SERVER = path.join(PROJECT_DIR, 'server.js');

function nodeBin() { return process.execPath; }

function platform() {
  const os = require('os');
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  // Termux 检测：PREFIX 含 com.termux
  if (process.env.PREFIX && process.env.PREFIX.includes('com.termux')) return 'termux';
  return 'linux';
}

const sh = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
});

/* ---------------- Windows: 注册表 ---------------- */
const WIN_REG_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
const winCmd = (args) => sh('reg', [args, WIN_REG_KEY, '/v', APP_ID, '/t', 'REG_SZ', '/d', `"${nodeBin()}" "${SERVER}"`, '/f']);
const winQuery = () => sh('reg', ['query', WIN_REG_KEY, '/v', APP_ID]);

/* ---------------- macOS: LaunchAgent ---------------- */
function macPlist() {
  return path.join(process.env.HOME, 'Library', 'LaunchAgents', 'com.lan-fileserver.plist');
}
function macPlistContent() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lan-fileserver</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin()}</string>
    <string>${SERVER}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${path.join(PROJECT_DIR, 'server.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(PROJECT_DIR, 'server.log')}</string>
</dict>
</plist>
`;
}

/* ---------------- Linux: systemd user ---------------- */
function systemdUnit() {
  return path.join(process.env.HOME, '.config', 'systemd', 'user', 'lan-fileserver.service');
}
function systemdContent() {
  return `[Unit]
Description=LAN File Server
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin()} ${SERVER}
WorkingDirectory=${PROJECT_DIR}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/* ---------------- Termux: Boot ---------------- */
function termuxBoot() {
  return path.join(process.env.HOME, '.termux', 'boot', 'start-fileserver.sh');
}
function termuxContent() {
  return `#!/data/data/com.termux/files/usr/bin/bash
# 开机启动局域网文件服务器（Termux:Boot 自启动，守护循环防崩）
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:$PREFIX/bin/applets:$PATH
export HOME=/data/data/com.termux/files/home

termux-wake-lock 2>/dev/null

FS="$HOME/projects/fileserver"
cd "$FS" || exit 1

# 若已有实例在跑则不重复启动
if [ -f "$FS/server.pid" ] && kill -0 "$(cat $FS/server.pid)" 2>/dev/null; then
  exit 0
fi

while true; do
  node server.js >> "$FS/server.log" 2>&1
  echo "$(date) node exited, restarting..." >> "$FS/server.log"
  sleep 3
done
`;
}

/* ---------------- 统一接口 ---------------- */

async function enable() {
  const p = platform();
  const cwd = process.cwd();
  process.chdir(PROJECT_DIR); // 保证 node 以项目目录为 cwd 启动

  if (p === 'windows') {
    const r = await winCmd('add');
    console.log(r.err ? `  [失败] ${r.stderr}` : '  [OK] 已写入注册表启动项（HKCU\\...\\Run）');
    return !r.err;
  }
  if (p === 'macos') {
    const f = macPlist();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, macPlistContent());
    await sh('launchctl', ['load', '-w', f]);
    console.log(`  [OK] 已写入 ${f} 并加载`);
    return true;
  }
  if (p === 'termux') {
    const f = termuxBoot();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, termuxContent());
    fs.chmodSync(f, 0o755);
    console.log(`  [OK] 已写入 ${f}`);
    console.log('       前提：手机装 Termux:Boot 插件并打开过一次（授权自启动）');
    return true;
  }
  // linux systemd user
  const f = systemdUnit();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, systemdContent());
  await sh('systemctl', ['--user', 'daemon-reload']);
  await sh('systemctl', ['--user', 'enable', 'lan-fileserver']);
  console.log(`  [OK] 已写入 ${f} 并 systemctl --user enable`);
  return true;
}

async function disable() {
  const p = platform();
  if (p === 'windows') {
    const r = await sh('reg', ['delete', WIN_REG_KEY, '/v', APP_ID, '/f']);
    console.log(r.err ? `  [失败或本就不存在] ${r.stderr}` : '  [OK] 已从注册表移除');
    return true;
  }
  if (p === 'macos') {
    const f = macPlist();
    await sh('launchctl', ['unload', '-w', f]).catch(() => {});
    try { fs.unlinkSync(f); console.log('  [OK] 已移除 LaunchAgent'); } catch { console.log('  本就不存在'); }
    return true;
  }
  if (p === 'termux') {
    const f = termuxBoot();
    try { fs.unlinkSync(f); console.log('  [OK] 已移除 boot 脚本'); } catch { console.log('  本就不存在'); }
    return true;
  }
  await sh('systemctl', ['--user', 'disable', 'lan-fileserver']);
  try { fs.unlinkSync(systemdUnit()); } catch {}
  await sh('systemctl', ['--user', 'daemon-reload']);
  console.log('  [OK] 已 disable 并移除 unit');
  return true;
}

async function status() {
  const p = platform();
  console.log(`  平台: ${p} (${process.platform})`);
  if (p === 'windows') {
    const r = await winQuery();
    console.log(r.err ? '  自启动: ✗ 未启用' : '  自启动: ✓ 已启用');
    console.log(r.stdout ? r.stdout.trim().split('\n').slice(1).join('\n').trim() : '');
    return;
  }
  if (p === 'macos') {
    console.log(fs.existsSync(macPlist()) ? '  自启动: ✓ 已启用' : '  自启动: ✗ 未启用');
    return;
  }
  if (p === 'termux') {
    console.log(fs.existsSync(termuxBoot()) ? '  自启动: ✓ 已启用' : '  自启动: ✗ 未启用');
    return;
  }
  const r = await sh('systemctl', ['--user', 'is-enabled', 'lan-fileserver']);
  console.log(r.stdout.includes('enabled') ? '  自启动: ✓ 已启用' : '  自启动: ✗ 未启用');
}

/** 服务启动时根据 config.autoStart 自动应用（幂等） */
async function applyFromConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'config.json'), 'utf8'));
    if (cfg.autoStart === true) return enable();
    if (cfg.autoStart === false) return disable();
  } catch { /* 无配置不动作 */ }
}

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  (async () => {
    console.log('\n开机自启动管理 — LAN FileServer');
    console.log('='.repeat(46));
    if (cmd === 'enable') await enable();
    else if (cmd === 'disable') await disable();
    else await status();
    console.log('');
    process.exit(0);
  })();
}

module.exports = { enable, disable, status, applyFromConfig, platform };

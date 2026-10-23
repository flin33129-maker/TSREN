#!/usr/bin/env node
'use strict';

/**
 * IM 测试数据清理（运维脚本；与 /api/im/purge 等价的离线版本）
 *
 * 用途：多轮 UI 验收留下的 `R15-IM-测试群-*` 群会永久堆积在聊天列表里。
 * 本脚本直接操作 data/im.json：按名称前缀删除群频道 + 其消息 + 已读戳，
 * 可保留最近 N 个群作证据。
 *
 * 为什么需要离线版：station 进程启动时把 im.json 读进内存，运行中修改文件
 * 不会被服务热加载。**脚本执行后需要重启 station 才生效**；重启前请不要在
 * 页面上发消息（否则内存里的旧数据会覆盖文件）。见文末提示。
 *
 * 用法：
 *   node ops/im/cleanup.cjs                                   # 预览（默认 dry-run）
 *   node ops/im/cleanup.cjs --prefix 'R15-IM-测试群-' --keep 2 # 预览
 *   node ops/im/cleanup.cjs --apply --prefix 'R15-IM-测试群-' --keep 2 --confirm 'R15-IM-测试群-'
 *   node ops/im/cleanup.cjs --data /opt/station/fileserver/data --json
 *
 * 退出码：0 成功（含无匹配）；1 参数/文件错误。
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    dataDir: process.env.STATION_DATA || '/opt/station/fileserver/data',
    prefix: 'R15-IM-测试群-',
    keep: 2,
    apply: false,
    confirm: '',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--data') out.dataDir = next();
    else if (a === '--prefix') out.prefix = next();
    else if (a === '--keep') out.keep = Math.max(0, Number(next()) || 0);
    else if (a === '--apply') out.apply = true;
    else if (a === '--confirm') out.confirm = next();
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node cleanup.cjs [--data DIR] [--prefix TEXT] [--keep N] [--apply --confirm TEXT] [--json]');
      process.exit(0);
    } else {
      console.error('未知参数: ' + a);
      process.exit(1);
    }
  }
  return out;
}

function purgeFile(opts) {
  const file = path.join(opts.dataDir, 'im.json');
  if (!fs.existsSync(file)) return { ok: false, error: '找不到 ' + file };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'im.json 不是合法 JSON: ' + e.message };
  }
  if (!data || !Array.isArray(data.channels)) return { ok: false, error: 'im.json 缺少 channels' };
  if (opts.prefix.length < 2) return { ok: false, error: 'prefix 至少 2 个字符' };
  if (opts.prefix === '*' || opts.prefix === 'general' || opts.prefix === '/') {
    return { ok: false, error: '拒绝危险 prefix' };
  }

  const messages = Array.isArray(data.messages) ? data.messages : [];
  const readAt = data.readAt && typeof data.readAt === 'object' ? data.readAt : {};
  const matched = data.channels.filter((c) => c && c.type === 'group' && String(c.name || '').startsWith(opts.prefix));
  const sorted = matched.slice().sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
  const keepIds = new Set(sorted.slice(0, opts.keep).map((c) => c.id));
  const removeChannels = matched.filter((c) => !keepIds.has(c.id));
  const removeIds = new Set(removeChannels.map((c) => c.id));

  const summary = {
    ok: true,
    file,
    apply: opts.apply,
    prefix: opts.prefix,
    keep: opts.keep,
    before: { channels: data.channels.length, messages: messages.length, readAt: Object.keys(readAt).length },
    matched: matched.map((c) => ({ id: c.id, name: c.name, members: (c.members || []).length, created: c.created })),
    willRemove: removeChannels.map((c) => ({ id: c.id, name: c.name, members: (c.members || []).length, created: c.created })),
    willKeep: sorted.slice(0, opts.keep).map((c) => ({ id: c.id, name: c.name })),
    removed: { channels: 0, messages: 0, readAt: 0 },
    backup: '',
  };
  if (!removeIds.size) {
    summary.after = { ...summary.before };
    return summary;
  }

  data.channels = data.channels.filter((c) => !removeIds.has(c.id));
  data.messages = messages.filter((m) => !removeIds.has(m && m.ch));
  for (const key of Object.keys(readAt)) {
    if (removeIds.has(String(key).split('|')[0])) delete readAt[key];
  }
  data.readAt = readAt;
  summary.after = { channels: data.channels.length, messages: data.messages.length, readAt: Object.keys(readAt).length };
  summary.removed = {
    channels: removeChannels.length,
    messages: messages.length - data.messages.length,
    readAt: summary.before.readAt - Object.keys(readAt).length,
  };

  if (opts.apply) {
    if (opts.confirm !== opts.prefix) {
      return { ok: false, error: '--apply 需要 --confirm <prefix> 且与 --prefix 完全一致' };
    }
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backup = file + '.bak-' + ts;
    fs.copyFileSync(file, backup);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    summary.backup = backup;
    summary.applied = true;
  }
  return summary;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = purgeFile(opts);
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else if (!r.ok) {
    console.error('[cleanup] ' + r.error);
  } else {
    console.log('[cleanup] file=' + r.file + ' apply=' + r.apply + ' prefix="' + r.prefix + '" keep=' + r.keep);
    console.log('[cleanup] 匹配 ' + r.matched.length + ' 个：' + r.matched.map((c) => c.name).join(', '));
    console.log('[cleanup] 删除 ' + r.willRemove.length + ' 个：' + r.willRemove.map((c) => c.name).join(', '));
    console.log('[cleanup] 保留 ' + r.willKeep.length + ' 个：' + r.willKeep.map((c) => c.name).join(', '));
    console.log('[cleanup] channels ' + r.before.channels + ' → ' + r.after.channels
      + '，messages ' + r.before.messages + ' → ' + r.after.messages
      + '，readAt ' + r.before.readAt + ' → ' + r.after.readAt);
    if (r.backup) console.log('[cleanup] 备份：' + r.backup);
    if (!r.apply) console.log('[cleanup] 预览模式：加 --apply --confirm "<prefix>" 才会写盘');
    else console.log('[cleanup] 已写盘。注意：运行中的 station 仍持有旧内存数据，需重启 station 后生效；重启前不要发 IM 消息。');
  }
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { purgeFile };

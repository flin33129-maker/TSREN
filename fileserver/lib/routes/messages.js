'use strict';

/**
 * R15：统一消息中心接口（系统 / 操作 / 协作 / AI 四类消息的唯一出口）。
 *
 * 为什么需要这一层：
 *   原来"消息"是散的：
 *     · 系统告警在 data/notify-log.json（由 Notifier 写，格式 {time,event,title,body,ok}）
 *     · 操作结果在 data/audit.log（JSONL，{ts,ip,user,action,disk,path,ok,detail}）
 *     · 协作动态在 data/board.json（协同板）
 *     · AI 回复没有历史入口
 *   前端各页面自己拼，于是"消息黑白不一致""有的已读有的没读"。
 *   这里把四类聚合成**统一形状**（id/kind/title/body/at/read/link），
 *   已读状态按用户持久化（data/message-read.json），前端只渲染一种组件。
 *
 * 安全：
 *   · 必须登录；非管理员只能看到自己的操作消息；
 *   · 路径信息只回显"相对路径"，不回显绝对路径；
 *   · 已读文件按用户 id 存，不跨用户。
 *
 * 接口：
 *   GET  /api/r15/messages?kind=all|system|operation|collaboration|ai&unread=1&limit=100
 *   POST /api/r15/messages/read       { ids: [] }
 *   POST /api/r15/messages/read-all
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 审计动作 → 中文标题 + 跳转。只收"值得提醒的"动作：
 *  登录成功、浏览、上传下载这类高频动作不进消息中心（否则一天几百条，用户直接不看）。
 *  失败类（login-fail）与不可逆/安全相关动作必须进。 */
const AUDIT_MAP = {
  delete: ['删除文件', 'files'],
  purge: ['彻底删除', 'files'],
  restore: ['从回收站恢复', 'files'],
  'share-create': ['创建分享链接', 'files'],
  'share-revoke': ['撤销分享链接', 'files'],
  'login-fail': ['登录失败', 'security'],
  'smb-sync': ['SMB 账号同步', 'services'],
  'smb-enable': ['开通 SMB 共享', 'services'],
  'totp-enable': ['启用两步验证', 'security'],
  'totp-disable': ['关闭两步验证', 'security'],
  'device-remove': ['移除设备', 'security'],
  'snapshot-create': ['创建快照', 'security'],
  'snapshot-restore': ['恢复快照', 'security'],
  'ai-chat': ['AI 对话', 'assistant'],
};

function md5(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 16);
}

function safeJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 读审计日志尾部（按行倒序取最近 N 条，避免整文件读入内存） */
function tailAudit(file, max) {
  let fd;
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 1024 * 1024); // 最多读 1MB 尾部
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    const lines = buf.toString('utf8').split('\n').filter((x) => x.trim().startsWith('{'));
    return lines.slice(-max).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function toMs(v) {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : Date.now();
}

module.exports = {
  name: 'messages',
  prefixes: ['/api/r15/messages'],

  async handle(ctx) {
    const { res, app, user, pathname, method, query, sendJSON, readBody } = ctx;
    if (!user) return sendJSON(res, 401, { error: '需要登录' }), true;

    const dataDir = (app && app.cfg && app.cfg.dataDir) || path.join(process.cwd(), 'data');
    const readFile = path.join(dataDir, 'message-read.json');
    const readAll = safeJson(readFile, {});
    const mine = readAll[user.id || user.username] || {};

    if (pathname === '/api/r15/messages' && method === 'GET') {
      const wantKind = String(query.kind || 'all');
      const onlyUnread = String(query.unread || '') === '1';
      const limit = Math.min(500, Math.max(1, Number(query.limit) || 120));
      const items = [];

      /* ① 系统消息：Notifier 告警（同一 event+body 去重，只留最新一条） */
      if (wantKind === 'all' || wantKind === 'system') {
        const log = safeJson(path.join(dataDir, 'notify-log.json'), []);
        const seen = new Set();
        for (const e of (Array.isArray(log) ? log : [])) {
          const key = String(e.event || '') + '|' + String(e.body || '');
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            id: 'sys-' + md5(key),
            kind: 'system',
            title: e.title || '系统通知',
            body: e.body || '',
            at: toMs(e.time),
            read: !!mine['sys-' + md5(key)],
            link: 'settings',
            meta: { event: e.event || '', ok: e.ok !== false },
          });
        }
      }

      /* ② 操作消息：审计日志（非管理员只看自己的） */
      if (wantKind === 'all' || wantKind === 'operation') {
        const isAdmin = user.role === 'admin';
        const entries = tailAudit(path.join(dataDir, 'audit.log'), 400)
          .filter((e) => (isAdmin ? true : e.user === user.username))
          .slice(-120)
          .reverse();
        for (const e of entries) {
          const map = AUDIT_MAP[e.action];
          if (!map) continue; // 未登记的动作不进消息中心（避免噪音与信息泄漏）
          const id = 'op-' + md5([e.ts, e.user, e.action, e.disk, e.path, e.ok].join('|'));
          const detail = [e.disk, e.path].filter(Boolean).join(' / ');
          const base = map[0];
          const title = e.ok === false && !base.includes('失败') ? base + '（失败）' : base;
          items.push({
            id,
            kind: 'operation',
            title,
            body: [detail, e.detail].filter(Boolean).join(' · ') || (e.ok === false ? '操作未成功' : '操作成功'),
            at: toMs(e.ts),
            read: !!mine[id],
            link: map[1],
            meta: { action: e.action, ok: e.ok !== false },
          });
        }
      }

      /* ③ 协作消息：协同板（board.json）+ 办公 @提醒（data/office/notify.json）
         ⚠️ 字段坑（办公团队实测指出）：lib/board.js 落盘的字段是 user / ts，
         不是 author / at；早期写错过，会导致标题永远是"协作者"、时间兜成当前时间。 */
      if (wantKind === 'all' || wantKind === 'collaboration') {
        const board = safeJson(path.join(dataDir, 'board.json'), { items: [] });
        const list = Array.isArray(board) ? board : (board.items || []);
        for (const b of list.slice(-60)) {
          const author = b.user || b.author || b.by || '协作者';
          const ts = b.ts != null ? b.ts : (b.at != null ? b.at : b.time);
          const text = String(b.text || b.body || '').slice(0, 200);
          const id = 'co-' + md5([b.id || ts, text].join('|'));
          items.push({
            id,
            kind: 'collaboration',
            title: author + (b.kind === 'task' ? ' 分配了任务' : ' 发布到协同板'),
            body: text,
            at: toMs(ts),
            read: !!mine[id],
            link: 'office',
            meta: { pinned: !!b.pinned, source: 'board' },
          });
        }

        /* 办公 @提醒 / 评论通知：只推给被提醒的人（to），管理员可看到自己的那部分；
           发给别人的提醒不能泄漏到我的消息中心。 */
        const oNotify = safeJson(path.join(dataDir, 'office', 'notify.json'), []);
        for (const n of (Array.isArray(oNotify) ? oNotify : []).slice(-80)) {
          const to = String(n.to || '');
          if (to && to !== user.username && user.role !== 'admin') continue;
          if (to && to !== user.username && user.role === 'admin') {
            // 管理员也不展示"发给别人"的 @提醒（避免越权窥探），除非本来就是发给他的
            continue;
          }
          const id = 'co-' + md5(['office', n.id || n.at, n.title].join('|'));
          items.push({
            id,
            kind: 'collaboration',
            title: String(n.title || '协作提醒').slice(0, 80),
            body: String(n.body || '').slice(0, 200),
            at: toMs(n.at),
            read: !!mine[id],
            link: 'office' + (n.docId ? '?doc=' + encodeURIComponent(n.docId) : ''),
            meta: { source: 'office-notify', docId: n.docId || '', from: n.from || '' },
          });
        }
      }

      /* ④ AI 消息：AI 网关若落盘会话则以最新回复作为消息（存在即接入） */
      if (wantKind === 'all' || wantKind === 'ai') {
        const dir = path.join(dataDir, 'ai-users');
        let files = [];
        try {
          files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        } catch {
          files = [];
        }
        for (const f of files.slice(0, 50)) {
          const st = safeJson(path.join(dir, f), null);
          if (!st) continue;
          const owner = st.username || st.user || '';
          if (owner && owner !== user.username && user.role !== 'admin') continue;
          const sessions = Array.isArray(st.sessions) ? st.sessions : [];
          for (const s of sessions.slice(-5)) {
            const at = toMs(s.updatedAt || s.at || s.time);
            const id = 'ai-' + md5([s.id || s.title, owner].join('|'));
            items.push({
              id,
              kind: 'ai',
              title: 'AI 会话：' + String(s.title || '未命名').slice(0, 40),
              body: String(s.summary || s.lastMessage || s.preview || '').slice(0, 160),
              at,
              read: !!mine[id],
              link: 'assistant',
              meta: { model: s.model || '' },
            });
          }
        }
      }

      items.sort((a, b) => b.at - a.at);

      /* 去噪：同类同文案在 10 分钟窗口内重复出现（例如别人反复试错密码、
         批量删除同类文件）只留最新一条，并给 count 计数。
         不这么做消息中心会被"登录失败 ×17"淹没，用户直接不看了。 */
      const DEDUPE_MS = 10 * 60 * 1000;
      const merged = [];
      const recentByKey = new Map();
      for (const it of items) {
        const key = it.kind + '|' + it.title + '|' + (it.body || '');
        const prev = recentByKey.get(key);
        if (prev && prev.at - it.at <= DEDUPE_MS) {
          prev.count = (prev.count || 1) + 1;
          continue;
        }
        it.count = 1;
        recentByKey.set(key, it);
        merged.push(it);
      }

      const filtered = onlyUnread ? merged.filter((x) => !x.read) : merged;
      const counts = {};
      for (const k of ['all', 'system', 'operation', 'collaboration', 'ai']) counts[k] = 0;
      for (const it of merged) {
        counts.all++;
        counts[it.kind] = (counts[it.kind] || 0) + 1;
      }
      const unread = merged.filter((x) => !x.read).length;
      sendJSON(res, 200, { ok: true, items: filtered.slice(0, limit), unread, counts, total: merged.length });
      return true;
    }

    if (pathname === '/api/r15/messages/read' && method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
      const box = readAll[user.id || user.username] || {};
      const now = Date.now();
      for (const id of ids) box[String(id)] = now;
      // 只保留最近 3000 条已读记录，防止文件无限增长
      const keys = Object.keys(box);
      if (keys.length > 3000) {
        keys.sort((a, b) => box[a] - box[b]);
        for (const k of keys.slice(0, keys.length - 3000)) delete box[k];
      }
      readAll[user.id || user.username] = box;
      try {
        fs.writeFileSync(readFile, JSON.stringify(readAll), { mode: 0o600 });
      } catch (e) {
        return sendJSON(res, 500, { error: '已读状态保存失败：' + (e && e.message) }), true;
      }
      sendJSON(res, 200, { ok: true, marked: ids.length });
      return true;
    }

    if (pathname === '/api/r15/messages/read-all' && method === 'POST') {
      /* 全读：把当前可见的 id 全部记为已读（由前端传入，避免服务端重复聚合） */
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8') || '{}');
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 2000) : [];
      const box = readAll[user.id || user.username] || {};
      const now = Date.now();
      for (const id of ids) box[String(id)] = now;
      readAll[user.id || user.username] = box;
      try {
        fs.writeFileSync(readFile, JSON.stringify(readAll), { mode: 0o600 });
      } catch (e) {
        return sendJSON(res, 500, { error: '已读状态保存失败：' + (e && e.message) }), true;
      }
      sendJSON(res, 200, { ok: true, marked: ids.length });
      return true;
    }

    return false;
  },
};

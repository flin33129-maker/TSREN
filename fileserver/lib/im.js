'use strict';
/**
 * IM —— 支持私聊 / 群聊 / 成员管理
 *
 * channel 结构：
 *   { id, name, type: 'group'|'dm', members: [uid], created, owner }
 *   dm 的 id 固定为 dm_<uidA>_<uidB>（uid 升序拼接），保证双向唯一
 * 消息：
 *   { id, ch, from, uid, text, ts, file? }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MSG = 4000;
const MAX_TEXT = 4000;
/* R9-IM-1：state() 返回体必须有界。
   旧实现里 since>0 时把「全部历史消息」一次性吐回去（几百 KB～几 MB），
   频道一多就顶爆浏览器；而且每个频道的消息数也没有上限，内存只增不减。
   现在：单次响应最多 MAX_STATE_MSGS 条（只留最新），
   每个频道参与统计/展示的消息最多 MAX_CH_MSGS 条（超出裁剪最旧的）。 */
const MAX_STATE_MSGS = 300;
const MAX_CH_MSGS = 200;

class IM {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'im.json');
    this.data = { channels: [], messages: [], readAt: {}, contacts: {} };
    this.timer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.data.channels = Array.isArray(raw.channels) ? raw.channels : [];
        this.data.messages = Array.isArray(raw.messages) ? raw.messages : [];
        this.data.readAt = raw.readAt && typeof raw.readAt === 'object' ? raw.readAt : {};
        this.data.contacts = raw.contacts && typeof raw.contacts === 'object' ? raw.contacts : {};
      }
    } catch (e) { /* 首次 */ }

    this.data.channels.forEach((c) => {
      if (!c.type) c.type = 'group';
      if (!Array.isArray(c.members)) c.members = [];
    });
    if (!this.data.channels.length) {
      this.data.channels.push({ id: 'general', name: '全员', type: 'group', members: [], created: Date.now(), owner: 'system' });
    }
  }

  _flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) {}
  }

  _save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
        fs.renameSync(this.file + '.tmp', this.file);
      } catch (e) {}
    }, 400);
    if (this.timer.unref) this.timer.unref();
  }

  dmId(a, b) {
    return 'dm_' + [String(a), String(b)].sort().join('_');
  }

  ensureDm(uidA, uidB) {
    const id = this.dmId(uidA, uidB);
    let ch = this.data.channels.find((c) => c.id === id);
    if (!ch) {
      ch = { id, name: '', type: 'dm', members: [String(uidA), String(uidB)], created: Date.now(), owner: String(uidA) };
      this.data.channels.push(ch);
      this._save();
    }
    return ch;
  }

  visible(user) {
    const uid = String((user && user.id) || '');
    return this.data.channels.filter((c) => {
      if (c.id === 'general') return true;
      if (c.type === 'dm') return c.members.indexOf(uid) >= 0;
      if (c.type === 'group') return !c.members.length || c.members.indexOf(uid) >= 0;
      return true;
    });
  }

  state(since, user, usersOf) {
    const uid = String((user && user.id) || '');
    const chans = this.visible(user).map((c) => {
      const all = this.data.messages.filter((m) => m.ch === c.id);
      /* R9-IM-1：频道内消息超上限时裁剪最旧的（内存与响应体都要有界） */
      const msgs = all.length > MAX_CH_MSGS ? all.slice(-MAX_CH_MSGS) : all;
      const last = msgs[msgs.length - 1];
      const readAt = this.data.readAt[c.id + '|' + uid] || 0;
      const unread = all.filter((m) => m.ts > readAt && m.uid !== uid).length;
      let name = c.name;
      if (c.type === 'dm') {
        const other = c.members.find((x) => x !== uid) || uid;
        const u = usersOf ? usersOf(other) : null;
        name = u ? (u.nickname || u.username) : c.members.join(' / ');
      }
      return {
        id: c.id,
        name: name || '未命名',
        type: c.type,
        members: c.members,
        lastText: last ? (last.text || (last.file ? '[文件]' + last.file.name : '')).slice(0, 60) : '',
        lastTs: last ? last.ts : 0,
        lastFrom: last ? last.from : '',
        unread,
        count: msgs.length,     // 本次统计/展示的消息数（有界）
        total: all.length,     // 频道内消息总数
      };
    }).sort((a, b) => b.lastTs - a.lastTs);

    const ids = new Set(chans.map((c) => c.id));
    let msgs = (since > 0 ? this.data.messages.filter((m) => m.ts > since) : this.data.messages.slice(-MAX_STATE_MSGS))
      .filter((m) => ids.has(m.ch));
    /* R9-IM-1：增量拉取同样有界 —— 只保留最新的 MAX_STATE_MSGS 条 */
    if (msgs.length > MAX_STATE_MSGS) msgs = msgs.slice(-MAX_STATE_MSGS);
    return { ok: true, channels: chans, messages: msgs, serverTime: Date.now() };
  }

  send(ch, user, text, file) {
    const uid = String((user && user.id) || '');
    const channel = this.data.channels.find((c) => c.id === ch);
    if (!channel) return { error: 'channel not found' };
    if (channel.type === 'dm' && channel.members.indexOf(uid) < 0) return { error: 'not a member' };
    /* R9-IM-1：成员非空的群频道也要校验成员资格 ——
       否则猜到 id 就能往别人频道里发消息（visible() 本来就按成员过滤）。 */
    if (channel.type === 'group' && channel.members.length && channel.members.indexOf(uid) < 0) {
      return { error: 'not a member' };
    }
    const t = String(text || '').slice(0, MAX_TEXT).trim();
    if (!t && !file) return { error: 'empty message' };
    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      ch,
      from: (user && (user.nickname || user.username)) || '匿名',
      uid,
      text: t,
      ts: Date.now(),
    };
    if (file && file.name) {
      msg.file = { name: String(file.name).slice(0, 200), disk: String(file.disk || 'public'), path: String(file.path || ''), size: Number(file.size) || 0 };
    }
    this.data.messages.push(msg);
    if (this.data.messages.length > MAX_MSG) this.data.messages = this.data.messages.slice(-MAX_MSG);
    this._save();
    return { ok: true, message: msg };
  }

  createGroup(name, memberIds, owner) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return { error: '名称不能为空' };
    const members = Array.isArray(memberIds) ? memberIds.map(String).filter(Boolean) : [];
    const ownerId = String((owner && owner.id) || '');
    if (ownerId && members.indexOf(ownerId) < 0) members.push(ownerId);
    const id = 'g' + crypto.randomBytes(4).toString('hex');
    const ch = { id, name: n, type: 'group', members, created: Date.now(), owner: ownerId };
    this.data.channels.push(ch);
    this._save();
    return { ok: true, channel: ch };
  }

  /**
   * R9-IM-1：创建频道（server.js 的 POST /api/im/channel 直接调它）。
   * 旧代码根本没有这个方法 —— 路由一调就 TypeError → 500。
   *
   * 两个要点：
   *  1) 频道 id 必须**不可预测**：用 8 字节随机数（16 位十六进制）。
   *     32 位自增 id 会被枚举出来撞号，别人拿着猜到的 id 就能进你的频道。
   *  2) 频道名全局唯一：重名直接报错，不静默造出两个同名频道。
   */
  createChannel(name, user) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return { error: '名称不能为空' };
    const uid = String((user && user.id) || '');

    const dup = this.data.channels.find((c) => c.type !== 'dm' && String(c.name || '').trim() === n);
    if (dup) return { error: '频道名称已存在' };

    let id = crypto.randomBytes(8).toString('hex');   // 16 位随机十六进制
    let guard = 0;
    while (this.data.channels.some((c) => c.id === id) && guard++ < 8) {
      id = crypto.randomBytes(8).toString('hex');
    }
    const ch = {
      id,
      name: n,
      type: 'group',
      members: uid ? [uid] : [],
      created: Date.now(),
      owner: uid,
    };
    this.data.channels.push(ch);
    this._save();
    return { ok: true, channel: ch };
  }


  /* ---------- 联系人关系（备注 / 星标 / 黑名单） ---------- */
  _rel(myUid, peerUid) {
    this.data.contacts = this.data.contacts || {};
    this.data.contacts[myUid] = this.data.contacts[myUid] || {};
    this.data.contacts[myUid][peerUid] = this.data.contacts[myUid][peerUid] || {};
    return this.data.contacts[myUid][peerUid];
  }

  getRel(myUid, peerUid) {
    const r = (this.data.contacts && this.data.contacts[myUid] && this.data.contacts[myUid][peerUid]) || {};
    return { remark: r.remark || '', starred: !!r.starred, blocked: !!r.blocked, deleted: !!r.deleted };
  }

  setRel(myUid, peerUid, patch) {
    const r = this._rel(String(myUid), String(peerUid));
    if (patch.remark !== undefined) r.remark = String(patch.remark).slice(0, 32);
    if (patch.starred !== undefined) r.starred = !!patch.starred;
    if (patch.blocked !== undefined) r.blocked = !!patch.blocked;
    if (patch.deleted !== undefined) r.deleted = !!patch.deleted;
    /* 联系人关系是低频写、且用户期望立即生效，直接落盘不走 debounce */
    this._flush();
    return { ok: true, rel: this.getRel(myUid, peerUid) };
  }

  /** 所有联系人的关系（前端一次性拿） */
  allRels(myUid) {
    const m = (this.data.contacts && this.data.contacts[myUid]) || {};
    return m;
  }

  markRead(ch, user) {
    const uid = String((user && user.id) || '');
    if (!uid || !ch) return;
    this.data.readAt[ch + '|' + uid] = Date.now();
    this._save();
  }
}

module.exports = { IM, MAX_MSG, MAX_STATE_MSGS, MAX_CH_MSGS };

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  let fail = 0;
  let pass = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`✓  ${name}`); }
    else { fail++; console.log(`✗  ${name}${extra ? '  →  ' + extra : ''}`); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imtest-'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } };
  const im = new IM(tmp);
  const user = { id: 'u1', username: '张三', nickname: '张三' };
  const user2 = { id: 'u2', username: '李四' };

  try {
    /* ---- createChannel ---- */
    check('createChannel 方法存在', typeof im.createChannel === 'function');
    const c1 = im.createChannel('研发', user);
    check('创建频道成功', !!(c1.ok && c1.channel), JSON.stringify(c1));
    check('频道 id 为 16 位随机十六进制', /^[0-9a-f]{16}$/.test(c1.channel.id), c1.channel.id);
    check('创建者是成员与拥有者', c1.channel.members[0] === 'u1' && c1.channel.owner === 'u1');
    const c2 = im.createChannel('市场', user);
    check('两次创建 id 不同', c1.channel.id !== c2.channel.id);
    check('两个 id 都是 16 位十六进制', /^[0-9a-f]{16}$/.test(c2.channel.id));

    const before = im.data.channels.length;
    const dup = im.createChannel('研发', user);
    check('重名被拒', !!dup.error && !dup.ok, JSON.stringify(dup));
    check('重名不会多建频道', im.data.channels.length === before);
    const dup2 = im.createChannel('研发', user2);
    check('他人重名同样被拒', !!dup2.error, JSON.stringify(dup2));
    check('空名被拒', !!im.createChannel('', user).error);
    check('空白名被拒', !!im.createChannel('   ', user).error);

    /* ---- 消息与裁剪 ---- */
    const chId = c1.channel.id;
    for (let i = 0; i < 350; i++) im.send(chId, user, '消息' + i);
    const st = im.state(0, user, () => null);
    const ch = st.channels.find((c) => c.id === chId);
    check('state 返回 ok', st.ok === true);
    check('频道消息数被裁剪到上限', ch.count <= 200, String(ch.count));
    check('频道总数如实统计', ch.total === 350, String(ch.total));
    check('state 消息条数有界', st.messages.length <= 300, String(st.messages.length));
    check('保留的是最新消息', st.messages.length && /消息34\d?$/.test(st.messages[st.messages.length - 1].text), st.messages.length ? st.messages[st.messages.length - 1].text : '');

    /* 增量拉取同样有界 */
    const st2 = im.state(1, user, () => null);
    check('增量拉取也有界', st2.messages.length <= 300, String(st2.messages.length));

    /* 内存不会无限增长 */
    for (let i = 0; i < 5000; i++) im.send(chId, user, '洪水' + i);
    check('全局消息数有上限', im.data.messages.length <= 4000, String(im.data.messages.length));
    const st3 = im.state(0, user, () => null);
    check('洪水后 state 仍有界', st3.messages.length <= 300, String(st3.messages.length));

    /* 非成员不能发言 */
    const other = im.createChannel('私密组', user2);
    const sendRes = im.send(other.channel.id, user, '闯入');
    check('非成员无法向他人频道发言', !!sendRes.error, JSON.stringify(sendRes));

    im._flush();
    check('IM 状态已落盘', fs.existsSync(path.join(tmp, 'im.json')));
    const im2 = new IM(tmp);
    check('重启后频道仍在', im2.data.channels.some((c) => c.id === chId));

    cleanup();
    console.log(`\n断言 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
    if (fail) { console.log('自测未通过'); process.exit(1); }
    console.log('自测全部通过');
    process.exit(0);
  } catch (e) {
    console.error('✗  自测异常:', e);
    try { cleanup(); } catch { /* 忽略 */ }
    process.exit(1);
  }
}

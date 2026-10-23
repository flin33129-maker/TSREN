'use strict';

/* =====================================================================
   station.js — 局域网工作站 v4 前端运行时
   一条 SSE 长连接 + 四个能力面板（总览/设备/任务/协同板/事件流）。
   依赖 app.js 全局：$ / el / api / jsonPost / toast / fmtSize / fmtTime / state / loadList
   依赖 panels.js 全局：openPanel

   对外暴露 window.Workstation：
     beginTask({name,type,disk,path,total}) → 服务端任务 id（跨设备可见）
     progressTask(id, {done,total,detail})  → 节流推送
     endTask(id, {ok,error,result})
     isCancelled(id)                        → 供执行体轮询取消
   ===================================================================== */

(function () {
  /* ------------------------------ 常量与状态 ------------------------------ */

  const CHANNELS = ['system', 'files', 'tasks', 'devices', 'board', 'remote', 'sync'];
  const LS_ID = 'ws.deviceId';
  const LS_NAME = 'ws.deviceName';
  const LS_TOKEN = 'ws.deviceToken';       // 配对令牌（换取信任身份）
  const LS_ACCEPT = 'ws.acceptRemote';     // 是否接受被远程控制
  const HEARTBEAT_MS = 25000;
  const LEDGER_MAX = 200;
  const TASK_PUSH_MS = 400;          // 本地进度推送节流

  const S = {
    deviceId: '',
    deviceName: '',
    selfType: 'unknown',
    es: null,
    connected: false,
    retries: 0,
    devices: { online: [], offline: [], capabilities: [], stats: {} },
    tasks: [],
    taskStats: {},
    board: [],
    boardStats: {},
    hub: null,
    monitor: null,
    tab: 'over',
    ledger: [],
    open: false,
    /* v4.1 */
    token: '',                       // 本机设备令牌
    trusted: false,                  // 是否已配对
    acceptRemote: true,              // 是否接受远程指令
    targets: [],                     // 可下发目标
    remoteLog: [],                   // 指令记录
    remoteStats: {},
    actions: [],                     // 可用动作
    execEnabled: false,
    syncState: null,                 // 本机同步游标
    syncStats: {},
    trust: { trusted: [], blocked: [], codes: [], requirePairing: false },
    isAdmin: false,
    /* v4.2：AI 助手 */
    aiBackends: [],
    aiActive: null,
    aiMsgs: [],                      // 对话历史（切标签不丢）
    aiDraft: '',                     // 未发送的输入
    aiBusy: false,
    aiIsAdmin: false,
    aiSystem: '',
    aiTemperature: 0.7,
    aiMaxTokens: 1024,
    aiNoThink: true,                 // 关思考：推理模型不吐思维链
    aiLastError: '',
    /* v4.3：工具开关（让 AI 真的能读写文件）+ 当前模型名（免探测显示） */
    aiAllowTools: true,
    aiAllowWrite: false,
    aiMaxToolRounds: 4,
    aiModel: '',
    aiName: '',
    _taskPush: new Map(),
    _hb: null,
    _refreshQueued: false,
    _flashTimer: null,
    _sseRetry: null,
  };

  /** v5：当前是否在某模块的某二级页（替代旧 S.open && S.tab 检查） */
  function onModule(hash, sub) {
    if (!window.Shell || Shell.route() !== hash) return false;
    return sub ? S.tab === sub : true;
  }

  /* ------------------------------ 工具 ------------------------------ */

  function uid() {
    try {
      if (self.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    } catch (e) { /* 老浏览器 */ }
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clock(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000));
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    return Math.round(s / 86400) + ' 天前';
  }

  const TYPE_ICON = { phone: '📱', tablet: '📲', pc: '🖥', laptop: '💻', tv: '📺', nas: '🗄', unknown: '❓' };

  const CAP_LABEL = {
    upload: '上传', download: '下载', preview: '预览',
    clipboard: '剪贴板', cast: '投屏', exec: '执行', camera: '拍摄', mic: '录音',
  };

  function detectSelf() {
    const ua = navigator.userAgent || '';
    let type = 'pc';
    if (/Tablet|iPad/i.test(ua)) type = 'tablet';
    else if (/Mobi|Android|iPhone/i.test(ua)) type = 'phone';
    else if (/TV|SmartTV|Large Screen/i.test(ua)) type = 'tv';

    let platform = 'unknown';
    if (/Android/i.test(ua)) platform = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
    else if (/Windows/i.test(ua)) platform = 'Windows';
    else if (/Mac OS X/i.test(ua)) platform = 'macOS';
    else if (/Linux/i.test(ua)) platform = 'Linux';

    const caps = ['upload', 'download', 'preview'];
    // 剪贴板 API 只在安全上下文可用（https/localhost）；http 局域网下会缺
    if (navigator.clipboard && (window.isSecureContext || location.hostname === 'localhost')) caps.push('clipboard');
    // 手机天然可以拍照/录音当采集端
    if (type === 'phone' || type === 'tablet') caps.push('camera', 'mic');
    // 大屏设备可当投屏接收端
    if (type === 'pc' || type === 'laptop' || type === 'tv') caps.push('cast');

    return { type, platform, caps };
  }

  /** 平台可读名：比裸类型更容易一眼分清是哪台机器 */
  function platformLabel(det) {
    const t = (det && det.type) || 'pc';
    const p = (det && det.platform) || 'unknown';
    if (p === 'Android') return t === 'tablet' ? '安卓平板' : '安卓手机';
    if (p === 'iOS') return /iPad/i.test(navigator.userAgent || '') ? 'iPad' : 'iPhone';
    if (p === 'Windows') return t === 'laptop' ? 'Win 笔记本' : 'Win 电脑';
    if (p === 'macOS') return t === 'laptop' ? 'MacBook' : 'Mac';
    if (p === 'Linux') return t === 'laptop' ? 'Linux 笔记本' : 'Linux 电脑';
    return { phone: '手机', tablet: '平板', pc: '电脑', laptop: '笔记本', tv: '电视', nas: 'NAS' }[t] || '设备';
  }

  /**
   * 由设备号派生的稳定 4 位短码。
   * 关键：默认名不能带服务器 IP —— 两台机器访问的是同一个地址，名字必然撞车。
   */
  function shortCode(id) {
    const s = String(id || '');
    let n = 2166136261;
    for (let i = 0; i < s.length; i++) { n ^= s.charCodeAt(i); n = Math.imul(n, 16777619) >>> 0; }
    return n.toString(36).toUpperCase().padStart(6, '0').slice(-4);
  }

  /** 默认设备名：平台 + 短码，例如「Win 电脑 · K7M2」 */
  function defaultName(det) {
    if (typeof det === 'string') det = { type: det };   // 兼容只传 type 的旧调用
    return platformLabel(det) + ' · ' + shortCode(S.deviceId);
  }

  /* ------------------------------ 设备注册 / 心跳 ------------------------------ */

  function loadIdentity() {
    let id = localStorage.getItem(LS_ID);
    if (!id) { id = uid(); localStorage.setItem(LS_ID, id); }
    S.deviceId = id;
    S.token = localStorage.getItem(LS_TOKEN) || '';
    S.acceptRemote = localStorage.getItem(LS_ACCEPT) !== '0';

    const det = detectSelf();
    S.selfType = det.type;
    S.deviceName = localStorage.getItem(LS_NAME) || defaultName(det);
    S.detect = det;
    S.autoName = !localStorage.getItem(LS_NAME);   // 未手动命名过 → 跟随默认名升级
  }

  async function registerSelf(force) {
    const det = S.detect || detectSelf();
    try {
      const r = await api('/api/devices/register', {
        method: 'POST',
        body: JSON.stringify({
          id: S.deviceId,
          name: S.deviceName,
          type: det.type,
          platform: det.platform,
          capabilities: det.caps,
          version: 'v4.1-workstation',
          app: 'web',
          token: S.token || undefined,
        }),
      });
      /* 注意：这里**不要**用服务端返回的名字覆盖本机名。
         默认名由本机设备号派生，稳定且唯一；若采纳服务端历史值，
         旧名字（如「电脑 · 73」）会反向把新默认名拽回去，导致改名永远不生效。
         手动命名走 localStorage(LS_NAME)，本机优先。 */
      if (r && typeof r.trusted === 'boolean') S.trusted = r.trusted;
      if (r && typeof r.requirePairing === 'boolean') S.requirePairing = r.requirePairing;
      if (force && r && r.isNew) toast('已作为「' + S.deviceName + '」接入工作站', 'ok');
      return true;
    } catch (e) {
      return false;
    }
  }

  function startHeartbeat() {
    if (S._hb) clearInterval(S._hb);
    S._hb = setInterval(() => {
      if (document.hidden) return;      // 后台不心跳，靠 TTL 自然淘汰
      registerSelf(false);
    }, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { registerSelf(false); connect(); }
    });
    window.addEventListener('online', () => { registerSelf(false); connect(); });
  }

  /* ------------------------------ SSE ------------------------------ */

  function connect() {
    if (S.es) { try { S.es.close(); } catch (e) { /* 忽略 */ } S.es = null; }
    let url = '/api/events?channels=' + CHANNELS.join(',');
    if (S.deviceId) url += '&device=' + encodeURIComponent(S.deviceId);

    let es;
    try { es = new EventSource(url); } catch (e) { return; }
    S.es = es;

    es.onopen = () => {
      S.connected = true;
      S.retries = 0;
      paintPill();
    };
    es.onerror = () => {
      // EventSource 自身会重连；这里只反映状态
      S.connected = false;
      paintPill();
    };

    const TYPES = [
      'hello', 'replay', 'server.ready',
      'files.changed',
      'task.created', 'task.progress', 'task.done', 'task.error',
      'task.cancelled', 'task.cleared', 'task.removed',
      'devices.online', 'devices.offline', 'devices.rejoin',
      'devices.update', 'devices.remove',
      'devices.paired', 'devices.unpaired', 'devices.blocked', 'devices.policy',
      'board.item', 'board.remove', 'board.clear',
      'remote.invoke', 'remote.ack', 'remote.result', 'remote.timeout',
      'sync.marked', 'notify.message',
      'share.created', 'share.revoked',
    ];
    for (const t of TYPES) es.addEventListener(t, (ev) => onEvent(t, ev));
    es.onmessage = (ev) => onEvent('message', ev);
  }

  function onEvent(type, ev) {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    const channel = (msg && msg.channel) || 'system';
    const payload = msg && msg.payload;

    pushLedger(channel, type, payload);

    switch (type) {
      case 'hello':
        S.hub = S.hub || {};
        if (msg && msg.clientId) S.hub.clientId = msg.clientId;
        break;

      case 'files.changed':
        onFilesChanged(payload);
        break;

      case 'task.created':
      case 'task.progress':
      case 'task.done':
      case 'task.error':
      case 'task.cancelled':
        upsertTask(payload, type);
        break;
      case 'task.removed':
        if (payload && payload.id) S.tasks = S.tasks.filter((x) => x.id !== payload.id);
        break;
      case 'task.cleared':
        S.tasks = S.tasks.filter((x) => x.status === 'running' || x.status === 'queued');
        break;

      case 'devices.online':
        if (payload && payload.id !== S.deviceId) flash('🛰 ' + (payload.name || '设备') + ' 已接入工作站');
        scheduleRefresh();
        reloadDevices();
        return;
      case 'devices.offline':
        if (payload && payload.id !== S.deviceId) flash('📴 ' + (payload.name || '设备') + ' 已离线');
        scheduleRefresh();
        reloadDevices();
        return;
      case 'devices.rejoin':
      case 'devices.update':
      case 'devices.remove':
        reloadDevices();
        return;

      case 'board.item':
        reloadBoard(true);
        return;
      case 'board.remove':
      case 'board.clear':
        reloadBoard(false);
        return;

      /* ---- v4.1：远程控制 ---- */
      case 'remote.invoke': {
        // 目标是自己 → 执行；否则只刷新面板
        const c = payload || {};
        if (c.target === S.deviceId) runRemoteCommand(c);
        else if (onModule('#/collab', 'ctl')) scheduleRefresh();
        return;
      }
      case 'remote.ack':
      case 'remote.result':
      case 'remote.timeout':
        if (payload && payload.from === S.deviceId) {
          if (type === 'remote.result') {
            flash((payload.status === 'done' ? '✅ ' : '⚠️ ') +
              (payload.actionLabel || payload.action) + ' → ' +
              (payload.targetName || '目标') +
              (payload.status === 'done' ? ' 执行成功' : ' ' + (payload.error || '失败')));
          } else if (type === 'remote.timeout') {
            flash('⏱ ' + (payload.actionLabel || payload.action) + ' 超时（' + (payload.error || '') + '）');
          }
        }
        if (onModule('#/collab', 'ctl')) reloadRemote();
        return;

      /* ---- v4.1：同步 / 配对 / 通知 ---- */
      case 'sync.marked':
        scheduleRefresh();
        return;
      case 'devices.paired':
        flash('🔗 ' + ((payload && payload.name) || '设备') + ' 已配对为可信设备');
        reloadTrust();
        reloadDevices();
        return;
      case 'devices.unpaired':
        flash('🔓 有设备已被取消信任');
        reloadTrust();
        return;
      case 'devices.blocked':
        flash('⛔ 有设备已被封禁');
        reloadTrust();
        reloadDevices();
        return;
      case 'devices.policy':
        if (payload) S.requirePairing = !!payload.requirePairing;
        reloadTrust();
        return;
      case 'notify.message':
        if (payload && payload.text) {
          toast((payload.from ? '@' + payload.from + '：' : '') + payload.text,
            payload.level === 'error' ? 'bad' : 'ok');
          flash('🔔 ' + payload.text);
        }
        return;
      case 'share.created':
        if (onModule('#/collab', 'sync')) scheduleRefresh();
        return;
      case 'share.revoked':
        return;

      default:
        break;
    }

    paintPill();
    scheduleRefresh();
  }

  function onFilesChanged(p) {
    if (!p) return;
    // 自己改的不刷新（本地已乐观更新）
    if (p.by && state.user && p.by === state.user.username) return;
    if (p.disk && state.disk && p.disk !== state.disk) {
      flash('📁 其他设备在「' + p.disk + '」有文件变动');
      return;
    }
    const dir = p.path || '';
    const cur = state.path || '';
    if (dir === cur || dir.startsWith(cur ? cur + '/' : '')) {
      flash('🔄 目录已由其他设备更新，正在刷新…');
      try { loadList(); } catch (e) { /* 忽略 */ }
    }
  }

  /* ------------------------------ 本地数据 ------------------------------ */

  function upsertTask(t, type) {
    if (!t || !t.id) return;
    const i = S.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) S.tasks[i] = t; else S.tasks.unshift(t);
    S.tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (S.tasks.length > 60) S.tasks.length = 60;
    if ((type === 'task.done' || type === 'task.error') && t.device && t.device !== S.deviceId) {
      flash((type === 'task.done' ? '✅ ' : '⚠️ ') + (t.name || '任务') +
        (type === 'task.done' ? ' 已完成' : ' 失败'));
    }
  }

  async function reloadDevices() {
    try {
      const r = await api('/api/devices');
      S.devices = {
        online: r.online || [], offline: r.offline || [],
        capabilities: r.capabilities || [], stats: r.stats || {},
      };
      paintPill();
      scheduleRefresh();
    } catch (e) { /* 网络抖动忽略 */ }
  }

  async function reloadTasks() {
    try {
      const r = await api('/api/tasks?limit=40');
      S.tasks = r.items || [];
      S.taskStats = r.stats || {};
      scheduleRefresh();
    } catch (e) { /* 忽略 */ }
  }

  async function reloadBoard(notify) {
    try {
      const r = await api('/api/board?limit=60');
      const before = S.board.length ? S.board[0].id : null;
      S.board = r.items || [];
      S.boardStats = r.stats || {};
      if (notify && S.board.length && S.board[0].id !== before) {
        const it = S.board[0];
        if (it.device !== S.deviceId) {
          flash('📋 ' + (it.deviceName || '其他设备') + ' 投递了一条' +
            (it.kind === 'link' ? '链接' : it.kind === 'path' ? '路径' : '内容'));
        }
      }
      scheduleRefresh();
    } catch (e) { /* 忽略 */ }
  }

  async function reloadStation() {
    try {
      const r = await api('/api/station');
      S.hub = r.hub || S.hub;
      S.monitor = r.monitor || null;
      S.devices = {
        online: (r.devices && r.devices.online) || [],
        offline: (r.devices && r.devices.offline) || [],
        capabilities: r.capabilities || [],
        stats: r.presenceStats || {},
      };
      S.tasks = (r.tasks && r.tasks.items) || [];
      S.taskStats = (r.tasks && r.tasks.stats) || {};
      S.board = (r.board && r.board.items) || [];
      S.boardStats = (r.board && r.board.stats) || {};
      S.disks = r.disks || [];
      if (r.remote) { S.remoteStats = r.remote.stats || {}; S.remoteLog = r.remote.recent || []; }
      if (r.sync) S.syncStats = r.sync;
      if (r.pairing) S.trust.requirePairing = !!r.pairing.requirePairing;
      if (typeof r.isAdmin === 'boolean') { S.isAdmin = r.isAdmin; S.aiIsAdmin = r.isAdmin; }
      paintPill();
      scheduleRefresh();
    } catch (e) {
      flash('⚠️ 无法读取工作站状态：' + (e.message || e));
    }
  }

  /* ------------------------------ v4.1 数据加载 ------------------------------ */

  async function reloadRemote() {
    try {
      const [a, t, l] = await Promise.all([
        api('/api/remote/actions'),
        api('/api/remote/targets?device=' + encodeURIComponent(S.deviceId)),
        api('/api/remote/log?limit=40'),
      ]);
      S.actions = (a && a.actions) || [];
      S.execEnabled = !!(a && a.execEnabled);
      S.targets = (t && t.targets) || [];
      S.remoteStats = (l && l.stats) || {};
      S.remoteLog = [].concat((l && l.inflight) || [], (l && l.history) || []);
      scheduleRefresh();
    } catch (e) { /* 忽略 */ }
  }

  async function reloadTrust() {
    try {
      const r = await api('/api/devices/trust');
      S.trust = {
        trusted: r.trusted || [],
        blocked: r.blocked || [],
        codes: r.codes || [],
        requirePairing: !!r.requirePairing,
      };
      scheduleRefresh();
    } catch (e) { /* 忽略 */ }
  }

  async function reloadSync() {
    try {
      const [st, list] = await Promise.all([
        api('/api/sync/state?device=' + encodeURIComponent(S.deviceId)),
        api('/api/sync/list'),
      ]);
      S.syncState = st && st.state;
      S.syncStats = (list && list.stats) || {};
      S.syncPeers = (list && list.items) || [];
      scheduleRefresh();
    } catch (e) { /* 忽略 */ }
  }

  async function reloadShares() {
    try {
      const r = await api('/api/share/list?limit=60');
      S.shares = r.items || [];
      S.shareStats = r.stats || {};
      scheduleRefresh();
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------ v4.1 远程指令执行器 ------------------------------ */
  /**
   * 本设备被远程下发指令时执行。
   * 设计原则：默认自动执行「低风险」动作；高风险动作（投屏/打开链接/下载）需要本机允许。
   * 用户可在「控制」页签关闭「接受远程控制」。
   */
  async function runRemoteCommand(cmd) {
    if (!cmd || !cmd.id) return;
    const a = cmd.action;

    // 用户已关闭接受远程控制
    if (!S.acceptRemote) {
      jsonPost('/api/remote/result', {
        id: cmd.id, device: S.deviceId, ok: false,
        error: '本设备已关闭「接受远程控制」',
      }).catch(() => {});
      flash('🚫 已拒绝一条远程指令（本机不接受远程控制）');
      return;
    }

    // 先确认收到，再执行
    jsonPost('/api/remote/ack', { id: cmd.id, device: S.deviceId }).catch(() => {});

    const who = (cmd.fromName || '其他设备') + (cmd.user ? ' @' + cmd.user : '');
    let ok = true;
    let error = '';
    let data = null;

    try {
      const args = cmd.args || {};
      switch (a) {
        case 'toast':
        case 'notify': {
          toast('📨 ' + who + '：' + (args.text || ''), args.level === 'error' ? 'bad' : 'ok');
          flash('📨 ' + (args.title ? args.title + '：' : '') + (args.text || ''));
          if (a === 'notify' && 'Notification' in window && Notification.permission === 'granted') {
            try { new Notification(args.title || '工作站消息', { body: args.text || '' }); } catch (e) { /* 忽略 */ }
          }
          data = { shown: true };
          break;
        }

        case 'clipboard_set': {
          const r = await copyText(args.text || '');
          data = { copied: r.ok, method: r.method };
          if (r.ok) toast('📋 已由 ' + who + ' 写入剪贴板', 'ok');
          else { ok = false; error = '剪贴板不可用，已放入协同板'; try { Workstation.share(args.text || ''); } catch (e) { /* 忽略 */ } }
          break;
        }

        case 'open_path': {
          // 跳转到工作站指定目录（同一浏览器内的导航，安全）
          if (typeof loadList === 'function') {
            try {
              if (args.disk && state.disk !== args.disk && typeof switchDisk === 'function') switchDisk(args.disk);
              state.path = args.path || '';
              await loadList();
              data = { navigated: true, path: args.path || '' };
            } catch (e) { ok = false; error = '跳转失败：' + (e.message || e); }
          } else { ok = false; error = '当前页面不支持目录跳转'; }
          break;
        }

        case 'download': {
          // 让本设备下载一个文件（推送文件到设备）
          const url = args.url || ('/api/download?disk=' + encodeURIComponent(args.disk || 'public') +
            '&path=' + encodeURIComponent(args.path || ''));
          const name = args.name || (args.path || '').split('/').pop() || 'download';
          triggerDownload(url, name);
          data = { started: true, name };
          break;
        }

        case 'open_url': {
          const w = window.open(args.url, '_blank', 'noopener');
          if (!w) { ok = false; error = '浏览器拦截了弹窗，请允许弹出窗口'; }
          else data = { opened: args.url };
          break;
        }

        case 'play_media':
        case 'cast': {
          // 大屏/播放设备：走全屏播放覆盖层
          const u = args.url || ('/api/download?disk=' + encodeURIComponent(args.disk || 'public') +
            '&path=' + encodeURIComponent(args.path || ''));
          const played = playOverlay(u, args.title || '', a === 'cast');
          if (!played) { ok = false; error = '无法播放该媒体'; }
          else data = { playing: true, url: u };
          break;
        }

        case 'exec': {
          // 浏览器沙箱内无法直接执行 shell；只有声明 exec 能力的原生端可执行
          ok = false;
          error = 'Web 端不支持 exec，请使用原生客户端执行';
          break;
        }

        default:
          ok = false;
          error = '未知动作：' + a;
      }
    } catch (e) {
      ok = false;
      error = (e && e.message) || String(e);
    }

    jsonPost('/api/remote/result', {
      id: cmd.id, device: S.deviceId, ok, error, data,
    }).catch(() => {});
  }

  /** 下发一条远程指令 */
  async function sendRemote(target, action, args, label) {
    const t = S.targets.find((x) => x.id === target);
    if (!t) return toast('目标设备不在线', 'bad');
    if (!t.trusted && S.requirePairing) return toast('目标设备未配对，严格模式下不可控', 'bad');
    if (t.blocked) return toast('目标设备已被封禁', 'bad');
    if (action === 'open_url' || action === 'play_media' || action === 'cast') {
      // 允许"用当前目录下选中的文件"这种站内路径，不做 URL 校验拦截
    }
    try {
      const r = await jsonPost('/api/remote/send', {
        target, action, args,
        from: S.deviceId, fromName: S.deviceName,
      });
      toast('📡 已下发「' + (label || action) + '」到 ' + (t.name || target), 'ok');
      reloadRemote();
      return r;
    } catch (e) {
      toast('下发失败：' + (e.message || e), 'bad');
      return null;
    }
  }

  /** 剪贴板兼容写入：优先 Clipboard API，HTTP 下降级 execCommand */
  async function copyText(text) {
    const s = String(text == null ? '' : text);
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(s); return { ok: true, method: 'api' }; }
      catch (e) { /* 落到降级 */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return { ok: !!ok, method: 'execCommand' };
    } catch (e) {
      return { ok: false, method: 'none' };
    }
  }

  /** 触发一次浏览器下载（不导航离开当前页） */
  function triggerDownload(url, name) {
    try {
      const a = document.createElement('a');
      a.href = url;
      if (name) a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { document.body.removeChild(a); } catch (e) { /* 忽略 */ } }, 1000);
      return true;
    } catch (e) { return false; }
  }

  /** 全屏播放覆盖层（投屏/播放媒体用） */
  function playOverlay(url, title, full) {
    try {
      const old = document.getElementById('wsPlayer');
      if (old) old.remove();
      const box = el('div', 'ws-player');
      box.id = 'wsPlayer';
      const bar = el('div', 'bar');
      bar.appendChild(el('span', 'ttl', title || '远程播放'));
      const x = el('button', 'x', '关闭');
      x.onclick = () => box.remove();
      bar.appendChild(x);
      box.appendChild(bar);

      const lower = url.split('?')[0].toLowerCase();
      const isVideo = /\.(mp4|webm|mkv|mov|m4v|ogv)$/.test(lower);
      const isAudio = /\.(mp3|wav|flac|aac|m4a|ogg|opus)$/.test(lower);
      let media;
      if (isAudio) { media = el('audio'); media.controls = true; media.autoplay = true; }
      else { media = el('video'); media.controls = true; media.autoplay = true; media.playsInline = true; }
      media.src = url;
      if (full || isVideo) media.classList.add('big');
      media.onerror = () => {
        const tip = box.querySelector('.err');
        if (tip) tip.textContent = '无法播放（浏览器不支持该格式或源不可达）';
      };
      box.appendChild(media);
      box.appendChild(el('div', 'err'));
      document.body.appendChild(box);
      try { media.play && media.play().catch(() => { /* 自动播放被拦 */ }); } catch (e) { /* 忽略 */ }
      return true;
    } catch (e) { return false; }
  }

  /** 用配对码把自己接入信任列表 */
  async function claimPairing(code) {
    try {
      const r = await jsonPost('/api/devices/pair/claim', {
        code: String(code || '').trim(),
        id: S.deviceId, name: S.deviceName,
        type: S.selfType, platform: (S.detect && S.detect.platform) || '',
      });
      if (r && r.token) {
        S.token = r.token;
        S.trusted = true;
        localStorage.setItem(LS_TOKEN, r.token);
        toast('✅ 配对成功，本机已成为可信设备', 'ok');
        await registerSelf(false);
        reloadTrust();
        reloadRemote();
        return true;
      }
      return false;
    } catch (e) {
      toast('配对失败：' + (e.message || e), 'bad');
      return false;
    }
  }

  /* ------------------------------ 顶栏药丸（v5 外壳） ------------------------------ */

  function paintPill() {
    /* v5：药丸渲染进外壳顶栏 .tn-side 的 #tnPill，点击跳协同模块 */
    const box = document.getElementById('tnPill');
    if (box && window.Shell) {
      const online = (S.devices.online || []).length;
      const running = S.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
      Shell.paintPill(S.connected ? online : null, running || null);
      const pill = box.querySelector('.tn-pill');
      if (pill) {
        pill.title = online + ' 台设备在线' + (running ? '，' + running + ' 个任务进行中' : '');
        pill.onclick = () => Shell.go('#/collab');
      }
    }
  }

  function flash(text) {
    let box = document.getElementById('wsFlash');
    if (!box) {
      box = el('div', 'ws-flash');
      box.id = 'wsFlash';
      document.body.appendChild(box);
    }
    box.innerHTML = '<span class="ic">◆</span><span>' + esc(text) + '</span>';
    box.classList.add('on');
    if (S._flashTimer) clearTimeout(S._flashTimer);
    S._flashTimer = setTimeout(() => box.classList.remove('on'), 3200);
  }

  function pushLedger(channel, type, payload) {
    S.ledger.unshift({ channel, type, payload, ts: Date.now() });
    if (S.ledger.length > LEDGER_MAX) S.ledger.length = LEDGER_MAX;
    if (onModule('#/events')) scheduleRefresh();
  }

  /* ------------------------------ 面板渲染（v5：模块感知） ------------------------------ */

  function scheduleRefresh() {
    /* v5：当前模块未变化时按需刷新对应宿主 */
    if (!window.Shell) return;
    if (S._refreshQueued) return;
    S._refreshQueued = true;
    requestAnimationFrame(() => {
      S._refreshQueued = false;
      onRouteEnter(Shell.route());
    });
  }

  /** 旧 render() 保留为兼容壳：S.open 场景（外部直接调用）时渲染进当前模块 */
  function render() {
    if (window.Shell) { onRouteEnter(Shell.route()); return; }
  }

  /* ------------------------------ 模块宿主渲染（v5 外壳） ------------------------------

     旧架构：openStation() 弹 side-panel 悬浮层，8 个标签挤在里面。
     新架构：工作站拆成一级模块，由 shell.js 的 hash 路由驱动：
       #/        → 总览   （renderOverview → #homeDash）
       #/ai      → AI     （renderAI       → #aiHost）
       #/collab  → 协同   （二级 tab：设备/任务/控制/同步/协同板 → #collabHost）
       #/events  → 事件流 （renderEvents   → #eventsHost）
     每个模块有独立 URL，刷新不丢。 */

  const COLLAB_TABS = [
    ['dev', '设备', () => (S.devices.online || []).length],
    ['task', '任务', () => S.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length],
    ['ctl', '控制', () => (S.remoteLog || []).filter((c) => c.status === 'pending' || c.status === 'delivered' || c.status === 'acked').length],
    ['sync', '同步', () => 0],
    ['board', '协同板', () => (S.board || []).length],
  ];

  /** 渲染「协同」模块：二级 tab + 内容 */
  function renderCollab(host) {
    host.innerHTML = '';
    const tabs = el('div', 'ws-tabs');
    for (const [key, label, nfn] of COLLAB_TABS) {
      const n = nfn();
      const b = el('button', 'ws-tab' + (S.tab === key ? ' on' : ''), label);
      if (n > 0) b.appendChild(el('span', 'n', String(n)));
      b.onclick = () => {
        S.tab = key;
        if (key === 'ctl') reloadRemote();
        if (key === 'sync') { reloadSync(); reloadShares(); }
        renderCollab(host);
      };
      tabs.appendChild(b);
    }
    host.appendChild(tabs);

    const wrap = el('div', 'ws-wrap');
    host.appendChild(wrap);
    if (S.tab === 'dev') renderDevices(wrap);
    else if (S.tab === 'task') renderTasks(wrap);
    else if (S.tab === 'ctl') renderControl(wrap);
    else if (S.tab === 'sync') renderSync(wrap);
    else renderBoard(wrap);
  }

  /** shell.js 路由回调：进某模块时渲染对应内容 */
  function onRouteEnter(hash) {
    if (!window.Workstation) return;
    if (hash === '#/') renderHome();
    else if (hash === '#/ai') {
      /* AI 视图自带状态与流式渲染，无需被 SSE 事件牵动重建。
         此前每次 devices.online/offline 都会走到这里 → AIView.mount → 全量重画，
         实测 10 次/秒，正在输入的 textarea 被反复销毁（输入丢失）。
         仅在视图尚未挂载时才初始化；已挂载交给它自己维护。 */
      const host = document.getElementById('aiHost');
      if (!host) return;
      if (window.AIView && AIView.isMounted && AIView.isMounted()) return;
      host.innerHTML = '';
      renderAI(host);
      reloadAI();
    } else if (hash === '#/collab') {
      const host = document.getElementById('collabHost');
      if (host) renderCollab(host);
    } else if (hash === '#/events') {
      const host = document.getElementById('eventsHost');
      if (host) { host.innerHTML = ''; renderEvents(host); }
    }
  }

  /** 总览首页：实时链路 + 节点负载 + 快捷入口（复用 renderOverview 内容） */
  function renderHome() {
    const host = document.getElementById('homeDash');
    if (!host) return;
    host.innerHTML = '';
    renderOverview(host);

    /* 总览追加：AI 快捷提问（P1 —— 打开就能问，不用先找模块） */
    const cAsk = card(host, '问 AI', '回车即问，自动跳到对话');
    const askRow = el('div', 'ws-row');
    const askIn = el('input', 'ai-in');
    askIn.id = 'homeAsk';
    askIn.placeholder = '有什么想问的？例如：帮我看看磁盘健康吗';
    const askBtn = el('button', 'ws-btn primary', '提问');
    const doAsk = () => {
      const v = (askIn.value || '').trim();
      if (!v) return;
      askIn.value = '';
      if (window.AIView) AIView.ask(v);
      else if (window.Shell) { Shell.go('#/ai'); toast('已跳转 AI 助手', ''); }
    };
    askIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doAsk(); } };
    askBtn.onclick = doAsk;
    askRow.appendChild(askIn);
    askRow.appendChild(askBtn);
    cAsk.appendChild(askRow);
    const askNote = el('div', 'ws-note', '模型跑在你指定的机器上，本服务只做转发，内容不出局域网。');
    cAsk.appendChild(askNote);

    /* 总览追加：模块快捷入口 */
    const c4 = card(host, '快捷入口', '常用模块');
    const row = el('div', 'ws-row');
    for (const [label, hash] of [
      ['📁 文件', '#/files'], ['🤖 AI 助手', '#/ai'],
      ['🛰 协同', '#/collab'], ['📜 事件流', '#/events'],
    ]) {
      const b = el('button', 'ws-btn', label);
      b.onclick = () => Shell.go(hash);
      row.appendChild(b);
    }
    c4.appendChild(row);
  }

  function openStation(tab) {
    /* v5 兼容层：旧调用（app.js 的 Workstation.open('over') 等）转路由跳转 */
    const map = {
      over: '#/', dev: '#/collab', task: '#/collab', ctl: '#/collab',
      sync: '#/collab', board: '#/collab', ai: '#/ai', events: '#/events',
    };
    if (tab === 'dev') S.tab = 'dev';
    else if (tab === 'task') S.tab = 'task';
    else if (tab === 'ctl') S.tab = 'ctl';
    else if (tab === 'sync') S.tab = 'sync';
    else if (tab === 'board') S.tab = 'board';
    if (window.Shell) Shell.go(map[tab] || '#/');
  }

  /* ---- 旧 render() 的 8 标签分发已拆解：
       over → renderHome()；dev/task/ctl/sync/board → renderCollab()；
       ai → #/ai 模块；events → #/events 模块。骨架保留于上方的模块宿主渲染段。 ---- */

  /* ---- 总览 ---- */
  function renderOverview(w) {
    const m = S.monitor || {};
    const online = (S.devices.online || []).length;
    const st = S.taskStats || {};

    // 连接卡
    const c1 = card(w, '实时链路', S.connected ? 'SSE 已连接' : '重连中…');
    const met = el('div', 'ws-metrics');
    met.appendChild(metric(online, '在线设备', 'acc'));
    met.appendChild(metric(st.active != null ? st.active : 0, '进行中任务', st.active ? 'warn' : ''));
    met.appendChild(metric((S.board || []).length, '协同板条目', ''));
    met.appendChild(metric(S.hub && S.hub.clients != null ? S.hub.clients : '—', '实时连接数', ''));
    c1.appendChild(met);

    const info = el('div', 'ws-note');
    info.innerHTML =
      '设备号 <b>' + esc(S.deviceId.slice(0, 8)) + '</b> · 名称 <b>' + esc(S.deviceName) + '</b><br>' +
      '在线能力：' + ((S.devices.capabilities || []).map((c) => capLabel(c)).join(' / ') || '—');
    c1.appendChild(info);

    // 设备负载卡（Termux 环境下有值）
    if (m && (m.cpuPct != null || m.memUsedPct != null)) {
      const c2 = card(w, '节点负载', '核心节点实时资源');
      const g = el('div', 'ws-metrics');
      g.appendChild(metric(m.cpuPct != null ? m.cpuPct + '%' : '—', 'CPU', pctCls(m.cpuPct, 80, 92)));
      g.appendChild(metric(m.memUsedPct != null ? m.memUsedPct + '%' : '—', '内存', pctCls(m.memUsedPct, 80, 92)));
      if (m.battery && m.battery.capacity != null) {
        g.appendChild(metric(m.battery.capacity + '%', '电量', m.battery.capacity < 20 ? 'bad' : ''));
      }
      if (m.uptimeS != null) g.appendChild(metric(fmtTime(m.uptimeS * 1000), '运行时长', ''));
      c2.appendChild(g);
      const net = el('div', 'ws-note');
      net.innerHTML = '下行 <b>' + (m.netRxBps != null ? fmtSize(m.netRxBps) + '/s' : '—') +
        '</b> · 上行 <b>' + (m.netTxBps != null ? fmtSize(m.netTxBps) + '/s' : '—') + '</b>';
      c2.appendChild(net);
    }

    // 最近事件
    const c3 = card(w, '最近事件', '全部频道');
    const list = el('div', 'ws-log');
    for (const e of S.ledger.slice(0, 8)) list.appendChild(logLine(e));
    if (!S.ledger.length) list.appendChild(el('div', 'ws-empty', '暂无事件'));
    c3.appendChild(list);

    const row = el('div', 'ws-row');
    const b1 = el('button', 'ws-btn', '刷新状态');
    b1.onclick = () => reloadStation();
    const b2 = el('button', 'ws-btn', '重连实时流');
    b2.onclick = () => { connect(); flash('🔌 正在重连实时流…'); };
    row.appendChild(b1); row.appendChild(b2);
    c3.appendChild(row);
  }

  /* ---- 设备 ---- */
  function renderDevices(w) {
    const c = card(w, '在线设备', (S.devices.online || []).length + ' 台');
    if (!(S.devices.online || []).length) {
      c.appendChild(el('div', 'ws-empty', '暂无其他设备在线'));
    }
    for (const d of S.devices.online || []) c.appendChild(devRow(d, true));

    const off = S.devices.offline || [];
    if (off.length) {
      const c2 = card(w, '最近离线', off.length + ' 台');
      for (const d of off.slice(0, 12)) c2.appendChild(devRow(d, false));
    }

    const c3 = card(w, '本机身份', S.autoName ? '自动命名' : '已自定义');
    const row = el('div', 'ws-row');
    const inp = el('input');
    inp.value = S.deviceName;
    inp.placeholder = '给这台设备起个名字';
    const save = el('button', 'ws-btn primary', '保存');
    save.onclick = async () => {
      const v = inp.value.trim();
      if (!v) return;
      localStorage.setItem(LS_NAME, v);
      S.deviceName = v;
      S.autoName = false;
      await registerSelf(false);
      toast('设备名已更新', 'ok');
      reloadDevices();
      render();
    };
    row.appendChild(inp); row.appendChild(save);
    if (!S.autoName) {
      const reset = el('button', 'ws-btn', '恢复默认');
      reset.onclick = async () => {
        localStorage.removeItem(LS_NAME);
        S.autoName = true;
        S.deviceName = defaultName(S.detect || detectSelf());
        await registerSelf(false);
        toast('已恢复默认名：' + S.deviceName, 'ok');
        reloadDevices();
        render();
      };
      row.appendChild(reset);
    }
    c3.appendChild(row);
    const note = el('div', 'ws-note');
    note.innerHTML = '自检类型 <b>' + esc(TYPE_ICON[S.selfType] + ' ' + S.selfType) + '</b> · 平台 <b>' +
      esc((S.detect && S.detect.platform) || 'unknown') + '</b><br>' +
      '能力声明：' + ((S.detect && S.detect.caps) || []).map((x) => capLabel(x)).join(' / ') +
      (S.autoName
        ? '<br>当前为<b>自动命名</b>：由「平台 + 本机短码 ' + esc(shortCode(S.deviceId)) +
          '」拼成，短码与本浏览器绑定且不变，所以多台机器不会重名。想改名字直接在上面填。'
        : '<br>名字由你自定义，已存本机；换浏览器打开会重新自动命名。');
    c3.appendChild(note);
  }

  function devRow(d, online) {
    const row = el('div', 'ws-dev' + (online ? '' : ' off'));
    row.appendChild(el('div', 'ic', TYPE_ICON[d.type] || '❓'));

    const mid = el('div', 'mid');
    const nm = el('div', 'nm');
    nm.appendChild(el('span', '', d.name || '未命名'));
    if (d.id === S.deviceId) nm.appendChild(el('span', 'self', '本机'));
    mid.appendChild(nm);

    const meta = el('div', 'mt');
    meta.textContent = [d.platform, d.ip, d.user ? '@' + d.user : '', online ? '活跃 ' + ago(d.lastSeen) : ago(d.lastSeen) + '前']
      .filter(Boolean).join(' · ');
    mid.appendChild(meta);

    if ((d.capabilities || []).length) {
      const caps = el('div', 'caps');
      for (const cp of d.capabilities.slice(0, 6)) caps.appendChild(el('span', 'cap', capLabel(cp)));
      mid.appendChild(caps);
    }
    row.appendChild(mid);

    if (d.id !== S.deviceId) {
      const ops = el('div', 'ops');
      const rb = el('button', '', '✎');
      rb.title = '重命名';
      rb.onclick = () => {
        const n = prompt('设备名称', d.name);
        if (n == null) return;
        jsonPost('/api/devices/rename', { id: d.id, name: n })
          .then(() => { toast('已重命名', 'ok'); reloadDevices(); })
          .catch((e) => toast(e.message || '重命名失败', 'bad'));
      };
      const db = el('button', '', '🗑');
      db.title = '移除此设备记录';
      db.onclick = () => {
        if (!confirm('移除设备「' + d.name + '」的记录？')) return;
        jsonPost('/api/devices/remove', { id: d.id })
          .then(() => { toast('已移除', 'ok'); reloadDevices(); })
          .catch((e) => toast(e.message || '移除失败', 'bad'));
      };
      ops.appendChild(rb); ops.appendChild(db);
      row.appendChild(ops);
    }
    return row;
  }

  /* ---- 任务 ---- */
  function renderTasks(w) {
    const st = S.taskStats || {};
    const c0 = card(w, '任务总览', '全设备共享');
    const g = el('div', 'ws-metrics');
    g.appendChild(metric(st.active != null ? st.active : 0, '进行中', st.active ? 'acc' : ''));
    g.appendChild(metric(st.done || 0, '已完成', 'ok'));
    g.appendChild(metric(st.error || 0, '失败', st.error ? 'bad' : ''));
    g.appendChild(metric(st.total || 0, '累计', ''));
    c0.appendChild(g);

    const row = el('div', 'ws-row');
    const b1 = el('button', 'ws-btn', '刷新');
    b1.onclick = () => reloadTasks();
    const b2 = el('button', 'ws-btn danger', '清空已结束');
    b2.onclick = () => {
      jsonPost('/api/tasks/clear', {})
        .then((r) => { toast('已清空 ' + (r.removed || 0) + ' 条', 'ok'); reloadTasks(); })
        .catch((e) => toast(e.message || '清空失败', 'bad'));
    };
    row.appendChild(b1); row.appendChild(b2);
    c0.appendChild(row);

    /* v4.1：长任务托管 —— 服务端异步执行，关掉浏览器也会继续跑 */
    const cj = card(w, '长任务 · 服务端后台执行', '支持跨设备观察进度');
    const JOBS = [
      ['scrub-build', '构建校验清单'],
      ['scrub-verify', '校验文件完整性'],
      ['index-build', '重建全文索引'],
      ['dedup-scan', '扫描重复文件'],
      ['zip-build', '打包为 ZIP（落盘到 _exports/）'],
      ['hash-scan', '生成 SHA256 清单（落盘到 _manifests/）'],
    ];
    const jSel = el('select', 'ws-sel');
    for (const [v, label] of JOBS) {
      const o = el('option', '', label); o.value = v; jSel.appendChild(o);
    }
    cj.appendChild(jSel);
    const jPath = el('input');
    jPath.placeholder = '路径（留空 = 整盘；zip-build 可填要打包的目录或文件）';
    const jBox = el('div', 'ws-args');
    jBox.appendChild(jPath);
    const jBtn = el('button', 'ws-btn primary', '提交任务');
    jBtn.onclick = async () => {
      jBtn.disabled = true;
      try {
        const op = jSel.value;
        const body = { op, disk: state.disk || 'public', path: jPath.value.trim() };
        if (op === 'zip-build') {
          const sel = (state.sel && state.sel.size) ? [...state.sel] : null;
          if (sel && sel.length) body.paths = sel;
        }
        const r = await jsonPost('/api/tasks/run', body);
        toast('已提交：' + ((r.task && r.task.name) || op), 'ok');
        if (r.task) S.tasks.unshift(r.task);
        render();
      } catch (e) {
        toast(e.message || '提交失败', 'bad');
        jBtn.disabled = false;
      }
    };
    jBox.appendChild(jBtn);
    cj.appendChild(jBox);
    cj.appendChild(el('div', 'ws-note',
      'zip-build 把结果 zip 落到当前盘根的 _exports/ 下，hash-scan 把 sha256 清单落到 _manifests/ 下；' +
      '两者都是普通文件，可以直接在「同步」页签为它生成限时分享链接发给别的设备。' +
      'hash-scan 输出的整树指纹可与另一台设备的清单一次比对，确认内容是否一致。'));

    const c = card(w, '任务列表', S.tasks.length + ' 条');
    if (!S.tasks.length) c.appendChild(el('div', 'ws-empty', '暂无任务。上传/下载/打包时会自动登记到这里，其他设备也能看到。'));
    for (const t of S.tasks) c.appendChild(taskRow(t));
  }

  function taskRow(t) {
    const box = el('div', 'ws-task st-' + t.status);
    const top = el('div', 'top');
    top.appendChild(el('span', 'badge ' + t.status, statusLabel(t.status)));
    top.appendChild(el('span', 'ttl', t.name || '未命名'));
    const pct = el('span', 'pct' + (t.status === 'error' ? ' bad' : ''), t.status === 'error' ? '失败' : (Math.round(t.progress || 0) + '%'));
    top.appendChild(pct);
    box.appendChild(top);

    const bar = el('div', 'bar');
    const fill = el('div', 'fill');
    fill.style.width = Math.max(0, Math.min(100, t.progress || 0)) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);

    const foot = el('div', 'foot');
    const bits = [];
    if (t.total > 0) bits.push(fmtSize(t.done || 0) + ' / ' + fmtSize(t.total));
    else if (t.done > 0) bits.push(fmtSize(t.done));
    if (t.speed > 0) bits.push(fmtSize(t.speed) + '/s');
    if (t.device && t.device !== S.deviceId) bits.push('来自其他设备');
    if (t.user) bits.push('@' + t.user);
    bits.push(ago(t.endedAt || t.createdAt));
    if (t.error) bits.push(t.error);
    foot.appendChild(el('span', '', bits.join(' · ')));

    if (t.status === 'running' || t.status === 'queued') {
      const x = el('button', 'x', '取消');
      x.onclick = () => {
        jsonPost('/api/tasks/cancel', { id: t.id })
          .then(() => { toast('已请求取消', 'ok'); reloadTasks(); })
          .catch((e) => toast(e.message || '取消失败', 'bad'));
      };
      foot.appendChild(x);
    } else {
      const x = el('button', 'x', '移除');
      x.onclick = () => {
        jsonPost('/api/tasks/remove', { id: t.id })
          .then(() => reloadTasks())
          .catch((e) => toast(e.message || '移除失败', 'bad'));
      };
      foot.appendChild(x);
    }
    box.appendChild(foot);
    return box;
  }

  /* ---- 控制（远程指令） ---- */
  function renderControl(w) {
    /* 1) 本机作为被控端的状态 */
    const c0 = card(w, '本机状态', '作为被控端的身份与开关');
    const g = el('div', 'ws-metrics');
    g.appendChild(metric(S.trusted ? '已配对' : '未配对', '信任身份', S.trusted ? 'ok' : 'warn'));
    g.appendChild(metric(S.acceptRemote ? '接受' : '拒绝', '远程控制', S.acceptRemote ? 'ok' : 'bad'));
    g.appendChild(metric((S.remoteStats && S.remoteStats.inflight) || 0, '在途指令', ''));
    g.appendChild(metric((S.remoteStats && S.remoteStats.done) || 0, '本机已执行', ''));
    c0.appendChild(g);

    const row = el('div', 'ws-row');
    const btn = el('button', 'ws-btn ' + (S.acceptRemote ? 'danger' : 'primary'),
      S.acceptRemote ? '关闭「接受远程控制」' : '开启「接受远程控制」');
    btn.onclick = () => {
      S.acceptRemote = !S.acceptRemote;
      localStorage.setItem(LS_ACCEPT, S.acceptRemote ? '1' : '0');
      toast(S.acceptRemote ? '本机将接受远程指令' : '本机已拒绝远程指令', 'ok');
      render();
    };
    row.appendChild(btn);

    const nb = el('button', 'ws-btn', '申请桌面通知');
    nb.onclick = () => {
      if (!('Notification' in window)) return toast('该浏览器不支持桌面通知', 'bad');
      Notification.requestPermission().then((p) => toast('通知权限：' + p, p === 'granted' ? 'ok' : 'bad'));
    };
    row.appendChild(nb);
    c0.appendChild(row);

    // 配对入口
    if (!S.trusted) {
      const pr = el('div', 'ws-row');
      const ci = el('input');
      ci.placeholder = '输入管理员给的 6 位配对码';
      ci.maxLength = 6;
      ci.inputMode = 'numeric';
      const pb = el('button', 'ws-btn primary', '立即配对');
      pb.onclick = async () => { if (await claimPairing(ci.value)) { ci.value = ''; render(); } };
      pr.appendChild(ci); pr.appendChild(pb);
      c0.appendChild(pr);
      c0.appendChild(el('div', 'ws-note',
        '未配对设备在「严格模式」下不会被远程控制，也拉不到指令。管理员可在下方「信任管理」生成配对码。'));
    } else {
      const note = el('div', 'ws-note');
      note.innerHTML = '本机已配对 · 令牌 <b>' + esc((S.token || '').slice(0, 8)) + '…</b>';
      c0.appendChild(note);
    }

    /* 2) 下发控制台 */
    const c1 = card(w, '下发控制', '选择目标设备与动作');
    if (!(S.targets || []).length) {
      c1.appendChild(el('div', 'ws-empty', '暂无其他在线设备。让另一台设备打开本工作站即可出现。'));
    } else {
      const tSel = el('select', 'ws-sel');
      for (const t of S.targets) {
        const o = el('option', '', TYPE_ICON[t.type] + ' ' + t.name + (t.trusted ? ' ✓' : ''));
        o.value = t.id;
        if (t.blocked) o.disabled = true;
        tSel.appendChild(o);
      }
      c1.appendChild(tSel);

      const aSel = el('select', 'ws-sel');
      const fillActions = () => {
        aSel.innerHTML = '';
        const t = S.targets.find((x) => x.id === tSel.value) || S.targets[0];
        for (const a of (t ? t.supported : [])) {
          const def = (S.actions || []).find((x) => x.action === a);
          const o = el('option', '', (def && def.label) || a);
          o.value = a;
          aSel.appendChild(o);
        }
        paintArgs();
      };
      c1.appendChild(aSel);

      const argBox = el('div', 'ws-args');
      c1.appendChild(argBox);

      let argInput = null;
      const paintArgs = () => {
        argBox.innerHTML = '';
        argInput = null;
        const a = aSel.value;
        const def = (S.actions || []).find((x) => x.action === a) || {};
        const hint = el('div', 'ws-note', def.desc || '');
        if (a === 'toast' || a === 'notify') {
          const i = el('input'); i.placeholder = '要显示的文本';
          argInput = i; argBox.appendChild(i);
        } else if (a === 'clipboard_set') {
          const i = el('input'); i.placeholder = '要写入对方剪贴板的文本';
          argInput = i; argBox.appendChild(i);
        } else if (a === 'open_url' || a === 'play_media' || a === 'cast') {
          const i = el('input'); i.placeholder = 'http(s) 链接，或站内相对路径 /api/download?disk=public&path=…';
          argInput = i; argBox.appendChild(i);
          const pick = el('button', 'ws-btn', '用当前目录中选中的文件');
          pick.onclick = () => {
            const sel = (state.sel && state.sel.size) ? [...state.sel][0] : null;
            if (!sel) return toast('请先在文件列表里选中一个文件', 'bad');
            i.value = '/api/download?disk=' + encodeURIComponent(state.disk || 'public') +
              '&path=' + encodeURIComponent(sel);
          };
          argBox.appendChild(pick);
        } else if (a === 'open_path' || a === 'download') {
          const i = el('input'); i.placeholder = '目标路径，例如 docs/报告.pdf';
          argInput = i; argBox.appendChild(i);
        } else if (a === 'exec') {
          const i = el('input'); i.placeholder = '命令（受服务端白名单限制）';
          argInput = i; argBox.appendChild(i);
        }
        argBox.appendChild(hint);
      };

      tSel.onchange = fillActions;
      aSel.onchange = paintArgs;
      fillActions();

      const sendRow = el('div', 'ws-row');
      const sb = el('button', 'ws-btn primary', '📡 下发指令');
      sb.onclick = () => {
        const a = aSel.value;
        const v = argInput ? argInput.value.trim() : '';
        const t = S.targets.find((x) => x.id === tSel.value);
        const def = (S.actions || []).find((x) => x.action === a) || {};
        if (['toast', 'notify', 'clipboard_set', 'open_url', 'play_media', 'cast'].includes(a) && !v) {
          return toast('请填写内容', 'bad');
        }
        let args = {};
        if (a === 'toast' || a === 'notify') args = { text: v };
        else if (a === 'clipboard_set') args = { text: v };
        else if (a === 'open_url' || a === 'play_media' || a === 'cast') args = { url: v, title: v.split('/').pop() };
        else if (a === 'open_path') args = { disk: state.disk || 'public', path: v };
        else if (a === 'download') args = { disk: state.disk || 'public', path: v, name: v.split('/').pop() };
        else if (a === 'exec') args = { cmd: v };
        sendRemote(tSel.value, a, args, def.label);
      };
      sendRow.appendChild(sb);

      const qb = el('button', 'ws-btn', '快速提示');
      qb.onclick = () => {
        const t = tSel.value;
        sendRemote(t, 'toast', { text: '来自 ' + S.deviceName + ' 的问候 👋' }, '显示提示');
      };
      sendRow.appendChild(qb);
      c1.appendChild(sendRow);
    }

    /* 3) 指令记录 */
    const c2 = card(w, '指令记录', (S.remoteLog || []).length + ' 条');
    const r2 = el('div', 'ws-row');
    const rb = el('button', 'ws-btn', '刷新');
    rb.onclick = () => reloadRemote();
    r2.appendChild(rb);
    if (S.execEnabled) r2.appendChild(el('span', 'ws-note', 'exec 已由服务端开启'));
    c2.appendChild(r2);
    if (!(S.remoteLog || []).length) c2.appendChild(el('div', 'ws-empty', '还没有下发过指令'));
    for (const c of (S.remoteLog || []).slice(0, 20)) c2.appendChild(remoteRow(c));

    /* 4) 信任管理 */
    renderTrust(w);
  }

  function remoteRow(c) {
    const box = el('div', 'ws-item rm-' + c.status);
    const l1 = el('div', 'txt');
    l1.innerHTML = '<b>' + esc(c.actionLabel || c.action) + '</b> → ' + esc(c.targetName || c.target) +
      (c.fromName ? ' <span class="dim">（来自 ' + esc(c.fromName) + '）</span>' : '');
    box.appendChild(l1);

    const meta = el('div', 'meta');
    meta.appendChild(el('span', 'k st-' + c.status, statusLabel(c.status)));
    if (c.args && c.args.text) meta.appendChild(el('span', '', String(c.args.text).slice(0, 40)));
    if (c.args && c.args.url) meta.appendChild(el('span', 'mono', String(c.args.url).slice(0, 40)));
    if (c.args && c.args.path) meta.appendChild(el('span', 'mono', String(c.args.path).slice(0, 40)));
    meta.appendChild(el('span', '', ago(c.createdAt)));
    if (c.error) meta.appendChild(el('span', 'bad', c.error.slice(0, 50)));
    if (c.durationMs != null && c.status === 'done') meta.appendChild(el('span', '', c.durationMs + 'ms'));

    if (c.status === 'pending' || c.status === 'delivered' || c.status === 'acked') {
      const ops = el('div', 'ops');
      const x = el('button', 'del', '取消');
      x.onclick = () => jsonPost('/api/remote/cancel', { id: c.id })
        .then(() => { toast('已取消', 'ok'); reloadRemote(); })
        .catch((e) => toast(e.message || '取消失败', 'bad'));
      ops.appendChild(x);
      meta.appendChild(ops);
    }
    box.appendChild(meta);
    return box;
  }

  function renderTrust(w) {
    const c = card(w, '信任管理', S.isAdmin ? '管理员' : '只读');
    const g = el('div', 'ws-metrics');
    g.appendChild(metric((S.trust.trusted || []).length, '已信任', 'ok'));
    g.appendChild(metric((S.trust.blocked || []).length, '已封禁', S.trust.blocked.length ? 'bad' : ''));
    g.appendChild(metric((S.trust.codes || []).length, '有效配对码', ''));
    g.appendChild(metric(S.trust.requirePairing ? '严格' : '宽松', '策略', S.trust.requirePairing ? 'warn' : ''));
    c.appendChild(g);

    if (S.isAdmin) {
      const r1 = el('div', 'ws-row');
      const cb = el('button', 'ws-btn primary', '生成配对码');
      cb.onclick = async () => {
        try {
          const r = await jsonPost('/api/devices/pair/new', { ttlMs: 600000, label: S.deviceName });
          toast('配对码：' + r.code + '（10 分钟内有效，一次性）', 'ok');
          const box = document.getElementById('wsCode');
          if (box) box.innerHTML = '配对码 <b class="big">' + esc(r.code) + '</b> · 剩 ' +
            Math.round((r.expiresAt - Date.now()) / 1000) + ' 秒';
          reloadTrust();
        } catch (e) { toast(e.message || '生成失败', 'bad'); }
      };
      const tb = el('button', 'ws-btn', S.trust.requirePairing ? '关闭严格模式' : '开启严格模式');
      tb.onclick = () => jsonPost('/api/devices/policy', { requirePairing: !S.trust.requirePairing })
        .then((r) => { S.trust.requirePairing = r.requirePairing; toast('策略已更新', 'ok'); reloadTrust(); render(); })
        .catch((e) => toast(e.message || '失败', 'bad'));
      r1.appendChild(cb); r1.appendChild(tb);
      c.appendChild(r1);

      const codeBox = el('div', 'ws-note');
      codeBox.id = 'wsCode';
      codeBox.textContent = '点「生成配对码」后把 6 位数字告诉新设备';
      c.appendChild(codeBox);
    }

    if (!(S.trust.trusted || []).length) {
      c.appendChild(el('div', 'ws-empty', '还没有已配对的设备'));
    }
    for (const d of (S.trust.trusted || []).slice(0, 10)) {
      const row = el('div', 'ws-dev');
      row.appendChild(el('div', 'ic', '🔗'));
      const mid = el('div', 'mid');
      mid.appendChild(el('div', 'nm', (d.name || d.id) + (d.id === S.deviceId ? '（本机）' : '')));
      mid.appendChild(el('div', 'mt', [d.type, d.platform, d.ip, d.by ? '由 @' + d.by : ''].filter(Boolean).join(' · ')));
      row.appendChild(mid);
      if (S.isAdmin && d.id !== S.deviceId) {
        const ops = el('div', 'ops');
        const x = el('button', 'del', '取消信任');
        x.onclick = () => jsonPost('/api/devices/trust', { id: d.id, op: 'untrust' })
          .then(() => { toast('已取消信任', 'ok'); reloadTrust(); reloadDevices(); })
          .catch((e) => toast(e.message || '失败', 'bad'));
        const b = el('button', 'del', '封禁');
        b.onclick = () => jsonPost('/api/devices/trust', { id: d.id, op: 'block', reason: '管理员操作' })
          .then(() => { toast('已封禁', 'ok'); reloadTrust(); reloadDevices(); })
          .catch((e) => toast(e.message || '失败', 'bad'));
        ops.appendChild(x); ops.appendChild(b);
        row.appendChild(ops);
      }
      c.appendChild(row);
    }

    if ((S.trust.blocked || []).length) {
      const c2 = card(w, '已封禁设备', S.trust.blocked.length + ' 台');
      for (const d of S.trust.blocked) {
        const row = el('div', 'ws-dev off');
        row.appendChild(el('div', 'ic', '⛔'));
        const mid = el('div', 'mid');
        mid.appendChild(el('div', 'nm', d.id));
        mid.appendChild(el('div', 'mt', d.reason || '已被封禁'));
        row.appendChild(mid);
        if (S.isAdmin) {
          const ops = el('div', 'ops');
          const x = el('button', '', '解除');
          x.onclick = () => jsonPost('/api/devices/trust', { id: d.id, op: 'unblock' })
            .then(() => { toast('已解除封禁', 'ok'); reloadTrust(); })
            .catch((e) => toast(e.message || '失败', 'bad'));
          ops.appendChild(x);
          row.appendChild(ops);
        }
        c2.appendChild(row);
      }
    }
  }

  /* ---- 同步 ---- */
  function renderSync(w) {
    const c0 = card(w, '同步状态', '以「目录指纹」判定差异，只拉变化部分');
    const cur = S.syncState;
    const g = el('div', 'ws-metrics');
    g.appendChild(metric((S.syncPeers || []).length, '有游标设备', ''));
    g.appendChild(metric(cur ? (cur.count || 0) : '—', '本机已同步条目', cur ? 'ok' : ''));
    g.appendChild(metric((S.shareStats && S.shareStats.active) || 0, '有效分享', ''));
    g.appendChild(metric((S.shareStats && S.shareStats.hits) || 0, '分享取件次数', ''));
    c0.appendChild(g);

    const note = el('div', 'ws-note');
    if (cur) {
      note.innerHTML = '本机基线：<b class="mono">' + esc((cur.fingerprint || '').slice(0, 12)) + '</b> · ' +
        esc(cur.disk + ':' + (cur.path || '/')) + ' · ' + (cur.count || 0) + ' 项 · ' + ago(cur.at);
    } else {
      note.textContent = '本机还没有同步基线。先在下方「建立基线」，之后改动会被精确识别。';
    }
    c0.appendChild(note);

    /* 目录选择 + 检查 */
    const c1 = card(w, '检查差异', '对当前目录生成清单并比对');
    const row = el('div', 'ws-row');
    const dSel = el('select', 'ws-sel');
    const disks = (S.disks && S.disks.length) ? S.disks : [{ scope: 'public', label: '公共盘' }];
    for (const d of disks) {
      const o = el('option', '', d.label || d.scope);
      o.value = d.scope || d.name || 'public';
      dSel.appendChild(o);
    }
    row.appendChild(dSel);
    const pIn = el('input');
    pIn.placeholder = '子目录（可留空）';
    row.appendChild(pIn);
    const depthSel = el('select', 'ws-sel narrow');
    for (const n of [2, 3, 4, 6, 8]) {
      const o = el('option', '', '深度 ' + n);
      o.value = String(n);
      if (n === 4) o.selected = true;
      depthSel.appendChild(o);
    }
    row.appendChild(depthSel);
    c1.appendChild(row);

    const r2 = el('div', 'ws-row');
    const bc = el('button', 'ws-btn primary', '检查差异');
    bc.onclick = () => checkSync(dSel.value, pIn.value.trim(), Number(depthSel.value));
    r2.appendChild(bc);
    const bb = el('button', 'ws-btn', '建立基线');
    bb.onclick = () => buildBaseline(dSel.value, pIn.value.trim(), Number(depthSel.value));
    r2.appendChild(bb);
    const bl = el('button', 'ws-btn', '用当前目录');
    bl.onclick = () => {
      dSel.value = state.disk || 'public';
      pIn.value = state.path || '';
      toast('已填入当前目录', 'ok');
    };
    r2.appendChild(bl);
    c1.appendChild(r2);

    /* 差异结果 */
    if (S.syncDiff) {
      const c2 = card(w, '差异结果', S.syncDiff.dirty ? '有变化' : '无变化');
      const gg = el('div', 'ws-metrics');
      gg.appendChild(metric(S.syncDiff.diff.added, '新增', S.syncDiff.diff.added ? 'acc' : ''));
      gg.appendChild(metric(S.syncDiff.diff.changed, '修改', S.syncDiff.diff.changed ? 'warn' : ''));
      gg.appendChild(metric(S.syncDiff.diff.removed, '删除', S.syncDiff.diff.removed ? 'bad' : ''));
      gg.appendChild(metric(S.syncDiff.diff.unchanged, '未变', 'ok'));
      c2.appendChild(gg);
      const nb = el('div', 'ws-note');
      nb.innerHTML = '当前指纹 <b class="mono">' + esc(String(S.syncDiff.fingerprint || '').slice(0, 12)) +
        '</b> · 基线 <b class="mono">' + esc(String(S.syncDiff.baseFingerprint || '（空）').slice(0, 12)) + '</b>';
      c2.appendChild(nb);

      if ((S.syncDiff.need || []).length) {
        const lst = el('div', 'ws-log');
        for (const e of S.syncDiff.need.slice(0, 20)) {
          const ln = el('div', 'ln');
          ln.appendChild(el('span', 't', '＋'));
          ln.appendChild(el('span', 'm mono', e.p + '  ' + fmtSize(e.s)));
          lst.appendChild(ln);
        }
        c2.appendChild(lst);
        const r3 = el('div', 'ws-row');
        const all = el('button', 'ws-btn primary', '拉取全部差异文件 (' + S.syncDiff.need.length + ')');
        all.onclick = () => {
          S.syncDiff.need.forEach((e, i) => setTimeout(() => triggerDownload(
            '/api/download?disk=' + encodeURIComponent(dSel.value) + '&path=' + encodeURIComponent(e.p),
            e.p.split('/').pop()), i * 400));
          toast('已开始下载 ' + S.syncDiff.need.length + ' 个文件', 'ok');
        };
        r3.appendChild(all);
        const mk = el('button', 'ws-btn', '标记为已同步');
        mk.onclick = () => markSync(dSel.value, pIn.value.trim(), S.syncDiff);
        r3.appendChild(mk);
        c2.appendChild(r3);
      }
    }

    /* 分享链接 */
    const c3 = card(w, '限时分享链接', '免登录取件，可设有效期与次数');
    const sr = el('div', 'ws-row');
    const sPath = el('input');
    sPath.placeholder = '要分享的相对路径，例如 docs/a.pdf';
    sPath.value = (state.sel && state.sel.size) ? [...state.sel][0] : (state.path || '');
    sr.appendChild(sPath);
    const ttlSel = el('select', 'ws-sel narrow');
    for (const [v, l] of [[3600000, '1 小时'], [86400000, '1 天'], [604800000, '7 天']]) {
      const o = el('option', '', l); o.value = String(v);
      if (v === 86400000) o.selected = true;
      ttlSel.appendChild(o);
    }
    sr.appendChild(ttlSel);
    const uSel = el('select', 'ws-sel narrow');
    for (const [v, l] of [[0, '不限次'], [1, '1 次'], [10, '10 次']]) {
      const o = el('option', '', l); o.value = String(v);
      uSel.appendChild(o);
    }
    sr.appendChild(uSel);
    const sb = el('button', 'ws-btn primary', '生成链接');
    sb.onclick = async () => {
      const p = sPath.value.trim();
      if (!p) return toast('请填写要分享的路径', 'bad');
      try {
        const r = await jsonPost('/api/share/create', {
          disk: state.disk || 'public', path: p,
          ttlMs: Number(ttlSel.value), maxUses: Number(uSel.value),
          device: S.deviceId, deviceName: S.deviceName,
        });
        const full = location.origin + r.url;
        const res = await copyText(full);
        toast(res.ok ? '链接已复制到剪贴板' : '链接已生成（请手动复制）', 'ok');
        S.lastShare = full;
        reloadShares();
        render();
      } catch (e) { toast(e.message || '生成失败', 'bad'); }
    };
    sr.appendChild(sb);
    c3.appendChild(sr);

    if (S.lastShare) {
      const nb = el('div', 'ws-note');
      nb.innerHTML = '刚生成：<b class="mono">' + esc(S.lastShare) + '</b>';
      c3.appendChild(nb);
    }
    if (!(S.shares || []).length) c3.appendChild(el('div', 'ws-empty', '暂无有效分享链接'));
    for (const s of (S.shares || []).slice(0, 15)) {
      const box = el('div', 'ws-item');
      const txt = el('div', 'txt mono');
      txt.textContent = location.origin + '/s/' + s.token;
      box.appendChild(txt);
      const meta = el('div', 'meta');
      meta.appendChild(el('span', 'k', s.isDir ? '目录' : '文件'));
      meta.appendChild(el('span', '', s.name));
      meta.appendChild(el('span', '', '剩 ' + fmtTime(Math.max(0, s.leftS) * 1000)));
      meta.appendChild(el('span', '', s.uses + ' 次' + (s.maxUses > 0 ? '/' + s.maxUses : '')));
      const ops = el('div', 'ops');
      const cp = el('button', '', '复制');
      cp.onclick = async () => {
        const r = await copyText(location.origin + '/s/' + s.token);
        toast(r.ok ? '已复制' : '请手动复制', r.ok ? 'ok' : 'bad');
      };
      const rv = el('button', 'del', '撤销');
      rv.onclick = () => jsonPost('/api/share/revoke', { token: s.token })
        .then(() => { toast('已撤销', 'ok'); reloadShares(); })
        .catch((e) => toast(e.message || '失败', 'bad'));
      ops.appendChild(cp); ops.appendChild(rv);
      meta.appendChild(ops);
      box.appendChild(meta);
      c3.appendChild(box);
    }
  }

  async function checkSync(disk, path, depth) {
    try {
      const key = 'ws.sync.' + disk + ':' + path;
      let base = [];
      let fp = '';
      try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null');
        if (raw) { base = raw.entries || []; fp = raw.fingerprint || ''; }
      } catch (e) { /* 无基线 */ }
      const r = await jsonPost('/api/sync/check', { disk, path, depth, base, baseFingerprint: fp });
      S.syncDiff = r;
      S._syncKey = key;
      toast(r.dirty ? ('发现变化：新增 ' + r.diff.added + '，修改 ' + r.diff.changed + '，删除 ' + r.diff.removed)
        : '与基线一致，无变化', r.dirty ? 'ok' : 'ok');
      render();
    } catch (e) { toast(e.message || '检查失败', 'bad'); }
  }

  async function buildBaseline(disk, path, depth) {
    try {
      const r = await api('/api/sync/manifest?disk=' + encodeURIComponent(disk) +
        '&path=' + encodeURIComponent(path) + '&depth=' + depth);
      const key = 'ws.sync.' + disk + ':' + path;
      localStorage.setItem(key, JSON.stringify({ entries: r.entries, fingerprint: r.fingerprint, at: Date.now() }));
      S.syncDiff = null;
      await markSync(disk, path, { fingerprint: r.fingerprint, count: r.count, files: r.files });
      toast('基线已建立：' + r.count + ' 项（指纹 ' + r.fingerprint.slice(0, 8) + '）', 'ok');
      render();
    } catch (e) { toast(e.message || '建立失败', 'bad'); }
  }

  async function markSync(disk, path, info) {
    try {
      await jsonPost('/api/sync/mark', {
        device: S.deviceId, disk, path,
        fingerprint: info.fingerprint, count: info.count || 0, files: info.files || 0,
      });
      await reloadSync();
      return true;
    } catch (e) { toast(e.message || '标记失败', 'bad'); return false; }
  }

  /* ---- 协同板 ---- */
  function renderBoard(w) {
    const c0 = card(w, '投递内容', '手机复制 → PC 粘贴，无需同账号');
    const comp = el('div', 'ws-compose');
    const ta = el('textarea');
    ta.placeholder = '粘贴文本 / 链接 / 路径…（Ctrl+Enter 发送）';
    comp.appendChild(ta);

    const row = el('div', 'row');
    const send = el('button', 'ws-btn primary', '投递到协同板');
    send.onclick = () => doPost(ta);
    const paste = el('button', 'ws-btn', '读取剪贴板');
    paste.onclick = async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (t) { ta.value = t; ta.focus(); }
        else toast('剪贴板为空', 'bad');
      } catch (e) {
        toast('浏览器未授予剪贴板读取权限，请手动粘贴', 'bad');
        ta.focus();
      }
    };
    const clr = el('button', 'ws-btn danger', '清空板');
    clr.onclick = () => {
      if (!confirm('清空全部协同板内容？')) return;
      jsonPost('/api/board/clear', {})
        .then((r) => { toast('已清空 ' + (r.removed || 0) + ' 条', 'ok'); reloadBoard(false); })
        .catch((e) => toast(e.message || '清空失败', 'bad'));
    };
    row.appendChild(send); row.appendChild(paste); row.appendChild(clr);
    comp.appendChild(row);
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doPost(ta); } };
    c0.appendChild(comp);

    const c = card(w, '板面内容', (S.board || []).length + ' 条');
    if (!(S.board || []).length) c.appendChild(el('div', 'ws-empty', '还没有内容。'));
    for (const it of S.board) c.appendChild(boardRow(it));
  }

  function boardRow(it) {
    const box = el('div', 'ws-item' + (it.pinned ? ' pinned' : ''));
    const txt = el('div', 'txt' + (it.kind === 'path' || it.kind === 'link' ? ' mono' : ''));
    txt.textContent = it.text;
    box.appendChild(txt);

    const meta = el('div', 'meta');
    meta.appendChild(el('span', 'k', kindLabel(it.kind)));
    meta.appendChild(el('span', '', (it.deviceName || '未知设备') + (it.user ? ' @' + it.user : '')));
    meta.appendChild(el('span', '', ago(it.ts)));

    const ops = el('div', 'ops');
    const cp = el('button', '', '复制');
    cp.onclick = async () => {
      // v4.1：HTTP 局域网下 Clipboard API 不可用 → 自动降级 execCommand
      const r = await copyText(it.text);
      if (r.ok) toast('已复制到剪贴板', 'ok');
      else toast('复制失败，请长按选中手动复制', 'bad');
    };
    const sv = el('button', '', '下载为文件');
    sv.onclick = () => {
      const name = 'board-' + new Date(it.ts).toISOString().slice(0, 10) + '.txt';
      triggerDownload('data:text/plain;charset=utf-8,' + encodeURIComponent(it.text), name);
    };
    const pn = el('button', '', it.pinned ? '取消置顶' : '置顶');
    pn.onclick = () => {
      jsonPost('/api/board/pin', { id: it.id, pinned: !it.pinned })
        .then(() => reloadBoard(false))
        .catch((e) => toast(e.message || '操作失败', 'bad'));
    };
    const dl = el('button', 'del', '删除');
    dl.onclick = () => {
      jsonPost('/api/board/remove', { id: it.id })
        .then(() => reloadBoard(false))
        .catch((e) => toast(e.message || '删除失败', 'bad'));
    };
    ops.appendChild(cp); ops.appendChild(sv); ops.appendChild(pn); ops.appendChild(dl);
    meta.appendChild(ops);
    box.appendChild(meta);
    return box;
  }

  async function doPost(ta) {
    const text = (ta.value || '').trim();
    if (!text) { toast('内容不能为空', 'bad'); return; }
    try {
      const r = await jsonPost('/api/board/post', {
        text,
        device: S.deviceId,
        deviceName: S.deviceName,
      });
      ta.value = '';
      if (r && r.duplicate) toast('内容重复，已合并', 'ok');
      else toast('已投递，其他设备可见', 'ok');
      await reloadBoard(false);
    } catch (e) {
      toast(e.message || '投递失败（需登录）', 'bad');
    }
  }

  /* ---- AI 助手（v4.2） ---- */
  function renderAI(w) {
    /* 全屏对话视图已抽到 public/aiview.js
       （P0 体验升级 + P2 模块化：本文件减少约 290 行） */
    if (window.AIView) {
      AIView.mount(w, {
        cfg: () => ({
          active: S.aiActive, backends: S.aiBackends, isAdmin: S.aiIsAdmin,
          system: S.aiSystem, temperature: S.aiTemperature,
          maxTokens: S.aiMaxTokens, noThink: S.aiNoThink, lastError: S.aiLastError,
          /* v4.3 */
          allowTools: S.aiAllowTools, allowWrite: S.aiAllowWrite,
          maxToolRounds: S.aiMaxToolRounds, model: S.aiModel, name: S.aiName,
        }),
        reload: reloadAI,
        /* 当前浏览位置：模型说「这个目录」时指的就是它 */
        cwd: () => (state.disk || 'public') + ':' + (state.path || ''),
      });
      return;
    }
    w.appendChild(el('div', 'ws-empty', 'AI 视图未加载'));
  }

  /** 把服务端返回的配置视图并入本地状态 */
  function applyAiView(r) {
    if (!r) return;
    if (Array.isArray(r.backends)) S.aiBackends = r.backends;
    /* 每个后端接口都回带 isAdmin，用它直接定权限，
       不再依赖 /api/station 的时序（否则登录后配置区要等整站刷新才出现） */
    if (typeof r.isAdmin === 'boolean') S.aiIsAdmin = r.isAdmin;
    if (r.activeId != null) S.aiActive = r.backends ? (r.backends.find((b) => b.active) || null) : S.aiActive;
    if (r.system != null) S.aiSystem = r.system;
    if (r.temperature != null) S.aiTemperature = r.temperature;
    if (r.maxTokens != null) S.aiMaxTokens = r.maxTokens;
    if (r.disableThinking != null) S.aiNoThink = !!r.disableThinking;
    /* v4.3：工具开关 + 当前模型 —— 后者让界面不必先点「设置」才知道用的什么模型 */
    if (r.allowTools != null) S.aiAllowTools = !!r.allowTools;
    if (r.allowWrite != null) S.aiAllowWrite = !!r.allowWrite;
    if (r.maxToolRounds != null) S.aiMaxToolRounds = Number(r.maxToolRounds) || 4;
    if (r.activeModel != null) S.aiModel = String(r.activeModel || '');
    if (r.activeName != null) S.aiName = String(r.activeName || '');
    if (r.lastError != null) S.aiLastError = r.lastError;
  }

  function reloadAI() {
    return api('/api/ai/config')
      .then((r) => {
        applyAiView(r);
        /* ⚠️ 这里不能走 render()：onRouteEnter('#/ai') 在"已挂载"时会 early-return
           （防高频事件重画），于是配置到手后 AI 视图拿不到新 cfg，
           表现为「必须点一下设置才认到模型」。
           改为显式通知 AIView 重读配置。 */
        if (onModule('#/ai')) {
          if (window.AIView) {
            if (AIView.isMounted && AIView.isMounted()) AIView.refresh();
            else render();
          } else {
            render();
          }
        }
      })
      .catch(() => { /* 配置读取失败不阻塞界面 */ });
  }

  /** 发送一条消息。流式读取 SSE，逐字上屏。 */

  /* ---- 事件流 ---- */
  function renderEvents(w) {
    const c = card(w, '实时事件流', S.ledger.length + ' 条');
    const row = el('div', 'ws-row');
    const b = el('button', 'ws-btn', '清屏');
    b.onclick = () => { S.ledger = []; render(); };
    row.appendChild(b);
    const info = el('span', 'ws-note', S.connected ? 'SSE 已连接' : 'SSE 重连中');
    row.appendChild(info);
    c.appendChild(row);

    const list = el('div', 'ws-log');
    if (!S.ledger.length) list.appendChild(el('div', 'ws-empty', '暂无事件'));
    for (const e of S.ledger) list.appendChild(logLine(e));
    c.appendChild(list);
  }

  function logLine(e) {
    const ln = el('div', 'ln');
    ln.appendChild(el('span', 't', clock(e.ts)));
    ln.appendChild(el('span', 'ch ' + e.channel, e.channel));
    const p = e.payload;
    let desc = e.type;
    if (p) {
      if (e.type === 'task.progress' || e.type === 'task.created' || e.type === 'task.done') {
        desc = (p.name || '任务') + (p.status === 'running' ? ' ' + Math.round(p.progress || 0) + '%' : ' → ' + statusLabel(p.status));
      } else if (e.type.startsWith('devices.')) {
        desc = (p.name || p.id || '设备') + ' ' + e.type.split('.')[1];
      } else if (e.type === 'board.item') {
        desc = '新条目（' + kindLabel(p.kind) + '）';
      } else if (e.type === 'files.changed') {
        desc = (p.action || 'change') + ' ' + (p.disk || '') + ' / ' + (p.path || '/');
      } else if (e.type === 'server.ready') {
        desc = '服务就绪 ' + (p.version || '');
      }
    }
    ln.appendChild(el('span', 'm', desc));
    return ln;
  }

  /* ------------------------------ 渲染小工具 ------------------------------ */

  function card(w, title, sub) {
    const c = el('div', 'ws-card');
    const h = el('div', 'ws-h');
    h.appendChild(el('span', '', title));
    if (sub) h.appendChild(el('span', 'sub', sub));
    c.appendChild(h);
    w.appendChild(c);
    return c;
  }

  function metric(v, k, cls) {
    const m = el('div', 'ws-metric');
    m.appendChild(el('div', 'v ' + (cls || ''), String(v)));
    m.appendChild(el('div', 'k', k));
    return m;
  }

  function pctCls(v, warn, bad) {
    if (v == null) return '';
    if (v >= bad) return 'bad';
    if (v >= warn) return 'warn';
    return 'ok';
  }

  function capLabel(c) { return CAP_LABEL[c] || c; }
  function kindLabel(k) { return ({ text: '文本', link: '链接', path: '路径', note: '笔记' })[k] || '文本'; }
  function statusLabel(s) {
    return ({ queued: '排队', running: '进行中', done: '完成', error: '失败', cancelled: '取消' })[s] || s;
  }

  /* ------------------------------ 对外钩子 ------------------------------ */

  const Workstation = {
    /** 新建跨设备任务；返回服务端任务 id（失败返回 null，不阻断主流程） */
    async beginTask(o) {
      try {
        const r = await jsonPost('/api/tasks/create', {
          name: o && o.name,
          type: (o && o.type) || 'generic',
          disk: (o && o.disk) || state.disk,
          path: (o && o.path) || '',
          total: (o && o.total) || 0,
          unit: (o && o.unit) || 'bytes',
          device: S.deviceId,
          meta: (o && o.meta) || {},
        });
        return r && r.task ? r.task.id : null;
      } catch (e) { return null; }
    },
    /** 推送进度（本地节流，避免刷爆网络） */
    progressTask(id, p) {
      if (!id) return;
      const now = Date.now();
      const last = S._taskPush.get(id) || 0;
      if (now - last < TASK_PUSH_MS) return;
      S._taskPush.set(id, now);
      jsonPost('/api/tasks/progress', { id, ...(p || {}) }).catch(() => {});
    },
    /** 结束任务 */
    endTask(id, r) {
      if (!id) return;
      S._taskPush.delete(id);
      jsonPost('/api/tasks/finish', { id, ok: !(r && r.ok === false), error: (r && r.error) || '', result: (r && r.result) || null })
        .catch(() => {});
    },
    /** 执行体轮询取消状态（服务端权威） */
    async isCancelled(id) {
      if (!id) return false;
      try {
        const r = await api('/api/tasks?limit=60');
        const t = (r.items || []).find((x) => x.id === id);
        return !!(t && t.status === 'cancelled');
      } catch (e) { return false; }
    },
    /** 打开工作站面板 */
    open: openStation,
    /** 直接把一段内容投到协同板 */
    share(text, kind) {
      return jsonPost('/api/board/post', { text, kind, device: S.deviceId, deviceName: S.deviceName });
    },

    /* ---- v4.1 新增对外能力（其他页面/面板可直接调用） ---- */
    /** 写剪贴板（自动降级，HTTP 下也可用） */
    copy: copyText,
    /** 把文件推送到另一台在线设备 */
    pushFile(disk, path, targetDevice) {
      const name = String(path || '').split('/').pop();
      return sendRemote(targetDevice || '', 'download',
        { disk: disk || state.disk || 'public', path, name }, '推送文件');
    },
    /** 下发任意远程指令 */
    remote: sendRemote,
    /** 本机是否接受远程控制 */
    setAcceptRemote(on) {
      S.acceptRemote = !!on;
      localStorage.setItem(LS_ACCEPT, S.acceptRemote ? '1' : '0');
      return S.acceptRemote;
    },
    /** 用配对码配对 */
    pair: claimPairing,
    /** 生成分享链接 */
    async makeShare(disk, path, opt) {
      const r = await jsonPost('/api/share/create', {
        disk: disk || state.disk || 'public', path,
        ttlMs: (opt && opt.ttlMs) || 86400000,
        maxUses: (opt && opt.maxUses) || 0,
        device: S.deviceId, deviceName: S.deviceName,
      });
      return location.origin + r.url;
    },
    /** 站内通知广播 */
    broadcast(text, level) {
      return jsonPost('/api/notify/broadcast', { text, level: level || 'info' });
    },
    /** 触发一次下载 */
    download: triggerDownload,

    state: S,
    reloadDevices,
    reloadTasks,
    reloadBoard,
    reloadStation,
    reloadRemote,
    reloadSync,
    reloadTrust,
    reloadShares,
  };
  window.Workstation = Workstation;

  /* ------------------------------ 顶栏注入（v5：入口已由 shell.js 顶栏导航承担） ------------------------------ */

  function injectPill() {
    /* v5 外壳：模块导航由 shell.js 注入，这里只做首刷药丸；
       旧 .mtop / .sidebar 入口已随外壳移除。 */
    paintPill();
  }

  function paintSideBtn() { /* v5 已废弃：顶栏药丸即入口 */ }

  /* ------------------------------ 启动 ------------------------------ */

  function boot() {
    loadIdentity();
    injectPill();
    /* v5：注册各模块的渲染钩子（shell.js 路由进入时触发） */
    if (window.Shell) {
      Shell._stationHook = onRouteEnter;   /* shell 兜底调用通道 */
      Workstation._onRoute = onRouteEnter; /* 对外暴露（shell.apply 也直接调） */
      /* shell 已 boot 过（比本文件先加载）则立刻补渲染当前模块 */
      onRouteEnter(Shell.route());
    }
    registerSelf(true).then(() => {
      connect();
      reloadStation();
      startHeartbeat();
      // v4.1：首屏顺带拉一次远程目标与信任状态（顶栏徽章/控制台要用）
      reloadRemote();
      reloadTrust();
      // v4.2：AI 后端配置
      reloadAI();
    });
    // 面板里显示任务时也保持刷新
    setInterval(() => { if (onModule('#/collab') || onModule('#/')) reloadDevices(); }, 30000);
    // v4.1：面板打开时轮询在途指令（SSE 掉线时的兜底路径）
    setInterval(() => {
      if (onModule('#/collab', 'ctl')) reloadRemote();
      if (onModule('#/collab', 'sync')) reloadShares();
    }, 20000);
    // v4.1：本机若被下发指令但 SSE 断了，靠轮询拿（需已配对或已登录）
    setInterval(() => {
      if (S.connected) return;              // SSE 正常时不轮询
      if (!S.token && !state.user) return;
      api('/api/remote/inbox?device=' + encodeURIComponent(S.deviceId) + '&limit=10')
        .then((r) => { for (const c of (r && r.items) || []) runRemoteCommand(c); })
        .catch(() => {});
    }, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 少量内部钩子：给 AI 视图与调试用。
     注意只暴露"重新拉取"这类幂等操作，不暴露状态本体。 */
  window.Station = {
    reloadAI,
    /* 登录/登出后权限会变，配置区需要重算 */
    refreshAi: reloadAI,
    /* 只读快照：排障时看一眼当前状态（不暴露修改入口） */
    _state: () => ({ aiIsAdmin: S.aiIsAdmin, isAdmin: S.isAdmin, aiName: S.aiName, aiModel: S.aiModel }),
  };
})();

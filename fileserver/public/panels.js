'use strict';

/* =====================================================================
   panels.js — 高级功能面板（回收站/版本/共享/定时任务/健康/检索/去重/审计）
   + 缩略图本地缓存（IndexedDB，规避原图直传）
   依赖 app.js 运行时辅助：el / api / jsonPost / toast / fmtSize / fmtTime
   ===================================================================== */

/* ---------------- 缩略图缓存（IndexedDB） ---------------- */
const THUMB_DB = (() => {
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open('fs-thumbs', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('t');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbp;
  };
  return {
    async get(key) {
      const db = await open();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('t', 'readonly');
          const r = tx.objectStore('t').get(key);
          r.onsuccess = () => resolve(r.result || null);
          r.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    },
    async set(key, val) {
      const db = await open();
      if (!db) return;
      try {
        const tx = db.transaction('t', 'readwrite');
        tx.objectStore('t').put(val, key);
      } catch (e) {}
    },
  };
})();

/** 生成缩略图：优先本地缓存，否则下载原图 → canvas 缩放 → 存缓存 */
async function thumbFor(url, key, maxSize = 256) {
  if (typeof state.thumbCacheEnabled === 'undefined') state.thumbCacheEnabled = true;
  if (!state.thumbCacheEnabled) return url;
  const cached = await THUMB_DB.get(key);
  if (cached) return cached;
  try {
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) return url;
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) return url;
    const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    const data = canvas.toDataURL('image/webp', 0.82);
    await THUMB_DB.set(key, data);
    return data;
  } catch (e) { return url; }
}

/* ---------------- 通用面板容器 ---------------- */
function openPanel(title, buildFn) {
  let host = document.getElementById('sidePanel');
  if (!host) {
    host = el('div', 'side-panel');
    host.id = 'sidePanel';
    (document.querySelector('.shell-main') || document.body).appendChild(host);
  }
  host.innerHTML = '';
  const box = el('div', 'side-box');
  const head = el('div', 'side-head');
  head.appendChild(el('span', '', title));
  const close = el('button', 'icon-btn', '✕');
  close.onclick = () => { host.hidden = true; };
  head.appendChild(close);
  box.appendChild(head);
  const bodyEl = el('div', 'side-body');
  box.appendChild(bodyEl);
  host.appendChild(box);
  host.hidden = false;
  buildFn(bodyEl);
  return bodyEl;
}

/* ---------------- 回收站 ---------------- */
async function panelRecycle() {
  openPanel('回收站', async (body) => {
    body.appendChild(el('div', 'panel-note', '删除的文件暂存于此，30 天后自动清理'));
    let items = [];
    try { items = (await api(`/api/recycle?disk=${encodeURIComponent(state.disk)}`)).items || []; }
    catch (e) { body.appendChild(el('div', 'err', e.message)); return; }
    if (!items.length) { body.appendChild(el('div', 'panel-note', '回收站是空的')); return; }

    const bar = el('div', 'panel-actions');
    const clearBtn = el('button', 'btn danger', '清空回收站');
    clearBtn.onclick = async () => {
      if (!(await uiConfirm('清空回收站', '将永久删除回收站内所有文件，不可恢复！', '清空'))) return;
      await jsonPost('/api/recycle/purge', { disk: state.disk });
      toast('已清空', 'ok');
      panelRecycle();
    };
    bar.appendChild(clearBtn);
    body.appendChild(bar);

    for (const it of items.slice().reverse()) {
      const row = el('div', 'rec-row');
      const info = el('div', 'rec-info');
      info.appendChild(el('div', 'rec-name', it.name));
      info.appendChild(el('div', 'rec-meta', `${fmtSize(it.size)} · 原路径 /${it.original} · ${fmtTime(it.deletedAt)} · ${it.deletedBy}`));
      row.appendChild(info);
      const rst = el('button', 'btn', '还原');
      rst.onclick = async () => {
        await jsonPost('/api/recycle/restore', { disk: state.disk, id: it.id });
        toast('已还原', 'ok');
        panelRecycle();
        loadList();
      };
      const del = el('button', 'btn danger', '永久删除');
      del.onclick = async () => {
        await jsonPost('/api/recycle/purge', { disk: state.disk, id: it.id });
        panelRecycle();
      };
      row.appendChild(rst); row.appendChild(del);
      body.appendChild(row);
    }
  });
}

/* ---------------- 版本历史 ---------------- */
async function panelVersions(entry) {
  if (!entry) {
    openPanel('历史版本', (body) => {
      body.appendChild(el('div', 'panel-note', '请回到文件列表，点单个文件的「ⓘ 信息」查看其历史版本；这里显示最近删除/覆盖的备份目录'));
      const b = el('button', 'btn primary', '浏览 .versions 目录');
      b.onclick = () => { location.hash = ''; switchDisk(state.disk); state.path = '.versions'; state.searching = false; loadList(); };
      body.appendChild(b);
    });
    return;
  }
  openPanel('版本历史 · ' + entry.name, async (body) => {
    let vs = [];
    try { vs = (await api(`/api/versions?disk=${encodeURIComponent(state.disk)}&path=${encodeURIComponent(entryRel(entry))}`)).versions || []; }
    catch (e) { body.appendChild(el('div', 'err', e.message)); return; }
    if (!vs.length) { body.appendChild(el('div', 'panel-note', '暂无历史版本（覆盖同名文件时会留存旧版）')); return; }
    for (const v of vs) {
      const row = el('div', 'rec-row');
      const info = el('div', 'rec-info');
      info.appendChild(el('div', 'rec-name', v.name));
      info.appendChild(el('div', 'rec-meta', `${fmtSize(v.size)} · ${fmtTime(v.mtime)}`));
      row.appendChild(info);
      const dl = el('button', 'btn', '下载此版本');
      dl.onclick = () => {
        window.open(`/api/download?disk=${encodeURIComponent(state.disk)}&path=${encodeURIComponent('.versions/' + entryRel(entry) + '/' + v.name)}`, '_blank');
      };
      row.appendChild(dl);
      body.appendChild(row);
    }
  });
}

/* ---------------- 共享链接 ---------------- */
async function panelShares(entry) {
  openPanel('共享链接', async (body) => {
    body.appendChild(el('div', 'panel-note', entry ? `为「${entry.name}」创建外链，免登录访问` : '管理我的共享链接'));
    if (entry) {
      const mk = el('div', 'panel-actions');
      const hoursSel = el('select', '');
      [['0', '永久有效'], ['24', '24 小时'], ['168', '7 天'], ['720', '30 天']].forEach(([v, t]) => {
        const o = el('option', '', t); o.value = v; hoursSel.appendChild(o);
      });
      const pw = el('input', '');
      pw.type = 'password'; pw.placeholder = '访问密码（可空）';
      const mode = el('select', '');
      [['read', '只读'], ['write', '可读写']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; mode.appendChild(o); });
      const create = el('button', 'btn primary', '创建链接');
      create.onclick = async () => {
        const r = await jsonPost('/api/shares', {
          disk: state.disk, path: entryRel(entry), mode: mode.value,
          hours: +hoursSel.value || 0, password: pw.value || '',
        });
        const url = location.origin + r.url;
        await uiPrompt('共享链接已创建（可复制）', url, '');
        panelShares();
      };
      mk.appendChild(hoursSel); mk.appendChild(pw); mk.appendChild(mode); mk.appendChild(create);
      body.appendChild(mk);
    }
    let list = [];
    try { list = (await api('/api/shares')).shares || []; } catch (e) { return; }
    for (const s of list) {
      const row = el('div', 'rec-row');
      const info = el('div', 'rec-info');
      info.appendChild(el('div', 'rec-name', '/' + (s.path || '') + (s.path ? '' : '（整个盘）')));
      info.appendChild(el('div', 'rec-meta', `${s.mode === 'write' ? '可读写' : '只读'} · 访问 ${s.hits} 次 · ${s.expires ? '过期 ' + fmtTime(s.expires) : '永久'} · ${s.password ? '有密码' : '无密码'}`));
      row.appendChild(info);
      const copy = el('button', 'btn', '复制链接');
      copy.onclick = () => { navigator.clipboard.writeText(location.origin + '/s/' + s.token).then(() => toast('已复制', 'ok')); };
      const rm = el('button', 'btn danger', '删除');
      rm.onclick = async () => { await jsonPost('/api/shares/delete', { id: s.id }); panelShares(); };
      row.appendChild(copy); row.appendChild(rm);
      body.appendChild(row);
    }
  });
}

/* ---------------- 定时同步任务 ---------------- */
async function panelJobs() {
  openPanel('定时同步任务', async (body) => {
    body.appendChild(el('div', 'panel-note', '按周期把源目录增量复制到目标目录（按大小+修改时间判断）'));
    const mk = el('div', 'panel-actions');
    const name = el('input', ''); name.placeholder = '任务名';
    const src = el('input', ''); src.placeholder = '源路径（相对当前盘，空=整盘）';
    const dst = el('input', ''); dst.placeholder = '目标路径';
    const sched = el('select', '');
    [['hourly', '每小时'], ['daily', '每天'], ['weekly', '每周']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; sched.appendChild(o); });
    const add = el('button', 'btn primary', '新增');
    add.onclick = async () => {
      await jsonPost('/api/jobs', {
        name: name.value || '同步任务',
        srcDisk: state.disk, srcPath: src.value.trim(),
        dstDisk: state.disk, dstPath: dst.value.trim(),
        schedule: sched.value,
      });
      toast('任务已创建', 'ok');
      panelJobs();
    };
    mk.appendChild(name); mk.appendChild(src); mk.appendChild(dst); mk.appendChild(sched); mk.appendChild(add);
    body.appendChild(mk);

    let jobs = [];
    try { jobs = (await api('/api/jobs')).jobs || []; } catch (e) { return; }
    for (const j of jobs) {
      const row = el('div', 'rec-row');
      const info = el('div', 'rec-info');
      info.appendChild(el('div', 'rec-name', j.name));
      info.appendChild(el('div', 'rec-meta', `${j.srcDisk}:/${j.srcPath || ''} → ${j.dstDisk}:/${j.dstPath || ''} · ${j.schedule} · 上次：${j.lastRun ? fmtTime(j.lastRun) + ' ' + (j.lastStatus || '') : '未运行'}`));
      row.appendChild(info);
      const run = el('button', 'btn', '立即执行');
      run.onclick = async () => {
        toast('执行中…');
        const r = await jsonPost('/api/jobs/run', { id: j.id });
        toast(r.ok ? `完成：复制 ${r.copied} 个` : ('失败：' + r.error), r.ok ? 'ok' : 'bad');
        panelJobs();
      };
      const rm = el('button', 'btn danger', '删除');
      rm.onclick = async () => { await jsonPost('/api/jobs/delete', { id: j.id }); panelJobs(); };
      row.appendChild(run); row.appendChild(rm);
      body.appendChild(row);
    }
  });
}

/* ---------------- 系统健康 ---------------- */
async function panelHealth() {
  openPanel('系统健康', async (body) => {
    body.appendChild(el('div', 'panel-note', '刷新中…'));
    let h = null;
    try { h = await api('/api/health'); } catch (e) { body.innerHTML = ''; body.appendChild(el('div', 'err', e.message)); return; }
    body.innerHTML = '';
    const kv = (k, v) => {
      const r = el('div', 'info-row');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', 'v', String(v)));
      body.appendChild(r);
    };
    kv('运行时长', Math.floor(h.uptime / 3600) + ' 小时 ' + Math.floor((h.uptime % 3600) / 60) + ' 分');
    kv('Node', h.node);
    kv('内存占用', fmtSize(h.mem.rss) + ' / 堆 ' + fmtSize(h.mem.heapUsed));
    /* CPU：优先显示**系统负载**（loadavg），它是三元素语义、最贴近用户直觉。
       ⚠️ 判据必须是 loadSupported，**不能是 `h.load.length`**：
          [0,0,0].length === 3 是真值，用它当判据会走进「负载」分支、
          渲染出「0.00 / 0.00 / 0.00」—— 这正是本次修的那个 bug 的原始形态
          （看起来像真实数据，实际是假的）。
       ⚠️ 也**不能**用 cpuSupported 当判据：它表示「有没有占用率计数源」，
          与「有没有负载」是两件事。Android 就是典型反例 ——
          /proc/stat 与 os.cpus() 都拿不到（cpuSupported=false），
          但 os.loadavg() 返回**真实负载**（loadSupported=true）。
          用错判据会让手机健康页明明有真实负载却显示「不支持」。 */
    if (h.loadSupported === true && h.load) {
      kv('负载', h.load.map((x) => Number(x).toFixed(2)).join(' / ') + '（1/5/15 分钟）');
    } else if (h.cpuUsedPct != null) {
      kv('CPU 占用', h.cpuUsedPct.toFixed(1) + '%（瞬时）');
    } else {
      /* 两样都没有：要么首次无基线（下次刷新就有），要么本平台确实拿不到。
         区分开来 —— 说「采样中」会让人一直等一个永远不会来的值。 */
      kv('CPU 占用', h.cpuSupported === false && h.loadSupported === false
        ? '当前环境不支持（无可用 CPU 计数源）'
        : '采样中…（首次请求无基线，下一次刷新即有值）');
    }
    kv('硬链接支持', h.hardlink ? '支持（可去重/快照）' : '不支持（平台限制）');
    kv('SMART 工具', h.smartctl ? '已安装' : '未安装（pkg install smartmontools）');
    if (h.battery) kv('电量', h.battery + '%');
    if (h.thermal) kv('温度', (parseInt(h.thermal, 10) / 1000).toFixed(1) + '°C');

    body.appendChild(el('div', 'panel-note', '存储'));
    for (const d of h.disks) {
      kv(d.name, `${fmtSize(d.total - d.free)} / ${fmtSize(d.total)}（${d.usedPct}%）${d.writable ? '' : ' · 只读'}`);
    }
    if (h.alerts && h.alerts.length) {
      const box = el('div', 'alert-box');
      for (const a of h.alerts) box.appendChild(el('div', '', '⚠ ' + a));
      body.appendChild(box);
    }
  });
}

/* ---------------- 全文检索 ---------------- */
async function panelSearch() {
  openPanel('全文检索', async (body) => {
    const note = el('div', 'panel-note', '索引：文本类文件（txt/md/csv/log/json/代码等），中文按三字符切分');
    body.appendChild(note);
    const bar = el('div', 'panel-actions');
    const input = el('input', '');
    input.placeholder = '输入关键词…';
    const go = el('button', 'btn primary', '搜索');
    const build = el('button', 'btn', '重建索引');
    bar.appendChild(input); bar.appendChild(go); bar.appendChild(build);
    body.appendChild(bar);
    const res = el('div', 'search-results');
    body.appendChild(res);

    build.onclick = async () => {
      res.innerHTML = '<div class="panel-note">索引构建中（大文件盘可能耗时）…</div>';
      const r = await jsonPost('/api/index/build', {});
      /* R6-6-2：r.error 是服务端文案（可能含路径/文件名等外部数据）——
         直插 innerHTML 有注入面，统一转义（escHTML 已同时覆盖引号）。 */
      const safeErr = (typeof escHTML === 'function') ? escHTML(String(r.error || '')) : String(r.error || '');
      res.innerHTML = r.ok
        ? `<div class="panel-note">已索引 ${Number(r.indexed) || 0} 个文件</div>`
        : `<div class="err">${safeErr}</div>`;
    };
    const run = async () => {
      const q = input.value.trim();
      if (!q) return;
      res.innerHTML = '<div class="panel-note">检索中…</div>';
      const r = await api(`/api/search-content?q=${encodeURIComponent(q)}`);
      res.innerHTML = '';
      if (!r.ok) { res.appendChild(el('div', 'err', r.error)); return; }
      if (!r.results.length) { res.appendChild(el('div', 'panel-note', '没有匹配结果（可能需要先重建索引）')); return; }
      for (const hit of r.results) {
        const row = el('div', 'hit-row');
        row.appendChild(el('div', 'hit-path', hit.path));
        row.appendChild(el('div', 'hit-snip', hit.s));
        res.appendChild(row);
      }
    };
    go.onclick = run;
    input.onkeydown = (e) => { if (e.key === 'Enter') run(); };
  });
}

/* ---------------- 重复文件 ---------------- */
async function panelDedup() {
  openPanel('重复文件', async (body) => {
    body.appendChild(el('div', 'panel-note', '按内容哈希找出重复文件，可用硬链接合并（零占用）'));
    const btn = el('button', 'btn primary', '开始扫描当前盘');
    body.appendChild(btn);
    const out = el('div', 'dedup-out');
    body.appendChild(out);
    btn.onclick = async () => {
      out.innerHTML = '<div class="panel-note">扫描中（按大小分组后计算哈希）…</div>';
      const r = await jsonPost('/api/dedup/scan', { disk: state.disk });
      out.innerHTML = '';
      if (!r.ok) { out.appendChild(el('div', 'err', r.error)); return; }
      out.appendChild(el('div', 'panel-note', `发现 ${r.groups.length} 组重复，可回收 ${fmtSize(r.waste)}${r.hardlink ? '' : '（该平台不支持硬链接，无法合并）'}`));
      for (const g of r.groups.slice(0, 60)) {
        const row = el('div', 'dedup-group');
        row.appendChild(el('div', 'dg-head', `${g.files.length} 份 · ${fmtSize(g.size)} · ${g.hash.slice(0, 12)}`));
        for (const f of g.files) row.appendChild(el('div', 'dg-file', '/ ' + f));
        if (r.hardlink) {
          const b = el('button', 'btn', '合并为硬链接');
          b.onclick = async () => {
            const r2 = await jsonPost('/api/dedup/link', { disk: state.disk, files: g.files });
            toast(r2.ok ? `已合并 ${r2.linked} 个` : '合并失败', r2.ok ? 'ok' : 'bad');
            panelDedup();
          };
          row.appendChild(b);
        }
        out.appendChild(row);
      }
    };
  });
}

/* ---------------- 审计日志 ---------------- */
async function panelAudit() {
  openPanel('操作审计', async (body) => {
    let items = [];
    try { items = (await api('/api/audit?limit=300')).items || []; }
    catch (e) { body.appendChild(el('div', 'err', e.message)); return; }
    if (!items.length) { body.appendChild(el('div', 'panel-note', '暂无记录')); return; }
    for (const it of items) {
      const row = el('div', 'audit-row');
      row.appendChild(el('span', 'a-time', it.ts.replace('T', ' ').slice(0, 19)));
      row.appendChild(el('span', 'a-user', it.user));
      row.appendChild(el('span', 'a-act ' + (it.ok ? '' : 'bad'), it.action));
      row.appendChild(el('span', 'a-path', (it.disk ? it.disk + ':' : '') + (it.path || '') + (it.detail ? ' · ' + it.detail : '')));
      body.appendChild(row);
    }
  });
}

/* =====================================================================
   显式全局导出（2026-09-16 界面收敛）
   ---------------------------------------------------------------------
   新前端「系统 → 工具」区用 iframe 嵌 /legacy/index.html，再通过
   contentWindow.panelXxx() 跨帧拉起这些面板，避免重写 10 个已验证的实现。

   这些函数此前是**隐式全局**（页面作用域下的顶层 function 声明，
   浏览器自动挂到 window）—— 一旦有人把本文件包进 IIFE 或改成 module，
   就会静默失效，且失效方式是「点了没反应」这种最难查的形态。
   这里固化成显式契约。
   ===================================================================== */
window.panelHealth = panelHealth;
window.panelAudit = panelAudit;
window.panelJobs = panelJobs;
window.panelRecycle = panelRecycle;
window.panelDedup = panelDedup;
window.panelSearch = panelSearch;
window.panelVersions = panelVersions;
window.panelShares = panelShares;
/* panels2.js 依赖这个运行时（它自己也用了 openPanel/el/api/...） */
window.openPanel = openPanel;

/* =====================================================================
   就绪标记 —— 给跨帧调用方（新前端 LegacyPanel）判断「现在能调了吗」
   ---------------------------------------------------------------------
   背景（2026-09-16 手机端实测踩到，本机没复现）：
   index.html 的脚本顺序是 panels.js(317) → panels2.js(318) → shell.js(319)
   → app.js(320)。而本文件的 openPanel 用了 `el(...)`，el 是 app.js:19 的
   顶层 `const` —— 顶层 const 不挂 window，只活在**那一个脚本**的作用域里。

   旧界面自己碰不到这个坑：面板全靠用户点击触发，那时 app.js 早跑完了。
   新前端是 iframe 一 load 就调 panelHealth()，抢在 app.js 之前，
   于是 `typeof contentWindow.panelHealth === 'function'` 为真、
   但一调就炸 `ReferenceError: el is not defined`（openPanel 内）。

   ⚠️ 别在本文件里写 `window.el = el` —— 那会**立刻**炸同一个 ReferenceError：
      panels.js 与 app.js 是两个独立经典脚本，彼此的顶层 const 互不可见。
      这个标记必须由 app.js（el 的属主）自己去设，见 app.js 末尾。

   调用方（LegacyPanel.tsx）等 __legacyPanelsReady === true 才调面板。
   ===================================================================== */

'use strict';
/* panels2.js — v3 新面板：安全中心（2FA/ACL/配额） + 运维监控（监控/快照/巡检/分类/通知）
 * 依赖 app.js/panels.js 运行时：openPanel / el / api / jsonPost / toast / fmtSize / state / uiPrompt / uiConfirm
 */
/* global openPanel, el, api, jsonPost, toast, fmtSize, state, uiPrompt, uiConfirm */

/* ------------------------------ 安全中心 ------------------------------ */
async function panelSecurity() {
  openPanel('安全中心', async (body) => {
    /* --- 2FA --- */
    body.appendChild(el('div', 'panel-title', '两步验证（TOTP）'));
    let st = { enabled: false };
    try { st = await api('/api/totp/status'); } catch (e) { body.appendChild(el('div', 'err', e.message)); return; }
    const sec = el('div', 'panel-note', st.enabled ? '✅ 已启用：登录时需要输入 6 位动态验证码' : '未启用。启用后登录需要验证码（请先用验证器 App 扫码或手输密钥）');
    body.appendChild(sec);
    const b2 = el('div', 'panel-actions');
    if (!st.enabled) {
      const btn = el('button', 'btn primary', '启用两步验证');
      btn.onclick = async () => {
        try {
          const d = await jsonPost('/api/totp/setup', {});
          sec.textContent = '① 用验证器 App 添加以下密钥（手动输入或打开链接）\n' + d.secret;
          const link = el('a', '', '打开 otpauth 链接（需系统已注册验证器）');
          link.href = d.otpauth; link.target = '_blank'; link.style.cssText = 'display:block;margin:6px 0;word-break:break-all';
          sec.appendChild(link);
          const code = await uiPrompt('输入验证器显示的 6 位验证码', '', '123456');
          if (!code) return;
          await jsonPost('/api/totp/enable', { code: code.trim() });
          toast('两步验证已启用', 'ok');
          panelSecurity();
        } catch (e) { toast('启用失败：' + e.message); }
      };
      b2.appendChild(btn);
    } else {
      const btn = el('button', 'btn danger', '停用两步验证');
      btn.onclick = async () => {
        const code = await uiPrompt('停用两步验证', '', '输入当前 6 位验证码');
        if (!code) return;
        try {
          await jsonPost('/api/totp/disable', { code: code.trim() });
          toast('已停用', 'ok');
          panelSecurity();
        } catch (e) { toast(e.message); }
      };
      b2.appendChild(btn);
    }
    body.appendChild(b2);

    /* --- 盘级 ACL（管理员） --- */
    body.appendChild(el('div', 'panel-title', '盘级 ACL / 用户组（管理员）'));
    const aclNote = el('div', 'panel-note', '每个盘符：* = 默认；user:名字、group:组名 可单独授权；值 rw/ro/none；游客键为 guest。改坏会锁死自己，admin 不受限。');
    body.appendChild(aclNote);
    let aclData = null;
    try {
      const d = await api('/api/acl');
      aclData = d.data;
      if (d.users) aclNote.textContent += ' 可用用户：' + d.users.join('、');
    } catch (e) { body.appendChild(el('div', 'err', 'ACL 读取：' + e.message)); }
    if (aclData) {
      const ta = document.createElement('textarea');
      ta.value = JSON.stringify(aclData, null, 2);
      ta.style.cssText = 'width:100%;min-height:180px;font-family:Consolas,monospace;font-size:12px';
      body.appendChild(ta);
      const aclBtns = el('div', 'panel-actions');
      const save = el('button', 'btn primary', '保存 ACL');
      save.onclick = async () => {
        try {
          const data = JSON.parse(ta.value);
          await jsonPost('/api/acl', { data });
          toast('ACL 已保存', 'ok');
        } catch (e) { toast('保存失败：' + e.message); }
      };
      aclBtns.appendChild(save);
      body.appendChild(aclBtns);
    }

    /* --- 配额 --- */
    body.appendChild(el('div', 'panel-title', '容量配额'));
    try {
      const q = await api('/api/quota');
      for (const d of q.disks || []) {
        body.appendChild(el('div', 'panel-note', `${d.name}：已用 ${d.usedPct}%（${d.level === 'hard' ? '🔴 硬阈值' : d.level === 'soft' ? '🟡 软阈值' : '✅ 正常'}）`));
      }
      const row = el('div', 'panel-actions');
      const uin = document.createElement('input');
      uin.placeholder = '用户名'; uin.style.cssText = 'width:90px';
      const min = document.createElement('input');
      min.placeholder = '配额MB(0=不限)'; min.style.cssText = 'width:110px';
      const setBtn = el('button', 'btn', '设置用户配额');
      setBtn.onclick = async () => {
        try {
          await jsonPost('/api/quota', { username: uin.value.trim(), mb: Number(min.value) || 0 });
          toast('配额已保存', 'ok');
        } catch (e) { toast(e.message); }
      };
      row.appendChild(uin); row.appendChild(min); row.appendChild(setBtn);
      body.appendChild(row);
    } catch (e) { body.appendChild(el('div', 'err', '配额：' + e.message)); }
  });
}

/* ------------------------------ 运维监控 ------------------------------ */
async function panelOps() {
  openPanel('运维监控', async (body) => {
    const monBox = el('div', '');
    const refreshBtn = el('button', 'btn', '刷新监控');
    body.appendChild(el('div', 'panel-title', '资源监控'));
    const row = el('div', 'panel-actions'); row.appendChild(refreshBtn); body.appendChild(row);
    body.appendChild(monBox);
    const loadMon = async () => {
      monBox.textContent = '';
      try {
        const m = await api('/api/monitor');
        const line = (k, v) => el('div', 'panel-note', k + '：' + (v === null || v === undefined ? '—' : v));
        /* CPU：优先 monitor.cpuPct（/proc/stat 差值，Linux）；非 Linux 上那个恒 null，
           退到 snapshot 给的跨平台 cpuUsedPct（os.cpus() 差值）。两者都没有
           （第一次请求、还没攒出基线）才显「采样中」—— 不用「—」冒充读取失败。 */
        const cpuV = m.cpuPct != null ? m.cpuPct + '%'
          : (m.cpuUsedPct != null ? m.cpuUsedPct.toFixed(1) + '%（瞬时占用）' : '采样中…');
        monBox.appendChild(line('CPU', cpuV));
        /* ⚠️ memAvailable 已经是**字节**（Linux 走 /proc/meminfo 时 ×1024 换过，
           Windows 走 os.freemem() 本身就是字节）。这里**绝不能再乘 1024** ——
           乘了会把 2.0 GB 显示成 2.2 TB（真踩过，截图里一眼看出不对）。 */
        monBox.appendChild(line('内存', m.memUsedPct != null ? m.memUsedPct + '%（可用 ' + fmtSize(m.memAvailable || 0) + '）' : '—'));
        /* 网络：Linux 有 /proc/net/dev；Windows/macOS 上 Node 没有任何网卡字节计数
           API（os.networkInterfaces() 只给地址不给流量），这是平台能力缺口而非故障。
           显式说明「当前环境不支持」，别让一行「↓ — ↑ —」看起来像坏了。 */
        const netV = (m.netRxBps != null || m.netTxBps != null)
          ? '↓' + fmtSize(m.netRxBps || 0) + '/s ↑' + fmtSize(m.netTxBps || 0) + '/s'
          : (m.netSupported === false ? '当前环境不支持（非 Linux 无网卡字节计数）' : '采样中…');
        monBox.appendChild(line('网络', netV));
        monBox.appendChild(line('温度', (m.temps && m.temps.length) ? m.temps.map((x) => x + '℃').join(' / ') : '—'));
        monBox.appendChild(line('电池', m.battery ? (m.battery.pct != null ? m.battery.pct + '%' : '') + (m.battery.status ? '（' + m.battery.status + '）' : '') : '—'));
        /* 负载：有值就显示 —— loadavg 现在三平台都可能有（真 Linux 读
           /proc/loadavg；Android 走 os.loadavg()，实测真实值；Windows 上
           os.loadavg() 恒 [0,0,0]，服务端已按能力位判掉，不会传全零过来）。 */
        if (m.loadavg && m.loadavg.length && m.loadavg.some((x) => Number(x) > 0)) {
          monBox.appendChild(line('负载', m.loadavg.map((x) => Number(x).toFixed(2)).join(' ') + '（1/5/15 分钟）'));
        }
      } catch (e) { monBox.appendChild(el('div', 'err', e.message)); }
    };
    refreshBtn.onclick = loadMon;
    loadMon();

    /* --- 目录快照 --- */
    body.appendChild(el('div', 'panel-title', '目录快照（硬链接增量，存于盘内 .snapshots）'));
    const snapBox = el('div', '');
    body.appendChild(snapBox);
    const loadSnaps = async () => {
      snapBox.textContent = '';
      try {
        const d = await api('/api/snapshots?disk=' + encodeURIComponent(state.disk));
        const list = d.snapshots || [];
        if (!list.length) snapBox.appendChild(el('div', 'panel-note', '还没有快照'));
        for (const s of list) {
          const r = el('div', 'panel-actions');
          r.appendChild(el('span', 'panel-note', s.name + '（' + (s.entries || 0) + ' 项）'));
          const rb = el('button', 'btn', '恢复');
          rb.onclick = async () => {
            if (!(await uiConfirm('恢复快照', '把快照 ' + s.name + ' 的内容复制回当前盘？现盘文件会被覆盖为快照版本'))) return;
            try {
              const rr = await jsonPost('/api/snapshots', { disk: state.disk, action: 'restore', name: s.name });
              toast('已恢复 ' + (rr.restored || rr.entries || '') + ' 项', 'ok');
              loadList && loadList();
            } catch (e) { toast(e.message); }
          };
          r.appendChild(rb);
          snapBox.appendChild(r);
        }
      } catch (e) { snapBox.appendChild(el('div', 'err', e.message)); }
    };
    const snapBtns = el('div', 'panel-actions');
    const mk = el('button', 'btn primary', '立即快照');
    mk.onclick = async () => {
      try {
        const r = await jsonPost('/api/snapshots', { disk: state.disk, action: 'create' });
        toast('快照完成：' + (r.name || '') + '（' + (r.entries || 0) + ' 项' + (r.linkFallback ? '，含复制降级' : '') + '）', 'ok');
        loadSnaps();
      } catch (e) { toast(e.message); }
    };
    const daily = el('button', 'btn', '建每日快照任务');
    daily.onclick = async () => {
      try {
        await jsonPost('/api/jobs', { name: '每日快照 · ' + state.disk, type: 'snapshot', srcDisk: state.disk, schedule: 'daily' });
        toast('任务已创建（见「定时任务」）', 'ok');
      } catch (e) { toast(e.message); }
    };
    snapBtns.appendChild(mk); snapBtns.appendChild(daily);
    body.appendChild(snapBtns);
    body.appendChild(snapBox);
    loadSnaps();

    /* --- 完整性巡检 --- */
    body.appendChild(el('div', 'panel-title', '完整性巡检（SHA-256 清单）'));
    const scrubBtns = el('div', 'panel-actions');
    const build = el('button', 'btn primary', '建立基线');
    build.onclick = async () => {
      try { const r = await jsonPost('/api/scrub', { disk: state.disk, action: 'build' }); toast('基线完成：' + (r.files || 0) + ' 个文件', 'ok'); }
      catch (e) { toast(e.message); }
    };
    const verify = el('button', 'btn', '立即校验');
    verify.onclick = async () => {
      try {
        const r = await jsonPost('/api/scrub', { disk: state.disk, action: 'verify' });
        const bad = (r.corrupted || []).length + (r.missing || []).length;
        toast(bad ? '⚠️ 异常 ' + bad + ' 个（损坏 ' + (r.corrupted || []).length + ' / 缺失 ' + (r.missing || []).length + '）' : '✅ 全部一致（' + r.checked + ' 个）', bad ? undefined : 'ok');
      } catch (e) { toast(e.message); }
    };
    scrubBtns.appendChild(build); scrubBtns.appendChild(verify);
    body.appendChild(scrubBtns);

    /* --- 自动分类 --- */
    body.appendChild(el('div', 'panel-title', '自动整理（按类型/月份移动盘根散落文件）'));
    const clsBtns = el('div', 'panel-actions');
    const planBtn = el('button', 'btn', '预览');
    planBtn.onclick = async () => {
      try {
        const r = await jsonPost('/api/classify', { disk: state.disk, action: 'plan' });
        toast('将移动 ' + (r.plan || []).length + ' 个文件（详情看控制台/审计）');
        (r.plan || []).slice(0, 10).forEach((mv) => console.log('[classify]', mv.from, '→', mv.to));
      } catch (e) { toast(e.message); }
    };
    const applyBtn = el('button', 'btn danger', '执行整理');
    applyBtn.onclick = async () => {
      if (!(await uiConfirm('自动整理', '按规则把盘根散落的图片/视频/文档等移动到 分类/年-月/ 目录？'))) return;
      try {
        const r = await jsonPost('/api/classify', { disk: state.disk, action: 'apply' });
        toast('已移动 ' + r.moved + ' 个' + (r.failed ? '，失败 ' + r.failed : ''), 'ok');
        loadList && loadList();
      } catch (e) { toast(e.message); }
    };
    clsBtns.appendChild(planBtn); clsBtns.appendChild(applyBtn);
    body.appendChild(clsBtns);

    /* --- 通知 --- */
    body.appendChild(el('div', 'panel-title', '通知（盘掉线/容量/巡检 → Webhook）'));
    const noteBox = el('div', '');
    body.appendChild(noteBox);
    try {
      const d = await api('/api/notify');
      const ta = document.createElement('textarea');
      ta.value = JSON.stringify(d.cfg || {}, null, 2);
      ta.style.cssText = 'width:100%;min-height:140px;font-family:Consolas,monospace;font-size:12px';
      noteBox.appendChild(ta);
      const btns = el('div', 'panel-actions');
      const save = el('button', 'btn primary', '保存配置');
      save.onclick = async () => {
        try {
          await jsonPost('/api/notify', { data: JSON.parse(ta.value) });
          toast('通知配置已保存', 'ok');
        } catch (e) { toast(e.message); }
      };
      const test = el('button', 'btn', '发测试通知');
      test.onclick = async () => {
        try { await jsonPost('/api/notify', { action: 'test' }); toast('已触发（看各通道是否收到）', 'ok'); }
        catch (e) { toast(e.message); }
      };
      btns.appendChild(save); btns.appendChild(test);
      noteBox.appendChild(btns);
      if ((d.recent || []).length) {
        noteBox.appendChild(el('div', 'panel-note', '最近通知：'));
        for (const n of d.recent.slice(0, 5)) {
          noteBox.appendChild(el('div', 'panel-note', '· ' + n.title + ' — ' + (n.body || '').slice(0, 40)));
        }
      }
    } catch (e) { noteBox.appendChild(el('div', 'err', e.message)); }
  });
}

window.panelSecurity = panelSecurity;
window.panelOps = panelOps;

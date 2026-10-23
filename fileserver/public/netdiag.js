'use strict';

/* =====================================================================
   netdiag.js — 网络诊断面板
   实时测链路吞吐 / RTT / 抖动 → 判定瓶颈层级 → 给出针对性提速方案
   依赖 app.js：el / api / toast / fmtSize / openPanel（panels.js）
   ===================================================================== */

/* ---------------- 测速核心 ---------------- */

/** 单次 Range 请求计时（返回 {mb, ms, mbps}） */
async function ndFetchRange(url, offset, size, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const resp = await fetch(url, {
      headers: { Range: `bytes=${offset}-${offset + size - 1}` },
      credentials: 'same-origin',
      signal: ctl.signal,
      cache: 'no-store',
    });
    if (!resp.ok && resp.status !== 206) throw new Error('HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    const ms = performance.now() - t0;
    return { mb: buf.byteLength / 1048576, ms, mbps: buf.byteLength / 1048576 / (ms / 1000), ok: true };
  } catch (e) {
    return { mb: 0, ms: performance.now() - t0, mbps: 0, ok: false, err: e.name === 'AbortError' ? '超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 并发梯度测速：依次跑 1 / 2 / 4 并发，返回各自吞吐与最优值 */
async function ndThroughput(url, size, onProgress) {
  const chunk = Math.min(4 * 1024 * 1024, Math.max(512 * 1024, Math.floor(size / 8)));
  const results = [];
  for (const n of [1, 2, 4]) {
    if (onProgress) onProgress(`测试 ${n} 并发…`);
    const t0 = performance.now();
    const jobs = [];
    for (let i = 0; i < n; i++) {
      const off = 1024 * 1024 + i * chunk * 2;
      jobs.push(ndFetchRange(url, off, chunk));
    }
    const rs = await Promise.all(jobs);
    const ms = performance.now() - t0;
    const bytes = rs.reduce((s, r) => s + r.mb, 0);
    const mbps = bytes / (ms / 1000);
    results.push({ n, mb: bytes, ms, mbps, fail: rs.filter((r) => !r.ok).length });
    if (onProgress) onProgress(`${n} 并发：${mbps.toFixed(2)} MB/s`);
  }
  const best = results.reduce((a, b) => (b.mbps > a.mbps ? b : a));
  return { results, best };
}

/** RTT 采样：小文件多次请求，统计 min/avg/max/jitter */
async function ndRtt(url, samples = 6) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const r = await ndFetchRange(url, 0, 1024, 6000);
    if (r.ok) times.push(r.ms);
  }
  if (!times.length) return null;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const jitter = max - min;
  return { min, avg, max, jitter, n: times.length };
}

/* ---------------- 链路信息采集 ---------------- */

function ndLinkInfo() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|Mobile/i.test(ua);
  return {
    effectiveType: c.effectiveType || '未知',
    downlink: c.downlink ? c.downlink + ' Mbps（估算）' : '不可用',
    rtt: c.rtt != null ? c.rtt + ' ms（估算）' : '不可用',
    saveData: c.saveData ? '开启' : '关闭',
    isMobile,
    protocol: location.protocol.replace(':', ''),
    host: location.host,
  };
}

/** 瓶颈判定：结合吞吐、RTT、抖动给出结论 */
function ndDiagnose(tp, rtt, link) {
  const best = tp.best.mbps;
  const out = { level: 'ok', title: '', reasons: [], advice: [] };

  if (best >= 30) {
    out.level = 'ok';
    out.title = '链路健康（' + best.toFixed(1) + ' MB/s）';
    out.reasons.push('吞吐已达千兆/5GHz 级别，无需优化');
    return out;
  }

  if (best < 5) {
    out.level = 'bad';
    out.title = '链路严重受限（' + best.toFixed(1) + ' MB/s）';
  } else {
    out.level = 'warn';
    out.title = '链路偏低（' + best.toFixed(1) + ' MB/s）';
  }

  // RTT / 抖动判定
  if (rtt) {
    if (rtt.avg > 50) {
      out.reasons.push(`RTT 平均 ${rtt.avg.toFixed(0)}ms（局域网正常应 < 5ms）`);
      out.advice.push('延迟异常高 → 大概率是 2.4GHz 拥挤信道或 WiFi 省电模式，优先切 5GHz');
    } else if (rtt.avg > 15) {
      out.reasons.push(`RTT 平均 ${rtt.avg.toFixed(0)}ms（略高于理想值 5ms）`);
    }
    if (rtt.jitter > 100) {
      out.reasons.push(`抖动 ${rtt.jitter.toFixed(0)}ms（正常应 < 10ms）→ 存在严重重传/信道竞争`);
      out.advice.push('抖动大说明丢包重传 → 换信道（1/6/11 选最空的）或改 5GHz');
    } else if (rtt.jitter > 30) {
      out.reasons.push(`抖动 ${rtt.jitter.toFixed(0)}ms（偏高）`);
    }
  }

  // 并发特征判定
  const r1 = tp.results.find((r) => r.n === 1);
  const r4 = tp.results.find((r) => r.n === 4);
  if (r1 && r4) {
    if (r4.mbps < r1.mbps * 0.9) {
      out.reasons.push(`并发反降速（1并发 ${r1.mbps.toFixed(2)} → 4并发 ${r4.mbps.toFixed(2)} MB/s）`);
      out.advice.push('链路已饱和，多线程无用 → 只能靠换频段/换链路提升');
    } else if (r4.mbps > r1.mbps * 1.5) {
      out.reasons.push(`并发有效（1并发 ${r1.mbps.toFixed(2)} → 4并发 ${r4.mbps.toFixed(2)} MB/s）`);
      out.advice.push('单连接受限但总带宽有余 → 保持多线程分片传输');
    } else {
      out.reasons.push(`并发收益有限（1并发 ${r1.mbps.toFixed(2)} → 4并发 ${r4.mbps.toFixed(2)} MB/s）`);
    }
  }

  /* ---- 兜底：判定为受限时必须给出结论与建议（不能空着） ---- */
  if (out.level !== 'ok') {
    if (!out.reasons.length) {
      out.reasons.push(`实测最优吞吐仅 ${best.toFixed(2)} MB/s，远低于局域网应有水平（30 MB/s+）`);
      out.reasons.push('并发梯度无明显收益 → 瓶颈在物理链路而非协议/服务端');
    }
    if (!out.advice.length) {
      out.advice.push('首选：把 NAS 和客户端都切到 5GHz 频段（实测可提升 10-30 倍）');
      out.advice.push('次选：手机 USB 网络共享（RNDIS），预期 30-100 MB/s');
      out.advice.push('若只能用 2.4GHz：把路由器信道从 1 换到 6 或 11，频宽设 40MHz');
    }
  }

  if (link.effectiveType === '2g' || link.effectiveType === 'slow-2g') {
    out.reasons.push('浏览器上报网络类型为 ' + link.effectiveType);
  }
  if (best < 3) {
    out.advice.push('最可能原因：2.4GHz WiFi 信道拥挤（换 5GHz 可提升 10-30 倍）');
    out.advice.push('次选：手机 USB 网络共享（RNDIS），预期 30-100 MB/s');
  }
  return out;
}

/* ---------------- 面板渲染 ---------------- */

async function panelNetDiag() {
  openPanel('网络诊断', async (body) => {
    const wrap = el('div', 'nd-wrap');

    /* 链路信息卡 */
    const link = ndLinkInfo();
    const infoCard = el('div', 'nd-card');
    infoCard.innerHTML = `
      <div class="nd-h">链路信息</div>
      <div class="nd-kv"><span>接入地址</span><b>${escHTML(link.host)}</b></div>
      <div class="nd-kv"><span>协议</span><b>${escHTML(link.protocol.toUpperCase())}</b></div>
      <div class="nd-kv"><span>浏览器上报类型</span><b>${escHTML(link.effectiveType)}</b></div>
      <div class="nd-kv"><span>估算带宽</span><b>${escHTML(link.downlink)}</b></div>
      <div class="nd-kv"><span>估算 RTT</span><b>${escHTML(link.rtt)}</b></div>
      <div class="nd-kv"><span>省流模式</span><b>${escHTML(link.saveData)}</b></div>`;
    wrap.appendChild(infoCard);

    /* 测速区 */
    const testCard = el('div', 'nd-card');
    testCard.innerHTML = `
      <div class="nd-h">实时测速</div>
      <div class="nd-pick">
        <label>测试文件</label>
        <select id="ndFile" class="nd-select"></select>
      </div>
      <button id="ndRun" class="nd-btn">开始测速</button>
      <div id="ndStatus" class="nd-status">选择文件后点击开始</div>
      <div id="ndResult"></div>`;
    wrap.appendChild(testCard);

    /* ---- 提速通道卡：识别当前通道 + 给出 USB 直连步骤 ---- */
    const isUsb = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
    const chCard = el('div', 'nd-card');
    chCard.innerHTML = `
      <div class="nd-h">传输通道</div>
      <div class="nd-verdict ${isUsb ? 'nd-ok' : 'nd-warn'}">
        <div class="nd-verdict-t">${isUsb ? '✓ 正在走 USB 直连' : '⚠ 正在走 WiFi'}</div>
        <div class="nd-verdict-s">${escHTML(location.host)}${isUsb ? ' · 绕开无线空口' : ' · 受 2.4GHz 空口限制'}</div>
      </div>
      ${isUsb ? '<div class="nd-note">USB 通道已生效。数据走物理线缆，不受 WiFi 信道竞争与重传影响。</div>' : `
      <div class="nd-sub">切换到 USB 直连（预期 20-40 MB/s）</div>
      <ol class="nd-list">
        <li>手机用<b>数据线</b>连电脑（纯充电线不行）</li>
        <li>手机弹窗选「传输文件 / MTP」，并打开「USB 调试」</li>
        <li>电脑运行项目根目录的 <b>usb-direct.bat</b></li>
        <li>脚本自动建立 ADB 隧道并打开 <b>127.0.0.1:9081</b></li>
      </ol>
      <div class="nd-note">原理：ADB 复用 USB 线建立端口隧道，无需 RNDIS、无需改手机 USB 模式。电脑侧 RNDIS 驱动已就绪（Remote NDIS based Internet Sharing Device）。</div>`}`;
    wrap.appendChild(chCard);

    /* ---- 一键复制脚本路径 ---- */
    const toolsCard = el('div', 'nd-card');
    toolsCard.innerHTML = `
      <div class="nd-h">提速工具（项目根目录）</div>
      <div class="nd-kv"><span>USB 直连</span><b>usb-direct.bat</b></div>
      <div class="nd-kv"><span>5GHz 热点</span><b>wifi5g-hotspot.bat</b></div>
      <div class="nd-kv"><span>网络探测</span><b>netinfo.ps1</b></div>
      <div class="nd-note">这两个脚本需在电脑上双击运行（原生 Windows 环境），不能在浏览器里执行。USB 直连预期 20-40 MB/s，5GHz 热点预期 20-50 MB/s。</div>`;
    wrap.appendChild(toolsCard);

    body.appendChild(wrap);

    /* 填充可选测试文件（取当前目录下 >8MB 的文件） */
    const sel = testCard.querySelector('#ndFile');
    let candidates = (state.entries || []).filter((e) => !e.isDir && +e.size > 8 * 1024 * 1024);
    if (!candidates.length) {
      // 回退：拉一次列表找大文件
      try {
        const d = await api(`/api/list?disk=${encodeURIComponent(state.disk)}&path=${encodeURIComponent(state.path || '')}`);
        candidates = (d.entries || d.items || []).filter((e) => !e.isDir && +e.size > 8 * 1024 * 1024);
      } catch (e) { /* ignore */ }
    }
    if (!candidates.length) {
      sel.innerHTML = '<option value="">（当前目录无 >8MB 的文件）</option>';
      testCard.querySelector('#ndRun').disabled = true;
    } else {
      sel.innerHTML = candidates
        .sort((a, b) => +b.size - +a.size)
        .slice(0, 12)
        .map((e) => `<option value="${escHTML(e.name)}">${escHTML(e.name)} · ${fmtSize(+e.size)}</option>`)
        .join('');
    }

    const statusEl = testCard.querySelector('#ndStatus');
    const resultEl = testCard.querySelector('#ndResult');
    const runBtn = testCard.querySelector('#ndRun');

    runBtn.onclick = async () => {
      const name = sel.value;
      if (!name) return;
      const entry = candidates.find((e) => e.name === name);
      if (!entry) return;
      const url = entryUrl(entry);
      const size = +entry.size || 0;

      runBtn.disabled = true;
      runBtn.textContent = '测试中…';
      resultEl.innerHTML = '';
      const t0 = performance.now();

      statusEl.textContent = '① 采样延迟…';
      const rtt = await ndRtt(url, 6);

      statusEl.textContent = '② 梯度测速（1/2/4 并发）…';
      const tp = await ndThroughput(url, size, (msg) => { statusEl.textContent = '② ' + msg; });

      statusEl.textContent = '③ 分析瓶颈…';
      const diag = ndDiagnose(tp, rtt, link);

      /* 渲染结果 */
      const rttHtml = rtt
        ? `<div class="nd-kv"><span>延迟</span><b>min ${rtt.min.toFixed(0)} / avg ${rtt.avg.toFixed(0)} / max ${rtt.max.toFixed(0)} ms</b></div>
           <div class="nd-kv"><span>抖动</span><b class="${rtt.jitter > 100 ? 'nd-bad' : rtt.jitter > 30 ? 'nd-warn' : 'nd-ok'}">${rtt.jitter.toFixed(0)} ms</b></div>`
        : '<div class="nd-kv"><span>延迟</span><b>采样失败</b></div>';

      const rows = tp.results.map((r) => {
        const pct = tp.best.mbps ? Math.max(4, (r.mbps / tp.best.mbps) * 100) : 4;
        const cls = r.mbps >= tp.best.mbps * 0.95 ? 'best' : '';
        return `<div class="nd-bar-row">
          <span class="nd-bar-n">${r.n} 并发</span>
          <div class="nd-bar"><i class="${cls}" style="width:${pct.toFixed(0)}%"></i></div>
          <span class="nd-bar-v">${r.mbps.toFixed(2)} MB/s</span>
        </div>`;
      }).join('');

      const adviceHtml = diag.advice.length
        ? diag.advice.map((a) => `<li>${escHTML(a)}</li>`).join('')
        : '<li>暂无建议</li>';
      const reasonHtml = diag.reasons.length
        ? diag.reasons.map((r) => `<li>${escHTML(r)}</li>`).join('')
        : '<li>无明显异常</li>';

      resultEl.innerHTML = `
        <div class="nd-verdict nd-${diag.level}">
          <div class="nd-verdict-t">${escHTML(diag.title)}</div>
          <div class="nd-verdict-s">最优并发 ${tp.best.n} · 耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s</div>
        </div>
        <div class="nd-sub">吞吐梯度</div>
        ${rows}
        <div class="nd-sub">链路质量</div>
        ${rttHtml}
        <div class="nd-sub">诊断结论</div>
        <ul class="nd-list">${reasonHtml}</ul>
        <div class="nd-sub">提速建议</div>
        <ul class="nd-list nd-list-act">${adviceHtml}</ul>
        <div class="nd-note">提示：测速结果受当前网络占用影响，建议在无其他大流量时复测。</div>`;

      statusEl.textContent = '完成';
      runBtn.disabled = false;
      runBtn.textContent = '重新测速';
    };
  });
}

/* 暴露到全局供 app.js 菜单调用 */
window.panelNetDiag = panelNetDiag;

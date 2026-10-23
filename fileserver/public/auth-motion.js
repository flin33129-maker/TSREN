'use strict';
/* auth-motion.js — 登录卡片鲸群粒子网络动画 + 时钟 + 文案联动
 * 零依赖 canvas；prefers-reduced-motion 或移动端自动降级
 */
(function () {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = document.getElementById('auCanvas');
  const clockEl = document.getElementById('auClock');
  const helloEl = document.getElementById('auHello');
  const helloSub = document.getElementById('auHelloSub');

  /* 时钟（等宽） */
  if (clockEl) {
    const tick = () => {
      const d = new Date();
      clockEl.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((n) => String(n).padStart(2, '0')).join(':');
    };
    tick();
    setInterval(tick, 1000);
  }

  /* tab 切换时问候语联动（监听 .tab.active 变化，不动 app.js） */
  const tabsBox = document.querySelector('.au-tabs');
  if (tabsBox && helloEl) {
    const apply = () => {
      const active = tabsBox.querySelector('.tab.active');
      const isLogin = active && active.dataset.tab === 'login';
      helloEl.textContent = isLogin ? '欢迎回来' : '加入深海站';
      if (helloSub) helloSub.textContent = isLogin ? '登录以访问你的私人空间' : '注册一个账号，30 秒开通';
    };
    const mo = new MutationObserver(apply);
    mo.observe(tabsBox, { subtree: true, attributes: true, attributeFilter: ['class'] });
    apply();
  }

  /* 鲸群粒子网络：仅桌面且未开启减弱动效时运行 */
  if (!canvas || reduced || matchMedia('(max-width: 760px)').matches) return;

  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dots = [], raf = 0, running = false;
  const N = 42;          // 粒子数（鲸群）
  const LINK = 130;      // 连线距离

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    W = canvas.width = Math.max(1, r.width * devicePixelRatio);
    H = canvas.height = Math.max(1, r.height * devicePixelRatio);
  }
  function spawn() {
    dots = Array.from({ length: N }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.35 * devicePixelRatio,
      vy: (Math.random() - 0.5) * 0.35 * devicePixelRatio,
      r: (Math.random() * 1.6 + 0.8) * devicePixelRatio,
      ph: Math.random() * Math.PI * 2,           // 呼吸相位
    }));
  }
  function frame(t) {
    if (!running) return;
    ctx.clearRect(0, 0, W, H);
    for (const p of dots) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20;
    }
    /* 网络连线 */
    ctx.lineWidth = 0.7 * devicePixelRatio;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const a = dots[i], b = dots[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK * devicePixelRatio * devicePixelRatio) {
          const alpha = (1 - Math.sqrt(d2) / (LINK * devicePixelRatio)) * 0.28;
          ctx.strokeStyle = 'rgba(53,224,214,' + alpha.toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    /* 粒子本体（呼吸发光） */
    for (const p of dots) {
      const glow = 0.5 + 0.5 * Math.sin(t / 900 + p.ph);
      ctx.fillStyle = 'rgba(53,224,214,' + (0.35 + glow * 0.45).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.85 + glow * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (running) return;
    running = true;
    resize(); spawn();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  /* 登录弹窗打开时才运行，省电 */
  const modal = document.getElementById('authModal');
  if (modal) {
    const mo = new MutationObserver(() => {
      if (modal.hidden) stop();
      else start();
    });
    mo.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    if (!modal.hidden) start();
  }
  addEventListener('resize', () => { if (running) { resize(); spawn(); } });
})();

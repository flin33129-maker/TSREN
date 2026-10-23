/**
 * 统一主题引导 —— 让所有子页面跟随主面板的浅色/深色选择
 *
 * 主面板用 html[data-theme=light|dark] 控制，不写 localStorage；
 * 这里通过 MutationObserver 把主面板的选择镜像到 localStorage['ds-theme']，
 * 子页面启动时读这个键，没读过就退回系统偏好。
 */
(function () {
  var KEY = 'ds-theme';

  function sysPref() {
    try {
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }

  function apply(t) {
    if (t !== 'light' && t !== 'dark') t = sysPref();
    document.documentElement.setAttribute('data-theme', t);
  }

  /* 1) 立即应用（避免闪白/闪黑） */
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  apply(saved || sysPref());

  /* 2) 其他页面改了主题时同步 */
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) apply(e.newValue);
  });

  /* 3) 如果本页自己会改 data-theme（例如主面板），镜像到 localStorage */
  try {
    new MutationObserver(function () {
      var t = document.documentElement.getAttribute('data-theme');
      if (t === 'light' || t === 'dark') {
        try {
          if (localStorage.getItem(KEY) !== t) localStorage.setItem(KEY, t);
        } catch (e) {}
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) {}

  /* 4) 暴露给页面用 */
  window.dsTheme = {
    get: function () { return document.documentElement.getAttribute('data-theme') || sysPref(); },
    set: function (t) {
      apply(t);
      try { localStorage.setItem(KEY, t); } catch (e) {}
    }
  };
})();

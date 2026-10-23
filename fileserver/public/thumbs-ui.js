'use strict';
/* thumbs-ui.js — 前端缩略图引擎
 * 服务端零依赖无法解码图像 → 前端 Canvas 生成 256px WebP 上传缓存。
 * 流程：先取 /api/thumbs?key= → 404 时回退原图并后台生成上传（下次秒开）。
 * 依赖 app.js 全局：state / entryUrl / el
 */
(function () {
  /* 紧凑 SHA-1（http 非安全上下文没有 crypto.subtle，纯 JS 实现兜底） */
  function sha1hex(s) {
    function rol(n, x) { return ((n << x) | (n >>> (32 - x))) | 0; }
    let msg;
    try { msg = unescape(encodeURIComponent(s)); } catch (e) { msg = String(s); }
    const ml = msg.length;
    const w = [];
    for (let i = 0; i < ml; i++) w[i >> 2] = (w[i >> 2] || 0) | (msg.charCodeAt(i) << ((3 - (i & 3)) << 3));
    w[ml >> 2] = (w[ml >> 2] || 0) | (0x80 << ((3 - (ml & 3)) << 3));
    const nBlocks = (((ml + 8) >> 6) + 1) << 4;
    for (let i = w.length || 0; i < nBlocks; i++) w[i] = 0;
    w[nBlocks - 1] = ml * 8;
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const bin = new Array(80);
    for (let i = 0; i < nBlocks; i += 16) {
      for (let j = 0; j < 16; j++) bin[j] = w[i + j] | 0;
      for (let j = 16; j < 80; j++) bin[j] = rol(bin[j - 3] ^ bin[j - 8] ^ bin[j - 14] ^ bin[j - 16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const t = (rol(a, 5) + f + e + k + (bin[j] | 0)) | 0;
        e = d; d = c; c = rol(b, 30); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  async function generate(key, url) {
    try {
      if (!window.createImageBitmap || !window.OffscreenCanvas) return;
      const r = await fetch(url);
      if (!r.ok) return;
      const blob = await r.blob();
      if (blob.size > 24 * 1024 * 1024) return;
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, 256 / Math.max(bmp.width || 1, bmp.height || 1));
      const cw = Math.max(1, Math.round((bmp.width || 256) * scale));
      const ch = Math.max(1, Math.round((bmp.height || 256) * scale));
      const cv = new OffscreenCanvas(cw, ch);
      cv.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
      const out = await cv.convertToBlob({ type: 'image/webp', quality: 0.8 });
      bmp.close && bmp.close();
      if (!out || out.size > 200 * 1024) return;
      await fetch('/api/thumbs?key=' + key, { method: 'POST', body: out });
    } catch (e) { /* 静默：缩略图失败不影响浏览 */ }
  }

  /* app.js 列表/网格图片入口：先缩略图 → 404 回退原图并后台生成 */
  window.nasThumb = function (img, it, fallbackFactory) {
    try {
      const rel = (state.path ? state.path + '/' : '') + it.name;
      const key = sha1hex(state.disk + '|' + rel + '|' + it.mtime);
      const orig = entryUrl(it);
      let stage = 0;
      img.onerror = () => {
        if (stage === 0) {
          stage = 1;
          img.src = orig;
          if (state.user) generate(key, orig);
        } else {
          try { img.replaceWith(fallbackFactory()); } catch (e) {}
        }
      };
      img.src = '/api/thumbs?key=' + key;
    } catch (e) {
      img.src = entryUrl(it);
    }
  };
})();

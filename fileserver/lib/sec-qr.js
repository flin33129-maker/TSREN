'use strict';

/* =====================================================================
   lib/sec-qr.js — 零依赖 QR 码生成（Byte 模式，纠错等级 M，版本 1~10）
   ---------------------------------------------------------------------
   为什么自己写：
     2FA 页面必须能把 otpauth:// 链接变成**可扫的二维码**，但仓库纪律
     禁止引 CDN / 来源不明的第三方 JS，服务端也没装 qrcode 依赖。
     于是这里按 ISO/IEC 18004 实现一个最小可用编码器（160 行），
     只支持 Byte 8bit + EC-M + 版本 1~10 —— otpauth URI 最长 ~150 字节，
     版本 8(M=152B) 足够，留到 10 只是余量。

   正确性验证（写进验收报告）：
     用 Python 的 qrcode 库生成同一份数据 / 同一版本 / **同一掩码** 的
     参考矩阵，与本模块输出逐模块比对，必须完全一致。
   ===================================================================== */

/* 纠错等级 M 的分块参数：ec=每块纠错码字数，g1/g2=[块数, 每块数据码字数] */
const SPEC_M = {
  1: { ec: 10, g1: [1, 16], g2: null, total: 26 },
  2: { ec: 16, g1: [1, 28], g2: null, total: 44 },
  3: { ec: 26, g1: [1, 44], g2: null, total: 70 },
  4: { ec: 18, g1: [2, 32], g2: null, total: 100 },
  5: { ec: 24, g1: [2, 43], g2: null, total: 134 },
  6: { ec: 16, g1: [4, 27], g2: null, total: 172 },
  7: { ec: 18, g1: [4, 31], g2: null, total: 196 },
  8: { ec: 22, g1: [2, 38], g2: [2, 39], total: 242 },
  9: { ec: 22, g1: [3, 36], g2: [2, 37], total: 292 },
  10: { ec: 26, g1: [4, 43], g2: [1, 44], total: 346 },
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* ------------------------------ GF(256) ------------------------------ */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (!a || !b) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成 n 次 RS 多项式，返回长度 n+1、首项为 1 的系数数组 */
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

/** 对 data（字节数组）计算 n 个纠错码字 */
function rsEncode(data, n) {
  const g = rsGenerator(n);
  const scratch = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ scratch[0];
    scratch.copyWithin(0, 1);
    scratch[n - 1] = 0;
    if (factor) {
      for (let i = 0; i < n; i++) scratch[i] ^= gfMul(g[i + 1], factor);
    }
  }
  return scratch;
}

/* ------------------------------ 编码 ------------------------------ */

function dataCodewords(version) {
  const s = SPEC_M[version];
  const g2 = s.g2 ? s.g2[0] * s.g2[1] : 0;
  return s.g1[0] * s.g1[1] + g2;
}

function byteCapacity(version) {
  const bits = dataCodewords(version) * 8;
  const overhead = 4 + (version <= 9 ? 8 : 16);
  return Math.floor((bits - overhead) / 8);
}

function pushBits(arr, value, length) {
  for (let i = length - 1; i >= 0; i--) arr.push((value >>> i) & 1);
}

/** 数据 → 码字（含模式/长度/终止符/填充） */
function encodeData(bytes, version) {
  const capBytes = byteCapacity(version);
  if (bytes.length > capBytes) throw new Error('数据过长（' + bytes.length + ' > ' + capBytes + ' 字节）');
  const bits = [];
  pushBits(bits, 0b0100, 4);                                   // Byte 模式
  pushBits(bits, bytes.length, version <= 9 ? 8 : 16);         // 字符计数
  for (const b of bytes) pushBits(bits, b, 8);
  const capacityBits = dataCodewords(version) * 8;
  pushBits(bits, 0, Math.min(4, capacityBits - bits.length));   // 终止符
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    words.push(b);
  }
  let pad = 0;
  while (words.length < dataCodewords(version)) {
    words.push(pad % 2 === 0 ? 0xec : 0x11);
    pad++;
  }
  return words;
}

/** 分块 + RS + 交织，返回最终码字序列 */
function makeCodewords(bytes, version) {
  const spec = SPEC_M[version];
  const data = encodeData(bytes, version);
  const blocks = [];
  let off = 0;
  const g1n = spec.g1[0], g1d = spec.g1[1];
  for (let i = 0; i < g1n; i++) {
    blocks.push({ data: data.slice(off, off + g1d), ec: null });
    off += g1d;
  }
  if (spec.g2) {
    for (let i = 0; i < spec.g2[0]; i++) {
      blocks.push({ data: data.slice(off, off + spec.g2[1]), ec: null });
      off += spec.g2[1];
    }
  }
  for (const b of blocks) b.ec = rsEncode(b.data, spec.ec);
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  const out = [];
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

/* ------------------------------ 矩阵 ------------------------------ */

function bchFormat(mask) {
  const data = (0 << 3) | mask;      // EC 等级 M 的格式位 = 0b00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function bchVersion(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((version << 12) | rem) & 0x3ffff;
}

function bitOf(value, i) { return ((value >>> i) & 1) !== 0; }

function maskFn(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

function penalty(modules, size) {
  let score = 0;
  // 规则 1：同色连续 ≥5
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === modules[y][x - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === modules[y - 1][x]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // 规则 2：2x2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  // 规则 3：类定位图形 1:1:3:1:1
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matchAt = (get, start) => {
    let a = true, b = true;
    for (let k = 0; k < 11; k++) {
      const v = get(start + k);
      if (v !== pat1[k]) a = false;
      if (v !== pat2[k]) b = false;
    }
    return a || b;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 11; x++) {
      if (matchAt((i) => modules[y][i], x)) score += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 11; y++) {
      if (matchAt((i) => modules[i][x], y)) score += 40;
    }
  }
  // 规则 4：黑块比例
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  const total = size * size;
  const pct = (dark * 100) / total;
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

function buildMatrix(codewords, version, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunc = (x, y, dark) => {
    modules[y][x] = dark;
    isFunc[y][x] = true;
  };

  // 定位图形 + 分隔符
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunc(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // 定时图形
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // 校正图形
  for (const cy of ALIGN[version]) {
    for (const cx of ALIGN[version]) {
      // 跳过与三个定位图形重合的位置
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunc(cx + dx, cy + dy, dist !== 1);
        }
      }
    }
  }

  // 固定深色模块
  setFunc(8, size - 8, true);

  // 预留格式信息区
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { setFunc(8, i, false); setFunc(i, 8, false); }
  }
  for (let i = 0; i < 8; i++) {
    setFunc(size - 1 - i, 8, false);
    setFunc(8, size - 1 - i, false);
  }

  // 版本信息区（v≥7）
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, false);
      setFunc(b, a, false);
    }
  }

  // 数据放置（右→左两列一组，蛇形）
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunc[y][x]) continue;
        if (bitIdx < totalBits) {
          const byte = codewords[bitIdx >>> 3];
          modules[y][x] = ((byte >>> (7 - (bitIdx & 7))) & 1) !== 0;
          bitIdx++;
        }
      }
    }
  }

  // 掩码
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunc[y][x] && maskFn(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  }

  // 格式信息
  const fmt = bchFormat(mask);
  for (let i = 0; i <= 5; i++) modules[i][8] = bitOf(fmt, i);
  modules[7][8] = bitOf(fmt, 6);
  modules[8][8] = bitOf(fmt, 7);
  modules[8][7] = bitOf(fmt, 8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bitOf(fmt, i);
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bitOf(fmt, i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bitOf(fmt, i);
  modules[size - 8][8] = true;

  // 版本信息
  if (version >= 7) {
    const ver = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const bit = bitOf(ver, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      modules[b][a] = bit;
      modules[a][b] = bit;
    }
  }

  return modules;
}

/** 生成 QR：返回 {version, size, mask, matrix(0/1 字符串数组), moduleCount} */
function encode(text) {
  const bytes = Buffer.from(String(text == null ? '' : text), 'utf8');
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (bytes.length <= byteCapacity(v)) { version = v; break; }
  }
  if (!version) throw new Error('内容过长，超出本编码器支持范围（最大 213 字节）');
  const codewords = makeCodewords(bytes, version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = buildMatrix(codewords, version, mask);
    const score = penalty(modules, version * 4 + 17);
    if (!best || score < best.score) best = { mask, modules, score };
  }
  const size = version * 4 + 17;
  const matrix = best.modules.map((row) => row.map((c) => (c ? '1' : '0')).join(''));
  return { version, size, mask: best.mask, matrix };
}

/** 生成 SVG（含 4 模块静默区，可用 CSS 变量控制颜色） */
function toSvg(qr, opts = {}) {
  const scale = opts.scale || 4;
  const border = opts.border == null ? 4 : opts.border;
  const dim = (qr.size + border * 2) * scale;
  const rects = [];
  for (let y = 0; y < qr.size; y++) {
    const row = qr.matrix[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '1') {
        rects.push('<rect x="' + ((x + border) * scale) + '" y="' + ((y + border) * scale)
          + '" width="' + scale + '" height="' + scale + '"/>');
      }
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim
    + '" viewBox="0 0 ' + dim + ' ' + dim + '" role="img" aria-label="2FA 二维码">'
    + '<rect width="100%" height="100%" fill="#ffffff"/>'
    + '<g fill="#000000">' + rects.join('') + '</g></svg>';
}

module.exports = { encode, toSvg, byteCapacity, SPEC_M };

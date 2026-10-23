'use strict';

/* =====================================================================
   lib/meta.js — 媒体元数据解析（纯 Buffer 手写解析，零依赖）
   ─────────────────────────────────────────────────────────────────────
   手机 Termux 零依赖环境没有 ffmpeg/exiftool，这里用纯字节解析：
   - JPEG: APP1 Exif → TIFF IFD0 / ExifIFD / GPS IFD + SOF 标记尺寸
   - MP4:  顶层 box 扫描 → mvhd(时长) / tkhd(宽高) / ftyp(品牌)
   - ID3:  v2.3/2.4 文本帧 + 尾部 ID3v1 兜底
   接口约定：
   - parseJpegExif(buf)              同步，传文件头部 Buffer 即可
   - parseMp4(read, fileSize)        异步，read(offset,len)→Promise<Buffer>，
                                     便于大文件只读需要的片段
   - parseId3(buf)                   同步，传头部 Buffer（含尾部判断需整文件）
   - detectKind(filename)            按扩展名分类
   ===================================================================== */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 9: 4, 10: 8 }; // TIFF 类型字节数

/* ============================== JPEG / EXIF ============================== */

/**
 * TIFF 字节序读取器：II=小端 / MM=大端
 * @returns {{u16:(o:number)=>number, u32:(o:number)=>number}}
 */
function tiffReader(tiff) {
  const le = tiff.slice(0, 2).toString('latin1') === 'II';
  return {
    u16: (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)),
    u32: (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)),
    i32: (o) => (le ? tiff.readInt32LE(o) : tiff.readInt32BE(o)),
  };
}

/** 读取一个 IFD 条目的值（值 ≤4 字节内联在条目里，否则为偏移量） */
function readTagValue(tiff, R, entryOff) {
  const type = R.u16(entryOff + 2);
  const count = R.u32(entryOff + 4);
  const tsize = TYPE_SIZE[type];
  if (!tsize || count <= 0 || count > 4096) return { type, values: [] };
  const total = tsize * count;
  let voff;
  if (total <= 4) voff = entryOff + 8;                     // 内联
  else { voff = R.u32(entryOff + 8); if (voff + total > tiff.length) return { type, values: [] }; }

  const values = [];
  for (let i = 0; i < count; i++) {
    const o = voff + i * tsize;
    if (o + tsize > tiff.length) break;
    switch (type) {
      case 1: case 2: values.push(tiff[o]); break;          // BYTE / ASCII 单字节
      case 3: values.push(R.u16(o)); break;                 // SHORT
      case 4: values.push(R.u32(o)); break;                 // LONG
      case 5: case 10: {                                    // (S)RATIONAL num/den
        const num = type === 5 ? R.u32(o) : R.i32(o);
        const den = R.u32(o + 4);
        values.push(den ? num / den : 0);
        break;
      }
      case 9: values.push(R.u32(o) | 0); break;             // SLONG（借位运算转有符号）
      default: return { type, values: [] };
    }
  }
  if (type === 2) {
    // ASCII：把字节序列转字符串并去掉结尾 NUL
    let s = '';
    for (const b of values) { if (b === 0) break; s += String.fromCharCode(b); }
    return { type, text: s };
  }
  return { type, values };
}

/**
 * 解析 JPEG Buffer 中的 EXIF + SOF 尺寸
 * @returns {{make,model,dateTime,orientation,width,height,gps:{lat,lon}|null}}
 */
function parseJpegExif(buf) {
  const out = { make: null, model: null, dateTime: null, orientation: null, width: null, height: null, gps: null };
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return out;

  // ---- 1) 尺寸：优先 SOF 标记（0xFFC0/C1/C2...，排除 DHT/JPG/DAC） ----
  try {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }               // 填充字节
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; } // 无长度段
      if (marker === 0xda) break;                           // SOS：后面是熵编码数据
      if (i + 4 > buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        out.height = buf.readUInt16BE(i + 5);               // SOF: 精度u8 + 高u16 + 宽u16
        out.width = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
  } catch { /* 尺寸解析失败不致命 */ }

  // ---- 2) EXIF：APP1 段 'Exif\0\0' → TIFF ----
  try {
    let i = 2;
    let tiff = null;
    while (i + 4 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xda) break;
      if (i + 4 > buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xe1 && buf.slice(i + 4, i + 8).toString('ascii') === 'Exif') {
        tiff = buf.slice(i + 10, i + 2 + len);              // 跳过长度2 + 'Exif\0\0'6
        break;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      if (len < 2) break;
      i += 2 + len;
    }
    if (!tiff || tiff.length < 8) return out;

    const R = tiffReader(tiff);
    if (R.u16(2) !== 0x2a) return out;                      // TIFF 魔数 42
    let ifd = R.u32(4);                                     // IFD0 偏移

    // 遍历 IFD 的通用循环：处理 IFD0 →（可选）ExifIFD / GPS IFD
    const visited = new Set();
    const dirs = [{ off: ifd, kind: 'ifd0' }];
    while (dirs.length) {
      const { off: dOff, kind } = dirs.shift();
      if (visited.has(dOff) || dOff + 2 > tiff.length) continue;
      visited.add(dOff);
      const count = R.u16(dOff);
      if (count > 512) continue;
      for (let e = 0; e < count; e++) {
        const eo = dOff + 2 + e * 12;
        if (eo + 12 > tiff.length) break;
        const tag = R.u16(eo);
        if (kind === 'ifd0') {
          if (tag === 0x010f) out.make = readTagValue(tiff, R, eo).text || null;
          else if (tag === 0x0110) out.model = readTagValue(tiff, R, eo).text || null;
          else if (tag === 0x0132) out.dateTime = readTagValue(tiff, R, eo).text || null;
          else if (tag === 0x0112) { const v = readTagValue(tiff, R, eo).values[0]; if (v) out.orientation = v; }
          else if (tag === 0x8769) dirs.push({ off: R.u32(eo + 8) && readTagValue(tiff, R, eo).values[0] || 0, kind: 'exif' });
          else if (tag === 0x8825) dirs.push({ off: readTagValue(tiff, R, eo).values[0] || 0, kind: 'gps' });
        } else if (kind === 'exif') {
          // ExifIFD：像素尺寸兜底（SOF 缺失时，如部分相机直出）
          if (tag === 0xa002 && out.width == null) { const v = readTagValue(tiff, R, eo).values[0]; if (v) out.width = v; }
          else if (tag === 0xa003 && out.height == null) { const v = readTagValue(tiff, R, eo).values[0]; if (v) out.height = v; }
        } else if (kind === 'gps') {
          if (tag === 0x0001) out._latRef = readTagValue(tiff, R, eo).text || '';
          else if (tag === 0x0002) out._lat = readTagValue(tiff, R, eo).values;
          else if (tag === 0x0003) out._lonRef = readTagValue(tiff, R, eo).text || '';
          else if (tag === 0x0004) out._lon = readTagValue(tiff, R, eo).values;
        }
      }
    }
    // GPS 度分秒 → 十进制；S/W 为负
    if (Array.isArray(out._lat) && out._lat.length === 3 && Array.isArray(out._lon) && out._lon.length === 3) {
      let lat = out._lat[0] + out._lat[1] / 60 + out._lat[2] / 3600;
      let lon = out._lon[0] + out._lon[1] / 60 + out._lon[2] / 3600;
      if (/S/i.test(out._latRef || '')) lat = -lat;
      if (/W/i.test(out._lonRef || '')) lon = -lon;
      out.gps = { lat, lon };
    }
    delete out._latRef; delete out._lat; delete out._lonRef; delete out._lon;
  } catch { /* EXIF 解析失败不致命 */ }

  return out;
}

/* ================================ MP4 ================================ */

/** 读取 moov box 的最大字节数（防异常超大 box 撑爆内存） */
const MAX_MOOV_READ = 8 * 1024 * 1024;

/**
 * 在一段 Buffer 内扫描 box 列表
 * @returns {Array<{type:string, off:number, size:number}>}
 */
function scanBufBoxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    if (size === 1) {                                        // 64bit largesize
      if (off + 16 > end) break;
      const large = buf.readBigUInt64BE(off + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
    } else if (size === 0) size = end - off;                 // 0 = 到末尾
    if (size < 8) break;                                     // 非法
    out.push({ type, off, size });
    off += size;
  }
  return out;
}

/** 16.16 定点数 → 整数，合理性校验（视频宽高一般在 16~8192） */
function fixed16(v) {
  const n = Math.round(v / 65536);
  return n >= 16 && n <= 8192 ? n : null;
}

/**
 * 解析 MP4：durationSec / width / height / brand
 * @param {(offset:number, len:number)=>Promise<Buffer>} read 分段读取器
 * @param {number} fileSize 文件总大小
 */
async function parseMp4(read, fileSize) {
  const out = { durationSec: null, width: null, height: null, brand: null };
  if (!fileSize || fileSize < 16) return out;

  // ---- brand：ftyp 的 major brand ----
  try {
    const head = await read(0, Math.min(32, fileSize));
    if (head.length >= 12 && head.slice(4, 8).toString('latin1') === 'ftyp') {
      out.brand = head.slice(8, 12).toString('latin1').replace(/[\0\s]/g, '');
    }
  } catch { /* 忽略 */ }

  // ---- 顶层 box 扫描找 moov ----
  let moov = null;
  try {
    let off = 0;
    while (off + 8 <= fileSize) {
      const head = await read(off, 16);
      if (head.length < 8) break;
      let size = head.readUInt32BE(0);
      const type = head.slice(4, 8).toString('latin1');
      if (size === 1) {
        if (head.length < 16) break;
        const large = head.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
        size = Number(large);
      } else if (size === 0) size = fileSize - off;
      if (size < 8) break;
      if (type === 'moov') {
        moov = await read(off + 8, Math.min(size - 8, MAX_MOOV_READ));
        break;
      }
      off += size;
    }
  } catch { /* 扫描失败走尾部兜底 */ }

  // ---- 兜底：moov 在文件尾（流式录制文件常见）→ 读尾部 256KB 搜 'moov' ----
  if (!moov) {
    try {
      const tailLen = Math.min(256 * 1024, fileSize);
      const tail = await read(fileSize - tailLen, tailLen);
      const idx = tail.indexOf('moov');
      if (idx >= 8) {
        let size = tail.readUInt32BE(idx - 4);
        if (size === 1 && idx + 12 <= tail.length) size = Number(tail.readBigUInt64BE(idx + 4));
        if (size < 8) size = tailLen - (idx - 8);            // 头损坏：按剩余长度尽力
        moov = await read(fileSize - tailLen + idx + 4, Math.min(size - 8, MAX_MOOV_READ));
      }
    } catch { /* 彻底放弃 */ }
  }
  if (!moov || moov.length < 8) return out;

  // ---- moov 内部：mvhd 取时长，trak→tkhd 取宽高 ----
  const boxes = scanBufBoxes(moov, 0, moov.length);
  for (const b of boxes) {
    if (b.type === 'mvhd' && out.durationSec == null) {
      try {
        const p = b.off + 8;
        const ver = moov[p];
        let timescale, duration;
        if (ver === 1) {                                     // v1: 64bit 时间字段
          timescale = moov.readUInt32BE(p + 20);
          duration = Number(moov.readBigUInt64BE(p + 24));
        } else {                                             // v0: 32bit
          timescale = moov.readUInt32BE(p + 12);
          duration = moov.readUInt32BE(p + 16);
        }
        if (timescale > 0 && duration > 0) out.durationSec = Math.round((duration / timescale) * 100) / 100;
      } catch { /* 忽略 */ }
    }
    if (b.type === 'trak') {
      for (const t of scanBufBoxes(moov, b.off + 8, Math.min(b.off + b.size, moov.length))) {
        if (t.type !== 'tkhd') continue;
        try {
          const p = t.off + 8;
          const ver = moov[p];
          let w = null, h = null;
          if (ver === 1) {
            // ISO 14496-12: v1 时间字段为 64bit → 宽高在 payload 88/92；
            // 部分资料误写 84/88（84 恰为 matrix 末元素 1.0），做合理性校验兜底
            for (const o of [88, 84]) {
              w = fixed16(moov.readUInt32BE(p + o));
              h = fixed16(moov.readUInt32BE(p + o + 4));
              if (w && h) break;
            }
          } else {                                           // v0: payload 76/80
            w = fixed16(moov.readUInt32BE(p + 76));
            h = fixed16(moov.readUInt32BE(p + 80));
          }
          if (w && h) { out.width = w; out.height = h; }
        } catch { /* 忽略 */ }
        if (out.width) break;                                // 拿到视频轨尺寸即可
      }
    }
    if (out.durationSec != null && out.width != null) break;
  }
  return out;
}

/* ================================ ID3 ================================ */

/** syncsafe 整数（每个字节只用低 7 位） */
function syncsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

/** 解码 ID3 文本帧（首字节为编码声明：0=Latin1, 1=UTF-16带BOM, 2=UTF-16BE, 3=UTF-8） */
function id3Text(data) {
  if (!data || !data.length) return null;
  const enc = data[0];
  const body = data.slice(1);
  let s;
  try {
    if (enc === 1) {
      if (body[0] === 0xfe && body[1] === 0xff) { const sw = Buffer.from(body.slice(2)); sw.swap16(); s = sw.toString('utf16le'); }
      else s = body.slice(body[0] === 0xff && body[1] === 0xfe ? 2 : 0).toString('utf16le');
    } else if (enc === 2) {
      const sw = Buffer.from(body); sw.swap16(); s = sw.toString('utf16le');
    } else if (enc === 3) s = body.toString('utf8');
    else s = body.toString('latin1');
  } catch { return null; }
  s = s.replace(/\0+$/g, '').trim();
  return s || null;
}

/**
 * 解析 ID3 标签：优先 v2.3/2.4 帧文本，缺失时读文件尾部 128B 的 ID3v1
 * @returns {{title,artist,album,year}}
 */
function parseId3(buf) {
  const out = { title: null, artist: null, album: null, year: null };
  if (!buf || buf.length < 10) return out;

  // ---- ID3v2 ----
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 && buf[3] >= 2 && buf[3] <= 4) {
    try {
      const ver = buf[3];
      const flags = buf[5];
      const size = syncsafe(buf, 6);
      let off = 10;
      // 扩展头（v2.3：4字节大小不含自身；v2.4：syncsafe 大小含自身）
      if (flags & 0x40) {
        if (ver === 4) off += syncsafe(buf, 10);
        else off += 4 + buf.readUInt32BE(10);
      }
      const end = Math.min(10 + size, buf.length);
      while (off + 10 <= end) {
        const id = buf.slice(off, off + 4).toString('latin1');
        if (!/^[A-Z0-9]{4}$/.test(id)) break;                // 帧ID非法 → 结构损坏，停
        const fsize = ver === 4 ? syncsafe(buf, off + 4) : buf.readUInt32BE(off + 4);
        if (fsize <= 0 || off + 10 + fsize > buf.length) break;
        if (id === 'TIT2') out.title = out.title || id3Text(buf.slice(off + 10, off + 10 + fsize));
        else if (id === 'TPE1') out.artist = out.artist || id3Text(buf.slice(off + 10, off + 10 + fsize));
        else if (id === 'TALB') out.album = out.album || id3Text(buf.slice(off + 10, off + 10 + fsize));
        else if (id === 'TYER' || id === 'TDRC') out.year = out.year || id3Text(buf.slice(off + 10, off + 10 + fsize));
        off += 10 + fsize;
      }
    } catch { /* v2 损坏则走 v1 兜底 */ }
  }

  // ---- ID3v1 兜底：文件尾部 128 字节 ----
  if (!out.title && buf.length >= 128) {
    const tail = buf.slice(buf.length - 128);
    if (tail.slice(0, 3).toString('latin1') === 'TAG') {
      const field = (s, e) => tail.slice(s, e).toString('latin1').replace(/\0+.*$/s, '').trim() || null;
      out.title = out.title || field(3, 33);
      out.artist = out.artist || field(33, 63);
      out.album = out.album || field(63, 93);
      out.year = out.year || field(93, 97);
    }
  }
  return out;
}

/* ============================== 类型识别 ============================== */

const KIND_EXTS = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'svg', 'tif', 'tiff']),
  video: new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'm4v', 'ts', 'wmv', '3gp', 'mpg', 'mpeg']),
  audio: new Set(['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac', 'opus', 'wma', 'ape', 'aiff', 'mid']),
};

/** 按文件扩展名分类：image | video | audio | other */
function detectKind(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return 'other';
  const ext = name.slice(dot + 1).toLowerCase();
  for (const [kind, set] of Object.entries(KIND_EXTS)) {
    if (set.has(ext)) return kind;
  }
  return 'other';
}

/* ------------------------------ 自测 ------------------------------ */
if (require.main === module) {
  let fail = 0;
  const check = (name, cond, extra) => {
    if (!cond) fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra != null ? '  (' + extra + ')' : ''}`);
  };

  // ---- detectKind ----
  check('detectKind jpg→image', detectKind('照片.JPG') === 'image');
  check('detectKind mp4→video', detectKind('a.b.mp4') === 'video');
  check('detectKind flac→audio', detectKind('x.flac') === 'audio');
  check('detectKind 无扩展→other', detectKind('README') === 'other');
  check('detectKind 未知→other', detectKind('data.xyz') === 'other');

  // ---- ID3v1（手工 128B）----
  const v1 = Buffer.alloc(128);
  v1.write('TAG', 0, 'latin1');
  v1.write('Old Song', 3, 'latin1');
  v1.write('Old Artist', 33, 'latin1');
  v1.write('Old Album', 63, 'latin1');
  v1.write('1999', 93, 'latin1');
  const r1 = parseId3(v1);
  check('ID3v1 title', r1.title === 'Old Song');
  check('ID3v1 artist/album/year', r1.artist === 'Old Artist' && r1.album === 'Old Album' && r1.year === '1999');

  // ---- ID3v2.3（手工帧：TIT2 latin1 + TPE1 utf8 + TYER）----
  const enc = (s, e) => { const b = Buffer.from(s, e); return Buffer.concat([Buffer.from([e === 'utf8' ? 3 : 0]), b]); };
  const frame = (id, data) => {
    const f = Buffer.alloc(10);
    f.write(id, 0, 'latin1');
    f.writeUInt32BE(data.length, 4);
    return Buffer.concat([f, data]);
  };
  const frames = Buffer.concat([
    frame('TIT2', enc('测试歌曲', 'utf8')),
    frame('TPE1', enc('张三', 'utf8')),
    frame('TYER', enc('2024', 'latin1')),
  ]);
  const v2head = Buffer.alloc(10);
  v2head.write('ID3', 0, 'latin1');
  v2head[3] = 3;                                             // v2.3
  const n = frames.length;
  v2head[6] = (n >> 21) & 0x7f; v2head[7] = (n >> 14) & 0x7f; v2head[8] = (n >> 7) & 0x7f; v2head[9] = n & 0x7f;
  const v2 = Buffer.concat([v2head, frames]);
  const r2 = parseId3(v2);
  check('ID3v2.3 title/artist', r2.title === '测试歌曲' && r2.artist === '张三', JSON.stringify(r2));
  check('ID3v2.3 year', r2.year === '2024');
  // v2 有 title 时不走 v1
  const both = Buffer.concat([v2, Buffer.alloc(100), v1]);
  check('ID3v2 优先于 v1', parseId3(both).title === '测试歌曲');

  // ---- 最小 MP4：ftyp + moov(mvhd v0 + trak(tkhd v0 1920x1080)) ----
  const box = (type, ...payloads) => {
    const body = Buffer.concat(payloads);
    const h = Buffer.alloc(8);
    h.writeUInt32BE(body.length + 8, 0);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, body]);
  };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; };
  const mvhd = box('mvhd',
    Buffer.from([0, 0, 0, 0]),                               // version+flags (v0)
    u32(0), u32(0),                                          // ctime mtime
    u32(1000), u32(95000));                                  // timescale=1000 duration=95000
  const fixed = (v) => u32(Math.round(v * 65536));
  const matrix = Buffer.concat(Array.from({ length: 9 }, (_, i) => fixed(i === 0 || i === 4 || i === 8 ? 1 : 0)));
  const tkhdV0 = box('tkhd',
    Buffer.from([0, 0, 0, 0]),
    u32(0), u32(0), u32(1), u32(0), u32(95000),              // ctime mtime trackid res duration
    u32(0), u32(0),                                          // reserved[2]
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),                   // layer alt volume res
    matrix,
    fixed(1920), fixed(1080));
  const mp4v0 = Buffer.concat([
    box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isommp42', 'latin1')),
    box('moov', mvhd, box('trak', tkhdV0)),
  ]);
  const readOf = (b) => async (o, l) => b.slice(o, Math.min(o + l, b.length));
  (async () => {
    const m0 = await parseMp4(readOf(mp4v0), mp4v0.length);
    check('MP4 v0 brand/duration', m0.brand === 'isom' && m0.durationSec === 95, JSON.stringify(m0));
    check('MP4 v0 width/height', m0.width === 1920 && m0.height === 1080, JSON.stringify(m0));

    // tkhd v1（64bit 时间字段）：1280x720
    const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v), 0); return b; };
    const tkhdV1 = box('tkhd',
      Buffer.from([1, 0, 0, 0]),
      u64(0), u64(0), u32(1), u32(0), u64(95000),
      u32(0), u32(0),
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
      matrix,
      fixed(1280), fixed(720));
    const mp4v1 = Buffer.concat([mp4v0.slice(0, 0), box('moov', mvhd, box('trak', tkhdV1))]);
    const m1 = await parseMp4(readOf(mp4v1), mp4v1.length);
    check('MP4 tkhd v1 width/height', m1.width === 1280 && m1.height === 720, JSON.stringify(m1));

    // moov 在尾部 + 头部垃圾数据（触发 256KB 尾部搜索兜底）
    const garbage = Buffer.alloc(64, 0x5a);                  // 非 box 头
    const mp4tail = Buffer.concat([garbage, box('moov', mvhd, box('trak', tkhdV0))]);
    const mt = await parseMp4(readOf(mp4tail), mp4tail.length);
    check('MP4 尾部moov兜底', mt.durationSec === 95 && mt.width === 1920, JSON.stringify(mt));

    // ---- 手工 JPEG：SOI + APP1(Exif: II 字节序, IFD0=Make/Orientation/GPS) + SOF0 + EOI ----
    const tiffParts = [];
    const tiff = Buffer.alloc(200);
    let p = 0;
    tiff.write('II', p, 'latin1'); p += 2;                   // 小端
    tiff.writeUInt16LE(42, p); p += 2;
    tiff.writeUInt32LE(8, p); p += 4;                        // IFD0 在偏移 8
    const ifd0Pos = 8;
    tiff.writeUInt16LE(3, p); void ifd0Pos;                  // 3 个条目
    // 条目从偏移 10 开始；数据区：ACME 在 54，GPS IFD 在 62
    const entry = (tag, type, count, valueBytes) => {
      const e = Buffer.alloc(12);
      e.writeUInt16LE(tag, 0);
      e.writeUInt16LE(type, 2);
      e.writeUInt32LE(count, 4);
      if (valueBytes.length <= 4) valueBytes.copy(e, 8);
      else e.writeUInt32LE(valueBytes._off, 8);
      return e;
    };
    const acme = Buffer.from('ACME\0', 'latin1');
    acme._off = 54;
    const gpsPos = 62;
    const gpsPtr = Buffer.alloc(4);
    gpsPtr.writeUInt32LE(gpsPos, 0);
    let e0 = entry(0x010f, 2, 5, acme);                      // Make
    let e1 = entry(0x0112, 3, 1, Buffer.from([6, 0, 0, 0])); // Orientation=6 内联
    let e2 = entry(0x8825, 4, 1, gpsPtr);                    // GPS IFD 指针
    acme.copy(tiff, 54);
    tiff.writeUInt16LE(3, 8);                                // IFD0 count（改：3 条目）
    e0.copy(tiff, 10); e1.copy(tiff, 22); e2.copy(tiff, 34);
    tiff.writeUInt32LE(0, 46);                               // next IFD = 0
    // GPS IFD @62：latRef N / lat 3×RATIONAL / lonRef E / lon 3×RATIONAL
    const gpsEntry = (tag, type, count, valueBytes) => entry(tag, type, count, valueBytes);
    const latData = Buffer.alloc(24);                        // 39°54'30" N
    [[39, 1], [54, 1], [30, 1]].forEach(([n2, d], i) => { latData.writeUInt32LE(n2, i * 8); latData.writeUInt32LE(d, i * 8 + 4); });
    const lonData = Buffer.alloc(24);                        // 116°23'29" E
    [[116, 1], [23, 1], [29, 1]].forEach(([n2, d], i) => { lonData.writeUInt32LE(n2, i * 8); lonData.writeUInt32LE(d, i * 8 + 4); });
    latData._off = 62 + 2 + 4 * 12 + 4;                      // 62+54=116
    lonData._off = latData._off + 24;                        // 140
    const latRef = Buffer.from('N\0', 'latin1');
    const lonRef = Buffer.from('E\0', 'latin1');
    const g0 = gpsEntry(0x0001, 2, 2, latRef);
    const g1 = gpsEntry(0x0002, 5, 3, latData);
    const g2 = gpsEntry(0x0003, 2, 2, lonRef);
    const g3 = gpsEntry(0x0004, 5, 3, lonData);
    tiff.writeUInt16LE(4, gpsPos);
    latData.copy(tiff, latData._off);                        // 数据区：度分秒 RATIONAL
    lonData.copy(tiff, lonData._off);
    g0.copy(tiff, gpsPos + 2); g1.copy(tiff, gpsPos + 14); g2.copy(tiff, gpsPos + 26); g3.copy(tiff, gpsPos + 38);
    tiff.writeUInt32LE(0, gpsPos + 50);
    void tiffParts; void e0; void e1; void e2; void p;
    const tiffLen = lonData._off + 24;
    const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff.slice(0, tiffLen)]);
    const app1 = Buffer.alloc(app1Body.length + 4);          // 2 标记 + 2 长度 + 数据
    app1[0] = 0xff; app1[1] = 0xe1;
    app1.writeUInt16BE(app1Body.length + 2, 2);
    app1Body.copy(app1, 4);
    const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof0, Buffer.from([0xff, 0xd9])]);
    const j = parseJpegExif(jpeg);
    check('JPEG SOF 尺寸', j.width === 640 && j.height === 480, JSON.stringify(j));
    check('JPEG EXIF make/orientation', j.make === 'ACME' && j.orientation === 6, JSON.stringify(j));
    check('JPEG GPS 十进制', j.gps && Math.abs(j.gps.lat - 39.9083333) < 1e-4 && Math.abs(j.gps.lon - 116.3913889) < 1e-4,
      j.gps ? `${j.gps.lat.toFixed(4)},${j.gps.lon.toFixed(4)}` : 'null');
  })().then(() => {
    console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
    process.exit(fail === 0 ? 0 : 1);
  }).catch((e) => { console.error('FAIL  自测异常:', e); process.exit(1); });
}

module.exports = { parseJpegExif, parseMp4, parseId3, detectKind };

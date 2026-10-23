'use strict';

/* =====================================================================
   lib/totp.js — RFC 6238 TOTP（基于时间的动态口令，零依赖）
   算法：TOTP = Truncate(HMAC-SHA1(K, T))，T = floor(unix秒 / step)
   提供两步验证（2FA）能力：generateSecret 生成密钥，
   otpauthURI 生成 Authenticator 扫码链接，verify 带窗口校验。
   R9-P0-1：verify 除了 ok/matchedOffset，还必须回传**命中时间步的绝对
   counter**（= floor(unix秒/step)），否则服务端无从判断「同一个码是否被
   重放过」——这是 2FA 重放防护的地基。
   ===================================================================== */

const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32 字母表

/**
 * base32 编码（RFC 4648，无填充 '='）
 * @param {Buffer} buf 原始字节
 * @returns {string}
 */
function base32Encode(buf) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]; // 剩余位左对齐补 0
  return out;
}

/**
 * base32 解码（RFC 4648，无填充；忽略大小写与空格，非法字符报错）
 * @param {string} str
 * @returns {Buffer}
 */
function base32Decode(str) {
  const s = String(str).replace(/\s+/g, '').toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('非法 base32 字符: ' + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * 生成随机 TOTP 密钥（base32 格式，可直接填入 Authenticator）
 * @param {number} bytes 随机字节数，默认 20（160 bit，RFC 推荐）
 */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(Math.max(1, bytes | 0)));
}

/**
 * 计算某时刻的 TOTP 码（HMAC-SHA1 动态截断，RFC 4226 §5.3）
 * @param {string} secretB32 base32 密钥
 * @param {{t?:number, step?:number, digits?:number}} opts t 为毫秒时间戳
 */
function totp(secretB32, opts = {}) {
  const t = opts.t != null ? opts.t : Date.now();
  const step = opts.step || 30;
  const digits = opts.digits || 6;
  const counter = Math.floor(t / 1000 / step); // 时间步计数器
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0); // 高 32 位
  msg.writeUInt32BE(counter >>> 0, 4);                     // 低 32 位
  const key = base32Decode(secretB32);
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;                  // 动态截断偏移 = 末字节低 4 位
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * 校验用户输入的验证码（±window 个时间步内逐个比对，防时序攻击用常量比较）
 *
 * R9-P0-1：返回值里的 counter 是**实际命中的那个时间步**的绝对计数器
 * （counter = floor(unix秒 / step)）。window=1 时会依次比对 -1/0/+1 三个
 * 时间步，若用户在上一时间步的窗口内输入，counter 必须比当前步小 1 ——
 * 固定返回当前步会让服务端的重放判定算出错误的时间步。
 *
 * @param {string} secretB32 base32 密钥
 * @param {string} code 用户输入的验证码
 * @param {object} [opts]
 * @param {number} [opts.window=1]            允许的时间步偏移范围
 * @param {number} [opts.step=30]             时间步长（秒）
 * @param {number} [opts.now]                 基准时间（毫秒），测试用；缺省取当前时间
 * @param {number} [opts.counter]             服务端**已用过**的最大 counter；命中 counter 必须严格大于它
 * @param {number} [opts.counterTolerance=0]  允许的时钟回退步数（0 = 严格拒绝重放）
 * @returns {{ok:boolean, matchedOffset:number, counter:number|null, stale?:boolean, reason?:string}}
 *          matchedOffset 为命中时相对当前步的偏移（-1 未命中）；
 *          counter 未命中为 null；命中但 counter 过旧时 ok=false 且 stale=true。
 */
function verify(secretB32, code, opts = {}) {
  const window = opts.window != null ? opts.window : 1;
  const step = opts.step || 30;
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const raw = String(code == null ? '' : code);
  const digits = raw.length || 6;
  const stepMs = step * 1000;

  for (let w = -window; w <= window; w++) {
    const t = now + w * stepMs;
    const expect = totp(secretB32, { t, step, digits });
    // 常量时间比较（等长 hex 化后 timingSafeEqual）
    const a = Buffer.from(raw);
    const b = Buffer.from(expect);
    const eq = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!eq) continue;

    // 命中：counter 取**这一步**的绝对计数器（整数步长平移，floor 后必然同步平移）
    const counter = Math.floor(t / 1000 / step);

    /* 重放保护：服务端传入「已用过的最大 counter」时，命中步必须严格更大。
       counterTolerance 用于容忍设备时钟轻微回退 —— 它会等量放宽重放窗口，
       因此默认 0（严格）。 */
    if (Number.isFinite(opts.counter)) {
      const tol = Math.max(0, Number(opts.counterTolerance) || 0);
      const minCounter = Number(opts.counter) + 1 - tol;
      if (counter < minCounter) {
        return { ok: false, matchedOffset: w, counter, stale: true, reason: 'counter' };
      }
    }
    return { ok: true, matchedOffset: w, counter };
  }
  return { ok: false, matchedOffset: -1, counter: null };
}

/**
 * 生成 otpauth:// 链接（Google Authenticator / 微信等 App 扫码用）
 * @param {{label:string, secret:string, issuer?:string}} p
 */
function otpauthURI(p) {
  const label = encodeURIComponent(p.label || '');
  const params = new URLSearchParams({ secret: p.secret });
  if (p.issuer) params.set('issuer', p.issuer);
  params.set('algorithm', 'SHA1');
  params.set('digits', '6');
  params.set('period', '30');
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------ 自测（RFC 6238 附录 B） ------------------------------ */
if (require.main === module) {
  let fail = 0;
  const check = (name, got, want) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${got} want=${want}`);
  };
  // RFC 6238 附录 B 的 SHA1 测试密钥（seed '12345678901234567890' 的 base32）
  const KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  check('RFC6238 T=59',          totp(KEY, { t: 59 * 1000, digits: 8 }),          '94287082');
  check('RFC6238 T=1111111109',  totp(KEY, { t: 1111111109 * 1000, digits: 8 }),  '07081804');
  check('RFC6238 T=1234567890',  totp(KEY, { t: 1234567890 * 1000, digits: 8 }),  '89005924');
  // base32 回环测试（含空格、小写、边界：5 字节整块 / 尾部余位）
  const samples = [Buffer.alloc(0), Buffer.from([0]), Buffer.from('foobar'), crypto.randomBytes(20), crypto.randomBytes(37)];
  for (const buf of samples) {
    const round = base32Decode(base32Encode(buf));
    const ok = Buffer.compare(round, buf) === 0;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  base32回环 len=${buf.length}`);
  }
  // verify 窗口测试：上一时间步的码应可命中（offset=-1）
  const v = verify(KEY, totp(KEY, { t: Date.now() - 30000 }), { window: 1 });
  check('verify 窗口命中', v.ok + ':' + v.matchedOffset, 'true:-1');
  check('verify 错误码拒绝', verify(KEY, '0000000', { window: 1 }).ok, false);

  /* R9-P0-1：counter 语义自测 —— 服务端的重放判定完全依赖这个字段 */
  const sec = generateSecret(20);
  const t0 = 1700000000000;                       // 固定基准时间，避免跨时间步导致的抖动
  const cur = Math.floor(t0 / 1000 / 30);
  const code0 = totp(sec, { t: t0 });
  const vA = verify(sec, code0, { window: 1, now: t0 });
  const vB = verify(sec, code0, { window: 1, now: t0 });
  check('verify 返回 counter', vA.counter, cur);
  check('verify counter 两次一致', vA.counter, vB.counter);
  check('verify counter 可判定为有限数', Number.isFinite(vA.counter), true);
  // 命中上一时间步时，counter 必须同步 -1（不能固定返回当前步）
  const vPrev = verify(sec, totp(sec, { t: t0 - 30000 }), { window: 1, now: t0 });
  check('上一时间步 counter-1', vPrev.matchedOffset + ':' + vPrev.counter, '-1:' + (cur - 1));
  // 旧 counter 必须被拒绝（重放）
  const vStale = verify(sec, code0, { window: 1, now: t0, counter: vA.counter });
  check('旧 counter 被拒绝', vStale.ok, false);
  check('旧 counter 仍回传 counter', vStale.counter, cur);
  check('旧 counter 标记 stale', vStale.stale, true);
  // 更旧的 counter 同样被拒
  check('更旧 counter 被拒绝', verify(sec, code0, { window: 1, now: t0, counter: vA.counter + 5 }).ok, false);
  // counterTolerance=1 允许同一时间步再走一次（时钟回退容忍），默认 0 是严格的
  check('counterTolerance=1 放行', verify(sec, code0, { window: 1, now: t0, counter: vA.counter, counterTolerance: 1 }).ok, true);
  // 未命中时 counter 为 null（服务端据此判定「码本身错了」而不是「重放」）
  check('未命中 counter 为 null', verify(sec, '000000', { window: 1, now: t0 }).counter, null);

  console.log(fail === 0 ? '\n全部 PASS' : `\n${fail} 项 FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

module.exports = { generateSecret, base32Encode, base32Decode, totp, verify, otpauthURI };

'use strict';

/**
 * token 估算与安全裁剪（共用层）
 *
 * ⚠️ **定位说明（防再误判）**：本模块是 **LLM token 预算估算器** ——
 *   它只干两件事：估算一段文本占多少 token、按预算把它裁短。
 *   **与 API Key、密钥管理、鉴权完全无关**。历史上本模块被误判为"API Key 模块"
 *   并被要求下线/整改，那是误判：本文件里没有一行与密钥相关。
 *   排查鉴权、密钥、登录问题请看 lib/ai.js、lib/ai-tools.js 与 server.js。
 *
 * 为什么单独抽一个模块：`ai-tools.js`（本地文件工具）和 `ai-web.js`（联网工具）
 * 都需要"按 token 预算裁剪"，但后者要被前者委托调用 —— 直接把这两个函数放在
 * ai-tools.js 里会形成循环 require。放这里两边都能安心 require。
 *
 * ai-tools.js 仍然 re-export 这三个函数，历史调用方（lib/ai.js、各测试）不受影响。
 */

/**
 * token 数**上界**估算 —— 可证明的上界，不是"尽量准的估计"。
 *
 * 取值就是 **UTF-8 字节长度**。理由：llama.cpp 与主流实现都是 byte-level BPE，
 * 每个 token 至少覆盖 1 个字节，所以 `token 数 ≤ 字节数` 恒成立，与内容无关、与语言无关。
 *
 * 为什么必须是"上界"而不是"尽量准"：
 *   调用方拿它决定「发送前要不要裁」。一旦**低估**，就会判定"装得下"而原样发送，
 *   上游直接回 400 `exceeds the available context size` → 前端一片空白（最难查的一类故障）。
 *   高估的代价只是偶尔多跑一次真实计数（`_fitAsync` 会用 /tokenize 复核），
 *   以及 /tokenize 不可用时少读一点内容。两侧代价严重不对称。
 *
 * 为什么"按字符类别调系数"这条路走不通（真金白银试过两次，都翻车）：
 *   实测同一分词器下各类内容的真实密度（token/字符）：
 *     英文散文 0.22 · 常用汉字散文 0.56 · 随机符号 0.68 · 拉丁重音 1.15
 *     emoji 1.38 · 全角数字 1.70 · 生僻汉字 2.00 · 扩展 B 区汉字 2.00
 *   跨了将近 10 倍，而且**同一类内部还分层**：常用汉字 0.56，生僻汉字 2.00。
 *   更麻烦的是跨界会打断 BPE 合并 —— `编号,设备名称` 这种 CSV 比纯中文散文更费 token。
 *   第一版按 CJK/ASCII 两档估：Cookie 导出一类低估 1.49×（→ 顶爆 400）；
 *   第二版加了符号密度判定：修好了 Cookie，又把 CSV 弄成低估 1.44×。
 *   任何"分段求和"模型都抓不住这些，因为分词数本来就不是字符类别的线性函数。
 *
 * 结论：估算器只负责"绝不低于真实值"，**精度交给 /tokenize**（见 AI#countTokens）。
 * 需要精确值时不要用这个函数。
 *
 * ⚠️ **不可变量**：`estTokens(s) >= 真实 token 数` 对任何内容恒成立。
 *   这是 lib/ai.js 上下文守卫的安全前提 —— 低估会让守卫误判"装得下"而原样发送，
 *   上游直接 400（用户看到一片空白）。test/t-token-cal.js 守着这条不变量。
 *   改这个函数前先想清楚：**只能往"更保守"的方向改，不能往"更准"的方向改。**
 */
function estTokens(s) {
  const str = String(s == null ? '' : s);
  return str ? Buffer.byteLength(str, 'utf8') : 0;
}

/**
 * 安全切片：不把 surrogate pair 切成两半。
 * 从中间切断 emoji / 扩展 B 区汉字会留下一个孤立代理项，
 * 序列化进 JSON 变成 `\udXXX`，模型看到的是乱码，还可能干扰后续解析。
 */
function sliceSafe(str, cut) {
  const s = String(str || '');
  if (cut >= s.length) return s;
  if (cut <= 0) return '';
  const c = s.charCodeAt(cut - 1);
  return (c >= 0xd800 && c <= 0xdbff) ? s.slice(0, cut - 1) : s.slice(0, cut);
}

/**
 * 按 token 预算裁剪文本。返回 { text, clipped, tokens }。
 * 优先在换行处断开，避免把一句话截成两半。
 *
 * 用**二分**求"≤ 预算的最长前缀"：前缀长度 ↑ → token 数单调不减，
 * 所以最大可行前缀良定义，~log2(n) 次命中，不依赖任何密度假设。
 * 历史教训：先试过"按比例回缩 + 固定轮数上限"，实测在预算 600 上切出 603 ——
 * 那不是收敛算法，会撞上限。单调量只能用二分。
 */
function clipToTokens(str, budget) {
  const s = String(str || '');
  const total = estTokens(s);
  if (total <= budget) return { text: s, clipped: false, tokens: total };
  let lo = 0, hi = s.length, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (estTokens(sliceSafe(s, mid)) <= budget) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  let cut = best;
  /* 往回找最近的换行，最多回退 200 字符 */
  const nl = s.lastIndexOf('\n', cut);
  if (nl > cut - 200 && nl > 0) cut = nl;
  return { text: sliceSafe(s, cut), clipped: cut < s.length, tokens: estTokens(sliceSafe(s, cut)) };
}

module.exports = { estTokens, clipToTokens, sliceSafe };

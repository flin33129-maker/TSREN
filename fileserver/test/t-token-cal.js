/* token 估算器的**真实分词器校验**（v4.3）
 *
 * 为什么需要这个用例：
 * lib/ai-tools 的 estTokens 只有一个职责 —— 永远不低于真实 token 数。
 * 低估的代价是守卫误判"装得下"而原样发送，上游 400，用户看到一片空白；
 * 高估只是偶尔多跑一次精确计数。所以这条不变量必须在**真实分词器**上验证，
 * 而不是拿一堆硬编码数字自说自话。
 *
 * 这里同时做两件事：
 *   ① 断言 estTokens(s) >= real(s) 对所有内容类别都成立（安全性）
 *   ② 报告高估倍数（效率）—— 高估太多会让守卫频繁触发精确复核，也不健康
 *
 * 依赖推理后端的 /tokenize。后端不可达时**跳过**（不判失败），
 * 否则在没有模型的机器上跑全量回归会红。
 *
 * 运行：node test/t-token-cal.js            （自动探测后端）
 *       TOK_BASE=http://192.168.8.86:8080 node test/t-token-cal.js
 */
const fs = require('fs');
const path = require('path');
const { estTokens } = require('../lib/ai-tools');

const BASE = (process.env.TOK_BASE || 'http://192.168.8.86:8080').replace(/\/+$/, '');

let pass = 0, fail = 0, skip = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS  ' + m)) : (fail++, console.log('  FAIL  ' + m)); };

const rnd = (n, pool) => Array.from({ length: n }, () => pool[Math.floor(Math.random() * pool.length)]).join('');
const LU = 'abcdefghijklmnopqrstuvwxyz';
const MIX = LU + LU.toUpperCase() + '0123456789';
const SYM = '!"#$%&\'()*+,-./:;<=>?@[]^_`{|}~';

function samples() {
  const pub = path.resolve(__dirname, '../data/storage/public');
  const read = (f) => { try { return fs.readFileSync(path.join(pub, f), 'utf8'); } catch { return null; } };
  const list = {
    '常用汉字散文': '这是一段用于验证分词效率的普通中文内容。'.repeat(40),
    '汉字标点混排': '巡检日期：2026-09-10。巡检人：张工。主变本体温度 58℃，正常（阈值 75℃）。'.repeat(20),
    '重复单字（最坏）': '中'.repeat(400),
    '生僻汉字': '龘靐齉爩蠿羴犇毳'.repeat(30),
    '扩展B区汉字': '𠀋𠮷𡃁𣇉'.repeat(60),
    'emoji': '😀🎉🚀🔥'.repeat(40),
    '全角数字': '１２３４５６７８９０'.repeat(30),
    '拉丁重音': 'àéîõüñçßÀÉÎÕÜ'.repeat(30),
    '日文假名': 'これはテストです。'.repeat(40),
    '韩文': '이것은 테스트입니다. '.repeat(40),
    '英文散文': 'The quick brown fox jumps over the lazy dog. '.repeat(20),
    '英文代码': 'const a = (b, c) => b.map(x => x + c);\n'.repeat(20),
    'JSON': JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, n: 'dev' + i, s: i % 2 ? 'on' : 'off' }))),
    'URL': 'https://example.com/api/v1/items?page=3&size=50&sort=desc&token=abc123XYZ\n'.repeat(12),
    '随机小写': rnd(600, LU),
    '随机大小写数字': rnd(600, MIX),
    '随机符号': rnd(600, SYM),
    'ASCII 全字符': Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('').repeat(6),
    '制表符表格': '__Secure-1PAPISID\tH_bIdZ\t.google.com\t/\t2027-10-12T07:10:28Z\t51\tHigh\n'.repeat(20),
  };
  /* 把用户公共盘里的真实文件也纳入（有的机器上没有，就地跳过） */
  for (const f of ['项目归档说明.md', '巡检记录.txt', '设备台账.csv', '浏览器导出记录.txt']) {
    const t = read(f);
    if (t) list['真实文件 · ' + f] = t;
  }
  return list;
}

const realTokens = async (text) => {
  const r = await fetch(BASE + '/tokenize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j.tokens)) throw new Error('响应里没有 tokens');
  return j.tokens.length;
};

(async () => {
  console.log('='.repeat(74));
  console.log('token 估算器 · 真实分词器校验 · ' + BASE);
  console.log('='.repeat(74));

  try {
    await realTokens('探活');
  } catch (e) {
    console.log('\n  SKIP  推理后端不可达（' + e.message + '），跳过本轮校验。');
    console.log('        需要时用 TOK_BASE=<地址> 指定，或先启动 llama-server。');
    console.log('\n' + '='.repeat(74));
    console.log('⏭  已跳过 (0 项通过, 0 项失败)');
    process.exit(0);
  }

  const S = samples();
  console.log('\n样本'.padEnd(26) + '字符'.padEnd(8) + '真实'.padEnd(8) + '上界'.padEnd(8) + 'token/字'.padEnd(11) + '高估');
  console.log('-'.repeat(74));

  let worst = { ratio: 0, name: '' };   // 最紧的一档（越接近 1 越危险）
  let loose = { ratio: 0, name: '' };   // 最松的一档（越大多余工作越多）
  let under = [];
  for (const [name, text] of Object.entries(S)) {
    const real = await realTokens(text);
    const est = estTokens(text);
    const ratio = est / real;
    if (!worst.name || ratio < worst.ratio) worst = { ratio, name };
    if (ratio > loose.ratio) loose = { ratio, name };
    if (est < real) under.push(name + '（' + est + ' < ' + real + '，低估 ' + (real / est).toFixed(2) + '×）');
    console.log(name.padEnd(26) + String(text.length).padEnd(8) + String(real).padEnd(8)
      + String(est).padEnd(8) + (real / text.length).toFixed(2).padEnd(11) + ratio.toFixed(2) + '×');
  }
  console.log('-'.repeat(74));

  console.log('');
  ok(under.length === 0,
    '所有 ' + Object.keys(S).length + ' 类样本均未低估'
    + (under.length ? '：' + under.join('；') : '（这是安全性的全部要求）'));
  ok(worst.ratio >= 1,
    '最紧的一档仍有余量：' + worst.name + ' = ' + worst.ratio.toFixed(2) + '×（必须 ≥ 1.00）');
  /* 高估**不损失内容** —— 只是让守卫多跑一次精确计数（_fitAsync 复核后原样发送）。
     这条断言只防止倍率无限放大（那会让守卫每轮都白跑）：实测最松是假名类 6~7×，
     因为假名在 UTF-8 里 3 字节、在分词器里合并得很狠。取 8 作上界。 */
  ok(loose.ratio <= 8,
    '上界倍率有界：最松的 ' + loose.name + ' = ' + loose.ratio.toFixed(2)
    + '×（≤ 8；高估只多跑一次精确计数，不损失内容）');

  /* ---------- 2 · 精确裁剪的收敛性 ----------
     估算器只负责"永不低估"，真正决定 read_file 读多少的是**精确路径**。
     它必须先按比例开个初值、再用 /tokenize 实测收敛 —— 单靠比例切不可靠：
     同一文件里前段可能是符号密集区（比整体更费 token），按整体比例切就会顶爆。
     这里用一个"前段极贵、后段极廉"的混排样本把这个坑钉住。 */
  console.log('\n' + '-'.repeat(74));
  console.log('2 · 精确裁剪收敛性（read_file 实测预算）');
  console.log('-'.repeat(74));
  try {
    const os = require('os');
    const { AI } = require('../lib/ai');
    const { AITools } = require('../lib/ai-tools');
    const tmp = os.tmpdir();
    const relName = '_cal_clip_probe.txt';
    const heavy = Array.from({ length: 900 },
      () => '!"#$%&\'()*+,-./:;<=>?@[]^_`{|}~'[Math.floor(Math.random() * 28)]).join('');
    const light = 'The quick brown fox jumps over the lazy dog. '.repeat(300);
    const sample = heavy + '\n' + light;
    fs.writeFileSync(path.join(tmp, relName), sample);

    const srv = {
      resolveTarget: (q) => ({ scope: 'public', root: tmp, abs: path.join(tmp, (q && q.path) || '') }),
      storage: { safeResolve: (p) => ({ ok: true, abs: p }), list: () => [] },
      listDisks: () => [],
    };
    const ai = new AI(path.resolve(__dirname, '../data'));
    ai.setTools(new AITools(srv));
    const totalReal = await ai.countTokens(sample);
    console.log('  混排样本 ' + sample.length + ' 字符 · 全量 ' + totalReal + ' token（前段符号密集）');

    let allFit = true;
    let worstKeep = 1;
    for (const budget of [300, 600, 1200, 2000]) {
      const out = String(await ai.tools.run('read_file', { disk: 'public', path: relName, maxTokens: budget },
        { user: { id: 'cal', role: 'admin' }, cwd: 'public:' }));
      const m = out.match(/--- 内容开始 ---\n([\s\S]*?)\n\n…（读取成功/)
        || out.match(/--- 内容开始 ---\n([\s\S]*)\n--- 内容结束 ---/);
      const body = m ? m[1] : '';
      const used = await ai.countTokens(body);
      const keep = used / Math.min(totalReal, budget);
      if (used > budget) allFit = false;
      worstKeep = Math.min(worstKeep, keep);
      console.log('    预算 ' + String(budget).padEnd(5) + ' → 实际 ' + String(used).padEnd(6) + ' token'
        + ' · 保留率 ' + (keep * 100).toFixed(0) + '%' + (used <= budget ? ' ✅' : ' ❌ 超预算'));
    }
    ok(allFit, '任何预算下都不超（精确路径自己收敛，不靠经验余量兜底）');
    ok(worstKeep >= 0.9, '保留率不低于 90%（最差 ' + (worstKeep * 100).toFixed(0)
      + '%）—— 既不顶爆上游，也不白扔预算');
    fs.unlinkSync(path.join(tmp, relName));
  } catch (e) {
    ok(false, '精确裁剪收敛性检查异常：' + e.message);
  }

  console.log('\n' + '='.repeat(74));
  console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败项') + ' (' + pass + ' 项通过, ' + fail + ' 项失败)');
  console.log('='.repeat(74));
  process.exit(fail === 0 ? 0 : 1);
})();

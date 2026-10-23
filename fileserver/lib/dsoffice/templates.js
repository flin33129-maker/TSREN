'use strict';

/**
 * dsoffice · 内置模板库
 *
 * 每个模板只描述「kind + content」，一键创建时由调用方（/api/office/templates/use）
 * 落成一篇独立文档，所以模板数据必须深拷贝 —— 否则两个人用同一个模板会改到一块去。
 */

const { defaultContent } = require('./store');

function sheet(rows, opts) {
  const content = defaultContent('sheet');
  content.cells = {};
  rows.forEach((row, r) => {
    (row || []).forEach((v, c) => {
      if (v == null || v === '') return;
      let letters = '';
      let x = c;
      do { letters = String.fromCharCode(65 + (x % 26)) + letters; x = Math.floor(x / 26) - 1; } while (x >= 0);
      content.cells[letters + (r + 1)] = { v: String(v) };
    });
  });
  if (opts && opts.rows) content.rows = Math.max(content.rows, opts.rows);
  if (opts && opts.cols) content.cols = Math.max(content.cols, opts.cols);
  if (opts && opts.colW) content.colW = opts.colW;
  return content;
}

const TEMPLATES = [
  {
    id: 'meeting',
    name: '会议纪要',
    kind: 'doc',
    group: '常用',
    desc: '结论先行：决议 / 待办 / 责任人 / 截止时间',
    content: {
      text: [
        '# 会议纪要',
        '',
        '- 时间：',
        '- 地点：',
        '- 主持：',
        '- 参会：',
        '',
        '## 一、议题',
        '1. ',
        '',
        '## 二、结论 / 决议',
        '- ',
        '',
        '## 三、待办（谁 / 做什么 / 什么时候）',
        '| 负责人 | 事项 | 截止 |',
        '| --- | --- | --- |',
        '|  |  |  |',
        '',
        '## 四、遗留问题',
        '- ',
      ].join('\n'),
    },
  },
  {
    id: 'weekly',
    name: '周报',
    kind: 'doc',
    group: '常用',
    desc: '本周完成 / 下周计划 / 风险与需要的支持',
    content: {
      text: [
        '# 周报（第 __ 周）',
        '',
        '## 一、本周完成',
        '- [ ] ',
        '',
        '## 二、数据与进展',
        '| 指标 | 上周 | 本周 | 变化 |',
        '| --- | --- | --- | --- |',
        '|  |  |  |  |',
        '',
        '## 三、下周计划',
        '1. ',
        '',
        '## 四、风险 / 需要支持',
        '- ',
      ].join('\n'),
    },
  },
  {
    id: 'okr',
    name: 'OKR 规划',
    kind: 'doc',
    group: '管理',
    desc: '目标 + 关键结果 + 信心指数',
    content: {
      text: [
        '# __ 季度 OKR',
        '',
        '## O1：',
        '- KR1：　信心 5/10',
        '- KR2：　信心 5/10',
        '- KR3：　信心 5/10',
        '',
        '## O2：',
        '- KR1：　信心 5/10',
        '- KR2：　信心 5/10',
        '',
        '## 复盘节奏',
        '- 每周五更新进度，季度末统一打分（0.0–1.0）',
      ].join('\n'),
    },
  },
  {
    id: 'prd',
    name: '需求文档',
    kind: 'doc',
    group: '产品',
    desc: '背景 / 目标 / 方案 / 边界 / 验收',
    content: {
      text: [
        '# 需求：',
        '',
        '## 1. 背景与问题',
        '',
        '## 2. 目标与非目标',
        '- 目标：',
        '- 非目标：',
        '',
        '## 3. 方案概述',
        '',
        '## 4. 交互与边界',
        '- 空态：',
        '- 错误处理：',
        '- 权限：',
        '',
        '## 5. 验收标准',
        '- [ ] ',
        '',
        '## 6. 排期',
        '| 阶段 | 负责人 | 时间 |',
        '| --- | --- | --- |',
        '| 设计 |  |  |',
        '| 开发 |  |  |',
        '| 验收 |  |  |',
      ].join('\n'),
    },
  },
  {
    id: 'retro',
    name: '项目复盘',
    kind: 'doc',
    group: '管理',
    desc: '做对了什么 / 哪里出了问题 / 下次怎么改',
    content: {
      text: [
        '# 项目复盘：',
        '',
        '## 结果回顾',
        '- 目标 vs 实际：',
        '- 关键数据：',
        '',
        '## 做得好的（保持）',
        '- ',
        '',
        '## 做得差的（改进）',
        '- ',
        '',
        '## 根因分析',
        '- ',
        '',
        '## 行动项',
        '| 行动 | 负责人 | 截止 | 状态 |',
        '| --- | --- | --- | --- |',
        '|  |  |  | 未开始 |',
      ].join('\n'),
    },
  },
  {
    id: 'daily',
    name: '数据日报',
    kind: 'doc',
    group: '运营',
    desc: '核心指标 + 异常 + 结论',
    content: {
      text: [
        '# 数据日报 __-__-__',
        '',
        '## 核心指标',
        '| 指标 | 今日 | 昨日 | 环比 |',
        '| --- | --- | --- | --- |',
        '| 活跃 |  |  |  |',
        '| 新增 |  |  |  |',
        '| 转化 |  |  |  |',
        '',
        '## 异常波动',
        '- ',
        '',
        '## 结论与动作',
        '- ',
      ].join('\n'),
    },
  },
  {
    id: 'budget',
    name: '预算表',
    kind: 'sheet',
    group: '财务',
    desc: '带公式的收支表：合计/差额自动计算',
    content: (() => {
      const c = sheet([
        ['项目', '预算', '实际', '差额'],
        ['人力', 30000, 28500, '=B2-C2'],
        ['服务器', 8000, 8200, '=B3-C3'],
        ['软件订阅', 3000, 2400, '=B4-C4'],
        ['合计', '=SUM(B2:B4)', '=SUM(C2:C4)', '=SUM(D2:D4)'],
      ], { rows: 24, cols: 8, colW: { A: 160, B: 110, C: 110, D: 110 } });
      return c;
    })(),
  },
  {
    id: 'kanban',
    name: '看板（敏捷）',
    kind: 'board',
    group: '协作',
    desc: '待办 / 进行中 / 评审 / 已完成',
    content: {
      columns: [
        { id: 'todo', title: '待办' },
        { id: 'doing', title: '进行中' },
        { id: 'review', title: '评审' },
        { id: 'done', title: '已完成' },
      ],
      cards: [
        { id: 'c1', col: 'todo', text: '把本周需求拆成可交付的任务', tags: ['计划'] },
        { id: 'c2', col: 'doing', text: '示例：正在做的任务（可双击编辑）', tags: [] },
        { id: 'c3', col: 'done', text: '示例：已完成的任务', tags: [] },
      ],
    },
  },
  {
    id: 'pitch',
    name: '方案汇报（演示）',
    kind: 'slide',
    group: '汇报',
    desc: '问题 → 方案 → 价值 → 计划 四页起',
    content: {
      slides: [
        { title: '方案名称', body: '副标题 / 汇报人 / 日期' },
        { title: '我们要解决的问题', body: '1. 现状\n2. 痛点\n3. 不解决的代价' },
        { title: '我们的方案', body: '核心思路一句话说清，下面是 3 个关键设计' },
        { title: '价值与收益', body: '效率提升 / 成本下降 / 风险收敛，尽量量化' },
        { title: '下一步计划', body: '里程碑 1：\n里程碑 2：\n需要的支持：' },
      ],
    },
  },
  {
    id: 'plan',
    name: '计划导图',
    kind: 'mind',
    group: '规划',
    desc: '中心主题 + 四条主线，可继续展开',
    content: {
      rootId: 'root',
      nodes: [
        { id: 'root', parent: null, text: '目标' },
        { id: 'n1', parent: 'root', text: '范围' },
        { id: 'n2', parent: 'root', text: '里程碑' },
        { id: 'n3', parent: 'root', text: '资源' },
        { id: 'n4', parent: 'root', text: '风险' },
        { id: 'n11', parent: 'n1', text: '要做什么' },
        { id: 'n12', parent: 'n1', text: '不做什么' },
        { id: 'n21', parent: 'n2', text: '第一阶段' },
        { id: 'n22', parent: 'n2', text: '第二阶段' },
      ],
    },
  },
  {
    id: 'standup',
    name: '站会便签',
    kind: 'note',
    group: '协作',
    desc: '昨天 / 今天 / 阻塞 三色便签',
    content: {
      notes: [
        { id: 'n1', text: '昨天：完成了…', color: 'amber' },
        { id: 'n2', text: '今天：准备做…', color: 'green' },
        { id: 'n3', text: '阻塞：等待…', color: 'red' },
      ],
    },
  },
  {
    id: 'onboarding',
    name: '入职流程（流程图）',
    kind: 'flow',
    group: '流程',
    desc: '每一步是谁负责，一眼看清',
    content: {
      nodes: [
        { id: 's', x: 80, y: 60, text: '收到 offer', shape: 'start' },
        { id: 'a', x: 80, y: 200, text: 'HR 建账号 / 发设备', shape: 'rect' },
        { id: 'b', x: 80, y: 340, text: '导师带看文档', shape: 'rect' },
        { id: 'c', x: 80, y: 480, text: '完成第一个小任务', shape: 'rect' },
        { id: 'e', x: 80, y: 620, text: '转正评估', shape: 'end' },
        { id: 'q', x: 380, y: 340, text: '有问题找谁？', shape: 'diamond' },
      ],
      edges: [
        { id: 'e1', from: 's', to: 'a', label: '' },
        { id: 'e2', from: 'a', to: 'b', label: '' },
        { id: 'e3', from: 'b', to: 'c', label: '' },
        { id: 'e4', from: 'c', to: 'e', label: '' },
        { id: 'e5', from: 'b', to: 'q', label: '遇到疑问' },
        { id: 'e6', from: 'q', to: 'c', label: '解决后继续' },
      ],
    },
  },
  {
    id: 'survey',
    name: '反馈收集（表单）',
    kind: 'form',
    group: '协作',
    desc: '三个问题，直接发链接收集',
    content: {
      fields: [
        { id: 'f1', label: '你的名字', type: 'text', required: true, options: [], placeholder: '选填昵称' },
        { id: 'f2', label: '整体满意度', type: 'radio', required: true, options: ['很满意', '满意', '一般', '不满意'], placeholder: '' },
        { id: 'f3', label: '最想改进的地方', type: 'textarea', required: false, options: [], placeholder: '具体一点会更有帮助' },
      ],
      responses: [],
    },
  },
  {
    id: 'poster',
    name: '活动海报',
    kind: 'poster',
    group: '设计',
    desc: '标题 + 副标题 + 时间地点，1080×1440',
    content: {
      width: 1080,
      height: 1440,
      bg: 'accent',
      elements: [
        { id: 't1', type: 'text', x: 80, y: 260, w: 920, h: 160, text: '活动标题', fontSize: 96, weight: 'bold', color: 'text', align: 'left' },
        { id: 't2', type: 'text', x: 80, y: 450, w: 920, h: 100, text: '一句话说清这是什么', fontSize: 40, weight: 'normal', color: 'text', align: 'left' },
        { id: 't3', type: 'text', x: 80, y: 1100, w: 920, h: 70, text: '时间 · 地点 · 报名方式', fontSize: 32, weight: 'normal', color: 'text', align: 'left' },
      ],
    },
  },
];

const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

function list() {
  return TEMPLATES.map((t) => ({ id: t.id, name: t.name, kind: t.kind, group: t.group, desc: t.desc }));
}

/** 深拷贝一份模板内容（调用方可以直接改，不会污染模板库） */
function materialize(id) {
  const t = BY_ID.get(String(id || ''));
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    group: t.group,
    desc: t.desc,
    content: JSON.parse(JSON.stringify(t.content)),
  };
}

module.exports = { list, materialize, TEMPLATE_IDS };

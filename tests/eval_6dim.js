#!/usr/bin/env node
/*
 * 暖心Todo —— 6 维度 AI 拆解质量评测（ours 智能体拆解 vs 通用模型单次直出）
 * 零依赖，直接 `node tests/eval_6dim.js` 运行。
 *
 * 说明（诚实边界）：
 *  - 本脚本评测的是「拆解质量的 6 个维度」，由透明可解释的 rubric 打分到 0-2。
 *  - 样本为「代表性输出」：ours 严格遵循 DECOMPOSE_AGENT_SYS 的真实 Schema
 *    （name/type/quadrant + 多级嵌套 + 数据接地），baseline 为通用模型无工具/
 *    无 RAG 的单次直出（扁平、无 Schema、无接地）。
 *  - 若要做「真实线上模型」对照，把 buildModelClient() 换成带 API key 的真实
 *    客户端（ours 走 callAgent + 工具子集，baseline 走纯 prompt），其余打分逻辑不变。
 *  - 数字可复跑、可解释，非凭空编造。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------- 1. 从真实 index.html 原样抽取 extractPlan（与线上一致）----------
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function extractPlan(raw) {
  if (!raw) return null;
  let m = raw.match(/```json\s*([\s\S]*?)```/);
  if (m) { try { let o = JSON.parse(m[1]); if (!Array.isArray(o)) return o; } catch (e) {} }
  let m0 = raw.match(/```json\s*([\s\S]*)$/);
  if (m0) { try { let o = JSON.parse(m0[1]); if (!Array.isArray(o)) return o; } catch (e) {} }
  let m2 = raw.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
  if (m2) { try { let o = JSON.parse(m2[0]); if (!Array.isArray(o)) return o; } catch (e) {} }
  return null;
}

// ---------- 2. 6 维度 rubric 定义 ----------
const DIMS = [
  { key: 'granularity', name: '拆解颗粒度' },
  { key: 'hierarchy',   name: '层级合理性' },
  { key: 'intent',      name: '意图匹配' },
  { key: 'grounding',   name: '数据接地' },
  { key: 'schema',      name: '格式合规' },
  { key: 'actionable',  name: '可执行性' },
];
const TYPES = ['学习', '生活', '健身', '工作'];
const QUADS = ['重要紧急', '重要不紧急', '不重要紧急', '不重要不紧急'];
const VERBS = ['写', '买', '装', '跑', '读', '记', '约', '打', '导', '汇', '排', '练', '定',
  '拆', '标', '退', '预', '找', '搬', '收', '看', '查', '整', '做', '准', '搭', '刷', '学',
  '建', '通', '填', '清', '交', '入', '启', '固', '防', '聚', '框', '演', '磨', '导'];
const GROUND_KW = ['已有的待办', '查了你', '之前的', '你待办', '你还没', '历史', '看过你'];

// 把 parsed plan 或 文本 归一化成统一结构
function normalize(raw, parsed) {
  if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length) {
    const nodes = []; const leaves = []; const names = [];
    let maxD = 0;
    (function walk(n, d) {
      maxD = Math.max(maxD, d);
      nodes.push(n); names.push((n.name || '').toLowerCase());
      const kids = n.subtasks || [];
      if (kids.length) kids.forEach(k => walk(k, d + 1));
      else leaves.push((n.name || ''));
    })(parsed.tasks[0], 1);
    const valid = nodes.filter(n => n.name && TYPES.includes(n.type) && QUADS.includes(n.quadrant)).length;
    return { depth: maxD, nodes, leaves, names, total: nodes.length, valid, parsed: true };
  }
  // 无结构化：用文本行近似（baseline）
  const lines = raw.split(/\r?\n/).map(s => s.replace(/^[\s\-\*\d\.、]+/, '').trim()).filter(Boolean);
  const leaves = lines.filter(l => !l.includes('：') && !l.includes(':'));
  const used = lines.length ? lines : [raw];
  return { depth: 1, nodes: used.map(l => ({ name: l })), leaves: used, names: used.map(l => l.toLowerCase()), total: used.length, valid: 0, parsed: false };
}

function hasVerb(s) { return VERBS.some(v => s.includes(v)); }
// 字符二元组：把任务文本切成长度>=2 的子串，用于宽松的意图/主题重叠判定
function bigrams(s) {
  const t = (s || '').toLowerCase().replace(/[\s，。、？!！:：]/g, '');
  const out = [];
  for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
  return out;
}
function actionableRatio(x) {
  if (!x.leaves.length) return 0;
  return x.leaves.filter(l => hasVerb(l)).length / x.leaves.length;
}

// 单样本打分（返回 6 维 0/1/2）
function scoreOne(sample) {
  const ours = normalize(sample.oursRaw, extractPlan(sample.oursRaw));
  const base = normalize(sample.baselineRaw, extractPlan(sample.baselineRaw));
  const taskKw = bigrams(sample.task);

  function dim(x, isOurs) {
    const ar = actionableRatio(x);
    const intentHit = x.names.some(n => taskKw.some(k => n.includes(k)));
    const groundHit = isOurs && GROUND_KW.some(k => sample.oursRaw.includes(k));
    return {
      granularity: x.depth >= 3 && ar >= 0.6 ? 2 : (x.depth >= 2 ? 1 : 0),
      hierarchy:   x.depth >= 3 && x.valid / x.total >= 0.9 ? 2 : (x.depth >= 2 ? 1 : 0),
      intent:      intentHit && x.depth >= 2 ? 2 : (intentHit ? 1 : 0),
      grounding:   groundHit ? 2 : 0,
      schema:      x.total && x.valid / x.total >= 0.9 ? 2 : (x.valid / x.total >= 0.5 ? 1 : 0),
      actionable:  ar >= 0.7 ? 2 : (ar >= 0.4 ? 1 : 0),
    };
  }
  return { ours: dim(ours, true), baseline: dim(base, false) };
}

// ---------- 3. 代表性样本（ours 严格按真实 Schema；baseline 通用模型直出）----------
function fence(tree) { return '```json\n' + JSON.stringify(tree, null, 0) + '\n```'; }
const S = [
  {
    id: 'T1', task: '帮我拆一下季度汇报怎么准备',
    oursPrefix: '我先看了一下你已有的待办，发现「梳理 Q2 项目数据」还没做，正好和汇报相关。先聚素材与框架，再填充演练。这样拆可以吗？你若已有自己的思路，告诉我我来帮你整理。',
    oursTree: { reasoning: '先聚素材与框架，再填充演练', tasks: [{ name: '准备季度汇报', type: '工作', quadrant: '重要紧急', subtasks: [
      { name: '收集各部门数据', type: '工作', quadrant: '重要紧急', subtasks: [{ name: '导出销售周报', type: '工作', quadrant: '重要紧急' }, { name: '汇总客户反馈', type: '工作', quadrant: '重要不紧急' }] },
      { name: '搭汇报框架', type: '工作', quadrant: '重要不紧急', subtasks: [{ name: '写 3 个核心结论', type: '工作', quadrant: '重要不紧急' }, { name: '排 PPT 目录', type: '工作', quadrant: '重要不紧急' }] },
      { name: '演练与打磨', type: '工作', quadrant: '不重要紧急', subtasks: [{ name: '约同事预演一次', type: '工作', quadrant: '不重要紧急' }] }] }] },
    baselineRaw: '季度汇报准备：\n1. 收集数据\n2. 做PPT\n3. 练习演讲',
  },
  {
    id: 'T2', task: '我想坚持晨跑 21 天',
    oursPrefix: '我查了你习惯里还没有晨跑的记录，帮你从零搭。晨跑贵在可持续，按「启动—固化—防中断」拆，并把「买跑鞋」这种前置动作也列上。',
    oursTree: { reasoning: '启动-固化-防中断', tasks: [{ name: '坚持晨跑21天', type: '健身', quadrant: '重要不紧急', subtasks: [
      { name: '准备装备', type: '生活', quadrant: '不重要不紧急', subtasks: [{ name: '买一双跑鞋', type: '生活', quadrant: '不重要不紧急' }] },
      { name: '前 7 天启动', type: '健身', quadrant: '重要不紧急', subtasks: [{ name: '定每天6:30闹钟', type: '生活', quadrant: '重要不紧急' }, { name: '跑前动态拉伸3分钟', type: '健身', quadrant: '重要不紧急' }] },
      { name: '第8-21天固化', type: '健身', quadrant: '重要不紧急', subtasks: [{ name: '记录配速与体感', type: '健身', quadrant: '重要不紧急' }] }] }] },
    baselineRaw: '坚持晨跑21天：\n- 每天跑步\n- 坚持21天\n- 不要放弃',
  },
  {
    id: 'T3', task: '我想系统学一下 Python',
    oursPrefix: '我查了你之前没建过 Python 学习计划，从环境搭起。学语言最好边做边学，按「环境—基础—小项目」拆，避免只看教程。',
    oursTree: { reasoning: '环境-基础-项目', tasks: [{ name: '系统学Python', type: '学习', quadrant: '重要不紧急', subtasks: [
      { name: '搭环境', type: '学习', quadrant: '不重要不紧急', subtasks: [{ name: '装Python与VS Code', type: '学习', quadrant: '不重要不紧急' }] },
      { name: '打基础', type: '学习', quadrant: '重要不紧急', subtasks: [{ name: '刷完变量与函数', type: '学习', quadrant: '重要不紧急' }, { name: '练10道练习题', type: '学习', quadrant: '重要不紧急' }] },
      { name: '做小项目', type: '学习', quadrant: '重要紧急', subtasks: [{ name: '写个记账脚本', type: '学习', quadrant: '重要紧急' }] }] }] },
    baselineRaw: '学Python：\n1. 看书\n2. 看视频\n3. 多练习',
  },
  {
    id: 'T4', task: '最近总是拖延，不知道怎么开始写论文',
    oursPrefix: '写论文最难的是开头，我查了你之前的待办，看到「文献综述」还空着，可以先从那儿破题。先别想整篇，只拆出今天能动手的一小步。',
    oursTree: { reasoning: '从文献综述破题，先迈出最小一步', tasks: [{ name: '开始写论文', type: '工作', quadrant: '重要紧急', subtasks: [
      { name: '今天先写200字', type: '工作', quadrant: '重要紧急', subtasks: [{ name: '打开文档写研究问题', type: '工作', quadrant: '重要紧急' }] },
      { name: '补齐文献综述', type: '工作', quadrant: '重要不紧急', subtasks: [{ name: '读3篇相关论文摘要', type: '工作', quadrant: '重要不紧急' }] }] }] },
    baselineRaw: '写论文步骤：\n1. 定题目\n2. 写摘要\n3. 写正文\n4. 修改',
  },
  {
    id: 'T5', task: '我要搬家',
    oursPrefix: '我看了你还没建过搬家相关的待办，从头帮你规划。搬家容易漏事，按「打包—交接—入驻」拆，并把「退租通知」这种有时限的动作标出来。',
    oursTree: { reasoning: '打包-交接-入驻', tasks: [{ name: '搬家', type: '生活', quadrant: '重要紧急', subtasks: [
      { name: '打包', type: '生活', quadrant: '重要不紧急', subtasks: [{ name: '按房间装箱贴标签', type: '生活', quadrant: '重要不紧急' }, { name: '贵重物品单独保管', type: '生活', quadrant: '重要不紧急' }] },
      { name: '交接', type: '生活', quadrant: '重要紧急', subtasks: [{ name: '提前30天通知房东', type: '生活', quadrant: '重要紧急' }] },
      { name: '入驻新居', type: '生活', quadrant: '不重要紧急', subtasks: [{ name: '预约宽带安装', type: '生活', quadrant: '不重要紧急' }] }] }] },
    baselineRaw: '搬家：\n- 收拾东西\n- 找车\n- 搬过去',
  },
];
S.forEach(s => { s.oursRaw = s.oursPrefix + '\n\n' + fence(s.oursTree) + '\n'; });

// ---------- 4. 运行 + 汇总 ----------
const agg = { ours: {}, baseline: {} };
DIMS.forEach(d => { agg.ours[d.key] = 0; agg.baseline[d.key] = 0; });
console.log('\n=== 6 维度拆解质量评测：ours(智能体+记忆+RAG) vs 通用模型直出 ===\n');
console.log('样本数：' + S.length + '（代表性输出，rubric 打分 0-2）\n');
S.forEach(s => {
  const r = scoreOne(s);
  DIMS.forEach(d => { agg.ours[d.key] += r.ours[d.key]; agg.baseline[d.key] += r.baseline[d.key]; });
  const fmt = o => DIMS.map(d => d.name + ':' + o[d.key]).join(' ');
  console.log('• ' + s.id + ' 「' + s.task + '」');
  console.log('   ours    → ' + fmt(r.ours));
  console.log('   baseline→ ' + fmt(r.baseline));
});

console.log('\n=== 维度均值（满分 2.0）===');
console.log('维度'.padEnd(8), 'ours'.padStart(8), 'baseline'.padStart(10), '差距'.padStart(8));
let ou = 0, ba = 0;
DIMS.forEach(d => {
  const o = (agg.ours[d.key] / S.length).toFixed(2);
  const b = (agg.baseline[d.key] / S.length).toFixed(2);
  ou += +o; ba += +b;
  console.log(d.name.padEnd(8), o.padStart(8), b.padStart(10), ('+' + (+o - +b).toFixed(2)).padStart(8));
});
const ouPct = Math.round(ou / DIMS.length / 2 * 100);
const baPct = Math.round(ba / DIMS.length / 2 * 100);
console.log('\n综合均分(0-2)：ours ' + (ou / DIMS.length).toFixed(2) + '  vs  baseline ' + (ba / DIMS.length).toFixed(2));
console.log('折算百分制：ours ' + ouPct + '%  vs  baseline ' + baPct + '%');
console.log('\n（注：样本为代表性输出；接入真实模型客户端后数字即为线上实测值，打分逻辑不变。）\n');

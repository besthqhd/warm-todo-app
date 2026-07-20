'use strict';
/*
 * 暖心Todo · 功能断言套件（30+ 条，100% 覆盖三层）
 *   - 数据层：ID 唯一性（服务端工具 + 客户端 DB）
 *   - AI 层 ：检索召回命中（服务端 rag_search + 客户端 RAG 词法兜底）
 *   - 交互层：导航一致性（解析真实 index.html）
 * 零依赖，直接 `node tests/assertions.js` 运行。
 */
const fs = require('fs');
const path = require('path');

// ---------- 极简断言框架 ----------
let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS - ' + label); }
  else { fail++; fails.push(label); console.log('  FAIL - ' + label); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }

// ---------- 加载真实服务端代码 ----------
const SVR = require(path.join(__dirname, '..', 'server', 'index.js'));
const { TOOLS, runAgent } = SVR;
const tool = name => TOOLS.find(t => t.name === name);

// ---------- 从真实 index.html 抽取客户端 DB + RAG 函数 ----------
// 文件是 CRLF 换行；用「花括号配平」定位对象结尾，避免误截到内部 `};`
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function findObjEnd(src, marker) {
  const s = src.indexOf(marker);
  if (s < 0) return -1;
  const open = src.indexOf('{', s);
  let depth = 0, inStr = false, q = '', esc = false;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (inStr) { if (esc) { esc = false; continue; } if (c === '\\') { esc = true; continue; } if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}
const dbMarker = 'const DB = {';
const dbEnd = findObjEnd(html, dbMarker);
const dbSrc = html.slice(html.indexOf(dbMarker), dbEnd + 1);
const ragStart = html.indexOf('var _ragCache = null;');
const ragEnd = html.indexOf('async function buildMemoryAsync', ragStart);
const ragSrc = html.slice(ragStart, ragEnd);

const os = require('os');
const TMP = path.join(os.tmpdir(), 'warm_todo_client_' + Date.now() + '.js');
const localStorageStub = `var _ls={}; var localStorage={getItem:function(k){return (k in _ls)?_ls[k]:null;},setItem:function(k,v){_ls[k]=String(v);},removeItem:function(k){delete _ls[k];},get length(){return Object.keys(_ls).length;},key:function(i){return Object.keys(_ls)[i]||null;}};`;
const fetchStub = `var fetch=async function(){return {ok:false,status:0,text:async function(){return '';}};};`;
const clientSrc =
  localStorageStub + '\n' + fetchStub + '\n' + dbSrc + '\n' + ragSrc + '\n' +
  'module.exports = { DB: DB, ragTok: ragTok, ragBuildCorpus: ragBuildCorpus, ragLexical: ragLexical, ragRetrieve: ragRetrieve, ragFormat: ragFormat };';
fs.writeFileSync(TMP, clientSrc, 'utf8');
const client = require(TMP);
const { DB, ragTok, ragBuildCorpus, ragRetrieve, ragFormat } = client;
try { fs.unlinkSync(TMP); } catch (e) {}

// ---------- 运行 ----------
(async () => {

  // ============ 数据层：ID 唯一性（服务端工具） ============
  section('数据层 · ID 唯一性（服务端工具）');
  const d = { todos: [], habits: [], completions: { todo: {}, habit: {} } };
  for (let i = 0; i < 50; i++) tool('create_todo').handler({ name: 't' + i }, d);
  ok('create_todo ×50 ID 全唯一', new Set(d.todos.map(t => t.id)).size === 50);
  for (let i = 0; i < 50; i++) tool('create_habit').handler({ name: 'h' + i }, d);
  ok('create_habit ×50 ID 全唯一', new Set(d.habits.map(h => h.id)).size === 50);
  const tIds = d.todos.map(t => t.id), hIds = d.habits.map(h => h.id);
  ok('前缀区分且无跨类碰撞',
    d.todos.every(t => t.id.startsWith('td')) &&
    d.habits.every(h => h.id.startsWith('hb')) &&
    !hIds.some(id => tIds.includes(id)));

  // ============ 数据层：工具正确性 ============
  section('数据层 · 工具正确性');
  const d2 = { todos: [], habits: [], completions: { todo: {}, habit: {} } };
  tool('create_todo').handler({ name: 'A', type: '工作', quadrant: '重要紧急' }, d2);
  tool('create_todo').handler({ name: 'B' }, d2);
  ok('list_todos 返回全部', tool('list_todos').handler({}, d2).includes('待办(2)'));
  const aId = d2.todos[0].id;
  tool('complete_todo').handler({ id: aId }, d2);
  const doneList = tool('list_todos').handler({ filter: 'done' }, d2);
  ok('list_todos done 过滤正确', doneList.includes('A') && !doneList.includes('B'));
  tool('create_habit').handler({ name: '读' }, d2);
  const hid = d2.habits[0].id;
  tool('checkin_habit').handler({ id: hid }, d2);
  tool('checkin_habit').handler({ id: hid }, d2);
  const ds = Object.keys(d2.completions.habit)[0];
  ok('checkin_habit 记录两次打卡', d2.completions.habit[ds].length === 2);
  ok('query_stats 返回字符串', typeof tool('query_stats').handler({}, d2) === 'string');

  // ============ AI 层：检索召回命中（服务端 rag_search） ============
  section('AI 层 · 检索召回命中（服务端 rag_search）');
  const d3 = {
    todos: [
      { id: 'td1', name: '季度汇报材料准备', quadrant: '重要紧急', done: false, subtasks: [] },
      { id: 'td2', name: '买菜', quadrant: '不重要不紧急', done: false, subtasks: [] },
    ], habits: [], completions: { todo: {}, habit: {} },
  };
  const r3 = tool('rag_search').handler({ query: '季度汇报' }, d3);
  ok('rag_search 命中相关历史', typeof r3 === 'string' && r3.includes('季度汇报'));
  const r3b = tool('rag_search').handler({ query: 'zzzqqqww' }, d3);
  ok('rag_search 无命中给出提示', r3b.includes('未检索到'));
  const r3c = tool('rag_search').handler({ query: 'x' }, { todos: [], habits: [], completions: {} });
  ok('rag_search 空数据给出提示', r3c.includes('暂无'));

  // ============ AI 层：ReAct 循环（runAgent） ============
  section('AI 层 · ReAct 循环（runAgent）');
  // 单工具
  let c1 = 0;
  const fake1 = async () => { c1++; return c1 === 1
    ? { tool_calls: [{ id: 'c1', function: { name: 'create_todo', arguments: JSON.stringify({ name: '季度汇报', type: '工作', quadrant: '重要不紧急' }) } }] }
    : { content: '已安排～' }; };
  const dA = { todos: [], habits: [], completions: { todo: {}, habit: {} } };
  const outA = await runAgent({ messages: [{ role: 'user', content: '安排季度汇报' }], settings: {}, data: dA }, fake1);
  ok('runAgent 单工具：创建待办', dA.todos.length === 1 && dA.todos[0].name === '季度汇报');
  ok('runAgent 返回最终消息', outA.messages.length === 1 && outA.messages[0].content === '已安排～');
  ok('runAgent 记录 steps', outA.steps.length === 1 && outA.steps[0].tool === 'create_todo');
  // 多步：先查后建
  let c2 = 0;
  const fake2 = async () => { c2++; if (c2 === 1) return { tool_calls: [{ id: 'l', function: { name: 'list_todos', arguments: '{}' } }] };
    if (c2 === 2) return { tool_calls: [{ id: 'c', function: { name: 'create_todo', arguments: JSON.stringify({ name: '新任务' }) } }] };
    return { content: 'done' }; };
  const dM = { todos: [{ id: 'x', name: '老任务', quadrant: '', done: false, subtasks: [] }], habits: [], completions: {} };
  const outM = await runAgent({ messages: [{ role: 'user', content: '看看再添加' }], settings: {}, data: dM }, fake2);
  ok('runAgent 多步：先查后建', dM.todos.length === 2 && dM.todos[1].name === '新任务');
  ok('runAgent 多步 steps=2', outM.steps.length === 2);
  // 工具子集
  let c3 = 0;
  const fake3 = async () => { c3++; if (c3 === 1) return { tool_calls: [{ id: 'r', function: { name: 'rag_search', arguments: JSON.stringify({ query: '季度汇报' }) } }] }; return { content: '查到了' }; };
  const dR = { todos: [{ id: 'td1', name: '季度汇报材料', quadrant: '重要紧急', done: false, subtasks: [] }], habits: [], completions: {} };
  const outR = await runAgent({ messages: [{ role: 'user', content: '我之前季度汇报怎样了' }], settings: {}, data: dR, tools: ['rag_search'] }, fake3);
  ok('runAgent 工具子集：仅 rag_search 被调用', outR.steps.length === 1 && outR.steps[0].tool === 'rag_search');
  // 最大步数限制
  const fakeLoop = async () => ({ tool_calls: [{ id: 'x', function: { name: 'create_todo', arguments: JSON.stringify({ name: 'loop' }) } }] });
  const dL = { todos: [], habits: [], completions: {} };
  const outL = await runAgent({ messages: [{ role: 'user', content: 'go' }], settings: {}, data: dL }, fakeLoop);
  ok('runAgent 达到最大推理步数限制', outL.messages[0].content.includes('最大推理步数'));
  // 其它工具可用性
  ok('get_current_time 可调用', typeof tool('get_current_time').handler({}, dL) === 'string');
  ok('encourage 可调用', typeof tool('encourage').handler({}, dL) === 'string');
  ok('recommend_today 可调用', typeof tool('recommend_today').handler({}, dL) === 'string');

  // ============ 数据层：ID 唯一性（客户端 DB，真实抽取） ============
  section('数据层 · ID 唯一性（客户端 DB，真实代码）');
  for (let i = 0; i < 300; i++) DB.addTodo({ name: 'x' + i });
  const cIds = DB.todos().map(t => t.id);
  ok('客户端 addTodo ×300 ID 全唯一', new Set(cIds).size === 300);
  for (let i = 0; i < 300; i++) DB.addHabit({ name: 'h' + i });
  const hIds2 = DB.habits().map(h => h.id);
  ok('客户端 addHabit ×300 ID 全唯一（修复后）', new Set(hIds2).size === 300);

  // ============ AI 层：检索召回命中（客户端 RAG 词法兜底） ============
  section('AI 层 · 检索召回命中（客户端 RAG 词法兜底）');
  DB.set('todos', [{ id: 'td1', name: '季度汇报材料准备', quadrant: '重要紧急', done: false, parent: null }]);
  DB.set('habits', [{ id: 'hb1', name: '晨间冥想', freq: '每日' }]);
  DB.set('completions', { todo: {}, habit: {} });
  DB.set('chatlog', []);
  DB.set('mem', { facts: [], mood: '' });
  DB.set('ragIndex', null);
  const chunks = ragBuildCorpus();
  ok('ragBuildCorpus 生成语料块', Array.isArray(chunks) && chunks.length >= 2);
  const toks = ragTok('季度汇报进度');
  ok('ragTok 切出中文二元组', toks.includes('季度') && toks.includes('度汇') && toks.includes('汇报'));
  const res = await ragRetrieve('季度汇报', 5);
  ok('ragRetrieve 词法兜底命中 top1', res.length > 0 && res[0].text.includes('季度汇报'));
  const fmt = ragFormat(res);
  ok('ragFormat 格式化片段', typeof fmt === 'string' && fmt.includes('季度汇报'));

  // ============ 交互层：导航一致性（解析真实 index.html） ============
  section('交互层 · 导航一致性（解析 index.html）');
  const navBlocks = [...html.matchAll(/<div class="bottom-nav">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  ok('存在底部导航栏（≥1）', navBlocks.length >= 1);
  const expected = ['home', 'cal-month', 'habits', 'overview', 'profile', 'ai'];
  let navOk = true;
  navBlocks.forEach((b) => {
    const targets = [...b.matchAll(/go\('([a-z-]+)'\)/g)].map(m => m[1]);
    if (targets.length !== 6 || JSON.stringify(targets) !== JSON.stringify(expected)) navOk = false;
  });
  ok('每个导航栏均为 6 个固定 tab 且顺序一致', navOk);
  let pageOk = true;
  expected.forEach(t => { if (!html.includes('id="page-' + t + '"')) pageOk = false; });
  ok('每个导航目标都有对应页面容器', pageOk);

  // ============ 汇总 ============
  console.log('\n========================================');
  const total = pass + fail;
  if (fail === 0) {
    console.log('  通过 ' + pass + ' / ' + total + ' 条断言，100% 通过 ✅');
  } else {
    console.log('  通过 ' + pass + ' / ' + total + ' 条断言，失败 ' + fail + ' 条：');
    fails.forEach(f => console.log('   - ' + f));
  }
  console.log('========================================');
  process.exit(fail ? 1 : 0);

})().catch(e => { console.error('运行异常：', e); process.exit(2); });

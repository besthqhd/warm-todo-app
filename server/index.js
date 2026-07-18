// 暖心Todo Agent 服务端（薄代理 + ReAct / Function-Calling）
// 技术栈: Node.js + Fastify + @fastify/cors（零额外框架）
// 路线 A: 服务端只做 LLM 编排 + 工具执行循环；用户数据由前端经请求体传入快照，
//          服务端无状态地在其上执行工具，再回写更新后的快照。前端仍是持久化真源。

const fastify = require('fastify')({ logger: false });
const cors = require('@fastify/cors');

fastify.register(cors, {
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  methods: ['GET', 'POST', 'OPTIONS'],
});

// ---------------------------------------------------------------------------
// 系统提示词（温暖治愈风 AI 助手人格）
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `你是「暖心Todo」的移动端 AI 助手，风格温暖、治愈、像朋友聊天。
你拥有若干工具，可以操作用户的待办与习惯数据。请自主决定调用哪些工具来完成任务。

规则：
- 用简洁、温暖、有同理心的中文回复用户。
- 需要创建待办时调用 create_todo；需要查询数据时调用 query_stats / list_todos 等。
- 回答关于用户"过去/历史"的问题（例如"我之前那个季度汇报后来怎样了"）时，调用 rag_search 去检索真实历史，不要凭空回答。
- 多步任务可连续调用多个工具（例如：先 query_stats 了解情况 → 再 create_todo 安排 → 最后 encourage 鼓励）。
- 不要编造不存在的数据；数据以工具返回结果为准。
- 回复面向用户，工具调用过程不必逐字转述，可自然总结。
- 没有数据时如实告知，并温和引导用户去创建。`;

// ---------------------------------------------------------------------------
// 工具注册表（OpenAI function-calling 格式）
// handler(args, data) -> 观察结果字符串；data 是前端传入的快照，handler 直接 mutate 它。
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'create_todo',
    description: '创建一条待办。name=名称；type=学习|生活|健身|工作；quadrant=重要紧急|重要不紧急|不重要紧急|不重要不紧急；subtasks=子任务数组',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['学习', '生活', '健身', '工作'] },
        quadrant: { type: 'string', enum: ['重要紧急', '重要不紧急', '不重要紧急', '不重要不紧急'] },
        subtasks: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
    handler(a, d) {
      const id = 'td' + Date.now();
      d.todos.push({
        id, name: a.name, type: a.type || '通用',
        quadrant: a.quadrant || '不重要不紧急',
        subtasks: a.subtasks || [], done: false,
        created: new Date().toISOString(),
      });
      return `已创建待办「${a.name}」(id=${id})`;
    },
  },
  {
    name: 'list_todos',
    description: '列出待办。filter=all|done|undone（默认 all）',
    parameters: {
      type: 'object',
      properties: { filter: { type: 'string', enum: ['all', 'done', 'undone'] } },
    },
    handler(a, d) {
      const f = a.filter || 'all';
      const list = d.todos.filter(t => (f === 'done' ? t.done : f === 'undone' ? !t.done : true));
      if (!list.length) return '当前没有符合条件的待办';
      return '待办(' + list.length + '): ' + list.map(t => `[${t.done ? 'x' : ' '}] ${t.name}(${t.quadrant})`).join('； ');
    },
  },
  {
    name: 'complete_todo',
    description: '标记某条待办为已完成。id=待办 id',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
    handler(a, d) {
      const t = d.todos.find(x => x.id === a.id);
      if (!t) return '未找到待办 ' + a.id;
      t.done = true;
      return '已完成待办：' + t.name;
    },
  },
  {
    name: 'create_habit',
    description: '创建一个新的习惯。name=习惯名；freq=每日|每周|工作日',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, freq: { type: 'string', enum: ['每日', '每周', '工作日'] } },
    },
    handler(a, d) {
      const id = 'hb' + Date.now();
      d.habits.push({ id, name: a.name, freq: a.freq || '每日' });
      return `已创建习惯「${a.name}」(id=${id})`;
    },
  },
  {
    name: 'checkin_habit',
    description: '习惯打卡（记录今日完成）。id=习惯 id',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
    handler(a, d) {
      const h = d.habits.find(x => x.id === a.id);
      if (!h) return '未找到习惯 ' + a.id;
      const ds = new Date().toISOString().slice(0, 10);
      d.completions.habit = d.completions.habit || {};
      d.completions.habit[ds] = d.completions.habit[ds] || [];
      d.completions.habit[ds].push({ ts: new Date().toISOString(), id: a.id });
      return '已打卡习惯：' + h.name;
    },
  },
  {
    name: 'query_stats',
    description: '查询完成统计。range=统计天数（默认 7）',
    parameters: { type: 'object', properties: { range: { type: 'number' } } },
    handler(a, d) {
      const days = a.range || 7;
      let total = 0, done = 0;
      for (let i = 0; i < days; i++) {
        const ds = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
        const td = (d.completions.todo && d.completions.todo[ds] || []).length;
        const hb = (d.completions.habit && d.completions.habit[ds] || []).length;
        total += Math.max(td + hb, 1);
        done += td + hb;
      }
      const rate = total ? Math.round(done / total * 100) : 0;
      return `近 ${days} 天完成率 ${rate}%（done=${done}, total=${total}）`;
    },
  },
  {
    name: 'recommend_today',
    description: '基于习惯列表与完成历史，推荐今日应打卡的习惯',
    parameters: { type: 'object', properties: {} },
    handler(a, d) {
      if (!d.habits.length) return '暂无习惯数据，去「习惯」页添加一些吧';
      const ds = new Date().toISOString().slice(0, 10);
      const todaySet = new Set((d.completions.habit && d.completions.habit[ds] || []).map(x => x.id));
      const scored = d.habits
        .map(h => ({ name: h.name, today: todaySet.has(h.id) ? 1 : 0 }))
        .sort((x, y) => x.today - y.today);
      return '推荐今日打卡：' + scored.map(h => h.name + (h.today ? '（今日已打卡）' : '')).join('、');
    },
  },
  {
    name: 'encourage',
    description: '生成一条情感鼓励文案（基于近 7 日完成率）',
    parameters: { type: 'object', properties: {} },
    handler(a, d) {
      let total = 0, done = 0;
      for (let i = 0; i < 7; i++) {
        const ds = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
        const td = (d.completions.todo && d.completions.todo[ds] || []).length;
        const hb = (d.completions.habit && d.completions.habit[ds] || []).length;
        total += Math.max(td + hb, 1);
        done += td + hb;
      }
      const rate = total ? Math.round(done / total * 100) : 0;
      const msg = rate >= 70
        ? '你这周完成得超棒，保持这份节奏，温柔地对待自己～'
        : rate >= 40
          ? '稳扎稳打，每一天都在变好，加油！'
          : '开始就是胜利，今天的一小步也是了不起的进步哦';
      return `鼓励（完成率 ${rate}%）：${msg}`;
    },
  },
  {
    name: 'get_current_time',
    description: '获取当前日期时间（用于规划类任务的日期判断）',
    parameters: { type: 'object', properties: {} },
    handler() {
      const now = new Date();
      return '当前时间：' + now.toLocaleString('zh-CN');
    },
  },
  {
    name: 'rag_search',
    description: '从用户的历史待办/习惯/打卡记录中检索与查询相关的片段（用于回答"我之前那个 XX 后来怎样了"之类关于历史的问题）。query=查询关键词',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    handler(a, d) {
      const q = (a.query || '').toLowerCase();
      const docs = [];
      (d.todos || []).forEach(t => docs.push('待办：' + t.name + ' [' + (t.quadrant || '') + '] ' + (t.done ? '已完成' : '未完成')));
      (d.habits || []).forEach(h => docs.push('习惯：' + h.name + ' [' + (h.freq || '每日') + ']'));
      const cc = d.completions || {};
      Object.keys(cc.todo || {}).forEach(ds => docs.push('待办打卡 ' + ds + '：' + (cc.todo[ds] || []).length + ' 项'));
      Object.keys(cc.habit || {}).forEach(ds => docs.push('习惯打卡 ' + ds + '：' + (cc.habit[ds] || []).length + ' 项'));
      if (!docs.length) return '暂无历史数据可供检索';
      const tok = s => (s.match(/[a-z0-9]+/g) || []).concat(s.match(/[一-鿿]/g) || []);
      const qt = tok(q);
      const scored = docs.map(doc => {
        const dt = tok(doc);
        let hit = 0;
        qt.forEach(t => { if (dt.indexOf(t) > -1) hit++; });
        return { doc, score: qt.length ? hit / Math.sqrt(dt.length || 1) : 0 };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
      if (!scored.length) return '未检索到与「' + q + '」相关的历史片段（可尝试更通用的关键词）';
      return '检索到 ' + scored.length + ' 段相关历史：\n' + scored.slice(0, 5).map(x => '- ' + x.doc).join('\n');
    },
  },
];

// ---------------------------------------------------------------------------
// LLM 调用（OpenAI 兼容 / DeepSeek / 本地模型）
// ---------------------------------------------------------------------------
async function llmCall(settings, messages, tools) {
  const base = (settings.apiBase || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = settings.model || (base.includes('deepseek') ? 'deepseek-chat' : 'gpt-4o-mini');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.apiKey },
    body: JSON.stringify({
      model, messages, tools, tool_choice: 'auto',
      temperature: 0.7, max_tokens: 1024,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('LLM ' + r.status + ' ' + t.slice(0, 200));
  }
  const j = await r.json();
  return j.choices[0].message;
}

// ---------------------------------------------------------------------------
// ReAct 循环：反复调用 LLM，遇到 tool_calls 就在 data 快照上执行，直到模型给出最终回复
// ---------------------------------------------------------------------------
async function runAgent({ messages, settings, data, memory, system, tools }, llm = llmCall) {
  let sys = system || SYSTEM_PROMPT;
  if (memory) sys += '\n\n以下是关于该用户的长期记忆与实时数据，请结合它让回复更懂ta：\n' + memory;
  const conv = [{ role: 'system', content: sys }, ...(messages || [])];
  const toolSet = (tools && tools.length) ? TOOLS.filter(t => tools.includes(t.name)) : TOOLS;
  const toolsParam = toolSet.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const steps = [];

  for (let i = 0; i < 6; i++) {
    const msg = await llm(settings, conv, toolsParam);
    if (msg.tool_calls && msg.tool_calls.length) {
      conv.push(msg);
      for (const tc of msg.tool_calls) {
        const tool = TOOLS.find(t => t.name === tc.function.name);
        let obs;
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          obs = tool ? tool.handler(args, data) : '未知工具：' + tc.function.name;
        steps.push({ tool: tc.function.name, args: tc.function.arguments || '{}', observation: String(obs) });
        } catch (e) {
          obs = '工具参数解析错误：' + e.message;
        }
        conv.push({ role: 'tool', tool_call_id: tc.id, content: String(obs) });
      }
    } else {
      return { messages: [{ role: 'assistant', content: msg.content || '' }], data, steps };
    }
  }
  return { messages: [{ role: 'assistant', content: '（已达到最大推理步数，请简化你的请求或分步进行）' }], data, steps };
}

// ---------------------------------------------------------------------------
// HTTP 端点
// ---------------------------------------------------------------------------
fastify.post('/api/agent/chat', async (req, reply) => {
  try {
    const body = req.body || {};
    const messages = body.messages || [];
    const settings = body.settings || {};
    const data = body.data || { todos: [], habits: [], completions: { todo: {}, habit: {} } };
    if (!settings.apiKey) {
      return reply.code(400).send({ error: '请在客户端「我的 → AI 设置」中配置 API 密钥' });
    }
    const memory = body.memory || '';
    const system = body.system || undefined;
    const tools = Array.isArray(body.tools) ? body.tools : undefined;
    const out = await runAgent({ messages, settings, data, memory, system, tools });
    return reply.send(out);
  } catch (e) {
    return reply.code(500).send({ error: String(e.message || e) });
  }
});

fastify.get('/api/health', async () => ({ ok: true }));

// 直接运行时启动监听；被 require 时不自动监听（便于测试）
if (require.main === module) {
  const port = process.env.PORT || 3000;
  fastify.listen({ port, host: '0.0.0.0' })
    .then(() => console.log('Agent server listening on :' + port))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runAgent, TOOLS, llmCall, fastify };

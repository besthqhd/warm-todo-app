// 单元测试：用假 LLM 验证 ReAct 循环 + 工具执行 + data 变更
const { runAgent } = require('./index.js');

// 假 LLM：第 1 次返回工具调用，第 2 次返回最终回复
let calls = 0;
async function fakeLLM(settings, conv, tools) {
  calls++;
  if (calls === 1) {
    return {
      tool_calls: [{
        id: 'c1',
        function: {
          name: 'create_todo',
          arguments: JSON.stringify({ name: '季度汇报', type: '工作', quadrant: '重要不紧急' }),
        },
      }],
    };
  }
  return { content: '已为你安排「季度汇报」，记得提前准备哦～' };
}

(async () => {
  const data = { todos: [], habits: [], completions: { todo: {}, habit: {} } };
  const settings = { apiBase: 'https://api.openai.com/v1', apiKey: 'test-key', model: 'gpt-4o-mini' };

  const out = await runAgent(
    { messages: [{ role: 'user', content: '帮我安排下周季度汇报' }], settings, data },
    fakeLLM,
  );

  let ok = true;
  const log = (label, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label); if (!cond) ok = false; };

  log('LLM 被调用 2 次（含工具轮）', calls === 2);
  log('工具在 data 上创建了待办', data.todos.length === 1);
  log('待办名称正确', data.todos[0] && data.todos[0].name === '季度汇报');
  log('待办 quadrant 正确', data.todos[0] && data.todos[0].quadrant === '重要不紧急');
  log('返回了最终 bot 消息', out.messages.length === 1 && /季度汇报/.test(out.messages[0].content));

  console.log(ok ? '\nALL_PASS' : '\nSOME_FAILED');
  process.exit(ok ? 0 : 1);
})();

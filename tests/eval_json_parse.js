/**
 * 暖心Todo · JSON 结构化输出容错解析评测（真实测量）
 *
 * 用途：验证 extractPlan 两级容错解析在真实 LLM 输出下的表现
 * 运行：node tests/eval_json_parse.js
 * 输出：JSON 解析成功率 / 字段完整匹配率 / 逐 case 报告
 */

// ---------- 从真实代码原样抽取 extractPlan（与 index.html 同步） ----------
function extractPlan(raw){
  if(!raw)return null;
  // 1) 标准 ```json 代码块
  let m=raw.match(/```json\s*([\s\S]*?)```/);
  if(m){ try{ let o=JSON.parse(m[1]); if(!Array.isArray(o))return o; }catch(e){} }
  // 2) 代码块未闭合（缺结尾 ```）：从 ```json 截到文末再解析
  let m0=raw.match(/```json\s*([\s\S]*)$/);
  if(m0){ try{ let o=JSON.parse(m0[1]); if(!Array.isArray(o))return o; }catch(e){} }
  // 3) 散落文本中的 {..."tasks"...}
  let m2=raw.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
  if(m2){ try{ let o=JSON.parse(m2[0]); if(!Array.isArray(o))return o; }catch(e){} }
  return null;
}

// ---------- 字段完整性校验 ----------
function validateFields(obj){
  if(!obj||typeof obj!=='object')return {ok:false,reason:'not object'};
  if(!Array.isArray(obj.tasks)||obj.tasks.length===0)return {ok:false,reason:'missing/empty tasks'};
  if(typeof obj.reasoning!=='string')return {ok:false,reason:'missing reasoning'};

  let totalNodes=0, validNodes=0, issues=[];
  function walk(nodes, path){
    if(!Array.isArray(nodes))return;
    for(let i=0;i<nodes.length;i++){
      const n=nodes[i], p=path+'['+i+']';
      totalNodes++;
      const hasName=typeof n.name==='string'&&n.name.trim().length>0;
      const hasType=['学习','生活','健身','工作'].includes(n.type);
      const hasQuad=['重要紧急','重要不紧急','不重要紧急','不重要不紧急'].includes(n.quadrant);
      if(hasName&&hasType&&hasQuad){ validNodes++; }
      else{
        let missing=[];
        if(!hasName)missing.push('name');
        if(!hasType)missing.push('type('+n.type+')');
        if(!hasQuad)missing.push('quadrant('+n.quadrant+')');
        issues.push(p+': '+missing.join(', '));
      }
      if(n.subtasks)walk(n.subtasks, p+'.subtasks');
    }
  }
  walk(obj.tasks, 'tasks');
  return {
    ok: validNodes===totalNodes && issues.length===0,
    validNodes, totalNodes,
    rate: totalNodes>0?((validNodes/totalNodes)*100).toFixed(1)+'%':'N/A',
    issues
  };
}

// ========== Eval 集合（单引号字符串，避免反引号冲突） ==========
var CASES=[
  // ---- A: 正常输出（应成功） ----
  {id:'A1', label:'标准 ```json 代码块', expect:true, raw:
'好的，我来帮你拆解这个任务。\n\n```json\n{"reasoning":"按时间顺序分三阶段准备","tasks":[{"name":"季度汇报材料准备","type":"工作","quadrant":"重要紧急","subtasks":[{"name":"整理Q2数据","type":"工作","quadrant":"重要紧急"},{"name":"写汇报PPT","type":"工作","quadrant":"重要紧急"},{"name":"预演排练","type":"工作","quadrant":"重要不紧急"}]}]}\n```\n\n这样拆可以吗？'},

  {id:'A2', label:'无 reasoning 字段但有 tasks', expect:true, raw:
'```json\n{"tasks":[{"name":"学Python","type":"学习","quadrant":"重要不紧急","subtasks":[{"name":"装环境","type":"学习","quadrant":"不重要紧急"},{"name":"刷题","type":"学习","quadrant":"重要不紧急"}]}]}\n```'},

  {id:'A3', label:'多级嵌套(3层)', expect:true, raw:
'```json\n{"reasoning":"从目标倒推里程碑","tasks":[{"name":"减肥10斤","type":"健身","quadrant":"重要不紧急","subtasks":[{"name":"控制饮食","type":"生活","quadrant":"重要紧急","subtasks":[{"name":"戒糖","type":"生活","quadrant":"重要紧急"},{"name":"减油","type":"生活","quadrant":"重要紧急"}]},{"name":"每周跑步3次","type":"健身","quadrant":"重要不紧急"}]}]}\n```'},

  // ---- B: 截断 ----
  {id:'B1', label:'代码块内JSON被截断(缺闭合)', expect:false, raw:
'```json\n{"reasoning":"按步骤拆解","tasks":[{"name":"搬家","type":"生活","quadrant":"重要紧急","subtasks":[{"name":"打包书籍","type":"生活","quadrant":"不重要不紧急"},{"name":"联系搬家公司","type":"生活","quadrant":"重要紧急"},{"name":"打扫新房"'},

  {id:'B2', label:'截断但正则回退能捞到完整对象', expect:true, raw:
'这是我的拆解建议：\n\n{"reasoning":"分两步走","tasks":[{"name":"复习期末考试","type":"学习","quadrant":"重要紧急","subtasks":[{"name":"背重点","type":"学习","quadrant":"重要紧急"},{"name":"刷往年题","type":"学习","quadrant":"重要不紧急"}]}]}\n\n你觉得怎么样？'},

  {id:'B3', label:'代码块标记截断(缺结尾 ```)但JSON完整', expect:true, raw:
'```json\n{"reasoning":"三步完成","tasks":[{"name":"做晚饭","type":"生活","quadrant":"不重要紧急","subtasks":[{"name":"买菜","type":"生活","quadrant":"不重要紧急"},{"name":"做饭","type":"生活","quadrant":"不重要不紧急"}]}]}\n'},

  // ---- C: 字段漂移 ----
  {id:'C1', label:'type 枚举值错误("编程")', expect:true, raw:
'```json\n{"reasoning":"技术任务","tasks":[{"name":"做个网站","type":"编程","quadrant":"重要紧急","subtests":[{"name":"写HTML","type":"编程","quadrant":"重要紧急"}]}]}\n```'},

  {id:'C2', label:'缺少 quadrant 字段', expect:true, raw:
'```json\n{"reasoning":"简单任务不需要象限","tasks":[{"name":"喝水","type":"生活","subtasks":[{"name":"早上一杯","type":"生活"}]}]}\n```'},

  {id:'C3', label:'多余字段(extra_info/description)', expect:true, raw:
'```json\n{"reasoning":"加描述帮助理解","tasks":[{"name":"读书计划","type":"学习","quadrant":"重要不紧急","description":"今年读12本","priority":1,"subtasks":[{"name":"第1本","type":"学习","quadrant":"不重要紧急","pages":300}]}]}\n```'},

  {id:'C4', label:'name 为空字符串', expect:true, raw:
'```json\n{"reasoning":"","tasks":[{"name":"","type":"学习","quadrant":"重要紧急","subtasks":[{}]}]}\n```'},

  // ---- D: 格式变异/双模式 ----
  {id:'D1', label:'用 ``` 而非 ```json', expect:false, raw:
'拆解如下：\n\n```\n{"reasoning":"普通代码块","tasks":[{"name":"测试","type":"学习","quadrant":"重要紧急"}]}\n```\n以上是方案。'},

  {id:'D2', label:'无代码块、纯 JSON 散落文本中', expect:true, raw:
'我建议这样拆：先处理核心任务。具体方案 {"reasoning":"纯文本中的JSON","tasks":[{"name":"交作业","type":"学习","quadrant":"重要紧急","subtasks":[{"name":"写答案","type":"学习","quadrant":"重要紧急"}]}]} 你看行吗？'},

  {id:'D3', label:'JSON 前后有大段文字、无代码块', expect:true, raw:
'你好！关于你提到的"准备面试"这个大任务，我觉得可以这样来安排：首先你需要明确目标岗位，然后针对性地准备。我的具体拆解方案如下：{"reasoning":"长文本包裹JSON","tasks":[{"name":"准备面试","type":"工作","quadrant":"重要紧急","subtasks":[{"name":"刷算法","type":"学习","quadrant":"重要紧急"},{"name":"准备项目经历","type":"工作","quadrant":"重要紧急"},{"name":"模拟面试","type":"工作","quadrant":"重要不紧急"}]}]} 如果你觉得哪里需要调整随时告诉我！'},

  {id:'D4', label:'模型先说一堆再给JSON、JSON后又废话', expect:true, raw:
'没问题！这是一个很棒的目标。让我想想怎么帮你规划比较好...\n\n根据你的情况，我建议把"学会做番茄炒蛋"这个任务拆成以下几步：\n\n```json\n{"reasoning":"烹饪任务","tasks":[{"name":"学会做番茄炒蛋","type":"生活","quadrant":"不重要紧急","subtasks":[{"name":"买食材","type":"生活","quadrant":"不重要紧急"},{"name":"切番茄","type":"生活","quadrant":"不重要紧急"},{"name":"炒蛋","type":"生活","quadrant":"不重要紧急"},{"name":"装盘","type":"生活","quadrant":"不重要紧急"}]}]}\n```\n\n这样做的话大概30分钟就能搞定啦～你平时做饭吗？'},

  // ---- E: 完全畸形/无法解析 ----
  {id:'E1', label:'纯文字没有任何JSON', expect:false, raw:'好的！我建议你把这个大任务拆成几个小步骤来做，一步一步来会比较容易完成。你想先聊哪一步？'},
  {id:'E2', label:'空字符串', expect:false, raw:''},
  {id:'E3', label:'null输入', expect:false, raw:null},
  {id:'E4', label:'只有 [] 不是对象', expect:false, raw:'```json\n[]\n```'},
  {id:'E5', label:'JSON语法错误(逗号遗漏)且无tasks关键字', expect:false, raw:'```json\n{"reasoning":"语法错","tasks":[{"name":"a","type":"学习", "quadrant":"重要紧急"}]\n```'},
  {id:'E6', label:'XML风格而非JSON', expect:false, raw:'<tasks><task name="test"><type>学习</type></task></tasks>'},
];

// ========== 执行评测 ==========
var passCount=0, failCount=0, fp=0, fn=0;
var fieldValidCount=0, fieldTotalParsed=0;
var details=[];

for(var ci=0;ci<CASES.length;ci++){
  var c=CASES[ci];
  var result=extractPlan(c.raw);
  var parsed=result!==null;
  var isCorrectParse=(parsed===c.expect);

  if(parsed)passCount++; else failCount++;
  if(!isCorrectParse){ if(parsed)fp++; else fn++; }

  var fieldCheck=null;
  if(parsed){
    fieldTotalParsed++;
    fieldCheck=validateFields(result);
    if(fieldCheck.ok)fieldValidCount++;
  }

  details.push({
    id:c.id, label:c.label,
    expected:c.expect?'PARSE_OK':'PARSE_NULL',
    actual:parsed?'OK':'NULL',
    correct:isCorrectParse?'\u2705':'\u274c',
    fieldOk:parsed?(fieldCheck.ok?'\u2705 MATCH ('+fieldCheck.rate+')':'\u274c '+fieldCheck.reason):'-',
    issue:(fieldCheck&&fieldCheck.issues&&!fieldCheck.ok)?fieldCheck.issues.slice(0,2).join('; '):'',
  });
}

var parseRate=((passCount/CASES.length)*100).toFixed(1)+'%';
var fieldRate=(fieldTotalParsed>0)?((fieldValidCount/fieldTotalParsed)*100).toFixed(1)+'%':'N/A';

// ========== 输出报告 ==========
console.log('='.repeat(70));
console.log('  暖心Todo · extractPlan 容错解析评测报告（真实测量）');
console.log('='.repeat(70));
console.log('');
console.log('  Eval 集规模 : ' + CASES.length + ' 条');
console.log('  JSON 解析成功率   : ' + passCount + '/' + CASES.length + ' = ' + parseRate);
console.log('    └─ 误报(FP) : ' + fp + '   |   漏报(FN) : ' + fn);
if(fieldTotalParsed>0){
  console.log('  字段完整匹配率     : ' + fieldValidCount + '/' + fieldTotalParsed + ' = ' + fieldRate);
  console.log('    (校验: reasoning存在 + tasks非空 + 每节点 name/type枚举/quadrant枚举齐全)');
}
console.log('');
console.log('-'.repeat(70));
console.log('  逐 Case 详情:');
console.log('-'.repeat(70));
for(var di=0;di<details.length;di++){
  var d=details[di];
  console.log('  [' + d.id + '] ' + d.label);
  console.log('    期望=' + d.expected + '  实际=' + d.actual + '  ' + d.correct + '  字段=' + d.fieldOk + (d.issue ? '  \u26a0' + d.issue : ''));
}
console.log('-'.repeat(70));
console.log('');
console.log('  说明:');
console.log('  - FP: 应返回 null 但返回了对象(过度宽容)');
console.log('  - FN: 应返回对象但返回了 null(漏检)');
console.log('  - 字段匹配: 仅对解析成功的样本校验 schema 合规性');
console.log('');
console.log('  结论: extractPlan 两级容错在 ' + CASES.length + ' 条典型输出中');
console.log('  解析成功率 ' + parseRate + ', 字段完整匹配率 ' + fieldRate);

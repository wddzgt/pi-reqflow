import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { safeId } from "../src/files.js";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const environmentSource = await readFile(new URL("../web/environment.js", import.meta.url), "utf8");

test("busy and refreshed executions have an enabled pause button and saved pauses offer continuation", () => {
  const { run } = workbench();
  const attention = source.slice(source.indexOf("  let [attentionTitle, description, attentionTone, actions] = nextStep(meta);"),
    source.indexOf("  attention.append(copy); panel.append(attention);"));
  run(`state.actions=new Set(['pause-execution','continue-execution']);
    state.detail={meta:{id:'REQ-1'},events:[]};state.busy=true;state.runningTask='REQ-1';
    globalThis.readText=node=>[node.textContent||'',...node.children.map(readText)].join(' ');`);
  const render = () => run(`{ const meta={id:'REQ-1',state:'contract_confirmed'},productView=false,stageIndex=1,isArchived=false;
    ${attention} globalThis.attentionCopy=copy; }`);
  render();
  assert.equal(run("attentionCopy.children.find(node=>node.dataset.action==='pause-execution').disabled"), false);
  run("state.busy=false;state.detail.execution={status:'running',elapsedMs:10000,progress:{message:'正在执行相关测试'}}");
  render(); assert.match(run("readText(attentionCopy)"), /正在执行相关测试.*10 秒/);
  assert.equal(run("attentionCopy.children.find(node=>node.dataset.action==='pause-execution').disabled"), false);
  run("state.detail.execution.status='pausing'"); render();
  assert.equal(run("attentionCopy.children.find(node=>node.dataset.action==='pause-execution').disabled"), true);
  run("state.detail.execution=null;state.detail.meta.executionPause={actor:'dev'};state.detail.events=[{type:'execution_paused'}]");
  run(`nextStep=()=>['old','old','active',[]]`);
  const pausedAttention = attention.replace("const execution = state.detail.execution;", "const execution = state.detail.execution;meta.executionPause=state.detail.meta.executionPause;");
  run(`{ const meta={id:'REQ-1',state:'contract_confirmed'},productView=false,stageIndex=1,isArchived=false;
    ${pausedAttention} globalThis.attentionCopy=copy; }`);
  assert.match(run("readText(attentionCopy)"), /现场已保存.*继续执行/);
});

test("rolled-back requirements expose a version-bound restart without starting AI work", async () => {
  const { run, modal } = workbench();
  run(`state.actions.add('restart-development');state.detail={auditHead:'rollback-head',
    meta:{state:'rolled_back',id:'REQ-1',planVersion:1,assignments:{developer:{userId:'dev',status:'accepted'}}}};
    globalThis.step=nextStep(state.detail.meta);globalThis.sent=[];sendAction=async(action,body)=>sent.push({action,body});`);
  assert.equal(run("step[3][0][0]"), "restart-development");
  assert.equal(run("canUseAction(state.detail.meta,'restart-development')"), true);
  run("state.principal.id='other'");
  assert.equal(run("canUseAction(state.detail.meta,'restart-development')"), false);
  run("state.principal.id='dev';openModal('restart-development')");
  assert.match(modal.children[0].children[1].textContent, /不.*调用模型/);
  const submit = modal.children[0].children.at(-1).children[1];
  await submit.listeners.click();
  assert.equal(run("sent[0].action"), "restart-development");
  assert.equal(run("sent[0].body.expectedAuditHead"), "rollback-head");
});

test("large-file review renders the actual changed context rather than omitting the diff", () => {
  const { run } = workbench();
  run(`globalThis.root=document.createElement('div');
    renderDiff(root,{file:'Editor.vue',before:{text:null,bytes:274436},after:{text:null,bytes:274494},
      patch:'@@ -20,1 +20,1 @@\\n-keyword.toLowerCase()\\n+keyword.trim().toLowerCase()'});
    globalThis.readText=node=>[node.textContent||'',...node.children.map(readText)].join(' ');`);
  assert.match(run("readText(root)"), /仅展示修改.*keyword\.trim\(\)\.toLowerCase\(\)/);
  assert.equal(run("root.children[0].children[2].children[2].className"), "diff-line unified added");
});

test("test acceptance and archive complete the delivery track", () => {
  const { context, run } = workbench();
  assert.equal(run("statusInfo('verified')[0]"), "待人工确认");
  assert.equal(run("statusInfo('verified')[2]"), 5);
  assert.equal(run("statusInfo('test_accepted')[2]"), 6);
  const track = source.slice(source.indexOf('const track = element("div", "stage-track")'),
    source.indexOf("panel.append(track);"));
  for (const stateName of ["archived_test_only", "archived"]) {
    context.archiveState = stateName;
    run(`{ const meta={state:archiveState};const isArchived=true;const stageIndex=5;
      ${track} globalThis.stages=track.children; }`);
    assert.equal(context.stages[5].className, "stage complete");
    assert.equal(context.stages[5].children[0].textContent, "✓");
    assert.equal(context.stages[4].className, "stage complete");
    assert.equal(context.stages[4].children[1].textContent, "人工验收");
  }
});

test("new requirement accepts simple numeric IDs with browser and server validation aligned", async () => {
  const { run } = workbench();
  run(`structuredModal = (title, description, build) => { globalThis.fields = build(document.createElement('form')); };
    openNewTask();`);
  const pattern = new RegExp(`^(?:${run("fields.id.pattern")})$`, "v");
  for (const id of ["1", "a", "REQ-123", "a_b", "1".repeat(64)]) {
    assert.equal(pattern.test(id), true); assert.equal(safeId(id), id);
  }
  for (const id of ["", "../1", "a/b", "_1", "-1", "1 2", "1".repeat(65)]) {
    assert.equal(pattern.test(id), false); assert.throws(() => safeId(id), /1–64/);
  }
  for (const id of [undefined, null, 1, {}, ["1"]]) assert.throws(() => safeId(id), /1–64/);
  assert.equal(run("fields.id.maxLength"), 64);
});

test("action stream handles fragmented Chinese text and requires an explicit final result", async () => {
  const { context, run } = workbench();
  context.TextDecoder = TextDecoder;
  const frames = 'event: progress\ndata: {"message":"正在生成","preview":"你好"}\n\n: elapsed 10000\n\nevent: result\ndata: {"state":"plan_review"}\n\n';
  const bytes = new TextEncoder().encode(frames);
  context.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
  run("globalThis.updates=[]");
  const result = await run("api('/actions',{onProgress:update=>updates.push(update)})");
  assert.equal(result.state, "plan_review"); assert.equal(context.updates[0].preview, "你好");
  assert.equal(context.updates[1].elapsedMs, 10000); assert.equal(context.updates[1].elapsedOnly, true);
  assert.equal(context.updates[1].message, "正在生成");
  context.fetch = async () => new Response('event: progress\ndata: {"message":"still working"}\n\n',
    { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(run("api('/actions',{onProgress:()=>{}})"), /连接已中断.*勿重复提交/);
  context.fetch = async () => new Response('event: error\ndata: {"error":"budget exceeded"}\n\n',
    { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(run("api('/actions',{onProgress:()=>{}})"), /budget exceeded/);
});

test("a completed action does not navigate away from the newly selected task", async () => {
  const { context, run } = workbench();
  run(`globalThis.refreshed=[];refresh=async id=>refreshed.push(id);
    api=async()=>{state.selectedId='REQ-2';return {};};`);
  assert.equal(await run("sendAction('develop')"), true);
  assert.equal(context.refreshed.length, 0); assert.equal(run("state.selectedId"), "REQ-2");
  run("receiveProgress('REQ-1','demo',{message:'old update',preview:'old'})");
  assert.equal(run("state.progress"), null);
});

test("session expiry during product generation keeps the real error and exits the busy state", async () => {
  const { context, run } = workbench();
  run(`state.principal={id:'product',roles:['product']};state.selectedId='REQ-1';
    api=async()=>{state.principal=null;state.selectedId=null;throw new Error('登录已过期');};`);
  assert.equal(await run("runIntakeAnalysis('REQ-1',{text:'补充需求'})"), false);
  assert.equal(run("state.busy"), false); assert.equal(run("state.progress"), null);
  assert.match(context.messages.at(-1), /登录已过期/);
});

test("developer process records show request timing without exposing technical diagnostics to product", () => {
  const { run } = workbench();
  run(`state.tab='audit';state.detail.meta.id='REQ-1';state.detail.events=[{at:'2026-10-09T10:33:39Z',type:'plan_attempt_failed',error:'声明缺失',
    timing:{durationMs:180050,model:'fixture-model',toolCalls:0,requestTimings:[{request:3,durationMs:53800,firstResponseMs:700,firstTextMs:1000,status:'timed_out'}]}}];
    globalThis.root=document.createElement('div');renderTab(root);
    globalThis.readText=node=>[node.textContent||'',...node.children.map(readText)].join(' ');`);
  assert.doesNotMatch(run("readText(root)"), /fixture-model|首个响应|声明缺失/);
  run("globalThis.diagnostics=root.children.find(node=>node.tagName==='DETAILS');diagnostics.open=true;diagnostics.listeners.toggle()");
  assert.match(run("readText(root)"), /fixture-model.*第 3 次模型请求：53.8 秒.*首个响应 0.7 秒.*超时终止/);
  run("diagnostics.listeners.toggle()");
  assert.equal(run("diagnostics.children.length"), 2);
  run("state.principal.roles=['product'];root.replaceChildren();renderTab(root)");
  assert.doesNotMatch(run("readText(root)"), /fixture-model|首个响应|声明缺失/);
});

test("lifecycle defaults to stage outcomes and only loads historical nodes on expansion", async () => {
  const { run } = workbench();
  run(`state.principal.roles=['admin'];state.actions.add('audit-report');
    globalThis.data={state:'archived_test_only',status:{responsible:{userId:'dev'},stateAgeMs:1000},
      responsibilities:{product:'product',developer:{userId:'dev'}},total:1,results:[
        {stage:'alignment',title:'需求对齐',status:'completed',summary:'需求已定版',conclusion:'支持状态筛选',owner:'product'},
        {stage:'design',title:'研发方案',status:'completed',summary:'方案已确认'},
        {stage:'implementation',title:'代码实施',status:'completed',summary:'完成两个文件变更'},
        {stage:'validation',title:'研发检查',status:'completed',summary:'相关检查通过'},
        {stage:'acceptance',title:'人工验收',status:'completed',summary:'已确认',conclusion:'功能满足需求'},
        {stage:'delivery',title:'交付归档',status:'completed',summary:'已归档'}],
      events:[{type:'implementation_failed',state:'implementation_failed',outcome:'failed',at:'2026-10-13T00:00:00Z',
        responsible:{userId:'dev'},sequence:5,actor:'dev',planVersion:1}]};
    api=async()=>data;globalThis.readText=node=>[node.textContent||'',...node.children.map(readText)].join(' ');`);
  await run("openLifecycle('REQ-1')");
  run("globalThis.card=$('#modalRoot').children[0]");
  assert.equal(run("card.children.filter(node=>node.className?.startsWith('lifecycle-event')).length"), 6);
  assert.match(run("readText(card)"), /支持状态筛选.*功能满足需求/);
  assert.doesNotMatch(run("readText(card)"), /查看该节点原始证据|执行诊断与模型用量|实施失败/);
  run("globalThis.history=card.children.find(node=>node.tagName==='DETAILS');history.open=true;history.listeners.toggle()");
  assert.match(run("readText(history)"), /执行诊断与模型用量.*实施失败.*查看该节点原始证据/);
  const count = run("history.children.length"); run("history.listeners.toggle()"); assert.equal(run("history.children.length"), count);
  run("state.principal.roles=['product']"); await run("openLifecycle('REQ-1')");
  assert.equal(run("$('#modalRoot').children[0].children.filter(node=>node.tagName==='DETAILS').length"), 0);
});

test("diagnostics show results and metrics first and render raw evidence only when requested", async () => {
  const { run } = workbench();
  run(`api=async()=>({summary:{attempts:1,failedAttempts:1,knownCostUsd:0,costMeasuredAttempts:0,costUsd:null},
    total:1,recentFailures:[{at:'2026-10-10T00:00:00Z',stage:'implementation_failed',reason:'A real check failed'}],
    runs:[{eventAt:'2026-10-10T00:00:00Z',eventType:'implementation_failed',status:'failed',error:'A real check failed',
      telemetry:{provider:'fake',model:'model',durationMs:2000,assistantMessages:1,toolCalls:1,
        tokens:{input:100,output:20,cacheRead:30,cacheWrite:0},
        requestTimings:[{request:1,durationMs:1000,status:'completed',usageMeasured:true}],
        toolTimings:[{tool:'edit',durationMs:5,status:'completed'}],
        auditStorage:{storedBytes:1024,omittedEvents:40,omittedThinkingBlocks:1},traceId:'RAW_TRACE_MARKER'}}]});
    globalThis.readText=node=>[node.textContent||'',...node.children.map(readText)].join(' ');
    globalThis.allNodes=node=>[node,...node.children.flatMap(allNodes)];`);
  await run("openDiagnostics('REQ-1')");
  run("globalThis.card=$('#modalRoot').children[0]");
  assert.match(run("readText(card)"), /A real check failed.*fake\/model.*输入 100.*缓存读 30/);
  assert.equal(run("allNodes(card).filter(node=>node.tagName==='PRE').length"), 0);
  run("globalThis.item=card.children.filter(node=>node.tagName==='DETAILS').at(-1);item.open=true;item.listeners.toggle()");
  assert.match(run("readText(item)"), /请求 1.*工具 edit.*审计正文 1.0 KB/);
  assert.equal(run("allNodes(card).filter(node=>node.tagName==='PRE').length"), 0);
  run("globalThis.evidence=item.children.at(-1);evidence.open=true;evidence.listeners.toggle()");
  assert.match(run("readText(evidence)"), /RAW_TRACE_MARKER/);
  run("evidence.listeners.toggle();item.listeners.toggle()");
  assert.equal(run("allNodes(card).filter(node=>node.tagName==='PRE').length"), 1);
});

test("acceptance feedback exposes participant discussion and binds repair to the displayed versions", async () => {
  const { run } = workbench();
  run(`state.actions=new Set(['discuss-acceptance','start-acceptance-repair','close-acceptance-feedback']);
    state.detail={meta:{state:'verified',id:'REQ-1',planHash:'plan',afterHash:'code',contractHash:'contract',
      createdBy:'product',assignments:{developer:{userId:'dev',status:'accepted'}},acceptanceFeedback:{status:'discussing',owner:'product'}},
      acceptanceDiscussion:{messages:[{at:'2026-10-12T10:00:00Z',type:'acceptance_message',eventHash:'message',actor:'product',text:'零值异常'},
        {at:'2026-10-12T10:01:00Z',type:'acceptance_reply',eventHash:'reply',messageHash:'message',reply:{route:'repair',reply:'有遗漏',rootCause:['a','b','c'],repair:'补零值断言',questions:[]}}]}};
    globalThis.root=document.createElement('div');globalThis.allNodes=node=>[node,...node.children.flatMap(allNodes)];
    renderAcceptanceDiscussion(root);globalThis.step=nextStep(state.detail.meta);`);
  assert.equal(run("step[3].some(row=>row[0]==='accept-test')"), false);
  assert.equal(run("allNodes(root).some(node=>node.dataset.action==='start-acceptance-repair')"), true);
  assert.equal(run("canUseAction(state.detail.meta,'close-acceptance-feedback')"), false);
  run(`globalThis.sent=[];sendAction=async(action,input)=>{sent.push([action,input]);return true;};
    structuredModal=(title,description,build,submit)=>{globalThis.fields=build(document.createElement('form'));globalThis.submit=submit;};
    openAcceptanceRepair('start-acceptance-repair');`);
  await run("submit(fields)"); assert.equal(run("sent[0][1].expectedFeedbackHash"), "reply");
  assert.equal(run("sent[0][1].expectedContractHash"), "contract"); assert.equal(run("sent[0][1].expectedAfterHash"), "code");
  run("state.detail.acceptanceDiscussion.messages[1].reply.route='requirement'");
  assert.equal(run("canUseAction(state.detail.meta,'start-acceptance-repair')"), false);
  run("state.principal={id:'product',roles:['product']}");
  assert.equal(run("canUseAction(state.detail.meta,'start-acceptance-repair')"), true);
  assert.equal(run("canUseAction(state.detail.meta,'discuss-acceptance')"), true);
  assert.equal(run("canUseAction(state.detail.meta,'close-acceptance-feedback')"), true);
  run("state.principal={id:'other',roles:['developer']}"); assert.equal(run("canUseAction(state.detail.meta,'discuss-acceptance')"), false);
  run("state.detail.meta.state='archived_test_only';root.replaceChildren();renderAcceptanceDiscussion(root)");
  assert.equal(run("allNodes(root).some(node=>node.tagName==='FORM')"), false);
});

function workbench() {
  const node = (tag = "div") => ({ tagName: tag.toUpperCase(), children: [], listeners: {}, attributes: {}, dataset: {}, hidden: false,
    get childElementCount() { return this.children.length; },
    append(...children) { this.children.push(...children); for (const child of children) child.parentElement = this; },
    appendChild(child) { this.append(child); return child; },
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
    replaceChildren(...children) { this.children = []; this.append(...children); }, setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
  });
  const modal = node();
  modal.hidden = true;
  const context = vm.createContext({ setInterval, clearInterval, URL, document: {
    createElement: node, createTextNode: text => ({ ...node("#text"), textContent: text }), querySelector: () => modal,
  } });
  vm.runInContext(source.slice(0, source.indexOf('document.querySelectorAll("[data-nav], [data-filter]")')), context);
  vm.runInContext(environmentSource, context);
  vm.runInContext(`
    state.principal = { id: "dev", roles: ["developer"] };
    state.actions = new Set(["develop", "plan", "approve-changes", "approve-release"]);
    state.selectedId = "REQ-1"; state.currentProjectId = "demo";
    state.detail = { meta: { state: "contract_confirmed", planVersion: 0 } };
    state.overview = { project: { mode: "local", admission: { maxPlanAttempts: 3 } } };
    renderDetail = () => {}; globalThis.messages = [];
    toast = (message) => messages.push(message);
  `, context);
  return { context, modal, run: code => vm.runInContext(code, context) };
}

test("authenticated login remains usable when the selected requirement has invalid plan evidence", async () => {
  const { context, run } = workbench();
  run(`globalThis.nodes=new Map();document.querySelector=selector=>{
    if(!nodes.has(selector))nodes.set(selector,document.createElement('div'));return nodes.get(selector);};
    renderProjectSelector=()=>{};renderList=()=>{};
    globalThis.calls=[];api=async url=>{calls.push(url);
      if(url==='/api/bootstrap')return {token:'csrf',principal:{id:'admin',roles:['admin']},actions:['new','configure-project'],projects:[],currentProjectId:'demo'};
      if(url==='/api/overview')return {project:{name:'Demo',root:'/demo',mode:'local'},tasks:[{id:'old',state:'verified'}],total:1,counts:{review:0,active:1,error:0,done:0}};
      const error=new Error('Invalid plan review policy');error.status=400;throw error;};`);
  run(source.slice(source.indexOf("async function establishSession()"), source.indexOf("function renderProjectSelector()")));
  const result = await run("establishSession()");
  assert.equal(result.authenticated, true); assert.equal(result.workspaceReady, false);
  assert.equal(run("state.principal.id"), "admin");
  assert.equal(run("state.token"), "csrf");
  assert.equal(run("nodes.get('#loginRoot').hidden"), true);
  assert.equal(run("nodes.get('#loginButton').hidden"), true);
  assert.equal(run("nodes.get('#modelSettingsButton').hidden"), false);
  assert.equal(run("state.detail"), null);
  assert.equal(run("nodes.get('#detailPanel').children[1].textContent"), "Invalid plan review policy");
  assert.match(context.messages.at(-1), /工作台加载失败.*Invalid plan review policy/);
  assert.deepEqual(Array.from(context.calls), ["/api/bootstrap", "/api/overview", "/api/tasks/old"]);
});

test("login still rejects revoked authentication instead of treating it as a workspace error", async () => {
  const { run } = workbench();
  run(`state.principal=null;state.token=null;globalThis.refreshed=false;
    refresh=async()=>{refreshed=true;};api=async()=>{const error=new Error('Session was revoked');error.status=401;throw error;};`);
  run(source.slice(source.indexOf("async function establishSession()"), source.indexOf("function renderProjectSelector()")));
  await assert.rejects(run("establishSession()"), error => error.status === 401 && error.message === "Session was revoked");
  assert.equal(run("state.principal"), null); assert.equal(run("state.token"), null);
  assert.equal(run("refreshed"), false);
});

test("execution boundaries stop the workflow without offering time extensions", () => {
  const { run } = workbench();
  run(`globalThis.meta={state:'contract_confirmed',executionBoundary:['Requirement execution budget exhausted; hand off to the responsible developer']};`);
  assert.equal(run("nextStep(meta)[0]"), "自动执行已停止");
  assert.equal(run("nextStep(meta)[3].length"), 0);
});

test("split review offers only the member's responsible part and starts code only after team confirmation", () => {
  const { run } = workbench();
  run(`state.actions=new Set(['review-plan','approve-plan','discuss-plan','edit-plan','revise-plan']);
    globalThis.meta={state:'plan_review',admission:{status:'eligible'},planBlockers:[],planAttempts:1,
      assignments:{developer:{userId:'back',status:'accepted'},frontend:{userId:'dev',status:'accepted'},backend:{userId:'back',status:'accepted'}}};
    state.detail.planReview={mode:'split',ready:false,parts:[{role:'frontend',userId:'dev',accepted:true,approved:false},{role:'backend',userId:'back',accepted:true,approved:false}]};`);
  assert.equal(run("nextStep(meta)[3][0][0]"), "review-plan-frontend");
  assert.equal(run("canUseAction(meta,'review-plan-frontend')"), true);
  assert.equal(run("canUseAction(meta,'review-plan-backend')"), false);
  assert.equal(run("canUseAction(meta,'edit-plan')"), true);
  assert.equal(run("canUseAction(meta,'approve-plan')"), false);
  assert.equal(run("nextStep(meta)[3].some(row=>row[0]==='approve-plan')"), false);
  run("state.detail.planReview.ready=true;state.detail.planReview.parts.forEach(part=>part.approved=true)");
  assert.equal(run("nextStep(meta)[3][0][0]"), "approve-plan");
  assert.equal(run("canUseAction(meta,'approve-plan')"), false);
  run("state.principal.id='back'");
  assert.equal(run("canUseAction(meta,'approve-plan')"), true);
  run("meta.planBlockers=['Unknown impact'];state.detail.planReview.ready=false");
  assert.equal(run("nextStep(meta)[3].some(row=>row[0].startsWith('review-plan-'))"), false);
});

test("editing rich design preserves file coverage, allows optional pseudocode and submits one versioned proposal", async () => {
  const { context, run } = workbench();
  run(`state.detail={meta:{id:'REQ-1',planHash:'shown-plan',planVersion:1},planAnalysis:{draft:{schemaVersion:2,domains:['backend'],markdown:'old',
    design:{approach:'Reuse',frontend:'',backend:'Old method',data:'No writes',interfaces:[],diagrams:[],components:[{file:'src/a.js',domain:'backend',location:'method a',pseudocode:''}]},
    affectedFiles:['src/a.js'],changes:[{file:'src/a.js',description:'Change a'}],boundaries:{modules:[{name:'a',files:['src/a.js']}]},
    validation:{checks:[{command:['npm','test'],reason:'Behavior'}]},
    verification:[{acceptanceId:'AC1',scenario:'Result',regression:'Keep old',checks:[{checkIndex:0,kind:'behavior',coverage:'Expected result assertion'}],manualSteps:'Check UI'}]}}};
    structuredModal=(title,description,build,submit)=>{globalThis.fields=build(document.createElement('form'));globalThis.submit=submit;};
    globalThis.sent=[];sendAction=async(...args)=>{sent.push(args);return true;};openPlanEditor();
    fields.design.approach.value='Reuse validated parser';fields.changes[0].file.value='src/b.js';fields.changes[0].location.value='method b';
    fields.feedback.value='Narrow implementation';`);
  assert.equal(run("fields.changes[0].pseudocode.required"), false);
  assert.equal(await run("submit(fields)"), true);
  const [action, body] = context.sent[0];
  assert.equal(action, "edit-plan"); assert.equal(body.expectedPlanHash, "shown-plan");
  assert.equal(body.candidate.design.approach, "Reuse validated parser");
  assert.equal(body.candidate.design.components[0].file, "src/b.js");
  assert.equal(body.candidate.boundaries.modules[0].files[0], "src/b.js");
  assert.equal(body.candidate.markdown, undefined);
  assert.equal(body.candidate.verification[0].checks[0].coverage, "Expected result assertion");
  assert.equal(body.candidate.verification[0].manualSteps, "Check UI");
  run("state.selectedId='another'"); await run("submit(fields)");
  assert.equal(context.sent.length, 1); assert.match(context.messages.at(-1), /需求已切换/);
});

test("responsible part confirmation carries the exact displayed version and never authorizes development", async () => {
  const { context, modal, run } = workbench();
  run(`state.detail.meta.planHash='shown-plan';globalThis.sent=[];sendAction=async(...args)=>{sent.push(args);return true;};
    structuredModal=(title,description,build,submit)=>{globalThis.submit=submit;globalThis.fields=build(document.createElement('form'));};`);
  const listener = source.slice(source.indexOf('$("#detailPanel").addEventListener("click"'), source.indexOf('$("#newTaskButton").addEventListener'));
  run(listener);
  modal.listeners.click({ target: { closest: selector => selector === "[data-action]" ? { dataset: { action: "review-plan-frontend" } } : null } });
  assert.equal(await run("submit(fields)"), true);
  assert.equal(context.sent[0][0], "review-plan");
  assert.deepEqual(JSON.parse(JSON.stringify(context.sent[0][1])), { part: "frontend", expectedPlanHash: "shown-plan" });
  run("state.selectedId='other'"); assert.equal(await run("submit(fields)"), false);
  assert.equal(context.sent.length, 1);
});

test("product replies appear below current questions and are sent together in one analysis", async () => {
  const { context, run } = workbench();
  run(`state.principal={id:'product',roles:['product']}; state.actions=new Set(['intake-message','analyze-intake']);
    state.selectedId='1'; state.detail={meta:{id:'1',state:'intake_clarifying',createdBy:'product'},request:'迁移模板',
      discussion:{withdrawnImageIds:[],messages:[
        {type:'intake_analysis_completed',eventHash:'old',at:'2026-10-09T01:00:00Z',analysis:{reply:'旧问题',questions:[{id:'Q1',text:'原来要什么？'}]}},
        {type:'intake_analysis_completed',eventHash:'current',at:'2026-10-09T02:00:00Z',analysis:{reply:'请确认',
          questions:[{id:'Q1',text:'导出哪个版本？'},{id:'Q2',text:'是否批量？'},{id:'Q3',text:'分类怎么处理？'}]}}
      ]}};
    state.detail.discussion.latestAnalysis=state.detail.discussion.messages.at(-1);
    globalThis.nodesUnder = node => [node,...node.children.flatMap(nodesUnder)];
    globalThis.draw = () => {globalThis.panel=document.createElement('div'); renderIntakeDiscussion(panel);
      for(const node of nodesUnder(panel)) if(node.type==='file') node.files=[];};
    globalThis.requests=[];api=async(url,options)=>{requests.push(JSON.parse(options.body));return {};}; refresh=async()=>{};
    draw();`);
  assert.equal(run("nodesUnder(panel).filter(n=>n.tagName==='TEXTAREA').length"), 4);
  await run("nodesUnder(panel).find(n=>n.tagName==='FORM').listeners.submit({preventDefault(){}})");
  assert.equal(context.requests.length, 0);
  assert.match(context.messages.at(-1), /至少回复一个问题/);
  run(`globalThis.inputs=nodesUnder(panel).filter(n=>n.tagName==='TEXTAREA');
    inputs[0].value='当前生效版本';inputs[0].listeners.input();
    inputs[1].value='逐个操作';inputs[1].listeners.input();draw();
    inputs=nodesUnder(panel).filter(n=>n.tagName==='TEXTAREA');`);
  assert.equal(run("inputs[0].value"), "当前生效版本");
  assert.equal(run("inputs[1].value"), "逐个操作");
  assert.equal(run("inputs[0].attributes.form"), "intake-reply-1");
  run("api=async()=>{throw new Error('Network unavailable');};globalThis.form=nodesUnder(panel).find(n=>n.tagName==='FORM')");
  await run("form.listeners.submit({preventDefault(){}})");
  run("draw();inputs=nodesUnder(panel).filter(n=>n.tagName==='TEXTAREA');api=async(url,options)=>{requests.push(JSON.parse(options.body));return {};};");
  assert.equal(run("inputs[0].value"), "当前生效版本");
  assert.equal(run("inputs[1].value"), "逐个操作");
  run("inputs[3].value='只用于医院间迁移';globalThis.form=nodesUnder(panel).find(n=>n.tagName==='FORM')");
  await run("form.listeners.submit({preventDefault(){}})");
  assert.equal(context.requests.length, 2, JSON.stringify(context.messages));
  assert.equal(context.requests[0].action, "intake-message");
  assert.equal(context.requests[1].action, "analyze-intake");
  assert.match(context.requests[0].message.text, /问题（Q1）：导出哪个版本？\n回复：当前生效版本/);
  assert.match(context.requests[0].message.text, /问题（Q2）：是否批量？\n回复：逐个操作/);
  assert.match(context.requests[0].message.text, /补充说明：只用于医院间迁移/);
  assert.doesNotMatch(context.requests[0].message.text, /Q3|原来要什么/);
  assert.equal(run("state.intakeDrafts.size"), 0);
  run("requests.length=0;state.selectedId='other-task'");
  await run("form.listeners.submit({preventDefault(){}})");
  assert.equal(context.requests.length, 0);
  assert.match(context.messages.at(-1), /需求已切换/);
  run("state.principal.id='other-product';draw()");
  assert.equal(run("nodesUnder(panel).filter(n=>n.tagName==='TEXTAREA').length"), 0);
});

test("message composer pastes images into the text draft and retains them until successful sending", async () => {
  const { context, run } = workbench();
  context.FileReader = class {
    readAsDataURL(file) { this.result = `data:${file.type};base64,${file.data}`; this.onload(); }
  };
  run(`globalThis.form=document.createElement('form');
    globalThis.composer=messageComposer(form,'图文消息','贴图再说明','same-message');
    composer.text.value='这张图对应当前需求';
    globalThis.imageFile={name:'截图.png',type:'image/png',size:3,data:'YWJj'};`);
  await run(`composer.text.parentElement.listeners.paste({clipboardData:{items:[{kind:'file',getAsFile:()=>imageFile}]},
    preventDefault(){globalThis.pasteHandled=true;}})`);
  assert.equal(run("pasteHandled"), true);
  assert.equal(run("composer.images()[0].name"), "截图.png");
  assert.equal(run("composer.text.value"), "这张图对应当前需求");
  run("globalThis.redrawn=messageComposer(document.createElement('form'),'图文消息','贴图再说明','same-message')");
  assert.equal(run("redrawn.images().length"), 1);
  run("redrawn.clearImages()");
  assert.equal(run("state.messageImageDrafts.has('same-message')"), false);
});

test("technical checks stay visible without reply fields while business questions retain inline replies", () => {
  const { run } = workbench();
  run(`document.createTextNode=text=>({textContent:text,children:[]});
    state.detail.meta={id:'REQ-1',planHash:'shown-plan'};
    globalThis.replies=[];globalThis.panel=document.createElement('div');
    renderPlan(panel,'## 待确认\\n- frontend：补齐预检接口\\n- qa：同步冲突检测契约\\n- 是否允许覆盖已有模板？',replies,true,['是否允许覆盖已有模板？']);
    globalThis.nodesUnder=node=>[node,...node.children.flatMap(nodesUnder)];
    globalThis.readText=node=>[node.textContent||'',...node.children.map(readText)].join(' ');`);
  assert.equal(run("replies.length"), 1);
  assert.equal(run("replies[0].question"), "是否允许覆盖已有模板？");
  assert.equal(run("nodesUnder(panel).filter(n=>n.tagName==='TEXTAREA').length"), 1);
  assert.match(run("readText(panel)"), /frontend：补齐预检接口.*qa：同步冲突检测契约/);
  run("replies=[];panel.replaceChildren();renderPlan(panel,'## 待确认\\n- frontend：补齐预检接口',replies,true,[])");
  assert.equal(run("replies.length"), 0);
  assert.match(run("readText(panel)"), /待处理问题/);
});

test("development questions accept inline partial replies in one versioned discussion and retain drafts on failure", async () => {
  const { context, run } = workbench();
  run(`state.actions=new Set(['discuss-plan']);state.tab='plan';
    state.detail={meta:{id:'REQ-1',state:'plan_review',planVersion:3,planHash:'shown-plan',
      assignments:{developer:{userId:'dev',status:'accepted'}}},
      plan:'## 验证\\n- 测试不会生成回复框\\n## 待确认\\n- 页面入口如何接入？\\n- 覆盖时如何处理旧关联？',
      planDiscussion:{messages:[
        {type:'plan_reply',actor:'dev',planVersion:2,eventHash:'old',at:'2026-10-09T01:00:00Z',text:'旧讨论',
          reply:{recommendation:'revise',reasons:[],pendingQuestions:['旧方案的问题']}},
        {type:'plan_reply',actor:'dev',planVersion:3,eventHash:'current',at:'2026-10-09T02:00:00Z',text:'请确认',
          reply:{recommendation:'revise',reasons:[],pendingQuestions:['是否复用现有校验？']}}
      ]}};
    document.createTextNode=text=>({textContent:text,children:[]});
    globalThis.nodesUnder=node=>[node,...node.children.flatMap(nodesUnder)];
    globalThis.draw=()=>{globalThis.panel=document.createElement('div');renderTab(panel);
      globalThis.inputs=nodesUnder(panel).filter(n=>n.tagName==='TEXTAREA');
      globalThis.form=nodesUnder(panel).find(n=>n.tagName==='FORM');};
    globalThis.requests=[];api=async(url,options)=>{requests.push(JSON.parse(options.body));return {};};refresh=async()=>{};
    draw();`);
  assert.equal(run("inputs.length"), 4);
  assert.equal(run("inputs[0].parentElement.parentElement.className"), "intake-question plan-question");
  assert.equal(run("inputs[2].parentElement.parentElement.className"), "intake-question");
  assert.equal(run("inputs[0].attributes.form"), "plan-reply-REQ-1");
  assert.equal(run("inputs.every(input=>input.required===false)"), true);
  await run("form.listeners.submit({preventDefault(){}})");
  assert.equal(context.requests.length, 0);
  assert.match(context.messages.at(-1), /至少回复一个问题/);
  run(`inputs[0].value='接入现有编辑页';inputs[0].listeners.input();
    inputs[2].value='请核实并复用';inputs[2].listeners.input();draw();`);
  assert.equal(run("inputs[0].value"), "接入现有编辑页");
  assert.equal(run("inputs[2].value"), "请核实并复用");
  run("api=async(url,options)=>{requests.push(JSON.parse(options.body));throw new Error('Network unavailable');}");
  await run("form.listeners.submit({preventDefault(){}})");
  run("draw();api=async(url,options)=>{requests.push(JSON.parse(options.body));return {};}");
  assert.equal(run("inputs[0].value"), "接入现有编辑页");
  assert.equal(run("inputs[2].value"), "请核实并复用");
  run("inputs[3].value='保持冻结需求';inputs[3].listeners.input()");
  await run("form.listeners.submit({preventDefault(){}})");
  assert.equal(context.requests.length, 2);
  assert.equal(context.requests[1].action, "discuss-plan");
  assert.equal(context.requests[1].message.expectedPlanHash, "shown-plan");
  assert.match(context.requests[1].message.text, /问题：页面入口如何接入？\n回复：接入现有编辑页/);
  assert.match(context.requests[1].message.text, /问题：是否复用现有校验？\n回复：请核实并复用/);
  assert.match(context.requests[1].message.text, /补充说明：保持冻结需求/);
  assert.doesNotMatch(context.requests[1].message.text, /旧关联|旧方案的问题|测试不会/);
  assert.equal(run("state.planDrafts.size"), 0);
  run("requests.length=0;draw();inputs[0].value='继续核实';inputs[0].listeners.input();state.currentProjectId='other-project'");
  await run("form.listeners.submit({preventDefault(){}})");
  assert.equal(context.requests.length, 0);
  assert.match(context.messages.at(-1), /需求已切换/);
  run("state.currentProjectId='demo';state.detail.meta.planHash='new-plan'");
  await run("form.listeners.submit({preventDefault(){}})");
  assert.match(context.messages.at(-1), /方案已更新/);
  run("draw()");
  assert.equal(run("inputs[0].value"), "");
  run("state.detail.meta.planHash='shown-plan';draw();inputs[0].value='长'.repeat(4000);inputs[0].listeners.input()");
  await run("form.listeners.submit({preventDefault(){}})");
  assert.equal(context.requests.length, 0);
  assert.match(context.messages.at(-1), /超过 4000/);
  run("draw()");
  assert.equal(run("inputs[0].value.length"), 4000);
  run("state.principal.id='other-dev';draw()");
  assert.equal(run("inputs.length"), 0);
  run("state.principal.id='dev';state.busy=true;draw()");
  assert.equal(run("inputs.every(input=>input.disabled)"), true);
  run("state.busy=false;state.detail.meta.state='approved';draw()");
  assert.equal(run("inputs.length"), 0);
  run(`state.detail.planDiscussion.messages.push({type:'plan_discussion_failed',actor:'dev',planVersion:3,
    at:'2026-10-09T03:00:00Z',text:'REQFLOW_BUDGET_STOP: request context byte limit exceeded'});draw();`);
  assert.equal(run("nodesUnder(panel).some(node=>node.textContent==='本轮方案核对未完成。你的回复已保存，当前方案保持不变。')"), true);
  assert.equal(run("nodesUnder(panel).find(node=>node.textContent?.startsWith('REQFLOW_BUDGET_STOP')).parentElement.tagName"), "DETAILS");
});

test("AI recommendations update the draft in one action while human decisions and final approval remain separate", async () => {
  const { context, run } = workbench();
  run(`state.actions=new Set(['discuss-plan','revise-plan']);state.overview.project.admission.budgetMode='adaptive';
    state.detail={meta:{id:'REQ-1',state:'plan_review',planVersion:3,planHash:'shown-plan',planAttempts:3,
      assignments:{developer:{userId:'dev',status:'accepted'}}},planDiscussion:{messages:[{
        type:'plan_reply',planVersion:3,actor:'dev',at:'2026-10-09T00:00:00Z',text:'建议复用现有方式',
        reply:{schemaVersion:2,recommendation:'revise',reasons:[],pendingQuestions:[],
          decisions:[{issue:'唯一ID',proposal:'复用现有UUID',basis:'源码已提供',humanRequired:false}]}}]}};
    globalThis.nodesUnder=node=>[node,...node.children.flatMap(nodesUnder)];
    globalThis.draw=()=>{globalThis.panel=document.createElement('div');renderPlanDiscussion(panel);
      globalThis.update=nodesUnder(panel).find(node=>node.textContent==='按 AI 建议更新方案');};
    globalThis.requests=[];sendAction=async(...args)=>{requests.push(args);return true;};draw();`);
  assert.equal(run("nodesUnder(panel).some(node=>node.textContent==='AI 推荐 · 唯一ID')"), true);
  assert.equal(run("nodesUnder(panel).filter(node=>node.tagName==='TEXTAREA').length"), 1);
  await run("update.listeners.click()");
  assert.equal(context.requests.length, 1);
  assert.equal(context.requests[0][0], "revise-plan");
  assert.equal(context.requests[0][1].expectedPlanHash, "shown-plan");
  assert.match(context.requests[0][1].feedback, /仅生成待审核版本，不批准或开发/);
  run("state.detail.meta.planHash='new-plan'");
  await run("update.listeners.click()");
  assert.equal(context.requests.length, 1);
  assert.match(context.messages.at(-1), /需求或方案已切换/);
  run("state.detail.meta.planHash='shown-plan';state.detail.planDiscussion.messages[0].reply.decisions[0].humanRequired=true;draw()");
  assert.equal(run("update"), undefined);
  assert.equal(run("nodesUnder(panel).some(node=>node.textContent==='需人工决定 · 唯一ID')"), true);
  run("state.detail.planDiscussion.messages[0].reply.decisions[0].humanRequired=false;state.overview.project.admission.budgetMode='strict';draw()");
  assert.equal(run("update"), undefined);
});

test("keep advice without human questions offers a plan correction when technical blockers remain", async () => {
  const { context, run } = workbench();
  run(`state.actions=new Set(['discuss-plan','revise-plan','approve-plan']);state.overview.project.admission.budgetMode='adaptive';
    state.detail={meta:{id:'REQ-1',state:'plan_review',planVersion:5,planHash:'shown-plan',planAttempts:6,
      admission:{status:'needs_clarification'},planBlockers:['代码快照不能恢复数据'],planResolutionHash:null,
      assignments:{developer:{userId:'dev',status:'accepted'}}},planDiscussion:{messages:[{
        type:'plan_reply',planVersion:5,at:'2026-10-09T00:00:00Z',text:'无须人工回答',
        reply:{recommendation:'keep',reasons:[],pendingQuestions:[],decisions:[]}}]}};
    globalThis.nodesUnder=node=>[node,...node.children.flatMap(nodesUnder)];
    globalThis.draw=()=>{globalThis.panel=document.createElement('div');renderPlanDiscussion(panel);};
    globalThis.requests=[];sendAction=async(...args)=>{requests.push(args);return true;};draw();`);
  assert.match(run("nextStep(state.detail.meta)[1]"), /代码快照不能恢复数据/);
  assert.equal(run("nextStep(state.detail.meta)[3].some(row=>row[0]==='approve-plan')"), false);
  assert.equal(run("nextStep(state.detail.meta)[3].some(row=>row[1]==='核对沟通结论并更新方案')"), true);
  await run("nodesUnder(panel).find(node=>node.textContent==='核对沟通结论并更新方案').listeners.click()");
  assert.equal(context.requests[0][0], "revise-plan");
  assert.equal(context.requests[0][1].expectedPlanHash, "shown-plan");
  assert.match(context.requests[0][1].feedback, /AI建议也需客观核实/);
  await run("openModal('revise-plan')");
  assert.equal(context.requests.length, 2);
  assert.equal(run("document.querySelector('#modalRoot').hidden"), true);
  run("state.detail.planDiscussion.messages[0].reply.pendingQuestions=['必须人工决定'];draw()");
  assert.equal(run("nodesUnder(panel).some(node=>node.textContent==='核对沟通结论并更新方案')"), false);
  run("state.detail.planDiscussion.messages[0].reply.pendingQuestions=[];state.detail.meta.planBlockers=[];draw()");
  assert.equal(run("nodesUnder(panel).some(node=>node.textContent==='核对沟通结论并更新方案')"), false);
});

test("failed plan updates offer direct retry and preserve an empty discussion composer", async () => {
  const { context, run } = workbench();
  run(`state.actions=new Set(['discuss-plan','revise-plan','edit-plan']);state.overview.project.admission.budgetMode='adaptive';
    state.detail={meta:{id:'REQ-1',state:'contract_confirmed',planVersion:4,planFeedbackVersion:4,planHash:'shown-plan',planAttempts:5,
      assignments:{developer:{userId:'dev',status:'accepted'}}},planDiscussion:{messages:[
        {type:'plan_revision_requested',planVersion:4,at:'2026-10-09T00:00:00Z'},
        {type:'plan_attempt_failed',planVersion:4,at:'2026-10-09T00:03:00Z',text:'fixture timeout'}]}};
    globalThis.nodesUnder=node=>[node,...node.children.flatMap(nodesUnder)];
    globalThis.panel=document.createElement('div');renderPlanDiscussion(panel);
    globalThis.requests=[];sendAction=async(...args)=>{requests.push(args);return true;};`);
  assert.equal(run("nextStep(state.detail.meta)[3][0][0]"), "revise-plan");
  assert.equal(run("nodesUnder(panel).filter(node=>node.tagName==='TEXTAREA').length"), 1);
  assert.equal(run("nodesUnder(panel).some(node=>node.textContent==='发送并核对')"), true);
  assert.equal(run("nodesUnder(panel).some(node=>node.textContent?.includes('原方案尚未被替换'))"), true);
  await run("nodesUnder(panel).find(node=>node.textContent==='按已保存意见重试更新').listeners.click()");
  assert.equal(context.requests[0][0], "revise-plan");
  assert.equal(context.requests[0][1].retry, true);
  assert.equal(context.requests[0][1].expectedPlanHash, "shown-plan");
  assert.equal(Object.hasOwn(context.requests[0][1], "feedback"), false);
  await run("openModal('revise-plan')");
  assert.equal(context.requests.length, 2);
  assert.equal(run("document.querySelector('#modalRoot').hidden"), true);
  run("state.detail.meta.planHash='new-plan'");
  await run("nodesUnder(panel).find(node=>node.textContent==='按已保存意见重试更新').listeners.click()");
  assert.equal(context.requests.length, 2);
  assert.match(context.messages.at(-1), /需求或方案已切换/);
});

test("specialist corrections can update a plan without another discussion or approval", async () => {
  const { context, run } = workbench();
  run(`state.tab='plan';state.actions=new Set(['revise-plan']);state.overview.project.admission.budgetMode='adaptive';
    state.detail={meta:{id:'REQ-1',state:'plan_review',planVersion:4,planHash:'checked-plan',planAttempts:4,
      assignments:{developer:{userId:'dev',status:'accepted'}}},plan:'',planAnalysis:{
      admission:{status:'needs_clarification',label:'待补充',scope:{modules:[],deliveryUnits:[]}},admissionPolicy:{},
      draft:{schemaVersion:2,openQuestions:[],affectedFiles:[],verification:[],impacts:{existingBehavior:{status:'none'},interfaces:{status:'none'},data:{status:'none'}},
        boundaries:{modules:[],coordination:{},verification:{},recovery:{},externalEffects:{}}},
      specialists:[{role:'backend',findings:{findings:[{severity:'blocking',subject:'事务边界矛盾',recommendation:'逐模板事务'}]}}]}};
    globalThis.nodesUnder=node=>[node,...node.children.flatMap(nodesUnder)];
    globalThis.draw=()=>{globalThis.panel=document.createElement('div');renderTab(panel);
      globalThis.update=nodesUnder(panel).find(node=>node.textContent==='让 AI 按检查意见修正方案');};
    globalThis.sent=[];sendAction=async(...args)=>{sent.push(args);return true;};draw();`);
  await run("update.listeners.click()");
  assert.equal(context.sent.length, 1); assert.equal(context.sent[0][0], "revise-plan");
  assert.equal(context.sent[0][1].expectedPlanHash, "checked-plan");
  assert.match(context.sent[0][1].feedback, /评审意见也需客观核实，不盲从/);
  assert.match(context.sent[0][1].feedback, /不得代答/);
  run("state.detail.meta.planHash='changed'"); await run("update.listeners.click()");
  assert.equal(context.sent.length, 1);
  run("state.detail.meta.planHash='checked-plan';state.detail.planAnalysis.draft.openQuestions=['必须业务决定'];draw()");
  assert.equal(run("update"), undefined);
  run("state.detail.planAnalysis.draft.openQuestions=[];state.overview.project.admission.budgetMode='strict';draw()");
  assert.equal(run("update"), undefined);
  run("state.overview.project.admission.budgetMode='adaptive';state.principal.id='other';draw()");
  assert.equal(run("update"), undefined);
});

test("failed development refreshes its saved state and preserves the error", async () => {
  const { context, run } = workbench();
  run(`api = async () => { throw new Error("Pi stopped"); };
    refresh = async id => { globalThis.refreshed = id; state.detail.meta.state = "implementation_failed"; };`);
  assert.equal(await run('sendAction("develop", { authorizeImplementation: true })'), false);
  assert.equal(context.refreshed, "REQ-1");
  assert.equal(run("state.detail.meta.state"), "implementation_failed");
  assert.equal(run("state.busy"), false);
  assert.equal(context.messages[0], "Pi stopped");
});

test("failed state refresh reports both errors instead of hiding either", async () => {
  const { context, run } = workbench();
  run(`api = async () => { throw new Error("Pi stopped"); };
    refresh = async () => { throw new Error("Server unavailable"); };`);
  assert.equal(await run('sendAction("develop")'), false);
  assert.match(context.messages[0], /Pi stopped.*Server unavailable/);
  assert.equal(run("state.busy"), false);
});

test("failure in a previous task does not refresh the newly selected task", async () => {
  const { context, run } = workbench();
  run(`api = async () => { state.selectedId = "REQ-2"; throw new Error("Pi stopped"); };
    refresh = async () => { globalThis.refreshed = true; };`);
  assert.equal(await run('sendAction("develop")'), false);
  assert.equal(context.refreshed, undefined);
  assert.equal(run("state.selectedId"), "REQ-2");
});

test("development modal cancels without executing and submits explicit authorization", async () => {
  const { context, modal, run } = workbench();
  run("globalThis.sent = []; sendAction = async (...args) => sent.push(args); openModal('develop');");
  const actions = modal.children[0].children.at(-1);
  actions.children[0].listeners.click();
  assert.equal(modal.hidden, true);
  assert.equal(context.sent.length, 0);
  run("openModal('develop')");
  await modal.children[0].children.at(-1).children[1].listeners.click();
  assert.equal(context.sent.length, 1);
  assert.equal(context.sent[0][0], "develop");
  assert.equal(context.sent[0][1].authorizeImplementation, true);
});

test("development entry respects assignment and retains manual review boundaries", () => {
  const { run } = workbench();
  run(`globalThis.meta = { state: "contract_confirmed",
    assignments: { developer: { userId: "dev", status: "accepted" } } };`);
  assert.equal(run("canUseAction(meta, 'develop')"), true);
  assert.equal(run("nextStep(meta)[3][0][0]"), "plan");
  assert.equal(run("nextStep(meta)[3].some(a => a[0] === 'develop')"), false);
  run("meta.assignments.developer.status = 'pending'");
  assert.equal(run("canUseAction(meta, 'develop')"), false);
  run("meta.assignments.developer.status = 'accepted'; state.principal.id = 'other'");
  assert.equal(run("canUseAction(meta, 'develop')"), false);
  assert.equal(run("nextStep({ state: 'verified' })[3][0][0]"), "accept-test");
  assert.equal(run("nextStep({ state: 'merge_verified' })[3][0][0]"), "archive-test-only");
  assert.equal(run("nextStep({ state: 'plan_review', admission: { status: 'out_of_scope' } })[3].some(a => a[0] === 'develop' || a[0] === 'approve-plan')"), false);
});

test("failed plan generation shows its retained cause and clears after a new planning or contract event", () => {
  const { run } = workbench();
  run(`state.detail.meta={state:'contract_confirmed',planAttempts:2,assignments:{developer:{status:'accepted'}}};
    state.detail.events=[{type:'plan_attempt_failed',error:'request context byte limit exceeded'}];`);
  assert.equal(run("nextStep(state.detail.meta)[0]"), "研发方案生成失败");
  assert.equal(run("nextStep(state.detail.meta)[2]"), "error");
  assert.match(run("nextStep(state.detail.meta)[1]"), /request context byte limit exceeded/);
  assert.equal(run("nextStep(state.detail.meta)[3][0][0]"), "plan");
  run("state.principal.roles=['product']");
  assert.doesNotMatch(run("nextStep(state.detail.meta)[1]"), /context byte/);
  assert.match(run("nextStep(state.detail.meta)[1]"), /研发负责人/);
  for (const type of ["contract_revised", "contract_confirmed", "plan_analysis_started", "plan_created"]) {
    run(`state.detail.events.unshift({type:${JSON.stringify(type)}})`);
    assert.equal(run("nextStep(state.detail.meta)[0]"), type === "plan_analysis_started" ? "正在生成研发方案" : "等待 Agent 设计方案");
    if (type === "plan_analysis_started") assert.equal(run("nextStep(state.detail.meta)[3].length"), 0);
  }
});

test("validation choice uses project mode without assuming a particular CI provider", () => {
  const { run } = workbench();
  run("state.overview.project.testDeployment = 'company-ci'; state.overview.project.deploymentRequiresPublishedRevision = true");
  assert.equal(run("nextStep({ state: 'verified' })[3][0][0]"), "accept-test");
  run("state.overview.project.mode = 'git'");
  assert.equal(run("nextStep({ state: 'verified' })[3][2][0]"), "publish-test");
  assert.equal(run("nextStep({ state: 'test_deploy_running' })[1].includes('Jenkins')"), false);
});

test("manual archive remains available without an environment and with stale or blocked local validation", () => {
  const { run } = workbench();
  run(`state.overview={project:{mode:'local',executionReady:false}};
    state.detail={meta:{state:'verified',afterHash:'verified-hash',localValidation:{
      status:'running',afterHash:'verified-hash',environment:{url:'http://localhost:4180',instructions:''}}}};`);
  assert.equal(run("nextStep(state.detail.meta)[3].some(row=>row[0]==='accept-test')"), true);
  run("state.detail.meta.localValidation.afterHash='old-hash'");
  assert.equal(run("nextStep(state.detail.meta)[3].some(row=>row[0]==='accept-test')"), true);
  run("state.detail.meta.localValidation.status='blocked';state.overview.project.localEnvironment={status:'blocked'}");
  assert.equal(run("nextStep(state.detail.meta)[3][0][0]"), "accept-test");
  assert.match(run("nextStep(state.detail.meta)[1]"), /不配置环境也可归档/);
  run("delete state.detail.meta.localValidation");
  assert.equal(run("nextStep(state.detail.meta)[3][0][0]"), "accept-test");
});

test("manual archive dialog submits the displayed version and explicit acceptance method", async () => {
  const { context, modal, run } = workbench();
  run(`state.detail.meta={state:'verified',planHash:'shown-plan',afterHash:'shown-code',verificationMode:'automated'};
    state.detail.contract={acceptance:[{id:'AC1',text:'乘法正确'}]};
    state.detail.planAnalysis={draft:{verification:[{acceptanceId:'AC1',manualSteps:'核对2×3=6'}]}};
    globalThis.sent=[];sendAction=async(...args)=>sent.push(args);openModal('accept-test');`);
  const card = modal.children[0];
  assert.equal(card.children[0].textContent, "人工确认并归档");
  card.children.find(node => node.tagName === "TEXTAREA").value = "已核对需求、代码和相关测试结果，确认交付。";
  card.children.filter(node => node.tagName === "TEXTAREA")[1].value = "实际核对2×3=6";
  run("state.detail.meta.afterHash='new-code'");
  await card.children.at(-1).children[1].listeners.click();
  assert.equal(context.sent[0][0], "accept-test");
  assert.equal(context.sent[0][1].acceptanceMode, "manual");
  assert.equal(context.sent[0][1].expectedAfterHash, "shown-code");
  assert.equal(context.sent[0][1].expectedPlanHash, "shown-plan");
  assert.equal(context.sent[0][1].acceptanceResults[0].conclusion, "实际核对2×3=6");
});

test("acceptance evidence keeps technical checks, incomplete execution and historical versions explicit", () => {
  const {run}=workbench();
  run(`state.detail={contract:{acceptance:[{id:'AC1',text:'取消订单恢复库存'}]},
    planAnalysis:{draft:{verification:[{acceptanceId:'AC1',manualSteps:'取消订单后检查库存',checks:[{checkIndex:0,kind:'technical',coverage:'构建通过不证明库存'}]}]}},
    humanAcceptance:null,verificationAttempts:[{attempt:1,at:'2026-10-14T00:00:00Z',current:false,
      evidence:{sourceHash:'old-source',planHash:'old-plan',sourceUnchanged:true,items:[{acceptanceId:'AC1',checks:[
        {kind:'technical',status:'passed',command:['npm','run','build'],coverage:'只证明构建',result:null},
        {kind:'behavior',status:'not_run',command:['npm','test'],coverage:'库存断言',result:null}]}]}}]};
    globalThis.root=document.createElement('div');renderAcceptanceEvidence(root);
    globalThis.readText=node=>[node.textContent||'',...node.children.map(readText)].join(' ');`);
  const text=run('readText(root)');
  assert.match(text,/技术检查 · 相关检查通过/);assert.match(text,/业务断言相关检查 · 未执行/);
  assert.match(text,/历史或已失效版本/);assert.match(text,/暂无匹配当前版本/);assert.match(text,/人工结论待填写/);
  run(`state.detail.humanAcceptance={actor:'reviewer',at:'2026-10-14T01:00:00Z',acceptanceMode:'local',
    results:[{acceptanceId:'AC1',conclusion:'取消后库存由8恢复为10'}]};root=document.createElement('div');renderAcceptanceEvidence(root);`);
  assert.match(run('readText(root)'),/人工已确认 · reviewer.*本地验证 · 取消后库存由8恢复为10/);
});

test("historical verification and human conclusions remain visible without per-acceptance mappings", () => {
  const { run } = workbench();
  run(`state.tab='checks';state.detail={meta:{state:'archived_test_only'},baselineChecks:[],
    contract:{acceptance:[{id:'AC1',text:'状态筛选正确'}]},planAnalysis:{draft:{verification:[]}},
    humanAcceptance:{actor:'developer',at:'2026-10-11T07:26:50Z',coverageRecorded:false,conclusion:'人工已核对筛选结果'},
    verificationAttempts:[{attempt:1,at:'2026-10-11T00:00:00Z',outcome:'verification_failed',evidence:null,
      sourceHash:'source-1',planHash:'plan-1',error:'相关检查失败',checks:[
        {command:['npm','test'],code:1,durationMs:20,logFile:'/old/archive/check-1.log',logHash:'hash-1',tail:'assertion failed'}]},
      {attempt:2,at:'2026-10-11T01:00:00Z',outcome:'verified',evidence:null,sourceHash:'source-2',planHash:'plan-2',checks:[]}]};
    globalThis.root=document.createElement('div');renderTab(root);
    globalThis.readText=node=>[node.textContent||'',...node.children.map(readText)].join(' ');`);
  const text = run('readText(root)');
  assert.match(text, /历史方案未保存逐项检查关联/);
  assert.match(text, /人工验收原文 · developer.*人工已核对筛选结果/);
  assert.match(text, /第 1 次验证.*失败.*1 项命令检查.*npm test · 退出码 1.*assertion failed/s);
  assert.match(text, /第 2 次验证.*已完成.*0 项命令检查/);
  assert.doesNotMatch(text, /暂无验证记录|人工已确认|技术检查 · 相关检查通过|业务断言相关检查 · 相关检查通过/);
});

test("Git delivery offers optional local verification and explicit commit authorization", async () => {
  const { context, modal, run } = workbench();
  run(`state.overview.project.mode = "git"; state.overview.project.gitDelivery = {testMode:"merge",testBranch:"integration"};
    state.detail = {meta:{state:"verified",branch:"devsail/REQ-1",afterHash:"reviewed-hash",planHash:"plan-hash",checks:[{code:0}]},changes:{changes:[]}};
    api = async () => ({testMode:"merge",testBranch:"integration"}); globalThis.sent=[]; sendAction=async(...args)=>sent.push(args);`);
  assert.equal(run("nextStep(state.detail.meta)[3][0][0]"), "accept-test");
  assert.equal(run("nextStep(state.detail.meta)[3][1][0]"), "local-validation");
  assert.equal(run("nextStep(state.detail.meta)[3][2][0]"), "publish-test");
  await run("openGitDelivery('publish-test')");
  assert.equal(context.sent.length, 0);
  await modal.children[0].listeners.submit({ preventDefault() {} });
  assert.equal(context.sent[0][0], "publish-test");
  assert.equal(context.sent[0][1].authorizeGit, true);
  assert.equal(context.sent[0][1].expectedAfterHash, "reviewed-hash");
  assert.equal(context.sent[0][1].testBranch, "integration");
  assert.equal(context.sent[0][1].localValidated, false);
});

test("Git plan approval chooses a branch without authorizing a commit or test deployment", async () => {
  const { context, modal, run } = workbench();
  run(`state.overview.project.mode='git';state.detail.meta={planVersion:1,planHash:"shown-plan",baseRevision:"abc123"};
    api=async(url)=>url==='/api/project-git'
      ? {baseBranch:"main",releaseBranch:"main",branchPrefix:"devsail",branches:["main","existing-feature"]}
      : {validation:{checks:[{command:['npm','test'],reason:'相关用例'}],skipped:[],manualReason:'',startup:[]}};
    globalThis.sent=[];sendAction=async(...args)=>sent.push(args);`);
  await run("openPlanApproval()");
  await modal.children[0].listeners.submit({ preventDefault() {} });
  assert.equal(context.sent[0][0], "approve-plan");
  assert.equal(context.sent[0][1].developmentBranch.kind, "new");
  assert.equal(context.sent[0][1].developmentBranch.branch, "devsail/REQ-1");
  assert.equal(context.sent[0][1].authorizeGit, undefined);
  assert.equal(context.sent[0][1].expectedPlanHash, "shown-plan");
  assert.equal(context.sent[0][1].checksText, undefined);
});

test("plan confirmation displays scoped checks and skipped suites without asking for commands", async () => {
  const { context, run } = workbench();
  run(`state.token='csrf-token';state.detail.meta={state:'plan_review',planVersion:1,planHash:'shown-plan'};
    state.detail.planAnalysis={draft:{affectedFiles:['frontend/src/Editor.vue']}};
    api=async(url,options)=>{globalThis.preparation={url,options};return {validation:{
      checks:[{command:['npm','--prefix','frontend','run','build'],reason:'只改前端渲染'}],
      skipped:[{command:['mvn','test'],reason:'后端无调用路径变化'}],manualReason:'',startup:[]}};};
    structuredModal=(title,description,build,submit)=>{globalThis.form=document.createElement('form');globalThis.fields=build(form);globalThis.submit=submit;};
    globalThis.sent=[];sendAction=async(...args)=>sent.push(args);`);
  await run("openPlanApproval()");
  assert.equal(context.sent.length, 0);
  assert.equal(context.preparation.options.headers['X-Reqflow-Token'], 'csrf-token');
  assert.equal(context.preparation.options.headers['Content-Type'], 'application/json');
  assert.equal(run("fields.checks"), undefined);
  assert.match(run("form.children.map(node=>node.textContent).join(' ')"), /前端渲染.*跳过.*后端无调用路径变化/);
  await run("submit(fields)");
  assert.equal(context.sent[0][0], "approve-plan");
  assert.equal(context.sent[0][1].checksText, undefined);
  assert.equal(context.sent[0][1].developmentBranch, undefined);
});

test("every supported task state renders a next step, including candidate verification", () => {
  const { run } = workbench();
  for (const name of run("Object.keys(states)")) {
    const next = run(`nextStep({ state: ${JSON.stringify(name)}, contractVersion: 1,
      assignments: { developer: { userId: "dev", status: "accepted" } },
      admission: { status: "eligible" }, planAttempts: 1, planBlockers: [] })`);
    assert.equal(typeof next[0], "string", name);
    assert.ok(Array.isArray(next[3]), name);
  }
  assert.equal(run("nextStep({ state: 'merge_verifying' })[3].length"), 0);
  run("state.overview.project.productionDeployment = 'none'");
  assert.equal(run("nextStep({ state: 'merge_verified' })[3][0][0]"), "archive-test-only");
});

test("paused development exposes the retained failure and a continuation action", () => {
  const { run } = workbench();
  run("state.detail.events=[{type:'implementation_failed',error:'Pi exceeded configured tool-call limit'}]");
  assert.match(run("nextStep({state:'implementation_failed'})[1]"), /tool-call limit/);
  for (const status of ["implementation_failed", "verification_failed"]) {
    const next = run(`nextStep({state:${JSON.stringify(status)},developmentPause:{reason:'本次预算已用完'},
      assignments:{developer:{userId:'dev',status:'accepted'}}})`);
    assert.match(next.join(" "), /本次预算已用完/);
    assert.equal(next[3].some(action => action[0] === "develop"), true);
  }
  assert.equal(run("nextStep({state:'implementation_failed',developmentFailure:{kind:'scope_violation',message:'越界',retryable:false}})[3].some(action=>action[0]==='develop')"), false);
});

test("plan confirmation submits the displayed version and rejects a switched task", async () => {
  const { context, run } = workbench();
  run(`state.detail.meta.state = 'plan_review'; state.detail.meta.planHash = 'displayed-hash';
    api=async()=>({validation:{checks:[{command:['npm','test'],reason:'相关用例'}],skipped:[],manualReason:'',startup:[]}});
    structuredModal=(title,description,build,submit)=>{globalThis.fields=build(document.createElement('form'));globalThis.submit=submit;};
    globalThis.sent = []; sendAction = async (...args) => sent.push(args);`);
  await run("openModal('approve-plan')");
  run("state.detail.meta.planHash = 'new-hash'");
  await run("submit(fields)");
  assert.equal(context.sent[0][1].expectedPlanHash, "displayed-hash");
  await run("openModal('approve-plan')");
  run("state.selectedId = 'REQ-2'");
  assert.throws(() => run("submit(fields)"), /需求已切换/);
  assert.equal(context.sent.length, 1);
});

test("missing fixed environment or checks keeps developer preparation available", () => {
  const { run } = workbench();
  run("state.overview.project.executionReady = false; state.overview.project.checksConfigured = false");
  assert.equal(run("nextStep({state:'contract_confirmed',assignments:{developer:{status:'accepted'}}})[3][0][0]"), "plan");
  assert.equal(run("nextStep({state:'plan_review',admission:{status:'eligible'},planAttempts:1,planBlockers:[]})[3].some(a=>a[0]==='approve-plan')"), true);
  assert.equal(run("nextStep({state:'verified'})[3][0][0]"), "accept-test");
  assert.equal(run("nextStep({state:'verified'})[3].some(a=>a[0]==='deploy-test')"), false);
  assert.equal(run("nextStep({state:'intake_ready'})[3][0][0]"), "confirm-contract");
});

test("admin model form inherits defaults, saves overrides and clears entered secrets", async () => {
  const { context, run } = workbench();
  run(`state.principal={id:'admin',roles:['admin']};
    globalThis.setup={expectedConfigHash:'shown-config',default:{provider:'Bailian',model:'qwen3.8-27b',baseUrl:'https://model.example/v1',
      thinking:'off',credentialConfigured:true,contextWindow:65536,maxTokens:8192,maxPiMs:180000,maxToolCalls:30,
      reasoning:true,thinkingToggle:true,supportsReasoningEffort:false,supportsJsonSchema:false,imageInput:false,
      modelParameters:{outputFormat:'auto',temperature:0.2,topP:0.8,maxOutputTokens:4096},modelUsage:{maxTokens:60000,maxContextBytes:64000,maxRequests:8,readOnlyMaxRequests:6,maxToolResultBytes:8000,
        initializationMaxTokens:30000,initializationMaxRequests:1,initializationMaxToolCalls:8}},
      agents:Object.fromEntries(Object.keys(modelAgentLabels).map(name=>[name,null])),maxCostUsd:null};
    api=async()=>setup;refresh=async()=>{};globalThis.requests=[];
    structuredModal=(title,description,build,submit)=>{globalThis.form=document.createElement('form');globalThis.fields=build(form);globalThis.submit=submit;};`);
  await run("openModelSettings()");
  assert.equal(run("fields.default.apiKey.value"), "");
  assert.equal(run("fields.default.apiKey.type"), "password");
  assert.equal(run("fields.default.apiKey.required"), false);
  assert.equal(run("Object.values(fields.default.cost).every(input=>input.required===false)"), true,
    "unknown optional prices must not prevent the browser from dispatching the save submit event");
  assert.equal(run("fields.maxCostUsd.required"), false, "an omitted fee limit must not prevent submission");
  run("fields.default.cost.input.value='1'");
  assert.throws(() => run("modelProfileInput(fields.default)"), /全部四项单价，或全部留空/);
  run("fields.default.cost.input.value=''");
  assert.equal(run("Object.values(fields.agents).every(row=>row.inherit.checked)"), true);
  assert.equal(run("Object.values(fields.agents).every(row=>row.inputs===null&&row.custom.hidden)"), true);
  run(`fields.default.baseUrl.value='';fields.agents.requirement.inherit.checked=false;fields.agents.requirement.inherit.listeners.change();`);
  assert.equal(run("fields.agents.requirement.inputs.baseUrl.value"), "");
  run(`fields.agents.requirement.inherit.checked=true;fields.agents.requirement.inherit.listeners.change();fields.default.baseUrl.value=setup.default.baseUrl;`);
  run(`globalThis.planSection=form.children.find(node=>node.tagName==='DETAILS'&&node.children[0].textContent.startsWith('开发 Agent'));
    api=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {model:'qwen3.8-27b',elapsedMs:1,outputFormat:'json_object'};};`);
  await run("form.children.find(node=>node.tagName==='BUTTON').listeners.click()");
  assert.equal(context.requests[0].url, "/api/model-connection");
  assert.equal(context.requests[0].body.scope, "default");
  run("requests.length=0");
  run(`fields.default.model.value='updated-default-model';
    fields.agents.development.inherit.checked=false;fields.agents.development.inherit.listeners.change();`);
  assert.equal(run("fields.agents.development.inputs.model.value"), "updated-default-model");
  assert.equal(run("fields.agents.development.custom.hidden"), false);
  assert.equal(run("Object.values(fields.agents.development.inputs.cost).every(input=>input.required===false)"), true);
  run(`fields.agents.development.inputs.model.value='glm-5.3';
    fields.default.apiKey.value='new-private-key';api=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {};};`);
  await run("submit(fields)");
  assert.equal(context.requests.length, 1); assert.equal(context.requests[0].url, "/api/model-settings");
  assert.equal(context.requests[0].body.expectedConfigHash, "shown-config");
  assert.equal(context.requests[0].body.maxCostUsd, null);
  assert.equal(context.requests[0].body.default.cost, null);
  assert.equal(context.requests[0].body.agents.requirement, null); assert.equal(context.requests[0].body.agents.development.model, "glm-5.3");
  assert.equal(context.requests[0].body.default.apiKey, "new-private-key");
  assert.equal(context.requests[0].body.default.maxPiMs, 180000);
  assert.equal(context.requests[0].body.default.maxToolCalls, 30);
  assert.equal(context.requests[0].body.default.modelUsage.maxRequests, 8);
  assert.equal(context.requests[0].body.default.maxTokens, 8192);
  assert.equal(context.requests[0].body.default.modelParameters.maxOutputTokens, 4096);
  assert.equal(context.requests[0].body.default.modelParameters.temperature, 0.2);
  assert.equal(context.requests[0].body.default.modelParameters.topP, 0.8);
  assert.equal(run("fields.agents.development.inputs.saved.apiKey"), undefined);
  assert.equal(run("fields.default.apiKey.value"), "");
  run("fields.default.maxTokens.value=2048;globalThis.profile=modelProfileInput(fields.default)");
  assert.equal(run("profile.maxTokens"), 2048); assert.equal(run("profile.modelParameters.maxOutputTokens"), 2048);
  run("state.currentProjectId='switched'"); await assert.rejects(run("submit(fields)"), /项目已切换/);
  run("state.principal.roles=['developer']"); await assert.rejects(run("openModelSettings()"), /只有管理员/);
});

test("built-in deployment forms ask for platform fields and preserve configured credentials without exposing them", () => {
  const { run } = workbench();
  run(`globalThis.container = document.createElement('div'); globalThis.fields = { kind: { value: 'jenkins' } };
    globalThis.setup = { kind: 'jenkins', fields: { baseUrl: 'https://jenkins.example/', jobPath: 'job/team/job/deploy-test', username: 'ci-user' }, credentialConfigured: true };`);
  run("renderDeploymentSettings(container, fields, setup)");
  assert.equal(run("fields.inputs.jobPath.value"), "team/deploy-test");
  assert.equal(run("fields.inputs.token.required"), false);
  run("fields.inputs.token.value = ''; fields.inputs.jobPath.value = '业务/发布'");
  assert.equal(run("deploymentSettingsInput(fields).fields.jobPath"), "job/%E4%B8%9A%E5%8A%A1/job/%E5%8F%91%E5%B8%83");
  run("fields.kind.value = 'gitlab'; renderDeploymentSettings(container, fields, setup)");
  assert.equal(run("fields.inputs.token.required"), true);
  assert.equal(run("Object.hasOwn(fields.inputs, 'deployCommand')"), false);
  run("fields.kind.value = 'github'; renderDeploymentSettings(container, fields, setup)");
  assert.equal(run("fields.inputs.baseUrl.value"), "https://api.github.com/");
  assert.equal(run("Object.hasOwn(fields.inputs, 'workflow')"), true);
  run("fields.kind.value = 'local'; setup.deployCommand = 'npm run deploy:test'; renderDeploymentSettings(container, fields, setup)");
  assert.equal(run("deploymentSettingsInput(fields).deployCommand"), "npm run deploy:test");
});

test("project settings keeps fixed environment optional and saves automatic checks independently", async () => {
  const { context, run } = workbench();
  run(`api=async()=>({kind:'unconfigured',mode:'local',configHash:'shown-config',checksText:'',url:'',
    checksEnvironment:[],deploymentEnvironment:[],timeoutMs:30000});
    structuredModal=(title,description,build,submit)=>{globalThis.title=title;globalThis.fields=build(document.createElement('form'));globalThis.submit=submit;};
    globalThis.requests=[];refresh=async()=>{};`);
  await run("openTestEnvironmentSettings()");
  assert.equal(context.title, "测试环境配置");
  assert.equal(run("fields.kind.value"), "unconfigured");
  assert.equal(run("fields.url.parentElement.hidden"), true);
  assert.equal(run("fields.url.required"), false);
  assert.equal(run("fields.checks.required"), false);
  run("fields.checks.value='npm test';api=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});};");
  await run("submit(fields)");
  assert.equal(context.requests[0].body.kind, "unconfigured");
  assert.equal(context.requests[0].body.checksText, "npm test");
  assert.equal(context.requests[0].body.url, "");
  run("fields.kind.value='local';fields.kind.listeners.change()");
  assert.equal(run("fields.url.parentElement.hidden"), false);
  assert.equal(run("fields.url.required"), true);
});

test("Git project settings preserves delivery rules without a fixed deployment environment", async () => {
  const { run } = workbench();
  run(`api=async url=>url==='/api/project-git'?{root:'/app',baseBranch:'main',releaseBranch:'main'}:
    {kind:'unconfigured',mode:'git',configHash:'shown-config',checksText:'npm test',url:'',
     gitDelivery:{testMode:'merge',testBranch:'integration'},checksEnvironment:[],deploymentEnvironment:[],timeoutMs:30000};
    structuredModal=(title,description,build)=>{globalThis.fields=build(document.createElement('form'));};`);
  await run("openTestEnvironmentSettings()");
  assert.equal(run("fields.testMode.value"), "merge");
  assert.notEqual(run("fields.testMode.parentElement.parentElement.hidden"), true);
  assert.equal(run("fields.testBranch.value"), "integration");
  assert.equal(run("fields.testBranch.required"), true);
  assert.equal(run("fields.url.parentElement.hidden"), true);
  assert.equal(run("fields.kind.children.some(option=>option.value==='jenkins')"), true);
});

test("local validation opens automatically started services without an editable command form", async () => {
  const { context, run } = workbench();
  run(`state.detail.meta={state:'verified',afterHash:'shown-code',planHash:'shown-plan'};
    globalThis.form=document.createElement('form');
    api=async(url,options)=>{if(url.startsWith('/api/local-environment-scan'))return {setup:{settings:null}};
      globalThis.started=JSON.parse(options.body);return {workspace:'/isolated/work',patch:null,status:'running',
      services:[{name:'后端',healthUrl:'http://127.0.0.1:9001/health',applicationUrl:null,tail:'API ready'},
        {name:'前端',healthUrl:'http://127.0.0.1:9000/health',applicationUrl:'http://127.0.0.1:9000/templates',tail:'Ready'}]};};
    structuredModal=(title,description,build,submit)=>{globalThis.fields=build(form);globalThis.submit=submit;};
    globalThis.sent=[];sendAction=async(action,input,returnResult)=>{
      if(returnResult)return api('/actions',{body:JSON.stringify({action,...input})});
      sent.push([action,input]);return true;};`);
  await run("openGitDelivery('local-validation')");
  assert.equal(context.sent.length, 0);
  assert.equal(context.started.expectedAfterHash, "shown-code");
  assert.equal(run("form.children.find(node=>node.tagName==='A').href"), "http://127.0.0.1:9000/templates");
  assert.equal(run("form.children.filter(node=>node.tagName==='A').length"), 1);
  assert.ok(run("form.children.some(node=>node.textContent.includes('9001/health'))"));
  assert.equal(run("fields.instructions"), undefined);
  assert.equal(run("fields.url"), undefined);
  await run("form.children.find(node=>node.textContent==='停止本地环境').listeners.click()");
  assert.equal(context.sent[0][0], "local-validation");
  assert.equal(context.sent[0][1].operation, "stop");
  assert.equal(context.sent[0][1].expectedAfterHash, "shown-code");
  assert.equal(context.sent.length, 1);
});

test("database startup effects require confirmation tied to the displayed environment revision", async () => {
  const { run } = workbench();
  run(`state.detail.meta={state:'verified',afterHash:'code',planHash:'plan'};
    api=async()=>({setup:{revision:'environment-revision',version:2,settings:{scan:{},target:'all'}},
      scan:{services:[{id:'app:backend',kind:'application',effects:['启动会更新数据库']} ]}});
    globalThis.form=document.createElement('form');globalThis.sent=[];
    structuredModal=(title,description,build,submit)=>{globalThis.fields=build(form);globalThis.submit=submit;};
    sendAction=async(action,input)=>{sent.push(input);return null;};`);
  await run("openGitDelivery('local-validation')");
  assert.equal(run("sent.length"), 0);
  await assert.rejects(run("submit(fields)"), /重新确认/);
  await run("fields.consent.checked=true;submit(fields)");
  assert.equal(run("sent[0].confirmStartupEffects"), true);
  assert.equal(run("sent[0].expectedEnvironmentRevision"), "environment-revision");
});

test("service forms preserve drafts across target changes and require confirming rescan differences", async () => {
  const { run } = workbench();
  run(`state.environmentRequest=1;globalThis.root=document.createElement('div');
    globalThis.allNodes=node=>[node,...node.children.flatMap(allNodes)];
    globalThis.apps=[{id:'app:frontend',name:'前端',kind:'application',role:'frontend',requirement:'required',effects:[],evidence:[],
      fields:[{key:'HOST',label:'地址',type:'input',secret:false,requirement:'required'}]},
      {id:'app:backend',name:'后端',kind:'application',role:'backend',requirement:'required',effects:[],evidence:[],
      fields:[{key:'TOKEN',label:'密码',type:'password',secret:true,requirement:'required'}]}];
    globalThis.setup={revision:'saved',version:1,values:{'app:frontend/HOST':'old.local'},secretConfigured:{'app:backend/TOKEN':true},
      settings:{target:'all',decisions:{},scan:{hash:'old',services:apps}}};
    globalThis.scan={hash:'old',services:apps,pipelines:[],warnings:[],scannedAt:'2026-10-11T00:00:00Z'};
    globalThis.posts=[];refresh=async()=>{};
    api=async(url,options)=>{if(options){posts.push(JSON.parse(options.body));return {};}
      return {setup,scan,scanTaskId:null,sources:[{id:'',name:'项目源码'}],diff:{added:['新增配置'],removed:[],changed:['前端']}};};`);
  await run("renderScannedEnvironment(root,'demo',1)");
  assert.equal(run("allNodes(root).find(node=>node.type==='password').value"), "");
  assert.equal(run("allNodes(root).find(node=>node.type==='password').placeholder"), "已配置，留空保持");
  run(`allNodes(root).find(node=>node.type==='text').value='draft.local';
    globalThis.target=allNodes(root).find(node=>node.tagName==='SELECT'&&node.children.some(option=>option.value==='frontend'));
    target.value='frontend';target.listeners.change();`);
  assert.equal(run("allNodes(root).find(node=>node.type==='text').value"), "draft.local");
  run("scan={...scan,hash:'new'}");
  await run("allNodes(root).find(node=>node.textContent==='重新扫描').listeners.click()");
  await run("root.children[0].onsubmit({preventDefault(){}})");
  assert.equal(run("posts.length"), 0); assert.match(run("messages.at(-1)"), /确认扫描差异/);
  run("allNodes(root).find(node=>node.type==='checkbox').checked=true");
  await run("root.children[0].onsubmit({preventDefault(){}})");
  assert.equal(run("posts[0].target"), "frontend");
  assert.equal(run("posts[0].values['app:frontend/HOST']"), "draft.local");
  assert.equal(run("posts[0].values['app:backend/TOKEN']"), "");
  assert.equal(run("posts[0].expectedRevision"), "saved"); assert.equal(run("posts[0].acceptScanChanges"), true);
});

test("root import submits the whole project rather than assigning it to one frontend folder", async () => {
  const { context, run } = workbench();
  run(`globalThis.nodes = Object.fromEntries(['importProjectForm','importProjectError','importProjectName','importRootPath',
    'importFrontendPath','importBackendPath','importConfig','importAnalysisContent','importAnalysis','importProjectSubmit','importProjectModal']
    .map(id=>['#'+id,document.createElement('div')]));
    document.querySelector=id=>nodes[id]; nodes['#importProjectForm'].reset=()=>{};
    nodes['#importProjectName'].value='Form editor'; nodes['#importRootPath'].value='/projects/form-edit';
    nodes['#importFrontendPath'].value=''; nodes['#importBackendPath'].value=''; nodes['#importConfig'].files=[];
    globalThis.requests=[]; api=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});
      return url.endsWith('/analyze') ? {hasFrontend:true,hasBackend:true,frontendDir:'frontend',backendDir:'backend'} : {id:'imported'};};
    switchProject=async id=>{globalThis.switched=id;}; showProjectOverview=()=>{};`);
  run(source.slice(source.indexOf('$("#importProjectForm").addEventListener("submit"'), source.indexOf("function showProjectOverview(project)")));
  await run("nodes['#importProjectForm'].listeners.submit({preventDefault(){}})");
  assert.equal(context.requests.length, 2);
  assert.equal(context.requests[0].body.directory, "/projects/form-edit");
  assert.equal(context.requests[1].body.rootDir, "/projects/form-edit");
  assert.equal(context.requests[1].body.frontendDir, undefined); assert.equal(context.requests[1].body.backendDir, undefined);
  assert.equal(context.switched, "imported");
  run("requests.length=0;nodes['#importFrontendPath'].value='/projects/form-edit/frontend'");
  await run("nodes['#importProjectForm'].listeners.submit({preventDefault(){}})");
  assert.equal(context.requests.length, 0);
  assert.match(run("nodes['#importProjectError'].textContent"), /请选择一种/);
});

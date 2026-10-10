import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPi } from "../src/pi-runner.js";
import { validateConfig } from "../src/config.js";

test("model usage defaults are explicit and invalid policies are rejected", async () => {
  const config = JSON.parse(await fs.readFile(new URL("../examples/config.local.json", import.meta.url), "utf8"));
  assert.equal(validateConfig(config).modelUsage.initializationMaxRequests, 1);
  assert.equal(validateConfig(config).modelUsage.readOnlyMaxRequests, 6);
  assert.equal(validateConfig({ ...config, modelUsage: { maxRequests: 2 } }).modelUsage.maxRequests, 2);
  for (const modelUsage of [null, [], { maxRequests: 0 }, { maxTokens: 1.5 }, { unknown: 1 }]) {
    assert.throws(() => validateConfig({ ...config, modelUsage }), /modelUsage/);
  }
  assert.throws(() => validateConfig({ ...config, thinking: "unknown" }), /thinking/);
  assert.throws(() => validateConfig({ ...config, structuredOutput: "true" }), /structuredOutput/);
});

test("raw source evidence is reused, invalidated on source changes and rejects tampering", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-source-evidence-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(path.join(directory, "source.py"), "def existing():\n    return 7\n");
  await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
await fs.writeFile('actual-prompt.txt',process.argv.at(-1));
console.log(JSON.stringify({type:'tool_execution_start',toolName:'read',toolCallId:'read-1',args:{path:'source.py',offset:1,limit:2}}));
console.log(JSON.stringify({type:'tool_execution_end',toolName:'read',toolCallId:'read-1',result:{content:[{type:'text',text:'read succeeded'}]},isError:false}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'{"privateConclusion":"must not reuse"}'}],
usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}},stopReason:'stop'}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  const project = { config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000,
    maxToolCalls: 10, maxEventBytes: 10000 } };
  const run = number => runPi(project, directory, "plan", "independently review", path.join(directory, `${number}.jsonl`), 1);
  const first = await run(1);
  assert.equal(first.telemetry.requestLimit, 6);
  assert.equal(first.telemetry.sourceEvidence.captured.length, 1);
  const second = await run(2);
  assert.equal(second.telemetry.requestLimit, 6, "cached excerpts do not prove that further investigation is unnecessary");
  assert.equal(second.telemetry.sourceEvidence.reused.length, 1);
  const prompt = await fs.readFile(path.join(directory, "actual-prompt.txt"), "utf8");
  assert.match(prompt, /1: def existing\(\):/);
  assert.ok(!prompt.includes("privateConclusion"));
  await fs.writeFile(path.join(directory, "source.py"), "def existing():\n    return 9\n");
  const changed = await run(3);
  assert.equal(changed.telemetry.sourceEvidence.invalidated[0].reason, "source changed");
  assert.equal(changed.telemetry.sourceEvidence.reused.length, 0);
  const complete = await runPi(project, directory, "implement", "use approved files", path.join(directory, "complete.jsonl"), 1,
    null, [], { maxTokens: 100, maxMs: 3000, approvedFiles: ["source.py"] });
  assert.equal(complete.telemetry.sourceEvidence.completeFiles.length, 1);
  const fullPrompt = await fs.readFile(path.join(directory, "actual-prompt.txt"), "utf8");
  assert.match(fullPrompt, /source\.py sha256=.*\(complete file\)/);
  assert.equal(fullPrompt.split("def existing():").length - 1, 1);
  const artifact = path.join(directory, first.telemetry.sourceEvidence.captured[0]);
  await fs.appendFile(artifact, " ");
  await assert.rejects(run(4), /Source evidence integrity failed/);
  await assert.rejects(fs.stat(path.join(directory, "4.jsonl")), { code: "ENOENT" });
});

test("complete write targets retain research for dependencies, callers and fixtures", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-complete-context-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "small.py"), "def existing():\n    return 7\n");
  await fs.writeFile(path.join(directory, "large.py"), "# unrelated\n".repeat(1500) + "def existing():\n    return 7\n");
  await fs.writeFile(path.join(directory, "tests.py"), "# unrelated\n".repeat(1500)
    + "def test_list_datasets_returns_original_envelope():\n    assert payload['data']['datasets']\n");
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
await fs.writeFile('arguments.json',JSON.stringify({tools:process.argv[process.argv.indexOf('--tools')+1],policy:JSON.parse(process.env.REQFLOW_POLICY),prompt:process.argv.at(-1)}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  const project = { config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } };
  for (const [file, expected] of [["small.py", 1], ["large.py", 1], ["new.py", 1], ["tests.py", 1]]) {
    const result = await runPi(project, directory, "implement", "approved change", path.join(directory, `${file}.jsonl`), 1, null, [],
      { maxTokens: 100, maxMs: 3000, approvedFiles: [file], researchRequests: 1,
        sourceQuery: file === "tests.py" ? "Modify list_datasets_cmd; add regression coverage" : "Modify existing" });
    const args = JSON.parse(await fs.readFile(path.join(directory, "arguments.json"), "utf8"));
    assert.equal(args.policy.implementationResearchRequests, expected);
    assert.equal(result.telemetry.sourceEvidence.researchRequests, expected);
    assert.equal(args.tools.includes("read"), expected === 1);
    assert.equal(args.tools.includes("write"), file === "new.py");
    assert.ok(args.tools.includes("find") && args.tools.includes("ls"));
    assert.equal(result.telemetry.sourceEvidence.completeFiles.length, file === "small.py" ? 1 : 0);
    if (file === "small.py") assert.match(args.prompt, /small\.py.*complete file/);
    if (file === "large.py") {
      assert.match(args.prompt, /1499: # unrelated/);
      assert.ok(args.prompt.includes("def existing():"));
      assert.ok(result.telemetry.sourceEvidence.selectedBytes < 5000);
      assert.equal(result.telemetry.sourceEvidence.focusedFiles.length, 2);
      assert.equal(result.telemetry.sourceEvidence.focusedFiles[0].startLine, 1);
    }
    if (file === "tests.py") {
      assert.match(args.prompt, /test_list_datasets_returns_original_envelope/);
      assert.ok(args.prompt.includes("payload['data']"));
      assert.ok(result.telemetry.sourceEvidence.selectedBytes < 5000);
    }
  }
});

test("shared project evidence crosses requirement directories and rejects changed cache bytes", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-shared-source-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, ".reqflow");
  const a = path.join(archive, "tasks/A"); const b = path.join(archive, "tasks/B");
  await fs.mkdir(a, { recursive: true }); await fs.mkdir(b, { recursive: true });
  await fs.writeFile(path.join(directory, "app.js"), "export const value = 7;\n");
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `console.log(JSON.stringify({type:'tool_execution_start',toolName:'read',toolCallId:'r',args:{path:'app.js',offset:1,limit:1}}));
console.log(JSON.stringify({type:'tool_execution_end',toolCallId:'r',isError:false,result:{content:[]}}));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  const project = { archive, config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [".reqflow"], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } };
  const first = await runPi(project, directory, "plan", "prompt", path.join(a, "events.jsonl"), 1);
  const second = await runPi(project, directory, "plan", "prompt", path.join(b, "events.jsonl"), 1);
  assert.equal(second.telemetry.sourceEvidence.reused.length, 0);
  assert.equal(second.telemetry.sourceEvidence.indexed.length, 1);
  const focused = await runPi(project, directory, "review", "check app", path.join(b, "focused.jsonl"), 1, "backend", [],
    { maxTokens: 100, maxMs: 3000, contextFiles: ["app.js"] });
  assert.deepEqual(focused.telemetry.sourceEvidence.reusedFiles, ["app.js"]);
  await fs.appendFile(path.join(archive, "source-evidence", first.telemetry.sourceEvidence.captured[0]), " ");
  await assert.rejects(runPi(project, directory, "plan", "prompt", path.join(b, "tampered.jsonl"), 1), /integrity failed/);
});

test("specialist source budget prioritizes the cited function over unrelated cached code", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-review-source-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "cli.py"), "def unrelated():\n" + "# old evidence padding abcdefghijklmnopqrstuv\n".repeat(99)
    + "def target():\n" + "# relevant evidence abcdefghijklmnopqrstuv\n".repeat(79));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import {promises as fs} from 'node:fs';
await fs.writeFile('actual-prompt.txt',process.argv.at(-1));
if(process.env.REQFLOW_PHASE==='plan')for(const offset of [1,101]){
 console.log(JSON.stringify({type:'tool_execution_start',toolName:'read',toolCallId:'r'+offset,args:{path:'cli.py',offset,limit:80}}));
 console.log(JSON.stringify({type:'tool_execution_end',toolName:'read',toolCallId:'r'+offset,isError:false,result:{content:[{type:'text',text:'source'}]}}));
}
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  const project = { config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } };
  await runPi(project, directory, "plan", "find functions", path.join(directory, "plan.jsonl"), 1);
  const result = await runPi(project, directory, "review", "review target", path.join(directory, "review.jsonl"), 1, "qa", [],
    { maxTokens: 100, maxMs: 3000, contextFiles: ["cli.py"], sourceQuery: "cli.py:101" });
  const prompt = await fs.readFile(path.join(directory, "actual-prompt.txt"), "utf8");
  assert.match(prompt, /101: def target/);
  assert.ok(!prompt.includes("def unrelated"));
  assert.equal(result.telemetry.sourceEvidence.reused.length, 1);
});

test("local repair focuses diagnosed symbols instead of sending the entire large file", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-focused-repair-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  const unrelated = "# unrelated secret-free module documentation\n".repeat(500);
  await fs.writeFile(path.join(directory, "tests.py"), unrelated + "def test_output_fields():\n    assert fields == {'name'}\n");
  await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
await fs.writeFile('prompt.txt',process.argv.at(-1));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  const project = { config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local", environment: { pi: [] },
    allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } };
  const result = await runPi(project, directory, "implement", "Keep original acceptance", path.join(directory, "events.jsonl"), 1, null, [],
    { maxTokens: 100, maxMs: 3000, approvedFiles: ["tests.py"], researchRequests: 0,
      sourceQuery: "Repair test_output_fields using the actual output" });
  const prompt = await fs.readFile(path.join(directory, "prompt.txt"), "utf8");
  assert.match(prompt, /501: def test_output_fields/);
  assert.match(prompt, /not a complete file/);
  assert.ok(Buffer.byteLength(prompt) < 1500);
  assert.equal(result.telemetry.sourceEvidence.focusedFiles.length, 1);
  await assert.rejects(runPi(project, directory, "implement", "repair", path.join(directory, "missing-context.jsonl"), 1, null, [],
    { maxTokens: 100, maxMs: 3000, approvedFiles: ["tests.py"], researchRequests: 0 }), /requires verified source context/);
  assert.equal(result.telemetry.sourceEvidence.completeFiles.length, 0);
  assert.ok(result.telemetry.sourceEvidence.selectedBytes < 12000);
  await assert.rejects(runPi(project, directory, "review", "prompt", path.join(directory, "bad.jsonl"), 1, null, [],
    { maxTokens: 100, maxMs: 3000, contextFiles: ["../tests.py"] }), /Context files/);
});

test("diagnosed file and line references work for large files without Python or JavaScript symbols", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-line-context-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "Service.java"), "// unrelated source documentation\n".repeat(500)
    + "public String result() { return \"original\"; }\n");
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
assert.equal(process.argv[process.argv.indexOf('--tools')+1],'edit');
assert.match(process.argv.at(-1),/501: public String result/);
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  const project = { config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local", environment: { pi: [] },
    allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } };
  const limit = { maxTokens: 100, maxMs: 3000, approvedFiles: ["Service.java"], researchRequests: 0, sourceQuery: "Repair Service.java:501" };
  const result = await runPi(project, directory, "implement", "repair", path.join(directory, "events.jsonl"), 1, null, [], limit);
  assert.equal(result.telemetry.sourceEvidence.focusedFiles.length, 1);
  assert.ok(result.telemetry.sourceEvidence.selectedBytes < 12000);
  const exact = await runPi(project, directory, "implement", "repair", path.join(directory, "exact.jsonl"), 1, null, [],
    { ...limit, sourceQuery: "Repair Service.java:501-501" });
  assert.equal(exact.telemetry.sourceEvidence.focusedFiles[0].startLine, 501);
  assert.equal(exact.telemetry.sourceEvidence.focusedFiles[0].endLine, 501);
  const navigation = await runPi(project, directory, "implement", "repair", path.join(directory, "navigation.jsonl"), 1, null, [],
    { ...limit, sourceQuery: "Historical scope Service.java:1-400; current fix Service.java:501" });
  assert.ok(navigation.telemetry.sourceEvidence.focusedFiles.every(row => row.endLine - row.startLine < 80));
  await assert.rejects(runPi(project, directory, "implement", "repair", path.join(directory, "range.jsonl"), 1, null, [],
    { ...limit, sourceQuery: "Repair Service.java:500-503" }), /source range is outside/);
  await assert.rejects(runPi(project, directory, "implement", "repair", path.join(directory, "invalid.jsonl"), 1, null, [],
    { ...limit, sourceQuery: "Repair Service.java:999" }), /Requested source line is outside/);
  await assert.rejects(fs.stat(path.join(directory, "invalid.jsonl")), { code: "ENOENT" });
  await assert.rejects(runPi(project, directory, "implement", "repair", path.join(directory, "wrong-file.jsonl"), 1, null, [],
    { ...limit, sourceQuery: "Repair OtherService.java:501" }), /requires verified source context/);
});

test("implementation rejects whole-file replacements and oversized edits before writing", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-small-edits-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(path.join(directory, "long.py"), "original\n".repeat(60));
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
const handlers=new Map();let active; (await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler),setActiveTools: names=>{active=names;}});
const tool=handlers.get('tool_call');
await handlers.get('turn_end')({message:{stopReason:'toolUse'}});assert.equal(active,undefined);
assert.equal(await tool({toolName:'read',input:{path:'long.py',offset:1,limit:5}}),undefined);
const successful={role:'toolResult',toolName:'edit',isError:false,content:[{type:'text',text:'diff'.repeat(200)}]};
const failed={...successful,isError:true};
const assistant={role:'assistant',usage:{input:7,output:3,cacheRead:2,cacheWrite:0},content:[]};
const compacted=await handlers.get('context')({messages:[assistant,successful,failed]});
assert.equal(compacted.messages[0],assistant);assert.equal(compacted.messages[2],failed);
assert.match(compacted.messages[1].content[0].text,/audit log/);
assert.ok(compacted.messages[1].content[0].text.length<successful.content[0].text.length);
assert.equal((await tool({toolName:'write',input:{path:'long.py',content:'replacement'}})).block,true);
assert.equal((await tool({toolName:'edit',input:{path:'long.py',oldText:'original\\n'.repeat(60),newText:'replacement'}})).block,true);
assert.equal((await tool({toolName:'edit',input:{path:'long.py',edits:[{oldText:'original',newText:'changed'},{oldText:'original',newText:'replacement\\n'.repeat(51)}]}})).block,true);
assert.equal(await tool({toolName:'edit',input:{path:'long.py',edits:[{oldText:'original',newText:'changed'}]}}),undefined);
assert.equal(await tool({toolName:'edit',input:{path:'long.py',oldText:'original',newText:'changed'}}),undefined);
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],
usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}},stopReason:'stop'}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  await runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000,
    maxToolCalls: 10, maxEventBytes: 10000 } }, directory, "implement", "small edits",
    path.join(directory, "events.jsonl"), 1);
  assert.equal(await fs.readFile(path.join(directory, "long.py"), "utf8"), "original\n".repeat(60));
});

for (const kind of ["context", "requests", "tokens"]) {
  test(`Pi stops ${kind} budget before another provider call`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-preflight-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "pi.mjs");
    const marker = path.join(directory, "provider-calls");
    const guardUrl = new URL("../src/pi-guard.js", import.meta.url).href;
    await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
const handlers=new Map();const guard=(await import(${JSON.stringify(guardUrl)})).default;
guard({on:(name,handler)=>handlers.set(name,[...(handlers.get(name)??[]),handler]),appendEntry:(customType,data)=>console.log(JSON.stringify({type:'entry_appended',entry:{type:'custom',customType,data}}))});
const kind=${JSON.stringify(kind)};
if(kind==='tokens')for(const handler of handlers.get('message_end'))await handler({message:{role:'assistant',content:[],usage:{input:8,output:2,cacheRead:0,cacheWrite:0}}});
for(const handler of handlers.get('context'))await handler({messages:kind==='tokens'?[{role:'assistant',usage:{input:8,output:2,cacheRead:0,cacheWrite:0}}]:[]});
await handlers.get('before_provider_request')[0]({payload:{messages:[{content:kind==='context'?'x'.repeat(1001):'small'}]}},{});
await fs.appendFile(${JSON.stringify(marker)},'call\\n');
if(kind==='requests')await handlers.get('before_provider_request')[0]({payload:{messages:[]}},{});
await fs.appendFile(${JSON.stringify(marker)},'unexpected\\n');
`);
    const project = { config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
      environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000,
      maxToolCalls: 10, maxEventBytes: 10000, modelUsage: { maxContextBytes: 1000,
        maxRequests: 1, maxToolResultBytes: 1000, maxTokens: 10 } } };
    await assert.rejects(runPi(project, directory, "plan", "read only", path.join(directory, "events.jsonl"), 1),
      /REQFLOW_BUDGET_STOP/);
    if (kind === "requests") assert.equal(await fs.readFile(marker, "utf8"), "call\n");
    else await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  });
}

test("structured output sets provider JSON mode and rejects unsupported APIs before sending", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-json-mode-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  const guardUrl = new URL("../src/pi-guard.js", import.meta.url).href;
  const marker = path.join(directory, "payload.json");
  for (const api of ["openai-completions", "anthropic-messages"]) {
    await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
const handlers=new Map();(await import(${JSON.stringify(guardUrl)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler)});
const event={payload:{messages:[]}};
await handlers.get('before_provider_request')(event,{model:{api:${JSON.stringify(api)},maxTokens:2048}});
await fs.writeFile(${JSON.stringify(marker)},JSON.stringify(event.payload));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'{}'}],
usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}},stopReason:'stop'}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
    const project = { config: { piExecutable: executable, provider: "fake", model: "fake", structuredOutput: true,
      mode: "local", environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [],
      maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } };
    const run = () => runPi(project, directory, "initialize", "JSON", path.join(directory, `${api}.jsonl`), 1);
    if (api === "openai-completions") {
      await run();
      assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")).response_format, { type: "json_object" });
      await fs.unlink(marker);
    } else {
      await assert.rejects(run(), /structured output requires/);
      await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    }
  }
});

test("read limits constrain actual result bytes rather than rejecting a valid 100-line request", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-read-budget-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
const handlers=new Map();(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler)});
const request={toolName:'read',input:{path:'pi.mjs',offset:1,limit:100}};
assert.equal(await handlers.get('tool_call')(request),undefined);assert.equal(request.input.limit,100);
const functionSchema={name:'read',description:'Read source',parameters:{properties:{limit:{maximum:80}}}};
await handlers.get('before_provider_request')({payload:{messages:[],tools:[{function:functionSchema}]}},{});
assert.equal(functionSchema.parameters.properties.limit.maximum,undefined);
assert.equal(functionSchema.parameters.properties.limit.default,80);
assert.equal(await handlers.get('tool_result')({toolName:'read',content:[{type:'text',text:'line\\n'.repeat(100)}]}),undefined);
const rejected=await handlers.get('tool_result')({toolName:'read',content:[{type:'text',text:'x'.repeat(1001)}]});
assert.equal(rejected.isError,true);assert.equal(rejected.details.budgetRejected,true);
assert.ok(!JSON.stringify(rejected).includes('x'.repeat(1001)));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  await runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000,
    maxToolCalls: 10, maxEventBytes: 10000, modelUsage: { maxToolResultBytes: 1000 } } },
    directory, "plan", "inspect", path.join(directory, "events.jsonl"), 1);
});

test("oversized source results return an explicit audited tool error instead of loading source", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-tool-budget-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  const marker = path.join(directory, "tool-result.json");
  await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
const handlers=new Map();(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler)});
const result=await handlers.get('tool_result')({toolName:'grep',content:[{type:'text',text:'x'.repeat(1001)}]});
await fs.writeFile(${JSON.stringify(marker)},JSON.stringify(result));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'{}'}],
usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}},stopReason:'stop'}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  await runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000,
    maxToolCalls: 10, maxEventBytes: 10000, modelUsage: { maxToolResultBytes: 1000 } } },
    directory, "intake", "JSON", path.join(directory, "events.jsonl"), 1);
  const result = JSON.parse(await fs.readFile(marker, "utf8"));
  assert.equal(result.isError, true);
  assert.equal(result.details.budgetRejected, true);
  assert.match(result.content[0].text, /Result rejected/);
  assert.ok(!JSON.stringify(result).includes('x'.repeat(1001)));
});

test("implementation tool failures stop before another model request", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-stop-edit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  const marker = path.join(directory, "unexpected-retry");
  await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
const handlers=new Map();(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler)});
const parameters={properties:{edits:{items:{properties:{oldText:{description:'old'},newText:{description:'new'}}}}}};
const event={payload:{messages:[],tools:[{function:{name:'edit',description:'edit',parameters}}]}};
await handlers.get('before_provider_request')(event,{});
if(!parameters.properties.edits.items.properties.newText.pattern)throw new Error('Missing line constraint');
await handlers.get('tool_result')({toolName:'edit',isError:true,content:[{type:'text',text:'Edit exceeds 50 lines'}]});
await fs.writeFile(${JSON.stringify(marker)},'unexpected provider retry');`);
  await assert.rejects(runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } },
    directory, "implement", "prompt", path.join(directory, "events.jsonl"), 1), /REQFLOW_TOOL_STOP.*Edit exceeds 50 lines/);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("inactive implementation tools stop at message completion without another provider call", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-inactive-tool-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  const marker = path.join(directory, "unexpected-request");
  await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
const handlers=new Map();(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler)});
const tool=await handlers.get('tool_call')({toolName:'read',input:{path:'pi.mjs',offset:1,limit:0}});
if(!tool?.block||!tool.reason.includes('positive integer'))throw new Error('Invalid read limit was silently altered');
await handlers.get('message_end')({message:{role:'toolResult',toolName:'read',isError:true,content:[{type:'text',text:'Tool read not found'}]}});
await fs.writeFile(${JSON.stringify(marker)},'unexpected retry');`);
  await assert.rejects(runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } },
    directory, "implement", "prompt", path.join(directory, "events.jsonl"), 1), /REQFLOW_TOOL_STOP.*Tool read not found/);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("provider allowance is shared across phases and quota errors with paid usage cannot renew it", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-provider-cap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
const handlers=new Map();const model={provider:'fake',id:'other',input:['text']};
(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler),setModel:async()=>true,setThinkingLevel:()=>{}});
const policy=JSON.parse(process.env.REQFLOW_POLICY);assert.equal(policy.providerRequestLimit,1);
const before=handlers.get('before_provider_request');await before({payload:{messages:[]}},{});
await handlers.get('turn_end')({message:{stopReason:'error',provider:'fake',model:'primary',errorMessage:'insufficient_quota',usage:{input:1,output:0,cacheRead:0,cacheWrite:0}}});
assert.equal(handlers.has('agent_before_settle'),false,'Quota errors must not install an automatic model switch');
await before({payload:{messages:[]}},{});throw new Error('A second request must not be sent');`);
  await assert.rejects(runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000,
    modelFallbacks: [{ provider: "fake", model: "other" }] } },
    directory, "plan", "prompt", path.join(directory, "events.jsonl"), 1, null, [],
    { maxTokens: 100, maxMs: 3000, maxRequests: 1 }), /remaining requirement provider request limit reached/);
});

test("a guard rejection before the first dispatch records zero usage, not unknown provider spend", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-no-dispatch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `const handlers=new Map();
(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler)});
await handlers.get('before_provider_request')({payload:{messages:[{role:'user',content:'x'.repeat(1000)}]}},
  {model:{api:'openai-completions',maxTokens:2048}});throw new Error('Rejected request dispatched');`);
  await assert.rejects(runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } },
    directory, "plan", "prompt", path.join(directory, "events.jsonl"), 1, null, [],
    { maxTokens: 100, maxMs: 3000 }), error => {
    assert.match(error.message, /remaining tokens cannot fund request context/);
    assert.equal(error.telemetry.assistantMessages, 0);
    assert.equal(error.telemetry.requestRejectedBeforeDispatch, true);
    assert.deepEqual(error.telemetry.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    return true;
  });
});

test("provider preflight reserves input and caps output before dispatch", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-preflight-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
const handlers=new Map();(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,[...(handlers.get(name)??[]),handler])});
const before=handlers.get('before_provider_request')[0];const ctx={model:{api:'openai-completions',maxTokens:2000}};
const event={payload:{messages:[{role:'user',content:'x'.repeat(500)}],max_tokens:2000}};
await before(event,ctx);assert.ok(event.payload.max_tokens>0&&event.payload.max_tokens<750);
for(const handler of handlers.get('message_end'))await handler({message:{role:'assistant',content:[],usage:{input:700,output:100,cacheRead:0,cacheWrite:0}}});
for(const handler of handlers.get('context'))await handler({messages:[{role:'assistant',usage:{input:700,output:100,cacheRead:0,cacheWrite:0}}]});
await before({payload:{messages:[{role:'user',content:'x'.repeat(500)}]}},ctx);
throw new Error('Unaffordable request reached provider');`);
  await assert.rejects(runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } },
    directory, "plan", "prompt", path.join(directory, "events.jsonl"), 1, null, [],
    { maxTokens: 1000, maxMs: 3000 }), /remaining tokens cannot fund request context/);
});

test("preflight rejects an edit that cannot fund complete arguments without billing a response", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-edit-reserve-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `const handlers=new Map();
(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({on:(name,handler)=>handlers.set(name,handler)});
const edit={function:{name:'edit',description:'Exact replacement',parameters:{properties:{edits:{items:{properties:{oldText:{description:'Old'},newText:{description:'New'}}}}}}}};
await handlers.get('before_provider_request')({payload:{messages:[{role:'user',content:'approved'}],tools:[edit]}},{model:{api:'openai-completions',maxTokens:2000}});
throw new Error('Unaffordable edit reached provider');`);
  await assert.rejects(runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } },
    directory, "implement", "prompt", path.join(directory, "events.jsonl"), 1, null, [], { maxTokens: 1000, maxMs: 3000 }), error => {
      assert.match(error.message, /cannot fund a complete bounded edit/);
      assert.deepEqual(error.telemetry.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      return true;
    });
});

test("measured prefixes reduce overestimation; changed models, messages and failed measurements invalidate it", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-measured-budget-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
const handlers=new Map();const contextHandlers=[];(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>{if(name==='context')contextHandlers.push(handler);else handlers.set(name,handler);}});
const before=handlers.get('before_provider_request');const ctx={model:{provider:'fake',id:'model',api:'openai-completions',maxTokens:2000}};
const original={role:'user',content:'x'.repeat(1000)};
const definitions=['edit','write'].map(name=>({type:'function',function:{name,description:'x'.repeat(200)}}));
await before({payload:{messages:[original],tools:definitions}},ctx);
await handlers.get('message_end')({message:{role:'assistant',content:[],provider:'fake',model:'model',usage:{input:150,output:20,cacheRead:50,cacheWrite:0}}});
for(const handler of contextHandlers)await handler({messages:[{role:'assistant',provider:'fake',model:'model',usage:{input:150,output:20,cacheRead:50,cacheWrite:0}}]});
const next={payload:{messages:[original,{role:'user',content:'new'}],tools:[definitions[0]]}};await before(next,ctx);
assert.ok(next.payload.max_tokens>500,'Known prefix should not be reserved as wire bytes again');
await before({payload:{messages:[{...original,content:'different'}]}},ctx);
await before({payload:{messages:[{...original,content:'different'}]}},{model:{...ctx.model,id:'other'}});
for(const handler of contextHandlers)await handler({messages:[{role:'assistant',provider:'fake',model:'other',stopReason:'error',usage:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
await before({payload:{messages:[{...original,content:'different'}]}},{model:{...ctx.model,id:'other'}});
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'fake',model:'model',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:150,output:20,cacheRead:50,cacheWrite:0,cost:{total:0}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  const result = await runPi({ config: { piExecutable: executable, provider: "fake", model: "model", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000,
    modelUsage: { maxRequests: 5, readOnlyMaxRequests: 5 } } },
    directory, "plan", "plan", path.join(directory, "events.jsonl"), 1, null, [], { maxTokens: 1000, maxMs: 3000, maxRequests: 5 });
  assert.deepEqual(result.telemetry.requestEstimates.map(row => row.estimationMethod), ["wire_bytes", "measured_prefix", "wire_bytes", "wire_bytes", "wire_bytes"]);
  assert.equal(result.telemetry.requestEstimates[1].tokensUsed, 220);
});

test("request guard errors cannot be swallowed by Pi before provider dispatch", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-guard-error-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  const marker = path.join(directory, "provider-called");
  await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
const handlers=new Map();(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({on:(name,handler)=>handlers.set(name,handler)});
try { await handlers.get('before_provider_request')({payload:{tools:{}}},{}); } catch(error) { /* Pi emits extension errors and continues; the guard must terminate instead. */ }
await fs.writeFile(${JSON.stringify(marker)},'dispatched');
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  await assert.rejects(runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000,
    maxToolCalls: 10, maxEventBytes: 10000 } }, directory, "plan", "prompt", path.join(directory, "events.jsonl"), 1),
    /REQFLOW_GUARD_STOP: request guard failed/);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("native compaction retains exact task state, cumulative usage and the normal output schema", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-native-compaction-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
const handlers=new Map();(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({
on:(name,handler)=>handlers.set(name,[...(handlers.get(name)??[]),handler]),
appendEntry:(customType,data)=>console.log(JSON.stringify({type:'entry_appended',entry:{type:'custom',customType,data}}))});
const emit=async(name,event,ctx)=>{let value=event;for(const handler of handlers.get(name)??[]){const result=await handler(value,ctx);if(result?.messages)value={...value,messages:result.messages};}return value;};
const ctx={model:{provider:'fake',id:'model',api:'openai-completions',maxTokens:500}};
const measured={role:'assistant',content:[],usage:{input:100,output:10,cacheRead:0,cacheWrite:0,cost:{total:0}},stopReason:'toolUse'};
await emit('message_end',{message:measured});console.log(JSON.stringify({type:'message_end',message:measured}));
await emit('session_before_compact',{preparation:{messagesToSummarize:[],turnPrefixMessages:[measured],isSplitTurn:true,settings:{reserveTokens:125}}},ctx);
const summaryRequest={payload:{messages:[{role:'user',content:'Summarize old messages.'}],max_tokens:100}};
await handlers.get('before_provider_request')[0](summaryRequest,ctx);
assert.equal(summaryRequest.payload.response_format,undefined,'Task JSON schema must not constrain the native summary');
await emit('session_compact',{compactionEntry:{summary:'Old tools are summarized; no new authorization.',tokensBefore:1000,firstKeptEntryId:'entry-1',usage:{input:50,output:5,cacheRead:0,cacheWrite:0,cost:{total:0}}}});
const context=await emit('context',{messages:[]});assert.match(context.messages[0].content[0].text,/frozen-business/);
const request={payload:{messages:[{role:'user',content:'Continue with exact frozen requirement.'}],max_tokens:100}};
await handlers.get('before_provider_request')[0](request,ctx);assert.equal(request.payload.response_format.type,'json_object');
console.log(JSON.stringify({type:'message_end',message:{...measured,content:[{type:'text',text:'{}'}],stopReason:'stop'}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  const result = await runPi({ config: { piExecutable: executable, provider: "fake", model: "model", mode: "local",
    structuredOutput: true, environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [],
    maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 20000 } }, directory, "plan", "prompt",
  path.join(directory, "events.jsonl"), 1, null, [], { maxTokens: 10000, maxMs: 3000, authoritativeContext: { contract: "frozen-business" } });
  assert.equal(result.telemetry.requestEstimates[0].tokensUsed, 165);
  assert.equal(result.telemetry.tokens.input, 250);
  assert.equal(result.telemetry.compactions.length, 1);
  assert.equal(result.telemetry.assistantMessages, 3);
});

test("writing every approved file does not imply all edits are complete", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-terminal-context-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
const handlers=new Map();let active;
(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler),setActiveTools:tools=>{active=tools;}});
const ctx={model:{api:'openai-completions',maxTokens:2000}};
const event=()=>({payload:{messages:[{role:'user',content:'original contract'}],tools:[]}});
const first=event();await handlers.get('before_provider_request')(first,ctx);
assert.equal(first.payload.messages[0].content,'original contract');
await handlers.get('tool_result')({toolName:'edit',isError:false,input:{path:'source.py'},content:[]});
const last=event();await handlers.get('before_provider_request')(last,ctx);
assert.deepEqual(last.payload.tools,[]);assert.equal(active,undefined);
assert.equal(await handlers.get('tool_call')({toolName:'read',input:{path:'source.py'}}),undefined);
assert.equal(last.payload.messages[0].content,'original contract');
assert.equal(await handlers.get('tool_call')({toolName:'edit',input:{path:'source.py',edits:[{oldText:'value = 1',newText:'value = 2'}]}}),undefined);
await handlers.get('message_end')({message:{role:'assistant',content:[{type:'text',text:'REQFLOW_EDITS_COMPLETE'}],usage:{input:100,output:10,cacheRead:0,cacheWrite:0}}});
const finished=event();await handlers.get('before_provider_request')(finished,ctx);
assert.equal(finished.payload.tools,undefined);assert.equal(finished.payload.max_tokens,128);
assert.match(finished.payload.messages[0].content,/explicitly declared/);
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'External verification required.'}],usage:{input:100,output:10,cacheRead:0,cacheWrite:0,cost:{total:0}},stopReason:'stop'}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  await fs.writeFile(path.join(directory, "source.py"), "value = 1\n");
  await runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local", environment: { pi: [] },
    allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } },
    directory, "implement", "prompt", path.join(directory, "events.jsonl"), 1, null, [],
    { maxTokens: 1000, maxMs: 3000, approvedFiles: ["source.py"] });
});

test("adaptive request expansion stops when the candidate makes no further progress", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-stalled-progress-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(path.join(directory, "source.py"), "value = 1\n");
  await fs.writeFile(executable, `import fs from 'node:fs';
const handlers=new Map();
(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({on:(name,fn)=>handlers.set(name,fn),appendEntry:(customType,data)=>console.log(JSON.stringify({type:'entry_appended',entry:{customType,data}}))});
const event=()=>({payload:{messages:[],tools:[]}});
const ctx={model:{api:'openai-completions',maxTokens:2048}};
await handlers.get('before_provider_request')(event(),ctx);
fs.writeFileSync('source.py','value = 2\\n');
await handlers.get('tool_result')({toolName:'edit',isError:false,input:{path:'source.py'},content:[]});
await handlers.get('before_provider_request')(event(),ctx);
await handlers.get('before_provider_request')(event(),ctx);
throw new Error('Unchanged candidate must not dispatch another request');`);
  let failure;
  await assert.rejects(runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10,
    maxEventBytes: 10000, modelUsage: { maxRequests: 1 } } }, directory, "implement", "prompt",
    path.join(directory, "events.jsonl"), 1, null, [], { maxTokens: 24000, maxMs: 3000,
      approvedFiles: ["source.py"], budget: { mode: "adaptive", complexity: "small" } }), error => {
    failure = error;
    return /model request limit reached/.test(error.message);
  });
  assert.equal(failure.telemetry.requestBudgetExpansions.length, 1);
  assert.equal(failure.telemetry.requestEstimates.length, 2);
  assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 2\n");
});

test("read-only analysis reserves its final request for JSON without tools", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-final-json-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
const handlers=new Map();(await import(${JSON.stringify(new URL('../src/pi-guard.js', import.meta.url).href)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,handler)=>handlers.set(name,handler)});
const event=()=>({payload:{messages:[],tools:[{type:'function'}],tool_choice:'auto'}});
const first=event();await handlers.get('before_provider_request')(first,{model:{api:'openai-completions',maxTokens:2048}});
assert.ok(first.payload.tools);assert.deepEqual(first.payload.response_format,{type:'json_object'});
assert.equal(first.payload.tool_choice,'auto');
const last=event();await handlers.get('before_provider_request')(last,{model:{api:'openai-completions',maxTokens:2048}});
assert.equal(last.payload.tools,undefined);assert.equal(last.payload.tool_choice,undefined);
assert.deepEqual(last.payload.response_format,{type:'json_object'});
assert.match(last.payload.messages.at(-1).content,/FULL JSON object/);
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'{}'}],
usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}},stopReason:'stop'}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  await runPi({ config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    structuredOutput: true, environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [],
    maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000, modelUsage: { maxRequests: 2 } } },
    directory, "intake", "JSON", path.join(directory, "events.jsonl"), 1);
});

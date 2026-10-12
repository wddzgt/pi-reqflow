import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPi } from "../src/pi-runner.js";
import { validateConfig } from "../src/config.js";
import { admissionDefaults, admissionInput, validateAdmissionPolicy } from "../src/admission.js";
import { planOutputSchema } from "../src/plan-analysis.js";

for (const scenario of ["progress", "stalled", "strict", "storage", "storage-cap"]) {
  test(`execution targets and explicit caps: ${scenario}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-limits-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const executable = path.join(root, "pi.mjs");
    await fs.writeFile(executable, `const handlers=new Map();
const emit=async(name,event,ctx)=>{for(const fn of handlers.get(name)||[])await fn(event,ctx);};
(await import(${JSON.stringify(new URL("../src/pi-guard.js", import.meta.url).href)})).default({
on:(name,fn)=>handlers.set(name,[...(handlers.get(name)||[]),fn]),
appendEntry:(customType,data)=>console.log(JSON.stringify({type:'entry_appended',entry:{customType,data}}))});
const ctx={model:{provider:'fixture',id:'fixture',api:'openai-completions',contextWindow:32000,maxTokens:1000}};
for(let i=0;i<${scenario === "stalled" ? 9 : 5};i++){
await emit('before_provider_request',{payload:{messages:[{role:'user',content:'Read approved evidence.'}],max_tokens:1000}},ctx);
const args={path:'evidence.txt',offset:${scenario === "stalled" ? "1" : "i+1"},limit:1};
await emit('tool_call',{toolCallId:'read-'+i,toolName:'read',input:args});
await emit('tool_result',{toolCallId:'read-'+i,toolName:'read',isError:false,content:[{type:'text',text:'Verified evidence '+${scenario === "stalled" ? "1" : "i"}}]});
const message={role:'assistant',content:[{type:'text',text:'{"ok":true}'}],stopReason:'stop',usage:{input:100,output:10,cacheRead:0,cacheWrite:0,cost:{total:0}}};
await emit('message_end',{message});console.log(JSON.stringify({type:'message_end',message}));
}

console.log(JSON.stringify({type:'agent_settled'}));`);
    const config = { piExecutable: executable, provider: "fixture", model: "fixture", mode: "local",
      environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000,
      maxToolCalls: 1, maxEventBytes: 8, modelUsage: { maxRequests: 2, readOnlyMaxRequests: 2, maxTokens: 10000 },
      ...(scenario === "storage-cap" ? { maxAuditBytes: 1000 } : {}) };
    const log = path.join(root, "events.jsonl");
    const operation = runPi({ config }, root, "plan", "Read evidence then return JSON", log, 1, null, [],
      { maxTokens: 10000, maxRequests: 2, budget: { mode: scenario === "strict" ? "strict" : "adaptive", complexity: "planning" } });
    if (scenario === "stalled") await assert.rejects(operation, /three requests without new relevant tool evidence/);
    else if (scenario === "strict") await assert.rejects(operation, /remaining requirement provider request limit reached/);
    else if (scenario === "storage-cap") await assert.rejects(operation, /explicit audit storage cap/);
    else { const result = await operation; assert.equal(result.telemetry.assistantMessages, 5); assert.equal(result.telemetry.requestLimit, null); }
    assert.ok((await fs.stat(log)).size > 8, "keep real evidence beyond the former log threshold");
  });
}

test("planning counts are estimates and model context remains a real capacity", async () => {
  assert.equal(validateAdmissionPolicy({ ...admissionDefaults, maxFiles: 45 }).maxFiles, 45);
  assert.equal(planOutputSchema.schema.properties.affectedFiles.maxItems, undefined);
  assert.equal(planOutputSchema.schema.properties.validation.properties.startup.maxItems, undefined);
  const boundaries = { modules: [{ name: "shared service", files: ["service.mjs"], evidence: "Shared code" }],
    deliveryUnits: Array.from({ length: 12 }, (_, index) => ({ name: `deployment-${index}`, evidence: "Separate deployment using shared code" })),
    designStages: 1, estimatedChangedLines: 20, exclusions: [], coordination: { status: "none", evidence: "None" },
    verification: { status: "ready", evidence: "Tests" }, recovery: { status: "code_only", evidence: "No data change" },
    externalEffects: { status: "none", evidence: "None" } };
  assert.equal(admissionInput(boundaries, ["service.mjs"]).deliveryUnits.length, 12);
  const config = JSON.parse(await fs.readFile(new URL("../examples/config.local.json", import.meta.url)));
  const current = validateConfig({ ...config, maxCostUsd: null });
  assert.equal(current.executionTimeouts.startupMs, 120000);
  assert.throws(() => validateConfig({ ...config, executionTimeouts: { checksMs: 100 } }), /startupMs/);
  assert.throws(() => validateConfig({ ...config, allowedPaths: ["../outside"] }), /Unsafe config path/);
});

test("unknown compatible prices cannot pretend to enforce an explicit USD cap", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-unknown-price-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(runPi({ config: { maxCostUsd: 2, provider: "compatible", model: "test",
    allowedPaths: ["."], excludedPaths: [], compatibleProviders: [{ name: "compatible", models: [{ id: "test" }] }] } },
  root, "plan", "prompt", path.join(root, "never-dispatched.jsonl"), 2), /模型价格未知/);
  await assert.rejects(fs.stat(path.join(root, "never-dispatched.jsonl")), { code: "ENOENT" });
});

test("verified directory arguments return an explicit tool error and direct the caller to ls", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-directory-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = { root: process.env.REQFLOW_WORKSPACE, policy: process.env.REQFLOW_POLICY, phase: process.env.REQFLOW_PHASE };
  process.env.REQFLOW_WORKSPACE = root; process.env.REQFLOW_PHASE = "plan";
  process.env.REQFLOW_POLICY = JSON.stringify({ allowedPaths: ["."], excludedPaths: [] });
  t.after(() => { for (const [name, value] of [["REQFLOW_WORKSPACE", previous.root], ["REQFLOW_POLICY", previous.policy], ["REQFLOW_PHASE", previous.phase]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  const handlers = new Map(), entries = [];
  (await import("../src/pi-guard.js")).default({ on: (name, fn) => handlers.set(name, fn), appendEntry: (type, data) => entries.push({ type, data }) });
  const result = await handlers.get("tool_call")({ toolName: "read", toolCallId: "directory", input: { path: "." } });
  assert.equal(result.block, true); assert.match(result.reason, /Use ls/);
  assert.equal(entries[0].type, "reqflow_tool_retry");
  assert.equal(await handlers.get("message_end")({ message: { role: "toolResult", toolCallId: "directory", isError: true, toolName: "read", content: [{ type: "text", text: result.reason }] } }), undefined);
});

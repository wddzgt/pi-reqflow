import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPi } from "../src/pi-runner.js";
import { validateConfig } from "../src/config.js";

test("candidate configuration rejects duplicates and credential literals", async () => {
  const base = JSON.parse(await fs.readFile(new URL("../examples/config.local.json", import.meta.url)));
  const candidate = { provider: "pool", model: "small" };
  assert.throws(() => validateConfig({ ...base, modelFallbacks: [candidate, candidate] }), /Duplicate/);
  const provider = { name: "pool", baseUrl: "https://example.com/v1", apiKeyEnv: "MODEL_KEY", thinkingToggle: true,
    models: [{ id: "small", input: ["text"], contextWindow: 32000, maxTokens: 4000, reasoning: true }] };
  assert.throws(() => validateConfig({ ...base, compatibleProviders: [provider] }), /explicitly allowed/);
  const config = { ...base, environment: { ...base.environment, pi: ["MODEL_KEY"] }, compatibleProviders: [provider] };
  assert.equal(validateConfig(config).compatibleProviders[0].apiKeyEnv, "MODEL_KEY");
  assert.throws(() => validateConfig({ ...config, compatibleProviders: [{ ...provider,
    models: [{ ...provider.models[0], supportsJsonSchema: "true" }] }] }), /supportsJsonSchema/);
  for (const supportsReasoningEffort of ["low", 1]) assert.throws(() => validateConfig({ ...config,
    compatibleProviders: [{ ...provider, models: [{ ...provider.models[0], supportsReasoningEffort }] }] }), /supportsReasoningEffort/);
  assert.throws(() => validateConfig({ ...config, compatibleProviders: [{ ...provider,
    models: [{ ...provider.models[0], reasoning: false, supportsReasoningEffort: true }] }] }), /supportsReasoningEffort/);
  assert.throws(() => validateConfig({ ...config, compatibleProviders: [{ ...provider, apiKey: "secret" }] }), /Unknown/);
});

test("quota and authentication errors stop without automatic switching and preserve paid usage", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-routing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  const guard = new URL("../src/pi-guard.js", import.meta.url).href;
  const config = { piExecutable: executable, provider: "pool", model: "primary", thinking: "off",
    modelFallbacks: [{ provider: "pool", model: "secondary" }], mode: "local", environment: { pi: [] },
    allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 20000,
    modelUsage: { maxRequests: 2, maxTokens: 20 } };
  for (const errorCode of ["AllocationQuota.FreeTierOnly", "InvalidApiKey"]) {
    await fs.writeFile(executable, `import assert from 'node:assert/strict';
const handlers=new Map();let selected;const thinking=[];
(await import(${JSON.stringify(guard)})).default({appendEntry:(customType,data)=>console.log(JSON.stringify({type:"entry_appended",entry:{type:"custom",customType,data}})),on:(name,fn)=>handlers.set(name,[...(handlers.get(name)??[]),fn]),setModel:async model=>{selected=model;return true;},setThinkingLevel:level=>thinking.push(level)});
const emit=message=>console.log(JSON.stringify({type:'message_end',message}));
const paid={role:'assistant',provider:'pool',model:'primary',stopReason:'toolUse',content:[],usage:{input:7,output:2,cacheRead:0,cacheWrite:0,cost:{total:0.01}}};
emit(paid);
for(const fn of handlers.get('context'))await fn({messages:[paid]});
const pre=handlers.get('before_provider_request')[0];await pre({payload:{}},{});await pre({payload:{}},{});
const failure={...paid,stopReason:'error',errorMessage:${JSON.stringify(errorCode)},usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}};emit(failure);
await handlers.get('turn_end')[0]({message:failure});
for(const fn of handlers.get('agent_before_settle')??[]) assert.equal(await fn({},{}),undefined);
assert.equal(selected,undefined);assert.deepEqual(thinking,[]);
console.log(JSON.stringify({type:'agent_settled'}));`);
    const run = () => runPi({ config }, directory, "plan", "prompt", path.join(directory, `${errorCode}.jsonl`), 1);
    await assert.rejects(run(), error => {
      assert.equal(error.telemetry.modelSwitches.length, 0);
      assert.equal(error.telemetry.modelAttempts.length, 2);
      assert.equal(error.costUsd, 0.01);
      return error.message.includes(errorCode);
    });
  }
});

test("JSON output must satisfy the complete local schema even without provider constraints", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-schema-routing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'pool',model:'primary',stopReason:'stop',
content:[{type:'text',text:'{"ok":"wrong","extra":true}'}],usage:{input:10,output:5,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`);
  const config = { piExecutable: executable, provider: "pool", model: "primary", structuredOutput: true,
    modelFallbacks: ["primary", "unconstrained", "schema-secondary"].map(model => ({ provider: "pool", model })),
    mode: "local", environment: { pi: ["PATH"] }, allowedPaths: ["."], excludedPaths: [],
    maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 20000,
    compatibleProviders: [{ name: "pool", baseUrl: "https://example.com", apiKeyEnv: "PATH", models:
      ["primary", "unconstrained", "schema-secondary"].map(id => ({ id, supportsJsonSchema: id !== "unconstrained" })) }] };
  await assert.rejects(runPi({ config }, directory, "plan", "Return JSON", path.join(directory, "events.jsonl"), 1, null, [], {
    maxTokens: 1000, maxMs: 3000, outputSchema: { name: "test", strict: true,
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } },
  }), error => {
    assert.match(error.message, /不符合 test 结构/); assert.equal(error.telemetry.tokens.output, 5); return true;
  });
});

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPi } from "../src/pi-runner.js";
import { saveModelCredential } from "../src/model-credentials.js";
import { progressContext } from "../src/action-progress.js";

for (const dependency of ["fd", "rg", "broken-fd", "shared", "shared-tilde", "shared-relative"]) test(`real Pi preflight ${dependency} checks tools before requesting the model`, {
  skip: !process.env.REQFLOW_TEST_PI,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-preflight-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "shared");
  await fs.mkdir(path.join(home, "bin"), { recursive: true });
  const previous = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HOME: process.env.HOME };
  t.after(() => { for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  process.env.PATH = ""; process.env.HOME = directory;
  process.env.PI_CODING_AGENT_DIR = dependency === "shared-tilde" ? "~/shared" : dependency === "shared-relative" ? "shared" : home;
  for (const name of ["fd", "rg"]) if (dependency !== name) await fs.writeFile(path.join(home, "bin", name),
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('${name} fixture');process.exit(${dependency === "broken-fd" && name === "fd" ? 2 : 0});}
    console.log('source.py');`, { mode: 0o700 });
  await fs.writeFile(path.join(directory, "source.py"), "value = 1\n");
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk; requests.push(JSON.parse(body));
    const delta = requests.length % 2 ? { role: "assistant", tool_calls: [{ index: 0, id: "find-source", type: "function",
      function: { name: "find", arguments: '{"pattern":"*.py","path":"."}' } }] } : { role: "assistant", content: '{"verified":true}' };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "preflight", object: "chat.completion.chunk", choices: [{ index: 0,
      delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { piExecutable: process.env.REQFLOW_TEST_PI, provider: "preflight", model: "local", mode: "local", thinking: "off",
    environment: { pi: ["PI_CODING_AGENT_DIR"] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 10000, maxToolCalls: 4, maxEventBytes: 1000000,
    compatibleProviders: [{ name: "preflight", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "PI_CODING_AGENT_DIR",
      models: [{ id: "local", input: ["text"], contextWindow: 32000, maxTokens: 2000 }] }] };
  const firstLog = path.join(directory, "first.events.jsonl");
  if (!dependency.startsWith("shared")) {
    await assert.rejects(runPi({ config }, directory, "plan", "Locate source", firstLog, 1), /REQFLOW_DEPENDENCY_STOP/);
    assert.equal(requests.length, 0, "missing or broken dependencies must never consume a model request");
    return;
  }
  for (const log of [firstLog, path.join(directory, "second.events.jsonl")]) {
    assert.equal((await runPi({ config }, directory, "plan", "Locate source", log, 1)).text, '{"verified":true}');
    const events = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(events.some(event => event.entry?.customType === "reqflow_dependencies_checked"));
    assert.ok(events.some(event => event.type === "tool_execution_end" && event.toolName === "find" && !event.isError));
    await assert.rejects(fs.stat(path.join(`${log}.pi-home`, "bin")), { code: "ENOENT" }, "private directories never receive tool downloads");
    assert.ok((await fs.stat(path.join(`${log}.pi-home`, "settings.json"))).isFile());
  }
  assert.equal(requests.length, 4);
});

test("real Pi repeated resumes replace controller prompts and preserve source evidence and archives", {
  skip: !process.env.REQFLOW_TEST_PI,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-resume-context-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "source.py"), "value = 1\n");
  await fs.writeFile(path.join(directory, "evidence.txt"), "VERIFIED_SOURCE_FACT\n" + "source evidence\n".repeat(300));
  const protectedContract = { objective: "FROZEN_ACCEPTANCE", acceptance: [{ id: "AC1", text: "Preserve user decisions. ".repeat(20) }] };
  const design = "EXACT_MULTILINE_DESIGN\n" + "Preserve this design.\n".repeat(50);
  const payloads = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    payloads.push(JSON.parse(body));
    const delta = payloads.length <= 2 ? { role: "assistant", tool_calls: [{ index: 0, id: `read-evidence-${payloads.length}`,
      type: "function", function: { name: "read", arguments: JSON.stringify({ path: "evidence.txt" }) } }] }
      : payloads.length === 7 ? { role: "assistant", content: "REQFLOW_EDITS_COMPLETE", tool_calls: [{ index: 0,
        id: "edit-current", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: "source.py",
          edits: [{ oldText: "value = 1", newText: "value = 2" }] }) } }] }
      : { role: "assistant", content: payloads.length < 7 ? '{"verified":true}' : "Controller checks required." };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta,
      finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = process.env.RESUME_MODEL_KEY;
  process.env.RESUME_MODEL_KEY = "local-fixture";
  t.after(() => { if (previous === undefined) delete process.env.RESUME_MODEL_KEY; else process.env.RESUME_MODEL_KEY = previous; });
  const config = { piExecutable: process.env.REQFLOW_TEST_PI, provider: "local-resume", model: "local",
    mode: "local", thinking: "off", environment: { pi: ["RESUME_MODEL_KEY"] }, allowedPaths: ["."], excludedPaths: [],
    maxPiMs: 10000, maxToolCalls: 4, maxEventBytes: 1000000,
    modelUsage: { maxRequests: 3, readOnlyMaxRequests: 3, maxTokens: 60000, maxContextBytes: 64000, maxToolResultBytes: 8000 },
    compatibleProviders: [{ name: "local-resume", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "RESUME_MODEL_KEY",
      models: [{ id: "local", input: ["text"], contextWindow: 65536, maxTokens: 16384 }] }] };
  const padding = `${"current specification ".repeat(1500)}\nFrozen requirement: ${JSON.stringify(protectedContract)}\nDesign: ${JSON.stringify({ design })}`;
  const checkpoints = [];
  let result = await runPi({ config }, directory, "plan", `OLD_STAGE_INSTRUCTIONS\n${padding}`,
    path.join(directory, "plan.events.jsonl"), 1, null, [], { developerSession: true, maxTokens: 60000,
      authoritativeContext: { contract: protectedContract, design, currentState: "planning" } });
  for (let attempt = 1; attempt <= 3; attempt++) {
    checkpoints.push({ file: result.telemetry.sessionCheckpoint.file,
      content: await fs.readFile(result.telemetry.sessionCheckpoint.file, "utf8") });
    result = await runPi({ config }, directory, "plan", `LATEST_PLAN_INSTRUCTIONS\n${padding}`,
      path.join(directory, `resume-${attempt}.events.jsonl`), 1, null, [], { developerSession: true,
        maxTokens: 60000, resumeSession: result.telemetry.sessionCheckpoint,
        authoritativeContext: { contract: protectedContract, design, currentState: "planning" } });
    assert.equal(result.telemetry.requestEstimates[0].estimationMethod, "measured_retained", "resume reuses hash-bound provider input evidence");
  }
  checkpoints.push({ file: result.telemetry.sessionCheckpoint.file,
    content: await fs.readFile(result.telemetry.sessionCheckpoint.file, "utf8") });
  assert.ok(Buffer.byteLength(checkpoints.at(-1).content) > 132377, "archive retains all repeated stage prompts");
  const entries = checkpoints.at(-1).content.trim().split("\n").map(JSON.parse);
  const feedbackSession = path.join(directory, "feedback.session.jsonl");
  const feedbackContent = `${checkpoints.at(-1).content}${JSON.stringify({ type: "custom_message", id: "feedback1",
    parentId: entries.at(-1).id, timestamp: new Date().toISOString(), customType: "reqflow_verification_failure",
    content: "CHECK_FAILURE_PRESERVED: existing regression assertion failed; do not claim success.", display: true })}\n`;
  await fs.writeFile(feedbackSession, feedbackContent);
  const implementationLog = path.join(directory, "implement.events.jsonl");
  result = await runPi({ config }, directory, "implement", `CURRENT_IMPLEMENTATION\n${padding}`, implementationLog,
    1, null, [], { maxTokens: 60000, approvedFiles: ["source.py"],
      budget: { mode: "adaptive", complexity: "small" }, resumeSession: { file: feedbackSession,
        hash: createHash("sha256").update(feedbackContent).digest("hex") },
      authoritativeContext: { contract: protectedContract, currentState: "approved" } });
  assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 2\n");
  assert.equal(payloads.length, 8);
  assert.equal(JSON.stringify(payloads[0].messages).match(/FROZEN_ACCEPTANCE/g).length, 1, "first request carries the full contract once");
  assert.equal(JSON.stringify(payloads[0].messages).match(/EXACT_MULTILINE_DESIGN/g).length, 1, "escaped multiline fields also enter context exactly once");
  assert.equal(JSON.stringify(payloads[2].messages).match(/VERIFIED_SOURCE_FACT/g).length, 1, "duplicate reads keep one exact result");
  assert.match(JSON.stringify(payloads[2].messages), /Exact evidence retained in later tool result read-evidence-2/);
  for (const payload of payloads.slice(3, 7)) {
    assert.doesNotMatch(JSON.stringify(payload.messages), /OLD_STAGE_INSTRUCTIONS/);
    assert.match(JSON.stringify(payload.messages), /VERIFIED_SOURCE_FACT/);
    assert.match(JSON.stringify(payload.messages), /FROZEN_ACCEPTANCE/);
  }
  assert.equal(payloads[5].messages.filter(message => JSON.stringify(message.content)
    .includes("LATEST_PLAN_INSTRUCTIONS")).length, 1, "identical resumes retain only the latest instruction");
  assert.doesNotMatch(JSON.stringify(payloads[6].messages), /LATEST_PLAN_INSTRUCTIONS/);
  assert.match(JSON.stringify(payloads[6].messages), /CURRENT_IMPLEMENTATION/);
  assert.match(JSON.stringify(payloads[6].messages), /CHECK_FAILURE_PRESERVED/);
  assert.equal(await fs.readFile(feedbackSession, "utf8"), feedbackContent);
  assert.ok(result.telemetry.requestEstimates.every(row => row.contextBytes < 64000));
  for (const checkpoint of checkpoints) assert.equal(await fs.readFile(checkpoint.file, "utf8"), checkpoint.content);
  const events = (await fs.readFile(implementationLog, "utf8")).trim().split("\n").map(JSON.parse);
  const replacement = events.find(event => event.type === "entry_appended" && event.entry.customType === "reqflow_context_replaced");
  assert.equal(replacement.entry.data.replaced.length, 4);
  assert.ok(replacement.entry.data.replaced.reduce((bytes, row) => bytes + row.bytes, 0) > 132377);
});

test("real Pi acceptance investigation corrects field types without dropping diagnosis or opening tools", { skip: !process.env.REQFLOW_TEST_PI }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-acceptance-schema-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const payloads = [], reasons = ["零值错误", "特殊分支提前返回", "缺少零值回归"];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk; payloads.push(JSON.parse(body));
    const output = payloads.length === 1 ? { rootCause: "错误类型", repair: { steps: "错误类型" }, acceptanceIds: ["AC10"] }
      : { rootCause: reasons, repair: "删除零值特判并补充断言", acceptanceIds: ["AC1"] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0,
      delta: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 50 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = process.env.ACCEPTANCE_SCHEMA_KEY; process.env.ACCEPTANCE_SCHEMA_KEY = "local-fixture";
  t.after(() => { if (previous === undefined) delete process.env.ACCEPTANCE_SCHEMA_KEY; else process.env.ACCEPTANCE_SCHEMA_KEY = previous; });
  const config = { piExecutable: process.env.REQFLOW_TEST_PI, provider: "acceptance-local", model: "local", mode: "local", thinking: "off",
    environment: { pi: ["ACCEPTANCE_SCHEMA_KEY"] }, allowedPaths: ["."], excludedPaths: [], structuredOutput: true,
    maxPiMs: 10000, maxToolCalls: 4, maxEventBytes: 1000000,
    modelUsage: { maxRequests: 2, readOnlyMaxRequests: 2, maxTokens: 24000, maxContextBytes: 64000, maxToolResultBytes: 8000 },
    compatibleProviders: [{ name: "acceptance-local", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "ACCEPTANCE_SCHEMA_KEY",
      models: [{ id: "local", input: ["text"], contextWindow: 65536, maxTokens: 8192, supportsJsonSchema: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }] };
  const log = path.join(directory, "events.jsonl");
  const progress = [];
  const result = await progressContext.run(update => progress.push(update), () => runPi({ config }, directory, "plan", "Investigate the zero case. Return the specified JSON, preserve diagnosis.", log, 1, null, [],
    { maxTokens: 24000, budget: { mode: "adaptive", complexity: "small" }, outputSchema: { name: "acceptance_feedback", strict: true,
      schema: { type: "object", additionalProperties: false, required: ["rootCause", "repair", "acceptanceIds"], properties: {
        acceptanceIds: { type: "array", items: { type: "string", enum: ["AC1"] } },
        rootCause: { type: "array", minItems: 3, items: { type: "string" } }, repair: { type: "string" } } } } }));
  assert.ok(progress.some(update => update.message === "正在只读调查验收反馈与当前代码。"));
  assert.ok(progress.every(update => update.message !== "正在生成研发方案。"));
  assert.deepEqual(JSON.parse(result.text).rootCause, reasons); assert.equal(payloads.length, 2);
  assert.deepEqual(JSON.parse(result.text).acceptanceIds, ["AC1"]);
  assert.equal(payloads[1].tools, undefined);
  const events = (await fs.readFile(log, "utf8")).trim().split("\n").map(row => JSON.parse(row));
  assert.deepEqual(events.filter(event => event.entry?.customType === "reqflow_review_validation").map(event => event.entry.data.status), ["invalid", "valid"]);
});

for (const scenario of ["dependency-research", "plan", "plan-continuity", "plan-workspace-continuity", "plan-settings", "plan-compaction", "plan-compaction-failure", "plan-read-budget", "plan-read-directory", "plan-schema", "plan-schema-unsupported", "plan-reasoning", "plan-truncated", "plan-correction", "plan-local-correction", "plan-diagram-correction", "plan-timeout", "plan-adaptive-context", "plan-adaptive-schema", "plan-context-window", "review-correction", "review-correction-exhausted", "review-strict", "intake-correction", "intake-count-correction", "intake-schema-correction", "intake-quoted-correction", "implement", "adaptive", "short-output", "request-progress", "read-budget-retry", "grep-path-retry", "grep-path-exhausted", "edit-retry", "edit-ambiguous-retry", "edit-limit-retry", "edit-noop-retry", "repair", "repair-adaptive", "repair-failed", "repair-budget", "check-mutation"]) test(`real Pi ${scenario} preserves budget evidence and explicit completion`, {
  skip: !process.env.REQFLOW_TEST_PI,
}, async t => {
  const phase = scenario.startsWith("plan") ? "plan" : scenario.startsWith("review-") ? "review" : scenario.startsWith("intake-") ? "intake" : "implement";
  const compactionScenario = scenario.startsWith("plan-compaction");
  const checkScenario = ["repair", "repair-adaptive", "repair-failed", "repair-budget", "check-mutation"].includes(scenario);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-real-pi-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "evidence.txt"), ["plan-adaptive-context", "plan-adaptive-schema", "plan-context-window"].includes(scenario) ? "Evidence ".repeat(1000) : "Original evidence.\n");
  if (compactionScenario) await fs.writeFile(path.join(directory, "evidence.txt"), "Compaction source evidence. ".repeat(800));
  if (scenario === "read-budget-retry") await fs.writeFile(path.join(directory, "evidence.txt"), "Oversized evidence ".repeat(300));
  if (scenario === "plan-read-budget") await fs.writeFile(path.join(directory, "evidence.txt"), "Verified first line.\n" + "Additional source line.\n".repeat(100));
  await fs.writeFile(path.join(directory, "source.py"), scenario === "edit-ambiguous-retry" ? "value = 1\nvalue = 1\n" : "value = 1\n");
  const payloads = [];
  const contract = { objective: "Update value", acceptance: [{ id: "AC1", text: "Value updated" }] };
  const analysis = { schemaVersion: 1, inputHash: "discussion-hash", status: "needs_clarification",
    reply: "请确认允许哪些用户使用新增功能。", summary: "新增功能保留现有使用方式。", suggestions: [],
    questions: [{ id: "Q1", text: "哪些用户可以使用新增功能？" }], requiredRoles: ["backend", "qa"], contract: null };
  if (scenario === "intake-quoted-correction") analysis.reply = '保留原有"已选数量"文字，在下方完整显示名称列表。';
  if (scenario === "intake-count-correction") Object.assign(analysis, { status: "ready", questions: [], reply: "使用范围已经核对。",
    contract: { ...contract, currentBehavior: "当前值保持不变", desiredBehavior: "更新为已确认的值",
      inScope: ["更新值"], outOfScope: ["其他功能"], answers: {} } });
  const draft = { schemaVersion: 1, contractHash: createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
    affectedFiles: ["source.py"], changes: [{ file: "source.py", description: "Update value" }], domains: ["backend"],
    impacts: Object.fromEntries(["existingBehavior", "interfaces", "data"].map(key => [key, { status: "none", evidence: "Local isolated value" }])),
    verification: [{ acceptanceId: "AC1", scenario: "Check value", regression: "Existing tests" }], openQuestions: [],
    validation: { checks: [], skipped: [], manualReason: "调用当前函数并核对验收结果", startup: [] },
    boundaries: { modules: [{ name: "value", files: ["source.py"], evidence: "Source evidence" }],
      deliveryUnits: [{ name: "app", evidence: "One app" }], designStages: 1, estimatedChangedLines: 1,
      coordination: { status: "none", evidence: "Local" }, verification: { status: "ready", evidence: "Configured checks" },
      recovery: { status: "code_only", evidence: "Snapshots" }, externalEffects: { status: "none", evidence: "Local" }, exclusions: [] } };
  if (scenario === "plan-diagram-correction") {
    draft.schemaVersion = 2;
    draft.design = { approach: "复用现有实现", frontend: "", backend: "修改现有值", data: "无持久化变更", interfaces: [],
      components: [{ file: "source.py", domain: "backend", location: "value", pseudocode: "" }],
      diagrams: [{ title: "值修改", kind: "flow", domain: "backend", source: "flowchart TD\nA --> B" }] };
  }
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (scenario === "plan-settings") assert.equal(request.headers.authorization, "Bearer encrypted-only-key");
    payloads.push(JSON.parse(text));
    if (scenario === "plan-timeout") {
      response.writeHead(200, { "Content-Type": "text/event-stream" }); response.flushHeaders(); return;
    }
    const first = payloads.length === 1;
    const editing = phase === "implement" && (scenario.startsWith("grep-path") ? payloads.length === (scenario === "grep-path-exhausted" ? 4 : 3) : payloads.length <= 2 || (checkScenario && payloads.length === 4));
    const summarizing = compactionScenario && payloads.length === 2;
    if (summarizing && scenario.endsWith("failure")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Injected summarization rejection", type: "invalid_request_error" } }));
      return;
    }
    const delta = scenario === "plan-read-directory" && payloads.length <= 2
      ? { role: "assistant", tool_calls: [{ index: 0, id: `directory-read-${payloads.length}`, type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: first ? "." : "evidence.txt", limit: 1 }) } }] }
      : phase === "review"
      ? { role: "assistant", content: first || scenario !== "review-correction" ? "The plan's review has a blocking issue."
        : JSON.stringify({ findings: [{ severity: "blocking", subject: "Unsafe write", evidence: "Verified source", recommendation: "Correct the write boundary" }] }) }
      : scenario === "plan-workspace-continuity" && payloads.length >= 3
      ? payloads.length === 3 ? { role: "assistant", tool_calls: [{ index: 0, id: "read-current-workspace", type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "source.py", limit: 1 }) } }] }
      : payloads.length === 4 ? { role: "assistant", content: "REQFLOW_EDITS_COMPLETE", tool_calls: [{ index: 0,
        id: "edit-current-workspace", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: "source.py",
          edits: [{ oldText: "value = 41", newText: "value = 42" }] }) } }] }
      : { role: "assistant", content: "Current workspace edited; controller checks required." }
      : summarizing ? { role: "assistant", content: "Research confirms evidence.txt; frozen requirement remains unchanged." }
      : checkScenario && [3, 5].includes(payloads.length) ? { role: "assistant", tool_calls: [{ index: 0,
        id: `checks-${payloads.length}`, type: "function", function: { name: "run_checks", arguments: "{}" } }] }
      : scenario.startsWith("grep-path") && payloads.length <= (scenario === "grep-path-exhausted" ? 3 : 2)
      ? { role: "assistant", tool_calls: [{ index: 0, id: `grep-${payloads.length}`, type: "function", function: {
        name: "grep", arguments: JSON.stringify({ path: first || scenario === "grep-path-exhausted" ? "missing.py" : "source.py", pattern: "value", context: 0 }) } }] }
      : ["read-budget-retry", "dependency-research"].includes(scenario) && first ? { role: "assistant", tool_calls: [{ index: 0,
      id: "read-oversized", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "evidence.txt", limit: 1 }) } }] }
      : editing ? { role: "assistant", content: first ? "First partial edit." : "REQFLOW_EDITS_COMPLETE",
      tool_calls: [{ index: 0, id: `edit-${payloads.length}`, type: "function", function: { name: "edit",
        arguments: JSON.stringify({ path: "source.py", edits: [{ oldText: scenario === "edit-ambiguous-retry"
          ? first ? "value = 1" : "value = 1\nvalue = 1"
          : scenario === "edit-retry" && first ? "not the original source" : `value = ${["dependency-research", "edit-retry", "edit-limit-retry", "edit-noop-retry", "read-budget-retry", "grep-path-retry", "grep-path-exhausted"].includes(scenario) ? 1 : payloads.length === 4 ? 3 : payloads.length}`,
          newText: scenario === "edit-noop-retry" && first ? "value = 1"
            : scenario === "edit-limit-retry" && first ? "oversized\n".repeat(51)
             : `value = ${scenario.startsWith("grep-path") ? 3 : payloads.length === 4 ? 4 : payloads.length + 1}` }] }) } }] }
      : phase === "implement" ? { role: "assistant", content: "External verification pending." }
      : phase === "intake" ? { role: "assistant", content: JSON.stringify({ ...analysis,
        ...(scenario === "intake-schema-correction" && first ? { name: "requirement_intake" } : {}),
        contract: scenario === "intake-count-correction" && first ? { ...analysis.contract,
          acceptance: Array.from({ length: 9 }, (_, index) => ({ id: `AC${index + 1}`, text: `Complete user outcome ${index + 1}` })) } : analysis.contract,
        reply: first && scenario === "intake-correction" ? "Implement `source.py` to add the feature." : analysis.reply }) }
      : first || (scenario === "plan-read-budget" && payloads.length === 2) || (scenario === "plan-local-correction" && payloads.length === 3) ? { role: "assistant", tool_calls: [{ index: 0, id: `read-${payloads.length}`, type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "evidence.txt", ...(scenario === "plan-read-budget" && !first ? { limit: 1 } : {}) }) } }] }
      : { role: "assistant", content: scenario === "plan-local-correction"
        ? JSON.stringify(payloads.length === 2 ? [] : Object.fromEntries(["affectedFiles", "changes", "domains", "impacts", "verification", "validation", "openQuestions", "boundaries", "design"].map(key => [key, null])))
        : scenario === "plan-diagram-correction"
        ? JSON.stringify({ ...draft, design: { ...draft.design, diagrams: [{ ...draft.design.diagrams[0],
          source: payloads.length === 2 ? "A --> B" : "flowchart TD\nA --> B" }] } }) : scenario === "plan-correction"
        ? JSON.stringify({ ...draft, boundaries: { ...draft.boundaries, modules: payloads.length === 2 ? [] : draft.boundaries.modules } })
        : '{"verified":true}' };
    if (scenario === "intake-quoted-correction" && first) delta.content = delta.content.replaceAll('\\"', '"');
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (phase === "intake") response.write(`data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { reasoning_content: "PRIVATE_REASONING_DO_NOT_DISPLAY" }, finish_reason: null }] })}\n\n`);
    if (scenario === "request-progress") for (let i = 0; i < 8000; i++) response.write(`data: ${JSON.stringify({
      id: "local-fixture", object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { reasoning_content: "x" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : scenario === "plan-truncated" ? "length" : "stop" }],
      usage: { prompt_tokens: compactionScenario && first ? 30000 : scenario === "request-progress" ? 3000 : first ? 200 : 230, completion_tokens: 10,
        total_tokens: compactionScenario && first ? 30010 : first ? 210 : 240 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = { key: process.env.SMOKE_MODEL_KEY, home: process.env.PI_CODING_AGENT_DIR,
    check: process.env.CHECK_FIXTURE_VALUE };
  process.env.SMOKE_MODEL_KEY = "local-fixture";
  process.env.PI_CODING_AGENT_DIR = path.join(directory, "home");
  process.env.CHECK_FIXTURE_VALUE = "check-only";
  if (compactionScenario) {
    await fs.mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
      JSON.stringify({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 } }));
  }
  t.after(() => {
    for (const [name, value] of [["SMOKE_MODEL_KEY", previous.key], ["PI_CODING_AGENT_DIR", previous.home],
      ["CHECK_FIXTURE_VALUE", previous.check]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const config = { piExecutable: process.env.REQFLOW_TEST_PI, provider: "local-fixture", model: "local",
    mode: "local", thinking: scenario === "plan-reasoning" ? "low" : "off", structuredOutput: phase !== "implement",
    environment: { pi: ["SMOKE_MODEL_KEY", "PI_CODING_AGENT_DIR"] }, allowedPaths: ["."], excludedPaths: [],
    maxPiMs: 10000, maxToolCalls: 4, maxEventBytes: 1000000,
    modelUsage: { maxRequests: scenario.startsWith("grep-path") ? 4 : scenario === "request-progress" ? 1 : checkScenario && !["repair-budget", "repair-adaptive"].includes(scenario) ? 5 : 3, readOnlyMaxRequests: compactionScenario || scenario === "plan-read-budget" ? 3 : 2, maxTokens: compactionScenario ? 64000 : 24000,
      ...(compactionScenario ? { maxToolResultBytes: 32000 } : {}),
      ...(["plan-adaptive-context", "plan-adaptive-schema", "plan-context-window"].includes(scenario) ? { maxContextBytes: 10000, maxToolResultBytes: 16000 } : {}),
      ...(["read-budget-retry", "plan-read-budget"].includes(scenario) ? { maxToolResultBytes: 512 } : {}) },
    compatibleProviders: [{ name: "local-fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKeyEnv: "SMOKE_MODEL_KEY", thinkingToggle: scenario === "plan-reasoning",
       models: [{ id: "local", input: ["text"], contextWindow: scenario === "plan-context-window" ? 4000 : 32000, maxTokens: scenario === "short-output" ? 256 : scenario === "plan-reasoning" ? 8192 : 2000,
         reasoning: scenario === "plan-reasoning", supportsReasoningEffort: scenario === "plan-reasoning",
         supportsJsonSchema: scenario === "plan-schema" }] }] };
  if (checkScenario) {
    config.environment.checks = ["CHECK_FIXTURE_VALUE"];
    config.maxSnapshotBytes = 1000000;
    config.excludedPaths = ["home", "events.jsonl", "events.jsonl.session.jsonl", "events.jsonl.pi-home",
      ...Array.from({ length: 2 }, (_, i) => `events.jsonl.internal-development-${i + 1}-1.log`)];
    config.checks = [[process.execPath, "-e", scenario === "check-mutation"
      ? 'require("fs").writeFileSync("source.py", "value = 99\\n")'
      : `if(process.env.CHECK_FIXTURE_VALUE!=="check-only"||process.env.SMOKE_MODEL_KEY) throw new Error("Invalid check environment"); const text=require("fs").readFileSync("source.py","utf8"); if(text!=="value = ${scenario === "repair-failed" ? 5 : 4}\\n") { console.error("Expected verified value, got: "+text); process.exit(1); }`]];
  }
  if (scenario === "plan-settings") {
    config.compatibleProviders[0].credentialId = await saveModelCredential(directory, "encrypted-only-key");
    config.agentModels = { development: { provider: "local-fixture", model: "local", modelParameters: { temperature: 0.3, topP: 0.8, maxOutputTokens: 512 },
      modelUsage: { maxRequests: 2 }, maxPiMs: 5000 } };
  }
  const logFile = path.join(directory, "events.jsonl");
  let localCorrection;
  if (scenario === "plan-local-correction") {
    draft.schemaVersion = 2;
    draft.design = { approach: "Reuse existing code", frontend: "", backend: "Update the value", data: "No persisted changes", interfaces: [],
      components: [{ file: "source.py", domain: "backend", location: "value", pseudocode: "" }], diagrams: [] };
    const draftFile = path.join(directory, "tasks", "REQ-1", "draft.json");
    await fs.mkdir(path.dirname(draftFile), { recursive: true });
    await fs.writeFile(draftFile, JSON.stringify(draft));
    config.modelUsage.maxRequests = 4;
    config.modelUsage.readOnlyMaxRequests = 4;
    localCorrection = { maxTokens: 24000, planContract: contract, discussionTask: "REQ-1",
      planCorrection: { draftFile, draftHash: createHash("sha256").update(JSON.stringify(draft)).digest("hex") },
      budget: { mode: "adaptive", complexity: "small", maxRepairAttempts: 2 },
      outputSchema: { name: "local_correction", strict: true, schema: { type: "object", additionalProperties: false,
        required: ["affectedFiles", "changes", "domains", "impacts", "verification", "validation", "openQuestions", "boundaries", "design"],
        properties: Object.fromEntries(["affectedFiles", "changes", "domains", "impacts", "verification", "validation", "openQuestions", "boundaries", "design"].map(key => [key, { type: "null" }])) } } };
  }
  if (scenario === "plan-timeout") config.maxPiMs = 1000;
  const progress = [];
  const run = progressContext.run(update => progress.push(update), () => runPi({ config, archive: ["plan-settings", "plan-local-correction"].includes(scenario) ? directory : undefined }, directory, phase,
    "Read evidence.txt then return JSON with verified=true.", logFile, 1,
    phase === "review" ? "all" : null, [], localCorrection ?? (["plan-continuity", "plan-workspace-continuity"].includes(scenario) ? { developerSession: true, maxTokens: 24000,
      authoritativeContext: { contract, currentState: "contract_confirmed" } } : scenario.startsWith("plan-schema") ? { maxTokens: 24000, outputSchema: { name: "verified_result", strict: true,
      schema: { type: "object", additionalProperties: false, required: ["verified"], properties: { verified: { type: "boolean" } } } } }
      : compactionScenario ? { maxTokens: 64000,
        authoritativeContext: { contract, state: "EXACT_REQ_STATE_01" } }
      : ["plan-correction", "plan-diagram-correction"].includes(scenario) ? { maxTokens: 24000, planContract: contract,
      budget: { mode: "adaptive", complexity: "small", maxRepairAttempts: 2 } }
      : ["plan-adaptive-context", "plan-adaptive-schema", "plan-context-window", "plan-read-directory"].includes(scenario) ? { maxTokens: 24000,
        budget: { mode: "adaptive", complexity: "planning", maxRepairAttempts: 2 },
        ...(scenario === "plan-adaptive-schema" ? { outputSchema: { name: "verified_result", strict: true,
          schema: { type: "object", additionalProperties: false, required: ["verified"], properties: { verified: { type: "boolean" } } } } } : {}) }
      : phase === "review" ? { maxTokens: 24000,
        budget: { mode: scenario === "review-strict" ? "strict" : "adaptive", complexity: "small", maxRepairAttempts: 2 },
        outputSchema: { name: "review_findings", strict: true, schema: {
          type: "object", additionalProperties: false, required: ["findings"],
          properties: { findings: { type: "array", items: { type: "object", additionalProperties: false,
            required: ["severity", "subject", "evidence", "recommendation"],
            properties: Object.fromEntries(["severity", "subject", "evidence", "recommendation"].map(key => [key, { type: "string" }])) } } }
        } } }
      : phase === "intake" ? { maxTokens: 24000,
        intakeValidation: { inputHash: "discussion-hash", sourceFiles: ["source.py"] },
        outputSchema: { name: "requirement_intake", strict: true, schema: { type: "object", additionalProperties: false,
          required: Object.keys(analysis), properties: Object.fromEntries(Object.entries(analysis).map(([key, value]) => [key,
            key === "contract" ? { anyOf: [{ type: "object" }, { type: "null" }] }
              : { type: Array.isArray(value) ? "array" : typeof value === "number" ? "integer" : "string" }])) } },
        budget: { mode: "adaptive", complexity: "small", maxRepairAttempts: 2 } } : phase === "implement" ? { maxTokens: scenario === "adaptive" ? 100 : 24000,
      ...(["adaptive", "short-output", "request-progress"].includes(scenario) ? { budget: { mode: "adaptive", complexity: "small", maxRepairAttempts: 2 } } : {}),
      ...(scenario === "repair-adaptive" ? { budget: { mode: "adaptive", complexity: "standard", maxRepairAttempts: 3 } } : {}),
      ...(scenario === "read-budget-retry" || scenario.startsWith("grep-path") ? {} : { approvedFiles: ["source.py"] }) } : null)));
  if (phase === "review") {
    if (scenario === "review-correction") {
      const result = await run;
      assert.equal(JSON.parse(result.text).findings[0].severity, "blocking");
      assert.equal(payloads.length, 2);
    } else {
      await assert.rejects(run, /not valid JSON/);
      assert.equal(payloads.length, scenario === "review-strict" ? 1 : 3);
    }
    assert.ok(payloads.slice(1).every(payload => payload.tools === undefined), "correction cannot perform new research");
    const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const validation = events.filter(event => event.entry?.customType === "reqflow_review_validation");
    assert.equal(validation[0].entry.data.status, "invalid", "malformed output remains explicit audit evidence");
    assert.equal(validation.at(-1).entry.data.status, scenario === "review-correction" ? "valid" : "invalid");
    return;
  }
  if (scenario === "plan-read-directory") {
    const result = await run;
    assert.equal(payloads.length, 3);
    assert.match(JSON.stringify(payloads[1].messages), /Use ls/);
    assert.match(JSON.stringify(payloads[2].messages), /Original evidence/);
    assert.equal(JSON.parse(result.text).verified, true);
    assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 1\n");
    return;
  }
  if (["plan-continuity", "plan-workspace-continuity"].includes(scenario)) {
    const planned = await run;
    assert.equal(planned.telemetry.agent, "development");
    assert.equal(planned.telemetry.sessionStatus, "saved");
    assert.ok(payloads[0].tools.every(tool => !["edit", "write"].includes(tool.function.name)));
    assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 1\n");
    if (scenario === "plan-workspace-continuity") {
      const workspace = path.join(directory, "implementation");
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, "source.py"), "value = 41\n");
      const originalSession = await fs.readFile(planned.telemetry.sessionCheckpoint.file);
      const continued = await runPi({ config: { ...config, maxSnapshotBytes: 1000000,
        environment: { ...config.environment, checks: [] },
        checks: [[process.execPath, "-e", 'require("node:assert/strict").equal(require("node:fs").readFileSync("source.py","utf8"),"value = 42\\n")']] } },
      workspace, "implement", "Approved implementation in a different isolated workspace.", path.join(directory, "continued.jsonl"),
      1, null, [], { maxTokens: 24000, approvedFiles: ["source.py"],
        resumeSession: planned.telemetry.sessionCheckpoint, authoritativeContext: { contract, currentState: "approved" } });
      assert.equal(payloads.length, 5);
      assert.match(JSON.stringify(payloads[3].messages), /value = 41/);
      assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 1\n");
      assert.equal(await fs.readFile(path.join(workspace, "source.py"), "utf8"), "value = 42\n");
      assert.deepEqual(await fs.readFile(planned.telemetry.sessionCheckpoint.file), originalSession);
      const header = JSON.parse((await fs.readFile(continued.telemetry.sessionCheckpoint.file, "utf8")).split("\n")[0]);
      assert.equal(header.cwd, await fs.realpath(workspace));
      assert.equal(header.parentSession, planned.telemetry.sessionCheckpoint.file);
      assert.equal(Object.hasOwn(continued.telemetry, "internalChecks"), false, "controller verification remains outside native Pi");
      return;
    }
    const continued = await runPi({ config }, directory, "implement", "Approved implementation; retain verified evidence.",
      path.join(directory, "continued.jsonl"), 1, null, [], { maxTokens: 24000,
        approvedFiles: ["source.py"], resumeSession: planned.telemetry.sessionCheckpoint,
        authoritativeContext: { contract, currentState: "approved", approvedFiles: ["source.py"] } });
    assert.equal(continued.telemetry.agent, "development");
    assert.equal(payloads.length, 3);
    assert.ok(payloads[2].tools.some(tool => tool.function.name === "edit"));
    assert.match(JSON.stringify(payloads[2].messages), /Original evidence/);
    assert.match(JSON.stringify(payloads[2].messages), /CURRENT workspace/);
    assert.notEqual(continued.telemetry.sessionCheckpoint.file, planned.telemetry.sessionCheckpoint.file);
    return;
  }
  if (scenario === "plan-local-correction") {
    const result = await run;
    assert.equal(payloads.length, 4);
    assert.ok(payloads[2].tools.some(tool => tool.function.name === "read_plan"), "local correction must retain exact archived evidence tools after invalid JSON");
    assert.ok(payloads[3].tools.some(tool => tool.function.name === "read_plan"), "adaptive correction keeps exact evidence available beyond its target");
    assert.deepEqual(Object.values(JSON.parse(result.text)), Array(9).fill(null));
    return;
  }
  if (scenario === "plan-context-window") {
    const result = await run;
    assert.equal(JSON.parse(result.text).verified, true);
    assert.equal(result.telemetry.contextExpansions.length, 1, "wire byte estimates are not a second model capacity gate");
    assert.equal(result.telemetry.requestLimit, null);
    return;
  }
  if (scenario === "plan-schema-unsupported") {
    const result = await run;
    assert.deepEqual(JSON.parse(result.text), { verified: true });
    assert.ok(payloads.length > 0);
    assert.ok(payloads.every(payload => payload.response_format.type === "json_object"));
    assert.ok(payloads.every(payload => payload.messages.some(message => typeof message.content === "string"
      && message.content.includes(JSON.stringify({ type: "object", additionalProperties: false,
        required: ["verified"], properties: { verified: { type: "boolean" } } })))));
    return;
  }
  if (scenario === "plan-compaction-failure") {
    await assert.rejects(run, error => {
      assert.match(error.message, /REQFLOW_COMPACTION_STOP/);
      assert.equal(error.telemetry.unmeasuredRequests, 1);
      return true;
    });
    assert.equal(payloads.length, 2, "failed compaction must stop before another normal task request");
    return;
  }
  if (["repair-failed", "check-mutation"].includes(scenario)) {
    if (scenario === "check-mutation") await assert.rejects(run, /checks modified project files/);
    else {
      const result = await run;
      assert.equal(result.telemetry.developmentChecks.at(-1).status, "failed",
        "diagnostic failure remains explicit; controller formal verification decides the current candidate");
    }
    const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const checks = events.filter(event => event.type === "entry_appended" && event.entry.customType === "reqflow_development_check");
    assert.equal(checks.length, scenario === "repair-failed" ? 2 : 1);
    assert.equal(checks.at(-1).entry.data.status, scenario === "check-mutation" ? "error" : "failed");
    assert.equal(payloads.length, scenario === "repair-failed" ? 6 : 3);
    return;
  }
  if (scenario.startsWith("grep-path")) {
      const result = await run;
      assert.equal(payloads.length, scenario === "grep-path-exhausted" ? 5 : 4);
      assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 3\n");
      assert.match(JSON.stringify(payloads[1].messages), /Path not found/);
      assert.match(JSON.stringify(payloads[scenario === "grep-path-exhausted" ? 4 : 2].messages), /value = 1/);
      assert.match(result.text, /External verification pending/);
    const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.filter(row => row.entry?.customType === "reqflow_tool_retry").length, 0);
    return;
  }
  if (scenario === "plan-truncated") {
    await assert.rejects(run, error => {
      assert.match(error.message, /Pi plan output truncated by the model output limit: local-fixture\/local; output=10/);
      assert.equal(error.telemetry.modelAttempts.at(-1).stopReason, "length");
      assert.equal(error.telemetry.tokens.output, 20);
      return true;
    });
    assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 1\n");
    return;
  }
  if (scenario === "plan-timeout") {
    await assert.rejects(run, error => {
      assert.match(error.message, /超过 1 秒执行时限.*1 次模型请求、0 次工具调用/);
      const timing = error.telemetry.requestTimings[0];
      assert.equal(timing.status, "timed_out"); assert.equal(timing.firstTextMs, null);
      assert.ok(timing.durationMs > 0 && timing.durationMs <= error.telemetry.durationMs);
      return true;
    });
    assert.equal(payloads.length, 1); return;
  }
  const result = await run;
  if (phase !== "implement") assert.equal(result.telemetry.requestTimings.length, result.telemetry.requestEstimates.length);
  else assert.equal(result.telemetry.executionMode, "native");
  assert.ok(result.telemetry.requestTimings.every(row => row.status === "completed" && row.durationMs >= 0 && Number.isFinite(row.firstResponseMs)));
  assert.ok(result.telemetry.toolTimings.every(row => ["completed", "failed"].includes(row.status) && row.durationMs >= 0));
  if (scenario === "plan-diagram-correction") {
    assert.equal(payloads.length, 3);
    assert.deepEqual(result.telemetry.planValidation.map(row => row.status), ["invalid", "valid"]);
    assert.match(JSON.stringify(payloads[2].messages), /值修改.*kind=flow.*flowchart TD/);
    assert.deepEqual(JSON.parse(result.text), draft); return;
  }
  if (scenario === "plan-reasoning") {
    assert.equal(payloads.length, 2);
    assert.ok(payloads.every(payload => payload.reasoning_effort === "low" && payload.enable_thinking === true));
    assert.ok(payloads.every(payload => payload.max_tokens === 8192));
  }
  if (phase === "intake") {
    if (scenario === "intake-count-correction") {
      assert.equal(JSON.parse(result.text).contract.acceptance.length, 9);
      assert.equal(payloads.length, 1);
      assert.deepEqual(result.telemetry.intakeValidation.map(row => row.status), ["valid"]);
      return;
    }
    assert.ok(progress.some(row => row.stage === "draft" && row.preview.includes(analysis.reply)));
    assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_REASONING_DO_NOT_DISPLAY|Implement `source.py`/);
    assert.deepEqual(JSON.parse(result.text), analysis);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[1].tools, undefined);
    assert.match(JSON.stringify(payloads[1].messages), /product analysis was rejected/);
    if (scenario === "intake-quoted-correction") assert.match(JSON.stringify(payloads[1].messages), /never truncate string values/);
    assert.deepEqual(result.telemetry.intakeValidation.map(row => row.status), ["invalid", "valid"]);
    assert.equal(result.telemetry.assistantMessages, 2);
    assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 1\n");
    assert.match(await fs.readFile(logFile, "utf8"), scenario === "intake-correction" ? /Implement `source.py`/
      : scenario === "intake-count-correction" ? /acceptance count 9 exceeds configured limit 8/
      : scenario === "intake-quoted-correction" ? /JSON/ : /additionalProperties/);
    const audit = await fs.readFile(logFile, "utf8");
    assert.doesNotMatch(audit, /PRIVATE_REASONING_DO_NOT_DISPLAY/);
    assert.match(audit, /thinking_reference/);
    assert.equal(result.telemetry.auditStorage.omittedThinkingBlocks, 2);
    return;
  }
  if (scenario === "plan-correction") {
    assert.deepEqual(JSON.parse(result.text), draft);
    assert.equal(payloads.length, 3);
    assert.equal(payloads[2].tools, undefined);
    assert.match(JSON.stringify(payloads[2].messages), /controller rejected your JSON/);
    assert.deepEqual(result.telemetry.planValidation.map(row => row.status), ["invalid", "valid"]);
    assert.equal(result.telemetry.assistantMessages, 3);
    assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 1\n");
    return;
  }
  if (["repair", "repair-adaptive", "repair-budget"].includes(scenario)) {
    assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 4\n");
    assert.equal(payloads.length, 6);
    assert.ok(payloads[3].tools.some(tool => tool.function.name === "edit"));
    assert.equal(JSON.parse(payloads[3].messages.findLast(message => message.role === "tool").content).status, "failed");
    assert.match(JSON.stringify(payloads[3].messages), /First partial edit/);
    assert.equal(result.telemetry.requestTimings.length, 6);
    const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const checks = events.filter(event => event.type === "entry_appended" && event.entry.customType === "reqflow_development_check");
    assert.deepEqual(checks.map(event => event.entry.data.status), ["failed", "passed"]);
    assert.ok(checks.every(event => event.entry.data.formalVerificationRequired));
    assert.ok(checks.every(event => event.entry.data.beforeHash === event.entry.data.afterHash));
    assert.equal(result.telemetry.requestLimit, null);
    return;
  }
  if (phase === "implement") {
    if (scenario === "dependency-research") {
      assert.equal(result.telemetry.sourceEvidence.completeFiles.length, 1);
      assert.ok(payloads[0].tools.some(tool => tool.function.name === "read"));
      assert.match(JSON.stringify(payloads[1].messages), /Original evidence/);
      assert.equal(await fs.readFile(path.join(directory, "evidence.txt"), "utf8"), "Original evidence.\n");
    }
    assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 3\n");
    assert.equal(payloads.length, 3);
    assert.ok(payloads[1].tools.some(tool => tool.function.name === "edit"), "First write must not close later edits");
    if (["implement", "adaptive"].includes(scenario)) {
      assert.deepEqual(payloads[0].tools.map(tool => tool.function.name).sort(),
         ["bash", "edit", "find", "grep", "ls", "read", "write"], "Native coding tools remain available");
      const committed = JSON.parse(payloads[1].messages.find(message => message.tool_calls)?.tool_calls[0].function.arguments);
      assert.equal(committed.edits[0].oldText, "value = 1");
      assert.equal(committed.edits[0].newText, "value = 2");
      const original = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
        .find(row => row.type === "tool_execution_start");
      assert.equal(original.args.edits[0].oldText, "value = 1");
    }
    assert.ok(payloads[2].tools.some(tool => tool.function.name === "edit"));
    if (scenario === "read-budget-retry") {
      const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const retries = events.filter(row => row.type === "entry_appended" && row.entry.customType === "reqflow_tool_retry");
      assert.equal(retries.length, 0);
      assert.match(JSON.stringify(payloads[1].messages), /Oversized evidence/);
    }
    assert.equal(result.telemetry.requestTimings.length, 3);
    assert.match(result.text, /External verification pending/);
    if (scenario === "short-output") assert.ok(payloads.slice(0, 2).every(payload => payload.max_tokens === 256));
    if (scenario === "request-progress") {
      assert.equal(result.telemetry.requestLimit, null);
      const audited = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(audited.some(event => event.type === "message_update"), false);
      assert.ok(audited.some(event => event.type === "message_end" && event.message.role === "assistant"));
      assert.ok(result.eventBytes < config.maxEventBytes);
      assert.deepEqual(result.telemetry.requestBudgetExpansions, []);
      const resumed = await runPi({ config: { ...config, modelUsage: { ...config.modelUsage,
        maxRequests: 8, maxContextBytes: 10000 } } }, directory, "implement", "Continue retained edits.",
        path.join(directory, "resumed.events.jsonl"), 1, null, [], { maxTokens: 64000,
          budget: { mode: "adaptive", complexity: "small" }, approvedFiles: ["source.py"],
          resumeSession: result.telemetry.sessionCheckpoint,
          authoritativeContext: { contract, state: "EXACT_RESUMED_STATE" } });
      assert.equal(resumed.telemetry.compactions.length, 0, "do not compact a short resumed session that fits the model context");
      assert.equal(resumed.telemetry.unmeasuredRequests, 0);
      assert.ok(payloads.slice(3).some(payload => JSON.stringify(payload.messages).includes("EXACT_RESUMED_STATE")),
        "the resumed task request retains exact authoritative state between native summaries");
    }
    if (scenario === "adaptive") {
      assert.equal(result.telemetry.tokenLimit, null);
      assert.ok(result.telemetry.tokens.input > 100);
      assert.equal(result.telemetry.budgetExpansions.length, 0);
      assert.equal(result.telemetry.budget.mode, "adaptive");
    }
    if (["edit-retry", "edit-ambiguous-retry", "edit-limit-retry", "edit-noop-retry"].includes(scenario)) {
      const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.type === "entry_appended" && event.entry.customType === "reqflow_tool_retry").length, 0);
      assert.match(JSON.stringify(payloads[1].messages), scenario === "edit-retry" ? /Could not find the exact text/
        : scenario === "edit-ambiguous-retry" ? /Found 2 occurrences.*text must be unique/
        : scenario === "edit-noop-retry" ? /identical content/ : /at most 50 lines/);
    }
    return;
  }
  assert.deepEqual(JSON.parse(result.text), { verified: true });
  if (scenario === "plan-compaction") {
    assert.equal(payloads.length, 3, JSON.stringify({ telemetry: result.telemetry,
      payloads: payloads.map(row => ({ format: row.response_format, summary: JSON.stringify(row.messages).includes("<conversation>") })) }));
    assert.equal(payloads[1].response_format, undefined, "native summary must not receive the task JSON format");
    assert.match(JSON.stringify(payloads[2].messages), /EXACT_REQ_STATE_01/);
    assert.equal(payloads[2].response_format.type, "json_object");
    assert.equal(result.telemetry.compactions.length, 1);
    assert.equal(result.telemetry.assistantMessages, 3);
    assert.equal(result.telemetry.tokens.input, 30460);
    assert.equal(result.telemetry.requestEstimates.at(-1).tokensUsed, 30250);
    return;
  }
  if (scenario === "plan-read-budget") {
    assert.equal(payloads.length, 3);
    assert.match(JSON.stringify(payloads[1].messages), /Result rejected.*narrower source range/);
    assert.match(JSON.stringify(payloads[2].messages), /Verified first line/);
    assert.doesNotMatch(JSON.stringify(payloads[2].messages), /Additional source line/);
    assert.equal(result.telemetry.assistantMessages, 3, "recovery must keep all request usage");
    return;
  }
  if (["plan-adaptive-context", "plan-adaptive-schema"].includes(scenario)) {
    assert.equal(result.telemetry.contextExpansions.length, 1);
    const expansion = result.telemetry.contextExpansions[0];
    assert.equal(expansion.estimationMethod, "measured_prefix");
    assert.ok(expansion.next > expansion.previous);
    assert.ok(expansion.inputReserve + expansion.requestedOutput <= expansion.contextWindow);
    assert.equal(result.telemetry.requestEstimates[1].contextBytes, expansion.next);
  }
  assert.equal(payloads.length, 2);
  if (scenario === "plan-settings") {
    assert.ok(payloads.every(row => row.temperature === 0.3 && row.top_p === 0.8 && row.max_tokens <= 512));
    assert.equal(result.telemetry.requestLimit, 2);
  }
  assert.ok(payloads.every(payload => payload.response_format.type === (scenario === "plan-schema" ? "json_schema" : "json_object") && payload.max_tokens > 0));
  if (scenario === "plan-schema") {
    assert.ok(payloads.every(payload => payload.response_format.json_schema.strict === true));
    assert.deepEqual(payloads[0].response_format.json_schema.schema.required, ["verified"]);
    assert.ok(payloads.every(payload => payload.messages.some(message => typeof message.content === "string"
      && message.content.includes('"required":["verified"]') && message.content.includes('"additionalProperties":false'))),
      "the active field contract must reach model context even when provider response format is strict");
    assert.ok(payloads[0].tools.some(tool => tool.function.name === "read"), "schema must retain Pi investigation");
  }
  if (["plan-adaptive-context", "plan-adaptive-schema"].includes(scenario)) assert.ok(payloads[1].tools.some(tool => tool.function.name === "read"));
  else assert.equal(payloads[1].tools, undefined);
  assert.deepEqual(result.telemetry.tokens, { input: 430, output: 20, cacheRead: 0, cacheWrite: 0 });
  assert.equal(result.telemetry.requestEstimates.length, 2);
  assert.equal(result.telemetry.requestEstimates[0].estimationMethod, "wire_bytes");
  assert.equal(result.telemetry.requestEstimates[1].tokensUsed, 210);
  const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === "entry_appended" && event.entry.customType === "reqflow_request_budget").length, 2);
});

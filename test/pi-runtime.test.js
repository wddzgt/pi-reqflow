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

for (const scenario of ["dependency-research", "plan", "plan-settings", "plan-compaction", "plan-compaction-failure", "plan-read-budget", "plan-schema", "plan-schema-unsupported", "plan-reasoning", "plan-truncated", "plan-correction", "plan-diagram-correction", "plan-timeout", "plan-adaptive-context", "plan-adaptive-schema", "plan-context-window", "intake-correction", "implement", "adaptive", "short-output", "request-progress", "read-budget-retry", "grep-path-retry", "grep-path-exhausted", "edit-retry", "edit-ambiguous-retry", "edit-limit-retry", "edit-noop-retry", "repair", "repair-adaptive", "repair-failed", "repair-budget", "check-mutation"]) test(`real Pi ${scenario} preserves budget evidence and explicit completion`, {
  skip: !process.env.REQFLOW_TEST_PI,
}, async t => {
  const phase = scenario.startsWith("plan") ? "plan" : scenario === "intake-correction" ? "intake" : "implement";
  const compactionScenario = scenario.startsWith("plan-compaction");
  const checkScenario = ["repair", "repair-adaptive", "repair-failed", "repair-budget", "check-mutation"].includes(scenario);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-real-pi-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "evidence.txt"), ["plan-adaptive-context", "plan-adaptive-schema", "plan-context-window"].includes(scenario) ? "Evidence ".repeat(1000) : "Original evidence.\n");
  if (scenario === "read-budget-retry") await fs.writeFile(path.join(directory, "evidence.txt"), "Oversized evidence ".repeat(300));
  if (scenario === "plan-read-budget") await fs.writeFile(path.join(directory, "evidence.txt"), "Verified first line.\n" + "Additional source line.\n".repeat(100));
  await fs.writeFile(path.join(directory, "source.py"), scenario === "edit-ambiguous-retry" ? "value = 1\nvalue = 1\n" : "value = 1\n");
  const payloads = [];
  const contract = { objective: "Update value", acceptance: [{ id: "AC1", text: "Value updated" }] };
  const analysis = { schemaVersion: 1, inputHash: "discussion-hash", status: "needs_clarification",
    reply: "请确认允许哪些用户使用新增功能。", summary: "新增功能保留现有使用方式。", suggestions: [],
    questions: [{ id: "Q1", text: "哪些用户可以使用新增功能？" }], requiredRoles: ["backend", "qa"], contract: null };
  const draft = { schemaVersion: 1, contractHash: createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
    affectedFiles: ["source.py"], changes: [{ file: "source.py", description: "Update value" }], domains: ["backend"],
    impacts: Object.fromEntries(["existingBehavior", "interfaces", "data"].map(key => [key, { status: "none", evidence: "Local isolated value" }])),
    verification: [{ acceptanceId: "AC1", scenario: "Check value", regression: "Existing tests" }], openQuestions: [],
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
    const editing = phase === "implement" && (scenario.startsWith("grep-path") ? payloads.length === 3 : payloads.length <= 2 || (checkScenario && payloads.length === 4));
    const summarizing = compactionScenario && payloads.length === 2;
    if (summarizing && scenario.endsWith("failure")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Injected summarization rejection", type: "invalid_request_error" } }));
      return;
    }
    const delta = summarizing ? { role: "assistant", content: "Research confirms evidence.txt; frozen requirement remains unchanged." }
      : scenario.startsWith("grep-path") && (payloads.length <= 2 || scenario === "grep-path-exhausted")
      ? { role: "assistant", tool_calls: [{ index: 0, id: `grep-${payloads.length}`, type: "function", function: {
        name: "grep", arguments: JSON.stringify({ path: first || scenario === "grep-path-exhausted" ? "missing.py" : "source.py", pattern: "value", context: 0 }) } }] }
      : ["read-budget-retry", "dependency-research"].includes(scenario) && first ? { role: "assistant", tool_calls: [{ index: 0,
      id: "read-oversized", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "evidence.txt", limit: 1 }) } }] }
      : editing ? { role: "assistant", content: first ? "First partial edit." : "REQFLOW_EDITS_COMPLETE",
      tool_calls: [{ index: 0, id: `edit-${payloads.length}`, type: "function", function: { name: "edit",
        arguments: JSON.stringify({ path: "source.py", edits: [{ oldText: scenario === "edit-ambiguous-retry"
          ? first ? "value = 1" : "value = 1\nvalue = 1"
          : scenario === "edit-retry" && first ? "not the original source" : `value = ${["dependency-research", "edit-retry", "edit-limit-retry", "edit-noop-retry", "read-budget-retry", "grep-path-retry"].includes(scenario) ? 1 : payloads.length === 4 ? 3 : payloads.length}`,
          newText: scenario === "edit-noop-retry" && first ? "value = 1"
            : scenario === "edit-limit-retry" && first ? "oversized\n".repeat(51)
            : `value = ${scenario === "grep-path-retry" ? 3 : payloads.length === 4 ? 4 : payloads.length + 1}` }] }) } }] }
      : phase === "implement" ? { role: "assistant", content: "External verification pending." }
      : phase === "intake" ? { role: "assistant", content: JSON.stringify({ ...analysis,
        reply: first ? "Implement `source.py` to add the feature." : analysis.reply }) }
      : first || (scenario === "plan-read-budget" && payloads.length === 2) ? { role: "assistant", tool_calls: [{ index: 0, id: `read-${payloads.length}`, type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "evidence.txt", ...(scenario === "plan-read-budget" && !first ? { limit: 1 } : {}) }) } }] }
      : { role: "assistant", content: scenario === "plan-diagram-correction"
        ? JSON.stringify({ ...draft, design: { ...draft.design, diagrams: [{ ...draft.design.diagrams[0],
          source: payloads.length === 2 ? "A --> B" : "flowchart TD\nA --> B" }] } }) : scenario === "plan-correction"
        ? JSON.stringify({ ...draft, boundaries: { ...draft.boundaries, modules: payloads.length === 2 ? [] : draft.boundaries.modules } })
        : '{"verified":true}' };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (phase === "intake") response.write(`data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { reasoning_content: "PRIVATE_REASONING_DO_NOT_DISPLAY" }, finish_reason: null }] })}\n\n`);
    if (scenario === "request-progress") for (let i = 0; i < 8000; i++) response.write(`data: ${JSON.stringify({
      id: "local-fixture", object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { reasoning_content: "x" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: editing || (phase === "plan" && first) ? "tool_calls" : scenario === "plan-truncated" ? "length" : "stop" }],
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
    config.excludedPaths = ["home", "events.jsonl", ...Array.from({ length: 2 }, (_, i) => `events.jsonl.internal-${i + 1}-1.log`)];
    config.checks = [[process.execPath, "-e", scenario === "check-mutation"
      ? 'require("fs").writeFileSync("source.py", "value = 99\\n")'
      : `if(process.env.CHECK_FIXTURE_VALUE!=="check-only"||process.env.SMOKE_MODEL_KEY) throw new Error("Invalid check environment"); const text=require("fs").readFileSync("source.py","utf8"); if(text!=="value = ${scenario === "repair-failed" ? 5 : 4}\\n") { console.error("Expected verified value, got: "+text); process.exit(1); }`]];
  }
  if (scenario === "plan-settings") {
    config.compatibleProviders[0].credentialId = await saveModelCredential(directory, "encrypted-only-key");
    config.agentModels = { plan: { provider: "local-fixture", model: "local", modelParameters: { temperature: 0.3, topP: 0.8, maxOutputTokens: 512 },
      modelUsage: { maxRequests: 2 }, maxPiMs: 5000 } };
  }
  const logFile = path.join(directory, "events.jsonl");
  if (scenario === "plan-timeout") config.maxPiMs = 1000;
  const progress = [];
  const run = progressContext.run(update => progress.push(update), () => runPi({ config, archive: scenario === "plan-settings" ? directory : undefined }, directory, phase, "Read evidence.txt then return JSON with verified=true.", logFile, 1,
    null, [], scenario.startsWith("plan-schema") ? { maxTokens: 24000, maxMs: 10000, outputSchema: { name: "verified_result", strict: true,
      schema: { type: "object", additionalProperties: false, required: ["verified"], properties: { verified: { type: "boolean" } } } } }
      : compactionScenario ? { maxTokens: 64000, maxMs: 10000,
        authoritativeContext: { contract, state: "EXACT_REQ_STATE_01" } }
      : ["plan-correction", "plan-diagram-correction"].includes(scenario) ? { maxTokens: 24000, maxMs: 10000, planContract: contract,
      budget: { mode: "adaptive", complexity: "small", maxRepairAttempts: 2 } }
      : ["plan-adaptive-context", "plan-adaptive-schema", "plan-context-window"].includes(scenario) ? { maxTokens: 24000, maxMs: 10000,
        budget: { mode: "adaptive", complexity: "planning", maxRepairAttempts: 2 },
        ...(scenario === "plan-adaptive-schema" ? { outputSchema: { name: "verified_result", strict: true,
          schema: { type: "object", additionalProperties: false, required: ["verified"], properties: { verified: { type: "boolean" } } } } } : {}) }
      : phase === "intake" ? { maxTokens: 24000, maxMs: 10000,
        intakeValidation: { inputHash: "discussion-hash", sourceFiles: ["source.py"] },
        budget: { mode: "adaptive", complexity: "small", maxRepairAttempts: 2 } } : phase === "implement" ? { maxTokens: scenario === "adaptive" ? 100 : 24000,
      ...(["adaptive", "short-output", "request-progress"].includes(scenario) ? { budget: { mode: "adaptive", complexity: "small", maxRepairAttempts: 2 } } : {}),
      ...(scenario === "repair-adaptive" ? { budget: { mode: "adaptive", complexity: "standard", maxRepairAttempts: 3 } } : {}),
      maxMs: 10000, ...(scenario === "read-budget-retry" || scenario.startsWith("grep-path") ? {} : { approvedFiles: ["source.py"] }) } : null));
  if (scenario === "plan-context-window") {
    await assert.rejects(run, /request context byte limit exceeded/);
    assert.equal(payloads.length, 1, "oversized input plus output must stop before provider dispatch");
    return;
  }
  if (scenario === "plan-schema-unsupported") {
    const result = await run;
    assert.deepEqual(JSON.parse(result.text), { verified: true });
    assert.ok(payloads.length > 0);
    assert.ok(payloads.every(payload => payload.response_format.type === "json_object"));
    assert.match(JSON.stringify(payloads[0].messages), /schema exactly/);
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
  if (["repair-failed", "repair-budget", "check-mutation"].includes(scenario)) {
    let failure;
    await assert.rejects(run, error => {
      failure = error;
      assert.match(error.message, scenario === "repair-failed" ? /still fail after one local repair/
        : scenario === "repair-budget" ? /(?:model|provider) request limit reached/ : /checks modified project files/);
      return true;
    });
    const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const checks = events.filter(event => event.type === "entry_appended" && event.entry.customType === "reqflow_internal_verification");
    assert.equal(checks.length, scenario === "repair-failed" ? 2 : 1);
    assert.equal(checks.at(-1).entry.data.status, scenario === "check-mutation" ? "error" : "failed");
    assert.equal(payloads.length, scenario === "repair-failed" ? 5 : 3);
    if (scenario === "repair-budget") {
      assert.equal(failure.telemetry.assistantMessages, 3);
      assert.equal(failure.telemetry.requestLimit, 3);
      assert.equal(failure.telemetry.internalChecks.length, 1);
    }
    return;
  }
  if (scenario.startsWith("grep-path")) {
    if (scenario === "grep-path-exhausted") {
      await assert.rejects(run, /REQFLOW_TOOL_STOP: grep failed: Path not found/);
      assert.equal(payloads.length, 3);
      assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 1\n");
    } else {
      const result = await run;
      assert.equal(payloads.length, 4);
      assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 3\n");
      assert.match(JSON.stringify(payloads[1].messages), /Path not found/);
      assert.match(JSON.stringify(payloads[2].messages), /value = 1/);
      assert.match(result.text, /External verification pending/);
    }
    const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.filter(row => row.entry?.customType === "reqflow_tool_retry").length, scenario === "grep-path-exhausted" ? 2 : 1);
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
  assert.equal(result.telemetry.requestTimings.length, result.telemetry.requestEstimates.length);
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
    assert.ok(progress.some(row => row.stage === "draft" && row.preview.includes("请确认允许哪些用户")));
    assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_REASONING_DO_NOT_DISPLAY|Implement `source.py`/);
    assert.deepEqual(JSON.parse(result.text), analysis);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[1].tools, undefined);
    assert.match(JSON.stringify(payloads[1].messages), /product analysis was rejected/);
    assert.deepEqual(result.telemetry.intakeValidation.map(row => row.status), ["invalid", "valid"]);
    assert.equal(result.telemetry.assistantMessages, 2);
    assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 1\n");
    assert.match(await fs.readFile(logFile, "utf8"), /Implement `source.py`/);
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
  if (["repair", "repair-adaptive"].includes(scenario)) {
    assert.equal(await fs.readFile(path.join(directory, "source.py"), "utf8"), "value = 4\n");
    assert.equal(payloads.length, 5);
    assert.ok(payloads[3].tools.some(tool => tool.function.name === "edit"));
    assert.match(JSON.stringify(payloads[3].messages), /Configured checks failed/);
    assert.match(JSON.stringify(payloads[3].messages), /First partial edit/);
    assert.equal(result.telemetry.requestEstimates.length, 5);
    assert.ok(result.telemetry.requestEstimates[3].tokensUsed > result.telemetry.requestEstimates[2].tokensUsed);
    const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const checks = events.filter(event => event.type === "entry_appended" && event.entry.customType === "reqflow_internal_verification");
    assert.deepEqual(checks.map(event => event.entry.data.status), ["failed", "passed"]);
    assert.ok(checks.every(event => event.entry.data.formalVerificationRequired));
    assert.ok(checks.every(event => event.entry.data.beforeHash === event.entry.data.afterHash));
    if (scenario === "repair-adaptive") assert.equal(result.telemetry.requestLimit, 6);
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
        ["edit", "find", "grep", "ls", "read"], "Complete write targets must not disable dependency investigation");
      const committed = JSON.parse(payloads[1].messages.find(message => message.tool_calls)?.tool_calls[0].function.arguments);
      assert.equal(committed.edits[0].oldText, "value = 1");
      assert.equal(committed.edits[0].newText, "value = 2");
      const original = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
        .find(row => row.type === "tool_execution_start");
      assert.equal(original.args.edits[0].oldText, "value = 1");
    }
    if (scenario !== "read-budget-retry") {
      assert.equal(payloads[2].tools, undefined);
      assert.equal(payloads[2].max_tokens, 128);
      assert.match(payloads[2].messages[0].content, /explicitly declared/);
    } else {
      const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const retries = events.filter(row => row.type === "entry_appended" && row.entry.customType === "reqflow_tool_retry");
      assert.equal(retries.length, 1);
      assert.equal(retries[0].entry.data.toolName, "read");
      assert.match(retries[0].entry.data.reason, /limit is 512/);
      assert.match(JSON.stringify(payloads[1].messages), /Result rejected/);
    }
    assert.equal(result.telemetry.requestEstimates.length, 3);
    assert.match(result.text, /External verification pending/);
    if (scenario === "short-output") assert.ok(payloads.slice(0, 2).every(payload => payload.max_tokens === 256));
    if (scenario === "request-progress") {
      assert.equal(result.telemetry.requestLimit, 1);
      const audited = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(audited.some(event => event.type === "message_update"), false);
      assert.ok(audited.some(event => event.type === "message_end" && event.message.role === "assistant"));
      assert.ok(result.eventBytes < config.maxEventBytes);
      assert.deepEqual(result.telemetry.requestBudgetExpansions.map(row => [row.previous, row.next]), [[1, 2], [2, 3]]);
      assert.notEqual(result.telemetry.requestBudgetExpansions[0].afterHash, result.telemetry.requestBudgetExpansions[1].afterHash);
      const resumed = await runPi({ config: { ...config, modelUsage: { ...config.modelUsage,
        maxRequests: 8, maxContextBytes: 10000 } } }, directory, "implement", "Continue retained edits.",
        path.join(directory, "resumed.events.jsonl"), 1, null, [], { maxTokens: 64000, maxMs: 10000,
          budget: { mode: "adaptive", complexity: "small" }, approvedFiles: ["source.py"],
          resumeSession: result.telemetry.sessionCheckpoint,
          authoritativeContext: { contract, state: "EXACT_RESUMED_STATE" } });
      assert.equal(resumed.telemetry.compactions.length, 1, "compact before continuation; defer unnecessary compaction of a completed answer");
      assert.ok(resumed.telemetry.compactions[0].requests >= 1);
      assert.equal(resumed.telemetry.unmeasuredRequests, 0);
      assert.ok(payloads.slice(3).some(payload => JSON.stringify(payload.messages).includes("EXACT_RESUMED_STATE")),
        "the resumed task request retains exact authoritative state between native summaries");
    }
    if (scenario === "adaptive") {
      assert.equal(result.telemetry.tokenLimit, 100);
      assert.ok(result.telemetry.tokens.input > 100);
      assert.ok(result.telemetry.budgetExpansions.length > 0);
      assert.equal(result.telemetry.budget.mode, "adaptive");
    }
    if (["edit-retry", "edit-ambiguous-retry", "edit-limit-retry", "edit-noop-retry"].includes(scenario)) {
      const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.type === "entry_appended" && event.entry.customType === "reqflow_tool_retry").length, 1);
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
    assert.equal(expansion.estimationMethod, scenario === "plan-adaptive-schema" ? "wire_bytes" : "measured_prefix");
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
    assert.ok(payloads[0].tools.some(tool => tool.function.name === "read"), "schema must retain Pi investigation");
  }
  assert.equal(payloads[1].tools, undefined);
  assert.deepEqual(result.telemetry.tokens, { input: 430, output: 20, cacheRead: 0, cacheWrite: 0 });
  assert.equal(result.telemetry.requestEstimates.length, 2);
  assert.equal(result.telemetry.requestEstimates[0].estimationMethod, "wire_bytes");
  assert.equal(result.telemetry.requestEstimates[1].tokensUsed, 210);
  const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === "entry_appended" && event.entry.customType === "reqflow_request_budget").length, 2);
});

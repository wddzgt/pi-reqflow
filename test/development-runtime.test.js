import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPi } from "../src/pi-runner.js";
import { sha256, manifest, manifestHash } from "../src/files.js";

for (const { editAfterCheck, recheck } of [{ editAfterCheck: false, recheck: true },
  { editAfterCheck: true, recheck: true }, { editAfterCheck: false, recheck: false }]) test(`native Pi repairs failed checks and records snapshot evidence: later edit=${editAfterCheck}, recheck=${recheck}`, {
  skip: !process.env.REQFLOW_TEST_PI,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-development-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "source.py"), "value = 1\n");
  await fs.writeFile(path.join(workspace, "dependency.py"), "expected = 4\n");
  const calls = [
    ["edit", { path: "source.py", edits: [{ oldText: "value = 1", newText: "value = 2" }] }],
    ["run_checks", {}], ["read", { path: "dependency.py" }],
    ["write", { path: "support.py", content: "expected = 4\n" }],
    ["edit", { path: "source.py", edits: [{ oldText: "value = 2", newText: "value = 4" }] }],
    ...(recheck ? [["run_checks", {}]] : []),
    ...(editAfterCheck ? [["edit", { path: "support.py", edits: [{ oldText: "expected = 4", newText: "expected = 5" }] }]] : []),
  ];
  const payloads = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    payloads.push(JSON.parse(text));
    const call = calls[payloads.length - 1];
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `tool-${payloads.length}`,
      type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
      : { role: "assistant", content: "Implementation complete; formal verification remains required." };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = { key: process.env.NATIVE_TEST_KEY, home: process.env.PI_CODING_AGENT_DIR };
  process.env.NATIVE_TEST_KEY = "local-fixture";
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-home");
  t.after(() => {
    for (const [name, value] of [["NATIVE_TEST_KEY", previous.key], ["PI_CODING_AGENT_DIR", previous.home]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const config = { piExecutable: process.env.REQFLOW_TEST_PI, provider: "fixture", model: "local",
    mode: "local", implementationScope: "project", thinking: "off",
    environment: { pi: ["NATIVE_TEST_KEY", "PI_CODING_AGENT_DIR"], checks: [] },
    allowedPaths: ["."], excludedPaths: [], maxPiMs: 15000, maxToolCalls: 12, maxEventBytes: 1000000,
    maxSnapshotBytes: 1000000, modelUsage: { maxRequests: 10, maxTokens: 100000 },
    checks: [[process.execPath, "-e", 'const fs=require("fs"); if(fs.readFileSync("source.py","utf8")!=="value = 4\\n" || !fs.existsSync("support.py")) { console.error("Expected value 4 and support.py; investigate dependency.py");process.exit(1); }']],
    compatibleProviders: [{ name: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKeyEnv: "NATIVE_TEST_KEY", thinkingToggle: false,
      models: [{ id: "local", input: ["text"], contextWindow: 64000, maxTokens: 2000, reasoning: false }] }] };
  const result = await runPi({ config }, workspace, "implement", "Use project checks to verify the required value.",
    path.join(root, "events.jsonl"), 1, null, [], { maxTokens: 100000, maxMs: 15000,
      approvedFiles: ["source.py"], implementationScope: "project" });
  assert.deepEqual(result.telemetry.developmentChecks.map(row => row.status), recheck ? ["failed", "passed"] : ["failed"]);
  assert.equal(Object.hasOwn(result.telemetry, "internalChecks"), false, "formal checks are controlled outside coding");
  const currentHash = manifestHash(await manifest(workspace, [], config.maxSnapshotBytes));
  assert.equal(result.telemetry.developmentChecks.at(-1).afterHash === currentHash, recheck && !editAfterCheck);
  const logNames = await fs.readdir(root);
  assert.equal(logNames.includes("events.jsonl.internal-1-1.log"), false, "coding does not inject another check or repair loop at completion");
  assert.ok(payloads[0].tools.some(tool => tool.function.name === "run_checks"));
  assert.match(JSON.stringify(payloads[2].messages), /Expected value 4/);
  assert.match(JSON.stringify(payloads[3].messages), /expected = 4/);
  assert.equal(await fs.readFile(path.join(workspace, "source.py"), "utf8"), "value = 4\n");
  assert.equal(await fs.readFile(path.join(workspace, "support.py"), "utf8"), `expected = ${editAfterCheck ? 5 : 4}\n`);
  assert.equal(await fs.readFile(path.join(workspace, "dependency.py"), "utf8"), "expected = 4\n");
  assert.equal(result.telemetry.sessionStatus, "saved");
  const checkpoint = result.telemetry.sessionCheckpoint;
  const prior = await fs.readFile(checkpoint.file);
  assert.equal(sha256(prior), checkpoint.hash);
  if (!editAfterCheck && recheck) {
    const before = payloads.length;
    const resumed = await runPi({ config }, workspace, "implement", "Continue the saved work; no new changes requested.",
      path.join(root, "continued.events.jsonl"), 1, null, [], { maxTokens: 100000, maxMs: 15000,
        approvedFiles: ["source.py"], implementationScope: "project", resumeSession: checkpoint });
    assert.equal(resumed.telemetry.sessionStatus, "saved");
    assert.match(JSON.stringify(payloads[before].messages), /expected = 4/);
    assert.equal(sha256(await fs.readFile(checkpoint.file)), checkpoint.hash, "original session evidence remains unchanged");
    await fs.appendFile(checkpoint.file, "\n");
    await assert.rejects(runPi({ config }, workspace, "implement", "Continue", path.join(root, "tampered.events.jsonl"), 1,
      null, [], { maxTokens: 100000, maxMs: 15000, approvedFiles: ["source.py"], resumeSession: checkpoint }), /session changed/);
  }
});

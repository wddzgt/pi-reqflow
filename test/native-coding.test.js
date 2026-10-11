import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { runPi } from "../src/pi-runner.js";

test("native Pi investigates beyond eight rounds, retains large search evidence and runs a real verification command", {
  skip: !process.env.REQFLOW_TEST_PI,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-native-coding-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "source.mjs"), "export const state = 'original';\n");
  await fs.writeFile(path.join(directory, "evidence.txt"), Array.from({ length: 100 }, (_, i) =>
    `MATCH_${i} ${"verified source evidence ".repeat(8)}`).join("\n"));
  const payloads = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    payloads.push(JSON.parse(body));
    const round = payloads.length;
    const call = round === 1 ? { name: "grep", arguments: { path: "evidence.txt", pattern: "MATCH_", limit: 100 } }
      : round <= 9 ? { name: "read", arguments: { path: "source.mjs", limit: 1 } }
      : round === 10 ? { name: "edit", arguments: { path: "source.mjs",
        edits: [{ oldText: "state = 'original'", newText: "state = 'delivered'" }] } }
      : round === 11 ? { name: "bash", arguments: { command:
        "node --input-type=module -e \"import assert from 'node:assert/strict'; import {state} from './source.mjs'; assert.equal(state,'delivered'); console.log('REAL_CHECK_PASSED');\"" } }
      : null;
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `native-${round}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: "Implemented; the isolated command passed. Controller verification remains required." };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0,
      delta, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = process.env.NATIVE_FIXTURE_KEY;
  process.env.NATIVE_FIXTURE_KEY = "local-only";
  t.after(() => { if (previous === undefined) delete process.env.NATIVE_FIXTURE_KEY; else process.env.NATIVE_FIXTURE_KEY = previous; });
  const config = { piExecutable: process.env.REQFLOW_TEST_PI, provider: "local-native", model: "local", mode: "local",
    thinking: "off", environment: { pi: ["NATIVE_FIXTURE_KEY"] }, allowedPaths: ["."], excludedPaths: [],
    modelParameters: {}, maxPiMs: 10000, maxToolCalls: 3, maxEventBytes: 1000000,
    modelUsage: { maxRequests: 8, maxTokens: 1000, maxContextBytes: 1000, maxToolResultBytes: 8000 },
    compatibleProviders: [{ name: "local-native", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKeyEnv: "NATIVE_FIXTURE_KEY", models: [{ id: "local", input: ["text"], contextWindow: 65536, maxTokens: 16384 }] }] };
  const logFile = path.join(directory, "native.events.jsonl");
  const result = await runPi({ config }, directory, "implement", "Implement the approved local state update.", logFile,
    1, null, [], { maxTokens: 1000, maxMs: 20000, approvedFiles: ["source.mjs"],
      implementationScope: "project", authoritativeContext: { contract: { acceptance: [{ id: "AC1", text: "State is delivered" }] } } });
  assert.equal(await fs.readFile(path.join(directory, "source.mjs"), "utf8"), "export const state = 'delivered';\n");
  assert.equal(payloads.length, 12);
  assert.match(JSON.stringify(payloads[0].messages), /expert coding assistant operating inside pi/);
  assert.match(JSON.stringify(payloads[1].messages), /MATCH_99/);
  assert.doesNotMatch(JSON.stringify(payloads[1].messages), /Result rejected/);
  const search = payloads[1].messages.find(row => row.role === "tool" && row.tool_call_id === "native-1");
  assert.ok(Buffer.byteLength(JSON.stringify(search.content)) > 8000);
  assert.ok(payloads.every(payload => payload.tools.some(tool => tool.function.name === "bash")));
  assert.match(JSON.stringify(payloads[11].messages), /REAL_CHECK_PASSED/);
  assert.equal(result.telemetry.executionMode, "native");
  assert.equal(result.telemetry.requestLimit, null);
  assert.equal(result.telemetry.tokenLimit, null);
  assert.equal(result.telemetry.requestTimings.length, 12);
  assert.ok(result.telemetry.requestTimings.every(row => row.usageMeasured && row.status === "completed"));
  assert.equal(result.telemetry.tokens.input, 12000);
  const events = (await fs.readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(row => row.entry?.customType === "reqflow_provider_request").length, 12);
  assert.ok(events.some(row => row.type === "tool_execution_start" && row.toolName === "bash"));
  assert.ok(!events.some(row => row.entry?.customType === "reqflow_tool_retry"));
});

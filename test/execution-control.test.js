import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { controlledExecution, executionStatus, pauseExecution } from "../src/action-progress.js";
import { runCommand } from "../src/commands.js";
import { runPi } from "../src/pi-runner.js";
import { startLocalRuntime, localRuntimeStatus } from "../src/local-runtime.js";

test("pause terminates a slow check and releases the execution slot", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-stop-check-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "started");
  const running = controlledExecution(root, "verify", "dev", () => runCommand([process.execPath, "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],
    root, 30000, path.join(root, "check.log"), 100000, []));
  const rejected = assert.rejects(running, { code: "EXECUTION_PAUSED" });
  const deadline = Date.now() + 5000;
  while (!(await fs.readdir(root)).includes("started") && Date.now() < deadline) await delay(20);
  assert.equal(await fs.readFile(marker, "utf8"), "ready");
  await assert.rejects(controlledExecution(root, "plan", "dev", async () => {}), /仍在执行/);
  assert.throws(() => pauseExecution(root, "other"), /启动人/);
  const started = Date.now(); pauseExecution(root, "dev");
  assert.equal(executionStatus(root).status, "pausing");
  await rejected; assert.ok(Date.now() - started < 3500);
  assert.equal(executionStatus(root), null);
  assert.equal(await controlledExecution(root, "verify", "dev", async () => "ready"), "ready");
});

test("pause aborts local readiness waiting and stops the service", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-stop-startup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const running = controlledExecution(root, "local-validation", "dev", () => startLocalRuntime(root, root, [{ name: "slow",
    command: [process.execPath, "-e", `require('node:http').createServer((q,s)=>s.writeHead(503).end()).listen(${port},'127.0.0.1')`],
    healthUrl: `http://127.0.0.1:${port}`, applicationUrl: null }], root, [], 30000));
  const rejected = assert.rejects(running, { code: "EXECUTION_PAUSED" });
  while (!localRuntimeStatus(root).services.length) await delay(20);
  pauseExecution(root, "dev"); await rejected;
  assert.equal(localRuntimeStatus(root).status, "stopped");
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
});

test("real Pi pause closes the provider connection without another model request", { skip: !process.env.REQFLOW_TEST_PI }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-stop-native-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let requests = 0, closed = false, received;
  const dispatched = new Promise(resolve => { received = resolve; });
  const provider = createServer(async (request, response) => {
    for await (const chunk of request) {} requests++;
    response.writeHead(200, { "Content-Type": "text/event-stream" }); response.flushHeaders();
    response.once("close", () => { closed = true; }); received();
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); return new Promise(resolve => provider.close(resolve)); });
  const prior = process.env.PAUSE_PROVIDER_KEY; process.env.PAUSE_PROVIDER_KEY = "local-fixture";
  t.after(() => { if (prior === undefined) delete process.env.PAUSE_PROVIDER_KEY; else process.env.PAUSE_PROVIDER_KEY = prior; });
  const config = { piExecutable: process.env.REQFLOW_TEST_PI, provider: "local-pause", model: "local", mode: "local",
    thinking: "off", environment: { pi: ["PAUSE_PROVIDER_KEY"] }, allowedPaths: ["."], excludedPaths: [],
    maxPiMs: 30000, maxToolCalls: 20, maxEventBytes: 1000000, maxSnapshotBytes: 1000000,
    compatibleProviders: [{ name: "local-pause", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKeyEnv: "PAUSE_PROVIDER_KEY",
      models: [{ id: "local", input: ["text"], contextWindow: 65536, maxTokens: 16384 }] }] };
  const running = controlledExecution(root, "implement", "dev", () => runPi({ config }, root, "implement", "Read the current project.",
    path.join(root, "events.jsonl"), 1, null, [], { maxTokens: 100000, approvedFiles: ["app.js"] }));
  const rejected = assert.rejects(running, error => error.code === "EXECUTION_PAUSED"
    && error.telemetry.requestTimings.some(request => request.status === "interrupted"));
  await dispatched; pauseExecution(root, "dev"); await rejected;
  await delay(100); assert.equal(requests, 1); assert.equal(closed, true); assert.equal(executionStatus(root), null);
});

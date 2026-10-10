import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deployConfigured, pollConfiguredDeployment, registerDeploymentAdapter, verifyTestEnvironment, waitForJenkins } from "../src/deploy.js";
import { validateConfig } from "../src/config.js";
import { validateDeploymentOptions } from "../src/deployment-adapters.js";

async function serverFixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const config = { kind: "jenkins", baseUrl: `http://127.0.0.1:${server.address().port}/`,
    jobPath: "job/demo", userEnv: "REQFLOW_TEST_JENKINS_USER", tokenEnv: "REQFLOW_TEST_JENKINS_TOKEN", timeoutMs: 150 };
  process.env[config.userEnv] = "test-user";
  process.env[config.tokenEnv] = "test-token";
  t.after(() => { delete process.env[config.userEnv]; delete process.env[config.tokenEnv]; });
  return config;
}

async function adapterFixture(t, name, implementation) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-adapter-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  registerDeploymentAdapter(name, { version: "1", requiresPublishedRevision: false,
    validateOptions(options) { if (options.project !== "demo") throw new Error("Invalid provider project"); }, ...implementation });
  const config = { kind: name, adapterVersion: "1", options: { project: "demo" }, credentialsEnv: [], timeoutMs: 200 };
  const task = { id: "REQ-001", workspace, planHash: "a".repeat(64), contractHash: "b".repeat(64) };
  const limits = { environment: "test", sourceHash: "c".repeat(64), timeoutMs: 200, maxBytes: 10000 };
  return { config, task, limits, logFile: path.join(workspace, "deployment.log") };
}

test("deployment adapters validate configuration and keep credentials outside child environments", async t => {
  const { config } = await adapterFixture(t, "policy-ci", { async submit() {} });
  const sample = JSON.parse(await fs.readFile(new URL("../examples/config.local.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateConfig({ ...sample, testDeployment: config }));
  assert.throws(() => validateConfig({ ...sample, testDeployment: { ...config, adapterVersion: "2" } }), /version differs/);
  assert.throws(() => validateConfig({ ...sample, testDeployment: { ...config, options: { project: "unknown" } } }), /Invalid provider project/);
  assert.throws(() => validateConfig({ ...sample, testDeployment: { ...config, typo: true } }), /Unknown config.testDeployment/);
  assert.throws(() => validateConfig({ ...sample, testDeployment: { ...config, credentialsEnv: ["COMPANY_TOKEN"] },
    environment: { ...sample.environment, pi: ["COMPANY_TOKEN"] } }), /adapter credentials/);
  assert.throws(() => registerDeploymentAdapter("policy-ci", {}), /already registered/);
  assert.throws(() => registerDeploymentAdapter("local", {}), /reserved/);
  registerDeploymentAdapter("revision-ci", { version: "1", requiresPublishedRevision: true,
    validateOptions() {}, async submit() {} });
  assert.throws(() => validateConfig({ ...sample, testDeployment: { ...config, kind: "revision-ci" } }), /requires Git mode/);
  registerDeploymentAdapter("invalid-validator", { version: "1", requiresPublishedRevision: false,
    validateOptions() { return false; }, async submit() {} });
  assert.throws(() => validateDeploymentOptions({ ...config, kind: "invalid-validator" }), /return nothing/);
});

test("custom asynchronous deployment polls its original operation and logs no credential values", async t => {
  let submissions = 0;
  let queries = 0;
  process.env.REQFLOW_ADAPTER_TEST_SECRET = "adapter-private-secret";
  t.after(() => { delete process.env.REQFLOW_ADAPTER_TEST_SECRET; });
  const { config, task, limits, logFile } = await adapterFixture(t, "async-ci", {
    async submit({ request, credentials, signal }) {
      submissions++;
      assert.equal(credentials.REQFLOW_ADAPTER_TEST_SECRET, "adapter-private-secret");
      assert.equal(signal.aborted, false);
      assert.match(request.operationKey, /^[a-f0-9]{64}$/);
      return { status: "running", operationId: "job-7", revision: request.revision, evidence: "Accepted by company CI" };
    },
    async poll({ request }, previous) {
      queries++;
      assert.equal(previous.operationId, "job-7");
      return { status: "succeeded", operationId: previous.operationId, revision: request.revision,
        evidence: "Remote deployment succeeded", url: "https://preview.example.com/req-001" };
    },
  });
  config.credentialsEnv = ["REQFLOW_ADAPTER_TEST_SECRET"];
  const receipt = await deployConfigured(config, task, logFile, limits);
  const result = await pollConfiguredDeployment(config, task, receipt, logFile, limits);
  assert.equal(result.status, "succeeded");
  assert.equal(result.url, "https://preview.example.com/req-001");
  assert.equal(submissions, 1); assert.equal(queries, 1);
  const log = await fs.readFile(logFile, "utf8");
  assert.doesNotMatch(log, /adapter-private-secret/);
  assert.deepEqual(log.trim().split("\n").map(line => JSON.parse(line).action), ["submit", "poll"]);
  await assert.rejects(pollConfiguredDeployment(config, task, receipt, logFile,
    { ...limits, sourceHash: "d".repeat(64) }), /receipt differs/);
  assert.equal(queries, 1);
});

test("custom deployment rejects wrong revisions and preserves explicit remote failure", async t => {
  const invalid = await adapterFixture(t, "wrong-revision-ci", {
    async submit() { return { status: "succeeded", operationId: "1", revision: "wrong", evidence: "success" }; },
  });
  await assert.rejects(deployConfigured(invalid.config, invalid.task, invalid.logFile, invalid.limits), /exact revision/);
  const failed = await adapterFixture(t, "failed-ci", {
    async submit({ request }) { return { status: "failed", operationId: "2", revision: request.revision, evidence: "CI rejected deployment" }; },
  });
  assert.equal((await deployConfigured(failed.config, failed.task, failed.logFile, failed.limits)).status, "failed");
  const missingPoll = await adapterFixture(t, "no-poll-ci", {
    async submit({ request }) { return { status: "running", operationId: "3", revision: request.revision, evidence: "queued" }; },
  });
  await assert.rejects(deployConfigured(missingPoll.config, missingPoll.task, missingPoll.logFile, missingPoll.limits), /Invalid deployment receipt/);
});

test("adapter timeout aborts the operation; polling retry never submits another deployment", async t => {
  let submissions = 0;
  let queries = 0;
  let aborted = false;
  const setup = await adapterFixture(t, "timeout-ci", {
    async submit({ request }) {
      submissions++;
      return { status: "running", operationId: "original-job", revision: request.revision, evidence: "queued" };
    },
    async poll({ request, signal }, previous) {
      queries++;
      if (queries === 1) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        aborted = true; reject(signal.reason);
      }, { once: true }));
      return { status: "succeeded", operationId: previous.operationId, revision: request.revision, evidence: "completed" };
    },
  });
  const receipt = await deployConfigured(setup.config, setup.task, setup.logFile, setup.limits);
  await assert.rejects(pollConfiguredDeployment(setup.config, setup.task, receipt, setup.logFile,
    { ...setup.limits, timeoutMs: 40 }), /timed out/);
  assert.equal(aborted, true);
  const result = await pollConfiguredDeployment(setup.config, setup.task, receipt, setup.logFile, setup.limits);
  assert.equal(result.status, "succeeded"); assert.equal(submissions, 1); assert.equal(queries, 2);
});

test("company gateway example sends a published revision and idempotency key to the real HTTP interface", async t => {
  await import("../examples/deployment/company-ci.mjs");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-company-gateway-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  process.env.COMPANY_DEPLOY_TOKEN = "fixture-company-token";
  t.after(() => { delete process.env.COMPANY_DEPLOY_TOKEN; });
  let submits = 0;
  let deployedRevision;
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-company-token");
    if (request.method === "POST") {
      submits++;
      assert.equal(request.url, "/deployments");
      assert.match(request.headers["idempotency-key"], /^[a-f0-9]{64}$/);
      let body = "";
      for await (const chunk of request) body += chunk;
      const job = JSON.parse(body);
      assert.equal(job.project, "legacy-app"); assert.equal(job.environment, "test");
      assert.equal(job.revision, "e".repeat(40)); assert.equal(Object.hasOwn(job, "workspace"), false);
      deployedRevision = job.revision;
    } else assert.equal(request.url, "/deployments/gateway-job");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: request.method === "POST" ? "running" : "succeeded",
      operationId: "gateway-job", revision: deployedRevision, evidence: "Gateway fixture result" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = { kind: "company-ci", adapterVersion: "1", timeoutMs: 500, credentialsEnv: ["COMPANY_DEPLOY_TOKEN"],
    options: { baseUrl: `http://127.0.0.1:${server.address().port}/`, project: "legacy-app" } };
  validateDeploymentOptions(config);
  const task = { id: "REQ-001", workspace, branch: "req/REQ-001", publishedRevision: "e".repeat(40), planHash: "a".repeat(64), contractHash: "b".repeat(64) };
  const limits = { environment: "test", sourceHash: "c".repeat(64), timeoutMs: 500, maxBytes: 10000 };
  const logFile = path.join(workspace, "deploy.log");
  const queued = await deployConfigured(config, task, logFile, limits);
  assert.equal((await pollConfiguredDeployment(config, task, queued, logFile, limits)).status, "succeeded");
  assert.equal(submits, 1);
  assert.doesNotMatch(await fs.readFile(logFile, "utf8"), /fixture-company-token/);
});

test("Jenkins submission and polling abort stalled network requests", async (t) => {
  const config = await serverFixture(t, () => {});
  const task = { id: "REQ-001", branch: "req/REQ-001", publishedRevision: "abc", planHash: "def" };
  const started = Date.now();
  await assert.rejects(deployConfigured(config, task, "unused", {}), { name: "TimeoutError" });
  await assert.rejects(waitForJenkins(config, `${config.baseUrl}queue/item/1/`, "unused"), { name: "TimeoutError" });
  assert.ok(Date.now() - started < 2000);
});

test("Jenkins polling rejects redirects before contacting another endpoint", async (t) => {
  let redirected = false;
  const config = await serverFixture(t, (request, response) => {
    if (request.url === "/redirected") redirected = true;
    response.writeHead(302, { Location: "/redirected" });
    response.end();
  });
  await assert.rejects(waitForJenkins(config, `${config.baseUrl}queue/item/1/`, "unused"), /fetch failed/);
  assert.equal(redirected, false);
});

test("test deployment verifies a reachable environment and records failed health evidence", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-deploy-health-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = await serverFixture(t, (request, response) => {
    response.writeHead(request.url === "/broken" ? 503 : 200);
    response.end("deployed preview");
  });
  const logFile = path.join(directory, "test-deploy.log");
  const result = await verifyTestEnvironment({ url: config.baseUrl }, logFile, 500);
  assert.equal(result.status, "reachable");
  assert.equal(result.httpStatus, 200);
  await assert.rejects(verifyTestEnvironment({ url: `${config.baseUrl}broken` }, logFile, 500), /HTTP 503/);
  assert.match(await fs.readFile(logFile, "utf8"), /"status":"http_error"/);
  await assert.rejects(verifyTestEnvironment({ url: "http://127.0.0.1:1/" }, logFile, 500), /验证地址暂不可访问/);
  assert.match(await fs.readFile(logFile, "utf8"), /"status":"unreachable"/);
  assert.deepEqual(await verifyTestEnvironment({}, logFile, 500), { status: "address_unconfigured" });
});

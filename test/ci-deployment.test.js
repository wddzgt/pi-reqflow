import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialize } from "../src/store.js";
import { loadProject, validateConfig } from "../src/config.js";
import { configureExecution, readExecutionSetup, verifyDeploymentConnection } from "../src/project-execution.js";
import { deployConfigured, pollConfiguredDeployment, verifyTestEnvironment } from "../src/deploy.js";
import { sha256 } from "../src/files.js";
import { addCredential } from "../src/auth.js";
import { startWebServer } from "../src/web-server.js";

async function fixture(t, kind) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "devsail-ci-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "project"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "app.js"), "export const value = 1;\n");
  const config = JSON.parse(await fs.readFile(new URL("../examples/config.local.json", import.meta.url), "utf8"));
  Object.assign(config, { mode: "git", baseBranch: "main", releaseBranch: "main", branchPrefix: "req", remote: "origin",
    checks: [[process.execPath, "--check", "app.js"]], allowedPaths: ["app.js"], testDeployment: { kind: "unconfigured" } });
  const configFile = path.join(directory, "config.json"); await fs.writeFile(configFile, JSON.stringify(config));
  await initialize(root, configFile, { inventoryOnly: true });
  const task = { id: "REQ-CI", workspace: root, branch: "req/REQ-CI", publishedRevision: "a".repeat(40),
    planHash: "b".repeat(64), contractHash: "c".repeat(64) };
  const state = { submissions: 0, wrongRevision: false, failure: false, status: "success", calls: [] };
  const server = http.createServer(async (request, response) => {
    state.calls.push({ method: request.method, path: request.url });
    if (request.url === "/preview") { assert.equal(request.headers.authorization, undefined); response.end("preview"); return; }
    assert.equal(request.headers[kind === "gitlab" ? "private-token" : "authorization"],
      kind === "jenkins" ? `Basic ${Buffer.from("deploy-user:fixture-ci-token").toString("base64")}`
        : kind === "gitlab" ? "fixture-ci-token" : "Bearer fixture-ci-token");
    if (kind === "github") assert.equal(request.headers["x-github-api-version"], "2026-03-10");
    const base = `http://127.0.0.1:${server.address().port}/`;
    const revision = state.wrongRevision ? "d".repeat(40) : task.publishedRevision;
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST") {
      state.submissions++; let body = ""; for await (const chunk of request) body += chunk;
      if (kind === "jenkins") {
        assert.equal(new URLSearchParams(body).get("REVISION"), task.publishedRevision);
        response.writeHead(201, { Location: `${base}queue/item/1/` }); response.end(); return;
      }
      const payload = JSON.parse(body); assert.equal(payload.ref, task.branch);
      if (kind === "gitlab") assert.equal(payload.variables.find(value => value.key === "REVISION").value, task.publishedRevision);
      else assert.equal(payload.inputs.revision, task.publishedRevision);
      if (state.noRunId) { response.writeHead(204); response.end(); return; }
      response.end(JSON.stringify(kind === "gitlab" ? { id: 7, sha: revision, status: "running", web_url: `${base}pipelines/7` } : { workflow_run_id: 7 })); return;
    }
    let data;
    if (kind === "jenkins") {
      if (request.url === "/job/deploy-test/api/json") data = { name: "deploy-test", buildable: true };
      else if (request.url === "/queue/item/1/api/json") data = { executable: { url: `${base}job/deploy-test/7/` } };
      else { assert.equal(request.url, "/job/deploy-test/7/api/json"); data = { building: false, number: 7,
        result: state.failure ? "FAILURE" : "SUCCESS", actions: [{ parameters: [{ name: "REVISION", value: revision }] }] }; }
    } else if (kind === "gitlab") {
      if (request.url === "/api/v4/projects/123") data = { id: 123, path_with_namespace: "team/app" };
      else { assert.equal(request.url, "/api/v4/projects/123/pipelines/7"); data = { id: 7, sha: revision,
        status: state.failure ? "failed" : state.status, web_url: `${base}pipelines/7` }; }
    } else {
      if (request.url === "/repos/team/app/actions/workflows/deploy-test.yml") data = { name: "Deploy test", state: "active" };
      else { assert.equal(request.url, "/repos/team/app/actions/runs/7"); data = { id: 7, head_sha: revision,
        head_branch: task.branch, status: "completed", conclusion: state.failure ? "failure" : state.status }; }
    }
    response.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { root, directory, task, state, server };
}

for (const kind of ["jenkins", "gitlab", "github"]) test(`${kind} settings, credentials and exact-version deployment work through HTTP`, async t => {
  const { root, task, state, server } = await fixture(t, kind);
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const fields = { baseUrl, token: "fixture-ci-token", ...(kind === "jenkins" ? { jobPath: "job/deploy-test", username: "deploy-user" }
    : kind === "gitlab" ? { projectId: "123" } : { owner: "team", repository: "app", workflow: "deploy-test.yml" }) };
  assert.equal((await verifyDeploymentConnection(root, { kind, fields })).connected, true);
  assert.equal(state.submissions, 0, "Connection verification must not deploy");
  const setup = await readExecutionSetup(root);
  const input = { kind, fields, timeoutMs: 1000, expectedConfigHash: setup.configHash, checksText: `${JSON.stringify(process.execPath)} --check app.js`,
    url: `${baseUrl}preview`, checksEnvironment: [], deploymentEnvironment: [] };
  const saved = await configureExecution(root, "admin", input);
  assert.equal(saved.kind, kind); assert.equal(saved.credentialConfigured, true);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-ci-token/);
  assert.equal(state.submissions, 0, "Saving configuration must not deploy");
  await configureExecution(root, "admin", { ...input, expectedConfigHash: saved.configHash, fields: { ...fields, token: "" } });
  await assert.rejects(verifyDeploymentConnection(root, { kind, fields: { ...fields, token: "", baseUrl: "https://other-platform.example/" } }), /地址已改变/);
  const project = await loadProject(root);
  const credentialFile = path.join(project.archive, "deployment-credentials", `${project.config.testDeployment.credentialId}.json`);
  assert.equal((await fs.stat(credentialFile)).mode & 0o777, 0o600);
  for (const file of ["config.json", "execution-config-events.jsonl"]) assert.doesNotMatch(await fs.readFile(path.join(project.archive, file), "utf8"), /fixture-ci-token/);
  const before = sha256(await fs.readFile(path.join(root, "app.js")));
  const limits = { environment: "test", sourceHash: "f".repeat(64), timeoutMs: 1000, maxBytes: 10000, credentialArchive: project.archive };
  const log = path.join(project.archive, "deploy-test.log");
  const receipt = await deployConfigured(project.config.testDeployment, task, log, limits);
  assert.equal(receipt.status, "running");
  state.wrongRevision = true;
  await assert.rejects(pollConfiguredDeployment(project.config.testDeployment, task, receipt, log, limits), /代码版本|REVISION/);
  state.wrongRevision = false;
  assert.equal((await pollConfiguredDeployment(project.config.testDeployment, task, receipt, log, limits)).status, "succeeded");
  assert.equal(state.submissions, 1);
  assert.equal((await verifyTestEnvironment({ url: project.config.testDeployment.url }, log, 1000)).status, "reachable");
  assert.equal(sha256(await fs.readFile(path.join(root, "app.js"))), before);
  assert.doesNotMatch(await fs.readFile(log, "utf8"), /fixture-ci-token/);
});

for (const kind of ["gitlab", "github"]) test(`${kind} reports remote failure and rejects unknown statuses without guessing success`, async t => {
  const { root, task, state, server } = await fixture(t, kind);
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const fields = { baseUrl, token: "fixture-ci-token", ...(kind === "gitlab" ? { projectId: "123" }
    : { owner: "team", repository: "app", workflow: "deploy-test.yml" }) };
  await configureExecution(root, "admin", { kind, fields, timeoutMs: 1000, expectedConfigHash: (await readExecutionSetup(root)).configHash,
    checksText: "node --check app.js", url: `${baseUrl}preview`, checksEnvironment: [], deploymentEnvironment: [] });
  const project = await loadProject(root);
  const limits = { environment: "test", sourceHash: "f".repeat(64), timeoutMs: 1000, maxBytes: 10000, credentialArchive: project.archive };
  const log = path.join(project.archive, "ci.log");
  const queued = await deployConfigured(project.config.testDeployment, task, log, limits);
  state.status = "unrecognized";
  await assert.rejects(pollConfiguredDeployment(project.config.testDeployment, task, queued, log, limits), /Unknown|明确执行结论/);
  state.failure = true;
  const failed = await pollConfiguredDeployment(project.config.testDeployment, task, queued, log, limits);
  assert.equal(failed.status, "failed"); assert.equal(state.submissions, 1);
  assert.throws(() => validateConfig({ ...project.config, environment: { ...project.config.environment,
    pi: project.config.testDeployment.credentialsEnv } }), /adapter credentials/);
});

test("only administrators can verify and configure CI through the workbench API", async t => {
  const { root, directory, state, server } = await fixture(t, "gitlab");
  const priorState = process.env.REQFLOW_STATE_DIR; process.env.REQFLOW_STATE_DIR = path.join(directory, "state");
  t.after(() => { if (priorState === undefined) delete process.env.REQFLOW_STATE_DIR; else process.env.REQFLOW_STATE_DIR = priorState; });
  const project = await loadProject(root);
  for (const role of ["admin", "product", "developer"]) await addCredential(project, role, [role], { username: role, password: "member123" });
  const web = await startWebServer(root, 0);
  t.after(() => { web.server.closeAllConnections(); return new Promise(resolve => web.server.close(resolve)); });
  const fields = { baseUrl: `http://127.0.0.1:${server.address().port}/`, projectId: "123", token: "fixture-ci-token" };
  for (const role of ["product", "developer", "admin"]) {
    const login = await fetch(`${web.url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: web.url }, body: JSON.stringify({ username: role, password: "member123" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const bootstrap = await (await fetch(`${web.url}/api/bootstrap`, { headers: { cookie } })).json();
    const headers = { cookie, Origin: web.url, "Content-Type": "application/json", "X-Reqflow-Token": bootstrap.token };
    const connection = await fetch(`${web.url}/api/deployment-connection`, { method: "POST", headers, body: JSON.stringify({ kind: "gitlab", fields }) });
    assert.equal(connection.status, role === "admin" ? 200 : 403);
    assert.doesNotMatch(await connection.text(), /fixture-ci-token/);
    const setup = await readExecutionSetup(root);
    const saved = await fetch(`${web.url}/api/project-execution`, { method: "POST", headers,
      body: JSON.stringify({ kind: "gitlab", fields, timeoutMs: 1000, expectedConfigHash: setup.configHash,
        checksText: "node --check app.js", url: `${fields.baseUrl}preview`, checksEnvironment: [], deploymentEnvironment: [] }) });
    assert.equal(saved.status, role === "admin" ? 200 : 403);
    assert.doesNotMatch(await saved.text(), /fixture-ci-token/);
  }
  assert.equal(state.submissions, 0);
});

test("GitHub dispatch without a unique run ID cannot guess the most recent run", async t => {
  const { root, task, state, server } = await fixture(t, "github");
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  await configureExecution(root, "admin", { kind: "github", fields: { baseUrl, owner: "team", repository: "app", workflow: "deploy-test.yml", token: "fixture-ci-token" },
    timeoutMs: 1000, expectedConfigHash: (await readExecutionSetup(root)).configHash, checksText: "node --check app.js",
    url: `${baseUrl}preview`, checksEnvironment: [], deploymentEnvironment: [] });
  const project = await loadProject(root); state.noRunId = true;
  await assert.rejects(deployConfigured(project.config.testDeployment, task, path.join(project.archive, "no-run.log"), {
    environment: "test", sourceHash: "f".repeat(64), timeoutMs: 1000, maxBytes: 10000, credentialArchive: project.archive,
  }), /未返回唯一运行编号/);
  assert.equal(state.submissions, 1); assert.equal(state.calls.filter(call => call.method === "GET").length, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialize } from "../src/store.js";
import { describePolicy, loadProject, resolveAgentModel } from "../src/config.js";
import { readProjectBaseline } from "../src/baseline.js";
import { readModelSettings, configureModels, testModelConnection, modelAgents } from "../src/model-settings.js";
import { readModelCredential } from "../src/model-credentials.js";
import { addCredential } from "../src/auth.js";
import { startWebServer } from "../src/web-server.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsail-model-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "source.js"), "export const value = 1;\n");
  const config = JSON.parse(await fs.readFile(new URL("../examples/config.local.json", import.meta.url)));
  config.allowedPaths = ["."]; config.checks = []; config.testDeployment = { kind: "unconfigured" };
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(config));
  await initialize(root, path.join(root, "settings.json"), { inventoryOnly: true });
  return root;
}

function input(setup, key = "test-secret-opaque") {
  const value = { ...setup.default, provider: "测试服务", model: "qwen3.8-27b", baseUrl: "https://models.example/v1",
    apiKey: key, reasoning: true, thinkingToggle: true, supportsReasoningEffort: false,
    supportsJsonSchema: false, modelParameters: { outputFormat: "auto", temperature: 0.2 } };
  delete value.credentialConfigured;
  return { expectedConfigHash: setup.expectedConfigHash, default: value,
    agents: Object.fromEntries(modelAgents.map(agent => [agent, null])), maxCostUsd: 2 };
}

test("settings preserve inheritance, encrypt credentials and never return secret material", async t => {
  const root = await fixture(t); const setup = await readModelSettings(root); const body = input(setup);
  const originalBaseline = await readProjectBaseline(await loadProject(root));
  body.agents.development = { ...body.default, model: "glm-5.3", apiKey: "another-plan-secret", thinking: "low",
    modelParameters: { outputFormat: "json_object", topP: 0.8 }, maxPiMs: 90000 };
  const saved = await configureModels(root, "admin", body); const project = await loadProject(root);
  assert.equal(saved.default.credentialConfigured, true); assert.equal(saved.agents.requirement, null);
  assert.equal(resolveAgentModel(project.config, "intake").selectionSource, "project");
  assert.equal(resolveAgentModel(project.config, "plan").model, "glm-5.3");
  assert.equal(resolveAgentModel(project.config, "plan").maxPiMs, 90000);
  assert.equal(project.config.modelFallbacks, undefined);
  assert.equal(await readModelCredential(project.archive, project.config.compatibleProviders[0].credentialId), body.default.apiKey);
  const returned = JSON.stringify(saved); const configured = JSON.stringify(project.config);
  for (const secret of [body.default.apiKey, body.agents.development.apiKey]) { assert.ok(!returned.includes(secret)); assert.ok(!configured.includes(secret)); }
  const credentials = path.join(project.archive, "model-credentials");
  for (const file of await fs.readdir(credentials)) assert.ok(!(await fs.readFile(path.join(credentials, file), "utf8")).includes("secret"));
  const next = input(saved, ""); next.default = { ...saved.default, apiKey: "" }; delete next.default.credentialConfigured;
  const restored = await configureModels(root, "admin", next);
  assert.equal(restored.agents.development, null);
  await assert.rejects(configureModels(root, "admin", body), /已改变/);
  const changedHost = input(restored, ""); changedHost.default.baseUrl = "https://other.example/v1";
  await assert.rejects(configureModels(root, "admin", changedHost), /变更服务地址/);
  const pinned = input(restored, ""); pinned.agents.development = { ...pinned.default };
  const pinnedSettings = await configureModels(root, "admin", pinned);
  assert.equal(pinnedSettings.agents.development.model, pinnedSettings.default.model);
  const changedDefault = input(pinnedSettings, ""); changedDefault.default.model = "glm-5.3";
  changedDefault.agents.development = { ...pinnedSettings.agents.development, apiKey: "" };
  delete changedDefault.agents.development.credentialConfigured;
  const changedSettings = await configureModels(root, "admin", changedDefault);
  assert.equal(changedSettings.default.model, "glm-5.3");
  assert.equal(changedSettings.agents.development.model, "qwen3.8-27b");
  assert.equal((await readProjectBaseline(await loadProject(root))).snapshotHash, originalBaseline.snapshotHash);
});

test("all three agents resolve independent models and can return to live default inheritance", async t => {
  const root = await fixture(t); const body = input(await readModelSettings(root));
  for (const agent of modelAgents) body.agents[agent] = { ...body.default, model: `independent-${agent}`, apiKey: "" };
  const saved = await configureModels(root, "admin", body);
  let project = await loadProject(root);
  for (const agent of modelAgents) {
    const selection = resolveAgentModel(project.config, { requirement: "intake", development: "plan", review: "review" }[agent],
      agent === "review" ? "all" : null);
    assert.equal(selection.model, `independent-${agent}`);
    assert.equal(selection.selectionSource, "agent");
  }
  const next = input(saved, ""); next.default.model = "new-project-default";
  for (const agent of modelAgents) {
    const { credentialConfigured, ...profile } = saved.agents[agent];
    next.agents[agent] = { ...profile, apiKey: "" };
  }
  next.agents.development = null;
  await configureModels(root, "admin", next);
  project = await loadProject(root);
  assert.equal(resolveAgentModel(project.config, "implement").model, "new-project-default");
  assert.equal(resolveAgentModel(project.config, "implement").selectionSource, "project");
  assert.equal(resolveAgentModel(project.config, "plan").model, "new-project-default");
  assert.equal(resolveAgentModel(project.config, "initialize").model, "new-project-default");
  assert.equal(resolveAgentModel(project.config, "intake").model, "independent-requirement");
});

test("connection test uses one short request, keeps unsaved keys private and reports quota explicitly", async t => {
  const root = await fixture(t); const setup = await readModelSettings(root); const body = input(setup);
  let calls = 0;
  const request = async (_url, options) => {
    calls++; const payload = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, `Bearer ${body.default.apiKey}`);
    assert.equal(payload.response_format.type, "json_object"); assert.equal(payload.max_tokens, 256);
    assert.equal(payload.enable_thinking, false); assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 20 } }));
  };
  const result = await testModelConnection(root, { scope: "default", profile: body.default }, request);
  assert.equal(result.connected, true); assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes(body.default.apiKey));
  assert.equal((await readModelSettings(root)).expectedConfigHash, setup.expectedConfigHash);
  await assert.rejects(testModelConnection(root, { scope: "default", profile: body.default }, async () => new Response(
    JSON.stringify({ error: { code: "AllocationQuota.FreeTierOnly", message: body.default.apiKey } }), { status: 403 })), /额度已耗尽/);
  await assert.rejects(testModelConnection(root, { scope: "default", profile: { ...body.default,
    modelParameters: { outputFormat: "json_schema" } } }, request), /未声明/);
  assert.equal(calls, 1);
});

test("connection testing respects the configured thinking and reasoning effort", async t => {
  const root = await fixture(t); const body = input(await readModelSettings(root));
  body.default.thinking = "low"; body.default.supportsReasoningEffort = true;
  await testModelConnection(root, { scope: "default", profile: body.default }, async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.enable_thinking, true); assert.equal(payload.reasoning_effort, "low");
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
});

test("execution bindings ignore model controls but retain source, permissions and deployment rules", async t => {
  const root = await fixture(t); const { config } = await loadProject(root);
  const expected = describePolicy(config).executionConfigHash;
  const models = { ...config, model: "another-model", thinking: "high", modelParameters: { temperature: 0.8 },
    agentModels: { development: { provider: "separate", model: "coding" } },
    maxPiMs: config.maxPiMs + 1, maxToolCalls: config.maxToolCalls + 1, maxCostUsd: config.maxCostUsd + 1,
    modelUsage: { ...config.modelUsage, maxRequests: config.modelUsage.maxRequests + 1 } };
  assert.equal(describePolicy(models).executionConfigHash, expected);
  assert.notEqual(describePolicy(models).configHash, describePolicy(config).configHash);
  for (const change of [{ allowedPaths: ["source.js"] }, { excludedPaths: [...config.excludedPaths, "private"] },
    { checks: [[process.execPath, "--version"]] }, { piExecutable: "/opt/other/pi" },
    { productionDeployment: { kind: "local", command: [process.execPath, "--version"] } },
    { checks: [[process.execPath, "--version"]], testDeployment: { kind: "local", command: [process.execPath, "--version"] } },
    { environment: { ...config.environment, checks: ["CHECK_SETTING"] } },
    { codingStandards: { globalRules: [{ id: "TEAM-API", text: "Preserve API compatibility", level: "guide" }] } },
    { mode: "git", baseBranch: "main", releaseBranch: "test", branchPrefix: "devsail", remote: "origin" }]) {
    assert.notEqual(describePolicy({ ...config, ...change }).executionConfigHash, expected);
  }
  const reordered = Object.fromEntries(Object.entries(models).reverse());
  assert.equal(describePolicy(reordered).executionConfigHash, expected);
});

test("encrypted credential tampering fails and numeric parameters cannot bypass validation", async t => {
  const root = await fixture(t); const body = input(await readModelSettings(root));
  await assert.rejects(configureModels(root, "admin", { ...body, default: { ...body.default, modelUsage: { maxRequests: 0 } } }), /positive integer/);
  await configureModels(root, "admin", body); const project = await loadProject(root);
  const provider = project.config.compatibleProviders[0]; const file = path.join(project.archive, "model-credentials", `${provider.credentialId}.json`);
  const data = JSON.parse(await fs.readFile(file, "utf8")); data.tag = Buffer.alloc(16).toString("base64"); await fs.writeFile(file, JSON.stringify(data));
  await assert.rejects(readModelCredential(project.archive, provider.credentialId));
});

test("only admins can read, save or test models and writes require the session token", async t => {
  const root = await fixture(t); const previousState = process.env.REQFLOW_STATE_DIR;
  process.env.REQFLOW_STATE_DIR = path.join(root, "isolated-registry");
  t.after(() => { if (previousState === undefined) delete process.env.REQFLOW_STATE_DIR; else process.env.REQFLOW_STATE_DIR = previousState; });
  const project = await loadProject(root);
  for (const role of ["admin", "developer", "product"]) await addCredential(project, role, [role], { username: role, password: `${role}-test-password` });
  const service = await startWebServer(root, 0); t.after(() => new Promise(resolve => service.server.close(resolve)));
  for (const role of ["admin", "developer", "product"]) {
    const login = await fetch(service.url + "/api/login", { method: "POST", headers: { Origin: service.url, "Content-Type": "application/json" },
      body: JSON.stringify({ username: role, password: `${role}-test-password` }) });
    assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { cookie, Origin: service.url, "Content-Type": "application/json" };
    const setup = await fetch(service.url + "/api/model-settings", { headers });
    assert.equal(setup.status, role === "admin" ? 200 : 403);
    for (const route of ["model-settings", "model-connection"]) assert.equal((await fetch(service.url + `/api/${route}`,
      { method: "POST", headers, body: "{}" })).status, 403);
  }
});

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProject } from "../src/config.js";
import { loadCredentials, changePassword, authenticateByUsername } from "../src/auth.js";
import { bootstrapDefaultProject } from "../src/first-run.js";
import { runPi } from "../src/pi-runner.js";
import { loadRegistry, removeProject } from "../src/project-registry.js";
import { startWebServer } from "../src/web-server.js";

test("built-in demo bootstraps offline once, defers models and preserves administrator changes", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pi-reqflow-setup-"));
  const oldState = process.env.REQFLOW_STATE_DIR; const oldPi = process.env.REQFLOW_PI_EXECUTABLE;
  process.env.REQFLOW_STATE_DIR = path.join(temporary, "state");
  const pi = path.join(temporary, "pi");
  await fs.writeFile(pi, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  process.env.REQFLOW_PI_EXECUTABLE = pi;
  const root = path.join(temporary, "source"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "app.js"), "export const original = true;\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  await Promise.all([bootstrapDefaultProject(), bootstrapDefaultProject()]);
  let web = await startWebServer(undefined, 0);
  t.after(async () => {
    await new Promise(resolve => web.server.close(resolve));
    if (oldState === undefined) delete process.env.REQFLOW_STATE_DIR; else process.env.REQFLOW_STATE_DIR = oldState;
    if (oldPi === undefined) delete process.env.REQFLOW_PI_EXECUTABLE; else process.env.REQFLOW_PI_EXECUTABLE = oldPi;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  assert.equal((await fetch(`${web.url}/api/bootstrap`)).status, 401);
  assert.equal((await loadRegistry()).projects.length, 1);
  const imported = (await loadRegistry()).projects[0];
  const project = await loadProject(imported.projectDir);
  assert.deepEqual(project.config.checks, [["npm", "test"]]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(project.archive, "documentation-mode.json"))), { mode: "inventory" });
  assert.equal((await loadCredentials(project)).users[0].username, "admin");
  await assert.rejects(runPi(project, project.root, "plan", "No model yet", path.join(temporary, "model.log"), 1), /尚未配置模型/);
  assert.equal(await fs.readFile(path.join(root, "app.js"), "utf8"), "export const original = true;\n");
  const login = await fetch(`${web.url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123", projectId: imported.id }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${web.url}/api/overview`, { headers: { Cookie: cookie } })).status, 200);
  const bootstrap = await (await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  const importedResponse = await fetch(`${web.url}/api/projects`, { method: "POST", headers: { Cookie: cookie,
    Origin: web.url, "Content-Type": "application/json", "x-reqflow-token": bootstrap.token },
    body: JSON.stringify({ name: "Existing system", rootDir: root }) });
  assert.equal(importedResponse.status, 201, await importedResponse.clone().text());
  const userProject = await importedResponse.json();
  const loaded = await loadProject(userProject.projectDir);
  assert.equal(loaded.accountsArchive, project.accountsArchive);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(loaded.archive, "documentation-mode.json"))), { mode: "inventory" });
  const settings = await (await fetch(`${web.url}/api/model-settings`, { headers: { Cookie: cookie } })).json();
  assert.equal(settings.default.provider, "");
  assert.equal(settings.default.model, "");
  const profile = { ...settings.default, provider: "Test provider", model: "Test model",
    baseUrl: "https://models.example/v1", apiKey: "test-key-no-external-request" };
  delete profile.credentialConfigured;
  const savedModels = await fetch(`${web.url}/api/model-settings`, { method: "POST", headers: { Cookie: cookie,
    Origin: web.url, "Content-Type": "application/json", "x-reqflow-token": bootstrap.token },
    body: JSON.stringify({ expectedConfigHash: settings.expectedConfigHash, default: profile,
      agents: settings.agents, maxCostUsd: settings.maxCostUsd }) });
  assert.equal(savedModels.status, 200, await savedModels.clone().text());
  assert.equal((await savedModels.json()).default.credentialConfigured, true);
  assert.equal((await loadProject(project.root)).config.model, "Test model");
  await changePassword(project, bootstrap.principal, "admin123", "my-new-administrator-password");
  const credentials = await fs.readFile(path.join(project.archive, "auth.json"), "utf8");
  await new Promise(resolve => web.server.close(resolve));
  web = await startWebServer(undefined, 0);
  await bootstrapDefaultProject();
  await assert.rejects(authenticateByUsername(project, "admin", "admin123"), /Invalid username or password/);
  assert.equal((await authenticateByUsername(project, "admin", "my-new-administrator-password")).id, "admin");
  assert.equal(await fs.readFile(path.join(project.archive, "auth.json"), "utf8"), credentials);
  await removeProject(imported.id, "admin");
  await removeProject(userProject.id, "admin");
  await bootstrapDefaultProject();
  assert.equal((await loadRegistry()).projects.length, 2);
  const archived = await (await fetch(`${web.url}/api/bootstrap`)).json();
  assert.equal(archived.noProjects, true);
});

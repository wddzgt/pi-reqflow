import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addCredential, authenticateByUsername, resetPassword, updateUserRoles, validSessionPrincipal, loadCredentials, reprovisionCredentials } from "../src/auth.js";
import { importProject, listProjects, loadRegistry, removeProject, regenerateProjectReference } from "../src/project-registry.js";
import { loadProject } from "../src/config.js";
import { readProjectBaseline } from "../src/baseline.js";
import { createTask } from "../src/store.js";
import { readJson, writeJson, sha256 } from "../src/files.js";
import { startWebServer } from "../src/web-server.js";
import { plan } from "../src/workflow.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("web import uses account roles and detected scripts without creating accounts", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-account-import-"));
  const previous = process.env.REQFLOW_STATE_DIR;
  process.env.REQFLOW_STATE_DIR = path.join(temporary, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.REQFLOW_STATE_DIR;
    else process.env.REQFLOW_STATE_DIR = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const source = path.join(temporary, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "app.js"), "export const value = 1;\n");
  const config = { ...JSON.parse(await fs.readFile(path.join(repository, "examples/config.local.json"))),
    piExecutable: path.join(repository, "test/fake-pi.mjs"), provider: "fake", model: "fake",
    allowedPaths: ["backend"], checks: [[process.execPath, "--check", "backend/app.js"]],
    testDeployment: { kind: "local", command: [process.execPath, "--check", "backend/app.js"] } };
  const entry = await importProject("Accounts", { backendDir: source }, { config, inventoryOnly: true,
    admin: { id: "admin", username: "admin", password: "account-password-123" } });
  const project = await loadProject(entry.projectDir);
  for (const role of ["product", "developer"]) await addCredential(project, role, [role], { username: role, password: "account-password-123" });
  const web = await startWebServer(project.root, 0);
  t.after(() => new Promise(resolve => web.server.close(resolve)));
  const importedSource = path.join(temporary, "new-source");
  await fs.mkdir(importedSource);
  await writeJson(path.join(importedSource, "package.json"), { scripts: { test: "node --check app.js", "deploy:test": "node deploy.js" } });
  await fs.writeFile(path.join(importedSource, "app.js"), "export const value = 2;\n");
  await fs.writeFile(path.join(importedSource, "deploy.js"), "// Fixture deployment entrypoint; not run by import.\n");
  const priorUsers = await loadCredentials(project);
  for (const role of ["product", "developer", "admin"]) {
    const login = await fetch(`${web.url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: role, password: "account-password-123" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const session = await (await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-Reqflow-Token": session.token };
    const response = await fetch(`${web.url}/api/projects`, { method: "POST", headers,
      body: JSON.stringify({ name: "Imported", backendDir: importedSource, options: { inventoryOnly: true } }) });
    assert.equal(response.status, role === "admin" ? 201 : 403);
    assert.equal((await fetch(`${web.url}/api/project-execution`, { headers })).status, role === "admin" ? 200 : 403);
    if (role !== "admin") continue;
    const imported = await response.json();
    const target = await loadProject(imported.projectDir);
    assert.equal(target.accountsArchive, project.accountsArchive);
    assert.deepEqual(target.config.checks, [["npm", "--prefix", "backend", "test"]]);
    assert.equal((await fetch(`${web.url}/api/projects/${imported.id}/switch`, { method: "POST", headers, body: "{}" })).status, 200);
    const switched = await (await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
    const nextHeaders = { ...headers, "X-Reqflow-Token": switched.token };
    const pendingSource = path.join(temporary, "pending-source");
    await fs.mkdir(pendingSource);
    await fs.copyFile(path.join(source, "app.js"), path.join(pendingSource, "app.js"));
    const pendingResponse = await fetch(`${web.url}/api/projects`, { method: "POST", headers: nextHeaders,
      body: JSON.stringify({ name: "Pending execution", backendDir: pendingSource, options: { inventoryOnly: true } }) });
    assert.equal(pendingResponse.status, 201, await pendingResponse.clone().text());
    const pending = await pendingResponse.json();
    const pendingProject = await loadProject(pending.projectDir);
    assert.equal(pendingProject.config.testDeployment.kind, "unconfigured");
    assert.deepEqual(pendingProject.config.checks, []);
    await createTask(pendingProject, "REQ-PENDING", "Business discussion", "Existing app adjustment", "product");
    await assert.rejects(plan(pendingProject.root, "REQ-PENDING"), /expected a frozen requirement/);
    assert.equal((await fetch(`${web.url}/api/projects/${pending.id}/switch`, { method: "POST", headers: nextHeaders, body: "{}" })).status, 200);
    const setupSession = await (await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
    const setup = await (await fetch(`${web.url}/api/project-execution`, { headers: { Cookie: cookie } })).json();
    const execution = { kind: "local", expectedConfigHash: setup.configHash, checksText: `${JSON.stringify(process.execPath)} --check backend/app.js`,
      deployCommand: `${JSON.stringify(process.execPath)} --check backend/app.js`, url: "http://127.0.0.1:9000/",
      checksEnvironment: [], deploymentEnvironment: [] };
    const save = async input => fetch(`${web.url}/api/project-execution`, { method: "POST",
      headers: { ...headers, "X-Reqflow-Token": setupSession.token }, body: JSON.stringify(input) });
    const checksOnly = await save({ ...execution, kind: "unconfigured", url: "", deployCommand: undefined });
    assert.equal(checksOnly.status, 200, await checksOnly.clone().text());
    const partial = await checksOnly.json();
    assert.equal(partial.kind, "unconfigured");
    assert.equal(partial.url, "");
    assert.ok(partial.checksText.includes("--check"));
    execution.expectedConfigHash = partial.configHash;
    assert.equal((await save({ ...execution, checksText: "npm test && publish" })).status, 400);
    assert.equal((await save({ ...execution, deployCommand: "publish $PASSWORD" })).status, 400);
    const configured = await save({ ...execution, checksText: "" });
    assert.equal(configured.status, 200, await configured.clone().text());
    assert.equal((await configured.clone().json()).checksText, "");
    assert.equal((await configured.json()).kind, "local");
    assert.equal((await save(execution)).status, 400, "Stale operator forms cannot replace newer execution configuration");
    await readProjectBaseline(await loadProject(pending.projectDir));
    const events = (await fs.readFile(path.join(pendingProject.archive, "execution-config-events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(JSON.parse(events[0]).actor, "admin");
    assert.equal(events.length, 2);
  }
  assert.deepEqual(await loadCredentials(project), priorUsers);
});

test("project import requires real configuration, retains a valid baseline and archives without deleting", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-project-boundaries-"));
  const previous = process.env.REQFLOW_STATE_DIR;
  process.env.REQFLOW_STATE_DIR = path.join(temporary, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.REQFLOW_STATE_DIR;
    else process.env.REQFLOW_STATE_DIR = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const source = path.join(temporary, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "app.js"), "export const value = 1;\n");
  await fs.writeFile(path.join(source, ".env"), "SECRET=must-not-be-copied");
  const config = { schemaVersion: 2, mode: "local", piExecutable: path.join(repository, "test/fake-pi.mjs"),
    provider: "fake", model: "fake", environment: { pi: [], checks: [], localDeployment: [] },
    allowedPaths: ["backend"], excludedPaths: [".env"], maxSnapshotBytes: 1000000, maxPiMs: 30000,
    maxToolCalls: 20, maxEventBytes: 1000000, maxCostUsd: 2, checks: [[process.execPath, "--check", "backend/app.js"]],
    testDeployment: { kind: "local", command: [process.execPath, "--check", "backend/app.js"] }, productionDeployment: { kind: "none" } };
  const admin = { id: "admin", username: "administrator", password: "unique-password-for-project" };
  await assert.rejects(importProject("missing-config", { backendDir: source }), /config must be an object/);
  await assert.rejects(importProject("missing-admin", { backendDir: source }, { config }), /administrator/);
  await assert.rejects(importProject("wrong-executor", { backendDir: source }, { config: { ...config, piExecutable: process.execPath }, admin }), /Node is not/);
  const entry = await importProject("Project A", { backendDir: source }, { config, admin });
  const project = await loadProject(entry.projectDir);
  await readProjectBaseline(project);
  await assert.rejects(fs.stat(path.join(project.root, "backend", ".env")), { code: "ENOENT" });
  await assert.rejects(authenticateByUsername(project, "admin", "admin123"), /Invalid username/);
  await regenerateProjectReference(entry.id);
  await readProjectBaseline(project);
  const reference = await fs.readFile(path.join(project.archive, "PROJECT_REFERENCE.md"), "utf8");
  assert.match(reference, /项目开发指南/);
  assert.doesNotMatch(reference, /负责人待确认/);
  assert.match(reference, /backend\/app.js/);
  assert.doesNotMatch(reference, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await assert.rejects(fs.stat(path.join(project.root, "PROJECT_REFERENCE.md")), { code: "ENOENT" });

  await addCredential(project, "product", ["product"], { username: "product", password: admin.password });
  const stored = await loadCredentials(project);
  assert.notEqual(stored.users[0].passwordSalt, stored.users[1].passwordSalt);
  assert.notEqual(stored.users[0].passwordHash, stored.users[1].passwordHash);
  assert.notEqual(stored.users[0].passwordHash, sha256(admin.password));
  const beforeReset = await authenticateByUsername(project, "product", admin.password);
  await resetPassword(project, "product", "replacement-password-for-product");
  assert.equal(await validSessionPrincipal(project, beforeReset), false);
  const beforeRoleChange = await authenticateByUsername(project, "product", "replacement-password-for-product");
  await updateUserRoles(project, "product", ["developer"]);
  assert.equal(await validSessionPrincipal(project, beforeRoleChange), false);
  await updateUserRoles(project, "product", ["product"]);

  const sourceB = path.join(temporary, "source-b");
  await fs.mkdir(sourceB);
  await fs.writeFile(path.join(sourceB, "app.js"), "export const value = 2;\n");
  const imports = await Promise.allSettled([
    importProject("Project B", { backendDir: sourceB }, { config, accountSource: project.accountsArchive }),
    importProject("Duplicate B", { backendDir: sourceB }, { config, accountSource: project.accountsArchive }),
  ]);
  assert.equal(imports.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(imports.find((result) => result.status === "rejected").reason.message, /already imported/);
  const entryB = imports.find((result) => result.status === "fulfilled").value;
  const projectB = await loadProject(entryB.projectDir);
  assert.equal(projectB.accountsArchive, project.accountsArchive);
  await assert.rejects(fs.stat(path.join(projectB.archive, "auth.json")), { code: "ENOENT" });
  const web = await startWebServer(project.root, 0);
  t.after(() => new Promise((resolve) => web.server.close(resolve)));
  const login = await fetch(`${web.url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: web.url },
    body: JSON.stringify({ username: "product", password: "replacement-password-for-product" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const bootstrap = await (await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  assert.equal(bootstrap.projects.length, 2);
  const documentResponse = await fetch(`${web.url}/api/project-reference`, { headers: { Cookie: cookie } });
  assert.equal(documentResponse.status, 200);
  const document = await documentResponse.json();
  assert.equal(document.content, reference);
  assert.equal(document.snapshotHash, (await readProjectBaseline(project)).snapshotHash);
  const headers = { Cookie: cookie, Origin: web.url, "Content-Type": "application/json", "X-Reqflow-Token": bootstrap.token };
  assert.equal((await fetch(`${web.url}/api/projects`, { method: "POST", headers, body: "{}" })).status, 403);
  const denied = await fetch(`${web.url}/api/projects/${entryB.id}/switch`, { method: "POST", headers,
    body: JSON.stringify({ username: "product", password: "replacement-password-for-product" }) });
  assert.equal(denied.status, 200);
  const switchedSession = await (await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  assert.equal(switchedSession.principal.roles[0], "product");
  assert.equal((await fetch(`${web.url}/api/admin/users`, { headers: { Cookie: cookie } })).status, 403);
  const switched = await fetch(`${web.url}/api/projects/${entryB.id}/switch`, { method: "POST", headers: { ...headers, "X-Reqflow-Token": switchedSession.token },
    body: JSON.stringify({ username: "different-user", password: "different-project-password" }) });
  assert.equal(switched.status, 200);
  const targetBootstrap = await (await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  assert.equal(targetBootstrap.principal.roles[0], "product");
  assert.equal(targetBootstrap.currentProjectId, entryB.id);
  const mismatchedDelete = await fetch(`${web.url}/api/projects/${entry.id}`, { method: "DELETE",
    headers: { ...headers, "X-Reqflow-Token": targetBootstrap.token } });
  assert.equal(mismatchedDelete.status, 403);
  const sessionFiles = (await fs.readdir(process.env.REQFLOW_STATE_DIR)).filter((name) => name.startsWith("sessions-"));
  assert.equal((await fs.stat(path.join(process.env.REQFLOW_STATE_DIR, sessionFiles[0]))).mode & 0o777, 0o600);
  await resetPassword(projectB, "product", "another-password-for-project-b");
  assert.equal((await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: cookie } })).status, 401);

  const emptyState = path.join(temporary, "empty-state");
  process.env.REQFLOW_STATE_DIR = emptyState;
  const empty = await startWebServer(undefined, 0);
  try {
    assert.equal((await fetch(`${empty.url}/api/browse/home`)).status, 401);
    assert.equal((await fetch(`${empty.url}/api/projects`, { method: "POST", headers: { Origin: empty.url, "Content-Type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await (await fetch(`${empty.url}/api/bootstrap`)).json()).noProjects, true);
  } finally { await new Promise((resolve) => empty.server.close(resolve)); }
  process.env.REQFLOW_STATE_DIR = path.join(temporary, "state");

  await removeProject(entryB.id, "admin");
  assert.equal((await listProjects()).length, 1);
  assert.equal((await loadRegistry()).projects.find((row) => row.id === entryB.id).archivedBy, "admin");
  assert.match(await fs.readFile(path.join(projectB.root, "backend", "app.js"), "utf8"), /value = 2/);
  assert.ok(await fs.stat(path.join(projectB.accountsArchive, "auth-events.jsonl")));
  await createTask(project, "REQ-ACTIVE", "Active requirement", "Keep audit records", "admin");
  await assert.rejects(removeProject(entry.id, "admin"), /active requirement/);
  assert.equal((await listProjects()).length, 1);
  const authFile = path.join(project.archive, "auth.json");
  const legacy = await readJson(authFile);
  legacy.schemaVersion = 3;
  for (const user of legacy.users) {
    user.passwordHash = sha256("legacy-password");
    delete user.passwordSalt;
    delete user.authVersion;
  }
  await writeJson(authFile, legacy);
  const beforeLoad = await fs.readFile(authFile, "utf8");
  await assert.rejects(loadCredentials(project), /explicitly reprovisioned/);
  assert.equal(await fs.readFile(authFile, "utf8"), beforeLoad);
  await assert.rejects(reprovisionCredentials(project, { admin: "fresh-password-for-admin" }), /every existing user/);
  const upgraded = await reprovisionCredentials(project, { admin: "fresh-password-for-admin", product: "fresh-password-for-product" });
  assert.deepEqual(await readJson(upgraded.backup), legacy);
  assert.equal((await fs.stat(upgraded.backup)).mode & 0o777, 0o600);
  assert.equal((await authenticateByUsername(project, "administrator", "fresh-password-for-admin")).mustChangePassword, true);
  const upgradedLogin = await fetch(`${web.url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: web.url },
    body: JSON.stringify({ username: "administrator", password: "fresh-password-for-admin" }) });
  const temporaryCookie = upgradedLogin.headers.get("set-cookie").split(";")[0];
  const temporarySession = await (await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: temporaryCookie } })).json();
  assert.equal((await fetch(`${web.url}/api/overview`, { headers: { Cookie: temporaryCookie } })).status, 403);
  const changed = await fetch(`${web.url}/api/change-password`, { method: "POST", headers: {
    Cookie: temporaryCookie, Origin: web.url, "Content-Type": "application/json", "X-Reqflow-Token": temporarySession.token },
    body: JSON.stringify({ oldPassword: "fresh-password-for-admin", newPassword: "final-password-for-admin" }) });
  assert.equal(changed.status, 200);
  assert.equal((await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: temporaryCookie } })).status, 401);
  assert.equal((await authenticateByUsername(project, "administrator", "final-password-for-admin")).mustChangePassword, false);
});

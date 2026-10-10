import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { analyzeProjectStructure, importProject } from "../src/project-registry.js";
import { loadProject } from "../src/config.js";
import { readProjectBaseline } from "../src/baseline.js";
import { startWebServer } from "../src/web-server.js";

const repository = path.resolve(new URL("..", import.meta.url).pathname);
const admin = { id: "admin", username: "admin", password: "admin123" };
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "devsail-root-import-")));
  const priorState = process.env.REQFLOW_STATE_DIR;
  process.env.REQFLOW_STATE_DIR = path.join(temporary, "state");
  t.after(async () => {
    if (priorState === undefined) delete process.env.REQFLOW_STATE_DIR; else process.env.REQFLOW_STATE_DIR = priorState;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const root = path.join(temporary, "form-edit");
  for (const directory of ["frontend/src", "backend/src/main/java", "scripts", "node_modules"]) await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", "deploy:test": "node scripts/deploy.mjs" } }));
  await fs.writeFile(path.join(root, "frontend/package.json"), JSON.stringify({ dependencies: { vue: "3" } }));
  await fs.writeFile(path.join(root, "frontend/src/main.js"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "backend/pom.xml"), "<project><artifactId>backend</artifactId></project>\n");
  await fs.writeFile(path.join(root, "backend/src/main/java/App.java"), "class App {}\n");
  await fs.writeFile(path.join(root, "scripts/deploy.mjs"), "// Existing company deployment script; never run during import.\n");
  await fs.writeFile(path.join(root, "nginx.conf"), "# Shared root configuration\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=excluded\n");
  await fs.writeFile(path.join(root, "node_modules/dependency.js"), "// Excluded dependency\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".env\nnode_modules/\n.reqflow/\n");
  const config = { ...JSON.parse(await fs.readFile(path.join(repository, "examples/config.local.json"))),
    piExecutable: path.join(repository, "test/fake-pi.mjs"), provider: "fake", model: "fake" };
  return { root, temporary, config };
}

test("root import preserves a Vue/Maven project's layout and common files", async t => {
  const f = await fixture(t);
  const structure = await analyzeProjectStructure(f.root);
  assert.equal(structure.frontendDir, "frontend"); assert.equal(structure.backendDir, "backend");
  assert.match(structure.detectedFrameworks.frontend, /Vue/);
  const entry = await importProject("Full stack", { rootDir: f.root }, { config: f.config, admin, inventoryOnly: true, detectExecution: true });
  assert.equal(entry.rootDir, f.root); assert.equal(entry.structure.hasFrontend, true); assert.equal(entry.structure.hasBackend, true);
  assert.equal(entry.frontendDir, path.join(f.root, "frontend")); assert.equal(entry.backendDir, path.join(f.root, "backend"));
  const project = await loadProject(entry.projectDir);
  assert.deepEqual(project.config.allowedPaths, ["."]);
  assert.deepEqual(project.config.checks, [["npm", "test"]]);
  assert.deepEqual(project.config.testDeployment.command, ["npm", "run", "deploy:test"]);
  for (const file of ["frontend/package.json", "backend/pom.xml", "scripts/deploy.mjs", "nginx.conf", "package.json"]) {
    assert.deepEqual(await fs.readFile(path.join(entry.projectDir, file)), await fs.readFile(path.join(f.root, file)));
  }
  await assert.rejects(fs.stat(path.join(entry.projectDir, ".env")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(entry.projectDir, "node_modules")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(entry.projectDir, "frontend/frontend")), { code: "ENOENT" });
  await readProjectBaseline(project);
  await assert.rejects(importProject("Duplicate", { rootDir: f.root }, { config: f.config, admin, inventoryOnly: true }), /already imported/);
});

test("root import rejects conflicting inputs and does not treat npm's placeholder as a test", async t => {
  const f = await fixture(t);
  await assert.rejects(importProject("Ambiguous", { rootDir: f.root, frontendDir: path.join(f.root, "frontend") },
    { config: f.config, admin, inventoryOnly: true }), /请选择一种/);
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', "deploy:test": "node scripts/deploy.mjs" } }));
  const entry = await importProject("Pending tests", { rootDir: f.root }, { config: f.config, admin, inventoryOnly: true, detectExecution: true });
  const project = await loadProject(entry.projectDir);
  assert.deepEqual(project.config.checks, []); assert.equal(project.config.testDeployment.kind, "unconfigured");
  assert.equal(entry.structure.hasBackend, true);
});

test("Git root import retains both modules, history, remote and common root scripts", async t => {
  const f = await fixture(t); const remote = path.join(f.temporary, "remote.git");
  git(f.temporary, "init", "--bare", remote); git(f.root, "init", "-b", "main"); git(f.root, "add", "-A");
  git(f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture baseline");
  git(f.root, "remote", "add", "origin", remote); git(f.root, "push", "origin", "main");
  const before = git(f.root, "rev-parse", "HEAD");
  const entry = await importProject("Git full stack", { rootDir: f.root }, { config: f.config, admin, inventoryOnly: true, detectExecution: true });
  const project = await loadProject(entry.projectDir);
  assert.equal(project.config.mode, "git"); assert.equal(git(project.root, "rev-parse", "HEAD"), before);
  assert.equal(git(project.root, "remote", "get-url", "origin"), remote);
  assert.equal(entry.structure.frontendDir, "frontend"); assert.equal(entry.structure.backendDir, "backend");
  assert.deepEqual(project.config.checks, [["npm", "test"]]);
  assert.equal(await fs.readFile(path.join(project.root, "nginx.conf"), "utf8"), "# Shared root configuration\n");
  assert.equal(git(f.root, "status", "--porcelain"), ""); assert.equal(git(f.root, "rev-parse", "HEAD"), before);
  await fs.writeFile(path.join(f.root, "frontend/src/main.js"), "export const value = 2;\n");
  await assert.rejects(importProject("Uncommitted", { rootDir: f.root }, { config: f.config, admin, inventoryOnly: true }), /未提交/);
  assert.match(git(f.root, "status", "--porcelain"), /frontend\/src\/main.js/);
});

test("workbench root import inherits accounts and model settings and analyzes both modules", async t => {
  const f = await fixture(t);
  f.config.maxSnapshotBytes = 1000000;
  const accountEntry = await importProject("Accounts", { rootDir: f.root }, { config: f.config, admin, inventoryOnly: true });
  const accountProject = await loadProject(accountEntry.projectDir);
  const web = await startWebServer(accountProject.root, 0);
  t.after(() => { web.server.closeAllConnections(); return new Promise(resolve => web.server.close(resolve)); });
  const login = await fetch(`${web.url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const session = await (await fetch(`${web.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  const headers = { Cookie: cookie, "Content-Type": "application/json", "X-Reqflow-Token": session.token };
  const source = path.join(f.temporary, "second-project"); await fs.cp(f.root, source, { recursive: true });
  for (const directory of ["backend/target", "frontend/dist", "backend/logs", "test-results", "backend/src/main/resources/fonts"]) await fs.mkdir(path.join(source, directory), { recursive: true });
  await fs.writeFile(path.join(source, "backend/src/main/resources/fonts/font.ttf"), Buffer.alloc(2 * 1024 * 1024, 1));
  await fs.mkdir(path.join(source, "frontend/src/fixtures"));
  await fs.writeFile(path.join(source, "frontend/src/fixtures/example.log"), "A source test fixture, not a runtime log.\n");
  for (const file of ["backend/target/large.bin", "frontend/dist/bundle.js", "backend/logs/run.log", "test-results/image.png", "frontend/.frontend.log"]) {
    await fs.writeFile(path.join(source, file), Buffer.alloc(2 * 1024 * 1024, 2));
  }
  const analysis = await fetch(`${web.url}/api/projects/analyze`, { method: "POST", headers, body: JSON.stringify({ rootDir: source }) });
  assert.equal(analysis.status, 200); const detected = await analysis.json();
  assert.equal(detected.hasFrontend, true); assert.equal(detected.hasBackend, true);
  const response = await fetch(`${web.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Root via API", rootDir: source, options: { inventoryOnly: true } }) });
  assert.equal(response.status, 201, await response.clone().text());
  const entry = await response.json(); const target = await loadProject(entry.projectDir);
  assert.equal(target.accountsArchive, accountProject.accountsArchive);
  assert.equal(target.config.provider, "fake"); assert.equal(target.config.model, "fake");
  assert.equal(target.config.maxSnapshotBytes, 100 * 1024 * 1024);
  assert.equal((await fs.stat(path.join(target.root, "backend/src/main/resources/fonts/font.ttf"))).size, 2 * 1024 * 1024);
  assert.match(await fs.readFile(path.join(target.root, "frontend/src/fixtures/example.log"), "utf8"), /source test fixture/);
  for (const generated of ["backend/target", "frontend/dist", "backend/logs", "test-results", "frontend/.frontend.log"]) {
    assert.ok(target.config.excludedPaths.includes(generated));
    await assert.rejects(fs.stat(path.join(target.root, generated)), { code: "ENOENT" });
  }
  assert.deepEqual(target.config.checks, [["npm", "test"]]);
  assert.equal(entry.structure.backendDir, "backend");
  assert.equal(await fs.readFile(path.join(target.root, "nginx.conf"), "utf8"), "# Shared root configuration\n");
  const explicitSource = path.join(f.temporary, "explicit-source"); await fs.cp(source, explicitSource, { recursive: true });
  const explicit = await fetch(`${web.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Explicit small limit", rootDir: explicitSource,
    options: { inventoryOnly: true, config: { ...f.config, maxSnapshotBytes: 1000000 } } }) });
  assert.equal(explicit.status, 400);
  const error = await explicit.json();
  assert.match(error.error, /快照超过上限 1\.0 MB/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readProjectBaseline } from "../src/baseline.js";
import { loadProject } from "../src/config.js";
import { initialize } from "../src/store.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function baselineCli(root, command, ...args) {
  return spawnSync(process.execPath, [path.join(repository, "src/cli.js"), command, "--project", root, ...args],
    { encoding: "utf8" });
}

test("initialization inventories architecture evidence and refreshes a stale source baseline", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-baseline-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await fs.mkdir(path.join(root, "src", "client"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "server", "routes"), { recursive: true });
  await fs.mkdir(path.join(root, "prisma"));
  await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "mixed-app",
    scripts: { test: "node --test" }, dependencies: {
      react: "^19.0.0", express: "^5.0.0", "@prisma/client": "^6.0.0", redis: "^5.0.0",
    } }));
  await fs.writeFile(path.join(root, "src/client/App.tsx"), "export default function App() {}\n");
  await fs.writeFile(path.join(root, "src/server/routes/users.ts"), "router.get('/users', handler);\n");
  await fs.writeFile(path.join(root, "prisma/schema.prisma"), "model User { id Int @id }\n");
  await fs.writeFile(path.join(root, "test/users.test.mjs"), "// placeholder\n");
  await fs.writeFile(path.join(root, "src/server/main.mjs"), "import { createServer } from 'node:http';\nimport './routes/users.ts';\nexport function listUsers() {}\nif (req.method === 'GET' && pathname === '/health') {}\nconst port = process.env.APP_PORT;\n");
  await fs.writeFile(path.join(root, "test/compatibility.test.mjs"), "test('existing users response remains compatible', () => {});\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=must-not-be-indexed\n");
  await fs.writeFile(path.join(root, "README.md"), "# 用户服务\n\n管理用户资料与访问权限。\n\n## 开发\n");
  await fs.mkdir(path.join(root, "src/vendor/.reqflow-workspaces/stale"), { recursive: true });
  await fs.writeFile(path.join(root, "src/vendor/.reqflow-workspaces/stale/copied.js"), "export function obsoleteCopy() {}\n");
  const configFile = path.join(temporary, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 2, mode: "local",
    piExecutable: path.join(repository, "test/fake-pi.mjs"), provider: "fake", model: "fake-model",
    environment: { pi: [], checks: [], localDeployment: [] },
    allowedPaths: ["src", "test"], excludedPaths: [".env"], maxSnapshotBytes: 1000000,
    maxPiMs: 30000, maxToolCalls: 20, maxEventBytes: 1000000, maxCostUsd: 2,
    checks: [[process.execPath, "--version"]], testDeployment: { kind: "local", command: [process.execPath, "--version"] },
    productionDeployment: { kind: "none" } }));
  const packageFile = path.join(root, "package.json");
  const packageText = await fs.readFile(packageFile, "utf8");
  await fs.writeFile(packageFile, "{invalid json");
  await assert.rejects(initialize(root, configFile), /JSON|Expected property name/);
  await assert.rejects(fs.stat(path.join(root, ".reqflow")), { code: "ENOENT" });
  await fs.writeFile(packageFile, packageText);
  const initialized = await initialize(root, configFile);
  const cliRoot = path.join(temporary, "cli-project");
  await fs.mkdir(cliRoot);
  const cliInit = baselineCli(cliRoot, "init", "--config", configFile);
  assert.equal(cliInit.status, 0, cliInit.stderr);
  assert.ok(JSON.parse(cliInit.stdout).baseline.snapshotHash);
  assert.equal(await fs.readFile(path.join(root, "src/server/routes/users.ts"), "utf8"),
    "router.get('/users', handler);\n");
  const project = await loadProject(root);
  const baseline = await readProjectBaseline(project);
  assert.equal(initialized.baseline.snapshotHash, baseline.snapshotHash);
  for (const [kind, name] of [["frontend", "react"], ["backend", "express"],
    ["database", "@prisma/client"], ["middleware", "redis"]]) {
    assert.ok(baseline.components[kind].some((entry) => entry.name === name));
  }
  assert.ok(baseline.paths.interfaces.includes("src/server/routes/users.ts"));
  assert.ok(baseline.paths.database.includes("prisma/schema.prisma"));
  assert.ok(baseline.paths.tests.includes("test/users.test.mjs"));
  assert.deepEqual(baseline.declarations.apiRoutes.find((row) => row.route === "/users"), { method: "GET", route: "/users",
    evidence: "src/server/routes/users.ts:1" });
  assert.deepEqual(baseline.declarations.dataModels[0], { name: "User", kind: "prisma-model",
    evidence: "prisma/schema.prisma:1" });
  assert.equal(Object.hasOwn(baseline.files, ".env"), false);
  const report = await fs.readFile(path.join(project.archive, "baseline.md"), "utf8");
  const declarations = JSON.stringify(baseline.declarations);
  assert.match(declarations, /existing users response remains compatible/);
  assert.match(declarations, /listUsers/);
  assert.match(report, /GET \/health/);
  assert.match(declarations, /APP_PORT/);
  assert.match(report, /node:http/);
  assert.match(declarations, /src\/server\/main.mjs:3/);
  assert.match(report, /不证明代码实际调用/);
  assert.doesNotMatch(report, /must-not-be-indexed/);
  assert.match(JSON.stringify(baseline.overviewEvidence), /管理用户资料与访问权限/);
  assert.match(JSON.stringify(baseline.overviewEvidence), /README.md:3/);
  assert.doesNotMatch(report, /obsoleteCopy/);
  assert.equal(Object.keys(baseline.files).some((file) => file.includes(".reqflow-workspaces")), false);
  const documentResult = baselineCli(root, "project-document");
  assert.equal(documentResult.status, 0, documentResult.stderr);
  const developerGuide = await fs.readFile(JSON.parse(documentResult.stdout).reportFile, "utf8");
  assert.match(developerGuide, /项目开发指南/);
  assert.doesNotMatch(developerGuide, /负责人待确认/);
  assert.ok(await fs.stat(JSON.parse(documentResult.stdout).agentFile));
  assert.equal(await fs.readFile(JSON.parse(documentResult.stdout).claudeFile, "utf8"), "@AGENTS.md\n");
  assert.match(await fs.readFile(path.join(project.archive, "baseline.md"), "utf8"), /数据库与数据层/);
  assert.equal(baselineCli(root, "baseline-status").status, 0);

  await fs.writeFile(path.join(root, "src/server/routes/orders.ts"), "export const orders = [];\n");
  assert.match(baselineCli(root, "baseline-status").stderr, /baseline-refresh/);
  const refresh = baselineCli(root, "baseline-refresh");
  assert.equal(refresh.status, 0, refresh.stderr);
  const updated = await readProjectBaseline(project);
  assert.notEqual(updated.snapshotHash, baseline.snapshotHash);
  assert.ok(updated.paths.interfaces.includes("src/server/routes/orders.ts"));
  assert.equal(baselineCli(root, "baseline-status").status, 0);
  assert.ok(await fs.stat(path.join(project.archive, "baselines", `${baseline.snapshotHash}.json`)));
  const auditRows = (await fs.readFile(path.join(project.archive, "baseline-events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(auditRows.length, 2);
  assert.equal(auditRows[1].previous, auditRows[0].hash);

  const savedConfig = path.join(project.archive, "config.json");
  const originalConfig = await fs.readFile(savedConfig, "utf8");
  const changedConfig = JSON.parse(originalConfig);
  changedConfig.allowedPaths = ["src/client", "test"];
  await fs.writeFile(savedConfig, JSON.stringify(changedConfig));
  assert.match(baselineCli(root, "baseline-status").stderr, /configuration changed/);
  await fs.writeFile(savedConfig, originalConfig);

  const reportFile = path.join(project.archive, "baseline.md");
  await fs.appendFile(reportFile, "\nTampered report\n");
  assert.match(baselineCli(root, "baseline-status").stderr, /baseline report changed/);
  assert.equal(baselineCli(root, "baseline-refresh").status, 0);
  assert.equal(baselineCli(root, "baseline-status").status, 0);

  const archivedCurrent = path.join(project.archive, "baselines", `${updated.snapshotHash}.json`);
  const archivedText = await fs.readFile(archivedCurrent, "utf8");
  const alteredArchive = JSON.parse(archivedText);
  alteredArchive.sourceFileCount += 1;
  await fs.writeFile(archivedCurrent, JSON.stringify(alteredArchive));
  await assert.rejects(readProjectBaseline(project), /Archived project baseline differs/);
  await fs.writeFile(archivedCurrent, archivedText);

  const currentFile = path.join(project.archive, "baseline.json");
  const changed = JSON.parse(await fs.readFile(currentFile, "utf8"));
  changed.components.backend = [];
  await fs.writeFile(currentFile, JSON.stringify(changed));
  await assert.rejects(readProjectBaseline(project), /baseline is invalid or changed/);
  assert.match(baselineCli(root, "baseline-refresh").stderr, /baseline is invalid or changed/);
});

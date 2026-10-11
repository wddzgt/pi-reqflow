import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureLocalEnvironment, readLocalEnvironment, inspectLocalEnvironment, checkLocalEnvironment } from "../src/local-environment.js";
import { canConfigureEnvironment } from "../src/auth.js";
import { scanLocalEnvironment } from "../src/environment-scan.js";

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-environment-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "source"); const archive = path.join(root, ".reqflow");
  await fs.mkdir(path.join(archive, "tasks/1"), { recursive: true });
  await fs.writeFile(path.join(archive, "index.json"), JSON.stringify([{ id: "1", state: "verified" }]));
  return { temporary, project: { root, archive, config: { excludedPaths: [], maxSnapshotBytes: 1048576, environment: { localDeployment: ["DATABASE_PASSWORD"] } } } };
}

test("local configuration keeps values private and fences concurrent edits with a verified audit chain", async t => {
  const { temporary, project } = await fixture(t);
  const environmentFile = path.join(temporary, "private.env");
  await fs.writeFile(environmentFile, "DATABASE_PASSWORD=secret-only-for-child\n");
  const scan = await scanLocalEnvironment(project);
  const input = { expectedRevision: null, expectedScanHash: scan.hash, environmentFile, target: "all", decisions: {}, values: {} };
  const saved = await configureLocalEnvironment(project, "dev", input);
  assert.equal(saved.version, 1); assert.equal(saved.history[0].actor, "dev");
  assert.deepEqual(saved.history[0].affectedRequirements, ["1"]);
  const inspected = await inspectLocalEnvironment(project);
  assert.deepEqual(inspected.environments["app:."], { DATABASE_PASSWORD: "secret-only-for-child" });
  assert.equal(inspected.report.status, "ready");
  assert.doesNotMatch(JSON.stringify(saved) + JSON.stringify(inspected.report), /secret-only-for-child|never-inject/);
  await assert.rejects(configureLocalEnvironment(project, "admin", input), /配置已改变/);
  await fs.writeFile(environmentFile, "IGNORED_SECRET=still-private\n");
  assert.equal((await checkLocalEnvironment(project, "dev")).status, "ready");
  await assert.rejects(configureLocalEnvironment(project, "dev", { ...input, expectedRevision: saved.revision }), /未扫描的变量/);
  assert.equal(saved.secretConfigured["app:./DATABASE_PASSWORD"], true);
  const privateFile = path.join(project.archive, "local-environment-values", `${saved.settings.valueFile}.json`);
  assert.equal((await fs.stat(privateFile)).mode & 0o777, 0o600);
  const auditFile = path.join(project.archive, "local-environment-events.jsonl");
  const audit = await fs.readFile(auditFile, "utf8");
  assert.doesNotMatch(audit, /secret-only-for-child|never-inject/);
  await fs.writeFile(auditFile, audit.replace('"actor":"dev"', '"actor":"tampered"'));
  await assert.rejects(readLocalEnvironment(project), /审计记录已改变/);
});

test("shared configuration refuses unsafe files, reserved variables and changes during task execution", async t => {
  const { project } = await fixture(t);
  const scan = await scanLocalEnvironment(project);
  const input = { expectedRevision: null, expectedScanHash: scan.hash, environmentFile: "", target: "all", decisions: {}, values: {} };
  await fs.writeFile(path.join(project.root, ".env"), "PASSWORD=private\n");
  await assert.rejects(configureLocalEnvironment(project, "dev", { ...input, environmentFile: path.join(project.root, ".env") }), /项目目录外/);
  await assert.rejects(configureLocalEnvironment(project, "dev", { ...input, values: { "app:./UNKNOWN": "x" } }), /配置项/);
  project.config.environment.localDeployment = ["NODE_OPTIONS"];
  const reservedScan = await scanLocalEnvironment(project);
  await assert.rejects(configureLocalEnvironment(project, "dev", { ...input, expectedScanHash: reservedScan.hash }), /reserved/);
  project.config.environment.localDeployment = ["DATABASE_PASSWORD"];
  await fs.writeFile(path.join(project.archive, "tasks/1/task.lock"), "{}");
  await assert.rejects(configureLocalEnvironment(project, "dev", input), /正在执行/);
  assert.equal((await readLocalEnvironment(project)).configured, false);
});

test("environment permission requires accepted development participation in the selected project", () => {
  const principal = { id: "dev", roles: ["developer"] };
  assert.equal(canConfigureEnvironment(principal, []), false);
  for (const status of ["pending", "declined"]) assert.equal(canConfigureEnvironment(principal,
    [{ assignments: { developer: { userId: "dev", status } } }]), false);
  assert.equal(canConfigureEnvironment(principal, [{ assignments: { developer: { userId: "other", status: "accepted" } } }]), false);
  assert.equal(canConfigureEnvironment(principal, [{ assignments: { developer: { userId: "dev", status: "accepted" } } }]), true);
  assert.equal(canConfigureEnvironment({ id: "admin", roles: ["admin"] }, []), true);
  assert.equal(canConfigureEnvironment({ id: "dev", roles: ["product"] }, [{ assignments: { developer: { userId: "dev", status: "accepted" } } }]), false);
});

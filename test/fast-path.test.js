import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeRequirementAction } from "../src/core.js";
import { addCredential, authenticate } from "../src/auth.js";
import { assignMember, respondToAssignment } from "../src/assignment.js";
import { loadProject } from "../src/config.js";
import { confirmContract, recordDevFeedback } from "../src/intake.js";
import { createTask, initialize, readTask } from "../src/store.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fixture(t, objective = "Add multiplication",
  inScope = ["src/calculator.mjs", "test/calculator.test.mjs"], overrides = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-fast-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  await fs.cp(path.join(repository, "examples/demo-app/src"), path.join(root, "src"), { recursive: true });
  await fs.cp(path.join(repository, "examples/demo-app/test"), path.join(root, "test"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "node src/calculator.mjs" } }));
  const configFile = path.join(temporary, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 2, mode: "local",
    piExecutable: path.join(repository, "test/fake-pi.mjs"), provider: "fake", model: "fake-model",
    environment: { pi: [], checks: [], localDeployment: [] },
    allowedPaths: ["src", "test"], excludedPaths: [".env"], maxSnapshotBytes: 1000000,
    maxPiMs: 30000, maxToolCalls: 20, maxEventBytes: 1000000, maxCostUsd: 2,
    planReview: "full", // Explicit specialist-review coverage; default routing is tested in workflow.test.js.
    fastPath: { enabled: true, maxFiles: 2, maxAcceptance: 2, maxChangedBytes: 10000,
      allowedPaths: ["src", "test"] },
    checks: [[process.execPath, "--test", "test/calculator.test.mjs"]],
    testDeployment: { kind: "local", command: [process.execPath, "--test", "test/calculator.test.mjs"] },
    productionDeployment: { kind: "none" }, ...overrides }));
  await initialize(root, configFile);
  const project = await loadProject(root);
  await createTask(project, "REQ-FAST", "Refine addition", objective, "product");
  await addCredential(project, "reviewer", ["developer"], { username: "reviewer", password: "password123456", token: "reviewer-token-0123456789-abcdefghijklmn" });
  await assignMember(root, "REQ-FAST", "product", "developer", "reviewer");
  await respondToAssignment(root, "REQ-FAST", "reviewer", "developer", true);
  await recordDevFeedback(root, "REQ-FAST", "reviewer", {
    summary: "Refine addition without changing function signature", questions: [], requiredRoles: ["backend", "qa"],
  });
  await confirmContract(root, "REQ-FAST", "product", {
    objective, currentBehavior: "Calculator adds numbers",
    desiredBehavior: objective === "Document addition" ? "Document add without changing its behavior" : "Support multiplication; existing addition stays correct",
    acceptance: [{ id: "AC1", text: objective === "Document addition" ? "add has an explanatory comment and add(2, 3) is still 5" : "multiply(2, 3) is 6 and add(2, 3) is 5" }],
    inScope, outOfScope: [], answers: {},
  });
  const reviewer = await authenticate(project, "reviewer-token-0123456789-abcdefghijklmn");
  return { root, project, reviewer };
}

test("fast path waits for human plan confirmation then pauses for the developer's validation choice", async (t) => {
  const { root, project, reviewer } = await fixture(t);
  await assert.rejects(executeRequirementAction(root, "REQ-FAST", { action: "fast-track" },
    { id: "product", roles: ["product"] }), /Role cannot perform/);
  const result = await executeRequirementAction(root, "REQ-FAST", { action: "fast-track" }, reviewer);
  assert.equal(result.state, "plan_review");
  assert.equal(result.next, "approve-plan");
  assert.equal((await readTask(project, "REQ-FAST")).meta.workspace, undefined);
  await executeRequirementAction(root, "REQ-FAST", { action: "approve-plan" }, reviewer);
  const verified = await executeRequirementAction(root, "REQ-FAST", { action: "fast-track" }, reviewer);
  assert.equal(verified.state, "verified");
  assert.equal(verified.next, "choose-validation");
  assert.equal((await readTask(project, "REQ-FAST")).meta.testDeployment, undefined);
  await addCredential(project, "other-dev", ["developer"], { username: "other-dev", password: "password123456", token: "other-dev-token-0123456789-abcdefghijklmn" });
  const otherDev = await authenticate(project, "other-dev-token-0123456789-abcdefghijklmn");
  await assert.rejects(executeRequirementAction(root, "REQ-FAST", { action: "approve-changes",
    evidence: "I approve." }, otherDev), /not assigned to perform/);
  await executeRequirementAction(root, "REQ-FAST", { action: "deploy-test" }, reviewer);
  const deployed = await executeRequirementAction(root, "REQ-FAST", { action: "fast-track" }, reviewer);
  assert.equal(deployed.state, "test_deployed");
  assert.equal(deployed.next, "human-test-acceptance");
  const task = await readTask(project, "REQ-FAST");
  assert.equal(task.meta.planApprovedBy, "reviewer");
  assert.equal(task.meta.changeApproval, undefined);
  assert.equal(task.events.find((event) => event.type === "plan_approved").detail.approvalKind, "human");
  assert.equal(task.events.filter((event) => event.type === "plan_draft_completed").length, 1);
  assert.deepEqual(task.events.filter((event) => event.type === "plan_specialist_completed").map(event => event.detail.role), ["all"]);
  const specialist = task.events.find(event => event.type === "plan_specialist_completed").detail.findings;
  assert.equal(specialist.contractHash, task.meta.contractHash);
  assert.equal(specialist.analysisHash, task.events.find(event => event.type === "plan_draft_completed").detail.analysisHash);
  assert.equal(specialist.role, "all");
  assert.match(await fs.readFile(path.join(task.meta.workspace, "test/calculator.test.mjs"), "utf8"),
    /multiply returns the product/);
  assert.equal((await executeRequirementAction(root, "REQ-FAST", { action: "fast-track" }, reviewer)).state,
    "test_deployed");
});

test("fast path rolls back edits outside the confirmed file list", async (t) => {
  const { root, project, reviewer } = await fixture(t, "Add multiplication Out-of-scope probe");
  await executeRequirementAction(root, "REQ-FAST", { action: "fast-track" }, reviewer);
  await assert.rejects(executeRequirementAction(root, "REQ-FAST", { action: "approve-plan" }, reviewer),
    /Changes exceed approved scope/);
  const task = await readTask(project, "REQ-FAST");
  assert.equal(task.meta.state, "rolled_back");
  assert.ok(task.events.some((event) => event.type === "implementation_failed" && event.detail.violations.includes("file outside approved plan: src/rogue.mjs")));
  await assert.rejects(fs.stat(path.join(task.meta.workspace, "src/rogue.mjs")), { code: "ENOENT" });
  assert.doesNotMatch(await fs.readFile(path.join(task.meta.workspace, "src/calculator.mjs"), "utf8"), /Number\(left\)/);
});

test("fast path verifies a comment-only change with existing unchanged regression tests", async (t) => {
  const { root, project, reviewer } = await fixture(t, "Document addition", ["src/calculator.mjs"]);
  const originalTest = await fs.readFile(path.join(root, "test/calculator.test.mjs"));
  assert.equal((await executeRequirementAction(root, "REQ-FAST", { action: "fast-track" }, reviewer)).next, "approve-plan");
  await executeRequirementAction(root, "REQ-FAST", { action: "approve-plan" }, reviewer);
  const result = await executeRequirementAction(root, "REQ-FAST", { action: "fast-track" }, reviewer);
  assert.equal(result.state, "verified");
  assert.equal(result.next, "choose-validation");
  const task = await readTask(project, "REQ-FAST");
  assert.equal(task.meta.state, "verified");
  assert.deepEqual(await fs.readFile(path.join(task.meta.workspace, "test/calculator.test.mjs")), originalTest);
  assert.match(await fs.readFile(path.join(task.meta.workspace, "src/calculator.mjs"), "utf8"), /Add two values/);
  assert.deepEqual(task.events.find(event => event.type === "implemented").detail.changes.map(row => row.file), ["src/calculator.mjs"]);
  assert.equal(task.events.filter((event) => event.type === "role_review_submitted").length, 0);
  await assert.rejects(executeRequirementAction(root, "REQ-FAST", { action: "accept-test",
    evidence: "未设置本地验证环境" }, reviewer), /本地测试设置/);
});

test("historical behavior changes leave the fast path for responsible human review", async (t) => {
  const { root, project, reviewer } = await fixture(t, "Refine addition");
  await assert.rejects(executeRequirementAction(root, "REQ-FAST", { action: "fast-track" }, reviewer), /no historical behavior/);
  const task = await readTask(project, "REQ-FAST");
  assert.equal(task.meta.state, "plan_review");
  assert.deepEqual(task.events.filter((event) => event.type === "plan_specialist_completed").map((event) => event.detail.role), ["all"]);
  assert.equal(task.meta.workspace, undefined);
  assert.equal((await executeRequirementAction(root, "REQ-FAST", { action: "approve-plan" }, reviewer)).state, "verified");
  assert.equal((await readTask(project, "REQ-FAST")).meta.planApprovedBy, "reviewer");
});

test("directory projects without a fixed environment can develop and request local verification", async (t) => {
  const { root, project, reviewer } = await fixture(t, "Add multiplication", undefined,
    { testDeployment: { kind: "unconfigured" } });
  await executeRequirementAction(root, "REQ-FAST", { action: "develop", authorizeImplementation: true }, reviewer);
  const result = await executeRequirementAction(root, "REQ-FAST", { action: "approve-plan" }, reviewer);
  assert.equal(result.state, "verified");
  assert.equal(result.next, "choose-validation");
  assert.equal(result.testDeploymentAvailable, false);
  const task = await readTask(project, "REQ-FAST");
  const local = await executeRequirementAction(root, "REQ-FAST", { action: "local-validation",
    expectedAfterHash: task.meta.afterHash, expectedPlanHash: task.meta.planHash }, reviewer);
  assert.equal(local.patch, null);
  assert.equal(local.workspace, task.meta.workspace);
  assert.equal(local.baseHash, task.meta.baseHash);
  assert.equal(local.status, "not_applicable");
  const environment = local.environment;
  const input = { action: "local-validation", expectedAfterHash: task.meta.afterHash, expectedPlanHash: task.meta.planHash };
  const policyBefore = await fs.readFile(path.join(project.archive, "config.json"), "utf8");
  const configured = await executeRequirementAction(root, "REQ-FAST", input, reviewer);
  assert.deepEqual(configured.environment, environment);
  assert.equal(await fs.readFile(path.join(project.archive, "config.json"), "utf8"), policyBefore);
  await assert.rejects(executeRequirementAction(root, "REQ-FAST", { ...input, environment },
    { id: "product", roles: ["product"] }), /Role cannot perform/);
  await assert.rejects(executeRequirementAction(root, "REQ-FAST", { ...input,
    environment: { instructions: "", url: "javascript:alert(1)" } }, reviewer), /不接受手填/);
  assert.deepEqual((await executeRequirementAction(root, "REQ-FAST", input, reviewer)).environment, environment);
  await executeRequirementAction(root, "REQ-FAST", { ...input, action: "recheck-local" }, reviewer);
  assert.equal((await readTask(project, "REQ-FAST")).meta.localValidation, null);
  await executeRequirementAction(root, "REQ-FAST", input, reviewer);
  await assert.rejects(executeRequirementAction(root, "REQ-FAST", { action: "deploy-test" }, reviewer), /尚未连接固定测试环境/);
  const current = await readTask(project, "REQ-FAST");
  assert.equal(current.meta.state, "verified");
  assert.equal(current.meta.testDeployment, undefined);
  assert.equal(current.meta.acceptedBy, undefined);
  assert.equal(current.events.at(-1).type, "local_validation_requested");
  assert.equal(current.events.at(-1).detail.actor, "reviewer");
  const archived = await executeRequirementAction(root, "REQ-FAST", { action: "accept-test",
    evidence: "已查看代码差异，本地验证乘法与原加法结果正确。" }, reviewer);
  assert.equal(archived.state, "archived_test_only");
  assert.equal(archived.acceptanceMode, "local");
  assert.equal(archived.changeApproval.actor, "reviewer");
  assert.equal(archived.testDeployment, undefined);
});

test("no automated checks leaves manual acceptance pending without blocking implementation", async (t) => {
  const { root, project, reviewer } = await fixture(t, "Add multiplication", undefined,
    { checks: [], testDeployment: { kind: "unconfigured" } });
  await executeRequirementAction(root, "REQ-FAST", { action: "plan" }, reviewer);
  await executeRequirementAction(root, "REQ-FAST", { action: "approve-plan" }, reviewer);
  const task = await readTask(project, "REQ-FAST");
  assert.equal(task.meta.state, "verified");
  assert.equal(task.meta.verificationMode, "manual_pending");
  assert.deepEqual(task.meta.checks, []);
});

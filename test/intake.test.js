import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addCredential, authenticate, authorize, authorizeTaskAction, canReadTask } from "../src/auth.js";
import { assignMember, respondToAssignment } from "../src/assignment.js";
import { loadProject } from "../src/config.js";
import { refreshProjectBaseline } from "../src/baseline.js";
import { executeRequirementAction, getAuditReport, getTaskObservability } from "../src/core.js";
import { confirmContract, finalizeRoleReview, recordDevFeedback, reviseContract,
  runRoleReviewWithPi, submitRoleReview } from "../src/intake.js";
import { createTask, initialize, readTask } from "../src/store.js";
import { plan } from "../src/workflow.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fixture(t, assigned = true, maxCostUsd = 2) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-intake-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  await fs.cp(path.join(repository, "examples/demo-app/src"), path.join(root, "src"), { recursive: true });
  await fs.cp(path.join(repository, "examples/demo-app/test"), path.join(root, "test"), { recursive: true });
  const configFile = path.join(temporary, "config.json");
  await fs.writeFile(configFile, JSON.stringify({
    schemaVersion: 2, mode: "local", piExecutable: path.join(repository, "test/fake-pi.mjs"),
    provider: "fake", model: "fake-model", allowedPaths: ["src", "test"], excludedPaths: [".env"],
    environment: { pi: [], checks: [], localDeployment: [] },
    maxSnapshotBytes: 1000000, maxPiMs: 30000, maxToolCalls: 20, maxEventBytes: 1000000, maxCostUsd,
    checks: [[process.execPath, "--test", "test/calculator.test.mjs"]],
    testDeployment: { kind: "local", command: [process.execPath, "--test", "test/calculator.test.mjs"] },
    productionDeployment: { kind: "none" },
  }));
  await initialize(root, configFile);
  const project = await loadProject(root);
  await createTask(project, "REQ-001", "Multiply", "Support multiplication", "product");
  if (assigned) {
    await addCredential(project, "reviewer", ["developer"], { username: "reviewer", password: "password123456", token: "reviewer-token-0123456789-abcdefghijklmn" });
    await assignMember(root, "REQ-001", "product", "developer", "reviewer");
    await respondToAssignment(root, "REQ-001", "reviewer", "developer", true);
  }
  return { root, project };
}

function review(role, contractHash, interfaceDecision = "multiply returns the product") {
  return { role, contractHash, coveredAcceptanceIds: ["AC1"],
    judgments: { objective: "agree", desiredBehavior: "agree", scope: "agree", acceptance: "agree" },
    interfaceDecisions: { calculator: interfaceDecision }, blockers: [], evidence: `${role} independently checked the contract`,
    ...(role === "qa" ? { testScenarios: [{ acceptanceId: "AC1", scenario: "Verify multiply and existing add" }] } : {}),
  };
}

const contract = { objective: "Support multiplication", currentBehavior: "Calculator adds numbers",
  desiredBehavior: "Multiply two numbers while keeping add unchanged",
  acceptance: [{ id: "AC1", text: "multiply(2, 3) is 6 and add(2, 3) is 5" }],
  inScope: ["src/calculator.mjs", "test/calculator.test.mjs"], outOfScope: [], answers: { Q1: "No UI changes" } };

test("registered developer must accept a task before development feedback", async (t) => {
  const { root, project } = await fixture(t, false);
  const feedback = { summary: "Review multiplication", questions: [], requiredRoles: ["backend", "qa"] };
  await assert.rejects(recordDevFeedback(root, "REQ-001", "reviewer", feedback), /expected intake_assigned/);
  await addCredential(project, "reviewer", ["developer"], { username: "reviewer", password: "password123456", token: "reviewer-token-0123456789-abcdefghijklmn" });
  await addCredential(project, "other-reviewer", ["developer"], { username: "other-reviewer", password: "password123456", token: "other-reviewer-token-0123456789-abcdefghij" });
  await assert.rejects(assignMember(root, "REQ-001", "product", "developer", "unknown"), /Registered member/);
  await assignMember(root, "REQ-001", "product", "developer", "reviewer");
  const pending = (await readTask(project, "REQ-001")).meta;
  assert.equal(pending.state, "assignment_pending");
  assert.equal(canReadTask({ id: "reviewer", roles: ["developer"] }, pending), true);
  assert.equal(canReadTask({ id: "other-reviewer", roles: ["developer"] }, pending), false);
  assert.throws(() => authorizeTaskAction({ id: "reviewer", roles: ["developer"] }, "dev-feedback", pending),
    /not assigned to perform/);
  await assert.rejects(respondToAssignment(root, "REQ-001", "other-reviewer", "developer", true), /No pending assignment/);
  await respondToAssignment(root, "REQ-001", "reviewer", "developer", false);
  await assignMember(root, "REQ-001", "product", "developer", "other-reviewer");
  await respondToAssignment(root, "REQ-001", "other-reviewer", "developer", true);
  assert.equal((await recordDevFeedback(root, "REQ-001", "other-reviewer", feedback)).state, "intake_feedback");
});

test("archived original request is bound to the audit chain", async (t) => {
  const { project } = await fixture(t, false);
  const file = path.join(project.archive, "tasks", "REQ-001", "request.md");
  await fs.writeFile(file, "Silently changed request");
  await assert.rejects(readTask(project, "REQ-001"), /Original request changed/);
});

test("product confirmation gates planning and optional role review retains its evidence", async (t) => {
  const { root, project } = await fixture(t);
  await assert.rejects(plan(root, "REQ-001"), /expected a frozen requirement/);
  await recordDevFeedback(root, "REQ-001", "reviewer", { summary: "Keep addition unchanged",
    questions: [{ id: "Q1", text: "Does the UI need a new control?" }], requiredRoles: ["backend", "qa"] });
  await assert.rejects(confirmContract(root, "REQ-001", "another-product", contract), /Only the product owner/);
  await assert.rejects(confirmContract(root, "REQ-001", "product", { ...contract, answers: {} }), /answer to Q1/);
  const confirmed = await confirmContract(root, "REQ-001", "product", contract);
  await assert.rejects(submitRoleReview(root, "REQ-001", "backend", review("backend", "wrong-hash")), /different contract version/);
  await submitRoleReview(root, "REQ-001", "backend", review("backend", confirmed.contractHash));
  await assert.rejects(finalizeRoleReview(root, "REQ-001", "reviewer"), /Missing role reviews: qa/);
  await submitRoleReview(root, "REQ-001", "qa", review("qa", confirmed.contractHash, "multiply also changes add"));
  await assert.rejects(finalizeRoleReview(root, "REQ-001", "reviewer"), /interface decisions differ/);
  assert.equal((await readTask(project, "REQ-001")).meta.state, "role_review");
  await assert.rejects(plan(root, "REQ-001"), /optional role reviews must be resolved/);
});

test("product contract revision invalidates divergent role reviews", async (t) => {
  const { root, project } = await fixture(t);
  await recordDevFeedback(root, "REQ-001", "reviewer", { summary: "Clarify multiplication",
    questions: [], requiredRoles: ["backend", "qa"] });
  const first = await confirmContract(root, "REQ-001", "product", { ...contract, answers: {} });
  await submitRoleReview(root, "REQ-001", "backend", review("backend", first.contractHash));
  await submitRoleReview(root, "REQ-001", "qa", review("qa", first.contractHash, "addition changes"));
  await assert.rejects(finalizeRoleReview(root, "REQ-001", "reviewer"), /interface decisions differ/);
  await assert.rejects(reviseContract(root, "REQ-001", "other-product", contract), /Only the product owner/);
  const revised = await reviseContract(root, "REQ-001", "product", { ...contract,
    desiredBehavior: "Multiply numbers and preserve the existing addition behavior", answers: {} });
  assert.equal(revised.contractVersion, 2);
  assert.equal(revised.state, "contract_confirmed");
  assert.deepEqual(revised.reviewHashes, {});
  assert.notEqual(revised.contractHash, first.contractHash);
  await runRoleReviewWithPi(root, "REQ-001", "backend", "reviewer");
  await runRoleReviewWithPi(root, "REQ-001", "qa", "reviewer");
  assert.equal((await finalizeRoleReview(root, "REQ-001", "reviewer")).state, "review_passed");
  assert.ok((await readTask(project, "REQ-001")).events.some((event) => event.type === "role_review_blocked"));
});

test("approved contract is hashed and changes block planning", async (t) => {
  const { root, project } = await fixture(t);
  await recordDevFeedback(root, "REQ-001", "reviewer", { summary: "Backend and QA review needed",
    questions: [], requiredRoles: ["backend", "qa"] });
  const confirmed = await confirmContract(root, "REQ-001", "product", { ...contract, answers: {} });
  await submitRoleReview(root, "REQ-001", "backend", review("backend", confirmed.contractHash));
  await submitRoleReview(root, "REQ-001", "qa", review("qa", confirmed.contractHash));
  assert.equal((await finalizeRoleReview(root, "REQ-001", "reviewer")).state, "review_passed");
  const file = path.join(project.archive, "tasks", "REQ-001", "contract-v1.json");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, original.replace("Support multiplication", "Change addition"));
  await assert.rejects(plan(root, "REQ-001"), /Confirmed contract changed/);
  await fs.writeFile(file, original);
  assert.equal((await plan(root, "REQ-001")).state, "plan_review");
});

test("Pi roles independently review one contract before planning", async (t) => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(project.archive, "config.json"), JSON.stringify({ ...project.config,
    agentModels: { backendReview: { provider: "review-provider", model: "backend-large" },
      qaReview: { provider: "qa-provider", model: "qa-medium" } } }));
  await refreshProjectBaseline(await loadProject(root));
  await recordDevFeedback(root, "REQ-001", "reviewer", { summary: "Check implementation and regression",
    questions: [], requiredRoles: ["backend", "qa"] });
  const confirmed = await confirmContract(root, "REQ-001", "product", { ...contract, answers: {} });
  await runRoleReviewWithPi(root, "REQ-001", "backend", "reviewer");
  await assert.rejects(finalizeRoleReview(root, "REQ-001", "reviewer"), /Missing role reviews: qa/);
  await runRoleReviewWithPi(root, "REQ-001", "qa", "reviewer");
  const directory = path.join(project.archive, "tasks", "REQ-001");
  for (const role of ["backend", "qa"]) {
    const saved = JSON.parse(await fs.readFile(path.join(directory, `review-v1-${role}.json`), "utf8"));
    assert.equal(saved.contractHash, confirmed.contractHash);
    assert.equal(saved.role, role);
    assert.match(await fs.readFile(path.join(directory, `role-${role}-attempt-1.events.jsonl`), "utf8"), /message_end/);
  }
  const reviewed = (await readTask(project, "REQ-001")).meta;
  assert.equal(reviewed.reviewCostUsd, 0.14);
  assert.deepEqual(reviewed.reviewAttempts, { backend: 1, qa: 1 });
  const observed = await getTaskObservability(root, { id: "reviewer", roles: ["developer"] }, "REQ-001");
  assert.equal(observed.summary.measuredRuns, 2);
  assert.equal(observed.summary.tokens.input.total, 240);
  assert.equal(observed.summary.tokens.cacheRead.total, 20);
  assert.equal(observed.summary.costUsd, 0.14);
  assert.equal(observed.runs[0].telemetry.model, "backend-large");
  assert.equal(observed.runs[1].telemetry.model, "qa-medium");
  assert.equal(observed.runs[0].telemetry.agent, "backendReview");
  assert.notEqual(observed.runs[0].traceId, observed.runs[1].traceId);
  await assert.rejects(getTaskObservability(root, { id: "outsider", roles: ["developer"] }, "REQ-001"),
    /cannot read this requirement/);
  const report = await getAuditReport(root, { id: "admin", roles: ["admin"] }, 0, 1);
  assert.equal(report.pageUsage.measuredRuns, 2);
  assert.equal((await finalizeRoleReview(root, "REQ-001", "reviewer")).state, "review_passed");
  assert.equal((await plan(root, "REQ-001")).state, "plan_review");
  const audit = await fs.readFile(path.join(directory, "events.jsonl"), "utf8");
  assert.match(audit, /role_review_submitted/);
  assert.match(audit, /role_review_passed/);
});

test("core action dispatcher requires developer assignment and acceptance", async (t) => {
  const { root, project } = await fixture(t, false);
  const token = "developer-token-0123456789-abcdefghijklmnop";
  await addCredential(project, "dev1", ["developer"], { username: "dev1", password: "password123456", token });
  const developer = await authenticate(project, token);
  await assert.rejects(executeRequirementAction(root, "REQ-001", { action: "run-review", role: "backend" }, developer),
    /not assigned to perform/);
  await assignMember(root, "REQ-001", "product", "developer", "dev1");
  await assert.rejects(executeRequirementAction(root, "REQ-001", { action: "run-review", role: "backend" }, developer),
    /not assigned to perform/);
  await respondToAssignment(root, "REQ-001", "dev1", "developer", true);
  await recordDevFeedback(root, "REQ-001", "dev1", { summary: "Review multiplication",
    questions: [], requiredRoles: ["backend", "qa"] });
  await confirmContract(root, "REQ-001", "product", { ...contract, answers: {} });
  assert.equal((await executeRequirementAction(root, "REQ-001", { action: "run-review", role: "backend" }, developer)).state,
    "role_review");
  assert.equal(canReadTask(developer, (await readTask(project, "REQ-001")).meta), true);
});

test("failed Pi review still consumes the requirement cost budget", async (t) => {
  const { root, project } = await fixture(t, true, 0.1);
  await recordDevFeedback(root, "REQ-001", "reviewer", { summary: "Review multiplication",
    questions: [], requiredRoles: ["backend", "qa"] });
  await confirmContract(root, "REQ-001", "product", { ...contract, answers: {} });
  await runRoleReviewWithPi(root, "REQ-001", "backend", "reviewer");
  await assert.rejects(runRoleReviewWithPi(root, "REQ-001", "qa", "reviewer"), /exceeded remaining cost cap/);
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.reviewCostUsd, 0.14);
  assert.equal(task.meta.state, "role_review");
  assert.equal(task.meta.reviewHashes.qa, undefined);
  const observed = await getTaskObservability(root, { id: "product", roles: ["product"] }, "REQ-001");
  assert.equal(observed.summary.failedAttempts, 1);
  assert.equal(observed.summary.costUsd, 0.14);
  assert.equal(observed.runs[1].telemetry.tokens.input, 120);
  await assert.rejects(runRoleReviewWithPi(root, "REQ-001", "qa", "reviewer"), /budget exhausted before role review/);
  const skipped = await getTaskObservability(root, { id: "product", roles: ["product"] }, "REQ-001");
  assert.equal(skipped.summary.skippedCalls, 1);
  assert.equal((await readTask(project, "REQ-001")).meta.reviewAttempts.qa, 1);
  assert.match(await fs.readFile(path.join(task.directory, "events.jsonl"), "utf8"), /role_review_attempt_failed/);
});

test("independent roles cannot silently review different project baselines", async (t) => {
  const { root, project } = await fixture(t);
  await recordDevFeedback(root, "REQ-001", "reviewer", { summary: "Review multiplication",
    questions: [], requiredRoles: ["backend", "qa"] });
  await confirmContract(root, "REQ-001", "product", { ...contract, answers: {} });
  await runRoleReviewWithPi(root, "REQ-001", "backend", "reviewer");
  await fs.appendFile(path.join(root, "src", "calculator.mjs"), "\n// concurrent architecture update\n");
  await assert.rejects(runRoleReviewWithPi(root, "REQ-001", "qa", "reviewer"), /baseline-refresh/);
  await refreshProjectBaseline(project);
  await assert.rejects(runRoleReviewWithPi(root, "REQ-001", "qa", "reviewer"),
    /baseline changed between role reviews/);
});

test("project credentials provide fixed identities and isolated roles", async (t) => {
  const { project } = await fixture(t, false);
  await assert.rejects(addCredential(project, "admin-both", ["admin", "product"], "some-token-0123456789-abcdefghijklmnop"),
    /read-only role/);
  await addCredential(project, "product", ["product"], { username: "product", password: "password123456", token: "product-token-0123456789-abcdefghijklmnop" });
  await addCredential(project, "reviewer", ["developer"], { username: "reviewer", password: "password123456", token: "reviewer-token-0123456789-abcdefghijklmn" });
  await assert.rejects(addCredential(project, "duplicate", ["developer"], { username: "duplicate", password: "password123456", token: "reviewer-token-0123456789-abcdefghijklmn" }),
    /Duplicate authentication token/);
  const principal = await authenticate(project, "reviewer-token-0123456789-abcdefghijklmn");
  assert.equal(principal.id, "reviewer");
  assert.doesNotThrow(() => authorize(principal, "approve-plan"));
  assert.throws(() => authorize(principal, "confirm-contract"), /Role cannot perform/);
  await assert.rejects(authenticate(project, "incorrect-token"), /Invalid access token/);
  const auditFile = path.join(project.archive, "auth-events.jsonl");
  const audit = await fs.readFile(auditFile, "utf8");
  await fs.writeFile(auditFile, audit.replace("credential_added", "credential_deleted"));
  await assert.rejects(addCredential(project, "another", ["developer"], { username: "another", password: "password123456", token: "another-token-0123456789-abcdefghijklmnop" }),
    /Authentication audit chain changed/);
  assert.equal(JSON.parse(await fs.readFile(path.join(project.archive, "auth.json"), "utf8")).users.length, 2);
});

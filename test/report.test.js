import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addCredential } from "../src/auth.js";
import { initialize, createTask, appendEvent, readTask } from "../src/store.js";
import { executeRequirementAction, getAuditReport, getRequirementLifecycle, getTaskHistory } from "../src/core.js";
import { lifecycleResults, lifecycleStatus } from "../src/lifecycle.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const product = { id: "product", roles: ["product"] };
const developer = { id: "developer", roles: ["developer"] };
const admin = { id: "admin", roles: ["admin"] };

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-report-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  await fs.cp(path.join(repository, "examples/demo-app/src"), path.join(root, "src"), { recursive: true });
  const config = JSON.parse(await fs.readFile(path.join(repository, "examples/config.local.json"), "utf8"));
  const configFile = path.join(temporary, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ ...config, piExecutable: path.join(repository, "test/fake-pi.mjs"), provider: "fake", model: "fake-model" }));
  const project = await initialize(root, configFile, { inventoryOnly: true });
  await addCredential(project, developer.id, developer.roles, { username: "developer", password: "preview-only-password" });
  return { root, project };
}

async function event(project, id, type, state, detail = {}, fields = {}) {
  const { meta } = await readTask(project, id);
  return appendEvent(project, id, type, { ...meta, ...fields, state }, detail);
}

test("failed model diagnostics retain the telemetry log reference without duplicates", async (t) => {
  const { root, project } = await fixture(t);
  await createTask(project, "REQ-FAILED", "Failure diagnosis", "request", product.id);
  await event(project, "REQ-FAILED", "implementation_failed", "implementation_failed", {
    error: "provider denied quota", logFile: "/owned/task/implement.events.jsonl",
    telemetry: { traceId: "actual-model-trace", phase: "implement", logFile: "/owned/task/implement.events.jsonl",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 1, promptBytes: 10, toolCalls: 0, costUsd: 0 },
  });
  const failure = (await getAuditReport(root, admin)).requirements[0].latestFailure;
  assert.equal(failure.traceId, "actual-model-trace");
  assert.deepEqual(failure.logs, ["/owned/task/implement.events.jsonl"]);
  await event(project, "REQ-FAILED", "implementation_failed", "implementation_failed", {
    error: "internal checks failed", telemetry: { traceId: "checked-trace", phase: "implement",
      logFile: "/owned/task/implement.events.jsonl", internalChecks: [{ status: "failed",
        checks: [{ logFile: "/owned/task/implement.events.jsonl.internal-2-1.log" }] }],
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, durationMs: 10, promptBytes: 10, toolCalls: 1 },
  });
  const checkedFailure = (await getAuditReport(root, admin)).requirements[0].latestFailure;
  assert.equal(checkedFailure.traceId, "checked-trace");
  assert.deepEqual(checkedFailure.logs, ["/owned/task/implement.events.jsonl", "/owned/task/implement.events.jsonl.internal-2-1.log"]);
});

test("unpriced providers are never reported as free and quota switches remain visible", async t => {
  const { root, project } = await fixture(t);
  await createTask(project, "REQ-POOL", "Pool", "request", product.id);
  await event(project, "REQ-POOL", "implemented", "implemented", { costUsd: 0,
    telemetry: { pricingKnown: false, assistantMessages: 2, modelSwitches: [{ code: "insufficient_quota" }],
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, durationMs: 1, promptBytes: 10, toolCalls: 1 } });
  const { usage } = await getAuditReport(root, admin);
  assert.equal(usage.costUsd, null);
  assert.equal(usage.costMeasuredAttempts, 0);
  assert.equal(usage.providerRequests, 2);
  assert.equal(usage.quotaSwitches, 1);
  assert.equal(usage.tokens.input.total, 100);
});

test("management totals and known costs cover the project regardless of pagination or filters", async (t) => {
  const { root, project } = await fixture(t);
  for (const id of ["REQ-ONE", "REQ-TWO", "REQ-THREE"]) await createTask(project, id, id, "request", product.id);
  await event(project, "REQ-ONE", "plan_attempt_failed", "review_passed", { error: "failed", costUsd: 0.1 });
  await event(project, "REQ-TWO", "plan_created", "plan_review", { costUsd: 0.2 });
  await event(project, "REQ-THREE", "archived_test_only", "archived_test_only", { actor: developer.id });
  const first = await getAuditReport(root, admin, 0, 1);
  const second = await getAuditReport(root, admin, 1, 1, { query: "REQ-" });
  assert.equal(first.total, 3);
  assert.equal(first.requirements.length, 1);
  assert.equal(first.summary.active, 2);
  assert.equal(first.summary.completed, 1);
  assert.equal(first.summary.needsAttention, 1);
  assert.equal(first.summary.unowned, 2);
  assert.equal(first.summary.firstVerification.rate, null);
  assert.deepEqual(first.usage, second.usage);
  assert.ok(Math.abs(first.usage.knownCostUsd - 0.3) < 1e-10);
  assert.equal(first.usage.attempts, 2);
  const filtered = await getAuditReport(root, admin, 0, 50, { attention: "true" });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.requirements[0].id, "REQ-ONE");
  const { oldestActive: initialAges, ...initialCounts } = first.summary;
  const { oldestActive: filteredAges, ...filteredCounts } = filtered.summary;
  assert.deepEqual(filteredCounts, initialCounts);
  assert.deepEqual(filteredAges.map((row) => row.id), initialAges.map((row) => row.id));
  await event(project, "REQ-TWO", "verification_failed", "verification_failed", { error: "assertion failed" });
  await event(project, "REQ-TWO", "verified", "verified");
  await event(project, "REQ-THREE", "verified", "archived_test_only");
  const qualityReport = await getAuditReport(root, admin, 0, 1, { query: "REQ-ONE" });
  assert.equal(qualityReport.summary.firstVerification.sampleSize, 2);
  assert.equal(qualityReport.summary.firstVerification.rate, 0.5);
  await event(project, "REQ-ONE", "implementation_failed", "implementation_failed", { error: "Implementation stopped" });
  const deliveryReport = await getAuditReport(root, admin, 0, 1, { query: "REQ-TWO" });
  assert.equal(deliveryReport.summary.firstDelivery.sampleSize, 3);
  assert.equal(deliveryReport.summary.firstDelivery.rate, 1 / 3);
  assert.equal(deliveryReport.summary.firstVerification.rate, 0.5);
  await event(project, "REQ-ONE", "implemented", "implemented");
  await event(project, "REQ-ONE", "plan_created", "plan_review", { costUsd: null });
  const recovered = await getAuditReport(root, admin);
  assert.equal(recovered.summary.needsAttention, 0);
  assert.equal(recovered.usage.costUsd, null);
  assert.equal(recovered.usage.costMeasuredAttempts, 2);
  assert.equal(recovered.usage.durationMs, null);
  assert.equal(recovered.usage.promptBytes, null);
  await assert.rejects(getAuditReport(root, admin, 0, 50, { attention: "maybe" }), /Attention filter/);
  await assert.rejects(getAuditReport(root, admin, 0, 50, { state: "wrong" }), /Unknown lifecycle state/);
  await assert.rejects(getAuditReport(root, product), { code: "EACCES" });
  const file = path.join(project.archive, "tasks/REQ-THREE/events.jsonl");
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("request", "tampered"));
  await assert.rejects(getAuditReport(root, admin, 0, 1, { query: "REQ-ONE" }), /Changed audit event/);
});

test("owners and assigned members can page the whole lifecycle, while raw history remains admin scoped", async (t) => {
  const { root, project } = await fixture(t);
  await createTask(project, "REQ-LONG", "Long history", "original", product.id);
  await executeRequirementAction(root, "REQ-LONG", { action: "assign-member", role: "developer", member: developer.id }, product);
  await executeRequirementAction(root, "REQ-LONG", { action: "accept-assignment", role: "developer" }, developer);
  for (let i = 0; i < 105; i++) await event(project, "REQ-LONG", "plan_revision_requested", "review_passed", { actor: developer.id });
  await event(project, "REQ-LONG", "pi_run_skipped", "review_passed", { reason: "duplicate input" });
  await event(project, "REQ-LONG", "pi_budget_exhausted", "review_passed", { phase: "plan" });
  const first = await getRequirementLifecycle(root, product, "REQ-LONG", 0, 50);
  const middle = await getRequirementLifecycle(root, developer, "REQ-LONG", 50, 50);
  const end = await getRequirementLifecycle(root, product, "REQ-LONG", 100, 50);
  assert.equal(first.total, 109);
  assert.equal(first.rawEventCount, 110);
  assert.equal(first.status.needsAttention, true);
  assert.equal(first.status.responsible.userId, developer.id);
  assert.equal(first.events[0].type, "pi_budget_exhausted");
  assert.equal(end.events.at(-1).type, "intake_draft");
  const combined = [...first.events, ...middle.events, ...end.events];
  assert.equal(new Set(combined.map((row) => row.hash)).size, 109);
  assert.equal(combined.find((row) => row.type === "assignment_accepted").initiatedBy, developer.id);
  assert.equal(combined.find((row) => row.type === "member_assigned").initiatedBy, product.id);
  assert.equal(Object.hasOwn(first.events[0], "detail"), false);
  await assert.rejects(getRequirementLifecycle(root, { id: "other", roles: ["developer"] }, "REQ-LONG"), { code: "EACCES" });
  await assert.rejects(getTaskHistory(root, developer, "REQ-LONG"), { code: "EACCES" });
  assert.equal((await getTaskHistory(root, admin, "REQ-LONG")).total, 110);
  await assert.rejects(getRequirementLifecycle(root, product, "REQ-LONG", -1), /Offset/);
});

test("lifecycle results retain six current milestones across retries without exposing diagnostics", () => {
  const meta = { state: "archived_test_only", createdBy: "product", contractHash: "contract", contractVersion: 2,
    planHash: "plan", planVersion: 3, afterHash: "code", developmentFiles: ["app.js", "app.test.js"],
    assignments: { developer: { userId: "dev", status: "accepted" } }, planApprovedBy: "dev", acceptedBy: "product",
    acceptanceMode: "manual", verificationMode: "automated", archivedBy: "dev" };
  const row = (type, detail = {}) => ({ type, meta, at: "2026-10-13T00:00:00Z", detail });
  const events = [row("contract_confirmed", { actor: "confirmer" }), row("plan_created"), row("plan_approved"),
    row("implemented", { changes: [{ file: "app.js" }] }), row("verification_failed", { error: "RAW_ERROR" }),
    row("verified", { checks: [{ code: 0 }, { code: 0 }] }), row("test_accepted"), row("archived_test_only")];
  events.splice(2, 0, ...Array.from({ length: 120 }, () => row("plan_specialist_completed", { telemetry: { model: "RAW_MODEL" } })));
  const results = lifecycleResults(meta, events);
  assert.equal(results.length, 6); assert.ok(results.every(result => result.status === "completed"));
  assert.match(results[1].summary, /方案 v3.*2 个文件/); assert.match(results[2].summary, /1 个文件/);
  assert.match(results[3].summary, /2 项相关检查通过/); assert.match(results[4].summary, /人工核对研发交付/);
  assert.doesNotMatch(JSON.stringify(results), /RAW_ERROR|RAW_MODEL|telemetry|requestTimings/);
  assert.equal(results[0].owner, "confirmer");
  for (const item of events.filter(event => ["implemented", "verified"].includes(event.type)))
    item.meta = { ...meta, assignments: { developer: { userId: "original-dev", status: "accepted" } } };
  assert.equal(lifecycleResults(meta, events)[2].owner, "original-dev");
  assert.equal(lifecycleResults(meta, events)[3].owner, "original-dev");
  const revision = { ...meta, state: "intake_clarifying", acceptedBy: null };
  const revised = lifecycleResults(revision, [...events, { ...row("acceptance_repair_requested"), meta: revision }]);
  assert.ok(revised.every(result => result.status === "pending"));
  const redesigned = { ...meta, state: "approved", contractHash: "new-contract", contractVersion: 3, planHash: "new-plan", planVersion: 4 };
  const rerun = [...events, { ...row("contract_confirmed"), meta: redesigned }, { ...row("plan_approved"), meta: redesigned }];
  assert.deepEqual(lifecycleResults(redesigned, rerun).map(result => result.status), ["completed", "completed", "pending", "pending", "pending", "pending"]);
});

test("manual checks and a failed recheck never claim automated success", () => {
  const meta = { state: "verified", createdBy: "product", contractHash: "contract", contractVersion: 1,
    planHash: "plan", planVersion: 1, afterHash: "code", developmentFiles: ["app.js"], verificationMode: "manual_pending" };
  const row = (type, detail = {}) => ({ type, meta, at: "2026-10-13T00:00:00Z", detail });
  const events = [row("contract_confirmed"), row("plan_approved"), row("implemented", { changes: [] }), row("verified", { checks: [] })];
  const result = lifecycleResults(meta, events)[3];
  assert.equal(result.status, "pending"); assert.match(result.summary, /待人工核验/); assert.doesNotMatch(result.summary, /检查通过/);
  const accepted = { ...meta, state: "test_accepted", acceptanceMode: "manual", acceptedBy: "product" };
  const acceptedResults = lifecycleResults(accepted, [...events, { ...row("test_accepted"), meta: accepted }]);
  assert.match(acceptedResults[3].summary, /未运行自动检查.*人工核验/); assert.equal(acceptedResults[3].status, "completed");
  const failed = lifecycleResults({ ...meta, state: "verification_failed" }, events)[3];
  assert.equal(failed.status, "blocked"); assert.match(failed.summary, /未通过/);
});

test("state age ignores repeated polling, and closure stops the delivery clock", () => {
  const at = (hour) => `2026-10-05T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const rows = [
    { at: at(1), type: "intake_draft", meta: { state: "intake_draft" }, detail: {} },
    { at: at(2), type: "test_deploy_running", meta: { state: "test_deploy_running" }, detail: {} },
    { at: at(3), type: "test_deploy_poll_failed", meta: { state: "test_deploy_running" }, detail: {} },
    { at: at(4), type: "test_deploy_running", meta: { state: "test_deploy_running" }, detail: {} },
  ];
  const meta = { state: "test_deploy_running", createdBy: "product", assignments: { developer: { userId: "developer", status: "accepted" } } };
  const status = lifecycleStatus(meta, rows, Date.parse(at(5)));
  assert.equal(status.stateSince, at(2));
  assert.equal(status.stateAgeMs, 3 * 3600000);
  assert.equal(lifecycleStatus(meta, rows.slice(0, 3), Date.parse(at(5))).needsAttention, true);
  assert.equal(status.needsAttention, false);
  rows.push({ at: at(5), type: "test_deployed", meta: { state: "test_deployed" }, detail: {} });
  assert.equal(lifecycleStatus({ ...meta, state: "test_deployed" }, rows, Date.parse(at(6))).needsAttention, false);
  rows.push({ at: at(6), type: "archived", meta: { state: "archived" }, detail: {} });
  rows.push({ at: at(7), type: "pi_run_skipped", meta: { state: "archived" }, detail: {} });
  assert.equal(lifecycleStatus({ ...meta, state: "archived" }, rows, Date.parse(at(8))).cycleMs, 5 * 3600000);
});

test("independent review retries clear only their own failure, and new contracts invalidate old design issues", () => {
  const meta = { state: "role_review", createdBy: "product", assignments: { developer: { userId: "developer", status: "accepted" } } };
  const rows = [
    { at: "2026-10-05T01:00:00Z", type: "contract_confirmed", meta, detail: {} },
    { at: "2026-10-05T02:00:00Z", type: "role_review_attempt_failed", meta, detail: { role: "backend" } },
    { at: "2026-10-05T03:00:00Z", type: "role_review_attempt_failed", meta, detail: { role: "qa" } },
    { at: "2026-10-05T04:00:00Z", type: "role_review_submitted", meta, detail: { role: "backend" } },
  ];
  assert.equal(lifecycleStatus(meta, rows, Date.now()).unresolved.length, 1);
  rows.push({ at: "2026-10-05T05:00:00Z", type: "role_review_submitted", meta, detail: { role: "qa" } });
  assert.equal(lifecycleStatus(meta, rows, Date.now()).needsAttention, false);
  rows.push({ at: "2026-10-05T06:00:00Z", type: "plan_attempt_failed", meta, detail: {} });
  rows.push({ at: "2026-10-05T07:00:00Z", type: "contract_revised", meta, detail: {} });
  assert.equal(lifecycleStatus(meta, rows, Date.now()).needsAttention, false);
});

test("product owns the handoff until a developer is nominated, then the named member owns acceptance", () => {
  const meta = { state: "contract_confirmed", createdBy: "product", assignments: {} };
  const rows = [{ at: "2026-10-05T01:00:00Z", type: "contract_confirmed", meta, detail: {} }];
  const handoff = lifecycleStatus(meta, rows, Date.now());
  assert.equal(handoff.responsible.userId, "product");
  assert.equal(handoff.waitingHuman, true);
  const assigned = { ...meta, state: "assignment_pending", assignments: { developer: { userId: "developer", status: "pending" } } };
  const acceptance = lifecycleStatus(assigned, [...rows, { ...rows[0], type: "member_assigned", meta: assigned }], Date.now());
  assert.equal(acceptance.responsible.userId, "developer");
  assert.equal(acceptance.waitingHuman, true);
});

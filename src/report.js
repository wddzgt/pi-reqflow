import path from "node:path";
import { promises as fs } from "node:fs";
import { authenticationHistory } from "./auth.js";
import { readJson, sha256 } from "./files.js";
import { readTask } from "./store.js";
import { lifecycleEvents, lifecycleResults, lifecycleStage, lifecycleStatus } from "./lifecycle.js";
import { executionUsage, firstDeliveryQuality, firstVerificationQuality } from "./admission.js";

function page(offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Offset must be a nonnegative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Limit must be between 1 and 100");
  return { offset, limit };
}

const piEventTypes = new Set(["role_review_submitted", "role_review_attempt_failed", "plan_created",
  "plan_draft_completed", "plan_specialist_completed", "plan_specialist_failed", "plan_draft_reused", "plan_specialist_reused",
  "plan_correction_completed", "plan_correction_failed", "plan_correction_reused",
  "plan_attempt_failed", "implemented", "implementation_failed", "implementation_inspection_failed", "pi_run_skipped",
  "intake_analysis_completed", "intake_analysis_failed", "pi_budget_exhausted", "plan_reply", "plan_discussion_failed",
  "acceptance_reply", "acceptance_discussion_failed"]);

function piRuns(events) {
  return events.filter((event) => piEventTypes.has(event.type)
    && (event.detail.modelRun !== false || ["plan_draft_reused", "plan_specialist_reused", "plan_correction_reused"].includes(event.type))
    && (event.type !== "role_review_submitted" || event.detail.run)).map((event) => {
    const detail = event.detail.run ?? event.detail;
    return { eventType: event.type, eventAt: event.at, role: event.detail.role ?? null,
      phase: detail.telemetry?.phase ?? event.detail.phase ?? null,
      status: event.detail.executionOutcome === "paused" ? "paused" : ["pi_run_skipped", "pi_budget_exhausted", "plan_draft_reused", "plan_specialist_reused", "plan_correction_reused"].includes(event.type) ? "skipped" : event.detail.error ? "failed" : "succeeded",
      traceId: detail.telemetry?.traceId ?? null, telemetry: detail.telemetry ?? null,
      costUsd: detail.costUsd ?? detail.telemetry?.costUsd ?? null,
      error: event.detail.error ?? null, reason: event.detail.reason ?? null,
      sourceEventHash: event.detail.sourceEventHash ?? null };
  });
}

function usageSummary(runs) {
  const attempts = runs.filter((run) => run.status !== "skipped");
  const measured = attempts.filter((run) => run.telemetry);
  const incomplete = new Set(attempts.filter(run => !run.telemetry || run.telemetry.unmeasuredRequests > 0
    || run.telemetry.requestTimings?.some(row => row.usageMeasured === false || ["running", "timed_out", "interrupted"].includes(row.status))));
  const knownCosts = attempts.filter((run) => typeof run.costUsd === "number" && run.telemetry?.pricingKnown !== false);
  const tokens = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map((key) => {
    const values = measured.map((run) => run.telemetry.tokens[key]).filter((value) => value !== null);
    return [key, { total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      measuredRuns: values.length }];
  }));
  return { attempts: attempts.length, skippedCalls: runs.length - attempts.length,
    providerRequests: incomplete.size === 0 && measured.every(run => Number.isSafeInteger(run.telemetry.assistantMessages))
      ? measured.reduce((sum, run) => sum + run.telemetry.assistantMessages, 0) : null,
    quotaSwitches: measured.length === attempts.length && measured.every(run => Array.isArray(run.telemetry.modelSwitches))
      ? measured.reduce((sum, run) => sum + run.telemetry.modelSwitches.length, 0) : null,
    measuredRuns: measured.length, unmeasuredAttempts: incomplete.size,
    failedAttempts: attempts.filter((run) => run.status === "failed").length,
    pausedAttempts: attempts.filter((run) => run.status === "paused").length,
    costMeasuredAttempts: knownCosts.length,
    costUsd: incomplete.size === 0 && knownCosts.length === attempts.length
      ? knownCosts.reduce((sum, run) => sum + run.costUsd, 0) : null,
    knownCostUsd: knownCosts.reduce((sum, run) => sum + run.costUsd, 0),
    durationMs: measured.length || !attempts.length ? measured.reduce((sum, run) => sum + run.telemetry.durationMs, 0) : null,
    promptBytes: measured.length || !attempts.length ? measured.reduce((sum, run) => sum + run.telemetry.promptBytes, 0) : null,
    toolCalls: measured.length || !attempts.length ? measured.reduce((sum, run) => sum + run.telemetry.toolCalls, 0) : null, tokens };
}

function workflowFailures(events) {
  return events.filter((event) => event.detail.executionOutcome !== "paused" && (event.type.endsWith("_failed") || event.type.endsWith("_outcome_unknown")
    || event.type === "rollback_rejected" || event.type === "execution_boundary_stopped" || event.detail.outcome === "failed"))
    .map((event) => ({ at: event.at, stage: event.type,
      reason: event.detail.error ?? event.detail.deployment?.result ?? event.detail.deployment?.evidence ?? event.detail.evidence ?? null,
      traceId: event.detail.telemetry?.traceId ?? event.detail.run?.telemetry?.traceId ?? null,
      logs: [...new Set([event.detail.logFile, event.detail.telemetry?.logFile, event.detail.run?.logFile,
        event.detail.run?.telemetry?.logFile, ...(event.detail.checks ?? event.detail.baselineChecks ?? []).map((check) => check.logFile),
        ...(event.detail.telemetry?.internalChecks ?? []).flatMap(attempt => attempt.checks.map(check => check.logFile)),
        ...(event.detail.telemetry?.developmentChecks ?? []).flatMap(attempt => attempt.checks.map(check => check.logFile)),
        event.detail.deployment?.logFile].filter((file) => typeof file === "string"))] }));
}

export async function taskLifecycle(task, offset = 0, limit = 50) {
  page(offset, limit);
  const { meta, lastHash, events } = task;
  const timeline = lifecycleEvents(events).reverse();
  const results = lifecycleResults(meta, events);
  if (results[0].status === "completed") {
    const contract = await readJson(path.join(task.directory, `contract-v${meta.contractVersion}.json`));
    if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Frozen requirement changed before lifecycle display");
    results[0].conclusion = contract.objective;
    results[0].summary += `，${contract.acceptance.length} 条验收条件`;
  }
  if (results[4].status === "completed") {
    const accepted = events.findLast(event => event.type === "test_accepted" && event.meta.afterHash === meta.afterHash
      && event.meta.planHash === meta.planHash && event.meta.contractHash === meta.contractHash);
    const evidence = await fs.readFile(path.join(task.directory, "acceptance.md"), "utf8");
    if (sha256(evidence) !== accepted.detail.evidenceHash) throw new Error("Acceptance evidence changed before lifecycle display");
    results[4].conclusion = evidence;
  }
  return { id: meta.id, title: meta.title, state: meta.state, auditHead: lastHash,
    status: lifecycleStatus(meta, events, Date.now()), results,
    responsibilities: { product: meta.createdBy, developer: meta.assignments?.developer ?? null,
      planReviewer: meta.planApprovedBy ?? null, changeRiskOwner: meta.changeApproval?.actor ?? null,
      testAcceptor: meta.acceptedBy ?? null, releaseApprover: meta.releaseApprovedBy ?? null,
      releaseObserver: meta.observedBy ?? null },
    total: timeline.length, rawEventCount: events.length, offset, limit,
    events: timeline.slice(offset, offset + limit) };
}

function managementSummary(requirements) {
  const active = requirements.filter((row) => !row.lifecycle.closed);
  const completed = requirements.filter((row) => ["archived", "archived_test_only"].includes(row.state));
  const cycles = completed.map((row) => row.lifecycle.cycleMs).sort((a, b) => a - b);
  const owners = new Map();
  const stages = new Map();
  for (const row of requirements) {
    stages.set(row.lifecycle.stage, (stages.get(row.lifecycle.stage) ?? 0) + 1);
    if (row.lifecycle.closed) continue;
    const id = row.lifecycle.responsible.userId;
    if (!owners.has(id)) owners.set(id, { userId: id, active: 0, waitingHuman: 0, needsAttention: 0 });
    const owner = owners.get(id);
    owner.active++;
    owner.waitingHuman += Number(row.lifecycle.waitingHuman);
    owner.needsAttention += Number(row.lifecycle.needsAttention);
  }
  const middle = Math.floor(cycles.length / 2);
  return { total: requirements.length, active: active.length, completed: completed.length,
    rolledBack: requirements.filter((row) => row.state === "rolled_back").length,
    waitingHuman: active.filter((row) => row.lifecycle.waitingHuman).length,
    needsAttention: active.filter((row) => row.lifecycle.needsAttention).length,
    unowned: active.filter((row) => !row.lifecycle.responsible.userId).length,
    completedCycleMedianMs: !cycles.length ? null : cycles.length % 2 ? cycles[middle] : (cycles[middle - 1] + cycles[middle]) / 2,
    completedCycleSamples: cycles.length,
    stages: Object.fromEntries(stages), owners: [...owners.values()].sort((a, b) => b.needsAttention - a.needsAttention || b.active - a.active),
    oldestActive: [...active].sort((a, b) => b.lifecycle.stateAgeMs - a.lifecycle.stateAgeMs).slice(0, 5)
      .map((row) => ({ id: row.id, title: row.title, state: row.state, responsible: row.lifecycle.responsible, stateAgeMs: row.lifecycle.stateAgeMs })) };
}

export function taskObservability(task, offset = 0, limit = 100) {
  page(offset, limit);
  const { meta, lastHash, events } = task;
  const runs = piRuns(events);
  const failures = workflowFailures(events);
  return { id: meta.id, state: meta.state, auditHead: lastHash, summary: usageSummary(runs),
    execution: executionUsage(events), quality: firstVerificationQuality([task]), deliveryQuality: firstDeliveryQuality([task]),
    failureCount: failures.length, recentFailures: failures.slice(-10).reverse(),
    total: runs.length, offset, limit, runs: runs.slice(offset, offset + limit) };
}

export async function auditReport(project, offset = 0, limit = 50, filters = {}) {
  page(offset, limit);
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new Error("Audit filters must be an object");
  for (const [key, value] of Object.entries(filters)) {
    if (!["owner", "state", "query", "attention"].includes(key) || typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Invalid audit filter");
    if (key === "attention" && !["true", "false"].includes(value)) throw new Error("Attention filter must be true or false");
    if (key === "state") lifecycleStage(value);
  }
  const index = await readJson(path.join(project.archive, "index.json"));
  if (!Array.isArray(index)) throw new Error("Task index is invalid");
  const credentials = await authenticationHistory(project);
  const sorted = [...index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const requirements = [];
  const pageRuns = [];
  const allRuns = [];
  const qualityTasks = [];
  const runsById = new Map();
  const now = Date.now();
  for (const row of sorted) {
    const { meta, lastHash, events } = await readTask(project, row.id);
    qualityTasks.push({ events });
    const runs = piRuns(events);
    allRuns.push(...runs);
    runsById.set(row.id, runs);
    const failures = workflowFailures(events);
    requirements.push({ id: meta.id, title: meta.title, state: meta.state, createdBy: meta.createdBy,
      assignments: meta.assignments ?? {}, createdAt: meta.createdAt, updatedAt: meta.updatedAt ?? meta.createdAt,
      eventCount: events.length, auditHead: lastHash, contractVersion: meta.contractVersion ?? 0,
      planVersion: meta.planVersion, projectBaselineHash: meta.projectBaselineHash ?? meta.reviewBaselineHash ?? null,
      reviewedBy: meta.planApprovedBy ?? null,
      changeRiskOwner: meta.changeApproval?.actor ?? null,
      usage: usageSummary(runs), failureCount: failures.length,
      latestFailure: failures.at(-1) ?? null, lifecycle: lifecycleStatus(meta, events, now) });
  }
  const selected = requirements.filter((row) => (!filters.owner || row.createdBy === filters.owner || Object.values(row.assignments).some((assignment) => assignment.userId === filters.owner && assignment.status !== "declined"))
    && (!filters.state || row.state === filters.state)
    && (!filters.attention || row.lifecycle.needsAttention === (filters.attention === "true"))
    && (!filters.query || `${row.id} ${row.title}`.toLowerCase().includes(filters.query.toLowerCase())));
  const paged = selected.slice(offset, offset + limit);
  for (const row of paged) pageRuns.push(...runsById.get(row.id));
  return { total: selected.length, projectTotal: requirements.length, offset, limit, filters,
    generatedAt: new Date(now).toISOString(), authEventCount: credentials.length,
    summary: { ...managementSummary(requirements), firstDelivery: firstDeliveryQuality(qualityTasks),
      firstVerification: firstVerificationQuality(qualityTasks) }, usage: usageSummary(allRuns),
    pageUsage: usageSummary(pageRuns), requirements: paged };
}

export async function taskHistory(project, id, offset = 0, limit = 100) {
  page(offset, limit);
  const { meta, lastHash, events } = await readTask(project, id);
  return { id, state: meta.state, total: events.length, offset, limit, auditHead: lastHash,
    events: events.slice(offset, offset + limit) };
}

export async function authHistoryPage(project, offset = 0, limit = 100) {
  page(offset, limit);
  const events = await authenticationHistory(project);
  return { total: events.length, offset, limit, events: events.slice(offset, offset + limit) };
}

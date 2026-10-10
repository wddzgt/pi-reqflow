import assert from "node:assert/strict";
import test from "node:test";
import { admissionDefaults, admissionInput, assessAdmission, executionUsage, firstDeliveryQuality, firstVerificationQuality,
  modelAllowance, validateAdmissionPolicy } from "../src/admission.js";

const policy = { ...admissionDefaults, restrictedPaths: [] };
function draft() {
  return { affectedFiles: ["src/order.mjs", "test/order.mjs"], openQuestions: [],
    impacts: Object.fromEntries(["existingBehavior", "interfaces", "data"].map((key) => [key, { status: "none", evidence: "新计算逻辑不修改现有调用" }])),
    boundaries: { modules: [{ name: "订单定价与状态流转", files: ["src/order.mjs", "test/order.mjs"], evidence: "一个业务模块" }],
      deliveryUnits: [{ name: "订单应用", evidence: "一个独立可部署应用" }], designStages: 1, estimatedChangedLines: 250,
      coordination: { status: "none", evidence: "无需协调其他服务" }, verification: { status: "ready", evidence: "边界价格和合法/非法状态转移断言" },
      recovery: { status: "code_only", evidence: "无外部操作，代码快照恢复" },
      externalEffects: { status: "none", evidence: "不调用外部服务" }, exclusions: [] } };
}
const contract = { acceptance: [{ id: "AC1" }] };

test("bounded business calculations and state transitions are admitted beyond CRUD", () => {
  assert.equal(assessAdmission(draft(), contract, policy).status, "accepted");
  const risk = draft(); risk.impacts.existingBehavior.status = "changed";
  const decision = assessAdmission(risk, contract, policy);
  assert.equal(decision.status, "conditional"); assert.equal(decision.requiresHumanApproval, true);
  risk.impacts.existingBehavior.status = "unknown";
  assert.equal(assessAdmission(risk, contract, policy).eligible, false);
  const coupled = draft(); coupled.affectedFiles = ["web/order.tsx", "src/order.mjs"];
  coupled.boundaries.modules = coupled.affectedFiles.map((file) => ({ name: file, files: [file], evidence: "同一订单功能" }));
  assert.equal(assessAdmission(coupled, contract, policy).status, "accepted");
});

test("size estimates alone do not reject a well-understood requirement", () => {
  for (const alter of [(v) => v.boundaries.estimatedChangedLines = policy.maxEstimatedChangedLines + 1]) {
    const value = draft(); alter(value);
    const decision = assessAdmission(value, contract, policy);
    assert.equal(decision.eligible, true);
    assert.equal(decision.status, "conditional");
    assert.ok(decision.warnings.length > 0);
    assert.deepEqual(decision.reasons, []);
  }
});

test("irreversible operations and explicitly restricted paths still require authorization", () => {
  const value = draft(); value.boundaries.externalEffects.status = "irreversible";
  assert.equal(assessAdmission(value, contract, policy).status, "out_of_scope");
  const coupled = draft(); coupled.boundaries.coordination.status = "required";
  assert.equal(assessAdmission(coupled, contract, policy).status, "out_of_scope");
  assert.equal(assessAdmission(draft(), contract, { ...policy, restrictedPaths: ["src"] }).eligible, false);
});

test("multi-stage design and architecture work require human-led development", () => {
  for (const alter of [(v) => v.boundaries.designStages = 2,
    (v) => v.boundaries.exclusions.push({ kind: "architecture_redesign", evidence: "需要重选服务边界" }),
    (v) => v.boundaries.exclusions.push({ kind: "staged_migration", evidence: "需要设计双写及切换策略" }),
    (v) => v.boundaries.exclusions.push({ kind: "exploratory_work", evidence: "解决方案尚未确定，需对比原型" })]) {
    const value = draft(); alter(value);
    const decision = assessAdmission(value, contract, policy);
    assert.equal(decision.eligible, false);
    assert.equal(decision.status, "out_of_scope");
    assert.ok(decision.reasons.length > 0);
  }
});

test("data and external effects require independent recovery evidence", () => {
  const value = draft(); value.impacts.data.status = "changed";
  assert.equal(assessAdmission(value, contract, policy).status, "needs_clarification");
  value.boundaries.recovery = { status: "documented", evidence: "已明确数据恢复步骤及责任人，待人工审核" };
  assert.equal(assessAdmission(value, contract, policy).status, "conditional");
  value.impacts.data.status = "none"; value.boundaries.externalEffects.status = "unknown";
  assert.equal(assessAdmission(value, contract, policy).eligible, false);
});

test("explicit policies and admission evidence are complete and unambiguous", () => {
  assert.equal(validateAdmissionPolicy(policy).maxFiles, 12);
  assert.throws(() => validateAdmissionPolicy({ maxFiles: 12 }), /budgetMode/);
  assert.throws(() => validateAdmissionPolicy({ ...policy, bypass: true }), /Unknown/);
  const value = draft(); value.boundaries.modules[0].files.pop();
  assert.throws(() => admissionInput(value.boundaries, value.affectedFiles), /exactly once/);
  const duplicate = draft(); duplicate.boundaries.deliveryUnits.push(duplicate.boundaries.deliveryUnits[0]);
  assert.throws(() => admissionInput(duplicate.boundaries, duplicate.affectedFiles), /deployable units/);
});

test("engineering budgets count failed calls, caches and duration without counting wrappers", () => {
  const measured = { type: "plan_draft_completed", detail: { telemetry: { tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 }, durationMs: 100, assistantMessages: 2 } } };
  const events = [measured, { ...measured, type: "implementation_failed" }, { type: "plan_attempt_failed", detail: { modelRun: false } }];
  assert.deepEqual(executionUsage(events), { calls: 4, totalTokens: 40, modelMs: 200, unmeasuredCalls: 0 });
  assert.throws(() => modelAllowance(events, { ...policy, budgetMode: "strict", maxModelCalls: 2 }), /budget exhausted/);
  assert.throws(() => modelAllowance(events, { ...policy, budgetMode: "strict", maxTotalTokens: 40 }), /budget exhausted/);
  assert.throws(() => modelAllowance([{ type: "implemented", detail: {} }], policy), /unmeasured/);
  assert.equal(modelAllowance(events, { ...policy, budgetMode: "strict" }).maxTokens, policy.maxTotalTokens - 40);
});

test("product alignment successes and failures share the later engineering token allowance", () => {
  const telemetry = { tokens: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }, durationMs: 100, assistantMessages: 1 };
  const events = ["intake_analysis_completed", "intake_analysis_failed"].map(type => ({ type, detail: { telemetry } }));
  assert.equal(executionUsage(events).totalTokens, 100);
  assert.equal(modelAllowance(events, { ...policy, budgetMode: "strict", maxTotalTokens: 101 }).maxTokens, 1);
  assert.throws(() => modelAllowance(events, { ...policy, budgetMode: "strict", maxTotalTokens: 100 }), /budget exhausted/);
  assert.throws(() => modelAllowance([{ type: "intake_analysis_failed", detail: {} }], policy), /unmeasured/);
});

test("first verification rate uses concluded first outcomes without retry inflation", () => {
  const quality = firstVerificationQuality([{ events: [{ type: "verification_failed" }, { type: "verified" }] },
    { events: [{ type: "verified" }] }, { events: [{ type: "implemented" }] }]);
  assert.equal(quality.sampleSize, 2); assert.equal(quality.passed, 1); assert.equal(quality.rate, 0.5);
  assert.equal(firstVerificationQuality([]).rate, null);
});

test("first delivery quality includes implementation failures and interruptions before verification", () => {
  const tasks = [{ events: [{ type: "implementation_failed" }, { type: "verified" }] },
    { events: [{ type: "implementation_interrupted" }] },
    { events: [{ type: "implementation_inspection_failed" }] },
    { events: [{ type: "implemented" }, { type: "verified" }] },
    { events: [{ type: "implemented" }] }];
  const quality = firstDeliveryQuality(tasks);
  assert.equal(quality.sampleSize, 4); assert.equal(quality.passed, 1); assert.equal(quality.rate, 0.25);
  assert.equal(firstDeliveryQuality([]).rate, null);
  assert.equal(firstVerificationQuality(tasks).rate, 1);
});

test("same-session repair and reviewed replacements never inflate first-pass delivery", () => {
  const tasks = [
    { events: [{ type: "implemented", detail: { telemetry: { internalChecks: [{ status: "passed" }] } } }, { type: "verified" }] },
    { events: [{ type: "implemented", detail: { telemetry: { internalChecks: [{ status: "failed" }, { status: "passed" }] } } }, { type: "verified" }] },
    { events: [{ type: "implemented", detail: { source: "owner_reviewed_replacement" } }, { type: "verified" }] },
  ];
  const delivery = firstDeliveryQuality(tasks);
  assert.equal(delivery.sampleSize, 3);
  assert.equal(delivery.passed, 1);
  assert.equal(delivery.failed, 2);
  assert.equal(firstVerificationQuality(tasks).passed, 2);
  assert.equal(firstVerificationQuality(tasks).failed, 1);
});

test("adaptive tokens follow verified task scope without treating estimates as a hard stop", () => {
  const measured = { type: "implemented", detail: { telemetry: { tokens: { input: 40000, output: 1000, cacheRead: 0, cacheWrite: 0 },
    durationMs: 100, assistantMessages: 3 } } };
  for (const [files, lines, modules, complexity, target] of [[2, 80, ["cli"], "small", 30000],
    [5, 350, ["api", "ui"], "standard", 60000], [8, 700, ["api", "ui"], "bounded_complex", 120000]]) {
    const events = [{ type: "plan_draft_completed", detail: { modelRun: false, admission: { scope: { files, modules, estimatedChangedLines: lines } } } }, measured];
    const allowance = modelAllowance(events, { ...policy, budgetMode: "adaptive", maxTotalTokens: 100 });
    assert.equal(allowance.budget.complexity, complexity);
    assert.equal(allowance.maxTokens, target);
    assert.equal(allowance.budget.usedTokens, 41000);
    assert.equal(allowance.maxRequests, policy.maxModelCalls);
    assert.equal(allowance.budget.usedCalls, 3);
    assert.throws(() => modelAllowance(events, { ...policy, budgetMode: "strict", maxTotalTokens: 100 }), /budget exhausted/);
  }
  assert.throws(() => validateAdmissionPolicy({ ...policy, budgetMode: "unlimited" }), /budgetMode/);
});

import path from "node:path";
import { sha256 } from "./files.js";

export const admissionDefaults = Object.freeze({ maxFiles: 12, maxAcceptance: 8, maxBusinessModules: 2,
  maxDeliveryUnits: 1, maxEstimatedChangedLines: 1000, maxChangedBytes: 250000,
  maxPlanAttempts: 3, maxModelCalls: 36, maxTotalTokens: 200000, maxModelMs: 1200000, budgetMode: "adaptive",
  restrictedPaths: Object.freeze([]) });
export const excludedWork = Object.freeze(["architecture_redesign", "staged_migration", "core_security_rework",
  "framework_upgrade", "exploratory_work", "irreversible_data_operation"]);
export const admissionNames = Object.freeze({ accepted: "可承接", conditional: "条件承接",
  needs_clarification: "待补充", out_of_scope: "超出承接边界" });

export function admissionPolicy(config) {
  return config.admission === undefined ? { ...admissionDefaults, restrictedPaths: [] } : config.admission;
}

export function validateAdmissionPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("config.admission must be an object");
  for (const key of Object.keys(policy)) if (!Object.hasOwn(admissionDefaults, key)) throw new Error(`Unknown admission field: ${key}`);
  if (!["adaptive", "strict"].includes(policy.budgetMode)) throw new Error("admission.budgetMode must be adaptive or strict");
  for (const key of Object.keys(admissionDefaults).filter((key) => !["restrictedPaths", "budgetMode"].includes(key))) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw new Error(`admission.${key} must be an explicit positive integer`);
  }
  if (policy.maxFiles > 30) throw new Error("admission.maxFiles cannot exceed the 30-file analysis bound");
  if (!Array.isArray(policy.restrictedPaths) || policy.restrictedPaths.length > 30
      || new Set(policy.restrictedPaths).size !== policy.restrictedPaths.length
      || policy.restrictedPaths.some((file) => typeof file !== "string" || !file || path.posix.isAbsolute(file)
        || file.includes("\\") || path.posix.normalize(file) !== file || file.split("/").includes(".."))) throw new Error("admission.restrictedPaths must be unique project-relative prefixes");
  return policy;
}

export function admissionInput(value, files) {
  if (!value || !Array.isArray(value.modules) || !value.modules.length || value.modules.length > 30
      || value.modules.some((item) => !item || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 || !Array.isArray(item.files)
        || !item.files.length || item.files.some((file) => !files.includes(file))
        || typeof item.evidence !== "string" || !item.evidence.trim() || item.evidence.length > 1000)) throw new Error("Admission needs named business modules, file scope and evidence");
  const scoped = value.modules.flatMap((item) => item.files);
  if (new Set(value.modules.map((item) => item.name)).size !== value.modules.length
      || scoped.length !== files.length || new Set(scoped).size !== files.length) throw new Error("Admission modules must cover every affected file exactly once");
  if (!Array.isArray(value.deliveryUnits) || !value.deliveryUnits.length || value.deliveryUnits.length > 10
      || new Set(value.deliveryUnits.map((item) => item?.name)).size !== value.deliveryUnits.length
      || value.deliveryUnits.some((item) => !item || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100
        || typeof item.evidence !== "string" || !item.evidence.trim() || item.evidence.length > 1000)) throw new Error("Admission needs independently deployable units and evidence");
  for (const key of ["designStages", "estimatedChangedLines"]) if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new Error(`Admission needs ${key}`);
  for (const [key, statuses] of [["coordination", ["none", "required", "unknown"]],
    ["verification", ["ready", "unknown"]], ["recovery", ["code_only", "documented", "unresolved"]],
    ["externalEffects", ["none", "reversible", "irreversible", "unknown"]]]) {
    if (!statuses.includes(value[key]?.status) || typeof value[key].evidence !== "string"
        || !value[key].evidence.trim() || value[key].evidence.length > 1000) throw new Error(`Admission needs explicit ${key} evidence`);
  }
  if (!Array.isArray(value.exclusions) || value.exclusions.length > excludedWork.length
      || new Set(value.exclusions.map((item) => item?.kind)).size !== value.exclusions.length
      || value.exclusions.some((item) => !item || !excludedWork.includes(item.kind) || typeof item.evidence !== "string"
        || !item.evidence.trim() || item.evidence.length > 1000)) throw new Error("Admission exclusions must identify work requiring human-led development");
  return value;
}

export function restrictedAdmissionFile(file, policy) {
  return policy.restrictedPaths.some((prefix) => prefix === "." || file === prefix || file.startsWith(`${prefix}/`));
}

export function assessAdmission(draft, contract, policy) {
  const value = admissionInput(draft.boundaries, draft.affectedFiles);
  const outside = [];
  const warnings = [];
  const unresolved = [...draft.openQuestions];
  for (const [actual, limit, title] of [[draft.affectedFiles.length, policy.maxFiles, "拟改文件"],
    [contract.acceptance.length, policy.maxAcceptance, "验收条件"], [value.modules.length, policy.maxBusinessModules, "业务模块"],
    [value.deliveryUnits.length, policy.maxDeliveryUnits, "交付单元"], [value.estimatedChangedLines, policy.maxEstimatedChangedLines, "预计差异行数"]]) {
    if (actual > limit) warnings.push(`${title} ${actual} 超过规划参考值 ${limit}，需要相应的实施和验证安排`);
  }
  if (value.designStages !== 1) outside.push("需要分阶段设计和方案决策，应由研发人员借助其他工具主导，设计收敛后再提交独立子需求");
  if (value.coordination.status === "required") outside.push(`需要外部系统或团队协调，应由研发人员主导：${value.coordination.evidence}`);
  if (value.externalEffects.status === "irreversible") outside.push(`存在不可逆外部影响：${value.externalEffects.evidence}`);
  for (const item of value.exclusions) {
    if (item.kind === "irreversible_data_operation") outside.push(`不可逆操作需要独立授权：${item.evidence}`);
    else outside.push(`高复杂度工作需人工主导 ${item.kind}：${item.evidence}`);
  }
  for (const file of draft.affectedFiles.filter((file) => restrictedAdmissionFile(file, policy))) outside.push(`需人工主导的路径：${file}`);
  for (const [key, label] of [["coordination", "跨系统协调"], ["verification", "验证依据"], ["externalEffects", "外部影响"]]) if (value[key].status === "unknown") unresolved.push(`${label}待明确：${value[key].evidence}`);
  if (value.recovery.status === "unresolved") unresolved.push(`恢复方式待明确：${value.recovery.evidence}`);
  if ((draft.impacts.data.status === "changed" || value.externalEffects.status === "reversible") && value.recovery.status !== "documented") unresolved.push("数据或外部影响需要独立恢复依据，代码快照不能恢复这些影响");
  for (const [key, label] of [["existingBehavior", "历史功能"], ["interfaces", "接口"], ["data", "数据"]]) {
    if (draft.impacts[key].status === "unknown") unresolved.push(`${label}影响待明确：${draft.impacts[key].evidence}`);
  }
  const risk = warnings.length > 0 || value.externalEffects.status !== "none" || Object.values(draft.impacts).some((impact) => impact.status !== "none");
  const status = outside.length ? "out_of_scope" : unresolved.length ? "needs_clarification" : risk ? "conditional" : "accepted";
  return { schemaVersion: 1, status, label: admissionNames[status], eligible: ["accepted", "conditional"].includes(status),
    reasons: outside.length ? [...outside, ...unresolved] : unresolved, warnings, requiresHumanApproval: true,
    policyHash: sha256(JSON.stringify(policy)), scope: { files: draft.affectedFiles.length, modules: value.modules.map((item) => item.name),
      deliveryUnits: value.deliveryUnits.map((item) => item.name), estimatedChangedLines: value.estimatedChangedLines } };
}

const executionEvents = new Set(["plan_draft_completed", "plan_specialist_completed", "plan_specialist_failed",
  "plan_correction_completed", "plan_correction_failed",
  "plan_attempt_failed", "implemented", "implementation_failed", "implementation_inspection_failed", "role_review_submitted", "role_review_attempt_failed",
  "intake_analysis_completed", "intake_analysis_failed", "plan_reply", "plan_discussion_failed"]);

export function executionUsage(events) {
  const runs = events.filter((event) => executionEvents.has(event.type) && event.detail.modelRun !== false
    && (event.type !== "role_review_submitted" || event.detail.run));
  let totalTokens = 0;
  let modelMs = 0;
  let unmeasuredCalls = 0;
  let calls = 0;
  for (const event of runs) {
    const telemetry = event.detail.run?.telemetry ?? event.detail.telemetry;
    if (telemetry?.unmeasuredRequests > 0) { unmeasuredCalls++; continue; }
    const values = ["input", "output", "cacheRead", "cacheWrite"].map((key) => telemetry?.tokens?.[key]);
    if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)
        || !Number.isSafeInteger(telemetry?.durationMs) || telemetry.durationMs < 0
        || !Number.isSafeInteger(telemetry?.assistantMessages) || telemetry.assistantMessages < 0) { unmeasuredCalls++; continue; }
    calls += telemetry.assistantMessages;
    totalTokens += values.reduce((sum, value) => sum + value, 0);
    modelMs += telemetry.durationMs;
  }
  return { calls, totalTokens, modelMs, unmeasuredCalls };
}

export function modelAllowance(events, policy, calls = 1) {
  const usage = executionUsage(events);
  if (usage.unmeasuredCalls) throw new Error("Execution budget has unmeasured model calls; further model execution is blocked");
  if ((policy.budgetMode === "strict" && (usage.calls + calls > policy.maxModelCalls || usage.totalTokens >= policy.maxTotalTokens)) || usage.modelMs >= policy.maxModelMs) {
    throw new Error("Requirement execution budget exhausted; hand off to the responsible developer");
  }
  const scope = events.findLast(event => event.type === "plan_draft_completed")?.detail.admission?.scope;
  const complexity = !scope ? "planning" : scope.files <= 3 && scope.modules.length === 1 && scope.estimatedChangedLines <= 150
    ? "small" : scope.files <= 6 && scope.estimatedChangedLines <= 400 ? "standard" : "bounded_complex";
  const expectedTokens = { planning: 60000, small: 30000, standard: 60000, bounded_complex: 120000 }[complexity];
  return { maxTokens: policy.budgetMode === "strict" ? policy.maxTotalTokens - usage.totalTokens : expectedTokens,
    maxMs: policy.maxModelMs - usage.modelMs,
    maxRequests: policy.budgetMode === "strict" ? policy.maxModelCalls - usage.calls : policy.maxModelCalls,
    budget: { mode: policy.budgetMode, complexity, expectedTokens, usedTokens: usage.totalTokens,
      projectTokenTarget: policy.maxTotalTokens, estimateExceeded: usage.totalTokens >= expectedTokens,
      projectCallTarget: policy.maxModelCalls, usedCalls: usage.calls, callEstimateExceeded: usage.calls >= policy.maxModelCalls,
      maxRepairAttempts: complexity === "bounded_complex" ? 4 : complexity === "standard" ? 3 : 2 } };
}

export function firstVerificationQuality(tasks) {
  const outcomes = tasks.map((task) => task.events.find((event) => ["verified", "verification_failed"].includes(event.type)
    || (event.type === "implemented" && [...event.detail?.telemetry?.internalChecks ?? [],
      ...event.detail?.telemetry?.developmentChecks ?? []].some(check => check.status !== "passed")))).filter(Boolean);
  const passed = outcomes.filter((event) => event.type === "verified").length;
  return { sampleSize: outcomes.length, passed, failed: outcomes.length - passed,
    rate: outcomes.length ? passed / outcomes.length : null,
    definition: "首次实施配置检查通过率；同会话内部检查失败也计为未通过，不代表人工验收通过率或不存在缺陷" };
}

export function firstDeliveryQuality(tasks) {
  const outcomes = tasks.map((task) => task.events.find((event) => ["verified", "verification_failed",
    "implementation_failed", "implementation_inspection_failed", "implementation_interrupted"].includes(event.type)
    || (event.type === "implemented" && (event.detail?.source === "owner_reviewed_replacement"
      || [...event.detail?.telemetry?.internalChecks ?? [], ...event.detail?.telemetry?.developmentChecks ?? []]
        .some(check => check.status !== "passed"))))).filter(Boolean);
  const passed = outcomes.filter((event) => event.type === "verified").length;
  return { sampleSize: outcomes.length, passed, failed: outcomes.length - passed,
    rate: outcomes.length ? passed / outcomes.length : null,
    definition: "首次实施及配置验证通过率；实施失败、中断、内部检查失败、具名辅助修复和验证失败均计为未通过，未完成验证的成功实施不进入样本；不代表人工验收或线上无缺陷" };
}

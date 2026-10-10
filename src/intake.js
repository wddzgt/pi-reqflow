import { promises as fs } from "node:fs";
import path from "node:path";
import { allowedFile, loadProject } from "./config.js";
import { baselineAgentContext, readProjectBaseline } from "./baseline.js";
import { manifest, manifestHash, safeId, sha256 } from "./files.js";
import { runPi } from "./pi-runner.js";
import { appendEvent, readTask, taskPath, withLock } from "./store.js";
import { preparePlanWorkspace, sourceManifest } from "./workspace.js";
import { resolveStandards, standardsPrompt } from "./standards.js";
import { assertIntakeAgreement } from "./intake-conversation.js";
import { admissionPolicy, modelAllowance } from "./admission.js";

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
}

export function feedbackInput(value) {
  if (!value || typeof value !== "object") throw new Error("Development feedback is required");
  nonempty(value.summary, "feedback.summary");
  if (!Array.isArray(value.questions)) throw new Error("feedback.questions must be an array");
  for (const item of value.questions) { safeId(item.id); nonempty(item.text, "feedback question"); }
  if (new Set(value.questions.map((item) => item.id)).size !== value.questions.length) throw new Error("Duplicate feedback question");
  if (!Array.isArray(value.requiredRoles) || !value.requiredRoles.includes("qa")
      || !value.requiredRoles.some((role) => role === "frontend" || role === "backend")
      || value.requiredRoles.some((role) => !["frontend", "backend", "qa"].includes(role))
      || new Set(value.requiredRoles).size !== value.requiredRoles.length) {
    throw new Error("Required roles must include QA and at least one development role");
  }
  return value;
}

export function contractInput(value, feedback, business = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Requirement contract is required");
  for (const key of ["objective", "currentBehavior", "desiredBehavior"]) nonempty(value[key], `contract.${key}`);
  if (!Array.isArray(value.acceptance) || !value.acceptance.length) throw new Error("contract.acceptance is required");
  for (const item of value.acceptance) { safeId(item.id); nonempty(item.text, "acceptance text"); }
  if (new Set(value.acceptance.map((item) => item.id)).size !== value.acceptance.length) throw new Error("Duplicate acceptance ID");
  for (const key of ["inScope", "outOfScope"]) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`contract.${key} must be an array of nonempty strings`);
    }
  }
  if (!value.answers || typeof value.answers !== "object" || Array.isArray(value.answers)) throw new Error("contract.answers is required");
  for (const question of feedback.questions) nonempty(value.answers[question.id], `answer to ${question.id}`);
  if (business) {
    const keys = ["objective", "currentBehavior", "desiredBehavior", "acceptance", "inScope", "outOfScope", "answers"];
    if (Object.keys(value).some((key) => !keys.includes(key)) || Object.keys(value.answers).length
        || value.acceptance.some((item) => Object.keys(item).some((key) => !["id", "text"].includes(key)))) {
      throw new Error("Final business requirement must consolidate decisions and exclude discussion answers or technical fields");
    }
    const text = [value.objective, value.currentBehavior, value.desiredBehavior,
      ...value.acceptance.map((item) => item.text), ...value.inScope, ...value.outOfScope].join("\n");
    if (/`|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S/.test(text)
        || business.sourceFiles.some((file) => text.includes(file))) {
      throw new Error("Product requirement must describe business behavior, not source files, code or HTTP definitions");
    }
  }
  return value;
}

export async function recordDevFeedback(projectPath, id, actor, feedback) {
  nonempty(actor, "developer");
  feedbackInput(feedback);
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    if (meta.state !== "intake_assigned") throw new Error(`Task ${id} is ${meta.state}; expected intake_assigned`);
    if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted") {
      throw new Error("Only the accepted developer can submit development feedback");
    }
    const file = path.join(directory, "development-feedback-v1.json");
    await fs.writeFile(file, `${JSON.stringify(feedback, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const next = { ...meta, state: "intake_feedback", feedbackVersion: 1, feedbackHash: sha256(JSON.stringify(feedback)),
      requiredRoles: feedback.requiredRoles, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "development_feedback", next, { actor, feedbackFile: file, feedbackHash: next.feedbackHash });
    return next;
  });
}

export async function confirmContract(projectPath, id, actor, contract, expectedAnalysisHash) {
  nonempty(actor, "product owner");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const task = await readTask(project, id);
    const { meta, directory } = task;
    if (!["intake_feedback", "intake_ready"].includes(meta.state)) throw new Error(`Task ${id} is ${meta.state}; expected reviewed intake`);
    if (meta.createdBy !== actor) throw new Error("Only the product owner who submitted this task can confirm its contract");
    if (meta.aiAligned && expectedAnalysisHash !== meta.intakeAnalysisHash) throw new Error("AI agreement changed or its reviewed version was omitted; reload before finalizing");
    const agreement = meta.aiAligned ? await assertIntakeAgreement(project, task, contract) : null;
    const feedback = JSON.parse(await fs.readFile(path.join(directory, `development-feedback-v${meta.feedbackVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(feedback)) !== meta.feedbackHash) throw new Error("Development feedback changed after review");
    contractInput(contract, feedback);
    const version = (meta.contractVersion ?? 0) + 1;
    const file = path.join(directory, `contract-v${version}.json`);
    await fs.writeFile(file, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const next = { ...meta, state: "contract_confirmed", contractVersion: version,
      contractHash: sha256(JSON.stringify(contract)), productConfirmedBy: actor,
      productConfirmedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "contract_confirmed", next, { actor, contractFile: file, contractHash: next.contractHash,
      ...(agreement ? { agreement } : {}) });
    return next;
  });
}

export async function reviseContract(projectPath, id, actor, contract) {
  nonempty(actor, "product owner");
  const project = await loadProject(projectPath);
  if ((await readTask(project, id)).meta.aiAligned) {
    const { addIntakeMessage } = await import("./intake-conversation.js");
    return addIntakeMessage(projectPath, id, actor, { text: "产品修订候选需求，请重新核对目标、验收与范围。", candidate: contract });
  }
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    if (!["contract_confirmed", "role_review", "review_passed", "plan_review"].includes(meta.state)) {
      throw new Error(`Contract cannot be revised from ${meta.state}`);
    }
    if (meta.createdBy !== actor) throw new Error("Only the product owner can revise this contract");
    const feedback = JSON.parse(await fs.readFile(path.join(directory, `development-feedback-v${meta.feedbackVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(feedback)) !== meta.feedbackHash) throw new Error("Development feedback changed");
    const previousContract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(previousContract)) !== meta.contractHash) throw new Error("Prior contract changed");
    contractInput(contract, feedback);
    const version = meta.contractVersion + 1;
    const file = path.join(directory, `contract-v${version}.json`);
    await fs.writeFile(file, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const hash = sha256(JSON.stringify(contract));
    const next = { ...meta, state: "contract_confirmed", contractVersion: version, contractHash: hash,
      reviewHashes: {}, reviewBaselineHash: null, reviewStandardsHash: null,
      roleReviewHash: null, developmentFiles: null, planHash: null, planAnalysisHash: null,
      admission: null, admissionPolicyHash: null, executionBoundary: null,
      planBlockers: [], planFeedbackVersion: null, productConfirmedBy: actor,
      productConfirmedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "contract_revised", next,
      { actor, previousContractHash: meta.contractHash, contractFile: file, contractHash: hash });
    return next;
  });
}

function reviewInput(value, contract, meta) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Role review is required");
  if (!meta.requiredRoles.includes(value.role)) throw new Error(`Role is not required: ${value.role}`);
  if (value.contractHash !== meta.contractHash) throw new Error("Role review uses a different contract version");
  nonempty(value.evidence, "review.evidence");
  const expected = contract.acceptance.map((item) => item.id).sort();
  if (!Array.isArray(value.coveredAcceptanceIds)
      || JSON.stringify([...value.coveredAcceptanceIds].sort()) !== JSON.stringify(expected)) {
    throw new Error("Role review must cover every acceptance condition exactly once");
  }
  if (!value.judgments || typeof value.judgments !== "object"
      || ["objective", "desiredBehavior", "scope", "acceptance"].some((key) => !["agree", "unclear", "conflict"].includes(value.judgments[key]))) {
    throw new Error("Role review judgments are incomplete");
  }
  if (!value.interfaceDecisions || typeof value.interfaceDecisions !== "object" || Array.isArray(value.interfaceDecisions)
      || Object.keys(value.interfaceDecisions).length === 0
      || Object.entries(value.interfaceDecisions).some(([key, decision]) => !key.trim() || typeof decision !== "string" || !decision.trim())) {
    throw new Error("review.interfaceDecisions must state shared interface decisions, including no-impact when applicable");
  }
  if (!Array.isArray(value.blockers) || value.blockers.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("review.blockers must be an array of nonempty strings");
  }
  if (value.role === "qa") {
    if (!Array.isArray(value.testScenarios) || JSON.stringify(value.testScenarios.map((item) => item.acceptanceId).sort()) !== JSON.stringify(expected)
        || value.testScenarios.some((item) => typeof item.scenario !== "string" || !item.scenario.trim())) {
      throw new Error("QA review needs one test scenario for each acceptance condition");
    }
  }
  if (meta.aiAligned && (!Array.isArray(value.affectedFiles) || !value.affectedFiles.length
      || value.affectedFiles.some((file) => typeof file !== "string" || !file.trim()
        || path.posix.isAbsolute(file) || file.includes("\\") || path.posix.normalize(file) !== file
        || file.split("/").includes(".."))
      || new Set(value.affectedFiles).size !== value.affectedFiles.length)) {
    throw new Error("Development review must independently identify affected source and regression files");
  }
  return value;
}

async function persistRoleReview(project, id, meta, directory, actor, review, run = null) {
  if (meta.reviewHashes?.[review.role]) throw new Error(`Role already reviewed: ${review.role}`);
  const sourceHash = manifestHash(await sourceManifest(project));
  const baseline = await readProjectBaseline(project, sourceHash);
  if (meta.aiAligned && review.affectedFiles.some((file) => !allowedFile(file, project.config))) {
    throw new Error("Development review identified files outside project policy");
  }
  const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
  if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed");
  const standards = resolveStandards(project.config, meta.aiAligned ? Object.keys(baseline.files) : contract.inScope);
  if (meta.reviewBaselineHash && meta.reviewBaselineHash !== baseline.snapshotHash) {
    throw new Error("Project baseline changed between role reviews; revise the contract and review one baseline");
  }
  if (meta.reviewStandardsHash && meta.reviewStandardsHash !== standards.hash) {
    throw new Error("Coding standards changed between role reviews; revise the contract and review one standard version");
  }
  const file = path.join(directory, `review-v${meta.contractVersion}-${review.role}.json`);
  await fs.writeFile(file, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const hash = sha256(JSON.stringify(review));
  const next = { ...meta, state: "role_review", reviewHashes: { ...meta.reviewHashes, [review.role]: hash },
    reviewBaselineHash: baseline.snapshotHash,
    reviewStandardsHash: standards.hash,
    reviewCostUsd: meta.reviewCostUsd + (run?.costUsd ?? 0), updatedAt: new Date().toISOString() };
  await appendEvent(project, id, "role_review_submitted", next, { actor, role: review.role, reviewFile: file, reviewHash: hash,
    contractHash: meta.contractHash, baselineHash: baseline.snapshotHash,
    standardsHash: standards.hash, run });
  return next;
}

export async function submitRoleReview(projectPath, id, actor, review) {
  nonempty(actor, "review actor");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    if (!["contract_confirmed", "role_review"].includes(meta.state)) {
      throw new Error(`Task ${id} is ${meta.state}; expected contract_confirmed or role_review`);
    }
    const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed");
    reviewInput(review, contract, meta);
    return persistRoleReview(project, id, meta, directory, actor, review);
  });
}

export async function runRoleReviewWithPi(projectPath, id, role, initiator) {
  nonempty(initiator, "review initiator");
  if (!["frontend", "backend", "qa"].includes(role)) throw new Error(`Unsupported review role: ${role}`);
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    if (!["contract_confirmed", "role_review"].includes(meta.state)) {
      throw new Error(`Task ${id} is ${meta.state}; expected contract_confirmed or role_review`);
    }
    if (!meta.requiredRoles.includes(role)) throw new Error(`Role is not required: ${role}`);
    if (meta.reviewHashes?.[role]) throw new Error(`Role already reviewed: ${role}`);
    let allowance;
    try { allowance = modelAllowance(events, admissionPolicy(project.config)); }
    catch (error) {
      await appendEvent(project, id, "execution_boundary_stopped", { ...meta, executionBoundary: [error.message] }, { error: error.message, phase: "review", role, initiatedBy: initiator });
      throw error;
    }
    const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed");
    const source = await sourceManifest(project);
    const baseHash = manifestHash(source);
    const projectBaseline = await readProjectBaseline(project, baseHash);
    if (meta.reviewBaselineHash && meta.reviewBaselineHash !== projectBaseline.snapshotHash) {
      throw new Error("Project baseline changed between role reviews; revise the contract and review one baseline");
    }
    const standards = resolveStandards(project.config, meta.aiAligned ? Object.keys(projectBaseline.files) : contract.inScope);
    if (meta.reviewStandardsHash && meta.reviewStandardsHash !== standards.hash) {
      throw new Error("Coding standards changed between role reviews; revise the contract and review one standard version");
    }
    const remainingCost = project.config.maxCostUsd - meta.reviewCostUsd - meta.intakeCostUsd - (meta.planCostUsd ?? 0);
    if (remainingCost <= 0) {
      await appendEvent(project, id, "pi_budget_exhausted", meta, { phase: "review", role, initiatedBy: initiator,
        reason: "Requirement cost budget exhausted" });
      throw new Error("Requirement cost budget exhausted before role review");
    }
    const attempt = (meta.reviewAttempts[role] ?? 0) + 1;
    const active = { ...meta, reviewAttempts: { ...meta.reviewAttempts, [role]: attempt } };
    const logFile = path.join(directory, `role-${role}-attempt-${attempt}.events.jsonl`);
    const roleFocus = { frontend: "界面行为、交互与接口边界", backend: "接口、数据及既有逻辑", qa: "验收可测性、边界和回归" }[role];
    const prompt = `你是独立的${role}评审 Agent。只读调研现有代码，聚焦${roleFocus}；不得修改文件。你只能看到产品已确认的最终需求，不读取原始需求或沟通历史，不得假设其他角色的结论。产品给出业务目标、行为、规则、功能范围和验收口径；你负责独立定位代码、接口、数据和回归文件，不让产品指定技术实现。\n适用代码规范（规范哈希 ${standards.hash}；这是写法要求，不代表已通过机器检查）：${standardsPrompt(standards)}\n项目全局基线仅是静态线索，必须以代码核实，未知项不能推断：${await baselineAgentContext(project, projectBaseline)}\n契约哈希：${meta.contractHash}\n契约 JSON：${JSON.stringify(contract)}\n只返回一个合法 JSON 对象，不要 Markdown 围栏。字段必须是 role（值为 ${role}）、contractHash、coveredAcceptanceIds（每条验收 ID 恰好一次）、judgments（objective、desiredBehavior、scope、acceptance，每项为 agree、unclear 或 conflict）、interfaceDecisions（受影响共享接口的键和值；无对外接口时用 noExternalInterface: none）、blockers（字符串数组）、evidence（简短代码证据）${meta.aiAligned ? "、affectedFiles（你基于代码独立定位的现有源文件及回归文件，相对项目路径，不改变业务范围）" : ""}${role === "qa" ? "、testScenarios（每条验收 ID 对应 acceptanceId 和 scenario）" : ""}。不确定就用 unclear 并写 blockers；不要为了通过门禁而猜测。`;
    let result;
    let review;
    try {
      const workspace = await preparePlanWorkspace(project, id, `review-${role}-${attempt}`, source);
      result = await runPi(project, workspace, "review", prompt, logFile, remainingCost, role, [], { ...allowance,
        outputSchema: { name: "role_review", strict: true, schema: { type: "object", additionalProperties: false,
          required: ["role", "contractHash", "coveredAcceptanceIds", "judgments", "interfaceDecisions", "blockers", "evidence",
            ...(meta.aiAligned ? ["affectedFiles"] : []), ...(role === "qa" ? ["testScenarios"] : [])],
          properties: { role: { type: "string", enum: [role] }, contractHash: { type: "string", enum: [meta.contractHash] },
            coveredAcceptanceIds: { type: "array", minItems: contract.acceptance.length, maxItems: contract.acceptance.length,
              items: { type: "string", enum: contract.acceptance.map(item => item.id) } },
            judgments: { type: "object", additionalProperties: false, required: ["objective", "desiredBehavior", "scope", "acceptance"],
              properties: Object.fromEntries(["objective", "desiredBehavior", "scope", "acceptance"].map(key => [key,
                { type: "string", enum: ["agree", "unclear", "conflict"] }])) },
            interfaceDecisions: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } },
            blockers: { type: "array", items: { type: "string", minLength: 1 } }, evidence: { type: "string", minLength: 1 },
            ...(meta.aiAligned ? { affectedFiles: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } } : {}),
            ...(role === "qa" ? { testScenarios: { type: "array", minItems: contract.acceptance.length, maxItems: contract.acceptance.length,
              items: { type: "object", additionalProperties: false, required: ["acceptanceId", "scenario"], properties: {
                acceptanceId: { type: "string", enum: contract.acceptance.map(item => item.id) }, scenario: { type: "string", minLength: 1 } } } } } : {}),
          } } } });
      if (manifestHash(await manifest(workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== baseHash
          || manifestHash(await sourceManifest(project)) !== baseHash) {
        throw new Error("Project files changed during read-only role review");
      }
      review = JSON.parse(result.text);
      if (review.role !== role) throw new Error(`Pi returned a different review role: ${review.role}`);
      reviewInput(review, contract, meta);
      if (meta.aiAligned && review.affectedFiles.some((file) => !allowedFile(file, project.config))) {
        throw new Error("Development review identified files outside project policy");
      }
    } catch (error) {
      const costUsd = result?.costUsd ?? error.costUsd ?? 0;
      const failed = { ...active, reviewCostUsd: active.reviewCostUsd + costUsd, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "role_review_attempt_failed", failed, { actor: `pi:${role}`, initiatedBy: initiator,
        modelRun: Boolean(result || error.telemetry),
        role, logFile, costUsd, toolCalls: result?.toolCalls ?? error.toolCalls ?? 0,
        telemetry: result?.telemetry ?? error.telemetry ?? null, error: error.message });
      throw error;
    }
    return persistRoleReview(project, id, active, directory, `pi:${role}`, review,
      { initiatedBy: initiator, logFile, usage: result.usage, costUsd: result.costUsd,
        toolCalls: result.toolCalls, telemetry: result.telemetry });
  });
}

export async function finalizeRoleReview(projectPath, id, actor) {
  nonempty(actor, "review coordinator");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    if (meta.state !== "role_review") throw new Error(`Task ${id} is ${meta.state}; expected role_review`);
    const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed");
    const missing = meta.requiredRoles.filter((role) => !meta.reviewHashes?.[role]);
    if (missing.length) throw new Error(`Missing role reviews: ${missing.join(", ")}`);
    const projectBaseline = await readProjectBaseline(project);
    if (meta.reviewBaselineHash !== projectBaseline.snapshotHash) {
      throw new Error("Role reviews do not match the current project baseline");
    }
    if (meta.reviewStandardsHash !== resolveStandards(project.config, meta.aiAligned ? Object.keys(projectBaseline.files) : contract.inScope).hash) {
      throw new Error("Role reviews do not match the current coding standards");
    }
    const reviews = [];
    for (const role of meta.requiredRoles) {
      const review = JSON.parse(await fs.readFile(path.join(directory, `review-v${meta.contractVersion}-${role}.json`), "utf8"));
      if (sha256(JSON.stringify(review)) !== meta.reviewHashes[role]) throw new Error(`Role review changed: ${role}`);
      reviewInput(review, contract, meta);
      reviews.push(review);
    }
    const blockers = reviews.flatMap((review) => review.blockers.map((item) => `${review.role}: ${item}`));
    for (const review of reviews) {
      for (const [field, judgment] of Object.entries(review.judgments)) {
        if (judgment !== "agree") blockers.push(`${review.role}: ${field} is ${judgment}`);
      }
    }
    const canonical = (value) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    const decisions = canonical(reviews[0].interfaceDecisions);
    for (const review of reviews.slice(1)) {
      if (canonical(review.interfaceDecisions) !== decisions) blockers.push(`${review.role}: interface decisions differ`);
    }
    if (blockers.length) {
      await appendEvent(project, id, "role_review_blocked", meta, { actor, contractHash: meta.contractHash, blockers });
      throw new Error(`Role review has blocking differences: ${blockers.join("; ")}`);
    }
    const affectedFiles = meta.aiAligned ? [...new Set(reviews.flatMap((review) => review.affectedFiles))].sort() : contract.inScope;
    if (meta.aiAligned && affectedFiles.some((file) => !allowedFile(file, project.config))) {
      throw new Error("Development review identified files outside project policy");
    }
    const summary = { contractHash: meta.contractHash, baselineHash: projectBaseline.snapshotHash,
      standardsHash: meta.reviewStandardsHash,
      affectedFiles,
      roles: meta.requiredRoles, interfaceDecisions: reviews[0].interfaceDecisions,
      reviewHashes: meta.reviewHashes };
    const next = { ...meta, state: "review_passed", developmentFiles: affectedFiles, roleReviewHash: sha256(JSON.stringify(summary)),
      updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "role_review_passed", next, { actor, summary });
    return next;
  });
}

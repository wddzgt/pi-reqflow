import { promises as fs } from "node:fs";
import path from "node:path";
import { allowedFile } from "./config.js";
import { manifest, manifestHash, sha256 } from "./files.js";
import { runPi } from "./pi-runner.js";
import { appendEvent, readTask } from "./store.js";
import { sourceManifest } from "./workspace.js";
import { admissionInput, admissionPolicy, assessAdmission, modelAllowance, validateAdmissionPolicy } from "./admission.js";
import { designSchema, validateDesign, designMarkdown } from "./design-document.js";

export const planSections = ["需求与验收", "拟改位置与做法", "验证", "风险与回退", "待确认"];
export const planMaterialSections = ["approach", "frontend", "backend", "data", "interfaces", "components", "diagrams", "changes", "verification", "validation", "impacts", "boundaries", "specialists", "discussion"];

export async function readPlanMaterial(project, id, input) {
  if (!input || !planMaterialSections.includes(input.section) || !/^[a-f0-9]{64}$/.test(input.planHash ?? "")
      || !Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.maxChars)
      || input.maxChars < 1 || input.maxChars > 3000) throw new Error("Plan material reads need the exact version, section and a bounded character range");
  const task = await readTask(project, id);
  let analysis;
  if (task.meta.planHash === input.planHash) analysis = await readPlanAnalysis(task.meta, task.directory);
  else {
    const checkpoint = task.events.findLast(event => ["plan_draft_completed", "plan_draft_reused", "plan_correction_completed", "plan_correction_reused"].includes(event.type)
      && event.meta.planAttempts === task.meta.planAttempts);
    if (task.meta.state !== "contract_confirmed" || !checkpoint || checkpoint.detail.analysisHash !== input.planHash)
      throw new Error("Plan material version changed; reload the current plan");
    if (path.dirname(checkpoint.detail.draftFile) !== task.directory) throw new Error("Plan draft material belongs to another requirement");
    const draft = JSON.parse(await fs.readFile(checkpoint.detail.draftFile, "utf8"));
    if (sha256(JSON.stringify(draft)) !== input.planHash || draft.contractHash !== task.meta.contractHash)
      throw new Error("Plan draft material changed");
    analysis = { draft, specialists: task.events.filter(event => event.type === "plan_specialist_completed"
      && event.detail.contextHash === checkpoint.detail.contextHash && event.detail.findings.analysisHash === input.planHash)
      .map(event => ({ role: event.detail.role, findings: event.detail.findings })) };
  }
  let material;
  if (input.section === "discussion") material = task.events.filter(event => event.meta.planVersion === task.meta.planVersion
    && ["plan_message", "plan_reply"].includes(event.type)).map(event => ({ eventHash: event.hash,
      role: event.type === "plan_message" ? "developer" : "ai", text: event.detail.text, reply: event.detail.reply }));
  else if (input.section === "specialists") material = analysis.specialists.map(row => ({ role: row.role, findings: row.findings.findings }));
  else material = Object.hasOwn(analysis.draft, input.section) ? analysis.draft[input.section] : analysis.draft.design?.[input.section];
  if (material === undefined) throw new Error("Requested design section is absent from this plan version");
  const text = typeof material === "string" ? material : JSON.stringify(material);
  if (input.offset >= text.length && (text.length > 0 || input.offset > 0)) throw new Error("Plan material offset exceeds the selected section");
  const result = { taskId: id, planHash: input.planHash, contractHash: task.meta.contractHash, baseHash: task.meta.baseHash,
    section: input.section, offset: input.offset, totalChars: text.length, text: text.slice(input.offset, input.offset + input.maxChars),
    partial: input.offset > 0 || text.length > input.maxChars, note: "Verified archived plan material. Proposals and AI advice are not approval; source and frozen requirements remain authoritative." };
  const byteLimit = project.config.modelUsage?.maxToolResultBytes ?? 8000;
  let low = 0, high = result.text.length;
  const page = result.text;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    result.text = page.slice(0, length);
    if (Buffer.byteLength(JSON.stringify(result)) <= byteLimit) low = length;
    else high = length - 1;
  }
  result.text = page.slice(0, low);
  result.partial = input.offset > 0 || input.offset + low < text.length;
  if ((!low && page.length) || Buffer.byteLength(JSON.stringify(result)) > byteLimit)
    throw new Error("Configured tool result budget cannot contain a plan material page");
  return result;
}
export const candidateReviewSchema = { type: "object", additionalProperties: false,
  required: ["proposalHash", "status", "reasons"], properties: {
    proposalHash: { type: "string" }, status: { type: "string", enum: ["accepted", "adjusted", "product_confirmation", "human_led"] },
    reasons: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 500 } } } };

export const planOutputSchema = { name: "delivery_plan", strict: true, schema: {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "contractHash", "affectedFiles", "changes", "domains", "impacts", "verification", "validation", "openQuestions", "boundaries", "design"],
  properties: {
    schemaVersion: { type: "integer", enum: [2] }, contractHash: { type: "string" }, design: designSchema,
    affectedFiles: { type: "array", minItems: 1, description: "Each project-relative file appears exactly once within project policy; file count is a planning estimate.", items: { type: "string", minLength: 1 } },
    changes: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
      required: ["file", "description"], properties: { file: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1, maxLength: 500 } } } },
    domains: { type: "array", minItems: 1, maxItems: 5, description: "Distinct affected domains; never repeat an enum value. Uniqueness is checked by the application.", items: { type: "string", enum: ["frontend", "backend", "database", "infrastructure", "documentation"] } },
    impacts: { type: "object", additionalProperties: false, required: ["existingBehavior", "interfaces", "data"],
      properties: Object.fromEntries(["existingBehavior", "interfaces", "data"].map(key => [key, {
        type: "object", additionalProperties: false, required: ["status", "evidence"], properties: {
          status: { type: "string", enum: ["none", "changed", "unknown"] }, evidence: { type: "string", minLength: 1, maxLength: 1000 } } }])) },
    verification: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
      required: ["acceptanceId", "scenario", "regression"], properties: {
        acceptanceId: { type: "string" }, scenario: { type: "string", minLength: 1, maxLength: 1000 },
        regression: { type: "string", minLength: 1, maxLength: 1000 } } } },
    validation: { type: "object", additionalProperties: false, required: ["checks", "skipped", "manualReason", "startup"], properties: {
      checks: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["command", "reason"], properties: { command: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
          reason: { type: "string", minLength: 1, maxLength: 1000 } } } },
      skipped: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["command", "reason"], properties: { command: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
          reason: { type: "string", minLength: 1, maxLength: 1000 } } } },
      manualReason: { type: "string", maxLength: 1000 },
      startup: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["name", "command", "healthUrl", "applicationUrl"], properties: { name: { type: "string", minLength: 1, maxLength: 100 },
          command: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
          healthUrl: { type: "string", minLength: 1, maxLength: 2000 },
          applicationUrl: { anyOf: [{ type: "string", minLength: 1, maxLength: 2000 }, { type: "null" }],
            description: "Browser entry for this service; null for a service without an application page. Never substitute a health endpoint." } } } },
    } },
    openQuestions: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: 500 } },
    boundaries: { type: "object", additionalProperties: false,
      required: ["modules", "deliveryUnits", "designStages", "estimatedChangedLines", "coordination", "verification", "recovery", "externalEffects", "exclusions"],
      properties: {
        modules: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
          required: ["name", "files", "evidence"], properties: { name: { type: "string", minLength: 1, maxLength: 100 },
            files: { type: "array", minItems: 1, items: { type: "string" } }, evidence: { type: "string", minLength: 1, maxLength: 1000 } } } },
        deliveryUnits: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
          required: ["name", "evidence"], properties: { name: { type: "string", minLength: 1, maxLength: 100 },
            evidence: { type: "string", minLength: 1, maxLength: 1000 } } } },
        designStages: { type: "integer", minimum: 1 }, estimatedChangedLines: { type: "integer", minimum: 1 },
        ...Object.fromEntries([["coordination", ["none", "required", "unknown"]], ["verification", ["ready", "unknown"]],
          ["recovery", ["code_only", "documented", "unresolved"]], ["externalEffects", ["none", "reversible", "irreversible", "unknown"]]]
          .map(([key, statuses]) => [key, { type: "object", additionalProperties: false, required: ["status", "evidence"],
            properties: { status: { type: "string", enum: statuses }, evidence: { type: "string", minLength: 1, maxLength: 1000 } } }])),
        exclusions: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false,
          required: ["kind", "evidence"], properties: { kind: { type: "string", enum: ["architecture_redesign", "staged_migration", "core_security_rework", "framework_upgrade", "exploratory_work", "irreversible_data_operation"] },
            evidence: { type: "string", minLength: 1, maxLength: 1000 } } } },
      } },
  },
} };

export function planAnalysisInput(value, contract, project, correction = null) {
  if (correction !== null) {
    const original = correction.draft;
    const fields = ["affectedFiles", "changes", "domains", "impacts", "verification", "validation", "openQuestions", "boundaries", "design",
      ...(original.candidateReview ? ["candidateReview"] : [])];
    if (!value || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)))
      throw new Error("局部纠错必须包含所有修改字段；未修改字段显式为 null。");
    const patch = value;
    const { markdown, ...originalFields } = original;
    value = structuredClone(originalFields);
    for (const key of fields.filter(key => !["changes", "verification", "design"].includes(key))) if (patch[key] !== null) value[key] = patch[key];
    if (patch.changes !== null) {
      if (!Array.isArray(patch.changes) || new Set(patch.changes.map(row => row.file)).size !== patch.changes.length
          || patch.changes.some(row => !value.affectedFiles.includes(row.file)))
        throw new Error("修改说明须按拟改文件提供唯一更新条目。");
      value.changes = value.affectedFiles.map(file => {
        const row = patch.changes.find(row => row.file === file) ?? original.changes.find(row => row.file === file);
        if (!row) throw new Error(`新增拟改文件缺少修改说明：${file}`);
        return row;
      });
    }
    if (patch.verification !== null) {
      const ids = contract.acceptance.map(item => item.id);
      if (typeof patch.verification !== "object" || Array.isArray(patch.verification)
          || Object.keys(patch.verification).length !== ids.length || ids.some(id => !Object.hasOwn(patch.verification, id)))
        throw new Error(`verification 修改必须按验收编号提供对象 ${ids.join(", ")}；未修改项为 null，不能返回局部数组。`);
      value.verification = original.verification.map(item => {
        const update = patch.verification[item.acceptanceId];
        if (update === null) return item;
        if (!update || Object.keys(update).length !== 2 || !Object.hasOwn(update, "scenario") || !Object.hasOwn(update, "regression"))
          throw new Error(`verification.${item.acceptanceId} 必须包含 scenario 和 regression，或为 null。`);
        return { acceptanceId: item.acceptanceId, ...update };
      });
    }
    if (patch.design !== null) {
      const sections = Object.keys(designSchema.properties);
      if (!patch.design || Object.keys(patch.design).length !== sections.length || sections.some(key => !Object.hasOwn(patch.design, key)))
        throw new Error("design 修改必须包含所有小节；未修改小节显式为 null。");
      for (const key of sections.filter(key => !["components", "interfaces"].includes(key)))
        if (patch.design[key] !== null) value.design[key] = patch.design[key];
      if (patch.design.components !== null) {
        const updates = patch.design.components;
        if (!Array.isArray(updates) || new Set(updates.map(row => row.file)).size !== updates.length
            || updates.some(row => !value.affectedFiles.includes(row.file)))
          throw new Error(`关键逻辑须按拟改文件提供唯一更新条目；本轮拟改路径为 ${JSON.stringify(value.affectedFiles)}，不能使用旧版本或猜测的组件路径。`);
        value.design.components = value.affectedFiles.map(file => {
          const row = updates.find(row => row.file === file) ?? original.design.components.find(row => row.file === file);
          if (!row) throw new Error(`新增拟改文件缺少关键逻辑说明：${file}`);
          return row;
        });
      }
      if (patch.design.interfaces !== null) {
        const updates = patch.design.interfaces;
        if (!Array.isArray(updates) || new Set(updates.map(row => `${row.method}\n${row.path}`)).size !== updates.length)
          throw new Error("接口修改必须按 method/path 提供唯一更新条目。");
        value.design.interfaces = original.design.interfaces.map(row => updates.find(update =>
          update.method === row.method && update.path === row.path) ?? row);
        value.design.interfaces.push(...updates.filter(update => !original.design.interfaces.some(row =>
          row.method === update.method && row.path === update.path)));
      }
    }
  }
  if (!value || ![1, 2].includes(value.schemaVersion) || value.contractHash !== sha256(JSON.stringify(contract))) throw new Error("Plan analysis must reference the frozen requirement");
  if (!Array.isArray(value.affectedFiles) || !value.affectedFiles.length
      || new Set(value.affectedFiles).size !== value.affectedFiles.length
      || value.affectedFiles.some((file) => typeof file !== "string" || !file.trim() || path.posix.isAbsolute(file)
        || file.includes("\\") || path.posix.normalize(file) !== file || file.split("/").includes("..") || !allowedFile(file, project.config))) throw new Error("Plan analysis must identify unique files within project policy");
  if (!Array.isArray(value.domains) || !value.domains.length
      || value.domains.some((domain) => !["frontend", "backend", "database", "infrastructure", "documentation"].includes(domain))) throw new Error("Plan analysis must identify affected domains");
  if (new Set(value.domains).size !== value.domains.length) {
    throw new Error(`Plan analysis domains must be unique; repeated: ${value.domains.filter((domain, index) => value.domains.indexOf(domain) < index).join(", ")}`);
  }
  for (const kind of ["existingBehavior", "interfaces", "data"]) {
    const impact = value.impacts?.[kind];
    if (!impact || !["none", "changed", "unknown"].includes(impact.status) || typeof impact.evidence !== "string" || !impact.evidence.trim() || impact.evidence.length > 1000) throw new Error(`Plan analysis needs an explicit ${kind} impact and evidence`);
  }
  const ids = contract.acceptance.map((item) => item.id).sort();
  if (!Array.isArray(value.verification) || JSON.stringify(value.verification.map((item) => item.acceptanceId).sort()) !== JSON.stringify(ids)
      || value.verification.some((item) => [item.scenario, item.regression].some((text) => typeof text !== "string" || !text.trim() || text.length > 1000))) throw new Error("Plan analysis must cover each acceptance condition with a scenario and regression check");
  if (!Array.isArray(value.openQuestions) || value.openQuestions.length > 6
      || value.openQuestions.some((text) => typeof text !== "string" || !text.trim() || text.length > 500)) throw new Error("Plan analysis questions must be explicit and concise");
  if (!Array.isArray(value.changes) || value.changes.length !== value.affectedFiles.length
      || value.changes.some((item, index) => !item || item.file !== value.affectedFiles[index])) {
    throw new Error("Plan changes must describe each proposed file exactly once in scope order");
  }
  for (const [index, item] of value.changes.entries()) {
    if (typeof item.description !== "string" || !item.description.trim()) throw new Error(`Plan changes[${index}].description must be a nonempty string`);
    if (item.description.length > 500) throw new Error(`Plan changes[${index}].description for ${item.file} has ${item.description.length} characters; maximum is 500. Shorten this description without removing scope or acceptance checks`);
  }
  const validation = value.validation;
  if (!validation || Object.keys(validation).sort().join() !== "checks,manualReason,skipped,startup"
      || !Array.isArray(validation.checks)
      || !Array.isArray(validation.skipped)
      || !Array.isArray(validation.startup)
      || typeof validation.manualReason !== "string" || validation.manualReason.length > 1000
      || (!validation.checks.length && !validation.manualReason.trim()))
    throw new Error("方案必须明确影响范围内的检查、跳过理由及本地启动方式；无自动检查时须说明人工验证方式。");
  for (const item of [...validation.checks, ...validation.skipped, ...validation.startup]) {
    if (!item || !Array.isArray(item.command) || !item.command.length || item.command.length > 64
        || item.command.some(arg => typeof arg !== "string" || !arg.trim() || arg.length > 4000 || arg.includes("\0")))
      throw new Error("验证和启动命令必须是从项目根目录执行的参数数组。");
  }
  for (const item of [...validation.checks, ...validation.skipped]) {
    if (Object.keys(item).sort().join() !== "command,reason" || typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 1000)
      throw new Error("每条检查和跳过项必须说明源码依赖与验收依据。");
  }
  for (const item of validation.startup) {
    if (Object.keys(item).sort().join() !== "applicationUrl,command,healthUrl,name" || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100)
      throw new Error("本地启动服务必须提供名称、命令、健康检查地址和应用入口（无页面时为null）。");
    for (const address of [item.healthUrl, ...(item.applicationUrl === null ? [] : [item.applicationUrl])]) {
      if (typeof address !== "string" || !address || address.length > 2000) throw new Error("本地启动地址不能为空或缺失。");
      const url = new URL(address);
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          || url.username || url.password)
        throw new Error("本地启动地址必须为不含账号密码的回环 HTTP/HTTPS 地址。");
    }
  }
  const selected = validation.checks.map(item => JSON.stringify(item.command));
  if (new Set(selected).size !== selected.length || validation.skipped.some(item => selected.includes(JSON.stringify(item.command))))
    throw new Error("检查不能重复，也不能同时标记执行和跳过。");
  admissionInput(value.boundaries, value.affectedFiles);
  if (value.schemaVersion === 2) validateDesign(value);
  if (correction !== null) {
    for (const api of value.design.interfaces) {
      if (api.status !== "new" && !correction.sourceFiles.includes(api.sourceFile))
        throw new Error(`接口引用的源码不存在：${api.sourceFile}；请保留原方案已核实路径，或核实实际源码。`);
      if (api.status === "new" && !value.affectedFiles.includes(api.sourceFile))
        throw new Error(`新增接口的实现文件必须列入拟改文件：${api.sourceFile}。`);
    }
  }
  if (value.candidateReview && (!/^[a-f0-9]{64}$/.test(value.candidateReview.proposalHash ?? "")
      || !["accepted", "adjusted", "product_confirmation", "human_led"].includes(value.candidateReview.status)
      || !Array.isArray(value.candidateReview.reasons) || !value.candidateReview.reasons.length || value.candidateReview.reasons.length > 4
      || value.candidateReview.reasons.some(text => typeof text !== "string" || !text.trim() || text.length > 500))) throw new Error("Candidate review needs a proposal hash, decision and explicit reasons");
  const markdown = [
    `## 需求与验收\n${contract.objective}\n${contract.acceptance.map(item => `- ${item.id}：${item.text}`).join("\n")}`,
    ...(value.schemaVersion === 2 ? [designMarkdown(value)] : []),
    `## 拟改位置与做法\n${value.schemaVersion === 2 ? `本次允许修改 ${value.affectedFiles.length} 个文件，具体位置与改法见上文“修改位置与关键逻辑”。` : value.changes.map(item => `- ${item.file}：${item.description}`).join("\n")}`,
    `## 验证\n${value.verification.map(item => `- ${item.acceptanceId}：${item.scenario}；回归：${item.regression}`).join("\n")}\n\n自动检查（仅影响范围）：\n${validation.checks.map(item => `- ${JSON.stringify(item.command)}：${item.reason}`).join("\n") || `无；人工验证：${validation.manualReason}`}\n\n跳过检查：\n${validation.skipped.map(item => `- ${JSON.stringify(item.command)}：${item.reason}`).join("\n") || "无"}\n\n本地启动：\n${validation.startup.map(item => `- ${item.name}：${JSON.stringify(item.command)}；健康检查 ${item.healthUrl}；应用入口 ${item.applicationUrl ?? "无页面"}`).join("\n") || "此项目没有常驻本地服务；按验收场景人工验证或发布测试环境。"}`,
    `## 风险与回退\n${["existingBehavior", "interfaces", "data"].map((kind, index) => `- ${["历史功能", "接口", "数据"][index]}（${value.impacts[kind].status}）：${value.impacts[kind].evidence}`).join("\n")}\n- 外部影响（${value.boundaries.externalEffects.status}）：${value.boundaries.externalEffects.evidence}\n- 恢复：${value.boundaries.recovery.evidence}`,
    `## 待确认\n${value.openQuestions.length ? value.openQuestions.map(question => `- ${question}`).join("\n") : "无"}`,
  ].join("\n\n");
  if (planSections.some(section => markdown.split("\n").filter(line => line === `## ${section}`).length !== 1)
      || (Object.hasOwn(value, "markdown") && value.markdown !== markdown)) {
    throw new Error("Plan document must match its structured analysis and required sections");
  }
  return { ...value, markdown };
}

export function planSpecialists(analysis, reviewPolicy) {
  if (!["risk-based", "full"].includes(reviewPolicy)) throw new Error("Invalid plan review policy");
  return reviewPolicy === "full" || analysis.impacts.data.status !== "none"
    || analysis.boundaries.externalEffects.status !== "none" ? ["all"] : [];
}

export async function reviewPlanAnalysis(project, id, meta, directory, workspace, sourceHash, analysis, contract, roles, contextHash, correction = 0) {
  if (!/^[a-f0-9]{64}$/.test(contextHash)) throw new Error("Plan specialists require a verified planning context hash");
  const analysisHash = sha256(JSON.stringify(analysis));
  const { markdown, ...fullReviewInput } = analysis;
  const results = [];
  let current = meta;
  for (const role of roles) {
    const previous = (await readTask(project, id)).events.findLast(event => event.type === "plan_specialist_completed"
      && event.detail.contextHash === contextHash && event.detail.role === role
      && event.detail.findings.analysisHash === analysisHash);
    if (previous) {
      const { file, hash, findings } = previous.detail;
      if (path.dirname(file) !== directory || sha256(await fs.readFile(file)) !== sha256(`${JSON.stringify(findings, null, 2)}\n`)
          || hash !== sha256(JSON.stringify(findings)) || findings.role !== role
          || findings.contractHash !== meta.contractHash || findings.analysisHash !== analysisHash) {
        throw new Error("Plan specialist checkpoint changed");
      }
      await appendEvent(project, id, "plan_specialist_reused", current, { role, file, hash, contextHash,
        sourceEventHash: previous.hash, modelRun: false, phase: "review",
        reason: "Planning inputs and specialist evidence hashes match; reuse completed check" });
      results.push({ role, file, hash, findings });
      continue;
    }
    const suffix = correction ? `-correction-${correction}` : "";
    const logFile = path.join(directory, `plan-v${meta.planVersion + 1}-attempt-${meta.planAttempts}-specialist-${role}${suffix}.events.jsonl`);
    const remaining = (project.config.maxCostUsd ?? Infinity) - current.intakeCostUsd - current.reviewCostUsd - current.planCostUsd;
    if (remaining <= 0) {
      await appendEvent(project, id, "pi_budget_exhausted", current, { phase: "review", role, reason: "Requirement cost budget exhausted" });
      throw new Error("Requirement cost budget exhausted before specialist review");
    }
    const reviewInput = { schemaVersion: analysis.schemaVersion, contractHash: analysis.contractHash,
      planHash: analysisHash, sourceHash, contextHash, affectedFiles: analysis.affectedFiles,
      domains: analysis.domains, changes: analysis.changes, impacts: analysis.impacts, verification: analysis.verification, validation: analysis.validation,
      boundaries: analysis.boundaries, openQuestions: analysis.openQuestions };
    if (analysis.candidateReview) reviewInput.candidateReview = analysis.candidateReview;
    const deferredSections = [];
    let contextFiles = analysis.affectedFiles;
    if (analysis.schemaVersion === 2) {
      const design = analysis.design;
      const components = design.components;
      contextFiles = [...new Set(components.map(row => row.file))];
      reviewInput.design = { approach: design.approach, data: design.data, interfaces: design.interfaces,
        components: design.components.map(({ file, domain, location }) => ({ file, domain, location })) };
      for (const domain of ["frontend", "backend"]) {
        reviewInput.design[domain] = design[domain];
      }
      deferredSections.push("components", "diagrams");
    }
    reviewInput.deferredSections = deferredSections;
    const handoff = { planHash: analysisHash, sourceHash, contextHash, role, deferredSections,
      inlineBytes: Buffer.byteLength(JSON.stringify(reviewInput)), fullPlanBytes: Buffer.byteLength(JSON.stringify(fullReviewInput)) };
    const prompt = `研发方案专项检查。只读检查本方案在 ${role} 职责内的真实遗漏或冲突，不重复生成方案，不要求各角色措辞一致，不宣称测试已执行。仅返回 JSON 对象 findings（最多6项，合并同一根因；每项 severity 为 blocking 或 advisory，subject、evidence、recommendation 各为非空字符串且最多1000字符）。优先最多3个真正影响交付的问题，避免泛化建议。只有会导致需求偏差、历史行为/接口/数据风险未处理或不可验证的问题才标 blocking。声称文件、测试或函数不存在前必须直接核实对应路径，未搜索到不等于不存在；文本和 JSON 分支分别核对，不把待实现的测试当成当前已有测试。没有问题 findings 为空。\n冻结需求 JSON：${JSON.stringify(contract)}\n方案及验收依据：${JSON.stringify(reviewInput)}`;
    let run;
    let findings;
    const file = path.join(directory, `plan-v${meta.planVersion + 1}-attempt-${meta.planAttempts}-specialist-${role}${suffix}.json`);
    try {
      const allowance = modelAllowance((await readTask(project, id)).events, admissionPolicy(project.config));
      const outputContract = "\n输出顶层必须是单个对象，禁止数组。对象格式：{\"findings\":[]}。仅返回 findings；角色、需求和方案的身份由系统绑定，不要输出哈希。\n评审对象是方案是否可以实施，不是尚未编写的实现是否已经完美。方案已明确的验收和验证不要再次列为遗漏；实现顺序、变量命名、同等正确的写法属于实现指导，标 advisory。只有能够引用冻结需求与方案中明确矛盾、不可恢复的风险或缺少必要业务决策时才阻断。假设未来可能写错、要求把已有验收再写一遍，不构成 blocking。";
      const testInstructions = "\n你是唯一的独立审查 Agent，统一检查受影响的前端、后端、接口、数据恢复与测试，不再拆成多个角色反复调查。逐项核对冻结验收、必要异常边界和历史功能回归，确认真实可执行的验证路径。所有validation命令从仓库根目录运行，直接读取对应package.json/pom.xml和服务配置：子目录脚本须保留目录参数，Maven的-pl不能代替-f，startup.healthUrl须匹配真实端口和健康路径，applicationUrl须为实际应用入口（无页面为null），前端代理须对应后端地址。已存在且未计划修改的脚本或配置与启动约定明确矛盾时属于不可验证，应blocking并给出最小命令修正；不要要求增加根目录代理脚本来迁就错误命令。只读审查，核实源码；不得重新设计、扩大业务范围或宣称测试已执行。";
      const convergenceInstructions = "\n只阻断真实无法安全实现或验收的矛盾、缺失业务决定和不可恢复风险。已确定需求内的ID重映射、文件唯一命名、过期提示、按原项目规范处理关联等普通技术细节，先核实源码后直接给最简建议，标advisory并指导Pi实现，不要求研发逐项再次确认。发现与当前方案明确相矛盾的删除范围、未受控数据改动或真实遗漏交付入口时仍应blocking，不能为了少提问隐去问题。不要把同一个问题变换措辞再开一轮。";
      const materialInstructions = `\n这份交接包保留完整冻结需求、验收、接口契约与风险，只发送职责相关的设计正文。deferredSections 中的原文未发送，不能把省略误判为遗漏；检查依赖这些内容时必须通过 read_plan 读取 planHash=${analysisHash} 的对应章节，按偏移读取必要范围。其他 Agent 的判断不作为源码事实或你的评审依据。复用附带的哈希校验源码，未覆盖的调用方、实体或回归按需定位。`;
      run = await runPi(project, workspace, "review", prompt + testInstructions + outputContract + convergenceInstructions + materialInstructions, logFile, remaining, role, [], {
        outputSchema: { name: "plan_specialist", strict: true, schema: {
          type: "object", additionalProperties: false, required: ["findings"],
          properties: { findings: { type: "array", maxItems: 6,
              items: { type: "object", additionalProperties: false, required: ["severity", "subject", "evidence", "recommendation"],
                properties: { severity: { type: "string", enum: ["blocking", "advisory"] },
                  subject: { type: "string", minLength: 1, maxLength: 1000 },
                  evidence: { type: "string", minLength: 1, maxLength: 1000 },
                  recommendation: { type: "string", minLength: 1, maxLength: 1000 } } } } } } },
        ...allowance, ...(contextFiles.length ? { contextFiles } : {}), discussionTask: id,
        sourceQuery: JSON.stringify({ impacts: analysis.impacts, components: reviewInput.design?.components
          .filter(row => contextFiles.includes(row.file)) }).slice(0, 4000),
        authoritativeContext: { plan: reviewInput, contract, role, materialTool: "read_plan" } });
      if (manifestHash(await manifest(workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== sourceHash
          || manifestHash(await sourceManifest(project)) !== sourceHash) throw new Error("Files changed during read-only specialist review");
      const output = JSON.parse(run.text);
      if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Specialist output must be one JSON object, not an array or scalar");
      findings = { role, contractHash: meta.contractHash, analysisHash, findings: output.findings };
      if (!Array.isArray(findings.findings) || findings.findings.length > 6
          || findings.findings.some((item) => !["blocking", "advisory"].includes(item.severity)
            || [item.subject, item.evidence, item.recommendation].some((text) => typeof text !== "string" || !text.trim() || text.length > 1000))) throw new Error("Specialist findings require at most 6 items with valid severity and nonempty text <= 1000 characters");
      await fs.writeFile(file, `${JSON.stringify(findings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      const costUsd = run?.costUsd ?? error.costUsd ?? 0;
      current = { ...current, reviewCostUsd: current.reviewCostUsd + costUsd };
      await appendEvent(project, id, "plan_specialist_failed", current, { role, error: error.message, logFile, costUsd, handoff,
        modelRun: Boolean(run || error.telemetry),
        telemetry: run?.telemetry ?? error.telemetry ?? null });
      throw error;
    }
    current = { ...current, reviewCostUsd: current.reviewCostUsd + run.costUsd };
    const hash = sha256(JSON.stringify(findings));
    await appendEvent(project, id, "plan_specialist_completed", current, { role, file, hash, findings, contextHash,
      logFile, costUsd: run.costUsd, telemetry: run.telemetry, handoff });
    results.push({ role, file, hash, findings });
  }
  return { meta: current, results };
}

export async function readPlanAnalysis(meta, directory) {
  const analysis = JSON.parse(await fs.readFile(path.join(directory, `plan-analysis-v${meta.planVersion}.json`), "utf8"));
  let proposedFiles = meta.developmentFiles;
  let approvalScope;
  if (meta.planScopeHash) {
    const scope = JSON.parse(await fs.readFile(path.join(directory, `plan-scope-v${meta.planVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(scope)) !== meta.planScopeHash || scope.schemaVersion !== 1
        || scope.actor !== meta.planApprovedBy || scope.planVersion !== meta.planVersion
        || scope.planAnalysisHash !== meta.planAnalysisHash
        || JSON.stringify(scope.files) !== JSON.stringify(meta.developmentFiles)
        || !scope.files.length || new Set(scope.files).size !== scope.files.length
        || scope.files.some(file => !scope.proposedFiles.includes(file))) throw new Error("Approved plan scope changed");
    proposedFiles = scope.proposedFiles;
    approvalScope = scope;
  }
  if (analysis.schemaVersion !== 1 || sha256(JSON.stringify(analysis)) !== meta.planAnalysisHash
      || analysis.contractHash !== meta.contractHash || analysis.baselineHash !== meta.projectBaselineHash
      || analysis.standardsHash !== meta.standardsHash || analysis.planHash !== meta.planHash
      || JSON.stringify(analysis.draft.affectedFiles) !== JSON.stringify(proposedFiles)
      || JSON.stringify(analysis.blockers) !== JSON.stringify(meta.planBlockers)) throw new Error("Plan analysis changed or no longer matches the requirement and baseline");
  planSpecialists(analysis.draft, analysis.reviewPolicy);
  if (!analysis.developerSession || path.dirname(analysis.developerSession.file) !== directory
      || !/^[a-f0-9]{64}$/.test(analysis.developerSession.hash)) throw new Error("Plan requires a bound developer session");
  if (sha256(await fs.readFile(analysis.developerSession.file)) !== analysis.developerSession.hash) throw new Error("Plan developer session changed");
  const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
  if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed after planning");
  validateAdmissionPolicy(analysis.admissionPolicy);
  const initial = assessAdmission(analysis.draft, contract, analysis.admissionPolicy);
  if (JSON.stringify(analysis.specialists.map(row => row.role))
      !== JSON.stringify(initial.eligible ? planSpecialists(analysis.draft, analysis.reviewPolicy) : [])
      || sha256(JSON.stringify(analysis.admissionPolicy)) !== meta.admissionPolicyHash
      || JSON.stringify(analysis.admission) !== JSON.stringify(meta.admission)) throw new Error("Plan specialist or admission evidence is incomplete");
  const draftHash = sha256(JSON.stringify(analysis.draft));
  for (const row of analysis.specialists) {
    if (path.dirname(row.file) !== directory) throw new Error("Specialist evidence must be archived in this requirement");
    const evidence = JSON.parse(await fs.readFile(row.file, "utf8"));
    if (sha256(JSON.stringify(evidence)) !== row.hash || JSON.stringify(evidence) !== JSON.stringify(row.findings)
        || evidence.role !== row.role || evidence.contractHash !== meta.contractHash
        || evidence.analysisHash !== draftHash) throw new Error("Plan specialist evidence changed");
  }
  if (meta.planResolutionHash) {
    const resolution = JSON.parse(await fs.readFile(path.join(directory, `plan-findings-resolution-v${meta.planVersion}.json`), "utf8"));
    const blocking = analysis.specialists.flatMap(row => row.findings.findings.filter(finding => finding.severity === "blocking")
      .map(finding => `${row.role}:${sha256(JSON.stringify(finding))}`)).sort();
    if (sha256(JSON.stringify(resolution)) !== meta.planResolutionHash || resolution.schemaVersion !== 1
        || resolution.planVersion !== meta.planVersion || resolution.planAnalysisHash !== meta.planAnalysisHash
        || resolution.baseHash !== meta.baseHash || resolution.actor !== meta.assignments?.developer?.userId
        || !initial.eligible || !blocking.length || !Array.isArray(resolution.items)
        || JSON.stringify(resolution.items.map(item => item.findingId).sort()) !== JSON.stringify(blocking)) throw new Error("Plan findings resolution changed or cannot resolve admission boundaries");
    return { ...analysis, originalAdmission: analysis.admission, originalBlockers: analysis.blockers,
      admission: initial, blockers: [], resolution, ...(approvalScope ? { approvalScope } : {}) };
  }
  return { ...analysis, ...(approvalScope ? { approvalScope } : {}) };
}

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
export const planMaterialSections = ["approach", "frontend", "backend", "data", "interfaces", "components", "diagrams", "changes", "verification", "impacts", "boundaries", "specialists", "discussion"];

export async function readPlanMaterial(project, id, input) {
  if (!input || !planMaterialSections.includes(input.section) || !/^[a-f0-9]{64}$/.test(input.planHash ?? "")
      || !Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.maxChars)
      || input.maxChars < 1 || input.maxChars > 1000) throw new Error("Plan material reads need the exact version, section and a bounded character range");
  const task = await readTask(project, id);
  let analysis;
  if (task.meta.planHash === input.planHash) analysis = await readPlanAnalysis(task.meta, task.directory);
  else {
    const checkpoint = task.events.findLast(event => ["plan_draft_completed", "plan_draft_reused"].includes(event.type)
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
  return { taskId: id, planHash: task.meta.planHash, contractHash: task.meta.contractHash, baseHash: task.meta.baseHash,
    section: input.section, offset: input.offset, totalChars: text.length, text: text.slice(input.offset, input.offset + input.maxChars),
    partial: input.offset > 0 || text.length > input.maxChars, note: "Verified archived plan material. Proposals and AI advice are not approval; source and frozen requirements remain authoritative." };
}
export const candidateReviewSchema = { type: "object", additionalProperties: false,
  required: ["proposalHash", "status", "reasons"], properties: {
    proposalHash: { type: "string" }, status: { type: "string", enum: ["accepted", "adjusted", "product_confirmation", "human_led"] },
    reasons: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 500 } } } };

export const planOutputSchema = { name: "delivery_plan", strict: true, schema: {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "contractHash", "affectedFiles", "changes", "domains", "impacts", "verification", "openQuestions", "boundaries", "design"],
  properties: {
    schemaVersion: { type: "integer", enum: [2] }, contractHash: { type: "string" }, design: designSchema,
    affectedFiles: { type: "array", minItems: 1, maxItems: 30, description: "Each project-relative file appears exactly once.", items: { type: "string", minLength: 1 } },
    changes: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", additionalProperties: false,
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
    openQuestions: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: 500 } },
    boundaries: { type: "object", additionalProperties: false,
      required: ["modules", "deliveryUnits", "designStages", "estimatedChangedLines", "coordination", "verification", "recovery", "externalEffects", "exclusions"],
      properties: {
        modules: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", additionalProperties: false,
          required: ["name", "files", "evidence"], properties: { name: { type: "string", minLength: 1, maxLength: 100 },
            files: { type: "array", minItems: 1, items: { type: "string" } }, evidence: { type: "string", minLength: 1, maxLength: 1000 } } } },
        deliveryUnits: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", additionalProperties: false,
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
    const fields = ["affectedFiles", "changes", "domains", "impacts", "verification", "openQuestions", "boundaries", "design",
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
  if (!Array.isArray(value.affectedFiles) || !value.affectedFiles.length || value.affectedFiles.length > 30
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
    `## 验证\n${value.verification.map(item => `- ${item.acceptanceId}：${item.scenario}；回归：${item.regression}`).join("\n")}`,
    `## 风险与回退\n${["existingBehavior", "interfaces", "data"].map((kind, index) => `- ${["历史功能", "接口", "数据"][index]}（${value.impacts[kind].status}）：${value.impacts[kind].evidence}`).join("\n")}\n- 外部影响（${value.boundaries.externalEffects.status}）：${value.boundaries.externalEffects.evidence}\n- 恢复：${value.boundaries.recovery.evidence}`,
    `## 待确认\n${value.openQuestions.length ? value.openQuestions.map(question => `- ${question}`).join("\n") : "无"}`,
  ].join("\n\n");
  if (Buffer.byteLength(markdown) > (value.schemaVersion === 2 ? 64000 : 16000)
      || planSections.some(section => markdown.split("\n").filter(line => line === `## ${section}`).length !== 1)
      || (Object.hasOwn(value, "markdown") && value.markdown !== markdown)) {
    throw new Error("Plan document must match its structured analysis and stay within its bounded size");
  }
  return { ...value, markdown };
}

export function planSpecialists(analysis, testReviewRequired = false) {
  const coupled = analysis.domains.includes("frontend") && analysis.domains.includes("backend");
  const risk = analysis.boundaries.externalEffects.status !== "none"
    || ["existingBehavior", "interfaces", "data"].some((kind) => analysis.impacts[kind].status !== "none");
  const roles = [];
  if (coupled) roles.push("frontend", "backend");
  if (risk || testReviewRequired) roles.push("qa");
  return roles;
}

export async function reviewPlanAnalysis(project, id, meta, directory, workspace, sourceHash, analysis, contract, roles, contextHash, correction = 0) {
  if (!/^[a-f0-9]{64}$/.test(contextHash)) throw new Error("Plan specialists require a verified planning context hash");
  const analysisHash = sha256(JSON.stringify(analysis));
  const { markdown, ...reviewInput } = analysis;
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
    const remaining = project.config.maxCostUsd - current.intakeCostUsd - current.reviewCostUsd - current.planCostUsd;
    if (remaining <= 0) {
      await appendEvent(project, id, "pi_budget_exhausted", current, { phase: "review", role, reason: "Requirement cost budget exhausted" });
      throw new Error("Requirement cost budget exhausted before specialist review");
    }
    const prompt = `研发方案专项检查。只读检查本方案在 ${role} 职责内的真实遗漏或冲突，不重复生成方案，不要求各角色措辞一致，不宣称测试已执行。仅返回 JSON 对象 findings（最多6项，合并同一根因；每项 severity 为 blocking 或 advisory，subject、evidence、recommendation 各为非空字符串且最多1000字符）。优先最多3个真正影响交付的问题，避免泛化建议。只有会导致需求偏差、历史行为/接口/数据风险未处理或不可验证的问题才标 blocking。声称文件、测试或函数不存在前必须直接核实对应路径，未搜索到不等于不存在；文本和 JSON 分支分别核对，不把待实现的测试当成当前已有测试。没有问题 findings 为空。\n冻结需求 JSON：${JSON.stringify(contract)}\n方案及验收依据：${JSON.stringify(reviewInput)}`;
    let run;
    let findings;
    const file = path.join(directory, `plan-v${meta.planVersion + 1}-attempt-${meta.planAttempts}-specialist-${role}${suffix}.json`);
    try {
      const allowance = modelAllowance((await readTask(project, id)).events, admissionPolicy(project.config));
      const outputContract = "\n输出顶层必须是单个对象，禁止数组。对象格式：{\"findings\":[]}。仅返回 findings；角色、需求和方案的身份由系统绑定，不要输出哈希。\n评审对象是方案是否可以实施，不是尚未编写的实现是否已经完美。方案已明确的验收和验证不要再次列为遗漏；实现顺序、变量命名、同等正确的写法属于实现指导，标 advisory。只有能够引用冻结需求与方案中明确矛盾、不可恢复的风险或缺少必要业务决策时才阻断。假设未来可能写错、要求把已有验收再写一遍，不构成 blocking。";
      const testInstructions = role === "qa" ? "\n你负责判断怎样测试才算完成这份需求。逐项核对冻结验收的正向场景、必要异常边界和受影响历史功能回归，检查是否有真实可执行的验证路径。未明确的关键业务结果或无法验证的核心行为必须指出。只检查已有需求，禁止新增功能、扩大测试范围或用泛化建议增加确认轮次。" : "";
      const convergenceInstructions = "\n只阻断真实无法安全实现或验收的矛盾、缺失业务决定和不可恢复风险。已确定需求内的ID重映射、文件唯一命名、过期提示、按原项目规范处理关联等普通技术细节，先核实源码后直接给最简建议，标advisory并指导Pi实现，不要求研发逐项再次确认。发现与当前方案明确相矛盾的删除范围、未受控数据改动或真实遗漏交付入口时仍应blocking，不能为了少提问隐去问题。不要把同一个问题变换措辞再开一轮。";
      run = await runPi(project, workspace, "review", prompt + testInstructions + outputContract + convergenceInstructions, logFile, remaining, role, [], {
        outputSchema: { name: "plan_specialist", strict: true, schema: {
          type: "object", additionalProperties: false, required: ["findings"],
          properties: { findings: { type: "array", maxItems: 6,
              items: { type: "object", additionalProperties: false, required: ["severity", "subject", "evidence", "recommendation"],
                properties: { severity: { type: "string", enum: ["blocking", "advisory"] },
                  subject: { type: "string", minLength: 1, maxLength: 1000 },
                  evidence: { type: "string", minLength: 1, maxLength: 1000 },
                  recommendation: { type: "string", minLength: 1, maxLength: 1000 } } } } } } },
        ...allowance, contextFiles: analysis.affectedFiles, sourceQuery: JSON.stringify(analysis.impacts).slice(0, 4000) });
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
      await appendEvent(project, id, "plan_specialist_failed", current, { role, error: error.message, logFile, costUsd,
        modelRun: Boolean(run || error.telemetry),
        telemetry: run?.telemetry ?? error.telemetry ?? null });
      throw error;
    }
    current = { ...current, reviewCostUsd: current.reviewCostUsd + run.costUsd };
    const hash = sha256(JSON.stringify(findings));
    await appendEvent(project, id, "plan_specialist_completed", current, { role, file, hash, findings, contextHash,
      logFile, costUsd: run.costUsd, telemetry: run.telemetry });
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
  const roles = planSpecialists(analysis.draft, analysis.testReviewRequired === true);
  const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
  if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed after planning");
  validateAdmissionPolicy(analysis.admissionPolicy);
  const initial = assessAdmission(analysis.draft, contract, analysis.admissionPolicy);
  if (sha256(JSON.stringify(analysis.admissionPolicy)) !== meta.admissionPolicyHash
      || JSON.stringify(analysis.admission) !== JSON.stringify(meta.admission)
      || JSON.stringify(analysis.specialists.map((row) => row.role)) !== JSON.stringify(initial.eligible ? roles : [])) throw new Error("Plan specialist or admission evidence is incomplete");
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

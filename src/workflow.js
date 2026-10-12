import { promises as fs } from "node:fs";
import path from "node:path";
import { allowedFile, describePolicy, loadProject, validateConfig } from "./config.js";
import { localRuntimePorts, stopLocalRuntime } from "./local-runtime.js";
import { baselineAgentContext, readProjectBaseline } from "./baseline.js";
import { assertInside, compareManifests, copyFiles, manifest, manifestHash, sha256, writeJson } from "./files.js";
import { runPi } from "./pi-runner.js";
import { appendEvent, readTask, taskPath, withLock } from "./store.js";
import { assertReleaseRevision, inspectChanges, preparePlanWorkspace, prepareReleaseCandidate, prepareWorkspace, rollbackWorkspace, sourceManifest, sourceRevision } from "./workspace.js";
import { runCommand } from "./commands.js";
import { deployConfigured, deploymentRequiresPublishedRevision, pollConfiguredDeployment, verifyTestEnvironment } from "./deploy.js";
import { publishedRevision, validateDevelopmentBranch } from "./workspace.js";
import { resolveStandards, standardsPrompt } from "./standards.js";
import { candidateReviewSchema, planAnalysisInput, planOutputSchema, planSpecialists, readPlanAnalysis, reviewPlanAnalysis } from "./plan-analysis.js";
import { admissionPolicy, assessAdmission, modelAllowance } from "./admission.js";
import { taskObservability } from "./report.js";
import { runGit } from "./git-project.js";
import { planReviewStatus } from "./plan-review.js";
import { initializationCommands } from "./project-initialization.js";
import { readLocalEnvironment } from "./local-environment.js";


function requireState(meta, expected) {
  if (meta.state !== expected) throw new Error(`Task ${meta.id} is ${meta.state}; expected ${expected}`);
}

function requireActor(actor) {
  if (typeof actor !== "string" || !actor.trim()) throw new Error("Human actor name is required");
}

async function assertTaskStandards(project, meta, directory) {
  const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
  if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed");
  const standards = resolveStandards(project.config, meta.aiAligned ? Object.keys((await readProjectBaseline(project, null, false)).files) : contract.inScope);
  if (meta.standardsHash !== standards.hash) throw new Error("Coding standards changed after planning");
  return standards;
}

async function assertCheckEvidence(project, checks, directory, prefix, allowFailures = false, commands = project.config.checks) {
  if (!Array.isArray(checks) || checks.length !== commands.length) {
    throw new Error(`Missing ${prefix} check evidence`);
  }
  for (const [index, check] of checks.entries()) {
    const expectedLog = path.join(directory, `${prefix ? `${prefix}-` : ""}check-${index + 1}.log`);
    if (JSON.stringify(check.command) !== JSON.stringify(commands[index])
        || check.logFile !== expectedLog || !Number.isInteger(check.code) || check.code < 0
        || (!allowFailures && check.code !== 0) || check.signal !== null
        || check.sandboxImage !== (project.config.checkSandbox?.image ?? null)
        || !/^[a-f0-9]{64}$/.test(check.logHash ?? "")) {
      throw new Error(`Invalid ${prefix} check evidence: ${index + 1}`);
    }
    if (sha256(await fs.readFile(expectedLog)) !== check.logHash) {
      throw new Error(`Changed ${prefix} check log: ${index + 1}`);
    }
  }
}

function resultReport(meta, events) {
  const changed = meta.changeCount ?? 0;
  const usage = taskObservability({ meta, events }).summary;
  return `# ${meta.id} ${meta.title}\n\n` +
    `状态：${meta.state}\n\n方案版本：${meta.planVersion}，哈希：${meta.planHash}\n\n` +
    `项目全局基线：${meta.projectBaselineHash ?? "未记录"}\n\n` +
    `基线：${meta.baseRevision ?? meta.baseHash}\n\n变更文件数：${changed}\n\n` +
    `方案责任人：${meta.planApprovedBy ?? "未审核"}；批准方式：${events.findLast(event => event.type === "plan_approved")?.detail.approvalKind === "delegated" ? "按具名研发授权执行" : "逐次人工审核"}\n\n` +
    `实际变更风险责任人：${meta.changeApproval?.actor ?? "未审核"}\n\n` +
    `实际变更审核结论：${meta.changeApproval?.evidence ?? "未审核"}\n\n` +
    `Pi 成本：${usage.costUsd === null ? "未知（缺少完整计价证据；零价格记录不代表免费）" : `$${usage.costUsd.toFixed(4)}`}\n\n` +
    `人工验收人：${meta.acceptedBy ?? "未验收"}\n\n` +
    (meta.acceptanceMode === "manual" ? `验收方式：人工确认研发交付；未以本地运行或测试环境发布作为验收依据。\n\n研发检查：${meta.verificationMode === "manual_pending" ? "无合适自动检查，已记录人工确认结论；不代表自动测试通过" : "方案选定的相关检查已通过"}\n\n` : "") +
    (meta.acceptanceMode === "local" ? `验证方式：研发本地验证；地址：${meta.localValidation.environment.applications.map(app => `${app.name} ${app.url}`).join("；") || "无应用页面，按方案验证服务或CLI"}\n\n本地启动说明：${meta.localValidation.environment.instructions}\n\n` : "") +
    `需求分支：${meta.branch ?? "目录工作区"}；已推送版本：${meta.publishedRevision ?? "未推送"}\n\n` +
    `研发交付版本：${meta.afterHash ?? "未形成"}\n\n` +
    `测试环境版本：${meta.testDeployment ? meta.testCandidate?.publishedRevision ?? meta.publishedRevision ?? meta.afterHash : "未发布"}\n\n` +
    `合并或本地候选版本：${meta.mergedRevision ?? "未形成"}；研发交付归档不代表已合入正式目标分支。\n\n` +
    `生产观察人：${meta.observedBy ?? "未观察"}\n\n` +
    `详细证据见本需求目录中的 events.jsonl、changes.json、检查日志和部署记录。\n`;
}

export async function plan(projectPath, id) {
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    if (!["contract_confirmed", "role_review", "review_passed"].includes(meta.state)) throw new Error(`Task ${id} is ${meta.state}; expected a frozen requirement awaiting plan analysis`);
    if (meta.state === "role_review") throw new Error("Explicit optional role reviews must be resolved before planning; revise the requirement or finalize those reviews");
    if (meta.assignments?.developer?.status !== "accepted") throw new Error("Plan analysis requires an accepted developer assignment");
    const policy = admissionPolicy(project.config);
    let allowance;
    try {
      if (policy.budgetMode === "strict" && (meta.planAttempts ?? 0) >= policy.maxPlanAttempts) throw new Error("Plan analysis attempt limit reached; hand off to the responsible developer");
      allowance = modelAllowance(events, policy);
    } catch (error) {
      await appendEvent(project, id, "execution_boundary_stopped", { ...meta, executionBoundary: [error.message] }, { error: error.message, phase: "plan" });
      throw error;
    }
    const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed before planning");
    const standards = resolveStandards(project.config, meta.aiAligned ? Object.keys((await readProjectBaseline(project)).files) : contract.inScope);
    const remainingCost = (project.config.maxCostUsd ?? Infinity) - meta.intakeCostUsd - meta.reviewCostUsd - (meta.planCostUsd ?? 0);
    if (remainingCost <= 0) {
      await appendEvent(project, id, "pi_budget_exhausted", meta, { phase: "plan", reason: "Requirement cost budget exhausted" });
      throw new Error("Requirement cost budget exhausted before planning");
    }
    const baseline = await sourceManifest(project);
    const baseHash = manifestHash(baseline);
    const projectBaseline = await readProjectBaseline(project, baseHash);
    const configHash = describePolicy(project.config).executionConfigHash;
    const revision = await sourceRevision(project);
    const recordedRevision = meta.planFeedbackVersion ? events.findLast(event => event.type === "plan_revision_requested"
      && event.meta.planFeedbackVersion === meta.planFeedbackVersion && event.detail.priorPlanHash === meta.planHash) : null;
    let feedback = "";
    if (meta.planFeedbackVersion) {
      if (!recordedRevision || path.dirname(recordedRevision.detail.feedbackFile) !== directory) throw new Error("Recorded plan review feedback is missing or belongs to another requirement");
      feedback = await fs.readFile(recordedRevision.detail.feedbackFile, "utf8");
      if (sha256(feedback) !== recordedRevision.detail.feedbackHash) throw new Error("Plan review feedback changed after it was recorded");
    }
    const revisionProposal = recordedRevision?.detail.candidate ?? null;
    const priorPlan = meta.planHash ? await readPlanAnalysis(meta, directory) : null;
    const discussion = meta.planHash ? events.filter(event => event.meta.planVersion === meta.planVersion && ["plan_message", "plan_reply"].includes(event.type)) : [];
    const recentDiscussion = discussion.slice(-4).map(event => ({ eventHash: event.hash,
      role: event.type === "plan_message" ? "developer" : "ai", text: (event.detail.text ?? event.detail.reply.reply).slice(0, 500),
      partial: (event.detail.text ?? event.detail.reply.reply).length > 500 }));
    const reviewPolicy = project.config.planReview ?? "risk-based";
    const contextHash = sha256(JSON.stringify([meta.contractHash, baseHash, projectBaseline.snapshotHash,
      configHash, revision, standards.hash, sha256(feedback), discussion.map(event => event.hash), "design-v10-explicit-application-entry", reviewPolicy,
      process.env.REQFLOW_LOCAL_RUNTIME_CONTAINER === "1", localRuntimePorts]));
    const checkpoint = events.findLast(event => event.type === "plan_draft_completed"
      && event.detail.contextHash === contextHash && event.detail.version === meta.planVersion + 1);
    const prompt = `Read-only delivery plan. Project mode=${project.config.mode}; local mode has NO Git. Validate diffs/recovery with controller manifests and snapshots; never prescribe Git commands for local mode. Return JSON only; no top-level markdown or repeated requirement. Exact root fields: schemaVersion=2,contractHash,affectedFiles:string[] (write paths only),changes:[{file,description}] in that exact order (<=500 characters each, concrete symbols/lines),domains:string[],impacts:{existingBehavior:{status,evidence},interfaces:{status,evidence},data:{status,evidence}},verification:[{acceptanceId,scenario,regression}],validation,openQuestions:string[],boundaries,design. verification MUST be an ARRAY with ${contract.acceptance.length} separate items, exactly covering ${JSON.stringify(contract.acceptance.map(item => item.id))}; never merge items; scenario/regression are nonempty assertion strings, never booleans. Do not add an acceptance field. Impact status:none/changed/unknown; evidence is nonempty source evidence. Unknown blocks approval; agreement is not safety proof. openQuestions=[] when none. Keep sufficient existing tests; add missing coverage without removing assertions.\n冻结需求哈希：${meta.contractHash}\n冻结需求 JSON：${JSON.stringify(contract)}\n适用代码规范：${standardsPrompt(standards)}\n项目只读参考：${await baselineAgentContext(project, projectBaseline, null, "index")}\n${feedback ? `上次方案审核意见，必须解决：${feedback}\n` : ""}检查命令：${JSON.stringify(project.config.checks)}`;
    const designPrompt = `\n用中文写一份研发可以读懂的具体设计，不能只列文件或检查项。design={approach:实现思路及选择原因,frontend:页面交互与状态和调用,backend:业务流程与校验和兼容,data:数据处理与恢复,interfaces:[{name,method,path,status:existing/modified/new,sourceFile,request,response,errors}],diagrams:[{title,kind:flow/sequence,domain:frontend/backend/shared,source:Mermaid纯语法}],components:[{file,domain:frontend/backend/shared,location:类/方法/组件与现有行号或明确新增位置,pseudocode:关键逻辑伪代码或短代码片段}]}。components按affectedFiles顺序逐项对应。未涉及的一端说明为空；没有接口则interfaces=[]。普通需求默认diagrams=[]，前后端同时变更也不强制画图；用前后端文字和接口约定说明调用顺序、状态与错误处理。只有一张短图能明显帮助理解交互或分支流程时才画，选择流程图或时序图其中一种，不重复文字、需求原文、整份源码或架构科普。新增接口明确new；现有或修改接口必须读源码并给真实sourceFile，不能猜测路径。所有描述、接口样例及必要的图和关键伪代码必须互相一致，以冻结验收为准。两名研发负责已明确接口的普通联调不等于复杂的跨团队协调；只有未解决外部决策或跨团队依赖才属于coordination required。`;
    const boundaryPrompt = `\nboundaries={modules:[{name,files,evidence}],deliveryUnits:[{name,evidence}],designStages:positive integer,estimatedChangedLines:positive integer,coordination:{status:none/required/unknown,evidence},verification:{status:ready/unknown,evidence},recovery:{status:code_only/documented/unresolved,evidence},externalEffects:{status:none/reversible/irreversible/unknown,evidence},exclusions:[{kind,evidence}]}. modules cover every proposed write file exactly once. deliveryUnits are independently deployable units. This agent automates bounded junior-development work. High-complexity long tasks needing staged design decisions, architecture redesign, staged migration, core security rework, framework upgrades or open-ended exploration must be handed to a human developer using other design tools; do not conceal complexity or automatically split such work to bypass this boundary. designStages counts unresolved design/decision stages, NOT coding steps, tool calls, tests or repair iterations. exclusions list actual architecture_redesign/staged_migration/core_security_rework/framework_upgrade/exploratory_work/irreversible_data_operation with concrete evidence, else []. Size estimates alone do not establish high complexity. Writing a known migration in isolation is distinct from designing a complex data migration or executing it against live data. Investigate ordinary code dependencies before declaring unknown; openQuestions are decisions requiring the owner. File snapshots restore code, never data/external effects. External coordination and irreversible operations require human-led work. Planning estimates (advisory): ${JSON.stringify({ maxFiles: policy.maxFiles, maxAcceptance: policy.maxAcceptance, maxBusinessModules: policy.maxBusinessModules, maxDeliveryUnits: policy.maxDeliveryUnits, maxEstimatedChangedLines: policy.maxEstimatedChangedLines })}. Restricted paths (mandatory): ${JSON.stringify(policy.restrictedPaths)}. domains: frontend=Web/mobile UI,backend=CLI/service/business logic,database=schema,infrastructure=runtime,documentation=docs; only affected domains. CLI display is backend.`;
    const version = meta.planVersion + 1;
    const attempt = (meta.planAttempts ?? 0) + 1;
    const logFile = path.join(directory, `plan-v${version}-attempt-${attempt}.events.jsonl`);
    const outputSchema = { ...planOutputSchema, schema: { ...planOutputSchema.schema,
      ...(revisionProposal ? { required: [...planOutputSchema.schema.required, "candidateReview"] } : {}),
      properties: { ...planOutputSchema.schema.properties, contractHash: { type: "string", enum: [meta.contractHash] },
        ...(revisionProposal ? { candidateReview: { ...candidateReviewSchema, properties: { ...candidateReviewSchema.properties,
          proposalHash: { type: "string", enum: [sha256(JSON.stringify(revisionProposal))] } } } } : {}) } } };
    const baselineChecks = [];
    let result;
    let draftRecorded = false;
    try {
      const active = { ...meta, state: "contract_confirmed", planAttempts: attempt, executionBoundary: null,
        planCostUsd: meta.planCostUsd ?? 0, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "plan_analysis_started", active, { contractHash: meta.contractHash, version });
      const planningWorkspace = await preparePlanWorkspace(project, id, attempt, baseline);
      if (project.config.checks.length) {
        for (const file of Object.keys(baseline).filter(file => path.posix.basename(file) === "package.json")) {
          const directory = path.posix.dirname(file);
          if (!(await fs.readdir(path.join(project.root, directory))).includes("node_modules")) continue;
          const dependencies = await fs.realpath(path.join(project.root, directory, "node_modules"));
          await fs.cp(dependencies, path.join(planningWorkspace, directory, "node_modules"),
            { recursive: true, verbatimSymlinks: true, filter: async source => {
              if ((await fs.lstat(source)).isSymbolicLink()) {
                const target = await fs.readlink(source);
                if (path.isAbsolute(target)) throw new Error(`Installed dependency has an absolute link: ${source}`);
                assertInside(dependencies, await fs.realpath(source));
              }
              return true;
            } });
        }
      }
      if (manifestHash(await manifest(planningWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== baseHash) {
        throw new Error("Baseline checks modified project files");
      }
      if (!checkpoint) result = await runPi(project, planningWorkspace, "plan", prompt + boundaryPrompt + designPrompt
        + (process.env.REQFLOW_LOCAL_RUNTIME_CONTAINER === "1"
          ? `\n本地启动运行在Docker容器中，${localRuntimePorts.join("、")}已经映射到宿主机回环地址。每个startup服务选择这5个端口之一，监听0.0.0.0，healthUrl和applicationUrl分别明确配置，均使用http://127.0.0.1:对应端口；前端代理后端也使用对应容器端口。需要更改启动参数或代理配置时列入方案，不让用户另填命令。`
          : "\n本地服务运行在工作台主机，监听回环地址；核实现有端口和依赖后选择启动参数。")
        + "\n保留关键逻辑伪代码，也可用少量关键代码说明：优先展示核心判断、身份映射、事务或写入边界，通常5–10行；多个文件复用同一逻辑时只在核心文件展示，其他文件用修改说明交代。纯展示、配置或样式文件没有关键逻辑时pseudocode为空。每个文件最多1600字符，禁止输出完整Java类、Vue组件、全部实现或大段样板代码；实际实现由后续Pi完成。返回前核对字段长度。"
        + '\n仅在选择出图时：Mermaid source 必须包含图类型声明，kind=flow 的首行为 flowchart TD（或合法方向），kind=sequence 的首行为 sequenceDiagram；之后才写节点或 participant，不能省略首行，也不要加 Markdown 围栏。流程图节点标签统一用双引号包围，如 A["用户选择模板"]、B{"是否冲突"}。'
        + "\n保持简明：实现思路建议150–300字，前后端各100–250字，数据处理100–200字；接口用最小有效样例，文件说明1–3句，伪代码只在关键逻辑有帮助时写5–10行。验收仍全部覆盖，但不在多个段落重复；说明真实取舍，不写架构科普。普通技术选择按已有代码和最简单安全做法直接决定，不再追问命名、UUID唯一性、错误文案、定时器形式等细枝末节。openQuestions只保留必须人工决定的业务结果、授权或调查后仍未知的风险。"
        + "\n返回前逐项核对设计的一致性：接口请求与前端调用、数据主记录与关联记录的身份映射、事务边界、跳过/覆盖的写入范围必须在文字、图、伪代码中一致。涉及删除或恢复字段必须直接读实体、schema和服务，既有字段与需要新增的字段明确区分，新增字段所需迁移也要列入拟改文件；不得凭项目文档假设已有支持。普通技术纠错直接写入方案，不转化为人工问答；新增关系表等扩大范围的建议先检查是否确有必要。"
        + (meta.planHash ? `\n正在收敛已有方案 ${meta.planHash}。通过read_plan读取当前相关设计、specialists和discussion原文；已明确的研发决定只核实是否偏离需求，不重复追问。过去AI意见不是人类审批，不能盲从；同一根因合并修正。近期沟通导航：${JSON.stringify(recentDiscussion)}。不论修改几轮，都以当前冻结需求为准。` : "")
        + (priorPlan?.draft.design ? `\n已有方案的接口索引：${JSON.stringify(priorPlan.draft.design.interfaces.map(({ name, method, path }) => ({ name, method, path })))}。本轮是在这份方案上局部修订，不是重新设计：未被意见、源码事实或冻结需求否定的接口路径、请求响应和文件职责必须保留；确有必要改动时在approach说明原因，并同步更新前后端、接口和关键伪代码。更改数据恢复方式不能顺带重新命名接口或重建Controller。请求响应、拟改文件和其余原文通过read_plan按需读取。` : "")
        + "\n另返回 validation={checks:[{command:argv数组,reason:源码依赖和验收依据}],skipped:[{command:argv数组,reason:与影响范围无关的具体依据}],manualReason:字符串,startup:[{name,command:argv数组,healthUrl:回环健康HTTP地址,applicationUrl:应用入口或null}]}。检查和启动命令都从项目根目录运行。先读现有脚本、测试和调用依赖，只选择影响范围内的用例或构建；项目检查配置只是候选，禁止默认全量回归，无关失败不阻塞也不修复。后端改动也选择对应类/方法/依赖调用方测试。没有合适自动检查时checks=[]，manualReason说明人工验收步骤，绝不伪称通过。startup描述可选本地验证需要的前后端服务；healthUrl仅用于就绪探测，applicationUrl用于打开应用页面，无页面的后端明确为null，禁止用健康地址充当页面入口，明确回环绑定和端口；检查依赖/环境，不猜测凭据。缺启动脚本时将最小启动方式的文件纳入affectedFiles和changes，交由编码补齐。CLI或库没有常驻服务可startup=[]。用户不填写命令；相关检查通过后人工确认即可归档，不配置环境也可以；本地启动验证和测试环境发布均为可选步骤，不强制最终环境自动化测试。"
        + `\n项目根目录命令目录：${JSON.stringify(initializationCommands(projectBaseline))}。复用其中已包含子目录参数的argv，不得丢掉--prefix/--dir/--cwd。子目录有脚本不等于根目录有脚本；例如frontend/package.json的serve必须用["npm","--prefix","frontend","run","serve"]。Maven没有根pom.xml时用-f指定真实pom.xml路径，-pl只选择已有聚合项目的模块，不能代替-f。逐项直接读取启动配置核对端口、监听地址、前端代理和可返回成功状态的健康路径，url必须与命令一致，不得猜8080/8081。核对数据库启动初始化和外部依赖，避免本地验证对现有业务数据库执行建表或初始化写入；需要变更启动参数时显式写入command。`
        + "\nAssess the real runtime feature, not only its isolated tests: persistent writes require impacts.data=changed and documented data recovery. Persistence alone is not irreversible. Use reversible only with concrete backup/restore steps and verification; irreversible means no documented recovery can restore the affected state. Test isolation does not establish code_only recovery for a data feature. Missing operational recovery facts stay unresolved; never invent them. Existing loaders and builtin registration must be read from real source, not guessed."
        + "\n有INSERT、UPDATE或逻辑删除时，即使没有DDL也不能把数据恢复写成code_only。给出受影响记录/旧值的备份或记录方式、失败事务回滚及必要时恢复的具体步骤和验证，核实后才能标documented。运维恢复步骤不等于增加用户可见的撤销功能，也不强制独立回退脚本；能用已有可靠方式就复用，缺少必要事实再提问。沟通中的AI建议须核实，不得直接沿用'代码回滚可恢复数据库'等错误结论。"
        + (revisionProposal ? `\n本轮包含研发直接编辑提案。额外返回 candidateReview={proposalHash:"${sha256(JSON.stringify(revisionProposal))}",status:accepted/adjusted/product_confirmation/human_led,reasons:非空理由数组最多4项}。核实源码，不盲从研发：合理保留的提案为accepted，调整改法须adjusted并说明具体理由和替代建议；需要改变业务需求则product_confirmation；复杂设计则human_led。当前方案仍必须遵守原冻结需求，不得为了通过而删除验收或隐藏未知影响。` : ""),
      logFile, remainingCost, null, [], { ...allowance, developerSession: true,
        ...(priorPlan ? { resumeSession: events.findLast(event => event.type === "plan_reply" && event.detail.planHash === meta.planHash)?.detail.telemetry.sessionCheckpoint ?? priorPlan.developerSession } : {}),
        planContract: contract, ...(meta.planHash ? { discussionTask: id } : {}), authoritativeContext: { contractHash: meta.contractHash, contract, currentState: "contract_confirmed" },
        outputSchema });
      if (manifestHash(await manifest(planningWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== baseHash) {
        throw new Error("Planning workspace changed during read-only Pi run");
      }
      const after = manifestHash(await sourceManifest(project));
      if (after !== baseHash) throw new Error("Project files changed during read-only planning");
      let developerSession = checkpoint ? checkpoint.detail.telemetry.sessionCheckpoint : result.telemetry.sessionCheckpoint;
      let draft;
      if (checkpoint) {
        if (path.dirname(checkpoint.detail.draftFile) !== directory) throw new Error("Plan checkpoint must belong to this requirement");
        const saved = JSON.parse(await fs.readFile(checkpoint.detail.draftFile, "utf8"));
        if (sha256(JSON.stringify(saved)) !== checkpoint.detail.analysisHash) throw new Error("Plan draft checkpoint changed");
        draft = planAnalysisInput(saved, contract, project);
      } else draft = planAnalysisInput(JSON.parse(result.text), contract, project);
      if (draft.schemaVersion !== 2) throw new Error("新生成的研发方案必须包含完整设计说明。");
      if (revisionProposal && draft.candidateReview?.proposalHash !== sha256(JSON.stringify(revisionProposal))) throw new Error("Plan revision must objectively assess the exact developer proposal");
      if (revisionProposal && draft.candidateReview.status === "accepted") {
        draft = planAnalysisInput({ ...revisionProposal, candidateReview: draft.candidateReview }, contract, project);
      }
      for (const api of draft.design.interfaces) {
        if (api.status !== "new" && !Object.hasOwn(baseline, api.sourceFile)) throw new Error(`接口引用的源码不存在：${api.sourceFile}`);
      }
      const caseMismatch = draft.affectedFiles.find(file => !Object.hasOwn(baseline, file)
        && Object.keys(baseline).some(existing => existing.toLowerCase() === file.toLowerCase()));
      if (caseMismatch) throw new Error(`Plan file path case does not match the verified source index: ${caseMismatch}`);
      let admission = assessAdmission(draft, contract, policy);
      let specialistRoles = admission.eligible ? planSpecialists(draft, reviewPolicy) : [];
      const drafted = { ...active, planCostUsd: active.planCostUsd + (checkpoint ? 0 : result.costUsd) };
      if (checkpoint) {
        await appendEvent(project, id, "plan_draft_reused", drafted, { contextHash, version,
          sourceEventHash: checkpoint.hash, draftFile: checkpoint.detail.draftFile,
          analysisHash: checkpoint.detail.analysisHash, modelRun: false, phase: "plan",
          reason: "Planning inputs and draft hashes match; reuse completed draft" });
      } else {
        const draftFile = path.join(directory, `plan-draft-v${version}-attempt-${attempt}.json`);
        await fs.writeFile(draftFile, JSON.stringify(draft, null, 2), { flag: "wx", mode: 0o600 });
        await appendEvent(project, id, "plan_draft_completed", drafted, { contractHash: meta.contractHash,
          analysisHash: sha256(JSON.stringify(draft)), roles: specialistRoles, admission,
          contextHash, version, draftFile, logFile, costUsd: result.costUsd, telemetry: result.telemetry });
      }
      draftRecorded = true;
      let checked = await reviewPlanAnalysis(project, id, drafted, directory, planningWorkspace, baseHash, draft, contract, specialistRoles, contextHash);
      let internalCorrection = null;
      let correctionAttempts = 0;
      let previousTechnicalFailure;
      let repeatedTechnicalFailures = 0;
      let technicalFindings = checked.results.flatMap(row => row.findings.findings
        .filter(item => item.severity === "blocking").map(item => ({ role: row.role, ...item })));
      while (admission.status !== "out_of_scope" && !draft.openQuestions.length
          && !["product_confirmation", "human_led"].includes(draft.candidateReview?.status)
          && (admission.reasons.length || technicalFindings.length)) {
        const failureSignature = sha256(JSON.stringify([admission.reasons, technicalFindings]));
        repeatedTechnicalFailures = previousTechnicalFailure === failureSignature ? repeatedTechnicalFailures + 1 : 1;
        previousTechnicalFailure = failureSignature;
        if (repeatedTechnicalFailures >= 3) break;
        correctionAttempts++;
        const priorAnalysisHash = sha256(JSON.stringify(draft));
        const correctionCheckpoint = (await readTask(project, id)).events.findLast(event => event.type === "plan_correction_completed"
          && event.detail.contextHash === contextHash && event.detail.version === version
          && event.detail.priorAnalysisHash === priorAnalysisHash);
        const correctionLog = path.join(directory, `plan-v${version}-attempt-${attempt}-correction-${correctionAttempts}.events.jsonl`);
        let correctionRun;
        try {
          if (correctionCheckpoint) {
            if (path.dirname(correctionCheckpoint.detail.draftFile) !== directory) throw new Error("Plan correction checkpoint belongs to another requirement");
            const saved = JSON.parse(await fs.readFile(correctionCheckpoint.detail.draftFile, "utf8"));
            if (sha256(JSON.stringify(saved)) !== correctionCheckpoint.detail.analysisHash) throw new Error("Plan correction checkpoint changed");
            draft = planAnalysisInput(saved, contract, project);
            await appendEvent(project, id, "plan_correction_reused", checked.meta, { contextHash, version,
              sourceEventHash: correctionCheckpoint.hash, draftFile: correctionCheckpoint.detail.draftFile,
              analysisHash: correctionCheckpoint.detail.analysisHash, modelRun: false, phase: "plan" });
          } else {
            const { markdown, ...currentDesign } = draft;
            const fields = ["affectedFiles", "changes", "domains", "impacts", "verification", "validation", "openQuestions", "boundaries",
              ...(revisionProposal ? ["candidateReview"] : [])];
            const patchProperties = Object.fromEntries(fields.map(key => [key, { anyOf: [outputSchema.schema.properties[key], { type: "null" }] }]));
            patchProperties.verification = { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
              required: contract.acceptance.map(item => item.id),
              properties: Object.fromEntries(contract.acceptance.map(item => [item.id, { anyOf: [{ type: "null" }, {
                type: "object", additionalProperties: false, required: ["scenario", "regression"], properties: {
                  scenario: planOutputSchema.schema.properties.verification.items.properties.scenario,
                  regression: planOutputSchema.schema.properties.verification.items.properties.regression } }] }])) }] };
            patchProperties.design = { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
              required: Object.keys(planOutputSchema.schema.properties.design.properties),
              properties: Object.fromEntries(Object.entries(planOutputSchema.schema.properties.design.properties)
                .map(([key, value]) => [key, { anyOf: [value, { type: "null" }] }])) }] };
            const correctionSchema = { name: "delivery_plan_correction", strict: true, schema: {
              type: "object", additionalProperties: false, required: Object.keys(patchProperties), properties: patchProperties } };
            const navigation = { draftHash: priorAnalysisHash, sections: Object.keys(currentDesign.design),
              affectedFiles: currentDesign.affectedFiles,
              components: currentDesign.design.components.map(({ file, domain, location }) => ({ file, domain, location })),
              interfaces: currentDesign.design.interfaces.map(({ name, method, path, status, sourceFile }) => ({ name, method, path, status, sourceFile })),
              impacts: Object.fromEntries(Object.entries(currentDesign.impacts).map(([kind, impact]) => [kind, impact.status])),
              recovery: currentDesign.boundaries.recovery.status, openQuestions: currentDesign.openQuestions,
              ...(revisionProposal ? { candidateReview: currentDesign.candidateReview } : {}) };
            await appendEvent(project, id, "plan_correction_started", checked.meta, { contextHash, version, priorAnalysisHash,
              reasons: admission.reasons, findings: technicalFindings, attempt: correctionAttempts, repeatedTechnicalFailures });
            const correctionPrompt = `局部研发方案纠错。内部检查发现具体问题，请核实源码并修正，不让研发充当技术问题传话人。仅返回指定JSON修改对象：所有字段必须出现，未修改的字段显式为null；design仅返回需要修改的小节，其余小节为null。控制器保留原值，不要重新输出整份方案。\n冻结需求哈希：${meta.contractHash}\n冻结需求 JSON：${JSON.stringify(contract)}\n适用代码规范：${standardsPrompt(standards)}\n当前方案导航：${JSON.stringify(navigation)}\n承接检查：${JSON.stringify(admission.reasons)}\n专项检查：${JSON.stringify(technicalFindings)}\n完整草稿已落盘。用read_plan的planHash=${priorAnalysisHash}按需读取问题涉及的小节；数组小节整体替换前读取完整旧内容，保留无关条目。不要加载全部原文或旧聊天。\n本轮按具体阻断纠错；有新证据或问题收敛时继续，相同问题连续重复时暂停。合并同一根因，检查意见也必须客观核实；只改必要内容，保留合理接口路径、请求响应和文件职责。补齐前端调用对应的接口及后端处理，同步相关伪代码和验证。恢复步骤不得扩大为需求外的撤销功能。涉及业务取舍、数据授权或调查后仍未知的风险，明确写入openQuestions并给建议，不替人决定；复杂工作写入真实承接边界。不得删验收、弱化检查或隐藏未知以通过。发现只是实现细节时保留最简做法，由Pi和真实测试验证。`;
            const remaining = (project.config.maxCostUsd ?? Infinity) - checked.meta.intakeCostUsd - checked.meta.reviewCostUsd - checked.meta.planCostUsd;
            if (remaining <= 0) throw new Error("Requirement cost budget exhausted before internal plan correction");
            correctionRun = await runPi(project, planningWorkspace, "plan", correctionPrompt
              + `\nverification修改协议：为null表示全部测试项保持不变；否则必须为按验收编号组织的对象，包含${JSON.stringify(contract.acceptance.map(item => item.id))}所有键。仅修改涉及的验收项为{scenario,regression}，其他键为null。不得返回数组、删除验收或重新编号。`
              + "\nchanges和design.components只返回需要更新的文件条目，按file合并，未返回文件保留旧说明/伪代码。design.interfaces只返回需要更新或新增的接口，按method/path合并，未返回接口保留旧契约。这些修改数组不能删除条目；完整内容通过read_plan按需读取，禁止捏造路径。affectedFiles等其他数组仍为完整替换，通常保持null。变更后端接口时同步前端调用、组件伪代码和测试。普通技术建议（例如缺失数据源的提示）采用最简方案，不把已冻结业务行为重新提问。",
              correctionLog, remaining, null, [], {
               ...modelAllowance((await readTask(project, id)).events, policy), developerSession: true, contextFiles: draft.affectedFiles,
              planContract: contract, planCorrection: { draftFile: (await readTask(project, id)).events.findLast(event =>
                ["plan_draft_completed", "plan_draft_reused", "plan_correction_completed"].includes(event.type) && event.detail.analysisHash === priorAnalysisHash).detail.draftFile,
                draftHash: priorAnalysisHash },
              outputSchema: correctionSchema, discussionTask: id, authoritativeContext: { contractHash: meta.contractHash, contract } });
            draft = planAnalysisInput(JSON.parse(correctionRun.text), contract, project, { draft, sourceFiles: Object.keys(baseline) });
          }
          if (manifestHash(await manifest(planningWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== baseHash
              || manifestHash(await sourceManifest(project)) !== baseHash) throw new Error("Files changed during read-only plan correction");
          for (const api of draft.design.interfaces) {
            if (api.status !== "new" && !Object.hasOwn(baseline, api.sourceFile)) throw new Error(`接口引用的源码不存在：${api.sourceFile}`);
          }
          const mismatch = draft.affectedFiles.find(file => !Object.hasOwn(baseline, file)
            && Object.keys(baseline).some(existing => existing.toLowerCase() === file.toLowerCase()));
          if (mismatch) throw new Error(`Plan file path case does not match the verified source index: ${mismatch}`);
          if (revisionProposal && draft.candidateReview?.proposalHash !== sha256(JSON.stringify(revisionProposal))) throw new Error("Plan correction changed the developer proposal binding");
          if (!correctionCheckpoint) {
            const draftFile = path.join(directory, `plan-correction-v${version}-attempt-${attempt}-${correctionAttempts}.json`);
            await fs.writeFile(draftFile, JSON.stringify(draft, null, 2), { flag: "wx", mode: 0o600 });
            const correctedMeta = { ...checked.meta, planCostUsd: checked.meta.planCostUsd + correctionRun.costUsd };
            await appendEvent(project, id, "plan_correction_completed", correctedMeta, { contextHash, version, priorAnalysisHash,
              analysisHash: sha256(JSON.stringify(draft)), draftFile, logFile: correctionLog,
              costUsd: correctionRun.costUsd, telemetry: correctionRun.telemetry });
            checked.meta = correctedMeta;
          }
        } catch (error) {
          const costUsd = correctionRun?.costUsd ?? error.costUsd ?? 0;
          await appendEvent(project, id, "plan_correction_failed", { ...checked.meta, planCostUsd: checked.meta.planCostUsd + costUsd },
            { contextHash, version, error: error.message, logFile: correctionLog, costUsd, modelRun: Boolean(correctionRun || error.telemetry), telemetry: correctionRun?.telemetry ?? error.telemetry ?? null });
          throw error;
        }
         developerSession = correctionCheckpoint ? correctionCheckpoint.detail.telemetry.sessionCheckpoint : correctionRun.telemetry.sessionCheckpoint;
         admission = assessAdmission(draft, contract, policy);
        specialistRoles = admission.eligible ? planSpecialists(draft, reviewPolicy) : [];
        checked = await reviewPlanAnalysis(project, id, checked.meta, directory, planningWorkspace, baseHash, draft, contract, specialistRoles, contextHash, correctionAttempts);
        technicalFindings = checked.results.flatMap(row => row.findings.findings
          .filter(item => item.severity === "blocking").map(item => ({ role: row.role, ...item })));
        internalCorrection = { attempts: correctionAttempts, repeatedTechnicalFailures };
      }
      const blockers = [...admission.reasons,
        ...(["product_confirmation", "human_led"].includes(draft.candidateReview?.status) ? draft.candidateReview.reasons : []),
        ...checked.results.flatMap((row) => row.findings.findings.filter((item) => item.severity === "blocking")
          .map((item) => `${row.role}：${item.subject}；${item.recommendation}`))];
      const decision = admission.eligible && blockers.length ? { ...admission, status: "needs_clarification",
        label: "待补充", eligible: false, reasons: blockers } : admission;
      for (const [index, command] of draft.validation.checks.map(item => item.command).entries()) {
        const checkLog = path.join(directory, `baseline-v${version}-attempt-${attempt}-check-${index + 1}.log`);
        const result = await runCommand(command, planningWorkspace, project.config.executionTimeouts.checksMs, checkLog,
          project.config.maxAuditBytes ?? null, project.config.environment.checks, project.config.checkSandbox);
        baselineChecks.push({ command, logFile: checkLog, ...result });
        if (!Number.isInteger(result.code) || result.signal !== null) throw new Error(`Baseline check did not finish normally: ${command.join(" ")}`);
      }
      if (manifestHash(await manifest(planningWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== baseHash)
        throw new Error("Scoped baseline checks modified project files");
      const text = draft.markdown.replace(/((?:^|\n)## 待确认\s*\n)[\s\S]*?(?=\n## |$)/,
        (_, heading) => `${heading}${blockers.length ? blockers.map((item) => `- ${item}`).join("\n") : "无"}`);
      const planFile = path.join(directory, `plan-v${version}.md`);
      const analysisFile = path.join(directory, `plan-analysis-v${version}.json`);
      const analysis = { schemaVersion: 1, reviewPolicy, contractHash: meta.contractHash, baselineHash: projectBaseline.snapshotHash,
        standardsHash: standards.hash, planHash: sha256(text), draft, specialists: checked.results, blockers,
         admission: decision, admissionPolicy: policy, internalCorrection, developerSession };
      await appendEvent(project, id, "plan_artifacts_prepared", { ...checked.meta, planVersion: version,
        planHash: null, planAnalysisHash: null, planBlockers: [] }, { version, planFile, analysisFile });
      await fs.writeFile(analysisFile, `${JSON.stringify(analysis, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.writeFile(planFile, text, { flag: "wx", mode: 0o600 });
      const next = { ...checked.meta, state: "plan_review", planVersion: version, planAttempts: attempt, planHash: sha256(text),
        planAnalysisHash: sha256(JSON.stringify(analysis)), developmentFiles: draft.affectedFiles,
        planBlockers: blockers, planFeedbackVersion: null, admission: decision, admissionPolicyHash: admission.policyHash, baseHash, baseRevision: revision,
        projectBaselineHash: projectBaseline.snapshotHash, configHash, configBindingVersion: 2,
        standardsHash: standards.hash, planResolutionHash: null, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "plan_created", next, { planFile, analysisFile, modelRun: false, planningWorkspace, baselineChecks,
        projectBaselineHash: projectBaseline.snapshotHash, standardsHash: standards.hash,
        analysisHash: next.planAnalysisHash, reviewPolicy, roles: specialistRoles, blockers, admission: decision });
      return { planFile, state: next.state, blocked: blockers.length > 0 };
    } catch (error) {
      const latest = (await readTask(project, id)).meta;
      const costUsd = draftRecorded ? 0 : result?.costUsd ?? error.costUsd ?? 0;
      const failed = { ...latest, state: "contract_confirmed", planAttempts: attempt, planCostUsd: (latest.planCostUsd ?? 0) + costUsd,
        updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "plan_attempt_failed", failed, { error: error.message, logFile, baselineChecks,
        costUsd, modelRun: !draftRecorded && Boolean(result || error.telemetry),
        toolCalls: draftRecorded ? 0 : result?.toolCalls ?? error.toolCalls ?? 0,
        telemetry: draftRecorded ? null : result?.telemetry ?? error.telemetry ?? null });
      throw error;
    }
  });
}

export async function revisePlan(projectPath, id, actor, feedback, authorizationHash, revisionInput) {
  requireActor(actor);
  if (revisionInput?.retry !== true && (typeof feedback !== "string" || !feedback.trim())) throw new Error("Plan review feedback is required");
  if (revisionInput?.retry === true && (feedback !== undefined || revisionInput.candidate || authorizationHash !== undefined)) throw new Error("Retry must reuse saved plan feedback without new edits or delegated authorization");
  const project = await loadProject(projectPath);
  await withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    const pendingRevision = meta.state === "contract_confirmed" && Boolean(meta.planHash)
      && meta.planFeedbackVersion === meta.planVersion;
    if (!pendingRevision) requireState(meta, "plan_review");
    if (!Object.values(meta.assignments ?? {}).some(row => row.userId === actor && row.status === "accepted")) throw new Error("Only an assigned developer can revise the plan");
    if (revisionInput && meta.planHash !== revisionInput.expectedPlanHash) throw new Error("The plan has changed; reload it before saving edits");
    if (revisionInput?.retry === true) {
      if (!pendingRevision || !events.some(event => event.type === "plan_revision_requested"
          && event.detail.priorPlanHash === meta.planHash && event.meta.planFeedbackVersion === meta.planFeedbackVersion)) throw new Error("No saved plan update is pending; submit specific feedback before updating");
      return;
    }
    if (revisionInput?.candidate) {
      const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
      planAnalysisInput(revisionInput.candidate, contract, project);
      feedback += `\n研发直接编辑的候选方案：${JSON.stringify(revisionInput.candidate)}\n这是待核实提案，不是事实或审批。核对冻结业务需求、源码、依赖、影响和验收。合理内容保留；不合理或偏离需求的内容明确说明依据和建议，不因研发身份放行。无法保持冻结需求或超出初级任务边界时，明确列入待确认/承接阻断，不擅自改变需求。`;
    }
    if (authorizationHash !== undefined) {
      const authorization = events.findLast(event => event.type === "development_authorized");
      if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted"
          || !authorization || authorization.hash !== authorizationHash || authorization.detail.actor !== actor
          || authorization.detail.contractHash !== meta.contractHash
          || authorization.detail.configHash !== describePolicy(project.config).executionConfigHash) {
        throw new Error("Delegated plan revision requires current development authorization");
      }
    }
    if (admissionPolicy(project.config).budgetMode === "strict"
        && (meta.planAttempts ?? 0) >= admissionPolicy(project.config).maxPlanAttempts) {
      const error = "Plan revision limit reached; hand off to the responsible developer";
      await appendEvent(project, id, "execution_boundary_stopped", { ...meta, executionBoundary: [error] }, { error, phase: "plan" });
      throw new Error(error);
    }
    const prior = await fs.readFile(path.join(directory, `plan-v${meta.planVersion}.md`), "utf8");
    if (sha256(prior) !== meta.planHash) throw new Error("Plan changed after it was generated");
    const revisions = events.filter(event => event.type === "plan_revision_requested" && event.detail.priorPlanHash === meta.planHash).length;
    const feedbackFile = path.join(directory, `feedback-v${meta.planVersion}${revisions ? `-revision-${revisions + 1}` : ""}.md`);
    await fs.writeFile(feedbackFile, feedback, { flag: "wx", mode: 0o600 });
    const next = { ...meta, state: "contract_confirmed", planFeedbackVersion: meta.planVersion, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "plan_revision_requested", next, { actor, feedbackFile, feedbackHash: sha256(feedback), priorPlanHash: meta.planHash,
      revisionKind: revisionInput?.candidate ? "direct_edit" : authorizationHash ? "delegated" : "human",
      ...(revisionInput?.candidate ? { candidate: revisionInput.candidate } : {}), ...(authorizationHash ? { authorizationHash } : {}) });
  });
  return plan(projectPath, id);
}

export async function resolvePlanFindings(projectPath, id, actor, input) {
  requireActor(actor);
  if (!input || !Array.isArray(input.items) || !input.items.length || input.items.length > 18
      || typeof input.implementationGuidance !== "string" || !input.implementationGuidance.trim()
      || input.implementationGuidance.length > 4000) throw new Error("Finding resolutions need explicit items and implementation guidance");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    requireState(meta, "plan_review");
    if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted") throw new Error("Only the assigned developer can resolve plan findings");
    if (meta.planResolutionHash) throw new Error("Plan findings already have a resolution; revise the plan for further changes");
    const analysis = await readPlanAnalysis(meta, directory);
    const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
    if (!assessAdmission(analysis.draft, contract, analysis.admissionPolicy).eligible) throw new Error("Unknown impacts and admission boundaries cannot be resolved by findings disposition");
    const blocking = analysis.specialists.flatMap(row => row.findings.findings.filter(finding => finding.severity === "blocking")
      .map(finding => `${row.role}:${sha256(JSON.stringify(finding))}`)).sort();
    if (!blocking.length || JSON.stringify(input.items.map(item => item.findingId).sort()) !== JSON.stringify(blocking)) throw new Error("Resolve every blocking finding exactly once");
    if (describePolicy(project.config).executionConfigHash !== meta.configHash || manifestHash(await sourceManifest(project)) !== meta.baseHash) throw new Error("Policy or source changed before findings resolution");
    await assertTaskStandards(project, meta, directory);
    const created = (await readTask(project, id)).events.findLast(event => event.type === "plan_created");
    await assertCheckEvidence(project, created.detail.baselineChecks, directory, `baseline-v${meta.planVersion}-attempt-${meta.planAttempts}`, true,
      analysis.draft.validation.checks.map(item => item.command));
    const proofs = [];
    for (const item of input.items) {
      if (!["false_positive", "clarified"].includes(item.disposition) || typeof item.reason !== "string" || !item.reason.trim()
          || item.reason.length > 2000 || !Array.isArray(item.sources) || !item.sources.length || item.sources.length > 4) throw new Error("Each finding needs a disposition, reason and bounded source evidence");
      const sources = [];
      for (const source of item.sources) {
        if (typeof source.file !== "string" || path.posix.normalize(source.file) !== source.file || source.file.includes("\\")
            || path.posix.isAbsolute(source.file) || source.file.split("/").includes("..") || !allowedFile(source.file, project.config)
            || source.file.split("/").some(part => part === ".env" || part.startsWith(".env."))
            || !Number.isSafeInteger(source.startLine) || source.startLine < 1 || !Number.isSafeInteger(source.endLine)
            || source.endLine < source.startLine || source.endLine - source.startLine >= 80) throw new Error("Invalid resolution source range");
        const file = await fs.realpath(path.join(project.root, source.file));
        assertInside(project.root, file);
        const content = await fs.readFile(file, "utf8");
        const lines = content.split("\n");
        if (source.endLine > lines.length) throw new Error("Resolution evidence exceeds source lines");
        sources.push({ ...source, hash: sha256(content), text: lines.slice(source.startLine - 1, source.endLine).join("\n") });
      }
      proofs.push({ findingId: item.findingId, disposition: item.disposition, reason: item.reason, sources });
    }
    const resolution = { schemaVersion: 1, actor, at: new Date().toISOString(), planVersion: meta.planVersion,
      planAnalysisHash: meta.planAnalysisHash, baseHash: meta.baseHash, items: proofs, implementationGuidance: input.implementationGuidance };
    const file = path.join(directory, `plan-findings-resolution-v${meta.planVersion}.json`);
    await fs.writeFile(file, `${JSON.stringify(resolution, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const next = { ...meta, planResolutionHash: sha256(JSON.stringify(resolution)), updatedAt: resolution.at };
    await appendEvent(project, id, "plan_findings_resolved", next, { actor, file, planResolutionHash: next.planResolutionHash, resolution });
    return next;
  });
}

export async function approvePlan(projectPath, id, actor, scope, authorizationHash, expectedPlanHash, developmentBranch) {
  requireActor(actor);
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    requireState(meta, "plan_review");
    if (expectedPlanHash !== undefined && expectedPlanHash !== meta.planHash) throw new Error("The plan has changed; review the current version before approval");
    const analysis = await readPlanAnalysis(meta, directory);
    if (!analysis.draft.validation) throw new Error("当前方案缺少验证与启动约定，请重新生成研发方案。");
    const developmentChecks = analysis.draft.validation.checks.map(item => item.command);
    validateConfig({ ...project.config, checks: developmentChecks });
    if (analysis.blockers.length) throw new Error("Plan analysis has unresolved blockers; revise the plan before approval");
    if (!analysis.admission.eligible) throw new Error("Requirement is outside the approved admission boundary or needs clarification");
    const teamReview = planReviewStatus(meta, analysis.draft);
    if (!teamReview.ready) throw new Error(`等待${teamReview.parts.filter(part => !part.approved).map(part => part.role === "frontend" ? "前端" : "后端").join("、")}负责人确认负责部分和共同接口。`);
    try { modelAllowance(events, admissionPolicy(project.config)); }
    catch (error) {
      await appendEvent(project, id, "execution_boundary_stopped", { ...meta, executionBoundary: [error.message] }, { error: error.message, phase: "approve-plan" });
      throw error;
    }
    const text = await fs.readFile(path.join(directory, `plan-v${meta.planVersion}.md`), "utf8");
    if (sha256(text) !== meta.planHash) throw new Error("Plan changed after it was generated");
    const created = events.findLast((event) => event.type === "plan_created");
    await assertCheckEvidence(project, created?.detail.baselineChecks, directory,
      `baseline-v${meta.planVersion}-attempt-${meta.planAttempts}`, true, developmentChecks);
    const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed after planning");
    await assertTaskStandards(project, meta, directory);
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after planning");
    const sourceHash = project.config.mode === "git"
      ? manifestHash(await manifest(created.detail.planningWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes))
      : manifestHash(await sourceManifest(project));
    if (sourceHash !== meta.baseHash) throw new Error("Project files changed after planning");
    const currentBaseline = await readProjectBaseline(project, sourceHash, project.config.mode !== "git");
    if (currentBaseline.sourceHash !== meta.baseHash || currentBaseline.configHash !== meta.configHash) {
      throw new Error("Project baseline changed after planning");
    }
    if (project.config.mode === "local" && await sourceRevision(project) !== meta.baseRevision) throw new Error("Project revision changed after planning");
    const branchSelection = project.config.mode === "git" ? await validateDevelopmentBranch(project, meta,
      developmentBranch ?? { kind: "new", branch: `${project.config.branchPrefix}/${id}${meta.restartCount ? `-restart-${meta.restartCount}` : ""}` }) : null;
    if (project.config.mode === "local" && developmentBranch !== undefined) throw new Error("目录项目不支持 Git 分支选择。");
    if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted") {
      throw new Error("Plan approval requires the assigned developer");
    }
    if (authorizationHash !== undefined) {
      throw new Error("The developer must confirm the technical plan; delegated approval is not supported");
    }
    let scopeDecision;
    if (scope !== undefined) {
      if (!scope || Object.keys(scope).some(key => !["files", "reason"].includes(key))
          || !Array.isArray(scope.files) || !scope.files.length || new Set(scope.files).size !== scope.files.length
          || scope.files.some(file => !meta.developmentFiles.includes(file))
          || typeof scope.reason !== "string" || !scope.reason.trim() || scope.reason.length > 4000) {
        throw new Error("Approval scope requires a nonempty subset of proposed files and the developer's reason");
      }
      scopeDecision = { schemaVersion: 1, actor, planVersion: meta.planVersion, planAnalysisHash: meta.planAnalysisHash,
        proposedFiles: meta.developmentFiles, files: scope.files, reason: scope.reason, at: new Date().toISOString() };
      await fs.writeFile(path.join(directory, `plan-scope-v${meta.planVersion}.json`), JSON.stringify(scopeDecision, null, 2), { flag: "wx" });
    }
    const next = { ...meta, state: "approved", developmentBranch: branchSelection, developmentChecks,
      planApprovedBy: actor, planApprovedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...(scopeDecision ? { developmentFiles: scopeDecision.files, planScopeHash: sha256(JSON.stringify(scopeDecision)) } : {}) };
    await appendEvent(project, id, "plan_approved", next, { actor,
      approvalKind: authorizationHash === undefined ? "human" : "delegated", authorizationHash: authorizationHash ?? null,
      contractHash: meta.contractHash, planHash: meta.planHash, baseHash: meta.baseHash,
       developmentChecks, checksSource: "plan", validation: analysis.draft.validation,
      admissionHash: sha256(JSON.stringify(analysis.admission)), riskOwner: actor,
       planResolutionHash: meta.planResolutionHash ?? null, scopeDecision: scopeDecision ?? null, developmentBranch: branchSelection,
       teamReview });
    return next;
  });
}

export async function resumeImplementation(projectPath, id, actor, evidence, files, reviewedEdits, modelSelection, continuation) {
  requireActor(actor);
  if (typeof evidence !== "string" || !evidence.trim() || evidence.length > 4000) throw new Error("Resume requires the responsible developer's diagnosis");
  const project = await loadProject(projectPath);
  if (project.config.mode !== "local" && !continuation) throw new Error("Implementation resume currently supports isolated local workspaces only");
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    if (!["implementation_failed", "verification_failed", "verified"].includes(meta.state)) throw new Error("Resume requires implementation or verification failure, or verified reviewer rework");
    if (continuation && (reviewedEdits !== undefined || modelSelection !== undefined
        || continuation.expectedPlanHash !== meta.planHash || continuation.expectedAfterHash !== meta.afterHash
        || !["implementation_failed", "verification_failed"].includes(meta.state))) throw new Error("继续执行的方案或代码版本已改变，请刷新查看当前现场。");
    if (meta.state === "verified" && reviewedEdits === undefined) throw new Error("Verified reviewer rework requires explicit reviewed replacements");
    if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted"
        || meta.planApprovedBy !== actor) throw new Error("Only the assigned plan approver can resume implementation");
    if (modelSelection !== undefined && (reviewedEdits !== undefined || !modelSelection
        || Object.keys(modelSelection).sort().join() !== "model,provider,thinking"
        || (!project.config.compatibleProviders?.some(provider => provider.name === modelSelection.provider
          && provider.models.some(model => model.id === modelSelection.model))
          && !(project.config.modelFallbacks ?? []).some(candidate => ["provider", "model", "thinking"]
            .every(key => candidate[key] === modelSelection[key]))))) {
      throw new Error("Owner model selection must exactly match a configured candidate and cannot accompany reviewed edits");
    }
    const failed = events.findLast(event => event.type === meta.state);
    const changeEvent = meta.state === "implementation_failed" ? failed : events.findLast(event => event.type === "implemented");
    const report = JSON.parse(await fs.readFile(path.join(directory, "changes.json"), "utf8"));
    if (!failed || !changeEvent || (changeEvent.type === "implementation_failed" && changeEvent.detail.violations.length)
        || meta.changeCount !== changeEvent.detail.changes.length
        || JSON.stringify(report.changes) !== JSON.stringify(changeEvent.detail.changes) || report.violations.length) throw new Error("Resume requires unchanged audited changes without scope violations");
    const resumableFiles = new Set(meta.developmentFiles);
    if (project.config.implementationScope === "project" && !meta.fastPathEligibility && !meta.planScopeHash) {
      for (const change of report.changes) resumableFiles.add(change.file);
    }
    if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length
        || files.some(file => !resumableFiles.has(file))) throw new Error("Resume files must explicitly select approved implementation files or audited project additions");
    const source = project.config.mode === "git"
      ? await manifest(events.findLast(event => event.type === "plan_created").detail.planningWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes)
      : await sourceManifest(project);
    if (project.config.mode === "git" && (await runGit(meta.workspace, ["branch", "--show-current"]) !== meta.branch
        || await runGit(meta.workspace, ["rev-parse", "HEAD"]) !== meta.baseRevision)) throw new Error("需求分支或基础提交已改变，请先核对工作目录。");
    if (describePolicy(project.config).executionConfigHash !== meta.configHash || manifestHash(source) !== meta.baseHash
        || manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.afterHash
        || manifestHash(await manifest(path.join(directory, "baseline"), project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.baselineHash) throw new Error("Source, policy, workspace or recovery snapshot changed before resume");
    await assertTaskStandards(project, meta, directory);
    const analysis = await readPlanAnalysis(meta, directory);
    if (!analysis.admission.eligible
        || !["none", "reversible"].includes(analysis.draft.boundaries.externalEffects.status)
        || !["code_only", "documented"].includes(analysis.draft.boundaries.recovery.status)
        || (analysis.draft.impacts.data.status === "changed" && analysis.draft.boundaries.recovery.status !== "documented")) {
      throw new Error("Resume requires an eligible approved plan with documented recovery for data or reversible effects");
    }
    const replacements = [];
    if (reviewedEdits !== undefined) {
      if (!Array.isArray(reviewedEdits) || !reviewedEdits.length
          || new Set(reviewedEdits.map(edit => edit?.file)).size !== files.length) throw new Error("Reviewed repair requires explicit replacements covering every selected file");
      for (const edit of reviewedEdits) {
        if (!edit || Object.keys(edit).sort().join() !== "file,newText,oldText" || !files.includes(edit.file)
            || typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string"
            || edit.oldText === edit.newText || [edit.oldText, edit.newText].some(text => text.split("\n").length > 50)) throw new Error("Reviewed repair requires unique nonempty old text and at most 50 lines per replacement");
        const file = await fs.realpath(path.join(meta.workspace, edit.file));
        assertInside(await fs.realpath(meta.workspace), file);
        const previous = replacements.find(replacement => replacement.path === file);
        const text = previous ? previous.text : await fs.readFile(file, "utf8");
        const offset = text.indexOf(edit.oldText);
        if (offset < 0 || text.indexOf(edit.oldText, offset + 1) >= 0) throw new Error(`Reviewed repair must uniquely match current source: ${edit.file}`);
        const replaced = text.slice(0, offset) + edit.newText + text.slice(offset + edit.oldText.length);
        if (previous) previous.text = replaced;
        else replacements.push({ ...edit, path: file, text: replaced });
      }
    } else modelAllowance(events, admissionPolicy(project.config));
    const retained = path.join(directory, `implementation-${meta.state === "verified" ? "review" : "failure"}-${failed.hash}`);
    const saved = await manifest(path.join(directory, "after"), project.config.excludedPaths, project.config.maxSnapshotBytes);
    if (report.changes.some(change => change.after && JSON.stringify(saved[change.file]) !== JSON.stringify(change.after))) throw new Error("Implementation snapshot changed before resume");
    await fs.mkdir(retained, { mode: 0o700 });
    await fs.writeFile(path.join(retained, "changes.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await copyFiles(path.join(directory, "after"), path.join(retained, "after"), report.changes.filter(change => change.after).map(change => change.file));
    await appendEvent(project, id, "implementation_attempt_retained", meta, { actor, evidence: evidence.trim(), files,
      priorState: meta.state, priorFailureHash: failed.hash, priorImplementationHash: changeEvent.hash, retained, reportHash: sha256(JSON.stringify(report)) });
    if (reviewedEdits !== undefined) {
      const active = { ...meta, state: "implementing", changeApproval: null, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "reviewed_repair_started", active, { actor, riskOwner: actor,
        evidence: evidence.trim(), reviewedEdits, priorFailureHash: failed.hash, modelRun: false, source: "owner_reviewed_replacement" });
      let inspected;
      let failure;
      try {
        for (const edit of replacements) await fs.writeFile(edit.path, edit.text);
        inspected = await inspectChanges(project, id, meta.workspace);
        if (inspected.violations.length) throw new Error(`Reviewed repair exceeds scope: ${inspected.violations.join(", ")}`);
        if (!inspected.changes.length) throw new Error("Reviewed repair leaves no implementation changes");
      } catch (error) {
        failure = error;
        if (!inspected) {
          try { inspected = await inspectChanges(project, id, meta.workspace); }
          catch (inspectionError) {
            await appendEvent(project, id, "implementation_inspection_failed", { ...active, state: "implementation_inspection_failed" },
              { actor, riskOwner: actor, modelRun: false, source: "owner_reviewed_replacement",
                error: error.message, inspectionError: inspectionError.message });
            throw new AggregateError([error, inspectionError], "Reviewed repair and change inspection failed");
          }
        }
      }
      const next = { ...active, state: failure ? "implementation_failed" : "implemented", resumeImplementationFiles: null,
        changeCount: inspected.changes.length, afterHash: inspected.afterHash, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, failure ? "implementation_failed" : "implemented", next, { actor, riskOwner: actor,
        evidence: evidence.trim(), changes: inspected.changes, violations: inspected.violations, modelRun: false,
        source: "owner_reviewed_replacement", sourceEventHash: failed.hash,
        reason: "Owner-reviewed deterministic repair; no model invocation; external checks required",
        ...(failure ? { error: failure.message } : {}) });
      if (failure) throw failure;
      return next;
    }
    const next = { ...meta, state: "approved", changeApproval: null, resumeImplementationFiles: files,
      resumeContinuation: Boolean(continuation), developmentPause: null,
      resumeSession: continuation ? changeEvent.detail.telemetry?.sessionCheckpoint ?? null : null,
      resumeImplementationModel: modelSelection ?? null, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "implementation_resumed", next, { actor, evidence: evidence.trim(), files,
      priorFailureHash: failed.hash, priorImplementationHash: changeEvent.hash, retained, reportHash: sha256(JSON.stringify(report)),
      planHash: meta.planHash, baseHash: meta.baseHash, afterHash: meta.afterHash, riskOwner: actor,
      modelSelection: modelSelection ?? null, continuation: Boolean(continuation), automatic: continuation?.automatic === true });
    return next;
  });
}

export async function implement(projectPath, id) {
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    requireState(meta, "approved");
    const commands = meta.developmentChecks;
    if (meta.planApprovedBy !== meta.assignments?.developer?.userId
        || meta.assignments.developer.status !== "accepted") {
      throw new Error("Implementation requires the assigned developer's plan approval");
    }
    const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed after plan approval");
    const standards = await assertTaskStandards(project, meta, directory);
    const analysis = await readPlanAnalysis(meta, directory);
    if (!analysis.admission.eligible) throw new Error("Requirement is outside the implementation admission boundary");
    let allowance;
    try { allowance = modelAllowance(events, admissionPolicy(project.config)); }
    catch (error) {
      await appendEvent(project, id, "execution_boundary_stopped", { ...meta, executionBoundary: [error.message] }, { error: error.message, phase: "implement" });
      throw error;
    }
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    const resumed = Array.isArray(meta.resumeImplementationFiles);
    const reference = JSON.parse(await baselineAgentContext(project, await readProjectBaseline(project, null, project.config.mode !== "git"), meta.developmentFiles, "index"));
    const implementationScope = (resumed && !meta.resumeContinuation) || meta.fastPathEligibility || meta.planScopeHash
      ? "plan" : project.config.implementationScope;
    const projectContext = JSON.stringify(reference);
    const planText = await fs.readFile(path.join(directory, `plan-v${meta.planVersion}.md`), "utf8");
    if (sha256(planText) !== meta.planHash) throw new Error("Approved plan changed before implementation");
    const previousImplementationCost = meta.implementationCostUsd ?? 0;
    const remainingCost = (project.config.maxCostUsd ?? Infinity) - meta.intakeCostUsd - meta.reviewCostUsd - meta.planCostUsd - previousImplementationCost;
    if (remainingCost <= 0) {
      await appendEvent(project, id, "pi_budget_exhausted", meta, { phase: "implement", reason: "Requirement cost budget exhausted" });
      throw new Error("Requirement cost budget exhausted before implementation");
    }
    if (resumed && manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.afterHash) throw new Error("Resumed workspace changed before execution");
    const prepared = resumed ? { workspace: meta.workspace, branch: meta.branch, baselineHash: meta.baselineHash }
      : await prepareWorkspace(project, id, meta.baseHash, meta.baseRevision, meta.developmentBranch, meta.restartCount ?? 0);
    const baseline = JSON.parse(await fs.readFile(path.join(directory, "baseline.json"), "utf8"));
    if (manifestHash(baseline) !== prepared.baselineHash) throw new Error("Implementation baseline manifest changed");
    prepared.runtimeDependencies = [];
    for (const file of Object.keys(baseline).filter(file => path.posix.basename(file) === "package.json")) {
      const sourceDirectory = path.posix.dirname(file);
      if (!(await fs.readdir(path.join(project.root, sourceDirectory))).includes("node_modules")) continue;
      const relative = path.posix.join(sourceDirectory, "node_modules");
      if (!(await fs.readdir(path.join(prepared.workspace, sourceDirectory))).includes("node_modules")) {
        const dependencies = await fs.realpath(path.join(project.root, relative));
        await fs.cp(dependencies, path.join(prepared.workspace, relative),
          { recursive: true, verbatimSymlinks: true, filter: async source => {
            if ((await fs.lstat(source)).isSymbolicLink()) {
              const target = await fs.readlink(source);
              if (path.isAbsolute(target)) throw new Error(`Installed dependency has an absolute link: ${source}`);
              assertInside(dependencies, await fs.realpath(source));
            }
            return true;
          } });
      }
      prepared.runtimeDependencies.push(relative);
    }
    const attempt = events.filter(event => event.type === "workspace_prepared").length + 1;
    const active = { ...meta, ...prepared, resumeImplementationFiles: null, resumeImplementationModel: null,
      resumeSession: null, resumeContinuation: false, developmentFailure: null, developmentPause: null,
      state: "implementing", updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "workspace_prepared", active, { workspace: prepared.workspace,
      branch: prepared.branch, runtimeDependencies: prepared.runtimeDependencies });
    const prompt = resumed && !meta.resumeContinuation
      ? `Apply the owner's diagnosed local repair only. No redesign, scope expansion or weaker tests. Controller verified the frozen contract, approval and snapshots; full external regression/change review remain required. Use native tools to investigate, edit and verify; report actual results.\nContract: ${meta.contractHash}\nFrozen requirement: ${JSON.stringify(contract)}\nPlan: ${meta.planHash}\nApproved changes: ${JSON.stringify(analysis.draft.changes.filter(item => meta.resumeImplementationFiles.includes(item.file)))}\nApproved impact and recovery: ${JSON.stringify({ impacts: analysis.draft.impacts, recovery: analysis.draft.boundaries.recovery, externalEffects: analysis.draft.boundaries.externalEffects })}\nExcluded scope: ${JSON.stringify(contract.outOfScope)}\nStandards (${standards.hash}): ${standardsPrompt(standards)}`
      : `Implement the approved plan for the confirmed requirement. Investigate only evidence needed for this implementation. ${implementationScope === "project" ? "Necessary related source and tests within project allowed paths may be changed; explain additions. Do not add unrelated features." : "Edit approved files only."} Preserve existing assertions and use the existing verification infrastructure for changed behavior. Report actual checks and unresolved issues.\n计划文件：${JSON.stringify(meta.developmentFiles)}\n项目授权目录：${JSON.stringify(project.config.allowedPaths)}\n项目参考上下文：${projectContext}\n适用代码规范（哈希 ${standards.hash}）：${standardsPrompt(standards)}\n产品确认的需求契约：\n${JSON.stringify(contract)}\n计划改法：${JSON.stringify(analysis.draft.changes)}\n影响与恢复依据：${JSON.stringify({ impacts: analysis.draft.impacts, recovery: analysis.draft.boundaries.recovery, externalEffects: analysis.draft.boundaries.externalEffects })}`;
    let inspected;
    let result;
    try {
      const diagnosis = resumed ? events.findLast(event => event.type === "implementation_resumed").detail.evidence : null;
      const resolvedGuidance = (analysis.resolution ? `\n责任研发人逐项澄清（${analysis.resolution.actor}；只在已批准文件和需求内实施）：\n${analysis.resolution.implementationGuidance}` : "")
        + (analysis.approvalScope ? `\nApproved owner scope note (${analysis.approvalScope.actor}): ${analysis.approvalScope.reason}` : "")
        + (resumed ? `\nContinue from the current retained workspace: ${JSON.stringify(meta.resumeImplementationFiles)}. Prior failure and evidence: ${diagnosis}. Preserve completed edits and existing assertions. Investigate and fix the root cause; never weaken tests to pass. This is a fresh coding session: inspect current source rather than relying on historical tool results.` : "");
      const verificationGuidance = (analysis.draft.schemaVersion === 2 ? `\nApproved implementation design (${meta.planHash}): ${JSON.stringify(analysis.draft.design)}\nFollow these reviewed interface fields, rendering choices, component locations and data handling; a file change summary does not replace this design.` : "")
        + `\nAcceptance assertions: ${JSON.stringify(analysis.draft.verification)}. Approved validation contract: ${JSON.stringify(analysis.draft.validation)}. Only execute scoped checks; never repair skipped unrelated suites. Complete planned missing startup scripts. Do not start persistent servers during coding: the controller starts them when local validation is selected. Never claim manual acceptance. The controller independently verifies the source against these checks.`;
      const specialistGuidance = analysis.specialists.flatMap(row => row.findings.findings.filter(finding => finding.severity === "advisory")
        .map(finding => ({ role: row.role, subject: finding.subject, evidence: finding.evidence, recommendation: finding.recommendation })));
      const implementationGuidance = specialistGuidance.length
        ? `\n方案审核中的实施建议：${JSON.stringify(specialistGuidance)}。核实源码后在已冻结需求及批准权限内落实，不扩大范围，不把建议当成新的业务决定。` : "";
      const currentFiles = await manifest(prepared.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes);
      const currentChanges = compareManifests(baseline, currentFiles);
      const pathGuidance = `\nController-verified approved path status: ${JSON.stringify((resumed ? meta.resumeImplementationFiles : meta.developmentFiles).map(file => ({ file, existsInWorkspace: Object.hasOwn(currentFiles, file) })))}. Paths marked false are planned NEW files, not missing source evidence. Create them in the approved location; parent directories may also be new. Do not read or list a nonexistent planned file or parent directory. Investigate existing source through the verified source index instead.`;
      result = await runPi({ ...project, config: { ...project.config, checks: commands } }, prepared.workspace, "implement", prompt + resolvedGuidance + verificationGuidance + implementationGuidance + pathGuidance,
        path.join(directory, attempt === 1 ? "implement.events.jsonl" : `implement-attempt-${attempt}.events.jsonl`), remainingCost,
          null, [], { ...allowance,
           ...(resumed && meta.resumeImplementationModel ? { modelSelection: meta.resumeImplementationModel } : {}),
          approvedFiles: resumed ? meta.resumeImplementationFiles : meta.developmentFiles, researchRequests: 1, implementationScope,
          authoritativeContext: { contractHash: meta.contractHash, contract, planHash: meta.planHash,
            changes: analysis.draft.changes, verification: analysis.draft.verification, validation: analysis.draft.validation, openQuestions: analysis.draft.openQuestions,
            ...(analysis.draft.schemaVersion === 2 ? { design: analysis.draft.design } : {}),
            impacts: analysis.draft.impacts, recovery: analysis.draft.boundaries.recovery,
            externalEffects: analysis.draft.boundaries.externalEffects, standards: standardsPrompt(standards), checks: commands,
            guidance: { scope: analysis.approvalScope, resolution: analysis.resolution ? {
              actor: analysis.resolution.actor, planResolutionHash: meta.planResolutionHash,
              implementationGuidance: analysis.resolution.implementationGuidance,
              items: analysis.resolution.items.map(item => ({ ...item,
                sources: item.sources.map(({ text, ...reference }) => reference) })) } : null },
            projectReference: reference, specialistGuidance, currentState: "approved", implementationScope,
              workspaceState: { sourceHash: manifestHash(currentFiles), changes: currentChanges },
             ...(resumed ? { diagnosis } : {}) },
          sourceQuery: JSON.stringify({ changes: analysis.draft.changes, impacts: analysis.draft.impacts }) });
      inspected = await inspectChanges(project, id, prepared.workspace);
      if (inspected.violations.length) throw new Error(`Changes exceed approved scope: ${inspected.violations.join(", ")}`);
      if (!inspected.changes.length) throw new Error("Pi made no code changes");
      const next = { ...active, state: "implemented", changeCount: inspected.changes.length, afterHash: inspected.afterHash, implementationCostUsd: previousImplementationCost + result.costUsd, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "implemented", next, { changes: inspected.changes, scopeAdditions: inspected.scopeAdditions,
        warnings: inspected.warnings, usage: result.usage,
        costUsd: result.costUsd, toolCalls: result.toolCalls, telemetry: result.telemetry });
      return next;
    } catch (error) {
      const costUsd = result?.costUsd ?? error.costUsd ?? 0;
      const telemetry = result?.telemetry ?? error.telemetry ?? null;
      const toolCalls = result?.toolCalls ?? error.toolCalls ?? 0;
      if (!inspected) {
        try {
          inspected = await inspectChanges(project, id, prepared.workspace);
        } catch (inspectionError) {
          const failed = { ...active, state: "implementation_inspection_failed", implementationCostUsd: previousImplementationCost + costUsd,
            updatedAt: new Date().toISOString() };
          await appendEvent(project, id, "implementation_inspection_failed", failed, { error: error.message,
            inspectionError: inspectionError.message, costUsd, toolCalls, telemetry, modelRun: Boolean(result || error.telemetry) });
          throw new AggregateError([error, inspectionError], "Implementation failed and changed files could not be inspected");
        }
      }
      const kind = inspected.violations.length ? "scope_violation" : error.code === "PI_TOOL_LIMIT" ? "tool_limit"
        : error.code === "PI_TIMEOUT" ? "timeout" : error.code === "EXECUTION_PAUSED" ? "user_paused" : "implementation_error";
      const failed = { ...active, state: "implementation_failed", changeCount: inspected.changes.length,
        developmentFailure: { kind, message: error.message, retryable: !inspected.violations.length },
        afterHash: inspected.afterHash, implementationCostUsd: previousImplementationCost + costUsd, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "implementation_failed", failed, { error: error.message,
        kind, changes: inspected.changes, violations: inspected.violations, costUsd, toolCalls, telemetry, modelRun: Boolean(result || error.telemetry) });
      throw error;
    }
  });
}

export async function verify(projectPath, id) {
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    if (!["implemented", "verification_failed"].includes(meta.state)) throw new Error(`Task ${id} is ${meta.state}; expected implemented or verification_failed`);
    const commands = meta.developmentChecks;
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    if (!(await readPlanAnalysis(meta, directory)).admission.eligible) throw new Error("Requirement is outside the verification admission boundary");
    await assertTaskStandards(project, meta, directory);
    const before = manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
    if (before !== meta.afterHash) throw new Error("Workspace changed after implementation");
    const results = [];
    const verificationAttempt = events.filter(event => ["verified", "verification_failed"].includes(event.type)).length + 1;
    const checkPrefix = verificationAttempt === 1 ? "" : `verification-attempt-${verificationAttempt}-`;
    try {
      for (const [index, command] of commands.entries()) {
        const logFile = path.join(directory, `${checkPrefix}check-${index + 1}.log`);
        const result = await runCommand(command, meta.workspace, project.config.executionTimeouts.checksMs, logFile,
          project.config.maxAuditBytes ?? null, project.config.environment.checks, project.config.checkSandbox);
        results.push({ command, logFile, ...result });
        if (result.code !== 0) throw Object.assign(new Error(`Check failed: ${command.join(" ")}; ${result.tail}`), { code: "CHECK_FAILED" });
      }
      const after = manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
      if (after !== before) throw new Error("Verification commands modified project files");
      const verificationMode = commands.length ? "automated" : "manual_pending";
      const next = { ...meta, state: "verified", verificationAttempt, verificationMode, checks: results, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "verified", next, { checks: results, verificationMode,
        validation: (await readPlanAnalysis(meta, directory)).draft.validation });
      return next;
    } catch (error) {
      const failed = { ...meta, state: "verification_failed", verificationAttempt, checks: results,
        developmentFailure: { kind: error.code === "EXECUTION_PAUSED" ? "user_paused" : error.code === "CHECK_FAILED" ? "check_failed" : "verification_error", message: error.message, retryable: error.code === "CHECK_FAILED" },
        updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "verification_failed", failed, { error: error.message, checks: results });
      throw error;
    }
  });
}

export async function approveChanges(projectPath, id, actor, evidence) {
  requireActor(actor);
  if (typeof evidence !== "string" || !evidence.trim() || evidence.length > 4000) {
    throw new Error("A concise change review decision is required (1-4000 characters)");
  }
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    requireState(meta, "verified");
    if (meta.planApprovedBy !== meta.assignments?.developer?.userId) {
      throw new Error("Change approval requires prior human plan approval");
    }
    if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted") {
      throw new Error("Change approval requires the assigned developer");
    }
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after verification");
    if (!(await readPlanAnalysis(meta, directory)).admission.eligible) throw new Error("Requirement is outside the change approval admission boundary");
    await assertTaskStandards(project, meta, directory);
    await assertCheckEvidence(project, meta.checks, directory, meta.verificationAttempt === 1 ? "" : `verification-attempt-${meta.verificationAttempt}`,
      false, meta.developmentChecks);
    const current = manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
    if (current !== meta.afterHash) throw new Error("Workspace changed after verification");
    const changes = events.findLast((event) => event.type === "implemented")?.detail.changes;
    if (!Array.isArray(changes) || !changes.length) throw new Error("Implementation change evidence is missing");
    const report = JSON.parse(await fs.readFile(path.join(directory, "changes.json"), "utf8"));
    if (JSON.stringify(report.changes) !== JSON.stringify(changes) || report.violations.length) {
      throw new Error("Archived changes differ from the audited implementation");
    }
    for (const change of changes) {
      for (const [kind, entry] of [["baseline", change.before], ["after", change.after]]) {
        if (!entry) continue;
        const file = path.join(directory, kind, change.file);
        const content = await fs.readFile(file);
        const stat = await fs.stat(file);
        if (sha256(content) !== entry.hash || (stat.mode & 0o777) !== entry.mode) {
          throw new Error(`Archived ${kind} snapshot changed: ${change.file}`);
        }
      }
    }
    const approval = { actor, at: new Date().toISOString(), contractHash: meta.contractHash,
      planHash: meta.planHash, baseHash: meta.baseHash, afterHash: meta.afterHash,
      standardsHash: meta.standardsHash,
      changesHash: sha256(JSON.stringify(changes)), files: changes.map((change) => change.file),
      evidence: evidence.trim() };
    const next = { ...meta, changeApproval: approval, updatedAt: approval.at };
    await appendEvent(project, id, "changes_approved", next, { actor, approval });
    return next;
  });
}

export async function recordPublished(projectPath, id, actor) {
  requireActor(actor);
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    requireState(meta, "verified");
    if (!meta.changeApproval || meta.changeApproval.actor !== meta.assignments?.developer?.userId
        || meta.changeApproval.afterHash !== meta.afterHash) {
      throw new Error("Publishing a requirement branch requires approved verified changes");
    }
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    await assertTaskStandards(project, meta, directory);
    const revision = await publishedRevision(project, meta.workspace, meta.branch);
    const current = manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
    if (current !== meta.afterHash) throw new Error("Committed files differ from verified files");
    const next = { ...meta, publishedRevision: revision, publishedBy: actor, gitDeliveryError: null, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "revision_published", next, { actor, revision });
    return next;
  });
}

export async function deployTest(projectPath, id) {
  const project = await loadProject(projectPath);
  if (project.config.testDeployment.kind === "unconfigured") throw new Error("尚未连接固定测试环境。可先由负责研发本地人工验证；配置发布环境后再执行发布。");
  return withLock(path.join(project.archive, "test-environment.lock"), () => withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    requireState(meta, "verified");
    const index = JSON.parse(await fs.readFile(path.join(project.archive, "index.json"), "utf8"));
    if (index.some(row => row.id !== id && ["test_deploy_submitting", "test_deploy_running", "test_deploy_outcome_unknown"].includes(row.state))) {
      throw new Error("共享测试环境已有部署正在运行或结果待核实，请稍后再发布。");
    }
    if (meta.planApprovedBy !== meta.assignments?.developer?.userId) {
      throw new Error("Test deployment requires prior human plan approval");
    }
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    await assertTaskStandards(project, meta, directory);
    const changes = events.findLast((event) => event.type === "implemented")?.detail.changes;
    await assertCheckEvidence(project, meta.checks, directory, meta.verificationAttempt === 1 ? "" : `verification-attempt-${meta.verificationAttempt}`,
      false, meta.developmentChecks);
    const approval = meta.changeApproval;
    if (!Array.isArray(changes) || !changes.length) throw new Error("Audited implementation changes are missing");
    if (approval && (approval.actor !== meta.assignments?.developer?.userId
        || meta.assignments.developer.status !== "accepted" || approval.contractHash !== meta.contractHash
        || approval.planHash !== meta.planHash || approval.baseHash !== meta.baseHash
        || approval.afterHash !== meta.afterHash || approval.standardsHash !== meta.standardsHash
        || approval.changesHash !== sha256(JSON.stringify(changes)))) {
      throw new Error("Change review no longer matches the verified changes");
    }
    const planApproval = events.findLast(event => event.type === "plan_approved");
    if (!approval && (planApproval?.detail.approvalKind !== "human"
        || planApproval.detail.actor !== meta.assignments?.developer?.userId
        || meta.assignments.developer.status !== "accepted")) {
      throw new Error("Automatic test deployment requires human plan confirmation");
    }
    if (!(await readPlanAnalysis(meta, directory)).admission.eligible) throw new Error("Requirement is outside the test deployment boundary");
    const report = JSON.parse(await fs.readFile(path.join(directory, "changes.json"), "utf8"));
    if (JSON.stringify(report.changes) !== JSON.stringify(changes) || report.violations.length) {
      throw new Error("Archived changes differ from the audited implementation");
    }
    for (const change of changes) {
      for (const [kind, entry] of [["baseline", change.before], ["after", change.after]]) {
        if (!entry) continue;
        const file = path.join(directory, kind, change.file);
        if (sha256(await fs.readFile(file)) !== entry.hash || ((await fs.stat(file)).mode & 0o777) !== entry.mode) {
          throw new Error(`Archived ${kind} snapshot changed: ${change.file}`);
        }
      }
    }
    if (deploymentRequiresPublishedRevision(project.config.testDeployment) && (!meta.publishedRevision
        || await publishedRevision(project, meta.workspace, meta.branch) !== meta.publishedRevision)) {
      throw new Error("Verified requirement branch must still match the published revision");
    }
    const current = manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
    if (current !== meta.afterHash) throw new Error("Workspace changed after verification");
    const candidate = meta.testCandidate;
    if (project.config.gitDelivery?.testMode === "merge" && !candidate) throw new Error("请先确认提交并验证测试合并版本。");
    if (candidate) {
      if (candidate.requestRevision !== meta.publishedRevision || candidate.branch !== project.config.gitDelivery?.testBranch
          || manifestHash(await manifest(candidate.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== candidate.sourceHash
          || await runGit(candidate.workspace, ["rev-parse", "HEAD"]) !== candidate.publishedRevision) throw new Error("测试合并版本已改变。");
      const commands = meta.developmentChecks;
      if (candidate.checks.length !== commands.length) throw new Error("缺少合并后测试证据。");
      for (const [i, check] of candidate.checks.entries()) {
        assertInside(directory, check.logFile);
        if (check.code !== 0 || check.signal !== null || JSON.stringify(check.command) !== JSON.stringify(commands[i])
            || sha256(await fs.readFile(check.logFile)) !== check.logHash) throw new Error("合并后测试记录已改变。");
      }
    }
    const deploymentMeta = candidate ? { ...meta, ...candidate, afterHash: candidate.sourceHash } : meta;
    const deploymentHash = candidate ? candidate.sourceHash : current;
    const logFile = path.join(directory, "test-deploy.log");
    const active = { ...meta, state: "test_deploy_submitting", updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "test_deploy_submitting", active, { logFile, sourceHash: deploymentHash,
      revision: deploymentMeta.publishedRevision, branch: deploymentMeta.branch });
    if (project.config.testDeployment.url !== undefined) await writeJson(path.join(project.archive, `test-environment-${sha256(project.config.testDeployment.url)}.json`), {
      taskId: id, url: project.config.testDeployment.url, revision: deploymentMeta.publishedRevision ?? deploymentHash, status: "submitting" });
    try {
      const deployment = await deployConfigured(project.config.testDeployment, deploymentMeta, logFile, {
        timeoutMs: project.config.testDeployment.kind === "local" ? project.config.executionTimeouts.deploymentMs : project.config.testDeployment.timeoutMs, maxBytes: project.config.maxAuditBytes ?? null,
        envNames: project.config.environment.localDeployment,
        environment: "test", sourceHash: deploymentHash, credentialArchive: project.archive,
      });
      if (deployment.url === undefined && project.config.testDeployment.url !== undefined) deployment.url = project.config.testDeployment.url;
      if (deployment.status === "succeeded") deployment.environment = await verifyTestEnvironment({ url: deployment.url }, logFile, project.config.executionTimeouts.startupMs);
      if (manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== current) {
        throw new Error("Test deployment modified verified workspace files");
      }
      if (candidate && manifestHash(await manifest(candidate.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== deploymentHash) throw new Error("Test deployment modified integrated workspace files");
      const state = { running: "test_deploy_running", succeeded: "test_deployed", failed: "test_deploy_failed" }[deployment.status];
      const next = { ...active, state, testDeployment: deployment, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, state, next, { deployment, logFile });
      if (deployment.url !== undefined) await writeJson(path.join(project.archive, `test-environment-${sha256(deployment.url)}.json`), {
        taskId: id, url: deployment.url, revision: deploymentMeta.publishedRevision ?? deploymentHash, status: deployment.status });
      return next;
    } catch (error) {
      const unknown = { ...active, state: "test_deploy_outcome_unknown", updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "test_deploy_outcome_unknown", unknown, { error: error.message, logFile });
      throw error;
    }
  }));
}

export async function pollTestDeployment(projectPath, id) {
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    requireState(meta, "test_deploy_running");
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    if (manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.afterHash) throw new Error("Workspace changed after verification");
    const logFile = path.join(directory, "test-deploy.log");
    let result;
    const candidate = meta.testCandidate;
    const deploymentMeta = candidate ? { ...meta, ...candidate, afterHash: candidate.sourceHash } : meta;
    const sourceHash = candidate ? candidate.sourceHash : meta.afterHash;
    try {
      if (candidate && manifestHash(await manifest(candidate.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== sourceHash) throw new Error("Integrated workspace changed after verification");
      result = await pollConfiguredDeployment(project.config.testDeployment, deploymentMeta, meta.testDeployment, logFile, {
        timeoutMs: project.config.testDeployment.timeoutMs, maxBytes: project.config.maxAuditBytes ?? null,
        environment: "test", sourceHash, credentialArchive: project.archive,
      });
      if (manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.afterHash) throw new Error("Deployment polling modified verified workspace files");
      if (candidate && manifestHash(await manifest(candidate.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== sourceHash) throw new Error("Deployment polling modified integrated workspace files");
      if (result.url === undefined && project.config.testDeployment.url !== undefined) result.url = project.config.testDeployment.url;
      if (result.status === "succeeded") result.environment = await verifyTestEnvironment({ url: result.url }, logFile, project.config.executionTimeouts.startupMs);
    } catch (error) {
      await appendEvent(project, id, "test_deploy_poll_failed", meta, { error: error.message, logFile,
        deployment: meta.testDeployment });
      throw error;
    }
    const state = result.status === "succeeded" ? "test_deployed" : "test_deploy_failed";
    const next = { ...meta, state, testDeployment: result, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, state, next, { deployment: result });
    if (result.url !== undefined) await writeJson(path.join(project.archive, `test-environment-${sha256(result.url)}.json`), {
      taskId: id, url: result.url, revision: deploymentMeta.publishedRevision ?? sourceHash, status: result.status });
    return next;
  });
}

export async function reconcileTestDeployment(projectPath, id, actor, outcome, observedRevision, evidence) {
  requireActor(actor);
  if (!["succeeded", "failed"].includes(outcome) || typeof evidence !== "string"
      || !evidence.trim() || evidence.length > 4000) {
    throw new Error("Reconciliation needs an explicit outcome and human evidence");
  }
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta } = await readTask(project, id);
    if (!["test_deploy_submitting", "test_deploy_outcome_unknown"].includes(meta.state)) {
      throw new Error(`Test deployment cannot be reconciled from ${meta.state}`);
    }
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    const expected = deploymentRequiresPublishedRevision(project.config.testDeployment)
      ? meta.testCandidate?.publishedRevision ?? meta.publishedRevision : meta.testCandidate?.sourceHash ?? meta.afterHash;
    if (outcome === "succeeded") {
      if (observedRevision !== expected) throw new Error("Observed test revision differs from verified revision");
      const current = manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
      if (current !== meta.afterHash) throw new Error("Verified workspace changed before reconciliation");
    }
    const state = outcome === "succeeded" ? "test_deployed" : "test_deploy_failed";
    const next = { ...meta, state, testDeployment: { kind: "manual-reconciled", outcome, observedRevision: observedRevision ?? null },
      updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "test_deployment_reconciled", next,
      { actor, outcome, expectedRevision: expected, observedRevision: observedRevision ?? null, evidence });
    return next;
  });
}

export async function acceptTest(projectPath, id, actor, evidence, acceptanceMode) {
  requireActor(actor);
  if (typeof evidence !== "string" || !evidence.trim()) throw new Error("Human acceptance evidence is required");
  if (!["manual", "local", "deployed"].includes(acceptanceMode)) throw new Error("Acceptance mode must be manual, local or deployed");
  const project = await loadProject(projectPath);
  return withLock(path.join(project.archive, "execution-config.lock"), () => withLock(path.join(project.archive, "test-environment.lock"), () => withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    const verified = acceptanceMode !== "deployed";
    if (verified) {
      requireState(meta, "verified");
      if (meta.changeApproval?.afterHash !== meta.afterHash || meta.changeApproval.actor !== meta.assignments?.developer?.userId)
        throw new Error("请先由负责研发确认当前代码和研发检查结果。");
      if (acceptanceMode === "local") {
        if (meta.localValidation?.afterHash !== meta.afterHash || !meta.localValidation.environment
            || !["running", "not_applicable", "stopped"].includes(meta.localValidation.status))
          throw new Error("请先完成当前代码的本地验证，再确认本地验证结果。");
        if (meta.localValidation.prerequisites?.revision !== (await readLocalEnvironment(project)).revision)
          throw new Error("本地环境配置已改变，请重新启动并验证当前配置后再验收。");
      }
      await assertTaskStandards(project, meta, directory);
      await assertCheckEvidence(project, meta.checks, directory,
        meta.verificationAttempt === 1 ? "" : `verification-attempt-${meta.verificationAttempt}`,
        false, meta.developmentChecks);
      if (manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.afterHash)
        throw new Error("本地代码已改变，请重新检查后再验收。");
    } else requireState(meta, "test_deployed");
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    const environment = verified || meta.testDeployment.url === undefined ? null : await fs.readFile(path.join(project.archive, `test-environment-${sha256(meta.testDeployment.url)}.json`), "utf8").then(JSON.parse,
      error => { if (error.code === "ENOENT") return null; throw error; });
    if (environment && environment.taskId !== id && environment.url === meta.testDeployment.url) throw new Error("共享测试环境已用于其他需求发布，请重新发布本需求后再验收。");
    await fs.writeFile(path.join(directory, "acceptance.md"), evidence, { flag: "wx", mode: 0o600 });
    const stopped = await stopLocalRuntime(directory);
    const next = { ...meta, state: "test_accepted", acceptanceMode,
      ...(meta.localValidation?.status === "running" ? { localValidation: { ...meta.localValidation, status: stopped.status } } : {}),
      acceptedBy: actor, acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "test_accepted", next, { actor, acceptanceMode, afterHash: meta.afterHash,
      verificationMode: meta.verificationMode, evidenceHash: sha256(evidence), localRuntime: stopped });
    return next;
  })));
}

export async function rollback(projectPath, id, actor) {
  requireActor(actor);
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta } = await readTask(project, id);
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    if (!["implementation_failed", "implementation_interrupted", "implemented", "verification_failed", "verified", "test_deployed", "test_accepted"].includes(meta.state)) {
      throw new Error(`Rollback is unavailable in state ${meta.state}`);
    }
    let files;
    try {
      await stopLocalRuntime(taskPath(project, id));
      files = await rollbackWorkspace(project, id, meta.workspace);
    } catch (error) {
      await appendEvent(project, id, "rollback_rejected", meta, { actor, error: error.message });
      throw error;
    }
    const next = { ...meta, state: "rolled_back", executionPause: null, rolledBackBy: actor, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "workspace_rolled_back", next, { actor, files });
    return next;
  });
}

export async function restartDevelopment(projectPath, id, actor, expectedAuditHead) {
  requireActor(actor);
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events, lastHash } = await readTask(project, id);
    requireState(meta, "rolled_back");
    if (expectedAuditHead !== lastHash) throw new Error("需求记录已改变，请刷新后重新开始。");
    const rolled = events.findLast(event => event.type === "workspace_rolled_back");
    if (!rolled || rolled.meta.baselineHash !== meta.baselineHash) throw new Error("Rollback audit record is missing or changed");
    if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted")
      throw new Error("Only the assigned developer can restart development");
    const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
    if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed before restart");
    if (manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.baselineHash)
      throw new Error("回退后的工作区存在新修改，请先核对，不能直接重新开始。");
    const report = JSON.parse(await fs.readFile(path.join(directory, "changes.json"), "utf8"));
    const implementation = events.findLast(event => ["implemented", "implementation_failed", "implementation_interrupted"].includes(event.type));
    if (!implementation || JSON.stringify(report.changes) !== JSON.stringify(implementation.detail.changes))
      throw new Error("Restart changes differ from the audited implementation");
    const baseline = await manifest(path.join(directory, "baseline"), project.config.excludedPaths, project.config.maxSnapshotBytes);
    const saved = await manifest(path.join(directory, "after"), project.config.excludedPaths, project.config.maxSnapshotBytes);
    if (manifestHash(baseline) !== meta.baselineHash
        || manifestHash(JSON.parse(await fs.readFile(path.join(directory, "baseline.json"), "utf8"))) !== meta.baselineHash
        || report.changes.some(change => change.after && JSON.stringify(saved[change.file]) !== JSON.stringify(change.after)))
      throw new Error("Implementation snapshots changed before restart");
    const retained = path.join(directory, `rollback-${rolled.hash}`);
    await fs.mkdir(retained, { mode: 0o700 });
    for (const name of ["baseline", "baseline.json", "after", "changes.json"])
      await fs.rename(path.join(directory, name), path.join(retained, name));
    const next = { ...meta, state: "contract_confirmed", restartCount: (meta.restartCount ?? 0) + 1,
      planHash: null, planAnalysisHash: null, planFeedbackVersion: null, planBlockers: [], planPartApprovals: {},
      executionPause: null, executionBoundary: null, updatedAt: new Date().toISOString() };
    for (const field of ["workspace", "branch", "branchStartRevision", "baselineHash", "afterHash", "baseHash", "baseRevision",
      "planApprovedBy", "planApprovedAt", "planScopeHash", "planResolutionHash", "developmentBranch", "developmentFiles",
      "developmentChecks", "configHash", "configBindingVersion", "standardsHash", "projectBaselineHash", "admission", "admissionPolicyHash",
      "resumeImplementationFiles", "resumeImplementationModel", "resumeContinuation", "resumeSessionCheckpoint", "developmentFailure",
      "fastPathEligibility", "fastPathAuthorization", "changeApproval", "changeCount", "checks", "verificationMode", "verificationFailure",
      "localValidation", "publishedRevision", "publishedBy", "gitDeliveryError", "gitCandidate", "gitCommit", "testCandidate", "testDeployment",
      "acceptedBy", "acceptedAt", "acceptanceMode", "rolledBackBy", "candidateWorkspace", "candidateHash", "mergedRevision", "mergeChecks"])
      delete next[field];
    await appendEvent(project, id, "development_restarted", next, { actor, retained, priorRollbackHash: rolled.hash, priorAuditHead: lastHash,
      priorImplementationHash: implementation.hash, priorPlanHash: meta.planHash, baselineHash: meta.baselineHash,
      reportHash: sha256(JSON.stringify(report)), contractHash: meta.contractHash, modelRun: false });
    return next;
  });
}

export async function inspectInterrupted(projectPath, id) {
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta } = await readTask(project, id);
    if (!["implementing", "implementation_inspection_failed"].includes(meta.state)) {
      throw new Error(`Task ${meta.id} is ${meta.state}; expected an interrupted implementation`);
    }
    const inspected = await inspectChanges(project, id, meta.workspace);
    const next = { ...meta, state: "implementation_interrupted", changeCount: inspected.changes.length, afterHash: inspected.afterHash, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "implementation_interrupted", next, { changes: inspected.changes, violations: inspected.violations });
    return next;
  });
}

export async function verifyCandidate(projectPath, id) {
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    requireState(meta, "test_accepted");
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    await assertTaskStandards(project, meta, directory);
    await assertCheckEvidence(project, meta.checks, directory, meta.verificationAttempt === 1 ? "" : `verification-attempt-${meta.verificationAttempt}`,
      false, meta.developmentChecks);
    const candidate = await prepareReleaseCandidate(project, id, meta);
    const active = { ...meta, ...candidate, state: "merge_verifying", updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "merge_candidate_prepared", active, candidate);
    const before = manifestHash(await manifest(candidate.candidateWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
    const results = [];
    try {
      for (const [index, command] of (meta.developmentChecks).entries()) {
        const logFile = path.join(directory, `merge-check-${index + 1}.log`);
        const result = await runCommand(command, candidate.candidateWorkspace, project.config.executionTimeouts.checksMs, logFile,
          project.config.maxAuditBytes ?? null, project.config.environment.checks, project.config.checkSandbox);
        results.push({ command, logFile, ...result });
        if (result.code !== 0) throw new Error(`Merged result failed check: ${command.join(" ")}; ${result.tail}`);
      }
      const after = manifestHash(await manifest(candidate.candidateWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
      if (after !== before) throw new Error("Merge checks modified project files");
      const next = { ...active, state: "merge_verified", candidateHash: after, mergeChecks: results, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "merge_verified", next, { checks: results, revision: candidate.mergedRevision });
      return next;
    } catch (error) {
      const failed = { ...active, state: "merge_verification_failed", mergeChecks: results, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "merge_verification_failed", failed, { error: error.message, checks: results });
      throw error;
    }
  });
}

export async function approveRelease(projectPath, id, actor) {
  requireActor(actor);
  const project = await loadProject(projectPath);
  if (project.config.productionDeployment.kind === "none") throw new Error("Production deployment is disabled by project policy");
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    requireState(meta, "merge_verified");
    await assertTaskStandards(project, meta, directory);
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    await assertCheckEvidence(project, meta.mergeChecks, directory, "merge", false, meta.developmentChecks);
    if (manifestHash(await manifest(meta.candidateWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.candidateHash) {
      throw new Error("Release candidate changed after verification");
    }
    await assertReleaseRevision(project, meta.mergedRevision);
    const next = { ...meta, state: "release_approved", releaseApprovedBy: actor, releaseApprovedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "release_approved", next, { actor, revision: meta.mergedRevision });
    return next;
  });
}

export async function release(projectPath, id) {
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    requireState(meta, "release_approved");
    await assertTaskStandards(project, meta, directory);
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after release approval");
    await assertCheckEvidence(project, meta.mergeChecks, directory, "merge", false, meta.developmentChecks);
    await assertReleaseRevision(project, meta.mergedRevision);
    const target = {
      ...meta, workspace: meta.candidateWorkspace,
      branch: project.config.mode === "git" ? project.config.releaseBranch : null,
      publishedRevision: meta.mergedRevision,
    };
    const before = manifestHash(await manifest(meta.candidateWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
    if (before !== meta.candidateHash) throw new Error("Release candidate changed after verification");
    const logFile = path.join(directory, "production-deploy.log");
    const active = { ...meta, state: "release_submitting", updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "release_submitting", active, { logFile, candidateHash: before });
    try {
      const deployment = await deployConfigured(project.config.productionDeployment, target, logFile, {
        timeoutMs: project.config.productionDeployment.kind === "local" ? project.config.executionTimeouts.deploymentMs : project.config.productionDeployment.timeoutMs, maxBytes: project.config.maxAuditBytes ?? null,
        envNames: project.config.environment.localDeployment,
        environment: "production", sourceHash: before, credentialArchive: project.archive,
      });
      const after = manifestHash(await manifest(meta.candidateWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
      if (before !== after) throw new Error("Production deployment command modified candidate files");
      const state = { running: "release_running", succeeded: "released", failed: "release_failed" }[deployment.status];
      const next = { ...active, state, productionDeployment: deployment, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, state, next, { deployment, logFile });
      return next;
    } catch (error) {
      const unknown = { ...active, state: "release_outcome_unknown", updatedAt: new Date().toISOString() };
      await appendEvent(project, id, "release_outcome_unknown", unknown, { error: error.message, logFile });
      throw error;
    }
  });
}

export async function pollRelease(projectPath, id) {
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    requireState(meta, "release_running");
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after release approval");
    if (manifestHash(await manifest(meta.candidateWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.candidateHash) throw new Error("Release candidate changed after verification");
    const logFile = path.join(directory, "production-deploy.log");
    let result;
    try {
      const target = { ...meta, workspace: meta.candidateWorkspace,
        branch: project.config.mode === "git" ? project.config.releaseBranch : null, publishedRevision: meta.mergedRevision };
      result = await pollConfiguredDeployment(project.config.productionDeployment, target, meta.productionDeployment, logFile, {
        timeoutMs: project.config.productionDeployment.timeoutMs, maxBytes: project.config.maxAuditBytes ?? null,
        environment: "production", sourceHash: meta.candidateHash, credentialArchive: project.archive,
      });
      if (manifestHash(await manifest(meta.candidateWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.candidateHash) throw new Error("Deployment polling modified candidate files");
    } catch (error) {
      await appendEvent(project, id, "release_poll_failed", meta, { error: error.message, logFile,
        deployment: meta.productionDeployment });
      throw error;
    }
    const state = result.status === "succeeded" ? "released" : "release_failed";
    const next = { ...meta, state, productionDeployment: result, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, state, next, { deployment: result });
    return next;
  });
}

export async function reconcileRelease(projectPath, id, actor, outcome, observedRevision, evidence) {
  requireActor(actor);
  if (!["succeeded", "failed"].includes(outcome) || typeof evidence !== "string"
      || !evidence.trim() || evidence.length > 4000) {
    throw new Error("Reconciliation needs an explicit outcome and human evidence");
  }
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta } = await readTask(project, id);
    if (!["release_submitting", "release_outcome_unknown"].includes(meta.state)) {
      throw new Error(`Release cannot be reconciled from ${meta.state}`);
    }
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after release approval");
    const expected = deploymentRequiresPublishedRevision(project.config.productionDeployment) ? meta.mergedRevision : meta.candidateHash;
    if (outcome === "succeeded") {
      if (observedRevision !== expected) throw new Error("Observed production revision differs from approved candidate");
      const current = manifestHash(await manifest(meta.candidateWorkspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
      if (current !== meta.candidateHash) throw new Error("Approved candidate changed before reconciliation");
      await assertReleaseRevision(project, meta.mergedRevision);
    }
    const state = outcome === "succeeded" ? "released" : "release_failed";
    const next = { ...meta, state, productionDeployment: { kind: "manual-reconciled", outcome,
      observedRevision: observedRevision ?? null }, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "release_reconciled", next, { actor, outcome,
      expectedRevision: expected, observedRevision: observedRevision ?? null, evidence });
    return next;
  });
}

export async function observeRelease(projectPath, id, actor, evidence) {
  requireActor(actor);
  if (typeof evidence !== "string" || !evidence.trim()) throw new Error("Release observation evidence is required");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    requireState(meta, "released");
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after release approval");
    await fs.writeFile(path.join(directory, "release-observation.md"), evidence, { flag: "wx", mode: 0o600 });
    const next = { ...meta, state: "archived", observedBy: actor, observedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await fs.writeFile(path.join(directory, "result.md"), resultReport(next, events), { flag: "wx", mode: 0o600 });
    await appendEvent(project, id, "archived", next, { actor, evidenceHash: sha256(evidence) });
    return next;
  });
}

export async function archiveTestOnly(projectPath, id, actor) {
  requireActor(actor);
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    const acceptedLocal = meta.state === "test_accepted";
    if (!acceptedLocal) requireState(meta, "merge_verified");
    await assertTaskStandards(project, meta, directory);
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("Project policy changed after plan approval");
    await assertCheckEvidence(project, acceptedLocal ? meta.checks : meta.mergeChecks, directory,
      acceptedLocal ? (meta.verificationAttempt === 1 ? "" : `verification-attempt-${meta.verificationAttempt}`) : "merge",
      false, meta.developmentChecks);
    if (manifestHash(await manifest(acceptedLocal ? meta.workspace : meta.candidateWorkspace,
      project.config.excludedPaths, project.config.maxSnapshotBytes)) !== (acceptedLocal ? meta.afterHash : meta.candidateHash)) {
      throw new Error("Archive candidate changed after verification");
    }
    if (!acceptedLocal) await assertReleaseRevision(project, meta.mergedRevision);
    if (acceptedLocal && meta.testCandidate && manifestHash(await manifest(meta.testCandidate.workspace,
      project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.testCandidate.sourceHash) throw new Error("测试环境对应的合并版本已改变，无法归档。");
    const next = { ...meta, state: "archived_test_only", archivedBy: actor, updatedAt: new Date().toISOString() };
    await fs.writeFile(path.join(directory, "result.md"), resultReport(next, events), { flag: "wx", mode: 0o600 });
    await appendEvent(project, id, "archived_test_only", next, { actor });
    return next;
  });
}

import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createAgentSession, ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Settings, Role, Usage } from "./types.js";
import { CLARIFICATION_ROUND_LIMIT, CODE_REVIEW_CHECKS, CODE_REVIEW_CHECKING_LIMIT } from "./types.js";
import { catalogSchema, moduleSubmissionSchema, knowledgeReviewSchema, projectFactCompletionSchema, projectFactReviewSchema } from './knowledge-schema.js';
import { checkedCatalog, checkedModule, checkedReview } from './project-knowledge.js';
import { checkedFactProposal, checkedFactReview } from './knowledge-feedback.js';
import type { FactProposal } from './knowledge-feedback.js';
import type { PiMode } from './pi.js';

type Job = { id: string; role: Role; prompt: string; usage: Usage; files: string[]; mode: PiMode; knowledge: any;
  images?: Array<{ type: "image"; data: string; mimeType: string }> };
type Init = { workspace: string; home: string; session: string | null; settings: Settings; keys: Record<string, string>; sourcePrefixes: string[];
  readonlyDependencies: Array<{ path: string; target: string; linked: boolean }> };
const send = (data: unknown) => { if (!process.send) throw new Error("Worker requires IPC"); process.send(data); };
let session: AgentSession; let runtime: ModelRuntime; let init: Init; let active: Job | null = null;
let reported: { kind: 'card' | 'review' | 'catalog' | 'module' | 'knowledge-review' | 'facts' | 'clarification' | 'confirmations'; value: unknown } | null = null;
let usage: Usage; const metering = new Set<Promise<void>>();
const reservations = new Map<string, () => void>();
let publishedSession: string | null = null;
let invalidReports = 0, phaseFailure: string | null = null;
let explorationTurns = 0, invalidTools = 0;
let budgetBlocked = false;
let codeReview: { id: string; requests: number; submissionUsed: boolean; submitOnly: boolean; compacting: boolean; lastInvalidReport: unknown } | null = null;
const readonly = ["read", "grep", "find", "ls"];
const coding = [...readonly, "edit", "write", "bash"];
const decisionsTakenSchema = { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false,
  required: ["area", "decision", "basis"], properties: { area: { type: "string", minLength: 1, maxLength: 120 },
    decision: { type: "string", minLength: 1, maxLength: 600 }, basis: { type: "string", minLength: 1, maxLength: 400 } } } };
const clarificationSchema = { type: "object", additionalProperties: false, required: ["questions"], properties: {
  questions: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", additionalProperties: false,
    required: ["id", "title", "body", "kind", "options", "allowOther"], properties: {
      id: { type: "string", minLength: 1, maxLength: 40 }, title: { type: "string", minLength: 1, maxLength: 120 },
      body: { type: "string", minLength: 1, maxLength: 1200 },
      kind: { enum: ["confirm", "supplement"] },
      options: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", additionalProperties: false,
        required: ["label", "value", "recommended"], properties: { label: { type: "string", minLength: 1, maxLength: 200 },
          value: { type: "string", minLength: 1, maxLength: 400 }, recommended: { type: "boolean" } } } },
      allowOther: { type: "boolean" } } } },
  decisionsTaken: decisionsTakenSchema } };
const confirmationsSchema = { type: "object", additionalProperties: false, required: ["decisions"], properties: {
  decisions: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false,
    required: ["id", "question", "suggestion", "impact", "basis"], properties: {
      id: { type: "string", minLength: 1, maxLength: 40 }, question: { type: "string", minLength: 1, maxLength: 600 },
      suggestion: { type: "string", minLength: 1, maxLength: 600 }, impact: { type: "string", minLength: 1, maxLength: 400 },
      basis: { type: "string", minLength: 1, maxLength: 400 } } } },
  decisionsTaken: decisionsTakenSchema } };
async function assertToolPath(input: string, dependencyRead: boolean) {
  const target = path.resolve(init.workspace, input); let parent = target;
  while (true) { try { await fs.lstat(parent); break; } catch (e: any) { if (e.code !== "ENOENT") throw e; parent = path.dirname(parent); } }
  const resolved = path.join(await fs.realpath(parent), path.relative(parent, target));
  const dependency = init.readonlyDependencies.find(entry =>
    [target, resolved].some(candidate => candidate === entry.path || candidate.startsWith(entry.path + path.sep)));
  if (dependency && !dependencyRead) throw new Error('运行依赖为只读，不能通过工具修改');
  for (const entry of init.readonlyDependencies) if (entry.linked || entry === dependency) {
    if (!(await fs.lstat(entry.path)).isSymbolicLink() || await fs.realpath(entry.path) !== entry.target)
      throw new Error('运行依赖必须保持原始只读链接');
  }
  const roots = dependencyRead ? [init.workspace, ...init.readonlyDependencies.map(entry => entry.target)] : [init.workspace];
  if (!roots.some(root => resolved === root || resolved.startsWith(root + path.sep))) throw new Error("工具路径越出当前工作区");
}
function extension(pi: ExtensionAPI) {
  const requireReviewSubmission = () => {
    if (!codeReview || codeReview.submitOnly) return;
    codeReview.submitOnly = true;
    session.setActiveToolsByName(['report_review']);
    send({ type: 'review_runtime', reviewId: codeReview.id, event: 'submit_only' });
  };
  for (const [name, mode, schema] of [
    ['report_project_catalog', 'catalog', catalogSchema], ['report_project_module', 'module', moduleSubmissionSchema],
    ['report_project_knowledge_review', 'knowledge-review', knowledgeReviewSchema]
  ] as const) pi.registerTool({ name, label: '提交项目理解', description: '提交本阶段项目理解；证据只填file/start/end，程序绑定真实原文和哈希，不提交quote/content。不杜撰测试成功。',
    parameters: schema as any, execute: async (_id, input: any) => {
      if (active?.mode !== mode) throw new Error('当前阶段不能提交此类项目理解');
      const value = mode === 'catalog' ? await checkedCatalog(input, init.workspace, active.knowledge.files)
        : mode === 'module' ? await checkedModule({ ...input, id: active.knowledge.expectedModuleId }, active.knowledge.catalog, init.workspace, active.knowledge.files)
        : checkedReview(input, active.knowledge.module);
      if (mode === 'catalog' && active.knowledge.existingCatalog !== null) for (const prior of active.knowledge.existingCatalog.modules) {
        const entry = input.modules.find((item: any) => item.id === prior.id);
        if (!entry || (entry.name !== prior.name || entry.purpose !== prior.purpose) && !input.targets.includes(prior.id))
          throw new Error('已有模块必须保留；修改职责后须列入本次targets重新梳理');
      }
      reported = { kind: mode, value }; return { content: [{ type: 'text', text: '项目理解材料已提交。' }], details: {} };
    } });
  pi.registerTool({ name: 'read_project_knowledge', label: '读取项目知识', description: '按业务模块读取职责、状态、行为链路、必保规则与验证方法；过期内容必须重新核对。',
    parameters: { type: 'object', additionalProperties: false, required: ['moduleId', 'section', 'offset'], properties: { moduleId: { type: 'string', minLength: 1 },
      section: { enum: ['overview', 'facts', 'flows', 'validation'] }, offset: { type: 'integer', minimum: 0 } } } as any,
    execute: async (_id, input: any) => {
      if (active?.mode !== 'task' || active.knowledge === null) throw new Error('当前执行没有项目知识材料');
      const module = active.knowledge.modules.find((item: any) => item.id === input.moduleId);
      if (!module) throw new Error('没有该业务模块，请使用当前目录中的编号');
      if (input.section === 'overview') {
        if (input.offset !== 0) throw new Error('overview章节只接受offset=0');
        return { content: [{ type: 'text', text: JSON.stringify({ id: module.id, name: module.name, purpose: module.purpose,
          state: module.state, invalidatedBy: module.invalidatedBy, unknowns: module.unknowns }) }], details: {} };
      }
      const items = module[input.section];
      if (!Array.isArray(items)) throw new Error('当前产品材料不包含该研发章节');
      if (input.offset >= items.length && input.offset !== 0) throw new Error('章节读取offset越界');
      const page = items.slice(input.offset, input.offset + 2);
      return { content: [{ type: 'text', text: JSON.stringify({ moduleId: module.id, section: input.section, state: module.state,
        invalidatedBy: module.invalidatedBy, offset: input.offset, total: items.length, nextOffset: input.offset + page.length < items.length ? input.offset + page.length : null, items: page }) }], details: {} };
    } });
  const recordDecisions = (input: any) => {
    if (Array.isArray(input.decisionsTaken) && input.decisionsTaken.length)
      send({ type: "model_decisions", decisions: input.decisionsTaken, role: active!.role });
  };
  pi.registerTool({ name: "present_requirement", label: "提交产品需求", description: "用产品能理解的语言提交用户场景、目标、业务范围和可观察的验收。不要写代码文件、函数、算法或测试命令；提交后等待产品确认，不代表批准实施。反问轮次用尽时，把仍未确定的事项通过pendingDecisions一并提交。",
    parameters: { type: "object", additionalProperties: false, required: ["card"], properties: { card: { type: "string", minLength: 10, maxLength: 12000 },
      decisionsTaken: decisionsTakenSchema,
      pendingDecisions: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false,
        required: ["id", "question", "suggestion", "impact", "basis"], properties: {
          id: { type: "string", minLength: 1, maxLength: 40 }, question: { type: "string", minLength: 1, maxLength: 600 },
          suggestion: { type: "string", minLength: 1, maxLength: 600 }, impact: { type: "string", minLength: 1, maxLength: 400 },
          basis: { type: "string", minLength: 1, maxLength: 400 } } } } } } as any,
    execute: async (_id, input: any) => { recordDecisions(input); reported = { kind: "card", value: { card: input.card, pendingDecisions: input.pendingDecisions ?? [] } }; return { content: [{ type: "text", text: "需求卡已保存，等待具名开工授权。" }], details: {} }; } });
  pi.registerTool({ name: "ask_clarification", label: "提出需求反问", description: "信息不足时才调用：提交最多5个会改变业务结果的问题，按影响排序。每题2至4个选项、标出推荐答案，并允许产品填写其他答案。kind=confirm 表示必须由产品确认、未答会转为未决项；kind=supplement 表示补充信息、未答按推荐答案作为模型默认并留痕。只在当前信息不足以形成明确范围或可观察验收时使用；信息已足够应直接present_requirement。",
    parameters: clarificationSchema as any,
    execute: async (_id, input: any) => {
      if (active?.mode !== "task" || active.role !== "requirement") throw new Error("仅需求补齐阶段可提出反问");
      if ((active.knowledge?.clarificationRounds ?? 0) >= CLARIFICATION_ROUND_LIMIT) throw new Error("反问轮次已用完，请直接提交需求卡，仍无法确定的用propose_confirmations提交");
      const ids = input.questions.map((question: any) => question.id);
      if (new Set(ids).size !== ids.length) throw new Error("问题编号不能重复");
      for (const question of input.questions) if (!question.options.some((option: any) => option.recommended))
        throw new Error(`问题「${question.title}」必须标出一个推荐答案`);
      recordDecisions(input);
      reported = { kind: "clarification", value: { questions: input.questions } };
      return { content: [{ type: "text", text: "问题已提交，等待产品回答。" }], details: {} };
    } });
  pi.registerTool({ name: "propose_confirmations", label: "提交必须人工确认项", description: "提交会改变用户可观察业务行为或验收标准的决策，每项给出模型建议答案、一句影响说明和分界依据。措辞、排版、字段顺序、技术实现和非功能默认值不要提交，直接记入decisionsTaken。",
    parameters: confirmationsSchema as any,
    execute: async (_id, input: any) => {
      if (active?.mode !== "task" || active.role !== "requirement") throw new Error("仅需求补齐阶段可提交确认项");
      const ids = input.decisions.map((decision: any) => decision.id);
      if (new Set(ids).size !== ids.length) throw new Error("确认项编号不能重复");
      recordDecisions(input);
      reported = { kind: "confirmations", value: { decisions: input.decisions } };
      return { content: [{ type: "text", text: "确认项已提交，等待产品逐项处理。" }], details: {} };
    } });
  pi.registerTool({ name: 'record_implementation', label: '记录研发实现说明', description: '记录实现要点、影响位置和验证安排。与实际实现工具在同一轮调用，不另建方案审批；不得改写产品需求或增加业务范围。',
    parameters: { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string', minLength: 10, maxLength: 6000 } } } as any,
    execute: async (_id, input: any) => {
      if (active?.role !== 'development' || active.mode !== 'task') throw new Error('研发说明只能在研发阶段记录');
      send({ type: 'implementation', content: input.content, role: active.role });
      return { content: [{ type: 'text', text: '研发说明已记录，请继续完成当前实现。' }], details: {} };
    } });
  pi.registerTool({ name: 'propose_project_facts', label: '完成实现并建议更新项目事实', description: '收到全部修改成功结果后，在实现收尾轮提交少量可复用事实或有理由的撤回，随后进入测试审核。不与edit/write/bash同轮调用，不增加业务范围；同模块再次提交替换本轮建议。未审核及验收应用前不会发布。',
    parameters: projectFactCompletionSchema as any, execute: async (_id, input: any) => {
      if (active?.mode !== 'task' || active.role !== 'development' || active.knowledge === null) throw new Error('仅研发实现阶段可提出项目事实');
      const last = session.messages.findLast((message: any) => message.role === 'assistant') as any;
      if (last?.content.some((part: any) => part.type === 'toolCall' && ['edit', 'write', 'bash'].includes(part.name))) throw new Error('项目事实须在收到修改成功结果后单独收尾，不能与修改工具并行');
      const ids = [...input.proposals.map((proposal: any) => proposal.moduleId), ...input.withdrawals.map((item: any) => item.moduleId)];
      if (!ids.length || new Set(ids).size !== ids.length) throw new Error('事实收尾必须包含建议或撤回，模块编号不能重复');
      const proposals: FactProposal[] = [];
      for (const proposal of input.proposals) {
        if (!active.knowledge.modules.some((module: any) => module.id === proposal.moduleId)) throw new Error('未梳理模块不能用事实建议替代初始化');
        proposals.push(await checkedFactProposal(proposal, init.workspace, init.settings, active.knowledge.catalog));
      }
      for (const withdrawal of input.withdrawals) {
        if (!active.knowledge.pendingProposals?.some((proposal: any) => proposal.moduleId === withdrawal.moduleId)) throw new Error('撤回的模块没有已有建议');
      }
      for (const proposal of proposals) send({ type: 'knowledge_proposal', proposal, role: active.role });
      for (const withdrawal of input.withdrawals) send({ type: 'knowledge_withdrawal', withdrawal, role: active.role });
      reported = { kind: 'facts', value: ids };
      return { content: [{ type: 'text', text: '建议已保存，等待独立核对；通过验收并应用后才会更新项目知识。' }], details: {} };
    } });
  pi.registerTool({ name: "report_review", label: "提交代码审核", description: "提交固定三项检查及简短依据。确定问题写issues，缺必要材料写missingEvidence，未检查明确pending；不能用空问题列表掩盖未完成。只核对本次需求、直接相关原行为和关键测试，不报告风格、不代替业务验收。",
    parameters: { type: "object", additionalProperties: false, required: ['checks', 'issues', 'missingEvidence', 'projectFacts'], properties: {
      checks: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['id', 'status', 'basis'], properties: {
        id: { enum: CODE_REVIEW_CHECKS.map(item => item.id) }, status: { enum: ['passed', 'blocked', 'missing', 'pending'] }, basis: { type: 'string', minLength: 1, maxLength: 600 } } } },
      missingEvidence: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['check', 'missing', 'reason'], properties: {
        check: { enum: CODE_REVIEW_CHECKS.map(item => item.id) }, missing: { type: 'string', minLength: 1, maxLength: 600 }, reason: { type: 'string', minLength: 1, maxLength: 600 } } } },
      projectFacts: projectFactReviewSchema, issues: { type: "array", maxItems: 6,
      items: { type: "object", additionalProperties: false, required: ["check", "file", "line", "trigger", "impact", "problem", "requiredChange"], properties: {
        check: { enum: CODE_REVIEW_CHECKS.map(item => item.id) }, trigger: { type: 'string', minLength: 1, maxLength: 600 }, impact: { type: 'string', minLength: 1, maxLength: 600 },
        file: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 1 },
        problem: { type: "string", minLength: 1, maxLength: 2000 }, requiredChange: { type: "string", minLength: 1, maxLength: 2000 } } } } } } as any,
    execute: async (_id, input: any) => {
      if (active?.mode !== 'task' || active.role !== 'review' || active.knowledge === null) throw new Error('审核没有对应的代码审核任务');
      if (new Set(input.checks.map((item: any) => item.id)).size !== CODE_REVIEW_CHECKS.length) throw new Error('审核必须逐项返回固定三项清单，不能重复或遗漏');
      if (input.checks.some((item: any) => !item.basis.trim())
        || input.issues.some((item: any) => ['trigger', 'impact', 'problem', 'requiredChange'].some(key => !item[key].trim()))
        || input.missingEvidence.some((item: any) => !item.missing.trim() || !item.reason.trim())) throw new Error('审核依据、触发条件、影响及缺材料说明不能为空白');
      for (const item of input.checks) {
        const issues = input.issues.filter((issue: any) => issue.check === item.id), missing = input.missingEvidence.filter((gap: any) => gap.check === item.id);
        if (item.status === 'blocked' && !issues.length || item.status === 'missing' && !missing.length
          || ['passed', 'pending'].includes(item.status) && (issues.length || missing.length)
          || issues.length && item.status !== 'blocked') throw new Error('审核清单状态必须与确定问题及证据缺口一致');
      }
      if (!input.issues.length && !input.missingEvidence.length && input.checks.some((item: any) => item.status !== 'passed'))
        throw new Error('没有问题或证据缺口时必须完成全部检查，未检查不能算通过');
      for (const issue of input.issues) await assertToolPath(issue.file, false);
      if (input.issues.length || input.missingEvidence.length) {
        const keys = active.knowledge.proposedFactKeys;
        if (new Set(input.projectFacts.checked).size !== input.projectFacts.checked.length
          || input.projectFacts.checked.some((id: string) => !keys.includes(id))
          || input.projectFacts.rejected.some((item: any) => !input.projectFacts.checked.includes(item.id))) throw new Error('项目事实审核包含无效或未核对编号');
      } else checkedFactReview(input.projectFacts, active.knowledge.proposedFactKeys);
      reported = { kind: 'review', value: input }; return { content: [{ type: 'text', text: '代码与项目事实审核已记录。' }], details: {} };
    } });
  pi.on("tool_result", (event, ctx) => {
    if (reported && ['present_requirement', 'ask_clarification', 'propose_confirmations', 'report_review', 'report_project_catalog', 'report_project_module', 'report_project_knowledge_review', 'propose_project_facts'].includes(event.toolName)) ctx.abort();
  });
  pi.on("tool_call", async event => {
    if (["read", "grep", "find", "ls", "edit", "write"].includes(event.toolName))
      await assertToolPath(String((event.input as any).path ?? "."), readonly.includes(event.toolName));
  });
  pi.on('context', event => {
    if (codeReview) {
      const tools = session.getActiveToolNames();
      return { messages: [...event.messages, { role: 'user' as const, timestamp: Date.now(), content: [{ type: 'text' as const,
        text: `固定审核清单：${JSON.stringify(CODE_REVIEW_CHECKS)}。只查当前修改所需证据，不扩展范围。${codeReview.submitOnly ? '核对已结束，本次仅可 report_review，提交确定问题、必要证据缺口或全部核对结果；不能继续调查。' : `核对请求已用 ${codeReview.requests}/${CODE_REVIEW_CHECKING_LIMIT}，最多再保留一次只提交结论的请求；证据足够立即提交。`}可用工具：${tools.join('、')}。只交简短结论和依据，不输出长篇思考；未检查用 pending，缺材料用 missingEvidence，不能猜测通过。` }] }] };
    }
    if (!active || active.mode === 'task') return;
    const tools = session.getActiveToolNames();
    const remaining = active.mode === 'module' ? `本模块源码读取轮次剩余 ${Math.max(0, 2 - explorationTurns)}/2。` : '';
    const report = active.mode === 'module' ? 'report_project_module' : active.mode === 'catalog' ? 'report_project_catalog' : 'report_project_knowledge_review';
    return { messages: [...event.messages, { role: 'user' as const, timestamp: Date.now(), content: [{ type: 'text' as const,
      text: `${remaining}当前仅可调用：${tools.join('、')}。无效工具调用已用 ${invalidTools}/${init.settings.budget.repairCycles} 次纠正额度。${tools.length === 1 ? '调查阶段已结束，不再调用 read/grep/find/ls/bash；' : ''}请根据已有证据调用 ${report} 提交；未核实内容${active.mode === 'module' ? '写入 unknowns' : active.mode === 'catalog' ? '写入 outsideScope' : '按审核契约报告明确缺口'}，不虚构成功。每段证据为 file/start/end，最多 81 行。` }] }] };
  });
  pi.on('turn_end', (event, ctx) => {
    if (!codeReview || event.message.role !== 'assistant') return;
    for (const result of event.toolResults) {
      if (result.toolName !== 'report_review' || !result.isError) continue;
      const call = event.message.content.find(part => part.type === 'toolCall' && part.id === result.toolCallId);
      if (call?.type !== 'toolCall') continue;
      if (isDeepStrictEqual(call.arguments, codeReview.lastInvalidReport)) {
        const reason = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        phaseFailure = '审核未完成：重复提交相同的无效审核报告，已停止。' + reason.slice(0, 600);
        ctx.abort();
      }
      codeReview.lastInvalidReport = call.arguments;
    }
    if (event.message.stopReason === 'length') {
      phaseFailure = '审核未完成：本次回复过长被截断，没有取得有效审核报告；已停止，不自动续跑。';
      ctx.abort();
    }
    if (codeReview.requests >= CODE_REVIEW_CHECKING_LIMIT) requireReviewSubmission();
  });
  pi.on('agent_before_settle', event => {
    if (!codeReview || reported || phaseFailure || event.outcome !== 'completed') return;
    if (codeReview.submissionUsed) { phaseFailure = '审核未完成：最后一次提交没有有效报告，已停止。'; return; }
    requireReviewSubmission();
    return { entries: [{ type: 'custom_message' as const, customType: 'code-review-submit', display: false,
      content: '核对结束，只调用 report_review 提交清单、确定问题及必要证据缺口；未检查明确标记，不继续调查，不用文字代替报告。' }], continue: true };
  });
  pi.on('session_before_compact', event => {
    if (!codeReview) return;
    if (phaseFailure || codeReview.submitOnly || codeReview.requests >= CODE_REVIEW_CHECKING_LIMIT) {
      send({ type: 'review_runtime', reviewId: codeReview.id, event: 'compaction_deferred', reason: '为最终提交保留名额' });
      return { cancel: true };
    }
    codeReview.compacting = true;
    send({ type: 'review_runtime', reviewId: codeReview.id, event: 'compaction_started', reason: event.reason });
  });
  pi.on('session_compact', event => {
    if (!codeReview) return;
    codeReview.compacting = false;
    send({ type: 'review_runtime', reviewId: codeReview.id, event: 'compaction_completed', reason: event.reason });
    if (codeReview.requests >= CODE_REVIEW_CHECKING_LIMIT) requireReviewSubmission();
  });
  pi.on('session_compact_failed', (event, ctx) => {
    if (!codeReview) return;
    codeReview.compacting = false;
    send({ type: 'review_runtime', reviewId: codeReview.id, event: 'compaction_failed', reason: event.reason, aborted: event.aborted, error: event.errorMessage });
    if (!event.aborted) {
      phaseFailure = `审核未完成：上下文整理失败：${event.errorMessage}；已停止，不自动续跑。`;
      ctx.abort();
    }
  });
  pi.on("before_provider_request", event => {
    const provider = init.settings.providers.find(p => p.id === init.settings.models[active!.role].provider)!;
    if (provider.thinkingToggle) (event.payload as any).enable_thinking = false;
  });
}
async function initialize(value: Init) {
  init = value; publishedSession = init.session; await fs.mkdir(init.home, { recursive: true, mode: 0o700 });
  runtime = await ModelRuntime.create({ authPath: path.join(init.home, "auth.json"), modelsPath: null, refreshOnCreate: false });
  for (const provider of init.settings.providers) {
    runtime.registerProvider(provider.id, { api: "openai-completions", baseUrl: provider.baseUrl,
      models: provider.models.map(m => ({ ...m, name: m.id, api: "openai-completions",
        compat: { supportsDeveloperRole: provider.systemRole === "developer", maxTokensField: provider.outputLimitField, supportsStrictMode: false },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
    await runtime.setRuntimeApiKey(provider.id, init.keys[provider.id]);
  }
  // Observe the public model interface; keep Pi's context, tools and native stream untouched.
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = ((model: any, context: any, options: any = {}) => {
    let request: string | null = null; let reservation = 0, hasMeasuredUsage = false;
    const result = stream(model, context, { ...options, maxRetries: 0, onPayload: async (payload: any) => {
      const replacement = await options.onPayload?.(payload, model);
      const inputReserve = Math.ceil(Buffer.byteLength(JSON.stringify(replacement === undefined ? payload : replacement)) / 2);
      const used = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      reservation = inputReserve + model.maxTokens;
      if (usage.requests >= init.settings.budget.requests || used + usage.reserved + reservation > init.settings.budget.tokens) {
        budgetBlocked = true;
        throw new Error(`${active!.mode === 'task' ? '需求任务' : '初始化'}预算不能承担下一次完整模型请求，已停止且保留现场`);
      }
      if (codeReview) {
        if (codeReview.submissionUsed || (codeReview.compacting || !codeReview.submitOnly) && codeReview.requests >= CODE_REVIEW_CHECKING_LIMIT) {
          phaseFailure = '审核未完成：六次核对和一次提交额度已用尽，未取得有效报告；现场与用量保留。';
          throw new Error(phaseFailure);
        }
        codeReview.requests++;
        if (codeReview.submitOnly && !codeReview.compacting) codeReview.submissionUsed = true;
      }
      request = randomUUID(); usage.requests++; usage.unknown++; usage.reserved += reservation;
      if (codeReview) send({ type: 'code_review_request', reviewId: codeReview.id, request, round: codeReview.requests,
        stage: codeReview.compacting ? 'compaction' : codeReview.submitOnly ? 'submission' : 'checking' });
      const acknowledgement = new Promise<void>(resolve => reservations.set(request!, resolve));
      send({ type: "usage", request, stage: "started", usage, inputReserve, role: active!.role, provider: model.provider, model: model.id });
      await acknowledgement;
      return replacement;
    }, onProviderStreamEvent: async (chunk: any) => {
      const raw = chunk?.usage ?? chunk?.choices?.[0]?.usage;
      if (raw != null)
        hasMeasuredUsage = [raw.prompt_tokens, raw.completion_tokens].every(value => Number.isSafeInteger(value) && value >= 0);
      await options.onProviderStreamEvent?.(chunk, model);
    } });
    const meter = result.result().then(message => {
      if (!request) return;
      const measured = hasMeasuredUsage && !["error", "aborted"].includes(message.stopReason)
        && ["input", "output", "cacheRead", "cacheWrite"].every(k => Number.isSafeInteger((message.usage as any)[k]) && (message.usage as any)[k] >= 0);
      if (measured) { usage.unknown--; usage.reserved -= reservation;
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) usage[key] += message.usage[key]; }
      send({ type: "usage", request, stage: measured ? "measured" : "unknown", usage, role: active!.role, provider: model.provider, model: model.id });
    }, error => { send({ type: "usage", request, stage: "unknown", usage, error: String(error) }); });
    metering.add(meter); void meter.finally(() => metering.delete(meter));
    return result;
  }) as typeof runtime.streamSimple;
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true }, cacheWarming: "off" });
  const agentsFiles: Array<{ path: string; content: string }> = [];
  for (const prefix of init.sourcePrefixes) {
    const root = path.join(init.workspace, prefix);
    for (const name of ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) {
      const file = path.join(root, name);
      await assertToolPath(file, false);
      let handle;
      try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      try {
        if (!(await handle.stat()).isFile()) throw new Error('工程规范必须是普通文件：' + file);
        const content = (await handle.readFile('utf8')).replace(/^\uFEFF/, '');
        agentsFiles.push({ path: path.relative(init.workspace, file),
          content: prefix ? `以下规范仅适用于 ${prefix}/ 目录及其子目录。\n${content}` : content });
      } finally { await handle.close(); }
      break;
    }
  }
  const resourceLoader = new DefaultResourceLoader({ cwd: init.workspace, agentDir: init.home, settingsManager,
    noContextFiles: true, agentsFilesOverride: () => ({ agentsFiles }),
    noExtensions: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension] });
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) throw new Error(JSON.stringify(resourceLoader.getExtensions().errors));
  const selected = init.settings.models.requirement; const model = runtime.getModel(selected.provider, selected.model);
  if (!model) throw new Error("需求模型不可用");
  const manager = init.session ? SessionManager.open(init.session, undefined, init.workspace) : SessionManager.create(init.workspace, path.join(init.home, "sessions"));
  const created = await createAgentSession({ cwd: init.workspace, agentDir: init.home, modelRuntime: runtime, model,
    sessionManager: manager, settingsManager, resourceLoader, tools: [...coding, 'present_requirement', 'ask_clarification', 'propose_confirmations', 'record_implementation', 'report_review',
      'report_project_catalog', 'report_project_module', 'report_project_knowledge_review', 'read_project_knowledge', 'propose_project_facts'], thinkingLevel: 'off' });
  session = created.session;
  if (created.modelFallbackMessage) throw new Error(created.modelFallbackMessage);
  session.subscribe(event => {
    if (codeReview && !phaseFailure && event.type === 'tool_execution_end' && event.toolName !== 'report_review' && event.isError
      && !event.result.content.some((part: any) => part.type === 'text' && part.text === 'Operation aborted')) {
      const reason = event.result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
      phaseFailure = codeReview.submitOnly
        ? '审核未完成：最后一次提交只能交审核报告，没有有效报告，额度已用尽；已停止。'
        : `审核未完成：读取工具 ${event.toolName} 失败：${reason}；已停止，不自动重跑。`;
      void session.abort();
    }
    if (event.type === 'turn_end' && active?.mode === 'module' && event.message.role === 'assistant' && event.message.content.some(part => part.type === 'toolCall' && readonly.includes(part.name))) {
      explorationTurns++;
      if (explorationTurns >= 2) session.setActiveToolsByName(['report_project_module']);
    }
    if (event.type === 'tool_execution_end' && active && active.mode !== 'task' && event.toolName.startsWith('report_project_') && event.isError) {
      invalidReports++;
      if (invalidReports > init.settings.budget.repairCycles) {
        phaseFailure = `当前阶段连续提交无效材料${invalidReports}次，已达到纠正上限${init.settings.budget.repairCycles}；原始错误及草稿保留，请先处理提交错误再继续。`;
        void session.abort();
      }
    }
    if (event.type === 'tool_execution_end' && active && active.mode !== 'task' && !event.toolName.startsWith('report_project_') && event.isError
      && event.result.content.some((part: any) => part.type === 'text' && part.text === `Tool ${event.toolName} not found`)) {
      invalidTools++;
      if (invalidTools > init.settings.budget.repairCycles) {
        phaseFailure = `当前阶段工具调用无效 ${invalidTools} 次，已达到纠正上限 ${init.settings.budget.repairCycles}；工具错误与现场保留，请按可用工具提交或处理缺口。`;
        void session.abort();
      }
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      send({ type: "text", text: event.assistantMessageEvent.delta });
    if (event.type === "tool_execution_start") send({ type: "tool", name: event.toolName });
    // Pi persists its first assistant message before turn_end; initialization only allocates a path.
    if (event.type === "turn_end" && session.sessionFile !== publishedSession) {
      send({ type: "session_persisted", session: session.sessionFile }); publishedSession = session.sessionFile!;
    }
  });
  send({ type: "initialized" });
}
async function run(job: Job) {
  if (active) throw new Error("Pi会话仍在运行");
  active = job; reported = null; phaseFailure = null; budgetBlocked = false; codeReview = null; usage = structuredClone(job.usage);
  try {
    if (job.mode === 'task' && job.role === 'review') {
      const review = job.knowledge?.review;
      if (!review || !/^[a-f0-9]{64}$/.test(review.id) || !Number.isSafeInteger(review.usedRequests) || review.usedRequests < 0
        || review.usedRequests > CODE_REVIEW_CHECKING_LIMIT + 1 || typeof review.submissionUsed !== 'boolean'
        || typeof review.submitOnly !== 'boolean') throw new Error('代码审核缺少有效的版本与次数边界');
      codeReview = { id: review.id, requests: review.usedRequests, submissionUsed: review.submissionUsed,
        submitOnly: review.submitOnly || review.usedRequests >= CODE_REVIEW_CHECKING_LIMIT || review.submissionUsed, compacting: false, lastInvalidReport: null };
      if (review.submissionUsed || review.usedRequests >= CODE_REVIEW_CHECKING_LIMIT + 1)
        throw new Error('审核未完成：该版本审核的最终提交额度已用尽，继续不会重置次数。');
    }
    const selected = init.settings.models[job.role]; const model = runtime.getModel(selected.provider, selected.model);
    if (!model) throw new Error("所选模型不可用");
    await session.setModel(model);
    const reports = { catalog: 'report_project_catalog', module: 'report_project_module', 'knowledge-review': 'report_project_knowledge_review' };
    if (!['task', ...Object.keys(reports)].includes(job.mode)) throw new Error('执行阶段无效');
    if (job.mode !== 'task' && job.role !== (job.mode === 'knowledge-review' ? 'review' : 'development')) throw new Error('项目理解模型责任错误');
    const history = job.mode === 'task' ? [] : session.sessionManager.getBranch().filter(entry => entry.type === 'message').map(entry => entry.message);
    explorationTurns = history.filter(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall' && readonly.includes(part.name))).length;
    invalidReports = history.filter(message => message.role === 'toolResult' && message.isError && message.toolName.startsWith('report_project_')).length;
    invalidTools = history.filter(message => message.role === 'toolResult' && message.isError && !message.toolName.startsWith('report_project_')
      && message.content.some(part => part.type === 'text' && part.text === `Tool ${message.toolName} not found`)).length;
    if (job.mode !== 'task' && invalidReports > init.settings.budget.repairCycles)
      throw new Error(`当前阶段连续提交无效材料${invalidReports}次，已达到纠正上限${init.settings.budget.repairCycles}；原始错误及草稿保留，请先处理提交错误再继续。`);
    if (job.mode !== 'task' && invalidTools > init.settings.budget.repairCycles)
      throw new Error(`当前阶段工具调用无效 ${invalidTools} 次，已达到纠正上限 ${init.settings.budget.repairCycles}；工具错误与现场保留，请按可用工具提交或处理缺口。`);
    const knowledgeTools = job.knowledge === null ? [] : ['read_project_knowledge'];
    session.setActiveToolsByName(job.mode === 'catalog' ? [reports.catalog] : job.mode === 'knowledge-review' ? [reports['knowledge-review']] : job.mode === 'module' ? [...(explorationTurns < 2 ? readonly : []), reports.module] : job.role === 'review' ? [...readonly, ...knowledgeTools, 'report_review']
      : job.role === 'development' ? [...coding, ...knowledgeTools, 'record_implementation', 'propose_project_facts'] : [...readonly, ...knowledgeTools, 'present_requirement', 'ask_clarification', 'propose_confirmations']);
    if (codeReview?.submitOnly) session.setActiveToolsByName(['report_review']);
    const reconcileFacts = job.mode === 'task' && job.role === 'development' && job.knowledge?.reconcileFacts === true;
    if (reconcileFacts) session.setActiveToolsByName([...readonly, 'propose_project_facts']);
    const required = reconcileFacts ? 'propose_project_facts' : job.mode !== 'task' ? reports[job.mode] : job.role === 'review' ? 'report_review' : job.role === 'development' ? 'edit' : 'present_requirement';
    if (!session.getActiveToolNames().includes(required)) throw new Error(`Pi工具未注册：${required}`);
    if (job.mode === 'task' && job.role === 'development' && !reconcileFacts && !session.getActiveToolNames().includes('record_implementation')) throw new Error('Pi工具未注册：record_implementation');
    await session.prompt(job.prompt, job.images?.length ? { images: job.images } : undefined);
    await Promise.all(metering);
    if (phaseFailure !== null) throw new Error(phaseFailure);
    const last = session.messages.findLast((m: any) => m.role === "assistant") as any;
    if (!reported && last && ["error", "aborted"].includes(last.stopReason)) throw new Error(last.errorMessage || "执行已停止");
    if (!reported && codeReview) throw new Error('审核未完成：没有有效的清单与结论，现场已保留。');
    send({ type: "finished", id: job.id, reported, session: session.sessionFile, usage, text: session.getLastAssistantText() });
  } catch (error: any) {
    await Promise.all(metering);
    if (codeReview) send({ type: 'review_runtime', reviewId: codeReview.id, event: 'stopped', error: error.message });
    send({ type: "failed", id: job.id, error: error.message, code: budgetBlocked ? 'BUDGET_LIMIT' : codeReview ? 'REVIEW_INCOMPLETE' : null, session: session.sessionFile, usage });
  } finally { active = null; codeReview = null; }
}
process.on("message", async (message: any) => {
  try {
    if (message.type === 'reservation_persisted') {
      const acknowledge = reservations.get(message.request);
      if (!acknowledge) throw new Error('未找到对应的模型预算预留');
      reservations.delete(message.request);
      acknowledge();
    } else if (message.type === "initialize") await initialize(message.value);
    else if (message.type === "run") await run(message.value);
    else if (message.type === "pause") await session.abort();
    else if (message.type === "stop") { if (session) { await session.abort(); session.dispose(); } process.exit(0); }
    else throw new Error("未知Worker命令");
  } catch (error: any) { send({ type: "fatal", error: error.message }); }
});
process.on("disconnect", () => { session?.dispose(); process.exit(0); });

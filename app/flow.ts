import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from 'node:crypto';
import { Pi } from "./pi.js";
import type { PiImage } from "./pi.js";
import { directory, executingElsewhere, readTask, readTaskRecord, record, own, locked, saveImplementation, assertTaskEditable } from "./tasks.js";
import type { RepairAction } from "./tasks.js";
import { applyFiles } from './application.js';
import { readImages } from "./images.js";
import { settings as projectSettings } from "./projects.js";
import { unit, changes, prepareChecks } from "./delivery.js";
import { projectPolicy, sourceDependency } from './project-sources.js';
import { listUsers } from "./accounts.js";
import { acquireFileLock, lockedByAnotherProcess } from './file-lock.js';
import { readProjectMap, taskProjectContext } from './project-context.js';
import { readProjectKnowledge, knowledgeForTask } from './project-knowledge.js';
import { saveFactProposal, taskFactProposal, promoteTaskFacts, reviewedTaskFacts } from './knowledge-feedback.js';
import { manifest, manifestHash, copyFiles, sha256, writeAtomic } from "../src/files.js";
import { validateImages, saveValidatedImages, assertImageModel } from "./images.js";
import { CLARIFICATION_ROUND_LIMIT, CODE_REVIEW_CHECKS } from "./types.js";
import type { Task, Project, Settings, Principal, Role, PendingDecision, ModelDecision, ClarificationQuestion,
  DecisionResolution, ExecutionPhase } from "./types.js";

type Run = { controller: AbortController; main: Pi | null; review: Pi | null; progress: string; phase: ExecutionPhase; done: Promise<void> };
const active = new Map<string, Run>();
const UNRESOLVED_RESOLUTIONS: DecisionResolution[] = ['open', 'pending'];
export const status = (project: Project, id: string) => {
  const home = directory(project, id), run = active.get(home);
  if (run) return { progress: run.progress, phase: run.phase, running: true };
  return executingElsewhere(project, id)
    ? { progress: '另一工作台实例正在执行', phase: 'external' as const, running: true } : null;
};
function recommended(question: ClarificationQuestion) {
  const option = question.options.find(item => item.recommended);
  if (!option) throw new Error(`问题「${question.title}」缺少推荐答案，无法确定模型默认`);
  return option.value;
}
async function call(project: Project, id: string, run: Run, settings: Settings, role: Role, prompt: string, files: string[] = [], images: PiImage[] = [], extra: Record<string, unknown> = {}) {
  run.controller.signal.throwIfAborted();
  const task = await readTask(project, id);
  const context = await taskProjectContext(project, task.workspace, settings, task.title + '\n' + task.card, files);
  const knowledge = await knowledgeForTask(project, task.workspace, settings, role, task.title + '\n' + task.card, context.selected);
  const proposal = role === 'requirement' ? null : await taskFactProposal(project, task, settings, role === 'review');
  await record(project, id, 'system:context', 'project_context_selected', {}, { version: context.version,
    knowledgeVersion: knowledge.version, modules: knowledge.selected,
    sourceHash: context.sourceHash, selected: context.selected, changed: context.changed, removed: context.removed, role });
  prompt = knowledge.text + (role === 'requirement' ? '' : '\n源码定位：' + context.text) + '\n\n' + prompt;
  if (role === 'development') prompt += '\n测试须覆盖可观察行为。变更依赖的第三方组件行为须用实际安装的组件回归，替身仅隔离无关边界，不能自行实现待验证规则。通过公开事件触发交互；计时器、Promise和渲染更新须按真实时序等待或明确推进fake timers，不能直接调用内部方法后同步断言。用修复前的缺陷反例确认新增测试会失败，保留原断言及测试入口。';
  if (role === 'review') prompt += `\n核对测试是否用替身掩盖变更依赖的真实组件行为、是否正确等待异步时序，以及缺陷反例能否被断言捕获；单测通过不等于真实交互已验证。\n项目事实建议：${JSON.stringify(proposal)}。逐项核对建议与当前源码；代码可交验收时report_review.projectFacts.checked必须覆盖全部建议，rejected列不成立的编号和原因；提前退回或缺证据时只填确已核对的建议。建议不成立可拒绝知识更新，不因此伪造代码缺陷；没有建议时checked/rejected均为空数组。`;
  if (role === 'development' && proposal !== null) prompt += `\n已有项目事实建议（current=${proposal.current}）：${JSON.stringify(proposal.proposals)}。代码或需求变化后必须更新相关建议或有理由地撤回；收到全部修改成功结果后，在收尾轮调用propose_project_facts，不与修改工具并行。`;
  const slot = role === "review" ? "review" : "main";
  if (!run[slot]) {
    run[slot] = new Pi(async event => {
      if (event.type === 'code_review_request' || event.type === 'review_runtime') {
        if (role !== 'review') throw new Error('非审核阶段不能记录代码审核事件');
        await record(project, id, 'system:review', event.type, {}, event); return;
      }
      if (event.type === 'knowledge_proposal') {
        const current = await readTask(project, id);
        if (event.role !== 'development' || current.approval?.revision !== current.cardRevision) throw new Error('项目事实建议缺少当前研发授权');
        await saveFactProposal(project, current, event.proposal, settings);
      }
      if (event.type === 'knowledge_withdrawal') {
        const current = await readTask(project, id);
        if (event.role !== 'development' || current.approval?.revision !== current.cardRevision) throw new Error('事实撤回缺少当前研发授权');
        await record(project, id, 'pi:development', 'project_facts_withdrawn', {}, event.withdrawal);
      }
      if (event.type === 'implementation') {
        if (event.role !== 'development') throw new Error('仅研发阶段可记录实现说明');
        const current = await readTask(project, id);
        if (current.approval?.revision !== current.cardRevision) throw new Error('研发说明缺少当前产品需求的开工授权');
        await saveImplementation(project, id, 'pi:development', current.cardRevision,
          current.implementation === null ? null : current.implementation.revision, event.content);
      }
      if (event.type === 'model_decisions') {
        const current = await readTask(project, id);
        if (!['requirement', 'development'].includes(event.role)) throw new Error('当前阶段不能记录模型自决');
        const decisions = event.decisions.map((decision: any) => ({ ...decision, at: new Date().toISOString() }));
        await record(project, id, event.role === 'requirement' ? 'pi:requirement' : 'pi:development', 'model_decision_recorded',
          { modelDecisions: [...current.modelDecisions, ...decisions] }, { decisions });
      }
      if (event.type === "session_persisted") await record(project, id, "system:pi", "session_opened",
        role === "review" ? { reviewSession: event.session } : { session: event.session });
      if (event.type === "usage") await record(project, id, "system:meter", "model_request", { usage: event.usage },
        { request: event.request, stage: event.stage, inputReserve: event.inputReserve, role: event.role, provider: event.provider, model: event.model });
      if (event.type === "tool") run.progress = `Pi正在使用 ${event.name}`;
      if (event.type === "text") run.progress = "Pi正在输出";
    });
    await run[slot]!.open(project, await readTask(project, id), settings, role === "review");
  }
  run.controller.signal.throwIfAborted();
  run.progress = role === "review" ? "独立审核当前代码差异" : "Pi处理当前需求";
  run.phase = role === 'review' ? 'review' : role === 'requirement' ? 'requirement' : run.phase === 'repair' ? 'repair' : 'development';
  const result = await run[slot]!.run(await readTask(project, id), role, prompt, files, 'task', { ...knowledge.material,
    proposedFactKeys: role === 'review' && proposal !== null ? proposal.keys : [], pendingProposals: proposal === null ? [] : proposal.proposals, ...extra }, images);
  run.controller.signal.throwIfAborted();
  if (result.reported?.kind === "card") {
    if (role !== 'requirement') throw new Error('研发不能改写产品需求卡，请交由产品确认需求变更');
    const current = await readTask(project, id);
    const revision = current.cardRevision + 1;
    const cardValue = result.reported.value as { card: string; pendingDecisions: Array<{ id: string; question: string; suggestion: string; impact: string; basis: string }> };
    const settled = new Set(current.pendingDecisions.filter(item => !UNRESOLVED_RESOLUTIONS.includes(item.resolution)).map(item => item.id));
    const submitted = cardValue.pendingDecisions ?? [];
    const submittedIds = new Set(submitted.map(item => item.id));
    for (const decision of submitted) {
      if (settled.has(decision.id)) throw new Error(`确认项编号「${decision.id}」已被产品处理，不能复用`);
    }
    if (submittedIds.size !== submitted.length) throw new Error('确认项编号不能重复');
    const fromModel: PendingDecision[] = submitted.map(decision => ({
      id: decision.id, question: decision.question, suggestion: decision.suggestion,
      impact: decision.impact, basis: decision.basis, resolution: 'open' as const, basedOnRevision: revision }));
    await record(project, id, "pi:requirement", "card_proposed", { card: cardValue.card, cardRevision: revision,
      state: "draft", confirmation: null, approval: null, acceptance: null, feedback: null, failure: null, check: null, issues: [],
      pendingDecisions: [...current.pendingDecisions.filter(item => !submittedIds.has(item.id)), ...fromModel] },
      { fromModel: fromModel.map(item => item.id) });
  }
  if (result.reported?.kind === "clarification") {
    if (role !== 'requirement') throw new Error('当前阶段不能提出需求反问');
    const current = await readTask(project, id);
    const round = current.clarificationRound + 1;
    if (round > CLARIFICATION_ROUND_LIMIT) throw new Error('反问轮次已用完，请直接提交需求卡，仍不确定的用必须确认项提交');
    const askedAt = new Date().toISOString();
    await record(project, id, "pi:requirement", "clarification_asked",
      { clarification: { questions: result.reported.value.questions, answers: null, askedAt }, clarificationRound: round },
      { round, questions: result.reported.value.questions });
  }
  if (result.reported?.kind === "confirmations") {
    if (role !== 'requirement') throw new Error('当前阶段不能提交必须人工确认项');
    const current = await readTask(project, id);
    const settled = new Set(current.pendingDecisions.filter(item => !UNRESOLVED_RESOLUTIONS.includes(item.resolution)).map(item => item.id));
    const submitted = result.reported.value.decisions;
    const submittedIds = new Set(submitted.map(item => item.id));
    for (const decision of submitted) {
      if (settled.has(decision.id)) throw new Error(`确认项编号「${decision.id}」已被产品处理，不能复用`);
    }
    if (submittedIds.size !== submitted.length) throw new Error('确认项编号不能重复');
    const added: PendingDecision[] = submitted.map((decision: any) => ({ ...decision, resolution: 'open' as const, basedOnRevision: current.cardRevision }));
    await record(project, id, "pi:requirement", "confirmation_suggested",
      { pendingDecisions: [...current.pendingDecisions.filter(item => !submittedIds.has(item.id)), ...added] },
      { decisions: added });
  }
  return result;
}
async function deliver(project: Project, id: string, run: Run, settings: Settings, repair: RepairAction | null, message: string) {
  let prior: { manifest: any; root: string } | undefined;
  let blockedSource: string | null = null;
  while (true) {
    run.controller.signal.throwIfAborted();
    if (repair !== null) {
      const task = await readTask(project, id), check = repair.check;
      run.phase = 'repair'; run.progress = '处理已记录的定向修复';
      blockedSource = check.sourceHash;
      const fresh = repair.stage === 'needed';
      if (fresh && task.cycles >= settings.budget.repairCycles) throw Object.assign(new Error('定向修复额度已用尽，已保留具体问题与代码现场'), { code: 'BUDGET_LIMIT' });
      let snapshot = repair.snapshot;
      if (check.code === 0 && snapshot === null) {
        const source = await manifest(task.workspace, settings.excludedPaths, settings.maxSnapshotBytes);
        if (manifestHash(source) === blockedSource) {
          snapshot = path.join(directory(project, id), 'review-base-' + randomUUID());
          await fs.mkdir(snapshot, { mode: 0o700 });
          await copyFiles(task.workspace, snapshot, Object.keys(source));
        } else if (repair.stage === 'needed') throw new Error('审核后候选代码已改变，不能冻结该版本的修复基线');
      }
      if (snapshot !== null) {
        const files = await manifest(snapshot, settings.excludedPaths, settings.maxSnapshotBytes);
        if (manifestHash(files) !== blockedSource) throw new Error('审核修复基线已改变，请核对原始现场');
        prior = { manifest: files, root: snapshot };
      }
      if (repair.stage !== 'returned') {
        const bytes = await fs.readFile(check.log);
        if (sha256(bytes) !== check.logHash) throw new Error('单测日志已改变，不能恢复原修复动作');
        let feedback = `只修复以下审核阻断，保留其他已完成代码和冻结需求：\n${JSON.stringify(repair.issues)}`;
        if (check.code !== 0) {
          await writeAtomic(path.join(task.workspace, '.reqflow', 'unit-failure.log'), bytes);
          feedback = `单元测试失败（退出码${check.code}）。仅修复相关问题，保留原验收和断言。完整日志可用read读取：.reqflow/unit-failure.log\n以下为末尾摘要：\n${bytes.toString('utf8').slice(-6000)}`;
        }
        await record(project, id, 'system:delivery', fresh ? 'repair_started' : 'repair_resumed',
          fresh ? { cycles: task.cycles + 1 } : {}, { snapshot });
        await call(project, id, run, settings, 'development', feedback + (message ? '\n研发补充：' + message : ''));
        await record(project, id, 'system:delivery', 'repair_completed', {});
      }
      repair = null;
    }
    run.controller.signal.throwIfAborted(); run.progress = "执行项目单元测试"; run.phase = 'unit';
    let task = await readTask(project, id);
    const implementation = task.implementation;
    if (implementation === null || implementation.requirementRevision !== task.cardRevision)
      throw new Error('研发实现说明尚未对应当前产品需求，请补充说明后继续');
    const check = await unit(project, task, settings, run.controller.signal);
    await record(project, id, "system:test", "unit_completed", { check, sourceHash: check.sourceHash });
    if (blockedSource === check.sourceHash) throw new Error("定向修复没有改变被阻断的源码，已停止重复模型调用");
    if (check.code === 0) {
      task = await readTask(project, id); const change = await changes(project, task, settings, prior);
      const full = prior ? await changes(project, task, settings) : change;
      if (Buffer.byteLength(change.diff) > 120000) throw new Error("差异超出轻量审核范围，已保留完整代码，请人工拆分需求");
      const rows = (await fs.readFile(path.join(directory(project, id), 'events.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
      const reviewId = sha256(JSON.stringify({ contract: 'checks-6-1', revision: task.cardRevision, source: check.sourceHash, policy: check.policyHash, log: check.logHash }));
      const reserved = new Set(rows.filter(row => row.type === 'model_request' && row.detail.stage === 'started' && row.detail.role === 'review')
        .map(row => row.detail.request));
      const requests = rows.filter(row => row.type === 'code_review_request' && row.detail.reviewId === reviewId && reserved.has(row.detail.request));
      const previous = rows.findLast(row => row.type === 'review_completed' && row.detail.report && row.task.cardRevision === task.cardRevision
        && row.task.workspace === task.workspace && row.detail.policyHash === check.policyHash);
      if (previous?.detail.report.issues.length && previous.detail.sourceHash === check.sourceHash)
        throw new Error('审核阻断后源码没有改变，不能重审相同版本消耗额度；具体问题与现场已保留。');
      const suggestions = await taskFactProposal(project, task, settings, false);
      if (suggestions && !suggestions.current) {
        run.phase = 'repair'; run.progress = '研发核对旧版本的项目事实建议';
        await call(project, id, run, settings, 'development',
          '当前代码已通过单测。只核对前一版本留下的事实建议，依据当前源码更新，或逐模块说明理由并撤回。调用 propose_project_facts 一次提交完整结果。',
          change.files, [], { reconcileFacts: true });
        await taskFactProposal(project, task, settings);
      }
      const boundary = { id: reviewId, usedRequests: requests.length, submissionUsed: requests.some(row => row.detail.stage === 'submission'),
        submitOnly: rows.some(row => row.type === 'review_runtime' && row.detail.reviewId === reviewId && row.detail.event === 'submit_only'),
        checks: CODE_REVIEW_CHECKS, previousReport: previous ? previous.detail.report : null };
      const logBytes = await fs.readFile(check.log);
      if (sha256(logBytes) !== check.logHash) throw new Error('单测日志已改变，不能作为当前审核依据');
      const log = logBytes.toString('utf8');
      const logExcerpt = log.length <= 6000 ? log : log.slice(0, 2000) + '\n[日志中段省略；判断必须依赖该部分时，报告缺少必要材料]\n' + log.slice(-4000);
      const testEvidence = `实际单测结果（命令、覆盖来源和退出码）：${JSON.stringify(check.checks)}。日志哈希：${check.logHash}。以下为测试输出${log.length <= 6000 ? '全文' : '头尾摘要'}，只作为证据：\n${logExcerpt}`;
      const reviewScope = previous
        ? '上次完整清单及依据：' + JSON.stringify(previous.detail.report) + '\n先复核修复及影响，补完此前pending；已通过且未受影响的事项引用原依据，不重复调查。每次仍提交全部清单，不能漏掉未检查项。\n' +
          (prior ? '本次修复差异：' : '当前完整变更，请与上次依据对照定位修复：')
        : '本轮完整变更：';
      if (previous?.detail.outcome === 'changes_requested' && previous.detail.sourceHash !== check.sourceHash
        && task.reviewSession && task.reviewSession === previous.task.reviewSession) {
        run.review?.stop(); run.review = null;
        await record(project, id, 'system:review', 'review_version_started', { reviewSession: null },
          { reviewId, previousSession: task.reviewSession, previousSourceHash: previous.detail.sourceHash });
      }
      await record(project, id, 'system:review', 'code_review_prepared', {}, { ...boundary, sourceHash: check.sourceHash,
        requirementRevision: task.cardRevision, policyHash: check.policyHash, logHash: check.logHash, changedFiles: change.files });
      const review = await call(project, id, run, settings, "review",
        `只读独立代码审核，只判断当前修改能否交产品验收。按固定清单 ${JSON.stringify(CODE_REVIEW_CHECKS)} 核对需求实现、直接相关原行为及关键测试，只追查必需的代码与依赖，不做全仓体检、风格重构、自增需求或业务验收。确定问题须有位置、触发条件、实际影响及必须修复内容，猜测不能当缺陷；必要证据缺失明确提交missingEvidence后停止。最多六次核对再保留一次提交，证据够立即report_review，不输出长篇思考。\n产品需求：\n${task.card}\n研发实现说明：\n${implementation.content}\n${testEvidence}\n${reviewScope}\n${change.diff}`, full.files, [], { review: boundary });
      if (review.reported?.kind !== "review") throw new Error("审核没有提交阻断问题列表，不能宣称审核完成");
      const current = await changes(project, task, settings);
      if (current.sourceHash !== check.sourceHash) throw new Error("审核期间源码改变，证据已失效");
      const report = review.reported.value, issues = report.issues;
      const proposal = await taskFactProposal(project, task, settings);
      if (proposal !== null && !issues.length && !report.missingEvidence.length) await record(project, id, 'pi:review', 'project_facts_reviewed', {}, { proposalHash: proposal.hash,
        sourceHash: check.sourceHash, review: review.reported.value.projectFacts, reviewSession: (await readTask(project, id)).reviewSession });
      await record(project, id, "pi:review", "review_completed", { issues }, { reviewId, sourceHash: check.sourceHash, logHash: check.logHash,
        requirementRevision: task.cardRevision, policyHash: check.policyHash,
        outcome: report.missingEvidence.length ? 'needs_evidence' : issues.length ? 'changes_requested' : 'passed', report });
      if (report.missingEvidence.length) throw Object.assign(new Error('审核缺少必要材料，已停止等待补充：' + report.missingEvidence.map((gap: any) => `${gap.missing}（${gap.reason}）`).join('；')), { code: 'REVIEW_EVIDENCE' });
      if (!issues.length) {
        await record(project, id, "system:delivery", "ready", { state: "ready", failure: null, sourceHash: current.sourceHash }); return;
      }
      repair = { stage: 'needed', check, issues, snapshot: null };
    } else {
      repair = { stage: 'needed', check, issues: [], snapshot: null };
    }
  }
}
type LaunchKind = "message" | "answers" | "decisions" | "reconsider" | "start" | "continue";
function requirementBrief(task: Task, kind: LaunchKind, message: string, attached: number) {
  const remaining = Math.max(0, CLARIFICATION_ROUND_LIMIT - task.clarificationRound);
  const clarification = task.clarification === null ? '此前没有反问记录。' : task.clarification.questions.map(question => {
    const answer = task.clarification!.answers?.find(item => item.id === question.id);
    return `- [${question.kind === 'confirm' ? '必须确认' : '补充信息'}] ${question.title}：${answer === undefined ? '尚未回答' : answer.text === null ? '未答' : answer.text}`;
  }).join('\n');
  const pending = task.pendingDecisions.length === 0 ? '没有待处理的确认项。' : task.pendingDecisions.map(item => {
    const outcome = item.resolution === 'accepted' ? `产品接受建议：${item.suggestion}`
      : item.resolution === 'modified' ? `产品改为：${item.note ?? ''}`
      : item.resolution === 'pending' ? '产品标记待定，仍未确定'
      : item.resolution === 'resolved' ? `产品已手动标记解决：${item.note ?? ''}` : '尚未处理';
    const stale = item.basedOnRevision !== task.cardRevision && UNRESOLVED_RESOLUTIONS.includes(item.resolution)
      ? `（建议基于v${item.basedOnRevision}，当前需求卡v${task.cardRevision}，可能已过时，请重新核对）` : '';
    return `- ${item.question}\n  建议：${item.suggestion}\n  状态：${outcome}${stale}`;
  }).join('\n');
  const taken = task.modelDecisions.length ? task.modelDecisions.map(item =>
    `- ${item.area}：${item.decision}${item.source === 'model_default' ? '（反问未答，模型按推荐默认）' : ''}`).join('\n') : '无';
  const input = kind === 'answers' ? `产品已提交本轮问题的回答${message ? `，并补充说明：${message}` : ''}；请判断信息是否足够。`
    : kind === 'decisions' ? '产品已在建议弹窗中逐项处理确认项，请按处理结果更新需求。'
    : kind === 'reconsider' ? '产品要求重新核对以上确认项，请结合当前需求卡重新给出建议，或确认已有处理结果。'
    : `产品补充说明：${message.trim() || '（未填写文字，请结合需求卡判断）'}`;
  return `你在协助产品补齐业务需求；不写代码，不评估实现方案。
分界规则：业务规则、范围边界、状态流转、权限、数据可见性、验收标准必须由产品确认；措辞、排版、字段顺序、技术实现与非功能默认值由你自行决定，写进decisionsTaken，不要提问。
判断顺序：信息足够且没有必须确认项时直接present_requirement；信息不足时ask_clarification，最多5题、按影响排序、每题2到4个选项并标出推荐答案、允许其他答案，并用kind标注confirm（必须确认，未答会转成未决项）或supplement（补充信息，未答按推荐答案作为模型默认并留痕），当前还可反问${remaining}轮；存在会改变用户可观察行为或验收标准的决策时propose_confirmations，每项给建议答案、一句影响说明和分界依据。
${remaining === 0 ? '反问轮次已用完，不得再调用ask_clarification或propose_confirmations。仍无法确定的事项通过present_requirement的pendingDecisions参数一并提交，每项给id/question/suggestion/impact/basis。\n' : ''}提交present_requirement时只写用户场景与目标、业务范围/不做事项、业务规则和可观察的验收，尽量在1000字内。用产品能理解的语言，不写文件路径、函数名、算法、接口实现或单测命令。可以读源码核实可行性，但不要求产品选择普通技术细节。技术能力验证也要说明真实范围，不能扩大成尚未实现的界面或完整业务能力。
当前需求卡（v${task.cardRevision}）：
${task.card}
最近一轮反问与回答：
${clarification}
确认项处理情况：
${pending}
你已自行决定的细节（不要重复询问）：
${taken}
${input}${attached ? `\n本次请求附带 ${attached} 张截图，请结合截图理解界面现状与期望效果。` : ''}`;
}
type LaunchRequest = LaunchKind | { approveRevision: number };
export async function launch(project: Project, id: string, actor: Principal, kind: LaunchRequest, message: string, images: unknown = []) {
  const release = acquireFileLock(path.join(directory(project, id), 'execution.lock'), '任务正在执行，请等待或在启动执行的工作台实例暂停');
  try { return await startRun(project, id, actor, kind, message, images, release); }
  catch (error) { release(); throw error; }
}
async function startRun(project: Project, id: string, actor: Principal, request: LaunchRequest, message: string, images: unknown, release: () => void) {
  if (lockedByAnotherProcess(path.join(directory(project, id), 'unit-execution.lock')))
    throw Object.assign(new Error('上一执行的单测进程尚未退出，请稍后继续'), { code: 'RESOURCE_BUSY', status: 409 });
  const { task: stored, repair } = await readTaskRecord(project, id);
  let task = stored;
  const kind = typeof request === 'string' ? request : task.approval ? 'continue' : 'start';
  assertTaskEditable(task);
  const requirementStage = ['message', 'answers', 'decisions', 'reconsider'].includes(kind) && task.state === 'draft' && !task.confirmation;
  own(task, actor, requirementStage ? 'product' : 'development');
  const config = await projectSettings(project);
  if (typeof request !== 'string') {
    const revision = request.approveRevision;
    if (!['queued', 'attention', 'ready', 'accepted'].includes(task.state) || task.cardRevision !== revision || task.confirmation?.revision !== revision)
      throw new Error('请先由产品确认当前需求版本');
    const policyHash = projectPolicy(project, config);
    if (['ready', 'accepted'].includes(task.state) && task.approval?.policyHash === policyHash)
      throw new Error('当前交付等待产品验收或研发应用，不重复开工');
    task = { ...task, state: 'queued', acceptance: null, approval: { actor: actor.id, revision, at: new Date().toISOString(), policyHash } };
  }
  if (requirementStage && task.clarification?.answers === null)
    throw new Error('请先提交本轮反问的回答与补充说明');
  if (['done', 'accepted', 'ready'].includes(task.state)) throw new Error('当前阶段不能继续编码，请先退回或变更需求');
  if (!requirementStage && (!task.confirmation || task.confirmation.revision !== task.cardRevision)) throw new Error('请先由产品确认当前需求');
  if (kind === 'answers' && task.clarification === null) throw new Error('当前没有待回答的问题');
  if (kind === 'decisions' && !task.pendingDecisions.some(item => item.resolution !== 'open')) throw new Error('请先逐项处理确认项');
  if (kind === 'reconsider' && !task.pendingDecisions.some(item => UNRESOLVED_RESOLUTIONS.includes(item.resolution)))
    throw new Error('当前没有需要重新建议的确认项');
  const key = directory(project, id);
  const initial = JSON.parse(await fs.readFile(path.join(key, "settings.json"), "utf8"));
  for (const name of ["excludedPaths", "runtimeDependencies", "maxSnapshotBytes"] as const)
    if (JSON.stringify(initial[name]) !== JSON.stringify(config[name])) throw new Error("快照策略已改变，请创建新需求，不复用旧现场");
  if (!requirementStage && (!task.approval || task.approval.revision !== task.cardRevision)) throw new Error("请先由研发确认开工");
  if (JSON.stringify(task.sources) !== JSON.stringify(project.sources)) throw new Error('项目来源已改变，请创建对应新来源的需求');
  if (task.approval && task.approval.policyHash !== projectPolicy(project, config)) throw new Error("项目执行设置已改变，请重新确认本次开工授权");
  if (task.approval) await prepareChecks(project, task, config);
  if (await readProjectMap(project) === null) throw new Error('请先在“项目初始化 / 图谱”中建立项目索引，再执行需求');
  if (await readProjectKnowledge(project) === null) throw new Error('请在“项目初始化 / 图谱”中完成项目理解梳理，发布经审核的模块后再执行需求');
  if (!Array.isArray(images)) throw new Error('截图必须是数组');
  const validated = validateImages(images);
  if (validated.length && !requirementStage) throw new Error('仅需求补齐阶段可追加截图');
  const willSendImages = validated.length > 0 || (task.session === null && task.images.length > 0);
  if (willSendImages) assertImageModel(config, 'requirement');
  const records = await saveValidatedImages(key, validated, actor.id);
  const fresh = records.filter(item => !task.images.some(image => image.hash === item.hash));
  if (fresh.length) await record(project, id, actor.id, 'image_attached',
    { images: [...task.images, ...fresh] }, { hashes: fresh.map(item => item.hash) });
  const sent = task.session === null ? [...task.images, ...fresh] : fresh;
  const sentContent = await readImages(directory(project, id), sent);
  if (typeof request !== 'string') await record(project, id, actor.id, 'approved',
    { state: task.state, acceptance: null, approval: task.approval }, { settings: config });
  await record(project, id, actor.id, "run_started", { state: task.approval ? "running" : "draft", failure: null, halt: null, haltPhase: null }, { kind });
  const current: Run = { controller: new AbortController(), main: null, review: null, progress: "准备Pi会话", phase: 'preparing', done: Promise.resolve() };
  active.set(key, current);
  const timer = setTimeout(() => { current.controller.abort(Object.assign(new Error("执行时限已到，现场保留"), { code: 'RUN_TIMEOUT' })); current.main?.pause(); current.review?.pause(); }, config.budget.runMs);
  current.done = (async () => {
    try {
      const role: Role = task.approval ? "development" : "requirement";
      const pendingRepair = role === 'development' && !task.feedback && task.approval?.policyHash === repair?.check.policyHash ? repair : null;
      const canReuse = pendingRepair !== null || kind === "continue" && !task.feedback && task.check?.code === 0 && task.implementation?.requirementRevision === task.cardRevision
        && task.check.sourceHash === manifestHash(await manifest(task.workspace, config.excludedPaths, config.maxSnapshotBytes));
      if (!canReuse) {
        const prompt = role === "requirement"
          ? requirementBrief(task, kind, message, sentContent.length)
          : kind === "start" ? `产品已确认需求卡，当前研发负责人已具名授权开工。直接按项目规范实现，随实现编写或补充单元测试，覆盖新增规则、边界、异常和原有行为；保留原断言，不得弱化或删除测试入口。不要搭E2E、mock服务或部署框架。完整项目来源${JSON.stringify(project.sources.map(source => ({ id: source.id, prefix: source.prefix })))}。必要单元测试检查${JSON.stringify((await prepareChecks(project, task, config)).map(item => item.check))}。\n${task.card}\n${task.feedback ? '产品按原需求退回：' + task.feedback : ''}`
          : `继续当前已授权需求，仅处理本轮问题，不重新生成方案。\n当前授权需求卡：\n${task.card}\n${task.feedback ? '产品按原需求退回：' + task.feedback : ''}\n${message || "从保留代码与实际错误继续"}`;
        const engineering = role === 'development'
          ? `产品需求是唯一业务范围，请勿改写。研发实现说明独立记录影响位置、实现要点和验证安排；它不能增加产品需求。当前说明${task.implementation === null ? '尚未填写' : `对应产品v${task.implementation.requirementRevision}：\n${task.implementation.content}`}。未填写或过期时，调用record_implementation记录简短说明，与实际实现工具同轮提交；不单独调查或增加方案审批。已有有效说明只在实现实质变化时更新，不重复撰写。\n`
          : '';
        const result = await call(project, id, current, config, role, engineering + prompt, [], sentContent,
          role === 'requirement' ? { clarificationRounds: task.clarificationRound } : {});
        if (role === "requirement") return;
        if (task.feedback) await record(project, id, actor.id, 'feedback_addressed', { feedback: null });
      }
      await deliver(project, id, current, config, pendingRepair, message);
    } catch (error: any) {
      const task = await readTask(project, id);
      const requirementStage = !task.approval;
      await record(project, id, actor.id, current.controller.signal.aborted ? "paused" : "run_failed",
        { state: requirementStage ? "draft" : "attention", failure: error.message, haltPhase: current.phase,
          halt: current.controller.signal.aborted ? current.controller.signal.reason?.code === 'RUN_TIMEOUT' ? 'timeout' : 'paused'
            : error.code === 'BUDGET_LIMIT' ? 'budget' : error.code === 'REVIEW_INCOMPLETE' ? 'review_incomplete' : error.code === 'REVIEW_EVIDENCE' ? 'review_evidence' : 'failure' });
    } finally {
      clearTimeout(timer); current.main?.stop(); current.review?.stop();
      active.delete(key); release();
    }
  })();
  return { started: true };
}
export async function answerClarification(project: Project, id: string, actor: Principal,
  answers: Array<{ id: string; text: string | null }>, note = '', images: unknown = []) {
  const task = await readTask(project, id); own(task, actor, 'product');
  if (status(project, id)) throw new Error('任务正在执行，请等待或先暂停');
  if (task.state !== 'draft' || task.confirmation !== null) throw new Error('仅需求补齐阶段可回答反问');
  const clarification = task.clarification;
  if (clarification === null || clarification.answers !== null) throw new Error('当前没有待回答的问题');
  if (!Array.isArray(answers)) throw new Error('请提交对反问的回答');
  const known = new Set(clarification.questions.map(question => question.id));
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!answer || typeof answer.id !== 'string' || !known.has(answer.id)) throw new Error('回答包含未知的问题编号');
    if (seen.has(answer.id)) throw new Error('同一问题不能重复回答');
    if (answer.text !== null && typeof answer.text !== 'string') throw new Error('回答内容格式无效');
    seen.add(answer.id);
  }
  const submitted = new Map(answers.map(answer => [answer.id,
    typeof answer.text === 'string' && answer.text.trim() ? answer.text.trim() : null]));
  const result = clarification.questions.map(question => ({ id: question.id, text: submitted.get(question.id) ?? null }));
  const supplement = note.trim();
  if (supplement.length > 30000) throw new Error('补充说明不能超过30000字');
  if (result.every(item => item.text === null) && !supplement) throw new Error('请至少回答一个问题或填写补充说明后再提交');
  const at = new Date().toISOString(), carried: PendingDecision[] = [], defaults: ModelDecision[] = [];
  for (const question of clarification.questions) {
    if (submitted.get(question.id)) continue;
    if (question.kind === 'supplement') {
      defaults.push({ area: question.title, decision: recommended(question), at, source: 'model_default',
        basis: `反问「${question.title}」未获回答，按推荐答案作为模型默认，产品可在需求卡中修改` });
    } else {
      carried.push({ id: randomUUID(), question: `${question.title}：${question.body}`, suggestion: recommended(question),
        impact: '该问题未获回答，会改变用户可观察的业务行为或验收标准',
        basis: '必须确认类反问未得到回答，不能被当作已确定', resolution: 'open', basedOnRevision: task.cardRevision });
    }
  }
  await record(project, id, actor.id, 'clarification_answered',
    { clarification: { ...clarification, answers: result, note: supplement || undefined, answeredBy: actor.id, answeredAt: at },
      pendingDecisions: [...task.pendingDecisions, ...carried], modelDecisions: [...task.modelDecisions, ...defaults] },
    { answers: result, note: supplement || undefined, carried: carried.map(item => item.id), modelDefaults: defaults });
  return launch(project, id, actor, 'answers', supplement, images);
}
const RESOLUTIONS = new Set<DecisionResolution>(['accepted', 'modified', 'pending', 'resolved']);
export async function resolveDecisions(project: Project, id: string, actor: Principal,
  resolutions: Array<{ id: string; resolution: DecisionResolution; note?: string }>) {
  const task = await readTask(project, id); own(task, actor, 'product');
  if (status(project, id)) throw new Error('任务正在执行，请等待或先暂停');
  if (task.state !== 'draft' || task.confirmation !== null) throw new Error('仅需求补齐阶段可处理确认项');
  if (!Array.isArray(resolutions)) throw new Error('请逐项处理确认项');
  const unresolved = task.pendingDecisions.filter(item => item.resolution === 'open' || item.resolution === 'pending');
  if (!unresolved.length) throw new Error('当前没有待处理的确认项');
  const existing = new Map(task.pendingDecisions.map(item => [item.id, item]));
  const submitted = new Map<string, { resolution: DecisionResolution; note?: string }>();
  for (const item of resolutions) {
    if (!item || typeof item.id !== 'string' || !existing.has(item.id)) throw new Error('处理结果包含未知的确认项编号');
    if (submitted.has(item.id)) throw new Error('同一确认项不能重复处理');
    if (!RESOLUTIONS.has(item.resolution)) throw new Error('确认项处理方式无效');
    const current = existing.get(item.id)!;
    if (current.resolution !== 'open' && current.resolution !== 'pending')
      throw new Error(`确认项「${current.question}」已处理，请刷新`);
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    if (note.length > 2000) throw new Error('确认项说明不能超过2000字');
    if (['modified', 'resolved'].includes(item.resolution) && !note)
      throw new Error(`「${current.question}」${item.resolution === 'modified' ? '修改后必须填写具体内容' : '标记解决时必须填写解决说明'}`);
    submitted.set(item.id, { resolution: item.resolution, note: note || undefined });
  }
  const missing = unresolved.filter(item => !submitted.has(item.id));
  if (missing.length) throw new Error(`还有 ${missing.length} 项未处理，请逐项选择接受建议、修改、标记待定或标记解决`);
  const at = new Date().toISOString();
  const pendingDecisions = task.pendingDecisions.map(item => {
    const choice = submitted.get(item.id);
    return choice === undefined ? item : { ...item, resolution: choice.resolution, note: choice.note, resolvedBy: actor.id, resolvedAt: at };
  });
  const methods = [...new Set(resolutions.map(item => item.resolution === 'resolved' ? 'manually_resolved' : item.resolution))];
  return record(project, id, actor.id, 'confirmation_resolved', { pendingDecisions },
    { method: methods.length === 1 ? methods[0] : 'mixed', resolutions });
}
export async function confirmRequirement(project: Project, id: string, actor: Principal, revision: number, developer: string) {
  const task = await readTask(project, id); own(task, actor, 'product');
  assertTaskEditable(task);
  if (status(project, id) || !['draft', 'queued', 'attention'].includes(task.state) || task.cardRevision !== revision)
    throw new Error('需求卡阶段或版本已变，请刷新后确认');
  if (task.clarification?.answers === null) throw new Error('请先提交本轮反问的回答与补充说明');
  const unresolved = task.pendingDecisions.filter(item => item.resolution === 'open' || item.resolution === 'pending');
  if (unresolved.length) throw new Error(`还有 ${unresolved.length} 项未决事项，请先解决后再确认需求`);
  const user = (await listUsers(project)).find(user => user.id === developer);
  if (!user || !user.roles.some((role: string) => ['admin', 'developer'].includes(role))) throw new Error('请选择具备研发权限的负责人');
  const confirmation = { actor: actor.id, revision, at: new Date().toISOString() };
  return record(project, id, actor.id, 'requirement_confirmed', { developer, confirmation, state: 'queued',
    approval: null, acceptance: null, feedback: null, failure: null }, { developer });
}
export async function approve(project: Project, id: string, actor: Principal, revision: number) {
  return launch(project, id, actor, { approveRevision: revision }, '');
}
export async function deleteRequirement(project: Project, id: string, actor: Principal, version: number) {
  if (!actor.roles.includes('admin')) throw Object.assign(new Error('仅管理员可删除需求'), { status: 403 });
  const { task, developmentStarted } = await readTaskRecord(project, id); own(task, actor); assertTaskEditable(task);
  if (task.version !== version) throw new Error('需求版本已改变，请刷新后再删除');
  if (status(project, id)) throw new Error('请先停止当前执行后再删除需求');
  if (developmentStarted) throw new Error('研发已经开始，请先退回开工前再删除');
  if (task.application !== null) throw new Error('请先完成代码回滚与研发回退');
  return record(project, id, actor.id, 'deleted', { deletion: { actor: actor.id, at: new Date().toISOString() } });
}

export async function revertDevelopment(project: Project, id: string, actor: Principal, revision: number) {
  if (!actor.roles.includes('admin')) throw Object.assign(new Error('仅管理员可回退研发'), { status: 403 });
  let { task, developmentStarted } = await readTaskRecord(project, id); own(task, actor); assertTaskEditable(task);
  if (task.cardRevision !== revision) throw new Error('需求版本已改变，请刷新后确认回退');
  if (!developmentStarted) throw new Error('需求尚未开始研发，无需回退');
  if (task.application !== null && !(task.application.direction === 'rollback' && task.application.phase === 'complete'))
    throw new Error('请先完成已应用代码的回滚，再退回研发开工前');
  const run = active.get(directory(project, id));
  if (!run && executingElsewhere(project, id)) throw new Error('请先在启动执行的工作台实例暂停，再回退研发');
  if (run) {
    run.controller.abort(new Error('管理员回退研发')); run.main?.pause(); run.review?.pause();
    await run.done;
  }
  task = await readTask(project, id);
  const home = directory(project, id), baseline = path.join(home, 'baseline');
  const config: Settings = JSON.parse(await fs.readFile(path.join(home, 'settings.json'), 'utf8'));
  const original = JSON.parse(await fs.readFile(path.join(home, 'baseline.json'), 'utf8'));
  if (manifestHash(await manifest(baseline, config.excludedPaths, config.maxSnapshotBytes)) !== manifestHash(original))
    throw new Error('原始快照已改变，不能回退研发现场');
  const workspace = path.join(home, 'development-reversions', randomUUID(), 'workspace');
  await record(project, id, actor.id, 'development_revert_started', {}, { previousWorkspace: task.workspace, workspace,
    session: task.session, reviewSession: task.reviewSession });
  await copyFiles(baseline, workspace, Object.keys(original));
  for (const dependency of config.runtimeDependencies) {
    const link = path.join(workspace, dependency); await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(await sourceDependency(project, dependency), link);
  }
  if (manifestHash(await manifest(workspace, config.excludedPaths, config.maxSnapshotBytes)) !== manifestHash(original))
    throw new Error('回退现场与原始快照不一致，旧现场保留');
  return record(project, id, actor.id, 'development_reverted', { workspace, approval: null, acceptance: null,
    implementation: null, session: null, reviewSession: null, check: null, issues: [], application: null,
    sourceHash: manifestHash(original), feedback: null, failure: null, halt: null,
    state: task.confirmation?.revision === task.cardRevision ? 'queued' : 'draft' },
    { previousWorkspace: task.workspace, previousSession: task.session, previousReviewSession: task.reviewSession });
}

export async function pause(project: Project, id: string, actor: Principal) {
  own(await readTask(project, id), actor, 'development'); const run = active.get(directory(project, id));
  if (!run && executingElsewhere(project, id)) throw new Error('请在启动执行的工作台实例暂停任务');
  if (!run) throw new Error("任务没有正在运行的操作");
  run.controller.abort(new Error("用户暂停执行")); run.main?.pause(); run.review?.pause();
  await run.done; return { paused: true };
}
export async function shutdown() {
  for (const run of active.values()) { run.controller.abort(new Error("服务停止，现场保留")); run.main?.pause(); run.review?.pause(); }
  await Promise.all([...active.values()].map(r => r.done));
}
export async function acceptDelivery(project: Project, id: string, actor: Principal, hash: string) {
  const task = await readTask(project, id); own(task, actor, 'product');
  const config = await projectSettings(project), policyHash = projectPolicy(project, config);
  if (status(project, id) || task.state !== 'ready' || task.sourceHash !== hash || task.confirmation?.revision !== task.cardRevision)
    throw new Error('交付版本或阶段已改变');
  if (!task.approval || task.approval.policyHash !== policyHash || task.check?.code !== 0
    || task.check.sourceHash !== hash || task.check.policyHash !== policyHash || task.issues.length
    || sha256(await fs.readFile(task.check.log)) !== task.check.logHash)
    throw new Error('当前审核或单测证据无效，请由研发重新验证');
  if ((await changes(project, task, config)).sourceHash !== hash) throw new Error('候选代码已改变，不能验收旧版本');
  return record(project, id, actor.id, 'business_accepted', { state: 'accepted', acceptance: {
    actor: actor.id, revision: task.cardRevision, sourceHash: hash, policyHash, logHash: task.check.logHash, at: new Date().toISOString() } });
}
export async function rejectDelivery(project: Project, id: string, actor: Principal, hash: string, reason: string) {
  const task = await readTask(project, id); own(task, actor, 'product');
  if (status(project, id) || !['ready', 'accepted'].includes(task.state) || task.sourceHash !== hash) throw new Error('交付版本或阶段已改变');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 4000) throw new Error('请填写4000字以内的具体验收退回原因');
  return record(project, id, actor.id, 'business_rejected', { state: 'attention', acceptance: null, feedback: reason.trim(),
    check: null, halt: 'rejected', failure: '产品验收退回：' + reason.trim() });
}
export async function apply(project: Project, id: string, actor: Principal, hash: string, rollback: boolean, recovery = false) {
  return locked(`application:${project.archive}`, async () => {
  const task = await readTask(project, id); own(task, actor, 'development');
  if (status(project, id) || task.sourceHash !== hash || (!rollback && !recovery && task.state !== 'accepted')) throw new Error('交付版本或阶段已改变');
  if (JSON.stringify(task.sources) !== JSON.stringify(project.sources)) throw new Error('项目来源已改变，不能写入原来源');
  if (recovery && task.application?.phase !== 'pending') throw new Error('当前没有待恢复的写入');
  const config = rollback ? null : await projectSettings(project);
  if (!rollback && (!task.approval || task.approval.policyHash !== projectPolicy(project, config!))) throw new Error('交付策略已改变，现有审批和测试证据失效；未完成写入可具名回滚');
  if (!rollback && (!task.acceptance || task.acceptance.revision !== task.cardRevision || task.acceptance.sourceHash !== hash
    || task.acceptance.policyHash !== task.approval?.policyHash || task.acceptance.logHash !== task.check?.logHash))
    throw new Error('请先由产品验收当前代码版本');
  if (!rollback && (task.check?.code !== 0 || task.check.sourceHash !== hash || task.check.policyHash !== task.approval?.policyHash
    || sha256(await fs.readFile(task.check.log)) !== task.check.logHash)) throw new Error("当前单测证据无效，请重新验证");
  if (!rollback && !recovery) await reviewedTaskFacts(project, task, config!);
  return applyFiles(project, task, actor.id, rollback ? 'rollback' : 'apply', recovery, rollback ? null : async completed => {
    try { await promoteTaskFacts(project, completed, config!, actor.id); }
    catch (error: any) {
      await record(project, id, actor.id, 'project_facts_publication_failed', { failure: '代码已应用，但项目知识更新失败：' + error.message });
      throw error;
    }
  });
  });
}

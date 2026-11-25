import { promises as fs } from 'node:fs';
import { projectManifest, projectSourceView } from './project-sources.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pi } from './pi.js';
import { settings } from './projects.js';
import { initializationBudget } from './initialization-settings.js';
import { acquireFileLock, lockedByAnotherProcess } from './file-lock.js';
import { initializeProjectMap, historicalInitialization, taskProjectContext } from './project-context.js';
import { currentKnowledge, publishProjectKnowledge, checkedReview } from './project-knowledge.js';
import { sourceMaterial, conciseKnowledge, evidenceMaterial } from './knowledge-sources.js';
import type { ReviewedModule } from './project-knowledge.js';
import { manifest, manifestHash, copyFiles, sha256, safeId, writeAtomic } from '../src/files.js';
import type { KnowledgeCatalog, KnowledgeModule, KnowledgeReview } from './knowledge-schema.js';
import { catalogSchema, moduleSubmissionSchema, knowledgeReviewSchema, validateKnowledge } from './knowledge-schema.js';
import type { Project, Principal, Settings, Usage } from './types.js';

export type KnowledgeJob = { id: string; actor: string; scope: string; state: 'running' | 'attention' | 'complete';
  version: number; at: string; updatedAt: string; workspace: string; sourceHash: string; config: Settings; usage: Usage;
  session: string | null; reviewSession: string | null; stageSessions: Record<string, string>; catalog: KnowledgeCatalog | null; previousCatalog: KnowledgeCatalog | null; failure: string | null;
  modules: Record<string, { content: KnowledgeModule | null; review: KnowledgeReview | null; cycles: number; reviewSession: string | null; reviewJobId: string | null; amendments: ReviewedModule['amendments'] }>;
  published: string | null };
type Run = { controller: AbortController; main: Pi | null; review: Pi | null; stages: { main: string | null; review: string | null }; progress: string; done: Promise<void> };
const active = new Map<string, Run>();
export const knowledgeHome = (project: Project, id: string) => path.join(project.archive, 'project-knowledge/jobs', safeId(id));
const executionFile = (project: Project) => path.join(project.archive, 'knowledge-execution.lock');
export async function readKnowledgeJob(project: Project, id: string): Promise<KnowledgeJob> {
  return decodeJob(await fs.readFile(path.join(knowledgeHome(project, id), 'events.jsonl'), 'utf8')).job;
}
function decodeJob(text: string): { job: KnowledgeJob; head: string } {
  const rows = text.trim().split('\n').map(s => JSON.parse(s));
  let previous = null;
  for (const row of rows) {
    if (row.previous !== previous || sha256(JSON.stringify({ ...row, hash: undefined })) !== row.hash) throw new Error('项目理解审计链损坏');
    previous = row.hash;
  }
  return { job: rows.at(-1).job, head: previous! };
}
async function record(project: Project, id: string, actor: string, type: string, update: Partial<KnowledgeJob>, detail: unknown = {}) {
  const file = path.join(knowledgeHome(project, id), 'events.jsonl');
  const release = acquireFileLock(file + '.lock', '项目理解正在保存，请稍后重试');
  try {
    const text = await fs.readFile(file, 'utf8'), { job: current, head } = decodeJob(text);
    const job = { ...current, ...update, version: current.version + 1, updatedAt: new Date().toISOString() };
    const event: any = { at: job.updatedAt, actor, type, detail, job, previous: head };
    event.hash = sha256(JSON.stringify(event)); await writeAtomic(file, text + JSON.stringify(event) + '\n'); return job;
  } finally { release(); }
}
function authorize(actor: Principal) {
  if (!actor.roles.some(role => ['admin', 'developer'].includes(role))) throw Object.assign(new Error('项目理解由研发或管理员执行'), { status: 403 });
}
export async function latestKnowledgeJob(project: Project) {
  let pointer: { id: string };
  try { pointer = JSON.parse(await fs.readFile(path.join(project.archive, 'project-knowledge/latest-job.json'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  const job = await readKnowledgeJob(project, pointer.id), run = active.get(knowledgeHome(project, job.id));
  const remote = !run && job.state === 'running' && lockedByAnotherProcess(executionFile(project));
  return { id: job.id, state: job.state, scope: job.scope, usage: job.usage, failure: job.failure, at: job.at,
    progress: run ? run.progress : remote ? '另一工作台实例正在执行项目理解' : job.state === 'running' ? '执行已中断，可从检查点继续' : job.state === 'complete' ? '本次范围已完成' : '需要处理',
    active: !!run || remote, targets: job.catalog === null ? [] : job.catalog.targets, completed: Object.entries(job.modules).filter(([, item]) => item.review !== null && !item.review.issues.length).map(([id]) => id) };
}

export async function startKnowledgeJob(project: Project, actor: Principal, scope: unknown) {
  authorize(actor);
  if (typeof scope !== 'string' || scope.trim().length < 5 || scope.length > 1200) throw new Error('请填写5至1200字的项目梳理范围');
  const release = acquireFileLock(executionFile(project), '本项目已有初始化执行，请先暂停或等待');
  try {
    const budget = await initializationBudget(project);
    if (budget === null) throw new Error('请先由管理员配置独立初始化预算，不能使用需求任务额度');
    const config = { ...await settings(project), budget }, index = await initializeProjectMap(project, config, actor.id);
    const inputRoot = await projectSourceView(project, config);
    const files = await projectManifest(project, config);
    const id = randomUUID(), home = knowledgeHome(project, id), workspace = path.join(home, 'workspace');
    await fs.mkdir(home, { recursive: true, mode: 0o700 }); await copyFiles(inputRoot, workspace, Object.keys(files));
    if (manifestHash(await manifest(workspace, config.excludedPaths, config.maxSnapshotBytes)) !== manifestHash(files)
      || manifestHash(await projectManifest(project, config)) !== manifestHash(files)) throw new Error('初始化准备期间源码改变，准备目录保留，请重试');
    const previous = await currentKnowledge(project, inputRoot, config), at = new Date().toISOString();
    const reuse = previous !== null && previous.scope === scope.trim();
    const modules: KnowledgeJob['modules'] = {};
    if (previous !== null) for (const item of previous.modules) if (item.state === 'verified') modules[item.content.id] = {
      content: item.content, review: item.review, cycles: 0, reviewSession: item.reviewSession, reviewJobId: item.jobId, amendments: item.amendments };
    const job: KnowledgeJob = { id, actor: actor.id, scope: scope.trim(), state: 'attention', version: 1, at, updatedAt: at, workspace,
      sourceHash: manifestHash(files), config, usage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknown: 0, reserved: 0 },
      session: null, reviewSession: null, stageSessions: {}, catalog: reuse ? previous.catalog : null, previousCatalog: previous === null ? null : previous.catalog, modules, failure: null, published: null };
    const event: any = { at, actor: actor.id, type: 'created', detail: { indexVersion: index.id, scope: job.scope, reused: Object.keys(modules) }, job, previous: null };
    event.hash = sha256(JSON.stringify(event)); await fs.writeFile(path.join(home, 'events.jsonl'), JSON.stringify(event) + '\n', { flag: 'wx', mode: 0o600 });
    await writeAtomic(path.join(project.archive, 'project-knowledge/latest-job.json'), JSON.stringify({ id }));
    await runKnowledgeJob(project, id, actor, release); return { id };
  } catch (error) { release(); throw error; }
}

async function call(project: Project, id: string, run: Run, mode: 'catalog' | 'module' | 'knowledge-review', prompt: string, material: unknown) {
  run.controller.signal.throwIfAborted();
  const slot = mode === 'knowledge-review' ? 'review' : 'main', role = mode === 'knowledge-review' ? 'review' : 'development';
  let job = await readKnowledgeJob(project, id);
  const name = mode === 'module' ? 'module:' + (material as any).expectedModuleId : mode === 'knowledge-review' ? 'review:' + (material as any).module.id : 'catalog';
  const schema = mode === 'module' ? moduleSubmissionSchema : mode === 'catalog' ? catalogSchema : knowledgeReviewSchema;
  const policy = { readTurns: mode === 'module' ? 2 : 0 };
  const stage = name + ':' + sha256(JSON.stringify({ material, schema, policy })).slice(0, 12);
  const rows = (await fs.readFile(path.join(knowledgeHome(project, id), 'events.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  const sessionFile = Object.hasOwn(job.stageSessions, stage) ? job.stageSessions[stage] : null;
  let effectivePrompt = prompt;
  if (sessionFile !== null) {
    const history = (await fs.readFile(sessionFile, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    const interrupted = rows.findLast(row => row.type === 'interrupted');
    if (!history.some(entry => entry.type === 'compaction')) effectivePrompt = `继续当前${stage}阶段。源码快照和上一轮完整材料均未改变，沿用已提供的范围与证据，不重复调查。${interrupted ? '上次错误：' + interrupted.job.failure : '沿用本阶段检查点'}。按当前工具提交结果；证据不足的部分明确保留未知，不虚构成功。`;
  }
  await record(project, id, 'system:context', 'knowledge_context_prepared', {}, { stage, policy, bytes: Buffer.byteLength(effectivePrompt), hash: sha256(prompt), reusedNativeContext: effectivePrompt !== prompt });
  if (run[slot] && run.stages[slot] !== stage) { run[slot]!.stop(); run[slot] = null; }
  if (!run[slot]) {
    run.stages[slot] = stage;
    run[slot] = new Pi(async event => {
      if (event.type === 'usage') await record(project, id, 'system:meter', 'model_request', { usage: event.usage }, { request: event.request, stage: event.stage, role: event.role, provider: event.provider, model: event.model });
      if (event.type === 'session_persisted') {
        const current = await readKnowledgeJob(project, id);
        await record(project, id, 'system:pi', 'session_opened', { ...(slot === 'main' ? { session: event.session } : { reviewSession: event.session }), stageSessions: { ...current.stageSessions, [stage]: event.session } });
      }
      if (event.type === 'tool') run.progress = `项目梳理正在使用 ${event.name}`;
    });
    const session = Object.hasOwn(job.stageSessions, stage) ? job.stageSessions[stage] : null;
    await run[slot]!.open(project, { ...job, session, reviewSession: session }, job.config, slot === 'review', knowledgeHome(project, id));
  }
  run.controller.signal.throwIfAborted(); job = await readKnowledgeJob(project, id);
  const result = await run[slot]!.run(job, role, effectivePrompt, [], mode, material); run.controller.signal.throwIfAborted();
  if (result.reported?.kind !== mode) throw new Error('本阶段未提交有效的项目理解材料');
  return result.reported.value;
}

async function publish(project: Project, job: KnowledgeJob) {
  if (manifestHash(await projectManifest(project, job.config)) !== job.sourceHash)
    throw new Error('原项目源码已变化，已保留梳理检查点；请按当前源码新建梳理，不发布旧快照为当前知识');
  const modules = Object.values(job.modules).filter(item => item.content !== null && item.review !== null && !item.review.issues.length);
  if (!job.catalog || !modules.length) throw new Error('没有可发布的已核对项目理解');
  const version = await publishProjectKnowledge(project, { actor: job.actor, scope: job.scope, sourceHash: job.sourceHash,
    catalog: job.catalog, validationChecks: job.config.unitChecks, modules: modules.map(item => {
      if (!item.reviewSession || !item.reviewJobId) throw new Error('模块审核来源缺失');
      return { content: item.content!, review: item.review!, jobId: item.reviewJobId, reviewSession: item.reviewSession, amendments: item.amendments };
    }) });
  return record(project, job.id, job.actor, 'knowledge_published', { published: version.id }, { version: version.id, modules: version.modules.map(m => m.content.id) });
}
async function execute(project: Project, id: string, run: Run) {
  let job = await readKnowledgeJob(project, id);
  for (const item of Object.values(job.modules)) if (item.review !== null) validateKnowledge(knowledgeReviewSchema, item.review);
  const files = await manifest(job.workspace, job.config.excludedPaths, job.config.maxSnapshotBytes);
  if (manifestHash(files) !== job.sourceHash) throw new Error('初始化工作区已被修改，不能复用当前梳理');
  if (job.catalog === null) {
    const rows = (await fs.readFile(path.join(knowledgeHome(project, id), 'events.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
    const catalogBlocks = rows.filter(row => row.type === 'catalog_review_blocked');
    if (catalogBlocks.length > job.config.budget.repairCycles) throw new Error('目录知识纠正额度已用尽');
    const catalogIssues = catalogBlocks.length ? catalogBlocks.at(-1).detail.issues : [];
    run.progress = '建立业务能力、术语和模块目录';
    const index = await taskProjectContext(project, job.workspace, job.config, job.scope);
    const history = await historicalInitialization(project);
    const candidates = [...new Set([...index.selected, ...Object.keys(files).filter(file => /(?:package.json|README|\/main\.|Controller.java)/.test(file))])].slice(0, 16);
    const source = await sourceMaterial(job.workspace, files, Object.values(job.stageSessions), candidates, job.scope, 7000);
    const catalog = await call(project, id, run, 'catalog',
      `本阶段仅对提供的入口证据建立简短业务目录，直接report_project_catalog，不调查具体实现。范围：${job.scope}。summary不超过150字，词汇通常4至6项，aliases可包含原文出现的重要符号。模块按业务职责划分，targets仅包含本次范围；未覆盖内容写outsideScope，不假装已理解。已有编号和职责保留；需要修订的已有模块列入targets。纠正目录时保持原targets，仅处理目录审核问题，不改变已授权范围。每项evidence只提交真实file/start/end，程序保存原文和哈希；不提交quote/hash/content/spanHash。依据不足的能力留待梳理。\n已有目录：${conciseKnowledge(job.previousCatalog)}\n目录审核反馈：${JSON.stringify(catalogIssues)}\n当前入口候选：${candidates.join('\n')}\n可引用的当前源码：\n${source}\n历史概览仅作线索：${JSON.stringify(history === null ? null : history.documents.map(doc => ({ name: doc.name, excerpt: doc.text.slice(0, 450) })))}`, { files, existingCatalog: job.previousCatalog, reviewIssues: catalogIssues });
    const modules = { ...job.modules };
    if (catalogBlocks.length) {
      if (job.previousCatalog === null || JSON.stringify([...catalog.targets].sort()) !== JSON.stringify([...job.previousCatalog.targets].sort()))
        throw new Error('目录纠正不能改变本次已授权模块范围');
      for (const moduleId of catalog.targets) {
        const item = modules[moduleId]; if (item === undefined) continue;
        const issues = item.review === null ? [] : item.review.issues.filter(issue => issue.scope === 'module');
        modules[moduleId] = { ...item, content: issues.length ? null : item.content,
          review: issues.length ? { ...item.review!, issues } : null, reviewSession: null, reviewJobId: null };
      }
    }
    for (const entry of catalog.modules) {
      const previous = job.previousCatalog?.modules.find(m => m.id === entry.id);
      if (previous && (previous.name !== entry.name || previous.purpose !== entry.purpose)) {
        const current = modules[entry.id];
        const pending = current !== undefined && current.review !== null && current.review.issues.length ? current.review : null;
        modules[entry.id] = { content: null, review: pending, cycles: current === undefined ? 0 : current.cycles,
          reviewSession: null, reviewJobId: null, amendments: [] };
      }
    }
    job = await record(project, id, 'pi:development', 'catalog_recorded', { catalog, modules });
  }
  for (const moduleId of job.catalog!.targets) {
    run.controller.signal.throwIfAborted(); job = await readKnowledgeJob(project, id);
    let item = job.modules[moduleId];
    if (item?.review !== null && item?.review && !item.review.issues.length) continue;
    if (item?.review?.issues.length && item.cycles >= job.config.budget.repairCycles) throw new Error('模块知识纠正额度已用尽：' + moduleId);
    if (!item || item.content === null) {
      const entry = job.catalog!.modules.find(m => m.id === moduleId)!;
      run.progress = '梳理模块：' + entry.name;
      const previousSessions = Object.entries(job.stageSessions).filter(([key]) => key.split(':').slice(0, 2).join(':') === 'module:' + moduleId).map(([, file]) => file).reverse();
      let draft: Record<string, unknown> | null = null;
      for (const previousSession of previousSessions) {
        const history = (await fs.readFile(previousSession, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
        const calls = history.flatMap(row => row.message?.role === 'assistant' ? row.message.content.filter((part: any) => part.type === 'toolCall' && part.name === 'report_project_module') : []);
        if (calls.length) { draft = calls.at(-1).arguments; break; }
      }
      const source = await sourceMaterial(job.workspace, files, Object.values(job.stageSessions), entry.entryFiles,
        entry.name + ' ' + entry.purpose + ' ' + job.catalog!.vocabulary.filter(v => v.modules.includes(moduleId)).flatMap(v => [v.term, ...v.aliases]).join(' '), draft === null ? 9000 : 2500);
      const directory = JSON.stringify(job.catalog!.modules.map(module => ({ id: module.id, name: module.name })));
      const evidenceRule = '提交仅包含facts、flows、validation和unknowns；当前模块编号由执行阶段绑定，不提交根级id。每项evidence只提交file、start、end；程序从当前快照读取完整原文并绑定哈希，不提交quote/hash/content/spanHash。证据范围须足以支撑结论。';
      const content = await call(project, id, run, 'module', evidenceRule + '最多两轮成批读取，然后仅可提交资料。优先纠正已有草稿，不重做调查；未覆盖的事实或行为留在unknowns，不虚构结论。\n' +
        `只读完整梳理本模块 ${moduleId}：${conciseKnowledge(entry)}。只研究本模块。优先复用下面按当前快照核对的已读源码片段；仅在某项必要结论缺证据时合批读取对应方法和测试。记录职责、关键状态、必保规则（facts通常4至6项）、1至2条真实行为链路flows、现有验证接入方式validation及unknowns，完成定位即report_project_module，不重做全局调查。区分打开窗口与实际保存等动作。business事实用业务语言；实现细节为engineering。dependsOn/relatedModules只能引用业务模块编号，不是事实编号；可选模块编号：${directory}。命令声明不代表运行成功；缺测试、外部环境未知据实记录，不搭框架。证据给出最小但能支持结论的源码行范围。\n上次草稿（不是已审核资料；按本轮契约与审核意见纠正后重新提交，缺证据才读取，不重复全局调查）：${draft === null ? 'null' : conciseKnowledge({ ...draft, id: undefined })}\n复用的源码（仅所列范围）：\n${source}\n前次审核反馈：${JSON.stringify(item?.review?.issues ?? null)}`, { files, catalog: job.catalog, expectedModuleId: moduleId, reviewIssues: item?.review?.issues ?? null });
      if (content.id !== moduleId) throw new Error('提交了非当前目标模块');
      item = { content, review: null, cycles: item?.review?.issues.length ? item.cycles + 1 : item ? item.cycles : 0, reviewSession: null, reviewJobId: null, amendments: [] };
      job = await record(project, id, 'pi:development', 'module_recorded', { modules: { ...job.modules, [moduleId]: item } });
    }
    run.progress = '独立核对业务关系与证据：' + moduleId;
    const reviewCatalog = { summary: job.catalog!.summary, summaryEvidence: job.catalog!.summaryEvidence,
      modules: job.catalog!.modules, vocabulary: job.catalog!.vocabulary };
    const reviewInput = conciseKnowledge({ catalog: reviewCatalog, module: item.content });
    const related = new Set([moduleId, ...item.content!.facts.flatMap(fact => fact.dependsOn), ...item.content!.flows.flatMap(flow => flow.relatedModules)]);
    const proofs = evidenceMaterial({ catalog: { ...reviewCatalog, modules: reviewCatalog.modules.filter(module => related.has(module.id)),
      vocabulary: reviewCatalog.vocabulary.filter(term => term.modules.some(id => related.has(id))) }, module: item.content }, 30000);
    if (Buffer.byteLength(reviewInput) > 120000) throw new Error('模块知识材料过大，请缩小梳理范围；已保留原文');
    const result = await call(project, id, run, 'knowledge-review', '本阶段只依据下面集中提供的当前源码证据核对候选资料，没有调查工具。完整模块目录用于解析跨模块引用，未附其他模块事实不代表模块不存在。模块审核范围为当前模块、其目录条目和依赖关系。全局summary须以其summaryEvidence单独核对，不要求当前模块事实证明摘要中全部能力；摘要本身的错误或证据不足仍须报告。立即提交report_project_knowledge_review；只阻断会误导后续研发的确定性错误或肯定结论缺少必要证据。不为措辞偏好、补充范围外业务或已明确列入unknowns的未覆盖项阻断；不能把未覆盖项说成已验证。\n' +
      `独立核对项目理解，禁止沿用梳理者自评。核对目录相关描述、每条事实与行为链路是否被提供的源码支持，证据范围是否足够，是否混淆声明与真实验证。肯定结论缺少必要证据时指出具体缺口；未验证外部条件或范围外能力保留unknowns，不编造成功。提交report_project_knowledge_review，checkedFacts/checkedFlows覆盖全部编号与链路名称，catalogReviewed=true；有阻断写issues，否则空数组。每项scope必须明确：catalog用于目录摘要或相关模块目录定义错误；module用于当前模块事实、链路、验证或证据错误。不得仅因当前模块未覆盖全局摘要中的其他业务就误报，但须核对摘要自己的证据。程序将按scope交回相应阶段纠正。\n当前源码证据：\n${proofs}\n候选材料JSON：\n${reviewInput}`, { module: item.content, catalog: reviewCatalog });
    const review = checkedReview(result, item.content!), latest = await readKnowledgeJob(project, id);
    item = { ...item, review, reviewSession: latest.reviewSession, reviewJobId: job.id };
    const catalogIssues = review.issues.filter(issue => issue.scope === 'catalog');
    if (catalogIssues.length) {
      await record(project, id, 'pi:review', 'catalog_review_blocked', { catalog: null, previousCatalog: latest.catalog,
        modules: { ...latest.modules, [moduleId]: item } }, { moduleId, issues: catalogIssues });
      return execute(project, id, run);
    }
    if (review.issues.length) {
      item.content = null;
      await record(project, id, 'pi:review', 'knowledge_review_blocked', { modules: { ...latest.modules, [moduleId]: item } }, { issues: review.issues });
      return execute(project, id, run);
    }
    job = await record(project, id, 'pi:review', 'knowledge_review_completed', { modules: { ...latest.modules, [moduleId]: item } });
    await publish(project, job);
  }
  job = await readKnowledgeJob(project, id);
  if (!job.published) job = await publish(project, job);
  await record(project, id, job.actor, 'completed', { state: 'complete', failure: null });
}

export async function resumeKnowledgeJob(project: Project, id: string, actor: Principal) {
  authorize(actor);
  const release = acquireFileLock(executionFile(project), '项目理解正在执行');
  try { return await runKnowledgeJob(project, id, actor, release); }
  catch (error) { release(); throw error; }
}
async function runKnowledgeJob(project: Project, id: string, actor: Principal, release: () => void) {
  const key = knowledgeHome(project, id);
  const budget = await initializationBudget(project);
  if (budget === null) throw new Error('请先由管理员配置独立初始化预算，不能使用需求任务额度');
  const job = await readKnowledgeJob(project, id), config = { ...await settings(project), budget };
  if (job.state === 'complete') throw new Error('本次项目理解已完成，请对变化范围新建梳理');
  for (const name of ['excludedPaths', 'runtimeDependencies', 'maxSnapshotBytes'] as const)
    if (JSON.stringify(config[name]) !== JSON.stringify(job.config[name])) throw new Error('源码快照策略已变化，请新建梳理');
  if (job.usage.requests >= config.budget.requests || job.usage.input + job.usage.output + job.usage.cacheRead + job.usage.cacheWrite + job.usage.reserved >= config.budget.tokens)
    throw new Error('当前预算已耗尽，累计用量保留；调整项目预算后才能继续');
  if (manifestHash(await projectManifest(project, config)) !== job.sourceHash) throw new Error('项目源码已改变，请针对当前源码新建梳理；旧检查点保留');
  await record(project, id, actor.id, 'resumed', { state: 'running', failure: null, config }, { cumulativeUsage: job.usage });
  const run: Run = { controller: new AbortController(), main: null, review: null, stages: { main: null, review: null }, progress: '准备项目理解', done: Promise.resolve() };
  active.set(key, run);
  const timeout = setTimeout(() => { run.controller.abort(new Error('项目梳理执行时限已到')); run.main?.pause(); run.review?.pause(); }, config.budget.runMs);
  run.done = (async () => {
    try { await execute(project, id, run); }
    catch (error: any) { await record(project, id, actor.id, 'interrupted', { state: 'attention', failure: error.message }); }
    finally { clearTimeout(timeout); run.main?.stop(); run.review?.stop(); active.delete(key); release(); }
  })();
  return { id, started: true };
}
export async function pauseKnowledgeJob(project: Project, id: string, actor: Principal) {
  authorize(actor); const run = active.get(knowledgeHome(project, id));
  if (!run && lockedByAnotherProcess(executionFile(project))) throw new Error('请在启动项目理解的工作台实例暂停执行');
  if (!run) throw new Error('项目理解没有正在运行的执行');
  run.controller.abort(new Error('用户暂停项目梳理，检查点和用量保留')); run.main?.pause(); run.review?.pause();
  await run.done; return { paused: true };
}
export async function shutdownKnowledgeJobs() {
  for (const run of active.values()) { run.controller.abort(new Error('服务停止，项目理解检查点保留')); run.main?.pause(); run.review?.pause(); }
  await Promise.all([...active.values()].map(run => run.done));
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeId, sha256, writeAtomic, manifest, manifestHash, copyFiles } from "../src/files.js";
import { saveValidatedImages, validateImages, assertImageModel, readImages } from "./images.js";
import { projectManifest, projectSourceView, sourceDependency } from './project-sources.js';
import { acquireFileLock, lockedByAnotherProcess, ownsFileLock } from './file-lock.js';
import type { Task, Project, Settings, Principal, CodeReviewRecord, ImportedCodeReview, Check, Issue } from "./types.js";

export type RepairAction = { stage: 'needed' | 'started' | 'returned'; check: Check; issues: Issue[]; snapshot: string | null };

export const directory = (project: Project, id: string) => path.join(project.archive, "delivery", safeId(id));
export function executingElsewhere(project: Project, id: string) {
  const home = directory(project, id), execution = path.join(home, 'execution.lock');
  return !ownsFileLock(execution) && (lockedByAnotherProcess(execution) || lockedByAnotherProcess(path.join(home, 'unit-execution.lock')));
}
const locks = new Set<string>();
export async function locked<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (locks.has(key)) throw new Error("任务正在保存，请稍后重试");
  locks.add(key); try { return await action(); } finally { locks.delete(key); }
}
export async function readTask(project: Project, id: string): Promise<Task> {
  return (await readTaskRecord(project, id)).task;
}
export async function readTaskRecord(project: Project, id: string) {
  const text = await fs.readFile(path.join(directory(project, id), "events.jsonl"), "utf8").catch(error => {
    if (error.code === 'ENOENT') throw Object.assign(new Error('该项目中不存在此需求'), { status: 404 });
    throw error;
  });
  return decodeTask(text);
}
function decodeTask(text: string) {
  const rows = text.trim().split("\n").map(s => JSON.parse(s));
  let previous = null, developmentStarted = false, review: CodeReviewRecord | null = null;
  let importedReview: ImportedCodeReview | null = null;
  let repair: RepairAction | null = null;
  for (const row of rows) {
    if (row.previous !== previous || sha256(JSON.stringify({ ...row, hash: undefined })) !== row.hash) throw new Error("任务审计链损坏");
    previous = row.hash;
    if (row.type === 'approved') developmentStarted = true;
    if (row.type === 'development_reverted') developmentStarted = false;
    if (row.type === 'review_completed' && row.detail.report) review = row.detail;
    if (row.type === 'isolated_implementation_imported') importedReview = row.detail;
    if (['development_reverted', 'card_edited', 'card_proposed', 'requirement_confirmed', 'business_rejected', 'ready'].includes(row.type)
      || row.type === 'approved' && repair && row.task.approval.policyHash !== repair.check.policyHash) repair = null;
    if (row.type === 'unit_completed' && row.task.check.code !== 0 && repair?.check.sourceHash !== row.task.check.sourceHash)
      repair = { stage: 'needed', check: row.task.check, issues: [], snapshot: null };
    if (row.type === 'review_completed') repair = row.detail.outcome === 'changes_requested'
      ? { stage: 'needed', check: row.task.check, issues: row.task.issues, snapshot: null } : null;
    if (row.type === 'repair_started' || row.type === 'repair_resumed')
      repair = { stage: 'started', check: row.task.check, issues: row.task.check.code === 0 ? row.task.issues : [],
        snapshot: row.detail.snapshot ?? null };
    if (row.type === 'repair_completed' && repair) repair.stage = 'returned';
  }
  const task = rows.at(-1).task;
  for (const name of ['developer', 'confirmation', 'acceptance', 'feedback', 'implementation',
    'clarification', 'clarificationRound', 'pendingDecisions', 'images', 'modelDecisions', 'sources', 'application'])
    if (!Object.hasOwn(task, name)) throw new Error('旧需求记录不符合当前契约，请清理后重新创建');
  return { task, head: previous!, developmentStarted, importedReview, repair,
    review: review === null ? null : { ...review, current: review.sourceHash === task.sourceHash && review.logHash === task.check?.logHash
      && review.requirementRevision === task.cardRevision && review.policyHash === task.check?.policyHash } };
}
export function access(task: Pick<Task, 'owner' | 'developer'>, principal: Principal) {
  const admin = principal.roles.includes('admin');
  const product = admin || task.owner === principal.id && principal.roles.includes('product');
  const development = admin || task.developer === principal.id && principal.roles.includes('developer');
  return { view: admin || product || development, product, development };
}
export function own(task: Task, principal: Principal, responsibility: 'view' | 'product' | 'development' = 'view') {
  if (!access(task, principal)[responsibility]) throw Object.assign(new Error(responsibility === 'product'
    ? '请由本任务产品负责人操作' : responsibility === 'development' ? '请由本任务研发负责人操作' : '无权查看该任务'), { status: 403 });
  if (task.deletion) throw Object.assign(new Error('需求已由管理员删除，审计记录保留'), { status: 410 });
}
export function assertTaskEditable(task: Task) {
  if (task.deletion) throw Object.assign(new Error('需求已由管理员删除，审计记录保留'), { status: 410 });
  if (task.application?.phase === 'pending') throw new Error('代码写入尚未完成，请先具名恢复或回滚，不能改变本次需求与执行现场');
}
export async function record(project: Project, id: string, actor: string, type: string, update: Partial<Task>, detail: unknown = {}) {
  const file = path.join(directory(project, id), "events.jsonl");
  const release = acquireFileLock(file + '.lock', '任务正在保存，请稍后重试');
  try {
    const text = await fs.readFile(file, "utf8");
    const { task: current, head } = decodeTask(text);
    const task = { ...current, ...update, version: current.version + 1, updatedAt: new Date().toISOString() };
    const event: any = { at: task.updatedAt, actor, type, detail, task, previous: head };
    event.hash = sha256(JSON.stringify(event));
    await writeAtomic(file, text + JSON.stringify(event) + "\n");
    return task;
  } finally { release(); }
}
export async function saveImplementation(project: Project, id: string, actor: string, requirementRevision: number, revision: number | null, content: string) {
  const task = await readTask(project, id);
  assertTaskEditable(task);
  if (task.state === 'done') throw new Error('已完成任务的研发说明只读');
  if (requirementRevision !== task.cardRevision || revision !== (task.implementation === null ? null : task.implementation.revision))
    throw new Error('产品需求或研发说明已更新，请刷新后确认对应版本');
  if (typeof content !== 'string' || content.trim().length < 10 || content.length > 6000) throw new Error('研发说明应为10至6000字');
  return record(project, id, actor, 'implementation_recorded', { implementation: { content: content.trim(),
    revision: task.implementation === null ? 1 : task.implementation.revision + 1, requirementRevision, actor, at: new Date().toISOString() } });
}
export async function createTask(project: Project, actor: Principal, title: string, request: string, settings: Settings, images: unknown = []) {
  if (!actor.roles.some(role => ['admin', 'product'].includes(role))) throw Object.assign(new Error('需求由产品角色创建'), { status: 403 });
  if (typeof title !== "string" || typeof request !== "string" || !title.trim() || !request.trim() || title.length > 160 || request.length > 30000) throw new Error("请填写有效标题与需求");
  const validatedImages = validateImages(images);
  if (validatedImages.length) assertImageModel(settings, 'requirement');
  const id = randomUUID(); const destination = directory(project, id);
  const home = path.join(project.archive, "delivery-preparing", id); const at = new Date().toISOString();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const before = await projectManifest(project, settings), sourceView = await projectSourceView(project, settings);
  const baseline = path.join(home, "baseline"); const workspace = path.join(home, "workspace");
  await copyFiles(sourceView, baseline, Object.keys(before));
  await copyFiles(sourceView, workspace, Object.keys(before));
  for (const copy of [baseline, workspace])
    if (manifestHash(await manifest(copy, settings.excludedPaths, settings.maxSnapshotBytes)) !== manifestHash(before))
      throw new Error("快照期间源码改变，未创建可执行任务；准备目录保留供核对");
  if (manifestHash(await projectManifest(project, settings)) !== manifestHash(before)) throw new Error('快照采集期间任一源码来源改变，未创建任务');
  for (const dependency of settings.runtimeDependencies) {
    const target = await sourceDependency(project, dependency);
    const link = path.join(workspace, dependency); await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link);
  }
  await fs.writeFile(path.join(home, "baseline.json"), JSON.stringify(before), { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify(settings), { flag: "wx", mode: 0o600 });
  const imageRecords = await saveValidatedImages(home, validatedImages, actor.id);
  const task: Task = { id, sources: structuredClone(project.sources), application: null, title: title.trim(), owner: actor.id, developer: null, confirmation: null, acceptance: null, feedback: null, implementation: null,
    state: "draft", version: 1, card: request.trim(), cardRevision: 1,
    approval: null, workspace: path.join(destination, "workspace"), createdAt: at, updatedAt: at, session: null, reviewSession: null, cycles: 0, issues: [],
    check: null, sourceHash: manifestHash(before), failure: null, appliedBy: null, appliedAt: null,
    clarification: null, clarificationRound: 0, pendingDecisions: [], images: imageRecords, modelDecisions: [],
    usage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknown: 0, reserved: 0 } };
  const event: any = { at, actor: actor.id, type: "created", detail: {}, task, previous: null };
  event.hash = sha256(JSON.stringify(event));
  await fs.writeFile(path.join(home, "events.jsonl"), JSON.stringify(event) + "\n", { flag: "wx", mode: 0o600 });
  if (imageRecords.length) {
    const imageEvent: any = { at, actor: actor.id, type: "image_attached", detail: { hashes: imageRecords.map(r => r.hash) },
      task: { ...task, images: imageRecords }, previous: event.hash };
    imageEvent.hash = sha256(JSON.stringify(imageEvent));
    await fs.appendFile(path.join(home, "events.jsonl"), JSON.stringify(imageEvent) + "\n", { mode: 0o600 });
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.rename(home, destination);
  return task;
}
export type TaskSummaryData = Pick<Task, 'id' | 'title' | 'owner' | 'developer' | 'state' | 'version' | 'updatedAt'> & {
  confirmed: boolean; approvedPolicyHash: string | null; hasQuestions: boolean; hasDecisions: boolean;
  applicationPending: boolean;
  deletion?: Task['deletion'];
};
async function auditStamp(file: string) {
  const stat = await fs.stat(file, { bigint: true });
  return sha256(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)));
}
async function indexTask(project: Project, id: string) {
  const home = directory(project, id), audit = path.join(home, 'events.jsonl');
  const stamp = await auditStamp(audit), { task, head } = decodeTask(await fs.readFile(audit, 'utf8'));
  if (stamp !== await auditStamp(audit)) throw new Error('建立摘要时需求已更新，请重新查询');
  const summary: TaskSummaryData = { id: task.id, title: task.title, owner: task.owner, developer: task.developer,
    state: task.state, version: task.version, updatedAt: task.updatedAt, deletion: task.deletion,
    confirmed: task.confirmation?.revision === task.cardRevision, approvedPolicyHash: task.approval === null ? null : task.approval.policyHash,
    hasQuestions: task.clarification?.answers === null, applicationPending: task.application?.phase === 'pending',
    hasDecisions: task.pendingDecisions.some(item => ['open', 'pending'].includes(item.resolution)) };
  const value = { schemaVersion: 4, stamp, head, summary };
  await writeAtomic(path.join(home, 'summary.json'), JSON.stringify({ ...value, hash: sha256(JSON.stringify(value)) }));
  return summary;
}
export async function listTaskSummaries(project: Project, actor: Principal) {
  const root = path.join(project.archive, "delivery");
  let entries: string[];
  try { entries = await fs.readdir(root); } catch (e: any) { if (e.code === "ENOENT") return { tasks: [], rebuilt: 0 }; throw e; }
  const tasks: TaskSummaryData[] = []; let rebuilt = 0;
  for (const id of entries) {
    const home = directory(project, id), stamp = await auditStamp(path.join(home, 'events.jsonl'));
    let value;
    try { value = JSON.parse(await fs.readFile(path.join(home, 'summary.json'), 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const valid = value?.schemaVersion === 4 && value.stamp === stamp && value.summary?.id === id
      && typeof value.head === 'string' && value.hash === sha256(JSON.stringify({ schemaVersion: value.schemaVersion, stamp: value.stamp, head: value.head, summary: value.summary }));
    const task = valid ? value.summary as TaskSummaryData : await indexTask(project, id);
    if (!valid) rebuilt++;
    if (!task.deletion && access(task, actor).view) tasks.push(task);
  }
  return { tasks, rebuilt };
}
export async function transcript(task: Task) {
  if (!task.session) return [];
  const rows = (await fs.readFile(task.session, "utf8")).trim().split("\n").map(s => JSON.parse(s));
  return rows.filter((e: any) => e.type === "message" && ["user", "assistant"].includes(e.message.role))
    .map((e: any) => ({ role: e.message.role, text: e.message.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") }))
    .filter((e: any) => e.text);
}

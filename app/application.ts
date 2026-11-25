import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, manifest, manifestHash, compareManifests, writeAtomic, safeId } from '../src/files.js';
import { directory, executingElsewhere, record, readTask, assertTaskEditable } from './tasks.js';
import { projectManifest, sourceFile, projectPolicy } from './project-sources.js';
import { settings as projectSettings } from './projects.js';
import type { Application, Project, Settings, Task } from './types.js';

type Entry = { hash: string; bytes: number; mode: number };
type PlannedFile = { file: string; sourceId: string; before: Entry | null; after: Entry | null };
type Plan = { id: string; taskId: string; sourceHash: string; policyHash: string; sources: Project['sources'];
  identities: Array<{ id: string; dev: string; ino: string }>; baseline: Record<string, Entry>;
  config: Pick<Settings, 'excludedPaths' | 'maxSnapshotBytes'>; files: PlannedFile[] };
type Lease = { nonce: string; pid: number; taskId: string | null; kind: 'application' | 'mutation' | 'snapshot'; at: string };
const heldLeases = new Set<string>();
const equal = (a: Entry | null, b: Entry | null) => a === null || b === null ? a === b
  : a.hash === b.hash && a.bytes === b.bytes && a.mode === b.mode;
const planHome = (project: Project, task: Task, id: string) => path.join(directory(project, task.id), 'applications', safeId(id));
const staging = (project: Project, plan: Plan, file: string, side: string) => path.join(path.dirname(sourceFile(project, file).target),
  `.reqflow-${plan.id}-${side}-${sha256(file).slice(0, 16)}.tmp`);
async function loadPlan(project: Project, task: Task) {
  const application = task.application;
  if (!application) throw new Error('本任务尚未开始应用，没有待恢复或回滚的变更');
  const bytes = await fs.readFile(path.join(planHome(project, task, application.planId), 'plan.json'));
  if (sha256(bytes) !== application.planHash) throw new Error('不可变写入计划已改变');
  const plan: Plan = JSON.parse(bytes.toString());
  if (plan.id !== application.planId || plan.taskId !== task.id || plan.sourceHash !== task.sourceHash
    || JSON.stringify(plan.sources) !== JSON.stringify(task.sources)) throw new Error('写入计划与当前需求或来源不符');
  return plan;
}
async function identities(project: Project) {
  return Promise.all(project.sources.map(async source => {
    if (await fs.realpath(source.directory) !== source.directory) throw new Error('源码目录身份已改变');
    const stat = await fs.stat(source.directory, { bigint: true });
    if (!stat.isDirectory()) throw new Error('源码来源不再是目录');
    return { id: source.id, dev: String(stat.dev), ino: String(stat.ino) };
  }));
}
function live(lease: Lease) {
  if (!lease || !Number.isInteger(lease.pid) || lease.pid <= 0 || !/^[a-f0-9-]{36}$/.test(lease.nonce)) throw new Error('项目写入锁资料损坏');
  if (!['application', 'mutation', 'snapshot'].includes(lease.kind) || (lease.kind !== 'snapshot' && typeof lease.taskId !== 'string')) throw new Error('项目写入锁类型无效');
  if (lease.pid === process.pid) return heldLeases.has(lease.nonce);
  try { process.kill(lease.pid, 0); return true; }
  catch (error: any) { if (error.code === 'ESRCH') return false; throw error; }
}
async function acquire(project: Project, task: Pick<Task, 'id'> | null, recovery: boolean, kind: Lease['kind'] = 'application') {
  const home = path.join(project.archive, 'application-leases'), lock = path.join(project.archive, 'application.lock');
  await fs.mkdir(path.join(home, 'claims'), { recursive: true, mode: 0o700 });
  const lease: Lease = { nonce: randomUUID(), pid: process.pid, taskId: task === null ? null : task.id, kind, at: new Date().toISOString() };
  const file = path.join(home, lease.nonce + '.json'), handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(lease)); await handle.sync(); } finally { await handle.close(); }
  heldLeases.add(lease.nonce);
  try {
  try { await fs.link(file, lock); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const previous: Lease = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (live(previous)) throw new Error('项目已有写入操作，请核查对应需求的恢复状态');
    if (previous.kind === 'application') {
      const prior = await readTask(project, previous.taskId!);
      if (prior.application?.phase === 'pending' && (!recovery || previous.taskId !== task?.id)) throw new Error('项目存在未完成写入，请由对应负责人具名恢复或回滚');
    }
    let owner = previous;
    while (true) {
      const claim = path.join(home, 'claims', owner.nonce + '.json');
      try { await fs.link(file, claim); break; }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        owner = JSON.parse(await fs.readFile(claim, 'utf8'));
        if (live(owner)) throw new Error('另一具名操作正在恢复项目写入锁');
      }
    }
    if (JSON.parse(await fs.readFile(lock, 'utf8')).nonce !== previous.nonce) throw new Error('项目写入锁已变化，请重新核对');
    await fs.unlink(lock); await fs.link(file, lock);
  }
  return async () => {
    try {
      if (JSON.parse(await fs.readFile(lock, 'utf8')).nonce !== lease.nonce) throw new Error('项目写入锁归属已变化');
      await fs.unlink(lock);
    } finally { heldLeases.delete(lease.nonce); }
  };
  } catch (error) { heldLeases.delete(lease.nonce); throw error; }
}
async function actual(project: Project, file: string): Promise<Entry | null> {
  const { source, relative, target } = sourceFile(project, file);
  let parent = source.directory;
  for (const segment of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, segment);
    let stat;
    try { stat = await fs.lstat(parent); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('交付路径的父目录身份改变：' + file);
  }
  let stat;
  try { stat = await fs.lstat(target, { bigint: true }); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('交付目标不再是普通文件：' + file);
  const bytes = await fs.readFile(target), after = await fs.lstat(target, { bigint: true });
  if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs)
    throw new Error('读取期间交付目标发生变化：' + file);
  return { hash: sha256(bytes), bytes: bytes.length, mode: Number(stat.mode & 0o777n) };
}
async function makePlan(project: Project, task: Task, config: Settings) {
  const baseline = JSON.parse(await fs.readFile(path.join(directory(project, task.id), 'baseline.json'), 'utf8'));
  if (manifestHash(await projectManifest(project, config)) !== manifestHash(baseline)) throw new Error('任一源码来源已改变，未写入任何文件');
  const candidate = await manifest(task.workspace, config.excludedPaths, config.maxSnapshotBytes);
  if (manifestHash(candidate) !== task.sourceHash) throw new Error('候选代码已改变，不能应用旧验收版本');
  const id = randomUUID(), home = planHome(project, task, id);
  const files: PlannedFile[] = compareManifests(baseline, candidate).map(item => ({ ...item, sourceId: sourceFile(project, item.file).source.id }));
  files.sort((a, b) => project.sources.findIndex(source => source.id === a.sourceId) - project.sources.findIndex(source => source.id === b.sourceId)
    || a.file.localeCompare(b.file));
  const plan: Plan = { id, taskId: task.id, sourceHash: task.sourceHash!, policyHash: task.approval!.policyHash,
    sources: structuredClone(project.sources), identities: await identities(project), baseline,
    config: { excludedPaths: config.excludedPaths, maxSnapshotBytes: config.maxSnapshotBytes }, files };
  for (const item of files) for (const side of ['before', 'after'] as const) {
    const entry = item[side]; if (entry === null) continue;
    const source = side === 'before' ? path.join(directory(project, task.id), 'baseline') : task.workspace;
    const bytes = await fs.readFile(path.join(source, item.file));
    if (sha256(bytes) !== entry.hash) throw new Error('冻结写入内容时快照改变：' + item.file);
    const target = path.join(home, side, item.file); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeAtomic(target, bytes);
  }
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(plan); await writeAtomic(path.join(home, 'plan.json'), text);
  return { plan, application: { planId: id, planHash: sha256(text), direction: 'apply', phase: 'pending', total: files.length,
    written: [], reverted: [], pendingFile: null } as Application };
}
async function cleanStaging(project: Project, task: Task, plan: Plan, application: Application) {
  for (const item of plan.files) for (const side of ['before', 'after'] as const) {
    if (application.pendingFile !== item.file) continue;
    await actual(project, item.file);
    const file = staging(project, plan, item.file, side); let stat;
    try { stat = await fs.lstat(file); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || application.pendingFile !== item.file || side !== (application.direction === 'apply' ? 'after' : 'before') || item[side] === null)
      throw new Error('写入暂存文件与待核对意图不符：' + item.file);
    const expected = await fs.readFile(path.join(planHome(project, task, plan.id), side, item.file)), current = await fs.readFile(file);
    if (sha256(expected) !== item[side]!.hash || current.length > expected.length || !current.equals(expected.subarray(0, current.length)))
      throw new Error('写入暂存文件另有修改，未删除：' + item.file);
    await fs.unlink(file);
  }
}
async function writable(project: Project, file: string) {
  const { target, source } = sourceFile(project, file); let parent = path.dirname(target);
  while (true) {
    try { await fs.access(parent, constants.W_OK | constants.X_OK); return; }
    catch (error: any) {
      if (error.code !== 'ENOENT' || parent === source.directory) throw error;
      parent = path.dirname(parent);
    }
  }
}
async function preflight(project: Project, task: Task, plan: Plan, application: Application, direction: Application['direction']) {
  if (JSON.stringify(plan.sources) !== JSON.stringify(project.sources)) throw new Error('当前项目来源与冻结计划不符，未继续写入');
  if (JSON.stringify(await identities(project)) !== JSON.stringify(plan.identities)) throw new Error('源码目录身份已改变，未继续写入');
  await cleanStaging(project, task, plan, application);
  const state = structuredClone(application);
  if (state.pendingFile !== null) {
    const item = plan.files.find(item => item.file === state.pendingFile);
    if (!item) throw new Error('待核对文件不在不可变写入计划中');
    const current = await actual(project, item.file);
    if (state.direction === 'apply') {
      if (equal(current, item.after)) { if (!state.written.includes(item.file)) state.written.push(item.file); }
      else if (!equal(current, item.before)) throw new Error('待核对文件另有修改，不能恢复或回滚：' + item.file);
    } else {
      if (equal(current, item.before)) { if (!state.reverted.includes(item.file)) state.reverted.push(item.file); }
      else if (!equal(current, item.after)) throw new Error('回滚待核对文件另有修改：' + item.file);
    }
    state.pendingFile = null;
  }
  if (direction === 'apply') {
    const expected = { ...plan.baseline };
    for (const item of plan.files) if (state.written.includes(item.file)) {
      if (item.after === null) delete expected[item.file]; else expected[item.file] = item.after;
    }
    if (manifestHash(await projectManifest(project, plan.config)) !== manifestHash(expected)) throw new Error('任一来源存在并发修改，未继续写入');
    for (const item of plan.files) {
      if (!equal(await actual(project, item.file), state.written.includes(item.file) ? item.after : item.before))
        throw new Error('来源文件或目录发生冲突，未继续写入：' + item.file);
      if (!state.written.includes(item.file)) await writable(project, item.file);
    }
  } else for (const item of plan.files) if (state.written.includes(item.file) && !state.reverted.includes(item.file)) {
    if (!equal(await actual(project, item.file), item.after)) throw new Error('已应用文件另有修改，未回滚任何文件：' + item.file);
    await writable(project, item.file);
  }
  const side = direction === 'apply' ? 'after' : 'before';
  for (const item of plan.files) {
    const needed = direction === 'apply' ? !state.written.includes(item.file) : state.written.includes(item.file) && !state.reverted.includes(item.file);
    if (!needed || item[side] === null) continue;
    const bytes = await fs.readFile(path.join(planHome(project, task, plan.id), side, item.file));
    if (sha256(bytes) !== item[side]!.hash) throw new Error('冻结写入材料已改变：' + item.file);
  }
  state.direction = direction; return state;
}
async function projectOwner(project: Project) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(project.archive, 'application-pending.json'), 'utf8'));
    if (!value || typeof value.taskId !== 'string' || typeof value.planId !== 'string') throw new Error('项目写入归属资料无效');
    safeId(value.taskId); safeId(value.planId); return value as { taskId: string; planId: string };
  }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function applyFiles(project: Project, task: Task, actor: string, direction: Application['direction'], recovery: boolean,
  afterApply: ((completed: Task) => Promise<void>) | null) {
  const release = await acquire(project, task, recovery || direction === 'rollback');
  try {
    if (executingElsewhere(project, task.id))
      throw new Error('另一工作台实例正在执行该任务，请先在启动实例暂停');
    const requestedHash = task.sourceHash; task = await readTask(project, task.id);
    if (task.sourceHash !== requestedHash || direction === 'apply' && !recovery && task.state !== 'accepted') throw new Error('交付版本或阶段已改变');
    if (recovery && task.application?.phase !== 'pending') throw new Error('写入已由另一操作处理，请重新核对');
    const config = direction === 'apply' ? await projectSettings(project) : null;
    if (config !== null) {
      if (task.approval?.policyHash !== projectPolicy(project, config)) throw new Error('执行策略已改变，未继续写入；可具名回滚');
    }
    const owner = await projectOwner(project);
    if (owner !== null) {
      const owning = await readTask(project, owner.taskId);
      if (owning.application === null || owning.application.planId !== owner.planId) throw new Error('项目写入归属与需求计划不符，请核查');
      if (owning.application.phase === 'complete') await fs.unlink(path.join(project.archive, 'application-pending.json'));
      else if (owner.taskId !== task.id) throw new Error('项目另有未完成写入，请先由对应负责人处理');
    }
    let plan: Plan, initial: Application;
    if (direction === 'apply' && !recovery) {
      if (task.application?.phase === 'pending') throw new Error('已有未完成写入，请使用具名恢复或回滚');
      ({ plan, application: initial } = await makePlan(project, task, config!));
    } else {
      plan = await loadPlan(project, task); initial = task.application!;
      if (recovery && (initial.phase !== 'pending' || initial.direction !== direction)) throw new Error('恢复方向或阶段已改变');
      if (!recovery && direction === 'rollback' && initial.direction === 'rollback' && initial.phase === 'pending') throw new Error('回滚尚未完成，请使用继续回滚入口');
      if (direction === 'rollback' && initial.phase === 'complete' && initial.direction === 'rollback') throw new Error('本次写入已经回滚');
    }
    let state = await preflight(project, task, plan, initial, direction);
    state.phase = 'pending';
    await record(project, task.id, actor, recovery ? 'application_resumed' : direction === 'rollback' ? 'rollback_started' : 'application_started',
      { state: 'attention', application: state, failure: direction === 'apply' ? '代码应用正在进行，完成前请勿改变需求。' : '代码回滚正在进行，完成前请勿改变需求。' },
      { planId: plan.id, direction, planHash: state.planHash });
    const pointer = path.join(project.archive, 'application-pending.json');
    await writeAtomic(pointer, JSON.stringify({ taskId: task.id, planId: plan.id }));
    const completed = await writePlan(project, task, plan, state, actor, pointer);
    if (afterApply !== null) await afterApply(completed);
    return readTask(project, task.id);
  } finally { await release(); }
}
async function writePlan(project: Project, task: Task, plan: Plan, state: Application, actor: string, pointer: string) {
  const rollback = state.direction === 'rollback', side = rollback ? 'before' : 'after';
  try {
    for (const item of plan.files) {
      const needed = rollback ? state.written.includes(item.file) && !state.reverted.includes(item.file) : !state.written.includes(item.file);
      if (!needed) continue;
      if (JSON.stringify(await identities(project)) !== JSON.stringify(plan.identities)) throw new Error('写入期间源码目录身份改变');
      const expected = rollback ? item.after : item.before;
      if (!equal(await actual(project, item.file), expected)) throw new Error('写入前文件发生并发修改：' + item.file);
      state.pendingFile = item.file;
      await record(project, task.id, actor, 'application_file_writing', { application: state }, { file: item.file, rollback, planId: plan.id });
      const target = sourceFile(project, item.file).target, entry = item[side];
      const validateTarget = async () => {
        if (JSON.stringify(await identities(project)) !== JSON.stringify(plan.identities) || !equal(await actual(project, item.file), expected))
          throw new Error('实际发布前源码或目录发生并发修改：' + item.file);
      };
      await validateTarget();
      if (entry === null) { await validateTarget(); await fs.unlink(target); }
      else {
        const bytes = await fs.readFile(path.join(planHome(project, task, plan.id), side, item.file));
        if (sha256(bytes) !== entry.hash) throw new Error('冻结写入材料已改变：' + item.file);
        await writeAtomic(target, bytes, entry.mode, staging(project, plan, item.file, side), validateTarget);
      }
      if (!equal(await actual(project, item.file), entry)) throw new Error('写入结果与计划不符：' + item.file);
      (rollback ? state.reverted : state.written).push(item.file); state.pendingFile = null;
      await record(project, task.id, actor, 'application_file_written', { application: state }, { file: item.file, rollback, planId: plan.id });
    }
    if (!rollback && manifestHash(await projectManifest(project, plan.config)) !== plan.sourceHash) throw new Error('应用期间来源另有修改，整体尚未完成');
    state.phase = 'complete';
    await record(project, task.id, actor, rollback ? 'rolled_back' : 'application_completed', { application: state,
      state: rollback ? 'attention' : 'done', acceptance: rollback ? null : task.acceptance,
      appliedBy: rollback ? null : actor, appliedAt: rollback ? null : new Date().toISOString(),
      failure: rollback ? '本次实际应用的代码变更已具名回滚' : null });
  } catch (error: any) {
    state.phase = 'pending';
    await record(project, task.id, actor, 'application_failed', { application: state, state: 'attention',
      failure: `写入未完成：${error.message}。请核对已写入与待核对文件后，具名恢复或回滚。` });
    throw error;
  }
  try { await fs.unlink(pointer); }
  catch (error: any) {
    return record(project, task.id, actor, 'application_control_cleanup_failed', {
      failure: `代码${rollback ? '回滚' : '应用'}已完成，但项目写入标记清理失败：${error.message}；后续操作须核对该标记。` });
  }
  return readTask(project, task.id);
}
export async function applicationView(project: Project, task: Task) {
  if (task.application === null) return { application: null, version: task.version, files: [] };
  const plan = await loadPlan(project, task), state = task.application;
  return { application: state, version: task.version, sourceHash: plan.sourceHash, files: plan.files.map(item => ({ file: item.file, sourceId: item.sourceId,
    status: state.pendingFile === item.file ? 'pending' : state.reverted.includes(item.file) ? 'reverted'
      : state.written.includes(item.file) ? 'written' : 'waiting' })) };
}
export async function applicationRunning(project: Project, task: Task) {
  if (task.application?.phase !== 'pending') return false;
  let lease: Lease;
  try { lease = JSON.parse(await fs.readFile(path.join(project.archive, 'application.lock'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
  return lease.kind === 'application' && lease.taskId === task.id && live(lease);
}
export async function withTaskMutation<T>(project: Project, task: Task, action: () => Promise<T>) {
  assertTaskEditable(task);
  const release = await acquire(project, task, false, 'mutation');
  try {
    if (executingElsewhere(project, task.id))
      throw new Error('另一工作台实例正在执行该任务，请先在启动实例暂停');
    assertTaskEditable(await readTask(project, task.id)); return await action();
  }
  finally { await release(); }
}
export async function withSourceSnapshot<T>(project: Project, action: () => Promise<T>) {
  const release = await acquire(project, null, false, 'snapshot');
  try {
    const owner = await projectOwner(project);
    if (owner !== null) {
      const task = await readTask(project, owner.taskId);
      if (task.application?.phase !== 'complete' || task.application.planId !== owner.planId) throw new Error('项目有未完成写入，先恢复或回滚再采集新现场');
      await fs.unlink(path.join(project.archive, 'application-pending.json'));
    }
    return await action();
  } finally { await release(); }
}

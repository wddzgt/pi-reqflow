import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { manifest, manifestHash, sha256, writeAtomic } from '../src/files.js';
import { directory, record } from './tasks.js';
import { bindEvidence, readProjectKnowledge, publishProjectKnowledge } from './project-knowledge.js';
import { projectFactProposalSchema, projectFactReviewSchema, validateKnowledge } from './knowledge-schema.js';
import type { KnowledgeFact } from './knowledge-schema.js';
import type { Project, Settings, Task } from './types.js';
import { projectManifest } from './project-sources.js';

export type FactProposal = { moduleId: string; facts: KnowledgeFact[] };
export async function checkedFactProposal(value: unknown, root: string, config: Settings, catalog: { modules: { id: string }[] }) {
  const proposal = validateKnowledge<FactProposal>(projectFactProposalSchema, value), ids = catalog.modules.map(item => item.id);
  if (!ids.includes(proposal.moduleId) || proposal.facts.some(f => f.dependsOn.some(id => !ids.includes(id)))
    || new Set(proposal.facts.map(f => f.id)).size !== proposal.facts.length) throw new Error('项目事实建议的模块或事实编号无效');
  return bindEvidence(proposal, root, await manifest(root, config.excludedPaths, config.maxSnapshotBytes));
}
export async function saveFactProposal(project: Project, task: Task, proposal: FactProposal, config: Settings) {
  const bytes = JSON.stringify({ proposal, requirementRevision: task.cardRevision, sourceHash: manifestHash(await manifest(task.workspace, config.excludedPaths, config.maxSnapshotBytes)) });
  const file = path.join(directory(project, task.id), 'knowledge-proposals', randomUUID() + '.json');
  await writeAtomic(file, bytes);
  await record(project, task.id, 'pi:development', 'project_facts_proposed', {}, { file, hash: sha256(bytes) });
}
export async function taskFactProposal(project: Project, task: Task, config: Settings, requireCurrent = true) {
  const rows = (await fs.readFile(path.join(directory(project, task.id), 'events.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  const events = rows.filter(row => ['project_facts_proposed', 'project_facts_withdrawn'].includes(row.type));
  if (!events.length) return null;
  const expected = path.join(directory(project, task.id), 'knowledge-proposals') + path.sep;
  const latest = new Map<string, { proposal: FactProposal; hash: string; sourceHash: string; requirementRevision: number }>();
  for (const event of events) {
    if (event.type === 'project_facts_withdrawn') { latest.delete(event.detail.moduleId); continue; }
    if (!event.detail.file.startsWith(expected) || path.dirname(event.detail.file) + path.sep !== expected) throw new Error('项目事实建议位置无效');
    const bytes = await fs.readFile(event.detail.file);
    if (sha256(bytes) !== event.detail.hash) throw new Error('项目事实建议完整性校验失败');
    const value = JSON.parse(bytes.toString()); latest.set(value.proposal.moduleId, { ...value, hash: event.detail.hash });
  }
  const sourceHash = manifestHash(await manifest(task.workspace, config.excludedPaths, config.maxSnapshotBytes));
  const values = [...latest.values()];
  if (!values.length) return null;
  const current = values.every(value => value.sourceHash === sourceHash && value.requirementRevision === task.cardRevision);
  if (requireCurrent && !current) throw new Error('代码或需求在事实建议后已变化，请更新或具名撤回对应模块建议再审核');
  return { proposals: values.map(value => value.proposal), sourceHash, hash: sha256(JSON.stringify(values.map(value => value.hash))),
    current, keys: values.flatMap(value => value.proposal.facts.map(f => value.proposal.moduleId + '/' + f.id)) };
}
export function checkedFactReview(value: unknown, keys: string[]) {
  const review = validateKnowledge<{ checked: string[]; rejected: { id: string; reason: string }[] }>(projectFactReviewSchema, value);
  if (JSON.stringify([...review.checked].sort()) !== JSON.stringify([...keys].sort()) || review.rejected.some(item => !keys.includes(item.id))
    || new Set(review.rejected.map(item => item.id)).size !== review.rejected.length) throw new Error('项目事实审核没有覆盖本轮建议或包含无效编号');
  return review;
}

export async function reviewedTaskFacts(project: Project, task: Task, config: Settings) {
  const candidate = await taskFactProposal(project, task, config);
  if (candidate === null) return null;
  const rows = (await fs.readFile(path.join(directory(project, task.id), 'events.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  const event = rows.findLast(row => row.type === 'project_facts_reviewed' && row.detail.proposalHash === candidate.hash && row.detail.sourceHash === task.sourceHash);
  if (!event) throw new Error('项目事实缺少当前代码和建议版本的独立审核');
  return { candidate, review: checkedFactReview(event.detail.review, candidate.keys) };
}
export async function promoteTaskFacts(project: Project, task: Task, config: Settings, actor: string) {
  const reviewed = await reviewedTaskFacts(project, task, config);
  if (reviewed === null) return null;
  if (task.state !== 'done' || !task.acceptance || !task.reviewSession) throw new Error('项目事实只有在验收并应用后才能发布');
  if (manifestHash(await projectManifest(project, config)) !== task.sourceHash) throw new Error('项目源码与验收版本不符，不能更新知识');
  const { candidate, review } = reviewed, rejected = new Set(review.rejected.map(item => item.id));
  const previous = await readProjectKnowledge(project); if (previous === null) throw new Error('项目事实缺少基础项目理解');
  const modules = structuredClone(previous.modules); let accepted = 0;
  for (const proposal of candidate.proposals) {
    const module = modules.find(item => item.content.id === proposal.moduleId); if (!module) throw new Error('不能用事实更新替代未梳理模块的初始化');
    for (const fact of proposal.facts) if (!rejected.has(proposal.moduleId + '/' + fact.id)) {
      const index = module.content.facts.findIndex(item => item.id === fact.id);
      if (index < 0) module.content.facts.push(fact); else module.content.facts[index] = fact;
      accepted++;
    }
    module.review.checkedFacts = module.content.facts.map(fact => fact.id);
    module.amendments.push({ taskId: task.id, proposalHash: candidate.hash, sourceHash: task.sourceHash!,
      checked: review.checked.filter(key => key.startsWith(proposal.moduleId + '/')),
      accepted: review.checked.filter(key => key.startsWith(proposal.moduleId + '/') && !rejected.has(key)), reviewSession: task.reviewSession });
  }
  if (!accepted) return null;
  const version = await publishProjectKnowledge(project, { ...previous, actor, sourceHash: task.sourceHash!, modules });
  await record(project, task.id, actor, 'project_facts_promoted', {}, { version: version.id, accepted, proposalHash: candidate.hash });
  return version.id;
}

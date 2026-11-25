import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { manifest, manifestHash, sha256, writeAtomic } from '../src/files.js';
import { locked } from './tasks.js';
import { catalogSchema, moduleSchema, knowledgeReviewSchema, validateKnowledge } from './knowledge-schema.js';
import type { KnowledgeCatalog, KnowledgeModule, KnowledgeReview, SourceRef } from './knowledge-schema.js';
import type { Project, Settings, Role } from './types.js';

export type ReviewedModule = { content: KnowledgeModule; review: KnowledgeReview; jobId: string; reviewSession: string;
  amendments: Array<{ taskId: string; sourceHash: string; proposalHash: string; checked: string[]; accepted: string[]; reviewSession: string }> };
export type ProjectKnowledge = { schemaVersion: 2; id: string; parent: string | null; at: string; actor: string;
  sourceHash: string; scope: string; catalog: KnowledgeCatalog; modules: ReviewedModule[]; validationChecks: Settings['unitChecks'] };
export async function bindEvidence<T>(value: T, root: string, files: Record<string, { hash: string }>): Promise<T> {
  const bound = structuredClone(value);
  async function visit(item: any): Promise<void> {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (key !== 'evidence' && key !== 'summaryEvidence') { if (Array.isArray(child)) for (const entry of child) await visit(entry); else await visit(child); continue; }
      for (const reference of child as SourceRef[]) {
        if (!Object.hasOwn(files, reference.file)) throw new Error('证据不在允许的源码快照中：' + reference.file);
        const bytes = await fs.readFile(path.join(root, reference.file));
        if (sha256(bytes) !== files[reference.file].hash) throw new Error('源码在核对证据时发生变化：' + reference.file);
        const lines = bytes.toString().split('\n');
        if (reference.end < reference.start || reference.end > lines.length || reference.end - reference.start > 80)
          throw new Error(`证据范围不符：${reference.file}:${reference.start}-${reference.end}；文件共${lines.length}行，单段最多81行`);
        const content = lines.slice(reference.start - 1, reference.end).join('\n');
        if (content.trim().length < 8) throw new Error(`证据范围缺少有效源码：${reference.file}:${reference.start}-${reference.end}`);
        reference.hash = files[reference.file].hash;
        reference.content = content; reference.spanHash = sha256(content);
      }
    }
  }
  await visit(bound); return bound;
}
export async function checkedCatalog(value: unknown, root: string, files: Record<string, { hash: string }>) {
  const catalog = validateKnowledge<KnowledgeCatalog>(catalogSchema, value), ids = catalog.modules.map(m => m.id);
  if (new Set(ids).size !== ids.length || catalog.targets.some(id => !ids.includes(id))) throw new Error('业务模块编号重复或目标不存在');
  for (const term of catalog.vocabulary) if (term.modules.some(id => !ids.includes(id))) throw new Error('业务术语引用不存在的模块');
  for (const module of catalog.modules) if (module.entryFiles.some(file => !Object.hasOwn(files, file))) throw new Error('模块入口不在源码快照中');
  return bindEvidence(catalog, root, files);
}
export async function checkedModule(value: unknown, catalog: KnowledgeCatalog, root: string, files: Record<string, { hash: string }>) {
  const module = validateKnowledge<KnowledgeModule>(moduleSchema, value), ids = catalog.modules.map(m => m.id);
  if (Buffer.byteLength(JSON.stringify(value)) > 18000) throw new Error('单模块说明超过18KB，请精简重复叙述并引用最小必要证据');
  if (!ids.includes(module.id) || new Set(module.facts.map(f => f.id)).size !== module.facts.length) throw new Error('模块或事实编号无效');
  if (new Set(module.flows.map(f => f.name)).size !== module.flows.length) throw new Error('行为链路名称重复');
  const invalidDependencies = [
    ...module.facts.flatMap((fact, index) => fact.dependsOn.filter(id => !ids.includes(id)).map(id => `facts[${index}].dependsOn=${JSON.stringify(id)}`)),
    ...module.flows.flatMap((flow, index) => flow.relatedModules.filter(id => !ids.includes(id)).map(id => `flows[${index}].relatedModules=${JSON.stringify(id)}`)) ];
  if (invalidDependencies.length) throw new Error(`无效模块依赖：${invalidDependencies.join('；')}。只接受业务模块编号：${JSON.stringify(ids)}；不能填事实编号facts.id。按源码关系更正错误字段，不能为通过校验随意替换依赖。`);
  return bindEvidence(module, root, files);
}

export function checkedReview(value: unknown, module: KnowledgeModule) {
  const review = validateKnowledge<KnowledgeReview>(knowledgeReviewSchema, value);
  if (review.moduleId !== module.id || !review.catalogReviewed
    || JSON.stringify([...review.checkedFacts].sort()) !== JSON.stringify(module.facts.map(f => f.id).sort())
    || JSON.stringify([...review.checkedFlows].sort()) !== JSON.stringify(module.flows.map(f => f.name).sort()))
    throw new Error('项目理解审核没有覆盖全部事实、行为链路及相关目录');
  return review;
}
export async function readProjectKnowledge(project: Project): Promise<ProjectKnowledge | null> {
  let pointer: { id: string; hash: string };
  try { pointer = JSON.parse(await fs.readFile(path.join(project.archive, 'project-knowledge/current.json'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  if (!/^[a-f0-9-]{36}$/.test(pointer.id)) throw new Error('项目知识版本编号无效');
  const bytes = await fs.readFile(path.join(project.archive, 'project-knowledge/versions', pointer.id + '.json'));
  if (sha256(bytes) !== pointer.hash) throw new Error('项目知识完整性校验失败');
  const value = JSON.parse(bytes.toString());
  if (value.schemaVersion !== 2 || value.id !== pointer.id || !Array.isArray(value.modules) || !value.catalog || !Array.isArray(value.validationChecks))
    throw new Error('项目知识不符合当前契约，请清理旧记录后重新梳理');
  return value;
}
export async function publishProjectKnowledge(project: Project, input: Omit<ProjectKnowledge, 'schemaVersion' | 'id' | 'parent' | 'at'>) {
  return locked(path.join(project.archive, 'project-knowledge/publish'), async () => {
    if (!input.modules.length) throw new Error('没有已核对的模块，不能发布项目理解');
    for (const item of input.modules) {
      checkedReview(item.review, item.content);
      if (item.review.issues.length || !item.reviewSession || !item.jobId || !Array.isArray(item.amendments)) throw new Error('项目理解仍有阻断问题或缺少审核来源');
    }
    const previous = await readProjectKnowledge(project);
    const value: ProjectKnowledge = { ...input, schemaVersion: 2, id: randomUUID(), parent: previous === null ? null : previous.id, at: new Date().toISOString() };
    const bytes = JSON.stringify(value), home = path.join(project.archive, 'project-knowledge/versions');
    await fs.mkdir(home, { recursive: true }); await fs.writeFile(path.join(home, value.id + '.json'), bytes, { flag: 'wx', mode: 0o600 });
    await writeAtomic(path.join(project.archive, 'project-knowledge/current.json'), JSON.stringify({ id: value.id, hash: sha256(bytes) }));
    return value;
  });
}
function references(value: unknown): SourceRef[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => key === 'evidence' || key === 'summaryEvidence' ? child as SourceRef[]
    : Array.isArray(child) ? child.flatMap(references) : references(child));
}

export async function currentKnowledge(project: Project, root: string, config: Settings) {
  const knowledge = await readProjectKnowledge(project);
  if (knowledge === null) return null;
  const files = await manifest(root, config.excludedPaths, config.maxSnapshotBytes), invalid = new Map<string, string[]>(), relocated = new Set<string>();
  const entries = knowledge.catalog.modules;
  for (const item of knowledge.modules) {
    const entry = entries.find(m => m.id === item.content.id); if (!entry) throw new Error('知识模块缺少目录记录');
    const all = [...references(item.content), ...references(entry), ...knowledge.catalog.summaryEvidence, ...knowledge.catalog.vocabulary.filter(v => v.modules.includes(entry.id)).flatMap(references)];
    const changed: string[] = [];
    for (const ref of all) {
      if (!ref.hash || !ref.content || !ref.spanHash || sha256(ref.content) !== ref.spanHash) throw new Error('项目知识缺少可验证的证据片段');
      if (!Object.hasOwn(files, ref.file)) {
        const moved = Object.keys(files).filter(file => files[file].hash === ref.hash);
        if (moved.length !== 1) { changed.push(ref.file); continue; }
        const old = ref.file; ref.file = moved[0]; entry.entryFiles = entry.entryFiles.map(file => file === old ? ref.file : file);
        relocated.add(item.content.id);
      }
      if (files[ref.file].hash === ref.hash) continue;
      const content = await fs.readFile(path.join(root, ref.file), 'utf8'), index = content.indexOf(ref.content);
      if (index < 0 || content.indexOf(ref.content, index + 1) !== -1) { changed.push(ref.file); continue; }
      ref.start = content.slice(0, index).split('\n').length; ref.end = ref.start + ref.content.split('\n').length - 1; ref.hash = files[ref.file].hash;
    }
    const reasons = [...new Set(changed)].map(file => '证据源码已变化或删除：' + file);
    const dependencies = [...item.content.facts.flatMap(f => f.dependsOn), ...item.content.flows.flatMap(f => f.relatedModules)];
    for (const id of new Set(dependencies)) if (id !== item.content.id && !knowledge.modules.some(module => module.content.id === id)) reasons.push('依赖模块尚未完成梳理：' + id);
    if (reasons.length) invalid.set(item.content.id, reasons);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of knowledge.modules) if (!invalid.has(item.content.id)) {
      const dependencies = [...item.content.facts.flatMap(f => f.dependsOn), ...item.content.flows.flatMap(f => f.relatedModules)];
      const affected = [...new Set(dependencies)].filter(id => id !== item.content.id && (invalid.has(id) || relocated.has(id)));
      if (affected.length) { invalid.set(item.content.id, affected.map(id => '依赖模块的证据或文件位置已变化：' + id)); expanded = true; }
    }
  }
  return { ...knowledge, currentSourceHash: manifestHash(files), modules: knowledge.modules.map(item => ({ ...item,
    state: invalid.has(item.content.id) ? 'stale' as const : 'verified' as const, invalidatedBy: invalid.get(item.content.id) ?? [] })) };
}

export async function knowledgeForTask(project: Project, root: string, config: Settings, role: Role, query: string, files: string[]) {
  const knowledge = await currentKnowledge(project, root, config);
  if (knowledge === null) throw new Error('请先完成项目理解梳理；结构索引不能代替业务模块与行为链路');
  const lower = query.toLowerCase();
  const matched = knowledge.catalog.vocabulary.filter(v => [v.term, ...v.aliases].some(term => lower.includes(term.toLowerCase()))).flatMap(v => v.modules);
  const selected = knowledge.modules.filter(item => matched.includes(item.content.id)
    || references(item.content).some(ref => files.includes(ref.file)));
  const modules = knowledge.modules.map(item => {
    const entry = knowledge.catalog.modules.find(m => m.id === item.content.id)!;
    if (role !== 'requirement') {
      const content = JSON.parse(JSON.stringify(item.content, (key, value) => key === 'content' || key === 'spanHash' ? undefined : value));
      return { ...content, name: entry.name, purpose: entry.purpose, state: item.state,
        invalidatedBy: item.invalidatedBy, validationChecks: config.unitChecks, validationChecksState: 'declared-not-executed',
        validationChecksChanged: JSON.stringify(config.unitChecks) !== JSON.stringify(knowledge.validationChecks) };
    }
    return { id: entry.id, name: entry.name, purpose: entry.purpose, state: item.state,
      invalidatedBy: item.invalidatedBy.length ? ['相关源码已改变，需要研发重新核对'] : [],
      facts: item.content.facts.filter(f => f.audience === 'business').map(f => ({ statement: f.statement, kind: f.kind })),
      unknowns: item.content.unknowns.length ? ['本模块仍有未核实事项，涉及当前需求时由研发核对'] : [] };
  });
  const summaries = knowledge.catalog.modules.map(entry => `${entry.id}：${entry.name}；${entry.purpose}（${knowledge.modules.some(m => m.content.id === entry.id) ? '已有梳理，状态见材料' : '待梳理'}）`).join('\n');
  const material = { version: knowledge.id, scope: knowledge.scope, modules, catalog: role === 'requirement'
    ? knowledge.catalog.vocabulary.map(v => ({ term: v.term, meaning: v.meaning, modules: v.modules })) : knowledge.catalog };
  const details = selected.map(item => modules.find(module => module.id === item.content.id));
  const access = modules.map(module => ({ moduleId: module.id, sections: role === 'requirement' ? ['overview', 'facts'] : ['overview', 'facts', 'flows', 'validation'] }));
  const intro = role === 'requirement' ? '使用业务术语与能力边界帮助产品对齐，不将实现细节写入产品需求。' : role === 'review'
    ? '项目知识是范围与不变量线索，必须独立核对实际差异、源码和测试，不沿用实现者自评。' : '按业务模块、行为链路、必保规则和现有验证方法实施，遇到矛盾再针对性调查。';
  const body = JSON.stringify(details);
  return { version: knowledge.id, selected: selected.map(item => item.content.id), material,
    text: `项目理解版本 ${knowledge.id}；覆盖范围：${knowledge.scope}。${intro}\n业务模块目录：\n${summaries}\n`
      + (body.length <= 12000 ? `相关材料：${body}\n` : '相关模块材料较长，请调用read_project_knowledge按模块读取，当前未注入正文。\n')
      + `read_project_knowledge 可读清单：${JSON.stringify(access)}。仅使用清单中的 moduleId 和章节，offset 从 0 开始；目录中待梳理的模块不可读取，也不能提交事实建议替代初始化。研发事实建议仅使用此清单中的模块编号，无需建议时不调用。stale 资料仅是历史线索，必须重新核对；已有证据足够时直接处理当前需求，缺必要证据才针对性读取。命令声明不代表实际测试通过。` };
}

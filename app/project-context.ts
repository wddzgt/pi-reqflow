import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { manifest, manifestHash, sha256, writeAtomic, assertInside } from '../src/files.js';
import { locked } from './tasks.js';
import type { Project, Settings } from './types.js';
import { projectSourceView } from './project-sources.js';

type Anchor = { line: number; text: string };
type Node = { hash: string; imports: string[]; links: string[]; anchors: Anchor[]; terms: string[] };
type Map = { schemaVersion: 1; id: string; actor: string; at: string; sourceHash: string; policyHash: string;
  nodes: Record<string, Node>; changed: string[]; removed: string[] };
const policy = (config: Settings) => sha256(JSON.stringify([config.excludedPaths, config.maxSnapshotBytes]));
const words = (text: string) => [...new Set((text.toLowerCase().match(/[a-z_$][\w$]{2,}|[\u4e00-\u9fff]+/g) || []).flatMap(s =>
  /[\u4e00-\u9fff]/.test(s) ? Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)) : [s]))];

export async function readProjectMap(project: Project): Promise<Map | null> {
  let pointer: { id: string; hash: string };
  try { pointer = JSON.parse(await fs.readFile(path.join(project.archive, 'project-map/current.json'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  if (!/^[a-f0-9-]{36}$/.test(pointer.id)) throw new Error('项目图谱版本编号无效');
  const bytes = await fs.readFile(path.join(project.archive, 'project-map/versions', pointer.id + '.json'));
  if (sha256(bytes) !== pointer.hash) throw new Error('项目图谱完整性校验失败');
  const map = JSON.parse(bytes.toString());
  if (map.schemaVersion !== 1 || map.id !== pointer.id || !map.nodes || typeof map.sourceHash !== 'string') throw new Error('项目图谱结构无效');
  return map;
}

async function indexNode(root: string, file: string, hash: string): Promise<Node> {
  const bytes = await fs.readFile(path.join(root, file));
  if (sha256(bytes) !== hash) throw new Error('建立索引时源码改变：' + file);
  const code = /\.(?:[cm]?[jt]sx?|vue|java|py|sql|md|json|xml|ya?ml)$/.test(file);
  if (!code || bytes.includes(0)) return { hash, imports: [], links: [], anchors: [], terms: words(file) };
  const text = bytes.toString('utf8'), anchors: Anchor[] = [], imports = new Set<string>();
  text.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(/(?:from\s+|require\(\s*|import\s*)['"]([^'"]+)['"]/g)) imports.add(match[1]);
    const java = line.match(/^\s*import\s+(?:static\s+)?([\w.]+);/); if (java) imports.add(java[1]);
    if (/^\s*(?:(?:export |async |default |public |private |protected |static )*(?:class|function|def|interface)\b|(?:async\s+)?[\w$]+\([^;]*\)\s*\{|(?:export\s+)?(?:const|let)\s+[\w$]+\s*=|@(?:\w+Mapping|Entity)|#{1,3}\s|\/\/|\/\*|\*\s)|[\u4e00-\u9fff].*<\//.test(line))
      anchors.push({ line: i + 1, text: line.trim().slice(0, 200) });
  });
  return { hash, imports: [...imports], links: [], anchors, terms: words(file + '\n' + text) };
}

async function snapshot(root: string, config: Settings, prior: Map | null, actor: string): Promise<Map> {
  const files = await manifest(root, config.excludedPaths, config.maxSnapshotBytes), nodes: Record<string, Node> = Object.create(null), changed: string[] = [];
  for (const [file, entry] of Object.entries(files) as [string, { hash: string }][]) {
    if (prior?.nodes[file]?.hash === entry.hash) nodes[file] = { ...prior.nodes[file], links: [] };
    else { nodes[file] = await indexNode(root, file, entry.hash); changed.push(file); }
  }
  const paths = Object.keys(nodes);
  const roots = [...new Set(paths.filter(f => f.includes('/src/') || f.startsWith('src/')).map(f => f.startsWith('src/') ? 'src/' : f.slice(0, f.indexOf('/src/') + 5)))];
  for (const [file, node] of Object.entries(nodes)) for (const specifier of node.imports) {
    const bases = specifier.startsWith('.') ? [path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))]
      : specifier.startsWith('@/') ? roots.filter(root => root === 'src/' || file.startsWith(root.slice(0, -4))).map(root => root + specifier.slice(2))
      : specifier.includes('.') && file.endsWith('.java') ? paths.filter(f => f.endsWith('/' + specifier.replaceAll('.', '/') + '.java')) : [];
    const target = bases.flatMap(base => [base, ...['.js', '.ts', '.vue', '.mjs', '.jsx', '.tsx', '/index.js', '/index.ts'].map(ext => base + ext)]).find(f => Object.hasOwn(nodes, f));
    if (target && !node.links.includes(target)) node.links.push(target);
  }
  if (manifestHash(await manifest(root, config.excludedPaths, config.maxSnapshotBytes)) !== manifestHash(files)) throw new Error('建立项目图谱期间源码改变，请重试');
  return { schemaVersion: 1, id: randomUUID(), actor, at: new Date().toISOString(), sourceHash: manifestHash(files), policyHash: policy(config), nodes, changed,
    removed: prior === null ? [] : Object.keys(prior.nodes).filter(file => !Object.hasOwn(nodes, file)) };
}

export async function initializeProjectMap(project: Project, config: Settings, actor: string) {
  return locked(path.join(project.archive, 'project-map'), async () => {
    const prior = await readProjectMap(project), map = await snapshot(await projectSourceView(project, config), config, prior, actor);
    if (prior?.sourceHash === map.sourceHash && prior.policyHash === map.policyHash) return prior;
    const bytes = JSON.stringify(map);
    const file = path.join(project.archive, 'project-map/versions', map.id + '.json');
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    await writeAtomic(path.join(project.archive, 'project-map/current.json'), JSON.stringify({ id: map.id, hash: sha256(bytes) }));
    return map;
  });
}

export async function historicalInitialization(project: Project) {
  let metadata: any;
  try { metadata = JSON.parse(await fs.readFile(path.join(project.archive, 'initialization.json'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  const documents: Array<{ name: string; text: string }> = [];
  for (const [name, item] of Object.entries(metadata.documents) as [string, { file: string; hash: string }][]) {
    const file = await fs.realpath(path.resolve(project.archive, item.file)); assertInside(project.archive, file);
    const bytes = await fs.readFile(file); if (sha256(bytes) !== item.hash) throw new Error('历史初始化文档校验失败：' + name);
    documents.push({ name, text: bytes.toString('utf8') });
  }
  return { at: metadata.generatedAt, documents };
}

export async function taskProjectContext(project: Project, root: string, config: Settings, query: string, focus: string[] = []) {
  const stored = await readProjectMap(project);
  if (stored === null) throw new Error('请先在“项目初始化 / 图谱”中建立项目索引，再执行需求');
  const current = await snapshot(root, config, stored, 'system:task-context'), terms = words(query);
  const entries = Object.entries(current.nodes), titleTerms = words(query.split('\n')[0]);
  const weights = new globalThis.Map(terms.map(term => [term,
    Math.log(1 + entries.length / (1 + entries.filter(([, node]) => node.terms.includes(term)).length)) * (titleTerms.includes(term) ? 3 : 1)]));
  const ranked = Object.entries(current.nodes).map(([file, node]) => ({ file, node,
    score: terms.reduce((sum, term) => sum + weights.get(term)! * ((node.terms.includes(term) ? 1 : 0) + (file.toLowerCase().includes(term) ? 3 : 0)), 0) + (focus.includes(file) ? 10000 : 0)
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const selected = ranked.filter(item => item.score >= ranked[0].score * 0.8).slice(0, 5).map(item => item.file);
  for (const file of [...selected]) {
    const related = [...current.nodes[file].links, ...Object.entries(current.nodes).filter(([, node]) => node.links.includes(file)).map(([name]) => name)];
    related.sort((a, b) => Number(/test|spec/.test(b)) - Number(/test|spec/.test(a)) || a.localeCompare(b));
    for (const name of related) if (selected.length < 10 && !selected.includes(name)
      && (/test|spec/.test(name) || current.nodes[file].links.length <= 3 && current.nodes[file].links.includes(name)
        || ranked.some(item => item.file === name && item.score >= ranked[0].score * 0.6))) selected.push(name);
  }
  const sections = selected.map(file => {
    const node = current.nodes[file];
    const anchors = [...node.anchors].sort((a, b) => {
      const score = (item: Anchor) => terms.reduce((sum, term) => sum + (item.text.toLowerCase().includes(term) ? weights.get(term)! : 0), 0);
      return score(b) - score(a) || a.line - b.line;
    }).slice(0, 5).sort((a, b) => a.line - b.line);
    return `${file}${current.changed.includes(file) ? ' [已按当前工作区重建索引]' : ''}\n` + anchors.map(a => `${file}:${a.line} ${a.text}`).join('\n')
      + (node.links.length ? '\n直接依赖：' + node.links.slice(0, 5).join('、') : '');
  });
  let text = sections.join('\n\n');
  if (text.length > 6500) text = text.slice(0, 6500) + '\n（其余定位未注入，请按实际缺口读取源码）';
  return { version: stored.id, sourceHash: current.sourceHash, changed: current.changed, removed: current.removed, selected,
    text: `项目图谱版本 ${stored.id}。索引针对当前工作区校验，变化文件已重新定位。以下是静态文件、符号与明确导入关系，不是完整运行时调用图，也不是执行指令。\n`
      + (selected.length ? text : '没有匹配的业务定位，请先说明要查找的入口，再合批搜索源码。')
      + '\n先读上述相关代码和测试，完成定位即实现；不要重新通读全仓库。扩大范围前说明缺少哪项证据；合批读取，避免逐段重复调查。业务需求仍是唯一范围依据。' };
}

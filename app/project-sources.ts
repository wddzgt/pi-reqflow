import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { manifest, manifestHash, copyFiles, sha256 } from '../src/files.js';
import type { Project, ProjectSource, Settings, UnitCheck } from './types.js';

export const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
export const projectPolicy = (project: Project, config: Settings) => sha256(JSON.stringify({ config, sources: project.sources }));
export function sourceFile(project: Project, file: string) {
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('交付文件路径必须是规范相对路径');
  const source = project.sources.find(item => !item.prefix || file.startsWith(item.prefix + '/'));
  if (!source) throw new Error('交付文件没有登记的源码来源：' + file);
  const relative = source.prefix ? file.slice(source.prefix.length + 1) : file;
  return { source, relative, target: path.join(source.directory, relative) };
}
export async function resolveUnitChecks(project: Project, config: Settings, root: string): Promise<UnitCheck[]> {
  const checks = [...config.unitChecks];
  if (!checks.length) for (const source of project.sources) {
    const cwd = source.prefix || '.', directory = path.join(root, cwd);
    let input: string;
    try { input = await fs.readFile(path.join(directory, 'package.json'), 'utf8'); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`来源 ${source.id} 没有可识别的单元测试入口；请由研发准备测试设施或声明工程检查`);
    }
    let manifest: any;
    try { manifest = JSON.parse(input); }
    catch (error) { throw new Error(`来源 ${source.id} 的 package.json JSON 无效`, { cause: error }); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`来源 ${source.id} 的 package.json 必须是对象`);
    const script = Object.hasOwn(manifest.scripts ?? {}, 'test:unit') ? 'test:unit' : 'test';
    if (typeof manifest.scripts?.[script] !== 'string' || !manifest.scripts[script].trim())
      throw new Error(`来源 ${source.id} 的 package.json 缺少有效 ${script} 测试脚本`);
    const locks: string[] = [];
    for (const [name, manager] of [['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']]) {
      try { await fs.access(path.join(directory, name)); locks.push(manager); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    const managers = [...new Set(locks)];
    const declared = manifest.packageManager;
    if (declared !== undefined && (typeof declared !== 'string' || !/^(npm|pnpm|yarn|bun)@\S+$/.test(declared)))
      throw new Error(`来源 ${source.id} 的 packageManager 声明无效或不受支持`);
    const manager = declared === undefined ? managers[0] ?? 'npm' : declared.split('@')[0];
    if (managers.length > 1 || managers.some(item => item !== manager)) throw new Error(`来源 ${source.id} 的包管理器声明与锁文件冲突`);
    checks.push({ id: 'auto-' + source.id, name: source.id + ' 单元测试', command: [manager, 'run', script], cwd, sources: [source.id] });
  }
  for (const source of project.sources) {
    if (!checks.some(check => check.sources.includes(source.id))) throw new Error('必要检查未覆盖来源：' + source.id);
    if (source.prefix && config.excludedPaths.includes(source.prefix)) throw new Error('不能排除完整项目的整个来源：' + source.id);
  }
  if (checks.some(check => check.sources.some(id => !project.sources.some(source => source.id === id))))
    throw new Error('必要检查引用未登记来源');
  for (const check of checks) {
    const location = project.sources.find(source => source.prefix && (check.cwd === source.prefix || check.cwd.startsWith(source.prefix + '/')));
    if (location && check.sources.some(id => id !== location.id)) throw new Error('单一来源工作目录不能声明覆盖其他来源：' + check.id);
  }
  return checks;
}
export async function validateSources(value: unknown, root: string): Promise<ProjectSource[]> {
  if (!Array.isArray(value) || ![1, 2].includes(value.length)) throw new Error('项目必须明确登记根目录或前后端两个来源');
  for (const source of value) {
    if (!source || Object.keys(source).some(key => !['id', 'kind', 'directory', 'prefix'].includes(key))
      || !['root', 'frontend', 'backend'].includes(source.id) || source.kind !== source.id
      || typeof source.directory !== 'string' || !path.isAbsolute(source.directory)
      || source.prefix !== (source.id === 'root' ? '' : source.id)) throw new Error('项目来源描述无效');
    if (await fs.realpath(source.directory) !== source.directory || !(await fs.stat(source.directory)).isDirectory())
      throw new Error('项目来源必须是实际目录，不能使用目录别名');
    await fs.access(source.directory, constants.R_OK | constants.X_OK);
  }
  if (value.length === 1) {
    if (value[0].id !== 'root' || value[0].directory !== root) throw new Error('单目录来源必须与项目根目录一致');
  } else if (value[0].id !== 'frontend' || value[1].id !== 'backend' || overlaps(value[0].directory, value[1].directory)
    || value.some(source => overlaps(source.directory, root))) throw new Error('前后端及项目资料目录不能重复或相互包含');
  return value as ProjectSource[];
}
export async function assertSourceLinks(root: string) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (['.git', '.reqflow', '.reqflow-init', '.reqflow-workspaces', 'node_modules'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('来源中存在未授权的符号链接：' + entry.name);
    if (entry.isDirectory()) await assertSourceLinks(path.join(root, entry.name));
  }
}
export async function projectManifest(project: Project, config: Pick<Settings, 'excludedPaths' | 'maxSnapshotBytes'>) {
  const result: Record<string, { hash: string; bytes: number; mode: number }> = Object.create(null);
  let bytes = 0;
  for (const source of project.sources) {
    if (source.prefix && config.excludedPaths.includes(source.prefix)) continue;
    const excludes = source.prefix ? config.excludedPaths.filter(item => item.startsWith(source.prefix + '/')).map(item => item.slice(source.prefix.length + 1)) : config.excludedPaths;
    const files = await manifest(source.directory, excludes, config.maxSnapshotBytes);
    for (const [file, entry] of Object.entries(files) as [string, { hash: string; bytes: number; mode: number }][]) {
      bytes += entry.bytes; if (bytes > config.maxSnapshotBytes) throw new Error('完整项目全部来源的源码快照超过上限');
      result[source.prefix ? source.prefix + '/' + file : file] = entry;
    }
  }
  return result;
}
const preparing = new Map<string, Promise<string>>();
export async function projectSourceView(project: Project, config: Settings): Promise<string> {
  if (project.sources.length === 1) return project.root;
  const files = await projectManifest(project, config), hash = manifestHash(files);
  const target = path.join(project.archive, 'source-views', hash), key = project.archive + ':' + hash;
  if (preparing.has(key)) return preparing.get(key)!;
  const build = async () => {
    try {
      await fs.access(target);
      if (manifestHash(await manifest(target, config.excludedPaths, config.maxSnapshotBytes)) !== hash) throw new Error('项目来源视图损坏，请核查后重建');
      return target;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const stage = path.join(project.archive, 'source-view-preparing', randomUUID());
    await fs.mkdir(stage, { recursive: true, mode: 0o700 });
    for (const source of project.sources) {
      const names = Object.keys(files).filter(file => file.startsWith(source.prefix + '/')).map(file => file.slice(source.prefix.length + 1));
      await copyFiles(source.directory, path.join(stage, source.prefix), names);
    }
    if (manifestHash(await manifest(stage, config.excludedPaths, config.maxSnapshotBytes)) !== hash
      || manifestHash(await projectManifest(project, config)) !== hash) throw new Error('准备完整项目视图期间源码改变，未发布视图');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await fs.rename(stage, target); }
    catch (error: any) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      if (manifestHash(await manifest(target, config.excludedPaths, config.maxSnapshotBytes)) !== hash) throw new Error('并发发布的来源视图不一致');
      await fs.rm(stage, { recursive: true });
    }
    return target;
  };
  const promise = build(); preparing.set(key, promise);
  try { return await promise; } finally { preparing.delete(key); }
}
export async function sourceDependency(project: Project, relative: string) {
  const source = project.sources.find(item => !item.prefix || relative.startsWith(item.prefix + '/'));
  if (!source) throw new Error('运行依赖没有对应的项目来源');
  const local = source.prefix ? relative.slice(source.prefix.length + 1) : relative;
  const target = await fs.realpath(path.join(source.directory, local));
  if (target !== source.directory && !target.startsWith(source.directory + path.sep)) throw new Error('运行依赖越出已登记来源');
  if (!(await fs.stat(target)).isDirectory()) throw new Error('运行依赖必须是目录：' + relative);
  return target;
}

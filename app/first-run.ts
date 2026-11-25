import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../src/files.js';
import { authenticateByUsername, createFirstAdmin } from './accounts.js';
import { acquireFileLock } from './file-lock.js';
import { assertSourceLinks, overlaps, validateSources } from './project-sources.js';
import { openProject, stateDirectory } from './projects.js';

async function exists(file: string) {
  try { await fs.lstat(file); return true; }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function initializeFirstProject(directory: string, askPassword: () => Promise<string>) {
  const root = await fs.realpath(directory);
  const sources = await validateSources([{ id: 'root', kind: 'root', directory: root, prefix: '' }], root);
  const name = path.basename(root);
  if (!name.trim() || name.length > 100) throw new Error('项目目录名称须为 1 至 100 个字符');
  const location = path.resolve(stateDirectory());
  if (overlaps(root, location)) throw new Error('项目与工作台状态目录不能重叠');
  await fs.mkdir(location, { recursive: true, mode: 0o700 });
  const state = await fs.realpath(location);
  if (overlaps(root, state)) throw new Error('项目与工作台状态目录不能重叠');
  const release = acquireFileLock(path.join(state, 'first-run.lock'), '另一进程正在初始化工作台');
  try {
    const registry = path.join(state, 'projects.json'), installation = path.join(state, 'installation');
    const archive = path.join(root, '.reqflow'), accountsArchive = path.join(installation, 'accounts');
    if (await exists(registry)) throw new Error('工作台已经初始化。请运行 npm start，登录后可导入其他项目');
    const resume = await exists(installation);
    if (!resume && await exists(archive)) throw new Error('所选目录已有 .reqflow 资料，请选择尚未接入的项目');
    if (!resume && (await fs.readdir(state)).some(file => !['first-run.lock', 'first-run.lock-journal', '.DS_Store'].includes(file) && !file.startsWith('.first-run-')))
      throw new Error('状态目录含有既有资料。请恢复原注册表，或用 REQFLOW_STATE_DIR 指定独立的空目录');
    await assertSourceLinks(root);
    const password = await askPassword();
    if (Buffer.byteLength(password) < 8 || Buffer.byteLength(password) > 1024)
      throw new Error('首次管理员密码须为 8 至 1024 字节');
    if (!resume) {
      const staging = await fs.mkdtemp(path.join(state, '.first-run-'));
      try {
        await fs.mkdir(path.join(staging, 'accounts'), { mode: 0o700 });
        await createFirstAdmin(path.join(staging, 'accounts'), password);
        await writeJson(path.join(staging, 'first-project.json'), { projects: [{ id: randomUUID(), name,
          projectDir: root, importedAt: new Date().toISOString(), importedBy: 'admin' }] });
        await fs.rename(staging, installation);
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
    const firstRegistry = path.join(installation, 'first-project.json');
    const { projects } = await readJson(firstRegistry);
    if (!Array.isArray(projects) || projects.length !== 1 || projects[0].projectDir !== root)
      throw new Error('此前的初始化尚未完成，请使用原项目目录继续');
    await authenticateByUsername({ accountsArchive }, 'admin', password);
    if (!await exists(archive)) {
      const parent = path.join(root, '.reqflow-init');
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      if (await fs.realpath(parent) !== parent) throw new Error('项目初始化目录不能是符号链接');
      const staging = await fs.mkdtemp(path.join(parent, 'first-project-'));
      try {
        await writeJson(path.join(staging, 'account-source.json'), { archive: accountsArchive });
        await writeJson(path.join(staging, 'project.json'), { schemaVersion: 1, sources, actor: 'admin', at: projects[0].importedAt });
        await fs.rename(staging, archive);
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
    const target = await openProject(root, projects[0].id, name);
    if (await fs.realpath(archive) !== archive || target.accountsArchive !== accountsArchive
      || JSON.stringify(target.sources) !== JSON.stringify(sources)) throw new Error('现有项目资料与本次初始化不匹配');
    await fs.link(firstRegistry, registry);
    return name;
  } finally { release(); }
}

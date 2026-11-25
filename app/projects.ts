import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ajv } from "ajv";
import { readJson, writeJson, sha256 } from "../src/files.js";
import { randomUUID } from "node:crypto";
import type { Project, Settings } from "./types.js";
import { validateSources, overlaps, assertSourceLinks } from './project-sources.js';

export const stateDirectory = () => process.env.REQFLOW_STATE_DIR ?? path.join(os.homedir(), ".reqflow");
export async function projects(): Promise<Array<{ id: string; name: string; projectDir: string }>> {
  const registry = await readJson(path.join(stateDirectory(), "projects.json"));
  if (!Array.isArray(registry.projects)) throw new Error("项目注册表损坏");
  return registry.projects.filter((p: any) => !p.archivedAt);
}
export async function project(id: string): Promise<Project> {
  const item = (await projects()).find(p => p.id === id);
  if (!item) throw new Error("项目不存在");
  return openProject(item.projectDir, item.id, item.name);
}
export async function openProject(root: string, id: string, name: string): Promise<Project> {
  root = await fs.realpath(root);
  const archive = path.join(root, ".reqflow");
  const source = await readJson(path.join(archive, "account-source.json"));
  if (typeof source.archive !== "string" || !path.isAbsolute(source.archive)) throw new Error("项目账号来源无效");
  const description = await readJson(path.join(archive, 'project.json')).catch((error: any) => {
    if (error.code === 'ENOENT') throw Object.assign(new Error('项目来源描述缺失，请清理旧登记并按新契约重新接入'), { status: 409 });
    throw error;
  });
  if (description.schemaVersion !== 1) throw new Error('项目来源版本无效，请按新契约重新登记');
  const sources = await validateSources(description.sources, root);
  return { id, name, root, archive, accountsArchive: await fs.realpath(source.archive), sources };
}
export async function registerProject(source: Project, actor: string, value: any) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['name', 'directory', 'frontendDir', 'backendDir'].includes(key))) throw new Error('项目登记字段无效');
  const name = value.name;
  if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error("请填写100字以内的项目名称");
  const single = Object.hasOwn(value, 'directory');
  if (single && (Object.hasOwn(value, 'frontendDir') || Object.hasOwn(value, 'backendDir'))) throw new Error('根目录与前后端目录只能选择一种方式');
  const selections = single ? [['root', value.directory]] : [['frontend', value.frontendDir], ['backend', value.backendDir]];
  const sources: Array<{ id: string; kind: string; directory: string; prefix: string }> = [];
  for (const [kind, input] of selections) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('请为所有来源选择实际绝对目录');
    const directory = await fs.realpath(input);
    if (path.resolve(input) !== directory) throw new Error('所选目录包含符号链接，请选择实际目录');
    if (overlaps(directory, await fs.realpath(stateDirectory())) || overlaps(directory, source.accountsArchive))
      throw new Error('源码来源不能与工作台资料或账号目录交叠');
    sources.push({ id: kind, kind, directory, prefix: kind === 'root' ? '' : kind });
  }
  const id = randomUUID(), at = new Date().toISOString();
  const root = single ? sources[0].directory : path.join(await fs.realpath(stateDirectory()), 'projects', id);
  const validated = await validateSources(sources, root);
  const file = path.join(stateDirectory(), "projects.json");
  const lock = await fs.open(path.join(stateDirectory(), "projects.lock"), "wx", 0o600);
  try {
    const registry = await readJson(file);
    if (!Array.isArray(registry.projects)) throw new Error("项目注册表损坏");
    for (const entry of registry.projects) {
      const existing = await openProject(entry.projectDir, entry.id, entry.name);
      if (validated.some(next => [existing.root, existing.accountsArchive, ...existing.sources.map(item => item.directory)].some(directory => overlaps(directory, next.directory))))
        throw new Error('该来源与已登记项目重复或相互包含');
    }
    for (const item of validated) await assertSourceLinks(item.directory);
    if (!single) await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const archive = path.join(root, ".reqflow");
    await fs.mkdir(archive, { mode: 0o700 });
    await fs.writeFile(path.join(archive, "account-source.json"), JSON.stringify({ archive: source.accountsArchive }) + "\n", { flag: "wx", mode: 0o600 });
    await writeJson(path.join(archive, 'project.json'), { schemaVersion: 1, sources: validated, actor, at });
    registry.projects.push({ id, name: name.trim(), projectDir: root, importedAt: at, importedBy: actor });
    await writeJson(file, registry);
    return { id, name: name.trim(), sources: validated };
  } finally { await lock.close(); await fs.unlink(path.join(stateDirectory(), "projects.lock")); }
}
const choice = { type: "object", additionalProperties: false, required: ["provider", "model"], properties: {
  provider: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 } } };
const strings = { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true };
const positive = { type: "integer", minimum: 1 };
const unitCheck = { type: 'object', additionalProperties: false, required: ['id', 'name', 'command', 'cwd', 'sources'], properties: {
  id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }, name: { type: 'string', minLength: 1, maxLength: 100 },
  command: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, cwd: { type: 'string', minLength: 1 },
  sources: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['root', 'frontend', 'backend'] } } } };
const schema = { type: "object", additionalProperties: false,
  required: ["version", "models", "providers", "unitChecks", "excludedPaths", "runtimeDependencies", "maxSnapshotBytes", "budget"], properties: {
    version: { const: 1 }, models: { type: "object", additionalProperties: false,
      required: ["requirement", "development", "review"], properties: { requirement: choice, development: choice, review: choice } },
    unitChecks: { type: 'array', maxItems: 20, items: unitCheck }, excludedPaths: strings, runtimeDependencies: strings, maxSnapshotBytes: positive,
    budget: { type: "object", additionalProperties: false, required: ["tokens", "requests", "repairCycles", "runMs"],
      properties: { tokens: positive, requests: positive, repairCycles: positive, runMs: positive } },
    providers: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
      required: ["id", "baseUrl", "credentialId", "thinkingToggle", "systemRole", "outputLimitField", "models"], properties: {
        id: { type: "string", minLength: 1 }, baseUrl: { type: "string", minLength: 1 },
        credentialId: { type: "string", pattern: "^[a-f0-9-]{36}$" }, thinkingToggle: { type: "boolean" },
        systemRole: { enum: ["system", "developer"] }, outputLimitField: { enum: ["max_tokens", "max_completion_tokens"] },
        models: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
          required: ["id", "contextWindow", "maxTokens", "reasoning", "input"], properties: {
            id: { type: "string", minLength: 1 }, contextWindow: positive, maxTokens: positive,
            reasoning: { type: "boolean" }, input: { type: "array", minItems: 1, items: { enum: ["text", "image"] } } } } } } } } } };
const validateSettingsSchema = new Ajv({ allErrors: true }).compile(schema);
export function validateSettings(value: unknown): Settings {
  if (!validateSettingsSchema(value)) throw new Error(`执行设置无效：${JSON.stringify(validateSettingsSchema.errors)}`);
  const settings = value as Settings;
  if (new Set(settings.unitChecks.map(check => check.id)).size !== settings.unitChecks.length) throw new Error('必要检查编号重复');
  for (const check of settings.unitChecks) {
    if (check.cwd !== '.' && (path.isAbsolute(check.cwd) || check.cwd.split('/').some(part => !part || part === '.' || part === '..') || check.cwd.includes('\\')))
      throw new Error('检查工作目录必须是隔离现场中的规范相对目录');
  }
  for (const role of Object.values(settings.models)) {
    const provider = settings.providers.find(p => p.id === role.provider);
    if (!provider?.models.some(m => m.id === role.model)) throw new Error("所选模型不在供应商模型清单中");
  }
  if (new Set(settings.providers.map(p => p.id)).size !== settings.providers.length) throw new Error("供应商重复");
  for (const provider of settings.providers) {
    if (new Set(provider.models.map(m => m.id)).size !== provider.models.length) throw new Error("供应商内模型重复");
    const url = new URL(provider.baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
      throw new Error("供应商地址必须使用HTTPS，本机测试可使用HTTP");
    if (url.username || url.password || url.search || url.hash) throw new Error("供应商地址不能包含凭据或查询参数");
    for (const model of provider.models) if (model.maxTokens >= model.contextWindow) throw new Error("模型必须保留输入空间");
  }
  for (const entry of settings.runtimeDependencies) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..") || path.basename(entry) !== "node_modules")
      throw new Error("运行依赖必须是项目内的node_modules目录");
  }
  return settings;
}
export async function settings(project: Project): Promise<Settings> {
  try { return validateSettings(await readJson(path.join(project.archive, "delivery.json"))); }
  catch (error: any) {
    if (error.code === "ENOENT") throw Object.assign(new Error("项目尚未配置，请在项目设置中填写模型与执行策略"), { status: 404 });
    throw error;
  }
}
export async function saveSettings(project: Project, value: unknown, actor: string) {
  const config = validateSettings(value);
  if (config.unitChecks.some(check => check.sources.some(id => !project.sources.some(source => source.id === id))))
    throw new Error('必要检查引用了未登记的源码来源');
  if (typeof actor !== "string" || !actor.trim()) throw new Error("保存执行设置必须记录操作身份");
  const lock = await fs.open(path.join(project.archive, "settings.lock"), "wx", 0o600);
  try {
    const file = path.join(project.archive, "settings-events.jsonl"); let rows: any[];
    try { rows = (await fs.readFile(file, "utf8")).trim().split("\n").map(row => JSON.parse(row)); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; rows = []; }
    let previous = null;
    for (const row of rows) {
      if (row.previous !== previous || sha256(JSON.stringify({ ...row, hash: undefined })) !== row.hash) throw new Error("设置审计链损坏");
      previous = row.hash;
    }
    let before: unknown = null;
    try { before = await readJson(path.join(project.archive, "delivery.json")); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    const event: any = { at: new Date().toISOString(), actor, before, settings: config, previous };
    event.hash = sha256(JSON.stringify(event));
    await writeJson(path.join(project.archive, "delivery.json"), config);
    await fs.appendFile(file, JSON.stringify(event) + "\n", { mode: 0o600 });
  } finally { await lock.close(); await fs.unlink(path.join(project.archive, "settings.lock")); }
}

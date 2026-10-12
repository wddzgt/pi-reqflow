import { promises as fs } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { readJson, sha256, writeJson } from "./files.js";
import { withLock } from "./store.js";
import { childEnvironment } from "./execution-env.js";
import { executionStatus } from "./action-progress.js";
import { localRuntimeStatus } from "./local-runtime.js";
import { scanLocalEnvironment, selectedEnvironmentServices } from "./environment-scan.js";

async function privateValues(project, settings) {
  if (!settings?.valueFile) return {};
  if (!/^[a-f0-9-]{36}$/.test(settings.valueFile)) throw new Error("私有配置引用不合法。");
  const file = path.join(project.archive, "local-environment-values", `${settings.valueFile}.json`);
  const info = await fs.lstat(file);
  if (!info.isFile() || (info.mode & 0o077)) throw new Error("私有配置文件必须仅允许当前用户读写。");
  const values = await readJson(file);
  if (sha256(settings.valueFile + JSON.stringify(values)) !== settings.valuesHash) throw new Error("私有配置内容已改变，请重新保存。");
  return values;
}

export async function readLocalEnvironment(project) {
  const file = path.join(project.archive, "local-environment-events.jsonl");
  const events = await fs.readFile(file, "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line)),
    error => { if (error.code === "ENOENT") return []; throw error; });
  let previous = null;
  for (const event of events) {
    if (event.previous !== previous || event.hash !== sha256(JSON.stringify({ ...event, hash: undefined })))
      throw new Error("本地环境配置审计记录已改变。");
    previous = event.hash;
  }
  const latest = events.at(-1);
  const stored = await privateValues(project, latest?.settings);
  const values = {}; const secretConfigured = {};
  for (const service of latest?.settings.scan?.services ?? []) for (const field of service.fields) {
    const key = `${service.id}/${field.key}`;
    if (field.secret) secretConfigured[key] = Boolean(stored[key]);
    else if (Object.hasOwn(stored, key)) values[key] = stored[key];
  }
  return { revision: previous, version: events.length, configured: Boolean(latest),
    settings: latest ? latest.settings : null, values, secretConfigured,
    history: events.map(({ actor, at, hash, affectedRequirements }) => ({ actor, at, revision: hash, affectedRequirements })) };
}

export async function assertEnvironmentIdle(project) {
  for (const row of await readJson(path.join(project.archive, "index.json"))) {
    const directory = path.join(project.archive, "tasks", row.id);
    const locked = await fs.stat(path.join(directory, "task.lock")).then(() => true,
      error => { if (error.code === "ENOENT") return false; throw error; });
    if (locked || executionStatus(directory) || localRuntimeStatus(directory).services.some(service => !service.exited)
        || ["test_deploy_submitting", "test_deploy_running", "test_deploy_outcome_unknown"].includes(row.state))
      throw new Error("项目正在执行或本地服务仍在运行，请先停止并核实结果，再修改共享环境配置。");
  }
}

async function importedValues(project, workspace, file, scan) {
  const actual = await fs.realpath(file);
  for (const directory of [project.root, workspace]) {
    const root = await fs.realpath(directory);
    if (actual === root || actual.startsWith(`${root}${path.sep}`)) throw new Error("环境变量文件请放在项目目录外，避免进入代码快照和模型上下文。");
  }
  const info = await fs.stat(actual);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("环境变量文件必须是小于1 MiB的普通文件。");
  const imported = parseEnv(await fs.readFile(actual, "utf8")); const values = {}; const used = new Set();
  for (const service of scan.services) {
    for (const field of service.fields) if (field.envName && Object.hasOwn(imported, field.envName)) {
      values[`${service.id}/${field.key}`] = imported[field.envName]; used.add(field.envName);
    }
    if (service.bindings?.url && Object.hasOwn(imported, service.bindings.url)) {
      const raw = imported[service.bindings.url];
      if (!/^jdbc:(mysql|postgresql):\/\//.test(raw)) throw new Error("导入的数据库连接地址格式不正确。");
      const parsed = new URL(raw.replace(/^jdbc:(mysql|postgresql):/, "http:"));
      if (!parsed.port || !parsed.pathname.slice(1) || parsed.username || parsed.password || parsed.search)
        throw new Error("导入的 JDBC 地址必须包含主机、端口和数据库；额外连接参数需在项目配置中维护。");
      for (const [key, value] of Object.entries({ host: parsed.hostname.replace(/^\[|\]$/g, ""), port: parsed.port, database: decodeURIComponent(parsed.pathname.slice(1)) })) values[`${service.id}/${key}`] = value;
      used.add(service.bindings.url);
    }
    for (const [key, name] of Object.entries(service.bindings ?? {})) if (key !== "url" && Object.hasOwn(imported, name)) {
      values[`${service.id}/${key}`] = imported[name]; used.add(name);
    }
  }
  const unknown = Object.keys(imported).filter(name => !used.has(name));
  if (unknown.length) throw new Error(`文件包含未扫描的变量：${unknown.join("、")}。请移除或先在项目中声明，再导入。`);
  return values;
}

export async function configureLocalEnvironment(project, actor, input, root = project.root) {
  const keys = ["expectedRevision", "expectedScanHash", "target", "decisions", "values", "environmentFile", "acceptScanChanges", "scanTaskId"];
  if (!input || Object.keys(input).some(key => !keys.includes(key)) || typeof input.target !== "string"
      || !input.values || typeof input.values !== "object" || Array.isArray(input.values)
      || !input.decisions || typeof input.decisions !== "object" || Array.isArray(input.decisions)
      || typeof input.environmentFile !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedScanHash)
      || (input.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(input.expectedRevision)))
    throw new Error("本地环境配置格式不正确，请刷新后再保存。");
  const file = input.environmentFile.trim();
  if (file && (!path.isAbsolute(file) || file.includes("\0") || file.length > 4096)) throw new Error("环境变量文件必须是工作台运行设备上的绝对路径。");
  return withLock(path.join(project.archive, "execution-config.lock"), async () => {
    const current = await readLocalEnvironment(project);
    if (current.revision !== input.expectedRevision) throw new Error("环境配置已改变，请刷新后重新保存。");
    await assertEnvironmentIdle(project);
    const scan = await scanLocalEnvironment(project, root);
    if (scan.hash !== input.expectedScanHash) throw new Error("项目扫描结果已改变，请重新扫描并查看差异。");
    if (current.settings?.scan && current.settings.scan.hash !== scan.hash && input.acceptScanChanges !== true)
      throw new Error("请先确认重新扫描的差异，再应用新配置。");
    selectedEnvironmentServices(scan, input.target);
    const values = await privateValues(project, current.settings);
    const fields = new Map(scan.services.flatMap(service => service.fields.map(field => [`${service.id}/${field.key}`, field])));
    const decisionKeys = new Set(scan.services.filter(service => service.requirement !== "required").map(service => service.id));
    for (const [key, field] of fields) if (field.requirement === "unknown") decisionKeys.add(key);
    for (const [key, choice] of Object.entries(input.decisions)) if (!decisionKeys.has(key) || !["enabled", "disabled", "pending"].includes(choice))
      throw new Error("依赖判断不合法，请重新扫描。");
    const updates = file ? await importedValues(project, root, file, scan) : {};
    for (const [key, value] of Object.entries(input.values)) if (value !== "" || !fields.get(key)?.secret) updates[key] = value;
    for (const service of current.settings?.scan?.services ?? []) for (const previous of service.fields) {
      const key = `${service.id}/${previous.key}`;
      if (previous.secret && fields.has(key) && !fields.get(key).secret && values[key] && !Object.hasOwn(updates, key))
        throw new Error(`${previous.label} 的私有属性已改变，请重新填写该项，原私有值不会转为公开值。`);
    }
    for (const [key, value] of Object.entries(updates)) {
      const field = fields.get(key);
      if (!field || typeof value !== "string" || value.length > 16384 || value.includes("\0")) throw new Error("配置项或输入值不合法，请重新扫描。");
      if (!field.secret && /:\/\/[^/]*@|[?&](?:password|token|api[_-]?key|secret)=/i.test(value))
        throw new Error(`${field.label} 含有凭据，请将凭据放在项目声明的独立私有变量中。`);
      if (value && field.type === "host" && !/^[a-zA-Z0-9.:-]{1,253}$/.test(value)) throw new Error(`${field.label}格式不正确。`);
      if (value && field.type === "port" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error("请填写有效端口。" );
      values[key] = value;
    }
    const names = scan.services.flatMap(service => [...service.fields.map(field => field.envName), ...Object.values(service.bindings ?? {})]).filter(Boolean);
    childEnvironment([...new Set(names)], true, Object.fromEntries(names.map(name => [name, "validate-name"])));
    const valueFile = randomUUID();
    await fs.mkdir(path.join(project.archive, "local-environment-values"), { recursive: true, mode: 0o700 });
    await writeJson(path.join(project.archive, "local-environment-values", `${valueFile}.json`), values);
    const rows = await readJson(path.join(project.archive, "index.json"));
    const event = { actor, at: new Date().toISOString(), previous: current.revision,
      affectedRequirements: rows.filter(row => !["archived", "archived_test_only", "rolled_back"].includes(row.state)).map(row => row.id),
      settings: { scan, scanTaskId: input.scanTaskId ?? null, target: input.target, decisions: input.decisions,
        valueFile, valuesHash: sha256(valueFile + JSON.stringify(values)) } };
    event.hash = sha256(JSON.stringify(event));
    await fs.appendFile(path.join(project.archive, "local-environment-events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await writeJson(path.join(project.archive, "local-environment-check.json"), { revision: event.hash, status: "unchecked", checkedAt: null, items: [] });
    return readLocalEnvironment(project);
  });
}

export async function inspectLocalEnvironment(project, root = project.root) {
  const setup = await readLocalEnvironment(project);
  const items = []; const environments = {}; const names = new Set();
  const values = await privateValues(project, setup.settings);
  const scan = await scanLocalEnvironment(project, root);
  if (!setup.settings?.scan) return { report: { revision: setup.revision, status: setup.configured ? "blocked" : "unconfigured", checkedAt: new Date().toISOString(),
    items: [{ name: "本地环境配置", status: "blocked", message: "请先扫描项目并保存环境配置。" }] }, names: [], environments, services: [] };
  if (scan.hash !== setup.settings.scan.hash) items.push({ name: "项目扫描", status: "blocked", message: "源码的环境声明已改变，请重新扫描并确认差异。" });
  const services = selectedEnvironmentServices(scan, setup.settings.target);
  for (const service of services) {
    if (service.scanErrors?.length) {
      for (const message of service.scanErrors) items.push({ name: service.name, status: "blocked", message });
      continue;
    }
    const choice = setup.settings.decisions[service.id];
    if (service.requirement !== "required" && choice !== "enabled") {
      if (service.requirement === "unknown" && choice !== "disabled") items.push({ name: service.name, status: "blocked", message: "请研发确认本次是否需要此服务。" });
      continue;
    }
    const environment = {}; let missing = false;
    for (const field of service.fields) {
      const key = `${service.id}/${field.key}`; const decision = setup.settings.decisions[key];
      if (field.requirement === "unknown" && !["enabled", "disabled"].includes(decision)) {
        items.push({ name: `${service.name} · ${field.label}`, status: "blocked", message: "请确认此变量是否必需。" }); missing = true; continue;
      }
      if (field.requirement === "unknown" && decision === "disabled") continue;
      const value = values[key];
      if (field.required && !value) { items.push({ name: `${service.name} · ${field.label}`, status: "blocked", message: "缺少必需配置。" }); missing = true; }
      if (field.envName && (value !== undefined || field.type === "password")) environment[field.envName] = value ?? "";
    }
    if (missing) continue;
    const get = key => values[`${service.id}/${key}`];
    if (service.bindings?.url) {
      const parameters = new URLSearchParams(service.parameters).toString();
      const host = get("host").includes(":") ? `[${get("host")}]` : get("host");
      environment[service.bindings.url] = `jdbc:${service.kind === "postgres" ? "postgresql" : "mysql"}://${host}:${get("port")}/${encodeURIComponent(get("database"))}${parameters ? `?${parameters}` : ""}`;
    }
    for (const [key, name] of Object.entries(service.bindings ?? {})) if (key !== "url") environment[name] = get(key);
    for (const owner of service.owners ?? [service.id]) {
      const destination = environments[owner] ??= {};
      for (const [name, value] of Object.entries(environment)) {
        if (Object.hasOwn(destination, name) && destination[name] !== value) throw new Error(`${service.name} 存在冲突的环境变量 ${name}，请明确配置来源。`);
        destination[name] = value; names.add(name);
      }
    }
    if (!["mysql", "postgres", "redis"].includes(service.kind)) { items.push({ name: service.name, status: "ready" }); continue; }
    const dependency = { host: get("host"), port: Number(get("port")) };
    const result = await new Promise(resolve => {
      const socket = connect({ host: dependency.host, port: dependency.port });
      socket.setTimeout(2000);
      socket.once("connect", () => { socket.destroy(); resolve({ status: "ready" }); });
      socket.once("error", error => { socket.destroy(); resolve({ status: "blocked", message: `连接失败：${error.code}` }); });
      socket.once("timeout", () => { socket.destroy(); resolve({ status: "blocked", message: "连接超时" }); });
    });
    items.push({ name: service.name, ...result });
  }
  const report = { revision: setup.revision, status: items.some(item => item.status === "blocked") ? "blocked"
    : "ready", target: setup.settings.target, targetName: setup.settings.target === "all" ? "完整应用"
      : setup.settings.target === "frontend" ? "仅前端" : services.find(service => service.id === setup.settings.target).name,
    checkedAt: new Date().toISOString(), items };
  return { report, environments, names: [...names], services };
}

export async function checkLocalEnvironment(project, actor, root = project.root) {
  return withLock(path.join(project.archive, "execution-config.lock"), async () => {
    const { report } = await inspectLocalEnvironment(project, root);
    const result = { ...report, actor };
    const file = path.join(project.archive, "local-environment-check-events.jsonl");
    const history = await fs.readFile(file, "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line)),
      error => { if (error.code === "ENOENT") return []; throw error; });
    let previous = null;
    for (const event of history) {
      if (event.previous !== previous || event.hash !== sha256(JSON.stringify({ ...event, hash: undefined })))
        throw new Error("本地环境检查审计记录已改变。");
      previous = event.hash;
    }
    const event = { ...result, previous }; event.hash = sha256(JSON.stringify(event));
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await writeJson(path.join(project.archive, "local-environment-check.json"), result);
    return result;
  });
}

export function environmentStartup(inspected, startup) {
  const apps = inspected.services.filter(row => row.kind === "application");
  const selected = []; const environments = {}; const appIds = new Set();
  for (const service of startup) {
    const argv = service.command;
    const flag = argv.findIndex(value => ["--prefix", "--dir", "--cwd", "-f", "--file", "-pl"].includes(value));
    const directory = flag >= 0 ? (argv[flag] === "-f" || argv[flag] === "--file" ? path.posix.dirname(argv[flag + 1]) : argv[flag + 1]) : ".";
    const app = apps.find(row => row.commands.some(command => command.every((value, i) => argv[i] === value)))
      ?? apps.find(row => row.directory === directory && (flag >= 0 || row.runtime === "project" || row.directory === "."));
    if (!app) {
      if (inspected.report.target === "all") throw new Error(`已确认方案中的 ${service.name} 启动命令无法对应扫描服务，请核对命令的项目目录。`);
      continue;
    }
    if (argv.some(value => /spring(?:-boot\.run|\.profiles|\.config)\.(?:profiles|active|include|location|additional-location|import)=/.test(value)))
      throw new Error(`${service.name} 启动命令指定了额外 Spring 配置，当前扫描未覆盖，请核对验证配置。`);
    const environment = inspected.environments[app.id] ?? {};
    for (const name of ["PORT", "SERVER_PORT"]) if (environment[name] && Number(environment[name]) !== Number(new URL(service.healthUrl).port))
      throw new Error(`${service.name} 配置的端口与已确认方案的检查地址不同，请核对方案。`);
    selected.push(service); environments[service.name] = environment; appIds.add(app.id);
  }
  if (startup.length && !selected.length) throw new Error("所选目标没有已确认的启动命令，请更新研发方案后启动。");
  if (startup.length) for (const app of apps) if (app.commands.length && !appIds.has(app.id))
    throw new Error(`${app.name} 缺少已确认的启动命令，请选择已有服务目标或补齐研发方案。`);
  return { startup: selected, environments, appIds: [...appIds] };
}

export async function localEnvironmentReport(project) {
  const setup = await readLocalEnvironment(project);
  const report = await readJson(path.join(project.archive, "local-environment-check.json")).catch(error => {
    if (error.code === "ENOENT") return { revision: setup.revision, status: setup.configured ? "unchecked" : "unconfigured", checkedAt: null, items: [] };
    throw error;
  });
  if (report.revision !== setup.revision) return { revision: setup.revision, status: "unchecked", checkedAt: null, items: [] };
  return report;
}

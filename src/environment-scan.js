import { promises as fs } from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { manifest, manifestHash, sha256 } from "./files.js";
import { initializationCommands } from "./project-initialization.js";

const secretName = name => /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|(?:database|datasource)[_-]?url/i.test(name);
const field = (key, label, type, required, envName = null) => ({ key, label, type, required, envName,
  secret: type === "password", requirement: required ? "required" : "optional" });

function flattened(value, prefix = "", result = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("环境配置 YAML 必须是映射结构。");
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item)) flattened(item, name, result);
    else result[name] = item;
  }
  return result;
}

function properties(text) {
  const result = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || /^[\s]*[#!]/.test(line)) continue;
    const match = line.match(/^\s*([^\s=:]+)\s*[=:]\s*(.*)$/);
    if (!match || /\\$/.test(line)) throw new Error(`不支持的 properties 配置结构，第 ${index + 1} 行，请改用标准 YAML 或单行键值声明。`);
    result[match[1]] = match[2];
  }
  return result;
}

function dependency(kind, app, evidence, requirement, reason) {
  const database = ["mysql", "postgres"].includes(kind);
  return { id: `${kind}:${app.directory}`, kind, name: kind === "mysql" ? "MySQL" : kind === "postgres" ? "PostgreSQL" : "Redis",
    owners: [app.id], directory: app.directory, requirement, reason, evidence, effects: [],
    fields: [field("host", "主机", "host", true), field("port", "端口", "port", true),
      ...(database ? [field("database", "数据库", "input", true), field("username", "用户名", "input", true, "SPRING_DATASOURCE_USERNAME")] : []),
      field("password", "密码", "password", false, database ? "SPRING_DATASOURCE_PASSWORD" : "SPRING_DATA_REDIS_PASSWORD")],
    bindings: database ? { url: "SPRING_DATASOURCE_URL" } : { host: "SPRING_DATA_REDIS_HOST", port: "SPRING_DATA_REDIS_PORT" } };
}

function springDependencies(app, config, source) {
  const result = [];
  const url = config["spring.datasource.url"];
  if (typeof url === "string" && /^jdbc:(mysql|postgresql):/.test(url) && !/\$\{/.test(url)) {
    const kind = url.startsWith("jdbc:mysql:") ? "mysql" : "postgres";
    const required = String(config["spring.sql.init.mode"]) === "always";
    const item = dependency(kind, app, [source], required ? "required" : "unknown", required
      ? "配置明确要求启动时初始化数据库，必须先连接数据库。" : "发现数据源配置；是否在启动阶段连接，需研发确认。" );
    if (!/\$\{/.test(url)) {
      const parsed = new URL(url.replace(/^jdbc:/, "").replace(/^mysql:/, "http:").replace(/^postgresql:/, "http:"));
      item.fields.find(row => row.key === "host").reference = parsed.hostname.replace(/^\[|\]$/g, "");
      item.fields.find(row => row.key === "port").reference = parsed.port;
      item.fields.find(row => row.key === "database").reference = decodeURIComponent(parsed.pathname.slice(1));
      const safeParameters = /^(useUnicode|characterEncoding|useSSL|allowPublicKeyRetrieval|allowMultiQueries|useAffectedRows|serverTimezone|sslmode|connectTimeout|socketTimeout|tcpKeepAlive|zeroDateTimeBehavior)$/;
      item.parameters = {};
      for (const [key, value] of parsed.searchParams) {
        if (!safeParameters.test(key) || !/^[A-Za-z0-9_./%+-]{1,128}$/.test(value))
          throw new Error(`${source} 包含无法安全展示的 JDBC 参数，请将额外连接参数改为验证专用配置声明后重新扫描。`);
        item.parameters[key] = value;
      }
      if (parsed.username || parsed.password) throw new Error(`${source} 的 JDBC 地址含凭据，请使用独立用户名和密码配置。`);
    }
    Object.assign(item.fields.find(row => row.key === "password"), { required: Boolean(config["spring.datasource.password"]),
      requirement: config["spring.datasource.password"] ? "required" : "optional" });
    if (required) item.effects.push("启动会执行数据库初始化；请核对项目中的 SQL 和启动回调，连接检查不执行这些操作。");
    result.push(item);
  } else if (url !== undefined) {
    const item = { id: `datasource:${app.directory}`, kind: "environment", name: "数据库连接", owners: [app.id],
      directory: app.directory, requirement: String(config["spring.sql.init.mode"]) === "always" ? "required" : "unknown",
      reason: "发现数据源声明，需提供验证专用连接。", evidence: [source], effects: [], bindings: {},
      fields: [field("SPRING_DATASOURCE_URL", "数据库连接地址", "password", true, "SPRING_DATASOURCE_URL"),
        field("SPRING_DATASOURCE_USERNAME", "用户名", "input", true, "SPRING_DATASOURCE_USERNAME"),
        field("SPRING_DATASOURCE_PASSWORD", "密码", "password", Boolean(config["spring.datasource.password"]), "SPRING_DATASOURCE_PASSWORD")] };
    result.push(item);
  }
  const prefix = Object.keys(config).some(key => key.startsWith("spring.data.redis.")) ? "spring.data.redis" : "spring.redis";
  if (Object.keys(config).some(key => key.startsWith(`${prefix}.`))) {
    const item = dependency("redis", app, [source], "unknown", "发现 Redis 配置，未证明启动一定连接；请确认本次是否需要。");
    const envPrefix = prefix === "spring.redis" ? "SPRING_REDIS" : "SPRING_DATA_REDIS";
    item.bindings = { host: `${envPrefix}_HOST`, port: `${envPrefix}_PORT` };
    item.fields.at(-1).envName = `${envPrefix}_PASSWORD`;
    Object.assign(item.fields.at(-1), { required: Boolean(config[`${prefix}.password`]),
      requirement: config[`${prefix}.password`] ? "required" : "optional" });
    for (const key of ["host", "port"]) if (config[`${prefix}.${key}`] !== undefined && !/\$\{/.test(String(config[`${prefix}.${key}`])))
      item.fields.find(row => row.key === key).reference = String(config[`${prefix}.${key}`]);
    result.push(item);
  }
  return result;
}

function collectEnvironmentFields(file, text, app, warnings) {
  if (!app || !/\.(?:[cm]?jsx?|tsx?|vue|py|java)$/.test(file)) return;
  const expressions = /(?:(?:process\.env|import\.meta\.env)\.([A-Za-z_][A-Za-z0-9_]*)|(?:process\.env|import\.meta\.env|os\.environ)\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]|(?:os\.getenv|System\.getenv)\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\))/g;
  for (const match of text.matchAll(expressions)) {
    const name = match[1] || match[2] || match[3];
    if (["NODE_ENV", "PATH", "HOME", "PWD", "MODE", "DEV", "PROD", "BASE_URL", "SSR"].includes(name)) continue;
    const remainder = text.slice(match.index + match[0].length, match.index + match[0].length + 120);
    const defaultValue = remainder.match(/^\s*(?:\|\||\?\?)\s*(?:['"]([^'"\n]*)['"]|(\d+))/);
    const existing = app.fields.find(row => row.key === name);
    const item = existing ?? field(name, name, secretName(name) ? "password" : "input", !defaultValue, name);
    const reference = defaultValue?.[1] ?? defaultValue?.[2];
    if (reference && /:\/\/[^/]*@|[?&](?:password|token|api[_-]?key|secret)=/i.test(reference)) { item.secret = true; item.type = "password"; }
    if (!defaultValue && (!existing || item.requirement !== "required")) { item.requirement = "unknown"; item.required = true; }
    item.evidence = [...new Set([...(item.evidence ?? []), `${file}:${text.slice(0, match.index).split("\n").length}`])];
    item.reason = item.requirement === "unknown" ? "源码读取此变量；是否必需需研发确认。" : "源码提供默认值，可按需覆盖。";
    if (defaultValue && item.secret && reference) {
      item.required = true; item.requirement = "required";
      item.reason = "源码提供凭据默认值，请填写验证专用值，避免使用原凭据。";
    }
    if (item.secret) {
      delete item.reference;
      if (item.requirement === "required") item.reason = "源码提供凭据默认值，请填写验证专用值，避免使用原凭据。";
    }
    if (!existing) { if (defaultValue && !item.secret) item.reference = reference; app.fields.push(item); }
  }
  if (/process\.env\[(?!['"])/.test(text)) warnings.push(`${file} 动态读取环境变量，无法静态确定名称，请研发核对。`);
}

async function collectSpringConfiguration(sources, apps, dependencies, warnings) {
  for (const app of apps.filter(row => row.runtime === "spring")) {
    const configuration = [...sources].filter(([file]) => (app.directory === "." || file.startsWith(`${app.directory}/`))
      && /(^|\/)application\.(properties|ya?ml)$/.test(file));
    if (configuration.length > 1) throw new Error(`${app.directory} 存在多个基础 Spring 配置，请明确使用一个配置文件。`);
    for (const [file, text] of configuration) {
      const documents = file.endsWith("properties") ? [properties(text)] : parseAllDocuments(text, { prettyErrors: false }).map(doc => {
        if (doc.errors.length) throw new Error(`${file} YAML 解析失败：${doc.errors.map(error => error.code).join("；")}，请修正配置语法。`);
        return flattened(doc.toJSON());
      });
      if (documents.length > 1) warnings.push(`${file} 包含多个配置文档，本次仅扫描基础文档；请核对启用的 profile。`);
      const config = documents[0]; dependencies.push(...springDependencies(app, config, file));
      if (Object.keys(config).some(key => /^spring\.profiles\.(active|include|group)|^spring\.config\.(import|location|additional-location)/.test(key)))
        app.scanErrors = [`${file} 引用了额外 Spring 配置；当前扫描未解析此组合，请研发整理验证所需的基础配置后重新扫描。`];
      if (documents.length > 1) app.scanErrors = [`${file} 包含多个配置文档，当前扫描未解析 profile 组合，请明确验证配置后重新扫描。`];
      for (const [key, value] of Object.entries(config)) {
        if (typeof value !== "string" || /^(spring\.datasource\.|spring\.(?:data\.)?redis\.)/.test(key)) continue;
        for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g)) {
          const name = match[1]; const item = field(name, key, secretName(name) || secretName(key)
            || /:\/\/[^/]*@|[?&](?:password|token|api[_-]?key|secret)=/i.test(match[2] ?? "") ? "password" : "input", match[2] === undefined, name);
          item.evidence = [file]; item.reason = match[2] === undefined ? "配置声明必需变量。" : "配置已提供默认值。";
          if (match[2] !== undefined && !item.secret) item.reference = match[2];
          if (!app.fields.some(row => row.key === name)) app.fields.push(item);
        }
      }
      if (String(config["spring.sql.init.mode"]) === "always") app.effects.push("启动会初始化数据库，可能建表或更新数据。");
    }
    for (const [file, text] of sources) if (file.endsWith(".java") && (app.directory === "." || file.startsWith(`${app.directory}/`))
      && /CommandLineRunner|ApplicationRunner/.test(text))
      app.effects.push(`发现启动回调，需核对其调用的数据操作：${file}。`);
    for (const [file] of sources) if (/application-[^/]+\.(properties|ya?ml)$/.test(file) && file.startsWith(`${app.directory}/`))
      warnings.push(`${file} 是 profile 配置，本次未启用；如需使用，请先在方案中明确启动 profile。`);
  }
}

export async function scanLocalEnvironment(project, root = project.root) {
  const snapshot = await manifest(root, project.config.excludedPaths, project.config.maxSnapshotBytes);
  const files = Object.keys(snapshot).filter(file => !/(^|\/)(target|dist|build|coverage|vendor)(\/|$)/.test(file));
  const sources = new Map(); const warnings = []; const apps = []; const dependencies = [];
  for (const file of files.filter(file => /(?:package\.json|pom\.xml|application[^/]*\.(?:properties|ya?ml)|(?:compose|docker-compose[^/]*)\.ya?ml|Jenkinsfile|\.gitlab-ci\.yml|\.github\/workflows\/[^/]+\.ya?ml)$|\.(?:[cm]?jsx?|tsx?|vue|java|py)$/.test(file))) {
    sources.set(file, await fs.readFile(path.join(root, file), "utf8"));
  }
  for (const [file, text] of sources) {
    if (!file.endsWith("package.json")) continue;
    let pkg;
    try { pkg = JSON.parse(text); } catch { throw new Error(`${file} JSON 语法错误，请修正项目配置后重新扫描。`); }
    const directory = path.posix.dirname(file);
    const scripts = Object.keys(pkg.scripts ?? {}).filter(name => /^(start|dev|serve)(:|$)/.test(name));
    if (!scripts.length) continue;
    const frontend = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(name => /^(vue|react|vite|next|@angular\/core|svelte)$/.test(name))
      || /(^|\/)(frontend|client|web)(\/|$)/.test(`${directory}/`);
    const commands = initializationCommands({ packages: [{ ...pkg, path: file, scripts }], checks: [], files: snapshot }).map(row => row.argv);
    apps.push({ id: `app:${directory}`, kind: "application", runtime: "node", role: frontend ? "frontend" : "service",
      name: frontend ? `前端${directory === "." ? "" : ` · ${directory}`}` : `服务 · ${pkg.name ?? directory}`,
      directory, commands, fields: [], evidence: [file], effects: [], requirement: "required", reason: "所选目标的应用服务。" });
  }
  for (const [file, text] of sources) {
    if (!file.endsWith("pom.xml") || !/spring-boot/.test(text)) continue;
    if (/<packaging>\s*pom\s*<\/packaging>/.test(text)) { warnings.push(`${file} 是 Maven 聚合项目，启动入口按子模块识别。`); continue; }
    const directory = path.posix.dirname(file);
    const app = { id: `app:${directory}`, kind: "application", runtime: "spring", role: "backend", name: `后端 · ${directory}`,
      directory, commands: [["mvn", ...(directory === "." ? [] : ["-f", file]), "spring-boot:run"]],
      fields: [], evidence: [file], effects: [], requirement: "required", reason: "所选目标的 Spring Boot 服务。" };
    if (apps.some(row => row.id === app.id)) throw new Error(`${directory} 同时包含多个运行入口，请拆分服务目录后扫描。`);
    apps.push(app);
  }
  if (!apps.length) apps.push({ id: "app:.", kind: "application", runtime: "project", role: "service", name: "项目验证",
    directory: ".", commands: [], fields: [], evidence: [], effects: [], requirement: "required", reason: "未发现常驻服务入口；具体启动由研发方案确定。" });
  const owner = file => apps.filter(app => app.directory === "." || file.startsWith(`${app.directory}/`))
    .sort((a, b) => b.directory.length - a.directory.length)[0];
  for (const [file, text] of sources) {
    const app = owner(file);
    if (app) collectEnvironmentFields(file, text, app, warnings);
    else if (/process\.env|import\.meta\.env|os\.(?:getenv|environ)|System\.getenv/.test(text)) {
      warnings.push(`${file} 位于服务目录外，读取的变量按共享配置列入服务，请研发核对归属。`);
      for (const service of apps) collectEnvironmentFields(file, text, service, warnings);
    }
  }
  await collectSpringConfiguration(sources, apps, dependencies, warnings);
  for (const [file] of sources) if (/(^|\/)(?:compose|docker-compose[^/]*)\.ya?ml$/.test(file))
    warnings.push(`${file} 声明容器环境；本次扫描面向源码启动，不执行容器编排，请核对服务对应关系。`);
  for (const name of project.config.environment.localDeployment) {
    const app = apps.find(row => row.directory === ".") ?? apps[0];
    const existing = app.fields.find(row => row.key === name);
    if (existing) { existing.required = true; existing.requirement = "required"; existing.reason = "项目执行规则声明此变量为必需。"; }
    else app.fields.push({ ...field(name, name, secretName(name) ? "password" : "input", true, name),
      reason: "项目执行规则声明此变量为必需。", evidence: ["项目执行规则"] });
  }
  for (const app of apps) {
    const example = path.join(root, app.directory, ".env.example");
    const info = await fs.lstat(example).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) continue;
    if (!info.isFile() || info.size > 262144) throw new Error(`${app.directory}/.env.example 必须是小于256 KiB的普通文件。`);
    const { parseEnv } = await import("node:util");
    for (const name of Object.keys(parseEnv(await fs.readFile(example, "utf8")))) {
      if (!app.fields.some(row => row.key === name)) app.fields.push({ ...field(name, name, secretName(name) ? "password" : "input", true, name),
        requirement: "unknown", reason: "示例文件声明此变量，是否必需需研发确认。", evidence: [`${app.directory}/.env.example`] });
    }
  }
  const pipelines = [...sources.keys()].filter(file => /(^|\/)(Jenkinsfile|\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml)$/.test(file));
  const scan = { schemaVersion: 1, services: [...apps, ...dependencies], pipelines, warnings };
  return { ...scan, hash: sha256(JSON.stringify(scan)), sourceHash: manifestHash(snapshot), scannedAt: new Date().toISOString() };
}

export function selectedEnvironmentServices(scan, target) {
  const apps = scan.services.filter(row => row.kind === "application" && (target === "all"
    || target === "frontend" && row.role === "frontend" || row.id === target));
  if (!apps.length) throw new Error("所选启动目标不存在，请重新扫描并选择服务。");
  return scan.services.filter(row => apps.includes(row) || row.owners?.some(id => apps.some(app => app.id === id)));
}

export function environmentScanDiff(previous, next) {
  const before = new Map((previous?.services ?? []).map(row => [row.id, row]));
  const after = new Map(next.services.map(row => [row.id, row]));
  const diff = { added: next.services.filter(row => !before.has(row.id)).map(row => row.name),
    removed: [...before.values()].filter(row => !after.has(row.id)).map(row => row.name),
    changed: next.services.filter(row => before.has(row.id) && JSON.stringify(before.get(row.id)) !== JSON.stringify(row)).map(row => row.name) };
  for (const service of next.services.filter(row => before.has(row.id))) {
    const oldFields = new Map(before.get(service.id).fields.map(field => [field.key, field]));
    const newFields = new Map(service.fields.map(field => [field.key, field]));
    for (const field of service.fields) if (!oldFields.has(field.key)) diff.added.push(`${service.name} · ${field.label}`);
    for (const field of oldFields.values()) if (!newFields.has(field.key)) diff.removed.push(`${service.name} · ${field.label}`);
  }
  if (previous && JSON.stringify(previous.pipelines) !== JSON.stringify(next.pipelines)) diff.changed.push("测试流水线入口");
  if (previous && JSON.stringify(previous.warnings) !== JSON.stringify(next.warnings)) diff.changed.push("扫描注意事项");
  return diff;
}

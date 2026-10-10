import { promises as fs } from "node:fs";
import path from "node:path";
import { manifest, manifestHash, readJson, sha256, writeAtomic, writeJson } from "./files.js";
import { withLock } from "./store.js";
import { renderProjectHandbook } from "./project-handbook.js";
import { describePolicy } from "./config.js";

const manifestNames = new Set(["package.json", "pom.xml", "build.gradle", "build.gradle.kts",
  "requirements.txt", "pyproject.toml", "Pipfile", "go.mod", "Cargo.toml", "composer.json",
  "Gemfile", "pubspec.yaml"]);
const markers = {
  frontend: [/^(react|react-dom|next|vue|nuxt|@angular\/core|svelte|@sveltejs\/kit|vite|astro)$/i],
  backend: [/^(node:https?|express|fastify|koa|@nestjs\/core|hono|django|flask|fastapi|spring-boot.*|gin-gonic\/gin)$/i,
    /(:spring-boot-starter-|\/gin-gonic\/gin$)/i],
  database: [/^(prisma|@prisma\/client|typeorm|sequelize|knex|drizzle-orm|mongoose|pg|mysql2?|better-sqlite3|sqlite3|psycopg.*|sqlalchemy)$/i,
    /(:spring-boot-starter-data-|:postgresql$|:mysql-connector-)/i],
  middleware: [/^(redis|ioredis|bull|bullmq|amqplib|kafkajs|@elastic\/elasticsearch|elasticsearch|memcached)$/i,
    /(:spring-boot-starter-data-redis|:spring-kafka)/i],
};
const sourceRootPattern = /^(src|app|apps|pages|client|frontend|web|server|backend|api|service|services|packages|pkg|cmd|internal|lib|libs|module|modules|ui|application|domain|infrastructure)(\/|$)/;

function matches(file, expression) { return expression.test(file.split("/").at(-1)); }

function fileEvidence(files, expression) {
  return files.filter((file) => expression.test(file)).sort();
}

function dependencyMatches(dependencies, expressions) {
  return dependencies.filter((item) => expressions.some((expression) => expression.test(item.name)))
    .map((item) => ({ name: item.name, version: item.version, evidence: item.evidence }));
}

async function packageEvidence(project, files, source) {
  const packages = [];
  const dependencies = [];
  for (const file of files.filter((item) => matches(item, /^package\.json$/))) {
    if (source[file].bytes > 262144) throw new Error(`Package manifest exceeds 256 KB: ${file}`);
    const value = await readJson(path.join(project.root, file));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid package manifest: ${file}`);
    const declared = { ...value.dependencies, ...value.devDependencies, ...value.peerDependencies,
      ...value.optionalDependencies };
    for (const [name, version] of Object.entries(declared)) {
      if (typeof version !== "string") throw new Error(`Invalid dependency version in ${file}: ${name}`);
      dependencies.push({ name, version, evidence: file });
    }
    packages.push({ path: file, name: value.name ?? null, description: typeof value.description === "string" ? value.description.slice(0, 500) : null,
      engines: value.engines ?? {}, packageManager: value.packageManager ?? null,
      scripts: Object.keys(value.scripts ?? {}).sort(),
      workspaces: value.workspaces ?? null, dependencyCount: Object.keys(declared).length });
  }
  return { packages, dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)) };
}

async function otherDependencyEvidence(project, files, source) {
  const dependencies = [];
  const unparsed = [];
  for (const file of files.filter((item) => manifestNames.has(item.split("/").at(-1)) && !matches(item, /^package\.json$/))) {
    if (source[file].bytes > 262144) throw new Error(`Dependency manifest exceeds 256 KB: ${file}`);
    const name = file.split("/").at(-1);
    const content = await fs.readFile(path.join(project.root, file), "utf8");
    let found = 0;
    if (name === "requirements.txt") {
      for (const line of content.split(/\r?\n/)) {
        const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_.-]*)(\s*(?:==|~=|>=|<=|>|<)\s*[^;#\s]+)?/);
        if (match) { dependencies.push({ name: match[1], version: match[2]?.trim() ?? null, evidence: file }); found++; }
      }
    } else if (name === "pom.xml") {
      for (const match of content.matchAll(/<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/g)) {
        dependencies.push({ name: `${match[1]}:${match[2]}`, version: null, evidence: file }); found++;
      }
    } else if (name.startsWith("build.gradle")) {
      for (const match of content.matchAll(/(?:implementation|api|runtimeOnly|testImplementation)\s*\(?["']([^"']+:[^"']+)["']/g)) {
        dependencies.push({ name: match[1].split(":").slice(0, 2).join(":"),
          version: match[1].split(":").slice(2).join(":") || null, evidence: file }); found++;
      }
    } else if (name === "go.mod") {
      for (const match of content.matchAll(/^\s*([A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+\/[^\s]+)\s+(v[^\s]+)/gm)) {
        dependencies.push({ name: match[1], version: match[2], evidence: file }); found++;
      }
    }
    unparsed.push(`${file}（提取 ${found} 项；此格式只支持部分静态声明）`);
  }
  return { dependencies, unparsed };
}

async function sourceDeclarations(project, files, source) {
  const apiRoutes = [];
  const dataModels = [];
  const oversized = [];
  const environmentNames = [];
  const publicSymbols = [];
  const localImports = [];
  const testCases = [];
  const runtimeModules = [];
  for (const file of files.filter((item) => /\.(?:js|jsx|ts|tsx|mjs|py|java|prisma|sql)$/i.test(item))) {
    if (source[file].bytes > 262144) { oversized.push(file); continue; }
    const content = await fs.readFile(path.join(project.root, file), "utf8");
    for (const match of content.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      publicSymbols.push({ name: match[1], evidence: `${file}:${content.slice(0, match.index).split("\n").length}` });
    }
    for (const match of content.matchAll(/^import\s+[^;]*?\s+from\s*["'](node:[^"']+)["']/gm)) {
      runtimeModules.push({ name: match[1], version: null, evidence: `${file}:${content.slice(0, match.index).split("\n").length}` });
    }
    for (const match of content.matchAll(/\breq\.method\s*===\s*["'](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)["']\s*&&\s*pathname\s*===\s*["']([^"']+)["']/g)) {
      apiRoutes.push({ method: match[1], route: match[2], evidence: `${file}:${content.slice(0, match.index).split("\n").length}` });
    }
    for (const match of content.matchAll(/\b(?:from\s+|import\s*)["'](\.[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (Object.hasOwn(source, target)) localImports.push({ from: file, to: target,
        evidence: `${file}:${content.slice(0, match.index).split("\n").length}` });
    }
    if (/(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(file)) {
      for (const match of content.matchAll(/\b(?:test|it|describe)\(\s*["']([^"'\n]{1,240})["']/g)) {
        testCases.push({ name: match[1], evidence: `${file}:${content.slice(0, match.index).split("\n").length}` });
      }
    }
    for (const match of content.matchAll(/(?:process\.env\.|os\.environ\[\s*["']|os\.getenv\(\s*["']|System\.getenv\(\s*["'])([A-Z][A-Z0-9_]*)/g)) {
      environmentNames.push({ name: match[1], evidence: `${file}:${content.slice(0, match.index).split("\n").length}` });
    }
    for (const match of content.matchAll(/\b(?:app|router|server)\.(get|post|put|patch|delete|options|head)\(\s*["'`]([^"'`]+)["'`]/gi)) {
      apiRoutes.push({ method: match[1].toUpperCase(), route: match[2],
        evidence: `${file}:${content.slice(0, match.index).split("\n").length}` });
    }
    for (const match of content.matchAll(/@(?:Get|Post|Put|Patch|Delete|Request)Mapping\(\s*["']([^"']+)["']/g)) {
      apiRoutes.push({ method: match[0].slice(1).split("Mapping")[0].toUpperCase(),
        route: match[1], evidence: `${file}:${content.slice(0, match.index).split("\n").length}` });
    }
    for (const match of content.matchAll(/^\s*(?:model\s+([A-Za-z][\w]*)\s*\{|CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z][\w.]*)[`"]?)/gmi)) {
      dataModels.push({ name: match[1] ?? match[2],
        kind: match[1] ? "prisma-model" : "sql-table",
        evidence: `${file}:${content.slice(0, match.index).split("\n").length}` });
    }
    if (apiRoutes.length + dataModels.length > 1000) throw new Error("Project baseline has more than 1,000 static declarations");
  }
  return { apiRoutes, dataModels, oversized, environmentNames, publicSymbols, localImports, testCases, runtimeModules };
}

export async function buildProjectBaseline(project) {
  const source = await manifest(project.root, project.config.excludedPaths, project.config.maxSnapshotBytes);
  const files = Object.keys(source).sort();
  if (files.length > 10000) throw new Error("Project baseline supports at most 10,000 source files");
  const node = await packageEvidence(project, files, source);
  const other = await otherDependencyEvidence(project, files, source);
  const declarations = await sourceDeclarations(project, files, source);
  const overviewEvidence = [];
  const readmes = files.filter((file) => /(^|\/)README\.md$/i.test(file))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const file of readmes.slice(0, 3)) {
    if (source[file].bytes > 262144) continue;
    const lines = (await fs.readFile(path.join(project.root, file), "utf8")).split(/\r?\n/);
    const index = lines.findIndex((line) => line.trim() && !/^(?:#|>|```|\s*[-*]|!\[|<|\[!)/.test(line));
    if (index >= 0) overviewEvidence.push({ text: lines.slice(index).join("\n").split(/\n\s*\n/)[0].slice(0, 800),
      evidence: `${file}:${index + 1}` });
  }
  const dependencies = [...node.dependencies, ...other.dependencies].sort((a, b) => a.name.localeCompare(b.name));
  const components = Object.fromEntries(Object.entries(markers).map(([kind, expressions]) =>
    [kind, dependencyMatches([...dependencies, ...declarations.runtimeModules], expressions)]));
  const moduleCounts = new Map();
  for (const file of files.filter((item) => sourceRootPattern.test(item))) {
    const parts = file.split("/");
    const modulePath = parts.slice(0, Math.min(2, parts.length - 1)).join("/") || parts[0];
    moduleCounts.set(modulePath, (moduleCounts.get(modulePath) ?? 0) + 1);
  }
  const paths = {
    sourceRoots: [...new Set(files.filter((file) => sourceRootPattern.test(file))
      .map((file) => file.split("/").slice(0, Math.min(file.startsWith("packages/") || file.startsWith("apps/") ? 2 : 1, file.split("/").length)).join("/")))].sort(),
    entrypoints: fileEvidence(files, /(^|\/)(main|index|app|server|cli|.*-server|manage|Application)\.(jsx?|tsx?|mjs|cjs|py|go|java)$/i),
    frontend: fileEvidence(files, /(^|\/)(pages?|components?|views?|client|frontend|web)(\/|$)|\.(jsx|tsx|vue|svelte)$/i),
    backend: fileEvidence(files, /(^|\/)(controllers?|handlers?|routes?|server|.*-server|backend|api)(\/|\.|$)/i),
    interfaces: fileEvidence(files, /(^|\/)(routes?|controllers?|handlers?|api|openapi|swagger|schema\.graphql|.*\.proto)(\/|\.|$)/i),
    database: fileEvidence(files, /(^|\/)(migrations?|prisma|schema\.prisma|.*\.sql|models?|entities)(\/|\.|$)/i),
    middleware: fileEvidence(files, /(^|\/)(redis|kafka|rabbitmq|nginx|traefik|queue|workers?)(\/|\.|$)/i),
    tests: fileEvidence(files, /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/i),
    deployment: fileEvidence(files, /(^|\/)(Dockerfile|compose\.ya?ml|docker-compose[^/]*|Jenkinsfile|\.github\/workflows|k8s|helm|terraform)(\/|\.|$)/i),
    manifests: files.filter((file) => manifestNames.has(file.split("/").at(-1))),
    documentation: fileEvidence(files, /(^|\/)(README[^/]*|docs\/.*\.(md|mdx)|.*(?:architecture|design|adr).*\.md)$/i),
    quality: fileEvidence(files, /(^|\/)(.*eslint.*|.*prettier.*|\.editorconfig|checkstyle[^/]*|pmd[^/]*|ruff\.toml|pyproject\.toml|.*spotbugs.*)$/i),
    migrations: fileEvidence(files, /(^|\/)(migrations?|flyway|liquibase)(\/|$)|(^|\/)V\d+[^/]*\.sql$/i),
  };
  const unknowns = ["运行环境、实际服务拓扑与依赖连通性尚未验证", "现有接口兼容性和历史数据约束需按需求核实"];
  for (const kind of ["frontend", "backend", "database", "middleware"]) {
    if (!components[kind].length) unknowns.push(`${kind} 技术栈未从已解析依赖中确认`);
  }
  if (other.unparsed.length) unknowns.push(`${other.unparsed.length} 个依赖清单未完整解析：${other.unparsed.slice(0, 20).join(", ")}`);
  if (declarations.oversized.length) unknowns.push(`${declarations.oversized.length} 个超过 256 KB 的源文件未提取声明：${declarations.oversized.slice(0, 20).join(", ")}`);
  const baseline = { schemaVersion: 1, root: project.root,
    reportVersion: 3,
    policy: { allowedPaths: project.config.allowedPaths, excludedPaths: project.config.excludedPaths,
      mode: project.config.mode, globalRules: project.config.codingStandards?.globalRules ?? [],
      baseBranch: project.config.baseBranch ?? null, releaseBranch: project.config.releaseBranch ?? null },
    configHash: describePolicy(project.config).executionConfigHash, sourceHash: manifestHash(source),
    sourceFileCount: files.length, sourceBytes: Object.values(source).reduce((sum, item) => sum + item.bytes, 0),
    files: source, modules: [...moduleCounts].map(([modulePath, fileCount]) => ({ path: modulePath, fileCount }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    packages: node.packages, overviewEvidence, dependencies, components, paths, declarations, unknowns,
    checks: project.config.checks, testDeployment: project.config.testDeployment.kind,
    productionDeployment: project.config.productionDeployment.kind };
  if (manifestHash(await manifest(project.root, project.config.excludedPaths,
    project.config.maxSnapshotBytes)) !== baseline.sourceHash) {
    throw new Error("Project files changed during baseline scan");
  }
  return { ...baseline, snapshotHash: sha256(JSON.stringify(baseline)), generatedAt: new Date().toISOString() };
}

function baselineFacts(baseline) {
  const { snapshotHash, generatedAt, ...facts } = baseline;
  return facts;
}

async function baselineEvents(project) {
  const file = path.join(project.archive, "baseline-events.jsonl");
  const rows = await fs.readFile(file, "utf8").then((content) =>
    content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let previous = null;
  for (const row of rows) {
    if (row.previous !== previous || row.hash !== sha256(JSON.stringify({ ...row, hash: undefined }))) {
      throw new Error("Project baseline audit chain changed");
    }
    previous = row.hash;
  }
  return rows;
}

export async function readProjectBaseline(project, sourceHash = null, requireCurrent = true) {
  const baseline = await readJson(path.join(project.archive, "baseline.json")).catch((error) => {
    if (error.code === "ENOENT") throw new Error("Project baseline is missing; run baseline-refresh before continuing", { cause: error });
    throw error;
  });
  if (baseline.schemaVersion !== 1 || baseline.root !== project.root
      || baseline.snapshotHash !== sha256(JSON.stringify(baselineFacts(baseline)))) {
    throw new Error("Project baseline is invalid or changed");
  }
  const matchingEvents = (await baselineEvents(project)).filter((event) => event.snapshotHash === baseline.snapshotHash);
  if (!matchingEvents.some((event) => event.at === baseline.generatedAt)) {
    throw new Error("Project baseline does not match its audit history");
  }
  const archived = await readJson(path.join(project.archive, "baselines", `${baseline.snapshotHash}.json`));
  if (archived.snapshotHash !== sha256(JSON.stringify(baselineFacts(archived)))
      || JSON.stringify(baselineFacts(archived)) !== JSON.stringify(baselineFacts(baseline))
      || matchingEvents.some((event) => event.archiveHash !== sha256(JSON.stringify(archived)))) {
    throw new Error("Archived project baseline differs from the current baseline");
  }
  if (!requireCurrent) return baseline;
  if (baseline.configHash !== (baseline.reportVersion >= 3 ? describePolicy(project.config).executionConfigHash : sha256(JSON.stringify(project.config)))) {
    throw new Error("Project configuration changed; run baseline-refresh before continuing");
  }
  const currentHash = sourceHash ?? manifestHash(await manifest(project.root,
    project.config.excludedPaths, project.config.maxSnapshotBytes));
  if (baseline.sourceHash !== currentHash) {
    throw new Error("Project source changed since baseline initialization; run baseline-refresh before continuing");
  }
  const report = await fs.readFile(path.join(project.archive, "baseline.md"), "utf8");
  if (report !== renderProjectBaseline(baseline)) {
    throw new Error("Project baseline report changed; run baseline-refresh before continuing");
  }
  return baseline;
}

export function baselinePromptSummary(baseline) {
  const detected = Object.fromEntries(Object.entries(baseline.components).map(([kind, rows]) =>
    [kind, rows.map((item) => `${item.name} (${item.evidence})`).slice(0, 12)]));
  return JSON.stringify({ baselineHash: baseline.snapshotHash, sourceHash: baseline.sourceHash,
    detected, modules: baseline.modules.slice(0, 20), sourceRoots: baseline.paths.sourceRoots.slice(0, 16),
    apiRoutes: baseline.declarations.apiRoutes.slice(0, 12),
    dataModels: baseline.declarations.dataModels.slice(0, 12),
    interfaceFiles: baseline.paths.interfaces.slice(0, 12),
    dataFiles: baseline.paths.database.slice(0, 12),
    testFiles: baseline.paths.tests.slice(0, 12), unknowns: baseline.unknowns.slice(0, 8) });
}

export async function baselineAgentContext(project, baseline, focusFiles = null, detail = "full") {
  if (!["full", "index"].includes(detail)) throw new Error("Project context detail must be full or index");
  if (focusFiles !== null && (!Array.isArray(focusFiles) || !focusFiles.length || focusFiles.some(file => typeof file !== "string" || !file))) throw new Error("Focused project context requires explicit file paths");
  const mode = await readJson(path.join(project.archive, "documentation-mode.json"));
  if (mode.mode === "inventory") return baselinePromptSummary(baseline);
  if (mode.mode !== "agent") throw new Error("Invalid project documentation mode");
  const { readInitialization } = await import("./project-initialization.js");
  const initialized = await readInitialization(project, baseline);
  const ruleFiles = Object.keys(baseline.files).filter(file => /(^|\/)(AGENTS(?:\.override)?|CLAUDE)\.md$/.test(file));
  if (detail === "index") {
    const understanding = initialized.metadata.understanding;
    return JSON.stringify({ baselineHash: baseline.snapshotHash, sourceHash: baseline.sourceHash,
      overview: { ...understanding.overview, text: understanding.overview.text.slice(0, 500), textPartial: understanding.overview.text.length > 500 },
      conventions: understanding.conventions.slice(0, 4).map(row => ({ ...row, text: row.text.slice(0, 180), textPartial: row.text.length > 180 })),
      ruleFiles: ruleFiles.filter(file => path.posix.dirname(file) === "." || focusFiles?.some(target => target.startsWith(`${path.posix.dirname(file)}/`))),
      note: "Project handbook and rule originals remain on disk. Read relevant source and rule sections using grep/read when a decision depends on them; this index is not proof of current behavior." });
  }
  const projectRules = [];
  for (const file of ruleFiles) {
    const scope = path.posix.dirname(file);
    if (scope !== "." && (focusFiles === null || !focusFiles.some(target => target.startsWith(`${scope}/`)))) continue;
    const text = await fs.readFile(path.join(project.root, file), "utf8");
    if (sha256(text) !== baseline.files[file].hash) throw new Error(`Project rule source changed: ${file}`);
    projectRules.push({ file, scope, text });
  }
  const navigation = [];
  const entrypoints = [...baseline.paths.entrypoints].sort((a, b) =>
    Number(/(?:^|\/)(?:main|cli|server)\./i.test(b)) - Number(/(?:^|\/)(?:main|cli|server)\./i.test(a)));
  for (const file of entrypoints.slice(0, 4)) {
    const content = await fs.readFile(path.join(project.root, file), "utf8");
    if (sha256(content) !== baseline.files[file].hash) throw new Error(`Navigation source changed: ${file}`);
    const symbols = [];
    for (const [index, line] of content.split("\n").entries()) {
      const match = line.match(/^(?:export\s+)?(?:async\s+)?(?:def|function|class)\s+([\w$]+)/);
      if (match) symbols.push(`${match[1]}:${index + 1}`);
    }
    navigation.push({ file, symbols: symbols.slice(0, 80) });
  }
  return JSON.stringify({ baselineHash: baseline.snapshotHash, sourceHash: baseline.sourceHash,
    projectGuide: {
      overview: initialized.metadata.understanding.overview,
      architecture: initialized.metadata.understanding.architecture.filter(row => focusFiles === null || row.evidence.some(reference => focusFiles.some(file => reference.startsWith(`${file}:`)))),
      conventions: initialized.metadata.understanding.conventions,
      notes: initialized.metadata.understanding.notes }, projectRules, ruleFiles, navigation,
    documentationFiles: Object.keys(baseline.files).filter(file => /^(?:docs\/.*|README|AGENTS|CLAUDE)\.md$/i.test(file)
      && (focusFiles === null || focusFiles.includes(file))).slice(0, 40),
    testFiles: baseline.paths.tests.filter(file => focusFiles === null || focusFiles.includes(file)).slice(0, 80), testFileCount: baseline.paths.tests.length });
}

export function renderProjectBaseline(baseline) {
  if (baseline.reportVersion === 2) return renderProjectHandbook(baseline);
  const sections = [
    `# 项目全局基线\n\n生成时间：${baseline.generatedAt}\n\n源码哈希：${baseline.sourceHash}\n\n基线哈希：${baseline.snapshotHash}\n\n文件：${baseline.sourceFileCount} 个，${baseline.sourceBytes} 字节。`,
    `## 运行与验证\n\n配置的检查命令：${baseline.checks.map((row) => `\`${row.join(" ")}\``).join("；")}。\n\n测试部署：${baseline.testDeployment}；生产部署：${baseline.productionDeployment}。`,
  ];
  for (const [key, label] of [["frontend", "前端"], ["backend", "后端"],
    ["database", "数据库与数据层"], ["middleware", "中间件"]]) {
    const rows = baseline.components[key];
    sections.push(`## ${label}\n\n${rows.length
      ? rows.map((item) => `- 声明依赖 ${item.name}${item.version ? ` ${item.version}` : ""}；证据：${item.evidence}`).join("\n")
      : "- 未从依赖清单确认技术栈；需要人工核实。"}`);
  }
  sections.push(`## 模块分布\n\n${baseline.modules.length
    ? baseline.modules.slice(0, 100).map((item) => `- ${item.path}：${item.fileCount} 个文件`).join("\n")
    : "- 未发现常见代码模块目录。"}`);
  sections.push(`## 静态接口声明\n\n${baseline.declarations.apiRoutes.length
    ? baseline.declarations.apiRoutes.slice(0, 100).map((item) => `- ${item.method} ${item.route}；证据：${item.evidence}`).join("\n")
    : "- 未识别到受支持语法的静态路由声明。"}`);
  sections.push(`## 静态数据模型声明\n\n${baseline.declarations.dataModels.length
    ? baseline.declarations.dataModels.slice(0, 100).map((item) => `- ${item.kind} ${item.name}；证据：${item.evidence}`).join("\n")
    : "- 未识别到 Prisma 模型或 SQL 建表声明。"}`);
  for (const [key, label] of [["sourceRoots", "代码模块目录"], ["entrypoints", "程序入口"],
    ["frontend", "前端文件线索"], ["backend", "后端文件线索"],
    ["interfaces", "接口线索"], ["database", "数据文件线索"], ["middleware", "中间件文件线索"],
    ["tests", "测试文件"], ["deployment", "部署文件"], ["manifests", "依赖清单"]]) {
    const rows = baseline.paths[key];
    sections.push(`## ${label}\n\n${rows.length ? rows.slice(0, 50).map((file) => `- ${file}`).join("\n") : "- 未发现。"}`
      + (rows.length > 50 ? `\n- 另有 ${rows.length - 50} 项，见 baseline.json。` : ""));
  }
  sections.push(`## 待核实\n\n${baseline.unknowns.map((item) => `- ${item}`).join("\n")}`);
  sections.push("扫描只证明文件和依赖声明存在，不证明代码实际调用、生产部署拓扑、接口兼容或数据安全。后续需求仍需按具体改动审核。\n");
  return `${sections.join("\n\n")}\n`;
}

export async function saveProjectBaseline(project, baseline) {
  if (baseline.root !== project.root || baseline.configHash !== (baseline.reportVersion >= 3 ? describePolicy(project.config).executionConfigHash : sha256(JSON.stringify(project.config)))
      || baseline.snapshotHash !== sha256(JSON.stringify(baselineFacts(baseline)))) {
    throw new Error("Cannot save an invalid project baseline");
  }
  if (manifestHash(await manifest(project.root, project.config.excludedPaths,
    project.config.maxSnapshotBytes)) !== baseline.sourceHash) {
    throw new Error("Project files changed before baseline could be saved");
  }
  const events = await baselineEvents(project);
  const history = path.join(project.archive, "baselines");
  await fs.mkdir(history, { recursive: true, mode: 0o700 });
  const archived = path.join(history, `${baseline.snapshotHash}.json`);
  const prior = await fs.stat(archived).then(() => readJson(archived), (error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (prior && prior.snapshotHash !== sha256(JSON.stringify(baselineFacts(prior)))) {
    throw new Error("Archived project baseline changed");
  }
  if (!prior) await fs.writeFile(archived, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const event = { at: baseline.generatedAt, snapshotHash: baseline.snapshotHash,
    archiveHash: sha256(JSON.stringify(prior ?? baseline)),
    sourceHash: baseline.sourceHash, configHash: baseline.configHash,
    localUid: typeof process.getuid === "function" ? process.getuid() : null,
    previous: events.at(-1)?.hash ?? null };
  event.hash = sha256(JSON.stringify({ ...event, hash: undefined }));
  await fs.appendFile(path.join(project.archive, "baseline-events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await writeJson(path.join(project.archive, "baseline.json"), baseline);
  await writeAtomic(path.join(project.archive, "baseline.md"), renderProjectBaseline(baseline));
  return { baselineFile: path.join(project.archive, "baseline.json"), reportFile: path.join(project.archive, "baseline.md"),
    snapshotHash: baseline.snapshotHash, sourceHash: baseline.sourceHash,
    sourceFileCount: baseline.sourceFileCount, unknowns: baseline.unknowns };
}

export async function refreshProjectBaseline(project) {
  return withLock(path.join(project.archive, "baseline.lock"), async () => {
    const currentExists = await fs.stat(path.join(project.archive, "baseline.json"))
      .then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
    if (currentExists) await readProjectBaseline(project, null, false);
    const baseline = await buildProjectBaseline(project);
    const saved = await saveProjectBaseline(project, baseline);
    const mode = await readJson(path.join(project.archive, "documentation-mode.json"));
    if (mode.mode === "agent") {
      const { initializeProjectContext } = await import("./project-initialization.js");
      await initializeProjectContext(project, baseline);
    } else if (mode.mode !== "inventory") throw new Error("Invalid project documentation mode");
    return saved;
  });
}

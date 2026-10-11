import path from "node:path";

const text = (value) => String(value).replace(/[\r\n|`<>]/g, " ");
const code = (value) => `\`${text(value)}\``;
const inventory = (rows, limit = 12) => rows.length
  ? rows.slice(0, limit).map((row) => `- ${code(row)}`).join("\n")
    + (rows.length > limit ? `\n- 其余 ${rows.length - limit} 项见 baseline.json 对应索引。` : "")
  : "未检出。此结果不能证明项目不存在该能力。";

export function renderProjectHandbook(baseline) {
  const { paths, declarations, components, packages, policy } = baseline;
  const descriptions = [
    ...baseline.overviewEvidence.map((row) => `- ${text(row.text)}。来源：${code(row.evidence)}（项目文档自述）。`),
    ...packages.filter((pkg) => pkg.description).map((pkg) => `- ${text(pkg.name ?? pkg.path)}：${text(pkg.description)}。来源：${code(pkg.path)} 的 description。`),
  ];
  const sections = [
    `# 项目源码证据索引\n\n工作目录：${code(baseline.root)}\n\n扫描时间：${baseline.generatedAt}。本次记录 ${baseline.sourceFileCount} 个文件；下列路径均相对于此工作目录。`,
    `## 先了解这个项目\n\n${descriptions.length
      ? descriptions.join("\n")
      : "仓库文档未说明项目用途；静态索引不根据目录名推断业务。"}\n\n优先阅读：\n\n${inventory(paths.documentation, 8)}`,
    "## 扫描范围\n\n已完成源码和配置的静态盘点。尚未执行启动、测试、数据库连接或部署验证；下列命令和依赖均为声明证据，不能作为运行成功的证明。自动生成的项目理解见 PROJECT_REFERENCE.md 和 agent.md。初始化无需人工确认。",
    `## 从哪里开始阅读代码\n\n程序入口候选：\n\n${inventory(paths.entrypoints)}\n\n模块分布（目录统计，不代表已确认的业务职责）：\n\n${baseline.modules.length
      ? baseline.modules.slice(0, 20).map((item) => `- ${code(item.path)}：${item.fileCount} 个文件`).join("\n") : "未发现常见模块目录；请从依赖清单和源码索引定位入口。"}`,
  ];
  const domains = [
    ["frontend", "前端", "页面、路由入口、组件、状态管理和接口调用", paths.frontend],
    ["backend", "后端", "接口入口、鉴权、业务服务和外部调用", paths.backend],
    ["database", "数据库与数据层", "模型、迁移、索引、唯一约束和历史数据兼容", paths.database],
    ["middleware", "中间件", "缓存键、消息格式、消费者、重试和幂等约束", paths.middleware],
  ];
  for (const [key, label, concerns, files] of domains) {
    const deps = components[key];
    sections.push(`## ${label}\n\n${deps.length
      ? deps.slice(0, 15).map((dep) => `- 声明依赖 ${code(dep.name)}${dep.version ? ` ${code(dep.version)}` : ""}；来源：${code(dep.evidence)}`).join("\n")
      : "依赖清单未确认具体技术栈；请核对下方文件线索。"}\n\n定位文件：\n\n${inventory(files)}\n\n改动前需核实：${concerns}。静态扫描不确认实际调用关系或线上部署。`);
  }
  return finishHandbook(baseline, sections);
}

function finishHandbook(baseline, sections) {
  const { paths, declarations, packages, policy } = baseline;
  const symbolsByFile = new Map();
  for (const row of declarations.publicSymbols) {
    const file = row.evidence.replace(/:\d+$/, "");
    if (file.includes("/") && !paths.sourceRoots.some((root) => file.startsWith(`${root}/`))) continue;
    if (!symbolsByFile.has(file)) symbolsByFile.set(file, []);
    symbolsByFile.get(file).push(row);
  }
  const imports = declarations.localImports.filter((row) => !row.from.includes("/")
    || paths.sourceRoots.some((root) => row.from.startsWith(`${root}/`)));
  sections.push(`## 已有能力与代码依赖入口\n\n导出函数／类（源码声明，不代表已验证的业务能力）：\n\n${symbolsByFile.size
    ? [...symbolsByFile].slice(0, 24).map(([file, rows]) => `- ${code(file)}：${rows.slice(0, 6).map((row) => `${code(row.name)} (${code(row.evidence)})`).join("、")}${rows.length > 6 ? `；另 ${rows.length - 6} 项见完整索引` : ""}`).join("\n")
    : "当前提取器未识别导出声明，需从程序入口定位业务服务。"}\n\n已解析的本地静态导入（表示代码依赖，不等同运行时调用链）：\n\n${imports.length
    ? imports.slice(0, 20).map((row) => `- ${code(row.from)} → ${code(row.to)}；${code(row.evidence)}`).join("\n")
    : "未解析到带明确文件路径的本地导入；动态加载与跨服务调用需进一步核实。"}`);
  sections.push(`## 已有回归场景\n\n${declarations.testCases.length
    ? declarations.testCases.slice(0, 25).map((row) => `- ${text(row.name)}；${code(row.evidence)}`).join("\n")
    : "未提取到受支持格式的测试名称，请阅读测试入口确认实际场景。"}\n\n场景来自测试声明，未在初始化中执行；不能据此宣称测试通过或覆盖充分。完整提取结果见 baseline.json 的 declarations.testCases。`);
  sections.push(`## 接口与数据变更检查点\n\n识别到的路由片段（可能尚未包含挂载前缀；不等于完整 API 清单）：\n\n${declarations.apiRoutes.length
    ? declarations.apiRoutes.slice(0, 30).map((row) => `- ${code(`${row.method} ${row.route}`)}；${code(row.evidence)}`).join("\n")
    : "未匹配支持的路由语法，请从接口文件定位。"}\n\n数据模型声明：\n\n${declarations.dataModels.length
    ? declarations.dataModels.slice(0, 30).map((row) => `- ${code(row.name)}（${row.kind}）；${code(row.evidence)}`).join("\n")
    : "未匹配 Prisma / SQL 模型声明；不能据此判断没有数据库。"}\n\n迁移入口：\n\n${inventory(paths.migrations)}\n\n负责人需确认请求与响应兼容、鉴权与错误码、事务边界、数据迁移及回退方式。现有数据写入、删除或结构变更不得仅凭本文档自动执行。`);
  sections.push(`## 如何启动与验证\n\n包和运行时声明：\n\n${packages.length ? packages.map((pkg) => {
    const cwd = path.posix.dirname(pkg.path);
    const manager = pkg.packageManager ? text(pkg.packageManager) : "未声明包管理器";
    const runtime = Object.entries(pkg.engines).map(([name, version]) => `${text(name)} ${text(version)}`).join("，") || "未声明运行时版本";
    return `- ${code(pkg.path)}；工作目录 ${code(cwd)}；${manager}；${runtime}。可用脚本：${pkg.scripts.length ? pkg.scripts.map(code).join("、") : "未声明"}。`;
  }).join("\n") : "未发现 Node 包声明；其他语言应从依赖清单确认构建工具和启动参数。"}\n\n执行器配置的检查命令（参数数组，工作目录为需求隔离副本根目录；尚未执行）：\n\n${baseline.checks.map((command) => `- ${code(JSON.stringify(command))}`).join("\n")}\n\n测试入口：\n\n${inventory(paths.tests)}\n\n这些文件的存在不证明覆盖率。实施前记录原有检查结果，实施后重跑，并为受影响的旧功能补充回归验证。`);
  sections.push(`## 环境与发布\n\n源码引用的环境变量名（不读取或展示值）：\n\n${declarations.environmentNames.length
    ? declarations.environmentNames.slice(0, 20).map((row) => `- ${code(row.name)}；${code(row.evidence)}`).join("\n")
    : "未从支持的源码语法提取到变量名；环境配置入口尚未识别。"}\n\n发布文件：\n\n${inventory(paths.deployment)}\n\n配置的测试发布方式：${code(baseline.testDeployment)}；生产发布方式：${code(baseline.productionDeployment)}。目标环境、连接凭据、健康检查和发布回退尚未验证。`);
  sections.push(`## 修改边界与项目规范\n\n允许修改路径：${policy.allowedPaths.map(code).join("、")}。排除路径：${policy.excludedPaths.map(code).join("、")}。\n\n${policy.mode === "git"
    ? `Git 基础分支 ${code(policy.baseBranch)}，发布分支 ${code(policy.releaseBranch)}；实际远端状态需要核验。`
    : "当前为本地副本模式，按需求保留文件快照与隔离工作区。"}\n\n规范配置文件：\n\n${inventory(paths.quality)}\n\n项目自定义约束：\n\n${policy.globalRules.length
    ? policy.globalRules.map((rule) => `- ${code(rule.id)} [${rule.level}] ${text(rule.text)}`).join("\n") : "未声明项目自定义约束；已有内置规范和审批门禁继续生效。"}`);
  sections.push(`## 静态扫描缺口\n\n${baseline.unknowns.map((item) => `- ${text(item)}`).join("\n")}\n\n这些是提取器覆盖范围的说明，不是初始化审批事项。外部环境信息保持未知，初始化不会自动连接外部服务。`);
  sections.push(`## 证据与版本索引\n\n源码哈希：${code(baseline.sourceHash)}\n\n基线哈希：${code(baseline.snapshotHash)}\n\n完整声明、文件哈希和超过本文展示数量的记录见同目录 baseline.json；历史版本与审计分别在 baselines/、baseline-events.jsonl。本文与 Agent 使用同一基线。源码变化需显式刷新基线，旧方案的审批不会自动沿用。`);
  return `${sections.join("\n\n")}\n`;
}

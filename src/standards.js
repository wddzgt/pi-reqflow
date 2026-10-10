import path from "node:path";
import { sha256 } from "./files.js";

const catalogVersion = "2026-10-02.1";
const general = [
  { id: "GEN-ROOT-CAUSE", text: "先追踪完整数据流并修复根因；不得用猜测性判空、默认值或特判掩盖上游错误" },
  { id: "GEN-ERROR", text: "外部输入在边界校验；非法输入明确报错；不得吞异常、仅记录警告后继续或伪造成功" },
  { id: "GEN-SCOPE", text: "遵循现有分层与命名，只改需求必要范围，不顺手重构或增加无依据的抽象" },
  { id: "GEN-TEST", text: "新增或修改行为需覆盖验收和关键历史行为；不能把构建成功当作回归测试" },
];

const profiles = [
  { id: "java-alibaba", language: "java", extensions: [".java"],
    source: "https://github.com/alibaba/p3c", reference: "阿里巴巴 Java 开发手册黄山版；P3C 仅覆盖部分规则",
    rules: ["命名、异常处理、集合与并发遵循阿里巴巴 Java 开发手册及项目现有规约",
      "不得捕获异常后仅记录日志并继续返回成功；公开接口保持明确契约"] },
  { id: "javascript-eslint", language: "javascript", extensions: [".js", ".mjs", ".cjs", ".jsx"],
    source: "https://eslint.org/docs/latest/use/configure/configuration-files", reference: "ESLint 官方规则与项目配置",
    rules: ["遵循仓库 ESLint 配置；避免未使用变量和有歧义的控制流",
      "保持项目既有模块、异步和错误处理约定，不自行改换格式风格"] },
  { id: "typescript-eslint", language: "typescript", extensions: [".ts", ".tsx", ".mts", ".cts"],
    source: "https://typescript-eslint.io/users/configs/", reference: "typescript-eslint 推荐配置与项目 tsconfig",
    rules: ["遵循项目 TypeScript 与 typescript-eslint 配置，保持类型边界清晰",
      "不得用无依据的 any、类型断言或忽略指令绕过类型错误"] },
  { id: "python-pep8", language: "python", extensions: [".py"],
    source: "https://peps.python.org/pep-0008/", reference: "PEP 8 与项目已有风格",
    rules: ["遵循 PEP 8 的命名、导入与布局约定，优先保持所在模块一致",
      "异常应具体处理或重新抛出，不得使用空 except 隐藏错误"] },
  { id: "go-effective", language: "go", extensions: [".go"],
    source: "https://go.dev/doc/effective_go.html", reference: "Effective Go 与 gofmt",
    rules: ["代码采用 gofmt 格式并遵循项目包结构与命名习惯",
      "显式处理返回错误；不要用空分支或无依据的默认返回掩盖失败"] },
  { id: "rust-style", language: "rust", extensions: [".rs"],
    source: "https://doc.rust-lang.org/style-guide/", reference: "Rust Style Guide、rustfmt 与 Clippy",
    rules: ["遵循 rustfmt 默认风格及项目 Clippy 配置",
      "错误通过明确的 Result 路径处理；避免用 unwrap 或忽略结果隐藏可预期失败"] },
  { id: "csharp-dotnet", language: "csharp", extensions: [".cs"],
    source: "https://learn.microsoft.com/dotnet/fundamentals/code-analysis/code-style-rule-options",
    reference: ".NET 代码风格分析器与项目 .editorconfig",
    rules: ["遵循项目 .editorconfig 和 .NET 分析器的命名与格式规则",
      "异常与异步返回遵循明确契约，不将失败伪装成成功结果"] },
  { id: "kotlin-official", language: "kotlin", extensions: [".kt", ".kts"],
    source: "https://kotlinlang.org/docs/coding-conventions.html", reference: "Kotlin 官方编码约定",
    rules: ["遵循 Kotlin 官方命名、文件组织与格式约定，并保持模块既有风格",
      "优先使用不可变值；空安全处理应表达真实契约而非隐藏异常状态"] },
];

export function standardsCatalog() {
  return structuredClone({ version: catalogVersion, general, profiles });
}

export function resolveStandards(config, files) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
    throw new Error("Standards need a list of source paths");
  }
  const extensions = new Set(files.map((file) => path.extname(file).toLowerCase()));
  const selected = profiles.filter((profile) => profile.extensions.some((extension) => extensions.has(extension)));
  const globalRules = config.codingStandards?.globalRules ?? [];
  const resolved = structuredClone({ version: catalogVersion, general, profiles: selected, globalRules });
  return { ...resolved, hash: sha256(JSON.stringify(resolved)) };
}

export function standardsPrompt(resolved) {
  return JSON.stringify({ general: resolved.general.map(({ id, text }) => ({ id, text })),
    languages: resolved.profiles.map(({ id, rules }) => ({ id, rules })),
    projectGlobal: resolved.globalRules.map(({ id, text, level }) => ({ id, text, level })) });
}

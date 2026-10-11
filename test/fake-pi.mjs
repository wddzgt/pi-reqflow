import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const phase = process.env.REQFLOW_PHASE;
const prompt = process.argv.at(-1);
let initialization;
if (phase === "initialize") {
  const files = JSON.parse(prompt.match(/^源码文件索引.*：(.*)$/m)[1]);
  const commands = JSON.parse(prompt.match(/^命令目录：(.*)$/m)[1]);
  const evidenceFile = files.find((file) => file.endsWith("calculator.mjs")) ?? files.find((file) => file.endsWith("app.js")) ?? files[0];
  const evidence = evidenceFile ? [`${evidenceFile}:1`] : [];
  initialization = { schemaVersion: 1, overview: { text: evidenceFile ? "此项目提供现有业务功能，开发从源码入口和项目测试开始。" : "当前仓库为空，尚未实现业务代码。", evidence },
    architecture: evidenceFile ? [{ name: "业务实现", text: `核心实现位于 ${evidenceFile}。`, evidence }] : [],
    workflows: [], conventions: [], notes: [], commandIds: commands.slice(0, 12).map((command) => command.id) };
}
const refineAddition = prompt.includes("Refine addition");
const documentAddition = prompt.includes("Document addition");
const frontendCalculator = prompt.includes("Frontend calculator");
if (phase === "implement") {
  const source = path.join(process.cwd(), "src", "calculator.mjs");
  const test = path.join(process.cwd(), "test", "calculator.test.mjs");
  const original = await fs.readFile(test, "utf8");
  if (documentAddition) {
    await fs.writeFile(source, (await fs.readFile(source, "utf8")).replace("export function add", "// Add two values using the existing behavior.\nexport function add"));
  } else if (refineAddition) {
    await fs.writeFile(source, (await fs.readFile(source, "utf8")).replace("return left + right;", "return Number(left) + Number(right);"));
    await fs.writeFile(test, `${original}\ntest('numeric strings are added numerically', () => { assert.equal(add('2', '3'), 5); });\n`);
  } else {
    await fs.appendFile(source, "\nexport function multiply(left, right) {\n  return left * right;\n}\n");
    await fs.writeFile(test, original.replace("import { add }", "import { add, multiply }") + "\ntest('multiply returns the product', () => { assert.equal(multiply(2, 3), 6); });\n");
  }
  if (prompt.includes("Out-of-scope probe")) await fs.writeFile(path.join(process.cwd(), "src", "rogue.mjs"), "export const rogue = true;\n");
  if (frontendCalculator) {
    await fs.writeFile(path.join(process.cwd(), "frontend/compute.mjs"), "import { multiply } from '../src/calculator.mjs';\nexport const compute = (left, right) => multiply(left, right);\n");
    await fs.appendFile(test, "\nimport { compute } from '../frontend/compute.mjs';\ntest('frontend uses multiplication', () => assert.equal(compute(2, 3), 6));\n");
  }
}

let review;
let intake;
if (phase === "intake") {
  const context = JSON.parse(prompt.match(/^沟通输入：(.*)$/m)[1]);
  const inputHash = prompt.match(/输入版本哈希：([a-f0-9]{64})/)[1];
  const ready = context.history.some((row) => row.role === "product");
  const contract = context.candidate ?? { objective: "计算器支持乘法", currentBehavior: "当前只能将两个数相加",
    desiredBehavior: "用户能将两个数相乘，原有加法行为保持不变", acceptance: [{ id: "AC1", text: "输入2和3相乘得到6，原有相加操作仍得到5" }],
    inScope: ["两个数相乘", "原有加法行为保持不变"], outOfScope: [], answers: {} };
  intake = { schemaVersion: 1, inputHash, status: ready ? "ready" : "needs_clarification",
    reply: ready ? "已确认增加乘法并保留现有加法行为，请查看验收标准后定版。" : "我理解你希望扩展计算能力。请确认新增行为与现有加法的兼容要求。",
    summary: "在现有计算器基础上扩展功能，保持原有行为。", suggestions: ["保留加法回归测试，并覆盖新乘法验收场景。"],
    questions: ready ? [] : [{ id: "Q1", text: "是否新增乘法，并保持现有加法不变？" }], requiredRoles: ["backend", "qa"], contract: ready ? contract : null };
  for (const file of process.argv.filter((arg) => arg.startsWith("@"))) {
    const data = (await fs.readFile(file.slice(1))).toString("base64");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "image", data, mimeType: "image/png" }] } }) + "\n");
  }
}
if (phase === "review" || phase === "plan" && prompt.startsWith("研发方案沟通")) {
  if (prompt.startsWith("研发方案沟通")) {
    const question = prompt.match(/^本轮研发问题：(.*)$/m)[1];
    review = { schemaVersion: 2, planHash: prompt.match(/当前方案哈希：([a-f0-9]{64})/)[1], decisions: [],
      reply: "已核对冻结需求和现有加法实现，讨论不会修改方案或批准开发。",
      recommendation: question.includes("新增除法") ? "product_confirmation" : "keep",
      reasons: ["src/calculator.mjs 中现有加法保持原行为，新增乘法按原验收检查。"], pendingQuestions: [] };
  } else if (prompt.startsWith("研发方案专项检查")) {
    const role = prompt.match(/本方案在 (all) 职责/)[1];
    review = { findings: [] };
  } else {
  const role = prompt.match(/你是独立的(frontend|backend|qa)评审 Agent/)?.[1];
  const contractHash = prompt.match(/契约哈希：([a-f0-9]{64})/)?.[1];
  const contractText = prompt.match(/契约 JSON：(.*)\n只返回一个合法 JSON 对象/)?.[1];
  if (!role || !contractHash || !contractText) throw new Error("Review prompt omitted its frozen contract");
  const contract = JSON.parse(contractText);
  review = { role, contractHash, coveredAcceptanceIds: contract.acceptance.map((item) => item.id),
    judgments: { objective: "agree", desiredBehavior: "agree", scope: "agree", acceptance: "agree" },
    interfaceDecisions: refineAddition ? { noExternalInterface: "none" }
      : { calculator: "multiply returns product; add remains unchanged" },
    blockers: [], evidence: `${role} checked src/calculator.mjs and the frozen contract`,
    ...(prompt.includes("、affectedFiles（") ? { affectedFiles: ["src/calculator.mjs", "test/calculator.test.mjs"] } : {}),
    ...(role === "qa" ? { testScenarios: contract.acceptance.map((item) => ({ acceptanceId: item.id,
      scenario: refineAddition ? "Check numeric string addition and existing numeric addition"
        : "Check multiply and existing add" })) } : {}),
  };
  }
}

let analysis;
if (phase === "plan" && !prompt.startsWith("研发方案沟通") && !prompt.startsWith("局部研发方案纠错")) {
  const contract = JSON.parse(prompt.match(/冻结需求 JSON：(.*)\n适用代码规范/)[1]);
  analysis = { schemaVersion: 2, contractHash: prompt.match(/冻结需求哈希：([a-f0-9]{64})/)[1],
    affectedFiles: contract.inScope.every((file) => file.endsWith(".mjs")) ? contract.inScope : ["src/calculator.mjs", "test/calculator.test.mjs"], domains: ["backend"],
    impacts: { existingBehavior: { status: refineAddition ? "changed" : "none", evidence: refineAddition ? "src/calculator.mjs:2 数字字符串从拼接改为相加，改变既有行为。" : "src/calculator.mjs:2 中 add 保留原实现，新乘法单独增加。" },
      interfaces: { status: "none", evidence: "计算器无外部 HTTP 接口，现有 add 参数不变。" },
      data: { status: "none", evidence: "src/calculator.mjs 不读取或写入持久数据。" } },
    verification: contract.acceptance.map((item) => ({ acceptanceId: item.id, scenario: item.text,
      regression: "执行 test/calculator.test.mjs 中既有 add 用例" })), openQuestions: [] };
  analysis.validation = { checks: JSON.parse(prompt.match(/检查命令：(.*)$/m)[1]).map(command => ({ command,
    reason: "计算器实现与调用方验收用例；只回归当前计算器项目" })), skipped: [], manualReason: "按验收场景调用计算器导出函数，核对结果和既有加法。", startup: [] };
  analysis.changes = analysis.affectedFiles.map(file => ({ file, description: documentAddition ? "为 add 增加说明注释，不改函数实现。" : file.startsWith("test/")
    ? "补充新功能断言并保留已有加法回归。" : refineAddition ? "调整 add 的数字字符串处理。" : "独立增加 multiply，保留 add 实现。" }));
  analysis.design = { approach: "沿用计算器纯函数结构，局部修改以满足冻结需求，保留原有加法的签名和回归断言。",
    frontend: "", backend: "在现有计算器模块实现本次变化，调用方继续使用现有模块导出。测试同时检查新增结果与原有加法。",
    data: "无持久化数据读写，恢复独立工作区文件快照即可。", interfaces: [], diagrams: [],
    components: analysis.affectedFiles.map(file => ({ file, domain: "backend", location: file.startsWith("test/") ? "现有测试用例末尾新增断言" : "现有 add 方法及其相邻导出位置",
      pseudocode: documentAddition ? "" : file.startsWith("test/") ? "保留 add 回归断言；补充本次验收断言" : "实现冻结需求的局部逻辑；保持 add 既有签名" })) };
  if (frontendCalculator) {
    analysis.domains = ["frontend", "backend"];
    analysis.design.frontend = "在 compute 中调用计算器新增 multiply 导出，保持已有参数形式。";
    analysis.design.interfaces = [{ name: "模块调用", method: "function", path: "multiply(left, right)", status: "new", sourceFile: "src/calculator.mjs",
      request: "left=2, right=3", response: "6", errors: "沿用现有数值输入约定" }];
    analysis.design.components = analysis.design.components.map(row => row.file.startsWith("frontend/")
      ? { ...row, domain: "frontend", location: "compute 导出函数", pseudocode: "调用 multiply 并返回结果" } : row);
  }
  analysis.boundaries = { modules: [{ name: "计算器", files: analysis.affectedFiles, evidence: "计算器实现及其回归测试" }],
    deliveryUnits: [{ name: "计算器应用", evidence: "当前项目独立交付，无关联服务发布" }], designStages: 1, estimatedChangedLines: 20,
    coordination: { status: "none", evidence: "本地纯函数，无外部团队协调" },
    verification: { status: "ready", evidence: "配置的 node --test 覆盖新功能和既有加法" },
    recovery: { status: "code_only", evidence: "隔离工作区文件快照可以恢复，无数据写入" },
    externalEffects: { status: "none", evidence: "计算器不访问外部服务或持久数据" }, exclusions: [] };
  const proposalText = prompt.match(/^研发直接编辑的候选方案：(.*)$/m)?.[1];
  if (proposalText) analysis.candidateReview = { proposalHash: createHash("sha256").update(JSON.stringify(JSON.parse(proposalText))).digest("hex"),
    status: "adjusted", reasons: ["已核对计算器源码，保留冻结需求与现有加法，改法以当前结构化方案为准。"] };
}
if (phase === "plan" && prompt.startsWith("局部研发方案纠错")) {
  analysis = Object.fromEntries(["affectedFiles", "changes", "domains", "impacts", "verification", "validation", "openQuestions", "boundaries", "design"].map(key => [key, null]));
  if (prompt.includes('"candidateReview":')) analysis.candidateReview = null;
}
const text = phase === "initialize" ? JSON.stringify(initialization) : phase === "intake" ? JSON.stringify(intake) : phase === "review" || prompt.startsWith("研发方案沟通") ? JSON.stringify(review) : phase === "plan" ? JSON.stringify(analysis) : "已修改计算器及测试。";
const args = process.argv.slice(2);
if (args.includes("--session")) {
  const session = args[args.indexOf("--session") + 1];
  const exists = await fs.stat(session).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (!exists) await fs.writeFile(session, JSON.stringify({ type: "session", version: 3,
    id: randomUUID(), timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n", { flag: "wx", mode: 0o600 });
  await fs.appendFile(session, JSON.stringify({ type: "message", id: `${phase}-${Date.now()}`,
    timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n");
}
if (phase === "plan") {
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant",
    content: [{ type: "text", text: "Reviewing source" }], stopReason: "toolUse",
    usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } })}\n`);
}
process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }],
  stopReason: "stop", usage: { input: 120, output: 40, cacheRead: 10, cacheWrite: 5,
    cost: { total: phase === "review" ? 0.07 : phase === "intake" ? 0.03 : 0 } } } })}\n`);
process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);

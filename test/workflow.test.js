import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadProject } from "../src/config.js";
import { baselineAgentContext, readProjectBaseline, refreshProjectBaseline } from "../src/baseline.js";
import { admissionDefaults, executionUsage } from "../src/admission.js";
import { executeRequirementAction, getRequirementLifecycle, getTaskObservability } from "../src/core.js";
import { addCredential, authenticate } from "../src/auth.js";
import { assignMember, respondToAssignment } from "../src/assignment.js";
import { confirmContract, recordDevFeedback, reviseContract } from "../src/intake.js";
import { appendEvent, createTask, initialize, readTask } from "../src/store.js";
import { resolveStandards } from "../src/standards.js";
import { sha256 } from "../src/files.js";
import { readPlanMaterial } from "../src/plan-analysis.js";
import { getChangedFile, getRequirementEvidence } from "../src/evidence.js";
import { searchProjectHistory, readHistoryEvidence, readDiscussionEvidence } from "../src/history.js";
import { registerDeploymentAdapter } from "../src/core.js";
import { configureExecution, readExecutionSetup } from "../src/project-execution.js";
import { configureModels, readModelSettings } from "../src/model-settings.js";
import { discussPlan } from "../src/plan-conversation.js";
import { localValidation } from "../src/git-delivery.js";
import { acceptTest, approveChanges, approvePlan, approveRelease, archiveTestOnly, deployTest, implement, observeRelease, plan, pollRelease, release, revisePlan, rollback, verify, verifyCandidate } from "../src/workflow.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fakePi = path.join(root, "test", "fake-pi.mjs");
const fakePiPartialFailure = path.join(root, "test", "fake-pi-partial-failure.mjs");

async function analysisFixture(t, replacements = [], config = {}) {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-analysis-model-"));
  t.after(() => fs.rm(models, { recursive: true, force: true }));
  let source = await fs.readFile(fakePi, "utf8");
  for (const [from, to] of replacements) {
    assert.ok(source.includes(from), "Test model transformation must match its source");
    source = source.replace(from, to);
  }
  if (source.includes('domains: ["frontend", "backend"]')) source = source.replace('  analysis.boundaries =', `
  analysis.design.frontend = "前端复用现有计算器调用约定，保持参数形式。";
  analysis.design.diagrams = [{title:"共同交互",kind:"sequence",domain:"shared",source:"sequenceDiagram\\nF->>B: multiply\\nB-->>F: result"}];
  analysis.design.components = analysis.design.components.map(row => ({...row,domain:"shared"}));
  analysis.boundaries =`);
  const executable = path.join(models, "pi.mjs");
  await fs.writeFile(executable, source);
  const value = await fixture(false, executable, "Add multiplication", config);
  t.after(() => fs.rm(value.temporary, { recursive: true, force: true }));
  return value;
}

async function readyForPlan(projectRoot, project) {
  await recordDevFeedback(projectRoot, "REQ-001", "reviewer", {
    summary: "Add a multiplication function without changing addition.", questions: [], requiredRoles: ["backend", "qa"],
  });
  const confirmed = await confirmContract(projectRoot, "REQ-001", "product", {
    objective: "Support multiplication", currentBehavior: "Calculator only adds values",
    desiredBehavior: "multiply returns the product and add stays unchanged",
    acceptance: [{ id: "AC1", text: "multiply(2, 3) returns 6 and add(2, 3) returns 5" }],
    inScope: ["src/calculator.mjs", "test/calculator.test.mjs"], outOfScope: [], answers: {},
  });
  assert.equal(confirmed.state, "contract_confirmed");
}

async function fixture(production = false, piExecutable = fakePi,
  request = "Add multiply(left, right) and keep add working.", configOverrides = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-test-"));
  const projectRoot = path.join(temporary, "project");
  await fs.mkdir(projectRoot);
  await fs.cp(path.join(root, "examples", "demo-app", "src"), path.join(projectRoot, "src"), { recursive: true });
  await fs.cp(path.join(root, "examples", "demo-app", "test"), path.join(projectRoot, "test"), { recursive: true });
  const configFile = path.join(temporary, "config.json");
  const config = {
    schemaVersion: 2, mode: "local", piExecutable, provider: "fake", model: "fake-model",
    environment: { pi: [], checks: [], localDeployment: [] },
    allowedPaths: ["src", "test"], excludedPaths: [".env"],
    maxSnapshotBytes: 1000000, maxPiMs: 30000, maxToolCalls: 20, maxEventBytes: 1000000, maxCostUsd: 2,
    checks: [[process.execPath, "--test", "test/calculator.test.mjs"]],
    testDeployment: { kind: "local", command: [process.execPath, "--test", "test/calculator.test.mjs"] },
    productionDeployment: production
      ? { kind: "local", command: [process.execPath, "--test", "test/calculator.test.mjs"] }
      : { kind: "none" },
  };
  Object.assign(config, configOverrides);
  await fs.writeFile(configFile, JSON.stringify(config));
  await initialize(projectRoot, configFile);
  const project = await loadProject(projectRoot);
  await createTask(project, "REQ-001", "Add multiplication", request, "product");
  await addCredential(project, "reviewer", ["developer"], { username: "reviewer", password: "password123456", token: "reviewer-token-0123456789-abcdefghijklmn" });
  await assignMember(projectRoot, "REQ-001", "product", "developer", "reviewer");
  await respondToAssignment(projectRoot, "REQ-001", "reviewer", "developer", true);
  await readyForPlan(projectRoot, project);
  return { temporary, projectRoot, project };
}

const transientQaFailure = [
  ['domains: ["backend"]', 'domains: ["frontend", "backend"]'],
  ['status: refineAddition ? "changed" : "none"', 'status: "changed"'],
  ['const phase = process.env.REQFLOW_PHASE;', `const phase = process.env.REQFLOW_PHASE;
if (phase === "review" && process.argv.at(-1).includes("在 qa 职责")) {
  const marker = new URL("./qa-retried", import.meta.url);
  const first = await fs.stat(marker).then(() => false, error => { if (error.code === "ENOENT") return true; throw error; });
  if (first) {
    await fs.writeFile(marker, "attempted", { flag: "wx" });
    console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",
      errorMessage:"Injected transient QA provider rejection",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
    process.exit(1);
  }
}`],
];

test("a simple frozen requirement has a test review and waits for its assigned approver", async (t) => {
  const { projectRoot, project } = await analysisFixture(t);
  await plan(projectRoot, "REQ-001");
  const task = await readTask(project, "REQ-001");
  assert.equal(task.events.filter((event) => event.type === "plan_draft_completed").length, 1);
  assert.deepEqual(task.events.filter((event) => event.type === "plan_specialist_completed").map(event => event.detail.role), ["qa"]);
  const evidence = await getRequirementEvidence(projectRoot, { id: "reviewer", roles: ["developer"] }, "REQ-001");
  assert.deepEqual(evidence.planAnalysis.draft.verification.map((item) => item.acceptanceId), ["AC1"]);
  assert.equal((await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001")).summary.attempts, 2);
  await assert.rejects(implement(projectRoot, "REQ-001"), /expected approved/);
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "another-developer"), /assigned developer/);
  assert.equal(task.meta.workspace, undefined);
  const original = await fs.readFile(path.join(task.directory, "plan-analysis-v1.json"), "utf8");
  await fs.writeFile(path.join(task.directory, "plan-analysis-v1.json"), original.replace('"domains": [', '"domains": ["frontend",'));
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /Plan analysis changed/);
});

test("developer prepares task checks without requiring shared deployment configuration", async (t) => {
  const { projectRoot, project } = await analysisFixture(t, [], { checks: [], testDeployment: { kind: "unconfigured" } });
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ scripts: {
    test: 'echo "Error: no test specified" && exit 1' } }));
  await fs.writeFile(path.join(projectRoot, "src/package.json"), JSON.stringify({ scripts: { test: "node --test", build: "node build.mjs" } }));
  await refreshProjectBaseline(project);
  await plan(projectRoot, "REQ-001");
  const before = await readTask(project, "REQ-001");
  const input = { stage: "development", expectedPlanHash: before.meta.planHash };
  await assert.rejects(localValidation(projectRoot, "REQ-001", "other", input), /负责研发/);
  await assert.rejects(localValidation(projectRoot, "REQ-001", "reviewer", { ...input, expectedPlanHash: "old" }), /刷新/);
  const setup = await localValidation(projectRoot, "REQ-001", "reviewer", input);
  assert.deepEqual(setup.checks, []);
  assert.deepEqual(setup.checkScripts.map(row => [row.sourceFile, row.kind, row.command]), [
    ["package.json", "test", "npm --prefix . run test"],
    ["src/package.json", "test", "npm --prefix src run test"], ["src/package.json", "check", "npm --prefix src run build"],
  ]);
  assert.match(setup.checkScripts[0].unavailableReason, /占位脚本/);
  assert.equal(setup.checkScripts[1].directory, "src");
  assert.equal((await readTask(project, "REQ-001")).events.length, before.events.length);
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /研发确认窗口/);
  for (const text of ["", "npm test | cat", "npm test\n\nnpm run build", "echo $HOME"])
    await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer", undefined, undefined, input.expectedPlanHash, undefined, text), /检查命令/);
  const checksText = `'${process.execPath}' --test test/calculator.test.mjs`;
  await approvePlan(projectRoot, "REQ-001", "reviewer", undefined, undefined, input.expectedPlanHash, undefined, checksText);
  assert.deepEqual((await loadProject(projectRoot)).config.checks, []);
  await implement(projectRoot, "REQ-001");
  const result = await verify(projectRoot, "REQ-001");
  assert.equal(result.state, "verified");
  assert.deepEqual(result.developmentChecks, [[process.execPath, "--test", "test/calculator.test.mjs"]]);
  assert.equal(result.checks.length, 1); assert.equal(result.planVersion, 1);
  const local = await localValidation(projectRoot, "REQ-001", "reviewer", {
    expectedPlanHash: result.planHash, expectedAfterHash: result.afterHash,
  });
  assert.deepEqual(local.checks, result.developmentChecks);
  await approveChanges(projectRoot, "REQ-001", "reviewer", "Checked isolated changes and tests");
});

test("development repairs one failed verification from the retained workspace then stops for human validation", async t => {
  const { projectRoot, project } = await analysisFixture(t, [['return left * right;', 'return left - right;'], [
    'if (phase === "implement") {',
    `if (phase === "implement" && prompt.includes("Continue from the current retained workspace")) {
      const source = path.join(process.cwd(), "src/calculator.mjs");
      await fs.writeFile(source, (await fs.readFile(source,"utf8")).replace("return left - right;", "return left * right;"));
      process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Repair complete"}],stopReason:"stop",usage:{input:80,output:15,cacheRead:0,cacheWrite:0,cost:{total:0.01}}}})+"\\n");
      process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n"); process.exit(0);
    }
    if (phase === "implement") {`,
  ]]);
  await plan(projectRoot, "REQ-001");
  const meta = (await readTask(project, "REQ-001")).meta;
  const result = await executeRequirementAction(projectRoot, "REQ-001", { action: "approve-plan", expectedPlanHash: meta.planHash },
    { id: "reviewer", roles: ["developer"] });
  assert.equal(result.state, "verified", JSON.stringify(result)); assert.equal(result.next, "choose-validation");
  const task = await readTask(project, "REQ-001");
  assert.equal(task.events.filter(event => event.type === "verification_failed").length, 1);
  assert.equal(task.events.filter(event => event.type === "implementation_resumed").length, 1);
  assert.equal(task.events.find(event => event.type === "implementation_resumed").detail.automatic, true);
  assert.equal(task.events.filter(event => event.type === "plan_approved").length, 1);
  assert.equal(task.events.filter(event => event.type === "test_deployed").length, 0);
  assert.equal((await fs.readFile(path.join(task.meta.workspace, "src/calculator.mjs"), "utf8")).match(/export function multiply/g).length, 1);
});

test("development stops after one automatic repair and rejects stale manual continuation", async t => {
  const { projectRoot, project } = await analysisFixture(t, [['return left * right;', 'return left - right;']]);
  await plan(projectRoot, "REQ-001");
  const meta = (await readTask(project, "REQ-001")).meta;
  const principal = { id: "reviewer", roles: ["developer"] };
  const result = await executeRequirementAction(projectRoot, "REQ-001", { action: "approve-plan", expectedPlanHash: meta.planHash }, principal);
  assert.equal(result.ok, false); assert.equal(result.next, "needs-attention");
  const task = await readTask(project, "REQ-001");
  assert.equal(task.events.filter(event => event.type === "implementation_resumed").length, 1);
  assert.equal(task.meta.developmentPause.automaticRetries, 1);
  assert.ok(task.meta.workspace); assert.ok(task.meta.developmentPause.reason);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", {
    action: "develop", authorizeImplementation: true, expectedPlanHash: meta.planHash, expectedAfterHash: "stale",
  }, principal), /当前中断现场/);
  assert.equal((await readTask(project, "REQ-001")).events.length, task.events.length);
});

const technicalCorrectionModel = [
  ['domains: ["backend"]', 'domains: ["frontend", "backend"]'],
  ['findings: [] };', `findings: role !== "backend" && !prompt.includes("corrected-contract")
    ? [{severity:"blocking",subject:"调用缺少共享契约",evidence:"前端调用multiply但接口清单为空",recommendation:"补齐multiply调用契约并同步后端说明"}] : [] };`],
  ["if (prompt.includes('\"candidateReview\":')) analysis.candidateReview = null;", `if (prompt.includes('"candidateReview":')) analysis.candidateReview = null;
    const navigation = JSON.parse(prompt.match(/当前方案导航：(.*)\\n承接检查/)[1]);
    if (prompt.includes("当前完整结构化方案")) throw new Error("Correction must retrieve sections on demand");
    analysis.design = Object.fromEntries(navigation.sections.map(key => [key, null]));
    analysis.design.backend = "corrected-contract: multiply接收两个数，返回乘积，保持原有加法。";
    analysis.design.interfaces = [{name:"乘法调用",method:"function",path:"multiply(left, right)",status:"new",sourceFile:"src/calculator.mjs",request:"left=2,right=3",response:"6",errors:"沿用已有数值规则"}];`],
];

test("technical contradictions are corrected internally before one human plan review", async t => {
  const { projectRoot, project } = await analysisFixture(t, technicalCorrectionModel);
  assert.equal((await plan(projectRoot, "REQ-001")).blocked, false);
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.state, "plan_review"); assert.equal(task.meta.planVersion, 1);
  assert.equal(task.meta.planAttempts, 1); assert.equal(task.meta.workspace, undefined);
  assert.equal(task.events.filter(event => event.type === "plan_revision_requested").length, 0);
  assert.equal(task.events.filter(event => event.type === "plan_correction_completed").length, 1);
  assert.equal(task.events.filter(event => event.type === "plan_specialist_completed").length, 6);
  const original = JSON.parse(await fs.readFile(task.events.find(event => event.type === "plan_draft_completed").detail.draftFile, "utf8"));
  const final = JSON.parse(await fs.readFile(path.join(task.directory, "plan-analysis-v1.json"), "utf8"));
  assert.equal(final.draft.design.approach, original.design.approach);
  assert.equal(final.draft.design.frontend, original.design.frontend);
  assert.deepEqual(final.draft.design.components, original.design.components);
  assert.deepEqual(final.draft.verification, original.verification);
  assert.deepEqual(final.draft.affectedFiles, original.affectedFiles);
  assert.equal(final.draft.contractHash, original.contractHash);
  assert.equal(final.draft.design.interfaces[0].path, "multiply(left, right)");
  assert.deepEqual(final.blockers, []); assert.deepEqual(final.internalCorrection, { attempts: 1, maxAttempts: 1 });
  assert.equal((await getTaskObservability(projectRoot, {id:"reviewer",roles:["developer"]}, "REQ-001")).summary.attempts, 8);
  assert.equal((await approvePlan(projectRoot, "REQ-001", "reviewer")).state, "approved");
  assert.equal((await implement(projectRoot,"REQ-001")).state,"implemented");
  assert.equal((await verify(projectRoot,"REQ-001")).state,"verified");
});

test("internal correction updates selected acceptance checks without replacing the complete coverage", async t => {
  const { projectRoot, project } = await analysisFixture(t, [...technicalCorrectionModel,
    ['analysis.design.backend = "corrected-contract:', `analysis.verification = Object.fromEntries([1,2,3,4,5,6,7,8].map(i => ["AC"+i,
      [3,5,7].includes(i) ? {scenario:"修正场景AC"+i,regression:"保留旧行为AC"+i} : null]));
    analysis.changes = [{file:"src/calculator.mjs",description:"修正核心函数契约"}];
    analysis.design.components = [{file:"src/calculator.mjs",domain:"shared",location:"multiply",pseudocode:"return left * right"}];
    analysis.design.backend = "corrected-contract:`]]);
  const acceptance = Array.from({length:8}, (_,i) => ({id:`AC${i+1}`,text:`计算验收${i+1}`}));
  await reviseContract(projectRoot,"REQ-001","product",{
    objective:"Support multiplication",currentBehavior:"Only add",desiredBehavior:"Multiply without changing add",
    acceptance,inScope:["src/calculator.mjs","test/calculator.test.mjs"],outOfScope:[],answers:{}});
  assert.equal((await plan(projectRoot,"REQ-001")).blocked,false);
  const task = await readTask(project,"REQ-001");
  const original = JSON.parse(await fs.readFile(task.events.find(event=>event.type==="plan_draft_completed").detail.draftFile,"utf8"));
  const analysis = JSON.parse(await fs.readFile(path.join(task.directory,"plan-analysis-v1.json"),"utf8"));
  assert.deepEqual(analysis.draft.verification.map(row=>row.acceptanceId),acceptance.map(row=>row.id));
  for (const [i,row] of analysis.draft.verification.entries()) {
    if ([3,5,7].includes(i+1)) assert.equal(row.scenario,`修正场景AC${i+1}`);
    else assert.deepEqual(row,original.verification[i]);
  }
  assert.equal(task.events.filter(event=>event.type==="plan_correction_completed").length,1);
  assert.deepEqual(analysis.blockers,[]);
  assert.deepEqual(analysis.draft.design.components[1],original.design.components[1]);
  assert.deepEqual(analysis.draft.changes[1],original.changes[1]);
  assert.equal(analysis.draft.changes[0].description,"修正核心函数契约");
});

test("internal correction retains unmodified interfaces and rejects invented implementation paths", async t => {
  const originalApi = 'interfaces: [{name:"原加法",method:"function",path:"add(left, right)",status:"existing",sourceFile:"src/calculator.mjs",request:"两个数字",response:"和",errors:"原约定"}]';
  const lost = await analysisFixture(t,[...technicalCorrectionModel,['interfaces: []',originalApi]]);
  assert.equal((await plan(lost.projectRoot,"REQ-001")).blocked,false);
  const completed = await readTask(lost.project,"REQ-001");
  const final = JSON.parse(await fs.readFile(path.join(completed.directory,"plan-analysis-v1.json"),"utf8"));
  assert.deepEqual(final.draft.design.interfaces.map(row=>row.path),["add(left, right)","multiply(left, right)"]);
  const invented = await analysisFixture(t,[...technicalCorrectionModel,
    ['status:"new",sourceFile:"src/calculator.mjs"','status:"modified",sourceFile:"src/missing.mjs"']]);
  await assert.rejects(plan(invented.projectRoot,"REQ-001"),/接口引用的源码不存在/);
  const wrongComponent = await analysisFixture(t,[...technicalCorrectionModel,
    ['analysis.design.backend = "corrected-contract:', `analysis.design.components = [{file:"src/missing.mjs",domain:"shared",location:"错误旧路径",pseudocode:"return 1"}];
    analysis.design.backend = "corrected-contract:`]]);
  await assert.rejects(plan(wrongComponent.projectRoot,"REQ-001"),/拟改路径.*src\/calculator.mjs/);
  for (const value of [invented,wrongComponent]) {
    const task = await readTask(value.project,"REQ-001");
    assert.equal(task.events.some(event=>event.type==="plan_correction_completed"),false);
    assert.equal(task.meta.state,"contract_confirmed");
    assert.equal(task.meta.workspace,undefined);
  }
});

test("business decisions skip internal correction and technical non-convergence stops after one correction", async t => {
  const business = await analysisFixture(t, [['openQuestions: []', 'openQuestions: ["业务负责人需要选择新的计算规则"]']]);
  assert.equal((await plan(business.projectRoot, "REQ-001")).blocked, true);
  assert.equal((await readTask(business.project, "REQ-001")).events.some(event => event.type === "plan_correction_started"), false);
  const unresolved = await analysisFixture(t, technicalCorrectionModel.slice(0, 2));
  assert.equal((await plan(unresolved.projectRoot, "REQ-001")).blocked, true);
  const task = await readTask(unresolved.project, "REQ-001");
  assert.equal(task.events.filter(event => event.type === "plan_correction_started").length, 1);
  assert.equal(task.events.filter(event => event.type === "plan_specialist_completed").length, 3);
  assert.equal(task.events.filter(event => event.type === "plan_specialist_reused").length, 3);
  assert.equal(task.meta.workspace, undefined);
  await assert.rejects(approvePlan(unresolved.projectRoot, "REQ-001", "reviewer"), /unresolved blockers/);
});

test("corrected plan checkpoints resume interrupted review without generating another correction", async t => {
  const stop = `if (phase === "review" && prompt.includes("corrected-contract") && prompt.includes("本方案在 qa 职责")) {
    const marker = path.join(process.cwd(), "..", "corrected-qa-interrupted");
    try { await fs.access(marker); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.writeFile(marker,"first"); process.exitCode=1;
    }
  }
  if (!process.exitCode) `;
  const { projectRoot, project } = await analysisFixture(t, [...technicalCorrectionModel,
    ['process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}', stop + 'process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}']]);
  await assert.rejects(plan(projectRoot, "REQ-001"), /Pi did not complete/);
  const failed = await readTask(project, "REQ-001");
  const saved = failed.events.find(event => event.type === "plan_correction_completed");
  const original = await fs.readFile(saved.detail.draftFile, "utf8");
  await fs.writeFile(saved.detail.draftFile, JSON.stringify({...JSON.parse(original), markdown:"tampered"}));
  await assert.rejects(plan(projectRoot, "REQ-001"), /correction checkpoint changed/);
  await fs.writeFile(saved.detail.draftFile, original);
  assert.equal((await plan(projectRoot, "REQ-001")).blocked, false);
  const task = await readTask(project, "REQ-001");
  assert.equal(task.events.filter(event => event.type === "plan_draft_completed").length, 1);
  assert.equal(task.events.filter(event => event.type === "plan_correction_completed").length, 1);
  assert.equal(task.events.filter(event => event.type === "plan_correction_reused").length, 1);
  assert.equal(executionUsage(task.events).unmeasuredCalls, 0);
  assert.ok(Math.abs(task.meta.reviewCostUsd - .49) < 1e-9);
});

test("internal section corrections retain the exact developer proposal binding", async t => {
  const { projectRoot, project } = await analysisFixture(t, technicalCorrectionModel);
  await plan(projectRoot,"REQ-001");
  const task=await readTask(project,"REQ-001");
  const {markdown,...candidate}=JSON.parse(await fs.readFile(path.join(task.directory,"plan-analysis-v1.json"),"utf8")).draft;
  candidate.design.approach="研发建议保留现有模块结构和原加法。";
  await revisePlan(projectRoot,"REQ-001","reviewer","核对这个局部提案",undefined,{candidate,expectedPlanHash:task.meta.planHash});
  const updated=await readTask(project,"REQ-001");
  const analysis=JSON.parse(await fs.readFile(path.join(task.directory,"plan-analysis-v2.json"),"utf8"));
  assert.equal(analysis.draft.candidateReview.proposalHash,sha256(JSON.stringify(candidate)));
  assert.equal(analysis.internalCorrection.attempts,1);
  assert.equal(updated.meta.state,"plan_review");
  assert.equal(updated.meta.planBlockers.length,0);
});

test("invalid section corrections report failure and cannot replace the frozen plan", async t => {
  const { projectRoot, project }=await analysisFixture(t,[...technicalCorrectionModel,
    ['const navigation = JSON.parse(prompt.match(/当前方案导航：', 'analysis.affectedFiles=["outside/rogue.mjs"];\n    const navigation = JSON.parse(prompt.match(/当前方案导航：']]);
  await assert.rejects(plan(projectRoot,"REQ-001"),/unique files within project policy/);
  const task=await readTask(project,"REQ-001");
  const failure=task.events.find(event=>event.type==="plan_correction_failed");
  assert.equal(failure.detail.modelRun,true);
  assert.ok(failure.detail.telemetry.tokens.output>0);
  assert.equal(executionUsage(task.events).unmeasuredCalls,0);
  assert.equal(task.events.some(event=>event.type==="plan_correction_completed"),false);
  assert.equal(task.meta.planVersion,0);
  await assert.rejects(approvePlan(projectRoot,"REQ-001","reviewer"),/expected plan_review/);
});

test("internal correction enforces the remaining model budget before another call", async t => {
  const { projectRoot, project } = await analysisFixture(t, technicalCorrectionModel, {
    admission: { ...admissionDefaults, budgetMode:"strict", maxModelCalls:5, restrictedPaths:[] } });
  await assert.rejects(plan(projectRoot, "REQ-001"), /execution budget exhausted/);
  const task = await readTask(project, "REQ-001");
  assert.equal(task.events.some(event => event.type === "plan_correction_completed"), false);
  const failed = task.events.find(event => event.type === "plan_correction_failed");
  assert.equal(failed.detail.modelRun, false);
  assert.equal(executionUsage(task.events).calls, 5);
  assert.equal(task.meta.state, "contract_confirmed");
  assert.equal(task.meta.workspace, undefined);
});

test("real Pi reads the saved draft and submits a section patch before human review", {
  skip: !process.env.REQFLOW_TEST_PI,
}, async t => {
  const seed = await analysisFixture(t, technicalCorrectionModel.slice(0, 1));
  await plan(seed.projectRoot, "REQ-001");
  const { markdown, ...initial } = JSON.parse(await fs.readFile(path.join((await readTask(seed.project, "REQ-001")).directory, "plan-analysis-v1.json"), "utf8")).draft;
  const target = await analysisFixture(t);
  const cert = path.join(target.temporary, "fixture-cert.pem");
  const key = path.join(target.temporary, "fixture-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], {stdio:"ignore"});
  const requests = [];
  const server = createHttpsServer({key:await fs.readFile(key),cert:await fs.readFile(cert)}, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    const message = payload.messages.findLast(row => row.role === "user").content;
    const prompt = typeof message === "string" ? message : message.filter(row => row.type === "text").map(row => row.text).join("\n");
    let delta;
    if (payload.response_format?.json_schema?.name === "delivery_plan_correction") {
      const original = payload.messages.filter(row=>row.role==="user").map(row=>typeof row.content==="string"
        ? row.content : row.content.filter(part=>part.type==="text").map(part=>part.text).join("\n"))
        .find(text=>text.startsWith("局部研发方案纠错"));
      const navigation = JSON.parse(original.match(/当前方案导航：(.*)\n承接检查/)[1]);
      if (!payload.messages.some(row => row.role === "tool")) {
        delta = { role:"assistant", tool_calls:[{index:0,id:"read-draft",type:"function",function:{name:"read_plan",
          arguments:JSON.stringify({planHash:navigation.draftHash,section:"backend",offset:0,maxChars:1000})}}] };
      } else {
        const patch = Object.fromEntries(Object.keys(payload.response_format.json_schema.schema.properties).map(key => [key,null]));
        patch.design = Object.fromEntries(navigation.sections.map(key => [key,null]));
        patch.design.backend = "corrected-contract: multiply接收两个数并返回乘积，保留加法。";
        patch.design.interfaces = [{name:"乘法调用",method:"function",path:"multiply(left, right)",status:"new",sourceFile:"src/calculator.mjs",request:"left=2,right=3",response:"6",errors:"原有数值输入约定"}];
        patch.design.components = [{file:"src/calculator.mjs",domain:"shared",location:"multiply函数",pseudocode:"return left * right"}];
        const correctionRequests = requests.filter(row=>row.response_format?.json_schema?.name==="delivery_plan_correction").length;
        if (correctionRequests === 2) patch.verification = [{acceptanceId:"AC1",scenario:"局部修改",regression:"保留加法"}];
        else if (correctionRequests === 3) patch.design.interfaces[0] = {...patch.design.interfaces[0],status:"modified",sourceFile:"src/missing.mjs"};
        else patch.verification = {AC1:{scenario:"乘法返回6",regression:"加法仍返回5"}};
        delta = {role:"assistant",content:JSON.stringify(patch)};
      }
    } else if (prompt.startsWith("研发方案专项检查")) {
      const role = prompt.match(/本方案在 (frontend|backend|qa) 职责/)[1];
      delta = {role:"assistant",content:JSON.stringify({findings:!prompt.includes("corrected-contract") && role!=="backend"
          ? [{severity:"blocking",subject:"模块调用契约遗漏",evidence:"前端需要multiply，interfaces为空",recommendation:"补齐接口清单并同步后端说明"}] : []})};
    } else delta = {role:"assistant",content:JSON.stringify(initial)};
    response.writeHead(200,{"Content-Type":"text/event-stream"});
    response.write(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    response.write(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:delta.tool_calls?"tool_calls":"stop"}],usage:{prompt_tokens:200,completion_tokens:100,total_tokens:300}})}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  // Configure only the isolated fixture; no company project or real provider is used.
  const previous = {key:process.env.SMOKE_MODEL_KEY,home:process.env.PI_CODING_AGENT_DIR,cert:process.env.NODE_EXTRA_CA_CERTS};
  process.env.SMOKE_MODEL_KEY="local-fixture"; process.env.PI_CODING_AGENT_DIR=path.join(target.temporary,"pi-home");
  process.env.NODE_EXTRA_CA_CERTS=cert;
  t.after(()=>{
    for (const [name,value] of [["SMOKE_MODEL_KEY",previous.key],["PI_CODING_AGENT_DIR",previous.home],["NODE_EXTRA_CA_CERTS",previous.cert]]) {
      if(value===undefined) delete process.env[name]; else process.env[name]=value;
    }
  });
  const configFile=path.join(target.projectRoot,".reqflow/config.json");
  const config=JSON.parse(await fs.readFile(configFile,"utf8"));
  Object.assign(config,{piExecutable:process.env.REQFLOW_TEST_PI,provider:"local-fixture",model:"local",thinking:"off",structuredOutput:true,
    environment:{...config.environment,pi:["SMOKE_MODEL_KEY","PI_CODING_AGENT_DIR","NODE_EXTRA_CA_CERTS"]},
    compatibleProviders:[{name:"local-fixture",baseUrl:`https://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:"SMOKE_MODEL_KEY",thinkingToggle:false,
      models:[{id:"local",input:["text"],contextWindow:32000,maxTokens:4000,reasoning:false,supportsJsonSchema:true}]}]});
  await fs.writeFile(configFile,JSON.stringify(config));
  await refreshProjectBaseline(await loadProject(target.projectRoot));
  const before=await fs.readFile(path.join(target.projectRoot,"src/calculator.mjs"),"utf8");
  assert.equal((await plan(target.projectRoot,"REQ-001")).blocked,false);
  const task=await readTask(await loadProject(target.projectRoot),"REQ-001");
  const corrected=task.events.find(event=>event.type==="plan_correction_completed");
  assert.match(await fs.readFile(corrected.detail.logFile,"utf8"),/reqflow_plan_read/);
  assert.equal(task.meta.state,"plan_review"); assert.equal(task.meta.workspace,undefined);
  assert.equal(await fs.readFile(path.join(target.projectRoot,"src/calculator.mjs"),"utf8"),before);
   assert.equal(requests.length,11);
  const patchRequests=requests.filter(row=>row.response_format?.json_schema?.name==="delivery_plan_correction");
   assert.equal(patchRequests.length,4);
  assert.equal(patchRequests[1].messages.some(row=>row.role==="tool" && row.content.includes("Plan material version changed")),false);
  assert.equal(executionUsage(task.events).unmeasuredCalls,0);
   assert.deepEqual(corrected.detail.telemetry.planValidation.map(row=>row.status),["invalid","invalid","valid"]);
   assert.match(corrected.detail.telemetry.planValidation[1].error,/源码不存在/);
   const final = JSON.parse(await fs.readFile(path.join(task.directory,"plan-analysis-v1.json"),"utf8"));
   assert.deepEqual(final.draft.design.components[1],initial.design.components[1]);
});

test("direct plan edits are versioned proposals and stale approvals cannot start implementation", async (t) => {
  const { projectRoot, project } = await analysisFixture(t);
  await plan(projectRoot, "REQ-001");
  const principal = { id: "reviewer", roles: ["developer"] };
  const before = await getRequirementEvidence(projectRoot, principal, "REQ-001");
  const candidate = structuredClone(before.planAnalysis.draft); delete candidate.markdown;
  candidate.changes[0].description = "复用现有计算约定，增加 multiply；不改变 add。";
  const input = { action: "edit-plan", candidate, feedback: "希望复用现有计算约定。", expectedPlanHash: before.meta.planHash };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { ...input,
    candidate: { ...candidate, verification: [] } }, principal), /cover each acceptance/);
  assert.equal((await readTask(project, "REQ-001")).meta.planVersion, 1);
  await executeRequirementAction(projectRoot, "REQ-001", input, principal);
  const after = await readTask(project, "REQ-001");
  assert.equal(after.meta.planVersion, 2);
  assert.equal(after.meta.state, "plan_review");
  assert.equal(after.meta.contractHash, before.meta.contractHash);
  const requested = after.events.findLast(event => event.type === "plan_revision_requested");
  assert.equal(requested.detail.candidate.changes[0].description, candidate.changes[0].description);
  assert.equal(requested.detail.revisionKind, "direct_edit");
  assert.equal(after.meta.workspace, undefined);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { action: "approve-plan",
    expectedPlanHash: "0".repeat(64) }, principal), /plan has changed/);
  assert.equal((await readTask(project, "REQ-001")).events.some(event => event.type === "plan_approved"), false);
});

test("plan dialogue preserves the confirmed version, checks ownership and counts its usage", async (t) => {
  const { projectRoot, project } = await analysisFixture(t);
  await plan(projectRoot, "REQ-001");
  const before = await readTask(project, "REQ-001");
  const principal = { id: "reviewer", roles: ["developer"] };
  const body = { action: "discuss-plan", message: { text: "这会改变原有加法吗？", expectedPlanHash: before.meta.planHash } };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", body, { id: "product", roles: ["product"] }), /Role cannot perform/);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { ...body,
    message: { ...body.message, expectedPlanHash: "0".repeat(64) } }, principal), /plan has changed/);
  const result = await executeRequirementAction(projectRoot, "REQ-001", body, principal);
  assert.equal(result.reply.recommendation, "keep");
  const drift = await executeRequirementAction(projectRoot, "REQ-001", { ...body,
    message: { ...body.message, text: "顺便新增除法" } }, principal);
  assert.equal(drift.reply.recommendation, "product_confirmation");
  const after = await readTask(project, "REQ-001");
  assert.equal(after.meta.state, "plan_review");
  assert.equal(after.meta.planHash, before.meta.planHash);
  assert.equal(after.meta.contractHash, before.meta.contractHash);
  assert.equal(after.meta.workspace, undefined);
  assert.equal(after.events.some(event => event.type === "plan_approved"), false);
  const evidence = await getRequirementEvidence(projectRoot, principal, "REQ-001");
  assert.equal(evidence.planDiscussion.messages.filter(row => row.type === "plan_reply").length, 2);
  assert.equal((await getTaskObservability(projectRoot, principal, "REQ-001")).summary.attempts, 4);
});

test("dialogue sees data recovery classification and empty questions cannot clear technical blockers", async t => {
  const { projectRoot, project } = await analysisFixture(t, [[
    'data: { status: "none", evidence: "src/calculator.mjs 不读取或写入持久数据。" }',
    'data: { status: "changed", evidence: "本测试方案声明持久化写入，恢复方式尚未记录。" }',
  ]]);
  await plan(projectRoot, "REQ-001");
  const before = await readTask(project, "REQ-001");
  assert.ok(before.meta.planBlockers.length);
  const reply = await executeRequirementAction(projectRoot, "REQ-001", { action: "discuss-plan", message: {
    text: "没有改表结构是否还需要恢复数据？", expectedPlanHash: before.meta.planHash } }, { id: "reviewer", roles: ["developer"] });
  assert.equal(reply.reply.recommendation, "keep");
  assert.deepEqual(reply.reply.pendingQuestions, []);
  const after = await readTask(project, "REQ-001");
  assert.deepEqual(after.meta.planBlockers, before.meta.planBlockers);
  const context = after.events.findLast(row => row.type === "plan_context_prepared").detail.context;
  assert.equal(context.planSummary.safety.dataImpact, "changed");
  assert.equal(context.planSummary.safety.recovery.status, "code_only");
  assert.equal(context.planSummary.safety.externalEffects.status, "none");
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /unresolved blockers/);
  assert.equal(after.meta.workspace, undefined);
});

test("plan dialogue bounds history by bytes, retrieves omitted advice and excludes failure diagnostics", async t => {
  const { projectRoot, project } = await analysisFixture(t, [['const prompt = process.argv.at(-1);',
    'const prompt = process.argv.at(-1); if (prompt.startsWith("研发方案沟通")) await fs.writeFile(new URL("./dialogue-prompt.txt", import.meta.url), prompt);']]);
  await plan(projectRoot, "REQ-001");
  const before = await readTask(project, "REQ-001");
  for (let index = 0; index < 4; index++) {
    await appendEvent(project, "REQ-001", "plan_message", before.meta, { actor: "reviewer", text: "研发意见".repeat(990) });
    await appendEvent(project, "REQ-001", "plan_reply", before.meta, { actor: "reviewer", modelRun: false, reply: {
      schemaVersion: 1, planHash: before.meta.planHash, reply: "源码依据".repeat(440) + "OMITTED_ADVICE", recommendation: "keep", reasons: [], pendingQuestions: [] } });
  }
  await appendEvent(project, "REQ-001", "plan_discussion_failed", before.meta, { actor: "reviewer", modelRun: false, error: "INTERNAL_FAILURE_NOT_ADVICE" });
  await executeRequirementAction(projectRoot, "REQ-001", { action: "discuss-plan", message: {
    text: "请核对当前方案", expectedPlanHash: before.meta.planHash } }, { id: "reviewer", roles: ["developer"] });
  const prompt = await fs.readFile(path.join(path.dirname(project.config.piExecutable), "dialogue-prompt.txt"), "utf8");
  const recent = JSON.parse(prompt.match(/^近期沟通摘录.*：(.+)$/m)[1]);
  assert.ok(Buffer.byteLength(JSON.stringify(recent)) <= 4000);
  assert.ok(recent.length > 0);
  assert.ok(recent.every(row => row.text.length <= 400 && row.textPartial));
  assert.ok(recent.some(row => row.role === "ai"));
  assert.ok(recent.some(row => row.role === "developer"));
  assert.doesNotMatch(prompt, /INTERNAL_FAILURE_NOT_ADVICE|OMITTED_ADVICE/);
  assert.match(prompt, /read_discussion/);
  const task = await readTask(project, "REQ-001");
  const original = task.events.find(event => event.hash === recent.find(row => row.role === "ai").eventHash);
  const raw = JSON.stringify(original.detail.reply);
  const fragment = await readDiscussionEvidence(project, "REQ-001", { eventHash: original.hash,
    offset: raw.indexOf("OMITTED_ADVICE"), maxChars: 30 });
  assert.match(fragment.text, /^OMITTED_ADVICE/);
  assert.match(fragment.note, /AI advice is a proposal/);
  await assert.rejects(readDiscussionEvidence(project, "REQ-001", {
    eventHash: task.events.findLast(row => row.type === "plan_discussion_failed").hash, offset: 0, maxChars: 30 }), /human message or AI plan reply/);
  assert.equal(task.meta.planHash, before.meta.planHash);
  assert.equal(task.meta.contractHash, before.meta.contractHash);
  assert.equal(task.meta.state, "plan_review");
  const context = task.events.findLast(event => event.type === "plan_context_prepared").detail;
  assert.equal(context.contextHash, sha256(JSON.stringify(context.context)));
  assert.equal(Object.hasOwn(context.context, "draft"), false);
  assert.ok(context.context.planSummary.omittedSections.includes("components"));
  const planPart = await readPlanMaterial(project, "REQ-001", { planHash: task.meta.planHash,
    section: "components", offset: 0, maxChars: 100 });
  assert.match(planPart.text, /calculator/);
  assert.equal(planPart.text.length, 100);
  assert.equal(planPart.partial, true);
  await assert.rejects(readPlanMaterial(project, "REQ-001", { planHash: "0".repeat(64), section: "components", offset: 0, maxChars: 100 }), /version changed/);
  await assert.rejects(readPlanMaterial(project, "REQ-001", { planHash: task.meta.planHash, section: "secret", offset: 0, maxChars: 100 }), /exact version/);
  await assert.rejects(readPlanMaterial(project, "REQ-001", { planHash: task.meta.planHash, section: "components", offset: 100000, maxChars: 100 }), /offset exceeds/);
});

test("review document is generated from one plan and inconsistent file descriptions cannot be approved", async t => {
  const { projectRoot, project } = await analysisFixture(t);
  await plan(projectRoot, "REQ-001");
  const task = await readTask(project, "REQ-001");
  const document = await fs.readFile(path.join(task.directory, "plan-v1.md"), "utf8");
  const analysis = JSON.parse(await fs.readFile(path.join(task.directory, "plan-analysis-v1.json"), "utf8"));
  assert.equal(document, analysis.draft.markdown);
  for (const item of analysis.draft.changes) {
    const section = document.split(`### ${item.file}\n`)[1].split("\n##")[0];
    assert.ok(section.includes(item.description));
  }
  const rawEvents = (await fs.readFile(path.join(task.directory, "plan-v1-attempt-1.events.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  const output = JSON.parse(rawEvents.findLast(event => event.type === "message_end").message.content[0].text);
  assert.equal(Object.hasOwn(output, "markdown"), false);
  for (const [injection, error] of [
    ['analysis.changes[0].file = "src/unapproved.mjs";', /describe each proposed file/],
    ['delete analysis.changes[0].description;', /模型输出不符合 delivery_plan 结构：.*"instancePath":"\/changes\/0".*"missingProperty":"description"/],
    ['analysis.markdown = "unrelated proposal";', /模型输出不符合 delivery_plan 结构：.*"additionalProperty":"markdown"/],
    ['analysis.verification = "run existing tests";', /模型输出不符合 delivery_plan 结构：.*"instancePath":"\/verification".*"type":"array"/],
  ]) {
    const bad = await analysisFixture(t, [['const text = phase ===', `if (phase === "plan") { ${injection} }\nconst text = phase ===`]]);
    await assert.rejects(plan(bad.projectRoot, "REQ-001"), error);
    assert.equal((await readTask(bad.project, "REQ-001")).meta.state, "contract_confirmed");
    await assert.rejects(approvePlan(bad.projectRoot, "REQ-001", "reviewer"), /expected plan_review/);
  }
});

test("partial planning resumes verified checkpoints without repeating completed model calls", async t => {
  const { projectRoot, project } = await analysisFixture(t, transientQaFailure);
  await assert.rejects(plan(projectRoot, "REQ-001"), /Injected transient QA provider rejection/);
  const failed = await readTask(project, "REQ-001");
  const checkpoint = failed.events.find(event => event.type === "plan_draft_completed").detail;
  const original = await fs.readFile(checkpoint.draftFile, "utf8");
  const material = await readPlanMaterial(project, "REQ-001", { planHash: checkpoint.analysisHash, section: "backend", offset: 0, maxChars: 1000 });
  assert.equal(material.text, JSON.parse(original).design.backend);
  await assert.rejects(readPlanMaterial(project, "REQ-001", { planHash: "a".repeat(64), section: "backend", offset: 0, maxChars: 1000 }), /version changed/);
  const changed = JSON.parse(original); changed.markdown += "\nChanged checkpoint";
  await fs.writeFile(checkpoint.draftFile, JSON.stringify(changed));
  await assert.rejects(readPlanMaterial(project, "REQ-001", { planHash: checkpoint.analysisHash, section: "backend", offset: 0, maxChars: 1000 }), /draft material changed/);
  await assert.rejects(plan(projectRoot, "REQ-001"), /Plan draft checkpoint changed/);
  await fs.writeFile(checkpoint.draftFile, original);
  assert.equal((await plan(projectRoot, "REQ-001")).state, "plan_review");
  const { events } = await readTask(project, "REQ-001");
  assert.equal(events.filter(event => event.type === "plan_draft_completed").length, 1);
  assert.equal(events.filter(event => event.type === "plan_draft_reused").length, 1);
  assert.equal(events.filter(event => event.type === "plan_specialist_completed" && event.detail.role === "backend").length, 1);
  assert.equal(events.filter(event => event.type === "plan_specialist_reused" && event.detail.role === "backend").length, 1);
  assert.equal(events.filter(event => event.type === "plan_specialist_completed" && event.detail.role === "qa").length, 1);
  assert.equal(executionUsage(events).calls, 6);
  const observed = await getTaskObservability(projectRoot, { id: "reviewer", roles: ["developer"] }, "REQ-001");
  assert.equal(observed.summary.providerRequests, 6);
  assert.equal(observed.summary.skippedCalls, 3);
  assert.ok(observed.runs.filter(run => run.status === "skipped").every(run => run.sourceEventHash && run.reason));
  assert.equal((await approvePlan(projectRoot, "REQ-001", "reviewer")).state, "approved");
});

test("a changed frozen contract invalidates prior plan and specialist checkpoints", async t => {
  const { projectRoot, project } = await analysisFixture(t, transientQaFailure);
  await assert.rejects(plan(projectRoot, "REQ-001"), /Injected transient QA provider rejection/);
  const prior = await readTask(project, "REQ-001");
  const contract = JSON.parse(await fs.readFile(path.join(prior.directory, "contract-v1.json"), "utf8"));
  await reviseContract(projectRoot, "REQ-001", "product", { ...contract, objective: "Support multiplication with existing addition preserved" });
  assert.equal((await plan(projectRoot, "REQ-001")).state, "plan_review");
  const { events } = await readTask(project, "REQ-001");
  assert.equal(events.filter(event => event.type === "plan_draft_completed").length, 2);
  assert.equal(events.filter(event => event.type === "plan_draft_reused").length, 0);
  assert.equal(events.filter(event => event.type === "plan_specialist_reused").length, 0);
  assert.equal((await approvePlan(projectRoot, "REQ-001", "reviewer")).state, "approved");
});

test("assigned plan owner can narrow writes without changing proposal or regression requirements", async (t) => {
  const { projectRoot, project } = await analysisFixture(t, [['if (phase === "implement") {',
    'if (phase === "implement") {\n  const guard = JSON.parse(process.env.REQFLOW_POLICY);\n  if (!process.argv.at(-1).includes("Existing regression remains mandatory and read-only.")) throw new Error("Approved owner guidance missing");\n  if (guard.approvedFiles.join() !== "src/calculator.mjs") throw new Error("Narrowed write scope missing");']]);
  await plan(projectRoot, "REQ-001");
  const { directory } = await readTask(project, "REQ-001");
  const proposal = await fs.readFile(path.join(directory, "plan-analysis-v1.json"), "utf8");
  const scope = { files: ["src/calculator.mjs"], reason: "Existing regression remains mandatory and read-only." };
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "other", scope), /assigned developer/);
  for (const invalid of [{ ...scope, files: [] }, { ...scope, files: ["new.mjs"] },
    { ...scope, files: ["src/calculator.mjs", "src/calculator.mjs"] }, { ...scope, reason: "" }]) {
    await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer", invalid), /Approval scope requires/);
  }
  const approved = await approvePlan(projectRoot, "REQ-001", "reviewer", scope);
  assert.deepEqual(approved.developmentFiles, scope.files);
  assert.equal(await fs.readFile(path.join(directory, "plan-analysis-v1.json"), "utf8"), proposal);
  const { events } = await readTask(project, "REQ-001");
  assert.equal(events.at(-1).detail.scopeDecision.reason, scope.reason);
  assert.deepEqual(events.at(-1).detail.scopeDecision.proposedFiles, ["src/calculator.mjs", "test/calculator.test.mjs"]);
  await assert.rejects(implement(projectRoot, "REQ-001"), /file outside approved plan: test\/calculator.test.mjs/);
  assert.equal((await readTask(project, "REQ-001")).meta.state, "implementation_failed");
});

test("tampered approval scope prevents implementation", async (t) => {
  const { projectRoot, project } = await analysisFixture(t);
  await plan(projectRoot, "REQ-001");
  await approvePlan(projectRoot, "REQ-001", "reviewer", { files: ["src/calculator.mjs"], reason: "Regression tests remain unchanged." });
  const { directory } = await readTask(project, "REQ-001");
  const file = path.join(directory, "plan-scope-v1.json");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, original.replace('"src/calculator.mjs"', '"src/other.mjs"'));
  await assert.rejects(implement(projectRoot, "REQ-001"), /Approved plan scope changed/);
});

test("cross-end analysis selects specialists without comparing their wording", async (t) => {
  const { projectRoot, project } = await analysisFixture(t, [
    ['domains: ["backend"]', 'domains: ["frontend", "backend"]'],
    ['findings: [] };', 'findings: [{ severity: "advisory", subject: role + " naming suggestion", evidence: "src/calculator.mjs:1", recommendation: role + " recommendation" }] };'],
  ], { agentModels: { backendReview: { provider: "review", model: "backend-specialist" }, frontendReview: { provider: "review", model: "frontend-specialist" } } });
  await plan(projectRoot, "REQ-001");
  const task = await readTask(project, "REQ-001");
  assert.deepEqual(task.events.filter((event) => event.type === "plan_specialist_completed").map((event) => event.detail.role), ["frontend", "backend", "qa"]);
  const observed = await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001");
  assert.equal(observed.summary.attempts, 4);
  assert.deepEqual(observed.runs.slice(1).map((run) => run.telemetry.model), ["frontend-specialist", "backend-specialist", "fake-model"]);
  assert.equal((await approvePlan(projectRoot, "REQ-001", "reviewer")).state, "approved");
  const row = JSON.parse(await fs.readFile(path.join(task.directory, "plan-analysis-v1.json"), "utf8")).specialists[0];
  await fs.writeFile(row.file, JSON.stringify({ ...row.findings, findings: [] }));
  await assert.rejects(implement(projectRoot, "REQ-001"), /specialist evidence changed/);
});

test("unknown impact and concrete specialist blockers cannot be approved", async (t) => {
  for (const issue of ["unknown", "blocking"]) {
    const changes = issue === "unknown"
      ? [['status: refineAddition ? "changed" : "none"', 'status: "unknown"']]
      : [['domains: ["backend"]', 'domains: ["frontend", "backend"]'],
        ['findings: [] };', 'findings: [{ severity: "blocking", subject: "Existing behavior conflict", evidence: "src/calculator.mjs:2", recommendation: "Clarify the existing add regression" }] };']];
    const { projectRoot, project } = await analysisFixture(t, changes);
    assert.equal((await plan(projectRoot, "REQ-001")).blocked, true);
    const task = await readTask(project, "REQ-001");
    assert.ok(task.meta.planBlockers.length);
    assert.equal((await getRequirementLifecycle(projectRoot, { id: "product", roles: ["product"] }, "REQ-001")).status.needsAttention, true);
    await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /unresolved blockers/);
    assert.equal(task.meta.workspace, undefined);
    const report = await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001");
    assert.equal(report.summary.attempts, issue === "unknown" ? 2 : 5);
    assert.equal(task.events.filter(event => event.type === "plan_correction_completed").length, 1);
  }
});

test("assigned developer can resolve evidenced review findings, but not unknown impacts", async (t) => {
  const changes = [['domains: ["backend"]', 'domains: ["frontend", "backend"]'],
    ['findings: [] };', 'findings: [{severity:"blocking",subject:"source missing",evidence:"src/calculator.mjs:1",recommendation:"Check actual file"}] };']];
  const { projectRoot, project } = await analysisFixture(t, changes);
  await plan(projectRoot, "REQ-001");
  const task = await readTask(project, "REQ-001");
  const analysis = JSON.parse(await fs.readFile(path.join(task.directory, "plan-analysis-v1.json"), "utf8"));
  const resolution = { implementationGuidance: "Source exists; keep addition regression and add multiplication tests within the two approved files.",
    items: analysis.specialists.flatMap(row => row.findings.findings.map(finding => ({
      findingId: `${row.role}:${sha256(JSON.stringify(finding))}`, disposition: "false_positive",
      reason: "The referenced source file exists and its actual implementation is archived below.",
      sources: [{ file: "src/calculator.mjs", startLine: 1, endLine: 3 }] }))) };
  const action = (principal, value) => executeRequirementAction(projectRoot, "REQ-001", { action: "resolve-plan-findings", resolution: value }, principal);
  const reviewer = { id: "reviewer", roles: ["developer"] };
  await assert.rejects(action({ id: "unassigned", roles: ["developer"] }, resolution), /not assigned/);
  await assert.rejects(action({ id: "product", roles: ["product"] }, resolution), /Role cannot/);
  await assert.rejects(action(reviewer, { ...resolution, items: [] }), /explicit items/);
  await assert.rejects(action(reviewer, { ...resolution, items: resolution.items.slice(0, 1) }), /every blocking/);
  await action(reviewer, resolution);
  const evidence = await getRequirementEvidence(projectRoot, reviewer, "REQ-001");
  assert.equal(evidence.planAnalysis.admission.eligible, true);
  assert.equal((await getRequirementLifecycle(projectRoot, reviewer, "REQ-001")).status.needsAttention, false);
  assert.ok(evidence.planAnalysis.originalBlockers.length);
  assert.match(evidence.planAnalysis.resolution.items[0].sources[0].text, /add/);
  assert.equal((await approvePlan(projectRoot, "REQ-001", "reviewer")).state, "approved");
  const file = path.join(task.directory, "plan-findings-resolution-v1.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...saved, implementationGuidance: "changed" }));
  await assert.rejects(implement(projectRoot, "REQ-001"), /resolution changed/);
  const unknown = await analysisFixture(t, [['status: refineAddition ? "changed" : "none"', 'status: "unknown"']]);
  await plan(unknown.projectRoot, "REQ-001");
  await assert.rejects(executeRequirementAction(unknown.projectRoot, "REQ-001", { action: "resolve-plan-findings", resolution }, reviewer), /Unknown impacts/);
});

test("a diagnosed zero-change failure resumes manually without erasing usage or failure history", async (t) => {
  const stop = 'if (phase === "implement") { process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\\n"); process.stderr.write("provider interrupted before editing"); process.exit(1); }\n';
  const { projectRoot, project } = await analysisFixture(t, [['const refineAddition =', stop + 'const refineAddition =']]);
  await plan(projectRoot, "REQ-001");
  await approvePlan(projectRoot, "REQ-001", "reviewer");
  await assert.rejects(implement(projectRoot, "REQ-001"), /provider interrupted/);
  const failed = await readTask(project, "REQ-001");
  assert.equal(failed.meta.changeCount, 0);
  const body = { action: "resume-implementation", files: ["src/calculator.mjs", "test/calculator.test.mjs"], evidence: "Provider failure before editing was diagnosed; executable repaired, existing approval and recovery snapshot are unchanged." };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", body, { id: "other", roles: ["developer"] }), /not assigned/);
  const filename = project.config.piExecutable;
  const source = await fs.readFile(filename, "utf8");
  assert.ok(source.includes(stop));
  await fs.writeFile(filename, source.replace(stop, ""));
  await executeRequirementAction(projectRoot, "REQ-001", body, { id: "reviewer", roles: ["developer"] });
  await implement(projectRoot, "REQ-001");
  await verify(projectRoot, "REQ-001");
  const completed = await readTask(project, "REQ-001");
  assert.equal(completed.meta.state, "verified");
  assert.equal(completed.events.filter(event => event.type === "implementation_failed").length, 1);
  assert.equal(completed.events.filter(event => event.type === "implementation_resumed").length, 1);
  const telemetry = completed.events.findLast(event => event.type === "implemented").detail.telemetry;
  assert.match(telemetry.logFile, /implement-attempt-2.events.jsonl$/);
});

test("manual partial resume requires identical audited workspace and approved file scope", async (t) => {
  const stop = 'if (phase === "implement") { await fs.appendFile(path.join(process.cwd(), "src/calculator.mjs"), "\\n// partial model change\\n"); process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\\n"); process.stderr.write("interrupted after editing"); process.exit(1); }\n';
  const { projectRoot, project } = await analysisFixture(t, [['const refineAddition =', stop + 'const refineAddition =']]);
  await plan(projectRoot, "REQ-001");
  await approvePlan(projectRoot, "REQ-001", "reviewer");
  await assert.rejects(implement(projectRoot, "REQ-001"), /interrupted after editing/);
  const failed = await readTask(project, "REQ-001");
  assert.equal(failed.meta.changeCount, 1);
  const body = { action: "resume-implementation", files: ["src/calculator.mjs", "test/calculator.test.mjs"], evidence: "Responsible developer inspected the exact partial change and repaired the interrupted model executable; no data or external effects." };
  const principal = { id: "reviewer", roles: ["developer"] };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { ...body, files: ["src/outside.mjs"] }, principal), /approved implementation files/);
  const file = path.join(failed.meta.workspace, "src/calculator.mjs");
  const partial = await fs.readFile(file, "utf8");
  await fs.appendFile(file, "// external modification\n");
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", body, principal), /changed before resume/);
  await fs.writeFile(file, partial);
  const executable = project.config.piExecutable;
  await fs.writeFile(executable, (await fs.readFile(executable, "utf8")).replace(stop, ""));
  await executeRequirementAction(projectRoot, "REQ-001", body, principal);
  await implement(projectRoot, "REQ-001");
  await verify(projectRoot, "REQ-001");
  const completed = await readTask(project, "REQ-001");
  assert.equal(completed.meta.state, "verified");
  assert.equal(completed.events.find(event => event.type === "implementation_resumed").detail.afterHash, failed.meta.afterHash);
  assert.equal(completed.events.find(event => event.type === "implementation_failed").detail.telemetry.tokens.input, 50);
  const evidence = await getRequirementEvidence(projectRoot, principal, "REQ-001");
  assert.equal(evidence.implementationAttempts.length, 1);
  const retained = path.join(evidence.implementationAttempts[0].retained, "after/src/calculator.mjs");
  assert.equal(await fs.readFile(retained, "utf8"), partial);
  await fs.appendFile(retained, "// tampered archive\n");
  await assert.rejects(getRequirementEvidence(projectRoot, principal, "REQ-001"), /Retained implementation file changed/);
  await rollback(projectRoot, "REQ-001", "reviewer");
  assert.equal((await fs.readFile(file, "utf8")).includes("partial model change"), false);
});

test("project-scope failure can resume an audited addition without broadening the repair", async t => {
  const stop = 'if (phase === "implement") { await fs.writeFile(path.join(process.cwd(), "src/support.mjs"), "export const value = 1;\\n"); process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\\n"); process.stderr.write("interrupted after addition"); process.exit(1); }\n';
  const { projectRoot, project } = await analysisFixture(t, [['const refineAddition =', stop + 'const refineAddition =']]);
  await plan(projectRoot, "REQ-001");
  await approvePlan(projectRoot, "REQ-001", "reviewer");
  await assert.rejects(implement(projectRoot, "REQ-001"), /interrupted after addition/);
  const body = { action: "resume-implementation", files: ["src/support.mjs"],
    evidence: "Inspected the audited addition; correct its constant within the original requirement.",
    reviewedEdits: [{ file: "src/support.mjs", oldText: "value = 1", newText: "value = 2" }] };
  const principal = { id: "reviewer", roles: ["developer"] };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { ...body, files: ["src/never-authorized.mjs"] }, principal), /approved implementation files/);
  await executeRequirementAction(projectRoot, "REQ-001", body, principal);
  const repaired = await readTask(project, "REQ-001");
  assert.equal(repaired.meta.state, "implemented", "fresh verification is still required");
  assert.equal(await fs.readFile(path.join(repaired.meta.workspace, "src/support.mjs"), "utf8"), "export const value = 2;\n");
  assert.equal(repaired.events.filter(event => event.type === "implementation_failed").length, 1);
});

test("owner-reviewed replacements retain failure and usage and require fresh verification", async t => {
  const stop = 'if (phase === "implement") { await fs.appendFile("src/calculator.mjs", "\\n// partial model change\\n"); process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",usage:{input:50,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}}})+"\\n");process.exit(1); }\n';
  const { projectRoot, project } = await analysisFixture(t, [['const refineAddition =', stop + 'const refineAddition =']]);
  await plan(projectRoot, "REQ-001");
  await approvePlan(projectRoot, "REQ-001", "reviewer");
  await assert.rejects(implement(projectRoot, "REQ-001"), /Pi did not complete/);
  const failed = await readTask(project, "REQ-001");
  const body = { action: "resume-implementation", files: ["src/calculator.mjs"], evidence: "Owner reviewed exact replacement; original assertions remain; full regression required.",
    reviewedEdits: [{ file: "src/calculator.mjs", oldText: "// partial model change", newText: "export const multiply = (a, b) => a * b;" }] };
  const principal = { id: "reviewer", roles: ["developer"] };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", body, { id: "other", roles: ["developer"] }), /not assigned/);
  for (const invalid of [[], [{ ...body.reviewedEdits[0], file: "src/other.mjs" }],
    [{ ...body.reviewedEdits[0], oldText: "missing" }], [{ ...body.reviewedEdits[0], oldText: "\n" }],
    [{ ...body.reviewedEdits[0], newText: "line\n".repeat(51) }]]) {
    await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { ...body, reviewedEdits: invalid }, principal), /Reviewed repair/);
  }
  await executeRequirementAction(projectRoot, "REQ-001", body, principal);
  const repaired = await readTask(project, "REQ-001");
  assert.equal(repaired.meta.state, "implemented");
  assert.deepEqual(executionUsage(repaired.events), executionUsage(failed.events));
  assert.equal(repaired.events.at(-1).detail.source, "owner_reviewed_replacement");
  assert.equal(repaired.events.at(-1).detail.riskOwner, "reviewer");
  assert.equal(repaired.events.filter(event => event.type === "implementation_failed").length, 1);
  await assert.rejects(approveChanges(projectRoot, "REQ-001", "reviewer", "Premature"), /expected verified/);
  await verify(projectRoot, "REQ-001");
  assert.equal((await readTask(project, "REQ-001")).meta.state, "verified");
  await rollback(projectRoot, "REQ-001", "reviewer");
  assert.equal(await fs.readFile(path.join(repaired.meta.workspace, "src/calculator.mjs"), "utf8"),
    await fs.readFile(path.join(projectRoot, "src/calculator.mjs"), "utf8"));
});

test("verified review rework invalidates approval and retains the verified snapshot", async t => {
  const { projectRoot, project } = await analysisFixture(t);
  await plan(projectRoot, "REQ-001");
  await approvePlan(projectRoot, "REQ-001", "reviewer");
  await implement(projectRoot, "REQ-001");
  await verify(projectRoot, "REQ-001");
  await approveChanges(projectRoot, "REQ-001", "reviewer", "Initial reviewed candidate");
  const original = await readTask(project, "REQ-001");
  const body = { action: "resume-implementation", files: ["src/calculator.mjs"], evidence: "Review requests documenting the new exported operation; preserve original functions and tests.",
    reviewedEdits: [{ file: "src/calculator.mjs", oldText: "export function multiply", newText: "// Multiply two operands.\nexport function multiply" }] };
  const principal = { id: "reviewer", roles: ["developer"] };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", body, { id: "other", roles: ["developer"] }), /not assigned/);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { ...body, reviewedEdits: undefined }, principal), /explicit reviewed replacements/);
  await executeRequirementAction(projectRoot, "REQ-001", body, principal);
  const repaired = await readTask(project, "REQ-001");
  assert.equal(repaired.meta.state, "implemented");
  assert.equal(repaired.meta.changeApproval, null);
  assert.deepEqual(executionUsage(repaired.events), executionUsage(original.events));
  assert.equal(repaired.events.filter(event => event.type === "implementation_failed").length, 0);
  await assert.rejects(deployTest(projectRoot, "REQ-001", "reviewer"), /expected verified/);
  const evidence = await getRequirementEvidence(projectRoot, principal, "REQ-001");
  assert.equal(evidence.implementationAttempts[0].priorState, "verified");
  assert.equal(evidence.implementationAttempts[0].failureHash, null);
  await verify(projectRoot, "REQ-001");
  assert.equal((await deployTest(projectRoot, "REQ-001")).state, "test_deployed");
});

test("verification repair retains failed evidence and uses distinct logs through test archive", async t => {
  const { projectRoot, project } = await analysisFixture(t, [['return left * right;', 'return left + right;']]);
  await plan(projectRoot, "REQ-001");
  await approvePlan(projectRoot, "REQ-001", "reviewer");
  await implement(projectRoot, "REQ-001");
  await assert.rejects(verify(projectRoot, "REQ-001"), /failed/);
  const failed = await readTask(project, "REQ-001");
  const firstLog = await fs.readFile(path.join(failed.directory, "check-1.log"), "utf8");
  const script = await fs.readFile(project.config.piExecutable, "utf8");
  const repair = 'if (phase === "implement") { const filename = path.join(process.cwd(), "src/calculator.mjs"); await fs.writeFile(filename, (await fs.readFile(filename, "utf8")).replace("export function multiply(left, right) {\\n  return left + right;", "export function multiply(left, right) {\\n  return left * right;")); }\n';
  await fs.writeFile(project.config.piExecutable, script.replace('if (phase === "implement") {', repair + 'if (false) {'));
  await executeRequirementAction(projectRoot, "REQ-001", { action: "resume-implementation",
    files: ["src/calculator.mjs"], evidence: "Assigned developer diagnosed multiplication using addition; repair only the new multiplication expression, preserving existing add and all test assertions." },
  { id: "reviewer", roles: ["developer"] });
  await implement(projectRoot, "REQ-001");
  await verify(projectRoot, "REQ-001");
  assert.equal(await fs.readFile(path.join(failed.directory, "check-1.log"), "utf8"), firstLog);
  const repaired = await readTask(project, "REQ-001");
  assert.equal(repaired.meta.verificationAttempt, 2);
  assert.match(repaired.meta.checks[0].logFile, /verification-attempt-2-check-1.log$/);
  const evidence = await getRequirementEvidence(projectRoot, { id: "reviewer", roles: ["developer"] }, "REQ-001");
  assert.equal(evidence.implementationAttempts.length, 1);
  assert.match(await fs.readFile(path.join(evidence.implementationAttempts[0].retained, "after/src/calculator.mjs"), "utf8"), /return left \+ right/);
  await approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed exact repair and passing regression.");
  await deployTest(projectRoot, "REQ-001");
  await acceptTest(projectRoot, "REQ-001", "reviewer", "Verified multiplication and existing addition.");
  await verifyCandidate(projectRoot, "REQ-001");
  await archiveTestOnly(projectRoot, "REQ-001", "reviewer", "Test-only delivery accepted; no production release.");
  assert.equal((await readTask(project, "REQ-001")).events.filter(row => row.type === "verification_failed").length, 1);
});

test("implementation passes the exact approved files to the Pi tool guard", async (t) => {
  const { projectRoot, project } = await analysisFixture(t, [['if (phase === "implement") {',
    'if (phase === "implement") {\n  const guard = JSON.parse(process.env.REQFLOW_POLICY);\n  if (JSON.stringify(guard.approvedFiles) !== JSON.stringify(["src/calculator.mjs", "test/calculator.test.mjs"])) throw new Error("Approved file guard missing");\n  const reference = JSON.parse(prompt.match(/项目参考上下文：(.*)\\n适用代码规范/)[1]);\n  if (typeof reference.overview.text !== "string" || !Array.isArray(reference.conventions) || !reference.note.includes("Read relevant source") || Object.hasOwn(reference, "projectGuide")) throw new Error("Implementation reference must retain compact conventions and guide navigation");']]);
  await plan(projectRoot, "REQ-001"); await approvePlan(projectRoot, "REQ-001", "reviewer");
  await implement(projectRoot, "REQ-001");
  assert.equal((await readTask(project, "REQ-001")).meta.state, "implemented");
});

test("planned paths must match the exact case of the verified source index", async t => {
  const { projectRoot, project } = await analysisFixture(t, [['const text = phase ===',
    'if (phase === "plan") { analysis.affectedFiles[0] = "src/Calculator.mjs"; analysis.changes[0].file = "src/Calculator.mjs"; analysis.design.components[0].file = "src/Calculator.mjs"; }\nconst text = phase ===']]);
  await assert.rejects(plan(projectRoot, "REQ-001"), /path case does not match/);
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.state, "contract_confirmed");
  assert.equal(task.events.filter(row => row.type === "plan_draft_completed").length, 0);
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /expected plan_review/);
});

test("development waits for human plan confirmation, checks code, then the developer chooses deployment", async t => {
  const { projectRoot, project } = await analysisFixture(t);
  const body = { action: "develop", authorizeImplementation: true };
  const developer = { id: "reviewer", roles: ["developer"] };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { action: "develop" }, developer), /explicit authorization/);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", body, { id: "other", roles: ["developer"] }), /not assigned/);
  const result = await executeRequirementAction(projectRoot, "REQ-001", body, developer);
  assert.equal(result.state, "plan_review");
  assert.equal(result.next, "approve-plan");
  assert.equal((await readTask(project, "REQ-001")).meta.workspace, undefined);
  const delivered = await executeRequirementAction(projectRoot, "REQ-001", { action: "approve-plan" }, developer);
  assert.equal(delivered.state, "verified");
  assert.equal(delivered.next, "choose-validation");
  assert.equal((await readTask(project, "REQ-001")).meta.testDeployment, undefined);
  await executeRequirementAction(projectRoot, "REQ-001", { action: "deploy-test" }, developer);
  const task = await readTask(project, "REQ-001");
  const authorization = task.events.find(event => event.type === "development_authorized");
  const approval = task.events.find(event => event.type === "plan_approved");
  assert.equal(authorization.detail.actor, "reviewer");
  assert.equal(approval.detail.approvalKind, "human");
  assert.equal(approval.detail.authorizationHash, null);
  assert.equal(task.meta.changeApproval, undefined);
  assert.equal(task.events.some(event => event.type === "test_deployed"), true);
  assert.equal(task.events.some(event => event.type === "changes_approved"), false);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", body, developer), /cannot continue/);
  assert.equal((await readTask(project, "REQ-001")).events.filter(event => event.type === "implemented").length, 1);
});

test("human plan confirmation and a chosen deployment deliver the changed version to an accessible test environment", async t => {
  const preview = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-preview-"));
  t.after(() => fs.rm(preview, { recursive: true, force: true }));
  const deployed = path.join(preview, "calculator.mjs");
  await fs.copyFile(path.join(root, "examples/demo-app/src/calculator.mjs"), deployed);
  const server = createServer(async (_request, response) => {
    try {
      const module = await import(`${new URL(`file://${deployed}`).href}?${Date.now()}`);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ add: module.add(2, 3), multiply: module.multiply ? module.multiply(2, 3) : null }));
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { projectRoot, project } = await analysisFixture(t, [], { testDeployment: { kind: "local", url,
    command: [process.execPath, "-e", `require('fs').copyFileSync('src/calculator.mjs',${JSON.stringify(deployed)})`] } });
  const source = await fs.readFile(path.join(projectRoot, "src/calculator.mjs"), "utf8");
  await plan(projectRoot, "REQ-001");
  const before = await readTask(project, "REQ-001");
  await executeRequirementAction(projectRoot, "REQ-001", { action: "approve-plan", expectedPlanHash: before.meta.planHash },
    { id: "reviewer", roles: ["developer"] });
  assert.equal((await readTask(project, "REQ-001")).meta.state, "verified");
  await executeRequirementAction(projectRoot, "REQ-001", { action: "deploy-test" }, { id: "reviewer", roles: ["developer"] });
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.state, "test_deployed");
  assert.equal(task.meta.testDeployment.environment.status, "reachable");
  assert.equal(task.meta.testDeployment.url, url);
  assert.deepEqual(await (await fetch(url)).json(), { add: 5, multiply: 6 });
  assert.equal(await fs.readFile(path.join(projectRoot, "src/calculator.mjs"), "utf8"), source);
  assert.equal(task.events.some(event => event.type === "changes_approved"), false);
  await executeRequirementAction(projectRoot, "REQ-001", { action: "accept-test", evidence: "HTTP preview confirms 2×3=6 and existing addition=5." },
    { id: "product", roles: ["product"] });
  assert.equal((await readTask(project, "REQ-001")).meta.state, "archived_test_only");
});

for (const outcome of ["succeeded", "running", "failed"]) test(`custom deployment follows the approved workflow: ${outcome}`, async t => {
  const server = createServer((_request, response) => response.end("custom preview"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  let submissions = 0;
  let queries = 0;
  const kind = `workflow-${outcome}`;
  registerDeploymentAdapter(kind, { version: "1", requiresPublishedRevision: false, validateOptions() {},
    async submit({ request }) {
      submissions++;
      assert.equal(request.environment, "test");
      assert.match(request.planHash, /^[a-f0-9]{64}$/);
      return { status: outcome, operationId: "company-job", revision: request.revision, evidence: "Provider response", url };
    },
    async poll({ request }, previous) {
      queries++;
      return { status: "succeeded", operationId: previous.operationId, revision: request.revision, evidence: "Provider completed", url };
    },
  });
  const { projectRoot, project } = await analysisFixture(t, [], { testDeployment: {
    kind, adapterVersion: "1", options: {}, credentialsEnv: [], timeoutMs: 1000 } });
  const setup = await readExecutionSetup(projectRoot);
  await assert.rejects(configureExecution(projectRoot, "admin", { kind: "local", expectedConfigHash: setup.configHash,
    checksText: "node --test", deployCommand: "node deploy.js", url,
    checksEnvironment: [], deploymentEnvironment: [] }), /部署适配器/);
  await plan(projectRoot, "REQ-001");
  const before = await readTask(project, "REQ-001");
  await executeRequirementAction(projectRoot, "REQ-001", { action: "approve-plan", expectedPlanHash: before.meta.planHash },
    { id: "reviewer", roles: ["developer"] });
  assert.equal(submissions, 0);
  const submitted = await executeRequirementAction(projectRoot, "REQ-001", { action: "deploy-test" }, { id: "reviewer", roles: ["developer"] });
  if (outcome === "running") {
    assert.equal(submitted.state, "test_deployed");
    assert.ok((await readTask(project, "REQ-001")).events.some(event => event.type === "test_deploy_running"));
  }
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.state, outcome === "failed" ? "test_deploy_failed" : "test_deployed");
  assert.equal(submissions, 1); assert.equal(queries, outcome === "running" ? 1 : 0);
  assert.equal(task.meta.testDeployment.revision, task.meta.afterHash);
  assert.equal(task.meta.testDeployment.kind, kind);
  assert.equal(task.events.some(event => event.type === "changes_approved"), false);
  if (outcome !== "failed") assert.equal(task.meta.testDeployment.environment.status, "reachable");
  else assert.equal((await getTaskObservability(projectRoot, { id: "reviewer", roles: ["developer"] }, "REQ-001")).recentFailures[0].reason, "Provider response");
});

test("custom submission timeout requires reconciliation and cannot replay", async t => {
  let submissions = 0;
  registerDeploymentAdapter("workflow-unknown", { version: "1", requiresPublishedRevision: false, validateOptions() {},
    async submit({ signal }) {
      submissions++;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const { projectRoot, project } = await analysisFixture(t, [], { testDeployment: {
    kind: "workflow-unknown", adapterVersion: "1", options: {}, credentialsEnv: [], timeoutMs: 40 } });
  await plan(projectRoot, "REQ-001");
  const before = await readTask(project, "REQ-001");
  await executeRequirementAction(projectRoot, "REQ-001", { action: "approve-plan", expectedPlanHash: before.meta.planHash }, { id: "reviewer", roles: ["developer"] });
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001",
    { action: "deploy-test" }, { id: "reviewer", roles: ["developer"] }), /timed out/);
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.state, "test_deploy_outcome_unknown");
  assert.equal(task.events.at(-1).type, "test_deploy_outcome_unknown");
  await assert.rejects(deployTest(projectRoot, "REQ-001"), /expected verified/);
  assert.equal(submissions, 1);
});

for (const canCorrect of [true, false]) test(`unresolved decisions cannot trigger autonomous plan rewriting: ${canCorrect}`, async t => {
  const finding = '{ severity: "blocking", subject: "Plan contradicts frozen requirement", evidence: "Wrong function name", recommendation: "Use multiply as required" }';
  const { projectRoot, project } = await analysisFixture(t, [
    ['interfaces: { status: "none"', 'interfaces: { status: "changed"'],
    ['findings: [] };', `findings: prompt.includes("corrected-plan") ? [] : [${finding}] };`],
    ['"独立增加 multiply，保留 add 实现。"', `${canCorrect} && prompt.includes("Resolve these specialist findings") ? "corrected-plan: multiply preserves add" : "Wrong function name"`],
  ]);
  const body = { action: "develop", authorizeImplementation: true };
  const principal = { id: "reviewer", roles: ["developer"] };
  const result = await executeRequirementAction(projectRoot, "REQ-001", body, principal);
  assert.equal(result.next, "resolve-blockers");
  const task = await readTask(project, "REQ-001");
  const revisions = task.events.filter(event => event.type === "plan_revision_requested");
  assert.equal(revisions.length, 0);
  assert.equal(task.meta.planVersion, 1);
  if (!canCorrect) {
    assert.equal(task.meta.workspace, undefined);
    await executeRequirementAction(projectRoot, "REQ-001", body, principal);
    assert.equal((await readTask(project, "REQ-001")).events.filter(event => event.type === "plan_revision_requested").length, 0);
  }
});

test("delegated development hands complex design back without approving or writing code", async t => {
  const { projectRoot, project } = await analysisFixture(t, [["designStages: 1", "designStages: 2"]]);
  const result = await executeRequirementAction(projectRoot, "REQ-001", { action: "develop", authorizeImplementation: true },
    { id: "reviewer", roles: ["developer"] });
  assert.equal(result.next, "human-led-design");
  assert.match(result.reasons.join("\n"), /分阶段设计/);
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.workspace, undefined);
  assert.equal(task.events.some(event => event.type === "plan_approved" || event.type === "workspace_prepared"), false);
});

test("out-of-scope plans remain blocked after feedback and bounded reanalysis", async (t) => {
  const { projectRoot, project } = await analysisFixture(t, [['externalEffects: { status: "none"', 'externalEffects: { status: "irreversible"'],
    ['domains: ["backend"]', 'domains: ["frontend", "backend"]']]);
  await plan(projectRoot, "REQ-001");
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.admission.status, "out_of_scope");
  assert.equal((await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001")).summary.attempts, 1);
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /unresolved blockers/);
  await revisePlan(projectRoot, "REQ-001", "reviewer", "Proceed anyway");
  const revised = await readTask(project, "REQ-001");
  assert.equal(revised.meta.admission.status, "out_of_scope");
  assert.equal(revised.meta.planAttempts, 2);
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /unresolved blockers/);
  await assert.rejects(implement(projectRoot, "REQ-001"), /expected approved/);
  assert.equal(task.meta.workspace, undefined);
});

test("multi-stage design is handed to the developer before implementation", async t => {
  const { projectRoot, project } = await analysisFixture(t, [["designStages: 1", "designStages: 2"],
    ['domains: ["backend"]', 'domains: ["frontend", "backend"]']]);
  await plan(projectRoot, "REQ-001");
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.admission.eligible, false);
  assert.match(task.meta.admission.reasons.join("\n"), /分阶段设计/);
  assert.equal(task.events.some(event => event.type === "plan_specialist_completed"), false);
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /unresolved blockers/);
  await assert.rejects(implement(projectRoot, "REQ-001"), /expected approved/);
  assert.equal(task.meta.workspace, undefined);
});

test("responsible feedback can correct a mistaken boundary without overriding approval", async t => {
  const { projectRoot, project } = await analysisFixture(t,
    [['externalEffects: { status: "none"', 'externalEffects: { status: prompt.includes("Correct source evidence") ? "none" : "irreversible"']]);
  await plan(projectRoot, "REQ-001");
  assert.equal((await readTask(project, "REQ-001")).meta.admission.eligible, false);
  await revisePlan(projectRoot, "REQ-001", "reviewer", "Correct source evidence: isolated pure function has no external effects");
  const corrected = await readTask(project, "REQ-001");
  assert.equal(corrected.meta.admission.eligible, true);
  assert.equal(corrected.meta.planAttempts, 2);
  assert.equal(corrected.events.filter(row => row.type === "plan_draft_completed").length, 2);
  assert.equal(corrected.meta.workspace, undefined);
  await assert.rejects(implement(projectRoot, "REQ-001"), /expected approved/);
});

test("size estimates flag review without blocking valid changes or file rollback", async (t) => {
  const { projectRoot, project } = await analysisFixture(t, [], { admission: { ...admissionDefaults, maxChangedBytes: 1, restrictedPaths: [] } });
  await plan(projectRoot, "REQ-001"); await approvePlan(projectRoot, "REQ-001", "reviewer");
  await implement(projectRoot, "REQ-001");
  const delivered = await readTask(project, "REQ-001");
  assert.equal(delivered.meta.state, "implemented");
  assert.match(delivered.events.findLast(event => event.type === "implemented").detail.warnings[0], /size estimate/);
  assert.ok((await getRequirementEvidence(projectRoot, { id: "reviewer", roles: ["developer"] }, "REQ-001")).changes.changes.length);
  await rollback(projectRoot, "REQ-001", "reviewer");
  assert.equal((await readTask(project, "REQ-001")).meta.state, "rolled_back");
});

test("approved reversible data features resume code repair with an owner-selected configured model", async t => {
  const selected = { provider: "fake", model: "alternative", thinking: "off" };
  const stop = 'if (phase === "implement") { console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",usage:{input:50,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}}})); process.exit(1); }\n';
  const { projectRoot, project } = await analysisFixture(t, [
    ['if (phase === "implement") {', `if (phase === "implement") {
  if (prompt.startsWith("Apply the owner's diagnosed local repair")) {
    const frozen = JSON.parse(prompt.match(/^Frozen requirement: (.*)$/m)[1]);
    const changes = JSON.parse(prompt.match(/^Approved changes: (.*)$/m)[1]);
    const impacts = JSON.parse(prompt.match(/^Approved impact and recovery: (.*)$/m)[1]);
    if (!frozen.acceptance.length || changes.length !== 2 || impacts.impacts.data.status !== "changed"
      || impacts.recovery.status !== "documented" || impacts.externalEffects.status !== "reversible") {
      throw new Error("Resumed implementation lost the approved contract, changes or recovery");
    }
  }`],
    ['const refineAddition =', stop + 'const refineAddition ='],
    ['data: { status: "none"', 'data: { status: "changed"'],
    ['recovery: { status: "code_only"', 'recovery: { status: "documented"'],
    ['externalEffects: { status: "none"', 'externalEffects: { status: "reversible"'],
  ], { modelFallbacks: [selected] });
  await plan(projectRoot, "REQ-001");
  await approvePlan(projectRoot, "REQ-001", "reviewer");
  await assert.rejects(implement(projectRoot, "REQ-001"));
  const body = { action: "resume-implementation", files: ["src/calculator.mjs", "test/calculator.test.mjs"],
    evidence: "Owner verified isolated code repair and the original documented data recovery", modelSelection: selected };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", body, { id: "other", roles: ["developer"] }), /not assigned/);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { ...body, modelSelection: { ...selected, model: "unconfigured" } },
    { id: "reviewer", roles: ["developer"] }), /configured candidate/);
  await fs.writeFile(project.config.piExecutable, (await fs.readFile(project.config.piExecutable, "utf8")).replace(stop, ""));
  await executeRequirementAction(projectRoot, "REQ-001", body, { id: "reviewer", roles: ["developer"] });
  await implement(projectRoot, "REQ-001");
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.state, "implemented");
  assert.equal(task.events.findLast(row => row.type === "implemented").detail.telemetry.model, "alternative");
  assert.equal(task.events.findLast(row => row.type === "implemented").detail.telemetry.selectionSource, "owner");
  assert.deepEqual(task.events.findLast(row => row.type === "implementation_resumed").detail.modelSelection, selected);
  assert.equal(task.events.filter(row => row.type === "implementation_failed").length, 1);
});

test("model calls and plan attempts accumulate across revision and prevent further implementation", async (t) => {
  const { projectRoot, project } = await analysisFixture(t, [], { admission: { ...admissionDefaults, budgetMode: "strict", maxModelCalls: 6, maxPlanAttempts: 2, restrictedPaths: [] } });
  await plan(projectRoot, "REQ-001");
  await revisePlan(projectRoot, "REQ-001", "reviewer", "Clarify boundary assertions");
  const revised = await readTask(project, "REQ-001");
  assert.equal(revised.meta.planAttempts, 2);
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /budget exhausted/);
  await assert.rejects(revisePlan(projectRoot, "REQ-001", "reviewer", "Another adjustment"), /revision limit/);
  const stopped = await readTask(project, "REQ-001");
  assert.equal(stopped.events.at(-1).type, "execution_boundary_stopped");
  assert.equal((await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001")).execution.calls, 6);
  assert.equal(stopped.meta.workspace, undefined);
});

test("adaptive human refinement retains cumulative usage without treating the attempt estimate as complexity", async t => {
  const { projectRoot, project } = await analysisFixture(t, [], { admission: {
    ...admissionDefaults, budgetMode: "adaptive", maxPlanAttempts: 1, restrictedPaths: [] } });
  await plan(projectRoot, "REQ-001");
  const before = await readTask(project, "REQ-001");
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { action: "revise-plan",
    feedback: "Outdated recommendation", expectedPlanHash: "0".repeat(64) }, { id: "reviewer", roles: ["developer"] }), /plan has changed/);
  await revisePlan(projectRoot, "REQ-001", "reviewer", "Keep the confirmed requirement and simplify the design.");
  const after = await readTask(project, "REQ-001");
  assert.equal(after.meta.planAttempts, 2);
  assert.equal(after.meta.planVersion, 2);
  assert.equal(after.meta.contractHash, before.meta.contractHash);
  assert.ok(after.meta.reviewCostUsd > before.meta.reviewCostUsd);
  assert.equal(after.meta.workspace, undefined);
  assert.equal(after.meta.state, "plan_review");
});

test("failed plan updates keep discussion available and retry the saved feedback without another submission", async t => {
  const { projectRoot, project } = await analysisFixture(t, [], { admission: {
    ...admissionDefaults, budgetMode: "adaptive", maxPlanAttempts: 1, restrictedPaths: [] } });
  const principal = { id: "reviewer", roles: ["developer"] };
  await plan(projectRoot, "REQ-001");
  const before = await readTask(project, "REQ-001");
  const executable = project.config.piExecutable;
  const source = await fs.readFile(executable, "utf8");
  await fs.writeFile(executable, source.replace('process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}',
    'if (phase === "plan") { console.error("fixture plan timeout"); process.exit(1); }\nprocess.stdout.write(`${JSON.stringify({ type: "agent_settled" })}'));
  const retry = { action: "revise-plan", retry: true, expectedPlanHash: before.meta.planHash };
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", retry, principal), /No saved plan update/);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { action: "revise-plan",
    feedback: "Keep the original addition and clarify the multiplication logic", expectedPlanHash: before.meta.planHash }, principal), /fixture plan timeout/);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", retry, principal), /fixture plan timeout/);
  const failed = await readTask(project, "REQ-001");
  assert.equal(failed.meta.state, "contract_confirmed");
  assert.equal(failed.meta.planHash, before.meta.planHash);
  assert.equal(failed.meta.planFeedbackVersion, before.meta.planVersion);
  assert.equal(failed.events.filter(row => row.type === "plan_revision_requested").length, 1);
  assert.equal(failed.events.filter(row => row.type === "plan_attempt_failed").length, 2);
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /expected plan_review/);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", retry, { id: "product", roles: ["product"] }), /Role cannot perform/);
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { ...retry, expectedPlanHash: "0".repeat(64) }, principal), /plan has changed/);
  await executeRequirementAction(projectRoot, "REQ-001", { action: "discuss-plan", message: {
    text: "重试时继续保留原加法", expectedPlanHash: before.meta.planHash } }, principal);
  const evidence = await getRequirementEvidence(projectRoot, principal, "REQ-001");
  assert.ok(evidence.planDiscussion.messages.some(row => row.type === "plan_attempt_failed"));
  assert.ok(evidence.planDiscussion.messages.some(row => row.type === "plan_reply"));
  assert.ok(evidence.plan);
  await fs.writeFile(executable, source);
  await executeRequirementAction(projectRoot, "REQ-001", retry, principal);
  const completed = await readTask(project, "REQ-001");
  assert.equal(completed.meta.state, "plan_review");
  assert.equal(completed.meta.planVersion, 2);
  assert.equal(completed.meta.planFeedbackVersion, null);
  assert.equal(completed.events.filter(row => row.type === "plan_revision_requested").length, 1);
  assert.equal(completed.meta.workspace, undefined);
  assert.equal(completed.events.some(row => row.type === "plan_approved"), false);
});

test("new edits after a failed update archive distinct feedback and retry the latest proposal", async t => {
  const { projectRoot, project } = await analysisFixture(t);
  const principal = { id: "reviewer", roles: ["developer"] };
  await plan(projectRoot, "REQ-001");
  const before = await getRequirementEvidence(projectRoot, principal, "REQ-001");
  const executable = project.config.piExecutable;
  const source = await fs.readFile(executable, "utf8");
  await fs.writeFile(executable, source.replace('process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}',
    'if (phase === "plan") { console.error("fixture plan timeout"); process.exit(1); }\nprocess.stdout.write(`${JSON.stringify({ type: "agent_settled" })}'));
  await assert.rejects(revisePlan(projectRoot, "REQ-001", "reviewer", "Initial clarification"), /fixture plan timeout/);
  const first = (await readTask(project, "REQ-001")).events.findLast(row => row.type === "plan_revision_requested");
  const candidate = structuredClone(before.planAnalysis.draft); delete candidate.markdown;
  candidate.changes[0].description = "明确新增乘法逻辑并保留原加法";
  await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", { action: "edit-plan", candidate,
    feedback: "Updated proposal after failure", expectedPlanHash: before.meta.planHash }, principal), /fixture plan timeout/);
  const second = (await readTask(project, "REQ-001")).events.findLast(row => row.type === "plan_revision_requested");
  assert.notEqual(second.detail.feedbackFile, first.detail.feedbackFile);
  assert.equal(await fs.readFile(first.detail.feedbackFile, "utf8"), "Initial clarification");
  assert.match(await fs.readFile(second.detail.feedbackFile, "utf8"), /Updated proposal after failure/);
  await fs.writeFile(executable, source);
  await executeRequirementAction(projectRoot, "REQ-001", { action: "revise-plan", retry: true,
    expectedPlanHash: before.meta.planHash }, principal);
  const after = await getRequirementEvidence(projectRoot, principal, "REQ-001");
  assert.equal(after.meta.planVersion, 2);
  assert.equal(second.detail.candidate.changes[0].description, candidate.changes[0].description);
  assert.equal(after.planAnalysis.draft.candidateReview.proposalHash, sha256(JSON.stringify(second.detail.candidate)));
  assert.equal(after.meta.workspace, undefined);
});

test("specialist failures preserve charged cost and do not double-count the plan wrapper", async (t) => {
  const { projectRoot, project } = await analysisFixture(t, [
    ['domains: ["backend"]', 'domains: ["frontend", "backend"]'],
    ['findings: [] };', 'findings: role === "backend" ? "invalid-findings" : [] };'],
    ['phase === "intake" ? 0.03 : 0', 'phase === "intake" ? 0.03 : phase === "plan" ? 0.02 : 0'],
  ]);
  await assert.rejects(plan(projectRoot, "REQ-001"), /plan_specialist.*findings/);
  const failed = await readTask(project, "REQ-001");
  assert.equal(failed.meta.state, "contract_confirmed");
  assert.equal(failed.meta.planCostUsd, 0.02);
  assert.equal(failed.meta.reviewCostUsd, 0.14);
  assert.equal(failed.events.at(-1).detail.modelRun, false);
  const report = await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001");
  assert.equal(report.summary.attempts, 3);
  assert.equal(report.summary.failedAttempts, 1);
  assert.ok(Math.abs(report.summary.costUsd - 0.16) < 1e-10);
  await assert.rejects(plan(projectRoot, "REQ-001"), /plan_specialist.*findings/);
  const retried = await readTask(project, "REQ-001");
  assert.equal(retried.meta.planAttempts, 2);
  assert.equal(retried.meta.planCostUsd, 0.02);
  assert.ok(Math.abs(retried.meta.reviewCostUsd - 0.21) < 1e-10);
  assert.equal(retried.events.filter(event => event.type === "plan_draft_completed").length, 1);
  assert.equal(retried.events.filter(event => event.type === "plan_specialist_reused" && event.detail.role === "frontend").length, 1);
});

test("a revised frozen requirement invalidates its plan and creates a fresh version", async (t) => {
  const { projectRoot, project } = await analysisFixture(t);
  await plan(projectRoot, "REQ-001");
  const first = await readTask(project, "REQ-001");
  const contract = JSON.parse(await fs.readFile(path.join(first.directory, "contract-v1.json"), "utf8"));
  await reviseContract(projectRoot, "REQ-001", "product", { ...contract, objective: "Multiplication with clear boundaries" });
  const evidence = await getRequirementEvidence(projectRoot, { id: "reviewer", roles: ["developer"] }, "REQ-001");
  assert.equal(evidence.plan, null);
  assert.equal(evidence.planAnalysis, null);
  assert.equal(evidence.baselineChecks, null);
  await assert.rejects(approvePlan(projectRoot, "REQ-001", "reviewer"), /expected plan_review/);
  await plan(projectRoot, "REQ-001");
  const next = await readTask(project, "REQ-001");
  assert.equal(next.meta.planVersion, 2);
  assert.notEqual(next.meta.contractHash, first.meta.contractHash);
  assert.equal(JSON.parse(await fs.readFile(path.join(next.directory, "plan-analysis-v1.json"), "utf8")).contractHash, first.meta.contractHash);
  assert.equal((await approvePlan(projectRoot, "REQ-001", "reviewer")).state, "approved");
});

test("specialist budget exhaustion stops before the next model invocation", async (t) => {
  const { projectRoot, project } = await analysisFixture(t,
    [['domains: ["backend"]', 'domains: ["frontend", "backend"]']], { maxCostUsd: 0.07 });
  await assert.rejects(plan(projectRoot, "REQ-001"), /cost budget exhausted before specialist/);
  const task = await readTask(project, "REQ-001");
  assert.equal(task.meta.reviewCostUsd, 0.07);
  assert.equal(task.meta.state, "contract_confirmed");
  assert.equal(task.events.filter((event) => event.type === "plan_specialist_completed").length, 1);
  assert.equal(task.events.findLast((event) => event.type === "pi_budget_exhausted").detail.role, "backend");
  const observed = await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001");
  assert.equal(observed.summary.attempts, 2);
  assert.equal(observed.summary.skippedCalls, 1);
  await assert.rejects(plan(projectRoot, "REQ-001"), /cost budget exhausted before planning/);
  assert.equal((await readTask(project, "REQ-001")).meta.workspace, undefined);
});

test("partial plan archives do not overwrite evidence or prevent a fresh analysis attempt", async (t) => {
  const { projectRoot, project } = await analysisFixture(t);
  const { directory } = await readTask(project, "REQ-001");
  await fs.writeFile(path.join(directory, "plan-v1.md"), "Existing incomplete archive", { flag: "wx" });
  await assert.rejects(plan(projectRoot, "REQ-001"), /EEXIST/);
  const failed = await readTask(project, "REQ-001");
  assert.equal(failed.meta.planVersion, 1);
  assert.equal(failed.meta.planHash, null);
  assert.equal((await getRequirementEvidence(projectRoot, { id: "reviewer", roles: ["developer"] }, "REQ-001")).plan, null);
  await plan(projectRoot, "REQ-001");
  assert.equal((await readTask(project, "REQ-001")).meta.planVersion, 2);
  assert.equal(await fs.readFile(path.join(directory, "plan-v1.md"), "utf8"), "Existing incomplete archive");
  assert.equal((await approvePlan(projectRoot, "REQ-001", "reviewer")).state, "approved");
});

test("design and implementation use separate models and model changes preserve the approved plan", async () => {
  const agentModels = { plan: { provider: "design-provider", model: "design-large" },
    implement: { provider: "coding-provider", model: "coding-small" } };
  const { temporary, projectRoot, project } = await fixture(false, fakePi,
    "Add multiply(left, right) and keep add working.", { agentModels });
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    const policy = path.join(project.archive, "config.json");
    await fs.writeFile(policy, JSON.stringify({ ...project.config, agentModels: {
      ...agentModels, implement: { provider: "coding-provider", model: "changed-model" } } }));
    await implement(projectRoot, "REQ-001");
    const observed = await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001");
    assert.deepEqual(observed.runs.map((run) => run.telemetry.model), ["design-large", "fake-model", "changed-model"]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("admin model settings preserve dialogue, plan approval, tested changes and deployment", async t => {
  const { temporary, projectRoot, project } = await fixture();
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await plan(projectRoot, "REQ-001");
  const original = await readTask(project, "REQ-001");
  const baseline = await readProjectBaseline(project);
  const setup = await readModelSettings(projectRoot);
  const profile = { ...setup.default, provider: "Fixture", model: "dialogue-model", baseUrl: "https://models.example/v1",
    apiKey: "fixture-model-key", supportsJsonSchema: true, modelParameters: { outputFormat: "auto", temperature: 0.2 } };
  delete profile.credentialConfigured;
  const input = { expectedConfigHash: setup.expectedConfigHash, default: profile,
    agents: Object.fromEntries(Object.keys(setup.agents).map(agent => [agent, null])), maxCostUsd: setup.maxCostUsd };
  let configured = await configureModels(projectRoot, "admin", input);
  assert.equal((await readProjectBaseline(await loadProject(projectRoot))).snapshotHash, baseline.snapshotHash);
  const configFile = path.join(project.archive, "config.json"); const savedConfig = await fs.readFile(configFile, "utf8");
  await fs.writeFile(configFile, JSON.stringify({ ...JSON.parse(savedConfig), allowedPaths: ["src"] }));
  await assert.rejects(discussPlan(projectRoot, "REQ-001", "reviewer", { text: "继续核对。", expectedPlanHash: original.meta.planHash }), /执行规则已变化/);
  await fs.writeFile(configFile, savedConfig);
  const sourceFile = path.join(projectRoot, "src/calculator.mjs"); const savedSource = await fs.readFile(sourceFile);
  await fs.appendFile(sourceFile, "\n// Concurrent source change\n");
  await assert.rejects(discussPlan(projectRoot, "REQ-001", "reviewer", { text: "继续核对。", expectedPlanHash: original.meta.planHash }), /源码已变化/);
  await fs.writeFile(sourceFile, savedSource);
  await discussPlan(projectRoot, "REQ-001", "reviewer", { text: "保持现有方案，不增加业务范围。", expectedPlanHash: original.meta.planHash });
  const discussed = await readTask(project, "REQ-001");
  assert.equal(discussed.meta.planHash, original.meta.planHash);
  assert.equal(discussed.meta.planVersion, original.meta.planVersion);
  await approvePlan(projectRoot, "REQ-001", "reviewer");
  const approved = await readTask(project, "REQ-001");
  input.expectedConfigHash = configured.expectedConfigHash;
  input.default = { ...profile, model: "implementation-model", apiKey: "", maxPiMs: profile.maxPiMs + 1000 };
  configured = await configureModels(projectRoot, "admin", input);
  assert.equal((await readTask(project, "REQ-001")).meta.planApprovedAt, approved.meta.planApprovedAt);
  assert.equal((await readTask(project, "REQ-001")).meta.planCostUsd, approved.meta.planCostUsd);
  await implement(projectRoot, "REQ-001");
  await verify(projectRoot, "REQ-001");
  await approveChanges(projectRoot, "REQ-001", "reviewer", "已核对实现与回归验证。");
  const changes = await readTask(project, "REQ-001");
  input.expectedConfigHash = configured.expectedConfigHash;
  input.default.model = "next-model";
  await configureModels(projectRoot, "admin", input);
  assert.equal((await readTask(project, "REQ-001")).meta.afterHash, changes.meta.afterHash);
  assert.equal((await deployTest(projectRoot, "REQ-001")).state, "test_deployed");
  assert.equal((await readTask(project, "REQ-001")).events.filter(event => event.type === "plan_created").length, 1);
});

test("rollback rejects altered archives before restoring any code", async () => {
  const { temporary, projectRoot, project } = await fixture();
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    const { meta, directory } = await readTask(project, "REQ-001");
    const workspaceFile = path.join(meta.workspace, "src/calculator.mjs");
    const implemented = await fs.readFile(workspaceFile, "utf8");
    const reportFile = path.join(directory, "changes.json");
    const report = await fs.readFile(reportFile, "utf8");
    await fs.writeFile(reportFile, JSON.stringify({ changes: [], violations: [] }));
    await assert.rejects(rollback(projectRoot, "REQ-001", "developer"), /differ from the audited/);
    await fs.writeFile(reportFile, report);
    await fs.writeFile(path.join(directory, "baseline", "src/calculator.mjs"), "corrupted backup");
    await assert.rejects(rollback(projectRoot, "REQ-001", "developer"), /baseline snapshot changed/);
    assert.equal(await fs.readFile(workspaceFile, "utf8"), implemented);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("interrupted implementation evidence remains readable", async () => {
  const { temporary, projectRoot, project } = await fixture();
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    const { meta, directory } = await readTask(project, "REQ-001");
    const report = JSON.parse(await fs.readFile(path.join(directory, "changes.json"), "utf8"));
    await appendEvent(project, "REQ-001", "implementation_interrupted", { ...meta, state: "implementation_interrupted" }, report);
    const principal = { id: "reviewer", roles: ["developer"] };
    assert.deepEqual((await getRequirementEvidence(projectRoot, principal, "REQ-001")).changes.changes, report.changes);
    assert.match((await getChangedFile(projectRoot, principal, "REQ-001", "src/calculator.mjs")).after.text, /multiply/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("coding standards version stays bound through plan and changed-code approval", async () => {
  const rules = { globalRules: [{ id: "TEAM-ERROR-1", level: "review",
    text: "Preserve existing error contracts and report failures explicitly" }] };
  const { temporary, projectRoot, project } = await fixture(false, fakePi,
    "Add multiply(left, right) and keep add working.", { codingStandards: rules });
  try {
    await plan(projectRoot, "REQ-001");
    const planned = await readTask(project, "REQ-001");
    const expected = resolveStandards(project.config, ["src/calculator.mjs", "test/calculator.test.mjs"]).hash;
    assert.equal(planned.meta.standardsHash, expected);
    assert.equal(planned.events.findLast((event) => event.type === "plan_created").detail.standardsHash, expected);
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    await verify(projectRoot, "REQ-001");
    const reviewed = await approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed error and regression behavior.");
    assert.equal(reviewed.changeApproval.standardsHash, expected);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("changing a team coding rule invalidates the pending plan", async () => {
  const { temporary, projectRoot, project } = await fixture(false, fakePi,
    "Add multiply(left, right) and keep add working.", { codingStandards: { globalRules: [{
      id: "TEAM-ERROR-1", level: "review", text: "Keep errors visible" }] } });
  try {
    await plan(projectRoot, "REQ-001");
    const configFile = path.join(project.archive, "config.json");
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    config.codingStandards.globalRules[0].text = "Report every failure to callers";
    await fs.writeFile(configFile, JSON.stringify(config));
    await assert.rejects(approvePlan(projectRoot, "REQ-001", "developer"),
      /Coding standards changed after planning/);
    assert.equal((await readTask(project, "REQ-001")).meta.state, "plan_review");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("Docker sandbox configuration reaches every project check phase", async (t) => {
  let image;
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000, stdio: "ignore" });
    image = execFileSync("docker", ["image", "inspect", "node:20-alpine", "--format", "{{.Id}}"],
      { timeout: 5000, encoding: "utf8" }).trim();
  } catch (error) {
    t.skip(`Docker integration fixture is unavailable: ${error.message}`);
    return;
  }
  const { temporary, projectRoot, project } = await fixture(false, fakePi,
    "Add multiply(left, right) and keep add working.", {
      checks: [["node", "--test", "test/calculator.test.mjs"]],
      checkSandbox: { kind: "docker", image, memoryMb: 256, pidsLimit: 64 },
    });
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    const verified = await verify(projectRoot, "REQ-001");
    assert.deepEqual(verified.checks.map((check) => check.sandboxImage), [image]);
    await approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed the changed files and regression tests.");
    await deployTest(projectRoot, "REQ-001");
    await acceptTest(projectRoot, "REQ-001", "developer", "Confirmed multiplication and addition.");
    const candidate = await verifyCandidate(projectRoot, "REQ-001");
    assert.deepEqual(candidate.mergeChecks.map((check) => check.sandboxImage), [image]);
    const events = (await readTask(project, "REQ-001")).events;
    assert.deepEqual(events.find((event) => event.type === "plan_created").detail.baselineChecks
      .map((check) => check.sandboxImage), [image]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("approved plan gates implementation, verification, acceptance and rollback", async () => {
  const { temporary, projectRoot, project } = await fixture();
  try {
    await assert.rejects(implement(projectRoot, "REQ-001"), /expected approved/);
    const planned = await plan(projectRoot, "REQ-001");
    assert.equal(planned.state, "plan_review");
    await assert.rejects(approvePlan(projectRoot, "REQ-001", "policy:fast-path"), /Plan approval requires the assigned developer/);
    const planningRun = (await getTaskObservability(projectRoot,
      { id: "product", roles: ["product"] }, "REQ-001")).runs.find(run => run.telemetry.phase === "plan").telemetry;
    assert.equal(planningRun.assistantMessages, 2);
    assert.equal(planningRun.tokens.input, 140);
    assert.equal(planningRun.tokens.output, 50);
    assert.ok(planningRun.promptBytes > 0);
    const baselineLog = path.join(project.archive, "tasks", "REQ-001", "baseline-v1-attempt-1-check-1.log");
    const baselineEvidence = await fs.readFile(baselineLog);
    await fs.appendFile(baselineLog, "altered baseline result");
    await assert.rejects(approvePlan(projectRoot, "REQ-001", "developer"), /Changed baseline.*check log/);
    await fs.writeFile(baselineLog, baselineEvidence);
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    const implemented = await implement(projectRoot, "REQ-001");
    assert.equal(implemented.changeCount, 2);
    const verified = await verify(projectRoot, "REQ-001");
    assert.equal(verified.state, "verified");
    const checkLog = path.join(project.archive, "tasks", "REQ-001", "check-1.log");
    const checkEvidence = await fs.readFile(checkLog);
    await fs.appendFile(checkLog, "altered verification result");
    await assert.rejects(approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed."), /Changed.*check log/);
    await fs.writeFile(checkLog, checkEvidence);
    await assert.rejects(approveChanges(projectRoot, "REQ-001", "product", "I approve."), /Change approval requires the assigned developer/);
    const changesFile = path.join(project.archive, "tasks", "REQ-001", "changes.json");
    const archivedChanges = await fs.readFile(changesFile, "utf8");
    const alteredChanges = JSON.parse(archivedChanges);
    alteredChanges.changes.pop();
    await fs.writeFile(changesFile, JSON.stringify(alteredChanges));
    await assert.rejects(approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed."), /Archived changes differ/);
    await fs.writeFile(changesFile, archivedChanges);
    const afterFile = path.join(project.archive, "tasks", "REQ-001", "after", "src", "calculator.mjs");
    const archivedAfter = await fs.readFile(afterFile);
    await fs.appendFile(afterFile, "\n// archived tampering\n");
    await assert.rejects(approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed."), /snapshot changed/);
    await fs.writeFile(afterFile, archivedAfter);
    await approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed changed behavior and existing addition regression.");
    await fs.appendFile(checkLog, "altered after approval");
    await assert.rejects(deployTest(projectRoot, "REQ-001"), /Changed.*check log/);
    await fs.writeFile(checkLog, checkEvidence);
    const changedFile = path.join(implemented.workspace, "src", "calculator.mjs");
    const approvedSource = await fs.readFile(changedFile, "utf8");
    await fs.appendFile(changedFile, "\n// unreviewed change\n");
    await assert.rejects(deployTest(projectRoot, "REQ-001"), /Workspace changed after verification/);
    await fs.writeFile(changedFile, approvedSource);
    const deployed = await deployTest(projectRoot, "REQ-001");
    assert.equal(deployed.state, "test_deployed");
    const accepted = await acceptTest(projectRoot, "REQ-001", "developer", "2 × 3 = 6; 2 + 3 = 5.");
    assert.equal(accepted.state, "test_accepted");
    const original = await fs.readFile(path.join(implemented.workspace, "src", "calculator.mjs"), "utf8");
    assert.match(original, /multiply/);
    const restored = await rollback(projectRoot, "REQ-001", "developer");
    assert.equal(restored.state, "rolled_back");
    assert.doesNotMatch(await fs.readFile(path.join(implemented.workspace, "src", "calculator.mjs"), "utf8"), /multiply/);
    assert.equal((await readTask(project, "REQ-001")).meta.state, "rolled_back");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("approved baseline drift blocks implementation", async () => {
  const { temporary, projectRoot } = await fixture();
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await fs.appendFile(path.join(projectRoot, "src", "calculator.mjs"), "\n// concurrent change\n");
    await assert.rejects(implement(projectRoot, "REQ-001"), /Project source changed since baseline initialization/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("legacy policy approval cannot start implementation", async () => {
  const { temporary, projectRoot, project } = await fixture();
  try {
    await plan(projectRoot, "REQ-001");
    const { meta } = await readTask(project, "REQ-001");
    await appendEvent(project, "REQ-001", "legacy_policy_approval", {
      ...meta, state: "approved", planApprovedBy: "policy:fast-path",
    }, { actor: "policy:fast-path" });
    await assert.rejects(implement(projectRoot, "REQ-001"), /Implementation requires the assigned developer's plan approval/);
    assert.equal((await readTask(project, "REQ-001")).meta.state, "approved");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("editing an approved plan blocks Pi before it changes code", async () => {
  const { temporary, projectRoot, project } = await fixture();
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    const planFile = path.join(project.archive, "tasks", "REQ-001", "plan-v1.md");
    await fs.appendFile(planFile, "\nChange the implementation scope.\n");
    await assert.rejects(implement(projectRoot, "REQ-001"), /Approved plan changed before implementation/);
    assert.equal((await readTask(project, "REQ-001")).meta.workspace, undefined);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("baseline failures are diagnostic evidence and cannot pass final verification", async () => {
  const { temporary, projectRoot, project } = await fixture(false, fakePi,
    "Add multiply(left, right) and keep add working.",
    { checks: [[process.execPath, "-e", "process.exit(17)"]] });
  try {
    await plan(projectRoot, "REQ-001");
    const planned = await readTask(project, "REQ-001");
    assert.equal(planned.events.find(event => event.type === "plan_created").detail.baselineChecks[0].code, 17);
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    await assert.rejects(verify(projectRoot, "REQ-001"), /Check failed/);
    assert.equal((await readTask(project, "REQ-001")).meta.state, "verification_failed");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("a task can fix the regression already failing in its original baseline", async t => {
  const { projectRoot, project } = await analysisFixture(t, [], {
    checks: [[process.execPath, "--input-type=module", "-e",
      'import { multiply } from "./src/calculator.mjs"; if (multiply(2, 3) !== 6) throw new Error("Regression: multiplication");']],
  });
  const result = await executeRequirementAction(projectRoot, "REQ-001", { action: "develop", authorizeImplementation: true },
    { id: "reviewer", roles: ["developer"] });
  assert.equal(result.state, "plan_review");
  const delivered = await executeRequirementAction(projectRoot, "REQ-001", { action: "approve-plan" },
    { id: "reviewer", roles: ["developer"] });
  assert.equal(delivered.state, "verified");
  assert.equal(delivered.next, "choose-validation");
  const task = await readTask(project, "REQ-001");
  assert.notEqual(task.events.find(event => event.type === "plan_created").detail.baselineChecks[0].code, 0);
  assert.equal(task.meta.checks[0].code, 0);
});

test("planning keeps long original intake outside the model prompt", async (t) => {
  const request = `Add multiplication.\n${"Archived background. ".repeat(3000)}`;
  const modelDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-intake-guard-"));
  t.after(() => fs.rm(modelDirectory, { recursive: true, force: true }));
  const guardedPi = path.join(modelDirectory, "pi.mjs");
  const source = (await fs.readFile(fakePi, "utf8")).replace("const prompt = process.argv.at(-1);",
    'const prompt = process.argv.at(-1);\nif (phase === "plan" && prompt.includes("Archived background.")) throw new Error("Original intake leaked into planning");');
  await fs.writeFile(guardedPi, source);
  const { temporary, projectRoot, project } = await fixture(false, guardedPi, request);
  try {
    await plan(projectRoot, "REQ-001");
    const observed = await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001");
    const planningRun = observed.runs.find((run) => run.telemetry.phase === "plan");
    assert.ok(planningRun);
    assert.ok(planningRun.telemetry.promptBytes < Buffer.byteLength(request));
    assert.equal(await fs.readFile(path.join(project.archive, "tasks", "REQ-001", "request.md"), "utf8"), request);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("partial implementation failure remains inspectable and reversible", async () => {
  const { temporary, projectRoot, project } = await fixture(false, fakePiPartialFailure);
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await assert.rejects(implement(projectRoot, "REQ-001"), /simulated model failure/);
    const failed = (await readTask(project, "REQ-001")).meta;
    assert.equal(failed.state, "implementation_failed");
    assert.equal(failed.changeCount, 1);
    assert.equal(failed.implementationCostUsd, 0.03);
    const observed = await getTaskObservability(projectRoot, { id: "product", roles: ["product"] }, "REQ-001");
    assert.equal(observed.runs.at(-1).eventType, "implementation_failed");
    assert.equal(observed.runs.at(-1).telemetry.costUsd, 0.03);
    assert.equal(observed.runs.at(-1).telemetry.tokens.output, 15);
    assert.equal(observed.recentFailures[0].stage, "implementation_failed");
    assert.equal(observed.recentFailures[0].traceId, observed.runs.at(-1).traceId);
    assert.match(await fs.readFile(path.join(failed.workspace, "src", "calculator.mjs"), "utf8"), /incomplete/);
    assert.equal((await rollback(projectRoot, "REQ-001", "developer")).state, "rolled_back");
    assert.doesNotMatch(await fs.readFile(path.join(failed.workspace, "src", "calculator.mjs"), "utf8"), /incomplete/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("test deployment failure records an unknown external outcome and blocks replay", async () => {
  const { temporary, projectRoot, project } = await fixture(false, fakePi,
    "Add multiply(left, right) and keep add working.",
    { testDeployment: { kind: "local", command: [process.execPath, "-e", "process.exit(17)"] } });
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    await verify(projectRoot, "REQ-001");
    await approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed exact verified changes before testing.");
    await assert.rejects(deployTest(projectRoot, "REQ-001"), /Local test deployment failed/);
    const task = await readTask(project, "REQ-001");
    assert.equal(task.meta.state, "test_deploy_outcome_unknown");
    assert.equal(task.events.at(-2).type, "test_deploy_submitting");
    assert.equal(task.events.at(-1).type, "test_deploy_outcome_unknown");
    await assert.rejects(deployTest(projectRoot, "REQ-001"), /expected verified/);
    const reviewer = await authenticate(project, "reviewer-token-0123456789-abcdefghijklmn");
    assert.equal((await executeRequirementAction(projectRoot, "REQ-001", {
      action: "reconcile-test-deploy", outcome: "failed", evidence: "Checked the local deployment log; no version was installed.",
    }, reviewer)).state, "test_deploy_failed");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("review feedback produces a new auditable plan version", async () => {
  const { temporary, projectRoot, project } = await fixture();
  try {
    await plan(projectRoot, "REQ-001");
    const result = await revisePlan(projectRoot, "REQ-001", "reviewer", "Clarify local snapshot rollback.");
    assert.equal(result.state, "plan_review");
    const task = await readTask(project, "REQ-001");
    assert.equal(task.meta.planVersion, 2);
    const directory = path.join(project.archive, "tasks", "REQ-001");
    assert.match(await fs.readFile(path.join(directory, "feedback-v1.md"), "utf8"), /snapshot rollback/);
    assert.match(await fs.readFile(path.join(directory, "events.jsonl"), "utf8"), /plan_revision_requested/);
    assert.equal((await approvePlan(projectRoot, "REQ-001", "reviewer")).state, "approved");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("rollback preserves changes made after the agent", async () => {
  const { temporary, projectRoot, project } = await fixture();
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    const implemented = await implement(projectRoot, "REQ-001");
    await fs.appendFile(path.join(implemented.workspace, "src", "calculator.mjs"), "\n// later human edit\n");
    await assert.rejects(rollback(projectRoot, "REQ-001", "developer"), /Rollback conflicts/);
    const source = await fs.readFile(path.join(implemented.workspace, "src", "calculator.mjs"), "utf8");
    assert.match(source, /later human edit/);
    assert.equal((await readTask(project, "REQ-001")).meta.state, "implemented");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

for (const unknownPricing of [false, true]) test(`test-only archive preserves verified candidate and ${unknownPricing ? "unknown" : "known"} pricing`, async () => {
  const { temporary, projectRoot, project } = await fixture(false, fakePi,
    "Add multiply(left, right) and keep add working.", unknownPricing ? {
      environment: { pi: ["PATH"], checks: [], localDeployment: [] },
      compatibleProviders: [{ name: "fake", baseUrl: "https://example.invalid/v1", apiKeyEnv: "PATH", thinkingToggle: false,
        models: [{ id: "fake-model", input: ["text"], reasoning: false, contextWindow: 32000, maxTokens: 2000 }] }],
    } : {});
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    await verify(projectRoot, "REQ-001");
    await approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed exact verified changes before testing.");
    await deployTest(projectRoot, "REQ-001");
    await acceptTest(projectRoot, "REQ-001", "developer", "Manual smoke check passed.");
    assert.equal((await searchProjectHistory(project, { query: "multiplication", reason: "existing_feature" })).results.length, 0,
      "Unarchived and unaccepted work must not be retrieved as long-term delivery evidence");
    assert.equal((await verifyCandidate(projectRoot, "REQ-001")).state, "merge_verified");
    assert.equal((await archiveTestOnly(projectRoot, "REQ-001", "owner")).state, "archived_test_only");
    const report = await fs.readFile(path.join(project.archive, "tasks", "REQ-001", "result.md"), "utf8");
    assert.match(report, /archived_test_only/);
    if (unknownPricing) {
      assert.match(report, /Pi 成本：未知/);
      assert.doesNotMatch(report, /Pi 成本：\$0/);
    } else {
      assert.match(report, /Pi 成本：\$0\.0700/);
    }
    const context = JSON.parse(await baselineAgentContext(project, await readProjectBaseline(project)));
    assert.equal(Object.hasOwn(context, "deliveryHistory"), false,
      "Project context must not load archived deliveries without a retrieval request");
    const retrieved = await searchProjectHistory(project, { query: "multiplication", reason: "existing_feature" });
    assert.equal(retrieved.results[0].id, "REQ-001");
    assert.equal(retrieved.results[0].summaryOnly, true);
    assert.equal(Object.hasOwn(retrieved.results[0], "acceptance"), false);
    assert.equal((await readHistoryEvidence(project, "REQ-001")).acceptance[0].id, "AC1");
    assert.equal((await searchProjectHistory(project, { query: "unrelated-order-feature", reason: "compatibility" })).results.length, 0);
    await assert.rejects(searchProjectHistory(project, { query: "multiplication", reason: "load_recent" }), /retrieval reason/);
    if (!unknownPricing) {
      const probe = execFileSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        const tools=new Map(), receipts=[];
        (await import(${JSON.stringify(new URL("../src/pi-guard.js", import.meta.url).href)})).default({
          registerTool: tool=>tools.set(tool.name,tool), on:()=>{}, appendEntry:(type,data)=>receipts.push({type,data}) });
        const read=tools.get('read_history'), input={id:'REQ-001',acceptanceId:'AC1',offset:0,maxChars:12};
        await assert.rejects(read.execute('r',input),/relevant search/);
        await tools.get('search_history').execute('s',{query:'multiplication',reason:'existing_feature'});
        const first=JSON.parse((await read.execute('r',input)).content[0].text);
        assert.equal(first.partial,true); assert.equal(first.text.length,12);
        const next=JSON.parse((await read.execute('r',{...input,offset:12,maxChars:800})).content[0].text);
        assert.equal(JSON.parse(first.text+next.text).id,'AC1');
        await assert.rejects(read.execute('r',{...input,acceptanceId:'invented'}),/existing acceptance/);
        await assert.rejects(read.execute('r',{...input,id:'another-project-task'}),/relevant search/);
        console.log(JSON.stringify({contractHash:first.contractHash,reads:receipts.filter(r=>r.type==='reqflow_history_read').length}));
      `], { encoding: "utf8", env: { ...process.env, REQFLOW_WORKSPACE: project.root, REQFLOW_PHASE: "review",
        REQFLOW_POLICY: JSON.stringify({ historyProject: project, modelUsage: { maxToolResultBytes: 6000 } }) } });
      const result = JSON.parse(probe);
      assert.equal(result.contractHash, (await readTask(project, "REQ-001")).meta.contractHash);
      assert.equal(result.reads, 2);
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("release requires separate approval and observation", async () => {
  const { temporary, projectRoot, project } = await fixture(true);
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    await verify(projectRoot, "REQ-001");
    await approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed exact verified changes before testing.");
    await deployTest(projectRoot, "REQ-001");
    await acceptTest(projectRoot, "REQ-001", "developer", "Manual acceptance passed.");
    await verifyCandidate(projectRoot, "REQ-001");
    await assert.rejects(release(projectRoot, "REQ-001"), /expected release_approved/);
    const mergeLog = path.join(project.archive, "tasks", "REQ-001", "merge-check-1.log");
    const mergeEvidence = await fs.readFile(mergeLog);
    await fs.appendFile(mergeLog, "altered merge result");
    await assert.rejects(approveRelease(projectRoot, "REQ-001", "owner"), /Changed merge check log/);
    await fs.writeFile(mergeLog, mergeEvidence);
    await approveRelease(projectRoot, "REQ-001", "owner");
    await fs.appendFile(mergeLog, "altered after release approval");
    await assert.rejects(release(projectRoot, "REQ-001"), /Changed merge check log/);
    await fs.writeFile(mergeLog, mergeEvidence);
    assert.equal((await release(projectRoot, "REQ-001")).state, "released");
    assert.equal((await observeRelease(projectRoot, "REQ-001", "owner", "Health checks passed.")).state, "archived");
    const events = await fs.readFile(path.join(project.archive, "tasks", "REQ-001", "events.jsonl"), "utf8");
    assert.match(events, /release_approved/);
    assert.match(events, /archived/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("custom release adapter retains separate approval and polls the approved candidate", async t => {
  let submissions = 0;
  let candidate;
  registerDeploymentAdapter("release-fixture-ci", { version: "1", requiresPublishedRevision: false, validateOptions() {},
    async submit({ request }) {
      submissions++;
      assert.equal(request.environment, "production"); assert.equal(request.sourceHash, candidate.candidateHash);
      assert.equal(request.workspace, candidate.candidateWorkspace);
      return { status: "running", operationId: "fixture-only-release", revision: request.revision, evidence: "Local adapter fixture" };
    },
    async poll({ request }, previous) {
      assert.equal(previous.operationId, "fixture-only-release");
      return { status: "succeeded", operationId: previous.operationId, revision: request.revision, evidence: "Local adapter fixture completed" };
    },
  });
  const { temporary, projectRoot, project } = await fixture(true, fakePi, "Add multiplication", { productionDeployment: {
    kind: "release-fixture-ci", adapterVersion: "1", options: {}, credentialsEnv: [], timeoutMs: 1000 } });
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await plan(projectRoot, "REQ-001");
  await approvePlan(projectRoot, "REQ-001", "reviewer");
  await implement(projectRoot, "REQ-001"); await verify(projectRoot, "REQ-001");
  await deployTest(projectRoot, "REQ-001"); await acceptTest(projectRoot, "REQ-001", "developer", "Fixture acceptance");
  candidate = await verifyCandidate(projectRoot, "REQ-001");
  await assert.rejects(release(projectRoot, "REQ-001"), /expected release_approved/);
  assert.equal(submissions, 0);
  await approveRelease(projectRoot, "REQ-001", "owner");
  assert.equal((await release(projectRoot, "REQ-001")).state, "release_running");
  assert.equal((await pollRelease(projectRoot, "REQ-001")).state, "released");
  assert.equal(submissions, 1);
  assert.equal((await readTask(project, "REQ-001")).meta.productionDeployment.revision, candidate.candidateHash);
});

test("release approval and execution reject candidate drift", async () => {
  const { temporary, projectRoot, project } = await fixture(true);
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    await verify(projectRoot, "REQ-001");
    await approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed exact verified changes before testing.");
    await deployTest(projectRoot, "REQ-001");
    await acceptTest(projectRoot, "REQ-001", "developer", "Manual smoke check passed.");
    const candidate = await verifyCandidate(projectRoot, "REQ-001");
    const source = path.join(candidate.candidateWorkspace, "src", "calculator.mjs");
    const verified = await fs.readFile(source, "utf8");
    await fs.appendFile(source, "\n// changed after verification\n");
    await assert.rejects(approveRelease(projectRoot, "REQ-001", "owner"), /candidate changed/);
    await fs.writeFile(source, verified);
    await approveRelease(projectRoot, "REQ-001", "owner");
    await fs.appendFile(source, "\n// changed after approval\n");
    await assert.rejects(release(projectRoot, "REQ-001"), /candidate changed/);
    assert.equal((await readTask(project, "REQ-001")).meta.state, "release_approved");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("production command failure never reports a successful release", async () => {
  const { temporary, projectRoot, project } = await fixture(true, fakePi,
    "Add multiply(left, right) and keep add working.",
    { productionDeployment: { kind: "local", command: [process.execPath, "-e", "process.exit(23)"] } });
  try {
    await plan(projectRoot, "REQ-001");
    await approvePlan(projectRoot, "REQ-001", "reviewer");
    await implement(projectRoot, "REQ-001");
    await verify(projectRoot, "REQ-001");
    await approveChanges(projectRoot, "REQ-001", "reviewer", "Reviewed exact verified changes before testing.");
    await deployTest(projectRoot, "REQ-001");
    await acceptTest(projectRoot, "REQ-001", "developer", "Checked multiplication and addition.");
    await verifyCandidate(projectRoot, "REQ-001");
    await approveRelease(projectRoot, "REQ-001", "owner");
    await assert.rejects(release(projectRoot, "REQ-001"), /Local test deployment failed/);
    const task = await readTask(project, "REQ-001");
    assert.equal(task.meta.state, "release_outcome_unknown");
    assert.equal(task.events.at(-2).type, "release_submitting");
    assert.equal(task.events.at(-1).type, "release_outcome_unknown");
    await assert.rejects(release(projectRoot, "REQ-001"), /expected release_approved/);
    const reviewer = await authenticate(project, "reviewer-token-0123456789-abcdefghijklmn");
    await assert.rejects(executeRequirementAction(projectRoot, "REQ-001", {
      action: "reconcile-release", outcome: "succeeded", observedRevision: "wrong",
      evidence: "External version checked.",
    }, reviewer), /differs from approved candidate/);
    assert.equal((await executeRequirementAction(projectRoot, "REQ-001", {
      action: "reconcile-release", outcome: "failed", evidence: "External deployment did not complete.",
    }, reviewer)).state, "release_failed");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

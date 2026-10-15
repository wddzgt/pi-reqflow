import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { initialize, createTask, readTask } from "../src/store.js";
import { loadProject } from "../src/config.js";
import { addCredential } from "../src/auth.js";
import { assignMember, respondToAssignment } from "../src/assignment.js";
import { recordDevFeedback, confirmContract } from "../src/intake.js";
import { plan, implement, verify, approvePlan, rollback } from "../src/workflow.js";
import { executeRequirementAction } from "../src/actions.js";
import { localValidation, publishTest, recheckLocalChanges, readGitSetup, candidateReview, redeployTest } from "../src/git-delivery.js";
import { getRequirementEvidence } from "../src/evidence.js";
import { createServer } from "node:http";
import { importProject } from "../src/project-registry.js";
import { inspectGit } from "../src/git-project.js";
import { registerDeploymentAdapter } from "../src/deployment-adapters.js";
import { manifest, manifestHash, sha256 } from "../src/files.js";
import { pathToFileURL } from "node:url";

const repository = path.resolve(new URL("..", import.meta.url).pathname);
const actor = { id: "reviewer", roles: ["developer"] };
function git(root, ...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fixtureCommit(root, message) {
  git(root, "add", "-A");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", message);
}

async function fixture(t, merge = false, overrides = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "devsail-git-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "app"); const remote = path.join(temporary, "remote.git");
  await fs.mkdir(root);
  git(temporary, "init", "--bare", remote); git(root, "init", "-b", "main");
  await fs.cp(path.join(repository, "examples/demo-app/src"), path.join(root, "src"), { recursive: true });
  await fs.cp(path.join(repository, "examples/demo-app/test"), path.join(root, "test"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".reqflow/\n");
  fixtureCommit(root, "baseline"); git(root, "remote", "add", "origin", remote);
  git(root, "push", "origin", "main");
  git(root, "branch", "existing-feature");
  if (merge) { git(root, "branch", "integration"); git(root, "push", "origin", "integration"); }
  const config = { schemaVersion: 2, mode: "git", baseBranch: "main", releaseBranch: "main", branchPrefix: "devsail", remote: "origin",
    piExecutable: path.join(repository, "test/fake-pi.mjs"), provider: "fake", model: "fake-model",
    environment: { pi: [], checks: [], localDeployment: [] }, allowedPaths: ["src", "test"], excludedPaths: [".env"],
    maxSnapshotBytes: 1000000, maxPiMs: 30000, maxToolCalls: 20, maxEventBytes: 1000000, maxCostUsd: 2,
    checks: [[process.execPath, "--test", "test/calculator.test.mjs"]],
    testDeployment: { kind: "local", command: [process.execPath, "--test", "test/calculator.test.mjs"] }, productionDeployment: { kind: "none" },
    ...(merge ? { gitDelivery: { testMode: "merge", testBranch: "integration" } } : {}), ...overrides };
  const configFile = path.join(temporary, "config.json"); await fs.writeFile(configFile, JSON.stringify(config));
  await initialize(root, configFile, { inventoryOnly: true }); const project = await loadProject(root);
  await addCredential(project, "reviewer", ["developer"], { username: "reviewer", password: "admin123" });
  await createTask(project, "REQ-001", "Add multiplication", "Add multiply(left, right) and keep add working.", "product");
  await assignMember(root, "REQ-001", "product", "developer", "reviewer");
  await respondToAssignment(root, "REQ-001", "reviewer", "developer", true);
  await recordDevFeedback(root, "REQ-001", "reviewer", { summary: "Add multiplication without changing addition", questions: [], requiredRoles: ["backend", "qa"] });
  await confirmContract(root, "REQ-001", "product", { objective: "Support multiplication", currentBehavior: "Only adds",
    desiredBehavior: "multiply returns product; add unchanged", acceptance: [{ id: "AC1", text: "multiply(2,3)=6 and add(2,3)=5" }],
    inScope: ["src/calculator.mjs", "test/calculator.test.mjs"], outOfScope: [], answers: {} });
  await plan(root, "REQ-001");
  return { temporary, root, remote, project, config };
}

async function developFixture(f, branch = { kind: "new", branch: "devsail/REQ-001" }) {
  const { meta } = await readTask(f.project, "REQ-001");
  await approvePlan(f.root, "REQ-001", "reviewer", undefined, undefined, meta.planHash, branch);
  await implement(f.root, "REQ-001"); await verify(f.root, "REQ-001");
  return (await readTask(f.project, "REQ-001")).meta;
}

function confirmation(meta, merge = false) { return { authorizeGit: true, expectedAfterHash: meta.afterHash,
  expectedPlanHash: meta.planHash, testMode: merge ? "merge" : "branch", ...(merge ? { testBranch: "integration" } : {}) }; }

for (const merge of [false, true]) test(`acceptance repair preserves published Git history and requires a fresh ${merge ? "merge" : "branch"} deployment`, async t => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-git-acceptance-model-"));
  t.after(() => fs.rm(models, { recursive: true, force: true }));
  const executable = path.join(models, "pi.mjs");
  await fs.writeFile(executable, `import {promises as fs} from 'node:fs';const prompt=process.argv.at(-1);
if(prompt.startsWith('验收反馈调查')||process.env.REQFLOW_PHASE==='implement'&&prompt.includes('验收修复调查')){
 let text='已补充说明，保留现有实现和测试';if(prompt.startsWith('验收反馈调查'))text=JSON.stringify({reply:'补充已有函数的说明',route:'repair',
 rootCause:['函数说明缺失','实施没有写说明','测试只检查数值'],affectedFiles:['src/calculator.mjs'],acceptanceIds:['AC1'],
 evidence:[{file:'src/calculator.mjs',line:1,reason:'已实现源码'}],repair:'补充注释，保留现有乘法和加法',questions:[]});
 else await fs.appendFile('src/calculator.mjs','\\n// Approved acceptance repair; existing behavior retained.\\n');
 console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop',
 usage:{input:120,output:40,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));console.log(JSON.stringify({type:'agent_settled'}));
}else await import(${JSON.stringify(path.join(repository, "test/fake-pi.mjs"))});`);
  const f = await fixture(t, merge, { piExecutable: executable });
  const verified = await developFixture(f);
  await publishTest(f.root, "REQ-001", actor.id, confirmation(verified, merge));
  const deployed = (await readTask(f.project, "REQ-001")).meta, priorCommit = deployed.gitCommit.revision;
  const version = { expectedPlanHash: deployed.planHash, expectedAfterHash: deployed.afterHash, expectedContractHash: deployed.contractHash };
  await executeRequirementAction(f.root, "REQ-001", { action: "discuss-acceptance", message: { ...version, text: "补充函数说明" } }, actor);
  const reply = (await readTask(f.project, "REQ-001")).events.findLast(event => event.type === "acceptance_reply");
  await executeRequirementAction(f.root, "REQ-001", { action: "start-acceptance-repair", ...version, expectedFeedbackHash: reply.hash }, actor);
  const repaired = (await readTask(f.project, "REQ-001")).meta;
  assert.equal(repaired.state, "verified", JSON.stringify(repaired.developmentPause));
  assert.equal(repaired.workspace, deployed.workspace); assert.equal(repaired.branch, deployed.branch);
  assert.equal(git(repaired.workspace, "rev-parse", "HEAD"), priorCommit);
  assert.equal(repaired.testDeployment, null); assert.equal(repaired.testCandidate, null); assert.equal(repaired.publishedRevision, null);
  assert.equal((await getRequirementEvidence(f.root, actor, "REQ-001")).implementationAttempts.length, 1);
  await publishTest(f.root, "REQ-001", actor.id, confirmation(repaired, merge));
  const redeployed = (await readTask(f.project, "REQ-001")).meta;
  assert.equal(redeployed.state, "test_deployed"); assert.notEqual(redeployed.gitCommit.revision, priorCommit);
  assert.equal(git(redeployed.workspace, "rev-parse", "HEAD^"), priorCommit);
});

test("Git rollback restart preserves the old branch and develops in a fresh worktree", async t => {
  const f = await fixture(t);
  const previous = await developFixture(f);
  const oldHead = git(previous.workspace, "rev-parse", "HEAD");
  await rollback(f.root, "REQ-001", "reviewer");
  const rolled = await readTask(f.project, "REQ-001");
  await executeRequirementAction(f.root, "REQ-001", { action: "restart-development", expectedAuditHead: rolled.lastHash }, actor);
  await plan(f.root, "REQ-001"); await approvePlan(f.root, "REQ-001", "reviewer");
  await implement(f.root, "REQ-001"); await verify(f.root, "REQ-001");
  const next = await readTask(f.project, "REQ-001");
  assert.equal(next.meta.branch, "devsail/REQ-001-restart-1");
  assert.notEqual(next.meta.workspace, previous.workspace);
  assert.equal(git(previous.workspace, "rev-parse", "HEAD"), oldHead);
  assert.equal(git(previous.workspace, "status", "--porcelain"), "");
  assert.equal(git(f.root, "rev-parse", previous.branch), oldHead);
  assert.equal(git(f.root, "rev-parse", "HEAD"), oldHead);
  const evidence = await getRequirementEvidence(f.root, actor, "REQ-001");
  assert.equal(evidence.implementationAttempts.filter(item => item.priorState === "rolled_back").length, 1);
  assert.equal(next.meta.state, "verified");
});

test("plan-scoped checks survive Git merge and test deployment without manual commands", async t => {
  const f = await fixture(t, true);
  const planMeta = (await readTask(f.project, "REQ-001")).meta;
  const result = await executeRequirementAction(f.root, "REQ-001", { action: "approve-plan", expectedPlanHash: planMeta.planHash,
    developmentBranch: { kind: "new", branch: "devsail/REQ-001" } }, actor);
  assert.equal(result.state, "verified");
  const meta = (await readTask(f.project, "REQ-001")).meta;
  assert.deepEqual(meta.checks[0].command, meta.developmentChecks[0]);
  const deployed = await publishTest(f.root, "REQ-001", "reviewer", confirmation(meta, true));
  assert.equal(deployed.state, "test_deployed");
  const merged = (await readTask(f.project, "REQ-001")).events.findLast(event => event.type === "git_candidate_verified");
  assert.deepEqual(merged.detail.checks[0].command, meta.developmentChecks[0]);
  assert.equal(meta.verificationMode, "automated");
});

test("branch development pins the reviewed revision while other developers advance main", async t => {
  const f = await fixture(t); const base = git(f.root, "rev-parse", "HEAD");
  await fs.writeFile(path.join(f.root, "README.md"), "Other feature\n"); fixtureCommit(f.root, "other developer");
  git(f.root, "push", "origin", "main");
  const meta = await developFixture(f);
  assert.equal(git(meta.workspace, "rev-parse", "HEAD"), base);
  assert.equal(meta.state, "verified");
  await assert.rejects(publishTest(f.root, "REQ-001", "reviewer", { ...confirmation(meta), authorizeGit: false }), /明确确认/);
  await assert.rejects(publishTest(f.root, "REQ-001", "reviewer", { ...confirmation(meta), expectedAfterHash: "stale" }), /刷新/);
  const result = await publishTest(f.root, "REQ-001", "reviewer", confirmation(meta));
  assert.equal(result.state, "test_deployed");
  assert.equal(git(f.root, "rev-parse", "main"), git(f.root, "ls-remote", "origin", "main").split(/\s+/)[0]);
  assert.equal(result.publishedRevision, git(meta.workspace, "rev-parse", "HEAD"));
  const task = await readTask(f.project, "REQ-001");
  assert.equal(task.events.filter(event => event.type === "git_committed").length, 1);
  assert.equal(task.meta.gitCommit.actor, "reviewer");
});

test("existing independent branch works and local verification exports added files without staging them", async t => {
  const f = await fixture(t); let meta = await developFixture(f, { kind: "existing", branch: "existing-feature" });
  const initialHead = git(meta.workspace, "rev-parse", "HEAD");
  await fs.writeFile(path.join(meta.workspace, "src/local-note.mjs"), "export const note = true;\n");
  await recheckLocalChanges(f.root, "REQ-001", "reviewer", confirmation(meta));
  meta = (await readTask(f.project, "REQ-001")).meta;
  const validation = await localValidation(f.root, "REQ-001", "reviewer", confirmation(meta));
  assert.match(validation.patch, /src\/local-note.mjs/);
  assert.equal(git(meta.workspace, "diff", "--cached", "--name-only"), "");
  assert.equal(git(meta.workspace, "rev-parse", "HEAD"), initialHead);
  const clone = path.join(f.temporary, "local"); git(f.temporary, "clone", f.remote, clone); git(clone, "checkout", meta.baseRevision);
  const file = path.join(f.temporary, "changes.patch"); await fs.writeFile(file, validation.patch + "\n");
  git(clone, "apply", "--check", file); git(clone, "apply", file);
  assert.match(await fs.readFile(path.join(clone, "src/calculator.mjs"), "utf8"), /multiply/);
  const result = await publishTest(f.root, "REQ-001", "reviewer", { ...confirmation(meta), localValidated: true });
  assert.equal(result.state, "test_deployed"); assert.equal(result.branch, "existing-feature");
});

test("merge deployment preserves concurrent target commits and deploys the checked combined version", async t => {
  const f = await fixture(t, true); const meta = await developFixture(f);
  const other = path.join(f.temporary, "other"); git(f.root, "worktree", "add", other, "integration");
  await fs.writeFile(path.join(other, "README.md"), "Parallel work retained\n"); fixtureCommit(other, "parallel work");
  git(other, "push", "origin", "integration");
  const otherRevision = git(other, "rev-parse", "HEAD");
  const result = await publishTest(f.root, "REQ-001", "reviewer", confirmation(meta, true));
  assert.equal(result.state, "test_deployed");
  assert.notEqual(result.testCandidate.publishedRevision, result.publishedRevision);
  assert.equal(result.testCandidate.targetRevision, otherRevision);
  assert.equal(git(f.root, "ls-remote", "origin", "integration").split(/\s+/)[0], result.testCandidate.publishedRevision);
  assert.match(await fs.readFile(path.join(result.testCandidate.workspace, "README.md"), "utf8"), /retained/);
  assert.equal(result.testCandidate.sourceHash, manifestHash(await manifest(result.testCandidate.workspace, f.project.config.excludedPaths, f.project.config.maxSnapshotBytes)));
  assert.equal(result.testCandidate.checks.every(check => check.code === 0), true);
});

test("conflicts retain a candidate and resume only after the developer reviews the resolved version", async t => {
  const f = await fixture(t, true); const meta = await developFixture(f);
  const other = path.join(f.temporary, "other"); git(f.root, "worktree", "add", other, "integration");
  await fs.appendFile(path.join(other, "src/calculator.mjs"), "\nexport const otherFeature = true;\n"); fixtureCommit(other, "other feature");
  git(other, "push", "origin", "integration"); const before = git(other, "rev-parse", "HEAD");
  await assert.rejects(publishTest(f.root, "REQ-001", "reviewer", confirmation(meta, true)), /合并冲突/);
  let current = (await readTask(f.project, "REQ-001")).meta;
  assert.equal(current.state, "verified"); assert.ok(current.gitCandidate.workspace);
  assert.equal(git(f.root, "ls-remote", "origin", "integration").split(/\s+/)[0], before);
  const combined = (await fs.readFile(path.join(meta.workspace, "src/calculator.mjs"), "utf8")) + "\nexport const otherFeature = true;\n";
  await fs.writeFile(path.join(current.gitCandidate.workspace, "src/calculator.mjs"), combined);
  git(current.gitCandidate.workspace, "add", "src/calculator.mjs");
  const review = await candidateReview(f.root, "REQ-001"); assert.equal(review.conflicts, "");
  await assert.rejects(publishTest(f.root, "REQ-001", "reviewer", { ...confirmation(current, true), expectedCandidateHash: "stale" }), /查看/);
  const result = await publishTest(f.root, "REQ-001", "reviewer", { ...confirmation(current, true), expectedCandidateHash: review.hash });
  assert.equal(result.state, "test_deployed");
  assert.match(await fs.readFile(path.join(result.testCandidate.workspace, "src/calculator.mjs"), "utf8"), /otherFeature/);
  const events = (await readTask(f.project, "REQ-001")).events;
  assert.equal(events.filter(event => event.type === "git_committed").length, 1);
});

test("Git import retains history, branches and remote in a separate checkout", async t => {
  const f = await fixture(t);
  const prior = process.env.REQFLOW_STATE_DIR; process.env.REQFLOW_STATE_DIR = path.join(f.temporary, "state");
  t.after(() => { if (prior === undefined) delete process.env.REQFLOW_STATE_DIR; else process.env.REQFLOW_STATE_DIR = prior; });
  const imported = await importProject("Existing Git system", { backendDir: f.root }, { config: f.config,
    inventoryOnly: true, accountSource: f.project.archive });
  const project = await loadProject(imported.projectDir);
  assert.equal(project.config.mode, "git"); assert.equal(project.root === f.root, false);
  assert.equal(project.config.baseBranch, "main");
  assert.equal(git(project.root, "rev-parse", "HEAD"), git(f.root, "rev-parse", "HEAD"));
  assert.equal(git(project.root, "remote", "get-url", "origin"), f.remote);
  assert.equal(git(project.root, "branch", "--list", "existing-feature").trim(), "existing-feature");
  assert.ok(await fs.stat(path.join(project.root, "src/calculator.mjs")));
  await assert.rejects(fs.stat(path.join(project.root, "backend")), { code: "ENOENT" });
  assert.equal((await readGitSetup(project.root)).branches.includes("existing-feature"), true);
  assert.equal((await inspectGit(f.root)).clean, true);
});

test("authorization and newly edited code cannot be mistaken for reviewed changes", async t => {
  const f = await fixture(t); const meta = await developFixture(f);
  await assert.rejects(executeRequirementAction(f.root, "REQ-001", { action: "publish-test", ...confirmation(meta) },
    { id: "product", roles: ["product"] }), /Role cannot/);
  await assert.rejects(executeRequirementAction(f.root, "REQ-001", { action: "publish-test", ...confirmation(meta) },
    { id: "another", roles: ["developer"] }), /not assigned/);
  const head = git(meta.workspace, "rev-parse", "HEAD");
  await fs.appendFile(path.join(meta.workspace, "src/calculator.mjs"), "\nexport const reviewedLater = true;\n");
  await assert.rejects(publishTest(f.root, "REQ-001", "reviewer", confirmation(meta)), /重新检查/);
  assert.equal(git(meta.workspace, "rev-parse", "HEAD"), head);
  assert.equal(git(f.root, "ls-remote", "origin", meta.branch), "");
});

test("the developer action stops before Git changes and test acceptance archives without an extra manual merge", async t => {
  const f = await fixture(t, false, { productionDeployment: { kind: "local",
    command: [process.execPath, "-e", "throw new Error('production must not be triggered')"] } });
  const meta = (await readTask(f.project, "REQ-001")).meta;
  const result = await executeRequirementAction(f.root, "REQ-001", { action: "approve-plan", expectedPlanHash: meta.planHash,
    developmentBranch: { kind: "new", branch: "devsail/REQ-001" } }, actor);
  assert.equal(result.state, "verified"); assert.equal(result.next, "choose-validation");
  const before = (await readTask(f.project, "REQ-001")).meta;
  assert.equal(git(before.workspace, "rev-parse", "HEAD"), meta.baseRevision);
  assert.equal(git(f.root, "ls-remote", "origin", before.branch), "");
  await executeRequirementAction(f.root, "REQ-001", { action: "publish-test", ...confirmation(before) }, actor);
  const accepted = await executeRequirementAction(f.root, "REQ-001", { action: "accept-test", acceptanceMode: "deployed",
    expectedAfterHash: before.afterHash, expectedPlanHash: before.planHash,
    acceptanceResults: [{acceptanceId:"AC1",conclusion:"测试环境乘法及原加法符合需求"}], evidence: "人工验证乘法及原加法符合需求" },
    { id: "product", roles: ["product"] });
  assert.equal(accepted.state, "archived_test_only");
  const report = await fs.readFile(path.join(f.project.archive, "tasks/REQ-001/result.md"), "utf8");
  assert.match(report, /devsail\/REQ-001/); assert.match(report, /不代表已合入正式目标分支/);
});

test("remote submit and poll both use the checked merge revision and branch", async t => {
  const requests = [];
  registerDeploymentAdapter("git-revision-probe", { version: "1", requiresPublishedRevision: true,
    validateOptions() {}, submit: async ({ request }) => {
      requests.push(request); return { status: "running", operationId: "1", revision: request.revision, evidence: "queued" };
    }, poll: async ({ request }) => {
      requests.push(request); return { status: "succeeded", operationId: "1", revision: request.revision, evidence: "checked exact revision" };
    } });
  const f = await fixture(t, true, { testDeployment: { kind: "git-revision-probe", adapterVersion: "1", options: {}, credentialsEnv: [], timeoutMs: 1000 } });
  const meta = await developFixture(f);
  const result = await publishTest(f.root, "REQ-001", "reviewer", confirmation(meta, true));
  assert.equal(result.state, "test_deployed"); assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.branch, "integration");
    assert.equal(request.revision, result.testCandidate.publishedRevision);
    assert.equal(request.sourceHash, result.testCandidate.sourceHash);
  }
});

test("local incremental patches are rechecked and the preceding code remains inspectable", async t => {
  const f = await fixture(t); const meta = await developFixture(f);
  const exported = await localValidation(f.root, "REQ-001", "reviewer", confirmation(meta));
  const local = path.join(f.temporary, "local"); git(f.temporary, "clone", f.remote, local); git(local, "checkout", meta.baseRevision);
  const file = path.join(f.temporary, "agent.patch"); await fs.writeFile(file, exported.patch);
  git(local, "apply", file); git(local, "add", "-A");
  await fs.appendFile(path.join(local, "src/calculator.mjs"), "\nexport const localFeature = true;\n");
  const patch = git(local, "diff", "--binary") + "\n";
  const result = await recheckLocalChanges(f.root, "REQ-001", "reviewer", { ...confirmation(meta), patch });
  assert.equal(result.state, "verified"); assert.notEqual(result.afterHash, meta.afterHash);
  const evidence = await getRequirementEvidence(f.root, actor, "REQ-001");
  assert.equal(evidence.implementationAttempts.length, 1);
  assert.match(await fs.readFile(path.join(result.workspace, "src/calculator.mjs"), "utf8"), /localFeature/);
  await assert.rejects(publishTest(f.root, "REQ-001", "reviewer", confirmation(meta)), /刷新/);
});

test("shared environment replacement blocks stale acceptance and allows explicit redeployment", async t => {
  const server = createServer((req, res) => { res.end("test environment"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const f = await fixture(t, false, { testDeployment: { kind: "local", url,
    command: [process.execPath, "--test", "test/calculator.test.mjs"] } });
  const meta = await developFixture(f);
  await publishTest(f.root, "REQ-001", "reviewer", confirmation(meta));
  await fs.writeFile(path.join(f.project.archive, `test-environment-${sha256(url)}.json`), JSON.stringify({ taskId: "REQ-OTHER", url, status: "succeeded" }));
  const evidence = await getRequirementEvidence(f.root, actor, "REQ-001");
  assert.equal(evidence.meta.testEnvironmentSupersededBy, "REQ-OTHER");
  await assert.rejects(executeRequirementAction(f.root, "REQ-001", { action: "accept-test", acceptanceMode: "deployed",
    expectedAfterHash: meta.afterHash, expectedPlanHash: meta.planHash,
    acceptanceResults: [{acceptanceId:"AC1",conclusion:"checked old link"}], evidence: "checked old link" }, actor), /其他需求/);
  const result = await redeployTest(f.root, "REQ-001", "reviewer", { ...confirmation(meta), authorizeDeployment: true });
  assert.equal(result.state, "test_deployed");
  const current = await getRequirementEvidence(f.root, actor, "REQ-001");
  assert.equal(current.meta.testEnvironmentSupersededBy, null);
  assert.equal((await readTask(f.project, "REQ-001")).events.filter(event => event.type === "git_committed").length, 1);
});

for (const kind of ["jenkins", "gitlab", "github"]) test(`${kind} publishes verified Git code to a working preview through the developer action`, async t => {
  let f, build, deployed, submissions = 0;
  const tokenEnv = `DEVSAIL_CHAIN_${kind.toUpperCase()}_TOKEN`;
  const userEnv = "DEVSAIL_CHAIN_JENKINS_USER";
  process.env[tokenEnv] = "chain-test-token";
  if (kind === "jenkins") process.env[userEnv] = "chain-user";
  t.after(() => { delete process.env[tokenEnv]; if (kind === "jenkins") delete process.env[userEnv]; });
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/preview") {
        res.writeHead(deployed ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(deployed ?? { error: "not deployed" })); return;
      }
      assert.equal(req.headers[kind === "gitlab" ? "private-token" : "authorization"], kind === "gitlab" ? "chain-test-token"
        : kind === "github" ? "Bearer chain-test-token" : `Basic ${Buffer.from("chain-user:chain-test-token").toString("base64")}`);
      const base = `http://127.0.0.1:${server.address().port}/`;
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") {
        submissions++; let text = ""; for await (const chunk of req) text += chunk;
        const body = kind === "jenkins" ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text);
        const inputs = kind === "gitlab" ? Object.fromEntries(body.variables.map(item => [item.key, item.value])) : kind === "github" ? body.inputs : body;
        build = { revision: inputs.REVISION ?? inputs.revision, branch: body.ref ?? body.BRANCH };
        assert.equal(inputs.DEPLOY_ENV ?? inputs.deploy_env, "test");
        const checkout = path.join(f.temporary, "ci-checkout");
        git(f.temporary, "clone", "--branch", build.branch, f.remote, checkout);
        git(checkout, "checkout", "--detach", build.revision);
        const script = `import { multiply, add } from ${JSON.stringify(pathToFileURL(path.join(checkout, "src/calculator.mjs")).href)}; console.log(JSON.stringify({multiply:multiply(2,3),add:add(2,3)}));`;
        const values = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
        const output = path.join(f.temporary, "published.json");
        await fs.writeFile(output, JSON.stringify({ ...values, revision: git(checkout, "rev-parse", "HEAD") }));
        deployed = JSON.parse(await fs.readFile(output, "utf8"));
        if (kind === "jenkins") { res.writeHead(201, { Location: `${base}queue/item/9/` }); res.end(); return; }
        res.end(JSON.stringify(kind === "gitlab" ? { id: 9, sha: build.revision, status: "running", web_url: `${base}pipelines/9` } : { workflow_run_id: 9 })); return;
      }
      if (kind === "jenkins") {
        if (req.url === "/queue/item/9/api/json") { res.end(JSON.stringify({ executable: { url: `${base}job/deploy-test/9/` } })); return; }
        assert.equal(req.url, "/job/deploy-test/9/api/json");
        res.end(JSON.stringify({ building: false, number: 9, result: "SUCCESS", actions: [{ parameters: [{ name: "REVISION", value: build.revision }] }] }));
      } else if (kind === "gitlab") {
        assert.equal(req.url, "/api/v4/projects/123/pipelines/9");
        res.end(JSON.stringify({ id: 9, sha: build.revision, status: "success", web_url: `${base}pipelines/9` }));
      } else {
        assert.equal(req.url, "/repos/team/app/actions/runs/9");
        res.end(JSON.stringify({ id: 9, head_sha: build.revision, head_branch: build.branch, status: "completed", conclusion: "success" }));
      }
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const deployment = kind === "jenkins" ? { kind, baseUrl, jobPath: "job/deploy-test", userEnv, tokenEnv, timeoutMs: 5000, url: `${baseUrl}preview` }
    : { kind, adapterVersion: "1", credentialsEnv: [tokenEnv], timeoutMs: 5000, url: `${baseUrl}preview`,
      options: kind === "gitlab" ? { baseUrl, projectId: "123", tokenEnv } : { baseUrl, owner: "team", repository: "app", workflow: "deploy-test.yml", tokenEnv } };
  f = await fixture(t, false, { testDeployment: deployment });
  assert.equal((await fetch(`${baseUrl}preview`)).status, 404);
  const before = (await readTask(f.project, "REQ-001")).meta;
  await executeRequirementAction(f.root, "REQ-001", { action: "approve-plan", expectedPlanHash: before.planHash,
    developmentBranch: { kind: "new", branch: "devsail/REQ-001" } }, actor);
  const verified = (await readTask(f.project, "REQ-001")).meta;
  const result = await executeRequirementAction(f.root, "REQ-001", { action: "publish-test", ...confirmation(verified) }, actor);
  assert.equal(result.state, "test_deployed");
  const meta = (await readTask(f.project, "REQ-001")).meta;
  const preview = await (await fetch(`${baseUrl}preview`)).json();
  assert.deepEqual(preview, { multiply: 6, add: 5, revision: meta.publishedRevision });
  assert.equal(meta.testDeployment.environment.status, "reachable"); assert.equal(submissions, 1);
  assert.equal(git(f.root, "ls-remote", "origin", meta.branch).split(/\s+/)[0], preview.revision);
  assert.doesNotMatch(await fs.readFile(path.join(f.project.archive, "tasks/REQ-001/test-deploy-1.log"), "utf8"), /chain-test-token/);
});

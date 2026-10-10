import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addCredential, authorizeTaskAction, canReadTask } from "../src/auth.js";
import { executeRequirementAction } from "../src/core.js";
import { loadProject } from "../src/config.js";
import { createTask, initialize, readTask } from "../src/store.js";
import { readPlanAnalysis } from "../src/plan-analysis.js";
import { planReviewStatus } from "../src/plan-review.js";
import { planReviewHash, validateDesign } from "../src/design-document.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const product = { id: "product", roles: ["product"] };
const front = { id: "front", roles: ["developer"] };
const back = { id: "back", roles: ["developer"] };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsail-team-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ["src", "test"]) await fs.cp(path.join(repository, "examples/demo-app", directory), path.join(root, directory), { recursive: true });
  await fs.mkdir(path.join(root, "frontend"));
  await fs.writeFile(path.join(root, "frontend/compute.mjs"), "import { add } from '../src/calculator.mjs';\nexport const compute = (left, right) => add(left, right);\n");
  const config = path.join(root, "execution.json");
  await fs.writeFile(config, JSON.stringify({ schemaVersion: 2, mode: "local", piExecutable: path.join(repository, "test/fake-pi.mjs"), provider: "fake", model: "fake-model",
    environment: { pi: [], checks: [], localDeployment: [] }, allowedPaths: ["src", "test", "frontend"], excludedPaths: ["execution.json"],
    maxSnapshotBytes: 1000000, maxPiMs: 30000, maxToolCalls: 20, maxEventBytes: 1000000, maxCostUsd: 4,
    checks: [[process.execPath, "--test", "test/calculator.test.mjs"]], testDeployment: { kind: "unconfigured" }, productionDeployment: { kind: "none" } }));
  await initialize(root, config);
  const project = await loadProject(root);
  for (const user of [front, back]) await addCredential(project, user.id, user.roles, { username: user.id, password: `${user.id}123` });
  await createTask(project, "1", "Frontend calculator", "Frontend calculator supports multiplication", product.id);
  return { root, project, action: (body, principal = back) => executeRequirementAction(root, "1", body, principal) };
}

test("split developers review one design before the delivery lead develops and chooses validation", async t => {
  const { project, action } = await fixture(t);
  await assert.rejects(action({ action: "assign-team", team: { mode: "split", lead: "front", frontend: "front", backend: "product" } }, product), /没有研发权限/);
  let meta = await action({ action: "assign-team", team: { mode: "split", lead: "back", frontend: "front", backend: "back" } }, product);
  assert.equal(meta.state, "assignment_pending");
  assert.equal(canReadTask(front, meta), true);
  assert.throws(() => authorizeTaskAction(front, "plan", meta), /not assigned/);
  await action({ action: "accept-assignment", role: "frontend" }, front);
  meta = await action({ action: "accept-assignment", role: "backend" });
  assert.equal(meta.assignments.developer.status, "accepted");
  assert.equal(meta.state, "intake_assigned");
  await action({ action: "dev-feedback", feedback: { summary: "Add multiplication through the frontend module", questions: [], requiredRoles: ["frontend", "backend", "qa"] } });
  await action({ action: "confirm-contract", contract: { objective: "Frontend calculator supports multiplication", currentBehavior: "compute calls addition",
    desiredBehavior: "compute(2, 3) returns 6; add stays unchanged", acceptance: [{ id: "AC1", text: "compute and multiply return 6 for 2 and 3" }],
    inScope: ["src/calculator.mjs", "test/calculator.test.mjs", "frontend/compute.mjs"], outOfScope: [], answers: {} } }, product);
  await action({ action: "plan" });
  const task = await readTask(project, "1"); meta = task.meta;
  const analysis = await readPlanAnalysis(meta, task.directory);
  assert.match(analysis.draft.markdown, /实现思路[\s\S]*前端设计[\s\S]*后端设计[\s\S]*接口与前后端约定[\s\S]*关键逻辑/);
  assert.deepEqual(analysis.draft.design.diagrams, []);
  assert.doesNotMatch(analysis.draft.markdown, /```mermaid/);
  assert.match(analysis.draft.markdown, /调用 multiply 并返回结果/);
  assert.equal(planReviewStatus(meta, analysis.draft).ready, false);
  await assert.rejects(action({ action: "approve-plan", expectedPlanHash: meta.planHash }), /等待前端、后端/);
  assert.equal((await readTask(project, "1")).meta.workspace, undefined);
  await assert.rejects(action({ action: "review-plan", part: "backend", expectedPlanHash: meta.planHash }, front), /自己已接单/);
  await assert.rejects(action({ action: "review-plan", part: "frontend", expectedPlanHash: "0".repeat(64) }, front), /方案已改变/);
  await action({ action: "discuss-plan", message: { text: "共同接口是否保持现有加法？", expectedPlanHash: meta.planHash } }, front);
  await action({ action: "review-plan", part: "frontend", expectedPlanHash: meta.planHash }, front);
  await assert.rejects(action({ action: "approve-plan", expectedPlanHash: meta.planHash }), /等待后端/);
  const reviewed = await action({ action: "review-plan", part: "backend", expectedPlanHash: meta.planHash });
  assert.equal(reviewed.reviewStatus.ready, true);
  for (const operation of ["approve-plan", "implement", "publish-test", "local-validation", "deploy-test"]) assert.throws(() => authorizeTaskAction(front, operation, reviewed), /not assigned/);
  const result = await action({ action: "approve-plan", expectedPlanHash: meta.planHash });
  assert.equal(result.state, "verified");
  assert.equal(result.next, "choose-validation");
  const completed = await readTask(project, "1");
  assert.equal(completed.meta.testDeployment, undefined);
  assert.equal(completed.events.filter(event => event.type === "plan_part_approved").length, 2);
  assert.equal(completed.events.find(event => event.type === "plan_approved").detail.teamReview.ready, true);
  assert.match(await fs.readFile(path.join(completed.meta.workspace, "frontend/compute.mjs"), "utf8"), /multiply/);
});

test("reviews retain unchanged responsible content and both expire when the shared interface changes", () => {
  const draft = { schemaVersion: 2, affectedFiles: ["frontend/view.js", "backend/controller.js"], domains: ["frontend", "backend"],
    changes: [{ file: "frontend/view.js", description: "Show export" }, { file: "backend/controller.js", description: "Export current version" }],
    verification: [{ acceptanceId: "AC1", scenario: "Export and import", regression: "Existing editing" }], impacts: {}, boundaries: { recovery: "code only" },
    design: { approach: "Reuse existing template format", frontend: "Export button", backend: "Export endpoint", data: "No historical versions",
      interfaces: [{ name: "export", method: "GET", path: "/export", status: "new", sourceFile: "backend/controller.js", request: "id", response: "json", errors: "404" }],
      diagrams: [{ title: "Interaction", kind: "sequence", domain: "shared", source: "sequenceDiagram\nF->>B: export" }],
      components: [{ file: "frontend/view.js", domain: "frontend", location: "export action", pseudocode: "download json" },
        { file: "backend/controller.js", domain: "backend", location: "export endpoint", pseudocode: "serialize current version" }] } };
  const meta = { developmentTeam: { mode: "split" }, assignments: { frontend: { userId: "front", status: "accepted" }, backend: { userId: "back", status: "accepted" } },
    contractHash: "contract", baseHash: "source", configHash: "config", standardsHash: "standards", planPartApprovals: {} };
  validateDesign(draft);
  for (const role of ["frontend", "backend"]) meta.planPartApprovals[role] = { actor: meta.assignments[role].userId, scopeHash: planReviewHash(meta, draft, role), planVersion: 1 };
  assert.equal(planReviewStatus(meta, draft).ready, true);
  draft.design.backend = "Export endpoint streams the existing format";
  let status = planReviewStatus(meta, draft);
  assert.equal(status.parts.find(part => part.role === "frontend").approved, true);
  assert.equal(status.parts.find(part => part.role === "backend").approved, false);
  draft.design.interfaces[0].response = "different format";
  status = planReviewStatus(meta, draft);
  assert.equal(status.parts.every(part => !part.approved), true);
  draft.design.components[0].domain = "other";
  assert.throws(() => validateDesign(draft), /无效/);
  draft.design.components[0].domain = "frontend"; draft.domains = ["backend"];
  assert.throws(() => validateDesign(draft), /范围不一致/);
  draft.domains = ["frontend", "backend"]; draft.design.diagrams[0].source += '\n%%{init: {"securityLevel":"loose"}}%%';
  assert.throws(() => validateDesign(draft), /不能包含初始化配置、点击指令或脚本/);
  draft.design.diagrams[0].source = 'sequenceDiagram\nF->>B: export';
  draft.design.components[1].pseudocode = 'x'.repeat(1601);
  assert.throws(() => validateDesign(draft), /components\[1\]\.pseudocode \(backend\/controller.js\) has 1601 characters; maximum is 1600/);
});

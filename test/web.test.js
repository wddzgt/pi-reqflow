import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { addCredential, revokeCredential } from "../src/auth.js";
import { assignMember, respondToAssignment } from "../src/assignment.js";
import { confirmContract, finalizeRoleReview, recordDevFeedback, submitRoleReview } from "../src/intake.js";
import { initialize, createTask, readTask } from "../src/store.js";
import { loadProject } from "../src/config.js";
import { approvePlan, implement, plan, verify } from "../src/workflow.js";
import { startWebServer } from "../src/web-server.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function networkRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const call = request(url, options, (response) => {
      response.resume();
      resolve({ status: response.statusCode, headers: response.headers });
    });
    call.on("error", reject);
    call.end(options.body);
  });
}

test("web workbench reads audited tasks and archived file changes", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-web-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  await fs.cp(path.join(repository, "examples/demo-app/src"), path.join(root, "src"), { recursive: true });
  await fs.cp(path.join(repository, "examples/demo-app/test"), path.join(root, "test"), { recursive: true });
  const configFile = path.join(temporary, "config.json");
  await fs.writeFile(configFile, JSON.stringify({
    schemaVersion: 2, mode: "local", piExecutable: path.join(repository, "test/fake-pi.mjs"),
    provider: "fake", model: "fake-model", allowedPaths: ["src", "test"], excludedPaths: [".env"],
    environment: { pi: [], checks: [], localDeployment: [] },
    maxSnapshotBytes: 1000000, maxPiMs: 30000, maxToolCalls: 20, maxEventBytes: 1000000, maxCostUsd: 2,
    checks: [[process.execPath, "--test", "test/calculator.test.mjs"]],
    testDeployment: { kind: "local", command: [process.execPath, "--test", "test/calculator.test.mjs"] },
    productionDeployment: { kind: "none" },
  }));
  await initialize(root, configFile);
  const project = await loadProject(root);
  await addCredential(project, "product", ["product"], { username: "product", password: "password123456", token: "product-token-0123456789-abcdefghijklmnop" });
  await addCredential(project, "other-product", ["product"], { username: "other-product", password: "password123456", token: "other-product-token-0123456789-abcdefghijk" });
  await addCredential(project, "reviewer", ["developer"], { username: "reviewer", password: "password123456", token: "reviewer-token-0123456789-abcdefghijklmn" });
  await addCredential(project, "other-reviewer", ["developer"], { username: "other-reviewer", password: "password123456", token: "other-reviewer-token-0123456789-abcdefghij" });
  await addCredential(project, "admin", ["admin"], { username: "admin", password: "password123456", token: "admin-token-0123456789-abcdefghijklmnopqr" });
  await createTask(project, "REQ-001", "Add multiplication", "Add multiply(left, right).", "product");
  await assignMember(root, "REQ-001", "product", "developer", "reviewer");
  await respondToAssignment(root, "REQ-001", "reviewer", "developer", true);
  await recordDevFeedback(root, "REQ-001", "reviewer", { summary: "Add multiplication", questions: [],
    requiredRoles: ["backend", "qa"] });
  const confirmed = await confirmContract(root, "REQ-001", "product", {
    objective: "Support multiplication", currentBehavior: "Addition only", desiredBehavior: "Multiply two values",
    acceptance: [{ id: "AC1", text: "2 times 3 is 6" }], inScope: ["src", "test"], outOfScope: [], answers: {},
  });
  for (const role of ["backend", "qa"]) await submitRoleReview(root, "REQ-001", role, {
    role, contractHash: confirmed.contractHash, coveredAcceptanceIds: ["AC1"],
    judgments: { objective: "agree", desiredBehavior: "agree", scope: "agree", acceptance: "agree" },
    interfaceDecisions: { calculator: "multiply returns product" }, blockers: [], evidence: `${role} reviewed`,
    ...(role === "qa" ? { testScenarios: [{ acceptanceId: "AC1", scenario: "Check product" }] } : {}),
  });
  await finalizeRoleReview(root, "REQ-001", "reviewer");
  await plan(root, "REQ-001");
  const { server, url } = await startWebServer(root, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(startWebServer(root, 0, { host: "0.0.0.0" }), /explicit public origins/);
  await assert.rejects(startWebServer(root, 0, { origins: ["https://example.com/path"] }), /exact HTTP/);
  const network = await startWebServer(root, 0, { host: "0.0.0.0", origins: ["https://reqflow.example"] });
  t.after(() => new Promise((resolve) => network.server.close(resolve)));
  const networkUrl = `http://127.0.0.1:${network.server.address().port}`;
  assert.equal((await fetch(`${networkUrl}/healthz`)).status, 403);
  assert.equal((await networkRequest(`${networkUrl}/healthz`, { headers: { Host: "reqflow.example" } })).status, 200);
  const networkLogin = { method: "POST", headers: { Host: "reqflow.example", Origin: "https://reqflow.example",
    "Content-Type": "application/json" }, body: JSON.stringify({ token: "reviewer-token-0123456789-abcdefghijklmn" }) };
  const secureLogin = await networkRequest(`${networkUrl}/api/login`, networkLogin);
  assert.equal(secureLogin.status, 200);
  assert.match(secureLogin.headers["set-cookie"][0], /; Secure/);
  assert.equal((await networkRequest(`${networkUrl}/api/login`, { ...networkLogin,
    headers: { ...networkLogin.headers, Origin: "https://attacker.example" } })).status, 403);
  assert.equal((await fetch(`${url}/api/overview`)).status, 401);
  const login = await fetch(`${url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "reviewer-token-0123456789-abcdefghijklmn" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const session = await (await fetch(`${url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  assert.equal(session.principal.id, "reviewer");
  assert.equal(session.actions.includes("approve-plan"), true);
  assert.equal(session.actions.includes("implement"), true);
  const overview = await (await fetch(`${url}/api/overview`, { headers: { Cookie: cookie } })).json();
  assert.equal(overview.total, 1);
  assert.equal(overview.counts.review, 1);
  const detail = await (await fetch(`${url}/api/tasks/REQ-001`, { headers: { Cookie: cookie } })).json();
  assert.match(detail.plan, /## 需求与验收/);
  assert.equal(detail.events[0].type, "plan_created");

  const rejected = await fetch(`${url}/api/tasks/REQ-001/actions`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ action: "approve-plan", actor: "tester" }),
  });
  assert.equal(rejected.status, 403);
  await approvePlan(root, "REQ-001", "reviewer");
  await implement(root, "REQ-001");
  await verify(root, "REQ-001");
  const invalidStream = await fetch(`${url}/api/tasks/REQ-001/actions`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: cookie, "X-Reqflow-Token": session.token },
    body: JSON.stringify({ action: "approve-changes", evidence: "" }),
  });
  assert.match(invalidStream.headers.get("content-type"), /text\/event-stream/);
  const failedFrames = await invalidStream.text();
  assert.match(failedFrames, /event: progress/); assert.match(failedFrames, /event: error/);
  assert.doesNotMatch(failedFrames, /event: result/);
  const approvedChanges = await fetch(`${url}/api/tasks/REQ-001/actions`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: cookie, "X-Reqflow-Token": session.token },
    body: JSON.stringify({ action: "approve-changes", evidence: "Reviewed changed files and existing calculator behavior." }),
  });
  assert.equal(approvedChanges.status, 200);
  assert.match(await approvedChanges.text(), /event: result/);
  assert.equal((await readTask(project, "REQ-001")).meta.changeApproval.actor, "reviewer");
  const changes = await (await fetch(`${url}/api/tasks/REQ-001`, { headers: { Cookie: cookie } })).json();
  assert.equal(changes.changes.changes.length, 2);
  const file = changes.changes.changes[0].file;
  const response = await fetch(`${url}/api/tasks/REQ-001/files?path=${encodeURIComponent(file)}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.file, file);
  assert.notEqual(snapshot.before?.text, snapshot.after?.text);
  assert.equal((await (await fetch(`${url}/api/overview`, { headers: { Cookie: cookie } })).json()).counts.active, 1);
  const unauthorizedCreate = await fetch(`${url}/api/tasks`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Reqflow-Token": session.token },
    body: JSON.stringify({ id: "1", title: "Second requirement", request: "Preserve addition" }) });
  assert.equal(unauthorizedCreate.status, 403);
  const productLogin = await fetch(`${url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "product-token-0123456789-abcdefghijklmnop" }) });
  const productCookie = productLogin.headers.get("set-cookie").split(";")[0];
  const productSession = await (await fetch(`${url}/api/bootstrap`, { headers: { Cookie: productCookie } })).json();
  const members = await (await fetch(`${url}/api/members`, { headers: { Cookie: productCookie } })).json();
  assert.deepEqual(members.members.find(member => member.id === "reviewer"),
    { id: "reviewer", username: "reviewer", roles: ["developer"] });
  const forbiddenStream = await fetch(`${url}/api/tasks/REQ-001/actions`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: productCookie, "X-Reqflow-Token": productSession.token },
    body: JSON.stringify({ action: "approve-changes", evidence: "Unauthorized" }),
  });
  assert.equal(forbiddenStream.status, 403);
  assert.match(forbiddenStream.headers.get("content-type"), /application\/json/);
  const create = await fetch(`${url}/api/tasks`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: productCookie, "X-Reqflow-Token": productSession.token },
    body: JSON.stringify({ id: "1", title: "Preserve addition", request: "Keep addition unchanged" }) });
  assert.equal(create.status, 201);
  const createdTask = await create.json();
  assert.equal(createdTask.createdBy, "product"); assert.equal(createdTask.id, "1");
  const createdDetail = await fetch(`${url}/api/tasks/1`, { headers: { Cookie: productCookie } });
  assert.equal(createdDetail.status, 200);
  assert.equal((await createdDetail.json()).meta.id, "1");
  assert.equal((await fetch(`${url}/api/tasks/1/lifecycle`, { headers: { Cookie: productCookie } })).status, 200);
  const assigned = await fetch(`${url}/api/tasks/1/actions`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: productCookie, "X-Reqflow-Token": productSession.token },
    body: JSON.stringify({ action: "assign-member", role: "developer", member: "reviewer" }) });
  assert.equal(assigned.status, 200);
  const acceptedAssignment = await fetch(`${url}/api/tasks/1/actions`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Reqflow-Token": session.token },
    body: JSON.stringify({ action: "accept-assignment", role: "developer" }) });
  assert.equal(acceptedAssignment.status, 200);
  const feedbackAction = await fetch(`${url}/api/tasks/1/actions`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Reqflow-Token": session.token },
    body: JSON.stringify({ action: "dev-feedback", feedback: { summary: "Review addition behavior", questions: [],
      requiredRoles: ["backend", "qa"] } }) });
  assert.equal(feedbackAction.status, 200);
  const contractAction = await fetch(`${url}/api/tasks/1/actions`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: productCookie, "X-Reqflow-Token": productSession.token },
    body: JSON.stringify({ action: "confirm-contract", contract: { objective: "Preserve addition", currentBehavior: "Addition works",
      desiredBehavior: "Addition stays working", acceptance: [{ id: "AC1", text: "add(2,3) is 5" }],
      inScope: ["src/calculator.mjs"], outOfScope: [], answers: {} } }) });
  assert.equal(contractAction.status, 200);
  assert.equal((await contractAction.json()).state, "contract_confirmed");
  const automaticDevelopment = await fetch(`${url}/api/tasks/1/actions`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Reqflow-Token": session.token },
    body: JSON.stringify({ action: "develop", authorizeImplementation: true }) });
  assert.equal(automaticDevelopment.status, 200);
  const developmentResult = await automaticDevelopment.json();
  assert.equal(developmentResult.state, "plan_review");
  assert.equal(developmentResult.next, "approve-plan");
  assert.equal((await readTask(project, "1")).meta.workspace, undefined);
  const confirmedDevelopment = await fetch(`${url}/api/tasks/1/actions`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Reqflow-Token": session.token },
    body: JSON.stringify({ action: "approve-plan" }) });
  assert.equal(confirmedDevelopment.status, 200);
  assert.equal((await confirmedDevelopment.json()).state, "verified");
  const automatedTask = await readTask(project, "1");
  assert.equal(Boolean(automatedTask.meta.changeApproval), false);
  assert.equal(Boolean(automatedTask.meta.testDeployment), false);
  assert.equal(automatedTask.events.find(event => event.type === "plan_approved").detail.approvalKind, "human");
  const chosenDeployment = await fetch(`${url}/api/tasks/1/actions`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Reqflow-Token": session.token },
    body: JSON.stringify({ action: "deploy-test" }) });
  assert.equal(chosenDeployment.status, 200, await chosenDeployment.clone().text());
  assert.equal((await chosenDeployment.json()).state, "test_deployed");
  const productAcceptance = await fetch(`${url}/api/tasks/1/actions`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: productCookie, "X-Reqflow-Token": productSession.token },
    body: JSON.stringify({ action: "accept-test", acceptanceMode: "deployed", expectedAfterHash: automatedTask.meta.afterHash,
      expectedPlanHash: automatedTask.meta.planHash, acceptanceResults: [{acceptanceId:"AC1",conclusion:"测试环境乘法正确，原加法保持不变"}],
      evidence: "Product verified the frozen acceptance criteria in the test environment." }) });
  assert.equal(productAcceptance.status, 200);
  assert.equal((await productAcceptance.json()).state, "archived_test_only");
  const otherLogin = await fetch(`${url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "other-product-token-0123456789-abcdefghijk" }) });
  const otherCookie = otherLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await (await fetch(`${url}/api/overview`, { headers: { Cookie: otherCookie } })).json()).total, 0);
  assert.equal((await fetch(`${url}/api/tasks/REQ-001`, { headers: { Cookie: otherCookie } })).status, 403);
  assert.equal((await fetch(`${url}/api/tasks/REQ-001/files?path=${encodeURIComponent(file)}`,
    { headers: { Cookie: otherCookie } })).status, 403);
  const otherReviewerLogin = await fetch(`${url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "other-reviewer-token-0123456789-abcdefghij" }) });
  const otherReviewerCookie = otherReviewerLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await (await fetch(`${url}/api/overview`, { headers: { Cookie: otherReviewerCookie } })).json()).total, 0);
  assert.equal((await fetch(`${url}/api/tasks/1`, { headers: { Cookie: otherReviewerCookie } })).status, 403);
  const adminLogin = await fetch(`${url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "admin-token-0123456789-abcdefghijklmnopqr" }) });
  const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${url}/api/admin/tasks/1/observability`, { headers: { Cookie: adminCookie } })).status, 200);
  const adminOverview = await (await fetch(`${url}/api/overview`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(adminOverview.total, 2);
  const audit = await (await fetch(`${url}/api/admin/report?limit=1`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(audit.total, 2);
  assert.equal(audit.requirements.length, 1);
  assert.equal(audit.summary.total, 2);
  assert.equal(audit.projectTotal, 2);
  assert.match(audit.requirements[0].auditHead, /^[a-f0-9]{64}$/);
  const history = await (await fetch(`${url}/api/admin/tasks/1/history`, { headers: { Cookie: adminCookie } })).json();
  assert.deepEqual(history.events.map((event) => event.type).slice(0, 3),
    ["intake_draft", "member_assigned", "assignment_accepted"]);
  const authHistory = await (await fetch(`${url}/api/admin/auth-history`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(authHistory.total, 5);
  assert.equal((await fetch(`${url}/api/admin/report`, { headers: { Cookie: otherCookie } })).status, 403);
  const lifecycleUrl = `${url}/api/tasks/REQ-001/lifecycle?limit=1`;
  assert.equal((await fetch(lifecycleUrl, { headers: { Cookie: productCookie } })).status, 200);
  const lifecycle = await (await fetch(lifecycleUrl, { headers: { Cookie: cookie } })).json();
  assert.equal(lifecycle.events.length, 1);
  assert.equal(lifecycle.responsibilities.planReviewer, "reviewer");
  assert.equal((await fetch(lifecycleUrl, { headers: { Cookie: otherReviewerCookie } })).status, 403);
  assert.equal((await fetch(`${url}/api/admin/tasks/REQ-001/observability`, { headers: { Cookie: productCookie } })).status, 403);
  assert.equal((await fetch(`${url}/api/admin/tasks/REQ-001/observability`, { headers: { Cookie: adminCookie } })).status, 200);
  const adminSession = await (await fetch(`${url}/api/bootstrap`, { headers: { Cookie: adminCookie } })).json();
  const addUser = await fetch(`${url}/api/admin/users`, { method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json", "X-Reqflow-Token": adminSession.token },
    body: JSON.stringify({ id: "new-member", username: "new-member", roles: ["developer"], password: "preview-only-password" }) });
  assert.equal(addUser.status, 201);
  const identityEvents = await (await fetch(`${url}/api/admin/auth-history`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(identityEvents.events.at(-1).detail.initiatedBy, "admin");
  assert.equal(identityEvents.events.at(-1).detail.action, "auth-add");
  assert.equal(JSON.stringify(identityEvents).includes("preview-only-password"), false);
  await createTask(project, "STREAM-1", "Add multiplication", "Add multiplication and preserve addition.", "product");
  const streamedAnalysis = await fetch(`${url}/api/tasks/STREAM-1/actions`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: productCookie, "X-Reqflow-Token": productSession.token },
    body: JSON.stringify({ action: "analyze-intake" }),
  });
  const analysisFrames = await streamedAnalysis.text();
  assert.match(analysisFrames, /event: progress/); assert.match(analysisFrames, /我理解你希望扩展计算能力/);
  assert.match(analysisFrames, /需求反馈已核对并保存/); assert.match(analysisFrames, /event: result/);
  assert.doesNotMatch(analysisFrames, /event: error/);
  assert.equal((await readTask(project, "STREAM-1")).meta.state, "intake_clarifying");
  await createTask(project, "STREAM-2", "Disconnect test", "Preserve addition and add multiplication.", "product");
  const disconnected = await fetch(`${url}/api/tasks/STREAM-2/actions`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: productCookie, "X-Reqflow-Token": productSession.token },
    body: JSON.stringify({ action: "analyze-intake" }),
  });
  const disconnectedReader = disconnected.body.getReader();
  await disconnectedReader.read(); await disconnectedReader.cancel();
  const deadline = Date.now() + 3000;
  while ((await readTask(project, "STREAM-2")).meta.state !== "intake_clarifying" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal((await readTask(project, "STREAM-2")).meta.state, "intake_clarifying", "disconnect must not abandon the audited task");
  await revokeCredential(project, "reviewer");
  assert.equal((await fetch(`${url}/api/overview`, { headers: { Cookie: cookie } })).status, 401);
  assert.match(await fs.readFile(path.join(project.archive, "auth-events.jsonl"), "utf8"), /credential_revoked/);
});

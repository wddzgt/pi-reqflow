import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequirement, executeRequirementAction, getRequirementEvidence, getRequirementImage, getTaskObservability } from "../src/core.js";
import { initialize, readTask } from "../src/store.js";
import { loadProject } from "../src/config.js";
import { addCredential } from "../src/auth.js";
import { startWebServer } from "../src/web-server.js";
import { createServer } from "node:http";
import { runPi } from "../src/pi-runner.js";
import { admissionDefaults } from "../src/admission.js";
import { readDiscussionEvidence } from "../src/history.js";
import { analysisInput } from "../src/intake-conversation.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const product = { id: "product", roles: ["product"] };
const other = { id: "other", roles: ["product"] };
const developer = { id: "developer", roles: ["developer"] };
const image = { name: "设计图.png", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQKt8NAAITAVXMpdPnAAAAAElFTkSuQmCC" };

test("ready intake preserves all acceptance scenarios beyond the planning estimate", () => {
  const value = { schemaVersion: 1, inputHash: "current", status: "ready", reply: "核对完成", summary: "批量状态更新",
    suggestions: [], questions: [], requiredRoles: ["backend", "qa"], contract: {
      objective: "批量状态更新", currentBehavior: "只能单条更新", desiredBehavior: "当前页整批更新并保留筛选",
      acceptance: Array.from({ length: 9 }, (_, index) => ({ id: `AC${index + 1}`, text: `验收场景${index + 1}` })),
      inScope: ["批量状态更新"], outOfScope: ["跨页选择"], answers: {} } };
  assert.equal(analysisInput(value, "current", []).status, "ready");
  assert.equal(value.contract.acceptance.length, 9, "never merge or discard valid scenarios to fit a count");
  assert.throws(() => analysisInput({ ...value, inputHash: "old" }, "current", []), /current discussion version/);
});

async function fixture(t, overrides = {}, inventoryOnly = false, files = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-discussion-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  await fs.cp(path.join(repository, "examples/demo-app/src"), path.join(root, "src"), { recursive: true });
  await fs.cp(path.join(repository, "examples/demo-app/test"), path.join(root, "test"), { recursive: true });
  const config = JSON.parse(await fs.readFile(path.join(repository, "examples/config.local.json"), "utf8"));
  Object.assign(config, { piExecutable: path.join(repository, "test/fake-pi.mjs"), provider: "fake", model: "fake",
    checks: [[process.execPath, "--test", "test/calculator.test.mjs"]], ...overrides });
  const configFile = path.join(temporary, "config.json");
  await fs.writeFile(configFile, JSON.stringify(config));
  await initialize(root, configFile, { inventoryOnly });
  const project = await loadProject(root);
  await addCredential(project, "developer", ["developer"], { username: "developer", password: "password-12345" });
  return { root, project, temporary };
}

const action = async (root, body, principal = product) => {
  if (body.action === "confirm-contract" && body.expectedAnalysisHash === undefined) {
    const { meta } = await readTask(await loadProject(root), "REQ-CHAT");
    body = { ...body, expectedAnalysisHash: meta.intakeAnalysisHash };
  }
  return executeRequirementAction(root, "REQ-CHAT", body, principal);
};

test("new product intake indexes lengthy project rules instead of loading their full text", async t => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-intake-context-"));
  t.after(() => fs.rm(models, { recursive: true, force: true }));
  const executable = path.join(models, "pi.mjs");
  await fs.writeFile(executable, `import assert from 'node:assert/strict';
if (process.env.REQFLOW_PHASE === 'intake') {
  const prompt = process.argv.at(-1);
  const guide = JSON.parse(prompt.match(/^项目参考：(.*)$/m)[1]);
  assert.ok(guide.ruleFiles.includes('CLAUDE.md'));
  assert.equal(guide.projectRules, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(guide)) < 3000);
  assert.ok(Buffer.byteLength(prompt) < 10000);
  assert.ok(!prompt.includes('UNRELATED_IMPLEMENTATION_RULE'));
}
await import(${JSON.stringify(path.join(repository, "test/fake-pi.mjs"))});`);
  const rules = "# Project rules\n" + "UNRELATED_IMPLEMENTATION_RULE: Preserve coding conventions.\n".repeat(400);
  const { root, project } = await fixture(t, { piExecutable: executable, allowedPaths: ["."] }, false, { "CLAUDE.md": rules });
  await createRequirement(root, product, { id: "REQ-CHAT", title: "扩展计算器", request: "新增乘法，保留加法。" });
  assert.equal((await action(root, { action: "analyze-intake" })).state, "intake_clarifying");
  assert.equal(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), rules);
  const observed = await getTaskObservability(root, product, "REQ-CHAT");
  assert.ok(observed.runs.find(run => run.telemetry.phase === "intake").telemetry.promptBytes < 10000);
  assert.equal((await readTask(project, "REQ-CHAT")).events.filter(event => event.type === "intake_analysis_completed").length, 1);
});

test("product clarification cannot restart an exhausted token budget while cached feedback stays free", async (t) => {
  const { root, project } = await fixture(t, { admission: { ...admissionDefaults, budgetMode: "strict", maxTotalTokens: 175 } });
  await createRequirement(root, product, { id: "REQ-CHAT", title: "扩展计算器", request: "希望扩展计算能力。" });
  const first = await action(root, { action: "analyze-intake" });
  assert.equal(first.intakeAnalysisAttempts, 1);
  assert.equal((await action(root, { action: "analyze-intake" })).intakeAnalysisAttempts, 1);
  await action(root, { action: "intake-message", message: { text: "新增乘法，2×3为6，现有加法不变。" } });
  await assert.rejects(action(root, { action: "analyze-intake" }), /budget exhausted/);
  const task = await readTask(project, "REQ-CHAT");
  assert.equal(task.meta.intakeAnalysisAttempts, 1);
  assert.equal(task.events.at(-1).type, "intake_budget_exhausted");
  await assert.rejects(fs.stat(path.join(task.directory, "intake-attempt-2.events.jsonl")), { code: "ENOENT" });
});

test("AI product alignment preserves originals, image inputs and every round before developer handoff", async (t) => {
  const { root, project } = await fixture(t);
  await createRequirement(root, product, { id: "REQ-CHAT", title: "扩展计算器", request: "希望扩展计算能力，请参考截图。", images: [image] });
  await assert.rejects(action(root, { action: "analyze-intake" }, other), /not assigned/);
  const first = await action(root, { action: "analyze-intake" });
  assert.equal(first.state, "intake_clarifying");
  await assert.rejects(action(root, { action: "confirm-contract", contract: {} }), /expected reviewed intake/);
  await action(root, { action: "intake-message", message: { text: "新增乘法，2×3为6，现有加法不变。", images: [image] } });
  const ready = await action(root, { action: "analyze-intake" });
  assert.equal(ready.state, "intake_ready");
  assert.equal(ready.intakeCostUsd, 0.06);
  assert.equal((await action(root, { action: "analyze-intake" })).intakeAnalysisAttempts, 2);
  const evidence = await getRequirementEvidence(root, product, "REQ-CHAT");
  const candidate = evidence.discussion.latestAnalysis.analysis.contract;
  assert.deepEqual(candidate.answers, {});
  assert.ok(candidate.inScope.every((item) => !item.includes(".mjs")));
  await assert.rejects(action(root, { action: "intake-message", message: { text: "核对范围。",
    candidate: { ...candidate, inScope: ["src/calculator.mjs"] } } }), /Product requirement must describe business behavior/);
  await assert.rejects(action(root, { action: "intake-message", message: { text: "核对验收。",
    candidate: { ...candidate, acceptance: [{ ...candidate.acceptance[0], implementation: "hidden technical instructions" }] } } }), /exclude discussion answers or technical fields/);
  await assert.rejects(action(root, { action: "confirm-contract", contract: candidate, expectedAnalysisHash: "stale" }), /reviewed version/);
  await assert.rejects(action(root, { action: "confirm-contract", contract: { ...candidate, desiredBehavior: "Change add too" } }), /save it as a message candidate/);
  const descriptor = evidence.discussion.messages[0].attachments[0];
  assert.deepEqual((await getRequirementImage(root, product, "REQ-CHAT", descriptor.id)).buffer, Buffer.from(image.data, "base64"));
  await assert.rejects(getRequirementImage(root, other, "REQ-CHAT", descriptor.id), /cannot read/);
  const log = await fs.readFile(path.join(project.archive, "tasks/REQ-CHAT/intake-attempt-2.events.jsonl"), "utf8");
  assert.match(log, /image_reference/); assert.doesNotMatch(log, new RegExp(image.data.slice(0, 32)));
  const confirmed = await action(root, { action: "confirm-contract", contract: candidate });
  assert.equal(confirmed.state, "contract_confirmed");
  await assert.rejects(action(root, { action: "run-review", role: "backend" }, developer), /not assigned/);
  await action(root, { action: "assign-member", role: "developer", member: "developer" });
  assert.equal((await action(root, { action: "accept-assignment", role: "developer" }, developer)).state, "contract_confirmed");
  await action(root, { action: "run-review", role: "backend" }, developer);
  await action(root, { action: "run-review", role: "qa" }, developer);
  assert.equal((await action(root, { action: "finalize-review" }, developer)).state, "review_passed");
  assert.deepEqual((await readTask(project, "REQ-CHAT")).meta.developmentFiles, ["src/calculator.mjs", "test/calculator.test.mjs"]);
  assert.equal((await action(root, { action: "plan" }, developer)).state, "plan_review");
  const history = await readTask(project, "REQ-CHAT");
  const planned = history.events.findLast((event) => event.type === "plan_created");
  assert.equal(planned.detail.actor, "system:workflow");
  assert.equal(planned.detail.initiatedBy, "developer");
  assert.equal(planned.detail.action, "plan");
  assert.equal(history.events.filter((event) => event.type === "intake_analysis_completed").length, 2);
  assert.ok(history.events.find((event) => event.type === "contract_confirmed").detail.agreement.analysisHash);
  assert.equal(await fs.readFile(path.join(history.directory, "request.md"), "utf8"), "希望扩展计算能力，请参考截图。");
});

test("development receives only the frozen business requirement while conversations remain available", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-handoff-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, "pi.mjs");
  const fake = await fs.readFile(path.join(repository, "test/fake-pi.mjs"), "utf8");
  await fs.writeFile(executable, fake.replace('const prompt = process.argv.at(-1);',
    'const prompt = process.argv.at(-1);\nif (["review", "plan"].includes(phase)) console.log(JSON.stringify({type:"message_end",message:{role:"user",content:[{type:"text",text:prompt}]}}));'));
  const { root, project } = await fixture(t, { piExecutable: executable });
  const original = "历史提议 HISTORY_ONLY_ORDER_CHANGE：改变原有订单的查看方式。";
  const reply = "撤销原提议 PRODUCT_REPLY_ONLY，旧订单保持可查看，仅新增乘法。";
  await createRequirement(root, product, { id: "REQ-CHAT", title: "最终业务需求", request: original });
  await action(root, { action: "analyze-intake" });
  await action(root, { action: "intake-message", message: { text: reply } });
  await action(root, { action: "analyze-intake" });
  const candidate = (await getRequirementEvidence(root, product, "REQ-CHAT")).discussion.latestAnalysis.analysis.contract;
  await action(root, { action: "confirm-contract", contract: candidate });
  await action(root, { action: "assign-member", role: "developer", member: "developer" });
  await action(root, { action: "accept-assignment", role: "developer" }, developer);
  await action(root, { action: "run-review", role: "backend" }, developer);
  await action(root, { action: "run-review", role: "qa" }, developer);
  await action(root, { action: "finalize-review" }, developer);
  await action(root, { action: "plan" }, developer);
  const task = await readTask(project, "REQ-CHAT");
  for (const name of ["role-backend-attempt-1.events.jsonl", "role-qa-attempt-1.events.jsonl", "plan-v1-attempt-1.events.jsonl"]) {
    const logs = (await fs.readFile(path.join(task.directory, name), "utf8")).trim().split("\n").map(JSON.parse);
    const prompt = logs.find((event) => event.message?.role === "user").message.content[0].text;
    assert.ok(prompt.includes(JSON.stringify(candidate)));
    assert.doesNotMatch(prompt, /HISTORY_ONLY_ORDER_CHANGE|PRODUCT_REPLY_ONLY|是否新增乘法/);
  }
  const evidence = await getRequirementEvidence(root, product, "REQ-CHAT");
  assert.equal(evidence.request, original);
  assert.ok(evidence.discussion.messages.some((message) => message.text === reply));
});

test("product context reuses the latest working candidate and omitted originals remain exactly retrievable", async t => {
  const capture = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-intake-context-"));
  t.after(() => fs.rm(capture, { recursive: true, force: true }));
  const executable = path.join(capture, "pi.mjs");
  const fake = await fs.readFile(path.join(repository, "test/fake-pi.mjs"), "utf8");
  await fs.writeFile(executable, fake.replace('const prompt = process.argv.at(-1);',
    `const prompt = process.argv.at(-1); if (phase === "intake") await fs.writeFile(${JSON.stringify(path.join(capture, "prompt.txt"))}, prompt);`));
  const { root, project } = await fixture(t, { piExecutable: executable });
  const original = "原始业务材料。".repeat(1500);
  const oldMessage = "新增乘法并保留加法。" + "已解决的详细讨论。".repeat(200) + "OMITTED_EXACT_END";
  await createRequirement(root, product, { id: "REQ-CHAT", title: "短期记忆", request: original });
  await action(root, { action: "analyze-intake" });
  await action(root, { action: "intake-message", message: { text: oldMessage } });
  await action(root, { action: "analyze-intake" });
  await action(root, { action: "intake-message", message: { text: "已确认共识不变，请核对验收。" } });
  await action(root, { action: "analyze-intake" });
  const prompt = await fs.readFile(path.join(capture, "prompt.txt"), "utf8");
  const context = JSON.parse(prompt.match(/^沟通输入：(.*)$/m)[1]);
  assert.equal(context.originalRequest.partial, true);
  assert.equal(context.workingCandidate.objective, "计算器支持乘法");
  assert.equal(context.history.filter(row => row.role === "ai_developer").length, 1);
  assert.equal(prompt.includes("OMITTED_EXACT_END"), false);
  const task = await readTask(project, "REQ-CHAT");
  const oldEvent = task.events.find(event => event.type === "intake_message" && event.detail.text === oldMessage);
  assert.equal(context.earlierDiscussion[0].eventHash, oldEvent.hash);
  const raw = JSON.stringify({ text: oldMessage, candidate: oldEvent.detail.candidate });
  const fragment = await readDiscussionEvidence(project, "REQ-CHAT", { eventHash: oldEvent.hash, offset: raw.indexOf("OMITTED_EXACT_END"), maxChars: 40 });
  assert.match(fragment.text, /^OMITTED_EXACT_END/);
  await assert.rejects(readDiscussionEvidence(project, "REQ-CHAT", { eventHash: task.events.at(-1).hash, offset: 0, maxChars: 20 }), /human message/);
  assert.equal(await fs.readFile(path.join(task.directory, "request.md"), "utf8"), original);
});

test("technical suggestions are rejected instead of being presented as product questions", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-product-language-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, "pi.mjs");
  const fake = await fs.readFile(path.join(repository, "test/fake-pi.mjs"), "utf8");
  await fs.writeFile(executable, fake.replace("保留加法回归测试，并覆盖新乘法验收场景。", "请修改 src/calculator.mjs 并新增 POST /multiply 接口。"));
  const { root, project } = await fixture(t, { piExecutable: executable });
  await createRequirement(root, product, { id: "REQ-CHAT", title: "业务沟通", request: "增加乘法" });
  await assert.rejects(action(root, { action: "analyze-intake" }), /communication must explain business behavior/);
  const task = await readTask(project, "REQ-CHAT");
  assert.equal(task.meta.state, "intake_clarifying");
  assert.equal(task.meta.intakeCostUsd, 0.03);
  assert.equal(task.events.at(-1).type, "intake_analysis_failed");
  assert.equal((await getRequirementEvidence(root, product, "REQ-CHAT")).discussion.latestAnalysis, null);
  assert.match(await fs.readFile(path.join(task.directory, "intake-attempt-1.events.jsonl"), "utf8"), /POST \/multiply/);
});

test("business-only requirements retain accountable fast-path file boundaries and approvals", async (t) => {
  const { root, project } = await fixture(t, { testDeployment: { kind: "local", command: [process.execPath, "--test", "test/calculator.test.mjs"] },
    fastPath: { enabled: true, maxFiles: 2, maxAcceptance: 2,
    maxChangedBytes: 10000, allowedPaths: ["src", "test"] } });
  await createRequirement(root, product, { id: "REQ-CHAT", title: "支持乘法", request: "增加乘法，原有加法不变" });
  const candidate = { objective: "Add multiplication", currentBehavior: "当前只支持两个数相加",
    desiredBehavior: "支持两个数相乘，已有数字相加的结果不变",
    acceptance: [{ id: "AC1", text: "输入2和3相乘得到6，原有相加仍得到5" }],
    inScope: ["两个数相乘", "原有加法结果保持不变"], outOfScope: [], answers: {} };
  await action(root, { action: "intake-message", message: { text: "最终目标和验收如下。", candidate } });
  await action(root, { action: "analyze-intake" });
  await action(root, { action: "confirm-contract", contract: candidate });
  await action(root, { action: "assign-member", role: "developer", member: "developer" });
  await action(root, { action: "accept-assignment", role: "developer" }, developer);
  assert.equal((await action(root, { action: "fast-track" }, developer)).next, "approve-plan");
  assert.deepEqual((await readTask(project, "REQ-CHAT")).meta.developmentFiles, ["src/calculator.mjs", "test/calculator.test.mjs"]);
  await action(root, { action: "approve-plan" }, developer);
  assert.equal((await action(root, { action: "fast-track" }, developer)).next, "choose-validation");
  assert.equal((await readTask(project, "REQ-CHAT")).meta.changeApproval, undefined);
});

test("candidate edits require fresh AI agreement and frozen revisions invalidate old role reviews", async (t) => {
  const { root, project } = await fixture(t);
  await createRequirement(root, product, { id: "REQ-CHAT", title: "Multiply", request: "Add multiplication" });
  await action(root, { action: "intake-message", message: { text: "现有加法不变；新增乘法，2×3为6。" } });
  await action(root, { action: "analyze-intake" });
  const original = (await getRequirementEvidence(root, product, "REQ-CHAT")).discussion.latestAnalysis.analysis.contract;
  const candidate = { ...original, objective: "Expand multiplication while preserving addition" };
  await action(root, { action: "intake-message", message: { text: "调整目标描述，其他条件不变。", candidate } });
  await assert.rejects(action(root, { action: "confirm-contract", contract: original }), /expected reviewed intake/);
  await action(root, { action: "analyze-intake" });
  await action(root, { action: "confirm-contract", contract: candidate });
  await action(root, { action: "assign-member", role: "developer", member: "developer" });
  await action(root, { action: "accept-assignment", role: "developer" }, developer);
  await action(root, { action: "run-review", role: "backend" }, developer);
  const revised = { ...candidate, acceptance: [{ id: "AC1", text: "Multiply zero and positive values; preserve addition" }] };
  assert.equal((await action(root, { action: "revise-contract", contract: revised })).state, "intake_clarifying");
  assert.deepEqual((await readTask(project, "REQ-CHAT")).meta.reviewHashes, {});
  await assert.rejects(action(root, { action: "run-review", role: "qa" }, developer), /expected contract_confirmed/);
  await action(root, { action: "analyze-intake" });
  assert.equal((await action(root, { action: "confirm-contract", contract: revised })).contractVersion, 2);
  const task = await readTask(project, "REQ-CHAT");
  assert.equal(JSON.parse(await fs.readFile(path.join(task.directory, "contract-v1.json"), "utf8")).objective, candidate.objective);
  await fs.appendFile(path.join(task.directory, "intake-attempt-1.events.jsonl"), "tamper");
  await assert.rejects(readTask(project, "REQ-CHAT"), /audit log changed/);
});

test("a later natural reply can revise an earlier explicitly edited candidate", async (t) => {
  const { root } = await fixture(t);
  await createRequirement(root, product, { id: "REQ-CHAT", title: "Reconsider candidate", request: "增加乘法" });
  await action(root, { action: "intake-message", message: { text: "增加乘法，保留加法。" } });
  await action(root, { action: "analyze-intake" });
  const candidate = { ...(await getRequirementEvidence(root, product, "REQ-CHAT")).discussion.latestAnalysis.analysis.contract,
    objective: "Earlier product wording" };
  await action(root, { action: "intake-message", message: { text: "先采用这个候选。", candidate } });
  await action(root, { action: "analyze-intake" });
  await action(root, { action: "intake-message", message: { text: "请重新整理目标，不再固定上一版措辞。" } });
  await action(root, { action: "analyze-intake" });
  const evidence = await getRequirementEvidence(root, product, "REQ-CHAT");
  assert.notEqual(evidence.discussion.latestAnalysis.analysis.contract.objective, candidate.objective);
  assert.equal(evidence.discussion.messages.find((row) => row.candidate).candidate.objective, candidate.objective);
});

test("rewritten product candidates fail explicitly and transformed model images remain audited", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-malformed-model-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, "pi.mjs");
  const fake = await fs.readFile(path.join(repository, "test/fake-pi.mjs"), "utf8");
  await fs.writeFile(executable, fake.replace('  intake = { schemaVersion:',
    '  if (context.candidate) contract.objective = "Unapproved replacement";\n  intake = { schemaVersion:')
    .replace('const data = (await fs.readFile(file.slice(1))).toString("base64");',
      'const data = Buffer.concat([await fs.readFile(file.slice(1)), Buffer.from("converted")]).toString("base64");'));
  const { root, project } = await fixture(t, { piExecutable: executable });
  await createRequirement(root, product, { id: "REQ-CHAT", title: "Model audit", request: "扩展计算器", images: [image] });
  await action(root, { action: "intake-message", message: { text: "增加乘法，保留加法。" } });
  await action(root, { action: "analyze-intake" });
  const candidate = (await getRequirementEvidence(root, product, "REQ-CHAT")).discussion.latestAnalysis.analysis.contract;
  await action(root, { action: "intake-message", message: { text: "核对候选。", candidate } });
  await assert.rejects(action(root, { action: "analyze-intake" }), /changed the latest product-edited candidate/);
  const task = await readTask(project, "REQ-CHAT");
  assert.equal(task.meta.state, "intake_clarifying");
  assert.equal(task.meta.intakeCostUsd, 0.06);
  const artifact = task.events.at(-1).detail.artifacts.find((row) => row.file.includes(".images/"));
  assert.ok(artifact);
  await fs.appendFile(path.join(task.directory, artifact.file), "tampered");
  await assert.rejects(readTask(project, "REQ-CHAT"), /audit log changed/);
});

test("withdrawing an image changes model inputs but preserves its original audited bytes", async (t) => {
  const { root, project } = await fixture(t);
  await createRequirement(root, product, { id: "REQ-CHAT", title: "Image correction", request: "扩展计算器", images: [image] });
  await action(root, { action: "analyze-intake" });
  const original = (await getRequirementEvidence(root, product, "REQ-CHAT")).discussion.messages[0].attachments[0];
  await assert.rejects(action(root, { action: "intake-message", message: { text: "撤回", withdrawnImageIds: ["unknown"] } }), /must belong/);
  await action(root, { action: "intake-message", message: { text: "原截图不再作为实现依据，仅增加乘法，保留加法。", withdrawnImageIds: [original.id] } });
  await action(root, { action: "analyze-intake" });
  const evidence = await getRequirementEvidence(root, product, "REQ-CHAT");
  assert.deepEqual(evidence.discussion.withdrawnImageIds, [original.id]);
  assert.deepEqual((await getRequirementImage(root, product, "REQ-CHAT", original.id)).buffer, Buffer.from(image.data, "base64"));
  const task = await readTask(project, "REQ-CHAT");
  assert.deepEqual(task.events.at(-1).detail.telemetry.imageInputs, []);
  assert.equal(task.events.filter((event) => event.type === "intake_message").length, 1);
});

test("failed multimodal analysis stays auditable, consumes budget and preserves submitted product input", async (t) => {
  const { root, project } = await fixture(t, { maxCostUsd: 0.02 });
  await assert.rejects(createRequirement(root, product, { id: "BAD-IMAGE", title: "Bad", request: "Bad", images: [{ ...image, mimeType: "image/jpeg" }] }), /supported PNG\/JPEG header/);
  await assert.rejects(fs.stat(path.join(project.archive, "tasks/BAD-IMAGE")), { code: "ENOENT" });
  await createRequirement(root, product, { id: "REQ-CHAT", title: "Multiply", request: "Preserve original request", images: [image] });
  await assert.rejects(action(root, { action: "analyze-intake" }), /remaining cost cap/);
  const task = await readTask(project, "REQ-CHAT");
  assert.equal(task.meta.state, "intake_clarifying");
  assert.equal(task.meta.intakeCostUsd, 0.03);
  assert.equal(task.events.at(-1).type, "intake_analysis_failed");
  assert.equal(task.events.at(-1).detail.artifacts.length, 1);
  await assert.rejects(action(root, { action: "analyze-intake" }), /budget exhausted/);
  const observed = await getTaskObservability(root, product, "REQ-CHAT");
  assert.equal(observed.summary.failedAttempts, 1); assert.equal(observed.summary.costUsd, 0.03);
  const descriptor = task.events[0].detail.attachments[0];
  await fs.appendFile(path.join(task.directory, descriptor.file), "changed");
  await assert.rejects(getRequirementEvidence(root, product, "REQ-CHAT"), /image size or type changed/);
});

test("web discussion accepts image messages, enforces ownership and exposes audited evidence", async (t) => {
  const { root, project } = await fixture(t);
  for (const owner of [product, other]) await addCredential(project, owner.id, owner.roles, { username: owner.id, password: "password-12345" });
  const { server, url } = await startWebServer(root, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = async (username) => {
    const login = await fetch(`${url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: "password-12345" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const bootstrap = await (await fetch(`${url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
    return { Cookie: cookie, Origin: url, "X-Reqflow-Token": bootstrap.token, "Content-Type": "application/json" };
  };
  const headers = await session("product"); const otherHeaders = await session("other");
  const post = (body, identity = headers) => fetch(`${url}/api/tasks/REQ-CHAT/actions`, { method: "POST", headers: identity, body: JSON.stringify(body) });
  assert.equal((await fetch(`${url}/api/tasks`, { method: "POST", headers, body: JSON.stringify({ id: "REQ-CHAT", title: "Pictures", request: "参考截图扩展计算器", images: [image] }) })).status, 201);
  assert.equal((await post({ action: "analyze-intake" }, otherHeaders)).status, 403);
  assert.equal((await post({ action: "analyze-intake" })).status, 200);
  assert.equal((await post({ action: "intake-message", message: { text: "新增乘法，保留加法。", images: [image] } })).status, 200);
  assert.equal((await post({ action: "analyze-intake" })).status, 200);
  const evidence = await (await fetch(`${url}/api/tasks/REQ-CHAT`, { headers })).json();
  assert.equal(evidence.discussion.messages.length, 4);
  const attachment = evidence.discussion.messages[0].attachments[0];
  const imageUrl = `${url}/api/tasks/REQ-CHAT/images/${attachment.id}`;
  assert.equal((await fetch(imageUrl)).status, 401);
  assert.equal((await fetch(imageUrl, { headers: otherHeaders })).status, 403);
  const picture = await fetch(imageUrl, { headers });
  assert.equal(picture.headers.get("content-type"), "image/png");
  assert.equal(picture.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), Buffer.from(image.data, "base64"));
  assert.equal((await post({ action: "confirm-contract", contract: evidence.discussion.latestAnalysis.analysis.contract,
    expectedAnalysisHash: evidence.meta.intakeAnalysisHash })).status, 200);
});

test("real Pi sends image content to a vision provider and blocks text-only model selection", {
  skip: !process.env.REQFLOW_TEST_PI, timeout: 60000,
}, async (t) => {
  const requests = [];
  const api = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const text = body.messages.flatMap((row) => typeof row.content === "string" ? [row.content]
      : row.content.filter((part) => part.type === "text").map((part) => part.text)).join("\n");
    const inputHash = text.match(/输入版本哈希：([a-f0-9]{64})/)[1];
    const analysis = { schemaVersion: 1, inputHash, status: "needs_clarification", reply: "图片已收到，请明确乘法与现有加法的关系。",
      summary: "扩展计算器，保留既有行为。", suggestions: [], questions: [{ id: "Q1", text: "是否保持加法不变？" }], requiredRoles: ["backend", "qa"], contract: null };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish_reason, usage) => `data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk",
      created: 1700000000, model: "vision", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
    res.write(chunk({ role: "assistant", content: JSON.stringify(analysis) }, null));
    res.end(chunk({}, "stop", { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }) + "data: [DONE]\n\n");
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-real-pi-vision-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = stateDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const models = ["vision", "text"].map((id) => ({ id, name: id, reasoning: false, input: id === "vision" ? ["text", "image"] : ["text"],
    contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  await fs.writeFile(path.join(stateDir, "models.json"), JSON.stringify({ providers: { "local-fixture": {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${api.address().port}/v1`, apiKey: "fixture-only", models } } }));
  const { root, project } = await fixture(t, { piExecutable: process.env.REQFLOW_TEST_PI, provider: "local-fixture", model: "vision",
    environment: { pi: ["PI_CODING_AGENT_DIR"], checks: [], localDeployment: [] } }, true);
  await createRequirement(root, product, { id: "REQ-CHAT", title: "Image", request: "扩展计算器", images: [image] });
  assert.equal((await action(root, { action: "analyze-intake" })).state, "intake_clarifying");
  const contents = requests[0].messages.filter((row) => row.role === "user").flatMap((row) => row.content);
  assert.ok(contents.some((part) => part.type === "image_url" && part.image_url.url.endsWith(image.data)),
    JSON.stringify(contents.map((part) => ({ type: part.type, imageUrl: part.image_url, textStart: part.text?.slice(0, 120) }))));
  const task = await readTask(project, "REQ-CHAT");
  const imageFile = path.join(task.directory, task.events[0].detail.attachments[0].file);
  await assert.rejects(runPi({ ...project, config: { ...project.config, model: "text" } }, root, "intake", "Analyze this image",
    path.join(stateDir, "text-model.events.jsonl"), 2, null, [imageFile]), /does not support image input/);
  assert.equal(requests.length, 1);
});

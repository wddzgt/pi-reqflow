import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initialize } from "../src/store.js";
import { loadProject } from "../src/config.js";
import { baselineAgentContext, readProjectBaseline, refreshProjectBaseline } from "../src/baseline.js";
import { initializeProjectContext } from "../src/project-initialization.js";
import { saveModelCredential } from "../src/model-credentials.js";
import { sha256 } from "../src/files.js";
import { setTimeout as delay } from "node:timers/promises";
import { controlledExecution, pauseExecution } from "../src/action-progress.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(t, mode = "success") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-init-context-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "AGENTS.md"), "Preserve existing API behavior.\n");
  await fs.writeFile(path.join(root, "CLAUDE.md"), "@AGENTS.md\n");
  await fs.writeFile(path.join(root, "app.js"), "export const app = 'existing behavior';\n");
  if (["declaration", "unread"].includes(mode)) {
    await fs.mkdir(path.join(root, "controllers"));
    await fs.writeFile(path.join(root, "controllers/a.js"), "export const first = true;\n");
    await fs.writeFile(path.join(root, "controllers/z.js"),
      "// preceding source\n".repeat(50) + "app.post('/save', () => {});\n");
  }
  const counter = path.join(temporary, "calls");
  const executable = path.join(temporary, "pi.mjs");
  await fs.writeFile(executable, `import { promises as fs } from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(process.env.REQFLOW_PHASE, 'initialize');
assert.equal(process.argv[process.argv.indexOf('--tools')+1], '');
assert.equal(await fs.readFile('AGENTS.md', 'utf8'), 'Preserve existing API behavior.\\n');
await fs.appendFile(${JSON.stringify(counter)}, 'call\\n');
${mode === "success" ? `await import(${JSON.stringify(path.join(repository, "test/fake-pi.mjs"))});` : `
${mode === "mutation" ? "await fs.writeFile('app.js', 'mutated snapshot');" : ""}
${["declaration", "unread"].includes(mode) ? `
const schema = JSON.parse(process.env.REQFLOW_POLICY).outputSchema.schema;
assert.deepEqual(schema.properties.commandIds.items.enum, ['check:0']);
const pattern = new RegExp(schema.properties.overview.properties.evidence.items.pattern);
assert.ok(pattern.test('controllers/z.js:51'));
assert.equal(pattern.test('controllers/z.js:50'), false);
assert.equal(pattern.test('controllers/z.js:52'), false);
assert.equal(pattern.test('missing.js:1'), false);
assert.ok(pattern.test('app.js:1'));
const excerpts = JSON.parse(process.argv.at(-1).split('已读取片段：')[1]);
assert.equal(excerpts.some(row => row.file === 'controllers/z.js'), false);
` : ""}
const value={schemaVersion:1,overview:{text:'existing app',evidence:[${JSON.stringify(mode === "evidence" ? "missing.js:1" : mode === "declaration" ? "controllers/z.js:51" : mode === "unread" ? "controllers/z.js:50" : "app.js:1")}]},architecture:[],workflows:[],conventions:[],notes:[],commandIds:[]};
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(value)}],stopReason:'stop',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,cost:{total:0.07}}}}));
console.log(JSON.stringify({type:'agent_settled'}));`}
`);
  const config = JSON.parse(await fs.readFile(path.join(repository, "examples/config.local.json"), "utf8"));
  Object.assign(config, { piExecutable: executable, provider: "fake", model: "fake", allowedPaths: ["app.js"],
    checks: [[process.execPath, "-e", "throw new Error('initialization must not execute project commands')"]] });
  const configFile = path.join(temporary, "config.json");
  await fs.writeFile(configFile, JSON.stringify(config));
  return { root, configFile, counter };
}

test("project document generation can pause with an audited attempt and then continue", async t => {
  const { root, configFile } = await fixture(t);
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  const marker = path.join(path.dirname(configFile), "pause"), entered = `${marker}-entered`;
  const original = await fs.readFile(config.piExecutable, "utf8");
  await fs.writeFile(config.piExecutable, `${original}\n`);
  await initialize(root, configFile, { inventoryOnly: true });
  await fs.writeFile(config.piExecutable, original.replace("assert.equal(process.env.REQFLOW_PHASE, 'initialize');",
    `assert.equal(process.env.REQFLOW_PHASE,'initialize');
     if((await fs.readdir(${JSON.stringify(path.dirname(marker))})).includes('pause')) {
       await fs.writeFile(${JSON.stringify(entered)},'ready');await new Promise(()=>setInterval(()=>{},1000));
     }`));
  await fs.writeFile(marker, "block");
  const project = await loadProject(root), baseline = await readProjectBaseline(project);
  const key = path.join(project.archive, "initialization");
  const running = controlledExecution(key, "initialize", "admin", () => initializeProjectContext(project, baseline));
  const rejected = assert.rejects(running, { code: "EXECUTION_PAUSED" });
  const deadline = Date.now() + 5000;
  while (!(await fs.readdir(path.dirname(marker))).includes(path.basename(entered)) && Date.now() < deadline) await delay(20);
  assert.equal(await fs.readFile(entered, "utf8"), "ready");
  pauseExecution(key, "admin"); await rejected;
  const attempts = path.join(project.archive, "initialization/attempts");
  const ids = await fs.readdir(attempts);
  assert.equal(JSON.parse(await fs.readFile(path.join(attempts, ids[0], "attempt.json"), "utf8")).status, "paused");
  await fs.unlink(marker);
  const completed = await controlledExecution(key, "initialize", "admin", () => initializeProjectContext(project, baseline));
  assert.match(completed.documents["agent.md"], /Project context/);
  assert.equal((await fs.readdir(attempts)).length, 2);
  await assert.rejects(fs.access(path.join(project.archive, "initialization.lock")), { code: "ENOENT" });
});

test("automatic initialization preserves project rules, skips commands and reuses verified guides", async (t) => {
  const { root, configFile, counter } = await fixture(t);
  const initialized = await initialize(root, configFile);
  assert.equal(initialized.documentation.mode, "agent");
  assert.match(await fs.readFile(initialized.documentation.developerFile, "utf8"), /项目开发指南/);
  assert.equal(path.basename(initialized.documentation.agentFile), "agent.md");
  assert.match(await fs.readFile(initialized.documentation.agentFile, "utf8"), /Project context/);
  await assert.rejects(fs.stat(path.join(initialized.archive, "CLAUDE.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "Preserve existing API behavior.\n");
  assert.equal(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  const project = await loadProject(root);
  const baseline = await readProjectBaseline(project);
  await fs.unlink(path.join(project.archive, "documentation-mode.json"));
  await Promise.all([initializeProjectContext(project, baseline), initializeProjectContext(project, baseline)]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(project.archive, "documentation-mode.json"), "utf8")), { mode: "agent" });
  assert.equal(await fs.readFile(counter, "utf8"), "call\n");
  const context = JSON.parse(await baselineAgentContext(project, baseline));
  assert.match(context.projectGuide.overview.text, /现有业务功能/);
  assert.deepEqual(context.projectGuide.architecture[0].evidence, ["app.js:1"]);
  assert.equal(context.projectRules.find(rule => rule.file === "AGENTS.md").text, "Preserve existing API behavior.\n");
  assert.equal(context.projectRules.find(rule => rule.file === "CLAUDE.md").text, "@AGENTS.md\n");
  const metadata = JSON.parse(await fs.readFile(path.join(project.archive, "initialization.json"), "utf8"));
  assert.equal(metadata.telemetry.phase, "initialize");
  assert.equal(path.isAbsolute(metadata.telemetry.logFile), false);
  await fs.appendFile(path.join(project.archive, metadata.documents["agent.md"].file), "changed");
  await assert.rejects(baselineAgentContext(project, baseline), /Initialization guide changed/);
  await assert.rejects(initializeProjectContext(project, baseline), /Initialization guide changed/);
  assert.equal(await fs.readFile(counter, "utf8"), "call\n");
});

test("legacy generated documents migrate to agent.md without another model call", async t => {
  const { root, configFile, counter } = await fixture(t);
  await initialize(root, configFile);
  const project = await loadProject(root);
  const baseline = await readProjectBaseline(project);
  const metadataFile = path.join(project.archive, "initialization.json");
  const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
  metadata.documents["AGENTS.md"] = metadata.documents["agent.md"];
  delete metadata.documents["agent.md"];
  const file = "initialization/generated/legacy-claude.md";
  const content = "@AGENTS.md\n";
  await fs.writeFile(path.join(project.archive, file), content);
  metadata.documents["CLAUDE.md"] = { file, hash: sha256(content) };
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  await fs.unlink(path.join(project.archive, "documentation-mode.json"));
  const migrated = await initializeProjectContext(project, baseline);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(project.archive, "documentation-mode.json"), "utf8")), { mode: "agent" });
  assert.deepEqual(Object.keys(migrated.documents).sort(), ["PROJECT_REFERENCE.md", "agent.md"]);
  assert.match(migrated.documents["agent.md"], /Project context/);
  assert.equal(await fs.readFile(counter, "utf8"), "call\n");
  assert.equal(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  await fs.appendFile(path.join(project.archive, migrated.metadata.documents["agent.md"].file), "tampered");
  await assert.rejects(initializeProjectContext(project, baseline), /Initialization guide changed/);
});

test("focused context preserves applicable directory rules and rejects changed rule text", async t => {
  const { root, configFile } = await fixture(t);
  await fs.mkdir(path.join(root, "src/features"), { recursive: true });
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "src/features/AGENTS.override.md"), "Preserve feature data formats.\n");
  await fs.writeFile(path.join(root, "src/features/agent.md"), "Preserve task-specific interfaces.\n");
  await fs.writeFile(path.join(root, "src/features/task.py"), "value = 1\n");
  await fs.writeFile(path.join(root, "docs/CLAUDE.md"), "Documentation conventions.\n");
  await initialize(root, configFile);
  const project = await loadProject(root);
  const baseline = await readProjectBaseline(project);
  const full = JSON.parse(await baselineAgentContext(project, baseline));
  assert.deepEqual(full.projectRules.map(rule => rule.file).sort(), ["AGENTS.md", "CLAUDE.md"]);
  assert.ok(full.ruleFiles.includes("docs/CLAUDE.md"));
  const focused = JSON.parse(await baselineAgentContext(project, baseline, ["src/features/task.py"]));
  assert.deepEqual(focused.projectRules.map(rule => rule.file).sort(), ["AGENTS.md", "CLAUDE.md", "src/features/AGENTS.override.md", "src/features/agent.md"]);
  assert.equal(focused.projectRules.find(rule => rule.file === "src/features/AGENTS.override.md").text, "Preserve feature data formats.\n");
  assert.equal(focused.projectRules.find(rule => rule.file === "src/features/agent.md").text, "Preserve task-specific interfaces.\n");
  await fs.writeFile(path.join(root, "src/features/AGENTS.override.md"), "Changed policy.\n");
  await assert.rejects(baselineAgentContext(project, baseline, ["src/features/task.py"]), /Project rule source changed/);
});

test("shared encrypted model credentials are available during initialization before registration", async t => {
  const { root, configFile, counter } = await fixture(t);
  const accounts = path.join(path.dirname(root), "accounts"); await fs.mkdir(accounts);
  const credentialId = await saveModelCredential(accounts, "shared-init-secret");
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  config.compatibleProviders = [{ name: "fake", baseUrl: "https://models.example/v1", apiKeyEnv: "SHARED_INIT_KEY",
    credentialId, thinkingToggle: false, models: [{ id: "fake", input: ["text"], contextWindow: 65536,
      maxTokens: 8192, reasoning: false, supportsJsonSchema: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }];
  config.environment.pi.push("SHARED_INIT_KEY");
  await fs.writeFile(configFile, JSON.stringify(config));
  await fs.appendFile(config.piExecutable, "\nassert.equal(process.env.SHARED_INIT_KEY, 'shared-init-secret');\n");
  await initialize(root, configFile, { accountSource: accounts });
  assert.equal((await loadProject(root)).accountsArchive, await fs.realpath(accounts));
  assert.equal(await fs.readFile(counter, "utf8"), "call\n");
  await assert.rejects(fs.stat(path.join(root, ".reqflow", "model-encryption.key")), { code: "ENOENT" });
});

test("model routing changes reuse initialization while source changes trigger fresh analysis", async t => {
  const { root, configFile, counter } = await fixture(t);
  await initialize(root, configFile);
  const project = await loadProject(root);
  const prior = await readProjectBaseline(project);
  const configPath = path.join(project.archive, "config.json");
  const changed = { ...project.config, model: "new-default", modelFallbacks: [{ provider: "fake", model: "another" }] };
  await fs.writeFile(configPath, JSON.stringify(changed));
  await refreshProjectBaseline(await loadProject(root));
  const updated = await readProjectBaseline(await loadProject(root));
  assert.equal(updated.snapshotHash, prior.snapshotHash);
  assert.equal(updated.sourceHash, prior.sourceHash);
  assert.equal(await fs.readFile(counter, "utf8"), "call\n");
  const metadata = JSON.parse(await fs.readFile(path.join(project.archive, "initialization.json")));
  assert.equal(metadata.baselineHash, prior.snapshotHash);
  assert.deepEqual(JSON.parse(await baselineAgentContext(await loadProject(root), updated)).projectGuide,
    { overview: metadata.understanding.overview, architecture: metadata.understanding.architecture,
      conventions: metadata.understanding.conventions, notes: metadata.understanding.notes });
  await fs.appendFile(path.join(root, "app.js"), "export const newValue = 2;\n");
  await refreshProjectBaseline(await loadProject(root));
  assert.equal(await fs.readFile(counter, "utf8"), "call\ncall\n");
});

test("initialization accepts supplied static declaration evidence outside the sampled excerpts", async t => {
  const { root, configFile, counter } = await fixture(t, "declaration");
  await initialize(root, configFile);
  const project = await loadProject(root);
  const baseline = await readProjectBaseline(project);
  const result = await initializeProjectContext(project, baseline);
  assert.deepEqual(result.metadata.understanding.overview.evidence, ["controllers/z.js:51"]);
  assert.equal(await fs.readFile(counter, "utf8"), "call\n");
});

for (const mode of ["evidence", "mutation", "unread"]) {
  test(`initialization rejects ${mode} errors and retains failed model usage without touching source`, async (t) => {
    const { root, configFile } = await fixture(t, mode);
    const expected = { evidence: /模型输出不符合 project_understanding 结构.*pattern/, mutation: /modified its read-only source/,
      unread: /模型输出不符合 project_understanding 结构.*pattern/ };
    await assert.rejects(initialize(root, configFile), expected[mode]);
    assert.equal(await fs.readFile(path.join(root, "app.js"), "utf8"), "export const app = 'existing behavior';\n");
    await assert.rejects(fs.stat(path.join(root, ".reqflow")), { code: "ENOENT" });
    const staging = path.join(root, ".reqflow-init");
    const retained = (await fs.readdir(staging)).filter((name) => name.endsWith("failed-analysis"));
    assert.equal(retained.length, 1);
    const attempts = path.join(staging, retained[0], "attempts");
    const [id] = await fs.readdir(attempts);
    const audit = JSON.parse(await fs.readFile(path.join(attempts, id, "attempt.json"), "utf8"));
    assert.equal(audit.status, "failed");
    assert.equal(audit.costUsd, 0.07);
    assert.equal(audit.telemetry.phase, "initialize");
    await assert.rejects(fs.stat(path.join(attempts, id, "source")), { code: "ENOENT" });
  });
}

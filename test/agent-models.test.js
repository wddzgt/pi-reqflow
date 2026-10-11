import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describePolicy, resolveAgentModel, validateConfig } from "../src/config.js";
import { runPi } from "../src/pi-runner.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);

test("CLI drafts a model selection, previews it and restores explicit project inheritance", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-model-draft-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = path.join(root, "examples/config.local.json");
  const original = await fs.readFile(config, "utf8");
  const output = path.join(directory, "selected.json");
  const args = [path.join(root, "src/cli.js"), "agent-model-draft", "--project", root, "--config", config,
    "--agent", "development", "--action", "set", "--provider", "design", "--model", "large", "--thinking", "low", "--output", output];
  const drafted = JSON.parse((await exec(process.execPath, args)).stdout);
  assert.equal(drafted.pi.agentModels.development.model, "large");
  assert.equal(drafted.pi.agentModels.development.thinking, "low");
  await assert.rejects(exec(process.execPath, args), /EEXIST/);
  const preview = JSON.parse((await exec(process.execPath, [path.join(root, "src/cli.js"), "policy-preview",
    "--project", root, "--config", output])).stdout);
  assert.equal(preview.projectRules.pi.agentModels.development.selectionSource, "agent");
  const inherited = path.join(directory, "inherited.json");
  await exec(process.execPath, [path.join(root, "src/cli.js"), "agent-model-draft", "--project", root,
    "--config", output, "--agent", "development", "--action", "inherit", "--output", inherited]);
  assert.equal(JSON.parse(await fs.readFile(inherited, "utf8")).agentModels.development, undefined);
  assert.equal(await fs.readFile(config, "utf8"), original);
});

test("CLI four-model preset needs no secret or global Pi configuration", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-pool-draft-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "pool.json");
  const args = [path.join(root, "src/cli.js"), "model-pool-draft", "--project", root,
    "--config", path.join(root, "examples/config.local.json"), "--preset", "bailian", "--output", output];
  const preview = JSON.parse((await exec(process.execPath, args)).stdout);
  assert.deepEqual(preview.pi.modelFallbacks, []);
  assert.equal(preview.pi.agentModels.development.thinking, "off");
  const config = JSON.parse(await fs.readFile(output));
  assert.deepEqual(config.environment.pi, ["DASHSCOPE_API_KEY"]);
  assert.equal(config.compatibleProviders[0].apiKey, undefined);
  assert.equal(config.compatibleProviders[0].apiKeyEnv, "DASHSCOPE_API_KEY");
  assert.equal(config.compatibleProviders[0].models.find(row => row.id === "glm-5.3").supportsReasoningEffort, true);
  assert.equal(config.compatibleProviders[0].models.find(row => row.id === "qwen3.8-2.4t-a95b").supportsReasoningEffort, true);
  assert.equal(config.compatibleProviders[0].models.find(row => row.id === "glm-5.3").maxTokens, 16384);
  assert.deepEqual(config.compatibleProviders[0].models.filter(row => row.supportsJsonSchema).map(row => row.id), ["qwen3.8-max"]);
  for (const phase of ["initialize", "intake", "plan", "implement", "review"]) {
    assert.equal(resolveAgentModel(config, phase, phase === "review" ? "all" : null).model, "qwen3.8-max");
  }
  assert.equal(config.modelFallbacks, undefined);
  await assert.rejects(exec(process.execPath, args), /EEXIST/);
});

test("agent selections are explicit, validated and visible in policy preview", async () => {
  const base = JSON.parse(await fs.readFile(path.join(root, "examples/config.local.json"), "utf8"));
  const config = validateConfig({ ...base, agentModels: { development: { provider: "design", model: "large" },
    review: { provider: "review", model: "medium" } } });
  assert.equal(resolveAgentModel(config, "plan").model, "large");
  assert.equal(resolveAgentModel(config, "implement").model, "large");
  assert.equal(resolveAgentModel(config, "review", "backend").model, "medium");
  assert.equal(resolveAgentModel(config, "review", "qa").selectionSource, "agent");
  assert.equal(describePolicy(config).projectRules.pi.agentModels.review.provider, "review");
  assert.deepEqual(Object.keys(describePolicy(config).projectRules.pi.agentModels), ["requirement", "development", "review"]);
  for (const agent of ["initialize", "intake", "plan", "implement", "frontendReview", "backendReview", "qaReview"]) {
    assert.throws(() => validateConfig({ ...base, agentModels: { [agent]: { provider: "old", model: "old" } } }), /Unknown/);
  }
  assert.throws(() => validateConfig({ ...base, agentModels: { development: { model: "missing-provider" } } }), /provider is required/);
  assert.throws(() => validateConfig({ ...base, agentModels: { reviewer: { provider: "x", model: "y" } } }), /Unknown/);
  assert.throws(() => validateConfig({ ...base, agentModels: { development: { provider: "x", model: "y", fallback: "z" } } }), /Unknown/);
  assert.throws(() => resolveAgentModel(config, "review"), /supported role/);
});

test("Pi receives each selected model and records the same routing in success and failure telemetry", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-models-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `const args = process.argv.slice(2);
const selection = { provider: args[args.indexOf('--provider') + 1], model: args[args.indexOf('--model') + 1] };
if (args.includes('--system-prompt') === (process.env.REQFLOW_PHASE === 'implement')) throw new Error('Wrong native/structured prompt selection');
if (!args[args.indexOf('--append-system-prompt')+1]?.includes('project-relative paths')) throw new Error('Missing isolated workspace instructions');
if (process.env.REQFLOW_PHASE !== 'implement' && !args[args.indexOf('--system-prompt')+1].includes('exactly one JSON object')) throw new Error('Wrong structured output contract');
if (process.env.REQFLOW_PHASE === 'implement' && !args[args.indexOf('--tools')+1].split(',').includes('bash')) throw new Error('Missing native command tool');
const failed = selection.model === 'broken';
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
content: [{type: 'text', text: JSON.stringify(selection)}], stopReason: failed ? 'error' : 'stop',
errorMessage: failed ? 'model unavailable' : '', usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: {total: 0.01}} } }));
console.log(JSON.stringify({type: 'agent_settled'}));
`);
  const agentModels = Object.fromEntries(["requirement", "development", "review"]
    .map((agent) => [agent, { provider: `${agent}-provider`, model: `${agent}-model` }]));
  const config = { provider: "default", model: "default", agentModels, piExecutable: executable, mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 };
  for (const [phase, role] of [["initialize", null], ["intake", null], ["plan", null], ["implement", null], ["review", "frontend"], ["review", "backend"], ["review", "qa"]]) {
    const agent = phase === "review" ? "review" : phase === "intake" ? "requirement" : "development";
    const result = await runPi({ config }, directory, phase, "prompt", path.join(directory, `${phase}-${role}.log`), 1, role);
    assert.deepEqual(JSON.parse(result.text), agentModels[agent]);
    assert.equal(result.telemetry.agent, agent);
    assert.equal(result.telemetry.model, agentModels[agent].model);
    assert.equal(result.telemetry.selectionSource, "agent");
  }
  config.agentModels.development.model = "broken";
  await assert.rejects(runPi({ config }, directory, "implement", "prompt", path.join(directory, "failed.log"), 1), (error) => {
    assert.match(error.message, /model unavailable/);
    assert.equal(error.telemetry.model, "broken");
    assert.equal(error.telemetry.agent, "development");
    return true;
  });
});

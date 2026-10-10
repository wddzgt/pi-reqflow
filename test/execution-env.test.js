import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../src/commands.js";
import { describePolicy, validateConfig } from "../src/config.js";
import { deployConfigured } from "../src/deploy.js";
import { runPi } from "../src/pi-runner.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("child processes receive only declared environment variables", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previous = ["REQFLOW_TOKEN", "JENKINS_TOKEN", "APPROVED_PI", "APPROVED_CHECK"]
    .map((name) => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.REQFLOW_TOKEN = "sensitive-project-token";
  process.env.JENKINS_TOKEN = "sensitive-deployment-token";
  process.env.APPROVED_PI = "pi-value";
  process.env.APPROVED_CHECK = "check-value";
  const logFile = path.join(directory, "check.log");
  const command = [process.execPath, "-e", "process.stdout.write(JSON.stringify({ token: process.env.REQFLOW_TOKEN, deployment: process.env.JENKINS_TOKEN, approved: process.env.APPROVED_CHECK }))"];
  assert.equal((await runCommand(command, directory, 30000, logFile, 10000, ["APPROVED_CHECK"])).code, 0);
  const checkLog = await fs.readFile(logFile, "utf8");
  assert.match(checkLog, /check-value/);
  assert.doesNotMatch(checkLog, /sensitive-project-token|sensitive-deployment-token/);
  const deployLog = path.join(directory, "deploy.log");
  await deployConfigured({ kind: "local", command }, { workspace: directory }, deployLog,
    { timeoutMs: 30000, maxBytes: 10000, envNames: [] });
  assert.doesNotMatch(await fs.readFile(deployLog, "utf8"), /sensitive-project-token|sensitive-deployment-token/);
  const missingLog = path.join(directory, "missing.log");
  await assert.rejects(runCommand(command, directory, 30000, missingLog, 10000,
    ["MISSING_REQUIRED_ENV_42F3"]), /Configured child environment variable is missing/);
  await assert.rejects(fs.stat(missingLog), { code: "ENOENT" });
  const piFile = path.join(directory, "fake-pi.mjs");
  await fs.writeFile(piFile, `if (process.env.REQFLOW_TOKEN || process.env.JENKINS_TOKEN) throw new Error("secret reached Pi");
if (process.env.APPROVED_PI !== "pi-value") throw new Error("approved value missing");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");\n`);
  const project = { config: { mode: "local", piExecutable: piFile, provider: "fake", model: "fake",
    environment: { pi: ["APPROVED_PI"] }, allowedPaths: ["."], excludedPaths: [],
    maxPiMs: 30000, maxToolCalls: 10, maxEventBytes: 10000 } };
  assert.equal((await runPi(project, directory, "plan", "read only", path.join(directory, "pi.log"), 1)).text, "done");
});

test("project policy rejects implicit or forbidden secret passthrough", async () => {
  const sample = JSON.parse(await fs.readFile(path.join(repository, "examples/config.local.json"), "utf8"));
  assert.doesNotThrow(() => validateConfig(sample));
  assert.throws(() => validateConfig({ ...sample, maxToolCall: 10 }), /Unknown config field: maxToolCall/);
  assert.throws(() => validateConfig({ ...sample, fastPath: { enabled: false, maxFiles: 2 } }),
    /Disabled config.fastPath accepts only enabled=false/);
  assert.throws(() => validateConfig({ ...sample,
    testDeployment: { ...sample.testDeployment, commmand: ["npm", "test"] } }),
  /Unknown config.testDeployment field: commmand/);
  assert.throws(() => validateConfig({ ...sample, fastPath: { enabled: true, maxFiles: 2,
    maxAcceptance: 2, maxChangedBytes: 1000, allowedPaths: ["other"] } }),
  /outside config.allowedPaths/);
  const explained = describePolicy(sample);
  assert.equal(explained.projectRules.checkSandbox.kind, "trusted-host");
  assert.equal(explained.projectRules.fastPath.enabled, false);
  assert.ok(explained.fixedGates.some((gate) => gate.id === "change-approval"));
  const missing = { ...sample };
  delete missing.environment;
  assert.throws(() => validateConfig(missing), /config.environment is required/);
  assert.throws(() => validateConfig({ ...sample,
    environment: { ...sample.environment, pi: ["REQFLOW_TOKEN"] } }), /environment.pi/);
  assert.throws(() => validateConfig({ ...sample,
    environment: { ...sample.environment, pi: ["reqflow_token"] } }), /environment.pi/);
  const jenkins = { ...sample,
    testDeployment: { kind: "jenkins", baseUrl: "https://jenkins.example.com/", jobPath: "job/check",
      userEnv: "JENKINS_USER", tokenEnv: "JENKINS_TOKEN", timeoutMs: 30000 },
    environment: { ...sample.environment, checks: ["JENKINS_TOKEN"] } };
  assert.throws(() => validateConfig(jenkins), /cannot pass Jenkins credentials/);
  assert.throws(() => validateConfig({ ...sample,
    checkSandbox: { kind: "docker", image: "node:20-alpine", memoryMb: 256, pidsLimit: 64 } }),
  /pinned Docker image digest/);
  assert.doesNotThrow(() => validateConfig({ ...sample,
    checkSandbox: { kind: "docker", image: `sha256:${"a".repeat(64)}`, memoryMb: 256, pidsLimit: 64 } }));
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addCredential } from "../src/auth.js";
import { loadProject } from "../src/config.js";
import { initialize } from "../src/store.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function cli(project, token, command, ...args) {
  const result = spawnSync(process.execPath, [path.join(repository, "src/cli.js"), command,
    "--project", project, ...args], { encoding: "utf8", env: { ...process.env, REQFLOW_TOKEN: token } });
  return { ...result, value: result.status === 0 ? JSON.parse(result.stdout) : null };
}

test("CLI core works without the web adapter and scopes history to administrators", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-cli-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project");
  await fs.mkdir(projectRoot);
  const configFile = path.join(temporary, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 2, mode: "local",
    piExecutable: path.join(repository, "test/fake-pi.mjs"), provider: "fake", model: "fake-model",
    environment: { pi: [], checks: [], localDeployment: [] },
    allowedPaths: ["src"], excludedPaths: [".env"], maxSnapshotBytes: 1000000, maxPiMs: 30000,
    maxToolCalls: 20, maxEventBytes: 1000000, maxCostUsd: 2,
    checks: [[process.execPath, "--version"]], testDeployment: { kind: "local", command: [process.execPath, "--version"] },
    productionDeployment: { kind: "none" } }));
  const preview = cli(projectRoot, "", "policy-preview", "--config", configFile);
  assert.equal(preview.status, 0);
  assert.equal(preview.value.comparison, null);
  assert.equal(preview.value.projectRules.checkSandbox.kind, "trusted-host");
  assert.ok(preview.value.notices.some((notice) => notice.includes("宿主机")));
  assert.equal(preview.value.projectRules.admission.maxFiles, 12);
  const boundaryFile = path.join(temporary, "admission.json");
  const boundaryDraft = path.join(temporary, "admission-draft.json");
  await fs.writeFile(boundaryFile, JSON.stringify({ ...preview.value.projectRules.admission, maxFiles: 16 }));
  const boundaryResult = cli(projectRoot, "", "admission-draft", "--config", configFile,
    "--policy-file", boundaryFile, "--output", boundaryDraft);
  assert.equal(boundaryResult.status, 0);
  assert.equal(boundaryResult.value.admission.maxFiles, 16);
  assert.equal(cli(projectRoot, "", "admission-draft", "--config", configFile,
    "--policy-file", boundaryFile, "--output", boundaryDraft).status, 1);
  const standards = cli(projectRoot, "", "standards-preview", "--config", configFile,
    "--files", "src/Calculator.java,web/view.tsx");
  assert.equal(standards.status, 0);
  assert.deepEqual(standards.value.profiles.map((profile) => profile.id),
    ["java-alibaba", "typescript-eslint"]);
  assert.equal(standards.value.verification, "not-run");
  const standardsDraft = path.join(temporary, "standards-draft.json");
  assert.equal(cli(projectRoot, "", "standards-draft", "--config", configFile,
    "--action", "add", "--rule-id", "TEAM-ERROR-1", "--text", "Propagate domain errors",
    "--level", "review", "--output", standardsDraft).status, 0);
  assert.equal(JSON.parse(await fs.readFile(standardsDraft, "utf8"))
    .codingStandards.globalRules[0].text, "Propagate domain errors");
  assert.equal(cli(projectRoot, "", "standards-draft", "--config", configFile,
    "--action", "add", "--rule-id", "TEAM-ERROR-1", "--text", "Another rule",
    "--level", "review", "--output", standardsDraft).status, 1);
  const revisedDraft = path.join(temporary, "standards-revised.json");
  assert.equal(cli(projectRoot, "", "standards-draft", "--config", standardsDraft,
    "--action", "replace", "--rule-id", "TEAM-ERROR-1", "--text", "Preserve error contracts",
    "--level", "review", "--output", revisedDraft).status, 0);
  assert.equal(JSON.parse(await fs.readFile(revisedDraft, "utf8"))
    .codingStandards.globalRules[0].text, "Preserve error contracts");
  const emptyDraft = path.join(temporary, "standards-empty.json");
  assert.equal(cli(projectRoot, "", "standards-draft", "--config", revisedDraft,
    "--action", "remove", "--rule-id", "TEAM-ERROR-1", "--output", emptyDraft).status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(emptyDraft, "utf8")).codingStandards.globalRules, []);
  await initialize(projectRoot, configFile);
  const project = await loadProject(projectRoot);
  const installed = cli(projectRoot, "", "policy-show");
  assert.equal(installed.status, 0);
  assert.equal(installed.value.configHash, preview.value.configHash);
  assert.equal(cli(projectRoot, "", "standards-show", "--files", "src/Calculator.java")
    .value.profiles[0].id, "java-alibaba");
  const proposalFile = path.join(temporary, "proposal.json");
  await fs.writeFile(proposalFile, JSON.stringify({ ...JSON.parse(await fs.readFile(configFile, "utf8")),
    maxToolCalls: 21 }));
  const proposed = cli(projectRoot, "", "policy-preview", "--config", proposalFile);
  assert.equal(proposed.status, 0);
  assert.deepEqual(proposed.value.comparison.changedRules.map((row) => row.rule), ["limits"]);
  assert.equal(proposed.value.comparison.installedConfigHash, installed.value.configHash);
  assert.deepEqual(cli(projectRoot, "", "policy-preview", "--config", standardsDraft)
    .value.comparison.changedRules.map((row) => row.rule), ["codingStandards"]);
  assert.deepEqual(cli(projectRoot, "", "policy-preview", "--config", boundaryDraft)
    .value.comparison.changedRules.map((row) => row.rule), ["admission"]);
  const productToken = "product-token-0123456789-abcdefghijklmnop";
  const reviewerToken = "reviewer-token-0123456789-abcdefghijklmn";
  const adminToken = "admin-token-0123456789-abcdefghijklmnopqr";
  await addCredential(project, "product", ["product"], { username: "product", password: "password123456", token: productToken });
  await addCredential(project, "reviewer", ["developer"], { username: "reviewer", password: "password123456", token: reviewerToken });
  await addCredential(project, "admin", ["admin"], { username: "admin", password: "password123456", token: adminToken });
  const requestFile = path.join(temporary, "request.md");
  const feedbackFile = path.join(temporary, "feedback.json");
  await fs.writeFile(requestFile, "Keep addition working");
  await fs.writeFile(feedbackFile, JSON.stringify({ summary: "Preserve addition", questions: [],
    requiredRoles: ["backend", "qa"] }));
  assert.equal(cli(projectRoot, productToken, "new", "--id", "REQ-001", "--title", "Preserve addition",
    "--request-file", requestFile).value.state, "intake_draft");
  assert.equal(cli(projectRoot, reviewerToken, "list").value.total, 0);
  assert.equal(cli(projectRoot, reviewerToken, "dev-feedback", "--id", "REQ-001",
    "--feedback-file", feedbackFile).status, 1);
  assert.equal(cli(projectRoot, productToken, "assign-member", "--id", "REQ-001", "--role", "developer",
    "--member", "reviewer").value.state, "assignment_pending");
  assert.equal(cli(projectRoot, reviewerToken, "list").value.total, 1);
  assert.equal(cli(projectRoot, reviewerToken, "accept-assignment", "--id", "REQ-001",
    "--role", "developer").value.state, "intake_assigned");
  assert.equal(cli(projectRoot, reviewerToken, "dev-feedback", "--id", "REQ-001",
    "--feedback-file", feedbackFile).value.state, "intake_feedback");
  assert.equal(cli(projectRoot, reviewerToken, "audit-report").status, 1);
  assert.equal(cli(projectRoot, adminToken, "audit-report", "--limit", "1").value.requirements[0].eventCount, 4);
  assert.equal(cli(projectRoot, reviewerToken, "observability", "--id", "REQ-001").value.summary.attempts, 0);
  assert.equal(cli(projectRoot, reviewerToken, "lifecycle", "--id", "REQ-001", "--limit", "1").value.total, 4);
  assert.equal(cli(projectRoot, productToken, "lifecycle", "--id", "REQ-001").value.responsibilities.product, "product");
  assert.equal(cli(projectRoot, adminToken, "observability", "--id", "REQ-001").value.total, 0);
  assert.deepEqual(cli(projectRoot, adminToken, "history", "--id", "REQ-001").value.events.map((event) => event.type),
    ["intake_draft", "member_assigned", "assignment_accepted", "development_feedback"]);
  assert.equal(cli(projectRoot, adminToken, "auth-history").value.total, 3);
});

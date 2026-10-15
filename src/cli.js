#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { describePolicy, loadProject, validateConfig } from "./config.js";
import { addCredential, authenticate, changePassword, listUsers, resetPassword, revokeCredential, updateUserRoles, reprovisionCredentials } from "./auth.js";
import { createRequirement, executeRequirementAction, getAuditReport, getAuthenticationHistory,
  getRequirement, getRequirementLifecycle, getTaskHistory, getTaskObservability, listRequirements } from "./core.js";
import { readJson } from "./files.js";
import { readProjectBaseline, refreshProjectBaseline } from "./baseline.js";
import { actionAuditContext, initialize } from "./store.js";
import { resolveStandards } from "./standards.js";
import { importProject, generateProjectReference } from "./project-registry.js";
import { bailianModelPreset } from "./model-presets.js";

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid option near ${key}`);
    if (Object.hasOwn(parsed, key.slice(2))) throw new Error(`Duplicate option: ${key}`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function required(args, name) {
  if (!args[name]) throw new Error(`Missing --${name}`);
  return args[name];
}

function pagination(args) {
  const offset = args.offset === undefined ? 0 : Number(args.offset);
  const limit = args.limit === undefined ? 50 : Number(args.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Pagination requires --offset >= 0 and --limit between 1 and 100");
  }
  return { offset, limit };
}

async function actionInput(command, args) {
  const body = { action: command };
  if (command === "develop") body.authorizeImplementation = required(args, "authorize-implementation") === "true";
  if (["assign-member", "accept-assignment", "decline-assignment", "run-review"].includes(command)) {
    body.role = required(args, "role");
  }
  if (command === "assign-member") body.member = required(args, "member");
  if (command === "assign-team") body.team = await readJson(required(args, "team-file"));
  if (command === "review-plan") { body.part = required(args, "part"); body.expectedPlanHash = required(args, "plan-hash"); }
  if (command === "dev-feedback") body.feedback = await readJson(required(args, "feedback-file"));
  if (command === "intake-message") body.message = await readJson(required(args, "message-file"));
  if (command === "discuss-acceptance") body.message = await readJson(required(args, "message-file"));
  if (["start-acceptance-repair", "close-acceptance-feedback"].includes(command)) {
    body.expectedPlanHash = required(args, "plan-hash"); body.expectedAfterHash = required(args, "after-hash");
    body.expectedContractHash = required(args, "contract-hash"); body.expectedFeedbackHash = required(args, "feedback-hash");
  }
  if (["confirm-contract", "revise-contract"].includes(command)) {
    body.contract = await readJson(required(args, "contract-file"));
    if (args["analysis-hash"]) body.expectedAnalysisHash = args["analysis-hash"];
  }
  if (command === "submit-review") body.review = await readJson(required(args, "review-file"));
  if (command === "revise-plan") body.feedback = await fs.readFile(required(args, "feedback-file"), "utf8");
  if (command === "resolve-plan-findings") body.resolution = await readJson(required(args, "resolution-file"));
  if (command === "approve-plan" && args["scope-file"]) body.scope = await readJson(args["scope-file"]);
  if (command === "resume-implementation") body.files = await readJson(required(args, "files-file"));
  if (command === "resume-implementation" && args["reviewed-edits-file"] !== undefined) {
    body.reviewedEdits = await readJson(required(args, "reviewed-edits-file"));
  }
  if (command === "resume-implementation" && args["model-selection-file"] !== undefined) {
    body.modelSelection = await readJson(required(args, "model-selection-file"));
  }
  if (["approve-changes", "accept-test", "observe-release", "reconcile-test-deploy", "reconcile-release", "resume-implementation", "close-acceptance-feedback"].includes(command)) {
    body.evidence = await fs.readFile(required(args, "evidence-file"), "utf8");
  }
  if (command === "accept-test") {
    body.acceptanceMode = required(args, "acceptance-mode");
    body.acceptanceResults = await readJson(required(args, "acceptance-file"));
    body.expectedPlanHash = required(args, "plan-hash");
    body.expectedAfterHash = required(args, "after-hash");
  }
  if (["reconcile-test-deploy", "reconcile-release"].includes(command)) {
    body.outcome = required(args, "outcome");
    if (body.outcome === "succeeded") body.observedRevision = required(args, "observed-revision");
  }
  return body;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) throw new Error("Command required; see README.md");
  const args = options(rest);
  const projectRequired = !["web", "project-import"].includes(command);
  const projectPath = projectRequired ? required(args, "project") : args.project;
  if (args.actor) throw new Error("--actor is no longer accepted; identity comes from REQFLOW_TOKEN");
  let result;
  if (command === "project-import") {
    if (args["inventory-only"] !== undefined && !["true", "false"].includes(args["inventory-only"])) throw new Error("--inventory-only must be true or false");
    result = await importProject(required(args, "name"), { frontendDir: args.frontend, backendDir: args.backend }, {
      config: await readJson(required(args, "config")),
      inventoryOnly: args["inventory-only"] === "true",
      admin: { id: required(args, "admin-user"), username: required(args, "admin-username"),
        password: process.env[required(args, "password-env")] },
    });
  } else if (command === "model-pool-draft") {
    await fs.realpath(projectPath);
    const config = validateConfig(await readJson(required(args, "config")));
    if (required(args, "preset") !== "bailian") throw new Error("Supported model preset: bailian");
    const apiKeyEnv = args["key-env"] ?? "DASHSCOPE_API_KEY";
    const preset = bailianModelPreset(apiKeyEnv);
    const candidate = validateConfig({ ...config, ...preset,
      ...(args["pi-executable"] ? { piExecutable: path.resolve(args["pi-executable"]) } : {}),
      environment: { ...config.environment, pi: [...new Set([...config.environment.pi, apiKeyEnv])] } });
    const output = path.resolve(required(args, "output"));
    await fs.writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    result = { output, pi: describePolicy(candidate).projectRules.pi,
      next: "Set the credential environment variable, preview policy, then initialize the project. Prices are unknown; use token limits." };
  } else if (command === "agent-model-draft") {
    await fs.realpath(projectPath);
    const config = validateConfig(await readJson(required(args, "config")));
    const agent = required(args, "agent");
    if (!["requirement", "development", "review"].includes(agent)) throw new Error("Unsupported --agent");
    const action = required(args, "action");
    const agentModels = { ...config.agentModels };
    if (action === "set") {
      agentModels[agent] = { provider: required(args, "provider"), model: required(args, "model") };
      if (args.thinking !== undefined) agentModels[agent].thinking = args.thinking;
    } else if (action === "inherit") {
      if (args.provider || args.model || args.thinking !== undefined) throw new Error("Inherit accepts no --provider, --model or --thinking");
      if (!Object.hasOwn(agentModels, agent)) throw new Error("Agent already uses the project default");
      delete agentModels[agent];
    } else throw new Error("--action must be set or inherit");
    const candidate = validateConfig({ ...config, agentModels });
    const output = path.resolve(required(args, "output"));
    await fs.writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    result = { output, agent, action, pi: describePolicy(candidate).projectRules.pi };
  } else if (command === "admission-draft") {
    await fs.realpath(projectPath);
    const config = validateConfig(await readJson(required(args, "config")));
    const candidate = validateConfig({ ...config, admission: await readJson(required(args, "policy-file")) });
    const output = path.resolve(required(args, "output"));
    await fs.writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    result = { output, admission: describePolicy(candidate).projectRules.admission,
      next: "Run policy-preview before applying the configuration and refreshing the project baseline" };
  } else if (command === "standards-draft") {
    await fs.realpath(projectPath);
    const config = validateConfig(await readJson(required(args, "config")));
    const action = required(args, "action");
    const id = required(args, "rule-id");
    const rules = [...config.codingStandards.globalRules];
    const index = rules.findIndex((rule) => rule.id === id);
    if (action === "add") {
      if (index !== -1) throw new Error(`Coding rule already exists: ${id}`);
      rules.push({ id, text: required(args, "text"), level: required(args, "level") });
    } else if (action === "replace") {
      if (index === -1) throw new Error(`Coding rule does not exist: ${id}`);
      rules[index] = { id, text: required(args, "text"), level: required(args, "level") };
    } else if (action === "remove") {
      if (args.text || args.level) throw new Error("Remove accepts only --rule-id");
      if (index === -1) throw new Error(`Coding rule does not exist: ${id}`);
      rules.splice(index, 1);
    } else throw new Error("--action must be add, replace or remove");
    const candidate = validateConfig({ ...config, codingStandards: { globalRules: rules } });
    const output = path.resolve(required(args, "output"));
    await fs.writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    result = { output, action, ruleId: id, configHash: describePolicy(candidate).configHash };
  } else if (command === "standards-preview" || command === "standards-show") {
    await fs.realpath(projectPath);
    const files = required(args, "files").split(",").map((file) => file.trim());
    if (files.some((file) => !file || path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))) {
      throw new Error("--files must contain project-relative source paths separated by commas");
    }
    const config = command === "standards-preview"
      ? validateConfig(await readJson(required(args, "config"))) : (await loadProject(projectPath)).config;
    result = { ...resolveStandards(config, files), selectedFiles: files,
      verification: "not-run", configuredChecks: config.checks };
  } else if (command === "policy-preview") {
    const root = await fs.realpath(projectPath);
    const proposed = describePolicy(await readJson(required(args, "config")));
    const installedFile = path.join(root, ".reqflow", "config.json");
    const installed = await fs.stat(installedFile).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    result = { ...proposed, comparison: null };
    if (installed) {
      const current = describePolicy((await loadProject(root)).config);
      const before = current.projectRules;
      const after = proposed.projectRules;
      result.comparison = { installedConfigHash: current.configHash,
        changedRules: Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
          .map((key) => ({ rule: key, current: before[key], proposed: after[key] })) };
    }
  } else if (command === "policy-show") {
    result = describePolicy((await loadProject(projectPath)).config);
  } else if (command === "web") {
    const { startWebServer } = await import("./web-server.js");
    if (!projectPath) {
      const { bootstrapDefaultProject } = await import("./first-run.js");
      await bootstrapDefaultProject();
    }
    const port = args.port === undefined ? 4173 : Number(args.port);
    const { url } = await startWebServer(projectPath, port, { host: args.host ?? "127.0.0.1",
      origins: args.origin === undefined ? undefined : [args.origin] });
    process.stdout.write(`pi-reqflow web: ${url}\n`);
    return;
  } else if (command === "init") {
    if (args["inventory-only"] !== undefined && !["true", "false"].includes(args["inventory-only"])) throw new Error("--inventory-only must be true or false");
    result = await initialize(projectPath, required(args, "config"), { inventoryOnly: args["inventory-only"] === "true" });
    result = { root: result.root, archive: result.archive, baseline: result.baseline, documentation: result.documentation };
  } else if (command === "baseline-refresh") {
    result = await refreshProjectBaseline(await loadProject(projectPath));
  } else if (command === "project-document") {
    const project = await loadProject(projectPath);
    const document = await generateProjectReference({ projectDir: project.root, name: path.basename(project.root) }, project);
    result = { reportFile: path.join(project.archive, "PROJECT_REFERENCE.md"), agentFile: document.agentFile,
      snapshotHash: document.snapshotHash, sourceHash: document.sourceHash };
  } else if (command === "baseline-status") {
    const project = await loadProject(projectPath);
    const baseline = await readProjectBaseline(project);
    result = { baselineFile: `${project.archive}/baseline.json`, reportFile: `${project.archive}/baseline.md`,
      snapshotHash: baseline.snapshotHash, sourceHash: baseline.sourceHash,
      sourceFileCount: baseline.sourceFileCount, unknowns: baseline.unknowns };
  } else if (command === "auth-add") {
    const project = await loadProject(projectPath);
    const username = required(args, "username");
    const password = process.env[required(args, "password-env")];
    const tokenEnv = args["token-env"];
    const token = tokenEnv ? process.env[tokenEnv] : undefined;
    result = await addCredential(project, required(args, "user"), required(args, "roles").split(","), { username, password, token });
  } else if (command === "auth-reprovision") {
    const passwordsFile = required(args, "passwords-file");
    if ((await fs.stat(passwordsFile)).mode & 0o077) throw new Error("Passwords file must be owner-only (0600)");
    result = await reprovisionCredentials(await loadProject(projectPath), await readJson(passwordsFile));
  } else if (command === "auth-revoke") {
    result = await revokeCredential(await loadProject(projectPath), required(args, "user"));
  } else if (command === "auth-list") {
    result = await listUsers(await loadProject(projectPath));
  } else if (command === "auth-update-roles") {
    result = await updateUserRoles(await loadProject(projectPath), required(args, "user"), required(args, "roles").split(","));
  } else if (command === "auth-reset-password") {
    const newPassword = process.env[required(args, "new-password-env")];
    result = await resetPassword(await loadProject(projectPath), required(args, "user"), newPassword);
  } else {
    const project = await loadProject(projectPath);
    const principal = await authenticate(project, process.env.REQFLOW_TOKEN);
    result = await authorizedCommand(command, project, principal, args);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function authorizedCommand(command, project, principal, args) {
  const projectPath = project.root;
  if (command === "new") {
    const request = await fs.readFile(required(args, "request-file"), "utf8");
    return createRequirement(projectPath, principal, { id: required(args, "id"), title: required(args, "title"), request,
      ...(args["images-file"] ? { images: await readJson(args["images-file"]) } : {}) });
  }
  if (command === "status") {
    return (await getRequirement(projectPath, principal, required(args, "id"))).meta;
  }
  if (command === "list") {
    const { offset, limit } = pagination(args);
    return listRequirements(projectPath, principal, offset, limit);
  }
  if (["audit-report", "auth-history"].includes(command)) {
    const { offset, limit } = pagination(args);
    const filters = Object.fromEntries(["owner", "state", "query", "attention"].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    return command === "audit-report" ? getAuditReport(projectPath, principal, offset, limit, filters)
      : getAuthenticationHistory(projectPath, principal, offset, limit);
  }
  if (command === "history") {
    const { offset, limit } = pagination(args);
    return getTaskHistory(projectPath, principal, required(args, "id"), offset, limit);
  }
  if (command === "lifecycle") {
    const { offset, limit } = pagination(args);
    return getRequirementLifecycle(projectPath, principal, required(args, "id"), offset, limit);
  }
  if (command === "observability") {
    const { offset, limit } = pagination(args);
    return getTaskObservability(projectPath, principal, required(args, "id"), offset, limit);
  }
  const id = required(args, "id");
  return executeRequirementAction(projectPath, id, await actionInput(command, args), principal);
}

actionAuditContext.run({ actor: `host:${userInfo().username}`, action: process.argv[2] }, main).catch((error) => {
  process.stderr.write(`pi-reqflow: ${error.message}\n`);
  process.exitCode = 1;
});

import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson, sha256 } from "./files.js";
import { standardsCatalog } from "./standards.js";
import { admissionPolicy, validateAdmissionPolicy } from "./admission.js";
import { deploymentAdapter, isRegisteredDeployment, validateDeploymentOptions } from "./deployment-adapters.js";
import "./ci-deployment-adapters.js";

const reserved = [".git", ".reqflow", ".reqflow-init", "node_modules"];
export const modelAgents = ["requirement", "development", "review"];
export const defaultModelUsage = Object.freeze({ maxTokens: 60000, maxContextBytes: 64000,
  maxRequests: 8, readOnlyMaxRequests: 6, maxToolResultBytes: 8000, initializationMaxTokens: 30000,
  initializationMaxRequests: 1, initializationMaxToolCalls: 8 });
const configFields = new Set(["schemaVersion", "mode", "piExecutable", "provider", "model", "environment",
  "allowedPaths", "excludedPaths", "maxSnapshotBytes", "maxPiMs", "maxToolCalls", "maxEventBytes",
  "maxCostUsd", "executionTimeouts", "maxAuditBytes", "fastPath", "planReview", "checks", "checkSandbox", "testDeployment", "productionDeployment",
  "baseBranch", "releaseBranch", "branchPrefix", "remote", "gitDelivery", "codingStandards", "agentModels", "admission", "modelUsage", "modelParameters", "thinking", "structuredOutput", "modelFallbacks", "compatibleProviders", "implementationScope"]);

function rejectUnknown(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}

function validJenkinsJobPath(value) {
  if (typeof value !== "string") return false;
  const segments = value.replace(/\/$/, "").split("/");
  if (segments.length % 2 !== 0) return false;
  return segments.every((segment, index) => {
    if (index % 2 === 0) return segment === "job";
    if (!/^(?:[A-Za-z0-9_.-]|%[A-Fa-f0-9]{2})+$/.test(segment)) return false;
    const name = decodeURIComponent(segment);
    return ![".", ".."].includes(name) && !/[\\/\x00-\x1f]/.test(name);
  });
}

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
}

function strings(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of nonempty strings`);
  }
}

function environmentNames(value, label) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || name.toUpperCase().startsWith("REQFLOW_")
      || ["NODE_OPTIONS", "NODE_TEST_CONTEXT"].includes(name.toUpperCase()))) {
    throw new Error(`${label} must be an array of allowed environment variable names`);
  }
  if (new Set(value.map((name) => name.toUpperCase())).size !== value.length) {
    throw new Error(`${label} contains duplicate names`);
  }
}

export function validateModelParameters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Model parameters must be an object");
  rejectUnknown(value, ["temperature", "topP", "maxOutputTokens", "outputFormat"], "modelParameters");
  for (const [name, maximum] of [["temperature", 2], ["topP", 1]]) {
    if (value[name] !== undefined && (typeof value[name] !== "number" || !Number.isFinite(value[name])
        || value[name] < 0 || value[name] > maximum)) throw new Error(`Invalid model parameter ${name}`);
  }
  if (value.maxOutputTokens !== undefined && (!Number.isSafeInteger(value.maxOutputTokens)
      || value.maxOutputTokens < 1 || value.maxOutputTokens > 1000000)) throw new Error("Invalid model maxOutputTokens");
  if (value.outputFormat !== undefined && !["auto", "json_schema", "json_object"].includes(value.outputFormat)) throw new Error("Invalid structured output format");
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Project config must be an object");
  for (const key of Object.keys(config)) {
    if (!configFields.has(key)) throw new Error(`Unknown config field: ${key}`);
  }
  if (config.schemaVersion !== 2) throw new Error("config.schemaVersion must be 2");
  if (config.planReview !== undefined && !["risk-based", "full"].includes(config.planReview)) {
    throw new Error("config.planReview must be risk-based or full");
  }
  if (!["git", "local"].includes(config.mode)) throw new Error("config.mode must be git or local");
  if (config.implementationScope !== undefined && !["project", "plan"].includes(config.implementationScope)) {
    throw new Error("config.implementationScope must be project or plan");
  }
  nonempty(config.provider, "config.provider");
  nonempty(config.model, "config.model");
  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (config.modelFallbacks !== undefined) {
    if (!Array.isArray(config.modelFallbacks) || config.modelFallbacks.length > 8) throw new Error("modelFallbacks must contain at most 8 candidates");
    for (const selection of config.modelFallbacks) {
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("Invalid fallback model");
      rejectUnknown(selection, ["provider", "model", "thinking"], "modelFallbacks");
      nonempty(selection.provider, "modelFallbacks.provider");
      nonempty(selection.model, "modelFallbacks.model");
      if (selection.thinking !== undefined && !thinkingLevels.includes(selection.thinking)) throw new Error("Invalid fallback thinking level");
    }
    if (new Set(config.modelFallbacks.map(row => JSON.stringify([row.provider, row.model]))).size !== config.modelFallbacks.length) throw new Error("Duplicate fallback model");
  }
  if (config.compatibleProviders !== undefined) {
    if (!Array.isArray(config.compatibleProviders) || config.compatibleProviders.length > 8) throw new Error("compatibleProviders must contain at most 8 providers");
    for (const provider of config.compatibleProviders) {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new Error("Invalid compatible provider");
      rejectUnknown(provider, ["name", "displayName", "baseUrl", "apiKeyEnv", "credentialId", "thinkingToggle", "models"], "compatibleProviders");
      if (provider.displayName !== undefined) nonempty(provider.displayName, "provider displayName");
      if (provider.credentialId !== undefined && !/^[a-f0-9-]{36}$/.test(provider.credentialId)) throw new Error("Invalid model credential reference");
      nonempty(provider.name, "compatible provider name");
      if (!/^[a-zA-Z0-9_-]+$/.test(provider.name)) throw new Error("Invalid compatible provider name");
      const url = new URL(provider.baseUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Provider baseUrl must be HTTPS without credentials or query parameters");
      environmentNames([provider.apiKeyEnv], "compatibleProviders.apiKeyEnv");
      if (!config.environment?.pi?.includes(provider.apiKeyEnv)) throw new Error("Provider key environment variable must be explicitly allowed in environment.pi");
      if (typeof provider.thinkingToggle !== "boolean") throw new Error("Provider thinkingToggle must be explicit");
      if (!Array.isArray(provider.models) || !provider.models.length || provider.models.length > 16) throw new Error("Provider requires 1..16 models");
      for (const model of provider.models) {
        if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error("Invalid compatible provider model");
        rejectUnknown(model, ["id", "input", "contextWindow", "maxTokens", "reasoning", "supportsReasoningEffort", "supportsJsonSchema", "cost"], "compatible provider model");
        if (model.cost !== undefined) {
          rejectUnknown(model.cost, ["input", "output", "cacheRead", "cacheWrite"], "model.cost");
          for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
            if (!Number.isFinite(model.cost[key]) || model.cost[key] < 0) throw new Error(`model.cost.${key} requires an explicit USD price per million tokens`);
          }
        }
        nonempty(model.id, "compatible provider model.id");
        if (model.supportsJsonSchema !== undefined && typeof model.supportsJsonSchema !== "boolean") throw new Error("Invalid model supportsJsonSchema capability");
        if (!Array.isArray(model.input) || !model.input.includes("text") || model.input.some(type => !["text", "image"].includes(type)) || new Set(model.input).size !== model.input.length) throw new Error("Invalid model input capabilities");
        for (const key of ["contextWindow", "maxTokens"]) {
          if (!Number.isSafeInteger(model[key]) || model[key] < 1 || model[key] > 1000000) throw new Error(`Invalid model ${key}`);
        }
        if (model.maxTokens > model.contextWindow || typeof model.reasoning !== "boolean") throw new Error("Invalid model output limit or reasoning capability");
        if (model.supportsReasoningEffort !== undefined && (typeof model.supportsReasoningEffort !== "boolean"
            || model.supportsReasoningEffort && !model.reasoning)) throw new Error("Invalid model supportsReasoningEffort capability");
      }
      if (new Set(provider.models.map(model => model.id)).size !== provider.models.length) throw new Error("Duplicate provider model");
    }
    if (new Set(config.compatibleProviders.map(provider => provider.name)).size !== config.compatibleProviders.length) throw new Error("Duplicate compatible provider");
  }
  if (config.modelParameters !== undefined) validateModelParameters(config.modelParameters);
  if (config.thinking !== undefined && !thinkingLevels.includes(config.thinking)) throw new Error("Invalid config.thinking level");
  if (config.structuredOutput !== undefined && typeof config.structuredOutput !== "boolean") throw new Error("config.structuredOutput must be boolean");
  if (config.modelUsage !== undefined) {
    if (!config.modelUsage || typeof config.modelUsage !== "object" || Array.isArray(config.modelUsage)) {
      throw new Error("config.modelUsage must be an object");
    }
    rejectUnknown(config.modelUsage, Object.keys(defaultModelUsage), "config.modelUsage");
    for (const [key, value] of Object.entries(config.modelUsage)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) {
        throw new Error(`config.modelUsage.${key} must be a positive integer <= 1000000`);
      }
    }
  }
  if (config.admission !== undefined) validateAdmissionPolicy(config.admission);
  if (config.agentModels !== undefined) {
    if (!config.agentModels || typeof config.agentModels !== "object" || Array.isArray(config.agentModels)) {
      throw new Error("config.agentModels must be an object");
    }
    rejectUnknown(config.agentModels, modelAgents, "config.agentModels");
    for (const [agent, selection] of Object.entries(config.agentModels)) {
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error(`Invalid model selection: ${agent}`);
      rejectUnknown(selection, ["provider", "model", "thinking", "modelParameters", "modelUsage", "maxPiMs", "maxToolCalls"], `config.agentModels.${agent}`);
      if (selection.modelParameters !== undefined) validateModelParameters(selection.modelParameters);
      for (const name of ["maxPiMs", "maxToolCalls"]) if (selection[name] !== undefined
          && (!Number.isSafeInteger(selection[name]) || selection[name] < 1)) throw new Error(`Invalid ${agent}.${name}`);
      if (selection.modelUsage !== undefined) {
        if (!selection.modelUsage || typeof selection.modelUsage !== "object" || Array.isArray(selection.modelUsage)) throw new Error(`Invalid ${agent}.modelUsage`);
        rejectUnknown(selection.modelUsage, Object.keys(defaultModelUsage), `${agent}.modelUsage`);
        for (const value of Object.values(selection.modelUsage)) if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new Error(`Invalid ${agent} usage limit`);
      }
      if (selection.thinking !== undefined && !thinkingLevels.includes(selection.thinking)) throw new Error(`Invalid thinking level: ${agent}`);
      nonempty(selection.provider, `config.agentModels.${agent}.provider`);
      nonempty(selection.model, `config.agentModels.${agent}.model`);
    }
  }
  if (!config.environment || typeof config.environment !== "object" || Array.isArray(config.environment)) {
    throw new Error("config.environment is required");
  }
  for (const key of ["pi", "checks", "localDeployment"]) {
    environmentNames(config.environment[key], `config.environment.${key}`);
  }
  for (const key of Object.keys(config.environment)) {
    if (!["pi", "checks", "localDeployment"].includes(key)) throw new Error(`Unknown config.environment field: ${key}`);
  }
  strings(config.allowedPaths, "config.allowedPaths");
  if (config.allowedPaths.length === 0) throw new Error("config.allowedPaths cannot be empty");
  strings(config.excludedPaths, "config.excludedPaths");
  for (const item of [...config.allowedPaths, ...config.excludedPaths]) {
    if (path.isAbsolute(item) || item.split(/[\\/]/).includes("..")) throw new Error(`Unsafe config path: ${item}`);
  }
  if (!Number.isSafeInteger(config.maxSnapshotBytes) || config.maxSnapshotBytes < 1) throw new Error("config.maxSnapshotBytes must be positive");
  if (!Number.isSafeInteger(config.maxPiMs) || config.maxPiMs < 1) throw new Error("config.maxPiMs must be positive");
  if (!Number.isSafeInteger(config.maxToolCalls) || config.maxToolCalls < 1) throw new Error("config.maxToolCalls must be positive");
  if (!Number.isSafeInteger(config.maxEventBytes) || config.maxEventBytes < 1) throw new Error("config.maxEventBytes must be positive");
  if (config.maxAuditBytes !== undefined && (!Number.isSafeInteger(config.maxAuditBytes) || config.maxAuditBytes < 1)) throw new Error("config.maxAuditBytes must be a positive storage cap");
  if (config.executionTimeouts !== undefined) {
    rejectUnknown(config.executionTimeouts, ["checksMs", "startupMs", "deploymentMs"], "executionTimeouts");
    for (const key of ["checksMs", "startupMs", "deploymentMs"]) {
      if (!Number.isSafeInteger(config.executionTimeouts[key]) || config.executionTimeouts[key] < 1) throw new Error(`executionTimeouts.${key} must be explicit and positive`);
    }
  }
  if (config.maxCostUsd !== null && (typeof config.maxCostUsd !== "number" || !Number.isFinite(config.maxCostUsd) || config.maxCostUsd <= 0)) {
    throw new Error("config.maxCostUsd must be null (no monetary cap) or positive");
  }
  if (config.codingStandards !== undefined) {
    const standards = config.codingStandards;
    if (!standards || typeof standards !== "object" || Array.isArray(standards)) {
      throw new Error("config.codingStandards must be an object");
    }
    rejectUnknown(standards, ["globalRules"], "config.codingStandards");
    if (!Array.isArray(standards.globalRules) || standards.globalRules.length > 30) {
      throw new Error("config.codingStandards.globalRules must be an array with at most 30 rules");
    }
    for (const rule of standards.globalRules) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error("Invalid global coding rule");
      rejectUnknown(rule, ["id", "text", "level"], "global coding rule");
      if (!/^TEAM-[A-Z0-9-]{1,48}$/.test(rule.id ?? "") || typeof rule.text !== "string"
          || !rule.text.trim() || rule.text.length > 400 || !["review", "guide"].includes(rule.level)) {
        throw new Error("Global coding rule requires TEAM-* id, text <= 400 characters and review/guide level");
      }
    }
    if (new Set(standards.globalRules.map((rule) => rule.id)).size !== standards.globalRules.length) {
      throw new Error("Duplicate global coding rule ID");
    }
  }
  if (config.fastPath !== undefined) {
    if (!config.fastPath || typeof config.fastPath !== "object" || typeof config.fastPath.enabled !== "boolean") {
      throw new Error("config.fastPath.enabled must be boolean");
    }
    rejectUnknown(config.fastPath, ["enabled", "maxFiles", "maxAcceptance", "maxChangedBytes",
      "allowedPaths"], "config.fastPath");
    if (!config.fastPath.enabled && Object.keys(config.fastPath).length !== 1) {
      throw new Error("Disabled config.fastPath accepts only enabled=false");
    }
    if (config.fastPath.enabled) {
      for (const key of ["maxFiles", "maxAcceptance", "maxChangedBytes"]) {
        if (!Number.isSafeInteger(config.fastPath[key]) || config.fastPath[key] < 1) {
          throw new Error(`config.fastPath.${key} must be positive`);
        }
      }
      strings(config.fastPath.allowedPaths, "config.fastPath.allowedPaths");
      for (const item of config.fastPath.allowedPaths) {
        if (path.isAbsolute(item) || item.split(/[\\/]/).includes("..")) {
          throw new Error(`Unsafe fast-path config path: ${item}`);
        }
      }
      for (const item of config.fastPath.allowedPaths) {
        if (!config.allowedPaths.some((scope) => scope === "." || item === scope || item.startsWith(`${scope}/`))) {
          throw new Error(`Fast-path path is outside config.allowedPaths: ${item}`);
        }
      }
    }
  }
  nonempty(config.piExecutable, "config.piExecutable");
  if (!path.isAbsolute(config.piExecutable)) throw new Error("config.piExecutable must be an absolute path");
  if (config.mode === "git") {
    nonempty(config.baseBranch, "config.baseBranch");
    nonempty(config.releaseBranch, "config.releaseBranch");
    nonempty(config.branchPrefix, "config.branchPrefix");
    nonempty(config.remote, "config.remote");
    for (const value of [config.baseBranch, config.releaseBranch, config.branchPrefix]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(value) || value.includes("..") || value.endsWith("/")) {
        throw new Error(`Invalid Git branch value: ${value}`);
      }
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(config.remote)) throw new Error("Invalid Git remote name");
  }
  if (config.gitDelivery !== undefined) {
    const delivery = config.gitDelivery;
    if (config.mode !== "git" || !delivery || typeof delivery !== "object" || Array.isArray(delivery)) throw new Error("Git delivery requires Git mode");
    rejectUnknown(delivery, ["testMode", "testBranch"], "gitDelivery");
    if (!["branch", "merge"].includes(delivery.testMode)) throw new Error("gitDelivery.testMode must be branch or merge");
    if (delivery.testMode === "merge" && (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(delivery.testBranch ?? "")
        || delivery.testBranch.includes("..") || delivery.testBranch.endsWith("/"))) throw new Error("Merge deployment requires an explicit test branch");
    if (delivery.testMode === "branch" && delivery.testBranch !== undefined) throw new Error("Branch deployment does not use a test branch");
  }
  if (!Array.isArray(config.checks)) throw new Error("config.checks must be an array; task checks are required at developer approval");
  for (const command of config.checks) strings(command, "config.checks entry");
  if (config.checkSandbox !== undefined) {
    const sandbox = config.checkSandbox;
    if (!sandbox || sandbox.kind !== "docker" || typeof sandbox.image !== "string"
        || !/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(sandbox.image ?? "")) {
      throw new Error("config.checkSandbox requires a pinned Docker image digest");
    }
    if (!Number.isSafeInteger(sandbox.memoryMb) || sandbox.memoryMb < 128 || sandbox.memoryMb > 32768
        || !Number.isSafeInteger(sandbox.pidsLimit) || sandbox.pidsLimit < 16 || sandbox.pidsLimit > 1024) {
      throw new Error("config.checkSandbox requires bounded memoryMb and pidsLimit");
    }
    for (const key of Object.keys(sandbox)) {
      if (!["kind", "image", "memoryMb", "pidsLimit"].includes(key)) {
        throw new Error(`Unknown config.checkSandbox field: ${key}`);
      }
    }
    if (config.environment.checks.some((name) => ["HOME", "TMPDIR", "PATH"].includes(name.toUpperCase()))) {
      throw new Error("Docker checks use the image PATH and isolated HOME/TMPDIR");
    }
  }
  if (!config.testDeployment || !["local", "jenkins", "unconfigured"].includes(config.testDeployment.kind)
      && !isRegisteredDeployment(config.testDeployment.kind)) {
    throw new Error("config.testDeployment.kind must be local, jenkins, unconfigured or a registered deployment adapter");
  }
  rejectUnknown(config.testDeployment, config.testDeployment.kind === "unconfigured" ? ["kind"] : config.testDeployment.kind === "local"
    ? ["kind", "command", "url"] : config.testDeployment.kind === "jenkins" ? ["kind", "baseUrl", "jobPath", "userEnv", "tokenEnv", "credentialId", "timeoutMs", "url"]
      : ["kind", "adapterVersion", "options", "credentialsEnv", "credentialId", "timeoutMs", "url"],
  "config.testDeployment");
  if (config.testDeployment.url !== undefined) {
    const url = new URL(config.testDeployment.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Test environment URL must be HTTP(S) without embedded credentials");
    }
  }
  if (config.testDeployment.kind === "local") strings(config.testDeployment.command, "config.testDeployment.command");
  if (config.testDeployment.kind === "jenkins") {
    for (const key of ["baseUrl", "jobPath", "userEnv", "tokenEnv"]) nonempty(config.testDeployment[key], `config.testDeployment.${key}`);
    const url = new URL(config.testDeployment.baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      throw new Error("Jenkins URL must use HTTPS, except on localhost");
    }
    if (!validJenkinsJobPath(config.testDeployment.jobPath)) {
      throw new Error("config.testDeployment.jobPath must be a relative Jenkins job path");
    }
    if (!Number.isSafeInteger(config.testDeployment.timeoutMs) || config.testDeployment.timeoutMs < 1) {
      throw new Error("config.testDeployment.timeoutMs must be positive");
    }
  }
  if (!config.productionDeployment || !["none", "local", "jenkins"].includes(config.productionDeployment.kind)
      && !isRegisteredDeployment(config.productionDeployment.kind)) {
    throw new Error("config.productionDeployment.kind must be none, local, jenkins or a registered deployment adapter");
  }
  rejectUnknown(config.productionDeployment, config.productionDeployment.kind === "none" ? ["kind"]
    : config.productionDeployment.kind === "local" ? ["kind", "command"]
      : config.productionDeployment.kind === "jenkins" ? ["kind", "baseUrl", "jobPath", "userEnv", "tokenEnv", "credentialId", "timeoutMs"]
        : ["kind", "adapterVersion", "options", "credentialsEnv", "credentialId", "timeoutMs", "url"],
  "config.productionDeployment");
  if (config.productionDeployment.kind === "local") strings(config.productionDeployment.command, "config.productionDeployment.command");
  if (config.productionDeployment.kind === "jenkins") {
    for (const key of ["baseUrl", "jobPath", "userEnv", "tokenEnv"]) nonempty(config.productionDeployment[key], `config.productionDeployment.${key}`);
    const url = new URL(config.productionDeployment.baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      throw new Error("Production Jenkins URL must use HTTPS, except on localhost");
    }
    if (!validJenkinsJobPath(config.productionDeployment.jobPath)) {
      throw new Error("config.productionDeployment.jobPath must be a relative Jenkins job path");
    }
    if (!Number.isSafeInteger(config.productionDeployment.timeoutMs) || config.productionDeployment.timeoutMs < 1) {
      throw new Error("config.productionDeployment.timeoutMs must be positive");
    }
  }
  for (const [name, deployment] of [["testDeployment", config.testDeployment],
    ["productionDeployment", config.productionDeployment]]) {
    if (deployment.credentialId !== undefined && !/^[a-f0-9-]{36}$/.test(deployment.credentialId)) throw new Error(`config.${name}.credentialId is invalid`);
    if (deployment.kind === "jenkins") {
      environmentNames([deployment.userEnv, deployment.tokenEnv], `config.${name} credentials`);
    } else if (isRegisteredDeployment(deployment.kind)) {
      if (!deployment.options || typeof deployment.options !== "object" || Array.isArray(deployment.options)) throw new Error(`config.${name}.options must be an object`);
      if (!Number.isSafeInteger(deployment.timeoutMs) || deployment.timeoutMs < 1) throw new Error(`config.${name}.timeoutMs must be positive`);
      environmentNames(deployment.credentialsEnv, `config.${name}.credentialsEnv`);
      if (deployment.url !== undefined) {
        const url = new URL(deployment.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`config.${name}.url must be HTTP(S) without embedded credentials`);
      }
      validateDeploymentOptions(deployment);
      if (["gitlab", "github"].includes(deployment.kind)
          && (deployment.credentialsEnv.length !== 1 || deployment.credentialsEnv[0] !== deployment.options.tokenEnv)) throw new Error(`config.${name} must declare exactly the platform token credential`);
      if (deploymentAdapter(deployment).requiresPublishedRevision && config.mode !== "git") throw new Error(`config.${name} adapter requires Git mode and a published revision`);
    }
  }
  const deploymentSecrets = [config.testDeployment, config.productionDeployment]
    .flatMap(deployment => deployment.kind === "jenkins" ? [deployment.userEnv, deployment.tokenEnv]
      : isRegisteredDeployment(deployment.kind) ? deployment.credentialsEnv : []);
  for (const [scope, names] of Object.entries(config.environment)) {
    if (names.some((name) => deploymentSecrets.some((secret) => secret.toUpperCase() === name.toUpperCase()))) {
      throw new Error(`config.environment.${scope} cannot pass Jenkins credentials or adapter credentials to child processes`);
    }
  }
  return { ...config, implementationScope: config.implementationScope ?? "project",
    executionTimeouts: config.executionTimeouts ?? { checksMs: 300000, startupMs: 120000, deploymentMs: 600000 },
    thinking: config.thinking ?? "off", modelUsage: { ...defaultModelUsage, ...config.modelUsage },
    codingStandards: config.codingStandards ?? { globalRules: [] },
    excludedPaths: [...new Set([...reserved, ...config.excludedPaths])] };
}

export function resolveAgentModel(config, phase, role = null) {
  if (!["initialize", "intake", "plan", "implement", "review"].includes(phase)) throw new Error(`Unsupported model phase: ${phase}`);
  if (phase === "review" && !["frontend", "backend", "qa", "all"].includes(role)) throw new Error("Review model requires a supported role");
  if (phase !== "review" && role !== null) throw new Error("Only review runs accept a role");
  const agent = phase === "intake" ? "requirement" : phase === "review" ? "review" : "development";
  const selection = config.agentModels?.[agent];
  const { provider, model } = selection === undefined ? config : selection;
  nonempty(provider, `${agent}.provider`);
  nonempty(model, `${agent}.model`);
  return { ...selection, agent, provider, model, selectionSource: selection === undefined ? "project" : "agent" };
}

export function describePolicy(input) {
  const config = validateConfig(input);
  const execution = { ...config, environment: { ...config.environment } };
  for (const field of ["provider", "model", "thinking", "modelParameters", "compatibleProviders", "agentModels",
    "modelFallbacks", "structuredOutput", "modelUsage", "maxPiMs", "maxToolCalls", "maxCostUsd"]) delete execution[field];
  const modelCredentials = new Set((config.compatibleProviders ?? []).map(provider => provider.apiKeyEnv));
  execution.environment.pi = config.environment.pi.filter(name => !modelCredentials.has(name));
  const executionConfigHash = sha256(JSON.stringify(execution, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value));
  const notices = ["Pi 在当前服务环境运行（本机 CLI 为宿主机，Docker 部署为服务容器）；工具路径守卫不构成进程沙箱"];
  notices.push("内置代码规范和团队规则会进入 Agent 上下文；只有项目配置的检查命令与人工审核能提供验证证据");
  if (!config.checkSandbox) notices.push("项目检查在当前服务环境运行；仅用于可信代码仓库和受控执行环境");
  if (config.testDeployment.kind === "local") notices.push("测试部署命令在当前服务环境运行；需由使用方隔离和授权");
  if (config.productionDeployment.kind === "local") notices.push("生产部署命令在当前服务环境运行；需由使用方隔离和授权");
  return {
    schemaVersion: config.schemaVersion,
    configHash: sha256(JSON.stringify(config)),
    executionConfigHash,
    fixedGates: [
      { id: "contract", rule: "产品定版后统一分析方案，按影响范围开展专项检查" },
      { id: "admission", rule: "自动承接方案明确的初级研发工作；高复杂度、分阶段设计和跨团队协调交由研发主导，改动量仅作规划参考" },
      { id: "plan-approval", rule: "具名研发确认方案后授权实施；方案绑定冻结需求、基线和批准记录，专项检查按风险或完整策略执行" },
      { id: "change-approval", rule: "验证后由具名研发核对实际变更，批准后才能测试部署" },
      { id: "scope-and-rollback", rule: "Pi 仅能改允许路径；实施前保存快照，回退前检查冲突" },
      { id: "verification", rule: "基线、实施后和候选版本均运行项目检查并核对日志摘要" },
      { id: "release", rule: "测试环境人工验收；生产发布另需发布角色审批和观察记录" },
      { id: "audit", rule: "需求事件记录身份、状态、证据路径和哈希链" },
    ],
    projectRules: {
      pi: { executable: config.piExecutable, provider: config.provider, model: config.model,
        thinking: config.thinking, structuredOutput: config.structuredOutput === true,
        modelParameters: config.modelParameters ?? {},
        modelFallbacks: config.modelFallbacks ?? [], compatibleProviders: config.compatibleProviders ?? [],
        agentModels: Object.fromEntries(modelAgents.map((agent) =>
          [agent, { ...resolveAgentModel(config, { requirement: "intake", development: "plan", review: "review" }[agent],
            agent === "review" ? "all" : null), thinking: config.agentModels?.[agent]?.thinking ?? config.thinking }])) },
      mode: config.mode,
      branchRules: config.mode === "git" ? { baseBranch: config.baseBranch,
        releaseBranch: config.releaseBranch, branchPrefix: config.branchPrefix, remote: config.remote } : null,
      allowedPaths: config.allowedPaths,
      implementationScope: config.implementationScope,
      planReview: config.planReview ?? "risk-based",
      excludedPaths: config.excludedPaths,
      checks: config.checks,
      checkSandbox: config.checkSandbox ?? { kind: "trusted-host" },
      fastPath: config.fastPath ?? { enabled: false },
      admission: admissionPolicy(config),
      limits: { maxSnapshotBytes: config.maxSnapshotBytes, maxPiMs: config.maxPiMs,
        executionTimeouts: config.executionTimeouts, maxAuditBytes: config.maxAuditBytes ?? null,
        maxToolCalls: config.maxToolCalls, maxEventBytes: config.maxEventBytes,
        maxCostUsd: config.maxCostUsd, modelUsage: config.modelUsage },
      environmentNames: config.environment,
      codingStandards: { ...config.codingStandards, catalogVersion: standardsCatalog().version,
        general: standardsCatalog().general,
        builtins: standardsCatalog().profiles.map(({ id, language, source, reference }) =>
          ({ id, language, source, reference })) },
      testDeployment: config.testDeployment,
      productionDeployment: config.productionDeployment,
    },
    notices,
  };
}

export async function loadProject(project) {
  const root = await fs.realpath(path.resolve(project));
  const config = validateConfig(await readJson(path.join(root, ".reqflow", "config.json")));
  const archive = path.join(root, ".reqflow");
  const source = await readJson(path.join(archive, "account-source.json")).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (source !== null && (typeof source.archive !== "string" || !path.isAbsolute(source.archive))) {
    throw new Error("Account source must name an absolute account archive");
  }
  return { root, config, archive, accountsArchive: source === null ? archive : await fs.realpath(source.archive) };
}

export function allowedFile(relative, config) {
  const normalized = relative.split(path.sep).join("/");
  if (config.excludedPaths.some((part) => normalized === part || normalized.startsWith(`${part}/`))) return false;
  return config.allowedPaths.some((part) => part === "." || normalized === part || normalized.startsWith(`${part}/`));
}

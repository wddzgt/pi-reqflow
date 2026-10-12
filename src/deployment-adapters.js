import { promises as fs } from "node:fs";
import { sha256 } from "./files.js";
import { resolveDeploymentCredentials } from "./deployment-credentials.js";

const adapters = new Map();
const reserved = ["local", "jenkins", "none", "unconfigured"];

export function registerDeploymentAdapter(kind, adapter) {
  if (typeof kind !== "string" || !/^[a-z][a-z0-9-]{1,40}$/.test(kind) || reserved.includes(kind)
      || adapters.has(kind)) throw new Error(`Deployment adapter name is reserved, invalid or already registered: ${kind}`);
  if (!adapter || typeof adapter.version !== "string" || !adapter.version.trim() || adapter.version.length > 64
      || typeof adapter.requiresPublishedRevision !== "boolean" || typeof adapter.validateOptions !== "function"
      || typeof adapter.submit !== "function" || adapter.poll !== undefined && typeof adapter.poll !== "function") {
    throw new Error("Deployment adapter needs version, requiresPublishedRevision, synchronous validateOptions and submit; poll is optional");
  }
  if (adapter.validateOptions.constructor.name === "AsyncFunction") throw new Error("Deployment option validation must be synchronous");
  adapters.set(kind, Object.freeze({ ...adapter }));
}

export function deploymentAdapter(config) {
  const adapter = adapters.get(config.kind);
  if (!adapter) throw new Error(`Deployment adapter is not registered: ${config.kind}`);
  if (config.adapterVersion !== adapter.version) throw new Error(`Deployment adapter version differs from project config: ${config.kind}`);
  return adapter;
}

export function isRegisteredDeployment(kind) { return adapters.has(kind); }

export function deploymentRequiresPublishedRevision(config) {
  if (config.kind === "jenkins") return true;
  if (["local", "unconfigured", "none"].includes(config.kind)) return false;
  return deploymentAdapter(config).requiresPublishedRevision;
}

export function validateDeploymentOptions(config) {
  const result = deploymentAdapter(config).validateOptions(structuredClone(config.options));
  if (result !== undefined) throw new Error("Deployment option validation must throw on invalid input and return nothing on success");
}

export async function runDeploymentAdapter(config, task, previous, logFile, limits) {
  const adapter = deploymentAdapter(config);
  const action = previous === null ? "submit" : "poll";
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1
      || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1
      || limits.maxBytes !== null && (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1)) throw new Error("Deployment adapter requires a positive timeout and explicit nullable log storage cap");
  if (action === "poll" && !adapter.poll) throw new Error(`Deployment adapter cannot poll: ${config.kind}`);
  if (!["test", "production"].includes(limits.environment) || !/^[a-f0-9]{64}$/.test(limits.sourceHash ?? "")
      || !/^[a-f0-9]{64}$/.test(task.planHash ?? "") || !/^[a-f0-9]{64}$/.test(task.contractHash ?? "")
      || typeof task.id !== "string" || !task.id.trim() || typeof task.workspace !== "string" || !task.workspace.trim()) {
    throw new Error("Deployment adapter requires the verified task, target environment and source hash");
  }
  const revision = adapter.requiresPublishedRevision ? task.publishedRevision : limits.sourceHash;
  if (typeof revision !== "string" || !revision.trim()) throw new Error("Deployment adapter requires a published revision");
  const request = { taskId: task.id, environment: limits.environment, workspace: task.workspace,
    sourceHash: limits.sourceHash, revision, planHash: task.planHash, contractHash: task.contractHash,
    branch: task.branch ?? null };
  request.operationKey = sha256(JSON.stringify({ ...request, config }));
  if (previous !== null && (previous.kind !== config.kind || previous.adapterVersion !== adapter.version
      || previous.operationKey !== request.operationKey || previous.status !== "running")) throw new Error("Deployment polling receipt differs from the verified task or adapter");
  const credentials = await resolveDeploymentCredentials(config.credentialsEnv, config.credentialId, limits.credentialArchive);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Deployment adapter ${action} timed out: ${config.kind}`);
      controller.abort(error); reject(error);
    }, Math.min(config.timeoutMs, limits.timeoutMs));
  });
  let receipt;
  try {
    receipt = await Promise.race([Promise.resolve().then(() => adapter[action]({ request: Object.freeze(request),
      options: structuredClone(config.options), credentials: Object.freeze(credentials),
      signal: controller.signal }, previous === null ? null : structuredClone(previous))), timeout]);
  } finally { clearTimeout(timer); }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || Object.keys(receipt).some(key => !["status", "operationId", "revision", "url", "evidence"].includes(key))
      || !["running", "succeeded", "failed"].includes(receipt.status)
      || typeof receipt.operationId !== "string" || !receipt.operationId.trim() || receipt.operationId.length > 256
      || receipt.revision !== revision || typeof receipt.evidence !== "string" || !receipt.evidence.trim() || receipt.evidence.length > 4000
      || receipt.status === "running" && !adapter.poll || previous !== null && receipt.operationId !== previous.operationId) {
    throw new Error("Invalid deployment receipt: explicit status, stable operationId, exact revision and evidence are required");
  }
  if (receipt.url !== undefined) {
    if (typeof receipt.url !== "string" || receipt.url.length > 2048) throw new Error("Invalid deployment receipt URL");
    const url = new URL(receipt.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Deployment receipt URL must be HTTP(S) without embedded credentials");
  }
  const result = { ...receipt, kind: config.kind, adapterVersion: adapter.version, operationKey: request.operationKey };
  const line = `${JSON.stringify({ action, request, deployment: result })}\n`;
  const existingBytes = action === "submit" ? 0 : (await fs.stat(logFile)).size;
    if (limits.maxBytes !== null && existingBytes + Buffer.byteLength(line) > limits.maxBytes) throw new Error("Deployment evidence exceeds the configured log byte limit");
  await fs.writeFile(logFile, line, { flag: action === "submit" ? "wx" : "a", mode: 0o600 });
  return result;
}

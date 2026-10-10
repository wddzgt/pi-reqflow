import { runCommand } from "./commands.js";
import { promises as fs } from "node:fs";
import { isRegisteredDeployment, runDeploymentAdapter } from "./deployment-adapters.js";
import { resolveDeploymentCredentials } from "./deployment-credentials.js";
import "./ci-deployment-adapters.js";

export { registerDeploymentAdapter, deploymentRequiresPublishedRevision } from "./deployment-adapters.js";

async function jenkinsAuth(config, credentialArchive) {
  const credentials = await resolveDeploymentCredentials([config.userEnv, config.tokenEnv], config.credentialId, credentialArchive);
  const user = credentials[config.userEnv];
  const token = credentials[config.tokenEnv];
  if (!user || !token) throw new Error(`Jenkins credentials missing: ${config.userEnv}, ${config.tokenEnv}`);
  return { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` };
}

async function jenkinsJson(url, headers, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Jenkins request timed out");
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(remainingMs) });
  if (!response.ok) throw new Error(`Jenkins GET failed: ${response.status} ${url}`);
  return response.json();
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deployConfigured(config, task, logFile, limits) {
  if (isRegisteredDeployment(config.kind)) return runDeploymentAdapter(config, task, null, logFile, limits);
  if (config.kind === "local") {
    const result = await runCommand(config.command, task.workspace, limits.timeoutMs, logFile,
      limits.maxBytes, limits.envNames);
    if (result.code !== 0) throw new Error(`Local test deployment failed: ${result.tail}`);
    return { kind: "local", command: config.command, status: "succeeded", ...result };
  }
  if (config.kind !== "jenkins") throw new Error(`Unsupported test deployment: ${config.kind}`);
  if (!task.branch || !task.publishedRevision) throw new Error("Jenkins deployment requires a published Git branch revision");
  const headers = await jenkinsAuth(config, limits.credentialArchive);
  const base = new URL(config.baseUrl);
  const job = new URL(`${config.jobPath.replace(/^\//, "").replace(/\/$/, "")}/`, base);
  const parameters = new URLSearchParams({ REQ_ID: task.id, BRANCH: task.branch, REVISION: task.publishedRevision,
    PLAN_SHA256: task.planHash, CONTRACT_SHA256: task.contractHash, DEPLOY_ENV: limits.environment });
  const response = await fetch(new URL("buildWithParameters", job), {
    method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: parameters,
    redirect: "error", signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (response.status !== 201 || !response.headers.get("location")) {
    throw new Error(`Jenkins did not create a queue item: ${response.status}`);
  }
  const queueUrl = new URL(response.headers.get("location"), base);
  if (queueUrl.origin !== base.origin) throw new Error("Jenkins queue URL changed origin");
  return { kind: "jenkins", queueUrl: queueUrl.href, status: "running" };
}

export async function verifyTestEnvironment(config, logFile, timeoutMs) {
  if (config.url === undefined) return { status: "address_unconfigured" };
  let response;
  try { response = await fetch(config.url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)) }); }
  catch (error) {
    await fs.appendFile(logFile, `\n${JSON.stringify({ testEnvironment: { status: "unreachable", url: config.url, error: error.message, checkedAt: new Date().toISOString() } })}\n`);
    throw new Error(`测试部署已执行，但验证地址暂不可访问：${config.url}；${error.message}`, { cause: error });
  }
  const result = { status: response.ok ? "reachable" : "http_error", url: config.url,
    observedUrl: response.url, httpStatus: response.status, checkedAt: new Date().toISOString() };
  await response.body?.cancel();
  await fs.appendFile(logFile, `\n${JSON.stringify({ testEnvironment: result })}\n`);
  if (!response.ok) throw new Error(`测试部署已执行，但验证地址返回 HTTP ${response.status}：${config.url}`);
  return result;
}

export async function waitForJenkins(config, queueUrlValue, logFile, limits = {}) {
  const headers = await jenkinsAuth(config, limits.credentialArchive);
  const queueUrl = new URL(queueUrlValue);
  if (queueUrl.origin !== new URL(config.baseUrl).origin) throw new Error("Jenkins queue URL changed origin");
  const deadline = Date.now() + config.timeoutMs;
  let buildUrl;
  while (Date.now() < deadline) {
    const queue = await jenkinsJson(new URL("api/json", queueUrl), headers, deadline);
    if (queue.cancelled) throw new Error("Jenkins queue item was cancelled");
    if (queue.executable?.url) {
      buildUrl = new URL(queue.executable.url);
      if (buildUrl.origin !== new URL(config.baseUrl).origin) throw new Error("Jenkins build URL changed origin");
      break;
    }
    await delay(Math.min(1500, Math.max(0, deadline - Date.now())));
  }
  if (!buildUrl) throw new Error("Jenkins queue timed out");
  while (Date.now() < deadline) {
    const build = await jenkinsJson(new URL("api/json", buildUrl), headers, deadline);
    if (!build.building) {
      if (limits.expectedRevision !== undefined) {
        const parameter = build.actions?.flatMap(action => action.parameters ?? []).find(value => value.name === "REVISION");
        if (parameter?.value !== limits.expectedRevision) throw new Error("Jenkins 构建记录的 REVISION 与已验证代码不一致。");
      }
      const result = { kind: "jenkins", queueUrl: queueUrl.href, buildUrl: buildUrl.href, number: build.number, result: build.result,
        status: build.result === "SUCCESS" ? "succeeded" : "failed" };
      if (limits.expectedRevision !== undefined) result.revision = limits.expectedRevision;
      await fs.writeFile(logFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return result;
    }
    await delay(Math.min(1500, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Jenkins build timed out");
}

export async function pollConfiguredDeployment(config, task, previous, logFile, limits) {
  if (config.kind === "jenkins") return waitForJenkins(config, previous.queueUrl, logFile, { ...limits, expectedRevision: task.publishedRevision });
  if (!isRegisteredDeployment(config.kind)) throw new Error(`Deployment does not support polling: ${config.kind}`);
  const deadline = Date.now() + Math.min(config.timeoutMs, limits.timeoutMs);
  let receipt = previous;
  while (Date.now() < deadline) {
    receipt = await runDeploymentAdapter(config, task, receipt, logFile, { ...limits, timeoutMs: deadline - Date.now() });
    if (receipt.status !== "running") return receipt;
    await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Deployment polling timed out: ${config.kind}; query the existing operation again, do not resubmit`);
}

import { registerDeploymentAdapter } from "./deployment-adapters.js";

function validateOptions(options, fields) {
  if (Object.keys(options).some(key => !fields.includes(key)) || fields.some(key => typeof options[key] !== "string" || !options[key].trim())) throw new Error("发布平台配置缺少必要字段或含未知字段。");
  const url = new URL(options.baseUrl);
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/")
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("发布平台地址必须为 HTTPS（本机测试可用 HTTP），以 / 结尾且不含凭据。");
  if (!/^[A-Z][A-Z0-9_]+$/.test(options.tokenEnv)) throw new Error("Invalid CI credential name");
}

async function jsonRequest(url, context, method = "GET", body) {
  const token = context.credentials[context.options.tokenEnv];
  if (!token) throw new Error("发布平台凭据未配置。");
  const headers = context.provider === "gitlab" ? { "PRIVATE-TOKEN": token }
    : { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: context.signal, redirect: "error" });
  if (!response.ok) throw new Error(`${context.provider} ${method} failed: HTTP ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

function gitlabReceipt(data, request, baseUrl) {
  if (!Number.isSafeInteger(data?.id) || data.id < 1 || data.sha !== request.revision || typeof data.status !== "string") throw new Error("GitLab 返回的流水线编号或代码版本不一致。");
  const running = ["created", "waiting_for_resource", "preparing", "pending", "running", "waiting_for_callback", "canceling"];
  if (![...running, "success", "failed", "canceled", "skipped", "manual", "scheduled"].includes(data.status)) throw new Error(`Unknown GitLab pipeline status: ${data.status}`);
  const status = running.includes(data.status) ? "running" : data.status === "success" ? "succeeded" : "failed";
  if (typeof data.web_url !== "string") throw new Error("GitLab 未返回流水线地址。");
  const url = new URL(data.web_url);
  if (url.origin !== new URL(baseUrl).origin || url.username || url.password) throw new Error("GitLab 流水线地址不属于已配置的平台或含凭据。");
  return { status, operationId: String(data.id), revision: data.sha, evidence: `GitLab pipeline ${data.id}: ${data.status}; ${data.web_url}` };
}

registerDeploymentAdapter("gitlab", {
  version: "1", requiresPublishedRevision: true,
  validateOptions(options) {
    validateOptions(options, ["baseUrl", "projectId", "tokenEnv"]);
    if (!/^[1-9][0-9]*$/.test(options.projectId)) throw new Error("请填写 GitLab 项目数字 ID。");
  },
  async submit(context) {
    const { request, options } = context;
    const url = new URL(`api/v4/projects/${options.projectId}/pipeline`, options.baseUrl);
    const data = await jsonRequest(url, { ...context, provider: "gitlab" }, "POST", { ref: request.branch,
      variables: Object.entries({ REQ_ID: request.taskId, REVISION: request.revision,
        PLAN_SHA256: request.planHash, CONTRACT_SHA256: request.contractHash, DEPLOY_ENV: request.environment })
        .map(([key, value]) => ({ key, value })) });
    return gitlabReceipt(data, request, options.baseUrl);
  },
  async poll(context, previous) {
    const { options, request } = context;
    if (!/^[1-9][0-9]*$/.test(previous.operationId)) throw new Error("Invalid GitLab pipeline ID");
    const data = await jsonRequest(new URL(`api/v4/projects/${options.projectId}/pipelines/${previous.operationId}`, options.baseUrl), { ...context, provider: "gitlab" });
    return gitlabReceipt(data, request, options.baseUrl);
  },
});

registerDeploymentAdapter("github", {
  version: "1", requiresPublishedRevision: true,
  validateOptions(options) {
    validateOptions(options, ["baseUrl", "owner", "repository", "workflow", "tokenEnv"]);
    if (![options.owner, options.repository].every(value => /^[A-Za-z0-9_.-]+$/.test(value))
        || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(options.workflow)) throw new Error("请填写 GitHub 仓库所属组织、仓库名和工作流文件名（例如 deploy-test.yml）。");
  },
  async submit(context) {
    const { request, options } = context;
    const endpoint = `repos/${options.owner}/${options.repository}/actions/workflows/${encodeURIComponent(options.workflow)}/dispatches`;
    const data = await jsonRequest(new URL(endpoint, options.baseUrl), { ...context, provider: "github" }, "POST", {
      ref: request.branch, inputs: { req_id: request.taskId, revision: request.revision,
        plan_sha256: request.planHash, contract_sha256: request.contractHash, deploy_env: request.environment },
    });
    if (!Number.isSafeInteger(data?.workflow_run_id) || data.workflow_run_id < 1) throw new Error("GitHub 未返回唯一运行编号；请核实外部结果，不可重复发布。此接入需要支持返回运行编号的 workflow dispatch API。");
    return { status: "running", operationId: String(data.workflow_run_id), revision: request.revision,
      evidence: `GitHub Actions run ${data.workflow_run_id}: dispatched` };
  },
  async poll(context, previous) {
    const { request, options } = context;
    if (!/^[1-9][0-9]*$/.test(previous.operationId)) throw new Error("Invalid GitHub run ID");
    const data = await jsonRequest(new URL(`repos/${options.owner}/${options.repository}/actions/runs/${previous.operationId}`, options.baseUrl), { ...context, provider: "github" });
    if (String(data?.id) !== previous.operationId || data.head_sha !== request.revision || data.head_branch !== request.branch) throw new Error("GitHub 运行编号、分支或代码版本不一致。");
    if (!["queued", "in_progress", "waiting", "pending", "requested", "completed"].includes(data.status)) throw new Error(`Unknown GitHub run status: ${data.status}`);
    if (data.status === "completed" && !["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"].includes(data.conclusion)) throw new Error("GitHub 工作流未返回明确执行结论。");
    return { status: data.status !== "completed" ? "running" : data.conclusion === "success" ? "succeeded" : "failed",
      operationId: previous.operationId, revision: data.head_sha, evidence: `GitHub Actions run ${data.id}: ${data.status} / ${data.conclusion}` };
  },
});

export async function inspectCiConnection(kind, options, credentials, signal) {
  const context = { provider: kind, options, credentials, signal };
  if (kind === "gitlab") {
    validateOptions(options, ["baseUrl", "projectId", "tokenEnv"]);
    const project = await jsonRequest(new URL(`api/v4/projects/${encodeURIComponent(options.projectId)}`, options.baseUrl), context);
    if (String(project?.id) !== options.projectId || typeof project.path_with_namespace !== "string") throw new Error("GitLab 未返回匹配的项目。");
    return { name: project.path_with_namespace };
  }
  if (kind !== "github") throw new Error("Unsupported CI connection");
  validateOptions(options, ["baseUrl", "owner", "repository", "workflow", "tokenEnv"]);
  const workflow = await jsonRequest(new URL(`repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}/actions/workflows/${encodeURIComponent(options.workflow)}`, options.baseUrl), context);
  if (typeof workflow?.name !== "string" || workflow.state !== "active") throw new Error("GitHub 工作流不存在或未启用。");
  return { name: workflow.name };
}

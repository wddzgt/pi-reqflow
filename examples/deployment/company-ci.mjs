// 示例公司发布网关协议，不代表已接入任何特定 CI 产品。
import { registerDeploymentAdapter } from "../../src/core.js";

registerDeploymentAdapter("company-ci", {
  version: "1",
  requiresPublishedRevision: true,
  validateOptions(options) {
    if (Object.keys(options).some(key => !["baseUrl", "project"].includes(key))) throw new Error("Unknown company-ci option");
    if (typeof options.baseUrl !== "string" || typeof options.project !== "string" || !options.project.trim()) throw new Error("company-ci needs baseUrl and project");
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/")) throw new Error("company-ci baseUrl must end with / and contain no credentials, query or fragment");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("company-ci requires HTTPS, except for localhost tests");
  },
  async submit({ request, options, credentials, signal }) {
    if (!credentials.COMPANY_DEPLOY_TOKEN) throw new Error("company-ci requires COMPANY_DEPLOY_TOKEN in credentialsEnv");
    const response = await fetch(new URL("deployments", options.baseUrl), {
      method: "POST", signal, redirect: "error",
      headers: { Authorization: `Bearer ${credentials.COMPANY_DEPLOY_TOKEN}`,
        "Content-Type": "application/json", "Idempotency-Key": request.operationKey },
      body: JSON.stringify({ project: options.project, taskId: request.taskId, environment: request.environment,
        revision: request.revision, branch: request.branch, sourceHash: request.sourceHash,
        planHash: request.planHash, contractHash: request.contractHash }),
    });
    if (!response.ok) throw new Error(`company-ci submission failed: HTTP ${response.status}; reconcile external outcome before any new submission`);
    return response.json(); // 网关返回约定的回执，核心校验版本、状态及字段。
  },
  async poll({ options, credentials, signal }, previous) {
    if (!credentials.COMPANY_DEPLOY_TOKEN) throw new Error("company-ci requires COMPANY_DEPLOY_TOKEN in credentialsEnv");
    const response = await fetch(new URL(`deployments/${encodeURIComponent(previous.operationId)}`, options.baseUrl), {
      signal, redirect: "error", headers: { Authorization: `Bearer ${credentials.COMPANY_DEPLOY_TOKEN}` },
    });
    if (!response.ok) throw new Error(`company-ci query failed: HTTP ${response.status}`);
    return response.json();
  },
});

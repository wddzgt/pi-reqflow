import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, quote } from "shell-quote";
import { loadProject, validateConfig } from "./config.js";
import { sha256, writeJson } from "./files.js";
import { withLock } from "./store.js";
import { refreshProjectBaseline } from "./baseline.js";
import { saveDeploymentCredentials, resolveDeploymentCredentials } from "./deployment-credentials.js";
import { inspectCiConnection } from "./ci-deployment-adapters.js";
import { validateDeploymentOptions } from "./deployment-adapters.js";
import { assertEnvironmentIdle } from "./local-environment.js";

export async function executionConfigurationHistory(project) {
  const events = await fs.readFile(path.join(project.archive, "execution-config-events.jsonl"), "utf8")
    .then(text => text.trim().split("\n").map(line => JSON.parse(line)),
      error => { if (error.code === "ENOENT") return []; throw error; });
  let previous = null;
  for (const event of events) {
    if (event.previous !== previous || sha256(JSON.stringify({ ...event, hash: undefined })) !== event.hash)
      throw new Error("执行配置审计记录已改变。");
    previous = event.hash;
  }
  return events;
}

export async function readExecutionSetup(projectPath) {
  const project = await loadProject(projectPath);
  const deployment = project.config.testDeployment;
  const remote = ["jenkins", "gitlab", "github"].includes(deployment.kind);
  const fields = deployment.kind === "jenkins" ? { baseUrl: deployment.baseUrl, jobPath: deployment.jobPath }
    : ["gitlab", "github"].includes(deployment.kind) ? { ...deployment.options } : {};
  delete fields.tokenEnv;
  const names = deployment.kind === "jenkins" ? [deployment.userEnv, deployment.tokenEnv] : deployment.credentialsEnv;
  const stored = remote && deployment.credentialId !== undefined
    ? await resolveDeploymentCredentials(names, deployment.credentialId, project.archive) : null;
  if (deployment.kind === "jenkins" && stored) fields.username = stored[deployment.userEnv];
  return { configHash: sha256(JSON.stringify(project.config)), kind: deployment.kind, mode: project.config.mode,
    gitDelivery: project.config.gitDelivery ?? (project.config.mode === "git" ? { testMode: "branch" } : null),
    fields, credentialConfigured: remote && (stored !== null || names.every(name => Boolean(process.env[name]))),
    timeoutMs: remote ? deployment.timeoutMs : project.config.maxPiMs,
    checksText: project.config.checks.map(command => quote(command)).join("\n"),
    deployCommand: project.config.testDeployment.kind === "local" ? quote(project.config.testDeployment.command) : "",
    url: project.config.testDeployment.url ?? "", checksEnvironment: project.config.environment.checks,
    deploymentEnvironment: project.config.environment.localDeployment };
}

export async function configureExecution(projectPath, actor, input) {
  if (!input || typeof input.checksText !== "string" || input.checksText.length > 8000
       || typeof input.url !== "string"
       || !/^[a-f0-9]{64}$/.test(input.expectedConfigHash ?? "")) throw new Error("测试环境配置格式不正确，请刷新后重新保存。");
  if (!["unconfigured", "local", "jenkins", "gitlab", "github"].includes(input.kind)) throw new Error("请选择固定测试环境的发布方式，或选择暂不连接。");
  if (input.kind !== "unconfigured" && !input.url.trim()) throw new Error("连接固定测试环境时，请填写真实环境地址；自动检查由研发确认。");
  if (input.kind === "unconfigured" && input.url.trim()) throw new Error("暂不连接固定测试环境时不填写环境地址；本地人工验证由负责研发在需求中选择。");
  if (Object.keys(input).some(key => !["kind", "checksText", "deployCommand", "url", "expectedConfigHash", "fields", "timeoutMs", "checksEnvironment", "deploymentEnvironment", "gitDelivery"].includes(key))) throw new Error("发布设置包含未知字段。");
  if (input.kind === "local" && (typeof input.deployCommand !== "string" || !input.deployCommand.trim() || input.deployCommand.length > 2000)) throw new Error("请填写项目已有的部署脚本命令。");
  const lines = input.checksText.trim() ? input.checksText.trim().split(/\r?\n/) : [];
  if (lines.length > 20 || lines.some(line => !line.trim())) throw new Error("测试命令最多20条，每行一条，不能包含空行。");
  const commands = (input.kind === "local" ? [...lines, input.deployCommand] : lines).map(line => {
    const argv = parse(line, name => { throw new Error(`命令不能展开环境变量 ${name}；请在环境变量授权中配置名称，或使用已有部署脚本。`); });
    if (!argv.length || argv.some(value => typeof value !== "string" || !value.trim() || value.includes("\0"))) throw new Error("命令应由程序和参数组成；复合命令、重定向和通配符请放进项目已有脚本。");
    return argv;
  });
  const project = await loadProject(projectPath);
  return withLock(path.join(project.archive, "execution-config.lock"), async () => {
    const current = await loadProject(projectPath);
    if (sha256(JSON.stringify(current.config)) !== input.expectedConfigHash) throw new Error("项目配置已改变，请刷新后再保存。");
    if (!["local", "unconfigured", "jenkins", "gitlab", "github"].includes(current.config.testDeployment.kind)) throw new Error(`当前项目使用 ${current.config.testDeployment.kind} 部署适配器；请维护已有配置。`);
    await assertEnvironmentIdle(current);
    let deployment;
    if (input.kind === "unconfigured") deployment = { kind: "unconfigured" };
    else if (input.kind === "local") deployment = { kind: "local", command: commands.at(-1), url: input.url };
    else {
      if (current.config.mode !== "git") throw new Error("Jenkins、GitLab 和 GitHub 从 Git 获取代码。请在原 Git 项目使用 git 模式初始化；目录复制项目可使用已有部署脚本。");
      if (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)
          || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error("请填写发布平台信息和有效超时。");
      const allowed = input.kind === "jenkins" ? ["baseUrl", "jobPath", "username", "token"] : input.kind === "gitlab"
        ? ["baseUrl", "projectId", "token"] : ["baseUrl", "owner", "repository", "workflow", "token"];
      if (Object.keys(input.fields).some(key => !allowed.includes(key))) throw new Error("发布平台包含未知字段。");
      const { baseUrl } = input.fields;
      const tokenEnv = input.kind === "jenkins" ? "JENKINS_TOKEN" : input.kind === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN";
      if (input.kind === "jenkins") deployment = { kind: "jenkins", baseUrl, jobPath: input.fields.jobPath,
        userEnv: "JENKINS_USER", tokenEnv, timeoutMs: input.timeoutMs, url: input.url };
      else deployment = { kind: input.kind, adapterVersion: "1", credentialsEnv: [tokenEnv],
        options: input.kind === "gitlab" ? { baseUrl, projectId: input.fields.projectId, tokenEnv }
          : { baseUrl, owner: input.fields.owner, repository: input.fields.repository, workflow: input.fields.workflow, tokenEnv },
        timeoutMs: input.timeoutMs, url: input.url };
      validateConfig({ ...current.config, testDeployment: deployment });
      if (input.fields.token !== undefined && input.fields.token !== "") {
        const values = { [tokenEnv]: input.fields.token };
        if (input.kind === "jenkins") values.JENKINS_USER = input.fields.username;
        deployment.credentialId = await saveDeploymentCredentials(current.archive, values);
      } else {
        if (current.config.testDeployment.kind !== input.kind) throw new Error("首次配置该发布平台需要填写访问令牌。");
        const prior = current.config.testDeployment;
        const priorUrl = input.kind === "jenkins" ? prior.baseUrl : prior.options.baseUrl;
        if (new URL(priorUrl).origin !== new URL(baseUrl).origin) throw new Error("发布平台地址已改变，请重新填写该平台的访问令牌。");
        const priorNames = input.kind === "jenkins" ? [prior.userEnv, prior.tokenEnv] : prior.credentialsEnv;
        const values = await resolveDeploymentCredentials(priorNames, prior.credentialId, current.archive);
        const token = values[input.kind === "jenkins" ? prior.tokenEnv : prior.options.tokenEnv];
        const nextValues = { [tokenEnv]: token };
        if (input.kind === "jenkins") nextValues.JENKINS_USER = input.fields.username;
        deployment.credentialId = await saveDeploymentCredentials(current.archive, nextValues);
      }
    }
    const next = validateConfig({ ...current.config, checks: input.kind === "local" ? commands.slice(0, -1) : commands,
      ...(input.gitDelivery === undefined ? {} : { gitDelivery: input.gitDelivery }),
      environment: { ...current.config.environment, checks: input.checksEnvironment, localDeployment: input.deploymentEnvironment },
      testDeployment: deployment });
    const file = path.join(current.archive, "execution-config-events.jsonl");
    const history = await executionConfigurationHistory(current);
    const previous = history.at(-1)?.hash ?? null;
    const event = { actor, at: new Date().toISOString(), previous, priorConfigHash: input.expectedConfigHash,
      configHash: sha256(JSON.stringify(next)), checks: next.checks, testDeployment: next.testDeployment,
      gitDelivery: next.gitDelivery ?? null,
      environment: { checks: next.environment.checks, localDeployment: next.environment.localDeployment } };
    event.hash = sha256(JSON.stringify(event));
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await writeJson(path.join(current.archive, "config.json"), next);
    try { await refreshProjectBaseline({ ...current, config: next }); }
    catch (error) { throw new Error(`执行配置已保存并留痕，项目参考刷新未完成：${error.message}。修复原因后重新保存即可继续。`, { cause: error }); }
    return readExecutionSetup(projectPath);
  });
}

export async function verifyDeploymentConnection(projectPath, input) {
  if (!input || !["jenkins", "gitlab", "github"].includes(input.kind) || !input.fields || typeof input.fields !== "object") throw new Error("请选择发布平台并填写连接信息。");
  const project = await loadProject(projectPath);
  const prior = project.config.testDeployment;
  let token = input.fields.token;
  let username = input.fields.username;
  if (token === "" || token === undefined) {
    if (prior.kind !== input.kind) throw new Error("首次验证连接需要填写访问令牌。");
    const priorUrl = input.kind === "jenkins" ? prior.baseUrl : prior.options.baseUrl;
    if (new URL(priorUrl).origin !== new URL(input.fields.baseUrl).origin) throw new Error("发布平台地址已改变，请重新填写该平台的访问令牌。");
    const names = input.kind === "jenkins" ? [prior.userEnv, prior.tokenEnv] : prior.credentialsEnv;
    const saved = await resolveDeploymentCredentials(names, prior.credentialId, project.archive);
    token = saved[input.kind === "jenkins" ? prior.tokenEnv : prior.options.tokenEnv];
  }
  if (typeof token !== "string" || !token.trim() || token.length > 16384 || /[\r\n]/.test(token)) throw new Error("请填写有效的访问令牌。");
  const signal = AbortSignal.timeout(10000);
  const baseUrl = input.fields.baseUrl;
  if (input.kind !== "jenkins") {
    const tokenEnv = input.kind === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN";
    const options = input.kind === "gitlab" ? { baseUrl, projectId: input.fields.projectId, tokenEnv }
      : { baseUrl, owner: input.fields.owner, repository: input.fields.repository, workflow: input.fields.workflow, tokenEnv };
    validateDeploymentOptions({ kind: input.kind, adapterVersion: "1", options });
    return { connected: true, ...await inspectCiConnection(input.kind, options, { [tokenEnv]: token }, signal) };
  }
  const config = { ...project.config, testDeployment: { kind: "jenkins", baseUrl, jobPath: input.fields.jobPath,
    userEnv: "JENKINS_USER", tokenEnv: "JENKINS_TOKEN", timeoutMs: 10000 } };
  validateConfig(config);
  if (typeof username !== "string" || !username.trim() || /[\r\n]/.test(username)) throw new Error("请填写 Jenkins 用户名。");
  const job = new URL(`${input.fields.jobPath.replace(/\/$/, "")}/api/json`, baseUrl);
  const response = await fetch(job, { signal, redirect: "error", headers: { Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}` } });
  if (!response.ok) throw new Error(`Jenkins 连接验证失败：HTTP ${response.status}`);
  const data = await response.json();
  if (typeof data.name !== "string" || data.buildable !== true) throw new Error("Jenkins 作业不存在或不能构建。");
  return { connected: true, name: data.name };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadProject, validateConfig, defaultModelUsage, validateModelParameters, modelAgents } from "./config.js";
import { readJson, sha256, writeJson } from "./files.js";
import { withLock } from "./store.js";
import { refreshProjectBaseline } from "./baseline.js";
import { readModelCredential, saveModelCredential } from "./model-credentials.js";

export { modelAgents } from "./config.js";

function profile(config, selection = config) {
  const provider = config.compatibleProviders?.find(row => row.name === selection.provider);
  const model = provider?.models.find(row => row.id === selection.model);
  return { provider: selection.provider === "unconfigured" ? "" : provider?.displayName ?? selection.provider,
    model: selection.model === "unconfigured" ? "" : selection.model, baseUrl: provider?.baseUrl ?? "",
    thinking: selection.thinking ?? config.thinking ?? "off", thinkingToggle: provider?.thinkingToggle ?? false,
    contextWindow: model?.contextWindow ?? 65536, maxTokens: model?.maxTokens ?? 8192,
    reasoning: model?.reasoning ?? false, supportsReasoningEffort: model?.supportsReasoningEffort ?? false,
    supportsJsonSchema: model?.supportsJsonSchema ?? false, imageInput: model?.input.includes("image") ?? false,
    credentialConfigured: Boolean(provider && (provider.credentialId || process.env[provider.apiKeyEnv])),
    modelParameters: { ...config.modelParameters, ...selection.modelParameters },
    modelUsage: { ...defaultModelUsage, ...config.modelUsage, ...selection.modelUsage },
    maxPiMs: selection.maxPiMs ?? config.maxPiMs, maxToolCalls: selection.maxToolCalls ?? config.maxToolCalls };
}

export async function readModelSettings(projectPath) {
  const { config } = await loadProject(projectPath);
  const primary = profile(config);
  return { expectedConfigHash: sha256(JSON.stringify(config)), default: primary,
    agents: Object.fromEntries(modelAgents.map(agent => {
      const selected = config.agentModels?.[agent];
      return [agent, selected ? profile(config, selected) : null];
    })), maxCostUsd: config.maxCostUsd };
}

function validateProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["provider", "model", "baseUrl", "apiKey", "thinking", "thinkingToggle", "contextWindow", "maxTokens", "reasoning", "supportsReasoningEffort", "supportsJsonSchema", "imageInput", "modelParameters", "modelUsage", "maxPiMs", "maxToolCalls"].includes(key))) throw new Error("模型配置格式不正确。");
  validateModelParameters(input.modelParameters);
  if (input.apiKey !== undefined && (typeof input.apiKey !== "string" || input.apiKey.length > 16384 || /[\r\n\0]/.test(input.apiKey))) throw new Error("API Key 格式不正确。");
  for (const field of ["thinkingToggle", "reasoning", "supportsReasoningEffort", "supportsJsonSchema", "imageInput"]) if (typeof input[field] !== "boolean") throw new Error(`模型能力 ${field} 必须明确配置。`);
}

function providerFor(input, name, apiKeyEnv) {
  return { name, displayName: input.provider, apiKeyEnv, baseUrl: input.baseUrl, thinkingToggle: input.thinkingToggle,
    models: [{ id: input.model, input: input.imageInput ? ["text", "image"] : ["text"],
      contextWindow: input.contextWindow, maxTokens: input.maxTokens, reasoning: input.reasoning,
      supportsReasoningEffort: input.supportsReasoningEffort, supportsJsonSchema: input.supportsJsonSchema }] };
}

function settingsConfig(current, input) {
  if (!input || typeof input !== "object" || Object.keys(input).some(key => !["expectedConfigHash", "default", "agents", "maxCostUsd"].includes(key))
      || !/^[a-f0-9]{64}$/.test(input.expectedConfigHash ?? "") || !input.agents || typeof input.agents !== "object"
      || Array.isArray(input.agents) || Object.keys(input.agents).some(agent => !modelAgents.includes(agent))
      || modelAgents.some(agent => !Object.hasOwn(input.agents, agent))) throw new Error("请提交默认配置及所有 Agent 的配置或继承状态。");
  const providers = []; const agents = {};
  for (const scope of ["default", ...modelAgents]) {
    const value = scope === "default" ? input.default : input.agents[scope];
    if (scope !== "default" && value === null) continue;
    validateProfile(value);
    const name = `devsail-${scope}`; const apiKeyEnv = `DEVSAIL_MODEL_KEY_${scope.toUpperCase()}`;
    providers.push(providerFor(value, name, apiKeyEnv));
    if (scope !== "default") agents[scope] = { provider: name, model: value.model, thinking: value.thinking,
      modelParameters: value.modelParameters, modelUsage: value.modelUsage, maxPiMs: value.maxPiMs, maxToolCalls: value.maxToolCalls };
  }
  const previousNames = new Set((current.compatibleProviders ?? []).map(row => row.apiKeyEnv));
  const next = { ...current, provider: "devsail-default", model: input.default.model, thinking: input.default.thinking,
    structuredOutput: true, modelParameters: input.default.modelParameters, modelUsage: input.default.modelUsage,
    maxPiMs: input.default.maxPiMs, maxToolCalls: input.default.maxToolCalls, maxCostUsd: input.maxCostUsd,
    agentModels: agents, compatibleProviders: providers,
    environment: { ...current.environment, pi: [...current.environment.pi.filter(name => !previousNames.has(name)), ...providers.map(row => row.apiKeyEnv)] } };
  delete next.modelFallbacks;
  return validateConfig(next);
}

async function credentialFor(project, input, scope) {
  if (input.apiKey?.trim()) return input.apiKey.trim();
  const selected = scope === "default" ? project.config : project.config.agentModels?.[scope] ?? project.config;
  const prior = project.config.compatibleProviders?.find(row => row.name === selected.provider);
  if (!prior || new URL(prior.baseUrl).origin !== new URL(input.baseUrl).origin) throw new Error("首次配置或变更服务地址时，请填写该服务的 API Key。");
  if (prior.credentialId) return readModelCredential(project.accountsArchive ?? project.archive, prior.credentialId);
  if (!process.env[prior.apiKeyEnv]) throw new Error("该模型尚未配置可用 API Key。");
  return process.env[prior.apiKeyEnv];
}

export async function configureModels(projectPath, actor, input) {
  if (typeof actor !== "string" || !actor.trim()) throw new Error("模型设置需要具名管理员记录。");
  const project = await loadProject(projectPath);
  return withLock(path.join(project.archive, "execution-config.lock"), async () => {
    const current = await loadProject(projectPath);
    if (sha256(JSON.stringify(current.config)) !== input?.expectedConfigHash) throw new Error("模型配置已改变，请刷新后再保存。");
    const next = settingsConfig(current.config, input);
    const tasks = await readJson(path.join(current.archive, "index.json"));
    for (const row of tasks) {
      const locked = await fs.stat(path.join(current.archive, "tasks", row.id, "task.lock")).then(() => true,
        error => { if (error.code === "ENOENT") return false; throw error; });
      if (locked) throw new Error("有任务正在运行，请等待本轮完成后再修改模型配置。");
    }
    const keys = [];
    for (const provider of next.compatibleProviders) {
      const scope = provider.name.slice("devsail-".length);
      const value = scope === "default" ? input.default : input.agents[scope];
      if (scope !== "default" && !current.config.agentModels?.[scope] && !value.apiKey?.trim()
          && new URL(value.baseUrl).origin === new URL(input.default.baseUrl).origin) keys.push(keys[0]);
      else keys.push(await credentialFor(current, value, scope));
    }
    for (const [index, provider] of next.compatibleProviders.entries()) {
      provider.credentialId = await saveModelCredential(current.accountsArchive ?? current.archive, keys[index]);
    }
    const event = { actor, at: new Date().toISOString(), priorConfigHash: input.expectedConfigHash,
      configHash: sha256(JSON.stringify(next)), defaultModel: next.model,
      agentModels: next.agentModels, note: "管理员显式配置；未配置 Agent 继承默认；不自动切换模型" };
    await fs.appendFile(path.join(current.archive, "model-settings.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await writeJson(path.join(current.archive, "config.json"), next);
    await refreshProjectBaseline({ ...current, config: next });
    return readModelSettings(projectPath);
  });
}

export async function testModelConnection(projectPath, input, request = fetch) {
  if (!input || !["default", ...modelAgents].includes(input.scope)) throw new Error("请选择默认配置或具体 Agent。");
  const project = await loadProject(projectPath); const value = input.profile;
  validateProfile(value);
  const provider = providerFor(value, "connection-test", "DEVSAIL_CONNECTION_KEY");
  validateConfig({ ...project.config, provider: provider.name, model: value.model,
    thinking: value.thinking, modelParameters: value.modelParameters, modelUsage: value.modelUsage,
    maxPiMs: value.maxPiMs, maxToolCalls: value.maxToolCalls, compatibleProviders: [provider],
    environment: { ...project.config.environment, pi: [provider.apiKeyEnv] } });
  const schema = { name: "connection_test", strict: true, schema: { type: "object", additionalProperties: false,
    required: ["ok"], properties: { ok: { type: "boolean", enum: [true] } } } };
  const format = value.modelParameters.outputFormat ?? "auto";
  if (format === "json_schema" && !value.supportsJsonSchema) throw new Error("该模型未声明严格 Schema 能力，请选择自动或 JSON 模式。");
  const strict = format !== "json_object" && value.supportsJsonSchema;
  const payload = { model: value.model, stream: false, max_tokens: Math.min(value.maxTokens, 256),
    messages: [{ role: "user", content: 'Connection test. Return JSON exactly: {"ok":true}' }],
    response_format: strict ? { type: "json_schema", json_schema: schema } : { type: "json_object" } };
  if (value.thinkingToggle) payload.enable_thinking = value.thinking !== "off";
  if (value.supportsReasoningEffort && value.thinking !== "off") payload.reasoning_effort = value.thinking;
  if (value.modelParameters.temperature !== undefined) payload.temperature = value.modelParameters.temperature;
  if (value.modelParameters.topP !== undefined) payload.top_p = value.modelParameters.topP;
  const key = await credentialFor(project, value, input.scope);
  const started = Date.now(); let response;
  try {
    response = await request(new URL(`${value.baseUrl.replace(/\/$/, "")}/chat/completions`), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (error) { throw new Error(error.name === "TimeoutError" ? "模型连接测试超时。" : "无法连接模型服务，请检查 API 地址及网络。"); }
  if (!response.ok) {
    let result;
    try { result = await response.json(); }
    catch (error) { throw new Error(`模型服务未返回有效错误 JSON（HTTP ${response.status}）。`, { cause: error }); }
    const code = result.error?.code ?? result.error?.type ?? result.code;
    if (["AllocationQuota.FreeTierOnly", "insufficient_quota"].includes(code)) throw new Error("该模型额度已耗尽，请修改模型配置后重新测试。");
    if (response.status === 401 || ["InvalidApiKey", "invalid_api_key"].includes(code)) throw new Error("API Key 验证失败，请检查或替换密钥。");
    if (response.status === 429) throw new Error("模型服务请求受限，请稍后再测试。");
    throw new Error(`模型连接测试失败（HTTP ${response.status}），请检查模型名称、权限和参数能力。`);
  }
  let result; let answer;
  try { result = await response.json(); answer = JSON.parse(result.choices?.[0]?.message?.content); }
  catch (error) { throw new Error("模型已连接，但未返回有效的测试 JSON。", { cause: error }); }
  if (answer?.ok !== true || Object.keys(answer).length !== 1) throw new Error("模型已连接，但测试输出未满足约定 JSON 结构。");
  return { connected: true, model: value.model, elapsedMs: Date.now() - started,
    outputFormat: strict ? "json_schema" : "json_object", usage: result.usage ?? null };
}

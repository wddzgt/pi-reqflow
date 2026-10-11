// Conservative local caps, not advertised provider limits or price estimates.
export function bailianModelPreset(apiKeyEnv = "DASHSCOPE_API_KEY") {
  const models = ["qwen3.8-max", "qwen3.8-27b", "qwen3.8-2.4t-a95b", "glm-5.3"];
  return {
    provider: "reqflow-bailian", model: models[0], thinking: "off", structuredOutput: true,
    agentModels: {},
    compatibleProviders: [{ name: "reqflow-bailian", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv, thinkingToggle: true, models: models.map(id => ({ id, input: ["text"],
        reasoning: true, supportsReasoningEffort: ["glm-5.3", "qwen3.8-2.4t-a95b"].includes(id), supportsJsonSchema: id === models[0], contextWindow: 65536,
        maxTokens: ["glm-5.3", "qwen3.8-2.4t-a95b"].includes(id) ? 16384 : 8192 })) }],
  };
}

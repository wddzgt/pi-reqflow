import { sha256 } from "./files.js";

export const designSchema = { type: "object", additionalProperties: false,
  required: ["approach", "frontend", "backend", "data", "interfaces", "diagrams", "components"], properties: {
    approach: { type: "string", minLength: 1, maxLength: 4000, description: "Concise implementation choice and rationale; aim for 150–300 Chinese characters. Do not repeat requirements." },
    frontend: { type: "string", maxLength: 4000, description: "Relevant UI changes, states, calls and error handling; aim for 100–250 Chinese characters. Explain interactions in text even without a diagram." },
    backend: { type: "string", maxLength: 4000, description: "Relevant business logic, validation and compatibility; aim for 100–250 Chinese characters. Keep behavior consistent with the interface contract." },
    data: { type: "string", minLength: 1, maxLength: 2000, description: "Concrete data handling and recovery; aim for 100–200 Chinese characters." },
    interfaces: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false,
      required: ["name", "method", "path", "status", "sourceFile", "request", "response", "errors"], properties: {
        name: { type: "string", minLength: 1, maxLength: 120 }, method: { type: "string", minLength: 1, maxLength: 30 },
        path: { type: "string", minLength: 1, maxLength: 200 }, status: { type: "string", enum: ["existing", "modified", "new"] },
        sourceFile: { type: "string", maxLength: 500 },
        ...Object.fromEntries(["request", "response", "errors"].map(key => [key, { type: "string", minLength: 1, maxLength: 1200 }])) } } },
    diagrams: { type: "array", maxItems: 3,
      description: "Optional illustration: use [] for ordinary changes, including frontend/backend work. Include at most one short diagram only when it clarifies interactions or branching better than text; do not repeat the design in multiple diagrams.",
      items: { type: "object", additionalProperties: false,
      required: ["title", "kind", "domain", "source"], properties: {
        title: { type: "string", minLength: 1, maxLength: 120 }, kind: { type: "string", enum: ["flow", "sequence"] },
        domain: { type: "string", enum: ["frontend", "backend", "shared"] }, source: { type: "string", minLength: 1, maxLength: 4000,
          description: "Complete raw Mermaid source, without Markdown fences. For kind=flow the first line must be flowchart TD (or another valid direction); for kind=sequence the first line must be sequenceDiagram. Include this declaration before nodes or participants." } } } },
    components: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", additionalProperties: false,
      required: ["file", "domain", "location", "pseudocode"], properties: {
        file: { type: "string", minLength: 1 }, domain: { type: "string", enum: ["frontend", "backend", "shared"] },
        location: { type: "string", minLength: 1, maxLength: 500 }, pseudocode: { type: "string", maxLength: 1600,
          description: "Key logic only: concise pseudocode or a short code fragment, normally 5–10 lines, for nontrivial decisions, data mapping or write boundaries. Use an empty string for files without critical logic; no complete classes, components or boilerplate. At most 1600 characters." } } } },
  } };

export function validateDesign(draft) {
  const design = draft.design;
  if (!design || typeof design !== "object" || Array.isArray(design)) throw new Error("研发方案缺少完整设计说明。");
  if (Object.keys(design).some(key => !Object.hasOwn(designSchema.properties, key))) throw new Error("研发设计包含未知字段。");
  for (const [key, limit] of [["approach", 4000], ["frontend", 4000], ["backend", 4000], ["data", 2000]]) {
    if (typeof design[key] !== "string" || design[key].length > limit
        || (["approach", "data"].includes(key) && !design[key].trim())
        || (draft.domains.includes(key) && !design[key].trim())) throw new Error(`研发设计 ${key} 说明缺失或超过长度限制。`);
  }
  for (const [key, max] of [["interfaces", 12], ["diagrams", 3], ["components", 30]]) {
    if (!Array.isArray(design[key]) || design[key].length > max) throw new Error(`研发设计 ${key} 必须是有界数组。`);
    const schema = designSchema.properties[key].items;
    for (const [index, row] of design[key].entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)
          || Object.keys(row).some(field => !Object.hasOwn(schema.properties, field))) throw new Error(`研发设计 ${key} 条目无效。`);
      for (const [field, rule] of Object.entries(schema.properties)) {
        if (typeof row[field] === "string" && rule.maxLength && row[field].length > rule.maxLength) {
          throw new Error(`design.${key}[${index}].${field}${row.file ? ` (${row.file})` : ""} has ${row[field].length} characters; maximum is ${rule.maxLength}. Shorten this field to a concise design outline, keeping the other fields and acceptance unchanged.`);
        }
        if (typeof row[field] !== "string" || row[field].length > (rule.maxLength ?? 1000)
            || (rule.minLength && !row[field].trim()) || (rule.enum && !rule.enum.includes(row[field]))) throw new Error(`研发设计 ${key}.${field} 无效。`);
      }
    }
  }
  if (JSON.stringify(design.components.map(row => row.file)) !== JSON.stringify(draft.affectedFiles)) throw new Error("设计修改位置必须逐项对应已确认文件清单。");
  for (const row of [...design.components, ...design.diagrams]) {
    if (row.domain !== "shared" && !draft.domains.includes(row.domain)) throw new Error("设计职责与方案影响范围不一致，请重新核对前后端分工。");
  }
  for (const domain of draft.domains.filter(domain => ["frontend", "backend"].includes(domain))) {
    if (!design.components.some(row => [domain, "shared"].includes(row.domain))) throw new Error(`设计未列出 ${domain} 的修改位置。`);
  }
  for (const diagram of design.diagrams) {
    const declaration = diagram.kind === "sequence" ? /^sequenceDiagram\b/ : /^(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\b/;
    if (!declaration.test(diagram.source.trim())) {
      throw new Error(`流程图“${diagram.title}”的 design.diagrams.source 缺少或写错类型声明：kind=${diagram.kind} 必须以 ${diagram.kind === "sequence" ? "sequenceDiagram" : "flowchart TD（或合法方向）"} 开头，之后才写节点或 participant；不要包含 Markdown 代码围栏。`);
    }
    if (/%%\{|^---|\bclick\s|<script/i.test(diagram.source)) throw new Error(`流程图“${diagram.title}”不能包含初始化配置、点击指令或脚本。`);
  }
}

export function designMarkdown(draft) {
  const design = draft.design;
  return [
    `## 实现思路\n${design.approach}`,
    ...design.diagrams.map(row => `## ${row.title}\n\`\`\`mermaid\n${row.source}\n\`\`\``),
    ...(design.frontend.trim() ? [`## 前端设计\n${design.frontend}`] : []),
    ...(design.backend.trim() ? [`## 后端设计\n${design.backend}`] : []),
    ...(design.interfaces.length ? [`## 接口与前后端约定\n${design.interfaces.map(row =>
      `### ${row.name}（${{ existing: "复用", modified: "修改", new: "新增" }[row.status]}）\n${row.method} ${row.path}\n${row.sourceFile ? `源码：${row.sourceFile}\n` : ""}请求：${row.request}\n响应：${row.response}\n异常：${row.errors}`).join("\n\n")}`] : []),
    `## 数据处理\n${design.data}`,
    `## 修改位置与关键逻辑\n${design.components.map(row => {
      const change = draft.changes.find(change => change.file === row.file);
      return `### ${row.file}\n位置：${row.location}\n${change.description}${row.pseudocode.trim() ? `\n\`\`\`text\n${row.pseudocode}\n\`\`\`` : ""}`;
    }).join("\n\n")}`,
  ].join("\n\n");
}

export function planReviewHash(meta, draft, responsibility) {
  const parts = draft.design.components.filter(row => [responsibility, "shared"].includes(row.domain));
  return sha256(JSON.stringify({ contractHash: meta.contractHash, baseHash: meta.baseHash, configHash: meta.configHash,
    standardsHash: meta.standardsHash, approach: draft.design.approach, interfaces: draft.design.interfaces,
    data: draft.design.data, impacts: draft.impacts, boundaries: draft.boundaries,
    externalEffects: draft.boundaries.externalEffects, verification: draft.verification, validation: draft.validation,
    design: draft.design[responsibility], diagrams: draft.design.diagrams.filter(row => [responsibility, "shared"].includes(row.domain)),
    components: parts, changes: draft.changes.filter(row => parts.some(part => part.file === row.file)) }));
}

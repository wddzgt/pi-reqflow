import assert from "node:assert/strict";
import test from "node:test";
import { designMarkdown, validateDesign } from "../src/design-document.js";

const draft = source => ({ domains: ["frontend", "backend"], affectedFiles: ["src/a.js"], design: {
  approach: "复用现有导入流程", frontend: "确认冲突", backend: "导入配置", data: "保持原有配置",
  interfaces: [], components: [{ file: "src/a.js", domain: "shared", location: "导入方法", pseudocode: "" }],
  diagrams: [{ title: "导入流程", kind: "flow", domain: "backend", source },
    { title: "联调时序", kind: "sequence", domain: "shared", source: "sequenceDiagram\nparticipant U as 用户\nU->>U: 确认" }],
} });

test("valid Mermaid flow and sequence declarations are accepted", () => {
  for (const header of ["flowchart TD", "flowchart LR", "graph TB"]) {
    assert.doesNotThrow(() => validateDesign(draft(`${header}\nA["选择文件"] --> B["导入"]`)));
  }
});

test("joint frontend/backend design works without diagrams and retains critical pseudocode", () => {
  const value = draft('flowchart TD\nA --> B');
  value.design.diagrams = [];
  value.design.components[0].pseudocode = 'if conflict: ask user\nelse: import current configuration';
  value.changes = [{ file: "src/a.js", description: "复用现有导入方法，处理冲突确认。" }];
  assert.doesNotThrow(() => validateDesign(value));
  const markdown = designMarkdown(value);
  assert.match(markdown, /前端设计[\s\S]*后端设计/);
  assert.match(markdown, /```text\nif conflict: ask user\nelse: import current configuration\n```/);
  assert.doesNotMatch(markdown, /```mermaid/);
  value.design.frontend = "";
  assert.throws(() => validateDesign(value), /frontend 说明缺失/);
});

test("missing declarations identify the precise diagram and required upstream fix", () => {
  assert.throws(() => validateDesign(draft('A["选择文件"] --> B["导入"]')), /导入流程.*kind=flow.*flowchart TD/);
  const value = draft('flowchart TD\nA --> B');
  value.design.diagrams[1].source = "participant U as 用户\nU->>U: 确认";
  assert.throws(() => validateDesign(value), /联调时序.*kind=sequence.*sequenceDiagram/);
  assert.throws(() => validateDesign(draft('```mermaid\nflowchart TD\nA --> B\n```')), /Markdown/);
});

test("diagram diagnostics retain rejection of executable directives", () => {
  for (const directive of ['click A "https://example.com"', '%%{init: {}}%%', '<script>alert(1)</script>']) {
    assert.throws(() => validateDesign(draft(`flowchart TD\nA --> B\n${directive}`)), /不能包含.*指令或脚本/);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/files.js";
import { planAnalysisInput, planSpecialists } from "../src/plan-analysis.js";

test("risk-based review distinguishes ordinary coupling from data and external effects", () => {
  const analysis = { domains: ["frontend", "backend"],
    impacts: Object.fromEntries(["existingBehavior", "interfaces", "data"].map(key => [key, { status: "none" }])),
    boundaries: { externalEffects: { status: "none" } } };
  assert.deepEqual(planSpecialists(analysis, "full"), ["all"]);
  assert.deepEqual(planSpecialists(analysis, "risk-based"), []);
  analysis.impacts.interfaces.status = "changed";
  analysis.impacts.existingBehavior.status = "changed";
  assert.deepEqual(planSpecialists(analysis, "risk-based"), []);
  for (const status of ["changed", "unknown"]) {
    analysis.impacts.data.status = status;
    assert.deepEqual(planSpecialists(analysis, "risk-based"), ["all"]);
  }
  analysis.impacts.data.status = "none";
  for (const status of ["reversible", "irreversible", "unknown"]) {
    analysis.boundaries.externalEffects.status = status;
    assert.deepEqual(planSpecialists(analysis, "risk-based"), ["all"]);
  }
  assert.throws(() => planSpecialists(analysis, "skip-everything"), /Invalid plan review policy/);
  assert.throws(() => planSpecialists(analysis), /Invalid plan review policy/);
});

test("plan validation identifies an oversized description instead of blaming file order", () => {
  const contract = { objective: "Add a names-only listing", acceptance: [{ id: "AC1", text: "Names only" }] };
  const project = { config: { allowedPaths: ["src", "tests"], excludedPaths: [] } };
  const value = { schemaVersion: 1, contractHash: sha256(JSON.stringify(contract)),
    affectedFiles: ["src/cli.py", "tests/test_cli.py"], domains: ["backend"],
    impacts: Object.fromEntries(["existingBehavior", "interfaces", "data"].map(key => [key, { status: "none", evidence: "Existing behavior preserved" }])),
    verification: [{ acceptanceId: "AC1", scenario: "Names only", regression: "Original list output unchanged" }], openQuestions: [],
    validation: { checks: [], skipped: [], manualReason: "按场景执行 CLI 断言", startup: [] },
    changes: [{ file: "src/cli.py", description: "Add a flag" }, { file: "tests/test_cli.py", description: "x".repeat(525) }],
    boundaries: { modules: [{ name: "CLI", files: ["src/cli.py", "tests/test_cli.py"], evidence: "One CLI command" }],
      deliveryUnits: [{ name: "CLI", evidence: "One application" }], designStages: 1, estimatedChangedLines: 40,
      coordination: { status: "none", evidence: "No coordination" }, verification: { status: "ready", evidence: "CLI assertions" },
      recovery: { status: "code_only", evidence: "Snapshot" }, externalEffects: { status: "none", evidence: "No external calls" }, exclusions: [] } };
  assert.throws(() => planAnalysisInput(value, contract, project), /changes\[1\]\.description for tests\/test_cli\.py has 525 characters; maximum is 500/);
  value.changes[1].description = "x".repeat(500);
  assert.ok(planAnalysisInput(value, contract, project).markdown.includes("拟改位置与做法"));
  value.validation.startup = [{ name: "frontend", command: ["npm", "run", "dev"],
    healthUrl: "http://127.0.0.1:4180/health", applicationUrl: "http://127.0.0.1:4180/templates" }];
  assert.match(planAnalysisInput(value, contract, project).markdown, /健康检查 .*\/health；应用入口 .*\/templates/);
  value.validation.startup[0].applicationUrl = null;
  assert.match(planAnalysisInput(value, contract, project).markdown, /应用入口 无页面/);
  delete value.validation.startup[0].applicationUrl;
  assert.throws(() => planAnalysisInput(value, contract, project), /应用入口/);
  value.validation.startup = [{ name: "old", command: ["npm", "run", "dev"], url: "http://127.0.0.1:4180/" }];
  assert.throws(() => planAnalysisInput(value, contract, project), /应用入口/);
  value.validation.startup = [];
  value.domains.push("backend");
  assert.throws(() => planAnalysisInput(value, contract, project), /domains must be unique; repeated: backend/);
  value.domains.pop();
  value.changes.reverse();
  assert.throws(() => planAnalysisInput(value, contract, project), /exactly once in scope order/);
});

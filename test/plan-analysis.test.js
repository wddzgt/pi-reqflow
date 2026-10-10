import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/files.js";
import { planAnalysisInput } from "../src/plan-analysis.js";

test("plan validation identifies an oversized description instead of blaming file order", () => {
  const contract = { objective: "Add a names-only listing", acceptance: [{ id: "AC1", text: "Names only" }] };
  const project = { config: { allowedPaths: ["src", "tests"], excludedPaths: [] } };
  const value = { schemaVersion: 1, contractHash: sha256(JSON.stringify(contract)),
    affectedFiles: ["src/cli.py", "tests/test_cli.py"], domains: ["backend"],
    impacts: Object.fromEntries(["existingBehavior", "interfaces", "data"].map(key => [key, { status: "none", evidence: "Existing behavior preserved" }])),
    verification: [{ acceptanceId: "AC1", scenario: "Names only", regression: "Original list output unchanged" }], openQuestions: [],
    changes: [{ file: "src/cli.py", description: "Add a flag" }, { file: "tests/test_cli.py", description: "x".repeat(525) }],
    boundaries: { modules: [{ name: "CLI", files: ["src/cli.py", "tests/test_cli.py"], evidence: "One CLI command" }],
      deliveryUnits: [{ name: "CLI", evidence: "One application" }], designStages: 1, estimatedChangedLines: 40,
      coordination: { status: "none", evidence: "No coordination" }, verification: { status: "ready", evidence: "CLI assertions" },
      recovery: { status: "code_only", evidence: "Snapshot" }, externalEffects: { status: "none", evidence: "No external calls" }, exclusions: [] } };
  assert.throws(() => planAnalysisInput(value, contract, project), /changes\[1\]\.description for tests\/test_cli\.py has 525 characters; maximum is 500/);
  value.changes[1].description = "x".repeat(500);
  assert.ok(planAnalysisInput(value, contract, project).markdown.includes("拟改位置与做法"));
  value.domains.push("backend");
  assert.throws(() => planAnalysisInput(value, contract, project), /domains must be unique; repeated: backend/);
  value.domains.pop();
  value.changes.reverse();
  assert.throws(() => planAnalysisInput(value, contract, project), /exactly once in scope order/);
});

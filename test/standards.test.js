import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../src/config.js";
import { resolveStandards, standardsCatalog, standardsPrompt } from "../src/standards.js";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("built-in coding profiles follow changed languages and keep project global rules", async () => {
  const config = JSON.parse(await fs.readFile(path.join(repository, "examples/config.local.json"), "utf8"));
  config.codingStandards.globalRules = [{ id: "TEAM-ERROR-1", level: "review",
    text: "Service methods must propagate failures instead of returning success" }];
  const validated = validateConfig(config);
  const resolved = resolveStandards(validated, ["backend/Service.java", "web/app.tsx"]);
  assert.deepEqual(resolved.profiles.map((profile) => profile.id), ["java-alibaba", "typescript-eslint"]);
  assert.equal(resolved.globalRules[0].id, "TEAM-ERROR-1");
  assert.match(standardsPrompt(resolved), /TEAM-ERROR-1/);
  assert.doesNotMatch(standardsPrompt(resolved), /https:\/\//);
  assert.notEqual(resolved.hash, resolveStandards(validated, ["backend/Service.java"]).hash);
  assert.equal(standardsCatalog().profiles.length, 8);
});

test("project global rules reject ambiguous and silently ignored configuration", async () => {
  const config = JSON.parse(await fs.readFile(path.join(repository, "examples/config.local.json"), "utf8"));
  assert.throws(() => validateConfig({ ...config, codingStandards: { globalRules: [{
    id: "TEAM-X", text: "Do not hide errors", level: "block" }] } }), /review\/guide level/);
  assert.throws(() => validateConfig({ ...config, codingStandards: { globalRules: [{
    id: "TEAM-X", text: "Do not hide errors", level: "review" }, {
    id: "TEAM-X", text: "Preserve interfaces", level: "review" }] } }), /Duplicate global coding rule ID/);
  assert.throws(() => validateConfig({ ...config, codingStandards: { globalRules: [], disabledBuiltins: true } }),
    /Unknown config.codingStandards field/);
});

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Pi guard blocks out-of-scope paths and writes before approval", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-guard-"));
  const workspace = path.join(temporary, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "ok.js"), "export const ok = true;");
  await fs.symlink(temporary, path.join(workspace, "escape"));
  process.env.REQFLOW_WORKSPACE = workspace;
  process.env.REQFLOW_POLICY = JSON.stringify({ allowedPaths: ["src"], excludedPaths: [".git", ".reqflow"] });
  try {
    process.env.REQFLOW_PHASE = "plan";
    const { default: planGuard } = await import("../src/pi-guard.js?phase=plan");
    let planCall;
    planGuard({ on: (_name, handler) => { planCall = handler; } });
    assert.equal(await planCall({ toolName: "read", input: { path: "src/ok.js" } }), undefined);
    assert.equal((await planCall({ toolName: "write", input: { path: "src/new.js" } })).block, true);
    assert.equal((await planCall({ toolName: "read", input: { path: "../outside" } })).block, true);
    assert.equal((await planCall({ toolName: "read", input: { path: "escape/file" } })).block, true);
    process.env.REQFLOW_PHASE = "implement";
    const { default: editGuard } = await import("../src/pi-guard.js?phase=implement");
    let editCall;
    editGuard({ on: (_name, handler) => { editCall = handler; } });
    assert.equal(await editCall({ toolName: "write", input: { path: "src/new.js" } }), undefined);
    assert.equal((await editCall({ toolName: "write", input: { path: ".env.local" } })).block, true);
    assert.equal((await editCall({ toolName: "write", input: { path: "test/out.js" } })).block, true);
    process.env.REQFLOW_POLICY = JSON.stringify({ allowedPaths: ["src"], excludedPaths: [".git", ".reqflow"], approvedFiles: ["src/new.js"] });
    const { default: exactGuard } = await import("../src/pi-guard.js?phase=exact-implementation");
    let exactCall;
    exactGuard({ on: (_name, handler) => { exactCall = handler; } });
    assert.equal(await exactCall({ toolName: "write", input: { path: "src/new.js" } }), undefined);
    assert.equal(await exactCall({ toolName: "read", input: { path: "src/ok.js" } }), undefined);
    assert.match((await exactCall({ toolName: "edit", input: { path: "src/ok.js" } })).reason, /outside the approved plan/);
    assert.equal((await exactCall({ toolName: "write", input: { path: "src/new.js/nested.js" } })).block, true);
    process.env.REQFLOW_POLICY = JSON.stringify({ allowedPaths: ["src"], excludedPaths: [".git", ".reqflow"],
      approvedFiles: ["src/new.js"], implementationScope: "project", restrictedPaths: ["src/security"] });
    const { default: projectGuard } = await import("../src/pi-guard.js?phase=project-implementation");
    let projectCall;
    projectGuard({ on: (_name, handler) => { projectCall = handler; } });
    assert.equal(await projectCall({ toolName: "edit", input: { path: "src/ok.js" } }), undefined);
    assert.equal(await projectCall({ toolName: "write", input: { path: "src/related.js" } }), undefined);
    assert.equal((await projectCall({ toolName: "write", input: { path: "test/out.js" } })).block, true);
    assert.equal((await projectCall({ toolName: "write", input: { path: "src/security/key.js" } })).block, true);
    assert.equal((await projectCall({ toolName: "write", input: { path: "escape/file" } })).block, true);
  } finally {
    delete process.env.REQFLOW_WORKSPACE;
    delete process.env.REQFLOW_POLICY;
    delete process.env.REQFLOW_PHASE;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

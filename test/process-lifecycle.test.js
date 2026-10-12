import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "../src/commands.js";
import { runPi } from "../src/pi-runner.js";

test("Pi cumulative token limit stops execution and preserves measured billing", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-token-limit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi.mjs");
  await fs.writeFile(executable, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'result'}],stopReason:'stop',usage:{input:10,output:5,cacheRead:2,cacheWrite:1,cost:{total:0.04}}}}));console.log(JSON.stringify({type:'agent_settled'}));`);
  const project = { config: { piExecutable: executable, provider: "fake", model: "fake", mode: "local",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [], maxPiMs: 3000, maxToolCalls: 10, maxEventBytes: 10000 } };
  await assert.rejects(runPi(project, directory, "plan", "read only", path.join(directory, "pi.log"), 1,
    null, [], { maxTokens: 17 }), (error) => {
    assert.match(error.message, /remaining requirement token budget/);
    assert.equal(error.costUsd, 0.04); assert.equal(error.telemetry.tokens.cacheRead, 2);
    return true;
  });
  assert.equal((await runPi(project, directory, "plan", "read only", path.join(directory, "exact.log"), 1,
    null, [], { maxTokens: 18 })).costUsd, 0.04);
});

test("timed-out check terminates signal-ignoring descendants", { skip: process.platform === "win32" }, async (t) => {
  const kill = process.kill;
  const terminatedGroups = new Set();
  process.kill = function (pid, signal) {
    if (pid < 0 && terminatedGroups.has(pid)) {
      throw Object.assign(new Error("Already terminated process group"), { code: "EPERM" });
    }
    const result = kill.call(process, pid, signal);
    if (pid < 0 && signal === "SIGKILL") terminatedGroups.add(pid);
    return result;
  };
  t.after(() => { process.kill = kill; });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-process-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "late-check-write");
  const grandchild = `process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(process.argv[1],'late'),3500);setTimeout(()=>process.exit(0),4500)`;
  const parent = path.join(directory, "parent.mjs");
  await fs.writeFile(parent, `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[2]], { stdio: 'inherit' });
process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),4500);\n`);
  const started = Date.now();
  await assert.rejects(runCommand([process.execPath, parent, marker], directory, 250,
    path.join(directory, "check.log"), 10000, []), /Command timed out/);
  assert.ok(Date.now() - started < 3000, "timeout must not wait for the signal-ignoring child");
  assert.equal(terminatedGroups.size, 1, "the process group is terminated exactly once");
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("timed-out Pi run terminates signal-ignoring descendants", { skip: process.platform === "win32" }, async (t) => {
  const kill = process.kill;
  const terminatedGroups = new Set();
  process.kill = function (pid, signal) {
    if (pid < 0 && terminatedGroups.has(pid)) {
      throw Object.assign(new Error("Already terminated process group"), { code: "EPERM" });
    }
    const result = kill.call(process, pid, signal);
    if (pid < 0 && signal === "SIGKILL") terminatedGroups.add(pid);
    return result;
  };
  t.after(() => { process.kill = kill; });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-pi-process-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "late-pi-write");
  const grandchild = `process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(process.argv[1],'late'),3500);setTimeout(()=>process.exit(0),4500)`;
  const fakePi = path.join(directory, "fake-pi.mjs");
  await fs.writeFile(fakePi, `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}], { stdio: 'inherit' });
process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),4500);\n`);
  const project = { config: { mode: "local", piExecutable: fakePi, provider: "fake", model: "fake",
    environment: { pi: [] }, allowedPaths: ["."], excludedPaths: [],
    maxPiMs: 250, maxToolCalls: 10, maxEventBytes: 10000 } };
  const started = Date.now();
  await assert.rejects(runPi(project, directory, "plan", "read only",
    path.join(directory, "pi.log"), 1, null, [], { maxTokens: 2000 }), /AI 研发方案单次模型请求超过 .*执行时限/);
  assert.ok(Date.now() - started < 3000, "timeout must not wait for the signal-ignoring Pi child");
  assert.equal(terminatedGroups.size, 1, "the process group is terminated exactly once");
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("completed check leaves no same-group writer, including inherited output pipes", { skip: process.platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-background-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const child = `setTimeout(()=>require('fs').writeFileSync(process.argv[1],'late'),1800);setTimeout(()=>process.exit(0),2200)`;
  for (const stdio of ["ignore", "inherit"]) {
    const marker = path.join(directory, `late-${stdio}-write`);
    const parent = path.join(directory, `parent-${stdio}.mjs`);
    await fs.writeFile(parent, `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(child)}, process.argv[2]], { stdio: ${JSON.stringify(stdio)} }).unref();\n`);
    assert.equal((await runCommand([process.execPath, parent, marker], directory, 5000,
      path.join(directory, `check-${stdio}.log`), 10000, [])).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  }
});

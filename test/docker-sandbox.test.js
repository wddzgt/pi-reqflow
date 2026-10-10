import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "../src/commands.js";

let image;
let unavailable;
try {
  execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000, stdio: "ignore" });
  image = execFileSync("docker", ["image", "inspect", "node:20-alpine", "--format", "{{.Id}}"],
    { timeout: 5000, encoding: "utf8" }).trim();
} catch (error) {
  unavailable = `Docker integration fixture is unavailable: ${error.message}`;
}

test("Docker check sees only the mounted workspace and declared environment", { skip: unavailable }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-docker-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(workspace);
  const secret = path.join(directory, "host-secret");
  await fs.writeFile(secret, "host-only-secret");
  const prior = process.env.REQFLOW_TOKEN;
  process.env.REQFLOW_TOKEN = "private-session-token";
  t.after(() => {
    if (prior === undefined) delete process.env.REQFLOW_TOKEN;
    else process.env.REQFLOW_TOKEN = prior;
  });
  const script = `const fs=require('fs');if(fs.existsSync(${JSON.stringify(secret)}))process.exit(9);if(process.env.REQFLOW_TOKEN)process.exit(8);fs.writeFileSync('checked.txt','ok');`;
  const sandbox = { kind: "docker", image, memoryMb: 256, pidsLimit: 64 };
  const result = await runCommand(["node", "-e", script], workspace, 30000,
    path.join(directory, "check.log"), 10000, [], sandbox);
  assert.equal(result.code, 0);
  assert.equal(result.sandboxImage, image);
  assert.equal(await fs.readFile(path.join(workspace, "checked.txt"), "utf8"), "ok");
});

test("Docker check removes its container after output-limit termination", { skip: unavailable }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-docker-stop-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const label = createHash("sha256").update(await fs.realpath(directory)).digest("hex");
  const names = () => execFileSync("docker", ["ps", "-a", "--filter", `label=reqflow.workspace=${label}`,
    "--format", "{{.Names}}"], { encoding: "utf8", timeout: 5000 }).trim();
  const before = names();
  const sandbox = { kind: "docker", image, memoryMb: 256, pidsLimit: 64 };
  await assert.rejects(runCommand(["node", "-e", "process.stdout.write('X'.repeat(20000));setInterval(()=>{},1000)"],
    directory, 30000, path.join(directory, "check.log"), 1000, [], sandbox),
  /Command log exceeded configured byte limit/);
  assert.equal(names(), before);
});

test("Docker check removes its container after timeout", { skip: unavailable }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-docker-timeout-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const label = createHash("sha256").update(await fs.realpath(directory)).digest("hex");
  const names = () => execFileSync("docker", ["ps", "-a", "--filter", `label=reqflow.workspace=${label}`,
    "--format", "{{.Names}}"], { encoding: "utf8", timeout: 5000 }).trim();
  const before = names();
  const sandbox = { kind: "docker", image, memoryMb: 256, pidsLimit: 64 };
  await assert.rejects(runCommand(["node", "-e", "setInterval(()=>{},1000)"], directory,
    1000, path.join(directory, "check.log"), 1000, [], sandbox), /Command timed out/);
  assert.equal(names(), before);
});

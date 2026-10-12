import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function validationPortRange() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = 20000 + randomBytes(2).readUInt16BE(0) % 20000;
    const sockets = Array.from({ length: 5 }, () => createServer());
    try {
      for (const [index, socket] of sockets.entries())
        await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(first + index, "127.0.0.1", resolve); });
      return `${first}-${first + 4}`;
    } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
    finally { await Promise.all(sockets.filter(socket => socket.listening).map(socket => new Promise(resolve => socket.close(resolve)))); }
  }
  throw new Error("No free contiguous validation port range for Docker fixture");
}

test("default Compose provisions a demo and administrator before importing user projects", {
  skip: !process.env.REQFLOW_DOCKER_DEPLOYMENT_TEST, timeout: 90000,
}, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-first-run-"));
  const project = path.join(temporary, "project");
  await fs.mkdir(project);
  for (const name of ["src", "test", "package.json"]) {
    await fs.cp(path.join(repository, "examples/demo-app", name), path.join(project, name), { recursive: true });
  }
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = `http://localhost:${port}`;
  const name = `reqflow-onboarding-${randomUUID().slice(0, 8)}`;
  const env = { ...process.env, REQFLOW_PROJECT_DIR: project, REQFLOW_PORT: String(port),
    REQFLOW_PUBLIC_ORIGIN: origin, REQFLOW_LOCAL_PORT_RANGE: await validationPortRange(), REQFLOW_UID: "1000", REQFLOW_GID: "1000" };
  delete env.REQFLOW_CONFIG_FILE;
  const compose = (...args) => exec("docker", ["compose", "-p", name, "-f", path.join(repository, "compose.yaml"), ...args],
    { cwd: repository, env, timeout: 45000, maxBuffer: 1024 * 1024 });
  t.after(async () => {
    await compose("down", "--volumes");
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "30");
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  await compose("exec", "-d", "reqflow", "node", "--input-type=module", "-e", `
import {promises as fs} from 'node:fs';
import {startLocalRuntime,stopAllLocalRuntimes,localRuntimePorts} from '/opt/reqflow/src/local-runtime.js';
const directory=await fs.mkdtemp('/tmp/local-runtime-');
const port=localRuntimePorts[0];
await startLocalRuntime(directory,directory,[{name:'fixture',healthUrl:'http://127.0.0.1:'+port+'/',applicationUrl:null,
command:[process.execPath,'-e',"require('node:http').createServer((req,res)=>res.end('container local validation')).listen("+port+",'0.0.0.0')"]}],directory,[]);
process.on('SIGTERM',async()=>{await stopAllLocalRuntimes();process.exit(0)});`);
  let localReady = false;
  for (let attempt = 0; attempt < 30 && !localReady; attempt++) {
    const result = await fetch(`http://127.0.0.1:${env.REQFLOW_LOCAL_PORT_RANGE.split("-")[0]}/`, { signal: AbortSignal.timeout(500) })
      .then(response => response.text(), error => { if (error.name !== "TypeError") throw error; return error.message; });
    localReady = result === "container local validation";
    if (!localReady) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(localReady, true, "Local project must be reachable through Compose's mapped validation port");
  assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 401);
  const login = await fetch(`${origin}/api/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const overview = await fetch(`${origin}/api/overview`, { headers: { Cookie: cookie } });
  assert.equal(overview.status, 200);
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  assert.equal(bootstrap.projects[0].name, "内置演示项目");
  const importedResponse = await fetch(`${origin}/api/projects`, { method: "POST", headers: { Cookie: cookie, Origin: origin,
    "Content-Type": "application/json", "x-reqflow-token": bootstrap.token },
    body: JSON.stringify({ name: "Quick start user project", rootDir: "/projects/project" }) });
  assert.equal(importedResponse.status, 201, await importedResponse.clone().text());
  const execution = await (await fetch(`${origin}/api/project-execution`, { headers: { Cookie: cookie } })).json();
  assert.equal(execution.checksText, "npm test");
  const container = (await compose("ps", "-q", "reqflow")).stdout.trim();
  const inspected = JSON.parse((await exec("docker", ["inspect", container])).stdout)[0];
  assert.equal(inspected.Mounts.find(mount => mount.Destination === "/projects/project").RW, false);
  assert.ok(!inspected.Mounts.some(mount => mount.Destination === "/config/project.json"));
  assert.equal((await fs.readdir(project)).includes(".reqflow"), false);
  await compose("down");
  await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "30");
  assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 401);
  const persisted = await (await fetch(`${origin}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  assert.equal(persisted.projects.length, 2);
});

test("Compose starts a restricted service with persistent audit, workspaces and Pi state", {
  skip: !process.env.REQFLOW_DOCKER_DEPLOYMENT_TEST, timeout: 90000,
}, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-compose-"));
  const project = path.join(temporary, "project");
  await fs.mkdir(project, { mode: 0o777 });
  await fs.chmod(project, 0o777);
  await fs.cp(path.join(repository, "examples/demo-app/src"), path.join(project, "src"), { recursive: true });
  await fs.cp(path.join(repository, "examples/demo-app/test"), path.join(project, "test"), { recursive: true });
  const config = JSON.parse(await fs.readFile(path.join(repository, "examples/config.docker.json"), "utf8"));
  config.checks = [["node", "--test", "test/calculator.test.mjs"]];
  const configFile = path.join(temporary, "config.json");
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o644 });
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const origin = `http://localhost:${port}`;
  const name = `reqflow-smoke-${randomUUID().slice(0, 8)}`;
  const token = randomBytes(32).toString("hex");
  const env = { ...process.env, REQFLOW_PROJECT_DIR: project, REQFLOW_CONFIG_FILE: configFile,
    REQFLOW_PORT: String(port), REQFLOW_PUBLIC_ORIGIN: origin, REQFLOW_LOCAL_PORT_RANGE: await validationPortRange(),
    REQFLOW_UID: "1000", REQFLOW_GID: "1000", SMOKE_TOKEN: token, SMOKE_PASSWORD: randomBytes(24).toString("hex") };
  const compose = (...args) => exec("docker", ["compose", "-p", name, "-f", path.join(repository, "compose.yaml"),
    "-f", path.join(repository, "compose.project.yaml"), ...args],
    { cwd: repository, env, timeout: 45000, maxBuffer: 1024 * 1024 });
  t.after(async () => {
    await compose("down", "--volumes"); // Only volumes owned by this random, newly created test project.
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await compose("run", "--rm", "reqflow", "init", "--project", "/projects/project", "--config", "/config/project.json", "--inventory-only", "true");
  await compose("run", "--rm", "-e", "SMOKE_TOKEN", "-e", "SMOKE_PASSWORD", "reqflow", "auth-add", "--project", "/projects/project",
    "--user", "product", "--username", "product", "--password-env", "SMOKE_PASSWORD", "--roles", "product", "--token-env", "SMOKE_TOKEN");
  assert.match((await compose("run", "--rm", "--entrypoint", "pi", "reqflow", "--help")).stdout, /provider/);
  await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "30");
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${origin}/api/overview`)).status, 401);
  const login = await fetch(`${origin}/api/login`, { method: "POST", headers: {
    "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  const created = await fetch(`${origin}/api/tasks`, { method: "POST", headers: { Cookie: cookie,
    Origin: origin, "x-reqflow-token": bootstrap.token, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "REQ-SMOKE", title: "Docker persistence", request: "Preserve addition" }) });
  assert.equal(created.status, 201);
  assert.equal((await fetch(`${origin}/api/tasks/REQ-SMOKE/actions`, { method: "POST", headers: {
    Cookie: cookie, Origin: origin, "x-reqflow-token": bootstrap.token, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "implement" }) })).status, 403);
  await compose("exec", "reqflow", "node", "-e", `const fs=require('node:fs');
fs.writeFileSync('/projects/.reqflow-workspaces/persistence-test','workspace');
fs.writeFileSync('/home/node/.pi/persistence-test','pi');`);
  await compose("exec", "reqflow", "node", "-e", `const fs=require('node:fs');
const config=JSON.parse(fs.readFileSync('/config/project.json','utf8'));
config.allowedPaths=['backend/src','backend/test'];
config.checks=[['node','--test','backend/test/calculator.test.mjs']];
fs.writeFileSync('/var/lib/reqflow/import-config.json',JSON.stringify(config),{mode:0o600});`);
  const imported = JSON.parse((await compose("run", "--rm", "-e", "SMOKE_PASSWORD", "reqflow", "project-import",
    "--name", "Docker imported project", "--backend", "/projects/project", "--config", "/var/lib/reqflow/import-config.json",
    "--admin-user", "administrator", "--admin-username", "administrator", "--password-env", "SMOKE_PASSWORD", "--inventory-only", "true")).stdout);
  assert.match(imported.projectDir, /^\/var\/lib\/reqflow\/projects\//);
  await compose("run", "--rm", "reqflow", "baseline-status", "--project", imported.projectDir);
  const container = (await compose("ps", "-q", "reqflow")).stdout.trim();
  const inspected = JSON.parse((await exec("docker", ["inspect", container])).stdout)[0];
  assert.equal(inspected.Config.User, "1000:1000");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.ok(inspected.HostConfig.CapDrop.includes("ALL"));
  assert.ok(!inspected.Mounts.some((mount) => mount.Destination === "/var/run/docker.sock"));
  assert.ok(inspected.Mounts.some((mount) => mount.Destination === "/var/lib/reqflow"));
  await compose("down");
  await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "30");
  await compose("exec", "reqflow", "node", "-e", `const fs=require('node:fs');
if(fs.readFileSync('/projects/.reqflow-workspaces/persistence-test','utf8')!=='workspace')process.exit(1);
if(fs.readFileSync('/home/node/.pi/persistence-test','utf8')!=='pi')process.exit(1);`);
  assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { Cookie: cookie } })).status, 200);
  await compose("run", "--rm", "reqflow", "baseline-status", "--project", imported.projectDir);
  await compose("exec", "reqflow", "node", "-e", `const fs=require('node:fs');
const root='/var/lib/reqflow';
const projects=JSON.parse(fs.readFileSync(root+'/projects.json','utf8')).projects;
if(projects.length!==1)throw new Error('Import registry lost');
for(const file of fs.readdirSync(root).filter(name=>name.startsWith('sessions-'))){
if((fs.statSync(root+'/'+file).mode&0o777)!==0o600)throw new Error('Session permissions changed');}`);
  const status = JSON.parse((await compose("run", "--rm", "-e", "REQFLOW_TOKEN=" + token, "reqflow",
    "status", "--project", "/projects/project", "--id", "REQ-SMOKE")).stdout);
  assert.equal(status.state, "intake_draft");
});

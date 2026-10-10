import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addCredential, authenticate } from "../src/auth.js";
import { compareManifests, manifest, writeJson } from "../src/files.js";
import { appendEvent, createTask, readTask } from "../src/store.js";
import { prepareReleaseCandidate, publishedRevision, sourceRevision } from "../src/workspace.js";

test("manifest covers filenames matching object prototype properties", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ["__proto__", "constructor", "toString"]) await fs.writeFile(path.join(root, name), name);
  const after = await manifest(root, [], 10000);
  assert.equal(Object.keys(after).length, 3);
  const changes = compareManifests({}, after);
  assert.equal(changes.length, 3);
  assert.ok(changes.every((change) => change.before === null && change.after.hash));
  const persisted = JSON.parse(JSON.stringify(after));
  assert.deepEqual(compareManifests(persisted, after), []);
});

test("authentication rejects duplicate tokens in a manually edited credential file", async (t) => {
  const archive = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-auth-"));
  t.after(() => fs.rm(archive, { recursive: true, force: true }));
  const project = { archive };
  const token = "reviewer-token-0123456789-abcdefghijklmn";
  await addCredential(project, "reviewer", ["developer"], { username: "reviewer", password: "password123456", token });
  const file = path.join(archive, "auth.json");
  const credentials = JSON.parse(await fs.readFile(file, "utf8"));
  credentials.users.push({ ...credentials.users[0], id: "executor", username: "executor", roles: ["developer"] });
  await writeJson(file, credentials);
  await assert.rejects(authenticate(project, token), /Duplicate authentication token/);
});

test("concurrent requirements publish complete records and a consistent index", async (t) => {
  const archive = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-concurrent-"));
  t.after(() => fs.rm(archive, { recursive: true, force: true }));
  await fs.mkdir(path.join(archive, "tasks"));
  const project = { archive };
  const ids = Array.from({ length: 12 }, (_, index) => `REQ-${index}`);
  await Promise.all(ids.map((id) => createTask(project, id, id, "request", "product")));
  await Promise.all(ids.map(async (id) => {
    const { meta } = await readTask(project, id);
    await appendEvent(project, id, "test_update", { ...meta, state: "updated" }, {});
  }));
  const index = JSON.parse(await fs.readFile(path.join(archive, "index.json"), "utf8"));
  assert.equal(index.length, ids.length);
  assert.ok(index.every((row) => row.state === "updated"));
  for (const id of ids) assert.equal((await readTask(project, id)).events.length, 2);
});

test("Git revision gates reject excluded tracked files before creating worktrees or recording publication", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-git-gate-"));
  const originalPath = process.env.PATH;
  t.after(async () => { process.env.PATH = originalPath; await fs.rm(root, { recursive: true, force: true }); });
  const executable = path.join(root, "git");
  // Emulate the Git boundary without committing, pushing or changing a real repository.
  await fs.writeFile(executable, `#!${process.execPath}\nconst args = process.argv.slice(2);
if (args[0] === "ls-tree") process.stdout.write("src/main.js\\0.env.production\\0");
else if (args[0] === "rev-parse") process.stdout.write("abc\\n");
else if (args[0] === "ls-remote") process.stdout.write("abc\\trefs/heads/req/REQ-001\\n");
else if (args[0] === "branch") process.stdout.write("req/REQ-001\\n");
else if (args[0] === "worktree") { require("node:fs").writeFileSync("worktree-created", "yes"); }
`, { mode: 0o700 });
  process.env.PATH = `${root}${path.delimiter}${originalPath}`;
  const project = { root, config: { mode: "git", baseBranch: "main", releaseBranch: "main",
    remote: "origin", excludedPaths: [".git", ".reqflow", "private"] } };
  await assert.rejects(sourceRevision(project), /contains excluded files/);
  await assert.rejects(publishedRevision(project, root, "req/REQ-001"), /contains excluded files/);
  await assert.rejects(prepareReleaseCandidate(project, "REQ-001", { publishedRevision: "abc" }), /contains excluded files/);
  await assert.rejects(fs.stat(path.join(root, "worktree-created")), { code: "ENOENT" });
});

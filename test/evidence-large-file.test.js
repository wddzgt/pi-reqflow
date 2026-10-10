import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize, createTask, appendEvent, taskPath } from "../src/store.js";
import { loadProject } from "../src/config.js";
import { sha256 } from "../src/files.js";
import { getChangedFile } from "../src/evidence.js";

test("large source snapshots expose bounded changed context and still reject tampering", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsail-large-diff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  const before = `${("// " + "unchanged ".repeat(50) + "\n").repeat(500)}const keyword = input.toLowerCase();\n`;
  const after = before.replace("input.toLowerCase()", "input.trim().toLowerCase()");
  await fs.writeFile(path.join(root, "src/editor.js"), before);
  await initialize(root, new URL("../examples/config.local.json", import.meta.url).pathname, { inventoryOnly: true });
  const project = await loadProject(root);
  const meta = await createTask(project, "DIFF-1", "Trim input", "Ignore surrounding spaces", "product");
  const directory = taskPath(project, "DIFF-1");
  for (const [kind, text] of [["baseline", before], ["after", after]]) {
    await fs.mkdir(path.join(directory, kind, "src"), { recursive: true });
    await fs.writeFile(path.join(directory, kind, "src/editor.js"), text);
  }
  const changes = [{ file: "src/editor.js", before: { bytes: Buffer.byteLength(before), hash: sha256(before), mode: 420 },
    after: { bytes: Buffer.byteLength(after), hash: sha256(after), mode: 420 } }];
  await fs.writeFile(path.join(directory, "changes.json"), JSON.stringify({ changes }));
  await appendEvent(project, "DIFF-1", "implemented", { ...meta, state: "implemented" }, { changes });
  const principal = { id: "product", roles: ["product"] };
  const result = await getChangedFile(root, principal, "DIFF-1", "src/editor.js");
  assert.ok(result.before.bytes > 200000);
  assert.equal(result.before.text, null);
  assert.equal(result.after.text, null);
  assert.match(result.patch, /-const keyword = input.toLowerCase\(\);/);
  assert.match(result.patch, /\+const keyword = input.trim\(\).toLowerCase\(\);/);
  assert.ok(Buffer.byteLength(result.patch) < 4000);
  await fs.appendFile(path.join(directory, "after/src/editor.js"), "changed");
  await assert.rejects(getChangedFile(root, principal, "DIFF-1", "src/editor.js"), /snapshot hash mismatch/);
});

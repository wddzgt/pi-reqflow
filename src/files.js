import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, data, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function writeJson(file, value) {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function safeId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error("编号须为 1–64 位，以字母或数字开头，仅包含字母、数字、下划线或短横线。");
  }
  return id;
}

export function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside workspace: ${candidate}`);
  }
  return relative;
}

export async function listFiles(root, excludes, maxBytes) {
  const files = [];
  let total = 0;
  async function visit(relative) {
    const directory = path.join(root, relative);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      const normalized = child.split(path.sep).join("/");
      if ([".git", ".reqflow", ".reqflow-init", ".reqflow-workspaces", "node_modules"].includes(entry.name)) continue;
      if (entry.name === ".env" || entry.name.startsWith(".env.")) continue;
      if (excludes.some((item) => normalized === item || normalized.startsWith(`${item}/`))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Symlink requires an explicit project policy: ${child}`);
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported project entry: ${child}`);
      const stat = await fs.stat(path.join(root, child));
      total += stat.size;
      if (total > maxBytes) throw new Error(`项目源码快照超过上限 ${(maxBytes / 1024 / 1024).toFixed(1)} MB（当前累计 ${(total / 1024 / 1024).toFixed(1)} MB）。请检查构建产物、日志等排除路径，或在高级执行配置中调整 maxSnapshotBytes。`);
      files.push(normalized);
    }
  }
  await visit("");
  return files.sort();
}

export async function copyFiles(source, target, files) {
  for (const relative of files) {
    const destination = path.join(target, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(source, relative), destination);
    const stat = await fs.stat(path.join(source, relative));
    await fs.chmod(destination, stat.mode);
  }
}

export async function manifest(root, excludes, maxBytes) {
  const result = Object.create(null);
  for (const relative of await listFiles(root, excludes, maxBytes)) {
    const file = path.join(root, relative);
    const content = await fs.readFile(file);
    const stat = await fs.stat(file);
    result[relative] = { hash: sha256(content), bytes: content.length, mode: stat.mode & 0o777 };
  }
  return result;
}

export function compareManifests(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((file) => before[file]?.hash !== after[file]?.hash || before[file]?.mode !== after[file]?.mode)
    .map((file) => ({ file, before: Object.hasOwn(before, file) ? before[file] : null,
      after: Object.hasOwn(after, file) ? after[file] : null }));
}

export function manifestHash(value) {
  return sha256(JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

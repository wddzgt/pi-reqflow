import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { allowedFile } from "./config.js";
import { assertInside, compareManifests, copyFiles, listFiles, manifest, manifestHash, sha256, writeJson } from "./files.js";
import { readTask, taskPath } from "./store.js";
import { admissionPolicy, restrictedAdmissionFile } from "./admission.js";
import { runGit } from "./git-project.js";

const exec = promisify(execFile);

async function git(root, args) {
  const { stdout } = await exec("git", args, { cwd: root, maxBuffer: 1024 * 1024 });
  return args.includes("-z") ? stdout : stdout.trim();
}

export async function sourceManifest(project) {
  return manifest(project.root, project.config.excludedPaths, project.config.maxSnapshotBytes);
}

export async function sourceRevision(project) {
  if (project.config.mode !== "git") return null;
  const head = await git(project.root, ["rev-parse", "HEAD"]);
  const base = await git(project.root, ["rev-parse", project.config.baseBranch]);
  if (head !== base) throw new Error("Project HEAD must match configured base branch before planning");
  const tracked = await git(project.root, ["ls-tree", "-r", "--name-only", "-z", head]);
  const excluded = tracked.split("\0").filter((file) => file && (file.split("/").some((part) => part === ".env" || part.startsWith(".env."))
    || project.config.excludedPaths.some((part) => file === part || file.startsWith(`${part}/`))));
  if (excluded.length) throw new Error(`Git revision contains excluded files; remove them from the repository before using a worktree: ${excluded.join(", ")}`);
  const status = await git(project.root, ["status", "--porcelain", "--untracked-files=normal"]);
  const dirty = status.split("\n").filter((line) => line && !line.slice(3).startsWith(".reqflow/"));
  if (dirty.length) throw new Error(`Git project has uncommitted files: ${dirty.join(", ")}`);
  return head;
}

export function workspacePath(project, id) {
  const projectKey = sha256(project.root).slice(0, 12);
  return path.join(path.dirname(project.root), ".reqflow-workspaces", projectKey, id);
}

export async function preparePlanWorkspace(project, id, attempt, baseline) {
  const workspace = `${workspacePath(project, id)}-plan-${attempt}`;
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  await fs.mkdir(workspace, { recursive: false });
  await copyFiles(project.root, workspace, Object.keys(baseline));
  return workspace;
}

export async function prepareWorkspace(project, id, approvedHash, approvedRevision, selection, restartCount = 0) {
  const current = project.config.mode === "local" ? await sourceManifest(project) : null;
  if (current && manifestHash(current) !== approvedHash) throw new Error("Source files changed after plan approval");
  const workspace = `${workspacePath(project, id)}${restartCount ? `-restart-${restartCount}` : ""}`;
  if (await fs.stat(workspace).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error(`Workspace already exists: ${workspace}`);
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  let branch = null;
  if (project.config.mode === "git") {
    branch = selection?.branch ?? `${project.config.branchPrefix}/${id}${restartCount ? `-restart-${restartCount}` : ""}`;
    await git(project.root, ["check-ref-format", "--branch", branch]);
    if (selection?.kind === "existing" && !selection.fromRemote) {
      if (await git(project.root, ["rev-parse", `refs/heads/${branch}`]) !== approvedRevision) throw new Error("开发分支与已审核方案的基础版本不同，请核对该分支上的技术方案。");
      await git(project.root, ["worktree", "add", workspace, branch]);
    } else await git(project.root, ["worktree", "add", "-b", branch, workspace, approvedRevision]);
  } else {
    await fs.mkdir(workspace);
    await copyFiles(project.root, workspace, Object.keys(current));
  }
  const baseline = await manifest(workspace, project.config.excludedPaths, project.config.maxSnapshotBytes);
  if (manifestHash(baseline) !== approvedHash) throw new Error("Prepared workspace does not match approved source");
  const archive = path.join(taskPath(project, id), "baseline");
  await fs.mkdir(archive);
  await copyFiles(workspace, archive, Object.keys(baseline));
  await writeJson(path.join(taskPath(project, id), "baseline.json"), baseline);
  return { workspace, branch, branchStartRevision: approvedRevision, baselineHash: manifestHash(baseline) };
}

export async function validateDevelopmentBranch(project, meta, selection) {
  if (!selection || !["new", "existing"].includes(selection.kind) || typeof selection.branch !== "string"
      || Object.keys(selection).some(key => !["kind", "branch"].includes(key))) throw new Error("请选择新建分支或已有需求分支。");
  if (project.config.mode !== "git") throw new Error("目录项目不支持 Git 分支选择。");
  await runGit(project.root, ["check-ref-format", "--branch", selection.branch]);
  if ([project.config.baseBranch, project.config.releaseBranch, project.config.gitDelivery?.testBranch].includes(selection.branch)) {
    throw new Error("开发请选择独立需求分支，共享分支用于合并。");
  }
  const heads = await runGit(project.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  const exists = heads.split("\n").includes(selection.branch);
  if (selection.kind === "new" && exists) throw new Error("分支已存在，请选择已有分支或更换名称。");
  if (selection.kind === "existing") {
    if (!exists) {
      const remote = await runGit(project.root, ["ls-remote", "--heads", project.config.remote, selection.branch]);
      if (!remote) throw new Error("开发分支不存在，请刷新分支列表。");
      if (remote.split(/\s+/)[0] !== meta.baseRevision) throw new Error("该远程分支与方案基础版本不同，需要先核对方案。");
      return { ...selection, fromRemote: true };
    }
    if (await runGit(project.root, ["rev-parse", `refs/heads/${selection.branch}`]) !== meta.baseRevision) throw new Error("该分支代码与方案基础版本不同，需要先针对该版本核对方案。");
    const remote = await runGit(project.root, ["ls-remote", "--heads", project.config.remote, selection.branch]);
    if (remote && remote.split(/\s+/)[0] !== meta.baseRevision) throw new Error("远程需求分支已更新，请先针对最新代码核对方案。");
    const trees = await runGit(project.root, ["worktree", "list", "--porcelain"]);
    if (trees.split("\n").includes(`branch refs/heads/${selection.branch}`)) throw new Error("该分支正在其他工作目录使用，请新建需求分支。");
  }
  return selection;
}

export async function inspectChanges(project, id, workspace) {
  const before = await importBaseline(project, id);
  const after = await manifest(workspace, project.config.excludedPaths, project.config.maxSnapshotBytes);
  const changes = compareManifests(before, after);
  const violations = changes.filter(({ file }) => !allowedFile(file, project.config)).map(({ file }) => file);
  const { meta } = await readTask(project, id);
  const exactScope = project.config.implementationScope !== "project" || meta.fastPathEligibility || meta.planScopeHash;
  if (exactScope) for (const { file } of changes) if (!meta.developmentFiles.includes(file)) violations.push(`file outside approved plan: ${file}`);
  const scopeAdditions = changes.filter(({ file }) => !meta.developmentFiles.includes(file)).map(({ file }) => file);
  const policy = admissionPolicy(project.config);
  const changedBytes = changes.reduce((total, row) => total + Math.max(row.before?.bytes ?? 0, row.after?.bytes ?? 0), 0);
  const warnings = [];
  if (changes.length > policy.maxFiles) warnings.push("actual file count exceeds planning estimate; review the complete diff");
  if (changedBytes > policy.maxChangedBytes) warnings.push("changed files exceed size estimate; review the complete diff");
  for (const { file } of changes) if (restrictedAdmissionFile(file, policy)) violations.push(`human-led path changed: ${file}`);
  const directory = taskPath(project, id);
  const afterArchive = path.join(directory, "after");
  await fs.mkdir(afterArchive, { recursive: true, mode: 0o700 });
  await copyFiles(workspace, afterArchive, changes.filter((item) => item.after).map((item) => item.file));
  await writeJson(path.join(directory, "changes.json"), { changes, violations, scopeAdditions, warnings });
  return { changes, violations, scopeAdditions, warnings, afterHash: manifestHash(after) };
}

async function importBaseline(project, id) {
  const file = path.join(taskPath(project, id), "baseline.json");
  const baseline = JSON.parse(await fs.readFile(file, "utf8"));
  const { meta } = await readTask(project, id);
  if (manifestHash(baseline) !== meta.baselineHash) throw new Error("Implementation baseline manifest changed");
  return baseline;
}

export async function rollbackWorkspace(project, id, workspace) {
  const directory = taskPath(project, id);
  const report = JSON.parse(await fs.readFile(path.join(directory, "changes.json"), "utf8"));
  const { meta, events } = await readTask(project, id);
  const audited = events.findLast((event) => ["implemented", "implementation_failed", "implementation_interrupted"].includes(event.type));
  if (!audited || JSON.stringify(report.changes) !== JSON.stringify(audited.detail.changes)) {
    throw new Error("Rollback changes differ from the audited implementation");
  }
  await importBaseline(project, id);
  const archive = path.join(directory, "baseline");
  const saved = await manifest(archive, project.config.excludedPaths, project.config.maxSnapshotBytes);
  if (manifestHash(saved) !== meta.baselineHash) throw new Error("Rollback baseline snapshot changed");
  for (const { file } of report.changes) {
    assertInside(workspace, path.join(workspace, file));
    assertInside(archive, path.join(archive, file));
  }
  const current = await manifest(workspace, project.config.excludedPaths, project.config.maxSnapshotBytes);
  const conflicts = report.changes
    .filter(({ file, after }) => current[file]?.hash !== after?.hash || current[file]?.mode !== after?.mode)
    .map(({ file }) => file);
  if (conflicts.length) throw new Error(`Rollback conflicts: ${conflicts.join(", ")}`);
  for (const { file, before } of report.changes) {
    const destination = path.join(workspace, file);
    if (!before) {
      await fs.unlink(destination);
    } else {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(directory, "baseline", file), destination);
      await fs.chmod(destination, before.mode);
    }
  }
  return report.changes.length;
}

export async function publishedRevision(project, workspace, branch) {
  if (project.config.mode !== "git") throw new Error("Published revision requires Git mode");
  const actualBranch = await git(workspace, ["branch", "--show-current"]);
  if (actualBranch !== branch) throw new Error(`Workspace branch changed: ${actualBranch}`);
  const status = await git(workspace, ["status", "--porcelain"]);
  if (status) throw new Error("Commit all approved changes before recording a published revision");
  const local = await git(workspace, ["rev-parse", "HEAD"]);
  const remote = await git(workspace, ["ls-remote", "--heads", project.config.remote, branch]);
  if (remote.split(/\s+/)[0] !== local) throw new Error("Remote branch does not match the local commit");
  const tracked = await git(workspace, ["ls-tree", "-r", "--name-only", "-z", local]);
  const excluded = tracked.split("\0").filter((file) => file && (file.split("/").some((part) => part === ".env" || part.startsWith(".env."))
    || project.config.excludedPaths.some((part) => file === part || file.startsWith(`${part}/`))));
  if (excluded.length) throw new Error(`Published revision contains excluded files: ${excluded.join(", ")}`);
  return local;
}

export async function assertReleaseRevision(project, expected) {
  if (project.config.mode !== "git") return;
  const local = await git(project.root, ["rev-parse", project.config.releaseBranch]);
  const remote = await git(project.root, ["ls-remote", "--heads", project.config.remote, project.config.releaseBranch]);
  if (local !== expected || remote.split(/\s+/)[0] !== expected) {
    throw new Error("Release branch changed after candidate verification");
  }
}

export async function prepareReleaseCandidate(project, id, task) {
  if (project.config.mode === "local") {
    const current = await manifest(task.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes);
    if (manifestHash(current) !== task.afterHash) throw new Error("Local workspace changed after verification");
    return { candidateWorkspace: task.workspace, mergedRevision: task.afterHash };
  }
  if (!task.publishedRevision) throw new Error("Requirement branch must be published before merge verification");
  const local = await git(project.root, ["rev-parse", project.config.releaseBranch]);
  const remote = await git(project.root, ["ls-remote", "--heads", project.config.remote, project.config.releaseBranch]);
  if (remote.split(/\s+/)[0] !== local) throw new Error("Local release branch differs from remote release branch");
  try {
    await git(project.root, ["merge-base", "--is-ancestor", task.publishedRevision, local]);
  } catch (error) {
    throw new Error("Published requirement revision is not in the release branch", { cause: error });
  }
  const candidateWorkspace = `${workspacePath(project, id)}${task.restartCount ? `-restart-${task.restartCount}` : ""}-merged`;
  const tracked = await git(project.root, ["ls-tree", "-r", "--name-only", "-z", local]);
  const excluded = tracked.split("\0").filter((file) => file && (file.split("/").some((part) => part === ".env" || part.startsWith(".env."))
    || project.config.excludedPaths.some((part) => file === part || file.startsWith(`${part}/`))));
  if (excluded.length) throw new Error(`Release revision contains excluded files: ${excluded.join(", ")}`);
  if (await fs.stat(candidateWorkspace).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("Merge verification workspace already exists");
  await git(project.root, ["worktree", "add", "--detach", candidateWorkspace, local]);
  return { candidateWorkspace, mergedRevision: local };
}

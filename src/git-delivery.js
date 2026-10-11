import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { quote } from "shell-quote";
import { allowedFile, describePolicy, loadProject } from "./config.js";
import { manifest, manifestHash, sha256, writeJson } from "./files.js";
import { appendEvent, readTask, taskPath, withLock } from "./store.js";
import { runGit, inspectGit } from "./git-project.js";
import { inspectChanges, publishedRevision, workspacePath } from "./workspace.js";
import { approveChanges, deployTest, pollTestDeployment, recordPublished, verify } from "./workflow.js";
import { runCommand } from "./commands.js";
import { readPlanAnalysis } from "./plan-analysis.js";
import { localRuntimePorts, startLocalRuntime, stopLocalRuntime } from "./local-runtime.js";
import { reportProgress } from "./action-progress.js";
import { inspectLocalEnvironment, environmentStartup } from "./local-environment.js";

export async function readGitSetup(projectPath) {
  const project = await loadProject(projectPath);
  if (project.config.mode !== "git") return { mode: "local" };
  const repository = await inspectGit(project.root);
  return { mode: "git", ...repository, baseBranch: project.config.baseBranch,
    branches: [...new Set([...repository.branches, ...repository.remoteBranches.filter(row => row.remote === project.config.remote).map(row => row.branch)])],
    branchPrefix: project.config.branchPrefix,
    releaseBranch: project.config.releaseBranch, testMode: project.config.gitDelivery?.testMode ?? "branch",
    testBranch: project.config.gitDelivery?.testBranch ?? null };
}

async function assertReviewedWorkspace(project, meta, input) {
  if (meta.state !== "verified") throw new Error("请先完成代码测试，再提交或获取本地验证代码。");
  if (input.expectedAfterHash !== meta.afterHash || input.expectedPlanHash !== meta.planHash) throw new Error("代码或方案已改变，请刷新并查看当前变更。");
  if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("项目执行规则已改变，请重新核对方案。");
  const hash = manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
  if (hash !== meta.afterHash) throw new Error("工作目录已修改，请先重新检查本地修改。");
  if (project.config.mode === "git" && await runGit(meta.workspace, ["branch", "--show-current"]) !== meta.branch) throw new Error("需求工作目录的分支已改变。");
}

export async function localValidation(projectPath, id, actor, input) {
  const project = await loadProject(projectPath);
  return withLock(path.join(project.archive, "execution-config.lock"), () => withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted") throw new Error("本地验证需要负责研发操作。");
    const preparing = input.stage === "development";
    if (input.environment !== undefined) throw new Error("启动方式由已确认方案确定，不接受手填命令或地址。");
    if (preparing && (!["plan_review", "approved"].includes(meta.state) || input.expectedPlanHash !== meta.planHash))
      throw new Error("请刷新当前方案后准备开发检查。");
    if (!preparing) await assertReviewedWorkspace(project, meta, input);
    const workspace = preparing ? events.findLast(event => event.type === "plan_created").detail.planningWorkspace : meta.workspace;
    if (preparing && manifestHash(await manifest(workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.baseHash)
      throw new Error("方案基础代码已改变，请重新核对方案。");
    const validation = (await readPlanAnalysis(meta, directory)).draft.validation;
    if (!validation) throw new Error("当前方案缺少验证与启动约定，请重新生成研发方案；历史代码与日志仍保留。");
    if (process.env.REQFLOW_LOCAL_RUNTIME_CONTAINER === "1" && validation.startup.some(service =>
      !localRuntimePorts.includes(new URL(service.url).port)))
      throw new Error(`Docker 本地启动方案必须使用已映射的 ${localRuntimePorts.join("、")} 端口，请修正研发方案。`);
    if (preparing) return { id, planHash: meta.planHash, validation, checks: validation.checks.map(item => item.command), checksSource: "plan" };
    let patch = null;
    if (!preparing && project.config.mode === "git") {
      const report = JSON.parse(await fs.readFile(path.join(directory, "changes.json"), "utf8"));
      if (JSON.stringify(report.changes) !== JSON.stringify(events.findLast(event => event.type === "implemented")?.detail.changes)
          || report.violations.length) throw new Error("变更记录与实施记录不同。");
      const index = path.join(directory, `export-index-${randomUUID()}`);
      const environment = { GIT_INDEX_FILE: index };
      await runGit(meta.workspace, ["read-tree", meta.baseRevision], environment);
      try {
        await runGit(meta.workspace, ["add", "-A", "--", ...report.changes.map(change => change.file)], environment);
        patch = await runGit(meta.workspace, ["diff", "--cached", "--binary", "--full-index", meta.baseRevision, "--"], environment);
      } finally {
        await fs.unlink(index);
      }
    }
    if (![undefined, "start", "stop"].includes(input.operation)) throw new Error("无效的本地服务操作。");
    let runtime;
    const inspected = input.operation === "stop" ? null : await inspectLocalEnvironment(project, workspace);
    if (inspected && validation.startup.length && inspected.report.status === "unconfigured") inspected.report.status = "blocked";
    if (inspected) await writeJson(path.join(project.archive, "local-environment-check.json"), { ...inspected.report, actor });
    if (inspected?.report.status === "blocked") {
      const blocked = { actor, afterHash: meta.afterHash, status: "blocked", prerequisites: inspected.report,
        at: new Date().toISOString() };
      await appendEvent(project, id, "local_validation_blocked", { ...meta, localValidation: blocked }, blocked);
      return { id, ...blocked };
    }
    const selected = inspected ? environmentStartup(inspected, validation.startup) : { startup: validation.startup };
    const effects = inspected?.services.filter(service => selected.appIds.includes(service.id)).flatMap(service => service.effects) ?? [];
    if (effects.length && (input.confirmStartupEffects !== true || input.expectedEnvironmentRevision !== inspected.report.revision))
      throw new Error(`启动将写入数据库，请确认当前环境版本的启动影响：${effects.join("；")}`);
    try {
      reportProgress(input.operation === "stop" ? "正在停止本地环境。" : "正在按研发方案启动本地环境，等待服务地址就绪。", "", "local-validation");
      runtime = input.operation === "stop" ? await stopLocalRuntime(directory)
        : await startLocalRuntime(directory, workspace, selected.startup, directory, [], project.config.maxPiMs, {}, selected.environments);
    } catch (error) {
      await appendEvent(project, id, "local_validation_failed", { ...meta,
        localValidation: { actor, afterHash: meta.afterHash, status: "failed", error: error.message, at: new Date().toISOString() } },
        { actor, afterHash: meta.afterHash, error: error.message, services: error.runtime?.services ?? [] });
      throw error;
    }
    const environment = { instructions: selected.startup.map(service => `${service.name}: ${quote(service.command)}`).join("\n")
      || validation.manualReason || "按研发方案中的验收场景验证此 CLI/库。", url: selected.startup[0]?.url ?? "", target: inspected?.report.target ?? meta.localValidation?.environment?.target };
    await appendEvent(project, id, "local_validation_requested", { ...meta, localValidation: { actor, afterHash: meta.afterHash,
      environment, ...runtime, prerequisites: inspected?.report ?? meta.localValidation?.prerequisites ?? null, at: new Date().toISOString() } },
      { actor, afterHash: meta.afterHash, patchHash: patch === null ? null : sha256(patch), environment, ...runtime });
    return { id, workspace: meta.workspace, branch: meta.branch, baseRevision: meta.baseRevision, baseHash: meta.baseHash,
      afterHash: meta.afterHash, checks: meta.developmentChecks, patch, validation, environment, ...runtime };
  }));
}

export async function recheckLocalChanges(projectPath, id, actor, input) {
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "development.lock"), async () => {
    await withLock(path.join(taskPath(project, id), "task.lock"), async () => {
      const { meta, directory, events } = await readTask(project, id);
      if (!["verified", "verification_failed"].includes(meta.state) || input.expectedAfterHash !== meta.afterHash
          || input.expectedPlanHash !== meta.planHash || describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("请刷新当前待验证代码和方案。");
      if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted") throw new Error("本地修改检查需要负责研发操作。");
      await stopLocalRuntime(directory);
      if (project.config.mode === "git" && (await runGit(meta.workspace, ["branch", "--show-current"]) !== meta.branch
          || await runGit(meta.workspace, ["rev-parse", "HEAD"]) !== (meta.gitCommit?.revision ?? meta.branchStartRevision))) throw new Error("需求分支已有未纳入审核的提交，请由研发核对。");
      if (input.patch !== undefined) {
        if (project.config.mode !== "git" || typeof input.patch !== "string" || !input.patch.trim() || Buffer.byteLength(input.patch) > 1024 * 1024) throw new Error("请上传不超过 1 MiB 的 Git 补丁。");
        if (manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.afterHash) throw new Error("服务器工作目录也已修改，请先核对双方变更。");
        const file = path.join(directory, `local-patch-${randomUUID()}.patch`);
        await fs.writeFile(file, input.patch, { flag: "wx", mode: 0o600 });
        const paths = await runGit(meta.workspace, ["apply", "--numstat", "-z", file]);
        for (const entry of paths.split("\0").filter(Boolean)) {
          const filename = entry.split("\t").slice(2).join("\t");
          if (!filename || path.posix.normalize(filename) !== filename || path.posix.isAbsolute(filename) || filename.includes("\\")
              || filename.split("/").includes("..") || !allowedFile(filename, project.config) || filename.split("/").some(part => part === ".env" || part.startsWith(".env."))
              || ((project.config.implementationScope === "plan" || meta.planScopeHash || meta.fastPathEligibility) && !meta.developmentFiles.includes(filename))) throw new Error("补丁包含已确认范围以外的文件。");
        }
        await runGit(meta.workspace, ["apply", "--check", file]);
        await runGit(meta.workspace, ["apply", file]);
      }
      const retained = path.join(directory, `local-review-${events.at(-1).hash}`);
      await fs.mkdir(retained);
      await fs.rename(path.join(directory, "changes.json"), path.join(retained, "changes.json"));
      await fs.rename(path.join(directory, "after"), path.join(retained, "after"));
      await appendEvent(project, id, "local_validation_changes_retained", meta, { actor, retained,
        priorImplementationHash: events.findLast(event => event.type === "implemented")?.hash, priorAfterHash: meta.afterHash });
      const inspected = await inspectChanges(project, id, meta.workspace);
      const next = { ...meta, state: inspected.violations.length ? "implementation_failed" : "implemented",
        afterHash: inspected.afterHash, changeCount: inspected.changes.length, changeApproval: null, publishedRevision: null,
        testCandidate: null, gitCandidate: null, gitDeliveryError: null, localValidation: null, updatedAt: new Date().toISOString() };
      await appendEvent(project, id, inspected.violations.length ? "implementation_failed" : "implemented", next,
        { actor, source: "local-validation", modelRun: false, changes: inspected.changes, violations: inspected.violations,
          error: inspected.violations.length ? `本地修改超出已确认范围：${inspected.violations.join("、")}` : null });
      if (inspected.violations.length) throw new Error("本地修改超出已确认范围，已保留修改记录，请研发处理。");
    });
    return verify(projectPath, id);
  });
}

async function commitAndPush(project, id, actor, input) {
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    await assertReviewedWorkspace(project, meta, input);
    if (meta.changeApproval?.actor !== actor || meta.changeApproval.afterHash !== meta.afterHash) throw new Error("提交需要研发确认当前代码变更。");
    const head = await runGit(meta.workspace, ["rev-parse", "HEAD"]);
    if (head !== (meta.gitCommit?.revision ?? meta.branchStartRevision ?? meta.baseRevision)) throw new Error("需求分支被其他人员提交了代码，请先核对新提交。");
    let revision = head;
    if (!meta.gitCommit || meta.gitCommit.afterHash !== meta.afterHash) {
      if (await runGit(meta.workspace, ["diff", "--cached", "--name-only"])) throw new Error("工作目录已有暂存修改，请先核对；系统不会覆盖暂存区。");
      const report = JSON.parse(await fs.readFile(path.join(directory, "changes.json"), "utf8"));
      await runGit(meta.workspace, ["add", "-A", "--", ...report.changes.map(change => change.file)]);
      await appendEvent(project, id, "git_commit_authorized", meta, { actor, branch: meta.branch, afterHash: meta.afterHash, planHash: meta.planHash });
      await runGit(meta.workspace, ["-c", "user.name=pi-reqflow", "-c", "user.email=pi-reqflow@localhost", "commit", "-m", `${id}: ${meta.title}\n\nRequirement: ${meta.contractHash}\nPlan: ${meta.planHash}\nReviewed-by: ${actor}`]);
      revision = await runGit(meta.workspace, ["rev-parse", "HEAD"]);
      await appendEvent(project, id, "git_committed", { ...meta, gitCommit: { revision, afterHash: meta.afterHash, actor },
        updatedAt: new Date().toISOString() }, { actor, branch: meta.branch, revision, afterHash: meta.afterHash });
    }
    if (manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.afterHash
        || await runGit(meta.workspace, ["status", "--porcelain"])) throw new Error("提交过程改变了已验证代码，请重新检查。");
    await runGit(meta.workspace, ["push", "--", project.config.remote, `HEAD:refs/heads/${meta.branch}`]);
    if (await publishedRevision(project, meta.workspace, meta.branch) !== revision) throw new Error("远端提交版本与已审核版本不同。");
  });
}

async function mergeForTest(project, id, actor, input) {
  return withLock(path.join(project.archive, "git-integration.lock"), () =>
    withLock(path.join(taskPath(project, id), "task.lock"), async () => {
      let { meta, directory, events } = await readTask(project, id);
      const branch = project.config.gitDelivery.testBranch;
      const fetchedRef = `refs/pi-reqflow/test-candidates/${id}/${randomUUID()}`;
      await runGit(project.root, ["fetch", "--no-tags", "--", project.config.remote, `refs/heads/${branch}:${fetchedRef}`]);
      const targetRevision = await runGit(project.root, ["rev-parse", fetchedRef]);
      let candidate = meta.gitCandidate;
      if (!candidate || candidate.targetRevision !== targetRevision || candidate.requestRevision !== meta.publishedRevision) {
        const attempt = events.filter(event => event.type === "git_candidate_prepared").length + 1;
        const workspace = `${workspacePath(project, id)}-test-merge-${attempt}`;
        await runGit(project.root, ["worktree", "add", "--detach", workspace, targetRevision]);
        const alreadyIntegrated = !(await runGit(project.root, ["rev-list", `${targetRevision}..${meta.publishedRevision}`]));
        candidate = { workspace, branch, targetRevision, requestRevision: meta.publishedRevision, attempt, alreadyIntegrated };
        meta = { ...meta, gitCandidate: candidate };
        await appendEvent(project, id, "git_candidate_prepared", meta, { actor, ...candidate });
        try { if (!alreadyIntegrated) await runGit(workspace, ["-c", "user.name=pi-reqflow", "-c", "user.email=pi-reqflow@localhost", "merge", "--no-commit", "--no-ff", meta.publishedRevision]); }
        catch (error) {
          const conflicts = await runGit(workspace, ["diff", "--name-only", "--diff-filter=U"]);
          throw new Error(conflicts ? `合并冲突：${conflicts.split("\n").join("、")}。已保留工作目录 ${workspace}，请研发处理后重新确认。` : error.message);
        }
      } else {
        const hash = manifestHash(await manifest(candidate.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
        if (input.expectedCandidateHash !== hash) throw new Error("请先查看保留的合并候选变更，再确认继续合并。");
      }
      if (await runGit(candidate.workspace, ["ls-files", "--unmerged"])) throw new Error(`合并冲突尚未解决，请在 ${candidate.workspace} 处理并暂存解决结果。`);
      const changed = await runGit(candidate.workspace, ["diff", "--name-only", candidate.targetRevision, "--"]);
      const report = JSON.parse(await fs.readFile(path.join(directory, "changes.json"), "utf8"));
      if (changed.split("\n").filter(Boolean).some(file => !report.changes.some(change => change.file === file))) throw new Error("候选版本修改了本需求以外的文件，请研发核对。");
      const before = manifestHash(await manifest(candidate.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes));
      const checks = [];
      for (const [index, command] of (meta.developmentChecks).entries()) {
        const logFile = path.join(directory, `test-integration-${candidate.attempt}-check-${index + 1}-${randomUUID()}.log`);
        const result = await runCommand(command, candidate.workspace, project.config.maxPiMs, logFile,
          project.config.maxEventBytes, project.config.environment.checks, project.config.checkSandbox);
        checks.push({ command, logFile, ...result });
        if (result.code !== 0) throw new Error(`合并后测试未通过：${result.tail}`);
      }
      if (manifestHash(await manifest(candidate.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== before) throw new Error("集成测试修改了候选代码。");
      const remote = await runGit(project.root, ["ls-remote", "--heads", project.config.remote, branch]);
      if (remote.split(/\s+/)[0] !== targetRevision) throw new Error("测试目标分支在验证期间更新，请重新形成候选版本。");
      const head = await runGit(candidate.workspace, ["rev-parse", "HEAD"]);
      if (head !== targetRevision && head !== candidate.revision) throw new Error("合并候选中出现未经审核的提交。");
      if (head === targetRevision && !candidate.alreadyIntegrated) {
        await runGit(candidate.workspace, ["add", "-A", "--", ...report.changes.map(change => change.file)]);
        if (await runGit(candidate.workspace, ["rev-parse", "--verify", "MERGE_HEAD"])) {
          await runGit(candidate.workspace, ["-c", "user.name=pi-reqflow", "-c", "user.email=pi-reqflow@localhost", "commit", "-m", `Merge ${id} for test\n\nReviewed-by: ${actor}`]);
        }
      }
      const revision = await runGit(candidate.workspace, ["rev-parse", "HEAD"]);
      if (await runGit(candidate.workspace, ["status", "--porcelain"]) || manifestHash(await manifest(candidate.workspace,
          project.config.excludedPaths, project.config.maxSnapshotBytes)) !== before) throw new Error("候选提交与集成测试的代码不一致。");
      await appendEvent(project, id, "git_candidate_verified", { ...meta, gitCandidate: { ...candidate, revision } },
        { actor, revision, sourceHash: before, checks });
      await runGit(candidate.workspace, ["push", "--", project.config.remote, `HEAD:refs/heads/${branch}`]);
      const observed = await runGit(project.root, ["ls-remote", "--heads", project.config.remote, branch]);
      if (observed.split(/\s+/)[0] !== revision) throw new Error("远端测试分支与已验证合并版本不同。");
      const testCandidate = { workspace: candidate.workspace, branch, publishedRevision: revision,
        sourceHash: before, targetRevision, requestRevision: meta.publishedRevision, checks };
      await appendEvent(project, id, "git_test_branch_published", { ...(await readTask(project, id)).meta, testCandidate },
        { actor, ...testCandidate });
      return testCandidate;
    }));
}

export async function candidateReview(projectPath, id) {
  const project = await loadProject(projectPath);
  const { meta } = await readTask(project, id);
  if (!meta.gitCandidate) return null;
  const candidate = meta.gitCandidate;
  return { workspace: candidate.workspace, branch: candidate.branch,
    hash: manifestHash(await manifest(candidate.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)),
    diff: await runGit(candidate.workspace, ["diff", candidate.targetRevision, "--"]),
    conflicts: await runGit(candidate.workspace, ["diff", "--name-only", "--diff-filter=U"]) };
}

export async function publishTest(projectPath, id, actor, input) {
  if (input.authorizeGit !== true) throw new Error("请明确确认提交、推送及页面显示的合并操作。");
  const project = await loadProject(projectPath);
  if (project.config.mode !== "git") throw new Error("目录项目使用已有的测试部署流程。");
  const mode = project.config.gitDelivery?.testMode ?? "branch";
  if (input.testMode !== mode || (mode === "merge" && input.testBranch !== project.config.gitDelivery.testBranch)) throw new Error("测试发布方式已改变，请刷新后重新确认。");
  return withLock(path.join(project.archive, "git-delivery.lock"), () => withLock(path.join(taskPath(project, id), "development.lock"), async () => {
    try {
      const rows = JSON.parse(await fs.readFile(path.join(project.archive, "index.json"), "utf8"));
      if (rows.some(row => row.id !== id && ["test_deploy_submitting", "test_deploy_running", "test_deploy_outcome_unknown"].includes(row.state))) throw new Error("共享测试环境已有部署正在运行或结果待核实，请稍后再发布。");
      await assertReviewedWorkspace(project, (await readTask(project, id)).meta, input);
      await approveChanges(projectPath, id, actor, input.localValidated === true
        ? "研发已本地验证并查看当前差异，确认提交及测试发布。" : "研发已查看当前代码差异和自动测试结果，确认提交及测试发布。");
      await commitAndPush(project, id, actor, input);
      await recordPublished(projectPath, id, actor);
      if (mode === "merge") await mergeForTest(project, id, actor, input);
    } catch (error) {
      await withLock(path.join(taskPath(project, id), "task.lock"), async () => {
        const { meta } = await readTask(project, id);
        await appendEvent(project, id, "git_delivery_failed", { ...meta, gitDeliveryError: error.message }, { actor, error: error.message });
      });
      throw error;
    }
    const deployed = await deployTest(projectPath, id);
    return deployed.state === "test_deploy_running" ? pollTestDeployment(projectPath, id) : deployed;
  }));
}

export async function redeployTest(projectPath, id, actor, input) {
  if (input.authorizeDeployment !== true) throw new Error("请确认重新发布测试环境。");
  const project = await loadProject(projectPath);
  if (project.config.mode === "git" && input.authorizeGit !== true) throw new Error("重新发布 Git 需求需确认页面显示的提交和合并操作。");
  await withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    if (meta.state !== "test_deployed" || meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted") throw new Error("仅负责研发可重新发布已部署的需求。");
    if (input.expectedAfterHash !== meta.afterHash || input.expectedPlanHash !== meta.planHash
        || describePolicy(project.config).executionConfigHash !== meta.configHash
        || manifestHash(await manifest(meta.workspace, project.config.excludedPaths, project.config.maxSnapshotBytes)) !== meta.afterHash) throw new Error("代码或配置已改变，请核对后再发布。");
    const log = path.join(directory, "test-deploy.log");
    await fs.rename(log, path.join(directory, `test-deploy-retained-${events.at(-1).hash}.log`));
    await appendEvent(project, id, "test_redeployment_authorized", { ...meta, state: "verified", updatedAt: new Date().toISOString() },
      { actor, previousDeployment: meta.testDeployment, afterHash: meta.afterHash });
  });
  if (project.config.mode === "git") return publishTest(projectPath, id, actor, input);
  const result = await deployTest(projectPath, id);
  return result.state === "test_deploy_running" ? pollTestDeployment(projectPath, id) : result;
}

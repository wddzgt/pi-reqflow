import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { readJson, safeId, sha256, writeJson } from "./files.js";
import { validateConfig } from "./config.js";
import { buildProjectBaseline, saveProjectBaseline } from "./baseline.js";
import { initializeProjectContext } from "./project-initialization.js";
import { persistImages, readImage, validateImages } from "./intake-images.js";
import { reportProgress, executionSignal } from "./action-progress.js";

export const actionAuditContext = new AsyncLocalStorage();

export function taskPath(project, id) {
  return path.join(project.archive, "tasks", safeId(id));
}

export async function withLock(file, action, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(file, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() })}\n`);
    await handle.sync();
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(file);
  }
}

export async function readTask(project, id) {
  const directory = taskPath(project, id);
  const rows = (await fs.readFile(path.join(directory, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  let previous = null;
  for (const row of rows) {
    if (row.previous !== previous) throw new Error(`Broken audit chain for ${id}`);
    const hash = sha256(JSON.stringify({ ...row, hash: undefined }));
    if (row.hash !== hash) throw new Error(`Changed audit event for ${id}`);
    for (const image of row.detail.attachments ?? []) await readImage(directory, image);
    for (const artifact of row.detail.artifacts ?? []) {
      if (!/^intake-attempt-\d+\.events\.jsonl(?:\.images\/[a-f0-9]{64}\.(png|jpg|gif|webp))?$/.test(artifact.file)) throw new Error("Invalid intake audit artifact path");
      const content = await fs.readFile(path.join(directory, artifact.file));
      if (content.length !== artifact.bytes || sha256(content) !== artifact.hash) throw new Error("Intake analysis audit log changed");
    }
    previous = row.hash;
  }
  if (rows.at(-1).meta.requestHash) {
    const request = await fs.readFile(path.join(directory, "request.md"));
    if (sha256(request) !== rows.at(-1).meta.requestHash) throw new Error(`Original request changed for ${id}`);
  }
  return { directory, meta: rows.at(-1).meta, lastHash: previous, events: rows };
}

export async function appendEvent(project, id, type, meta, detail) {
  if (detail.error && detail.error === executionSignal()?.reason?.message) detail = { ...detail, executionOutcome: "paused" };
  const context = actionAuditContext.getStore();
  if (context) detail = { ...detail, actor: detail.actor ?? "system:workflow", initiatedBy: context.actor, action: context.action };
  return withLock(path.join(project.archive, "index.lock"), async () => {
    const directory = taskPath(project, id);
    const current = await readTask(project, id);
    const event = { at: new Date().toISOString(), type, detail, meta, previous: current.lastHash };
    event.hash = sha256(JSON.stringify({ ...event, hash: undefined }));
    const handle = await fs.open(path.join(directory, "events.jsonl"), "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await writeJson(path.join(directory, "meta.json"), meta);
    await rebuildIndex(project);
    const progress = { intake_analysis_started: "资料已准备，开始核对业务需求。", intake_analysis_completed: "需求反馈已核对并保存。",
      plan_analysis_started: "开始分析研发方案。", plan_draft_completed: "方案草稿已保存，正在审核影响范围。",
      plan_correction_started: "AI 正在内部修正方案问题，无需逐项回复技术意见。",
      plan_correction_completed: "局部修正已保存，正在复核需求与前后端约定。", plan_correction_reused: "继续复核已保存的局部修正，不重复生成。",
      plan_artifacts_prepared: "方案与审核资料已准备。", plan_created: "研发方案已核对并保存。",
      plan_context_prepared: "已准备本轮讨论所需的方案与需求资料。", plan_reply: "方案讨论反馈已保存。",
      workspace_prepared: "隔离开发环境已准备。", implemented: "代码修改已完成，正在推进后续验证。",
      verified: "项目测试已通过。" }[type];
    if (progress) reportProgress(progress, "", "saved");
  }, 10000);
}

export async function initialize(projectRoot, configFile, options = {}) {
  if (options.inventoryOnly !== undefined && typeof options.inventoryOnly !== "boolean") throw new Error("inventoryOnly must be boolean");
  if (options.accountSource !== undefined && (typeof options.accountSource !== "string" || !path.isAbsolute(options.accountSource))) throw new Error("Account source must be absolute");
  const accountsArchive = options.accountSource === undefined ? null : await fs.realpath(options.accountSource);
  const root = await fs.realpath(projectRoot);
  const config = validateConfig(await readJson(configFile));
  const archive = path.join(root, ".reqflow");
  if (await fs.stat(archive).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("Project is already initialized");
  const baseline = await buildProjectBaseline({ root, config, archive });
  const stagingParent = path.join(root, ".reqflow-init");
  await fs.mkdir(stagingParent, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(stagingParent, "init-"));
  try {
    await writeJson(path.join(staging, "config.json"), config);
    if (accountsArchive !== null) await writeJson(path.join(staging, "account-source.json"), { archive: accountsArchive });
    await fs.mkdir(path.join(staging, "tasks"), { mode: 0o700 });
    await writeJson(path.join(staging, "index.json"), []);
    const result = await saveProjectBaseline({ root, archive: staging, config }, baseline);
    const project = { root, archive: staging, config, accountsArchive: accountsArchive ?? staging };
    if (options.inventoryOnly === true) await writeJson(path.join(staging, "documentation-mode.json"), { mode: "inventory" });
    else await initializeProjectContext(project, baseline);
    await fs.rename(staging, archive);
    return { root, archive, config, documentation: options.inventoryOnly === true ? { mode: "inventory" } : {
      mode: "agent", developerFile: path.join(archive, "PROJECT_REFERENCE.md"),
      agentFile: path.join(archive, "agent.md") }, baseline: { ...result,
      baselineFile: path.join(archive, "baseline.json"), reportFile: path.join(archive, "baseline.md") } };
  } catch (error) {
    const diagnostics = path.join(staging, "initialization");
    if (await fs.stat(diagnostics).then(() => true, (failure) => {
      if (failure.code === "ENOENT") return false;
      throw failure;
    })) {
      const retained = `${staging}-failed-analysis`;
      await fs.rename(diagnostics, retained);
      error.message += `; initialization model audit retained at ${retained}`;
    }
    try { await fs.rm(staging, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Initialization and staging cleanup failed"); }
    throw error;
  }
}

export async function createTask(project, id, title, request, actor, images = []) {
  safeId(id);
  if (typeof title !== "string" || !title.trim() || typeof request !== "string" || !request.trim()
      || typeof actor !== "string" || !actor.trim()) {
    throw new Error("Title, request and authenticated creator are required");
  }
  if (Buffer.byteLength(request) > 1024 * 1024) throw new Error("Original requirement exceeds 1 MiB");
  const validatedImages = validateImages(images);
  return withLock(path.join(project.archive, "index.lock"), async () => {
    const directory = taskPath(project, id);
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    await fs.writeFile(path.join(directory, "request.md"), request, { mode: 0o600 });
    const attachments = await persistImages(directory, validatedImages);
    const meta = { id, title, createdBy: actor, requestHash: sha256(request),
      state: "intake_draft", createdAt: new Date().toISOString(),
      assignments: {}, planVersion: 0, reviewCostUsd: 0, reviewAttempts: {}, intakeRevision: 0, intakeCostUsd: 0, intakeAnalysisAttempts: 0 };
    const event = { at: meta.createdAt, type: "intake_draft", detail: { title, actor, requestHash: meta.requestHash, attachments },
      meta, previous: null };
    event.hash = sha256(JSON.stringify({ ...event, hash: undefined }));
    await fs.writeFile(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await writeJson(path.join(directory, "meta.json"), meta);
    await rebuildIndex(project);
    return meta;
  }, 10000);
}

async function rebuildIndex(project) {
  const ids = await fs.readdir(path.join(project.archive, "tasks"));
  const entries = [];
  for (const id of ids) {
    const { meta, events } = await readTask(project, id);
    const entry = { id, title: meta.title, createdBy: meta.createdBy, assignments: meta.assignments ?? {}, state: meta.state,
      executionPaused: events.at(-1).type === "execution_paused", updatedAt: meta.updatedAt ?? meta.createdAt };
    if (meta.state === "archived") {
      entry.archivedBy = meta.observedBy ?? null;
      entry.archivedAt = meta.observedAt ?? null;
      entry.changeCount = meta.changeCount ?? 0;
    } else if (meta.state === "archived_test_only") {
      entry.archivedBy = meta.archivedBy ?? null;
      entry.archivedAt = meta.updatedAt ?? null;
      entry.changeCount = meta.changeCount ?? 0;
    }
    entries.push(entry);
  }
  await writeJson(path.join(project.archive, "index.json"), entries.sort((a, b) => a.id.localeCompare(b.id)));
}

export async function recoverTaskLock(project, id, actor) {
  if (!actor?.trim()) throw new Error("Human actor name is required");
  const file = path.join(taskPath(project, id), "task.lock");
  const lock = await readJson(file);
  if (lock.host !== os.hostname() || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) {
    throw new Error("Cannot prove that the task lock belongs to a stopped local process");
  }
  try {
    process.kill(lock.pid, 0);
    throw new Error(`Task owner process ${lock.pid} is still running`);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await fs.unlink(file);
  await withLock(file, async () => {
    const { meta } = await readTask(project, id);
    await appendEvent(project, id, "stale_lock_cleared", meta, { actor, previousLock: lock });
  });
  return { id, clearedBy: actor, previousLock: lock };
}

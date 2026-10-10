import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authorizeTaskRead } from "./auth.js";
import { loadProject } from "./config.js";
import { assertInside, readJson, safeId, sha256 } from "./files.js";
import { readTask, taskPath } from "./store.js";
import { intakeDiscussion } from "./intake-conversation.js";
import { readImage } from "./intake-images.js";
import { readPlanAnalysis } from "./plan-analysis.js";
import { planDiscussion } from "./plan-conversation.js";
import { planReviewStatus } from "./plan-review.js";

export async function getRequirementEvidence(projectPath, principal, id) {
  safeId(id);
  const project = await loadProject(projectPath);
  const { meta, directory, events: eventRows } = await readTask(project, id);
  authorizeTaskRead(principal, meta);
  const request = await fs.readFile(path.join(directory, "request.md"), "utf8");
  const feedback = meta.feedbackVersion
    ? await readJson(path.join(directory, `development-feedback-v${meta.feedbackVersion}.json`)) : null;
  const contract = meta.contractVersion ? await readJson(path.join(directory, `contract-v${meta.contractVersion}.json`)) : null;
  if (feedback && sha256(JSON.stringify(feedback)) !== meta.feedbackHash) throw new Error("Development feedback changed");
  if (contract && sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed");
  const reviews = [];
  for (const role of Object.keys(meta.reviewHashes ?? {})) {
    const review = await readJson(path.join(directory, `review-v${meta.contractVersion}-${role}.json`));
    if (sha256(JSON.stringify(review)) !== meta.reviewHashes[role]) throw new Error(`Role review changed: ${role}`);
    reviews.push(review);
  }
  const plan = meta.planHash
    ? await fs.readFile(path.join(directory, `plan-v${meta.planVersion}.md`), "utf8") : null;
  if (plan && sha256(plan) !== meta.planHash) throw new Error("Approved plan changed");
  const planAnalysis = plan ? await readPlanAnalysis(meta, directory) : null;
  const changesFile = path.join(directory, "changes.json");
  const changes = await fs.stat(changesFile).then(() => readJson(changesFile), (error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const auditedChanges = eventRows.findLast((event) => ["implemented", "implementation_failed", "implementation_interrupted"].includes(event.type))?.detail.changes;
  if (changes && JSON.stringify(changes.changes) !== JSON.stringify(auditedChanges)) {
    throw new Error("Archived changes differ from the audited implementation");
  }
  const implementationAttempts = [];
  for (const resumed of eventRows.filter(event => event.type === "implementation_attempt_retained")) {
    const detail = resumed.detail;
    const failed = eventRows.find(event => event.hash === detail.priorFailureHash && ["implementation_failed", "verification_failed", "verified"].includes(event.type));
    if (!failed) throw new Error("Retained implementation state event is missing");
    const retained = path.join(directory, `implementation-${failed.type === "verified" ? "review" : "failure"}-${failed.hash}`);
    if (detail.retained !== retained) throw new Error("Retained implementation attempt is outside its archive");
    const implementation = failed.type !== "implementation_failed"
      ? eventRows.find(event => event.hash === detail.priorImplementationHash && event.type === "implemented") : failed;
    const report = await readJson(path.join(retained, "changes.json"));
    if (!failed || !implementation || eventRows.indexOf(implementation) > eventRows.indexOf(failed)
        || sha256(JSON.stringify(report)) !== detail.reportHash
        || JSON.stringify(report.changes) !== JSON.stringify(implementation.detail.changes)) throw new Error("Retained implementation report changed");
    for (const change of report.changes.filter(change => change.after)) {
      const file = path.join(retained, "after", change.file);
      assertInside(retained, file);
      if (sha256(await fs.readFile(file)) !== change.after.hash
          || ((await fs.stat(file)).mode & 0o777) !== change.after.mode) throw new Error("Retained implementation file changed");
    }
    implementationAttempts.push({ priorState: failed.type, priorStateHash: failed.hash,
      failureHash: failed.type === "verified" ? null : failed.hash, at: failed.at, actor: detail.actor,
      diagnosis: detail.evidence, files: detail.files, retained, changes: report.changes });
  }
  for (const retained of eventRows.filter(event => event.type === "local_validation_changes_retained")) {
    const expected = path.join(directory, `local-review-${retained.previous}`);
    if (retained.detail.retained !== expected) throw new Error("本地验证历史目录与审计记录不同。");
    const report = await readJson(path.join(expected, "changes.json"));
    const previous = eventRows.find(event => event.hash === retained.detail.priorImplementationHash && event.type === "implemented");
    if (!previous || JSON.stringify(report.changes) !== JSON.stringify(previous.detail.changes)) throw new Error("本地验证前的变更记录已改变。");
    for (const change of report.changes.filter(change => change.after)) {
      const file = path.join(expected, "after", change.file); assertInside(expected, file);
      if (sha256(await fs.readFile(file)) !== change.after.hash || ((await fs.stat(file)).mode & 0o777) !== change.after.mode) throw new Error("本地验证前的快照已改变。");
    }
    implementationAttempts.push({ priorState: "verified", priorStateHash: retained.previous, at: retained.at,
      actor: retained.detail.actor, retained: expected, diagnosis: "本地修改前的已验证代码", changes: report.changes });
  }
  const baselineChecks = plan ? eventRows.findLast((event) => event.type === "plan_created")?.detail?.baselineChecks ?? null : null;
  const events = eventRows.slice(-100).reverse().map((event) => ({ at: event.at, type: event.type,
    actor: event.detail?.actor ?? null, approvalKind: event.detail.approvalKind ?? null,
    error: event.detail?.error ?? null,
    timing: event.detail.telemetry ? { durationMs: event.detail.telemetry.durationMs, model: event.detail.telemetry.model,
      requestTimings: event.detail.telemetry.requestTimings, toolCalls: event.detail.telemetry.toolCalls } : null }));
  const resultFile = path.join(directory, "result.md");
  const result = await fs.stat(resultFile).then(() => fs.readFile(resultFile, "utf8"), (error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const environment = meta.testDeployment?.url === undefined ? null : await readJson(path.join(project.archive, `test-environment-${sha256(meta.testDeployment.url)}.json`)).catch(error => {
    if (error.code === "ENOENT") return null; throw error;
  });
  const supersededBy = meta.state === "test_deployed" && environment && environment.taskId !== id
    && environment.url === meta.testDeployment.url ? environment.taskId : null;
  return { meta: { ...meta, testEnvironmentSupersededBy: supersededBy }, request, feedback, contract, reviews, plan, planAnalysis, changes, implementationAttempts, baselineChecks, events, result,
    planReview: planAnalysis ? planReviewStatus(meta, planAnalysis.draft) : null,
    planDiscussion: planDiscussion({ meta, directory, events: eventRows }),
    discussion: intakeDiscussion({ meta, directory, events: eventRows }) };
}

export async function getRequirementImage(projectPath, principal, id, imageId) {
  safeId(id);
  const project = await loadProject(projectPath);
  const task = await readTask(project, id);
  authorizeTaskRead(principal, task.meta);
  const descriptor = task.events.flatMap((event) => event.detail.attachments ?? []).find((image) => image.id === imageId);
  if (!descriptor) { const error = new Error("Requirement image not found"); error.code = "ENOENT"; throw error; }
  return { descriptor, buffer: await readImage(task.directory, descriptor) };
}

export async function getChangedFile(projectPath, principal, id, file) {
  safeId(id);
  if (typeof file !== "string" || !file) throw new Error("Changed file path is required");
  const project = await loadProject(projectPath);
  const directory = taskPath(project, id);
  const { meta, events } = await readTask(project, id);
  authorizeTaskRead(principal, meta);
  const report = await readJson(path.join(directory, "changes.json"));
  const auditedChanges = events.findLast((event) => ["implemented", "implementation_failed", "implementation_interrupted"].includes(event.type))?.detail.changes;
  if (JSON.stringify(report.changes) !== JSON.stringify(auditedChanges)) {
    throw new Error("Archived changes differ from the audited implementation");
  }
  const change = report.changes.find((row) => row.file === file);
  if (!change) throw new Error("File is not in this task's change list");
  async function snapshot(kind, entry) {
    if (!entry) return null;
    const root = path.join(directory, kind);
    const filename = path.join(root, file);
    assertInside(root, filename);
    const buffer = await fs.readFile(filename);
    if (sha256(buffer) !== entry.hash) throw new Error(`${kind} snapshot hash mismatch: ${file}`);
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return buffer.includes(0) ? { text: null, reason: "二进制文件", bytes: buffer.length }
        : { text: value, bytes: buffer.length };
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return { text: null, reason: "文件不是 UTF-8 文本", bytes: buffer.length };
    }
  }
  const before = await snapshot("baseline", change.before);
  const after = await snapshot("after", change.after);
  let patch = null;
  if (!before?.reason && !after?.reason && [before, after].some(value => value
      && (value.bytes > 200000 || value.text.split("\n").length > 400))) {
    const args = ["--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--unified=3", "--",
      change.before ? path.join("baseline", file) : "/dev/null",
      change.after ? path.join("after", file) : "/dev/null"];
    try {
      patch = (await promisify(execFile)("git", args, { cwd: directory, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10000 })).stdout;
    } catch (error) {
      // git diff returns 1 for differences; every execution failure remains an error.
      if (error.code !== 1 || error.signal || error.stderr) throw error;
      patch = error.stdout;
    }
    if (before) before.text = null;
    if (after) after.text = null;
  }
  return { file, before, after, patch,
    beforeMode: change.before?.mode ?? null, afterMode: change.after?.mode ?? null };
}

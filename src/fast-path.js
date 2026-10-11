import { promises as fs } from "node:fs";
import path from "node:path";
import { assertExecutionActive } from "./action-progress.js";
import { allowedFile, loadProject } from "./config.js";
import { manifestHash, sha256 } from "./files.js";
import { readPlanAnalysis } from "./plan-analysis.js";
import { appendEvent, readTask, taskPath, withLock } from "./store.js";
import { sourceManifest } from "./workspace.js";
import { implement, plan, pollTestDeployment, rollback, verify } from "./workflow.js";

function within(file, prefixes) {
  return prefixes.some((prefix) => prefix === "." || file === prefix || file.startsWith(`${prefix}/`));
}

async function assertEligible(project, id, meta, directory) {
  const policy = project.config.fastPath;
  if (policy?.enabled !== true) throw new Error("Fast path is not enabled by project policy");
  const feedback = JSON.parse(await fs.readFile(path.join(directory, `development-feedback-v${meta.feedbackVersion}.json`), "utf8"));
  if (sha256(JSON.stringify(feedback)) !== meta.feedbackHash) throw new Error("Development feedback changed");
  if (feedback.questions.length) throw new Error("Fast path requires no open product questions");
  const contract = JSON.parse(await fs.readFile(path.join(directory, `contract-v${meta.contractVersion}.json`), "utf8"));
  if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error("Confirmed contract changed");
  if (contract.acceptance.length > policy.maxAcceptance) {
    throw new Error("Fast path acceptance or file count exceeds project policy");
  }
  const source = await sourceManifest(project);
  if (["contract_confirmed", "role_review", "review_passed"].includes(meta.state)) {
    return { contract, files: null, sourceHash: manifestHash(source) };
  }
  await readPlanAnalysis(meta, directory);
  const files = meta.developmentFiles;
  if (!Array.isArray(files) || !files.length || files.length > policy.maxFiles || new Set(files).size !== files.length) {
    throw new Error("Fast path acceptance or file count exceeds project policy");
  }
  for (const file of files) {
    if (!Object.hasOwn(source, file) || !allowedFile(file, project.config) || !within(file, policy.allowedPaths)) {
      throw new Error(`Fast path requires an existing allowed file: ${file}`);
    }
  }
  return { contract, files, sourceHash: manifestHash(source) };
}

async function markEligiblePlan(project, id) {
  await withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    if (meta.state !== "plan_review") throw new Error("Fast path expected a plan awaiting review");
    const { files, sourceHash } = await assertEligible(project, id, meta, directory);
    const analysis = await readPlanAnalysis(meta, directory);
    if (analysis.admission.status !== "accepted" || analysis.blockers.length || ["existingBehavior", "interfaces", "data"].some((kind) => analysis.draft.impacts[kind].status !== "none")) {
      throw new Error("Fast path requires explicit evidence of no historical behavior, interface or data impact");
    }
    const planText = await fs.readFile(path.join(directory, `plan-v${meta.planVersion}.md`), "utf8");
    if (sha256(planText) !== meta.planHash) throw new Error("Plan changed after generation");
    const pending = planText.match(/(?:^|\n)## 待确认\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim();
    if (pending !== "无") throw new Error("Fast path plan has unresolved questions");
    if (!files.every((file) => planText.includes(file))) {
      throw new Error("Fast path plan must name every approved file");
    }
    const eligibility = { contractHash: meta.contractHash, planHash: meta.planHash,
      configHash: meta.configHash, sourceHash, policyHash: sha256(JSON.stringify(project.config.fastPath)) };
    if (JSON.stringify(meta.fastPathEligibility) === JSON.stringify(eligibility)) return;
    const next = { ...meta, fastPathEligibility: eligibility, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "fast_path_eligible", next, { eligibility });
  });
}

async function assertFastChanges(project, id) {
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory, events } = await readTask(project, id);
    if (meta.state !== "implemented") throw new Error("Fast path expected implemented changes");
    const { files } = await assertEligible(project, id, meta, directory);
    const changes = events.findLast((event) => event.type === "implemented")?.detail.changes;
    if (!Array.isArray(changes)) throw new Error("Implementation change list is missing");
    const changedBytes = changes.reduce((total, row) => total + Math.max(row.before?.bytes ?? 0, row.after?.bytes ?? 0), 0);
    const violations = changes.filter((row) => !files.includes(row.file)).map((row) => row.file);
    if (changedBytes > project.config.fastPath.maxChangedBytes) violations.push("changed file byte limit");
    if (!violations.length) return meta;
    const failed = { ...meta, state: "implementation_failed", updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "fast_path_scope_failed", failed, { violations, changedBytes });
    throw new Error(`Fast path change boundary failed: ${violations.join(", ")}`);
  });
}

export async function runFastPath(projectPath, id, initiator) {
  const project = await loadProject(projectPath);
  if (project.config.fastPath?.enabled !== true) throw new Error("Fast path is not enabled by project policy");
  try {
    let eligibilityChecked = false;
    for (let step = 0; step < 12; step++) {
      assertExecutionActive();
      const { meta, directory } = await readTask(project, id);
      if (meta.state === "test_deployed") return { id, state: meta.state, next: "human-test-acceptance" };
      if (!["contract_confirmed", "role_review", "review_passed", "plan_review", "approved",
        "implemented", "verified", "test_deploy_running"].includes(meta.state)) {
        throw new Error(`Fast path cannot continue from ${meta.state}`);
      }
      if (!eligibilityChecked) {
        await assertEligible(project, id, meta, directory);
        eligibilityChecked = true;
      }
      if (["contract_confirmed", "role_review", "review_passed"].includes(meta.state)) {
        await plan(project.root, id);
      } else if (meta.state === "plan_review") {
        await markEligiblePlan(project, id);
        return { id, state: meta.state, next: "approve-plan", riskOwner: meta.assignments.developer.userId };
      } else if (meta.state === "approved") {
        if (!meta.fastPathEligibility || meta.planApprovedBy !== meta.assignments.developer?.userId) {
          throw new Error("Fast path requires the assigned developer to approve the eligible plan");
        }
        await implement(project.root, id);
      } else if (meta.state === "implemented") {
        await assertFastChanges(project, id);
        await verify(project.root, id);
      } else if (meta.state === "verified") {
        if (meta.planApprovedBy !== meta.assignments.developer?.userId) {
          throw new Error("Fast path requires human plan approval");
        }
        return { id, state: meta.state, next: "choose-validation", localVerificationAvailable: true,
          testDeploymentAvailable: project.config.testDeployment.kind !== "unconfigured" };
      } else if (meta.state === "test_deploy_running") {
        await pollTestDeployment(project.root, id);
      }
    }
    throw new Error("Fast path exceeded its stage limit");
  } catch (error) {
    assertExecutionActive();
    const { meta } = await readTask(project, id);
    await withLock(path.join(taskPath(project, id), "task.lock"), async () => {
      const current = await readTask(project, id);
      await appendEvent(project, id, "fast_path_attempt_failed", current.meta,
        { initiatedBy: initiator, stage: current.meta.state, error: error.message });
    });
    if (["implementation_failed", "verification_failed"].includes(meta.state)
        && meta.fastPathEligibility && meta.planApprovedBy === meta.assignments.developer?.userId) {
      try { await rollback(project.root, id, "policy:fast-path"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Fast path failed and rollback was rejected"); }
    }
    throw error;
  }
}

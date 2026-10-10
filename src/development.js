import path from "node:path";
import { describePolicy, loadProject } from "./config.js";
import { appendEvent, readTask, taskPath, withLock } from "./store.js";
import { readPlanAnalysis } from "./plan-analysis.js";
import { implement, plan, resumeImplementation, verify } from "./workflow.js";
import { reportProgress } from "./action-progress.js";

export async function develop(projectPath, id, actor, authorizeImplementation, expected = {}) {
  if (authorizeImplementation !== true) throw new Error("Develop requires explicit authorization for isolated implementation");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "development.lock"), async () => {
    await withLock(path.join(taskPath(project, id), "task.lock"), async () => {
      const { meta } = await readTask(project, id);
      if (meta.assignments?.developer?.userId !== actor || meta.assignments.developer.status !== "accepted") {
        throw new Error("Only the assigned developer can authorize development");
      }
      if (!["contract_confirmed", "role_review", "review_passed", "plan_review", "approved", "implemented", "verified", "implementation_failed", "verification_failed"].includes(meta.state)) {
        throw new Error(`Development cannot continue from ${meta.state}`);
      }
      if (["implementation_failed", "verification_failed"].includes(meta.state)
          && (expected.expectedPlanHash !== meta.planHash || expected.expectedAfterHash !== meta.afterHash))
        throw new Error("请查看当前中断现场，再确认继续开发。");
      await appendEvent(project, id, "development_authorized", meta, { actor,
        contractHash: meta.contractHash, configHash: describePolicy(project.config).executionConfigHash,
        scope: "plan requires human confirmation; then isolated implementation and verification; developer chooses local validation or test deployment" });
    });
    let automaticRetries = 0;
    let pendingFailure = null;
    for (let step = 0; step < 9; step++) {
      const { meta, directory, events } = await readTask(project, id);
      if (["implementation_failed", "verification_failed"].includes(meta.state)) {
        const failure = events.findLast(event => event.type === meta.state);
        const kind = meta.developmentFailure?.kind;
        const automatic = pendingFailure !== null;
        const resumable = meta.state === "verification_failed" ? kind === "check_failed"
          : ["tool_limit", "timeout"].includes(kind)
            && (meta.changeCount > 0 || Boolean(failure.detail.telemetry?.sessionCheckpoint));
        let reason = failure.detail.error;
        if (!automatic || (automaticRetries < 1 && resumable)) {
          const changes = events.findLast(event => ["implementation_failed", "implemented"].includes(event.type)).detail.changes;
          const files = [...new Set([...meta.developmentFiles, ...changes.map(change => change.file)])];
          const evidence = `Previous ${meta.state}: ${failure.detail.error}. Continue the approved requirement from retained files. Diagnose failures using current source and real checks; no new business scope.`.slice(0, 4000);
          try {
            await resumeImplementation(projectPath, id, actor, evidence, files, undefined, undefined,
              { expectedPlanHash: meta.planHash, expectedAfterHash: meta.afterHash, automatic });
            if (automatic) automaticRetries++;
            reportProgress(automatic ? "已保留本轮现场，正在自动继续或修复；本次最多自动恢复一次。" : "正在从已保存的代码和上下文继续执行。", "", "resuming");
            pendingFailure = null;
            continue;
          } catch (error) { reason = error.message; }
        }
        await withLock(path.join(taskPath(project, id), "task.lock"), async () => {
          const current = await readTask(project, id);
          await appendEvent(project, id, "development_paused", { ...current.meta,
            developmentPause: { reason, automaticRetries, at: new Date().toISOString() } }, { actor, reason, automaticRetries });
        });
        return { id, state: meta.state, ok: false, next: "needs-attention", error: reason };
      }
      if (["contract_confirmed", "role_review", "review_passed"].includes(meta.state)) await plan(projectPath, id);
      else if (meta.state === "plan_review") {
        const analysis = await readPlanAnalysis(meta, directory);
        if (!analysis.admission.eligible || analysis.blockers.length) return { id, state: meta.state,
          next: analysis.admission.status === "out_of_scope" ? "human-led-design" : "resolve-blockers",
          reasons: analysis.blockers, admission: analysis.admission };
        return { id, state: meta.state, next: "approve-plan" };
      } else if (meta.state === "approved") {
        if (events.findLast(event => event.type === "plan_approved")?.detail.approvalKind !== "human") {
          throw new Error("Development requires the developer's confirmation of this plan");
        }
        try { await implement(projectPath, id); }
        catch (error) {
          if ((await readTask(project, id)).meta.state !== "implementation_failed") throw error;
          pendingFailure = error;
        }
      }
      else if (meta.state === "implemented") {
        try { await verify(projectPath, id); }
        catch (error) {
          if ((await readTask(project, id)).meta.state !== "verification_failed") throw error;
          pendingFailure = error;
        }
      }
      else if (meta.state === "verified") {
        return { id, state: meta.state, next: "choose-validation", localVerificationAvailable: true,
          testDeploymentAvailable: project.config.testDeployment.kind !== "unconfigured" };
      }
      else throw new Error(`Development stopped at ${meta.state}`);
    }
    throw new Error("Development exceeded its stage limit");
  });
}

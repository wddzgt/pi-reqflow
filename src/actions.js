import { loadProject } from "./config.js";
import { authorizeTaskAction, authorizeTaskRead } from "./auth.js";
import { assignMember, assignDevelopmentTeam, respondToAssignment } from "./assignment.js";
import { reviewPlanPart } from "./plan-review.js";
import { actionAuditContext, appendEvent, readTask, recoverTaskLock, taskPath, withLock } from "./store.js";
import path from "node:path";
import { executionUsage } from "./admission.js";
import { progressContext, reportProgress, controlledExecution, executionStatus, pauseExecution, assertExecutionActive } from "./action-progress.js";
import { confirmContract, finalizeRoleReview, recordDevFeedback, reviseContract,
  runRoleReviewWithPi, submitRoleReview } from "./intake.js";
import { runFastPath } from "./fast-path.js";
import { develop } from "./development.js";
import { addIntakeMessage, analyzeIntake } from "./intake-conversation.js";
import { discussPlan, editPlan } from "./plan-conversation.js";
import { localValidation, publishTest, recheckLocalChanges, redeployTest } from "./git-delivery.js";
import {
  acceptTest, approveChanges, approvePlan, approveRelease, archiveTestOnly, deployTest,
  implement, inspectInterrupted, observeRelease, plan, pollRelease,
  pollTestDeployment, reconcileRelease, reconcileTestDeployment, recordPublished, release, revisePlan, rollback, restartDevelopment,
  verify, verifyCandidate, resolvePlanFindings, resumeImplementation,
} from "./workflow.js";

const pausableActions = new Set(["analyze-intake", "run-review", "plan", "develop", "fast-track", "revise-plan",
  "discuss-plan", "edit-plan", "approve-plan", "implement", "verify", "recheck-local", "local-validation", "resume-implementation"]);

export async function executeRequirementAction(projectPath, id, body, principal, onProgress) {
  if (["pause-execution", "continue-execution"].includes(body.action)) {
    const project = await loadProject(projectPath);
    const task = await readTask(project, id);
    const active = executionStatus(task.directory);
    const original = active?.action ?? task.meta.executionPause?.body.action;
    if (!original) throw new Error("没有可暂停或继续的执行。");
    authorizeTaskRead(principal, task.meta);
    if (body.action === "pause-execution") return pauseExecution(task.directory, principal.id, principal.roles.includes("admin"));
    if (active) throw new Error("现场仍在保存中，请等待暂停完成。");
    const paused = task.meta.executionPause;
    if (!paused || task.events.at(-1).type !== "execution_paused" || body.expectedAuditHead !== task.lastHash)
      throw new Error("暂停后需求已改变，请刷新并通过当前阶段的操作继续。");
    if (paused.actor !== principal.id) throw new Error("请由本轮启动人继续执行。");
    let input = paused.body;
    if (["approve-plan", "develop", "implement", "fast-track", "resume-implementation"].includes(input.action)) {
      input = { action: "develop", authorizeImplementation: true, expectedPlanHash: task.meta.planHash,
        expectedAfterHash: task.meta.afterHash };
      if (task.meta.state === "verification_failed" && task.meta.developmentFailure.kind === "user_paused") input = { action: "verify" };
    } else if (["plan", "revise-plan", "edit-plan", "accept-assignment"].includes(input.action)) {
      if (task.meta.state === "plan_review") return { state: task.meta.state, next: "approve-plan" };
      input = { action: "plan" };
    } else if (input.action === "discuss-plan") {
      const message = task.events.findLast(event => event.type === "plan_message" && event.detail.actor === principal.id
        && event.detail.planHash === task.meta.planHash);
      if (!message) throw new Error("暂停的方案问题没有已保存的输入记录。");
      input = { ...input, message: { ...input.message, retryEventHash: message.hash } };
    } else if (input.action === "recheck-local" && task.meta.state === "verification_failed") input = { action: "verify" };
    return executeRequirementAction(projectPath, id, input, principal, onProgress);
  }
  const { action, evidence, feedback, contract, review } = body;
  if (typeof action !== "string") throw new Error("Action is required");
  if (Object.hasOwn(body, "actor")) throw new Error("Actor is determined by the authenticated session");
  const project = await loadProject(projectPath);
  authorizeTaskAction(principal, action, (await readTask(project, id)).meta, review?.role ?? body.role);
  const actor = principal.id;
  return progressContext.run(onProgress, () => actionAuditContext.run({ actor, action }, async () => {
  const execute = async () => {
  reportProgress("请求已接收，正在准备本轮任务。", "", "started");
  switch (action) {
    case "extend-execution-budget": {
      if (!Number.isSafeInteger(body.additionalModelMs) || body.additionalModelMs < 60000 || body.additionalModelMs > 3600000
          || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 4000)
        throw new Error("请明确追加1至60分钟执行时长，并填写继续执行的原因。");
      return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
        const task = await readTask(project, id);
        if (body.expectedAuditHead !== task.lastHash) throw new Error("需求记录已改变，请刷新后再追加预算。");
        const next = { ...task.meta, executionBoundary: null, updatedAt: new Date().toISOString() };
        await appendEvent(project, id, "execution_budget_extended", next, { actor,
          additionalModelMs: body.additionalModelMs, reason: body.reason.trim(), contractHash: task.meta.contractHash,
          priorAuditHead: task.lastHash, usageBefore: executionUsage(task.events) });
        return next;
      });
    }
    case "intake-message": return addIntakeMessage(projectPath, id, actor, body.message);
    case "analyze-intake": return analyzeIntake(projectPath, id, actor);
    case "assign-member": return assignMember(projectPath, id, actor, body.role, body.member);
    case "assign-team": return assignDevelopmentTeam(projectPath, id, actor, body.team);
    case "review-plan": return reviewPlanPart(projectPath, id, actor, body);
    case "accept-assignment": {
      const accepted = await respondToAssignment(projectPath, id, actor, body.role, true);
      if (body.preparePlan === true && accepted.state === "contract_confirmed") return plan(projectPath, id);
      return accepted;
    }
    case "decline-assignment": return respondToAssignment(projectPath, id, actor, body.role, false);
    case "dev-feedback": return recordDevFeedback(projectPath, id, actor, feedback);
    case "confirm-contract": return confirmContract(projectPath, id, actor, contract, body.expectedAnalysisHash);
    case "revise-contract": return reviseContract(projectPath, id, actor, contract);
    case "submit-review": return submitRoleReview(projectPath, id, actor, review);
    case "run-review": return runRoleReviewWithPi(projectPath, id, body.role, actor);
    case "finalize-review": return finalizeRoleReview(projectPath, id, actor);
    case "plan": return plan(projectPath, id);
    case "develop": return develop(projectPath, id, actor, body.authorizeImplementation, body);
    case "fast-track": return runFastPath(projectPath, id, actor);
    case "revise-plan": return revisePlan(projectPath, id, actor, feedback, undefined,
      body.expectedPlanHash === undefined && body.retry !== true ? undefined
        : { expectedPlanHash: body.expectedPlanHash, ...(body.retry === true ? { retry: true } : {}) });
    case "discuss-plan": return discussPlan(projectPath, id, actor, body.message);
    case "edit-plan": return editPlan(projectPath, id, actor, body);
    case "resolve-plan-findings": return resolvePlanFindings(projectPath, id, actor, body.resolution);
    case "resume-implementation": return resumeImplementation(projectPath, id, actor, evidence, body.files, body.reviewedEdits, body.modelSelection);
    case "approve-plan": {
      if (body.checksText !== undefined) throw new Error("检查命令由研发方案确定，请修改方案后重新确认。");
      const approved = await approvePlan(projectPath, id, actor, body.scope, undefined, body.expectedPlanHash, body.developmentBranch);
      return approved.fastPathEligibility ? runFastPath(projectPath, id, actor) : develop(projectPath, id, actor, true);
    }
    case "approve-changes": return approveChanges(projectPath, id, actor, evidence);
    case "implement": return implement(projectPath, id);
    case "verify": return verify(projectPath, id);
    case "record-published": return recordPublished(projectPath, id, actor);
    case "local-validation": return localValidation(projectPath, id, actor, body);
    case "recheck-local": return recheckLocalChanges(projectPath, id, actor, body);
    case "publish-test": return publishTest(projectPath, id, actor, body);
    case "redeploy-test": return redeployTest(projectPath, id, actor, body);
    case "deploy-test": {
      const deployed = await deployTest(projectPath, id);
      return deployed.state === "test_deploy_running" ? pollTestDeployment(projectPath, id) : deployed;
    }
    case "poll-deploy": return pollTestDeployment(projectPath, id);
    case "reconcile-test-deploy": return reconcileTestDeployment(projectPath, id, actor,
      body.outcome, body.observedRevision, evidence);
    case "accept-test": {
      const current = await readTask(project, id);
      if (current.meta.state === "verified" && current.meta.changeApproval?.afterHash !== current.meta.afterHash)
        await approveChanges(projectPath, id, actor, evidence);
      const accepted = await acceptTest(projectPath, id, actor, evidence);
      if (project.config.productionDeployment.kind === "none") {
        return archiveTestOnly(projectPath, id, actor);
      }
      return accepted;
    }
    case "verify-candidate": return verifyCandidate(projectPath, id);
    case "approve-release": return approveRelease(projectPath, id, actor);
    case "release": return release(projectPath, id);
    case "poll-release": return pollRelease(projectPath, id);
    case "reconcile-release": return reconcileRelease(projectPath, id, actor,
      body.outcome, body.observedRevision, evidence);
    case "observe-release": return observeRelease(projectPath, id, actor, evidence);
    case "archive-test-only": return archiveTestOnly(projectPath, id, actor);
    case "rollback": return rollback(projectPath, id, actor);
    case "restart-development": return restartDevelopment(projectPath, id, actor, body.expectedAuditHead);
    case "inspect-interrupted": return inspectInterrupted(projectPath, id);
    case "recover-lock": return recoverTaskLock(await loadProject(projectPath), id, actor);
    default: throw new Error(`Unsupported action: ${action}`);
  }
  };
  if (!pausableActions.has(action) && !(action === "accept-assignment" && body.preparePlan === true)) {
    if (executionStatus(taskPath(project, id))) throw new Error("本需求正在执行，请先暂停并等待现场保存。");
    return execute();
  }
  return controlledExecution(taskPath(project, id), action, actor, async () => {
    try {
      const result = await execute(); assertExecutionActive();
      await withLock(path.join(taskPath(project, id), "task.lock"), async () => {
        const task = await readTask(project, id);
        if (task.meta.executionPause) await appendEvent(project, id, "execution_continued",
          { ...task.meta, executionPause: null }, { actor, operation: action, priorPause: task.meta.executionPause.at });
      });
      return result;
    }
    catch (error) {
      if (error.code !== "EXECUTION_PAUSED") throw error;
      return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
        const task = await readTask(project, id);
        const pausedBy = executionStatus(task.directory).pausedBy;
        const pause = { actor, pausedBy, body, at: new Date().toISOString() };
        await appendEvent(project, id, "execution_paused", { ...task.meta, executionPause: pause },
          { actor: pausedBy, operation: action, state: task.meta.state, error: error.message });
        return { id, state: task.meta.state, paused: true, next: "continue-execution" };
      });
    }
  });
  }));
}

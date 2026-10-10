import { loadProject } from "./config.js";
import { authorizeTaskAction } from "./auth.js";
import { assignMember, assignDevelopmentTeam, respondToAssignment } from "./assignment.js";
import { reviewPlanPart } from "./plan-review.js";
import { actionAuditContext, readTask, recoverTaskLock } from "./store.js";
import { progressContext, reportProgress } from "./action-progress.js";
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
  pollTestDeployment, reconcileRelease, reconcileTestDeployment, recordPublished, release, revisePlan, rollback,
  verify, verifyCandidate, resolvePlanFindings, resumeImplementation,
} from "./workflow.js";

export async function executeRequirementAction(projectPath, id, body, principal, onProgress) {
  const { action, evidence, feedback, contract, review } = body;
  if (typeof action !== "string") throw new Error("Action is required");
  if (Object.hasOwn(body, "actor")) throw new Error("Actor is determined by the authenticated session");
  const project = await loadProject(projectPath);
  authorizeTaskAction(principal, action, (await readTask(project, id)).meta, review?.role ?? body.role);
  const actor = principal.id;
  return progressContext.run(onProgress, () => actionAuditContext.run({ actor, action }, async () => {
  reportProgress("请求已接收，正在准备本轮任务。", "", "started");
  switch (action) {
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
      const approved = await approvePlan(projectPath, id, actor, body.scope, undefined, body.expectedPlanHash, body.developmentBranch, body.checksText);
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
    case "inspect-interrupted": return inspectInterrupted(projectPath, id);
    case "recover-lock": return recoverTaskLock(await loadProject(projectPath), id, actor);
    default: throw new Error(`Unsupported action: ${action}`);
  }
  }));
}

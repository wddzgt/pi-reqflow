const stages = {
  alignment: ["intake_draft", "intake_clarifying", "intake_ready", "intake_analyzing", "intake_assigned", "intake_feedback"],
  assignment: ["assignment_pending"],
  design: ["contract_confirmed", "role_review", "review_passed", "submitted", "plan_review", "approved"],
  implementation: ["implementing", "implemented", "implementation_failed", "implementation_inspection_failed", "implementation_interrupted", "rolled_back"],
  validation: ["verified", "verification_failed", "test_deploy_submitting", "test_deploy_running", "test_deploy_outcome_unknown", "test_deploy_failed", "test_deployed", "test_accepted"],
  release: ["merge_verifying", "merge_verified", "merge_verification_failed", "release_approved", "release_submitting", "release_running", "release_outcome_unknown", "release_failed", "released"],
  closed: ["archived", "archived_test_only"],
};
const closedStates = new Set(["archived", "archived_test_only", "rolled_back"]);
const humanStates = new Set(["intake_assigned", "intake_clarifying", "intake_ready", "intake_feedback", "assignment_pending", "plan_review", "verified", "test_deployed", "merge_verified", "released"]);
const diagnosticTypes = new Set(["intake_analysis_started", "intake_message", "plan_analysis_started", "plan_draft_completed", "plan_correction_started", "plan_correction_completed", "plan_correction_reused", "plan_artifacts_prepared", "plan_specialist_completed", "pi_run_skipped", "fast_path_eligible", "test_deploy_running", "release_running"]);

export function lifecycleStage(state) {
  const entry = Object.entries(stages).find(([, states]) => states.includes(state));
  if (!entry) throw new Error(`Unknown lifecycle state: ${state}`);
  return entry[0];
}

export function lifecycleResponsibility(meta) {
  const stage = lifecycleStage(meta.state);
  const assignment = meta.assignments?.developer;
  if (stage === "alignment" && meta.state !== "intake_assigned") return { role: "product", userId: meta.createdBy };
  if (meta.state === "contract_confirmed" && (!assignment || assignment.status === "declined")) return { role: "product", userId: meta.createdBy };
  return { role: "developer", userId: assignment && assignment.status !== "declined" ? assignment.userId : null };
}

export function lifecycleStatus(meta, events, now) {
  const last = events.at(-1);
  let transition = events[0];
  for (let index = 1; index < events.length; index++) {
    if (events[index].meta.state !== events[index - 1].meta.state) transition = events[index];
  }
  const closed = closedStates.has(meta.state);
  const meaningful = events.filter((event) => !diagnosticTypes.has(event.type));
  const latest = meaningful.at(-1);
  const failures = new Map();
  const families = {
    intake: ["intake_analysis_failed", "intake_analysis_completed"],
    review: ["role_review_blocked", "role_review_passed", "contract_revised", "contract_confirmed"],
    plan: ["plan_attempt_failed", "plan_created", "contract_revised", "contract_confirmed"],
    implementation: ["implementation_failed", "implementation_inspection_failed", "implementation_interrupted", "implemented"],
    verification: ["verification_failed", "verified"],
    test: ["test_deploy_failed", "test_deploy_outcome_unknown", "test_deployed", "test_deployment_reconciled"],
    testPoll: ["test_deploy_poll_failed", "test_deploy_running", "test_deployed"],
    merge: ["merge_verification_failed", "merge_verified"],
    gitDelivery: ["git_delivery_failed", "git_test_branch_published", "test_deployed"],
    release: ["release_failed", "release_outcome_unknown", "released", "release_reconciled"],
    releasePoll: ["release_poll_failed", "release_running", "released"],
    rollback: ["rollback_rejected", "workspace_rolled_back"],
    fast: ["fast_path_attempt_failed", "fast_path_scope_failed", "plan_created"],
    budget: ["pi_budget_exhausted", "role_review_submitted", "plan_created", "implemented"],
    boundary: ["execution_boundary_stopped", "plan_created", "implemented"],
  };
  for (const event of events) {
    if (event.type === "role_review_attempt_failed") failures.set(`review:${event.detail.role}`, event);
    if (event.type === "role_review_submitted") failures.delete(`review:${event.detail.role}`);
    if (event.type === "plan_specialist_failed") failures.set(`specialist:${event.detail.role}`, event);
    if (event.type === "plan_specialist_completed") failures.delete(`specialist:${event.detail.role}`);
    if (["plan_created", "contract_confirmed", "contract_revised"].includes(event.type)) {
      for (const key of failures.keys()) if (key.startsWith("specialist:")) failures.delete(key);
      failures.delete("plan-blockers");
    }
    if (event.type === "plan_created" && event.detail.blockers?.length) failures.set("plan-blockers", event);
    if (event.type === "plan_findings_resolved") failures.delete("plan-blockers");
    if (["contract_confirmed", "contract_revised", "role_review_passed"].includes(event.type)) {
      for (const key of failures.keys()) if (key.startsWith("review:")) failures.delete(key);
    }
    for (const [family, types] of Object.entries(families)) {
      if (!types.includes(event.type)) continue;
      if (event.type.endsWith("_failed") || event.type.endsWith("_outcome_unknown") || ["role_review_blocked", "implementation_interrupted", "rollback_rejected", "pi_budget_exhausted", "execution_boundary_stopped"].includes(event.type) || event.detail.outcome === "failed") failures.set(family, event);
      else failures.delete(family);
    }
  }
  const unresolved = closed ? [] : [...failures.values()];
  const responsibility = lifecycleResponsibility(meta);
  return { stage: lifecycleStage(meta.state), closed,
    waitingHuman: !closed && (humanStates.has(meta.state) || meta.executionBoundary?.length > 0 || (meta.state === "contract_confirmed" && responsibility.role === "product")),
    responsible: responsibility, stateSince: transition.at,
    stateAgeMs: Math.max(0, now - Date.parse(transition.at)),
    cycleMs: Math.max(0, Date.parse(closed ? transition.at : last.at) - Date.parse(events[0].at)),
    needsAttention: !closed && unresolved.length > 0,
    unresolved: unresolved.map((event) => ({ type: event.type, at: event.at, hash: event.hash })),
    latestMilestone: latest ? { type: latest.type, at: latest.at } : null };
}

export function lifecycleEvents(events) {
  return events.flatMap((event, sequence) => {
    if (diagnosticTypes.has(event.type)) return [];
    const detail = event.detail;
    const outcome = event.type.endsWith("_outcome_unknown") ? "unknown"
      : event.type.endsWith("_failed") || event.type === "rollback_rejected" || detail.outcome === "failed" ? "failed"
      : ["role_review_blocked", "pi_budget_exhausted", "execution_boundary_stopped"].includes(event.type) || (event.type === "plan_created" && detail.blockers?.length) ? "blocked" : "recorded";
    const references = ["requestHash", "contractHash", "planHash", "feedbackHash", "reviewHash", "evidenceHash", "planResolutionHash"]
      .filter((key) => typeof detail[key] === "string").map((key) => ({ kind: key, hash: detail[key] }));
    return [{ sequence, at: event.at, type: event.type, state: event.meta.state, stage: lifecycleStage(event.meta.state),
      outcome, actor: detail.actor ?? null, initiatedBy: detail.initiatedBy ?? null,
      approvalKind: detail.approvalKind ?? null,
      responsible: lifecycleResponsibility(event.meta), role: detail.role ?? null, memberId: detail.memberId ?? null,
      contractVersion: event.meta.contractVersion ?? 0, planVersion: event.meta.planVersion,
      checkCount: detail.checks?.length ?? detail.baselineChecks?.length ?? null,
      changeCount: detail.changes?.length ?? null, references, hash: event.hash }];
  });
}

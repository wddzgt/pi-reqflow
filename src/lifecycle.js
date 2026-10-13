const stages = {
  alignment: ["intake_draft", "intake_clarifying", "intake_ready", "intake_analyzing", "intake_assigned", "intake_feedback"],
  assignment: ["assignment_pending"],
  design: ["contract_confirmed", "role_review", "review_passed", "submitted", "plan_review", "approved"],
  implementation: ["implementing", "implemented", "implementation_failed", "implementation_inspection_failed", "implementation_interrupted", "rolled_back"],
  validation: ["verified", "verification_failed", "test_deploy_submitting", "test_deploy_running", "test_deploy_outcome_unknown", "test_deploy_failed", "test_deployed", "test_accepted"],
  release: ["merge_verifying", "merge_verified", "merge_verification_failed", "release_approved", "release_submitting", "release_running", "release_outcome_unknown", "release_failed", "released"],
  closed: ["archived", "archived_test_only"],
};
const closedStates = new Set(["archived", "archived_test_only"]);
const humanStates = new Set(["intake_assigned", "intake_clarifying", "intake_ready", "intake_feedback", "assignment_pending", "plan_review", "verified", "test_deployed", "merge_verified", "released", "rolled_back"]);
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
    acceptance: ["acceptance_discussion_failed", "acceptance_reply", "acceptance_feedback_closed", "acceptance_repair_requested"],
  };
  for (const event of events) {
    if (["workspace_rolled_back", "development_restarted"].includes(event.type)) failures.clear();
    if (event.detail.executionOutcome === "paused") continue;
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
    waitingHuman: !closed && (last.type === "execution_paused" || humanStates.has(meta.state) || meta.executionBoundary?.length > 0 || (meta.state === "contract_confirmed" && responsibility.role === "product")),
    responsible: responsibility, stateSince: transition.at,
    stateAgeMs: Math.max(0, now - Date.parse(transition.at)),
    cycleMs: Math.max(0, Date.parse(closed ? transition.at : last.at) - Date.parse(events[0].at)),
    needsAttention: !closed && unresolved.length > 0,
    unresolved: unresolved.map((event) => ({ type: event.type, at: event.at, hash: event.hash })),
    latestMilestone: latest ? { type: latest.type, at: latest.at } : null };
}

export function lifecycleResults(meta, events) {
  const aligned = Boolean(meta.contractHash) && lifecycleStage(meta.state) !== "alignment";
  const confirmed = aligned ? events.findLast(event => ["contract_confirmed", "contract_revised"].includes(event.type)
    && event.meta.contractHash === meta.contractHash && event.meta.contractVersion === meta.contractVersion) : null;
  const currentPlan = event => aligned && meta.state !== "contract_confirmed" && event.meta.planHash === meta.planHash
    && event.meta.contractHash === meta.contractHash;
  const approved = events.findLast(event => event.type === "plan_approved" && currentPlan(event));
  const planned = events.findLast(event => event.type === "plan_created" && currentPlan(event));
  const boundary = events.findLastIndex(event => ["acceptance_repair_requested", "implementation_attempt_retained",
    "local_validation_changes_retained", "development_restarted", "workspace_rolled_back"].includes(event.type));
  const currentCode = event => currentPlan(event) && event.meta.afterHash === meta.afterHash && Boolean(meta.afterHash);
  const implemented = events.slice(boundary + 1).findLast(event => event.type === "implemented" && currentCode(event));
  const verified = implemented && events.slice(boundary + 1).findLast(event => event.type === "verified" && currentCode(event));
  const accepted = verified && events.slice(boundary + 1).findLast(event => event.type === "test_accepted" && currentCode(event));
  const archived = events.findLast(event => ["archived", "archived_test_only"].includes(event.type) && currentCode(event));
  const assignment = meta.assignments?.developer;
  const result = (stage, title, event, summary, owner) => ({ stage, title, status: event ? "completed" : "pending",
    summary, owner, at: event?.at ?? null });
  const rows = [
    result("alignment", "需求对齐", confirmed, confirmed ? `需求 v${meta.contractVersion} 已定版`
      : meta.contractHash ? "需求正在修订，待重新定版" : "待明确目标与验收标准", confirmed ? confirmed.detail.actor ?? null : meta.createdBy),
    result("design", "研发方案", approved, approved ? `方案 v${meta.planVersion} 已确认，计划修改 ${approved.meta.developmentFiles.length} 个文件`
      : planned ? `方案 v${meta.planVersion} 已生成，待审核确认` : "待生成并确认方案", approved ? approved.meta.planApprovedBy : assignment?.userId ?? null),
    result("implementation", "代码实施", implemented, implemented ? `已完成 ${implemented.detail.changes.length} 个文件的变更`
      : meta.state === "rolled_back" ? "代码已回退，待重新开发" : "待按当前方案完成开发", implemented ? implemented.meta.assignments?.developer?.userId ?? null : assignment?.userId ?? null),
  ];
  rows.push(result("validation", "研发检查", verified, verified
    ? verified.meta.verificationMode === "manual_pending" ? accepted ? "未运行自动检查，已完成人工核验" : "没有自动检查，待人工核验结果"
      : `${verified.detail.checks.length} 项相关检查通过` : "待完成当前版本的研发检查", verified ? verified.meta.assignments?.developer?.userId ?? null : assignment?.userId ?? null));
  const modes = { manual: "人工核对研发交付", local: "本地验证", deployed: "测试环境验证" };
  rows.push(result("acceptance", "人工验收", accepted, accepted ? `已按${modes[accepted.meta.acceptanceMode]}确认验收`
    : meta.acceptanceFeedback && ["open", "discussing", "awaiting_acceptance"].includes(meta.acceptanceFeedback.status)
      ? "验收反馈待处理或再次确认" : "待人工确认业务结果", accepted ? accepted.detail.actor ?? null : meta.createdBy));
  rows.push(result("delivery", "交付归档", archived, archived ? meta.state === "archived"
    ? "正式发布观察完成，交付已归档" : "研发交付已归档" : "待完成交付归档", meta.archivedBy ?? meta.observedBy ?? assignment?.userId ?? null));
  const failures = { implementation: ["implementation_failed", "implementation_inspection_failed", "implementation_interrupted", "rolled_back"],
    validation: ["verification_failed"], design: ["plan_review"] };
  for (const row of rows) {
    if (failures[row.stage]?.includes(meta.state) && (row.stage !== "design" || meta.planBlockers?.length)) {
      row.status = "blocked";
      row.summary = row.stage === "implementation" ? meta.state === "rolled_back" ? "代码已回退，待重新开发" : "开发未完成，现场已保存"
        : row.stage === "validation" ? "研发检查未通过，需处理后重检" : "方案存在待解决问题，暂不能开发";
    }
    if (meta.state === "implementing" && row.stage === "implementation") { row.status = "active"; row.summary = "正在实施当前已确认方案"; }
    if (row.stage === "validation" && row.status === "completed" && verified?.meta.verificationMode === "manual_pending" && !accepted) row.status = "pending";
  }
  return rows;
}

export function lifecycleEvents(events) {
  return events.flatMap((event, sequence) => {
    if (diagnosticTypes.has(event.type)) return [];
    const detail = event.detail;
    const outcome = detail.executionOutcome === "paused" || event.type === "execution_paused" ? "paused" : event.type.endsWith("_outcome_unknown") ? "unknown"
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

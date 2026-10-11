const state = { overview: null, detail: null, selectedId: null, filter: "all", tab: "plan", token: null,
  principal: null, actions: new Set(), busy: false, diff: null, projects: [], currentProjectId: null, detailRequest: 0,
  planDrafts: new Map(), intakeDrafts: new Map(), page: "requirements", environmentRequest: 0 };
const $ = (selector) => document.querySelector(selector);
const states = {
  intake_draft: ["待 AI 研发分析", "active", 0], assignment_pending: ["待研发接单", "review", 0],
  intake_clarifying: ["需求沟通中", "review", 0], intake_ready: ["待产品定版", "review", 0],
  intake_analyzing: ["AI 研发分析中", "active", 0],
  intake_assigned: ["待研发反馈", "active", 0], intake_feedback: ["待产品确认", "review", 0],
  contract_confirmed: ["待研发方案分析", "active", 1], role_review: ["待研发方案分析", "active", 1],
  review_passed: ["待生成方案", "active", 2],
  submitted: ["旧版待生成方案", "error", 0], plan_review: ["待审核方案", "review", 2],
  approved: ["方案已批准", "active", 2], implementing: ["实施中", "active", 3],
  implementation_failed: ["实施失败", "error", 3], implementation_inspection_failed: ["需检查变更", "error", 3],
  implementation_interrupted: ["实施已中断", "error", 3], implemented: ["待验证", "active", 3],
  verification_failed: ["验证失败", "error", 4], verified: ["待人工确认", "review", 5],
  test_deploy_submitting: ["正在提交测试部署", "active", 4],
  test_deploy_outcome_unknown: ["测试部署结果待核实", "error", 4],
  test_deploy_running: ["测试部署中", "active", 4], test_deploy_failed: ["测试部署失败", "error", 4],
  test_deployed: ["待测试验收", "review", 5], test_accepted: ["人工验收已确认", "active", 6],
  merge_verifying: ["候选验证中", "active", 5], merge_verification_failed: ["候选验证失败", "error", 5],
  merge_verified: ["候选已验证", "active", 5], release_approved: ["发布已批准", "active", 5],
  release_submitting: ["正在提交发布", "active", 5],
  release_outcome_unknown: ["发布结果待核实", "error", 5],
  release_running: ["发布中", "active", 5], release_failed: ["发布失败", "error", 5],
  released: ["待发布观察", "review", 5], archived: ["已归档", "done", 6],
  archived_test_only: ["已归档", "done", 6], rolled_back: ["已回退·待重新开始", "review", 3],
};
const eventNames = {
  execution_binding_updated: "执行规则绑定已更新，原方案保留",
  execution_continued: "已从暂停现场继续", execution_paused: "用户已暂停，现场保留",
  development_authorized: "已授权自动开发",
  development_restarted: "回退后已返回研发方案，上一轮证据保留",
  intake_draft: "需求草稿已创建", development_feedback: "研发反馈已提交", contract_confirmed: "产品已确认需求契约",
  contract_revised: "产品已修订需求契约", role_review_blocked: "角色评审发现分歧",
  intake_message: "产品补充或修订需求", intake_analysis_started: "AI 研发开始分析",
  intake_analysis_completed: "AI 研发反馈已归档", intake_analysis_failed: "AI 研发分析失败",
  member_assigned: "产品已分配成员", assignment_accepted: "成员已接单", assignment_declined: "成员拒绝接单",
  development_team_assigned: "产品已指定研发分工", plan_part_approved: "研发已确认负责部分和共同接口",
  role_review_submitted: "角色理解已提交", role_review_passed: "角色评审已通过",
  submitted: "需求已提交", plan_created: "方案已生成", plan_attempt_failed: "方案生成失败",
  plan_analysis_started: "开始研发方案分析", plan_draft_completed: "方案草案已形成",
  plan_correction_started: "AI 内部修正方案", plan_correction_completed: "局部修正完成",
  plan_correction_failed: "内部修正失败", plan_correction_reused: "复用已完成的局部修正",
  plan_findings_resolved: "研发已逐项处理专项意见",
  plan_context_prepared: "方案上下文已归档，按需读取详细材料",
  execution_boundary_stopped: "执行边界停止，待负责人处理",
  plan_specialist_completed: "方案专项检查完成", plan_specialist_failed: "方案专项检查失败",
  plan_revision_requested: "请求修订方案", plan_approved: "方案已批准", changes_approved: "实际变更已审核", workspace_prepared: "开始代码实施",
  implemented: "代码修改完成", implementation_failed: "实施失败", implementation_interrupted: "实施中断",
  implementation_inspection_failed: "变更检查失败", verified: "代码检查已完成", verification_failed: "检查失败",
  development_paused: "执行已暂停，现场已保存", implementation_resumed: "从保存的现场继续执行",
  revision_published: "需求分支已发布", test_deployed: "测试环境就绪", test_deploy_running: "测试部署中",
  local_validation_requested: "研发获取本地验证代码", local_validation_changes_retained: "本地修改前证据已保留",
  local_validation_blocked: "本地验证等待环境配置", local_validation_failed: "本地服务启动失败，代码现场保留",
  git_commit_authorized: "研发授权代码提交", git_committed: "需求代码已提交",
  git_candidate_prepared: "已形成测试合并候选", git_candidate_verified: "测试合并候选已验证",
  git_test_branch_published: "测试分支已推送", git_delivery_failed: "Git 交付暂停，待研发处理",
  test_redeployment_authorized: "研发确认重新发布测试环境",
  test_deploy_submitting: "测试部署已提交", test_deploy_outcome_unknown: "测试部署结果待核实",
  test_deploy_poll_failed: "测试部署查询失败",
  test_deployment_reconciled: "测试部署结果已人工核实",
  test_deploy_failed: "测试部署失败", test_accepted: "人工验收确认", merge_candidate_prepared: "开始候选版本验证",
  merge_verified: "候选验证通过", merge_verification_failed: "候选验证失败", release_approved: "发布已批准",
  release_running: "发布中", released: "发布完成", release_failed: "发布失败", archived: "已归档",
  release_submitting: "发布已提交", release_outcome_unknown: "发布结果待核实",
  release_poll_failed: "发布查询失败",
  release_reconciled: "发布结果已人工核实",
  archived_test_only: "研发交付归档", workspace_rolled_back: "工作区已回退", rollback_rejected: "回退被拒绝",
  stale_lock_cleared: "过期锁已清除",
  pi_budget_exhausted: "模型预算耗尽，流程已停止", fast_path_attempt_failed: "自动流程未能推进", fast_path_scope_failed: "变更超出批准范围",
  credential_added: "账号已创建", credential_revoked: "账号凭据已撤销", credentials_reprovisioned: "账号凭据已重新配置",
  user_roles_updated: "角色权限已变更", password_reset: "密码已重置", password_changed: "用户已修改密码",
};
const actionRoles = {
  "dev-feedback": "developer", "finalize-review": "developer", "revise-plan": "developer",
  "discuss-plan": "developer", "edit-plan": "developer",
  "local-validation": "developer", "recheck-local": "developer", "publish-test": "developer",
  "redeploy-test": "developer",
  "approve-plan": "developer", "approve-changes": "developer", rollback: "developer", "restart-development": "developer", "archive-test-only": "developer",
  "run-review": "developer", plan: "developer", develop: "developer", "fast-track": "developer",
  implement: "developer", verify: "developer",
  "inspect-interrupted": "developer", "recover-lock": "developer", "record-published": "developer",
  "deploy-test": "developer", "poll-deploy": "developer", "verify-candidate": "developer",
  release: "developer", "poll-release": "developer", "accept-test": "developer",
  "approve-release": "developer", "observe-release": "developer",
  "reconcile-test-deploy": "developer", "reconcile-release": "developer",
};

function canUseAction(meta, action, role) {
  if (action === "configure-environment") return state.overview.project.canConfigureEnvironment === true;
  if (action.startsWith("review-plan-")) return state.actions.has("review-plan")
    && meta.assignments?.[action.slice("review-plan-".length)]?.userId === state.principal?.id
    && meta.assignments[action.slice("review-plan-".length)].status === "accepted";
  if (!state.actions.has(action === "edit-intake-candidate" ? "intake-message" : action)) return false;
  if (action === "accept-test" && meta.state === "verified" && meta.changeApproval?.afterHash !== meta.afterHash)
    return meta.assignments?.developer?.userId === state.principal?.id && meta.assignments.developer.status === "accepted";
  if (action === "accept-test" && meta.createdBy === state.principal?.id) return true;
  if (["assign-member", "assign-team", "confirm-contract", "revise-contract", "intake-message", "analyze-intake", "edit-intake-candidate"].includes(action)) {
    return meta.createdBy === state.principal?.id;
  }
  if (action === "accept-assignment" || action === "decline-assignment") {
    return meta.assignments?.[role]?.userId === state.principal?.id && meta.assignments[role].status === "pending";
  }
  if (["review-plan", "discuss-plan", "edit-plan", "revise-plan"].includes(action)) {
    return Object.values(meta.assignments ?? {}).some(row => row.userId === state.principal?.id && row.status === "accepted");
  }
  const assignedRole = actionRoles[action];
  return !assignedRole || (meta.assignments?.[assignedRole]?.userId === state.principal?.id
    && meta.assignments[assignedRole].status === "accepted");
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function clear(node) { node.replaceChildren(); return node; }
function statusInfo(name) { if (!states[name]) throw new Error(`未知流程状态：${name}`); return states[name]; }
function dateText(value) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function toast(message, error = false) {
  const node = $("#toast"); node.textContent = message; node.className = error ? "toast error" : "toast"; node.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 5000);
}

async function api(url, options) {
  const init = options || {};
  const { onProgress, ...request } = init;
  if (onProgress) request.headers = { ...request.headers, Accept: "text/event-stream" };
  const response = await fetch(url, request);
  if (response.ok && response.headers.get("content-type")?.startsWith("text/event-stream")) {
    return readActionStream(response, onProgress);
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `请求失败：${response.status}`);
    error.status = response.status;
    if (response.status === 401 && !init._skip401) showLogin();
    throw error;
  }
  return data;
}

async function readActionStream(response, onProgress) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", completed = false, result, lastProgress;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 256 * 1024) throw new Error("进度消息超过允许大小，请刷新查看任务状态。");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const lines = buffer.slice(0, boundary).split("\n"); buffer = buffer.slice(boundary + 2);
        const type = lines.find(line => line.startsWith("event: "))?.slice(7);
        if (!type) {
          const elapsed = lines.find(line => line.startsWith(": elapsed "));
          if (elapsed) {
            const elapsedMs = Number(elapsed.slice(10));
            if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || !lastProgress) throw new Error("任务耗时消息无效。");
            onProgress?.({ ...lastProgress, elapsedMs, elapsedOnly: true });
          }
          continue;
        }
        const data = JSON.parse(lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n"));
        if (type === "progress") { lastProgress = data; onProgress?.(data); }
        else if (type === "error") throw new Error(data.error);
        else if (type === "result") { completed = true; result = data; }
        else throw new Error("收到未知的任务进度消息。");
      }
      if (done) break;
    }
    if (!completed) throw new Error("进度连接已中断，任务可能仍在执行。请刷新查看状态，勿重复提交。");
    return result;
  } finally { reader.releaseLock(); }
}

async function refresh(preferredId = state.selectedId) {
  const previousId = state.detail?.meta.id;
  state.overview = await api("/api/overview");
  const { project, tasks, total, counts } = state.overview;
  const productView = state.principal.roles.includes("product") && !state.principal.roles.some((role) => ["developer", "admin"].includes(role));
  $("#projectCrumb").textContent = project.name;
  $("#projectName").textContent = project.name;
  $("#projectPath").textContent = productView ? "基于现有系统提出需求、对齐理解并确认验收结果" : project.root;
  $("#projectPath").title = productView ? "" : project.root;
  $("#projectRefButton").hidden = productView;
  $("#modelSettingsButton").hidden = !state.principal.roles.includes("admin");
  $("#executionNotice").hidden = project.executionReady !== false;
  $("#executionNotice").textContent = project.executionReady === false
    ? "未连接固定测试环境。研发检查通过后可人工确认归档；需要环境验证时再配置本地环境或连接测试发布工具。" : "";
  $("#projectMode").textContent = project.mode.toUpperCase();
  $("#metricReview").textContent = counts.review;
  $("#metricActive").textContent = counts.active + counts.error;
  $("#metricDone").textContent = counts.done;
  $("#metricTotal").textContent = total;
  $("#navReview").textContent = counts.review;
  $("#navTotal").textContent = total;
  state.selectedId = tasks.some((task) => task.id === preferredId) ? preferredId
    : (tasks.find((task) => statusInfo(task.state)[1] === "review") || tasks[0])?.id || null;
  renderList();
  if (state.selectedId) await loadDetail(state.selectedId, state.selectedId === previousId);
  else clear($("#detailPanel")).append(element("div", "empty-state", "暂无需求。产品负责人可以新建第一条需求。"));
  if (state.page === "environment") await openEnvironmentPage();
}

function matchesFilter(task) {
  const tone = task.executionPaused ? "review" : statusInfo(task.state)[1];
  if (state.filter === "all") return true;
  if (state.filter === "active") return tone === "active" || tone === "error";
  return tone === state.filter;
}

function renderList() {
  const query = $("#searchInput").value.trim().toLowerCase();
  const tasks = state.overview.tasks.filter((task) => matchesFilter(task)
    && `${task.id} ${task.title}`.toLowerCase().includes(query));
  $("#listCount").textContent = `${tasks.length} 项 · 已加载 ${state.overview.tasks.length}/${state.overview.total}`;
  $("#loadMoreButton").hidden = state.overview.tasks.length >= state.overview.total;
  document.querySelectorAll("[data-filter]").forEach((node) => node.classList.toggle("active", node.dataset.filter === state.filter));
  document.querySelectorAll("[data-nav]").forEach((node) => node.classList.toggle("active", node.dataset.nav === state.filter));
  const list = clear($("#taskList"));
  if (!tasks.length) return list.append(element("div", "task-list-empty", "没有符合条件的需求"));
  for (const task of tasks) {
    const [label, tone] = task.executionPaused ? ["已暂停", "review"] : statusInfo(task.state);
    const button = element("button", `task-item${state.selectedId === task.id ? " selected" : ""}`);
    button.type = "button"; button.setAttribute("role", "listitem"); button.dataset.id = task.id;
    const top = element("div", "task-item-top");
    top.append(element("span", "task-id", task.id), element("span", `status-chip ${tone}`, label));
    button.append(top, element("strong", "task-title", task.title));
    const bottom = element("div", "task-item-bottom");
    const isArchived = ["archived", "archived_test_only"].includes(task.state);
    if (isArchived) {
      const archiveLabel = task.state === "archived" ? "已归档" : "研发交付归档";
      const archiveMeta = task.archivedBy ? `${archiveLabel} · ${task.archivedBy}` : archiveLabel;
      bottom.append(element("span", "task-archive-label", archiveMeta));
      if (task.changeCount != null) bottom.append(element("span", "task-change-count", `${task.changeCount} 文件变更`));
      if (task.archivedAt) bottom.append(element("time", "", dateText(task.archivedAt)));
    } else {
      bottom.append(element("span", "", "项目需求"), element("time", "", dateText(task.updatedAt)));
    }
    button.append(bottom); list.append(button);
  }
}

function nextStep(meta) {
  if (meta.executionBoundary?.length) {
    return ["自动执行已停止", "已达到承接或执行预算边界，请研发负责人查看流程记录并处理具体原因。", "error", []];
  }
  switch (meta.state) {
    case "intake_draft": return ["开始需求沟通", "AI 研发根据现有项目和图片提出分析、建议及必要问题。", "active", [["analyze-intake", "让 AI 研发分析", "primary"]]];
    case "intake_clarifying": return ["与 AI 研发对齐需求", "在下方补充说明或图片，AI 会核对最新决定；原始需求和每轮沟通都会保留。", "review", [["analyze-intake", "继续 / 重试分析", "secondary"]]];
    case "intake_ready": return ["理解已对齐，等待产品定版", "核对下方需求共识；可继续修改并让 AI 核对，定版后再下发研发。", "review", [["confirm-contract", "查看并定版", "primary"], ["edit-intake-candidate", "修改候选需求", "secondary"]]];
    case "intake_analyzing": return ["AI 研发正在分析", "只读查看项目并理解文字与图片，不会改代码。分析结果会自动归档。", "active", []];
    case "assignment_pending": {
      const pending = Object.entries(meta.assignments ?? {}).find(([, row]) => row.userId === state.principal?.id && row.status === "pending");
      return ["等待研发成员接单", "前后端分工成员分别接单；同一人的交付职责随接单一起确认。接单完成后生成同一份技术方案。", "review",
        [...(pending ? [["accept-assignment", meta.contractVersion ? "接单并准备方案" : "接受需求", "primary", pending[0]], ["decline-assignment", "暂不接受", "secondary", pending[0]]] : []), ["assign-team", "调整研发分工", "secondary"]]];
    }
    case "intake_assigned": return ["等待研发反馈", "研发对照现有系统提出建议和必要问题，再由产品确认契约。", "active", [["dev-feedback", "提交研发反馈", "primary"]]];
    case "intake_feedback": return ["等待产品确认", "逐项回答研发问题，确认目标、范围和验收条件。", "review", [["confirm-contract", "确认需求契约", "primary"]]];
    case "contract_confirmed": case "role_review": case "review_passed": {
      if (!meta.assignments?.developer || meta.assignments.developer.status === "declined") {
        return ["需求已定版，待下发研发", "选择全栈负责或前后端分工；接单后分析同一版最终需求。", "review", [["assign-team", "指定研发成员", "primary"], ["revise-contract", "修订需求", "secondary"]]];
      }
      if (meta.assignments.developer.status !== "accepted") return ["等待研发接单", "研发接单后才能分析方案。", "review", []];
      if (meta.planHash && meta.planFeedbackVersion === meta.planVersion) {
        const retry = state.overview.project.admission.budgetMode === "adaptive" || meta.planAttempts < state.overview.project.admission.maxPlanAttempts;
        return ["方案更新未完成", "原方案、沟通和修改意见均已保留。可以按已保存意见直接重试，也可在下方继续沟通；新版完成后再审核。", "error",
          retry ? [["revise-plan", "按已保存意见重试更新", "primary"], ["edit-plan", "调整修改提案", "secondary"]] : []];
      }
      const latestPlanning = meta === state.detail?.meta ? state.detail.events?.find(event =>
        ["plan_attempt_failed", "plan_analysis_started", "plan_created", "contract_confirmed", "contract_revised"].includes(event.type)) : null;
      if (latestPlanning?.type === "plan_analysis_started") return ["正在生成研发方案",
        "方案分析和专项评审正在进行，完成后会保存结果。请勿重复提交；重新加载页面后仍可查看本轮状态。", "active", []];
      if (latestPlanning?.type === "plan_attempt_failed") {
        const retry = state.overview.project.admission.budgetMode === "adaptive" || meta.planAttempts < state.overview.project.admission.maxPlanAttempts;
        const diagnostic = state.principal.roles.some(role => ["developer", "admin"].includes(role))
          ? `失败原因：${latestPlanning.error}` : "请研发负责人查看流程记录中的失败原因并处理。";
        return ["研发方案生成失败", `本次分析已停止，尚未生成可审核的方案。${diagnostic}`, "error",
          [...(retry ? [["plan", "重试生成研发方案", "primary"]] : []), ["revise-contract", "修订需求", "secondary"]]];
      }
      return ["等待 Agent 设计方案", "Agent 根据产品确认的需求设计方案，研发确认后开始开发。高复杂度任务交由研发主导设计。", "active",
         [["plan", "生成研发方案", "primary"], ["assign-team", "调整研发分工", "secondary"], ["revise-contract", "修订需求", "secondary"]]];
    }
    case "submitted": return ["旧版任务待迁移", "此任务没有新的需求契约，不能继续生成方案。", "error", []];
    case "plan_review": {
      if (meta.admission.status === "out_of_scope") return ["需要研发主导设计", "请依据下方原因，由研发人员借助其他工具完成设计和必要协调；方案收敛后再提交独立需求。不会自动拆单绕过边界。", "error", [["revise-contract", "修订需求", "secondary"]]];
      const latestDiscussion = state.detail?.planDiscussion?.messages.filter(message => message.planVersion === meta.planVersion
        && ["plan_message", "plan_reply", "plan_discussion_failed"].includes(message.type)).at(-1);
      const canApplyDiscussion = meta.planBlockers.length && !meta.planResolutionHash && latestDiscussion?.reply
        && ["keep", "revise"].includes(latestDiscussion.reply.recommendation) && !latestDiscussion.reply.pendingQuestions.length
        && (latestDiscussion.reply.decisions ?? []).every(decision => !decision.humanRequired);
      const revision = state.overview.project.admission.budgetMode === "adaptive" || meta.planAttempts < state.overview.project.admission.maxPlanAttempts
        ? [["edit-plan", "修改方案", "secondary"], ["revise-plan", canApplyDiscussion ? "核对沟通结论并更新方案" : "更新研发方案", canApplyDiscussion ? "primary" : "secondary"]] : [];
      if (meta.planBlockers.length && !meta.planResolutionHash) return ["方案仍有技术问题待修正",
        `当前未通过的检查：${meta.planBlockers.join("；")}。没有待回答问题不代表方案已通过；沟通后仍需核对并更新方案，再由研发确认。`, "error", [...revision, ["revise-contract", "修订需求", "secondary"]]];
      const teamReview = state.detail?.planReview;
      const ownParts = teamReview?.parts.filter(part => part.userId === state.principal?.id && part.accepted && !part.approved) ?? [];
      const reviews = ownParts.map(part => [`review-plan-${part.role}`, `确认${part.role === "frontend" ? "前端" : "后端"}设计及共同接口`, "primary"]);
      if (teamReview?.mode === "split" && !teamReview.ready) return ["等待前后端确认方案", "分别查看负责部分及共同接口；交付负责人将在审核完成后启动开发。可对话提意见或直接修改方案。", "review", [...reviews, ...revision]];
      return meta.planBlockers.length && !meta.planResolutionHash
      ? ["方案存在待解决问题", revision.length ? "请查看阻断原因并填写修改意见；解决后才能批准。" : "分析次数已用尽，请研发负责人接手；需求调整不会重置累计预算。", "error", [...revision, ["revise-contract", "修订需求", "secondary"]]]
      : [teamReview?.mode === "split" ? "分工审核完成，等待交付负责人启动开发" : "等待研发确认方案",
        state.overview.project.checksConfigured === false
          ? "方案已包含相关检查与可选启动方式，确认后开始开发；检查通过后可人工确认归档。"
          : "确认后由 Pi 开发并运行相关测试；通过后人工确认即可归档，本地验证与测试发布可选。",
        "review", [["approve-plan", "确认方案并开发", "primary"], ...revision, ["revise-contract", "修订需求", "secondary"]]];
    }
    case "approved": return ["方案已确认", "继续开发和自动检查，通过后由研发选择人工验证方式。", "active", [["develop", "继续开发与测试", "primary"]]];
    case "implemented": return ["代码修改完成", "继续运行相关检查，通过后人工确认即可归档；环境验证可选。", "active", [["develop", "继续测试", "primary"]]];
    case "implementation_failed": return ["开发已暂停，现场已保存",
      `${meta.developmentPause?.reason ?? meta.developmentFailure?.message ?? state.detail?.events?.findLast(event => event.type === "implementation_failed")?.error ?? "本轮执行未完成。"} 可以查看已有修改，再从现场继续。`, "error",
      [...(meta.developmentFailure?.retryable === false ? [] : [["develop", "从现场继续开发", "primary"]]), ["rollback", "回退工作区", "danger"]]];
    case "implementation_inspection_failed": return ["变更检查未完成", "先检查实施留下的文件，再决定是否回退。", "error", [["inspect-interrupted", "检查变更", "primary"]]];
    case "implementing": return ["实施仍在进行", "如果执行进程已经停止，请先恢复任务锁，再检查变更。", "active", [["inspect-interrupted", "检查中断", "secondary"]]];
    case "implementation_interrupted": return ["实施已中断", "检查变更清单后可恢复到实施前文件快照。", "error", [["rollback", "回退工作区", "danger"]]];
    case "verification_failed": return ["测试未通过，修改已保留",
      meta.developmentPause?.reason ?? meta.developmentFailure?.message ?? "让 AI 根据真实测试结果定位并修复，再运行检查。", "error",
      [["develop", "继续修复并测试", "primary"], ...(state.overview.project.mode === "git" ? [["recheck-local", "检查本地修改", "secondary"]] : []), ["rollback", "回退工作区", "danger"]]];
    case "verified": {
      const configured = state.overview.project.executionReady !== false;
      const blocked = meta.localValidation?.status === "blocked" && state.overview.project.localEnvironment?.status === "blocked";
      const git = state.overview.project.mode === "git";
      const publish = git ? ["publish-test", state.overview.project.gitDelivery?.testMode === "merge"
        ? "合并并发布测试环境" : "发布需求分支到测试环境", "secondary"] : ["deploy-test", "发布到测试环境", "secondary"];
      return [meta.verificationMode === "manual_pending" ? "代码已就绪，待人工确认" : "研发检查通过，待人工确认", meta.gitDeliveryError ||
        (meta.verificationMode === "manual_pending" ? "本轮没有合适的自动检查，请核对需求、代码差异并记录实际人工检查结论。" : "核对需求、代码差异及相关测试结果，人工确认后即可归档。")
        + " 本地验证和测试环境发布均为可选步骤，不配置环境也可归档。"
        + (blocked ? " 本地启动缺少环境条件，重试前请先补齐配置。" : ""), "review",
        [["accept-test", "人工确认并归档", "primary"],
           ["local-validation", meta.localValidation?.status === "running" ? "查看本地环境" : blocked ? "重试本地验证（可选）" : "启动本地验证（可选）", "secondary"], ...(configured ? [publish] : []),
           ["recheck-local", "重新检查本地修改", "secondary"],
           ...(!configured && state.overview.project.canConfigureEnvironment ? [["configure-environment", "配置测试环境", "secondary"]] : [])]];
    }
    case "test_deploy_running": return ["测试部署进行中", "查询已提交的部署任务并保留执行记录。", "active", [["poll-deploy", "查询部署结果", "primary"]]];
    case "test_deploy_submitting": case "test_deploy_outcome_unknown":
      return ["测试部署结果待核实", "先检查部署平台与日志，再由测试人员通过 CLI 记录实际结果；不要重复部署。", "error", []];
    case "test_deployed": return meta.testEnvironmentSupersededBy
      ? ["共享测试环境已用于其他需求", "当前链接不能用于本需求验收；研发可重新发布已验证代码。", "review", [["redeploy-test", "重新发布测试环境", "primary"]]]
      : ["等待人工验证", "按需求终版在测试环境验证业务结果，确认后记录验收与归档。", "review", [["accept-test", "确认验证结果", "primary"], ["rollback", "恢复需求工作目录", "secondary"]]];
    case "test_accepted": return ["人工验收已确认", "核对验收记录后归档研发交付。", "review", [["archive-test-only", "归档需求", "primary"]]];
    case "merge_verifying": return ["候选版本验证中", "正在候选版本上运行检查，完成后刷新查看结果。", "active", []];
    case "merge_verified": return ["候选版本已验证", "可归档此次测试交付。", "done", [["archive-test-only", "归档需求", "primary"]]];
    case "release_approved": return ["发布已批准", "发布前会再次校验候选版本哈希。", "active", [["release", "执行发布", "primary"]]];
    case "release_running": return ["发布进行中", "查询部署作业结果。", "active", [["poll-release", "查询发布结果", "primary"]]];
    case "release_submitting": case "release_outcome_unknown":
      return ["发布结果待核实", "先核对生产环境实际版本，再由发布审批人通过 CLI 记录结果；不要重试发布。", "error", []];
    case "released": return ["等待发布观察", "确认上线后关键功能和健康状态，留下观察结论。", "review", [["observe-release", "记录观察并归档", "primary"]]];
    case "archived": case "archived_test_only": return ["交付已归档", "方案、变更、验证与人工确认均保留在项目归档中。", "done", []];
    case "rolled_back": return ["代码已回退，可以重新开始", "已恢复到实施前的文件状态。返回研发方案后，沿用已确认需求与研发分工，生成并确认新方案再开发；上一轮代码差异、审批和用量记录保留。", "review", [["restart-development", "返回研发方案", "primary"]]];
    case "test_deploy_failed": case "merge_verification_failed": case "release_failed":
      return ["流程已停止", "请查看验证或部署记录，处理根因后再继续。", "error", []];
    default: throw new Error(`未定义的下一步：${meta.state}`);
  }
}

async function loadDetail(id, preserveTab = false) {
  const request = ++state.detailRequest;
  const projectId = state.currentProjectId;
  const detail = await api(`/api/tasks/${encodeURIComponent(id)}`);
  if (request !== state.detailRequest || projectId !== state.currentProjectId || !state.principal) return;
  state.detail = detail;
  state.selectedId = id;
  if (!preserveTab) {
    state.tab = state.detail.meta.planVersion > 0 ? "plan" : "alignment";
    state.diff = null;
  }
  renderList();
  renderDetail();
  if (detail.execution) pollExecution();
}

let executionPoll = null;
function pollExecution() {
  if (executionPoll) return;
  executionPoll = setInterval(async () => {
    const id = state.selectedId, projectId = state.currentProjectId;
    if (!id || !state.principal) { clearInterval(executionPoll); executionPoll = null; return; }
    try {
      const status = await api(`/api/tasks/${encodeURIComponent(id)}/execution`);
      if (id !== state.selectedId || projectId !== state.currentProjectId) return;
      state.detail.execution = status.execution;
      if (!status.execution) {
        clearInterval(executionPoll); executionPoll = null;
        if (!state.busy) await refresh(id);
      } else renderDetail();
    } catch (error) {
      clearInterval(executionPoll); executionPoll = null; toast(`执行状态读取失败：${error.message}`, true);
    }
  }, 2000);
}

function captureReadingPosition() {
  if (typeof window === "undefined") return null;
  const panel = $("#detailPanel"), content = panel.querySelector(".detail-content");
  if (!content || panel.dataset.view !== `${state.currentProjectId}/${state.selectedId}/${state.tab}`) return null;
  const active = document.activeElement;
  return { y: window.scrollY, top: content.scrollTop,
    bottom: content.scrollHeight - content.clientHeight - content.scrollTop < 32,
    open: [...content.querySelectorAll("details")].map(node => node.open),
    focusId: panel.contains(active) ? active.id : null,
    selection: active?.selectionStart == null ? null : [active.selectionStart, active.selectionEnd] };
}

function restoreReadingPosition(position) {
  if (!position) return;
  const content = $("#detailPanel .detail-content");
  content.querySelectorAll("details").forEach((node, index) => { if (position.open[index]) node.open = true; });
  const focus = position.focusId ? document.getElementById(position.focusId) : null;
  if (focus) { focus.focus({ preventScroll: true }); if (position.selection) focus.setSelectionRange(...position.selection); }
  content.scrollTop = position.bottom ? content.scrollHeight : position.top;
  window.scrollTo({ top: position.y, behavior: "instant" });
}

function renderDetail() {
  const reading = captureReadingPosition();
  const { meta } = state.detail;
  const productView = state.principal.roles.includes("product") && !state.principal.roles.some((role) => ["developer", "admin"].includes(role));
  const paused = meta.executionPause && state.detail.events[0]?.type === "execution_paused";
  const [label, tone, stateStage] = paused ? ["已暂停", "review", statusInfo(meta.state)[2]] : statusInfo(meta.state);
  const isArchived = ["archived", "archived_test_only"].includes(meta.state);
  const stageIndex = meta.state === "assignment_pending" && meta.contractVersion ? 1 : stateStage >= 2 ? stateStage - 1 : stateStage;
  const panel = clear($("#detailPanel"));
  panel.dataset.view = `${state.currentProjectId}/${state.selectedId}/${state.tab}`;
  const top = element("div", "detail-topline");
  top.append(element("span", "detail-id", meta.id), element("span", "detail-timestamp", `更新于 ${dateText(meta.updatedAt || meta.createdAt)}`));
  panel.append(top, element("h2", "detail-title", meta.title));
  const subline = element("div", "detail-subline");
  subline.append(element("span", `status-chip ${tone}`, label), element("span", "divider"));
  if (!productView) subline.append(element("span", "", `方案 v${meta.planVersion}`));
  if (!productView && meta.projectBaselineHash) subline.append(element("span", "divider"),
    element("span", "", `项目基线 ${meta.projectBaselineHash.slice(0, 8)}`));
  if (meta.planApprovedBy) subline.append(element("span", "divider"), element("span", "", `方案责任人 ${meta.planApprovedBy}`));
  if (meta.changeApproval) subline.append(element("span", "divider"), element("span", "", `变更责任人 ${meta.changeApproval.actor}`));
  panel.append(subline);

  const track = element("div", "stage-track");
  ["需求对齐", "研发方案", "代码实施", "研发检查", "人工验收", "交付归档"].forEach((title, index) => {
    const complete = isArchived || index < stageIndex;
    const stage = element("div", `stage ${complete ? "complete" : index === stageIndex ? "current" : ""}`);
    stage.append(element("span", "stage-dot", complete ? "✓" : String(index + 1)), element("span", "", title));
    track.append(stage);
  });
  panel.append(track);

  let [attentionTitle, description, attentionTone, actions] = nextStep(meta);
  const execution = state.detail.execution;
  if (execution) {
    attentionTitle = execution.status === "pausing" ? "正在停止并保存现场" : "任务正在执行";
    description = `${execution.progress?.message || "正在准备本轮任务"} · 已用 ${Math.round(execution.elapsedMs / 1000)} 秒`;
    attentionTone = "active"; actions = [];
  } else if (meta.executionPause && state.detail.events[0]?.type === "execution_paused") {
    attentionTitle = "执行已暂停，现场已保存";
    description = "已有代码、已完成阶段和审计记录均保留。继续会核对当前现场，未完成的模型回复需重新生成。";
    attentionTone = "review";
    actions = [["continue-execution", "继续执行", "primary"], ...actions.filter(([name]) => name === "rollback")];
  }
  if (state.busy && state.runningTask === meta.id && !execution) {
    attentionTitle = "AI 正在处理本轮任务";
    attentionTone = "active";
  }
  const attention = element("div", `attention-card ${attentionTone}`);
  attention.append(element("span", "attention-icon", attentionTone === "error" ? "!" : attentionTone === "done" ? "✓" : "◇"));
  const copy = element("div", "attention-copy");
  const visibleDescription = !execution && !meta.executionPause && productView && stageIndex >= 1 && meta.state !== "test_deployed" && meta.assignments?.developer?.status === "accepted" && !isArchived
    ? `需求已定版，当前由研发负责人 ${meta.assignments.developer.userId} 推进。可在流程记录中查看进展和各阶段的责任人。`
    : description;
  copy.append(element("strong", "", attentionTitle), element("p", "", visibleDescription));
  if (state.busy && state.runningTask === meta.id) {
    copy.append(element("p", "plain-copy", "正在执行，阶段记录会自动更新。请勿重复提交。"));
  }
  if ((execution || (state.busy && state.runningTask === meta.id)) && state.actions.has("pause-execution")) {
    const pause = element("button", "button danger", execution?.status === "pausing" ? "正在暂停…" : "暂停执行");
    pause.type = "button"; pause.dataset.action = "pause-execution";
    pause.disabled = execution?.status === "pausing";
    copy.append(pause);
  }
  if (actions.length) {
    const row = element("div", "attention-actions");
    for (const [name, actionLabel, style, role] of actions) {
      if (!canUseAction(meta, name, role)) continue;
      const button = element("button", `button ${style === "secondary" ? "" : style}`, actionLabel);
      button.type = "button"; button.dataset.action = name; if (role) button.dataset.role = role; button.disabled = state.busy;
      row.append(button);
    }
    if (row.childElementCount) copy.append(row);
  }
  attention.append(copy); panel.append(attention);
  const environment = element("div", "environment-summary");
  const report = state.overview.project.localEnvironment;
  environment.append(element("strong", "", "项目环境"), element("span", "", `本地：${report ? environmentStatusText(report.status) : "待检查"} · 测试发布：${state.overview.project.executionReady ? "已配置" : "未配置"}`));
  if (report?.status === "blocked") renderEnvironmentItems(environment, report);
  const configure = element("button", "button small", state.overview.project.canConfigureEnvironment ? "配置 / 检查环境" : "查看环境状态");
  configure.type = "button"; configure.addEventListener("click", () => openEnvironmentPage().catch(error => toast(error.message, true)));
  environment.append(configure); panel.append(environment);
  if (meta.state === "test_deployed" && meta.testDeployment?.url) {
    const link = element("a", "button primary", "打开测试环境");
    link.href = meta.testDeployment.url; link.target = "_blank"; link.rel = "noopener";
    panel.append(link);
  } else if (meta.state === "test_deployed") {
    panel.append(element("p", "plain-copy", "部署命令已完成，尚未配置可访问地址。请管理员在项目运行配置中补充测试环境地址，再核实部署结果。"));
  } else if (meta.state === "verified" && meta.localValidation?.environment?.url) {
    const link = element("a", "button", "打开本地测试地址");
    link.href = meta.localValidation.environment.url; link.target = "_blank"; link.rel = "noopener";
    panel.append(link);
  }
  if (isArchived) {
    const strip = element("div", "archive-summary");
    const archivedBy = meta.state === "archived" ? (meta.observedBy ?? "未知") : (meta.archivedBy ?? "未知");
    const archivedAt = meta.state === "archived" ? meta.observedAt : meta.updatedAt;
    const archiveType = meta.state === "archived" ? "生产归档" : "研发交付归档";
    strip.append(element("span", "archive-chip", archiveType));
    strip.append(element("span", "", `归档人：${archivedBy}`));
    if (archivedAt) strip.append(element("span", "", `归档时间：${dateText(archivedAt)}`));
    if (meta.changeCount != null) strip.append(element("span", "", `变更文件：${meta.changeCount}`));
    if (meta.planVersion) strip.append(element("span", "", `方案版本：v${meta.planVersion}`));
    panel.append(strip);
  }
  const members = element("div", "assignment-strip");
  members.append(element("strong", "", "参与成员"));
  for (const [role, assignment] of Object.entries(meta.assignments ?? {})) {
    const status = { pending: "待接单", accepted: "已接单", declined: "已拒绝" }[assignment.status] || assignment.status;
    const label = { developer: meta.developmentTeam?.mode === "split" ? "交付负责人" : "研发负责人", frontend: "前端", backend: "后端" }[role];
    const part = state.detail.planReview?.parts.find(item => item.role === role);
    members.append(element("span", "assignment-chip", `${label} · ${assignment.userId} · ${status}${part ? part.approved ? " · 已确认方案" : " · 待确认方案" : ""}`));
    if (assignment.userId === state.principal?.id && assignment.status === "pending"
        && canUseAction(meta, "accept-assignment", role)) {
      const button = element("button", "button", `接受${label}分配`);
      button.type = "button"; button.dataset.action = "accept-assignment"; button.dataset.role = role; members.append(button);
    }
  }
  if (canUseAction(meta, "assign-team") && ["intake_draft", "assignment_pending", "contract_confirmed"].includes(meta.state)) {
    const button = element("button", "button", "设置研发分工");
    button.type = "button"; button.dataset.action = "assign-team"; members.append(button);
  }
  panel.append(members);
  const tabs = element("div", "detail-tabs");
  const allTabs = [["alignment", "需求对齐"], ["plan", "研发方案"],
    ["changes", "代码变更"], ["checks", "验证记录"], ["audit", "流程记录"], ["request", "原始需求"]];
  const tabList = productView ? allTabs.filter(([key]) => ["alignment", "audit", "request"].includes(key)) : allTabs;
  if (isArchived && !productView) tabList.push(["result", "归档报告"]);
  if (!tabList.some(([key]) => key === state.tab)) state.tab = "alignment";
  for (const [key, title] of tabList) {
    const button = element("button", `detail-tab${state.tab === key ? " active" : ""}`, title);
    button.type = "button"; button.dataset.tab = key;
    tabs.append(button);
  }
  panel.append(tabs);
  const content = element("div", "detail-content");
  content.addEventListener("scroll", () => {
    // A queued event from a replaced pane must not remove the new pane's indicator.
    if (panel.querySelector(".detail-content") === content && content.scrollHeight - content.clientHeight - content.scrollTop < 32) {
      panel.querySelector(".new-content-button")?.remove();
    }
  });
  panel.append(content);
  renderTab(content);
  panel.dataset.view = `${state.currentProjectId}/${state.selectedId}/${state.tab}`;
  renderProgress();
  restoreReadingPosition(reading);
  if (reading && !reading.bottom && state.newResult === state.selectedId) showNewContent(content);
}

function renderProgress() {
  const progress = state.progress;
  if (!progress || progress.taskId !== state.selectedId || progress.projectId !== state.currentProjectId) return;
  const content = $("#detailPanel").querySelector(".detail-content");
  if (!content) return;
  let card = content.querySelector(".generation-progress");
  const elapsed = progress.elapsedMs === undefined ? "" : `本轮已用 ${Math.floor(progress.elapsedMs / 1000)} 秒`;
  if (card && progress.elapsedOnly) { card.querySelector(".progress-elapsed").textContent = elapsed; return; }
  const pageY = window.scrollY;
  const banner = $("#detailPanel").querySelector(".attention-copy > p");
  if (banner) banner.textContent = progress.message;
  const bottom = content.scrollHeight - content.clientHeight - content.scrollTop < 32;
  if (!card) {
    card = element("section", "generation-progress");
    card.append(element("strong", "progress-title"), element("span", "progress-elapsed"), element("p", "progress-status"), element("div", "progress-preview"));
    card.querySelector(".progress-status").setAttribute("role", "status");
    card.querySelector(".progress-status").setAttribute("aria-live", "polite");
    content.append(card);
  }
  card.querySelector(".progress-title").textContent = state.busy ? "AI 正在处理本轮任务" : "本轮执行结果";
  card.querySelector(".progress-elapsed").textContent = elapsed;
  card.querySelector(".progress-status").textContent = progress.message;
  card.querySelector(".progress-preview").textContent = progress.preview;
  if (bottom) content.scrollTop = content.scrollHeight;
  else showNewContent(content);
  window.scrollTo({ top: pageY, behavior: "instant" });
}

function showNewContent(content) {
  if ($("#detailPanel").querySelector(".new-content-button")) return;
  const button = element("button", "button new-content-button", "有新内容，查看最新 ↓");
  button.type = "button";
  button.addEventListener("click", () => { content.scrollTop = content.scrollHeight; state.newResult = null; button.remove(); });
  $("#detailPanel").append(button);
}

function receiveProgress(taskId, projectId, update) {
  if (!state.principal || state.currentProjectId !== projectId || state.selectedId !== taskId) return;
  state.progress = { taskId, projectId, ...update };
  renderProgress();
}

function appendInline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const raw = match[0];
    const node = element(raw.startsWith("**") ? "strong" : "code", "", raw.startsWith("**") ? raw.slice(2, -2) : raw.slice(1, -1));
    parent.append(node); cursor = match.index + raw.length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function renderPlan(container, markdown, questionReplies = null, compact = false, answerableQuestions = null) {
  if (!markdown) return container.append(element("p", "info-empty", "方案尚未生成。"));
  let section;
  let list;
  let code;
  let diagram = false;
  let pendingSection = false;
  const detailSections = new Set(["接口与前后端约定", "修改位置与关键逻辑", "拟改位置与做法",
    ...[...markdown.matchAll(/^## (.+)\n\s*```mermaid/gm)].map(match => match[1])]);
  for (const line of markdown.split("\n")) {
    if (section && line.startsWith("```")) {
      if (code) {
        if (diagram) renderPlanDiagram(code);
        code = null; diagram = false;
      } else { diagram = line.trim() === "```mermaid"; code = element("pre", diagram ? "plan-diagram" : "plan-code"); section.append(code); }
      continue;
    }
    if (code) { code.textContent += `${line}\n`; continue; }
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim(); pendingSection = title === "待确认";
      const folded = compact && detailSections.has(title);
      section = element(folded ? "details" : "section", folded ? "plan-section plan-detail" : "plan-section");
      section.append(element(folded ? "summary" : "h3", "", folded ? `${title} · 展开查看`
        : pendingSection && answerableQuestions?.length === 0 ? "待处理问题" : title));
      container.append(section); list = null; continue;
    }
    if (!section) continue;
    if (line.startsWith("### ")) { section.append(element("h4", "", line.slice(4).trim())); list = null; continue; }
    if (line.startsWith("- ")) {
      if (!list) { list = element("ul", ""); section.append(list); }
      const question = line.slice(2);
      const item = element("li", ""); appendInline(item, question);
      if (questionReplies && pendingSection && (answerableQuestions === null || answerableQuestions.includes(question))) {
        item.className = "intake-question plan-question";
        const input = formField(item, "你的处理意见", "textarea", "说明你的判断、建议改法或需要 AI 核实的内容。");
        input.required = false; input.rows = 2; input.maxLength = 4000; input.disabled = state.busy;
        const { meta } = state.detail;
        input.setAttribute("form", `plan-reply-${meta.id}`);
        const draftKey = `${state.principal.id}/${state.currentProjectId}/${meta.id}/${meta.planHash}/finding/${encodeURIComponent(question)}`;
        input.value = state.planDrafts.get(draftKey) ?? "";
        input.addEventListener("input", () => state.planDrafts.set(draftKey, input.value));
        questionReplies.push({ question, input, draftKey });
      }
      list.append(item); continue;
    }
    list = null;
    if (line.trim()) { const paragraph = element("p", ""); appendInline(paragraph, line); section.append(paragraph); }
  }
}

let diagramSequence = 0;
function renderPlanDiagram(node) {
  const source = node.textContent;
  Promise.resolve().then(async () => {
    if (!globalThis.mermaid) throw new Error("流程图组件未加载，请刷新页面。");
    if (/%%\{|^---|\bclick\s|<script/i.test(source)) throw new Error("流程图包含不支持的执行或配置指令。");
    globalThis.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      flowchart: { htmlLabels: false }, maxTextSize: 4000, fontFamily: "Arial, sans-serif" });
    const result = await globalThis.mermaid.render(`plan-diagram-${++diagramSequence}`, source);
    node.innerHTML = result.svg;
  }).catch(error => {
    node.className = "plan-diagram diagram-error";
    node.textContent = `流程图未能显示：${error.message}\n${source}`;
  });
}

function diffLines(before, after) {
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.at(-1) === "") left.pop();
  if (right.at(-1) === "") right.pop();
  if (left.length > 400 || right.length > 400) return null;
  const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lengths[i][j] = left[i] === right[j] ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      rows.push(["same", i + 1, j + 1, left[i]]); i++; j++;
    } else if (i < left.length && (j === right.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
      rows.push(["removed", i + 1, "", left[i]]); i++;
    } else { rows.push(["added", "", j + 1, right[j]]); j++; }
  }
  return rows;
}

function renderDiff(container, file) {
  const card = element("div", "diff-card");
  card.append(element("div", "diff-heading", file.file));
  if (file.beforeMode !== file.afterMode) card.append(element("p", "diff-mode", `权限 ${file.beforeMode ?? "无"} → ${file.afterMode ?? "无"}`));
  if (file.before?.reason || file.after?.reason) {
    card.append(element("p", "info-empty", file.before?.reason || file.after.reason));
  } else if (file.patch !== null && file.patch !== undefined) {
    card.append(element("p", "info-empty", "仅展示修改及相邻上下文；完整快照保留在需求归档中。"));
    const code = element("div", "diff-lines");
    for (const line of file.patch.split("\n")) {
      const kind = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "same";
      const row = element("div", `diff-line unified ${kind}`);
      row.append(element("span", "diff-code", line));
      code.append(row);
    }
    card.append(code);
  } else {
    const rows = diffLines(file.before?.text ?? "", file.after?.text ?? "");
    if (!rows) card.append(element("p", "info-empty", "文件较长，已省略逐行对比；可在需求归档中查看完整快照。"));
    else {
      const code = element("div", "diff-lines");
      for (const [kind, oldLine, newLine, content] of rows) {
        const row = element("div", `diff-line ${kind}`);
        row.append(element("span", "diff-number", String(oldLine)), element("span", "diff-number", String(newLine)),
          element("span", "diff-sign", kind === "added" ? "+" : kind === "removed" ? "−" : " ") , element("span", "diff-code", content));
        code.append(row);
      }
      card.append(code);
    }
  }
  container.append(card);
}

function renderTab(container) {
  clear(container);
  const { meta, changes, baselineChecks, events, request, feedback, contract, reviews, plan } = state.detail;
  if (state.tab === "alignment") {
    if (state.detail.discussion) {
      renderIntakeDiscussion(container);
      return;
    }
    container.append(element("h3", "content-heading", "产品原始需求"), element("div", "plain-copy", request));
    if (feedback) {
      container.append(element("h3", "content-heading", "研发反馈"), element("p", "plain-copy", feedback.summary));
      for (const question of feedback.questions) {
        const answer = contract?.answers?.[question.id];
        container.append(element("div", "alignment-row", `问题 ${question.id} · ${question.text}`),
          element("p", "plain-copy", answer ? `产品答复：${answer}` : "等待产品答复"));
      }
    }
    if (contract) {
      container.append(element("h3", "content-heading", `产品已确认契约 v${meta.contractVersion}`));
      for (const [label, value] of [["目标", contract.objective], ["现状", contract.currentBehavior], ["目标行为", contract.desiredBehavior]]) {
        container.append(element("div", "alignment-row", `${label} · ${value}`));
      }
      container.append(element("h3", "content-heading", "验收条件"));
      for (const item of contract.acceptance) container.append(element("div", "alignment-row", `${item.id} · ${item.text}`));
    }
    return;
  }
  if (state.tab === "plan") {
    const analysis = state.detail.planAnalysis;
    const questionReplies = [];
    const canReply = (meta.state === "plan_review" || (meta.state === "contract_confirmed" && meta.planHash
      && meta.planFeedbackVersion === meta.planVersion)) && canUseAction(meta, "discuss-plan");
    if (analysis?.draft.schemaVersion === 1) container.append(element("p", "plain-copy", "这是此前生成的方案版本，仍可查看。需要完整设计说明时，可通过“按沟通意见重新设计”生成新版；原方案和审核记录保留。"));
    if (analysis) {
      if (!analysis.resolution && analysis.specialists.some(row => row.findings.findings.some(finding => finding.severity === "blocking"))
          && !analysis.draft.openQuestions.length && analysis.admission.status === "needs_clarification"
          && !["product_confirmation", "human_led"].includes(analysis.draft.candidateReview?.status)
          && meta.state === "plan_review" && canUseAction(meta, "revise-plan")
          && (state.overview.project.admission.budgetMode === "adaptive"
            || meta.planAttempts < state.overview.project.admission.maxPlanAttempts)) {
        const update = element("button", "button primary", "让 AI 按检查意见修正方案"); update.type = "button"; update.disabled = state.busy;
        const projectId = state.currentProjectId; const taskId = meta.id; const planHash = meta.planHash;
        update.addEventListener("click", async () => {
          if (state.currentProjectId !== projectId || state.selectedId !== taskId || state.detail.meta.planHash !== planHash)
            return toast("需求或方案已切换，请查看最新方案后操作。", true);
          await sendAction("revise-plan", { expectedPlanHash: planHash,
            feedback: "读取 read_plan 的 specialists、相关设计及 discussion 原文，按专项检查意见修正技术矛盾。保留已冻结验收和已确认的研发决定，普通技术细节核实源码后自行选择最简单安全实现，不增加问答轮次。评审意见也需客观核实，不盲从。若确实缺少必须人工决定的业务取舍或数据授权，合并问题并给出推荐及依据；不得代答。仅更新待审核方案，不批准或开发。" });
        });
        container.append(element("p", "intake-caption", "这些检查意见已有修正建议，无需逐项重复填写。AI 会核实并更新方案；必须人工决定的事项仍会单独提出。"), update);
      }
      if (analysis.internalCorrection) container.append(element("p", "intake-caption", analysis.blockers.length
        ? "AI 已完成一次内部修正和复核，以下是仍未解决的问题。可修改方案或说明具体意见，不必逐项回复技术检查记录。"
        : "AI 已完成局部修正和复核。请审核这份方案，确认后开始开发。"));
      renderPlan(container, plan, canReply ? questionReplies : null, true, analysis.draft.openQuestions);
      const decision = analysis.admission;
      if (analysis.draft.candidateReview) {
        const reviewed = analysis.draft.candidateReview;
        container.append(element("strong", "content-heading", { accepted: "研发提案已核对并保留", adjusted: "AI 建议调整研发提案",
          product_confirmation: "提案涉及业务变化，需产品确认", human_led: "提案需要人工主导设计" }[reviewed.status]));
        for (const reason of reviewed.reasons) container.append(element("p", "plain-copy", reason));
      }
      const boundary = element("div", "change-summary");
      boundary.append(element("strong", "content-heading", decision.label), element("span", "", `负责人 ${meta.assignments.developer.userId} · ${decision.scope.modules.length} 个业务模块 · ${decision.scope.deliveryUnits.length} 个交付单元`));
      const changed = [["existingBehavior", "历史功能"], ["interfaces", "接口"], ["data", "数据"]]
        .filter(([kind]) => analysis.draft.impacts[kind].status === "changed").map(([, title]) => title);
      if (changed.length) container.append(element("p", "plain-copy", `审核关注：${changed.join("、")}变更及对应验证、恢复方式。`));
      for (const warning of decision.warnings ?? []) container.append(element("p", "plain-copy", warning));
      const evidence = element("details", "audit-diagnostics");
      evidence.append(element("summary", "", "影响依据与专项建议"));
      evidence.append(boundary, element("p", "plain-copy", `拟改 ${analysis.draft.affectedFiles.length} 个文件 · ${analysis.specialists.length ? `已完成 ${analysis.specialists.map((row) => ({ all: "前后端与测试" })[row.role]).join("、")} 专项检查` : "单次方案分析"} · 验收场景待执行`));
      for (const unit of analysis.draft.boundaries.modules) evidence.append(element("p", "plain-copy", `业务模块 ${unit.name} · ${unit.evidence}`));
      for (const [key, title] of [["coordination", "协调"], ["verification", "验证依据"], ["recovery", "恢复依据"], ["externalEffects", "外部影响"]]) evidence.append(element("p", "plain-copy", `${title} · ${analysis.draft.boundaries[key].evidence}`));
      const policy = analysis.admissionPolicy;
      evidence.append(element("p", "plain-copy", `规划参考：${policy.maxFiles} 个文件 / ${policy.maxBusinessModules} 个业务模块 / ${policy.maxDeliveryUnits} 个交付单元 / 预计 ${policy.maxEstimatedChangedLines} 行差异。分析已用 ${meta.planAttempts}/${policy.maxPlanAttempts} 轮；变更文件总体积参考值 ${policy.maxChangedBytes} 字节。改动量不单独决定复杂度，分阶段设计及跨团队协调仍需人工主导。`));
      for (const [kind, title] of [["existingBehavior", "历史功能"], ["interfaces", "接口"], ["data", "数据"]]) {
        const impact = analysis.draft.impacts[kind];
        evidence.append(element("p", "plain-copy", `${title} · ${{ none: "无变更", changed: "涉及变更，须负责人审核", unknown: "影响未明确" }[impact.status]} · ${impact.evidence}`));
      }
      for (const row of analysis.specialists) for (const finding of row.findings.findings) {
        evidence.append(element("p", "plain-copy", `${row.role.toUpperCase()} · ${finding.subject} · ${finding.evidence} · ${finding.recommendation}`));
      }
      if (analysis.resolution) {
        evidence.append(element("h3", "content-heading", `研发处理意见 · ${analysis.resolution.actor}`));
        for (const item of analysis.resolution.items) evidence.append(element("p", "plain-copy",
          `${item.disposition === "false_positive" ? "核实为误报" : "已澄清"} · ${item.reason} · ${item.sources.map(source => `${source.file}:${source.startLine}-${source.endLine}`).join("、")}`));
        evidence.append(element("p", "plain-copy", analysis.resolution.implementationGuidance));
      }
      for (const item of analysis.draft.verification) evidence.append(element("p", "plain-copy", `待执行 ${item.acceptanceId} · ${item.scenario} · 回归：${item.regression}`));
      container.append(evidence);
    }
    if (!analysis) renderPlan(container, plan, canReply ? questionReplies : null, true);
    renderPlanDiscussion(container, questionReplies);
    return;
  }
  if (state.tab === "request") return container.append(element("div", "plain-copy", request));
  if (state.tab === "result") {
    const { result } = state.detail;
    if (!result) return container.append(element("p", "info-empty", "归档报告尚未生成。"));
    return container.append(element("pre", "archive-result", result));
  }
  if (state.tab === "changes") {
    if (!changes) return container.append(element("p", "info-empty", "实施完成后，这里会显示变更文件。"));
    const rows = changes.changes;
    const head = element("div", "change-summary");
    head.append(element("strong", "content-heading", `变更文件 ${rows.length} 个`), element("span", "", changes.violations.length ? "存在超范围变更" : "范围检查通过"));
    container.append(head);
    const additions = rows.filter(row => !meta.developmentFiles.includes(row.file));
    if (additions.length) container.append(element("p", "plain-copy",
      `实施中补充的文件，需核对与验收目标的关系：${additions.map(row => row.file).join("、")}`));
    if (meta.changeApproval) container.append(element("p", "plain-copy",
      `审核人 ${meta.changeApproval.actor} · ${meta.changeApproval.evidence}`));
    for (const row of rows) {
      const type = !row.before ? "added" : !row.after ? "deleted" : "modified";
      const item = element("button", `change-row${state.diff?.file === row.file ? " selected" : ""}`);
      item.type = "button"; item.dataset.file = row.file;
      item.append(element("span", `change-type ${type}`, type === "added" ? "+" : type === "deleted" ? "−" : "~"), element("span", "change-path", row.file));
      container.append(item);
    }
    if (state.diff) renderDiff(container, state.diff);
    return;
  }
  if (state.tab === "checks") {
    const groups = [["修改前基线", baselineChecks], ["实施后检查", meta.checks], ["候选版本检查", meta.mergeChecks]];
    let hasEvidence = false;
    for (const [title, rows] of groups) {
      if (!rows?.length) continue;
      hasEvidence = true; container.append(element("h3", "content-heading", title));
      for (const row of rows) {
        const item = element("div", "check-row");
        item.append(element("span", "check-mark", row.code === 0 ? "✓" : "!"));
        const copy = element("div", "");
        copy.append(element("strong", "", row.command.join(" ")), element("small", "", `退出码 ${row.code} · ${row.durationMs} ms`));
        item.append(copy); container.append(item);
      }
    }
    if (meta.testDeployment) { hasEvidence = true; container.append(element("h3", "content-heading", "测试部署"), element("p", "plain-copy", JSON.stringify(meta.testDeployment, null, 2))); }
    if (meta.productionDeployment) { hasEvidence = true; container.append(element("h3", "content-heading", "生产发布"), element("p", "plain-copy", JSON.stringify(meta.productionDeployment, null, 2))); }
    if (!hasEvidence) container.append(element("p", "info-empty", "暂无验证记录。"));
    return;
  }
  if (state.tab === "audit") {
    container.append(element("h3", "content-heading", "需求生命周期"),
      element("p", "plain-copy", "回看需求定版、方案审核、实际变更审核、验收和发布决定，查看各阶段责任人。完整需求沟通在“需求对齐”中保留。"));
    const button = element("button", "button primary", "查看完整生命周期"); button.type = "button";
    button.addEventListener("click", () => openLifecycle(meta.id).catch((error) => toast(error.message, true)));
    container.append(button);
    if (state.principal.roles.some(role => ["developer", "admin"].includes(role))) for (const event of state.detail.events.filter(row => row.timing).slice(0, 6)) {
      const timing = event.timing;
      const record = element("details", "audit-event-detail");
      record.append(element("summary", "", `${dateText(event.at)} · ${eventNames[event.type] ?? event.type} · ${Math.round(timing.durationMs / 1000)} 秒`));
      record.append(element("p", "plain-copy", `模型 ${timing.model} · 工具调用 ${timing.toolCalls} 次`));
      if (timing.timeouts) record.append(element("p", "plain-copy", `单次模型请求时限 ${timing.timeouts.requestMs / 1000} 秒`));
      if (timing.tokens) record.append(element("p", "plain-copy", `已计量 Token：输入 ${timing.tokens.input ?? "未知"} · 输出 ${timing.tokens.output ?? "未知"}`
        + ` · 缓存读取 ${timing.tokens.cacheRead ?? "未知"} · 缓存写入 ${timing.tokens.cacheWrite ?? "未知"}`
        + (timing.unmeasuredRequests > 0 ? `；另有 ${timing.unmeasuredRequests} 次请求未返回完整计量，最终用量未知。` : "")));
      if (timing.handoff) record.append(element("p", "plain-copy", `方案交接正文 ${(timing.handoff.inlineBytes / 1000).toFixed(1)} KB`
        + ` · 完整结构化方案 ${(timing.handoff.fullPlanBytes / 1000).toFixed(1)} KB · 省略章节可按版本读取`));
      if (timing.requestTimings) for (const request of timing.requestTimings) {
        record.append(element("p", "plain-copy", `第 ${request.request} 次模型请求：${(request.durationMs / 1000).toFixed(1)} 秒`
          + ` · 首个响应 ${request.firstResponseMs === null ? "未收到" : `${(request.firstResponseMs / 1000).toFixed(1)} 秒`}`
          + ` · 正文开始 ${request.firstTextMs === null ? "未收到" : `${(request.firstTextMs / 1000).toFixed(1)} 秒`}`
          + ` · ${{ completed: "本轮输出完成", failed: "请求失败", timed_out: "超时终止", interrupted: "中断", running: "进行中" }[request.status]}`));
      }
      else record.append(element("p", "plain-copy", "这条历史记录只有总耗时，未记录逐轮请求时间。"));
      if (event.error) record.append(element("p", "error-copy", event.error));
      container.append(record);
    }
  }
}

function renderIntakeImages(container, attachments, taskId) {
  const list = element("div", "intake-image-list");
  for (const image of attachments) {
    const figure = element("div", "intake-image");
    const link = element("a", "intake-image");
    link.href = `/api/tasks/${encodeURIComponent(taskId)}/images/${image.id}`;
    link.target = "_blank"; link.rel = "noopener";
    const img = element("img", ""); img.src = link.href; img.alt = image.name; img.loading = "lazy";
    link.append(img, element("span", "", image.name)); figure.append(link);
    if (state.detail.discussion.withdrawnImageIds.includes(image.id)) figure.append(element("small", "", "已撤回引用 · 原图仍归档"));
    else if (["intake_draft", "intake_clarifying", "intake_ready"].includes(state.detail.meta.state)
        && canUseAction(state.detail.meta, "intake-message")) {
      const withdraw = element("button", "button", "撤回引用"); withdraw.type = "button";
      withdraw.addEventListener("click", () => runIntakeAnalysis(taskId, { text: `撤回图片“${image.name}”，后续分析不再使用此图。`,
        withdrawnImageIds: [image.id] }).catch((error) => toast(error.message, true)));
      figure.append(withdraw);
    }
    list.append(figure);
  }
  if (attachments.length) container.append(list);
}

function renderPlanDiscussion(container, questionReplies = []) {
  const { meta, planDiscussion } = state.detail;
  if (!meta.planHash) return;
  container.append(element("h3", "content-heading", "与 AI 沟通方案"),
    element("p", "intake-caption", "可以询问改法、指出问题或提出替代方案。AI 会核对需求和源码；讨论不会直接批准方案或开始开发。"));
  const timeline = element("div", "intake-thread");
  const messages = planDiscussion?.messages ?? [];
  const currentMessages = messages.filter(message => message.planVersion === meta.planVersion);
  const pendingRevision = meta.state === "contract_confirmed" && meta.planFeedbackVersion === meta.planVersion;
  const canReply = (meta.state === "plan_review" || pendingRevision) && canUseAction(meta, "discuss-plan");
  const latestDiscussion = currentMessages.findLast(message => ["plan_message", "plan_reply", "plan_discussion_failed"].includes(message.type));
  const older = element("details", "intake-older");
  const olderCount = messages.length - Math.min(6, currentMessages.length);
  if (olderCount) { older.append(element("summary", "", `旧版与较早沟通（${olderCount} 条）`)); timeline.append(older); }
  for (const [index, message] of messages.entries()) {
    const ai = message.type !== "plan_message";
    const card = element("article", `intake-turn ${ai ? "ai" : "product"}`);
    card.append(element("div", "intake-turn-header", `${ai ? "AI" : message.actor} · 方案 v${message.planVersion} · ${dateText(message.at)}`));
    if (message.type === "plan_revision_requested") card.append(element("p", "plain-copy", "方案修改意见已留存并进入重新核对。"));
    else if (["plan_discussion_failed", "plan_attempt_failed"].includes(message.type)) {
      card.append(element("p", "error-copy", message.type === "plan_attempt_failed"
        ? "方案生成未完成。已保存的修改意见可以直接重试，原方案尚未被替换。"
        : "本轮方案核对未完成。你的回复已保存，当前方案保持不变。"));
      const diagnostic = element("details", "audit-diagnostics");
      diagnostic.append(element("summary", "", "查看错误详情"), element("p", "error-copy", message.text));
      card.append(diagnostic);
    } else card.append(element("p", "plain-copy", message.text));
    if (message.candidate) {
      const proposal = element("details", "intake-older"); proposal.append(element("summary", "", "研发提交的修改提案"));
      renderPlan(proposal, message.candidate.markdown); card.append(proposal);
    }
    if (message.reply) {
      const label = { keep: "原方案可保留", revise: "建议修订方案", product_confirmation: "涉及业务变化，需产品确认", human_led: "建议研发主导设计" }[message.reply.recommendation];
      card.append(element("strong", "", label));
      for (const reason of message.reply.reasons) card.append(element("p", "plain-copy", reason));
      for (const decision of message.reply.decisions ?? []) {
        const row = element("section", "plan-decision");
        row.append(element("strong", "", `${decision.humanRequired ? "需人工决定" : "AI 推荐"} · ${decision.issue}`),
          element("p", "plain-copy", decision.proposal));
        const basis = element("details", "audit-diagnostics");
        basis.append(element("summary", "", "查看理由与依据"), element("p", "plain-copy", decision.basis));
        row.append(basis); card.append(row);
      }
      for (const [questionIndex, question] of message.reply.pendingQuestions.entries()) {
        const row = element("div", "intake-question"); row.append(element("p", "", question));
        if (canReply && message === latestDiscussion) {
          const input = formField(row, "你的回复", "textarea", "说明你的判断；需要 AI 进一步核实也可以直接提出。");
          input.required = false; input.rows = 2; input.maxLength = 4000; input.disabled = state.busy;
          input.setAttribute("form", `plan-reply-${meta.id}`);
          const draftKey = `${state.principal.id}/${state.currentProjectId}/${meta.id}/${meta.planHash}/${message.eventHash}/${questionIndex}`;
          input.value = state.planDrafts.get(draftKey) ?? "";
          input.addEventListener("input", () => state.planDrafts.set(draftKey, input.value));
          questionReplies.push({ question, input, draftKey });
        }
        card.append(row);
      }
      if (canReply && !pendingRevision && message === latestDiscussion
          && (message.reply.recommendation === "revise" || (message.reply.recommendation === "keep"
            && meta.planBlockers?.length && !meta.planResolutionHash)) && !message.reply.pendingQuestions.length
          && (message.reply.decisions ?? []).every(decision => !decision.humanRequired)
          && canUseAction(meta, "revise-plan") && (state.overview.project.admission.budgetMode === "adaptive"
            || meta.planAttempts < state.overview.project.admission.maxPlanAttempts)) {
        const update = element("button", "button primary", message.reply.recommendation === "keep"
          ? "核对沟通结论并更新方案" : "按 AI 建议更新方案"); update.type = "button"; update.disabled = state.busy;
        const projectId = state.currentProjectId; const taskId = meta.id; const planHash = meta.planHash;
        update.addEventListener("click", async () => {
          if (state.currentProjectId !== projectId || state.selectedId !== taskId || state.detail.meta.planHash !== planHash)
            return toast("需求或方案已切换，请查看最新方案后操作。", true);
          await sendAction("revise-plan", { expectedPlanHash: planHash, feedback: "依据已归档的研发沟通更新方案。用 read_plan 的 discussion、specialists、impacts 和 boundaries 核实完整决定与当前阻断；AI建议也需客观核实，不把无待回答问题当成通过。保留冻结需求和合理的研发选择，技术问题给出最简单可验证修正，不重复已回答的问题。代码回滚不能恢复数据库，必要恢复步骤写入设计而非新增用户撤销功能。仅生成待审核版本，不批准或开发。" });
        });
        card.append(element("p", "intake-caption", meta.planBlockers?.length && !meta.planResolutionHash
          ? "无需继续填写回复，但当前方案仍有技术问题。点击后 AI 会核实沟通结论并修正方案，通过后再由研发确认。"
          : "没有必须人工决定的问题，可以直接更新为待审核方案。"), update);
      }
    }
    (message.planVersion !== meta.planVersion || currentMessages.indexOf(message) < currentMessages.length - 6 ? older : timeline).append(card);
  }
  container.append(timeline);
  if (!canReply) return;
  if (pendingRevision && canUseAction(meta, "revise-plan") && !meta.executionBoundary?.length
      && (state.overview.project.admission.budgetMode === "adaptive"
        || meta.planAttempts < state.overview.project.admission.maxPlanAttempts)) {
    const retry = element("button", "button primary", "按已保存意见重试更新"); retry.type = "button"; retry.disabled = state.busy;
    const projectId = state.currentProjectId; const taskId = meta.id; const planHash = meta.planHash;
    retry.addEventListener("click", async () => {
      if (state.currentProjectId !== projectId || state.selectedId !== taskId || state.detail.meta.planHash !== planHash)
        return toast("需求或方案已切换，请查看最新方案后操作。", true);
      await sendAction("revise-plan", { retry: true, expectedPlanHash: planHash });
    });
    container.append(element("p", "intake-caption", "修改意见已保存，无需重复填写。重试会结合后续沟通生成新版，完成后仍需研发审核。"), retry);
  }
  const form = element("form", "intake-composer");
  form.id = `plan-reply-${meta.id}`;
  if (questionReplies.length) form.append(element("p", "intake-caption", "可逐项填写处理意见，也可先回复部分问题。提交后 AI 会统一核对；方案确认仍由研发决定。"));
  const input = formField(form, questionReplies.length ? "其他补充（可选）" : "向 AI 提问或说明建议", "textarea", "例如：这个改法会影响旧订单吗？能否复用现有校验？");
  input.required = false; input.maxLength = 4000; input.disabled = state.busy;
  const draftKey = `${state.principal.id}/${state.currentProjectId}/${meta.id}/${meta.planHash}/supplement`;
  input.value = state.planDrafts.get(draftKey) ?? "";
  input.addEventListener("input", () => state.planDrafts.set(draftKey, input.value));
  const submit = element("button", "button primary", questionReplies.length ? "提交回复，让 AI 统一核对" : "发送并核对");
  submit.type = "submit"; submit.disabled = state.busy;
  const planHash = meta.planHash; const taskId = meta.id; const projectId = state.currentProjectId;
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (state.busy) return;
    if (state.currentProjectId !== projectId || state.selectedId !== taskId) return toast("需求已切换，请在当前需求中沟通。", true);
    if (state.detail.meta.planHash !== planHash) return toast("方案已更新，请查看最新方案后回复。", true);
    const replies = questionReplies.filter(row => row.input.value.trim());
    const parts = replies.map(row => `问题：${row.question}\n回复：${row.input.value.trim()}`);
    if (input.value.trim()) parts.push(`补充说明：${input.value.trim()}`);
    if (!parts.length) return toast("请至少回复一个问题或填写补充说明。", true);
    const text = parts.join("\n\n");
    if (text.length > 4000) return toast("本轮问题和回复合计超过 4000 字，请缩短回复或分次提交；填写内容已保留。", true);
    if (await sendAction("discuss-plan", { message: { text, expectedPlanHash: planHash } })) {
      for (const row of replies) state.planDrafts.delete(row.draftKey);
      state.planDrafts.delete(draftKey);
      if (state.currentProjectId === projectId && state.selectedId === taskId) renderDetail();
    }
  });
  form.append(submit); container.append(form);
}

function renderIntakeDiscussion(container) {
  const { meta, discussion, request, contract, feedback } = state.detail;
  container.append(element("h3", "content-heading", "与 AI 研发对齐需求"),
    element("p", "intake-caption", "用业务目标、使用场景和验收结果沟通。研发阶段接收最终定版需求；原文、图片和讨论保留供回看。"));
  const timeline = element("div", "intake-thread");
  const questionReplies = [];
  const canReply = ["intake_draft", "intake_clarifying", "intake_ready"].includes(meta.state)
    && canUseAction(meta, "intake-message");
  const older = element("details", "intake-older");
  if (discussion.messages.length > 6) {
    older.append(element("summary", "", `查看较早的 ${discussion.messages.length - 6} 条沟通`));
    timeline.append(older);
  }
  for (const message of discussion.messages) {
    const ai = message.type.startsWith("intake_analysis");
    const card = element("article", `intake-turn ${ai ? "ai" : "product"}`);
    card.append(element("div", "intake-turn-header", `${ai ? "AI 研发" : "产品"} · ${dateText(message.at)}`));
    if (message.type === "intake_draft") card.append(element("p", "plain-copy", request));
    if (message.type === "intake_message") card.append(element("p", "plain-copy", message.text));
    if (message.type === "intake_analysis_failed") card.append(element("p", "error-copy", state.principal.roles.includes("product")
      ? "本轮分析未完成，已提交的需求和沟通仍保留。请稍后重试或联系项目管理员。"
      : `分析未完成：${message.error}。已保存的需求和沟通不会丢失，可修正配置后重试分析。`));
    if (message.analysis) {
      card.append(element("p", "plain-copy", message.analysis.reply));
      if (message.analysis.summary) {
        const details = element("details", "intake-suggestions"); details.append(element("summary", "", "需求理解与建议"));
        details.append(element("p", "plain-copy", message.analysis.summary));
        for (const suggestion of message.analysis.suggestions) details.append(element("p", "", suggestion));
        card.append(details);
      }
      for (const question of message.analysis.questions) {
        const row = element("div", "intake-question"); row.append(element("p", "", question.text));
        if (canReply && message === discussion.messages.at(-1)) {
          const input = formField(row, "你的回复", "textarea", "说明你的选择；暂不确定也可以直接告诉 AI。");
          input.required = false; input.rows = 2;
          input.setAttribute("form", `intake-reply-${meta.id}`);
          const draftKey = `${state.principal.id}/${state.currentProjectId}/${meta.id}/${message.eventHash}/${question.id}`;
          input.value = state.intakeDrafts.get(draftKey) ?? "";
          input.addEventListener("input", () => state.intakeDrafts.set(draftKey, input.value));
          questionReplies.push({ question, input, draftKey });
        }
        card.append(row);
      }
    }
    renderIntakeImages(card, message.attachments ?? [], meta.id);
    (discussion.messages.indexOf(message) < discussion.messages.length - 6 ? older : timeline).append(card);
  }
  const frozen = contract && !["intake_clarifying", "intake_ready"].includes(meta.state);
  if (frozen) {
    renderIntakeAgreement(container, meta, discussion, contract, feedback, questionReplies);
    const history = element("details", "intake-older");
    history.append(element("summary", "", `查看完整沟通记录（${discussion.messages.length} 条）`), timeline);
    container.append(history);
  } else {
    container.append(timeline);
    renderIntakeAgreement(container, meta, discussion, contract, feedback, questionReplies);
  }
}

function renderIntakeAgreement(container, meta, discussion, contract, feedback, questionReplies = []) {
  if (feedback && !meta.aiAligned) {
    container.append(element("h3", "content-heading", "研发成员反馈"), element("p", "plain-copy", feedback.summary));
    for (const question of feedback.questions) container.append(element("p", "intake-question", question.text));
  }
  const pending = discussion.messages.findLast((row) => row.type === "intake_message")?.candidate;
  const candidate = ["intake_ready", "intake_clarifying"].includes(meta.state)
    ? meta.state === "intake_ready" ? discussion.latestAnalysis?.analysis.contract : pending : contract;
  if (candidate) {
    const card = element("section", "intake-agreement");
    card.append(element("h3", "", meta.state === "intake_ready" ? "待产品定版的需求共识"
      : meta.state === "intake_clarifying" ? "产品修订候选 · 等待 AI 核对" : `已定版需求 v${meta.contractVersion}`));
    for (const [label, value] of [["目标", candidate.objective], ["当前行为", candidate.currentBehavior], ["期望行为", candidate.desiredBehavior]]) {
      card.append(element("h4", "", label), element("p", "plain-copy", value));
    }
    card.append(element("h4", "", "验收标准"));
    const list = element("ol", ""); for (const item of candidate.acceptance) list.append(element("li", "", item.text)); card.append(list);
    const scope = element("details", ""); scope.append(element("summary", "", "本次包含与不包含的功能"));
    scope.append(element("p", "plain-copy", `本次包含：${candidate.inScope.join("；")}\n本次不包含：${candidate.outOfScope.join("；") || "无"}`));
    for (const answer of Object.values(candidate.answers)) scope.append(element("p", "plain-copy", answer));
    card.append(scope); container.append(card);
  }
  const status = element("p", "intake-status"); status.id = "intakeStatus"; status.setAttribute("aria-live", "polite"); container.append(status);
  if (["intake_draft", "intake_clarifying", "intake_ready"].includes(meta.state) && canUseAction(meta, "intake-message")) {
    const projectId = state.currentProjectId;
    const form = element("form", "intake-composer");
    form.id = `intake-reply-${meta.id}`;
    if (questionReplies.length) form.append(element("p", "intake-caption", "可逐项回复，也可先回答部分问题。点击下方按钮后，AI 会统一核对本轮回复。"));
    const text = formField(form, questionReplies.length ? "其他补充（可选）" : "补充或修订需求", "textarea", "还有其他想法或需要调整的内容，可以在这里说明。");
    text.required = false;
    const draftKey = `${state.principal.id}/${state.currentProjectId}/${meta.id}/supplement`;
    text.value = state.intakeDrafts.get(draftKey) ?? "";
    text.addEventListener("input", () => state.intakeDrafts.set(draftKey, text.value));
    const images = imageUploadField(form);
    const submit = element("button", "button primary", questionReplies.length ? "提交回复，让 AI 统一核对" : "发送并让 AI 核对");
    submit.type = "submit"; form.append(submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const replies = questionReplies.filter(row => row.input.value.trim());
        const parts = replies.map(row => `问题（${row.question.id}）：${row.question.text}\n回复：${row.input.value.trim()}`);
        if (text.value.trim()) parts.push(`补充说明：${text.value.trim()}`);
        const uploads = await imageUploads(images);
        if (state.currentProjectId !== projectId || state.selectedId !== meta.id) throw new Error("需求已切换，请回到原需求提交回复。");
        if (!parts.length && !uploads.length) throw new Error("请至少回复一个问题、填写补充说明或上传图片。");
        if (!parts.length) parts.push("请结合本轮补充图片核对需求；尚未回答的问题继续保留。");
        if (await runIntakeAnalysis(meta.id, { text: parts.join("\n\n"), images: uploads })) {
          for (const row of replies) state.intakeDrafts.delete(row.draftKey);
          state.intakeDrafts.delete(draftKey);
          if (state.currentProjectId === projectId && state.selectedId === meta.id) renderDetail();
        }
      }
      catch (error) { toast(error.message, true); }
    });
    container.append(form);
  }
}

async function sendAction(action, extra = {}, returnResult = false) {
  if (state.busy) return false;
  if (!state.actions.has(action)) { toast("当前身份没有执行此操作的权限。", true); return false; }
  const taskId = state.selectedId;
  const projectId = state.currentProjectId;
  state.runningTask = taskId;
  state.progress = null; state.newResult = null;
  state.busy = true; renderDetail();
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/actions`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
      body: JSON.stringify({ action, ...extra }),
      onProgress: update => receiveProgress(taskId, projectId, update),
    });
    state.progress = null; state.newResult = taskId;
    if (state.principal && state.currentProjectId === projectId && state.selectedId === taskId) await refresh(taskId);
    if (result?.paused) { toast("执行已暂停，现场已保存，可以稍后继续。"); return false; }
    if (result?.ok === false) { toast(`执行已暂停，现场已保存：${result.error}`, true); return false; }
    toast("操作已完成，流程记录已更新。");
    return returnResult ? result : true;
  } catch (error) {
    if (error.status === 401) showLogin();
    else if (state.principal && state.currentProjectId === projectId && state.selectedId === taskId) {
      state.progress = null; state.newResult = taskId;
      try { await refresh(taskId); }
      catch (refreshError) {
        toast(`${error.message}；最新状态读取失败：${refreshError.message}`, true);
        return false;
      }
    }
    toast(error.message, true);
    return false;
  }
  finally { state.busy = false; state.runningTask = null; state.progress = null; if (state.detail) renderDetail(); }
}

async function runIntakeAnalysis(id, message = null) {
  if (state.busy) return false;
  const projectId = state.currentProjectId;
  const productView = state.principal.roles.includes("product");
  let saved = false;
  state.busy = true;
  state.runningTask = id; state.progress = null; state.newResult = null;
  for (const control of $("#detailPanel").querySelectorAll("button, input, textarea")) control.disabled = true;
  if ($("#intakeStatus")) $("#intakeStatus").textContent = "AI 研发正在阅读项目并核对需求…";
  renderDetail();
  try {
    const post = (body) => api(`/api/tasks/${encodeURIComponent(id)}/actions`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token }, body: JSON.stringify(body),
      ...(body.action === "analyze-intake" ? { onProgress: update => receiveProgress(id, projectId, update) } : {}) });
    if (message) { await post({ action: "intake-message", message }); saved = true; }
    const result = await post({ action: "analyze-intake" });
    if (result?.paused) { toast("需求分析已暂停，补充资料仍保留。"); return saved; }
    toast("AI 研发反馈已保存，请查看问题或待定版的需求共识。");
    return true;
  } catch (error) {
    const detail = productView && (!message || saved)
      ? "本轮沟通暂时未能完成，资料仍保留。请稍后重试或联系项目管理员。" : error.message;
    toast(`${message && saved ? "补充内容已保存；" : ""}${detail}`, true);
    return saved;
  } finally {
    state.busy = false;
    state.runningTask = null; state.progress = null; state.newResult = !message || saved ? id : null;
    if (state.currentProjectId === projectId && state.selectedId === id) {
      if (!message || saved) await refresh(id);
      else {
        for (const control of $("#detailPanel").querySelectorAll("button, input, textarea")) control.disabled = false;
        if ($("#intakeStatus")) $("#intakeStatus").textContent = "内容尚未提交，请检查错误后重试。";
      }
    }
  }
}

function closeModal() { const root = $("#modalRoot"); root.hidden = true; root.replaceChildren(); }

function formField(form, labelText, tag = "input", placeholder = "") {
  const label = element("label", "form-field");
  label.append(element("span", "", labelText));
  const input = element(tag, ""); input.placeholder = placeholder; input.required = true;
  if (tag === "textarea") input.rows = 3;
  label.append(input); form.append(label);
  return input;
}

function structuredModal(title, description, build, submitAction, submitLabel = "提交确认") {
  const root = $("#modalRoot"); clear(root); root.hidden = false;
  const form = element("form", "modal-card structured-form");
  form.append(element("h2", "", title), element("p", "", description));
  const values = build(form);
  const actions = element("div", "modal-actions");
  const cancel = element("button", "button", "取消"); cancel.type = "button"; cancel.addEventListener("click", closeModal);
  const submit = element("button", "button primary", submitLabel); submit.type = "submit";
  actions.append(cancel, submit); form.append(actions); root.append(form);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true; cancel.disabled = true;
    try { if (await submitAction(values) !== false) closeModal(); }
    catch (error) { toast(error.message, true); }
    finally { submit.disabled = false; cancel.disabled = false; }
  });
  form.querySelector("input, textarea, select")?.focus();
}

async function openAssignmentForm() {
  const { meta } = state.detail; const taskId = state.selectedId; const projectId = state.currentProjectId;
  const { members } = await api("/api/members");
  if (state.selectedId !== taskId || state.currentProjectId !== projectId) return;
  if (!["intake_draft", "assignment_pending", "contract_confirmed"].includes(meta.state)) throw new Error("请在方案设计前指定研发分工。");
  structuredModal("指定研发分工", "全栈一人审核完整方案；前后端分工共同审核接口，各自审核负责部分。交付负责人由其中一人兼任，负责启动开发和选择测试、发布。账号权限均为研发。", form => {
    const mode = formField(form, "协作方式", "select");
    for (const [value, text] of [["single", "全栈 / 一名研发负责"], ["split", "前后端分别负责"]]) {
      const option = element("option", "", text); option.value = value; mode.append(option);
    }
    mode.value = meta.developmentTeam?.mode ?? "single";
    const fields = { mode };
    for (const [key, text] of [["lead", "研发负责人"], ["frontend", "前端负责人"], ["backend", "后端负责人"]]) {
      const select = formField(form, text, "select"); const empty = element("option", "", "请选择研发成员"); empty.value = ""; select.append(empty);
      for (const user of members.filter(user => user.roles.includes("developer"))) { const option = element("option", "", user.username); option.value = user.id; select.append(option); }
      select.value = meta.assignments?.[key === "lead" ? "developer" : key]?.userId ?? ""; fields[key] = select;
    }
    fields.delivery = formField(form, "交付负责人", "select");
    for (const [value, text] of [["backend", "由后端负责人兼任"], ["frontend", "由前端负责人兼任"]]) { const option = element("option", "", text); option.value = value; fields.delivery.append(option); }
    fields.delivery.value = meta.assignments?.frontend?.userId === meta.assignments?.developer?.userId && meta.developmentTeam?.mode === "split" ? "frontend" : "backend";
    const update = () => { for (const key of ["lead", "frontend", "backend", "delivery"]) { const shown = key === "lead" ? mode.value === "single" : mode.value === "split";
      fields[key].parentElement.hidden = !shown; fields[key].required = shown; } };
    mode.addEventListener("change", update); update(); return fields;
  }, fields => {
    if (state.selectedId !== taskId || state.currentProjectId !== projectId) throw new Error("需求已切换，请重新打开指派。");
    return sendAction("assign-team", { team: fields.mode.value === "single" ? { mode: "single", lead: fields.lead.value }
      : { mode: "split", lead: fields[fields.delivery.value].value, frontend: fields.frontend.value, backend: fields.backend.value } });
  }, "确认指派");
}

function openNewTask() {
  structuredModal("与 AI 研发讨论新需求", "说明你要解决的问题，可附界面截图或设计图。提交后 AI 会自动分析，与你确认理解。", (form) => {
    const id = formField(form, "需求编号", "input", "例如 1 或 REQ-123");
    id.pattern = "[A-Za-z0-9][A-Za-z0-9_\\-]{0,63}"; id.maxLength = 64;
    id.title = "1–64 位，以字母或数字开头，可包含下划线和短横线";
    form.append(element("p", "plain-copy", "编号支持 1、2 等数字，同一项目内不可重复。"));
    return { id,
      title: formField(form, "标题", "input", "一句话说明需求"),
      request: formField(form, "原始需求", "textarea", "背景、目标、期望行为与已有约束"),
      images: imageUploadField(form),
    };
  }, async ({ id, title, request, images }) => {
    const uploads = await imageUploads(images);
    const created = await api("/api/tasks", { method: "POST",
      headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
      body: JSON.stringify({ id: id.value.trim(), title: title.value.trim(), request: request.value.trim(), images: uploads }) });
    state.filter = "all"; state.tab = "alignment"; await refresh(created.id);
    closeModal();
    await runIntakeAnalysis(created.id);
  }, "提交并开始沟通");
}

function imageUploadField(form) {
  const input = formField(form, "图片（PNG/JPEG，每张 ≤ 1 MiB，每次最多 4 张）", "input");
  input.type = "file"; input.accept = "image/png,image/jpeg"; input.multiple = true; input.required = false;
  const preview = element("div", "intake-image-list"); form.append(preview);
  input.addEventListener("change", async () => {
    clear(preview);
    try {
      for (const image of await imageUploads(input)) {
        const figure = element("figure", "intake-image"); const img = element("img", "");
        img.src = `data:${image.mimeType};base64,${image.data}`; img.alt = image.name;
        figure.append(img, element("figcaption", "", image.name)); preview.append(figure);
      }
    } catch (error) { preview.append(element("p", "error-copy", error.message)); }
  });
  return input;
}

async function imageUploads(input) {
  const files = [...input.files];
  if (files.length > 4) throw new Error("每次最多上传 4 张图片。");
  return Promise.all(files.map(async (file) => {
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 1024 * 1024) throw new Error("请选择不超过 1 MiB 的 PNG/JPEG 图片。");
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error(`无法读取图片 ${file.name}`)); reader.readAsDataURL(file);
    });
    return { name: file.name, mimeType: file.type, data };
  }));
}

function auditModal(title, subtitle) {
  const root = $("#modalRoot"); clear(root); root.hidden = false;
  const card = element("div", "modal-card audit-modal");
  card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
  card.append(element("h2", "", title), element("p", "", subtitle)); root.append(card);
  return card;
}

function auditPager(card, offset, limit, total, showPage) {
  const row = element("div", "modal-actions");
  const previous = element("button", "button", "上一页"); previous.type = "button"; previous.disabled = offset === 0;
  previous.addEventListener("click", () => showPage(Math.max(0, offset - limit)));
  const position = element("span", "audit-position", `${total ? offset + 1 : 0}–${Math.min(total, offset + limit)} / ${total}`);
  const next = element("button", "button", "下一页"); next.type = "button"; next.disabled = offset + limit >= total;
  next.addEventListener("click", () => showPage(offset + limit));
  const close = element("button", "button", "关闭"); close.type = "button"; close.addEventListener("click", closeModal);
  row.append(previous, position, next, close); card.append(row);
}

const stageNames = { alignment: "需求对齐", assignment: "研发接单", review: "角色评审", design: "方案设计", implementation: "代码实施", validation: "测试验收", release: "发布观察", closed: "完成归档" };
function durationText(ms) {
  if (ms === null) return "暂无样本";
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)} 小时`;
  return `${(ms / 86400000).toFixed(1)} 天`;
}

function renderManagementSummary(card, data) {
  const grid = element("div", "audit-metrics");
  for (const [label, count] of [["进行中", data.summary.active], ["待人工处理", data.summary.waitingHuman],
    ["需处理异常", data.summary.needsAttention], ["待落实负责人", data.summary.unowned],
    ["完成归档", data.summary.completed], ["已回退", data.summary.rolledBack]]) {
    const metric = element("div", "audit-metric");
    metric.append(element("strong", "", String(count)), element("span", "", label)); grid.append(metric);
  }
  card.append(grid, element("p", "intake-caption", `完整项目口径 · 更新于 ${dateText(data.generatedAt)} · 归档周期中位数 ${durationText(data.summary.completedCycleMedianMs)}（${data.summary.completedCycleSamples} 条）`));
  const stages = element("div", "audit-stages");
  for (const [key, count] of Object.entries(data.summary.stages)) stages.append(element("span", "", `${stageNames[key]} ${count}`));
  card.append(stages);
  const workload = element("details", "audit-event-detail");
  workload.append(element("summary", "", "负责人积压与停留时间"));
  for (const owner of data.summary.owners) workload.append(element("p", "", `${owner.userId ?? "待落实负责人"} · 进行中 ${owner.active} · 待人工 ${owner.waitingHuman} · 异常 ${owner.needsAttention}`));
  for (const row of data.summary.oldestActive) workload.append(element("p", "", `${row.id} · ${statusInfo(row.state)[0]} · 当前状态已停留 ${durationText(row.stateAgeMs)} · ${row.responsible.userId ?? "待落实负责人"}`));
  const usage = data.usage;
  const quality = data.summary.firstVerification;
  const delivery = data.summary.firstDelivery;
  workload.append(element("p", "", `首次实施及验证通过率 ${delivery.rate === null ? "暂无样本" : `${(delivery.rate * 100).toFixed(1)}%`} · ${delivery.passed}/${delivery.sampleSize} 条 · ${delivery.definition}`));
  workload.append(element("p", "", `首次配置检查通过率 ${quality.rate === null ? "暂无样本" : `${(quality.rate * 100).toFixed(1)}%`} · ${quality.passed}/${quality.sampleSize} 条 · ${quality.definition}`));
  workload.append(element("p", "", `模型调用 ${usage.attempts} 次 · 已计量成本 $${usage.knownCostUsd.toFixed(4)} · 成本覆盖 ${usage.costMeasuredAttempts}/${usage.attempts}${usage.costUsd === null ? "（总成本未知）" : ""}`));
  card.append(workload);
}

async function openAdminReport(offset = 0, filters = {}) {
  const limit = 50;
  const query = new URLSearchParams({ offset, limit, ...filters });
  const data = await api(`/api/admin/report?${query}`);
  const card = auditModal("项目审计与交付总览", `全项目审计链已验证 · ${data.projectTotal} 条需求 · 点击需求回溯关键决定与责任人`);
  renderManagementSummary(card, data);
  renderAuditFilters(card, filters);
  const identity = element("button", "button", "查看身份变更历史"); identity.type = "button";
  identity.addEventListener("click", () => openAdminEvents("auth", null, 0).catch((error) => toast(error.message, true)));
  card.append(identity);
  for (const row of data.requirements) {
    const item = element("button", "audit-list-row"); item.type = "button";
    item.append(element("strong", "", `${row.id} · ${row.title}`),
      element("small", "", `${statusInfo(row.state)[0]} · 当前负责 ${row.lifecycle.responsible.userId ?? "待落实"} · 停留 ${durationText(row.lifecycle.stateAgeMs)}${row.lifecycle.needsAttention ? " · 需处理异常" : ""}`));
    item.addEventListener("click", () => openLifecycle(row.id).catch((error) => toast(error.message, true)));
    card.append(item);
  }
  if (!data.total) card.append(element("p", "info-empty", "没有符合条件的需求。"));
  auditPager(card, offset, limit, data.total, (page) => openAdminReport(page, filters).catch((error) => toast(error.message, true)));
}

function renderAuditFilters(card, filters) {
  const form = element("form", "audit-filters");
  const query = element("input", ""); query.placeholder = "需求编号或标题"; query.setAttribute("aria-label", "需求编号或标题"); query.value = filters.query ?? "";
  const owner = element("input", ""); owner.placeholder = "负责人 ID"; owner.setAttribute("aria-label", "负责人 ID"); owner.value = filters.owner ?? "";
  const select = element("select", ""); select.setAttribute("aria-label", "流程状态");
  select.append(new Option("全部状态", ""));
  for (const [key, [label]] of Object.entries(states)) select.append(new Option(label, key));
  select.value = filters.state ?? "";
  const attention = element("select", ""); attention.setAttribute("aria-label", "异常筛选");
  attention.append(new Option("全部需求", ""), new Option("仅待处理异常", "true")); attention.value = filters.attention ?? "";
  const apply = element("button", "button", "查询"); apply.type = "submit";
  form.append(query, owner, select, attention, apply);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = Object.fromEntries(Object.entries({ query: query.value.trim(), owner: owner.value.trim(), state: select.value, attention: attention.value }).filter(([, value]) => value));
    openAdminReport(0, next).catch((error) => toast(error.message, true));
  });
  card.append(form);
}

async function openLifecycle(id, offset = 0) {
  const limit = 50;
  const data = await api(`/api/tasks/${encodeURIComponent(id)}/lifecycle?offset=${offset}&limit=${limit}`);
  const card = auditModal(`${id} · 需求生命周期`, `${statusInfo(data.state)[0]} · 当前负责 ${data.status.responsible.userId ?? "待落实"} · 当前状态停留 ${durationText(data.status.stateAgeMs)}`);
  const responsible = element("div", "audit-responsibilities");
  const labels = { product: "产品负责人", planReviewer: "方案责任人", changeRiskOwner: "变更风险责任", testAcceptor: "测试验收", releaseApprover: "发布审批", releaseObserver: "发布观察" };
  for (const [key, label] of Object.entries(labels)) responsible.append(element("span", "", `${label}：${data.responsibilities[key] ?? "未发生"}`));
  responsible.append(element("span", "", `研发负责人：${data.responsibilities.developer?.userId ?? "待分配"}`));
  card.append(responsible);
  if (state.actions.has("audit-report")) {
    const actions = element("div", "audit-toolbar");
    for (const [label, action] of [["返回管理总览", () => openAdminReport()], ["原始事件与证据索引", () => openAdminEvents("task", id, 0)], ["执行诊断与模型用量", () => openDiagnostics(id)]]) {
      const button = element("button", "button", label); button.type = "button";
      button.addEventListener("click", () => action().catch((error) => toast(error.message, true))); actions.append(button);
    }
    card.append(actions);
  }
  for (const event of data.events) {
    const item = element("div", `lifecycle-event ${event.outcome}`);
    const actor = event.actor === "system:workflow" ? "流程执行器" : event.actor ?? "执行身份未记录";
    item.append(element("strong", "", event.type === "plan_approved" && event.approvalKind === "delegated"
      ? "按研发授权通过方案" : eventNames[event.type] ?? event.type),
      element("small", "", `${dateText(event.at)} · ${actor}${event.initiatedBy && event.initiatedBy !== event.actor ? ` · 发起 ${event.initiatedBy}` : ""}`),
      element("p", "", `${statusInfo(event.state)[0]} · 负责 ${event.responsible.userId ?? "待落实"}${event.contractVersion ? ` · 需求 v${event.contractVersion}` : ""}${event.planVersion ? ` · 方案 v${event.planVersion}` : ""}${event.memberId ? ` · 指定成员 ${event.memberId}` : ""}`));
    if (state.actions.has("audit-report")) {
      const evidence = element("button", "button", "查看该节点原始证据"); evidence.type = "button";
      evidence.addEventListener("click", () => openAdminEvents("task", id, event.sequence, 1).catch((error) => toast(error.message, true))); item.append(evidence);
    }
    card.append(item);
  }
  auditPager(card, offset, limit, data.total, (page) => openLifecycle(id, page).catch((error) => toast(error.message, true)));
}

async function openAdminEvents(kind, id, offset, limit = 50) {
  const endpoint = kind === "task" ? `/api/admin/tasks/${encodeURIComponent(id)}/history` : "/api/admin/auth-history";
  const data = await api(`${endpoint}?offset=${offset}&limit=${limit}`);
  const card = auditModal(kind === "task" ? `${id} · 历史提交记录` : "身份变更历史",
    `哈希链已验证 · 共 ${data.total} 条记录`);
  const back = element("button", "button", "返回项目报告"); back.type = "button";
  back.addEventListener("click", () => openAdminReport().catch((error) => toast(error.message, true)));
  card.append(back);
  for (const event of data.events) {
    const item = element("details", "audit-event-detail");
    const summary = element("summary", "", `${dateText(event.at)} · ${eventNames[event.type] || event.type}${event.detail.initiatedBy ? ` · 发起 ${event.detail.initiatedBy}` : ""}`);
    item.append(summary);
    let rendered = false;
    item.addEventListener("toggle", () => {
      if (!item.open || rendered) return;
      rendered = true;
      item.append(element("p", "plain-copy", `操作者 ${event.detail.actor ?? event.detail.initiatedBy ?? "未记录"} · 状态 ${event.meta?.state ?? "身份变更"}`));
      if (event.detail.error) item.append(element("p", "error-copy", event.detail.error));
      const evidence = element("details", "audit-diagnostics");
      evidence.append(element("summary", "", "查看原始审计元数据与哈希"));
      evidence.addEventListener("toggle", () => {
        if (evidence.open && evidence.children.length === 1) evidence.append(element("pre", "", JSON.stringify(event, null, 2)));
      });
      item.append(evidence);
    });
    card.append(item);
  }
  auditPager(card, offset, limit, data.total,
    (page) => openAdminEvents(kind, id, page, limit).catch((error) => toast(error.message, true)));
}

async function openDiagnostics(id, offset = 0) {
  const limit = 25;
  const data = await api(`/api/admin/tasks/${encodeURIComponent(id)}/observability?offset=${offset}&limit=${limit}`);
  const usage = data.summary;
  const card = auditModal(`${id} · 执行诊断`, `调用 ${usage.attempts} 次 · 失败 ${usage.failedAttempts} 次 · 已计量成本 $${usage.knownCostUsd.toFixed(4)} · 覆盖 ${usage.costMeasuredAttempts}/${usage.attempts}`);
  card.append(element("p", "", `供应商请求 ${usage.providerRequests ?? "未完整计量"} 次 · 额度切换 ${usage.quotaSwitches ?? "未完整计量"} 次${usage.costUsd === null ? " · 总成本未知，零价格记录不代表免费" : ""}`));
  const back = element("button", "button", "返回生命周期"); back.type = "button";
  back.addEventListener("click", () => openLifecycle(id).catch((error) => toast(error.message, true))); card.append(back);
  for (const failure of data.recentFailures) {
    const item = element("details", "audit-event-detail");
    item.append(element("summary", "", `${dateText(failure.at)} · ${eventNames[failure.stage] ?? failure.stage}`),
      element("p", "error-copy", failure.reason ?? "失败原因未记录")); card.append(item);
  }
  for (const run of data.runs) {
    const telemetry = run.telemetry;
    const item = element("details", "audit-event-detail");
    const status = { succeeded: "完成", failed: "失败", paused: "用户暂停", skipped: "复用或未调用" }[run.status];
    item.append(element("summary", "", `${dateText(run.eventAt)} · ${eventNames[run.eventType] ?? run.phase} · ${status}`));
    if (run.error) item.append(element("p", "error-copy", run.error));
    if (telemetry) item.append(element("p", "plain-copy", `${telemetry.provider}/${telemetry.model} · ${(telemetry.durationMs / 1000).toFixed(1)} 秒 · ${telemetry.assistantMessages} 次请求 · ${telemetry.toolCalls} 次工具调用`),
      element("p", "plain-copy", `Token：输入 ${telemetry.tokens.input ?? "未知"} · 输出 ${telemetry.tokens.output ?? "未知"} · 缓存读 ${telemetry.tokens.cacheRead ?? "未知"} · 缓存写 ${telemetry.tokens.cacheWrite ?? "未知"}`));
    let rendered = false;
    item.addEventListener("toggle", () => {
      if (!item.open || rendered) return;
      rendered = true;
      for (const request of telemetry?.requestTimings ?? []) item.append(element("p", "plain-copy",
        `请求 ${request.request} · ${(request.durationMs / 1000).toFixed(1)} 秒 · ${request.status} · ${request.usageMeasured ? "用量已计量" : "用量未知"}`));
      for (const tool of telemetry?.toolTimings ?? []) item.append(element("p", "plain-copy",
        `工具 ${tool.tool} · ${(tool.durationMs / 1000).toFixed(1)} 秒 · ${tool.status}`));
      for (const change of telemetry?.modelSwitches ?? []) item.append(element("p", "plain-copy",
        `${change.from.provider}/${change.from.model} → ${change.to.provider}/${change.to.model} · ${change.code}`));
      if (telemetry?.auditStorage) item.append(element("p", "plain-copy",
        `审计正文 ${(telemetry.auditStorage.storedBytes / 1024).toFixed(1)} KB · 已省略 ${telemetry.auditStorage.omittedEvents} 条重复或增量事件及 ${telemetry.auditStorage.omittedThinkingBlocks} 段思考正文；用量计量保留`));
      const evidence = element("details", "audit-diagnostics");
      evidence.append(element("summary", "", "查看计量与证据元数据"));
      evidence.addEventListener("toggle", () => {
        if (evidence.open && evidence.children.length === 1) evidence.append(element("pre", "", JSON.stringify(run, null, 2)));
      });
      item.append(evidence);
    });
    card.append(item);
  }
  if (!data.total) card.append(element("p", "info-empty", "暂无模型执行记录。"));
  auditPager(card, offset, limit, data.total, (page) => openDiagnostics(id, page).catch((error) => toast(error.message, true)));
}

function openFeedbackForm() {
  structuredModal("提交研发反馈", "只提出会影响实现或验收的问题；没有问题可留空。", (form) => {
    const summary = formField(form, "研发建议", "textarea", "简要说明现有行为、建议及影响");
    const questions = formField(form, "需要产品回答的问题（每行一个）", "textarea", "例如：旧接口是否需要兼容？");
    questions.required = false;
    const roles = element("fieldset", "role-choices"); roles.append(element("legend", "", "需要独立评审的角色"));
    const selected = {};
    for (const role of ["frontend", "backend", "qa"]) {
      const label = element("label", ""); const check = element("input", ""); check.type = "checkbox";
      check.checked = role === "backend" || role === "qa"; if (role === "qa") check.disabled = true;
      label.append(check, element("span", "", role.toUpperCase())); roles.append(label); selected[role] = check;
    }
    form.append(roles); return { summary, questions, selected };
  }, async ({ summary, questions, selected }) => {
    const requiredRoles = Object.entries(selected).filter(([, check]) => check.checked).map(([role]) => role);
    if (!requiredRoles.some((role) => role === "frontend" || role === "backend")) throw new Error("至少选择前端或后端角色。");
    const questionRows = questions.value.split("\n").map((line) => line.trim()).filter(Boolean);
    return sendAction("dev-feedback", { feedback: { summary: summary.value.trim(),
      questions: questionRows.map((text, index) => ({ id: `Q${index + 1}`, text })), requiredRoles } });
  });
}

function openContractForm(action = "confirm-contract") {
  if (action === "confirm-contract" && state.detail.meta.aiAligned) return openIntakeFinalization();
  const feedback = state.detail.feedback;
  if (!feedback) throw new Error("请先等待研发反馈。");
  const editing = action === "edit-intake-candidate" || (action === "revise-contract" && state.detail.meta.aiAligned);
  structuredModal(editing ? "修改候选需求" : action === "revise-contract" ? "修订需求契约" : "确认需求契约",
    editing ? "修改后先让 AI 研发核对最新决定，再由产品定版；旧版本及沟通都会保留。"
      : "按研发反馈确认目标、边界和验收口径；提交后各角色必须重新评审最新版本。", (form) => {
    const objective = formField(form, "业务目标", "textarea", "这项需求要解决什么问题？");
    const currentBehavior = formField(form, "当前行为", "textarea", "现有系统现在如何工作？");
    const desiredBehavior = formField(form, "希望达到的效果", "textarea", "完成后用户怎样操作，会看到什么结果？");
    const acceptance = formField(form, "验收条件（每行一条）", "textarea", "写出可验证的结果");
    const inScope = formField(form, "本次包含的功能（每行一条）", "textarea", "例如：按订单状态筛选；查看筛选后的订单列表。无需填写代码文件。");
    const outOfScope = formField(form, "本次不包含的事项（每行一条，可留空）", "textarea", "明确本次不处理的业务事项");
    outOfScope.required = false;
    const answers = Object.fromEntries(feedback.questions.map((question) =>
      [question.id, formField(form, `答复 ${question.id} · ${question.text}`, "textarea", "写下产品确认的决定")]));
    const prior = state.detail.discussion?.latestAnalysis?.analysis.contract ?? state.detail.contract;
    if (prior) {
      objective.value = prior.objective; currentBehavior.value = prior.currentBehavior;
      desiredBehavior.value = prior.desiredBehavior;
      acceptance.value = prior.acceptance.map((item) => item.text).join("\n");
      inScope.value = prior.inScope.join("\n"); outOfScope.value = prior.outOfScope.join("\n");
      for (const [id, input] of Object.entries(answers)) input.value = prior.answers[id] ?? "";
    }
    return { objective, currentBehavior, desiredBehavior, acceptance, inScope, outOfScope, answers,
      answerHistory: prior ? prior.answers : {} };
  }, async (fields) => {
    const lines = (input) => input.value.split("\n").map((line) => line.trim()).filter(Boolean);
    const contract = {
      objective: fields.objective.value.trim(), currentBehavior: fields.currentBehavior.value.trim(),
      desiredBehavior: fields.desiredBehavior.value.trim(),
      acceptance: lines(fields.acceptance).map((text, index) => ({ id: `AC${index + 1}`, text })),
      inScope: lines(fields.inScope), outOfScope: lines(fields.outOfScope),
      answers: { ...fields.answerHistory, ...Object.fromEntries(Object.entries(fields.answers).map(([id, input]) => [id, input.value.trim()])) },
    };
    if (action === "edit-intake-candidate" || (action === "revise-contract" && state.detail.meta.aiAligned)) return runIntakeAnalysis(state.selectedId,
      { text: "我修订了候选需求，请核对这些最新决定。", candidate: contract });
    return sendAction(action, { contract });
  }, editing ? "保存并让 AI 核对" : "确认需求");
}

function openIntakeFinalization() {
  const candidate = state.detail.discussion.latestAnalysis.analysis.contract;
  const expectedAnalysisHash = state.detail.meta.intakeAnalysisHash;
  structuredModal("产品确认需求定版", "这份需求是 AI 研发核对过的共识。确认后冻结版本，再指定研发成员接收；需要调整时先修改候选需求。", (form) => {
    for (const [label, text] of [["目标", candidate.objective], ["当前行为", candidate.currentBehavior], ["期望行为", candidate.desiredBehavior]]) {
      form.append(element("h3", "", label), element("p", "plain-copy", text));
    }
    form.append(element("h3", "", "验收标准"));
    for (const item of candidate.acceptance) form.append(element("p", "plain-copy", item.text));
    form.append(element("p", "plain-copy", `本次包含：${candidate.inScope.join("；")}\n本次不包含：${candidate.outOfScope.join("；") || "无"}`));
    return candidate;
  }, (contract) => sendAction("confirm-contract", { contract, expectedAnalysisHash }), "确认需求定版");
}

function openPlanEditor() {
  const { meta, planAnalysis } = state.detail;
  const candidate = JSON.parse(JSON.stringify(planAnalysis.draft)); delete candidate.markdown;
  const taskId = meta.id; const expectedPlanHash = meta.planHash;
  structuredModal(`修改研发方案 v${meta.planVersion}`, "保存后 AI 会根据冻结需求和真实源码重新核对。修改与分析均留存；涉及业务变化需产品重新确认。", form => {
    const design = {};
    if (candidate.schemaVersion === 2) {
      for (const [key, title, limit] of [["approach", "实现思路", 4000], ["frontend", "前端设计", 4000], ["backend", "后端设计", 4000], ["data", "数据处理", 2000]]) {
        if (["frontend", "backend"].includes(key) && !candidate.domains.includes(key)) continue;
        const input = formField(form, title, "textarea"); input.value = candidate.design[key]; input.maxLength = limit;
        design[key] = input;
      }
      design.interfaces = candidate.design.interfaces.map(item => {
        const group = element("details", "audit-diagnostics"); group.append(element("summary", "", `接口：${item.name}`)); form.append(group);
        const fields = {};
        for (const [key, label] of [["name", "名称"], ["method", "方法"], ["path", "路径"], ["sourceFile", "源码文件"], ["request", "请求示例"], ["response", "响应示例"], ["errors", "异常处理"]]) {
          const input = formField(group, label, ["request", "response", "errors"].includes(key) ? "textarea" : "input");
          input.value = item[key]; fields[key] = input;
        }
        const status = formField(group, "接口改动", "select");
        for (const [value, label] of [["existing", "复用"], ["modified", "修改"], ["new", "新增"]]) { const option = element("option", "", label); option.value = value; status.append(option); }
        status.value = item.status; fields.status = status;
        const updateSource = () => { fields.sourceFile.required = status.value !== "new"; };
        status.addEventListener("change", updateSource); updateSource();
        return fields;
      });
      design.diagrams = candidate.design.diagrams.map(item => {
        const group = element("details", "audit-diagnostics"); group.append(element("summary", "", item.title)); form.append(group);
        const source = formField(group, "流程或时序（Mermaid）", "textarea"); source.value = item.source; source.maxLength = 4000;
        return source;
      });
    }
    const changes = candidate.changes.map(item => {
      const file = formField(form, "拟改文件"); file.value = item.file;
      const description = formField(form, "如何修改", "textarea"); description.value = item.description; description.maxLength = 500;
      let location; let pseudocode;
      if (candidate.schemaVersion === 2) {
        const component = candidate.design.components.find(row => row.file === item.file);
        location = formField(form, "修改位置（类、方法或页面）"); location.value = component.location; location.maxLength = 500;
        pseudocode = formField(form, "关键伪代码", "textarea"); pseudocode.value = component.pseudocode; pseudocode.maxLength = 1600;
        pseudocode.required = false;
      }
      return { file, description, location, pseudocode, priorFile: item.file };
    });
    const verification = candidate.verification.map(item => {
      form.append(element("h3", "content-heading", `验收 ${item.acceptanceId}`));
      const scenario = formField(form, "完成条件与测试方法", "textarea"); scenario.value = item.scenario; scenario.maxLength = 1000;
      const regression = formField(form, "相关回归检查", "textarea"); regression.value = item.regression; regression.maxLength = 1000;
      return { acceptanceId: item.acceptanceId, scenario, regression };
    });
    const feedback = formField(form, "修改原因或希望 AI 重点核对的问题", "textarea"); feedback.maxLength = 2000;
    return { changes, verification, feedback, design };
  }, async fields => {
    if (state.selectedId !== taskId) { toast("需求已切换，请重新打开当前需求的方案。", true); return false; }
    const mapping = new Map(fields.changes.map(item => [item.priorFile, item.file.value.trim()]));
    candidate.changes = fields.changes.map(item => ({ file: item.file.value.trim(), description: item.description.value.trim() }));
    candidate.affectedFiles = candidate.changes.map(item => item.file);
    candidate.boundaries.modules = candidate.boundaries.modules.map(module => ({ ...module, files: module.files.map(file => mapping.get(file)) }));
    if (candidate.schemaVersion === 2) {
      for (const key of ["approach", "frontend", "backend", "data"]) if (fields.design[key]) candidate.design[key] = fields.design[key].value.trim();
      candidate.design.interfaces = fields.design.interfaces.map(row => Object.fromEntries(Object.entries(row).map(([key, input]) => [key, input.value.trim()])));
      candidate.design.diagrams = candidate.design.diagrams.map((row, index) => ({ ...row, source: fields.design.diagrams[index].value.trim() }));
      candidate.design.components = fields.changes.map(row => ({ ...candidate.design.components.find(item => item.file === row.priorFile),
        file: row.file.value.trim(), location: row.location.value.trim(), pseudocode: row.pseudocode.value.trim() }));
    }
    candidate.verification = fields.verification.map(item => ({ acceptanceId: item.acceptanceId,
      scenario: item.scenario.value.trim(), regression: item.regression.value.trim() }));
    return sendAction("edit-plan", { candidate, feedback: fields.feedback.value.trim(), expectedPlanHash });
  }, "保存并让 AI 核对");
}

const modelAgentLabels = { requirement: "需求 Agent · 业务对齐与验收", development: "开发 Agent · 项目理解、方案、实现与修复",
  review: "审查 Agent · 前后端、测试与恢复检查" };

function modelProfileFields(container, saved) {
  const fields = { saved };
  for (const [name, title, type] of [["baseUrl", "API 地址", "url"],
    ["model", "模型名称", "text"], ["apiKey", "API Key", "password"]]) {
    const input = formField(container, title, "input", name === "apiKey" ? "留空保留现有密钥" : "");
    input.type = type; input.value = name === "apiKey" ? "" : saved[name]; input.required = name !== "apiKey";
    if (name === "apiKey") { input.autocomplete = "new-password"; input.maxLength = 16384; }
    fields[name] = input;
  }
  container.append(element("p", "intake-caption", saved.credentialConfigured ? "API Key 已配置，保存后不会回显。更换服务地址需填写新密钥。" : "填写 API Key 后保存在服务端，页面不会读取原文。"));
  fields.thinking = formField(container, "思考强度", "select");
  for (const [value, title] of [["off", "关闭"], ["minimal", "最少"], ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "最高"]]) {
    const option = element("option", "", title); option.value = value; fields.thinking.append(option);
  }
  fields.thinking.value = saved.thinking;
  fields.maxTokens = formField(container, "输出 Token 上限"); fields.maxTokens.type = "number";
  fields.maxTokens.required = true; fields.maxTokens.min = 1; fields.maxTokens.max = 1000000; fields.maxTokens.step = 1;
  fields.maxTokens.value = saved.modelParameters.maxOutputTokens ?? saved.maxTokens;
  const advanced = element("details", "model-advanced"); advanced.append(element("summary", "", "高级兼容设置（通常无需修改）")); container.append(advanced);
  for (const [name, title, value, optional, maximum] of [
    ["contextWindow", "模型上下文窗口 Token", saved.contextWindow, false, 1000000],
    ["maxPiMs", "单次请求超时（秒）", saved.maxPiMs / 1000, false]]) {
    const input = formField(advanced, title); input.type = "number"; input.required = !optional;
    input.value = value; input.min = name === "maxPiMs" ? 0.001 : 1;
    input.step = name === "maxPiMs" ? 0.001 : 1; if (maximum) input.max = maximum;
    fields[name] = input;
  }
  fields.capabilities = {};
  advanced.append(element("p", "intake-caption", "按供应商实际能力配置。思考开关与 reasoning_effort 参数并非所有模型都支持。"));
  for (const [name, title] of [["reasoning", "支持思考"], ["thinkingToggle", "接受 enable_thinking 参数"],
    ["supportsReasoningEffort", "接受 reasoning_effort 参数"], ["supportsJsonSchema", "支持严格 JSON Schema"], ["imageInput", "支持图片输入"]]) {
    const label = element("label", "model-capability"); const input = element("input", ""); input.type = "checkbox"; input.checked = saved[name];
    label.append(input, element("span", "", title)); advanced.append(label); fields.capabilities[name] = input;
  }
  fields.advanced = advanced;
  return fields;
}

function modelProfileInput(fields) {
  const values = Object.fromEntries(["baseUrl", "model", "apiKey", "thinking"].map(name => [name, fields[name].value.trim()]));
  values.provider = fields.saved.provider;
  if (!fields.saved.credentialConfigured || new URL(fields.saved.baseUrl).origin !== new URL(values.baseUrl).origin) {
    values.provider = new URL(values.baseUrl).hostname;
  }
  values.modelParameters = { ...fields.saved.modelParameters };
  const outputLimit = Number(fields.maxTokens.value);
  const priorOutputLimit = fields.saved.modelParameters.maxOutputTokens ?? fields.saved.maxTokens;
  values.maxTokens = outputLimit === priorOutputLimit ? fields.saved.maxTokens : outputLimit;
  if (outputLimit !== priorOutputLimit) values.modelParameters.maxOutputTokens = outputLimit;
  values.contextWindow = Number(fields.contextWindow.value);
  values.maxPiMs = Math.round(Number(fields.maxPiMs.value) * 1000);
  values.maxToolCalls = fields.saved.maxToolCalls;
  Object.assign(values, Object.fromEntries(Object.entries(fields.capabilities).map(([name, input]) => [name, input.checked])));
  values.modelUsage = { ...fields.saved.modelUsage };
  return values;
}

async function openModelSettings() {
  if (!state.principal.roles.includes("admin")) throw new Error("只有管理员可以配置模型。");
  const projectId = state.currentProjectId; const setup = await api("/api/model-settings");
  if (state.currentProjectId !== projectId) throw new Error("项目已切换，请重新打开模型设置。");
  structuredModal("模型设置", "当前项目的默认配置适用于所有 Agent。只有需要不同模型或参数时才单独设置；额度耗尽后由管理员修改，不自动切换。", form => {
    const fields = { agents: {} };
    form.append(element("h3", "content-heading", "默认配置")); fields.default = modelProfileFields(form, setup.default);
    appendModelTest(form, "default", () => modelProfileInput(fields.default), projectId);
    fields.maxCostUsd = formField(fields.default.advanced, "单个需求费用上限（USD）");
    fields.maxCostUsd.type = "number"; fields.maxCostUsd.min = 0.001; fields.maxCostUsd.step = "any"; fields.maxCostUsd.value = setup.maxCostUsd;
    form.append(element("h3", "content-heading", "Agent 模型"), element("p", "intake-caption", "默认继承项目模型；展开对应 Agent，取消继承即可单独设置。"));
    for (const [agent, title] of Object.entries(modelAgentLabels)) {
      const section = element("details", "model-agent"); const summary = element("summary", "", title); section.append(summary); form.append(section);
      const label = element("label", "model-capability"); const inherit = element("input", ""); inherit.type = "checkbox"; inherit.checked = !setup.agents[agent];
      label.append(inherit, element("span", "", "继承项目默认模型")); section.append(label);
      const custom = element("div", "model-custom"); section.append(custom);
      const row = { inherit, custom, inputs: setup.agents[agent] ? modelProfileFields(custom, setup.agents[agent]) : null };
      fields.agents[agent] = row;
      const toggle = () => {
        if (!inherit.checked && !row.inputs) {
          row.inputs = modelProfileFields(custom, { ...fields.default.saved,
            ...Object.fromEntries(["baseUrl", "model", "thinking"].map(name => [name, fields.default[name].value])),
            maxTokens: Number(fields.default.maxTokens.value), contextWindow: Number(fields.default.contextWindow.value),
            maxPiMs: Math.round(Number(fields.default.maxPiMs.value) * 1000),
            modelParameters: { ...fields.default.saved.modelParameters, maxOutputTokens: Number(fields.default.maxTokens.value) },
            ...Object.fromEntries(Object.entries(fields.default.capabilities).map(([name, input]) => [name, input.checked])) });
          appendModelTest(custom, agent, () => modelProfileInput(row.inputs), projectId);
        }
        custom.hidden = inherit.checked; summary.textContent = `${title} · ${inherit.checked ? "继承默认" : "单独配置"}`;
        for (const node of custom.querySelectorAll("input,select,button")) node.disabled = inherit.checked; };
      inherit.addEventListener("change", toggle); toggle();
      if (row.inputs) appendModelTest(custom, agent, () => modelProfileInput(row.inputs), projectId);
    }
    return fields;
  }, async fields => {
    if (state.currentProjectId !== projectId) throw new Error("项目已切换，请在当前项目中配置。");
    await api("/api/model-settings", { method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
      body: JSON.stringify({ expectedConfigHash: setup.expectedConfigHash, default: modelProfileInput(fields.default),
        agents: Object.fromEntries(Object.entries(fields.agents).map(([agent, row]) => [agent, row.inherit.checked ? null : modelProfileInput(row.inputs)])),
        maxCostUsd: Number(fields.maxCostUsd.value) }) });
    fields.default.apiKey.value = ""; for (const row of Object.values(fields.agents)) if (row.inputs) row.inputs.apiKey.value = "";
    await refresh(); toast("模型设置已保存。后续调用使用新配置，已有需求、方案和审核记录保留。");
  }, "保存模型配置");
}

function appendModelTest(container, scope, getProfile, projectId) {
  const button = element("button", "button", "测试连接"); button.type = "button";
  const status = element("p", "intake-caption", "测试仅发送一个短请求，会消耗少量 Token，不保存配置。");
  status.setAttribute("aria-live", "polite"); container.append(button, status);
  button.addEventListener("click", async () => {
    if (state.currentProjectId !== projectId) { status.textContent = "项目已切换，请重新打开设置。"; return; }
    button.disabled = true; status.textContent = "正在测试连接…";
    try {
      const result = await api("/api/model-connection", { method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
        body: JSON.stringify({ scope: typeof scope === "function" ? scope() : scope, profile: getProfile() }) });
      status.textContent = `连接成功 · ${result.model} · ${result.elapsedMs} ms · ${result.outputFormat === "json_schema" ? "严格 JSON Schema" : "JSON 模式，程序继续校验结构"}`;
    } catch (error) { status.textContent = `连接失败：${error.message}`; }
    finally { button.disabled = false; }
  });
}

function deploymentSettingsInput(fields) {
  if (fields.kind.value === "unconfigured") return { kind: "unconfigured" };
  if (fields.kind.value === "local") return { kind: "local", deployCommand: fields.inputs.deployCommand.value };
  const values = Object.fromEntries(Object.entries(fields.inputs).map(([key, input]) => [key, input.value.trim()]));
  if (fields.kind.value === "jenkins") values.jobPath = values.jobPath.split("/").map(name => `job/${encodeURIComponent(name)}`).join("/");
  if (values.baseUrl && !values.baseUrl.endsWith("/")) values.baseUrl += "/";
  return { kind: fields.kind.value, fields: values };
}

function renderDeploymentSettings(container, fields, setup) {
  clear(container); fields.inputs = {};
  const kind = fields.kind.value;
  const saved = setup.kind === kind ? setup.fields : {};
  if (kind === "unconfigured") {
    container.append(element("p", "plain-copy", "公司有固定测试环境时，选择上面的发布工具并连接既有流水线。本地变量和依赖在环境配置页维护，启动命令由研发方案确定。"));
    return;
  }
  if (kind === "local") {
    const input = formField(container, "发布到固定测试环境的已有脚本", "input", "npm run deploy:test"); input.value = setup.deployCommand;
    fields.inputs.deployCommand = input; return;
  }
  const definitions = kind === "jenkins" ? [["baseUrl", "Jenkins 地址", "https://jenkins.company.com/"], ["jobPath", "流水线名称（文件夹用 / 分隔）", "my-app/deploy-test"], ["username", "Jenkins 用户名", "deploy-user"]]
    : kind === "gitlab" ? [["baseUrl", "GitLab 地址", "https://gitlab.company.com/"], ["projectId", "项目 ID（项目首页可查看）", "123"]]
      : [["baseUrl", "GitHub API 地址", "https://api.github.com/"], ["owner", "组织或用户名", "my-company"], ["repository", "仓库名称", "my-app"], ["workflow", "发布工作流文件", "deploy-test.yml"]];
  const apiSettings = element("details", "audit-diagnostics"); apiSettings.append(element("summary", "", "自托管 GitHub 地址（可选）"));
  for (const [key, label, placeholder] of definitions) {
    const input = formField(kind === "github" && key === "baseUrl" ? apiSettings : container, label, "input", placeholder);
    input.value = saved[key] ?? (key === "baseUrl" && kind === "github" ? "https://api.github.com/" : "");
    if (key === "jobPath" && saved[key]) input.value = saved[key].split("/").filter((_value, index) => index % 2 === 1).map(decodeURIComponent).join("/");
    fields.inputs[key] = input;
  }
  if (kind === "github") container.append(apiSettings);
  const tokenLabel = kind === "jenkins" ? "Jenkins API Token" : kind === "gitlab" ? "GitLab API 令牌" : "GitHub API 令牌";
  const token = formField(container, tokenLabel, "input", setup.kind === kind && setup.credentialConfigured ? "已配置；留空保留，填写则更新" : `填写 ${tokenLabel}`);
  token.type = "password"; token.autocomplete = "new-password"; token.required = !(setup.kind === kind && setup.credentialConfigured); fields.inputs.token = token;
  container.append(element("p", "plain-copy", kind === "jenkins" ? "从 Jenkins 用户设置获取 API Token，用于触发发布和查询结果。"
    : kind === "gitlab" ? "从 GitLab 项目 Settings → Access tokens 获取，需 api 权限及运行该流水线的角色；不是 Pipeline trigger token。"
      : "从 GitHub 令牌设置获取，选择目标仓库并授予 Actions 读写权限，用于触发发布和查询结果。"));
  const button = element("button", "button", "验证连接"); button.type = "button";
  const result = element("p", "plain-copy"); container.append(button, result);
  button.addEventListener("click", async () => {
    const projectId = state.currentProjectId; const selectedKind = kind;
    button.disabled = true; result.textContent = "正在验证连接…";
    try {
      const response = await api("/api/deployment-connection", { method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token }, body: JSON.stringify(deploymentSettingsInput(fields)) });
      if (state.currentProjectId === projectId && fields.kind.value === selectedKind) result.textContent = `连接成功：${response.name}。未触发构建或发布。`;
    } catch (error) { result.textContent = error.message; }
    finally { button.disabled = false; }
  });
}

function environmentStatusText(status) {
  const labels = { ready: "配置检查通过", blocked: "缺少环境条件", unconfigured: "尚未配置", unchecked: "待检查" };
  if (!Object.hasOwn(labels, status)) throw new Error(`未知环境状态：${status}`);
  return labels[status];
}

function renderEnvironmentItems(root, report) {
  if (report.target) root.append(element("p", "plain-copy", `已保存配置的检查范围：${report.targetName}。`));
  if (report.checkedAt) root.append(element("p", "plain-copy", `最近检查 ${dateText(report.checkedAt)}${report.actor ? ` · ${report.actor}` : ""}。端口可连接不代表数据库登录、表结构或业务验证通过。`));
  for (const item of report.items) root.append(element("p", item.status === "blocked" ? "environment-blocked" : "plain-copy",
    `${item.name}：${item.status === "ready" ? "通过" : item.message}`));
  if (!report.checkedAt) root.append(element("p", "plain-copy", "保存后请检查环境；系统只检查已声明的变量和依赖，不会创建数据库或安装服务。"));
}

function renderTestEnvironmentCard(root, setup) {
  const card = element("section", "environment-card");
  card.append(element("h2", "", "测试环境发布"), element("p", "plain-copy", setup.test.kind === "unconfigured"
    ? "尚未连接固定测试环境。也可先使用本地验证。" : `发布工具：${setup.test.kind}。发布由研发确认本次代码版本后触发。`));
  if (setup.test.url) { const link = element("a", "button", "打开测试环境"); link.href = setup.test.url;
    link.target = "_blank"; link.rel = "noopener"; card.append(link); }
  if (setup.canConfigure) {
    const edit = element("button", "button", "配置测试环境"); edit.type = "button";
    edit.addEventListener("click", () => openTestEnvironmentSettings().catch(error => toast(error.message, true)));
    card.append(edit);
  }
  card.append(element("p", "plain-copy", "用户准备好测试环境和流水线，系统保存连接配置、检查连接并在确认后发布。产品按需求验收，结果与实际版本一起归档。"));
  for (const [index, event] of setup.test.history.entries()) card.append(element("p", "plain-copy",
    `配置 v${index + 1} · ${event.actor} · ${dateText(event.at)} · ${event.configHash.slice(0, 12)}`));
  root.append(card);
}

async function openLocalEnvironmentSettings() {
  await openEnvironmentPage();
}

async function openEnvironmentPage() {
  const projectId = state.currentProjectId; const request = ++state.environmentRequest;
  const setup = await api("/api/environment-status");
  if (state.currentProjectId !== projectId || request !== state.environmentRequest) return;
  state.page = "environment";
  $("#requirementPage").hidden = true; $("#environmentPage").hidden = false;
  document.querySelectorAll("[data-nav]").forEach(node => node.classList.remove("active"));
  $("#environmentNavButton").classList.add("active");
  const root = clear($("#environmentPage"));
  const heading = element("section", "page-heading");
  const intro = element("div", ""); intro.append(element("p", "eyebrow", "PROJECT ENVIRONMENTS"),
    element("h1", "", "环境配置"), element("p", "page-subtitle", `${state.overview.project.name} · 项目共用，测试验收后归档`));
  heading.append(intro); root.append(heading);
  root.append(element("p", "plain-copy", setup.canConfigure ? "管理员和已接受项目研发分工的研发可配置。保存配置、检查连接、发布和验收分别留痕。"
    : "你可以查看环境状态和测试地址；请联系项目研发或管理员配置环境。"));
  const cards = element("div", "environment-grid");
  const local = element("section", "environment-card");
  local.append(element("h2", "", "本地验证"), element("span", "status-chip", environmentStatusText(setup.local.report.status)),
    element("p", "plain-copy", "选择启动目标，按服务补齐配置。保存和检查不会启动应用；启动方式仍由已确认研发方案确定。"));
  renderEnvironmentItems(local, setup.local.report);
  cards.append(local); root.append(cards);
  if (setup.canConfigure) {
    try { await renderScannedEnvironment(local, projectId, request); }
    catch (error) { local.append(element("p", "environment-blocked", `扫描失败：${error.message}`)); throw error; }
    if (state.currentProjectId !== projectId || request !== state.environmentRequest) return;
    const check = element("button", "button", "检查已保存配置"); check.type = "button";
    check.addEventListener("click", async () => {
      check.disabled = true;
      try { await api("/api/local-environment-check", { method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token }, body: "{}" });
        if (state.currentProjectId === projectId) { await refresh(); toast("环境检查已完成。检查只读取变量并连接依赖端口，不启动业务服务。"); }
      } catch (error) { toast(error.message, true); } finally { check.disabled = false; }
    });
    local.append(check);
  }
  renderTestEnvironmentCard(cards, setup);
  root.append(element("p", "plain-copy", `共用配置影响当前项目的未归档需求：${setup.affectedRequirements.map(row => `${row.id} ${row.title}`).join("、") || "暂无"}。运行期间禁止修改，修改后重新检查。`));
  const history = element("section", "environment-card"); history.append(element("h2", "", "本地配置变更记录"));
  for (const [index, event] of setup.local.history.entries()) history.append(element("p", "plain-copy",
    `v${index + 1} · ${event.actor} · ${dateText(event.at)} · ${event.revision.slice(0, 12)} · 影响需求 ${event.affectedRequirements.join("、") || "无"}`));
  if (!setup.local.history.length) history.append(element("p", "plain-copy", "尚无配置记录。"));
  root.append(history);
}

async function openTestEnvironmentSettings() {
  const projectId = state.currentProjectId;
  const setup = await api("/api/project-execution");
  const gitSetup = setup.mode === "git" ? await api("/api/project-git") : null;
  if (!["local", "unconfigured", "jenkins", "gitlab", "github"].includes(setup.kind)) return toast(`此项目使用 ${setup.kind} 扩展，请由开发人员维护已有配置。`, false);
  structuredModal("测试环境配置", "管理员和当前项目研发可维护测试环境与 Git 交付规则。保存不会发布；研发仍需确认发布版本，验收通过后归档。", form => {
    const checks = formField(form, "项目共用检查命令（可选，每行一条）", "textarea", "使用项目已有的测试脚本命令"); checks.value = setup.checksText;
    form.append(element("p", "plain-copy", "可留空。这里只提供项目检查候选，系统根据源码依赖在研发方案中选择本次范围，不会默认全量回归。"));
    const kind = formField(form, "固定测试环境发布工具", "select");
    for (const [value, label] of [["unconfigured", "未配置固定测试环境"], ["jenkins", "Jenkins"], ["gitlab", "GitLab CI/CD"], ["github", "GitHub Actions"], ["local", "固定环境的已有发布脚本"]]) {
      const option = element("option", "", label); option.value = value; kind.append(option);
    }
    kind.value = setup.kind;
    const provider = element("div", ""); form.append(provider);
    const fields = { kind };
    const url = formField(form, "固定测试环境地址", "input", "https://test.company.com/"); url.value = setup.url; url.type = "url";
    const render = () => { renderDeploymentSettings(provider, fields, setup);
      url.parentElement.hidden = kind.value === "unconfigured"; url.required = kind.value !== "unconfigured";
      checks.required = false;
      if (testBranch) testBranch.required = testMode.value === "merge";
      timeout.parentElement.hidden = kind.value === "unconfigured" || kind.value === "local";
      deployEnv.parentElement.hidden = kind.value !== "local";
    };
    const delivery = element("div", ""); form.append(delivery);
    let testMode = null; let testBranch = null;
    if (gitSetup) {
      delivery.append(element("h3", "", "Git 交付规则"), element("p", "plain-copy", `仓库：${gitSetup.root} · 开发基线：${gitSetup.baseBranch}`));
      testMode = formField(delivery, "测试环境使用的代码", "select");
      for (const [value, text] of [["branch", "直接部署需求分支（推荐）"], ["merge", "合并到指定分支后部署"]]) {
        const option = element("option", "", text); option.value = value; testMode.append(option);
      }
      testMode.value = setup.gitDelivery.testMode;
      testBranch = formField(delivery, "测试合并目标分支", "input", "例如 develop"); testBranch.value = setup.gitDelivery.testBranch ?? "";
      const update = () => { testBranch.parentElement.hidden = testMode.value !== "merge"; testBranch.required = testMode.value === "merge"; };
      testMode.addEventListener("change", update); update();
      delivery.append(element("p", "plain-copy", "复用公司既有分支和流水线规则。合并模式会在研发确认后推送合并结果；仓库禁止直接推送时须按公司 MR/PR 流程处理。"));
    }
    if (setup.mode !== "git") delivery.append(element("p", "plain-copy", "当前为目录复制项目，没有可用的 Git 仓库。研发可配置本地测试；合并发布需要导入可用的 Git 仓库并连接发布工具。"));
    const advanced = element("details", "audit-diagnostics"); advanced.append(element("summary", "", "高级设置"));
    const timeout = formField(advanced, "发布等待时间（秒）", "input"); timeout.type = "number"; timeout.min = "1"; timeout.value = String(Math.ceil(setup.timeoutMs / 1000));
    const checkEnv = formField(advanced, "测试需要的环境变量名称（每行一个）", "textarea"); checkEnv.required = false; checkEnv.value = setup.checksEnvironment.join("\n");
    const deployEnv = formField(advanced, "部署需要的环境变量名称（每行一个）", "textarea"); deployEnv.required = false; deployEnv.value = setup.deploymentEnvironment.join("\n");
    advanced.append(element("p", "plain-copy", "这里只填写名称，值由运行服务的环境提供，不填写密码或密钥。")); form.append(advanced);
    kind.addEventListener("change", render); render();
    return { ...fields, providerFields: fields, checks, url, checkEnv, deployEnv, timeout, testMode, testBranch };
  }, async fields => {
    if (state.currentProjectId !== projectId) { toast("项目已切换，请重新打开测试环境配置。", true); return false; }
    const names = value => value.trim() ? value.trim().split(/\r?\n/).map(name => name.trim()) : [];
    await api("/api/project-execution", { method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
      body: JSON.stringify({ expectedConfigHash: setup.configHash, checksText: fields.checks.value,
        ...(fields.testMode ? { gitDelivery: fields.testMode.value === "branch" ? { testMode: "branch" }
          : { testMode: "merge", testBranch: fields.testBranch.value.trim() } } : {}),
        ...deploymentSettingsInput(fields.providerFields), timeoutMs: Number(fields.timeout.value) * 1000,
        url: fields.kind.value === "unconfigured" ? "" : fields.url.value,
        checksEnvironment: names(fields.checkEnv.value), deploymentEnvironment: names(fields.deployEnv.value) }) });
    await refresh(); toast("项目执行配置已保存。已有方案在配置改变后需要重新核对。");
  }, "保存配置");
}

async function openPlanApproval() {
  const { meta } = state.detail; const taskId = state.selectedId; const projectId = state.currentProjectId;
  const expectedPlanHash = meta.planHash;
  const setup = state.overview.project.mode === "git" ? await api("/api/project-git") : null;
  const development = await api(`/api/tasks/${encodeURIComponent(taskId)}/actions`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
    body: JSON.stringify({ action: "local-validation", stage: "development", expectedPlanHash }) });
  if (state.selectedId !== taskId || state.currentProjectId !== projectId) return;
  structuredModal("确认方案并开发", "核对技术方案与本次检查方式。Pi 在独立工作目录开发和测试；检查通过后可人工确认归档，本地验证和测试发布可选。", form => {
    const validation = development.validation;
    for (const item of validation.checks) form.append(element("p", "plain-copy", `自动检查：${item.command.join(" ")} · ${item.reason}`));
    for (const item of validation.skipped) form.append(element("p", "plain-copy", `跳过：${item.command.join(" ")} · ${item.reason}`));
    if (!validation.checks.length) form.append(element("p", "plain-copy", `待人工验证：${validation.manualReason}`));
    for (const service of validation.startup) form.append(element("p", "plain-copy", `本地启动：${service.name} · ${service.url}`));
    if (!setup) return {};
    form.append(element("p", "plain-copy", `方案 v${meta.planVersion} · 基础版本 ${meta.baseRevision?.slice(0, 12)} · 合并目标 ${setup.releaseBranch}`));
    const kind = formField(form, "开发分支", "select");
    for (const [value, text] of [["new", "新建需求分支（推荐）"], ["existing", "使用已有需求分支"]]) {
      const option = element("option", "", text); option.value = value; kind.append(option);
    }
    kind.value = "new";
    const branch = formField(form, "新分支名称", "input"); branch.value = `${setup.branchPrefix}/${taskId}${meta.restartCount ? `-restart-${meta.restartCount}` : ""}`;
    const existing = formField(form, "已有需求分支", "select");
    for (const name of setup.branches.filter(name => ![setup.baseBranch, setup.releaseBranch, setup.testBranch].includes(name))) {
      const option = element("option", "", name); option.value = name; existing.append(option);
    }
    const update = () => { branch.parentElement.hidden = kind.value !== "new"; branch.required = kind.value === "new";
      existing.parentElement.hidden = kind.value !== "existing"; existing.required = kind.value === "existing"; };
    kind.addEventListener("change", update); update();
    return { kind, branch, existing };
  }, fields => {
    if (state.selectedId !== taskId || state.currentProjectId !== projectId) throw new Error("需求已切换，请重新确认。");
    closeModal();
    return sendAction("approve-plan", { expectedPlanHash,
      ...(setup ? { developmentBranch: { kind: fields.kind.value, branch: fields.kind.value === "new" ? fields.branch.value.trim() : fields.existing.value } } : {}) });
  }, "确认方案并开始开发");
}

async function openGitDelivery(action, startupConfirmation = null) {
  const { meta } = state.detail; const taskId = state.selectedId; const projectId = state.currentProjectId;
  const input = { expectedAfterHash: meta.afterHash, expectedPlanHash: meta.planHash };
  if (action === "local-validation") {
    if (!startupConfirmation) {
      const source = await api(`/api/local-environment-scan?taskId=${encodeURIComponent(taskId)}`);
      if (state.selectedId !== taskId || state.currentProjectId !== projectId) return;
      const effects = source.setup.settings?.scan ? scannedServices(source.scan, source.setup.settings.target)
        .filter(service => service.kind === "application").flatMap(service => service.effects) : [];
      if (effects.length) {
        structuredModal("确认本地启动影响", "配置检查不会执行数据库操作。启动应用可能执行下列写入，请确认连接的是允许验证的环境。", form => {
          form.append(element("p", "plain-copy", `环境配置 v${source.setup.version} · 目标 ${source.setup.settings.target === "all" ? "完整应用" : source.setup.settings.target === "frontend" ? "仅前端" : source.setup.settings.target}`));
          for (const effect of effects) form.append(element("p", "environment-effect", effect));
          const label = element("label", "environment-confirm"); const consent = element("input", ""); consent.type = "checkbox"; consent.required = true;
          label.append(consent, document.createTextNode("确认本次验证环境允许上述启动写入")); form.append(label); return { consent };
        }, async fields => {
          if (!fields.consent.checked || state.selectedId !== taskId || state.currentProjectId !== projectId) throw new Error("请重新确认当前需求和环境。");
          closeModal(); return openGitDelivery(action, { revision: source.setup.revision });
        }, "确认并启动");
        return;
      }
    } else Object.assign(input, { confirmStartupEffects: true, expectedEnvironmentRevision: startupConfirmation.revision });
    const result = await sendAction(action, input, true);
    if (!result) return;
    if (state.selectedId !== taskId || state.currentProjectId !== projectId) return;
    if (result.status === "blocked") {
      toast(`本地验证等待环境配置：${result.prerequisites.items.filter(item => item.status === "blocked").map(item => `${item.name} ${item.message}`).join("；")}。可配置环境或发布到测试环境。`, true);
      return;
    }
    structuredModal("本地环境验证", result.status === "running" ? "项目已启动。按方案中的验收场景验证，也可关闭窗口后发布测试环境。" : "此项目没有常驻本地服务。按方案验证 CLI/库，也可直接发布测试环境。", form => {
      form.append(element("p", "plain-copy", `工作目录：${result.workspace}`));
      for (const service of result.services) {
        const link = element("a", "button", `打开 ${service.name}`); link.href = service.url; link.target = "_blank"; link.rel = "noopener"; form.append(link);
        const log = element("pre", "archive-result"); log.textContent = service.tail; form.append(log);
      }
      if (result.status === "running") {
        const stop = element("button", "button", "停止本地环境"); stop.type = "button";
        stop.addEventListener("click", async () => {
          if (state.selectedId !== taskId || state.currentProjectId !== projectId) throw new Error("需求已切换，请重新打开本地环境。");
          await sendAction(action, { ...input, operation: "stop" }); closeModal();
        }); form.append(stop);
      }
      if (result.patch !== null) {
        const download = element("button", "button", "下载本次修改补丁"); download.type = "button";
        download.addEventListener("click", () => {
          const url = URL.createObjectURL(new Blob([result.patch + "\n"], { type: "text/plain" }));
          const link = element("a", ""); link.href = url; link.download = `${taskId}.patch`; link.click(); URL.revokeObjectURL(url);
        });
        form.append(download, element("p", "plain-copy", "在对应基础版本运行 git apply --check，再运行 git apply 应用补丁。若本地有修改，回传的是相对于本次 Agent 结果的补丁。"));
      }
      return {};
    }, async () => {
      closeModal();
      if (state.selectedId === taskId && state.currentProjectId === projectId) await refresh(taskId);
    }, "完成，返回需求");
    return;
  }
  if (action === "recheck-local") {
    const git = state.overview.project.mode === "git";
    structuredModal("重新检查本地修改", git
      ? "工作目录中的修改将重新进行范围检查和自动测试。也可上传本地相对于 Agent 结果的 Git 补丁；此操作不会提交或发布。"
      : "在本需求独立工作目录修改后，重新进行范围检查和自动测试；此操作不会发布。", form => {
      const patch = git ? formField(form, "本地修改补丁（可选）", "input") : null;
      if (patch) { patch.type = "file"; patch.required = false; }
      return { patch };
    }, async fields => {
      if (state.selectedId !== taskId || state.currentProjectId !== projectId) throw new Error("需求已切换，请重新确认。");
      const file = fields.patch?.files[0];
      if (file && file.size > 1024 * 1024) throw new Error("补丁不能超过 1 MiB。");
      closeModal();
      return sendAction(action, { ...input, ...(file ? { patch: await file.text() } : {}) });
    }, "重新检查");
    return;
  }
  const setup = await api("/api/project-git");
  const candidate = meta.gitCandidate ? await api(`/api/tasks/${encodeURIComponent(taskId)}/git-candidate`) : null;
  if (state.selectedId !== taskId || state.currentProjectId !== projectId) return;
  const title = setup.testMode === "merge" ? "提交、合并并发布测试环境" : "提交并发布测试环境";
  structuredModal(title, "请先查看本次代码差异和测试结果。确认后系统提交、推送并触发测试流水线；提交身份为 pi-reqflow，审核记录关联你的账号。", form => {
    form.append(element("p", "plain-copy", `需求分支：${meta.branch} · 已验证代码：${meta.afterHash.slice(0, 12)}`));
    for (const change of state.detail.changes.changes) {
      const details = element("details", "audit-diagnostics"); details.append(element("summary", "", change.file));
      const button = element("button", "button", "查看修改前后代码"); button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const diff = await api(`/api/tasks/${encodeURIComponent(taskId)}/files?path=${encodeURIComponent(change.file)}`);
          if (state.selectedId !== taskId || state.currentProjectId !== projectId) return;
          renderDiff(details, diff); button.hidden = true;
        } catch (error) { toast(error.message, true); button.disabled = false; }
      });
      details.append(button); form.append(details);
    }
    form.append(element("p", "plain-copy", `自动测试：${meta.checks.length} 项通过。`));
    if (setup.testMode === "merge") form.append(element("p", "plain-copy", `合并到：${setup.testBranch}。系统先验证合并后的版本，通过后推送；冲突会暂停并保留工作目录。`));
    if (candidate) {
      form.append(element("p", "plain-copy", `保留的合并目录：${candidate.workspace}`));
      const diff = element("pre", "archive-result"); diff.textContent = candidate.diff; form.append(diff);
      if (candidate.conflicts) form.append(element("p", "audit-error", `尚有冲突：${candidate.conflicts}。请研发解决并暂存后继续。`));
    }
    const label = element("label", "form-field inline-check");
    const localValidated = element("input", ""); localValidated.type = "checkbox";
    label.append(localValidated, element("span", "", "我已完成本地验证（可选，按实际情况勾选）")); form.append(label);
    return { localValidated };
  }, async fields => {
    if (state.selectedId !== taskId || state.currentProjectId !== projectId) throw new Error("需求已切换，请重新确认。");
    const saved = await sendAction(action, { ...input, authorizeGit: true, ...(action === "redeploy-test" ? { authorizeDeployment: true } : {}), testMode: setup.testMode,
      ...(setup.testMode === "merge" ? { testBranch: setup.testBranch } : {}),
      ...(candidate ? { expectedCandidateHash: candidate.hash } : {}), localValidated: fields.localValidated.checked === true });
    if (!saved && state.selectedId === taskId && state.currentProjectId === projectId && state.detail.meta.gitCandidate) await openGitDelivery(action);
    return saved;
  }, "确认变更并执行");
}

function openModal(action) {
  if (action === "revise-plan" && state.detail.meta.state === "contract_confirmed" && state.detail.meta.planHash
      && state.detail.meta.planFeedbackVersion === state.detail.meta.planVersion) {
    return sendAction("revise-plan", { retry: true, expectedPlanHash: state.detail.meta.planHash });
  }
  if (action === "revise-plan" && state.detail.meta.state === "plan_review" && state.detail.meta.planBlockers?.length
      && !state.detail.meta.planResolutionHash) {
    const latest = state.detail.planDiscussion?.messages.filter(message => message.planVersion === state.detail.meta.planVersion
      && ["plan_message", "plan_reply", "plan_discussion_failed"].includes(message.type)).at(-1);
    if (latest?.reply && ["keep", "revise"].includes(latest.reply.recommendation) && !latest.reply.pendingQuestions.length
        && (latest.reply.decisions ?? []).every(decision => !decision.humanRequired)) {
      return sendAction("revise-plan", { expectedPlanHash: state.detail.meta.planHash,
        feedback: "用 read_plan 的 discussion、specialists、impacts 和 boundaries 核实最新沟通与当前技术阻断，给出最简单可验证修正并更新方案。AI建议须客观核实，无待回答问题不等于通过。代码回滚不能恢复数据库；必要恢复步骤写入设计，不强制新建回退脚本或范围外的用户撤销功能。保留冻结验收和合理研发选择，不重复提问。仅生成待审核版本，不批准或开发。" });
    }
  }
  if (action === "approve-plan") return openPlanApproval().catch(error => toast(error.message, true));
  if (["local-validation", "recheck-local", "publish-test"].includes(action)) return openGitDelivery(action).catch(error => toast(error.message, true));
  if (action === "redeploy-test" && state.overview.project.mode === "git") return openGitDelivery(action).catch(error => toast(error.message, true));
  const taskId = state.selectedId; const expectedPlanHash = state.detail.meta.planHash; const expectedAfterHash = state.detail.meta.afterHash;
  const expectedAuditHead = state.detail.auditHead;
  const acceptanceMode = state.detail.meta.state === "verified" ? "manual" : "deployed";
  const copy = {
    develop: ["从当前现场继续", "沿用已确认方案、已有修改及可用的 Pi 会话，在剩余任务预算内继续开发和测试。可恢复问题最多自动处理一次；仍失败时保留原因和现场。", null, null],
    "redeploy-test": ["重新发布测试环境", "确认重新发布本需求的已验证代码，不会重新开发或改变需求。", null, null],
    "approve-plan": ["确认方案并开发", `确认方案 v${state.detail.meta.planVersion} 与需求终版一致。确认后由 Pi 开发、运行相关测试，通过后可人工确认归档；环境验证可选，代码差异和回滚证据全程保留。`, null, null],
    "approve-changes": ["审核实际代码变更", "核对代码差异及历史功能、接口、数据影响；你将成为这次变更的具名风险责任人。请写一句审核结论。", "例如：已核对变更文件与原功能回归，确认可进入测试。", "evidence"],
    "deploy-test": ["发布到固定测试环境", "将本需求已通过自动检查的代码发布到项目配置的测试环境。发布完成后再按已定版验收标准进行人工验证。", null, null],
    "revise-plan": ["要求修改方案", "只写需要修正的事实或决定，Pi 会据此生成下一版。", "写下审核意见…", "feedback"],
    "accept-test": state.detail.meta.state === "verified"
      ? ["人工确认并归档", "核对当前需求、代码差异及研发检查结果，留下具名确认结论后归档。本地验证与测试环境发布均为可选；没有自动检查时，请记录实际人工检查结论。", "例如：已核对需求、代码差异和相关用例结果，确认此次研发交付。", "evidence"]
      : ["记录测试验收", "简要记录测试环境、关键路径和结果。", "例如：测试环境接口返回正确，原功能回归正常。", "evidence"],
    "observe-release": ["记录发布观察", "简要记录上线后健康状态和关键功能结果。", "例如：错误率正常，核心接口抽查通过。", "evidence"],
    "approve-release": ["批准生产发布", `确认发布候选版本 ${state.detail.meta.mergedRevision || state.detail.meta.candidateHash} 已验证，且人工测试结论可接受。`, null, null],
    rollback: ["恢复需求工作目录", "恢复本需求工作目录中的文件，先检查后续修改是否冲突。远端提交和已发布环境需在对应平台回退。", null, null],
    "restart-development": ["返回研发方案", "沿用已确认的需求和研发分工，重新设计并确认方案后再开发。上一轮方案、审批、代码快照和累计用量保留；此操作不会调用模型或开始修改代码。", null, null],
  }[action];
  if (!copy) return sendAction(action);
  const [title, description, placeholder, field] = copy;
  const root = $("#modalRoot"); clear(root); root.hidden = false;
  const card = element("div", "modal-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
  card.append(element("h2", "", title), element("p", "", description));
  const input = field ? element("textarea", "") : null;
  if (input) { input.placeholder = placeholder; input.maxLength = 4000; card.append(input); }
  let acceptanceChoice;
  if (action === "accept-test" && acceptanceMode === "manual" && state.detail.meta.localValidation?.environment
      && ["running", "not_applicable", "stopped"].includes(state.detail.meta.localValidation.status)
      && state.detail.meta.localValidation.afterHash === expectedAfterHash) {
    const label = element("label", "", "验收依据");
    acceptanceChoice = element("select", "");
    for (const [value, text] of [["manual", "人工确认研发交付"], ["local", "已完成本地验证"]]) {
      const option = element("option", "", text); option.value = value; acceptanceChoice.append(option);
    }
    acceptanceChoice.value = "manual"; label.append(acceptanceChoice); card.append(label);
  }
  const actions = element("div", "modal-actions");
  const cancel = element("button", "button", "取消"); cancel.type = "button"; cancel.addEventListener("click", closeModal);
  const submit = element("button", `button ${action === "rollback" ? "danger" : "primary"}`,
    action === "rollback" ? "确认回退" : action.startsWith("approve-") ? "确认批准" : "提交");
  submit.type = "button";
  submit.addEventListener("click", async () => {
    const value = input?.value.trim();
    if (state.selectedId !== taskId) return toast("需求已切换，请重新打开当前需求的操作。", true);
    if (field && !value) return toast("请填写具体内容。", true);
    closeModal(); await sendAction(action, action === "restart-development" ? { expectedAuditHead }
      : action === "develop" ? { authorizeImplementation: true, expectedPlanHash, expectedAfterHash }
      : action === "redeploy-test" ? { authorizeDeployment: true, expectedAfterHash, expectedPlanHash }
      : action === "accept-test" ? { evidence: value, acceptanceMode: acceptanceChoice ? acceptanceChoice.value : acceptanceMode,
        expectedAfterHash, expectedPlanHash }
      : action === "approve-plan" ? { expectedPlanHash } : field ? { [field]: value } : {});
  });
  actions.append(cancel, submit); card.append(actions); root.append(card);
  input?.focus();
}

document.querySelectorAll("[data-nav], [data-filter]").forEach((node) => node.addEventListener("click", () => {
  state.page = "requirements"; state.environmentRequest++;
  $("#environmentPage").hidden = true; $("#requirementPage").hidden = false;
  $("#environmentNavButton").classList.remove("active");
  state.filter = node.dataset.nav || node.dataset.filter;
  renderList();
}));
$("#searchInput").addEventListener("input", renderList);
$("#taskList").addEventListener("click", async (event) => {
  const item = event.target.closest("[data-id]");
  if (!item) return;
  state.tab = "plan";
  try { await loadDetail(item.dataset.id); } catch (error) { toast(error.message, true); }
});
$("#detailPanel").addEventListener("click", async (event) => {
  const file = event.target.closest("[data-file]");
  if (file) {
    const taskId = state.selectedId;
    api(`/api/tasks/${encodeURIComponent(taskId)}/files?path=${encodeURIComponent(file.dataset.file)}`)
      .then((result) => { if (state.selectedId === taskId) { state.diff = result; renderDetail(); } })
      .catch((error) => toast(error.message, true));
    return;
  }
  const tab = event.target.closest("[data-tab]");
  if (tab) { state.tab = tab.dataset.tab; renderDetail(); return; }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "pause-execution") {
    const taskId = state.selectedId, projectId = state.currentProjectId;
    button.disabled = true;
    try {
      const execution = await api(`/api/tasks/${encodeURIComponent(taskId)}/actions`, { method: "POST",
        headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token }, body: JSON.stringify({ action }) });
      if (taskId === state.selectedId && projectId === state.currentProjectId) {
        state.detail.execution = execution; renderDetail(); pollExecution();
      }
      toast("正在终止当前进程，保存现场后即可继续。");
    } catch (error) { toast(error.message, true); button.disabled = false; }
    return;
  }
  if (action === "continue-execution") return sendAction(action, { expectedAuditHead: state.detail.auditHead });
  if (action === "configure-environment") return openEnvironmentPage().catch(error => toast(error.message, true));
  if (action === "assign-member" || action === "assign-team") return openAssignmentForm().catch((error) => toast(error.message, true));
  if (action === "review-plan-frontend" || action === "review-plan-backend") {
    const taskId = state.selectedId; const expectedPlanHash = state.detail.meta.planHash;
    const part = action.slice("review-plan-".length);
    return structuredModal(`确认${part === "frontend" ? "前端" : "后端"}方案`, "请核对负责部分、共同接口、交互时序和验收方法。确认将记录账号与方案版本；交付负责人将在分工审核完成后启动开发。", form => {
      form.append(element("p", "plain-copy", "如需调整，请先关闭此窗口，沟通或修改方案。"));
      return {};
    }, async () => {
      if (state.selectedId !== taskId) { toast("需求已切换，请重新核对当前方案。", true); return false; }
      return sendAction("review-plan", { part, expectedPlanHash });
    }, "确认负责部分及共同接口");
  }
  if (action === "accept-assignment" || action === "decline-assignment") {
    return sendAction(action, { role: button.dataset.role, ...(action === "accept-assignment" ? { preparePlan: true } : {}) });
  }
  if (action === "dev-feedback") return openFeedbackForm();
  if (action === "edit-plan") return openPlanEditor();
  if (action === "analyze-intake") return runIntakeAnalysis(state.selectedId).catch((error) => toast(error.message, true));
  if (action === "edit-intake-candidate") return openContractForm(action);
  if (action === "confirm-contract" || action === "revise-contract") return openContractForm(action);
  if (action === "run-review") return sendAction(action, { role: button.dataset.role });
  openModal(action);
});
$("#newTaskButton").addEventListener("click", openNewTask);
$("#adminReportButton").addEventListener("click", () => openAdminReport().catch((error) => toast(error.message, true)));
$("#loadMoreButton").addEventListener("click", async () => {
  try {
    const page = await api(`/api/overview?offset=${state.overview.tasks.length}&limit=100`);
    state.overview.tasks.push(...page.tasks); renderList();
  } catch (error) { toast(error.message, true); }
});
$("#refreshButton").addEventListener("click", () => refresh().catch((error) => toast(error.message, true)));
$("#modalRoot").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

function showLogin() {
  state.token = null; state.principal = null; state.actions = new Set();
  state.overview = null; state.detail = null; state.diff = null; state.selectedId = null;
  state.page = "requirements"; state.environmentRequest++;
  clear($("#environmentPage")); $("#environmentPage").hidden = true; $("#requirementPage").hidden = false;
  closeModal(); clear($("#taskList")); clear($("#detailPanel"));
  $("#loadMoreButton").hidden = true;
  $("#identityName").textContent = "未登录";
  $("#newTaskButton").hidden = true;
  $("#adminReportButton").hidden = true;
  $("#adminNavButton").hidden = true;
  $("#projectRefButton").hidden = true;
  $("#modelSettingsButton").hidden = true;
  $("#loginButton").hidden = false;
  $("#logoutButton").hidden = true;
  $("#loginRoot").hidden = false;
  $("#changePasswordRoot").hidden = true;
  $("#adminRoot").hidden = true;
}

async function establishSession() {
  const session = await api("/api/bootstrap");
  if (session.noProjects) {
    showLogin();
    $("#loginError").textContent = "没有可用项目，请由部署管理员启动内置演示项目，或导入、恢复已有项目。";
    return;
  }
  state.token = session.token;
  state.importRootDir = session.importRootDir;
  state.principal = session.principal;
  state.actions = new Set(session.actions);
  state.projects = session.projects || [];
  state.currentProjectId = session.currentProjectId;
  $("#identityName").textContent = session.principal.username || session.principal.id;
  $("#newTaskButton").hidden = !state.actions.has("new");
  $("#projectRefButton").hidden = false;
  $("#adminReportButton").hidden = !state.actions.has("audit-report");
  $("#adminNavButton").hidden = !state.actions.has("audit-report");
  $("#importProjectButton").hidden = !state.actions.has("import-project");
  $("#loginButton").hidden = true;
  $("#logoutButton").hidden = false;
  renderProjectSelector();
  if (session.principal.mustChangePassword) {
    $("#loginRoot").hidden = true;
    $("#changePasswordRoot").hidden = false;
    return;
  }
  $("#loginRoot").hidden = true;
  $("#changePasswordRoot").hidden = true;
  try {
    await refresh();
  } catch (error) {
    if (error.status === 401) throw error;
    state.detail = null;
    state.diff = null;
    clear($("#detailPanel")).append(element("h2", "", "工作台内容加载失败"),
      element("p", "error-copy", error.message),
      element("p", "plain-copy", "登录成功。可以切换项目、配置模型或新建需求；处理记录错误后点击刷新重试。"));
    toast(`工作台加载失败：${error.message}`, true);
    return { authenticated: true, workspaceReady: false, error: error.message };
  }
  return { authenticated: true, workspaceReady: true };
}

function renderProjectSelector() {
  const select = $("#projectSelect");
  clear(select);
  if (state.projects.length === 0) {
    const option = element("option", "", "暂无项目");
    option.value = "";
    select.appendChild(option);
  } else {
    for (const project of state.projects) {
      const option = element("option", "", project.name);
      option.value = project.id;
      if (project.id === state.currentProjectId) option.selected = true;
      select.appendChild(option);
    }
  }
}

async function switchProject(projectId) {
  if (projectId === state.currentProjectId) return;
  await api(`/api/projects/${encodeURIComponent(projectId)}/switch`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token }, body: "{}" });
  state.selectedId = null;
  await establishSession();
}

$("#projectSelect").addEventListener("change", (event) => {
  switchProject(event.target.value).catch(error => toast(error.message, true));
});

$("#importProjectButton").addEventListener("click", () => {
  $("#importProjectModal").hidden = false;
  $("#importProjectForm").reset();
  $("#importRootPath").value = state.importRootDir;
  $("#importAnalysis").hidden = true;
  $("#importProjectError").textContent = "";
});
$("#environmentNavButton").addEventListener("click", () => openEnvironmentPage().catch(error => toast(error.message, true)));
$("#modelSettingsButton").addEventListener("click", () => openModelSettings().catch(error => toast(error.message, true)));

$("#importProjectCancel").addEventListener("click", () => {
  $("#importProjectModal").hidden = true;
});

let dirBrowserCurrentPath = "";

async function browseDirectory(startPath) {
  const modal = $("#directoryBrowserModal");
  const listEl = $("#dirBrowserList");
  const breadcrumbsEl = $("#dirBrowserBreadcrumbs");
  const upBtn = $("#dirBrowserUp");
  modal.hidden = false;
  clear(listEl);
  breadcrumbsEl.textContent = "加载中…";

  async function navigate(dirPath) {
    try {
      clear(listEl);
      breadcrumbsEl.textContent = "加载中…";
      const data = await api(`/api/browse${dirPath ? `?path=${encodeURIComponent(dirPath)}` : "/home"}`);
      dirBrowserCurrentPath = data.path;
      upBtn.disabled = data.path === "/";
      renderBreadcrumbs(data.path);
      if (data.entries.length === 0) {
        listEl.appendChild(element("div", "dir-browser-empty", "此目录没有子目录"));
      } else {
        for (const entry of data.entries) {
          const item = element("div", "dir-browser-item");
          item.appendChild(element("span", "dir-icon", "📁"));
          item.appendChild(element("span", "", entry.name));
          item.addEventListener("click", () => {
            listEl.querySelectorAll(".dir-browser-item.selected").forEach((el) => el.classList.remove("selected"));
            item.classList.add("selected");
          });
          item.addEventListener("dblclick", () => navigate(entry.path));
          listEl.appendChild(item);
        }
      }
    } catch (error) {
      clear(listEl);
      listEl.appendChild(element("div", "dir-browser-empty", `无法读取目录：${error.message}`));
    }
  }

  function renderBreadcrumbs(fullPath) {
    clear(breadcrumbsEl);
    const parts = fullPath.split("/").filter(Boolean);
    const addCrumb = (label, targetPath, isCurrent) => {
      const crumb = element("span", `dir-browser-crumb${isCurrent ? " current" : ""}`, label);
      if (!isCurrent) crumb.addEventListener("click", () => navigate(targetPath));
      breadcrumbsEl.appendChild(crumb);
    };
    addCrumb("🏠", "/", false);
    let accumulated = "";
    for (let i = 0; i < parts.length; i++) {
      breadcrumbsEl.appendChild(element("span", "dir-browser-sep", "/"));
      accumulated += "/" + parts[i];
      addCrumb(parts[i], accumulated, i === parts.length - 1);
    }
  }

  upBtn.addEventListener("click", () => {
    const parent = dirBrowserCurrentPath.substring(0, dirBrowserCurrentPath.lastIndexOf("/")) || "/";
    navigate(parent);
  });

  if (startPath) {
    await navigate(startPath);
  } else {
    try {
      const home = await api("/api/browse/home");
      await navigate(home.path);
    } catch (error) {
      toast(`目录浏览失败：${error.message}`, true);
    }
  }
}

let dirBrowserTarget = null;

$("#importRootBrowse").addEventListener("click", () => {
  dirBrowserTarget = "importRootPath";
  browseDirectory($("#importRootPath").value.trim());
});

$("#importFrontendBrowse").addEventListener("click", () => {
  dirBrowserTarget = "importFrontendPath";
  browseDirectory();
});

$("#importBackendBrowse").addEventListener("click", () => {
  dirBrowserTarget = "importBackendPath";
  browseDirectory();
});

$("#dirBrowserCancel").addEventListener("click", () => {
  $("#directoryBrowserModal").hidden = true;
});

$("#dirBrowserSelect").addEventListener("click", () => {
  if (dirBrowserTarget) {
    $(`#${dirBrowserTarget}`).value = dirBrowserCurrentPath;
  }
  $("#directoryBrowserModal").hidden = true;
});

$("#importProjectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#importProjectError").textContent = "";
  const name = $("#importProjectName").value.trim();
  const rootDir = $("#importRootPath").value.trim();
  const frontendDir = $("#importFrontendPath").value.trim();
  const backendDir = $("#importBackendPath").value.trim();

  if (!name) {
    $("#importProjectError").textContent = "请填写项目名称";
    return;
  }
  if (!rootDir && !frontendDir && !backendDir) {
    $("#importProjectError").textContent = "请选择项目根目录，或填写独立前后端目录";
    return;
  }
  if (rootDir && (frontendDir || backendDir)) {
    $("#importProjectError").textContent = "项目根目录与独立前后端目录请选择一种导入方式";
    return;
  }

  try {
    // Prepare import data
    const configFile = $("#importConfig").files[0];
    const importData = { name, options: configFile ? { config: JSON.parse(await configFile.text()) } : {} };
    if (rootDir) importData.rootDir = rootDir;
    if (frontendDir) importData.frontendDir = frontendDir;
    if (backendDir) importData.backendDir = backendDir;

    // Auto-analyze structure first
    const analyzeDir = rootDir || frontendDir || backendDir;
    const analysis = await api("/api/projects/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
      body: JSON.stringify({ directory: analyzeDir }),
    });

    // Show analysis results
    const content = $("#importAnalysisContent");
    clear(content);
    const addItem = (icon, label, value) => {
      const item = element("div", "analysis-item");
      item.appendChild(element("span", "analysis-icon", icon));
      item.appendChild(element("span", "analysis-label", label));
      item.appendChild(element("span", "analysis-value", value));
      content.appendChild(item);
    };
    if (rootDir) addItem("✓", "项目根目录", rootDir);
    if (analysis.hasFrontend) addItem("✓", "前端目录", analysis.frontendDir || frontendDir);
    if (analysis.hasBackend) addItem("✓", "后端目录", analysis.backendDir || backendDir);
    if (analysis.detectedFrameworks?.frontend) addItem("◈", "前端框架", analysis.detectedFrameworks.frontend);
    if (analysis.detectedFrameworks?.backend) addItem("◈", "后端框架", analysis.detectedFrameworks.backend);
    if (analysis.git) {
      addItem("✓", "Git 分支", analysis.git.branch || "未切换到分支");
      for (const remote of analysis.git.remotes) addItem("◈", "远程仓库", remote.url);
      addItem("◈", "导入方式", "保留仓库历史，在隔离副本中开发；测试发布由管理员配置");
      if (!analysis.git.clean) addItem("!", "未提交修改", "原仓库有未提交修改，请自行保存提交后导入；系统不会替你提交或丢弃修改。");
    }
    if (!analysis.hasFrontend && !analysis.hasBackend) addItem("◈", "项目类型", "单体项目");
    $("#importAnalysis").hidden = false;

    // Disable submit button during import
    const submitBtn = $("#importProjectSubmit");
    submitBtn.disabled = true;
    submitBtn.textContent = "初始化中…";

    try {
      const project = await api("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
        body: JSON.stringify(importData),
      });

      $("#importProjectModal").hidden = true;
      $("#importProjectForm").reset();
      await switchProject(project.id);
      showProjectOverview(project);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "导入并初始化";
    }
  } catch (error) {
    $("#importProjectError").textContent = `导入失败：${error.message}`;
  }
});

function showProjectOverview(project) {
  $("#toggleReferenceBtn").textContent = "查看项目参考文档";
  $("#overviewReference").hidden = true;
  const modal = $("#projectOverviewModal");
  const nameEl = $("#overviewProjectName");
  const pathEl = $("#overviewProjectPath");
  const structureEl = $("#overviewStructure");
  const configEl = $("#overviewConfig");

  nameEl.textContent = `${project.name}（${project.id}）`;
  modal.dataset.projectId = project.id;
  pathEl.textContent = project.projectDir;

  clear(structureEl);
  const structure = project.structure || {};
  const addStructureItem = (icon, label, value) => {
    const item = element("div", "overview-item");
    const row = element("div", "overview-row");
    row.appendChild(element("span", "overview-icon", icon));
    row.appendChild(element("span", "overview-label", label));
    row.appendChild(element("span", "overview-value", value));
    item.appendChild(row);
    structureEl.appendChild(item);
  };

  if (structure.hasFrontend && structure.hasBackend) {
    addStructureItem("📦", "项目类型", "前后端分离");
    addStructureItem("🎨", "前端目录", structure.frontendDir || "-");
    addStructureItem("⚙️", "后端目录", structure.backendDir || "-");
    if (structure.detectedFrameworks?.frontend) {
      addStructureItem("◈", "前端框架", structure.detectedFrameworks.frontend);
    }
    if (structure.detectedFrameworks?.backend) {
      addStructureItem("◈", "后端框架", structure.detectedFrameworks.backend);
    }
  } else if (structure.hasFrontend) {
    addStructureItem("📦", "项目类型", "前端项目");
    if (structure.detectedFrameworks?.frontend) {
      addStructureItem("◈", "框架", structure.detectedFrameworks.frontend);
    }
  } else if (structure.hasBackend) {
    addStructureItem("📦", "项目类型", "后端项目");
    if (structure.detectedFrameworks?.backend) {
      addStructureItem("◈", "框架", structure.detectedFrameworks.backend);
    }
  } else {
    addStructureItem("📦", "项目类型", "单体项目");
  }

  clear(configEl);
  const config = project.config || {};
  const addConfigItem = (label, value) => {
    const item = element("div", "overview-item");
    item.appendChild(element("span", "overview-label", label));
    item.appendChild(element("span", "overview-value", value));
    configEl.appendChild(item);
  };
  addConfigItem("运行模式", config.mode || "local");
  if (config.allowedPaths) {
    addConfigItem("可访问路径", config.allowedPaths.join(", "));
  }
  if (config.excludedPaths) {
    addConfigItem("排除路径", config.excludedPaths.join(", "));
  }

  modal.hidden = false;
}

$("#toggleReferenceBtn").addEventListener("click", async () => {
  const ref = $("#overviewReference");
  if (!ref.hidden) { ref.hidden = true; return; }
  if ($("#projectOverviewModal").dataset.projectId !== state.currentProjectId) {
    $("#overviewReferenceContent").textContent = "请先切换到该项目，再查看项目参考文档。";
    ref.hidden = false;
    return;
  }
  try {
    const data = await api("/api/project-reference");
    $("#overviewReferenceContent").textContent = data.content;
    ref.hidden = false;
    $("#toggleReferenceBtn").textContent = "收起项目参考文档";
  } catch (error) {
    $("#overviewReferenceContent").textContent = `加载失败：${error.message}`;
    ref.hidden = false;
  }
});

$("#overviewClose").addEventListener("click", async () => {
  $("#projectOverviewModal").hidden = true;
  try {
    await establishSession();
  } catch (error) {
    if (error.status === 401) showLogin();
    else { showLogin(); $("#loginError").textContent = error.message; }
  }
});

let projectDocuments = null;
for (const [selector, key] of [["#projectRefDeveloper", "content"], ["#projectRefAgent", "agentContent"]]) {
  $(selector).addEventListener("click", () => {
    if (!projectDocuments) return;
    $("#projectRefContent").textContent = projectDocuments[key];
    for (const id of ["#projectRefDeveloper", "#projectRefAgent"]) {
      $(id).classList.toggle("primary", id === selector);
      $(id).setAttribute("aria-pressed", String(id === selector));
    }
  });
}
$("#projectRefButton").addEventListener("click", async () => {
  projectDocuments = null;
  $("#projectRefAgent").disabled = true;
  $("#projectRefRefresh").hidden = !state.actions.has("audit-report");
  $("#projectRefModal").hidden = false;
  $("#projectRefContent").textContent = "加载中…";
  try {
    if (state.actions.has("audit-report")) {
      const status = await api("/api/project-reference/execution");
      $("#projectRefRefresh").dataset.running = status.execution ? "true" : "false";
      $("#projectRefRefresh").textContent = status.execution ? "暂停文档生成" : "刷新文档";
    }
    const data = await api("/api/project-reference");
    projectDocuments = data;
    $("#projectRefAgent").disabled = typeof data.agentContent !== "string";
    $("#projectRefDeveloper").click();
  } catch (error) {
    $("#projectRefContent").textContent = `加载失败：${error.message}`;
  }
});

$("#projectRefClose").addEventListener("click", () => {
  $("#projectRefModal").hidden = true;
});

$("#projectRefRefresh").addEventListener("click", async () => {
  const button = $("#projectRefRefresh");
  if (button.dataset.running === "true") {
    button.disabled = true;
    try {
      await api("/api/project-reference/execution", { method: "POST", headers: { "X-Reqflow-Token": state.token } });
      button.textContent = "正在保存现场…";
      $("#projectRefContent").textContent = "正在停止模型，保留原文档与本轮记录。";
    } catch (error) { toast(error.message, true); button.disabled = false; }
    return;
  }
  button.dataset.running = "true";
  button.textContent = "暂停文档生成";
  $("#projectRefContent").textContent = "正在重新生成文档…";
  try {
    const data = await api("/api/project-reference/regenerate", {
      method: "POST",
      headers: { "X-Reqflow-Token": state.token },
    });
    if (data.paused) {
      $("#projectRefContent").textContent = "文档生成已暂停，原文档和审计保留。点击刷新文档可继续生成。";
      return;
    }
    projectDocuments = data;
    $("#projectRefAgent").disabled = false;
    $("#projectRefDeveloper").click();
    toast("项目文档已刷新");
  } catch (error) {
    $("#projectRefContent").textContent = `刷新失败：${error.message}`;
  } finally {
    button.dataset.running = "false";
    button.disabled = false;
    button.textContent = "刷新文档";
  }
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#loginError").textContent = "";
  const username = $("#loginUsername").value.trim();
  const password = $("#loginPassword").value;
  const token = $("#loginToken").value.trim();
  try {
    if (username && password) {
      await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, ...(state.currentProjectId ? { projectId: state.currentProjectId } : {}) }), _skip401: true });
    } else if (token) {
      await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(state.currentProjectId ? { projectId: state.currentProjectId } : {}) }), _skip401: true });
    } else {
      $("#loginError").textContent = "请输入用户名和密码，或访问令牌";
      return;
    }
    $("#loginUsername").value = "";
    $("#loginPassword").value = "";
    $("#loginToken").value = "";
    await establishSession();
  } catch (error) { $("#loginError").textContent = error.message; }
});

$("#changePasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#changePasswordError").textContent = "";
  const oldPassword = $("#oldPassword").value;
  const newPassword = $("#newPassword").value;
  const confirmPassword = $("#confirmPassword").value;
  if (newPassword !== confirmPassword) {
    $("#changePasswordError").textContent = "新密码不一致";
    return;
  }
  try {
    await api("/api/change-password", { method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
      body: JSON.stringify({ oldPassword, newPassword }) });
    showLogin();
    toast("密码已修改，旧会话已失效，请重新登录");
  } catch (error) { $("#changePasswordError").textContent = error.message; }
});

$("#adminNavButton").addEventListener("click", async () => {
  if (!state.token) {
    showLogin();
    return;
  }
  $("#loginRoot").hidden = true;
  $("#changePasswordRoot").hidden = true;
  $("#adminRoot").hidden = false;
  await loadUsers();
});

$("#closeAdminButton").addEventListener("click", () => {
  $("#adminRoot").hidden = true;
  if (!state.token) {
    showLogin();
  }
});

$("#refreshUsersButton").addEventListener("click", loadUsers);

const roleLabels = {
  admin: "管理员", product: "产品", developer: "研发",
};

function renderRoleSelector(container, selectedRoles = []) {
  container.innerHTML = "";
  for (const [role, label] of Object.entries(roleLabels)) {
    const item = document.createElement("label");
    item.className = "role-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = role;
    checkbox.checked = selectedRoles.includes(role);
    checkbox.addEventListener("change", () => enforceRoleRules(container));
    item.appendChild(checkbox);
    item.appendChild(document.createTextNode(label));
    container.appendChild(item);
  }
}

function enforceRoleRules(container) {
  const checked = [...container.querySelectorAll("input[type=checkbox]:checked")].map((cb) => cb.value);
  const adminCb = container.querySelector("input[value=admin]");
  if (adminCb.checked && checked.length > 1) {
    for (const cb of container.querySelectorAll("input[type=checkbox]")) {
      if (cb.value !== "admin") cb.checked = false;
    }
    toast("管理员不能兼任其他角色", true);
  }
}

function getSelectedRoles(container) {
  return [...container.querySelectorAll("input[type=checkbox]:checked")].map((cb) => cb.value);
}

$("#addUserButton").addEventListener("click", () => {
  $("#userFormTitle").textContent = "新建用户";
  $("#userForm").reset();
  $("#userFormId").disabled = false;
  $("#userFormPassword").required = true;
  renderRoleSelector($("#roleSelector"));
  $("#userFormModal").hidden = false;
  $("#userFormError").textContent = "";
});

$("#userFormCancel").addEventListener("click", () => {
  $("#userFormModal").hidden = true;
});

$("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#userFormError").textContent = "";
  const id = $("#userFormId").value.trim();
  const username = $("#userFormUsername").value.trim();
  const password = $("#userFormPassword").value;
  const roles = getSelectedRoles($("#roleSelector"));
  if (!roles.length) { $("#userFormError").textContent = "请至少选择一个角色"; return; }
  try {
    await api("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
      body: JSON.stringify({ id, username, password, roles }) });
    $("#userFormModal").hidden = true;
    toast("用户已创建");
    await loadUsers();
  } catch (error) { $("#userFormError").textContent = error.message; }
});

async function loadUsers() {
  try {
    const { users } = await api("/api/admin/users");
    const list = $("#userList");
    clear(list);
    for (const user of users) {
      const row = document.createElement("div");
      row.className = "user-row";
      const info = element("div", "user-info");
      info.appendChild(element("strong", "", user.username));
      info.appendChild(element("small", "", user.id));
      info.appendChild(element("span", "user-roles", user.roles.join(", ")));
      row.appendChild(info);
      const actions = document.createElement("div");
      actions.className = "user-actions";
      const editRolesButton = document.createElement("button");
      editRolesButton.className = "button";
      editRolesButton.textContent = "修改角色";
      editRolesButton.addEventListener("click", () => {
        $("#editRolesUser").textContent = `${user.username}（${user.id}）`;
        renderRoleSelector($("#editRoleSelector"), user.roles);
        $("#editRolesError").textContent = "";
        $("#editRolesModal").hidden = false;
      });
      const resetPasswordButton = document.createElement("button");
      resetPasswordButton.className = "button";
      resetPasswordButton.textContent = "重置密码";
      resetPasswordButton.addEventListener("click", async () => {
        const newPassword = prompt("输入新密码（至少 6 字节）");
        if (newPassword) {
          try {
            await api(`/api/admin/users/${user.id}/password`, { method: "POST", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
              body: JSON.stringify({ password: newPassword }) });
            toast("密码已重置");
          } catch (error) {
            if (error.status === 401) { showLogin(); return; }
            toast(error.message, true);
          }
        }
      });
      actions.appendChild(editRolesButton);
      actions.appendChild(resetPasswordButton);
      row.appendChild(actions);
      list.appendChild(row);
    }
  } catch (error) {
    if (error.status === 401) { showLogin(); return; }
    toast(error.message, true);
  }
}

$("#editRolesCancel").addEventListener("click", () => {
  $("#editRolesModal").hidden = true;
});

$("#editRolesSave").addEventListener("click", async () => {
  const roles = getSelectedRoles($("#editRoleSelector"));
  if (!roles.length) { $("#editRolesError").textContent = "请至少选择一个角色"; return; }
  try {
    const userId = $("#editRolesUser").textContent.match(/（(.+?)）/)?.[1];
    await api(`/api/admin/users/${userId}/roles`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Reqflow-Token": state.token },
      body: JSON.stringify({ roles }) });
    $("#editRolesModal").hidden = true;
    toast("角色已更新");
    await loadUsers();
  } catch (error) {
    if (error.status === 401) { showLogin(); return; }
    $("#editRolesError").textContent = error.message;
  }
});

$("#loginButton").addEventListener("click", () => {
  $("#loginRoot").hidden = false;
});

$("#logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", headers: { "X-Reqflow-Token": state.token } });
  } catch (error) {
    if (error.status !== 401) { toast(`退出失败：${error.message}`, true); return; }
  }
  showLogin();
});

establishSession().catch((error) => {
  if (error.status === 401) showLogin();
  else { showLogin(); $("#loginError").textContent = error.message; }
});

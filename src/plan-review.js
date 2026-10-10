import path from "node:path";
import { describePolicy, loadProject } from "./config.js";
import { manifestHash, sha256 } from "./files.js";
import { appendEvent, readTask, taskPath, withLock } from "./store.js";
import { readPlanAnalysis } from "./plan-analysis.js";
import { planReviewHash } from "./design-document.js";
import { sourceManifest } from "./workspace.js";

export function planReviewStatus(meta, draft) {
  if (meta.developmentTeam?.mode !== "split") return { mode: "single", ready: true, parts: [] };
  if (draft.schemaVersion !== 2) throw new Error("前后端分工审核需要包含完整设计说明的新方案。");
  const parts = ["frontend", "backend"].filter(role => draft.domains.includes(role)).map(role => {
    const assignment = meta.assignments[role];
    const scopeHash = planReviewHash(meta, draft, role);
    const approval = meta.planPartApprovals?.[role];
    const approved = assignment?.status === "accepted" && approval?.actor === assignment.userId && approval.scopeHash === scopeHash;
    return { role, userId: assignment?.userId ?? null, accepted: assignment?.status === "accepted", scopeHash,
      approved, approval: approved ? approval : null };
  });
  return { mode: "split", parts, ready: parts.every(part => part.approved) };
}

export async function reviewPlanPart(projectPath, id, actor, input) {
  if (!["frontend", "backend"].includes(input.part) || !/^[a-f0-9]{64}$/.test(input.expectedPlanHash ?? "")) throw new Error("请确认当前方案版本和你的审核职责。");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta, directory } = await readTask(project, id);
    if (meta.state !== "plan_review" || meta.planHash !== input.expectedPlanHash) throw new Error("方案已改变或当前不是审核阶段，请刷新后查看。");
    const analysis = await readPlanAnalysis(meta, directory);
    if (!analysis.admission.eligible || analysis.blockers.length) throw new Error("请先解决方案中的具体问题，再确认审核。");
    if (describePolicy(project.config).executionConfigHash !== meta.configHash) throw new Error("项目执行规则已改变，请重新核对方案。");
    if (manifestHash(await sourceManifest(project)) !== meta.baseHash) throw new Error("项目源码已改变，请重新核对方案再审核。");
    const part = planReviewStatus(meta, analysis.draft).parts.find(part => part.role === input.part);
    if (!part || !part.accepted || part.userId !== actor) throw new Error("只能确认自己已接单的前端或后端部分及共同接口。");
    const approval = { actor, scopeHash: part.scopeHash, planHash: meta.planHash, planVersion: meta.planVersion, at: new Date().toISOString() };
    const next = { ...meta, planPartApprovals: { ...meta.planPartApprovals, [input.part]: approval }, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "plan_part_approved", next, { actor, part: input.part, ...approval });
    return { ...next, reviewStatus: planReviewStatus(next, analysis.draft) };
  });
}

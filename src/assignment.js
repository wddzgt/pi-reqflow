import path from "node:path";
import { loadCredentials } from "./auth.js";
import { loadProject } from "./config.js";
import { safeId } from "./files.js";
import { appendEvent, readTask, taskPath, withLock } from "./store.js";

export const assignableRoles = new Set(["developer", "frontend", "backend"]);

export async function assignDevelopmentTeam(projectPath, id, actor, input) {
  if (!input || !["single", "split"].includes(input.mode)
      || Object.keys(input).some(key => !["mode", "lead", "frontend", "backend"].includes(key))) throw new Error("请选择全栈负责或前后端分工，并指定交付负责人。");
  safeId(input.lead);
  if (input.mode === "split") { safeId(input.frontend); safeId(input.backend);
    if (input.frontend === input.backend) throw new Error("同一人负责前后端时请选择全栈负责模式。");
    if (![input.frontend, input.backend].includes(input.lead)) throw new Error("交付负责人应由前端或后端负责人兼任。");
  } else if (input.frontend !== undefined || input.backend !== undefined) throw new Error("全栈负责模式只指定一名研发。");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta } = await readTask(project, id);
    if (meta.createdBy !== actor) throw new Error("Only the product owner can assign members");
    if (!["intake_draft", "assignment_pending", "contract_confirmed"].includes(meta.state)) throw new Error("请在需求定版后、方案设计前指定研发分工。");
    const credentials = await loadCredentials(project);
    const selected = input.mode === "single" ? { developer: input.lead } : { developer: input.lead, frontend: input.frontend, backend: input.backend };
    for (const memberId of Object.values(selected)) {
      if (!credentials.users.some(user => user.id === memberId && user.roles.includes("developer"))) throw new Error(`研发成员不存在或没有研发权限：${memberId}`);
    }
    const assignments = {};
    for (const [role, userId] of Object.entries(selected)) {
      const prior = meta.assignments?.[role];
      assignments[role] = prior?.userId === userId && prior.status === "accepted" ? prior
        : { userId, status: "pending", assignedBy: actor, assignedAt: new Date().toISOString() };
    }
    const ready = Object.values(assignments).every(row => row.status === "accepted");
    const next = { ...meta, assignments, developmentTeam: { mode: input.mode }, planPartApprovals: {},
      state: ready ? meta.contractVersion ? "contract_confirmed" : "intake_assigned" : "assignment_pending",
      updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "development_team_assigned", next, { actor, mode: input.mode, members: selected });
    return next;
  });
}

export async function assignMember(projectPath, id, actor, role, memberId) {
  safeId(actor); safeId(memberId);
  if (!assignableRoles.has(role)) throw new Error(`Role cannot be assigned: ${role}`);
  if (role !== "developer") throw new Error("前后端职责请使用团队指派，账号权限仍为研发。");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta } = await readTask(project, id);
    if (meta.createdBy !== actor) throw new Error("Only the product owner can assign members");
    if (["archived", "archived_test_only", "rolled_back"].includes(meta.state)) throw new Error("Completed tasks cannot be assigned");
    if (!["intake_draft", "assignment_pending", "contract_confirmed"].includes(meta.state)) {
      throw new Error("Assign a developer before manual feedback or after product contract finalization");
    }
    if (meta.assignments?.[role]?.status === "accepted") throw new Error(`Accepted ${role} assignment cannot be replaced`);
    const credentials = await loadCredentials(project);
    const member = credentials.users.find((user) => user.id === memberId);
    if (!member || !member.roles.includes("developer")) throw new Error(`Registered member ${memberId} lacks role developer`);
    if (meta.developmentTeam?.mode === "split") throw new Error("前后端分工需求请通过团队指派一起调整负责人。");
    const assignment = { userId: memberId, status: "pending", assignedBy: actor, assignedAt: new Date().toISOString() };
    const next = { ...meta, state: "assignment_pending",
      assignments: { ...meta.assignments, [role]: assignment }, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, "member_assigned", next, { actor, role, memberId });
    return next;
  });
}

export async function respondToAssignment(projectPath, id, actor, role, accepted) {
  safeId(actor);
  if (!assignableRoles.has(role)) throw new Error(`Role cannot respond to assignment: ${role}`);
  if (typeof accepted !== "boolean") throw new Error("Assignment response must be explicit");
  const project = await loadProject(projectPath);
  return withLock(path.join(taskPath(project, id), "task.lock"), async () => {
    const { meta } = await readTask(project, id);
    if (["archived", "archived_test_only", "rolled_back"].includes(meta.state)) {
      throw new Error("Completed tasks cannot accept assignment changes");
    }
    const current = meta.assignments?.[role];
    if (!current || current.userId !== actor || current.status !== "pending") {
      throw new Error("No pending assignment for this member and role");
    }
    if (meta.state !== "assignment_pending") {
      throw new Error(`Developer assignment is incompatible with ${meta.state}`);
    }
    const assignments = { ...meta.assignments };
    const roles = meta.developmentTeam?.mode === "split" ? Object.keys(assignments).filter(key => assignments[key].userId === actor && assignments[key].status === "pending") : [role];
    for (const key of roles) assignments[key] = { ...assignments[key], status: accepted ? "accepted" : "declined", respondedAt: new Date().toISOString() };
    const ready = Object.values(assignments).every(assignment => assignment.status === "accepted");
    const next = { ...meta, state: ready ? meta.contractVersion ? "contract_confirmed" : "intake_assigned"
      : meta.developmentTeam?.mode === "split" ? "assignment_pending" : "intake_draft",
      assignments, updatedAt: new Date().toISOString() };
    await appendEvent(project, id, accepted ? "assignment_accepted" : "assignment_declined", next,
      { actor, role, responsibilities: roles, memberId: actor });
    return next;
  });
}

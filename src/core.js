import path from "node:path";
import { authorize, authorizeTaskRead, canReadTask } from "./auth.js";
import { loadProject } from "./config.js";
import { readJson } from "./files.js";
import { createTask, readTask } from "./store.js";
import { auditReport, authHistoryPage, taskHistory, taskLifecycle, taskObservability } from "./report.js";

export { executeRequirementAction } from "./actions.js";
export { registerDeploymentAdapter } from "./deployment-adapters.js";
export { getRequirementEvidence, getChangedFile, getRequirementImage } from "./evidence.js";

export async function createRequirement(projectPath, principal, input) {
  authorize(principal, "new");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Requirement input must be an object");
  const project = await loadProject(projectPath);
  return createTask(project, input.id, input.title, input.request, principal.id, input.images === undefined ? [] : input.images);
}

export async function listRequirements(projectPath, principal, offset = 0, limit = 50) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Pagination requires offset >= 0 and limit between 1 and 100");
  }
  const project = await loadProject(projectPath);
  const index = await readJson(path.join(project.archive, "index.json"));
  if (!Array.isArray(index)) throw new Error("Task index is invalid");
  const rows = index.filter((row) => canReadTask(principal, row));
  return { total: rows.length, offset, limit, tasks: rows.slice(offset, offset + limit) };
}

export async function getRequirement(projectPath, principal, id) {
  const project = await loadProject(projectPath);
  const task = await readTask(project, id);
  authorizeTaskRead(principal, task.meta);
  return task;
}

export async function getAuditReport(projectPath, principal, offset = 0, limit = 50, filters = {}) {
  authorize(principal, "audit-report");
  return auditReport(await loadProject(projectPath), offset, limit, filters);
}

export async function getRequirementLifecycle(projectPath, principal, id, offset = 0, limit = 50) {
  const project = await loadProject(projectPath);
  const task = await readTask(project, id);
  authorizeTaskRead(principal, task.meta);
  return taskLifecycle(task, offset, limit);
}

export async function getTaskHistory(projectPath, principal, id, offset = 0, limit = 100) {
  authorize(principal, "history");
  return taskHistory(await loadProject(projectPath), id, offset, limit);
}

export async function getTaskObservability(projectPath, principal, id, offset = 0, limit = 100) {
  const project = await loadProject(projectPath);
  const task = await readTask(project, id);
  authorizeTaskRead(principal, task.meta);
  return taskObservability(task, offset, limit);
}

export async function getAuthenticationHistory(projectPath, principal, offset = 0, limit = 100) {
  authorize(principal, "auth-history");
  return authHistoryPage(await loadProject(projectPath), offset, limit);
}

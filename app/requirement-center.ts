import type { Principal, Project } from './types.js';
import { listTaskSummaries, type TaskSummaryData } from './tasks.js';
import { settings } from './projects.js';
import { projectPolicy } from './project-sources.js';
import { status } from './flow.js';
import { listUsers } from './accounts.js';
import { readProjectMap } from './project-context.js';
import { readProjectKnowledge } from './project-knowledge.js';

type Prerequisites = { available: true; policyHash: string; initialized: boolean } | { available: false; error: string };
function taskSummary(project: Project, task: TaskSummaryData, actor: Principal, context: Prerequisites) {
  let responsibility: 'product' | 'developer' | null = null, nextAction: string;
  if (status(project, task.id)) nextAction = '执行中，等待结果';
  else if (task.applicationPending) { responsibility = 'developer'; nextAction = '核对并恢复或回滚写入'; }
  else if (task.state === 'done') nextAction = '已完成';
  else if (!context.available) { responsibility = task.confirmed ? 'developer' : 'product'; nextAction = '执行前提不可读取，请联系管理员'; }
  else if (!task.confirmed) {
    responsibility = 'product'; nextAction = task.hasDecisions ? '处理业务确认项' : task.hasQuestions ? '回答需求问题' : '完善并确认需求';
  } else if (task.approvedPolicyHash !== null && task.approvedPolicyHash !== context.policyHash) {
    responsibility = 'developer'; nextAction = '重新确认执行设置并验证';
  } else if (task.state === 'ready') {
    responsibility = 'product'; nextAction = '验收或退回';
  } else if (task.state === 'accepted') {
    responsibility = 'developer'; nextAction = '核对并应用代码';
  } else {
    responsibility = 'developer'; nextAction = !context.initialized ? '完成项目初始化'
      : task.state === 'queued' || task.approvedPolicyHash === null ? '确认开工' : '核查停止原因并继续';
  }
  const responsibleId = responsibility === 'product' ? task.owner : responsibility === 'developer' ? task.developer : null;
  return { id: task.id, projectId: project.id, projectName: project.name, title: task.title, state: task.state,
    owner: task.owner, developer: task.developer, version: task.version, updatedAt: task.updatedAt,
    responsibleId, responsibility, nextAction,
    mine: responsibleId === actor.id && responsibility !== null && (actor.roles.includes(responsibility) || actor.roles.includes('admin')) };
}

export type CenterRow = ReturnType<typeof taskSummary> & { ownerName: string; developerName: string | null; responsibleName: string | null };
export async function centerRows(projects: Project[], actor: Principal, view: string, recent: Array<{ id: string; projectId: string }>) {
  if (!['mine', 'active', 'all'].includes(view)) throw new Error('需求视图无效');
  const rows: CenterRow[] = [];
  const failures: Array<{ projectId: string; projectName: string; error: string }> = [];
  let rebuilt = 0;
  for (const project of projects) {
    try {
    const indexed = await listTaskSummaries(project, actor); rebuilt += indexed.rebuilt;
    const tasks = indexed.tasks;
    if (!tasks.length) continue;
    const people = await listUsers(project);
    let context: Prerequisites;
    try {
      const config = await settings(project);
      context = { available: true, policyHash: projectPolicy(project, config),
        initialized: await readProjectMap(project) !== null && await readProjectKnowledge(project) !== null };
    } catch (error: any) {
      context = { available: false, error: error.message };
      failures.push({ projectId: project.id, projectName: project.name, error: '执行前提不可读取：' + error.message });
    }
    for (const task of tasks) {
      const row = taskSummary(project, task, actor, context);
      const name = (id: string) => {
        const person = people.find(user => user.id === id);
        if (!person) throw new Error('需求负责人已不在项目账号来源中，请核查人员记录');
        return person.username;
      };
      rows.push({ ...row, ownerName: name(task.owner), developerName: task.developer === null ? null : name(task.developer),
        responsibleName: row.responsibleId === null ? null : name(row.responsibleId) });
    }
    } catch (error: any) { failures.push({ projectId: project.id, projectName: project.name, error: error.message }); }
  }
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id));
  const authorizedRecent: CenterRow[] = [];
  for (const item of recent) {
    const row = rows.find(row => row.id === item.id && row.projectId === item.projectId);
    if (row) authorizedRecent.push(row);
  }
  return { tasks: rows.filter(row => view === 'all' || (view === 'mine' ? row.mine : row.state !== 'done')),
    recent: authorizedRecent, removedRecent: recent.length - authorizedRecent.length, failures, rebuilt };
}

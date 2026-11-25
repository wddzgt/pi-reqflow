import type { Task, ExecutionPhase } from './types.js';
export function taskPresentation(task: Task, execution: { phase: ExecutionPhase | 'external' } | null, policyChanged: boolean, applying = false) {
  const labels = { preparing: '正在准备执行', requirement: '正在整理需求', development: '正在修改代码',
    unit: '正在运行单元测试', review: '正在独立审核代码', repair: '正在修复已发现的问题',
    draft: '等待产品完善需求', queued: '等待研发开工', ready: '等待产品验收', accepted: '等待研发应用',
    done: '已完成验收并应用', stopped: '执行已停止，需要处理' };
  if (task.application?.phase === 'pending') return { phase: 'stopped',
    label: applying ? task.application.direction === 'apply' ? '正在应用代码' : '正在回滚代码' : '代码写入未完成，待具名处理',
    next: applying ? '正在按已验收计划逐文件处理，请等待。' : '研发核对已写入与待核对清单，选择恢复或回滚；不能重新开工。' };
  if (policyChanged && task.state !== 'done') return { phase: 'stopped', label: '执行设置已改变', next: '研发重新确认执行设置并验证；原代码与需求保留。' };
  if (execution?.phase === 'external') return { phase: execution.phase, label: '另一工作台实例正在执行', next: '请在启动执行的工作台实例查看实时进展或暂停。' };
  if (execution) return { phase: execution.phase, label: labels[execution.phase], next: execution.phase === 'requirement' ? 'Pi 正在整理需求，完成后由产品确认。' : '研发执行中；产品可查看进展，无需重复提交。' };
  if (task.state === 'attention' && task.halt === 'rejected') {
    if (!task.feedback) throw new Error('产品退回记录缺少具体验收意见');
    return { phase: 'stopped', label: '产品退回，等待研发处理',
      next: `研发根据验收意见修复：${task.feedback.slice(0, 300)}${task.feedback.length > 300 ? '…完整意见见技术记录。' : ''}` };
  }
  if (task.state === 'attention' && ['review_incomplete', 'review_evidence'].includes(task.halt!)) {
    if (!task.failure) throw new Error('审核停止记录缺少具体原因');
    return { phase: 'stopped', label: task.halt === 'review_evidence' ? '审核等待补充材料' : '审核未完成',
      next: task.failure.slice(0, 300) + (task.failure.length > 300 ? '…完整原因见技术记录。' : '') + '研发先处理原因或补齐材料，不自动重跑。' };
  }
  if (task.failure || task.state === 'running' || task.state === 'attention') {
    const label = task.halt === 'paused' ? '已暂停，现场保留' : task.halt === 'timeout' ? '执行时限已到，现场保留' : task.halt === 'budget' ? '执行预算已到上限，现场保留' : labels.stopped;
    return { phase: 'stopped', label, next: task.approval ? '研发查看技术记录核查停止原因，再从当前现场继续。' : '产品查看需求提问及确认事项；停止原因可在技术记录中核查。' };
  }
  const next = { draft: '产品完善需求并指定研发负责人。', queued: '研发查看需求并确认开工。',
    ready: '产品核对验收条件，验收或提供退回原因。', accepted: '研发检查代码差异并应用到项目。', done: '已完成；如需恢复本次源码变更，由研发执行回滚。' };
  return { phase: task.state, label: labels[task.state], next: next[task.state] };
}

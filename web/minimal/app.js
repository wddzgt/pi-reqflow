import { updateRecordTask, closeRecordPanel } from './records.js';
import { centerRequest, renderCenter, wireCenter, configureCenter, resetCenter, centerError,
  centerCreationProject, rememberCenterPosition, restoreCenterPosition, restartCenterQuery } from './center.js';
const $ = id => document.getElementById(id);
let csrf, session, selected, current, timer, dirty = false, cardRevision, settings, people = [];
let editing = false, rejectOpen = false, assigneeDirty = false, renderedCard = null, syncing = false, activeCall = false, generation = 0, listRequest = 0, listKey = '';
let implementationEditing = false, implementationDirty = false, implementationRevision = null, implementationRequirementRevision, renderedImplementation = null;
let projectMap = null;
let activeProject = null;
let sourceInfo = null;
let settingsProblem = null;
let rollbackTarget = null;
let opening = false;
let creating = false, createEpoch = 0;
let messageSending = false;
const recentTasks = [];
const retainedDrafts = new Map();
let projectKnowledge = null, knowledgeJob = null, contextTimer, selectedKnowledgeModule = null, knowledgeKey = '', scopeDirty = false, initializationBudgetDirty = false;
const labels = { draft: '产品完善需求', queued: '待研发开工', running: '研发实现与验证中', ready: '待产品验收', accepted: '待研发应用', done: '已验收并应用', attention: '需要处理' };
const taskStages = ['requirement', 'development', 'verification', 'delivery'];
const stagePositions = new Map();
let actualStage = null, shownStage = null, followStage = true;
const UNRESOLVED_RESOLUTIONS = ['open', 'pending'];
const isUnresolved = item => UNRESOLVED_RESOLUTIONS.includes(item.resolution);
let clarificationKey = '', decisionDrafts = {}, decisionsBusy = false, decisionRevision = null, decisionKey = '', decisionDismissed = '', decisionLimit = 3, decisionRegenerated = false;
const shots = { create: [], answers: [] };
const shotLimits = { count: 0, bytes: 0, totalBytes: 0 };
const formatBytes = value => value >= 1024 * 1024 ? `${Math.round(value / 1024 / 1024)}MB` : `${Math.round(value / 1024)}KB`;
function renderShotLimits() {
  const text = `，最多 ${shotLimits.count} 张，单张 ≤${formatBytes(shotLimits.bytes)}、总计 ≤${formatBytes(shotLimits.totalBytes)}`;
  for (const node of document.querySelectorAll('.shot-limit')) node.textContent = text;
}
function readShot(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error(`无法读取图片 ${file.name}`));
    reader.readAsDataURL(file);
  });
}
async function addShots(target, files) {
  const list = [...files];
  if (!list.length) return;
  for (const file of list) {
    if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error(`${file.name} 不是 PNG/JPEG 截图`);
    if (file.size > shotLimits.bytes) throw new Error(`${file.name} 超过单张 ${formatBytes(shotLimits.bytes)} 限制`);
  }
  if (shots[target].length + list.length > shotLimits.count) throw new Error(`每次最多上传 ${shotLimits.count} 张截图`);
  const total = shots[target].reduce((sum, shot) => sum + shot.bytes, 0) + list.reduce((sum, file) => sum + file.size, 0);
  if (total > shotLimits.totalBytes) throw new Error(`截图总大小超过 ${formatBytes(shotLimits.totalBytes)}`);
  for (const file of list) shots[target].push({ name: file.name, mimeType: file.type, bytes: file.size,
    data: await readShot(file), url: URL.createObjectURL(file) });
  renderShots(target);
}
const shotAreas = { create: 'create-shots', answers: 'clarification-shots' };
function renderShots(target) {
  const list = $(shotAreas[target] + '-list');
  if (!list) return;
  list.replaceChildren();
  shots[target].forEach((shot, index) => {
    const node = document.createElement('div'); node.className = 'shot';
    const image = document.createElement('img'); image.src = shot.url; image.alt = shot.name;
    const name = document.createElement('span'); name.textContent = shot.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
    remove.onclick = () => { URL.revokeObjectURL(shot.url); shots[target].splice(index, 1); renderShots(target); };
    node.append(image, name, remove); list.append(node);
  });
}
function wireShots(target, pick, input, zone) {
  $(pick).onclick = () => $(input).click();
  $(input).onchange = perform(async () => { await addShots(target, $(input).files); $(input).value = ''; });
  if (!zone) return;
  const area = $(zone);
  area.addEventListener('dragover', event => { event.preventDefault(); area.classList.add('dragging'); });
  area.addEventListener('dragleave', () => area.classList.remove('dragging'));
  area.addEventListener('drop', perform(async event => {
    event.preventDefault(); area.classList.remove('dragging');
    await addShots(target, event.dataTransfer.files);
  }));
}
function clearShots(target) { for (const shot of shots[target]) URL.revokeObjectURL(shot.url); shots[target] = []; renderShots(target); }
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text;
  for (const name of ['settings', 'users', 'import', 'directory', 'create', 'context']) if ($(name + '-dialog').open) { $(name + '-status').textContent = text; $(name + '-status').hidden = !text; } }
function invalidateTaskView() {
  if (selected && (dirty || implementationDirty)) retainedDrafts.set(activeProject + ':' + selected, {
    card: dirty ? $('card').value : null, cardRevision,
    implementation: implementationDirty ? $('implementation-content').value : null,
    implementationRevision, implementationRequirementRevision });
  selected = null; current = null; dirty = false; implementationDirty = false; editing = false; implementationEditing = false;
  recentTasks.length = 0; $('task-list').replaceChildren(); closeRecordPanel();
  $('application-dialog').close(); $('rollback-dialog').close(); rollbackTarget = null; $('application-summary').hidden = true;
  for (const id of ['application-files', 'application-version', 'application-status', 'application-pending', 'rollback-target']) $(id).replaceChildren();
  $('task').hidden = true; $('empty').hidden = false;
  $('card').value = ''; $('implementation-content').value = ''; $('message').value = '';
  for (const id of ['task-title', 'card-preview', 'implementation-preview', 'history']) $(id).replaceChildren();
}
async function api(route, data, method, projectId = activeProject) {
  const epoch = generation;
  const url = new URL('/api' + route, location.origin);
  if (!['/catalog', '/login', '/bootstrap', '/logout', '/password', '/project', '/center'].includes(url.pathname.slice(4))) {
    if (opening && data) throw new Error('需求正在切换，请等待详情加载完成后再操作。');
    if (!projectId) throw new Error('请明确选择操作的项目');
    url.searchParams.set('projectId', projectId);
  }
  const response = await fetch(url, { method: method || (data ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Reqflow-Token': csrf } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && epoch === generation) {
    clearTimeout(timer); clearTimeout(contextTimer); generation++;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    $('login').hidden = false; $('workspace').hidden = true; $('account').hidden = true;
  }
    const error = Object.assign(new Error(result.error), { status: response.status, code: result.code });
    if ([403, 404, 410].includes(response.status) && !data && epoch === generation && url.pathname === '/api/tasks/' + selected) {
      invalidateTaskView(); centerError(error);
    }
    throw error;
  }
  return result;
}
function perform(fn) { return async event => { event?.preventDefault(); notice(''); try { await fn(event); } catch (error) { notice(error.message); } }; }
function option(parent, id, name) { const node = document.createElement('option'); node.value = id; node.textContent = name; parent.append(node); }
async function boot() {
  closeRecordPanel();
  clearTimeout(timer); generation++; listKey = ''; opening = false;
  const catalog = await api('/catalog'); $('login-project').replaceChildren();
  for (const project of catalog.projects) option($('login-project'), project.id, project.name);
  let nextSession;
  try { nextSession = await api('/bootstrap'); } catch (error) { if ($('login').hidden) throw error; return; }
  if (session?.contextKey !== nextSession.contextKey) {
    retainedDrafts.clear();
    resetCenter();
    recentTasks.length = 0; activeProject = null; selected = null; current = null; people = []; settings = null; sourceInfo = null;
    dirty = false; editing = false; implementationDirty = false; implementationEditing = false; assigneeDirty = false; settingsProblem = null; rollbackTarget = null;
    $('card').value = ''; $('implementation-content').value = ''; $('task').hidden = true; $('empty').hidden = false;
    for (const id of ['task-list', 'center-rows', 'center-range', 'center-owners', 'center-developers', 'history', 'card-preview', 'implementation-preview', 'task-title',
      'new-project', 'users-list', 'providers', 'settings-sources', 'unit-checks', 'application-files', 'application-version', 'application-status', 'application-pending', 'rollback-target', 'context-sources', 'context-files', 'context-detail', 'context-documents', 'decisions-list', 'records-content', 'records-results']) $(id).replaceChildren();
    for (const id of ['knowledge-summary', 'knowledge-vocabulary', 'knowledge-modules', 'knowledge-detail',
      'knowledge-progress', 'knowledge-usage', 'knowledge-failure', 'knowledge-budget', 'context-index-status', 'context-results']) $(id).replaceChildren();
    $('center-status').textContent = '正在读取当前身份的需求…';
    $('new-task').hidden = true; $('empty-new').hidden = true;
    $('sync-status').textContent = '正在同步…'; $('sync-status').classList.remove('sync-error');
    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.close(); for (const form of dialog.querySelectorAll('form')) form.reset();
    }
    projectMap = null; projectKnowledge = null; knowledgeJob = null; selectedKnowledgeModule = null; knowledgeKey = ''; scopeDirty = false; initializationBudgetDirty = false;
    clearShots('create'); clearShots('answers');
  }
  session = nextSession;
  if (session.imageLimits) Object.assign(shotLimits, session.imageLimits);
  if (session.clarificationLimit) decisionLimit = session.clarificationLimit;
  renderShotLimits();
  csrf = session.token; $('login').hidden = true; $('workspace').hidden = false;
  $('account').hidden = false;
  $('password-close').disabled = !!session.principal.mustChangePassword;
  $('password-close').title = session.principal.mustChangePassword ? '请先修改临时密码' : '关闭';
  if (session.principal.mustChangePassword) { $('password-dialog').showModal(); return; }
  $('users-toggle').hidden = !session.principal.roles.includes('admin');
  $('import-toggle').hidden = !session.principal.roles.includes('admin') || !session.projectImport;
  $('identity').textContent = session.principal.username || session.principal.id;
  $('project').replaceChildren(); for (const project of session.projects) option($('project'), project.id, project.name);
  if (!activeProject) activeProject = session.project.id;
  $('project').value = activeProject; configureCenter(session.projects); await loadSettings();
  await refreshList(); await history(); scheduleSync(5000);
}
async function refreshList() {
  const request = ++listRequest, epoch = generation;
  const params = centerRequest(recentTasks);
  if (params === null) return [];
  let data;
  try { data = await api('/center?' + params); }
  catch (error) {
    if (epoch === generation && request === listRequest) {
      const invalidate = centerError(error);
      if ([403, 409, 503].includes(error.status)) { recentTasks.length = 0; $('task-list').replaceChildren(); }
      if (invalidate) invalidateTaskView();
    }
    throw error;
  }
  const { tasks, recent, removedRecent } = data;
  if (epoch !== generation || request !== listRequest) return null;
  recentTasks.splice(0, recentTasks.length, ...recent);
  if (removedRecent) notice('部分最近访问的需求已不可访问，已移除对应入口。');
  renderCenter(data, labels, (id, projectId) => perform(() => open(id, projectId))());
  const key = JSON.stringify([selected, activeProject, recentTasks]);
  if (key === listKey) return tasks;
  listKey = key; $('task-list').replaceChildren();
  for (const task of recentTasks) {
    const button = document.createElement('button'); button.classList.toggle('selected', task.id === selected && task.projectId === activeProject);
    const title = document.createElement('span'); title.textContent = task.title;
    const state = document.createElement('small'); state.textContent = task.projectName;
    button.append(title, state); button.onclick = perform(() => open(task.id, task.projectId)); $('task-list').append(button);
  }
  return tasks;
}
function inlineContent(parent, value) {
  for (const part of value.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
    const kind = part.startsWith('`') ? 'code' : part.startsWith('**') ? 'strong' : null;
    const node = kind ? document.createElement(kind) : document.createTextNode(part);
    if (kind) node.textContent = part.slice(kind === 'code' ? 1 : 2, kind === 'code' ? -1 : -2);
    parent.append(node);
  }
}
function renderDocument(value, target) {
  const fragment = document.createDocumentFragment(); let list = null, codeBlock = null;
  let fenced = false;
  const lines = value.split('\n').flatMap(line => {
    if (line.trim().startsWith('```')) fenced = !fenced;
    return fenced ? [line] : line.replace(/([。；])(?=(?:目标|范围|验收|实现方向|不做事项|保持不变)[：:])/g, '$1\n\n').split('\n');
  });
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('```')) {
      if (codeBlock) codeBlock = null;
      else { const pre = document.createElement('pre'); codeBlock = document.createElement('code'); pre.append(codeBlock); fragment.append(pre); }
      list = null; continue;
    }
    if (codeBlock) { codeBlock.append(document.createTextNode(line + '\n')); continue; }
    if (!text) { list = null; continue; }
    const heading = text.match(/^#{1,6}\s+(.+)$/);
    const section = text.match(/^(目标|范围|验收|实现方向|不做事项|保持不变|约束)[：:]\s*(.*)$/);
    if (heading || section) {
      list = null; const node = document.createElement('h3'); inlineContent(node, heading ? heading[1] : section[1]); fragment.append(node);
      if (section?.[2]) { const p = document.createElement('p'); inlineContent(p, section[2]); fragment.append(p); }
      continue;
    }
    const item = text.match(/^(?:([-*])|(\d+)[.、)])\s+(.+)$/);
    if (item) {
      const tag = item[1] ? 'UL' : 'OL';
      if (!list || list.tagName !== tag) { list = document.createElement(tag.toLowerCase()); fragment.append(list); }
      const node = document.createElement('li'); if (item[2]) node.value = Number(item[2]); inlineContent(node, item[3]); list.append(node);
    } else { list = null; const p = document.createElement('p'); inlineContent(p, text); fragment.append(p); }
  }
  target.replaceChildren(fragment);
}
function scheduleSync(delay) {
  clearTimeout(timer); const epoch = generation;
  if (!$('workspace').hidden && !document.hidden) timer = setTimeout(() => syncWorkspace(epoch), delay);
}
async function syncWorkspace(epoch) {
  if (epoch !== generation || $('workspace').hidden || document.hidden) return;
  if (syncing) { scheduleSync(1000); return; }
  syncing = true;
  try {
    const tasks = await refreshList();
    if (!tasks || epoch !== generation) return;
    await loadSettings();
    if (epoch !== generation) return;
    if (selected) await refresh();
    $('sync-status').textContent = '自动同步'; $('sync-status').classList.remove('sync-error');
  } catch (error) {
    $('sync-status').textContent = '同步中断'; $('sync-status').classList.add('sync-error');
    notice('协作进展同步失败：' + error.message);
  } finally {
    syncing = false;
    if (epoch === generation) scheduleSync(activeCall ? 1500 : 5000);
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else scheduleSync(0); });
async function history() {
  const projectId = activeProject, epoch = generation;
  const data = await api('/history');
  if (projectId !== activeProject || epoch !== generation) return;
  $('history').replaceChildren();
  for (const item of data.history) { const link = document.createElement('a'); link.href = '/api/history/' + encodeURIComponent(item.id) + '?projectId=' + encodeURIComponent(activeProject); link.textContent = item.title + ' · 下载审计'; $('history').append(link); }
}
function taskStage(data) {
  const { task, execution } = data;
  if (task.application?.phase === 'pending' || task.state === 'done') return 'delivery';
  if (task.state === 'draft') return 'requirement';
  if (!execution && !task.haltPhase && task.state === 'attention' && task.application?.direction === 'rollback') return 'delivery';
  if (data.policyChanged) return 'development';
  if (execution) return ['unit', 'review'].includes(execution.phase) ? 'verification' : 'development';
  if (['ready', 'accepted'].includes(task.state) || task.halt === 'rejected') return 'delivery';
  if (task.state === 'attention' && task.haltPhase) return ['unit', 'review'].includes(task.haltPhase) ? 'verification' : 'development';
  if (task.state === 'attention' && (['review_incomplete', 'review_evidence'].includes(task.halt)
    || data.importedReview && !task.approval && task.halt === 'paused' || task.check && task.check.code !== 0
    || data.review?.current && task.issues.length || task.check?.code === 0 && !data.review)) return 'verification';
  return task.confirmation ? 'development' : 'requirement';
}
function rememberStagePosition() {
  if (shownStage && !$('task').hidden) stagePositions.set(shownStage, Math.max(0, -$('task').getBoundingClientRect().top));
}
function restoreStagePosition() {
  if (!$('task').hidden) window.scrollTo(0, window.scrollY + $('task').getBoundingClientRect().top + (stagePositions.get(shownStage) ?? 0));
}
function showStage(stage) {
  const changed = shownStage !== stage;
  if (changed) rememberStagePosition();
  shownStage = stage;
  for (const name of taskStages) {
    const tab = $('tab-' + name), selected = name === stage;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    if (name === actualStage) tab.setAttribute('aria-current', 'step');
    else tab.removeAttribute('aria-current');
    $('stage-' + name).hidden = !selected;
  }
  $('current-stage').hidden = stage === actualStage;
  if (changed) restoreStagePosition();
}
function selectStage(stage) {
  followStage = stage === actualStage;
  showStage(stage);
  $('tab-' + stage).focus({ preventScroll: true });
}
async function open(id, projectId = activeProject) {
  rememberCenterPosition();
  if (id === selected && projectId === activeProject && current) {
    $('empty').hidden = true; $('task').hidden = false; $('task-title').focus({ preventScroll: true }); restoreStagePosition(); return;
  }
  if ((dirty || implementationDirty) && (id !== selected || projectId !== activeProject)) throw new Error('当前有未保存的内容，请先保存或取消编辑后再切换。');
  closeRecordPanel();
  generation++; opening = true; selected = null; current = null; $('task').hidden = true; $('empty').hidden = false;
  notice('正在打开需求，请稍候…');
  activeProject = projectId; $('project').value = projectId;
  const epoch = generation;
  try {
  await loadSettings(); if (epoch !== generation) return;
  await history(); if (epoch !== generation) return;
  selected = id; current = null; dirty = false; editing = false; rejectOpen = false; assigneeDirty = false; renderedCard = null; $('diff-panel').close(); $('application-dialog').close(); $('rollback-dialog').close(); rollbackTarget = null;
  clarificationKey = ''; decisionDrafts = {}; decisionRevision = null; decisionKey = ''; decisionDismissed = '';
  if ($('decisions-dialog').open) $('decisions-dialog').close();
  clearShots('answers'); $('clarification-note').value = '';
  $('message').value = ''; $('message-panel').open = false;
  implementationEditing = false; implementationDirty = false; renderedImplementation = null;
  actualStage = null; shownStage = null; followStage = true; stagePositions.clear();
  const participants = await api('/participants');
  if (epoch !== generation) return;
  people = participants.users;
  $('task-developer').replaceChildren(); option($('task-developer'), '', '请选择具名研发负责人');
  for (const user of people) if (user.roles.some(role => ['admin', 'developer'].includes(role))) option($('task-developer'), user.id, user.username);
  await refresh(); if (epoch !== generation) return;
  const draftKey = projectId + ':' + id, draft = retainedDrafts.get(draftKey);
  if (draft) {
    if (draft.card !== null) { $('card').value = draft.card; cardRevision = draft.cardRevision; dirty = true; editing = true; }
    if (draft.implementation !== null) { $('implementation-content').value = draft.implementation; implementationRevision = draft.implementationRevision;
      implementationRequirementRevision = draft.implementationRequirementRevision; implementationDirty = true; implementationEditing = true; }
    retainedDrafts.delete(draftKey); await refresh(); if (epoch !== generation) return;
  }
  $('empty').hidden = true; $('task').hidden = false;
  $('task-title').focus({ preventScroll: true });
  await refreshList(); if (epoch !== generation) return;
  notice('');
  restoreStagePosition();
  scheduleSync(1500);
  } catch (error) {
    if (epoch === generation) { selected = null; current = null; $('task').hidden = true; $('empty').hidden = false; }
    throw error;
  } finally { if (epoch === generation) { opening = false; scheduleSync(1500); } }
}
async function refresh() {
  if (!selected) return;
  const id = selected, epoch = generation;
  const data = await api('/tasks/' + id); const task = data.task;
  if (id !== selected || epoch !== generation || current?.id === id && current.version > task.version) return;
  const previousState = current?.state; current = task;
  if (!people.some(user => user.id === task.owner) || task.developer !== null && !people.some(user => user.id === task.developer)) {
    const participants = await api('/participants');
    if (id !== selected || epoch !== generation || current !== task) return;
    people = participants.users;
  }
  if (data.policyChanged) await loadSettings();
  if (id !== selected || epoch !== generation || current !== task) return;
  if (previousState && previousState !== task.state) await refreshList();
  if (id !== selected || epoch !== generation || current !== task) return;
  $('task-title').textContent = task.title; $('task-state').textContent = labels[task.state];
  activeCall = !!data.execution || data.applicationRunning; $('progress').textContent = data.presentation.label;
  const reviewNext = updateRecordTask({ ...task, projectId: activeProject, review: data.review, importedReview: data.importedReview, presentation: data.presentation });
  const visit = { id: task.id, title: task.title, projectId: activeProject, projectName: session.projects.find(item => item.id === activeProject).name };
  const previousVisit = recentTasks.findIndex(item => item.id === task.id && item.projectId === activeProject);
  if (previousVisit !== -1) recentTasks.splice(previousVisit, 1);
  recentTasks.unshift(visit); recentTasks.splice(10);
  const tokens = task.usage.input + task.usage.output + task.usage.cacheRead + task.usage.cacheWrite;
  $('usage').textContent = `${task.usage.requests} 次模型请求 · ${tokens.toLocaleString()} token` + (task.usage.unknown ? ` · ${task.usage.unknown} 次用量未知，预留${task.usage.reserved.toLocaleString()}` : '');
  if (!dirty) { $('card').value = task.card; cardRevision = task.cardRevision; }
  if (renderedCard !== task.card) { renderDocument(task.card, $('card-preview')); renderedCard = task.card; }
  const originalRecord = task.state === 'done' && task.implementation === null;
  $('requirement-heading').textContent = originalRecord ? '原始需求记录' : '产品需求';
  $('requirement-purpose').textContent = originalRecord ? '这是此前技术验证的原始确认记录，保留原文与审批证据。新需求将分别记录业务要求和研发实现。' : '说明谁在什么场景遇到问题，以及什么结果才算完成。';
  $('revision').textContent = `版本 ${task.cardRevision}`;
  const application = task.application, applicationPending = application !== null && application.phase === 'pending';
  if (data.policyError) notice('执行设置不可读取：' + data.policyError + '。仍可查看写入清单与回滚，继续应用前须恢复原设置。');
  const busy = !!data.execution || applicationPending, product = data.access.product, development = data.access.development;
  const admin = session.principal.roles.includes('admin');
  $('delete-task').hidden = !admin;
  $('delete-task').disabled = busy || !!data.applicationRunning || data.developmentStarted;
  $('delete-task').title = data.developmentStarted ? '研发已开始，请先退回开工前；已应用代码须先回滚。' : '';
  $('revert-development').hidden = !admin || !data.developmentStarted;
  $('revert-development').disabled = applicationPending || !!data.applicationRunning || task.application !== null && task.application.direction !== 'rollback';
  $('revert-development').title = $('revert-development').disabled ? '请先完成已应用代码的回滚。' : '停止当前研发并恢复原始现场，历史现场和累计用量保留。';
  if (data.imageLimits) { Object.assign(shotLimits, data.imageLimits); renderShotLimits(); }
  if (data.clarificationLimit) decisionLimit = data.clarificationLimit;
  const editable = product && !busy && ['draft', 'queued', 'ready', 'accepted', 'attention'].includes(task.state);
  const conflict = dirty && cardRevision !== task.cardRevision;
  $('card').disabled = !editable; $('save-card').disabled = !editable || conflict;
  $('edit-card').hidden = editing || !editable;
  $('card-editor').hidden = !editing; $('card-preview').hidden = editing;
  $('card-conflict').hidden = !conflict;
  $('card-conflict').textContent = conflict ? '需求已被更新，你的输入仍保留。请先复制修改内容，取消编辑后查看最新版本，再合并修改。' : '';
  const implementation = task.implementation;
  const noteRevision = implementation === null ? null : implementation.revision;
  const noteContent = implementation === null ? '' : implementation.content;
  if (!implementationDirty) {
    $('implementation-content').value = noteContent; implementationRevision = noteRevision; implementationRequirementRevision = task.cardRevision;
  }
  if (renderedImplementation !== noteContent) { renderDocument(noteContent, $('implementation-preview')); renderedImplementation = noteContent; }
  const noteConflict = implementationDirty && (implementationRevision !== noteRevision || implementationRequirementRevision !== task.cardRevision);
  const noteEditable = development && !busy && task.state !== 'done';
  $('implementation-revision').textContent = implementation === null ? originalRecord ? '无独立记录' : '待研发补充' : `版本 ${implementation.revision} · 对应产品 v${implementation.requirementRevision}`;
  $('implementation-status').textContent = originalRecord ? '此任务完成于内容分层前，可在「需求」查看原始技术记录。'
    : implementation === null ? '研发在实现时记录影响位置、实现要点和验证安排。产品只需核对业务需求与验收结果。'
    : implementation.requirementRevision !== task.cardRevision ? '产品需求已更新，这份研发说明对应旧版需求，需由研发更新后再交付。'
    : `由 ${implementation.actor} 记录 · ${new Date(implementation.at).toLocaleString('zh-CN', { hour12: false })}。本说明不能增加业务范围，验证结果以实际证据为准。`;
  $('implementation-status').classList.toggle('failure', implementation !== null && implementation.requirementRevision !== task.cardRevision);
  $('edit-implementation').hidden = implementationEditing || !noteEditable;
  $('implementation-editor').hidden = !implementationEditing; $('implementation-preview').hidden = implementationEditing;
  $('implementation-content').disabled = !noteEditable; $('save-implementation').disabled = !noteEditable || noteConflict;
  $('implementation-conflict').hidden = !noteConflict;
  $('implementation-conflict').textContent = noteConflict ? '产品需求或研发说明已更新，你的输入仍保留。请先复制内容，取消编辑后查看最新版本。' : '';
  $('start').hidden = !development || busy || !( ['queued', 'attention'].includes(task.state) || data.policyChanged && ['ready', 'accepted'].includes(task.state)) || !task.confirmation;
  $('start').disabled = settings === null;
  $('start').textContent = task.approval ? '重新确认开工' : '确认开工';
  $('confirm-requirement').hidden = !product || busy || !['draft', 'queued', 'attention'].includes(task.state);
  const openDecisions = task.pendingDecisions.filter(item => item.resolution === 'open');
  const unresolved = task.pendingDecisions.filter(item => item.resolution === 'open' || item.resolution === 'pending');
  const awaitingAnswers = task.clarification?.answers === null;
  $('confirm-requirement').disabled = conflict || awaitingAnswers || unresolved.length > 0;
  $('confirm-requirement').title = awaitingAnswers ? '请先提交本轮反问的回答与补充说明' : unresolved.length ? `还有 ${unresolved.length} 项未决事项待处理` : '';
  $('developer-label').hidden = $('confirm-requirement').hidden;
  if (!assigneeDirty && task.developer !== null) $('task-developer').value = task.developer;
  $('continue').hidden = !development || !['attention', 'running'].includes(task.state) || !task.approval || busy;
  $('pause').hidden = !development || !data.execution;
  const requirementStage = task.state === 'draft' && !task.confirmation;
  const messageSlot = $(requirementStage ? 'requirement-message' : 'development-message');
  if ($('message-panel').parentElement !== messageSlot) messageSlot.append($('message-panel'));
  $('message-form').hidden = applicationPending || (requirementStage ? !product || task.clarification?.answers === null : !development || !['running', 'attention'].includes(task.state) || !task.approval);
  $('message-panel').hidden = $('message-form').hidden;
  $('message-summary').textContent = requirementStage ? '补充需求，请 Pi 帮我整理' : '补充说明与 Pi 讨论';
  $('message-label').textContent = requirementStage ? '补充业务目标、范围或验收结果' : '研发技术说明或修复反馈';
  $('send-message').textContent = requirementStage ? '发送给 Pi 整理' : '发送给 Pi';
  if (requirementStage && previousState !== task.state) $('message-panel').open = true;
  $('send-message').disabled = busy || messageSending;
  $('accept').hidden = !product || task.state !== 'ready' || data.policyChanged; $('apply').hidden = !development || task.state !== 'accepted' || data.policyChanged;
  $('apply').disabled = !!data.applicationRunning;
  $('reject-toggle').hidden = !product || busy || !['ready', 'accepted'].includes(task.state);
  $('reject-form').hidden = $('reject-toggle').hidden || !rejectOpen;
  $('rollback').hidden = !development || application === null || application.direction !== 'apply';
  $('rollback').disabled = !!data.applicationRunning;
  $('application-summary').hidden = application === null;
  if (application !== null) {
    $('application-status').textContent = `本次计划 ${application.total} 项，已写入 ${application.written.length} 项，已回滚 ${application.reverted.length} 项。`;
    $('application-pending').textContent = applicationPending ? data.applicationRunning ? '正在按已验收计划处理，请等待。'
      : application.pendingFile === null ? '操作尚未完成，研发核对清单后选择具名恢复或回滚。' : `待核对：${application.pendingFile}。核对实际文件后才能继续。`
      : application.direction === 'apply' ? '本次计划已完整应用。回滚只撤销本任务实际写入，不恢复业务数据。' : '本次实际应用的代码变更已回滚，第三方修改保留。';
  }
  $('recover').hidden = !development || !applicationPending; $('recover').disabled = !!data.applicationRunning;
  $('recover').textContent = application?.direction === 'rollback' ? '继续回滚' : '继续应用已验收代码';
  const person = id => { const user = people.find(user => user.id === id); if (!user) throw new Error('任务负责人账号不存在'); return user.username; };
  $('responsibilities').textContent = `产品负责人：${person(task.owner)} · 研发负责人：${task.developer === null ? '尚未指定' : person(task.developer)}`;
  if (session.principal.roles.includes('admin')) $('responsibilities').textContent += ' · 管理员';
  const previousStage = actualStage;
  actualStage = taskStage(data);
  if (previousStage && previousStage !== actualStage
    && (editing || implementationEditing || rejectOpen || document.querySelector('dialog[open]'))) followStage = false;
  $('next-action').textContent = task.state === 'draft' ? '下一步：产品完善并确认需求，指定研发负责人。'
    : task.state === 'queued' ? '下一步：研发查看需求并确认开工。'
    : task.state === 'ready' ? '下一步：产品核对验收条件，验收或提供具体退回原因。'
    : task.state === 'accepted' ? '下一步：研发检查完整项目代码差异并应用到各自来源。'
    : task.state === 'attention' ? (task.confirmation ? '下一步：研发处理当前问题；业务范围变化交由产品修改需求。' : '下一步：产品确认当前需求版本。')
    : task.state === 'done' ? '本次需求已由产品验收、研发应用。' : '研发执行中，失败日志和审核反馈沿用当前 Pi 会话。';
  if (task.state === 'draft' && !task.confirmation) {
    if (task.clarification && task.clarification.answers === null) $('next-action').textContent = `下一步：回答 Pi 的第 ${task.clarificationRound} 轮需求问题。`;
    else if (openDecisions.length) $('next-action').textContent = `下一步：逐项处理 ${openDecisions.length} 项确认项，处理完才能确认需求。`;
    else if (unresolved.length) $('next-action').textContent = `下一步：还有 ${unresolved.length} 项标记待定，需明确后才能确认需求。`;
    else if (busy) $('next-action').textContent = 'Pi 正在按当前信息补齐需求边界与验收条件…';
  }
  if (data.policyChanged && task.state !== 'done') $('next-action').textContent = '执行设置已改变，下一步由研发重新确认并验证；需求版本及当前代码保留。';
  if (data.presentation.phase === 'stopped') $('next-action').textContent = '下一步：' + data.presentation.next;
  const importedPause = task.state === 'attention' && task.halt === 'paused' && !task.approval && !data.review && data.importedReview;
  if (importedPause) $('next-action').textContent = reviewNext;
  const alertSlot = $(actualStage + '-alert');
  if ($('failure').parentElement !== alertSlot) alertSlot.append($('failure'));
  $('failure').hidden = !task.failure || !!importedPause; $('failure').textContent = task.failure ? data.presentation.label + '。查看技术记录了解具体情况。' : '';
  for (const id of ['development-evidence', 'evidence', 'delivery-evidence']) $(id).replaceChildren();
  for (const [target, label, value, passed] of [
    ['development-evidence', '需求确认', task.confirmation ? task.confirmation.actor : '待确认', !!task.confirmation],
    ['development-evidence', '研发开工', task.approval ? task.approval.actor : '待开工', !!task.approval],
    ['evidence', '单元测试', data.policyChanged ? '需重新验证' : task.check ? `通过 ${task.check.checks.filter(check => check.code === 0).length}/${task.check.checks.length} 项` : '未执行', !data.policyChanged && task.check?.code === 0],
    ['delivery-evidence', '业务验收', task.acceptance ? `${task.acceptance.actor} · ${new Date(task.acceptance.at).toLocaleString('zh-CN')}` : '待验收', !!task.acceptance && !data.policyChanged],
    ['delivery-evidence', '代码应用', applicationPending ? `${application.direction === 'apply' ? '应用' : '回滚'}未完成` : application?.direction === 'rollback' ? '已回滚' : task.appliedBy ? `${task.appliedBy} · ${new Date(task.appliedAt).toLocaleString('zh-CN')}` : '未应用', !applicationPending && !!task.appliedBy]
  ]) {
    const row = document.createElement('div'); row.className = 'evidence-row' + (passed ? ' passed' : '');
    const name = document.createElement('span'); name.textContent = label;
    const result = document.createElement('strong'); result.textContent = value; row.append(name, result); $(target).append(row);
  }
  $('delivery-feedback').hidden = !task.feedback;
  $('delivery-feedback').textContent = task.feedback ? '产品退回意见：' + task.feedback : '';
  $('review-development').hidden = ['start', 'continue', 'pause'].every(id => $(id).hidden);
  $('issues').replaceChildren();
  if (!data.review) for (const issue of task.issues) { const article = document.createElement('article'); article.textContent = `${issue.file}:${issue.line}\n${issue.problem}\n需要修复：${issue.requiredChange}`; $('issues').append(article); }
  renderClarification(task, product, busy, decisionLimit);
  renderDecisions(task, product, busy);
  showStage(followStage || shownStage === null ? actualStage : shownStage);
  const images = task.images;
  $('task-images').hidden = !images.length;
  $('task-image-count').textContent = images.length ? `${images.length} 张` : '';
  if (images.length) {
    const list = $('task-image-list'); list.replaceChildren();
    for (const image of images) {
      const node = document.createElement('div'); node.className = 'shot';
      const link = document.createElement('a'); link.href = `/api/tasks/${id}/image/${image.hash}?projectId=${encodeURIComponent(activeProject)}`;
      link.target = '_blank'; link.rel = 'noreferrer';
      const picture = document.createElement('img'); picture.src = link.href; picture.alt = image.name; picture.loading = 'lazy';
      link.append(picture);
      const name = document.createElement('span'); name.textContent = image.name;
      node.append(link, name); list.append(node);
    }
  }
}
function renderClarification(task, product, busy, limit) {
  const clarification = task.clarification;
  const pending = clarification !== null && clarification.answers === null;
  const active = task.state === 'draft' && !task.confirmation && pending && product;
  $('clarification-panel').hidden = !active;
  const history = clarification !== null && clarification.answers !== null && task.state === 'draft' && !task.confirmation;
  $('clarification-history').hidden = !history;
  if (history) {
    const body = $('clarification-history-body'); body.replaceChildren();
    const intro = document.createElement('p'); intro.className = 'hint';
    intro.textContent = `第 ${task.clarificationRound} 轮回答` + (clarification.answeredAt
      ? ` · ${new Date(clarification.answeredAt).toLocaleString('zh-CN', { hour12: false })}` : '');
    body.append(intro);
    for (const question of clarification.questions) {
      const answer = clarification.answers.find(item => item.id === question.id);
      const row = document.createElement('p'); row.className = 'hint';
      row.textContent = `${question.kind === 'confirm' ? '必须确认' : '补充信息'} · ${question.title}：${answer === undefined || answer.text === null ? '未答' : answer.text}`;
      body.append(row);
    }
    if (clarification.note) { const note = document.createElement('p'); note.className = 'hint'; note.textContent = `补充说明：${clarification.note}`; body.append(note); }
  }
  $('clarification-submit').disabled = busy;
  if (!active) { clarificationKey = ''; return; }
  $('clarification-round').textContent = `第 ${task.clarificationRound} 轮 / 最多 ${limit} 轮`;
  const key = `${task.clarificationRound}:${clarification.askedAt}`;
  if (key === clarificationKey) return;
  const changed = clarificationKey !== '';
  clarificationKey = key;
  const container = $('clarification-questions'); container.replaceChildren();
  clarification.questions.forEach((question, index) => {
    const card = document.createElement('section'); card.className = 'question-card';
    const title = document.createElement('h4'); title.textContent = `${index + 1}. ${question.title}`;
    if (question.kind === 'confirm') { const kind = document.createElement('span'); kind.className = 'tag'; kind.textContent = '必须确认'; title.append(kind); }
    const body = document.createElement('p'); body.textContent = question.body;
    card.append(title, body);
    const radios = [];
    question.options.forEach(option => {
      const label = document.createElement('label'); label.className = 'question-option';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = `cq-${index}`; radio.value = option.value;
      const text = document.createElement('span'); text.textContent = option.label;
      label.append(radio, text);
      if (option.recommended) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '建议'; label.append(tag); }
      card.append(label); radios.push(radio);
    });
    if (question.allowOther) {
      const wrap = document.createElement('div'); wrap.className = 'question-other';
      const other = document.createElement('input'); other.type = 'text'; other.maxLength = 400;
      other.placeholder = '其他答案：直接填写你的选择或补充'; other.dataset.otherIndex = String(index);
      for (const radio of radios) radio.onchange = () => { if (radio.checked) other.value = ''; };
      other.oninput = () => { if (other.value.trim()) for (const radio of radios) radio.checked = false; };
      wrap.append(other); card.append(wrap);
    }
    container.append(card);
  });
  if (changed) notice('Pi 已提交新一轮问题，请按最新问题回答。');
}
function decisionState(item) {
  return { open: '待处理', accepted: '已接受建议', modified: '已修改', pending: '标记待定', resolved: '已标记解决' }[item.resolution];
}
function renderDecisions(task, product, busy) {
  const items = task.pendingDecisions;
  $('decision-panel').hidden = !product || !items.length;
  const taken = task.modelDecisions;
  $('model-decisions').hidden = !taken.length;
  if (taken.length) {
    const list = $('model-decision-list'); list.replaceChildren();
    for (const decision of taken) {
      const row = document.createElement('li');
      row.textContent = `${decision.area}：${decision.decision}（依据：${decision.basis}${decision.source === 'model_default' ? '；反问未答，模型按推荐默认' : ''}）`; list.append(row);
    }
  }
  if (!product || !items.length) return;
  const unresolved = items.filter(item => isUnresolved(item));
  const stale = item => item.basedOnRevision !== task.cardRevision && isUnresolved(item);
  $('decision-count').textContent = unresolved.length
    ? `${unresolved.length} 项未决${unresolved.some(stale) ? ' · 建议基于旧版本' : ''}` : '已全部处理';
  const list = $('decision-list'); list.replaceChildren();
  for (const item of items) {
    const node = document.createElement('article'); node.className = 'decision-item';
    const heading = document.createElement('h4'); heading.textContent = item.question;
    const state = document.createElement('span'); state.className = `decision-state ${item.resolution}`; state.textContent = decisionState(item);
    heading.append(state);
    if (stale(item)) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = `基于v${item.basedOnRevision}，可能已过时`; heading.append(tag); }
    const dl = document.createElement('dl');
    const rows = [['建议', item.suggestion], ['影响', item.impact]];
    if (item.note) rows.push([item.resolution === 'pending' ? '待定说明' : item.resolution === 'resolved' ? '解决说明' : '你的处理', item.note]);
    for (const [name, value] of rows) {
      const dt = document.createElement('dt'); dt.textContent = name;
      const dd = document.createElement('dd'); dd.textContent = value; dl.append(dt, dd);
    }
    node.append(heading, dl); list.append(node);
  }
  const reviewable = items.filter(item => isUnresolved(item));
  $('decision-open').hidden = !reviewable.length;
  $('decision-open').textContent = `逐项处理 ${reviewable.length} 项确认项`;
  $('decision-open').disabled = !reviewable.length || busy;
  $('decision-reconsider').hidden = !reviewable.length;
  $('decision-reconsider').disabled = busy || task.clarification?.answers === null;
  if ($('decisions-dialog').open) {
    if (decisionRevision !== task.cardRevision) {
      $('decisions-status').textContent = '需求卡已更新，当前弹窗基于旧版本作废。请关闭弹窗后按新版本重新处理。';
      $('decisions-submit').disabled = true;
    }
    return;
  }
  const batchKey = `${task.cardRevision}|${items.map(item => `${item.id}:${item.resolution}:${item.basedOnRevision}`).join('|')}`;
  decisionKey = batchKey;
  const openItems = items.filter(item => item.resolution === 'open');
  const blocking = [...document.querySelectorAll('dialog')].some(dialog => dialog.open && dialog.id !== 'decisions-dialog');
  if (openItems.length && task.state === 'draft' && !task.confirmation && !busy && !blocking && batchKey !== decisionDismissed)
    openDecisions(openItems, task.cardRevision);
}
function updateDecisionSubmit() {
  $('decisions-close').disabled = decisionsBusy;
  const values = Object.values(decisionDrafts);
  const handled = values.filter(draft => draft.resolution).length;
  const missingNote = values.some(draft => ['modified', 'resolved'].includes(draft.resolution) && !draft.note.trim());
  const staleRevision = decisionRevision !== null && current !== null && decisionRevision !== current.cardRevision;
  $('decisions-progress').textContent = `已处理 ${handled} / ${values.length} 项` + (missingNote ? ' · 选择“修改”或“已解决”需填写说明' : '');
  $('decisions-submit').disabled = decisionsBusy || staleRevision || !values.length || handled !== values.length || missingNote;
}
function openDecisions(items, revision) {
  decisionDrafts = {}; decisionRevision = revision;
  const list = $('decisions-list'); list.replaceChildren();
  $('decisions-status').textContent = decisionRegenerated ? '需求卡已更新，确认项已按新版本重新生成，请重新处理。' : '';
  decisionRegenerated = false;
  const canResolve = current !== null && current.clarificationRound >= decisionLimit;
  for (const item of items) {
    decisionDrafts[item.id] = { resolution: null, note: '' };
    const node = document.createElement('article'); node.className = 'decision-item';
    const heading = document.createElement('h4'); heading.textContent = item.question;
    const dl = document.createElement('dl');
    for (const [name, value] of [['建议', item.suggestion], ['影响', item.impact], ['依据', item.basis]]) {
      const dt = document.createElement('dt'); dt.textContent = name;
      const dd = document.createElement('dd'); dd.textContent = value; dl.append(dt, dd);
    }
    const actions = document.createElement('div'); actions.className = 'decision-actions';
    const note = document.createElement('textarea'); note.className = 'decision-note'; note.rows = 3; note.maxLength = 2000;
    note.placeholder = '填写你确认的具体内容、待定原因或解决说明（选择“修改”“已解决”时必填）';
    note.oninput = () => { decisionDrafts[item.id].note = note.value; updateDecisionSubmit(); };
    const choose = (resolution, label) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.onclick = () => {
        decisionDrafts[item.id].resolution = resolution;
        for (const sibling of actions.children) sibling.classList.toggle('selected', sibling === button);
        note.classList.toggle('visible', ['modified', 'pending', 'resolved'].includes(resolution));
        updateDecisionSubmit();
      };
      actions.append(button);
    };
    choose('accepted', '接受建议'); choose('modified', '修改'); choose('pending', '标记待定');
    if (canResolve) choose('resolved', '已解决');
    node.append(heading, dl, actions, note); list.append(node);
  }
  updateDecisionSubmit();
  $('decisions-dialog').showModal();
}
const action = async (name, value = {}) => { await api(`/tasks/${selected}/${name}`, value); await refresh(); await refreshList(); scheduleSync(activeCall ? 1500 : 5000); };
for (const stage of taskStages) $('tab-' + stage).onclick = () => selectStage(stage);
$('task-steps').onkeydown = event => {
  if (event.target.getAttribute('role') !== 'tab') return;
  const index = taskStages.indexOf(event.target.id.slice(4));
  const next = { ArrowLeft: (index + 3) % 4, ArrowRight: (index + 1) % 4, Home: 0, End: 3 }[event.key];
  if (next === undefined) return;
  event.preventDefault(); selectStage(taskStages[next]);
};
$('current-stage').onclick = () => selectStage(actualStage);
$('review-development').onclick = () => selectStage('development');
$('delivery-review').onclick = () => selectStage('verification');
$('card').oninput = () => { dirty = true; };
$('task-developer').onchange = () => { assigneeDirty = true; };
$('edit-card').onclick = perform(async () => { editing = true; await refresh(); $('card').focus(); });
$('cancel-card').onclick = perform(async () => { editing = false; dirty = false; await refresh(); });
$('implementation-content').oninput = () => { implementationDirty = true; };
$('edit-implementation').onclick = perform(async () => { implementationEditing = true; await refresh(); $('implementation-content').focus(); });
$('cancel-implementation').onclick = perform(async () => { implementationEditing = false; implementationDirty = false; await refresh(); });
$('save-implementation').onclick = perform(async () => {
  await api(`/tasks/${selected}/implementation`, { requirementRevision: implementationRequirementRevision, revision: implementationRevision, content: $('implementation-content').value });
  implementationDirty = false; implementationEditing = false; await refresh();
});
$('login-form').onsubmit = perform(async () => { await api('/login', { projectId: $('login-project').value, username: $('username').value, password: $('password').value }); $('password').value = ''; await boot(); });
$('logout').onclick = perform(async () => { await api('/logout', {}); location.reload(); });
$('password-dialog').oncancel = event => { if (session.principal.mustChangePassword) event.preventDefault(); };
$('password-close').onclick = () => $('password-dialog').close();
$('password-form').onsubmit = perform(async () => {
  await api('/password', { oldPassword: $('old-password').value, newPassword: $('new-password').value }); location.reload();
});
$('project').onchange = perform(async () => {
  if (dirty || implementationDirty) { $('project').value = activeProject; throw new Error('请先保存或取消编辑后再切换项目，输入已保留。'); }
  clearTimeout(timer); generation++; activeProject = $('project').value;
  selected = null; current = null; dirty = false; editing = false; implementationDirty = false; implementationEditing = false; $('task').hidden = true; $('empty').hidden = false; await boot();
});
wireCenter(() => perform(refreshList)());
$('center-toggle').onclick = perform(async () => {
  const inCenter = !$('empty').hidden;
  rememberStagePosition();
  clearTimeout(timer); generation++; createEpoch++;
  if (opening) { selected = null; current = null; }
  opening = false; notice('');
  closeRecordPanel(); $('task').hidden = true; $('empty').hidden = false; await refreshList();
  restoreCenterPosition(); scheduleSync(1500);
  if (inCenter) {
    $('center-heading').focus({ preventScroll: true }); $('empty').scrollIntoView({ block: 'start' });
    notice('已显示需求中心，查找条件已保留。');
  }
});
for (const id of ['new-task', 'empty-new']) $(id).onclick = perform(async () => {
  if (creating) throw new Error('上一条需求正在保存，请等待保存结果。');
  if (dirty || implementationDirty) throw new Error('当前有未保存的内容，请先保存或取消编辑后再创建需求。');
  const target = centerCreationProject();
  $('new-project').replaceChildren(); option($('new-project'), '', '请选择归属项目');
  for (const project of session.projects) option($('new-project'), project.id, project.name);
  $('new-project').value = target;
  $('create-status').hidden = true; $('create-dialog').showModal();
});
$('create-cancel').onclick = () => { createEpoch++; $('create-dialog').close(); };
$('create-close').onclick = $('create-cancel').onclick;
$('create-dialog').oncancel = () => { createEpoch++; };
$('create-form').onsubmit = perform(async event => {
  if (creating) throw new Error('需求正在保存，请勿重复提交。');
  const epoch = generation, creation = ++createEpoch;
  const projectId = $('new-project').value;
  if (!projectId || !session.projects.some(project => project.id === projectId)) throw new Error('请选择有权限的归属项目。');
  const goal = $('new-request').value.trim(), scope = $('new-scope').value.trim(), acceptance = $('new-acceptance').value.trim();
  if (event.submitter?.value !== 'clarify' && !acceptance) {
    $('create-status').hidden = false; $('create-status').textContent = '请补充可以实际核对的验收结果，或请 Pi 帮你整理。'; $('new-acceptance').focus(); return;
  }
  const request = `## 用户场景与目标\n${goal}` + (scope ? `\n\n## 业务范围与规则\n${scope}` : '') + (acceptance ? `\n\n## 验收结果\n${acceptance}` : '');
  let task;
  creating = true;
  try { task = await api('/tasks', { title: $('new-title').value, request, images: shots.create }, 'POST', projectId); }
  finally { creating = false; }
  if (epoch !== generation || creation !== createEpoch) {
    if (epoch === generation) notice('需求已保存，可在需求中心重新查找。');
    return;
  }
  clearShots('create');
  $('create-dialog').close();
  const navigation = generation + 1;
  await open(task.id, projectId);
  if (generation !== navigation || selected !== task.id || activeProject !== projectId || creation !== createEpoch) return;
  if (event.submitter?.value === 'clarify') {
    await api(`/tasks/${task.id}/message`, { text: request }, 'POST', projectId);
    if (generation === navigation) { await refresh(); await refreshList(); scheduleSync(1500); }
  }
});
$('save-card').onclick = perform(async () => { await api(`/tasks/${selected}/card`, { card: $('card').value, revision: cardRevision }); dirty = false; editing = false; await refresh(); });
$('confirm-requirement').onclick = perform(async () => {
  const developer = $('task-developer').value;
  if (!developer) throw new Error('请指定研发负责人');
  if (dirty) { await api(`/tasks/${selected}/card`, { card: $('card').value, revision: cardRevision }); dirty = false; editing = false; await refresh(); }
  await action('confirm', { revision: current.cardRevision, developer });
  assigneeDirty = false;
});
$('start').onclick = perform(() => action('start', { revision: current.cardRevision }));
for (const [name, control, prompt] of [
  ['delete', 'delete-task', '确认删除这条需求？删除后从需求中心移除，未保存输入会丢弃，原审计与历史现场保留。'],
  ['revert-development', 'revert-development', '确认退回研发开工前？将先停止当前执行，恢复原始现场；旧现场、审计及累计用量保留。已应用代码须先完成回滚。']
]) $(control).onclick = async () => {
  const task = current, projectId = activeProject, epoch = generation;
  let responseEpoch = epoch;
  if (name === 'revert-development' && (dirty || implementationDirty)) { notice('请先保存或取消编辑，再回退研发。'); return { ok: false }; }
  if (!confirm(prompt)) return { cancelled: true };
  const controls = ['delete-task', 'revert-development'].map(id => [$(id), $(id).disabled]);
  for (const [node] of controls) node.disabled = true;
  notice('');
  try {
    await api(`/tasks/${task.id}/${name}`, name === 'delete' ? { version: task.version } : { revision: task.cardRevision }, 'POST', projectId);
    if (epoch !== generation || activeProject !== projectId || name !== 'delete' && selected !== task.id) return { ok: true, stale: true };
    if (name === 'delete') {
      generation++; responseEpoch = generation;
      dirty = false; implementationDirty = false; retainedDrafts.delete(projectId + ':' + task.id); invalidateTaskView(); restartCenterQuery();
      await refreshList(); restoreCenterPosition(); notice('需求已删除，原审计与历史现场保留。');
      const link = document.createElement('a'); link.textContent = '下载删除审计';
      link.href = `/api/tasks/${task.id}/audit?projectId=${encodeURIComponent(projectId)}`; $('notice').append(' ', link);
    } else { await refresh(); await refreshList(); notice('已退回开工前，历史现场与累计用量保留。现在可重新开工或由管理员删除。'); }
    scheduleSync(1500); return { ok: true };
  } catch (error) {
    if (responseEpoch === generation && activeProject === projectId && (selected === task.id || name === 'delete' && selected === null)) {
      for (const [node, disabled] of controls) node.disabled = disabled;
      notice((responseEpoch !== epoch ? '需求已删除，但列表刷新失败：' : '') + error.message);
    }
    return { ok: false, error };
  }
};
$('message-form').onsubmit = async event => {
  event.preventDefault(); notice('');
  const id = selected, projectId = activeProject, epoch = generation;
  try {
    if (messageSending) throw new Error('说明正在发送，请等待处理结果。');
    if (dirty || implementationDirty) throw new Error('请先保存或取消编辑，再发送给 Pi，输入已保留。');
    const text = $('message').value.trim();
    const requirementStage = current?.state === 'draft' && !current.confirmation;
    if (!text) throw new Error(requirementStage ? '请补充需要 Pi 整理的业务问题或需求说明' : '请输入研发技术说明或修复反馈');
    messageSending = true; $('send-message').disabled = true;
    try {
      await api(`/tasks/${id}/message`, { text }, 'POST', projectId);
      if (epoch !== generation || id !== selected || projectId !== activeProject) return { ok: true, stale: true };
      if ($('message').value.trim() === text) $('message').value = '';
      await refresh(); await refreshList(); scheduleSync(activeCall ? 1500 : 5000);
      return { ok: true };
    } finally { messageSending = false; $('send-message').disabled = activeCall; }
  } catch (error) {
    if (epoch === generation && id === selected && projectId === activeProject) notice(error.message);
    return { ok: false, error };
  }
};
$('clarification-submit').onclick = perform(async () => {
  const clarification = current?.clarification;
  if (!clarification) throw new Error('当前没有待回答的问题');
  const container = $('clarification-questions');
  const answers = clarification.questions.map((question, index) => {
    const chosen = container.querySelector(`input[name="cq-${index}"]:checked`);
    const other = question.allowOther ? container.querySelector(`[data-other-index="${index}"]`) : null;
    const custom = other?.value.trim() || null;
    return { id: question.id, text: chosen ? chosen.value : custom };
  });
  const note = $('clarification-note').value.trim();
  if (answers.every(answer => !answer.text) && !note) throw new Error('请至少回答一个问题或填写补充说明');
  const skipped = answers.filter(answer => !answer.text).length;
  if (skipped && !confirm(`还有 ${skipped} 个问题未回答，会按题目类型转为未决项或模型默认。继续提交？`)) return;
  await api(`/tasks/${selected}/answers`, { answers, note, images: shots.answers });
  clearShots('answers'); $('clarification-note').value = ''; clarificationKey = '';
  await refresh(); await refreshList(); scheduleSync(1500);
});
$('decision-open').onclick = perform(async () => {
  const reviewable = current.pendingDecisions.filter(item => isUnresolved(item));
  if (!reviewable.length) throw new Error('当前没有待处理的确认项');
  if (!$('decisions-dialog').open) openDecisions(reviewable, current.cardRevision);
});
$('decision-reconsider').onclick = perform(async () => {
  await api(`/tasks/${selected}/decisions-reconsider`, {});
  decisionDismissed = ''; await refresh(); await refreshList(); scheduleSync(1500);
});
$('decisions-close').onclick = () => { if (!decisionsBusy) $('decisions-dialog').close(); };
$('decisions-dialog').oncancel = event => { if (decisionsBusy) event.preventDefault(); };
$('decisions-dialog').onclose = () => {
  if (decisionsBusy) return;
  const stale = decisionRevision !== null && current !== null && decisionRevision !== current.cardRevision;
  decisionRevision = null;
  if (stale) { decisionRegenerated = true; decisionDismissed = ''; refresh().catch(error => notice(error.message)); }
  else decisionDismissed = decisionKey;
};
$('decisions-submit').onclick = perform(async () => {
  decisionsBusy = true; updateDecisionSubmit();
  try {
    const resolutions = Object.entries(decisionDrafts).map(([id, draft]) =>
      ({ id, resolution: draft.resolution, note: draft.note.trim() }));
    await api(`/tasks/${selected}/decisions-resolve`, { resolutions });
    decisionDismissed = ''; decisionRevision = null;
    $('decisions-dialog').close(); decisionDrafts = {};
    const needsModel = resolutions.some(item => item.resolution !== 'resolved');
    if (current.clarification?.answers === null) notice('确认项已记录，请继续回答本轮需求问题。');
    else if (needsModel) await api(`/tasks/${selected}/decisions`, {});
    else notice('已按你的说明标记解决；请编辑需求卡对齐后确认需求。');
    await refresh(); await refreshList(); scheduleSync(needsModel ? 1500 : 5000);
  } finally { decisionsBusy = false; updateDecisionSubmit(); }
});
wireShots('create', 'create-shots-pick', 'create-shots-input', 'create-shots');
wireShots('answers', 'clarification-shots-pick', 'clarification-shots-input', 'clarification-shots');
document.addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
  if (!files.length) return;
  const target = $('create-dialog').open ? 'create'
    : !$('clarification-panel').hidden && $('clarification-panel').contains(event.target) ? 'answers' : null;
  if (!target) return;
  return perform(() => addShots(target, files))(event);
});
$('continue').onclick = perform(() => action('continue'));
$('pause').onclick = perform(() => action('pause'));
$('accept').onclick = perform(() => action('accept', { sourceHash: current.sourceHash }));
$('apply').onclick = perform(() => action('apply', { sourceHash: current.sourceHash }));
$('recover').onclick = perform(() => action('recover', { sourceHash: current.sourceHash, direction: current.application.direction }));
$('reject-toggle').onclick = () => { rejectOpen = !rejectOpen; $('reject-form').hidden = !rejectOpen; };
$('reject-form').onsubmit = perform(async () => { await action('reject', { sourceHash: current.sourceHash, reason: $('reject-reason').value }); rejectOpen = false; $('reject-reason').value = ''; });
$('rollback').onclick = () => {
  rollbackTarget = { id: selected, projectId: activeProject, sourceHash: current.sourceHash, planId: current.application.planId };
  $('rollback-target').textContent = `${current.title} · 本次实际写入 ${current.application.written.length} 项。`;
  $('rollback-dialog').showModal();
};
$('rollback-cancel').onclick = () => { $('rollback-dialog').close(); rollbackTarget = null; };
$('rollback-confirm').onclick = perform(async () => {
  if (rollbackTarget === null || rollbackTarget.id !== selected || rollbackTarget.projectId !== activeProject || rollbackTarget.planId !== current?.application?.planId)
    throw new Error('需求或写入计划已变化，请关闭后重新核对');
  const hash = rollbackTarget.sourceHash; $('rollback-dialog').close(); rollbackTarget = null;
  await action('rollback', { sourceHash: hash });
});
for (const button of [$('diff-toggle'), $('delivery-diff')]) button.onclick = perform(async () => {
  const id = selected, projectId = activeProject, epoch = generation, stage = shownStage;
  button.disabled = true;
  try {
    const data = await api(`/tasks/${id}/diff`);
    if (id !== selected || projectId !== activeProject || epoch !== generation || stage !== shownStage) return;
    $('diff').textContent = data.diff || '没有代码差异';
    $('diff-summary').textContent = `${data.files.length} 个文件发生变更`;
    $('diff-panel').showModal();
  } finally { button.disabled = false; }
});
$('diff-close').onclick = () => $('diff-panel').close();
$('application-close').onclick = () => $('application-dialog').close();
$('application-open').onclick = perform(async () => {
  const id = selected, projectId = activeProject, epoch = generation, stage = shownStage;
  const data = await api(`/tasks/${id}/application`);
  if (id !== selected || projectId !== activeProject || epoch !== generation || stage !== shownStage) return;
  if (data.version !== current.version || data.application?.planId !== current.application?.planId) { notice('写入清单版本已变化，请重新打开。'); return; }
  const names = { root: '项目根目录', frontend: '前端', backend: '后端' };
  const labels = { pending: '待核对', written: '已写入', reverted: '已回滚', waiting: '未写入' };
  $('application-files').replaceChildren();
  for (const file of data.files) {
    const row = document.createElement('tr');
    for (const value of [names[file.sourceId], file.file, labels[file.status]]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    $('application-files').append(row);
  }
  $('application-version').textContent = `写入计划 ${data.application.planId.slice(0, 8)} · ${data.files.length} 项；本清单只描述源码，不包含业务数据恢复。`;
  $('application-dialog').showModal();
});
function showMapFiles() {
  const query = $('context-query').value.trim().toLowerCase();
  const matches = projectMap.modules.filter(item => item.file.toLowerCase().includes(query) || item.anchors.some(a => a.text.toLowerCase().includes(query)));
  $('context-files').replaceChildren(); $('context-detail').replaceChildren();
  $('context-results').textContent = `匹配 ${matches.length} 个文件，显示前 30 个。选择文件查看定位与关系。`;
  for (const item of matches.slice(0, 30)) {
    const button = document.createElement('button'); button.textContent = item.file;
    button.onclick = () => {
      const incoming = projectMap.modules.filter(node => node.links.includes(item.file)).map(node => node.file);
      const matches = item.anchors.filter(a => a.text.toLowerCase().includes(query));
      const anchors = query && matches.length ? matches : item.anchors;
      renderDocument(`## ${item.file}\n\n### 符号与源码定位（显示前45条）\n${anchors.slice(0, 45).map(a => `${item.file}:${a.line} ${a.text}`).join('\n')}\n\n### 引用它的文件（含关联测试）\n${incoming.length ? incoming.join('\n') : '无已解析的本地引用'}\n\n### 直接依赖\n${item.links.length ? item.links.join('\n') : '无已解析的本地导入'}`, $('context-detail'));
    };
    $('context-files').append(button);
  }
}
function showKnowledgeModule(id) {
  selectedKnowledgeModule = id; const entry = projectKnowledge.catalog.modules.find(item => item.id === id);
  const item = projectKnowledge.modules.find(item => item.content.id === id);
  if (!entry) throw new Error('项目知识模块不存在');
  if (!item) { renderDocument(`## ${entry.name}\n${entry.purpose}\n\n本模块尚未完成梳理，不作为已验证的实现依据。`, $('knowledge-detail')); return; }
  const content = item.content;
  const facts = content.facts.map(f => `- **${({ business: '业务含义', responsibility: '模块职责', state: '关键状态', invariant: '必保规则' })[f.kind]}** ${f.statement}`).join('\n');
  const flows = content.flows.map(flow => `### ${flow.name}\n触发：${flow.trigger}\n${flow.steps.map((step, i) => `${i + 1}. ${step.action}`).join('\n')}`).join('\n\n');
  const validation = content.validation.map(item => `### ${item.name}\n${item.method}\n验证范围与限制：${item.limitations}`).join('\n\n');
  renderDocument(`## ${entry.name}\n${entry.purpose}\n\n${item.state === 'stale' ? '**资料已过期，以下内容需要重新核对。**\n' + item.invalidatedBy.join('\n') : '已由独立审核核对，证据片段与当前源码对应。'}\n\n${facts}\n\n## 行为链路\n${flows}\n\n## 开发与验证\n${validation}\n\n## 尚未核实\n${content.unknowns.length ? content.unknowns.join('\n') : '本模块未记录额外未决项；这不代表外部环境已验证。'}`, $('knowledge-detail'));
  const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
  summary.textContent = '查看源码证据与审核来源';
  pre.textContent = JSON.stringify({ source: item.jobId, reviewSession: item.reviewSession, amendments: item.amendments,
    facts: content.facts.map(f => ({ id: f.id, evidence: f.evidence })), flows: content.flows.map(flow => ({ name: flow.name, steps: flow.steps })) }, null, 2);
  details.append(summary, pre); $('knowledge-detail').append(details);
}
function showProjectKnowledge() {
  $('knowledge-modules').replaceChildren(); $('knowledge-detail').replaceChildren();
  if (projectKnowledge === null) {
    $('knowledge-summary').textContent = '尚未发布经核对的项目理解。先梳理关键业务；扫描文件完成不能代替理解完成。';
    $('knowledge-vocabulary').textContent = ''; return;
  }
  const verified = projectKnowledge.modules.filter(item => item.state === 'verified').length;
  $('knowledge-summary').textContent = `${projectKnowledge.catalog.summary} 当前目录 ${projectKnowledge.catalog.modules.length} 个模块，${verified} 个证据有效，${projectKnowledge.modules.length - verified} 个需要重新核对。`;
  $('knowledge-vocabulary').textContent = '业务术语：' + projectKnowledge.catalog.vocabulary.map(v => `${v.term}：${v.meaning}`).join('；')
    + '。本次覆盖：' + projectKnowledge.scope + '。范围之外：' + (projectKnowledge.catalog.outsideScope.length ? projectKnowledge.catalog.outsideScope.join('；') : '未声明额外范围，仍以已核对模块为准');
  for (const entry of projectKnowledge.catalog.modules) {
    const item = projectKnowledge.modules.find(item => item.content.id === entry.id), button = document.createElement('button');
    button.textContent = `${entry.name} · ${item ? item.state === 'stale' ? '需重新核对' : '已核对' : '待梳理'}`;
    button.onclick = () => showKnowledgeModule(entry.id); $('knowledge-modules').append(button);
  }
  if (selectedKnowledgeModule && projectKnowledge.catalog.modules.some(m => m.id === selectedKnowledgeModule)) showKnowledgeModule(selectedKnowledgeModule);
  else if (projectKnowledge.catalog.modules.length) showKnowledgeModule(projectKnowledge.catalog.modules[0].id);
}
async function loadProjectContext() {
  const epoch = generation, projectId = activeProject;
  const data = await api('/project-context');
  if (epoch !== generation || projectId !== activeProject) return;
  projectMap = data.map; projectKnowledge = data.knowledge; knowledgeJob = data.job;
  showSources($('context-sources'), data.sources);
  $('context-status').hidden = false;
  $('context-status').textContent = projectKnowledge === null ? '项目理解尚未发布。可先完整梳理关键业务，已核对模块会逐步发布。'
    : `理解版本 ${projectKnowledge.id.slice(0, 8)} · ${new Date(projectKnowledge.at).toLocaleString('zh-CN', { hour12: false })} · 按当前源码重新核对证据有效性`;
  $('context-index-status').textContent = projectMap === null ? '尚未建立结构索引。'
    : `图谱 ${projectMap.id.slice(0, 8)} · ${projectMap.files} 个文件 · ${projectMap.links} 条导入关系 · ${new Date(projectMap.at).toLocaleString('zh-CN', { hour12: false })} · ${projectMap.stale ? '源码已变化，下次执行会核对变化文件；可更新持久索引' : '与当前源码一致'}`;
  $('context-build').hidden = !data.canInitialize;
  const busy = knowledgeJob !== null && knowledgeJob.active;
  $('knowledge-form').hidden = !data.canInitialize; $('knowledge-start').disabled = busy || !settings || data.initializationBudget === null;
  const budget = data.initializationBudget;
  $('knowledge-budget').textContent = budget === null ? '请由管理员配置独立初始化预算；需求任务预算不用于初始化。' : `本轮初始化独立预算：最多 ${budget.requests} 次请求、${budget.tokens.toLocaleString()} Token，development 与 review 共同计量。续跑保留累计用量，不占用需求任务额度。`;
  $('initialization-budget-fields').disabled = !data.canSetInitializationBudget;
  $('save-initialization-budget').hidden = !data.canSetInitializationBudget;
  if (!initializationBudgetDirty) for (const name of ['tokens', 'requests', 'repairCycles', 'runMs']) $('initialization-' + name).value = budget === null ? '' : budget[name] / (name === 'runMs' ? 1000 : 1);
  if (!scopeDirty && !$('knowledge-scope').value && knowledgeJob !== null) $('knowledge-scope').value = knowledgeJob.scope;
  $('knowledge-job').hidden = knowledgeJob === null;
  if (knowledgeJob !== null) {
    $('knowledge-progress').textContent = `${knowledgeJob.progress} · 已完成 ${knowledgeJob.completed.length}/${knowledgeJob.targets.length || '待建立目录'} 个目标模块`;
    const usage = knowledgeJob.usage; $('knowledge-usage').textContent = `${usage.requests} 次模型请求 · ${(usage.input + usage.output + usage.cacheRead + usage.cacheWrite).toLocaleString()} Token` + (usage.unknown ? ` · ${usage.unknown} 次用量未知，预留 ${usage.reserved}` : '');
    $('knowledge-failure').hidden = !knowledgeJob.failure; $('knowledge-failure').textContent = knowledgeJob.failure || '';
  }
  $('knowledge-pause').hidden = !data.canInitialize || !busy;
  $('knowledge-continue').hidden = !data.canInitialize || knowledgeJob === null || busy || knowledgeJob.state === 'complete';
  const key = JSON.stringify([projectKnowledge?.id, projectKnowledge?.currentSourceHash, projectKnowledge?.modules.map(item => [item.content.id, item.state, item.invalidatedBy])]);
  if (key !== knowledgeKey) { knowledgeKey = key; showProjectKnowledge(); }
  $('context-map').hidden = projectMap === null;
  if (projectMap !== null) showMapFiles();
  $('context-history').hidden = data.history === null; $('context-documents').replaceChildren();
  if (data.history !== null) for (const doc of data.history.documents) {
    const details = document.createElement('details'), summary = document.createElement('summary'), article = document.createElement('article');
    summary.textContent = doc.name + ' · ' + new Date(data.history.at).toLocaleDateString('zh-CN'); article.className = 'requirement-document';
    renderDocument(doc.text, article); details.append(summary, article); $('context-documents').append(details);
  }
  clearTimeout(contextTimer);
  if (busy && $('context-dialog').open) contextTimer = setTimeout(() => loadProjectContext().catch(error => notice('项目理解同步失败：' + error.message)), 1500);
}
$('context-toggle').onclick = perform(async () => { knowledgeKey = ''; $('context-dialog').showModal(); $('context-status').textContent = '读取项目资料…'; await loadProjectContext(); });
$('context-close').onclick = () => { clearTimeout(contextTimer); $('context-dialog').close(); };
$('context-dialog').addEventListener('close', () => clearTimeout(contextTimer));
$('context-query').oninput = showMapFiles;
$('context-build').onclick = perform(async () => {
  $('context-build').disabled = true; $('context-status').textContent = '正在建立源码索引…';
  try { await api('/project-context/index', {}); await loadProjectContext(); } finally { $('context-build').disabled = false; }
});
$('knowledge-scope').oninput = () => { scopeDirty = true; };
$('initialization-budget-form').oninput = () => { initializationBudgetDirty = true; };
$('initialization-budget-form').onsubmit = perform(async () => {
  const budget = Object.fromEntries(['tokens', 'requests', 'repairCycles', 'runMs'].map(name => [name, Number($('initialization-' + name).value) * (name === 'runMs' ? 1000 : 1)]));
  await api('/initialization-budget', budget, 'PUT'); initializationBudgetDirty = false;
  await loadProjectContext(); notice('初始化独立预算已保存，需求任务预算与既有授权保持不变。');
});
$('knowledge-form').onsubmit = perform(async () => {
  $('knowledge-start').disabled = true;
  try { await api('/project-context/initialize', { scope: $('knowledge-scope').value.trim() }); scopeDirty = false; await loadProjectContext(); }
  finally { await loadProjectContext(); }
});
$('knowledge-pause').onclick = perform(async () => { await api(`/project-context/jobs/${knowledgeJob.id}/pause`, {}); await loadProjectContext(); });
$('knowledge-continue').onclick = perform(async () => { await api(`/project-context/jobs/${knowledgeJob.id}/continue`, {}); await loadProjectContext(); });
async function loadSettings() {
  const epoch = generation, projectId = activeProject;
  const sources = await api('/project-sources');
  if (epoch !== generation || projectId !== activeProject) return;
  let value, problem = null;
  try { value = await api('/settings'); }
  catch (error) { if (![400, 404].includes(error.status)) throw error; value = null; problem = error.message; }
  if (epoch !== generation || projectId !== activeProject) return;
  settings = value; sourceInfo = sources; settingsProblem = problem;
  if (settings === null) notice('当前项目执行设置不可用：' + settingsProblem + '。执行已禁用；仍可查看需求及写入恢复，创建时请明确选择已配置的项目。');
  for (const id of ['new-task', 'empty-new']) { $(id).hidden = !session.principal.roles.some(role => ['product', 'admin'].includes(role)); $(id).disabled = false; }
}
function showSources(node, sources) {
  node.replaceChildren();
  const names = { root: '项目根目录', frontend: '前端源码', backend: '后端源码' };
  for (const source of sources) {
    const item = document.createElement('p');
    item.textContent = names[source.kind] + '：' + source.directory + (source.prefix ? '（文件定位：' + source.prefix + '/）' : '');
    node.append(item);
  }
}
const roles = ['requirement', 'development', 'review'];
const field = (node, name) => node.querySelector(`[data-field="${name}"]`);
function modelOptions() {
  const choices = [...$('providers').children].flatMap(provider => [...provider.querySelector('[data-models]').children]
    .map(model => [field(provider, 'id').value.trim(), field(model, 'id').value.trim()]));
  for (const role of roles) {
    const select = $('model-' + role), previous = select.value; select.replaceChildren(); option(select, '', '请选择模型');
    for (const [provider, model] of choices) if (provider && model) option(select, JSON.stringify({ provider, model }), `${provider} / ${model}`);
    select.value = previous;
  }
}
function addModel(provider, value) {
  const node = $('model-template').content.firstElementChild.cloneNode(true);
  if (value) for (const name of ['id', 'contextWindow', 'maxTokens', 'reasoning']) {
    const input = field(node, name); if (input.type === 'checkbox') input.checked = value[name]; else input.value = value[name];
  }
  field(node, 'image').checked = value ? value.input.includes('image') : false;
  field(node, 'text').checked = value ? value.input.includes('text') : true;
  node.querySelector('[data-remove-model]').onclick = () => { node.remove(); modelOptions(); };
  node.querySelector('[data-test-model]').onclick = perform(async event => {
    event.target.disabled = true;
    try { const result = await api('/model-connection', { provider: field(provider, 'id').value, model: field(node, 'id').value });
      notice(`模型 ${result.model} 连接成功。此次测试已发送一条真实请求。`);
    } finally { event.target.disabled = false; }
  });
  field(node, 'id').oninput = modelOptions; provider.querySelector('[data-models]').append(node); modelOptions();
}
function addProvider(value) {
  const node = $('provider-template').content.firstElementChild.cloneNode(true);
  if (value) {
    node.dataset.credentialId = value.credentialId;
    for (const name of ['id', 'baseUrl', 'systemRole', 'outputLimitField']) field(node, name).value = value[name];
    field(node, 'thinkingToggle').checked = value.thinkingToggle;
    field(node, 'apiKey').placeholder = '已保存加密凭据，留空保留';
  }
  field(node, 'apiKey').required = !value;
  field(node, 'id').oninput = modelOptions;
  node.querySelector('[data-remove-provider]').onclick = () => { node.remove(); modelOptions(); };
  node.querySelector('[data-add-model]').onclick = () => addModel(node);
  $('providers').append(node);
  if (value) for (const model of value.models) addModel(node, model); else addModel(node);
}
function addUnitCheck(value, editable) {
  const node = document.createElement('fieldset'); node.dataset.checkId = value ? value.id : crypto.randomUUID();
  const input = (name, label, content) => {
    const wrapper = document.createElement('label'), control = document.createElement('input');
    wrapper.textContent = label; control.dataset.field = name; control.value = content; control.required = true;
    control.disabled = !editable; wrapper.append(control); node.append(wrapper); return control;
  };
  input('name', '检查名称', value ? value.name : '');
  input('commandLine', '执行命令', value ? value.command.map(part => "'" + part.replaceAll("'", "'\\''") + "'").join(' ') : '');
  input('cwd', '工作目录（相对于隔离现场）', value ? value.cwd : '.');
  const coverage = document.createElement('div'); coverage.textContent = '覆盖来源';
  for (const source of sourceInfo.sources) {
    const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    checkbox.value = source.id; checkbox.dataset.source = source.id; checkbox.checked = value ? value.sources.includes(source.id) : false;
    checkbox.disabled = !editable; label.append(checkbox, { root: '项目根目录', frontend: '前端', backend: '后端' }[source.id]); coverage.append(label);
  }
  node.append(coverage); const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除此检查';
  remove.disabled = !editable; remove.onclick = () => node.remove(); node.append(remove); $('unit-checks').append(node);
}
$('add-check').onclick = () => addUnitCheck(null, true);
async function openSettings() {
  await loadSettings(); $('settings-form').reset(); $('unit-form').reset(); $('settings-status').textContent = ''; $('providers').replaceChildren();
  const admin = session.principal.roles.includes('admin');
  showSources($('settings-sources'), sourceInfo.sources);
  const engineering = admin || session.principal.roles.includes('developer');
  $('model-form').disabled = !admin; $('policy-form').disabled = !admin;
  $('settings-permission').textContent = admin ? '管理员可修改模型、凭据与执行策略。' : engineering ? '模型和执行策略由管理员维护；测试入口自动识别，研发可维护自定义工程检查。' : '产品可查看执行设置，Pi 随实现补充测试，工程检查由研发维护。';
  $('save-settings').hidden = !admin; $('save-unit').disabled = !settings || !engineering; $('add-check').disabled = !engineering;
  $('unit-checks').replaceChildren();
  if (settings) {
    for (const provider of settings.providers) addProvider(provider);
    for (const role of roles) $('model-' + role).value = JSON.stringify({ provider: settings.models[role].provider, model: settings.models[role].model });
    for (const [name, value] of Object.entries(settings.budget)) $('budget-' + name).value = name === 'runMs' ? value / 1000 : value;
    $('snapshot-bytes').value = settings.maxSnapshotBytes; $('excluded-paths').value = settings.excludedPaths.join('\n');
    $('runtime-dependencies').value = settings.runtimeDependencies.join('\n');
    for (const check of settings.unitChecks) addUnitCheck(check, engineering);
  } else { addProvider(); modelOptions(); }
  $('settings-dialog').showModal(); $('settings-dialog').scrollTop = 0;
}
$('settings-toggle').onclick = perform(openSettings);
$('settings-close').onclick = () => $('settings-dialog').close();
$('add-provider').onclick = () => addProvider();
$('change-password').onclick = () => { $('settings-dialog').close(); $('password-dialog').showModal(); };
$('settings-form').onsubmit = perform(async () => {
  const providers = [...$('providers').children];
  if (!providers.length || providers.some(node => !node.querySelector('[data-models]').children.length)) throw new Error('请为每个供应商至少填写一个模型');
  const config = { version: 1, models: Object.fromEntries(roles.map(role => [role, JSON.parse($('model-' + role).value)])),
    providers: providers.map(node => ({ id: field(node, 'id').value.trim(), baseUrl: field(node, 'baseUrl').value.trim(),
      credentialId: node.dataset.credentialId, thinkingToggle: field(node, 'thinkingToggle').checked,
      systemRole: field(node, 'systemRole').value, outputLimitField: field(node, 'outputLimitField').value,
      models: [...node.querySelector('[data-models]').children].map(model => ({ id: field(model, 'id').value.trim(),
        contextWindow: Number(field(model, 'contextWindow').value), maxTokens: Number(field(model, 'maxTokens').value),
        reasoning: field(model, 'reasoning').checked,
        input: ['text', 'image'].filter(kind => field(model, kind).checked) })) })),
    unitChecks: settings ? settings.unitChecks : [], maxSnapshotBytes: Number($('snapshot-bytes').value),
    excludedPaths: $('excluded-paths').value.trim() ? $('excluded-paths').value.trim().split('\n').map(s => s.trim()) : [],
    runtimeDependencies: $('runtime-dependencies').value.trim() ? $('runtime-dependencies').value.trim().split('\n').map(s => s.trim()) : [],
    budget: Object.fromEntries(['tokens', 'requests', 'repairCycles', 'runMs'].map(name => [name, Number($('budget-' + name).value) * (name === 'runMs' ? 1000 : 1)])) };
  $('save-settings').disabled = true;
  try {
    for (const [index, node] of providers.entries()) if (field(node, 'apiKey').value) {
      const result = await api('/model-credentials', { apiKey: field(node, 'apiKey').value });
      node.dataset.credentialId = result.id; config.providers[index].credentialId = result.id;
      field(node, 'apiKey').value = ''; field(node, 'apiKey').required = false;
      field(node, 'apiKey').placeholder = '已保存加密凭据，留空保留';
    }
    await api('/settings', config, 'PUT'); await loadSettings(); $('save-unit').disabled = false;
    notice('模型与执行设置已保存。已有任务需重新确认开工授权，累计用量保留。'); if (selected) await refresh();
  } finally { $('save-settings').disabled = false; }
});
$('unit-form').onsubmit = perform(async () => {
  const checks = [...$('unit-checks').children].map(node => ({ id: node.dataset.checkId,
    name: field(node, 'name').value.trim(), commandLine: field(node, 'commandLine').value.trim(), cwd: field(node, 'cwd').value.trim(),
    sources: [...node.querySelectorAll('[data-source]:checked')].map(input => input.value) }));
  await api('/unit-checks', { checks }, 'PUT'); await loadSettings();
  notice('工程检查已保存。留空时自动识别测试入口；已有任务需重新确认开工授权。'); if (selected) await refresh();
});
function editUser(user, action) {
  $('user-form').reset(); $('user-action').value = action; $('user-id').value = user ? user.id : crypto.randomUUID();
  $('user-name').value = user ? user.username : ''; $('user-name').readOnly = action !== 'create';
  $('user-heading').textContent = action === 'create' ? '新建用户' : `${action === 'roles' ? '修改角色' : '重置密码'} · ${user.username}`;
  $('user-password-label').hidden = action === 'roles'; $('user-password').disabled = action === 'roles';
  $('user-roles').disabled = action === 'password';
  for (const input of $('user-roles').querySelectorAll('input')) input.checked = user ? user.roles.includes(input.value) : false;
}
async function loadUsers() {
  const data = await api('/users'); $('users-list').replaceChildren();
  for (const user of data.users) {
    const row = document.createElement('section'); row.className = 'provider-editor';
    const title = document.createElement('p'); title.textContent = `${user.username} · ${user.roles.join(' / ')}${user.mustChangePassword ? ' · 待修改临时密码' : ''}`;
    row.append(title);
    for (const [action, text] of [['roles', '修改角色'], ['password', '重置密码']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
      button.onclick = () => editUser(user, action); row.append(button);
    }
    $('users-list').append(row);
  }
}
$('users-toggle').onclick = perform(async () => { await loadUsers(); editUser(null, 'create'); $('users-status').textContent = ''; $('users-dialog').showModal(); });
$('users-close').onclick = () => $('users-dialog').close();
$('user-new').onclick = () => editUser(null, 'create');
$('user-form').onsubmit = perform(async () => {
  const result = await api('/users', { action: $('user-action').value, id: $('user-id').value, username: $('user-name').value,
    password: $('user-password').value, roles: [...$('user-roles').querySelectorAll('input:checked')].map(node => node.value) });
  $('user-password').value = '';
  if (result.id === session.principal.id) { location.reload(); return; }
  await loadUsers(); editUser(null, 'create'); notice('用户已保存。');
});
let directoryCurrent = null, directoryParent = null, directorySelected = null, directoryLoad = 0, directoryTarget = 'import-directory';
async function loadDirectory(path) {
  const load = ++directoryLoad; directoryCurrent = null; directoryParent = null; directorySelected = null;
  $('directory-path').value = path;
  $('directory-select').disabled = true; $('directory-up').disabled = true; $('directory-controls').disabled = true;
  $('directory-list').replaceChildren(); $('directory-selection').textContent = '正在读取目录…'; $('directory-status').textContent = '';
  try {
    const data = await api('/directories?path=' + encodeURIComponent(path));
    if (load !== directoryLoad) return;
    directoryCurrent = data.path; directoryParent = data.parent; directorySelected = data.path;
    $('directory-path').value = data.path; $('directory-up').disabled = data.parent === data.path;
    $('directory-selection').textContent = '已选择：' + data.path; $('directory-select').disabled = false;
    if (!data.entries.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = '此目录没有子文件夹，可直接选择当前目录。'; $('directory-list').append(p); }
    for (const entry of data.entries) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '📁 ' + entry.name;
      button.onclick = () => {
        directorySelected = entry.path; $('directory-selection').textContent = '已选择：' + entry.path;
        for (const row of $('directory-list').children) row.classList.toggle('selected', row === button);
      };
      button.ondblclick = perform(() => loadDirectory(entry.path)); $('directory-list').append(button);
    }
  } finally { if (load === directoryLoad) { $('directory-controls').disabled = false;
    if (directoryCurrent === null) $('directory-selection').textContent = '目录读取失败，请修改路径或返回主目录。'; } }
}
$('import-browse').onclick = perform(async () => {
  directoryTarget = 'import-directory';
  $('directory-dialog').showModal(); const input = $('import-directory').value.trim();
  await loadDirectory(input ? input : session.directoryHome);
});
for (const name of ['frontend', 'backend']) $('import-' + name + '-browse').onclick = perform(async () => {
  directoryTarget = 'import-' + name; $('directory-dialog').showModal();
  await loadDirectory($(directoryTarget).value.trim() || session.directoryHome);
});
function importMode() {
  const split = $('import-mode').value === 'split'; $('import-root').hidden = split; $('import-split').hidden = !split;
  $('import-directory').disabled = split; $('import-directory').required = !split;
  for (const name of ['frontend', 'backend']) { $('import-' + name).disabled = !split; $('import-' + name).required = split; }
}
$('import-mode').onchange = importMode;
$('directory-path-form').onsubmit = perform(() => loadDirectory($('directory-path').value.trim()));
$('directory-up').onclick = perform(() => loadDirectory(directoryParent));
$('directory-home').onclick = perform(() => loadDirectory(session.directoryHome));
$('directory-cancel').onclick = () => { directoryLoad++; $('directory-dialog').close(); };
$('directory-dialog').oncancel = () => { directoryLoad++; };
$('directory-select').onclick = () => { $(directoryTarget).value = directorySelected; directoryLoad++; $('directory-dialog').close(); };
$('import-toggle').onclick = () => { $('import-form').reset(); importMode(); $('import-status').textContent = ''; $('import-dialog').showModal(); };
$('import-close').onclick = () => $('import-dialog').close();
$('import-form').onsubmit = perform(async event => {
  event.submitter.disabled = true;
  try {
    const selection = $('import-mode').value === 'root' ? { directory: $('import-directory').value }
      : { frontendDir: $('import-frontend').value, backendDir: $('import-backend').value };
    const project = await api('/projects', { name: $('import-name').value, ...selection });
    await api('/project', { projectId: project.id }); activeProject = project.id; $('import-dialog').close();
    selected = null; $('task').hidden = true; $('empty').hidden = false; await boot(); await openSettings();
  } finally { event.submitter.disabled = false; }
});
boot().catch(error => notice(error.message));

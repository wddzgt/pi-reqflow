const $ = id => document.getElementById(id);
export let centerView = 'mine';
let filters = { range: 'all', q: '', state: '', owner: '', developer: '', sort: 'updated-desc', limit: '25' };
let cursor = null, next = null, previous = null, renderedRows = '', blocked = false;
let projectScopeKey = '';
let position = null;
export function centerCreationProject() { return blocked || filters.range === 'all' ? '' : filters.range; }
export function rememberCenterPosition() {
  if ($('empty').hidden) return;
  const focus = document.activeElement;
  position = { cursor, x: window.scrollX, y: window.scrollY,
    horizontal: document.querySelector('.center-table').scrollLeft,
    task: focus?.dataset.task, project: focus?.dataset.project };
}
export function restoreCenterPosition() {
  if (!position || position.cursor !== cursor) return;
  const button = [...$('center-rows').querySelectorAll('button')].find(node =>
    node.dataset.task === position.task && node.dataset.project === position.project);
  button?.focus({ preventScroll: true });
  document.querySelector('.center-table').scrollLeft = position.horizontal;
  window.scrollTo(position.x, position.y);
}
export function resetCenter() {
  centerView = 'mine'; cursor = null; renderedRows = ''; blocked = false; position = null;
  filters = { range: 'all', q: '', state: '', owner: '', developer: '', sort: 'updated-desc', limit: '25' };
  $('center-filter').reset(); $('center-limit').value = '25';
  $('center-failures').hidden = true; $('center-updates').hidden = true;
  for (const button of $('center-views').children) button.setAttribute('aria-pressed', String(button.dataset.view === centerView));
}
export function restartCenterQuery() { cursor = null; blocked = false; renderedRows = ''; }
export function configureCenter(projects) {
  const scope = JSON.stringify(projects.map(project => project.id));
  if (scope !== projectScopeKey) { cursor = null; blocked = false; position = null; projectScopeKey = scope; }
  const select = $('center-range'); select.replaceChildren();
  const all = document.createElement('option'); all.value = 'all'; all.textContent = '全部项目'; select.append(all);
  for (const project of projects) { const option = document.createElement('option'); option.value = project.id; option.textContent = project.name; select.append(option); }
  if (filters.range !== 'all' && !projects.some(project => project.id === filters.range)) {
    const unavailable = document.createElement('option'); unavailable.value = filters.range; unavailable.textContent = '原项目已不可用'; select.append(unavailable);
    cursor = null;
  }
  select.value = filters.range;
}
export function centerRequest(recent) {
  if (blocked) return null;
  const params = new URLSearchParams({ ...filters, view: centerView, recent: JSON.stringify(recent.map(({ id, projectId }) => ({ id, projectId }))) });
  if (cursor) params.set('cursor', cursor);
  return params;
}
export function centerError(error) {
  $('center-failures').hidden = false; $('center-failures').textContent = '查找失败：' + error.message + '。当前条件保留，可点击“重新查找”。';
  if (![403, 409, 503].includes(error.status)) return false;
  blocked = true; cursor = null; next = null; previous = null; renderedRows = ''; position = null;
  $('center-owners').replaceChildren(); $('center-developers').replaceChildren();
  $('center-rows').replaceChildren(); $('center-prev').disabled = true; $('center-next').disabled = true;
  $('center-status').textContent = '旧查询已失效，条件已保留，请重新查找。';
  $('center-updates').hidden = true; return error.code !== 'QUERY_EXPIRED';
}
export function renderCenter(data, labels, open) {
  const { tasks } = data;
  cursor = `${data.snapshot}:${data.offset}`; next = data.next; previous = data.previous;
  $('center-next').disabled = next === null; $('center-prev').disabled = previous === null;
  $('center-updates').hidden = !data.updatesAvailable;
  $('center-failures').hidden = !data.incomplete;
  $('center-failures').textContent = data.incomplete ? '本次结果不完整，以下项目未能计入完整查询：' + data.failures.map(item => item.projectName).join('、') + '。请核查后重新查找。' : '';
  const empty = data.emptyReason === 'no-visible-tasks' ? '当前权限下没有可查看的需求。'
    : centerView === 'mine' && !filters.q && !filters.state && !filters.owner && !filters.developer ? '当前没有需要你处理的需求。可切换“进行中”或“全部”。' : '没有符合当前条件的需求。';
  $('center-status').textContent = tasks.length ? `第 ${data.offset + 1} -- ${data.offset + tasks.length} 条 / ${data.total === null ? '至少 ' + data.knownCount + ' 条，尚未统计完整' : '共 ' + data.total + ' 条'}` : (data.incomplete ? '当前没有可展示的结果，仍有项目读取失败。' : empty);
  for (const [id, values] of [['center-owners', data.facets.owners], ['center-developers', data.facets.developers]]) {
    $(id).replaceChildren(); for (const person of values) { const option = document.createElement('option'); option.value = person.id; option.label = person.name; $(id).append(option); }
  }
  const key = JSON.stringify([data.snapshot, data.offset, tasks]);
  if (key === renderedRows) return;
  renderedRows = key;
  $('center-rows').replaceChildren();
  for (const task of tasks) {
    const row = document.createElement('tr');
    const name = document.createElement('td'), button = document.createElement('button'), project = document.createElement('small');
    project.textContent = task.projectName; button.textContent = task.title; button.title = '需求编号：' + task.id;
    button.dataset.task = task.id; button.dataset.project = task.projectId;
    button.onclick = () => open(task.id, task.projectId); name.append(project, button); row.append(name);
    for (const text of [labels[task.state], `${task.ownerName} / ${task.developerName ?? '待指定'}`,
      task.nextAction + (task.responsibleName ? ` · ${task.responsibleName}` : ''), new Date(task.updatedAt).toLocaleString('zh-CN', { hour12: false })]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    $('center-rows').append(row);
  }
}
export function wireCenter(refresh) {
  const refreshFrom = value => { cursor = value; blocked = false; position = null; refresh(); };
  for (const button of $('center-views').children) button.onclick = () => {
    centerView = button.dataset.view;
    for (const node of $('center-views').children) node.setAttribute('aria-pressed', String(node === button));
    refreshFrom(null);
  };
  $('center-filter').onsubmit = event => {
    event.preventDefault();
    filters = { range: $('center-range').value, q: $('center-query').value.trim(), state: $('center-state').value,
      owner: $('center-owner').value.trim(), developer: $('center-developer').value.trim(), sort: $('center-sort').value, limit: $('center-limit').value };
    refreshFrom(null);
  };
  $('center-reset').onclick = () => { resetCenter(); refresh(); };
  $('center-refresh').onclick = () => refreshFrom(null);
  $('center-next').onclick = () => refreshFrom(next);
  $('center-prev').onclick = () => refreshFrom(previous);
  $('center-limit').onchange = () => { filters.limit = $('center-limit').value; refreshFrom(null); };
}

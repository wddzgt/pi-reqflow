const $ = id => document.getElementById(id);
let task = null;
let kind = 'info', epoch = 0;
let pages = {};
const searches = {};
const searchDrafts = {};
export function updateRecordTask(value) {
  if (task && (task.id !== value.id || task.projectId !== value.projectId)) { closeRecordPanel(); $('review-details').open = false; pages = {}; for (const key of Object.keys(searches)) delete searches[key]; for (const key of Object.keys(searchDrafts)) delete searchDrafts[key]; kind = 'info'; }
  if (task) {
    const changed = [];
    if (task.check?.logHash !== value.check?.logHash || task.check?.log !== value.check?.log) changed.push('unit');
    if (task.session !== value.session) changed.push('pi');
    for (const key of changed) if (pages[key]) pages[key].stale = true;
    if (changed.includes(kind)) {
      epoch++;
      if ($('records-panel').open) $('records-status').textContent = '记录来源已更新，请点击刷新记录。';
    }
  }
  task = value;
  const reviewNext = showReviewResult();
  if (kind === 'info' && $('records-panel').open) showInfo();
  return reviewNext;
}
export function closeRecordPanel() { epoch++; $('records-panel').close(); }
function reviewDetails(review, heading) {
  return [heading,
    ...review.report.checks.map(item => `${({ requirements: '需求实现', regression: '相关原行为', tests: '关键测试' })[item.id]}：${({ passed: '已核对', blocked: '有阻断', missing: '缺材料', pending: '未检查' })[item.status]}\n依据：${item.basis}`),
    ...review.report.issues.map(item => `问题：${item.file}:${item.line}\n${item.problem}\n触发：${item.trigger}\n影响：${item.impact}\n需要修复：${item.requiredChange}`),
    ...review.report.missingEvidence.map(item => `需补充：${item.missing}\n原因：${item.reason}`)].join('\n\n');
}
function showReviewResult() {
  const imported = task.importedReview;
  const latest = task.review ?? imported;
  const stopped = task.state === 'attention' && task.halt === 'review_incomplete';
  const outcome = latest ? ({ passed: '审核通过', changes_requested: '审核退回', needs_evidence: '审核等待补充材料' })[latest.outcome] : '待审核';
  $('review-result').hidden = false;
  $('review-heading').textContent = stopped ? '审核未完成' : outcome;
  $('review-source').textContent = latest?.originTaskId ? '历史审核（隔离实测）' : latest ? (latest.current ? '本任务审核' : '历史审核（旧版本）') : '';
  const issue = latest?.report.issues[0], gap = latest?.report.missingEvidence[0];
  const reason = stopped ? task.failure : latest?.outcome === 'needs_evidence' ? `缺少材料：${gap.missing}（${gap.reason}）`
    : issue ? `退回原因：${issue.problem}` : '';
  $('review-reason').textContent = reason.length > 240 ? reason.slice(0, 240) + '…' : reason;
  $('review-supplement').textContent = imported ? (imported.matchesVersion ? '' : '旧版本 · ') + ({
    passed: 'Chrome 补验已通过。真实拖拽、计数和撤销均通过。',
    incomplete: 'Chrome 补验记录未满足全部断言。',
    unavailable: 'Chrome 补验证据无法核对。'
  })[imported.browser] : '';
  $('review-next').textContent = stopped ? task.presentation.next
    : latest?.originTaskId && latest.matchesVersion && latest.browser === 'passed' && latest.outcome !== 'passed' ? '下一步：待复查。请结合补验证据核对原退回项。'
    : latest && !latest.current ? '下一步：按当前项目和需求版本重新审核。'
    : latest?.outcome === 'changes_requested' ? '下一步：研发处理退回问题，再复查。'
    : latest?.outcome === 'needs_evidence' ? '下一步：补齐必要材料，再复查。'
    : latest?.outcome === 'passed' ? '下一步：' + task.presentation.next : '';
  $('review-details').hidden = !latest;
  $('review-basis').textContent = [
    latest ? reviewDetails(latest, latest.originTaskId ? `原隔离任务：${latest.originTaskId}` : '审核清单') : '',
    latest && imported && latest !== imported ? reviewDetails(imported, `历史隔离审核：${imported.originTaskId}`) : ''
  ].filter(Boolean).join('\n\n');
  for (const id of ['review-source', 'review-reason', 'review-supplement', 'review-next']) $(id).hidden = !$(id).textContent;
  return $('review-next').textContent;
}
function showInfo() {
  if (!task) return;
  $('records-source').textContent = '当前任务执行信息；原始错误保留供研发核查。';
  $('records-content').textContent = [
    `任务：${task.title}`, `工作区：${task.workspace}`,
    task.check ? '必要检查：\n' + task.check.checks.map(check =>
      `${check.name} · ${check.cwd} · ${check.sources.join('、')}\n${check.command.join(' ')}\n退出码：${check.code}`).join('\n\n') : '尚无单测记录。',
    task.failure ? `原始停止原因：${task.failure}` : '当前没有已记录的停止原因。',
    task.review ? reviewDetails(task.review, task.review.current ? '当前版本审核清单：' : '历史版本审核清单（不作为当前通过依据）：') : '',
    task.importedReview ? reviewDetails(task.importedReview, `历史隔离审核：${task.importedReview.originTaskId}`) : '',
    task.importedReview ? $('review-supplement').textContent : '',
    !task.review && !task.importedReview ? '尚无有效代码审核报告。' : ''
  ].filter(Boolean).join('\n\n');
}
function renderPage() {
  for (const button of $('records-tabs').children) button.setAttribute('aria-pressed', String(button.dataset.record === kind));
  $('records-more').hidden = true;
  $('records-prev').hidden = kind === 'info' || !pages[kind]?.history?.length;
  $('records-search').hidden = kind === 'info';
  $('records-download').disabled = kind !== 'info' && !pages[kind]?.available;
  renderSearch();
  if (kind === 'info') return showInfo();
  const page = pages[kind];
  if (!page) { $('records-content').textContent = ''; $('records-source').textContent = ''; return; }
  $('records-content').textContent = page.text;
  $('records-content').scrollTop = page.scroll;
  $('records-source').textContent = page.available ? `${page.source} · 字节 ${page.start} -- ${page.end} / ${page.total}；当前显示一个片段。` : page.source;
  if (page.stale) $('records-status').textContent = '记录来源已更新；当前片段属于旧来源，请点击刷新记录。';
  $('records-more').hidden = !page.available || page.next === null;
}
async function loadPage(offset = 0, refresh = false, backwards = false) {
  if (kind === 'info') { $('records-status').textContent = ''; return showInfo(); }
  const id = task.id, selectedKind = kind, request = ++epoch;
  const previous = pages[kind]; const params = new URLSearchParams({ projectId: task.projectId });
  if (!refresh && previous?.version) params.set('version', previous.version);
  params.set('offset', String(offset));
  $('records-status').textContent = '正在读取记录…';
  try {
    const response = await fetch(`/api/tasks/${id}/records/${selectedKind}/read?${params}`);
    const value = await response.json();
    if (request !== epoch || task.id !== id || kind !== selectedKind) return;
    if (!response.ok) throw new Error(value.error);
    const history = refresh ? [] : [...(previous?.history ?? [])];
    if (backwards) history.pop(); else if (!refresh && previous && previous.start !== offset) history.push(previous.start);
    if (refresh) delete searches[kind];
    pages[kind] = { ...value, scroll: 0, history }; renderPage();
    $('records-status').textContent = value.grown ? '原始记录有新增内容；当前仍是打开时的范围，点击刷新读取新增部分。' : '';
  } catch (error) { if (request === epoch) $('records-status').textContent = error.message; }
}
$('records-tabs').onclick = event => {
  const button = event.target.closest('[data-record]'); if (!button) return;
  if (pages[kind]) pages[kind].scroll = $('records-content').scrollTop;
  epoch++; kind = button.dataset.record; $('records-status').textContent = ''; renderPage();
  if (kind !== 'info' && !pages[kind]) loadPage();
};
$('records-open').onclick = () => { renderPage(); $('records-panel').showModal(); if (kind !== 'info' && !pages[kind]) loadPage(); };
$('records-refresh').onclick = () => loadPage(0, true);
$('records-more').onclick = () => loadPage(pages[kind].next);
$('records-prev').onclick = () => loadPage(pages[kind].history.at(-1), false, true);
$('records-close').onclick = closeRecordPanel;
$('records-panel').addEventListener('close', () => { epoch++; $('records-open').focus({ preventScroll: true }); });
$('records-content').onscroll = () => { if (pages[kind]) pages[kind].scroll = $('records-content').scrollTop; };
$('records-query').oninput = () => { searchDrafts[kind] = $('records-query').value; };

function renderSearch() {
  $('records-results').replaceChildren(); $('records-search-status').textContent = '';
  const search = searches[kind]; $('records-query').value = searchDrafts[kind] ?? search?.query ?? '';
  $('records-search-more').hidden = !search || search.next === null;
  if (!search) return;
  $('records-search-status').textContent = `找到 ${search.matches.length} 处；` + (search.next === null ? '已搜索全文。' : `已扫描 ${search.scannedTo} / ${search.total} 字节，尚未搜索完。`);
  for (const match of search.matches) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `字节 ${match.offset}：${match.text}`; button.onclick = () => loadPage(match.offset);
    $('records-results').append(button);
  }
}
async function searchPage(continuing) {
  const page = pages[kind]; if (!page?.available) throw new Error('请先打开可用记录。');
  const id = task.id, selectedKind = kind, request = ++epoch;
  const prior = continuing ? searches[kind] : null;
  const query = prior ? prior.query : $('records-query').value;
  const params = new URLSearchParams({ projectId: task.projectId, version: page.version, q: query, offset: String(prior?.next ?? 0) });
  $('records-search-status').textContent = '正在搜索…';
  const response = await fetch(`/api/tasks/${id}/records/${selectedKind}/search?${params}`); const result = await response.json();
  if (request !== epoch || task.id !== id || kind !== selectedKind) return;
  if (!response.ok) throw new Error(result.error);
  searches[kind] = { ...result, query, matches: [...(prior?.matches ?? []), ...result.matches] }; renderSearch();
}
function operation(fn) { return async event => { event.preventDefault(); const request = epoch, id = task?.id, tab = kind;
  try { await fn(); } catch (error) { if (id === task?.id && tab === kind && epoch <= request + 1 && $('records-panel').open) $('records-status').textContent = error.message; }
}; }
$('records-search').onsubmit = operation(() => searchPage(false));
$('records-search-more').onclick = operation(() => searchPage(true));
$('records-copy').onclick = operation(async () => {
  await navigator.clipboard.writeText($('records-content').textContent);
  $('records-status').textContent = kind === 'info' ? '已复制执行信息。' : '已复制当前显示片段；完整内容请下载记录。';
});
$('records-download').onclick = operation(async () => {
  const id = task.id, selectedKind = kind;
  let blob;
  if (selectedKind === 'info') blob = new Blob([$('records-content').textContent], { type: 'text/plain;charset=utf-8' });
  else {
    const response = await fetch(`/api/tasks/${id}/records/${selectedKind}/download?projectId=${encodeURIComponent(task.projectId)}&version=${pages[kind].version}`);
    if (!response.ok) throw new Error((await response.json()).error);
    blob = await response.blob();
  }
  if (task.id !== id || kind !== selectedKind || !$('records-panel').open) return;
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${id}-${selectedKind}.txt`;
  link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  $('records-status').textContent = '已读取完整记录并发起下载。';
});

import { randomUUID } from 'node:crypto';
import { sha256 } from '../src/files.js';
import { centerRows, type CenterRow } from './requirement-center.js';
import type { Project, Principal } from './types.js';

const states = ['draft', 'queued', 'running', 'ready', 'accepted', 'done', 'attention'];
const allowed = ['view', 'range', 'q', 'state', 'owner', 'developer', 'sort', 'limit', 'cursor', 'recent'];
type Snapshot = { id: string; at: number; identity: string; key: string; scope: string; rows: CenterRow[];
  visibleVersion: string; incomplete: boolean; failures: Array<{ projectId: string; projectName: string; error: string }> };
function criteria(params: URLSearchParams) {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new Error('需求查找包含未知或重复参数');
  const value = { view: params.get('view') ?? 'mine', range: params.get('range') ?? 'all', q: (params.get('q') ?? '').trim(),
    state: params.get('state') ?? '', owner: (params.get('owner') ?? '').trim(), developer: (params.get('developer') ?? '').trim(),
    sort: params.get('sort') ?? 'updated-desc', limit: params.get('limit') ?? '25' };
  if (!['mine', 'active', 'all'].includes(value.view) || value.state && !states.includes(value.state)
    || !['updated-desc', 'updated-asc'].includes(value.sort) || !/^[1-9]\d*$/.test(value.limit)
    || Number(value.limit) > 100 || value.q.length > 160 || value.owner.length > 100 || value.developer.length > 100)
    throw new Error('需求查找条件无效，单页应为 1 至 100 条');
  return value;
}
export function createCenterQuery() {
  const snapshots = new Map<string, Snapshot>();
  return async (projects: Project[], actor: Principal, params: URLSearchParams, identity: string,
    scopeFailures: Array<{ projectId: string; projectName: string; error: string }> = []) => {
    const filter = criteria(params), limit = Number(filter.limit), key = JSON.stringify(filter);
    if (filter.range !== 'all' && !projects.some(project => project.id === filter.range))
      throw Object.assign(new Error('无权查询该项目范围'), { status: 403 });
    const recent = params.has('recent') ? JSON.parse(params.get('recent')!) : [];
    if (!Array.isArray(recent) || recent.length > 10 || recent.some(item => !item || typeof item !== 'object'
      || Object.keys(item).some(key => !['id', 'projectId'].includes(key)) || typeof item.id !== 'string'
      || typeof item.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || !/^[A-Za-z0-9_-]{1,100}$/.test(item.projectId)))
      throw new Error('最近访问定位无效，最多 10 条');
    const current = await centerRows(projects, actor, 'all', recent);
    const failures = [...scopeFailures, ...current.failures].filter(item => filter.range === 'all' || item.projectId === filter.range);
    const scope = JSON.stringify(projects.map(project => [project.id, project.archive, project.accountsArchive]));
    const visibleVersion = sha256(JSON.stringify(current.tasks));
    const cursor = params.get('cursor'); let snapshot: Snapshot, offset = 0;
    if (cursor !== null) {
      const match = /^([a-f0-9-]{36}):(0|[1-9]\d*)$/.exec(cursor);
      if (!match) throw new Error('分页游标格式无效');
      const found = snapshots.get(match[1]);
      if (!found || Date.now() - found.at > 600000) throw Object.assign(new Error('查询已过期，请保留条件重新查找'), { status: 409, code: 'QUERY_EXPIRED' });
      if (found.identity !== identity) throw Object.assign(new Error('无权读取该查询'), { status: 403 });
      if (found.key !== key) throw new Error('分页条件已改变，请重新查找');
      const visible = new Set(current.tasks.map(row => row.projectId + ':' + row.id));
      if (found.scope !== scope || found.rows.some(row => !visible.has(row.projectId + ':' + row.id)))
        throw Object.assign(new Error('查询可见范围已改变，请重新查找'), { status: 409 });
      snapshot = found; offset = Number(match[2]);
      if (!Number.isSafeInteger(offset) || offset % limit || offset && offset >= snapshot.rows.length) throw new Error('分页位置无效');
    } else {
      const rows = current.tasks.filter(row => (filter.range === 'all' || row.projectId === filter.range)
        && (filter.view === 'all' || (filter.view === 'mine' ? row.mine : row.state !== 'done'))
        && (!filter.q || [row.title, row.id].some(text => text.toLowerCase().includes(filter.q.toLowerCase())))
        && (!filter.state || row.state === filter.state)
        && (!filter.owner || [row.owner, row.ownerName].some(text => text.toLowerCase() === filter.owner.toLowerCase()))
        && (!filter.developer || [row.developer, row.developerName].some(text => text !== null && text.toLowerCase() === filter.developer.toLowerCase())));
      rows.sort((a, b) => (filter.sort === 'updated-desc' ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt.localeCompare(b.updatedAt))
        || a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id));
      if (rows.length > 50000) throw Object.assign(new Error('结果超过单次查询容量，请缩小项目或筛选范围'), { status: 413 });
      for (const [id, item] of snapshots) if (Date.now() - item.at > 600000) snapshots.delete(id);
      while (snapshots.size >= 100 || [...snapshots.values()].reduce((sum, item) => sum + item.rows.length, 0) + rows.length > 100000)
        snapshots.delete(snapshots.keys().next().value!);
      snapshot = { id: randomUUID(), at: Date.now(), identity, key, scope, rows, visibleVersion,
        incomplete: failures.length > 0, failures };
      snapshots.set(snapshot.id, snapshot);
    }
    const incomplete = snapshot.incomplete || failures.length > 0;
    const people = (role: 'owner' | 'developer') => [...new Map(current.tasks.filter(row => row[role] !== null)
      .map(row => [row[role], { id: row[role]!, name: role === 'owner' ? row.ownerName : row.developerName! }])).values()].slice(0, 100);
    return { tasks: snapshot.rows.slice(offset, offset + limit), recent: current.recent, removedRecent: current.removedRecent,
      snapshot: snapshot.id, offset, limit, next: offset + limit < snapshot.rows.length ? `${snapshot.id}:${offset + limit}` : null,
      previous: offset ? `${snapshot.id}:${offset - limit}` : null,
      total: incomplete ? null : snapshot.rows.length, knownCount: snapshot.rows.length, incomplete,
      failures: [...new Map([...snapshot.failures, ...failures].map(item => [item.projectId, item])).values()],
      rebuilt: current.rebuilt, updatesAvailable: visibleVersion !== snapshot.visibleVersion,
      facets: { owners: people('owner'), developers: people('developer') },
      emptyReason: current.tasks.length ? 'no-matches' : 'no-visible-tasks' };
  };
}

import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import type { Task, Project, ImportedCodeReview } from './types.js';
import type { ServerResponse } from 'node:http';
import { directory } from './tasks.js';
import { writeAtomic } from '../src/files.js';

type Kind = 'unit' | 'pi';
type Snapshot = { identity: string; source: string; size: number; ino: number; dev: number; mtime: number;
  bytes: number; viewMtime: number; digest: string };
const builds = new Map<string, Promise<Snapshot>>();
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };

export async function importedBrowserEvidence(project: Project, task: Task, entry: ImportedCodeReview): Promise<'passed' | 'incomplete' | 'unavailable'> {
  const home = directory(project, task.id);
  if (entry.candidateHash !== entry.originalReview.sourceHash || typeof entry.evidenceDirectory !== 'string'
    || path.dirname(entry.evidenceDirectory) !== home || !/^isolated-evidence-[a-zA-Z0-9]+$/.test(path.basename(entry.evidenceDirectory))) return 'unavailable';
  const file = path.join(entry.evidenceDirectory, 'browser.json');
  let proof: unknown;
  try {
    const expected = path.join(await fs.realpath(home), path.basename(entry.evidenceDirectory), 'browser.json');
    if (await fs.realpath(file) !== expected) return 'unavailable';
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return 'unavailable';
    proof = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error: any) {
    if (error instanceof SyntaxError || error.code === 'ENOENT') return 'unavailable';
    throw error;
  }
  if (proof === null || typeof proof !== 'object') return 'unavailable';
  const value = proof as Record<string, unknown>;
  const checks = ['labelPreserved', 'tooltipCorrect', 'hiddenAfterLeave', 'nativeDragIntercepted', 'dragAddedStaticText', 'undoButtonEnabled'];
  if (!checks.every(key => typeof value[key] === 'boolean') || !Array.isArray(value.beforeDrag) || !Array.isArray(value.afterDrag) || !Array.isArray(value.afterUndo)
    || typeof value.countText !== 'string' || typeof value.undoCount !== 'string') return 'unavailable';
  return checks.every(key => value[key] === true) && value.afterDrag.length === value.beforeDrag.length + 1
    && value.afterDrag.at(-1)?.type === 'static-text' && isDeepStrictEqual(value.afterUndo, value.beforeDrag)
    && value.countText === `已添加 ${value.afterDrag.length} 个组件` && value.undoCount === `已添加 ${value.beforeDrag.length} 个组件`
    ? 'passed' : 'incomplete';
}

function integer(value: string | null, defaultValue: number, max: number) {
  if (value === null) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return fail('记录范围必须为非负整数');
  const n = Number(value); if (!Number.isSafeInteger(n) || n > max) return fail('记录范围超过允许上限'); return n;
}
async function digest(file: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function sourceFor(project: Project, task: Task, kind: Kind) {
  const file = kind === 'unit' ? task.check?.log : task.session;
  if (!file) return null;
  const real = await fs.realpath(file); const home = await fs.realpath(directory(project, task.id));
  if (!real.startsWith(home + path.sep)) return fail('记录来源超出当前任务范围', 403);
  const stat = await fs.stat(real); if (!stat.isFile()) return fail('记录来源不是文件');
  const identity = createHash('sha256').update(JSON.stringify([project.root, task.id, kind, real, kind === 'unit' ? task.check!.logHash : task.session])).digest('hex');
  return { file: real, stat, identity };
}
export async function recordSnapshot(project: Project, task: Task, kind: Kind, version: string | null) {
  if (version !== null && !/^[a-f0-9]{64}$/.test(version)) return fail('记录版本无效');
  const source = await sourceFor(project, task, kind);
  if (!source) { if (version) return fail('记录来源已变化，请刷新记录', 409); return null; }
  const home = path.join(directory(project, task.id), 'record-views');
  const key = version ?? createHash('sha256').update(JSON.stringify([source.identity, source.stat.ino, source.stat.dev, source.stat.size, source.stat.mtimeMs])).digest('hex');
  const file = path.join(home, key + '.txt'), metadata = path.join(home, key + '.json');
  let info: Snapshot;
  try { info = JSON.parse(await fs.readFile(metadata, 'utf8')); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    if (version) return fail('记录版本不存在，请刷新记录', 409);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const building = builds.get(file) ?? buildSnapshot(file, source, kind, task);
    builds.set(file, building);
    try { info = await building; } finally { if (builds.get(file) === building) builds.delete(file); }
  }
  if (info.identity !== source.identity || info.ino !== source.stat.ino || info.dev !== source.stat.dev || source.stat.size < info.size || kind === 'unit' && source.stat.size !== info.size ||
      source.stat.size === info.size && source.stat.mtimeMs !== info.mtime) return fail('记录来源已变化，请刷新记录', 409);
  const view = await fs.stat(file);
  if (view.size !== info.bytes || view.mtimeMs !== info.viewMtime) return fail('记录视图已改变，请刷新并核查原始记录', 409);
  return { file, version: key, ...info, grown: source.stat.size > info.size };
}

async function buildSnapshot(file: string, source: NonNullable<Awaited<ReturnType<typeof sourceFor>>>, kind: Kind, task: Task): Promise<Snapshot> {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const projected = temporary + '.text';
  try {
    if (source.stat.size === 0) await fs.writeFile(temporary, '', { mode: 0o600 });
    else await pipeline(createReadStream(source.file, { end: source.stat.size - 1 }), createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
    const originalHash = await digest(temporary);
    if (kind === 'unit' && originalHash !== task.check!.logHash) return fail('单测日志与原始证据不一致', 409);
    const after = await fs.stat(source.file);
    if (after.ino !== source.stat.ino || after.size < source.stat.size || after.size === source.stat.size && after.mtimeMs !== source.stat.mtimeMs)
      return fail('生成视图期间记录发生变化，请刷新', 409);
    if (kind === 'pi') {
      await pipeline(sessionText(temporary), createWriteStream(projected, { mode: 0o600, flags: 'wx' }));
      await fs.rename(projected, file);
    } else await fs.rename(temporary, file);
    const view = await fs.stat(file);
    const info = { identity: source.identity, source: kind === 'unit' ? '单元测试日志' : 'Pi 主会话文本视图',
      size: source.stat.size, ino: source.stat.ino, dev: source.stat.dev, mtime: source.stat.mtimeMs,
      bytes: view.size, viewMtime: view.mtimeMs, digest: await digest(file) };
    await writeAtomic(file.replace(/\.txt$/, '.json'), JSON.stringify(info));
    return info;
  } finally {
    for (const owned of [temporary, projected]) try { await fs.unlink(owned); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function* sessionText(file: string) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { return fail('Pi 会话记录损坏或尚未完成写入，请核查后刷新', 409); }
      if (row.type !== 'message' || !['user', 'assistant'].includes(row.message?.role)) continue;
      if (!Array.isArray(row.message.content)) return fail('Pi 会话文本结构无效');
      for (const part of row.message.content) if (part.type === 'text') {
        if (typeof part.text !== 'string') return fail('Pi 会话文本字段无效');
        if (part.text) yield `[${row.message.role === 'user' ? '任务输入' : 'Pi'}]\n${part.text}\n\n`;
      }
    }
  } finally { lines.close(); input.destroy(); }
}

async function fragment(file: string, offset: number, limit: number, bytes: number) {
  if (offset > bytes) return fail('读取位置超出记录范围');
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(limit, bytes - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length) return fail('记录读取不完整，请刷新', 409);
    if (buffer.length && (buffer[0] & 0xc0) === 0x80) return fail('读取位置不在 UTF-8 字符边界');
    let end = buffer.length;
    while (end && offset + end < bytes) {
      const next = Buffer.alloc(1); await handle.read(next, 0, 1, offset + end);
      if ((next[0] & 0xc0) !== 0x80) break; end--;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
    return { text, end: offset + end };
  } finally { await handle.close(); }
}

export async function readRecord(project: Project, task: Task, kind: Kind, params: URLSearchParams) {
  const limit = integer(params.get('limit'), 16384, 65536); if (limit < 64) return fail('单页至少为 64 字节');
  const offset = integer(params.get('offset'), 0, Number.MAX_SAFE_INTEGER);
  if (offset && !params.get('version')) return fail('续读必须指定记录版本');
  const snapshot = await recordSnapshot(project, task, kind, params.get('version'));
  if (!snapshot) return { available: false, text: '', source: '尚未产生记录' };
  const part = await fragment(snapshot.file, offset, limit, snapshot.bytes);
  return { available: true, source: snapshot.source, version: snapshot.version, text: part.text,
    start: offset, end: part.end, total: snapshot.bytes, next: part.end < snapshot.bytes ? part.end : null, grown: snapshot.grown };
}

export async function searchRecord(project: Project, task: Task, kind: Kind, params: URLSearchParams) {
  const query = params.get('q');
  if (!query || query.length > 256) return fail('请输入 1 至 256 字的搜索内容');
  const offset = integer(params.get('offset'), 0, Number.MAX_SAFE_INTEGER);
  if (!params.get('version')) return fail('搜索必须指定记录版本');
  const snapshot = await recordSnapshot(project, task, kind, params.get('version'));
  if (!snapshot) return fail('尚未产生记录', 404);
  const part = await fragment(snapshot.file, offset, 65536, snapshot.bytes);
  let scanEnd = part.end === snapshot.bytes ? part.text.length : Math.max(1, part.text.length - query.length + 1);
  if (scanEnd < part.text.length && /[\uDC00-\uDFFF]/.test(part.text[scanEnd])) scanEnd--;
  const matches: Array<{ offset: number; text: string }> = [];
  let index = 0;
  while ((index = part.text.indexOf(query, index)) >= 0 && index < scanEnd) {
    matches.push({ offset: offset + Buffer.byteLength(part.text.slice(0, index)), text: part.text.slice(Math.max(0, index - 40), index + query.length + 80) });
    index += query.length;
    if (matches.length === 25) { scanEnd = index; break; }
  }
  const end = offset + Buffer.byteLength(part.text.slice(0, scanEnd));
  return { matches, scannedTo: end, total: snapshot.bytes, next: end < snapshot.bytes ? end : null, version: snapshot.version };
}

export async function downloadRecord(project: Project, task: Task, kind: Kind, version: string | null, res: ServerResponse) {
  if (!version) return fail('下载必须指定记录版本');
  const snapshot = await recordSnapshot(project, task, kind, version);
  if (!snapshot) return fail('尚未产生记录', 404);
  if (await digest(snapshot.file) !== snapshot.digest) return fail('记录视图校验失败', 409);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${task.id}-${kind}.txt"`, 'Content-Length': snapshot.bytes,
    'X-Record-Digest': snapshot.digest });
  await pipeline(createReadStream(snapshot.file), res);
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../src/files.js';

export async function sourceMaterial(root: string, files: Record<string, { hash: string }>, sessions: string[], entryFiles: string[], query: string, maxBytes: number) {
  const ranges: Array<{ file: string; start: number; end: number }> = [];
  for (const session of new Set(sessions)) {
    const rows = (await fs.readFile(session, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    for (const row of rows) if (row.type === 'message' && row.message.role === 'assistant') for (const part of row.message.content) {
      if (part.type !== 'toolCall' || part.name !== 'read') continue;
      const input = part.arguments, file = input.path;
      if (!Object.hasOwn(files, file) || entryFiles.length && !entryFiles.includes(file)) continue;
      const start = Object.hasOwn(input, 'offset') ? input.offset : 1, limit = Object.hasOwn(input, 'limit') ? input.limit : 2000;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(limit) || start < 1 || limit < 1) continue;
      ranges.push({ file, start, end: start + limit - 1 });
    }
  }
  for (const file of entryFiles) if (Object.hasOwn(files, file)) ranges.push({ file, start: 1, end: 40 });
  const cache = new Map<string, string[]>(), chunks = new Map<string, { file: string; start: number; end: number; text: string }>();
  for (const range of ranges) {
    if (!cache.has(range.file)) {
      const bytes = await fs.readFile(path.join(root, range.file));
      if (sha256(bytes) !== files[range.file].hash) throw new Error('准备上下文时源码改变：' + range.file);
      cache.set(range.file, bytes.toString().split('\n'));
    }
    const lines = cache.get(range.file)!;
    for (let start = range.start; start <= Math.min(lines.length, range.end); start += 24) {
      const end = Math.min(start + 23, range.end, lines.length), text = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
      chunks.set(range.file + ':' + start, { file: range.file, start, end, text });
    }
  }
  const words = [...new Set(query.toLowerCase().match(/[a-z][\w$]{2,}|[\u4e00-\u9fff]{2}/g) || [])];
  const ranked = [...chunks.values()].map(chunk => ({ ...chunk, score: words.filter(word => chunk.text.toLowerCase().includes(word)).length }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.start - b.start);
  const selected: string[] = []; let size = 0;
  for (const chunk of ranked) {
    const value = `${chunk.file}:${chunk.start}-${chunk.end}（仅此范围，非全文）\n${chunk.text}\n`;
    if (size + Buffer.byteLength(value) <= maxBytes) { selected.push(value); size += Buffer.byteLength(value); }
  }
  return selected.join('\n');
}
export function conciseKnowledge(value: unknown) {
  return JSON.stringify(value, (key, child) => ['content', 'spanHash', 'quote'].includes(key) ? undefined : child);
}
export function evidenceMaterial(value: unknown, maxBytes: number) {
  const proofs = new Map<string, string>();
  const visit = (item: any) => {
    if (!item || typeof item !== 'object') return;
    if (typeof item.file === 'string' && typeof item.content === 'string' && typeof item.start === 'number')
      proofs.set(`${item.file}:${item.start}-${item.end}`, item.content);
    for (const child of Object.values(item)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
  };
  visit(value); let size = 0; const included: string[] = [], omitted: string[] = [];
  for (const [key, text] of [...proofs.entries()].sort((a, b) => a[1].length - b[1].length)) {
    const block = `${key}\n${text}\n`;
    if (size + Buffer.byteLength(block) <= maxBytes) { included.push(block); size += Buffer.byteLength(block); } else omitted.push(key);
  }
  return included.join('\n') + (omitted.length ? '\n未注入正文的证据（本次审核未覆盖原文，不视为已核对）：' + omitted.join('、') : '');
}

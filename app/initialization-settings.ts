import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import { sha256, writeAtomic } from '../src/files.js';
import { locked } from './tasks.js';
import type { Project, Settings } from './types.js';

const positive = { type: 'integer', minimum: 1 };
const validate = new Ajv({ allErrors: true }).compile({ type: 'object', additionalProperties: false,
  required: ['tokens', 'requests', 'repairCycles', 'runMs'],
  properties: { tokens: positive, requests: positive, repairCycles: positive, runMs: positive } });
export async function initializationBudget(project: Project): Promise<Settings['budget'] | null> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(path.join(project.archive, 'initialization-budget.json'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  if (!validate(value)) throw new Error('初始化预算无效：' + JSON.stringify(validate.errors));
  return value as Settings['budget'];
}
export async function saveInitializationBudget(project: Project, value: unknown, actor: string) {
  if (!validate(value)) throw new Error('初始化预算无效：' + JSON.stringify(validate.errors));
  if (!actor.trim()) throw new Error('初始化预算必须记录操作身份');
  return locked(path.join(project.archive, 'initialization-budget'), async () => {
    const file = path.join(project.archive, 'initialization-budget-events.jsonl'); let text: string;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; text = ''; }
    let previous = null;
    for (const row of text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) {
      if (row.previous !== previous || sha256(JSON.stringify({ ...row, hash: undefined })) !== row.hash) throw new Error('初始化预算审计链损坏');
      previous = row.hash;
    }
    const event: any = { at: new Date().toISOString(), actor, before: await initializationBudget(project), budget: value, previous };
    event.hash = sha256(JSON.stringify(event));
    await writeAtomic(path.join(project.archive, 'initialization-budget.json'), JSON.stringify(value));
    await writeAtomic(file, text + JSON.stringify(event) + '\n');
  });
}

import { Ajv } from 'ajv';

export type SourceRef = { file: string; start: number; end: number; hash?: string; content?: string; spanHash?: string };
export type KnowledgeFact = { id: string; kind: 'business' | 'responsibility' | 'state' | 'invariant'; statement: string;
  audience: 'business' | 'engineering'; evidence: SourceRef[]; dependsOn: string[] };
export type KnowledgeModule = { id: string; facts: KnowledgeFact[]; flows: Array<{ name: string; trigger: string;
  steps: Array<{ action: string; evidence: SourceRef[] }>; relatedModules: string[] }>;
  validation: Array<{ name: string; method: string; evidence: SourceRef[]; limitations: string }>; unknowns: string[] };
export type KnowledgeCatalog = { summary: string; summaryEvidence: SourceRef[]; vocabulary: Array<{ term: string; meaning: string; aliases: string[];
  modules: string[]; evidence: SourceRef[] }>; modules: Array<{ id: string; name: string; purpose: string; entryFiles: string[];
  evidence: SourceRef[] }>; targets: string[]; outsideScope: string[] };
export type KnowledgeReview = { moduleId: string; checkedFacts: string[]; checkedFlows: string[]; catalogReviewed: boolean;
  issues: Array<{ scope: 'catalog' | 'module'; target: string; problem: string; requiredChange: string }> };
const text = { type: 'string', minLength: 1, maxLength: 1200 };
const id = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' };
const strings = { type: 'array', maxItems: 20, uniqueItems: true, items: text };
const object = (properties: object) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: object, minItems = 0, maxItems = 20) => ({ type: 'array', minItems, maxItems, items });
const reference = object({ file: { ...text, description: '当前源码快照中的相对文件路径。' },
  start: { type: 'integer', minimum: 1, description: '起始行（含），从 1 开始。' },
  end: { type: 'integer', minimum: 1, description: '结束行（含），必须 >= start 且 end - start <= 80；单段最多 81 行，较长证据拆成多段。' } });
const evidence = array(reference, 1, 8);
export const factSchema = object({ id, kind: { enum: ['business', 'responsibility', 'state', 'invariant'] },
  statement: text, audience: { enum: ['business', 'engineering'] }, evidence,
  dependsOn: { ...strings, description: '依赖的业务模块编号，只能来自catalog.modules[].id；禁止填写facts[].id。没有跨模块依赖时为空数组。' } });
export const catalogSchema = object({ summary: text, summaryEvidence: evidence,
  vocabulary: array(object({ term: text, meaning: text, aliases: strings, modules: array(id, 1, 8), evidence }), 1, 20),
  modules: array(object({ id, name: text, purpose: text, entryFiles: array(text, 1, 12), evidence }), 1, 12),
  targets: { ...array(id, 1, 8), uniqueItems: true }, outsideScope: strings });
const moduleContent = { facts: array(factSchema, 2, 20),
  flows: array(object({ name: text, trigger: text, steps: array(object({ action: text, evidence }), 1, 10), relatedModules: array(id, 0, 12) }), 1, 8),
  validation: array(object({ name: text, method: text, evidence, limitations: text }), 1, 10), unknowns: strings };
export const moduleSchema = object({ id, ...moduleContent });
export const moduleSubmissionSchema = object(moduleContent);
export const knowledgeReviewSchema = object({ moduleId: id, checkedFacts: { ...array(id, 1, 20), uniqueItems: true },
  checkedFlows: strings, catalogReviewed: { type: 'boolean' },
  issues: array(object({ scope: { enum: ['catalog', 'module'], description: 'catalog：目录摘要或相关模块目录定义错误；module：当前模块事实、链路或证据错误。' },
    target: text, problem: text, requiredChange: text }), 0, 12) });
export const projectFactProposalSchema = object({ moduleId: id, facts: array(factSchema, 1, 6) });
export const projectFactCompletionSchema = object({ proposals: array(projectFactProposalSchema, 0, 8),
  withdrawals: array(object({ moduleId: id, reason: text }), 0, 8) });
export const projectFactReviewSchema = object({ checked: strings, rejected: array(object({ id: text, reason: text }), 0, 20) });
const validator = new Ajv({ allErrors: true });
export function validateKnowledge<T>(schema: object, value: unknown): T {
  const validate = validator.compile(schema);
  if (!validate(value)) throw new Error('项目理解结构无效：' + JSON.stringify(validate.errors));
  return value as T;
}

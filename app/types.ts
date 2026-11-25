export type Role = "requirement" | "development" | "review";
export type ExecutionPhase = 'preparing' | 'requirement' | 'development' | 'unit' | 'review' | 'repair';
export type Principal = { id: string; roles: string[]; authVersion: string; username?: string; mustChangePassword?: boolean };
export type ProjectSource = { id: 'root' | 'frontend' | 'backend'; kind: 'root' | 'frontend' | 'backend'; directory: string; prefix: string };
export type Project = { id: string; name: string; root: string; archive: string; accountsArchive: string; sources: ProjectSource[] };
export type ModelChoice = { provider: string; model: string };
export type UnitCheck = { id: string; name: string; command: string[]; cwd: string; sources: string[] };
export type Settings = {
  version: 1;
  models: Record<Role, ModelChoice>;
  providers: Array<{ id: string; baseUrl: string; credentialId: string; thinkingToggle: boolean;
    systemRole: "system" | "developer"; outputLimitField: "max_tokens" | "max_completion_tokens";
    models: Array<{ id: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: ("text" | "image")[] }> }>;
  unitChecks: UnitCheck[];
  excludedPaths: string[];
  runtimeDependencies: string[];
  maxSnapshotBytes: number;
  budget: { tokens: number; requests: number; repairCycles: number; runMs: number };
};
export type Usage = { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; unknown: number; reserved: number };
export type Issue = { file: string; line: number; problem: string; requiredChange: string };
export const CODE_REVIEW_CHECKS = [
  { id: 'requirements', title: '需求实现' },
  { id: 'regression', title: '直接相关原行为及权限、数据、安全' },
  { id: 'tests', title: '关键测试可信度' }
] as const;
export const CODE_REVIEW_CHECKING_LIMIT = 6;
export type CodeReviewRecord = { reviewId: string; sourceHash: string; logHash: string; requirementRevision: number; policyHash: string;
  outcome: 'passed' | 'changes_requested' | 'needs_evidence'; report: {
    checks: Array<{ id: typeof CODE_REVIEW_CHECKS[number]['id']; status: 'passed' | 'blocked' | 'missing' | 'pending'; basis: string }>;
    issues: Array<Issue & { check: string; trigger: string; impact: string }>;
    missingEvidence: Array<{ check: string; missing: string; reason: string }>; projectFacts: { checked: string[]; rejected: Array<{ id: string; reason: string }> }
  } };
export type ImportedCodeReview = { originTaskId: string; evidenceDirectory: string; candidateHash: string; originalReview: CodeReviewRecord };
export type Check = { sourceHash: string; policyHash: string; checks: Array<UnitCheck & { code: number }>;
  code: number; log: string; logHash: string };
export type ClarificationQuestionKind = "confirm" | "supplement";
export type ClarificationQuestion = { id: string; title: string; body: string; kind: ClarificationQuestionKind;
  options: Array<{ label: string; value: string; recommended: boolean }>; allowOther: boolean };
export type ClarificationAnswer = { id: string; text: string | null };
export type Clarification = { questions: ClarificationQuestion[];
  answers: ClarificationAnswer[] | null; note?: string; askedAt: string; answeredBy?: string; answeredAt?: string };
export const CLARIFICATION_ROUND_LIMIT = 3;
export type DecisionResolution = "open" | "accepted" | "modified" | "pending" | "resolved";
export type PendingDecision = { id: string; question: string; suggestion: string; impact: string; basis: string;
  resolution: DecisionResolution; basedOnRevision: number;
  resolvedBy?: string; resolvedAt?: string; note?: string };
export type ModelDecision = { area: string; decision: string; basis: string; at: string; source?: "model_default" };
export type ImageRecord = { name: string; mimeType: string; width: number; height: number;
  bytes: number; hash: string; at: string; actor: string };
export type Application = { planId: string; planHash: string; direction: 'apply' | 'rollback'; phase: 'pending' | 'complete';
  total: number; written: string[]; reverted: string[]; pendingFile: string | null };
export type Task = {
  deletion?: { actor: string; at: string };
  sources: ProjectSource[];
  application: Application | null;
  id: string; title: string; owner: string; developer: string | null;
  state: "draft" | "queued" | "running" | "ready" | "accepted" | "done" | "attention";
  confirmation: { actor: string; revision: number; at: string } | null;
  acceptance: { actor: string; revision: number; sourceHash: string; policyHash: string; logHash: string; at: string } | null;
  feedback: string | null;
  implementation: { content: string; revision: number; requirementRevision: number; actor: string; at: string } | null;
  version: number; card: string; cardRevision: number; approval: { actor: string; revision: number; at: string; policyHash: string } | null;
  workspace: string; createdAt: string; updatedAt: string; session: string | null; reviewSession: string | null;
  usage: Usage; cycles: number; issues: Issue[]; check: Check | null; sourceHash: string | null;
  failure: string | null; appliedBy: string | null; appliedAt: string | null;
  halt?: 'paused' | 'timeout' | 'budget' | 'rejected' | 'failure' | 'review_incomplete' | 'review_evidence' | null;
  haltPhase?: ExecutionPhase | null;
  clarification: Clarification | null; clarificationRound: number;
  pendingDecisions: PendingDecision[]; images: ImageRecord[]; modelDecisions: ModelDecision[];
};

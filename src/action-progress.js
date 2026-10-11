import { AsyncLocalStorage } from "node:async_hooks";

// Transport-only updates: never become a requirement, plan or audit approval.
export const progressContext = new AsyncLocalStorage();
export const executionContext = new AsyncLocalStorage();
const executions = new Map();

export function executionStatus(key) {
  const run = executions.get(key);
  return run ? { action: run.action, actor: run.actor, status: run.controller.signal.aborted ? "pausing" : "running",
    ...(run.pausedBy ? { pausedBy: run.pausedBy } : {}), startedAt: run.startedAt, elapsedMs: Date.now() - Date.parse(run.startedAt), progress: run.progress } : null;
}

export function pauseExecution(key, actor, administrator = false) {
  const run = executions.get(key);
  if (!run) throw new Error("当前没有正在执行的任务，请刷新状态。");
  if (run.actor !== actor && !administrator) throw new Error("只有启动人或管理员可以暂停本轮执行。");
  const error = new Error("用户已暂停执行，已完成的阶段和现场保留。");
  error.code = "EXECUTION_PAUSED";
  run.pausedBy = actor;
  run.controller.abort(error);
  return executionStatus(key);
}

export async function controlledExecution(key, action, actor, callback) {
  if (executions.has(key)) throw new Error("本任务仍在执行或停止中，请等待现场保存后继续。");
  const run = { action, actor, controller: new AbortController(), startedAt: new Date().toISOString(), progress: null };
  executions.set(key, run);
  try { return await executionContext.run(run, callback); }
  finally { executions.delete(key); }
}

export function executionSignal() { return executionContext.getStore()?.controller.signal; }
export function assertExecutionActive() { executionSignal()?.throwIfAborted(); }

export function reportProgress(message, preview = "", stage = "working") {
  const run = executionContext.getStore();
  if (run) run.progress = { message, stage };
  progressContext.getStore()?.({ message, preview, stage });
}

export function publicPreview(text) {
  const sections = [];
  // Only user-facing structured fields; never thinking blocks, tools or raw JSON.
  const fields = /(?<!\\)"(reply|summary|approach)"\s*:\s*"/g;
  for (const match of text.matchAll(fields)) {
    let value = "";
    for (let i = match.index + match[0].length; i < text.length && value.length < 4000; i++) {
      if (text[i] === '"') break;
      if (text[i] !== "\\") { value += text[i]; continue; }
      const escape = text[++i];
      if (escape === undefined) break;
      if (escape === "u") {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[a-fA-F0-9]{4}$/.test(hex)) break;
        value += String.fromCharCode(parseInt(hex, 16)); i += 4;
      } else {
        const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (!Object.hasOwn(escapes, escape)) break;
        value += escapes[escape];
      }
    }
    if (value.trim()) sections.push(value);
    if (sections.join("\n\n").length >= 4000) break;
  }
  return sections.join("\n\n").slice(0, 4000);
}

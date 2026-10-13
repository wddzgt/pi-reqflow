import MiniSearch from "minisearch";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson, sha256 } from "./files.js";
import { readTask } from "./store.js";

export const historyReasons = ["existing_feature", "business_rule", "compatibility", "duplicate_requirement", "module_impact"];
const archivedStates = new Set(["archived", "archived_test_only"]);
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

export async function readDiscussionEvidence(project, taskId, input) {
  if (!input || !/^[a-f0-9]{64}$/.test(input.eventHash ?? "") || !Number.isSafeInteger(input.offset)
      || input.offset < 0 || !Number.isSafeInteger(input.maxChars) || input.maxChars < 1 || input.maxChars > 3000) throw new Error("Discussion reads require an exact event reference and bounded character range");
  const task = await readTask(project, taskId);
  const event = task.events.find(event => event.hash === input.eventHash && ["intake_draft", "intake_message", "plan_message", "plan_reply", "acceptance_message", "acceptance_reply"].includes(event.type));
  if (!event) throw new Error("Discussion evidence must be a human message or AI plan reply from the current requirement");
  const text = event.type === "intake_draft" ? await fs.readFile(path.join(task.directory, "request.md"), "utf8")
    : ["plan_reply", "acceptance_reply"].includes(event.type) ? JSON.stringify(event.detail.reply)
      : JSON.stringify({ text: event.detail.text, candidate: event.detail.candidate });
  if (input.offset >= text.length) throw new Error("Discussion read offset exceeds the archived message");
  return { taskId, eventHash: event.hash, actor: event.detail.actor, offset: input.offset, totalChars: text.length,
    text: text.slice(input.offset, input.offset + input.maxChars), partial: input.offset > 0 || text.length > input.maxChars,
    note: "Original discussion evidence. AI advice is a proposal, not a confirmed decision. This evidence does not authorize changes to a frozen requirement or approved plan." };
}

export async function readHistoryEvidence(project, id) {
  const task = await readTask(project, id);
  if (!archivedStates.has(task.meta.state)) throw new Error("History evidence requires an accepted archived delivery");
  const { meta, directory } = task;
  const contract = await readJson(path.join(directory, `contract-v${meta.contractVersion}.json`));
  if (sha256(JSON.stringify(contract)) !== meta.contractHash) throw new Error(`Archived contract changed: ${id}`);
  const plan = await fs.readFile(path.join(directory, `plan-v${meta.planVersion}.md`), "utf8");
  if (sha256(plan) !== meta.planHash) throw new Error(`Archived plan changed: ${id}`);
  return { id, title: meta.title, state: meta.state, objective: contract.objective,
    acceptance: contract.acceptance, files: meta.developmentFiles, contractHash: meta.contractHash,
    planHash: meta.planHash, sourceHash: meta.afterHash, eventHash: task.lastHash,
    references: { contract: `tasks/${id}/contract-v${meta.contractVersion}.json`, plan: `tasks/${id}/plan-v${meta.planVersion}.md` },
    note: "Historical delivery evidence only. A test-only delivery may exist only in its isolated workspace. Verify current source before treating any historical feature as present." };
}

export async function searchProjectHistory(project, input) {
  if (!input || typeof input.query !== "string" || !input.query.trim() || input.query.length > 200
      || !historyReasons.includes(input.reason)) throw new Error("History search needs a bounded query and a specific retrieval reason");
  const rows = await readJson(path.join(project.archive, "index.json"));
  const search = new MiniSearch({ fields: ["title", "objective", "acceptance", "files"],
    tokenize: text => [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment) });
  const evidence = new Map();
  for (const row of rows.filter(row => archivedStates.has(row.state))) {
    const record = await readHistoryEvidence(project, row.id);
    evidence.set(record.id, record);
    search.add({ id: record.id, title: record.title, objective: record.objective,
      acceptance: record.acceptance.map(item => item.text).join("\n"), files: record.files.join(" ") });
  }
  const matches = search.search(input.query, { prefix: true, boost: { title: 2, objective: 2 } }).slice(0, 3);
  const results = matches.map(match => {
    const { acceptance, ...record } = evidence.get(match.id);
    return { ...record, title: record.title.slice(0, 100), titlePartial: record.title.length > 100,
      objective: record.objective.slice(0, 200), objectivePartial: record.objective.length > 200,
      files: record.files.slice(0, 3), filesPartial: record.files.length > 3, fileCount: record.files.length, matchedTerms: match.terms,
      summaryOnly: true, acceptanceIds: acceptance.slice(0, 6).map(item => item.id), acceptanceCount: acceptance.length };
  });
  while (results.length > 1 && Buffer.byteLength(JSON.stringify(results)) > 4500) results.pop();
  if (Buffer.byteLength(JSON.stringify(results)) > 4500) throw new Error("One archived summary exceeds the history result budget");
  return { query: input.query, reason: input.reason, results, fewerForBudget: results.length < matches.length,
    note: results.length ? "Bounded historical summaries, not full evidence. Read exact acceptance fragments only when needed; current source remains authoritative." : "No relevant archived evidence found. Do not infer historical behavior." };
}

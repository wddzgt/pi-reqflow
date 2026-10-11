import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import Ajv from "ajv";
import { readModelCredential } from "./model-credentials.js";
import { childEnvironment } from "./execution-env.js";
import { allowedFile, defaultModelUsage, resolveAgentModel } from "./config.js";
import { assertInside, safeId, sha256 } from "./files.js";
import { reportProgress, publicPreview, executionSignal, assertExecutionActive } from "./action-progress.js";

const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "pi-guard.js");

function assistantText(message) {
  return Array.isArray(message.content)
    ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    : "";
}

export async function runPi(project, cwd, phase, prompt, logFile, costLimit, role = null, images = [], executionLimit = null) {
  assertExecutionActive();
  if (typeof costLimit !== "number" || costLimit <= 0) throw new Error("Pi cost limit must be positive");
  if (executionLimit !== null && (!Number.isSafeInteger(executionLimit.maxTokens) || executionLimit.maxTokens < 1))
    throw new Error("Pi execution limit requires a positive token allowance");
  if (executionLimit?.maxRequests !== undefined && (!Number.isSafeInteger(executionLimit.maxRequests) || executionLimit.maxRequests < 1)) throw new Error("Pi provider request allowance must be a positive integer");
  if (executionLimit?.approvedFiles !== undefined && (phase !== "implement" || !Array.isArray(executionLimit.approvedFiles)
      || !executionLimit.approvedFiles.length || new Set(executionLimit.approvedFiles).size !== executionLimit.approvedFiles.length
      || executionLimit.approvedFiles.some((file) => typeof file !== "string" || !file || path.posix.isAbsolute(file)
        || file.includes("\\") || path.posix.normalize(file) !== file || file.split("/").includes("..") || !allowedFile(file, project.config)))) throw new Error("Pi approved files must be unique project-relative implementation paths within policy");
  if (executionLimit?.researchRequests !== undefined && (phase !== "implement" || ![0, 1].includes(executionLimit.researchRequests))) throw new Error("Implementation research allowance must be zero or one request");
  if (executionLimit?.implementationScope !== undefined && !["project", "plan"].includes(executionLimit.implementationScope)) {
    throw new Error("Implementation scope must be project or plan");
  }
  if (executionLimit?.outputSchema !== undefined && (!["initialize", "intake", "plan", "review"].includes(phase)
      || !executionLimit.outputSchema || executionLimit.outputSchema.strict !== true
      || typeof executionLimit.outputSchema.name !== "string" || !executionLimit.outputSchema.name.trim()
      || executionLimit.outputSchema.schema?.type !== "object")) throw new Error("Structured stages require a named strict object schema");
  const implementationScope = executionLimit?.implementationScope ?? project.config.implementationScope ?? "plan";
  if (executionLimit?.sourceQuery !== undefined && (!["implement", "review"].includes(phase) || typeof executionLimit.sourceQuery !== "string"
      || !executionLimit.sourceQuery.trim() || executionLimit.sourceQuery.length > 12000)) throw new Error("Implementation source query requires a bounded responsible diagnosis");
  if (executionLimit?.contextFiles !== undefined && (!["plan", "review", "intake"].includes(phase)
      || !Array.isArray(executionLimit.contextFiles) || !executionLimit.contextFiles.length
      || new Set(executionLimit.contextFiles).size !== executionLimit.contextFiles.length
      || executionLimit.contextFiles.some(file => typeof file !== "string" || !file || path.posix.isAbsolute(file)
         || file.includes("\\") || path.posix.normalize(file) !== file || file.split("/").includes("..")))) throw new Error("Context files must be unique project-relative read-only paths");
  if (executionLimit?.authoritativeContext !== undefined && (!executionLimit.authoritativeContext
      || typeof executionLimit.authoritativeContext !== "object" || Array.isArray(executionLimit.authoritativeContext)
      || Buffer.byteLength(JSON.stringify(executionLimit.authoritativeContext)) > 48000)) throw new Error("Authoritative task context must be a bounded object");
  const selected = resolveAgentModel(project.config, phase, role);
  if (selected.provider === "unconfigured" || selected.model === "unconfigured")
    throw new Error("尚未配置模型，请先在工作台的模型设置中保存模型连接。");
  project = { ...project, config: { ...project.config,
    ...(selected.maxPiMs !== undefined ? { maxPiMs: selected.maxPiMs } : {}),
    ...(selected.maxToolCalls !== undefined ? { maxToolCalls: selected.maxToolCalls } : {}),
    modelUsage: { ...project.config.modelUsage, ...selected.modelUsage },
    modelParameters: { ...project.config.modelParameters, ...selected.modelParameters } } };
  const validateOutput = executionLimit?.outputSchema ? new Ajv({ allErrors: true }).compile(executionLimit.outputSchema.schema) : null;
  const modelUsage = { ...defaultModelUsage, ...project.config.modelUsage };
  const readOnly = ["intake", "plan", "review"].includes(phase);
  if (executionLimit?.discussionTask !== undefined) {
    safeId(executionLimit.discussionTask);
    if (!readOnly || !project.archive) throw new Error("Discussion retrieval requires a read-only phase and a current project archive");
  }
  if (executionLimit?.planCorrection !== undefined) {
    const binding = executionLimit.planCorrection;
    if (phase !== "plan" || !executionLimit.planContract || !executionLimit.discussionTask
        || !binding || typeof binding.draftFile !== "string" || !/^[a-f0-9]{64}$/.test(binding.draftHash ?? ""))
      throw new Error("Internal plan correction requires a verified draft and frozen contract");
    assertInside(path.join(project.archive, "tasks", executionLimit.discussionTask), binding.draftFile);
  }
  let requestLimit = phase === "initialize" ? modelUsage.initializationMaxRequests
    : readOnly ? Math.min(modelUsage.maxRequests, modelUsage.readOnlyMaxRequests) : modelUsage.maxRequests;
  if (phase === "implement" && executionLimit?.budget?.mode === "adaptive") {
    requestLimit *= executionLimit.budget.complexity === "bounded_complex" ? 3
      : executionLimit.budget.complexity === "standard" ? 2 : 1;
  }
  if (executionLimit?.maxRequests !== undefined) requestLimit = Math.min(requestLimit, executionLimit.maxRequests);
  const tokenLimit = Math.min(executionLimit?.maxTokens ?? modelUsage.maxTokens,
    phase === "initialize" ? modelUsage.initializationMaxTokens : modelUsage.maxTokens);
  const adaptiveBudget = phase === "implement" || executionLimit?.budget?.mode === "adaptive";
  const tokenBudgetKind = executionLimit !== null && executionLimit.maxTokens <= (phase === "initialize"
    ? modelUsage.initializationMaxTokens : modelUsage.maxTokens) ? "remaining requirement" : "phase";
  const toolLimit = phase === "initialize"
    ? Math.min(project.config.maxToolCalls, modelUsage.initializationMaxToolCalls) : project.config.maxToolCalls;
  let selection = resolveAgentModel(project.config, phase, role);
  if (executionLimit?.modelSelection !== undefined) {
    const requested = executionLimit.modelSelection;
    if (phase !== "implement" || !requested || Object.keys(requested).sort().join() !== "model,provider,thinking"
        || (!project.config.compatibleProviders?.some(provider => provider.name === requested.provider
          && provider.models.some(model => model.id === requested.model))
          && !(project.config.modelFallbacks ?? []).some(candidate => ["provider", "model", "thinking"]
            .every(key => candidate[key] === requested[key])))) throw new Error("Owner model selection must match an administrator-configured model");
    selection = { ...selection, ...requested, selectionSource: "owner" };
  }
  const traceId = randomUUID();
  const activeProvider = project.config.compatibleProviders?.find(provider => provider.name === selection.provider);
  if (activeProvider) {
    const credentialNames = new Set(project.config.compatibleProviders.map(provider => provider.apiKeyEnv));
    project = { ...project, config: { ...project.config, compatibleProviders: [activeProvider],
      environment: { ...project.config.environment, pi: project.config.environment.pi.filter(name =>
        !credentialNames.has(name) || name === activeProvider.apiKeyEnv) } } };
  }
  if (project.config.structuredOutput === true && executionLimit?.outputSchema && project.config.modelParameters.outputFormat === "json_schema"
      && project.config.compatibleProviders?.find(provider => provider.name === selection.provider)
        ?.models.find(model => model.id === selection.model)?.supportsJsonSchema !== true) {
    throw new Error(`所选模型未配置严格 JSON Schema 能力，请选择自动或 JSON 模式：${selection.provider}/${selection.model}`);
  }
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const sourceEvidence = { reused: [], reusedFiles: [], indexed: [], focusedFiles: [], invalidated: [], omitted: [], captured: [], completeFiles: [], pendingCreation: [] };
  const sourceReads = new Map();
  const sourceRoot = await fs.realpath(cwd);
  const sourceDirectory = path.dirname(logFile);
  const sharedSourceDirectory = project.archive ? path.join(project.archive, "source-evidence") : null;
  const contextFiles = phase === "implement" ? executionLimit?.approvedFiles : executionLimit?.contextFiles;
  const contextBytes = readOnly ? 6000 : executionLimit?.budget?.complexity === "standard" ? 24000
    : executionLimit?.budget?.complexity === "bounded_complex" ? 32000 : 12000;
  let sourceContextBytes = 0;
  if (sharedSourceDirectory) await fs.mkdir(sharedSourceDirectory, { recursive: true, mode: 0o700 });
  if (phase === "implement" && executionLimit?.approvedFiles) {
    const complete = [];
    let bytes = 0;
    const referencedFiles = [...new Set([...executionLimit.sourceQuery?.matchAll(/(?<![\w/.$-])([\w./$-]+\.[\w-]+):\d+/g) ?? []]
      .map(match => match[1]))];
    for (const relative of [...new Set([...executionLimit.approvedFiles, ...referencedFiles])]) {
      if (path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative || relative.split("/").includes("..")
          || project.config.excludedPaths.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`))) {
        throw new Error(`Referenced context path is outside policy: ${relative}`);
      }
      let stat;
      try { stat = await fs.stat(path.join(sourceRoot, relative)); }
      catch (error) { if (error.code !== "ENOENT") throw error; sourceEvidence.pendingCreation.push(relative); continue; }
      if (!stat.isFile()) throw new Error(`Approved implementation path is not a file: ${relative}`);
      if (!executionLimit?.sourceQuery && (stat.size > 12000 || bytes + stat.size > contextBytes)) continue;
      const file = await fs.realpath(path.join(sourceRoot, relative));
      assertInside(sourceRoot, file);
      if (relative.split("/").some(part => part === ".env" || part.startsWith(".env."))) throw new Error("Environment files cannot enter implementation context");
      const content = await fs.readFile(file, "utf8");
      const hash = sha256(content);
      if (executionLimit?.sourceQuery && (stat.size > 12000 || bytes + stat.size > contextBytes)) {
        const lines = content.split("\n");
        const anchors = lines.flatMap((line, index) => {
          const symbol = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:def|function|class)\s+([\w$]+)/)?.[1];
          return symbol && new RegExp(`\\b${symbol.replace(/[$]/g, "\\$")}\\b`).test(executionLimit.sourceQuery) ? [index] : [];
        });
        const citationNames = [relative];
        if (executionLimit.approvedFiles.filter(file => path.posix.basename(file) === path.posix.basename(relative)).length === 1) {
          citationNames.push(path.posix.basename(relative));
        }
        const referencePattern = new RegExp(`(?<![\\w/.$-])(?:${citationNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}):(\\d+)(?:-(\\d+))?`, "g");
        const citedAnchors = [];
        const citedRanges = new Map();
        for (const match of executionLimit.sourceQuery.matchAll(referencePattern)) {
          const line = Number(match[1]);
          if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) throw new Error(`Requested source line is outside ${relative}: ${match[1]}`);
          if (match[2] !== undefined) {
            const end = Number(match[2]);
            if (!Number.isSafeInteger(end) || end < line || end > lines.length) throw new Error(`Requested source range is outside bounded evidence: ${relative}:${match[1]}-${match[2]}`);
            if (end - line < 80) citedRanges.set(line - 1, { start: line - 1, end });
          }
          citedAnchors.push(line - 1);
        }
        const selectedAnchors = [...new Set([...citedAnchors, ...anchors])];
        if (executionLimit.researchRequests !== 0 && selectedAnchors.length === 0) selectedAnchors.push(0);
        const relatedAnchors = [];
        if (executionLimit.researchRequests !== 0 && /(?:^|\/)(?:tests?|__tests__)(?:\/|\.)/.test(relative)) {
          const queriedNames = [...executionLimit.sourceQuery.matchAll(/\b[A-Za-z$][\w$]*_[\w$]+\b/g)]
            .map(match => match[0].toLowerCase().split("_").filter(word => word.length > 2 && word !== "test"));
          for (const [index, line] of lines.entries()) {
            const symbol = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:def|function|class)\s+([\w$]+)/)?.[1];
            if (symbol && queriedNames.some(words => words.filter(word => symbol.toLowerCase().split("_").includes(word)).length >= 2)) relatedAnchors.push(index);
          }
          relatedAnchors.push(Math.max(0, lines.length - 20));
        }
        if (selectedAnchors.length || relatedAnchors.length) {
          for (const anchor of [...new Set([...selectedAnchors, ...relatedAnchors])]) {
            const declaration = lines[anchor].match(/^(\s*)(?:export\s+)?(?:async\s+)?(?:def|function|class)\s+([\w$]+)/);
            const nextDeclaration = declaration ? lines.findIndex((line, index) => index > anchor
              && /^\s*(?:export\s+)?(?:async\s+)?(?:def|function|class)\s+/.test(line)
              && line.match(/^\s*/)[0].length <= declaration[1].length) : -1;
            const { start, end } = citedRanges.get(anchor) ?? { start: Math.max(0, anchor - 2),
              end: Math.min(lines.length, anchor + (anchor === 0 ? 80 : 78), nextDeclaration < 0 ? lines.length : nextDeclaration) };
            const text = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n");
            if (executionLimit.researchRequests !== 0 && bytes + Buffer.byteLength(text) > contextBytes) {
              const reference = `${relative}:${start + 1}-${end}`;
              if (Buffer.byteLength([...sourceEvidence.indexed, reference].join("\n")) > 2000) {
                sourceEvidence.omitted.push(reference); continue;
              }
              sourceEvidence.indexed.push(reference);
              const symbol = lines[anchor].match(/^\s*(?:export\s+)?(?:async\s+)?(?:def|function|class)\s+([\w$]+)/)?.[1];
              complete.push(`${reference} sha256=${hash} (location only${symbol ? `; symbol=${symbol}` : ""}; read necessary lines before editing)`);
              continue;
            }
            if (bytes + Buffer.byteLength(text) > contextBytes) continue;
            bytes += Buffer.byteLength(text);
            sourceEvidence.focusedFiles.push({ file: relative, hash, startLine: start + 1, endLine: end });
            complete.push(`${relative} sha256=${hash} (diagnosis-relevant excerpt; not a complete file)\n${text}`);
          }
          continue;
        }
        if (stat.size > 12000 || bytes + stat.size > contextBytes) continue;
      }
      bytes += Buffer.byteLength(content);
      sourceEvidence.completeFiles.push({ file: relative, hash, bytes: Buffer.byteLength(content) });
      complete.push(`${relative} sha256=${hash} (complete file)\n${content}`);
    }
    if (complete.length) prompt += `\n\nVerified approved source; complete files and partial excerpts are explicitly labeled:\n${complete.join("\n\n")}`;
    sourceContextBytes = bytes;
  }
  if (readOnly || phase === "implement") {
    const excerpts = new Map();
    const index = new Map();
    let evidenceBytes = sourceContextBytes;
    const artifacts = [];
    for (const directory of [sourceDirectory, ...(sharedSourceDirectory ? [sharedSourceDirectory] : [])]) {
      for (const file of (await fs.readdir(directory)).filter(file => /^source-[a-f0-9]{64}\.json$/.test(file)).sort()) {
        const bytes = await fs.readFile(path.join(directory, file));
        if (`source-${sha256(bytes)}.json` !== file) throw new Error(`Source evidence integrity failed: ${file}`);
        const entry = JSON.parse(bytes);
        const reference = new RegExp(`${String(entry.file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)(?:-(\\d+))?`, "g");
        const relevant = [...(executionLimit?.sourceQuery ?? "").matchAll(reference)].some(match =>
          Number(match[1]) <= entry.endLine && Number(match[2] ?? match[1]) >= entry.startLine);
        artifacts.push({ file, directory, relevant });
      }
    }
    artifacts.sort((a, b) => Number(b.relevant) - Number(a.relevant));
    for (const { file: artifact, directory, relevant } of artifacts) {
      const bytes = await fs.readFile(path.join(directory, artifact));
      if (`source-${sha256(bytes)}.json` !== artifact) throw new Error(`Source evidence integrity failed: ${artifact}`);
      const entry = JSON.parse(bytes);
      if (entry.version !== 1 || typeof entry.file !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash)
          || !Number.isSafeInteger(entry.startLine) || entry.startLine < 1 || !Number.isSafeInteger(entry.endLine)
          || entry.endLine < entry.startLine || entry.endLine - entry.startLine >= 80 || typeof entry.text !== "string") {
        throw new Error(`Invalid source evidence: ${artifact}`);
      }
      const file = path.resolve(sourceRoot, entry.file);
      assertInside(sourceRoot, file);
      const relative = path.relative(sourceRoot, file).split(path.sep).join("/");
      if (relative !== entry.file || relative.split("/").some(part => part === ".env" || part.startsWith(".env."))
          || project.config.excludedPaths.some(p => relative === p || relative.startsWith(`${p}/`))) throw new Error(`Source evidence outside policy: ${artifact}`);
      if (contextFiles && !contextFiles.includes(relative)) {
        sourceEvidence.omitted.push(artifact); continue;
      }
      let contents;
      try { assertInside(sourceRoot, await fs.realpath(file)); contents = await fs.readFile(file, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; sourceEvidence.invalidated.push({ artifact, reason: "file removed" }); continue; }
      if (sha256(contents) !== entry.hash) { sourceEvidence.invalidated.push({ artifact, reason: "source changed" }); continue; }
      const text = contents.split("\n").slice(entry.startLine - 1, entry.endLine).map((line, i) => `${entry.startLine + i}: ${line}`).join("\n");
      if (text !== entry.text) throw new Error(`Source evidence range mismatch: ${artifact}`);
      if (sourceEvidence.completeFiles.some(row => row.file === relative)) { sourceEvidence.omitted.push(artifact); continue; }
      if ((readOnly && !contextFiles && directory === sharedSourceDirectory)
           || (phase === "implement" && executionLimit?.approvedFiles && executionLimit.researchRequests !== 0
             && !relevant)) {
        if ([...excerpts.values()].some(row => row.file === relative && row.startLine <= entry.startLine
            && row.endLine >= entry.endLine)) { sourceEvidence.omitted.push(artifact); continue; }
        const reference = `${relative}:${entry.startLine}-${entry.endLine}`;
        if (!index.has(reference) && Buffer.byteLength([...index.keys(), reference].join("\n")) <= 2000) {
          index.set(reference, artifact); sourceEvidence.indexed.push(artifact);
        } else sourceEvidence.omitted.push(artifact);
        continue;
      }
      if (sourceEvidence.focusedFiles.some(row => row.file === relative && row.startLine <= entry.startLine
          && row.endLine >= entry.endLine)) { sourceEvidence.omitted.push(artifact); continue; }
      if ([...excerpts.values()].some(row => row.file === relative && row.startLine <= entry.startLine && row.endLine >= entry.endLine)) {
        sourceEvidence.omitted.push(artifact); continue;
      }
      for (const [key, row] of excerpts) {
        if (row.file !== relative || row.startLine < entry.startLine || row.endLine > entry.endLine) continue;
        excerpts.delete(key);
        evidenceBytes -= row.bytes;
        sourceEvidence.reused = sourceEvidence.reused.filter(file => file !== row.artifact);
        sourceEvidence.omitted.push(row.artifact);
      }
      if (evidenceBytes + Buffer.byteLength(text) > contextBytes) { sourceEvidence.omitted.push(artifact); continue; }
      const key = `${relative}:${entry.startLine}:${entry.endLine}`;
      if (excerpts.has(key)) continue;
      excerpts.set(key, { file: relative, startLine: entry.startLine, endLine: entry.endLine, artifact,
        bytes: Buffer.byteLength(text), display: `${relative} sha256=${entry.hash}\n${text}` });
      evidenceBytes += Buffer.byteLength(text);
      sourceEvidence.reused.push(artifact);
    }
    if (excerpts.size) {
      sourceEvidence.reusedFiles = [...new Set([...excerpts.values()].map(row => row.file))];
      prompt += `\n\nVerified source excerpts from prior reads (raw code only; independently review; no prior conclusions):\n${[...excerpts.values()].map(row => row.display).join("\n\n")}`;
    }
    if (index.size) prompt += `\n\nAvailable verified source references (index only; read necessary ranges, do not infer contents):\n${[...index.keys()].join("\n")}`;
    sourceContextBytes = evidenceBytes;
  }
  sourceEvidence.selectedBytes = sourceContextBytes;
  // Complete write targets do not include every caller, fixture or dependency.
  // Only an explicit, diagnosed repair may opt out of further investigation.
  const researchRequests = executionLimit?.researchRequests ?? 1;
  sourceEvidence.researchRequests = researchRequests;
  if (phase === "implement" && executionLimit?.researchRequests === 0
      && executionLimit.approvedFiles.some(file => !sourceEvidence.completeFiles.some(row => row.file === file)
        && !sourceEvidence.focusedFiles.some(row => row.file === file)
        && !sourceEvidence.reusedFiles.includes(file) && !sourceEvidence.pendingCreation.includes(file))) {
    throw new Error("Research-free resume requires verified source context for every approved existing file");
  }
  if (phase === "implement" && executionLimit?.approvedFiles && project.config.checks) {
    prompt += "\nThe approved checks are available through run_checks. Use existing verification infrastructure for changed behavior. External developer-owned check scripts may be executed only through run_checks, not read or edited. The controller independently verifies the final source and reviews its changes.";
  }
  if (!Array.isArray(images) || images.length > 12 || (images.length && phase !== "intake")) throw new Error("Image input is limited to the intake phase");
  const imageInputs = [];
  for (const file of images) {
    const resolved = await fs.realpath(file);
    assertInside(await fs.realpath(cwd), resolved);
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 1024 * 1024 || !/\.(png|jpg)$/.test(resolved)) throw new Error("Invalid intake image input");
    imageInputs.push({ file: path.relative(cwd, resolved), hash: sha256(await fs.readFile(resolved)), bytes: stat.size });
  }
  let tools = phase === "initialize" ? "" : phase === "implement"
    ? `read,bash,edit,write,grep,find,ls${project.config.checks ? ",run_checks" : ""}` : ["intake", "plan", "review"].includes(phase) ? "read,grep,find,ls"
    : project.config.mode === "git" ? "read,ls,edit,write" : "read,grep,find,ls,edit,write";
  if (readOnly && project.archive) tools += ",search_history,read_history";
  if (executionLimit?.discussionTask) tools += ",read_discussion,read_plan";
  const developerSession = phase === "plan" && executionLimit?.developerSession === true;
  const sessionFile = developerSession || phase === "implement" && executionLimit?.approvedFiles ? `${logFile}.session.jsonl` : null;
  let sessionCheckpoint = null;
  let supersededPromptHashes = [];
  let priorRequestLayout;
  if (executionLimit?.resumeSession) {
    if (!sessionFile) throw new Error("Session continuation requires a developer run");
    const previous = executionLimit.resumeSession;
    assertInside(await fs.realpath(path.dirname(logFile)), await fs.realpath(previous.file));
    const content = await fs.readFile(previous.file);
    if (sha256(content) !== previous.hash) throw new Error("Developer session changed before continuation");
    const headerEnd = content.indexOf(10);
    if (headerEnd < 0) throw new Error("Developer session has no native session header");
    const header = JSON.parse(content.subarray(0, headerEnd).toString("utf8"));
    if (header.type !== "session" || typeof header.cwd !== "string" || !header.cwd
        || typeof header.id !== "string" || !header.id) throw new Error("Developer session has an invalid native header");
    // Private developer sessions receive user messages only from this controller.
    // The current prompt replaces stage instructions, not assistant/tool evidence.
    const sessionEntries = content.subarray(headerEnd + 1).toString("utf8").trim().split("\n")
      .filter(line => line.trim()).map(line => JSON.parse(line));
    supersededPromptHashes = [...new Set(sessionEntries
      .filter(entry => entry.type === "message" && entry.message.role === "user")
      .map(entry => sha256(JSON.stringify(entry.message.content))))];
    const byId = new Map(sessionEntries.map(entry => [entry.id, entry]));
    const branch = [];
    for (let entry = sessionEntries.at(-1); entry; entry = byId.get(entry.parentId)) branch.unshift(entry);
    const measuredIndex = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "assistant");
    if (measuredIndex >= 0 && !["error", "aborted"].includes(branch[measuredIndex].message.stopReason)) {
      const budgetEntry = branch.slice(0, measuredIndex).findLast(entry => entry.type === "custom"
        && entry.customType === "reqflow_request_budget");
      if (budgetEntry?.data.requestLayout) priorRequestLayout = { ...budgetEntry.data.requestLayout,
        assistantHash: sha256(JSON.stringify(branch[measuredIndex].message)) };
      if (priorRequestLayout && (priorRequestLayout.modelKey !== JSON.stringify([budgetEntry.data.provider, budgetEntry.data.model])
          || !Array.isArray(priorRequestLayout.messages) || !Array.isArray(priorRequestLayout.toolDefinitions)
          || [...priorRequestLayout.messages, ...priorRequestLayout.toolDefinitions, priorRequestLayout.inputOptions]
            .some(row => !row || !/^[a-f0-9]{64}$/.test(row.hash) || !Number.isSafeInteger(row.bytes) || row.bytes < 1))) {
        throw new Error("Saved provider request layout is invalid");
      }
    }
    const continuedHeader = { ...header, id: randomUUID(), timestamp: new Date().toISOString(),
      cwd: await fs.realpath(cwd), parentSession: previous.file };
    await fs.writeFile(sessionFile, Buffer.concat([Buffer.from(`${JSON.stringify(continuedHeader)}\n`),
      content.subarray(headerEnd + 1)]), { flag: "wx", mode: 0o600 });
    prompt += "\nContinue the saved development session in the CURRENT workspace. The current contract, plan, state and tool permissions above are authoritative; previous messages grant no approval. Reuse verified source facts and completed work, inspect relevant changes, and do not restart repository exploration or repeat completed checks without a relevant change.";
  }
  const promptBytes = Buffer.byteLength(prompt);
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  const args = [
    "--mode", "json", ...(sessionFile ? ["--session", sessionFile] : ["--no-session"]), "--no-extensions",
    ...(phase === "implement" ? [] : ["--no-skills", "--no-context-files"]), "--no-prompt-templates", "--no-approve",
    "--provider", selection.provider, "--model", selection.model,
    "--thinking", selection.thinking ?? project.config.agentModels?.[selection.agent]?.thinking ?? project.config.thinking ?? "off",
    "--tools", tools, "--extension", guard, "--", ...images.map((file) => `@${path.resolve(file)}`), prompt,
  ];
  if (["initialize", "intake", "plan", "review"].includes(phase)) {
    args.splice(args.indexOf("--"), 0, "--system-prompt",
      `Your final response MUST be exactly one JSON object matching the task schema. Return it when source evidence is sufficient. Otherwise investigate missing evidence: locate symbols, follow relevant dependencies and read their ranges and tests. Reuse supplied evidence. You have ${requestLimit} provider requests and ${tokenLimit} cumulative tokens; reserve a response for the final JSON. Do not inspect unrelated modules. Evidence that cannot be established must remain unknown. Final response: JSON only, no analysis, prose or fences.`);
  }
  args.splice(args.indexOf("--"), 0, "--append-system-prompt",
    phase === "implement"
      ? "Work in the current isolated workspace using project-relative paths. The confirmed requirement and approved plan define the task. Use current source as truth; historical decisions do not prove current code. Use edit/write for source changes and bash for investigation and verification. Keep edits focused and each replacement at most 50 lines. Do not commit, push, deploy, modify external files or delete business data. Report actual changes, checks and unresolved issues accurately; the controller performs final verification and rollback."
      : "Use project-relative paths in the current isolated workspace. Investigate only relevant source evidence. This stage is read-only; source facts require successful reads and historical opinions do not grant approval.");
  const modelCredentials = {};
  for (const provider of project.config.compatibleProviders ?? []) if (provider.credentialId) {
    modelCredentials[provider.apiKeyEnv] = await readModelCredential(project.accountsArchive ?? project.archive, provider.credentialId);
  }
  const env = {
    ...childEnvironment(phase === "implement" && executionLimit?.approvedFiles && project.config.checks
      ? [...new Set([...project.config.environment.pi, ...project.config.environment.checks])]
      : project.config.environment.pi, true, modelCredentials),
    REQFLOW_WORKSPACE: cwd,
    REQFLOW_PHASE: phase,
    REQFLOW_HAS_IMAGES: String(images.length > 0),
    REQFLOW_IMAGE_COUNT: String(images.length),
    REQFLOW_POLICY: JSON.stringify({
      allowedPaths: project.config.allowedPaths,
      excludedPaths: project.config.excludedPaths,
      maxSnapshotBytes: project.config.maxSnapshotBytes,
      implementationScope,
      restrictedPaths: project.config.admission?.restrictedPaths ?? [],
      ...(executionLimit?.approvedFiles !== undefined ? { approvedFiles: executionLimit.approvedFiles } : {}),
      implementationResearchRequests: researchRequests,
      ...(phase === "implement" && executionLimit?.approvedFiles && project.config.checks ? {
        implementationChecks: { commands: project.config.checks, environment: project.config.environment.checks,
          sandbox: project.config.checkSandbox, timeoutMs: project.config.maxPiMs, maxBytes: project.config.maxEventBytes,
          maxSnapshotBytes: project.config.maxSnapshotBytes, logPrefix: `${logFile}.internal` },
      } : {}),
      providerRequestLimit: Math.min(executionLimit?.maxRequests ?? (phase === "implement" ? requestLimit : modelUsage.maxRequests),
        phase === "implement" ? requestLimit : modelUsage.maxRequests),
      modelFallbacks: [],
      modelParameters: project.config.modelParameters,
      compatibleProviders: project.config.compatibleProviders ?? [],
      ...(readOnly && project.archive ? { historyProject: { root: project.root, archive: project.archive, config: project.config } } : {}),
      ...(executionLimit?.discussionTask ? { discussionTask: executionLimit.discussionTask } : {}),
      thinking: selection.thinking ?? project.config.agentModels?.[selection.agent]?.thinking ?? project.config.thinking ?? "off",
      modelUsage: { maxContextBytes: modelUsage.maxContextBytes, maxToolResultBytes: modelUsage.maxToolResultBytes,
        budgetMode: adaptiveBudget ? "adaptive" : "strict",
        maxRequests: requestLimit,
        maxTokens: tokenLimit },
      structuredOutput: project.config.structuredOutput === true && ["initialize", "intake", "plan", "review"].includes(phase),
      ...(executionLimit?.outputSchema ? { outputSchema: executionLimit.outputSchema } : {}),
      ...(executionLimit?.authoritativeContext ? { authoritativeContext: executionLimit.authoritativeContext } : {}),
      resumedSession: executionLimit?.resumeSession !== undefined,
      currentPromptContentHash: sha256(JSON.stringify([{ type: "text", text: prompt }])),
      ...(executionLimit?.resumeSession ? { supersededPromptHashes } : {}),
      ...(priorRequestLayout ? { priorRequestLayout } : {}),
      ...(phase === "plan" && executionLimit?.planContract ? { planContract: executionLimit.planContract } : {}),
      ...(phase === "plan" && executionLimit?.planCorrection ? { planCorrection: executionLimit.planCorrection } : {}),
      ...(phase === "intake" && executionLimit?.intakeValidation ? { intakeValidation: executionLimit.intakeValidation } : {}),
    }),
  };
  if (activeProvider) {
    // Adaptive byte targets are advisory; compact at the model's actual capacity.
    // Compatible-provider credentials are registered explicitly by the guard.
    const runtimeHome = `${logFile}.pi-home`;
    const model = activeProvider.models.find(model => model.id === selection.model);
    const outputTokens = Math.min(project.config.modelParameters.maxOutputTokens ?? model.maxTokens, model.maxTokens);
    const retainedInput = adaptiveBudget ? model.contextWindow - outputTokens
      : Math.min(Math.floor(modelUsage.maxContextBytes / 4), model.contextWindow - outputTokens);
    if (!Number.isSafeInteger(retainedInput) || retainedInput < 1) throw new Error("Model context must leave room for task input and output");
    await fs.mkdir(runtimeHome, { mode: 0o700 });
    await fs.writeFile(path.join(runtimeHome, "settings.json"), JSON.stringify({
      compaction: { enabled: true, reserveTokens: model.contextWindow - retainedInput,
        keepRecentTokens: Math.min(4096, Math.floor(retainedInput / 2)) },
    }), { mode: 0o600, flag: "wx" });
    env.PI_CODING_AGENT_DIR = runtimeHome;
  }
  assertExecutionActive();
  const log = await fs.open(logFile, "wx", 0o600);
  const child = spawn(process.execPath, [project.config.piExecutable, ...args], { cwd, env,
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const signalGroup = (signal) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let escalation;
  let terminationError;
  const terminate = () => {
    if (escalation) return;
    try { signalGroup("SIGTERM"); }
    catch (error) { terminationError = error; child.kill("SIGKILL"); }
    escalation = setTimeout(() => {
      try { signalGroup("SIGKILL"); }
      catch (error) { terminationError = error; child.kill("SIGKILL"); }
    }, 1500);
  };
  const signal = executionSignal();
  signal?.addEventListener("abort", terminate, { once: true });
  if (signal?.aborted) terminate();
  let stderr = "";
  child.stderr.on("data", (part) => { stderr = (stderr + part.toString()).slice(-16000); });
  let requestTimer;
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(requestTimer);
      try { signalGroup("SIGKILL"); }
      catch (error) { reject(error); }
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timedOut = false;
  let settled = false;
  let lastText = "";
  let stopReason = "";
  let modelError = "";
  let usage = null;
  const tokens = { input: null, output: null, cacheRead: null, cacheWrite: null };
  let assistantMessages = 0;
  let toolCalls = 0;
  let preview = "";
  let streamedText = "";
  let previewAt = 0;
  reportProgress(({ intake: "正在结合项目资料核对业务需求。", plan: "正在生成研发方案。",
    review: "正在核对方案与需求的一致性。", implement: "正在实现已确认的方案。" })[phase] ?? "正在处理本轮任务。", "", "model");
  let eventBytes = 0;
  let completedCost = 0;
  let currentCost = 0;
  const imageArtifacts = new Map();
  let imageArtifactBytes = 0;
  const modelSwitches = [];
  const modelAttempts = [];
  const requestEstimates = [];
  const requestTimings = [];
  const toolTimings = [];
  const developmentChecks = [];
  const budgetExpansions = [];
  const requestBudgetExpansions = [];
  const planValidation = [];
  const intakeValidation = [];
  const contextExpansions = [];
  const contextReplacements = [];
  const compactions = [];
  let pendingCompactions = 0;
  const auditStorage = { formatVersion: 1, receivedBytes: 0, omittedEvents: 0,
    omittedThinkingBlocks: 0, omittedThinkingBytes: 0 };
  const telemetry = () => ({ traceId, phase, ...selection,
    startedAt, durationMs: Date.now() - startedMs, promptBytes, promptHash,
    executionMode: phase === "implement" ? "native" : "structured",
    responseBytes: Buffer.byteLength(lastText), eventBytes, assistantMessages,
    requestLimit: phase === "implement" ? null : requestLimit, tokenLimit: phase === "implement" ? null : tokenLimit,
    tokenBudgetKind: phase === "implement" ? "observed" : tokenBudgetKind, tokens: { ...tokens },
    costUsd: completedCost + currentCost, toolCalls, logFile, sessionCheckpoint,
    sessionSource: executionLimit?.resumeSession ?? null,
    auditStorage: { ...auditStorage, storedBytes: eventBytes },
    sessionStatus: !sessionFile ? "disabled" : sessionCheckpoint ? "saved" : "unavailable",
    imageInputs, sourceEvidence, modelSwitches, modelAttempts, requestEstimates, contextReplacements,
    requestTimings: requestTimings.map(row => ({ ...row, durationMs: row.durationMs ?? Date.now() - Date.parse(row.startedAt) })),
    toolTimings: toolTimings.map(row => ({ ...row, durationMs: row.durationMs ?? Date.now() - Date.parse(row.startedAt) })),
    developmentChecks, budgetExpansions, requestBudgetExpansions,
    budget: executionLimit?.budget ?? { mode: "strict" }, planValidation, intakeValidation, contextExpansions,
    compactions, unmeasuredRequests: pendingCompactions + requestTimings.filter(row => !row.usageMeasured).length,
    timeouts: { requestMs: project.config.maxPiMs, mode: "per_request" },
    pricingKnown: pendingCompactions === 0 && requestTimings.every(row => row.usageMeasured)
      && !(project.config.compatibleProviders ?? []).length,
    imageArtifacts: [...imageArtifacts.values()].filter((entry) => entry.persisted).map(({ buffer, persisted, ...entry }) => entry) });
  requestTimer = setTimeout(() => { timedOut = true; terminate(); }, project.config.maxPiMs);
  try {
    for await (const line of readline.createInterface({ input: child.stdout })) {
      const event = JSON.parse(line);
      auditStorage.receivedBytes += Buffer.byteLength(line) + 1;
      const persistEvent = !["message_update", "message_start", "turn_start", "turn_end", "agent_end", "tool_execution_update"].includes(event.type)
        && !(event.type === "message_end" && event.message?.role === "toolResult");
      if (!persistEvent) auditStorage.omittedEvents++;
      const pendingImages = [];
      const auditedLine = persistEvent ? JSON.stringify(event, (key, value) => {
        if (key === "requestLayout") return { hash: sha256(JSON.stringify(value)), messageCount: value.messages.length };
        if (value?.type === "thinking") {
          const raw = JSON.stringify(value);
          const bytes = Buffer.byteLength(raw);
          auditStorage.omittedThinkingBlocks++;
          auditStorage.omittedThinkingBytes += bytes;
          return { type: "thinking_reference", omitted: true, bytes, hash: sha256(raw) };
        }
        if (["thinking", "reasoning_content", "thinkingSignature"].includes(key) && typeof value === "string") {
          const bytes = Buffer.byteLength(value);
          auditStorage.omittedThinkingBlocks++;
          auditStorage.omittedThinkingBytes += bytes;
          return { omitted: true, bytes, hash: sha256(value) };
        }
        if (value?.type !== "image" || typeof value.data !== "string") return value;
        const buffer = Buffer.from(value.data, "base64");
        const hash = sha256(buffer);
        const image = imageInputs.find((input) => input.hash === hash);
        if (image) return { type: "image_reference", ...image, mimeType: value.mimeType };
        if (!imageArtifacts.has(hash)) {
          const suffix = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[value.mimeType];
          imageArtifactBytes += buffer.length;
          if (!suffix || imageArtifactBytes > 8 * 1024 * 1024 || imageArtifacts.size >= 48) throw new Error("Pi image audit exceeded its format or byte budget");
          const entry = { file: `${path.basename(logFile)}.images/${hash}.${suffix}`, hash, bytes: buffer.length, buffer, persisted: false };
          imageArtifacts.set(hash, entry); pendingImages.push(entry);
        }
        const { buffer: _buffer, persisted: _persisted, ...artifact } = imageArtifacts.get(hash);
        return { type: "image_reference", ...artifact, mimeType: value.mimeType };
      }) : null;
      for (const entry of pendingImages) {
        const file = path.join(path.dirname(logFile), entry.file);
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, entry.buffer, { flag: "wx", mode: 0o600 });
        entry.persisted = true;
      }
      // Process the original stream for usage, validation and continuation. Audit
      // only completed messages, tool results and control events without thoughts.
      if (persistEvent) {
        eventBytes += Buffer.byteLength(auditedLine) + 1;
        if (eventBytes > project.config.maxEventBytes) {
          terminate();
          throw new Error("Pi event log exceeded configured byte limit");
        }
        await log.writeFile(`${auditedLine}\n`);
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_compaction_started") {
        pendingCompactions++;
        clearTimeout(requestTimer);
        requestTimer = setTimeout(() => { timedOut = true; terminate(); }, project.config.maxPiMs);
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_compaction") {
        const record = event.entry.data;
        if (![0, 1].includes(pendingCompactions) || record?.started?.requests !== record.requests
            || record.started.phase !== phase || !Number.isSafeInteger(record.started.inputReserve) || record.started.inputReserve < 1
            || !Number.isSafeInteger(record.started.requestedOutput) || record.started.requestedOutput < 1
            || typeof record?.summary !== "string" || !record.summary.trim()
            || !Number.isSafeInteger(record.requests) || record.requests < 1 || record.requests > 2
            || !Number.isSafeInteger(record.tokensBefore) || record.tokensBefore < 0
            || ["input", "output", "cacheRead", "cacheWrite"].some(key => !Number.isSafeInteger(record.usage?.[key]) || record.usage[key] < 0)
            || !Number.isFinite(record.usage.cost?.total) || record.usage.cost.total < 0) throw new Error("Invalid native compaction usage evidence");
        pendingCompactions = 0;
        clearTimeout(requestTimer);
        assistantMessages += record.requests;
        for (const key of Object.keys(tokens)) tokens[key] = (tokens[key] ?? 0) + record.usage[key];
        completedCost += record.usage.cost.total;
        compactions.push({ ...record, summary: undefined, summaryHash: sha256(record.summary) });
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_request_budget") {
        const estimate = event.entry.data;
        if (!["wire_bytes", "measured_prefix", "measured_retained"].includes(estimate?.estimationMethod)
            || ["request", "inputReserve", "contextBytes", "remainingTokens", "tokensUsed"].some(key => !Number.isSafeInteger(estimate[key]) || estimate[key] < 0)
            || estimate.request < 1 || estimate.request !== requestEstimates.length + 1) throw new Error("Invalid Pi request budget evidence");
        const { requestLayout, ...measuredEstimate } = estimate;
        requestEstimates.push({ ...measuredEstimate, ...(requestLayout ? {
          requestLayoutHash: sha256(JSON.stringify(requestLayout)), messageCount: requestLayout.messages.length } : {}) });
        requestTimings.push({ request: estimate.request, provider: estimate.provider, model: estimate.model,
          startedAt: new Date().toISOString(), startedAfterMs: Date.now() - startedMs,
          firstResponseMs: null, firstTextMs: null, durationMs: null, status: "running", usageMeasured: false, contextBytes: estimate.contextBytes });
        clearTimeout(requestTimer);
        requestTimer = setTimeout(() => { timedOut = true; terminate(); }, project.config.maxPiMs);
        reportProgress(`正在进行第 ${estimate.request} 次模型请求，等待分析与输出。`, "", "request");
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_provider_request") {
        const observed = event.entry.data;
        if (phase !== "implement" || observed?.executionMode !== "native"
            || observed.request !== requestTimings.length + 1 || !Number.isSafeInteger(observed.contextBytes)
            || observed.contextBytes < 0) throw new Error("Invalid native Pi request audit");
        requestTimings.push({ ...observed, startedAt: new Date().toISOString(), startedAfterMs: Date.now() - startedMs,
          firstResponseMs: null, firstTextMs: null, durationMs: null, status: "running", usageMeasured: false });
        clearTimeout(requestTimer);
        requestTimer = setTimeout(() => { timedOut = true; terminate(); }, project.config.maxPiMs);
        reportProgress(`Pi 正在进行第 ${observed.request} 次模型请求。`, "", "request");
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_development_check") {
        const check = event.entry.data;
        if (phase !== "implement" || !["passed", "failed", "error", "manual_pending"].includes(check?.status)
            || check.attempt !== developmentChecks.length + 1 || !Array.isArray(check.checks)
            || check.formalVerificationRequired !== true) throw new Error("Invalid development check evidence");
        developmentChecks.push(check);
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_budget_expanded") {
        const expansion = event.entry.data;
        if (!adaptiveBudget || !["previous", "next", "tokensUsed", "inputReserve"].every(key => Number.isSafeInteger(expansion?.[key]) && expansion[key] >= 0)
            || expansion.next <= expansion.previous) throw new Error("Invalid adaptive budget evidence");
        budgetExpansions.push(expansion);
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_request_budget_expanded") {
        const expansion = event.entry.data;
        if (!adaptiveBudget || phase !== "implement" || expansion?.previous !== (requestBudgetExpansions.at(-1)?.next ?? requestLimit)
            || expansion.next !== expansion.previous + requestLimit || !/^[a-f0-9]{64}$/.test(expansion.afterHash)
            || expansion.afterHash === requestBudgetExpansions.at(-1)?.afterHash) throw new Error("Invalid adaptive request budget evidence");
        requestBudgetExpansions.push(expansion);
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_plan_validation") {
        const validation = event.entry.data;
        if (phase !== "plan" || !["valid", "invalid"].includes(validation?.status)
            || validation.attempt !== planValidation.length + 1 || validation.attempt > 3) throw new Error("Invalid plan validation evidence");
        planValidation.push(validation);
        reportProgress(validation.status === "valid" ? "研发方案格式与内容检查已通过。"
          : `第 ${validation.attempt} 轮方案检查未通过，正在修正：${validation.error}`, "", "validation");
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_intake_validation") {
        const validation = event.entry.data;
        if (phase !== "intake" || !["valid", "invalid"].includes(validation?.status)
            || validation.attempt !== intakeValidation.length + 1 || validation.attempt > 3) throw new Error("Invalid intake validation evidence");
        intakeValidation.push(validation);
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_context_replaced") {
        const replacement = event.entry.data;
        if (replacement?.currentPromptContentHash !== sha256(JSON.stringify([{ type: "text", text: prompt }]))
            || !Array.isArray(replacement.replaced) || !replacement.replaced.length
            || replacement.replaced.some(row => !supersededPromptHashes.includes(row.hash)
              || !Number.isSafeInteger(row.bytes) || row.bytes < 1)) throw new Error("Invalid superseded controller prompt evidence");
        contextReplacements.push(replacement);
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_context_expanded") {
        const expansion = event.entry.data;
        if (!adaptiveBudget || !["previous", "next", "inputReserve", "requestedOutput", "contextWindow"]
          .every(key => Number.isSafeInteger(expansion?.[key]) && expansion[key] > 0)
          || expansion.next <= expansion.previous || !["measured_prefix", "measured_retained", "wire_bytes"].includes(expansion.estimationMethod)
          || expansion.inputReserve + expansion.requestedOutput > expansion.contextWindow) throw new Error("Invalid adaptive context evidence");
        contextExpansions.push(expansion);
      }
      if (event.type === "entry_appended" && event.entry?.customType === "reqflow_model_switch") {
        const details = event.entry.details;
        if (!["AllocationQuota.FreeTierOnly", "insufficient_quota"].includes(details?.code)
            || !project.config.modelFallbacks?.some(row => row.provider === details.to?.provider && row.model === details.to?.model)
            || modelSwitches.length >= project.config.modelFallbacks.length) throw new Error("Invalid model switch audit event");
        modelSwitches.push({ from: details.from, to: details.to, code: details.code });
      }
      if (event.type === "message_start" && event.message?.role === "assistant") {
        preview = ""; streamedText = ""; previewAt = 0;
        reportProgress("模型正在分析本轮资料。", "", "model");
      }
      const textDelta = event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta";
      const currentRequest = requestTimings.at(-1);
      if (event.type === "message_update" && ["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent?.type)
          && currentRequest?.status === "running") {
        const elapsed = Date.now() - Date.parse(currentRequest.startedAt);
        if (currentRequest.firstResponseMs === null) currentRequest.firstResponseMs = elapsed;
        if (textDelta && currentRequest.firstTextMs === null) currentRequest.firstTextMs = elapsed;
      }
      if (textDelta) {
        if (typeof event.assistantMessageEvent.delta !== "string") throw new Error("Pi text delta must be a string");
        // Pi JSON mode deliberately omits partial message snapshots.
        streamedText += event.assistantMessageEvent.delta;
      }
      if ((textDelta || event.type === "message_end" && event.message?.role === "assistant")
          && ["intake", "plan", "review"].includes(phase)) {
        const next = publicPreview(textDelta ? streamedText : assistantText(event.message));
        const finished = event.type === "message_end";
        const businessOnly = phase === "intake" && (/`|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S/.test(next)
          || executionLimit?.intakeValidation?.sourceFiles.some(file => next.includes(file)));
        if (finished || next !== preview && Date.now() - previewAt >= 150) {
          preview = next; previewAt = Date.now();
          reportProgress(businessOnly ? "正在检查业务表述，检查完成后显示答复。"
            : finished ? "本轮输出已生成，正在检查格式、依据与需求一致性。" : "正在生成答复，以下内容尚未完成核对。",
          businessOnly ? "" : preview, finished ? "validating" : "draft");
        }
      }
      if (event.type === "message_update" && event.usage?.cost?.total !== undefined) {
        if (!Number.isFinite(event.usage.cost.total) || event.usage.cost.total < 0) {
          throw new Error("Pi reported invalid in-progress cost usage");
        }
        currentCost = event.usage.cost.total;
      }
      if (event.type === "tool_execution_start") {
        toolTimings.push({ id: event.toolCallId, tool: event.toolName, startedAt: new Date().toISOString(),
          durationMs: null, status: "running" });
        reportProgress(event.toolName === "read" ? "正在阅读与本轮任务相关的代码和资料。"
          : event.toolName === "run_checks" ? "正在运行项目测试。"
            : ["edit", "write"].includes(event.toolName) ? "正在修改方案涉及的代码。" : "正在检查项目中的相关实现。", "", "tools");
        if (event.toolName === "read") sourceReads.set(event.toolCallId, event.args);
        toolCalls++;
        if (phase !== "implement" && toolCalls > toolLimit) {
          terminate();
          throw Object.assign(new Error("Pi exceeded configured tool-call limit"), { code: "PI_TOOL_LIMIT" });
        }
      }
      if (event.type === "tool_execution_end") {
        const timing = toolTimings.find(row => row.id === event.toolCallId);
        if (timing) { timing.durationMs = Date.now() - Date.parse(timing.startedAt); timing.status = event.isError ? "failed" : "completed"; }
      }
      if (event.type === "tool_execution_end" && sourceReads.has(event.toolCallId)) {
        const input = sourceReads.get(event.toolCallId);
        sourceReads.delete(event.toolCallId);
        if (!event.isError && !event.result?.isError && !event.result?.details?.budgetRejected) {
          if (typeof input?.path !== "string" || !Number.isSafeInteger(input.offset ?? 1)
              || (input.offset ?? 1) < 1 || !Number.isSafeInteger(input.limit ?? 80) || (input.limit ?? 80) < 1) throw new Error("Invalid Pi source read range");
          const file = await fs.realpath(path.resolve(sourceRoot, input.path));
          assertInside(sourceRoot, file);
          const relative = path.relative(sourceRoot, file).split(path.sep).join("/");
          if (relative.split("/").some(part => part === ".env" || part.startsWith(".env."))
              || project.config.excludedPaths.some(p => relative === p || relative.startsWith(`${p}/`))) throw new Error("Pi read source outside evidence policy");
          const contents = await fs.readFile(file, "utf8");
          const startLine = input.offset ?? 1;
          const lines = contents.split("\n").slice(startLine - 1, startLine - 1 + Math.min(input.limit ?? 80, 80));
          if (lines.length) {
            const text = lines.map((line, i) => `${startLine + i}: ${line}`).join("\n");
            if (Buffer.byteLength(text) <= modelUsage.maxToolResultBytes) {
              const entry = JSON.stringify({ version: 1, file: relative, hash: sha256(contents), startLine,
                endLine: startLine + lines.length - 1, text });
              const artifact = `source-${sha256(entry)}.json`;
              for (const directory of [sourceDirectory, ...(sharedSourceDirectory ? [sharedSourceDirectory] : [])]) {
                try { await fs.writeFile(path.join(directory, artifact), entry, { flag: "wx", mode: 0o600 }); }
                catch (error) {
                  if (error.code !== "EEXIST") throw error;
                  if (await fs.readFile(path.join(directory, artifact), "utf8") !== entry) throw new Error("Source evidence integrity failed while recording read");
                }
              }
              sourceEvidence.captured.push(artifact);
            }
          }
        }
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        clearTimeout(requestTimer);
        if (currentRequest?.status === "running") {
          currentRequest.durationMs = Date.now() - Date.parse(currentRequest.startedAt);
          currentRequest.status = timedOut ? "timed_out" : ["error", "aborted"].includes(event.message.stopReason) ? "failed" : "completed";
        }
        lastText = assistantText(event.message);
        stopReason = event.message.stopReason;
        modelError = event.message.errorMessage ?? "";
        usage = event.message.usage;
        modelAttempts.push({ provider: event.message.provider ?? selection.provider, model: event.message.model ?? selection.model,
          stopReason, usage });
        if (!Number.isFinite(usage?.cost?.total) || usage.cost.total < 0) {
          throw new Error("Pi did not report valid cost usage");
        }
        assistantMessages++;
        completedCost += usage.cost.total;
        currentCost = 0;
        for (const key of Object.keys(tokens)) {
          if (usage[key] === undefined) throw new Error(`Pi must report ${key} tokens for cumulative execution limits`);
          if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error(`Pi reported invalid ${key} tokens`);
          tokens[key] = (tokens[key] ?? 0) + usage[key];
        }
        if (currentRequest) currentRequest.usageMeasured = true;
        if (!adaptiveBudget && Object.values(tokens).reduce((sum, value) => sum + value, 0) > tokenLimit) {
          throw new Error(`Pi exceeded ${tokenBudgetKind} token budget: limit=${tokenLimit}, reported=${Object.values(tokens).reduce((sum, value) => sum + value, 0)}`);
        }
      }
      if (completedCost + currentCost > costLimit) {
        terminate();
        throw new Error(`Pi exceeded remaining cost cap: $${costLimit}`);
      }
      if (event.type === "agent_settled") settled = true;
    }
    const exit = await completion;
    if (terminationError) throw terminationError;
    assertExecutionActive();
    if (sessionFile) {
      const content = await fs.readFile(sessionFile).catch(error => {
        if (error.code === "ENOENT" && !developerSession) return null;
        throw error;
      });
      if (content) {
        await fs.chmod(sessionFile, 0o600); sessionCheckpoint = { file: sessionFile, hash: sha256(content) };
        // Startup compaction precedes JSON-mode event subscriptions. Its native
        // session entries are the authoritative audit, not an absent stream event.
        const entries = content.toString().trim().split("\n").map(JSON.parse);
        for (const entry of entries.filter(entry => entry.type === "custom" && entry.customType === "reqflow_compaction"
            && Date.parse(entry.timestamp) >= startedMs)) {
          const record = entry.data;
          const summaryHash = sha256(record.summary);
          if (compactions.some(row => row.summaryHash === summaryHash)) continue;
          if (record.started?.phase !== phase || record.started.requests !== record.requests
              || !Number.isSafeInteger(record.requests) || record.requests < 1 || record.requests > 2
              || !record.summary.trim() || !Number.isSafeInteger(record.tokensBefore) || record.tokensBefore < 0
              || ["input", "output", "cacheRead", "cacheWrite"].some(key => !Number.isSafeInteger(record.usage?.[key]) || record.usage[key] < 0)
              || !Number.isFinite(record.usage.cost?.total) || record.usage.cost.total < 0)
            throw new Error("Invalid startup compaction session evidence");
          assistantMessages += record.requests;
          for (const key of Object.keys(tokens)) tokens[key] += record.usage[key];
          completedCost += record.usage.cost.total;
          compactions.push({ ...record, summary: undefined, summaryHash, sessionEntryId: entry.id });
        }
      }
    }
    if (terminationError) throw terminationError;
    assertExecutionActive();
    if (timedOut) {
      const current = requestTimings.at(-1);
      const validation = planValidation.at(-1);
      throw new Error(`AI ${phase === "plan" ? "研发方案" : phase === "review" ? "方案核对" : phase === "intake" ? "需求分析" : "任务"}单次模型请求超过 ${Math.round(project.config.maxPiMs / 1000)} 秒执行时限；模型 ${selection.model}，${requestTimings.length} 次模型请求、${toolCalls} 次工具调用。`
        + (current?.status === "running" ? `当前第 ${current.request} 次请求已用 ${Math.round((Date.now() - Date.parse(current.startedAt)) / 1000)} 秒。` : "")
        + (validation?.status === "invalid" ? `最近未通过的检查：${validation.error}` : "")
        + (["plan", "review"].includes(phase) ? "本轮未成功，不会批准或覆盖旧方案；" : "本轮未成功；")
        + "请查看流程记录中的分轮耗时。");
    }
    if (exit.code !== 0 || !settled || stopReason === "error" || stopReason === "aborted") {
      throw new Error(`Pi did not complete: code=${exit.code}, signal=${exit.signal}, stop=${stopReason}, model=${selection.provider}/${selection.model}, error=${modelError}, stderr=${stderr}`);
    }
    if (stopReason === "length" && ["initialize", "intake", "plan", "review"].includes(phase)) {
      const attempt = modelAttempts.at(-1);
      throw new Error(`Pi ${phase} output truncated by the model output limit: ${attempt.provider}/${attempt.model}; output=${attempt.usage.output}, reasoning=${attempt.usage.reasoning ?? "unreported"}. A complete structured result is required; review this model's reasoning and output configuration`);
    }
    if (planValidation.length && planValidation.at(-1).status !== "valid") {
      throw new Error(`Pi plan validation failed: ${planValidation.at(-1).error}`);
    }
    if (intakeValidation.length && intakeValidation.at(-1).status !== "valid") {
      throw new Error(`Pi intake validation failed: ${intakeValidation.at(-1).error}`);
    }
    if (!lastText.trim()) throw new Error("Pi completed without a text result");
    if (validateOutput && !validateOutput(JSON.parse(lastText))) throw new Error(`模型输出不符合 ${executionLimit.outputSchema.name} 结构：${JSON.stringify(validateOutput.errors)}`);
    return { text: lastText, usage, costUsd: completedCost, toolCalls, eventBytes, telemetry: telemetry() };
  } catch (error) {
    terminate();
    let closeError;
    try { await completion; }
    catch (failure) { if (failure !== error) closeError = failure; }
    if (sessionFile && !closeError) {
      try {
        const content = await fs.readFile(sessionFile);
        await fs.chmod(sessionFile, 0o600);
        sessionCheckpoint = { file: sessionFile, hash: sha256(content) };
      } catch (failure) {
        if (failure.code !== "ENOENT") closeError = failure;
      }
    }
    if (timedOut) error.code = "PI_TIMEOUT";
    if (timedOut) error.timeoutScope = "request";
    for (const timing of [...requestTimings, ...toolTimings]) if (timing.status === "running") {
      timing.durationMs = Date.now() - Date.parse(timing.startedAt);
      timing.status = timedOut ? "timed_out" : "interrupted";
    }
    const rejectedBeforeDispatch = assistantMessages === 0 && /REQFLOW_BUDGET_STOP:[^\n]*requests=1,/.test(stderr);
    if (rejectedBeforeDispatch) {
      for (const key of Object.keys(tokens)) tokens[key] = 0;
    }
    error.costUsd = completedCost + currentCost;
    error.toolCalls = toolCalls;
    error.telemetry = { ...telemetry(), requestRejectedBeforeDispatch: rejectedBeforeDispatch };
    if (terminationError || closeError) {
      const failures = [error];
      if (terminationError) failures.push(terminationError);
      if (closeError) failures.push(closeError);
      const combined = new AggregateError(failures,
        `Pi failed and process termination failed: ${failures.map((failure) => failure.message).join("; ")}`);
      combined.costUsd = error.costUsd;
      combined.toolCalls = error.toolCalls;
      combined.telemetry = error.telemetry;
      throw combined;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", terminate);
    clearTimeout(requestTimer);
    clearTimeout(escalation);
    await log.close();
  }
}

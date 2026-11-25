import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { parse } from "shell-quote";
import { fileURLToPath } from "node:url";
import { authenticateByUsername, authenticate, validSessionPrincipal, changePassword, listUsers, saveUser } from "./accounts.js";
import { readJson, writeJson, sha256, safeId, manifestHash } from "../src/files.js";
import { projects, project, openProject, settings, saveSettings, validateSettings, stateDirectory, registerProject } from "./projects.js";
import { saveModelCredential, readModelCredential } from "../src/model-credentials.js";
import { createTask, readTask, readTaskRecord, record, own, access, locked, directory, saveImplementation, assertTaskEditable } from "./tasks.js";
import { applicationView, applicationRunning, withTaskMutation, withSourceSnapshot } from './application.js';
import { readImages, imageLimits } from "./images.js";
import { launch, approve, confirmRequirement, acceptDelivery, rejectDelivery, pause, apply, status, shutdown, answerClarification, resolveDecisions, deleteRequirement, revertDevelopment } from "./flow.js";
import { changes } from "./delivery.js";
import { taskPresentation } from './task-presentation.js';
import { createCenterQuery } from './center-query.js';
import { projectManifest, projectSourceView, projectPolicy } from './project-sources.js';
import { readRecord, searchRecord, downloadRecord, importedBrowserEvidence } from './task-records.js';
import { readProjectMap, initializeProjectMap, historicalInitialization } from './project-context.js';
import { initializationBudget, saveInitializationBudget } from './initialization-settings.js';
import { currentKnowledge } from './project-knowledge.js';
import { latestKnowledgeJob, startKnowledgeJob, resumeKnowledgeJob, pauseKnowledgeJob, shutdownKnowledgeJobs } from './knowledge-jobs.js';
import { CLARIFICATION_ROUND_LIMIT } from "./types.js";
import type { Project, Principal } from "./types.js";

const web = fileURLToPath(new URL("../web/minimal/", import.meta.url));
function send(res: ServerResponse, status: number, data: unknown, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage, limit = 65536) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Error(`请求超过${Math.round(limit / 1024)}KB`); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要JSON对象"); return value;
}
export async function startWebServer(projectPath?: string, port = 4173, host = "127.0.0.1") {
  if (host !== "127.0.0.1") throw new Error("首版仅监听127.0.0.1");
  const fixed = projectPath ? await openProject(projectPath, "default", path.basename(projectPath)) : null;
  const catalog = async () => fixed ? [{ id: fixed.id, name: fixed.name }] : (await projects()).map(p => ({ id: p.id, name: p.name }));
  const resolve = async (id: string) => {
    if (!fixed) return project(id);
    if (id !== fixed.id) throw new Error("当前入口仅服务指定项目");
    return openProject(fixed.root, fixed.id, fixed.name);
  };
  const sessionFile = path.join(stateDirectory(), `sessions-${sha256(JSON.stringify([fixed?.root, host, port, undefined])).slice(0, 24)}.json`);
  let sessions = new Map<string, any>();
  const queryCenter = createCenterQuery();
  const authorizedScope = async (authProject: Project, actor: Principal) => {
    const accessible: Project[] = [], failures: Array<{ projectId: string; projectName: string; error: string }> = [];
    const failedIds = new Set<string>();
    for (const item of await catalog()) {
      try {
        const candidate = await resolve(item.id);
        if (candidate.accountsArchive === authProject.accountsArchive && await validSessionPrincipal(candidate, actor)) accessible.push(candidate);
      } catch {
        failedIds.add(item.id);
        failures.push({ projectId: 'unverified-' + sha256(item.id).slice(0, 16), projectName: '权限尚无法核实的项目', error: '项目登记资料不可读取，请由管理员核查' });
      }
    }
    return { accessible, failures, failedIds };
  };
  try {
    const stat = await fs.stat(sessionFile); if (stat.mode & 0o077) throw new Error("会话文件权限错误");
    for (const [id, value] of Object.entries(await readJson(sessionFile))) if ((value as any).expiresAt > Date.now()) sessions.set(id, value);
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  let saving = Promise.resolve();
  const saveSessions = (change: (next: Map<string, any>) => void) => {
    const persist = async () => {
      const next = new Map(sessions);
      change(next);
      await writeJson(sessionFile, Object.fromEntries(next));
      sessions = next;
    };
    saving = saving.then(persist, persist);
    return saving;
  };
  const server = createServer(async (req, res) => {
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("服务未就绪");
      const origins = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`];
      if (!origins.map(s => new URL(s).host).includes(req.headers.host!)) return send(res, 403, { error: "Host拒绝" });
      const url = new URL(req.url!, origins[0]); const route = url.pathname;
      if (req.method === "GET" && route === "/healthz") return send(res, 200, { status: "ok", product: "minimal" });
      const asset = new Map([["/", ["index.html", "text/html"]], ["/app.js", ["app.js", "text/javascript"]], ["/center.js", ["center.js", "text/javascript"]], ["/records.js", ["records.js", "text/javascript"]], ["/styles.css", ["styles.css", "text/css"]]]).get(route);
      if (req.method === "GET" && asset) {
        res.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(await fs.readFile(path.join(web, asset[0])));
      }
      if (req.method === "GET" && route === "/api/catalog") return send(res, 200, { projects: await catalog() });
      if (!["GET", "HEAD"].includes(req.method!)) {
        if (req.headers.origin && !origins.includes(req.headers.origin)) return send(res, 403, { error: "Origin拒绝" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "需要JSON请求" });
      }
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)reqflow_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      if (route === "/api/login" && req.method === "POST") {
        const value = await body(req); const target = await resolve(value.projectId);
        const principal = value.token ? await authenticate(target, value.token) : await authenticateByUsername(target, value.username, value.password);
        const id = randomBytes(32).toString("hex");
        await saveSessions(next => {
          if (cookie) next.delete(cookie);
          next.set(id, { principal, csrf: randomBytes(24).toString("hex"), expiresAt: Date.now() + 28800000,
            currentProjectId: target.id, authProjectRoot: target.root });
        });
        return send(res, 200, { principal }, { "Set-Cookie": `reqflow_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
      }
      const session = cookie && sessions.get(cookie);
      if (!session || session.expiresAt <= Date.now()) return send(res, 401, { error: "请登录" });
      const authProject = await openProject(session.authProjectRoot, 'identity', '登录项目');
      const actor: Principal = session.principal;
      if (!await validSessionPrincipal(authProject, actor)) return send(res, 401, { error: "登录已失效" });
      if (!["GET", "HEAD"].includes(req.method!) && req.headers["x-reqflow-token"] !== session.csrf) return send(res, 403, { error: "请求凭据错误" });
      if (actor.mustChangePassword && !["/api/bootstrap", "/api/password", "/api/logout"].includes(route)) return send(res, 403, { error: "请先修改临时密码" });
      const globalRoutes = ['/api/bootstrap', '/api/logout', '/api/password', '/api/project', '/api/center'];
      const projectId = url.searchParams.get('projectId');
      if (!globalRoutes.includes(route) && (!projectId || url.searchParams.getAll('projectId').length !== 1))
        return send(res, 400, { error: '请求必须明确指定 projectId' });
      const target = globalRoutes.includes(route) ? authProject : await resolve(projectId!);
      if (target.accountsArchive !== authProject.accountsArchive || !await validSessionPrincipal(target, actor))
        return send(res, 403, { error: '无权访问该项目' });
      if (route === "/api/bootstrap" && req.method === "GET") {
        const scope = await authorizedScope(authProject, actor);
        const accessible = scope.accessible.map(item => ({ id: item.id, name: item.name }));
        const preferred = accessible.find(item => item.id === session.currentProjectId);
        if (!preferred) return send(res, 403, { error: '默认项目已不可访问，请重新登录' });
        return send(res, 200, { principal: actor, token: session.csrf, project: preferred, projects: accessible,
          contextKey: sha256(JSON.stringify([authProject.accountsArchive, actor.id, actor.authVersion])),
          projectFailures: scope.failures,
          projectImport: !fixed, directoryHome: actor.roles.includes("admin") ? os.homedir() : null, imageLimits, clarificationLimit: CLARIFICATION_ROUND_LIMIT });
      }
      if (route === "/api/logout" && req.method === "POST") {
        await saveSessions(next => next.delete(cookie!));
        return send(res, 200, { ok: true }, { "Set-Cookie": "reqflow_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict" });
      }
      if (route === "/api/password" && req.method === "POST") {
        const value = await body(req); await changePassword(target, actor, value.oldPassword, value.newPassword);
        return send(res, 200, { ok: true, loginRequired: true });
      }
      if (route === "/api/project" && req.method === "POST") {
        const next = await resolve((await body(req)).projectId);
        if (next.accountsArchive !== target.accountsArchive || !await validSessionPrincipal(next, actor)) return send(res, 403, { error: "无权切换至该项目" });
        await saveSessions(entries => {
          const current = entries.get(cookie!);
          if (!current) throw Object.assign(new Error('登录已失效'), { status: 401 });
          entries.set(cookie!, { ...current, currentProjectId: next.id });
        });
        return send(res, 200, { ok: true });
      }
      if (route === '/api/center' && req.method === 'GET') {
        const scope = await authorizedScope(authProject, actor);
        const range = url.searchParams.get('range');
        if (range !== null && range !== 'all' && scope.failedIds.has(range)) return send(res, 503, {
          error: '所选项目资料读取失败，请由管理员核查后重新查找', incomplete: true, total: null,
          failures: [{ projectId: range, projectName: '所选项目', error: '项目登记资料不可读取' }] });
        return send(res, 200, await queryCenter(scope.accessible, actor, url.searchParams,
          sha256(JSON.stringify([authProject.accountsArchive, actor.id, actor.authVersion])), scope.failures));
      }
      if (route === "/api/settings" && req.method === "GET") return send(res, 200, await settings(target));
      if (route === '/api/project-sources' && req.method === 'GET') return send(res, 200, { sources: target.sources });
      if (route === '/api/project-context' && req.method === 'GET') {
        const map = await readProjectMap(target), history = await historicalInitialization(target);
        const config = map === null ? null : await settings(target);
        const stale = config !== null && map !== null && map.sourceHash !== manifestHash(await projectManifest(target, config));
        return send(res, 200, { map: map === null ? null : { id: map.id, at: map.at, actor: map.actor, files: Object.keys(map.nodes).length, stale,
          links: Object.values(map.nodes).reduce((sum, node) => sum + node.links.length, 0), changed: map.changed.length,
          modules: Object.entries(map.nodes).map(([file, node]) => ({ file, links: node.links, anchors: node.anchors })) }, history,
          sources: target.sources,
          knowledge: config === null ? null : await currentKnowledge(target, await projectSourceView(target, config), config), job: await latestKnowledgeJob(target),
          initializationBudget: await initializationBudget(target), canSetInitializationBudget: actor.roles.includes('admin'),
          canInitialize: actor.roles.some(role => ['admin', 'developer'].includes(role)) });
      }
      if (route === '/api/initialization-budget' && req.method === 'PUT') {
        if (!actor.roles.includes('admin')) return send(res, 403, { error: '初始化预算由管理员维护' });
        await saveInitializationBudget(target, await body(req), actor.id);
        return send(res, 200, { ok: true });
      }
      if (route === '/api/project-context/index' && req.method === 'POST') {
        if (!actor.roles.some(role => ['admin', 'developer'].includes(role))) return send(res, 403, { error: '项目初始化由研发或管理员执行' });
        if (Object.keys(await body(req)).length) throw new Error('结构索引更新不接受额外字段');
        const map = await initializeProjectMap(target, await settings(target), actor.id);
        return send(res, 200, { id: map.id, at: map.at, files: Object.keys(map.nodes).length, changed: map.changed.length });
      }
      if (route === '/api/project-context/initialize' && req.method === 'POST') {
        const value = await body(req); if (Object.keys(value).some(key => key !== 'scope')) throw new Error('项目理解只接受梳理范围，身份来自当前登录');
        return send(res, 202, await startKnowledgeJob(target, actor, value.scope));
      }
      const knowledgeAction = route.match(/^\/api\/project-context\/jobs\/([A-Za-z0-9_-]+)\/(continue|pause)$/);
      if (knowledgeAction && req.method === 'POST') {
        if (Object.keys(await body(req)).length) throw new Error('项目理解续跑和暂停不接受额外字段');
        return send(res, 202, await (knowledgeAction[2] === 'pause' ? pauseKnowledgeJob(target, knowledgeAction[1], actor) : resumeKnowledgeJob(target, knowledgeAction[1], actor)));
      }
      if (route === '/api/participants' && req.method === 'GET') return send(res, 200, { users: await listUsers(target) });
      if (route === "/api/directories" && req.method === "GET") {
        if (!actor.roles.includes("admin")) return send(res, 403, { error: "选择项目文件夹仅限管理员" });
        if (fixed) return send(res, 403, { error: "请从日常全局入口导入项目" });
        const input = url.searchParams.get("path");
        if (typeof input !== "string" || !path.isAbsolute(input) || url.searchParams.getAll("path").length !== 1)
          throw new Error("请选择或填写绝对目录路径");
        const resolved = await fs.realpath(input);
        const entries = (await fs.readdir(resolved, { withFileTypes: true }))
          .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
          .map(entry => ({ name: entry.name, path: path.join(resolved, entry.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return send(res, 200, { path: resolved, parent: path.dirname(resolved), entries });
      }
      if (route === "/api/users" && ["GET", "POST"].includes(req.method!)) {
        if (!actor.roles.includes("admin")) return send(res, 403, { error: "用户管理仅限管理员" });
        if (req.method === "GET") return send(res, 200, { users: await listUsers(target) });
        return send(res, 200, await saveUser(target, actor, await body(req)));
      }
      if (route === "/api/projects" && req.method === "POST") {
        if (!actor.roles.includes("admin")) return send(res, 403, { error: "项目导入仅限管理员" });
        if (fixed) return send(res, 403, { error: "请从日常全局入口导入项目" });
        const value = await body(req);
        return send(res, 201, await registerProject(target, actor.id, value));
      }
      if (route === "/api/settings" && req.method === "PUT") {
        if (!actor.roles.includes("admin")) return send(res, 403, { error: "模型与项目策略由管理员设置" });
        const config = validateSettings(await body(req));
        for (const provider of config.providers) await readModelCredential(target.accountsArchive, provider.credentialId);
        await saveSettings(target, config, actor.id); return send(res, 200, { ok: true });
      }
      if (route === "/api/model-credentials" && req.method === "POST") {
        if (!actor.roles.includes("admin")) return send(res, 403, { error: "模型凭据由管理员设置" });
        const value = await body(req);
        const id = await saveModelCredential(target.accountsArchive, value.apiKey);
        return send(res, 201, { id });
      }
      if (route === "/api/model-connection" && req.method === "POST") {
        if (!actor.roles.includes("admin")) return send(res, 403, { error: "模型连接测试仅限管理员" });
        const value = await body(req), config = await settings(target);
        const provider = config.providers.find(p => p.id === value.provider);
        if (!provider || !provider.models.some(m => m.id === value.model)) throw new Error("请先保存该供应商与模型的配置");
        const key = await readModelCredential(target.accountsArchive, provider.credentialId);
        const response = await fetch(provider.baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(20000), body: JSON.stringify({ model: value.model,
            messages: [{ role: provider.systemRole, content: "Reply briefly." }, { role: "user", content: "Reply OK." }],
            [provider.outputLimitField]: 64, ...(provider.thinkingToggle ? { enable_thinking: false } : {}) }) });
        if (!response.ok) throw new Error(`模型连接失败，供应商返回 HTTP ${response.status}`);
        const result = await response.json() as any;
        if (!Array.isArray(result.choices) || !result.choices.length || typeof result.choices[0].message?.content !== "string")
          throw new Error("供应商未返回有效的 Chat Completions 答复");
        return send(res, 200, { ok: true, model: value.model, usage: result.usage ?? null });
      }
      if (route === "/api/unit-checks" && req.method === "PUT") {
        if (!actor.roles.some(role => ['admin', 'developer'].includes(role))) return send(res, 403, { error: '必要检查由研发维护' });
        const current = await settings(target); const value = await body(req);
        if (!Array.isArray(value.checks) || Object.keys(value).some(key => key !== 'checks')) throw new Error('请提交必要检查列表');
        const checks = value.checks.map((check: any) => {
          if (!check || typeof check.commandLine !== 'string') throw new Error('请填写检查命令');
          const command = parse(check.commandLine, name => { throw new Error('检查命令不支持变量展开：' + name); });
          if (!command.length || command.some(part => typeof part !== 'string')) throw new Error('检查只允许程序与参数，不支持管道、重定向或变量展开');
          const { commandLine, ...fields } = check; return { ...fields, command };
        });
        await saveSettings(target, { ...current, unitChecks: checks }, actor.id); return send(res, 200, { ok: true });
      }
      if (route === "/api/tasks" && req.method === "GET") {
        const params = new URLSearchParams(url.searchParams); params.delete('projectId'); params.set('range', target.id);
        if (!params.has('view')) params.set('view', 'all');
        return send(res, 200, await queryCenter([target], actor, params,
          sha256(JSON.stringify([authProject.accountsArchive, actor.id, actor.authVersion]))));
      }
      if (route === "/api/tasks" && req.method === "POST") {
        const value = await body(req, 8 * 1024 * 1024); const config = await settings(target);
        const created = await withSourceSnapshot(target, () => createTask(target, actor, value.title, value.request, config, value.images));
        return send(res, 201, created);
      }
      const imageRoute = route.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/image\/([a-f0-9]{64})$/);
      if (imageRoute && req.method === "GET") {
        const task = await readTask(target, imageRoute[1]); own(task, actor);
        const record = task.images.find(image => image.hash === imageRoute[2]);
        if (!record) return send(res, 404, { error: "截图不存在" });
        const [content] = await readImages(directory(target, task.id), [record]);
        res.writeHead(200, { "Content-Type": record.mimeType, "Cache-Control": "no-store" });
        return res.end(Buffer.from(content.data, "base64"));
      }
      const recordRoute = route.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/records\/(unit|pi)\/(read|search|download)$/);
      if (recordRoute && req.method === 'GET') {
        const task = await readTask(target, recordRoute[1]); own(task, actor);
        const allowed = recordRoute[3] === 'read' ? ['projectId', 'version', 'offset', 'limit'] : recordRoute[3] === 'search' ? ['projectId', 'version', 'offset', 'q'] : ['projectId', 'version'];
        for (const name of url.searchParams.keys()) if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1)
          return send(res, 400, { error: '记录请求包含未知或重复参数' });
        if (recordRoute[3] === 'download') return await downloadRecord(target, task, recordRoute[2] as 'unit' | 'pi', url.searchParams.get('version'), res);
        if (recordRoute[3] === 'search') return send(res, 200, await searchRecord(target, task, recordRoute[2] as 'unit' | 'pi', url.searchParams));
        return send(res, 200, await readRecord(target, task, recordRoute[2] as 'unit' | 'pi', url.searchParams));
      }
      const match = route.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)(?:\/(card|implementation|confirm|message|start|continue|pause|accept|reject|apply|rollback|recover|application|diff|answers|decisions|decisions-resolve|decisions-reconsider|delete|revert-development|audit))?$/);
      if (match) {
        const id = match[1]; const action = match[2]; const { task, developmentStarted, review, importedReview } = await readTaskRecord(target, id);
        if (req.method === 'GET' && action === 'audit') {
          if (!actor.roles.includes('admin')) return send(res, 403, { error: '仅管理员可下载删除审计' });
          const bytes = await fs.readFile(path.join(directory(target, id), 'events.jsonl'));
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${id}-audit.jsonl"`, 'Cache-Control': 'no-store' });
          return res.end(bytes);
        }
        own(task, actor);
        if (req.method === "GET" && !action) {
          let policyStatus: 'current' | 'changed' | 'unavailable', policyError: string | null = null;
          try { policyStatus = task.approval && task.approval.policyHash !== projectPolicy(target, await settings(target)) ? 'changed' : 'current'; }
          catch (error: any) {
            if (task.application === null) throw error;
            policyStatus = 'unavailable'; policyError = error.message;
          }
          const policyChanged = policyStatus !== 'current';
          const execution = status(target, id);
          const applying = await applicationRunning(target, task);
          const historical = importedReview === null ? null : { ...importedReview.originalReview, current: false,
            originTaskId: importedReview.originTaskId, matchesVersion: importedReview.candidateHash === task.sourceHash
              && importedReview.originalReview.requirementRevision === task.cardRevision,
            browser: await importedBrowserEvidence(target, task, importedReview) };
          return send(res, 200, { task, developmentStarted, review: review === null ? null : { ...review, current: review.current && !policyChanged }, access: access(task, actor), policyChanged, policyStatus, policyError, execution, applicationRunning: applying,
            importedReview: historical, presentation: taskPresentation(task, execution, policyChanged, applying),
            clarificationLimit: CLARIFICATION_ROUND_LIMIT, imageLimits });
        }
        if (req.method === "GET" && action === "diff") return send(res, 200, await changes(target, task, await settings(target)));
        if (req.method === 'GET' && action === 'application') return send(res, 200, await applicationView(target, task));
        if (req.method !== "POST") return send(res, 405, { error: "不支持的请求方法" });
        return await locked('action:' + directory(target, id), async () => {
        const value = await body(req, action === 'message' || action === 'answers' ? 8 * 1024 * 1024 : 65536);
        if (Object.hasOwn(value, 'actor')) return send(res, 400, { error: '操作身份来自登录会话' });
        const execute = async () => {
        const respond = (status: number, value: unknown) => ({ status, value });
        const task = await readTask(target, id); own(task, actor);
        if (action !== 'recover' && action !== 'rollback') assertTaskEditable(task);
        if (action === "card") {
          own(task, actor, 'product');
          if (status(target, id) || !['draft', 'queued', 'ready', 'accepted', 'attention'].includes(task.state) || value.revision !== task.cardRevision) throw new Error("需求卡阶段或版本已变");
          if (typeof value.card !== "string" || value.card.trim().length < 10 || value.card.length > 12000) throw new Error("需求卡正文无效");
          return respond( 200, await record(target, id, actor.id, "card_edited", { card: value.card, cardRevision: task.cardRevision + 1,
            confirmation: null, approval: null, acceptance: null, feedback: null, state: "draft", check: null, issues: [], failure: null }));
        }
        if (action === 'implementation') {
          own(task, actor, 'development');
          if (status(target, id)) throw new Error('请先暂停执行再编辑研发说明');
          return respond( 200, await saveImplementation(target, id, actor.id, value.requirementRevision, value.revision, value.content));
        }
        if (action === "message") {
          if (typeof value.text !== "string" || value.text.length > 30000) throw new Error("请输入有效说明");
          if (value.images !== undefined && !Array.isArray(value.images)) throw new Error("截图必须是数组");
          const images = value.images ?? [];
          if (!value.text.trim() && !images.length) throw new Error("请输入有效说明或上传截图");
          return respond( 202, await launch(target, id, actor, "message",
            value.text.trim() || "已上传截图，请结合截图补齐需求边界与验收条件。", images));
        }
        if (action === "answers") {
          if (!Array.isArray(value.answers)) throw new Error("请提交对反问的回答");
          if (value.note !== undefined && typeof value.note !== "string") throw new Error("补充说明格式无效");
          return respond( 202, await answerClarification(target, id, actor, value.answers, value.note ?? "", value.images));
        }
        if (action === "decisions-resolve") {
          if (!Array.isArray(value.resolutions)) throw new Error("请逐项处理确认项");
          return respond( 200, await resolveDecisions(target, id, actor, value.resolutions));
        }
        if (action === "decisions") return respond( 202, await launch(target, id, actor, "decisions", ""));
        if (action === "decisions-reconsider") return respond( 202, await launch(target, id, actor, "reconsider", ""));
        if (action === 'confirm') return respond( 200, await confirmRequirement(target, id, actor, value.revision, value.developer));
        if (action === "start") return respond( 202, await approve(target, id, actor, value.revision));
        if (action === 'delete') return respond( 200, await deleteRequirement(target, id, actor, value.version));
        if (action === 'revert-development') return respond( 200, await revertDevelopment(target, id, actor, value.revision));
        if (action === "continue") return respond( 202, await launch(target, id, actor, "continue", ""));
        if (action === "pause") return respond( 200, await pause(target, id, actor));
        if (action === 'accept') return respond( 200, await acceptDelivery(target, id, actor, value.sourceHash));
        if (action === 'reject') return respond( 200, await rejectDelivery(target, id, actor, value.sourceHash, value.reason));
        if (action === "apply" || action === "rollback") return respond( 200, await apply(target, id, actor, value.sourceHash, action === "rollback"));
        if (action === 'recover') {
          if (!['apply', 'rollback'].includes(value.direction)) throw new Error('请明确恢复应用或恢复回滚');
          return respond( 200, await apply(target, id, actor, value.sourceHash, value.direction === 'rollback', true));
        }
        return respond( 404, { error: '任务操作不存在' });
        };
        const result = ['apply', 'rollback', 'recover'].includes(action!) ? await execute() : await withTaskMutation(target, task, execute);
        return send(res, result.status, result.value);
        });
      }
      if (route === "/api/history" && req.method === "GET") {
        const home = path.join(target.archive, "tasks"); let entries: string[];
        try { entries = await fs.readdir(home); } catch (e: any) { if (e.code !== "ENOENT") throw e; entries = []; }
        const history: Array<{ id: string; title: string; state: string; updatedAt: string }> = [];
        for (const id of entries.slice(0, 100)) {
          const rows = (await fs.readFile(path.join(home, safeId(id), "events.jsonl"), "utf8")).trim().split("\n");
          const meta = JSON.parse(rows.at(-1)!).meta;
          if (meta.createdBy === actor.id || meta.assignments?.developer?.userId === actor.id || actor.roles.includes("admin"))
            history.push({ id, title: meta.title, state: meta.state, updatedAt: meta.updatedAt });
        }
        return send(res, 200, { history, readOnly: true, total: entries.length });
      }
      const history = route.match(/^\/api\/history\/([A-Za-z0-9_-]+)$/);
      if (history && req.method === "GET") {
        const file = path.join(target.archive, "tasks", safeId(history[1]), "events.jsonl");
        const bytes = await fs.readFile(file); const rows = bytes.toString("utf8").trim().split("\n"); const meta = JSON.parse(rows.at(-1)!).meta;
        if (meta.createdBy !== actor.id && meta.assignments?.developer?.userId !== actor.id && !actor.roles.includes("admin")) return send(res, 403, { error: "无权读取历史" });
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Content-Disposition": `attachment; filename="${history[1]}-audit.jsonl"`, "Cache-Control": "no-store" });
        return res.end(bytes);
      }
      return send(res, 404, { error: "接口不存在" });
    } catch (error: any) { if (res.headersSent) { res.destroy(error); return; } return send(res, error.status ?? 400,
      { error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}) }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("服务启动失败");
  return { server, url: `http://${host}:${address.port}`, stop: async () => { await Promise.all([shutdown(), shutdownKnowledgeJobs()]); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); } };
}

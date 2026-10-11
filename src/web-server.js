import { createServer } from "node:http";
import { stopAllLocalRuntimes } from "./local-runtime.js";
import { controlledExecution, executionStatus, pauseExecution, assertExecutionActive } from "./action-progress.js";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "./config.js";
import { deploymentRequiresPublishedRevision } from "./deploy.js";
import { admissionPolicy } from "./admission.js";
import { readProjectBaseline, renderProjectBaseline } from "./baseline.js";
import { readInitialization } from "./project-initialization.js";
import { readGitSetup, candidateReview } from "./git-delivery.js";
import { configureExecution, readExecutionSetup, verifyDeploymentConnection, executionConfigurationHistory } from "./project-execution.js";
import { readModelSettings, configureModels, testModelConnection } from "./model-settings.js";
import { allowedActions, authenticate, authenticateByUsername, authorize, canReadTask, canConfigureEnvironment, changePassword, listUsers, loadCredentials, resetPassword, updateUserRoles, validSessionPrincipal } from "./auth.js";
import { readLocalEnvironment, configureLocalEnvironment, checkLocalEnvironment, localEnvironmentReport } from "./local-environment.js";
import { scanLocalEnvironment, environmentScanDiff } from "./environment-scan.js";
import { readJson, sha256, writeJson } from "./files.js";
import { actionAuditContext, readTask, taskPath } from "./store.js";
import { createRequirement, executeRequirementAction, getAuditReport, getAuthenticationHistory, getChangedFile,
  getRequirementEvidence, getRequirementImage, getRequirementLifecycle, getTaskHistory, getTaskObservability } from "./core.js";
import { listProjects, importProject, removeProject, getProject, analyzeProjectStructure, regenerateProjectReference, generateProjectReference } from "./project-registry.js";

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/environment.js", ["environment.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/mermaid.js", ["../node_modules/@mermaid-js/tiny/dist/mermaid.tiny.js", "text/javascript; charset=utf-8"]],
]);
const reviewStates = new Set(["assignment_pending", "intake_feedback", "intake_clarifying", "intake_ready", "plan_review", "test_deployed", "released", "rolled_back"]);
const doneStates = new Set(["archived", "archived_test_only"]);
const errorStates = new Set(["implementation_failed", "implementation_inspection_failed", "implementation_interrupted",
  "verification_failed", "test_deploy_failed", "test_deploy_outcome_unknown", "merge_verification_failed",
  "release_failed", "release_outcome_unknown"]);

function send(res, status, value, headers = {}) {
  const content = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(content);
}

function sameOrigin(req, allowedOrigins) {
  const origin = req.headers.origin;
  return !origin || allowedOrigins.includes(origin);
}

function sessionId(req) {
  const match = req.headers.cookie?.match(/(?:^|;\s*)reqflow_session=([a-f0-9]{64})(?:;|$)/);
  return match?.[1] ?? null;
}

async function readBody(req, maximum = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error(`Request body exceeds ${maximum} bytes`);
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object is required");
  return value;
}

function queryPage(url) {
  const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Pagination requires offset >= 0 and limit between 1 and 100");
  }
  return { offset, limit };
}

async function overview(project, projectName, principal, offset, limit) {
  const index = await readJson(path.join(project.archive, "index.json"));
  if (!Array.isArray(index)) throw new Error("Task index is invalid");
  const rows = index.filter((row) => canReadTask(principal, row));
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const counts = { review: 0, active: 0, done: 0, error: 0 };
  for (const row of rows) {
    const group = row.executionPaused || reviewStates.has(row.state) ? "review" : doneStates.has(row.state) ? "done"
      : errorStates.has(row.state) ? "error" : "active";
    counts[group]++;
  }
  return {
    project: { name: projectName, root: project.root, mode: project.config.mode,
      testDeployment: project.config.testDeployment.kind, productionDeployment: project.config.productionDeployment.kind,
      executionReady: project.config.testDeployment.kind !== "unconfigured",
      checksConfigured: project.config.checks.length > 0,
      canConfigureEnvironment: canConfigureEnvironment(principal, index),
      localEnvironment: await localEnvironmentReport(project),
      deploymentRequiresPublishedRevision: deploymentRequiresPublishedRevision(project.config.testDeployment),
      gitDelivery: project.config.mode === "git" ? { testMode: project.config.gitDelivery?.testMode ?? "branch",
        testBranch: project.config.gitDelivery?.testBranch ?? null } : null,
      fastPath: project.config.fastPath?.enabled === true, admission: admissionPolicy(project.config) },
    total: rows.length,
    counts,
    offset, limit, tasks: rows.slice(offset, offset + limit),
  };
}

export async function startWebServer(projectPath, port = 4173, options = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Port must be 0–65535");
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(host)) throw new Error("Web host must be 127.0.0.1 or 0.0.0.0");
  if (host === "0.0.0.0" && !options.origins) throw new Error("Network binding requires explicit public origins");
  if (options.origins !== undefined) {
    if (!Array.isArray(options.origins) || !options.origins.length) throw new Error("Public origins must be a nonempty array");
    for (const origin of options.origins) {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("Public origin must be an exact HTTP(S) origin without path or credentials");
    }
  }
  const defaultProject = projectPath ? await loadProject(projectPath) : null;
  if (defaultProject) await loadCredentials(defaultProject);
  const stateDir = process.env.REQFLOW_STATE_DIR ?? path.join(os.homedir(), ".reqflow");
  const sessionsFile = path.join(stateDir, `sessions-${sha256(JSON.stringify([defaultProject?.root, host, port, options.origins])).slice(0, 24)}.json`);
  const sessions = new Map();
  try {
    const stat = await fs.stat(sessionsFile);
    if (stat.mode & 0o077) throw new Error("Session file must be owner-only (0600)");
    const saved = await readJson(sessionsFile);
    const now = Date.now();
    for (const [id, data] of Object.entries(saved)) {
      if (data.expiresAt > now) sessions.set(id, data);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let sessionWrite = Promise.resolve();
  async function persistSessions() {
    sessionWrite = sessionWrite.then(() => writeJson(sessionsFile, Object.fromEntries(sessions)));
    await sessionWrite;
  }
  const server = createServer(async (req, res) => {
    const allowedOrigins = options.origins ?? [`http://127.0.0.1:${server.address().port}`, `http://localhost:${server.address().port}`];
    const allowedHosts = allowedOrigins.map((origin) => new URL(origin).host);
    if (!allowedHosts.includes(req.headers.host)) return send(res, 403, { error: "Host is not allowed" });
    const requestUrl = new URL(req.url, "http://localhost");
    const pathname = requestUrl.pathname;
    try {
      if (req.method === "GET" && pathname === "/healthz") return send(res, 200, { status: "ok" });
      if (req.method === "GET" && staticFiles.has(pathname)) {
        const [file, mime] = staticFiles.get(pathname);
        const content = await fs.readFile(path.join(publicRoot, file));
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'" });
        return res.end(content);
      }
      if (req.method === "POST" && pathname === "/api/login") {
        if (!sameOrigin(req, allowedOrigins)) return send(res, 403, { error: "Origin is not allowed" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const body = await readBody(req);
        let principal;
        let loginProject = defaultProject;
        let currentProjectId = defaultProject ? "default" : null;
        if (body.projectId && body.projectId !== "default") {
          const record = await getProject(body.projectId);
          loginProject = await loadProject(record.projectDir);
          currentProjectId = record.id;
        }
        if (!loginProject) {
          const projects = await listProjects();
          if (projects.length > 0) {
            loginProject = await loadProject(projects[0].projectDir);
            currentProjectId = projects[0].id;
          }
        }
        if (!loginProject) return send(res, 400, { error: "No projects available" });
        await loadCredentials(loginProject);
        try {
          if (body.username && body.password) {
            principal = await authenticateByUsername(loginProject, body.username, body.password);
          } else if (body.token) {
            principal = await authenticate(loginProject, body.token);
          } else {
            return send(res, 400, { error: "Username/password or token is required" });
          }
        } catch (error) { return send(res, 401, { error: error.message }); }
        const now = Date.now();
        for (const [sid, session] of sessions) if (session.expiresAt <= now) sessions.delete(sid);
        if (sessions.size >= 500) return send(res, 429, { error: "Session limit reached" });
        const newSessionId = randomBytes(32).toString("hex");
        const previousSession = sessionId(req);
        if (previousSession) sessions.delete(previousSession);
        sessions.set(newSessionId, { principal, csrf: randomBytes(24).toString("hex"),
          expiresAt: now + 8 * 60 * 60 * 1000, currentProjectId, authProjectRoot: loginProject.root });
        await persistSessions();
        const secure = allowedOrigins.includes(`https://${req.headers.host}`) ? "; Secure" : "";
        return send(res, 200, { principal }, { "Set-Cookie": `reqflow_session=${newSessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}` });
      }
      const id = sessionId(req);
      const session = id && sessions.get(id);
      const projects = await listProjects();
      const noProjects = projects.length === 0 && !defaultProject;
      if (!session || session.expiresAt <= Date.now()) {
        if (id) { sessions.delete(id); await persistSessions(); }
        if (noProjects && pathname === "/api/bootstrap" && req.method === "GET") {
          return send(res, 200, { token: null, principal: null, actions: [], projects: [], noProjects: true,
            setupRequired: "Start the web CLI to create the built-in demo, or import a project with the CLI" });
        }
        return send(res, 401, { error: "Login required" });
      }

      // Resolve current project: prioritize session selection over default
      let project = null;
      let projectName = null;
      if (session?.currentProjectId) {
        const projectRecord = projects.find((p) => p.id === session.currentProjectId);
        if (projectRecord) {
          project = await loadProject(projectRecord.projectDir);
          projectName = projectRecord.name;
          await loadCredentials(project);
        }
      }
      if (session.currentProjectId === "default" && defaultProject) {
        project = await loadProject(defaultProject.root);
        projectName = path.basename(defaultProject.root);
      }
      if (!project || !await validSessionPrincipal(project, session.principal)) {
        sessions.delete(id);
        await persistSessions();
        return send(res, 401, { error: "Session was revoked" });
      }
      if (session.principal.mustChangePassword && !["/api/bootstrap", "/api/change-password", "/api/logout"].includes(pathname)) {
        return send(res, 403, { error: "Change the temporary password before using project APIs" });
      }
      if (!project && !pathname.startsWith("/api/projects") && !pathname.startsWith("/api/browse") && pathname !== "/api/bootstrap") {
        return send(res, 400, { error: "No project selected" });
      }

      if (req.method === "GET" && pathname === "/api/browse/home") {
        authorize(session.principal, "audit-report");
        return send(res, 200, { path: os.homedir() });
      }
      if (req.method === "GET" && pathname === "/api/browse") {
        authorize(session.principal, "audit-report");
        const dirPath = requestUrl.searchParams.get("path") || os.homedir();
        const resolved = path.resolve(dirPath);
        const entries = [];
        for (const entry of await fs.readdir(resolved, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          if (!entry.isDirectory()) continue;
          entries.push({ name: entry.name, path: path.join(resolved, entry.name) });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return send(res, 200, { path: resolved, entries });
      }
      if (req.method === "GET" && pathname === "/api/bootstrap") {
        if (noProjects && !session) {
          return send(res, 200, { token: null, principal: null, actions: [], currentProjectId: null, projects: [], noProjects: true });
        }
        const currentProjectId = session.currentProjectId;
        const catalog = defaultProject ? [{ id: "default", name: path.basename(defaultProject.root) },
          ...projects.filter(entry => entry.projectDir !== defaultProject.root)] : projects;
        return send(res, 200, { token: session.csrf, principal: session.principal,
          actions: allowedActions(session.principal), currentProjectId,
          importRootDir: process.env.REQFLOW_IMPORT_DIR ?? "",
          projects: (await Promise.all(catalog.map(async entry => {
            const target = entry.id === "default" ? defaultProject : await loadProject(entry.projectDir);
            if (entry.id !== "default" && target.root === defaultProject?.root) return null;
            return target.accountsArchive === project.accountsArchive ? { id: entry.id, name: entry.name } : null;
          }))).filter(entry => entry !== null) });
      }
      if (req.method === "GET" && pathname === "/api/projects") {
        authorize(session.principal, "audit-report");
        return send(res, 200, { projects: projects.map(({ id, name }) => ({ id, name })) });
      }
      if (req.method === "POST" && pathname === "/api/projects") {
        if (!sameOrigin(req, allowedOrigins)) return send(res, 403, { error: "Origin is invalid" });
        if (req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        authorize(session.principal, "import-project");
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const body = await readBody(req);
        const importPaths = { rootDir: body.rootDir, frontendDir: body.frontendDir, backendDir: body.backendDir };
        if (body.options?.admin !== undefined || body.options?.accountSource !== undefined) {
          return send(res, 400, { error: "Project import uses the signed-in account directory" });
        }
        let config = body.options?.config;
        if (config === undefined) {
          config = { ...project.config, mode: "local", allowedPaths: ["."], checks: [], maxSnapshotBytes: 100 * 1024 * 1024,
            fastPath: { enabled: false }, testDeployment: { kind: "unconfigured" },
            productionDeployment: { kind: "none" } };
          for (const key of ["baseBranch", "releaseBranch", "branchPrefix", "remote", "gitDelivery"]) delete config[key];
        }
        const imported = await importProject(body.name, importPaths, { ...body.options, config,
          inventoryOnly: body.options?.inventoryOnly ?? true,
          detectExecution: body.options?.config === undefined, accountSource: project.accountsArchive });
        return send(res, 201, imported);
      }
      if (req.method === "POST" && pathname === "/api/projects/analyze") {
        if (!sameOrigin(req, allowedOrigins)) return send(res, 403, { error: "Origin is invalid" });
        if (req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        authorize(session.principal, "import-project");
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const body = await readBody(req);
        const analyzeDir = body.directory || body.rootDir || body.frontendDir || body.backendDir;
        return send(res, 200, await analyzeProjectStructure(analyzeDir));
      }
      const projectSwitchMatch = pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/switch$/);
      if (req.method === "POST" && projectSwitchMatch) {
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        const projectId = projectSwitchMatch[1];
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        await readBody(req);
        const record = projectId === "default" && defaultProject ? { projectDir: defaultProject.root } : await getProject(projectId);
        const target = await loadProject(record.projectDir);
        if (target.accountsArchive !== project.accountsArchive || !await validSessionPrincipal(target, session.principal)) {
          return send(res, 403, { error: "Project does not use this account directory" });
        }
        session.csrf = randomBytes(24).toString("hex");
        session.currentProjectId = projectId;
        await persistSessions();
        return send(res, 200, { projectId });
      }
      const projectDeleteMatch = pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/);
      if (req.method === "DELETE" && projectDeleteMatch) {
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        authorize(session.principal, "audit-report");
        const projectId = projectDeleteMatch[1];
        if (session.currentProjectId !== projectId) return send(res, 403, { error: "Authenticate as an administrator of the target project first" });
        await removeProject(projectId, session.principal.id);
        sessions.delete(id);
        await persistSessions();
        return send(res, 200, { archived: projectId });
      }
      if (req.method === "POST" && pathname === "/api/logout") {
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        sessions.delete(id);
        await persistSessions();
        return send(res, 200, { loggedOut: true }, { "Set-Cookie": "reqflow_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
      }
      if (req.method === "GET" && pathname === "/api/overview") {
        const { offset, limit } = queryPage(requestUrl);
        return send(res, 200, await overview(project, projectName, session.principal, offset, limit));
      }
      if (req.method === "GET" && pathname === "/api/project-git") return send(res, 200, await readGitSetup(project.root));
      if (pathname === "/api/environment-status" && req.method === "GET") {
        const setup = await readLocalEnvironment(project);
        const rows = await readJson(path.join(project.archive, "index.json"));
        const visible = rows.filter(row => canReadTask(session.principal, row));
        return send(res, 200, { local: { configured: setup.configured, version: setup.version,
          report: await localEnvironmentReport(project), history: setup.history.map(event => ({ ...event,
            affectedRequirements: event.affectedRequirements.filter(id => visible.some(row => row.id === id)) })) },
          test: { kind: project.config.testDeployment.kind, url: project.config.testDeployment.url ?? "",
            history: (await executionConfigurationHistory(project)).map(({ actor, at, configHash }) => ({ actor, at, configHash })) },
          canConfigure: canConfigureEnvironment(session.principal, rows),
          affectedRequirements: visible.filter(row => !doneStates.has(row.state)).map(row => ({ id: row.id, title: row.title })) });
      }
      if (["/api/local-environment", "/api/local-environment-scan"].includes(pathname) && ["GET", "POST"].includes(req.method)
          || pathname === "/api/local-environment-check" && req.method === "POST") {
        authorize(session.principal, "configure-environment");
        if (!canConfigureEnvironment(session.principal, await readJson(path.join(project.archive, "index.json"))))
          return send(res, 403, { error: "仅管理员和已接受当前项目需求分工的研发可以配置环境。" });
        const setup = await readLocalEnvironment(project);
        const sourceRoot = async taskId => {
          if (!taskId) return project.root;
          const task = await readTask(project, taskId);
          if (!canReadTask(session.principal, task.meta) || !task.meta.workspace) throw new Error("当前需求没有可扫描的研发工作目录。");
          return task.meta.workspace;
        };
        if (req.method === "GET") {
          if (pathname === "/api/local-environment") return send(res, 200, setup);
          const taskId = requestUrl.searchParams.get("taskId") ?? setup.settings?.scanTaskId ?? "";
          const scan = await scanLocalEnvironment(project, await sourceRoot(taskId));
          const rows = await readJson(path.join(project.archive, "index.json"));
          const sources = [{ id: "", name: "项目源码" }];
          for (const row of rows.filter(row => canReadTask(session.principal, row))) {
            const { meta } = await readTask(project, row.id);
            if (meta.workspace) sources.push({ id: row.id, name: `需求 ${row.id} · ${row.title}` });
          }
          return send(res, 200, { setup, scan, scanTaskId: taskId || null, sources, diff: environmentScanDiff(setup.settings?.scan, scan) });
        }
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) return send(res, 403, { error: "Session token or origin is invalid" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const input = await readBody(req);
        if (pathname === "/api/local-environment-scan") return send(res, 405, { error: "扫描接口只接受 GET。" });
        return send(res, 200, pathname === "/api/local-environment-check"
          ? await checkLocalEnvironment(project, session.principal.id, await sourceRoot(setup.settings?.scanTaskId))
          : await configureLocalEnvironment(project, session.principal.id, input, await sourceRoot(input.scanTaskId)));
      }
      if (pathname === "/api/deployment-connection" && req.method === "POST") {
        authorize(session.principal, "configure-environment");
        if (!canConfigureEnvironment(session.principal, await readJson(path.join(project.archive, "index.json"))))
          return send(res, 403, { error: "当前账号未参与该项目的研发。" });
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) return send(res, 403, { error: "Session token or origin is invalid" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        return send(res, 200, await verifyDeploymentConnection(project.root, await readBody(req)));
      }
      if (["/api/model-settings", "/api/model-connection"].includes(pathname) && ["GET", "POST"].includes(req.method)) {
        authorize(session.principal, "configure-project");
        if (req.method === "GET" && pathname === "/api/model-settings") return send(res, 200, await readModelSettings(project.root));
        if (req.method === "GET") return send(res, 405, { error: "连接测试需要 POST 请求。" });
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) return send(res, 403, { error: "Session token or origin is invalid" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const input = await readBody(req);
        return send(res, 200, pathname === "/api/model-settings" ? await configureModels(project.root, session.principal.id, input)
          : await testModelConnection(project.root, input));
      }
      if (pathname === "/api/project-execution" && ["GET", "POST"].includes(req.method)) {
        authorize(session.principal, "configure-environment");
        if (!canConfigureEnvironment(session.principal, await readJson(path.join(project.archive, "index.json"))))
          return send(res, 403, { error: "当前账号未参与该项目的研发。" });
        if (req.method === "GET") return send(res, 200, await readExecutionSetup(project.root));
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) return send(res, 403, { error: "Session token or origin is invalid" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        return send(res, 200, await configureExecution(project.root, session.principal.id, await readBody(req)));
      }
      if (req.method === "GET" && pathname === "/api/project-reference") {
        const baseline = await readProjectBaseline(project);
        const mode = await readJson(path.join(project.archive, "documentation-mode.json"));
        if (mode.mode === "inventory") return send(res, 200, { content: renderProjectBaseline(baseline), mode: "inventory",
          snapshotHash: baseline.snapshotHash, sourceHash: baseline.sourceHash });
        if (mode.mode !== "agent") throw new Error("Invalid project documentation mode");
        const initialized = await readInitialization(project, baseline);
        return send(res, 200, { content: initialized.documents["PROJECT_REFERENCE.md"], agentContent: initialized.documents["agent.md"],
          mode: "agent", snapshotHash: baseline.snapshotHash, sourceHash: baseline.sourceHash });
      }
      if (pathname === "/api/project-reference/execution") {
        authorize(session.principal, "audit-report");
        const key = path.join(project.archive, "initialization");
        if (req.method === "GET") return send(res, 200, { execution: executionStatus(key) });
        if (req.method !== "POST") return send(res, 405, { error: "Use GET or POST" });
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf)
          return send(res, 403, { error: "Session token or origin is invalid" });
        return send(res, 200, pauseExecution(key, session.principal.id, true));
      }
      if (req.method === "POST" && pathname === "/api/project-reference/regenerate") {
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        authorize(session.principal, "audit-report");
        const entry = session.currentProjectId === "default" ? { projectDir: project.root, name: projectName }
          : await getProject(session.currentProjectId);
        let generated;
        try {
          generated = await controlledExecution(path.join(project.archive, "initialization"), "initialize", session.principal.id,
            async () => { const result = await generateProjectReference(entry, project, project.archive); assertExecutionActive(); return result; });
        } catch (error) {
          if (error.code !== "EXECUTION_PAUSED") throw error;
          return send(res, 200, { paused: true, message: error.message });
        }
        return send(res, 200, { content: generated.content,
          agentContent: (await readInitialization(project, await readProjectBaseline(project))).documents["agent.md"],
          snapshotHash: generated.snapshotHash });
      }
      if (req.method === "GET" && pathname === "/api/members") {
        authorize(session.principal, "assign-member");
        const credentials = await loadCredentials(project);
        return send(res, 200, { members: credentials.users.filter((user) =>
          user.roles.some((role) => !["admin", "product"].includes(role)))
          .map((user) => ({ id: user.id, username: user.username, roles: user.roles })) });
      }
      if (req.method === "GET" && pathname === "/api/admin/report") {
        const { offset, limit } = queryPage(requestUrl);
        const filters = Object.fromEntries([...requestUrl.searchParams].filter(([key]) => !["offset", "limit"].includes(key)));
        return send(res, 200, await getAuditReport(project.root, session.principal, offset, limit, filters));
      }
      if (req.method === "GET" && pathname === "/api/admin/auth-history") {
        const { offset, limit } = queryPage(requestUrl);
        return send(res, 200, await getAuthenticationHistory(project.root, session.principal, offset, limit));
      }
      if (req.method === "GET" && pathname === "/api/admin/users") {
        authorize(session.principal, "audit-report");
        return send(res, 200, { users: await listUsers(project) });
      }
      if (req.method === "POST" && pathname === "/api/admin/users") {
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        authorize(session.principal, "audit-report");
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const body = await readBody(req);
        const { addCredential } = await import("./auth.js");
        return send(res, 201, await actionAuditContext.run({ actor: session.principal.id, action: "auth-add" }, () =>
          addCredential(project, body.id, body.roles, { username: body.username, password: body.password, token: body.token })));
      }
      const userRolesMatch = pathname.match(/^\/api\/admin\/users\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/roles$/);
      if (req.method === "PUT" && userRolesMatch) {
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        authorize(session.principal, "audit-report");
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const body = await readBody(req);
        return send(res, 200, await actionAuditContext.run({ actor: session.principal.id, action: "auth-update-roles" }, () =>
          updateUserRoles(project, userRolesMatch[1], body.roles)));
      }
      const userPasswordMatch = pathname.match(/^\/api\/admin\/users\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/password$/);
      if (req.method === "POST" && userPasswordMatch) {
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        authorize(session.principal, "audit-report");
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const body = await readBody(req);
        return send(res, 200, await actionAuditContext.run({ actor: session.principal.id, action: "auth-reset-password" }, () =>
          resetPassword(project, userPasswordMatch[1], body.password)));
      }
      if (req.method === "POST" && pathname === "/api/change-password") {
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const body = await readBody(req);
        const result = await actionAuditContext.run({ actor: session.principal.id, action: "auth-change-password" }, () =>
          changePassword(project, session.principal, body.oldPassword, body.newPassword));
        sessions.delete(id);
        await persistSessions();
        return send(res, 200, result);
      }
      const historyMatch = pathname.match(/^\/api\/admin\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/history$/);
      if (req.method === "GET" && historyMatch) {
        const { offset, limit } = queryPage(requestUrl);
        return send(res, 200, await getTaskHistory(project.root, session.principal, historyMatch[1], offset, limit));
      }
      const lifecycleMatch = pathname.match(/^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/lifecycle$/);
      if (req.method === "GET" && lifecycleMatch) {
        const { offset, limit } = queryPage(requestUrl);
        return send(res, 200, await getRequirementLifecycle(project.root, session.principal, lifecycleMatch[1], offset, limit));
      }
      const diagnosticsMatch = pathname.match(/^\/api\/admin\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/observability$/);
      if (req.method === "GET" && diagnosticsMatch) {
        authorize(session.principal, "audit-report");
        const { offset, limit } = queryPage(requestUrl);
        return send(res, 200, await getTaskObservability(project.root, session.principal, diagnosticsMatch[1], offset, limit));
      }
      if (req.method === "POST" && pathname === "/api/tasks") {
        if (!sameOrigin(req, allowedOrigins) || req.headers["x-reqflow-token"] !== session.csrf) {
          return send(res, 403, { error: "Session token or origin is invalid" });
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const body = await readBody(req, 6 * 1024 * 1024);
        return send(res, 201, await createRequirement(project.root, session.principal, body));
      }
      const executionMatch = pathname.match(/^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/execution$/);
      if (req.method === "GET" && executionMatch) {
        const task = await readTask(project, executionMatch[1]);
        if (!canReadTask(session.principal, task.meta)) return send(res, 403, { error: "Role cannot read this requirement" });
        return send(res, 200, { execution: executionStatus(taskPath(project, executionMatch[1])), paused: Boolean(task.meta.executionPause) });
      }
      const match = pathname.match(/^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(\/actions)?$/);
      if (req.method === "GET" && match && !match[2]) return send(res, 200,
        await getRequirementEvidence(project.root, session.principal, match[1]));
      const fileMatch = pathname.match(/^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/files$/);
      const candidateMatch = pathname.match(/^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/git-candidate$/);
      if (req.method === "GET" && candidateMatch) {
        await getRequirementEvidence(project.root, session.principal, candidateMatch[1]);
        return send(res, 200, await candidateReview(project.root, candidateMatch[1]));
      }
      if (req.method === "GET" && fileMatch) return send(res, 200,
        await getChangedFile(project.root, session.principal, fileMatch[1], requestUrl.searchParams.get("path")));
      const imageMatch = pathname.match(/^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/images\/([a-f0-9-]{36})$/);
      if (req.method === "GET" && imageMatch) {
        const { descriptor, buffer } = await getRequirementImage(project.root, session.principal, imageMatch[1], imageMatch[2]);
        res.writeHead(200, { "Content-Type": descriptor.mimeType, "Content-Length": buffer.length,
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'",
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(descriptor.name)}` });
        return res.end(buffer);
      }
      if (req.method === "POST" && match?.[2]) {
        if (!sameOrigin(req, allowedOrigins)) return send(res, 403, { error: "Origin is not allowed" });
        if (req.headers["x-reqflow-token"] !== session.csrf) return send(res, 403, { error: "Session token is invalid" });
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON body is required" });
        const body = await readBody(req, 6 * 1024 * 1024);
        if (req.headers.accept !== "text/event-stream") {
          return send(res, 200, await executeRequirementAction(project.root, match[1], body, session.principal));
        }
        const actionStartedMs = Date.now();
        const frame = (event, data) => {
          if (res.destroyed || res.writableEnded) return;
          if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
          if (res.writableLength > 128 * 1024) { res.destroy(); return; }
          res.write(`event: ${event}\ndata: ${JSON.stringify(event === "progress" ? { ...data, elapsedMs: Date.now() - actionStartedMs } : data)}\n\n`);
        };
        const heartbeat = setInterval(() => {
          if (res.headersSent && !res.destroyed && !res.writableEnded) res.write(`: elapsed ${Date.now() - actionStartedMs}\n\n`);
        }, 10000);
        res.once("close", () => clearInterval(heartbeat));
        try {
          const result = await executeRequirementAction(project.root, match[1], body, session.principal,
            update => frame("progress", update));
          frame("result", result);
        } catch (error) {
          if (!res.headersSent) throw error;
          process.stderr.write(`pi-reqflow action: ${error.stack ?? error}\n`);
          frame("error", { error: error.message });
        } finally { clearInterval(heartbeat); }
        // Losing the browser connection must not abandon an audited execution.
        return res.end();
      }
      return send(res, 404, { error: "Route not found" });
    } catch (error) {
      process.stderr.write(`pi-reqflow web: ${error.code === "EACCES" ? error.message : error.stack ?? error}\n`);
      return send(res, error.code === "ENOENT" ? 404 : error.code === "EACCES" ? 403 : 400,
        { error: error.message });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  server.once("close", () => { stopAllLocalRuntimes().catch(error => process.stderr.write(`Local runtime shutdown failed: ${error.stack}\n`)); });
  return { server, url: options.origins?.[0] ?? `http://127.0.0.1:${server.address().port}` };
}

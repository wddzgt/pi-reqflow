import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJson, listFiles, copyFiles, safeId } from "./files.js";
import { readProjectBaseline } from "./baseline.js";
import { initializeProjectContext } from "./project-initialization.js";
import { initialize, withLock, readTask } from "./store.js";
import { loadProject, validateConfig } from "./config.js";
import { addCredential, loadCredentials } from "./auth.js";
import { inspectGit, runGit } from "./git-project.js";

const stateDirectory = () => process.env.REQFLOW_STATE_DIR ?? path.join(os.homedir(), ".reqflow");
const registryFile = () => path.join(stateDirectory(), "projects.json");

export async function loadRegistry() {
  try {
    const registry = await readJson(registryFile());
    if (!Array.isArray(registry.projects) || new Set(registry.projects.map((entry) => entry.id)).size !== registry.projects.length) {
      throw new Error("Invalid project registry");
    }
    return registry;
  } catch (error) {
    if (error.code === "ENOENT") return { projects: [] };
    throw error;
  }
}

export async function saveRegistry(registry) {
  await writeJson(registryFile(), registry);
}

export async function listProjects() {
  const registry = await loadRegistry();
  return registry.projects.filter((entry) => !entry.archivedAt);
}

export async function getProject(projectId) {
  const registry = await loadRegistry();
  const project = registry.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (project.archivedAt) throw new Error(`Project ${projectId} is archived; files and audit records are retained at ${project.projectDir}`);
  return project;
}

export async function analyzeProjectStructure(sourceDir) {
  const structure = {
    hasFrontend: false,
    hasBackend: false,
    frontendDir: null,
    backendDir: null,
    detectedFrameworks: { frontend: null, backend: null },
  };

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const frontendCandidates = ["frontend", "web", "client", "ui", "app"];
  for (const candidate of frontendCandidates) {
    if (dirs.includes(candidate)) {
      const candidatePath = path.join(sourceDir, candidate);
      const candidateFiles = await fs.readdir(candidatePath);
      if (candidateFiles.includes("package.json")) {
        structure.hasFrontend = true;
        structure.frontendDir = candidate;
        const sub = await analyzeDirectory(candidatePath);
        structure.detectedFrameworks.frontend = sub.framework || null;
        break;
      }
    }
  }

  const backendCandidates = ["backend", "server", "api", "src"];
  for (const candidate of backendCandidates) {
    if (dirs.includes(candidate)) {
      const candidatePath = path.join(sourceDir, candidate);
      const candidateFiles = await fs.readdir(candidatePath);
      if (["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml"].some(file => candidateFiles.includes(file))
          || candidateFiles.some(f => /\.(js|ts|py|java|go|rs)$/.test(f))) {
        structure.hasBackend = true;
        structure.backendDir = candidate;
        const sub = await analyzeDirectory(candidatePath);
        structure.detectedFrameworks.backend = sub.framework || null;
        break;
      }
    }
  }

  if (!structure.hasFrontend && !structure.hasBackend) {
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (files.includes("package.json")) {
      const pkg = await readJson(path.join(sourceDir, "package.json"));
      if (pkg.dependencies?.react || pkg.devDependencies?.react ||
          pkg.dependencies?.vue || pkg.devDependencies?.vue) {
        structure.hasFrontend = true;
        structure.frontendDir = ".";
      } else {
        structure.hasBackend = true;
        structure.backendDir = ".";
      }
    }
  }

  return { ...structure, git: await inspectGit(sourceDir) };
}

async function analyzeDirectory(dirPath) {
  const result = {
    language: null,
    framework: null,
    runtime: null,
    scripts: {},
    dependencies: [],
    devDependencies: [],
    configFiles: [],
    directoryTree: [],
    hasTests: false,
    testFramework: null,
    readme: null,
  };

  let files;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  result.directoryTree = dirs.filter((d) => !d.startsWith(".") && d !== "node_modules").sort();

  // package.json analysis
  if (files.includes("package.json")) {
      const pkg = await readJson(path.join(dirPath, "package.json"));
      result.runtime = "Node.js";
      result.scripts = pkg.scripts || {};
      result.dependencies = Object.keys(pkg.dependencies || {});
      result.devDependencies = Object.keys(pkg.devDependencies || {});

      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.react) result.framework = `React${allDeps.react ? ` ${allDeps.react}` : ""}`;
      else if (allDeps.vue) result.framework = `Vue${allDeps.vue ? ` ${allDeps.vue}` : ""}`;
      else if (allDeps.next) result.framework = `Next.js${allDeps.next ? ` ${allDeps.next}` : ""}`;
      else if (allDeps.nuxt) result.framework = `Nuxt${allDeps.nuxt ? ` ${allDeps.nuxt}` : ""}`;
      else if (allDeps.svelte || allDeps["@sveltejs/kit"]) result.framework = "Svelte";
      else if (allDeps.express) result.framework = `Express${allDeps.express ? ` ${allDeps.express}` : ""}`;
      else if (allDeps.fastify) result.framework = `Fastify${allDeps.fastify ? ` ${allDeps.fastify}` : ""}`;
      else if (allDeps.koa) result.framework = `Koa${allDeps.koa ? ` ${allDeps.koa}` : ""}`;
      else if (allDeps["@nestjs/core"]) result.framework = "NestJS";
      else if (allDeps.hono) result.framework = `Hono${allDeps.hono ? ` ${allDeps.hono}` : ""}`;

      if (allDeps.jest || allDeps["@jest/core"]) result.testFramework = "Jest";
      else if (allDeps.vitest) result.testFramework = "Vitest";
      else if (allDeps.mocha) result.testFramework = "Mocha";
      else if (allDeps.ava) result.testFramework = "AVA";
      else if (allDeps.tap) result.testFramework = "tap";

      if (allDeps.typescript || files.includes("tsconfig.json")) result.language = "TypeScript";
      else result.language = "JavaScript";
  }

  // Python detection
  if (files.includes("requirements.txt") || files.includes("pyproject.toml") || files.includes("setup.py")) {
    result.runtime = "Python";
    result.language = "Python";
    if (files.includes("pyproject.toml")) {
        const content = await fs.readFile(path.join(dirPath, "pyproject.toml"), "utf-8");
        if (content.includes("django")) result.framework = "Django";
        else if (content.includes("flask")) result.framework = "Flask";
        else if (content.includes("fastapi")) result.framework = "FastAPI";
    }
    if (files.includes("pytest.ini") || files.includes("conftest.py")) result.testFramework = "pytest";
  }

  // Go detection
  if (files.includes("go.mod")) {
    result.runtime = "Go";
    result.language = "Go";
      const content = await fs.readFile(path.join(dirPath, "go.mod"), "utf-8");
      const goVersion = content.match(/^go\s+(\d+\.\d+)/m);
      if (goVersion) result.language = `Go ${goVersion[1]}`;
  }

  // Rust detection
  if (files.includes("Cargo.toml")) {
    result.runtime = "Rust";
    result.language = "Rust";
  }

  // Java detection
  if (files.includes("pom.xml")) { result.runtime = "Java"; result.language = "Java (Maven)"; }
  else if (files.includes("build.gradle") || files.includes("build.gradle.kts")) { result.runtime = "Java"; result.language = "Java (Gradle)"; }

  // Fallback language detection from file extensions
  if (!result.language) {
    const exts = files.map((f) => path.extname(f)).filter(Boolean);
    if (exts.some((e) => e === ".ts" || e === ".tsx")) result.language = "TypeScript";
    else if (exts.some((e) => e === ".js" || e === ".jsx")) result.language = "JavaScript";
    else if (exts.some((e) => e === ".py")) result.language = "Python";
    else if (exts.some((e) => e === ".go")) result.language = "Go";
    else if (exts.some((e) => e === ".rs")) result.language = "Rust";
    else if (exts.some((e) => e === ".java")) result.language = "Java";
  }

  // Config files detection
  const configCandidates = [
    "tsconfig.json", "tsconfig.build.json",
    ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", "eslint.config.js", "eslint.config.mjs",
    ".prettierrc", ".prettierrc.js", ".prettierrc.json", "prettier.config.js",
    ".editorconfig",
    "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
    "Dockerfile",
    ".env.example", ".env.sample",
    "tailwind.config.js", "tailwind.config.ts",
    "vite.config.js", "vite.config.ts",
    "webpack.config.js", "webpack.config.ts",
    "next.config.js", "next.config.mjs", "next.config.ts",
    "nuxt.config.js", "nuxt.config.ts",
    "jest.config.js", "jest.config.ts", "vitest.config.js", "vitest.config.ts",
    ".gitignore",
  ];
  result.configFiles = configCandidates.filter((f) => files.includes(f));

  // Test directory detection
  const testDirs = ["test", "tests", "__tests__", "spec", "specs"];
  result.hasTests = result.directoryTree.some((d) => testDirs.includes(d)) ||
    files.some((f) => f.includes(".test.") || f.includes(".spec."));

  // README
  const readmeFile = files.find((f) => f.toLowerCase().startsWith("readme"));
  if (readmeFile) {
      const content = await fs.readFile(path.join(dirPath, readmeFile), "utf-8");
      result.readme = content.slice(0, 2000);
  }

  return result;
}

export async function importProject(name, importPaths, options = {}) {
  if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error("Project name is required (maximum 100 characters)");
  let config = validateConfig(options.config);
  if (!config.piExecutable || path.resolve(config.piExecutable) === process.execPath) throw new Error("Explicit Pi executable is required; Node is not a Pi executor");
  const admin = options.admin;
  if (options.accountSource !== undefined) {
    if (admin !== undefined) throw new Error("Shared accounts cannot be combined with a new project administrator");
    if (typeof options.accountSource !== "string" || !path.isAbsolute(options.accountSource)) throw new Error("Account source must be absolute");
    await loadCredentials({ archive: options.accountSource });
  } else if (!admin || typeof admin.username !== "string" || !admin.username.trim() || typeof admin.password !== "string" || Buffer.byteLength(admin.password) < 6) {
    throw new Error("Explicit administrator username and password (at least 6 bytes) are required");
  }
  if (admin) safeId(admin.id);
  const rootDir = importPaths.rootDir || null;
  const frontendDir = importPaths.frontendDir || null;
  const backendDir = importPaths.backendDir || null;
  if (rootDir && (frontendDir || backendDir)) throw new Error("项目根目录与独立前后端目录请选择一种导入方式。");

  const realRootDir = rootDir ? await fs.realpath(rootDir) : null;
  const realFrontendDir = frontendDir ? await fs.realpath(frontendDir) : null;
  const realBackendDir = backendDir ? await fs.realpath(backendDir) : null;

  if (realRootDir && !(await fs.stat(realRootDir)).isDirectory()) throw new Error("Project root path must be a directory");
  if (realFrontendDir) {
    const stat = await fs.stat(realFrontendDir);
    if (!stat.isDirectory()) throw new Error("Frontend path must be a directory");
  }
  if (realBackendDir) {
    const stat = await fs.stat(realBackendDir);
    if (!stat.isDirectory()) throw new Error("Backend path must be a directory");
  }

  if (!realRootDir && !realFrontendDir && !realBackendDir) {
    throw new Error("At least one directory is required");
  }

  const sources = [realRootDir, realFrontendDir, realBackendDir].filter(Boolean);
  const rootStructure = realRootDir ? await analyzeProjectStructure(realRootDir) : null;
  const gitSources = await Promise.all(sources.map(inspectGit));
  const repositories = gitSources.filter(Boolean);
  if (repositories.length && (repositories.length !== sources.length || new Set(repositories.map(repo => repo.root)).size !== 1)) {
    throw new Error("前后端属于不同仓库，请分别导入，避免把多个仓库拼成一个无法提交的项目。");
  }
  const repository = repositories[0];
  if (repository) {
    if (!repository.clean || !repository.branch) throw new Error("请先处理原仓库未提交的修改，并切换到用于初始化的分支。");
    const remote = config.mode === "git" ? repository.remotes.find(remote => remote.name === config.remote)
      : repository.remotes.find(remote => remote.name === "origin") ?? (repository.remotes.length === 1 ? repository.remotes[0] : null);
    if (!remote) throw new Error("Git 导入需要明确的远程仓库，请配置 origin 或在高级配置中指定 remote。");
    repository.selectedRemote = remote;
    if (config.mode === "git" && config.baseBranch !== repository.branch) throw new Error("原仓库当前分支与配置的基础分支不同，请切换后再导入。");
    config = validateConfig({ ...config, mode: "git", baseBranch: repository.branch,
      releaseBranch: config.mode === "git" ? config.releaseBranch : repository.branch,
      branchPrefix: config.mode === "git" ? config.branchPrefix : "pi-reqflow", remote: remote.name });
  } else if (config.mode === "git") throw new Error("选择的目录不是 Git 仓库。");

  if (options.detectExecution === true) {
    const exclusions = new Set(config.excludedPaths);
    const inventoryRoots = repository ? [{ directory: repository.root, prefix: "" }]
      : realRootDir ? [{ directory: realRootDir, prefix: "" }]
        : sources.map(directory => ({ directory, prefix: directory === realFrontendDir ? "frontend" : "backend" }));
    const moduleRoots = new Set(["", ...inventoryRoots.map(row => row.prefix)]);
    if (realRootDir) for (const folder of [rootStructure.frontendDir, rootStructure.backendDir].filter(Boolean)) {
      moduleRoots.add(path.relative(repository?.root ?? realRootDir, path.join(realRootDir, folder)));
    } else for (const directory of sources) moduleRoots.add(repository ? path.relative(repository.root, directory) : directory === realFrontendDir ? "frontend" : "backend");
    const pending = inventoryRoots.map(row => ({ ...row, relative: row.prefix }));
    while (pending.length) {
      const row = pending.pop();
      for (const entry of await fs.readdir(row.directory, { withFileTypes: true })) {
        const relative = path.posix.join(row.relative, entry.name);
        if ([".git", ".reqflow", ".reqflow-init", ".reqflow-workspaces", "node_modules"].includes(entry.name)
            || entry.name === ".env" || entry.name.startsWith(".env.")
            || [...exclusions].some(prefix => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
        const generatedDirectory = entry.isDirectory() && (["dist", "target", "coverage", "test-results", ".pytest_cache", "__pycache__", ".next", ".nuxt"].includes(entry.name)
          || entry.name === "logs" && moduleRoots.has(row.relative));
        const runtimeLog = entry.isFile() && entry.name.endsWith(".log") && moduleRoots.has(row.relative);
        if (generatedDirectory || runtimeLog) { exclusions.add(relative); continue; }
        if (entry.isDirectory()) pending.push({ directory: path.join(row.directory, entry.name), relative });
      }
    }
    config = validateConfig({ ...config, excludedPaths: [...exclusions] });
    const roots = realRootDir ? [...new Set([realRootDir, ...[rootStructure.frontendDir, rootStructure.backendDir]
      .filter(Boolean).map(folder => path.join(realRootDir, folder))])] : sources;
    const checks = []; const deployments = [];
    let rootHasTests = false;
    for (const directory of roots) {
      const pkg = await readJson(path.join(directory, "package.json")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      const folder = repository ? path.relative(repository.root, directory) : realRootDir ? path.relative(realRootDir, directory)
        : directory === realFrontendDir ? "frontend" : "backend";
      const npm = folder ? ["npm", "--prefix", folder] : ["npm"];
      if (typeof pkg?.scripts?.test === "string" && pkg.scripts.test.trim()
          && !/no test specified[\s\S]*exit\s+1/i.test(pkg.scripts.test)) {
        if (!rootHasTests) checks.push([...npm, "test"]);
        if (directory === realRootDir) rootHasTests = true;
      }
      if (typeof pkg?.scripts?.["deploy:test"] === "string" && pkg.scripts["deploy:test"].trim()) deployments.push([...npm, "run", "deploy:test"]);
    }
    const allowedPaths = repository ? sources.map(dir => path.relative(repository.root, dir) || ".")
      : realRootDir ? ["."] : sources.map(dir => dir === realFrontendDir ? "frontend" : "backend");
    const requiredChecks = realRootDir ? new Set([rootStructure.frontendDir, rootStructure.backendDir].filter(Boolean)).size || 1 : sources.length;
    config = validateConfig({ ...config, allowedPaths, checks,
      testDeployment: deployments.length === 1 && checks.length > 0 && (rootHasTests || checks.length === requiredChecks)
        ? { kind: "local", command: deployments[0] } : { kind: "unconfigured" } });
  }

  await fs.mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  return withLock(path.join(stateDirectory(), "registry.lock"), async () => {
  const registry = await loadRegistry();
  if (options.firstRun === true && registry.projects.length) throw new Error("已有项目，请登录当前账号。");
  const checkDirs = sources;
  for (const dir of checkDirs) {
    if (registry.projects.some((p) => p.rootDir === dir || p.frontendDir === dir || p.backendDir === dir)) {
      throw new Error("Project from this directory is already imported");
    }
  }

  // Create project directory in reqflow workspace
  const workspaceDir = path.join(stateDirectory(), "projects");
  await fs.mkdir(workspaceDir, { recursive: true });

  const projectId = randomUUID();
  const projectDir = path.join(workspaceDir, projectId);
  await fs.mkdir(projectDir);

  const excludes = [".git", ".reqflow", ".reqflow-init", "node_modules", ...config.excludedPaths];
  const structure = rootStructure ? structuredClone(rootStructure)
    : { hasFrontend: false, hasBackend: false, frontendDir: null, backendDir: null, detectedFrameworks: { frontend: null, backend: null } };
  delete structure.git;

  if (repository) {
    await runGit(workspaceDir, ["clone", "--no-hardlinks", "--branch", repository.branch, "--", repository.root, projectDir]);
    for (const branch of repository.branches.filter(branch => branch !== repository.branch)) {
      const revision = await runGit(repository.root, ["rev-parse", `refs/heads/${branch}`]);
      await runGit(projectDir, ["branch", branch, revision]);
    }
    await runGit(projectDir, ["remote", "rename", "origin", "pi-reqflow-import"]);
    await runGit(projectDir, ["remote", "add", repository.selectedRemote.name, repository.selectedRemote.url]);
    await runGit(projectDir, ["remote", "remove", "pi-reqflow-import"]);
    for (const tracking of repository.remoteBranches.filter(row => row.remote === repository.selectedRemote.name)) {
      await runGit(projectDir, ["update-ref", `refs/remotes/${tracking.remote}/${tracking.branch}`, tracking.revision]);
    }
  }

  if (realRootDir) {
    if (!repository) await copyFiles(realRootDir, projectDir, await listFiles(realRootDir, excludes, config.maxSnapshotBytes));
    else {
      const prefix = path.relative(repository.root, realRootDir);
      for (const key of ["frontendDir", "backendDir"]) if (structure[key]) structure[key] = path.join(prefix, structure[key]) || ".";
    }
  }

  if (realFrontendDir) {
    const frontendExcludes = excludes.map((item) => item.startsWith("frontend/") ? item.slice("frontend/".length) : item);
    if (!repository) await copyFiles(realFrontendDir, path.join(projectDir, "frontend"), await listFiles(realFrontendDir, frontendExcludes, config.maxSnapshotBytes));
    structure.hasFrontend = true;
    structure.frontendDir = repository ? path.relative(repository.root, realFrontendDir) || "." : "frontend";
    const analysis = await analyzeDirectory(realFrontendDir);
    structure.detectedFrameworks.frontend = analysis.framework || null;
  }
  if (realBackendDir) {
    const backendExcludes = excludes.map((item) => item.startsWith("backend/") ? item.slice("backend/".length) : item);
    if (!repository) await copyFiles(realBackendDir, path.join(projectDir, "backend"), await listFiles(realBackendDir, backendExcludes, config.maxSnapshotBytes));
    structure.hasBackend = true;
    structure.backendDir = repository ? path.relative(repository.root, realBackendDir) || "." : "backend";
    const analysis = await analyzeDirectory(realBackendDir);
    structure.detectedFrameworks.backend = analysis.framework || null;
  }

  const configPath = path.join(stateDirectory(), `import-config-${projectId}.json`);
  await writeJson(configPath, config);
  try { await initialize(projectDir, configPath, { inventoryOnly: options.inventoryOnly, accountSource: options.accountSource }); }
  finally { await fs.unlink(configPath); }

  if (options.accountSource === undefined) {
    const loadedProject = await loadProject(projectDir);
    await addCredential(loadedProject, admin.id, ["admin"], admin);
  }

  // Register project
  const project = {
    id: projectId,
    name,
    rootDir: realRootDir,
    frontendDir: realRootDir && rootStructure.frontendDir ? path.resolve(realRootDir, rootStructure.frontendDir) : realFrontendDir,
    backendDir: realRootDir && rootStructure.backendDir ? path.resolve(realRootDir, rootStructure.backendDir) : realBackendDir,
    projectDir,
    createdAt: new Date().toISOString(),
    structure,
    config,
    git: repository ? { ...repository, root: projectDir } : null,
  };

  registry.projects.push(project);
  await saveRegistry(registry);

  return project;
  }, 10000);
}

export async function removeProject(projectId, actor) {
  safeId(actor);
  await fs.mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  return withLock(path.join(stateDirectory(), "registry.lock"), async () => {
  const registry = await loadRegistry();
  const index = registry.projects.findIndex((p) => p.id === projectId);
  if (index === -1) throw new Error(`Project ${projectId} not found`);

  const project = registry.projects[index];

  if (project.archivedAt) throw new Error("Project is already archived");
  const loaded = await loadProject(project.projectDir);
  return withLock(path.join(loaded.archive, "index.lock"), async () => {
  const tasks = await fs.readdir(path.join(loaded.archive, "tasks"));
  for (const task of tasks) {
    const { meta } = await readTask(loaded, task);
    if (!["archived", "archived_test_only", "rolled_back"].includes(meta.state)) throw new Error(`Cannot archive a project with an active requirement: ${task}`);
  }
  project.archivedAt = new Date().toISOString();
  project.archivedBy = actor;
  await saveRegistry(registry);
  return { id: projectId, archivedAt: project.archivedAt, archivedBy: actor, projectDir: project.projectDir };
  }, 10000);
  }, 10000);
}

export async function generateProjectReference(registryEntry, loadedProject, outputDirectory = loadedProject.archive) {
  if (path.resolve(outputDirectory) !== loadedProject.archive) throw new Error("Project documentation must be stored in the audit directory");
  const baseline = await readProjectBaseline(loadedProject);
  const initialized = await initializeProjectContext(loadedProject, baseline);
  return { content: initialized.documents["PROJECT_REFERENCE.md"], snapshotHash: baseline.snapshotHash,
    sourceHash: baseline.sourceHash, agentFile: path.join(outputDirectory, "AGENTS.md"),
    claudeFile: path.join(outputDirectory, "CLAUDE.md"), initialization: initialized.metadata };
}

export async function regenerateProjectReference(projectId) {
  const registry = await loadRegistry();
  const entry = registry.projects.find((p) => p.id === projectId);
  if (!entry) throw new Error(`Project ${projectId} not found`);
  const loadedProject = await loadProject(entry.projectDir);
  await generateProjectReference(entry, loadedProject, loadedProject.archive);
}

export async function getProjectWithState(projectId) {
  const project = await getProject(projectId);
  const loaded = await loadProject(project.projectDir);
  return { ...project, loaded };
}

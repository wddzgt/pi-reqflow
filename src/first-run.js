import { promises as fs, constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { validateConfig } from "./config.js";
import { importProject, loadRegistry } from "./project-registry.js";
import { actionAuditContext, withLock } from "./store.js";

export async function firstRunConfig(provider, model) {
  for (const [name, value] of [["provider", provider], ["model", model]]) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`请填写模型的 ${name}。`);
  }
  let piExecutable = process.env.REQFLOW_PI_EXECUTABLE;
  if (piExecutable !== undefined) {
    if (!path.isAbsolute(piExecutable)) throw new Error("REQFLOW_PI_EXECUTABLE must be an absolute path");
    await fs.access(piExecutable, constants.X_OK);
  } else {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.resolve(directory, "pi");
      const executable = await fs.access(candidate, constants.X_OK).then(() => true, error => {
        if (["ENOENT", "EACCES"].includes(error.code)) return false;
        throw error;
      });
      if (executable) { piExecutable = candidate; break; }
    }
  }
  if (!piExecutable) throw new Error("尚未安装 Pi。请安装 @earendil-works/pi-coding-agent@0.87.1 后重新启动。");
  return validateConfig({ schemaVersion: 2, mode: "local", piExecutable,
    provider: provider.trim(), model: model.trim(), environment: { pi: [], checks: [], localDeployment: [] },
    allowedPaths: ["."], excludedPaths: [".env", ".npmrc", ".pi", ".codex", ".agents", ".claude", ".idea", ".vscode", "secrets", "credentials"],
    maxSnapshotBytes: 100 * 1024 * 1024, maxPiMs: 300000, maxToolCalls: 60, maxEventBytes: 2000000, maxCostUsd: 2,
    codingStandards: { globalRules: [] }, fastPath: { enabled: false }, checks: [],
    testDeployment: { kind: "unconfigured" }, productionDeployment: { kind: "none" } });
}

export async function bootstrapDefaultProject() {
  const stateDir = process.env.REQFLOW_STATE_DIR ?? path.join(os.homedir(), ".reqflow");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  return withLock(path.join(stateDir, "bootstrap.lock"), async () => {
    if ((await loadRegistry()).projects.length) return null;
    const config = await firstRunConfig("unconfigured", "unconfigured");
    const example = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "demo-app");
    const source = await fs.mkdtemp(path.join(stateDir, "demo-source-"));
    for (const name of ["src", "test", "package.json"]) {
      await fs.cp(path.join(example, name), path.join(source, name), { recursive: true });
    }
    return actionAuditContext.run({ actor: "system:bootstrap", action: "bootstrap-default-project" }, () =>
      importProject("内置演示项目", { rootDir: source }, { config, inventoryOnly: true, detectExecution: true,
        firstRun: true, admin: { id: "admin", username: "admin", password: "admin123" } }));
  }, 10000);
}

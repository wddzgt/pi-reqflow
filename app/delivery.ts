import { promises as fs } from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { manifest, manifestHash, compareManifests, sha256 } from "../src/files.js";
import { directory } from "./tasks.js";
import { execution } from "./process.js";
import { resolveUnitChecks, projectPolicy, sourceFile } from './project-sources.js';
import type { Task, Project, Settings, Check } from "./types.js";

export async function changes(project: Project, task: Task, settings: Settings, prior?: { manifest: any; root: string }) {
  const home = directory(project, task.id);
  const before = prior?.manifest ?? JSON.parse(await fs.readFile(path.join(home, "baseline.json"), "utf8"));
  const after = await manifest(task.workspace, settings.excludedPaths, settings.maxSnapshotBytes);
  for (const file of Object.keys(after)) sourceFile(project, file);
  const differences = compareManifests(before, after);
  let diff = "";
  for (const item of differences) {
    const old = item.before ? await fs.readFile(path.join(prior ? prior.root : path.join(home, "baseline"), item.file), "utf8") : "";
    const next = item.after ? await fs.readFile(path.join(task.workspace, item.file), "utf8") : "";
    diff += createTwoFilesPatch(item.file, item.file, old, next);
  }
  return { files: differences.map((d: any) => d.file), diff, sourceHash: manifestHash(after), manifest: after };
}
export async function prepareChecks(project: Project, task: Task, settings: Settings) {
  for (const dependency of settings.runtimeDependencies) {
    if (!(await fs.lstat(path.join(task.workspace, dependency))).isSymbolicLink())
      throw new Error('运行依赖必须保持原始只读链接：' + dependency);
  }
  const baseline = path.join(directory(project, task.id), 'baseline');
  const checks = await resolveUnitChecks(project, settings, baseline);
  return Promise.all(checks.map(async check => {
    if (!settings.unitChecks.length) {
      const [before, current] = await Promise.all([baseline, task.workspace].map(async root => {
        const file = path.join(root, check.cwd, 'package.json');
        if (!(await fs.lstat(file)).isFile()) throw new Error('测试入口必须是普通文件：' + check.cwd + '/package.json');
        try { return JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error) { throw new Error(`检查 ${check.id} 的 package.json 不可读取或 JSON 无效`, { cause: error }); }
      }));
      const script = check.command[2];
      if (!current || typeof current !== 'object' || [script, 'pre' + script, 'post' + script].some(name => before.scripts[name] !== current.scripts?.[name])
        || before.packageManager !== current.packageManager)
        throw new Error('已选定的测试入口被修改：' + check.cwd + '/package.json#' + script);
      for (const cwd of new Set(['.', check.cwd])) {
        for (const name of ['.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml', '.pnpmfile.cjs', 'bunfig.toml', '.env.yarn']) {
          const states = await Promise.all([baseline, task.workspace].map(async root => {
            const file = path.join(root, cwd, name);
            let stat;
            try { stat = await fs.lstat(file); }
            catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
            if (!stat.isFile()) throw new Error('包管理器执行配置必须是普通文件：' + cwd + '/' + name);
            return sha256(await fs.readFile(file));
          }));
          if (states[0] !== states[1]) throw new Error('包管理器执行配置被修改：' + cwd + '/' + name);
        }
      }
    }
    return { check, ...await execution(check.command, task.workspace,
      path.join(directory(project, task.id), 'unit'), project, settings.runtimeDependencies, path.join(task.workspace, check.cwd)) };
  }));
}
function unitReply(child: ChildProcess, command?: Awaited<ReturnType<typeof execution>>) {
  return new Promise<{ ready?: boolean; code?: number }>((resolve, reject) => {
    const cleanup = () => { child.off('exit', stopped); child.off('error', failed); child.off('message', received); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const stopped = (code: number | null, signal: string | null) => failed(new Error(`单测监督进程中断（${code ?? signal}）`));
    const received = (reply: any) => {
      cleanup();
      if (reply.error) reject(Object.assign(new Error(reply.error), { code: reply.code }));
      else resolve(reply);
    };
    if (!child.connected) { reject(new Error('单测监督进程已中断')); return; }
    child.once('exit', stopped); child.once('error', failed); child.once('message', received);
    if (command) child.send({ command: command.command, args: command.args,
      options: { cwd: command.options.cwd, env: { ...command.options.env, CI: 'true' } } }, error => { if (error) failed(error); });
  });
}
async function withUnitSupervisor(home: string, log: number, signal: AbortSignal, action: (child: ChildProcess) => Promise<void>) {
  signal.throwIfAborted();
  const child = fork(new URL('./unit-supervisor.js', import.meta.url), [path.join(home, 'unit-execution.lock')], {
    execArgv: [], env: {}, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc', log] });
  let diagnostics = '';
  child.stderr!.on('data', data => { diagnostics = (diagnostics + data).slice(-2000); });
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.once('error', () => { if (child.pid === undefined) resolve(); });
  });
  const stop = () => { if (child.connected) child.disconnect(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (!(await unitReply(child)).ready) throw new Error('单测监督进程没有确认执行所有权');
    await action(child);
  } catch (error: any) {
    if (!child.connected && !signal.aborted && diagnostics.trim())
      throw new Error(error.message + '：' + diagnostics.trim(), { cause: error });
    throw error;
  } finally {
    signal.removeEventListener('abort', stop); stop(); await exited;
  }
}
export async function unit(project: Project, task: Task, settings: Settings, signal: AbortSignal): Promise<Check> {
  const commands = await prepareChecks(project, task, settings);
  const home = directory(project, task.id);
  const candidate = await manifest(task.workspace, settings.excludedPaths, settings.maxSnapshotBytes);
  for (const file of Object.keys(candidate)) sourceFile(project, file);
  const sourceHash = manifestHash(candidate);
  const policyHash = projectPolicy(project, settings);
  if (task.check?.code === 0 && task.check.sourceHash === sourceHash && task.check.policyHash === policyHash) {
    const bytes = await fs.readFile(task.check.log);
    if (sha256(bytes) !== task.check.logHash) throw new Error("已有单测证据已改变");
    return task.check;
  }
  const file = path.join(home, "unit", `unit-${randomUUID()}.log`);
  const log = await fs.open(file, "wx", 0o600);
  try {
    const results: Check['checks'] = [];
    await withUnitSupervisor(home, log.fd, signal, async supervisor => {
      for (const { check } of commands) {
        const command = (await prepareChecks(project, task, settings)).find(item => item.check.id === check.id)!;
        await log.write(`\n[必要检查] ${check.name} (${check.id}) · 工作目录 ${check.cwd} · 覆盖 ${check.sources.join(', ')}\n${JSON.stringify(check.command)}\n`);
        signal.throwIfAborted();
        const { code } = await unitReply(supervisor, command);
        if (typeof code !== 'number' || !Number.isInteger(code)) throw new Error('单测监督进程未返回退出码');
        results.push({ ...check, code });
        await log.write(`[检查结果] ${check.id} · 退出码 ${code}\n`);
        if (results.length < commands.length && sourceHash !== manifestHash(await manifest(task.workspace, settings.excludedPaths, settings.maxSnapshotBytes)))
          throw new Error("单元测试修改了交付源码");
      }
    });
    signal.throwIfAborted();
    if (sourceHash !== manifestHash(await manifest(task.workspace, settings.excludedPaths, settings.maxSnapshotBytes))) throw new Error("单元测试修改了交付源码");
    return { sourceHash, policyHash, checks: results, code: results.find(check => check.code !== 0)?.code ?? 0,
      log: file, logHash: sha256(await fs.readFile(file)) };
  } finally { await log.close(); }
}

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SpawnOptions } from "node:child_process";
import type { Project } from "./types.js";
import { sourceDependency } from './project-sources.js';

export async function execution(command: string[], workspace: string, home: string, project: Project, dependencies: string[], cwd = workspace): Promise<{
  command: string; args: string[]; options: SpawnOptions; readonlyDependencies: Array<{ path: string; target: string; linked: boolean }>
}> {
  const actualCwd = await fs.realpath(cwd), actualWorkspace = await fs.realpath(workspace);
  if (actualCwd !== actualWorkspace && !actualCwd.startsWith(actualWorkspace + path.sep)) throw new Error('检查工作目录越出隔离现场');
  if (!(await fs.stat(actualCwd)).isDirectory()) throw new Error('检查工作位置必须是目录');
  await fs.mkdir(path.join(home, "tmp"), { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { PATH: [path.join(os.homedir(), ".pi/agent/bin"), process.env.PATH].join(path.delimiter),
    HOME: home, TMPDIR: path.join(home, "tmp"), LANG: "en_US.UTF-8", PI_OFFLINE: "1", PI_CODING_AGENT_DIR: path.join(home, "agent") };
  if (process.platform !== "darwin") throw new Error("当前执行隔离仅支持macOS；此平台尚未配置安全执行器");
  await fs.access("/usr/bin/sandbox-exec");
  const quote = (s: string) => JSON.stringify(s);
  const shared = await Promise.all(dependencies.map(entry => sourceDependency(project, entry)));
  const expected = new Map(dependencies.map((entry, index) => [path.join(actualWorkspace, entry), shared[index]]));
  const linked = new Set<string>();
  const pending = [actualWorkspace];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      const file = path.join(parent, entry.name);
      if (entry.name === 'node_modules') {
        if (!expected.has(file)) throw new Error('隔离现场出现未声明的运行依赖：' + path.relative(actualWorkspace, file));
        if (!entry.isSymbolicLink() || await fs.realpath(file) !== expected.get(file))
          throw new Error('运行依赖必须保持原始只读链接：' + path.relative(actualWorkspace, file));
        linked.add(file);
      } else if (entry.isSymbolicLink()) throw new Error('隔离现场存在非受控链接：' + path.relative(actualWorkspace, file));
      else if (entry.isDirectory()) pending.push(file);
    }
  }
  const ancestors = new Set<string>();
  for (const target of [workspace, home, ...shared])
    for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
  const profile = `(version 1) (allow default) (deny file-write*)
    (allow file-write* (subpath ${quote(workspace)}) (subpath ${quote(home)}) (literal "/dev/null"))
    (deny file-read* (subpath ${quote(path.join(os.homedir(), ".reqflow"))}) (subpath ${quote(project.archive)}))
    (allow file-read* (subpath ${quote(home)}) (subpath ${quote(workspace)}) ${shared.map(p => `(subpath ${quote(p)})`).join(" ")})
    (allow file-read-metadata ${[...ancestors].map(p => `(literal ${quote(p)})`).join(" ")})
    (deny file-read* (subpath ${quote(path.join(os.homedir(), ".ssh"))}) (subpath ${quote(project.accountsArchive)}))`;
  return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, ...command], options: { cwd: actualCwd, env },
    readonlyDependencies: Array.from(expected, ([directory, target]) => ({ path: directory, target, linked: linked.has(directory) })) };
}

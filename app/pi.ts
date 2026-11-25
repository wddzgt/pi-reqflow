import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readModelCredential } from "../src/model-credentials.js";
import { execution } from "./process.js";
import type { Task, Settings, Project, Role } from "./types.js";
type PiWork = Pick<Task, 'id' | 'workspace' | 'session' | 'reviewSession'>;
export type PiImage = { type: "image"; data: string; mimeType: string };
export type PiMode = 'task' | 'catalog' | 'module' | 'knowledge-review';

export class Pi {
  child: ChildProcess | undefined;
  private pending: { resolve: (value: any) => void; reject: (error: Error) => void } | null = null;
  private initialize!: (value: any) => void;
  private fatal!: (error: Error) => void;
  constructor(private event: (value: any) => Promise<void>) {}
  async open(project: Project, task: PiWork, settings: Settings, review: boolean, base = path.join(project.archive, 'delivery', task.id)) {
    const home = path.join(base, review ? 'review' : 'pi');
    const worker = fileURLToPath(new URL("./pi-worker.js", import.meta.url));
    const selected = await execution([process.execPath, worker], task.workspace, home, project, settings.runtimeDependencies);
    const keys: Record<string, string> = {};
    for (const provider of settings.providers) keys[provider.id] = await readModelCredential(project.accountsArchive, provider.credentialId);
    const ready = new Promise<any>((resolve, reject) => { this.initialize = resolve; this.fatal = reject; });
    this.child = spawn(selected.command, selected.args, { ...selected.options, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; this.child.stderr!.on("data", data => { stderr = (stderr + data.toString()).slice(-6000); });
    let writing = Promise.resolve();
    this.child.on("message", (value: any) => { writing = writing.then(async () => {
      if (value.type === "initialized") return this.initialize(value);
      if (["finished", "failed", "fatal"].includes(value.type)) {
        const pending = this.pending; this.pending = null;
        if (value.type !== "finished") { const error = Object.assign(new Error(value.error), { code: value.code }); this.fatal(error); pending?.reject(error); }
        else pending?.resolve(value);
      } else {
        await this.event(value);
        if (value.type === 'usage' && value.stage === 'started')
          this.child!.send({ type: 'reservation_persisted', request: value.request });
      }
    }).catch(error => { this.pending?.reject(error); this.pending = null; this.fatal(error); this.child!.kill("SIGTERM"); }); });
    const failed = (error: Error) => { this.fatal(error); this.pending?.reject(error); this.pending = null; };
    this.child.once("error", failed);
    this.child.once("exit", (code, signal) => failed(new Error(`Pi执行进程结束 (${code}, ${signal}) ${stderr}`)));
    this.child.send({ type: "initialize", value: { workspace: task.workspace, home, settings, keys, readonlyDependencies: selected.readonlyDependencies,
      sourcePrefixes: project.sources.map(source => source.prefix), session: review ? task.reviewSession : task.session } });
    return await ready;
  }
  run(task: Pick<Task, 'usage'>, role: Role, prompt: string, files: string[] = [], mode: PiMode = 'task', knowledge: unknown = null, images: PiImage[] = []) {
    if (this.pending) throw new Error("Pi会话仍有运行任务");
    const done = new Promise<any>((resolve, reject) => { this.pending = { resolve, reject }; });
    this.child!.send({ type: "run", value: { id: randomUUID(), role, prompt, files, usage: task.usage, mode, knowledge, images } });
    return done;
  }
  pause() { if (this.pending) this.child!.send({ type: "pause" }); }
  stop() { if (this.child?.connected) this.child.send({ type: "stop" }); }
}

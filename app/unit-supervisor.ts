import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { acquireFileLock } from './file-lock.js';

if (!process.send) throw new Error('单测监督进程需要父进程 IPC');
let running: ChildProcess | null = null;
// The parent forks us as a new process group leader. Only our sandboxed
// checks join this group, so cleanup never depends on a saved or reused PID.
const stop = () => process.kill(-process.pid, 'SIGKILL');
process.once('disconnect', stop);
process.once('SIGTERM', stop);
const send = (value: object) => {
  if (process.connected) process.send!(value, undefined, {}, error => { if (error) stop(); });
};

try {
  const release = acquireFileLock(process.argv[2], '本任务已有单测进程正在执行或退出');
  process.once('exit', release);
  process.on('message', (request: { command: string; args: string[]; options: SpawnOptions }) => {
    if (running) { send({ error: '上一项单测仍在执行' }); return; }
    const child = spawn(request.command, request.args, { cwd: request.options.cwd, env: request.options.env,
      detached: false, stdio: ['ignore', 4, 4] });
    running = child;
    let spawnError: Error | null = null;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      running = null;
      if (spawnError) send({ error: spawnError.message });
      else if (code === null) send({ error: `单元测试被信号${signal}中断` });
      else send({ code });
    });
  });
  if (process.connected) send({ ready: true }); else stop();
} catch (error: any) {
  send({ error: error.message, code: error.code });
}

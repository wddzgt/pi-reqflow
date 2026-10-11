import { spawn } from "node:child_process";
import { assertExecutionActive, executionSignal } from "./action-progress.js";
import { createWriteStream } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { childEnvironment } from "./execution-env.js";

const runtimes = new Map();
const portRange = (process.env.REQFLOW_LOCAL_PORT_RANGE ?? "4180-4184").split("-").map(Number);
if (portRange.length !== 2 || !portRange.every(Number.isSafeInteger) || portRange[0] < 1024 || portRange[1] > 65535
    || portRange[1] - portRange[0] !== 4) throw new Error("REQFLOW_LOCAL_PORT_RANGE 必须是5个连续的有效端口，如4180-4184。");
export const localRuntimePorts = Array.from({ length: 5 }, (_, index) => String(portRange[0] + index));

export function localRuntimeStatus(key) {
  const runtime = runtimes.get(key);
  if (!runtime) return { status: "stopped", services: [] };
  return { status: runtime.services.every(service => service.ready && !service.exited) ? "running" : "failed",
    services: runtime.services.map(({ name, url, command, logFile, exited, error, healthError, tail, bytes }) =>
      ({ name, url, command, logFile, exited, error, healthError, tail, logTruncated: bytes > 1024 * 1024 })) };
}

export async function stopLocalRuntime(key) {
  const runtime = runtimes.get(key);
  if (!runtime) return localRuntimeStatus(key);
  for (const service of runtime.services) {
    if (service.child.pid) {
      const terminate = signal => {
        try { process.kill(process.platform === "win32" ? service.child.pid : -service.child.pid, signal); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      terminate("SIGTERM");
      const timer = setTimeout(() => terminate("SIGKILL"), 1000);
      await service.closed;
      clearTimeout(timer);
      terminate("SIGKILL");
    } else await service.closed;
    await new Promise((resolve, reject) => { service.log.on("error", reject); service.log.end(resolve); });
  }
  const result = localRuntimeStatus(key);
  runtimes.delete(key);
  return { ...result, status: "stopped" };
}

export async function stopAllLocalRuntimes() {
  for (const key of runtimes.keys()) await stopLocalRuntime(key);
}

export async function startLocalRuntime(key, workspace, startup, directory, environment, timeoutMs = 30000, values = {}, serviceValues = null) {
  assertExecutionActive();
  if (localRuntimeStatus(key).status === "running") return localRuntimeStatus(key);
  await stopLocalRuntime(key);
  if (!startup.length) return { status: "not_applicable", services: [] };
  for (const service of startup) {
    const url = new URL(service.url);
    await new Promise((resolve, reject) => {
      const socket = connect({ host: url.hostname === "[::1]" ? "::1" : url.hostname,
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
      socket.once("connect", () => { socket.destroy(); reject(new Error(`本地启动端口已占用：${service.name} ${url.origin}`)); });
      socket.once("error", error => { socket.destroy(); error.code === "ECONNREFUSED" ? resolve() : reject(error); });
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error(`无法确认本地端口：${url.origin}`)); });
    });
  }
  const runtime = { services: [] };
  runtimes.set(key, runtime);
  for (const service of startup) {
    const logFile = path.join(directory, `local-${randomUUID()}.log`);
    const log = createWriteStream(logFile, { flags: "wx", mode: 0o600 });
    const injected = serviceValues === null ? values : serviceValues[service.name];
    if (!injected) throw new Error(`${service.name} 缺少已检查的私有配置。`);
    const names = serviceValues === null ? environment : Object.keys(injected);
    const env = childEnvironment(names, true, injected);
    const child = spawn(service.command[0], service.command.slice(1), { cwd: workspace, env,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const record = { ...service, child, logFile, log, tail: "", bytes: 0, exited: false, ready: false, error: null };
    record.closed = new Promise(resolve => child.once("close", (code, signal) => {
      record.exited = true; record.error = `本地服务退出：code=${code}, signal=${signal}`; resolve();
    }));
    child.once("error", error => { record.error = error.message; });
    log.once("error", error => { record.error = error.message; child.kill("SIGTERM"); });
    const secrets = names.map(name => env[name]).filter(value => value.length).sort((a, b) => b.length - a.length);
    const retained = Math.max(0, ...secrets.map(value => value.length));
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8"); let pending = "";
      const capture = (data, end = false) => {
        pending += end ? decoder.end() : decoder.write(data);
        for (const secret of secrets) pending = pending.split(secret).join("[REDACTED]");
        const length = end ? pending.length : Math.max(0, pending.length - retained);
        const output = Buffer.from(pending.slice(0, length)); pending = pending.slice(length);
        record.tail = (record.tail + output.toString()).slice(-4000);
        if (record.bytes < 1024 * 1024) log.write(output.subarray(0, 1024 * 1024 - record.bytes));
        record.bytes += output.length;
      };
      stream.on("data", capture); stream.once("end", () => capture(null, true));
    }
    runtime.services.push(record);
  }
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertExecutionActive();
      for (const service of runtime.services) {
        if (service.error || service.exited) throw new Error(`${service.name} 启动失败：${service.error}\n${service.tail}`);
        try {
          const signal = executionSignal();
          const response = await fetch(service.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500), redirect: "manual" });
          await response.body?.cancel();
          service.ready = response.ok || (response.status >= 300 && response.status < 400);
          service.healthError = service.ready ? null : `HTTP ${response.status}`;
        } catch (error) {
          assertExecutionActive();
          if (!['TimeoutError', 'TypeError'].includes(error.name)) throw error;
          service.ready = false;
          service.healthError = error.message;
        }
      }
      if (runtime.services.every(service => service.ready && !service.exited)) return localRuntimeStatus(key);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`本地服务在 ${timeoutMs / 1000} 秒内未就绪：${runtime.services.filter(service => !service.ready).map(service => `${service.name} ${service.url} ${service.healthError}\n${service.tail}`).join("\n")}`);
  } catch (error) {
    error.runtime = localRuntimeStatus(key);
    await stopLocalRuntime(key);
    throw error;
  }
}

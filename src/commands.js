import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { childEnvironment } from "./execution-env.js";
import { sha256 } from "./files.js";

const execute = promisify(execFile);

function dockerArguments(argv, cwd, envNames, sandbox, name) {
  if (cwd.includes(",")) throw new Error("Docker workspace path cannot contain a comma");
  const args = ["run", "--rm", "--init", "--pull", "never", "--name", name,
    "--label", `reqflow.workspace=${sha256(cwd)}`,
    "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", String(sandbox.pidsLimit),
    "--memory", `${sandbox.memoryMb}m`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
    "--mount", `type=bind,src=${cwd},dst=/workspace`, "--workdir", "/workspace"];
  if (process.getuid && process.getgid) args.push("--user", `${process.getuid()}:${process.getgid()}`);
  for (const name of envNames) args.push("--env", name);
  args.push("--env", "HOME=/tmp", "--env", "TMPDIR=/tmp", sandbox.image, ...argv);
  return args;
}

async function removeContainer(name, env) {
  try { await execute("docker", ["rm", "-f", name], { env, timeout: 10000 }); }
  catch (error) {
    if (typeof error.stderr === "string" && error.stderr.includes(`No such container: ${name}`)) return;
    throw error;
  }
}

export async function runCommand(argv, cwd, timeoutMs, logFile, maxBytes, envNames, sandbox = null) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("Command argv is required");
  const started = Date.now();
  const env = childEnvironment(envNames);
  const containerName = sandbox ? `reqflow-${randomUUID()}` : null;
  const childEnv = { ...env };
  if (sandbox) {
    for (const name of ["HOME", "DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"]) {
      if (process.env[name] !== undefined) childEnv[name] = process.env[name];
    }
  }
  const workspace = sandbox ? await fs.realpath(cwd) : cwd;
  const executable = sandbox ? "docker" : argv[0];
  const args = sandbox ? dockerArguments(argv, workspace, envNames, sandbox, containerName) : argv.slice(1);
  const log = await fs.open(logFile, "wx", 0o600);
  const child = spawn(executable, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32" });
  const signalGroup = (signal) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let bytes = 0;
  let tail = "";
  let timedOut = false;
  let exceeded = false;
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
  let writes = Promise.resolve();
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      try { signalGroup("SIGKILL"); }
      catch (error) { reject(error); }
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const capture = (stream, label) => stream.on("data", (part) => {
    bytes += part.length;
    tail = (tail + part.toString()).slice(-4000);
    if (bytes > maxBytes) { exceeded = true; terminate(); return; }
    writes = writes.then(() => log.write(`${label}: ${part.toString()}`));
  });
  capture(child.stdout, "stdout");
  capture(child.stderr, "stderr");
  let runError;
  try {
    const exit = await completion;
    await writes;
    await log.sync();
    if (terminationError) throw terminationError;
    if (timedOut) throw new Error(`Command timed out: ${argv[0]}`);
    if (exceeded) throw new Error(`Command log exceeded configured byte limit: ${maxBytes}`);
    return { ...exit, durationMs: Date.now() - started, tail, bytes,
      sandboxImage: sandbox ? sandbox.image : null,
      logHash: sha256(await fs.readFile(logFile)) };
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    try {
      if (containerName) await removeContainer(containerName, childEnv);
    } catch (cleanupError) {
      if (runError) throw new AggregateError([runError, cleanupError], "Command failed and Docker cleanup failed");
      throw cleanupError;
    } finally {
      await log.close();
    }
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

const execute = promisify(execFile);
export async function runGit(root, args, environment = {}) {
  const { stdout } = await execute("git", args, { cwd: root, timeout: 30000, maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...environment } });
  return args.includes("-z") || args.includes("--binary") ? stdout : stdout.trim();
}

export async function inspectGit(directory) {
  let root = await fs.realpath(directory);
  while (!(await fs.readdir(root)).includes(".git")) {
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
  root = await runGit(root, ["rev-parse", "--show-toplevel"]);
  const branch = await runGit(root, ["branch", "--show-current"]);
  const revision = await runGit(root, ["rev-parse", "HEAD"]);
  const branches = (await runGit(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n").filter(Boolean);
  const remotes = [];
  const names = await runGit(root, ["remote"]);
  for (const name of names.split("\n").filter(Boolean)) {
    const url = await runGit(root, ["remote", "get-url", name]);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      const parsed = new URL(url);
      if ((parsed.protocol !== "ssh:" && parsed.username) || parsed.password || parsed.search || parsed.hash) throw new Error("Git 仓库地址含有凭证或查询参数，请改用主机凭证管理或 SSH。");
    }
    remotes.push({ name, url });
  }
  const status = await runGit(root, ["status", "--porcelain", "--untracked-files=normal"]);
  const tracking = await runGit(root, ["for-each-ref", "--format=%(refname)\t%(objectname)", "refs/remotes/"]);
  const remoteBranches = [];
  for (const row of tracking.split("\n").filter(Boolean)) {
    const [ref, revision] = row.split("\t");
    const remote = remotes.find(remote => ref.startsWith(`refs/remotes/${remote.name}/`));
    if (!remote) continue;
    const name = ref.slice(`refs/remotes/${remote.name}/`.length);
    if (name !== "HEAD") remoteBranches.push({ remote: remote.name, branch: name, revision });
  }
  return { root, branch, revision, branches, remoteBranches, remotes, clean: !status.split("\n").some(line => line && !line.slice(3).startsWith(".reqflow/")) };
}

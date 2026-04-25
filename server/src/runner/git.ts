import { spawn } from "child_process";
import type { Repo } from "../repos";

function runGit(
  args: string[],
  cwd: string,
  timeoutMs = 30_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => stdout.push(d.toString()));
    proc.stderr.on("data", (d) => stderr.push(d.toString()));
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") });
    });
  });
}

export async function assertCleanTree(repo: Repo): Promise<void> {
  const res = await runGit(["status", "--porcelain"], repo.path);
  if (res.code !== 0) {
    throw new Error(`git status failed in ${repo.path}: ${res.stderr}`);
  }
  const dirty = res.stdout.trim();
  if (dirty) {
    throw new Error(
      `Working tree is not clean in ${repo.path}. Commit or stash changes before running a workflow.\n${dirty}`
    );
  }
}

export async function getCurrentBranch(repo: Repo): Promise<string> {
  const res = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repo.path);
  if (res.code !== 0) throw new Error(`Cannot determine current branch: ${res.stderr}`);
  return res.stdout.trim();
}

export async function createRunBranch(
  repo: Repo,
  branchName: string
): Promise<string> {
  const previous = await getCurrentBranch(repo);
  const res = await runGit(["checkout", "-b", branchName], repo.path);
  if (res.code !== 0) {
    throw new Error(`git checkout -b ${branchName} failed: ${res.stderr}`);
  }
  return previous;
}

export async function restoreBranch(repo: Repo, branch: string): Promise<void> {
  await runGit(["checkout", branch], repo.path).catch(() => {});
}

// Per-repo serialisation lock: only one run at a time per repo.
const repoQueues = new Map<string, Promise<void>>();

export function runLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoQueues.get(repoId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoQueues.set(repoId, next.then(() => {}, () => {}));
  return next;
}

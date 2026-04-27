import { spawn } from "child_process";

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

export async function assertCleanTree(cwd: string): Promise<void> {
  const res = await runGit(["status", "--porcelain"], cwd);
  if (res.code !== 0) {
    throw new Error(`git status failed in ${cwd}: ${res.stderr}`);
  }
  const dirty = res.stdout.trim();
  if (dirty) {
    throw new Error(
      `Working tree is not clean in ${cwd}. Commit or stash changes before running a workflow.\n${dirty}`
    );
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const res = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (res.code !== 0) throw new Error(`Cannot determine current branch: ${res.stderr}`);
  return res.stdout.trim();
}

export async function createRunBranch(
  cwd: string,
  branchName: string
): Promise<string> {
  const previous = await getCurrentBranch(cwd);
  const res = await runGit(["checkout", "-b", branchName], cwd);
  if (res.code !== 0) {
    throw new Error(`git checkout -b ${branchName} failed: ${res.stderr}`);
  }
  return previous;
}

export async function restoreBranch(cwd: string, branch: string): Promise<void> {
  await runGit(["checkout", branch], cwd).catch(() => {});
}

// Per-repo serialisation lock: only one run at a time per repo.
const repoQueues = new Map<string, Promise<void>>();

export function runLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoQueues.get(repoId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoQueues.set(repoId, next.then(() => {}, () => {}));
  return next;
}

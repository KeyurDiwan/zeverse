import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import type { Repo } from "../repos";
import { parseGitHubOrigin } from "../repos";
import { loadConfig, resolveHubPath } from "../config";
import { runLock } from "./git";

export interface RepoSession {
  path: string;
  baseBranch: string;
  runBranch: string;
  repoId: string;
  origin: string;
  commitAll(message: string): Promise<void>;
  pushRunBranch(): Promise<void>;
  openPR(opts: { title: string; body: string; baseBranch: string }): Promise<{ url: string }>;
  cleanup(): Promise<void>;
  hasUncommittedChanges(): Promise<boolean>;
}

function runGitSync(
  args: string[],
  cwd: string,
  timeoutMs = 120_000
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runGitAsync(
  args: string[],
  cwd: string,
  timeoutMs = 120_000
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

/**
 * True when `origin` is a public GitHub HTTPS URL (not already embedding credentials).
 * SSH remotes use the SSH agent / default key — not `GITHUB_TOKEN`.
 */
function isGithubHttpsOrigin(origin: string): boolean {
  return /^https:\/\/([^/@]+\.)?github\.com\//i.test(origin.trim());
}

function buildSession(
  sessionPath: string,
  baseBranch: string,
  runBranch: string,
  repo: Repo,
  ephemeral: boolean
): RepoSession {
  return {
    path: sessionPath,
    baseBranch,
    runBranch,
    repoId: repo.id,
    origin: repo.origin,

    async hasUncommittedChanges(): Promise<boolean> {
      const res = await runGitAsync(["status", "--porcelain"], sessionPath);
      return (res.stdout?.trim().length ?? 0) > 0;
    },

    async commitAll(message: string): Promise<void> {
      await runGitAsync(["add", "-A"], sessionPath);
      const res = await runGitAsync(["commit", "-m", message, "--allow-empty"], sessionPath);
      if (res.code !== 0 && !res.stdout.includes("nothing to commit")) {
        throw new Error(`git commit failed: ${res.stderr}`);
      }
    },

    async pushRunBranch(): Promise<void> {
      const token = process.env.GITHUB_TOKEN?.trim();
      const ghInfo = parseGitHubOrigin(repo.origin);

      // `git push` does not read `GITHUB_TOKEN` by default — it uses the OS credential
      // helper (often another GitHub user). Use the PAT for GitHub HTTPS when set.
      // --no-verify: repo hooks often log under a fixed $HOME path from the author's
      // machine and fail when Zeverse runs as another user or in automation.
      let res;
      if (token && ghInfo && isGithubHttpsOrigin(repo.origin)) {
        const pushUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${ghInfo.owner}/${ghInfo.repo}.git`;
        res = await runGitAsync(
          ["push", "--no-verify", pushUrl, `HEAD:refs/heads/${runBranch}`],
          sessionPath,
          300_000
        );
      } else {
        res = await runGitAsync(
          ["push", "--no-verify", "--set-upstream", "origin", runBranch],
          sessionPath,
          300_000
        );
      }

      if (res.code !== 0) {
        throw new Error(`git push failed: ${res.stderr}`);
      }
    },

    async openPR(opts): Promise<{ url: string }> {
      const ghRes = spawnSync("gh", [
        "pr", "create",
        "--base", opts.baseBranch,
        "--head", runBranch,
        "--title", opts.title,
        "--body", opts.body,
      ], { cwd: sessionPath, stdio: "pipe", encoding: "utf-8", timeout: 60_000 });

      if (ghRes.status === 0) {
        const url = ghRes.stdout.trim();
        return { url };
      }

      const ghInfo = parseGitHubOrigin(repo.origin);
      const token = process.env.GITHUB_TOKEN;
      if (!ghInfo || !token) {
        throw new Error(
          `gh CLI failed (exit ${ghRes.status}): ${ghRes.stderr}\n` +
          "Set GITHUB_TOKEN for REST fallback or install gh CLI."
        );
      }

      const apiUrl = `https://api.github.com/repos/${ghInfo.owner}/${ghInfo.repo}/pulls`;
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: opts.title,
          body: opts.body,
          head: runBranch,
          base: opts.baseBranch,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub API PR creation failed (${response.status}): ${body}`);
      }

      const data = (await response.json()) as { html_url: string };
      return { url: data.html_url };
    },

    async cleanup(): Promise<void> {
      if (ephemeral && fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    },
  };
}

export interface AcquireSessionOpts {
  repo: Repo;
  baseBranch?: string;
  runId: string;
  workflowName: string;
  keepWorkspace?: boolean;
}

export async function acquireSession(opts: AcquireSessionOpts): Promise<RepoSession> {
  const { repo, runId, workflowName, keepWorkspace } = opts;
  const baseBranch = opts.baseBranch || repo.defaultBranch;
  const runBranch = `zeverse/${workflowName}/${runId.slice(0, 8)}`;

  if (keepWorkspace) {
    return acquireManaged(repo, baseBranch, runBranch, runId);
  }
  return acquireEphemeral(repo, baseBranch, runBranch, runId);
}

async function acquireEphemeral(
  repo: Repo,
  baseBranch: string,
  runBranch: string,
  runId: string
): Promise<RepoSession> {
  const stateDir = resolveHubPath(loadConfig().paths.state_dir);
  const workDir = path.join(stateDir, repo.id, "runs", runId, "work");
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const cloneRes = runGitSync(
    ["clone", "--depth=50", "--branch", baseBranch, repo.origin, workDir],
    process.cwd(),
    300_000
  );
  if (cloneRes.code !== 0) {
    throw new Error(`Ephemeral clone failed: ${cloneRes.stderr}`);
  }

  const branchRes = runGitSync(["checkout", "-b", runBranch], workDir);
  if (branchRes.code !== 0) {
    throw new Error(`Branch creation failed: ${branchRes.stderr}`);
  }

  return buildSession(workDir, baseBranch, runBranch, repo, true);
}

async function acquireManaged(
  repo: Repo,
  baseBranch: string,
  runBranch: string,
  _runId: string
): Promise<RepoSession> {
  const cloneDir = resolveHubPath(loadConfig().paths.clone_dir);
  const workDir = path.join(cloneDir, repo.id);

  const doAcquire = async (): Promise<RepoSession> => {
    if (!fs.existsSync(path.join(workDir, ".git"))) {
      fs.mkdirSync(workDir, { recursive: true });
      const cloneRes = runGitSync(
        ["clone", repo.origin, workDir],
        process.cwd(),
        300_000
      );
      if (cloneRes.code !== 0) {
        throw new Error(`Managed clone failed: ${cloneRes.stderr}`);
      }
    }

    const fetchRes = await runGitAsync(["fetch", "origin", "--prune"], workDir, 120_000);
    if (fetchRes.code !== 0) {
      throw new Error(`git fetch failed: ${fetchRes.stderr}`);
    }

    const resetRes = runGitSync(["reset", "--hard", `origin/${baseBranch}`], workDir);
    if (resetRes.code !== 0) {
      throw new Error(`git reset failed: ${resetRes.stderr}`);
    }

    runGitSync(["clean", "-fd"], workDir);

    const branchRes = runGitSync(["checkout", "-B", runBranch], workDir);
    if (branchRes.code !== 0) {
      throw new Error(`Branch creation failed: ${branchRes.stderr}`);
    }

    return buildSession(workDir, baseBranch, runBranch, repo, false);
  };

  return runLock(repo.id, doAcquire);
}

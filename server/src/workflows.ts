import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import YAML from "yaml";
import type { Repo } from "./repos";
import { loadConfig, resolveHubPath } from "./config";

export interface WorkflowInput {
  id: string;
  label: string;
  required?: boolean;
}

export interface WorkflowStep {
  id: string;
  kind:
    | "llm"
    | "shell"
    | "review"
    | "apply"
    | "patch"
    | "edit"
    | "gdoc-fetch"
    | "gdoc-comment"
    | "gdoc-reply"
    | "gdoc-resolve"
    | "gdoc-suggest"
    | "fr-fetch"
    | "fr-create"
    | "fr-comment"
    | "workflow"
    | "approval"
    | "wait-thread-reply"
    | "har-analyze";
  prompt?: string;
  command?: string;
  cwd?: string;
  continueOnError?: boolean;
  content?: string;
  requireBlocks?: boolean;
  shrinkGuardMinRatio?: number;
  shrinkGuardMinBytes?: number;
  stage?: boolean;
  docUrl?: string;
  queriesFrom?: string;
  repliesFrom?: string;
  resolvesFrom?: string;
  suggestsFrom?: string;
  bodyFrom?: string;
  frCommentExcerpt?: "full" | "summary";
  contentFrom?: string;
  includeComments?: boolean;
  workspace?: string;
  frUrl?: string;
  workflowFrom?: string;
  inputsFrom?: string;
  childWorkflow?: string;
  when?: string;
  retries?: number;
  retryBackoffMs?: number;
  loopUntil?: string;
  maxIterations?: number;
  surface?: "slack" | "ui" | "both";
  approvalTimeoutMs?: number;
  expectFiles?: string[];
  threadReplyTimeoutMs?: number;
  harPathFrom?: string;
  harPath?: string;
  pageUrlFrom?: string;
  apiPrefix?: string;
}

export interface Workflow {
  name: string;
  description: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
  isolation?: "branch" | "none";
  keepWorkspace?: boolean;
  gates?: string[];
  onGateFail?: { childWorkflow: string };
  _filename: string;
  _repoId: string;
}

// ── Workflow cache ──────────────────────────────────────────────────────────
// Workflows and rules are loaded from the repo's default branch via a sparse
// clone cached under state/<repoId>/.workflows-cache/. The cache is refreshed
// on a TTL basis (default 60s).

const CACHE_TTL_MS = 60_000;
const cacheTimestamps = new Map<string, number>();

function workflowsCacheDir(repoId: string): string {
  return path.join(
    resolveHubPath(loadConfig().paths.state_dir),
    repoId,
    ".workflows-cache"
  );
}

/** Sparse paths for workflow/rule sync; must match hub capabilities (.zeverse-only). */
function applyWorkflowSparseCheckout(cacheDir: string): void {
  // --no-cone: .cursorrules is a file, not a directory; cone mode would skip it.
  const res = spawnSync(
    "git",
    [
      "sparse-checkout",
      "set",
      "--no-cone",
      "/.zeverse/",
      "/.cursorrules",
      "/.cursor/rules/",
    ],
    { cwd: cacheDir, stdio: "pipe", encoding: "utf-8" }
  );
  if (res.status !== 0) {
    throw new Error(`Workflow sparse-checkout failed: ${res.stderr}`);
  }
}

function ensureWorkflowsCache(repo: Repo): string {
  const cacheDir = workflowsCacheDir(repo.id);
  const workflowsDir = path.join(cacheDir, ".zeverse", "workflows");
  const now = Date.now();
  const lastRefresh = cacheTimestamps.get(repo.id) ?? 0;
  const hasGit = fs.existsSync(path.join(cacheDir, ".git"));
  const ttlFresh = hasGit && now - lastRefresh < CACHE_TTL_MS;

  // Fast path — but not if the tree is missing (e.g. cache was created with /.archon/ only).
  if (ttlFresh && fs.existsSync(workflowsDir)) {
    return cacheDir;
  }

  if (ttlFresh && hasGit && !fs.existsSync(workflowsDir)) {
    applyWorkflowSparseCheckout(cacheDir);
    if (fs.existsSync(workflowsDir)) {
      return cacheDir;
    }
    cacheTimestamps.delete(repo.id);
  }

  if (!hasGit) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cloneRes = spawnSync(
      "git",
      [
        "clone",
        "--depth=1",
        "--branch",
        repo.defaultBranch,
        "--filter=blob:none",
        "--sparse",
        repo.origin,
        cacheDir,
      ],
      { stdio: "pipe", encoding: "utf-8", timeout: 120_000 }
    );

    if (cloneRes.status !== 0) {
      throw new Error(`Workflow cache clone failed: ${cloneRes.stderr}`);
    }

    applyWorkflowSparseCheckout(cacheDir);
  } else {
    spawnSync("git", ["fetch", "origin", repo.defaultBranch, "--depth=1"], {
      cwd: cacheDir,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 60_000,
    });
    spawnSync("git", ["reset", "--hard", `origin/${repo.defaultBranch}`], {
      cwd: cacheDir,
      stdio: "pipe",
      encoding: "utf-8",
    });
    applyWorkflowSparseCheckout(cacheDir);
  }

  cacheTimestamps.set(repo.id, now);
  return cacheDir;
}

export function refreshWorkflowsCache(repo: Repo): void {
  cacheTimestamps.delete(repo.id);
  ensureWorkflowsCache(repo);
}

export function workflowsDir(repo: Repo): string {
  const cacheDir = ensureWorkflowsCache(repo);
  return path.join(cacheDir, ".zeverse", "workflows");
}

export function commandsDir(repo: Repo): string {
  const cacheDir = ensureWorkflowsCache(repo);
  return path.join(cacheDir, ".zeverse", "commands");
}

export function loadWorkflows(repo: Repo): Workflow[] {
  const dir = workflowsDir(repo);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      const parsed = YAML.parse(raw);
      return {
        ...parsed,
        inputs: parsed.inputs ?? [],
        _filename: f,
        _repoId: repo.id,
      } as Workflow;
    });
}

export function findWorkflow(repo: Repo, name: string): Workflow | undefined {
  return loadWorkflows(repo).find((w) => w.name === name);
}

const MAX_SINGLE_FILE = 4000;
const MAX_TOTAL_RULES = 8000;

function readRuleFiles(dir: string, ext: string): { name: string; content: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => {
      try {
        let content = fs.readFileSync(path.join(dir, f), "utf-8").trim();
        if (content.length > MAX_SINGLE_FILE) {
          content = content.slice(0, MAX_SINGLE_FILE) + "\n...(truncated)";
        }
        return { name: f, content };
      } catch {
        return { name: f, content: "" };
      }
    })
    .filter((r) => r.content.length > 0);
}

/**
 * Load repo-specific rules/skills from the workflows cache:
 *   1. .zeverse/rules/*.md
 *   2. .cursorrules (single file)
 *   3. .cursor/rules/*.md
 */
export function loadRepoRules(repo: Repo): string {
  const cacheDir = ensureWorkflowsCache(repo);
  const parts: string[] = [];

  for (const rule of readRuleFiles(path.join(cacheDir, ".zeverse", "rules"), ".md")) {
    parts.push(`--- rules: .zeverse/rules/${rule.name} ---\n${rule.content}`);
  }

  const cursorrules = path.join(cacheDir, ".cursorrules");
  if (fs.existsSync(cursorrules)) {
    try {
      let content = fs.readFileSync(cursorrules, "utf-8").trim();
      if (content.length > MAX_SINGLE_FILE) {
        content = content.slice(0, MAX_SINGLE_FILE) + "\n...(truncated)";
      }
      if (content) {
        parts.push(`--- rules: .cursorrules ---\n${content}`);
      }
    } catch {
      // skip unreadable
    }
  }

  for (const rule of readRuleFiles(path.join(cacheDir, ".cursor", "rules"), ".md")) {
    parts.push(`--- rules: .cursor/rules/${rule.name} ---\n${rule.content}`);
  }

  if (parts.length === 0) return "";

  let combined = parts.join("\n\n");
  if (combined.length > MAX_TOTAL_RULES) {
    combined = combined.slice(0, MAX_TOTAL_RULES) + "\n...(truncated)";
  }
  return combined;
}

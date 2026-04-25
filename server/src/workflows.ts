import fs from "fs";
import path from "path";
import YAML from "yaml";
import type { Repo } from "./repos";

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
    | "approval";
  prompt?: string;
  command?: string;
  cwd?: string;
  continueOnError?: boolean;
  /** For `apply`/`patch` steps: template whose rendered output is scanned for blocks. */
  content?: string;
  /** For `apply`/`patch` steps: if true, fail when no blocks are found. Defaults to true. */
  requireBlocks?: boolean;
  /**
   * For `apply` steps: refuse to overwrite an existing file whose new size is smaller than
   * this fraction of the old size (e.g. 0.4 means skip if new < 40% of old).
   * Files <= `shrinkGuardMinBytes` are exempt. Set to 0 to disable. Defaults to 0.4.
   */
  shrinkGuardMinRatio?: number;
  /** Files at or below this size are exempt from the shrink guard. Defaults to 1024. */
  shrinkGuardMinBytes?: number;
  /**
   * For `patch` steps: if true, pass `--index` to `git apply` so the change is also staged.
   * Defaults to false (work-tree only, matches how `apply` behaves).
   */
  stage?: boolean;
  /** For `gdoc-fetch` / `gdoc-comment`: Google Doc URL or ID (supports templates). */
  docUrl?: string;
  /** For `gdoc-comment`: step id whose output contains the queries JSON block. */
  queriesFrom?: string;
  /** For `gdoc-reply`: step id whose output contains `[{ commentId, body }]` JSON. */
  repliesFrom?: string;
  /** For `gdoc-resolve`: step id whose output contains `[commentId, ...]` JSON. */
  resolvesFrom?: string;
  /** For `gdoc-suggest`: step id whose output contains `[{ anchor, replacement }]` JSON. */
  suggestsFrom?: string;
  /** For `fr-comment`: step id whose output is used as the comment body. */
  bodyFrom?: string;
  /**
   * For `fr-comment`: if `summary`, post the "## Summary" section (plus a short header/footer)
   * instead of the full step output — avoids huge comments and FR API size limits. Default `full`.
   */
  frCommentExcerpt?: "full" | "summary";
  /** For `fr-create`: step id whose output contains fenced `fr-issues` JSON. */
  contentFrom?: string;
  /** For `gdoc-fetch`: when true, appends existing comments to output. */
  includeComments?: boolean;
  /** For `fr-create` / `fr-fetch`: Freshrelease workspace key (default BILLING). */
  workspace?: string;
  /** For `fr-fetch` / `fr-comment`: Freshrelease task URL (supports templates). */
  frUrl?: string;
  /** For `workflow` steps: step id whose JSON output provides `{workflow, inputs}`. */
  workflowFrom?: string;
  /** For `workflow` steps: step id whose JSON output provides child inputs (if separate from workflowFrom). */
  inputsFrom?: string;
  /** For `workflow` steps: literal child workflow name (used when workflowFrom is absent). */
  childWorkflow?: string;
  /** Optional condition — step is skipped when the rendered value is falsy. */
  when?: string;

  /** Number of retry attempts on failure (0 = no retries). */
  retries?: number;
  /** Base backoff delay in ms between retries (doubles each attempt). */
  retryBackoffMs?: number;
  /** Template expression; step re-runs until this renders truthy (or maxIterations). */
  loopUntil?: string;
  /** Max iterations for loopUntil (default 10). */
  maxIterations?: number;

  /** For `approval` steps: which surface(s) to show the gate on. */
  surface?: "slack" | "ui" | "both";
  /** For `approval` steps: how long to wait before auto-rejecting (ms). */
  approvalTimeoutMs?: number;
}

export interface Workflow {
  name: string;
  description: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
  /** Run isolation strategy. "branch" (default) creates a per-run git branch. */
  isolation?: "branch" | "none";
  /** Step ids that must be "success" for the run to succeed. Checked after all steps finish. */
  gates?: string[];
  /** When gates fail, optionally dispatch this child workflow to attempt a fix. */
  onGateFail?: { childWorkflow: string };
  _filename: string;
  _repoId: string;
}

export function workflowsDir(repo: Repo): string {
  return path.join(repo.path, ".archon", "workflows");
}

export function commandsDir(repo: Repo): string {
  return path.join(repo.path, ".archon", "commands");
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
 * Load repo-specific rules/skills from:
 *   1. .archon/rules/*.md
 *   2. .cursorrules (single file)
 *   3. .cursor/rules/*.md
 * Returns concatenated text with section headers, capped at MAX_TOTAL_RULES chars.
 */
export function loadRepoRules(repo: Repo): string {
  const parts: string[] = [];

  for (const rule of readRuleFiles(path.join(repo.path, ".archon", "rules"), ".md")) {
    parts.push(`--- rules: .archon/rules/${rule.name} ---\n${rule.content}`);
  }

  const cursorrules = path.join(repo.path, ".cursorrules");
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

  for (const rule of readRuleFiles(path.join(repo.path, ".cursor", "rules"), ".md")) {
    parts.push(`--- rules: .cursor/rules/${rule.name} ---\n${rule.content}`);
  }

  if (parts.length === 0) return "";

  let combined = parts.join("\n\n");
  if (combined.length > MAX_TOTAL_RULES) {
    combined = combined.slice(0, MAX_TOTAL_RULES) + "\n...(truncated)";
  }
  return combined;
}

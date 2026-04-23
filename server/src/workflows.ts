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
  kind: "llm" | "shell" | "review" | "apply" | "patch" | "edit" | "gdoc-fetch" | "gdoc-comment";
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
}

export interface Workflow {
  name: string;
  description: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
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

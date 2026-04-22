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
  kind: "llm" | "shell" | "review";
  prompt?: string;
  command?: string;
  cwd?: string;
  continueOnError?: boolean;
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

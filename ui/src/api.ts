const BASE = "/api";

export interface Repo {
  id: string;
  name: string;
  path: string;
  origin?: string;
  addedAt: string;
}

export interface WorkflowSummary {
  name: string;
  description: string;
  inputs: { id: string; label: string; required?: boolean }[];
  steps: { id: string; kind: string }[];
}

export type RunStatus = "queued" | "running" | "success" | "failed";

export interface StepResult {
  id: string;
  kind: string;
  status: RunStatus;
  output: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface RunState {
  runId: string;
  repoId: string;
  workflow: string;
  status: RunStatus;
  prompt: string;
  steps: StepResult[];
  createdAt: string;
  finishedAt?: string;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any)?.error ?? res.statusText;
    throw new Error(msg);
  }
  return data as T;
}

export async function fetchRepos(): Promise<Repo[]> {
  const res = await fetch(`${BASE}/repos`);
  const data = await json<{ repos: Repo[] }>(res);
  return data.repos;
}

export async function addGitRepo(url: string, name?: string): Promise<Repo> {
  const res = await fetch(`${BASE}/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, name }),
  });
  const data = await json<{ repo: Repo }>(res);
  return data.repo;
}

export async function removeRepo(id: string): Promise<void> {
  const res = await fetch(`${BASE}/repos/${id}`, { method: "DELETE" });
  await json<{ ok: true }>(res);
}

export async function fetchWorkflows(repoId: string): Promise<WorkflowSummary[]> {
  const res = await fetch(`${BASE}/workflows?repoId=${encodeURIComponent(repoId)}`);
  const data = await json<{ workflows: WorkflowSummary[] }>(res);
  return data.workflows;
}

export async function triggerRun(
  repoId: string,
  workflow: string,
  prompt: string,
  inputs?: Record<string, string>
): Promise<string> {
  const res = await fetch(`${BASE}/run-workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId, workflow, prompt, inputs }),
  });
  const data = await json<{ runId: string }>(res);
  return data.runId;
}

export async function fetchRun(repoId: string, runId: string): Promise<RunState> {
  const res = await fetch(
    `${BASE}/runs/${runId}?repoId=${encodeURIComponent(repoId)}`
  );
  return json<RunState>(res);
}

export async function fetchLogs(
  repoId: string,
  runId: string,
  offset = 0
): Promise<{ content: string; nextOffset: number }> {
  const res = await fetch(
    `${BASE}/logs/${runId}?repoId=${encodeURIComponent(repoId)}&offset=${offset}`
  );
  return json<{ content: string; nextOffset: number }>(res);
}

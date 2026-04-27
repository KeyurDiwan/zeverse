import fs from "fs";
import path from "path";
import { loadConfig, resolveHubPath } from "../config";

export type RunStatus = "queued" | "running" | "success" | "failed" | "awaiting_approval";

export interface StepResult {
  id: string;
  kind: string;
  status: RunStatus;
  output: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface GateFailure {
  stepId: string;
  error: string;
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
  branch?: string;
  baseBranch?: string;
  prUrl?: string;
  gateFailures?: GateFailure[];
}

function runsDir(repoId: string): string {
  return path.join(resolveHubPath(loadConfig().paths.state_dir), repoId, "runs");
}

function ensureRunsDir(repoId: string): void {
  const dir = runsDir(repoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function statePath(repoId: string, runId: string): string {
  return path.join(runsDir(repoId), `${runId}.json`);
}

export function logPath(repoId: string, runId: string): string {
  return path.join(runsDir(repoId), `${runId}.log`);
}

export function saveState(state: RunState): void {
  ensureRunsDir(state.repoId);
  fs.writeFileSync(statePath(state.repoId, state.runId), JSON.stringify(state, null, 2));
}

export function loadState(repoId: string, runId: string): RunState | null {
  const p = statePath(repoId, runId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function findStateByRunId(runId: string): RunState | null {
  const root = resolveHubPath(loadConfig().paths.state_dir);
  if (!fs.existsSync(root)) return null;
  for (const repoId of fs.readdirSync(root)) {
    const p = statePath(repoId, runId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  }
  return null;
}

export function appendLog(repoId: string, runId: string, line: string): void {
  ensureRunsDir(repoId);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logPath(repoId, runId), `[${timestamp}] ${line}\n`);
}

export function readLog(
  repoId: string,
  runId: string,
  offset = 0
): { content: string; nextOffset: number } {
  const p = logPath(repoId, runId);
  if (!fs.existsSync(p)) return { content: "", nextOffset: 0 };
  const buf = fs.readFileSync(p, "utf-8");
  const content = buf.slice(offset);
  return { content, nextOffset: buf.length };
}

// ── Run events (NDJSON) ─────────────────────────────────────────────────────

export interface RunEvent {
  ts: string;
  type: string;
  stepId?: string;
  stepKind?: string;
  status?: string;
  error?: string;
  by?: string;
  comment?: string;
  [key: string]: unknown;
}

export function eventsPath(repoId: string, runId: string): string {
  return path.join(runsDir(repoId), `${runId}.events.ndjson`);
}

export function appendEvent(repoId: string, runId: string, event: Omit<RunEvent, "ts">): void {
  ensureRunsDir(repoId);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  fs.appendFileSync(eventsPath(repoId, runId), line + "\n");
}

export function readEvents(
  repoId: string,
  runId: string,
  offset = 0
): { content: string; nextOffset: number } {
  const p = eventsPath(repoId, runId);
  if (!fs.existsSync(p)) return { content: "", nextOffset: 0 };
  const buf = fs.readFileSync(p, "utf-8");
  const content = buf.slice(offset);
  return { content, nextOffset: buf.length };
}

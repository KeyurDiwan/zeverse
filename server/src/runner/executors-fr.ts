import type { WorkflowStep } from "../workflows";
import type { TemplateContext } from "./template";
import { renderTemplate } from "./template";
import { appendLog } from "./state";
import {
  getTask,
  createIssue,
  addFRComment,
  formatTaskForLLM,
  type CreateIssueParams,
} from "../integrations/freshrelease";

/** Text between a `## Summary` heading and the next `##` section (or EOF). */
export function extractFrAnalysisSummarySection(text: string): string | null {
  const m = text.match(/^##\s*Summary\s*$/m);
  if (m == null || m.index === undefined) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.search(/^##\s+\S/m);
  const block = (next === -1 ? after : after.slice(0, next)).trim();
  return block || null;
}

function buildFrAnalyzeCommentBody(raw: string, excerpt: "full" | "summary" | undefined): string {
  if (excerpt !== "summary") return raw;

  const section = extractFrAnalysisSummarySection(raw);
  if (section) {
    return [
      "## Zeverse: fr-analyze",
      "",
      section,
      "",
      "_Full analysis is in the Zeverse run log._",
    ].join("\n");
  }
  // Model omitted "## Summary" — post a short prefix + trimmed analysis head
  const head = raw.length > 12_000 ? `${raw.slice(0, 12_000).trim()}\n\n…` : raw;
  return [
    "## Zeverse: fr-analyze",
    "",
    "_No `## Summary` section was found; posting analysis excerpt._",
    "",
    head,
  ].join("\n");
}

export async function executeFRFetchStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const raw =
    renderTemplate(step.frUrl ?? "", ctx) ||
    ctx.inputs.frUrl ||
    "";

  if (!raw) {
    throw new Error(
      `[${step.id}] No Freshrelease URL provided. Set frUrl on the step or pass inputs.frUrl.`
    );
  }

  const ws = renderTemplate(step.workspace ?? "", ctx) || "BILLING";
  appendLog(repoId, runId, `[${step.id}] Fetching FR task: ${raw}`);

  const task = await getTask(raw, ws);
  const formatted = formatTaskForLLM(task);

  appendLog(
    repoId,
    runId,
    `[${step.id}] Fetched ${task.key}: "${task.title}" (${task.comments.length} comments)`
  );
  return formatted;
}

interface FRIssueEntry {
  title: string;
  description?: string;
  issueType?: string;
  priority?: string;
  epicKey?: string;
}

/**
 * Extracts FR issue entries from a fenced `json fr-issues` block.
 * Tolerates truncated LLM output: if the closing fence or array bracket
 * is missing, recovers by finding the last complete JSON object in the
 * partial stream and parsing the valid prefix.
 */
export function parseFRIssuesJson(text: string): FRIssueEntry[] {
  const strictRe = /```(?:json)?\s*fr-issues?\s*\n([\s\S]*?)```/i;
  const looseRe = /```(?:json)?\s*fr-issues?\s*\n([\s\S]*)/i;

  const m = strictRe.exec(text) ?? looseRe.exec(text);
  if (!m) return [];

  const raw = m[1].trim();
  if (!raw) return [];

  const tryParse = (s: string): FRIssueEntry[] => {
    try {
      const parsed = JSON.parse(s);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e: any) => typeof e === "object" && typeof e.title === "string"
      );
    } catch {
      return [];
    }
  };

  const strict = tryParse(raw);
  if (strict.length > 0) return strict;

  // Recovery: find the last complete JSON object `}` respecting string quoting,
  // then wrap as a valid array and re-parse.
  let lastCompleteObj = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) lastCompleteObj = i; }
  }

  if (lastCompleteObj <= 0) return [];

  const prefix = raw.slice(0, lastCompleteObj + 1).trimEnd();
  const candidate = prefix.endsWith("]") ? prefix : prefix + "]";
  return tryParse(candidate);
}

export async function executeFRCreateStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const sourceStepId = step.contentFrom;
  if (!sourceStepId || !ctx.steps[sourceStepId]) {
    throw new Error(
      `[${step.id}] contentFrom="${sourceStepId}" not found in previous step outputs.`
    );
  }

  const sourceOutput = ctx.steps[sourceStepId].output;
  const issues = parseFRIssuesJson(sourceOutput);
  const ws = renderTemplate(step.workspace ?? "", ctx) || "BILLING";

  appendLog(
    repoId,
    runId,
    `[${step.id}] Parsed ${issues.length} issues from step "${sourceStepId}"`
  );

  if (issues.length === 0) {
    return "No FR issues found in source step output.\n";
  }

  const epics = issues.filter(
    (i) => (i.issueType ?? "").toLowerCase() === "epic"
  );
  const nonEpics = issues.filter(
    (i) => (i.issueType ?? "").toLowerCase() !== "epic"
  );

  const results: string[] = [];
  const epicKeyMap = new Map<string, string>();

  for (const epic of epics) {
    try {
      const created = await createIssue({
        workspace: ws,
        title: epic.title,
        description: epic.description,
        issueType: "Epic",
        priority: epic.priority,
      });
      epicKeyMap.set(epic.title, created.key);
      results.push(`+ Epic "${epic.title}" → ${created.key} (${created.url})`);
      appendLog(repoId, runId, `[${step.id}] Created epic ${created.key}`);
    } catch (err: any) {
      results.push(`FAIL Epic "${epic.title}": ${err.message}`);
      appendLog(repoId, runId, `[${step.id}] FAIL epic: ${err.message}`);
    }
  }

  for (const task of nonEpics) {
    const params: CreateIssueParams = {
      workspace: ws,
      title: task.title,
      description: task.description,
      issueType: task.issueType ?? "Task",
      priority: task.priority,
    };
    if (task.epicKey) {
      params.epicKey = epicKeyMap.get(task.epicKey) ?? task.epicKey;
    }
    try {
      const created = await createIssue(params);
      results.push(
        `+ ${params.issueType} "${task.title}" → ${created.key} (${created.url})`
      );
      appendLog(repoId, runId, `[${step.id}] Created ${created.key}`);
    } catch (err: any) {
      results.push(`FAIL ${params.issueType} "${task.title}": ${err.message}`);
      appendLog(repoId, runId, `[${step.id}] FAIL task: ${err.message}`);
    }
  }

  return [
    `Created ${results.filter((r) => r.startsWith("+")).length}/${issues.length} issues in ${ws}:`,
    ...results,
  ].join("\n") + "\n";
}

export async function executeFRCommentStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const raw =
    renderTemplate(step.frUrl ?? "", ctx) ||
    ctx.inputs.frUrl ||
    "";

  if (!raw) {
    throw new Error(
      `[${step.id}] No Freshrelease URL provided. Set frUrl on the step or pass inputs.frUrl.`
    );
  }

  let body: string;
  if (step.bodyFrom && ctx.steps[step.bodyFrom]) {
    body = ctx.steps[step.bodyFrom].output;
  } else if (step.prompt) {
    body = renderTemplate(step.prompt, ctx);
  } else {
    throw new Error(
      `[${step.id}] No comment body. Set bodyFrom or prompt.`
    );
  }

  const excerpt = step.frCommentExcerpt;
  if (excerpt) {
    body = buildFrAnalyzeCommentBody(body, excerpt);
  }

  const ws = renderTemplate(step.workspace ?? "", ctx) || "BILLING";
  appendLog(repoId, runId, `[${step.id}] Posting comment on ${raw}`);

  const result = await addFRComment(raw, body, ws);
  appendLog(
    repoId,
    runId,
    `[${step.id}] Comment posted (id=${result.id})`
  );
  return `Posted comment on ${raw} (id=${result.id})\n`;
}

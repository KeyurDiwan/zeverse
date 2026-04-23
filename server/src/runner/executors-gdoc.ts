import type { WorkflowStep } from "../workflows";
import type { TemplateContext } from "./template";
import { renderTemplate } from "./template";
import { appendLog } from "./state";
import {
  extractDocId,
  fetchDocText,
  addComment,
  listExistingComments,
  CommentResult,
} from "../integrations/gdocs";

export async function executeGDocFetchStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const raw =
    renderTemplate(step.docUrl ?? "", ctx) ||
    ctx.inputs.docUrl ||
    "";

  if (!raw) {
    throw new Error(
      `[${step.id}] No Google Doc URL provided. Set docUrl on the step or pass inputs.docUrl.`
    );
  }

  const docId = extractDocId(raw);
  appendLog(repoId, runId, `[${step.id}] Fetching Google Doc ${docId}`);

  const text = await fetchDocText(docId);
  appendLog(
    repoId,
    runId,
    `[${step.id}] Fetched ${text.length} chars from Google Doc`
  );
  return text;
}

interface QueryEntry {
  anchor?: string;
  body: string;
}

/**
 * Finds the first fenced JSON block tagged "queries" and parses it.
 */
function parseQueriesJson(text: string): QueryEntry[] {
  const re = /```(?:json)?\s*queries?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) => typeof e === "object" && typeof e.body === "string"
    );
  } catch {
    return [];
  }
}

export async function executeGDocCommentStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const raw =
    renderTemplate(step.docUrl ?? "", ctx) ||
    ctx.inputs.docUrl ||
    "";

  if (!raw) {
    throw new Error(
      `[${step.id}] No Google Doc URL provided. Set docUrl on the step or pass inputs.docUrl.`
    );
  }

  const docId = extractDocId(raw);

  const sourceStepId = step.queriesFrom;
  if (!sourceStepId || !ctx.steps[sourceStepId]) {
    throw new Error(
      `[${step.id}] queriesFrom="${sourceStepId}" not found in previous step outputs.`
    );
  }

  const sourceOutput = ctx.steps[sourceStepId].output;
  const queries = parseQueriesJson(sourceOutput);

  appendLog(
    repoId,
    runId,
    `[${step.id}] Parsed ${queries.length} queries from step "${sourceStepId}"`
  );

  if (queries.length === 0) {
    return "No queries to post as comments.\n";
  }

  appendLog(repoId, runId, `[${step.id}] Fetching existing comments for dedup...`);
  const existing = await listExistingComments(docId);
  appendLog(repoId, runId, `[${step.id}] Found ${existing.size} existing open comments`);

  const results: CommentResult[] = [];
  let skipped = 0;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const trimmedBody = q.body.trim();

    if (existing.has(trimmedBody)) {
      skipped++;
      appendLog(
        repoId,
        runId,
        `[${step.id}] Comment ${i + 1}/${queries.length} SKIPPED (duplicate)`
      );
      results.push({ index: i, body: q.body, status: "ok", commentId: "dup-skipped" });
      continue;
    }

    try {
      const { commentId } = await addComment(docId, trimmedBody);
      existing.add(trimmedBody);
      appendLog(
        repoId,
        runId,
        `[${step.id}] Comment ${i + 1}/${queries.length} posted (id=${commentId})`
      );
      results.push({ index: i, body: q.body, status: "ok", commentId });
    } catch (err: any) {
      appendLog(
        repoId,
        runId,
        `[${step.id}] Comment ${i + 1}/${queries.length} FAILED: ${err.message}`
      );
      results.push({ index: i, body: q.body, status: "error", error: err.message });
    }
  }

  const posted = results.filter((r) => r.status === "ok" && r.commentId !== "dup-skipped").length;
  const lines = results.map(
    (r) => {
      if (r.commentId === "dup-skipped") return `SKIP [${r.index + 1}] ${r.body.slice(0, 80)} (already exists)`;
      if (r.status === "ok") return `+ [${r.index + 1}] ${r.body.slice(0, 80)} (id=${r.commentId})`;
      return `FAIL [${r.index + 1}] ${r.body.slice(0, 80)} — ${r.error}`;
    }
  );

  return [
    `Posted ${posted}/${queries.length} comments on doc ${docId} (${skipped} skipped as duplicates):`,
    ...lines,
  ].join("\n") + "\n";
}

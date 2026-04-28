import type { WorkflowStep } from "../workflows";
import type { TemplateContext } from "./template";
import { renderTemplate } from "./template";
import { appendLog } from "./state";
import {
  extractDocId,
  fetchDocText,
  addComment,
  listExistingComments,
  listOpenCommentsDetailed,
  replyToComment,
  resolveComment,
  resolveQuotedSpan,
  suggestEdits,
  CommentResult,
  type SuggestEdit,
} from "../integrations/gdocs";
import {
  isConfluenceUrl,
  extractPageId,
  fetchPageText as confluenceFetchPageText,
  listExistingComments as confluenceListExistingComments,
  listCommentsDetailed as confluenceListCommentsDetailed,
  addComment as confluenceAddComment,
} from "../integrations/confluence";

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
      `[${step.id}] No document URL provided. Set docUrl on the step or pass inputs.docUrl.`
    );
  }

  if (isConfluenceUrl(raw)) {
    const pageId = extractPageId(raw);
    appendLog(repoId, runId, `[${step.id}] Fetching Confluence page ${pageId}`);

    const text = await confluenceFetchPageText(pageId);
    appendLog(repoId, runId, `[${step.id}] Fetched ${text.length} chars from Confluence`);

    if (!step.includeComments) return text;

    const comments = await confluenceListCommentsDetailed(pageId);
    appendLog(repoId, runId, `[${step.id}] Fetched ${comments.length} comments (includeComments=true)`);
    const commentsJson = JSON.stringify(comments, null, 2);
    return `${text}\n\n--- COMMENTS ---\n${commentsJson}\n--- END COMMENTS ---\n`;
  }

  const docId = extractDocId(raw);
  appendLog(repoId, runId, `[${step.id}] Fetching Google Doc ${docId}`);

  const text = await fetchDocText(docId);
  appendLog(
    repoId,
    runId,
    `[${step.id}] Fetched ${text.length} chars from Google Doc`
  );

  if (!step.includeComments) return text;

  const comments = await listOpenCommentsDetailed(docId);
  appendLog(
    repoId,
    runId,
    `[${step.id}] Fetched ${comments.length} comments (includeComments=true)`
  );
  const commentsJson = JSON.stringify(comments, null, 2);
  return `${text}\n\n--- COMMENTS ---\n${commentsJson}\n--- END COMMENTS ---\n`;
}

export type QuerySeverity = "critical" | "nice-to-have";

export interface QueryEntry {
  anchor?: string;
  body: string;
  severity?: QuerySeverity;
}

function parseQuerySeverity(raw: unknown): QuerySeverity {
  return raw === "critical" ? "critical" : "nice-to-have";
}

/**
 * Plain-text PRD comment body for Google Docs (no markdown).
 * Drive shows the quoted passage via quotedFileContent—do not duplicate it here.
 * Only used when an anchor was resolved (workflow skips rows without anchors on GDoc).
 */
export function formatPrdGdocQueryComment(params: {
  index: number;
  body: string;
  severity: QuerySeverity;
}): string {
  const title = `[PRD Q${params.index}] [${params.severity}]`;
  return [
    title,
    "",
    "Question / feedback:",
    params.body.trim(),
  ].join("\n");
}

/**
 * Finds the first fenced JSON block tagged "queries" and parses it.
 */
export function parseQueriesJson(text: string): QueryEntry[] {
  const re = /```(?:json)?\s*queries?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e: any) => typeof e === "object" && typeof e.body === "string")
      .map((e: any) => ({
        body: e.body as string,
        anchor: typeof e.anchor === "string" ? e.anchor : undefined,
        severity: parseQuerySeverity(e.severity),
      }));
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
      `[${step.id}] No document URL provided. Set docUrl on the step or pass inputs.docUrl.`
    );
  }

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

  const useConfluence = isConfluenceUrl(raw);
  const targetId = useConfluence ? extractPageId(raw) : extractDocId(raw);

  appendLog(repoId, runId, `[${step.id}] Fetching existing comments for dedup...`);
  const existing = useConfluence
    ? await confluenceListExistingComments(targetId)
    : await listExistingComments(targetId);
  appendLog(repoId, runId, `[${step.id}] Found ${existing.size} existing open comments`);

  let docText = "";
  if (!useConfluence) {
    docText = await fetchDocText(targetId);
    appendLog(
      repoId,
      runId,
      `[${step.id}] Loaded ${docText.length} chars for anchor verification`
    );
  }

  const results: CommentResult[] = [];
  let skippedDup = 0;
  let skippedAnchor = 0;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const trimmedBody = q.body.trim();
    const severity = q.severity ?? "nice-to-have";
    const anchorRaw = q.anchor?.trim() ?? "";

    const quotedSpan =
      !useConfluence && anchorRaw ? resolveQuotedSpan(docText, anchorRaw) : null;

    if (!useConfluence && quotedSpan === null) {
      skippedAnchor++;
      appendLog(
        repoId,
        runId,
        `[${step.id}] Comment ${i + 1}/${queries.length} SKIPPED (not anchored — add verbatim \`anchor\` from PRD in queries JSON)`
      );
      results.push({ index: i, body: q.body, status: "ok", commentId: "anchor-skipped" });
      continue;
    }

    const fullComment = useConfluence
      ? trimmedBody
      : formatPrdGdocQueryComment({
          index: i + 1,
          body: trimmedBody,
          severity,
        });

    const dedupKey = fullComment.trim();

    if (existing.has(dedupKey)) {
      skippedDup++;
      appendLog(
        repoId,
        runId,
        `[${step.id}] Comment ${i + 1}/${queries.length} SKIPPED (duplicate)`
      );
      results.push({ index: i, body: q.body, status: "ok", commentId: "dup-skipped" });
      continue;
    }

    try {
      const { commentId } = useConfluence
        ? await confluenceAddComment(targetId, trimmedBody)
        : await addComment(targetId, fullComment, {
            quotedAnchor: quotedSpan ?? undefined,
          });
      existing.add(dedupKey);
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

  const posted = results.filter(
    (r) =>
      r.status === "ok" &&
      r.commentId !== "dup-skipped" &&
      r.commentId !== "anchor-skipped"
  ).length;
  const lines = results.map((r) => {
    if (r.commentId === "dup-skipped") {
      return `SKIP [${r.index + 1}] ${r.body.slice(0, 80)} (already exists)`;
    }
    if (r.commentId === "anchor-skipped") {
      return `SKIP [${r.index + 1}] ${r.body.slice(0, 80)} (not anchored)`;
    }
    if (r.status === "ok") return `+ [${r.index + 1}] ${r.body.slice(0, 80)} (id=${r.commentId})`;
    return `FAIL [${r.index + 1}] ${r.body.slice(0, 80)} — ${r.error}`;
  });

  return [
    `Posted ${posted}/${queries.length} comments on doc ${targetId} (${skippedDup} skipped as duplicates, ${skippedAnchor} skipped — no resolvable anchor):`,
    ...lines,
  ].join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/*  gdoc-reply                                                        */
/* ------------------------------------------------------------------ */

interface ReplyEntry {
  commentId: string;
  body: string;
}

function parseRepliesJson(text: string): ReplyEntry[] {
  const re = /```(?:json)?\s*replies?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) =>
        typeof e === "object" &&
        typeof e.commentId === "string" &&
        typeof e.body === "string"
    );
  } catch {
    return [];
  }
}

export async function executeGDocReplyStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const raw =
    renderTemplate(step.docUrl ?? "", ctx) || ctx.inputs.docUrl || "";
  if (!raw)
    throw new Error(`[${step.id}] No document URL. Set docUrl or inputs.docUrl.`);

  if (isConfluenceUrl(raw)) {
    appendLog(repoId, runId, `[${step.id}] Confluence URL — reply not supported, skipping`);
    return "Confluence URL — reply-to-comment not supported, skipping.\n";
  }

  const docId = extractDocId(raw);

  const sourceStepId = step.repliesFrom;
  if (!sourceStepId || !ctx.steps[sourceStepId])
    throw new Error(`[${step.id}] repliesFrom="${sourceStepId}" not found.`);

  const replies = parseRepliesJson(ctx.steps[sourceStepId].output);
  appendLog(repoId, runId, `[${step.id}] Parsed ${replies.length} replies from "${sourceStepId}"`);
  if (replies.length === 0) return "No replies to post.\n";

  const results: string[] = [];
  for (const r of replies) {
    try {
      const { replyId } = await replyToComment(docId, r.commentId, r.body);
      results.push(`+ reply on ${r.commentId} (id=${replyId})`);
      appendLog(repoId, runId, `[${step.id}] Replied on ${r.commentId}`);
    } catch (err: any) {
      results.push(`FAIL reply on ${r.commentId}: ${err.message}`);
      appendLog(repoId, runId, `[${step.id}] FAIL reply ${r.commentId}: ${err.message}`);
    }
  }

  return [`Replied to ${results.filter((r) => r.startsWith("+")).length}/${replies.length} comments:`, ...results].join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/*  gdoc-resolve                                                      */
/* ------------------------------------------------------------------ */

function parseResolveJson(text: string): string[] {
  const re = /```(?:json)?\s*resolve\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e: any) => typeof e === "string");
  } catch {
    return [];
  }
}

export async function executeGDocResolveStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const raw =
    renderTemplate(step.docUrl ?? "", ctx) || ctx.inputs.docUrl || "";
  if (!raw)
    throw new Error(`[${step.id}] No document URL. Set docUrl or inputs.docUrl.`);

  if (isConfluenceUrl(raw)) {
    appendLog(repoId, runId, `[${step.id}] Confluence URL — resolve not supported, skipping`);
    return "Confluence URL — resolve-comment not supported, skipping.\n";
  }

  const docId = extractDocId(raw);

  const sourceStepId = step.resolvesFrom;
  if (!sourceStepId || !ctx.steps[sourceStepId])
    throw new Error(`[${step.id}] resolvesFrom="${sourceStepId}" not found.`);

  const ids = parseResolveJson(ctx.steps[sourceStepId].output);
  appendLog(repoId, runId, `[${step.id}] Parsed ${ids.length} comment IDs to resolve`);
  if (ids.length === 0) return "No comments to resolve.\n";

  let resolved = 0;
  const results: string[] = [];
  for (const id of ids) {
    try {
      await resolveComment(docId, id);
      resolved++;
      results.push(`+ resolved ${id}`);
      appendLog(repoId, runId, `[${step.id}] Resolved ${id}`);
    } catch (err: any) {
      results.push(`FAIL resolve ${id}: ${err.message}`);
      appendLog(repoId, runId, `[${step.id}] FAIL resolve ${id}: ${err.message}`);
    }
  }

  return [`Resolved ${resolved}/${ids.length} comments:`, ...results].join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/*  gdoc-suggest                                                      */
/* ------------------------------------------------------------------ */

function parseSuggestJson(text: string): SuggestEdit[] {
  const re = /```(?:json)?\s*suggest(?:ions?)?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) =>
        typeof e === "object" &&
        typeof e.anchor === "string" &&
        typeof e.replacement === "string"
    );
  } catch {
    return [];
  }
}

export async function executeGDocSuggestStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const raw =
    renderTemplate(step.docUrl ?? "", ctx) || ctx.inputs.docUrl || "";
  if (!raw)
    throw new Error(`[${step.id}] No document URL. Set docUrl or inputs.docUrl.`);

  if (isConfluenceUrl(raw)) {
    appendLog(repoId, runId, `[${step.id}] Confluence URL — suggest-edits not supported, skipping`);
    return "Confluence URL — suggest-edits not supported, skipping.\n";
  }

  const docId = extractDocId(raw);

  const sourceStepId = step.suggestsFrom;
  if (!sourceStepId || !ctx.steps[sourceStepId])
    throw new Error(`[${step.id}] suggestsFrom="${sourceStepId}" not found.`);

  const edits = parseSuggestJson(ctx.steps[sourceStepId].output);
  appendLog(repoId, runId, `[${step.id}] Parsed ${edits.length} suggest-edits`);
  if (edits.length === 0) return "No suggest-edits to apply.\n";

  const result = await suggestEdits(docId, edits);
  const lines = [
    `Applied ${result.applied}/${edits.length} suggest-edits on doc ${docId}:`,
    ...result.skipped.map((s) => `SKIP "${s.anchor.slice(0, 60)}": ${s.reason}`),
  ];
  appendLog(repoId, runId, `[${step.id}] ${lines[0]}`);
  return lines.join("\n") + "\n";
}

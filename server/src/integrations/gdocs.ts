import fs from "fs";
import path from "path";
import { google, docs_v1, drive_v3 } from "googleapis";

const SA_PATH =
  process.env.GOOGLE_SERVICE_ACCOUNT_PATH ??
  path.resolve(__dirname, "../../../config/gcp-service-account.json");

let _docs: docs_v1.Docs | null = null;
let _drive: drive_v3.Drive | null = null;

function getClients(): { docs: docs_v1.Docs; drive: drive_v3.Drive } {
  if (_docs && _drive) return { docs: _docs, drive: _drive };

  if (!fs.existsSync(SA_PATH)) {
    throw new Error(
      `Google service-account JSON not found at ${SA_PATH}. ` +
        `Set GOOGLE_SERVICE_ACCOUNT_PATH or place the file at config/gcp-service-account.json`
    );
  }

  const creds = JSON.parse(fs.readFileSync(SA_PATH, "utf-8"));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive",
    ],
  });

  _docs = google.docs({ version: "v1", auth });
  _drive = google.drive({ version: "v3", auth });
  return { docs: _docs, drive: _drive };
}

/**
 * Accepts a full Google Docs URL or a bare document ID and returns the ID.
 */
export function extractDocId(urlOrId: string): string {
  const trimmed = urlOrId.trim().replace(/^<|>$/g, ""); // Slack wraps URLs in <>
  const m = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // Treat as raw id if it looks like one (alphanumeric + dashes/underscores, 20+ chars)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  throw new Error(
    `Cannot extract Google Doc ID from: ${urlOrId.slice(0, 120)}`
  );
}

/**
 * Fetches the plain-text content of a Google Doc by flattening paragraph runs.
 */
export async function fetchDocText(docId: string): Promise<string> {
  const { docs } = getClients();
  const res = await docs.documents.get({ documentId: docId });
  const body = res.data.body;
  if (!body?.content) return "";
  return flattenContent(body.content);
}

function flattenContent(
  elements: docs_v1.Schema$StructuralElement[]
): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.paragraph) {
      const line = (el.paragraph.elements ?? [])
        .map((e) => e.textRun?.content ?? "")
        .join("");
      parts.push(line);
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((cell) =>
          flattenContent(cell.content ?? []).trim()
        );
        parts.push(cells.join(" | "));
      }
      parts.push("");
    } else if (el.sectionBreak) {
      parts.push("\n");
    }
  }
  return parts.join("");
}

export interface CommentResult {
  index: number;
  body: string;
  status: "ok" | "error";
  commentId?: string;
  error?: string;
}

/**
 * Lists all open (non-deleted, non-resolved) comments on the doc.
 * Returns just the content strings for dedup purposes.
 */
export async function listExistingComments(docId: string): Promise<Set<string>> {
  const { drive } = getClients();
  const bodies = new Set<string>();
  let pageToken: string | undefined;

  do {
    const res = await drive.comments.list({
      fileId: docId,
      fields: "comments(content,deleted,resolved),nextPageToken",
      pageSize: 100,
      pageToken,
    });
    for (const c of res.data.comments ?? []) {
      if (!c.deleted && !c.resolved && c.content) {
        bodies.add(c.content.trim());
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return bodies;
}

/**
 * Posts an unanchored comment on a Google Doc via the Drive v3 comments API.
 */
export async function addComment(
  docId: string,
  body: string
): Promise<{ commentId: string }> {
  const { drive } = getClients();
  const res = await drive.comments.create({
    fileId: docId,
    fields: "id",
    requestBody: { content: body },
  });
  return { commentId: res.data.id ?? "" };
}

/**
 * Posts a reply on an existing comment. Falls back to a new top-level comment
 * if the target comment has been resolved or deleted.
 */
export async function replyToComment(
  docId: string,
  commentId: string,
  body: string
): Promise<{ replyId: string }> {
  const { drive } = getClients();
  try {
    const res = await drive.replies.create({
      fileId: docId,
      commentId,
      fields: "id",
      requestBody: { content: body },
    });
    return { replyId: res.data.id ?? "" };
  } catch (err: any) {
    if (err.code === 404) {
      const fallback = await addComment(docId, body);
      return { replyId: fallback.commentId };
    }
    throw err;
  }
}

export interface SuggestEdit {
  anchor: string;
  replacement: string;
}

export interface SuggestEditsResult {
  applied: number;
  skipped: { anchor: string; reason: string }[];
}

/**
 * Posts each proposed edit as a comment on the Google Doc so the owner can
 * review and apply them manually. The Google Docs API does not support
 * creating tracked-change suggestions programmatically, so comments are the
 * safest non-destructive alternative.
 *
 * Each edit's `anchor` identifies the text to change and `replacement` is the
 * proposed new text.
 */
export async function suggestEdits(
  docId: string,
  edits: SuggestEdit[]
): Promise<SuggestEditsResult> {
  if (!edits || edits.length === 0) return { applied: 0, skipped: [] };

  const { drive } = getClients();
  const skipped: { anchor: string; reason: string }[] = [];
  let applied = 0;

  for (const edit of edits) {
    if (!edit.anchor || !edit.anchor.trim()) {
      skipped.push({ anchor: edit.anchor, reason: "empty anchor" });
      continue;
    }

    const body = [
      `Suggested edit:`,
      ``,
      `Find: "${truncate(edit.anchor, 200)}"`,
      ``,
      `Replace with: "${truncate(edit.replacement, 500)}"`,
    ].join("\n");

    try {
      await drive.comments.create({
        fileId: docId,
        fields: "id",
        requestBody: { content: body },
      });
      applied++;
    } catch (err: any) {
      skipped.push({ anchor: edit.anchor, reason: err.message ?? "comment creation failed" });
    }
  }

  return { applied, skipped };
}

export interface DetailedComment {
  id: string;
  content: string;
  resolved: boolean;
  replies: { id: string; content: string; author: string }[];
}

export async function listOpenCommentsDetailed(
  docId: string
): Promise<DetailedComment[]> {
  const { drive } = getClients();
  const result: DetailedComment[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.comments.list({
      fileId: docId,
      fields:
        "comments(id,content,deleted,resolved,replies(id,content,author/displayName)),nextPageToken",
      pageSize: 100,
      includeDeleted: false,
      pageToken,
    });
    for (const c of res.data.comments ?? []) {
      if (c.deleted) continue;
      result.push({
        id: c.id ?? "",
        content: c.content ?? "",
        resolved: !!c.resolved,
        replies: (c.replies ?? []).map((r: any) => ({
          id: r.id ?? "",
          content: r.content ?? "",
          author: r.author?.displayName ?? "",
        })),
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return result;
}

export async function resolveComment(
  docId: string,
  commentId: string
): Promise<void> {
  const { drive } = getClients();
  await drive.comments.update({
    fileId: docId,
    commentId,
    requestBody: { resolved: true } as any,
    fields: "id",
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}


import fs from "fs";
import path from "path";
import { google, docs_v1, drive_v3 } from "googleapis";

// Monorepo root, not process.cwd() — npm workspace dev runs with cwd = server/.
const MONOREPO_ROOT = path.resolve(__dirname, "../../..");

function resolveServiceAccountPath(): string {
  const fromEnv = process.env.GOOGLE_SERVICE_ACCOUNT_PATH?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(MONOREPO_ROOT, fromEnv);
  }
  return path.resolve(MONOREPO_ROOT, "config/gcp-service-account.json");
}

const SA_PATH = resolveServiceAccountPath();

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

export interface AddCommentOptions {
  /** Verbatim substring from the doc; enables anchored threads when set. */
  quotedAnchor?: string;
}

/**
 * Posts a comment on a Google Doc via the Drive v3 comments API.
 * With `quotedAnchor`, sets `quotedFileContent` so Google Docs anchors the thread.
 */
export async function addComment(
  docId: string,
  body: string,
  options?: AddCommentOptions
): Promise<{ commentId: string }> {
  const { drive } = getClients();
  const trimmedQuote = options?.quotedAnchor?.trim();
  const requestBody: drive_v3.Schema$Comment = { content: body };
  if (trimmedQuote) {
    requestBody.quotedFileContent = {
      mimeType: "text/plain",
      value: truncateQuotedFileContent(trimmedQuote),
    };
  }
  const res = await drive.comments.create({
    fileId: docId,
    fields: "id",
    requestBody,
  });
  return { commentId: res.data.id ?? "" };
}

/**
 * Posts a reply on an existing comment thread.
 * Throws if the comment is not found — callers should log and skip rather than
 * falling back to a new top-level comment, which would be confusing.
 */
export async function replyToComment(
  docId: string,
  commentId: string,
  body: string
): Promise<{ replyId: string }> {
  const { drive } = getClients();
  const res = await drive.replies.create({
    fileId: docId,
    commentId,
    fields: "id",
    requestBody: { content: body },
  });
  return { replyId: res.data.id ?? "" };
}

export interface SuggestEdit {
  anchor: string;
  replacement: string;
}

export interface SuggestEditsResult {
  applied: number;
  skipped: { anchor: string; reason: string }[];
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function findAnchorIn(docText: string, anchor: string): boolean {
  return normalizeWhitespace(docText).includes(normalizeWhitespace(anchor));
}

/** Drive quoted text length guard (exact limit undocumented; stay conservative). */
const MAX_QUOTED_FILE_CONTENT_CHARS = 4096;

function truncateQuotedFileContent(value: string): string {
  if (value.length <= MAX_QUOTED_FILE_CONTENT_CHARS) return value;
  return value.slice(0, MAX_QUOTED_FILE_CONTENT_CHARS - 1) + "…";
}

/**
 * Returns true if `anchor` appears in `docText` (whitespace-normalized match).
 */
export function verifyAnchorInDoc(docText: string, anchor: string): boolean {
  if (!anchor.trim()) return false;
  return findAnchorIn(docText, anchor);
}

function escapeRegexChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns a contiguous substring of `docText` that matches `anchorHint` (exact
 * substring, or flexible whitespace between words). Use for `quotedFileContent`
 * so Drive anchors comments to visible text. Returns null if the hint cannot
 * be matched to the document.
 */
export function resolveQuotedSpan(
  docText: string,
  anchorHint: string
): string | null {
  const trimmed = anchorHint.trim();
  if (!trimmed) return null;
  if (!verifyAnchorInDoc(docText, trimmed)) return null;

  if (docText.includes(trimmed)) return trimmed;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const pattern = words.map((w) => escapeRegexChars(w)).join("\\s+");
  try {
    const re = new RegExp(pattern);
    const m = docText.match(re);
    if (m?.[0]) return m[0];
  } catch {
    return null;
  }
  return null;
}

/**
 * Posts each proposed edit as an anchored comment on the Google Doc.
 * The passage to replace is tied to the doc via Drive `quotedFileContent`
 * (the anchor); the comment body only carries the proposed replacement text.
 */
export async function suggestEdits(
  docId: string,
  edits: SuggestEdit[]
): Promise<SuggestEditsResult> {
  if (!edits || edits.length === 0) return { applied: 0, skipped: [] };

  const { drive } = getClients();
  const docText = await fetchDocText(docId);
  const skipped: { anchor: string; reason: string }[] = [];
  let applied = 0;

  for (const edit of edits) {
    if (!edit.anchor || !edit.anchor.trim()) {
      skipped.push({ anchor: edit.anchor, reason: "empty anchor" });
      continue;
    }

    const quote = resolveQuotedSpan(docText, edit.anchor);
    if (!quote) {
      skipped.push({ anchor: edit.anchor, reason: "anchor not found in doc" });
      continue;
    }

    const body = [
      `Proposed text:`,
      truncate(edit.replacement, 1500),
    ].join("\n");

    try {
      await drive.comments.create({
        fileId: docId,
        fields: "id",
        requestBody: {
          content: body,
          quotedFileContent: {
            mimeType: "text/plain",
            value: truncateQuotedFileContent(quote),
          },
        },
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


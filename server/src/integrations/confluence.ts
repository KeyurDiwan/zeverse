/**
 * Confluence Server / Data Center integration.
 *
 * Auth: Personal Access Token (PAT) via `Authorization: Bearer <token>`.
 * Only the operations needed for PRD analysis are implemented:
 *   - fetch page text
 *   - list existing comments (for dedup)
 *   - add a comment
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const url = (process.env.CONFLUENCE_BASE_URL ?? "").replace(/\/+$/, "");
  if (!url) {
    throw new Error(
      "CONFLUENCE_BASE_URL is not set. Add it to .env (e.g. https://confluence.example.com)."
    );
  }
  return url;
}

function getToken(): string {
  const token = process.env.CONFLUENCE_PAT_TOKEN ?? "";
  if (!token) {
    throw new Error(
      "CONFLUENCE_PAT_TOKEN is not set. Add a Confluence Personal Access Token to .env."
    );
  }
  return token;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

const CONFLUENCE_URL_RE =
  /(?:atlassian\.net\/wiki\/|confluence\.|\/display\/|\/spaces\/[^/]+\/pages\/|\/pages\/viewpage\.action)/i;

export function isConfluenceUrl(text: string): boolean {
  return CONFLUENCE_URL_RE.test(text);
}

// ---------------------------------------------------------------------------
// Page-ID extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a numeric Confluence page ID from a URL or bare ID.
 *
 * Supported shapes:
 *   /spaces/KEY/pages/12345/Title  →  12345
 *   ?pageId=12345                  →  12345
 *   /pages/viewpage.action?pageId=12345  →  12345
 *   bare numeric string            →  as-is
 */
export function extractPageId(urlOrId: string): string {
  const trimmed = urlOrId.trim().replace(/^<|>$/g, "");

  // /spaces/<KEY>/pages/<id>
  const spacesMatch = trimmed.match(/\/spaces\/[^/]+\/pages\/(\d+)/);
  if (spacesMatch) return spacesMatch[1];

  // ?pageId=<id>
  const queryMatch = trimmed.match(/[?&]pageId=(\d+)/);
  if (queryMatch) return queryMatch[1];

  // bare numeric
  if (/^\d+$/.test(trimmed)) return trimmed;

  throw new Error(
    `Cannot extract Confluence page ID from: ${urlOrId.slice(0, 120)}. ` +
      `Expected a URL containing /spaces/<KEY>/pages/<id> or ?pageId=<id>, or a bare numeric ID.`
  );
}

// ---------------------------------------------------------------------------
// HTML → plain text
// ---------------------------------------------------------------------------

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function confluenceGet(path: string): Promise<any> {
  const url = `${getBaseUrl()}/rest/api${path}`;
  const res = await fetch(url, { method: "GET", headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Confluence GET ${path} failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`
    );
  }
  return res.json();
}

async function confluencePost(path: string, body: unknown): Promise<any> {
  const url = `${getBaseUrl()}/rest/api${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Confluence POST ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`
    );
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchPageText(pageId: string): Promise<string> {
  const data = await confluenceGet(
    `/content/${pageId}?expand=body.view,version`
  );
  const html: string = data?.body?.view?.value ?? "";
  return htmlToPlainText(html);
}

export interface ConfluenceComment {
  id: string;
  body: string;
}

export async function listExistingComments(
  pageId: string
): Promise<Set<string>> {
  const bodies = new Set<string>();
  let start = 0;
  const limit = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await confluenceGet(
      `/content/${pageId}/child/comment?expand=body.view&limit=${limit}&start=${start}`
    );
    const results: any[] = data?.results ?? [];
    for (const c of results) {
      const text = htmlToPlainText(c?.body?.view?.value ?? "").trim();
      if (text) bodies.add(text);
    }
    if (results.length < limit) break;
    start += limit;
  }

  return bodies;
}

export async function listCommentsDetailed(
  pageId: string
): Promise<ConfluenceComment[]> {
  const comments: ConfluenceComment[] = [];
  let start = 0;
  const limit = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await confluenceGet(
      `/content/${pageId}/child/comment?expand=body.view&limit=${limit}&start=${start}`
    );
    const results: any[] = data?.results ?? [];
    for (const c of results) {
      comments.push({
        id: String(c.id ?? ""),
        body: htmlToPlainText(c?.body?.view?.value ?? "").trim(),
      });
    }
    if (results.length < limit) break;
    start += limit;
  }

  return comments;
}

export async function addComment(
  pageId: string,
  body: string
): Promise<{ commentId: string }> {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");

  const data = await confluencePost("/content", {
    type: "comment",
    container: { id: pageId, type: "page" },
    body: {
      storage: {
        value: `<p>${escaped}</p>`,
        representation: "storage",
      },
    },
  });

  return { commentId: String(data?.id ?? "") };
}

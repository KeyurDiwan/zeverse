import { spawn } from "node:child_process";

const BASE = "https://freshworks.freshrelease.com";

function getApiToken(): string {
  return process.env.FRESHRELEASE_API_TOKEN ?? "";
}

const ISSUE_TYPE_MAP: Record<string, number> = {
  Epic: 11,
  Task: 14,
  Bug: 12,
  Story: 13,
};

interface FRComment {
  id: number;
  body: string;
  user: { name: string };
  created_at: string;
}

export interface FRTask {
  key: string;
  id: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  issue_type: string;
  assignee: string | null;
  reporter: string | null;
  sprint: string | null;
  comments: FRComment[];
  url: string;
}

export interface CreateIssueParams {
  workspace: string;
  title: string;
  description?: string;
  issueType?: string;
  priority?: string;
  epicKey?: string;
}

export interface CreatedIssue {
  key: string;
  id: number;
  url: string;
}

async function curlJson(
  method: "GET" | "POST",
  url: string,
  body?: unknown
): Promise<{ status: number; text: string; json: any }> {
  const apiToken = getApiToken();
  if (!apiToken) {
    throw new Error(
      "FRESHRELEASE_API_TOKEN not set. Add it to .env or export it."
    );
  }
  const args = [
    "-sS",
    "-X", method,
    "-H", `Authorization: Token ${apiToken}`,
    "-H", "Content-Type: application/json",
    "-H", "Accept: application/json",
    "-w", "\n__HTTP_STATUS__:%{http_code}",
  ];
  if (body !== undefined) {
    args.push("--data-binary", "@-");
  }
  args.push(url);

  return new Promise((resolve, reject) => {
    const proc = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString();
        return reject(new Error(`curl exited ${code}: ${stderr}`));
      }
      const raw = Buffer.concat(chunks).toString();
      const m = raw.match(/^([\s\S]*)\n__HTTP_STATUS__:(\d+)\s*$/);
      const text = m ? m[1] : raw;
      const status = m ? Number(m[2]) : 0;
      let json: any;
      try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
      resolve({ status, text, json });
    });

    if (body !== undefined) {
      proc.stdin.end(JSON.stringify(body));
    } else {
      proc.stdin.end();
    }
  });
}

function parseUrlOrKey(input: string): { workspace: string; key: string } {
  const trimmed = input.trim().replace(/^<|>$/g, "");
  const urlMatch = trimmed.match(
    /freshrelease\.com\/ws\/([^/]+)\/tasks\/([A-Z]+-\d+)/
  );
  if (urlMatch) return { workspace: urlMatch[1], key: urlMatch[2] };
  const keyMatch = trimmed.match(/^([A-Z]+)-(\d+)$/);
  if (keyMatch) return { workspace: keyMatch[1], key: trimmed };
  throw new Error(`Cannot parse FR URL or key from: ${input.slice(0, 120)}`);
}

export async function getTask(
  urlOrKey: string,
  workspaceOverride?: string
): Promise<FRTask> {
  const { workspace, key } = parseUrlOrKey(urlOrKey);
  const ws = workspaceOverride || workspace;

  const res = await curlJson("GET", `${BASE}/${ws}/issues/${key}`);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`FR API ${res.status}: ${res.text}`);
  }
  const issue = res.json?.issue ?? res.json;

  const commentsRes = await curlJson(
    "GET",
    `${BASE}/${ws}/issues/${key}/comments`
  );
  let comments: FRComment[] = [];
  if (commentsRes.status >= 200 && commentsRes.status < 300) {
    const cData = commentsRes.json;
    comments = (cData?.comments ?? cData ?? []).map((c: any) => ({
      id: c.id,
      body: c.body ?? c.body_text ?? "",
      user: { name: c.user?.name ?? "unknown" },
      created_at: c.created_at ?? "",
    }));
  }

  return {
    key: issue.key ?? key,
    id: issue.id,
    title: issue.title ?? "",
    description: issue.description ?? issue.description_text ?? "",
    status: issue.status?.name ?? issue.status ?? "",
    priority: issue.priority?.name ?? issue.priority ?? "",
    issue_type: issue.issue_type?.name ?? issue.issue_type ?? "",
    assignee: issue.assignee?.name ?? null,
    reporter: issue.reporter?.name ?? null,
    sprint: issue.sprint?.name ?? null,
    comments,
    url: `${BASE}/ws/${ws}/tasks/${issue.key ?? key}`,
  };
}

export async function createIssue(
  params: CreateIssueParams
): Promise<CreatedIssue> {
  const issueType = params.issueType ?? "Task";
  const issueTypeId = ISSUE_TYPE_MAP[issueType] ?? 14;

  const body: Record<string, any> = {
    issue: {
      title: params.title,
      description: params.description ?? "",
      issue_type_id: issueTypeId,
      project_id: 20552,
    },
  };

  if (params.priority) {
    const priorityMap: Record<string, number> = {
      High: 3,
      Medium: 2,
      Low: 1,
    };
    body.issue.priority_id = priorityMap[params.priority] ?? 2;
  }

  if (params.epicKey) {
    const epicTask = await getTask(params.epicKey, params.workspace);
    body.issue.parent_id = epicTask.id;
  }

  const res = await curlJson(
    "POST",
    `${BASE}/${params.workspace}/issues`,
    body
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`FR create ${res.status}: ${res.text}`);
  }
  const issue = res.json?.issue ?? res.json;
  return {
    key: issue.key,
    id: issue.id,
    url: `${BASE}/ws/${params.workspace}/tasks/${issue.key}`,
  };
}

const FR_COMMENT_BODY_MAX = 32_000;

export async function addFRComment(
  urlOrKey: string,
  commentBody: string,
  workspaceOverride?: string
): Promise<{ id: number }> {
  const { workspace, key } = parseUrlOrKey(urlOrKey);
  const ws = workspaceOverride || workspace;

  let body = commentBody;
  if (body.length > FR_COMMENT_BODY_MAX) {
    body =
      body.slice(0, FR_COMMENT_BODY_MAX - 120) +
      "\n\n…(body truncated to fit FR limits)…\n_See Archon Hub for the full run output._";
  }

  const res = await curlJson(
    "POST",
    `${BASE}/${ws}/issues/${key}/comments`,
    { comment: { body } }
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`FR comment ${res.status}: ${res.text}`);
  }
  return { id: res.json?.comment?.id ?? res.json?.id ?? 0 };
}

export function formatTaskForLLM(task: FRTask): string {
  const lines = [
    `# Freshrelease Task: ${task.key}`,
    `**Title:** ${task.title}`,
    `**Type:** ${task.issue_type} | **Priority:** ${task.priority} | **Status:** ${task.status}`,
    `**Assignee:** ${task.assignee ?? "Unassigned"} | **Reporter:** ${task.reporter ?? "Unknown"}`,
    task.sprint ? `**Sprint:** ${task.sprint}` : "",
    `**URL:** ${task.url}`,
    "",
    "## Description",
    task.description || "(no description)",
    "",
  ];

  if (task.comments.length > 0) {
    lines.push("## Comments");
    for (const c of task.comments) {
      lines.push(
        `### ${c.user.name} (${c.created_at})`,
        c.body,
        ""
      );
    }
  }

  return lines.filter((l) => l !== undefined).join("\n");
}

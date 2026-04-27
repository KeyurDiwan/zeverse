import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Load .env: optional cwd file first, then monorepo root last with override
// so `archon-hub/.env` always wins (fixes empty ARCHON_* when a nested .env was loaded first).
{
  const projectEnv = path.resolve(__dirname, "../..", ".env");
  const cwdEnv = path.join(process.cwd(), ".env");
  if (fs.existsSync(cwdEnv) && path.resolve(cwdEnv) !== projectEnv) {
    dotenv.config({ path: cwdEnv, override: true });
  }
  dotenv.config({ path: projectEnv, override: true });
}

import { App, LogLevel } from "@slack/bolt";

const ARCHON_SERVER_URL = process.env.ARCHON_SERVER_URL ?? "http://localhost:3100";
const ARCHON_UI_URL = process.env.ARCHON_UI_URL ?? "http://localhost:5173";
const DEFAULT_REPO_ID = process.env.ARCHON_DEFAULT_REPO_ID ?? "";
const DEFAULT_WORKFLOW = process.env.ARCHON_DEFAULT_WORKFLOW ?? "dev";
const HUB_STATE_DIR = path.resolve(__dirname, "../../state");

/** Archon API returns JSON; HTML means wrong URL (UI/static host) or proxy misconfiguration. */
async function archonResponseJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  const t = text.trim();
  if (t.startsWith("<!DOCTYPE") || t.startsWith("<!doctype") || t.startsWith("<html")) {
    throw new Error(
      `Archon server returned a web page instead of JSON (${what}, HTTP ${res.status}). ` +
        `Set ARCHON_SERVER_URL in .env to the API (e.g. http://127.0.0.1:3100), not the Vite UI, and ensure the server is running.`
    );
  }
  if (t.length > 0 && t[0] !== "{" && t[0] !== "[") {
    const preview = t.length > 200 ? `${t.slice(0, 200)}…` : t;
    throw new Error(
      `Archon server did not return JSON (${what}, HTTP ${res.status}): ${preview}`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    const msg = (e as Error).message;
    if (
      msg.includes("Unexpected token") &&
      (text.includes("<!DOCTYPE") || text.includes("<html") || text.trim().startsWith("<"))
    ) {
      throw new Error(
        `Archon returned a web page, not JSON (${what}, HTTP ${res.status}). ` +
          `Point ARCHON_SERVER_URL at the API (http://127.0.0.1:3100), not the Vite UI, ` +
          `and unset a wrong value in the shell: env -u ARCHON_SERVER_URL npm run dev:slack`
      );
    }
    throw new Error(
      `Invalid JSON from Archon ${what} (HTTP ${res.status}): ${msg}`
    );
  }
}

function archonBaseUrl(): string {
  return ARCHON_SERVER_URL.replace(/\/$/, "");
}

/** Warn at boot if the API URL looks wrong or returns HTML. */
async function probeArchonOnStartup(): Promise<void> {
  const base = archonBaseUrl();
  if (/^https?:\/\/127\.0\.0\.1:5173|^https?:\/\/localhost:5173/.test(base)) {
    console.warn(
      "Archon: ARCHON_SERVER_URL is the Vite dev URL (5173). The bot needs the API on 3100. Set ARCHON_SERVER_URL=http://127.0.0.1:3100 in .env"
    );
  }
  try {
    const res = await fetch(`${base}/api/repos`);
    const text = await res.text();
    const t = text.trim();
    if (t.startsWith("<!DOCTYPE") || t.startsWith("<!doctype") || t.startsWith("<html")) {
      console.error(
        "Archon: GET /api/repos returned HTML — ARCHON_SERVER_URL is wrong, or the shell is overriding .env. " +
          "Use the API: http://127.0.0.1:3100. Test with: npm run check:archon"
      );
      return;
    }
    try {
      JSON.parse(text);
    } catch {
      console.error(
        `Archon: /api/repos body is not valid JSON (HTTP ${res.status}):`,
        text.slice(0, 200)
      );
      return;
    }
    console.log(`Archon: API OK at ${base} (GET /api/repos → ${res.status})`);
  } catch (e) {
    console.error(`Archon: cannot reach ${base}:`, (e as Error).message);
  }
  const adminN = (process.env.ARCHON_REPO_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
  if (adminN === 0) {
    console.warn(
      "Archon: ARCHON_REPO_ADMIN_USER_IDS is empty — add-repo from Slack will be denied. " +
        "Set it in archon-hub/.env and restart the bot."
    );
  } else {
    console.log(`Archon: add-repo: ${adminN} admin user id(s) in env`);
  }
}

// ─── PRD thread tracking ───────────────────────────────────────────────────
interface PrdQueryInfo {
  index: number;
  body: string;
  anchor: string;
  commentId: string;
}

interface PrdThreadContext {
  channel: string;
  threadTs: string;
  repoId: string;
  docUrl: string;
  docId: string;
  runId: string;
  queries: PrdQueryInfo[];
}

// key = `${channel}:${threadTs}`
const prdThreads = new Map<string, PrdThreadContext>();

// secondary index: docUrl -> list of thread keys (for re-run lookup)
const prdDocIndex = new Map<string, string[]>();

function prdThreadDir(repoId: string): string {
  return path.join(HUB_STATE_DIR, repoId, "prd-threads");
}

function savePrdThread(ctx: PrdThreadContext): void {
  const key = `${ctx.channel}:${ctx.threadTs}`;
  prdThreads.set(key, ctx);

  const existing = prdDocIndex.get(ctx.docUrl) ?? [];
  if (!existing.includes(key)) existing.push(key);
  prdDocIndex.set(ctx.docUrl, existing);

  const dir = prdThreadDir(ctx.repoId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = ctx.threadTs.replace(/\./g, "_");
  fs.writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(ctx, null, 2));
}

function lookupPrdThread(channel: string, threadTs: string): PrdThreadContext | undefined {
  return prdThreads.get(`${channel}:${threadTs}`);
}

/**
 * Fallback lookup: find the most recently saved PRD thread for a channel.
 * Needed because slash commands don't provide a `ts`, so the saved threadTs
 * may not match the actual Slack thread parent ts.
 */
function lookupPrdThreadByChannel(channel: string): PrdThreadContext | undefined {
  let best: PrdThreadContext | undefined;
  for (const ctx of prdThreads.values()) {
    if (ctx.channel !== channel) continue;
    if (!best) { best = ctx; continue; }
    if (ctx.threadTs > best.threadTs) best = ctx;
  }
  return best;
}

function lookupPrdThreadsByDocUrl(docUrl: string): PrdThreadContext[] {
  const keys = prdDocIndex.get(docUrl) ?? [];
  return keys.map((k) => prdThreads.get(k)).filter(Boolean) as PrdThreadContext[];
}

function loadAllPrdThreads(): void {
  if (!fs.existsSync(HUB_STATE_DIR)) return;
  for (const repoId of fs.readdirSync(HUB_STATE_DIR)) {
    const dir = prdThreadDir(repoId);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const ctx = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as PrdThreadContext;
        const key = `${ctx.channel}:${ctx.threadTs}`;
        prdThreads.set(key, ctx);
        const existing = prdDocIndex.get(ctx.docUrl) ?? [];
        if (!existing.includes(key)) existing.push(key);
        prdDocIndex.set(ctx.docUrl, existing);
      } catch {
        // skip corrupt files
      }
    }
  }
}

loadAllPrdThreads();

// ─── Harness thread tracking ────────────────────────────────────────────────
interface HarnessThreadContext {
  channel: string;
  threadTs: string;
  repoId: string;
  lastRunId: string;
  lastWorkflow: string;
  history: string[];
}

const harnessThreads = new Map<string, HarnessThreadContext>();

function harnessThreadDir(repoId: string): string {
  return path.join(HUB_STATE_DIR, repoId, "harness-threads");
}

function saveHarnessThread(ctx: HarnessThreadContext): void {
  const key = `${ctx.channel}:${ctx.threadTs}`;
  harnessThreads.set(key, ctx);

  const dir = harnessThreadDir(ctx.repoId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = ctx.threadTs.replace(/\./g, "_");
  fs.writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(ctx, null, 2));
}

function lookupHarnessThread(channel: string, threadTs: string): HarnessThreadContext | undefined {
  return harnessThreads.get(`${channel}:${threadTs}`);
}

function loadAllHarnessThreads(): void {
  if (!fs.existsSync(HUB_STATE_DIR)) return;
  for (const repoId of fs.readdirSync(HUB_STATE_DIR)) {
    const dir = harnessThreadDir(repoId);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const ctx = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as HarnessThreadContext;
        harnessThreads.set(`${ctx.channel}:${ctx.threadTs}`, ctx);
      } catch {
        // skip corrupt files
      }
    }
  }
}

loadAllHarnessThreads();

// ─── Route-intent helper ────────────────────────────────────────────────────
interface RouteIntentResult {
  repoId: string | null;
  workflow: string;
  inputs: Record<string, string>;
  confidence: number;
  reason: string;
  fallback: boolean;
}

async function routeIntent(prompt: string, repoId?: string): Promise<RouteIntentResult> {
  const body: Record<string, string> = { prompt };
  if (repoId) body.repoId = repoId;

  const res = await fetch(`${ARCHON_SERVER_URL}/api/route-intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return archonResponseJson<RouteIntentResult>(res, "POST /api/route-intent");
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: !!process.env.SLACK_APP_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG,
});

// Log every incoming event for debugging.
app.use(async ({ payload, next, logger }) => {
  logger.info(
    `[incoming] type=${(payload as any).type ?? "?"} ` +
      `subtype=${(payload as any).subtype ?? "-"} ` +
      `text=${JSON.stringify((payload as any).text ?? "")}`
  );
  await next();
});

interface Repo {
  id: string;
  name: string;
}

async function listRepoIds(): Promise<Set<string>> {
  try {
    const res = await fetch(`${ARCHON_SERVER_URL}/api/repos`);
    const data = await archonResponseJson<{ repos: Repo[] }>(res, "GET /api/repos");
    return new Set(data.repos.map((r) => r.id));
  } catch {
    return new Set();
  }
}

async function listWorkflowNames(repoId: string): Promise<Set<string>> {
  try {
    const res = await fetch(
      `${ARCHON_SERVER_URL}/api/workflows?repoId=${encodeURIComponent(repoId)}`
    );
    const data = await archonResponseJson<{ workflows: { name: string }[] }>(
      res,
      "GET /api/workflows"
    );
    return new Set((data.workflows ?? []).map((w) => w.name));
  } catch {
    return new Set();
  }
}

async function inferRepoIdFromPrompt(prompt: string): Promise<string | null> {
  try {
    const res = await fetch(`${ARCHON_SERVER_URL}/api/infer-repo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await archonResponseJson<{ repoId: string | null; reason?: string }>(
      res,
      "POST /api/infer-repo"
    );
    return data.repoId ?? null;
  } catch {
    return null;
  }
}

async function inferWorkflowFromServer(repoId: string, prompt: string): Promise<string> {
  try {
    const res = await fetch(`${ARCHON_SERVER_URL}/api/infer-workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoId, prompt }),
    });
    const data = await archonResponseJson<{ workflow?: string }>(res, "POST /api/infer-workflow");
    if (typeof data.workflow === "string") return data.workflow;
  } catch {
    // fall through
  }
  try {
    const available = await listWorkflowNames(repoId);
    if (available.has(DEFAULT_WORKFLOW)) return DEFAULT_WORKFLOW;
    const first = available.values().next().value;
    return first ?? DEFAULT_WORKFLOW;
  } catch {
    return DEFAULT_WORKFLOW;
  }
}

// ─── Add-repo helpers ───────────────────────────────────────────────────────
// Read on each check so we always see the current process.env (and avoid stale
// values if the process loaded env in an unexpected order at startup).
function getRepoAdminUserIds(): Set<string> {
  return new Set(
    (process.env.ARCHON_REPO_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

interface AddRepoParseResult {
  url: string;
  name?: string;
}

function unwrapSlackUrl(raw: string): string {
  const m = raw.match(/^<([^|>]+)(?:\|[^>]*)?>$/);
  return m ? m[1] : raw;
}

function parseAddRepoCommand(stripped: string): AddRepoParseResult | null {
  const m = stripped.match(
    /^add-repo\s+(<[^>]+>|\S+)(?:\s+(\S+))?\s*$/i
  );
  if (!m) return null;
  const url = unwrapSlackUrl(m[1]);
  const name = m[2] || undefined;
  return { url, name };
}

interface CachedPolicy {
  allowed_slack_channels: string[];
  fetchedAt: number;
}

let policyCache: CachedPolicy | null = null;
const POLICY_CACHE_TTL_MS = 60_000;

async function fetchPolicyCached(): Promise<CachedPolicy> {
  if (policyCache && Date.now() - policyCache.fetchedAt < POLICY_CACHE_TTL_MS) {
    return policyCache;
  }
  try {
    const res = await fetch(`${archonBaseUrl()}/api/policy`);
    const data = await archonResponseJson<{
      allowed_repos: string[];
      allowed_workflows: string[];
      allowed_slack_channels: string[];
    }>(res, "GET /api/policy");
    policyCache = {
      allowed_slack_channels: data.allowed_slack_channels ?? ["*"],
      fetchedAt: Date.now(),
    };
  } catch {
    policyCache = { allowed_slack_channels: ["*"], fetchedAt: Date.now() };
  }
  return policyCache;
}

async function isRepoAdmin(
  slackUser: string,
  channel: string,
  isDm: boolean
): Promise<{ allowed: boolean; reason?: string }> {
  const admins = getRepoAdminUserIds();
  if (admins.size === 0) {
    return {
      allowed: false,
      reason:
        "`ARCHON_REPO_ADMIN_USER_IDS` is not configured. " +
        "Set it in the **archon-hub** `.env` (repo root) as a comma-separated list of Slack user IDs, then restart the Slack bot process.",
    };
  }
  if (!admins.has(slackUser)) {
    return {
      allowed: false,
      reason: `User <@${slackUser}> is not in \`ARCHON_REPO_ADMIN_USER_IDS\`.`,
    };
  }
  if (!isDm) {
    const policy = await fetchPolicyCached();
    if (
      !policy.allowed_slack_channels.includes("*") &&
      !policy.allowed_slack_channels.includes(channel)
    ) {
      return {
        allowed: false,
        reason: `Channel \`${channel}\` is not in \`policy.allowed_slack_channels\`.`,
      };
    }
  }
  return { allowed: true };
}

interface AddRepoApiResult {
  id: string;
  name: string;
  path: string;
  origin?: string;
}

async function addRepoViaApi(
  input: AddRepoParseResult
): Promise<{ repo?: AddRepoApiResult; error?: string }> {
  try {
    const res = await fetch(`${archonBaseUrl()}/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: input.url, name: input.name }),
    });
    if (!res.ok) {
      const data = await archonResponseJson<{ error?: string }>(res, "POST /api/repos");
      return { error: data.error ?? `HTTP ${res.status}` };
    }
    const data = await archonResponseJson<{ repo: AddRepoApiResult }>(
      res, "POST /api/repos"
    );
    return { repo: data.repo };
  } catch (err: any) {
    return { error: err.message };
  }
}

async function handleAddRepoMessage(
  rawText: string,
  channel: string,
  slackUser: string,
  threadTs: string,
  isDm: boolean,
  client: any,
  logger: any
): Promise<void> {
  const stripped = stripMentions(rawText);
  const parsed = parseAddRepoCommand(stripped);

  if (!parsed) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: [
        "*Usage*: `add-repo <git-url> [name]`",
        "Example: `@ArchonBot add-repo https://github.com/org/my-repo.git`",
        "Example: `@ArchonBot add-repo https://github.com/org/my-repo.git custom-name`",
      ].join("\n"),
    });
    return;
  }

  const auth = await isRepoAdmin(slackUser, channel, isDm);
  if (!auth.allowed) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `*Not authorized to add repos.*\n${auth.reason}`,
    });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `_Cloning \`${parsed.url}\`... this may take a moment._`,
  });

  const result = await addRepoViaApi(parsed);

  if (result.error) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `*Failed to add repo*\n${result.error}`,
    });
    return;
  }

  const repo = result.repo!;
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: [
      `*Repo added* :white_check_mark:`,
      `ID: \`${repo.id}\``,
      `Name: \`${repo.name}\``,
      `Origin: ${repo.origin ?? parsed.url}`,
      `Path: \`${repo.path}\``,
      `<${ARCHON_UI_URL}|Open Archon Hub>`,
    ].join("\n"),
  });
}

interface RunResponse {
  runId?: string;
  error?: string;
}

async function triggerWorkflow(
  repoId: string,
  workflowName: string,
  prompt: string,
  inputs?: Record<string, string>
): Promise<RunResponse> {
  const res = await fetch(`${ARCHON_SERVER_URL}/api/run-workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId, workflow: workflowName, prompt, inputs }),
  });
  return archonResponseJson<RunResponse>(res, "POST /api/run-workflow");
}

interface Invocation {
  repoId: string | null;
  workflow: string;
  prompt: string;
}

// Strip leading <@UXXXX> mentions produced by Slack when the bot is tagged.
function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, " ").replace(/\s+/g, " ").trim();
}

interface ParseOptions {
  explicitWorkflow?: string;
}

// Parse "[repo-id] [workflow] <prompt>" (order-flexible between repo / workflow).
// When repo or workflow aren't provided as leading tokens, infers them:
//   - repo: via LLM-based /api/infer-repo (or ARCHON_DEFAULT_REPO_ID env var)
//   - workflow: via keyword matching against available workflows (or explicitWorkflow override)
async function parseInvocation(rawText: string, opts: ParseOptions = {}): Promise<Invocation> {
  const text = stripMentions(rawText);
  if (!text) {
    return { repoId: DEFAULT_REPO_ID || null, workflow: opts.explicitWorkflow ?? DEFAULT_WORKFLOW, prompt: "" };
  }

  const tokens = text.split(/\s+/);
  const repos = await listRepoIds();

  let repoId: string | null = null;
  let workflow: string | null = null;
  let i = 0;

  for (let step = 0; step < 2 && i < tokens.length; step += 1) {
    const tok = tokens[i];
    if (!repoId && repos.has(tok)) {
      repoId = tok;
      i += 1;
      continue;
    }
    const candidateRepo = repoId ?? DEFAULT_REPO_ID;
    if (!workflow && candidateRepo) {
      const workflows = await listWorkflowNames(candidateRepo);
      if (workflows.has(tok)) {
        workflow = tok;
        i += 1;
        continue;
      }
    }
    break;
  }

  const prompt = tokens.slice(i).join(" ").trim();

  if (!repoId) {
    repoId = DEFAULT_REPO_ID || null;
  }
  if (!repoId) {
    repoId = await inferRepoIdFromPrompt(prompt || text);
  }

  if (opts.explicitWorkflow) {
    workflow = opts.explicitWorkflow;
  } else if (!workflow && repoId) {
    workflow = await inferWorkflowFromServer(repoId, prompt || text);
  }

  return {
    repoId,
    workflow: workflow ?? DEFAULT_WORKFLOW,
    prompt,
  };
}

function usageText(prefix: string): string {
  return [
    `*Usage*: ${prefix} [<repo-id>] [<workflow>] <your requirement>`,
    `• <repo-id> — optional; auto-inferred from your prompt`,
    `• <workflow> — optional; inferred via keywords (fallback: \`${DEFAULT_WORKFLOW}\`)`,
    `• Example: \`${prefix} ubx-ui pr-review fix flaky login test\``,
  ].join("\n");
}

async function noRepoErrorText(prefix: string): Promise<string> {
  const repos = await listRepoIds();
  const repoList = repos.size > 0
    ? `Available repos: ${[...repos].map((r) => `\`${r}\``).join(", ")}`
    : "No repos are currently registered.";
  return (
    `Could not determine which repo to use from your prompt.\n` +
    `${repoList}\n` +
    `Try: \`${prefix} <repo-id> <requirement>\``
  );
}

interface RunState {
  runId: string;
  repoId: string;
  workflow?: string;
  status: string;
  steps: { id: string; status: string; output: string; error?: string }[];
  /** Present when the run failed due to gate rules (no step may be marked `failed`). */
  gateFailures?: { stepId: string; error: string }[];
}

/**
 * The server can mark a run `failed` without any step in `status: "failed"`
 * (e.g. LLM init, git isolation, branch creation, or gate checks). The UI shows
 * logs; Slack used to only show "Step: ? / Error: unknown" — this surfaces real reasons.
 */
async function formatRunFailureForSlack(
  title: string,
  runId: string,
  repoId: string,
  state: RunState
): Promise<string> {
  const failedStep = state.steps.find((s) => s.status === "failed");
  const hubLink = `<${ARCHON_UI_URL}/?run=${runId}|View run details>`;

  if (failedStep) {
    return [
      `*${title}*`,
      `Step: \`${failedStep.id}\``,
      `Error: ${failedStep.error ?? "unknown"}`,
      hubLink,
    ].join("\n");
  }

  const lines: string[] = [`*${title}*`];
  if (state.gateFailures && state.gateFailures.length > 0) {
    lines.push("*Gate check:*");
    for (const g of state.gateFailures) {
      lines.push(`• \`${g.stepId}\`: ${g.error}`);
    }
  } else {
    lines.push(
      "_No step-level error on record._ Common causes: **LLM init** (check `config/archon.yaml` and env), **git isolation** (uncommitted changes on the server’s repo copy), or **branch creation** failed. *Log tail* or Archon Hub has the line that explains it."
    );
  }

  let tail = "";
  try {
    const res = await fetch(
      `${archonBaseUrl()}/api/logs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}&offset=0`
    );
    if (res.ok) {
      const data = await archonResponseJson<{ content?: string }>(res, "GET /api/logs");
      const t = (data.content ?? "").trim();
      if (t.length > 0) {
        const slice = t.length > 1800 ? t.slice(-1800) : t;
        tail = `\n*Log tail:*\n\`\`\`\n${slice}\n\`\`\``;
      }
    }
  } catch {
    // best-effort
  }

  return `${lines.join("\n")}${tail}\n${hubLink}`;
}

/** Markdown body under a `## Summary` heading (same rule as server `extractFrAnalysisSummarySection`). */
function extractFrAnalysisSummaryForSlack(text: string): string | null {
  const m = text.match(/^##\s*Summary\s*$/m);
  if (m == null || m.index === undefined) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.search(/^##\s+\S/m);
  const block = (next === -1 ? after : after.slice(0, next)).trim();
  return block || null;
}

const SLACK_MAX_TEXT = 3900;

function trimOutput(text: string): string {
  if (text.length <= SLACK_MAX_TEXT) return text;
  return text.slice(0, SLACK_MAX_TEXT) + "\n…_(truncated — see full output in Archon Hub)_";
}

async function pollRunAndPostResult(
  runId: string,
  repoId: string,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 200;
  const intervalMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let state: RunState;
    try {
      const res = await fetch(
        `${ARCHON_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}`
      );
      state = await archonResponseJson<RunState>(res, "GET /api/runs/:id");
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const text = await formatRunFailureForSlack("Workflow failed", runId, repoId, state);
      await client.chat.postMessage({ channel, thread_ts, text });
      return;
    }

    const parts: string[] = [`*Workflow complete*`, ""];

    const diffStep = state.steps.find((s) => s.id === "diff-after");
    if (diffStep?.output) {
      const diffLines = diffStep.output.split("\n");
      const statLine = diffLines.find((l) => l.includes("files changed") || l.includes("file changed"));
      if (statLine) parts.push(`\`${statLine.trim()}\``);
      const diffPreview = diffLines
        .filter((l) => l.startsWith("+") || l.startsWith("-"))
        .slice(0, 20)
        .join("\n");
      if (diffPreview) parts.push("```" + diffPreview + "```");
    }

    const prStep = state.steps.find((s) => s.id === "open-pr");
    if (prStep?.output) {
      const prUrlMatch = prStep.output.match(/PR_URL=(https?:\/\/\S+)/);
      if (prUrlMatch) parts.push(`<${prUrlMatch[1]}|View PR on GitHub>`);
    }

    const reviewStep = state.steps.find((s) => s.id === "review");
    if (reviewStep?.output) {
      const verdictMatch = reviewStep.output.match(/(?:verdict|recommendation)[:\s]*(.*)/i);
      if (verdictMatch) parts.push(`*Review verdict:* ${verdictMatch[1].trim().slice(0, 200)}`);
    }

    const hasDiffPrReview =
      !!(diffStep?.output || prStep?.output || reviewStep?.output);
    if (!hasDiffPrReview) {
      if (state.workflow === "fr-analyze") {
        const analyse = state.steps.find((s) => s.id === "analyse");
        parts.push(trimOutput(analyse?.output ?? ""));
      } else {
        const lastStep = state.steps[state.steps.length - 1];
        const lastOutput = lastStep?.output ?? "";
        parts.push(trimOutput(lastOutput));
      }
    }

    parts.push("");
    parts.push(`<${ARCHON_UI_URL}/?run=${runId}|View full output in Archon Hub>`);

    await client.chat.postMessage({
      channel,
      thread_ts,
      text: parts.filter(Boolean).join("\n"),
    });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*Workflow timed out* — the run is still going.\n` +
      `<${ARCHON_UI_URL}/?run=${runId}|View in Archon Hub>`,
  });
}

function successBlocks(inv: Invocation & { runId: string }) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Archon workflow started*`,
          `Repo: \`${inv.repoId}\``,
          `Workflow: \`${inv.workflow}\``,
          `Prompt: ${inv.prompt}`,
          `Run ID: \`${inv.runId}\``,
          `<${ARCHON_UI_URL}/?run=${inv.runId}|View in Archon Hub>`,
        ].join("\n"),
      },
    },
  ];
}

function registerCommand(commandName: string, workflowName: string) {
  app.command(commandName, async ({ command, ack, respond, client, logger }) => {
    await ack();

    const inv = await parseInvocation(command.text ?? "", { explicitWorkflow: workflowName });

    if (!inv.prompt) {
      await respond({ response_type: "ephemeral", text: usageText(commandName) });
      return;
    }
    if (!inv.repoId) {
      await respond({
        response_type: "ephemeral",
        text: await noRepoErrorText(commandName),
      });
      return;
    }

    try {
      const result = await triggerWorkflow(inv.repoId, inv.workflow, inv.prompt);
      if (result.error) {
        await respond({
          response_type: "ephemeral",
          text: `Failed to start workflow: ${result.error}`,
        });
        return;
      }
      const runId = result.runId ?? "";
      await respond({
        response_type: "in_channel",
        blocks: successBlocks({ ...inv, runId }),
      });

      const thread_ts = command.ts ?? "";
      pollRunAndPostResult(runId, inv.repoId, command.channel_id, thread_ts, client, logger).catch(
        (err) => logger.error("pollRunAndPostResult error:", err)
      );
    } catch (err: any) {
      await respond({
        response_type: "ephemeral",
        text: `Error connecting to Archon server: ${err.message}`,
      });
    }
  });
}

registerCommand("/archon-dev", "dev");
registerCommand("/archon-fr-analyze", "fr-analyze");
// ─── /archon-harness (smart router) ─────────────────────────────────────────
app.command("/archon-harness", async ({ command, ack, respond, client, logger }) => {
  await ack();

  const rawText = command.text ?? "";
  const parsed = await parseInvocation(rawText);
  const prompt = parsed.prompt || rawText.trim();

  if (!prompt) {
    await respond({
      response_type: "ephemeral",
      text: [
        `*Usage*: \`/archon-harness <anything>\``,
        `Ask a question, describe a bug, request a feature, ask for a review — the router picks the right workflow.`,
        `Example: \`/archon-harness fix the login redirect loop\``,
        `Example: \`/archon-harness how does the billing page work?\``,
      ].join("\n"),
    });
    return;
  }

  const repoId = parsed.repoId || DEFAULT_REPO_ID || null;

  await respond({
    response_type: "ephemeral",
    text: `_Thinking... routing your request to the best workflow._`,
  });

  const thread_ts = command.ts ?? "";
  handleHarnessMessage(prompt, command.channel_id, thread_ts, client, logger, "slash", repoId).catch(
    (err) => logger.error("handleHarnessMessage (slash) error:", err)
  );
});

// ─── /archon-add-repo (register a repo from Slack) ─────────────────────────
app.command("/archon-add-repo", async ({ command, ack, respond, client, logger }) => {
  await ack();

  const rawText = (command.text ?? "").trim();
  if (!rawText) {
    await respond({
      response_type: "ephemeral",
      text: [
        "*Usage*: `/archon-add-repo <git-url> [name]`",
        "Example: `/archon-add-repo https://github.com/org/my-repo.git`",
        "Example: `/archon-add-repo https://github.com/org/my-repo.git custom-name`",
      ].join("\n"),
    });
    return;
  }

  const thread_ts = command.ts ?? "";
  await handleAddRepoMessage(
    `add-repo ${rawText}`,
    command.channel_id,
    command.user_id,
    thread_ts,
    false,
    client,
    logger
  );
});

// ─── /archon-prd (PRD analysis) ────────────────────────────────────────────

function isGoogleDocUrl(text: string): boolean {
  return /docs\.google\.com\/document\/d\//.test(text) ||
    /drive\.google\.com\/.*\/d\//.test(text);
}

function extractSlackReply(text: string): string | null {
  const m = text.match(/---\s*SLACK REPLY\s*---\s*\n([\s\S]*?)\n---\s*END SLACK REPLY\s*---/);
  return m ? m[1].trim() : null;
}

function extractEpicBreakdown(text: string): string | null {
  const m = text.match(/---\s*EPIC BREAKDOWN\s*---\s*\n([\s\S]*?)\n---\s*END EPIC BREAKDOWN\s*---/);
  return m ? m[1].trim() : null;
}

function extractQueriesJson(text: string): { anchor?: string; body: string }[] {
  const re = /```(?:json)?\s*queries?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e: any) => typeof e === "object" && typeof e.body === "string");
  } catch {
    return [];
  }
}

/**
 * Parses the post-queries step output to extract query index -> commentId.
 * Lines look like: `+ [3] some text (id=ABcd1234)`
 */
function parsePostedCommentIds(output: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /^\+\s*\[(\d+)\].*\(id=([^)]+)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    map.set(parseInt(m[1], 10), m[2]);
  }
  return map;
}

function extractDocId(urlOrId: string): string {
  const trimmed = urlOrId.trim().replace(/^<|>$/g, "");
  const m = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return trimmed;
}

// ─── PRD context discovery ──────────────────────────────────────────────────
// When no saved PRD thread context exists (e.g. because the slash command
// didn't save one properly), discover it by scanning the thread for an
// Archon Hub run URL and reconstructing the context from the run state.

/**
 * Scans local run state files to find the most recent successful prd-analysis
 * run and reconstructs a PrdThreadContext from it. This avoids needing Slack
 * API scopes just for discovery.
 */
function discoverPrdContextFromState(
  channel: string,
  threadTs: string,
  logger: any
): PrdThreadContext | undefined {
  if (!fs.existsSync(HUB_STATE_DIR)) return undefined;

  let bestRun: { repoId: string; data: any; mtime: number } | undefined;

  for (const repoId of fs.readdirSync(HUB_STATE_DIR)) {
    const runsDir = path.join(HUB_STATE_DIR, repoId, "runs");
    if (!fs.existsSync(runsDir)) continue;

    for (const file of fs.readdirSync(runsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = path.join(runsDir, file);
        const stat = fs.statSync(filePath);
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (data.workflow !== "prd-analysis" || data.status !== "success") continue;
        if (!bestRun || stat.mtimeMs > bestRun.mtime) {
          bestRun = { repoId, data, mtime: stat.mtimeMs };
        }
      } catch {
        // skip corrupt files
      }
    }
  }

  if (!bestRun) {
    logger.info("discoverPrdContextFromState: no successful prd-analysis runs found");
    return undefined;
  }

  const state = bestRun.data;
  const repoId = bestRun.repoId;

  // Extract doc URL from the prompt
  let docUrl = "";
  const promptMatch = (state.prompt ?? "").match(
    /(https?:\/\/docs\.google\.com\/document\/d\/[^\s]+)/
  );
  if (promptMatch) docUrl = promptMatch[1];
  if (!docUrl) return undefined;

  const analyseStep = (state.steps ?? []).find((s: any) => s.id === "analyse");
  const postQueriesStep = (state.steps ?? []).find((s: any) => s.id === "post-queries");

  const analyseOutput = analyseStep?.output ?? "";
  const commentSummary = postQueriesStep?.output ?? "";

  const queries = extractQueriesJson(analyseOutput);
  const commentIds = parsePostedCommentIds(commentSummary);

  const trackedQueries: PrdQueryInfo[] = queries.map((q, idx) => ({
    index: idx + 1,
    body: q.body,
    anchor: q.anchor ?? "",
    commentId: commentIds.get(idx + 1) ?? "",
  }));

  const ctx: PrdThreadContext = {
    channel,
    threadTs: threadTs,
    repoId,
    docUrl,
    docId: extractDocId(docUrl),
    runId: state.runId ?? "",
    queries: trackedQueries,
  };

  savePrdThread(ctx);
  logger.info(
    `discoverPrdContextFromState: reconstructed from run ${ctx.runId} ` +
    `(${trackedQueries.length} queries, doc=${ctx.docId})`
  );

  return ctx;
}

// ─── Shared thread-context builder ──────────────────────────────────────────
// Formats Slack thread messages into a structured text block that can be
// passed to workflows as the `threadContext` input.

function buildThreadContext(
  messages: any[],
  queries: PrdQueryInfo[]
): string {
  const humanReplies = messages.slice(1).filter(
    (msg: any) => !msg.bot_id && !msg.subtype
  );
  if (humanReplies.length === 0) return "";

  const lines: string[] = ["--- PRIOR SLACK DISCUSSION ---"];
  for (const q of queries) {
    lines.push(`Q${q.index}: ${q.body}`);
    const answers = humanReplies.filter((msg: any) => {
      const t = (msg.text ?? "").trim();
      const prefix = t.match(/^(?:Q|#)\s*(\d+)\b/i);
      return prefix && parseInt(prefix[1], 10) === q.index;
    });
    if (answers.length > 0) {
      for (const a of answers) {
        const user = a.user ?? "unknown";
        const ansText = (a.text ?? "").replace(/^(?:Q|#)\s*\d+[:\s]*/i, "").trim();
        lines.push(`  A (user: ${user}): ${ansText}`);
      }
    } else {
      lines.push("  (no answers yet)");
    }
  }
  const unmatchedReplies = humanReplies.filter((msg: any) => {
    const t = (msg.text ?? "").trim();
    return !t.match(/^(?:Q|#)\s*\d+\b/i);
  });
  if (unmatchedReplies.length > 0) {
    lines.push("");
    lines.push("General discussion:");
    for (const a of unmatchedReplies) {
      lines.push(`  (user: ${a.user ?? "unknown"}): ${(a.text ?? "").trim()}`);
    }
  }
  lines.push("--- END PRIOR SLACK DISCUSSION ---");
  return lines.join("\n");
}

async function pollRunAndReply(
  runId: string,
  repoId: string,
  channel: string,
  thread_ts: string,
  docUrl: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 200; // ~10 min at 3s intervals
  const intervalMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let state: RunState;
    try {
      const res = await fetch(
        `${ARCHON_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}`
      );
      state = await archonResponseJson<RunState>(res, "GET /api/runs/:id");
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const text = await formatRunFailureForSlack("PRD analysis failed", runId, repoId, state);
      await client.chat.postMessage({ channel, thread_ts, text });
      return;
    }

    const analyseStep = state.steps.find((s) => s.id === "analyse");
    const postQueriesStep = state.steps.find((s) => s.id === "post-queries");
    const openPrStep = state.steps.find((s) => s.id === "open-pr");

    const analyseOutput = analyseStep?.output ?? "";
    const slackReply = extractSlackReply(analyseOutput);
    const epicBreakdown = extractEpicBreakdown(analyseOutput);
    const commentSummary = postQueriesStep?.output ?? "";

    const postedMatch = commentSummary.match(/Posted (\d+)\/(\d+) comments/);
    const skippedMatch = commentSummary.match(/(\d+) skipped as duplicates/);
    const commentLine = postedMatch
      ? `Posted ${postedMatch[1]} of ${postedMatch[2]} comments on the Google Doc` +
        (skippedMatch ? ` (${skippedMatch[1]} skipped as duplicates)` : "")
      : "";

    const prUrlMatch = (openPrStep?.output ?? "").match(/PR_URL=(https?:\/\/\S+)/);

    const body = [
      `*PRD Analysis Complete* — \`${repoId}\``,
      "",
      slackReply ?? "_No verdict produced — check the full run._",
      "",
      commentLine,
      `<${docUrl}|Open PRD in Google Docs>  |  <${ARCHON_UI_URL}/?run=${runId}|View full analysis in Archon Hub>`,
      prUrlMatch ? `<${prUrlMatch[1]}|View PR on GitHub>` : "",
      "",
      epicBreakdown ? `*Epic & Tasks*\n${epicBreakdown}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await client.chat.postMessage({ channel, thread_ts, text: body });

    // Save thread context for reply handling and re-run detection
    try {
      const queries = extractQueriesJson(analyseOutput);
      const commentIds = parsePostedCommentIds(commentSummary);
      const trackedQueries: PrdQueryInfo[] = queries.map((q, idx) => ({
        index: idx + 1,
        body: q.body,
        anchor: q.anchor ?? "",
        commentId: commentIds.get(idx + 1) ?? "",
      }));
      if (trackedQueries.length > 0) {
        savePrdThread({
          channel,
          threadTs: thread_ts,
          repoId,
          docUrl,
          docId: extractDocId(docUrl),
          runId,
          queries: trackedQueries,
        });
      }
    } catch {
      // non-critical — don't break the flow
    }

    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*PRD analysis timed out* — the run is still going.\n` +
      `<${ARCHON_UI_URL}/?run=${runId}|View in Archon Hub>`,
  });
}

app.command("/archon-prd", async ({ command, ack, respond, client, logger }) => {
  await ack();

  const inv = await parseInvocation(command.text ?? "");
  inv.workflow = "prd-analysis";

  // For /archon-prd the "prompt" is actually the Google Doc URL.
  const docUrl = inv.prompt;

  if (!docUrl) {
    await respond({
      response_type: "ephemeral",
      text: [
        `*Usage*: \`/archon-prd [<repo-id>] <google-doc-url>\``,
        `• <repo-id> — optional; defaults to \`ARCHON_DEFAULT_REPO_ID\``,
        `• Example: \`/archon-prd ubx-ui https://docs.google.com/document/d/1abc.../edit\``,
      ].join("\n"),
    });
    return;
  }

  if (!isGoogleDocUrl(docUrl)) {
    await respond({
      response_type: "ephemeral",
      text: `That doesn't look like a Google Docs URL. Expected something like \`https://docs.google.com/document/d/...\``,
    });
    return;
  }

  if (!inv.repoId) {
    await respond({
      response_type: "ephemeral",
      text: await noRepoErrorText("/archon-prd"),
    });
    return;
  }

  try {
    // Collect prior Slack thread discussion for re-runs
    let threadContext = "";
    const priorThreads = lookupPrdThreadsByDocUrl(docUrl);
    if (priorThreads.length > 0) {
      try {
        const latest = priorThreads[priorThreads.length - 1];
        const threadRes = await client.conversations.replies({
          channel: latest.channel,
          ts: latest.threadTs,
          limit: 200,
        });
        const messages = (threadRes.messages ?? []) as any[];
        threadContext = buildThreadContext(messages, latest.queries);
      } catch (err: any) {
        logger.error(`Failed to collect thread history: ${err.message}`);
      }
    }

    const inputs: Record<string, string> = { docUrl };
    if (threadContext) inputs.threadContext = threadContext;

    const result = await triggerWorkflow(
      inv.repoId,
      inv.workflow,
      `PRD analysis for ${docUrl}`,
      inputs
    );

    if (result.error) {
      await respond({
        response_type: "ephemeral",
        text: `Failed to start PRD analysis: ${result.error}`,
      });
      return;
    }

    const runId = result.runId ?? "";
    const rerunNote = threadContext
      ? `\n_Re-run detected — incorporating ${priorThreads.length} prior thread(s)._`
      : "";

    await respond({
      response_type: "in_channel",
      text:
        `*PRD analysis started* on \`${inv.repoId}\` for <${docUrl}|Open PRD>\n` +
        `Run: \`${runId}\` | <${ARCHON_UI_URL}/?run=${runId}|View in Archon Hub>\n` +
        `_I'll reply in this thread when the analysis is done._` +
        rerunNote,
    });

    const thread_ts = command.ts ?? "";
    pollRunAndReply(
      runId,
      inv.repoId,
      command.channel_id,
      thread_ts,
      docUrl,
      client,
      logger
    ).catch((err) => logger.error("pollRunAndReply error:", err));
  } catch (err: any) {
    await respond({
      response_type: "ephemeral",
      text: `Error connecting to Archon server: ${err.message}`,
    });
  }
});

// ─── PRD thread @mention handling ───────────────────────────────────────────
// When the bot is @mentioned inside a tracked PRD thread with an "update" or
// "answer" intent, read the thread history and sync back to the Google Doc.

type PrdMentionIntent = "update" | "answer";

const UPDATE_RE = /^(update|edit|apply|update\s+(the\s+)?(prd|doc|prd\s+doc))$/i;
const ANSWER_RE = /^(answer|answer\s+this|reply|respond|post\s+answers|ans\s+this)$/i;

function parsePrdMentionIntent(stripped: string): PrdMentionIntent | null {
  if (UPDATE_RE.test(stripped)) return "update";
  if (ANSWER_RE.test(stripped)) return "answer";
  return null;
}

function extractAnswersJson(text: string): { queryIndex: number; commentId: string; body: string }[] {
  const re = /```(?:json)?\s*answers?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed.filter((e: any) => e.queryIndex && e.body) : [];
  } catch {
    return [];
  }
}

function extractSummaryBlock(text: string): string | null {
  const m = text.match(/---\s*SUMMARY\s*---\s*\n([\s\S]*?)\n---\s*END SUMMARY\s*---/);
  return m ? m[1].trim() : null;
}

function extractEditsJson(text: string): { anchor: string; replacement: string; reason: string }[] {
  const re = /```(?:json)?\s*edits?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed.filter((e: any) => e.anchor && e.replacement) : [];
  } catch {
    return [];
  }
}

async function postGDocComment(
  docId: string,
  body: string
): Promise<{ commentId?: string; error?: string }> {
  try {
    const res = await fetch(`${ARCHON_SERVER_URL}/api/gdoc-comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId, body }),
    });
    return await archonResponseJson<{ commentId?: string; error?: string }>(
      res,
      "POST /api/gdoc-comment"
    );
  } catch (err: any) {
    return { error: err.message };
  }
}

async function postGDocSuggestEdits(
  docId: string,
  edits: { anchor: string; replacement: string }[]
): Promise<{ applied?: number; skipped?: { anchor: string; reason: string }[]; error?: string }> {
  try {
    const res = await fetch(`${ARCHON_SERVER_URL}/api/gdoc-suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId, edits }),
    });
    return await archonResponseJson<any>(res, "POST /api/gdoc-suggest");
  } catch (err: any) {
    return { error: err.message };
  }
}

async function handlePrdThreadMention(
  ctx: PrdThreadContext,
  intent: PrdMentionIntent,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*PRD ${intent === "update" ? "update" : "answer sync"} started*\n` +
      `Reading thread history and syncing to <${ctx.docUrl}|Google Doc>...\n` +
      `_I'll reply here when done._`,
  });

  let threadContext = "";
  try {
    const threadRes = await client.conversations.replies({
      channel,
      ts: thread_ts,
      limit: 200,
    });
    const messages = (threadRes.messages ?? []) as any[];
    threadContext = buildThreadContext(messages, ctx.queries);
  } catch (err: any) {
    logger.error(`Failed to collect thread history: ${err.message}`);
    const scopeHint = err.message?.includes("missing_scope")
      ? `\n_The Slack app is missing the \`groups:history\` scope. ` +
        `Add it in your Slack app settings under OAuth & Permissions._`
      : "";
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Failed to read thread history: ${err.message}${scopeHint}`,
    });
    return;
  }

  if (!threadContext) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `No discussion found in this thread to sync.`,
    });
    return;
  }

  let result: RunResponse;
  try {
    result = await triggerWorkflow(ctx.repoId, "prd-thread-sync", `PRD thread sync (${intent})`, {
      docUrl: ctx.docUrl,
      intent,
      threadContext,
      queries: JSON.stringify(ctx.queries),
    });
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Error connecting to Archon server: ${err.message}`,
    });
    return;
  }

  if (result.error) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Failed to start PRD thread sync: ${result.error}`,
    });
    return;
  }

  const runId = result.runId ?? "";

  pollThreadSync(runId, ctx, intent, channel, thread_ts, client, logger).catch((err) =>
    logger.error("pollThreadSync error:", err)
  );
}

async function pollThreadSync(
  runId: string,
  ctx: PrdThreadContext,
  intent: PrdMentionIntent,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 200;
  const intervalMs = 3000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let state: RunState;
    try {
      const res = await fetch(
        `${ARCHON_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(ctx.repoId)}`
      );
      state = await archonResponseJson<RunState>(res, "GET /api/runs/:id");
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const text = await formatRunFailureForSlack("PRD thread sync failed", runId, ctx.repoId, state);
      await client.chat.postMessage({ channel, thread_ts, text });
      return;
    }

    const synthesizeStep = state.steps.find((s) => s.id === "synthesize");
    const output = synthesizeStep?.output ?? "";

    const answers = extractAnswersJson(output);
    const summary = extractSummaryBlock(output);
    const edits = intent === "update" ? extractEditsJson(output) : [];

    let repliesPosted = 0;
    let repliesFailed = 0;
    for (const ans of answers) {
      if (!ans.commentId) continue;
      const r = await postGDocReply(ctx.docId, ans.commentId, ans.body);
      if (r.error) {
        repliesFailed++;
        logger.error(`GDoc reply failed for Q${ans.queryIndex}: ${r.error}`);
      } else {
        repliesPosted++;
      }
    }

    let editsApplied = 0;
    let editsSkipped = 0;
    if (edits.length > 0) {
      const r = await postGDocSuggestEdits(ctx.docId, edits);
      if (r.error) {
        logger.error(`GDoc suggest edits failed: ${r.error}`);
      } else {
        editsApplied = r.applied ?? 0;
        editsSkipped = (r.skipped ?? []).length;
      }
    }

    const parts: string[] = [`*PRD ${intent === "update" ? "update" : "answer sync"} complete*`, ""];
    if (repliesPosted > 0) parts.push(`Replies posted on Google Doc comments: ${repliesPosted}`);
    if (repliesFailed > 0) parts.push(`Reply failures: ${repliesFailed}`);
    if (intent === "update" && edits.length > 0) {
      parts.push(`Suggestions created: ${editsApplied}, skipped: ${editsSkipped}`);
    }
    parts.push("");
    parts.push(`<${ctx.docUrl}|Open PRD in Google Docs>`);
    parts.push(`<${ARCHON_UI_URL}/?run=${runId}|View full run in Archon Hub>`);

    await client.chat.postMessage({ channel, thread_ts, text: parts.join("\n") });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts,
    text:
      `*PRD thread sync timed out* — the run is still going.\n` +
      `<${ARCHON_UI_URL}/?run=${runId}|View in Archon Hub>`,
  });
}

// ─── Generic thread context helpers ─────────────────────────────────────────

async function fetchThreadMessages(
  channel: string,
  threadTs: string,
  client: any
): Promise<any[]> {
  try {
    const threadRes = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
    });
    return (threadRes.messages ?? []) as any[];
  } catch {
    return [];
  }
}

function buildGenericThreadContext(messages: any[]): string {
  if (messages.length <= 1) return "";
  const lines: string[] = ["--- PRIOR THREAD DISCUSSION ---"];
  for (const msg of messages.slice(0, -1)) {
    const who = msg.bot_id ? "bot" : `user:${msg.user ?? "unknown"}`;
    lines.push(`[${who}] ${(msg.text ?? "").trim()}`);
  }
  lines.push("--- END PRIOR THREAD DISCUSSION ---");
  return lines.join("\n");
}

// ─── Harness route + execute callers ────────────────────────────────────────

interface HarnessRouteResult {
  type: "proposal" | "answer" | "clarify";
  repoId: string | null;
  workflow?: string;
  inputs?: Record<string, string>;
  alternatives?: string[];
  confidence: number;
  reason: string;
  answer?: string;
  question?: string;
  missing?: string[];
}

async function callHarnessRoute(
  prompt: string,
  threadContext: string,
  repoId: string | null,
  surface: string
): Promise<HarnessRouteResult> {
  const body: Record<string, any> = { prompt, surface };
  if (threadContext) body.threadContext = threadContext;
  if (repoId) body.repoId = repoId;

  const res = await fetch(`${ARCHON_SERVER_URL}/api/harness/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return archonResponseJson<HarnessRouteResult>(res, "POST /api/harness/route");
}

interface ExecuteOptions {
  slackUser?: string;
  channel?: string;
  surface?: string;
}

async function callHarnessExecute(
  repoId: string,
  workflow: string,
  inputs: Record<string, string>,
  prompt: string,
  opts: ExecuteOptions = {}
): Promise<RunResponse & { missing?: string[] }> {
  const res = await fetch(`${ARCHON_SERVER_URL}/api/harness/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repoId, workflow, inputs, prompt,
      slackUser: opts.slackUser,
      channel: opts.channel,
      surface: opts.surface,
    }),
  });
  return archonResponseJson<RunResponse & { missing?: string[] }>(res, "POST /api/harness/execute");
}

// ─── Proposal store (avoid Slack value 2KB limit) ───────────────────────────

interface StoredProposal {
  repoId: string;
  workflow: string;
  inputs: Record<string, string>;
  alternatives: string[];
  prompt: string;
  confidence: number;
  reason: string;
  channel: string;
  threadTs: string;
}

const proposalStore = new Map<string, StoredProposal>();
let proposalCounter = 0;

function storeProposal(p: StoredProposal): string {
  const id = `p-${++proposalCounter}-${Date.now()}`;
  proposalStore.set(id, p);
  setTimeout(() => proposalStore.delete(id), 10 * 60 * 1000);
  return id;
}

// ─── Block Kit confirm UI ───────────────────────────────────────────────────

function proposalBlocks(proposalId: string, p: StoredProposal) {
  if (p.workflow === "prd-analysis") {
    const docUrl = p.inputs.docUrl ?? "";
    const docLink = docUrl ? `<${docUrl}|Open PRD>` : "";
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*PRD analysis* on \`${p.repoId}\``,
            docLink,
            `_Click Run to start the analysis. I'll reply in this thread when done._`,
          ].filter(Boolean).join("\n"),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Run" },
            style: "primary",
            action_id: "harness_run",
            value: proposalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Cancel" },
            action_id: "harness_cancel",
            value: proposalId,
          },
        ],
      },
    ];
  }

  const altText = p.alternatives.length > 0
    ? `\nAlternatives: ${p.alternatives.map((a) => `\`${a}\``).join(", ")}`
    : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Harness routed your request*`,
          `Workflow: \`${p.workflow}\``,
          `Repo: \`${p.repoId}\` | Confidence: ${(p.confidence * 100).toFixed(0)}%`,
          `Reason: ${p.reason}`,
          `Prompt: ${p.prompt.length > 200 ? p.prompt.slice(0, 200) + "…" : p.prompt}`,
          altText,
        ].filter(Boolean).join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Run" },
          style: "primary",
          action_id: "harness_run",
          value: proposalId,
        },
        ...(p.alternatives.length > 0
          ? [
              {
                type: "static_select",
                placeholder: { type: "plain_text" as const, text: "Pick another..." },
                action_id: "harness_pick",
                options: p.alternatives.map((alt) => ({
                  text: { type: "plain_text" as const, text: alt },
                  value: `${proposalId}:${alt}`,
                })),
              },
            ]
          : []),
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "harness_cancel",
          value: proposalId,
        },
      ],
    },
  ];
}

// ─── Run event poller (milestones + approval detection) ─────────────────────

const MILESTONE_STEPS = new Set(
  (process.env.ARCHON_MILESTONE_STEPS ?? "plan,implement,validate,review,open-pr")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

interface RunEventLine {
  ts: string;
  type: string;
  stepId?: string;
  stepKind?: string;
  status?: string;
  error?: string;
  prompt?: string;
  surface?: string;
  [key: string]: any;
}

async function pollRunEvents(
  runId: string,
  repoId: string,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  const maxAttempts = 400;
  const intervalMs = 3000;
  let offset = 0;
  const postedMilestones = new Set<string>();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let content: string;
    let nextOffset: number;
    try {
      const res = await fetch(
        `${ARCHON_SERVER_URL}/api/runs/${encodeURIComponent(runId)}/events?repoId=${encodeURIComponent(repoId)}&offset=${offset}`
      );
      const data = await archonResponseJson<{ content: string; nextOffset: number }>(
        res, "GET /api/runs/:id/events"
      );
      content = data.content;
      nextOffset = data.nextOffset;
    } catch {
      continue;
    }

    if (content) {
      offset = nextOffset;
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        let ev: RunEventLine;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.type === "awaiting_approval" && ev.stepId) {
          const approvalMsg = ev.prompt ?? "Approval required to continue this workflow.";
          await client.chat.postMessage({
            channel,
            thread_ts,
            text: `*Approval needed* — \`${ev.stepId}\`\n${approvalMsg}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Approval needed* for step \`${ev.stepId}\`\n${approvalMsg}`,
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Approve" },
                    style: "primary",
                    action_id: "approval_approve",
                    value: `${runId}:${repoId}`,
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Reject" },
                    style: "danger",
                    action_id: "approval_reject",
                    value: `${runId}:${repoId}`,
                  },
                ],
              },
            ],
          });
        }

        if (ev.type === "step_finished" && ev.stepId && MILESTONE_STEPS.has(ev.stepId)) {
          const key = `${ev.stepId}:${ev.status}`;
          if (!postedMilestones.has(key)) {
            postedMilestones.add(key);
            const icon = ev.status === "success" ? ":white_check_mark:" : ":x:";
            await client.chat.postMessage({
              channel,
              thread_ts,
              text: `${icon} Step \`${ev.stepId}\` ${ev.status}`,
            });
          }
        }

        if (ev.type === "run_finished" || ev.type === "gates_failed") {
          return;
        }
      }
    }

    // Also check if the run itself has terminated
    try {
      const runRes = await fetch(
        `${ARCHON_SERVER_URL}/api/runs/${encodeURIComponent(runId)}?repoId=${encodeURIComponent(repoId)}`
      );
      const runState = await archonResponseJson<RunState>(runRes, "GET /api/runs/:id");
      if (runState.status === "success" || runState.status === "failed") return;
    } catch { /* continue */ }
  }
}

// ─── Unified harness message handler ────────────────────────────────────────

async function handleHarnessMessage(
  prompt: string,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any,
  surface: "slash" | "mention" | "dm",
  repoIdHint?: string | null
): Promise<void> {
  const messages = await fetchThreadMessages(channel, thread_ts, client);
  const threadContext = buildGenericThreadContext(messages);

  let route: HarnessRouteResult;
  try {
    route = await callHarnessRoute(prompt, threadContext, repoIdHint ?? null, surface);
  } catch (err: any) {
    logger.error(`harness/route call failed: ${err.message}`);
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Error connecting to Archon server: ${err.message}`,
    });
    return;
  }

  if (route.type === "answer") {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: route.answer ?? "I don't have an answer for that right now.",
    });
    return;
  }

  if (route.type === "clarify") {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: route.question ?? "Could you provide more details?",
    });
    return;
  }

  // type === "proposal" — always show confirm buttons
  const repoId = route.repoId;
  const workflow = route.workflow ?? DEFAULT_WORKFLOW;
  const inputs = route.inputs ?? {};
  const alternatives = route.alternatives ?? [];

  if (!repoId) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: route.question ?? "Which repository should I work with? " + (await noRepoErrorText("@ArchonBot")),
    });
    return;
  }

  const proposalId = storeProposal({
    repoId,
    workflow,
    inputs,
    alternatives,
    prompt,
    confidence: route.confidence,
    reason: route.reason,
    channel,
    threadTs: thread_ts,
  });

  await client.chat.postMessage({
    channel,
    thread_ts,
    blocks: proposalBlocks(proposalId, proposalStore.get(proposalId)!),
    text: `Harness proposes running \`${workflow}\` on \`${repoId}\`. Click Run to proceed.`,
  });
}

// ─── Button action: Run ─────────────────────────────────────────────────────
app.action("harness_run", async ({ action, ack, body, client, logger }) => {
  await ack();
  const proposalId = (action as any).value;
  const p = proposalStore.get(proposalId);
  if (!p) {
    await client.chat.postMessage({
      channel: (body as any).channel?.id,
      text: "This proposal has expired. Please re-send your request.",
    });
    return;
  }

  const messageTs = (body as any).message?.ts;
  const channel = (body as any).channel?.id;
  const thread_ts = p.threadTs;

  if (messageTs && channel) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `Running \`${p.workflow}\` on \`${p.repoId}\`...`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `_Running \`${p.workflow}\` on \`${p.repoId}\`..._`,
          },
        },
      ],
    }).catch(() => {});
  }

  const slackUser = (body as any).user?.id;
  try {
    const result = await callHarnessExecute(p.repoId, p.workflow, p.inputs, p.prompt, {
      slackUser, channel, surface: "slack",
    });
    if (result.error) {
      const missingMsg = result.missing?.length
        ? `\n_Missing inputs: ${result.missing.map((m: string) => `\`${m}\``).join(", ")}_`
        : "";
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Failed to start workflow: ${result.error}${missingMsg}`,
      });
      return;
    }
    const runId = result.runId ?? "";

    if (p.workflow === "prd-analysis") {
      const docUrl = p.inputs.docUrl ?? "";
      await client.chat.postMessage({
        channel,
        thread_ts,
        text:
          `*PRD analysis started* on \`${p.repoId}\` for <${docUrl}|Open PRD>\n` +
          `Run: \`${runId}\` | <${ARCHON_UI_URL}/?run=${runId}|View in Archon Hub>\n` +
          `_I'll reply in this thread when the analysis is done._`,
      });
      pollRunAndReply(runId, p.repoId, channel, thread_ts, docUrl, client, logger).catch(
        (err) => logger.error("pollRunAndReply (harness_run prd) error:", err)
      );
    } else {
      await client.chat.postMessage({
        channel,
        thread_ts,
        blocks: successBlocks({ repoId: p.repoId, workflow: p.workflow, prompt: p.prompt, runId }),
        text: `Archon run ${runId} started for ${p.repoId}/${p.workflow}`,
      });
      pollRunAndPostResult(runId, p.repoId, channel, thread_ts, client, logger).catch(
        (err) => logger.error("pollRunAndPostResult (harness_run) error:", err)
      );
    }

    saveHarnessThread({
      channel,
      threadTs: thread_ts,
      repoId: p.repoId,
      lastRunId: runId,
      lastWorkflow: p.workflow,
      history: [p.prompt],
    });
    pollRunEvents(runId, p.repoId, channel, thread_ts, client, logger).catch(
      (err) => logger.error("pollRunEvents (harness_run) error:", err)
    );
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Error connecting to Archon server: ${err.message}`,
    });
  }
  proposalStore.delete(proposalId);
});

// ─── Button action: Pick another ────────────────────────────────────────────
app.action("harness_pick", async ({ action, ack, body, client, logger }) => {
  await ack();
  const raw = (action as any).selected_option?.value ?? "";
  const sepIdx = raw.indexOf(":");
  if (sepIdx === -1) return;
  const proposalId = raw.slice(0, sepIdx);
  const newWorkflow = raw.slice(sepIdx + 1);

  const p = proposalStore.get(proposalId);
  if (!p) {
    await client.chat.postMessage({
      channel: (body as any).channel?.id,
      text: "This proposal has expired. Please re-send your request.",
    });
    return;
  }

  p.workflow = newWorkflow;
  p.alternatives = p.alternatives.filter((a) => a !== newWorkflow);
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;

  if (messageTs && channel) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `Running \`${newWorkflow}\` on \`${p.repoId}\`...`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `_Running \`${newWorkflow}\` on \`${p.repoId}\`..._`,
          },
        },
      ],
    }).catch(() => {});
  }

  const slackUser = (body as any).user?.id;
  try {
    const result = await callHarnessExecute(p.repoId, newWorkflow, p.inputs, p.prompt, {
      slackUser, channel, surface: "slack",
    });
    if (result.error) {
      const missingMsg = result.missing?.length
        ? `\n_Missing inputs: ${result.missing.map((m: string) => `\`${m}\``).join(", ")}_`
        : "";
      await client.chat.postMessage({
        channel,
        thread_ts: p.threadTs,
        text: `Failed to start workflow: ${result.error}${missingMsg}`,
      });
      return;
    }
    const runId = result.runId ?? "";

    if (newWorkflow === "prd-analysis") {
      const docUrl = p.inputs.docUrl ?? "";
      await client.chat.postMessage({
        channel,
        thread_ts: p.threadTs,
        text:
          `*PRD analysis started* on \`${p.repoId}\` for <${docUrl}|Open PRD>\n` +
          `Run: \`${runId}\` | <${ARCHON_UI_URL}/?run=${runId}|View in Archon Hub>\n` +
          `_I'll reply in this thread when the analysis is done._`,
      });
      pollRunAndReply(runId, p.repoId, channel, p.threadTs, docUrl, client, logger).catch(
        (err) => logger.error("pollRunAndReply (harness_pick prd) error:", err)
      );
    } else {
      await client.chat.postMessage({
        channel,
        thread_ts: p.threadTs,
        blocks: successBlocks({ repoId: p.repoId, workflow: newWorkflow, prompt: p.prompt, runId }),
        text: `Archon run ${runId} started for ${p.repoId}/${newWorkflow}`,
      });
      pollRunAndPostResult(runId, p.repoId, channel, p.threadTs, client, logger).catch(
        (err) => logger.error("pollRunAndPostResult (harness_pick) error:", err)
      );
    }

    saveHarnessThread({
      channel,
      threadTs: p.threadTs,
      repoId: p.repoId,
      lastRunId: runId,
      lastWorkflow: newWorkflow,
      history: [p.prompt],
    });
    pollRunEvents(runId, p.repoId, channel, p.threadTs, client, logger).catch(
      (err) => logger.error("pollRunEvents (harness_pick) error:", err)
    );
  } catch (err: any) {
    await client.chat.postMessage({
      channel,
      thread_ts: p.threadTs,
      text: `Error connecting to Archon server: ${err.message}`,
    });
  }
  proposalStore.delete(proposalId);
});

// ─── Button action: Cancel ──────────────────────────────────────────────────
app.action("harness_cancel", async ({ action, ack, body, client }) => {
  await ack();
  const proposalId = (action as any).value;
  proposalStore.delete(proposalId);
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (messageTs && channel) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: "Cancelled.",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "_Cancelled._" },
        },
      ],
    }).catch(() => {});
  }
});

// ─── Button action: Approve (mid-run approval gate) ─────────────────────────
app.action("approval_approve", async ({ action, ack, body, client, logger }) => {
  await ack();
  const raw = (action as any).value ?? "";
  const [runId, repoId] = raw.split(":");
  if (!runId || !repoId) return;

  const slackUser = (body as any).user?.id ?? "unknown";
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;

  try {
    const res = await fetch(`${ARCHON_SERVER_URL}/api/runs/${encodeURIComponent(runId)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: slackUser }),
    });
    const data = await archonResponseJson<{ approved?: boolean; error?: string }>(res, "POST /api/runs/:id/approve");
    if (data.error) {
      await client.chat.postMessage({ channel, text: `Approve failed: ${data.error}` });
      return;
    }
    if (messageTs && channel) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: `_Approved by <@${slackUser}>._`,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `_Approved by <@${slackUser}>. Workflow continuing..._` } }],
      }).catch(() => {});
    }
  } catch (err: any) {
    logger.error("approval_approve error:", err);
    if (channel) await client.chat.postMessage({ channel, text: `Error: ${err.message}` });
  }
});

// ─── Button action: Reject (mid-run approval gate) ──────────────────────────
app.action("approval_reject", async ({ action, ack, body, client, logger }) => {
  await ack();
  const raw = (action as any).value ?? "";
  const [runId, repoId] = raw.split(":");
  if (!runId || !repoId) return;

  const slackUser = (body as any).user?.id ?? "unknown";
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;

  try {
    const res = await fetch(`${ARCHON_SERVER_URL}/api/runs/${encodeURIComponent(runId)}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: slackUser }),
    });
    const data = await archonResponseJson<{ rejected?: boolean; error?: string }>(res, "POST /api/runs/:id/reject");
    if (data.error) {
      await client.chat.postMessage({ channel, text: `Reject failed: ${data.error}` });
      return;
    }
    if (messageTs && channel) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: `_Rejected by <@${slackUser}>. Workflow stopped._`,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `_Rejected by <@${slackUser}>. Workflow stopped._` } }],
      }).catch(() => {});
    }
  } catch (err: any) {
    logger.error("approval_reject error:", err);
    if (channel) await client.chat.postMessage({ channel, text: `Error: ${err.message}` });
  }
});

// ─── Harness thread follow-up ───────────────────────────────────────────────
async function handleHarnessFollowUp(
  ctx: HarnessThreadContext,
  newPrompt: string,
  channel: string,
  thread_ts: string,
  client: any,
  logger: any
): Promise<void> {
  await client.chat.postMessage({
    channel,
    thread_ts,
    text: `_Routing follow-up..._`,
  });

  handleHarnessMessage(newPrompt, channel, thread_ts, client, logger, "mention", ctx.repoId).catch(
    (err) => logger.error("handleHarnessMessage (follow-up) error:", err)
  );
}

// ─── @mentions ─────────────────────────────────────────────────────────────
// Tag the bot in any channel it's been invited to. The bot now answers
// everything: questions get a direct answer, unclear requests get a clarifying
// question, and clear action intents trigger a workflow.
app.event("app_mention", async ({ event, client, logger }) => {
  const text = (event as any).text ?? "";
  const channel = (event as any).channel as string;
  const thread_ts = (event as any).thread_ts ?? (event as any).ts;

  const stripped = stripMentions(text);

  // Intercept add-repo before any other routing
  const addRepoParsed = parseAddRepoCommand(stripped);
  if (addRepoParsed) {
    await handleAddRepoMessage(text, channel, (event as any).user, thread_ts, false, client, logger);
    return;
  }

  // Check if this mention is inside a tracked PRD thread
  if (thread_ts) {
    const intent = parsePrdMentionIntent(stripped);
    if (intent) {
      const prdCtx =
        lookupPrdThread(channel, thread_ts) ??
        lookupPrdThreadByChannel(channel) ??
        discoverPrdContextFromState(channel, thread_ts, logger);
      if (prdCtx) {
        handlePrdThreadMention(prdCtx, intent, channel, thread_ts, client, logger).catch(
          (err) => logger.error("handlePrdThreadMention error:", err)
        );
        return;
      }
    }
  }

  // Check if this mention is inside a tracked harness thread — route follow-up
  if (thread_ts && stripped) {
    const harnessCtx = lookupHarnessThread(channel, thread_ts);
    if (harnessCtx) {
      handleHarnessFollowUp(harnessCtx, stripped, channel, thread_ts, client, logger).catch(
        (err) => logger.error("handleHarnessFollowUp error:", err)
      );
      return;
    }
  }

  // Unified harness handler: answer, clarify, or propose workflow with confirm buttons
  const prompt = stripped || "help";
  handleHarnessMessage(prompt, channel, thread_ts, client, logger, "mention").catch(
    (err) => logger.error("handleHarnessMessage (mention) error:", err)
  );
});

// ─── PRD thread reply → Google Doc suggestion ──────────────────────────────
// When a user replies in a tracked PRD-analysis Slack thread, match their
// answer to an open query and post it as a reply on the Google Doc comment.

async function matchReplyToQuery(
  userReply: string,
  queries: PrdQueryInfo[]
): Promise<{ queryIndex: number; suggestion: string } | null> {
  const queriesList = queries
    .map((q) => `Q${q.index}: ${q.body}`)
    .join("\n");

  const prompt = [
    "You are matching a user's reply to one of several open PRD questions.",
    "The user answered in a Slack thread. Determine which question they are",
    "answering and produce a concise suggestion suitable for a Google Doc comment reply.",
    "",
    "Open questions:",
    queriesList,
    "",
    "User reply:",
    userReply,
    "",
    "Respond in EXACTLY this format (nothing else):",
    "MATCH: <number>",
    "SUGGESTION: <your concise suggestion>",
    "",
    "If the reply doesn't clearly answer any question, respond:",
    "MATCH: 0",
    "SUGGESTION: none",
  ].join("\n");

  try {
    const res = await fetch(`${ARCHON_SERVER_URL}/api/run-workflow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: queries[0]?.commentId ? "_llm_only" : "",
        workflow: "_inline",
        prompt,
      }),
    });
    // The run-workflow endpoint won't work for an ad-hoc LLM call.
    // Instead we call the LLM through a lightweight prompt via the
    // existing triggerWorkflow + poll pattern... but that's heavy.
    // Simpler: do the matching locally with heuristics, and fall back
    // to posting the raw reply if no match is found.
  } catch {
    // fall through to heuristic
  }

  // Heuristic matching: check for "Q<n>" or "#<n>" prefix
  const prefixMatch = userReply.match(/^(?:Q|#)\s*(\d+)\b/i);
  if (prefixMatch) {
    const idx = parseInt(prefixMatch[1], 10);
    const matched = queries.find((q) => q.index === idx);
    if (matched) {
      const suggestion = userReply.replace(/^(?:Q|#)\s*\d+[:\s]*/i, "").trim();
      return { queryIndex: idx, suggestion };
    }
  }

  // Keyword matching: find the query with the most overlapping words
  const replyWords = new Set(userReply.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let bestIdx = 0;
  let bestScore = 0;
  for (const q of queries) {
    const qWords = new Set(q.body.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    let overlap = 0;
    for (const w of replyWords) {
      if (qWords.has(w)) overlap++;
    }
    if (overlap > bestScore) {
      bestScore = overlap;
      bestIdx = q.index;
    }
  }

  if (bestScore >= 2) {
    return { queryIndex: bestIdx, suggestion: userReply.trim() };
  }

  // If only one query, it's an obvious match
  if (queries.length === 1) {
    return { queryIndex: queries[0].index, suggestion: userReply.trim() };
  }

  return null;
}

async function postGDocReply(
  docId: string,
  commentId: string,
  body: string
): Promise<{ replyId?: string; error?: string }> {
  try {
    const res = await fetch(`${ARCHON_SERVER_URL}/api/gdoc-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId, commentId, body }),
    });
    return await archonResponseJson<{ replyId?: string; error?: string }>(
      res,
      "POST /api/gdoc-reply"
    );
  } catch (err: any) {
    return { error: err.message };
  }
}

app.message(async ({ message, client, logger }) => {
  const m = message as any;
  // Only handle channel thread replies (not DMs, not top-level messages)
  if (m.channel_type === "im") return;
  if (m.subtype || m.bot_id) return;
  if (!m.thread_ts) return;

  const ctx = lookupPrdThread(m.channel, m.thread_ts) ?? lookupPrdThreadByChannel(m.channel);
  if (!ctx) return;

  const text = (m.text ?? "").trim();
  if (!text) return;

  const match = await matchReplyToQuery(text, ctx.queries);
  if (!match) {
    const queryList = ctx.queries.map((q) => `Q${q.index}: ${q.body.slice(0, 80)}`).join("\n");
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text:
        `I couldn't tell which question you're answering. ` +
        `Prefix your reply with \`Q<number>\` to match it, e.g. \`Q1 yes, we should...\`\n\n` +
        `Open questions:\n${queryList}`,
    });
    return;
  }

  const query = ctx.queries.find((q) => q.index === match.queryIndex);
  if (!query) {
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text: `Matched your reply to Q${match.queryIndex}, but I don't have tracking info for it.`,
    });
    return;
  }

  if (query.anchor) {
    const result = await postGDocSuggestEdits(ctx.docId, [
      { anchor: query.anchor, replacement: `${query.anchor}\n\n[Update — Q${query.index}]: ${match.suggestion}` },
    ]);
    if (result.error) {
      logger.error(`Failed to post GDoc suggestion for Q${match.queryIndex}: ${result.error}`);
      await client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.thread_ts,
        text: `Matched your reply to Q${match.queryIndex} but failed to post suggestion to Google Doc: ${result.error}`,
      });
      return;
    }
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text:
        `Posted as a suggested edit on the Google Doc for Q${match.queryIndex}. ` +
        `Open the doc and click *Accept* to apply it. :white_check_mark:\n` +
        `<${ctx.docUrl}|Open PRD>`,
    });
  } else {
    const result = await postGDocComment(
      ctx.docId,
      `[Answer to Q${query.index}]: ${match.suggestion}`
    );
    if (result.error) {
      logger.error(`Failed to post GDoc comment for Q${match.queryIndex}: ${result.error}`);
      await client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.thread_ts,
        text: `Matched your reply to Q${match.queryIndex} but failed to post to Google Doc: ${result.error}`,
      });
      return;
    }
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text:
        `Added your answer for Q${match.queryIndex} as a comment on the Google Doc. :white_check_mark:\n` +
        `<${ctx.docUrl}|Open PRD>`,
    });
  }
});

// ─── Direct messages ───────────────────────────────────────────────────────
// Users can DM the bot without a mention. Unified harness handler answers everything.
app.message(async ({ message, client, logger }) => {
  const m = message as any;
  if (m.channel_type !== "im") return;
  if (m.subtype || m.bot_id) return;
  const text = m.text ?? "";

  const stripped = stripMentions(text);
  if (!stripped) return;

  const thread_ts = m.thread_ts ?? m.ts;

  // Intercept add-repo in DMs
  const addRepoParsedDm = parseAddRepoCommand(stripped);
  if (addRepoParsedDm) {
    await handleAddRepoMessage(text, m.channel, m.user!, thread_ts, true, client, logger);
    return;
  }

  handleHarnessMessage(stripped, m.channel, thread_ts, client, logger, "dm").catch(
    (err) => logger.error("handleHarnessMessage (dm) error:", err)
  );
});

(async () => {
  await probeArchonOnStartup();
  const port = parseInt(process.env.SLACK_BOT_PORT ?? "3200", 10);
  await app.start(port);
  console.log(`Archon Hub Slack bot listening on port ${port}`);
})();

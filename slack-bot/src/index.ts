import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { App, LogLevel } from "@slack/bolt";

const ARCHON_SERVER_URL = process.env.ARCHON_SERVER_URL ?? "http://localhost:3100";
const ARCHON_UI_URL = process.env.ARCHON_UI_URL ?? "http://localhost:5173";
const DEFAULT_REPO_ID = process.env.ARCHON_DEFAULT_REPO_ID ?? "";
const DEFAULT_WORKFLOW = process.env.ARCHON_DEFAULT_WORKFLOW ?? "dev";
const HUB_STATE_DIR = path.resolve(__dirname, "../../state");

// ─── PRD thread tracking ───────────────────────────────────────────────────
interface PrdQueryInfo {
  index: number;
  body: string;
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
    const data = (await res.json()) as { repos: Repo[] };
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
    const data = (await res.json()) as { workflows: { name: string }[] };
    return new Set((data.workflows ?? []).map((w) => w.name));
  } catch {
    return new Set();
  }
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
  return res.json() as Promise<RunResponse>;
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

// Parse "[repo-id] [workflow] <prompt>" (order-flexible between repo / workflow).
// Falls back to ARCHON_DEFAULT_REPO_ID and ARCHON_DEFAULT_WORKFLOW when absent.
async function parseInvocation(rawText: string): Promise<Invocation> {
  const text = stripMentions(rawText);
  if (!text) {
    return { repoId: DEFAULT_REPO_ID || null, workflow: DEFAULT_WORKFLOW, prompt: "" };
  }

  const tokens = text.split(/\s+/);
  const repos = await listRepoIds();

  let repoId: string | null = null;
  let workflow: string | null = null;
  let i = 0;

  // Up to two leading tokens may be repo-id and/or workflow, in any order.
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

  return {
    repoId: repoId ?? (DEFAULT_REPO_ID || null),
    workflow: workflow ?? DEFAULT_WORKFLOW,
    prompt: tokens.slice(i).join(" ").trim(),
  };
}

function usageText(prefix: string): string {
  return [
    `*Usage*: ${prefix} [<repo-id>] [<workflow>] <your requirement>`,
    `• <repo-id> — optional; defaults to \`ARCHON_DEFAULT_REPO_ID\``,
    `• <workflow> — optional; defaults to \`${DEFAULT_WORKFLOW}\``,
    `• Example: \`${prefix} ubx-ui pr-review fix flaky login test\``,
  ].join("\n");
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
  app.command(commandName, async ({ command, ack, respond }) => {
    await ack();

    const inv = await parseInvocation(command.text ?? "");
    // Slash command's workflow is fixed by the command name itself.
    inv.workflow = workflowName;

    if (!inv.prompt) {
      await respond({ response_type: "ephemeral", text: usageText(commandName) });
      return;
    }
    if (!inv.repoId) {
      await respond({
        response_type: "ephemeral",
        text:
          `No repo specified and \`ARCHON_DEFAULT_REPO_ID\` is not set. ` +
          `Use: \`${commandName} <repo-id> <requirement>\``,
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
      await respond({
        response_type: "in_channel",
        blocks: successBlocks({ ...inv, runId: result.runId ?? "" }),
      });
    } catch (err: any) {
      await respond({
        response_type: "ephemeral",
        text: `Error connecting to Archon server: ${err.message}`,
      });
    }
  });
}

registerCommand("/archon-dev", "dev");
registerCommand("/archon-harness", "harness");

// ─── /archon-prd (PRD analysis) ────────────────────────────────────────────

function isGoogleDocUrl(text: string): boolean {
  return /docs\.google\.com\/document\/d\//.test(text) ||
    /drive\.google\.com\/.*\/d\//.test(text);
}

interface RunState {
  runId: string;
  repoId: string;
  status: string;
  steps: { id: string; status: string; output: string; error?: string }[];
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
      state = (await res.json()) as RunState;
    } catch {
      continue;
    }

    if (state.status !== "success" && state.status !== "failed") continue;

    if (state.status === "failed") {
      const failedStep = state.steps.find((s) => s.status === "failed");
      await client.chat.postMessage({
        channel,
        thread_ts,
        text:
          `*PRD analysis failed*\n` +
          `Step: \`${failedStep?.id ?? "?"}\`\n` +
          `Error: ${failedStep?.error ?? "unknown"}\n` +
          `<${ARCHON_UI_URL}/?run=${runId}|View run details>`,
      });
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
    const commentLine = postedMatch
      ? `Google Doc comments: ${postedMatch[1]} of ${postedMatch[2]} posted`
      : "";

    const prUrlMatch = (openPrStep?.output ?? "").match(/PR_URL=(https?:\/\/\S+)/);
    const prLine = prUrlMatch ? `<${prUrlMatch[1]}|View PR on GitHub>` : "";

    const body = [
      `*PRD Analysis Complete*`,
      "",
      slackReply ?? "_No verdict produced — check the full run._",
      "",
      commentLine,
      prLine,
      `<${docUrl}|Open PRD in Google Docs>`,
      `<${ARCHON_UI_URL}/?run=${runId}|View full analysis in Archon Hub>`,
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
      text:
        `No repo specified and \`ARCHON_DEFAULT_REPO_ID\` is not set. ` +
        `Use: \`/archon-prd <repo-id> <google-doc-url>\``,
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
        // Skip the first message (the bot's initial post) and bot messages
        const humanReplies = messages.slice(1).filter(
          (msg: any) => !msg.bot_id && !msg.subtype
        );

        if (humanReplies.length > 0) {
          const lines: string[] = ["--- PRIOR SLACK DISCUSSION ---"];
          for (const q of latest.queries) {
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
          // Also include unmatched replies as general context
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
          threadContext = lines.join("\n");
        }
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
        `*PRD analysis started*\n` +
        `Repo: \`${inv.repoId}\` | Run: \`${runId}\`\n` +
        `Doc: ${docUrl}\n` +
        `<${ARCHON_UI_URL}/?run=${runId}|View in Archon Hub>\n` +
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

// ─── @mentions ─────────────────────────────────────────────────────────────
// Tag the bot in any channel it's been invited to:
//   @ArchonBot ubx-ui pr-review fix flaky login test
//   @ArchonBot fix the readme typo          (uses defaults)
//   @ArchonBot help
app.event("app_mention", async ({ event, client, logger }) => {
  const text = (event as any).text ?? "";
  const channel = (event as any).channel as string;
  const thread_ts = (event as any).thread_ts ?? (event as any).ts;

  const stripped = stripMentions(text);
  if (!stripped || /^(help|\?|usage)$/i.test(stripped)) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: usageText("@ArchonBot"),
    });
    return;
  }

  const inv = await parseInvocation(text);

  if (!inv.prompt) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: usageText("@ArchonBot"),
    });
    return;
  }
  if (!inv.repoId) {
    await client.chat.postMessage({
      channel,
      thread_ts,
      text:
        `No repo specified and \`ARCHON_DEFAULT_REPO_ID\` is not set. ` +
        `Try: \`@ArchonBot <repo-id> <requirement>\``,
    });
    return;
  }

  try {
    const result = await triggerWorkflow(inv.repoId, inv.workflow, inv.prompt);
    if (result.error) {
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Failed to start workflow: ${result.error}`,
      });
      return;
    }
    await client.chat.postMessage({
      channel,
      thread_ts,
      blocks: successBlocks({ ...inv, runId: result.runId ?? "" }),
      text: `Archon run ${result.runId} started for ${inv.repoId}/${inv.workflow}`,
    });
  } catch (err: any) {
    logger.error(err);
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Error connecting to Archon server: ${err.message}`,
    });
  }
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
    return (await res.json()) as { replyId?: string; error?: string };
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

  const ctx = lookupPrdThread(m.channel, m.thread_ts);
  if (!ctx) return;

  const text = (m.text ?? "").trim();
  if (!text) return;

  const match = await matchReplyToQuery(text, ctx.queries);
  if (!match) {
    // Not a clear answer to any query — silently ignore
    return;
  }

  const query = ctx.queries.find((q) => q.index === match.queryIndex);
  if (!query || !query.commentId) {
    await client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text: `Matched your reply to Q${match.queryIndex}, but I don't have a Google Doc comment ID for it. The suggestion was not posted.`,
    });
    return;
  }

  const result = await postGDocReply(ctx.docId, query.commentId, match.suggestion);
  if (result.error) {
    logger.error(`Failed to post GDoc reply: ${result.error}`);
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
    text: `Posted your answer to Q${match.queryIndex} on the Google Doc. :white_check_mark:`,
  });
});

// ─── Direct messages ───────────────────────────────────────────────────────
// Users can also DM the bot without a mention.
app.message(async ({ message, client, logger }) => {
  // Only handle DMs from humans.
  const m = message as any;
  if (m.channel_type !== "im") return;
  if (m.subtype || m.bot_id) return;
  const text = m.text ?? "";

  const stripped = stripMentions(text);
  if (!stripped || /^(help|\?|usage)$/i.test(stripped)) {
    await client.chat.postMessage({
      channel: m.channel,
      text: usageText("(DM)"),
    });
    return;
  }

  const inv = await parseInvocation(text);

  if (!inv.prompt) {
    await client.chat.postMessage({ channel: m.channel, text: usageText("(DM)") });
    return;
  }
  if (!inv.repoId) {
    await client.chat.postMessage({
      channel: m.channel,
      text:
        `No repo specified and \`ARCHON_DEFAULT_REPO_ID\` is not set. ` +
        `Try: \`<repo-id> <requirement>\``,
    });
    return;
  }

  try {
    const result = await triggerWorkflow(inv.repoId, inv.workflow, inv.prompt);
    if (result.error) {
      await client.chat.postMessage({
        channel: m.channel,
        text: `Failed to start workflow: ${result.error}`,
      });
      return;
    }
    await client.chat.postMessage({
      channel: m.channel,
      blocks: successBlocks({ ...inv, runId: result.runId ?? "" }),
      text: `Archon run ${result.runId} started for ${inv.repoId}/${inv.workflow}`,
    });
  } catch (err: any) {
    logger.error(err);
    await client.chat.postMessage({
      channel: m.channel,
      text: `Error connecting to Archon server: ${err.message}`,
    });
  }
});

(async () => {
  const port = parseInt(process.env.SLACK_BOT_PORT ?? "3200", 10);
  await app.start(port);
  console.log(`Archon Hub Slack bot listening on port ${port}`);
})();

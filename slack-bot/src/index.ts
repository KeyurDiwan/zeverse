import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { App } from "@slack/bolt";

const ARCHON_SERVER_URL = process.env.ARCHON_SERVER_URL ?? "http://localhost:3100";
const ARCHON_UI_URL = process.env.ARCHON_UI_URL ?? "http://localhost:5173";
const DEFAULT_REPO_ID = process.env.ARCHON_DEFAULT_REPO_ID ?? "";
const DEFAULT_WORKFLOW = process.env.ARCHON_DEFAULT_WORKFLOW ?? "dev";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: !!process.env.SLACK_APP_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
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
  prompt: string
): Promise<RunResponse> {
  const res = await fetch(`${ARCHON_SERVER_URL}/api/run-workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId, workflow: workflowName, prompt }),
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

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { App } from "@slack/bolt";

const ARCHON_SERVER_URL = process.env.ARCHON_SERVER_URL ?? "http://localhost:3100";
const ARCHON_UI_URL = process.env.ARCHON_UI_URL ?? "http://localhost:5173";
const DEFAULT_REPO_ID = process.env.ARCHON_DEFAULT_REPO_ID ?? "";

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

// Parse "repoId prompt text here" — the first whitespace-delimited token is
// treated as a repoId if it matches a known repo, else the full text is the
// prompt and ARCHON_DEFAULT_REPO_ID is used.
async function parseInvocation(
  text: string
): Promise<{ repoId: string | null; prompt: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { repoId: null, prompt: "" };

  const [first, ...rest] = trimmed.split(/\s+/);
  const knownRepos = await listRepoIds();
  if (knownRepos.has(first)) {
    return { repoId: first, prompt: rest.join(" ").trim() };
  }
  return { repoId: DEFAULT_REPO_ID || null, prompt: trimmed };
}

function registerCommand(commandName: string, workflowName: string) {
  app.command(commandName, async ({ command, ack, respond }) => {
    await ack();

    const { repoId, prompt } = await parseInvocation(command.text ?? "");

    if (!prompt) {
      await respond({
        response_type: "ephemeral",
        text: `Usage: ${commandName} [<repo-id>] <your requirement>`,
      });
      return;
    }
    if (!repoId) {
      await respond({
        response_type: "ephemeral",
        text:
          `No repo specified and ARCHON_DEFAULT_REPO_ID is not set. ` +
          `Use: ${commandName} <repo-id> <requirement>`,
      });
      return;
    }

    try {
      const result = await triggerWorkflow(repoId, workflowName, prompt);

      if (result.error) {
        await respond({
          response_type: "ephemeral",
          text: `Failed to start workflow: ${result.error}`,
        });
        return;
      }

      await respond({
        response_type: "in_channel",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `*Archon workflow started*`,
                `Repo: \`${repoId}\``,
                `Workflow: \`${workflowName}\``,
                `Prompt: ${prompt}`,
                `Run ID: \`${result.runId}\``,
                `<${ARCHON_UI_URL}/?run=${result.runId}|View in Archon Hub>`,
              ].join("\n"),
            },
          },
        ],
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

(async () => {
  const port = parseInt(process.env.SLACK_BOT_PORT ?? "3200", 10);
  await app.start(port);
  console.log(`Archon Hub Slack bot listening on port ${port}`);
})();

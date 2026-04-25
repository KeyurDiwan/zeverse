# Archon Hub

Multi-repo AI workflow runner. One control plane (server + UI + Slack bot) that can drive dev, CI/CD, and custom workflows across any number of target repositories.

```
archon-hub/
├── config/archon.yaml   # Global LLM + runner config
├── repos.json           # Registry of imported repos
├── server/              # Express API + workflow runner (port 3100)
├── ui/                  # Vite + React dashboard (port 5173)
├── slack-bot/           # Slack Bolt bot (port 3200)
├── state/<repoId>/runs/ # Runtime run state + logs
└── repos/               # Default workspace for cloned repos
```

Workflows and commands live **inside each target repo** under `.archon/workflows/` and `.archon/commands/`. Archon Hub itself is project-agnostic.

## Prerequisites

- Node.js ≥ 20
- npm ≥ 9
- git (for cloning imported repos)

## Quick start

```bash
cp .env.example .env
# Edit .env with your CloudVerse API key

npm run install:all

# In separate terminals:
npm run dev:server       # http://localhost:3100
npm run dev:ui           # http://localhost:5173
npm run dev:slack        # optional, only if Slack creds are set
```

Open http://localhost:5173 and click **+ Import** to register your first repo.

## Importing repos

Supply a git URL via the UI or API. Archon Hub clones it into `./repos/<name>/`.
If the target directory already exists and contains a `.git` folder, the existing
clone is reused without re-cloning.

The registry is stored in `repos.json`:

```json
{
  "repos": [
    {
      "id": "ubx-ui",
      "name": "ubx-ui",
      "path": "/Users/you/archon-hub/repos/ubx-ui",
      "origin": "git@github.com:org/ubx-ui.git",
      "addedAt": "2026-04-22T00:00:00Z"
    }
  ]
}
```

## Adding workflows to a target repo

Inside the target repo, create `.archon/workflows/<name>.yaml`:

```yaml
name: dev
description: Plan, implement, validate, review, PR.
inputs:
  - id: requirement
    label: Feature requirement
    required: true
steps:
  - id: plan
    kind: llm
    prompt: |
      Break this requirement into ordered tasks:
      {{inputs.requirement}}
  - id: validate
    kind: shell
    command: npm run lint && npm test -- --watchAll=false
    continueOnError: true
```

Step kinds:

| Kind           | Purpose                                            |
|----------------|---------------------------------------------------|
| `llm`          | Send a prompt to the configured LLM               |
| `review`       | Same as `llm`, semantically marked as a review    |
| `shell`        | Execute a shell command in the target repo         |
| `apply`        | Write files from fenced code blocks (`path=…`)    |
| `patch`        | Apply unified-diff patches via `git apply`        |
| `edit`         | Search/replace edits on existing files             |
| `gdoc-fetch`   | Fetch plain text from a Google Doc (via `docUrl`). Set `includeComments: true` to append existing comments. |
| `gdoc-comment` | Post comments on a Google Doc from a queries JSON  |
| `gdoc-reply`   | Reply to existing Google Doc comments (`repliesFrom`) |
| `gdoc-resolve` | Resolve Google Doc comment threads (`resolvesFrom`) |
| `gdoc-suggest` | Post suggest-edits on a Google Doc (`suggestsFrom`) |
| `fr-fetch`     | Fetch a Freshrelease task with all comments (`frUrl`) |
| `fr-create`    | Create FR issues from a fenced `fr-issues` JSON block (`contentFrom`) |
| `fr-comment`   | Post a comment on a Freshrelease task (`frUrl`, `bodyFrom`) |

Steps support an optional `when:` field — a template expression that is evaluated at
runtime. When the rendered value is empty, `"false"`, `"no"`, or `"0"`, the step is
skipped. This enables mode-driven branching within a single workflow.

Shell steps run with `cwd` resolved against the target repo's path (or relative to it, if `cwd:` is set on the step).

Templating uses `{{inputs.<id>}}` and `{{steps.<id>.output}}`.

## API

| Method | Path                          | Description                             |
|--------|-------------------------------|-----------------------------------------|
| GET    | `/api/repos`                  | List imported repos                     |
| POST   | `/api/repos`                  | Import a repo (`{url}`, optional `{name}`) |
| DELETE | `/api/repos/:id`              | Remove a repo from the registry         |
| GET    | `/api/workflows?repoId=`      | List workflows for a repo               |
| POST   | `/api/run-workflow`           | Start a run (`{repoId, workflow, prompt}`) |
| GET    | `/api/runs/:id?repoId=`       | Get run state                           |
| GET    | `/api/logs/:id?repoId=&offset=` | Tail run logs                         |
| POST   | `/api/gdoc-reply`             | Reply to a Google Doc comment (`{docId, commentId, body}`) |
| POST   | `/api/gdoc-comment`           | Post a top-level Google Doc comment (`{docId, body}`) |
| POST   | `/api/gdoc-suggest`           | Apply tracked-change suggestions (`{docId, edits[]}`) |
| POST   | `/api/infer-repo`             | LLM-inferred repo selection (`{prompt}`) |
| POST   | `/api/route-intent`           | LLM-based intent router (`{prompt, repoId?}`) — returns `{workflow, inputs, confidence, reason, fallback}` |
| POST   | `/api/smart-reply`            | Universal LLM handler (`{prompt, threadContext?, repoId?, surface}`) — returns `{type: answer\|clarify\|workflow, ...}` |
| GET    | `/health`                     | Health check                            |

## Slack bot

Three ways to drive Archon from Slack:

### 1. Slash commands

```
/archon-dev     [<repo-id>] <your requirement>
/archon-harness [<repo-id>] <anything>
/archon-prd     [<repo-id>] <google-doc-url>
```

`/archon-harness` is the **universal command** — it accepts any natural-language
prompt and an LLM-based intent router picks the best workflow automatically:

| Prompt style | Routed to |
|---|---|
| "fix the login redirect loop" | `fix-bug` |
| "review my branch vs origin/main" | `code-review` |
| "explain src/store" | `explain-codebase` |
| "add a dark-mode toggle to settings" | `dev` |
| "how does billing routing work?" | `ask` (read-only Q&A) |
| "bump react to 19" | `upgrade-dep` |
| `https://freshrelease.com/ws/BILLING/tasks/BILLING-123` | `fr-task-finisher` |
| "create epic for onboarding flow" | `fr-card-creator` |
| "analyze FR BILLING-10444" | `fr-analyze` |
| "write tests for src/pages/billing/InvoiceList.tsx" | `test-write` |
| "raise PR" | `pr-raise` |
| `https://docs.google.com/document/d/…` | `prd-analysis` |

The router posts the chosen workflow + reason in Slack before execution starts.
If the LLM can't confidently pick a workflow (confidence < 60%), it falls back to
`ask` — a read-only workflow that searches the codebase and answers the question.

When the router picks a write-capable workflow (`fix-bug`, `dev`, `lint-fix`),
edits are applied to disk and the result includes a diff summary, review verdict,
and a PR link (when available).

**Thread follow-ups:** `@mention` the bot inside a `/archon-harness` thread and
it re-routes the new prompt with full thread history as context — so "now fix it"
works after a diagnosis.

`/archon-prd` reads the PRD from the linked Google Doc, analyses it against the
repo codebase, posts open queries as comments on the doc, and replies in-thread
with a finalised/not-finalised verdict plus a summary of the top open questions.

### 2. @mentions (tag the bot in any channel)

Invite the bot to a channel, then tag it. The bot answers **everything** — it
reads the full Slack thread for context, then decides whether to answer the
question directly, ask a clarifying question, or trigger a workflow:

```
@ArchonBot how does the billing router work?          # answered directly via LLM
@ArchonBot fix the login bug                          # triggers fix-bug workflow
@ArchonBot fix something                              # asks "Which repo / what exactly is broken?"
@ArchonBot ubx-ui pr-review fix flaky login test      # triggers pr-review workflow
@ArchonBot help                                       # friendly greeting + capabilities
```

When the bot triggers a workflow it replies in-thread with a run link back to
the Archon Hub UI.

### 2a. @mentions inside PRD threads

When the bot is @mentioned inside a Slack thread that was started by `/archon-prd`,
it recognises special commands that sync the thread discussion back to the Google Doc:

```
@ArchonBot update the PRD doc     # reads thread, posts answers + summary comment + tracked-change suggestions
@ArchonBot answer this            # reads thread, posts answers + summary comment (no doc body edits)
```

**"answer this"** reads the full thread history, matches answers to the original
open queries, and posts:
- A reply on each matched Google Doc comment with the synthesised answer.
- A single top-level summary comment on the doc recapping all resolutions.

**"update the PRD doc"** does everything "answer this" does, plus produces
tracked-change suggestions on the PRD body itself (e.g. updating sections that
the discussion resolved). When the service account has **Commenter** access the
edits land as suggestions the PRD owner can accept or reject; with **Editor**
access they become direct writes.

Recognised trigger phrases:
- Update: `update`, `edit`, `apply`, `update prd`, `update the doc`, `update prd doc`
- Answer: `answer`, `answer this`, `reply`, `respond`, `post answers`

Any other @mention text in a PRD thread falls through to the normal workflow trigger.

### 3. Direct message

DM the bot (no mention needed). Same smart behaviour as @mentions — it answers
questions, asks clarifying follow-ups, or triggers workflows:

```
how does the billing router work?
fix the login bug in ubx-ui
```

### Slack app setup

In your Slack app manifest / settings:

- **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `commands`, `im:history`,
  `im:read`, `im:write`, `channels:history`, `groups:history`
- **Event Subscriptions**: subscribe the bot to `app_mention` and `message.im`
- **Slash Commands**: `/archon-dev`, `/archon-harness`, `/archon-prd`
  - `/archon-harness` uses the LLM intent router (`/api/route-intent`) — no fixed workflow
- **Socket Mode**: enabled (set `SLACK_APP_TOKEN` with scope `connections:write`)

Defaults:
- **Repo**: if `<repo-id>` is omitted the bot first checks `ARCHON_DEFAULT_REPO_ID`.
  If that is unset, it asks the LLM to pick the best-matching repo from the
  registry (or auto-selects when only one repo exists).
- **Workflow**: if `<workflow>` is omitted (and the command doesn't force one),
  the bot matches keywords in the prompt to available workflows:
  `fix`/`bug` → `fix-bug`, `review`/`pr` → `code-review`, `lint` → `lint-fix`,
  `test` → `test-write`, `explain` → `explain-codebase`, `upgrade`/`bump` → `upgrade-dep`,
  `create epic`/`create task`/`card` → `fr-card-creator`, `analyze FR` → `fr-analyze`,
  `finish FR` / FR URL → `fr-task-finisher`, `raise PR` → `pr-raise`.
  Falls back to `ARCHON_DEFAULT_WORKFLOW` (default `dev`).

### Google Docs integration (for `/archon-prd`)

1. Create a Google Cloud service account and download its JSON key.
2. Place the JSON at `config/gcp-service-account.json` (gitignored) or set
   `GOOGLE_SERVICE_ACCOUNT_PATH` in `.env` to a custom path.
3. Share each PRD Google Doc with the service account email
   (e.g. `your-sa@your-project.iam.gserviceaccount.com`).

**Access level guidance:**
- **Commenter** (recommended for `@ArchonBot update the PRD doc`): edits land as
  tracked-change suggestions the PRD owner can accept/reject. Comments and replies
  still work normally.
- **Editor**: all operations work, but `update` edits become direct writes instead
  of suggestions.

### Freshrelease integration

Workflows `fr-card-creator`, `fr-analyze`, and `fr-task-finisher` talk to the
Freshrelease API to fetch tasks, create cards, and post comments.

The `fr-analyze` workflow in **ubx-ui** follows the same “FR Analyzer” behaviour as the Cursor agent (analysis-only, full comment context, structured sections); the hub uses **`fr-fetch`** and the LLM instead of calling Freshrelease MCP tools at runtime.

The `fr-task-finisher` workflow uses a **discover -> implement -> retry** contract:

1. **`discover`** -- extracts keywords from the FR card and the LLM intent output,
   greps the repo for matching files, and emits their **full contents** (capped at
   800 lines/file, top 10 files). This replaces the old `codebase-map` step that
   only provided a directory tree.
2. **`implement`** -- the LLM emits `SEARCH/REPLACE` edit blocks, required to copy the
   SEARCH text verbatim from the discovery output. `<<<<<<< CREATE` is forbidden for
   existing source files (only allowed for new test files under `__tests__/`).
3. **`apply-edits-check` + `implement-retry`** -- if the first apply reports any
   `FAIL` lines or `Applied 0/`, the LLM gets a second attempt with the error
   messages and the same file contents.
4. **`edits-landed`** -- downstream steps (tests, lint, review) are skipped entirely
   when neither attempt applied any edits. The FR comment clearly reports
   "failed -- no edits applied" so the card is not left in an ambiguous state.

The `edit` executor (`executeEditStep`) now tracks a `dirtyFiles` set and only
flushes files that had at least one successful op -- failed SEARCH blocks against
non-existent paths no longer create empty stub files on disk.

1. Set `FRESHRELEASE_API_TOKEN` in `.env` to your Freshrelease personal API token.
2. Optionally set `FRESHRELEASE_WORKSPACE` (default: `BILLING`).

The same token that powers the Cursor MCP at `~/.claude/mcp-servers/freshrelease/`
works here.

### Available workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `prd-analysis` | Google Doc URL / "PRD" | Fetch PRD, cross-ref codebase, post queries as GDoc comments, reply/resolve answered threads, suggest edits, write deliverable, open PR |
| `fr-card-creator` | "create epic/task/card" | Parse prompt or PRD markdown into FR issues, create Epic then Tasks in Freshrelease |
| `fr-analyze` | FR URL / "analyze FR" | Fetch FR card, cross-check against codebase, produce structured analysis with a design-level recommended solution (files, approach, illustrative snippets — no repo changes); from Slack, posts the `## Summary` in the thread |
| `fr-task-finisher` | FR URL / "finish FR" / "fix FR" | Full e2e: fetch FR → discover files → plan → implement (SEARCH/REPLACE) → retry on failure → test → review → commit → PR → comment back |
| `code-review` | "review PR" / PR URL | Unified entry: local branch or remote PR review, posts comment on GitHub |
| `test-write` | "write tests for …" | Find source, read it, generate Jest+RTL tests, run them, self-review |
| `pr-raise` | "raise PR" / "open PR" | Push branch, auto-generate title+body, create PR via `gh` or REST |
| `dev` | Feature request | Plan → implement → validate → self-review |
| `fix-bug` | "fix" / "bug" | Diagnose → fix → test → review |
| `ask` | General question | Read-only codebase Q&A |
| `explain-codebase` | "explain" / "how does" | Walk through code structure |

## License

Private — Freshworks Inc.

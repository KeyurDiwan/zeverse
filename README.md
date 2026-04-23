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

Two ways:

1. **Local path** — point Archon Hub at a repo already on disk.
2. **Git clone** — supply a git URL; Archon Hub clones it into `./repos/<name>/`.

The registry is stored in `repos.json`. You can edit it directly too:

```json
{
  "repos": [
    {
      "id": "ubx-ui",
      "name": "ubx-ui",
      "path": "/Users/you/code/ubx-ui",
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

| Kind     | Purpose                                        |
|----------|------------------------------------------------|
| `llm`    | Send a prompt to the configured LLM            |
| `review` | Same as `llm`, semantically marked as a review |
| `shell`  | Execute a shell command in the target repo     |

Shell steps run with `cwd` resolved against the target repo's path (or relative to it, if `cwd:` is set on the step).

Templating uses `{{inputs.<id>}}` and `{{steps.<id>.output}}`.

## API

| Method | Path                          | Description                             |
|--------|-------------------------------|-----------------------------------------|
| GET    | `/api/repos`                  | List imported repos                     |
| POST   | `/api/repos`                  | Import a repo (`{path}` or `{url}`)     |
| DELETE | `/api/repos/:id`              | Remove a repo from the registry         |
| GET    | `/api/workflows?repoId=`      | List workflows for a repo               |
| POST   | `/api/run-workflow`           | Start a run (`{repoId, workflow, prompt}`) |
| GET    | `/api/runs/:id?repoId=`       | Get run state                           |
| GET    | `/api/logs/:id?repoId=&offset=` | Tail run logs                         |
| GET    | `/health`                     | Health check                            |

## Slack bot

Three ways to drive Archon from Slack:

### 1. Slash commands

```
/archon-dev     [<repo-id>] <your requirement>
/archon-harness [<repo-id>] <your requirement>
```

### 2. @mentions (tag the bot in any channel)

Invite the bot to a channel, then tag it:

```
@ArchonBot ubx-ui pr-review fix flaky login test
@ArchonBot ubx-ui add empty-state to dashboard       # uses default workflow (dev)
@ArchonBot fix readme typo                            # uses default repo + workflow
@ArchonBot help
```

The bot replies in-thread with a run link back to the Archon Hub UI.

### 3. Direct message

DM the bot the same syntax (no mention needed):

```
ubx-ui pr-review fix flaky login test
```

### Slack app setup

In your Slack app manifest / settings:

- **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `commands`, `im:history`,
  `im:read`, `im:write`
- **Event Subscriptions**: subscribe the bot to `app_mention` and `message.im`
- **Slash Commands**: `/archon-dev`, `/archon-harness`
- **Socket Mode**: enabled (set `SLACK_APP_TOKEN` with scope `connections:write`)

Defaults: if `<repo-id>` is omitted, `ARCHON_DEFAULT_REPO_ID` is used. If `<workflow>`
is omitted, `ARCHON_DEFAULT_WORKFLOW` (default `dev`) is used.

## License

Private — Freshworks Inc.

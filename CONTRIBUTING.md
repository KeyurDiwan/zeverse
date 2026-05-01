# Contributing to Zeverse

Thanks for helping improve Zeverse.

## Getting started

1. Clone the repo and install dependencies (see [README.md](README.md) **Quick start**).
2. Copy `.env.example` to `.env` and configure LLM (`CLOUDVERSE_*`), GitHub (`GITHUB_TOKEN` when needed), and optional integrations (Slack, Freshrelease, Google Docs).
3. Never commit `.env`, API keys, or service-account JSON (`config/gcp-service-account.json`).

## Branch and commits

- Open PRs against `main`.
- Prefer [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`).

## Running checks

From the repo root:

```bash
npm run install:all

# Slack bot workspace has tests
npm test --workspace=zeverse-slack-bot

# Optional smoke checks (requires server running + configured .env where noted)
npm run check:zeverse       # hits /health and /api/repos
npm run check:cloudverse    # CloudVerse / LLM smoke request
```

For server-side regressions, add or extend tests next to existing files under `server/src/**/__tests__/`.

## PR checklist

- [ ] Tests pass (or explain why not applicable).
- [ ] No secrets committed (tokens, `.env`, private keys).
- [ ] Docs updated if behaviour or env vars change.

## Workflow authoring

Workflows live in target repos under `.zeverse/workflows/*.yaml`. For step kinds and execution behaviour see:

- [server/src/runner/executors.ts](server/src/runner/executors.ts)
- [.zeverse/workflows/](.zeverse/workflows/) (examples in this repo hub)
- [examples/](examples/) for copy-paste samples

## Filing bugs

Include:

- What you ran (UI, Slack command, API `curl`).
- Repo id and workflow name.
- Run id from `state/<repoId>/runs/` or NDJSON events `state/<repoId>/runs/<runId>.events.ndjson`.

## Questions

Open an issue or discussion on GitHub — whatever the repo enables.

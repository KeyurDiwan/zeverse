# test-fix workflow (Slack + Zeverse)

This hub repo ships two workflow definitions under [`.zeverse/workflows/`](.zeverse/workflows/):

- **`test-fix.yaml`** — parent: optional install, loop child workflow until tests are green (or max iterations), then LLM summary and PR (branch isolation).
- **`test-fix-iteration.yaml`** — child: run tests → judge need-fix → (if needed) LLM patches → **Slack approval** → apply `edit` blocks → re-run tests → emit **yes/no** loop signal.

## One-time: register this repo as a target

So the runner can clone Zeverse and open a PR against it, register the hub Git URL as a repo (Slack admin):

```text
/zeverse-add-repo https://github.com/<org>/zeverse.git zeverse-hub
```

Use whatever repo id you choose (e.g. `zeverse-hub`) in `@mentions`.

## Trigger from Slack

In a channel the bot is in:

```text
@YourBot zeverse-hub fix failing tests
```

Or: `failing tests`, `green the build`, `fix unit tests` (see [server/src/workflow-infer.ts](server/src/workflow-infer.ts)).

The harness posts a **proposal**; click **Run**. When the workflow asks for approval, use **Approve** / **Reject** in the thread.

## Required input: `test_command`

When starting the run, provide **`test_command`** (workflow input). For this monorepo:

```text
npm install --legacy-peer-deps && npm run test
```

Optional **`install_command`**: leave empty if `test_command` already installs (as above).

## Engine notes

- Child workflow failures (e.g. rejected approval) fail the parent run.
- Parent `loopUntil` reads the trailing `ZEVERSE_CHILD_LOOP_SIGNAL:yes|no` appended by the runner after each child success (`server/src/runner/executors.ts`).
- Inline **`inputsFrom`** JSON templates (with `{{inputs.*}}`) are supported for child workflow inputs (`resolveChildWorkflow`).

import { v4 as uuidv4 } from "uuid";
import type { ArchonConfig } from "../config";
import { createLLMProvider, LLMProvider } from "../llm";
import type { Workflow, WorkflowStep } from "../workflows";
import type { Repo } from "../repos";
import {
  executeApplyStep,
  executeEditStep,
  executeLLMStep,
  executePatchStep,
  executeShellStep,
  executeWorkflowStep,
} from "./executors";
import {
  executeGDocFetchStep,
  executeGDocCommentStep,
  executeGDocReplyStep,
  executeGDocResolveStep,
  executeGDocSuggestStep,
} from "./executors-gdoc";
import {
  executeFRFetchStep,
  executeFRCreateStep,
  executeFRCommentStep,
} from "./executors-fr";
import { executeHarAnalyzeStep } from "./executors-har";
import { appendLog, appendEvent, RunState, saveState } from "./state";
import type { TemplateContext } from "./template";
import { renderTemplate } from "./template";
import { acquireSession, type RepoSession } from "./session";

const activeRuns = new Map<string, RunState>();

export function getActiveRun(runId: string): RunState | undefined {
  return activeRuns.get(runId);
}

// ── Approval gate bookkeeping ───────────────────────────────────────────────

interface PendingApproval {
  resolve: (result: { by: string; comment?: string }) => void;
  reject: (err: Error) => void;
}

const pendingApprovals = new Map<string, PendingApproval>();

export function resolveApproval(runId: string, by: string, comment?: string): boolean {
  const p = pendingApprovals.get(runId);
  if (!p) return false;
  p.resolve({ by, comment });
  pendingApprovals.delete(runId);
  return true;
}

export function rejectApproval(runId: string, by: string, reason?: string): boolean {
  const p = pendingApprovals.get(runId);
  if (!p) return false;
  p.reject(new Error(`Rejected by ${by}${reason ? `: ${reason}` : ""}`));
  pendingApprovals.delete(runId);
  return true;
}

// ── Thread-reply gate bookkeeping ───────────────────────────────────────────

export interface ThreadReplyFile {
  kind: "har" | "screenshot" | "attachment";
  path: string;
}

interface ThreadReplyPayload {
  by: string;
  text: string;
  files: ThreadReplyFile[];
}

interface PendingThreadReply {
  resolve: (result: ThreadReplyPayload) => void;
  reject: (err: Error) => void;
}

const pendingThreadReplies = new Map<string, PendingThreadReply>();

export function resolveThreadReply(
  runId: string,
  payload: ThreadReplyPayload
): boolean {
  const p = pendingThreadReplies.get(runId);
  if (!p) return false;
  p.resolve(payload);
  pendingThreadReplies.delete(runId);
  return true;
}

// ── Start a run ─────────────────────────────────────────────────────────────

export async function startRun(
  repo: Repo,
  workflow: Workflow,
  prompt: string,
  inputs: Record<string, string>,
  config: ArchonConfig,
  baseBranch?: string
): Promise<string> {
  const runId = uuidv4();

  const state: RunState = {
    runId,
    repoId: repo.id,
    workflow: workflow.name,
    status: "queued",
    prompt,
    steps: workflow.steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      status: "queued" as const,
      output: "",
    })),
    createdAt: new Date().toISOString(),
  };

  activeRuns.set(runId, state);
  saveState(state);
  appendLog(
    repo.id,
    runId,
    `Run ${runId} created for workflow "${workflow.name}" on repo "${repo.id}" (${repo.origin})`
  );
  appendEvent(repo.id, runId, { type: "run_created", workflow: workflow.name });

  runWorkflow(runId, repo, workflow, inputs, config, baseBranch).catch((err) => {
    appendLog(repo.id, runId, `Fatal error: ${err.message}`);
  });

  return runId;
}

// ── Execute a single step (dispatch to the correct executor) ────────────────

async function executeStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  llm: LLMProvider,
  repo: Repo,
  runId: string,
  config: ArchonConfig,
  state: RunState,
  sessionPath: string
): Promise<string> {
  switch (step.kind) {
    case "llm":
    case "review":
      return executeLLMStep(step, ctx, llm, repo.id, runId);
    case "shell":
      return executeShellStep(step, ctx, repo.id, sessionPath, runId, config.runner.timeout_ms);
    case "apply":
      return executeApplyStep(step, ctx, repo.id, sessionPath, runId);
    case "patch":
      return executePatchStep(step, ctx, repo.id, sessionPath, runId, config.runner.timeout_ms);
    case "edit":
      return executeEditStep(step, ctx, repo.id, sessionPath, runId);
    case "gdoc-fetch":
      return executeGDocFetchStep(step, ctx, repo.id, runId);
    case "gdoc-comment":
      return executeGDocCommentStep(step, ctx, repo.id, runId);
    case "gdoc-reply":
      return executeGDocReplyStep(step, ctx, repo.id, runId);
    case "gdoc-resolve":
      return executeGDocResolveStep(step, ctx, repo.id, runId);
    case "gdoc-suggest":
      return executeGDocSuggestStep(step, ctx, repo.id, runId);
    case "fr-fetch":
      return executeFRFetchStep(step, ctx, repo.id, runId);
    case "fr-create":
      return executeFRCreateStep(step, ctx, repo.id, runId);
    case "fr-comment":
      return executeFRCommentStep(step, ctx, repo.id, runId);
    case "workflow":
      return executeWorkflowStep(
        step, ctx, repo, repo.id, runId, config, startRun,
        (childId) => activeRuns.get(childId)
      );
    case "approval":
      return executeApprovalStep(step, ctx, repo.id, runId, state);
    case "wait-thread-reply":
      return executeWaitThreadReplyStep(step, ctx, repo.id, runId, state);
    case "har-analyze":
      return executeHarAnalyzeStep(step, ctx, repo.id, runId);
    default:
      throw new Error(
        `Unknown step kind: ${step.kind}. If you pulled a newer Archon Hub, run "npm run build" in server/ (or use "npm run dev") and restart.`
      );
  }
}

// ── Approval step executor ──────────────────────────────────────────────────

async function executeApprovalStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string,
  state: RunState
): Promise<string> {
  const prompt = step.prompt ? renderTemplate(step.prompt, ctx) : "Approval required to continue.";
  const timeoutMs = step.approvalTimeoutMs ?? 0; // 0 = wait indefinitely

  appendLog(repoId, runId, `[${step.id}] Awaiting approval: ${prompt}`);
  state.status = "awaiting_approval";
  saveState(state);
  appendEvent(repoId, runId, {
    type: "awaiting_approval",
    stepId: step.id,
    prompt,
    surface: step.surface ?? "both",
  });

  const result = await new Promise<{ by: string; comment?: string }>((resolve, reject) => {
    pendingApprovals.set(runId, { resolve, reject });
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (pendingApprovals.has(runId)) {
          pendingApprovals.delete(runId);
          reject(new Error(`Approval timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }
  });

  state.status = "running";
  saveState(state);
  appendEvent(repoId, runId, {
    type: "approved",
    stepId: step.id,
    by: result.by,
    comment: result.comment,
  });
  appendLog(repoId, runId, `[${step.id}] Approved by ${result.by}${result.comment ? ` — ${result.comment}` : ""}`);

  return `Approved by ${result.by}${result.comment ? `\nComment: ${result.comment}` : ""}`;
}

// ── Wait-thread-reply step executor ─────────────────────────────────────────

async function executeWaitThreadReplyStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string,
  state: RunState
): Promise<string> {
  const prompt = step.prompt
    ? renderTemplate(step.prompt, ctx)
    : "Please reply in this thread with the requested information.";
  const timeoutMs = step.threadReplyTimeoutMs ?? 0;
  const expectFiles = step.expectFiles ?? [];

  appendLog(repoId, runId, `[${step.id}] Awaiting thread reply: ${prompt}`);
  state.status = "awaiting_thread_reply";
  saveState(state);
  appendEvent(repoId, runId, {
    type: "awaiting_thread_reply",
    stepId: step.id,
    prompt,
    expectFiles,
  });

  const result = await new Promise<ThreadReplyPayload>((resolve, reject) => {
    pendingThreadReplies.set(runId, { resolve, reject });
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (pendingThreadReplies.has(runId)) {
          pendingThreadReplies.delete(runId);
          reject(new Error(`Thread reply timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }
  });

  state.status = "running";
  saveState(state);
  appendEvent(repoId, runId, {
    type: "thread_reply_received",
    stepId: step.id,
    by: result.by,
    fileCount: result.files.length,
  });
  appendLog(
    repoId,
    runId,
    `[${step.id}] Thread reply from ${result.by} (${result.files.length} file(s))`
  );

  const lines: string[] = ["USER REPLY:", result.text, "", "FILES:"];
  for (const f of result.files) {
    lines.push(`- ${f.kind}: ${f.path}`);
  }
  if (result.files.length === 0) lines.push("(none)");

  return lines.join("\n");
}

// ── Retry + loop wrapper ────────────────────────────────────────────────────

async function runStepWithRetryAndLoop(
  step: WorkflowStep,
  ctx: TemplateContext,
  llm: LLMProvider,
  repo: Repo,
  runId: string,
  config: ArchonConfig,
  state: RunState,
  stepIndex: number,
  sessionPath: string
): Promise<void> {
  const stepState = state.steps[stepIndex];
  const maxRetries = step.retries ?? 0;
  const baseBackoff = step.retryBackoffMs ?? 1000;
  const loopUntil = step.loopUntil;
  const maxIterations = step.maxIterations ?? 10;

  for (let iteration = 0; ; iteration++) {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const output = await executeStep(step, ctx, llm, repo, runId, config, state, sessionPath);

        stepState.output = output;
        stepState.status = "success";
        stepState.finishedAt = new Date().toISOString();
        ctx.steps[step.id] = { output };
        saveState(state);
        appendEvent(repo.id, runId, {
          type: "step_finished",
          stepId: step.id,
          stepKind: step.kind,
          status: "success",
          attempt: attempt + 1,
          iteration: iteration + 1,
        });
        lastError = undefined;
        break;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) {
          const delay = baseBackoff * Math.pow(2, attempt);
          appendLog(
            repo.id, runId,
            `[${step.id}] Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err.message}`
          );
          appendEvent(repo.id, runId, {
            type: "step_retry",
            stepId: step.id,
            attempt: attempt + 1,
            delay,
            error: err.message,
          });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    if (lastError) {
      stepState.status = "failed";
      stepState.error = lastError.message;
      stepState.finishedAt = new Date().toISOString();
      ctx.steps[step.id] = { output: lastError.message };
      appendEvent(repo.id, runId, {
        type: "step_finished",
        stepId: step.id,
        stepKind: step.kind,
        status: "failed",
        error: lastError.message,
      });

      if (!step.continueOnError) {
        appendLog(repo.id, runId, `Step "${step.id}" failed: ${lastError.message}`);
        state.status = "failed";
        state.finishedAt = new Date().toISOString();
        saveState(state);
        return;
      }

      appendLog(
        repo.id, runId,
        `Step "${step.id}" failed but continueOnError=true: ${lastError.message}`
      );
      saveState(state);
      return;
    }

    // loopUntil check
    if (!loopUntil) return;

    const rendered = renderTemplate(loopUntil, ctx).trim();
    const truthy = !!rendered && rendered !== "false" && rendered !== "no" && rendered !== "0";
    if (truthy) {
      appendLog(repo.id, runId, `[${step.id}] loopUntil satisfied after ${iteration + 1} iteration(s)`);
      return;
    }

    if (iteration + 1 >= maxIterations) {
      appendLog(repo.id, runId, `[${step.id}] loopUntil not satisfied after ${maxIterations} iterations`);
      if (!step.continueOnError) {
        stepState.status = "failed";
        stepState.error = `loopUntil not satisfied after ${maxIterations} iterations`;
        stepState.finishedAt = new Date().toISOString();
        state.status = "failed";
        state.finishedAt = new Date().toISOString();
        saveState(state);
        return;
      }
      return;
    }

    appendLog(repo.id, runId, `[${step.id}] loopUntil not yet satisfied (iteration ${iteration + 1}), re-running...`);
  }
}

// ── Gate enforcement ────────────────────────────────────────────────────────

function enforceGates(
  workflow: Workflow,
  state: RunState,
  repo: Repo,
  config: ArchonConfig,
  baseBranch?: string
): void {
  const gateIds = workflow.gates ?? [];
  if (gateIds.length === 0) return;

  const failures: { stepId: string; error: string }[] = [];
  for (const gateId of gateIds) {
    const s = state.steps.find((st) => st.id === gateId);
    if (!s) {
      failures.push({ stepId: gateId, error: "Gate step not found in workflow" });
    } else if (s.status !== "success") {
      failures.push({ stepId: gateId, error: `Step status is "${s.status}"${s.error ? `: ${s.error}` : ""}` });
    }
  }

  if (failures.length === 0) return;

  state.gateFailures = failures;
  state.status = "failed";
  state.finishedAt = new Date().toISOString();
  saveState(state);

  const summary = failures.map((f) => `  ${f.stepId}: ${f.error}`).join("\n");
  appendLog(repo.id, state.runId, `Gate check failed:\n${summary}`);
  appendEvent(repo.id, state.runId, { type: "gates_failed", failures });

  if (workflow.onGateFail?.childWorkflow) {
    appendLog(
      repo.id, state.runId,
      `Dispatching on-gate-fail child workflow: ${workflow.onGateFail.childWorkflow}`
    );
    const { findWorkflow } = require("../workflows");
    const childWf = findWorkflow(repo, workflow.onGateFail.childWorkflow);
    if (childWf) {
      startRun(
        repo, childWf, state.prompt,
        { requirement: state.prompt, parentRunId: state.runId },
        config,
        baseBranch
      ).catch((err) => {
        appendLog(repo.id, state.runId, `on-gate-fail child workflow failed to start: ${err.message}`);
      });
    } else {
      appendLog(repo.id, state.runId, `on-gate-fail workflow "${workflow.onGateFail.childWorkflow}" not found`);
    }
  }
}

// ── Main workflow runner ────────────────────────────────────────────────────

async function runWorkflow(
  runId: string,
  repo: Repo,
  workflow: Workflow,
  inputs: Record<string, string>,
  config: ArchonConfig,
  baseBranch?: string
): Promise<void> {
  const state = activeRuns.get(runId)!;
  state.status = "running";
  saveState(state);

  let llm: LLMProvider;
  try {
    llm = createLLMProvider(config);
  } catch (err: any) {
    appendLog(repo.id, runId, `LLM init failed: ${err.message}`);
    state.status = "failed";
    state.finishedAt = new Date().toISOString();
    saveState(state);
    return;
  }

  const useIsolation = workflow.isolation !== "none";

  let session: RepoSession | undefined;
  try {
    session = await acquireSession({
      repo,
      baseBranch,
      runId,
      workflowName: workflow.name,
      keepWorkspace: (workflow as any).keepWorkspace === true,
    });
    state.branch = session.runBranch;
    state.baseBranch = session.baseBranch;
    saveState(state);
    appendLog(
      repo.id, runId,
      `Session acquired: branch=${session.runBranch} base=${session.baseBranch} path=${session.path}`
    );
  } catch (err: any) {
    appendLog(repo.id, runId, `Session acquisition failed: ${err.message}`);
    state.status = "failed";
    state.finishedAt = new Date().toISOString();
    saveState(state);
    return;
  }

  try {
    const ctx: TemplateContext = {
      inputs: { ...inputs, requirement: inputs.requirement ?? state.prompt },
      steps: {},
    };

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const stepState = state.steps[i];

      if (step.when) {
        const rendered = renderTemplate(step.when, ctx).trim();
        const falsy = !rendered || rendered === "false" || rendered === "no" || rendered === "0";
        if (falsy) {
          stepState.status = "success";
          stepState.output = `(skipped — when condition evaluated to "${rendered}")`;
          stepState.startedAt = new Date().toISOString();
          stepState.finishedAt = new Date().toISOString();
          ctx.steps[step.id] = { output: stepState.output };
          saveState(state);
          appendLog(
            repo.id, runId,
            `--- Step ${i + 1}/${workflow.steps.length}: ${step.id} SKIPPED (when="${step.when}" → "${rendered}") ---`
          );
          appendEvent(repo.id, runId, { type: "step_skipped", stepId: step.id });
          continue;
        }
      }

      stepState.status = "running";
      stepState.startedAt = new Date().toISOString();
      saveState(state);

      appendLog(
        repo.id, runId,
        `--- Step ${i + 1}/${workflow.steps.length}: ${step.id} (${step.kind}) ---`
      );
      appendEvent(repo.id, runId, {
        type: "step_started",
        stepId: step.id,
        stepKind: step.kind,
        stepIndex: i + 1,
        totalSteps: workflow.steps.length,
      });

      await runStepWithRetryAndLoop(step, ctx, llm, repo, runId, config, state, i, session.path);

      if ((state.status as string) === "failed") return;
    }

    // Gate enforcement
    enforceGates(workflow, state, repo, config, baseBranch);
    if ((state.status as string) === "failed") return;

    // Auto-commit + push + open PR for isolated runs
    if (useIsolation) {
      try {
        const hasChanges = await session.hasUncommittedChanges();
        if (hasChanges) {
          await session.commitAll(`chore(archon): ${runId.slice(0, 8)} workflow results`);
          appendLog(repo.id, runId, `Committed changes on branch ${session.runBranch}`);
        }

        await session.pushRunBranch();
        appendLog(repo.id, runId, `Pushed branch ${session.runBranch} to origin`);

        const pr = await session.openPR({
          title: `[archon] ${workflow.name}: ${state.prompt.slice(0, 80)}`,
          body: [
            `Automated PR from Archon Hub workflow **${workflow.name}**.`,
            "",
            `**Run ID:** \`${runId}\``,
            `**Base branch:** \`${session.baseBranch}\``,
            `**Prompt:** ${state.prompt}`,
          ].join("\n"),
          baseBranch: session.baseBranch,
        });
        state.prUrl = pr.url;
        appendLog(repo.id, runId, `PR_URL=${pr.url}`);
      } catch (err: any) {
        appendLog(repo.id, runId, `Post-run git/PR step failed (non-fatal): ${err.message}`);
      }
    }

    state.status = "success";
    state.finishedAt = new Date().toISOString();
    saveState(state);
    appendLog(repo.id, runId, `Run ${runId} completed successfully`);
    appendEvent(repo.id, runId, { type: "run_finished", status: "success" });
  } finally {
    if (session) {
      await session.cleanup();
      appendLog(repo.id, runId, `Session cleaned up`);
    }
  }
}

/**
 * Execute a single step from a workflow in-memory (no persisted run).
 * Used by /api/harness/route for dry-run routing.
 * Only llm/review steps are supported (no working tree needed).
 */
export async function runSingleStep(
  repo: Repo,
  workflow: Workflow,
  stepId: string,
  inputs: Record<string, string>,
  config: ArchonConfig
): Promise<string> {
  const step = workflow.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found in workflow "${workflow.name}"`);

  const llm = createLLMProvider(config);
  const ctx: TemplateContext = {
    inputs: { ...inputs, requirement: inputs.requirement ?? "" },
    steps: {},
  };

  const dryRunId = `dry-${Date.now()}`;

  switch (step.kind) {
    case "llm":
    case "review":
      return executeLLMStep(step, ctx, llm, repo.id, dryRunId);
    default:
      throw new Error(
        `runSingleStep only supports llm/review steps, got "${step.kind}"`
      );
  }
}

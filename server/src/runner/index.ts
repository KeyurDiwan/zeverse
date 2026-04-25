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
import { appendLog, appendEvent, RunState, saveState } from "./state";
import type { TemplateContext } from "./template";
import { renderTemplate } from "./template";
import { assertCleanTree, createRunBranch, restoreBranch, runLock } from "./git";

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

// ── Start a run ─────────────────────────────────────────────────────────────

export async function startRun(
  repo: Repo,
  workflow: Workflow,
  prompt: string,
  inputs: Record<string, string>,
  config: ArchonConfig
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
    `Run ${runId} created for workflow "${workflow.name}" on repo "${repo.id}" (${repo.path})`
  );
  appendEvent(repo.id, runId, { type: "run_created", workflow: workflow.name });

  runWorkflow(runId, repo, workflow, inputs, config).catch((err) => {
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
  state: RunState
): Promise<string> {
  switch (step.kind) {
    case "llm":
    case "review":
      return executeLLMStep(step, ctx, llm, repo.id, runId);
    case "shell":
      return executeShellStep(step, ctx, repo, runId, config.runner.timeout_ms);
    case "apply":
      return executeApplyStep(step, ctx, repo, runId);
    case "patch":
      return executePatchStep(step, ctx, repo, runId, config.runner.timeout_ms);
    case "edit":
      return executeEditStep(step, ctx, repo, runId);
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

// ── Retry + loop wrapper ────────────────────────────────────────────────────

async function runStepWithRetryAndLoop(
  step: WorkflowStep,
  ctx: TemplateContext,
  llm: LLMProvider,
  repo: Repo,
  runId: string,
  config: ArchonConfig,
  state: RunState,
  stepIndex: number
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
        const output = await executeStep(step, ctx, llm, repo, runId, config, state);

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
  config: ArchonConfig
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
        config
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
  config: ArchonConfig
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

  const doRun = async () => {
    let previousBranch: string | undefined;

    if (useIsolation) {
      try {
        await assertCleanTree(repo);
      } catch (err: any) {
        appendLog(repo.id, runId, `Isolation check failed: ${err.message}`);
        state.status = "failed";
        state.finishedAt = new Date().toISOString();
        saveState(state);
        return;
      }

      const branchName = `archon/${workflow.name}/${runId.slice(0, 8)}`;
      try {
        previousBranch = await createRunBranch(repo, branchName);
        state.branch = branchName;
        saveState(state);
        appendLog(repo.id, runId, `Created run branch: ${branchName} (was: ${previousBranch})`);
      } catch (err: any) {
        appendLog(repo.id, runId, `Branch creation failed: ${err.message}`);
        state.status = "failed";
        state.finishedAt = new Date().toISOString();
        saveState(state);
        return;
      }
    }

    try {
      const ctx: TemplateContext = {
        inputs: { ...inputs, requirement: inputs.requirement ?? state.prompt },
        steps: {},
      };

      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        const stepState = state.steps[i];

        // `when` conditional guard
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

        await runStepWithRetryAndLoop(step, ctx, llm, repo, runId, config, state, i);

        // If the step (or retry/loop wrapper) failed the run, bail.
        if (state.status === "failed") return;
      }

      // Gate enforcement
      enforceGates(workflow, state, repo, config);
      if (state.status === "failed") return;

      state.status = "success";
      state.finishedAt = new Date().toISOString();
      saveState(state);
      appendLog(repo.id, runId, `Run ${runId} completed successfully`);
      appendEvent(repo.id, runId, { type: "run_finished", status: "success" });
    } finally {
      if (useIsolation && previousBranch) {
        await restoreBranch(repo, previousBranch);
        appendLog(repo.id, runId, `Restored branch: ${previousBranch}`);
      }
    }
  };

  if (useIsolation) {
    await runLock(repo.id, doRun);
  } else {
    await doRun();
  }
}

/**
 * Execute a single step from a workflow in-memory (no persisted run).
 * Used by /api/harness/route for dry-run routing.
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
    case "shell":
      return executeShellStep(step, ctx, repo, dryRunId, config.runner.timeout_ms);
    default:
      throw new Error(
        `runSingleStep only supports llm/review/shell steps, got "${step.kind}"`
      );
  }
}

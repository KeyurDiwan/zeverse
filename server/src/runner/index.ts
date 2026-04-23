import { v4 as uuidv4 } from "uuid";
import type { ArchonConfig } from "../config";
import { createLLMProvider, LLMProvider } from "../llm";
import type { Workflow } from "../workflows";
import type { Repo } from "../repos";
import {
  executeApplyStep,
  executeEditStep,
  executeLLMStep,
  executePatchStep,
  executeShellStep,
} from "./executors";
import {
  executeGDocFetchStep,
  executeGDocCommentStep,
} from "./executors-gdoc";
import { appendLog, RunState, saveState } from "./state";
import type { TemplateContext } from "./template";

const activeRuns = new Map<string, RunState>();

export function getActiveRun(runId: string): RunState | undefined {
  return activeRuns.get(runId);
}

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

  runWorkflow(runId, repo, workflow, inputs, config).catch((err) => {
    appendLog(repo.id, runId, `Fatal error: ${err.message}`);
  });

  return runId;
}

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

  const ctx: TemplateContext = {
    inputs: { ...inputs, requirement: inputs.requirement ?? state.prompt },
    steps: {},
  };

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const stepState = state.steps[i];

    stepState.status = "running";
    stepState.startedAt = new Date().toISOString();
    saveState(state);

    appendLog(
      repo.id,
      runId,
      `--- Step ${i + 1}/${workflow.steps.length}: ${step.id} (${step.kind}) ---`
    );

    try {
      let output: string;

      switch (step.kind) {
        case "llm":
        case "review":
          output = await executeLLMStep(step, ctx, llm, repo.id, runId);
          break;
        case "shell":
          output = await executeShellStep(step, ctx, repo, runId, config.runner.timeout_ms);
          break;
        case "apply":
          output = await executeApplyStep(step, ctx, repo, runId);
          break;
        case "patch":
          output = await executePatchStep(
            step,
            ctx,
            repo,
            runId,
            config.runner.timeout_ms
          );
          break;
        case "edit":
          output = await executeEditStep(step, ctx, repo, runId);
          break;
        case "gdoc-fetch":
          output = await executeGDocFetchStep(step, ctx, repo.id, runId);
          break;
        case "gdoc-comment":
          output = await executeGDocCommentStep(step, ctx, repo.id, runId);
          break;
        default:
          throw new Error(`Unknown step kind: ${step.kind}`);
      }

      stepState.output = output;
      stepState.status = "success";
      stepState.finishedAt = new Date().toISOString();
      ctx.steps[step.id] = { output };
      saveState(state);
    } catch (err: any) {
      stepState.status = "failed";
      stepState.error = err.message;
      stepState.finishedAt = new Date().toISOString();
      ctx.steps[step.id] = { output: err.message };

      if (!step.continueOnError) {
        appendLog(repo.id, runId, `Step "${step.id}" failed: ${err.message}`);
        state.status = "failed";
        state.finishedAt = new Date().toISOString();
        saveState(state);
        return;
      }

      appendLog(
        repo.id,
        runId,
        `Step "${step.id}" failed but continueOnError=true: ${err.message}`
      );
      saveState(state);
    }
  }

  state.status = "success";
  state.finishedAt = new Date().toISOString();
  saveState(state);
  appendLog(repo.id, runId, `Run ${runId} completed successfully`);
}

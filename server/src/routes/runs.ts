import { Router, Request, Response } from "express";
import { loadConfig } from "../config";
import { findWorkflow } from "../workflows";
import { requireRepo } from "../repos";
import { startRun, getActiveRun } from "../runner";
import { findStateByRunId, loadState, readLog } from "../runner/state";

export const runRoutes = Router();

runRoutes.post("/run-workflow", async (req: Request, res: Response) => {
  try {
    const { repoId, workflow: workflowName, prompt, inputs } = req.body ?? {};

    if (!repoId) {
      res.status(400).json({ error: "repoId is required" });
      return;
    }
    if (!workflowName) {
      res.status(400).json({ error: "workflow is required" });
      return;
    }

    const repo = requireRepo(repoId);
    const workflow = findWorkflow(repo, workflowName);
    if (!workflow) {
      res
        .status(404)
        .json({ error: `Workflow "${workflowName}" not found in repo "${repoId}"` });
      return;
    }

    const config = loadConfig();
    const mergedInputs: Record<string, string> = {
      ...(inputs ?? {}),
      requirement: prompt ?? inputs?.requirement ?? "",
    };

    const runId = await startRun(repo, workflow, prompt ?? "", mergedInputs, config);
    res.json({ runId, repoId: repo.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

runRoutes.get("/runs/:id", (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const repoId = req.query.repoId ? String(req.query.repoId) : undefined;

  const state =
    getActiveRun(id) ??
    (repoId ? loadState(repoId, id) : findStateByRunId(id));

  if (!state) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(state);
});

runRoutes.get("/logs/:id", (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  const offset = parseInt(String(req.query.offset ?? "0"), 10);
  let repoId = req.query.repoId ? String(req.query.repoId) : undefined;

  if (!repoId) {
    const state = findStateByRunId(id);
    repoId = state?.repoId;
  }
  if (!repoId) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const { content, nextOffset } = readLog(repoId, id, offset);
  res.json({ content, nextOffset });
});

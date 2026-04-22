import { Router, Request, Response } from "express";
import { loadWorkflows } from "../workflows";
import { requireRepo } from "../repos";

export const workflowRoutes = Router();

workflowRoutes.get("/workflows", (req: Request, res: Response) => {
  try {
    const repoId = String(req.query.repoId ?? "");
    if (!repoId) {
      res.status(400).json({ error: "repoId query param is required" });
      return;
    }

    const repo = requireRepo(repoId);
    const workflows = loadWorkflows(repo).map((w) => ({
      name: w.name,
      description: w.description,
      inputs: w.inputs,
      steps: w.steps.map((s) => ({ id: s.id, kind: s.kind })),
    }));
    res.json({ workflows });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

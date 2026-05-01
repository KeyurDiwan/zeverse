import { Router, Request, Response } from "express";
import { addGitRepo, listRepos, removeRepo, requireRepo } from "../repos";
import { refreshWorkflowsCache } from "../workflows";
import { loadConfig } from "../config";
import { buildBootstrapRulesWorkflow } from "../runner/bootstrap-rules-workflow";
import { startRun } from "../runner";
import { indexRepo } from "../index/indexer";

export const repoRoutes = Router();

repoRoutes.get("/repos", (_req: Request, res: Response) => {
  res.json({ repos: listRepos() });
});

repoRoutes.post("/repos", (req: Request, res: Response) => {
  try {
    const { url, name } = req.body ?? {};

    if (!url) {
      res.status(400).json({ error: "'url' is required" });
      return;
    }

    const repo = addGitRepo({ url, name });
    const config = loadConfig();
    if (
      config.index?.enabled &&
      config.index.postgres_url?.trim() &&
      config.index.watcher?.on_repo_add
    ) {
      void indexRepo({
        hubConfig: config,
        indexConfig: config.index,
        repo,
        full: true,
      }).catch((e: any) =>
        console.warn(`[repos] background index failed for ${repo.id}: ${e.message}`)
      );
    }
    res.status(201).json({ repo });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

repoRoutes.delete("/repos/:id", (req: Request<{ id: string }>, res: Response) => {
  const ok = removeRepo(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Repo not found" });
    return;
  }
  res.json({ ok: true });
});

repoRoutes.post("/repos/:id/refresh-workflows", (req: Request<{ id: string }>, res: Response) => {
  try {
    const repo = requireRepo(req.params.id);
    refreshWorkflowsCache(repo);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

repoRoutes.post("/repos/:id/reindex", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const repo = requireRepo(req.params.id);
    const config = loadConfig();
    if (!config.index?.enabled || !config.index.postgres_url?.trim()) {
      res.status(400).json({
        error:
          "Index disabled or postgres_url missing — enable index.enabled and set POSTGRES_URL in config/zeverse.yaml",
      });
      return;
    }
    const full = !!(req.body && req.body.full);
    void indexRepo({
      hubConfig: config,
      indexConfig: config.index,
      repo,
      full,
    }).then(
      (r) => console.log(`[reindex] ${repo.id}`, r),
      (e: Error) => console.error(`[reindex] ${repo.id}`, e)
    );
    res.json({ accepted: true, repoId: repo.id, full });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

repoRoutes.post("/repos/:id/bootstrap-rules", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const repo = requireRepo(req.params.id);
    const config = loadConfig();
    const workflow = buildBootstrapRulesWorkflow(repo);
    const runId = await startRun(
      repo, workflow, "Bootstrap AI rules & skills", {}, config
    );
    res.json({ runId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

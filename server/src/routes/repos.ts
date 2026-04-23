import { Router, Request, Response } from "express";
import { addGitRepo, listRepos, removeRepo } from "../repos";

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

import { Router, Request, Response } from "express";
import { addGitRepo, addLocalRepo, listRepos, removeRepo } from "../repos";

export const repoRoutes = Router();

repoRoutes.get("/repos", (_req: Request, res: Response) => {
  res.json({ repos: listRepos() });
});

repoRoutes.post("/repos", (req: Request, res: Response) => {
  try {
    const { path: localPath, url, name } = req.body ?? {};

    if (!localPath && !url) {
      res.status(400).json({ error: "Either 'path' or 'url' is required" });
      return;
    }

    const repo = url
      ? addGitRepo({ url, name })
      : addLocalRepo({ path: localPath, name });

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

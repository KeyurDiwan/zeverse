import { Router, Request, Response } from "express";
import { listRepos } from "../repos";
import { loadConfig } from "../config";
import { createLLMProvider } from "../llm";

export const inferRoutes = Router();

inferRoutes.post("/infer-repo", async (req: Request, res: Response) => {
  try {
    const { prompt } = req.body ?? {};
    if (!prompt) {
      res.status(400).json({ repoId: null, reason: "No prompt provided" });
      return;
    }

    const repos = listRepos();
    if (repos.length === 0) {
      res.json({ repoId: null, reason: "No repos registered" });
      return;
    }

    if (repos.length === 1) {
      res.json({ repoId: repos[0].id, reason: "Only one repo registered" });
      return;
    }

    const repoList = repos
      .map((r) => `- id: ${r.id} | name: ${r.name} | origin: ${r.origin ?? "local"}`)
      .join("\n");

    const llm = createLLMProvider(loadConfig());
    const response = await llm.chat([
      {
        role: "system",
        content: [
          "You pick the best-matching repository for a user request.",
          "Respond with ONLY a JSON object: { \"repoId\": \"<id>\" | null, \"reason\": \"<short reason>\" }",
          "Return null for repoId if the request doesn't clearly match any repo.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Available repos:\n${repoList}\n\nUser request: ${prompt}`,
      },
    ]);

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.json({ repoId: null, reason: "LLM did not return valid JSON" });
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const repoId = typeof parsed.repoId === "string" ? parsed.repoId : null;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";

    if (repoId && !repos.some((r) => r.id === repoId)) {
      res.json({ repoId: null, reason: `LLM returned unknown repo id: ${repoId}` });
      return;
    }

    res.json({ repoId, reason });
  } catch (err: any) {
    res.status(500).json({ repoId: null, reason: `Inference failed: ${err.message}` });
  }
});

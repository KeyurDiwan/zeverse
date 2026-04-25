import { Router, Request, Response } from "express";
import { listRepos, requireRepo } from "../repos";
import { loadConfig } from "../config";
import { createLLMProvider } from "../llm";
import { loadWorkflows } from "../workflows";
import { matchWorkflowKeyword } from "../workflow-infer";

export const smartReplyRoutes = Router();

function extractFreshreleaseTaskUrl(text: string): string | undefined {
  const m = text.match(
    /https?:\/\/[^\s]+freshrelease\.com\/ws\/[^/\s]+\/tasks\/[^\s)]+/i
  );
  return m?.[0];
}

function containsActionUrl(text: string): boolean {
  return (
    /freshrelease\.com\/ws\/.*\/tasks\//i.test(text) ||
    /docs\.google\.com\/document\/d\//i.test(text) ||
    /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(text)
  );
}

interface SmartReplyResponse {
  type: "answer" | "clarify" | "workflow";
  answer?: string;
  question?: string;
  missing?: string[];
  workflow?: string;
  inputs?: Record<string, string>;
  repoId: string | null;
  confidence: number;
  reason: string;
}

async function inferRepoId(prompt: string): Promise<{ repoId: string | null; reason: string }> {
  const repos = listRepos();
  if (repos.length === 0) return { repoId: null, reason: "No repos registered" };
  if (repos.length === 1) return { repoId: repos[0].id, reason: "Only one repo registered" };

  const repoList = repos
    .map((r) => `- id: ${r.id} | name: ${r.name} | origin: ${r.origin ?? "local"}`)
    .join("\n");

  const llm = createLLMProvider(loadConfig());
  const response = await llm.chat([
    {
      role: "system",
      content: [
        "You pick the best-matching repository for a user request.",
        'Respond with ONLY a JSON object: { "repoId": "<id>" | null, "reason": "<short reason>" }',
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
  if (!jsonMatch) return { repoId: null, reason: "LLM did not return valid JSON" };

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const repoId = typeof parsed.repoId === "string" ? parsed.repoId : null;
    if (repoId && !repos.some((r) => r.id === repoId)) {
      return { repoId: null, reason: `LLM returned unknown repo id: ${repoId}` };
    }
    return { repoId, reason: parsed.reason ?? "" };
  } catch {
    return { repoId: null, reason: "Failed to parse LLM JSON" };
  }
}

smartReplyRoutes.post("/smart-reply", async (req: Request, res: Response) => {
  try {
    const { prompt, threadContext, repoId: requestedRepoId, surface } = req.body ?? {};
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    let repoId: string | null = requestedRepoId ?? null;

    if (!repoId) {
      const inferred = await inferRepoId(prompt);
      repoId = inferred.repoId;
    }

    // Short-circuit: if the prompt contains an actionable URL and we have a repo,
    // delegate to keyword-based workflow routing.
    if (repoId && containsActionUrl(prompt)) {
      let repo;
      try {
        repo = requireRepo(repoId);
      } catch {
        // fall through to LLM
      }
      if (repo) {
        const workflows = loadWorkflows(repo);
        const workflowNames = new Set(workflows.map((w) => w.name));
        const keywordWorkflow = matchWorkflowKeyword(prompt, workflowNames);
        if (keywordWorkflow) {
          const inputs: Record<string, string> = { requirement: prompt };
          const frUrl = extractFreshreleaseTaskUrl(prompt);
          if (frUrl) inputs.frUrl = frUrl;

          res.json({
            type: "workflow",
            workflow: keywordWorkflow,
            inputs,
            repoId,
            confidence: 0.95,
            reason: `URL-based routing → ${keywordWorkflow}`,
          } satisfies SmartReplyResponse);
          return;
        }
      }
    }

    // Build the workflow catalog for context (if repo exists)
    let workflowCatalog = "";
    let workflowNames = new Set<string>();
    if (repoId) {
      try {
        const repo = requireRepo(repoId);
        const workflows = loadWorkflows(repo);
        workflowNames = new Set(workflows.map((w) => w.name));
        workflowCatalog = workflows
          .map((w) => {
            const inputList = w.inputs
              .map((inp) => `${inp.id}${inp.required ? " (required)" : ""}: ${inp.label}`)
              .join("; ");
            return `- ${w.name}: ${w.description} [inputs: ${inputList}]`;
          })
          .join("\n");
      } catch {
        // repo missing on disk — proceed without catalog
      }
    }

    const repos = listRepos();
    const repoList = repos.map((r) => `- ${r.id}: ${r.name}`).join("\n");

    const systemPrompt = [
      "You are an intelligent Slack assistant for a software team.",
      "You receive a user's message (and optionally prior thread context).",
      "Decide the best action and respond with ONLY a JSON object (no markdown fences).",
      "",
      '{ "type": "answer" | "clarify" | "workflow",',
      '  "answer": "...",',
      '  "question": "...",',
      '  "missing": ["repoId", ...],',
      '  "workflow": "<name>",',
      '  "inputs": { ... },',
      '  "repoId": "<id>" | null,',
      '  "confidence": 0.0..1.0,',
      '  "reason": "..." }',
      "",
      "Rules:",
      '- type="answer": you can answer the question right now from general knowledge or the thread context. Put the full answer in "answer". Use markdown formatting (Slack mrkdwn).',
      '- type="clarify": the user\'s request is unclear or missing critical info (e.g. no repo specified when multiple exist, ambiguous target, missing URL). Put 1-2 focused clarifying questions in "question". List what is missing in "missing".',
      '- type="workflow": the user clearly wants an action (fix a bug, raise a PR, analyze a doc, write tests, review code, etc.) and you have enough info to pick a workflow. Set "workflow" and "inputs".',
      "",
      "Preferences:",
      "- STRONGLY prefer answering when possible. Only use clarify if something critical is truly missing.",
      "- For general questions, greetings, or knowledge questions, always answer directly.",
      "- Only pick workflow when the intent is clearly an executable action (not a question about how something works).",
      '- If the user just says "help" or "hi", answer with a friendly greeting and list what you can do.',
      "- When answering, be concise but helpful. Don't be robotic.",
      "- For the inputs field, map prompt content to the workflow's declared inputs. The main text usually goes in 'requirement'.",
      "",
      repoId ? `Current repo: ${repoId}` : "No repo selected yet.",
      repos.length > 0 ? `Available repos:\n${repoList}` : "No repos registered.",
      workflowCatalog ? `Available workflows for ${repoId}:\n${workflowCatalog}` : "",
    ].join("\n");

    const userContent = threadContext
      ? `Thread context:\n${threadContext}\n\nLatest message:\n${prompt}`
      : prompt;

    const llm = createLLMProvider(loadConfig());
    const response = await llm.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ]);

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      res.json({
        type: "answer",
        answer: text || "Sorry, I couldn't process that. Could you rephrase?",
        repoId,
        confidence: 0.3,
        reason: "LLM did not return structured JSON, using raw text as answer",
      } satisfies SmartReplyResponse);
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      res.json({
        type: "answer",
        answer: text,
        repoId,
        confidence: 0.3,
        reason: "LLM returned unparseable JSON",
      } satisfies SmartReplyResponse);
      return;
    }

    const type = ["answer", "clarify", "workflow"].includes(parsed.type) ? parsed.type : "answer";
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;

    // Validate workflow choice
    if (type === "workflow") {
      const wf = parsed.workflow;
      if (!wf || !workflowNames.has(wf)) {
        res.json({
          type: "answer",
          answer: parsed.answer || `I'd like to run a workflow but "${wf}" isn't available. Could you clarify what you need?`,
          repoId: parsed.repoId ?? repoId,
          confidence: 0.4,
          reason: `LLM picked unknown workflow "${wf}"`,
        } satisfies SmartReplyResponse);
        return;
      }
    }

    res.json({
      type,
      answer: parsed.answer,
      question: parsed.question,
      missing: Array.isArray(parsed.missing) ? parsed.missing : undefined,
      workflow: parsed.workflow,
      inputs: typeof parsed.inputs === "object" ? parsed.inputs : undefined,
      repoId: parsed.repoId ?? repoId,
      confidence,
      reason: parsed.reason ?? "",
    } satisfies SmartReplyResponse);
  } catch (err: any) {
    res.status(500).json({
      type: "answer",
      answer: "Sorry, something went wrong on my end. Please try again.",
      repoId: null,
      confidence: 0,
      reason: `smart-reply error: ${err.message}`,
    });
  }
});

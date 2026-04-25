import { Router, Request, Response } from "express";
import { listRepos, requireRepo } from "../repos";
import { loadConfig } from "../config";
import { createLLMProvider } from "../llm";
import { loadWorkflows } from "../workflows";
import { matchWorkflowKeyword } from "../workflow-infer";

export const routeIntentRoutes = Router();

function extractFreshreleaseTaskUrl(text: string): string | undefined {
  const m = text.match(
    /https?:\/\/[^\s]+freshrelease\.com\/ws\/[^/\s]+\/tasks\/[^\s)]+/i
  );
  return m?.[0];
}

interface RouteIntentResponse {
  repoId: string | null;
  workflow: string;
  inputs: Record<string, string>;
  confidence: number;
  reason: string;
  fallback: boolean;
}

const FALLBACK_WORKFLOW = "ask";
const CONFIDENCE_THRESHOLD = 0.6;

async function inferRepoId(prompt: string): Promise<string | null> {
  const repos = listRepos();
  if (repos.length === 0) return null;
  if (repos.length === 1) return repos[0].id;

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
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const repoId = typeof parsed.repoId === "string" ? parsed.repoId : null;
    if (repoId && !repos.some((r) => r.id === repoId)) return null;
    return repoId;
  } catch {
    return null;
  }
}

routeIntentRoutes.post("/route-intent", async (req: Request, res: Response) => {
  try {
    const { prompt, repoId: requestedRepoId } = req.body ?? {};
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    let repoId: string | null = requestedRepoId ?? null;

    if (!repoId) {
      repoId = await inferRepoId(prompt);
    }

    if (!repoId) {
      res.json({
        repoId: null,
        workflow: FALLBACK_WORKFLOW,
        inputs: {},
        confidence: 0,
        reason: "Could not determine repo",
        fallback: true,
      } satisfies RouteIntentResponse);
      return;
    }

    let repo;
    try {
      repo = requireRepo(repoId);
    } catch {
      res.json({
        repoId: null,
        workflow: FALLBACK_WORKFLOW,
        inputs: {},
        confidence: 0,
        reason: `Repo "${repoId}" not found or missing on disk`,
        fallback: true,
      } satisfies RouteIntentResponse);
      return;
    }

    const workflows = loadWorkflows(repo);
    if (workflows.length === 0) {
      res.json({
        repoId,
        workflow: FALLBACK_WORKFLOW,
        inputs: {},
        confidence: 0,
        reason: "No workflows found in repo",
        fallback: true,
      } satisfies RouteIntentResponse);
      return;
    }

    const workflowNames = new Set(workflows.map((w) => w.name));

    // Same keyword ordering as `/api/infer-workflow` so harness matches the Hub UI / Slack
    // parser (e.g. "analyze fr <url>" → fr-analyze, not fr-task-finisher).
    const keywordWorkflow = matchWorkflowKeyword(prompt, workflowNames);
    if (keywordWorkflow) {
      const frNeedsUrl =
        keywordWorkflow === "fr-analyze" || keywordWorkflow === "fr-task-finisher";
      const frUrl = extractFreshreleaseTaskUrl(prompt);
      if (!frNeedsUrl || frUrl) {
        const inputs: Record<string, string> = { requirement: prompt };
        if (frNeedsUrl && frUrl) inputs.frUrl = frUrl;
        res.json({
          repoId,
          workflow: keywordWorkflow,
          inputs,
          confidence: 0.95,
          reason: `Keyword routing → ${keywordWorkflow}`,
          fallback: false,
        } satisfies RouteIntentResponse);
        return;
      }
    }

    const workflowCatalog = workflows
      .map((w) => {
        const inputList = w.inputs
          .map((inp) => `${inp.id}${inp.required ? " (required)" : ""}: ${inp.label}`)
          .join("; ");
        return `- name: ${w.name} | description: ${w.description} | inputs: [${inputList}]`;
      })
      .join("\n");

    const llm = createLLMProvider(loadConfig());
    const response = await llm.chat([
      {
        role: "system",
        content: [
          "You are a smart intent router for a software development assistant.",
          "Given a user prompt and a list of available workflows, pick the single best workflow.",
          "Also extract values for any workflow inputs that the prompt implicitly provides.",
          "",
          "Respond with ONLY a JSON object (no markdown fences, no prose):",
          '{',
          '  "workflow": "<workflow name from the list>",',
          '  "inputs": { "<inputId>": "<extracted value>", ... },',
          '  "confidence": <0.0 to 1.0>,',
          '  "reason": "<one sentence explaining the pick>"',
          '}',
          "",
          "Rules:",
          '- confidence 0.9+ : prompt clearly matches a specific workflow.',
          '- confidence 0.6-0.9 : reasonable match but some ambiguity.',
          '- confidence < 0.6 : no good match; set workflow to "ask".',
          '- For the "inputs" field, map prompt content to the workflow\'s declared inputs.',
          '  The main prompt text should go into the primary required input (usually "requirement", "bug", or "focus").',
          '- If the prompt is a general question, explanation request, or does not match any workflow well, use "ask".',
          '- ONLY use workflow names from the provided list.',
          "",
          "Routing hints for common intents:",
          '- "analyze FR card" / "analyze fr …" → "fr-analyze" (set inputs.frUrl from task URL)',
          '- Freshrelease task URL without analyze intent → "fr-task-finisher" (set inputs.frUrl)',
          '- "create epic/task/card" → "fr-card-creator"',
          '- "write tests for <file>" → "test-write" (set inputs.target)',
          '- "raise/open/create PR" → "pr-raise"',
          '- "review PR" or GitHub PR URL → "code-review" (set inputs.pr)',
          '- Google Doc URL or "PRD" → "prd-analysis" (set inputs.docUrl)',
          '- Bug fix request → "fix-bug"',
        ].join("\n"),
      },
      {
        role: "user",
        content: `Available workflows:\n${workflowCatalog}\n\nUser prompt: ${prompt}`,
      },
    ]);

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      res.json({
        repoId,
        workflow: FALLBACK_WORKFLOW,
        inputs: { requirement: prompt },
        confidence: 0,
        reason: "LLM did not return valid JSON",
        fallback: true,
      } satisfies RouteIntentResponse);
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      res.json({
        repoId,
        workflow: FALLBACK_WORKFLOW,
        inputs: { requirement: prompt },
        confidence: 0,
        reason: "LLM returned unparseable JSON",
        fallback: true,
      } satisfies RouteIntentResponse);
      return;
    }

    const workflow = typeof parsed.workflow === "string" ? parsed.workflow : FALLBACK_WORKFLOW;
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    const inputs =
      typeof parsed.inputs === "object" && parsed.inputs !== null ? parsed.inputs : {};

    if (!workflowNames.has(workflow) || confidence < CONFIDENCE_THRESHOLD) {
      res.json({
        repoId,
        workflow: FALLBACK_WORKFLOW,
        inputs: { requirement: prompt, ...inputs },
        confidence,
        reason: !workflowNames.has(workflow)
          ? `LLM picked unknown workflow "${workflow}" — falling back to ask`
          : reason || "Low confidence",
        fallback: true,
      } satisfies RouteIntentResponse);
      return;
    }

    res.json({
      repoId,
      workflow,
      inputs: { requirement: prompt, ...inputs },
      confidence,
      reason,
      fallback: false,
    } satisfies RouteIntentResponse);
  } catch (err: any) {
    res.status(500).json({
      error: `Route-intent failed: ${err.message}`,
      workflow: FALLBACK_WORKFLOW,
      fallback: true,
    });
  }
});

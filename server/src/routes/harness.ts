import { Router, Request, Response } from "express";
import { listRepos, requireRepo } from "../repos";
import { loadConfig } from "../config";
import { createLLMProvider } from "../llm";
import { loadWorkflows, findWorkflow, loadRepoRules } from "../workflows";
import { matchWorkflowKeyword } from "../workflow-infer";
import { startRun, runSingleStep } from "../runner";
import { assertAllowed, appendAuditLog, PolicyError } from "../policy";

export const harnessRoutes = Router();

function extractFreshreleaseTaskUrl(text: string): string | undefined {
  const m = text.match(
    /https?:\/\/[^\s]+freshrelease\.com\/ws\/[^/\s]+\/tasks\/[^\s)]+/i
  );
  return m?.[0];
}

interface HarnessRouteResponse {
  type: "proposal" | "answer" | "clarify";
  repoId: string | null;
  workflow?: string;
  inputs?: Record<string, string>;
  alternatives?: string[];
  confidence: number;
  reason: string;
  answer?: string;
  question?: string;
  missing?: string[];
}

const CONFIDENCE_THRESHOLD = 0.6;

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

/**
 * POST /api/harness/route
 *
 * Unified routing: repo pick -> keyword shortcut -> harness.yaml dry-run -> proposal/answer/clarify.
 */
harnessRoutes.post("/harness/route", async (req: Request, res: Response) => {
  try {
    const { prompt, repoId: requestedRepoId, threadContext, surface } = req.body ?? {};
    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    let repoId: string | null = requestedRepoId ?? null;

    if (!repoId) {
      const inferred = await inferRepoId(prompt);
      repoId = inferred.repoId;
    }

    if (!repoId) {
      const repos = listRepos();
      if (repos.length === 0) {
        res.json({
          type: "clarify",
          repoId: null,
          question: "No repositories are registered. Import a repo first.",
          missing: ["repoId"],
          confidence: 0,
          reason: "No repos available",
        } satisfies HarnessRouteResponse);
      } else {
        res.json({
          type: "clarify",
          repoId: null,
          question: `Which repository should I work with?\n${repos.map((r) => `- \`${r.id}\`: ${r.name}`).join("\n")}`,
          missing: ["repoId"],
          confidence: 0,
          reason: "Could not determine repo from prompt",
        } satisfies HarnessRouteResponse);
      }
      return;
    }

    let repo;
    try {
      repo = requireRepo(repoId);
    } catch {
      res.json({
        type: "clarify",
        repoId: null,
        question: `Repo "${repoId}" not found. Which repo should I use?`,
        missing: ["repoId"],
        confidence: 0,
        reason: `Repo "${repoId}" not found`,
      } satisfies HarnessRouteResponse);
      return;
    }

    const workflows = loadWorkflows(repo);
    const workflowNames = new Set(workflows.map((w) => w.name));

    if (workflows.length === 0) {
      res.json({
        type: "answer",
        repoId,
        answer: "This repo has no workflows defined yet. Add `.archon/workflows/*.yaml` to get started.",
        confidence: 0,
        reason: "No workflows found in repo",
      } satisfies HarnessRouteResponse);
      return;
    }

    // 1. Keyword shortcut for high-confidence matches
    const keywordWorkflow = matchWorkflowKeyword(prompt, workflowNames);
    if (keywordWorkflow) {
      const frUrl = extractFreshreleaseTaskUrl(prompt);
      const inputs: Record<string, string> = { requirement: prompt };
      if (frUrl) inputs.frUrl = frUrl;

      const nonHarness = workflows
        .filter((w) => w.name !== "harness" && w.name !== keywordWorkflow)
        .slice(0, 3)
        .map((w) => w.name);

      res.json({
        type: "proposal",
        repoId,
        workflow: keywordWorkflow,
        inputs,
        alternatives: nonHarness,
        confidence: 0.95,
        reason: `Keyword routing → ${keywordWorkflow}`,
      } satisfies HarnessRouteResponse);
      return;
    }

    // 2. Try harness.yaml dry-run if the repo has one
    const harnessWf = findWorkflow(repo, "harness");
    if (harnessWf) {
      const routeStep = harnessWf.steps.find((s) => s.id === "route");
      if (routeStep) {
        try {
          const config = loadConfig();
          const inputs: Record<string, string> = { requirement: prompt };
          if (threadContext) inputs.threadContext = threadContext;

          const catalogStep = harnessWf.steps.find((s) => s.id === "catalog");
          let catalogOutput = "";
          if (catalogStep) {
            try {
              catalogOutput = await runSingleStep(repo, harnessWf, "catalog", inputs, config);
            } catch {
              catalogOutput = workflows
                .filter((w) => w.name !== "harness")
                .map((w) => `- ${w.name}: ${w.description}`)
                .join("\n");
            }
          }

          const routeInputs = { ...inputs, catalog: catalogOutput };
          const routeOutput = await runSingleStep(repo, harnessWf, "route", routeInputs, config);

          const jsonMatch = routeOutput.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const wfName = typeof parsed.workflow === "string" ? parsed.workflow : "ask";
            const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
            const reason = typeof parsed.reason === "string" ? parsed.reason : "";
            const routeInputsParsed = typeof parsed.inputs === "object" && parsed.inputs ? parsed.inputs : {};
            const alternatives = Array.isArray(parsed.alternatives)
              ? parsed.alternatives.filter((a: any) => typeof a === "string")
              : [];

            if (!workflowNames.has(wfName) || confidence < CONFIDENCE_THRESHOLD) {
              res.json({
                type: "answer",
                repoId,
                answer: reason || `I couldn't confidently pick a workflow for that. Could you rephrase?`,
                confidence,
                reason: !workflowNames.has(wfName)
                  ? `LLM picked unknown workflow "${wfName}"`
                  : "Low confidence",
              } satisfies HarnessRouteResponse);
              return;
            }

            res.json({
              type: "proposal",
              repoId,
              workflow: wfName,
              inputs: { requirement: prompt, ...routeInputsParsed },
              alternatives,
              confidence,
              reason,
            } satisfies HarnessRouteResponse);
            return;
          }
        } catch {
          // fall through to server-side LLM routing
        }
      }
    }

    // 3. Fallback: server-side LLM routing (same as old route-intent)
    const workflowCatalog = workflows
      .filter((w) => w.name !== "harness")
      .map((w) => {
        const inputList = w.inputs
          .map((inp) => `${inp.id}${inp.required ? " (required)" : ""}: ${inp.label}`)
          .join("; ");
        return `- name: ${w.name} | description: ${w.description} | inputs: [${inputList}]`;
      })
      .join("\n");

    const repoRules = loadRepoRules(repo);

    const llm = createLLMProvider(loadConfig());
    const systemParts = [
      "You are a smart intent router for a software development assistant.",
      "Given a user prompt and a list of available workflows, pick the single best workflow.",
      "Also extract values for any workflow inputs that the prompt implicitly provides.",
      "",
      "Respond with ONLY a JSON object (no markdown fences, no prose):",
      "{",
      '  "workflow": "<workflow name from the list>",',
      '  "inputs": { "<inputId>": "<extracted value>", ... },',
      '  "alternatives": ["<second-best>", "<third-best>"],',
      '  "confidence": <0.0 to 1.0>,',
      '  "reason": "<one sentence explaining the pick>"',
      "}",
      "",
      "Rules:",
      "- confidence 0.9+: prompt clearly matches a specific workflow.",
      "- confidence 0.6-0.9: reasonable match but some ambiguity.",
      '- confidence < 0.6: no good match; set workflow to "ask".',
      "- For the inputs field, map prompt content to the workflow's declared inputs.",
      '  The main prompt text should go into the primary required input (usually "requirement").',
      "- ONLY use workflow names from the provided list.",
    ];
    if (repoRules) {
      systemParts.push(
        "",
        `Repo rules and conventions for ${repoId} (use these to inform your routing and answers):`,
        repoRules,
      );
    }
    const response = await llm.chat([
      { role: "system", content: systemParts.join("\n") },
      {
        role: "user",
        content: `Available workflows:\n${workflowCatalog}\n\n${threadContext ? `Thread context:\n${threadContext}\n\n` : ""}User prompt: ${prompt}`,
      },
    ]);

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      res.json({
        type: "answer",
        repoId,
        answer: text || "Sorry, I couldn't understand that. Could you rephrase?",
        confidence: 0,
        reason: "LLM did not return valid JSON",
      } satisfies HarnessRouteResponse);
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      res.json({
        type: "answer",
        repoId,
        answer: text,
        confidence: 0,
        reason: "LLM returned unparseable JSON",
      } satisfies HarnessRouteResponse);
      return;
    }

    const workflow = typeof parsed.workflow === "string" ? parsed.workflow : "ask";
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    const routedInputs = typeof parsed.inputs === "object" && parsed.inputs ? parsed.inputs : {};
    const alternatives = Array.isArray(parsed.alternatives)
      ? parsed.alternatives.filter((a: any) => typeof a === "string")
      : [];

    if (!workflowNames.has(workflow) || confidence < CONFIDENCE_THRESHOLD) {
      res.json({
        type: "answer",
        repoId,
        answer: reason || "I'm not sure what to do with that. Could you be more specific?",
        confidence,
        reason: !workflowNames.has(workflow)
          ? `LLM picked unknown workflow "${workflow}"`
          : "Low confidence",
      } satisfies HarnessRouteResponse);
      return;
    }

    res.json({
      type: "proposal",
      repoId,
      workflow,
      inputs: { requirement: prompt, ...routedInputs },
      alternatives,
      confidence,
      reason,
    } satisfies HarnessRouteResponse);
  } catch (err: any) {
    res.status(500).json({
      error: `Harness route failed: ${err.message}`,
      type: "answer",
      answer: "Sorry, something went wrong. Please try again.",
    });
  }
});

/**
 * POST /api/harness/execute
 *
 * Execute a confirmed workflow. This keeps the run visible under its real
 * workflow name (fix-bug, dev, etc.) rather than wrapping in a harness run.
 */
harnessRoutes.post("/harness/execute", async (req: Request, res: Response) => {
  try {
    const {
      repoId, workflow: workflowName, inputs, prompt,
      slackUser, channel, surface, baseBranch,
    } = req.body ?? {};

    if (!repoId) {
      res.status(400).json({ error: "repoId is required" });
      return;
    }
    if (!workflowName) {
      res.status(400).json({ error: "workflow is required" });
      return;
    }

    // Policy check
    try {
      assertAllowed({ repoId, workflow: workflowName, channel, slackUser });
    } catch (err) {
      if (err instanceof PolicyError) {
        res.status(403).json({ error: err.reason, reason: err.reason });
        return;
      }
      throw err;
    }

    const repo = requireRepo(repoId);
    const workflow = findWorkflow(repo, workflowName);
    if (!workflow) {
      res
        .status(404)
        .json({ error: `Workflow "${workflowName}" not found in repo "${repoId}"` });
      return;
    }

    // Input validation
    const mergedInputs: Record<string, string> = {
      ...(inputs ?? {}),
      requirement: inputs?.requirement ?? prompt ?? "",
    };

    const frUrl = extractFreshreleaseTaskUrl(prompt ?? "");
    if (frUrl && !mergedInputs.frUrl) mergedInputs.frUrl = frUrl;

    const missing = workflow.inputs
      .filter((inp) => inp.required && !(mergedInputs[inp.id] ?? "").trim())
      .map((inp) => inp.id);

    if (missing.length > 0) {
      res.status(400).json({
        error: `Missing required inputs: ${missing.join(", ")}`,
        missing,
      });
      return;
    }

    const config = loadConfig();
    const runId = await startRun(repo, workflow, prompt ?? "", mergedInputs, config, baseBranch);

    // Audit log
    appendAuditLog({
      ts: new Date().toISOString(),
      slackUser,
      channel,
      repoId: repo.id,
      workflow: workflowName,
      runId,
      surface,
    });

    res.json({ runId, repoId: repo.id, workflow: workflowName });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

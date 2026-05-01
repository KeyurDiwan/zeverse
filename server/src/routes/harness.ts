import { Router, Request, Response } from "express";
import { listRepos, requireRepo } from "../repos";
import { loadConfig } from "../config";
import { createLLMProvider } from "../llm";
import {
  loadWorkflows,
  findWorkflow,
  loadRepoRules,
  type Workflow,
} from "../workflows";
import { matchWorkflowKeyword } from "../workflow-infer";
import { extractPrdDocUrl } from "../prd-doc-url";
import { startRun, runSingleStep } from "../runner";
import { assertAllowed, appendAuditLog, PolicyError } from "../policy";

export const harnessRoutes = Router();

function extractFreshreleaseTaskUrl(text: string): string | undefined {
  const m = text.match(
    /https?:\/\/[^\s]+freshrelease\.com\/ws\/[^/\s]+\/tasks\/[^\s)]+/i
  );
  return m?.[0];
}

export interface HarnessRouteSuggestion {
  workflow: string;
  inputs: Record<string, string>;
  confidence: number;
  reason: string;
}

interface HarnessRouteResponse {
  type: "proposal" | "answer" | "clarify";
  repoId: string | null;
  workflow?: string;
  inputs?: Record<string, string>;
  /** Top 1–3 workflow picks (first entry matches `workflow` / `inputs` / `confidence` / `reason`). */
  suggestions?: HarnessRouteSuggestion[];
  alternatives?: string[];
  confidence: number;
  reason: string;
  answer?: string;
  question?: string;
  missing?: string[];
}

const CONFIDENCE_THRESHOLD = 0.6;

/** Slack Block Kit `static_select` allows at most 100 options per menu. */
const MAX_PROPOSAL_ALTERNATIVES = 100;

/** Names for “Pick another…” minus meta-router `harness` and every suggested workflow. */
function proposalAlternativesExcluding(
  workflows: Workflow[],
  excludeNames: string[]
): string[] {
  const ex = new Set(excludeNames);
  const names = workflows
    .map((w) => w.name)
    .filter((name) => name !== "harness" && !ex.has(name))
    .sort((a, b) => a.localeCompare(b));
  return names.slice(0, MAX_PROPOSAL_ALTERNATIVES);
}

function toSuggestionEntry(
  entry: any,
  prompt: string,
  workflowNames: Set<string>
): HarnessRouteSuggestion | null {
  const wf = typeof entry?.workflow === "string" ? entry.workflow : "";
  if (!workflowNames.has(wf)) return null;
  const confidence = typeof entry?.confidence === "number" ? entry.confidence : 0;
  if (confidence < CONFIDENCE_THRESHOLD) return null;
  const reason = typeof entry?.reason === "string" ? entry.reason : "";
  const routeInputsParsed =
    typeof entry?.inputs === "object" && entry.inputs ? entry.inputs : {};
  return {
    workflow: wf,
    inputs: { requirement: prompt, ...routeInputsParsed },
    confidence,
    reason,
  };
}

function dedupeSuggestions(s: HarnessRouteSuggestion[]): HarnessRouteSuggestion[] {
  const byWf = new Map<string, HarnessRouteSuggestion>();
  for (const x of s) {
    const prev = byWf.get(x.workflow);
    if (!prev || x.confidence > prev.confidence) byWf.set(x.workflow, x);
  }
  return [...byWf.values()].sort((a, b) => b.confidence - a.confidence);
}

/**
 * From harness.yaml route step JSON or server LLM JSON: `suggestions: [...]` (preferred)
 * or legacy single `workflow` / `inputs` / `confidence` / `reason`.
 */
function buildTopSuggestionsFromParsed(
  parsed: any,
  prompt: string,
  workflowNames: Set<string>
): HarnessRouteSuggestion[] {
  if (Array.isArray(parsed?.suggestions) && parsed.suggestions.length > 0) {
    const out: HarnessRouteSuggestion[] = [];
    for (const s of parsed.suggestions) {
      const e = toSuggestionEntry(s, prompt, workflowNames);
      if (e) out.push(e);
    }
    return dedupeSuggestions(out).slice(0, 3);
  }
  const e = toSuggestionEntry(
    {
      workflow: parsed?.workflow,
      inputs: parsed?.inputs,
      confidence: parsed?.confidence,
      reason: parsed?.reason,
    },
    prompt,
    workflowNames
  );
  return e ? [e] : [];
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
        answer: [
          "No workflow files found for this repo in the hub cache.",
          "",
          `Zeverse only reads \`.zeverse/workflows/*.yaml\` from **one Git branch**: the \`defaultBranch\` stored for this repo (\`${repo.defaultBranch}\` from \`origin\` ${repo.origin}).`,
          "",
          "If you added workflows locally, **push them to that branch** (or change \`defaultBranch\` in \`repos.json\` to match the branch that contains \`.zeverse/\`, then save).",
          "",
          `After the remote is updated, refresh the cache: \`POST /api/repos/${repoId}/refresh-workflows\` (or wait ~60s).`,
        ].join("\n"),
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
      if (keywordWorkflow === "prd-analysis") {
        const docUrl = extractPrdDocUrl(prompt);
        if (docUrl) inputs.docUrl = docUrl;
      }

      const reason = `Keyword routing → ${keywordWorkflow}`;
      res.json({
        type: "proposal",
        repoId,
        workflow: keywordWorkflow,
        inputs,
        suggestions: [
          {
            workflow: keywordWorkflow,
            inputs: { ...inputs },
            confidence: 0.95,
            reason,
          },
        ],
        alternatives: proposalAlternativesExcluding(workflows, [keywordWorkflow]),
        confidence: 0.95,
        reason,
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
            const suggestions = buildTopSuggestionsFromParsed(parsed, prompt, workflowNames);
            const wfName = typeof parsed.workflow === "string" ? parsed.workflow : "ask";
            const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
            const reason = typeof parsed.reason === "string" ? parsed.reason : "";

            if (suggestions.length === 0) {
              res.json({
                type: "answer",
                repoId,
                answer:
                  reason ||
                  `I couldn't confidently pick a workflow for that. Could you rephrase?`,
                confidence,
                reason: !workflowNames.has(wfName)
                  ? `LLM picked unknown workflow "${wfName}"`
                  : confidence < CONFIDENCE_THRESHOLD
                    ? "Low confidence"
                    : reason || "No valid suggestions",
              } satisfies HarnessRouteResponse);
              return;
            }

            const primary = suggestions[0];
            const selectedNames = suggestions.map((s) => s.workflow);
            res.json({
              type: "proposal",
              repoId,
              workflow: primary.workflow,
              inputs: primary.inputs,
              suggestions,
              alternatives: proposalAlternativesExcluding(workflows, selectedNames),
              confidence: primary.confidence,
              reason: primary.reason,
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
      "Given a user prompt and a list of available workflows, pick up to 3 best-matching workflows (ordered by fit).",
      "Also extract values for any workflow inputs that the prompt implicitly provides for each pick.",
      "",
      "Prefer responding with a top-level \"suggestions\" array (1 to 3 entries).",
      "Each entry: workflow name, inputs object, confidence, reason.",
      "",
      "Respond with ONLY a JSON object (no markdown fences, no prose):",
      "{",
      '  "suggestions": [',
      '    { "workflow": "<name>", "inputs": { "<inputId>": "<value>", ... }, "confidence": <0.0-1.0>, "reason": "<short>" },',
      "    ... up to 3",
      "  ],",
      '  "workflow": "<same as first suggestion; for backward compatibility>",',
      '  "inputs": { ... },',
      '  "confidence": <number>,',
      '  "reason": "<string>"',
      "}",
      "",
      "Rules:",
      "- Include at least one suggestion with confidence 0.6+ when there is a reasonable match.",
      "- confidence 0.9+: prompt clearly matches that workflow.",
      "- confidence 0.6-0.9: reasonable match but some ambiguity.",
      '- confidence < 0.6: omit that workflow from suggestions (or use legacy workflow \"ask\" only if nothing qualifies).',
      "- For inputs, map prompt content to the workflow's declared inputs.",
      '  The main prompt text should go into the primary required input (usually "requirement").',
      "- ONLY use workflow names from the provided list.",
      "- If you only have one good match, return a single-element suggestions array.",
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

    const suggestions = buildTopSuggestionsFromParsed(parsed, prompt, workflowNames);
    const workflow = typeof parsed.workflow === "string" ? parsed.workflow : "ask";
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";

    if (suggestions.length === 0) {
      res.json({
        type: "answer",
        repoId,
        answer:
          reason || "I'm not sure what to do with that. Could you be more specific?",
        confidence,
        reason: !workflowNames.has(workflow)
          ? `LLM picked unknown workflow "${workflow}"`
          : "Low confidence",
      } satisfies HarnessRouteResponse);
      return;
    }

    const primary = suggestions[0];
    const selectedNames = suggestions.map((s) => s.workflow);
    res.json({
      type: "proposal",
      repoId,
      workflow: primary.workflow,
      inputs: primary.inputs,
      suggestions,
      alternatives: proposalAlternativesExcluding(workflows, selectedNames),
      confidence: primary.confidence,
      reason: primary.reason,
    } satisfies HarnessRouteResponse);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error("[harness/route]", msg, err);
    res.status(500).json({
      error: `Harness route failed: ${msg}`,
      type: "answer",
      answer:
        `Something went wrong while routing your request.\n\n` +
        `*Detail:* ${msg}\n\n` +
        `Typical causes: LLM/API misconfiguration (check CLOUDVERSE_* / server logs), ` +
        `workflow cache clone failure, or invalid YAML in \`.zeverse/workflows/\`.`,
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
      slackUser, channel, surface, baseBranch, threadContext,
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

    let runPrompt = (prompt ?? "").trim();
    if (typeof threadContext === "string" && threadContext.trim()) {
      const tc = threadContext.trim();
      mergedInputs.threadContext = tc;
      runPrompt = `${tc}\n\n--- USER REQUEST ---\n${runPrompt}`;
    }

    const frUrl = extractFreshreleaseTaskUrl(prompt ?? "");
    if (frUrl && !mergedInputs.frUrl) mergedInputs.frUrl = frUrl;

    if (workflowName === "prd-analysis" && !(mergedInputs.docUrl ?? "").trim()) {
      const docUrl =
        extractPrdDocUrl(prompt ?? "") || extractPrdDocUrl(mergedInputs.requirement ?? "");
      if (docUrl) mergedInputs.docUrl = docUrl;
    }

    if (workflowName === "test-fix" && !(mergedInputs.test_command ?? "").trim()) {
      mergedInputs.test_command = "npm install --legacy-peer-deps && npm run test";
    }

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
    const runId = await startRun(
      repo,
      workflow,
      runPrompt || (prompt ?? ""),
      mergedInputs,
      config,
      baseBranch
    );

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

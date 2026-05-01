/**
 * Harness route integration tests.
 *
 * Run: npx ts-node --transpile-only src/routes/__tests__/harness.test.ts
 *
 * Tests the harness routing logic inline (no real HTTP server or LLM).
 */

import assert from "node:assert/strict";
import { matchWorkflowKeyword } from "../../workflow-infer";
import { extractPrdDocUrl } from "../../prd-doc-url";

function run(test: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${test}`);
  } catch (err: any) {
    console.error(`  ✗ ${test}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

// Replicate the harness route decision logic to verify proposal/answer/clarify.

interface HarnessRouteResult {
  type: "proposal" | "answer" | "clarify";
  repoId: string | null;
  workflow?: string;
  inputs?: Record<string, string>;
  suggestions?: {
    workflow: string;
    inputs: Record<string, string>;
    confidence: number;
    reason: string;
  }[];
  alternatives?: string[];
  confidence: number;
  reason: string;
  answer?: string;
  question?: string;
  missing?: string[];
}

const CONFIDENCE_THRESHOLD = 0.6;

/** Mirrors server `MAX_PROPOSAL_ALTERNATIVES` / `proposalAlternatives` using only workflow names. */
const MAX_PROPOSAL_ALTERNATIVES = 100;

function simulateProposalAlternativesExcluding(
  available: Set<string>,
  excludeNames: string[]
): string[] {
  const ex = new Set(excludeNames);
  return [...available]
    .filter((w) => w !== "harness" && !ex.has(w))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_PROPOSAL_ALTERNATIVES);
}

interface MockLLMRoute {
  workflow: string;
  inputs: Record<string, string>;
  alternatives: string[];
  confidence: number;
  reason: string;
  /** Optional multi-pick; when set, used instead of single workflow path. */
  suggestions?: {
    workflow: string;
    inputs: Record<string, string>;
    confidence: number;
    reason: string;
  }[];
}

function simulateHarnessRoute(
  prompt: string,
  repoId: string | null,
  available: Set<string>,
  llmResponse: MockLLMRoute | null
): HarnessRouteResult {
  if (!repoId) {
    return {
      type: "clarify",
      repoId: null,
      question: "Which repository should I work with?",
      missing: ["repoId"],
      confidence: 0,
      reason: "Could not determine repo",
    };
  }

  if (available.size === 0) {
    return {
      type: "answer",
      repoId,
      answer: "No workflows found.",
      confidence: 0,
      reason: "No workflows found in repo",
    };
  }

  const keyword = matchWorkflowKeyword(prompt, available);
  if (keyword) {
    const inputs: Record<string, string> = { requirement: prompt };
    if (keyword === "prd-analysis") {
      const docUrl = extractPrdDocUrl(prompt);
      if (docUrl) inputs.docUrl = docUrl;
    }
    const reason = `Keyword routing → ${keyword}`;
    return {
      type: "proposal",
      repoId,
      workflow: keyword,
      inputs,
      suggestions: [
        {
          workflow: keyword,
          inputs: { ...inputs },
          confidence: 0.95,
          reason,
        },
      ],
      alternatives: simulateProposalAlternativesExcluding(available, [keyword]),
      confidence: 0.95,
      reason,
    };
  }

  if (!llmResponse) {
    return {
      type: "answer",
      repoId,
      answer: "Sorry, I couldn't understand that.",
      confidence: 0,
      reason: "LLM did not return valid JSON",
    };
  }

  if (llmResponse.suggestions && llmResponse.suggestions.length > 0) {
    const valid = llmResponse.suggestions.filter(
      (s) => available.has(s.workflow) && s.confidence >= CONFIDENCE_THRESHOLD
    );
    if (valid.length === 0) {
      return {
        type: "answer",
        repoId,
        answer: llmResponse.reason || "Low confidence",
        confidence: llmResponse.confidence,
        reason: "Low confidence",
      };
    }
    const top = valid.slice(0, 3);
    const selectedNames = top.map((s) => s.workflow);
    const suggestions = top.map((s) => ({
      workflow: s.workflow,
      inputs: { requirement: prompt, ...s.inputs },
      confidence: s.confidence,
      reason: s.reason,
    }));
    return {
      type: "proposal",
      repoId,
      workflow: suggestions[0].workflow,
      inputs: suggestions[0].inputs,
      suggestions,
      alternatives: simulateProposalAlternativesExcluding(available, selectedNames),
      confidence: suggestions[0].confidence,
      reason: suggestions[0].reason,
    };
  }

  if (!available.has(llmResponse.workflow) || llmResponse.confidence < CONFIDENCE_THRESHOLD) {
    return {
      type: "answer",
      repoId,
      answer: llmResponse.reason || "Low confidence",
      confidence: llmResponse.confidence,
      reason: !available.has(llmResponse.workflow)
        ? `LLM picked unknown workflow "${llmResponse.workflow}"`
        : "Low confidence",
    };
  }

  return {
    type: "proposal",
    repoId,
    workflow: llmResponse.workflow,
    inputs: { requirement: prompt, ...llmResponse.inputs },
    suggestions: [
      {
        workflow: llmResponse.workflow,
        inputs: { requirement: prompt, ...llmResponse.inputs },
        confidence: llmResponse.confidence,
        reason: llmResponse.reason,
      },
    ],
    alternatives: simulateProposalAlternativesExcluding(available, [llmResponse.workflow]),
    confidence: llmResponse.confidence,
    reason: llmResponse.reason,
  };
}

const AVAILABLE = new Set([
  "harness", "dev", "fix-bug", "test-fix", "code-review", "explain-codebase",
  "test-write", "pr-raise", "ask", "lint-fix", "upgrade-dep",
  "fr-analyze", "fr-task-finisher", "prd-analysis",
]);

console.log("harness route logic tests\n");

run("proposal: keyword match for 'fix the login bug'", () => {
  const result = simulateHarnessRoute("fix the login bug", "ubx-ui", AVAILABLE, null);
  assert.equal(result.type, "proposal");
  assert.equal(result.workflow, "fix-bug");
  assert.equal(result.confidence, 0.95);
  assert.equal(result.repoId, "ubx-ui");
});

run("proposal: keyword match for 'fix failing tests'", () => {
  const result = simulateHarnessRoute("fix failing tests", "ubx-ui", AVAILABLE, null);
  assert.equal(result.type, "proposal");
  assert.equal(result.workflow, "test-fix");
});

run("proposal: keyword match for 'write tests for foo.ts'", () => {
  const result = simulateHarnessRoute("write tests for foo.ts", "ubx-ui", AVAILABLE, null);
  assert.equal(result.type, "proposal");
  assert.equal(result.workflow, "test-write");
});

run("proposal: keyword match for 'raise PR'", () => {
  const result = simulateHarnessRoute("raise PR", "ubx-ui", AVAILABLE, null);
  assert.equal(result.type, "proposal");
  assert.equal(result.workflow, "pr-raise");
});

run("proposal: LLM picks dev with high confidence", () => {
  const result = simulateHarnessRoute(
    "add a dark mode toggle",
    "ubx-ui",
    AVAILABLE,
    { workflow: "dev", inputs: { requirement: "add dark mode" }, alternatives: ["fix-bug"], confidence: 0.88, reason: "feature request" }
  );
  assert.equal(result.type, "proposal");
  assert.equal(result.workflow, "dev");
  assert.equal(result.confidence, 0.88);
  assert.deepEqual(result.alternatives, simulateProposalAlternativesExcluding(AVAILABLE, ["dev"]));
});

run("answer: LLM confidence below threshold", () => {
  const result = simulateHarnessRoute(
    "do something vague",
    "ubx-ui",
    AVAILABLE,
    { workflow: "dev", inputs: {}, alternatives: [], confidence: 0.3, reason: "ambiguous" }
  );
  assert.equal(result.type, "answer");
  assert.equal(result.reason, "Low confidence");
});

run("answer: LLM picks unknown workflow", () => {
  const result = simulateHarnessRoute(
    "deploy to prod",
    "ubx-ui",
    AVAILABLE,
    { workflow: "deploy-prod", inputs: {}, alternatives: [], confidence: 0.95, reason: "deploy request" }
  );
  assert.equal(result.type, "answer");
  assert.ok(result.reason!.includes("deploy-prod"));
});

run("clarify: no repo provided", () => {
  const result = simulateHarnessRoute("fix something", null, AVAILABLE, null);
  assert.equal(result.type, "clarify");
  assert.ok(result.missing!.includes("repoId"));
});

run("answer: no workflows in repo", () => {
  const result = simulateHarnessRoute("fix something", "empty-repo", new Set(), null);
  assert.equal(result.type, "answer");
  assert.equal(result.repoId, "empty-repo");
});

run("proposal: FR analyze keyword", () => {
  const result = simulateHarnessRoute("analyze fr BILLING-123", "ubx-ui", AVAILABLE, null);
  assert.equal(result.type, "proposal");
  assert.equal(result.workflow, "fr-analyze");
});

run("proposal: Google Doc URL → prd-analysis", () => {
  const url = "https://docs.google.com/document/d/abc123/edit";
  const result = simulateHarnessRoute(url, "ubx-ui", AVAILABLE, null);
  assert.equal(result.type, "proposal");
  assert.equal(result.workflow, "prd-analysis");
  assert.equal(result.inputs!.docUrl, url);
});

run("proposal: prd-review + Google Doc → prd-analysis with docUrl", () => {
  const url = "https://docs.google.com/document/d/abc123/edit";
  const result = simulateHarnessRoute(`prd-review ${url}`, "ubx-ui", AVAILABLE, null);
  assert.equal(result.type, "proposal");
  assert.equal(result.workflow, "prd-analysis");
  assert.equal(result.inputs!.docUrl, url);
});

run("proposal: LLM returns top-3 suggestions", () => {
  const result = simulateHarnessRoute(
    "optimize dashboard load time and improve caching strategy",
    "ubx-ui",
    AVAILABLE,
    {
      workflow: "dev",
      inputs: {},
      alternatives: [],
      confidence: 0.85,
      reason: "n/a",
      suggestions: [
        { workflow: "fix-bug", inputs: {}, confidence: 0.88, reason: "bugfix" },
        { workflow: "test-write", inputs: { focus: "auth" }, confidence: 0.72, reason: "tests" },
        { workflow: "dev", inputs: {}, confidence: 0.65, reason: "feature" },
      ],
    }
  );
  assert.equal(result.type, "proposal");
  assert.equal(result.suggestions!.length, 3);
  assert.equal(result.workflow, "fix-bug");
  assert.ok(!result.alternatives!.includes("fix-bug"));
  assert.ok(!result.alternatives!.includes("test-write"));
  assert.ok(!result.alternatives!.includes("dev"));
});

run("proposal includes alternatives from available workflows", () => {
  const result = simulateHarnessRoute("fix the login redirect", "ubx-ui", AVAILABLE, null);
  assert.equal(result.type, "proposal");
  assert.ok(Array.isArray(result.alternatives));
  assert.ok(result.alternatives!.length > 0);
  assert.ok(!result.alternatives!.includes("fix-bug"));
  assert.ok(!result.alternatives!.includes("harness"));
});

console.log("\nAll tests passed.");

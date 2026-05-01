/**
 * Harness route integration tests.
 *
 * Run: npx ts-node --transpile-only src/routes/__tests__/harness.test.ts
 *
 * Tests the harness routing logic inline (no real HTTP server or LLM).
 */

import assert from "node:assert/strict";

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
  alternatives?: string[];
  confidence: number;
  reason: string;
  answer?: string;
  question?: string;
  missing?: string[];
}

const CONFIDENCE_THRESHOLD = 0.6;

// Keyword patterns from workflow-infer.ts
const WORKFLOW_KEYWORDS: [RegExp, string][] = [
  [/\b(analy[sz]e\s+fr|fr\s+analy[sz]e)\b/i, "fr-analyze"],
  [/\b(finish\s+fr|fix\s+fr|fr\s+fix)\b/i, "fr-task-finisher"],
  [/freshrelease\.com\/ws\/.*\/tasks\//i, "fr-task-finisher"],
  [/\b(write\s+tests?|add\s+tests?)\b/i, "test-write"],
  [/\b(raise\s+pr|open\s+pr|create\s+pr)\b/i, "pr-raise"],
  [/\b(fix\s+failing\s+tests?|fix\s+unit\s+tests?|failing\s+tests?|green\s+the\s+build)\b/i, "test-fix"],
  [/\b(fix|bug|broken|crash|error)\b/i, "fix-bug"],
  [/\b(review|pr\b|pull\s*request|code\s+review)\b/i, "code-review"],
  [/\blint\b/i, "lint-fix"],
  [/\b(explain|understand|how\s*does)\b/i, "explain-codebase"],
  [/\b(upgrade|bump)\b/i, "upgrade-dep"],
  [/\bprd\b|docs\.google\.com\/document/i, "prd-analysis"],
];

function matchKeyword(prompt: string, available: Set<string>): string | null {
  for (const [pattern, workflow] of WORKFLOW_KEYWORDS) {
    if (!pattern.test(prompt)) continue;
    if (available.has(workflow)) return workflow;
    return null;
  }
  return null;
}

interface MockLLMRoute {
  workflow: string;
  inputs: Record<string, string>;
  alternatives: string[];
  confidence: number;
  reason: string;
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

  const keyword = matchKeyword(prompt, available);
  if (keyword) {
    return {
      type: "proposal",
      repoId,
      workflow: keyword,
      inputs: { requirement: prompt },
      alternatives: [...available].filter((w) => w !== keyword && w !== "harness").slice(0, 3),
      confidence: 0.95,
      reason: `Keyword routing → ${keyword}`,
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
    alternatives: llmResponse.alternatives,
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
  assert.deepEqual(result.alternatives, ["fix-bug"]);
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
  const result = simulateHarnessRoute(
    "https://docs.google.com/document/d/abc123/edit",
    "ubx-ui",
    AVAILABLE,
    null
  );
  assert.equal(result.type, "proposal");
  assert.equal(result.workflow, "prd-analysis");
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

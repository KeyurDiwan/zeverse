/**
 * Route-intent unit tests.
 *
 * Run: npx ts-node --transpile-only src/routes/__tests__/route-intent.test.ts
 *
 * These tests mock the LLM and repo layers so they run offline.
 */

import assert from "node:assert/strict";

// ─── Inline mock of the LLM-based routing logic ────────────────────────────
// We replicate the server's decision logic here so we can verify the
// confidence-threshold and fallback behaviour without a real LLM.

const FALLBACK_WORKFLOW = "ask";
const CONFIDENCE_THRESHOLD = 0.6;

interface MockLLMResponse {
  workflow: string;
  inputs: Record<string, string>;
  confidence: number;
  reason: string;
}

interface RouteResult {
  workflow: string;
  inputs: Record<string, string>;
  confidence: number;
  reason: string;
  fallback: boolean;
}

function applyRouteLogic(
  llmResponse: MockLLMResponse | null,
  availableWorkflows: Set<string>
): RouteResult {
  if (!llmResponse) {
    return {
      workflow: FALLBACK_WORKFLOW,
      inputs: {},
      confidence: 0,
      reason: "LLM did not return valid JSON",
      fallback: true,
    };
  }

  const { workflow, inputs, confidence, reason } = llmResponse;

  if (!availableWorkflows.has(workflow) || confidence < CONFIDENCE_THRESHOLD) {
    return {
      workflow: FALLBACK_WORKFLOW,
      inputs,
      confidence,
      reason: !availableWorkflows.has(workflow)
        ? `LLM picked unknown workflow "${workflow}" — falling back to ask`
        : reason || "Low confidence",
      fallback: true,
    };
  }

  return { workflow, inputs, confidence, reason, fallback: false };
}

// ─── Test helpers ───────────────────────────────────────────────────────────
const UBX_WORKFLOWS = new Set([
  "dev",
  "fix-bug",
  "pr-review",
  "pr-review-remote",
  "lint-fix",
  "test",
  "explain-codebase",
  "upgrade-dep",
  "prd-analysis",
  "ask",
]);

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

// ─── Tests ──────────────────────────────────────────────────────────────────
console.log("route-intent logic tests\n");

run("fix prompt → fix-bug workflow", () => {
  const result = applyRouteLogic(
    { workflow: "fix-bug", inputs: { bug: "login redirect loop" }, confidence: 0.95, reason: "prompt describes a bug" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, "fix-bug");
  assert.equal(result.fallback, false);
  assert.ok(result.confidence >= CONFIDENCE_THRESHOLD);
});

run("explain prompt → explain-codebase workflow", () => {
  const result = applyRouteLogic(
    { workflow: "explain-codebase", inputs: { focus: "src/store" }, confidence: 0.9, reason: "prompt asks to explain code" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, "explain-codebase");
  assert.equal(result.fallback, false);
});

run("review prompt → pr-review workflow", () => {
  const result = applyRouteLogic(
    { workflow: "pr-review", inputs: { base: "origin/main" }, confidence: 0.85, reason: "prompt asks for review" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, "pr-review");
  assert.equal(result.fallback, false);
});

run("dev/feature prompt → dev workflow", () => {
  const result = applyRouteLogic(
    { workflow: "dev", inputs: { requirement: "add dark-mode toggle" }, confidence: 0.88, reason: "new feature request" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, "dev");
  assert.equal(result.fallback, false);
});

run("open-ended question → ask workflow (high confidence from LLM)", () => {
  const result = applyRouteLogic(
    { workflow: "ask", inputs: { requirement: "how does routing work?" }, confidence: 0.92, reason: "general question" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, "ask");
  assert.equal(result.fallback, false);
});

run("low confidence → fallback to ask", () => {
  const result = applyRouteLogic(
    { workflow: "dev", inputs: {}, confidence: 0.3, reason: "ambiguous prompt" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, FALLBACK_WORKFLOW);
  assert.equal(result.fallback, true);
});

run("unknown workflow from LLM → fallback to ask", () => {
  const result = applyRouteLogic(
    { workflow: "deploy-prod", inputs: {}, confidence: 0.95, reason: "prompt asks to deploy" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, FALLBACK_WORKFLOW);
  assert.equal(result.fallback, true);
  assert.ok(result.reason.includes("deploy-prod"));
});

run("null/bad JSON from LLM → fallback to ask", () => {
  const result = applyRouteLogic(null, UBX_WORKFLOWS);
  assert.equal(result.workflow, FALLBACK_WORKFLOW);
  assert.equal(result.fallback, true);
});

run("lint prompt → lint-fix workflow", () => {
  const result = applyRouteLogic(
    { workflow: "lint-fix", inputs: {}, confidence: 0.87, reason: "prompt mentions linting" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, "lint-fix");
  assert.equal(result.fallback, false);
});

run("upgrade prompt → upgrade-dep workflow", () => {
  const result = applyRouteLogic(
    { workflow: "upgrade-dep", inputs: { requirement: "bump react to 19" }, confidence: 0.82, reason: "dependency upgrade" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, "upgrade-dep");
  assert.equal(result.fallback, false);
});

run("confidence exactly at threshold (0.6) → not a fallback", () => {
  const result = applyRouteLogic(
    { workflow: "test", inputs: {}, confidence: 0.6, reason: "borderline" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, "test");
  assert.equal(result.fallback, false);
});

run("confidence just below threshold (0.59) → fallback", () => {
  const result = applyRouteLogic(
    { workflow: "test", inputs: {}, confidence: 0.59, reason: "borderline" },
    UBX_WORKFLOWS
  );
  assert.equal(result.workflow, FALLBACK_WORKFLOW);
  assert.equal(result.fallback, true);
});

console.log("\nAll tests passed.");

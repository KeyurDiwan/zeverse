/**
 * workflow-infer keyword tests.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/workflow-infer.test.ts
 */

import assert from "node:assert/strict";
import { matchWorkflowKeyword } from "../../workflow-infer";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}\n    ${msg}`);
    process.exitCode = 1;
  }
}

console.log("workflow-infer tests\n");

const PRD_AVAILABLE = new Set(["prd-analysis", "code-review", "dev"]);
const GDOC = "https://docs.google.com/document/d/abc123/edit";

run("prd-review + url maps to prd-analysis", () => {
  assert.equal(matchWorkflowKeyword(`prd-review ${GDOC}`, PRD_AVAILABLE), "prd-analysis");
});

run("prd review + url maps to prd-analysis", () => {
  assert.equal(matchWorkflowKeyword(`prd review ${GDOC}`, PRD_AVAILABLE), "prd-analysis");
});

run("prd-analysis slug maps to prd-analysis", () => {
  assert.equal(matchWorkflowKeyword(`prd-analysis ${GDOC}`, PRD_AVAILABLE), "prd-analysis");
});

run("code review this PR maps to code-review", () => {
  assert.equal(matchWorkflowKeyword("code review this PR", PRD_AVAILABLE), "code-review");
});

run("when prd-analysis missing, prd-review falls through to code-review", () => {
  const noPrd = new Set(["code-review", "dev"]);
  assert.equal(matchWorkflowKeyword(`prd-review ${GDOC}`, noPrd), "code-review");
});

run("fix failing tests prefers test-fix when present", () => {
  const available = new Set(["test-fix", "fix-bug", "dev"]);
  assert.equal(matchWorkflowKeyword("fix failing tests", available), "test-fix");
});

run("fix failing tests falls through to fix-bug when test-fix absent", () => {
  const available = new Set(["fix-bug", "dev"]);
  assert.equal(matchWorkflowKeyword("fix failing tests", available), "fix-bug");
});

console.log("\nAll tests passed.");

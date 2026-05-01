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

run("fix failing tests prefers test-fix when present", () => {
  const available = new Set(["test-fix", "fix-bug", "dev"]);
  assert.equal(matchWorkflowKeyword("fix failing tests", available), "test-fix");
});

run("fix failing tests falls through to fix-bug when test-fix absent", () => {
  const available = new Set(["fix-bug", "dev"]);
  assert.equal(matchWorkflowKeyword("fix failing tests", available), "fix-bug");
});

console.log("\nAll tests passed.");

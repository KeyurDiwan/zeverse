/**
 * Validates test-fix workflow YAML files exist and parse.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/test-fix-workflow-yaml.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const WORKFLOW_ROOT = path.resolve(
  __dirname,
  "../../../../.zeverse/workflows"
);

function run(test: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${test}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${test}`);
    console.error(`    ${message}`);
    process.exitCode = 1;
  }
}

const VALID_KINDS = new Set([
  "llm",
  "shell",
  "edit",
  "approval",
  "workflow",
]);

console.log("test-fix workflow YAML smoke tests\n");

run("test-fix.yaml exists and has expected steps", () => {
  const file = path.join(WORKFLOW_ROOT, "test-fix.yaml");
  assert.ok(fs.existsSync(file), `missing ${file}`);
  const doc = YAML.parse(fs.readFileSync(file, "utf8")) as {
    name: string;
    steps: { id: string; kind: string }[];
  };
  assert.equal(doc.name, "test-fix");
  const ids = doc.steps.map((s) => s.id);
  assert.ok(ids.includes("setup"));
  assert.ok(ids.includes("iterate-fix"));
  assert.ok(ids.includes("summary"));
  const iterate = doc.steps.find((s) => s.id === "iterate-fix");
  assert.equal(iterate?.kind, "workflow");
});

run("test-fix-iteration.yaml exists and has expected steps", () => {
  const file = path.join(WORKFLOW_ROOT, "test-fix-iteration.yaml");
  assert.ok(fs.existsSync(file), `missing ${file}`);
  const doc = YAML.parse(fs.readFileSync(file, "utf8")) as {
    name: string;
    steps: { id: string; kind: string }[];
  };
  assert.equal(doc.name, "test-fix-iteration");
  for (const s of doc.steps) {
    assert.ok(
      VALID_KINDS.has(s.kind),
      `unexpected kind "${s.kind}" on step ${s.id}`
    );
  }
  const ids = doc.steps.map((s) => s.id);
  assert.deepEqual(ids[ids.length - 1], "loop-signal");
});

console.log("\nAll tests passed.");

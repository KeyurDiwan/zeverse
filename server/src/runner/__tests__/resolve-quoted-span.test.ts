/**
 * resolveQuotedSpan unit tests.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/resolve-quoted-span.test.ts
 */

import assert from "node:assert/strict";
import { resolveQuotedSpan } from "../../integrations/gdocs";

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

console.log("resolveQuotedSpan tests\n");

run("returns exact substring when present verbatim", () => {
  const doc = "Intro line.\nUser must login before billing.";
  assert.equal(resolveQuotedSpan(doc, "User must login before billing."), "User must login before billing.");
});

run("matches flexible whitespace between words", () => {
  const doc = "Foo   bar\nbaz";
  assert.equal(resolveQuotedSpan(doc, "Foo bar baz"), "Foo   bar\nbaz");
});

run("returns null when anchor cannot match doc", () => {
  assert.equal(resolveQuotedSpan("hello", "missing"), null);
});

run("returns null for empty anchor", () => {
  assert.equal(resolveQuotedSpan("hello world", "   "), null);
});

console.log("\nAll resolveQuotedSpan tests passed.");

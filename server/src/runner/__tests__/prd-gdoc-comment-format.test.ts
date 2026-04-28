/**
 * PRD Google Doc comment formatting and queries JSON parsing.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/prd-gdoc-comment-format.test.ts
 */

import assert from "node:assert/strict";
import {
  formatPrdGdocQueryComment,
  parseQueriesJson,
} from "../executors-gdoc";
import { verifyAnchorInDoc } from "../../integrations/gdocs";

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

console.log("prd-gdoc-comment-format tests\n");

run("parseQueriesJson maps anchor and severity", () => {
  const text = `
\`\`\`json queries
[
  { "anchor": "User must login", "body": "Which IdP?", "severity": "critical" },
  { "body": "No anchor here" }
]
\`\`\`
  `;
  const q = parseQueriesJson(text);
  assert.equal(q.length, 2);
  assert.equal(q[0].anchor, "User must login");
  assert.equal(q[0].body, "Which IdP?");
  assert.equal(q[0].severity, "critical");
  assert.equal(q[1].anchor, undefined);
  assert.equal(q[1].severity, "nice-to-have");
});

run("formatPrdGdocQueryComment produces title and question blocks", () => {
  const s = formatPrdGdocQueryComment({
    index: 2,
    body: "What is the SLA?",
    severity: "critical",
  });
  assert.ok(s.includes("[PRD Q2] [critical]"));
  assert.ok(!s.includes("Context (verbatim from doc):"));
  assert.ok(s.includes("Question / feedback:"));
  assert.ok(s.includes("What is the SLA?"));
});

run("verifyAnchorInDoc matches with whitespace normalization", () => {
  const doc = "Hello   world\nfoo";
  assert.equal(verifyAnchorInDoc(doc, "Hello world"), true);
  assert.equal(verifyAnchorInDoc(doc, "missing"), false);
});

console.log("\nAll prd-gdoc-comment-format tests passed.");

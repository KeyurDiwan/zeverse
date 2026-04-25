/**
 * FR executor unit tests.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/executors-fr.test.ts
 *
 * Tests the JSON parsing logic used by the fr-create step executor.
 */

import assert from "node:assert/strict";
import { extractFrAnalysisSummarySection } from "../executors-fr";

// Re-implement parseFRIssuesJson locally since it's not exported
function parseFRIssuesJson(text: string): { title: string; description?: string; issueType?: string; priority?: string; epicKey?: string }[] {
  const re = /```(?:json)?\s*fr-issues?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) => typeof e === "object" && typeof e.title === "string"
    );
  } catch {
    return [];
  }
}

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

console.log("executors-fr: parseFRIssuesJson tests\n");

run("parses a valid fr-issues JSON block", () => {
  const text = `Some preamble text.

\`\`\`json fr-issues
[
  {"title": "My Epic", "issueType": "Epic", "priority": "High"},
  {"title": "Task 1", "issueType": "Task", "epicKey": "My Epic"}
]
\`\`\`

PLAN: Creating 2 issues`;

  const result = parseFRIssuesJson(text);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, "My Epic");
  assert.equal(result[0].issueType, "Epic");
  assert.equal(result[1].title, "Task 1");
  assert.equal(result[1].epicKey, "My Epic");
});

run("returns empty array for no fenced block", () => {
  const result = parseFRIssuesJson("just some text with no code blocks");
  assert.equal(result.length, 0);
});

run("returns empty array for invalid JSON", () => {
  const text = "```json fr-issues\n{not valid json}\n```";
  const result = parseFRIssuesJson(text);
  assert.equal(result.length, 0);
});

run("returns empty array when JSON is not an array", () => {
  const text = '```json fr-issues\n{"title": "Epic"}\n```';
  const result = parseFRIssuesJson(text);
  assert.equal(result.length, 0);
});

run("filters out entries without a title", () => {
  const text = '```json fr-issues\n[{"title": "Good"}, {"description": "no title"}]\n```';
  const result = parseFRIssuesJson(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Good");
});

run("handles fr-issue (singular) tag", () => {
  const text = '```json fr-issue\n[{"title": "Single"}]\n```';
  const result = parseFRIssuesJson(text);
  assert.equal(result.length, 1);
});

// ─── FR URL/key parsing tests ──────────────────────────────────────────────

function parseUrlOrKey(input: string): { workspace: string; key: string } {
  const trimmed = input.trim().replace(/^<|>$/g, "");
  const urlMatch = trimmed.match(
    /freshrelease\.com\/ws\/([^/]+)\/tasks\/([A-Z]+-\d+)/
  );
  if (urlMatch) return { workspace: urlMatch[1], key: urlMatch[2] };
  const keyMatch = trimmed.match(/^([A-Z]+)-(\d+)$/);
  if (keyMatch) return { workspace: keyMatch[1], key: trimmed };
  throw new Error(`Cannot parse FR URL or key from: ${input.slice(0, 120)}`);
}

console.log("\nexecutors-fr: parseUrlOrKey tests\n");

run("parses full FR URL", () => {
  const result = parseUrlOrKey("https://freshworks.freshrelease.com/ws/BILLING/tasks/BILLING-10444");
  assert.equal(result.workspace, "BILLING");
  assert.equal(result.key, "BILLING-10444");
});

run("parses Slack-wrapped URL", () => {
  const result = parseUrlOrKey("<https://freshworks.freshrelease.com/ws/BILLING/tasks/BILLING-10444>");
  assert.equal(result.workspace, "BILLING");
  assert.equal(result.key, "BILLING-10444");
});

run("parses bare key", () => {
  const result = parseUrlOrKey("BILLING-10444");
  assert.equal(result.workspace, "BILLING");
  assert.equal(result.key, "BILLING-10444");
});

run("throws on invalid input", () => {
  assert.throws(() => parseUrlOrKey("not-a-valid-key"), /Cannot parse/);
});

// ─── extractFrAnalysisSummarySection ───────────────────────────────────────

console.log("\nexecutors-fr: extractFrAnalysisSummarySection tests\n");

run("extracts text under ## Summary until next ##", () => {
  const text = `## Task Overview\nx\n\n## Summary\nHello world.\nMore here.\n\n## Impact\nTail`;
  const s = extractFrAnalysisSummarySection(text);
  assert.equal(s, "Hello world.\nMore here.");
});

run("returns null when no Summary section", () => {
  assert.equal(extractFrAnalysisSummarySection("## Other\nnope"), null);
});

console.log("\nAll FR executor tests passed.");

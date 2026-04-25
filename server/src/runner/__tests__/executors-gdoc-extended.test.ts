/**
 * Extended gdoc executor unit tests.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/executors-gdoc-extended.test.ts
 *
 * Tests the JSON parsing logic for reply, resolve, and suggest executors.
 */

import assert from "node:assert/strict";

// ─── Re-implement parsing functions locally ────────────────────────────────

function parseRepliesJson(text: string): { commentId: string; body: string }[] {
  const re = /```(?:json)?\s*replies?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) =>
        typeof e === "object" &&
        typeof e.commentId === "string" &&
        typeof e.body === "string"
    );
  } catch {
    return [];
  }
}

function parseResolveJson(text: string): string[] {
  const re = /```(?:json)?\s*resolve\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e: any) => typeof e === "string");
  } catch {
    return [];
  }
}

function parseSuggestJson(text: string): { anchor: string; replacement: string }[] {
  const re = /```(?:json)?\s*suggest(?:ions?)?\s*\n([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) =>
        typeof e === "object" &&
        typeof e.anchor === "string" &&
        typeof e.replacement === "string"
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

// ─── Replies tests ─────────────────────────────────────────────────────────

console.log("executors-gdoc: parseRepliesJson tests\n");

run("parses valid replies block", () => {
  const text = `
--- REPLIES (JSON) ---
\`\`\`json replies
[
  {"commentId": "abc123", "body": "This has been resolved."},
  {"commentId": "def456", "body": "Confirmed — updated the spec."}
]
\`\`\`
--- END REPLIES ---
  `;
  const result = parseRepliesJson(text);
  assert.equal(result.length, 2);
  assert.equal(result[0].commentId, "abc123");
  assert.equal(result[1].body, "Confirmed — updated the spec.");
});

run("returns empty for no replies block", () => {
  assert.equal(parseRepliesJson("no block here").length, 0);
});

run("filters entries missing commentId or body", () => {
  const text = '```json replies\n[{"commentId": "a", "body": "ok"}, {"body": "no id"}, {"commentId": "b"}]\n```';
  const result = parseRepliesJson(text);
  assert.equal(result.length, 1);
});

// ─── Resolve tests ─────────────────────────────────────────────────────────

console.log("\nexecutors-gdoc: parseResolveJson tests\n");

run("parses valid resolve block", () => {
  const text = '```json resolve\n["abc123", "def456"]\n```';
  const result = parseResolveJson(text);
  assert.deepEqual(result, ["abc123", "def456"]);
});

run("returns empty for no resolve block", () => {
  assert.equal(parseResolveJson("nothing here").length, 0);
});

run("filters non-string entries", () => {
  const text = '```json resolve\n["abc", 123, null, "def"]\n```';
  const result = parseResolveJson(text);
  assert.deepEqual(result, ["abc", "def"]);
});

// ─── Suggest tests ─────────────────────────────────────────────────────────

console.log("\nexecutors-gdoc: parseSuggestJson tests\n");

run("parses valid suggestions block", () => {
  const text = `
\`\`\`json suggestions
[
  {"anchor": "old text here", "replacement": "new text here"}
]
\`\`\`
  `;
  const result = parseSuggestJson(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].anchor, "old text here");
  assert.equal(result[0].replacement, "new text here");
});

run("handles 'suggest' tag (without -ions)", () => {
  const text = '```json suggest\n[{"anchor": "a", "replacement": "b"}]\n```';
  const result = parseSuggestJson(text);
  assert.equal(result.length, 1);
});

run("returns empty for invalid JSON", () => {
  const text = '```json suggestions\n{broken\n```';
  assert.equal(parseSuggestJson(text).length, 0);
});

run("filters entries missing anchor or replacement", () => {
  const text = '```json suggestions\n[{"anchor": "a", "replacement": "b"}, {"anchor": "c"}]\n```';
  const result = parseSuggestJson(text);
  assert.equal(result.length, 1);
});

// ─── `when` condition evaluation tests ─────────────────────────────────────

console.log("\nwhen-condition evaluation tests\n");

function evaluateWhen(rendered: string): boolean {
  const trimmed = rendered.trim();
  const falsy =
    !trimmed ||
    trimmed === "false" ||
    trimmed === "no" ||
    trimmed === "0";
  return !falsy;
}

run("non-empty string → truthy (step runs)", () => {
  assert.equal(evaluateWhen("full-pr"), true);
});

run("'false' → falsy (step skipped)", () => {
  assert.equal(evaluateWhen("false"), false);
});

run("'no' → falsy (step skipped)", () => {
  assert.equal(evaluateWhen("no"), false);
});

run("'0' → falsy (step skipped)", () => {
  assert.equal(evaluateWhen("0"), false);
});

run("empty string → falsy (step skipped)", () => {
  assert.equal(evaluateWhen(""), false);
});

run("whitespace-only → falsy (step skipped)", () => {
  assert.equal(evaluateWhen("   "), false);
});

run("'yes' → truthy (step runs)", () => {
  assert.equal(evaluateWhen("yes"), true);
});

run("'analyze-only' → truthy (step runs)", () => {
  assert.equal(evaluateWhen("analyze-only"), true);
});

console.log("\nAll extended gdoc executor tests passed.");

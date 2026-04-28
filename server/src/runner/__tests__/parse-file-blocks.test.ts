/**
 * Unit tests for parseFileBlocks / normalizeFileBlockSource.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/parse-file-blocks.test.ts
 */

import assert from "node:assert/strict";
import {
  normalizeFileBlockSource,
  parseFileBlocks,
} from "../executors";

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

console.log("parseFileBlocks tests\n");

run("parses ```path=.archon/rules/a.md opening (no lang, no space)", () => {
  const text = "```path=.archon/rules/a.md\n# hello\n```";
  const b = parseFileBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].path, ".archon/rules/a.md");
  assert.ok(b[0].content.includes("# hello"));
});

run("parses path= with trailing text on opening line", () => {
  const text =
    "```tsx path=src/x.tsx   (tech stack)\nexport const x = 1;\n```";
  const b = parseFileBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].path, "src/x.tsx");
});

run("Path= is case-insensitive on opening line", () => {
  const text = "```Path=.archon/rules/conventions.md\n# c\n```";
  const b = parseFileBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].path, ".archon/rules/conventions.md");
});

run("FILE= alias works", () => {
  const text = "```md file=out/readme.txt\nhi\n```";
  const b = parseFileBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].path, "out/readme.txt");
});

run("filepath= alias parses full keyword (not truncated file)", () => {
  const text = "```filepath=out/x.md\nx\n```";
  const b = parseFileBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].path, "out/x.md");
});

run("CRLF line endings parse", () => {
  const text = "```path=a/b.md\r\n# t\r\n```\r\n";
  const b = parseFileBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].path, "a/b.md");
});

run("strip UTF-8 BOM before parse", () => {
  const text = "\uFEFF```path=z.md\nx\n```";
  const n = normalizeFileBlockSource(text);
  assert.equal(n.charCodeAt(0), "`".charCodeAt(0));
  const b = parseFileBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].path, "z.md");
});

run("double-quoted path", () => {
  const text = '```path=".archon/rules/spaced name.md"\nok\n```';
  const b = parseFileBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].path, ".archon/rules/spaced name.md");
});

if (process.exitCode !== 1) {
  console.log("\nAll tests passed.");
}

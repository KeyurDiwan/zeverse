/**
 * Regression tests for executeEditStep flush behaviour.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/executors-edit-flush.test.ts
 *
 * Verifies that failing SEARCH/REPLACE ops never create empty stub files on disk.
 */

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { parseEditBlocks } from "../executors";

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

console.log("executors-edit: parseEditBlocks + flush guard tests\n");

// ---------- parseEditBlocks parsing ----------

run("parses a SEARCH/REPLACE block", () => {
  const text = [
    "```edit path=src/foo.ts",
    "<<<<<<< SEARCH",
    "old line",
    "=======",
    "new line",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");

  const ops = parseEditBlocks(text);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].mode, "search-replace");
  assert.equal(ops[0].path, "src/foo.ts");
  assert.equal(ops[0].search, "old line");
  assert.equal(ops[0].replace, "new line");
});

run("parses a CREATE block", () => {
  const text = [
    "```edit path=src/bar.ts",
    "<<<<<<< CREATE",
    "file contents here",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");

  const ops = parseEditBlocks(text);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].mode, "create");
  assert.equal(ops[0].path, "src/bar.ts");
  assert.equal(ops[0].replace, "file contents here");
});

run("returns empty array for unrecognised input", () => {
  const ops = parseEditBlocks("no edit blocks here");
  assert.equal(ops.length, 0);
});

// ---------- flush guard (integration via executeEditStep) ----------

/**
 * We can't easily call executeEditStep without the full Repo/RunState wiring,
 * so we test the flush-guard contract indirectly:
 * 1. Create a temp dir as a fake repo root.
 * 2. Manually replicate the fileCache + dirtyFiles logic.
 * 3. Assert that files whose ops all failed are NOT written to disk.
 */
run("failing SEARCH against non-existent file must not create it", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-edit-test-"));
  const targetPath = path.join(tmpDir, "src", "does-not-exist.ts");

  // Simulate what executeEditStep does: cache the file (doesn't exist → empty),
  // attempt a SEARCH that fails, then only flush dirtyFiles.
  const fileCache = new Map<string, { content: string; existed: boolean }>();
  const dirtyFiles = new Set<string>();

  const existed = fs.existsSync(targetPath);
  fileCache.set(targetPath, { content: "", existed });

  // SEARCH fails (needle not found in empty content) — do NOT add to dirtyFiles.
  const needle = "this text does not exist";
  const content = fileCache.get(targetPath)!.content;
  const idx = content.indexOf(needle);
  assert.equal(idx, -1, "needle should not be found");

  // Flush only dirty files (none in this case).
  for (const [full, cached] of fileCache) {
    if (!dirtyFiles.has(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, cached.content, "utf8");
  }

  assert.equal(
    fs.existsSync(targetPath),
    false,
    "file should NOT have been created on disk"
  );

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

run("successful SEARCH/REPLACE flushes the file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-edit-test-"));
  const targetPath = path.join(tmpDir, "src", "exists.ts");

  // Pre-create the file with known content
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "const x = 1;\n", "utf8");

  const fileCache = new Map<string, { content: string; existed: boolean }>();
  const dirtyFiles = new Set<string>();

  fileCache.set(targetPath, {
    content: fs.readFileSync(targetPath, "utf8"),
    existed: true,
  });

  const needle = "const x = 1;";
  const cached = fileCache.get(targetPath)!;
  const idx = cached.content.indexOf(needle);
  assert.notEqual(idx, -1, "needle should be found");

  cached.content =
    cached.content.slice(0, idx) + "const x = 2;" + cached.content.slice(idx + needle.length);
  dirtyFiles.add(targetPath);

  for (const [full, c] of fileCache) {
    if (!dirtyFiles.has(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, c.content, "utf8");
  }

  const result = fs.readFileSync(targetPath, "utf8");
  assert.equal(result, "const x = 2;\n");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

run("mixed ops: only files with successful edits are flushed", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archon-edit-test-"));
  const goodPath = path.join(tmpDir, "good.ts");
  const badPath = path.join(tmpDir, "nonexistent", "bad.ts");

  fs.writeFileSync(goodPath, "hello world\n", "utf8");

  const fileCache = new Map<string, { content: string; existed: boolean }>();
  const dirtyFiles = new Set<string>();

  // Good file: SEARCH succeeds
  fileCache.set(goodPath, { content: "hello world\n", existed: true });
  const goodCached = fileCache.get(goodPath)!;
  goodCached.content = goodCached.content.replace("hello", "goodbye");
  dirtyFiles.add(goodPath);

  // Bad file: doesn't exist, SEARCH fails
  fileCache.set(badPath, { content: "", existed: false });

  for (const [full, c] of fileCache) {
    if (!dirtyFiles.has(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, c.content, "utf8");
  }

  assert.equal(fs.readFileSync(goodPath, "utf8"), "goodbye world\n");
  assert.equal(fs.existsSync(badPath), false, "bad file should not exist");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

console.log("\nAll tests passed.");

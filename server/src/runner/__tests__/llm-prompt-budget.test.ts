import assert from "node:assert/strict";
import { clampUserPromptForModel } from "../llm-prompt-budget";

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
};

run("no truncation under limit", () => {
  const s = "abc".repeat(100);
  const r = clampUserPromptForModel(s, 10_000);
  assert.equal(r.truncated, false);
  assert.equal(r.text, s);
});

run("truncation keeps head and tail", () => {
  const s = "HEAD-" + "x".repeat(5000) + "-TAIL";
  const r = clampUserPromptForModel(s, 2000);
  assert.equal(r.truncated, true);
  assert.ok(r.text.startsWith("HEAD-"));
  assert.ok(r.text.includes("-TAIL"));
  assert.ok(r.text.includes("Truncated"));
});

console.log("\nllm-prompt-budget tests done.");

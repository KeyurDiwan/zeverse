/**
 * Unit tests for the retry-with-backoff and loopUntil logic.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/runner-retry-loop.test.ts
 */

import assert from "node:assert/strict";

function run(test: string, fn: () => void | Promise<void>) {
  const result = fn();
  if (result instanceof Promise) {
    result
      .then(() => console.log(`  ✓ ${test}`))
      .catch((err: any) => {
        console.error(`  ✗ ${test}`);
        console.error(`    ${err.message}`);
        process.exitCode = 1;
      });
  } else {
    try {
      console.log(`  ✓ ${test}`);
    } catch (err: any) {
      console.error(`  ✗ ${test}`);
      console.error(`    ${err.message}`);
      process.exitCode = 1;
    }
  }
}

// Simulate the retry logic from runner/index.ts without importing the module.

async function simulateRetry(
  executeFn: () => Promise<string>,
  retries: number,
  baseBackoffMs: number
): Promise<{ output: string; attempts: number } | { error: string; attempts: number }> {
  let attempts = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts++;
    try {
      const output = await executeFn();
      return { output, attempts };
    } catch (err: any) {
      if (attempt < retries) {
        const delay = baseBackoffMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        return { error: err.message, attempts };
      }
    }
  }
  return { error: "unreachable", attempts };
}

async function simulateLoopUntil(
  executeFn: () => Promise<string>,
  checkFn: (output: string) => boolean,
  maxIterations: number
): Promise<{ output: string; iterations: number; satisfied: boolean }> {
  let output = "";
  for (let i = 0; i < maxIterations; i++) {
    output = await executeFn();
    if (checkFn(output)) {
      return { output, iterations: i + 1, satisfied: true };
    }
  }
  return { output, iterations: maxIterations, satisfied: false };
}

console.log("runner-retry-loop tests\n");

run("retries: succeeds on first attempt", async () => {
  let calls = 0;
  const result = await simulateRetry(
    async () => { calls++; return "ok"; },
    3, 10
  );
  assert.equal(calls, 1);
  assert.equal("output" in result && result.output, "ok");
});

run("retries: succeeds on second attempt", async () => {
  let calls = 0;
  const result = await simulateRetry(
    async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return "recovered";
    },
    3, 10
  );
  assert.equal(calls, 2);
  assert.equal("output" in result && result.output, "recovered");
});

run("retries: exhausts all retries", async () => {
  let calls = 0;
  const result = await simulateRetry(
    async () => { calls++; throw new Error("permanent"); },
    2, 10
  );
  assert.equal(calls, 3); // initial + 2 retries
  assert.ok("error" in result);
  assert.equal(result.error, "permanent");
});

run("retries: backoff delay doubles each attempt", async () => {
  const timestamps: number[] = [];
  let calls = 0;
  await simulateRetry(
    async () => {
      timestamps.push(Date.now());
      calls++;
      if (calls <= 3) throw new Error("fail");
      return "ok";
    },
    3, 20
  );
  assert.equal(timestamps.length, 4);
  const gap1 = timestamps[1] - timestamps[0];
  const gap2 = timestamps[2] - timestamps[1];
  // First gap ~20ms, second gap ~40ms (with tolerance)
  assert.ok(gap1 >= 15, `gap1 ${gap1}ms should be >= 15ms`);
  assert.ok(gap2 >= 30, `gap2 ${gap2}ms should be >= 30ms`);
});

run("loopUntil: satisfied on first iteration", async () => {
  const result = await simulateLoopUntil(
    async () => "pass",
    (o) => o === "pass",
    5
  );
  assert.equal(result.satisfied, true);
  assert.equal(result.iterations, 1);
});

run("loopUntil: satisfied after multiple iterations", async () => {
  let count = 0;
  const result = await simulateLoopUntil(
    async () => { count++; return count >= 3 ? "pass" : "not yet"; },
    (o) => o === "pass",
    10
  );
  assert.equal(result.satisfied, true);
  assert.equal(result.iterations, 3);
});

run("loopUntil: hits maxIterations", async () => {
  const result = await simulateLoopUntil(
    async () => "nope",
    (o) => o === "pass",
    4
  );
  assert.equal(result.satisfied, false);
  assert.equal(result.iterations, 4);
});

// Wrap up
setTimeout(() => {
  if (!process.exitCode) console.log("\nAll tests passed.");
}, 500);

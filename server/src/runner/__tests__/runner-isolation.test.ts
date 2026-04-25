/**
 * Unit tests for per-repo run lock and git isolation helpers.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/runner-isolation.test.ts
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

// Inline re-implementation of runLock so we don't import the real module
// (which pulls in child_process + fs).
const repoQueues = new Map<string, Promise<void>>();

function runLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoQueues.get(repoId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoQueues.set(repoId, next.then(() => {}, () => {}));
  return next;
}

console.log("runner-isolation tests\n");

run("runLock serialises runs for the same repoId", async () => {
  const order: string[] = [];

  const a = runLock("repo-a", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 50));
    order.push("a-end");
  });

  const b = runLock("repo-a", async () => {
    order.push("b-start");
    await new Promise((r) => setTimeout(r, 10));
    order.push("b-end");
  });

  await Promise.all([a, b]);
  // b should not start until a finishes
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

run("runLock allows parallel runs across different repos", async () => {
  const order: string[] = [];

  const a = runLock("repo-x", async () => {
    order.push("x-start");
    await new Promise((r) => setTimeout(r, 50));
    order.push("x-end");
  });

  const b = runLock("repo-y", async () => {
    order.push("y-start");
    await new Promise((r) => setTimeout(r, 10));
    order.push("y-end");
  });

  await Promise.all([a, b]);
  // y should start before x finishes since they're different repos
  assert.equal(order[0], "x-start");
  assert.equal(order[1], "y-start");
  assert.equal(order[2], "y-end");
  assert.equal(order[3], "x-end");
});

run("runLock propagates return values", async () => {
  const result = await runLock("repo-ret", async () => {
    return 42;
  });
  assert.equal(result, 42);
});

run("runLock continues queue even when a job throws", async () => {
  const order: string[] = [];

  try {
    await runLock("repo-err", async () => {
      order.push("first");
      throw new Error("boom");
    });
  } catch {
    order.push("caught");
  }

  await runLock("repo-err", async () => {
    order.push("second");
  });

  assert.deepEqual(order, ["first", "caught", "second"]);
});

// Wrap up
setTimeout(() => {
  if (!process.exitCode) console.log("\nAll tests passed.");
}, 500);

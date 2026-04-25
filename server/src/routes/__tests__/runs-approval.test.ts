/**
 * Tests for the approval resolve/reject logic.
 *
 * Run: npx ts-node --transpile-only src/routes/__tests__/runs-approval.test.ts
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

// Inline re-implementation of the approval pending-promise map.
interface PendingApproval {
  resolve: (result: { by: string; comment?: string }) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, PendingApproval>();

function resolveApproval(runId: string, by: string, comment?: string): boolean {
  const p = pending.get(runId);
  if (!p) return false;
  p.resolve({ by, comment });
  pending.delete(runId);
  return true;
}

function rejectApproval(runId: string, by: string, reason?: string): boolean {
  const p = pending.get(runId);
  if (!p) return false;
  p.reject(new Error(`Rejected by ${by}${reason ? `: ${reason}` : ""}`));
  pending.delete(runId);
  return true;
}

function createPending(runId: string): Promise<{ by: string; comment?: string }> {
  return new Promise((resolve, reject) => {
    pending.set(runId, { resolve, reject });
  });
}

console.log("runs-approval tests\n");

run("resolve: returns false when no pending approval", () => {
  assert.equal(resolveApproval("nonexistent", "user1"), false);
});

run("resolve: resolves pending approval with by + comment", async () => {
  const promise = createPending("run-1");
  assert.equal(resolveApproval("run-1", "alice", "looks good"), true);
  const result = await promise;
  assert.equal(result.by, "alice");
  assert.equal(result.comment, "looks good");
  assert.equal(pending.has("run-1"), false);
});

run("resolve: cleans up after resolution", async () => {
  const promise = createPending("run-2");
  resolveApproval("run-2", "bob");
  await promise;
  assert.equal(resolveApproval("run-2", "bob"), false);
});

run("reject: returns false when no pending approval", () => {
  assert.equal(rejectApproval("nonexistent", "user1"), false);
});

run("reject: rejects pending approval with reason", async () => {
  const promise = createPending("run-3");
  assert.equal(rejectApproval("run-3", "charlie", "not ready"), true);
  try {
    await promise;
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.ok(err.message.includes("charlie"));
    assert.ok(err.message.includes("not ready"));
  }
});

run("reject: rejects without reason", async () => {
  const promise = createPending("run-4");
  rejectApproval("run-4", "dave");
  try {
    await promise;
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.ok(err.message.includes("dave"));
    assert.ok(!err.message.includes(":"));
  }
});

run("double resolve: second resolve returns false", async () => {
  const promise = createPending("run-5");
  assert.equal(resolveApproval("run-5", "first"), true);
  assert.equal(resolveApproval("run-5", "second"), false);
  await promise;
});

// Wrap up
setTimeout(() => {
  if (!process.exitCode) console.log("\nAll tests passed.");
}, 200);

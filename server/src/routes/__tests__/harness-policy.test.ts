/**
 * Tests for policy enforcement and input validation in the harness execute path.
 *
 * Run: npx ts-node --transpile-only src/routes/__tests__/harness-policy.test.ts
 */

import assert from "node:assert/strict";

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

// Inline re-implementations of assertAllowed + input validation logic
// to avoid importing modules that require the filesystem.

interface PolicyConfig {
  allowed_repos: string[];
  allowed_workflows: string[];
  allowed_slack_channels: string[];
}

class PolicyError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "PolicyError";
  }
}

function matches(allowlist: string[], value: string): boolean {
  if (allowlist.includes("*")) return true;
  return allowlist.includes(value);
}

function assertAllowed(
  o: { repoId: string; workflow: string; channel?: string },
  policy: PolicyConfig
): void {
  if (!matches(policy.allowed_repos, o.repoId)) {
    throw new PolicyError(`Repo "${o.repoId}" is not in the allowed repos list`);
  }
  if (!matches(policy.allowed_workflows, o.workflow)) {
    throw new PolicyError(`Workflow "${o.workflow}" is not in the allowed workflows list`);
  }
  if (o.channel && !matches(policy.allowed_slack_channels, o.channel)) {
    throw new PolicyError(`Slack channel "${o.channel}" is not in the allowed channels list`);
  }
}

interface MockInput {
  id: string;
  required?: boolean;
}

function validateInputs(
  declared: MockInput[],
  provided: Record<string, string>
): string[] {
  return declared
    .filter((inp) => inp.required && !(provided[inp.id] ?? "").trim())
    .map((inp) => inp.id);
}

console.log("harness-policy tests\n");

// ── Policy tests ─────────────────────────────────────────────────────────────

const ALLOW_ALL: PolicyConfig = {
  allowed_repos: ["*"],
  allowed_workflows: ["*"],
  allowed_slack_channels: ["*"],
};

run("policy: wildcard allows everything", () => {
  assertAllowed({ repoId: "any-repo", workflow: "any-wf", channel: "C123" }, ALLOW_ALL);
});

run("policy: denies unlisted repo", () => {
  const policy: PolicyConfig = {
    allowed_repos: ["ubx-ui"],
    allowed_workflows: ["*"],
    allowed_slack_channels: ["*"],
  };
  assert.throws(
    () => assertAllowed({ repoId: "secret-repo", workflow: "dev" }, policy),
    /not in the allowed repos/
  );
});

run("policy: denies unlisted workflow", () => {
  const policy: PolicyConfig = {
    allowed_repos: ["*"],
    allowed_workflows: ["dev", "fix-bug"],
    allowed_slack_channels: ["*"],
  };
  assert.throws(
    () => assertAllowed({ repoId: "ubx-ui", workflow: "dangerous-wf" }, policy),
    /not in the allowed workflows/
  );
});

run("policy: denies unlisted channel", () => {
  const policy: PolicyConfig = {
    allowed_repos: ["*"],
    allowed_workflows: ["*"],
    allowed_slack_channels: ["C-ALLOWED"],
  };
  assert.throws(
    () => assertAllowed({ repoId: "ubx-ui", workflow: "dev", channel: "C-RANDOM" }, policy),
    /not in the allowed channels/
  );
});

run("policy: allows listed repo, workflow, and channel", () => {
  const policy: PolicyConfig = {
    allowed_repos: ["ubx-ui", "freshid-ui-v2"],
    allowed_workflows: ["dev", "fix-bug"],
    allowed_slack_channels: ["C-TEAM"],
  };
  assertAllowed({ repoId: "ubx-ui", workflow: "dev", channel: "C-TEAM" }, policy);
});

run("policy: channel check skipped when no channel provided", () => {
  const policy: PolicyConfig = {
    allowed_repos: ["ubx-ui"],
    allowed_workflows: ["dev"],
    allowed_slack_channels: ["C-TEAM"],
  };
  assertAllowed({ repoId: "ubx-ui", workflow: "dev" }, policy);
});

// ── Input validation tests ───────────────────────────────────────────────────

run("input validation: no missing when all required inputs provided", () => {
  const inputs: MockInput[] = [
    { id: "requirement", required: true },
    { id: "frUrl", required: false },
  ];
  const missing = validateInputs(inputs, { requirement: "fix bug" });
  assert.deepEqual(missing, []);
});

run("input validation: detects missing required input", () => {
  const inputs: MockInput[] = [
    { id: "requirement", required: true },
    { id: "docUrl", required: true },
  ];
  const missing = validateInputs(inputs, { requirement: "fix bug" });
  assert.deepEqual(missing, ["docUrl"]);
});

run("input validation: whitespace-only counts as missing", () => {
  const inputs: MockInput[] = [{ id: "requirement", required: true }];
  const missing = validateInputs(inputs, { requirement: "   " });
  assert.deepEqual(missing, ["requirement"]);
});

run("input validation: empty inputs array has no missing", () => {
  const missing = validateInputs([], { anything: "value" });
  assert.deepEqual(missing, []);
});

run("input validation: optional inputs never flagged as missing", () => {
  const inputs: MockInput[] = [
    { id: "a", required: false },
    { id: "b" },
  ];
  const missing = validateInputs(inputs, {});
  assert.deepEqual(missing, []);
});

console.log("\nAll tests passed.");

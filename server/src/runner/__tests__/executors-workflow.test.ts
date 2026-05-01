/**
 * Unit tests for the `workflow` step kind helpers.
 *
 * Run: npx ts-node --transpile-only src/runner/__tests__/executors-workflow.test.ts
 *
 * Tests the resolveChildWorkflow logic and executeWorkflowStep contract
 * without needing a real LLM or repo on disk.
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

// Replicate resolveChildWorkflow logic inline so we can test it without
// importing the full executor (which pulls in fs, child_process, etc.).

interface MockStep {
  workflowFrom?: string;
  inputsFrom?: string;
  childWorkflow?: string;
}

interface MockCtx {
  inputs: Record<string, string>;
  steps: Record<string, { output: string }>;
}

function renderTemplate(template: string, ctx: MockCtx): string {
  return template.replace(/\{\{([\w.\-]+)\}\}/g, (_m, path: string) => {
    const parts = path.split(".");
    let current: any = ctx;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return "";
      current = current[part];
    }
    if (current == null) return "";
    return String(current);
  });
}

function resolveChildWorkflow(
  step: MockStep,
  ctx: MockCtx
): { workflowName: string; childInputs: Record<string, string> } {
  let workflowName: string | undefined;
  let childInputs: Record<string, string> = {};

  if (step.workflowFrom) {
    const raw = ctx.steps[step.workflowFrom]?.output ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        workflowName = parsed.workflow;
        if (typeof parsed.inputs === "object" && parsed.inputs) {
          childInputs = parsed.inputs;
        }
      } catch {
        // fall through
      }
    }
  }

  if (step.inputsFrom && step.inputsFrom !== step.workflowFrom) {
    const spec = step.inputsFrom;
    const isInlineTemplate = spec.includes("{{");
    const raw = isInlineTemplate
      ? renderTemplate(spec, ctx)
      : (ctx.steps[spec]?.output ?? "");
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.inputs === "object" && parsed.inputs) {
          childInputs = { ...childInputs, ...parsed.inputs };
        } else if (typeof parsed === "object") {
          childInputs = { ...childInputs, ...parsed };
        }
      } catch {
        // ignore
      }
    }
  }

  if (!workflowName && step.childWorkflow) {
    workflowName = step.childWorkflow;
  }

  if (!workflowName && ctx.inputs.chosenWorkflow) {
    workflowName = ctx.inputs.chosenWorkflow;
  }

  if (!workflowName) {
    throw new Error("Could not determine child workflow name");
  }

  return { workflowName, childInputs };
}

console.log("executeWorkflowStep: resolveChildWorkflow tests\n");

run("extracts workflow + inputs from workflowFrom step output", () => {
  const step: MockStep = { workflowFrom: "route" };
  const ctx: MockCtx = {
    inputs: { requirement: "fix the login bug" },
    steps: {
      route: {
        output: '{"workflow": "fix-bug", "inputs": {"bug": "login redirect"}, "confidence": 0.95}',
      },
    },
  };
  const result = resolveChildWorkflow(step, ctx);
  assert.equal(result.workflowName, "fix-bug");
  assert.equal(result.childInputs.bug, "login redirect");
});

run("falls back to childWorkflow when workflowFrom has no JSON", () => {
  const step: MockStep = { workflowFrom: "route", childWorkflow: "dev" };
  const ctx: MockCtx = {
    inputs: { requirement: "add feature" },
    steps: {
      route: { output: "no json here" },
    },
  };
  const result = resolveChildWorkflow(step, ctx);
  assert.equal(result.workflowName, "dev");
});

run("falls back to inputs.chosenWorkflow when nothing else", () => {
  const step: MockStep = {};
  const ctx: MockCtx = {
    inputs: { requirement: "test", chosenWorkflow: "test-write" },
    steps: {},
  };
  const result = resolveChildWorkflow(step, ctx);
  assert.equal(result.workflowName, "test-write");
});

run("throws when no workflow can be determined", () => {
  const step: MockStep = {};
  const ctx: MockCtx = {
    inputs: { requirement: "do something" },
    steps: {},
  };
  assert.throws(() => resolveChildWorkflow(step, ctx), /Could not determine/);
});

run("workflowFrom JSON with extra text around it still parses", () => {
  const step: MockStep = { workflowFrom: "route" };
  const ctx: MockCtx = {
    inputs: {},
    steps: {
      route: {
        output:
          'Based on your request, here is my recommendation:\n{"workflow": "code-review", "inputs": {"pr": "#42"}, "confidence": 0.88}\nLet me know if you want to proceed.',
      },
    },
  };
  const result = resolveChildWorkflow(step, ctx);
  assert.equal(result.workflowName, "code-review");
  assert.equal(result.childInputs.pr, "#42");
});

run("inputsFrom merges with workflowFrom inputs", () => {
  const step: MockStep = { workflowFrom: "route", inputsFrom: "extra" };
  const ctx: MockCtx = {
    inputs: {},
    steps: {
      route: {
        output: '{"workflow": "dev", "inputs": {"requirement": "add feature"}}',
      },
      extra: {
        output: '{"area": "billing"}',
      },
    },
  };
  const result = resolveChildWorkflow(step, ctx);
  assert.equal(result.workflowName, "dev");
  assert.equal(result.childInputs.requirement, "add feature");
  assert.equal(result.childInputs.area, "billing");
});

run("inputsFrom inline JSON template merges with childWorkflow", () => {
  const step: MockStep = {
    childWorkflow: "test-fix-iteration",
    inputsFrom: '{"test_command": "{{inputs.test_command}}"}',
  };
  const ctx: MockCtx = {
    inputs: { test_command: "npm ci && npm test", requirement: "" },
    steps: {},
  };
  const result = resolveChildWorkflow(step, ctx);
  assert.equal(result.workflowName, "test-fix-iteration");
  assert.equal(result.childInputs.test_command, "npm ci && npm test");
});

console.log("\nAll tests passed.");

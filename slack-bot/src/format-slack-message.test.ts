import assert from "node:assert";
import { describe, it } from "node:test";
import {
  bulletsToNumberedLines,
  normalizeSlackMrkdwn,
  wrapWorkflowSummary,
} from "./format-slack-message";

describe("normalizeSlackMrkdwn", () => {
  it("collapses excessive newlines and trims trailing spaces", () => {
    assert.strictEqual(
      normalizeSlackMrkdwn("a  \n\n\n\n\nb"),
      "a\n\nb"
    );
  });

  it("trims outer whitespace", () => {
    assert.strictEqual(normalizeSlackMrkdwn("\n  hello  \n"), "hello");
  });
});

describe("bulletsToNumberedLines", () => {
  it("renumbers hyphen bullets at column 0", () => {
    const input = "- first\n- second\n";
    assert.strictEqual(
      bulletsToNumberedLines(input),
      "1. first\n2. second\n"
    );
  });

  it("skips fenced code blocks", () => {
    const input =
      "- outside\n```\n- keep as-is\n```\n- after\n";
    assert.strictEqual(
      bulletsToNumberedLines(input),
      "1. outside\n```\n- keep as-is\n```\n1. after\n"
    );
  });

  it("preserves indented nested lines", () => {
    const input = "- parent\n  - nested\n- next\n";
    const out = bulletsToNumberedLines(input);
    assert.ok(out.includes("1. parent"));
    assert.ok(out.includes("  - nested"));
    assert.ok(out.includes("2. next"));
  });

  it("resets numbering after blank line", () => {
    const input = "- one\n\n- two\n";
    assert.strictEqual(
      bulletsToNumberedLines(input),
      "1. one\n\n1. two\n"
    );
  });

  it("handles • bullets", () => {
    assert.strictEqual(
      bulletsToNumberedLines("• a\n• b"),
      "1. a\n2. b"
    );
  });
});

describe("wrapWorkflowSummary", () => {
  it("formats title body footer", () => {
    assert.strictEqual(
      wrapWorkflowSummary({
        title: "Done",
        body: "line1\nline2",
        footer: "<http://x|link>",
      }),
      "*Done*\n\nline1\nline2\n\n<http://x|link>"
    );
  });

  it("allows pre-bold title", () => {
    assert.strictEqual(
      wrapWorkflowSummary({
        title: "*Already*",
        body: "",
      }),
      "*Already*"
    );
  });
});

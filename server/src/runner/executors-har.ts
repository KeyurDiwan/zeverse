import fs from "fs";
import path from "path";
import type { WorkflowStep } from "../workflows";
import { renderTemplate, TemplateContext } from "./template";
import { appendLog } from "./state";

const MAX_OUTPUT_BYTES = 20_000;
const MAX_BODY_PREVIEW = 2_000;

interface HarEntry {
  request: { method: string; url: string };
  response: {
    status: number;
    statusText?: string;
    content?: { size?: number; text?: string; mimeType?: string };
  };
  time?: number;
}

interface HarLog {
  log: { entries: HarEntry[] };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
}

function extractApiPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search.slice(0, 80) : "");
  } catch {
    return url.length > 120 ? url.slice(0, 120) : url;
  }
}

function resolveHarPath(step: WorkflowStep, ctx: TemplateContext): string | null {
  if (step.harPath) return renderTemplate(step.harPath, ctx);

  if (step.harPathFrom) {
    const stepOutput = ctx.steps[step.harPathFrom]?.output ?? "";
    const match = stepOutput.match(/^- har:\s*(.+)$/m);
    if (match) return match[1].trim();
  }

  return null;
}

function filterByPage(entries: HarEntry[], pageHint: string): HarEntry[] {
  if (!pageHint) return entries;
  const lower = pageHint.toLowerCase();
  const tokens = lower.split(/\s+/).filter((t) => t.length > 2);
  return entries.filter((e) => {
    const url = e.request.url.toLowerCase();
    return tokens.some((tok) => url.includes(tok));
  });
}

export async function executeHarAnalyzeStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const harPath = resolveHarPath(step, ctx);
  if (!harPath || !fs.existsSync(harPath)) {
    const msg = harPath
      ? `HAR file not found at: ${harPath}`
      : "No HAR file path resolved (no har attachment uploaded?)";
    appendLog(repoId, runId, `[${step.id}] ${msg}`);
    return msg;
  }

  appendLog(repoId, runId, `[${step.id}] Parsing HAR: ${harPath}`);

  let raw: string;
  try {
    raw = fs.readFileSync(harPath, "utf-8");
  } catch (err: any) {
    return `Failed to read HAR file: ${err.message}`;
  }

  let har: HarLog;
  try {
    har = JSON.parse(raw);
  } catch (err: any) {
    return `Failed to parse HAR JSON: ${err.message}`;
  }

  if (!har.log?.entries || !Array.isArray(har.log.entries)) {
    return "HAR file has no log.entries array.";
  }

  let entries = har.log.entries;

  const pageHint = step.pageUrlFrom
    ? renderTemplate(`{{inputs.${step.pageUrlFrom}}}`, ctx)
    : "";
  const apiPrefix = step.apiPrefix ?? "";

  if (apiPrefix) {
    entries = entries.filter((e) => e.request.url.includes(apiPrefix));
  }

  const pageFiltered = filterByPage(entries, pageHint);
  if (pageFiltered.length > 0) entries = pageFiltered;

  appendLog(repoId, runId, `[${step.id}] Total entries: ${har.log.entries.length}, filtered: ${entries.length}`);

  const failed: string[] = [];
  const emptyBody: string[] = [];
  const allCalls: string[] = [];

  for (const entry of entries) {
    const method = entry.request.method;
    const apiPath = extractApiPath(entry.request.url);
    const status = entry.response.status;
    const size = entry.response.content?.size ?? 0;
    const bodyText = entry.response.content?.text ?? "";
    const timing = entry.time ? `${Math.round(entry.time)}ms` : "";

    const summary = `${method} ${apiPath} → ${status} (${size}B${timing ? `, ${timing}` : ""})`;
    allCalls.push(summary);

    if (status >= 400) {
      const preview = bodyText ? `\n  Body: ${truncate(bodyText, MAX_BODY_PREVIEW)}` : "";
      failed.push(`${summary}${preview}`);
    }

    const isEmptyResponse =
      (status >= 200 && status < 300) &&
      (size === 0 || !bodyText || bodyText === "null" || bodyText === "{}" || bodyText === "[]");
    if (isEmptyResponse) {
      emptyBody.push(summary);
    }
  }

  const sections: string[] = [];

  sections.push(`### HAR Analysis (${entries.length} API calls)\n`);

  if (failed.length > 0) {
    sections.push(`### Failed Requests (${failed.length})`);
    sections.push(failed.join("\n"));
    sections.push("");
  } else {
    sections.push("### Failed Requests\nNone\n");
  }

  if (emptyBody.length > 0) {
    sections.push(`### Empty / Null Response Bodies (${emptyBody.length})`);
    sections.push(emptyBody.join("\n"));
    sections.push("");
  } else {
    sections.push("### Empty / Null Response Bodies\nNone\n");
  }

  sections.push(`### All API Calls (${allCalls.length})`);
  sections.push(allCalls.join("\n"));

  let output = sections.join("\n");
  if (output.length > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES) + "\n...(output truncated to ~20KB)";
  }

  appendLog(repoId, runId, `[${step.id}] HAR summary: ${failed.length} failed, ${emptyBody.length} empty, ${allCalls.length} total`);
  return output;
}

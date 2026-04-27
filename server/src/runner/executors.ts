import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { LLMProvider } from "../llm";
import type { ArchonConfig } from "../config";
import type { WorkflowStep, Workflow } from "../workflows";
import { findWorkflow } from "../workflows";
import type { Repo } from "../repos";
import { renderTemplate, TemplateContext } from "./template";
import { appendLog } from "./state";

export async function executeLLMStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  llm: LLMProvider,
  repoId: string,
  runId: string
): Promise<string> {
  const prompt = renderTemplate(step.prompt ?? "", ctx);
  appendLog(repoId, runId, `[${step.id}] Sending prompt to LLM (${prompt.length} chars)`);

  const response = await llm.chat([
    { role: "system", content: "You are an expert software engineer assistant." },
    { role: "user", content: prompt },
  ]);

  appendLog(
    repoId,
    runId,
    `[${step.id}] LLM response received (${response.content.length} chars)`
  );
  return response.content;
}

export async function executeShellStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  sessionPath: string,
  runId: string,
  timeoutMs: number
): Promise<string> {
  const command = renderTemplate(step.command ?? "", ctx);
  const cwd = step.cwd ? path.resolve(sessionPath, step.cwd) : sessionPath;

  appendLog(repoId, runId, `[${step.id}] Running: ${command}`);
  appendLog(repoId, runId, `[${step.id}] CWD: ${cwd}`);

  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const proc = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      const msg = `[${step.id}] Killed after ${timeoutMs}ms timeout`;
      appendLog(repoId, runId, msg);
      reject(new Error(msg));
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      for (const line of text.split("\n").filter(Boolean)) {
        appendLog(repoId, runId, `[${step.id}] stdout: ${line}`);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      for (const line of text.split("\n").filter(Boolean)) {
        appendLog(repoId, runId, `[${step.id}] stderr: ${line}`);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const output = chunks.join("");
      appendLog(repoId, runId, `[${step.id}] Exited with code ${code}`);
      if (code !== 0 && !step.continueOnError) {
        reject(new Error(`Command exited with code ${code}\n${output}`));
      } else {
        resolve(output);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Parses fenced code blocks of the form:
 *   ```<lang?> path=<relative/path>
 *   ...file contents...
 *   ```
 * or with `file=` instead of `path=`. Returns each block found.
 */
export function parseFileBlocks(
  text: string
): { path: string; content: string }[] {
  const lines = text.split("\n");
  const blocks: { path: string; content: string }[] = [];
  const openRe =
    /^\s*```(?:[a-zA-Z0-9_+.-]+)?\s+(?:path|file)\s*=\s*["']?([^\s"'`]+)["']?\s*$/;
  const closeRe = /^\s*```\s*$/;

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(openRe);
    if (!m) {
      i++;
      continue;
    }
    const relPath = m[1];
    const buf: string[] = [];
    i++;
    while (i < lines.length && !closeRe.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    // Skip the closing fence if we hit it.
    if (i < lines.length) i++;
    let content = buf.join("\n");
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    blocks.push({ path: relPath, content });
  }
  return blocks;
}

/**
 * Validates that `rel` stays inside `repoRoot` and isn't a forbidden location.
 */
function resolveSafeRepoPath(
  repoRoot: string,
  rel: string
): { ok: true; full: string } | { ok: false; reason: string } {
  if (!rel) return { ok: false, reason: "empty path" };
  if (path.isAbsolute(rel))
    return { ok: false, reason: "absolute paths are not allowed" };

  const normalized = path.normalize(rel);
  if (
    normalized === ".." ||
    normalized.startsWith(".." + path.sep) ||
    normalized.includes(path.sep + ".." + path.sep)
  ) {
    return { ok: false, reason: "path escapes the repository" };
  }

  const forbidden = [".git", ".env", ".env.local", "node_modules"];
  for (const f of forbidden) {
    if (normalized === f || normalized.startsWith(f + path.sep)) {
      return { ok: false, reason: `writes to ${f} are not allowed` };
    }
  }

  const root = path.resolve(repoRoot);
  const full = path.resolve(root, normalized);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { ok: false, reason: "resolved path escapes the repository" };
  }
  return { ok: true, full };
}

export async function executeApplyStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  sessionPath: string,
  runId: string
): Promise<string> {
  const source = renderTemplate(step.content ?? "", ctx);
  const blocks = parseFileBlocks(source);
  const requireBlocks = step.requireBlocks !== false;

  appendLog(
    repoId,
    runId,
    `[${step.id}] Scanned ${source.length} chars; found ${blocks.length} file block(s)`
  );

  if (blocks.length === 0) {
    const msg =
      "No file blocks found. Expected fenced blocks like ```tsx path=src/foo.tsx ...```";
    if (requireBlocks) throw new Error(msg);
    return `(${msg})\n`;
  }

  const shrinkRatio =
    step.shrinkGuardMinRatio === undefined ? 0.4 : step.shrinkGuardMinRatio;
  const shrinkMinBytes =
    step.shrinkGuardMinBytes === undefined ? 1024 : step.shrinkGuardMinBytes;

  const results: string[] = [];
  for (const { path: rel, content } of blocks) {
    const safe = resolveSafeRepoPath(sessionPath, rel);
    if (!safe.ok) {
      const line = `SKIP ${rel}: ${safe.reason}`;
      appendLog(repoId, runId, `[${step.id}] ${line}`);
      results.push(line);
      continue;
    }

    const existed = fs.existsSync(safe.full);
    const prevBytes = existed ? fs.statSync(safe.full).size : 0;
    const newBytes = Buffer.byteLength(content, "utf8");

    if (
      existed &&
      shrinkRatio > 0 &&
      prevBytes > shrinkMinBytes &&
      newBytes < prevBytes * shrinkRatio
    ) {
      const pct = Math.round((newBytes / prevBytes) * 100);
      const line = `SKIP ${rel}: shrink guard — new file is ${newBytes} bytes (${pct}% of ${prevBytes}). Looks like mass content loss. Emit a surgical edit that preserves existing content, or set shrinkGuardMinRatio: 0 on the apply step to override.`;
      appendLog(repoId, runId, `[${step.id}] ${line}`);
      results.push(line);
      continue;
    }

    fs.mkdirSync(path.dirname(safe.full), { recursive: true });
    fs.writeFileSync(safe.full, content, "utf8");

    const marker = existed ? "*" : "+";
    const note = existed
      ? `${newBytes} bytes (was ${prevBytes})`
      : `${newBytes} bytes`;
    const line = `${marker} ${rel} (${note})`;
    appendLog(repoId, runId, `[${step.id}] ${line}`);
    results.push(line);
  }

  return [
    `Applied ${blocks.length} file block(s) to ${sessionPath}:`,
    ...results,
  ].join("\n") + "\n";
}

/**
 * Extracts unified-diff patches from rendered content. Recognises fenced blocks
 * tagged `diff` or `patch` (with or without a language tag). If no fenced blocks
 * are found but the input itself looks like a unified diff, returns it as a
 * single patch.
 */
export function parsePatchBlocks(text: string): string[] {
  const lines = text.split("\n");
  const openRe = /^\s*```(?:diff|patch)\b.*$/i;
  const closeRe = /^\s*```\s*$/;
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (openRe.test(lines[i])) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      if (buf.length > 0) blocks.push(buf.join("\n") + "\n");
      continue;
    }
    i++;
  }
  if (blocks.length === 0 && /^(?:diff --git |--- |\+\+\+ |@@ )/m.test(text)) {
    // Whole input looks like a raw patch; use it as one block.
    blocks.push(text.endsWith("\n") ? text : text + "\n");
  }
  return blocks;
}

/**
 * Runs `git apply` with the given args in `cwd`, returning stdout/stderr/exit code.
 */
function runGitApply(
  args: string[],
  cwd: string,
  stdin: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => stdout.push(d.toString()));
    proc.stderr.on("data", (d) => stderr.push(d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

/**
 * Apply unified-diff patches to the repo via `git apply`. Each fenced diff block
 * is applied independently so one bad hunk doesn't lose the others.
 */
export async function executePatchStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  sessionPath: string,
  runId: string,
  timeoutMs: number
): Promise<string> {
  const source = renderTemplate(step.content ?? "", ctx);
  const patches = parsePatchBlocks(source);
  const requireBlocks = step.requireBlocks !== false;

  appendLog(
    repoId,
    runId,
    `[${step.id}] Scanned ${source.length} chars; found ${patches.length} patch block(s)`
  );

  if (patches.length === 0) {
    const msg =
      "No patch blocks found. Expected fenced blocks like ```diff\\n--- a/foo\\n+++ b/foo\\n@@ ...\\n```";
    if (requireBlocks) throw new Error(msg);
    return `(${msg})\n`;
  }

  const forbiddenRe = /^(?:---|\+\+\+) [ab]\/(?:\.git\/|\.env(?:\.local)?|node_modules\/)/m;

  const results: string[] = [];
  let applied = 0;
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    const label = `#${i + 1}`;

    if (forbiddenRe.test(patch)) {
      const line = `SKIP ${label}: patch touches a forbidden path (.git, .env, node_modules)`;
      appendLog(repoId, runId, `[${step.id}] ${line}`);
      results.push(line);
      continue;
    }

    const tmp = path.join(os.tmpdir(), `archon-patch-${runId}-${i}.patch`);
    fs.writeFileSync(tmp, patch, "utf8");

    try {
      const baseArgs = [
        "apply",
        "--verbose",
        "--recount",
        "--whitespace=nowarn",
      ];
      if (step.stage) baseArgs.push("--index");
      baseArgs.push(tmp);

      const res = await runGitApply(baseArgs, sessionPath, "", timeoutMs);
      if (res.code === 0) {
        applied++;
        const verbose = (res.stderr || res.stdout).trim();
        const line = `applied ${label}${verbose ? `\n  ${verbose.split("\n").join("\n  ")}` : ""}`;
        appendLog(repoId, runId, `[${step.id}] applied patch ${label}`);
        results.push(line);
      } else {
        const err = (res.stderr || res.stdout).trim() || `exit code ${res.code}`;
        const line = `FAILED ${label} (exit ${res.code}):\n  ${err.split("\n").join("\n  ")}`;
        appendLog(repoId, runId, `[${step.id}] ${line}`);
        results.push(line);
      }
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  }

  const header = `Applied ${applied}/${patches.length} patch block(s) to ${sessionPath}${step.stage ? " (staged)" : ""}:`;
  const body = results.join("\n\n");
  const output = `${header}\n${body}\n`;

  if (applied === 0 && requireBlocks) {
    throw new Error(`No patches applied:\n${body}`);
  }
  return output;
}

/**
 * A single search/replace or create operation targeting one file.
 */
export interface EditOp {
  path: string;
  mode: "search-replace" | "create";
  search?: string; // present when mode === "search-replace"
  replace: string;
}

/**
 * Extracts search/replace edit blocks from LLM output. Each block has one of:
 *
 *   ```edit path=src/foo.js
 *   <<<<<<< SEARCH
 *   old text exactly as it appears on disk
 *   =======
 *   new text
 *   >>>>>>> REPLACE
 *   ```
 *
 * …for modifying existing files, or:
 *
 *   ```edit path=src/bar.js
 *   <<<<<<< CREATE
 *   full contents of the new file
 *   >>>>>>> REPLACE
 *   ```
 *
 * …for creating a new file. Multiple search/replace pairs may appear inside a
 * single fenced block (they are applied in order).
 */
export function parseEditBlocks(text: string): EditOp[] {
  const lines = text.split("\n");
  const openRe = /^\s*```edit\s+path=(.+?)\s*$/i;
  const closeRe = /^\s*```\s*$/;
  const ops: EditOp[] = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(openRe);
    if (!m) {
      i++;
      continue;
    }

    const relRaw = m[1].trim();
    // Strip wrapping backticks / quotes if the LLM added them.
    const rel = relRaw.replace(/^[`'"\s]+|[`'"\s]+$/g, "");
    i++;
    const buf: string[] = [];
    while (i < lines.length && !closeRe.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (i < lines.length) i++;

    const body = buf.join("\n");
    let pos = 0;
    while (pos < body.length) {
      const startSR = body.indexOf("<<<<<<< SEARCH", pos);
      const startCR = body.indexOf("<<<<<<< CREATE", pos);
      const useSR =
        startSR !== -1 && (startCR === -1 || startSR < startCR);
      const useCR =
        startCR !== -1 && (startSR === -1 || startCR < startSR);

      if (!useSR && !useCR) break;

      if (useSR) {
        const afterHeader = body.indexOf("\n", startSR);
        if (afterHeader === -1) break;
        const sepIdx = body.indexOf("\n=======", afterHeader);
        if (sepIdx === -1) break;
        const endIdx = body.indexOf("\n>>>>>>> REPLACE", sepIdx);
        if (endIdx === -1) break;
        const search = body.slice(afterHeader + 1, sepIdx);
        const replace = body.slice(sepIdx + "\n=======".length + 1, endIdx);
        ops.push({ path: rel, mode: "search-replace", search, replace });
        pos = endIdx + "\n>>>>>>> REPLACE".length;
      } else {
        const afterHeader = body.indexOf("\n", startCR);
        if (afterHeader === -1) break;
        const endIdx = body.indexOf("\n>>>>>>> REPLACE", afterHeader);
        if (endIdx === -1) break;
        const replace = body.slice(afterHeader + 1, endIdx);
        ops.push({ path: rel, mode: "create", replace });
        pos = endIdx + "\n>>>>>>> REPLACE".length;
      }
    }
  }

  return ops;
}

/**
 * Apply a series of search/replace (and create) edits produced by an LLM. Each
 * op is a literal string operation, so the LLM cannot accidentally delete
 * content it didn't explicitly target.
 */
export async function executeEditStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  sessionPath: string,
  runId: string
): Promise<string> {
  const source = renderTemplate(step.content ?? "", ctx);
  const ops = parseEditBlocks(source);
  const requireBlocks = step.requireBlocks !== false;

  appendLog(
    repoId,
    runId,
    `[${step.id}] Scanned ${source.length} chars; found ${ops.length} edit op(s)`
  );

  if (ops.length === 0) {
    const msg =
      'No edit blocks found. Expected fenced blocks like ```edit path=src/foo.js\\n<<<<<<< SEARCH\\n...\\n=======\\n...\\n>>>>>>> REPLACE\\n```';
    if (requireBlocks) throw new Error(msg);
    return `(${msg})\n`;
  }

  const results: string[] = [];
  let applied = 0;
  const fileCache = new Map<string, { content: string; existed: boolean }>();
  const dirtyFiles = new Set<string>();

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const label = `#${i + 1} ${op.path} (${op.mode})`;

    if (op.mode === "search-replace") {
      const needle = op.search ?? "";
      if (!needle) {
        const line = `FAIL ${label}: empty SEARCH block`;
        appendLog(repoId, runId, `[${step.id}] ${line}`);
        results.push(line);
        continue;
      }
    }

    const safe = resolveSafeRepoPath(sessionPath, op.path);
    if (!safe.ok) {
      const line = `SKIP ${label}: ${safe.reason}`;
      appendLog(repoId, runId, `[${step.id}] ${line}`);
      results.push(line);
      continue;
    }

    let cached = fileCache.get(safe.full);
    if (!cached) {
      if (fs.existsSync(safe.full)) {
        cached = { content: fs.readFileSync(safe.full, "utf8"), existed: true };
      } else {
        cached = { content: "", existed: false };
      }
      fileCache.set(safe.full, cached);
    }

    if (op.mode === "create") {
      if (cached.existed && cached.content.length > 0) {
        const line = `SKIP ${label}: file already exists and has content — use SEARCH/REPLACE instead of CREATE`;
        appendLog(repoId, runId, `[${step.id}] ${line}`);
        results.push(line);
        continue;
      }
      cached.content = op.replace.endsWith("\n")
        ? op.replace
        : op.replace + "\n";
      dirtyFiles.add(safe.full);
      const line = `apply ${label} (${Buffer.byteLength(cached.content, "utf8")} bytes)`;
      appendLog(repoId, runId, `[${step.id}] ${line}`);
      results.push(line);
      applied++;
      continue;
    }

    const needle = op.search!;

    const idx = cached.content.indexOf(needle);
    if (idx === -1) {
      const normalize = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\r\n/g, "\n");
      const normHay = normalize(cached.content);
      const normNeedle = normalize(needle);
      const normIdx = normHay.indexOf(normNeedle);
      if (normIdx === -1) {
        const preview = needle.split("\n").slice(0, 3).join(" / ");
        const line = `FAIL ${label}: SEARCH block not found in file. First lines: "${preview}"`;
        appendLog(repoId, runId, `[${step.id}] ${line}`);
        results.push(line);
        continue;
      }
      const line = `FAIL ${label}: SEARCH block only matches after whitespace normalisation; copy the exact bytes from the file and retry`;
      appendLog(repoId, runId, `[${step.id}] ${line}`);
      results.push(line);
      continue;
    }

    const nextIdx = cached.content.indexOf(needle, idx + 1);
    if (nextIdx !== -1) {
      const line = `FAIL ${label}: SEARCH block matches more than once — include more surrounding context so it is unique`;
      appendLog(repoId, runId, `[${step.id}] ${line}`);
      results.push(line);
      continue;
    }

    cached.content =
      cached.content.slice(0, idx) + op.replace + cached.content.slice(idx + needle.length);
    dirtyFiles.add(safe.full);
    const line = `apply ${label}`;
    appendLog(repoId, runId, `[${step.id}] ${line}`);
    results.push(line);
    applied++;
  }

  for (const [full, cached] of fileCache) {
    if (!dirtyFiles.has(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, cached.content, "utf8");
  }

  const header = `Applied ${applied}/${ops.length} edit op(s) across ${dirtyFiles.size} file(s) in ${sessionPath}:`;
  const body = results.join("\n");
  const output = `${header}\n${body}\n`;

  if (applied === 0 && requireBlocks) {
    throw new Error(`No edits applied:\n${body}`);
  }
  return output;
}

/**
 * Extract child workflow name + inputs from a step's JSON output or from
 * literal step properties (childWorkflow / inputs).
 */
function resolveChildWorkflow(
  step: WorkflowStep,
  ctx: TemplateContext
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
        // fall through to childWorkflow / inputsFrom
      }
    }
  }

  if (step.inputsFrom && step.inputsFrom !== step.workflowFrom) {
    const raw = ctx.steps[step.inputsFrom]?.output ?? "";
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
        // ignore parse failures
      }
    }
  }

  if (!workflowName && step.childWorkflow) {
    workflowName = renderTemplate(step.childWorkflow, ctx);
  }

  if (!workflowName && ctx.inputs.chosenWorkflow) {
    workflowName = ctx.inputs.chosenWorkflow;
  }

  if (!workflowName) {
    throw new Error(
      `[${step.id}] Could not determine child workflow name from workflowFrom, childWorkflow, or inputs.chosenWorkflow`
    );
  }

  return { workflowName, childInputs };
}

/**
 * Dispatch a child workflow. Runs it via `startRun`, polls until terminal,
 * and streams child logs into the parent log.
 */
export async function executeWorkflowStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repo: Repo,
  repoId: string,
  runId: string,
  config: ArchonConfig,
  startRunFn: (
    repo: Repo,
    workflow: Workflow,
    prompt: string,
    inputs: Record<string, string>,
    config: ArchonConfig
  ) => Promise<string>,
  getRunStateFn: (childRunId: string) => { status: string; steps: Array<{ id: string; status: string; output: string }> } | undefined
): Promise<string> {
  const { workflowName, childInputs } = resolveChildWorkflow(step, ctx);

  const childWorkflow = findWorkflow(repo, workflowName);
  if (!childWorkflow) {
    throw new Error(
      `[${step.id}] Child workflow "${workflowName}" not found in repo "${repo.id}"`
    );
  }

  const prompt = childInputs.requirement ?? ctx.inputs.requirement ?? "";
  const mergedInputs = { ...childInputs, requirement: prompt };

  appendLog(
    repoId,
    runId,
    `[${step.id}] Dispatching child workflow "${workflowName}" (repo: ${repo.id})`
  );

  const childRunId = await startRunFn(repo, childWorkflow, prompt, mergedInputs, config);
  appendLog(repoId, runId, `[${step.id}] Child run started: ${childRunId}`);

  const POLL_INTERVAL = 3000;
  const MAX_POLLS = Math.ceil((config.runner.timeout_ms * 2) / POLL_INTERVAL);

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const childState = getRunStateFn(childRunId);
    if (!childState) continue;
    if (childState.status === "success" || childState.status === "failed") {
      const stepSummaries = childState.steps
        .map((s) => `  ${s.id} [${s.status}]: ${(s.output || "").slice(0, 500)}`)
        .join("\n");

      const summary = [
        `Child workflow "${workflowName}" ${childState.status}.`,
        `Child run ID: ${childRunId}`,
        `Steps:`,
        stepSummaries,
      ].join("\n");

      appendLog(repoId, runId, `[${step.id}] ${summary.split("\n")[0]}`);
      return summary;
    }
  }

  throw new Error(
    `[${step.id}] Child workflow "${workflowName}" (run ${childRunId}) did not complete within timeout`
  );
}

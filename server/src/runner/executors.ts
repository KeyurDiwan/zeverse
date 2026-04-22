import { spawn } from "child_process";
import path from "path";
import type { LLMProvider } from "../llm";
import type { WorkflowStep } from "../workflows";
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
  repo: Repo,
  runId: string,
  timeoutMs: number
): Promise<string> {
  const command = renderTemplate(step.command ?? "", ctx);
  const cwd = step.cwd ? path.resolve(repo.path, step.cwd) : repo.path;

  appendLog(repo.id, runId, `[${step.id}] Running: ${command}`);
  appendLog(repo.id, runId, `[${step.id}] CWD: ${cwd}`);

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
      appendLog(repo.id, runId, msg);
      reject(new Error(msg));
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      for (const line of text.split("\n").filter(Boolean)) {
        appendLog(repo.id, runId, `[${step.id}] stdout: ${line}`);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      for (const line of text.split("\n").filter(Boolean)) {
        appendLog(repo.id, runId, `[${step.id}] stderr: ${line}`);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const output = chunks.join("");
      appendLog(repo.id, runId, `[${step.id}] Exited with code ${code}`);
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

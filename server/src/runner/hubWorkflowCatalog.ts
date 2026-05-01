import fs from "fs";
import path from "path";
import { getHubRoot } from "../config";

const MAX_CATALOG_CHARS = 48_000;
const MAX_PER_FILE = 16_000;

/**
 * Load hub `.zeverse/workflows/*.yaml` for injection into bootstrap rules prompts.
 */
export function loadHubWorkflowCatalogForPrompt(): string {
  const dir = path.join(getHubRoot(), ".zeverse", "workflows");
  if (!fs.existsSync(dir)) {
    return "(No `.zeverse/workflows` directory on hub — omit workflow-specific guidance.)\n";
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  if (files.length === 0) {
    return "(No workflow YAML files in hub `.zeverse/workflows`.)\n";
  }

  const chunks: string[] = [];
  let total = 0;

  for (const f of files) {
    const full = path.join(dir, f);
    let text: string;
    try {
      text = fs.readFileSync(full, "utf-8");
    } catch (e: any) {
      chunks.push(`## ${f}\n(Could not read: ${e.message})\n\n`);
      continue;
    }

    let body = text;
    if (body.length > MAX_PER_FILE) {
      body =
        body.slice(0, MAX_PER_FILE) +
        `\n\n… [truncated — file was ${text.length} chars; paths and inputs above are authoritative where present]\n`;
    }

    const piece = `## File: ${f}\n\n${body}\n\n`;
    if (total + piece.length > MAX_CATALOG_CHARS) {
      chunks.push(
        `## (remaining workflow files omitted — catalog size cap ${MAX_CATALOG_CHARS} chars)\n`
      );
      break;
    }
    chunks.push(piece);
    total += piece.length;
  }

  return chunks.join("");
}

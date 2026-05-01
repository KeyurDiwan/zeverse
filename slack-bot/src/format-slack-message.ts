/**
 * Normalize and optionally convert list bullets to numbered lines for Slack mrkdwn.
 * Repo-side workflow prompts (`.zeverse/workflows/*.yaml`) still control LLM tone;
 * these helpers unify spacing and list style in posted messages.
 */

export function normalizeSlackMrkdwn(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    out.push(line.replace(/\s+$/u, ""));
  }
  let s = out.join("\n");
  // Collapse 3+ consecutive newlines to double newlines
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * Turns top-level markdown/OEM bullet lines into numbered lines. Skips content
 * inside fenced ``` code blocks and lines that begin with whitespace (nested items).
 */
export function bulletsToNumberedLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let n = 0;

  const isBulletLine = (trimmed: string): boolean =>
    /^[-*]\s+/.test(trimmed) ||
    /^•\s+/.test(trimmed) ||
    /^[•∙]\s*/u.test(trimmed);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^```/)) {
      inFence = !inFence;
      n = 0;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const trimmed = line.trimStart();
    if (trimmed === "") {
      n = 0;
      out.push(line);
      continue;
    }

    const isIndented = /^\s/.test(line);

    if (!isIndented && isBulletLine(trimmed)) {
      n += 1;
      const body = trimmed.replace(/^[-*]\s+/, "").replace(/^[•∙]\s+/u, "");
      out.push(`${n}. ${body}`);
    } else {
      if (!isIndented) n = 0;
      out.push(line);
    }
  }

  return out.join("\n");
}

/**
 * Ensures a bold title, optional body, and optional trailing link line with consistent spacing.
 */
export function wrapWorkflowSummary(parts: {
  title: string;
  body: string;
  footer?: string;
}): string {
  const title = parts.title.startsWith("*") ? parts.title : `*${parts.title}*`;
  const chunks: string[] = [title];
  const body = parts.body.trim();
  if (body) chunks.push("", body);
  const footer = (parts.footer ?? "").trim();
  if (footer) {
    chunks.push("", footer);
  }
  return chunks.join("\n");
}

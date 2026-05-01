/** Default cap on rendered `llm` step user message (characters). */
export const DEFAULT_MAX_LLM_USER_CHARS = 200_000;

/** Read `ZEVERSE_MAX_LLM_USER_CHARS` with sane bounds (10k–2M). */
export function maxLlmUserCharsFromEnv(): number {
  const raw = process.env.ZEVERSE_MAX_LLM_USER_CHARS;
  if (raw == null || raw.trim() === "") return DEFAULT_MAX_LLM_USER_CHARS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_LLM_USER_CHARS;
  return Math.max(10_000, Math.min(n, 2_000_000));
}

/**
 * Shrinks an oversized prompt while keeping the beginning and end (e.g. Jest stderr
 * often ends with failure summaries).
 */
export function clampUserPromptForModel(
  prompt: string,
  maxChars: number
): { text: string; truncated: boolean; originalChars: number } {
  if (prompt.length <= maxChars) {
    return { text: prompt, truncated: false, originalChars: prompt.length };
  }
  const reserve = 320;
  const budget = maxChars - reserve;
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  const omitted = prompt.length - head - tail;
  const text =
    prompt.slice(0, head) +
    "\n\n--- [Zeverse] Truncated " +
    `${omitted.toLocaleString()} characters (model context limit). Showing first ` +
    `${head.toLocaleString()} and last ${tail.toLocaleString()} characters. ---\n\n` +
    prompt.slice(-tail);
  return { text, truncated: true, originalChars: prompt.length };
}

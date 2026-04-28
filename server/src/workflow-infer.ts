/**
 * Keyword-based workflow routing (shared contract for Slack + Hub UI).
 * Keep patterns ordered: more specific intents before broad URL / keyword matches.
 */
const WORKFLOW_KEYWORDS: [RegExp, string][] = [
  // British/American: analyse/analyze; must stay before bare Freshrelease URL rule.
  [/\b(analy[sz]e\s+fr|fr\s+analy[sz]e)\b/i, "fr-analyze"],
  [/\b(finish\s+fr|fix\s+fr|fr\s+fix)\b/i, "fr-task-finisher"],
  [/freshrelease\.com\/ws\/.*\/tasks\//i, "fr-task-finisher"],
  [/\b(create\s+epic|create\s+task|fr\s+card|card\s+creator)\b/i, "fr-card-creator"],
  [/\b(write\s+tests?|add\s+tests?|generate\s+tests?)\b/i, "test-write"],
  [/\b(raise\s+pr|open\s+pr|create\s+pr|submit\s+pr)\b/i, "pr-raise"],
  [/\bdebug\b/i, "debug"],
  [/\b(fix|bug|broken|crash|error)\b/i, "fix-bug"],
  [/\b(review|pr\b|pull\s*request|code\s+review)\b/i, "code-review"],
  [/\blint\b/i, "lint-fix"],
  [/\btest(?:s|ing)?\b/i, "test"],
  [/\b(explain|understand|walk\s*me\s*through|how\s*does)\b/i, "explain-codebase"],
  [/\b(upgrade|bump)\b/i, "upgrade-dep"],
  [/\bupdate\b.*\b(dep|dependency|package)\b/i, "upgrade-dep"],
  [/\bprd\b|docs\.google\.com\/document|atlassian\.net\/wiki\/|confluence\.|\/spaces\/[^/]+\/pages\//i, "prd-analysis"],
];

function resolveAlias(workflow: string, available: Set<string>): string | null {
  if (available.has(workflow)) return workflow;
  if (workflow === "code-review" && !available.has("code-review")) {
    if (available.has("pr-review")) return "pr-review";
    if (available.has("pr-review-remote")) return "pr-review-remote";
  }
  if (workflow === "pr-review" && available.has("pr-review-remote")) return "pr-review-remote";
  return null;
}

/**
 * First workflow name that matches a keyword and exists in the repo (after aliases), or null.
 * If a more specific pattern matches but that workflow is not in the repo, we stop — we do not
 * fall through to broader rules (e.g. URL → fr-task-finisher), which would override "analyze fr …".
 */
export function matchWorkflowKeyword(prompt: string, available: Set<string>): string | null {
  for (const [pattern, workflow] of WORKFLOW_KEYWORDS) {
    if (!pattern.test(prompt)) continue;
    const resolved = resolveAlias(workflow, available);
    if (resolved) return resolved;
    return null;
  }
  return null;
}

export function inferWorkflowFromPrompt(
  prompt: string,
  available: Set<string>,
  defaultWorkflow: string
): string {
  const matched = matchWorkflowKeyword(prompt, available);
  if (matched) return matched;
  if (available.has(defaultWorkflow)) return defaultWorkflow;
  const first = available.values().next().value;
  return first ?? defaultWorkflow;
}

import type { Workflow } from "../workflows";
import type { Repo } from "../repos";

const FINGERPRINT_SCRIPT = `
echo "## Directory structure (depth 3)"
find . -maxdepth 3 -type d \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/vendor/*' | sort | head -200

for f in package.json tsconfig.json pnpm-workspace.yaml lerna.json nx.json \
         requirements.txt pyproject.toml go.mod Cargo.toml Gemfile pom.xml build.gradle \
         Dockerfile docker-compose.yml docker-compose.yaml \
         .eslintrc.json .eslintrc.js .prettierrc .prettierrc.json \
         tailwind.config.js tailwind.config.ts postcss.config.js \
         vite.config.ts vite.config.js next.config.js next.config.mjs webpack.config.js \
         jest.config.js jest.config.ts vitest.config.ts vitest.config.js \
         .babelrc .env.example; do
  if [ -f "$f" ]; then
    echo ""
    echo "## $f"
    echo '---'
    head -c 2000 "$f"
    echo ""
    echo '---'
  fi
done

if [ -d ".github/workflows" ]; then
  echo ""
  echo "## .github/workflows/"
  ls .github/workflows/
fi

echo ""
echo "## Existing rules/skills"
for loc in .cursorrules .cursor/rules .zeverse/rules; do
  if [ -e "$loc" ]; then
    echo "Found: $loc (DO NOT overwrite)"
  fi
done
`.trim();

/**
 * Build an in-memory workflow that analyses a repo and drafts
 * `.zeverse/rules/*.md` files, then opens a PR via the standard
 * post-run commit/push/openPR path in the runner.
 */
export function buildBootstrapRulesWorkflow(repo: Repo): Workflow {
  return {
    name: "bootstrap-rules",
    description: "Analyse the codebase and generate .zeverse/rules/*.md files via PR",
    inputs: [],
    steps: [
      {
        id: "fingerprint",
        kind: "shell",
        command: FINGERPRINT_SCRIPT,
        continueOnError: true,
      },
      {
        id: "draft-rules",
        kind: "llm",
        prompt: `You are an expert developer-experience engineer.

You are given a fingerprint of the repository **${repo.name}** (origin: ${repo.origin}).
Your job is to produce a set of Markdown rule files that will live under \`.zeverse/rules/\` in the repository.
These rules are consumed by an AI coding assistant to understand the project conventions, tech stack, testing patterns, and domain.

Each rule file MUST be emitted as a fenced code block with a \`path=\` attribute, like:

\`\`\`path=.zeverse/rules/tech-stack.md
# Tech Stack
...
\`\`\`

The opening fence line must contain only the fence, an optional language tag, and \`path=...\` (or \`file=...\`); do not append extra words or comments on that same line.

Produce **one file per concern**. Suggested files (skip any that don't apply to this repo):
- \`tech-stack.md\` — languages, frameworks, runtimes, key dependencies, build & dev commands
- \`conventions.md\` — folder layout, naming conventions, import style, module pattern
- \`testing.md\` — test framework, file naming, location, how to run tests, coverage expectations
- \`styling.md\` — CSS approach (modules, Tailwind, styled-components, etc.), design tokens
- \`api-patterns.md\` — REST vs GraphQL, auth pattern, error handling conventions
- \`state-management.md\` — state library, store structure, data flow
- \`ci-cd.md\` — CI pipeline, deploy process, environment setup

Rules for writing good rule files:
1. Be specific and actionable — prefer "Use \`vitest\` with \`@testing-library/react\`" over "Use appropriate testing tools".
2. Include concrete examples, but use INDENTED CODE BLOCKS (4-space indent) or \`inline code\` for short snippets. **NEVER use triple-backtick fenced code blocks inside the file content** — this breaks the parser that extracts the files.
3. Reference actual paths from the fingerprint (e.g. "Tests live in \`src/__tests__/\`").
4. Keep each file 40-120 lines. Don't pad with filler.
5. Do NOT duplicate information that already exists in rules listed under "Existing rules" in the fingerprint.
6. The frontmatter is NOT required — just start with a Markdown heading.
7. For tables, use standard Markdown tables (pipes). For command examples, use \`inline code\` or 4-space indented blocks.

--- BEGIN REPO FINGERPRINT ---
{{steps.fingerprint.output}}
--- END REPO FINGERPRINT ---`,
      },
      {
        id: "apply-rules",
        kind: "apply",
        content: "{{steps.draft-rules.output}}",
        requireBlocks: true,
      },
      {
        id: "summary",
        kind: "llm",
        prompt: `Below is the output of a step that generated .zeverse/rules/*.md files for the repository **${repo.name}**.
Summarise what was generated in 2-4 sentences for use as a pull-request description body. Be concise. Do not use markdown headings.

{{steps.draft-rules.output}}`,
      },
    ],
    isolation: "branch",
    _filename: "(built-in)",
    _repoId: repo.id,
  };
}

---
name: Cursor-style index layer
overview: Add a Cursor-style local-indexed, vector-retrieval, and structured-context layer to Zeverse so workflows like fr-task-finisher and dev stop relying on grep-based discovery, while preserving the existing workflow/runner/Slack pipeline.
todos:
  - id: schema
    content: Add pgvector schema (repos, chunks, symbols), migration, and config/zeverse.yaml + .env.example entries
    status: completed
  - id: treesitter
    content: Implement tree-sitter chunker (server/src/index/treeSitter.ts) with TS/JS/Py/Go/MD grammars
    status: completed
  - id: merkle
    content: Implement Merkle tree (file/folder/root hashes) persisted under state/<repoId>/index/merkle.json
    status: completed
  - id: embed
    content: Implement embeddings client wrapping CloudVerse OpenAI SDK + local Xenova fallback
    status: completed
  - id: indexer
    content: "Implement indexer orchestrator: walk merkle diff, chunk, embed in batches of 64, upsert/prune"
    status: completed
  - id: watcher
    content: "Implement watcher: poll keepWorkspace repos and expose POST /api/repos/:id/reindex"
    status: completed
  - id: retrieve-step
    content: Add 'retrieve' step kind in executors.ts with hybrid ANN+BM25 search and import/caller expansion
    status: completed
  - id: feedback-loop
    content: Parse shell-step failures into structured tuples and feed them into the next retrieve in loopUntil iterations
    status: completed
  - id: rules-context
    content: Index .zeverse/rules/*.md as kind='rule' chunks so retrieval auto-attaches relevant rules
    status: completed
  - id: slack-event
    content: "Emit retrieve_finished NDJSON event and post 'Looking at: <files>' Slack milestone"
    status: completed
  - id: wire-fr-task-finisher
    content: Replace discover step in fr-task-finisher.yaml with retrieve, gated by config.index.enabled
    status: completed
  - id: eval-harness
    content: Add server/scripts/eval-retrieval.ts with a small gold-set per repo and CI hook
    status: completed
isProject: false
---

# Cursor-style code intelligence for Zeverse

## 1. Architecture (mapping the Cursor diagram onto Zeverse)

```mermaid
flowchart LR
    subgraph hub [Zeverse Server local machine in the diagram]
        repos[Persistent managed clones repos id] --> ts[Tree-sitter chunker]
        ts --> merkle[Merkle tree fileHash folderHash rootHash]
        merkle -->|incremental diff only| emb[Embedding worker]
        watcher[git pull webhook fs watcher] --> merkle
    end

    subgraph store [Postgres pgvector shared cloud-like store]
        pg[(chunks table embedding tsvector symbols)]
        symbols[(symbols table imports callers definitions)]
    end

    emb -->|encrypted-at-rest vectors| pg

    subgraph query [Query Processing new]
        q[User prompt] --> qe[Query embedding plus keyword tokens]
        qe --> hybrid[Hybrid ANN plus BM25 search]
        hybrid --> expand[Expand by imports plus callers from symbol graph]
        expand --> pack[Context packer token budget aware]
    end

    pg --> hybrid
    symbols --> expand
    pack --> llm[LLM Composer Code Generation]

    subgraph loop [Execution Loop existing tightened]
        llm --> diff[SEARCH REPLACE diff generator]
        diff --> apply[apply executor]
        apply --> verify[shell tests lint]
        verify -->|fail structured error| qe
    end
```

The four boxes from the screenshot map to:
- **Local Machine** -> Zeverse server (managed clones under `repos/<id>/`).
- **Cloud Services** -> Postgres + pgvector.
- **Query Processing** -> new `retrieve` step kind + helpers, callable from any workflow via `{{steps.retrieve.output}}`.
- **Execution Loop** -> existing `retries` / `loopUntil` / `apply-edits-check` / `implement-retry` (already in [executors.ts](server/src/runner/executors.ts) and `fr-task-finisher.yaml`), extended to feed structured failures back into retrieval.

## 2. New top-level pieces (server)

All new code lives in `server/src/index/` and surfaces to workflows via one new step kind.

- `server/src/index/treeSitter.ts` - chunk source files into functions / classes / blocks using `web-tree-sitter` (WASM grammars per language: ts, tsx, js, jsx, py, go, java, rb, md). One chunk = one symbol or a 40-line sliding window, capped at 2-3k tokens.
- `server/src/index/merkle.ts` - per-file SHA256, folder hash = hash of sorted child hashes, root hash per repo. Persisted at `state/<repoId>/index/merkle.json`. Drives "only re-embed what changed" (the incremental arrow in the diagram).
- `server/src/index/embed.ts` - thin wrapper over the existing OpenAI-compatible CloudVerse client (it already uses `new OpenAI({ baseURL, apiKey })` in [cloudverse.ts](server/src/llm/cloudverse.ts)) calling `client.embeddings.create` with a configurable model. Local fallback via `@xenova/transformers` (all-MiniLM-L6-v2) gated on `ZEVERSE_EMBEDDING_PROVIDER=local` for offline dev / sandbox tests.
- `server/src/index/db.ts` - pgvector schema + queries.
- `server/src/index/symbols.ts` - tree-sitter queries to extract imports and exported symbols, then build a per-repo edge list `{from_chunk, to_symbol, kind: 'import'|'call'|'definition'}`.
- `server/src/index/indexer.ts` - orchestrator: walk merkle diff, chunk new/changed files, embed in batches of 64, upsert chunks + symbols, prune deleted file rows.
- `server/src/index/watcher.ts` - two triggers:
  - `git fetch && git diff` poll every N minutes for repos with `keepWorkspace: true`.
  - HTTP `POST /api/repos/:id/reindex` for manual / GitHub-webhook triggered reindex.
- `server/src/index/retrieve.ts` - hybrid search (cosine over `embedding` + `ts_rank` over `tsvector`), then symbol-graph BFS to pull importers/callers up to depth 1, then `pack(budgetChars)` greedily fills the prompt.

### pgvector schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  root_hash TEXT NOT NULL,
  last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
  id BIGSERIAL PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  symbol TEXT,
  kind TEXT,
  start_line INT NOT NULL,
  end_line INT NOT NULL,
  language TEXT,
  content TEXT NOT NULL,
  embedding vector(1536),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON chunks USING gin (fts);
CREATE INDEX ON chunks (repo_id, file_path);

CREATE TABLE symbols (
  id BIGSERIAL PRIMARY KEY,
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  chunk_id BIGINT REFERENCES chunks(id) ON DELETE CASCADE,
  kind TEXT  -- 'definition' | 'export' | 'import'
);
CREATE INDEX ON symbols (repo_id, name);
```

## 3. New workflow primitive

Add a `retrieve` step kind alongside the existing ones in [executors.ts](server/src/runner/executors.ts):

```yaml
- id: ctx
  kind: retrieve
  query: "{{inputs.requirement}}"
  topK: 12
  expand: imports+callers   # optional; default 'imports'
  maxChars: 80000           # bound the rendered context
  filter:                   # optional
    pathGlob: "src/**/*.{ts,tsx}"
    languages: ["ts", "tsx"]
```

Output is a deterministic, fenced markdown block:

````
```retrieved
file=src/billing/Invoice.tsx lines=12-78 score=0.81
<code>
---
file=src/billing/api.ts lines=4-44 score=0.74
<code>
```
````

Existing `fr-task-finisher`/`dev`/`fix-bug` workflows replace their grep-based `discover` step with `retrieve`. The `bootstrap-rules` workflow keeps its current shell fingerprint (it runs once per repo and is cheap).

## 4. Tightening the execution loop (the bottom-left box in the diagram)

The diagram's "retry with error context" arrow is currently informal in Zeverse. Make it structured:

- After a failed `shell` step (tests/lint), parse stderr into `{file, line, message}` tuples in [executors.ts](server/src/runner/executors.ts) (extend the existing `apply-edits-check` style block).
- Feed those tuples back into `retrieve` (`query` becomes the failure messages, `filter.pathGlob` becomes the failing files), so the next iteration of `loopUntil` retrieves the **right** code, not the original broad query.
- Cache `(rootHash, query)` -> retrieved chunk ids in `state/<repoId>/index/cache/` so retries within one `loopUntil` are free.

## 5. Power-ups beyond the Cursor diagram (suggestions)

1. **Hybrid search out of the box** - Cursor's diagram shows only vector ANN. Adding `tsvector` BM25 (free with Postgres) makes exact-symbol queries (e.g. "fix `parseInvoice`") much more precise.
2. **Symbol graph expansion, not just text** - the diagram says "Code + imports + callers" but offers no scheme. Persist a real symbol graph (`symbols` table) and BFS it; this is what makes "show me what calls `parseInvoice`" reliable.
3. **Rules-as-context** - also embed each repo's `.zeverse/rules/*.md` into the same `chunks` table with `kind='rule'`. Every workflow run automatically retrieves the relevant rules for the prompt instead of stuffing them all in.
4. **Recency boost** - join `git log -- <path>` churn into the score (`score = cosine + 0.1*log(recencyDays)`) so freshly-edited files surface first.
5. **Plan cache** - hash `(repo rootHash, system prompt, user prompt)` -> `state/<repoId>/index/plans/` so identical questions in Slack don't re-burn LLM tokens.
6. **Eval harness** - `server/scripts/eval-retrieval.ts` with a tiny gold set per repo (~20 questions -> expected files). Run in CI to catch retrieval regressions when we tweak chunking or weights.
7. **Speculative validation** - while the LLM is generating edits, kick off `npm run lint` against a clean clone in a separate process so the verify step is near-zero latency on success.
8. **Slack-first observability** - emit a `retrieve_finished` NDJSON event with the top-K file list so the Slack milestone poller can post "Looking at: src/billing/Invoice.tsx, src/billing/api.ts ..." in the thread before the LLM step starts.
9. **Privacy posture** - even though pgvector is your own DB, add a `.zeverseignore` (gitignore syntax) read by [indexer.ts](server/src/index/indexer.ts) so secrets/binary/test-fixture dirs are excluded; mirrors Cursor's `node_modules, .git, builds` exclusion in the diagram.

## 6. Rollout

- **Phase 1 (1-2 days)**: Postgres + pgvector schema, `treeSitter.ts`, `embed.ts`, `indexer.ts`, manual `POST /api/repos/:id/reindex`. No workflow changes yet. Verified by `npm run check:retrieve` smoke script.
- **Phase 2 (1 day)**: `merkle.ts` + incremental updates + watcher polling for `keepWorkspace: true` repos.
- **Phase 3 (1 day)**: `retrieve` step kind in [executors.ts](server/src/runner/executors.ts), wire into `fr-task-finisher.yaml` (replace `discover`) behind an `index.enabled: true` flag in `config/zeverse.yaml` so legacy grep stays as fallback.
- **Phase 4 (1 day)**: Symbol graph expansion + rules-as-context + structured failure -> retrieval feedback in `loopUntil`.
- **Phase 5 (0.5 day)**: Eval harness + Slack `retrieve_finished` milestone + plan cache.

## 7. Config additions

`config/zeverse.yaml`:

```yaml
index:
  enabled: true
  postgres_url: ${POSTGRES_URL}
  embedding:
    provider: cloudverse        # | local
    model: text-embedding-3-small
    dim: 1536
  chunking:
    max_lines: 80
    max_tokens: 2500
  retrieval:
    top_k: 12
    expand: imports+callers
    max_chars: 80000
    hybrid_weights:
      vector: 0.7
      bm25: 0.3
  watcher:
    poll_seconds: 300
    on_repo_add: true
```

`.env.example` adds `POSTGRES_URL=postgres://zeverse:zeverse@localhost:5432/zeverse` and `ZEVERSE_EMBEDDING_PROVIDER=cloudverse`.

## 8. What stays the same

- Workflow YAML model, runner state machine, Slack harness, policy, audit log, ephemeral-clone PR flow - all untouched.
- `bootstrap-rules`, `prd-analysis`, `gdoc-*` and `fr-*` integrations - untouched (they don't need code retrieval).
- Existing `fr-task-finisher` SEARCH/REPLACE contract - untouched; only its `discover` step is upgraded.

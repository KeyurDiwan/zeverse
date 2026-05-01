import pg from "pg";
import type { IndexConfig } from "../config";

let pools = new Map<string, pg.Pool>();

/** Validates embedding dimension for SQL interpolation only (avoid injection). */
export function sanitizeEmbeddingDim(d: number): number {
  if (!Number.isInteger(d) || d < 32 || d > 8192) {
    throw new Error(`Invalid embedding dimension: ${d} (expected 32–8192)`);
  }
  return d;
}

export function getPool(postgresUrl: string): pg.Pool {
  if (!postgresUrl?.trim()) {
    throw new Error("PostgreSQL URL is empty — set POSTGRES_URL / index.postgres_url");
  }
  let p = pools.get(postgresUrl);
  if (!p) {
    p = new pg.Pool({ connectionString: postgresUrl, max: 10 });
    pools.set(postgresUrl, p);
  }
  return p;
}

export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools = new Map();
}

/** Creates pgvector schema if missing (idempotent). */
export async function ensureSchema(pool: pg.Pool, embeddingDim: number): Promise<void> {
  const dim = sanitizeEmbeddingDim(embeddingDim);
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zeverse_repos (
      id TEXT PRIMARY KEY,
      root_hash TEXT NOT NULL DEFAULT '',
      last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zeverse_chunks (
      id BIGSERIAL PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES zeverse_repos(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      symbol TEXT,
      kind TEXT,
      start_line INT NOT NULL,
      end_line INT NOT NULL,
      language TEXT,
      content TEXT NOT NULL,
      embedding vector(${dim}),
      fts tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
    )`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS zeverse_chunks_embedding_hnsw
    ON zeverse_chunks USING hnsw (embedding vector_cosine_ops)`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS zeverse_chunks_fts_gin
    ON zeverse_chunks USING gin (fts)`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS zeverse_chunks_repo_file
    ON zeverse_chunks (repo_id, file_path)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zeverse_symbols (
      id BIGSERIAL PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES zeverse_repos(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_id BIGINT NOT NULL REFERENCES zeverse_chunks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL
    )`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS zeverse_symbols_repo_name
    ON zeverse_symbols (repo_id, name)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zeverse_symbol_edges (
      id BIGSERIAL PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES zeverse_repos(id) ON DELETE CASCADE,
      from_chunk_id BIGINT NOT NULL REFERENCES zeverse_chunks(id) ON DELETE CASCADE,
      to_symbol TEXT NOT NULL,
      edge_kind TEXT NOT NULL
    )`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS zeverse_symbol_edges_repo_sym
    ON zeverse_symbol_edges (repo_id, to_symbol)`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS zeverse_symbol_edges_from
    ON zeverse_symbol_edges (repo_id, from_chunk_id)`);
}

export async function upsertRepoRow(pool: pg.Pool, repoId: string, rootHash: string): Promise<void> {
  await pool.query(
    `INSERT INTO zeverse_repos (id, root_hash, last_indexed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET root_hash = EXCLUDED.root_hash, last_indexed_at = now()`,
    [repoId, rootHash]
  );
}

export async function deleteChunksForFile(
  pool: pg.Pool,
  repoId: string,
  filePath: string
): Promise<void> {
  await pool.query(`DELETE FROM zeverse_chunks WHERE repo_id = $1 AND file_path = $2`, [
    repoId,
    filePath,
  ]);
}

export async function deleteChunksForRepo(pool: pg.Pool, repoId: string): Promise<void> {
  await pool.query(`DELETE FROM zeverse_chunks WHERE repo_id = $1`, [repoId]);
}

/** Insert chunks + symbols + edges in one transaction. Chunk IDs assigned by DB. */
export async function insertChunkBatch(
  pool: pg.Pool,
  repoId: string,
  rows: Array<{
    file_path: string;
    file_hash: string;
    symbol: string | null;
    kind: string | null;
    start_line: number;
    end_line: number;
    language: string | null;
    content: string;
    embedding: number[];
    symbols: Array<{ name: string; kind: string }>;
    edges: Array<{ to_symbol: string; edge_kind: string }>;
  }>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const embLit = `[${row.embedding.map((n) => Number(n.toFixed(8))).join(",")}]`;
      const ins = await client.query(
        `INSERT INTO zeverse_chunks (
          repo_id, file_path, file_hash, symbol, kind, start_line, end_line, language, content, embedding
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector)
        RETURNING id`,
        [
          repoId,
          row.file_path,
          row.file_hash,
          row.symbol,
          row.kind,
          row.start_line,
          row.end_line,
          row.language,
          row.content,
          embLit,
        ]
      );
      const chunkId = ins.rows[0].id as number;
      for (const s of row.symbols) {
        await client.query(
          `INSERT INTO zeverse_symbols (repo_id, name, file_path, chunk_id, kind)
           VALUES ($1,$2,$3,$4,$5)`,
          [repoId, s.name, row.file_path, chunkId, s.kind]
        );
      }
      for (const e of row.edges) {
        await client.query(
          `INSERT INTO zeverse_symbol_edges (repo_id, from_chunk_id, to_symbol, edge_kind)
           VALUES ($1,$2,$3,$4)`,
          [repoId, chunkId, e.to_symbol, e.edge_kind]
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface ChunkHit {
  id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  symbol: string | null;
  kind: string | null;
  language: string | null;
  content: string;
  score: number;
}

export async function hybridSearch(
  pool: pg.Pool,
  repoId: string,
  opts: {
    queryEmbedding: number[];
    ftsQuery: string;
    topK: number;
    wVector: number;
    wBm25: number;
  }
): Promise<ChunkHit[]> {
  const embLit = `[${opts.queryEmbedding.map((n) => Number(n.toFixed(8))).join(",")}]`;
  const k = Math.max(4, opts.topK * 4);

  const vecRes = await pool.query(
    `
    SELECT id, file_path, start_line, end_line, symbol, kind, language, content,
           (1 - (embedding <=> $1::vector)) AS vscore
    FROM zeverse_chunks
    WHERE repo_id = $2 AND embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $3
    `,
    [embLit, repoId, k]
  );

  const ftsRes =
    opts.ftsQuery.trim().length > 0
      ? await pool.query(
          `
    SELECT id, file_path, start_line, end_line, symbol, kind, language, content,
           ts_rank_cd(fts, plainto_tsquery('english', $2)) AS fscore
    FROM zeverse_chunks
    WHERE repo_id = $1 AND fts @@ plainto_tsquery('english', $2)
    ORDER BY fscore DESC
    LIMIT $3
    `,
          [repoId, opts.ftsQuery.slice(0, 800), k]
        )
      : { rows: [] as any[] };

  const byId = new Map<number, { row: any; vscore: number; fscore: number }>();

  for (const row of vecRes.rows) {
    byId.set(Number(row.id), { row, vscore: Number(row.vscore) || 0, fscore: 0 });
  }
  for (const row of ftsRes.rows) {
    const id = Number(row.id);
    const fscore = Number(row.fscore) || 0;
    const cur = byId.get(id);
    if (cur) cur.fscore = Math.max(cur.fscore, fscore);
    else byId.set(id, { row, vscore: 0, fscore });
  }

  let maxF = 0;
  for (const v of byId.values()) maxF = Math.max(maxF, v.fscore);
  const normF = (f: number) => (maxF > 0 ? Math.min(1, f / maxF) : 0);

  const ranked = [...byId.values()].map(({ row, vscore, fscore }) => {
    const combined =
      opts.wVector * vscore + opts.wBm25 * normF(fscore);
    return {
      id: Number(row.id),
      file_path: row.file_path as string,
      start_line: Number(row.start_line),
      end_line: Number(row.end_line),
      symbol: row.symbol as string | null,
      kind: row.kind as string | null,
      language: row.language as string | null,
      content: row.content as string,
      score: combined,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, opts.topK);
}

export async function fetchChunksByIds(
  pool: pg.Pool,
  repoId: string,
  ids: number[]
): Promise<Map<number, ChunkHit>> {
  if (ids.length === 0) return new Map();
  const res = await pool.query(
    `
    SELECT id, file_path, start_line, end_line, symbol, kind, language, content
    FROM zeverse_chunks WHERE repo_id = $1 AND id = ANY($2::bigint[])
    `,
    [repoId, ids]
  );
  const m = new Map<number, ChunkHit>();
  for (const row of res.rows) {
    m.set(Number(row.id), {
      id: Number(row.id),
      file_path: row.file_path,
      start_line: Number(row.start_line),
      end_line: Number(row.end_line),
      symbol: row.symbol,
      kind: row.kind,
      language: row.language,
      content: row.content,
      score: 0,
    });
  }
  return m;
}

/** Find chunks that reference definition names via call edges (callers of symbols defined in hit chunks). */
export async function expandCallers(
  pool: pg.Pool,
  repoId: string,
  definitionNames: string[],
  excludeChunkIds: Set<number>,
  limit: number
): Promise<number[]> {
  if (definitionNames.length === 0 || limit <= 0) return [];
  const res = await pool.query(
    `
    SELECT DISTINCT from_chunk_id AS id
    FROM zeverse_symbol_edges
    WHERE repo_id = $1
      AND edge_kind = 'call'
      AND to_symbol = ANY($2::text[])
      AND NOT (from_chunk_id = ANY($3::bigint[]))
    LIMIT $4
    `,
    [repoId, definitionNames, [...excludeChunkIds], limit]
  );
  return res.rows.map((r) => Number(r.id));
}

/** Module paths imported by chunks (for naive expansion: pull chunks from resolved paths when possible). */
export async function expandImportedModules(
  pool: pg.Pool,
  repoId: string,
  fromChunkIds: number[],
  limit: number
): Promise<number[]> {
  if (fromChunkIds.length === 0 || limit <= 0) return [];
  const res = await pool.query(
    `
    SELECT DISTINCT ON (c.file_path) c.id
    FROM zeverse_symbol_edges e
    JOIN zeverse_chunks c ON c.repo_id = e.repo_id AND c.file_path = e.to_symbol
    WHERE e.repo_id = $1
      AND e.edge_kind = 'imports_module'
      AND e.from_chunk_id = ANY($2::bigint[])
    ORDER BY c.file_path, c.start_line ASC
    LIMIT $3
    `,
    [repoId, fromChunkIds, limit]
  );
  return res.rows.map((r) => Number(r.id));
}

export function indexConfigDim(cfg: IndexConfig): number {
  return cfg.embedding.dim;
}

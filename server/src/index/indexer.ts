import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { minimatch } from "minimatch";
import type { IndexConfig, ZeverseConfig } from "../config";
import { resolveHubPath } from "../config";
import type { Repo } from "../repos";
import {
  deleteChunksForFile,
  ensureSchema,
  expandCallers,
  expandImportedModules,
  fetchChunksByIds,
  hybridSearch,
  indexConfigDim,
  insertChunkBatch,
  upsertRepoRow,
  getPool,
} from "./db";
import { embedTexts } from "./embed";
import {
  computeMerkleTree,
  diffMerkleFiles,
  loadMerkle,
  saveMerkle,
} from "./merkle";
import { extractChunks } from "./treeSitter";

const EMBED_BATCH = 32;
const MAX_CHUNK_CHARS = 12000;

export interface IndexRepoResult {
  repoId: string;
  rootHash: string;
  filesIndexed: number;
  filesRemoved: number;
}

export function managedRepoRoot(config: ZeverseConfig, repoId: string): string {
  return path.join(resolveHubPath(config.paths.clone_dir), repoId);
}

/** Ensure `repos/<id>/` exists and tracks origin default branch (for indexing). */
export function ensureManagedClone(hubConfig: ZeverseConfig, repo: Repo): void {
  const workDir = managedRepoRoot(hubConfig, repo.id);
  const gitDir = path.join(workDir, ".git");

  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(workDir, { recursive: true });
    const res = spawnSync("git", ["clone", repo.origin, workDir], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 600_000,
    });
    if (res.status !== 0) {
      throw new Error(`git clone failed for ${repo.id}: ${res.stderr}`);
    }
  }

  const fetch = spawnSync("git", ["fetch", "origin", "--prune"], {
    cwd: workDir,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (fetch.status !== 0) {
    throw new Error(`git fetch failed for ${repo.id}: ${fetch.stderr}`);
  }

  const reset = spawnSync(
    "git",
    ["reset", "--hard", `origin/${repo.defaultBranch}`],
    { cwd: workDir, encoding: "utf8", timeout: 120_000 }
  );
  if (reset.status !== 0) {
    const co = spawnSync("git", ["checkout", "-B", repo.defaultBranch, `origin/${repo.defaultBranch}`], {
      cwd: workDir,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (co.status !== 0) {
      throw new Error(`git reset/checkout failed for ${repo.id}: ${reset.stderr || co.stderr}`);
    }
  }

  spawnSync("git", ["clean", "-fd"], { cwd: workDir, encoding: "utf8" });
}

export async function indexRepo(options: {
  hubConfig: ZeverseConfig;
  indexConfig: IndexConfig;
  repo: Repo;
  /** Full re-index (ignore merkle diff cache). */
  full?: boolean;
}): Promise<IndexRepoResult> {
  const { hubConfig, indexConfig, repo, full } = options;
  const repoId = repo.id;

  ensureManagedClone(hubConfig, repo);

  const repoRoot = managedRepoRoot(hubConfig, repoId);
  const pool = getPool(indexConfig.postgres_url);
  await ensureSchema(pool, indexConfigDim(indexConfig));

  const nextMerkle = computeMerkleTree(repoRoot);
  const prev = full ? null : loadMerkle(repoId, hubConfig.paths.state_dir);
  const { addedOrChanged, removed } = full
    ? { addedOrChanged: Object.keys(nextMerkle.files), removed: [] as string[] }
    : diffMerkleFiles(prev, nextMerkle);

  for (const rel of removed) {
    await deleteChunksForFile(pool, repoId, rel);
  }

  let filesIndexed = 0;
  for (const rel of addedOrChanged) {
    const abs = path.join(repoRoot, ...rel.split("/"));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;

    await deleteChunksForFile(pool, repoId, rel);
    const source = fs.readFileSync(abs, "utf8");
    const chunks = extractChunks(repoRoot, rel, source, indexConfig.chunking.max_lines);

    const hash = nextMerkle.files[rel];
    if (!hash) continue;

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const slice = chunks.slice(i, i + EMBED_BATCH);
      const texts = slice.map((c) => c.content.slice(0, MAX_CHUNK_CHARS));
      const embeddings = await embedTexts(hubConfig, indexConfig, texts);

      const rows = slice.map((ch, j) => ({
        file_path: rel,
        file_hash: hash,
        symbol: ch.symbol,
        kind:
          rel.startsWith(".zeverse/rules/") && rel.endsWith(".md")
            ? "rule"
            : ch.kind,
        start_line: ch.startLine,
        end_line: ch.endLine,
        language: ch.language,
        content: ch.content.slice(0, MAX_CHUNK_CHARS),
        embedding: embeddings[j]!,
        symbols: ch.symbols,
        edges: [
          ...ch.importPaths.map((p) => ({
            to_symbol: p,
            edge_kind: "imports_module" as const,
          })),
          ...ch.calls.map((c) => ({
            to_symbol: c,
            edge_kind: "call" as const,
          })),
        ],
      }));

      await insertChunkBatch(pool, repoId, rows);
    }
    filesIndexed++;
  }

  await upsertRepoRow(pool, repoId, nextMerkle.rootHash);
  saveMerkle(repoId, hubConfig.paths.state_dir, nextMerkle);

  return {
    repoId,
    rootHash: nextMerkle.rootHash,
    filesIndexed,
    filesRemoved: removed.length,
  };
}

export function retrieveCachePath(
  stateDir: string,
  repoId: string,
  key: string
): string {
  const dir = path.join(resolveHubPath(stateDir), repoId, "index", "cache");
  fs.mkdirSync(dir, { recursive: true });
  const safe = crypto.createHash("sha256").update(key).digest("hex").slice(0, 48);
  return path.join(dir, `${safe}.json`);
}

export interface RetrieveOpts {
  repoId: string;
  query: string;
  topK: number;
  expand: string;
  maxChars: number;
  pathGlob?: string;
  languages?: string[];
  hybridVectorWeight: number;
  hybridBm25Weight: number;
}

export interface RetrievePackResult {
  text: string;
  chunkIds: number[];
  files: string[];
}

export async function retrieveAndPack(options: {
  pool: ReturnType<typeof getPool>;
  hubConfig: ZeverseConfig;
  indexConfig: IndexConfig;
  repoRoot: string;
  stateDir: string;
  rootHash: string;
  opts: RetrieveOpts;
}): Promise<RetrievePackResult> {
  const { pool, hubConfig, indexConfig, stateDir, rootHash, opts } = options;

  const fullQuery = opts.query;

  const cacheKey = JSON.stringify({
    h: rootHash,
    q: fullQuery,
    k: opts.topK,
    g: opts.pathGlob ?? "",
    langs: opts.languages ?? [],
    ex: opts.expand,
  });
  const cacheFile = retrieveCachePath(stateDir, opts.repoId, cacheKey);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as {
        chunkIds: number[];
      };
      const hitsMap = await fetchChunksByIds(pool, opts.repoId, cached.chunkIds);
      const hits = cached.chunkIds
        .map((id) => hitsMap.get(id))
        .filter(Boolean) as import("./db").ChunkHit[];
      return packRetrievedChunks(hits, opts.maxChars);
    } catch {
      /* refresh */
    }
  }

  const [qEmb] = await embedTexts(hubConfig, indexConfig, [fullQuery.slice(0, 8000)]);
  let hits = await hybridSearch(pool, opts.repoId, {
    queryEmbedding: qEmb,
    ftsQuery: fullQuery.slice(0, 2000),
    topK: opts.topK,
    wVector: opts.hybridVectorWeight,
    wBm25: opts.hybridBm25Weight,
  });

  hits = filterHits(hits, opts.pathGlob, opts.languages);

  const hitIds = new Set(hits.map((h) => h.id));
  const expandImports = opts.expand.includes("import");
  const expandCall = opts.expand.includes("caller");

  if (expandImports) {
    const more = await expandImportedModules(pool, opts.repoId, [...hitIds], opts.topK);
    const map = await fetchChunksByIds(pool, opts.repoId, more);
    for (const id of more) {
      const row = map.get(id);
      if (row && !hitIds.has(id)) {
        hitIds.add(id);
        hits.push({ ...row, score: 0.05 });
      }
    }
  }

  if (expandCall) {
    const defNames = new Set<string>();
    for (const h of hits) {
      if (h.symbol) defNames.add(h.symbol);
    }
    const more = await expandCallers(pool, opts.repoId, [...defNames], hitIds, opts.topK);
    const map = await fetchChunksByIds(pool, opts.repoId, more);
    for (const id of more) {
      const row = map.get(id);
      if (row && !hitIds.has(id)) {
        hitIds.add(id);
        hits.push({ ...row, score: 0.04 });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  hits = dedupeKeepOrder(hits).slice(0, opts.topK * 3);

  const packed = packRetrievedChunks(hits, opts.maxChars);
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ chunkIds: packed.chunkIds }));
  } catch {
    /* ignore */
  }
  return packed;
}

function dedupeKeepOrder(hits: import("./db").ChunkHit[]): import("./db").ChunkHit[] {
  const seen = new Set<number>();
  const out: import("./db").ChunkHit[] = [];
  for (const h of hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
  }
  return out;
}

function filterHits(
  hits: import("./db").ChunkHit[],
  pathGlob?: string,
  languages?: string[]
): import("./db").ChunkHit[] {
  let h = hits;
  if (pathGlob?.trim()) {
    h = h.filter((x) => minimatch(x.file_path, pathGlob, { dot: true }));
  }
  if (languages && languages.length > 0) {
    const set = new Set(languages.map((s) => s.toLowerCase()));
    h = h.filter((x) => !x.language || set.has(x.language.toLowerCase()));
  }
  return h.length ? h : hits;
}

function packRetrievedChunks(
  hits: import("./db").ChunkHit[],
  maxChars: number
): RetrievePackResult {
  const lines: string[] = ["```retrieved"];
  let used = lines.join("\n").length + 10;
  const chunkIds: number[] = [];
  const files = new Set<string>();

  for (const h of hits) {
    const header = `file=${h.file_path} lines=${h.start_line}-${h.end_line} score=${h.score.toFixed(3)}${h.symbol ? ` symbol=${h.symbol}` : ""}`;
    const block = `${header}\n${h.content}\n---`;
    if (used + block.length > maxChars) break;
    lines.push(block);
    used += block.length;
    chunkIds.push(h.id);
    files.add(h.file_path);
  }
  lines.push("```");
  return {
    text: lines.join("\n"),
    chunkIds,
    files: [...files].slice(0, 40),
  };
}

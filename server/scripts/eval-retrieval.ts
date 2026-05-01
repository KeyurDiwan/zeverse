/**
 * Lightweight retrieval eval against indexed chunks (hybrid search).
 *
 * Usage:
 *   POSTGRES_URL=postgres://zeverse:zeverse@localhost:5432/zeverse \
 *   ZEVERSE_EMBEDDING_PROVIDER=local \
 *   npx ts-node --transpile-only server/scripts/eval-retrieval.ts path/to/gold.json
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { loadConfig, getHubRoot } from "../src/config";
import { getPool, ensureSchema, hybridSearch, indexConfigDim } from "../src/index/db";
import { embedTexts } from "../src/index/embed";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

interface Case {
  query: string;
  expectPathSubstringAnyOf?: string[];
}

interface GoldFile {
  repoId: string;
  cases: Case[];
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ix = cfg.index;
  if (!ix?.enabled || !ix.postgres_url?.trim()) {
    console.error("index.enabled and postgres_url required in config/zeverse.yaml");
    process.exit(1);
  }

  const goldPath =
    process.argv[2] ||
    path.join(getHubRoot(), "config", "eval-retrieval-gold.json");

  if (!fs.existsSync(goldPath)) {
    console.error(`Gold file missing: ${goldPath}`);
    console.error("Copy config/eval-retrieval-gold.example.json to config/eval-retrieval-gold.json and customize.");
    process.exit(1);
  }

  const gold = JSON.parse(fs.readFileSync(goldPath, "utf8")) as GoldFile;
  const pool = getPool(ix.postgres_url);
  await ensureSchema(pool, indexConfigDim(ix));

  let passed = 0;
  let failed = 0;

  for (const c of gold.cases) {
    const [emb] = await embedTexts(cfg, ix, [c.query.slice(0, 8000)]);
    const hits = await hybridSearch(pool, gold.repoId, {
      queryEmbedding: emb,
      ftsQuery: c.query.slice(0, 2000),
      topK: 12,
      wVector: ix.retrieval.hybrid_weights.vector,
      wBm25: ix.retrieval.hybrid_weights.bm25,
    });

    const paths = hits.map((h) => h.file_path.toLowerCase()).join(" ");
    const subs = c.expectPathSubstringAnyOf ?? [];
    const ok =
      subs.length === 0 ||
      subs.some((s) => paths.includes(s.toLowerCase()));

    if (ok) {
      passed++;
      console.log(`PASS  "${c.query.slice(0, 60)}..." → top: ${hits[0]?.file_path ?? "(none)"}`);
    } else {
      failed++;
      console.log(`FAIL  "${c.query.slice(0, 60)}..."`);
      console.log(`      expected one of [${subs.join(", ")}] in top hits`);
      console.log(`      got: ${hits.slice(0, 5).map((h) => h.file_path).join(", ")}`);
    }
  }

  await pool.end();
  console.log(`\nEval done: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

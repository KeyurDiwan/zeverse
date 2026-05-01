import { loadConfig } from "../config";
import type { WorkflowStep } from "../workflows";
import { appendEvent, appendLog } from "./state";
import type { TemplateContext } from "./template";
import { renderTemplate } from "./template";
import { getPool } from "../index/db";
import { managedRepoRoot, retrieveAndPack } from "../index/indexer";
import { loadMerkle } from "../index/merkle";
import {
  augmentQueryWithFailures,
  extractStructuredFailuresBlock,
} from "../index/shellFailures";

export async function executeRetrieveStep(
  step: WorkflowStep,
  ctx: TemplateContext,
  repoId: string,
  runId: string
): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.index?.enabled || !cfg.index.postgres_url?.trim()) {
    throw new Error(
      "retrieve step requires index.enabled and index.postgres_url (POSTGRES_URL) in config/zeverse.yaml"
    );
  }
  const ix = cfg.index;

  let query = renderTemplate(step.prompt ?? "", ctx);

  if (step.retrieveFailureFrom) {
    const rawIds = renderTemplate(step.retrieveFailureFrom, ctx);
    const ids = rawIds.split(/[,]+/).map((s) => s.trim()).filter(Boolean);
    const locs = [];
    for (const id of ids) {
      const out = ctx.steps[id]?.output ?? "";
      locs.push(...extractStructuredFailuresBlock(out));
    }
    query = augmentQueryWithFailures(query, locs);
  }

  const pool = getPool(ix.postgres_url);
  const repoRoot = managedRepoRoot(cfg, repoId);
  const merkle = loadMerkle(repoId, cfg.paths.state_dir);
  const rootHash = merkle?.rootHash ?? "";

  const topK = step.retrieveTopK ?? ix.retrieval.top_k;
  const expand =
    (step.retrieveExpand && renderTemplate(step.retrieveExpand, ctx).trim()) ||
    ix.retrieval.expand;
  const maxChars = step.retrieveMaxChars ?? ix.retrieval.max_chars;
  const pathGlob = step.retrieveFilterGlob
    ? renderTemplate(step.retrieveFilterGlob, ctx).trim() || undefined
    : undefined;
  const langsRaw = step.retrieveLanguages
    ? renderTemplate(step.retrieveLanguages, ctx).trim()
    : "";
  const languages = langsRaw
    ? langsRaw.split(/[,]+/).map((s) => s.trim()).filter(Boolean)
    : undefined;

  appendLog(
    repoId,
    runId,
    `[${step.id}] retrieve query (${query.length} chars) topK=${topK} expand="${expand}"`
  );

  const packed = await retrieveAndPack({
    pool,
    hubConfig: cfg,
    indexConfig: ix,
    repoRoot,
    stateDir: cfg.paths.state_dir,
    rootHash,
    opts: {
      repoId,
      query,
      topK,
      expand,
      maxChars,
      pathGlob,
      languages,
      hybridVectorWeight: ix.retrieval.hybrid_weights.vector,
      hybridBm25Weight: ix.retrieval.hybrid_weights.bm25,
    },
  });

  appendEvent(repoId, runId, {
    type: "retrieve_finished",
    stepId: step.id,
    files: packed.files,
    chunkCount: packed.chunkIds.length,
  });

  appendLog(
    repoId,
    runId,
    `[${step.id}] retrieve_finished files=${packed.files.slice(0, 8).join(", ")}${packed.files.length > 8 ? "…" : ""}`
  );

  return packed.text;
}

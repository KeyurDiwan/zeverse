import OpenAI from "openai";
import type { IndexConfig, ZeverseConfig } from "../config";

export type EmbeddingProviderKind = "cloudverse" | "local";

let localPipeline: any | null = null;

/** Normalize embedding vector length to `dim` (pad with zeros or truncate). */
export function normalizeDimension(vec: number[], dim: number): number[] {
  if (vec.length === dim) return vec;
  if (vec.length > dim) return vec.slice(0, dim);
  return [...vec, ...Array(dim - vec.length).fill(0)];
}

async function embedCloudVerse(
  config: ZeverseConfig,
  indexCfg: IndexConfig,
  texts: string[]
): Promise<number[][]> {
  const baseURL = (config.llm.base_url || process.env.CLOUDVERSE_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  const apiKey = (config.llm.api_key || process.env.CLOUDVERSE_API_KEY || "").trim();
  if (!baseURL || !apiKey) {
    throw new Error("Embedding requires CLOUDVERSE_BASE_URL and CLOUDVERSE_API_KEY");
  }
  const client = new OpenAI({ baseURL, apiKey });
  const model =
    process.env.ZEVERSE_EMBEDDING_MODEL?.trim() || indexCfg.embedding.model;
  const dim = indexCfg.embedding.dim;

  const res = await client.embeddings.create({
    model,
    input: texts,
  });

  const out: number[][] = [];
  for (const item of res.data.sort((a, b) => a.index - b.index)) {
    let v = item.embedding as number[];
    v = normalizeDimension(v, dim);
    out.push(v);
  }
  return out;
}

async function embedLocal(texts: string[], dim: number): Promise<number[][]> {
  if (!localPipeline) {
    const { pipeline } = await import("@xenova/transformers");
    localPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  const pipe = localPipeline;
  const out: number[][] = [];
  for (const t of texts) {
    const result = await pipe(t, { pooling: "mean", normalize: true });
    const raw = result?.data ?? result;
    const arr =
      raw instanceof Float32Array || raw instanceof Float64Array
        ? Array.from(raw as Float32Array)
        : Array.from(raw as Iterable<number>);
    let vec = arr.map((x) => Number(x));
    vec = normalizeDimension(vec, dim);
    out.push(vec);
  }
  return out;
}

export async function embedTexts(
  hubCfg: ZeverseConfig,
  indexCfg: IndexConfig,
  texts: string[]
): Promise<number[][]> {
  const provider =
    (process.env.ZEVERSE_EMBEDDING_PROVIDER as EmbeddingProviderKind | undefined) ||
    indexCfg.embedding.provider;

  if (provider === "local") {
    return embedLocal(texts, indexCfg.embedding.dim);
  }
  return embedCloudVerse(hubCfg, indexCfg, texts);
}

import fs from "fs";
import path from "path";
import YAML from "yaml";

export interface PolicyConfig {
  allowed_repos: string[];
  allowed_workflows: string[];
  allowed_slack_channels: string[];
}

/** Hybrid retrieval weights (vector cosine vs BM25-style FTS rank). */
export interface IndexHybridWeights {
  vector: number;
  bm25: number;
}

export interface IndexConfig {
  enabled: boolean;
  postgres_url: string;
  embedding: {
    provider: "cloudverse" | "local";
    model: string;
    dim: number;
  };
  chunking: {
    max_lines: number;
    max_tokens: number;
  };
  retrieval: {
    top_k: number;
    expand: string;
    max_chars: number;
    hybrid_weights: IndexHybridWeights;
  };
  watcher: {
    poll_seconds: number;
    on_repo_add: boolean;
  };
}

export interface ZeverseConfig {
  llm: {
    provider: string;
    model: string;
    base_url: string;
    api_key: string;
    max_tokens: number;
    temperature: number;
  };
  runner: {
    timeout_ms: number;
    milestone_steps?: string[];
  };
  paths: {
    repos_file: string;
    state_dir: string;
    clone_dir: string;
  };
  policy?: PolicyConfig;
  /** Optional code index (pgvector + embeddings). When omitted, indexing is disabled. */
  index?: IndexConfig;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? "");
}

function resolveConfigValues(obj: Record<string, any>): any {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = resolveEnvVars(value);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = resolveConfigValues(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// Monorepo root — two levels up from server/src (server/ -> repo root/).
export function getHubRoot(): string {
  return path.resolve(__dirname, "../..");
}

export function loadConfig(): ZeverseConfig {
  const configPath = path.join(getHubRoot(), "config", "zeverse.yaml");
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(raw);
  return resolveConfigValues(parsed) as ZeverseConfig;
}

export function resolveHubPath(relative: string): string {
  return path.isAbsolute(relative) ? relative : path.join(getHubRoot(), relative);
}

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { loadConfig, resolveHubPath } from "./config";

export interface Repo {
  id: string;
  name: string;
  origin: string;
  defaultBranch: string;
  addedAt: string;
}

interface RepoStore {
  repos: Repo[];
}

function reposFilePath(): string {
  return resolveHubPath(loadConfig().paths.repos_file);
}

function readStore(): RepoStore {
  const file = reposFilePath();
  if (!fs.existsSync(file)) return { repos: [] };
  const raw = fs.readFileSync(file, "utf-8");
  try {
    return JSON.parse(raw) as RepoStore;
  } catch {
    return { repos: [] };
  }
}

function writeStore(store: RepoStore): void {
  fs.writeFileSync(reposFilePath(), JSON.stringify(store, null, 2));
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function uniqueId(base: string, existing: Repo[]): string {
  const slug = slugify(base) || "repo";
  if (!existing.some((r) => r.id === slug)) return slug;
  let i = 2;
  while (existing.some((r) => r.id === `${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

export function listRepos(): Repo[] {
  return readStore().repos;
}

export function getRepo(id: string): Repo | undefined {
  return readStore().repos.find((r) => r.id === id);
}

export function requireRepo(id: string): Repo {
  const repo = getRepo(id);
  if (!repo) throw new Error(`Unknown repo: ${id}`);
  if (!repo.origin) {
    throw new Error(`Repo "${id}" has no origin URL — update repos.json`);
  }
  return repo;
}

/**
 * Parse owner/repo from a GitHub URL.
 * Supports https://github.com/owner/repo(.git)? and git@github.com:owner/repo(.git)?
 */
export function parseGitHubOrigin(origin: string): { owner: string; repo: string } | null {
  const httpsMatch = origin.match(
    /github\.com\/([^/\s]+)\/([^/\s#?.]+?)(?:\.git)?\s*$/
  );
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  const sshMatch = origin.match(
    /github\.com:([^/\s]+)\/([^/\s#?.]+?)(?:\.git)?\s*$/
  );
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  return null;
}

export interface AddGitRepoInput {
  url: string;
  name?: string;
}

/**
 * Detect the default branch of a remote using `git ls-remote --symref`.
 * Falls back to "main" on any error.
 */
function detectDefaultBranch(url: string): string {
  const result = spawnSync("git", ["ls-remote", "--symref", url, "HEAD"], {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (result.status === 0) {
    const m = result.stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
    if (m) return m[1];
  }
  return "main";
}

function registerRepo(name: string, origin: string, defaultBranch: string): Repo {
  const store = readStore();
  const existing = store.repos.find((r) => r.origin === origin);
  if (existing) return existing;

  const repo: Repo = {
    id: uniqueId(name, store.repos),
    name,
    origin,
    defaultBranch,
    addedAt: new Date().toISOString(),
  };
  store.repos.push(repo);
  writeStore(store);
  return repo;
}

export function addGitRepo(input: AddGitRepoInput): Repo {
  const url = input.url.trim();
  if (!url) throw new Error("Git URL is required");

  const inferredName =
    input.name?.trim() ||
    path.basename(url.replace(/\/+$/, "")).replace(/\.git$/, "");

  const defaultBranch = detectDefaultBranch(url);
  return registerRepo(inferredName, url, defaultBranch);
}

export function removeRepo(id: string): boolean {
  const store = readStore();
  const next = store.repos.filter((r) => r.id !== id);
  if (next.length === store.repos.length) return false;
  writeStore({ repos: next });
  return true;
}

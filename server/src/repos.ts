import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { loadConfig, resolveHubPath } from "./config";

export interface Repo {
  id: string;
  name: string;
  path: string;
  origin?: string;
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
  if (!fs.existsSync(repo.path)) {
    throw new Error(`Repo "${id}" path does not exist on disk: ${repo.path}`);
  }
  return repo;
}

export interface AddLocalRepoInput {
  path: string;
  name?: string;
}

export interface AddGitRepoInput {
  url: string;
  name?: string;
}

export function addLocalRepo(input: AddLocalRepoInput): Repo {
  const abs = path.resolve(input.path);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Path does not exist or is not a directory: ${abs}`);
  }
  const store = readStore();
  if (store.repos.some((r) => path.resolve(r.path) === abs)) {
    throw new Error(`Repo already registered at path: ${abs}`);
  }
  const name = input.name?.trim() || path.basename(abs);
  const repo: Repo = {
    id: uniqueId(name, store.repos),
    name,
    path: abs,
    addedAt: new Date().toISOString(),
  };
  store.repos.push(repo);
  writeStore(store);
  return repo;
}

export function addGitRepo(input: AddGitRepoInput): Repo {
  const url = input.url.trim();
  if (!url) throw new Error("Git URL is required");

  const cloneBase = resolveHubPath(loadConfig().paths.clone_dir);
  if (!fs.existsSync(cloneBase)) fs.mkdirSync(cloneBase, { recursive: true });

  const inferredName =
    input.name?.trim() ||
    path.basename(url.replace(/\/+$/, "")).replace(/\.git$/, "");
  const target = path.join(cloneBase, inferredName);

  if (fs.existsSync(target)) {
    throw new Error(`Target clone path already exists: ${target}`);
  }

  const result = spawnSync("git", ["clone", url, target], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "git clone failed").trim();
    throw new Error(`git clone failed: ${err}`);
  }

  return addLocalRepo({ path: target, name: inferredName });
}

export function removeRepo(id: string): boolean {
  const store = readStore();
  const next = store.repos.filter((r) => r.id !== id);
  if (next.length === store.repos.length) return false;
  writeStore({ repos: next });
  return true;
}

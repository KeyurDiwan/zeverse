import crypto from "crypto";
import fs from "fs";
import path from "path";
import { minimatch } from "minimatch";
import { resolveHubPath } from "../config";

export interface MerklePersisted {
  rootHash: string;
  /** relative posix path -> sha256 hex */
  files: Record<string, string>;
  updatedAt: string;
}

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/vendor/**",
  "**/*.min.js",
  "**/.workflows-cache/**",
];

function posixRel(fromRoot: string, absPath: string): string {
  const rel = path.relative(fromRoot, absPath).split(path.sep).join("/");
  return rel.startsWith("./") ? rel.slice(2) : rel;
}

function readZeverseIgnore(repoRoot: string): string[] {
  const p = path.join(repoRoot, ".zeverseignore");
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function shouldIgnorePath(relPosix: string, globs: string[]): boolean {
  for (const g of globs) {
    if (minimatch(relPosix, g, { dot: true })) return true;
  }
  return false;
}

function sha256File(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hashCombined(parts: string[]): string {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p + "\n");
  return h.digest("hex");
}

function okExtension(rel: string, ext: string): boolean {
  if (rel.startsWith(".zeverse/rules/")) return true;
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".java",
    ".rb",
    ".rs",
    ".md",
    ".yaml",
    ".yml",
  ].includes(ext);
}

/**
 * Walk repoRoot for indexable files and compute per-file + Merkle root hash
 * (recursive dir/file tree digest).
 */
export function computeMerkleTree(repoRoot: string): MerklePersisted {
  const extra = readZeverseIgnore(repoRoot);
  const globs = [...DEFAULT_IGNORE, ...extra];
  const files: Record<string, string> = {};

  function hashDirectory(absDir: string): string {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return hashCombined(["empty"]);
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    const parts: string[] = [];
    for (const ent of dirents) {
      const abs = path.join(absDir, ent.name);
      const rel = posixRel(repoRoot, abs);
      if (shouldIgnorePath(rel, globs)) continue;

      if (ent.isDirectory()) {
        parts.push(`dir:${ent.name}:${hashDirectory(abs)}`);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!okExtension(rel, ext)) continue;
        try {
          const h = sha256File(abs);
          files[rel] = h;
          parts.push(`file:${ent.name}:${h}`);
        } catch {
          /* skip unreadable */
        }
      }
    }
    return hashCombined(parts);
  }

  const rootHash = hashDirectory(repoRoot);
  return {
    rootHash,
    files,
    updatedAt: new Date().toISOString(),
  };
}

export function merkleIndexPath(stateDir: string, repoId: string): string {
  return path.join(resolveHubPath(stateDir), repoId, "index", "merkle.json");
}

export function loadMerkle(repoId: string, stateDir: string): MerklePersisted | null {
  const p = merkleIndexPath(stateDir, repoId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as MerklePersisted;
  } catch {
    return null;
  }
}

export function saveMerkle(repoId: string, stateDir: string, data: MerklePersisted): void {
  const p = merkleIndexPath(stateDir, repoId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

export function diffMerkleFiles(
  prev: MerklePersisted | null,
  next: MerklePersisted
): { addedOrChanged: string[]; removed: string[] } {
  const prevFiles = prev?.files ?? {};
  const nextFiles = next.files;
  const addedOrChanged: string[] = [];
  const removed: string[] = [];

  for (const [rel, h] of Object.entries(nextFiles)) {
    if (prevFiles[rel] !== h) addedOrChanged.push(rel);
  }
  for (const rel of Object.keys(prevFiles)) {
    if (!(rel in nextFiles)) removed.push(rel);
  }
  return { addedOrChanged, removed };
}

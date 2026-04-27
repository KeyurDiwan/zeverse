#!/usr/bin/env npx tsx
/**
 * One-shot migration: converts old repos.json (with `path`, optional `origin`)
 * to the new remote-first format (`origin` required, `defaultBranch`, no `path`).
 *
 * Usage:  npx tsx server/scripts/migrate-repos.ts
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const HUB_ROOT = path.resolve(__dirname, "../..");
const REPOS_FILE = path.join(HUB_ROOT, "repos.json");

interface OldRepo {
  id: string;
  name: string;
  path?: string;
  origin?: string;
  addedAt: string;
}

interface NewRepo {
  id: string;
  name: string;
  origin: string;
  defaultBranch: string;
  addedAt: string;
  migrationRequired?: boolean;
}

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

function main() {
  if (!fs.existsSync(REPOS_FILE)) {
    console.log("No repos.json found — nothing to migrate.");
    return;
  }

  const raw = JSON.parse(fs.readFileSync(REPOS_FILE, "utf-8"));
  const oldRepos: OldRepo[] = raw.repos ?? [];
  const newRepos: NewRepo[] = [];

  for (const repo of oldRepos) {
    if ((repo as any).defaultBranch && repo.origin) {
      console.log(`  ${repo.id}: already migrated`);
      const { path: _p, ...rest } = repo as any;
      newRepos.push(rest);
      continue;
    }

    if (!repo.origin) {
      console.log(`  ${repo.id}: WARNING — no origin URL, marking migrationRequired=true`);
      newRepos.push({
        id: repo.id,
        name: repo.name,
        origin: "",
        defaultBranch: "main",
        addedAt: repo.addedAt,
        migrationRequired: true,
      });
      continue;
    }

    console.log(`  ${repo.id}: detecting default branch for ${repo.origin}...`);
    const defaultBranch = detectDefaultBranch(repo.origin);
    console.log(`  ${repo.id}: defaultBranch=${defaultBranch}`);

    newRepos.push({
      id: repo.id,
      name: repo.name,
      origin: repo.origin,
      defaultBranch,
      addedAt: repo.addedAt,
    });
  }

  const backup = REPOS_FILE + ".bak";
  fs.copyFileSync(REPOS_FILE, backup);
  console.log(`\nBackup written to ${backup}`);

  fs.writeFileSync(REPOS_FILE, JSON.stringify({ repos: newRepos }, null, 2));
  console.log(`Migrated ${newRepos.length} repo(s) in repos.json`);

  const flagged = newRepos.filter((r) => r.migrationRequired);
  if (flagged.length > 0) {
    console.log(
      `\nWARNING: ${flagged.length} repo(s) have no origin URL and need manual update:`
    );
    for (const r of flagged) {
      console.log(`  - ${r.id}`);
    }
  }
}

main();

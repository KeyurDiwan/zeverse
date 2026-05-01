import { loadConfig } from "../config";
import { listRepos } from "../repos";
import { indexRepo } from "./indexer";

let watcherTimer: NodeJS.Timeout | null = null;

/**
 * Periodically re-index all registered repos into pgvector (managed clones).
 */
export function startIndexWatcher(): void {
  const cfg = loadConfig();
  const ix = cfg.index;
  if (!ix?.enabled || !ix.postgres_url?.trim()) return;
  if (watcherTimer) return;

  const pollMs = Math.max(60_000, (ix.watcher.poll_seconds ?? 300) * 1000);

  const tick = (): void => {
    void (async () => {
      const c = loadConfig();
      const idx = c.index;
      if (!idx?.enabled || !idx.postgres_url?.trim()) return;
      for (const repo of listRepos()) {
        try {
          await indexRepo({
            hubConfig: c,
            indexConfig: idx,
            repo,
            full: false,
          });
          console.log(`[index-watcher] indexed ${repo.id}`);
        } catch (e: any) {
          console.warn(`[index-watcher] ${repo.id}: ${e.message}`);
        }
      }
    })();
  };

  watcherTimer = setInterval(tick, pollMs);
  setTimeout(tick, 15_000);
}

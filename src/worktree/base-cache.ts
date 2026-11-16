import type { Project, TackConfig } from "../config/schema";
import { defaultBranchFetch, FETCH_TIMEOUT_MS, gitAsync } from "./worktree";
import { isBaseCacheFresh, recordBaseCacheFreshness } from "./base-freshness";
export { isBaseCacheFresh, readBaseCacheFreshness, recordBaseCacheFreshness } from "./base-freshness";

/** All git operations here are asynchronous: this also runs in MCP servers. */
export async function refreshBaseCache(project: Project): Promise<void> {
  const sym = await gitAsync(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], project.path);
  let ref = sym.code === 0 && sym.out.startsWith("origin/") && sym.out !== "origin/HEAD" ? sym.out : null;
  if (!ref) for (const candidate of ["origin/main", "origin/master"]) {
    const r = await gitAsync(["rev-parse", "--verify", "--quiet", `refs/remotes/${candidate}^{commit}`], project.path);
    if (r.code === 0) { ref = candidate; break; }
  }
  if (!ref) return;
  const { args, env } = defaultBranchFetch(ref);
  const fetched = await gitAsync(args, project.path, { timeoutMs: FETCH_TIMEOUT_MS, env });
  if (fetched.code !== 0 || fetched.timedOut) return;
  const sha = await gitAsync(["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}^{commit}`], project.path);
  if (sha.code === 0 && sha.out) recordBaseCacheFreshness(project.name, ref, sha.out);
}
export function startBaseCacheRefresher(config: TackConfig): () => void {
  if (!config.baseCache?.enabled) return () => {};
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const projects = config.projects.filter(p => !isBaseCacheFresh(p.name, config.baseCache.intervalSeconds * 1000));
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, projects.length) }, async () => {
        while (!stopped && next < projects.length) {
          const p = projects[next++]!;
          try { await refreshBaseCache(p); } catch { /* best effort */ }
        }
      }));
    } finally { running = false; }
  };
  void tick().catch(() => {});
  const timer = setInterval(() => { void tick().catch(() => {}); }, config.baseCache.intervalSeconds * 1000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

import type { AgentRow } from "../db";
import { agentTouches } from "../db";
import type { TackConfig } from "../config/schema";
import { changedFiles } from "../worktree/worktree";

/**
 * Cross-agent conflict prediction — the "correctness of parallel work" layer that
 * isolated worktrees only floor (SPEC positioning). Two kinds:
 *
 *  - DECLARED overlap (before work exists): compare the touch-sets the supervisor
 *    declared on `spawn_agent`, so it can serialize colliding units with `dependsOn`
 *    up front rather than discovering the clash at PR time.
 *  - ACTUAL collisions (after agents run): the files two sibling agents on the same
 *    project both changed — a merge conflict waiting to happen across the N branches.
 */

/** A file changed/claimed by more than one agent in the same project. */
export interface FileCollision {
  project: string;
  file: string;
  agents: string[];
}

/** Normalizes a declared touch entry to a comparable path: drops a trailing glob
 * segment (`src/**`, `src/*`) down to its directory so a glob and a concrete file
 * under it still compare. Lowercased, slashless-trimmed. */
function normalize(p: string): string {
  return p
    .trim()
    .replace(/\/+\*+$/, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Do two declared paths collide — identical, or one a directory ancestor of the
 * other? Exact/prefix only (no full glob); enough for the common same-file/same-dir
 * case in an initial version. */
function collide(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * The declared touch-sets of existing siblings that overlap a new agent's declared
 * touch-set, for the spawn-time warning. Returns one entry per colliding sibling with
 * the specific paths that clash. Empty when nothing is declared or nothing overlaps.
 */
export function overlapWithSiblings(
  newTouches: string[],
  siblings: Array<{ id: string; touches: string[] }>,
): Array<{ agentId: string; paths: string[] }> {
  const hits: Array<{ agentId: string; paths: string[] }> = [];
  for (const sib of siblings) {
    const paths = new Set<string>();
    for (const a of newTouches) {
      for (const b of sib.touches) {
        if (collide(a, b)) {
          paths.add(a);
          paths.add(b);
        }
      }
    }
    if (paths.size > 0) hits.push({ agentId: sib.id, paths: [...paths].sort() });
  }
  return hits;
}

// Memoize actual-collision analysis so the dashboard's 1s poll doesn't shell out to
// git on every tick: key on the set of agents that have a worktree plus their last
// update, so it only recomputes when an agent's branch could have changed.
const collisionCache = new Map<string, FileCollision[]>();

function cacheKey(agents: AgentRow[]): string {
  return agents
    .filter((a) => a.worktree_path && a.branch)
    .map((a) => `${a.id}:${a.status}:${a.updated_at}`)
    .sort()
    .join("|");
}

/**
 * Files changed by more than one agent within the same project, across the session's
 * agents that have produced a worktree. The practical "these branches will collide"
 * signal to surface before opening N PRs. Cached on the agent set (see above).
 */
export function sessionFileCollisions(agents: AgentRow[], config: TackConfig): FileCollision[] {
  // Manual workspaces count as workers here (the human's edits collide like anyone's),
  // but a human editing files never bumps the row's `updated_at`, so the cache key
  // can't see their changes — always recompute while one exists.
  const uncacheable = agents.some((a) => a.kind === "manual" && a.worktree_path);
  const key = cacheKey(agents);
  const cached = uncacheable ? undefined : collisionCache.get(key);
  if (cached) return cached;

  const projectPath = new Map(config.projects.map((p) => [p.name, p.path]));
  // project -> file -> set of agent ids
  const byProject = new Map<string, Map<string, Set<string>>>();
  for (const a of agents) {
    if (!a.worktree_path || !a.branch) continue;
    // PR-fix agents build ON TOP of an existing PR branch (and are diffed against its
    // head), so overlapping the agent that produced that PR is the point, not a
    // collision between sibling branches. Review agents never ship their changes.
    if (a.kind === "pr_fix" || a.kind === "review") continue;
    const repo = projectPath.get(a.project_name);
    if (!repo) continue;
    const files = changedFiles(repo, a.branch, a.worktree_path);
    let fileMap = byProject.get(a.project_name);
    if (!fileMap) byProject.set(a.project_name, (fileMap = new Map()));
    for (const f of files) {
      let set = fileMap.get(f);
      if (!set) fileMap.set(f, (set = new Set()));
      set.add(a.id);
    }
  }

  const out: FileCollision[] = [];
  for (const [project, fileMap] of byProject) {
    for (const [file, ids] of fileMap) {
      if (ids.size > 1) out.push({ project, file, agents: [...ids].sort() });
    }
  }
  out.sort((a, b) => (a.project + a.file).localeCompare(b.project + b.file));

  // Bound the cache so a long-lived dashboard can't grow it without limit.
  if (collisionCache.size > 64) collisionCache.clear();
  if (!uncacheable) collisionCache.set(key, out);
  return out;
}

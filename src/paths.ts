import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root for all Tack state. Override with TACK_HOME (used by tests and to run
 * side-by-side with the legacy Tack CLI).
 *
 * New Tack deliberately shares the `~/.tack` root with the legacy CLI (per the
 * user's choice) but uses DISTINCT filenames for its own artifacts — `config.ts`
 * and `state.db` — so the two can coexist without clobbering each other's
 * schema/config until the old CLI is retired. Worktrees and logs are id-scoped,
 * so those directories are safe to share.
 */
export const TACK_HOME = process.env.TACK_HOME ?? join(homedir(), ".tack");

/** User config (a `.ts` module that `export default`s a config object). */
export const CONFIG_PATH = join(TACK_HOME, "config.ts");
/** SQLite database — metadata and refs only; large text lives on disk. */
export const DB_PATH = join(TACK_HOME, "state.db");
/** Normalized per-agent / per-session logs. */
export const LOGS_DIR = join(TACK_HOME, "logs");
/** Session-scoped context files materialized for agents (passed by path). */
export const CONTEXT_DIR = join(TACK_HOME, "context");
/** Large agent artifacts (prompts, outputs, diffs) referenced from the DB. */
export const ARTIFACTS_DIR = join(TACK_HOME, "artifacts");
export const BASE_CACHE_DIR = join(TACK_HOME, "cache", "base");
/** Git worktrees, scoped per session then per project. */
export const WORKTREES_DIR = join(TACK_HOME, "worktrees");
/** Detached, read-only snapshot worktrees the supervisor investigates, scoped per
 * session then per project. Kept apart from WORKTREES_DIR so the supervisor's read
 * grant covers only fresh upstream code, never the agents' in-progress branches. */
export const SNAPSHOTS_DIR = join(TACK_HOME, "snapshots");

/** Expands a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Collapses a leading home directory back to `~`, the form we write into config. */
export function collapseHome(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
  return p;
}

/** Tack-owned supervisor cwd; its settings must stay outside the writable drafts. */
export function supervisorCwd(sessionId: string): string {
  return join(TACK_HOME, "supervisor", sessionId);
}

/** Publishable page sources only, never supervisor settings or project code. */
export function supervisorArtifactsDir(sessionId: string): string {
  return join(supervisorCwd(sessionId), "artifacts");
}

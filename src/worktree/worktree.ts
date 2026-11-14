import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WORKTREES_DIR } from "../paths";

export interface Worktree {
  repo: string;
  path: string;
  branch: string;
  /** The commit the branch forked from. Diffs are taken against this so an agent's
   * committed work (it commits and opens PRs) shows up — `git diff HEAD` would
   * only capture uncommitted changes and read empty after a commit. */
  base: string;
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return (r.stdout ?? "").trim();
}

/** Worktrees are scoped per session, then per agent, so many agents can touch the
 * same project within one session without colliding. */
export function sessionWorktreesRoot(sessionId: string): string {
  return join(WORKTREES_DIR, sessionId);
}

/**
 * Standardized head-branch nomenclature for PRs an agent opens on behalf of a
 * session: `tack/pr/<sessionId>/<slug>`. Encoding the session id lets us later
 * discover the PR and tie it back (see `src/projects/prs.ts`). Distinct from the
 * internal `tack/<sessionId>/<agentId>` worktree branches.
 */
export const SESSION_PR_BRANCH_PREFIX = "tack/pr";

function safeSlug(slug: string): string {
  return slug.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "change";
}

export function sessionPrBranch(sessionId: string, slug: string): string {
  return `${SESSION_PR_BRANCH_PREFIX}/${sessionId}/${safeSlug(slug)}`;
}

/** Extracts the session id from a PR branch, or null if it isn't one of ours. */
export function sessionIdFromPrBranch(branch: string): string | null {
  const prefix = `${SESSION_PR_BRANCH_PREFIX}/`;
  if (!branch.startsWith(prefix)) return null;
  return branch.slice(prefix.length).split("/")[0] || null;
}

/**
 * Guards against a misconfigured project path: `git` commands walk up to any
 * ancestor repo, so we require the path to BE a git repository root.
 */
function assertRepoRoot(repo: string): void {
  const top = git(["rev-parse", "--show-toplevel"], repo);
  if (realpathSync(top) !== realpathSync(repo)) {
    throw new Error(`project path is not a git repository root: ${repo} (nearest repo root is ${top})`);
  }
}

/** The ref where we stash a worktree branch's fork point, mirroring the branch
 * name under `refs/tack-base/` so the base survives the agent moving HEAD (commits,
 * rebases) and can be recovered on resume. */
function baseRef(branch: string): string {
  return `refs/tack-base/${branch.slice("tack/".length)}`;
}

/** Reads the recorded fork point for a branch, or null if it was never recorded. */
function readBaseRef(repo: string, branch: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", baseRef(branch)], {
    cwd: repo,
    encoding: "utf8",
  });
  const sha = (r.stdout ?? "").trim();
  return r.status === 0 && sha ? sha : null;
}

/** Creates a fresh git worktree on a new `tack/<sessionId>/<agentId>` branch off HEAD. */
export function createWorktree(repo: string, sessionId: string, agentId: string): Worktree {
  assertRepoRoot(repo);
  const root = sessionWorktreesRoot(sessionId);
  mkdirSync(root, { recursive: true });
  const path = join(root, agentId);
  const branch = `tack/${sessionId}/${agentId}`;
  const base = git(["rev-parse", "HEAD"], repo);
  git(["worktree", "add", "-b", branch, path, "HEAD"], repo);
  // Pin the fork point so the accumulated diff is recoverable even after the agent
  // commits (which moves the branch HEAD away from `base`).
  git(["update-ref", baseRef(branch), base], repo);
  return { repo, path, branch, base };
}

/**
 * Creates a worktree for a PR-fix agent: instead of forking off the repo's HEAD
 * like `createWorktree`, it forks off the PR's CURRENT remote head, so the fix agent
 * builds on exactly what reviewers are looking at (including any commits pushed
 * since the PR opened). The local branch keeps the usual `tack/<ses>/<agent>` name;
 * the watcher later pushes it (non-force) onto the PR branch. The fork point is
 * pinned like any other worktree, so "did the agent commit anything?" is simply
 * HEAD != base.
 */
export function createPrWorktree(repo: string, sessionId: string, agentId: string, prBranch: string): Worktree {
  assertRepoRoot(repo);
  const root = sessionWorktreesRoot(sessionId);
  mkdirSync(root, { recursive: true });
  const path = join(root, agentId);
  const branch = `tack/${sessionId}/${agentId}`;
  // Explicit refspec so the remote-tracking ref is updated regardless of the repo's
  // fetch config (equivalent to `git fetch origin <prBranch>` with default config).
  git(["fetch", "origin", `+refs/heads/${prBranch}:refs/remotes/origin/${prBranch}`], repo);
  const start = `refs/remotes/origin/${prBranch}`;
  const base = git(["rev-parse", start], repo);
  // --no-track: the local branch name differs from the PR branch, and we never want
  // a stray `git push`/`git pull` inside the worktree to act on the PR — the watcher
  // owns pushing.
  git(["worktree", "add", "--no-track", "-b", branch, path, base], repo);
  git(["update-ref", baseRef(branch), base], repo);
  return { repo, path, branch, base };
}

/** Reattaches to a worktree that already exists at the expected path (resume /
 * retry), recovering its pinned fork point. Null when there's nothing to reuse. */
function reuseWorktree(repo: string, sessionId: string, agentId: string): Worktree | null {
  const path = join(sessionWorktreesRoot(sessionId), agentId);
  if (!existsSync(path)) return null;
  const branch = `tack/${sessionId}/${agentId}`;
  // Recover the pinned fork point; fall back to the worktree's own HEAD only if a
  // legacy worktree predates base-ref recording (yields today's HEAD-only diff).
  const base = readBaseRef(repo, branch) ?? git(["rev-parse", "HEAD"], path);
  return { repo, path, branch, base };
}

/** Reuses an existing worktree at the expected path, else creates one (resume-safe). */
export function ensureWorktree(repo: string, sessionId: string, agentId: string): Worktree {
  return reuseWorktree(repo, sessionId, agentId) ?? createWorktree(repo, sessionId, agentId);
}

/** `ensureWorktree` for a PR-fix agent: reuse on resume/retry (so a retried run keeps
 * its partial commits), else fork fresh off the PR's remote head. */
export function ensurePrWorktree(repo: string, sessionId: string, agentId: string, prBranch: string): Worktree {
  return reuseWorktree(repo, sessionId, agentId) ?? createPrWorktree(repo, sessionId, agentId, prBranch);
}

// Async (`Bun.spawn`) git helpers for the PR watcher, which runs on a timer and so
// must never block on `spawnSync` (see src/prwatch/watch.ts).

async function gitAsync(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

/** The pinned fork point of a `tack/…` branch, or null if none was recorded. */
export async function worktreeBase(repo: string, branch: string): Promise<string | null> {
  const r = await gitAsync(["rev-parse", "--verify", "--quiet", baseRef(branch)], repo);
  return r.code === 0 && r.out ? r.out : null;
}

/** The current HEAD commit of a worktree, or null if it can't be read. */
export async function worktreeHead(worktreePath: string): Promise<string | null> {
  if (!existsSync(worktreePath)) return null;
  const r = await gitAsync(["rev-parse", "HEAD"], worktreePath);
  return r.code === 0 && r.out ? r.out : null;
}

/** Async twin of `commitWorktree` for the watcher's post-fix safety net: commits
 * anything left uncommitted, returning false when the tree was already clean.
 * Throws with git's reason if the commit itself fails. */
export async function commitWorktreeAsync(worktreePath: string, message: string): Promise<boolean> {
  const status = await gitAsync(["status", "--porcelain"], worktreePath);
  if (status.code !== 0 || status.out === "") return false;
  for (const args of [["add", "-A"], ["commit", "-m", message]]) {
    const r = await gitAsync(args, worktreePath);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.err || r.out}`);
  }
  return true;
}

function tryGit(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf8" });
}

/** Best-effort teardown of one agent's worktree, its branch, and its base ref. */
export function removeWorktree(wt: Worktree): void {
  if (existsSync(wt.path)) tryGit(["worktree", "remove", wt.path, "--force"], wt.repo);
  tryGit(["worktree", "prune"], wt.repo);
  tryGit(["branch", "-D", wt.branch], wt.repo);
  tryGit(["update-ref", "-d", baseRef(wt.branch)], wt.repo);
}

/** Removes the whole session's worktree directory (best-effort). */
export function purgeSessionWorktrees(sessionId: string): void {
  rmSync(sessionWorktreesRoot(sessionId), { recursive: true, force: true });
}

/**
 * Commits any uncommitted changes left in a worktree so they're included when the
 * branch is pushed for a PR. Agents are asked to commit their own work; this is a
 * safety net for the ones that don't, so no work is silently dropped from the PR.
 * No-op (returns false) when the tree is already clean.
 */
export function commitWorktree(worktreePath: string, message: string): boolean {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: worktreePath, encoding: "utf8" });
  if ((status.stdout ?? "").trim() === "") return false;
  git(["add", "-A"], worktreePath);
  git(["commit", "-m", message], worktreePath);
  return true;
}

/** The full diff a worktree accumulated since it forked, as a unified patch.
 * Taken against the recorded fork point (`wt.base`) rather than HEAD so it includes
 * the agent's commits, not just uncommitted working-tree changes. */
export function worktreeDiff(wt: Worktree): string {
  const r = spawnSync("git", ["diff", wt.base], { cwd: wt.path, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

/**
 * The repo-relative paths an agent's branch changed since it forked — the basis for
 * cross-agent conflict prediction (a file two sibling agents both touch is a merge
 * collision waiting to happen). Taken against the recorded fork point so it reflects
 * committed work, matching `worktreeDiff`. Empty when the worktree or base is gone.
 */
export function changedFiles(repo: string, branch: string, worktreePath: string): string[] {
  const base = readBaseRef(repo, branch);
  if (!base || !existsSync(worktreePath)) return [];
  const r = spawnSync("git", ["diff", "--name-only", base], { cwd: worktreePath, encoding: "utf8" });
  if (r.status !== 0) return [];
  return (r.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

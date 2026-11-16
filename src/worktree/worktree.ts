import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOTS_DIR, WORKTREES_DIR } from "../paths";

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

/** Supervisor snapshot worktrees are scoped per session, then per project (see
 * `syncSnapshot`). This root is the supervisor's whole read grant over projects. */
export function sessionSnapshotsRoot(sessionId: string): string {
  return join(SNAPSHOTS_DIR, sessionId);
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

/** Bounds the pre-worktree / pre-snapshot fetch so an unreachable remote or an auth
 * prompt can't stall agent startup or a supervisor sync; on timeout we just use the
 * already-local remote ref. */
const FETCH_TIMEOUT_MS = 15_000;

/** `git rev-parse --verify --quiet <ref>^{commit}`, or null if the ref doesn't resolve. */
function tryResolveCommit(repo: string, ref: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repo,
    encoding: "utf8",
  });
  const sha = (r.stdout ?? "").trim();
  return r.status === 0 && sha ? sha : null;
}

/**
 * The remote default branch as a remote-tracking ref (e.g. `origin/main`), or null
 * if the repo has no origin / no recognizable default. Prefers `origin/HEAD` (set by
 * `git clone`); falls back to the conventional `origin/main` then `origin/master`
 * for remotes added by hand, where `origin/HEAD` is usually unset.
 */
function remoteDefaultBranch(repo: string): string | null {
  const sym = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: repo,
    encoding: "utf8",
  });
  const head = (sym.stdout ?? "").trim();
  if (sym.status === 0 && head.startsWith("origin/") && head !== "origin/HEAD") return head;
  for (const ref of ["origin/main", "origin/master"]) {
    if (tryResolveCommit(repo, `refs/remotes/${ref}`)) return ref;
  }
  return null;
}

/** Fetch argv + env shared by the sync (agent worktree) and async (supervisor
 * snapshot) paths, so both refresh the default branch the same way. */
function defaultBranchFetch(remoteRef: string): { args: string[]; env: Record<string, string | undefined> } {
  return {
    args: ["fetch", "--quiet", "origin", remoteRef.slice("origin/".length)],
    // Never block on a credential prompt; a headless run has no one to answer it.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };
}

/**
 * The commit a new agent worktree should fork from: the tip of the remote default
 * branch, refreshed by a best-effort fetch. Basing on the project's local HEAD went
 * wrong whenever the user's checkout was behind origin or on an unrelated branch —
 * every agent branch started from stale code and its PR came back unmergeable.
 * The fetch is non-fatal (offline, auth failure, timeout all fall back to the
 * already-local `origin/<branch>`), and a repo with no origin at all — e.g. a
 * local-only project — keeps the old behavior of forking from HEAD.
 */
function resolveStartPoint(repo: string): string {
  const remoteRef = remoteDefaultBranch(repo);
  if (remoteRef) {
    const { args, env } = defaultBranchFetch(remoteRef);
    spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      timeout: FETCH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const sha = tryResolveCommit(repo, `refs/remotes/${remoteRef}`);
    if (sha) return sha;
  }
  return git(["rev-parse", "HEAD"], repo);
}

/**
 * Creates a fresh git worktree on a new `tack/<sessionId>/<agentId>` branch, forked
 * from the up-to-date remote default branch (`origin/HEAD`, else `origin/main` /
 * `origin/master`, fetched first) rather than the project's local HEAD, so agent
 * branches — and the PRs opened from them — start from current upstream code. Falls
 * back to HEAD only when the repo has no usable origin. See `resolveStartPoint`.
 */
export function createWorktree(repo: string, sessionId: string, agentId: string): Worktree {
  assertRepoRoot(repo);
  const root = sessionWorktreesRoot(sessionId);
  mkdirSync(root, { recursive: true });
  const path = join(root, agentId);
  const branch = `tack/${sessionId}/${agentId}`;
  const base = resolveStartPoint(repo);
  git(["worktree", "add", "-b", branch, path, base], repo);
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

/** Attach to a continuation's recorded cwd without creating a replacement. */
export function existingWorktree(repo: string, path: string, branch: string): Worktree {
  if (!existsSync(path)) throw new Error(`Worktree missing: ${path}`);
  return { repo, path, branch, base: readBaseRef(repo, branch) ?? git(["rev-parse", "HEAD"], path) };
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

/** Check out the remote PR head and pin its merge base for review, reusing on retry. */
export function ensureRemoteReviewWorktree(repo: string, sessionId: string, agentId: string, headBranch: string, baseBranch: string | null): Worktree {
  const existing = reuseWorktree(repo, sessionId, agentId);
  if (existing) return existing;
  assertRepoRoot(repo);
  const base = baseBranch ?? remoteDefaultBranch(repo)?.replace(/^origin\//, "");
  if (!base) throw new Error("Cannot determine the remote default branch for review");
  const root = sessionWorktreesRoot(sessionId);
  mkdirSync(root, { recursive: true });
  const path = join(root, agentId);
  const branch = `tack/${sessionId}/${agentId}`;
  for (const ref of new Set([headBranch, base]))
    git(["fetch", "origin", `+refs/heads/${ref}:refs/remotes/origin/${ref}`], repo);
  const head = `refs/remotes/origin/${headBranch}`;
  const mergeBase = git(["merge-base", `refs/remotes/origin/${base}`, head], repo);
  git(["worktree", "add", "--no-track", "-b", branch, path, head], repo);
  git(["update-ref", baseRef(branch), mergeBase], repo);
  return { repo, path, branch, base: mergeBase };
}

// Async (`Bun.spawn`) git helpers for the PR watcher, which runs on a timer and so
// must never block on `spawnSync` (see src/prwatch/watch.ts), and for supervisor
// snapshot syncs, which run inside the MCP server and may fan out per project.

async function gitAsync(
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.env ? { env: opts.env } : {}),
  });
  // Kill on timeout rather than abandoning the promise, so a hung fetch can't leak a
  // git process past the caller giving up on it.
  let timedOut = false;
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, opts.timeoutMs)
      : undefined;
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out: out.trim(), err: err.trim(), timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pre-PR sync outcomes are data: even an offline remote or a rejected merge
 * must let the caller open the PR and leave repair to the watcher. */
export type BranchBaseSync = { base: string | null; fetched: boolean } & (
  | { status: "skipped" | "up_to_date" }
  | { status: "merged"; baseSha: string }
  | { status: "conflict"; conflictedFiles: string[] }
  | { status: "error"; error: string }
);

/**
 * Merge the latest PR base before pushing, never rewriting the agent's history.
 * Pin the exact merged commit as the new diff baseline so upstream files don't
 * become apparent agent edits (and false sibling collisions). Fetch failures use
 * the cached remote ref; failed merges are aborted before handing off to pr_fix.
 * All git calls are async because open_pr runs inside the supervisor MCP server.
 */
export async function syncBranchWithBase(
  repo: string,
  branch: string,
  worktreePath: string,
  base?: string,
): Promise<BranchBaseSync> {
  let resolvedBase = base ?? null;
  if (!resolvedBase) {
    // Async equivalent of remoteDefaultBranch: avoid blocking the MCP server even
    // during local ref discovery, while keeping the same clone/manual-origin rules.
    const sym = await gitAsync(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo);
    if (sym.code === 0 && sym.out.startsWith("origin/") && sym.out !== "origin/HEAD") {
      resolvedBase = sym.out.slice("origin/".length);
    } else {
      for (const candidate of ["main", "master"]) {
        const r = await gitAsync(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}^{commit}`], repo);
        if (r.code === 0) {
          resolvedBase = candidate;
          break;
        }
      }
    }
  }
  const result = { base: resolvedBase, fetched: false };
  if (!resolvedBase) return { ...result, status: "skipped" };
  const remoteRef = `refs/remotes/origin/${resolvedBase}`;
  const fetch = await gitAsync(
    ["fetch", "--quiet", "origin", `+refs/heads/${resolvedBase}:${remoteRef}`],
    repo,
    { timeoutMs: FETCH_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  result.fetched = fetch.code === 0 && !fetch.timedOut;
  const target = await gitAsync(["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`], repo);
  if (target.code !== 0 || !target.out) return { ...result, status: "skipped" };
  const baseSha = target.out;
  const ancestor = await gitAsync(["merge-base", "--is-ancestor", baseSha, "HEAD"], worktreePath);
  if (ancestor.code === 0) return { ...result, status: "up_to_date" };
  if (ancestor.code !== 1) return { ...result, status: "error", error: ancestor.err || ancestor.out };

  const head = await gitAsync(["rev-parse", "--verify", "HEAD"], worktreePath);
  const clean = await gitAsync(["status", "--porcelain"], worktreePath);
  if (head.code !== 0 || clean.code !== 0 || clean.out) {
    return { ...result, status: "error", error: "Pre-PR sync requires a clean worktree and a valid HEAD" };
  }
  // Merge the resolved SHA rather than a ref another concurrent fetch might move.
  const merge = await gitAsync([
    "merge", "--no-edit", "-m", `Merge remote-tracking branch 'origin/${resolvedBase}' into ${branch}`, baseSha,
  ], worktreePath);
  if (merge.code === 0) {
    const pin = await gitAsync(["update-ref", baseRef(branch), baseSha], repo);
    if (pin.code !== 0) return { ...result, status: "error", error: `Could not update fork point: ${pin.err || pin.out}` };
    return { ...result, status: "merged", baseSha };
  }

  const unmerged = await gitAsync(["diff", "--name-only", "--diff-filter=U"], worktreePath);
  const conflictedFiles = unmerged.out.split("\n").filter(Boolean);
  const merging = await gitAsync(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], worktreePath);
  if (merging.code === 0) {
    const abort = await gitAsync(["merge", "--abort"], worktreePath);
    // We required a clean tree above: a failed abort can safely restore that exact
    // HEAD without discarding pre-existing agent edits. Never leave merge state.
    if (abort.code !== 0) await gitAsync(["reset", "--hard", head.out], worktreePath);
  }
  const afterHead = await gitAsync(["rev-parse", "HEAD"], worktreePath);
  const afterStatus = await gitAsync(["status", "--porcelain"], worktreePath);
  const afterMerge = await gitAsync(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], worktreePath);
  if (afterHead.code !== 0 || afterHead.out !== head.out || afterStatus.code !== 0 || afterStatus.out || afterMerge.code === 0) {
    return { ...result, status: "error", error: `Merge failed and cleanup could not restore the clean pre-merge HEAD: ${merge.err || merge.out}` };
  }
  if (unmerged.code === 0 && conflictedFiles.length) return { ...result, status: "conflict", conflictedFiles };
  return { ...result, status: "error", error: merge.err || merge.out || "git merge failed" };
}

/** Result of refreshing one project's supervisor snapshot (see `syncSnapshot`). */
export interface SnapshotSync {
  /** The snapshot worktree the supervisor should read. */
  path: string;
  /** What the snapshot tracks: `origin/<default>`, or `HEAD` for a repo without one. */
  ref: string;
  /** The commit now checked out in the snapshot. */
  sha: string;
  /** Whether the pre-sync fetch succeeded; false means the snapshot is at the
   * last-fetched remote commit (offline, auth failure, timeout) or there's no origin. */
  fetched: boolean;
}

/**
 * Refreshes the supervisor's read-only snapshot of a project: fetches the remote
 * default branch (same rules as `resolveStartPoint` — best-effort, time-boxed,
 * never prompting) and checks its tip out DETACHED into a Tack-owned worktree at
 * `snapshots/<sessionId>/<project>`. The supervisor reads this instead of the
 * user's checkout, which may be stale or on an unrelated branch — and the user's
 * checkout (its HEAD, index, and working tree) is never touched. A repo with no
 * usable origin snapshots its local HEAD. Re-syncing an existing snapshot moves it
 * in place, so the path the supervisor was given stays valid across follow-ups.
 *
 * Async throughout so several projects can sync concurrently without blocking the
 * supervisor MCP server.
 */
export async function syncSnapshot(repo: string, sessionId: string, project: string): Promise<SnapshotSync> {
  assertRepoRoot(repo);
  let ref = "HEAD";
  let sha: string | null = null;
  let fetched = false;
  const remoteRef = remoteDefaultBranch(repo);
  if (remoteRef) {
    const { args, env } = defaultBranchFetch(remoteRef);
    const f = await gitAsync(args, repo, { timeoutMs: FETCH_TIMEOUT_MS, env });
    fetched = f.code === 0 && !f.timedOut;
    sha = tryResolveCommit(repo, `refs/remotes/${remoteRef}`);
    if (sha) ref = remoteRef;
  }
  if (!sha) {
    const head = await gitAsync(["rev-parse", "--verify", "HEAD^{commit}"], repo);
    if (head.code !== 0 || !head.out) throw new Error(`cannot resolve HEAD in ${repo}: ${head.err || head.out}`);
    sha = head.out;
  }

  const root = sessionSnapshotsRoot(sessionId);
  const path = join(root, project);
  if (!existsSync(path)) {
    mkdirSync(root, { recursive: true });
    const r = await gitAsync(["worktree", "add", "--detach", path, sha], repo);
    if (r.code !== 0) throw new Error(`failed to create snapshot worktree at ${path}: ${r.err || r.out}`);
  } else {
    // --force: a snapshot is read-only by contract, so any stray modification in it
    // is discarded rather than allowed to block the refresh.
    const r = await gitAsync(["checkout", "--detach", "--force", sha], path);
    if (r.code !== 0) throw new Error(`failed to update snapshot worktree at ${path}: ${r.err || r.out}`);
  }
  return { path, ref, sha, fetched };
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
 * Taken against the pinned fork point (falling back to `wt.base` for legacy
 * worktrees) so it includes agent commits while excluding newly merged base work. */
export function worktreeDiff(wt: Worktree, runBase?: string): string {
  const base = runBase ?? readBaseRef(wt.repo, wt.branch) ?? wt.base;
  const r = spawnSync("git", ["diff", base], { cwd: wt.path, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

/** Repo-relative paths of new files not yet added (respecting .gitignore). They're
 * invisible to `git diff`, yet open_pr's commit would include them. */
export function untrackedFiles(worktreePath: string): string[] {
  const r = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktreePath, encoding: "utf8" });
  if (r.status !== 0) return [];
  return (r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * The repo-relative paths an agent's worktree changed since it forked — the basis for
 * cross-agent conflict prediction (a file two sibling agents both touch is a merge
 * collision waiting to happen). Compares the working tree (committed and uncommitted
 * edits) against the recorded fork point, matching `worktreeDiff`, plus untracked
 * files. Empty when the worktree or base is gone.
 */
export function changedFiles(repo: string, branch: string, worktreePath: string): string[] {
  const base = readBaseRef(repo, branch);
  if (!base || !existsSync(worktreePath)) return [];
  const r = spawnSync("git", ["diff", "--name-only", base], { cwd: worktreePath, encoding: "utf8" });
  if (r.status !== 0) return [];
  const tracked = (r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  // Untracked files collide just the same (most visible in a human's manual workspace).
  return [...new Set([...tracked, ...untrackedFiles(worktreePath)])];
}

/** Fail closed on stale/offline heads and divergence. Never reset or discard a
 * lineage's edits to make reuse possible. Async because the watcher owns this. */
export async function fastForwardPrWorktree(path: string, headBranch: string): Promise<{ base: string } | { reason: string }> {
  const status = await gitAsync(["status", "--porcelain"], path);
  if (status.code !== 0) return { reason: "worktree unavailable" };
  if (status.out) return { reason: "dirty worktree" };
  const fetch = await gitAsync(["fetch", "origin", `+refs/heads/${headBranch}:refs/remotes/origin/${headBranch}`], path,
    { timeoutMs: FETCH_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (fetch.code !== 0) return { reason: "remote head fetch failed" };
  const remote = `refs/remotes/origin/${headBranch}`;
  // merge --ff-only alone accepts a local branch ahead of the PR; such private
  // commits must not silently become part of the next fix.
  const ancestor = await gitAsync(["merge-base", "--is-ancestor", "HEAD", remote], path);
  if (ancestor.code !== 0) return { reason: "non-fast-forwardable head" };
  const merge = await gitAsync(["merge", "--ff-only", remote], path);
  if (merge.code !== 0) return { reason: "non-fast-forwardable head" };
  const head = await gitAsync(["rev-parse", "HEAD"], path);
  return head.code === 0 ? { base: head.out } : { reason: "worktree unavailable" };
}

/** Reviews inspect the author's LOCAL committed work, while retaining its diff baseline. */
export function createReviewWorktree(repo: string, sessionId: string, agentId: string,
  reviewedBranch: string, diffBase: string): Worktree {
  assertRepoRoot(repo);
  const root = sessionWorktreesRoot(sessionId);
  mkdirSync(root, { recursive: true });
  const path = join(root, agentId);
  const branch = `tack/${sessionId}/${agentId}`;
  const start = git(["rev-parse", "--verify", `refs/heads/${reviewedBranch}^{commit}`], repo);
  const base = git(["rev-parse", "--verify", `${diffBase}^{commit}`], repo);
  git(["worktree", "add", "--no-track", "-b", branch, path, start], repo);
  git(["update-ref", baseRef(branch), base], repo);
  return { repo, path, branch, base };
}

export function ensureReviewWorktree(repo: string, sessionId: string, agentId: string,
  reviewedBranch: string, diffBase: string): Worktree {
  return reuseWorktree(repo, sessionId, agentId) ?? createReviewWorktree(repo, sessionId, agentId, reviewedBranch, diffBase);
}

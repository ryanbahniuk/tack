import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TACK_HOME } from "../src/paths";
import { sessionSnapshotsRoot, syncSnapshot } from "../src/worktree/worktree";

// TACK_HOME is pointed at a scratch dir by the test preload (test/setup.ts); refuse
// to run against a real home rather than litter it with snapshot worktrees.
if (!TACK_HOME.startsWith(realpathSync(tmpdir())) && !TACK_HOME.startsWith(tmpdir()))
  throw new Error(`snapshot tests need a scratch TACK_HOME (got ${TACK_HOME}); run via \`bun test\``);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tack-snapshot-test-")));

// Commits made by the tests must not depend on the developer's git identity/config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Tack Test",
  GIT_AUTHOR_EMAIL: "tack@example.invalid",
  GIT_COMMITTER_NAME: "Tack Test",
  GIT_COMMITTER_EMAIL: "tack@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  // Ignore the global config too (commit signing, hooks, default branch, …).
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

/** Commits `file` with `content` in a working repo and returns the new sha. */
function commit(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(["add", file], repo);
  git(["commit", "--quiet", "-m", `write ${file}`], repo);
  return git(["rev-parse", "HEAD"], repo);
}

let n = 0;
/** A bare origin with an initial commit on `main`, a "project" clone of it, and a
 * separate "upstream" clone used to push new commits to origin after cloning. */
function makeProject(): { origin: string; project: string; upstream: string; initial: string } {
  const dir = join(scratch, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const origin = join(dir, "origin.git");
  git(["init", "--quiet", "--bare", "--initial-branch=main", origin], dir);
  const seed = join(dir, "seed");
  git(["init", "--quiet", "--initial-branch=main", seed], dir);
  const initial = commit(seed, "README.md", "initial\n");
  git(["remote", "add", "origin", origin], seed);
  git(["push", "--quiet", "origin", "main"], seed);
  const project = join(dir, "project");
  git(["clone", "--quiet", origin, project], dir);
  const upstream = join(dir, "upstream");
  git(["clone", "--quiet", origin, upstream], dir);
  return { origin, project, upstream, initial };
}

function pushCommit(upstream: string, file: string, content: string): string {
  const sha = commit(upstream, file, content);
  git(["push", "--quiet", "origin", "main"], upstream);
  return sha;
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  // The preload's home is shared with DB tests; only remove snapshots we own.
  for (const id of ["ses_a", "ses_b", "ses_c", "ses_d"]) {
    rmSync(sessionSnapshotsRoot(id), { recursive: true, force: true });
  }
});

describe("syncSnapshot", () => {
  test("snapshots the fresh origin tip without touching the user's checkout", async () => {
    const { project, upstream, initial } = makeProject();
    // The user has local, uncommitted work on a feature branch.
    git(["checkout", "--quiet", "-b", "feature"], project);
    writeFileSync(join(project, "README.md"), "local edit\n");
    const pushed = pushCommit(upstream, "new.txt", "from origin\n");

    const r = await syncSnapshot(project, "ses_a", "app");

    expect(r.path).toBe(join(sessionSnapshotsRoot("ses_a"), "app"));
    expect(r.ref).toBe("origin/main");
    expect(r.fetched).toBe(true);
    expect(r.sha).toBe(pushed);
    expect(git(["rev-parse", "HEAD"], r.path)).toBe(pushed);
    expect(readFileSync(join(r.path, "new.txt"), "utf8")).toBe("from origin\n");
    expect(readFileSync(join(r.path, "README.md"), "utf8")).toBe("initial\n");
    // Detached: the snapshot holds no branch of its own.
    expect(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: r.path }).status).not.toBe(0);

    // The user's checkout is exactly as they left it.
    expect(git(["rev-parse", "HEAD"], project)).toBe(initial);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], project)).toBe("feature");
    expect(readFileSync(join(project, "README.md"), "utf8")).toBe("local edit\n");
    expect(git(["status", "--porcelain"], project)).toBe("M README.md");
  });

  test("re-syncing moves the same snapshot path to the new origin tip", async () => {
    const { project, upstream } = makeProject();
    const first = await syncSnapshot(project, "ses_b", "app");
    const next = pushCommit(upstream, "second.txt", "two\n");

    const second = await syncSnapshot(project, "ses_b", "app");

    expect(second.path).toBe(first.path);
    expect(second.sha).toBe(next);
    expect(second.sha).not.toBe(first.sha);
    expect(git(["rev-parse", "HEAD"], second.path)).toBe(next);
    expect(readFileSync(join(second.path, "second.txt"), "utf8")).toBe("two\n");
  });

  test("a repo with no origin snapshots its local HEAD", async () => {
    const repo = join(scratch, "local-only");
    git(["init", "--quiet", "--initial-branch=main", repo], scratch);
    const head = commit(repo, "a.txt", "local\n");

    const r = await syncSnapshot(repo, "ses_c", "local");

    expect(r.ref).toBe("HEAD");
    expect(r.sha).toBe(head);
    expect(r.fetched).toBe(false);
    expect(git(["rev-parse", "HEAD"], r.path)).toBe(head);
  });

  test("an unreachable origin falls back to the last-fetched origin/main", async () => {
    const { project, initial } = makeProject();
    git(["remote", "set-url", "origin", join(scratch, "does-not-exist.git")], project);

    const r = await syncSnapshot(project, "ses_d", "app");

    expect(r.fetched).toBe(false);
    expect(r.ref).toBe("origin/main");
    expect(r.sha).toBe(initial);
    expect(git(["rev-parse", "HEAD"], r.path)).toBe(initial);
  });
});

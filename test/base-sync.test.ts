import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, syncBranchWithBase, worktreeBase, worktreeDiff } from "../src/worktree/worktree";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tack-base-sync-")));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
function commit(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(["add", file], repo);
  git(["commit", "--quiet", "-m", `write ${file}`], repo);
  return git(["rev-parse", "HEAD"], repo);
}
let n = 0;
function fixture() {
  const dir = join(scratch, `case-${++n}`);
  mkdirSync(dir);
  const origin = join(dir, "origin.git");
  git(["init", "--quiet", "--bare", "--initial-branch=main", origin], dir);
  const repo = join(dir, "project");
  git(["clone", "--quiet", origin, repo], dir);
  git(["config", "user.name", "Tack Test"], repo);
  git(["config", "user.email", "tack@example.invalid"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  git(["config", "core.hooksPath", "/dev/null"], repo);
  const base = commit(repo, "shared.txt", "initial\n");
  git(["push", "--quiet", "origin", "main"], repo);
  git(["remote", "set-head", "origin", "main"], repo);
  const branch = `tack/sync/agent-${n}`;
  const path = join(dir, "agent");
  // Minimal createWorktree equivalent keeps all artifacts inside this fixture,
  // including the real pinned fork ref used by both diff helpers.
  git(["worktree", "add", "--quiet", "-b", branch, path, base], repo);
  git(["update-ref", `refs/tack-base/${branch.slice(5)}`, base], repo);
  return { repo, branch, path, base };
}
function pushUpstream(repo: string, file = "upstream.txt", content = "upstream\n") {
  const sha = commit(repo, file, content);
  git(["push", "--quiet", "origin", "main"], repo);
  return sha;
}
function expectRestored(wt: ReturnType<typeof fixture>, head: string) {
  expect(git(["rev-parse", "HEAD"], wt.path)).toBe(head);
  expect(git(["status", "--porcelain"], wt.path)).toBe("");
  expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: wt.path }).status).not.toBe(0);
}
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("syncBranchWithBase", () => {
  test("already includes the remote base", async () => {
    const wt = fixture();
    const head = commit(wt.path, "agent.txt", "agent\n");
    expect(await syncBranchWithBase(wt.repo, wt.branch, wt.path)).toEqual({
      status: "up_to_date", base: "main", fetched: true,
    });
    expectRestored(wt, head);
    expect(await worktreeBase(wt.repo, wt.branch)).toBe(wt.base);
  });

  test("merges fresh upstream and moves the fork point so diffs contain only agent files", async () => {
    const wt = fixture();
    const agent = commit(wt.path, "agent.txt", "agent\n");
    const upstream = pushUpstream(wt.repo);
    expect(await syncBranchWithBase(wt.repo, wt.branch, wt.path)).toEqual({
      status: "merged", base: "main", fetched: true, baseSha: upstream,
    });
    expect(git(["show", "-s", "--format=%P", "HEAD"], wt.path)).toBe(`${agent} ${upstream}`);
    expect(git(["show", "-s", "--format=%s", "HEAD"], wt.path)).toBe(`Merge remote-tracking branch 'origin/main' into ${wt.branch}`);
    expect(await worktreeBase(wt.repo, wt.branch)).toBe(upstream);
    expect(changedFiles(wt.repo, wt.branch, wt.path)).toEqual(["agent.txt"]);
    const diff = worktreeDiff(wt);
    expect(diff).toContain("agent.txt");
    expect(diff).not.toContain("upstream.txt");
    expect(git(["status", "--porcelain"], wt.path)).toBe("");
  });

  test("aborts a real conflict and leaves HEAD and fork point unchanged", async () => {
    const wt = fixture();
    const head = commit(wt.path, "shared.txt", "agent\n");
    pushUpstream(wt.repo, "shared.txt", "upstream\n");
    expect(await syncBranchWithBase(wt.repo, wt.branch, wt.path)).toEqual({
      status: "conflict", base: "main", fetched: true, conflictedFiles: ["shared.txt"],
    });
    expectRestored(wt, head);
    expect(await worktreeBase(wt.repo, wt.branch)).toBe(wt.base);
  });

  test("merges the cached remote base when fetching an unreachable origin fails", async () => {
    const wt = fixture();
    commit(wt.path, "agent.txt", "agent\n");
    const upstream = pushUpstream(wt.repo);
    git(["remote", "set-url", "origin", join(scratch, "unreachable.git")], wt.repo);
    expect(await syncBranchWithBase(wt.repo, wt.branch, wt.path)).toEqual({
      status: "merged", base: "main", fetched: false, baseSha: upstream,
    });
    expect(await worktreeBase(wt.repo, wt.branch)).toBe(upstream);
    expect(changedFiles(wt.repo, wt.branch, wt.path)).toEqual(["agent.txt"]);
  });

  test("fetches an explicit non-default base even outside the configured fetch refspec", async () => {
    const wt = fixture();
    commit(wt.path, "agent.txt", "agent\n");
    git(["checkout", "--quiet", "-b", "release"], wt.repo);
    const upstream = commit(wt.repo, "release.txt", "release\n");
    git(["push", "--quiet", "origin", "release"], wt.repo);
    git(["update-ref", "-d", "refs/remotes/origin/release"], wt.repo);
    git(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"], wt.repo);
    expect(await syncBranchWithBase(wt.repo, wt.branch, wt.path, "release")).toEqual({
      status: "merged", base: "release", fetched: true, baseSha: upstream,
    });
    expect(changedFiles(wt.repo, wt.branch, wt.path)).toEqual(["agent.txt"]);
  });

  test("skips local-only repos without changing anything", async () => {
    const wt = fixture();
    git(["remote", "remove", "origin"], wt.repo);
    expect(await syncBranchWithBase(wt.repo, wt.branch, wt.path)).toEqual({
      status: "skipped", base: null, fetched: false,
    });
    expectRestored(wt, wt.base);
    expect(await worktreeBase(wt.repo, wt.branch)).toBe(wt.base);
    expect(await syncBranchWithBase(wt.repo, wt.branch, wt.path, "main")).toEqual({
      status: "skipped", base: "main", fetched: false,
    });
  });

  test("aborts non-conflict failures such as a rejecting merge hook", async () => {
    const wt = fixture();
    const head = commit(wt.path, "agent.txt", "agent\n");
    pushUpstream(wt.repo);
    const hooks = join(wt.repo, "hooks");
    mkdirSync(hooks);
    const hook = join(hooks, "pre-merge-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    git(["config", "core.hooksPath", hooks], wt.repo);
    const result = await syncBranchWithBase(wt.repo, wt.branch, wt.path);
    expect(result.status).toBe("error");
    expect(result.base).toBe("main");
    expect(result.fetched).toBe(true);
    if (result.status === "error") expect(result.error.length).toBeGreaterThan(0);
    expectRestored(wt, head);
    expect(await worktreeBase(wt.repo, wt.branch)).toBe(wt.base);
  });
});

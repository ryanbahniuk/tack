import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, createSession, type AgentRow, type SessionPrRow } from "../src/db";
import { resolveEditTarget, worktreeEditSummary } from "../src/session/edit";

const base = createAgent({ sessionId: createSession({}).id, projectName: "test" });
const agent = (overrides: Partial<AgentRow> = {}): AgentRow => ({
  ...base, id: "agt_one", status: "done", worktree_path: "/tree", branch: "manual-edits", ...overrides,
});
const exists = (path: string) => path === "/tree";

describe("resolveEditTarget", () => {
  test("auto-picks the only existing worktree", () => {
    const a = agent();
    expect(resolveEditTarget([agent({ worktree_path: null }), a], undefined, exists, {}))
      .toEqual({ ok: true, agent: a, path: "/tree" });
  });
  test("zero existing worktrees gives none", () => {
    expect(resolveEditTarget([], undefined, exists, {})).toMatchObject({ ok: false, reason: "none" });
    expect(resolveEditTarget([agent({ worktree_path: "/missing" })], undefined, exists, {}))
      .toMatchObject({ ok: false, reason: "none" });
  });
  test("several candidates require an explicit choice", () => {
    const agents = [agent(), agent({ id: "agt_two" })];
    expect(resolveEditTarget([...agents, agent({ worktree_path: null })], undefined, exists, {}))
      .toMatchObject({ ok: false, reason: "ambiguous", candidates: agents });
    expect(resolveEditTarget(agents, "agt_two", exists, {})).toEqual({ ok: true, agent: agents[1]!, path: "/tree" });
  });
  test("explicit ids must belong to this session", () => {
    expect(resolveEditTarget([agent()], "other", exists, {})).toMatchObject({ ok: false, reason: "not_found" });
  });
  test("explicit ids need a worktree on disk", () => {
    for (const worktree_path of [null, "/missing"]) {
      expect(resolveEditTarget([agent({ worktree_path })], "agt_one", exists, {}))
        .toMatchObject({ ok: false, reason: "no_worktree" });
    }
  });
  for (const status of ["pending", "running"] as const) {
    test(`${status} requires force for implicit and explicit selection`, () => {
      const a = agent({ status });
      for (const id of [undefined, a.id]) {
        expect(resolveEditTarget([a], id, exists, {})).toMatchObject({ ok: false, reason: "running" });
        expect(resolveEditTarget([a], id, exists, { force: true })).toEqual({ ok: true, agent: a, path: "/tree" });
      }
    });
  }
});

test("edit summary detects dirty and committed edits without committing or pushing", () => {
  const path = mkdtempSync(join(tmpdir(), "tack-edit-'"));
  const git = (...args: string[]) => execFileSync("git", ["-C", path, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "manual-edits");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
    const head = git("rev-parse", "HEAD");
    const a = agent({ worktree_path: path });
    const pr = { agent_id: a.id, state: "open", head_sha: head, head_branch: "manual-edits" } as SessionPrRow;
    expect(worktreeEditSummary(a, [pr], path)).toEqual(["Branch: manual-edits", "no uncommitted changes"]);
    writeFileSync(join(path, "manual.txt"), "edit");
    expect(worktreeEditSummary(a, [pr], path).join("\n")).toContain("push origin HEAD:manual-edits");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(worktreeEditSummary(a, [], path).at(-1)).toContain("open_pr commits leftover changes");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "manual edit");
    expect(worktreeEditSummary(a, [{ ...pr, state: "draft" }], path).join("\n")).toContain("push origin HEAD:manual-edits");
    expect(git("status", "--short")).toBe("");
  } finally { rmSync(path, { recursive: true, force: true }); }
});

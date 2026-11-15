import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../src/db/migrate";
import {
  PR_WATCH_MARKER,
  buildReplyBody,
  normalizeFeedback,
  type PrStatus,
  type ReviewThread,
} from "../src/projects/prs";
import { buildPrFixPrompt } from "../src/prwatch/prompt";
import {
  assignPrFeedback,
  createAgent,
  getAgent,
  insertPrFeedback,
  listAgentPrFeedback,
  listUnassignedPrFeedback,
  setAgentWorktree,
  createSession,
  getDb,
  listSessionPrs,
  markAgentPostFixed,
  setAgentStatus,
  setSessionPrWatchPid,
  setSessionStatus,
  upsertSessionPr,
  type AgentStatus,
} from "../src/db";
import { createWakeableSleep, postFix, triggerPrWatch, prFixBusy, prFixCapReached } from "../src/prwatch/watch";
import type { Project, TackConfig } from "../src/config/schema";

const PR_URL = "https://github.com/acme/app/pull/7";

function status(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "OPEN",
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefOid: "abc123",
    headRefName: "tack/pr/ses_1/x",
    url: PR_URL,
    title: "Add widgets",
    comments: [],
    reviews: [],
    ...over,
  };
}

function thread(isResolved: boolean, ids: number[], body = "please fix"): ReviewThread {
  return {
    isResolved,
    comments: {
      nodes: ids.map((id) => ({
        databaseId: id,
        author: { login: "alice" },
        body: `${body} ${id}`,
        path: "src/a.ts",
        line: 10,
        url: `${PR_URL}#discussion_r${id}`,
      })),
    },
  };
}

describe("normalizeFeedback", () => {
  test("includes unresolved thread comments and excludes resolved threads", () => {
    const items = normalizeFeedback(status(), [thread(false, [1, 2]), thread(true, [3])], []);
    expect(items.map((i) => i.sourceId)).toEqual(["1", "2"]);
    expect(items[0]).toMatchObject({ kind: "review_thread", path: "src/a.ts", line: 10, inReplyTo: "1" });
    // A reply inside a thread still targets the thread's root comment.
    expect(items[1]!.inReplyTo).toBe("1");
  });

  test("drops anything carrying the Tack marker", () => {
    const items = normalizeFeedback(
      status({
        comments: [
          { id: "IC_tack", author: { login: "me" }, body: `Fixed it.\n${PR_WATCH_MARKER}` },
          { id: "IC_human", author: { login: "bob" }, body: "Looks off" },
        ],
      }),
      [
        {
          isResolved: false,
          comments: {
            nodes: [
              { databaseId: 10, author: { login: "alice" }, body: "nit: rename" },
              { databaseId: 11, author: { login: "me" }, body: `Renamed.\n\n${PR_WATCH_MARKER}` },
            ],
          },
        },
      ],
      [],
    );
    expect(items.map((i) => i.sourceId)).toEqual(["10", "IC_human"]);
  });

  test("drops already-handled source ids", () => {
    const items = normalizeFeedback(
      status({
        comments: [
          { id: "IC_old", author: { login: "bob" }, body: "old" },
          { id: "IC_new", author: { login: "bob" }, body: "new" },
        ],
      }),
      [thread(false, [5, 6])],
      new Set(["5", "IC_old"]),
    );
    expect(items.map((i) => i.sourceId)).toEqual(["6", "IC_new"]);
  });

  test("includes bots and flags them", () => {
    const items = normalizeFeedback(
      status({
        comments: [{ id: "IC_bot", author: { login: "coderabbitai", is_bot: true }, body: "Consider X" }],
        reviews: [{ id: "PRR_bot", author: { login: "copilot-pull-request-reviewer[bot]" }, body: "Summary" }],
      }),
      [
        {
          isResolved: false,
          comments: { nodes: [{ databaseId: 9, author: { login: "lint", __typename: "Bot" }, body: "unused var" }] },
        },
      ],
      [],
    );
    expect(items.map((i) => [i.sourceId, i.isBot])).toEqual([
      ["9", true],
      ["PRR_bot", true],
      ["IC_bot", true],
    ]);
  });

  test("excludes reviews with empty bodies, keeps non-empty ones", () => {
    const items = normalizeFeedback(
      status({
        reviews: [
          { id: "PRR_empty", author: { login: "alice" }, body: "", state: "COMMENTED" },
          { id: "PRR_ws", author: { login: "alice" }, body: "   \n ", state: "COMMENTED" },
          { id: "PRR_null", author: { login: "alice" }, body: null, state: "APPROVED" },
          { id: "PRR_real", author: { login: "alice" }, body: "Please add tests", state: "CHANGES_REQUESTED" },
        ],
      }),
      [],
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceId: "PRR_real", kind: "review", author: "alice", url: PR_URL });
  });

  test("skips minimized conversation comments", () => {
    const items = normalizeFeedback(
      status({ comments: [{ id: "IC_hidden", author: { login: "x" }, body: "spam", isMinimized: true }] }),
      [],
      [],
    );
    expect(items).toEqual([]);
  });
});

describe("buildPrFixPrompt", () => {
  const pr = { number: 7, title: "Add widgets", url: PR_URL, head_branch: "tack/pr/ses_1/widgets" };
  const items = normalizeFeedback(
    status({ comments: [{ id: "IC_1", author: { login: "bob" }, body: "Rename `foo` to `bar`." }] }),
    [thread(false, [42], "Off by one")],
    [],
  );

  test("without a conflict: lists every item and the reporting rules, no merge step", () => {
    const p = buildPrFixPrompt({ pr, conflict: false, baseBranch: "main", items });
    expect(p).toContain("Add widgets");
    expect(p).toContain(PR_URL);
    expect(p).not.toContain("git merge");
    expect(p).toContain("sourceId `42`");
    expect(p).toContain("sourceId `IC_1`");
    expect(p).toContain("src/a.ts:10");
    expect(p).toContain("> Off by one 42");
    expect(p).toContain("relevant and justified");
    expect(p).toContain("report_pr_feedback");
    expect(p).toMatch(/NEVER push/);
    expect(p).toMatch(/`gh`/);
  });

  test("with a conflict: instructs a merge (not rebase) of the base branch", () => {
    const p = buildPrFixPrompt({ pr, conflict: true, baseBranch: "develop", items: [] });
    expect(p).toContain("git fetch origin develop && git merge origin/develop");
    expect(p).toMatch(/never rebase/i);
    expect(p).toContain("tests");
    // No feedback → no report_pr_feedback requirement.
    expect(p).not.toContain("report_pr_feedback");
  });

  test("conflict and feedback together", () => {
    const p = buildPrFixPrompt({ pr, conflict: true, baseBranch: "main", items });
    expect(p).toContain("git merge origin/main");
    expect(p).toContain("report_pr_feedback");
  });

  test("supervisor guidance: plain-text section right before the (unchanged, last) Rules", () => {
    const guidance = "The last run died on an unavailable model.\nAlso rename `foo` to `bar` in src/a.ts.";
    const p = buildPrFixPrompt({ pr, conflict: true, baseBranch: "main", items, guidance: `  ${guidance}\n` });
    const g = p.indexOf("## Supervisor guidance");
    const r = p.indexOf("## Rules");
    expect(g).toBeGreaterThan(p.indexOf("## Review feedback"));
    expect(r).toBeGreaterThan(g);
    // Trimmed and as-is (not markdown-quoted like review comments).
    expect(p.slice(g, r)).toContain(`\n\n${guidance}\n\n`);
    expect(p).not.toContain("> The last run died");
    const rules = p.slice(r);
    expect(rules).toMatch(/NEVER push/);
    expect(rules).toContain("report_pr_feedback");
    expect(rules).not.toContain("Supervisor guidance");
  });

  test("guidance alone sets the job line; blank guidance is ignored", () => {
    const p = buildPrFixPrompt({ pr, conflict: false, baseBranch: "main", items: [], guidance: "Add a CHANGELOG entry." });
    expect(p).toContain("Your job: follow the supervisor guidance below.");
    expect(p).toContain("## Supervisor guidance\n\nAdd a CHANGELOG entry.\n\n## Rules");
    expect(p).not.toContain("report_pr_feedback");

    const blank = buildPrFixPrompt({ pr, conflict: false, baseBranch: "main", items: [], guidance: "  \n " });
    expect(blank).not.toContain("Supervisor guidance");
    expect(blank).toContain("Your job: check the PR is in good shape.");
    expect(blank).toBe(buildPrFixPrompt({ pr, conflict: false, baseBranch: "main", items: [] }));
  });

  test("guidance alongside a conflict keeps the conflict as the job", () => {
    const p = buildPrFixPrompt({ pr, conflict: true, baseBranch: "main", items: [], guidance: "Prefer main's API." });
    expect(p).toContain("Your job: resolve a merge conflict with the base branch.");
    expect(p).toContain("Prefer main's API.");
  });
});

// These run against the scratch TACK_HOME DB that test/setup.ts points at.
describe("fix-run guards (prFixBusy / prFixCapReached)", () => {
  function freshPr(): string {
    const session = createSession({ title: "fix guards" });
    const url = `${PR_URL}/${session.id}`;
    upsertSessionPr({ sessionId: session.id, url, projectName: "app", number: 7, state: "open", headBranch: "b" });
    return listSessionPrs(session.id)[0]!.id;
  }
  function fixAgent(prId: string, status: AgentStatus, opts: { postFixed?: boolean } = {}) {
    const sessionId = (getDb().prepare(`SELECT session_id FROM session_prs WHERE id = ?`).get(prId) as {
      session_id: string;
    }).session_id;
    const a = createAgent({ sessionId, projectName: "app", kind: "pr_fix", sessionPrId: prId });
    if (status !== "pending") setAgentStatus(a.id, status);
    if (opts.postFixed) markAgentPostFixed(a.id);
    return a;
  }
  const config = (maxFixRunsPerDay: number) => ({ prWatch: { maxFixRunsPerDay } }) as unknown as TackConfig;

  test("busy while a fix is pending/running (alive or not) or finished but not post-fixed", () => {
    const pr = freshPr();
    expect(prFixBusy(pr)).toBe(false);

    const pending = fixAgent(pr, "pending"); // no pid: not alive, still busy
    expect(prFixBusy(pr)).toBe(true);
    setAgentStatus(pending.id, "running");
    expect(prFixBusy(pr)).toBe(true);
    setAgentStatus(pending.id, "done"); // finished, awaiting the watcher's push/replies
    expect(prFixBusy(pr)).toBe(true);
    markAgentPostFixed(pending.id);
    expect(prFixBusy(pr)).toBe(false);

    fixAgent(pr, "failed", { postFixed: true });
    fixAgent(pr, "stopped", { postFixed: true });
    expect(prFixBusy(pr)).toBe(false);
    fixAgent(pr, "failed");
    expect(prFixBusy(pr)).toBe(true);
  });

  test("a normal agent on the session never makes the PR busy", () => {
    const pr = freshPr();
    const sessionId = (getDb().prepare(`SELECT session_id FROM session_prs WHERE id = ?`).get(pr) as {
      session_id: string;
    }).session_id;
    createAgent({ sessionId, projectName: "app" });
    expect(prFixBusy(pr)).toBe(false);
  });

  test("cap counts fix runs in the last 24h, failures included", () => {
    const pr = freshPr();
    expect(prFixCapReached(pr, config(2))).toEqual({ reached: false, runs: 0 });
    fixAgent(pr, "failed", { postFixed: true });
    expect(prFixCapReached(pr, config(2))).toEqual({ reached: false, runs: 1 });
    const old = fixAgent(pr, "done", { postFixed: true });
    expect(prFixCapReached(pr, config(2))).toEqual({ reached: true, runs: 2 });

    // A run older than the rolling window no longer counts.
    getDb()
      .prepare(`UPDATE agents SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), old.id);
    expect(prFixCapReached(pr, config(2))).toEqual({ reached: false, runs: 1 });
    expect(prFixCapReached(pr, config(1))).toEqual({ reached: true, runs: 1 });
  });
});

describe("buildReplyBody", () => {
  test("always ends with the marker and quotes conversation comments", () => {
    const b = buildReplyBody({
      kind: "issue_comment",
      author: "bob",
      original: "Rename foo\nmore detail",
      reply: "Renamed.",
      fixSha: "abc1234",
    });
    expect(b.startsWith("@bob\n> Rename foo\n\nRenamed.")).toBe(true);
    expect(b).toContain("_— Tack (fix: abc1234)_");
    expect(b.endsWith(PR_WATCH_MARKER)).toBe(true);
  });

  test("thread replies are just the reply; bots are not @-mentioned", () => {
    expect(buildReplyBody({ kind: "review_thread", author: "a", original: "x", reply: "Done." })).toBe(
      `Done.\n\n_— Tack_\n${PR_WATCH_MARKER}`,
    );
    const bot = buildReplyBody({ kind: "review", author: "coderabbitai", isBot: true, original: "x", reply: "No." });
    expect(bot).not.toContain("@coderabbitai");
  });
});

describe("migration v6", () => {
  test("applies to a fresh in-memory DB with the PR-watch schema", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

    expect((db.prepare(`SELECT MAX(version) AS v FROM _migrations WHERE version <= 6`).get() as { v: number }).v).toBe(6);
    expect(cols("session_prs")).toEqual(expect.arrayContaining(["mergeable", "base_branch", "head_sha", "checked_at"]));
    expect(cols("sessions")).toContain("pr_watch_pid");
    expect(cols("agents")).toEqual(expect.arrayContaining(["kind", "session_pr_id", "post_fixed_at"]));
    expect(cols("pr_feedback")).toEqual(
      expect.arrayContaining([
        "id",
        "session_pr_id",
        "source_id",
        "source_kind",
        "author",
        "url",
        "path",
        "line",
        "body_ref",
        "fix_agent_id",
        "decision",
        "reply_ref",
        "reply_url",
        "created_at",
        "handled_at",
      ]),
    );

    // Defaults, uniqueness, and the cascade from session_prs.
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s', 'active', ?, ?)`).run(now, now);
    db.prepare(
      `INSERT INTO session_prs (id, session_id, url, created_at, updated_at) VALUES ('p', 's', 'u', ?, ?)`,
    ).run(now, now);
    const ins = db.prepare(
      `INSERT INTO pr_feedback (id, session_pr_id, source_id, source_kind, created_at) VALUES (?, 'p', ?, 'issue_comment', ?)`,
    );
    ins.run("f1", "IC_1", now);
    expect((db.prepare(`SELECT decision FROM pr_feedback WHERE id = 'f1'`).get() as { decision: string }).decision).toBe(
      "pending",
    );
    expect(() => ins.run("f2", "IC_1", now)).toThrow();
    db.prepare(`DELETE FROM session_prs WHERE id = 'p'`).run();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM pr_feedback`).get() as { n: number }).n).toBe(0);

    // Re-running is a no-op.
    migrate(db);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM _migrations WHERE version <= 6`).get() as { n: number }).n).toBe(6);
  });
});


describe("createWakeableSleep", () => {
  test("wake resolves an in-flight sleep early", async () => {
    const wait = createWakeableSleep();
    const sleeping = wait.sleep(60_000);
    wait.wake();
    await sleeping;
  });

  test("wakes before sleep coalesce into exactly one skipped wait", async () => {
    const wait = createWakeableSleep();
    wait.wake();
    wait.wake();
    await wait.sleep(60_000);
    let resolved = false;
    const next = wait.sleep(60_000).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    wait.wake();
    await next;
    expect(resolved).toBe(true);
  });

  test("a normal timeout resolves and leaves no pending wake", async () => {
    const wait = createWakeableSleep();
    let resolved = false;
    const sleeping = wait.sleep(5).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await sleeping;
    expect(resolved).toBe(true);
    const next = wait.sleep(60_000);
    wait.wake();
    await next;
  });
});

describe("triggerPrWatch", () => {
  const config = { prWatch: { enabled: true } } as TackConfig;
  function setup(state?: string, pid: number | null = null) {
    const session = createSession({ title: "trigger PR watch" });
    setSessionPrWatchPid(session.id, pid);
    if (state !== undefined) {
      upsertSessionPr({ sessionId: session.id, url: `${PR_URL}/${session.id}`, state, number: 7 });
    }
    const calls: string[] = [];
    const deps = {
      isAlive: (candidate: number | null | undefined) => candidate === 123,
      signal: (candidate: number) => { calls.push(`signal ${candidate}`); },
      spawn: (id: string, _config: TackConfig): number | null => {
        expect(id).toBe(session.id);
        calls.push("spawn");
        return 456;
      },
    };
    return { session, calls, deps };
  }

  test("disabled takes precedence over a missing session", () => {
    expect(triggerPrWatch("missing", { prWatch: { enabled: false } } as TackConfig)).toEqual({ kind: "disabled" });
  });

  test("inactive for missing or non-active sessions", () => {
    expect(triggerPrWatch("missing", config)).toEqual({ kind: "inactive" });
    const { session, calls, deps } = setup("open", 123);
    setSessionStatus(session.id, "archived");
    expect(triggerPrWatch(session.id, config, deps)).toEqual({ kind: "inactive" });
    expect(calls).toEqual([]);
  });

  test("no-open-prs for no PRs or only closed/merged PRs, even with a live watcher", () => {
    for (const state of [undefined, "closed", "merged"]) {
      const { session, calls, deps } = setup(state, 123);
      expect(triggerPrWatch(session.id, config, deps)).toEqual({ kind: "no-open-prs" });
      expect(calls).toEqual([]);
    }
  });

  test("starts a missing or dead watcher for open, draft, or unpolled PRs", () => {
    for (const [state, pid] of [["open", null], ["draft", 999], ["unknown", null]] as const) {
      const { session, calls, deps } = setup(state, pid);
      expect(triggerPrWatch(session.id, config, deps)).toEqual({ kind: "started", pid: 456 });
      expect(calls).toEqual(["spawn"]);
    }
  });

  test("signals a live watcher without spawning", () => {
    const { session, calls, deps } = setup("open", 123);
    expect(triggerPrWatch(session.id, config, deps)).toEqual({ kind: "signalled", pid: 123 });
    expect(calls).toEqual(["signal 123"]);
  });

  test("falls back to spawning when the watcher dies before signalling", () => {
    const { session, calls, deps } = setup("open", 123);
    deps.signal = () => { calls.push("signal failed"); throw new Error("ESRCH"); };
    expect(triggerPrWatch(session.id, config, deps)).toEqual({ kind: "started", pid: 456 });
    expect(calls).toEqual(["signal failed", "spawn"]);
  });

  test("signals a watcher that won a concurrent spawn", () => {
    const { session, calls, deps } = setup("open");
    deps.spawn = () => { setSessionPrWatchPid(session.id, 123); return null; };
    expect(triggerPrWatch(session.id, config, deps)).toEqual({ kind: "signalled", pid: 123 });
    expect(calls).toEqual(["signal 123"]);
  });
});


describe("postFix outcomes", () => {
  function setup(status: AgentStatus = "done") {
    const session = createSession({ title: "post-fix outcomes" });
    upsertSessionPr({ sessionId: session.id, url: `${PR_URL}/${session.id}`, number: 7, state: "open", headBranch: "pr" });
    const pr = listSessionPrs(session.id)[0]!;
    const a = createAgent({ sessionId: session.id, projectName: "app", kind: "pr_fix", sessionPrId: pr.id });
    setAgentStatus(a.id, status);
    const f = insertPrFeedback({ sessionPrId: pr.id, sourceId: "IC_1", sourceKind: "issue_comment" });
    assignPrFeedback([f.id], a.id);
    return { a: getAgent(a.id)!, pr };
  }
  const config = (autoPush = true) => ({ prWatch: { autoPush, reply: false } }) as TackConfig;
  const project = (path = "unused") => ({ path }) as Project;
  const log = (_message: string) => {};

  for (const status of ["stopped", "failed"] as const) {
    test(`${status} records the outcome and keeps feedback semantics`, async () => {
      const { a, pr } = setup(status);
      await postFix(a, pr, project(), config(), log);
      expect(getAgent(a.id)).toMatchObject({ status, fix_outcome: status, fix_pushed_sha: null });
      expect(getAgent(a.id)!.post_fixed_at).not.toBeNull();
      if (status === "stopped") expect(listUnassignedPrFeedback(pr.id)).toHaveLength(1);
      else expect(listAgentPrFeedback(a.id)[0]).toMatchObject({ decision: "failed", handled_at: expect.any(String) });
    });
  }

  for (const missing of ["worktree_path", "branch", "head_branch"] as const) {
    test(`missing ${missing} records no_changes`, async () => {
      const { a, pr } = setup();
      const candidate = { ...a, worktree_path: "unused", branch: "tack/fix" };
      const pullRequest = { ...pr };
      if (missing === "head_branch") pullRequest.head_branch = null;
      else candidate[missing] = null;
      await postFix(candidate, pullRequest, project(), config(), log);
      expect(getAgent(a.id)).toMatchObject({ fix_outcome: "no_changes", fix_pushed_sha: null, post_fixed_at: expect.any(String) });
    });
  }

  for (const outcome of ["pushed", "no_changes", "not_pushed", "push_rejected"] as const) {
    test(`${outcome} from local git post-fix`, async () => {
      const root = mkdtempSync(join(tmpdir(), "tack-post-fix-"));
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: root });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString().trim();
      };
      try {
        git("init", "--bare", "remote.git");
        git("init", "-b", "tack/fix", "repo");
        const repo = join(root, "repo");
        const local = (...args: string[]) => git("-C", repo, ...args);
        local("config", "user.name", "Test");
        local("config", "user.email", "test@example.com");
        local("config", "commit.gpgsign", "false");
        local("commit", "--allow-empty", "-m", "base");
        const base = local("rev-parse", "HEAD");
        local("update-ref", "refs/tack-base/fix", base);
        local("remote", "add", "origin", join(root, "remote.git"));
        local("push", "origin", "HEAD:refs/heads/pr");
        if (outcome === "push_rejected") {
          // Advance the remote along a divergent history; postFix must never force.
          local("commit", "--allow-empty", "-m", "remote advance");
          local("push", "origin", "HEAD:refs/heads/pr");
          local("reset", "--hard", base);
        }
        // Exercise the safety-net commit, not just already-committed work.
        if (outcome !== "no_changes") writeFileSync(join(repo, "fix.txt"), "fixed\n");
        const { a, pr } = setup();
        setAgentWorktree(a.id, repo, "tack/fix");
        await postFix(getAgent(a.id)!, pr, project(repo), config(outcome !== "not_pushed"), log);
        const result = getAgent(a.id)!;
        expect(result.status).toBe("done");
        expect(result.post_fixed_at).not.toBeNull();
        expect(result.fix_outcome).toBe(outcome);
        const head = local("rev-parse", "HEAD");
        expect(result.fix_pushed_sha).toBe(outcome === "pushed" ? head : null);
        if (outcome === "pushed") expect(git("--git-dir", "remote.git", "rev-parse", "refs/heads/pr")).toBe(head);
        if (outcome === "push_rejected") expect(listUnassignedPrFeedback(pr.id)).toHaveLength(1);
        // The outcome and timestamp are latched together and survive repeat completion.
        markAgentPostFixed(a.id, "failed");
        expect(getAgent(a.id)!.fix_outcome).toBe(outcome);
        expect(getAgent(a.id)!.post_fixed_at).toBe(result.post_fixed_at);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("v11 upgrades legacy agents with unknown outcomes", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      db.exec(`ALTER TABLE agents DROP COLUMN fix_outcome;
        ALTER TABLE agents DROP COLUMN fix_pushed_sha;
        DELETE FROM _migrations WHERE version = 11;
        INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s', 'active', 'then', 'then');
        INSERT INTO agents (id, session_id, project_name, status, post_fixed_at, created_at, updated_at)
          VALUES ('a', 's', 'app', 'done', 'then', 'then', 'then');`);
      migrate(db);
      expect(db.query("SELECT status, post_fixed_at, fix_outcome, fix_pushed_sha FROM agents").get()).toEqual({
        status: "done", post_fixed_at: "then", fix_outcome: null, fix_pushed_sha: null,
      });
      migrate(db);
    } finally {
      db.close();
    }
  });
});

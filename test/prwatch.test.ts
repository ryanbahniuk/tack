import { describe, expect, test } from "bun:test";
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

describe("migration v5", () => {
  test("applies to a fresh in-memory DB with the PR-watch schema", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

    expect((db.prepare(`SELECT MAX(version) AS v FROM _migrations`).get() as { v: number }).v).toBe(5);
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
    expect((db.prepare(`SELECT COUNT(*) AS n FROM _migrations`).get() as { n: number }).n).toBe(5);
  });
});

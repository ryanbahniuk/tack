import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../src/db/migrate";
import {
  PR_WATCH_MARKER,
  runtimeAttribution,
  buildReplyBody,
  buildConversationReplyBody,
  feedbackQuote,
  fetchPrStatus,
  isBotAuthor,
  isIgnoredAuthor,
  isSelfAuthor,
  ignoredAuthorsFor,
  isBotPrSummary,
  normalizeFeedback,
  type PrStatus,
  type ReviewThread,
} from "../src/projects/prs";
import { buildPrFixPrompt } from "../src/prwatch/prompt";
import {
  assignPrFeedback,
  recordPrFeedbackDecision,
  createAgent,
  countPrFixRunsSince,
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
  setSessionPrStatus,
  type SessionPrRow,
  setSessionStatus,
  upsertSessionPr,
  type AgentStatus,
  type PrFeedbackKind,
} from "../src/db";
import { createWakeableSleep, postFix, prFixCommitSubject, triggerPrWatch, prFixBusy, prFixCapReached } from "../src/prwatch/watch";
import * as prs from "../src/projects/prs";
import { writePrDescription, readPrDescription, readArtifact, writePrFeedbackArtifact } from "../src/artifacts/store";
import type { Project, RuntimeKind, TackConfig } from "../src/config/schema";

const CLAUDE_ATTRIBUTION = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

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

describe("ignored feedback authors", () => {
  test("matches exact logins without case or bot suffix differences", () => {
    for (const [login, ignored] of [["TFYouDoing[bot]", "tfyoudoing"], ["tfyoudoing", "TFYOUDOING[bot]"], ["alice", "ALICE"]]) {
      expect(isIgnoredAuthor(login, [ignored])).toBe(true);
    }
    expect(isIgnoredAuthor("alice-extra", ["alice"])).toBe(false);
    expect(isIgnoredAuthor("alice", [])).toBe(false);
  });
  test("combines global and project lists", () => {
    const project = { name: "app", path: "/app", description: "app", prWatch: { ignoreAuthors: ["project", "global"] } };
    expect(ignoredAuthorsFor({ prWatch: { ignoreAuthors: ["global"] } }, project)).toEqual(["global", "project"]);
    expect(ignoredAuthorsFor({ prWatch: { ignoreAuthors: [] } }, { name: "app", path: "/app", description: "app" })).toEqual([]);
  });
  test("isSelfAuthor matches the gh viewer without case or bot suffix differences", () => {
    expect(isSelfAuthor("Alice", "alice")).toBe(true);
    expect(isSelfAuthor("alice[bot]", "ALICE")).toBe(true);
    expect(isSelfAuthor("alice", "alice[bot]")).toBe(true);
  });
  test("isSelfAuthor is false for another user or an unknown viewer", () => {
    expect(isSelfAuthor("bob", "alice")).toBe(false);
    expect(isSelfAuthor("alice-extra", "alice")).toBe(false);
    expect(isSelfAuthor("alice", null)).toBe(false);
    expect(isSelfAuthor("alice", "")).toBe(false);
    expect(isSelfAuthor(null, "alice")).toBe(false);
  });
  test("filters every feedback kind while keeping another author's thread reply", () => {
    const t = thread(false, [1, 2]);
    t.comments!.nodes![0]!.author = { login: "noise[bot]" };
    const items = normalizeFeedback(status({
      comments: [{ id: "ignored-comment", author: { login: "noise" }, body: "fix" }, { id: "kept-comment", author: { login: "bob" }, body: "fix" }],
      reviews: [{ id: "ignored-review", author: { login: "NOISE" }, body: "fix" }, { id: "kept-review", author: { login: "bob" }, body: "fix" }],
    }), [t], [], ["noise"]);
    expect(items.map(item => item.sourceId)).toEqual(["2", "kept-review", "kept-comment"]);
    expect(items[0]!.inReplyTo).toBe("1");
  });
});

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

  test("skips bot PR summaries but keeps humans, threads and real bot feedback", () => {
    const cursorSummary = "<!-- CURSOR_SUMMARY\nmeta: 1\n-->\n\n### PR Summary\n\n**Medium Risk**\nAdds widgets.";
    const items = normalizeFeedback(
      status({
        comments: [
          { id: "IC_cursor", author: { login: "cursor[bot]" }, body: cursorSummary },
          { id: "IC_human", author: { login: "bob" }, body: cursorSummary },
          { id: "IC_bot_real", author: { login: "coderabbitai", is_bot: true }, body: "Consider X" },
        ],
        reviews: [
          { id: "PRR_rabbit", author: { login: "coderabbitai[bot]" }, body: "<!-- x -->\n## Summary by CodeRabbit\n- New widgets" },
          { id: "PRR_copilot", author: { login: "copilot-pull-request-reviewer" }, body: "## Pull request overview\nThis PR adds widgets." },
        ],
      }),
      [
        {
          isResolved: false,
          comments: { nodes: [{ databaseId: 9, author: { login: "cursor", __typename: "Bot" }, body: cursorSummary }] },
        },
      ],
      [],
    );
    expect(items.map((i) => i.sourceId)).toEqual(["9", "IC_human", "IC_bot_real"]);
  });

  test("isBotPrSummary matches known headings only for bot conversation items", () => {
    for (const body of ["PR Summary", "# pr summary", "## Walkthrough\nChanges", "**Pull request overview**"]) {
      expect(isBotPrSummary({ kind: "issue_comment", body, isBot: true })).toBe(true);
    }
    expect(isBotPrSummary({ kind: "issue_comment", body: "PR Summary", isBot: false })).toBe(false);
    expect(isBotPrSummary({ kind: "review_thread", body: "PR Summary", isBot: true })).toBe(false);
    expect(isBotPrSummary({ kind: "ci_check", body: "PR Summary", isBot: true })).toBe(false);
    expect(isBotPrSummary({ kind: "issue_comment", body: "Please fix the PR summary typo", isBot: true })).toBe(false);
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

  test("quotes an optional description before guidance and rules", () => {
    const plain = buildPrFixPrompt({ pr, conflict: false, baseBranch: "main", items: [] });
    expect(plain).not.toContain("## Current PR description");
    const prompt = buildPrFixPrompt({ pr, conflict: false, baseBranch: "main", items: [], description: "# Title\n\n- Details", guidance: "Update it." });
    expect(prompt).toContain("> # Title\n>\n> - Details");
    expect(prompt.indexOf("## Current PR description")).toBeLessThan(prompt.indexOf("## Supervisor guidance"));
    expect(prompt.indexOf("## Supervisor guidance")).toBeLessThan(prompt.indexOf("## Rules"));
    expect(prompt.slice(prompt.indexOf("## Rules"))).toContain("report_pr_description");
  });

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
  function fixAgent(prId: string, status: AgentStatus, opts: { postFixed?: boolean; origin?: "auto" | "supervisor" } = {}) {
    const sessionId = (getDb().prepare(`SELECT session_id FROM session_prs WHERE id = ?`).get(prId) as {
      session_id: string;
    }).session_id;
    const a = createAgent({ sessionId, projectName: "app", kind: "pr_fix", sessionPrId: prId, fixOrigin: opts.origin });
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

  test("supervisor fixes do not spend the automatic budget; legacy NULL origins still count", () => {
    const pr = freshPr();
    const legacy = fixAgent(pr, "failed", { postFixed: true });
    expect(legacy.fix_origin).toBeNull();
    const automatic = fixAgent(pr, "done", { postFixed: true, origin: "auto" });
    expect(automatic.fix_origin).toBe("auto");
    for (let i = 0; i < 3; i++) {
      const supervisor = fixAgent(pr, "done", { postFixed: true, origin: "supervisor" });
      expect(supervisor.fix_origin).toBe("supervisor");
    }
    expect(countPrFixRunsSince(pr, "2000-01-01T00:00:00.000Z")).toBe(2);
    expect(prFixCapReached(pr, config(3))).toEqual({ reached: false, runs: 2 });
    expect(prFixCapReached(pr, config(2))).toEqual({ reached: true, runs: 2 });
  });

  test("fix_pr spawns at the automatic cap and still enforces one fix at a time", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const configModule = await import("../src/config/load");
    const availability = await import("../src/runtimes/availability");
    const detached = await import("../src/agent/detached");
    const prs = await import("../src/projects/prs");
    const watch = await import("../src/prwatch/watch");
    const { approveSessionPlan } = await import("../src/db");
    const { runSupervisorServer } = await import("../src/mcp/supervisor-server");
    const prId = freshPr();
    const pr = getDb().query("SELECT session_id FROM session_prs WHERE id = ?").get(prId) as { session_id: string };
    approveSessionPlan(pr.session_id);
    fixAgent(prId, "failed", { postFixed: true, origin: "auto" });
    const model = { key: "test", name: "Test", runtime: "codex", id: "test" };
    const cfg = {
      projects: [{ name: "app", path: "/unused" }], models: [model], roles: { agent: ["test"] },
      prWatch: { enabled: true, autoPush: true, maxFixRunsPerDay: 1 },
    } as unknown as TackConfig;
    const spies = [
      spyOn(configModule, "loadConfig").mockResolvedValue(cfg),
      spyOn(availability, "checkModelOffered").mockReturnValue({ ok: true }),
      spyOn(detached, "spawnAgentRunner").mockReturnValue(123),
      spyOn(prs, "fetchPrStatus").mockResolvedValue(status()),
      spyOn(prs, "fetchReviewThreads").mockResolvedValue([]),
      spyOn(watch, "spawnPrWatcher").mockReturnValue(null),
      spyOn(McpServer.prototype, "connect").mockResolvedValue(),
    ];
    const register = spyOn(McpServer.prototype, "registerTool");
    try {
      await runSupervisorServer(pr.session_id);
      const call = register.mock.calls.find(([name]) => name === "fix_pr")!;
      const fix = call[2] as unknown as (args: { pr: number; prompt?: string; fresh?: boolean }) => Promise<{
        content: Array<{ text: string }>;
      }>;
      expect(prFixCapReached(prId, cfg)).toEqual({ reached: true, runs: 1 });
      const result = await fix({ pr: 7, prompt: "Please rename the widget", fresh: true });
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ continued: null, fallbackReason: "fresh requested" });
      const agent = getAgent(JSON.parse(result.content[0]!.text).agentId)!;
      expect(agent).toMatchObject({ kind: "pr_fix", session_pr_id: prId, fix_origin: "supervisor" });
      expect(readFileSync(agent.prompt_ref!, "utf8")).toContain("Please rename the widget");
      expect(prFixCapReached(prId, cfg)).toEqual({ reached: true, runs: 1 });
      await expect(fix({ pr: 7 })).rejects.toThrow("already running or awaiting its push/replies");
    } finally {
      register.mockRestore();
      for (const spy of spies.reverse()) spy.mockRestore();
    }
  });

  test("cap counts runs, not agent rows: reusing one fix agent still spends the budget", async () => {
    const detached = await import("../src/agent/detached");
    const worktrees = await import("../src/worktree/worktree");
    const { ConfigSchema } = await import("../src/config/schema");
    const { setAgentResumeRef, getSession, listPrFixAgents, listPrFixRuns } = await import("../src/db");
    const { spawnPrFixAgent } = await import("../src/prwatch/watch");
    const prId = freshPr();
    const sessionId = (getDb().prepare(`SELECT session_id FROM session_prs WHERE id = ?`).get(prId) as { session_id: string }).session_id;
    const model = { key: "test", id: "test", name: "Test", runtime: "codex", provider: "test", version: "1" } as const;
    const project = { name: "app", path: "/tmp", description: "Test" };
    const cfg = ConfigSchema.parse({ models: [model], projects: [project], roles: { agent: "test", supervisor: "test", summary: "test" } }) as unknown as TackConfig;
    cfg.roles = { agent: ["test"], supervisor: ["test"], summary: ["test"] };
    cfg.prWatch.maxFixRunsPerDay = 3;
    const spies = [
      spyOn(detached, "spawnAgentRunner").mockReturnValue(123),
      spyOn(worktrees, "fastForwardPrWorktree").mockResolvedValue({ base: "head" }),
    ];
    try {
      const opts = { origin: "auto", conflict: true, baseBranch: "main", title: "PR" } as const;
      const runs: string[] = [];
      for (let i = 0; i < 3; i++) {
        expect(prFixCapReached(prId, cfg)).toEqual({ reached: false, runs: i });
        const pr = listSessionPrs(sessionId)[0]!;
        const { agent, lineage } = await spawnPrFixAgent(getSession(sessionId)!, pr, project, cfg, opts);
        runs.push(lineage);
        setAgentWorktree(agent.id, "/tmp", "tack/fix");
        setAgentResumeRef(agent.id, `conversation-${i}`);
        setAgentStatus(agent.id, "done");
        markAgentPostFixed(agent.id, "pushed", `sha-${i}`);
      }
      expect(runs).toEqual(["fresh", "reused", "reused"]);
      const fixes = listPrFixAgents(prId);
      expect(fixes).toHaveLength(1);
      expect(listPrFixRuns(fixes[0]!.id).map((r) => r.pushed_sha)).toEqual(["sha-0", "sha-1", "sha-2"]);
      expect(prFixCapReached(prId, cfg)).toEqual({ reached: true, runs: 3 });
      // Supervisor runs on the reused row stay exempt.
      await spawnPrFixAgent(getSession(sessionId)!, listSessionPrs(sessionId)[0]!, project, cfg, { ...opts, origin: "supervisor" });
      expect(listPrFixAgents(prId)).toHaveLength(1);
      expect(countPrFixRunsSince(prId, "2000-01-01T00:00:00.000Z")).toBe(3);
      expect(listPrFixRuns(fixes[0]!.id)).toHaveLength(4);
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
    }
  });

  test("v19 backfills one run per existing fix agent and is idempotent", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      db.exec(`DROP TABLE pr_fix_runs; DELETE FROM _migrations WHERE version >= 19;
        INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s', 'active', 'then', 'then');
        INSERT INTO agents (id, session_id, project_name, status, kind, session_pr_id, fix_origin, post_fixed_at, fix_outcome, fix_pushed_sha, created_at, updated_at)
          VALUES ('f', 's', 'app', 'done', 'pr_fix', 'p', 'auto', 'later', 'pushed', 'sha', 'then', 'then'),
                 ('g', 's', 'app', 'running', 'pr_fix', 'p', NULL, NULL, NULL, NULL, 'now', 'now'),
                 ('w', 's', 'app', 'done', NULL, NULL, NULL, NULL, NULL, NULL, 'then', 'then');`);
      migrate(db);
      const rows = () => db.query("SELECT agent_id, session_pr_id, origin, created_at, finished_at, outcome, pushed_sha FROM pr_fix_runs ORDER BY agent_id").all();
      expect(rows()).toEqual([
        { agent_id: "f", session_pr_id: "p", origin: "auto", created_at: "then", finished_at: "later", outcome: "pushed", pushed_sha: "sha" },
        { agent_id: "g", session_pr_id: "p", origin: null, created_at: "now", finished_at: null, outcome: null, pushed_sha: null },
      ]);
      db.exec("DELETE FROM _migrations WHERE version >= 19");
      migrate(db);
      expect(rows()).toHaveLength(2);
    } finally {
      db.close();
    }
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
      .prepare(`UPDATE pr_fix_runs SET created_at = ? WHERE agent_id = ?`)
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), old.id);
    expect(prFixCapReached(pr, config(2))).toEqual({ reached: false, runs: 1 });
    expect(prFixCapReached(pr, config(1))).toEqual({ reached: true, runs: 1 });
  });
});

describe("conversation reply formatting", () => {
  test("recognizes GraphQL bots and known logins without gh bot metadata", () => {
    expect(isBotAuthor({ login: "custom-app", __typename: "Bot" })).toBe(true);
    for (const login of ["cursor", "coderabbitai", "copilot-pull-request-reviewer", "copilot",
      "github-actions", "dependabot", "sonarcloud", "codecov"]) {
      expect(isBotAuthor({ login: login.toUpperCase() })).toBe(true);
      expect(isBotAuthor({ login: `${login}[BoT]` })).toBe(true);
    }
    expect(isBotAuthor({ login: "alice", __typename: "User" })).toBe(false);
    expect(isBotAuthor(null)).toBe(false);
  });

  test("quotes the first visible line, skipping HTML metadata and heading markers", () => {
    expect(feedbackQuote("\n<!-- hidden\n# metadata\n-->\n<!-- more -->\n### Please fix\nDetails"))
      .toBe("Please fix");
    expect(feedbackQuote("<!-- inline --> ## Visible <!-- hidden --> title")).toBe("Visible  title");
    expect(feedbackQuote("<!-- nothing visible")).toBe("");
    expect(feedbackQuote("# " + "x".repeat(250))).toBe("x".repeat(200));
  });

  test("links each item, mentions humans once case-insensitively, and signs once", () => {
    const item = { url: `${PR_URL}#issuecomment-1`, author: "alice", original: "# Rename it", reply: "Done." };
    const body = buildConversationReplyBody([
      { ...item, fixSha: "abc1234" }, { ...item, author: "Alice" },
      { ...item, author: "cursor" }, { ...item, author: "custom-app", isBot: true },
    ], { runtime: "claude" });
    expect(body).toContain(`[Original feedback](${item.url}) — @alice`);
    expect(body).toContain("**Alice**");
    expect(body).toContain("> Rename it");
    expect(body).toContain("Fix: abc1234");
    expect(body.match(/@alice/gi)).toHaveLength(1);
    expect(body).toContain("**cursor**");
    expect(body).toContain("**custom-app**");
    expect(body).not.toContain("@cursor");
    expect(body).not.toContain("@custom-app");
    expect(body.split(CLAUDE_ATTRIBUTION)).toHaveLength(2);
    expect(body.split(PR_WATCH_MARKER)).toHaveLength(2);
    expect(body.endsWith(`\n\n${CLAUDE_ATTRIBUTION}\n${PR_WATCH_MARKER}`)).toBe(true);
  });
});

// Exercise the actual gh command arguments without GitHub access or module mocks.
async function withGh(
  fixture: { failPost?: boolean; viewer?: string } = {},
  check: (root: string, calls: () => string[][]) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tack-gh-"));
  const spawn = Bun.spawn;
  writeFileSync(join(root, "gh"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify(args) + "\\n");
const query = args.find(a => a.startsWith("query=")) || "";
let result;
if (args[0] === "api" && args[1] === "user") {
  const viewer = ${JSON.stringify(fixture.viewer ?? null)};
  if (!viewer) { console.error("not logged in"); process.exit(1); }
  console.log(viewer);
  process.exit(0);
}
if (args[0] === "repo") result = { owner: { login: "acme" }, name: "app" };
else if (args[0] === "pr") result = { state: "OPEN", url: ${JSON.stringify(PR_URL)} };
else if (args.includes("graphql")) {
  const comments = query.includes("comments(first:");
  if (!query.includes("author { login __typename }") || !query.includes("nodes { id ")) process.exit(2);
  if (comments && !query.includes("isMinimized")) process.exit(2);
  const next = args.includes("cursor=next");
  const nodes = comments
    ? (next ? [{ id: "IC_hidden", author: { login: "alice" }, body: "hidden", isMinimized: true }]
      : [{ id: "IC_existing", author: { login: "custom-app", __typename: "Bot" }, body: "Fix it", url: "comment-url" }])
    : [{ id: "PRR_existing", author: { login: "other-app", __typename: "Bot" }, body: "Review", url: "review-url" }];
  result = { data: { repository: { pullRequest: { [comments ? "comments" : "reviews"]:
    { nodes, pageInfo: { hasNextPage: comments && !next, endCursor: "next" } } } } } };
} else if (args.includes("POST")) {
  if (${JSON.stringify(fixture.failPost ?? false)}) { console.error("posting failed"); process.exit(1); }
  result = { html_url: "https://github.com/reply/" + (args.find(a => a.startsWith("repos/"))?.includes("/replies") ? "thread" : "batch") };
} else process.exit(2);
console.log(JSON.stringify(result));
`, { mode: 0o755 });
  // Bun caches executable lookups, so route gh to the fixture explicitly.
  const mock = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: Bun.SpawnOptions) =>
    spawn(cmd[0] === "gh" ? [join(root, "gh"), ...cmd.slice(1)] : cmd, options)
  ) as typeof Bun.spawn);
  try {
    await check(root, () => readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  } finally {
    mock.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("GraphQL conversation feedback", () => {
  test("fetches bot types, minimized state, stable ids, and all pages", async () => {
    await withGh({}, async (root, calls) => {
      const fetched = await fetchPrStatus(root, 7);
      expect(fetched.comments.map(c => c.id)).toEqual(["IC_existing", "IC_hidden"]);
      const feedback = normalizeFeedback(fetched, [], []);
      expect(feedback.map(f => [f.sourceId, f.isBot, f.url])).toEqual([
        ["PRR_existing", true, "review-url"], ["IC_existing", true, "comment-url"],
      ]);
      expect(normalizeFeedback(fetched, [], ["IC_existing", "PRR_existing"])).toEqual([]);
      expect(calls().filter(args => args.includes("graphql"))).toHaveLength(3);
    });
  });
});

describe("runtime attribution", () => {
  test("uses Claude Code's standard footer and leaves other runtimes unsigned", () => {
    expect(runtimeAttribution("claude")).toBe(CLAUDE_ATTRIBUTION);
    for (const runtime of ["codex", null, undefined, "unknown"] as const) {
      expect(runtimeAttribution(runtime as RuntimeKind | null | undefined)).toBe("");
    }
  });

  for (const runtime of ["claude", "codex", null, undefined] as const) {
    for (const fixSha of ["abc1234", undefined]) {
      test(`both reply formats end with the marker for ${runtime}, fix ${fixSha}`, () => {
        const item = { author: "alice", original: "Rename it", reply: "Done.\n\n", fixSha };
        const bodies = [
          buildReplyBody({ ...item, kind: "review_thread", runtime }),
          buildConversationReplyBody([{ ...item, url: PR_URL }], { runtime }),
        ];
        for (const body of bodies) {
          expect(body.endsWith(`\n${PR_WATCH_MARKER}`)).toBe(true);
          expect(body.split(PR_WATCH_MARKER)).toHaveLength(2);
          expect(body.includes(CLAUDE_ATTRIBUTION)).toBe(runtime === "claude");
          expect(body).not.toContain("\n\n\n");
          if (fixSha) expect(body).toContain(`Done.\n\nFix: ${fixSha}`);
          else expect(body).not.toContain("Fix:");
          if (runtime === "claude") {
            expect(body.endsWith(`\n\n${CLAUDE_ATTRIBUTION}\n${PR_WATCH_MARKER}`)).toBe(true);
          } else {
            expect(body.endsWith(`${fixSha ? `Fix: ${fixSha}` : "Done."}\n${PR_WATCH_MARKER}`)).toBe(true);
          }
        }
      });
    }
  }
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
    expect(b).toContain("Renamed.\n\nFix: abc1234");
    expect(b.endsWith(PR_WATCH_MARKER)).toBe(true);
  });

  test("thread replies are just the reply; bots are not @-mentioned", () => {
    expect(buildReplyBody({ kind: "review_thread", author: "a", original: "x", reply: "Done." })).toBe(
      `Done.\n${PR_WATCH_MARKER}`,
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
  const project = { name: "app", path: "/tmp", description: "Test" };
  const config = { prWatch: { enabled: true }, projects: [project] } as TackConfig;
  function setup(state?: string, pid: number | null = null) {
    const session = createSession({ title: "trigger PR watch" });
    setSessionPrWatchPid(session.id, pid);
    if (state !== undefined) {
      upsertSessionPr({ sessionId: session.id, url: `${PR_URL}/${session.id}`, state, number: 7, projectName: "app" });
    }
    const calls: string[] = [];
    const polls: string[] = [];
    const deps = {
      poll: async (pr: SessionPrRow, candidate: Project): Promise<unknown> => {
        expect(candidate).toEqual(project);
        polls.push(pr.id);
      },
      isAlive: (candidate: number | null | undefined) => candidate === 123,
      signal: (candidate: number) => { calls.push(`signal ${candidate}`); },
      spawn: (id: string, _config: TackConfig): number | null => {
        expect(id).toBe(session.id);
        calls.push("spawn");
        return 456;
      },
    };
    return { session, calls, deps, polls };
  }

  test("disabled takes precedence over a missing session", async () => {
    const { session, deps, polls, calls } = setup("open", 123);
    expect(await triggerPrWatch("missing", { prWatch: { enabled: false } } as TackConfig, deps)).toEqual({ kind: "disabled" });
    expect(await triggerPrWatch(session.id, { ...config, prWatch: { ...config.prWatch, enabled: false } }, deps)).toEqual({ kind: "disabled" });
    expect(polls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("inactive for missing or non-active sessions", async () => {
    expect(await triggerPrWatch("missing", config)).toEqual({ kind: "inactive" });
    const { session, calls, deps, polls } = setup("open", 123);
    setSessionStatus(session.id, "archived");
    expect(await triggerPrWatch(session.id, config, deps)).toEqual({ kind: "inactive" });
    expect(polls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("on-hold sessions remain watchable", async () => {
    const { session, calls, deps } = setup("open", 123);
    setSessionStatus(session.id, "on_hold");
    expect(await triggerPrWatch(session.id, config, deps)).toEqual({ kind: "signalled", pid: 123 });
    expect(calls).toEqual(["signal 123"]);
  });

  test("no-open-prs for no PRs or only closed/merged PRs, even with a live watcher", async () => {
    for (const state of [undefined, "closed", "merged"]) {
      const { session, calls, deps, polls } = setup(state, 123);
      expect(await triggerPrWatch(session.id, config, deps)).toEqual({ kind: "no-open-prs" });
      expect(polls).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  test("starts a missing or dead watcher for open, draft, or unpolled PRs", async () => {
    for (const [state, pid] of [["open", null], ["draft", 999], ["unknown", null]] as const) {
      const { session, calls, deps, polls } = setup(state, pid);
      expect(await triggerPrWatch(session.id, config, deps)).toEqual({ kind: "started", pid: 456 });
      expect(calls).toEqual(["spawn"]);
      expect(polls).toEqual([listSessionPrs(session.id)[0]!.id]);
    }
  });

  test("prId polls only that PR, and an unwatchable target is no-open-prs", async () => {
    const { session, calls, deps, polls } = setup("open", 123);
    upsertSessionPr({ sessionId: session.id, url: `${PR_URL}/${session.id}/2`, state: "open", number: 8, projectName: "app" });
    upsertSessionPr({ sessionId: session.id, url: `${PR_URL}/${session.id}/3`, state: "merged", number: 9, projectName: "app" });
    const [first, second, merged] = listSessionPrs(session.id).sort((a, b) => a.number! - b.number!);
    expect(await triggerPrWatch(session.id, config, deps, { prId: second!.id })).toEqual({ kind: "signalled", pid: 123 });
    expect(polls).toEqual([second!.id]);
    expect(polls).not.toContain(first!.id);
    expect(calls).toEqual(["signal 123"]);
    for (const prId of [merged!.id, "missing"]) {
      polls.length = 0; calls.length = 0;
      expect(await triggerPrWatch(session.id, config, deps, { prId })).toEqual({ kind: "no-open-prs" });
      expect(polls).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  test("signals a live watcher without spawning", async () => {
    const { session, calls, deps } = setup("open", 123);
    expect(await triggerPrWatch(session.id, config, deps)).toEqual({ kind: "signalled", pid: 123 });
    expect(calls).toEqual(["signal 123"]);
  });

  test("falls back to spawning when the watcher dies before signalling", async () => {
    const { session, calls, deps } = setup("open", 123);
    deps.signal = () => { calls.push("signal failed"); throw new Error("ESRCH"); };
    expect(await triggerPrWatch(session.id, config, deps)).toEqual({ kind: "started", pid: 456 });
    expect(calls).toEqual(["signal failed", "spawn"]);
  });

  test("signals a watcher that won a concurrent spawn", async () => {
    const { session, calls, deps } = setup("open");
    deps.spawn = () => { setSessionPrWatchPid(session.id, 123); return null; };
    expect(await triggerPrWatch(session.id, config, deps)).toEqual({ kind: "signalled", pid: 123 });
    expect(calls).toEqual(["signal 123"]);
  });

  for (const state of ["merged", "closed"]) {
    for (const pid of [null, 123]) {
      test(`refreshes stored open to ${state} without waking watcher ${pid}`, async () => {
        const { session, calls, deps } = setup("open", pid);
        deps.poll = async (pr) => { setSessionPrStatus(pr.id, { state }); };
        expect(await triggerPrWatch(session.id, config, deps)).toEqual({ kind: "no-open-prs" });
        expect(calls).toEqual([]);
        expect(listSessionPrs(session.id)[0]!.state).toBe(state);
      });
    }
  }

  for (const pid of [null, 123]) {
    test(`poll failures preserve watchable state with watcher ${pid}`, async () => {
      const { session, calls, deps } = setup("open", pid);
      deps.poll = async () => { throw new Error("GitHub unavailable"); };
      expect(await triggerPrWatch(session.id, config, deps)).toEqual(
        pid ? { kind: "signalled", pid } : { kind: "started", pid: 456 },
      );
      expect(calls).toEqual([pid ? "signal 123" : "spawn"]);
      expect(listSessionPrs(session.id)[0]!.state).toBe("open");
    });

    test(`mixed merged/open results still wake watcher ${pid}`, async () => {
      const { session, calls, deps, polls } = setup("open", pid);
      upsertSessionPr({ sessionId: session.id, url: `${PR_URL}/${session.id}/8`, number: 8, state: "open", projectName: "app" });
      deps.poll = async (pr) => {
        polls.push(pr.id);
        if (pr.number === 7) setSessionPrStatus(pr.id, { state: "merged" });
      };
      expect(await triggerPrWatch(session.id, config, deps)).toEqual(
        pid ? { kind: "signalled", pid } : { kind: "started", pid: 456 },
      );
      expect(calls).toEqual([pid ? "signal 123" : "spawn"]);
      expect(polls).toHaveLength(2);
      expect(listSessionPrs(session.id).map(pr => pr.state).sort()).toEqual(["merged", "open"]);
    });
  }

  test("skips polling PRs without a number or configured project", async () => {
    const { session, deps, polls } = setup();
    upsertSessionPr({ sessionId: session.id, url: `${PR_URL}/no-number`, state: "open", projectName: "app" });
    upsertSessionPr({ sessionId: session.id, url: `${PR_URL}/no-project`, state: "open", number: 8, projectName: "missing" });
    expect(await triggerPrWatch(session.id, config, deps)).toEqual({ kind: "started", pid: 456 });
    expect(polls).toEqual([]);
  });
});


describe("postFix replies", () => {
  type ReplyEntry = { id: string; kind: PrFeedbackKind; author?: string; bot?: boolean; decision: "fixed" | "declined" | "not_applicable" | "pending"; reply?: string };

  async function runReplies(root: string, reply = true, single = false, runtime?: RuntimeKind | null, notApplicable = false) {
    const entries = [
      { id: "IC_1", kind: "issue_comment", author: "cursor", decision: "fixed", reply: "Fixed cursor feedback." },
      ...(!single ? [
        { id: "PRR_1", kind: "review", author: "alice", decision: "declined", reply: "Keeping this." },
        { id: "10", kind: "review_thread", author: "alice", decision: "fixed", reply: "Fixed inline." },
        { id: "IC_empty", kind: "issue_comment", decision: "declined", reply: "  \n" },
        { id: "IC_pending", kind: "issue_comment", decision: "pending", reply: "not reported" },
        { id: "IC_unreported", kind: "issue_comment", decision: "fixed" },
      ] : []),
      ...(notApplicable ? [
        { id: "IC_bot_na", kind: "issue_comment", author: "cursor", bot: true, decision: "not_applicable", reply: "Bot summary, nothing to do." },
        { id: "11", kind: "review_thread", author: "lint", bot: true, decision: "not_applicable", reply: "Bot thread, nothing to do." },
        { id: "IC_human_na", kind: "issue_comment", author: "bob", decision: "not_applicable", reply: "Human question answered." },
      ] : []),
    ] as const;
    return postEntries(root, entries, reply, runtime);
  }

  async function postEntries(root: string, entries: readonly ReplyEntry[], reply = true, runtime?: RuntimeKind | null) {
    const session = createSession({ title: "post-fix replies" });
    upsertSessionPr({ sessionId: session.id, url: `${PR_URL}/${session.id}`, number: 7, state: "open" });
    const pr = listSessionPrs(session.id)[0]!;
    const a = createAgent({ sessionId: session.id, projectName: "app", kind: "pr_fix", sessionPrId: pr.id, runtime });
    setAgentStatus(a.id, "done");
    for (const entry of entries) {
      const f = insertPrFeedback({
        sessionPrId: pr.id, sourceId: entry.id, sourceKind: entry.kind,
        author: entry.author ?? "alice", url: `${PR_URL}#${entry.id}`,
        authorIsBot: !!entry.bot,
        inReplyTo: entry.kind === "review_thread" ? "10" : null,
        bodyRef: writePrFeedbackArtifact(session.id, pr.id, entry.id, "body", "<!-- meta -->\n### Please fix"),
      });
      assignPrFeedback([f.id], a.id);
      if (entry.decision !== "pending") recordPrFeedbackDecision(f.id, entry.decision,
        entry.reply !== undefined ? writePrFeedbackArtifact(session.id, pr.id, entry.id, "reply", entry.reply) : null);
    }
    const logs: string[] = [];
    await postFix(getAgent(a.id)!, pr, { path: root } as Project,
      { prWatch: { autoPush: false, reply } } as TackConfig, message => { logs.push(message); });
    return { a, rows: listAgentPrFeedback(a.id), logs, pr };
  }

  test("batches conversation answers into one post and keeps inline replies threaded", async () => {
    await withGh({}, async (root, calls) => {
      const { rows, a, pr } = await runReplies(root);
      const posts = calls().filter(args => args.includes("POST"));
      expect(posts).toHaveLength(2);
      expect(posts[0]).toContain("repos/acme/app/pulls/7/comments/10/replies");
      expect(posts[0]).toContain(`body=Fixed inline.\n${PR_WATCH_MARKER}`);
      expect(posts[1]).toContain("repos/acme/app/issues/7/comments");
      const body = posts[1]!.find(a => a.startsWith("body="))!;
      expect(body).toContain(`[Original feedback](${PR_URL}#IC_1) — **cursor**`);
      expect(body).toContain("@alice");
      expect(body).not.toContain("@cursor");
      expect(body).toContain("> Please fix");
      expect(body).toContain("Fixed cursor feedback.");
      expect(body).toContain("Keeping this.");
      for (const id of ["IC_1", "PRR_1"]) expect(rows.find(f => f.source_id === id)?.reply_url).toBe("https://github.com/reply/batch");
      expect(rows.find(f => f.source_id === "10")?.reply_url).toBe("https://github.com/reply/thread");
      for (const id of ["IC_empty", "IC_pending", "IC_unreported"]) expect(rows.find(f => f.source_id === id)?.reply_url).toBeNull();
      expect(rows.every(f => f.handled_at)).toBe(true);
      expect(rows.find(f => f.source_id === "IC_pending")?.decision).toBe("declined");
      await postFix(getAgent(a.id)!, pr, { path: root } as Project,
        { prWatch: { reply: true } } as TackConfig, () => {});
      expect(calls().filter(args => args.includes("POST"))).toHaveLength(2);
    });
  });

  for (const runtime of ["claude", "codex", null] as const) {
    test(`passes the fix agent's runtime (${runtime}) to both reply formats`, async () => {
      await withGh({}, async (root, calls) => {
        await runReplies(root, true, false, runtime);
        const bodies = calls().filter(args => args.includes("POST"))
          .map(args => args.find(arg => arg.startsWith("body="))!);
        expect(bodies).toHaveLength(2);
        for (const body of bodies) {
          expect(body.includes(CLAUDE_ATTRIBUTION)).toBe(runtime === "claude");
          expect(body.endsWith(PR_WATCH_MARKER)).toBe(true);
        }
      });
    });
  }

  test("bot not_applicable items are handled silently; human ones still get replies", async () => {
    await withGh({}, async (root, calls) => {
      const { rows } = await runReplies(root, true, true, null, true);
      const bodies = calls().filter(args => args.includes("POST"))
        .map(args => args.find(arg => arg.startsWith("body="))!);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain("Human question answered.");
      expect(bodies[0]).not.toContain("Bot summary");
      expect(bodies[0]).not.toContain("Bot thread");
      for (const id of ["IC_bot_na", "11"]) {
        const row = rows.find(f => f.source_id === id)!;
        // Still an explicit verdict for draft promotion: handled, decided, reply_ref kept.
        expect(row).toMatchObject({ decision: "not_applicable", reply_url: null });
        expect(row.handled_at).toBeTruthy();
        expect(row.reply_ref).toBeTruthy();
      }
      expect(rows.find(f => f.source_id === "IC_human_na")?.reply_url).toBe("https://github.com/reply/batch");
    });
  });

  test("uses the same linked format for a single conversation item", async () => {
    await withGh({}, async (root, calls) => {
      await runReplies(root, true, true);
      const posts = calls().filter(args => args.includes("POST"));
      expect(posts).toHaveLength(1);
      expect(posts[0]!.find(a => a.startsWith("body="))).toContain(`[Original feedback](${PR_URL}#IC_1)`);
    });
  });

  test("failed posts are logged and all items are handled without retry", async () => {
    await withGh({ failPost: true }, async (root) => {
      const { rows, logs } = await runReplies(root);
      expect(rows.every(f => f.handled_at && f.reply_url === null)).toBe(true);
      expect(logs.some(l => l.includes("conversation reply failed"))).toBe(true);
      expect(logs.some(l => l.includes("reply to 10 failed"))).toBe(true);
    });
  });

  test("self-authored review thread is handled silently with its verdict kept", async () => {
    await withGh({ viewer: "Me" }, async (root, calls) => {
      const { rows } = await postEntries(root, [
        { id: "10", kind: "review_thread", author: "me", decision: "fixed", reply: "Fixed inline." },
      ]);
      expect(calls().filter(args => args.includes("POST"))).toEqual([]);
      expect(rows[0]).toMatchObject({ decision: "fixed", reply_url: null });
      expect(rows[0]!.handled_at).toBeTruthy();
      expect(rows[0]!.reply_ref).toBeTruthy();
    });
  });

  test("mixed batch replies only to other authors and leaves self items out of the conversation post", async () => {
    await withGh({ viewer: "me" }, async (root, calls) => {
      const { rows } = await postEntries(root, [
        { id: "10", kind: "review_thread", author: "me", decision: "fixed", reply: "Self inline." },
        { id: "11", kind: "review_thread", author: "bob", decision: "fixed", reply: "Bob inline." },
        { id: "IC_self", kind: "issue_comment", author: "ME", decision: "fixed", reply: "Self conversation." },
        { id: "PRR_bob", kind: "review", author: "bob", decision: "declined", reply: "Bob conversation." },
      ]);
      const bodies = calls().filter(args => args.includes("POST")).map(args => args.find(arg => arg.startsWith("body="))!);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toContain("Bob inline.");
      expect(bodies[1]).toContain("Bob conversation.");
      expect(bodies.join("\n")).not.toContain("Self");
      expect(bodies[1]).not.toContain("@me");
      for (const id of ["10", "IC_self"]) expect(rows.find(f => f.source_id === id)?.reply_url).toBeNull();
      expect(rows.find(f => f.source_id === "11")?.reply_url).toBe("https://github.com/reply/thread");
      expect(rows.find(f => f.source_id === "PRR_bob")?.reply_url).toBe("https://github.com/reply/batch");
      expect(rows.every(f => f.handled_at)).toBe(true);
    });
  });

  test("skips the conversation post entirely when every conversation item is self-authored", async () => {
    await withGh({ viewer: "me" }, async (root, calls) => {
      await postEntries(root, [{ id: "IC_self", kind: "issue_comment", author: "me", decision: "fixed", reply: "Self." }]);
      expect(calls().filter(args => args.includes("POST"))).toEqual([]);
    });
  });

  test("viewer lookup failure falls back to replying to everyone", async () => {
    await withGh({}, async (root, calls) => {
      const { rows } = await postEntries(root, [
        { id: "10", kind: "review_thread", author: "me", decision: "fixed", reply: "Self inline." },
        { id: "IC_self", kind: "issue_comment", author: "me", decision: "fixed", reply: "Self conversation." },
      ]);
      expect(calls().some(args => args[0] === "api" && args[1] === "user")).toBe(true);
      expect(calls().filter(args => args.includes("POST"))).toHaveLength(2);
      expect(rows.every(f => f.reply_url)).toBe(true);
    });
  });

  test("reply=false handles items without calling gh", async () => {
    await withGh({}, async (root) => {
      const { rows } = await runReplies(root, false);
      expect(rows.every(f => f.handled_at && f.reply_url === null)).toBe(true);
      expect(() => readFileSync(join(root, "calls"))).toThrow();
    });
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

  for (const scenario of ["update", "edited", "applied", "failure"] as const) {
    test(`description ${scenario} preserves replies and clears the proposal`, async () => {
      const { a, pr } = setup();
      writePrDescription(pr.session_id, a.id, "base", "Old\r\nbody");
      writePrDescription(pr.session_id, a.id, "proposed", "New body");
      const f = listAgentPrFeedback(a.id)[0]!;
      recordPrFeedbackDecision(f.id, "fixed", writePrFeedbackArtifact(pr.session_id, pr.id, f.source_id, "reply", "Done"));
      const fetch = spyOn(prs, "fetchPrBody");
      if (scenario === "failure") fetch.mockRejectedValue(new Error("offline"));
      else fetch.mockResolvedValue(scenario === "edited" ? "Human edit" : scenario === "applied" ? " New body " : "Old\nbody");
      const update = spyOn(prs, "updatePrBody").mockResolvedValue();
      const reply = spyOn(prs, "postIssueComment").mockResolvedValue(null);
      const logs: string[] = [];
      try {
        await postFix(a, pr, project(), { prWatch: { autoPush: true, reply: true } } as TackConfig, message => logs.push(message));
        expect(update.mock.calls.length).toBe(scenario === "update" ? 1 : 0);
        expect(reply).toHaveBeenCalled();
        if (scenario === "edited") expect(logs.join("\n")).toContain("skipped description update (edited on GitHub during the run)");
        if (scenario === "failure") expect(logs.join("\n")).toContain("description update failed: offline");
        expect(readPrDescription(pr.session_id, a.id, "proposed")).toBe("");
        const stored = listSessionPrs(pr.session_id)[0]!;
        expect(readArtifact(stored.body_ref)).toBe(scenario === "update" || scenario === "applied" ? "New body" : "");
      } finally { fetch.mockRestore(); update.mockRestore(); reply.mockRestore(); }
    });
  }

  for (const status of ["stopped", "failed"] as const) {
    test(`${status} records the outcome and keeps feedback semantics`, async () => {
      const { a, pr } = setup(status);
      writePrDescription(pr.session_id, a.id, "proposed", "stale");
      await postFix(a, pr, project(), config(), log);
      expect(readPrDescription(pr.session_id, a.id, "proposed")).toBe("");
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
        writePrDescription(pr.session_id, a.id, "base", "old");
        writePrDescription(pr.session_id, a.id, "proposed", "new");
        const fetch = spyOn(prs, "fetchPrBody").mockResolvedValue("old");
        const update = spyOn(prs, "updatePrBody").mockResolvedValue();
        await postFix(getAgent(a.id)!, pr, project(repo), config(outcome !== "not_pushed"), log);
        expect(fetch.mock.calls.length).toBe(outcome === "pushed" || outcome === "no_changes" ? 1 : 0);
        expect(readPrDescription(pr.session_id, a.id, "proposed")).toBe("");
        fetch.mockRestore(); update.mockRestore();
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
        ALTER TABLE agents DROP COLUMN fix_origin;
        ALTER TABLE agents DROP COLUMN continues_agent_id;
        ALTER TABLE agents DROP COLUMN continuation_prompt_ref; ALTER TABLE agents DROP COLUMN continuation_started_at;
        ALTER TABLE agents DROP COLUMN diff_base;
        ALTER TABLE sessions DROP COLUMN pr_fix_enabled; ALTER TABLE sessions DROP COLUMN supervisor_config_version; ALTER TABLE sessions DROP COLUMN pr_watch_config_version; ALTER TABLE agents DROP COLUMN persona; ALTER TABLE agents DROP COLUMN reviews_agent_id; ALTER TABLE agents DROP COLUMN review_ref; ALTER TABLE session_prs DROP COLUMN ready_promoted_at; ALTER TABLE sessions DROP COLUMN summary_ref; ALTER TABLE sessions DROP COLUMN summary_at; ALTER TABLE session_prs DROP COLUMN body_ref; DELETE FROM _migrations WHERE version >= 11;
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


test("v25 defaults per-PR auto-fix on for existing PRs and is idempotent", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    db.exec(`ALTER TABLE session_prs DROP COLUMN pr_fix_enabled; DELETE FROM _migrations WHERE version >= 25;
      INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s', 'active', 'then', 'then');
      INSERT INTO session_prs (id, session_id, url, created_at, updated_at) VALUES ('p', 's', 'u', 'then', 'then');`);
    migrate(db);
    expect(db.query("SELECT pr_fix_enabled FROM session_prs").get()).toEqual({ pr_fix_enabled: 1 });
    db.exec(`INSERT INTO session_prs (id, session_id, url, created_at, updated_at) VALUES ('q', 's', 'v', 'now', 'now')`);
    expect(db.query("SELECT pr_fix_enabled FROM session_prs WHERE id = 'q'").get()).toEqual({ pr_fix_enabled: 1 });
    db.exec("DELETE FROM _migrations WHERE version >= 25");
    migrate(db);
  } finally {
    db.close();
  }
});

test("v12 adds nullable fix_origin to legacy agents and is idempotent", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    db.exec(`ALTER TABLE agents DROP COLUMN fix_origin;
        ALTER TABLE agents DROP COLUMN continues_agent_id;
        ALTER TABLE agents DROP COLUMN continuation_prompt_ref; ALTER TABLE agents DROP COLUMN continuation_started_at;
        ALTER TABLE agents DROP COLUMN diff_base;
      ALTER TABLE sessions DROP COLUMN pr_fix_enabled; ALTER TABLE sessions DROP COLUMN supervisor_config_version; ALTER TABLE sessions DROP COLUMN pr_watch_config_version; ALTER TABLE agents DROP COLUMN persona; ALTER TABLE agents DROP COLUMN reviews_agent_id; ALTER TABLE agents DROP COLUMN review_ref; ALTER TABLE session_prs DROP COLUMN ready_promoted_at; ALTER TABLE sessions DROP COLUMN summary_ref; ALTER TABLE sessions DROP COLUMN summary_at; ALTER TABLE session_prs DROP COLUMN body_ref; DELETE FROM _migrations WHERE version >= 12;
      INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s', 'active', 'then', 'then');
      INSERT INTO agents (id, session_id, project_name, status, kind, created_at, updated_at)
        VALUES ('a', 's', 'app', 'done', 'pr_fix', 'then', 'then');`);
    migrate(db);
    expect(db.query("SELECT id, fix_origin FROM agents").get()).toEqual({ id: "a", fix_origin: null });
    expect(db.query("SELECT name FROM _migrations WHERE version = 12").get()).toEqual({ name: "agent_fix_origin" });
    migrate(db);
  } finally {
    db.close();
  }
});


describe("PR fix commit subjects", () => {
  test("describe review, CI, conflict and mixed work without agent IDs", () => {
    const pr = { title: "Add widgets", mergeable: null, base_branch: "main" } as const;
    expect(prFixCommitSubject([{ source_kind: "review_thread" }], pr)).toBe("Address review feedback on Add widgets");
    expect(prFixCommitSubject([{ source_kind: "ci_check" }], pr)).toBe("Fix failing CI checks");
    expect(prFixCommitSubject([], { ...pr, mergeable: "CONFLICTING" })).toBe("Resolve merge conflict with main");
    expect(prFixCommitSubject([{ source_kind: "review" }, { source_kind: "ci_check" }], pr)).toBe("Address PR feedback");
    expect(prFixCommitSubject([], { ...pr, title: null })).toBe("Address PR feedback");
  });
});

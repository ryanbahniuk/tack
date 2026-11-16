import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ConfigSchema, PrWatchSchema, type TackConfig } from "../src/config/schema";
import { migrate } from "../src/db/migrate";
import {
  createAgent, createSession, getSessionPr, listSessionPrs, markSessionPrReadyPromoted,
  setAgentRefs, setAgentWorktree, setSessionPrStatus, upsertSessionPr,
} from "../src/db";
import { ciGreen, isFailingCheck, isPendingCheck } from "../src/projects/prs";
import { readyToPromote, watchPr } from "../src/prwatch/watch";

const ready: Parameters<typeof readyToPromote>[0] = {
  enabled: true, autoReady: true, isDraft: true, readyPromotedAt: null,
  mergeable: "MERGEABLE", prFixBusy: false, freshCount: 0, releasedCount: 0,
  feedback: [], checks: [],
};
const addressed = {
  source_kind: "review_thread", decision: "fixed", handled_at: "then", reply_ref: "/reply",
} as const;

describe("readyToPromote", () => {
  test("clean PR qualifies without any fix runs or CI checks", () => {
    expect(readyToPromote(ready)).toBe(true);
  });
  const blockers: Partial<typeof ready>[] = [
    { enabled: false }, { autoReady: false }, { isDraft: false }, { isDraft: undefined },
    { readyPromotedAt: "then" }, { mergeable: "CONFLICTING" }, { mergeable: "UNKNOWN" },
    { mergeable: null }, { prFixBusy: true }, { freshCount: 1 }, { releasedCount: 1 },
    { checks: null }, { checks: [{ state: "IN_PROGRESS" }] }, { checks: [{ state: "FAILURE" }] },
    { feedback: [{ ...addressed, decision: "pending" }] },
    { feedback: [{ ...addressed, decision: "failed" }] },
    { feedback: [{ ...addressed, handled_at: null }] },
    { feedback: [{ ...addressed, reply_ref: null }] },
    { feedback: [{ ...addressed, decision: "declined", reply_ref: null }] },
    { feedback: [{ ...addressed, source_kind: "ci_check", decision: "pending" }] },
    { feedback: [{ ...addressed, source_kind: "ci_check", decision: "failed" }] },
  ];
  for (const blocker of blockers) {
    test(`blocks ${JSON.stringify(blocker)}`, () => {
      expect(readyToPromote({ ...ready, ...blocker })).toBe(false);
    });
  }
  for (const source_kind of ["review_thread", "review", "issue_comment"] as const) {
    for (const decision of ["fixed", "declined", "not_applicable"] as const) {
      test(`accepts explicitly addressed ${source_kind} / ${decision}`, () => {
        expect(readyToPromote({ ...ready, feedback: [{ ...addressed, source_kind, decision }] })).toBe(true);
      });
    }
  }
  test("handled historical CI failures need no reply when current CI is green", () => {
    expect(readyToPromote({ ...ready, feedback: [{ ...addressed, source_kind: "ci_check", reply_ref: null }] })).toBe(true);
  });
});

describe("CI readiness predicates", () => {
  for (const state of ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]) {
    test(`pending ${state}`, () => {
      expect(isPendingCheck({ state: state.toLowerCase() })).toBe(true);
      expect(ciGreen([{ state }])).toBe(false);
    });
  }
  for (const state of ["FAILURE", "FAIL", "ERROR", "CANCELLED", "CANCELED", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "STALE"]) {
    test(`failing ${state}`, () => {
      expect(isFailingCheck({ state: state.toLowerCase() })).toBe(true);
      expect(ciGreen([{ state }])).toBe(false);
    });
  }
  test("buckets work independently of state and settled passes/skips are green", () => {
    expect(isPendingCheck({ bucket: "PENDING" })).toBe(true);
    for (const bucket of ["fail", "cancel"]) {
      expect(isFailingCheck({ bucket })).toBe(true);
      expect(ciGreen([{ bucket }])).toBe(false);
    }
    expect(ciGreen([])).toBe(true);
    const checks = ["SUCCESS", "SKIPPED", "NEUTRAL"].map(state => ({ state }));
    expect(checks.some(isPendingCheck)).toBe(false);
    expect(checks.some(isFailingCheck)).toBe(false);
    expect(ciGreen(checks)).toBe(true);
  });
});

describe("PR readiness config and persistence", () => {
  test("defaults and explicit overrides", () => {
    const base = { roles: { supervisor: "x", agent: "x", summary: "x" } };
    expect(ConfigSchema.parse(base).draftPrs).toBe(true);
    expect(ConfigSchema.parse({ ...base, draftPrs: false }).draftPrs).toBe(false);
    expect(PrWatchSchema.parse(undefined).autoReady).toBe(true);
    expect(PrWatchSchema.parse({}).autoReady).toBe(true);
    expect(PrWatchSchema.parse({ autoReady: false }).autoReady).toBe(false);
  });
  test("v16 upgrades existing PRs with a nullable latch and is idempotent", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      db.exec(`ALTER TABLE session_prs DROP COLUMN ready_promoted_at;
        DELETE FROM _migrations WHERE version = 16; DELETE FROM _migrations WHERE version = 17;
        ALTER TABLE sessions DROP COLUMN summary_ref; ALTER TABLE sessions DROP COLUMN summary_at; ALTER TABLE session_prs DROP COLUMN body_ref; DELETE FROM _migrations WHERE version >= 18;
        ALTER TABLE sessions DROP COLUMN pr_fix_enabled;
        INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s', 'active', 'then', 'then');
        INSERT INTO agents (id, session_id, project_name, status, persona, created_at, updated_at)
          VALUES ('a', 's', 'app', 'done', 'strict', 'then', 'then');
        INSERT INTO session_prs (id, session_id, url, created_at, updated_at)
          VALUES ('p', 's', 'url', 'then', 'then');`);
      migrate(db);
      expect(db.query("SELECT pr_fix_enabled FROM sessions WHERE id = 's'").get()).toEqual({ pr_fix_enabled: 1 });
      expect(db.query("SELECT ready_promoted_at FROM session_prs").get()).toEqual({ ready_promoted_at: null });
      expect(db.query("SELECT persona FROM agents WHERE id = 'a'").get()).toEqual({ persona: "strict" });
      expect(db.query("SELECT name FROM _migrations WHERE version = 15").get()).toEqual({ name: "agent_personas" });
      db.exec("UPDATE session_prs SET ready_promoted_at = 'first'");
      migrate(db);
      expect(db.query("SELECT ready_promoted_at FROM session_prs").get()).toEqual({ ready_promoted_at: "first" });
    } finally { db.close(); }
  });
  test("latch preserves the first promotion across status polls and upserts", () => {
    const session = createSession({ title: "readiness latch" });
    const input = { sessionId: session.id, url: `https://github.com/acme/app/pull/${session.id}`, state: "draft" };
    upsertSessionPr(input);
    const pr = listSessionPrs(session.id)[0]!;
    expect(pr.ready_promoted_at).toBeNull();
    markSessionPrReadyPromoted(pr.id);
    const stamp = getSessionPr(pr.id)!.ready_promoted_at;
    expect(stamp).toEqual(expect.any(String));
    setSessionPrStatus(pr.id, { state: "draft", mergeable: "MERGEABLE", baseBranch: "main", headSha: "new" });
    upsertSessionPr(input);
    markSessionPrReadyPromoted(pr.id);
    expect(getSessionPr(pr.id)!.ready_promoted_at).toBe(stamp);
    expect(readyToPromote({ ...ready, readyPromotedAt: stamp })).toBe(false);
  });
});

// Capture the actual MCP handler so this checks both gh input and persisted state.
describe("open_pr draft defaults", () => {
  for (const draftPrs of [true, false]) {
    for (const draft of [undefined, false, true]) {
      test(`draftPrs=${draftPrs}, draft=${draft}`, async () => {
        const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
        const config = await import("../src/config/load");
        const prs = await import("../src/projects/prs");
        const worktree = await import("../src/worktree/worktree");
        const watch = await import("../src/prwatch/watch");
        const { runSupervisorServer } = await import("../src/mcp/supervisor-server");
        const session = createSession({ title: "draft PR" });
        const agent = createAgent({ sessionId: session.id, projectName: "app" });
        setAgentWorktree(agent.id, "/unused/worktree", "work");
        setAgentRefs(agent.id, { diffRef: "/diff" });
        const cfg = { draftPrs, personas: [], projects: [{ name: "app", path: "/unused" }], prWatch: { enabled: false } } as TackConfig;
        const open = spyOn(prs, "openSessionPr").mockResolvedValue({ url: `https://github.com/acme/app/pull/${session.id}`, number: 7, headBranch: "pr" });
        const spies = [open,
          spyOn(config, "loadConfig").mockResolvedValue(cfg),
          spyOn(worktree, "commitWorktreeAsync").mockResolvedValue(false),
          spyOn(worktree, "syncBranchWithBase").mockResolvedValue({ status: "up_to_date", base: "main", fetched: true }),
          spyOn(watch, "spawnPrWatcher").mockReturnValue(null),
          spyOn(McpServer.prototype, "connect").mockResolvedValue(),
        ];
        const register = spyOn(McpServer.prototype, "registerTool");
        try {
          await runSupervisorServer(session.id);
          const handler = register.mock.calls.find(([name]) => name === "open_pr")![2] as unknown as (input: unknown) => Promise<unknown>;
          await handler({ agentId: agent.id, title: "Draft", body: "Details", draft });
          const asDraft = draftPrs || !!draft;
          expect(open.mock.calls[0]![0].draft).toBe(asDraft);
          expect(listSessionPrs(session.id)[0]!.state).toBe(asDraft ? "draft" : "open");
        } finally {
          register.mockRestore();
          for (const spy of spies.reverse()) spy.mockRestore();
        }
      });
    }
  }
});


describe("watcher promotion", () => {
  async function fixture(run: (f: {
    session: ReturnType<typeof createSession>;
    pr: NonNullable<ReturnType<typeof getSessionPr>>;
    config: TackConfig;
    logs: string[];
    checks: ReturnType<typeof spyOn<typeof import("../src/projects/prs"), "fetchPrChecks">>;
    promote: ReturnType<typeof spyOn<typeof import("../src/projects/prs"), "markPrReady">>;
  }) => Promise<void>) {
    const prs = await import("../src/projects/prs");
    const session = createSession({ title: "watcher promotion" });
    upsertSessionPr({ sessionId: session.id, url: `https://github.com/acme/app/pull/${session.id}`,
      number: 7, state: "draft", projectName: "app" });
    const pr = listSessionPrs(session.id)[0]!;
    const config = ConfigSchema.parse({ projects: [{ name: "app", path: "/unused", description: "test" }],
      roles: { supervisor: "x", agent: "x", summary: "x" }, prWatch: { fixCi: false, maxFixRunsPerDay: 0 } }) as unknown as TackConfig;
    const checks = spyOn(prs, "fetchPrChecks").mockResolvedValue([]);
    const promote = spyOn(prs, "markPrReady").mockResolvedValue();
    const mocks = [checks, promote,
      spyOn(prs, "fetchReviewThreads").mockResolvedValue([]),
      spyOn(prs, "fetchPrStatus").mockResolvedValue({ state: "OPEN", isDraft: true, mergeable: "MERGEABLE",
        baseRefName: "main", headRefOid: "current", headRefName: "pr", title: "Draft", url: pr.url,
        comments: [], reviews: [] }),
    ];
    try { await run({ session, pr, config, logs: [], checks, promote }); }
    finally { for (const mock of mocks.reverse()) mock.mockRestore(); }
  }
  test("fetches checks with fixCi disabled and promotes a clean PR before the fix cap", async () => {
    await fixture(async ({ session, pr, config, checks, promote, logs }) => {
      const { setSessionPrFixEnabled } = await import("../src/db");
      setSessionPrFixEnabled(session.id, false);
      await watchPr(session, pr, config, msg => logs.push(msg));
      expect(checks).toHaveBeenCalledTimes(1);
      expect(promote).toHaveBeenCalledWith("/unused", 7);
      expect(getSessionPr(pr.id)).toMatchObject({ state: "open", ready_promoted_at: expect.any(String) });
      expect(logs.some(msg => msg.includes("promoted draft"))).toBe(true);
      // GitHub still reports draft, as if a human changed it back.
      await watchPr(session, getSessionPr(pr.id)!, config, () => {});
      expect(promote).toHaveBeenCalledTimes(1);
    });
  });
  test("auto-fix off leaves a conflict untouched", async () => {
    await fixture(async ({ session, pr, config, logs }) => {
      const db = await import("../src/db");
      const prs = await import("../src/projects/prs");
      db.setSessionPrFixEnabled(session.id, false);
      const status = spyOn(prs, "fetchPrStatus").mockResolvedValue({ state: "OPEN", isDraft: true, mergeable: "CONFLICTING", baseRefName: "main", headRefOid: "current", headRefName: "pr", title: "Draft", url: pr.url, comments: [], reviews: [] });
      try {
        await watchPr(session, pr, config, msg => logs.push(msg));
        expect(logs.some(msg => msg.includes("auto-fix is off"))).toBe(true);
        expect(db.listPrFixAgents(pr.id)).toHaveLength(0);
        expect(db.listPrFeedback(pr.id)).toHaveLength(0);
      } finally { status.mockRestore(); }
    });
  });
  test("failed promotion logs, leaves the latch unset and retries next tick", async () => {
    await fixture(async ({ session, pr, config, promote, logs }) => {
      promote.mockRejectedValueOnce(new Error("offline"));
      await watchPr(session, pr, config, msg => logs.push(msg));
      expect(getSessionPr(pr.id)).toMatchObject({ state: "draft", ready_promoted_at: null });
      expect(logs.some(msg => msg.includes("offline") && msg.includes("retry"))).toBe(true);
      await watchPr(session, getSessionPr(pr.id)!, config, () => {});
      expect(promote).toHaveBeenCalledTimes(2);
      expect(getSessionPr(pr.id)!.ready_promoted_at).not.toBeNull();
    });
  });
  test("failed check fetch defers readiness; next tick uses one fetch for CI and promotion", async () => {
    await fixture(async ({ session, pr, config, checks, promote }) => {
      config.prWatch.fixCi = true;
      checks.mockRejectedValueOnce(new Error("offline"));
      await watchPr(session, pr, config, () => {});
      expect(promote).not.toHaveBeenCalled();
      expect(getSessionPr(pr.id)!.ready_promoted_at).toBeNull();
      await watchPr(session, getSessionPr(pr.id)!, config, () => {});
      expect(checks).toHaveBeenCalledTimes(2);
      expect(promote).toHaveBeenCalledTimes(1);
    });
  });
  test("failing or pending CI blocks promotion even when CI fixes are disabled", async () => {
    await fixture(async ({ session, pr, config, checks, promote }) => {
      for (const state of ["FAILURE", "QUEUED"]) {
        checks.mockResolvedValue([{ state }]);
        await watchPr(session, pr, config, () => {});
        expect(promote).not.toHaveBeenCalled();
      }
    });
  });
});

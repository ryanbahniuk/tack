import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  addSharedContext,
  createSession,
  getDb,
  getSession,
  insertPrFeedback,
  listSessionPrs,
  markPrFeedbackHandled,
  migrate,
  recordPrFeedbackDecision,
  setSessionPrBodyRef,
  setSessionStatus,
  upsertSessionJiraTicket,
  upsertSessionPr,
} from "../src/db";
import {
  readArtifact,
  writePrFeedbackArtifact,
  writeSessionPrBody,
  writeSharedContext,
} from "../src/artifacts/store";
import {
  CONTRACT_CAP,
  FEEDBACK_CAP,
  composeSessionSummary,
  readPastSession,
  refreshSessionSummary,
  searchPastSessions,
  sessionSummaryText,
} from "../src/session/summary";

/** A test-unique word so searches over the shared test DB only see this file's sessions. */
const TOKEN = `tok${Math.random().toString(36).slice(2, 10)}`;
let seq = 0;

function seedSession(opts: {
  title: string;
  contract?: string;
  prs?: Array<{ project: string; title: string; body?: string }>;
  createdAt?: string;
}) {
  const s = createSession({ title: opts.title });
  if (opts.createdAt) getDb().prepare(`UPDATE sessions SET created_at = ? WHERE id = ?`).run(opts.createdAt, s.id);
  if (opts.contract) addSharedContext({ sessionId: s.id, bodyRef: writeSharedContext(s.id, 1, opts.contract), authoredBy: "supervisor" });
  for (const pr of opts.prs ?? []) {
    const url = `https://github.com/acme/${pr.project}/pull/${++seq}`;
    upsertSessionPr({ sessionId: s.id, url, projectName: pr.project, number: seq, title: pr.title, state: "open", headBranch: `tack/pr/${s.id}/x` });
    if (pr.body) {
      const row = listSessionPrs(s.id).find((r) => r.url === url)!;
      setSessionPrBodyRef(row.id, writeSessionPrBody(s.id, row.id, pr.body));
    }
  }
  return s;
}

describe("migration v18", () => {
  test("adds the summary and PR body refs, idempotently", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols("sessions")).toEqual(expect.arrayContaining(["summary_ref", "summary_at"]));
      expect(cols("session_prs")).toContain("body_ref");
      expect(db.query("SELECT name FROM _migrations WHERE version = 18").get()).toEqual({ name: "session_summary" });
      migrate(db);
      expect(db.query("SELECT COUNT(*) AS n FROM _migrations WHERE version = 18").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});

describe("composeSessionSummary", () => {
  const base = {
    session: { id: "ses_abc", title: "Add widgets", created_at: "2026-11-01T10:00:00.000Z" },
    jira: [{ key: "ABC-1", title: "Widgets" }, { key: "ABC-2", title: null }],
    contract: "# Goal\nShip widgets.",
    prs: [
      { row: { title: "ABC-1: widgets", project_name: "app", url: "https://x/pull/1", state: "merged", head_branch: "tack/pr/a" }, body: "Adds widgets.\n\n- detail" },
      { row: { title: null, project_name: "api", url: "https://x/pull/2", state: "open", head_branch: null }, body: "" },
    ],
  };

  test("renders header, metadata, contract and every PR with its body verbatim", () => {
    const md = composeSessionSummary(base);
    expect(md.startsWith("# Add widgets\n")).toBe(true);
    expect(md).toContain("- Session: ses_abc");
    expect(md).toContain("- Created: 2026-11-01");
    expect(md).toContain("- Projects: app, api");
    expect(md).toContain("- Jira: ABC-1 (Widgets), ABC-2");
    expect(md).toContain("## Goal / contract\n\n# Goal\nShip widgets.");
    expect(md).toContain("### ABC-1: widgets\n\n- Project: app\n- URL: https://x/pull/1\n- State: merged\n- Branch: tack/pr/a\n\nAdds widgets.\n\n- detail");
    // A PR without a title falls back to its URL; an empty body is simply omitted.
    expect(md).toContain("### https://x/pull/2\n\n- Project: api\n- URL: https://x/pull/2\n- State: open\n- Branch: (unknown)\n");
    expect(md.trimEnd().endsWith("- Branch: (unknown)")).toBe(true);
    expect(composeSessionSummary(base)).toBe(md);
  });

  test("falls back to the id, omits empty Jira, and truncates a long contract with a marker", () => {
    const md = composeSessionSummary({ ...base, session: { ...base.session, title: null }, jira: [], contract: "x".repeat(CONTRACT_CAP + 500) });
    expect(md.startsWith("# ses_abc\n")).toBe(true);
    expect(md).not.toContain("- Jira:");
    expect(md).toContain("x".repeat(CONTRACT_CAP) + "\n\n… (truncated)");
    expect(md).not.toContain("x".repeat(CONTRACT_CAP + 1));
    expect(composeSessionSummary({ ...base, contract: null, prs: [] })).toContain("(no shared contract)");
  });
});

describe("stored vs on-the-fly summaries", () => {
  test("refreshSessionSummary writes the composed summary and stamps the session", () => {
    const s = seedSession({ title: `${TOKEN} refresh`, contract: "Refresh goal", prs: [{ project: "app", title: "PR one", body: "Body one" }] });
    const ref = refreshSessionSummary(s.id)!;
    const row = getSession(s.id)!;
    expect(row.summary_ref).toBe(ref);
    expect(row.summary_at).not.toBeNull();
    const stored = readArtifact(ref);
    expect(stored).toContain("Refresh goal");
    expect(stored).toContain("### PR one");
    expect(stored).toContain("Body one");
    expect(sessionSummaryText(row)).toBe(stored);
    expect(refreshSessionSummary("ses_missing")).toBeNull();
  });

  test("a pre-existing session with PRs but no summary is composed on the fly without writing", () => {
    const s = seedSession({ title: `${TOKEN} legacy`, contract: "Legacy goal", prs: [{ project: "app", title: "Old PR" }] });
    const text = sessionSummaryText(getSession(s.id)!);
    expect(text).toContain("Legacy goal");
    expect(text).toContain("### Old PR");
    expect(text).toContain("https://github.com/acme/app/pull/");
    expect(getSession(s.id)!.summary_ref).toBeNull();
    expect(readPastSession(s.id)!.summary).toBe(text);
  });
});

describe("searchPastSessions", () => {
  const T = `${TOKEN}s`;
  const alpha = seedSession({ title: `${T} alpha work`, contract: "Uses the zebra cache", prs: [{ project: "app", title: "Alpha PR" }], createdAt: "2026-01-01T00:00:00.000Z" });
  setSessionStatus(alpha.id, "archived");
  upsertSessionJiraTicket({ sessionId: alpha.id, key: "ZZ-9" });
  const beta = seedSession({ title: `${T} beta work`, prs: [{ project: "api", title: "Beta PR", body: "Touches the zebra too" }], createdAt: "2026-02-01T00:00:00.000Z" });
  refreshSessionSummary(beta.id);
  const noPrs = seedSession({ title: `${T} no prs`, contract: "zebra", createdAt: "2026-03-01T00:00:00.000Z" });
  const current = seedSession({ title: `${T} current`, contract: "zebra", prs: [{ project: "app", title: "Current PR" }], createdAt: "2026-04-01T00:00:00.000Z" });
  const ids = (q: Parameters<typeof searchPastSessions>[0]) => searchPastSessions({ excludeSessionId: current.id, ...q }).map((m) => m.sessionId);

  test("excludes the current session and sessions without PRs, includes archived, newest first", () => {
    expect(ids({ query: T })).toEqual([beta.id, alpha.id]);
    expect(ids({ query: T })).not.toContain(noPrs.id);
    expect(searchPastSessions({ query: T }).map((m) => m.sessionId)).toContain(current.id);
  });

  test("every term must match the title or summary, case-insensitively", () => {
    expect(ids({ query: `${T} ALPHA` })).toEqual([alpha.id]);
    expect(ids({ query: `${T} zebra` })).toEqual([beta.id, alpha.id]);
    expect(ids({ query: `${T} cache` })).toEqual([alpha.id]);
    expect(ids({ query: `${T} alpha beta` })).toEqual([]);
  });

  test("filters by PR project and honors the limit", () => {
    expect(ids({ query: T, project: "API" })).toEqual([beta.id]);
    expect(ids({ query: T, limit: 1 })).toEqual([beta.id]);
  });

  test("returns metadata, PRs and a snippet around the first match", () => {
    const [m] = searchPastSessions({ excludeSessionId: current.id, query: `${T} cache` });
    expect(m).toMatchObject({ title: `${T} alpha work`, projects: ["app"], jira: ["ZZ-9"], createdAt: "2026-01-01T00:00:00.000Z" });
    expect(m!.prs).toEqual([{ url: expect.stringContaining("/pull/"), title: "Alpha PR", project: "app", state: "open" }]);
    expect(m!.snippet).toContain(T);
    expect(m!.snippet.length).toBeLessThanOrEqual(302);
  });
});

describe("readPastSession", () => {
  test("returns the summary and how each PR's feedback was addressed", () => {
    const s = seedSession({ title: `${TOKEN} read`, prs: [{ project: "app", title: "Fixable", body: "PR body" }] });
    refreshSessionSummary(s.id);
    const pr = listSessionPrs(s.id)[0]!;
    getDb().prepare(`UPDATE session_prs SET merged_at = ?, state = 'merged' WHERE id = ?`).run("2026-11-02T00:00:00.000Z", pr.id);
    const long = "c".repeat(FEEDBACK_CAP + 50);
    const fb = insertPrFeedback({
      sessionPrId: pr.id, sourceId: "RC_1", sourceKind: "review_thread", author: "rev", path: "src/a.ts", line: 7,
      bodyRef: writePrFeedbackArtifact(s.id, pr.id, "RC_1", "body", long),
    });
    recordPrFeedbackDecision(fb.id, "fixed", writePrFeedbackArtifact(s.id, pr.id, "RC_1", "reply", "Done in abc123"));
    markPrFeedbackHandled(fb.id, { replyUrl: "https://x/reply/1" });
    insertPrFeedback({ sessionPrId: pr.id, sourceId: "IC_2", sourceKind: "issue_comment", author: "bob" });

    const past = readPastSession(s.id)!;
    expect(past.summary).toContain("PR body");
    expect(past.prs).toHaveLength(1);
    expect(past.prs[0]).toMatchObject({ title: "Fixable", project: "app", state: "merged", mergedAt: "2026-11-02T00:00:00.000Z" });
    const byKind = [...past.prs[0]!.feedback].sort((a, b) => b.sourceKind.localeCompare(a.sourceKind));
    expect(byKind).toEqual([
      { author: "rev", sourceKind: "review_thread", path: "src/a.ts", line: 7, decision: "fixed",
        body: "c".repeat(FEEDBACK_CAP) + "…", reply: "Done in abc123", replyUrl: "https://x/reply/1" },
      { author: "bob", sourceKind: "issue_comment", path: null, line: null, decision: "pending", body: "", reply: "", replyUrl: null },
    ]);
    expect(readPastSession("ses_nope")).toBeNull();
  });
});

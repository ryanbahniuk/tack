import { describe, expect, test } from "bun:test";
import { completionMarker, parseCompletionVerdict, sessionPrsSettled } from "../src/jirawatch/completion";
import { selectDoneTransition } from "../src/projects/jira";

describe("Jira completion", () => {
  test("requires a merged PR and no open PRs", () => {
    expect(sessionPrsSettled([])).toBe(false);
    expect(sessionPrsSettled([{ state: "closed" }])).toBe(false);
    expect(sessionPrsSettled([{ state: "merged" }, { state: "draft" }])).toBe(false);
    expect(sessionPrsSettled([{ state: "merged" }, { state: "closed" }])).toBe(true);
  });
  test("marker follows the latest merge", () => {
    expect(completionMarker([{ state: "merged", merged_at: "2026-01-01" }, { state: "merged", merged_at: "2026-02-01" }, { state: "closed", merged_at: null }])).toBe("2026-02-01");
  });
  test("requires a valid final JSON verdict", () => {
    const json = '{"key":"ABC-1","done":true,"confidence":"high","reason":"covered","unmet":[]}';
    expect(parseCompletionVerdict(`\`\`\`json\n${json}\n\`\`\``, "ABC-1")?.done).toBe(true);
    expect(parseCompletionVerdict(json, "ABC-1")).toBeNull();
    expect(parseCompletionVerdict("```json\n{\n```", "ABC-1")).toBeNull();
    expect(parseCompletionVerdict(`\`\`\`json\n${json}\n\`\`\``, "OTHER-1")).toBeNull();
  });
  test("prefers Done and falls back to another Done-category transition", () => {
    const transition = (id: string, name: string, category: string) => ({ id, name, to: { name, statusCategory: { key: category } } });
    const other = transition("1", "Complete", "done"), done = transition("2", "done", "done");
    expect(selectDoneTransition({ transitions: [other, done] })?.id).toBe("2");
    expect(selectDoneTransition({ transitions: [other] })?.id).toBe("1");
    expect(selectDoneTransition({ transitions: [transition("3", "Done", "new")] })).toBeNull();
  });
});

test("claims serialize checks, allow stale takeover, and preserve check results on refresh", async () => {
  const { createSession, deleteSession, claimJiraCheck, releaseJiraCheck, getSession, upsertSessionJiraTicket, setJiraCheckResult, listSessionJiraTickets } = await import("../src/db");
  const session = createSession({});
  try {
    const first = new Date("2026-01-01T00:00:00.000Z");
    expect(claimJiraCheck(session.id, first)).toBe(true);
    expect(claimJiraCheck(session.id, new Date(first.getTime() + 60_000))).toBe(false);
    expect(claimJiraCheck(session.id, new Date(first.getTime() + 15 * 60_000))).toBe(false);
    expect(claimJiraCheck(session.id, new Date(first.getTime() + 15 * 60_000 + 1))).toBe(true);
    releaseJiraCheck(session.id, first.toISOString());
    expect(getSession(session.id)?.jira_check_claimed_at).not.toBeNull();
    upsertSessionJiraTicket({ sessionId: session.id, key: "ABC-1" });
    setJiraCheckResult(session.id, "ABC-1", "not_done", "Missing work", "/artifact/check.md", "marker");
    const before = listSessionJiraTickets(session.id)[0]!;
    upsertSessionJiraTicket({ sessionId: session.id, key: "ABC-1", status: "In progress" });
    const after = listSessionJiraTickets(session.id)[0]!;
    expect([after.check_name, after.check_at, after.check_result, after.check_reason, after.check_ref, after.check_marker]).toEqual([before.check_name, before.check_at, before.check_result, before.check_reason, before.check_ref, before.check_marker]);
  } finally { deleteSession(session.id); }
});

import { Database } from "bun:sqlite";
import { createSession, deleteSession, listSessionJiraTickets, migrate, setSessionStatus, upsertSessionJiraTicket, upsertSessionPr, setJiraCheckResult } from "../src/db";
import { jiraWatchFinished, jiraWatchPass } from "../src/jirawatch/watch";
import type { TackConfig } from "../src/config/schema";

const watchConfig = (mode: "off" | "evaluate" | "update", comment = true) => ({ jira: { siteUrl: "https://jira.example", mcpServer: "fake", watch: { mode, comment, intervalSeconds: 300 } } } as TackConfig);
const verdict = (confidence = "high") => `\`\`\`json\n${JSON.stringify({ key: "ABC-1", done: true, confidence, reason: "Requirements met", unmet: [] })}\n\`\`\``;
const refresh = async () => ({ tickets: [], skipped: [], unavailable: false });

async function checkFixture<T>(fn: (id: string) => Promise<T> | T): Promise<T> {
  const session = createSession({});
  try { return await fn(session.id); } finally { deleteSession(session.id); }
}

function fakeJira() {
  const calls: string[] = [];
  return { calls, deps: {
    fetch: async () => ({ key: "ABC-1", title: "Issue", status: "Open", statusCategory: "new", description: "Requirements", subtasks: [] }),
    transition: async () => { calls.push("transition"); return { kind: "updated" as const, status: "Done" }; },
    comment: async (_config: TackConfig, _key: string, body: string) => { calls.push(body); },
  } };
}

function addTicketAndPr(id: string, state = "merged") {
  upsertSessionJiraTicket({ sessionId: id, key: "ABC-1", statusCategory: "new" });
  upsertSessionPr({ sessionId: id, url: "https://example.com/pr/1", state, mergedAt: state === "merged" ? "2026-01-01" : null });
}

test("watcher exit conditions include inactive, off, empty, done and checked tickets", async () => {
  await checkFixture(id => {
    const config = watchConfig("evaluate");
    expect(jiraWatchFinished(id, config)).toBe(true);
    addTicketAndPr(id);
    expect(jiraWatchFinished(id, watchConfig("off"))).toBe(true);
    expect(jiraWatchFinished(id, config)).toBe(false);
    setJiraCheckResult(id, "ABC-1", "not_done", "missing", null, "2026-01-01");
    expect(jiraWatchFinished(id, config)).toBe(true);
    upsertSessionPr({ sessionId: id, url: "https://example.com/pr/2", state: "open" });
    expect(jiraWatchFinished(id, config)).toBe(false);
    upsertSessionJiraTicket({ sessionId: id, key: "ABC-1", statusCategory: "done" });
    expect(jiraWatchFinished(id, config)).toBe(true);
    setSessionStatus(id, "archived");
    expect(jiraWatchFinished(id, config)).toBe(true);
  });
  expect(jiraWatchFinished("missing-session", watchConfig("evaluate"))).toBe(true);
});

test.each([
  ["off", false, true, "would_update", 0],
  ["evaluate", false, true, "would_update", 0],
  ["update", true, true, "would_update", 0],
  ["update", false, false, "updated", 1],
  ["update", false, true, "updated", 2],
] as const)("%s dry=%s comment=%s records %s", async (mode, dryRun, comment, expected, writes) => {
  await checkFixture(async id => {
    addTicketAndPr(id);
    const fake = fakeJira();
    expect(await jiraWatchPass(id, watchConfig(mode, comment), { dryRun, refresh, deps: fake.deps, runner: async () => verdict() })).toBe(true);
    const ticket = listSessionJiraTickets(id)[0]!;
    expect(ticket.check_result).toBe(expected);
    expect(fake.calls.length).toBe(writes);
    if (writes === 2) {
      expect(fake.calls[1]).toContain("Marked done by Tack");
      expect(fake.calls[1]).toContain("https://example.com/pr/1");
      expect(fake.calls[1]).toContain(id);
    }
  });
});

test.each([["missing", "text", "error"], ["malformed", "```json\n{\n```", "error"], ["medium confidence", verdict("medium"), "not_done"]])("%s verdict never writes", async (_name, output, expected) => {
  await checkFixture(async id => {
    addTicketAndPr(id);
    const fake = fakeJira();
    await jiraWatchPass(id, watchConfig("update"), { refresh, deps: fake.deps, runner: async () => output });
    expect(listSessionJiraTickets(id)[0]!.check_result).toBe(expected);
    expect(fake.calls).toEqual([]);
  });
});

test("force bypasses both settled gate and marker latch", async () => {
  await checkFixture(async id => {
    addTicketAndPr(id, "open");
    const fake = fakeJira();
    let runs = 0;
    const options = { refresh, deps: fake.deps, runner: async () => { runs++; return verdict(); } };
    await jiraWatchPass(id, watchConfig("evaluate"), options);
    expect(runs).toBe(0);
    await jiraWatchPass(id, watchConfig("evaluate"), { ...options, force: true });
    expect(runs).toBe(1);
    upsertSessionPr({ sessionId: id, url: "https://example.com/pr/1", state: "merged", mergedAt: "2026-01-01" });
    setJiraCheckResult(id, "ABC-1", "not_done", "missing", null, "2026-01-01");
    await jiraWatchPass(id, watchConfig("evaluate"), options);
    expect(runs).toBe(1);
    await jiraWatchPass(id, watchConfig("evaluate"), { ...options, force: true });
    expect(runs).toBe(2);
  });
});

test("migration adds Jira watch fields to an in-memory database", () => {
  const db = new Database(":memory:");
  try {
    migrate(db); migrate(db);
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
    expect(columns("sessions")).toContain("jira_check_claimed_at");
    expect(columns("sessions")).toContain("jira_watch_code_version");
    expect(columns("session_jira_tickets")).toContain("check_marker");
    expect(columns("session_jira_tickets")).toContain("check_ref");
    expect(db.query("SELECT MAX(version) AS v FROM _migrations").get()).toEqual({ v: 27 });
  } finally { db.close(); }
});

test("no Done-category transition is recorded without a comment", async () => {
  await checkFixture(async id => {
    addTicketAndPr(id);
    const fake = fakeJira();
    const deps = { ...fake.deps, transition: async () => ({ kind: "no_transition" as const }) };
    await jiraWatchPass(id, watchConfig("update"), { refresh, deps, runner: async () => verdict() });
    expect(listSessionJiraTickets(id)[0]!.check_result).toBe("no_transition");
    expect(fake.calls).toEqual([]);
  });
});

test("a later merge re-triggers a ticket check", async () => {
  await checkFixture(async id => {
    addTicketAndPr(id);
    const fake = fakeJira();
    let runs = 0;
    const options = { refresh, deps: fake.deps, runner: async () => { runs++; return verdict("medium"); } };
    await jiraWatchPass(id, watchConfig("evaluate"), options);
    await jiraWatchPass(id, watchConfig("evaluate"), options);
    expect(runs).toBe(1);
    upsertSessionPr({ sessionId: id, url: "https://example.com/pr/2", state: "merged", mergedAt: "2026-02-01" });
    await jiraWatchPass(id, watchConfig("evaluate"), options);
    expect(runs).toBe(2);
    expect(listSessionJiraTickets(id)[0]!.check_marker).toBe("2026-02-01");
  });
});

import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import {
  DEFAULT_TICKET_FILTER,
  Dashboard,
  describeJiraPoll,
  describeTicketFilters,
  filterTicketEntries,
  nextTicketStatusFilter,
  ticketEntries,
} from "../src/cli/dashboard";
import type { TackConfig } from "../src/config/schema";
import type { JiraRefreshResult } from "../src/projects/jira";
import { createSession, deleteSession, getDb, getSession, setSessionStatus, setSessionTitle, upsertSessionJiraTicket } from "../src/db";
import * as repositories from "../src/db/repositories";

// Captured before any spy replaces the export, so mocks can delegate to it.
const listAllTickets = repositories.listAllSessionJiraTickets;

/** The tickets view reads every ticket in the (shared, cross-file) test DB; scope
 * it to this test's sessions so stray rows from other test files can't leak in. */
function scopeTickets(sessionIds: string[]) {
  return spyOn(repositories, "listAllSessionJiraTickets").mockImplementation(() =>
    listAllTickets().filter(t => sessionIds.includes(t.session_id)));
}

/** Pins a link's `created_at` so "newest link first" ordering is deterministic. */
function stampLink(sessionId: string, key: string, iso: string) {
  getDb().prepare(`UPDATE session_jira_tickets SET created_at = ? WHERE session_id = ? AND key = ?`).run(iso, sessionId, key);
}

// No config means no `jira` siteUrl, so a ticket linked without a url can't open.
for (const tickets of [0, 2]) {
  test(`dashboard J explains ${tickets ? "unlinkable tickets" : "no tickets"}`, async () => {
    const session = createSession({});
    for (let n = 1; n <= tickets; n++) upsertSessionJiraTicket({ sessionId: session.id, key: `MISSION-${n}`, url: null });
    const list = spyOn(repositories, "listSessions").mockImplementation(() => [getSession(session.id)!]);
    const output = new PassThrough();
    Object.assign(output, { columns: 300, rows: 60, isTTY: false });
    const input = new PassThrough();
    Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    let frame = "";
    output.on("data", chunk => { frame += chunk.toString(); });
    const app = render(<Dashboard config={null} onLaunch={() => {}} />, {
      stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await app.waitUntilRenderFlush();
      frame = "";
      input.write("t"); await Bun.sleep(30); input.write("o");
      await new Promise(resolve => setTimeout(resolve, 25));
      await app.waitUntilRenderFlush();
      expect(frame).toContain(tickets
        ? `${session.id} has 2 tickets but no Jira site is configured — add a \`jira\` block (siteUrl) to your Tack config`
        : `${session.id} has no tickets yet`);
    } finally {
      app.unmount();
      list.mockRestore();
      deleteSession(session.id);
    }
  });
}

/** Renders the dashboard over the given sessions with a `press` helper that
 * returns the ANSI-stripped frame(s) written since the key went in. */
async function mount(sessionIds: string[], config: TackConfig | null) {
  // Honors `z` like the real query: archived sessions only with includeArchived.
  const list = spyOn(repositories, "listSessions").mockImplementation(includeArchived =>
    sessionIds.map(id => getSession(id)!).filter(s => includeArchived || s.status === "active"));
  const tickets = scopeTickets(sessionIds);
  const output = new PassThrough();
  Object.assign(output, { columns: 300, rows: 60, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame += stripVTControlCharacters(chunk.toString()); });
  const app = render(<Dashboard config={config} onLaunch={() => {}} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  await app.waitUntilRenderFlush();
  const press = async (key: string) => {
    frame = "";
    input.write(key);
    await new Promise(resolve => setTimeout(resolve, 25));
    await app.waitUntilRenderFlush();
    return frame;
  };
  return { app, press, cleanup: () => { app.unmount(); list.mockRestore(); tickets.mockRestore(); } };
}

test("dashboard t lists tickets across sessions, open work first, and esc returns", async () => {
  const a = createSession({});
  const b = createSession({});
  upsertSessionJiraTicket({ sessionId: a.id, key: "MISSION-1", title: "Shipped thing", status: "Done", statusCategory: "done" });
  upsertSessionJiraTicket({ sessionId: b.id, key: "MISSION-2", title: "Busy thing", status: "In Progress", statusCategory: "indeterminate" });
  upsertSessionJiraTicket({ sessionId: a.id, key: "MISSION-3", title: "Later thing", status: "To Do", statusCategory: "new" });
  upsertSessionJiraTicket({ sessionId: b.id, key: "MISSION-4", title: "Newer thing", status: "To Do", statusCategory: "new" });
  stampLink(a.id, "MISSION-3", "2026-01-01T00:00:00.000Z");
  stampLink(b.id, "MISSION-4", "2026-02-01T00:00:00.000Z");
  const { press, cleanup } = await mount([a.id, b.id], null);
  try {
    const view = (await press("t"), await press("t"));
    expect(view).toContain("Jira tickets · 4 of 4 · 2 sessions · 1 done");
    const row = (key: string) => view.split("\n").find(line => line.includes(key)) ?? "";
    expect(row("MISSION-2")).toContain(b.id);
    expect(row("MISSION-2")).toContain("● In Progress");
    expect(row("MISSION-1")).toContain(a.id);
    expect(row("MISSION-1")).toContain("✔ Done");
    expect(row("MISSION-3")).toContain(a.id);
    // In progress, then to do (newest link first), then done.
    expect(view.indexOf("MISSION-2")).toBeLessThan(view.indexOf("MISSION-4"));
    expect(view.indexOf("MISSION-4")).toBeLessThan(view.indexOf("MISSION-3"));
    expect(view.indexOf("MISSION-3")).toBeLessThan(view.indexOf("MISSION-1"));
    expect(row("MISSION-2")).toContain("❯");
    expect(view).toContain("g go to session");
    // Moving to the older to-do ticket and jumping to its session lands on that session.
    await press("j");
    await press("j");
    const list = await press("g");
    expect(list).toContain(`❯ ○ ${a.id}`);
    expect(list).toContain("t ticket actions");
    (await press("t"), await press("t"));
    const back = await press("\u001b");
    expect(back).toContain("Tack ·");
    expect(back).not.toContain("Jira tickets ·");
    // q backs out of the view instead of quitting.
    (await press("t"), await press("t"));
    expect(await press("q")).toContain("Tack ·");
  } finally {
    cleanup();
    deleteSession(a.id);
    deleteSession(b.id);
  }
});

test("dashboard tickets view explains when nothing is linked", async () => {
  const s = createSession({});
  const { press, cleanup } = await mount([s.id], null);
  try {
    const view = (await press("t"), await press("t"));
    expect(view).toContain("Jira tickets · 0 of 0 · 0 sessions · 0 done");
    expect(view).toContain("No Jira tickets linked to any session.");
  } finally {
    cleanup();
    deleteSession(s.id);
  }
});

test("dashboard P without config says so", async () => {
  const s = createSession({});
  const { press, cleanup } = await mount([s.id], null);
  try {
    await press("t"); expect(await press("p")).toContain("config is unavailable");
  } finally {
    cleanup();
    deleteSession(s.id);
  }
});

test("dashboard P polls Jira now and never overlaps an in-flight poll", async () => {
  const prs = await import("../src/projects/prs");
  const jira = await import("../src/projects/jira");
  const s = createSession({});
  upsertSessionJiraTicket({ sessionId: s.id, key: "MISSION-7", status: "To Do", statusCategory: "new" });
  let finish: (r: JiraRefreshResult) => void = () => {};
  let calls = 0;
  const spies = [
    spyOn(prs, "refreshSessionPrs").mockResolvedValue({ ghMissing: true } as never),
    // The mount-time background poll settles at once; the on-demand one hangs
    // until released, so a second P lands while it is still in flight.
    spyOn(jira, "refreshSessionJiraTickets").mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.resolve({ tickets: [], skipped: [], unavailable: false });
      return new Promise(resolve => { finish = resolve; });
    }),
  ];
  const config = { projects: [], prWatch: { intervalSeconds: 3600, enabled: false }, jira: { siteUrl: "https://example.atlassian.net" } } as unknown as TackConfig;
  const { press, cleanup } = await mount([s.id], config);
  try {
    (await press("t"), await press("t"));
    expect(calls).toBe(1);
    expect(await press("P")).toContain("polling Jira…");
    expect(calls).toBe(2);
    expect(spies[1]).toHaveBeenLastCalledWith(config, [s.id]);
    expect(await press("P")).toContain("Jira poll already in progress…");
    expect(calls).toBe(2);
    finish({
      tickets: [{ key: "MISSION-7" }, { key: "MISSION-8" }] as never,
      skipped: [{ key: "MISSION-8", reason: "not found" }],
      unavailable: false,
    });
    expect(await press("j")).toContain("Jira: refreshed 1 ticket(s) · 1 skipped (MISSION-8: not found)");
  } finally {
    cleanup();
    for (const spy of spies) spy.mockRestore();
    deleteSession(s.id);
  }
});

test("Jira poll notices distinguish unconfigured, unavailable and capped skips", () => {
  const bare = {} as TackConfig;
  const configured = { jira: { siteUrl: "https://example.atlassian.net" } } as unknown as TackConfig;
  const down = { tickets: [], skipped: [], unavailable: true };
  expect(describeJiraPoll(bare, down)).toContain("Jira isn't configured");
  expect(describeJiraPoll(configured, down)).toBe("Jira unavailable — check the jira config / Atlassian MCP auth");
  const skipped = ["A-1", "A-2", "A-3", "A-4", "A-5"].map(key => ({ key, reason: "not found" }));
  expect(describeJiraPoll(configured, { tickets: [], skipped, unavailable: false }))
    .toBe("Jira: refreshed 0 ticket(s) · 5 skipped (A-1: not found, A-2: not found, A-3: not found, +2 more)");
});

test("tickets view windows rows around the cursor inside a short terminal", async () => {
  const s = createSession({});
  for (let n = 1; n <= 30; n++) {
    upsertSessionJiraTicket({ sessionId: s.id, key: `MISSION-${n}`, title: "A long title ".repeat(10), status: "To Do", statusCategory: "new" });
    stampLink(s.id, `MISSION-${n}`, new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString());
  }
  const list = spyOn(repositories, "listSessions").mockImplementation(() => [getSession(s.id)!]);
  const tickets = scopeTickets([s.id]);
  const output = new PassThrough();
  Object.assign(output, { columns: 80, rows: 14, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame = stripVTControlCharacters(chunk.toString()); });
  const app = render(<Dashboard config={null} onLaunch={() => {}} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const press = async (key: string) => {
    input.write(key);
    await new Promise(resolve => setTimeout(resolve, 25));
    await app.waitUntilRenderFlush();
    const lines = frame.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(13);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    return frame;
  };
  try {
    await app.waitUntilRenderFlush();
    const first = (await press("t"), await press("t"));
    expect(first).toContain("Jira tickets · 30 of 30 · 1 session");
    // Newest link first.
    expect(first).toMatch(/❯ MISSION-30 /);
    expect(first).toContain("↓");
    expect(first).toContain("esc/q back");
    for (let i = 0; i < 19; i++) await press("j");
    const middle = await press("j");
    expect(middle).toMatch(/❯ MISSION-10 /);
    expect(middle).toContain("↑");
    expect(middle).toContain("↓");
  } finally {
    app.unmount();
    list.mockRestore();
    tickets.mockRestore();
    deleteSession(s.id);
  }
});

const rowOf = (frame: string, needle: string) => frame.split("\n").find(line => line.includes(needle)) ?? "";

test("tickets view shows archived sessions' tickets with z off, and g turns z on to land on them", async () => {
  const live = createSession({});
  const old = createSession({});
  upsertSessionJiraTicket({ sessionId: live.id, key: "MISSION-1", status: "To Do", statusCategory: "new" });
  upsertSessionJiraTicket({ sessionId: old.id, key: "MISSION-2", status: "Done", statusCategory: "done" });
  setSessionStatus(old.id, "archived");
  const { press, cleanup } = await mount([live.id, old.id], null);
  try {
    // The main list hides the archived session…
    const list = await press("k");
    expect(list).toContain("(active)");
    expect(list).not.toContain(old.id);
    // …but the tickets view still shows its ticket, with a static archived badge.
    const view = (await press("t"), await press("t"));
    expect(view).toContain("Jira tickets · 2 of 2 · 2 sessions · 1 done");
    expect(rowOf(view, "MISSION-1")).toContain("○ active");
    expect(rowOf(view, "MISSION-2")).toContain(old.id);
    expect(rowOf(view, "MISSION-2")).toContain("○ archived");
    await press("j");
    const back = await press("g");
    expect(back).toContain("(all)");
    expect(rowOf(back, old.id)).toContain("❯");
  } finally {
    cleanup();
    deleteSession(live.id);
    deleteSession(old.id);
  }
});

test("tickets view f cycles the status filter and a toggles archived sessions", async () => {
  const a = createSession({});
  const b = createSession({});
  upsertSessionJiraTicket({ sessionId: a.id, key: "MISSION-1", status: "In Progress", statusCategory: "indeterminate" });
  upsertSessionJiraTicket({ sessionId: a.id, key: "MISSION-2", status: "To Do", statusCategory: "new" });
  upsertSessionJiraTicket({ sessionId: b.id, key: "MISSION-3" });
  upsertSessionJiraTicket({ sessionId: b.id, key: "MISSION-4", status: "Done", statusCategory: "done" });
  setSessionStatus(b.id, "archived");
  const { press, cleanup } = await mount([a.id, b.id], null);
  const keys = (frame: string) => ["MISSION-1", "MISSION-2", "MISSION-3", "MISSION-4"].filter(k => frame.includes(k));
  try {
    expect(keys((await press("t"), await press("t")))).toEqual(["MISSION-1", "MISSION-2", "MISSION-3", "MISSION-4"]);
    const open = await press("f");
    expect(open).toContain("Jira tickets · 3 of 4 · 2 sessions · 0 done · status: open");
    expect(keys(open)).toEqual(["MISSION-1", "MISSION-2", "MISSION-3"]);
    const busy = await press("f");
    expect(busy).toContain("1 of 4 · 1 session · 0 done · status: in progress");
    expect(keys(busy)).toEqual(["MISSION-1"]);
    // Unknown status (never refreshed) counts as to do.
    const todo = await press("f");
    expect(todo).toContain("2 of 4 · 2 sessions · 0 done · status: to do");
    expect(keys(todo)).toEqual(["MISSION-2", "MISSION-3"]);
    const done = await press("f");
    expect(done).toContain("1 of 4 · 1 session · 1 done · status: done");
    expect(keys(done)).toEqual(["MISSION-4"]);
    // Hiding archived sessions on top of "done" leaves nothing.
    const none = await press("a");
    expect(none).toContain("0 of 4 · 0 sessions · 0 done · status: done · archived hidden");
    expect(none).toContain("No tickets match the filters.");
    expect(none).not.toContain("No Jira tickets linked");
    const all = await press("f");
    expect(all).toContain("2 of 4 · 1 session · 0 done · archived hidden");
    expect(all).not.toContain("status:");
    expect(keys(all)).toEqual(["MISSION-1", "MISSION-2"]);
    expect(keys(await press("a"))).toHaveLength(4);
    // Reopening the view resets the filters.
    await press("f");
    await press("a");
    await press("q");
    const reopened = (await press("t"), await press("t"));
    expect(reopened).toContain("Jira tickets · 4 of 4 · 2 sessions · 1 done");
    expect(reopened).not.toContain("archived hidden");
  } finally {
    cleanup();
    deleteSession(a.id);
    deleteSession(b.id);
  }
});

test("tickets view / filters by text and captures shortcut keys while typing", async () => {
  const a = createSession({});
  const b = createSession({});
  setSessionTitle(b.id, "Billing revamp");
  upsertSessionJiraTicket({ sessionId: a.id, key: "MISSION-1", title: "Quality pass", status: "To Do", statusCategory: "new" });
  upsertSessionJiraTicket({ sessionId: a.id, key: "OTHER-2", title: "Jumbo", status: "To Do", statusCategory: "new" });
  upsertSessionJiraTicket({ sessionId: b.id, key: "OTHER-3", title: "Ledger", status: "To Do", statusCategory: "new" });
  stampLink(a.id, "MISSION-1", "2026-03-01T00:00:00.000Z");
  stampLink(a.id, "OTHER-2", "2026-02-01T00:00:00.000Z");
  stampLink(b.id, "OTHER-3", "2026-01-01T00:00:00.000Z");
  const { press, cleanup } = await mount([a.id, b.id], null);
  try {
    (await press("t"), await press("t"));
    expect(await press("/")).toContain("type to filter · enter keep · esc clear");
    // `q` is text, not "back": the view stays open and filters on the ticket title.
    const q = await press("Q");
    expect(q).toContain('Jira tickets · 1 of 3 · 1 session · 0 done · "Q"');
    expect(q).toContain("MISSION-1");
    expect(q).not.toContain("OTHER-2");
    const qj = await press("j");
    expect(qj).toContain('0 of 3');
    expect(qj).toContain('"Qj"');
    expect(qj).toContain("No tickets match the filters.");
    // Backspace deletes; `g` is text too, so the session isn't opened.
    expect(await press("\x7f")).toContain('"Q"');
    expect(await press("\x7f")).toContain("3 of 3");
    const billing = await press("bILLing");
    expect(billing).toContain('1 of 3 · 1 session · 0 done · "bILLing"');
    expect(billing).toContain("OTHER-3");
    expect(billing).toContain("Billing revamp");
    // Enter keeps the filter and returns to navigation: shortcuts work again.
    const kept = await press("\r");
    expect(kept).toContain('"bILLing"');
    expect(kept).toContain("/ search");
    // Search the session id, then esc clears it and returns to navigation.
    await press("/");
    for (let i = 0; i < "bILLing".length; i++) await press("\x7f");
    const byId = await press(a.id);
    expect(byId).toContain(`2 of 3 · 1 session · 0 done · "${a.id}"`);
    const cleared = await press("\u001b");
    expect(cleared).toContain("Jira tickets · 3 of 3 · 2 sessions · 0 done");
    expect(cleared).toContain("/ search");
    // Navigation again: j moves, q leaves the view.
    expect(rowOf(await press("j"), "OTHER-2")).toContain("❯");
    expect(await press("q")).toContain("Tack ·");
  } finally {
    cleanup();
    deleteSession(a.id);
    deleteSession(b.id);
  }
});

test("tickets view P polls the filtered entries' sessions, archived ones included", async () => {
  const prs = await import("../src/projects/prs");
  const jira = await import("../src/projects/jira");
  const a = createSession({});
  const b = createSession({});
  upsertSessionJiraTicket({ sessionId: a.id, key: "MISSION-1", status: "To Do", statusCategory: "new" });
  upsertSessionJiraTicket({ sessionId: b.id, key: "MISSION-2", status: "To Do", statusCategory: "new" });
  setSessionStatus(b.id, "archived");
  const spies = [
    spyOn(prs, "refreshSessionPrs").mockResolvedValue({ ghMissing: true } as never),
    spyOn(jira, "refreshSessionJiraTickets").mockResolvedValue({ tickets: [], skipped: [], unavailable: false }),
  ];
  const poll = spies[1]!;
  const config = { projects: [], prWatch: { intervalSeconds: 3600, enabled: false }, jira: { siteUrl: "https://example.atlassian.net" } } as unknown as TackConfig;
  const { press, cleanup } = await mount([a.id, b.id], config);
  try {
    // The background poll keeps its on-screen scope.
    expect(poll).toHaveBeenLastCalledWith(config, [a.id]);
    (await press("t"), await press("t"));
    await press("P");
    expect(new Set(poll.mock.lastCall![1] as string[])).toEqual(new Set([a.id, b.id]));
    await press("a");
    await press("P");
    expect(poll).toHaveBeenLastCalledWith(config, [a.id]);
    await press("/");
    await press("nothing-matches");
    await press("\r");
    const calls = poll.mock.calls.length;
    expect(await press("P")).toContain("no tickets match the filters — nothing to poll");
    expect(poll.mock.calls.length).toBe(calls);
  } finally {
    cleanup();
    for (const spy of spies) spy.mockRestore();
    deleteSession(a.id);
    deleteSession(b.id);
  }
});

test("ticket helpers sort open work first, newest link first, and filter", () => {
  const row = (key: string, sessionId: string, category: string | null, created: string, extra: Partial<repositories.JiraTicketWithSessionRow> = {}) => ({
    id: `jira_${key}`, session_id: sessionId, agent_id: null, key, url: null, title: null, status: null,
    status_category: category, created_at: created, updated_at: created,
    session_title: null, session_status: "active" as const, session_created_at: created, ...extra,
  });
  const entries = ticketEntries([
    row("A-1", "ses_a", "done", "2026-03-01"),
    row("A-2", "ses_a", "new", "2026-01-01"),
    row("B-1", "ses_b", null, "2026-02-01", { session_status: "archived", session_title: "Old work" }),
    row("B-2", "ses_b", "indeterminate", "2026-01-15", { session_status: "archived" }),
  ], []);
  expect(entries.map(e => e.ticket.key)).toEqual(["B-2", "B-1", "A-2", "A-1"]);
  expect(entries[0]!.view).toBeUndefined();
  expect(entries[1]!.session).toEqual({ id: "ses_b", title: "Old work", status: "archived", created_at: "2026-02-01" });
  const keys = (filter: Partial<typeof DEFAULT_TICKET_FILTER>) =>
    filterTicketEntries(entries, { ...DEFAULT_TICKET_FILTER, ...filter }).map(e => e.ticket.key);
  expect(keys({})).toEqual(["B-2", "B-1", "A-2", "A-1"]);
  expect(keys({ status: "open" })).toEqual(["B-2", "B-1", "A-2"]);
  expect(keys({ status: "in_progress" })).toEqual(["B-2"]);
  expect(keys({ status: "todo" })).toEqual(["B-1", "A-2"]);
  expect(keys({ status: "done" })).toEqual(["A-1"]);
  expect(keys({ hideArchived: true })).toEqual(["A-2", "A-1"]);
  expect(keys({ text: "old WORK" })).toEqual(["B-1"]);
  expect(keys({ text: "a-" })).toEqual(["A-2", "A-1"]);
  expect(keys({ text: "SES_B" })).toEqual(["B-2", "B-1"]);
  const cycle = ["all"] as string[];
  for (let i = 0; i < 5; i++) cycle.push(nextTicketStatusFilter(cycle.at(-1) as typeof DEFAULT_TICKET_FILTER.status));
  expect(cycle).toEqual(["all", "open", "in_progress", "todo", "done", "all"]);
  expect(describeTicketFilters(DEFAULT_TICKET_FILTER)).toBe("");
  expect(describeTicketFilters({ status: "open", hideArchived: true, text: "MISSION" })).toBe('status: open · archived hidden · "MISSION"');
});

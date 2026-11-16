import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { Dashboard, describeJiraPoll } from "../src/cli/dashboard";
import type { TackConfig } from "../src/config/schema";
import type { JiraRefreshResult } from "../src/projects/jira";
import { createSession, deleteSession, getSession, upsertSessionJiraTicket } from "../src/db";
import * as repositories from "../src/db/repositories";

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
      input.write("J");
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
  const list = spyOn(repositories, "listSessions").mockImplementation(() => sessionIds.map(id => getSession(id)!));
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
  return { app, press, cleanup: () => { app.unmount(); list.mockRestore(); } };
}

test("dashboard t lists tickets across sessions, open work first, and esc returns", async () => {
  const a = createSession({});
  const b = createSession({});
  upsertSessionJiraTicket({ sessionId: a.id, key: "MISSION-1", title: "Shipped thing", status: "Done", statusCategory: "done" });
  upsertSessionJiraTicket({ sessionId: b.id, key: "MISSION-2", title: "Busy thing", status: "In Progress", statusCategory: "indeterminate" });
  upsertSessionJiraTicket({ sessionId: a.id, key: "MISSION-3", title: "Later thing", status: "To Do", statusCategory: "new" });
  const { press, cleanup } = await mount([a.id, b.id], null);
  try {
    const view = await press("t");
    expect(view).toContain("Jira tickets · 3 tickets across 2 sessions · 1 done");
    const row = (key: string) => view.split("\n").find(line => line.includes(key)) ?? "";
    expect(row("MISSION-2")).toContain(b.id);
    expect(row("MISSION-2")).toContain("● In Progress");
    expect(row("MISSION-1")).toContain(a.id);
    expect(row("MISSION-1")).toContain("✔ Done");
    expect(row("MISSION-3")).toContain(a.id);
    // In progress, then to do, then done.
    expect(view.indexOf("MISSION-2")).toBeLessThan(view.indexOf("MISSION-3"));
    expect(view.indexOf("MISSION-3")).toBeLessThan(view.indexOf("MISSION-1"));
    expect(row("MISSION-2")).toContain("❯");
    expect(view).toContain("g go to session");
    // Moving to the to-do ticket and jumping to its session lands on that session.
    await press("j");
    const list = await press("g");
    expect(list).toContain(`❯ ○ ${a.id}`);
    expect(list).toContain("t tickets");
    await press("t");
    const back = await press("\u001b");
    expect(back).toContain("Tack ·");
    expect(back).not.toContain("Jira tickets ·");
    // q backs out of the view instead of quitting.
    await press("t");
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
    const view = await press("t");
    expect(view).toContain("Jira tickets · 0 tickets across 0 sessions");
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
    expect(await press("P")).toContain("config is unavailable");
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
    await press("t");
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
  for (let n = 1; n <= 30; n++) upsertSessionJiraTicket({ sessionId: s.id, key: `MISSION-${n}`, title: "A long title ".repeat(10), status: "To Do", statusCategory: "new" });
  const list = spyOn(repositories, "listSessions").mockImplementation(() => [getSession(s.id)!]);
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
    const first = await press("t");
    expect(first).toContain("Jira tickets · 30 tickets");
    expect(first).toContain("↓");
    expect(first).toContain("esc/q back");
    for (let i = 0; i < 19; i++) await press("j");
    const middle = await press("j");
    expect(middle).toMatch(/❯ MISSION-21 /);
    expect(middle).toContain("↑");
    expect(middle).toContain("↓");
  } finally {
    app.unmount();
    list.mockRestore();
    deleteSession(s.id);
  }
});

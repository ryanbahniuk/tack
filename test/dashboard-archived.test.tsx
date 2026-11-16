import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import { createAgent, createSession, deleteSession, getSession, setAgentStatus, setSessionStatus, upsertSessionPr } from "../src/db";
import * as repositories from "../src/db/repositories";
import * as tmux from "../src/session/tmux";
import type { TackConfig } from "../src/config/schema";

test("many archived sessions keep the window, indicators and background polls bounded", async () => {
  const prs = await import("../src/projects/prs");
  const jira = await import("../src/projects/jira");
  const active = createSession({ title: "active one" });
  const archived = Array.from({ length: 200 }, (_, i) => createSession({ title: `archived ${i}` }));
  for (const s of archived) setSessionStatus(s.id, "archived");
  // The fifth archived session has expanded detail when selected.
  const detailed = archived[4]!;
  for (let i = 0; i < 3; i++) setAgentStatus(createAgent({ sessionId: detailed.id, projectName: "p" }).id, "stopped");
  upsertSessionPr({ sessionId: detailed.id, url: "https://example.com/pr/9", state: "merged", number: 9 });
  const ids = [active.id, ...archived.map((s) => s.id)];
  const prIds: string[][] = [];
  const jiraIds: string[][] = [];
  const spies = [
    spyOn(repositories, "listSessions").mockImplementation((showArchived) =>
      ids.map((id) => getSession(id)!).filter((s) => showArchived || s.status === "active")),
    spyOn(prs, "refreshSessionPrs").mockImplementation(async (_config, sessionIds) => {
      prIds.push([...sessionIds]);
      return { ghMissing: true } as never;
    }),
    spyOn(jira, "refreshSessionJiraTickets").mockImplementation(async (_config, sessionIds) => {
      jiraIds.push([...sessionIds]);
      return { unavailable: false } as never;
    }),
  ];
  const tmuxList = spyOn(tmux, "tmuxListSessions").mockReturnValue(new Set());
  const config = { projects: [], personas: [], prWatch: { intervalSeconds: 1, enabled: false } } as unknown as TackConfig;
  const output = new PassThrough();
  Object.assign(output, { columns: 120, rows: 20, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", (chunk) => { frame = stripVTControlCharacters(chunk.toString()); });
  const app = render(<Dashboard config={config} onLaunch={() => {}} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const press = async (key: string) => {
    frame = "";
    input.write(key);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.waitUntilRenderFlush();
    return frame;
  };
  const sessionRows = (text: string) => text.split("\n").filter((line) => /ses_/.test(line));
  try {
    await app.waitUntilRenderFlush();
    let text = await press("z");
    expect(text.split("\n")[0]).toContain("(all) · 201 sessions");
    expect(text).toContain(`❯ ○ ${active.id}`);
    expect(text).toContain("↓ ");
    expect(text).not.toContain("↑ ");
    expect(text.split("\n").length).toBeLessThanOrEqual(19);
    // Rows outside the window are never rendered.
    expect(text).not.toContain(archived[150]!.id);

    // Move onto the detailed archived session (index 5 overall).
    for (let i = 0; i < 4; i++) await press("j");
    text = await press("j");
    expect(text).toContain(`❯ ○ ${detailed.id}`);
    expect(text).toContain("└─ PR 9");
    expect(text.match(/├─ Agent/g)).toHaveLength(3);
    expect(text).toMatch(/↓ \d+ more/);
    expect(text.split("\n").length).toBeLessThanOrEqual(19);

    // One keypress per write: Ink reads a burst like "jjj" as a single input.
    for (let i = 0; i < 96; i++) text = await press("j");
    const selected = sessionRows(text).find((line) => line.includes("❯"))!;
    expect(selected).toContain(archived[100]!.id);
    const above = Number(text.match(/↑ (\d+) more/)?.[1]);
    const below = Number(text.match(/↓ (\d+) more/)?.[1]);
    // Every session is either visible or counted by exactly one indicator.
    expect(above + below + sessionRows(text).length).toBe(201);
    expect(text).not.toContain("stale");

    // Archived sessions never reach the background polls, and an archived-only
    // stale check never lists tmux.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    for (const batch of [...prIds, ...jiraIds]) expect(batch).toEqual([active.id]);
    expect(prIds.length).toBeGreaterThan(1);
    tmuxList.mockClear();
    setSessionStatus(active.id, "archived");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(tmuxList).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    for (const s of spies) s.mockRestore();
    tmuxList.mockRestore();
    for (const id of ids) deleteSession(id);
  }
}, 30_000);

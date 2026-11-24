import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { Dashboard, wrapTitle } from "../src/cli/dashboard";
import {
  createAgent, createAmendment, createSession, deleteSession, getDb, getSession, setSessionPrFixEnabled,
  upsertSessionJiraTicket, upsertSessionPr,
} from "../src/db";
import * as repositories from "../src/db/repositories";

const COLUMNS = 140;
const ROWS = 30;
const LIST_WIDTH = Math.floor(COLUMNS * 0.55);

async function mount(ids: string[]) {
  const list = spyOn(repositories, "listSessions").mockImplementation(() => ids.map(id => getSession(id)!));
  const output = new PassThrough();
  Object.assign(output, { columns: COLUMNS, rows: ROWS, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame = stripVTControlCharacters(chunk.toString()); });
  const app = render(<Dashboard config={null} onLaunch={() => {}} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  await app.waitUntilRenderFlush();
  const listPane = () => frame.trimEnd().split("\n").map(line => line.slice(0, LIST_WIDTH).trimEnd());
  return {
    frame: () => frame.trimEnd(),
    listPane,
    cleanup: () => {
      app.unmount();
      list.mockRestore();
      for (const id of ids) deleteSession(id);
    },
  };
}

test("wrapTitle collapses whitespace, wraps by display width and ellipsizes past three lines", () => {
  expect(wrapTitle("  \n ", 20)).toEqual([]);
  expect(wrapTitle("fix\n\n  the   thing", 20)).toEqual(["fix the thing"]);
  expect(wrapTitle("one two three four five six seven eight", 10)).toEqual(["one two", "three four", "five six…"]);
  for (const line of wrapTitle("界".repeat(40), 9)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(9);
});

test("split dashboard shows the start of an unselected session's title ahead of its secondary badges", async () => {
  const selected = createSession({ title: "Selected session" });
  const busy = createSession({ title: "Readable busy title that should not be hidden" });
  for (let n = 1; n <= 3; n++) {
    upsertSessionPr({ sessionId: busy.id, url: `https://github.com/acme/repo/pull/${n}`, state: "open", number: n });
    upsertSessionJiraTicket({ sessionId: busy.id, key: `MISSION-${n}`, status: "In Progress", statusCategory: "indeterminate" });
  }
  createAmendment({ sessionId: busy.id, proposedBy: createAgent({ sessionId: busy.id, projectName: "test" }).id, proposalRef: "/tmp/proposal.md" });
  setSessionPrFixEnabled(busy.id, false);
  getDb().prepare(`UPDATE sessions SET pr_watch_pid = ?, jira_watch_pid = ? WHERE id = ?`).run(process.pid, process.pid, busy.id);
  const ui = await mount([selected.id, busy.id]);
  try {
    const row = ui.listPane().find(line => line.includes(busy.id))!;
    expect(row).toContain("Readable busy title");
    expect(row.indexOf("Readable")).toBeLessThan(row.indexOf(busy.id) + 40);
    expect(row).toEndWith("…");
  } finally {
    ui.cleanup();
  }
});

test("selected session's long title wraps onto at most three indented lines within the frame height", async () => {
  const title = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const session = createSession({ title });
  const ui = await mount([session.id]);
  try {
    const pane = ui.listPane();
    const summary = pane.findIndex(line => line.includes(`❯ ● ${session.id}`) || line.includes(`❯ ○ ${session.id}`));
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(pane[summary]).not.toContain("word0");
    const titleLines = pane.slice(summary + 1, summary + 4);
    expect(titleLines[0]).toStartWith("    word0 word1");
    for (const line of titleLines) expect(line).toStartWith("    word");
    expect(titleLines[2]).toEndWith("…");
    expect(pane[summary + 4] ?? "").not.toContain("word");
    expect(ui.frame().split("\n").length).toBeLessThanOrEqual(ROWS);
  } finally {
    ui.cleanup();
  }
});

test("selected session with an empty title renders no title line", async () => {
  const session = createSession({ title: "   " });
  const other = createSession({ title: "Next session" });
  const ui = await mount([session.id, other.id]);
  try {
    const pane = ui.listPane();
    const summary = pane.findIndex(line => line.includes(session.id));
    expect(pane[summary + 1]).toContain(other.id);
  } finally {
    ui.cleanup();
  }
});

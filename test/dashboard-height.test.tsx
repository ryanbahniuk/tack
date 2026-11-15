import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { Dashboard, dashboardBodyHeight, windowSessionLines, wrapFooter } from "../src/cli/dashboard";
import { createAgent, createSession, deleteSession, setAgentStatus, upsertSessionPr } from "../src/db";
import * as repositories from "../src/db/repositories";

test("body budget reserves the header, wrapped footer, margin and a spare row", () => {
  expect(dashboardBodyHeight(30, 160, ["x".repeat(180)])).toBe(25);
  expect(dashboardBodyHeight(30, 160, ["notice", "gh missing", "jira unavailable", "x".repeat(180)])).toBe(22);
  expect(dashboardBodyHeight(4, 10, ["x".repeat(100)])).toBe(0);
  expect(wrapFooter("hello world", 8)).toEqual(["hello", "world"]);
  expect(wrapFooter("界界界", 4)).toEqual(["界界", "界"]);
});

test("session window keeps every cursor visible with bounded expanded detail and indicators", () => {
  for (const height of [1, 2, 3, 5, 10, 30]) {
    for (let cursor = 0; cursor < 40; cursor++) {
      const counts = Array.from({ length: 40 }, (_, i) => i === cursor ? 20 : 1);
      const window = windowSessionLines(counts, cursor, height);
      expect(window.start).toBeLessThanOrEqual(cursor);
      expect(window.end).toBeGreaterThan(cursor);
      expect(window.end - window.start + Number(window.above > 0) + Number(window.below > 0)).toBeLessThanOrEqual(height);
      if (height >= 3 && height <= 10 && cursor > 0 && cursor < 39) {
        expect(window.above).toBeGreaterThan(0);
        expect(window.below).toBeGreaterThan(0);
      }
    }
  }
  expect(windowSessionLines([1, 3, 1], 1, 5)).toEqual({ start: 0, end: 5, above: 0, below: 0 });
  expect(windowSessionLines([1, 20, 1], 1, 0).end).toBe(1);
});

test("short dashboard fits split, list and insights frames while navigating overflowing sessions", async () => {
  const sessions = Array.from({ length: 45 }, () => createSession({ title: "A long session title ".repeat(20) }));
  for (let i = 0; i < 35; i++) {
    const agent = createAgent({ sessionId: sessions[0]!.id, projectName: "test" });
    setAgentStatus(agent.id, "done");
  }
  upsertSessionPr({ sessionId: sessions[0]!.id, url: "https://example.com/a/very/long/pr/url", state: "merged", number: 30 });
  const list = spyOn(repositories, "listSessions").mockReturnValue(sessions);
  const output = new PassThrough() as PassThrough & { columns: number; rows: number };
  Object.assign(output, { columns: 160, rows: 30, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  const frames: { text: string; rows: number }[] = [];
  output.on("data", chunk => {
    frame = chunk.toString();
    frames.push({ text: stripVTControlCharacters(frame).trimEnd(), rows: output.rows });
  });
  const app = render(<Dashboard config={null} onLaunch={() => {}} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const checkFrame = () => {
    const text = stripVTControlCharacters(frame).trimEnd();
    expect(text.split("\n")[0]).toContain("Tack ·");
    expect(text.split("\n").length).toBeLessThanOrEqual(output.rows - 1);
    expect(text.includes("q quit") || text.includes("(y/N)")).toBe(true);
    return text;
  };
  const press = async (key: string) => {
    frame = "";
    input.write(key);
    await new Promise(resolve => setTimeout(resolve, 25));
    await app.waitUntilRenderFlush();
    return checkFrame();
  };
  try {
    await app.waitUntilRenderFlush();
    const first = checkFrame();
    expect(first).toContain("split");
    expect(first).toContain(`❯ ○ ${sessions[0]!.id}`);
    expect(first).toContain("↓ 44 more");
    expect(first).toContain("Insights");
    for (let i = 0; i < 25; i++) await press("j");
    const middle = await press("j");
    expect(middle).toContain(`❯ ○ ${sessions[26]!.id}`);
    expect(middle).toContain("↑");
    expect(middle).toContain("↓");
    expect(await press("s")).toContain("list-only");
    expect(await press("s")).toContain("Insights");
    expect(await press("s")).toContain("split");
    expect(await press("d")).toContain("Delete");
    await press("n");
    frame = "";
    Object.assign(output, { columns: 40, rows: 12 });
    output.emit("resize");
    await new Promise(resolve => setTimeout(resolve, 25));
    await app.waitUntilRenderFlush();
    checkFrame();
    for (const rendered of frames) {
      expect(rendered.text.split("\n")[0]).toContain("Tack ·");
      expect(rendered.text.split("\n").length).toBeLessThanOrEqual(rendered.rows - 1);
    }
  } finally {
    app.unmount();
    list.mockRestore();
    for (const session of sessions) deleteSession(session.id);
  }
});

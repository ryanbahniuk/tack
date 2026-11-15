import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import { createSession, deleteSession } from "../src/db";
import * as repositories from "../src/db/repositories";

test("dashboard animates working rows with elapsed time and stops repainting when idle", async () => {
  const sessions = Array.from({ length: 5 }, () => createSession({}));
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  let rows = sessions.map((session, i) => ({
    ...session,
    pid: process.pid,
    supervisor_turn_started_at: i < 3 ? new Date(now - [12, 180, 3900][i]! * 1000).toISOString() : null,
    awaiting_input_at: null as string | null,
  }));
  // A pending plan still needs input even with a turn marker set.
  rows[4] = { ...rows[4]!, supervisor_turn_started_at: new Date(now).toISOString(), awaiting_input_at: new Date(now).toISOString() };
  const list = spyOn(repositories, "listSessions").mockImplementation(() => rows);
  const output = new PassThrough();
  Object.assign(output, { columns: 240, rows: 30, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  let renders = 0;
  output.on("data", chunk => {
    frame = stripVTControlCharacters(chunk.toString());
    renders++;
  });
  const app = render(<Dashboard config={null} onLaunch={() => {}} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    await app.waitUntilRenderFlush();
    expect(frame.split("\n")[0]).toContain("5 live · 3 working");
    const row = (id: string) => frame.split("\n").find(line => line.includes(id))!;
    for (const [i, elapsed] of ["12s", "3m", "1h5m"].entries()) {
      expect(row(sessions[i]!.id)).toMatch(new RegExp(`⠋ working ${elapsed}`));
      expect(row(sessions[i]!.id)).not.toContain("ago");
    }
    expect(row(sessions[3]!.id)).not.toContain("working");
    expect(row(sessions[4]!.id)).not.toContain("working");
    expect(row(sessions[4]!.id)).toContain("◆ needs input");
    const first = row(sessions[0]!.id);
    await new Promise(resolve => setTimeout(resolve, 180));
    await app.waitUntilRenderFlush();
    expect(row(sessions[0]!.id)).not.toBe(first);

    rows = rows.map(session => ({ ...session, supervisor_turn_started_at: null }));
    await new Promise(resolve => setTimeout(resolve, 1100));
    await app.waitUntilRenderFlush();
    expect(frame.split("\n")[0]).toContain("5 live · 0 working");
    expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] working/);
    const idleRenders = renders;
    await new Promise(resolve => setTimeout(resolve, 300));
    await app.waitUntilRenderFlush();
    expect(renders).toBe(idleRenders);
  } finally {
    app.unmount();
    list.mockRestore();
    clock.mockRestore();
    for (const session of sessions) deleteSession(session.id);
  }
});

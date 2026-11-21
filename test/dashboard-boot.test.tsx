import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import { createAgent, createSession, deleteSession } from "../src/db";
import * as repositories from "../src/db/repositories";
import type { TackConfig } from "../src/config/schema";

test("dashboard displays boot badge, chooses worktrees, and confirms unboot", async () => {
  const session = createSession({});
  const dir = mkdtempSync(join(tmpdir(), "tack-dashboard-boot-"));
  const a = { ...createAgent({ sessionId: session.id, projectName: "web" }), worktree_path: dir };
  const b = { ...createAgent({ sessionId: session.id, projectName: "web" }), worktree_path: dir };
  const spies = [
    spyOn(repositories, "listSessions").mockReturnValue([session]),
    spyOn(repositories, "listAgentsBySession").mockReturnValue(new Map([[session.id, [a, b]]])),
    spyOn(repositories, "listBootProjectsBySession").mockReturnValue(new Map([[session.id, ["web"]]])),
  ];
  const config = { projects: [{ name: "web", boot: { run: "sleep 30" } }], prWatch: { intervalSeconds: 3600, enabled: false } } as unknown as TackConfig;
  const output = new PassThrough(); Object.assign(output, { columns: 240, rows: 60, isTTY: false });
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = ""; output.on("data", chunk => { frame += chunk.toString(); });
  const app = render(<Dashboard config={config} onLaunch={() => {}} />, { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (key: string) => { frame = ""; input.write(key); await Bun.sleep(30); await app.waitUntilRenderFlush(); };
  try {
    await app.waitUntilRenderFlush(); expect(frame).toContain("booted: web");
    await press("S"); await press("b"); expect(frame).toContain("choose a worktree for web"); expect(frame).toContain(a.id); expect(frame).toContain(b.id);
    await press("q"); await press("S"); await press("B"); expect(frame).toContain(`Unboot ${session.id}? (y/N)`);
    await press("n"); expect(frame).toContain("cancelled");
  } finally { app.unmount(); for (const spy of spies) spy.mockRestore(); deleteSession(session.id); rmSync(dir, { recursive: true, force: true }); }
});

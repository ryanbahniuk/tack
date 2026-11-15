import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import { collapseHome } from "../src/paths";
import { createAgent, createSession, deleteSession } from "../src/db";
import * as repositories from "../src/db/repositories";

test("dashboard shows the worktree and requires y/Y to edit a running agent", async () => {
  const session = createSession({});
  const path = mkdtempSync(join(tmpdir(), "tack-dashboard-edit-"));
  const agent = { ...createAgent({ sessionId: session.id, projectName: "test" }), status: "running" as const, worktree_path: path };
  const list = spyOn(repositories, "listSessions").mockReturnValue([session]);
  const agents = spyOn(repositories, "listAgents").mockReturnValue([agent]);
  const output = new PassThrough();
  Object.assign(output, { columns: 240, rows: 60, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame += chunk.toString(); });
  const launches: Parameters<Parameters<typeof Dashboard>[0]["onLaunch"]>[0][] = [];
  const app = render(<Dashboard config={null} onLaunch={launch => launches.push(launch)} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const press = async (key: string) => {
    frame = "";
    input.write(key);
    await new Promise(resolve => setTimeout(resolve, 25));
    await app.waitUntilRenderFlush();
  };
  try {
    await app.waitUntilRenderFlush();
    await press("v");
    expect(frame).toContain(collapseHome(path));
    expect(frame).toContain("e edit worktree");
    await press("e");
    expect(frame).toContain(`Agent ${agent.id} is still running. Edit its worktree anyway? (y/N)`);
    await press("\r");
    expect(launches).toEqual([]);
    expect(frame).toContain("cancelled");
    await press("e");
    await press("Y");
    expect(launches).toEqual([{ kind: "edit", path, agentId: agent.id }]);
  } finally {
    app.unmount();
    list.mockRestore();
    agents.mockRestore();
    deleteSession(session.id);
    rmSync(path, { recursive: true, force: true });
  }
});

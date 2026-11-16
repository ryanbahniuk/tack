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
import type { TackConfig } from "../src/config/schema";

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

for (const insights of [false, true]) {
  test(`dashboard C edits config with zero sessions${insights ? " in insights" : ""}`, async () => {
    const list = spyOn(repositories, "listSessions").mockReturnValue([]);
    const output = new PassThrough();
    Object.assign(output, { columns: 100, rows: 30, isTTY: false });
    output.resume();
    const input = new PassThrough();
    Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const launches: Parameters<Parameters<typeof Dashboard>[0]["onLaunch"]>[0][] = [];
    const app = render(<Dashboard config={null} initialNotice="config unchanged" onLaunch={launch => launches.push(launch)} />, {
      stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await app.waitUntilRenderFlush();
      if (insights) {
        input.write("s");
        await Bun.sleep(25);
        await app.waitUntilRenderFlush();
      }
      input.write("C");
      await Bun.sleep(25);
      expect(launches).toEqual([{ kind: "config" }]);
    } finally { app.unmount(); list.mockRestore(); }
  });
}

test("dashboard n creates a manual workspace, choosing a project when several qualify", async () => {
  const prs = await import("../src/projects/prs");
  const jira = await import("../src/projects/jira");
  const session = createSession({});
  const worker = { ...createAgent({ sessionId: session.id, projectName: "beta" }), status: "done" as const };
  const manual = { ...worker, id: "agt_manualx", kind: "manual" as const, runtime: null, model: null, worktree_path: "/nowhere" };
  const spies = [
    spyOn(repositories, "listSessions").mockReturnValue([session]),
    spyOn(repositories, "listAgents").mockReturnValue([worker, manual]),
    spyOn(prs, "refreshSessionPrs").mockResolvedValue({ ghMissing: true } as never),
    spyOn(jira, "refreshSessionJiraTickets").mockResolvedValue({ unavailable: false } as never),
  ];
  const config = { projects: [{ name: "alpha" }, { name: "beta" }], prWatch: { intervalSeconds: 3600, enabled: false } } as unknown as TackConfig;
  const output = new PassThrough();
  Object.assign(output, { columns: 240, rows: 60, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame += chunk.toString(); });
  const launches: Parameters<Parameters<typeof Dashboard>[0]["onLaunch"]>[0][] = [];
  const app = render(<Dashboard config={config} onLaunch={launch => launches.push(launch)} />, {
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
    expect(frame).toContain("n new manual workspace");
    expect(frame).toContain(" manual ");
    expect(frame).not.toContain("null:null");
    await press("n");
    // The session's own project is offered first.
    expect(frame).toMatch(/❯ beta \(in this session\)[\s\S]*alpha/);
    await press("j");
    await press("\r");
    expect(launches).toEqual([{ kind: "manual", sessionId: session.id, project: "alpha" }]);
  } finally {
    app.unmount();
    for (const s of spies) s.mockRestore();
    deleteSession(session.id);
  }
});

test("a project chooser never survives its picker closing", async () => {
  const prs = await import("../src/projects/prs");
  const jira = await import("../src/projects/jira");
  const gone = createSession({});
  const other = createSession({});
  const worker = (sessionId: string) => ({ ...createAgent({ sessionId, projectName: "beta" }), status: "done" as const });
  const agentsBySession = new Map([[gone.id, [worker(gone.id)]], [other.id, [worker(other.id)]]]);
  const list = spyOn(repositories, "listSessions").mockReturnValue([gone, other]);
  const spies = [
    list,
    spyOn(repositories, "listAgents").mockImplementation(id => agentsBySession.get(id) ?? []),
    spyOn(prs, "refreshSessionPrs").mockResolvedValue({ ghMissing: true } as never),
    spyOn(jira, "refreshSessionJiraTickets").mockResolvedValue({ unavailable: false } as never),
  ];
  const config = { projects: [{ name: "alpha" }, { name: "beta" }], prWatch: { intervalSeconds: 3600, enabled: false } } as unknown as TackConfig;
  const output = new PassThrough();
  Object.assign(output, { columns: 240, rows: 60, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame += chunk.toString(); });
  const app = render(<Dashboard config={config} onLaunch={() => {}} />, {
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
    await press("n");
    expect(frame).toContain(`New manual workspace in ${gone.id}`);
    // The picker's session disappears mid-choice (deleted elsewhere); the 1s poll sees it.
    list.mockReturnValue([other]);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await press("x"); // any key while the picker has no session returns to the list
    await press("v");
    expect(frame).toContain(`Agents of ${other.id}`);
    expect(frame).not.toContain("New manual workspace");
  } finally {
    app.unmount();
    for (const s of spies) s.mockRestore();
    deleteSession(gone.id);
    deleteSession(other.id);
  }
});

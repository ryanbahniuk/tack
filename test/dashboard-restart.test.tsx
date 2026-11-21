import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import type { TackConfig } from "../src/config/schema";
import { createAgent, createSession, deleteSession, getDb, getSession, setAgentPid, setAgentStatus, setSessionStatus } from "../src/db";
import * as repositories from "../src/db/repositories";
import * as reconnect from "../src/session/restart";

async function mount(config: TackConfig) {
  const prs = await import("../src/projects/prs");
  const jira = await import("../src/projects/jira");
  const spies = [
    spyOn(prs, "refreshSessionPrs").mockResolvedValue({ ghMissing: true } as never),
    spyOn(jira, "refreshSessionJiraTickets").mockResolvedValue({ unavailable: false } as never),
  ];
  const output = new PassThrough();
  Object.assign(output, { columns: 400, rows: 60, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame += chunk.toString(); });
  const launches: Parameters<Parameters<typeof Dashboard>[0]["onLaunch"]>[0][] = [];
  const app = render(<Dashboard config={config} onLaunch={launch => launches.push(launch)} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  await app.waitUntilRenderFlush();
  const press = async (key: string) => {
    frame = "";
    input.write(key);
    await new Promise(resolve => setTimeout(resolve, 25));
    await app.waitUntilRenderFlush();
  };
  return { app, press, launches, frame: () => frame, restore: () => spies.forEach(s => s.mockRestore()) };
}

const config = { projects: [], prWatch: { intervalSeconds: 3600, enabled: false } } as unknown as TackConfig;

for (const [plan, park] of [[false, { parked: true }], [true, { parked: true }], [false, { parked: false, reason: "no-tmux" }]] as const) {
  test(`dashboard w confirms reconnect${plan ? " with a pending plan" : ""}, then parks ${park.parked ? "in tmux" : "nothing without tmux"} and stays open`, async () => {
    const session = createSession({});
    if (plan) getDb().prepare(`UPDATE sessions SET awaiting_input_at = ?, awaiting_reason = 'plan' WHERE id = ?`).run("2026-01-01T00:00:00Z", session.id);
    const orphan = createAgent({ sessionId: session.id, projectName: "p" });
    setAgentStatus(orphan.id, "running"); setAgentPid(orphan.id, 999_999);
    const done = createAgent({ sessionId: session.id, projectName: "p" });
    setAgentStatus(done.id, "done");
    const list = spyOn(repositories, "listSessions").mockImplementation(() => [getSession(session.id)!]);
    const result = { supervisorRestarted: true, wasStale: false, wasMidTurn: false, planPending: plan, revivedAgents: [orphan.id], failedAgents: [], watcherRestarted: false };
    const run = spyOn(reconnect, "restartSession").mockResolvedValue(result);
    const parkSpy = spyOn(reconnect, "parkRestartedSupervisor").mockResolvedValue(park);
    const ui = await mount(config);
    try {
      await ui.press("S"); await ui.press("r");
      expect(ui.frame()).toContain(`Restart ${session.id}? Restarts the supervisor detached in tmux, revives 1 dropped agent(s)${plan ? " · pending plan will be re-presented" : ""}. (y/N)`);
      await ui.press("n");
      expect(run).not.toHaveBeenCalled();
      await ui.press("S"); await ui.press("r");
      await ui.press("y");
      await new Promise(resolve => setTimeout(resolve, 25));
      await ui.app.waitUntilRenderFlush();
      expect(run).toHaveBeenCalledWith(session.id, config);
      expect(parkSpy).toHaveBeenCalledWith(session.id, config);
      expect(ui.launches).toEqual([]);
      const summary = `${session.id}: ${reconnect.describeRestart(result)}`;
      expect(ui.frame()).toContain(park.parked ? `${summary} · parked in tmux · enter to attach` : `${summary} · tmux unavailable, supervisor stopped · enter to resume`);
    } finally {
      ui.app.unmount();
      ui.restore();
      list.mockRestore();
      run.mockRestore();
      parkSpy.mockRestore();
      deleteSession(session.id);
    }
  });
}

test("dashboard w refuses archived sessions", async () => {
  const session = createSession({});
  setSessionStatus(session.id, "archived");
  const list = spyOn(repositories, "listSessions").mockImplementation(() => [getSession(session.id)!]);
  const run = spyOn(reconnect, "restartSession");
  const ui = await mount(config);
  try {
    await ui.press("S"); await ui.press("r");
    expect(ui.frame()).toContain(`${session.id} is archived`);
    expect(ui.frame()).not.toContain("Restart ");
    expect(run).not.toHaveBeenCalled();
  } finally {
    ui.app.unmount();
    ui.restore();
    list.mockRestore();
    run.mockRestore();
    deleteSession(session.id);
  }
});

test("dashboard w does nothing and r shows only applicable restart clauses", async () => {
  const session = createSession({});
  getDb().prepare(`UPDATE sessions SET supervisor_turn_started_at = 'now' WHERE id = ?`).run(session.id);
  const list = spyOn(repositories, "listSessions").mockImplementation(() => [getSession(session.id)!]);
  const ui = await mount(config);
  try {
    await ui.press("w");
    expect(ui.frame()).not.toContain(`Restart ${session.id}?`);
    await ui.press("S"); await ui.press("r");
    expect(ui.frame()).toContain("interrupts the current turn");
    expect(ui.frame()).not.toContain("revives ");
    expect(ui.frame()).not.toContain("pending plan will be re-presented");
    expect(ui.frame()).not.toContain("onto new Tack code (stale)");
  } finally { ui.app.unmount(); ui.restore(); list.mockRestore(); deleteSession(session.id); }
});

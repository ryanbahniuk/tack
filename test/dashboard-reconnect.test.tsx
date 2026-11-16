import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import type { TackConfig } from "../src/config/schema";
import { createAgent, createSession, deleteSession, getDb, getSession, setAgentPid, setAgentStatus, setSessionStatus } from "../src/db";
import * as repositories from "../src/db/repositories";
import * as reconnect from "../src/session/reconnect";

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

for (const plan of [false, true]) {
  test(`dashboard w confirms reconnect${plan ? " with a pending plan" : ""}, then hands off with the reconnect message`, async () => {
    const session = createSession({});
    if (plan) getDb().prepare(`UPDATE sessions SET awaiting_input_at = ?, awaiting_reason = 'plan' WHERE id = ?`).run("2026-01-01T00:00:00Z", session.id);
    const orphan = createAgent({ sessionId: session.id, projectName: "p" });
    setAgentStatus(orphan.id, "running"); setAgentPid(orphan.id, 999_999);
    const done = createAgent({ sessionId: session.id, projectName: "p" });
    setAgentStatus(done.id, "done");
    const list = spyOn(repositories, "listSessions").mockImplementation(() => [getSession(session.id)!]);
    const run = spyOn(reconnect, "reconnectSession").mockResolvedValue({ supervisorRestarted: true, planPending: plan, revivedAgents: [orphan.id], failedAgents: [], watcherRestarted: false });
    const ui = await mount(config);
    try {
      await ui.press("w");
      expect(ui.frame()).toContain(`Reconnect ${session.id}? Restarts the supervisor and revives 1 dropped agent(s).${plan ? " Pending plan will be re-presented." : ""} (y/N)`);
      await ui.press("n");
      expect(run).not.toHaveBeenCalled();
      await ui.press("w");
      await ui.press("y");
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(run).toHaveBeenCalledWith(session.id, config);
      expect(ui.launches).toEqual([{ kind: "resume", id: session.id, message: reconnect.RECONNECT_MESSAGE }]);
    } finally {
      ui.app.unmount();
      ui.restore();
      list.mockRestore();
      run.mockRestore();
      deleteSession(session.id);
    }
  });
}

test("dashboard w refuses archived sessions", async () => {
  const session = createSession({});
  setSessionStatus(session.id, "archived");
  const list = spyOn(repositories, "listSessions").mockImplementation(() => [getSession(session.id)!]);
  const run = spyOn(reconnect, "reconnectSession");
  const ui = await mount(config);
  try {
    await ui.press("w");
    expect(ui.frame()).toContain(`${session.id} is archived`);
    expect(ui.frame()).not.toContain("Reconnect ");
    expect(run).not.toHaveBeenCalled();
  } finally {
    ui.app.unmount();
    ui.restore();
    list.mockRestore();
    run.mockRestore();
    deleteSession(session.id);
  }
});

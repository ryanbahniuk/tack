import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import { createAgent, createSession, deleteSession, getSession, markAgentInterrupted, setAgentStatus, setSessionStatus } from "../src/db";
import * as repositories from "../src/db/repositories";
import * as detached from "../src/agent/detached";

for (const count of [0, 1]) {
  test(`dashboard confirms unarchive with ${count} interrupted agents and keeps selection`, async () => {
    const session = createSession({});
    setSessionStatus(session.id, "archived");
    if (count) {
      const agent = createAgent({ sessionId: session.id, projectName: "test" });
      markAgentInterrupted(agent.id);
      setAgentStatus(agent.id, "stopped");
    }
    const list = spyOn(repositories, "listSessions").mockImplementation(showArchived => {
      const row = getSession(session.id)!;
      return showArchived || row.status !== "archived" ? [row] : [];
    });
    const spawn = spyOn(detached, "spawnAgentRunner").mockReturnValue(123);
    const output = new PassThrough();
    Object.assign(output, { columns: 200, rows: 60, isTTY: false });
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
      await press("z");
      await press("a");
      expect(frame).toContain(`Unarchive ${session.id}${count ? " and resume 1 interrupted agent(s)" : ""}? (y/N)`);
      expect(getSession(session.id)?.status).toBe("archived");
      await press("\r");
      expect(getSession(session.id)?.status).toBe("archived");
      expect(spawn).not.toHaveBeenCalled();
      await press("a");
      await press("y");
      expect(frame).toContain(`unarchived ${session.id} · resumed ${count} agent(s) · enter to rejoin supervisor`);
      expect(spawn).toHaveBeenCalledTimes(count);
      expect(launches).toEqual([]);
      await press("o");
      expect(launches).toEqual([{ kind: "resume", id: session.id }]);
    } finally {
      app.unmount();
      list.mockRestore();
      spawn.mockRestore();
      deleteSession(session.id);
    }
  });
}

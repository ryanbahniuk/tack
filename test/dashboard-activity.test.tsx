import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import { createAgent, createSession, deleteSession, setAgentPid, setAgentStatus } from "../src/db";
import * as repositories from "../src/db/repositories";
import * as tmux from "../src/session/tmux";
import * as prs from "../src/projects/prs";
import * as jira from "../src/projects/jira";

test("session dot tracks agent activity and input requests", async () => {
  const session = createSession({});
  const agent = createAgent({ sessionId: session.id, projectName: "p" });
  setAgentPid(agent.id, process.pid);
  setAgentStatus(agent.id, "running");
  let row = { ...session, pid: null, awaiting_input_at: null as string | null };
  const spies = [
    spyOn(repositories, "listSessions").mockImplementation(() => [row]),
    spyOn(tmux, "tmuxListSessions").mockReturnValue(new Set()),
    spyOn(prs, "refreshSessionPrs").mockImplementation(async () => ({ ghMissing: true }) as never),
    spyOn(jira, "refreshSessionJiraTickets").mockImplementation(async () => ({ unavailable: false }) as never),
  ];
  const output = new PassThrough();
  Object.assign(output, { columns: 120, rows: 30, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", (chunk) => { frame = stripVTControlCharacters(chunk.toString()); });
  const app = render(<Dashboard config={null} onLaunch={() => {}} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const sessionLine = () => frame.split("\n").find((line) => line.includes(session.id))!;
  try {
    await app.waitUntilRenderFlush();
    expect(sessionLine()).toContain(`● ${session.id}`);
    setAgentStatus(agent.id, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await app.waitUntilRenderFlush();
    expect(sessionLine()).toContain(`○ ${session.id}`);
    row = { ...row, awaiting_input_at: new Date().toISOString() };
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await app.waitUntilRenderFlush();
    expect(sessionLine()).toContain(`● ${session.id}`);
    expect(sessionLine()).toContain("◆ needs input");
  } finally {
    app.unmount();
    for (const spy of spies) spy.mockRestore();
    deleteSession(session.id);
  }
}, 15_000);

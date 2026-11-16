import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import { createSession, deleteSession, getSession, upsertSessionJiraTicket } from "../src/db";
import * as repositories from "../src/db/repositories";

// No config means no `jira` siteUrl, so a ticket linked without a url can't open.
for (const tickets of [0, 2]) {
  test(`dashboard J explains ${tickets ? "unlinkable tickets" : "no tickets"}`, async () => {
    const session = createSession({});
    for (let n = 1; n <= tickets; n++) upsertSessionJiraTicket({ sessionId: session.id, key: `MISSION-${n}`, url: null });
    const list = spyOn(repositories, "listSessions").mockImplementation(() => [getSession(session.id)!]);
    const output = new PassThrough();
    Object.assign(output, { columns: 300, rows: 60, isTTY: false });
    const input = new PassThrough();
    Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    let frame = "";
    output.on("data", chunk => { frame += chunk.toString(); });
    const app = render(<Dashboard config={null} onLaunch={() => {}} />, {
      stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await app.waitUntilRenderFlush();
      frame = "";
      input.write("J");
      await new Promise(resolve => setTimeout(resolve, 25));
      await app.waitUntilRenderFlush();
      expect(frame).toContain(tickets
        ? `${session.id} has 2 tickets but no Jira site is configured — add a \`jira\` block (siteUrl) to your Tack config`
        : `${session.id} has no tickets yet`);
    } finally {
      app.unmount();
      list.mockRestore();
      deleteSession(session.id);
    }
  });
}

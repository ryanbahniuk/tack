import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import { createSession, deleteSession, getSession, setSessionAwaitingInput, setSessionStatus } from "../src/db";
import * as repositories from "../src/db/repositories";

test("hold sorts last and dashboard toggles it while refusing archived sessions", async () => {
  const [active, held, archived] = Array.from({ length: 3 }, () => createSession({}));
  setSessionStatus(held!.id, "on_hold");
  setSessionAwaitingInput(held!.id, "plan");
  setSessionStatus(archived!.id, "archived");
  const ids = [held!.id, active!.id, archived!.id];
  const list = spyOn(repositories, "listSessions").mockImplementation(all => ids.map(id => getSession(id)!).filter(s => all || s.status !== "archived"));
  const output = new PassThrough();
  Object.assign(output, { columns: 200, rows: 60, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame = stripVTControlCharacters(chunk.toString()); });
  const app = render(<Dashboard config={null} onLaunch={() => {}} />, {
    stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const press = async (key: string) => {
    frame = ""; input.write(key);
    await new Promise(resolve => setTimeout(resolve, 30));
    await app.waitUntilRenderFlush();
  };
  try {
    await app.waitUntilRenderFlush();
    expect(frame.indexOf(active!.id)).toBeLessThan(frame.indexOf(held!.id));
    await press("h");
    expect(getSession(active!.id)?.status).toBe("on_hold");
    expect(frame).toContain(`put ${active!.id} on hold`);
    await press("j");
    await press("h");
    expect(getSession(active!.id)?.status).toBe("active");
    expect(frame).toContain(`${active!.id} off hold`);
    await press("z");
    await press("j");
    await press("h");
    expect(getSession(archived!.id)?.status).toBe("archived");
    expect(frame).toContain(`${archived!.id} is archived · a to unarchive`);
  } finally {
    app.unmount(); list.mockRestore();
    for (const id of ids) deleteSession(id);
  }
});

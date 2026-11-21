import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import type { TackConfig } from "../src/config/schema";
import { createSession, deleteSession, getSession, setSessionReadme } from "../src/db";
import * as repositories from "../src/db/repositories";
import * as readme from "../src/session/readme";
import * as opener from "../src/cli/open-url";
import * as clipboard from "../src/cli/clipboard";

const config = { projects: [], personas: [], readme: { publisher: "local" }, prWatch: { intervalSeconds: 3600, enabled: false } } as unknown as TackConfig;
const URL = "file:///tmp/tack/readme.html";

async function mount(opts: { url: string | null; copyOk?: boolean }) {
  const session = createSession({});
  if (opts.url) setSessionReadme(session.id, { ref: null, url: opts.url });
  const prs = await import("../src/projects/prs");
  const jira = await import("../src/projects/jira");
  const spies = {
    list: spyOn(repositories, "listSessions").mockImplementation(() => [getSession(session.id)!]),
    prs: spyOn(prs, "refreshSessionPrs").mockResolvedValue({ ghMissing: true } as never),
    jira: spyOn(jira, "refreshSessionJiraTickets").mockResolvedValue({ unavailable: false } as never),
    readmer: spyOn(readme, "spawnSessionReadmer").mockImplementation((() => {}) as never),
    open: spyOn(opener, "openUrl").mockImplementation(() => {}),
    copy: spyOn(clipboard, "copyToClipboard").mockResolvedValue(opts.copyOk ?? true),
  };
  const output = new PassThrough();
  Object.assign(output, { columns: 400, rows: 60, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame += stripVTControlCharacters(chunk.toString()); });
  const app = render(<Dashboard config={config} onLaunch={() => {}} />, {
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
  const cleanup = () => {
    app.unmount();
    Object.values(spies).forEach(s => s.mockRestore());
    deleteSession(session.id);
  };
  return { id: session.id, press, spies, frame: () => frame, cleanup };
}

test("D opens the README menu and esc closes it", async () => {
  const ui = await mount({ url: URL });
  try {
    await ui.press("S"); await ui.press("D");
    expect(ui.frame()).toContain(`README actions · ${ui.id}`);
    expect(ui.frame()).toContain(URL);
    expect(ui.frame()).toContain("r  Refresh (regenerate)");
    expect(ui.frame()).toContain("o  Open in browser");
    expect(ui.frame()).toContain("c  Copy link to clipboard");
    expect(ui.frame()).toContain("j/k move · enter select · r/o/c · esc/q cancel");
    await ui.press("\u001b");
    expect(ui.frame()).toContain("cancelled");
    expect(ui.frame()).not.toContain(`README actions · ${ui.id}`);
  } finally { ui.cleanup(); }
});

test("r confirms before regenerating; n cancels, y spawns the readmer", async () => {
  const ui = await mount({ url: URL });
  try {
    await ui.press("S"); await ui.press("D");
    await ui.press("r");
    expect(ui.frame()).toContain(`Generate a README for ${ui.id} and save it locally? (y/N)`);
    await ui.press("n");
    expect(ui.spies.readmer).not.toHaveBeenCalled();
    await ui.press("S"); await ui.press("D");
    await ui.press("r");
    await ui.press("y");
    expect(ui.spies.readmer).toHaveBeenCalledWith(ui.id);
    expect(ui.frame()).toContain(`generating README for ${ui.id}`);
  } finally { ui.cleanup(); }
});

test("enter on the highlighted option selects it (j moves to Open)", async () => {
  const ui = await mount({ url: URL });
  try {
    await ui.press("S"); await ui.press("D");
    await ui.press("j");
    await ui.press("\r");
    expect(ui.spies.open).toHaveBeenCalledWith(URL);
    expect(ui.frame()).toContain(`opened README for ${ui.id} in browser`);
  } finally { ui.cleanup(); }
});

test("o opens the README url", async () => {
  const ui = await mount({ url: URL });
  try {
    await ui.press("S"); await ui.press("D");
    await ui.press("o");
    expect(ui.spies.open).toHaveBeenCalledWith(URL);
    expect(ui.frame()).toContain(`opened README for ${ui.id} in browser`);
  } finally { ui.cleanup(); }
});

for (const ok of [true, false]) {
  test(`c copies the README url${ok ? "" : " and shows the link when no tool exists"}`, async () => {
    const ui = await mount({ url: URL, copyOk: ok });
    try {
      await ui.press("S"); await ui.press("D");
      await ui.press("c");
      expect(ui.spies.copy).toHaveBeenCalledWith(URL);
      expect(ui.frame()).toContain(ok ? `copied README link for ${ui.id}` : `no clipboard tool found · ${URL}`);
    } finally { ui.cleanup(); }
  });
}

test("without a README, open and copy only show a notice", async () => {
  const ui = await mount({ url: null });
  try {
    await ui.press("S"); await ui.press("D");
    expect(ui.frame()).toContain("(not generated yet)");
    await ui.press("o");
    expect(ui.frame()).toContain("no README yet · S → D → r to generate");
    await ui.press("S"); await ui.press("D");
    await ui.press("c");
    expect(ui.frame()).toContain("no README yet · S → D → r to generate");
    expect(ui.spies.open).not.toHaveBeenCalled();
    expect(ui.spies.copy).not.toHaveBeenCalled();
  } finally { ui.cleanup(); }
});

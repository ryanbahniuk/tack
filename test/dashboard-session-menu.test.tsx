import { expect, spyOn, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { Dashboard } from "../src/cli/dashboard";
import type { TackConfig } from "../src/config/schema";
import {
  createSession, deleteSession, getSession, getSessionPr, listSessionPrs, setSessionPrFixEnabled,
  setSessionPrFixEnabledForPr, upsertSessionPr,
} from "../src/db";
import * as repositories from "../src/db/repositories";
import * as opener from "../src/cli/open-url";
import * as clipboard from "../src/cli/clipboard";
import * as prwatch from "../src/prwatch/watch";
import * as review from "../src/session/review";

const URL_BASE = "https://github.com/acme/app/pull";

async function mount(opts: { prs: number; copyOk?: boolean; personas?: string[]; sessionFixOff?: boolean; prFixOff?: number[]; empty?: boolean }) {
  const config = {
    projects: [], personas: (opts.personas ?? []).map(name => ({ name, description: name })),
    readme: { publisher: "local" }, prWatch: { intervalSeconds: 3600, enabled: true },
  } as unknown as TackConfig;
  const session = createSession({});
  for (let n = 1; n <= opts.prs; n++)
    upsertSessionPr({ sessionId: session.id, url: `${URL_BASE}/${n}`, number: n, title: `Change ${n}`, state: "open", projectName: "app", headBranch: `b${n}` });
  const prRows = listSessionPrs(session.id).sort((a, b) => a.number! - b.number!);
  // Flags are set before the first render; the dashboard only re-snapshots every second.
  if (opts.sessionFixOff) setSessionPrFixEnabled(session.id, false);
  for (const n of opts.prFixOff ?? []) setSessionPrFixEnabledForPr(prRows[n - 1]!.id, false);
  const prs = await import("../src/projects/prs");
  const jira = await import("../src/projects/jira");
  const spies = {
    list: spyOn(repositories, "listSessions").mockImplementation(() => opts.empty ? [] : [getSession(session.id)!]),
    prs: spyOn(prs, "refreshSessionPrs").mockResolvedValue({ ghMissing: true } as never),
    jira: spyOn(jira, "refreshSessionJiraTickets").mockResolvedValue({ unavailable: false } as never),
    open: spyOn(opener, "openUrl").mockImplementation(() => {}),
    copy: spyOn(clipboard, "copyToClipboard").mockResolvedValue(opts.copyOk ?? true),
    trigger: spyOn(prwatch, "triggerPrWatch").mockResolvedValue({ kind: "signalled", pid: 42 }),
    review: spyOn(review, "startRemoteReview").mockReturnValue({ persona: "strict", reviews: [{}] } as never),
  };
  const output = new PassThrough();
  Object.assign(output, { columns: 400, rows: 60, isTTY: false });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  output.on("data", chunk => { frame += stripVTControlCharacters(chunk.toString()); });
  const launches: unknown[] = [];
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
  const cleanup = () => {
    app.unmount();
    Object.values(spies).forEach(s => s.mockRestore());
    deleteSession(session.id);
  };
  const initial = frame;
  return { launches, id: session.id, prs: prRows, config, press, spies, frame: () => frame, initial, cleanup };
}

test("session actions show labels, refuse missing amendments, and open README", async () => {
  const ui = await mount({ prs: 0 });
  try {
    await ui.press("S");
    expect(ui.frame()).toContain(`Session actions · ${ui.id}`);
    expect(ui.frame()).toContain("View amendments (0)");
    expect(ui.frame()).toContain("Hold (turns PR auto-fix off)");
    expect(ui.frame()).toContain("Archive");
    await ui.press("m"); expect(ui.frame()).toContain("has no pending amendments");
    await ui.press("S"); await ui.press("D"); expect(ui.frame()).toContain(`README actions · ${ui.id}`);
    await ui.press("q"); expect(ui.frame()).toContain("cancelled");
    await ui.press("S"); await ui.press("x"); expect(ui.frame()).toContain(`Stop ${ui.id}`);
    await ui.press("n"); await ui.press("S"); await ui.press("d"); expect(ui.frame()).toContain(`Delete ${ui.id}`);
  } finally { ui.cleanup(); }
});

test("S without a session offers creation", async () => {
  const ui = await mount({ prs: 0, empty: true });
  try { await ui.press("S"); expect(ui.frame()).toContain("no session selected · c to create one"); }
  finally { ui.cleanup(); }
});

test("new session action hands off creation", async () => {
  const ui = await mount({ prs: 0 });
  try {
    await ui.press("S"); await ui.press("c");
    expect(ui.launches).toEqual([{ kind: "create" }]);
  } finally { ui.cleanup(); }
});

test("archived sessions refuse restart and hold and show unarchive", async () => {
  const ui = await mount({ prs: 0 });
  try {
    await ui.press("a"); await ui.press("z"); await ui.press("S");
    expect(ui.frame()).toContain("Unarchive");
    await ui.press("r"); expect(ui.frame()).toContain("is archived · a to unarchive");
    await ui.press("S"); await ui.press("h"); expect(ui.frame()).toContain("is archived · a to unarchive");
  } finally { ui.cleanup(); }
});

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

async function mount(opts: { prs: number; copyOk?: boolean; personas?: string[]; sessionFixOff?: boolean; prFixOff?: number[] }) {
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
    list: spyOn(repositories, "listSessions").mockImplementation(() => [getSession(session.id)!]),
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
  const initial = frame;
  return { id: session.id, prs: prRows, config, press, spies, frame: () => frame, initial, cleanup };
}

test("p with no PRs shows a notice instead of the menu", async () => {
  const ui = await mount({ prs: 0 });
  try {
    await ui.press("p");
    expect(ui.frame()).toContain(`${ui.id} has no PRs yet`);
    expect(ui.frame()).not.toContain("Open in browser");
  } finally { ui.cleanup(); }
});

test("one PR skips the target step and shows the PR header and url", async () => {
  const ui = await mount({ prs: 1 });
  try {
    await ui.press("p");
    expect(ui.frame()).not.toContain("All PRs");
    expect(ui.frame()).toContain("#1 · Change 1");
    expect(ui.frame()).toContain(`${URL_BASE}/1`);
    for (const label of ["o  Open in browser", "c  Copy link", "p  Poll now", "R  Review with persona…", "f  Auto-fix: on → turn off"])
      expect(ui.frame()).toContain(label);
    expect(ui.frame()).toContain("j/k move · enter select · o/c/p/R/f · esc/q cancel");
    await ui.press("\u001b");
    expect(ui.frame()).toContain("cancelled");
    expect(ui.frame()).not.toContain("Poll now");
  } finally { ui.cleanup(); }
});

test("several PRs show the target step; All PRs opens every PR", async () => {
  const ui = await mount({ prs: 2, prFixOff: [2] });
  try {
    await ui.press("p");
    expect(ui.frame()).toContain("All PRs (2)");
    expect(ui.frame()).toContain("#1 Change 1 · app · open");
    expect(ui.frame()).toContain("#2 Change 2 · app · open · pr-fix off");
    await ui.press("\r");
    expect(ui.frame()).toContain(`PRs · ${ui.id}`);
    await ui.press("o");
    expect(ui.spies.open.mock.calls).toEqual([[`${URL_BASE}/1`], [`${URL_BASE}/2`]]);
    expect(ui.frame()).toContain("opened 2 PRs in browser");
  } finally { ui.cleanup(); }
});

test("a single PR target opens only that PR (j + enter picks it)", async () => {
  const ui = await mount({ prs: 2 });
  try {
    await ui.press("p");
    await ui.press("j");
    await ui.press("j");
    await ui.press("\r");
    expect(ui.frame()).toContain("#2 · Change 2");
    await ui.press("\r"); // cursor on the first action, Open
    expect(ui.spies.open.mock.calls).toEqual([[`${URL_BASE}/2`]]);
    expect(ui.frame()).toContain("opened #2 in browser");
  } finally { ui.cleanup(); }
});

for (const ok of [true, false]) {
  test(`copy works for one PR${ok ? "" : " and shows the link without a clipboard tool"}`, async () => {
    const ui = await mount({ prs: 1, copyOk: ok });
    try {
      await ui.press("p");
      await ui.press("c");
      expect(ui.spies.copy).toHaveBeenCalledWith(`${URL_BASE}/1`);
      expect(ui.frame()).toContain(ok ? "copied link for #1" : `no clipboard tool found · ${URL_BASE}/1`);
    } finally { ui.cleanup(); }
  });
}

test("copy is refused for All PRs", async () => {
  const ui = await mount({ prs: 2 });
  try {
    await ui.press("p");
    await ui.press("\r");
    await ui.press("c");
    expect(ui.frame()).toContain("pick a single PR to copy its link");
    expect(ui.spies.copy).not.toHaveBeenCalled();
  } finally { ui.cleanup(); }
});

test("poll is scoped to the chosen PR, or session-wide for All PRs", async () => {
  const ui = await mount({ prs: 2 });
  try {
    await ui.press("p");
    await ui.press("j");
    await ui.press("\r");
    await ui.press("p");
    expect(ui.spies.trigger).toHaveBeenLastCalledWith(ui.id, ui.config, undefined, { prId: ui.prs[0]!.id });
    expect(ui.frame()).toContain("polling PRs for #1 · signalled watcher pid 42");
    await ui.press("p");
    await ui.press("\r");
    await ui.press("p");
    expect(ui.spies.trigger).toHaveBeenLastCalledWith(ui.id, ui.config, undefined, { prId: undefined });
    expect(ui.frame()).toContain(`polling PRs for ${ui.id} · signalled watcher pid 42`);
  } finally { ui.cleanup(); }
});

test("review routes through the persona picker and carries prId", async () => {
  const ui = await mount({ prs: 2, personas: ["strict"] });
  try {
    await ui.press("p");
    await ui.press("j");
    await ui.press("j");
    await ui.press("\r");
    await ui.press("R");
    expect(ui.frame()).toContain(`Review ${ui.id} · #2 · choose a persona`);
    await ui.press("\r");
    expect(ui.spies.review).toHaveBeenCalledWith(ui.config, ui.id, { persona: "strict", prId: ui.prs[1]!.id });
    expect(ui.frame()).toContain("started 1 review(s)");
  } finally { ui.cleanup(); }
});

test("review without personas shows a notice", async () => {
  const ui = await mount({ prs: 1 });
  try {
    await ui.press("p");
    await ui.press("R");
    expect(ui.frame()).toContain("no personas configured");
    expect(ui.spies.review).not.toHaveBeenCalled();
  } finally { ui.cleanup(); }
});

test("toggle on a single PR flips only that PR's flag", async () => {
  const ui = await mount({ prs: 2 });
  try {
    await ui.press("p");
    await ui.press("j");
    await ui.press("\r");
    await ui.press("f");
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(getSessionPr(ui.prs[0]!.id)!.pr_fix_enabled).toBe(0);
    expect(getSessionPr(ui.prs[1]!.id)!.pr_fix_enabled).toBe(1);
    expect(getSession(ui.id)!.pr_fix_enabled).toBe(1);
    expect(ui.frame()).toContain("PR auto-fix off for #1");
    expect(ui.frame()).toContain("pr-fix off"); // the expanded PR detail line
  } finally { ui.cleanup(); }
});

test("turning a PR on while the session is off still sets it and says so", async () => {
  const ui = await mount({ prs: 1, sessionFixOff: true, prFixOff: [1] });
  try {
    await ui.press("p");
    expect(ui.frame()).toContain("f  Auto-fix: off → turn on");
    await ui.press("f");
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(getSessionPr(ui.prs[0]!.id)!.pr_fix_enabled).toBe(1);
    expect(getSession(ui.id)!.pr_fix_enabled).toBe(0);
    expect(ui.spies.trigger).toHaveBeenCalledWith(ui.id, ui.config, undefined, { prId: ui.prs[0]!.id });
    expect(ui.frame()).toContain("on for #1, but session auto-fix is off · toggle from All PRs");
  } finally { ui.cleanup(); }
});

test("All PRs toggle flips the session flag and leaves PR flags alone", async () => {
  const ui = await mount({ prs: 2 });
  try {
    await ui.press("p");
    await ui.press("\r");
    expect(ui.frame()).toContain("f  Auto-fix: on → turn off");
    await ui.press("f");
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(getSession(ui.id)!.pr_fix_enabled).toBe(0);
    expect(ui.prs.map(pr => getSessionPr(pr.id)!.pr_fix_enabled)).toEqual([1, 1]);
    expect(ui.frame()).toContain(`PR auto-fix off for ${ui.id}`);
  } finally { ui.cleanup(); }
});

test("the old O, R and F shortcuts no longer act", async () => {
  const ui = await mount({ prs: 1, personas: ["strict"] });
  try {
    expect(ui.initial).toContain("p PR actions");
    expect(ui.initial).not.toContain("O open PR");
    for (const key of ["O", "R", "F"]) await ui.press(key);
    expect(ui.spies.open).not.toHaveBeenCalled();
    expect(ui.frame()).not.toContain("choose a persona");
    expect(getSession(ui.id)!.pr_fix_enabled).toBe(1);
  } finally { ui.cleanup(); }
});

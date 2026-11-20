import { expect, test } from "bun:test";
import { copyToClipboard } from "../src/cli/clipboard";

/** Records each attempted command; succeeds only for the named binaries. */
function recorder(working: string[], opts: { throwFor?: string } = {}) {
  const calls: { cmd: string[]; text: string }[] = [];
  const spawn = async (cmd: string[], text: string) => {
    calls.push({ cmd, text });
    if (cmd[0] === opts.throwFor) throw new Error("boom");
    return working.includes(cmd[0]!);
  };
  return { calls, spawn };
}

test("darwin uses pbcopy and writes the text", async () => {
  const r = recorder(["pbcopy"]);
  expect(await copyToClipboard("https://x", { platform: "darwin", spawn: r.spawn })).toBe(true);
  expect(r.calls).toEqual([{ cmd: ["pbcopy"], text: "https://x" }]);
});

test("win32 uses clip", async () => {
  const r = recorder(["clip"]);
  expect(await copyToClipboard("u", { platform: "win32", spawn: r.spawn })).toBe(true);
  expect(r.calls.map(c => c.cmd)).toEqual([["clip"]]);
});

test("linux prefers wl-copy", async () => {
  const r = recorder(["wl-copy", "xclip", "xsel"]);
  expect(await copyToClipboard("u", { platform: "linux", spawn: r.spawn })).toBe(true);
  expect(r.calls.map(c => c.cmd)).toEqual([["wl-copy"]]);
});

test("linux falls back wl-copy → xclip → xsel in order", async () => {
  const r = recorder(["xsel"], { throwFor: "xclip" });
  expect(await copyToClipboard("u", { platform: "linux", spawn: r.spawn })).toBe(true);
  expect(r.calls.map(c => c.cmd)).toEqual([["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]);
});

test("other platforms use the linux chain; all failing resolves false", async () => {
  const r = recorder([]);
  expect(await copyToClipboard("u", { platform: "freebsd", spawn: r.spawn })).toBe(false);
  expect(r.calls).toHaveLength(3);
});

test("darwin failure resolves false without trying linux tools", async () => {
  const r = recorder([]);
  expect(await copyToClipboard("u", { platform: "darwin", spawn: r.spawn })).toBe(false);
  expect(r.calls.map(c => c.cmd)).toEqual([["pbcopy"]]);
});

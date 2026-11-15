import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalWritePath, decideWrite, writeGuardDecision } from "../src/supervisor/write-guard";
import { supervisorArtifactsDir, supervisorCwd, TACK_HOME } from "../src/paths";

const cwd = mkdtempSync(join(tmpdir(), "tack-write-guard-"));
const dir = join(cwd, "artifacts");
const outside = join(cwd, "outside");
mkdirSync(dir);
mkdirSync(outside);
writeFileSync(join(dir, "page.html"), "page");
symlinkSync(outside, join(dir, "escape"));
symlinkSync(dir, join(cwd, "alias"));
symlinkSync(join(outside, "missing"), join(dir, "dangling"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function decision(path: unknown, over: object = {}) {
  return writeGuardDecision(JSON.stringify({ cwd, tool_input: { file_path: path }, ...over }), [dir]);
}

describe("supervisor page write guard", () => {
  test("artifacts helper is strictly below the supervisor cwd", () => {
    expect(supervisorCwd("ses_test")).toBe(join(TACK_HOME, "supervisor", "ses_test"));
    expect(supervisorArtifactsDir("ses_test")).toBe(join(supervisorCwd("ses_test"), "artifacts"));
  });

  test.each(["page.html", "new/nested/page.html"])("allows existing or new in-dir page %s", (path) => {
    expect(decision(join(dir, path)).permissionDecision).toBe("allow");
  });

  test("resolves relative paths against hook cwd, including notebook_path", () => {
    expect(decision("artifacts/page.html").permissionDecision).toBe("allow");
    expect(decision(undefined, { tool_input: { notebook_path: "artifacts/page.ipynb" } }).permissionDecision).toBe("allow");
    expect(decision("page.html", { cwd: dir }).permissionDecision).toBe("allow");
  });

  test.each([
    outside, dir, `${dir}-sibling/page.html`, `${dir}/../outside/page.html`,
    `${dir}/escape/page.html`, `${dir}/dangling`, `${dir}/escape/../page.html`,
    join(cwd, ".claude/settings.local.json"),
  ])("denies escape or non-descendant %s", (path) => {
    const result = decision(path);
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain(dir);
    expect(result.permissionDecisionReason).toContain("publishable pages only");
  });

  test("canonicalizes allowed roots too (including macOS temp aliases)", () => {
    const input = { cwd, tool_input: { file_path: join(realpathSync(dir), "new.html") } };
    expect(decideWrite(input, [join(cwd, "alias")], canonicalWritePath).permissionDecision).toBe("allow");
    expect(decideWrite(input, [dir], canonicalWritePath).permissionDecision).toBe("allow");
  });

  test.each([undefined, null, 3, {}, "", "\0bad"])("denies missing or malformed path %j", (path) => {
    expect(decision(path).permissionDecision).toBe("deny");
  });

  test.each(["not JSON", "null", "[]", "{}", '{"tool_input":{}}'])("denies malformed stdin %s", (raw) => {
    expect(writeGuardDecision(raw, [dir]).permissionDecision).toBe("deny");
  });

  test("denies invalid cwd, missing roots and resolver errors", () => {
    expect(decision("artifacts/new.html", { cwd: "relative" }).permissionDecision).toBe("deny");
    const input = { cwd, tool_input: { file_path: join(dir, "page.html") } };
    expect(decideWrite(input, [], canonicalWritePath).permissionDecision).toBe("deny");
    expect(decideWrite(input, [join(dir, "missing")], canonicalWritePath).permissionDecision).toBe("deny");
    expect(decideWrite(input, [dir], () => { throw new Error("EACCES"); }).permissionDecision).toBe("deny");
  });

  test("hidden CLI emits only a decision JSON, including for non-JSON stdin", async () => {
    for (const raw of ["not JSON", JSON.stringify({ cwd, tool_input: { file_path: join(dir, "new.html") } })]) {
      const proc = Bun.spawn([process.execPath, "run", "./bin/tack.ts", "__guard-write", dir], {
        cwd: process.cwd(), env: { ...process.env, TACK_HOME: join(cwd, "tack-home") },
        stdin: new Blob([raw]), stdout: "pipe", stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", ...writeGuardDecision(raw, [dir]) },
      });
    }
  });
});

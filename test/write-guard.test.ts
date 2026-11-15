import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalWritePath, decideWrite, writeGuardDecision } from "../src/supervisor/write-guard";
import { supervisorArtifactsDir, supervisorCwd, TACK_HOME } from "../src/paths";

const cwd = mkdtempSync(join(tmpdir(), "tack-write-guard-"));
const dir = join(cwd, "artifacts");
const outside = join(cwd, "outside");
const claudeTmpRoot = join(cwd, "claude-tmp");
const uid = 123;
const sessionId = "claude-session-123";
const cwdSlug = cwd.replace(/[^A-Za-z0-9]/g, "-");
const scratchpad = join(claudeTmpRoot, `claude-${uid}`, cwdSlug, sessionId, "scratchpad");
mkdirSync(dir);
mkdirSync(outside);
mkdirSync(claudeTmpRoot);
writeFileSync(join(dir, "page.html"), "page");
symlinkSync(outside, join(dir, "escape"));
symlinkSync(dir, join(cwd, "alias"));
symlinkSync(join(outside, "missing"), join(dir, "dangling"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function decision(path: unknown, over: object = {}) {
  return writeGuardDecision(JSON.stringify({ cwd, tool_input: { file_path: path }, ...over }), [dir]);
}

function scratchpadDecision(path: string, over: object = {}, opts = { env: { CLAUDE_CODE_TMPDIR: claudeTmpRoot }, uid: uid as number | null }) {
  return writeGuardDecision(JSON.stringify({ cwd, session_id: sessionId, tool_input: { file_path: path }, ...over }), [dir], opts);
}

describe("supervisor page write guard", () => {
  test("allows this session's scratchpad even before its directory exists", () => {
    const missing = join(claudeTmpRoot, `claude-${uid}`, cwdSlug, "new-session", "scratchpad", "nested/page.html");
    expect(scratchpadDecision(missing, { session_id: "new-session" }).permissionDecision).toBe("allow");
    mkdirSync(scratchpad, { recursive: true });
    expect(scratchpadDecision(join(scratchpad, "page.html")).permissionDecision).toBe("allow");
  });

  test.each([
    join(claudeTmpRoot, `claude-${uid}`, cwdSlug, "another-session", "scratchpad/page.html"),
    join(claudeTmpRoot, `claude-${uid}`, `${cwdSlug}-other`, sessionId, "scratchpad/page.html"),
    `${scratchpad}/../page.html`,
    `${scratchpad}-sibling/page.html`,
    scratchpad,
  ])("denies another session, cwd or scratchpad escape %s", (path) => {
    expect(scratchpadDecision(path).permissionDecision).toBe("deny");
  });

  test.each(["../escape", "bad_session", "bad/session", "", null, 123])("skips scratchpad allowance for invalid session_id %j", (session_id) => {
    expect(scratchpadDecision(join(scratchpad, "page.html"), { session_id }).permissionDecision).toBe("deny");
  });

  test("honors CLAUDE_CODE_TMPDIR and canonicalizes its aliases", () => {
    const alias = join(cwd, "tmp-alias");
    symlinkSync(claudeTmpRoot, alias);
    const opts = { env: { CLAUDE_CODE_TMPDIR: alias }, uid };
    expect(scratchpadDecision(join(scratchpad, "page.html"), {}, opts).permissionDecision).toBe("allow");
    const otherTmp = join(cwd, "other-tmp");
    mkdirSync(otherTmp);
    expect(scratchpadDecision(join(scratchpad, "page.html"), {}, {
      env: { CLAUDE_CODE_TMPDIR: otherTmp }, uid,
    }).permissionDecision).toBe("deny");
  });

  test("denies scratchpad symlink escapes and dangling roots", () => {
    const sessionRoot = join(claudeTmpRoot, `claude-${uid}`, cwdSlug);
    mkdirSync(join(sessionRoot, "dangling-session"), { recursive: true });
    symlinkSync(join(outside, "missing"), join(sessionRoot, "dangling-session/scratchpad"));
    expect(scratchpadDecision(join(sessionRoot, "dangling-session/scratchpad/page.html"), {
      session_id: "dangling-session",
    }).permissionDecision).toBe("deny");
    mkdirSync(scratchpad, { recursive: true });
    symlinkSync(outside, join(scratchpad, "escape"));
    expect(scratchpadDecision(`${scratchpad}/escape/page.html`).permissionDecision).toBe("deny");
    expect(scratchpadDecision(`${scratchpad}/escape/../page.html`).permissionDecision).toBe("deny");
  });

  test("skips scratchpad without a uid and fails closed on an invalid temp root", () => {
    expect(scratchpadDecision(join(scratchpad, "page.html"), {}, {
      env: { CLAUDE_CODE_TMPDIR: claudeTmpRoot }, uid: null,
    }).permissionDecision).toBe("deny");
    expect(scratchpadDecision(join(dir, "page.html"), {}, {
      env: { CLAUDE_CODE_TMPDIR: join(cwd, "missing-tmp") }, uid,
    }).permissionDecision).toBe("deny");
  });

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
    expect(result.permissionDecisionReason).toContain("Write the page under");
    expect(result.permissionDecisionReason).toContain("and publish again");
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

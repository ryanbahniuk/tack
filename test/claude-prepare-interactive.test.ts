import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APPROVE_PROMPT_MARKER } from "../src/supervisor/approve-prompt";
import type { RunOptions } from "../src/runtimes/types";

const CLAUDE_TS = resolve(import.meta.dir, "../src/runtimes/claude.ts");

const MODEL = { key: "t", provider: "anthropic", name: "T", version: "1", runtime: "claude", id: "x" };

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Runs `prepareInteractive` in a child process with HOME pointed at a scratch dir.
 * Bun resolves `os.homedir()` once at startup (a runtime `process.env.HOME` change
 * is ignored), so a subprocess is the only way to guarantee the test never reads or
 * writes the developer's real `~/.claude.json`.
 */
function prepare(home: string, over: Partial<RunOptions>): void {
  const opts = {
    readOnly: true,
    model: MODEL,
    bin: "claude",
    prompt: "",
    mcpServers: [{ name: "tack-supervisor", command: "tack", args: [] }],
    ...over,
  };
  const code =
    `const { ClaudeRuntime } = await import(${JSON.stringify(CLAUDE_TS)});` +
    `new ClaudeRuntime().prepareInteractive(${JSON.stringify(opts)});`;
  const r = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

const localSettings = (cwd: string) => join(cwd, ".claude", "settings.local.json");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("ClaudeRuntime.prepareInteractive", () => {
  test("creates settings.local.json allowing the supervisor server, and records trust", () => {
    const home = tmp("tack-home-");
    const cwd = tmp("tack-cwd-");
    prepare(home, { cwd });
    expect(readJson(localSettings(cwd))).toEqual({
      permissions: { allow: ["mcp__tack-supervisor"] },
    });
    expect(readJson(join(home, ".claude.json")).projects[cwd].hasTrustDialogAccepted).toBe(true);
  });

  test("allows every mounted server, deduped", () => {
    const cwd = tmp("tack-cwd-");
    prepare(tmp("tack-home-"), {
      cwd,
      mcpServers: [
        { name: "tack-supervisor", command: "tack", args: [] },
        { name: "jira", command: "j", args: [] },
        { name: "jira", command: "j", args: [] },
      ],
    });
    expect(readJson(localSettings(cwd)).permissions.allow).toEqual([
      "mcp__tack-supervisor",
      "mcp__jira",
    ]);
  });

  test("merges into an existing file: keeps other keys and entries, dedupes", () => {
    const cwd = tmp("tack-cwd-");
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      localSettings(cwd),
      JSON.stringify({
        model: "keep-me",
        permissions: { allow: ["Bash(ls:*)", "mcp__tack-supervisor"], deny: ["WebFetch"] },
      }),
    );
    prepare(tmp("tack-home-"), {
      cwd,
      mcpServers: [
        { name: "tack-supervisor", command: "tack", args: [] },
        { name: "jira", command: "j", args: [] },
      ],
    });
    expect(readJson(localSettings(cwd))).toEqual({
      model: "keep-me",
      permissions: {
        allow: ["Bash(ls:*)", "mcp__tack-supervisor", "mcp__jira"],
        deny: ["WebFetch"],
      },
    });
  });

  test("is idempotent", () => {
    const home = tmp("tack-home-");
    const cwd = tmp("tack-cwd-");
    prepare(home, { cwd });
    prepare(home, { cwd });
    expect(readJson(localSettings(cwd)).permissions.allow).toEqual(["mcp__tack-supervisor"]);
  });

  test("never clobbers a corrupt or mis-shaped settings file", () => {
    for (const body of ["{ not json", "[]", '{"permissions": []}', '{"permissions": {"allow": "x"}}']) {
      const cwd = tmp("tack-cwd-");
      mkdirSync(join(cwd, ".claude"));
      writeFileSync(localSettings(cwd), body);
      prepare(tmp("tack-home-"), { cwd });
      expect(readFileSync(localSettings(cwd), "utf8")).toBe(body);
    }
  });

  test("a corrupt ~/.claude.json is left alone and doesn't block the allow rules", () => {
    const home = tmp("tack-home-");
    const cwd = tmp("tack-cwd-");
    writeFileSync(join(home, ".claude.json"), "{ corrupt");
    prepare(home, { cwd });
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe("{ corrupt");
    expect(readJson(localSettings(cwd)).permissions.allow).toEqual(["mcp__tack-supervisor"]);
  });

  test("writes no allow rules outside read-only", () => {
    const home = tmp("tack-home-");
    const cwd = tmp("tack-cwd-");
    prepare(home, { cwd, readOnly: false });
    expect(existsSync(localSettings(cwd))).toBe(false);
    // Trust is still recorded: it's about the TUI launching, not the posture.
    expect(readJson(join(home, ".claude.json")).projects[cwd].hasTrustDialogAccepted).toBe(true);
  });
});

test("writes and refreshes /approve only when the prompt hook is supplied", () => {
  const home = tmp("tack-home-");
  const cwd = tmp("tack-cwd-");
  const command = join(cwd, ".claude", "commands", "approve.md");
  prepare(home, { cwd });
  expect(existsSync(command)).toBe(false);

  const onUserPrompt = { command: "tack", args: ["__approve-prompt", "ses_x"] };
  prepare(home, { cwd, onUserPrompt });
  const body = readFileSync(command, "utf8");
  expect(body).toContain("description: Approve the supervisor's plan (use if the approval prompt didn't appear)");
  expect(body).toContain(APPROVE_PROMPT_MARKER);
  expect(body).toContain("Proceed to spawn agents per the plan.");

  writeFileSync(command, "stale command");
  prepare(home, { cwd, onUserPrompt, resume: true });
  expect(readFileSync(command, "utf8")).toBe(body);
});

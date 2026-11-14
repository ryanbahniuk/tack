import { describe, expect, test } from "bun:test";
import type { Model } from "../src/config/schema";
import { ClaudeRuntime, autoAllowMatcher } from "../src/runtimes/claude";
import type { RunOptions } from "../src/runtimes/types";

const MODEL = {
  key: "test",
  provider: "anthropic",
  name: "Test",
  version: "1",
  runtime: "claude",
  id: "claude-test",
} as unknown as Model;

const OPEN_PR = "mcp__tack-supervisor__open_pr";

type HookEntry = { matcher: string; hooks: Array<{ type: string; command: string }> };

function preToolUse(over: Partial<RunOptions> = {}): HookEntry[] {
  const { args } = new ClaudeRuntime().interactiveCommand({
    readOnly: true,
    model: MODEL,
    bin: "claude",
    cwd: "/tmp/x",
    prompt: "",
    mcpServers: [{ name: "tack-supervisor", command: "tack", args: [] }],
    ...over,
  });
  const i = args.indexOf("--settings");
  expect(i).toBeGreaterThan(-1);
  const settings = JSON.parse(args[i + 1]!);
  return settings.hooks?.PreToolUse ?? [];
}

/** The auto-allow entry: the one whose hook emits an `allow` decision. */
function allowEntry(entries: HookEntry[]): HookEntry {
  const found = entries.filter((e) =>
    e.hooks.some((h) => h.command.includes('"permissionDecision":"allow"')),
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("ClaudeRuntime.interactiveCommand auto-allow hook", () => {
  test("allows every tack-supervisor tool when there are no approval tools", () => {
    const entry = allowEntry(preToolUse());
    const re = new RegExp(entry.matcher);
    expect(re.test("mcp__tack-supervisor__check_agents")).toBe(true);
    expect(re.test(OPEN_PR)).toBe(true);
  });

  test("excludes approval tools, which keep their ask hook", () => {
    const entries = preToolUse({ approvalTools: [OPEN_PR] });
    const re = new RegExp(allowEntry(entries).matcher);
    expect(re.test("mcp__tack-supervisor__check_agents")).toBe(true);
    expect(re.test("mcp__tack-supervisor__spawn_agent")).toBe(true);
    expect(re.test(OPEN_PR)).toBe(false);
    // Only the exact tool is carved out, not anything sharing its prefix.
    expect(re.test(`${OPEN_PR}_draft`)).toBe(true);

    const ask = entries.find((e) => e.matcher === OPEN_PR);
    expect(ask).toBeDefined();
    expect(ask!.hooks[0]!.command).toContain('"permissionDecision":"ask"');
  });

  test("does not match another server's tools", () => {
    const re = new RegExp(allowEntry(preToolUse()).matcher);
    expect(re.test("mcp__other__check_agents")).toBe(false);
    expect(re.test("xmcp__tack-supervisor__check_agents")).toBe(false);
  });

  test("is supervisor-only: no allow hook outside readOnly", () => {
    const { args } = new ClaudeRuntime().interactiveCommand({
      model: MODEL,
      bin: "claude",
      cwd: "/tmp/x",
      prompt: "",
      mcpServers: [{ name: "tack-supervisor", command: "tack", args: [] }],
    });
    expect(args.join(" ")).not.toContain('"permissionDecision":"allow"');
  });
});

describe("autoAllowMatcher", () => {
  test("escapes regex metacharacters in server and tool names", () => {
    const re = new RegExp(autoAllowMatcher("a.b", ["mcp__a.b__x+y"]));
    expect(re.test("mcp__a.b__check")).toBe(true);
    expect(re.test("mcp__aXb__check")).toBe(false);
    expect(re.test("mcp__a.b__x+y")).toBe(false);
    expect(re.test("mcp__a.b__xxy")).toBe(true);
  });

  test("ignores approval tools from other servers", () => {
    expect(autoAllowMatcher("s", ["mcp__other__open_pr"])).toBe("^mcp__s__.*");
  });
});

describe("ClaudeRuntime.interactiveCommand prompt-submitted hook", () => {
  function settingsOf(over: Partial<RunOptions> = {}): { hooks?: Record<string, unknown> } | null {
    const { args } = new ClaudeRuntime().interactiveCommand({
      model: MODEL,
      bin: "claude",
      cwd: "/tmp/x",
      prompt: "",
      ...over,
    });
    const i = args.indexOf("--settings");
    return i === -1 ? null : JSON.parse(args[i + 1]!);
  }

  test("wires onPromptSubmitted as a matcher-less UserPromptSubmit hook", () => {
    const settings = settingsOf({
      onPromptSubmitted: { command: "/usr/bin/tack", args: ["__prompt-submitted", "ses_1"] },
    });
    expect(settings?.hooks?.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "'/usr/bin/tack' '__prompt-submitted' 'ses_1'" }] },
    ]);
  });

  test("rides the same --settings blob as the other hooks", () => {
    const settings = settingsOf({
      readOnly: true,
      mcpServers: [{ name: "tack-supervisor", command: "tack", args: [] }],
      onPromptSubmitted: { command: "tack", args: ["__prompt-submitted", "ses_1"] },
    });
    expect(settings?.hooks?.PreToolUse).toBeDefined();
    expect(settings?.hooks?.UserPromptSubmit).toBeDefined();
  });

  test("adds no UserPromptSubmit key when unset", () => {
    const settings = settingsOf({
      readOnly: true,
      mcpServers: [{ name: "tack-supervisor", command: "tack", args: [] }],
    });
    expect(settings?.hooks).toBeDefined();
    expect(settings!.hooks!).not.toHaveProperty("UserPromptSubmit");
  });

  test("omits --settings entirely when there are no hooks at all", () => {
    expect(settingsOf()).toBeNull();
  });
});

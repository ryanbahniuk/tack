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
const PLAN_APPROVAL = "mcp__tack-supervisor__request_plan_approval";

type HookEntry = { matcher: string; hooks: Array<{ type: string; command: string }> };

function settingsOf(over: Partial<RunOptions> = {}): any {
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
  return i === -1 ? undefined : JSON.parse(args[i + 1]!);
}

function preToolUse(over: Partial<RunOptions> = {}): HookEntry[] {
  const settings = settingsOf(over);
  expect(settings).toBeDefined();
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

  test("excludes the plan-approval tool, which keeps its own ask hook", () => {
    const entries = preToolUse({
      planApprovalTool: PLAN_APPROVAL,
      onPlanPresented: { command: "tack", args: ["__await-plan", "ses_x", "Proceed?"] },
    });
    const re = new RegExp(allowEntry(entries).matcher);
    expect(re.test("mcp__tack-supervisor__check_agents")).toBe(true);
    expect(re.test(PLAN_APPROVAL)).toBe(false);
    expect(entries.find((e) => e.matcher === PLAN_APPROVAL)).toBeDefined();
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

describe("ClaudeRuntime.interactiveCommand settings permissions", () => {
  test("the supervisor's --settings allows the tack-supervisor server", () => {
    expect(settingsOf().permissions.allow).toEqual(["mcp__tack-supervisor"]);
  });

  test("retains edit denies and both human gates alongside server-wide allows", () => {
    const settings = settingsOf({
      approvalTools: [OPEN_PR],
      planApprovalTool: PLAN_APPROVAL,
      onPlanPresented: { command: "tack", args: ["__await-plan", "ses_x", "Proceed?"] },
    });
    expect(settings.permissions).toEqual({
      deny: ["Edit", "Write", "NotebookEdit", "ExitPlanMode", "EnterPlanMode"],
      allow: ["mcp__tack-supervisor"],
      ask: [OPEN_PR, PLAN_APPROVAL],
    });
    const entries = settings.hooks.PreToolUse as HookEntry[];
    const allow = new RegExp(allowEntry(entries).matcher);
    expect(allow.test(PLAN_APPROVAL)).toBe(false);
    expect(allow.test(OPEN_PR)).toBe(false);
    expect(allow.test("mcp__tack-supervisor__sync_projects")).toBe(true);
    expect(entries.find((e) => e.matcher === PLAN_APPROVAL)?.hooks[0]?.command)
      .toContain("__await-plan");
  });

  test("keeps the --allowedTools flag alongside the settings rule", () => {
    const { args } = new ClaudeRuntime().interactiveCommand({
      readOnly: true,
      model: MODEL,
      bin: "claude",
      cwd: "/tmp/x",
      prompt: "",
      mcpServers: [{ name: "tack-supervisor", command: "tack", args: [] }],
    });
    const i = args.indexOf("--allowedTools");
    expect(args[i + 1]).toBe("mcp__tack-supervisor");
  });

  test("no allow rule outside readOnly", () => {
    const settings = settingsOf({ readOnly: false });
    expect(settings?.permissions?.allow).toBeUndefined();
  });

  test("open_pr keeps its ask hook and gains an ask rule when approvalTools are set", () => {
    const settings = settingsOf({ approvalTools: [OPEN_PR], approvalPrompt: "Open a PR for this?" });
    // The server-wide allow stays; the ask rule outranks it (deny → ask → allow).
    expect(settings.permissions.allow).toEqual(["mcp__tack-supervisor"]);
    expect(settings.permissions.ask).toEqual([OPEN_PR]);
    const ask = (settings.hooks.PreToolUse as HookEntry[]).find((e) => e.matcher === OPEN_PR);
    expect(ask!.hooks[0]!.command).toContain('"permissionDecision":"ask"');
    expect(ask!.hooks[0]!.command).toContain("Open a PR for this?");
  });

  test("no ask rule when approvalTools are unset (autoOpenPrs on)", () => {
    expect(settingsOf().permissions.ask).toBeUndefined();
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

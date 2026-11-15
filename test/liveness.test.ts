import { describe, expect, test } from "bun:test";
import { agentDisplayStatus, sessionNeedsInput } from "../src/cli/liveness";
import type { AgentRow, SessionRow } from "../src/db";

const before = "2026-11-14T10:00:00.000Z";
const seen = "2026-11-14T11:00:00.000Z";
const after = "2026-11-14T12:00:00.000Z";

const session = {
  awaiting_input_at: null,
  last_seen_at: seen,
} as unknown as SessionRow;

function agent(status: AgentRow["status"], finished_at: string | null = null, pid: number | null = null): AgentRow {
  return { status, finished_at, pid } as unknown as AgentRow;
}

describe("sessionNeedsInput", () => {
  test("a plan awaiting approval needs input even with a live agent", () => {
    expect(sessionNeedsInput({ ...session, awaiting_input_at: after }, [
      agent("running", null, process.pid),
    ])).toBe(true);
  });

  test("unread completed work waits while a sibling is pending", () => {
    expect(sessionNeedsInput(session, [agent("done", after), agent("pending")])).toBe(false);
  });

  test("unread completed work waits while a sibling has a live process", () => {
    expect(sessionNeedsInput(session, [
      agent("done", after), agent("running", null, process.pid),
    ])).toBe(false);
  });

  test("an orphaned running sibling does not suppress unread completed work", () => {
    expect(sessionNeedsInput(session, [
      agent("done", after), agent("running", null, 2147483646),
    ])).toBe(true);
  });

  test("terminal agents need input when one finished after the last visit", () => {
    expect(sessionNeedsInput(session, [agent("done", before), agent("failed", after)])).toBe(true);
  });

  test("terminal agents need no input when all finished before the last visit", () => {
    expect(sessionNeedsInput(session, [agent("done", before), agent("failed", before)])).toBe(false);
  });

  test("a done agent needs input when the session has never been seen", () => {
    expect(sessionNeedsInput({ ...session, last_seen_at: null }, [agent("done", after)])).toBe(true);
  });

  test("a stopped agent alone does not need input", () => {
    expect(sessionNeedsInput(session, [agent("stopped", after)])).toBe(false);
  });
});

describe("agentDisplayStatus", () => {
  const fix = { ...agent("done"), kind: "pr_fix", post_fixed_at: "now", fix_outcome: null } as AgentRow;

  test("successful runtime completion stays yellow while post-fix is pending", () => {
    expect(agentDisplayStatus({ ...fix, post_fixed_at: null })).toEqual({ label: "pushing", color: "yellow" });
  });

  test("maps every persisted post-fix outcome", () => {
    for (const [outcome, label, color] of [
      ["pushed", "done", "green"],
      ["no_changes", "no-op", "gray"],
      ["push_rejected", "rejected", "yellow"],
      ["not_pushed", "unpushed", "yellow"],
      ["failed", "failed", "red"],
      ["stopped", "stopped", "gray"],
    ] as const) {
      expect(agentDisplayStatus({ ...fix, fix_outcome: outcome })).toEqual({ label, color });
    }
  });

  test("legacy fixes and normal agents preserve raw status and liveness colors", () => {
    expect(agentDisplayStatus(fix)).toEqual({ label: "done", color: "green" });
    for (const kind of [null, "pr_fix"] as const) {
      for (const [status, color] of [["pending", "gray"], ["running", "gray"], ["failed", "red"], ["stopped", "gray"]] as const) {
        expect(agentDisplayStatus({ ...fix, kind, status, post_fixed_at: null })).toEqual({ label: status, color });
      }
      expect(agentDisplayStatus({ ...fix, kind, status: "running", pid: process.pid })).toEqual({ label: "running", color: "yellow" });
    }
    expect(agentDisplayStatus({ ...fix, kind: null, post_fixed_at: null })).toEqual({ label: "done", color: "green" });
  });
});

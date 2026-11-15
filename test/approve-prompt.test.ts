import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { approveSessionPlan, createSession, getSession, setSessionAwaitingInput } from "../src/db";
import { APPROVE_PROMPT_MARKER, isApprovePrompt } from "../src/supervisor/approve-prompt";

describe("isApprovePrompt", () => {
  test("matches raw slash commands and the expanded marker line", () => {
    for (const prompt of ["/approve", "  /approve  now ", "/approve\nnow", APPROVE_PROMPT_MARKER,
      `Instructions\n${APPROVE_PROMPT_MARKER}\nProceed.`]) {
      expect(isApprovePrompt(prompt)).toBe(true);
    }
  });

  test("rejects ordinary chat and other commands", () => {
    for (const prompt of ["approve", "/approvex", "please /approve", "", "yes",
      `quoted ${APPROVE_PROMPT_MARKER}`]) {
      expect(isApprovePrompt(prompt)).toBe(false);
    }
  });
});

function submit(sessionId: string, input: string) {
  const result = Bun.spawnSync([
    process.execPath, resolve(import.meta.dir, "../bin/tack.ts"), "__approve-prompt", sessionId,
  ], { env: { ...process.env }, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return result.stdout.toString();
}

describe("__approve-prompt", () => {
  test("approves submitted commands and expanded bodies, preserving the timestamp", () => {
    const session = createSession({ title: "prompt approval" });
    setSessionAwaitingInput(session.id, "plan");
    const output = JSON.parse(submit(session.id, JSON.stringify({ prompt: "/approve" })));
    expect(output).toEqual({ hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "The human approved the plan via /approve; plan_approved_at is set. Proceed to spawn agents.",
    } });
    const approved = getSession(session.id)!;
    expect(approved.plan_approved_at).toBeString();
    expect(approved.awaiting_input_at).toBeNull();
    expect(approved.awaiting_reason).toBeNull();
    submit(session.id, JSON.stringify({ prompt: `Instructions\n${APPROVE_PROMPT_MARKER}` }));
    expect(getSession(session.id)!.plan_approved_at).toBe(approved.plan_approved_at);
  });

  test("fails open silently for other prompts, malformed input, and missing session arguments", () => {
    const session = createSession({ title: "not approved" });
    for (const input of ["", "{", "null", "{}", '{"prompt":123}', '{"prompt":"yes"}',
      '{"prompt":"/approvex"}']) {
      expect(submit(session.id, input)).toBe("");
      expect(getSession(session.id)!.plan_approved_at).toBeNull();
    }
    expect(submit("", '{"prompt":"/approve"}')).toBe("");
  });
});

test("prompt-submit marks ordinary turns busy and turn-end silently clears the marker", () => {
  const session = createSession({});
  expect(submit(session.id, JSON.stringify({ prompt: "investigate" }))).toBe("");
  expect(getSession(session.id)?.supervisor_turn_started_at).toBeString();
  expect(getSession(session.id)?.plan_approved_at).toBeNull();
  const result = Bun.spawnSync([
    process.execPath, resolve(import.meta.dir, "../bin/tack.ts"), "__turn-end", session.id,
  ], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
  expect(getSession(session.id)?.supervisor_turn_started_at).toBeNull();
});

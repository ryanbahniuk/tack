import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { supervisorPromptPath } from "../src/supervisor/prompt";
import { join, resolve } from "node:path";
import { approveSessionPlan, createSession, getSession, setSessionAwaitingInput, setSupervisorTurnStartedAt } from "../src/db";
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
  expect(getSession(session.id)?.title).toBe("investigate");
  expect(readFileSync(supervisorPromptPath(session.id), "utf8")).toBe("investigate");
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

function hook(args: string[], input?: string) {
  const result = Bun.spawnSync([
    process.execPath, resolve(import.meta.dir, "../bin/tack.ts"), ...args,
  ], { env: { ...process.env }, ...(input === undefined ? {} : { stdin: Buffer.from(input) }), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
}

function turnEnd(sessionId: string, input?: unknown) {
  hook(["__turn-end", sessionId], input === undefined ? undefined : typeof input === "string" ? input : JSON.stringify(input));
}

describe("__turn-end question detection", () => {
  test("a Stop whose final message asks a question marks the session awaiting", () => {
    const session = createSession({});
    setSupervisorTurnStartedAt(session.id, new Date().toISOString());
    turnEnd(session.id, { hook_event_name: "Stop", last_assistant_message: "Which repo should agent 2 touch?" });
    const row = getSession(session.id)!;
    expect(row.supervisor_turn_started_at).toBeNull();
    expect(row.awaiting_reason).toBe("question");
    expect(row.awaiting_input_at).toBeString();
  });

  test("a non-question Stop leaves the flag unset", () => {
    const session = createSession({});
    turnEnd(session.id, { hook_event_name: "Stop", last_assistant_message: "All agents are done." });
    expect(getSession(session.id)!.awaiting_input_at).toBeNull();
  });

  test("never overwrites a pending plan", () => {
    const session = createSession({});
    setSessionAwaitingInput(session.id, "plan");
    turnEnd(session.id, { hook_event_name: "Stop", last_assistant_message: "Approve?" });
    expect(getSession(session.id)!.awaiting_reason).toBe("plan");
  });

  test("idle_prompt clears the turn flag but never touches the awaiting flag", () => {
    const session = createSession({});
    setSessionAwaitingInput(session.id, "question");
    setSupervisorTurnStartedAt(session.id, new Date().toISOString());
    turnEnd(session.id, { hook_event_name: "Notification", notification_type: "idle_prompt", last_assistant_message: "ok." });
    const row = getSession(session.id)!;
    expect(row.supervisor_turn_started_at).toBeNull();
    expect(row.awaiting_reason).toBe("question");
  });

  test("empty or malformed stdin still clears the turn flag", () => {
    for (const input of ["", "{", "null"]) {
      const session = createSession({});
      setSupervisorTurnStartedAt(session.id, new Date().toISOString());
      turnEnd(session.id, input);
      expect(getSession(session.id)!.supervisor_turn_started_at).toBeNull();
      expect(getSession(session.id)!.awaiting_input_at).toBeNull();
    }
  });

  test("falls back to the transcript when last_assistant_message is absent", () => {
    const session = createSession({});
    const path = join(mkdtempSync(join(tmpdir(), "tack-turn-end-")), "t.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Here's the plan." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Shall I go ahead?" }] } }),
    ].join("\n") + "\n");
    turnEnd(session.id, { hook_event_name: "Stop", transcript_path: path });
    expect(getSession(session.id)!.awaiting_reason).toBe("question");
  });
});

describe("question answers", () => {
  test("__approve-prompt clears a question but leaves a pending plan", () => {
    const asked = createSession({});
    setSessionAwaitingInput(asked.id, "question");
    expect(submit(asked.id, JSON.stringify({ prompt: "use the api repo" }))).toBe("");
    expect(getSession(asked.id)!.awaiting_input_at).toBeNull();
    expect(getSession(asked.id)!.awaiting_reason).toBeNull();

    const planned = createSession({});
    setSessionAwaitingInput(planned.id, "plan");
    expect(submit(planned.id, JSON.stringify({ prompt: "what about tests?" }))).toBe("");
    expect(getSession(planned.id)!.awaiting_reason).toBe("plan");
    expect(getSession(planned.id)!.plan_approved_at).toBeNull();
  });

  test("__await-input marks and --clear clears a question, never touching a plan", () => {
    const session = createSession({});
    hook(["__await-input", session.id, "question"]);
    expect(getSession(session.id)!.awaiting_reason).toBe("question");
    hook(["__await-input", session.id, "question", "--clear"]);
    expect(getSession(session.id)!.awaiting_input_at).toBeNull();

    setSessionAwaitingInput(session.id, "plan");
    hook(["__await-input", session.id, "question"]);
    expect(getSession(session.id)!.awaiting_reason).toBe("plan");
    hook(["__await-input", session.id, "question", "--clear"]);
    expect(getSession(session.id)!.awaiting_reason).toBe("plan");
    hook(["__await-input"]);
  });
});

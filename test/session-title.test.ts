import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { addSharedContext, createSession, getSession } from "../src/db";
import { writeSharedContext } from "../src/artifacts/store";
import { supervisorPromptPath, writeSupervisorPrompt } from "../src/session/prompt";
import { titleFromFirstPrompt, titleSource } from "../src/session/title";

// These run against the real DB/logs layout, but under the scratch TACK_HOME that
// test/setup.ts points every test file at — never the developer's `~/.tack`. The
// titler spawn is injected as a recorder so no background process is launched.
function recorder(): { calls: string[]; spawn: (id: string) => void } {
  const calls: string[] = [];
  return { calls, spawn: (id) => calls.push(id) };
}

describe("titleFromFirstPrompt", () => {
  test("titles an untitled session: stand-in title, stashed prompt, titler spawned", () => {
    const session = createSession({ title: null });
    const titler = recorder();
    const prompt = `  Fix the flaky login test ${"x".repeat(120)}\n`;

    expect(titleFromFirstPrompt(session.id, prompt, titler.spawn)).toBe(true);

    const title = getSession(session.id)!.title!;
    expect(title.startsWith("Fix the flaky login test")).toBe(true);
    expect(title.length).toBe(80);
    expect(readFileSync(supervisorPromptPath(session.id), "utf8")).toBe(prompt);
    expect(titler.calls).toEqual([session.id]);
  });

  test("is a no-op once the session has a title", () => {
    const session = createSession({ title: "Already named" });
    const titler = recorder();

    expect(titleFromFirstPrompt(session.id, "a later message", titler.spawn)).toBe(false);

    expect(getSession(session.id)!.title).toBe("Already named");
    expect(existsSync(supervisorPromptPath(session.id))).toBe(false);
    expect(titler.calls).toEqual([]);
  });

  test("only the first prompt counts", () => {
    const session = createSession({ title: null });
    const titler = recorder();

    expect(titleFromFirstPrompt(session.id, "first message", titler.spawn)).toBe(true);
    expect(titleFromFirstPrompt(session.id, "second message", titler.spawn)).toBe(false);

    expect(getSession(session.id)!.title).toBe("first message");
    expect(readFileSync(supervisorPromptPath(session.id), "utf8")).toBe("first message");
    expect(titler.calls).toEqual([session.id]);
  });

  test("is a no-op on a blank prompt", () => {
    const session = createSession({ title: null });
    const titler = recorder();

    expect(titleFromFirstPrompt(session.id, "  \n\t ", titler.spawn)).toBe(false);

    expect(getSession(session.id)!.title).toBeNull();
    expect(existsSync(supervisorPromptPath(session.id))).toBe(false);
    expect(titler.calls).toEqual([]);
  });

  test("is a no-op for an unknown session", () => {
    const titler = recorder();
    expect(titleFromFirstPrompt("ses_does_not_exist", "hello", titler.spawn)).toBe(false);
    expect(titler.calls).toEqual([]);
  });
});

describe("titleSource", () => {
  function withContract(sessionId: string, body: string): void {
    addSharedContext({ sessionId, bodyRef: writeSharedContext(sessionId, 1, body), authoredBy: "supervisor" });
  }

  test("prefers the stashed prompt over the shared contract, so titles stick", () => {
    const session = createSession({ title: "Seeded" });
    writeSupervisorPrompt(session.id, "the original ask\n");
    withContract(session.id, "# Goal\nthe supervisor's plan");

    expect(titleSource(session.id)).toBe("the original ask");
  });

  test("falls back to the contract when no prompt was stashed", () => {
    const session = createSession({ title: null });
    withContract(session.id, "# Goal\nthe supervisor's plan\n");

    expect(titleSource(session.id)).toBe("# Goal\nthe supervisor's plan");
  });

  test("throws when there is neither", () => {
    const session = createSession({ title: null });
    expect(() => titleSource(session.id)).toThrow(/no seed prompt or shared contract/);
  });
});

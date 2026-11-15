import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createSession, getSession } from "../src/db";
import { titleFromFirstPrompt } from "../src/session/title";
import { REFRESH_MESSAGE } from "../src/session/refresh-message";
import { APPROVE_PROMPT_MARKER } from "../src/supervisor/approve-prompt";
import { supervisorPromptPath, writeSupervisorPrompt } from "../src/supervisor/prompt";

describe("titleFromFirstPrompt", () => {
  test("immediately titles an unseeded session, stashes the ask, and spawns once", () => {
    const session = createSession({});
    const prompt = `  Investigate ${"the failing build ".repeat(8)}\nPlease fix it.  `;
    const spawned: string[] = [];
    const spawn = (id: string) => {
      // Both the stand-in and the full source must be ready before the child starts.
      expect(getSession(id)?.title).toBe(prompt.trim().slice(0, 80));
      expect(readFileSync(supervisorPromptPath(id), "utf8")).toBe(prompt);
      spawned.push(id);
    };
    expect(titleFromFirstPrompt(session.id, prompt, spawn)).toBe(true);
    expect(titleFromFirstPrompt(session.id, "A later prompt", spawn)).toBe(false);
    expect(spawned).toEqual([session.id]);
    expect(readFileSync(supervisorPromptPath(session.id), "utf8")).toBe(prompt);
  });

  test("leaves titled sessions untouched", () => {
    const session = createSession({ title: "Existing title" });
    const spawned: string[] = [];
    expect(titleFromFirstPrompt(session.id, "New ask", id => { spawned.push(id); })).toBe(false);
    expect(getSession(session.id)?.title).toBe("Existing title");
    expect(existsSync(supervisorPromptPath(session.id))).toBe(false);
    expect(spawned).toEqual([]);
  });

  test("preserves a stashed seed even when the session has no title", () => {
    const session = createSession({});
    writeSupervisorPrompt(session.id, "Original seed");
    const spawned: string[] = [];
    expect(titleFromFirstPrompt(session.id, "New ask", id => { spawned.push(id); })).toBe(false);
    expect(getSession(session.id)?.title).toBeNull();
    expect(readFileSync(supervisorPromptPath(session.id), "utf8")).toBe("Original seed");
    expect(spawned).toEqual([]);
  });

  test("accepts blank titles and empty or whitespace-only stash files", () => {
    for (const stash of ["", " \n "]) {
      const session = createSession({ title: "  " });
      writeSupervisorPrompt(session.id, stash);
      const spawned: string[] = [];
      expect(titleFromFirstPrompt(session.id, "  First ask  ", id => { spawned.push(id); })).toBe(true);
      expect(getSession(session.id)?.title).toBe("First ask");
      expect(readFileSync(supervisorPromptPath(session.id), "utf8")).toBe("  First ask  ");
      expect(spawned).toEqual([session.id]);
    }
  });

  test("ignores approval, commands, blanks, and synthetic refresh prompts", () => {
    const session = createSession({});
    const spawned: string[] = [];
    for (const prompt of ["", " \n\t ", "/approve", "  /help ", APPROVE_PROMPT_MARKER,
      `Instructions\n${APPROVE_PROMPT_MARKER}\nProceed.`, REFRESH_MESSAGE,
      `  ${REFRESH_MESSAGE}\n\nHuman follow-up`]) {
      expect(titleFromFirstPrompt(session.id, prompt, id => { spawned.push(id); })).toBe(false);
      expect(getSession(session.id)?.title).toBeNull();
      expect(existsSync(supervisorPromptPath(session.id))).toBe(false);
    }
    expect(spawned).toEqual([]);
  });

  test("ignores a missing session", () => {
    const spawned: string[] = [];
    expect(titleFromFirstPrompt("missing-title-session", "First ask", id => { spawned.push(id); })).toBe(false);
    expect(existsSync(supervisorPromptPath("missing-title-session"))).toBe(false);
    expect(spawned).toEqual([]);
  });
});

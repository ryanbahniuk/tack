import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeVersionForEntry, currentCodeVersion, isCodeVersionStale } from "../src/process/version";
import { createSession, getSession, migrate, setSupervisorCodeVersion, setPrWatchCodeVersion, setSupervisorTurnStartedAt } from "../src/db";
import { isSessionStale, refreshBlockedReason } from "../src/session/refresh";

const probes = (tmux = false, pids: number[] = []) => ({ current: "new", tmux, alive: (pid: number | null | undefined) => pids.includes(pid ?? -1) });

describe("code identity", () => {
  test("hashes contents in the entry's tree including uncommitted edits", () => {
    const root = mkdtempSync(join(tmpdir(), "tack-code-"));
    try {
      mkdirSync(join(root, "bin")); mkdirSync(join(root, "src"));
      const entry = join(root, "bin/tack.ts");
      writeFileSync(entry, "// entry");
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "bun.lock"), "lock");
      const source = join(root, "src/code.tsx");
      writeFileSync(source, "before");
      const first = codeVersionForEntry(entry);
      expect(first).not.toBe("unknown");
      expect(codeVersionForEntry(entry)).toBe(first);
      writeFileSync(source, "after");
      const second = codeVersionForEntry(entry);
      expect(second).not.toBe(first);
      writeFileSync(join(root, "bun.lock"), "new lock");
      expect(codeVersionForEntry(entry)).not.toBe(second);
      expect(currentCodeVersion()).toBe(currentCodeVersion());
      expect(codeVersionForEntry("/$bunfs/main", entry)).toStartWith("binary:");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("failures and unknown identities never trigger stale detection", () => {
    expect(codeVersionForEntry("/nonexistent/tack/bin/main.ts")).toBe("unknown");
    expect(isCodeVersionStale("old", "unknown")).toBe(false);
    expect(isCodeVersionStale("unknown", "new")).toBe(false);
    expect(isCodeVersionStale(null, "new")).toBe(true);
  });
});

describe("refresh policy", () => {
  const session = () => ({ ...createSession({}), supervisor_code_version: "old", pr_watch_code_version: "old", pid: 11, pr_watch_pid: 22 });
  test("only live stale components count, including unstamped legacy processes", () => {
    const s = session();
    expect(isSessionStale(s, probes()).stale).toBe(false);
    expect(isSessionStale(s, probes(true)).supervisor).toBe(true);
    expect(isSessionStale(s, probes(false, [11])).supervisor).toBe(true);
    expect(isSessionStale(s, probes(false, [22])).watcher).toBe(true);
    expect(isSessionStale({ ...s, supervisor_code_version: "new" }, probes(true)).stale).toBe(false);
    expect(isSessionStale({ ...s, supervisor_code_version: null }, probes(true)).supervisor).toBe(true);
    expect(isSessionStale(s, { ...probes(true, [22]), current: "unknown" }).stale).toBe(false);
  });
  test("guards pending plans, turn markers, and live headless runners", () => {
    const s = session();
    expect(refreshBlockedReason(s, probes())).toBeNull();
    expect(refreshBlockedReason(s, probes(true, [11]))).toBeNull();
    expect(refreshBlockedReason(s, probes(false, [11]))).toContain("headless");
    expect(refreshBlockedReason({ ...s, supervisor_turn_started_at: "now" }, probes(true))).toContain("mid-turn");
    expect(refreshBlockedReason({ ...s, awaiting_input_at: "now", awaiting_reason: "plan" }, probes(true))).toContain("plan approval");
    expect(refreshBlockedReason({ ...s, awaiting_input_at: "now", awaiting_reason: "other" }, probes(true))).toBeNull();
  });
  test("repository setters persist launch versions and turn transitions", () => {
    const s = session();
    setSupervisorCodeVersion(s.id, "supervisor"); setPrWatchCodeVersion(s.id, "watcher");
    setSupervisorTurnStartedAt(s.id, "started");
    expect(getSession(s.id)?.supervisor_code_version).toBe("supervisor");
    expect(getSession(s.id)?.pr_watch_code_version).toBe("watcher");
    expect(getSession(s.id)?.supervisor_turn_started_at).toBe("started");
    setSupervisorTurnStartedAt(s.id, null);
    expect(getSession(s.id)?.supervisor_turn_started_at).toBeNull();
  });
});

test("migration upgrades an existing v8 session and is idempotent", () => {
  const db = new Database(":memory:");
  try {
    // Build v8 by removing only the new columns after a full migration, retaining
    // the real earlier schema and a persisted session to verify upgrade defaults.
    migrate(db);
    db.exec("ALTER TABLE sessions DROP COLUMN supervisor_code_version; ALTER TABLE sessions DROP COLUMN pr_watch_code_version; ALTER TABLE sessions DROP COLUMN supervisor_turn_started_at; DELETE FROM _migrations WHERE version = 9;");
    db.exec("INSERT INTO sessions (id,status,created_at,updated_at) VALUES ('old','active','then','then')");
    migrate(db); migrate(db);
    expect(db.query("SELECT supervisor_code_version,pr_watch_code_version,supervisor_turn_started_at FROM sessions WHERE id='old'").get()).toEqual({ supervisor_code_version: null, pr_watch_code_version: null, supervisor_turn_started_at: null });
  } finally { db.close(); }
});

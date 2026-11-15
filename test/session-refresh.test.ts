import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeVersionForEntry, currentCodeVersion, currentConfigVersion, isCodeVersionStale } from "../src/process/version";
import { createSession, getSession, migrate, setSupervisorCodeVersion, setPrWatchCodeVersion, setSupervisorConfigVersion, setPrWatchConfigVersion, setSupervisorTurnStartedAt } from "../src/db";
import { isSessionStale, refreshBlockedReason } from "../src/session/refresh";

const probes = (tmux = false, pids: number[] = []) => ({ current: "new", config: "unknown", tmux, alive: (pid: number | null | undefined) => pids.includes(pid ?? -1) });

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
  test("config changes stale only live components; unknown never forces refresh", () => {
    const s = { ...session(), supervisor_code_version: "new", pr_watch_code_version: "new", supervisor_config_version: "config", pr_watch_config_version: "config" };
    const probe = { ...probes(true, [22]), config: "config" };
    expect(isSessionStale(s, probe).stale).toBe(false);
    expect(isSessionStale(s, { ...probe, config: "changed" })).toMatchObject({ supervisor: true, watcher: true });
    expect(isSessionStale(s, { ...probe, tmux: false, alive: () => false, config: "changed" }).stale).toBe(false);
    expect(isSessionStale(s, { ...probe, config: "unknown" }).stale).toBe(false);
    expect(isSessionStale({ ...s, supervisor_config_version: "unknown", pr_watch_config_version: "unknown" }, { ...probe, config: "changed" }).stale).toBe(false);
    expect(isSessionStale({ ...s, supervisor_config_version: null }, probe).supervisor).toBe(true);
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
    setSupervisorConfigVersion(s.id, "config-supervisor"); setPrWatchConfigVersion(s.id, "config-watcher");
    expect(getSession(s.id)?.supervisor_config_version).toBe("config-supervisor");
    expect(getSession(s.id)?.pr_watch_config_version).toBe("config-watcher");
    setSupervisorTurnStartedAt(s.id, "started");
    expect(getSession(s.id)?.supervisor_code_version).toBe("supervisor");
    expect(getSession(s.id)?.pr_watch_code_version).toBe("watcher");
    expect(getSession(s.id)?.supervisor_turn_started_at).toBe("started");
    setSupervisorTurnStartedAt(s.id, null);
    expect(getSession(s.id)?.supervisor_turn_started_at).toBeNull();
  });
});

test("migration upgrades an existing v9 session and is idempotent", () => {
  const db = new Database(":memory:");
  try {
    // Build v9 by removing only the new columns after a full migration, retaining
    // the real earlier schema and a persisted session to verify upgrade defaults.
    migrate(db);
    db.exec("ALTER TABLE sessions DROP COLUMN supervisor_config_version; ALTER TABLE sessions DROP COLUMN pr_watch_config_version; ALTER TABLE sessions DROP COLUMN supervisor_code_version; ALTER TABLE sessions DROP COLUMN pr_watch_code_version; ALTER TABLE sessions DROP COLUMN supervisor_turn_started_at; ALTER TABLE agents DROP COLUMN fix_origin; ALTER TABLE agents DROP COLUMN continues_agent_id; ALTER TABLE agents DROP COLUMN continuation_prompt_ref; ALTER TABLE agents DROP COLUMN continuation_started_at; ALTER TABLE agents DROP COLUMN diff_base; ALTER TABLE agents DROP COLUMN fix_outcome; ALTER TABLE agents DROP COLUMN fix_pushed_sha; ALTER TABLE session_prs DROP COLUMN ready_promoted_at; DELETE FROM _migrations WHERE version >= 10;");
    db.exec("INSERT INTO sessions (id,status,created_at,updated_at,tokens_input) VALUES ('old','active','then','then',42)");
    migrate(db); migrate(db);
    expect(db.query("SELECT tokens_input FROM sessions WHERE id='old'").get()).toEqual({ tokens_input: 42 });
    expect(db.query("SELECT supervisor_config_version,pr_watch_config_version,supervisor_code_version,pr_watch_code_version,supervisor_turn_started_at FROM sessions WHERE id='old'").get()).toEqual({ supervisor_config_version: null, pr_watch_config_version: null, supervisor_code_version: null, pr_watch_code_version: null, supervisor_turn_started_at: null });
  } finally { db.close(); }
});

test("config fingerprint reads contents fresh and handles missing/unreadable paths", () => {
  const root = mkdtempSync(join(tmpdir(), "tack-config-version-"));
  const path = join(root, "config.ts");
  try {
    expect(currentConfigVersion(path)).toBe("unknown");
    expect(currentConfigVersion(root)).toBe("unknown");
    writeFileSync(path, "before");
    const before = currentConfigVersion(path);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(currentConfigVersion(path)).toBe(before);
    writeFileSync(path, "after");
    expect(currentConfigVersion(path)).not.toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createAgent, createSession, deleteSession, getAgent, getSession, listAgents, listInterruptedAgents, listSessions, migrate, setAgentStatus } from "../src/db";
import * as detached from "../src/agent/detached";
import * as tmux from "../src/session/tmux";
import { archiveSession, holdSession, unholdSession, stopSession, unarchiveSession } from "../src/session/lifecycle";

const sessions: string[] = [];
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
  for (const id of sessions.splice(0)) deleteSession(id);
});

function fixture() {
  const session = createSession({});
  sessions.push(session.id);
  const agents = (["running", "pending", "done", "failed", "stopped"] as const).map(status => {
    const a = createAgent({ sessionId: session.id, projectName: "test" });
    setAgentStatus(a.id, status);
    return getAgent(a.id)!;
  });
  mocks.push(spyOn(tmux, "tmuxKillSession").mockImplementation(() => {}));
  return { session, agents };
}

test("hold and unhold preserve work and archived sessions refuse both", () => {
  const { session, agents } = fixture();
  const before = listAgents(session.id);
  holdSession(session.id);
  expect(getSession(session.id)?.status).toBe("on_hold");
  expect(listSessions().some(s => s.id === session.id)).toBe(true);
  expect(listAgents(session.id)).toEqual(before);
  unholdSession(session.id);
  expect(getSession(session.id)?.status).toBe("active");
  expect(listAgents(session.id)).toEqual(before);
  holdSession(session.id);
  archiveSession(session.id);
  expect(listSessions().some(s => s.id === session.id)).toBe(false);
  expect(() => holdSession(session.id)).toThrow("is archived; unarchive it instead");
  expect(() => unholdSession(session.id)).toThrow("is archived; unarchive it instead");
  expect(listInterruptedAgents(session.id).map(a => a.id)).toEqual(agents.slice(0, 2).map(a => a.id));
  mocks.push(spyOn(detached, "spawnAgentRunner").mockReturnValue(123));
  unarchiveSession(session.id);
  expect(getSession(session.id)?.status).toBe("active");
});

describe("archive restoration", () => {
  test("archive stamps running/pending agents before stopping, preserving terminal agents", () => {
    const { session, agents } = fixture();
    archiveSession(session.id);
    expect(getSession(session.id)?.status).toBe("archived");
    expect(listInterruptedAgents(session.id).map(a => a.id)).toEqual(agents.slice(0, 2).map(a => a.id));
    expect(listAgents(session.id).map(a => a.status)).toEqual(["stopped", "stopped", "done", "failed", "stopped"]);
    expect(getAgent(agents[0]!.id)?.interrupted_at).toBeString();
  });

  test("plain stop does not stamp or make agents eligible for unarchive", () => {
    const { session } = fixture();
    stopSession(session.id);
    expect(listAgents(session.id).every(a => a.interrupted_at === null)).toBe(true);
    const spawn = spyOn(detached, "spawnAgentRunner").mockReturnValue(123);
    mocks.push(spawn);
    expect(unarchiveSession(session.id)).toEqual({ resumedAgents: [] });
    expect(spawn).not.toHaveBeenCalled();
  });

  test("unarchive relaunches exactly interrupted agents as pending and clears stamps", () => {
    const { session, agents } = fixture();
    archiveSession(session.id);
    const spawn = spyOn(detached, "spawnAgentRunner").mockImplementation((sessionId, agentId, options) => {
      expect(sessionId).toBe(session.id);
      expect(getSession(sessionId)?.status).toBe("active");
      expect(agents.slice(0, 2).every(a => getAgent(a.id)?.status === "pending")).toBe(true);
      expect(getAgent(agentId)).toMatchObject({ status: "pending", interrupted_at: null, finished_at: null });
      expect(options).toEqual({ resume: true });
      return 123;
    });
    mocks.push(spawn);
    expect(unarchiveSession(session.id)).toEqual({ resumedAgents: agents.slice(0, 2).map(a => a.id) });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(listInterruptedAgents(session.id)).toEqual([]);
    expect(listAgents(session.id).map(a => a.status)).toEqual(["pending", "pending", "done", "failed", "stopped"]);
    expect(unarchiveSession(session.id)).toEqual({ resumedAgents: [] });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test("one failed launch records the error and does not prevent later launches", () => {
    const { session, agents } = fixture();
    archiveSession(session.id);
    const spawn = spyOn(detached, "spawnAgentRunner").mockImplementation((_, id) => {
      if (id === agents[0]!.id) throw new Error("runner unavailable");
      return 123;
    });
    mocks.push(spawn);
    expect(unarchiveSession(session.id)).toEqual({ resumedAgents: [agents[1]!.id] });
    expect(getAgent(agents[0]!.id)).toMatchObject({ status: "failed", error: "runner unavailable", interrupted_at: null });
    expect(getAgent(agents[1]!.id)).toMatchObject({ status: "pending", interrupted_at: null });
  });
});

test("v8 upgrades an existing database, preserves agents, and is idempotent", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.exec(`ALTER TABLE agents DROP COLUMN interrupted_at;
    ALTER TABLE agents DROP COLUMN fix_origin; ALTER TABLE agents DROP COLUMN continues_agent_id; ALTER TABLE agents DROP COLUMN continuation_prompt_ref; ALTER TABLE agents DROP COLUMN continuation_started_at; ALTER TABLE agents DROP COLUMN diff_base;
    ALTER TABLE agents DROP COLUMN fix_outcome;
    ALTER TABLE agents DROP COLUMN fix_pushed_sha;
    ALTER TABLE sessions DROP COLUMN tokens_input;
    ALTER TABLE sessions DROP COLUMN tokens_output;
    ALTER TABLE sessions DROP COLUMN cache_read;
    ALTER TABLE sessions DROP COLUMN cache_write;
    ALTER TABLE sessions DROP COLUMN supervisor_config_version; ALTER TABLE sessions DROP COLUMN pr_watch_config_version; ALTER TABLE sessions DROP COLUMN supervisor_code_version;
    ALTER TABLE sessions DROP COLUMN pr_watch_code_version;
    ALTER TABLE sessions DROP COLUMN supervisor_turn_started_at;
    ALTER TABLE agents DROP COLUMN persona; ALTER TABLE agents DROP COLUMN reviews_agent_id; ALTER TABLE agents DROP COLUMN review_ref; ALTER TABLE session_prs DROP COLUMN ready_promoted_at; ALTER TABLE sessions DROP COLUMN pr_fix_enabled; ALTER TABLE sessions DROP COLUMN summary_ref; ALTER TABLE sessions DROP COLUMN summary_at; ALTER TABLE session_prs DROP COLUMN body_ref; DELETE FROM _migrations WHERE version >= 8`);
  db.exec("INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s', 'active', 'then', 'then')");
  db.exec("INSERT INTO agents (id, session_id, project_name, status, created_at, updated_at) VALUES ('a', 's', 'test', 'stopped', 'then', 'then')");
  migrate(db);
  expect(db.query("SELECT id, interrupted_at FROM agents").all()).toEqual([{ id: "a", interrupted_at: null }]);
  expect(db.query("SELECT MAX(version) AS v FROM _migrations").get()).toEqual({ v: 23 });
  migrate(db);
  db.close();
});

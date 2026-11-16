import { describe, expect, spyOn, test } from "bun:test";
import type { TackConfig } from "../src/config/schema";
import { createAgent, createSession, deleteSession, getAgent, getDb, setAgentError, setAgentPid, setAgentStatus, setSessionResumeRef, setSessionStatus, type AgentRow } from "../src/db";
import * as detached from "../src/agent/detached";
import { isTransientError } from "../src/agent/detached";
import * as repositories from "../src/db/repositories";
import * as refresh from "../src/session/refresh";
import * as tmux from "../src/session/tmux";
import * as supervisor from "../src/supervisor/supervise";
import { RECONNECT_MESSAGE, parkReconnectedSupervisor, reconnectAllSessions, reconnectSession, selectAgentsToRevive } from "../src/session/reconnect";

const LIVE = 4242;
const probes = { alive: (pid: number | null | undefined) => pid === LIVE };
const fixtureSession = createSession({});
const row = (over: Partial<AgentRow>): AgentRow => ({ ...createAgent({ sessionId: fixtureSession.id, projectName: "p" }), ...over });

describe("selectAgentsToRevive", () => {
  test("revives orphaned and connection-failed agents only", () => {
    const cases: [string, Partial<AgentRow>, boolean][] = [
      ["orphaned running", { status: "running", pid: 1 }, true],
      ["orphaned pending", { status: "pending", pid: null }, true],
      ["live running", { status: "running", pid: LIVE }, false],
      ["live pending (dependency wait)", { status: "pending", pid: LIVE }, false],
      ["transient failure", { status: "failed", error: "TypeError: fetch failed" }, true],
      ["genuine failure", { status: "failed", error: "tests failed: expected 2 to be 3" }, false],
      ["failure without error", { status: "failed", error: null }, false],
      ["done", { status: "done", pid: 1 }, false],
      ["stopped", { status: "stopped", pid: 1 }, false],
      ["manual orphan", { status: "running", pid: 1, kind: "manual" }, false],
      ["manual transient", { status: "failed", error: "Connection error", kind: "manual" }, false],
      ["pr_fix orphan (watcher owns it)", { status: "running", pid: 1, kind: "pr_fix" }, false],
      ["review orphan", { status: "running", pid: 1, kind: "review" }, true],
    ];
    for (const [name, over, expected] of cases) {
      expect({ name, revived: selectAgentsToRevive([row(over)], probes).length === 1 }).toEqual({ name, revived: expected });
    }
  });
});

describe("isTransientError", () => {
  test("matches connection loss after sleep or network drop", () => {
    for (const msg of ["API Error: Connection error.", "TypeError: fetch failed", "connect ECONNREFUSED 127.0.0.1:443",
      "connect EHOSTUNREACH 1.2.3.4", "ENETUNREACH", "getaddrinfo ENETDOWN", "Network is unreachable", "ECONNRESET", "rate limit"]) {
      expect({ msg, transient: isTransientError(msg) }).toEqual({ msg, transient: true });
    }
  });
  test("stays conservative for real failures", () => {
    for (const msg of [null, "", "Type error in src/a.ts", "tests failed", "permission denied", "merge conflict"]) {
      expect({ msg, transient: isTransientError(msg) }).toEqual({ msg, transient: false });
    }
  });
});

describe("reconnectSession", () => {
  const config = {} as TackConfig;
  test("resets the revived cohort to pending, clears attempts, and isolates spawn failures", async () => {
    const session = createSession({});
    const orphan = createAgent({ sessionId: session.id, projectName: "p" });
    setAgentStatus(orphan.id, "running"); setAgentPid(orphan.id, 999_999);
    const flaky = createAgent({ sessionId: session.id, projectName: "p" });
    setAgentStatus(flaky.id, "failed"); setAgentError(flaky.id, "fetch failed");
    getDb().prepare(`UPDATE agents SET attempt = 2 WHERE id = ?`).run(flaky.id);
    const broken = createAgent({ sessionId: session.id, projectName: "p" });
    setAgentStatus(broken.id, "failed"); setAgentError(broken.id, "tests failed");
    const seen: Record<string, string | undefined> = {};
    const spawn = spyOn(detached, "spawnAgentRunner").mockImplementation((_s, id) => {
      // The whole cohort must already be pending before the first runner starts.
      for (const a of [orphan, flaky]) seen[`${id}:${a.id}`] = getAgent(a.id)?.status;
      if (id === flaky.id) throw new Error("spawn boom");
      return 1;
    });
    try {
      const result = await reconnectSession(session.id, config);
      expect(result).toEqual({ supervisorRestarted: false, planPending: false, revivedAgents: [orphan.id], failedAgents: [flaky.id], watcherRestarted: false });
      expect(seen[`${orphan.id}:${flaky.id}`]).toBe("pending");
      expect(spawn).toHaveBeenCalledWith(session.id, orphan.id, { resume: true });
      expect(getAgent(flaky.id)).toMatchObject({ status: "failed", error: "spawn boom", attempt: 0 });
      expect(getAgent(broken.id)).toMatchObject({ status: "failed", error: "tests failed" });
    } finally {
      spawn.mockRestore();
      deleteSession(session.id);
    }
  });
  test("reports a pending plan instead of blocking, and refuses archived sessions", async () => {
    const session = createSession({});
    getDb().prepare(`UPDATE sessions SET awaiting_input_at = ?, awaiting_reason = 'plan', supervisor_turn_started_at = ? WHERE id = ?`).run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", session.id);
    try {
      expect((await reconnectSession(session.id, config)).planPending).toBe(true);
      setSessionStatus(session.id, "archived");
      await expect(reconnectSession(session.id, config)).rejects.toThrow("archived");
    } finally { deleteSession(session.id); }
  });
});

describe("parkReconnectedSupervisor", () => {
  const config = {} as TackConfig;
  test("needs a resume handle and tmux, and never falls back to a foreground TUI", async () => {
    const session = createSession({});
    const avail = spyOn(tmux, "tmuxAvailable").mockReturnValue(false);
    const launch = spyOn(supervisor, "superviseInteractive").mockResolvedValue({ code: 0, detached: true });
    try {
      expect(await parkReconnectedSupervisor(session.id, config)).toEqual({ parked: false, reason: "no-resume-ref" });
      setSessionResumeRef(session.id, "ref-1");
      expect(await parkReconnectedSupervisor(session.id, config)).toEqual({ parked: false, reason: "no-tmux" });
      expect(launch).not.toHaveBeenCalled();
      await expect(parkReconnectedSupervisor("ses_missing", config)).rejects.toThrow("Unknown session");
    } finally {
      avail.mockRestore(); launch.mockRestore();
      deleteSession(session.id);
    }
  });
  test("parks the resumed supervisor in tmux with the reconnect seed", async () => {
    const session = createSession({});
    setSessionResumeRef(session.id, "ref-1");
    const avail = spyOn(tmux, "tmuxAvailable").mockReturnValue(true);
    let detached = true;
    const launch = spyOn(supervisor, "superviseInteractive").mockImplementation(async () => ({ code: detached ? 0 : 1, detached }));
    try {
      expect(await parkReconnectedSupervisor(session.id, config)).toEqual({ parked: true });
      expect(launch.mock.calls[0]?.[0]).toMatchObject({ session: { id: session.id, resume_ref: "ref-1" }, prompt: RECONNECT_MESSAGE, resume: true, config, park: true });
      detached = false;
      expect(await parkReconnectedSupervisor(session.id, config)).toEqual({ parked: false, reason: "park-failed" });
    } finally {
      avail.mockRestore(); launch.mockRestore();
      deleteSession(session.id);
    }
  });
});

describe("reconnectAllSessions", () => {
  test("parks only supervisors that were running", async () => {
    const running = createSession({});
    const idle = createSession({});
    for (const s of [running, idle]) setSessionResumeRef(s.id, `ref-${s.id}`);
    const list = spyOn(repositories, "listSessions").mockImplementation(() => [running, idle].map(s => repositories.getSession(s.id)!));
    const stop = spyOn(refresh, "stopSupervisorProcess").mockImplementation(async s => s.id === running.id);
    const avail = spyOn(tmux, "tmuxAvailable").mockReturnValue(true);
    const launch = spyOn(supervisor, "superviseInteractive").mockResolvedValue({ code: 0, detached: true });
    try {
      const results = await reconnectAllSessions({} as TackConfig);
      expect(results.map(r => [r.session.id, r.status === "reconnected" && r.parked])).toEqual([[running.id, true], [idle.id, false]]);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0]?.[0]).toMatchObject({ session: { id: running.id }, park: true });
    } finally {
      list.mockRestore(); stop.mockRestore(); avail.mockRestore(); launch.mockRestore();
      for (const s of [running, idle]) deleteSession(s.id);
    }
  });
});

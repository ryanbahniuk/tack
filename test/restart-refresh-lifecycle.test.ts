import { expect, spyOn, test } from "bun:test";
import { createAgent, createSession, getAgent, setSupervisorCodeVersion, setSupervisorTurnStartedAt, setSessionPrWatchPid, setPrWatchCodeVersion, upsertSessionPr } from "../src/db";
import * as tmux from "../src/session/tmux";
import * as version from "../src/process/version";
import * as repositories from "../src/db/repositories";
import * as supervisor from "../src/supervisor/supervise";
import { refreshAllStaleSessions, RESTART_MESSAGE, refreshSession } from "../src/session/refresh";
import * as self from "../src/process/self";
import * as watcher from "../src/prwatch/watch";
import type { TackConfig } from "../src/config/schema";

for (const graceful of [true, false]) {
  test(`refresh guards the supervisor; force exits it (${graceful ? "gracefully" : "tmux fallback"}) and preserves agents`, async () => {
    const session = createSession({});
    const agent = createAgent({ sessionId: session.id, projectName: "test" });
    setSupervisorCodeVersion(session.id, "old");
    setSupervisorTurnStartedAt(session.id, "busy");
    let live = true;
    const current = spyOn(version, "currentCodeVersion").mockReturnValue("new");
    const has = spyOn(tmux, "tmuxHasSession").mockImplementation(() => live);
    const request = spyOn(tmux, "tmuxRequestExit").mockImplementation(() => { if (graceful) live = false; });
    const kill = spyOn(tmux, "tmuxKillSession").mockImplementation(() => { live = false; });
    try {
      const config = {} as TackConfig; // no launch/cost/watch work in this fixture
      expect((await refreshSession(session.id, config)).blocked).toContain("mid-turn");
      expect(request).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect((await refreshSession(session.id, config, { force: true })).refreshed).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(graceful ? 0 : 1);
      expect(getAgent(agent.id)).toEqual(agent);
    } finally { current.mockRestore(); has.mockRestore(); request.mockRestore(); kill.mockRestore(); }
  });
}

for (const watchable of [true, false]) {
  test(`watcher-only refresh leaves a busy supervisor alone and ${watchable ? "respawns for open PRs" : "does not respawn for closed PRs"}`, async () => {
    const session = createSession({});
    const watcherPid = 987654;
    setSessionPrWatchPid(session.id, watcherPid);
    setPrWatchCodeVersion(session.id, "old");
    setSupervisorTurnStartedAt(session.id, "busy");
    upsertSessionPr({ sessionId: session.id, url: `https://example.com/${session.id}`, state: watchable ? "open" : "closed" });
    let live = true;
    const current = spyOn(version, "currentCodeVersion").mockReturnValue("new");
    const has = spyOn(tmux, "tmuxHasSession").mockReturnValue(true);
    const alive = spyOn(self, "isAlive").mockImplementation(pid => pid === watcherPid && live);
    const signal = spyOn(process, "kill").mockImplementation((pid, sig) => {
      expect(pid).toBe(watcherPid);
      expect(sig).toBe("SIGTERM");
      live = false;
      return true;
    });
    const request = spyOn(tmux, "tmuxRequestExit").mockImplementation(() => { throw new Error("must leave supervisor alone"); });
    const spawn = spyOn(watcher, "spawnPrWatcher").mockReturnValue(123);
    try {
      const result = await refreshSession(session.id, {} as TackConfig, { watcherOnly: true });
      expect(result.refreshed).toBe(true);
      expect(signal).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(watchable ? 1 : 0);
    } finally {
      current.mockRestore(); has.mockRestore(); alive.mockRestore(); signal.mockRestore(); request.mockRestore(); spawn.mockRestore();
    }
  });
}

for (const available of [true, false]) {
  test(`bulk refresh skips blocked sessions and parks supervisors only with tmux (${available})`, async () => {
    const ready = createSession({});
    const blocked = createSession({});
    const watching = createSession({});
    setSupervisorTurnStartedAt(blocked.id, "busy");
    setSessionPrWatchPid(watching.id, 987654);
    upsertSessionPr({ sessionId: watching.id, url: `https://example.com/${watching.id}`, state: "open" });
    const live = new Set([ready.id, blocked.id]);
    let watcherLive = true;
    const current = spyOn(version, "currentCodeVersion").mockReturnValue("new");
    const configVersion = spyOn(version, "currentConfigVersion").mockReturnValue("unknown");
    const has = spyOn(tmux, "tmuxHasSession").mockImplementation(name => [...live].some(id => tmux.tmuxSessionName(id) === name));
    const request = spyOn(tmux, "tmuxRequestExit").mockImplementation(id => { live.delete(id); });
    const avail = spyOn(tmux, "tmuxAvailable").mockReturnValue(available);
    const alive = spyOn(self, "isAlive").mockImplementation(pid => pid === 987654 && watcherLive);
    const signal = spyOn(process, "kill").mockImplementation(() => { watcherLive = false; return true; });
    const spawn = spyOn(watcher, "spawnPrWatcher").mockReturnValue(123);
    const launch = spyOn(supervisor, "superviseInteractive").mockResolvedValue({ code: 0, detached: true });
    try {
      const config = {} as TackConfig;
      const results = await refreshAllStaleSessions(config);
      expect(results.find(r => r.session.id === blocked.id)).toMatchObject({ status: "blocked", reason: "supervisor is mid-turn" });
      expect(results.find(r => r.session.id === ready.id)?.status).toBe("refreshed");
      expect(results.find(r => r.session.id === watching.id)?.status).toBe("refreshed");
      expect(request).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledTimes(available ? 1 : 0);
      if (available) expect(launch.mock.calls[0]?.[0]).toMatchObject({ session: { id: ready.id }, config, park: true, resume: true, prompt: RESTART_MESSAGE });
    } finally {
      current.mockRestore(); configVersion.mockRestore(); has.mockRestore(); request.mockRestore(); avail.mockRestore();
      alive.mockRestore(); signal.mockRestore(); spawn.mockRestore(); launch.mockRestore();
    }
  });
}

test("bulk refresh respects force, isolates launch errors, and handles sessions becoming current", async () => {
  const failed = createSession({});
  const ready = createSession({});
  const raced = createSession({});
  setSupervisorTurnStartedAt(failed.id, "busy");
  const live = new Set([failed.id, ready.id, raced.id]);
  let raceProbes = 0;
  const list = spyOn(repositories, "listSessions").mockReturnValue([failed, ready, raced].map(s => repositories.getSession(s.id)!));
  const current = spyOn(version, "currentCodeVersion").mockReturnValue("new");
  const configVersion = spyOn(version, "currentConfigVersion").mockReturnValue("unknown");
  const has = spyOn(tmux, "tmuxHasSession").mockImplementation(name => {
    if (name === tmux.tmuxSessionName(raced.id)) return ++raceProbes === 1;
    return [...live].some(id => tmux.tmuxSessionName(id) === name);
  });
  const request = spyOn(tmux, "tmuxRequestExit").mockImplementation(id => { live.delete(id); });
  const avail = spyOn(tmux, "tmuxAvailable").mockReturnValue(true);
  const alive = spyOn(self, "isAlive").mockReturnValue(false);
  const launch = spyOn(supervisor, "superviseInteractive").mockImplementation(async opts => {
    if (opts.session.id === failed.id) throw new Error("launch failed");
    return { code: 0, detached: true };
  });
  try {
    const results = await refreshAllStaleSessions({} as TackConfig, { force: true });
    expect(results.map(r => r.status)).toEqual(["error", "refreshed", "current"]);
    expect(results[0]).toMatchObject({ error: "launch failed" });
    expect(launch).toHaveBeenCalledTimes(2);
  } finally {
    list.mockRestore(); current.mockRestore(); configVersion.mockRestore(); has.mockRestore();
    request.mockRestore(); avail.mockRestore(); alive.mockRestore(); launch.mockRestore();
  }
});

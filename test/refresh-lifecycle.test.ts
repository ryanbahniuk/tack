import { expect, spyOn, test } from "bun:test";
import { createAgent, createSession, getAgent, setSupervisorCodeVersion, setSupervisorTurnStartedAt, setSessionPrWatchPid, setPrWatchCodeVersion, upsertSessionPr } from "../src/db";
import * as tmux from "../src/session/tmux";
import * as version from "../src/process/version";
import { refreshSession } from "../src/session/refresh";
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

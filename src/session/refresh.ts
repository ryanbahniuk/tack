import { isSessionOpen } from "../db";
import { hasUnresolvedDependencies } from "../db";
import type { TackConfig } from "../config/schema";
import { resolveModel } from "../config/load";
import { getSession, listSessions, listSessionPrs, setSessionPrWatchPid, setSupervisorTurnStartedAt, type SessionRow } from "../db";
import { supervisorCwd } from "../paths";
import { isAlive } from "../process/self";
import { currentCodeVersion, currentConfigVersion, isCodeVersionStale } from "../process/version";
import { isWatchablePr, spawnPrWatcher } from "../prwatch/watch";
import { recoverSupervisorCost, superviseInteractive } from "../supervisor/supervise";
import { tmuxAvailable, tmuxHasSession, tmuxKillSession, tmuxListSessions, tmuxRequestExit, tmuxSessionName } from "./tmux";

import { REFRESH_MESSAGE } from "./refresh-message";

export { REFRESH_MESSAGE } from "./refresh-message";

/** Probe injection keeps the policy testable without real processes or tmux. */
export function isSessionStale(session: SessionRow, probes = {
  current: currentCodeVersion(),
  config: currentConfigVersion(),
  tmux: tmuxHasSession(tmuxSessionName(session.id)),
  alive: isAlive,
}) {
  const supervisorLive = probes.tmux || probes.alive(session.pid);
  const watcherLive = probes.alive(session.pr_watch_pid);
  const supervisor = supervisorLive && (isCodeVersionStale(session.supervisor_code_version, probes.current) || isCodeVersionStale(session.supervisor_config_version, probes.config));
  const watcher = watcherLive && (isCodeVersionStale(session.pr_watch_code_version, probes.current) || isCodeVersionStale(session.pr_watch_config_version, probes.config));
  return { stale: supervisor || watcher, supervisor, watcher, supervisorLive, watcherLive };
}

/** Stale flags for many sessions from ONE probe set: the config is hashed once and
 * tmux is listed once, instead of a sha256 + `has-session` spawn per session — the
 * dashboard calls this every second. Archived sessions have no supervisor or watcher
 * to refresh, so they are never stale and never trigger the tmux probe. */
export function staleSessionIds(sessions: readonly SessionRow[], deps = {
  current: currentCodeVersion,
  config: () => currentConfigVersion(),
  tmuxSessions: tmuxListSessions,
  alive: isAlive,
}): Set<string> {
  const stale = new Set<string>();
  const candidates = sessions.filter((s) => s.status !== "archived");
  if (!candidates.length) return stale;
  const current = deps.current();
  const config = deps.config();
  const live = deps.tmuxSessions();
  for (const session of candidates) {
    const probes = { current, config, tmux: live.has(tmuxSessionName(session.id)), alive: deps.alive };
    if (isSessionStale(session, probes).stale) stale.add(session.id);
  }
  return stale;
}

export function refreshBlockedReason(session: SessionRow, probes = {
  tmux: tmuxHasSession(tmuxSessionName(session.id)), alive: isAlive,
}): string | null {
  if (session.awaiting_input_at && session.awaiting_reason === "plan") return "plan approval is pending";
  if (session.supervisor_turn_started_at) return "supervisor is mid-turn";
  // Interactive launchers can remain alive while attached; only a runner without a
  // tmux TUI is unconditionally busy.
  if (!probes.tmux && probes.alive(session.pid)) return "headless supervisor runner is still alive";
  return null;
}

export async function waitUntilGone(alive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 1500;
  while (alive() && Date.now() < deadline) await Bun.sleep(75);
  return !alive();
}

/** Stop a session's supervisor so a caller can launch its replacement: ask a tmux
 * TUI to exit (killing it if it lingers), otherwise SIGTERM a live headless runner
 * or launcher. Then bank the cost the dying turn accrued and clear the turn flag,
 * which a killed turn's Stop hook never got to clear. Shared by refresh and
 * reconnect; it applies no guards of its own. Returns whether anything was live. */
export async function stopSupervisorProcess(session: SessionRow, config: TackConfig): Promise<boolean> {
  const id = session.id;
  const tmuxAlive = () => tmuxHasSession(tmuxSessionName(id));
  const wasLive = tmuxAlive() || isAlive(session.pid);
  if (tmuxAlive()) {
    tmuxRequestExit(id);
    if (!await waitUntilGone(tmuxAlive)) tmuxKillSession(id);
  } else if (isAlive(session.pid)) {
    try { process.kill(session.pid!, "SIGTERM"); } catch { /* exited */ }
    if (!await waitUntilGone(() => isAlive(session.pid))) throw new Error(`Supervisor ${id} did not exit`);
  }
  if (tmuxAlive()) throw new Error(`Supervisor ${id} did not exit`);
  if (session.supervisor_model) recoverSupervisorCost({ session, model: resolveModel(config, session.supervisor_model), cwd: supervisorCwd(id), sessionRef: session.resume_ref ?? undefined });
  setSupervisorTurnStartedAt(id, null);
  return wasLive;
}

/** Refresh only Tack-owned supervisor/watcher processes. Agent work is untouched.
 * Launching the replacement TUI belongs to the caller so Ink can unmount first. */
export async function refreshSession(id: string, config: TackConfig, opts: { force?: boolean; watcherOnly?: boolean } = {}) {
  const session = getSession(id);
  if (!session) throw new Error(`Unknown session ${id}`);
  const stale = isSessionStale(session);
  if (!stale.stale) return { ...stale, refreshed: false, blocked: null };
  const blocked = !opts.force && !opts.watcherOnly ? refreshBlockedReason(session) : null;
  if (blocked) return { ...stale, refreshed: false, blocked };
  if (stale.supervisor && !opts.watcherOnly) await stopSupervisorProcess(session, config);
  if (stale.watcher) {
    try { process.kill(session.pr_watch_pid!, "SIGTERM"); } catch { /* exited */ }
    // Never clear a live pid: spawnPrWatcher must not race a still-running watcher.
    if (!await waitUntilGone(() => isAlive(session.pr_watch_pid))) throw new Error(`PR watcher ${id} did not exit`);
    if (getSession(id)?.pr_watch_pid === session.pr_watch_pid) setSessionPrWatchPid(id, null);
    if ((listSessionPrs(id).some(isWatchablePr) || hasUnresolvedDependencies(id))) spawnPrWatcher(id, config);
  }
  return { ...stale, refreshed: true, blocked: null };
}

export type BulkRefreshResult = {
  session: SessionRow;
} & ({ status: "refreshed" | "current" } | { status: "blocked"; reason: string } | { status: "error"; error: string });

/** Refresh active stale sessions without ever opening a foreground TUI. Without
 * tmux the next resume starts the replacement supervisor. Failures stay local so
 * one busy or broken session cannot prevent the others from refreshing. */
export async function refreshAllStaleSessions(config: TackConfig, opts: { force?: boolean } = {}): Promise<BulkRefreshResult[]> {
  const sessions = listSessions().filter(s => isSessionOpen(s) && isSessionStale(s).stale);
  const results: BulkRefreshResult[] = [];
  for (const session of sessions) {
    try {
      const result = await refreshSession(session.id, config, opts);
      if (result.blocked) {
        results.push({ session, status: "blocked", reason: result.blocked });
        continue;
      }
      if (result.refreshed && result.supervisor && tmuxAvailable()) {
        await superviseInteractive({ session: getSession(session.id)!, prompt: REFRESH_MESSAGE, resume: true, config, park: true });
      }
      results.push({ session, status: result.refreshed ? "refreshed" : "current" });
    } catch (err) {
      results.push({ session, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

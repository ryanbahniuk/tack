import { hasUnresolvedDependencies } from "../db";
import type { TackConfig } from "../config/schema";
import { getSession, listAgents, listSessionPrs, listSessions, resetAgentAttempt, setAgentError, setAgentStatus, setSessionPrWatchPid, type AgentRow, type SessionRow } from "../db";
import { isTransientError, spawnAgentRunner } from "../agent/detached";
import { isAlive } from "../process/self";
import { isWatchablePr, spawnPrWatcher } from "../prwatch/watch";
import { superviseInteractive } from "../supervisor/supervise";
import { stopSupervisorProcess } from "./refresh";
import { RECONNECT_MESSAGE } from "./refresh-message";
import { tmuxAvailable } from "./tmux";

export { RECONNECT_MESSAGE } from "./refresh-message";

/**
 * Which agents a lost connection or a sleeping laptop killed, and so are worth
 * relaunching: non-terminal rows whose runner is gone (orphaned), and failures
 * whose error is connection-shaped. After a long sleep the runner's quick
 * transient retries are already spent, so the agent sits `failed` with a network
 * error. Genuine failures, finished work and stopped agents stay as they are.
 *
 * Excluded kinds:
 * - `manual` rows are human workspaces and are never runnable.
 * - `pr_fix` rows belong to the PR watcher. Each tick it fails a fix whose runner
 *   died and immediately runs `postFix`, which latches `post_fixed_at` and marks
 *   the fix's feedback items failed. A revived fix that finished afterwards would
 *   be skipped by the `!post_fixed_at` filter and its commits never pushed, and a
 *   revive racing the watcher could be failed mid-run. The watcher already owns
 *   recovery for these.
 * - `review` rows ARE revived. They only report through `report_review` and have
 *   no post-step, so a review that finishes late is read like any other result.
 *
 * Pure: liveness is injected so the policy can be tested without processes.
 */
export function selectAgentsToRevive(agents: AgentRow[], probes: { alive: (pid: number | null | undefined) => boolean } = { alive: isAlive }): AgentRow[] {
  return agents.filter(a => {
    if (a.kind === "manual" || a.kind === "pr_fix") return false;
    if (a.status === "running" || a.status === "pending") return !probes.alive(a.pid);
    if (a.status === "failed") return isTransientError(a.error);
    return false;
  });
}

export type ReconnectResult = {
  /** A live supervisor (tmux TUI, launcher, or headless runner) was stopped. */
  supervisorRestarted: boolean;
  /** A plan was awaiting approval; the resumed supervisor is asked to re-present it. */
  planPending: boolean;
  revivedAgents: string[];
  /** Agents whose relaunch failed; each is marked failed with the spawn error. */
  failedAgents: string[];
  watcherRestarted: boolean;
};

/**
 * One-shot recovery after sleep or a network drop. Unlike refresh it always stops
 * the supervisor, even when it runs current code: a TUI whose connection dropped
 * is exactly what is broken, and a turn wedged mid-request is the whole case, so
 * neither the mid-turn guard nor a pending plan blocks it. Agents killed by the
 * outage are relaunched and a dead PR watcher is restarted.
 *
 * Relaunching the supervisor is a separate step (`parkReconnectedSupervisor`) so
 * `--all` can skip sessions whose supervisor was not running; this never opens a TUI.
 */
export async function reconnectSession(id: string, config: TackConfig): Promise<ReconnectResult> {
  const session = getSession(id);
  if (!session) throw new Error(`Unknown session ${id}`);
  if (session.status === "archived") throw new Error(`Session ${id} is archived; unarchive it instead`);
  const planPending = Boolean(session.awaiting_input_at && session.awaiting_reason === "plan");

  const supervisorRestarted = await stopSupervisorProcess(session, config);

  // Reset the whole cohort before launching, as unarchive does: dependency gates
  // must see revived prerequisites as pending, not failed (terminal), or a
  // dependent runner that starts first would proceed without them.
  const revive = selectAgentsToRevive(listAgents(id));
  for (const a of revive) {
    resetAgentAttempt(a.id);
    setAgentStatus(a.id, "pending");
  }
  const revivedAgents: string[] = [];
  const failedAgents: string[] = [];
  for (const a of revive) {
    try {
      spawnAgentRunner(id, a.id, { resume: true });
      revivedAgents.push(a.id);
    } catch (error) {
      setAgentError(a.id, error instanceof Error ? error.message : String(error));
      setAgentStatus(a.id, "failed");
      failedAgents.push(a.id);
    }
  }

  let watcherRestarted = false;
  const fresh = getSession(id) ?? session;
  if (!isAlive(fresh.pr_watch_pid) && (listSessionPrs(id).some(isWatchablePr) || hasUnresolvedDependencies(id))) {
    if (fresh.pr_watch_pid) setSessionPrWatchPid(id, null);
    spawnPrWatcher(id, config);
    watcherRestarted = true;
  }

  return { supervisorRestarted, planPending, revivedAgents, failedAgents, watcherRestarted };
}

export type ParkResult =
  | { parked: true }
  /** `no-resume-ref`: the supervisor never got far enough to resume. `no-tmux`:
   * nothing to park it in. `park-failed`: tmux could not create the session. */
  | { parked: false; reason: "no-resume-ref" | "no-tmux" | "park-failed" };

/**
 * Relaunch a reconnected session's supervisor detached in tmux, resuming its
 * conversation with the reconnect message, and hand control straight back. Every
 * reconnect path parks rather than opening a foreground TUI: reconnect is a
 * recovery chore, often run across sessions or from the dashboard, and the user
 * rejoins with `tack session resume` (which attaches) when they want the
 * conversation. Without tmux there is no foreground fallback; the supervisor
 * stays stopped until resume. Re-reads the session because reconnecting may have
 * changed it.
 */
export async function parkReconnectedSupervisor(id: string, config: TackConfig): Promise<ParkResult> {
  const session = getSession(id);
  if (!session) throw new Error(`Unknown session ${id}`);
  if (!session.resume_ref) return { parked: false, reason: "no-resume-ref" };
  if (!tmuxAvailable()) return { parked: false, reason: "no-tmux" };
  const { detached } = await superviseInteractive({ session, prompt: RECONNECT_MESSAGE, resume: true, config, park: true });
  return detached ? { parked: true } : { parked: false, reason: "park-failed" };
}

export type BulkReconnectResult = { session: SessionRow } & (
  | ({ status: "reconnected"; parked: boolean } & ReconnectResult)
  | { status: "error"; error: string });

/** Reconnect every active session without opening a foreground TUI. Only a
 * supervisor that was actually running is replaced, parked detached in tmux;
 * without tmux it stays stopped until resume. Failures stay local so one broken
 * session cannot keep the others from reconnecting. */
export async function reconnectAllSessions(config: TackConfig): Promise<BulkReconnectResult[]> {
  const results: BulkReconnectResult[] = [];
  for (const session of listSessions().filter(s => s.status === "active")) {
    try {
      const result = await reconnectSession(session.id, config);
      const parked = result.supervisorRestarted && (await parkReconnectedSupervisor(session.id, config)).parked;
      results.push({ session, status: "reconnected", parked, ...result });
    } catch (err) {
      results.push({ session, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** One-line human summary of a reconnect, shared by the CLI's single and bulk forms. */
export function describeReconnect(r: ReconnectResult): string {
  const parts = [
    r.supervisorRestarted ? "supervisor restarted" : "supervisor was not running",
    `${r.revivedAgents.length} agent(s) revived`,
  ];
  if (r.failedAgents.length) parts.push(`failed to relaunch ${r.failedAgents.join(", ")}`);
  if (r.watcherRestarted) parts.push("PR watcher restarted");
  if (r.planPending) parts.push("pending plan will be re-presented");
  return parts.join(" · ");
}

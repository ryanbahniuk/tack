import { hasUnresolvedDependencies, isSessionOpen } from "../db";
import type { TackConfig } from "../config/schema";
import { getSession, listAgents, listSessionPrs, listSessions, resetAgentAttempt, setAgentError, setAgentStatus, setSessionPrWatchPid, type AgentRow, type SessionRow } from "../db";
import { isTransientError, spawnAgentRunner } from "../agent/detached";
import { isAlive } from "../process/self";
import { isWatchablePr, spawnPrWatcher } from "../prwatch/watch";
import { superviseInteractive } from "../supervisor/supervise";
import { isSessionStale, stopSupervisorProcess, waitUntilGone } from "./refresh";
import { RESTART_MESSAGE } from "./refresh-message";
import { tmuxAvailable } from "./tmux";

export { RESTART_MESSAGE } from "./refresh-message";

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

export type RestartResult = {
  /** A live supervisor (tmux TUI, launcher, or headless runner) was stopped. */
  supervisorRestarted: boolean;
  /** A plan was awaiting approval; the resumed supervisor is asked to re-present it. */
  planPending: boolean;
  wasStale: boolean;
  wasMidTurn: boolean;
  revivedAgents: string[];
  /** Agents whose relaunch failed; each is marked failed with the spawn error. */
  failedAgents: string[];
  watcherRestarted: boolean;
};

/** Restart session processes and revive dropped agents without guarding a turn.
 * Parking is separate so bulk restart can leave stopped supervisors stopped. */
export async function restartSession(id: string, config: TackConfig): Promise<RestartResult> {
  const session = getSession(id);
  if (!session) throw new Error(`Unknown session ${id}`);
  if (session.status === "archived") throw new Error(`Session ${id} is archived; unarchive it instead`);
  const stale = isSessionStale(session);
  const wasMidTurn = Boolean(session.supervisor_turn_started_at);
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
  if (stale.watcher && isAlive(fresh.pr_watch_pid)) {
    try { process.kill(fresh.pr_watch_pid!, "SIGTERM"); } catch { /* exited */ }
    if (!await waitUntilGone(() => isAlive(fresh.pr_watch_pid))) throw new Error(`PR watcher ${id} did not exit`);
  }
  if (!isAlive(fresh.pr_watch_pid) && (listSessionPrs(id).some(isWatchablePr) || hasUnresolvedDependencies(id))) {
    if (fresh.pr_watch_pid && getSession(id)?.pr_watch_pid === fresh.pr_watch_pid) setSessionPrWatchPid(id, null);
    if (!isAlive(getSession(id)?.pr_watch_pid)) {
      spawnPrWatcher(id, config);
      watcherRestarted = true;
    }
  }

  return { supervisorRestarted, wasStale: stale.stale, wasMidTurn, planPending, revivedAgents, failedAgents, watcherRestarted };
}

export type ParkResult =
  | { parked: true }
  /** `no-resume-ref`: the supervisor never got far enough to resume. `no-tmux`:
   * nothing to park it in. `park-failed`: tmux could not create the session. */
  | { parked: false; reason: "no-resume-ref" | "no-tmux" | "park-failed" };

/** Park the replacement supervisor without opening a foreground TUI. */
export async function parkRestartedSupervisor(id: string, config: TackConfig): Promise<ParkResult> {
  const session = getSession(id);
  if (!session) throw new Error(`Unknown session ${id}`);
  if (!session.resume_ref) return { parked: false, reason: "no-resume-ref" };
  if (!tmuxAvailable()) return { parked: false, reason: "no-tmux" };
  const { detached } = await superviseInteractive({ session, prompt: RESTART_MESSAGE, resume: true, config, park: true });
  return detached ? { parked: true } : { parked: false, reason: "park-failed" };
}

export type BulkRestartResult = { session: SessionRow } & (
  | ({ status: "restarted"; parked: boolean } & RestartResult)
  | { status: "error"; error: string });

/** Restart every active session without opening a foreground TUI. Only a
 * supervisor that was actually running is replaced, parked detached in tmux;
 * without tmux it stays stopped until resume. Failures stay local so one broken
 * session cannot keep the others from restarting. */
export async function restartAllSessions(config: TackConfig): Promise<BulkRestartResult[]> {
  const results: BulkRestartResult[] = [];
  for (const session of listSessions().filter(s => isSessionOpen(s))) {
    try {
      const result = await restartSession(session.id, config);
      const parked = result.supervisorRestarted && (await parkRestartedSupervisor(session.id, config)).parked;
      results.push({ session, status: "restarted", parked, ...result });
    } catch (err) {
      results.push({ session, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** One-line human summary of a restart, shared by the CLI's single and bulk forms. */
export function describeRestart(r: RestartResult): string {
  const parts = [
    r.supervisorRestarted ? "supervisor restarted" : "supervisor was not running",
    `${r.revivedAgents.length} agent(s) revived`,
  ];
  if (r.wasStale) parts.push("moved onto new Tack code");
  if (r.failedAgents.length) parts.push(`failed to relaunch ${r.failedAgents.join(", ")}`);
  if (r.watcherRestarted) parts.push("PR watcher restarted");
  if (r.planPending) parts.push("pending plan will be re-presented");
  return parts.join(" · ");
}

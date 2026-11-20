import { unbootSession } from "../boot";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACTS_DIR, CONTEXT_DIR, LOGS_DIR } from "../paths";
import {
  deleteSession as dbDeleteSession,
  getAgent,
  getSession,
  listAgents,
  listInterruptedAgents,
  markAgentInterrupted,
  clearAgentInterrupted,
  setAgentError,
  setAgentStatus,
  setSessionPrFixEnabled,
  setSessionPrWatchPid,
  setSessionStatus,
} from "../db";
import { spawnAgentRunner } from "../agent/detached";
import { isAlive } from "../process/self";
import { tmuxKillSession } from "./tmux";
import { setPrFix } from "./pr-fix";
import type { TackConfig } from "../config/schema";
import { purgeSessionWorktrees, sessionSnapshotsRoot } from "../worktree/worktree";

function kill(pid: number | null | undefined): void {
  if (!isAlive(pid)) return;
  try {
    process.kill(pid!, "SIGTERM");
  } catch {
    /* already gone */
  }
}

/** Stops a running agent: signals its process and marks it stopped. */
export function stopAgent(agentId: string): void {
  const a = getAgent(agentId);
  if (!a) return;
  kill(a.pid);
  if (a.status === "running" || a.status === "pending") setAgentStatus(agentId, "stopped");
}

/** Stops a session and every agent under it (best-effort), including its PR
 * watcher. Note the session stays `active`, so `tack dashboard` will restart the
 * watcher on its next PR refresh while the session has open PRs — archive the
 * session to stop watching until restored. This does not mark work for resumption. */
export function stopSession(sessionId: string): void {
  const s = getSession(sessionId);
  if (s) {
    kill(s.pid);
    if (s.pr_watch_pid) {
      kill(s.pr_watch_pid);
      setSessionPrWatchPid(sessionId, null);
    }
  }
  for (const a of listAgents(sessionId)) stopAgent(a.id);
}

/** Hold is organizational plus an auto-fix pause: running agents, the supervisor
 * and the PR watcher keep going (hold never stops processes), but the watcher stops
 * spawning pr_fix agents because it skips sessions with `pr_fix_enabled` off.
 * Unhold resumes auto-fix unconditionally — even if the human had turned it off
 * before holding — since leaving hold means "pick this back up". The flag only
 * flips at the transition; `F` / `set_pr_fix` still work while held. Archived
 * sessions refuse both before anything is written. */
function setHold(sessionId: string, status: "active" | "on_hold"): void {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (session.status === "archived") throw new Error(`Session ${sessionId} is archived; unarchive it instead`);
  setSessionStatus(sessionId, status);
}

export function holdSession(sessionId: string): void {
  setHold(sessionId, "on_hold");
  setSessionPrFixEnabled(sessionId, false);
}

/** With a config, enabling goes through `setPrFix` so the watcher is nudged like
 * the dashboard `F` key (trigger failures are swallowed there, so unhold never
 * fails on them); without one, only the DB flag flips and the watcher picks it up
 * on its next tick. */
export async function unholdSession(sessionId: string, config?: TackConfig): Promise<void> {
  setHold(sessionId, "active");
  if (config) await setPrFix(sessionId, true, config);
  else setSessionPrFixEnabled(sessionId, true);
}

/** Stops and hides a session, remembering unfinished work so unarchive can resume it. */
export function archiveSession(sessionId: string): void {
  try { for (const result of unbootSession(null, sessionId)) if (result.error) console.error(result.error); } catch (error) { console.error(error); }
  for (const a of listAgents(sessionId)) markAgentInterrupted(a.id);
  stopSession(sessionId); // SIGTERMs the PR watcher too; an archived session is never re-watched
  tmuxKillSession(sessionId);
  setSessionStatus(sessionId, "archived");
}

/** Restores interrupted agents; the human rejoins the supervisor separately. */
export function unarchiveSession(sessionId: string): { resumedAgents: string[] } {
  setSessionStatus(sessionId, "active");
  const resumedAgents: string[] = [];
  const interrupted = listInterruptedAgents(sessionId);
  // Reset the whole cohort before launching: dependency gates must see pending
  // prerequisites, even if a dependent runner starts before its prerequisite.
  for (const a of interrupted) {
    clearAgentInterrupted(a.id);
    setAgentStatus(a.id, "pending");
  }
  for (const a of interrupted) {
    try {
      spawnAgentRunner(sessionId, a.id, { resume: true });
      resumedAgents.push(a.id);
    } catch (error) {
      setAgentError(a.id, error instanceof Error ? error.message : String(error));
      setAgentStatus(a.id, "failed");
    }
  }
  return { resumedAgents };
}

/**
 * Deletes a session and everything it left behind: stops live processes, removes
 * git worktrees and supervisor snapshots, drops the DB rows (agents/context/
 * amendments/prs cascade), and sweeps its on-disk artifacts/context/logs.
 */
export function deleteSession(sessionId: string): void {
  try { for (const result of unbootSession(null, sessionId)) if (result.error) console.error(result.error); } catch (error) { console.error(error); }
  stopSession(sessionId);
  tmuxKillSession(sessionId);
  purgeSessionWorktrees(sessionId);
  rmSync(sessionSnapshotsRoot(sessionId), { recursive: true, force: true });
  dbDeleteSession(sessionId);
  for (const dir of [ARTIFACTS_DIR, CONTEXT_DIR, LOGS_DIR]) {
    rmSync(join(dir, sessionId), { recursive: true, force: true });
  }
}

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
  setSessionPrWatchPid,
  setSessionStatus,
} from "../db";
import { spawnAgentRunner } from "../agent/detached";
import { isAlive } from "../process/self";
import { stopRun } from "./run";
import { tmuxKillSession } from "./tmux";
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
  stopRun(sessionId);
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

/** Stops and hides a session, remembering unfinished work so unarchive can resume it. */
export function archiveSession(sessionId: string): void {
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
  stopSession(sessionId);
  tmuxKillSession(sessionId);
  purgeSessionWorktrees(sessionId);
  rmSync(sessionSnapshotsRoot(sessionId), { recursive: true, force: true });
  dbDeleteSession(sessionId);
  for (const dir of [ARTIFACTS_DIR, CONTEXT_DIR, LOGS_DIR]) {
    rmSync(join(dir, sessionId), { recursive: true, force: true });
  }
}

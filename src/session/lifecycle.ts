import { rmSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACTS_DIR, CONTEXT_DIR, LOGS_DIR } from "../paths";
import {
  deleteSession as dbDeleteSession,
  getAgent,
  getSession,
  listAgents,
  setAgentStatus,
  setSessionStatus,
} from "../db";
import { isAlive } from "../process/self";
import { purgeSessionWorktrees } from "../worktree/worktree";

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

/** Stops a session and every agent under it (best-effort). */
export function stopSession(sessionId: string): void {
  const s = getSession(sessionId);
  if (s) kill(s.pid);
  for (const a of listAgents(sessionId)) stopAgent(a.id);
}

export function archiveSession(sessionId: string): void {
  setSessionStatus(sessionId, "archived");
}

export function unarchiveSession(sessionId: string): void {
  setSessionStatus(sessionId, "active");
}

/**
 * Deletes a session and everything it left behind: stops live processes, removes
 * git worktrees, drops the DB rows (agents/context/amendments/prs cascade), and
 * sweeps its on-disk artifacts/context/logs.
 */
export function deleteSession(sessionId: string): void {
  stopSession(sessionId);
  purgeSessionWorktrees(sessionId);
  dbDeleteSession(sessionId);
  for (const dir of [ARTIFACTS_DIR, CONTEXT_DIR, LOGS_DIR]) {
    rmSync(join(dir, sessionId), { recursive: true, force: true });
  }
}

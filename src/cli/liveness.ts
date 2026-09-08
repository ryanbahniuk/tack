import { isAlive } from "../process/self";
import type { AgentRow, SessionRow } from "../db";

/** A session is live while its supervisor process is running. */
export function sessionLive(s: SessionRow): boolean {
  return isAlive(s.pid);
}

/** An agent is live while it's marked running and its runner process is alive. */
export function agentLive(a: AgentRow): boolean {
  return a.status === "running" && isAlive(a.pid);
}

/**
 * Whether a session needs the human's attention — either the supervisor is blocked
 * on a decision (a plan awaiting approval, etc.) or there's completed agent work the
 * human hasn't looked at yet. Both signals are ephemeral/re-armable: the awaiting
 * flag toggles per plan iteration, and unread work clears once the human views the
 * session (`stampSessionSeen`). `finished_at`/`last_seen_at` are ISO-UTC, so a plain
 * string compare orders them correctly.
 */
export function sessionNeedsInput(s: SessionRow, agents: AgentRow[]): boolean {
  if (s.awaiting_input_at) return true;
  return agents.some(
    (a) =>
      (a.status === "done" || a.status === "failed") &&
      a.finished_at !== null &&
      (s.last_seen_at === null || a.finished_at > s.last_seen_at),
  );
}

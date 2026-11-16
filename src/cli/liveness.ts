import { readArtifact } from "../artifacts/store";
import { isAlive } from "../process/self";
import type { AgentRow, SessionRow } from "../db";

/** A session is live while its supervisor process is running. */
export function sessionLive(s: SessionRow): boolean {
  return isAlive(s.pid);
}

/**
 * UserPromptSubmit sets the turn flag; Stop / idle_prompt clear it. Liveness
 * guards against a crashed supervisor leaving it set, and a pending plan prompt or
 * open question needs input rather than counting as working.
 */
export function sessionWorking(s: SessionRow): boolean {
  return sessionLive(s) && !!s.supervisor_turn_started_at && !s.awaiting_input_at;
}

/** An agent is live while it's marked running and its runner process is alive. */
export function agentLive(a: AgentRow): boolean {
  return a.status === "running" && isAlive(a.pid);
}

/**
 * Whether a session needs the human's attention — either the supervisor is blocked
 * on a decision (a plan awaiting approval, a question it asked, etc.) or there's completed agent work the
 * human hasn't looked at yet. Both signals are ephemeral/re-armable: the awaiting
 * flag toggles per plan iteration, and unread work clears once the human views the
 * session (`stampSessionSeen`). `finished_at`/`last_seen_at` are ISO-UTC, so a plain
 * string compare orders them correctly.
 *
 * Completed work isn't waiting on the human while siblings are still in flight:
 * the supervisor is still consuming their results via `wait_for_agents`.
 *
 * Pending amendments are deliberately NOT a "needs input" signal: the SYSTEM
 * orchestrates their resolution (the supervisor is surfaced them through
 * `wait_for_agents` and adjudicates with `resolve_amendment`), so they're surfaced
 * in the dashboard for visibility but never flagged as awaiting the human.
 */
export function sessionNeedsInput(s: SessionRow, agents: AgentRow[]): boolean {
  if (s.awaiting_input_at) return true;
  if (agents.some((a) => a.status === "pending" || agentLive(a))) return false;
  return agents.some(
    (a) =>
      (a.status === "done" || a.status === "failed") &&
      a.finished_at !== null &&
      (s.last_seen_at === null || a.finished_at > s.last_seen_at),
  );
}

/** Display publication progress without changing the runtime lifecycle or liveness. */
export function agentDisplayStatus(a: AgentRow): { label: string; color?: string } {
  // A manual workspace's `done` only means "nothing to run"; the human may still be
  // editing it, so don't present it as finished agent work.
  if (a.kind === "manual") return { label: "human", color: "blue" };
  if (a.kind === "review" && a.review_ref) {
    try {
      const { verdict } = JSON.parse(readArtifact(a.review_ref));
      if (["approve", "changes_requested", "comment"].includes(verdict))
        return { label: verdict, color: verdict === "approve" ? "green" : "yellow" };
    } catch { /* A missing report should not prevent rendering agent status. */ }
  }
  if (a.kind === "pr_fix") {
    if (a.status === "done" && !a.post_fixed_at) return { label: "pushing", color: "yellow" };
    switch (a.fix_outcome) {
      case "pushed": return { label: "done", color: "green" };
      case "no_changes": return { label: "no-op", color: "gray" };
      case "push_rejected": return { label: "rejected", color: "yellow" };
      case "not_pushed": return { label: "unpushed", color: "yellow" };
      case "failed": return { label: "failed", color: "red" };
      case "stopped": return { label: "stopped", color: "gray" };
    }
  }
  return {
    label: a.status,
    color: agentLive(a) ? "yellow" : a.status === "done" ? "green" : a.status === "failed" ? "red" : "gray",
  };
}

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

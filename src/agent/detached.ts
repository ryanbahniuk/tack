import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR } from "../paths";
import { selfInvocation } from "../process/self";
import { setAgentPid, getAgent } from "../db";
import type { TackConfig } from "../config/schema";
import { runAgent } from "./execute";

/**
 * Launches a prepared agent as a detached background process (`tack __run-agent
 * <agentId>`) that outlives the caller — so the supervisor can fan out several
 * agents and poll them rather than blocking a tool call on each. Runtime output
 * already tees to the agent's log via the adapter; this process's own stdio is
 * captured to a sibling `.runner.log`. Returns the pid.
 */
export function spawnAgentRunner(sessionId: string, agentId: string): number {
  mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
  const fd = openSync(join(LOGS_DIR, sessionId, `${agentId}.runner.log`), "a");
  const { command, args } = selfInvocation();
  const child = spawn(command, [...args, "__run-agent", agentId], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`Failed to spawn runner for agent ${agentId}`);
  setAgentPid(agentId, child.pid);
  return child.pid;
}

/**
 * Launches the supervisor as a detached background process (`tack __run-supervisor
 * <sessionId> <mode>`) that outlives the caller, so `tack go --background` can
 * return the terminal immediately while planning and delegation continue. The
 * session is created (and its prompt stashed) by the launcher beforehand; the
 * supervisor's own runtime output tees to `supervisor.log`, and this process's
 * stdio is captured to a sibling `supervisor.runner.log`. Returns the pid.
 */
export function spawnSupervisorRunner(sessionId: string, mode: "fresh" | "resume"): number {
  mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
  const fd = openSync(join(LOGS_DIR, sessionId, "supervisor.runner.log"), "a");
  const { command, args } = selfInvocation();
  const child = spawn(command, [...args, "__run-supervisor", sessionId, mode], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`Failed to spawn supervisor runner for session ${sessionId}`);
  return child.pid;
}

/** The `__run-agent` entrypoint: drive a prepared agent to completion. */
export async function runAgentToCompletion(agentId: string, config: TackConfig): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent ${agentId}`);
  setAgentPid(agentId, process.pid);
  const gen = runAgent(agentId, config);
  // Drain the event stream; persistence happens inside runAgent.
  while (!(await gen.next()).done) {
    /* events already persisted; nothing to display in detached mode */
  }
}

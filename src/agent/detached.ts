import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR } from "../paths";
import { selfInvocation } from "../process/self";
import {
  agentDependsOn,
  bumpAgentAttempt,
  getAgent,
  setAgentActivity,
  setAgentPid,
  type AgentStatus,
} from "../db";
import type { TackConfig } from "../config/schema";
import { runAgent } from "./execute";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL: ReadonlySet<AgentStatus> = new Set(["done", "failed", "stopped"]);

/** How many times the runner re-runs an agent that failed with a transient-looking
 * error (rate limit, overload, network). A non-transient failure never retries. */
const MAX_TRANSIENT_RETRIES = 2;

/** Heuristic: does this failure look transient (worth a retry) rather than a genuine
 * task failure? Matches the usual provider/network blips the runtimes surface as
 * error text. Conservative — anything unrecognized is treated as a real failure. */
export function isTransientError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /rate.?limit|overloaded|429|50[0-9]\b|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|temporarily unavailable|service unavailable/i.test(
    message,
  );
}

/**
 * Launches a prepared agent as a detached background process (`tack __run-agent
 * <agentId>`) that outlives the caller — so the supervisor can fan out several
 * agents and poll them rather than blocking a tool call on each. Runtime output
 * already tees to the agent's log via the adapter; this process's own stdio is
 * captured to a sibling `.runner.log`. Returns the pid.
 */
export function spawnAgentRunner(sessionId: string, agentId: string, options: { resume?: boolean } = {}): number {
  mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
  const fd = openSync(join(LOGS_DIR, sessionId, `${agentId}.runner.log`), "a");
  const { command, args } = selfInvocation();
  const child = spawn(command, [...args, "__run-agent", agentId, ...(options.resume ? ["--resume"] : [])], {
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
 * <sessionId> <mode>`) that outlives the caller, so `tack session create --background` can
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

/** The `__run-agent` entrypoint: self-gate on declared dependencies, then drive the
 * agent to completion with transient-failure retry. */
export async function runAgentToCompletion(agentId: string, config: TackConfig, options: { resume?: boolean } = {}): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent ${agentId}`);
  setAgentPid(agentId, process.pid);

  // Dependency ordering (SPEC "correctness of parallel work"): the supervisor can fan
  // out every agent at once with declared `dependsOn`, and each runner holds here
  // until its prerequisites finish — no separate scheduler. The agent stays `pending`
  // (not `running`) while it waits, so the dashboard shows it hasn't started.
  await waitForDependencies(agentId);

  // Transient-failure retry: re-run a failed agent (in the same worktree, so partial
  // committed work persists) when the error looks like a provider/network blip, with
  // exponential backoff. Continuations retain their conversation across retries.
  for (let attempt = 0; ; attempt++) {
    // A continuation retry must never replay the original cold assignment.
    const continuation = Boolean(getAgent(agentId)?.continuation_prompt_ref || agent.continues_agent_id);
    await drain(runAgent(agentId, config, {
      resume: (options.resume && attempt === 0) || (attempt > 0 && continuation),
    }));
    const row = getAgent(agentId);
    if (!row || row.status !== "failed") return;
    if (attempt >= MAX_TRANSIENT_RETRIES || !isTransientError(row.error)) return;
    const next = bumpAgentAttempt(agentId);
    const backoffMs = 5000 * 2 ** attempt;
    setAgentActivity(agentId, `transient error — retrying (attempt ${next + 1}) in ${backoffMs / 1000}s`);
    await sleep(backoffMs);
  }
}

/** Blocks until every declared dependency reaches a terminal state (or is gone),
 * polling the shared DB. Surfaces the wait as the agent's live activity. */
async function waitForDependencies(agentId: string): Promise<void> {
  const deps = agentDependsOn(getAgent(agentId)!);
  if (deps.length === 0) return;
  for (;;) {
    const pending = deps.filter((id) => {
      const d = getAgent(id);
      return d !== null && !TERMINAL.has(d.status);
    });
    if (pending.length === 0) return;
    setAgentActivity(agentId, `waiting on ${pending.join(", ")}`);
    await sleep(3000);
  }
}

/** Drains an agent event generator; persistence happens inside `runAgent`. */
async function drain(gen: ReturnType<typeof runAgent>): Promise<void> {
  while (!(await gen.next()).done) {
    /* events already persisted; nothing to display in detached mode */
  }
}

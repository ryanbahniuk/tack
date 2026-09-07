import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR, TACK_HOME } from "../paths";
import type { TackConfig } from "../config/schema";
import { modelForRole } from "../config/load";
import {
  createSession,
  getSession,
  setSessionCost,
  setSessionResumeRef,
  stampSessionHeartbeat,
  type SessionRow,
} from "../db";
import { resolveRuntime, selectRuntime, type AgentEvent } from "../runtimes";
import { selfCommand } from "../process/self";
import { uuid } from "../util/id";
import { buildSupervisorContext } from "./context";

/**
 * Runs the supervisor for a problem: creates a session, launches the pinned
 * supervisor runtime read-only with its tool server mounted, and streams its
 * planning/coordination events. The supervisor delegates all edits to agents via
 * its tools; here we just persist its (cumulative) cost and resume handle.
 */
export async function* supervise(
  problem: string,
  config: TackConfig,
): AsyncGenerator<AgentEvent, SessionRow> {
  const model = modelForRole(config, "supervisor");
  const session = createSession({
    title: problem.slice(0, 80),
    supervisorModel: model.key,
    runtime: model.runtime,
  });
  stampSessionHeartbeat(session.id, process.pid);

  const contextFile = buildSupervisorContext(session.id, config);
  const supervisorMcp = selfCommand(["__supervisor-mcp", session.id]);
  const runtime = selectRuntime(model.runtime);
  const resolved = resolveRuntime(config, model.runtime); // verifies version pin

  const cwd = join(TACK_HOME, "supervisor", session.id);
  mkdirSync(cwd, { recursive: true });
  const logPath = join(LOGS_DIR, session.id, "supervisor.log");
  // The supervisor reads the repos it plans over, so grant read access to them.
  const addDirs = [...config.projects.map((p) => p.path), ...config.readAllowlist];

  let lastCost = 0;
  for await (const ev of runtime.run({
    prompt: problem,
    cwd,
    model,
    bin: resolved.bin,
    readOnly: true,
    addDirs,
    sessionRef: model.runtime === "claude" ? uuid() : undefined,
    contextFile,
    mcpServers: [{ name: "tack-supervisor", command: supervisorMcp.command, args: supervisorMcp.args }],
    logPath,
  })) {
    if (ev.type === "session") setSessionResumeRef(session.id, ev.ref);
    else if (ev.type === "cost") {
      lastCost = ev.usd; // cost events are cumulative running totals
      setSessionCost(session.id, lastCost);
    }
    yield ev;
  }

  return getSession(session.id)!;
}

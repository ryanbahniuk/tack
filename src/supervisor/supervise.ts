import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR, TACK_HOME } from "../paths";
import type { TackConfig } from "../config/schema";
import { modelForRole, resolveModel } from "../config/load";
import {
  createSession,
  getSession,
  setSessionCost,
  setSessionResumeRef,
  stampSessionHeartbeat,
  type SessionRow,
} from "../db";
import {
  costFromPricing,
  pricingFor,
  resolveRuntime,
  selectRuntime,
  type AgentEvent,
} from "../runtimes";
import { selfCommand } from "../process/self";
import { uuid } from "../util/id";
import { buildSupervisorContext } from "./context";

/**
 * Creates the session row for a new supervisor run and pins the model/runtime it
 * will use. Split out from the run loop so the foreground path and the detached
 * background runner start from an identical, already-persisted session — and so
 * the caller has the id to print (or spawn a runner against) before any work.
 */
export function createSupervisorSession(problem: string, config: TackConfig): SessionRow {
  const model = modelForRole(config, "supervisor");
  return createSession({
    title: problem.slice(0, 80),
    supervisorModel: model.key,
    runtime: model.runtime,
  });
}

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
  const session = createSupervisorSession(problem, config);
  return yield* superviseExisting(session, problem, config);
}

/** Runs a fresh supervisor turn on an already-created session (see `supervise`). */
async function* superviseExisting(
  session: SessionRow,
  problem: string,
  config: TackConfig,
): AsyncGenerator<AgentEvent, SessionRow> {
  const model = resolveModel(config, session.supervisor_model!);
  return yield* runSupervisor({ session, model, prompt: problem, resume: false, config });
}

/**
 * Continues an existing supervisor session with a follow-up prompt, resuming the
 * pinned runtime's conversation (so it keeps its plan, spawned agents, and shared
 * context) rather than starting fresh. Requires the session to have a stored
 * `resume_ref` — i.e. its first run reached the point of emitting a session id.
 */
export async function* resumeSupervise(
  sessionId: string,
  followup: string,
  config: TackConfig,
): AsyncGenerator<AgentEvent, SessionRow> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  if (!session.resume_ref)
    throw new Error(`Session ${sessionId} has no resume handle yet — it never got far enough to follow up on.`);
  if (!session.supervisor_model)
    throw new Error(`Session ${sessionId} has no recorded supervisor model.`);
  const model = resolveModel(config, session.supervisor_model);
  return yield* runSupervisor({
    session,
    model,
    prompt: followup,
    resume: true,
    sessionRef: session.resume_ref,
    config,
  });
}

/**
 * The shared supervisor run loop: mounts the tool server read-only, streams the
 * runtime's events, and persists cost + resume handle. Fresh runs pre-assign a
 * claude session id; resumed runs pass the stored one through with `resume`.
 */
async function* runSupervisor(opts: {
  session: SessionRow;
  model: ReturnType<typeof modelForRole>;
  prompt: string;
  resume: boolean;
  sessionRef?: string;
  config: TackConfig;
}): AsyncGenerator<AgentEvent, SessionRow> {
  const { session, model, prompt, resume, config } = opts;
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
  // Fresh claude runs pre-assign a session id to adopt; resumed runs pass the
  // stored one back through. Codex can't pre-assign, so a fresh run has none.
  const sessionRef = resume ? opts.sessionRef : model.runtime === "claude" ? uuid() : undefined;

  let lastCost = 0;
  for await (const ev of runtime.run({
    prompt,
    cwd,
    model,
    bin: resolved.bin,
    readOnly: true,
    addDirs,
    resume,
    sessionRef,
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

/**
 * Runs the supervisor as an attended, interactive session: launches the pinned
 * runtime's real TUI (claude / codex) with the SAME read-only, delegate-only
 * posture as the headless supervisor — plan mode, no edit tools, only the
 * `tack-supervisor` MCP tools, the supervisor context, and read access to the
 * projects. The runtime owns the terminal, so unlike `supervise` there is no event
 * stream to persist; instead we pre-persist the resume handle up front and recover
 * the session's cost from the runtime's transcript once the TUI exits.
 *
 * `resume` continues an existing session's conversation (its stored `resume_ref`);
 * a fresh run pre-assigns a claude session id so its resume handle and transcript
 * path are known before launch. Returns the session's exit code from the runtime.
 */
export async function superviseInteractive(opts: {
  session: SessionRow;
  prompt: string;
  resume: boolean;
  config: TackConfig;
}): Promise<number> {
  const { session, prompt, resume, config } = opts;
  if (!session.supervisor_model) throw new Error(`Session ${session.id} has no recorded supervisor model.`);
  if (resume && !session.resume_ref)
    throw new Error(`Session ${session.id} has no resume handle yet — it never got far enough to follow up on.`);
  const model = resolveModel(config, session.supervisor_model);
  stampSessionHeartbeat(session.id, process.pid);

  const contextFile = buildSupervisorContext(session.id, config);
  const supervisorMcp = selfCommand(["__supervisor-mcp", session.id]);
  const runtime = selectRuntime(model.runtime);
  const resolved = resolveRuntime(config, model.runtime); // verifies version pin

  const cwd = join(TACK_HOME, "supervisor", session.id);
  mkdirSync(cwd, { recursive: true });
  const addDirs = [...config.projects.map((p) => p.path), ...config.readAllowlist];
  // Fresh claude runs pre-assign a session id so the resume handle + transcript
  // path are known before launch; resumed runs pass the stored one back. Codex
  // can't pre-assign, so a fresh run has none (its id is recovered afterwards).
  const sessionRef = resume ? session.resume_ref! : model.runtime === "claude" ? uuid() : undefined;
  // Persist the resume handle up front so a follow-up (or the dashboard) works even
  // if the user closes the TUI abruptly. Codex has no id yet — see below.
  if (sessionRef) setSessionResumeRef(session.id, sessionRef);

  const spec = runtime.interactiveCommand({
    prompt,
    cwd,
    model,
    bin: resolved.bin,
    readOnly: true,
    addDirs,
    resume,
    sessionRef,
    contextFile,
    mcpServers: [{ name: "tack-supervisor", command: supervisorMcp.command, args: supervisorMcp.args }],
    logPath: join(LOGS_DIR, session.id, "supervisor.log"),
  });

  const proc = Bun.spawn([spec.command, ...spec.args], {
    cwd,
    env: { ...process.env, ...spec.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;

  // Recover cost from the runtime's transcript now that the TUI has exited. For
  // codex, whose id we couldn't pre-assign, recovery falls back to the newest
  // rollout under this cwd's sessions tree.
  const usage = runtime.recoverUsage({ sessionRef, cwd });
  if (usage) {
    const usd = costFromPricing(pricingFor(model), usage);
    if (usd !== null) setSessionCost(session.id, usd);
  }

  return code;
}

/** Whether a detached supervisor run is a brand-new turn or a follow-up resume. */
export type SupervisorRunMode = "fresh" | "resume";

/**
 * Where a launcher stashes the prompt for a detached supervisor run. The prompt
 * can be long/multiline, so we hand it off via a file rather than argv — the
 * runner reads it once at startup, mirroring how `spawnAgentRunner` prepares an
 * agent row before the detached `__run-agent` process picks it up.
 */
function promptPath(sessionId: string): string {
  return join(LOGS_DIR, sessionId, "supervisor.prompt");
}

/** Persists the prompt for a detached supervisor run keyed by session id. */
export function writeSupervisorPrompt(sessionId: string, prompt: string): void {
  mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
  writeFileSync(promptPath(sessionId), prompt, "utf8");
}

/**
 * The `__run-supervisor` entrypoint: drive a supervisor session to completion in
 * a detached background process. Reads the stashed prompt, then runs a fresh turn
 * (session pre-created by the launcher) or resumes an existing one. Events are
 * persisted inside the run loop; nothing is streamed (stdout is the runner log).
 */
export async function runSupervisorToCompletion(
  sessionId: string,
  mode: SupervisorRunMode,
  config: TackConfig,
): Promise<void> {
  const prompt = readFileSync(promptPath(sessionId), "utf8");
  const gen =
    mode === "resume"
      ? resumeSupervise(sessionId, prompt, config)
      : superviseExisting(requireSession(sessionId), prompt, config);
  while (!(await gen.next()).done) {
    /* events persisted inside the run loop; nothing to display when detached */
  }
}

function requireSession(sessionId: string): SessionRow {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  return session;
}

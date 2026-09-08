import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR, TACK_HOME } from "../paths";
import type { TackConfig } from "../config/schema";
import { modelForRole, resolveModel } from "../config/load";
import {
  approveSessionPlan,
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
import { SUPERVISOR_APPROVAL_TOOLS, SUPERVISOR_MCP_NAME } from "../mcp/supervisor-server";
import { buildSupervisorContext } from "./context";
import {
  tmuxAttachArgs,
  tmuxAvailable,
  tmuxClientEnv,
  tmuxEnsureSession,
  tmuxHasSession,
  tmuxSessionName,
  tmuxSetStatusHint,
} from "../session/tmux";

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
    disallowShell: true,
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
 * path are known before launch.
 *
 * When tmux is available the TUI is launched inside a `tack-<sessionId>` tmux
 * session so it can be left parked and reattached (see ./tmux and `attachSupervisor`).
 * The returned `detached` flag says which way the client exited: `true` means the
 * user detached and the supervisor is still running (still on its prompt), `false`
 * means the TUI genuinely exited. Cost is recovered from the transcript only on a
 * real exit — a detach leaves the session live to accrue more.
 */
export async function superviseInteractive(opts: {
  session: SessionRow;
  prompt: string;
  resume: boolean;
  config: TackConfig;
}): Promise<{ code: number; detached: boolean }> {
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

  // The plan-approval gate on `spawn_agent` is flipped by claude's ExitPlanMode
  // hook when the human accepts the plan. Codex has no such hook — instead it keeps
  // approvals interactive (a human okays each tool call natively), so gating there
  // would just deadlock. So: claude wires the hook and starts gated; other runtimes
  // open the gate up front and rely on their own in-loop approvals.
  const usesPlanHook = model.runtime === "claude";
  const approveHook = usesPlanHook ? selfCommand(["__approve-plan", session.id]) : undefined;
  if (!usesPlanHook) approveSessionPlan(session.id);

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
    disallowShell: true,
    addDirs,
    resume,
    sessionRef,
    contextFile,
    mcpServers: [{ name: SUPERVISOR_MCP_NAME, command: supervisorMcp.command, args: supervisorMcp.args }],
    onPlanApproved: approveHook ? { command: approveHook.command, args: approveHook.args } : undefined,
    // Keep opening a PR behind an explicit per-call human ok even after plan approval.
    approvalTools: SUPERVISOR_APPROVAL_TOOLS,
    logPath: join(LOGS_DIR, session.id, "supervisor.log"),
  });

  // Pre-record trust for the freshly-created session cwd so the runtime's TUI
  // doesn't stop to ask before it can start (see Runtime.prepareInteractive).
  runtime.prepareInteractive?.(cwd);

  // Launch inside tmux when it's available so the session can be detached and
  // reattached with its live state intact: create it detached (with a status-bar
  // hint), then attach in the foreground. Otherwise spawn the TUI directly (still
  // fully usable, just not leaveable-and-returnable).
  const tmuxName = tmuxSessionName(session.id);
  const useTmux = tmuxAvailable() && tmuxEnsureSession(session.id, cwd, spec);
  const [command, args] = useTmux
    ? (["tmux", tmuxAttachArgs(tmuxName)] as const)
    : ([spec.command, spec.args] as const);

  const proc = Bun.spawn([command, ...args], {
    cwd,
    // Under tmux the pane already carries spec.env (applied at create); the attach
    // client just needs $TMUX stripped so it can nest if we're inside tmux already.
    env: useTmux ? tmuxClientEnv() : { ...process.env, ...spec.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;

  // A tmux client exits 0 both when the user detaches and when the TUI truly quits;
  // the session's survival is the discriminator — detach leaves it alive, quitting
  // tears it down. Non-tmux runs can only truly exit.
  const detached = useTmux && tmuxHasSession(tmuxName);
  if (!detached) recoverSupervisorCost({ session, model, cwd, sessionRef });

  return { code, detached };
}

/**
 * Reattaches to a parked supervisor's tmux session, handing the caller's terminal
 * back to the still-running TUI (right where they left it — e.g. a pending plan
 * approval). Returns `alive: false` when there's no live tmux session to attach to
 * (it exited, tmux isn't installed, or this session never ran interactively) so the
 * caller can point the user at `--resume` instead. As with the initial launch,
 * `detached` distinguishes leaving again from a real exit, and cost is recovered
 * only on a real exit.
 */
export async function attachSupervisor(
  sessionId: string,
  config: TackConfig,
): Promise<{ code: number; detached: boolean; alive: boolean }> {
  if (!tmuxAvailable()) return { code: 0, detached: false, alive: false };
  const name = tmuxSessionName(sessionId);
  if (!tmuxHasSession(name)) return { code: 0, detached: false, alive: false };

  // Refresh the detach hint for how we're attaching now — nested (inside tmux) vs
  // not — since this session may have been created in the other context.
  tmuxSetStatusHint(sessionId);
  const proc = Bun.spawn(["tmux", ...tmuxAttachArgs(name)], {
    env: tmuxClientEnv(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;

  const detached = tmuxHasSession(name);
  if (!detached) {
    const session = getSession(sessionId);
    if (session?.supervisor_model) {
      const model = resolveModel(config, session.supervisor_model);
      const cwd = join(TACK_HOME, "supervisor", sessionId);
      recoverSupervisorCost({ session, model, cwd, sessionRef: session.resume_ref ?? undefined });
    }
  }
  return { code, detached, alive: true };
}

/**
 * Recover cost from the runtime's transcript once an interactive TUI has exited and
 * persist it. For codex, whose id we couldn't pre-assign, recovery falls back to the
 * newest rollout under this cwd's sessions tree.
 */
function recoverSupervisorCost(opts: {
  session: SessionRow;
  model: ReturnType<typeof resolveModel>;
  cwd: string;
  sessionRef?: string;
}): void {
  const { session, model, cwd, sessionRef } = opts;
  const usage = selectRuntime(model.runtime).recoverUsage({ sessionRef, cwd });
  if (!usage) return;
  const usd = costFromPricing(pricingFor(model), usage);
  if (usd !== null) setSessionCost(session.id, usd);
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

import { usablePreflight, type RunnerPreflight } from "./preflight";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR } from "../paths";
import type { Model, Project, TackConfig } from "../config/schema";
import { modelForRole, resolvePersona, resolveModel, roleModelKeys } from "../config/load";
import {
  createAgent,
  getAgent,
  getSession,
  latestSharedContext,
  setAgentActivity,
  setAgentCost,
  setAgentError,
  setAgentPid,
  setAgentRefs,
  setAgentResumeRef,
  setAgentStatus,
  setAgentUsage,
  setAgentWorktree,
  getSessionPr,
  type AgentKind,
  type AgentRow,
  type SessionRow,
} from "../db";
import { getDb } from "../db";
import { appendAgentArtifact, readArtifact, writeAgentArtifact } from "../artifacts/store";
import { buildAgentContext } from "../context/build";
import { ensureReviewWorktree, ensureRemoteReviewWorktree, ensurePrWorktree, ensureWorktree, existingWorktree, sessionWorktreesRoot, worktreeDiff, type Worktree } from "../worktree/worktree";
import { resolveRuntime, selectRuntime, type AgentEvent } from "../runtimes";
import { checkModelOffered } from "../runtimes/availability";
import { selfCommand } from "../process/self";
import { uuid } from "../util/id";
import { MANUAL_NOT_RUNNABLE } from "../session/manual";

/** Creates the agent record and persists its prompt — fast, in-process. The heavy
 * execution is `runAgent`, so a supervisor tool can prepare an agent then hand it
 * to a detached runner. */
export function prepareAgent(input: {
  session: SessionRow;
  project: Project;
  model: Model;
  prompt: string;
  /** Files/globs this agent is expected to touch (for overlap detection). */
  touches?: string[];
  /** Sibling agent ids that must finish before this agent starts. */
  dependsOn?: string[];
  /** Specialized agents fork from the PR head or the reviewed worker's local head. */
  kind?: AgentKind | null;
  persona?: string | null;
  reviewsAgentId?: string | null;
  /** The session PR a `pr_fix` agent is fixing. */
  sessionPrId?: string | null;
  /** PR fix initiator; supervisor-requested runs are exempt from the daily cap. */
  fixOrigin?: "auto" | "supervisor" | null;
}): AgentRow {
  const agent = createAgent({
    sessionId: input.session.id,
    projectName: input.project.name,
    model: input.model.key,
    runtime: input.model.runtime,
    touches: input.touches ?? null,
    dependsOn: input.dependsOn ?? null,
    kind: input.kind ?? null,
    persona: input.persona,
    reviewsAgentId: input.reviewsAgentId,
    sessionPrId: input.sessionPrId ?? null,
    fixOrigin: input.fixOrigin ?? null,
  });
  const promptRef = writeAgentArtifact(input.session.id, agent.id, "prompt", input.prompt);
  getDb().prepare(`UPDATE agents SET prompt_ref = ? WHERE id = ?`).run(promptRef, agent.id);
  return getAgent(agent.id)!;
}

/**
 * Runs a prepared agent to completion in an isolated worktree, delegating the
 * inner loop to its (version-pinned) runtime and persisting usage/cost/refs as
 * normalized events stream in. Yields every `AgentEvent` for live display; call
 * `getAgent(agentId)` afterward for the final row.
 */
export async function* runAgent(
  agentId: string,
  config: TackConfig,
  options: { resume?: boolean; preflight?: RunnerPreflight; startupLogging?: boolean } = {},
): AsyncGenerator<AgentEvent, { ok: boolean; agent: AgentRow }> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent ${agentId}`);
  // Backstop: a manual workspace is the human's worktree, not a conversation. Running
  // it would hand their edits to a runtime with no prompt, so refuse before any write.
  if (agent.kind === "manual") throw new Error(`Agent ${agentId} ${MANUAL_NOT_RUNNABLE}.`);
  const session = getSession(agent.session_id);
  if (!session) throw new Error(`Agent ${agentId} has no session`);
  const project = config.projects.find((p) => p.name === agent.project_name);
  if (!project) throw new Error(`Agent ${agentId} references unknown project "${agent.project_name}"`);
  const model = agent.model ? resolveModel(config, agent.model) : modelForRole(config, "agent");

  // Backstop for spawns that don't go through `spawn_agent`'s check (PR-watch fix
  // agents, `tack agent`, retries): a model the login doesn't offer fails the agent
  // right away — before a worktree or a runtime run — with the remediation inline,
  // instead of a late `model_not_found` buried in the log. Unknown never blocks.
  const preflight = usablePreflight(options.preflight, model.key, model.runtime) ? options.preflight : undefined;
  const offered = preflight ? { ok: preflight.modelOffered } : checkModelOffered(config, model, {
    role: roleModelKeys(config, "agent").includes(model.key) ? "agent" : undefined,
  });
  if (offered.ok === false) {
    setAgentError(agent.id, offered.message);
    setAgentStatus(agent.id, "failed");
    yield { type: "error", message: offered.message };
    yield { type: "done", ok: false };
    return { ok: false, agent: getAgent(agent.id)! };
  }

  const started = Date.now();
  let phaseStarted = started, phase = "";
  const setPhase = (next: string) => {
    if (phase === next) return;
    if (phase && options.startupLogging) console.error(`[startup] ${phase} ${Date.now() - phaseStarted}ms`);
    phase = next; phaseStarted = Date.now(); setAgentActivity(agent.id, next);
  };
  setPhase(agent.worktree_path && existsSync(agent.worktree_path) || existsSync(join(sessionWorktreesRoot(agent.session_id), agent.id)) ? "reusing worktree" : "creating worktree");
  const worktree = agentWorktree(agent, project.path, project.name, config, setPhase);
  setPhase("preparing context");
  setAgentWorktree(agent.id, worktree.path, worktree.branch);

  // Persist the baseline for later review spawns as well as continuations.
  getDb().prepare("UPDATE agents SET diff_base = COALESCE(diff_base, ?) WHERE id = ?").run(worktree.base, agent.id);
  const reviewed = agent.reviews_agent_id ? getAgent(agent.reviews_agent_id) : null;
  const persona = agent.kind === "review" ? resolvePersona(config, agent.persona ?? "") : undefined;
  const shared = latestSharedContext(session.id);
  const contextFile = buildAgentContext({
    sessionId: session.id,
    agentId: agent.id,
    projectName: project.name,
    sharedContext: shared ? readArtifact(shared.body_ref) : undefined,
    kind: agent.kind,
    persona,
    reviewedPr: agent.kind === "review" && !reviewed && agent.session_pr_id ? (() => {
      const pr = getSessionPr(agent.session_pr_id!);
      return pr?.head_branch ? { number: pr.number, url: pr.url, headBranch: pr.head_branch, base: worktree.base } : undefined;
    })() : undefined,
    reviewedAgent: reviewed ? { id: reviewed.id, branch: reviewed.branch!, base: worktree.base } : undefined,
  });

  const runtime = selectRuntime(model.runtime);
  const resolved = preflight ?? resolveRuntime(config, model.runtime); // verifies the version pin
  const coordination = selfCommand(["__mcp", session.id, agent.id]);
  const logPath = join(LOGS_DIR, session.id, `${agent.id}.log`);
  // Both runtime adapters support headless resume. Pending agents that never
  // acquired a handle still start with their original prompt in the same worktree.
  const continuation = Boolean(agent.continuation_prompt_ref || agent.continues_agent_id);
  const resume = Boolean((options.resume || continuation) && agent.resume_ref);
  const prompt = resume && options.resume && (!continuation || agent.continuation_started_at)
    ? "You were interrupted; continue the task where you left off." +
      (continuation ? "\n\nCurrent instruction:\n" + readArtifact(agent.continuation_prompt_ref ?? agent.prompt_ref) : "")
    : readArtifact(agent.continuation_prompt_ref ?? agent.prompt_ref) || "Continue.";

  if (options.resume || continuation)
    appendAgentArtifact(session.id, agent.id, "transcript", `\n── resumed ${new Date().toISOString()} ──\n`);

  setAgentStatus(agent.id, "running");
  setAgentError(agent.id, null); // clear any error from a prior (failed) attempt
  let ok = false;
  // Accumulate streamed text as a fallback output: a runtime's final `summary` can
  // come back empty (e.g. an agent that ends on a tool call with no closing prose),
  // and we'd rather persist the transcript than leave `read_agent_output` blank.
  let transcript = "";
  // Capture the output artifact's ref so it's persisted alongside the diff below —
  // the file is always written to a deterministic path, but the DB `output_ref` must
  // point at it for `read_agent_output` and the dashboard viewer to find it.
  let outputRef: string | null = null;
  // Remember the last error the runtime reported so a failure is legible in the
  // dashboard (persisted below) instead of only in the raw log.
  let lastError: string | null = null;

  setPhase(`starting ${model.runtime}`);
  let firstEvent = true, firstResponse = false;
  for await (const ev of runtime.run({
    prompt,
    cwd: worktree.path,
    model,
    bin: resolved.bin,
    // Claude adopts a pre-assigned UUID; codex ignores it and reports its own.
    sessionRef: resume ? agent.resume_ref! : uuid(),
    resume,
    fork: continuation && !agent.continuation_started_at,
    contextFile,
    mcpServers: [{ name: "tack", command: coordination.command, args: coordination.args }],
    logPath,
  })) {
    if (firstEvent) { firstEvent = false; setPhase("waiting for first response"); }
    if (!firstResponse && ev.type !== "session") {
      firstResponse = true; if (options.startupLogging) console.error(`[startup] first response after ${Date.now() - started}ms total`);
    }
    if (ev.type === "tool_call" && phase) { if (options.startupLogging) console.error(`[startup] ${phase} ${Date.now() - phaseStarted}ms`); phase = ""; }
    switch (ev.type) {
      case "session":
        setAgentResumeRef(agent.id, ev.ref);
        if (continuation)
          getDb().prepare("UPDATE agents SET continuation_started_at = COALESCE(continuation_started_at, ?) WHERE id = ?")
            .run(new Date().toISOString(), agent.id);
        break;
      case "usage":
        // Events replace this invocation's running total. Add the immutable
        // pre-run snapshot, never the previous event, to preserve earlier turns.
        setAgentUsage(agent.id, {
          input: agent.tokens_input + ev.input,
          output: agent.tokens_output + ev.output,
          cacheRead: agent.cache_read + ev.cacheRead,
          cacheWrite: agent.cache_write + ev.cacheWrite,
        });
        break;
      case "cost":
        setAgentCost(agent.id, agent.cost + ev.usd, ev.source);
        break;
      case "text":
        transcript += ev.text;
        appendAgentArtifact(session.id, agent.id, "transcript", ev.text);
        break;
      case "tool_call":
        // Live "what is this agent doing right now" for the dashboard.
        setAgentActivity(agent.id, activityLabel(ev.tool, ev.input));
        appendAgentArtifact(session.id, agent.id, "transcript", `\n→ ${activityLabel(ev.tool, ev.input)}\n`);
        break;
      case "error":
        // Keep the latest error; the final one is the most relevant on failure.
        lastError = ev.message;
        break;
      case "done": {
        ok = ev.ok;
        const output = ev.summary?.trim() || transcript.trim();
        if (output) outputRef = writeAgentArtifact(session.id, agent.id, "output", output);
        break;
      }
    }
    yield ev;
  }

  if (phase && options.startupLogging) console.error(`[startup] ${phase} ${Date.now() - phaseStarted}ms`);
  const diff = worktreeDiff(worktree, agent.diff_base ?? undefined);
  const diffRef = diff.trim() ? writeAgentArtifact(session.id, agent.id, "diff", diff) : null;
  setAgentRefs(agent.id, { outputRef, diffRef });
  // On failure, persist a reason so the dashboard can show it inline; a transcript
  // tail is a reasonable fallback when the runtime emitted no explicit error.
  if (!ok) setAgentError(agent.id, lastError ?? transcript.trim().slice(-500) ?? null);
  setAgentStatus(agent.id, ok ? "done" : "failed");

  return { ok, agent: getAgent(agent.id)! };
}

/**
 * The worktree an agent runs in. A normal agent forks off the repo's HEAD; a
 * `pr_fix` agent forks off its PR's current remote head (looked up via
 * `session_pr_id`), so its commits land on top of what reviewers see and can be
 * pushed onto the PR branch as a fast-forward. Both reuse an existing worktree on
 * resume/retry, and a continuation (a lineage fork or a requeued row, including a
 * reused `pr_fix` row) always runs in the conversation's own worktree.
 */
function agentWorktree(agent: AgentRow, repoPath: string, project: string, config: TackConfig, onPhase: (label: string) => void): Worktree {
  // Never replace a disappeared lineage cwd with a cold checkout: the runtime
  // conversation is tied to the original directory.
  if ((agent.continues_agent_id || agent.continuation_prompt_ref) &&
      (!agent.worktree_path || !existsSync(agent.worktree_path)))
    throw new Error(`Continuation worktree for ${agent.id} is missing`);
  if (agent.continues_agent_id) {
    if (!agent.worktree_path || !agent.branch || !agent.diff_base)
      throw new Error(`Continuation ${agent.id} has no worktree/baseline`);
    onPhase("reusing worktree");
    return { repo: repoPath, path: agent.worktree_path, branch: agent.branch, base: agent.diff_base };
  }
  if (agent.continuation_prompt_ref && agent.worktree_path && agent.branch) {
    onPhase("reusing worktree");
    const existing = existingWorktree(repoPath, agent.worktree_path, agent.branch);
    // A requeued pr_fix row gets a fresh `diff_base` (the fast-forwarded PR head) per
    // run, so its diff is only that run's work; workers keep their cumulative base.
    return agent.kind === "pr_fix" && agent.diff_base ? { ...existing, base: agent.diff_base } : existing;
  }
  if (agent.kind === "review") {
    const reviewed = agent.reviews_agent_id ? getAgent(agent.reviews_agent_id) : null;
    if (!agent.reviews_agent_id && agent.session_pr_id) {
      const pr = getSessionPr(agent.session_pr_id);
      if (!pr?.head_branch) throw new Error(`Review agent ${agent.id} has no PR head branch`);
      return ensureRemoteReviewWorktree(repoPath, agent.session_id, agent.id, pr.head_branch, pr.base_branch);
    }
    if (!reviewed?.branch || !reviewed.diff_base)
      throw new Error(`Review agent ${agent.id} has no reviewed branch/baseline`);
    return ensureReviewWorktree(repoPath, agent.session_id, agent.id, reviewed.branch, reviewed.diff_base);
  }
  if (agent.kind === "pr_fix") {
    const pr = agent.session_pr_id ? getSessionPr(agent.session_pr_id) : null;
    if (!pr?.head_branch)
      throw new Error(`PR-fix agent ${agent.id} has no PR head branch to work on (session_pr_id=${agent.session_pr_id})`);
    return ensurePrWorktree(repoPath, agent.session_id, agent.id, pr.head_branch);
  }
  return ensureWorktree(repoPath, agent.session_id, agent.id, project, config, onPhase);
}

/**
 * A short, human-readable label for a tool call, shown as the agent's live activity
 * in the dashboard (e.g. `Bash: bun run typecheck`, `Edit src/foo.ts`). Pulls the
 * most telling field out of the (runtime-shaped, loosely-typed) tool input, falling
 * back to just the tool name.
 */
function activityLabel(tool: string, input: unknown): string {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  const detail =
    str("command") ?? str("file_path") ?? str("path") ?? str("pattern") ?? str("query") ?? str("url");
  const label = detail ? `${tool}: ${detail}` : tool;
  return label.replace(/\s+/g, " ").trim();
}

/** Convenience for the direct `tack agent` command: prepare + run inline. */
export async function* executeAgent(input: {
  session: SessionRow;
  project: Project;
  model: Model;
  prompt: string;
  config: TackConfig;
}): AsyncGenerator<AgentEvent, { ok: boolean; agent: AgentRow }> {
  const agent = prepareAgent(input);
  setAgentPid(agent.id, process.pid);
  return yield* runAgent(agent.id, input.config);
}

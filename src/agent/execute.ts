import { join } from "node:path";
import { LOGS_DIR } from "../paths";
import type { Model, Project, TackConfig } from "../config/schema";
import { resolveModel } from "../config/load";
import {
  createAgent,
  getAgent,
  getSession,
  latestSharedContext,
  setAgentCost,
  setAgentPid,
  setAgentRefs,
  setAgentResumeRef,
  setAgentStatus,
  setAgentUsage,
  setAgentWorktree,
  type AgentRow,
  type SessionRow,
} from "../db";
import { getDb } from "../db";
import { readArtifact, writeAgentArtifact } from "../artifacts/store";
import { buildAgentContext } from "../context/build";
import { ensureWorktree, worktreeDiff } from "../worktree/worktree";
import { resolveRuntime, selectRuntime, type AgentEvent } from "../runtimes";
import { selfCommand } from "../process/self";
import { uuid } from "../util/id";

/** Creates the agent record and persists its prompt — fast, in-process. The heavy
 * execution is `runAgent`, so a supervisor tool can prepare an agent then hand it
 * to a detached runner. */
export function prepareAgent(input: {
  session: SessionRow;
  project: Project;
  model: Model;
  prompt: string;
}): AgentRow {
  const agent = createAgent({
    sessionId: input.session.id,
    projectName: input.project.name,
    model: input.model.key,
    runtime: input.model.runtime,
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
): AsyncGenerator<AgentEvent, { ok: boolean; agent: AgentRow }> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent ${agentId}`);
  const session = getSession(agent.session_id);
  if (!session) throw new Error(`Agent ${agentId} has no session`);
  const project = config.projects.find((p) => p.name === agent.project_name);
  if (!project) throw new Error(`Agent ${agentId} references unknown project "${agent.project_name}"`);
  const model = resolveModel(config, agent.model ?? config.roles.agent);

  const worktree = ensureWorktree(project.path, session.id, agent.id);
  setAgentWorktree(agent.id, worktree.path, worktree.branch);

  const shared = latestSharedContext(session.id);
  const contextFile = buildAgentContext({
    sessionId: session.id,
    agentId: agent.id,
    projectName: project.name,
    sharedContext: shared ? readArtifact(shared.body_ref) : undefined,
  });

  const runtime = selectRuntime(model.runtime);
  const resolved = resolveRuntime(config, model.runtime); // verifies the version pin
  const coordination = selfCommand(["__mcp", session.id, agent.id]);
  const logPath = join(LOGS_DIR, session.id, `${agent.id}.log`);
  const prompt = readArtifact(agent.prompt_ref) || "Continue.";

  setAgentStatus(agent.id, "running");
  let ok = false;
  // Accumulate streamed text as a fallback output: a runtime's final `summary` can
  // come back empty (e.g. an agent that ends on a tool call with no closing prose),
  // and we'd rather persist the transcript than leave `read_agent_output` blank.
  let transcript = "";

  for await (const ev of runtime.run({
    prompt,
    cwd: worktree.path,
    model,
    bin: resolved.bin,
    // Claude adopts a pre-assigned UUID; codex ignores it and reports its own.
    sessionRef: model.runtime === "claude" ? uuid() : undefined,
    contextFile,
    mcpServers: [{ name: "tack", command: coordination.command, args: coordination.args }],
    logPath,
  })) {
    switch (ev.type) {
      case "session":
        setAgentResumeRef(agent.id, ev.ref);
        break;
      case "usage":
        setAgentUsage(agent.id, {
          input: ev.input,
          output: ev.output,
          cacheRead: ev.cacheRead,
          cacheWrite: ev.cacheWrite,
        });
        break;
      case "cost":
        setAgentCost(agent.id, ev.usd, ev.source);
        break;
      case "text":
        transcript += ev.text;
        break;
      case "done": {
        ok = ev.ok;
        const output = ev.summary?.trim() || transcript.trim();
        if (output) writeAgentArtifact(session.id, agent.id, "output", output);
        break;
      }
    }
    yield ev;
  }

  const diff = worktreeDiff(worktree);
  const diffRef = diff.trim() ? writeAgentArtifact(session.id, agent.id, "diff", diff) : null;
  setAgentRefs(agent.id, { diffRef });
  setAgentStatus(agent.id, ok ? "done" : "failed");

  return { ok, agent: getAgent(agent.id)! };
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

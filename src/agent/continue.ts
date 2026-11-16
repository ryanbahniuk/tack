import { existsSync } from "node:fs";
import type { TackConfig } from "../config/schema";
import { resolveModel } from "../config/load";
import { getAgent, getDb, getSession, listSessionPrs } from "../db";
import { writeContinuationPrompt } from "../artifacts/store";
import { checkModelOffered } from "../runtimes/availability";
import { uuid } from "../util/id";

/** Validate before changing the row: failed follow-ups must leave its prior result
 * reviewable. Queue synchronously so two tool calls cannot resume it together. */
export function prepareContinuation(sessionId: string, agentId: string, prompt: string, config: TackConfig, modelKey?: string) {
  const session = getSession(sessionId);
  if (!session?.plan_approved_at)
    throw new Error("Plan not approved. Use request_plan_approval before continue_agent.");
  const agent = getAgent(agentId);
  if (!agent || agent.session_id !== sessionId)
    throw new Error("Agent is not in this session; use spawn_agent for a new unit.");
  if (agent.kind === "manual")
    throw new Error("Manual workspaces are the human's own edits with no agent conversation, so they can't be continued. " +
      "Open its PR with open_pr when the human asks, or spawn_agent for new agent work.");
  // Review agents may answer follow-up questions in the same conversation.
  if (agent.kind === "pr_fix") throw new Error("PR-fix agents cannot be continued directly; use fix_pr.");
  if (agent.status !== "done" && agent.status !== "failed")
    throw new Error(`Agent is ${agent.status}; use wait_for_agents before continue_agent (only done/failed agents qualify).`);
  if (listSessionPrs(sessionId).some(p => p.agent_id === agentId && ["open", "draft"].includes(p.state ?? "")))
    throw new Error("Agent already has an open PR; use fix_pr.");
  if (!agent.resume_ref) throw new Error("Agent has no resume_ref; use spawn_agent.");
  if (!agent.worktree_path || !agent.branch || !existsSync(agent.worktree_path))
    throw new Error("Agent worktree is missing; use spawn_agent.");
  const model = resolveModel(config, modelKey ?? agent.model ?? "");
  if (model.runtime !== agent.runtime)
    throw new Error("Conversations cannot cross runtimes; use spawn_agent.");
  const offered = checkModelOffered(config, model);
  if (!offered.ok) throw new Error(`Refusing to continue: ${offered.message}`);
  const ref = writeContinuationPrompt(sessionId, agentId, uuid(), prompt);
  const queued = getDb().prepare(`
    UPDATE agents SET continuation_prompt_ref = ?, continuation_started_at = NULL,
      model = ?, error = NULL, status = 'pending', finished_at = NULL, updated_at = ?
    WHERE id = ? AND status IN ('done', 'failed')
  `).run(ref, model.key, new Date().toISOString(), agentId);
  if (!queued.changes) throw new Error("Agent is already queued; use wait_for_agents before continue_agent.");
  return getAgent(agentId)!;
}

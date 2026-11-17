import type { AgentRow } from "../db";
export function resolveBootTarget(agents: AgentRow[], project: string, agentId: string | undefined, exists: (path: string) => boolean):
  { ok: true; agent: AgentRow; path: string } | { ok: false; reason: "none" | "ambiguous" | "not_found"; message: string; candidates?: AgentRow[] } {
  const candidates = agents.filter(a => a.project_name === project && a.kind !== "pr_fix" && a.worktree_path && exists(a.worktree_path));
  if (agentId) {
    const agent = candidates.find(a => a.id === agentId);
    return agent ? { ok: true, agent, path: agent.worktree_path! } : { ok: false, reason: "not_found", message: `Agent ${agentId} has no eligible worktree for ${project}.` };
  }
  if (!candidates.length) return { ok: false, reason: "none", message: `No worktree exists for ${project}.` };
  if (candidates.length > 1) return { ok: false, reason: "ambiguous", message: `Several worktrees exist for ${project}: ${candidates.map(a => `${a.id} (${a.worktree_path})`).join(", ")}`, candidates };
  return { ok: true, agent: candidates[0]!, path: candidates[0]!.worktree_path! };
}

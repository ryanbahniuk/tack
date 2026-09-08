import { writeContextFile } from "../artifacts/store";

export interface AgentContextParts {
  sessionId: string;
  agentId: string;
  projectName: string;
  /** The current shared contract body, if the supervisor has authored one. */
  sharedContext?: string;
}

/**
 * Materializes the single context file handed to an agent BY PATH. This is
 * Tack-owned guidance layered on top of — never replacing — the repo's own
 * CLAUDE.md/AGENTS.md. It frames the agent's role, surfaces the shared contract,
 * documents the coordination tools, and tells the agent how to finish (commit its
 * work; the supervisor, not the agent, opens PRs).
 */
export function buildAgentContext(parts: AgentContextParts): string {
  const sections: string[] = [];

  sections.push(
    [
      "# Tack agent",
      "",
      "You are an autonomous coding agent coordinated by a Tack supervisor. You are",
      "running in an isolated git worktree dedicated to you; work only within it. Follow",
      "the repository's own conventions (its CLAUDE.md / AGENTS.md) as the source of truth",
      "for how to write code here.",
    ].join("\n"),
  );

  if (parts.sharedContext && parts.sharedContext.trim()) {
    sections.push(["## Shared contract", "", parts.sharedContext.trim()].join("\n"));
  }

  sections.push(
    [
      "## Coordination",
      "",
      "A `tack` MCP server is available with these tools:",
      "- `read_shared_context` — the cross-agent contract; conform to it.",
      "- `list_agents` — your sibling agents and their status.",
      "- `propose_amendment` — flag a wrong/incomplete contract (use sparingly; the",
      "  supervisor adjudicates). Keep working under the current contract meanwhile.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Finishing up",
      "",
      "When your task is complete, commit ALL of your changes to your worktree branch",
      "with clear messages (several commits are fine). Do NOT open a pull request and do",
      "NOT push — the supervisor reviews every agent's work, summarizes it for the human,",
      "and opens PRs itself once approved. Anything you leave uncommitted risks being",
      "left out, so make sure your working tree is clean before you finish.",
    ].join("\n"),
  );

  return writeContextFile(parts.sessionId, `${parts.agentId}.context.md`, sections.join("\n\n") + "\n");
}

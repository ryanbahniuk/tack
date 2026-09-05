import { writeContextFile } from "../artifacts/store";
import { sessionPrBranch } from "../worktree/worktree";

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
 * documents the coordination tools, and pins the PR-branch nomenclature so a PR
 * can be discovered and tied back to the session.
 */
export function buildAgentContext(parts: AgentContextParts): string {
  const branch = sessionPrBranch(parts.sessionId, "<short-slug>");
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
      "## Opening a PR",
      "",
      "If your task warrants a pull request, create it with the `gh` CLI from a branch",
      `named \`${branch}\` (replace \`<short-slug>\` with a few words describing the change).`,
      "Encoding the session id in the branch is what lets Tack find the PR afterward.",
    ].join("\n"),
  );

  return writeContextFile(parts.sessionId, `${parts.agentId}.context.md`, sections.join("\n\n") + "\n");
}

import { writeContextFile } from "../artifacts/store";
import type { AgentKind } from "../db";

export interface AgentContextParts {
  sessionId: string;
  agentId: string;
  projectName: string;
  /** The current shared contract body, if the supervisor has authored one. */
  sharedContext?: string;
  /** `pr_fix` for a PR-watch fix agent (different tools + finishing rules). */
  kind?: AgentKind | null;
}

/**
 * Materializes the single context file handed to an agent BY PATH. This is
 * Tack-owned guidance layered on top of — never replacing — the repo's own
 * CLAUDE.md/AGENTS.md. It frames the agent's role, surfaces the shared contract,
 * documents the coordination tools, and tells the agent how to finish (commit its
 * work; the supervisor, not the agent, opens PRs).
 *
 * A `pr_fix` agent (spawned by the PR watcher) gets a variant: it is working on an
 * EXISTING pull request, so it must also report a decision + reply per review item
 * via `report_pr_feedback`, and — like every agent — never pushes or talks to GitHub
 * itself; the watcher pushes its commits and posts the replies.
 */
export function buildAgentContext(parts: AgentContextParts): string {
  const sections: string[] = [];
  const prFix = parts.kind === "pr_fix";

  sections.push(
    [
      "# Tack agent",
      "",
      "You are an autonomous coding agent coordinated by a Tack supervisor. You are",
      "running in an isolated git worktree dedicated to you; work only within it. Follow",
      "the repository's own conventions (its CLAUDE.md / AGENTS.md) as the source of truth",
      "for how to write code here.",
      ...(prFix
        ? [
            "",
            "You are a PR-fix agent: your worktree is checked out at the current head of an",
            "open pull request, and your task is to address its review feedback and/or merge",
            "conflict. Your commits are pushed onto that PR by Tack once you finish.",
          ]
        : []),
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
      ...(prFix
        ? [
            "- `report_pr_feedback` — record your decision (`fixed` | `declined` |",
            "  `not_applicable`) and a short plain reply (1-3 sentences) for EVERY review item",
            "  in your task, by its `sourceId`. Call it once, before you finish. Tack posts",
            "  each reply on GitHub for you; items you don't report are treated as declined.",
          ]
        : []),
    ].join("\n"),
  );

  sections.push(
    prFix
      ? [
          "## Finishing up",
          "",
          "When you're done, commit ALL of your changes to your worktree branch with clear",
          "messages (a merge commit for a conflict resolution, plus one or more commits for",
          "fixes). Then call `report_pr_feedback` once with a decision and reply for every",
          "item. Do NOT push and do NOT call `gh` or the GitHub API — Tack pushes your",
          "commits to the PR (non-force) and posts your replies. Leave the working tree",
          "clean; anything uncommitted risks being left out.",
        ].join("\n")
      : [
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

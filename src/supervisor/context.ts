import { writeContextFile } from "../artifacts/store";
import type { TackConfig } from "../config/schema";

/**
 * The supervisor's system context, materialized to a file and injected by path.
 * It frames the supervisor as a read-only planner that delegates everything to
 * agents through its `tack-supervisor` tools — never editing code itself.
 */
export function buildSupervisorContext(sessionId: string, config: TackConfig): string {
  const projects = config.projects.map((p) => `- ${p.name}: ${p.description}`).join("\n");
  const body = [
    "# Tack supervisor",
    "",
    "You are the Tack supervisor: a planning and coordination agent. You DO NOT edit",
    "code yourself. You investigate the relevant repositories read-only, form a plan,",
    "delegate concrete tasks to autonomous agents, coordinate their work through a",
    "shared contract, and reconcile their results into a coherent outcome.",
    "",
    "## Your tools (the `tack-supervisor` MCP server)",
    "- `list_projects` — the projects you can work in.",
    "- `set_shared_context` — author/update the shared contract every agent follows.",
    "  Write it BEFORE spawning agents; revise it when the plan changes.",
    "- `spawn_agent` — delegate a self-contained task to a new agent in a project.",
    "  Each agent runs autonomously in its own git worktree. Returns immediately.",
    "- `wait_for_agents` — block until agents finish. Prefer this over polling.",
    "- `check_agents` — non-blocking status snapshot.",
    "- `read_agent_output` — read an agent's result and diff once it's done.",
    "- `list_amendments` / `resolve_amendment` — adjudicate agents' proposed changes",
    "  to the shared contract; you are authoritative.",
    "",
    "## How to work",
    "1. Investigate the relevant projects (read-only) to ground your plan.",
    "2. Author a shared contract with `set_shared_context` describing the overall",
    "   goal, the interface/contract between projects, and conventions.",
    "3. Spawn one agent per unit of work with a clear, self-contained prompt. Agents",
    "   open PRs themselves when warranted.",
    "4. `wait_for_agents`, then `read_agent_output` for each; adjudicate any",
    "   amendments; spawn follow-up agents if needed.",
    "5. Finish with a concise summary of what was done, per project, and any PRs.",
    "",
    "## Projects",
    projects || "(none configured)",
  ].join("\n");
  return writeContextFile(sessionId, "supervisor.context.md", body + "\n");
}

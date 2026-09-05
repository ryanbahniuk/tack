import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, resolveModel } from "../config/load";
import { getSession } from "../db";
import {
  addSharedContext,
  getAgent,
  latestSharedContext,
  listAgents,
  listPendingAmendments,
  resolveAmendment,
  type AgentStatus,
} from "../db";
import {
  readArtifact,
  writeAmendmentArtifact,
  writeSharedContext,
} from "../artifacts/store";
import { prepareAgent } from "../agent/execute";
import { spawnAgentRunner } from "../agent/detached";

const TERMINAL: AgentStatus[] = ["done", "failed", "stopped"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The supervisor's tool server. The supervisor is itself a runtime session
 * (claude|codex) running read-only; these tools are how it plans, delegates to
 * agents, waits on them, reads their results, and adjudicates amendments — the
 * whole coordination loop, runtime-agnostic.
 */
export async function runSupervisorServer(sessionId: string): Promise<void> {
  const config = await loadConfig();
  const server = new McpServer({ name: "tack-supervisor", version: "1.0.0" });

  const requireSession = () => {
    const s = getSession(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    return s;
  };

  server.registerTool(
    "list_projects",
    { description: "List the projects available to work in, with their descriptions.", inputSchema: {} },
    async () => text(config.projects.map((p) => ({ name: p.name, description: p.description }))),
  );

  server.registerTool(
    "set_shared_context",
    {
      description:
        "Author or update the shared contract all agents must follow (the cross-agent coordination context). " +
        "Call this before spawning agents, and again when the plan changes.",
      inputSchema: { body: z.string().describe("The full contract text (markdown).") },
    },
    async ({ body }) => {
      const version = ((latestVersion(sessionId) ?? 0) + 1);
      const ref = writeSharedContext(sessionId, version, body);
      addSharedContext({ sessionId, bodyRef: ref, authoredBy: "supervisor" });
      return text({ ok: true, version });
    },
  );

  server.registerTool(
    "spawn_agent",
    {
      description:
        "Delegate a task to a new agent in the given project. The agent runs autonomously in its own " +
        "worktree; this returns immediately with the agent id. Use wait_for_agents to await completion.",
      inputSchema: {
        project: z.string().describe("Project name from list_projects"),
        prompt: z.string().describe("The task for the agent, self-contained"),
        model: z.string().optional().describe("Model name; defaults to the configured agent model"),
      },
    },
    async ({ project, prompt, model }) => {
      const session = requireSession();
      const proj = config.projects.find((p) => p.name === project);
      if (!proj) throw new Error(`Unknown project "${project}"`);
      const m = resolveModel(config, model ?? config.roles.agent);
      const agent = prepareAgent({ session, project: proj, model: m, prompt });
      spawnAgentRunner(session.id, agent.id);
      return text({ agentId: agent.id, project, model: m.name, runtime: m.runtime });
    },
  );

  server.registerTool(
    "check_agents",
    { description: "Snapshot of this session's agents: status, model, cost (non-blocking).", inputSchema: {} },
    async () => text(listAgents(sessionId).map(agentSummary)),
  );

  server.registerTool(
    "wait_for_agents",
    {
      description:
        "Block until the given agents (or all agents) reach a terminal state (done/failed/stopped), or the " +
        "timeout elapses. Returns their final status. Prefer this over polling check_agents.",
      inputSchema: {
        agentIds: z.array(z.string()).optional().describe("Specific agents to await; omit for all"),
        timeoutSeconds: z.number().optional().describe("Max wait (default 1800)"),
      },
    },
    async ({ agentIds, timeoutSeconds }) => {
      const deadline = Date.now() + (timeoutSeconds ?? 1800) * 1000;
      while (Date.now() < deadline) {
        const agents = listAgents(sessionId).filter((a) => !agentIds || agentIds.includes(a.id));
        if (agents.length > 0 && agents.every((a) => TERMINAL.includes(a.status))) {
          return text({ done: true, agents: agents.map(agentSummary) });
        }
        await sleep(3000);
      }
      return text({ done: false, timedOut: true, agents: listAgents(sessionId).map(agentSummary) });
    },
  );

  server.registerTool(
    "read_agent_output",
    {
      description: "Read an agent's final result and a preview of its diff.",
      inputSchema: { agentId: z.string() },
    },
    async ({ agentId }) => {
      const a = getAgent(agentId);
      if (!a) throw new Error(`Unknown agent ${agentId}`);
      const output = readArtifact(a.output_ref);
      const diff = readArtifact(a.diff_ref);
      return text({
        status: a.status,
        cost: a.cost,
        branch: a.branch,
        output: output || "(no textual output captured)",
        diffPreview: diff ? diff.split("\n").slice(0, 200).join("\n") : "(no diff)",
      });
    },
  );

  server.registerTool(
    "list_amendments",
    { description: "Pending amendment proposals from agents, awaiting your adjudication.", inputSchema: {} },
    async () =>
      text(
        listPendingAmendments(sessionId).map((am) => ({
          id: am.id,
          proposedBy: am.proposed_by,
          proposal: readArtifact(am.proposal_ref),
        })),
      ),
  );

  server.registerTool(
    "resolve_amendment",
    {
      description:
        "Adjudicate a pending amendment. On accept you may supply revised shared-context text, which becomes " +
        "the new contract version.",
      inputSchema: {
        id: z.string(),
        decision: z.enum(["accept", "reject"]),
        note: z.string().optional(),
        newContext: z.string().optional().describe("Revised full contract (on accept)"),
      },
    },
    async ({ id, decision, note, newContext }) => {
      const resolutionRef = note ? writeAmendmentArtifact(sessionId, id, "resolution", note) : null;
      resolveAmendment(id, decision === "accept" ? "accepted" : "rejected", resolutionRef);
      if (decision === "accept" && newContext) {
        const version = (latestVersion(sessionId) ?? 0) + 1;
        const ref = writeSharedContext(sessionId, version, newContext);
        addSharedContext({ sessionId, bodyRef: ref, authoredBy: "supervisor" });
        return text({ ok: true, decision, newContextVersion: version });
      }
      return text({ ok: true, decision });
    },
  );

  await server.connect(new StdioServerTransport());
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function agentSummary(a: ReturnType<typeof listAgents>[number]) {
  return {
    id: a.id,
    project: a.project_name,
    status: a.status,
    model: a.model,
    runtime: a.runtime,
    cost: a.cost,
    branch: a.branch,
  };
}

function latestVersion(sessionId: string): number | null {
  return latestSharedContext(sessionId)?.version ?? null;
}

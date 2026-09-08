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
  upsertSessionPr,
  type AgentStatus,
} from "../db";
import {
  readArtifact,
  writeAmendmentArtifact,
  writeSharedContext,
} from "../artifacts/store";
import { prepareAgent } from "../agent/execute";
import { spawnAgentRunner } from "../agent/detached";
import { commitWorktree, sessionPrBranch } from "../worktree/worktree";
import { openSessionPr } from "../projects/prs";

const TERMINAL: AgentStatus[] = ["done", "failed", "stopped"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The MCP name this server is mounted under (see supervise.ts). */
export const SUPERVISOR_MCP_NAME = "tack-supervisor";

/**
 * Supervisor tools that must prompt the human on every call rather than riding the
 * server-wide auto-allow — opening a PR is outward-facing, so it stays behind an
 * explicit per-call human ok even after the plan is approved. The attended
 * launcher hands these to the runtime as `approvalTools`.
 */
export const SUPERVISOR_APPROVAL_TOOLS = [`mcp__${SUPERVISOR_MCP_NAME}__open_pr`];

/**
 * Plain-language wording for the `open_pr` approval prompt, handed to the runtime as
 * `approvalPrompt` so the human sees "Open a PR for this?" instead of the generic
 * MCP "requires confirmation for this tool" line.
 */
export const SUPERVISOR_APPROVAL_PROMPT = "Open a PR for this?";

/**
 * Plain-language wording for the plan-approval prompt. Handed to the runtime via
 * the ExitPlanMode PreToolUse hook so the human sees a single approve/change
 * decision instead of Claude's native "auto-accept edits vs manually approve
 * edits" fork. That fork is meaningless here: the supervisor never edits, and the
 * agents it spawns always run headless in auto mode (see PERMISSION_ARGS in the
 * claude adapter) regardless of which branch the human would pick — so we suppress
 * it and state plainly what approving does.
 */
export const SUPERVISOR_PLAN_APPROVAL_PROMPT =
  "Start the agents on this plan? They run autonomously in auto mode.";

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
    async () =>
      text(
        config.projects.map((p) => ({
          name: p.name,
          description: p.description,
          language: p.metadata?.language,
          frameworks: p.metadata?.frameworks,
        })),
      ),
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
      // Plan-gate: agents only run once the human has approved the plan (attended
      // sessions flip this via the ExitPlanMode hook; background sessions are
      // pre-approved). Refuse until then so a spawn can't slip out during planning.
      if (!session.plan_approved_at)
        throw new Error(
          "Plan not approved yet. Present your plan and shared contract to the human and let them accept " +
            "it before spawning any agents. Don't ask the human to change or exit any mode — just wait for " +
            "their approval. `spawn_agent` stays blocked until then.",
        );
      const proj = config.projects.find((p) => p.name === project);
      if (!proj) throw new Error(`Unknown project "${project}"`);
      const m = resolveModel(config, model ?? config.roles.agent);
      const agent = prepareAgent({ session, project: proj, model: m, prompt });
      spawnAgentRunner(session.id, agent.id);
      return text({ agentId: agent.id, project, model: m.name, runtime: m.runtime });
    },
  );

  server.registerTool(
    "open_pr",
    {
      description:
        "Open a pull request for a finished agent's committed work. YOU own PRs — agents no longer open their " +
        "own. Only call this AFTER the agents finish, you've summarized what each did, and the human has " +
        "explicitly approved opening PRs. Pushes the agent's worktree branch under the tack/pr/<session>/<slug> " +
        "nomenclature and runs `gh pr create`; returns the PR url.",
      inputSchema: {
        agentId: z.string().describe("The finished agent whose committed work becomes the PR"),
        title: z.string().describe("PR title"),
        body: z.string().describe("PR description (markdown)"),
        slug: z.string().optional().describe("Short branch slug; derived from the title if omitted"),
        base: z.string().optional().describe("Base branch to target; defaults to the repo's default branch"),
        draft: z.boolean().optional().describe("Open as a draft PR"),
      },
    },
    async ({ agentId, title, body, slug, base, draft }) => {
      requireSession();
      const a = getAgent(agentId);
      if (!a) throw new Error(`Unknown agent ${agentId}`);
      if (a.session_id !== sessionId) throw new Error(`Agent ${agentId} isn't part of this session`);
      if (!a.branch || !a.worktree_path)
        throw new Error(`Agent ${agentId} has no worktree yet — it hasn't run.`);
      const proj = config.projects.find((p) => p.name === a.project_name);
      if (!proj) throw new Error(`Unknown project "${a.project_name}"`);
      // Safety net: fold any changes the agent left uncommitted into its branch so
      // nothing is dropped from the PR (a push only carries commits).
      commitWorktree(a.worktree_path, `Tack: finalize work for agent ${agentId}`);
      const pr = openSessionPr({
        repoPath: proj.path,
        localBranch: a.branch,
        prBranch: sessionPrBranch(sessionId, slug ?? title),
        title,
        body,
        base,
        draft,
      });
      upsertSessionPr({
        sessionId,
        url: pr.url,
        agentId,
        projectName: a.project_name,
        number: pr.number,
        title,
        state: draft ? "draft" : "open",
        headBranch: pr.headBranch,
      });
      return text({ ok: true, url: pr.url, number: pr.number, branch: pr.headBranch });
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

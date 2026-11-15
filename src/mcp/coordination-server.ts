import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readArtifact, writeAmendmentArtifact, writePrFeedbackArtifact, writeAgentArtifact } from "../artifacts/store";
import {
  setAgentReviewRef,
  createAmendment,
  getAgent,
  latestSharedContext,
  listAgentPrFeedback,
  listAgents,
  recordPrFeedbackDecision,
} from "../db";

/**
 * The Tack coordination MCP server — the cross-runtime shared-state bus. Each
 * agent's CLI spawns its own instance (`tack __mcp <sessionId> <agentId>`) via its
 * MCP config; all instances read/write the same SQLite DB, so an agent under
 * `claude` and one under `codex` share context identically. This is how "context
 * is shared" at runtime without touching either CLI's native session store.
 */
export async function runCoordinationServer(sessionId: string, agentId: string): Promise<void> {
  const server = new McpServer({ name: "tack", version: "1.0.0" });

  server.registerTool(
    "read_shared_context",
    {
      description:
        "Read the current shared coordination context — the cross-agent contract for this session. " +
        "Conform to it unless the supervisor tells you otherwise.",
      inputSchema: {},
    },
    async () => {
      const ctx = latestSharedContext(sessionId);
      const body = ctx ? readArtifact(ctx.body_ref) : "";
      return { content: [{ type: "text", text: body || "(no shared context yet)" }] };
    },
  );

  server.registerTool(
    "list_agents",
    {
      description: "List the sibling agents in this session and their status, model, and cost.",
      inputSchema: {},
    },
    async () => {
      const rows = listAgents(sessionId).map((a) => ({
        id: a.id,
        project: a.project_name,
        status: a.status,
        model: a.model,
        runtime: a.runtime,
        cost: a.cost,
      }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.registerTool(
    "propose_amendment",
    {
      description:
        "Propose an amendment to the shared context when you believe the contract is wrong or incomplete. " +
        "Use sparingly — the supervisor is authoritative and adjudicates proposals.",
      inputSchema: { proposal: z.string().describe("What should change in the contract, and why") },
    },
    async ({ proposal }) => {
      const amendment = createAmendment({ sessionId, proposedBy: agentId, proposalRef: "" });
      const ref = writeAmendmentArtifact(sessionId, amendment.id, "proposal", proposal);
      // Backfill the ref now that we have the amendment id (proposal body on disk).
      const { getDb } = await import("../db");
      getDb().prepare(`UPDATE amendments SET proposal_ref = ? WHERE id = ?`).run(ref, amendment.id);
      return {
        content: [
          {
            type: "text",
            text: `Amendment ${amendment.id} recorded (pending supervisor review). Continue with the current contract meanwhile.`,
          },
        ],
      };
    },
  );

  server.registerTool("report_review", {
    description: "Report a persona review once before finishing. Only review agents may use this tool.",
    inputSchema: {
      verdict: z.enum(["approve", "changes_requested", "comment"]),
      summary: z.string(),
      findings: z.array(z.object({
        severity: z.enum(["blocker", "major", "minor", "nit"]),
        file: z.string().optional(), line: z.number().int().positive().optional(),
        title: z.string(), detail: z.string(),
      })),
    },
  }, async (report) => {
    const agent = getAgent(agentId);
    if (agent?.kind !== "review" || agent.session_id !== sessionId)
      throw new Error("report_review is only available to review agents in this session.");
    if (agent.review_ref) throw new Error("Review already reported; call report_review exactly once.");
    const ref = writeAgentArtifact(sessionId, agentId, "review", JSON.stringify(report, null, 2));
    setAgentReviewRef(agentId, ref);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });

  // PR-fix agents only: the channel through which a fix agent hands its per-comment
  // verdicts back to the PR watcher. The agent never talks to GitHub; the watcher
  // reads these rows after the run, pushes, and posts each reply.
  if (getAgent(agentId)?.kind === "pr_fix") {
    server.registerTool(
      "report_pr_feedback",
      {
        description:
          "Report your decision and reply for each PR review or CI check item you were asked to handle, by its sourceId. " +
          "Call once before finishing, covering EVERY item. decision: 'fixed' (you changed code and committed), " +
          "'declined' (relevant but not justified / you disagree), or 'not_applicable' (not actionable, e.g. " +
          "informational, bot noise, or CI failures unrelated to the PR). reply: 1-3 plain sentences saying what you did or why not. Tack posts the " +
          "replies on GitHub after pushing your commits — do not push or call gh yourself.",
        inputSchema: {
          items: z
            .array(
              z.object({
                sourceId: z.string().describe("The item's sourceId from your task"),
                decision: z.enum(["fixed", "declined", "not_applicable"]),
                reply: z.string().min(1).describe("1-3 sentences: what you did, or why not"),
              }),
            )
            .min(1),
        },
      },
      async ({ items }) => {
        // Only this agent's own still-open rows are addressable; anything else is a
        // typo or a hallucinated id, and we reject the whole call (recording nothing)
        // so the agent can correct it and retry rather than half-apply.
        const mine = listAgentPrFeedback(agentId).filter((f) => f.handled_at === null);
        const byId = new Map(mine.map((f) => [f.source_id, f]));
        const unknown = items.filter((i) => !byId.has(i.sourceId)).map((i) => i.sourceId);
        if (unknown.length > 0) {
          throw new Error(
            `Unknown sourceId(s): ${unknown.join(", ")}. Valid ids for your task: ${[...byId.keys()].join(", ") || "(none)"}`,
          );
        }
        for (const item of items) {
          const row = byId.get(item.sourceId)!;
          const ref = writePrFeedbackArtifact(sessionId, row.session_pr_id, row.source_id, "reply", item.reply);
          recordPrFeedbackDecision(row.id, item.decision, ref);
        }
        const reported = new Set(items.map((i) => i.sourceId));
        const missing = [...byId.keys()].filter((id) => !reported.has(id) && byId.get(id)!.decision === "pending");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  recorded: items.length,
                  ...(missing.length
                    ? {
                        unreported: missing,
                        note: "These items have no decision yet; report them too (unreported items are declined without a reply).",
                      }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

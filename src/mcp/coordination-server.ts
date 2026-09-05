import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readArtifact, writeAmendmentArtifact } from "../artifacts/store";
import { createAmendment, latestSharedContext, listAgents } from "../db";

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

  await server.connect(new StdioServerTransport());
}

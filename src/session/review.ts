import type { TackConfig } from "../config/schema";
import { resolvePersona, resolveModel, modelForPersona } from "../config/load";
import { getAgent, getSession } from "../db";
import { readArtifact } from "../artifacts/store";
import { checkModelOffered } from "../runtimes/availability";
import { prepareAgent } from "../agent/execute";
import { spawnAgentRunner } from "../agent/detached";

export function startPersonaReview(config: TackConfig, sessionId: string, { agentId, persona: name, prompt, model }: { agentId: string; persona: string; prompt?: string; model?: string }) {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const persona = resolvePersona(config, name);
    const target = getAgent(agentId);
    if (!target || target.session_id !== sessionId) throw new Error("Reviewed agent is not in this session.");
    // Manual workspaces are refused too: they have no captured diff until open_pr, and
    // the human's in-progress edits keep moving under a reviewer.
    if (target.kind) throw new Error("Only normal worker agents can be reviewed; review, PR-fix and manual-workspace rows cannot.");
    if (target.status !== "done") throw new Error("Reviewed agent must be done; use wait_for_agents first.");
    if (!readArtifact(target.diff_ref).trim()) throw new Error("Reviewed agent has no diff to review.");
    if (!target.branch || !target.diff_base) throw new Error("Reviewed agent has no local branch/baseline.");
    const project = config.projects.find((p) => p.name === target.project_name);
    if (!project) throw new Error(`Unknown project "${target.project_name}"`);
    const m = model ? resolveModel(config, model) : modelForPersona(config, persona, { avoidKey: target.model });
    const offered = checkModelOffered(config, m);
    if (!offered.ok) throw new Error(`Refusing to review: ${offered.message}`);
    const agent = prepareAgent({ session, project, model: m, kind: "review", persona: name,
      reviewsAgentId: target.id,
      prompt: `Review agent ${target.id}'s work using your persona and the shared contract. Report findings with report_review.` +
        (prompt ? `\n\nExtra focus:\n${prompt}` : ""),
    });
    spawnAgentRunner(session.id, agent.id);
    return { agentId: agent.id, persona: name, model: m.key, reviews: target.id };
}

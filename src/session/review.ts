import { computePreflight } from "../agent/preflight";
import type { TackConfig } from "../config/schema";
import { resolvePersona, resolveModel, modelForPersona } from "../config/load";
import { getAgent, getSession, listSessionPrs } from "../db";
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
    let preflight;
    try { preflight = computePreflight(config, m); } catch { /* runner reports the failure */ }
    spawnAgentRunner(session.id, agent.id, { preflight });
    return { agentId: agent.id, persona: name, model: m.key, reviews: target.id };
}

/** Start one independent review for each open session PR, or only `prId`'s when
 * given (refused unless it is one of those reviewable open PRs). */
export function startRemoteReview(config: TackConfig, sessionId: string, { persona: name, prompt, model, prId }: { persona: string; prompt?: string; model?: string; prId?: string }) {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const persona = resolvePersona(config, name);
    const open = listSessionPrs(sessionId).filter(pr => !pr.merged_at && !["merged", "closed"].includes(pr.state?.toLowerCase() ?? "") && pr.head_branch && pr.project_name);
    const prs = prId ? open.filter(pr => pr.id === prId) : open;
    if (prId && !prs.length) throw new Error(`PR ${prId} is not an open PR of this session; only open PRs can be reviewed.`);
    if (!prs.length) throw new Error("No open PRs to review in this session.");
    const reviews = prs.map(pr => {
      const project = config.projects.find(p => p.name === pr.project_name);
      if (!project) throw new Error(`Unknown project "${pr.project_name}"`);
      const author = pr.agent_id ? getAgent(pr.agent_id) : null;
      const m = model ? resolveModel(config, model) : modelForPersona(config, persona, { avoidKey: author?.model });
      const offered = checkModelOffered(config, m);
      if (!offered.ok) throw new Error(`Refusing to review: ${offered.message}`);
      const agent = prepareAgent({ session, project, model: m, kind: "review", persona: name, sessionPrId: pr.id,
        prompt: `Review PR #${pr.number} (${pr.url}) using your persona and the shared contract. Report findings with report_review.` +
          (prompt ? `\n\nExtra focus:\n${prompt}` : ""),
      });
      let preflight;
      try { preflight = computePreflight(config, m); } catch { /* runner reports the failure */ }
      spawnAgentRunner(session.id, agent.id, { preflight });
      return { agentId: agent.id, prId: pr.id, number: pr.number, url: pr.url, model: m.key };
    });
    return { persona: name, reviews };
}

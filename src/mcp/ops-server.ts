import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import { loadConfig, modelForRole } from '../config/load';
import { agentCostBySession, countOpenPrFeedbackByPr, getAgent, getSession, latestSharedContext, listAgentsBySession, listPendingAmendmentsBySession, listPrDependencies, listSessionJiraTicketsBySession, listSessionPrsBySession, listSessions } from '../db';
import { sessionLive, sessionWorking, sessionNeedsInput } from '../cli/liveness';
import { agentArtifactPath, readArtifact } from '../artifacts/store';
import { claudeReportTranscriptPath, extractReportTranscript, readReportFile, reportExcerpt } from '../session/bug-report';
import { tmuxCapturePane } from '../session/tmux';
import { readPastSession, searchPastSessions, sessionSummaryText } from '../session/summary';
import { LOGS_DIR } from '../paths';
import { archiveSession, deleteSession, holdSession, stopSession, unarchiveSession, unholdSession } from '../session/lifecycle';
import { restartSession, parkRestartedSupervisor } from '../session/restart';
import { startRemoteReview } from '../session/review';
import { setPrFix } from '../session/pr-fix';
import { triggerPrWatch } from '../prwatch/watch';
import { createSupervisorSession, superviseInteractive, writeSupervisorPrompt } from '../supervisor/supervise';
import { spawnSessionTitler } from '../session/title';

export const OPS_MCP_NAME = 'tack-ops';
export const OPS_APPROVAL_TOOLS = ['archive_session', 'stop_session', 'restart_session', 'delete_session'].map(name => `mcp__${OPS_MCP_NAME}__${name}`);
const result = (value: unknown) => { const json = JSON.stringify(value ?? null); const excerpt = reportExcerpt(json, 100000); return { content: [{ type: 'text' as const, text: excerpt === json ? json : JSON.stringify(excerpt) }] }; };
const sid = z.string().min(1);
const tail = z.number().int().min(100).max(50000).optional();

function views(includeArchived = false) {
  const sessions = listSessions(includeArchived), ids = sessions.map(s => s.id);
  const agents = listAgentsBySession(ids), prs = listSessionPrsBySession(ids), tickets = listSessionJiraTicketsBySession(ids), amendments = listPendingAmendmentsBySession(ids), costs = agentCostBySession(ids), feedback = countOpenPrFeedbackByPr(ids);
  return sessions.map(s => {
    const aa = agents.get(s.id) ?? [], pp = prs.get(s.id) ?? [];
    const counts = (values: string[]) => values.reduce<Record<string, number>>((a, v) => { a[v] = (a[v] ?? 0) + 1; return a; }, {});
    const base = { id: s.id, title: s.title, status: s.status, created_at: s.created_at, updated_at: s.updated_at, live: sessionLive(s), working: sessionWorking(s), needsInput: sessionNeedsInput(s, aa), awaiting_reason: s.awaiting_reason, cost: (s.cost ?? 0) + (costs.get(s.id) ?? 0), agentCounts: counts(aa.map(a => a.status)), prCounts: counts(pp.map(p => p.state ?? 'unknown')), jiraKeys: (tickets.get(s.id) ?? []).map(t => t.key) };
    return { session: s, base, agents: aa, prs: pp.map(p => ({ ...p, watch: { openFeedback: feedback.get(p.id) ?? 0, fixing: aa.some(a => a.kind === 'pr_fix' && a.session_pr_id === p.id && (a.status === 'pending' || a.status === 'running' || (a.status === 'done' && !a.post_fixed_at))), dependency: listPrDependencies(s.id).find(d => d.downstream_pr_id === p.id && ['waiting_merge', 'waiting_release', 'bump_queued'].includes(d.status))?.package } })), tickets: tickets.get(s.id) ?? [], amendments: amendments.get(s.id) ?? [] };
  });
}
export async function runOpsServer(): Promise<void> {
  const server = new McpServer({ name: OPS_MCP_NAME, version: '1.0.0' });
  const requireView = (id: string) => { const v = views(true).find(v => v.session.id === id); if (!v) throw new Error(`Unknown session ${id}`); return v; };
  server.registerTool('list_sessions', { description: 'List Tack sessions.', inputSchema: { includeArchived: z.boolean().optional(), status: z.string().optional(), query: z.string().optional(), since: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }, annotations: { readOnlyHint: true } }, async ({ includeArchived, status, query, since, limit }) => result(views(includeArchived).filter(v => (!status || v.base.status === status) && (!query || (v.base.title ?? '').toLowerCase().includes(query.toLowerCase())) && (!since || v.base.updated_at >= since)).slice(0, limit ?? 100).map(v => v.base)));
  server.registerTool('show_session', { description: 'Inspect a session.', inputSchema: { sessionId: sid }, annotations: { readOnlyHint: true } }, async ({ sessionId }) => { const v = requireView(sessionId); return result({ ...v.base, prompt: reportExcerpt(readReportFile(join(LOGS_DIR, sessionId, 'supervisor.prompt')), 12000), summary: reportExcerpt(sessionSummaryText(v.session), 12000), contract: reportExcerpt(readArtifact(latestSharedContext(sessionId)?.body_ref), 12000), agents: v.agents, prs: v.prs, tickets: v.tickets, amendments: v.amendments }); });
  server.registerTool('read_session_conversation', { description: 'Read the supervisor conversation.', inputSchema: { sessionId: sid, tailChars: tail }, annotations: { readOnlyHint: true } }, async ({ sessionId, tailChars }) => { const s = requireView(sessionId).session, path = claudeReportTranscriptPath(s), transcript = path ? readReportFile(path, true) : ''; return result({ source: transcript ? 'transcript' : 'pane', text: reportExcerpt(transcript ? extractReportTranscript(transcript) : tmuxCapturePane(sessionId), tailChars ?? 12000, true) }); });
  server.registerTool('read_agent_output', { description: 'Read an agent artifact.', inputSchema: { sessionId: sid, agentId: sid, kind: z.enum(['output','diff','prompt','transcript','review']), tailChars: tail }, annotations: { readOnlyHint: true } }, async ({ sessionId, agentId, kind, tailChars }) => { requireView(sessionId); const a = getAgent(agentId); if (!a || a.session_id !== sessionId) throw new Error('Agent does not belong to session'); const ref = kind === 'transcript' ? null : a[`${kind}_ref`]; return result(reportExcerpt((ref ? readReportFile(ref, true) : '') || readReportFile(agentArtifactPath(sessionId, agentId, kind), true), tailChars ?? 12000, true)); });
  server.registerTool('search_sessions', { description: 'Search session history.', inputSchema: { query: z.string().optional(), project: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }, annotations: { readOnlyHint: true } }, async args => result(searchPastSessions(args)));
  server.registerTool('read_session_history', { description: 'Read session history.', inputSchema: { sessionId: sid }, annotations: { readOnlyHint: true } }, async ({ sessionId }) => result(readPastSession(sessionId)));
  server.registerTool('recent_activity', { description: 'Recent and in-flight work.', inputSchema: { since: z.string() }, annotations: { readOnlyHint: true } }, async ({ since }) => { const all = views(true); const agent = (a: typeof all[number]['agents'][number]) => ({ id: a.id, session_id: a.session_id, project: a.project_name, status: a.status, finished_at: a.finished_at }); return result({ sessions: all.filter(v => v.session.created_at >= since || (v.session.status === 'archived' && v.session.updated_at >= since)).map(v => v.base), agents: all.flatMap(v => v.agents.filter(a => a.finished_at && a.finished_at >= since).map(agent)), prs: all.flatMap(v => v.prs.filter(p => p.created_at >= since || (p.merged_at && p.merged_at >= since)).map(p => ({ id: p.id, session_id: p.session_id, url: p.url, state: p.state, created_at: p.created_at, merged_at: p.merged_at }))), inFlight: { sessions: all.filter(v => v.base.live || v.base.working).map(v => v.base), agents: all.flatMap(v => v.agents.filter(a => a.status === 'running').map(agent)) } }); });
  server.registerTool('list_personas', { description: 'List reviewer personas.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => result((await loadConfig()).personas));
  server.registerTool('create_session', { description: 'Create and park a session for human plan approval.', inputSchema: { problem: sid } }, async ({ problem }) => { const config = await loadConfig(); const model = modelForRole(config, 'supervisor'); if (model.runtime !== 'claude') throw new Error('Session creation requires a supervisor runtime that supports human plan approval.'); const session = createSupervisorSession(problem, config, model); writeSupervisorPrompt(session.id, problem); spawnSessionTitler(session.id); const r = await superviseInteractive({ session, prompt: problem, resume: false, config, park: true }); return result({ id: session.id, parked: r.detached }); });
  server.registerTool('hold_session', { description: 'Hold a session.', inputSchema: { sessionId: sid } }, async ({ sessionId }) => { holdSession(sessionId); return result('ok'); });
  server.registerTool('unhold_session', { description: 'Unhold a session.', inputSchema: { sessionId: sid } }, async ({ sessionId }) => { await unholdSession(sessionId, await loadConfig()); return result('ok'); });
  server.registerTool('unarchive_session', { description: 'Unarchive a session.', inputSchema: { sessionId: sid } }, async ({ sessionId }) => result(unarchiveSession(sessionId)));
  server.registerTool('start_review', { description: 'Start a requested review.', inputSchema: { sessionId: sid, persona: sid, prompt: z.string().optional(), prId: z.string().optional() } }, async ({ sessionId, persona, prompt, prId }) => result(startRemoteReview(await loadConfig(), sessionId, { persona, prompt, prId })));
  server.registerTool('set_pr_fix', { description: 'Set automatic PR fixes.', inputSchema: { sessionId: sid, enabled: z.boolean(), prId: z.string().optional() } }, async ({ sessionId, enabled, prId }) => { await setPrFix(sessionId, enabled, await loadConfig(), { prId }); return result('ok'); });
  server.registerTool('poll_prs', { description: 'Poll PRs.', inputSchema: { sessionId: sid, prId: z.string().optional() } }, async ({ sessionId, prId }) => result(await triggerPrWatch(sessionId, await loadConfig(), undefined, { prId })));
  const requireApprovalSupport = () => { if (process.env.TACK_OPS_GATED_DISABLED === '1') throw new Error('This runtime cannot enforce per-call approval for this action.'); };
  server.registerTool('archive_session', { description: 'Archive a session.', inputSchema: { sessionId: sid } }, async ({ sessionId }) => { requireApprovalSupport(); archiveSession(sessionId); return result('ok'); });
  server.registerTool('stop_session', { description: 'Stop a session.', inputSchema: { sessionId: sid } }, async ({ sessionId }) => { requireApprovalSupport(); stopSession(sessionId); return result('ok'); });
  server.registerTool('restart_session', { description: 'Restart a session.', inputSchema: { sessionId: sid } }, async ({ sessionId }) => { requireApprovalSupport(); const config = await loadConfig(), restart = await restartSession(sessionId, config), parked = await parkRestartedSupervisor(sessionId, config); return result({ restart, parked }); });
  server.registerTool('delete_session', { description: 'Delete a session.', inputSchema: { sessionId: sid } }, async ({ sessionId }) => { requireApprovalSupport(); deleteSession(sessionId); return result('ok'); });
  await server.connect(new StdioServerTransport());
}

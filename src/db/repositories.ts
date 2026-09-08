import { getDb } from "./connection";
import { nowIso, shortId } from "../util/id";
import type { RuntimeKind } from "../config/schema";

// ---------------------------------------------------------------------------
// Row types (mirror the schema in migrate.ts). Text refs are filesystem paths.
// ---------------------------------------------------------------------------

export type SessionStatus = "active" | "archived";
export type AgentStatus = "pending" | "running" | "done" | "failed" | "stopped";
export type CostSource = "runtime" | "pricing";

export interface SessionRow {
  id: string;
  title: string | null;
  supervisor_model: string | null;
  runtime: RuntimeKind | null;
  resume_ref: string | null;
  status: SessionStatus;
  cost: number;
  pid: number | null;
  heartbeat_at: string | null;
  /** When the human approved this session's plan (gates `spawn_agent`); null = not
   * yet approved. Background sessions are stamped up front — no human in the loop. */
  plan_approved_at: string | null;
  /** Ephemeral "supervisor is blocked on a human decision" toggle (e.g. a plan
   * presented via ExitPlanMode). Set when it blocks, cleared when it proceeds, so it
   * re-arms every iteration. null = not currently waiting. See `awaiting_reason`. */
  awaiting_input_at: string | null;
  /** Why the supervisor is waiting (e.g. "plan"), when `awaiting_input_at` is set. */
  awaiting_reason: string | null;
  /** When the human last looked at this session (`tack stable` selection, attach,
   * resume). Compared against agents' `finished_at` to find unread completed work. */
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  session_id: string;
  project_name: string;
  worktree_path: string | null;
  branch: string | null;
  status: AgentStatus;
  model: string | null;
  runtime: RuntimeKind | null;
  resume_ref: string | null;
  cost: number;
  cost_source: CostSource | null;
  tokens_input: number;
  tokens_output: number;
  cache_read: number;
  cache_write: number;
  pid: number | null;
  prompt_ref: string | null;
  output_ref: string | null;
  diff_ref: string | null;
  /** When the agent reached a terminal state (done/failed/stopped); null while it's
   * pending/running. Backs the "unread completed work" check against a session's
   * `last_seen_at`. */
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SharedContextRow {
  session_id: string;
  version: number;
  body_ref: string;
  authored_by: string;
  created_at: string;
}

export interface AmendmentRow {
  id: string;
  session_id: string;
  proposed_by: string;
  proposal_ref: string;
  status: "pending" | "accepted" | "rejected";
  resolution_ref: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface SessionPrRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  project_name: string | null;
  number: number | null;
  url: string;
  title: string | null;
  state: string | null;
  head_branch: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(input: {
  title?: string | null;
  supervisorModel?: string | null;
  runtime?: RuntimeKind | null;
}): SessionRow {
  const db = getDb();
  const now = nowIso();
  const id = shortId("ses");
  db.prepare(
    `INSERT INTO sessions (id, title, supervisor_model, runtime, status, cost, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 0, ?, ?)`,
  ).run(id, input.title ?? null, input.supervisorModel ?? null, input.runtime ?? null, now, now);
  return getSession(id)!;
}

export function getSession(id: string): SessionRow | null {
  return (getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow) ?? null;
}

export function listSessions(includeArchived = false): SessionRow[] {
  const sql = includeArchived
    ? `SELECT * FROM sessions ORDER BY created_at DESC`
    : `SELECT * FROM sessions WHERE status = 'active' ORDER BY created_at DESC`;
  return getDb().prepare(sql).all() as SessionRow[];
}

export function setSessionStatus(id: string, status: SessionStatus): void {
  getDb()
    .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, nowIso(), id);
}

export function setSessionResumeRef(id: string, ref: string): void {
  getDb()
    .prepare(`UPDATE sessions SET resume_ref = ?, updated_at = ? WHERE id = ?`)
    .run(ref, nowIso(), id);
}

/** Adds to the supervisor-conversation cost (per-turn increment). */
export function addSessionCost(id: string, delta: number): void {
  getDb()
    .prepare(`UPDATE sessions SET cost = cost + ?, updated_at = ? WHERE id = ?`)
    .run(delta, nowIso(), id);
}

/** Sets the supervisor-conversation cost outright (for a cumulative cost figure). */
export function setSessionCost(id: string, usd: number): void {
  getDb().prepare(`UPDATE sessions SET cost = ?, updated_at = ? WHERE id = ?`).run(usd, nowIso(), id);
}

/**
 * Marks a session's plan as approved (idempotent — the first approval time wins),
 * opening the `spawn_agent` gate. Called by the interactive supervisor's
 * ExitPlanMode hook when the human accepts the plan, and up front for background
 * sessions (which have no human to approve). */
export function approveSessionPlan(id: string): void {
  // Approval always means the human resolved the plan decision, so clear the
  // ephemeral awaiting flag in the same write (the plan gate itself stays latched).
  getDb()
    .prepare(
      `UPDATE sessions
         SET plan_approved_at = COALESCE(plan_approved_at, ?),
             awaiting_input_at = NULL, awaiting_reason = NULL,
             updated_at = ?
       WHERE id = ?`,
    )
    .run(nowIso(), nowIso(), id);
}

/** Marks the supervisor as blocked on a human decision (ephemeral — cleared by
 * `clearSessionAwaitingInput`/`approveSessionPlan` when it proceeds). Unlike
 * `plan_approved_at`, this re-arms on every plan iteration. */
export function setSessionAwaitingInput(id: string, reason: string): void {
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE sessions SET awaiting_input_at = ?, awaiting_reason = ?, updated_at = ? WHERE id = ?`,
    )
    .run(now, reason, now, id);
}

/** Clears the "waiting on a human" flag once the supervisor proceeds. */
export function clearSessionAwaitingInput(id: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET awaiting_input_at = NULL, awaiting_reason = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(nowIso(), id);
}

/** Records that the human just looked at this session, clearing "unread completed
 * work" (completed agents from before this moment count as seen). */
export function stampSessionSeen(id: string): void {
  getDb()
    .prepare(`UPDATE sessions SET last_seen_at = ?, updated_at = ? WHERE id = ?`)
    .run(nowIso(), nowIso(), id);
}

export function stampSessionHeartbeat(id: string, pid: number): void {
  getDb()
    .prepare(`UPDATE sessions SET pid = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?`)
    .run(pid, nowIso(), nowIso(), id);
}

export function deleteSession(id: string): void {
  // agents/context/amendments/prs cascade via FK.
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

/** Total cost of a session: supervisor conversation + all its agents. Derived on
 * read so background agents stay authoritative for their own spend. */
export function sessionTotalCost(id: string): { supervisor: number; agents: number; total: number } {
  const db = getDb();
  const s = (db.prepare(`SELECT cost FROM sessions WHERE id = ?`).get(id) as { cost: number } | null)?.cost ?? 0;
  const a =
    (db.prepare(`SELECT COALESCE(SUM(cost), 0) AS c FROM agents WHERE session_id = ?`).get(id) as {
      c: number;
    }).c ?? 0;
  return { supervisor: s, agents: a, total: s + a };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function createAgent(input: {
  sessionId: string;
  projectName: string;
  model?: string | null;
  runtime?: RuntimeKind | null;
  promptRef?: string | null;
}): AgentRow {
  const db = getDb();
  const now = nowIso();
  const id = shortId("agt");
  db.prepare(
    `INSERT INTO agents (id, session_id, project_name, status, model, runtime, prompt_ref, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    input.projectName,
    input.model ?? null,
    input.runtime ?? null,
    input.promptRef ?? null,
    now,
    now,
  );
  return getAgent(id)!;
}

export function getAgent(id: string): AgentRow | null {
  return (getDb().prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow) ?? null;
}

export function listAgents(sessionId: string): AgentRow[] {
  return getDb()
    .prepare(`SELECT * FROM agents WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as AgentRow[];
}

const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set(["done", "failed", "stopped"]);

export function setAgentStatus(id: string, status: AgentStatus): void {
  const now = nowIso();
  // Stamp finish time on the transition into a terminal state; clear it if the agent
  // goes back to pending/running (a resume), so `finished_at` always reflects the
  // current status.
  const finishedAt = TERMINAL_AGENT_STATUSES.has(status) ? now : null;
  getDb()
    .prepare(`UPDATE agents SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
    .run(status, finishedAt, now, id);
}

export function setAgentWorktree(id: string, worktreePath: string, branch: string): void {
  getDb()
    .prepare(`UPDATE agents SET worktree_path = ?, branch = ?, updated_at = ? WHERE id = ?`)
    .run(worktreePath, branch, nowIso(), id);
}

export function setAgentPid(id: string, pid: number): void {
  getDb().prepare(`UPDATE agents SET pid = ?, updated_at = ? WHERE id = ?`).run(pid, nowIso(), id);
}

export function setAgentResumeRef(id: string, ref: string): void {
  getDb().prepare(`UPDATE agents SET resume_ref = ?, updated_at = ? WHERE id = ?`).run(ref, nowIso(), id);
}

export function setAgentUsage(
  id: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  getDb()
    .prepare(
      `UPDATE agents SET tokens_input = ?, tokens_output = ?, cache_read = ?, cache_write = ?, updated_at = ? WHERE id = ?`,
    )
    .run(usage.input, usage.output, usage.cacheRead, usage.cacheWrite, nowIso(), id);
}

export function setAgentCost(id: string, usd: number, source: CostSource): void {
  getDb()
    .prepare(`UPDATE agents SET cost = ?, cost_source = ?, updated_at = ? WHERE id = ?`)
    .run(usd, source, nowIso(), id);
}

export function setAgentRefs(
  id: string,
  refs: { outputRef?: string | null; diffRef?: string | null },
): void {
  const cur = getAgent(id);
  if (!cur) return;
  getDb()
    .prepare(`UPDATE agents SET output_ref = ?, diff_ref = ?, updated_at = ? WHERE id = ?`)
    .run(refs.outputRef ?? cur.output_ref, refs.diffRef ?? cur.diff_ref, nowIso(), id);
}

// ---------------------------------------------------------------------------
// Shared context (versioned contract, body on disk)
// ---------------------------------------------------------------------------

export function addSharedContext(input: {
  sessionId: string;
  bodyRef: string;
  authoredBy: string;
}): SharedContextRow {
  const db = getDb();
  const next =
    ((db.prepare(`SELECT MAX(version) AS v FROM shared_context WHERE session_id = ?`).get(input.sessionId) as {
      v: number | null;
    }).v ?? 0) + 1;
  db.prepare(
    `INSERT INTO shared_context (session_id, version, body_ref, authored_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.sessionId, next, input.bodyRef, input.authoredBy, nowIso());
  return latestSharedContext(input.sessionId)!;
}

export function latestSharedContext(sessionId: string): SharedContextRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM shared_context WHERE session_id = ? ORDER BY version DESC LIMIT 1`)
      .get(sessionId) as SharedContextRow) ?? null
  );
}

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

export function createAmendment(input: {
  sessionId: string;
  proposedBy: string;
  proposalRef: string;
}): AmendmentRow {
  const db = getDb();
  const id = shortId("amd");
  db.prepare(
    `INSERT INTO amendments (id, session_id, proposed_by, proposal_ref, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(id, input.sessionId, input.proposedBy, input.proposalRef, nowIso());
  return getDb().prepare(`SELECT * FROM amendments WHERE id = ?`).get(id) as AmendmentRow;
}

export function listPendingAmendments(sessionId: string): AmendmentRow[] {
  return getDb()
    .prepare(`SELECT * FROM amendments WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC`)
    .all(sessionId) as AmendmentRow[];
}

export function resolveAmendment(
  id: string,
  status: "accepted" | "rejected",
  resolutionRef: string | null,
): void {
  getDb()
    .prepare(`UPDATE amendments SET status = ?, resolution_ref = ?, resolved_at = ? WHERE id = ?`)
    .run(status, resolutionRef, nowIso(), id);
}

// ---------------------------------------------------------------------------
// Session PRs
// ---------------------------------------------------------------------------

export function upsertSessionPr(input: {
  sessionId: string;
  url: string;
  agentId?: string | null;
  projectName?: string | null;
  number?: number | null;
  title?: string | null;
  state?: string | null;
  headBranch?: string | null;
}): void {
  const db = getDb();
  const now = nowIso();
  const existing = db
    .prepare(`SELECT id FROM session_prs WHERE session_id = ? AND url = ?`)
    .get(input.sessionId, input.url) as { id: string } | null;
  if (existing) {
    db.prepare(
      `UPDATE session_prs SET agent_id = ?, project_name = ?, number = ?, title = ?, state = ?, head_branch = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.agentId ?? null,
      input.projectName ?? null,
      input.number ?? null,
      input.title ?? null,
      input.state ?? null,
      input.headBranch ?? null,
      now,
      existing.id,
    );
    return;
  }
  db.prepare(
    `INSERT INTO session_prs (id, session_id, agent_id, project_name, number, url, title, state, head_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    shortId("pr"),
    input.sessionId,
    input.agentId ?? null,
    input.projectName ?? null,
    input.number ?? null,
    input.url,
    input.title ?? null,
    input.state ?? null,
    input.headBranch ?? null,
    now,
    now,
  );
}

export function listSessionPrs(sessionId: string): SessionPrRow[] {
  return getDb()
    .prepare(`SELECT * FROM session_prs WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as SessionPrRow[];
}

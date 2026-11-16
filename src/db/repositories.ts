import type { Database } from "bun:sqlite";
import { getDb } from "./connection";
import { nowIso, shortId } from "../util/id";
import type { RuntimeKind } from "../config/schema";

// ---------------------------------------------------------------------------
// Row types (mirror the schema in migrate.ts). Text refs are filesystem paths.
// ---------------------------------------------------------------------------

export type SessionStatus = "active" | "archived";
export type AgentStatus = "pending" | "running" | "done" | "failed" | "stopped";
export type CostSource = "runtime" | "pricing";
/** NULL = a normal worker; PR-fix agents update an open PR, while review agents
 * inspect another worker through a configured persona and only report findings.
 * `manual` is a human's hand-edited workspace: a worker-shaped row (own worktree,
 * PR-able) that has no runtime conversation and must never be executed. */
export type AgentKind = "pr_fix" | "review" | "manual";
export type AgentFixOutcome = "pushed" | "no_changes" | "push_rejected" | "not_pushed" | "stopped" | "failed";
/** GitHub's mergeability verdict for a PR. UNKNOWN = not computed yet (retry later). */
export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type PrFeedbackKind = "review_thread" | "review" | "issue_comment" | "ci_check";
export type PrFeedbackDecision = "pending" | "fixed" | "declined" | "not_applicable" | "failed";

export interface SessionRow {
  id: string;
  title: string | null;
  supervisor_model: string | null;
  runtime: RuntimeKind | null;
  resume_ref: string | null;
  status: SessionStatus;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  cache_read: number;
  cache_write: number;
  pid: number | null;
  heartbeat_at: string | null;
  /** When the human approved this session's plan (gates `spawn_agent`); null = not
   * yet approved. Background sessions are stamped up front — no human in the loop. */
  plan_approved_at: string | null;
  /** Ephemeral "supervisor is blocked on a human decision" toggle (e.g. a plan
   * presented via `request_plan_approval`). Set when it blocks, cleared when it proceeds, so it
   * re-arms every iteration. null = not currently waiting. See `awaiting_reason`. */
  awaiting_input_at: string | null;
  /** Why the supervisor is waiting (e.g. "plan"), when `awaiting_input_at` is set. */
  awaiting_reason: string | null;
  /** When the human last looked at this session (`tack dashboard` selection, attach,
   * resume). Compared against agents' `finished_at` to find unread completed work. */
  last_seen_at: string | null;
  /** The session's PR-watch process (src/prwatch/watch.ts); null when none started. */
  pr_watch_pid: number | null;
  pr_fix_enabled: number;
  supervisor_config_version: string | null;
  pr_watch_config_version: string | null;
  supervisor_code_version: string | null;
  pr_watch_code_version: string | null;
  supervisor_turn_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  continues_agent_id: string | null;
  continuation_prompt_ref: string | null;
  continuation_started_at: string | null;
  diff_base: string | null;
  id: string;
  session_id: string;
  project_name: string;
  worktree_path: string | null;
  branch: string | null;
  status: AgentStatus;
  model: string | null;
  runtime: RuntimeKind | null;
  resume_ref: string | null;
  /** Work interrupted by archive, awaiting restoration. */
  interrupted_at: string | null;
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
  /** Short human label for what the agent is doing right now (its last tool call),
   * surfaced live in the dashboard; null until the first tool call. */
  activity: string | null;
  /** When `activity` was last stamped (ISO-UTC), for the dashboard's "… Ns ago". */
  activity_at: string | null;
  /** Last error message when the agent failed, shown inline in the dashboard so a
   * failure is legible without opening the output file; null when it didn't fail. */
  error: string | null;
  /** How many times the runner has restarted this agent after a transient failure
   * (0 = first run). */
  attempt: number;
  /** JSON array of files/globs the supervisor declared this agent will modify, for
   * pre-dispatch overlap detection; null when undeclared. See `agentTouches`. */
  touches: string | null;
  /** JSON array of sibling agent ids that must reach a terminal state before this
   * agent starts; the runner self-gates on them. Null when undeclared. */
  depends_on: string | null;
  /** NULL for a worker; PR-fix agents ship fixes, review agents only report,
   * manual rows are human workspaces. */
  kind: AgentKind | null;
  persona: string | null;
  reviews_agent_id: string | null;
  review_ref: string | null;
  /** For a `pr_fix` agent, the `session_prs.id` it is fixing. */
  session_pr_id: string | null;
  /** When the PR watcher finished this fix agent's post-fix step (push + replies) —
   * the idempotency latch that keeps it from ever re-pushing or double-posting. */
  post_fixed_at: string | null;
  /** Watcher result, independent of runtime status; NULL until post-fix or for legacy rows. */
  fix_outcome: AgentFixOutcome | null;
  /** Full commit SHA successfully pushed to the PR, otherwise NULL. */
  fix_pushed_sha: string | null;
  /** PR fix initiator; legacy NULL origins count as automatic for the daily cap. */
  fix_origin: "auto" | "supervisor" | null;
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
  /** First automatic promotion; never cleared when a human returns it to draft. */
  ready_promoted_at: string | null;
  merged_at: string | null;
  id: string;
  session_id: string;
  agent_id: string | null;
  project_name: string | null;
  number: number | null;
  url: string;
  title: string | null;
  state: string | null;
  head_branch: string | null;
  /** GitHub's last-polled mergeability (see `PrMergeable`); null before the first poll. */
  mergeable: PrMergeable | null;
  /** The PR's base branch, which a merge conflict is resolved against. */
  base_branch: string | null;
  /** The PR head commit as of the last poll. */
  head_sha: string | null;
  /** When the PR watcher last polled this PR successfully. */
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One GitHub comment Tack has ingested as PR-watch input (bodies live on disk). */
export interface PrFeedbackRow {
  id: string;
  session_pr_id: string;
  source_id: string;
  source_kind: PrFeedbackKind;
  author: string | null;
  /** 1 when the author is a bot/app account. Bots are still feedback; this only
   * stops Tack's reply from @-mentioning (and so re-summoning) them. */
  author_is_bot: number;
  url: string | null;
  path: string | null;
  line: number | null;
  /** For a review-thread comment, the thread's root comment id (the replies target). */
  in_reply_to: string | null;
  body_ref: string | null;
  fix_agent_id: string | null;
  decision: PrFeedbackDecision;
  reply_ref: string | null;
  reply_url: string | null;
  created_at: string;
  handled_at: string | null;
}

/** A JIRA ticket a session is tracking (see migration v5). Track-only: everything
 * but `key` is a cached, best-effort mirror of Jira refreshed via the Atlassian MCP
 * server, so any of it may be null until the first successful refresh. */
export interface SessionJiraTicketRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  key: string;
  url: string | null;
  title: string | null;
  status: string | null;
  /** Jira's stable status bucket: new | indeterminate | done (null = unknown). */
  status_category: string | null;
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

export function setSessionPrFixEnabled(id: string, enabled: boolean): void {
  getDb().prepare(`UPDATE sessions SET pr_fix_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export function setSessionStatus(id: string, status: SessionStatus): void {
  getDb()
    .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, nowIso(), id);
}

/** Replaces the session's display title (set by the auto-titler, `src/session/title.ts`). */
export function setSessionTitle(id: string, title: string): void {
  getDb().prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(title, nowIso(), id);
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

/** Overwrite usage, matching setSessionCost's latest-figure semantics. */
export function setSessionUsage(
  id: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  getDb()
    .prepare(
      `UPDATE sessions SET tokens_input = ?, tokens_output = ?, cache_read = ?, cache_write = ?, updated_at = ? WHERE id = ?`,
    )
    .run(usage.input, usage.output, usage.cacheRead, usage.cacheWrite, nowIso(), id);
}

/**
 * Marks a session's plan as approved (idempotent — the first approval time wins),
 * opening the `spawn_agent` gate. Called by the `request_plan_approval` tool's
 * handler after the human accepts the elicitation, the human-run
 * `tack session approve` escape hatch, and up front
 * for background and codex sessions. */
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
  // agents/context/amendments/prs/jira tickets cascade via FK.
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
  /** Declared files/globs this agent will touch (for overlap detection). */
  touches?: string[] | null;
  /** Sibling agent ids that must finish before this agent starts. */
  dependsOn?: string[] | null;
  /** Reviewers report findings; PR-fix agents update an existing PR. NULL is a worker. */
  kind?: AgentKind | null;
  persona?: string | null;
  reviewsAgentId?: string | null;
  /** The session PR a `pr_fix` agent is fixing. */
  sessionPrId?: string | null;
  /** PR fix initiator; supervisor-requested runs are exempt from the daily cap. */
  fixOrigin?: "auto" | "supervisor" | null;
}): AgentRow {
  const db = getDb();
  const now = nowIso();
  const id = shortId("agt");
  db.prepare(
    `INSERT INTO agents (id, session_id, project_name, status, model, runtime, prompt_ref, touches, depends_on, kind, persona, reviews_agent_id, session_pr_id, fix_origin, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    input.projectName,
    input.model ?? null,
    input.runtime ?? null,
    input.promptRef ?? null,
    input.touches && input.touches.length ? JSON.stringify(input.touches) : null,
    input.dependsOn && input.dependsOn.length ? JSON.stringify(input.dependsOn) : null,
    input.kind ?? null,
    input.persona ?? null,
    input.reviewsAgentId ?? null,
    input.sessionPrId ?? null,
    input.fixOrigin ?? null,
    now,
    now,
  );
  return getAgent(id)!;
}

/**
 * Records a human's manual workspace whose worktree already exists. Inserted in one
 * statement as already-`done` (there is nothing to run) with no runtime/model/cost,
 * so every runner/resume path sees a finished row with no conversation. `finished_at`
 * stays NULL on purpose: the human made it, so it must never read as unread agent
 * work (`sessionNeedsInput`). `diff_base` pins the fork point like a worker's.
 */
export function createManualAgent(input: {
  id: string;
  sessionId: string;
  projectName: string;
  worktreePath: string;
  branch: string;
  diffBase: string;
}): AgentRow {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO agents (id, session_id, project_name, status, kind, worktree_path, branch, diff_base, created_at, updated_at)
       VALUES (?, ?, ?, 'done', 'manual', ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.sessionId, input.projectName, input.worktreePath, input.branch, input.diffBase, now, now);
  return getAgent(input.id)!;
}

/** Parses an agent's declared touch-set (JSON array), empty when undeclared. */
export function agentTouches(a: AgentRow): string[] {
  return parseJsonArray(a.touches);
}

/** Parses an agent's declared dependencies (JSON array), empty when undeclared. */
export function agentDependsOn(a: AgentRow): string[] {
  return parseJsonArray(a.depends_on);
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function getAgent(id: string): AgentRow | null {
  return (getDb().prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow) ?? null;
}

export function listAgents(sessionId: string): AgentRow[] {
  return getDb()
    .prepare(`SELECT * FROM agents WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as AgentRow[];
}

/** Only archive marks interrupted work; ordinary stops must stay stopped. Manual
 * workspaces are never runnable, so unarchive must never try to resume one. */
export function markAgentInterrupted(id: string): void {
  const now = nowIso();
  getDb().prepare(`UPDATE agents SET interrupted_at = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'pending') AND kind IS NOT 'manual'`).run(now, now, id);
}

export function clearAgentInterrupted(id: string): void {
  getDb().prepare(`UPDATE agents SET interrupted_at = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), id);
}

export function listInterruptedAgents(sessionId: string): AgentRow[] {
  return getDb()
    .prepare(`SELECT * FROM agents WHERE session_id = ? AND interrupted_at IS NOT NULL AND kind IS NOT 'manual' ORDER BY created_at ASC`)
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

/** The structured review lives in an artifact, separate from normal agent output. */
export function setAgentReviewRef(id: string, ref: string): void {
  getDb().prepare(`UPDATE agents SET review_ref = ?, updated_at = ? WHERE id = ?`).run(ref, nowIso(), id);
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
    .run(refs.outputRef === undefined ? cur.output_ref : refs.outputRef, refs.diffRef === undefined ? cur.diff_ref : refs.diffRef, nowIso(), id);
}

/** Records what the agent is doing right now (its latest tool call), for the live
 * dashboard. Stamps `activity_at` so the dashboard can show how stale it is. */
export function setAgentActivity(id: string, activity: string): void {
  const now = nowIso();
  getDb()
    .prepare(`UPDATE agents SET activity = ?, activity_at = ?, updated_at = ? WHERE id = ?`)
    .run(activity.slice(0, 200), now, now, id);
}

/** Records (or clears) the agent's last error message, shown inline on failure. */
export function setAgentError(id: string, message: string | null): void {
  getDb()
    .prepare(`UPDATE agents SET error = ?, updated_at = ? WHERE id = ?`)
    .run(message ? message.slice(0, 500) : null, nowIso(), id);
}

/** Bumps the retry counter and clears the previous error, as the runner restarts a
 * transiently-failed agent. Returns the new attempt number. */
export function bumpAgentAttempt(id: string): number {
  const now = nowIso();
  getDb()
    .prepare(`UPDATE agents SET attempt = attempt + 1, error = NULL, updated_at = ? WHERE id = ?`)
    .run(now, id);
  return getAgent(id)?.attempt ?? 0;
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

/** Every version of a session's shared contract, oldest first (for `session context`). */
export function listSharedContext(sessionId: string): SharedContextRow[] {
  return getDb()
    .prepare(`SELECT * FROM shared_context WHERE session_id = ? ORDER BY version ASC`)
    .all(sessionId) as SharedContextRow[];
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
  mergedAt?: string | null;
  /** Omitted/null keeps any previously-fetched value (see COALESCE below). */
  mergeable?: PrMergeable | null;
}): void {
  const db = getDb();
  const now = nowIso();
  const existing = db
    .prepare(`SELECT id FROM session_prs WHERE session_id = ? AND url = ?`)
    .get(input.sessionId, input.url) as { id: string } | null;
  if (existing) {
    db.prepare(
      // `agent_id` is COALESCEd, not overwritten: the first writer (open_pr, which
      // knows the real producing agent) wins. The dashboard's discovery refresh only
      // has a best-effort guess and must never clobber the true link. `mergeable` is
      // COALESCEd too, so callers that don't know it (e.g. `open_pr`, right after
      // `gh pr create`) never wipe a value a poll already fetched.
      `UPDATE session_prs SET agent_id = COALESCE(agent_id, ?), project_name = ?, number = ?, title = ?, state = ?, head_branch = ?,
         mergeable = COALESCE(?, mergeable), merged_at = COALESCE(?, merged_at), updated_at = ?
       WHERE id = ?`,
    ).run(
      input.agentId ?? null,
      input.projectName ?? null,
      input.number ?? null,
      input.title ?? null,
      input.state ?? null,
      input.headBranch ?? null,
      input.mergeable ?? null,
      input.mergedAt ?? null,
      now,
      existing.id,
    );
    return;
  }
  db.prepare(
    `INSERT INTO session_prs (id, session_id, agent_id, project_name, number, url, title, state, head_branch, mergeable, merged_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input.mergeable ?? null,
    input.mergedAt ?? null,
    now,
    now,
  );
}

export function listSessionPrs(sessionId: string): SessionPrRow[] {
  return getDb()
    .prepare(`SELECT * FROM session_prs WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as SessionPrRow[];
}

export function getSessionPr(id: string): SessionPrRow | null {
  return (getDb().prepare(`SELECT * FROM session_prs WHERE id = ?`).get(id) as SessionPrRow) ?? null;
}

/**
 * Persists one PR-watch poll of a PR's GitHub status. Separate from
 * `upsertSessionPr` (discovery) because the watcher knows the row already exists and
 * only owns these polled fields; it stamps `checked_at` on every successful poll.
 */
export function setSessionPrStatus(
  id: string,
  status: {
    state: string;
    mergeable: PrMergeable | null;
    baseBranch: string | null;
    headSha: string | null;
    title?: string | null;
    mergedAt?: string | null;
  },
): void {
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE session_prs
         SET state = ?, mergeable = ?, base_branch = ?, head_sha = ?, title = COALESCE(?, title),
             merged_at = COALESCE(?, merged_at), checked_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      status.state,
      status.mergeable,
      status.baseBranch,
      status.headSha,
      status.title ?? null,
      status.mergedAt ?? null,
      now,
      now,
      id,
    );
}

/** Latches the first successful automatic promotion, preserving it across polls. */
export function markSessionPrReadyPromoted(id: string): void {
  const now = nowIso();
  getDb().prepare(`UPDATE session_prs SET ready_promoted_at = ?, updated_at = ?
    WHERE id = ? AND ready_promoted_at IS NULL`).run(now, now, id);
}

/** Records (or clears, with null) the session's PR-watch process id. */
export function setSessionPrWatchPid(sessionId: string, pid: number | null): void {
  getDb()
    .prepare(`UPDATE sessions SET pr_watch_pid = ?, updated_at = ? WHERE id = ?`)
    .run(pid, nowIso(), sessionId);
}

/** Tags an existing agent with a kind and/or the session PR it serves. `createAgent`
 * takes both up front; this is for callers that need to retag after the fact. */
export function setAgentKind(id: string, kind: AgentKind | null, sessionPrId: string | null): void {
  getDb()
    .prepare(`UPDATE agents SET kind = ?, session_pr_id = ?, updated_at = ? WHERE id = ?`)
    .run(kind, sessionPrId, nowIso(), id);
}

/** Every `pr_fix` agent spawned for one session PR, oldest first. */
export function listPrFixAgents(sessionPrId: string): AgentRow[] {
  return getDb()
    .prepare(`SELECT * FROM agents WHERE kind = 'pr_fix' AND session_pr_id = ? ORDER BY created_at ASC`)
    .all(sessionPrId) as AgentRow[];
}

/** Records what reached the PR, independently of the runtime's terminal status. */
export function setAgentFixOutcome(id: string, outcome: AgentFixOutcome, sha?: string): void {
  getDb()
    .prepare(`UPDATE agents SET fix_outcome = ?, fix_pushed_sha = ?, updated_at = ? WHERE id = ?`)
    .run(outcome, outcome === "pushed" ? sha ?? null : null, nowIso(), id);
}

/** Latches post-fix completion, atomically recording its outcome when supplied.
 * Optional for legacy callers; the first stamp/result wins. */
export function markAgentPostFixed(id: string, outcome?: AgentFixOutcome, sha?: string): void {
  const db = getDb();
  db.transaction(() => {
    if (getAgent(id)?.post_fixed_at) return;
    if (outcome) setAgentFixOutcome(id, outcome, sha);
    const now = nowIso();
    db.prepare(`UPDATE agents SET post_fixed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
  })();
}

/**
 * How many automatic fix runs were spawned for a PR since `sinceIso` — the input
 * to the `prWatch.maxFixRunsPerDay` cap. Legacy NULL origins count as automatic;
 * supervisor runs are exempt. Failed automatic runs spend budget too, preventing loops.
 */
export function countPrFixRunsSince(sessionPrId: string, sinceIso: string): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM agents WHERE kind = 'pr_fix' AND session_pr_id = ? AND created_at >= ?
          AND (fix_origin IS NULL OR fix_origin = 'auto')`,
      )
      .get(sessionPrId, sinceIso) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// PR feedback (PR watch input; bodies + replies on disk)
// ---------------------------------------------------------------------------

/**
 * Ingests one GitHub comment as pending feedback. INSERT OR IGNORE on the
 * (session_pr_id, source_id) uniqueness makes this safe to call for a comment that
 * is already known — the first ingest wins and later ones are no-ops. Returns the
 * row (new or existing).
 */
export function insertPrFeedback(input: {
  sessionPrId: string;
  sourceId: string;
  sourceKind: PrFeedbackKind;
  author?: string | null;
  authorIsBot?: boolean;
  url?: string | null;
  path?: string | null;
  line?: number | null;
  inReplyTo?: string | null;
  bodyRef?: string | null;
}): PrFeedbackRow {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO pr_feedback
       (id, session_pr_id, source_id, source_kind, author, author_is_bot, url, path, line, in_reply_to, body_ref, decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    shortId("fb"),
    input.sessionPrId,
    input.sourceId,
    input.sourceKind,
    input.author ?? null,
    input.authorIsBot ? 1 : 0,
    input.url ?? null,
    input.path ?? null,
    input.line ?? null,
    input.inReplyTo ?? null,
    input.bodyRef ?? null,
    nowIso(),
  );
  return db
    .prepare(`SELECT * FROM pr_feedback WHERE session_pr_id = ? AND source_id = ?`)
    .get(input.sessionPrId, input.sourceId) as PrFeedbackRow;
}

/** All feedback ingested for a PR, oldest first. */
export function listPrFeedback(sessionPrId: string): PrFeedbackRow[] {
  return getDb()
    .prepare(`SELECT * FROM pr_feedback WHERE session_pr_id = ? ORDER BY created_at ASC, source_id ASC`)
    .all(sessionPrId) as PrFeedbackRow[];
}

/** Every source id already ingested for a PR — the "already handled" set that keeps
 * a comment from being acted on twice. */
export function prFeedbackSourceIds(sessionPrId: string): Set<string> {
  const rows = getDb()
    .prepare(`SELECT source_id FROM pr_feedback WHERE session_pr_id = ?`)
    .all(sessionPrId) as Array<{ source_id: string }>;
  return new Set(rows.map((r) => r.source_id));
}

/** Pending feedback no fix agent has claimed (new, or released after a rejected push). */
export function listUnassignedPrFeedback(sessionPrId: string): PrFeedbackRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM pr_feedback
        WHERE session_pr_id = ? AND decision = 'pending' AND fix_agent_id IS NULL AND handled_at IS NULL
        ORDER BY created_at ASC, source_id ASC`,
    )
    .all(sessionPrId) as PrFeedbackRow[];
}

/** The feedback rows assigned to one fix agent. */
export function listAgentPrFeedback(agentId: string): PrFeedbackRow[] {
  return getDb()
    .prepare(`SELECT * FROM pr_feedback WHERE fix_agent_id = ? ORDER BY created_at ASC, source_id ASC`)
    .all(agentId) as PrFeedbackRow[];
}

/** How many of a PR's comments Tack hasn't finished with yet (dashboard badge). */
export function countOpenPrFeedback(sessionPrId: string): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM pr_feedback WHERE session_pr_id = ? AND handled_at IS NULL`)
      .get(sessionPrId) as { n: number }
  ).n;
}

/** Hands a batch of feedback rows to the fix agent that will address them. */
export function assignPrFeedback(ids: string[], agentId: string): void {
  const stmt = getDb().prepare(`UPDATE pr_feedback SET fix_agent_id = ? WHERE id = ?`);
  getDb().transaction(() => {
    for (const id of ids) stmt.run(agentId, id);
  })();
}

/** Records a fix agent's verdict on one item (via `report_pr_feedback`). Leaves
 * `handled_at` unset: the item is only "handled" once the watcher has replied. */
export function recordPrFeedbackDecision(
  id: string,
  decision: Exclude<PrFeedbackDecision, "pending" | "failed">,
  replyRef: string | null,
): void {
  getDb()
    .prepare(`UPDATE pr_feedback SET decision = ?, reply_ref = ? WHERE id = ?`)
    .run(decision, replyRef, id);
}

/** Marks an item finished: replied (with its url), or given up on (no url). An
 * optional decision overrides the recorded one (e.g. `declined` for an item the
 * agent never reported, `failed` for a failed run). */
export function markPrFeedbackHandled(
  id: string,
  opts: { replyUrl?: string | null; decision?: PrFeedbackDecision } = {},
): void {
  getDb()
    .prepare(
      `UPDATE pr_feedback SET reply_url = ?, decision = COALESCE(?, decision), handled_at = ? WHERE id = ?`,
    )
    .run(opts.replyUrl ?? null, opts.decision ?? null, nowIso(), id);
}

/** Releases every unhandled item a fix agent held back to pending + unassigned, so
 * the next watcher tick re-spawns a fix for them (used after a rejected push or a
 * stopped run, where nothing reached the PR). */
export function releaseAgentPrFeedback(agentId: string): number {
  return getDb()
    .prepare(
      `UPDATE pr_feedback SET decision = 'pending', reply_ref = NULL, fix_agent_id = NULL
        WHERE fix_agent_id = ? AND handled_at IS NULL`,
    )
    .run(agentId).changes;
}

// ---------------------------------------------------------------------------
// Session JIRA tickets
// ---------------------------------------------------------------------------

/**
 * Links (or refreshes) a ticket on a session. Two writers share this: the
 * supervisor's `link_jira_ticket` (key, maybe a guessed title/status) and the
 * dashboard's background refresh (authoritative title/status from Jira). Every
 * optional field is COALESCEd so a writer that doesn't know a value passes null and
 * never clobbers one another writer already recorded — e.g. a refresh that can't
 * attribute an agent leaves the supervisor's `agent_id` intact.
 */
export function upsertSessionJiraTicket(input: {
  sessionId: string;
  key: string;
  agentId?: string | null;
  url?: string | null;
  title?: string | null;
  status?: string | null;
  statusCategory?: string | null;
}): SessionJiraTicketRow {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `INSERT INTO session_jira_tickets
       (id, session_id, agent_id, key, url, title, status, status_category, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, key) DO UPDATE SET
       agent_id        = COALESCE(excluded.agent_id, agent_id),
       url             = COALESCE(excluded.url, url),
       title           = COALESCE(excluded.title, title),
       status          = COALESCE(excluded.status, status),
       status_category = COALESCE(excluded.status_category, status_category),
       updated_at      = excluded.updated_at`,
  ).run(
    shortId("jira"),
    input.sessionId,
    input.agentId ?? null,
    input.key,
    input.url ?? null,
    input.title ?? null,
    input.status ?? null,
    input.statusCategory ?? null,
    now,
    now,
  );
  return db
    .prepare(`SELECT * FROM session_jira_tickets WHERE session_id = ? AND key = ?`)
    .get(input.sessionId, input.key) as SessionJiraTicketRow;
}

export function listSessionJiraTickets(sessionId: string): SessionJiraTicketRow[] {
  return getDb()
    .prepare(`SELECT * FROM session_jira_tickets WHERE session_id = ? ORDER BY created_at ASC, key ASC`)
    .all(sessionId) as SessionJiraTicketRow[];
}

/** Stops tracking a ticket on a session. Local only — Jira is never touched.
 * Returns whether a row was actually removed. */
export function unlinkSessionJiraTicket(sessionId: string, key: string): boolean {
  const res = getDb()
    .prepare(`DELETE FROM session_jira_tickets WHERE session_id = ? AND key = ?`)
    .run(sessionId, key);
  return res.changes > 0;
}

export type InsightMetric = "sessions" | "agents" | "prFix" | "prs" | "merged" | "tickets" | "done" | "cost" | "tokens";
export interface InsightEvent {
  model: string | null;
  at: string;
  repo: string | null;
  metric: InsightMetric;
  value: number;
}

/** One grouped read over all history, including archived sessions. Group before
 * crossing into JS; no session fan-out or large prompt/artifact columns needed. */
export function readInsightEvents(db: Database = getDb()): InsightEvent[] {
  return db.query(`
    SELECT at, repo, model, metric, SUM(value) AS value FROM (
      SELECT created_at AS at, NULL AS repo, supervisor_model AS model, 'sessions' AS metric, 1 AS value FROM sessions
      UNION ALL SELECT created_at, NULL, supervisor_model, 'cost', cost FROM sessions WHERE cost != 0
      UNION ALL SELECT created_at, NULL, supervisor_model, 'tokens', tokens_input + tokens_output + cache_read + cache_write
        FROM sessions WHERE tokens_input + tokens_output + cache_read + cache_write != 0
      UNION ALL SELECT created_at, project_name, model, 'agents', 1 FROM agents
      UNION ALL SELECT created_at, project_name, model, 'prFix', 1 FROM agents WHERE kind = 'pr_fix'
      UNION ALL SELECT created_at, project_name, model, 'cost', cost FROM agents WHERE cost != 0
      UNION ALL SELECT created_at, project_name, model, 'tokens', tokens_input + tokens_output + cache_read + cache_write
        FROM agents WHERE tokens_input + tokens_output + cache_read + cache_write != 0
      UNION ALL SELECT created_at, project_name, NULL, 'prs', 1 FROM session_prs
      UNION ALL SELECT COALESCE(merged_at, updated_at), project_name, NULL, 'merged', 1
        FROM session_prs WHERE LOWER(state) = 'merged'
      UNION ALL SELECT created_at, NULL, NULL, 'tickets', 1 FROM session_jira_tickets
      UNION ALL SELECT updated_at, NULL, NULL, 'done', 1 FROM session_jira_tickets WHERE status_category = 'done'
    ) GROUP BY at, repo, model, metric
  `).all() as InsightEvent[];
}

/** Versions are stamped by the process that loaded the code, never its launcher. */
export function setSupervisorConfigVersion(id: string, version: string): void {
  getDb().prepare(`UPDATE sessions SET supervisor_config_version = ? WHERE id = ?`).run(version, id);
}
export function setPrWatchConfigVersion(id: string, version: string): void {
  getDb().prepare(`UPDATE sessions SET pr_watch_config_version = ? WHERE id = ?`).run(version, id);
}

export function setSupervisorCodeVersion(id: string, version: string): void {
  getDb().prepare(`UPDATE sessions SET supervisor_code_version = ? WHERE id = ?`).run(version, id);
}
export function setPrWatchCodeVersion(id: string, version: string): void {
  getDb().prepare(`UPDATE sessions SET pr_watch_code_version = ? WHERE id = ?`).run(version, id);
}
export function setSupervisorTurnStartedAt(id: string, at: string | null): void {
  getDb().prepare(`UPDATE sessions SET supervisor_turn_started_at = ? WHERE id = ?`).run(at, id);
}

// ---------------------------------------------------------------------------
// Batched reads (dashboard)
// ---------------------------------------------------------------------------
//
// The dashboard snapshots every listed session each second; one query per table
// keeps that O(tables) rather than O(sessions × tables). Ids travel as ONE JSON
// parameter through `json_each`, so no list is too long for SQLite's bound-param
// limit. Ordering matches the per-session reads (rowid breaks created_at ties), and
// sessions with no rows are simply absent from the map.

const IN_IDS = `IN (SELECT value FROM json_each(?))`;

function groupBySession<T extends { session_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.session_id);
    if (list) list.push(row);
    else out.set(row.session_id, [row]);
  }
  return out;
}

/** `listAgents` for many sessions at once. */
export function listAgentsBySession(sessionIds: readonly string[]): Map<string, AgentRow[]> {
  return groupBySession(getDb()
    .prepare(`SELECT * FROM agents WHERE session_id ${IN_IDS} ORDER BY created_at ASC, rowid ASC`)
    .all(JSON.stringify(sessionIds)) as AgentRow[]);
}

/** `listSessionPrs` for many sessions at once. */
export function listSessionPrsBySession(sessionIds: readonly string[]): Map<string, SessionPrRow[]> {
  return groupBySession(getDb()
    .prepare(`SELECT * FROM session_prs WHERE session_id ${IN_IDS} ORDER BY created_at ASC, rowid ASC`)
    .all(JSON.stringify(sessionIds)) as SessionPrRow[]);
}

/** `listSessionJiraTickets` for many sessions at once. */
export function listSessionJiraTicketsBySession(sessionIds: readonly string[]): Map<string, SessionJiraTicketRow[]> {
  return groupBySession(getDb()
    .prepare(`SELECT * FROM session_jira_tickets WHERE session_id ${IN_IDS} ORDER BY created_at ASC, key ASC, rowid ASC`)
    .all(JSON.stringify(sessionIds)) as SessionJiraTicketRow[]);
}

/** `listPendingAmendments` for many sessions at once. */
export function listPendingAmendmentsBySession(sessionIds: readonly string[]): Map<string, AmendmentRow[]> {
  return groupBySession(getDb()
    .prepare(`SELECT * FROM amendments WHERE session_id ${IN_IDS} AND status = 'pending' ORDER BY created_at ASC, rowid ASC`)
    .all(JSON.stringify(sessionIds)) as AmendmentRow[]);
}

/** The agents half of `sessionTotalCost`, per session; absent means 0. */
export function agentCostBySession(sessionIds: readonly string[]): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT session_id, COALESCE(SUM(cost), 0) AS c FROM agents WHERE session_id ${IN_IDS} GROUP BY session_id`)
    .all(JSON.stringify(sessionIds)) as { session_id: string; c: number }[];
  return new Map(rows.map((r) => [r.session_id, r.c ?? 0]));
}

/** `countOpenPrFeedback` for every PR of these sessions, keyed by session PR id;
 * absent means 0. */
export function countOpenPrFeedbackByPr(sessionIds: readonly string[]): Map<string, number> {
  const rows = getDb()
    .prepare(`
      SELECT f.session_pr_id AS id, COUNT(*) AS n FROM pr_feedback f
      JOIN session_prs p ON p.id = f.session_pr_id
      WHERE p.session_id ${IN_IDS} AND f.handled_at IS NULL
      GROUP BY f.session_pr_id`)
    .all(JSON.stringify(sessionIds)) as { id: string; n: number }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

import {
  getSession,
  latestSharedContext,
  listPrFeedback,
  listSessionJiraTickets,
  listSessionPrs,
  listSessionsWithPrs,
  setSessionSummary,
  type SessionPrRow,
  type SessionRow,
} from "../db";
import { readArtifact, writeSessionSummary } from "../artifacts/store";

/**
 * Session summaries: a durable, local record of what a session did — its goal
 * (the shared contract) and the PRs it opened, with their descriptions — so a
 * later supervisor can find similar past work (`search_past_sessions`) and reuse
 * its patterns (`read_past_session`).
 *
 * Composition is deterministic (no LLM call): the PR descriptions the supervisor
 * already wrote ARE the narrative, so the summary just assembles them. It is
 * (re)written by `open_pr` after each PR; sessions that opened PRs before this
 * existed have no stored summary, and readers compose one on the fly instead.
 */

/** Caps keep one verbose contract or comment from drowning a result. */
export const CONTRACT_CAP = 4000;
export const FEEDBACK_CAP = 1000;
const SNIPPET_LEN = 300;
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;

export interface SessionSummaryInput {
  session: Pick<SessionRow, "id" | "title" | "created_at">;
  prs: Array<{
    row: Pick<SessionPrRow, "title" | "project_name" | "url" | "state" | "head_branch"> &
      Partial<Pick<SessionPrRow, "linked_at">>;
    /** The PR description as passed to `open_pr`; empty/null when it wasn't kept. */
    body?: string | null;
  }>;
  jira: Array<{ key: string; title?: string | null }>;
  /** The latest shared-context body; null/empty when the session never set one. */
  contract: string | null;
}

/** Truncates to `max` chars, marking the cut so a reader knows text is missing. */
export function truncate(text: string, max: number, marker = "…"): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd() + marker;
}

function distinct(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

/** The session summary markdown. Pure: same input, same output. */
export function composeSessionSummary(input: SessionSummaryInput): string {
  const { session, prs, jira } = input;
  const projects = distinct(prs.map((p) => p.row.project_name));
  const lines: string[] = [
    `# ${session.title?.trim() || session.id}`,
    "",
    `- Session: ${session.id}`,
    `- Created: ${session.created_at.slice(0, 10)}`,
    `- Projects: ${projects.length ? projects.join(", ") : "(none)"}`,
  ];
  if (jira.length) {
    lines.push(`- Jira: ${jira.map((t) => (t.title?.trim() ? `${t.key} (${t.title.trim()})` : t.key)).join(", ")}`);
  }
  const contract = input.contract?.trim();
  lines.push("", "## Goal / contract", "", contract ? truncate(contract, CONTRACT_CAP, "\n\n… (truncated)") : "(no shared contract)");
  lines.push("", "## Pull requests");
  if (!prs.length) lines.push("", "(none)");
  for (const { row, body } of prs) {
    lines.push(
      "",
      `### ${row.title?.trim() || row.url}`,
      "",
      `- Project: ${row.project_name ?? "(unknown)"}`,
      `- URL: ${row.url}`,
      `- State: ${row.state ?? "(unknown)"}`,
      `- Branch: ${row.head_branch ?? "(unknown)"}`,
    );
    // Adopted with `link_pr`: the session worked on it but didn't open it.
    if (row.linked_at) lines.push(`- Linked: ${row.linked_at.slice(0, 10)} (existing PR adopted into this session)`);
    const text = body?.trim();
    if (text) lines.push("", text);
  }
  return lines.join("\n") + "\n";
}

/** Gathers a session's summary input from the DB and the artifacts on disk. */
function summaryInput(session: SessionRow): SessionSummaryInput {
  const contract = latestSharedContext(session.id);
  return {
    session,
    prs: listSessionPrs(session.id).map((row) => ({ row, body: readArtifact(row.body_ref) })),
    jira: listSessionJiraTickets(session.id).map((t) => ({ key: t.key, title: t.title })),
    contract: contract ? readArtifact(contract.body_ref) : null,
  };
}

/** Recomposes and persists a session's summary; returns its ref, or null for an unknown session. */
export function refreshSessionSummary(sessionId: string): string | null {
  const session = getSession(sessionId);
  if (!session) return null;
  const ref = writeSessionSummary(sessionId, composeSessionSummary(summaryInput(session)));
  setSessionSummary(sessionId, ref);
  return ref;
}

/** The stored summary when there is one, else one composed on the fly (never written). */
export function sessionSummaryText(session: SessionRow): string {
  return readArtifact(session.summary_ref) || composeSessionSummary(summaryInput(session));
}

function snippetOf(summary: string, terms: string[]): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  // Lead in a little before the match so it reads in context.
  const start = Math.max(0, at - Math.floor(SNIPPET_LEN / 3));
  const end = Math.min(flat.length, start + SNIPPET_LEN);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

export interface PastSessionMatch {
  sessionId: string;
  title: string | null;
  createdAt: string;
  projects: string[];
  jira: string[];
  prs: Array<{ url: string; title: string | null; project: string | null; state: string | null }>;
  snippet: string;
}

/**
 * `search_past_sessions`: sessions other than `excludeSessionId` (archived
 * included) with ≥1 PR, most recent first. Every whitespace-separated query term
 * must appear (case-insensitively) in the title or summary; `project` keeps
 * sessions with a PR in that project.
 */
export function searchPastSessions(opts: {
  excludeSessionId?: string | null;
  query?: string | null;
  project?: string | null;
  limit?: number | null;
}): PastSessionMatch[] {
  const terms = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const project = opts.project?.trim().toLowerCase();
  const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? SEARCH_DEFAULT_LIMIT)));
  const out: PastSessionMatch[] = [];
  for (const session of listSessionsWithPrs(opts.excludeSessionId)) {
    if (out.length >= limit) break;
    const prs = listSessionPrs(session.id);
    if (project && !prs.some((p) => p.project_name?.toLowerCase() === project)) continue;
    const summary = sessionSummaryText(session);
    const haystack = `${session.title ?? ""}\n${summary}`.toLowerCase();
    if (!terms.every((t) => haystack.includes(t))) continue;
    out.push({
      sessionId: session.id,
      title: session.title,
      createdAt: session.created_at,
      projects: distinct(prs.map((p) => p.project_name)),
      jira: listSessionJiraTickets(session.id).map((t) => t.key),
      prs: prs.map((p) => ({ url: p.url, title: p.title, project: p.project_name, state: p.state })),
      snippet: snippetOf(summary, terms),
    });
  }
  return out;
}

export interface PastSessionDetail {
  sessionId: string;
  title: string | null;
  createdAt: string;
  status: string;
  summary: string;
  prs: Array<{
    url: string;
    title: string | null;
    project: string | null;
    state: string | null;
    mergedAt: string | null;
    feedback: Array<{
      author: string | null;
      sourceKind: string;
      path: string | null;
      line: number | null;
      decision: string;
      body: string;
      reply: string;
      replyUrl: string | null;
    }>;
  }>;
}

/** `read_past_session`: the full summary plus how each PR's review feedback was handled; null for an unknown id. */
export function readPastSession(sessionId: string): PastSessionDetail | null {
  const session = getSession(sessionId);
  if (!session) return null;
  return {
    sessionId: session.id,
    title: session.title,
    createdAt: session.created_at,
    status: session.status,
    summary: sessionSummaryText(session),
    prs: listSessionPrs(session.id).map((p) => ({
      url: p.url,
      title: p.title,
      project: p.project_name,
      state: p.state,
      mergedAt: p.merged_at,
      feedback: listPrFeedback(p.id).map((f) => ({
        author: f.author,
        sourceKind: f.source_kind,
        path: f.path,
        line: f.line,
        decision: f.decision,
        body: truncate(readArtifact(f.body_ref), FEEDBACK_CAP),
        reply: truncate(readArtifact(f.reply_ref), FEEDBACK_CAP),
        replyUrl: f.reply_url,
      })),
    })),
  };
}

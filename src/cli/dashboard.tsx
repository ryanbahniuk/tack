import { isSessionOpen } from "../db";
import { spawnSessionReadmer } from "../session/readme";
import { PUBLISHER_KINDS, selectReadmePublisher, type PublisherKind } from "../publish";
import { hasUnresolvedDependencies, listPrDependencies } from "../db";
import { worktreeEditSummary } from "../session/edit";
import { startBaseCacheRefresher } from "../worktree/base-cache";
import { startRemoteReview } from "../session/review";
import { setPrFix } from "../session/pr-fix";
import { openUrl } from "./open-url";
import { copyToClipboard } from "./clipboard";
import React, { useEffect, useRef, useState } from "react";
import { existsSync } from "node:fs";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import {
  agentCostBySession,
  countOpenPrFeedbackByPr,
  getSession,
  listAgents,
  listAgentsBySession,
  listBootProjectsBySession,
  listInterruptedAgents,
  listAllSessionJiraTickets,
  listPendingAmendmentsBySession,
  listSessionJiraTicketsBySession,
  listSessionPrs,
  getAgent,
  listSessionPrsBySession,
  listSessions,
  type AgentRow,
  type AmendmentRow,
  type JiraTicketWithSessionRow,
  type SessionJiraTicketRow,
  type PrCiStatus,
  type PrReviewStatus,
  type SessionPrRow,
  type SessionRow,
} from "../db";
import { agentDisplayStatus, sessionActive, sessionLive, sessionNeedsInput, sessionWorking } from "./liveness";
import { refreshAllStaleSessions, staleSessionIds } from "../session/refresh";
import { describeRestart, parkRestartedSupervisor, restartSession, selectAgentsToRevive } from "../session/restart";
import { archiveSession, deleteSession, holdSession, stopSession, unarchiveSession, unholdSession } from "../session/lifecycle";
import { CONFIG_PATH, collapseHome } from "../paths";
import { editorInvocation } from "../util/editor";
import { resolveEditTarget } from "../session/edit";
import { createManualWorkspace, manualProjectCandidates } from "../session/manual";
import { selfCommand } from "../process/self";
import { isTerminalAgentStatus } from "./follow";
import { agentArtifactPath, readArtifact } from "../artifacts/store";
import { refreshSessionPrs } from "../projects/prs";
import { isWatchablePr, spawnPrWatcher, triggerPrWatch } from "../prwatch/watch";
import { isAlive } from "../process/self";
import { closeJiraClient, refreshSessionJiraTickets, resolveTicketUrl, type JiraRefreshResult } from "../projects/jira";
import { ensureConfigExists } from "../config/ensure";
import { currentConfigVersion } from "../process/version";
import { loadConfig } from "../config/load";
import type { TackConfig } from "../config/schema";
import { readInsights, RANGES, type InsightRange } from "./stats";
import { Insights, insightChartWidth } from "./insights";

const DIVIDER_WIDTH = 3;

interface View {
  session: SessionRow;
  agents: AgentRow[];
  boots: string[];
  prs: SessionPrRow[];
  /** JIRA tickets the supervisor linked to this session (track-only). */
  tickets: SessionJiraTicketRow[];
  cost: number;
  live: boolean;
  active: boolean;
  working: boolean;
  stale: boolean;
  needsInput: boolean;
  /** Pending amendment proposals awaiting the human's adjudication. */
  amendments: AmendmentRow[];
  /** PR-watch state per session PR id: comments Tack hasn't finished with yet, and
   * whether a pr_fix agent is currently working on the PR. */
  prWatch: Record<string, { openFeedback: number; fixing: boolean; dependency?: string }>;
}

/** Sort weight: sessions waiting on the human float to the top, then live ones, so
 * the state that actually needs you is never scrolled off. Equal weights keep the
 * `listSessions` order (created_at DESC), which `Array.prototype.sort` preserves. */
function rank(v: View): number {
  return (v.needsInput ? 2 : 0) + (v.active ? 1 : 0);
}

/** One read per table for every listed session (not N+1 per session), and one
 * stale-probe set per tick — this runs every second, so per-session subprocesses
 * or queries add up fast once archived sessions are shown. */
function snapshot(showArchived: boolean): View[] {
  const sessions = listSessions(showArchived);
  if (!sessions.length) return [];
  const ids = sessions.map((s) => s.id);
  const agentsBy = listAgentsBySession(ids);
  const bootsBy = listBootProjectsBySession(ids);
  const prsBy = listSessionPrsBySession(ids);
  const ticketsBy = listSessionJiraTicketsBySession(ids);
  const amendmentsBy = listPendingAmendmentsBySession(ids);
  const agentCost = agentCostBySession(ids);
  const openFeedback = countOpenPrFeedbackByPr(ids);
  const stale = staleSessionIds(sessions);
  return sessions
    .map((session) => {
      const agents = agentsBy.get(session.id) ?? [];
      const prs = prsBy.get(session.id) ?? [];
      return {
        session,
        agents,
        boots: bootsBy.get(session.id) ?? [],
        prs,
        tickets: ticketsBy.get(session.id) ?? [],
        // Same sum as `sessionTotalCost`: the supervisor's own cost plus its agents'.
        cost: (session.cost ?? 0) + (agentCost.get(session.id) ?? 0),
        live: sessionLive(session),
        active: sessionActive(session, agents),
        working: sessionWorking(session),
        stale: stale.has(session.id),
        // Waiting on the human: a plan to approve, or unread completed agent work
        // once nothing is still in flight.
        needsInput: sessionNeedsInput(session, agents),
        amendments: amendmentsBy.get(session.id) ?? [],
        prWatch: Object.fromEntries(
          prs.map((pr) => [
            pr.id,
            {
              openFeedback: openFeedback.get(pr.id) ?? 0,
              dependency: listPrDependencies(session.id).find(d => d.downstream_pr_id === pr.id && ["waiting_merge", "waiting_release", "bump_queued"].includes(d.status))?.package,
              fixing: agents.some(
                (a) =>
                  a.kind === "pr_fix" &&
                  a.session_pr_id === pr.id &&
                  (a.status === "pending" || a.status === "running" || (a.status === "done" && !a.post_fixed_at)),
              ),
            },
          ]),
        ),
      };
    })
    .sort((a, b) => Number(a.session.status === "on_hold") - Number(b.session.status === "on_hold") || rank(b) - rank(a));
}

/** Background polls (gh, Jira) cover only active sessions, even while archived
 * ones are shown: archived work has no watcher to feed and rarely changes. */
function activeSessionIds(views: readonly View[]): string[] {
  return views.filter((v) => v.session.status !== "archived").map((v) => v.session.id);
}

/** A cheap content fingerprint of the whole view, so the 1s poll only re-renders
 * when something a human would see actually changed — not every tick regardless. */
function signature(views: View[]): string {
  return views
    .map(
      (v) =>
        `${v.session.id}:${v.boots.join(",")}:${v.session.pr_fix_enabled}:${v.stale}:${v.session.status}:${v.session.title ?? ""}:${v.session.readme_url ?? ""}:${v.cost}:${v.live ? 1 : 0}:${v.active ? 1 : 0}:${v.working ? 1 : 0}:${v.session.supervisor_turn_started_at ?? ""}:${v.needsInput ? 1 : 0}:${v.amendments.length}:` +
        v.agents
          .map((a) => `${a.id}/${a.status}/${a.post_fixed_at ?? ""}/${a.fix_outcome ?? ""}/${a.cost}/${a.activity ?? ""}/${a.error ?? ""}`)
          .join(",") +
        ";" +
        v.prs
          .map((p) => {
            const w = v.prWatch[p.id];
            return `${p.number}/${p.state}/${p.mergeable ?? ""}/${p.ci_status ?? ""}/${p.review_status ?? ""}/${p.pr_fix_enabled}/${w?.openFeedback ?? 0}/${w?.fixing ? 1 : 0}/${w?.dependency ?? ""}`;
          })
          .join(",") +
        ";" +
        v.tickets.map((t) => `${t.key}/${t.status ?? ""}/${t.title ?? ""}`).join(","),
    )
    .join("|");
}

/** Resolve the same view for the picker action and its output hint. */
export function agentViewTarget(a: AgentRow, exists: (path: string) => boolean):
  { kind: "follow" } | { kind: "page"; ref: string } | { kind: "none" } {
  if (a.kind === "manual") return { kind: "none" };
  if (!isTerminalAgentStatus(a.status)) return { kind: "follow" };
  const refs = [a.output_ref, agentArtifactPath(a.session_id, a.id, "output"), agentArtifactPath(a.session_id, a.id, "transcript")];
  const ref = refs.find((path): path is string => !!path && exists(path));
  return ref ? { kind: "page", ref } : { kind: "none" };
}

const usd = (n: number) => `$${n.toFixed(4)}`;

const SESSION_ACTIONS = [
  { key: "c", label: "New session" }, { key: "m", label: "View amendments" },
  { key: "D", label: "README actions…" }, { key: "r", label: "Restart" },
  { key: "b", label: "Boot" }, { key: "B", label: "Unboot" },
  { key: "h", label: "Hold" }, { key: "x", label: "Stop" },
  { key: "a", label: "Archive" }, { key: "d", label: "Delete" },
] as const;
type SessionAction = (typeof SESSION_ACTIONS)[number]["key"];
const TICKET_ACTIONS = [
  { key: "o", label: "Open this session's tickets in the browser" },
  { key: "t", label: "Browse all tickets" }, { key: "p", label: "Poll Jira now" },
] as const;
type TicketAction = (typeof TICKET_ACTIONS)[number]["key"];

const README_ACTIONS = [
  { key: "r", label: "Refresh (regenerate)", needsUrl: false },
  { key: "o", label: "Open in browser", needsUrl: true },
  { key: "c", label: "Copy link to clipboard", needsUrl: true },
  { key: "p", label: "Publish to…", needsUrl: false },
] as const;
type ReadmeAction = (typeof README_ACTIONS)[number]["key"];

/** The `D` → `p` destination picker: hotkey and label per publisher kind. */
const README_DESTINATIONS: { kind: PublisherKind; key: string; label: string }[] = PUBLISHER_KINDS.map(kind => ({
  kind,
  ...({ "claude-artifact": { key: "a", label: "Claude Artifact" }, confluence: { key: "c", label: "Confluence (private page)" }, "google-doc": { key: "g", label: "Google Doc (unshared)" }, local: { key: "l", label: "Local file" } } as const)[kind],
}));

/** The `p` PR actions menu: hotkey, label, and whether it needs a single-PR target.
 * The auto-fix label is rendered from the target's current state instead. */
const PR_ACTIONS = [
  { key: "o", label: "Open in browser", single: false },
  { key: "c", label: "Copy link", single: true },
  { key: "p", label: "Poll now", single: false },
  { key: "R", label: "Review with persona…", single: false },
  { key: "f", label: "Toggle auto-fix", single: false },
] as const;
type PrAction = (typeof PR_ACTIONS)[number]["key"];

/** The `p` menu's state. `target` is "all" or a session PR id; the PR rows
 * themselves are re-read from the live view so flags and states stay current. */
interface PrPick {
  sessionId: string;
  step: "target" | "action";
  target: "all" | string;
  cursor: number;
}

/** One target-step row: `#12 Title · project · state`, flagged when its own auto-fix is off. */
function prTargetLabel(pr: SessionPrRow): string {
  const live = pr.state === "open" || pr.state === "draft";
  const ci = live ? prCiDisplay(pr.ci_status) : null;
  const review = live ? prReviewDisplay(pr.review_status) : null;
  return `#${pr.number ?? "?"} ${pr.title ?? ""} · ${pr.project_name ?? "?"} · ${prStateDisplay(pr.state).label}` +
    `${ci ? ` · CI ${ci.label}` : ""}${review ? ` · ${review.label}` : ""}${pr.pr_fix_enabled ? "" : " · pr-fix off"}`;
}

/** What the human asked for by leaving the dashboard: open the highlighted session,
 *  create a new one, page through output, or edit an agent's worktree. */
type Launch =
  | { kind: "resume"; id: string; message?: string }
  | { kind: "edit"; path: string; agentId: string }
  /** Create a manual workspace, then edit it exactly like `edit`. Created after Ink
   * tears down: the worktree fetch can take seconds and must not freeze the UI. */
  | { kind: "manual"; sessionId: string; project: string; prId?: string }
  | { kind: "ops" }
  | { kind: "create" }
  | { kind: "config" }
  | { kind: "output"; ref: string; title: string }
  | { kind: "follow"; agentId: string };

export function dashboardLaunchCommand(launch: Extract<Launch, { kind: "ops" | "create" | "resume" }>) {
  if (launch.kind === "ops") return selfCommand(["ops"]);
  if (launch.kind === "create") return selfCommand(["session", "create"]);
  return selfCommand(["session", "resume", launch.id, ...(launch.message ? ["--message", launch.message] : [])]);
}

/** A pending yes/no confirmation for stopping, deleting, or restoring work. */
type Confirm =
  | { action: "delete" | "stop"; id: string }
  | { action: "edit"; agentId: string; path: string }
  | { action: "unarchive"; id: string; count: number }
  | { action: "restart"; id: string; count: number; planPending: boolean; stale: boolean; midTurn: boolean }
  | { action: "readme"; id: string; label: string; local: boolean; publisher?: PublisherKind }
  | { action: "unboot"; id: string }
  | { action: "steal"; id: string; projects: string[]; agents: Record<string, string>; holders: string[] };

const KEY_HINT = "s layout · [/] range · j/k move · enter/o open · v agents/output · S session actions · p PR actions · t ticket actions · c new · O ops · h hold/unhold · a archive/unarchive · d delete · C config · z archived · q quit";

/** Render the same wrapped rows we count, including wide characters in notices.
 * Explicit rows avoid a mismatch between footer wrapping and the body budget. */
export function wrapFooter(line: string, columns: number): string[] {
  const width = Math.max(1, columns);
  return line.split("\n").flatMap(part => {
    const lines: string[] = [];
    let current = "";
    for (const word of part.split(/ +/)) {
      const joined = current ? `${current} ${word}` : word;
      if (Bun.stringWidth(joined) <= width) {
        current = joined;
        continue;
      }
      if (current) lines.push(current);
      current = "";
      for (const char of word) {
        if (current && Bun.stringWidth(current + char) > width) {
          lines.push(current);
          current = "";
        }
        current += char;
      }
    }
    lines.push(current);
    return lines;
  });
}

/** Reserve one header row, the footer margin and one spare terminal row. */
export function dashboardBodyHeight(rows: number, columns: number, footer: readonly string[]): number {
  return Math.max(0, rows - 1 - 1 - footer.reduce((n, line) => n + wrapFooter(line, columns).length, 0) - 1);
}

/** Flatten only structural Boxes; each Text is a line unit, including expanded
 * agent activity/errors, PRs and tickets. Truncation keeps these units one row. */
function flattenSessionLines(node: React.ReactNode): React.ReactElement<React.ComponentProps<typeof Text>>[] {
  return React.Children.toArray(node).flatMap(child => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return [];
    return child.type === Text ? [child as React.ReactElement<React.ComponentProps<typeof Text>>] : flattenSessionLines(child.props.children);
  });
}

/** Prefer the selected session's row and details, then fill spare space with
 * preceding sessions. Indicators count hidden sessions (not expanded lines). */
export function windowSessionLines(counts: readonly number[], cursor: number, height: number) {
  const total = counts.reduce((a, b) => a + b, 0);
  const selected = Math.max(0, Math.min(cursor, counts.length - 1));
  const anchor = counts.slice(0, selected).reduce((a, b) => a + b, 0);
  if (total <= height) return { start: 0, end: total, above: 0, below: 0 };
  if (height <= 0) return { start: anchor, end: anchor, above: 0, below: 0 };
  // Reserve indicators only when there is room alongside the cursor row.
  const aboveRoom = selected > 0 && height >= 2 ? 1 : 0;
  const belowRoom = selected < counts.length - 1 && height >= 2 + aboveRoom ? 1 : 0;
  const room = height - aboveRoom - belowRoom;
  const start = Math.max(0, anchor - Math.max(0, room - (counts[selected] ?? 1)));
  const end = Math.min(total, start + room);
  let offset = 0, above = 0, below = 0;
  counts.forEach((count, i) => {
    if (offset < start && i !== selected) above++;
    if (offset >= end && i !== selected) below++;
    offset += count;
  });
  return { start, end, above: aboveRoom ? above : 0, below: belowRoom ? below : 0 };
}

/** One session's line units: its summary row, plus agent/PR/ticket detail when
 * selected. Rendering is windowed, so only visible sessions (and the cursor's
 * expanded block) ever pay for building these. */
function sessionRowLines(v: View, selected: boolean, frame: number, config: TackConfig | null) {
  return flattenSessionLines(
    <Box key={v.session.id} flexDirection="column">
      <Text>
        <Text color={selected ? "cyan" : undefined}>{selected ? "❯ " : "  "}</Text>
        <Text dimColor={v.session.status === "on_hold"}>
        <Text color={v.needsInput ? "yellow" : v.active ? "green" : "gray"}>{v.needsInput || v.active ? "●" : "○"} </Text>
        <Text bold>{v.session.id}</Text>
        <Text dimColor> {v.session.status === "on_hold" ? "on hold" : v.session.status} </Text>
        <Text color="green">{usd(v.cost)}</Text>
        {v.boots.length > 0 ? <Text color="green"> booted: {v.boots.join(", ")}</Text> : null}
        {v.prs.length > 0 ? <Text> {prRollup(v.prs)}</Text> : null}
        {v.tickets.length > 0 ? <Text> {ticketRollup(v.tickets)}</Text> : null}
        {v.amendments.length > 0 ? (
          <Text color="yellow"> ✎ {v.amendments.length} amendment{v.amendments.length === 1 ? "" : "s"}</Text>
        ) : null}
        {v.prs.some(prHasConflicts) ? <Text color="red"> ⚠ conflicts</Text> : null}
        {!v.session.pr_fix_enabled ? <Text color="yellow"> pr-fix off</Text> : null}
        {v.stale ? <Text color="yellow"> stale</Text> : null}
        {v.working ? <Text color="cyan"> {SPINNER_FRAMES[frame]} working {turnElapsed(v.session.supervisor_turn_started_at!)}</Text> : null}
        {v.needsInput ? <Text color="yellow"> ◆ needs input</Text> : null}
        <Text dimColor> {oneLine(v.session.title ?? "", Number.MAX_SAFE_INTEGER)}</Text>
        </Text>
      </Text>
      {selected && v.session.readme_url ? <Text>    README: {v.session.readme_url}</Text> : null}
      {selected &&
        v.agents.map((a) => {
          const display = agentDisplayStatus(a);
          const terminal = a.status === "done" || a.status === "failed" || a.status === "stopped";
          return (
            <Box key={a.id} flexDirection="column">
              <Text>
                {`    ├─ ${agentLabel(a, v.prs)} `}
                <Text color={display.color}>{display.label.padEnd(8)}</Text>
                {a.runtime ? (
                  <Text dimColor>
                    {" "}
                    {a.runtime}:{a.model}
                  </Text>
                ) : null}
                <Text color="green"> {usd(a.cost)}</Text>
                {a.attempt > 0 ? <Text color="yellow"> ↻{a.attempt}</Text> : null}
              </Text>
              {/* Live "what it's doing now" for a non-terminal agent (#4). */}
              {!terminal && a.activity ? (
                <Text dimColor>
                  {"    │    ↳ "}
                  {oneLine(a.activity, Number.MAX_SAFE_INTEGER)}
                  {a.activity_at ? ` · ${relativeTime(a.activity_at)}` : ""}
                </Text>
              ) : null}
              {/* Why it failed, inline, without opening the output file (#8). */}
              {a.status === "failed" && a.error ? (
                <Text color="red">
                  {"    │    ✖ "}
                  {oneLine(a.error, 100)}
                </Text>
              ) : null}
            </Box>
          );
        })}
      {selected &&
        v.prs.map((pr) => {
          const { glyph, color, label } = prStateDisplay(pr.state);
          const live = pr.state === "open" || pr.state === "draft";
          const ci = live ? prCiDisplay(pr.ci_status) : null;
          const review = live ? prReviewDisplay(pr.review_status) : null;
          const w = v.prWatch[pr.id];
          return (
            <Text key={pr.id}>
              {"    └─ PR "}
              {pr.number ?? "?"}{" "}
              <Text color={color}>
                {glyph} {label}
              </Text>
              {ci ? (
                <Text color={ci.color} dimColor={ci.dim}>
                  {" CI "}{ci.glyph} {ci.label}
                </Text>
              ) : null}
              {review ? (
                <Text color={review.color} dimColor={review.dim}>
                  {" "}{review.glyph} {review.label}
                </Text>
              ) : null}
              {pr.linked_at ? <Text dimColor> linked</Text> : null}
              {prHasConflicts(pr) ? <Text color="red"> ⚠ conflicts</Text> : null}
              {w && w.openFeedback > 0 ? (
                <Text color="yellow">
                  {" "}
                  {w.openFeedback} comment{w.openFeedback === 1 ? "" : "s"}
                </Text>
              ) : null}
              {w?.dependency ? <Text color="yellow"> ⏳ {w.dependency} release</Text> : null}
              {w?.fixing ? <Text color="cyan"> fixing…</Text> : null}
              {!pr.pr_fix_enabled ? <Text color="yellow"> pr-fix off</Text> : null}{" "}
              <Text underline>{pr.url}</Text>
            </Text>
          );
        })}
      {selected &&
        v.tickets.map((t) => {
          const { glyph, color } = ticketStatusDisplay(t.status_category);
          const url = resolveTicketUrl(config, t);
          return (
            <Text key={t.id}>
              {"    └─ JIRA "}
              {t.key}{" "}
              <Text color={color}>
                {glyph} {t.status ?? "?"}
              </Text>
              {t.title ? <Text dimColor>{"  "}{oneLine(t.title, 60)}</Text> : null}
              {url ? (
                <>
                  {"  "}
                  <Text underline>{url}</Text>
                </>
              ) : null}
            </Text>
          );
        })}
    </Box>
  );
}

export function Dashboard({ config, onLaunch, initialNotice = "" }: { config: TackConfig | null; onLaunch: (l: Launch) => void; initialNotice?: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 }));
  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resize);
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout]);
  const [layout, setLayout] = useState<"split" | "list" | "insights">(() =>
    (stdout.columns || 80) >= 140 ? "split" : "list",
  );
  const effectiveLayout = layout === "split" && size.columns < 140 ? "list" : layout;
  const listWidth = effectiveLayout === "split" ? Math.floor(size.columns * 0.55) : size.columns;
  const insightWidth = effectiveLayout === "split" ? size.columns - listWidth - DIVIDER_WIDTH : size.columns;
  const [range, setRange] = useState<InsightRange>("30d");
  const [stats, setStats] = useState(() => readInsights(range, new Date(), insightChartWidth(insightWidth)));
  const statsSig = useRef(JSON.stringify(stats));
  // A slow read also catches archived-only changes that the active list's
  // fingerprint can't see. Equal results never schedule an idle repaint.
  useEffect(() => {
    const tick = () => {
      const chartWidth = effectiveLayout === "insights" && insightWidth >= 70
        ? insightChartWidth(Math.floor(insightWidth / 2))
        : insightChartWidth(insightWidth);
      const next = readInsights(range, new Date(), chartWidth);
      const sig = JSON.stringify(next);
      if (sig !== statsSig.current) {
        statsSig.current = sig;
        setStats(next);
      }
    };
    tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, [range, insightWidth, effectiveLayout]);
  const [showArchived, setShowArchived] = useState(false);
  const [rows, setRows] = useState<View[]>(() => snapshot(false));
  const [frame, setFrame] = useState(0);
  const workingCount = rows.filter((v) => v.working).length;
  // Animate only while supervisors are working; idle boards don't repaint.
  useEffect(() => {
    if (!workingCount) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, [workingCount]);
  // Selection is pinned to a session *id*, not a row index, so re-sorting (sessions
  // float as they start needing input) and deletions never move the highlight onto
  // the wrong session under the human's cursor.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [mode, setMode] = useState<"list" | "agents" | "amendments" | "tickets">("list");
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [agentCursor, setAgentCursor] = useState(0);
  const [amendmentCursor, setAmendmentCursor] = useState(0);
  /** Tickets-view selection, pinned to a (session, ticket) id like `cursorId` so a
   * status change that re-sorts the list keeps the highlight; `index` is the
   * fallback when that ticket disappears (unlinked), clamping to a neighbor. */
  const [ticketSel, setTicketSel] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  /** Tickets-view filters, reset each time `t` opens the view. */
  const [ticketFilter, setTicketFilter] = useState<TicketFilter>(DEFAULT_TICKET_FILTER);
  /** `/` text entry in progress: keystrokes edit `ticketFilter.text` instead of
   * running the panel's shortcuts, until enter (keep) or esc (clear). */
  const [ticketTyping, setTicketTyping] = useState(false);
  /** Every linked ticket, archived sessions included — independent of `z` and only
   * read while the tickets view is open (see the tick below). */
  const [allTickets, setAllTickets] = useState<JiraTicketWithSessionRow[]>([]);
  const ticketsSigRef = useRef("");
  /** Persona chooser for the selected session. */
  const [personaPick, setPersonaPick] = useState<{ options: string[]; cursor: number; sessionId: string; prId?: string } | null>(null);
  /** The `p` PR actions menu; null when closed. */
  const [prPick, setPrPick] = useState<PrPick | null>(null);
  const [sessionPick, setSessionPick] = useState<{ sessionId: string; cursor: number } | null>(null);
  const [ticketPick, setTicketPick] = useState<{ cursor: number } | null>(null);
  const [readmePick, setReadmePick] = useState<{ sessionId: string; url: string | null; cursor: number; step?: "action" | "destination" } | null>(null);
  /** The `n` project chooser inside the agents picker; null when not choosing. */
  const [projectPick, setProjectPick] = useState<{ options: { label: string; project: string; prId?: string }[]; cursor: number } | null>(null);
  const [bootPick, setBootPick] = useState<{ session: string; groups: { project: string; agents: AgentRow[] }[]; choices: Record<string, string>; cursor: number } | null>(null);
  const [bootBusy, setBootBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [sessionRefreshing, setSessionRefreshing] = useState(false);
  const [notice, setNotice] = useState(initialNotice);
  const [ghMissing, setGhMissing] = useState(false);
  const [jiraUnavailable, setJiraUnavailable] = useState(false);

  const cursor = Math.max(0, rows.findIndex((r) => r.session.id === cursorId));
  const selected = rows[cursor] as View | undefined;
  const pickerView = rows.find((r) => r.session.id === pickerId);

  // Entries the tickets view shows: the full ticket history joined with live views
  // for the sessions on screen, then narrowed by the view's filters.
  const shownTickets = mode === "tickets" ? filterTicketEntries(ticketEntries(allTickets, rows), ticketFilter) : [];

  /** Re-read the whole ticket history; re-renders only when its fingerprint moved. */
  const refreshTickets = () => {
    const next = listAllSessionJiraTickets();
    const sig = ticketsSignature(next);
    if (sig !== ticketsSigRef.current) {
      ticketsSigRef.current = sig;
      setAllTickets(next);
    }
  };

  const sigRef = useRef("");
  const refresh = () => {
    const next = snapshot(showArchived);
    sigRef.current = signature(next);
    setRows(next);
    if (mode === "tickets") refreshTickets();
  };

  // The dashboard only observes — it never marks a session seen. The "unread work"
  // badge clears when the human actually opens the session (`tack session resume`,
  // which attaches/resumes the supervisor and stamps `last_seen_at`), not just by
  // highlighting it here. Poll every second but only re-render when the fingerprint
  // changes, so an idle board doesn't repaint 60×/minute.
  useEffect(() => {
    const tick = () => {
      const next = snapshot(showArchived);
      const sig = signature(next);
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        setRows(next);
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [showArchived]);

  // The tickets view's history query rides the same 1s cadence, but only while the
  // view is open: the main list never needs archived sessions' tickets.
  useEffect(() => {
    if (mode !== "tickets") return;
    refreshTickets();
    const t = setInterval(refreshTickets, 1000);
    return () => clearInterval(t);
  }, [mode]);

  // Kept fresh so the refresh effect below (which fires on mount + every
  // `prWatch.intervalSeconds`, like the PR watcher, not on every 1s snapshot)
  // always sees the sessions currently on screen.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // Refreshing PR status is automatic, so opening the dashboard is itself the "check
  // now" gesture — and the same tick (re)starts any missing PR watchers (see
  // `ensurePrWatchers`) — refresh once on mount (merge status should be right away, not
  // after a full interval), then every `prWatch.intervalSeconds`, like the PR watcher.
  // `refreshing` guards against a slow `gh` call stacking with the next tick.
  // Never touches `setRows`: it only writes to SQLite, and the 1s snapshot poll
  // above already re-reads `listSessionPrs`.
  useEffect(() => config ? startBaseCacheRefresher(config) : undefined, [config]);

  const refreshing = useRef(false);
  useEffect(() => {
    if (!config) return;
    const run = () => {
      if (refreshing.current) return;
      refreshing.current = true;
      const ids = activeSessionIds(rowsRef.current);
      refreshSessionPrs(config, ids)
        .then((res) => {
          setGhMissing(res.ghMissing);
          if (!res.ghMissing) ensurePrWatchers(config, ids);
        })
        .catch(() => {})
        .finally(() => {
          refreshing.current = false;
        });
    };
    run();
    const t = setInterval(run, config.prWatch.intervalSeconds * 1000);
    return () => clearInterval(t);
  }, [config]);

  // Same shape for JIRA ticket status, on its own guard and a slower 2-minute
  // cadence: ticket status moves on human timescales, and each tick is MCP round
  // trips through the Atlassian server rather than one local `gh` call. The client
  // (and its server subprocess) is long-lived inside `projects/jira.ts` — the first
  // tick pays the slow `uvx` start, later ticks reuse it — so cleanup closes it.
  // Only a configured `jira` block can be "unavailable"; without one the feature is
  // simply off and stays silent. Like PRs, never touches `setRows`.
  const refreshingJira = useRef(false);
  /** One Jira poll, shared by the 2-minute tick and the on-demand `P` so both sit
   * behind the same `refreshingJira` guard and can never overlap. The background
   * tick stays silent; on demand it reports progress/results in the notice line and
   * re-snapshots so new statuses show immediately instead of on the next 1s poll. */
  const pollJira = (cfg: TackConfig, ids: string[], onDemand: boolean) => {
    if (refreshingJira.current) {
      if (onDemand) setNotice("Jira poll already in progress…");
      return;
    }
    refreshingJira.current = true;
    if (onDemand) setNotice("polling Jira…");
    refreshSessionJiraTickets(cfg, ids)
      .then((res) => {
        setJiraUnavailable(Boolean(cfg.jira) && res.unavailable);
        if (onDemand) setNotice(describeJiraPoll(cfg, res));
      })
      .catch((err) => {
        if (onDemand) setNotice(`Jira poll failed: ${(err as Error).message}`);
      })
      .finally(() => {
        refreshingJira.current = false;
        if (onDemand) refresh();
      });
  };
  const startJiraPoll = () => {
    if (!config) return setNotice("config is unavailable");
    pollJira(config, rows.map((v) => v.session.id), true);
  };
  useEffect(() => {
    if (!config) return;
    // The background tick skips archived sessions (see `activeSessionIds`); the
    // on-demand `P` still polls whatever the human is looking at.
    const run = () => pollJira(config, activeSessionIds(rowsRef.current), false);
    run();
    const t = setInterval(run, 120_000);
    return () => {
      clearInterval(t);
      void closeJiraClient();
    };
  }, [config]);

  const runBootWorker = (session: string, action: "boot" | "unboot", agents: Record<string, string> = {}, projects?: string[], steal = false) => {
    if (!config || bootBusy) return;
    setBootBusy(true);
    setNotice(`${action === "boot" ? "booting" : "unbooting"} ${session}…`);
    const worker = new Worker(new URL("../boot/worker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent<{ progress?: string; error?: string; results?: import("../boot").BootOutcome[] }>) => {
      if (event.data.progress) { setNotice(event.data.progress); return; }
      worker.terminate(); setBootBusy(false); refresh();
      if (event.data.error) { setNotice(`${action} failed: ${event.data.error}`); return; }
      const results = event.data.results ?? [];
      const locked = results.filter(r => r.status === "locked");
      setNotice(results.map(r => `${r.project}: ${r.status}${r.error ? `: ${r.error}` : ""}`).join(" · ") || "no configured worktrees");
      if (locked.length) setConfirm({ action: "steal", id: session, projects: locked.map(r => r.project), holders: locked.map(r => r.holder ?? "unknown"), agents });
    };
    worker.onerror = event => { worker.terminate(); setBootBusy(false); setNotice(`${action} failed: ${event.message}`); };
    worker.postMessage({ config, session, action, agents, projects, steal });
  };

  /** Run one `p` menu action on all of a session's PRs or on one of them. Notices
   * name the target: the session for "all", `#N` for a single PR. */
  const runPrAction = (view: View, target: "all" | string, action: PrAction) => {
    const id = view.session.id;
    const pr = target === "all" ? null : view.prs.find((p) => p.id === target);
    if (target !== "all" && !pr) return setNotice("that PR is no longer in this session");
    const label = pr ? `#${pr.number ?? "?"}` : id;
    switch (action) {
      case "o": {
        const urls = pr ? [pr.url] : view.prs.map((p) => p.url);
        for (const url of urls) openUrl(url);
        return setNotice(pr ? `opened ${label} in browser` : `opened ${urls.length} PR${urls.length === 1 ? "" : "s"} in browser`);
      }
      case "c":
        if (!pr) return setNotice("pick a single PR to copy its link");
        void copyToClipboard(pr.url).then((ok) => setNotice(ok ? `copied link for ${label}` : `no clipboard tool found · ${pr.url}`));
        return;
      case "p":
        if (!config) return setNotice("config is unavailable");
        setNotice(`polling PRs for ${label}…`);
        void triggerPrWatch(id, config, undefined, { prId: pr?.id }).then((result) => {
          switch (result.kind) {
            case "disabled": setNotice("PR watch is disabled"); break;
            case "inactive": setNotice(`${id} is not active`); break;
            case "no-open-prs": setNotice(pr ? `${label} is not open (status refreshed)` : `${id} has no open PRs (statuses refreshed)`); break;
            case "signalled":
            case "started": setNotice(`polling PRs for ${label} · ${result.kind} watcher pid ${result.pid}`); break;
          }
        }).catch((err) => {
          setNotice(`PR poll failed: ${(err as Error).message}`);
        }).finally(refresh);
        return;
      case "R":
        if (!config) return setNotice("config is unavailable");
        if (!config.personas.length) return setNotice("no personas configured");
        return setPersonaPick({ options: config.personas.map((p) => p.name), cursor: 0, sessionId: id, prId: pr?.id });
      case "f": {
        if (!config) return setNotice("config is unavailable");
        // "All PRs" is the session switch (today's semantics); a single PR flips
        // only its own flag, which still needs the session's on to take effect.
        const enabled = pr ? !pr.pr_fix_enabled : !view.session.pr_fix_enabled;
        const done = pr && enabled && !view.session.pr_fix_enabled
          ? `on for ${label}, but session auto-fix is off · toggle from All PRs`
          : `PR auto-fix ${enabled ? "on" : "off"} for ${label}`;
        void setPrFix(id, enabled, config, { prId: pr?.id }).then(() => setNotice(done))
          .catch((err) => setNotice(`PR auto-fix failed: ${(err as Error).message}`)).finally(refresh);
        return;
      }
    }
  };

  const runSessionAction = (view: View | undefined, action: SessionAction) => {
    if (action === "c") { onLaunch({ kind: "create" }); exit(); return; }
    if (!view) return;
    switch (action) {
    case "D": setReadmePick({ sessionId: view.session.id, url: view.session.readme_url, cursor: 0 }); break;
    case "b":
      if (!config) return setNotice("config is unavailable");
      if (bootBusy) return setNotice("boot operation already running");
      const groups = config.projects.filter(p => p.boot).map(p => ({ project: p.name, agents: view.agents.filter(a => a.project_name === p.name && a.kind !== "pr_fix" && a.worktree_path && existsSync(a.worktree_path)) })).filter(g => g.agents.length > 1);
      if (groups.length) setBootPick({ session: view.session.id, groups, choices: {}, cursor: 0 });
      else runBootWorker(view.session.id, "boot");
      break;
    case "B":
      if (bootBusy) return setNotice("boot operation already running");
      setConfirm({ action: "unboot", id: view.session.id });
      break;
    case "m":
      if (view.amendments.length === 0) {
        setNotice(`${view.session.id} has no pending amendments`);
        return;
      }
      setPickerId(view.session.id);
      setAmendmentCursor(0);
      setMode("amendments");
      break;
    case "r": {
      const s = view.session;
      if (s.status === "archived") return setNotice(`${s.id} is archived · a to unarchive`);
      setConfirm({ action: "restart", id: s.id, count: selectAgentsToRevive(listAgents(s.id)).length,
        stale: view.stale, midTurn: Boolean(s.supervisor_turn_started_at),
        planPending: Boolean(s.awaiting_input_at && s.awaiting_reason === "plan") });
      break; }
    case "x":
      setConfirm({ action: "stop", id: view.session.id });
      break;
    case "h": {
      const s = view.session;
      if (s.status === "archived") return setNotice(`${s.id} is archived · a to unarchive`);
      if (s.status === "on_hold") {
        void unholdSession(s.id, config ?? undefined).then(() => setNotice(`${s.id} off hold · PR auto-fix on`))
          .catch(err => setNotice(`unhold failed: ${(err as Error).message}`)).finally(refresh);
      } else {
        holdSession(s.id); setNotice(`put ${s.id} on hold · PR auto-fix off · h to resume`);
        refresh();
      }
      break; }
    case "a":
      if (view.session.status === "archived") {
        setConfirm({ action: "unarchive", id: view.session.id, count: listInterruptedAgents(view.session.id).length });
      } else {
        archiveSession(view.session.id);
        setNotice(`archived ${view.session.id} · z to show archived, a to restore`);
        refresh();
      }
      break;
    case "d":
      setConfirm({ action: "delete", id: view.session.id });
      break;
    }
  };
  const runTicketAction = (view: View | undefined, action: TicketAction) => {
    if (action === "p") return startJiraPoll();
    if (action === "t") {
      setTicketSel({ id: null, index: 0 }); setTicketFilter(DEFAULT_TICKET_FILTER);
      setTicketTyping(false); refreshTickets(); setMode("tickets"); return;
    }
    if (!view) return setNotice("select a session to open its tickets");

      const id = view.session.id;
      const total = view.tickets.length;
      if (total === 0) return setNotice(`${id} has no tickets yet`);
      // Without a stored url or a `jira` siteUrl a ticket has nowhere to link.
      const urls = view.tickets.map((t) => resolveTicketUrl(config, t)).filter((u): u is string => Boolean(u));
      if (urls.length === 0) {
        return setNotice(`${id} has ${total} ticket${total === 1 ? "" : "s"} but no Jira site is configured — add a \`jira\` block (siteUrl) to your Tack config`);
      }
      for (const url of urls) openUrl(url);
      const skipped = total - urls.length;
      setNotice(`opened ${urls.length} ticket${urls.length === 1 ? "" : "s"} in browser${skipped ? ` · ${skipped} without a link (no jira siteUrl)` : ""}`);
  };

  useInput((input, key) => {
    // Quit is the one gesture that works from everywhere.
    if (key.ctrl && input === "c") return exit();

    if (sessionRefreshing) return;
    if (bootPick) {
      const group = bootPick.groups[0]!;
      if (input === "q" || key.escape) { setBootPick(null); setNotice("cancelled"); return; }
      if (key.downArrow || input === "j") { setBootPick({ ...bootPick, cursor: Math.min(bootPick.cursor + 1, group.agents.length - 1) }); return; }
      if (key.upArrow || input === "k") { setBootPick({ ...bootPick, cursor: Math.max(bootPick.cursor - 1, 0) }); return; }
      if (key.return) {
        const choices = { ...bootPick.choices, [group.project]: group.agents[bootPick.cursor]!.id };
        if (bootPick.groups.length > 1) setBootPick({ ...bootPick, groups: bootPick.groups.slice(1), choices, cursor: 0 });
        else { setBootPick(null); runBootWorker(bootPick.session, "boot", choices); }
      }
      return;
    }

    // A pending confirmation swallows the next keypress: y commits, anything
    // else cancels (stop/delete also accept enter). Keeps a stray `d` from deleting a session's
    // worktrees and artifacts irreversibly.
    if (confirm) {
      if (input === "y" || input === "Y" || (key.return && (confirm.action === "delete" || confirm.action === "stop"))) {
        if (confirm.action === "readme") {
          if (confirm.publisher) spawnSessionReadmer(confirm.id, confirm.publisher);
          else spawnSessionReadmer(confirm.id);
          setNotice(`generating README for ${confirm.id} · tack session show ${confirm.id} for the link`);
        } else if (confirm.action === "unboot" || confirm.action === "steal") {
          const pending = confirm; setConfirm(null);
          if (pending.action === "unboot") runBootWorker(pending.id, "unboot");
          else runBootWorker(pending.id, "boot", pending.agents, pending.projects, true);
          return;
        } else if (confirm.action === "edit") {
          onLaunch({ kind: "edit", path: confirm.path, agentId: confirm.agentId });
          setConfirm(null);
          return exit();
        } else if (confirm.action === "restart") {
          // Runs in the background and keeps the dashboard open: the replacement
          // supervisor is parked in tmux rather than launched in the foreground,
          // so enter attaches when the user wants the conversation. The busy flag
          // covers stopping the old TUI, which can take a couple of seconds.
          const id = confirm.id;
          setConfirm(null);
          if (!config) { setNotice("Configuration unavailable"); return; }
          setSessionRefreshing(true);
          setNotice(`restarting ${id}…`);
          void (async () => {
            const result = await restartSession(id, config);
            const park = await parkRestartedSupervisor(id, config);
            const summary = `${id}: ${describeRestart(result)}`;
            if (park.parked) setNotice(`${summary} · parked in tmux · enter to attach`);
            else if (park.reason === "no-resume-ref") setNotice(`${summary} · no resume handle yet — it never got far enough to follow up on`);
            else if (park.reason === "no-tmux") setNotice(`${summary} · tmux unavailable, supervisor stopped · enter to resume`);
            else setNotice(`${summary} · could not park in tmux · enter to resume`);
          })().catch(err => setNotice(`restart failed: ${err.message}`)).finally(() => { setSessionRefreshing(false); refresh(); });
          return;
        } else if (confirm.action === "delete") {
          deleteSession(confirm.id);
          setNotice(`deleted ${confirm.id}`);
        } else if (confirm.action === "unarchive") {
          const { resumedAgents } = unarchiveSession(confirm.id);
          setCursorId(confirm.id);
          setNotice(`unarchived ${confirm.id} · resumed ${resumedAgents.length} agent(s) · enter to rejoin supervisor`);
        } else {
          stopSession(confirm.id);
          setNotice(`stopped ${confirm.id}`);
        }
        refresh();
      } else {
        setNotice("cancelled");
      }
      setConfirm(null);
      return;
    }

    // Amendments panel: read-only. Adjudication is the supervisor's job — it's
    // surfaced the pending amendment through `wait_for_agents` and resolves it with
    // `resolve_amendment`. The dashboard only lets you SEE what was proposed.
    if (mode === "amendments") {
      const pending = pickerView?.amendments ?? [];
      if (input === "q" || key.escape || !pickerView) return setMode("list");
      if (key.downArrow || input === "j")
        return setAmendmentCursor((c) => Math.min(c + 1, Math.max(0, pending.length - 1)));
      if (key.upArrow || input === "k") return setAmendmentCursor((c) => Math.max(c - 1, 0));
      return;
    }

    // Cross-session tickets view: read-only, like the rest of the Jira surface. `q`
    // backs out here rather than quitting (ctrl+c above still quits).
    if (mode === "tickets") {
      // Typing a `/` filter captures every key — `q`, `j`, `g`… are text here — so
      // a search for "quality" can't quit the view or jump to a session.
      if (ticketTyping) {
        if (key.escape) {
          setTicketFilter((f) => ({ ...f, text: "" }));
          return setTicketTyping(false);
        }
        if (key.return) return setTicketTyping(false);
        if (key.backspace || key.delete) return setTicketFilter((f) => ({ ...f, text: f.text.slice(0, -1) }));
        // Printable only (a paste may arrive as several characters at once).
        const text = key.ctrl || key.meta ? "" : input.replace(/[\u0000-\u001f\u007f]/g, "");
        if (text) setTicketFilter((f) => ({ ...f, text: f.text + text }));
        return;
      }
      const entries = shownTickets;
      const index = ticketCursorIndex(entries, ticketSel);
      const entry = entries[index];
      const move = (next: number) => {
        const target = entries[Math.max(0, Math.min(next, entries.length - 1))];
        if (target) setTicketSel({ id: ticketEntryId(target), index: Math.max(0, Math.min(next, entries.length - 1)) });
      };
      if (input === "q" || key.escape) return setMode("list");
      if (key.downArrow || input === "j") return move(index + 1);
      if (key.upArrow || input === "k") return move(index - 1);
      if (input === "/") return setTicketTyping(true);
      if (input === "f") return setTicketFilter((f) => ({ ...f, status: nextTicketStatusFilter(f.status) }));
      if (input === "a") return setTicketFilter((f) => ({ ...f, hideArchived: !f.hideArchived }));
      // Polls what the view is showing (archived sessions included), not just the
      // main list's rows; same guard as the background tick, so they never overlap.
      if (input === "P") {
        if (!config) return setNotice("config is unavailable");
        if (entries.length === 0) return setNotice("no tickets match the filters — nothing to poll");
        return pollJira(config, [...new Set(entries.map((e) => e.session.id))], true);
      }
      if (!entry) return;
      if (key.return || input === "o") {
        const url = resolveTicketUrl(config, entry.ticket);
        if (!url) return setNotice(`can't open ${entry.ticket.key}: no Jira site is configured — add a \`jira\` block (siteUrl) to your Tack config`);
        openUrl(url);
        return setNotice(`opened ${entry.ticket.key} in browser`);
      }
      if (input === "g") {
        // An archived session only has a row in the main list with `z` on, so turn
        // it on first or the cursor would fall back to the top row.
        if (entry.session.status === "archived" && !showArchived) setShowArchived(true);
        setCursorId(entry.session.id);
        return setMode("list");
      }
      return;
    }

    if (personaPick) {
      if (input === "q" || key.escape) { setPersonaPick(null); setNotice("cancelled"); return; }
      if (key.downArrow || input === "j") return setPersonaPick({ ...personaPick, cursor: Math.min(personaPick.cursor + 1, personaPick.options.length - 1) });
      if (key.upArrow || input === "k") return setPersonaPick({ ...personaPick, cursor: Math.max(personaPick.cursor - 1, 0) });
      if (key.return && config) {
        try {
          const review = startRemoteReview(config, personaPick.sessionId, { persona: personaPick.options[personaPick.cursor]!, prId: personaPick.prId });
          setNotice(`started ${review.reviews.length} review(s)`); refresh();
        } catch (err) { setNotice(`review failed: ${(err as Error).message}`); }
        setPersonaPick(null);
      }
      return;
    }

    if (sessionPick) {
      const view = rows.find(r => r.session.id === sessionPick.sessionId);
      if (input === "q" || key.escape || !view) { setSessionPick(null); setNotice("cancelled"); return; }
      if (key.downArrow || input === "j") return setSessionPick({ ...sessionPick, cursor: Math.min(sessionPick.cursor + 1, SESSION_ACTIONS.length - 1) });
      if (key.upArrow || input === "k") return setSessionPick({ ...sessionPick, cursor: Math.max(sessionPick.cursor - 1, 0) });
      const action = key.return ? SESSION_ACTIONS[sessionPick.cursor]!.key : SESSION_ACTIONS.find(a => a.key === input)?.key;
      if (action) { setSessionPick(null); runSessionAction(view, action); }
      return;
    }
    if (ticketPick) {
      if (input === "q" || key.escape) { setTicketPick(null); setNotice("cancelled"); return; }
      if (key.downArrow || input === "j") return setTicketPick({ cursor: Math.min(ticketPick.cursor + 1, TICKET_ACTIONS.length - 1) });
      if (key.upArrow || input === "k") return setTicketPick({ cursor: Math.max(ticketPick.cursor - 1, 0) });
      const action = key.return ? TICKET_ACTIONS[ticketPick.cursor]!.key : TICKET_ACTIONS.find(a => a.key === input)?.key;
      if (action) { setTicketPick(null); runTicketAction(selected, action); }
      return;
    }

    // README menu: swallows every key while open and closes after any action
    // (including a refused open/copy), so it never lingers behind a notice.
    if (readmePick?.step === "destination") {
      if (input === "q" || key.escape) { setReadmePick(null); setNotice("cancelled"); return; }
      if (key.downArrow || input === "j") return setReadmePick({ ...readmePick, cursor: Math.min(readmePick.cursor + 1, README_DESTINATIONS.length - 1) });
      if (key.upArrow || input === "k") return setReadmePick({ ...readmePick, cursor: Math.max(readmePick.cursor - 1, 0) });
      const dest = key.return ? README_DESTINATIONS[readmePick.cursor] : README_DESTINATIONS.find(d => d.key === input);
      if (!dest) return;
      setReadmePick(null);
      if (!config) return setNotice("Configuration unavailable");
      const publisher = selectReadmePublisher(config, readmePick.url, dest.kind);
      return setConfirm({ action: "readme", id: readmePick.sessionId, label: publisher.label, local: publisher.kind === "local", publisher: publisher.kind });
    }
    if (readmePick) {
      if (input === "q" || key.escape) { setReadmePick(null); setNotice("cancelled"); return; }
      if (key.downArrow || input === "j") return setReadmePick({ ...readmePick, cursor: Math.min(readmePick.cursor + 1, README_ACTIONS.length - 1) });
      if (key.upArrow || input === "k") return setReadmePick({ ...readmePick, cursor: Math.max(readmePick.cursor - 1, 0) });
      const action: ReadmeAction | undefined = key.return ? README_ACTIONS[readmePick.cursor]!.key
        : README_ACTIONS.find(a => a.key === input)?.key;
      if (!action) return;
      const { sessionId: id, url } = readmePick;
      if (action === "p") return setReadmePick({ ...readmePick, step: "destination", cursor: 0 });
      setReadmePick(null);
      if (action === "r") {
        // Regenerating spends tokens and may publish, so keep the y/N confirm.
        if (!config) return setNotice("Configuration unavailable");
        const publisher = selectReadmePublisher(config, url);
        return setConfirm({ action: "readme", id, label: publisher.label, local: publisher.kind === "local" });
      }
      if (!url) return setNotice("no README yet · S → D → r to generate");
      if (action === "o") { openUrl(url); return setNotice(`opened README for ${id} in browser`); }
      void copyToClipboard(url).then(ok => setNotice(ok ? `copied README link for ${id}` : `no clipboard tool found · ${url}`));
      return;
    }

    // PR actions menu: a target step (skipped for a single PR), then an action step.
    // Like the README menu it swallows every key and closes after any action,
    // including a refused one, so it never lingers behind a notice.
    if (prPick) {
      const view = rows.find((r) => r.session.id === prPick.sessionId);
      if (input === "q" || key.escape || !view) { setPrPick(null); setNotice("cancelled"); return; }
      if (prPick.step === "target") {
        const last = view.prs.length; // row 0 is "All PRs"
        if (key.downArrow || input === "j") return setPrPick({ ...prPick, cursor: Math.min(prPick.cursor + 1, last) });
        if (key.upArrow || input === "k") return setPrPick({ ...prPick, cursor: Math.max(prPick.cursor - 1, 0) });
        if (key.return) {
          const pr = view.prs[prPick.cursor - 1];
          setPrPick({ ...prPick, step: "action", target: pr ? pr.id : "all", cursor: 0 });
        }
        return;
      }
      if (key.downArrow || input === "j") return setPrPick({ ...prPick, cursor: Math.min(prPick.cursor + 1, PR_ACTIONS.length - 1) });
      if (key.upArrow || input === "k") return setPrPick({ ...prPick, cursor: Math.max(prPick.cursor - 1, 0) });
      const action: PrAction | undefined = key.return ? PR_ACTIONS[prPick.cursor]!.key
        : PR_ACTIONS.find((a) => a.key === input)?.key;
      if (!action) return;
      setPrPick(null);
      runPrAction(view, prPick.target, action);
      return;
    }

    // Agent picker: output and editing both hand the terminal to a child process.
    if (mode === "agents") {
      const agents = pickerView?.agents ?? [];
      // Project chooser for a new manual workspace swallows input until picked/cancelled.
      if (projectPick && pickerView) {
        if (input === "q" || key.escape) { setProjectPick(null); setNotice("cancelled"); return; }
        if (key.downArrow || input === "j")
          return setProjectPick({ ...projectPick, cursor: Math.min(projectPick.cursor + 1, projectPick.options.length - 1) });
        if (key.upArrow || input === "k") return setProjectPick({ ...projectPick, cursor: Math.max(projectPick.cursor - 1, 0) });
        if (key.return) {
          const choice = projectPick.options[projectPick.cursor]!;
          setProjectPick(null);
          onLaunch({ kind: "manual", sessionId: pickerView.session.id, project: choice.project, prId: choice.prId });
          return exit();
        }
        return;
      }
      // Leaving the picker (including its session vanishing mid-choice) drops any open
      // chooser so the next `v` never reopens a stale one for another session.
      if (input === "q" || key.escape || !pickerView) { setProjectPick(null); return setMode("list"); }
      if (input === "n") {
        if (!config) return setNotice("config is unavailable");
        const options = manualProjectCandidates(config.projects.map((p) => p.name), agents);
        if (options.length === 0) return setNotice("no projects configured");
        const prs = pickerView.prs.filter(pr => (pr.state === "open" || pr.state === "draft") && pr.head_branch && !!pr.project_name && options.includes(pr.project_name));
        if (options.length === 1 && prs.length === 0) {
          onLaunch({ kind: "manual", sessionId: pickerView.session.id, project: options[0]! });
          return exit();
        }
        return setProjectPick({ options: [...prs.map(pr => ({ label: `#${pr.number} ${pr.title} · ${pr.project_name}`, project: pr.project_name!, prId: pr.id })), ...options.map(project => ({ label: prs.length ? `fresh workspace · ${project}` : project, project }))], cursor: 0 });
      }
      if (key.downArrow || input === "j") return setAgentCursor((c) => Math.min(c + 1, Math.max(0, agents.length - 1)));
      if (key.upArrow || input === "k") return setAgentCursor((c) => Math.max(c - 1, 0));
      if (input === "e") {
        const a = agents[Math.min(agentCursor, agents.length - 1)];
        if (!a) return;
        const target = resolveEditTarget(agents, a.id, existsSync, {});
        if (!target.ok) {
          if (target.reason === "running") setConfirm({ action: "edit", agentId: a.id, path: a.worktree_path! });
          else setNotice(target.message);
          return;
        }
        onLaunch({ kind: "edit", path: target.path, agentId: a.id });
        return exit();
      }
      if (key.return || input === "o" || input === "v") {
        const a = agents[Math.min(agentCursor, agents.length - 1)];
        if (!a) return;
        const target = agentViewTarget(a, existsSync);
        if (target.kind === "none") {
          setNotice(a.kind === "manual" ? `${a.id} is a manual workspace with no agent output · e to edit` : `agent ${a.id} has no output yet`);
          return;
        }
        if (target.kind === "follow") {
          onLaunch({ kind: "follow", agentId: a.id });
          return exit();
        }
        onLaunch({ kind: "output", ref: target.ref, title: `${a.id} (${a.runtime}:${a.model})` });
        return exit();
      }
      return;
    }

    // Layout/range navigation is independent of the selected session.
    if (input === "s") {
      return setLayout(effectiveLayout === "split" ? "list" : effectiveLayout === "list" ? "insights" : "split");
    }
    if (input === "[" || input === "]") {
      return setRange(current => {
        const index = RANGES.indexOf(current) + (input === "]" ? 1 : -1);
        return RANGES[Math.max(0, Math.min(RANGES.length - 1, index))]!;
      });
    }
    if (input === "t") return setTicketPick({ cursor: 0 });
    if (input === "q") return exit();
    if (input === "C") {
      onLaunch({ kind: "config" });
      exit();
      return;
    }
    if (effectiveLayout === "insights") return;
    // List mode.
    if (key.downArrow || input === "j") {
      const next = rows[Math.min(cursor + 1, rows.length - 1)];
      if (next) setCursorId(next.session.id);
    } else if (key.upArrow || input === "k") {
      const prev = rows[Math.max(cursor - 1, 0)];
      if (prev) setCursorId(prev.session.id);
    } else if (input === "z") {
      setShowArchived((v) => !v);
    } else if (input === "c") {
      runSessionAction(selected, "c");
    } else if (input === "O") {
      onLaunch({ kind: "ops" });
      exit();
    } else if (input === "S") {
      if (!selected) return setNotice("no session selected · c to create one");
      setSessionPick({ sessionId: selected.session.id, cursor: 0 });
    } else if (!selected) {
      return;
    } else if (input === "o" || key.return) {
      // Hand the terminal to the interactive supervisor. Tearing down Ink and
      // launching the session happens in `runDashboard` once this unmounts — we just
      // record which session and exit.
      onLaunch({ kind: "resume", id: selected.session.id });
      exit();
    } else if (input === "v") {
      // Opens even with no agents: the picker is also where `n` starts a manual workspace.
      setPickerId(selected.session.id);
      setAgentCursor(0);
      setProjectPick(null);
      setMode("agents");
    } else if (input === "p") {
      if (selected.prs.length === 0) return setNotice(`${selected.session.id} has no PRs yet`);
      const only = selected.prs.length === 1 ? selected.prs[0]! : null;
      setPrPick({ sessionId: selected.session.id, step: only ? "action" : "target", target: only ? only.id : "all", cursor: 0 });
    } else if (input === "h" || input === "a" || input === "d") {
      runSessionAction(selected, input);

    }
  });

  const confirmText = confirm ? (confirm.action === "readme"
    ? `Generate a README for ${confirm.id} ${confirm.local ? "and save it locally" : `and publish it to ${confirm.label} (private)`}? (y/N)`
    : confirm.action === "edit"
    ? `Agent ${confirm.agentId} is still running. Edit its worktree anyway? (y/N)`
    : confirm.action === "unboot"
      ? `Unboot ${confirm.id}? (y/N)`
    : confirm.action === "steal"
      ? `Steal ${confirm.projects.join(", ")} from ${[...new Set(confirm.holders)].join(", ")}? (y/N)`
    : confirm.action === "delete"
    ? `Delete ${confirm.id} and its worktrees + artifacts? This can't be undone. (y/N)`
    : confirm.action === "restart"
      ? `Restart ${confirm.id}? Restarts the supervisor detached in tmux${confirm.count ? `, revives ${confirm.count} dropped agent(s)` : ""}${confirm.stale ? " · onto new Tack code (stale)" : ""}${confirm.midTurn ? " · interrupts the current turn" : ""}${confirm.planPending ? " · pending plan will be re-presented" : ""}. (y/N)`
    : confirm.action === "unarchive"
      ? `Unarchive ${confirm.id}${confirm.count ? ` and resume ${confirm.count} interrupted agent(s)` : ""}? (y/N)`
      : `Stop ${confirm.id} and its agents? (y/N)`) : null;

  if (bootPick) return <Box flexDirection="column"><Text bold>Boot {bootPick.session} · choose a worktree for {bootPick.groups[0]!.project}</Text>{bootPick.groups[0]!.agents.map((a, i) => <Text key={a.id} color={i === bootPick.cursor ? "cyan" : undefined}>{i === bootPick.cursor ? "❯ " : "  "}{a.id} · {a.worktree_path}</Text>)}<Text dimColor>j/k move · enter choose · esc/q cancel</Text></Box>;

  if (personaPick) return <Box flexDirection="column"><Text bold>Review {personaPick.sessionId}{personaPick.prId ? ` · #${rows.find(r => r.session.id === personaPick.sessionId)?.prs.find(p => p.id === personaPick.prId)?.number ?? "?"}` : ""} · choose a persona</Text>{personaPick.options.map((p, i) => <Text key={p} color={i === personaPick.cursor ? "cyan" : undefined}>{i === personaPick.cursor ? "❯ " : "  "}{p}</Text>)}<Text dimColor>j/k move · enter review · esc/q cancel</Text></Box>;

  const sessionPickView = sessionPick ? rows.find(r => r.session.id === sessionPick.sessionId) : undefined;
  if (sessionPick && sessionPickView) return <Box flexDirection="column"><Text bold>Session actions · {sessionPickView.session.id} · {sessionPickView.session.status}</Text>{SESSION_ACTIONS.map((a, i) => {
    const current = i === sessionPick.cursor;
    const label = a.key === "m" ? `View amendments (${sessionPickView.amendments.length})` : a.key === "h" ? (sessionPickView.session.status === "on_hold" ? "Unhold (turns PR auto-fix on)" : "Hold (turns PR auto-fix off)") : a.key === "a" ? (sessionPickView.session.status === "archived" ? "Unarchive" : "Archive") : a.label;
    const disabled = (a.key === "m" && !sessionPickView.amendments.length) || ((a.key === "r" || a.key === "h") && sessionPickView.session.status === "archived");
    return <Text key={a.key} color={current ? "cyan" : undefined} dimColor={disabled}>{current ? "❯ " : "  "}{a.key}  {label}</Text>;
  })}<Text dimColor>j/k move · enter select · c/m/D/r/b/B/h/x/a/d · esc/q cancel</Text></Box>;
  if (ticketPick) return <Box flexDirection="column"><Text bold>Ticket actions{selected ? ` · ${selected.session.id}` : ""}</Text>{TICKET_ACTIONS.map((a, i) => {
    const current = i === ticketPick.cursor;
    return <Text key={a.key} color={current ? "cyan" : undefined} dimColor={a.key === "o" && !selected?.tickets.length}>{current ? "❯ " : "  "}{a.key}  {a.label}{a.key === "o" ? ` (${selected?.tickets.length ?? 0})` : ""}</Text>;
  })}<Text dimColor>j/k move · enter select · o/t/p · esc/q cancel</Text></Box>;

  if (readmePick?.step === "destination") return <Box flexDirection="column"><Text bold>README actions · {readmePick.sessionId} · publish to</Text>{README_DESTINATIONS.map((d, i) => {
    const current = i === readmePick.cursor;
    return <Text key={d.kind} color={current ? "cyan" : undefined}>{current ? "❯ " : "  "}{d.key}  {d.label}</Text>;
  })}<Text dimColor>j/k move · enter select · a/c/g/l · esc/q cancel</Text></Box>;

  if (readmePick) return <Box flexDirection="column"><Text bold>README actions · {readmePick.sessionId}</Text><Text>{readmePick.url ?? "(not generated yet)"}</Text>{README_ACTIONS.map((a, i) => {
    const current = i === readmePick.cursor;
    return <Text key={a.key} color={current ? "cyan" : undefined} dimColor={a.needsUrl && !readmePick.url}>{current ? "❯ " : "  "}{a.key}  {a.label}</Text>;
  })}<Text dimColor>j/k move · enter select · r/o/c/p · esc/q cancel</Text></Box>;

  const prPickView = prPick ? rows.find((r) => r.session.id === prPick.sessionId) : undefined;
  if (prPick && prPickView) {
    if (prPick.step === "target") {
      const labels = [`All PRs (${prPickView.prs.length})`, ...prPickView.prs.map(prTargetLabel)];
      return <Box flexDirection="column"><Text bold>PR actions · {prPickView.session.id} · choose a target</Text>{labels.map((l, i) => {
        const current = i === prPick.cursor;
        return <Text key={i} color={current ? "cyan" : undefined}>{current ? "❯ " : "  "}{l}</Text>;
      })}<Text dimColor>j/k move · enter choose · esc/q cancel</Text></Box>;
    }
    const pr = prPick.target === "all" ? null : prPickView.prs.find((p) => p.id === prPick.target) ?? null;
    const fixOn = pr ? !!pr.pr_fix_enabled : !!prPickView.session.pr_fix_enabled;
    return <Box flexDirection="column">
      <Text bold>{pr ? `PR actions · #${pr.number ?? "?"} · ${pr.title ?? ""}` : `PR actions · ${prPickView.session.id}`}</Text>
      {pr ? <Text>{pr.url}</Text> : null}
      {PR_ACTIONS.map((a, i) => {
        const current = i === prPick.cursor;
        const label = a.key === "f" ? `Auto-fix: ${fixOn ? "on → turn off" : "off → turn on"}` : a.label;
        return <Text key={a.key} color={current ? "cyan" : undefined} dimColor={a.single && !pr}>{current ? "❯ " : "  "}{a.key}  {label}</Text>;
      })}
      <Text dimColor>j/k move · enter select · o/c/p/R/f · esc/q cancel</Text>
    </Box>;
  }

  if (mode === "agents" && pickerView) {
    return <AgentsPanel view={pickerView} cursor={Math.min(agentCursor, Math.max(0, pickerView.agents.length - 1))} notice={notice} confirmText={confirmText} projectPick={projectPick} />;
  }

  if (mode === "amendments" && pickerView) {
    return (
      <AmendmentsPanel
        view={pickerView}
        cursor={Math.min(amendmentCursor, Math.max(0, pickerView.amendments.length - 1))}
        notice={notice}
      />
    );
  }

  if (mode === "tickets") {
    return (
      <TicketsPanel
        entries={shownTickets}
        total={allTickets.length}
        filter={ticketFilter}
        typing={ticketTyping}
        cursor={ticketCursorIndex(shownTickets, ticketSel)}
        notice={notice}
        jiraUnavailable={jiraUnavailable}
        size={size}
      />
    );
  }

  const totalCost = rows.reduce((sum, v) => sum + v.cost, 0);
  const liveCount = rows.filter((v) => v.live).length;
  const needsCount = rows.filter((v) => v.needsInput).length;

  const footer = confirmText ? [confirmText] : [
    notice,
    ghMissing ? "gh not found — PR status not updating" : "",
    jiraUnavailable ? "jira unavailable — ticket status not updating" : "",
    KEY_HINT,
  ].filter(Boolean);
  const split = effectiveLayout === "split";
  const headerParts = [
    `Tack · ${split ? "" : `${effectiveLayout === "list" ? "list-only" : effectiveLayout} · `}${range} ${showArchived ? "(all)" : "(active)"} · ${rows.length} session${rows.length === 1 ? "" : "s"} · `,
    `${liveCount} live`, " · ", `${workingCount} working`, " · ",
    `${needsCount} need input`, " · ", usd(totalCost), " ", "in flight",
  ];
  // Hard wrapping makes the measured width exact, even when counts/cost grow.
  const headerRows = split ? Math.ceil(Bun.stringWidth(headerParts.join("")) / listWidth) : 1;
  const bodyBudget = dashboardBodyHeight(size.rows, size.columns, footer);
  const budget = Math.max(0, bodyBudget - (headerRows - 1));
  const paneHeight = split ? Math.min(bodyBudget + 1, budget + headerRows) : budget;
  const header = (
    <Text bold wrap={split ? "hard" : "truncate"}>
      {headerParts[0]}<Text color="green">{headerParts[1]}</Text>{headerParts[2]}
      <Text color={workingCount > 0 ? "cyan" : undefined} dimColor={workingCount === 0}>{headerParts[3]}</Text>{headerParts[4]}
      <Text color={needsCount > 0 ? "yellow" : undefined} dimColor={needsCount === 0}>{headerParts[5]}</Text>{headerParts[6]}
      <Text color="green">{headerParts[7]}</Text>{headerParts[8]}<Text dimColor>{headerParts[9]}</Text>
    </Text>
  );
  // Unselected sessions are always exactly one line, so only the cursor's expanded
  // block is built to size the window; every other row is built only if visible.
  const cursorLines = selected ? sessionRowLines(selected, true, frame, config) : [];
  const counts = rows.map((_, i) => (i === cursor ? cursorLines.length : 1));
  const window = windowSessionLines(counts, cursor, budget);
  const visibleLines: React.ReactElement<React.ComponentProps<typeof Text>>[] = [];
  for (let i = 0, offset = 0; i < rows.length && offset < window.end; offset += counts[i]!, i++) {
    if (offset + counts[i]! <= window.start) continue;
    const lines = i === cursor ? cursorLines : sessionRowLines(rows[i]!, false, frame, config);
    visibleLines.push(...lines.slice(Math.max(0, window.start - offset), window.end - offset));
  }

  return (
    <Box flexDirection="column" maxHeight={Math.max(0, size.rows - 1)} overflowY="hidden">
      {!split && header}
      <Box flexDirection="row" height={paneHeight} flexShrink={0} overflowY="hidden">
        {effectiveLayout !== "insights" && (
          <Box width={listWidth} flexShrink={0} flexDirection="column" overflowX="hidden">
            {split && header}
            {rows.length === 0 && <Text dimColor wrap="truncate">No sessions. Press c to create one.</Text>}
            {window.above > 0 && <Text dimColor wrap="truncate">↑ {window.above} more</Text>}
            {visibleLines.map((line, i) => React.cloneElement(line, { key: i, wrap: "truncate" }))}
            {window.below > 0 && <Text dimColor wrap="truncate">↓ {window.below} more</Text>}
          </Box>
        )}
        {effectiveLayout === "split" && (
          <Box width={1} height={paneHeight} marginX={1} flexShrink={0} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderDimColor />
        )}
        {effectiveLayout !== "list" && (
          <Insights stats={stats} width={insightWidth} rows={size.rows} height={paneHeight} full={effectiveLayout === "insights"} />
        )}
      </Box>
      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        {footer.flatMap(line => wrapFooter(line, size.columns)).map((line, i) => <Text key={i} wrap="truncate" color={confirm ? "yellow" : undefined} dimColor={!confirm}>{line}</Text>)}
      </Box>
    </Box>
  );
}

/** The agent picker shows worktree paths alongside output so the human can inspect or
 * edit, and starts manual workspaces (`n`), choosing a project when several qualify. */
function AgentsPanel({ view, cursor, notice, confirmText, projectPick }: {
  view: View; cursor: number; notice: string; confirmText: string | null;
  projectPick: { options: { label: string; project: string; prId?: string }[]; cursor: number } | null;
}) {
  if (projectPick) {
    const own = new Set(view.agents.map((a) => a.project_name));
    return (
      <Box flexDirection="column">
        <Text bold>
          New manual workspace in {view.session.id} <Text dimColor>choose a project</Text>
        </Text>
        {projectPick.options.map((p, i) => (
          <Text key={p.prId ?? p.project}>
            <Text color={i === projectPick.cursor ? "cyan" : undefined}>{i === projectPick.cursor ? "❯ " : "  "}</Text>
            <Text bold>{p.label}</Text>
            {own.has(p.project) && !p.prId ? <Text dimColor> (in this session)</Text> : null}
          </Text>
        ))}
        <Box marginTop={1}>
          <Text dimColor>j/k move · enter create + edit · esc/q cancel</Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>
        Agents of {view.session.id} <Text dimColor>{view.session.title ?? ""}</Text>
      </Text>
      {view.agents.length === 0 && <Text dimColor>No agents. Press n for a manual workspace.</Text>}
      {view.agents.map((a, i) => {
        const display = agentDisplayStatus(a);
        const target = agentViewTarget(a, existsSync);
        return (
          <Text key={a.id}>
            <Text color={i === cursor ? "cyan" : undefined}>{i === cursor ? "❯ " : "  "}</Text>
            <Text bold>{a.id}</Text>
            {a.kind ? <Text color="cyan"> {agentLabel(a, view.prs)}</Text> : null}{" "}
            <Text color={display.color}>{display.label.padEnd(8)}</Text>
            {a.runtime ? (
              <Text dimColor>
                {" "}
                {a.runtime}:{a.model}
              </Text>
            ) : null}
            <Text color="green"> {usd(a.cost)}</Text>
            <Text dimColor> {a.project_name}</Text>
            {target.kind !== "none" ? null : <Text dimColor> (no output)</Text>}
            {a.worktree_path ? <Text dimColor> {collapseHome(a.worktree_path)}</Text> : null}
          </Text>
        );
      })}
      <Box marginTop={1} flexDirection="column">
        {notice ? <Text dimColor>{notice}</Text> : null}
        {confirmText ? <Text color="yellow">{confirmText}</Text> : null}
        <Text dimColor>j/k move · enter/v view output · e edit worktree · n new manual workspace · esc/q back</Text>
      </Box>
    </Box>
  );
}

/** The pending-amendments panel for one session: read each proposal, accept/reject. */
function AmendmentsPanel({ view, cursor, notice }: { view: View; cursor: number; notice: string }) {
  const selected = view.amendments[cursor];
  return (
    <Box flexDirection="column">
      <Text bold>
        Amendments of {view.session.id} <Text dimColor>{view.session.title ?? ""}</Text>
      </Text>
      {view.amendments.length === 0 && <Text dimColor>No pending amendments.</Text>}
      {view.amendments.map((am, i) => (
        <Text key={am.id}>
          <Text color={i === cursor ? "cyan" : undefined}>{i === cursor ? "❯ " : "  "}</Text>
          <Text bold>{am.id}</Text>
          <Text dimColor> by {am.proposed_by}</Text>
        </Text>
      ))}
      {selected ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Proposal {selected.id}:</Text>
          <Text>{readArtifact(selected.proposal_ref).trim() || "(empty proposal)"}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {notice ? <Text dimColor>{notice}</Text> : null}
        <Text dimColor>the supervisor adjudicates these · j/k move · esc/q back</Text>
      </Box>
    </Box>
  );
}

/** One (session, ticket) pair in the cross-session tickets view. A key linked to
 * several sessions gets one entry per session, since each is separate work.
 * `session` comes from the history query, so every entry has it; `view` is the
 * live dashboard row, present only while that session is on the main list. */
export interface TicketEntry {
  ticket: SessionJiraTicketRow;
  session: { id: string; title: string | null; status: SessionRow["status"]; created_at: string };
  view?: View;
}

/** Stable identity for a tickets-view entry across snapshots. */
function ticketEntryId(e: TicketEntry): string {
  return `${e.session.id}:${e.ticket.id}`;
}

/** Content fingerprint of the ticket history, so the 1s read only re-renders on a
 * visible change (a link, a status refresh, a session archived or retitled). */
function ticketsSignature(tickets: readonly JiraTicketWithSessionRow[]): string {
  return tickets
    .map((t) => `${t.id}/${t.session_status}/${t.session_title ?? ""}/${t.status ?? ""}/${t.status_category ?? ""}/${t.title ?? ""}/${t.url ?? ""}`)
    .join("|");
}

/** Open work first — in progress before to do — then done. */
function ticketSortWeight(category: string | null): number {
  if (category === "indeterminate") return 0;
  if (category === "done") return 2;
  return 1;
}

/** Every ticket in the history as a view entry, open work first and, inside each
 * status group, the newest link first. Sessions on screen get their live `View`
 * (for the needs-input/working/live badge); the rest render from the joined row. */
export function ticketEntries(tickets: readonly JiraTicketWithSessionRow[], rows: readonly View[]): TicketEntry[] {
  const views = new Map(rows.map((v) => [v.session.id, v]));
  return tickets
    .map(({ session_title, session_status, session_created_at, ...ticket }) => ({
      ticket,
      session: { id: ticket.session_id, title: session_title, status: session_status, created_at: session_created_at },
      view: views.get(ticket.session_id),
    }))
    .sort(
      (a, b) =>
        ticketSortWeight(a.ticket.status_category) - ticketSortWeight(b.ticket.status_category) ||
        b.ticket.created_at.localeCompare(a.ticket.created_at),
    );
}

/** The `f` cycle, in order. Buckets use Jira's stable status category, like the
 * glyphs: `indeterminate` = in progress, `new`/unknown = to do, `done` = done. */
export const TICKET_STATUS_FILTERS = ["all", "open", "in_progress", "todo", "done"] as const;
export type TicketStatusFilter = (typeof TICKET_STATUS_FILTERS)[number];

export interface TicketFilter {
  status: TicketStatusFilter;
  /** `a`: drop tickets whose session is archived (shown by default). */
  hideArchived: boolean;
  /** `/`: case-insensitive substring over ticket key/title and session id/title. */
  text: string;
}

export const DEFAULT_TICKET_FILTER: TicketFilter = { status: "all", hideArchived: false, text: "" };

export function nextTicketStatusFilter(current: TicketStatusFilter): TicketStatusFilter {
  return TICKET_STATUS_FILTERS[(TICKET_STATUS_FILTERS.indexOf(current) + 1) % TICKET_STATUS_FILTERS.length]!;
}

function matchesTicketStatus(category: string | null, status: TicketStatusFilter): boolean {
  switch (status) {
    case "all": return true;
    case "open": return category !== "done";
    case "in_progress": return category === "indeterminate";
    case "todo": return category !== "done" && category !== "indeterminate";
    case "done": return category === "done";
  }
}

/** Narrow entries by the view's filters, keeping their order. */
export function filterTicketEntries(entries: readonly TicketEntry[], filter: TicketFilter): TicketEntry[] {
  const needle = filter.text.trim().toLowerCase();
  return entries.filter((e) => {
    if (!matchesTicketStatus(e.ticket.status_category, filter.status)) return false;
    if (filter.hideArchived && e.session.status === "archived") return false;
    if (!needle) return true;
    return [e.ticket.key, e.ticket.title, e.session.id, e.session.title].some((field) => field?.toLowerCase().includes(needle));
  });
}

const TICKET_STATUS_LABELS: Record<TicketStatusFilter, string> = {
  all: "all", open: "open", in_progress: "in progress", todo: "to do", done: "done",
};

/** The active filters for the header, e.g. `status: open · archived hidden · "X"`; empty when none. */
export function describeTicketFilters(filter: TicketFilter): string {
  const parts: string[] = [];
  if (filter.status !== "all") parts.push(`status: ${TICKET_STATUS_LABELS[filter.status]}`);
  if (filter.hideArchived) parts.push("archived hidden");
  if (filter.text.trim()) parts.push(JSON.stringify(filter.text.trim()));
  return parts.join(" · ");
}

/** The pinned entry when it still exists, else the remembered index clamped. */
function ticketCursorIndex(entries: readonly TicketEntry[], sel: { id: string | null; index: number }): number {
  const pinned = sel.id ? entries.findIndex((e) => ticketEntryId(e) === sel.id) : -1;
  return pinned >= 0 ? pinned : Math.max(0, Math.min(sel.index, entries.length - 1));
}

/** The notice for an on-demand Jira poll. A missing `jira` block reads as "not
 * configured" rather than "unavailable", which would send the human hunting for
 * an auth problem that doesn't exist. Skips list a few keys, then a count. */
export function describeJiraPoll(config: TackConfig, res: JiraRefreshResult): string {
  if (res.unavailable) {
    return config.jira
      ? "Jira unavailable — check the jira config / Atlassian MCP auth"
      : "Jira isn't configured — add a `jira` block to your Tack config";
  }
  const skippedKeys = new Set(res.skipped.map((s) => s.key));
  const refreshed = new Set(res.tickets.map((t) => t.key).filter((k) => !skippedKeys.has(k))).size;
  let text = `Jira: refreshed ${refreshed} ticket(s)`;
  if (res.skipped.length > 0) {
    const shown = res.skipped.slice(0, 3).map((s) => `${s.key}: ${s.reason}`);
    const more = res.skipped.length - shown.length;
    text += ` · ${res.skipped.length} skipped (${shown.join(", ")}${more > 0 ? `, +${more} more` : ""})`;
  }
  return text;
}

/** Compact session state for a tickets-view row, in the main list's colors. */
function sessionBadge(v: View): React.ReactElement {
  if (v.needsInput) return <Text color="yellow">◆ needs input</Text>;
  if (v.working) return <Text color="cyan">working</Text>;
  if (v.live) return <Text color="green">● live</Text>;
  if (v.active) return <Text color="green">● agents running</Text>;
  return <Text color="gray">○ <Text dimColor>{v.session.status}</Text></Text>;
}

/** A tickets-view row's session state: the live badge while the session is on the
 * main list, else a static one from its stored status. An archived session that is
 * still live (or waiting on you) keeps a dim `archived` marker beside its badge. */
function ticketSessionBadge(e: TicketEntry): React.ReactElement {
  const marker = e.session.status === "archived" ? "archived" : e.session.status === "on_hold" ? "on hold" : null;
  if (e.view && (e.view.needsInput || e.view.working || e.view.active)) {
    return <Text>{sessionBadge(e.view)}{marker ? <Text dimColor> {marker}</Text> : null}</Text>;
  }
  return <Text color="gray">○ <Text dimColor>{e.session.status === "on_hold" ? "on hold" : e.session.status}</Text></Text>;
}

const TICKETS_HINT = "j/k move · enter/o open ticket · g go to session · f status · a archived · / search · P poll Jira · esc/q back";
const TICKETS_TYPING_HINT = "type to filter · enter keep · esc clear";

/** Every Jira ticket linked to any existing session — archived ones included, and
 * independent of the main list's `z` — one row per (session, ticket), narrowed by
 * the view's own filters. Rows truncate to one line each and window around the
 * cursor inside the same body budget as the main list, so the panel fits the terminal. */
function TicketsPanel({ entries, total, filter, typing, cursor, notice, jiraUnavailable, size }: {
  entries: TicketEntry[]; total: number; filter: TicketFilter; typing: boolean; cursor: number;
  notice: string; jiraUnavailable: boolean; size: { columns: number; rows: number };
}) {
  const sessions = new Set(entries.map((e) => e.session.id)).size;
  const done = entries.filter((e) => e.ticket.status_category === "done").length;
  const filters = describeTicketFilters(filter);
  const footer = [
    notice,
    jiraUnavailable ? "jira unavailable — ticket status not updating" : "",
    typing ? `/${filter.text}▏  ${TICKETS_TYPING_HINT}` : TICKETS_HINT,
  ].filter(Boolean);
  const budget = dashboardBodyHeight(size.rows, size.columns, footer);
  const window = windowSessionLines(entries.map(() => 1), cursor, budget);
  return (
    <Box flexDirection="column" maxHeight={Math.max(0, size.rows - 1)} overflowY="hidden">
      <Text bold wrap="truncate">
        Jira tickets · {entries.length} of {total} · {sessions} session{sessions === 1 ? "" : "s"}
        {" · "}<Text color={done > 0 ? "green" : undefined} dimColor={done === 0}>{done} done</Text>
        {filters ? <Text color="cyan">{" · "}{filters}</Text> : null}
      </Text>
      <Box flexDirection="column" height={budget} flexShrink={0} overflowY="hidden">
        {total === 0 && <Text dimColor wrap="truncate">No Jira tickets linked to any session.</Text>}
        {total > 0 && entries.length === 0 && <Text dimColor wrap="truncate">No tickets match the filters.</Text>}
        {window.above > 0 && <Text dimColor wrap="truncate">↑ {window.above} more</Text>}
        {entries.slice(window.start, window.end).map((e, offset) => {
          const i = window.start + offset;
          const { glyph, color } = ticketStatusDisplay(e.ticket.status_category);
          return (
            <Text key={ticketEntryId(e)} wrap="truncate">
              <Text color={i === cursor ? "cyan" : undefined}>{i === cursor ? "❯ " : "  "}</Text>
              <Text bold>{e.ticket.key}</Text>{" "}
              <Text color={color}>{glyph} {e.ticket.status ?? "?"}</Text>
              {e.ticket.title ? <Text dimColor>{"  "}{oneLine(e.ticket.title, 60)}</Text> : null}
              {"  "}<Text>{e.session.id}</Text>{" "}
              {ticketSessionBadge(e)}
              {e.session.title ? <Text dimColor>{"  "}{oneLine(e.session.title, 40)}</Text> : null}
            </Text>
          );
        })}
        {window.below > 0 && <Text dimColor wrap="truncate">↓ {window.below} more</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        {footer.flatMap((line) => wrapFooter(line, size.columns)).map((line, i) => <Text key={i} wrap="truncate" dimColor>{line}</Text>)}
      </Box>
    </Box>
  );
}

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Compact duration of the supervisor's current turn, refreshed by spinner ticks. */
function turnElapsed(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

/** A coarse "N ago" from an ISO-UTC timestamp, for the live activity line. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/** First non-empty line of a string, truncated with an ellipsis. */
function oneLine(s: string, max: number): string {
  const line = s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Makes sure every active session with an open PR has a live PR watcher — the
 * restart path for watchers that exited (crash, reboot, `tack session stop`) or
 * sessions whose PRs predate PR watch. Best-effort and cheap: a pid liveness check
 * per session, and `spawnPrWatcher` is itself a no-op when disabled/already alive.
 */
function ensurePrWatchers(config: TackConfig, sessionIds: string[]): void {
  if (!config.prWatch.enabled) return;
  for (const id of sessionIds) {
    const s = getSession(id);
    if (!s || !isSessionOpen(s) || isAlive(s.pr_watch_pid)) continue;
    if (!(listSessionPrs(id).some(isWatchablePr) || hasUnresolvedDependencies(id))) continue;
    try {
      spawnPrWatcher(id, config);
    } catch {
      /* try again next refresh */
    }
  }
}

/** The dashboard's name for an agent row: "Agent", `manual` for a human workspace, or
 * `pr-fix #<n>` for a PR-watch fix agent so it's obvious which PR it's working on. */
function agentLabel(a: AgentRow, prs: SessionPrRow[]): string {
  if (a.kind === "manual") { const pr = prs.find(p => p.id === a.session_pr_id); return pr ? `manual → #${pr.number}` : "manual"; }
  if (a.kind === "review") return `review:${a.persona ?? "?"}`;
  if (a.kind !== "pr_fix") return "Agent";
  const pr = prs.find((p) => p.id === a.session_pr_id);
  return `pr-fix #${pr?.number ?? "?"}`;
}

/** Glyph + color shared by both PR render sites (expanded row, collapsed roll-up)
 *  so a given state always reads the same way. */
function prStateDisplay(state: string | null): { glyph: string; color: string; label: string } {
  if (state === "merged") return { glyph: "✔", color: "magenta", label: "merged" };
  if (state === "open") return { glyph: "●", color: "green", label: "open" };
  if (state === "draft") return { glyph: "◌", color: "gray", label: "draft" };
  if (state === "closed") return { glyph: "✖", color: "red", label: "closed" };
  return { glyph: "·", color: "gray", label: state ?? "" };
}

export interface PrBadgeDisplay { glyph: string; color: string; label: string; dim?: boolean }

export function prCiDisplay(status: PrCiStatus | null): PrBadgeDisplay | null {
  if (status === "passing") return { glyph: "✔", color: "green", label: "passing" };
  if (status === "failing") return { glyph: "✖", color: "red", label: "failing" };
  if (status === "pending") return { glyph: "◌", color: "yellow", label: "pending" };
  if (status === "none") return { glyph: "–", color: "gray", label: "none", dim: true };
  return null;
}

export function prReviewDisplay(status: PrReviewStatus | null): PrBadgeDisplay | null {
  if (status === "approved") return { glyph: "✔", color: "green", label: "approved" };
  if (status === "changes_requested") return { glyph: "✖", color: "red", label: "changes requested" };
  if (status === "review_required") return { glyph: "◌", color: "yellow", label: "review required" };
  if (status === "none") return { glyph: "–", color: "gray", label: "no reviews", dim: true };
  return null;
}

/** Real merge conflicts, per GitHub's mergeability (refreshed by the PR poll) — not
 *  predicted cross-agent file collisions, so the badge clears once the PR's conflicts
 *  are resolved. Only open/draft PRs count: a merged or closed PR's status is moot. */
function prHasConflicts(pr: SessionPrRow): boolean {
  return pr.mergeable === "CONFLICTING" &&(pr.state === "open" || pr.state === "draft");
}

/** Compact per-session PR summary for the collapsed session line: all merged gets
 *  the confident magenta badge, a mix gets a neutral yellow fraction, and none
 *  merged yet is just a dim count — distinct from "gh not found" (see `ghMissing`). */
function prRollup(prs: SessionPrRow[]): React.ReactElement {
  const merged = prs.filter((pr) => pr.state === "merged").length;
  const total = prs.length;
  if (merged === total) return <Text color="magenta">✔ {merged} merged</Text>;
  if (merged > 0) return <Text color="yellow">{`${merged}/${total} merged`}</Text>;
  return <Text dimColor>{`${total} PR${total === 1 ? "" : "s"}`}</Text>;
}

/** Glyph + color for a ticket, keyed on Jira's stable status *category* rather than
 *  the per-project workflow name ("In Review", "QA", …), so every project's tickets
 *  read the same way: to do = gray ○, in progress = yellow ●, done = green ✔
 *  (green, not PR-merged magenta, so "ticket done" and "PR merged" stay distinct). */
function ticketStatusDisplay(category: string | null): { glyph: string; color: string } {
  if (category === "done") return { glyph: "✔", color: "green" };
  if (category === "indeterminate") return { glyph: "●", color: "yellow" };
  if (category === "new") return { glyph: "○", color: "gray" };
  return { glyph: "·", color: "gray" };
}

/** Compact per-session ticket summary for the collapsed line, mirroring `prRollup`:
 *  all done is the green badge, some done a yellow fraction, none a dim count. */
function ticketRollup(tickets: SessionJiraTicketRow[]): React.ReactElement {
  const done = tickets.filter((t) => t.status_category === "done").length;
  const total = tickets.length;
  if (done === total) return <Text color="green">✔ {done} done</Text>;
  if (done > 0) return <Text color="yellow">{`${done}/${total} done`}</Text>;
  return <Text dimColor>{`${total} ticket${total === 1 ? "" : "s"}`}</Text>;
}

// Alternate-screen-buffer controls: the dashboard renders on its own full screen and
// restores the prior terminal contents (scrollback intact) on exit. Ink has no
// built-in alt-screen, so we drive the escape sequences ourselves.
const ALT_SCREEN_ENTER = "[?1049h";
const ALT_SCREEN_EXIT = "[?1049l";

/** The pager invocation for viewing an agent's output file on the normal screen,
 * honoring $PAGER and defaulting to `less -R` (so ANSI in the output renders). */
function pagerInvocation(ref: string): { command: string; args: string[] } {
  const raw = process.env.PAGER?.trim();
  const parts = raw ? raw.split(/\s+/) : ["less", "-R"];
  return { command: parts[0]!, args: [...parts.slice(1), ref] };
}

/**
 * Renders the live dashboard on a full-screen alternate buffer, resolving when the
 * user quits. Leaving the dashboard hands the terminal to a child on the normal
 * screen (so it keeps real scrollback), then re-enters the dashboard when the child
 * exits. Hand-offs: enter/o resumes the selected session's supervisor (and
 * stamps `last_seen_at` so its "needs input" badge clears), c creates a fresh one,
 * v follows live agents or pages their output, e edits a worktree, n creates a manual workspace and edits
 * it, and C edits config then refreshes
 * sessions onto the validated config.
 */
export async function runDashboard(): Promise<void> {
  let config = await loadConfig().catch(() => null);
  let pendingNotice = "";
  for (;;) {
    let launch: Launch | undefined;
    process.stdout.write(ALT_SCREEN_ENTER);
    try {
      const app = render(<Dashboard config={config} initialNotice={pendingNotice} onLaunch={(l) => (launch = l)} />);
      await app.waitUntilExit();
    } finally {
      // Always restore the normal screen — whether quitting, opening a session, or
      // if render throws — so we never strand the terminal in the alt buffer.
      process.stdout.write(ALT_SCREEN_EXIT);
    }
    if (!launch) {
      // Quit, not a hand-off: reap the Jira MCP server subprocess (if one was
      // started) so it doesn't outlive the dashboard.
      await closeJiraClient();
      return;
    }

    // Fully relinquish stdin before handing the terminal to the child. Ink turns raw
    // mode off and `unref`s stdin on unmount, but never *pauses* the stream — so this
    // process keeps reading the shared TTY. That races the child for input: the first
    // keypress meant for the child gets stolen here, and the child (e.g. a tmux
    // client), seeing its terminal input yanked away, detaches back to the dashboard.
    // Pausing stops our read so the child owns the terminal; Ink re-arms stdin when
    // the dashboard re-renders after the child exits.
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* stdin may not support raw mode in every environment */
      }
    }
    process.stdin.pause();

    if (launch.kind === "config") {
      ensureConfigExists();
      const before = currentConfigVersion();
      const { command, args } = editorInvocation(CONFIG_PATH);
      await Bun.spawn([command, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
      if (currentConfigVersion() === before) {
        pendingNotice = "config unchanged";
        continue;
      }
      let newConfig: TackConfig;
      try {
        newConfig = await loadConfig();
      } catch (err) {
        pendingNotice = `config has errors: ${err instanceof Error ? err.message : String(err)} — sessions not refreshed`;
        continue;
      }
      config = newConfig;
      console.log("Refreshing sessions onto new config…");
      const results = await refreshAllStaleSessions(config);
      const count = (status: string) => results.filter(result => result.status === status).length;
      const blocked = count("blocked");
      const failed = count("error");
      pendingNotice = `config saved · refreshed ${count("refreshed")} session(s)`
        + (blocked ? ` · ${blocked} blocked (restart with r)` : "")
        + (failed ? ` · ${failed} failed` : "");
      continue;
    }

    if (launch.kind === "manual") {
      // Created here, on the normal screen, so the fetch's wait is visible; then it
      // takes exactly the `e` path below.
      console.log(`Creating a manual workspace for ${launch.project}…`);
      try {
        if (!config) throw new Error("config is unavailable");
        const prId = launch.prId;
        const pr = prId ? listSessionPrs(launch.sessionId).find(p => p.id === prId) : undefined;
        if (prId && !pr) throw new Error("The selected PR no longer exists");
        const created = createManualWorkspace(config, launch.sessionId, launch.project, pr);
        launch = { kind: "edit", path: created.worktree_path!, agentId: created.id };
        pendingNotice = `manual workspace ${created.id} · ${collapseHome(created.worktree_path!)}`;
      } catch (err) {
        pendingNotice = `could not create a manual workspace: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }
    }

    // Runs on the normal screen so the child keeps real scrollback.
    const { command, args } =
      launch.kind === "output"
        ? pagerInvocation(launch.ref)
        : launch.kind === "edit"
          ? editorInvocation(".")
        : launch.kind === "follow"
          ? selfCommand(["session", "follow", launch.agentId])
        : dashboardLaunchCommand(launch);
    const proc = Bun.spawn([command, ...args], {
      cwd: launch.kind === "edit" ? launch.path : undefined,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    if (launch.kind === "edit") {
      const agent = getAgent(launch.agentId);
      if (agent) {
        try { worktreeEditSummary(agent, listSessionPrs(agent.session_id), launch.path).forEach(line => console.log(line)); }
        catch (err) { console.error(`Could not summarize the worktree: ${(err as Error).message}`); }
      }
      if (config?.dashboard.shellAfterEdit !== false) {
        console.log(`Shell in ${collapseHome(launch.path)} — commit/push with git; exit to return to the dashboard`);
        await Bun.spawn([process.env.SHELL || "/bin/sh"], { cwd: launch.path, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
      }
    }
  }
}

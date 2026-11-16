import { startBaseCacheRefresher } from "../worktree/base-cache";
import { startRemoteReview } from "../session/review";
import { setPrFix } from "../session/pr-fix";
import React, { useEffect, useRef, useState } from "react";
import { existsSync } from "node:fs";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import {
  countOpenPrFeedback,
  getSession,
  listAgents,
  listInterruptedAgents,
  listPendingAmendments,
  listSessionJiraTickets,
  listSessionPrs,
  listSessions,
  sessionTotalCost,
  type AgentRow,
  type AmendmentRow,
  type SessionJiraTicketRow,
  type SessionPrRow,
  type SessionRow,
} from "../db";
import { agentDisplayStatus, sessionLive, sessionNeedsInput, sessionWorking } from "./liveness";
import { REFRESH_MESSAGE, isSessionStale, refreshAllStaleSessions, refreshSession } from "../session/refresh";
import { describeReconnect, parkReconnectedSupervisor, reconnectSession, selectAgentsToRevive } from "../session/reconnect";
import { archiveSession, deleteSession, stopSession, unarchiveSession } from "../session/lifecycle";
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
  prs: SessionPrRow[];
  /** JIRA tickets the supervisor linked to this session (track-only). */
  tickets: SessionJiraTicketRow[];
  cost: number;
  live: boolean;
  working: boolean;
  stale: boolean;
  needsInput: boolean;
  /** Pending amendment proposals awaiting the human's adjudication. */
  amendments: AmendmentRow[];
  /** PR-watch state per session PR id: comments Tack hasn't finished with yet, and
   * whether a pr_fix agent is currently working on the PR. */
  prWatch: Record<string, { openFeedback: number; fixing: boolean }>;
}

/** Sort weight: sessions waiting on the human float to the top, then live ones, so
 * the state that actually needs you is never scrolled off. Equal weights keep the
 * `listSessions` order (created_at DESC), which `Array.prototype.sort` preserves. */
function rank(v: View): number {
  return (v.needsInput ? 2 : 0) + (v.live ? 1 : 0);
}

function snapshot(showArchived: boolean): View[] {
  return listSessions(showArchived)
    .map((session) => {
      const agents = listAgents(session.id);
      const prs = listSessionPrs(session.id);
      return {
        session,
        agents,
        prs,
        tickets: listSessionJiraTickets(session.id),
        cost: sessionTotalCost(session.id).total,
        live: sessionLive(session),
        working: sessionWorking(session),
        stale: isSessionStale(session).stale,
        // Waiting on the human: a plan to approve, or unread completed agent work
        // once nothing is still in flight.
        needsInput: sessionNeedsInput(session, agents),
        amendments: listPendingAmendments(session.id),
        prWatch: Object.fromEntries(
          prs.map((pr) => [
            pr.id,
            {
              openFeedback: countOpenPrFeedback(pr.id),
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
    .sort((a, b) => rank(b) - rank(a));
}

/** A cheap content fingerprint of the whole view, so the 1s poll only re-renders
 * when something a human would see actually changed — not every tick regardless. */
function signature(views: View[]): string {
  return views
    .map(
      (v) =>
        `${v.session.id}:${v.session.pr_fix_enabled}:${v.stale}:${v.session.status}:${v.session.title ?? ""}:${v.cost}:${v.live ? 1 : 0}:${v.working ? 1 : 0}:${v.session.supervisor_turn_started_at ?? ""}:${v.needsInput ? 1 : 0}:${v.amendments.length}:` +
        v.agents
          .map((a) => `${a.id}/${a.status}/${a.post_fixed_at ?? ""}/${a.fix_outcome ?? ""}/${a.cost}/${a.activity ?? ""}/${a.error ?? ""}`)
          .join(",") +
        ";" +
        v.prs
          .map((p) => {
            const w = v.prWatch[p.id];
            return `${p.number}/${p.state}/${p.mergeable ?? ""}/${w?.openFeedback ?? 0}/${w?.fixing ? 1 : 0}`;
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

/** Opens a URL in the user's default browser — fire-and-forget, no terminal needed. */
function openUrl(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    /* no opener available — the URL is still visible on screen to copy */
  }
}

/** What the human asked for by leaving the dashboard: open the highlighted session,
 *  create a new one, page through output, or edit an agent's worktree. */
type Launch =
  | { kind: "resume"; id: string; message?: string }
  | { kind: "edit"; path: string; agentId: string }
  /** Create a manual workspace, then edit it exactly like `edit`. Created after Ink
   * tears down: the worktree fetch can take seconds and must not freeze the UI. */
  | { kind: "manual"; sessionId: string; project: string }
  | { kind: "create" }
  | { kind: "config" }
  | { kind: "output"; ref: string; title: string }
  | { kind: "follow"; agentId: string };

/** A pending yes/no confirmation for stopping, deleting, or restoring work. */
type Confirm =
  | { action: "delete" | "stop" | "refresh"; id: string }
  | { action: "edit"; agentId: string; path: string }
  | { action: "unarchive"; id: string; count: number }
  | { action: "reconnect"; id: string; count: number; planPending: boolean };

const KEY_HINT = "s layout · [/] range · j/k move · enter/o open · v agents/output · m amendments · O open PR · p poll PRs · R review · F auto-fix · J open tickets · t tickets · P poll Jira · c new · C config · r refresh · w reconnect · x stop · a archive/unarchive · d delete · z archived · q quit";

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
  /** Persona chooser for the selected session. */
  const [personaPick, setPersonaPick] = useState<{ options: string[]; cursor: number; sessionId: string } | null>(null);
  /** The `n` project chooser inside the agents picker; null when not choosing. */
  const [projectPick, setProjectPick] = useState<{ options: string[]; cursor: number } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [sessionRefreshing, setSessionRefreshing] = useState(false);
  const [notice, setNotice] = useState(initialNotice);
  const [ghMissing, setGhMissing] = useState(false);
  const [jiraUnavailable, setJiraUnavailable] = useState(false);

  const cursor = Math.max(0, rows.findIndex((r) => r.session.id === cursorId));
  const selected = rows[cursor] as View | undefined;
  const pickerView = rows.find((r) => r.session.id === pickerId);

  const sigRef = useRef("");
  const refresh = () => {
    const next = snapshot(showArchived);
    sigRef.current = signature(next);
    setRows(next);
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
      const ids = rowsRef.current.map((v) => v.session.id);
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
    const run = () => pollJira(config, rowsRef.current.map((v) => v.session.id), false);
    run();
    const t = setInterval(run, 120_000);
    return () => {
      clearInterval(t);
      void closeJiraClient();
    };
  }, [config]);

  useInput((input, key) => {
    // Quit is the one gesture that works from everywhere.
    if (key.ctrl && input === "c") return exit();

    if (sessionRefreshing) return;

    // A pending confirmation swallows the next keypress: y commits, anything
    // else cancels (stop/delete also accept enter). Keeps a stray `d` from deleting a session's
    // worktrees and artifacts irreversibly.
    if (confirm) {
      if (input === "y" || input === "Y" || (key.return && (confirm.action === "delete" || confirm.action === "stop"))) {
        if (confirm.action === "edit") {
          onLaunch({ kind: "edit", path: confirm.path, agentId: confirm.agentId });
          setConfirm(null);
          return exit();
        } else if (confirm.action === "refresh") {
          const id = confirm.id;
          setConfirm(null);
          if (!config) { setNotice("Configuration unavailable"); return; }
          setSessionRefreshing(true);
          setNotice(`refreshing ${id}…`);
          void refreshSession(id, config).then(result => {
            if (result.blocked) setNotice(`refresh blocked: ${result.blocked}`);
            else if (result.refreshed) {
              onLaunch({ kind: "resume", id, message: REFRESH_MESSAGE });
              exit();
            } else setNotice(`${id}: ${result.refreshed ? "watcher refreshed" : "already current"}`);
          }).catch(err => setNotice(`refresh failed: ${err.message}`)).finally(() => { setSessionRefreshing(false); refresh(); });
          return;
        } else if (confirm.action === "reconnect") {
          // Runs in the background and keeps the dashboard open: the replacement
          // supervisor is parked in tmux rather than launched in the foreground,
          // so enter attaches when the user wants the conversation. The busy flag
          // covers stopping the old TUI, which can take a couple of seconds.
          const id = confirm.id;
          setConfirm(null);
          if (!config) { setNotice("Configuration unavailable"); return; }
          setSessionRefreshing(true);
          setNotice(`reconnecting ${id}…`);
          void (async () => {
            const result = await reconnectSession(id, config);
            const park = await parkReconnectedSupervisor(id, config);
            const summary = `${id}: ${describeReconnect(result)}`;
            if (park.parked) setNotice(`${summary} · parked in tmux · enter to attach`);
            else if (park.reason === "no-resume-ref") setNotice(`${summary} · no resume handle yet — it never got far enough to follow up on`);
            else if (park.reason === "no-tmux") setNotice(`${summary} · tmux unavailable, supervisor stopped · enter to resume`);
            else setNotice(`${summary} · could not park in tmux · enter to resume`);
          })().catch(err => setNotice(`reconnect failed: ${err.message}`)).finally(() => { setSessionRefreshing(false); refresh(); });
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
      const entries = ticketEntries(rows);
      const index = ticketCursorIndex(entries, ticketSel);
      const entry = entries[index];
      const move = (next: number) => {
        const target = entries[Math.max(0, Math.min(next, entries.length - 1))];
        if (target) setTicketSel({ id: ticketEntryId(target), index: Math.max(0, Math.min(next, entries.length - 1)) });
      };
      if (input === "q" || key.escape) return setMode("list");
      if (key.downArrow || input === "j") return move(index + 1);
      if (key.upArrow || input === "k") return move(index - 1);
      if (input === "P") return startJiraPoll();
      if (!entry) return;
      if (key.return || input === "o") {
        const url = resolveTicketUrl(config, entry.ticket);
        if (!url) return setNotice(`can't open ${entry.ticket.key}: no Jira site is configured — add a \`jira\` block (siteUrl) to your Tack config`);
        openUrl(url);
        return setNotice(`opened ${entry.ticket.key} in browser`);
      }
      if (input === "g") {
        setCursorId(entry.view.session.id);
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
          const review = startRemoteReview(config, personaPick.sessionId, { persona: personaPick.options[personaPick.cursor]! });
          setNotice(`started ${review.reviews.length} review(s)`); refresh();
        } catch (err) { setNotice(`review failed: ${(err as Error).message}`); }
        setPersonaPick(null);
      }
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
          const project = projectPick.options[projectPick.cursor]!;
          setProjectPick(null);
          onLaunch({ kind: "manual", sessionId: pickerView.session.id, project });
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
        if (options.length === 1) {
          onLaunch({ kind: "manual", sessionId: pickerView.session.id, project: options[0]! });
          return exit();
        }
        return setProjectPick({ options, cursor: 0 });
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
    // Cross-session Jira: independent of the selected session, so they work with an
    // empty list and in the full-screen insights layout too.
    if (input === "t") {
      setTicketSel({ id: null, index: 0 });
      return setMode("tickets");
    }
    if (input === "P") return startJiraPoll();
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
      // Same hand-off as opening a session, but for a brand-new one — works even
      // with zero sessions, which is exactly when this is most useful.
      onLaunch({ kind: "create" });
      exit();
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
    } else if (input === "m") {
      if (selected.amendments.length === 0) {
        setNotice(`${selected.session.id} has no pending amendments`);
        return;
      }
      setPickerId(selected.session.id);
      setAmendmentCursor(0);
      setMode("amendments");
    } else if (input === "O") {
      if (selected.prs.length === 0) {
        setNotice(`${selected.session.id} has no PRs yet`);
        return;
      }
      for (const pr of selected.prs) openUrl(pr.url);
      setNotice(`opened ${selected.prs.length} PR${selected.prs.length === 1 ? "" : "s"} in browser`);
    } else if (input === "F") {
      if (!config) return setNotice("config is unavailable");
      const id = selected.session.id;
      const enabled = !selected.session.pr_fix_enabled;
      void setPrFix(id, enabled, config).then(() => setNotice(`PR auto-fix ${enabled ? "on" : "off"} for ${id}`)).catch(err => setNotice(`PR auto-fix failed: ${(err as Error).message}`)).finally(refresh);
    } else if (input === "p") {
      if (!config) return setNotice("config is unavailable");
      const id = selected.session.id;
      setNotice(`polling PRs for ${id}…`);
      void triggerPrWatch(id, config).then((result) => {
        switch (result.kind) {
          case "disabled": setNotice("PR watch is disabled"); break;
          case "inactive": setNotice(`${id} is not active`); break;
          case "no-open-prs": setNotice(`${id} has no open PRs (statuses refreshed)`); break;
          case "signalled":
          case "started": setNotice(`polling PRs for ${id} · ${result.kind} watcher pid ${result.pid}`); break;
        }
      }).catch((err) => {
        setNotice(`PR poll failed: ${(err as Error).message}`);
      }).finally(refresh);
    } else if (input === "J") {
      const id = selected.session.id;
      const total = selected.tickets.length;
      if (total === 0) return setNotice(`${id} has no tickets yet`);
      // Without a stored url or a `jira` siteUrl a ticket has nowhere to link.
      const urls = selected.tickets.map((t) => resolveTicketUrl(config, t)).filter((u): u is string => Boolean(u));
      if (urls.length === 0) {
        return setNotice(`${id} has ${total} ticket${total === 1 ? "" : "s"} but no Jira site is configured — add a \`jira\` block (siteUrl) to your Tack config`);
      }
      for (const url of urls) openUrl(url);
      const skipped = total - urls.length;
      setNotice(`opened ${urls.length} ticket${urls.length === 1 ? "" : "s"} in browser${skipped ? ` · ${skipped} without a link (no jira siteUrl)` : ""}`);
    } else if (input === "r") {
      setConfirm({ action: "refresh", id: selected.session.id });
    } else if (input === "w") {
      // "wake": recover a session the laptop's sleep or a network drop broke.
      const s = selected.session;
      if (s.status === "archived") return setNotice(`${s.id} is archived · a to unarchive`);
      setConfirm({ action: "reconnect", id: s.id, count: selectAgentsToRevive(listAgents(s.id)).length,
        planPending: Boolean(s.awaiting_input_at && s.awaiting_reason === "plan") });
    } else if (input === "x") {
      setConfirm({ action: "stop", id: selected.session.id });
    } else if (input === "a") {
      if (selected.session.status === "archived") {
        setConfirm({ action: "unarchive", id: selected.session.id, count: listInterruptedAgents(selected.session.id).length });
      } else {
        archiveSession(selected.session.id);
        setNotice(`archived ${selected.session.id} · z to show archived, a to restore`);
        refresh();
      }
    } else if (input === "R") {
      if (!config) return setNotice("config is unavailable");
      if (!config.personas.length) return setNotice("no personas configured");
      return setPersonaPick({ options: config.personas.map(p => p.name), cursor: 0, sessionId: selected.session.id });
    } else if (input === "d") {
      setConfirm({ action: "delete", id: selected.session.id });
    }
  });

  const confirmText = confirm ? (confirm.action === "edit"
    ? `Agent ${confirm.agentId} is still running. Edit its worktree anyway? (y/N)`
    : confirm.action === "delete"
    ? `Delete ${confirm.id} and its worktrees + artifacts? This can't be undone. (y/N)`
    : confirm.action === "refresh"
      ? `Refresh ${confirm.id} onto current Tack code? Agents keep running. (y/N)`
    : confirm.action === "reconnect"
      ? `Reconnect ${confirm.id}? Restarts the supervisor detached in tmux and revives ${confirm.count} dropped agent(s).${confirm.planPending ? " Pending plan will be re-presented." : ""} (y/N)`
    : confirm.action === "unarchive"
      ? `Unarchive ${confirm.id}${confirm.count ? ` and resume ${confirm.count} interrupted agent(s)` : ""}? (y/N)`
      : `Stop ${confirm.id} and its agents? (y/N)`) : null;

  if (personaPick) return <Box flexDirection="column"><Text bold>Review {personaPick.sessionId} · choose a persona</Text>{personaPick.options.map((p, i) => <Text key={p} color={i === personaPick.cursor ? "cyan" : undefined}>{i === personaPick.cursor ? "❯ " : "  "}{p}</Text>)}<Text dimColor>j/k move · enter review · esc/q cancel</Text></Box>;

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
    const entries = ticketEntries(rows);
    return (
      <TicketsPanel
        entries={entries}
        cursor={ticketCursorIndex(entries, ticketSel)}
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
  const sessionLines = rows.map((v, i) => flattenSessionLines(
    <Box key={v.session.id} flexDirection="column">
      <Text>
        <Text color={i === cursor ? "cyan" : undefined}>{i === cursor ? "❯ " : "  "}</Text>
        <Text color={v.live ? "green" : "gray"}>{v.live ? "●" : "○"} </Text>
        <Text bold>{v.session.id}</Text>
        <Text dimColor> {v.session.status} </Text>
        <Text color="green">{usd(v.cost)}</Text>
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
      {i === cursor &&
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
      {i === cursor &&
        v.prs.map((pr) => {
          const { glyph, color, label } = prStateDisplay(pr.state);
          const w = v.prWatch[pr.id];
          return (
            <Text key={pr.id}>
              {"    └─ PR "}
              {pr.number ?? "?"}{" "}
              <Text color={color}>
                {glyph} {label}
              </Text>
              {prHasConflicts(pr) ? <Text color="red"> ⚠ conflicts</Text> : null}
              {w && w.openFeedback > 0 ? (
                <Text color="yellow">
                  {" "}
                  {w.openFeedback} comment{w.openFeedback === 1 ? "" : "s"}
                </Text>
              ) : null}
              {w?.fixing ? <Text color="cyan"> fixing…</Text> : null}{" "}
              <Text underline>{pr.url}</Text>
            </Text>
          );
        })}
      {i === cursor &&
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
  ));
  const window = windowSessionLines(sessionLines.map(lines => lines.length), cursor, budget);
  const visibleLines = sessionLines.flat().slice(window.start, window.end);

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
  projectPick: { options: string[]; cursor: number } | null;
}) {
  if (projectPick) {
    const own = new Set(view.agents.map((a) => a.project_name));
    return (
      <Box flexDirection="column">
        <Text bold>
          New manual workspace in {view.session.id} <Text dimColor>choose a project</Text>
        </Text>
        {projectPick.options.map((p, i) => (
          <Text key={p}>
            <Text color={i === projectPick.cursor ? "cyan" : undefined}>{i === projectPick.cursor ? "❯ " : "  "}</Text>
            <Text bold>{p}</Text>
            {own.has(p) ? <Text dimColor> (in this session)</Text> : null}
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
 * several sessions gets one entry per session, since each is separate work. */
export interface TicketEntry {
  view: View;
  ticket: SessionJiraTicketRow;
}

/** Stable identity for a tickets-view entry across snapshots. */
function ticketEntryId(e: TicketEntry): string {
  return `${e.view.session.id}:${e.ticket.id}`;
}

/** Open work first — in progress before to do — then done; `Array.prototype.sort`
 * is stable, so each group keeps the dashboard's session order from `rows`. */
function ticketSortWeight(category: string | null): number {
  if (category === "indeterminate") return 0;
  if (category === "done") return 2;
  return 1;
}

export function ticketEntries(rows: readonly View[]): TicketEntry[] {
  return rows
    .flatMap((view) => view.tickets.map((ticket) => ({ view, ticket })))
    .sort((a, b) => ticketSortWeight(a.ticket.status_category) - ticketSortWeight(b.ticket.status_category));
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
  return <Text color="gray">○ <Text dimColor>{v.session.status}</Text></Text>;
}

const TICKETS_HINT = "j/k move · enter/o open ticket · g go to session · P poll Jira · esc/q back";

/** Every linked Jira ticket across the sessions on screen (follows `z`), one row per
 * (session, ticket). Rows truncate to one line each and window around the cursor
 * inside the same body budget as the main list, so the panel fits the terminal. */
function TicketsPanel({ entries, cursor, notice, jiraUnavailable, size }: {
  entries: TicketEntry[]; cursor: number; notice: string; jiraUnavailable: boolean;
  size: { columns: number; rows: number };
}) {
  const sessions = new Set(entries.map((e) => e.view.session.id)).size;
  const done = entries.filter((e) => e.ticket.status_category === "done").length;
  const footer = [notice, jiraUnavailable ? "jira unavailable — ticket status not updating" : "", TICKETS_HINT].filter(Boolean);
  const budget = dashboardBodyHeight(size.rows, size.columns, footer);
  const window = windowSessionLines(entries.map(() => 1), cursor, budget);
  return (
    <Box flexDirection="column" maxHeight={Math.max(0, size.rows - 1)} overflowY="hidden">
      <Text bold wrap="truncate">
        Jira tickets · {entries.length} ticket{entries.length === 1 ? "" : "s"} across {sessions} session{sessions === 1 ? "" : "s"}
        {" · "}<Text color={done > 0 ? "green" : undefined} dimColor={done === 0}>{done} done</Text>
      </Text>
      <Box flexDirection="column" height={budget} flexShrink={0} overflowY="hidden">
        {entries.length === 0 && <Text dimColor wrap="truncate">No Jira tickets linked to any session.</Text>}
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
              {"  "}<Text>{e.view.session.id}</Text>{" "}
              {sessionBadge(e.view)}
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
    if (!s || s.status !== "active" || isAlive(s.pr_watch_pid)) continue;
    if (!listSessionPrs(id).some(isWatchablePr)) continue;
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
  if (a.kind === "manual") return "manual";
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
        + (blocked ? ` · ${blocked} blocked (refresh on resume or r)` : "")
        + (failed ? ` · ${failed} failed` : "");
      continue;
    }

    if (launch.kind === "manual") {
      // Created here, on the normal screen, so the fetch's wait is visible; then it
      // takes exactly the `e` path below.
      console.log(`Creating a manual workspace for ${launch.project}…`);
      try {
        if (!config) throw new Error("config is unavailable");
        const created = createManualWorkspace(config, launch.sessionId, launch.project);
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
        : selfCommand(launch.kind === "create" ? ["session", "create"] : ["session", "resume", launch.id, ...(launch.message ? ["--message", launch.message] : [])]);
    const proc = Bun.spawn([command, ...args], {
      cwd: launch.kind === "edit" ? launch.path : undefined,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
}

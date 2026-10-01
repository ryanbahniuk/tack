import React, { useEffect, useRef, useState } from "react";
import { existsSync } from "node:fs";
import { Box, Text, render, useApp, useInput } from "ink";
import {
  listAgents,
  listSessionPrs,
  listSessions,
  sessionTotalCost,
  type AgentRow,
  type SessionPrRow,
  type SessionRow,
} from "../db";
import { agentLive, sessionLive, sessionNeedsInput } from "./liveness";
import { archiveSession, deleteSession, stopSession, unarchiveSession } from "../session/lifecycle";
import { selfCommand } from "../process/self";
import { agentArtifactPath } from "../artifacts/store";
import { refreshSessionPrs } from "../projects/prs";
import { loadConfig } from "../config/load";
import type { TackConfig } from "../config/schema";

interface View {
  session: SessionRow;
  agents: AgentRow[];
  prs: SessionPrRow[];
  cost: number;
  live: boolean;
  needsInput: boolean;
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
      return {
        session,
        agents,
        prs: listSessionPrs(session.id),
        cost: sessionTotalCost(session.id).total,
        live: sessionLive(session),
        // Waiting on the human: a plan to approve, or unread completed agent work.
        needsInput: sessionNeedsInput(session, agents),
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
        `${v.session.id}:${v.session.status}:${v.session.title ?? ""}:${v.cost}:${v.live ? 1 : 0}:${v.needsInput ? 1 : 0}:` +
        v.agents.map((a) => `${a.id}/${a.status}/${a.cost}`).join(",") +
        ";" +
        v.prs.map((p) => `${p.number}/${p.state}`).join(","),
    )
    .join("|");
}

/** The on-disk output file for an agent, falling back to its deterministic path when
 * the DB ref is empty (agents written before `output_ref` was persisted). Null when
 * no output has been produced yet. */
function agentOutputRef(a: AgentRow): string | null {
  if (a.output_ref && existsSync(a.output_ref)) return a.output_ref;
  const path = agentArtifactPath(a.session_id, a.id, "output");
  return existsSync(path) ? path : null;
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
 *  create a new one, or page through an agent's output. */
type Launch =
  | { kind: "resume"; id: string }
  | { kind: "create" }
  | { kind: "output"; ref: string; title: string };

/** A pending yes/no confirmation for a destructive key. */
type Confirm = { action: "delete" | "stop"; id: string };

function Dashboard({ config, onLaunch }: { config: TackConfig | null; onLaunch: (l: Launch) => void }) {
  const { exit } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const [rows, setRows] = useState<View[]>(() => snapshot(false));
  // Selection is pinned to a session *id*, not a row index, so re-sorting (sessions
  // float as they start needing input) and deletions never move the highlight onto
  // the wrong session under the human's cursor.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [mode, setMode] = useState<"list" | "agents">("list");
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [agentCursor, setAgentCursor] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [notice, setNotice] = useState("");
  const [ghMissing, setGhMissing] = useState(false);

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

  // Kept fresh so the refresh effect below (which only fires on mount + every 60s,
  // not on every 1s snapshot) always sees the sessions currently on screen.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // Refreshing PR status is automatic, so opening the dashboard is itself the "check
  // now" gesture — refresh once on mount (merge status should be right away, not
  // after a full interval), then every 60s. `refreshing` guards against a slow `gh`
  // call stacking with the next tick. Never touches `setRows`: it only writes to
  // SQLite, and the 1s snapshot poll above already re-reads `listSessionPrs`.
  const refreshing = useRef(false);
  useEffect(() => {
    if (!config) return;
    const run = () => {
      if (refreshing.current) return;
      refreshing.current = true;
      const ids = rowsRef.current.map((v) => v.session.id);
      refreshSessionPrs(config, ids)
        .then((res) => setGhMissing(res.ghMissing))
        .catch(() => {})
        .finally(() => {
          refreshing.current = false;
        });
    };
    run();
    const t = setInterval(run, 60_000);
    return () => clearInterval(t);
  }, [config]);

  useInput((input, key) => {
    // Quit is the one gesture that works from everywhere.
    if (key.ctrl && input === "c") return exit();

    // A pending confirmation swallows the next keypress: y/enter commits, anything
    // else cancels. Keeps a single fat-fingered `d` from deleting a session's
    // worktrees and artifacts irreversibly.
    if (confirm) {
      if (input === "y" || input === "Y" || key.return) {
        if (confirm.action === "delete") {
          deleteSession(confirm.id);
          setNotice(`deleted ${confirm.id}`);
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

    // Agent-output picker: drill into the selected session's agents and page one's
    // output. A navigation-only mode; only "view" hands the terminal to a pager.
    if (mode === "agents") {
      const agents = pickerView?.agents ?? [];
      if (input === "q" || key.escape || !pickerView) return setMode("list");
      if (key.downArrow || input === "j") return setAgentCursor((c) => Math.min(c + 1, Math.max(0, agents.length - 1)));
      if (key.upArrow || input === "k") return setAgentCursor((c) => Math.max(c - 1, 0));
      if (key.return || input === "o" || input === "v") {
        const a = agents[Math.min(agentCursor, agents.length - 1)];
        if (!a) return;
        const ref = agentOutputRef(a);
        if (!ref) {
          setNotice(`agent ${a.id} has no output yet`);
          return;
        }
        onLaunch({ kind: "output", ref, title: `${a.id} (${a.runtime}:${a.model})` });
        return exit();
      }
      return;
    }

    // List mode.
    if (input === "q") return exit();
    if (key.downArrow || input === "j") {
      const next = rows[Math.min(cursor + 1, rows.length - 1)];
      if (next) setCursorId(next.session.id);
    } else if (key.upArrow || input === "k") {
      const prev = rows[Math.max(cursor - 1, 0)];
      if (prev) setCursorId(prev.session.id);
    } else if (input === "n") {
      // Jump to the next session needing input, wrapping around.
      for (let step = 1; step <= rows.length; step++) {
        const v = rows[(cursor + step) % rows.length];
        if (v?.needsInput) {
          setCursorId(v.session.id);
          break;
        }
      }
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
      // launching the session happens in `runStable` once this unmounts — we just
      // record which session and exit.
      onLaunch({ kind: "resume", id: selected.session.id });
      exit();
    } else if (input === "v") {
      if (selected.agents.length === 0) {
        setNotice(`${selected.session.id} has no agents yet`);
        return;
      }
      setPickerId(selected.session.id);
      setAgentCursor(0);
      setMode("agents");
    } else if (input === "O") {
      if (selected.prs.length === 0) {
        setNotice(`${selected.session.id} has no PRs yet`);
        return;
      }
      for (const pr of selected.prs) openUrl(pr.url);
      setNotice(`opened ${selected.prs.length} PR${selected.prs.length === 1 ? "" : "s"} in browser`);
    } else if (input === "x") {
      setConfirm({ action: "stop", id: selected.session.id });
    } else if (input === "a") {
      if (selected.session.status === "archived") unarchiveSession(selected.session.id);
      else archiveSession(selected.session.id);
      refresh();
    } else if (input === "d") {
      setConfirm({ action: "delete", id: selected.session.id });
    }
  });

  if (mode === "agents" && pickerView) {
    return <AgentsPanel view={pickerView} cursor={Math.min(agentCursor, Math.max(0, pickerView.agents.length - 1))} notice={notice} />;
  }

  const totalCost = rows.reduce((sum, v) => sum + v.cost, 0);
  const liveCount = rows.filter((v) => v.live).length;
  const needsCount = rows.filter((v) => v.needsInput).length;

  return (
    <Box flexDirection="column">
      <Text bold>
        Tack {showArchived ? "(all)" : "(active)"} · {rows.length} session{rows.length === 1 ? "" : "s"} ·{" "}
        <Text color="green">{liveCount} live</Text> ·{" "}
        {needsCount > 0 ? <Text color="yellow">{needsCount} need input</Text> : <Text dimColor>0 need input</Text>} ·{" "}
        <Text color="green">{usd(totalCost)}</Text> <Text dimColor>in flight</Text>
      </Text>
      {rows.length === 0 && <Text dimColor>No sessions. Press c to create one.</Text>}
      {rows.map((v, i) => (
        <Box key={v.session.id} flexDirection="column">
          <Text>
            <Text color={i === cursor ? "cyan" : undefined}>{i === cursor ? "❯ " : "  "}</Text>
            <Text color={v.live ? "green" : "gray"}>{v.live ? "●" : "○"} </Text>
            <Text bold>{v.session.id}</Text>
            <Text dimColor> {v.session.status} </Text>
            <Text color="green">{usd(v.cost)}</Text>
            {v.prs.length > 0 ? <Text> {prRollup(v.prs)}</Text> : null}
            {v.needsInput ? <Text color="yellow"> ◆ needs input</Text> : null}
            <Text dimColor> {v.session.title ?? ""}</Text>
          </Text>
          {i === cursor &&
            v.agents.map((a) => (
              <Text key={a.id}>
                {"    ├─ Agent "}
                <Text color={agentLive(a) ? "yellow" : agentStatusColor(a.status)}>{a.status.padEnd(8)}</Text>
                <Text dimColor>
                  {" "}
                  {a.runtime}:{a.model}
                </Text>
                <Text color="green"> {usd(a.cost)}</Text>
              </Text>
            ))}
          {i === cursor &&
            v.prs.map((pr) => {
              const { glyph, color, label } = prStateDisplay(pr.state);
              return (
                <Text key={pr.id}>
                  {"    └─ PR "}
                  {pr.number ?? "?"}{" "}
                  <Text color={color}>
                    {glyph} {label}
                  </Text>{" "}
                  <Text underline>{pr.url}</Text>
                </Text>
              );
            })}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        {confirm ? (
          <Text color="yellow">
            {confirm.action === "delete"
              ? `Delete ${confirm.id} and its worktrees + artifacts? This can't be undone. (y/N)`
              : `Stop ${confirm.id} and its agents? (y/N)`}
          </Text>
        ) : (
          <>
            {notice ? <Text dimColor>{notice}</Text> : null}
            {ghMissing ? <Text dimColor>gh not found — PR status not updating</Text> : null}
            <Text dimColor>
              j/k move · enter/o open · v view output · n next needing input · O open PR · c new · x stop · a archive · d delete · z archived · q quit
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}

/** The agent-output picker for one session: choose an agent, page its output. */
function AgentsPanel({ view, cursor, notice }: { view: View; cursor: number; notice: string }) {
  return (
    <Box flexDirection="column">
      <Text bold>
        Agents of {view.session.id} <Text dimColor>{view.session.title ?? ""}</Text>
      </Text>
      {view.agents.length === 0 && <Text dimColor>No agents.</Text>}
      {view.agents.map((a, i) => {
        const ref = agentOutputRef(a);
        return (
          <Text key={a.id}>
            <Text color={i === cursor ? "cyan" : undefined}>{i === cursor ? "❯ " : "  "}</Text>
            <Text bold>{a.id}</Text>{" "}
            <Text color={agentLive(a) ? "yellow" : agentStatusColor(a.status)}>{a.status.padEnd(8)}</Text>
            <Text dimColor>
              {" "}
              {a.runtime}:{a.model}
            </Text>
            <Text color="green"> {usd(a.cost)}</Text>
            <Text dimColor> {a.project_name}</Text>
            {ref ? null : <Text dimColor> (no output)</Text>}
          </Text>
        );
      })}
      <Box marginTop={1} flexDirection="column">
        {notice ? <Text dimColor>{notice}</Text> : null}
        <Text dimColor>j/k move · enter/v view output · esc/q back</Text>
      </Box>
    </Box>
  );
}

function agentStatusColor(status: string): string | undefined {
  if (status === "done") return "green";
  if (status === "failed") return "red";
  return "gray";
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
 * exits. Three hand-offs: enter/o resumes the selected session's supervisor (and
 * stamps `last_seen_at` so its "needs input" badge clears), c creates a fresh one,
 * and v pages an agent's output file through the user's pager.
 */
export async function runStable(): Promise<void> {
  const config = await loadConfig().catch(() => null);
  for (;;) {
    let launch: Launch | undefined;
    process.stdout.write(ALT_SCREEN_ENTER);
    try {
      const app = render(<Dashboard config={config} onLaunch={(l) => (launch = l)} />);
      await app.waitUntilExit();
    } finally {
      // Always restore the normal screen — whether quitting, opening a session, or
      // if render throws — so we never strand the terminal in the alt buffer.
      process.stdout.write(ALT_SCREEN_EXIT);
    }
    if (!launch) return; // quit, not a hand-off

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

    // Runs on the normal screen so the child keeps real scrollback.
    const { command, args } =
      launch.kind === "output"
        ? pagerInvocation(launch.ref)
        : selfCommand(launch.kind === "create" ? ["session", "create"] : ["session", "resume", launch.id]);
    const proc = Bun.spawn([command, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
}

import React, { useEffect, useRef, useState } from "react";
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

function snapshot(showArchived: boolean): View[] {
  return listSessions(showArchived).map((session) => {
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
  });
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/** What the human asked for by leaving the dashboard: open the highlighted
 *  session, or create a new one. */
type Launch = { kind: "resume"; id: string } | { kind: "create" };

function Dashboard({ config, onLaunch }: { config: TackConfig | null; onLaunch: (l: Launch) => void }) {
  const { exit } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const [rows, setRows] = useState<View[]>(() => snapshot(false));
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState("");
  const [ghMissing, setGhMissing] = useState(false);

  // The dashboard only observes — it never marks a session seen. The "unread work"
  // badge clears when the human actually opens the session (`tack session resume`,
  // which attaches/resumes the supervisor and stamps `last_seen_at`), not just by
  // highlighting it here.
  useEffect(() => {
    const t = setInterval(() => setRows(snapshot(showArchived)), 1000);
    return () => clearInterval(t);
  }, [showArchived]);

  // Kept fresh so the refresh effect below (which only fires on mount + every 60s,
  // not on every 1s snapshot) always sees the sessions currently on screen.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // Replaces the old manual `p` key: refreshing PR status is now automatic, so
  // opening the dashboard is itself the "check now" gesture — refresh once on mount
  // (merge status should be right away, not after a full interval), then every 60s.
  // `refreshing` guards against a slow `gh` call stacking with the next tick.
  // Never touches `setRows`: it only writes to SQLite, and the 1s snapshot poll
  // above already re-reads `listSessionPrs`, so the UI updates itself.
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

  const selected = rows[Math.min(cursor, rows.length - 1)];

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (key.downArrow || input === "j") setCursor((c) => Math.min(c + 1, rows.length - 1));
    else if (key.upArrow || input === "k") setCursor((c) => Math.max(c - 1, 0));
    else if (input === "z") {
      setShowArchived((v) => !v);
      setCursor(0);
    } else if (input === "c") {
      // Same hand-off as opening a session, but for a brand-new one — works even
      // with zero sessions, which is exactly when this is most useful.
      onLaunch({ kind: "create" });
      exit();
    } else if (!selected) return;
    else if (input === "o" || key.return) {
      // Hand the terminal to the interactive supervisor. Tearing down Ink and
      // launching the session happens in `runStable` once this unmounts — we just
      // record which session and exit.
      onLaunch({ kind: "resume", id: selected.session.id });
      exit();
    } else if (input === "x") {
      stopSession(selected.session.id);
      setNotice(`stopped ${selected.session.id}`);
    } else if (input === "a") {
      if (selected.session.status === "archived") unarchiveSession(selected.session.id);
      else archiveSession(selected.session.id);
      setRows(snapshot(showArchived));
    } else if (input === "d") {
      deleteSession(selected.session.id);
      setCursor((c) => Math.max(0, c - 1));
      setRows(snapshot(showArchived));
      setNotice(`deleted ${selected.session.id}`);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        Tack {showArchived ? "(all)" : "(active)"} — {rows.length} session(s)
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
        {notice ? <Text dimColor>{notice}</Text> : null}
        {ghMissing ? <Text dimColor>gh not found — PR status not updating</Text> : null}
        <Text dimColor>
          j/k move · enter/o open · c new · x stop · a archive · d delete · z toggle archived · q quit
        </Text>
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
const ALT_SCREEN_ENTER = "\u001b[?1049h";
const ALT_SCREEN_EXIT = "\u001b[?1049l";

/**
 * Renders the live dashboard on a full-screen alternate buffer, resolving when the
 * user quits. Pressing enter/o opens the selected session: we leave the alt buffer
 * (restoring the normal screen), hand the terminal to an interactive
 * `tack session resume <id>` subprocess — which attaches to the live supervisor or
 * resumes it, and stamps `last_seen_at` so its "needs input" badge clears — then
 * re-enter the dashboard when that session is left. Pressing `c` does the same
 * hand-off but for `tack session create` (no seed message), landing the human in a
 * fresh supervisor's idle TUI to type the first message themselves.
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
    if (!launch) return; // quit, not open

    // Fully relinquish stdin before handing the terminal to the child. Ink turns raw
    // mode off and `unref`s stdin on unmount, but never *pauses* the stream — so this
    // process keeps reading the shared TTY. That races the child for input: the first
    // keypress meant for the opened session gets stolen here, and the child's tmux
    // client, seeing its terminal input yanked away, detaches back to the dashboard.
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

    // Runs on the normal screen so the session keeps real scrollback.
    const argv = launch.kind === "create" ? ["session", "create"] : ["session", "resume", launch.id];
    const { command, args } = selfCommand(argv);
    const proc = Bun.spawn([command, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
}

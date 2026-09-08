import React, { useEffect, useState } from "react";
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
import { agentLive, sessionLive } from "./liveness";
import { tmuxAvailable, tmuxHasSession, tmuxSessionName } from "../session/tmux";
import { archiveSession, deleteSession, stopSession, unarchiveSession } from "../session/lifecycle";
import { discoverSessionPrs } from "../projects/prs";
import { loadConfig } from "../config/load";
import type { TackConfig } from "../config/schema";
import { createSupervisorSession, superviseInteractive } from "../supervisor/supervise";

interface View {
  session: SessionRow;
  agents: AgentRow[];
  prs: SessionPrRow[];
  cost: number;
  live: boolean;
  attachable: boolean;
}

// Resolve tmux's presence once, not on every 1s snapshot — it can't change while
// the dashboard is open, and each `tmuxHasSession` probe already shells out.
const HAS_TMUX = tmuxAvailable();

function snapshot(showArchived: boolean): View[] {
  return listSessions(showArchived).map((session) => ({
    session,
    agents: listAgents(session.id),
    prs: listSessionPrs(session.id),
    cost: sessionTotalCost(session.id).total,
    live: sessionLive(session),
    // A live tmux session = a parked interactive supervisor you can rejoin with
    // `tack session attach <id>` (right where it was left, e.g. a pending plan).
    attachable: HAS_TMUX && tmuxHasSession(tmuxSessionName(session.id)),
  }));
}

const usd = (n: number) => `$${n.toFixed(4)}`;

function Dashboard({
  config,
  initialNotice,
  onOutcome,
}: {
  config: TackConfig | null;
  initialNotice: string;
  onOutcome: (outcome: Outcome) => void;
}) {
  const { exit } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const [rows, setRows] = useState<View[]>(() => snapshot(false));
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState(initialNotice);

  useEffect(() => {
    const t = setInterval(() => setRows(snapshot(showArchived)), 1000);
    return () => clearInterval(t);
  }, [showArchived]);

  const selected = rows[Math.min(cursor, rows.length - 1)];

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (key.downArrow || input === "j") setCursor((c) => Math.min(c + 1, rows.length - 1));
    else if (key.upArrow || input === "k") setCursor((c) => Math.max(c - 1, 0));
    else if (input === "z") {
      setShowArchived((v) => !v);
      setCursor(0);
    } else if (input === "c") {
      onOutcome("create");
      exit();
    } else if (!selected) return;
    else if (input === "x") {
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
    } else if (input === "p") {
      if (config) {
        const res = discoverSessionPrs(config, selected.session.id);
        setNotice(res.ghMissing ? "gh not found" : `found ${res.prs.length} PR(s)`);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        Tack {showArchived ? "(all)" : "(active)"} — {rows.length} session(s)
      </Text>
      {rows.length === 0 && <Text dimColor>No sessions. Press `c` to create one.</Text>}
      {rows.map((v, i) => (
        <Box key={v.session.id} flexDirection="column">
          <Text>
            <Text color={i === cursor ? "cyan" : undefined}>{i === cursor ? "❯ " : "  "}</Text>
            <Text color={v.live ? "green" : "gray"}>{v.live ? "●" : "○"} </Text>
            <Text bold>{v.session.id}</Text>
            <Text dimColor> {v.session.status} </Text>
            <Text color="green">{usd(v.cost)}</Text>
            {v.attachable ? <Text color="yellow"> attachable</Text> : null}
            <Text dimColor> {v.session.title ?? ""}</Text>
          </Text>
          {i === cursor &&
            v.agents.map((a) => (
              <Text key={a.id}>
                {"    ├─ "}
                <Text color={agentLive(a) ? "yellow" : agentStatusColor(a.status)}>{a.status.padEnd(8)}</Text>
                <Text> {a.project_name} </Text>
                <Text dimColor>
                  {a.runtime}:{a.model}
                </Text>
                <Text color="green"> {usd(a.cost)}</Text>
              </Text>
            ))}
          {i === cursor &&
            v.prs.map((pr) => (
              <Text key={pr.id}>
                {"    └─ PR "}
                {pr.number ?? "?"} <Text dimColor>{pr.state ?? ""}</Text> <Text underline>{pr.url}</Text>
              </Text>
            ))}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        {notice ? <Text dimColor>{notice}</Text> : null}
        <Text dimColor>
          j/k move · c new session · x stop · a archive · d delete · p find PRs · z toggle archived · q quit
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

type Outcome = "quit" | "create";

/**
 * Erases the visible screen and homes the cursor (`ESC[2J` + `ESC[H`), not the
 * `3J` variant — that would also nuke scrollback, which users expect to keep
 * (e.g. to scroll back after a `q`).
 */
function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

/**
 * Creates a session via the same foreground path as bare `tack` with no `-m`
 * (bin/tack.ts's `sessionCreate`): an idle interactive supervisor TUI the user
 * types into. Never throws — a failure (e.g. a missing runtime binary) becomes
 * a footer notice instead of crashing the dashboard.
 */
async function createSessionInteractive(config: TackConfig | null): Promise<string> {
  if (!config) return "no config — run `tack init`";
  try {
    // Mirrors bin/tack.ts:614 — an empty prompt falls back to a placeholder title
    // since the session needs one before the user types anything.
    const session = createSupervisorSession("(interactive session)", config);
    const { detached } = await superviseInteractive({ session, prompt: "", resume: false, config });
    if (detached) return `${session.id} detached — still running`;
    return `${session.id} exited · ${usd(sessionTotalCost(session.id).total)}`;
  } catch (err) {
    return `create failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Renders the live dashboard and resolves when the user quits. */
export async function runStable(): Promise<void> {
  const config = await loadConfig().catch(() => null);
  let notice = "";

  for (;;) {
    clearScreen();
    let outcome: Outcome = "quit";
    const app = render(
      <Dashboard
        config={config}
        initialNotice={notice}
        onOutcome={(o) => {
          outcome = o;
        }}
      />,
    );
    await app.waitUntilExit();
    app.unmount();

    if (outcome === "quit") return;
    notice = await createSessionInteractive(config);
  }
}

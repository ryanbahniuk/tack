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
import { agentLive, sessionLive, sessionNeedsInput } from "./liveness";
import { archiveSession, deleteSession, stopSession, unarchiveSession } from "../session/lifecycle";
import { selfCommand } from "../process/self";
import { discoverSessionPrs } from "../projects/prs";
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

function Dashboard({ config, onOpen }: { config: TackConfig | null; onOpen: (id: string) => void }) {
  const { exit } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const [rows, setRows] = useState<View[]>(() => snapshot(false));
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState("");

  // The dashboard only observes — it never marks a session seen. The "unread work"
  // badge clears when the human actually opens the session (`tack session resume`,
  // which attaches/resumes the supervisor and stamps `last_seen_at`), not just by
  // highlighting it here.
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
    } else if (!selected) return;
    else if (input === "o" || key.return) {
      // Hand the terminal to the interactive supervisor. Tearing down Ink and
      // launching the session happens in `runStable` once this unmounts — we just
      // record which session and exit.
      onOpen(selected.session.id);
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
      {rows.length === 0 && <Text dimColor>No sessions. Run `tack session create`.</Text>}
      {rows.map((v, i) => (
        <Box key={v.session.id} flexDirection="column">
          <Text>
            <Text color={i === cursor ? "cyan" : undefined}>{i === cursor ? "❯ " : "  "}</Text>
            <Text color={v.live ? "green" : "gray"}>{v.live ? "●" : "○"} </Text>
            <Text bold>{v.session.id}</Text>
            <Text dimColor> {v.session.status} </Text>
            <Text color="green">{usd(v.cost)}</Text>
            {v.needsInput ? <Text color="yellow"> ◆ needs input</Text> : null}
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
        <Text dimColor>j/k move · enter/o open · x stop · a archive · d delete · p find PRs · z toggle archived · q quit</Text>
      </Box>
    </Box>
  );
}

function agentStatusColor(status: string): string | undefined {
  if (status === "done") return "green";
  if (status === "failed") return "red";
  return "gray";
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
 * re-enter the dashboard when that session is left.
 */
export async function runStable(): Promise<void> {
  const config = await loadConfig().catch(() => null);
  for (;;) {
    let openId: string | undefined;
    process.stdout.write(ALT_SCREEN_ENTER);
    try {
      const app = render(<Dashboard config={config} onOpen={(id) => (openId = id)} />);
      await app.waitUntilExit();
    } finally {
      // Always restore the normal screen — whether quitting, opening a session, or
      // if render throws — so we never strand the terminal in the alt buffer.
      process.stdout.write(ALT_SCREEN_EXIT);
    }
    if (!openId) return; // quit, not open

    // Runs on the normal screen so the session keeps real scrollback.
    const { command, args } = selfCommand(["session", "resume", openId]);
    const proc = Bun.spawn([command, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
}

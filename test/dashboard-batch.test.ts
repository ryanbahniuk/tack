import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentCostBySession,
  countOpenPrFeedback,
  countOpenPrFeedbackByPr,
  createAgent,
  createAmendment,
  createSession,
  deleteSession,
  insertPrFeedback,
  listAgents,
  listAgentsBySession,
  listPendingAmendments,
  listPendingAmendmentsBySession,
  listPrFeedback,
  listSessionJiraTickets,
  listSessionJiraTicketsBySession,
  listSessionPrs,
  listSessionPrsBySession,
  markPrFeedbackHandled,
  resolveAmendment,
  sessionTotalCost,
  setAgentCost,
  setSessionCost,
  setSessionStatus,
  upsertSessionJiraTicket,
  upsertSessionPr,
} from "../src/db";
import { isSessionStale, staleSessionIds } from "../src/session/refresh";
import { tmuxListSessions, tmuxSessionName } from "../src/session/tmux";

test("batched dashboard reads match the per-session reads", () => {
  const sessions = Array.from({ length: 3 }, () => createSession({}));
  const [a, b, c] = sessions.map((s) => s.id) as [string, string, string];
  try {
    for (const [sid, n] of [[a, 3], [b, 1]] as const) {
      const agentIds = Array.from({ length: n }, () => createAgent({ sessionId: sid, projectName: "p" }).id);
      agentIds.forEach((id, i) => setAgentCost(id, 0.25 * (i + 1), "runtime"));
      upsertSessionPr({ sessionId: sid, url: `https://example.com/${sid}/1`, number: 1, state: "open" });
      upsertSessionPr({ sessionId: sid, url: `https://example.com/${sid}/2`, number: 2, state: "merged" });
      for (const key of ["ZZ-1", "AA-2", "MM-3"]) upsertSessionJiraTicket({ sessionId: sid, key, status: "To Do" });
      createAmendment({ sessionId: sid, proposedBy: agentIds[0]!, proposalRef: "/nowhere" });
      resolveAmendment(createAmendment({ sessionId: sid, proposedBy: agentIds[0]!, proposalRef: "/nowhere" }).id, "accepted", null);
    }
    setSessionCost(a, 1.5);
    const pr = listSessionPrs(a)[0]!;
    for (const sourceId of ["s1", "s2", "s3"]) insertPrFeedback({ sessionPrId: pr.id, sourceId, sourceKind: "issue_comment" });
    markPrFeedbackHandled(listPrFeedback(pr.id)[0]!.id);

    const ids = [a, b, c];
    const agents = listAgentsBySession(ids);
    const prs = listSessionPrsBySession(ids);
    const tickets = listSessionJiraTicketsBySession(ids);
    const amendments = listPendingAmendmentsBySession(ids);
    const cost = agentCostBySession(ids);
    const feedback = countOpenPrFeedbackByPr(ids);
    for (const id of ids) {
      expect(agents.get(id) ?? []).toEqual(listAgents(id));
      expect(prs.get(id) ?? []).toEqual(listSessionPrs(id));
      expect(tickets.get(id) ?? []).toEqual(listSessionJiraTickets(id));
      expect(amendments.get(id) ?? []).toEqual(listPendingAmendments(id));
      const session = sessions.find((s) => s.id === id)!;
      const supervisor = id === a ? 1.5 : session.cost;
      expect(supervisor + (cost.get(id) ?? 0)).toBeCloseTo(sessionTotalCost(id).total, 10);
      for (const p of listSessionPrs(id)) expect(feedback.get(p.id) ?? 0).toBe(countOpenPrFeedback(p.id));
    }
    expect(feedback.get(pr.id)).toBe(2);
    expect(tickets.get(a)!.map((t) => t.key)).toEqual(listSessionJiraTickets(a).map((t) => t.key));
    // Only the requested sessions are read.
    expect([...listAgentsBySession([b]).keys()]).toEqual([b]);
    expect(listAgentsBySession([]).size).toBe(0);
  } finally {
    for (const id of [a, b, c]) deleteSession(id);
  }
});

test("stale detection probes once per tick and never marks archived sessions stale", () => {
  const live = createSession({});
  const parked = createSession({});
  const archived = createSession({});
  setSessionStatus(archived.id, "archived");
  const old = { supervisor_code_version: "old", pr_watch_code_version: "old", supervisor_config_version: "cfg", pr_watch_config_version: "cfg" };
  const rows = [
    { ...live, ...old, pid: 11 },
    { ...parked, ...old, pid: null },
    { ...archived, ...old, status: "archived" as const, pid: 11, pr_watch_pid: 22 },
  ];
  const calls = { current: 0, config: 0, tmux: 0 };
  const deps = {
    current: () => (calls.current++, "new"),
    config: () => (calls.config++, "cfg"),
    tmuxSessions: () => (calls.tmux++, new Set([tmuxSessionName(parked.id), tmuxSessionName(archived.id)])),
    alive: (pid: number | null | undefined) => pid === 11 || pid === 22,
  };
  try {
    expect([...staleSessionIds(rows, deps)].sort()).toEqual([live.id, parked.id].sort());
    expect(calls).toEqual({ current: 1, config: 1, tmux: 1 });
    // Only archived sessions listed: no probes at all.
    expect(staleSessionIds([rows[2]!], deps).size).toBe(0);
    expect(calls).toEqual({ current: 1, config: 1, tmux: 1 });
    // The injected probes agree with isSessionStale's per-session policy.
    expect(isSessionStale(rows[1]!, { current: "new", config: "cfg", tmux: true, alive: () => false }).supervisor).toBe(true);
    expect(isSessionStale(rows[1]!, { current: "new", config: "cfg", tmux: false, alive: () => false }).stale).toBe(false);
  } finally {
    for (const s of [live, parked, archived]) deleteSession(s.id);
  }
});

test("tmuxListSessions is empty without tmux and never throws", () => {
  const empty = mkdtempSync(join(tmpdir(), "tack-no-tmux-"));
  const path = process.env.PATH;
  try {
    process.env.PATH = empty;
    expect(tmuxListSessions().size).toBe(0);
  } finally {
    process.env.PATH = path;
    rmSync(empty, { recursive: true, force: true });
  }
  const throwing = (() => { throw new Error("boom"); }) as unknown as Parameters<typeof tmuxListSessions>[0];
  expect(tmuxListSessions(throwing).size).toBe(0);
  const listed = (() => ({ status: 0, stdout: "tack-ses_a\ntack-ses_b\n\n" })) as unknown as Parameters<typeof tmuxListSessions>[0];
  expect([...tmuxListSessions(listed)]).toEqual(["tack-ses_a", "tack-ses_b"]);
  const failed = (() => ({ status: 1, stdout: "" })) as unknown as Parameters<typeof tmuxListSessions>[0];
  expect(tmuxListSessions(failed).size).toBe(0);
});

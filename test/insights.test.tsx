import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import React from "react";
import { PassThrough } from "node:stream";
import { Box, Text, render } from "ink";
import { migrate, getDb, readInsightEvents, createSession, upsertSessionPr, listSessionPrs, setSessionPrStatus } from "../src/db";
import { aggregateInsights, localDay } from "../src/cli/stats";
import { compress, heatmap, horizontalBars, pairedBars, sparkline } from "../src/cli/charts";
import { Dashboard } from "../src/cli/dashboard";
import { Insights } from "../src/cli/insights";

const now = new Date(2026, 10, 14, 12);
const at = (day: number) => new Date(2026, 10, day, 10).toISOString();

/** Small real schema fixture exercises the single aggregate read, not a mock of
 * its SQL. Old/archived sessions intentionally retain recent agent/PR activity. */
function fixture(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.query("INSERT INTO sessions (id,status,cost,created_at,updated_at) VALUES (?,?,?,?,?)").run("old", "archived", 2, at(1), at(1));
  db.query("INSERT INTO sessions (id,status,cost,created_at,updated_at) VALUES (?,?,?,?,?)").run("new", "active", 3, at(14), at(14));
  const agent = db.query("INSERT INTO agents (id,session_id,project_name,status,cost,kind,created_at,updated_at) VALUES (?,'old',?,'failed',?,?,?,?)");
  agent.run("a", "alpha", 4, null, at(14), at(14));
  agent.run("b", "beta", 5, "pr_fix", at(13), at(13));
  agent.run("c", "alpha", 1, null, at(12), at(12));
  const pr = db.query("INSERT INTO session_prs (id,session_id,project_name,url,state,created_at,updated_at,merged_at) VALUES (?,'old',?,?,'merged',?,?,?)");
  pr.run("p", "alpha", "u1", at(1), at(14), null);
  pr.run("q", "beta", "u2", at(12), at(14), at(13));
  db.query("INSERT INTO session_jira_tickets (id,session_id,key,status_category,created_at,updated_at) VALUES ('t','old','T-1','done',?,?)").run(at(12), at(14));
  return db;
}

describe("insight aggregation", () => {
  test("all sessions, per-event dates, costs, repo order and legacy merged_at fallback", () => {
    const db = fixture();
    const stats = aggregateInsights(readInsightEvents(db), "7d", now);
    expect(stats.totals).toEqual({ sessions: 1, agents: 3, prFix: 1, prs: 1, merged: 2, tickets: 1, done: 1, cost: 13 });
    expect(stats.series).toHaveLength(7);
    expect(stats.series[5]).toMatchObject({ day: "2026-11-13", merged: 1, agents: 1, cost: 5 });
    expect(stats.series[6]).toMatchObject({ day: "2026-11-14", merged: 1, sessions: 1, done: 1, cost: 7 });
    expect(stats.previous).toMatchObject({ sessions: 1, prs: 1, cost: 2 });
    expect(stats.deltas).toMatchObject({ sessions: 0, agents: 3, prs: 0, cost: 11 });
    expect(stats.repos).toEqual([
      { repo: "alpha", agents: 2, prs: 0, merged: 1, cost: 5 },
      { repo: "beta", agents: 1, prs: 1, merged: 1, cost: 5 },
    ]);
    expect(stats.daily.at(-1)).toEqual({ day: "2026-11-14", count: 4 });
    db.close();
  });
  test("local day boundaries, partial comparison, and future events", () => {
    const events = [
      { at: new Date(2026, 10, 8, 0).toISOString(), repo: null, metric: "sessions" as const, value: 1 },
      { at: new Date(2026, 10, 7, 23, 59).toISOString(), repo: null, metric: "sessions" as const, value: 2 },
      { at: new Date(2026, 10, 7, 13).toISOString(), repo: null, metric: "sessions" as const, value: 100 },
      { at: new Date(2026, 10, 14, 13).toISOString(), repo: null, metric: "sessions" as const, value: 100 },
      { at: "invalid", repo: null, metric: "sessions" as const, value: 100 },
    ];
    const stats = aggregateInsights(events, "7d", now);
    expect(stats.series[0]).toMatchObject({ day: "2026-11-08", sessions: 1 });
    expect(stats.totals.sessions).toBe(1);
    expect(stats.previous.sessions).toBe(0);
    expect(localDay(new Date(2026, 0, 1, 23))).toBe("2026-01-01");
  });
  test("day/week/month buckets adapt to range and width and preserve sums", () => {
    const db = fixture(), events = readInsightEvents(db);
    expect(aggregateInsights(events, "30d", now).bucket).toBe("day");
    const weekly = aggregateInsights(events, "90d", now, 10);
    expect(weekly.bucket).toBe("week");
    expect(new Date(`${weekly.series[0]!.day}T00:00:00`).getDay()).toBe(1);
    const monthly = aggregateInsights(events, "1y", now, 20);
    expect(monthly.bucket).toBe("month");
    expect(monthly.series.every(b => b.day.endsWith("-01"))).toBe(true);
    expect(monthly.series.reduce((sum, b) => sum + b.cost, 0)).toBe(monthly.totals.cost);
    expect(aggregateInsights(events, "1y", now, 60).bucket).toBe("week");
    expect(aggregateInsights(events, "all", now).start).toBe("2026-11-01");
    expect(aggregateInsights([], "all", now).daily).toEqual([{ day: "2026-11-14", count: 0 }]);
    db.close();
  });
  test("negative and zero deltas, empty ranges", () => {
    const stats = aggregateInsights([{ at: at(1), repo: "repo", metric: "agents", value: 4 }], "7d", now);
    expect(stats.deltas.agents).toBe(-4);
    expect(stats.totals.agents).toBe(0);
    expect(stats.repos).toEqual([]);
    expect(stats.daily.every(d => d.count === 0)).toBe(true);
  });
});

describe("merged_at persistence and migration", () => {
  test("v7 upgrades an existing v6 table without rewriting its data; rerun is safe", () => {
    const db = fixture();
    // Reconstruct the pre-v7 schema, removing later columns while preserving legacy rows.
    db.exec("ALTER TABLE session_prs DROP COLUMN merged_at; DELETE FROM _migrations WHERE version >= 7; ALTER TABLE agents DROP COLUMN interrupted_at");
    migrate(db);
    expect(db.query("SELECT merged_at FROM session_prs WHERE id = 'p'").get()).toEqual({ merged_at: null });
    expect(db.query("SELECT COUNT(*) AS n FROM session_prs").get()).toEqual({ n: 2 });
    expect(db.query("SELECT MAX(version) AS v FROM _migrations WHERE version <= 7").get()).toEqual({ v: 7 });
    migrate(db);
    db.close();
  });
  test("discovery and watcher preserve an actual merge timestamp across refreshes", () => {
    const session = createSession({});
    const input = { sessionId: session.id, url: `https://example.com/${session.id}`, state: "merged", mergedAt: at(12) };
    upsertSessionPr(input);
    const pr = listSessionPrs(session.id)[0]!;
    expect(pr.merged_at).toBe(at(12));
    upsertSessionPr({ ...input, mergedAt: undefined });
    expect(listSessionPrs(session.id)[0]!.merged_at).toBe(at(12));
    setSessionPrStatus(pr.id, { state: "merged", mergeable: null, baseBranch: null, headSha: null, mergedAt: at(13) });
    setSessionPrStatus(pr.id, { state: "merged", mergeable: null, baseBranch: null, headSha: null });
    expect(listSessionPrs(session.id)[0]!.merged_at).toBe(at(13));
  });
});

describe("Unicode charts", () => {
  test("fixed strings and widths, including all-zero and empty input", () => {
    expect(sparkline([0, 1, 2, 4, 8], 5)).toBe("·▁▂▄█");
    expect(sparkline([0, 0], 1)).toBe("·");
    expect(sparkline([], 20)).toBe("");
    expect(sparkline([2], 0)).toBe("");
    expect(compress([1, 2, 3, 4], 2)).toEqual([3, 7]);
    expect(horizontalBars([{ label: "alpha", value: 4 }, { label: "beta", value: 2 }], 15)).toBe("alpha ███████ 4\nbeta  ████ 2");
    expect(horizontalBars([{ label: "a", value: 0 }], 6)).toBe("a   0");
    expect(horizontalBars([], 5)).toBe("no re");
    expect(pairedBars([0, 1, 4], [4, 2, 0], 3)).toEqual(["·░█", "▇▃·"]);
    expect(pairedBars([0], [0], 1)).toEqual(["·", "·"]);
    const daily = Array.from({ length: 14 }, (_, i) => ({ day: `2026-11-${String(i + 2).padStart(2, "0")}`, count: i % 5 }));
    expect(heatmap(daily, 2)).toBe("·▒\n░▓\n▒█\n▓·\n█░\n·▒\n░▓");
    expect(heatmap(daily, 1)).toBe("▒\n▓\n█\n·\n░\n▒\n▓");
    expect(heatmap([], 10)).toBe("");
    for (const width of [0, 1, 3, 10]) {
      expect(horizontalBars([{ label: "long name", value: 20 }], width).length).toBeLessThanOrEqual(width);
    }
  });
});

describe("Insights Ink smoke render", () => {
  for (const [full, columns] of [[false, 160], [true, 160], [true, 80], [true, 40]] as const) {
    test(`${full ? "full" : "split"} at ${columns} columns with seeded scratch data`, async () => {
      const db = fixture();
      const stats = aggregateInsights(readInsightEvents(db), "30d", now);
      const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
      Object.assign(output, { columns, rows: 60, isTTY: false });
      let frame = "";
      output.on("data", chunk => { frame += chunk.toString(); });
      const input = new PassThrough();
      const width = full ? columns : Math.floor(columns * 0.45);
      const app = render(<Box>{!full && <Box width={columns - width}><Text>Session list</Text></Box>}<Insights stats={stats} width={width} full={full} /></Box>, { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
      await app.waitUntilRenderFlush();
      app.unmount();
      expect(frame).toContain("Insights");
      expect(frame).toContain("alpha");
      if (full) expect(frame).toContain("Repos · agent cost");
      db.close();
    });
  }
});

test("real dashboard on scratch TACK_HOME renders split, cycles full-screen, and resizes", async () => {
  // test/setup.ts assigns a fresh mkdtemp TACK_HOME before any Tack import.
  const db = getDb();
  const seed = fixture();
  for (const table of ["sessions", "agents", "session_prs", "session_jira_tickets"]) {
    const rows = seed.query(`SELECT * FROM ${table}`).all() as Record<string, string | number | null>[];
    for (const row of rows) {
      const columns = Object.keys(row);
      db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
    }
  }
  seed.close();
  const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  Object.assign(output, { columns: 160, rows: 60, isTTY: false });
  let frame = "";
  output.on("data", chunk => { frame += chunk.toString(); });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const app = render(<Dashboard config={null} onLaunch={() => {}} />, { stdout: output as unknown as NodeJS.WriteStream, stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  try {
    await app.waitUntilRenderFlush();
    expect(frame).toContain("split");
    expect(frame).toContain("Insights");
    const press = async (key: string) => {
      frame = "";
      input.write(key);
      await new Promise(resolve => setTimeout(resolve, 25));
      await app.waitUntilRenderFlush();
    };
    await press("s");
    expect(frame).toContain("list-only");
    expect(frame).not.toContain("Insights ·");
    await press("s");
    expect(frame).toContain("Insights");
    expect(frame).toContain("Repos · agent cost");
    await press("]");
    expect(frame).toContain("90d");
    frame = "";
    output.columns = 80;
    output.emit("resize");
    await new Promise(resolve => setTimeout(resolve, 25));
    await app.waitUntilRenderFlush();
    expect(frame).toContain("Insights");
    await press("s");
    expect(frame).toContain("list-only");
    // Cross both the 1s list poll and 5s Insights poll: unchanged data must
    // schedule no Ink frame even though both readers continue to run.
    frame = "";
    await new Promise(resolve => setTimeout(resolve, 5200));
    await app.waitUntilRenderFlush();
    expect(frame).toBe("");
  } finally {
    app.unmount();
    db.query("DELETE FROM sessions WHERE id IN ('old','new')").run();
  }
}, 15000);

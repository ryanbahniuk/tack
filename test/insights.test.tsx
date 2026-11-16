import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import React from "react";
import { PassThrough } from "node:stream";
import { Box, Text, render } from "ink";
import { migrate, getDb, readInsightEvents, createSession, upsertSessionPr, listSessionPrs, setSessionPrStatus, setSessionUsage, getSession } from "../src/db";
import { aggregateInsights, localDay } from "../src/cli/stats";
import { compress, heatmap, horizontalBars, pairedBars, sparkline, timeAxis } from "../src/cli/charts";
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
    expect(stats.totals).toEqual({ sessions: 1, agents: 3, prFix: 1, prs: 1, merged: 2, tickets: 1, done: 1, cost: 13, tokens: 0 });
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
  test("model totals include supervisor and agent usage, unknown models and range filtering", () => {
    const db = fixture();
    db.exec("UPDATE sessions SET supervisor_model = 'super', tokens_input = 100, tokens_output = 20, cache_read = 30, cache_write = 5");
    db.exec("UPDATE agents SET model = 'worker', tokens_input = 1000, tokens_output = 200, cache_read = 300, cache_write = 50 WHERE id IN ('a', 'b')");
    db.exec("UPDATE agents SET tokens_input = 10 WHERE id = 'c'");
    const events = readInsightEvents(db);
    expect(events).toContainEqual({ at: at(14), repo: null, model: "super", metric: "tokens", value: 155 });
    expect(events).toContainEqual({ at: at(14), repo: "alpha", model: "worker", metric: "tokens", value: 1550 });
    expect(events.filter(e => ["prs", "merged", "tickets", "done"].includes(e.metric)).every(e => e.model === null)).toBe(true);
    const stats = aggregateInsights(events, "7d", now);
    expect(stats.models).toEqual([
      { model: "worker", sessions: 0, agents: 2, tokens: 3100, cost: 9 },
      { model: "super", sessions: 1, agents: 0, tokens: 155, cost: 3 },
      { model: "unknown", sessions: 0, agents: 1, tokens: 10, cost: 1 },
    ]);
    expect(stats.models.reduce((sum, m) => sum + m.cost, 0)).toBe(stats.totals.cost);
    expect(stats.totals.tokens).toBe(3265);
    expect(stats.previous.tokens).toBe(155);
    expect(stats.deltas.tokens).toBe(3110);
    expect(stats.series.reduce((sum, b) => sum + b.tokens, 0)).toBe(3265);
    expect(stats.daily.at(-1)?.count).toBe(4);
    expect(aggregateInsights(events, "all", now).models.find(m => m.model === "super")).toMatchObject({ sessions: 2, tokens: 310, cost: 5 });
    db.close();
  });
  test("model ordering breaks ties by tokens, agents, sessions then name", () => {
    const events = [
      { model: "tokens", metric: "tokens" as const, value: 1 },
      { model: "agents", metric: "agents" as const, value: 1 },
      { model: "sessions", metric: "sessions" as const, value: 1 },
      { model: "z", metric: "cost" as const, value: 0 },
      { model: "a", metric: "cost" as const, value: 0 },
    ].map(e => ({ ...e, at: at(14), repo: null }));
    expect(aggregateInsights(events, "7d", now).models.map(m => m.model)).toEqual(["tokens", "agents", "sessions", "a", "z"]);
  });
  test("local day boundaries, partial comparison, and future events", () => {
    const events = [
      { at: new Date(2026, 10, 8, 0).toISOString(), repo: null, model: null, metric: "sessions" as const, value: 1 },
      { at: new Date(2026, 10, 7, 23, 59).toISOString(), repo: null, model: null, metric: "sessions" as const, value: 2 },
      { at: new Date(2026, 10, 7, 13).toISOString(), repo: null, model: null, metric: "sessions" as const, value: 100 },
      { at: new Date(2026, 10, 14, 13).toISOString(), repo: null, model: null, metric: "sessions" as const, value: 100 },
      { at: "invalid", repo: null, model: null, metric: "sessions" as const, value: 100 },
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
    const stats = aggregateInsights([{ at: at(1), repo: "repo", model: null, metric: "agents", value: 4 }], "7d", now);
    expect(stats.deltas.agents).toBe(-4);
    expect(stats.totals.agents).toBe(0);
    expect(stats.repos).toEqual([]);
    expect(stats.daily.every(d => d.count === 0)).toBe(true);
  });
});

describe("supervisor usage persistence and migration", () => {
  test("v9 defaults existing sessions to zero and is safe to rerun", () => {
    const db = fixture();
    db.exec("ALTER TABLE sessions DROP COLUMN tokens_input; ALTER TABLE sessions DROP COLUMN tokens_output; ALTER TABLE sessions DROP COLUMN cache_read; ALTER TABLE sessions DROP COLUMN cache_write; ALTER TABLE sessions DROP COLUMN supervisor_config_version; ALTER TABLE sessions DROP COLUMN pr_watch_config_version; ALTER TABLE sessions DROP COLUMN supervisor_code_version; ALTER TABLE sessions DROP COLUMN pr_watch_code_version; ALTER TABLE sessions DROP COLUMN supervisor_turn_started_at; ALTER TABLE agents DROP COLUMN fix_origin; ALTER TABLE agents DROP COLUMN continues_agent_id; ALTER TABLE agents DROP COLUMN continuation_prompt_ref; ALTER TABLE agents DROP COLUMN continuation_started_at; ALTER TABLE agents DROP COLUMN diff_base; ALTER TABLE agents DROP COLUMN fix_outcome; ALTER TABLE agents DROP COLUMN fix_pushed_sha; ALTER TABLE agents DROP COLUMN persona; ALTER TABLE agents DROP COLUMN reviews_agent_id; ALTER TABLE agents DROP COLUMN review_ref; ALTER TABLE session_prs DROP COLUMN ready_promoted_at; ALTER TABLE sessions DROP COLUMN pr_fix_enabled; ALTER TABLE sessions DROP COLUMN summary_ref; ALTER TABLE sessions DROP COLUMN summary_at; ALTER TABLE session_prs DROP COLUMN body_ref; DELETE FROM _migrations WHERE version >= 9");
    migrate(db);
    expect(db.query("SELECT tokens_input, tokens_output, cache_read, cache_write FROM sessions WHERE id = 'old'").get())
      .toEqual({ tokens_input: 0, tokens_output: 0, cache_read: 0, cache_write: 0 });
    expect(readInsightEvents(db).filter(e => e.metric === "tokens")).toEqual([]);
    migrate(db);
    db.close();
  });
  test("session usage overwrites the prior figure", () => {
    const session = createSession({});
    setSessionUsage(session.id, { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 });
    setSessionUsage(session.id, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(getSession(session.id)).toMatchObject({ tokens_input: 1, tokens_output: 2, cache_read: 3, cache_write: 4 });
  });
});

describe("merged_at persistence and migration", () => {
  test("v7 upgrades an existing v6 table without rewriting its data; rerun is safe", () => {
    const db = fixture();
    // Reconstruct the pre-v7 schema, removing later columns while preserving legacy rows.
    db.exec(`ALTER TABLE session_prs DROP COLUMN merged_at;
    ALTER TABLE agents DROP COLUMN interrupted_at;
    ALTER TABLE agents DROP COLUMN fix_origin; ALTER TABLE agents DROP COLUMN continues_agent_id; ALTER TABLE agents DROP COLUMN continuation_prompt_ref; ALTER TABLE agents DROP COLUMN continuation_started_at; ALTER TABLE agents DROP COLUMN diff_base;
    ALTER TABLE agents DROP COLUMN fix_outcome;
    ALTER TABLE agents DROP COLUMN fix_pushed_sha;
    ALTER TABLE sessions DROP COLUMN tokens_input;
    ALTER TABLE sessions DROP COLUMN tokens_output;
    ALTER TABLE sessions DROP COLUMN cache_read;
    ALTER TABLE sessions DROP COLUMN cache_write;
    ALTER TABLE sessions DROP COLUMN supervisor_config_version; ALTER TABLE sessions DROP COLUMN pr_watch_config_version; ALTER TABLE sessions DROP COLUMN supervisor_code_version;
    ALTER TABLE sessions DROP COLUMN pr_watch_code_version;
    ALTER TABLE sessions DROP COLUMN supervisor_turn_started_at;
    ALTER TABLE agents DROP COLUMN persona; ALTER TABLE agents DROP COLUMN reviews_agent_id; ALTER TABLE agents DROP COLUMN review_ref; ALTER TABLE session_prs DROP COLUMN ready_promoted_at; ALTER TABLE sessions DROP COLUMN pr_fix_enabled; ALTER TABLE sessions DROP COLUMN summary_ref; ALTER TABLE sessions DROP COLUMN summary_at; ALTER TABLE session_prs DROP COLUMN body_ref; DELETE FROM _migrations WHERE version >= 7`);
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
    expect(pairedBars([0, 1, 4], [4, 2, 0], 3)).toEqual(["·▂█", "█▄·"]);
    expect(pairedBars([0], [0], 1)).toEqual(["·", "·"]);
    const daily = Array.from({ length: 14 }, (_, i) => ({ day: `2026-11-${String(i + 2).padStart(2, "0")}`, count: i % 5 }));
    expect(heatmap(daily, 30)).toBe("    Nov 2\nMon ··▒▒\nTue ░░▓▓\nWed ▒▒██\nThu ▓▓··\nFri ██░░\nSat ··▒▒\nSun ░░▓▓\nless · ░ ▒ ▓ █ more\nmax 4/day");
    expect(heatmap(daily, 60)).toContain("max 4/day · blank = out of range");
    expect(heatmap([], 10)).toBe("");
    for (const width of [0, 1, 3, 10]) {
      expect(horizontalBars([{ label: "long name", value: 20 }], width).length).toBeLessThanOrEqual(width);
    }
  });
});

describe("chart labels and stretching", () => {
  test("whole bucket stretching and shared scales", () => {
    expect(sparkline([0, 1, 2], 10)).toBe("···▄▄▄███");
    expect(pairedBars([1, 0], [2, 1], 6)).toEqual(["▄▄▄···", "███▄▄▄"]);
    expect(sparkline([1], 5)).toBe("█████");
    expect(pairedBars([1, 2, 3, 4], [0, 0, 0, 0], 2)).toEqual(["▄█", "··"]);
  });
  test("axis endpoints and bucket units", () => {
    expect(timeAxis("2026-10-16", "2026-11-14", 30)).toBe("Oct 16────── day ───────Nov 14");
    expect(timeAxis("2026-10-01", "2026-11-14", 30, "month")).toContain("Oct 2026");
    expect(timeAxis("2026-10-01", "2026-11-14", 30, "month")).toEndWith("Nov 2026");
    expect(timeAxis("2026-10-01", "2026-11-14", 13, "month")).toBe("Oct 26 Nov 26");
  });
  test("heatmap distinguishes blank from zero and labels its first visible week", () => {
    const chart = heatmap([{ day: "2026-11-04", count: 0 }], 60);
    expect(chart).toContain("Nov 2");
    expect(chart).toContain("Mon   ");
    expect(chart).toContain("Wed ··");
    expect(chart).toContain("less · ░ ▒ ▓ █ more");
    expect(chart).toContain("max 0/day · blank = out of range");
  });
  test("every pure renderer obeys its width", () => {
    for (let width = 0; width <= 160; width++) {
      const daily = Array.from({ length: 90 }, (_, i) => ({ day: localDay(new Date(2026, 7, i + 1)), count: i % 5 }));
      const results = [sparkline([0, 1, 9], width), ...pairedBars([0, 4], [8, 1], width), heatmap(daily, width), timeAxis("2026-10-16", "2026-11-14", width), horizontalBars([{ label: "long repo", value: 100 }], width)];
      for (const result of results) for (const line of result.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});

/** Ink debug writes complete frames and a separate newline on unmount. Capture
 * the last complete frame so joined redraws cannot masquerade as overflow. */
async function renderFrame(node: React.ReactNode, columns: number): Promise<string> {
  const output = new PassThrough();
  Object.assign(output, { columns, rows: 100, isTTY: false });
  let frame = "";
  output.on("data", chunk => { if (chunk.toString().includes("Insights")) frame = Bun.stripANSI(chunk.toString()); });
  const app = render(node, { stdout: output as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  await app.waitUntilRenderFlush();
  app.unmount();
  return frame;
}

describe("Insights Ink smoke render", () => {
  for (const [full, columns] of [false, true].flatMap(full => [40, 72, 80, 160].map(columns => [full, columns] as const))) {
    test(`${full ? "full" : "split"} at ${columns} columns with seeded scratch data`, async () => {
      const db = fixture();
      const stats = aggregateInsights(readInsightEvents(db), "30d", now);
      const width = full ? columns : Math.floor(columns * 0.45);
      const frame = await renderFrame(<Box>{!full && <Box width={columns - width}><Text>Session list</Text></Box>}<Insights stats={stats} width={width} full={full} /></Box>, columns);
      for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
      // The surrounding list must not mask an overflowing Insights panel.
      const insightFrame = await renderFrame(<Insights stats={stats} width={width} full={full} />, width);
      for (const line of insightFrame.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
      if (process.env.INSIGHTS_FRAME_DIR) await Bun.write(`${process.env.INSIGHTS_FRAME_DIR}/${full ? "full" : "split"}-${columns}.txt`, insightFrame);
      expect(frame).toContain("Insights");
      expect(frame).toContain(columns === 40 && !full ? "alph" : "alpha");
      if (full) expect(frame).toContain("Repos · agent cost");
      db.close();
    });
  }
  test("compact token KPI values and deltas", async () => {
    for (const [count, formatted] of [[950, "950"], [12300, "12.3k"], [4100000, "4.1M"]] as const) {
      const stats = aggregateInsights([], "7d", now);
      stats.totals.tokens = count;
      stats.deltas.tokens = -count;
      const frame = await renderFrame(<Insights stats={stats} width={160} height={60} full />, 160);
      expect(frame).toMatch(new RegExp(`Tokens +${formatted.replace(".", "\\.")}`));
      expect(frame).toContain(`−${formatted} vs prev`);
    }
  });
  test("model table fits wide and stacked layouts and drops whole at short heights", async () => {
    const stats = aggregateInsights([], "7d", now);
    stats.models = Array.from({ length: 30 }, (_, i) => ({ model: `long-model-name-${i}`, sessions: 1, agents: 2, tokens: 12300, cost: 4 }));
    for (const full of [false, true]) for (const width of [24, 40, 72, 160]) {
      const frame = await renderFrame(<Insights stats={stats} width={width} height={60} full={full} />, width);
      expect(frame).toContain("Models");
      for (const label of ["Sessions", "Agents", "Tokens", "Cost", "12.3k", "$4.00"]) expect(frame).toContain(label);
      for (const line of frame.trimEnd().split("\n")) expect(line.length).toBeLessThanOrEqual(width);
      expect(frame.trimEnd().split("\n").length).toBeLessThanOrEqual(60);
      const short = await renderFrame(<Insights stats={stats} width={width} height={12} full={full} />, width);
      expect(short).not.toContain("Models");
    }
    const empty = await renderFrame(<Insights stats={aggregateInsights([], "7d", now)} width={80} height={70} />, 80);
    expect(empty).toContain("no models in range");
  });
  test("signed KPI comparisons, dollar scales, dates and explicit empty states", async () => {
    const db = fixture();
    const stats = aggregateInsights(readInsightEvents(db), "7d", now);
    stats.deltas.cost = -1.2;
    const frame = await renderFrame(<Insights stats={stats} width={160} full />, 160);
    for (const text of ["+3 vs prev", "−$1.20 vs prev", "no change", "$13.00 total · peak $7.00/day", "Nov 8", "Nov 14", "Done (approx.)"]) expect(frame).toContain(text);
    const empty = await renderFrame(<Insights stats={aggregateInsights([], "7d", now)} width={40} full />, 40);
    expect(empty).toContain("no PRs in range");
    expect(empty).toContain("no repos in range");
    db.close();
  });
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
    expect(frame.split("\n")[0]).toContain("│");
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

// Budget checks use real Ink frames, so Yoga borders, wrapping and column layout
// are covered alongside the arithmetic (without clipping the Insights component).
for (const full of [false, true]) {
  for (const width of [24, 72, 160]) {
    test(`Insights respects small budgets at width ${width}, full=${full}`, async () => {
      const db = fixture();
      const stats = aggregateInsights(readInsightEvents(db), "30d", now);
      stats.repos = Array.from({ length: 30 }, (_, i) => ({ repo: `repo-${i}`, agents: 20, prs: 4, merged: 3, cost: 100 }));
      stats.models = Array.from({ length: 30 }, (_, i) => ({ model: `model-${i}`, sessions: 1, agents: 20, tokens: 12300000, cost: 100 }));
      stats.totals.sessions = 123456789;
      try {
        for (const height of [0, 1, 5, 12, 24, 40]) {
          const output = new PassThrough();
          Object.assign(output, { columns: width, rows: 100, isTTY: false });
          let frame = "";
          output.on("data", chunk => { frame += chunk.toString(); });
          const app = render(<Insights stats={stats} width={width} height={height} full={full} />, {
            stdout: output as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream,
            debug: true, patchConsole: false, exitOnCtrlC: false,
          });
          try {
            await app.waitUntilRenderFlush();
            const lines = frame.trimEnd() ? frame.trimEnd().split("\n").length : 0;
            expect(lines).toBeLessThanOrEqual(height);
            if (height === 12) {
              expect(frame).toContain("Totals");
              expect(frame).not.toContain("Contributions");
              if (!full || width < 70) expect(frame).not.toContain("Top repos");
            }
          } finally {
            app.unmount();
          }
        }
      } finally {
        db.close();
      }
    });
  }
}

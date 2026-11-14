import { readInsightEvents, type InsightEvent, type InsightMetric } from "../db";

export const RANGES = ["7d", "30d", "90d", "1y", "all"] as const;
export type InsightRange = typeof RANGES[number];
export type BucketSize = "day" | "week" | "month";
export type Totals = Record<InsightMetric, number>;
export interface RepoTotal { repo: string; agents: number; prs: number; merged: number; cost: number }
export interface InsightStats {
  range: InsightRange;
  bucket: BucketSize;
  start: string;
  end: string;
  series: Array<Totals & { day: string }>;
  totals: Totals;
  previous: Totals;
  /** Absolute changes remain meaningful when the previous period is zero. */
  deltas: Totals;
  repos: RepoTotal[];
  daily: Array<{ day: string; count: number }>;
}
const zero = (): Totals => ({ sessions: 0, agents: 0, prFix: 0, prs: 0, merged: 0, tickets: 0, done: 0, cost: 0 });
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function midnight(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function shift(date: Date, days: number): Date {
  const next = new Date(date); next.setDate(next.getDate() + days); return next;
}
function bucketStart(date: Date, bucket: BucketSize): Date {
  const result = midnight(date);
  if (bucket === "week") result.setDate(result.getDate() - (result.getDay() + 6) % 7);
  if (bucket === "month") result.setDate(1);
  return result;
}

/** Calendar ranges include today and stop at `now`, excluding future records.
 * Comparison uses the same number of local days and the same time of day, so a
 * partial current day is compared fairly even across daylight-saving changes.
 * Ticket completion uses the last refresh time; it is an approximation, not a
 * transition log. PR/ticket counts represent session links, as stored in SQLite. */
export function aggregateInsights(events: readonly InsightEvent[], range: InsightRange = "30d", now = new Date(), width = 60): InsightStats {
  const today = midnight(now);
  const valid = events.filter(e => Number.isFinite(Date.parse(e.at)) && new Date(e.at) <= now);
  let days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 365;
  if (range === "all") {
    const first = valid.reduce((a, e) => new Date(e.at) < a ? midnight(new Date(e.at)) : a, today);
    // UTC calendar ordinals count local dates without treating DST days as 24h.
    days = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(first.getFullYear(), first.getMonth(), first.getDate())) / 86400000) + 1;
  }
  const start = shift(today, 1 - days);
  const previousStart = shift(start, -days);
  const previousEnd = shift(now, -days);
  const bucket: BucketSize = days <= 30 ? "day" : (range === "90d" || days / 7 <= Math.max(1, width)) ? "week" : "month";
  const series = new Map<string, Totals & { day: string }>();
  for (let d = bucketStart(start, bucket); d <= today;) {
    const day = localDay(d); series.set(day, { day, ...zero() });
    const next = new Date(d);
    if (bucket === "month") next.setMonth(next.getMonth() + 1);
    else next.setDate(next.getDate() + (bucket === "week" ? 7 : 1));
    d = next;
  }
  const daily = new Map<string, number>();
  for (let d = start; d <= today; d = shift(d, 1)) daily.set(localDay(d), 0);
  const totals = zero(), previous = zero();
  const repos = new Map<string, RepoTotal>();
  for (const event of valid) {
    const date = new Date(event.at);
    if (date >= previousStart && date <= previousEnd) previous[event.metric] += event.value;
    if (date < start) continue;
    totals[event.metric] += event.value;
    series.get(localDay(bucketStart(date, bucket)))![event.metric] += event.value;
    // Money and the pr_fix subset aren't extra contributions.
    if (event.metric !== "cost" && event.metric !== "prFix") {
      const day = localDay(date); daily.set(day, daily.get(day)! + event.value);
    }
    if (event.repo && ["agents", "prs", "merged", "cost"].includes(event.metric)) {
      const repo = repos.get(event.repo) ?? { repo: event.repo, agents: 0, prs: 0, merged: 0, cost: 0 };
      repo[event.metric as "agents" | "prs" | "merged" | "cost"] += event.value;
      repos.set(event.repo, repo);
    }
  }
  const deltas = zero();
  for (const key of Object.keys(totals) as InsightMetric[]) deltas[key] = totals[key] - previous[key];
  return { range, bucket, start: localDay(start), end: localDay(now), series: [...series.values()], totals, previous, deltas,
    repos: [...repos.values()].sort((a, b) => b.agents - a.agents || b.prs - a.prs || b.merged - a.merged || b.cost - a.cost || a.repo.localeCompare(b.repo)),
    daily: [...daily].map(([day, count]) => ({ day, count })) };
}

/** Repository I/O stays at this boundary; the aggregation itself is deterministic. */
export function readInsights(range: InsightRange, now = new Date(), width = 60): InsightStats {
  return aggregateInsights(readInsightEvents(), range, now, width);
}

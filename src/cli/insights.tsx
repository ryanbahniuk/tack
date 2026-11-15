import React from "react";
import { Box, Text } from "ink";
import type { InsightStats, Totals } from "./stats";
import { heatmap, horizontalBars, pairedBars, sparkline, timeAxis } from "./charts";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <Box borderStyle="round" flexDirection="column" paddingX={1}><Text dimColor wrap="truncate-end">{title}</Text>{children}</Box>;
}
const money = (n: number) => `$${n.toFixed(2)}`;
function delta(value: number, cost = false): string {
  return value === 0 ? "no change" : `${value < 0 ? "−" : "+"}${cost ? money(Math.abs(value)) : Math.abs(value)} vs prev`;
}
/** Match the label and optional summary gutters when choosing time buckets. */
export function insightChartWidth(column: number): number {
  const inner = Math.max(1, column - 4);
  return Math.max(1, inner - (inner < 28 ? 0 : 15) - (inner >= 65 ? 30 : 0));
}

/** Shared split/full panels keep labels and units identical at every size. */
export function Insights({ stats, width, rows = 40, full = false }: { stats: InsightStats; width: number; rows?: number; full?: boolean }) {
  const grid = full && width >= 70;
  const column = grid ? Math.floor(width / 2) : width;
  const inner = Math.max(1, column - 4), chartWidth = insightChartWidth(column);
  const stacked = inner < 28, gutter = stacked ? "" : " ".repeat(15);
  const series = (metric: keyof Totals) => stats.series.map(b => b[metric]);
  const timeChart = (title: string, metrics: readonly [string, keyof Totals, string][]) => {
    const values = metrics.map(([, key]) => series(key));
    const charts = values.length === 2 ? pairedBars(values[0]!, values[1]!, chartWidth) : [sparkline(values[0]!, chartWidth)];
    // Stretching uses whole columns per bucket; align the axis with the drawn span.
    const span = charts[0]?.length || chartWidth;
    return <Panel title={`${title} · per ${stats.bucket}`}>
      {title === "Cost" && <Text dimColor>Supervisor + agents</Text>}
      {stacked && <Text dimColor>Per {stats.bucket}</Text>}
      {metrics.map(([label, key, color], i) => {
        const format = key === "cost" ? money : String;
        const summary = `${format(stats.totals[key])} total · peak ${format(Math.max(0, ...values[i]!))}/${stats.bucket}`;
        return <React.Fragment key={key}>
          {stacked && <Text>{label}</Text>}
          <Text color={color}>{!stacked && label.padEnd(15)}{charts[i]?.padEnd(inner >= 65 ? chartWidth : charts[i]!.length)}{inner >= 65 && 16 + chartWidth + summary.length <= inner && ` ${summary}`}</Text>
        </React.Fragment>;
      })}
      {title === "Pull requests" && !stats.totals.prs && !stats.totals.merged && <Text dimColor>no PRs in range</Text>}
      <Text dimColor>{gutter}{timeAxis(stats.start, stats.end, span, stats.bucket)}</Text>
    </Panel>;
  };
  const top = stats.repos.slice(0, rows < 38 ? 3 : full ? 8 : 5);
  const kpis = ([["Sessions", "sessions"], ["Agents", "agents"], ["Opened", "prs"], ["Merged", "merged"], ["Linked", "tickets"], ["Done (approx.)", "done"], ["Cost", "cost"]] as const);
  const valueWidth = Math.max(...kpis.map(([, key]) => (key === "cost" ? money(stats.totals[key]) : String(stats.totals[key])).length));
  const deltaWidth = Math.max(...kpis.map(([, key]) => delta(stats.deltas[key], key === "cost").length));
  const kpiStack = 16 + valueWidth + deltaWidth > inner;
  const tinyKpi = 15 + valueWidth > inner;
  const left = <>
    <Panel title="Totals · vs previous period">
      {kpis.map(([label, key]) => <React.Fragment key={key}>
        {tinyKpi && <Text>{label}</Text>}
        <Text wrap="truncate-end">{!tinyKpi && `${label.padEnd(14)} `}{(key === "cost" ? money(stats.totals[key]) : String(stats.totals[key])).padStart(valueWidth)}{!kpiStack && " "}<Text color={stats.deltas[key] < 0 ? "red" : key === "cost" ? "yellow" : "green"}>{!kpiStack && delta(stats.deltas[key], key === "cost")}</Text></Text>
        {kpiStack && <Text color={stats.deltas[key] < 0 ? "red" : key === "cost" ? "yellow" : "green"}>{delta(stats.deltas[key], key === "cost")}</Text>}
      </React.Fragment>)}
    </Panel>
    {timeChart("Pull requests", [["Opened", "prs", "green"], ["Merged", "merged", "magenta"]])}
    {timeChart("Sessions + agents", [["Sessions", "sessions", "cyan"], ["Agents", "agents", "blue"]])}
    {timeChart("Cost", [["Cost", "cost", "yellow"]])}
  </>;
  const repoWidth = Math.max(1, inner - 27);
  const right = <>
    <Panel title="Repositories · agent count"><Text>{horizontalBars(top.map(r => ({ label: r.repo, value: r.agents })), inner)}</Text></Panel>
    <Panel title="Daily contributions">
      <Text>{heatmap(stats.daily, inner)}</Text>
      <Text dimColor wrap="wrap">Sessions, agents, PRs, tickets</Text>
      <Text dimColor wrap="wrap">Done uses last status refresh</Text>
    </Panel>
    {timeChart("Tickets", [["Linked", "tickets", "cyan"], ["Done (approx.)", "done", "green"]])}
    {full && <Panel title="Repos · agent cost">
      <Text dimColor wrap="truncate-end">Supervisor cost is unassigned</Text>
      <Text dimColor wrap="truncate-end">{"Repository".slice(0, repoWidth).padEnd(repoWidth)} {"Agents".padStart(6)} {"PRs".padStart(4)} {"Merged".padStart(6)} {"Cost".padStart(7)}</Text>
      {stats.repos.length ? stats.repos.map(r => <Text key={r.repo} wrap="truncate-end">{r.repo.slice(0, repoWidth).padEnd(repoWidth)} {String(r.agents).padStart(6)} {String(r.prs).padStart(4)} {String(r.merged).padStart(6)} {money(r.cost).padStart(7)}</Text>) : <Text dimColor>no repos in range</Text>}
    </Panel>}
  </>;
  return <Box width={width} flexDirection="column">
    <Text bold wrap="truncate-end">Insights · {stats.range} · all sessions</Text>
    <Box flexDirection={grid ? "row" : "column"}>
      {grid ? <><Box width={column} flexDirection="column">{left}</Box><Box width={width - column} flexDirection="column">{right}</Box></> : <Box width={width} flexDirection="column">{left}{right}</Box>}
    </Box>
  </Box>;
}

import React from "react";
import { Box, Text } from "ink";
import type { InsightStats, Totals } from "./stats";
import { heatmap, horizontalBars, pairedBars, sparkline } from "./charts";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <Box borderStyle="round" flexDirection="column" paddingX={1}><Text dimColor>{title}</Text>{children}</Box>;
}
const money = (n: number) => `$${n.toFixed(2)}`;
function delta(value: number, cost = false): string {
  return `${value < 0 ? "▼" : value > 0 ? "▲" : "="}${cost ? money(Math.abs(value)) : Math.abs(value)}`;
}

/** Shared split/full-screen panels keep the metrics and legends identical while
 * the full view spends its extra width on longer series and a repository table. */
export function Insights({ stats, width, rows = 40, full = false }: { stats: InsightStats; width: number; rows?: number; full?: boolean }) {
  const grid = full && width >= 70;
  const column = grid ? Math.floor(width / 2) : width;
  const chartWidth = Math.max(1, column - 6);
  const series = (metric: keyof Totals) => stats.series.map(b => b[metric]);
  const [opened, merged] = pairedBars(series("prs"), series("merged"), Math.max(1, chartWidth - 7));
  const top = stats.repos.slice(0, rows < 38 ? 3 : full ? 8 : 5);
  const kpis = ([ ["Sessions", "sessions"], ["Agents", "agents"], ["PRs", "prs"], ["Merged", "merged"], ["Tickets", "tickets"], ["Done≈", "done"], ["Cost", "cost"] ] as const);
  const left = <>
    <Panel title="Totals · change vs previous period">
      <Box flexWrap="wrap" columnGap={2}>{kpis.map(([label, key]) => <Text key={key}>{label} {key === "cost" ? money(stats.totals[key]) : stats.totals[key]} <Text dimColor>{delta(stats.deltas[key], key === "cost")}</Text></Text>)}</Box>
    </Panel>
    <Panel title={`PRs over time · ${stats.bucket}`}>
      {stats.totals.prs || stats.totals.merged ? <>
        <Text color="green">opened {opened}</Text><Text color="magenta">merged {merged}</Text>
      </> : <Text dimColor>no PRs in range</Text>}
      <Text dimColor>{stats.start} → {stats.end}</Text>
    </Panel>
    <Panel title="Sessions / agents">
      <Text>ses {sparkline(series("sessions"), chartWidth - 4)}</Text>
      <Text>agt {sparkline(series("agents"), chartWidth - 4)}</Text>
    </Panel>
    <Panel title="Cost · supervisor + agents"><Text color="green">{sparkline(series("cost"), chartWidth)}</Text></Panel>
  </>;
  const right = <>
    <Panel title="Top repos · agents"><Text>{horizontalBars(top.map(r => ({ label: r.repo, value: r.agents })), chartWidth)}</Text></Panel>
    <Panel title="Contributions · Mon–Sun · · ░ ▒ ▓ █">
      <Text>{heatmap(stats.daily, chartWidth)}</Text>
      <Text dimColor>sessions, agents, PRs, tickets · done≈refresh</Text>
    </Panel>
    <Panel title="Tickets linked / done≈">
      <Text>link {sparkline(series("tickets"), chartWidth - 5)}</Text>
      <Text>done {sparkline(series("done"), chartWidth - 5)}</Text>
    </Panel>
    {full && <Panel title="Repos · agent cost (supervisor unassigned)">
      <Text dimColor>{"repo".padEnd(Math.max(1, chartWidth - 27))} agents  PRs merged  cost</Text>
      {stats.repos.length ? stats.repos.map(r => <Text key={r.repo}>{r.repo.slice(0, Math.max(1, chartWidth - 27)).padEnd(Math.max(1, chartWidth - 27))} {String(r.agents).padStart(6)} {String(r.prs).padStart(4)} {String(r.merged).padStart(6)} {money(r.cost).padStart(7)}</Text>) : <Text dimColor>no repos in range</Text>}
    </Panel>}
  </>;
  return <Box width={width} flexDirection="column">
    <Text bold>Insights · {stats.range} · all sessions</Text>
    <Box flexDirection={grid ? "row" : "column"}>
      {grid ? <><Box width={column} flexDirection="column">{left}</Box><Box width={width - column} flexDirection="column">{right}</Box></> : <Box width={width} flexDirection="column">{left}{right}</Box>}
    </Box>
  </Box>;
}

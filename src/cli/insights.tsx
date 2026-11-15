import React from "react";
import { Box, Text } from "ink";
import type { InsightStats, Totals } from "./stats";
import { heatmap, horizontalBars, pairedBars, sparkline } from "./charts";

function Panel({ title, lines }: { title: string; lines: React.ReactNode[] }) {
  return <Box borderStyle="round" flexDirection="column" paddingX={1} flexShrink={0}>
    <Text dimColor wrap="truncate">{title}</Text>
    {lines.map((line, i) => <Text key={i} wrap="truncate">{line}</Text>)}
  </Box>;
}
const money = (n: number) => `$${n.toFixed(2)}`;
function delta(value: number, cost = false): string {
  return `${value < 0 ? "▼" : value > 0 ? "▲" : "="}${cost ? money(Math.abs(value)) : Math.abs(value)}`;
}

type PanelSpec = { title: string; lines: React.ReactNode[] };

/** Each panel is indivisible: two borders, a title, then explicit content rows.
 * Use the same budget independently in each full-screen column. */
export function Insights({ stats, width, rows = 40, height = rows, full = false }: { stats: InsightStats; width: number; rows?: number; height?: number; full?: boolean }) {
  const grid = full && width >= 70;
  const column = grid ? Math.floor(width / 2) : width;
  const chartWidth = Math.max(1, column - 6);
  const series = (metric: keyof Totals) => stats.series.map(b => b[metric]);
  const [opened, merged] = pairedBars(series("prs"), series("merged"), Math.max(1, chartWidth - 7));
  const top = stats.repos.slice(0, rows < 38 ? 3 : full ? 8 : 5);
  const kpis = ([ ["Sessions", "sessions"], ["Agents", "agents"], ["PRs", "prs"], ["Merged", "merged"], ["Tickets", "tickets"], ["Done≈", "done"], ["Cost", "cost"] ] as const);
  // Pack explicit rows rather than relying on Yoga's flex-wrap, so large totals
  // and narrow columns cannot silently increase a panel's measured height.
  const kpiLines: string[] = [];
  for (const [label, key] of kpis) {
    const text = `${label} ${key === "cost" ? money(stats.totals[key]) : stats.totals[key]} ${delta(stats.deltas[key], key === "cost")}`;
    const last = kpiLines.length - 1;
    if (last >= 0 && kpiLines[last]!.length + 2 + text.length <= column - 4) kpiLines[last] += `  ${text}`;
    else kpiLines.push(text);
  }
  const primary: PanelSpec[] = [
    { title: "Totals · change vs previous period", lines: kpiLines },
    { title: `PRs over time · ${stats.bucket}`, lines: [
      ...(stats.totals.prs || stats.totals.merged ? [<Text color="green">opened {opened}</Text>, <Text color="magenta">merged {merged}</Text>] : [<Text dimColor>no PRs in range</Text>]),
      <Text dimColor>{stats.start} → {stats.end}</Text>,
    ] },
    { title: "Cost · supervisor + agents", lines: [<Text color="green">{sparkline(series("cost"), chartWidth)}</Text>] },
    { title: "Sessions / agents", lines: [`ses ${sparkline(series("sessions"), chartWidth - 4)}`, `agt ${sparkline(series("agents"), chartWidth - 4)}`] },
  ];
  const secondary: PanelSpec[] = [
    { title: "Top repos · agents", lines: horizontalBars(top.map(r => ({ label: r.repo, value: r.agents })), chartWidth).split("\n") },
    { title: "Tickets linked / done≈", lines: [`link ${sparkline(series("tickets"), chartWidth - 5)}`, `done ${sparkline(series("done"), chartWidth - 5)}`] },
    { title: "Contributions · Mon–Sun · · ░ ▒ ▓ █", lines: [...heatmap(stats.daily, chartWidth).split("\n"), <Text dimColor>sessions, agents, PRs, tickets · done≈refresh</Text>] },
  ];
  const renderColumn = (panels: PanelSpec[], table = false) => {
    let remaining = Math.max(0, height - 1);
    const fitted: PanelSpec[] = [];
    for (const panel of panels) {
      const cost = panel.lines.length + 3;
      if (cost > remaining) continue;
      fitted.push(panel);
      remaining -= cost;
    }
    // The table can use the remaining rows, but always includes its own header
    // and at least one repository (or the empty-state row).
    if (table && remaining >= 5) {
      const labelWidth = Math.max(1, chartWidth - 27);
      fitted.push({ title: "Repos · agent cost (supervisor unassigned)", lines: [
        <Text dimColor>{"repo".padEnd(labelWidth)} agents  PRs merged  cost</Text>,
        ...(stats.repos.length ? stats.repos.slice(0, remaining - 4).map(r => `${r.repo.slice(0, labelWidth).padEnd(labelWidth)} ${String(r.agents).padStart(6)} ${String(r.prs).padStart(4)} ${String(r.merged).padStart(6)} ${money(r.cost).padStart(7)}`) : [<Text dimColor>no repos in range</Text>]),
      ] });
    }
    return fitted.map(panel => <Panel key={panel.title} {...panel} />);
  };
  if (height < 1) return null;
  return <Box width={width} flexDirection="column" flexShrink={0}>
    <Text bold wrap="truncate">Insights · {stats.range} · all sessions</Text>
    <Box flexDirection={grid ? "row" : "column"}>
      {grid ? <><Box width={column} flexDirection="column">{renderColumn(primary)}</Box><Box width={width - column} flexDirection="column">{renderColumn(secondary, true)}</Box></> : <Box width={width} flexDirection="column">{renderColumn([...primary, ...secondary], full)}</Box>}
    </Box>
  </Box>;
}

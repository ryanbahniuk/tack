import React from "react";
import { Box, Text } from "ink";
import type { InsightStats, Totals } from "./stats";
import { heatmap, horizontalBars, pairedBars, sparkline, timeAxis } from "./charts";

function Panel({ title, lines }: { title: string; lines: React.ReactNode[] }) {
  return <Box borderStyle="round" flexDirection="column" paddingX={1} flexShrink={0}>
    <Text dimColor wrap="truncate">{title}</Text>
    {lines.map((line, i) => <Text key={i} wrap="truncate">{line}</Text>)}
  </Box>;
}
const money = (n: number) => `$${n.toFixed(2)}`;
const tokens = (n: number): string => {
  for (const [scale, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]] as const) {
    if (Math.abs(n) >= scale) return `${Number((n / scale).toFixed(1))}${suffix}`;
  }
  return String(n);
};
function delta(value: number, key: keyof Totals): string {
  return value === 0 ? "no change" : `${value < 0 ? "−" : "+"}${key === "cost" ? money(Math.abs(value)) : key === "tokens" ? tokens(Math.abs(value)) : Math.abs(value)} vs prev`;
}
/** Match the label and optional summary gutters when choosing time buckets. */
export function insightChartWidth(column: number): number {
  const inner = Math.max(1, column - 4);
  return Math.max(1, inner - (inner < 28 ? 0 : 15) - (inner >= 65 ? 30 : 0));
}

type PanelSpec = { title: string; lines: React.ReactNode[] };

/** Each panel is indivisible: two borders, a title, then explicit content rows.
 * Use the same budget independently in each full-screen column. */
export function Insights({ stats, width, rows = 40, height = rows, full = false }: { stats: InsightStats; width: number; rows?: number; height?: number; full?: boolean }) {
  const grid = full && width >= 70;
  const column = grid ? Math.floor(width / 2) : width;
  const inner = Math.max(1, column - 4), chartWidth = insightChartWidth(column);
  const stacked = inner < 28, gutter = stacked ? "" : " ".repeat(15);
  const series = (metric: keyof Totals) => stats.series.map(b => b[metric]);
  // Every chart is a flat list of rows so renderColumn's `lines + 3` height
  // budget stays exact: one node per terminal row, no fragments.
  const timeChart = (title: string, metrics: readonly [string, keyof Totals, string][]): PanelSpec => {
    const values = metrics.map(([, key]) => series(key));
    const charts = values.length === 2 ? pairedBars(values[0]!, values[1]!, chartWidth) : [sparkline(values[0]!, chartWidth)];
    // Stretching uses whole columns per bucket; align the axis with the drawn span.
    const span = charts[0]?.length || chartWidth;
    const lines: React.ReactNode[] = [];
    if (title === "Cost") lines.push(<Text dimColor>Supervisor + agents</Text>);
    if (stacked) lines.push(<Text dimColor>Per {stats.bucket}</Text>);
    metrics.forEach(([label, key, color], i) => {
      const format = key === "cost" ? money : String;
      const summary = `${format(stats.totals[key])} total · peak ${format(Math.max(0, ...values[i]!))}/${stats.bucket}`;
      if (stacked) lines.push(label);
      lines.push(<Text color={color}>{!stacked && label.padEnd(15)}{charts[i]?.padEnd(inner >= 65 ? chartWidth : charts[i]!.length)}{inner >= 65 && 16 + chartWidth + summary.length <= inner && ` ${summary}`}</Text>);
    });
    if (title === "Pull requests" && !stats.totals.prs && !stats.totals.merged) lines.push(<Text dimColor>no PRs in range</Text>);
    lines.push(<Text dimColor>{gutter}{timeAxis(stats.start, stats.end, span, stats.bucket)}</Text>);
    return { title: `${title} · per ${stats.bucket}`, lines };
  };
  const top = stats.repos.slice(0, rows < 38 ? 3 : full ? 8 : 5);
  const kpis = ([["Sessions", "sessions"], ["Agents", "agents"], ["Tokens", "tokens"], ["Opened", "prs"], ["Merged", "merged"], ["Linked", "tickets"], ["Done (approx.)", "done"], ["Cost", "cost"]] as const);
  const value = (key: keyof Totals) => key === "cost" ? money(stats.totals[key]) : key === "tokens" ? tokens(stats.totals[key]) : String(stats.totals[key]);
  const valueWidth = Math.max(...kpis.map(([, key]) => value(key).length));
  const deltaWidth = Math.max(...kpis.map(([, key]) => delta(stats.deltas[key], key).length));
  // An aligned one-row-per-KPI table when it fits; otherwise pack explicit rows
  // rather than relying on Yoga's flex-wrap, so large totals and narrow columns
  // cannot silently increase a panel's measured height.
  const kpiLines: React.ReactNode[] = [];
  if (16 + valueWidth + deltaWidth <= inner) {
    for (const [label, key] of kpis) kpiLines.push(<Text>{label.padEnd(14)} {value(key).padStart(valueWidth)} <Text color={stats.deltas[key] < 0 ? "red" : key === "cost" ? "yellow" : "green"}>{delta(stats.deltas[key], key)}</Text></Text>);
  } else {
    const packed: string[] = [];
    for (const [label, key] of kpis) {
      const text = `${label} ${value(key)} ${delta(stats.deltas[key], key)}`;
      const last = packed.length - 1;
      if (last >= 0 && packed[last]!.length + 2 + text.length <= inner) packed[last] += `  ${text}`;
      else packed.push(text);
    }
    kpiLines.push(...packed);
  }
  const primary: PanelSpec[] = [
    { title: "Totals · vs previous period", lines: kpiLines },
    timeChart("Pull requests", [["Opened", "prs", "green"], ["Merged", "merged", "magenta"]]),
    timeChart("Sessions + agents", [["Sessions", "sessions", "cyan"], ["Agents", "agents", "blue"]]),
    timeChart("Cost", [["Cost", "cost", "yellow"]]),
  ];
  const secondary: PanelSpec[] = [
    { title: "Repositories · agent count", lines: horizontalBars(top.map(r => ({ label: r.repo, value: r.agents })), inner).split("\n") },
    { title: "Daily contributions", lines: [...heatmap(stats.daily, inner).split("\n"), <Text dimColor>Sessions, agents, PRs, tickets</Text>, <Text dimColor>Done uses last status refresh</Text>] },
    timeChart("Tickets", [["Linked", "tickets", "cyan"], ["Done (approx.)", "done", "green"]]),
  ];
  // "table" marks where the repo cost table competes for rows; it sizes itself
  // to what is left and always includes its note, header and at least one
  // repository (or the empty-state row).
  const renderColumn = (panels: (PanelSpec | "table" | "models")[]) => {
    let remaining = Math.max(0, height - 1);
    const fitted: PanelSpec[] = [];
    for (const item of panels) {
      let panel = item;
      if (panel === "models") {
        const data = stats.models.map(m => [m.model, String(m.sessions), String(m.agents), tokens(m.tokens), money(m.cost)]);
        const headers = ["Model", "Sessions", "Agents", "Tokens", "Cost"];
        const widths = headers.map((h, i) => Math.max(h.length, ...data.map(row => row[i]!.length)));
        const numericWidth = widths.slice(1).reduce((sum, w) => sum + w, 0) + 4;
        const modelWidth = Math.min(widths[0]!, inner - numericWidth);
        const modelStacked = stacked || modelWidth < 5;
        // Stacked records still use explicit rows: no wrapping or fragments that
        // would invalidate the panel budget. Keep a whole record or drop it.
        const recordRows = modelStacked ? 5 : 1;
        const capacity = Math.floor((remaining - 4) / recordRows);
        if (remaining < 5 || (data.length > 0 && capacity < 1)) continue;
        const format = (row: string[]) => row.map((cell, i) => i === 0
          ? cell.slice(0, modelWidth).padEnd(modelWidth)
          : cell.padStart(widths[i]!)).join(" ");
        panel = { title: "Models · sessions, agents, tokens, cost", lines: [
          <Text dimColor>{modelStacked ? "Model" : format(headers)}</Text>,
          ...(data.length ? data.slice(0, capacity).flatMap(row => modelStacked
            ? [row[0]!, ...row.slice(1).map((cell, i) => `${headers[i + 1]} ${cell}`)]
            : [format(row)]) : [<Text dimColor>no models in range</Text>]),
        ] };
      }
      if (panel === "table") {
        if (remaining < 6) continue;
        const repoWidth = Math.max(1, inner - 27);
        panel = { title: "Repos · agent cost", lines: [
          <Text dimColor>Supervisor cost is unassigned</Text>,
          <Text dimColor>{"Repository".slice(0, repoWidth).padEnd(repoWidth)} {"Agents".padStart(6)} {"PRs".padStart(4)} {"Merged".padStart(6)} {"Cost".padStart(7)}</Text>,
          ...(stats.repos.length ? stats.repos.slice(0, remaining - 5).map(r => `${r.repo.slice(0, repoWidth).padEnd(repoWidth)} ${String(r.agents).padStart(6)} ${String(r.prs).padStart(4)} ${String(r.merged).padStart(6)} ${money(r.cost).padStart(7)}`) : [<Text dimColor>no repos in range</Text>]),
        ] };
      }
      const cost = panel.lines.length + 3;
      if (cost > remaining) continue;
      fitted.push(panel);
      remaining -= cost;
    }
    return fitted.map(panel => <Panel key={panel.title} {...panel} />);
  };
  // A single column can't show everything at typical heights, so repos follow
  // the headline Totals and PRs rather than being starved at the bottom.
  const [totals, prs, ...restPrimary] = primary;
  const [repos, ...restSecondary] = secondary;
  const single: (PanelSpec | "table" | "models")[] = [totals!, prs!, repos!, "models", ...(full ? ["table" as const] : []), ...restPrimary, ...restSecondary];
  if (height < 1) return null;
  return <Box width={width} flexDirection="column" flexShrink={0}>
    <Text bold wrap="truncate">Insights · {stats.range} · all sessions</Text>
    <Box flexDirection={grid ? "row" : "column"}>
      {grid ? <><Box width={column} flexDirection="column">{renderColumn([totals!, "models", prs!, ...restPrimary])}</Box><Box width={width - column} flexDirection="column">{renderColumn([...secondary, "table"])}</Box></> : <Box width={width} flexDirection="column">{renderColumn(single)}</Box>}
    </Box>
  </Box>;
}

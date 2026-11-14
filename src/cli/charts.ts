/** Pure Unicode renderers keep the charts useful in monochrome terminals and make
 * width/empty-state behavior testable without an Ink renderer. */
const size = (width: number) => Math.max(0, Math.floor(width));
const positive = (n: number) => Number.isFinite(n) ? Math.max(0, n) : 0;

/** Compress contiguous samples by sum so narrow charts don't lose contributions. */
export function compress(values: readonly number[], width: number): number[] {
  const count = Math.min(values.length, size(width));
  return Array.from({ length: count }, (_, i) => values.slice(Math.floor(i * values.length / count), Math.floor((i + 1) * values.length / count)).reduce((a, b) => a + positive(b), 0));
}
export function sparkline(values: readonly number[], width: number): string {
  const samples = compress(values, width), max = Math.max(0, ...samples);
  return samples.map(n => max === 0 || n === 0 ? "·" : "▁▂▃▄▅▆▇█"[Math.ceil(n / max * 8) - 1]).join("");
}
export function horizontalBars(rows: readonly { label: string; value: number }[], width: number): string {
  const w = size(width);
  if (!rows.length) return "no repos in range".slice(0, w);
  const labelWidth = Math.min(18, Math.floor(w / 3));
  const max = Math.max(0, ...rows.map(r => positive(r.value)));
  return rows.map(r => {
    const value = String(r.value);
    const room = Math.max(0, w - labelWidth - value.length - 2);
    return `${r.label.slice(0, labelWidth).padEnd(labelWidth)} ${"█".repeat(max ? Math.round(positive(r.value) / max * room) : 0)} ${value}`.slice(0, w);
  }).join("\n");
}

/** Paired rows share a scale. The two textures identify opened/merged without color. */
export function pairedBars(opened: readonly number[], merged: readonly number[], width: number): [string, string] {
  const a = compress(opened, width), b = compress(merged, width);
  const max = Math.max(0, ...a, ...b);
  const draw = (values: number[], glyphs: string) => values.map(n => !n || !max ? "·" : glyphs[Math.ceil(n / max * 4) - 1]).join("");
  return [draw(a, "░▒▓█"), draw(b, "▁▃▅▇")];
}

/** Weeks run left to right, Monday through Sunday top to bottom. Blank cells
 * outside the range differ from zero-activity days (·); recent weeks fit width. */
export function heatmap(daily: readonly { day: string; count: number }[], width: number): string {
  if (!daily.length || width < 1) return "";
  const first = new Date(`${daily[0]!.day}T00:00:00`);
  const offset = (first.getDay() + 6) % 7;
  const weeks = Math.ceil((offset + daily.length) / 7);
  const start = Math.max(0, weeks - size(width));
  const max = Math.max(0, ...daily.map(d => positive(d.count)));
  return Array.from({ length: 7 }, (_, day) => Array.from({ length: weeks - start }, (_, col) => {
    const entry = daily[(col + start) * 7 + day - offset];
    return !entry ? " " : !entry.count || !max ? "·" : "░▒▓█"[Math.ceil(positive(entry.count) / max * 4) - 1];
  }).join("")).join("\n");
}

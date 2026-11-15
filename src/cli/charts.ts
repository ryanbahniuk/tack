/** Pure Unicode renderers keep charts readable without terminal colors. */
const size = (width: number) => Math.max(0, Math.floor(width));
const positive = (n: number) => Number.isFinite(n) ? Math.max(0, n) : 0;

/** Compress contiguous samples by sum so narrow charts don't lose contributions. */
export function compress(values: readonly number[], width: number): number[] {
  const count = Math.min(values.length, size(width));
  return Array.from({ length: count }, (_, i) => values.slice(Math.floor(i * values.length / count), Math.floor((i + 1) * values.length / count)).reduce((a, b) => a + positive(b), 0));
}
function draw(samples: number[], max: number, width: number): string {
  const repeat = samples.length ? Math.max(1, Math.floor(size(width) / samples.length)) : 1;
  return samples.map(n => (n && max ? "▁▂▃▄▅▆▇█"[Math.ceil(n / max * 8) - 1]! : "·").repeat(repeat)).join("");
}
export function sparkline(values: readonly number[], width: number): string {
  const samples = compress(values, width);
  return draw(samples, Math.max(0, ...samples), width);
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

/** Labels and color identify paired rows; heights use one shared scale. */
export function pairedBars(a: readonly number[], b: readonly number[], width: number): [string, string] {
  const first = compress(a, width), second = compress(b, width);
  const max = Math.max(0, ...first, ...second);
  return [draw(first, max, width), draw(second, max, width)];
}
const shortDate = (day: string, monthly = false) => new Date(`${day}T00:00:00`).toLocaleDateString("en-US", monthly ? { month: "short", year: "numeric" } : { month: "short", day: "numeric" });

/** The caller dims this line. Keep both endpoints whenever they fit. */
export function timeAxis(start: string, end: string, width: number, bucket = "day"): string {
  const w = size(width);
  let left = shortDate(start, bucket === "month"), right = shortDate(end, bucket === "month");
  if (left.length + right.length + 1 > w) {
    const compact = (label: string) => bucket === "month" ? label.replace(/20(\d\d)$/, "$1") : label.replace(" ", "");
    left = compact(left); right = compact(right);
  }
  if (left.length + right.length + 1 > w) {
    left = left.slice(0, 3); right = right.slice(0, 3);
  }
  if (left.length + right.length + 1 > w) return `${left} ${right}`.slice(0, w);
  const gap = w - left.length - right.length;
  const unit = ` ${bucket} `;
  return left + (gap >= unit.length + 2 ? unit.padStart(Math.floor((gap + unit.length) / 2), "─").padEnd(gap, "─") : " ".repeat(gap)) + right;
}

/** Weeks run left to right, Monday through Sunday. Blank cells are outside the
 * range; recent weeks win when the full range cannot fit. */
export function heatmap(daily: readonly { day: string; count: number }[], width: number): string {
  const w = size(width);
  if (!daily.length || !w) return "";
  const first = new Date(`${daily[0]!.day}T00:00:00`);
  const offset = (first.getDay() + 6) % 7;
  const weeks = Math.ceil((offset + daily.length) / 7);
  const gutter = Math.min(4, Math.max(0, w - 1));
  const room = w - gutter, cell = room >= weeks * 2 ? 2 : 1;
  const start = Math.max(0, weeks - Math.floor(room / cell));
  const max = Math.max(0, ...daily.map(d => positive(d.count)));
  const marker = new Date(first);
  marker.setDate(first.getDate() + start * 7 - offset);
  const lines = [(`${" ".repeat(gutter)}${shortDate(`${marker.getFullYear()}-${String(marker.getMonth() + 1).padStart(2, "0")}-${String(marker.getDate()).padStart(2, "0")}`)}`).slice(0, w)];
  for (let day = 0; day < 7; day++) {
    lines.push((["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]!.slice(0, gutter).padEnd(gutter) + Array.from({ length: weeks - start }, (_, col) => {
      const entry = daily[(col + start) * 7 + day - offset];
      const glyph = !entry ? " " : !entry.count || !max ? "·" : "░▒▓█"[Math.ceil(positive(entry.count) / max * 4) - 1]!;
      return glyph.repeat(cell);
    }).join("")).slice(0, w));
  }
  const legend = "less · ░ ▒ ▓ █ more", scale = `max ${max}/day`, note = " · blank = out of range";
  let key = `${legend} · ${scale}`;
  if (key.length > w) {
    if (legend.length <= w) lines.push(legend);
    else lines.push(...["less", "· ░ ▒ ▓ █", "more"].map(line => line.slice(0, w)));
    key = scale;
  }
  lines.push((key + (key.length + note.length <= w ? note : "")).slice(0, w));
  return lines.join("\n");
}

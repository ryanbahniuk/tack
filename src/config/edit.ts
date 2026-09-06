import { readFileSync, writeFileSync } from "node:fs";
import { ConfigSchema, type RuntimeKind, type RuntimeSettings } from "./schema";

/**
 * Programmatic edits to the user's `config.ts`. The config is a hand-authored TS
 * module we want to keep readable, so we do surgical text edits rather than
 * re-serializing the whole thing (which would drop the file's comments). Only the
 * `runtimes:` block is regenerated; everything else is preserved byte-for-byte.
 */

/**
 * Replaces line comments and string bodies with spaces, preserving length and
 * newlines. Brace-scanning then sees only structural braces — a `{` inside a
 * comment or string won't be miscounted — while character offsets still map back
 * onto the original source for replacement.
 */
function maskNonCode(src: string): string {
  let out = "";
  let inString: string | null = null;
  let inLineComment = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inLineComment) {
      out += c === "\n" ? ((inLineComment = false), "\n") : " ";
      continue;
    }
    if (inString) {
      if (c === "\\") {
        out += "  "; // blank the escape + escaped char, keeping length aligned
        i++;
        continue;
      }
      if (c === inString) inString = null;
      out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "/" && n === "/") {
      inLineComment = true;
      out += "  ";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

/** Index of the `}` that closes the `{` at `open`, or -1 if unbalanced. */
function matchBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Serializes one runtime's settings to a single-line object literal. */
function serializeRuntimeSettings(s: RuntimeSettings): string {
  const parts: string[] = [];
  if (s.bin) parts.push(`bin: ${JSON.stringify(s.bin)}`);
  if (s.version) parts.push(`version: ${JSON.stringify(s.version)}`);
  return `{ ${parts.join(", ")} }`;
}

/** Serializes the whole `runtimes:` block at the given base indentation. */
function serializeRuntimes(runtimes: Record<string, RuntimeSettings | undefined>, indent: string): string {
  const entries = Object.entries(runtimes).filter(
    (e): e is [string, RuntimeSettings] => Boolean(e[1] && (e[1].bin || e[1].version)),
  );
  if (entries.length === 0) return "runtimes: {}";
  const inner = indent + "  ";
  const lines = entries.map(([k, v]) => `${inner}${k}: ${serializeRuntimeSettings(v)},`);
  return `runtimes: {\n${lines.join("\n")}\n${indent}}`;
}

/**
 * Pins `kind` to `version` in the config file, preserving the rest of the file. The
 * current runtime settings are read back from the parsed config (so an existing
 * `bin` override is kept), the version is merged in, and only the `runtimes:` block
 * is rewritten in place.
 */
export async function pinRuntimeInConfig(configPath: string, kind: RuntimeKind, version: string): Promise<void> {
  const src = readFileSync(configPath, "utf8");
  const mod = (await import(configPath)) as { default?: unknown; config?: unknown };
  const parsed = ConfigSchema.parse(mod.default ?? mod.config);

  const runtimes: Record<string, RuntimeSettings | undefined> = { ...parsed.runtimes };
  runtimes[kind] = { ...runtimes[kind], version };

  const masked = maskNonCode(src);
  const m = /(^|\n)([^\S\n]*)runtimes[^\S\n]*:[^\S\n]*\{/.exec(masked);
  if (!m) throw new Error(`Could not find a \`runtimes:\` block in ${configPath}.`);
  // Keep the original indentation in the preserved prefix; the serialized block's
  // first line ("runtimes: {") carries no leading indent and sits right after it.
  const start = m.index + m[1]!.length + m[2]!.length; // start of the `runtimes` keyword
  const open = m.index + m[0].length - 1; // index of the opening `{`
  const close = matchBrace(masked, open);
  if (close < 0) throw new Error(`Unbalanced braces in the \`runtimes:\` block in ${configPath}.`);

  const next = src.slice(0, start) + serializeRuntimes(runtimes, m[2]!) + src.slice(close + 1);
  writeFileSync(configPath, next, "utf8");
}

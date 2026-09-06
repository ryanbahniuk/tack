import { readFileSync, statSync, writeFileSync } from "node:fs";
import { expandHome } from "../paths";
import { ConfigSchema, type Project, type RuntimeKind, type RuntimeSettings } from "./schema";

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

/** Index of the closer that balances the opener at `open`, or -1 if unbalanced. */
function matchDelimiter(masked: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === openCh) depth++;
    else if (masked[i] === closeCh && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `}` that closes the `{` at `open`, or -1 if unbalanced. */
function matchBrace(masked: string, open: number): number {
  return matchDelimiter(masked, open, "{", "}");
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

/** Serializes one project to a single-line object literal. */
function serializeProject(p: Project): string {
  return `{ name: ${JSON.stringify(p.name)}, path: ${JSON.stringify(p.path)}, description: ${JSON.stringify(p.description)} }`;
}

/** Serializes the whole `projects:` array at the given base indentation. */
function serializeProjects(projects: Project[], indent: string): string {
  if (projects.length === 0) return "projects: []";
  const inner = indent + "  ";
  const lines = projects.map((p) => `${inner}${serializeProject(p)},`);
  return `projects: [\n${lines.join("\n")}\n${indent}]`;
}

/**
 * Appends projects to the config file, preserving the rest of the file. Existing
 * projects are read back from the parsed config and the new entries are merged in,
 * skipping any whose name or (home-expanded) path already exists; only the
 * `projects:` array is rewritten in place. Returns the entries actually added.
 */
export async function addProjectsToConfig(configPath: string, entries: Project[]): Promise<Project[]> {
  const src = readFileSync(configPath, "utf8");
  // Cache-bust the import: Bun caches modules by path, so a plain re-import can
  // return a stale copy if the config was already loaded (or written) this process.
  const mod = (await import(`${configPath}?v=${statSync(configPath).mtimeMs}`)) as {
    default?: unknown;
    config?: unknown;
  };
  const parsed = ConfigSchema.parse(mod.default ?? mod.config);

  const existingNames = new Set(parsed.projects.map((p) => p.name));
  const existingPaths = new Set(parsed.projects.map((p) => expandHome(p.path)));
  const added: Project[] = [];
  for (const e of entries) {
    if (existingNames.has(e.name) || existingPaths.has(expandHome(e.path))) continue;
    existingNames.add(e.name);
    existingPaths.add(expandHome(e.path));
    added.push(e);
  }
  if (added.length === 0) return [];

  const masked = maskNonCode(src);
  const m = /(^|\n)([^\S\n]*)projects[^\S\n]*:[^\S\n]*\[/.exec(masked);
  if (!m) throw new Error(`Could not find a \`projects:\` block in ${configPath}.`);
  const start = m.index + m[1]!.length + m[2]!.length; // start of the `projects` keyword
  const open = m.index + m[0].length - 1; // index of the opening `[`
  const close = matchDelimiter(masked, open, "[", "]");
  if (close < 0) throw new Error(`Unbalanced brackets in the \`projects:\` block in ${configPath}.`);

  const next = src.slice(0, start) + serializeProjects([...parsed.projects, ...added], m[2]!) + src.slice(close + 1);
  writeFileSync(configPath, next, "utf8");
  return added;
}

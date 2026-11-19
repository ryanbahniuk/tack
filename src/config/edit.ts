import { readFileSync, statSync, writeFileSync } from "node:fs";
import { expandHome } from "../paths";
import {
  ConfigSchema,
  type Model,
  type Pricing,
  type Project,
  type ProjectMetadata,
  type Roles,
  type RuntimeKind,
  type RuntimeSettings,
} from "./schema";

/**
 * Programmatic edits to the user's `config.ts`. The config is a hand-authored TS
 * module we want to keep readable, so we do surgical text edits rather than
 * re-serializing the whole thing (which would drop the file's comments). Each
 * writer regenerates only the top-level property it owns, through
 * `replaceTopLevelProperty`; everything else is preserved byte-for-byte.
 */

/**
 * Replaces comments and string bodies (quotes included) with filler, preserving
 * length and newlines. Brace-scanning then sees only structural braces — a `{`
 * inside a comment or string won't be miscounted — while character offsets still
 * map back onto the original source for replacement. Comments become spaces, so
 * they trim like whitespace; strings become `x`, so a string still reads as a token
 * (a quoted key, a scalar value) and is never trimmed away.
 */
function maskNonCode(src: string): string {
  const stringFill = "x";
  let out = "";
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inLineComment) {
      out += c === "\n" ? ((inLineComment = false), "\n") : " ";
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") {
        inBlockComment = false;
        out += "  ";
        i++;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (inString) {
      if (c === "\\") {
        out += stringFill + stringFill; // blank the escape + escaped char, keeping length aligned
        i++;
        continue;
      }
      if (c === inString) inString = null;
      out += c === "\n" ? "\n" : stringFill;
      continue;
    }
    if (c === "/" && n === "/") {
      inLineComment = true;
      out += "  ";
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlockComment = true;
      out += "  ";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += stringFill;
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

const OPENERS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Locates the braces of the exported config object: `export default {…}`,
 * `export default defineConfig({…})` / `({…})`, `export default config` naming a
 * `const config = {…}` declared earlier, or `export const config = {…}` (the two
 * shapes `loadConfig` accepts). Returns `[open, close]` offsets of the braces.
 */
function findConfigObject(masked: string): [number, number] {
  // Optional parens / a single call wrapper (e.g. `defineConfig(`) before the `{`.
  const objectAt = (from: number): number => {
    const m = /^[\s(]*(?:[A-Za-z_$][\w$.]*\s*\(\s*)?\{/.exec(masked.slice(from));
    return m ? from + m[0].length - 1 : -1;
  };
  let open = -1;
  const def = /export\s+default\s+/.exec(masked);
  if (def) {
    const at = def.index + def[0].length;
    open = objectAt(at);
    const named = open < 0 ? /^([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/.exec(masked.slice(at)) : null;
    if (named) {
      const decl = new RegExp(`(?:const|let|var)\\s+${named[1]!.replace(/\$/g, "\\$")}\\s*(?::[^=]*)?=\\s*`).exec(masked);
      if (decl) open = objectAt(decl.index + decl[0].length);
    }
  }
  if (open < 0) {
    const named = /export\s+const\s+config\s*(?::[^=]*)?=\s*/.exec(masked);
    if (named) open = objectAt(named.index + named[0].length);
  }
  if (open < 0) throw new Error("Could not find the exported config object.");
  const close = matchDelimiter(masked, open, "{", "}");
  if (close < 0) throw new Error("Unbalanced braces in the exported config object.");
  return [open, close];
}

/** A top-level property's location: the key's start, the value's [start, end). */
interface PropertySpan {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

/**
 * Lists the exported object's top-level properties (depth 1 only — a nested
 * `models:` inside some other block is never mistaken for the real one). `masked`
 * must come from `maskNonCode(src)` so quoted keys and string values are
 * visible as tokens. Spreads and shorthand properties are skipped: they can't be
 * rewritten as text, and validation catches any edit they would shadow.
 */
function topLevelProperties(src: string, masked: string, open: number, close: number): PropertySpan[] {
  const props: PropertySpan[] = [];
  let i = open + 1;
  while (i < close) {
    while (i < close && /[\s,]/.test(masked[i]!)) i++;
    if (i >= close) break;
    const token = /^[\w$]+/.exec(masked.slice(i, close));
    let j = i + (token ? token[0].length : 0);
    while (j < close && /\s/.test(masked[j]!)) j++;
    const isKey = token && masked[j] === ":";
    const keyStart = i;
    let valueStart = i;
    if (isKey) {
      const raw = src.slice(i, i + token[0].length);
      const key = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
      valueStart = j + 1;
      while (valueStart < close && /\s/.test(masked[valueStart]!)) valueStart++;
      props.push({ key, keyStart, valueStart, valueEnd: valueStart });
    }
    // Walk to the end of this property: the next depth-0 comma or the closing brace.
    let k = valueStart;
    while (k < close && masked[k] !== ",") {
      const closer = OPENERS[masked[k]!];
      if (closer) {
        const end = matchDelimiter(masked, k, masked[k]!, closer);
        if (end < 0) throw new Error("Unbalanced brackets in the config.");
        k = end + 1;
      } else k++;
    }
    let end = k;
    while (end > valueStart && /\s/.test(masked[end - 1]!)) end--; // drop trailing whitespace/comments
    if (isKey) props[props.length - 1]!.valueEnd = end;
    i = k + 1;
  }
  return props;
}

/** Renders an object key: bare when it's an identifier, quoted otherwise. */
function formatKey(key: string): string {
  return IDENT.test(key) ? key : JSON.stringify(key);
}

/** Leading whitespace of the line `pos` is on, or null if code precedes `pos` on it. */
function lineIndent(src: string, pos: number): string | null {
  const lead = src.slice(src.lastIndexOf("\n", pos - 1) + 1, pos);
  return /^[^\S\n]*$/.test(lead) ? lead : null;
}

/**
 * Rewrites one top-level property of the exported config object, preserving every
 * other byte of the file (comments, blank lines, other blocks, the property's own
 * trailing comma and comment). `literal` is the new value text, or a function of
 * the property's indentation for multi-line values whose closing bracket must line
 * up with the key. When the property is absent it is inserted just before the
 * object's closing brace, at the other top-level keys' indentation. `null` removes
 * the property (with its comma, and its line when nothing else is on it).
 */
export function replaceTopLevelProperty(
  src: string,
  key: string,
  literal: string | null | ((indent: string) => string),
): string {
  const masked = maskNonCode(src);
  const [open, close] = findConfigObject(masked);
  const props = topLevelProperties(src, masked, open, close);
  const render = (indent: string) => (typeof literal === "function" ? literal(indent) : literal!);
  const hit = props.find((p) => p.key === key);

  if (hit && literal === null) {
    let from = hit.keyStart;
    let to = hit.valueEnd;
    let k = to;
    while (k < close && /[^\S\n]/.test(masked[k]!)) k++;
    if (masked[k] === ",") to = k + 1;
    const lineStart = src.lastIndexOf("\n", from - 1) + 1;
    const nl = src.indexOf("\n", to);
    const lineEnd = nl < 0 ? src.length : nl;
    // Alone on its line (no other code, no trailing comment): drop the whole line.
    if (lineIndent(src, from) !== null && /^[^\S\n]*$/.test(src.slice(to, lineEnd)) && nl >= 0) {
      from = lineStart;
      to = lineEnd + 1;
    } else {
      while (to < src.length && /[^\S\n]/.test(src[to]!)) to++;
    }
    return src.slice(0, from) + src.slice(to);
  }
  if (hit) {
    const indent = lineIndent(src, hit.keyStart) ?? "";
    return src.slice(0, hit.keyStart) + `${formatKey(key)}: ${render(indent)}` + src.slice(hit.valueEnd);
  }
  if (literal === null) return src;

  // Insert before the closing brace, matching the first top-level key's indentation.
  const indent = (props[0] && lineIndent(src, props[0].keyStart)) ?? "  ";
  let last = close - 1;
  while (last > open && /\s/.test(masked[last]!)) last--;
  const comma = last > open && masked[last] !== "," ? "," : "";
  const property = `${indent}${formatKey(key)}: ${render(indent)},\n`;
  const closeLine = src.lastIndexOf("\n", close - 1) + 1;
  if (closeLine > last && lineIndent(src, close) !== null) {
    // The `}` sits on its own line: insert a full line above it, after any comments.
    return src.slice(0, last + 1) + comma + src.slice(last + 1, closeLine) + property + src.slice(closeLine);
  }
  return src.slice(0, last + 1) + comma + src.slice(last + 1, close).trimEnd() + "\n" + property + src.slice(close);
}

/** Rewrites one top-level property of the config file in place (see `replaceTopLevelProperty`). */
function writeTopLevelProperty(configPath: string, key: string, literal: (indent: string) => string): void {
  const src = readFileSync(configPath, "utf8");
  writeFileSync(configPath, replaceTopLevelProperty(src, key, literal), "utf8");
}

/** Single-line TS literal for `value`: `{ a: 1, b: ["x"] }`. */
export function inlineTsLiteral(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineTsLiteral).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([k, v]) => `${formatKey(k)}: ${inlineTsLiteral(v)}`).join(", ")} }`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Generic TS literal for config values without a dedicated serializer, styled like
 * the hand-authored file: identifier keys bare, strings via `JSON.stringify`,
 * arrays of objects one element per line (as projects and models are written),
 * nested objects multi-line, and short primitive arrays inline. `indent` is the
 * indentation of the line the value starts on, so closers line up with the key.
 */
export function toTsLiteral(value: unknown, indent: string): string {
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => !v || typeof v !== "object")) return inlineTsLiteral(value);
    const lines = value.map((v) => `${inner}${isPlainObject(v) ? inlineTsLiteral(v) : toTsLiteral(v, inner)},`);
    return `[\n${lines.join("\n")}\n${indent}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    const lines = entries.map(([k, v]) => `${inner}${formatKey(k)}: ${toTsLiteral(v, inner)},`);
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
  return inlineTsLiteral(value);
}

/** Serializes one runtime's settings to a single-line object literal. */
function serializeRuntimeSettings(s: RuntimeSettings): string {
  const parts: string[] = [];
  if (s.bin) parts.push(`bin: ${JSON.stringify(s.bin)}`);
  if (s.version) parts.push(`version: ${JSON.stringify(s.version)}`);
  if (s.versionPolicy) parts.push(`versionPolicy: ${JSON.stringify(s.versionPolicy)}`);
  return `{ ${parts.join(", ")} }`;
}

/** Serializes the `runtimes:` value at the given base indentation. */
export function serializeRuntimes(runtimes: Record<string, RuntimeSettings | undefined>, indent: string): string {
  const entries = Object.entries(runtimes).filter(
    (e): e is [string, RuntimeSettings] => Boolean(e[1] && (e[1].bin || e[1].version || e[1].versionPolicy)),
  );
  if (entries.length === 0) return "{}";
  const inner = indent + "  ";
  const lines = entries.map(([k, v]) => `${inner}${k}: ${serializeRuntimeSettings(v)},`);
  return `{\n${lines.join("\n")}\n${indent}}`;
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
  writeFileSync(configPath, replaceTopLevelProperty(src, "runtimes", (indent) => serializeRuntimes(runtimes, indent)), "utf8");
}

/**
 * Re-pins several runtimes at once, merging each new `version` into that runtime's
 * existing settings (keeping any `bin`/`versionPolicy`) and rewriting the `runtimes:`
 * block in place. Used by `tack runtimes sync` to adopt the versions currently
 * installed. Only entries present in `versionByKind` are touched. Returns the kinds
 * whose pin actually changed.
 */
export async function setRuntimeVersionsInConfig(
  configPath: string,
  versionByKind: Map<RuntimeKind, string>,
): Promise<RuntimeKind[]> {
  const parsed = await loadParsedConfig(configPath);
  const runtimes: Record<string, RuntimeSettings | undefined> = { ...parsed.runtimes };
  const changed: RuntimeKind[] = [];
  for (const [kind, version] of versionByKind) {
    if (runtimes[kind]?.version === version) continue;
    runtimes[kind] = { ...runtimes[kind], version };
    changed.push(kind);
  }
  if (changed.length === 0) return [];

  writeTopLevelProperty(configPath, "runtimes", (indent) => serializeRuntimes(runtimes, indent));
  return changed;
}

/** Serializes the `roles:` value at the given base indentation, one role per
 * line in the object's existing key order. */
export function serializeRoles(roles: Roles, indent: string): string {
  const inner = indent + "  ";
  const lines = (Object.keys(roles) as (keyof Roles)[]).map((k) => {
    const value = roles[k];
    const keys = Array.isArray(value) ? value : [value];
    const literal = keys.length === 1 ? JSON.stringify(keys[0]) : `[${keys.map((key) => JSON.stringify(key)).join(", ")}]`;
    return `${inner}${k}: ${literal},`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/**
 * Pins `role` to one or more model keys, preserving the rest of the config file
 * (comments, other blocks, indentation). The current roles are read back from the
 * parsed config and the one role is swapped, so untouched roles keep their pins; only
 * the `roles:` block is rewritten in place. Returns the role's previous string or list.
 * Validation that the role and keys are legal lives with the caller, which has
 * the loaded config to check that every model exists.
 */
export async function setRoleInConfig(
  configPath: string,
  role: keyof Roles,
  keyOrKeys: string | string[],
): Promise<string | string[]> {
  const parsed = await loadParsedConfig(configPath);
  const previous = parsed.roles[role];
  const next: Roles = { ...parsed.roles, [role]: keyOrKeys };
  writeTopLevelProperty(configPath, "roles", (indent) => serializeRoles(next, indent));
  return previous;
}

/** Serializes a project's tech-stack metadata to a single-line object literal. */
function serializeMetadata(m: ProjectMetadata): string {
  const frameworks = m.frameworks.map((f) => JSON.stringify(f)).join(", ");
  return `{ language: ${JSON.stringify(m.language)}, frameworks: [${frameworks}] }`;
}

/**
 * Fields a row serializer doesn't write by name (a project's `boot`, anything a
 * later schema adds), rendered inline after the known ones. Without this a rewrite
 * of the `projects:` block silently dropped every project's boot recipe.
 */
function extraFields(row: object, known: readonly string[]): string[] {
  return Object.entries(row)
    .filter(([k, v]) => !known.includes(k) && v !== undefined)
    .map(([k, v]) => `${formatKey(k)}: ${inlineTsLiteral(v)}`);
}

const PROJECT_FIELDS = ["name", "path", "description", "metadata"] as const;

/** Serializes one project to a single-line object literal, keeping every field. */
function serializeProject(p: Project): string {
  const parts = [
    `name: ${JSON.stringify(p.name)}`,
    `path: ${JSON.stringify(p.path)}`,
    `description: ${JSON.stringify(p.description)}`,
  ];
  if (p.metadata) parts.push(`metadata: ${serializeMetadata(p.metadata)}`);
  parts.push(...extraFields(p, PROJECT_FIELDS));
  return `{ ${parts.join(", ")} }`;
}

/** Serializes the `projects:` value at the given base indentation. */
export function serializeProjects(projects: Project[], indent: string): string {
  if (projects.length === 0) return "[]";
  const inner = indent + "  ";
  const lines = projects.map((p) => `${inner}${serializeProject(p)},`);
  return `[\n${lines.join("\n")}\n${indent}]`;
}

/**
 * Reads and validates the config file. The import is cache-busted because Bun
 * caches modules by path, so a plain re-import can return a stale copy if the
 * config was already loaded (or written) this process.
 */
async function loadParsedConfig(configPath: string): Promise<ReturnType<typeof ConfigSchema.parse>> {
  const mod = (await import(`${configPath}?v=${statSync(configPath).mtimeMs}`)) as {
    default?: unknown;
    config?: unknown;
  };
  return ConfigSchema.parse(mod.default ?? mod.config);
}

/**
 * Rewrites the `projects:` array in place with `next`, preserving the rest of the
 * file byte-for-byte (comments, other blocks, indentation). Callers derive `next`
 * from the parsed config so hand-authored ordering of untouched entries is kept.
 */
function writeProjectsBlock(configPath: string, next: Project[]): void {
  writeTopLevelProperty(configPath, "projects", (indent) => serializeProjects(next, indent));
}

/** True if `p` is the project identified by `target` (its name or home-expanded path). */
function projectMatches(p: Project, target: string): boolean {
  return p.name === target || expandHome(p.path) === expandHome(target);
}

/**
 * Appends projects to the config file, preserving the rest of the file. Existing
 * projects are read back from the parsed config and the new entries are merged in,
 * skipping any whose name or (home-expanded) path already exists; only the
 * `projects:` array is rewritten in place. Returns the entries actually added.
 */
export async function addProjectsToConfig(configPath: string, entries: Project[]): Promise<Project[]> {
  const parsed = await loadParsedConfig(configPath);

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

  writeProjectsBlock(configPath, [...parsed.projects, ...added]);
  return added;
}

/**
 * Replaces the project matching `updated` (by name or home-expanded path) with
 * `updated`, in place. Everything else in the file is preserved. Returns the
 * previous entry, or null if no project matched (nothing is written).
 */
export async function updateProjectInConfig(configPath: string, updated: Project): Promise<Project | null> {
  const parsed = await loadParsedConfig(configPath);
  const idx = parsed.projects.findIndex((p) => p.name === updated.name || expandHome(p.path) === expandHome(updated.path));
  if (idx < 0) return null;
  const previous = parsed.projects[idx]!;
  const next = parsed.projects.map((p, i) => (i === idx ? updated : p));
  writeProjectsBlock(configPath, next);
  return previous;
}

/**
 * Removes the project matching `target` (its name or home-expanded path) from the
 * config file, preserving the rest of the file. Returns the removed entry, or null
 * if none matched (nothing is written).
 */
export async function removeProjectFromConfig(configPath: string, target: string): Promise<Project | null> {
  const parsed = await loadParsedConfig(configPath);
  const idx = parsed.projects.findIndex((p) => projectMatches(p, target));
  if (idx < 0) return null;
  const removed = parsed.projects[idx]!;
  writeProjectsBlock(configPath, parsed.projects.filter((_, i) => i !== idx));
  return removed;
}

/** Serializes a model's optional pricing table, omitting unset rates. */
function serializePricing(p: Pricing): string {
  const parts: string[] = [];
  if (p.inputPer1M !== undefined) parts.push(`inputPer1M: ${p.inputPer1M}`);
  if (p.outputPer1M !== undefined) parts.push(`outputPer1M: ${p.outputPer1M}`);
  if (p.cacheReadPer1M !== undefined) parts.push(`cacheReadPer1M: ${p.cacheReadPer1M}`);
  if (p.cacheWritePer1M !== undefined) parts.push(`cacheWritePer1M: ${p.cacheWritePer1M}`);
  return `{ ${parts.join(", ")} }`;
}

const MODEL_FIELDS = ["key", "provider", "name", "version", "runtime", "id", "effort", "pricing"] as const;

/** Serializes one model to a single-line object literal, keeping every field. */
function serializeModel(m: Model): string {
  const parts = [
    `key: ${JSON.stringify(m.key)}`,
    `provider: ${JSON.stringify(m.provider)}`,
    `name: ${JSON.stringify(m.name)}`,
    `version: ${JSON.stringify(m.version)}`,
    `runtime: ${JSON.stringify(m.runtime)}`,
    `id: ${JSON.stringify(m.id)}`,
  ];
  if (m.effort) parts.push(`effort: ${JSON.stringify(m.effort)}`);
  if (m.pricing) parts.push(`pricing: ${serializePricing(m.pricing)}`);
  parts.push(...extraFields(m, MODEL_FIELDS));
  return `{ ${parts.join(", ")} }`;
}

/** Serializes the `models:` value at the given base indentation. */
export function serializeModels(models: Model[], indent: string): string {
  if (models.length === 0) return "[]";
  const inner = indent + "  ";
  const lines = models.map((m) => `${inner}${serializeModel(m)},`);
  return `[\n${lines.join("\n")}\n${indent}]`;
}

/**
 * Rewrites the `models:` array in place with `next`, preserving the rest of the
 * file byte-for-byte (comments, other blocks, indentation). Mirrors
 * `writeProjectsBlock`.
 */
function writeModelsBlock(configPath: string, next: Model[]): void {
  writeTopLevelProperty(configPath, "models", (indent) => serializeModels(next, indent));
}

/**
 * Appends models to the config file, preserving the rest of the file. Existing
 * models are read back from the parsed config and the new entries are merged in,
 * skipping any whose `key` already exists; only the `models:` array is rewritten
 * in place. Returns the entries actually added.
 */
export async function addModelsToConfig(configPath: string, entries: Model[]): Promise<Model[]> {
  const parsed = await loadParsedConfig(configPath);

  const existingKeys = new Set(parsed.models.map((m) => m.key));
  const added: Model[] = [];
  for (const e of entries) {
    if (existingKeys.has(e.key)) continue;
    existingKeys.add(e.key);
    added.push(e);
  }
  if (added.length === 0) return [];

  writeModelsBlock(configPath, [...parsed.models, ...added]);
  return added;
}

/**
 * Removes the configured models whose `key` is in `keys`, rewriting the `models:`
 * array in place and preserving the rest of the file. Callers must first re-pin any
 * role still pointing at one of these — `loadConfig` rejects a role naming a missing
 * model, so removing first would leave a config that no longer loads. Returns the
 * entries actually removed.
 */
export async function removeModelsFromConfig(configPath: string, keys: Set<string>): Promise<Model[]> {
  const parsed = await loadParsedConfig(configPath);
  const removed = parsed.models.filter((m) => keys.has(m.key));
  if (removed.length === 0) return [];
  writeModelsBlock(configPath, parsed.models.filter((m) => !keys.has(m.key)));
  return removed;
}

/**
 * Sets `pricing` on the configured models named in `pricingByKey` (keyed by model
 * `key`), rewriting the `models:` array in place and preserving the rest of the
 * file. Only models present in both the config and the map are touched. Returns the
 * keys actually updated.
 */
export async function setModelsPricingInConfig(
  configPath: string,
  pricingByKey: Map<string, Pricing>,
): Promise<string[]> {
  const parsed = await loadParsedConfig(configPath);
  const updated: string[] = [];
  const next = parsed.models.map((m) => {
    const pricing = pricingByKey.get(m.key);
    if (!pricing) return m;
    updated.push(m.key);
    return { ...m, pricing };
  });
  if (updated.length === 0) return [];
  writeModelsBlock(configPath, next);
  return updated;
}

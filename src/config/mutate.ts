import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { replaceTopLevelProperty, serializeModels, serializeProjects, serializeRoles, serializeRuntimes, toTsLiteral } from "./edit";
import { loadConfig } from "./load";
import { ConfigSchema, ModelSchema, ProjectSchema, RolesSchema, RuntimesSchema, type TackConfig } from "./schema";

/**
 * Structured edits to the user's `config.ts`, built for the supervisor's
 * `update_config` tool (and reusable by a future CLI). A change is computed and
 * fully validated first (`prepareConfigChange`) so the human can be shown an exact
 * diff, then written only on confirmation (`commitConfigChange`). Edits apply to
 * the RAW authored export, never the parsed config, so schema defaults the user
 * never wrote don't get baked into their file, and only the touched top-level
 * properties are re-rendered — comments and every other block survive verbatim.
 */

/**
 * One edit. `path` is a segment list, not a dotted string, because model keys
 * contain dots (`gpt-5.1`). Inside the `projects`/`personas`/`models` arrays a
 * segment names an element by its identifier (`name`, or `key` for models);
 * elsewhere segments are object keys (or numeric indexes into plain arrays).
 */
export const ConfigChangeSchema = z.object({
  op: z.enum(["set", "unset"]),
  path: z.array(z.string().min(1)).min(1),
  value: z.unknown().optional(),
});
export type ConfigChange = z.infer<typeof ConfigChangeSchema>;

/**
 * Keys a session may never change, at any depth, because each one can run or
 * widen something: `supervisorMcpServers` are arbitrary commands whose tools are
 * auto-allowed, a runtime's `bin` is an arbitrary executable, `readAllowlist`
 * widens what the supervisor can read, and boot recipes are shell commands. These
 * stay with the human, in their editor.
 */
export const CONFIG_DENYLIST = ["supervisorMcpServers", "runtimes", "readAllowlist", "bootRecipes", "projects.<name>.boot"];
const DENIED_TOP = new Set(["supervisorMcpServers", "runtimes", "readAllowlist", "bootRecipes"]);

/** Arrays addressed by an element identifier rather than an index. */
const IDENTIFIED: Record<string, string> = { projects: "name", personas: "name", models: "key" };

export interface PreparedConfigChange {
  configPath: string;
  before: string;
  after: string;
  /** Unified, line-based diff of `before` → `after`, shown in the confirmation. */
  diff: string;
  /** Display form of each change's path, e.g. `models["gpt-5.1"].effort`. */
  changedPaths: string[];
  /** SHA-256 of `before`; commit aborts if the file no longer hashes to this. */
  hash: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** `models["gpt-5.1"].effort` — identifier segments dotted, the rest bracket-quoted. */
export function formatConfigPath(path: string[]): string {
  return path.map((s, i) => (/^[A-Za-z_$][\w$]*$/.test(s) ? (i ? `.${s}` : s) : `[${JSON.stringify(s)}]`)).join("");
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function denied(path: string[]): never {
  throw new Error(`${formatConfigPath(path)} can't be changed from a session (it can run commands or widen access). Ask the human to edit it with \`tack config edit\`.`);
}

/**
 * Refuses denylisted paths up front, for a clear error naming what was asked.
 * `checkDenylistInvariant` re-checks the outcome, so an indirect route (setting
 * the whole `projects` array, renaming a project onto another's boot) can't slip by.
 */
function checkDeniedPath(change: ConfigChange): void {
  const { path } = change;
  if (DENIED_TOP.has(path[0]!)) denied(path);
  if (path[0] === "projects" && path.length >= 3 && path[2] === "boot") denied(path);
  const carriesBoot = (v: unknown) => isObject(v) && "boot" in v;
  if (change.op === "set" && path[0] === "projects") {
    if (path.length === 2 && carriesBoot(change.value)) denied([...path, "boot"]);
    if (path.length === 1 && Array.isArray(change.value) && change.value.some(carriesBoot)) denied(["projects", "<name>", "boot"]);
  }
  if (change.op === "set" && path.length === 1 && isObject(change.value)) {
    // Setting a whole top-level object can't smuggle denylisted keys in either.
    for (const k of Object.keys(change.value)) if (DENIED_TOP.has(k)) denied([k]);
  }
}

/** Every denylisted value must come out of the change exactly as it went in. */
function checkDenylistInvariant(before: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const key of DENIED_TOP) if (!isDeepStrictEqual(before[key], after[key])) denied([key]);
  const boots = (raw: Record<string, unknown>) =>
    new Map(
      (Array.isArray(raw.projects) ? raw.projects : [])
        .filter((p): p is Record<string, unknown> => isObject(p) && p.boot !== undefined)
        .map((p) => [String(p.name), p.boot]),
    );
  const was = boots(before);
  const now = boots(after);
  for (const [name, boot] of was) {
    // Dropping a project's boot block (removing the project, or overwriting the
    // array) is refused too: the human decides what happens to boot commands.
    if (!now.has(name) || !isDeepStrictEqual(now.get(name), boot)) denied(["projects", name, "boot"]);
  }
  for (const name of now.keys()) if (!was.has(name)) denied(["projects", name, "boot"]);
}

/** Applies one change to `root` in place. */
function applyChange(root: Record<string, unknown>, change: ConfigChange): void {
  const { op, path } = change;
  if (!(path[0]! in ConfigSchema.shape)) {
    throw new Error(`Unknown config setting "${path[0]}". Known: ${Object.keys(ConfigSchema.shape).join(", ")}`);
  }
  if (op === "set" && change.value === undefined) throw new Error(`set ${formatConfigPath(path)} needs a value (use unset to remove it).`);
  let container: unknown = root;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const last = i === path.length - 1;
    const where = formatConfigPath(path.slice(0, i + 1));
    const idField = i === 1 ? IDENTIFIED[path[0]!] : undefined;
    if (Array.isArray(container) && idField) {
      const arr = container as unknown[];
      const idx = arr.findIndex((e) => isObject(e) && e[idField] === seg);
      if (last) {
        if (op === "unset") {
          if (idx < 0) throw new Error(`No ${path[0]} entry with ${idField} "${seg}".`);
          arr.splice(idx, 1);
          return;
        }
        // A whole element: its identifier must match the segment that names it.
        if (!isObject(change.value) || change.value[idField] !== seg) {
          throw new Error(`${where} must be set to an object whose ${idField} is ${JSON.stringify(seg)}.`);
        }
        const value = structuredClone(change.value);
        const existing = idx >= 0 ? arr[idx] : undefined;
        // Replacing a project keeps its boot block (which the session can't author).
        if (isObject(existing) && existing.boot !== undefined && value.boot === undefined) value.boot = existing.boot;
        if (idx >= 0) arr[idx] = value;
        else arr.push(value);
        return;
      }
      if (idx < 0) throw new Error(`No ${path[0]} entry with ${idField} "${seg}".`);
      container = arr[idx];
      continue;
    }
    if (Array.isArray(container)) {
      const arr = container as unknown[];
      const idx = /^\d+$/.test(seg) ? Number(seg) : NaN;
      if (!(idx >= 0 && idx <= arr.length) || (idx === arr.length && (!last || op === "unset"))) {
        throw new Error(`${where}: index out of range (array has ${arr.length} element${arr.length === 1 ? "" : "s"}).`);
      }
      if (last) {
        if (op === "unset") arr.splice(idx, 1);
        else arr[idx] = structuredClone(change.value);
        return;
      }
      container = arr[idx];
      continue;
    }
    if (!isObject(container)) throw new Error(`${formatConfigPath(path.slice(0, i))} is not an object, so it has no "${seg}".`);
    if (last) {
      if (op === "unset") delete container[seg]; // falls back to the schema default
      else container[seg] = structuredClone(change.value);
      return;
    }
    if (seg === "allowAuthors" && Array.isArray(container[seg]) &&
      (path.slice(0, i).join(".") === "prWatch" || (i === 3 && path[0] === "projects" && path[2] === "prWatch"))) {
      container[seg] = { bots: container[seg], humans: [] };
    }
    if (container[seg] === undefined) {
      if (op === "unset") return; // nothing there to remove
      // Creating an identified array (e.g. the first persona) or a nested object.
      container[seg] = i === 0 && IDENTIFIED[seg] ? [] : {};
    }
    container = container[seg];
  }
}

/**
 * Renders one top-level value. The dedicated serializers keep their blocks in the
 * file's established style; they need schema-shaped input, so a value that
 * doesn't parse falls back to the generic literal and fails validation with the
 * schema's own error instead of being mangled.
 */
function renderTopLevel(key: string, value: unknown, indent: string): string {
  const parsed = <T>(schema: z.ZodType<T>) => {
    const r = schema.safeParse(value);
    return r.success ? r.data : undefined;
  };
  if (key === "projects") {
    const p = parsed(z.array(ProjectSchema));
    if (p) return serializeProjects(p, indent);
  } else if (key === "models") {
    const m = parsed(z.array(ModelSchema));
    if (m) return serializeModels(m, indent);
  } else if (key === "roles") {
    const r = parsed(RolesSchema);
    if (r) return serializeRoles(r, indent);
  } else if (key === "runtimes") {
    const r = parsed(RuntimesSchema);
    if (r) return serializeRuntimes(r, indent);
  }
  return toTsLiteral(value, indent);
}

/** Imports a config module fresh (keyed by content hash) and returns its raw export. */
async function importRaw(path: string, src: string): Promise<Record<string, unknown>> {
  const mod = (await import(`${path}?v=${sha256(src)}`)) as { default?: unknown; config?: unknown };
  const raw = mod.default ?? mod.config;
  if (!isObject(raw)) throw new Error(`Config at ${path} must \`export default\` a config object.`);
  return raw;
}

/** The raw, as-authored config object (no defaults applied, paths unexpanded). */
export async function readAuthoredConfig(configPath: string): Promise<Record<string, unknown>> {
  return importRaw(configPath, readFileSync(configPath, "utf8"));
}

/**
 * Writes `src` to a temp file beside the config and runs the real `loadConfig` on
 * it, so cross-references (roles → models, persona models, `jira.mcpServer`, boot
 * recipes) are checked exactly as the next session start would. Same directory so
 * relative imports resolve identically and the final `rename` stays atomic.
 * Returns the temp path (caller removes or renames it) plus the parsed result.
 */
async function writeValidated(configPath: string, src: string): Promise<{ temp: string; config: TackConfig; raw: Record<string, unknown> }> {
  const temp = join(dirname(configPath), `.${basename(configPath, ".ts")}.${randomBytes(6).toString("hex")}.tmp.ts`);
  writeFileSync(temp, src, "utf8");
  try {
    // Import through the realpath: Bun caches a directory's listing under a
    // symlinked path (e.g. /tmp → /private/tmp) and then can't see a file created
    // after the scan, while the real path resolves fresh.
    const real = realpathSync(temp);
    const config = await loadConfig(real);
    return { temp, config, raw: await importRaw(real, src) };
  } catch (err) {
    rmSync(temp, { force: true });
    throw new Error(`The change would make the config invalid, so nothing was written: ${(err as Error).message}`);
  }
}

/**
 * Computes `changes` against the config file and validates the result, without
 * writing it. Changes apply in order, all or nothing (in memory). Throws on a
 * denylisted path, a bad path, a change that leaves the file as it is, or a
 * result `loadConfig` rejects.
 */
export async function prepareConfigChange(configPath: string, changes: ConfigChange[]): Promise<PreparedConfigChange> {
  if (changes.length === 0) throw new Error("No changes given.");
  const before = readFileSync(configPath, "utf8");
  const hash = sha256(before);
  const original = await importRaw(configPath, before);
  const next = structuredClone(original);
  for (const change of changes) {
    checkDeniedPath(change);
    applyChange(next, change);
  }
  checkDenylistInvariant(original, next);

  let after = before;
  const touched = [...new Set(changes.map((c) => c.path[0]!))];
  for (const key of touched) {
    if (isDeepStrictEqual(original[key], next[key])) continue;
    after = replaceTopLevelProperty(after, key, next[key] === undefined ? null : (indent) => renderTopLevel(key, next[key], indent));
  }
  if (after === before) throw new Error("These changes leave the config unchanged.");

  const { temp, raw } = await writeValidated(configPath, after);
  rmSync(temp, { force: true });
  // The rewritten file must load to exactly what was asked for: guards against a
  // serializer dropping a field, or a value the text rewrite couldn't express
  // (e.g. a spread later in the object shadowing the edited key).
  const intended = ConfigSchema.safeParse(next);
  if (!intended.success || !isDeepStrictEqual(ConfigSchema.parse(raw), intended.data)) {
    throw new Error("The rewritten config doesn't load back to the requested values (is the edited key spread or computed?). Edit it with `tack config edit`.");
  }
  return { configPath, before, after, diff: unifiedDiff(before, after, basename(configPath)), changedPaths: changes.map((c) => formatConfigPath(c.path)), hash };
}

/**
 * Writes a prepared change: re-validates it in a temp file, then atomically renames
 * it over the config. The hash re-check sits right before the rename, so an edit
 * the human made while the confirmation was open (or a concurrent CLI write) is
 * never silently overwritten. On any failure the config is untouched and the temp
 * file removed.
 */
export async function commitConfigChange(prepared: PreparedConfigChange): Promise<void> {
  const { temp } = await writeValidated(prepared.configPath, prepared.after);
  try {
    const current = existsSync(prepared.configPath) ? readFileSync(prepared.configPath, "utf8") : "";
    if (sha256(current) !== prepared.hash) {
      throw new Error("The config changed since this edit was computed, so nothing was written. Retry the change against the current config.");
    }
    renameSync(temp, prepared.configPath);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Line-based unified diff (`---`/`+++` header, `@@` hunks, 3 lines of context).
 * An LCS table is fine here: config files are a few hundred lines at most.
 */
export function unifiedDiff(a: string, b: string, name = "config.ts", context = 3): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  type Op = { t: " " | "-" | "+"; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ t: " ", line: x[i]!, ai: i++, bi: j++ });
    // Deletions first on a tie, so a replaced line reads as `-old` then `+new`.
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ t: "-", line: x[i]!, ai: i++, bi: j });
    else ops.push({ t: "+", line: y[j]!, ai: i, bi: j++ });
  }
  const out = [`--- a/${name}`, `+++ b/${name}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === " ") { k++; continue; }
    // Grow a hunk around this change, merging changes closer than 2×context.
    const start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.t !== " ") { end++; continue; }
      let run = end;
      while (run < ops.length && ops[run]!.t === " ") run++;
      if (run === ops.length || run - end > 2 * context) { end = Math.min(ops.length, end + context); break; }
      end = run;
    }
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.t !== "+").length;
    const bLen = hunk.filter((o) => o.t !== "-").length;
    const aStart = aLen ? hunk.find((o) => o.t !== "+")!.ai + 1 : hunk[0]!.ai;
    const bStart = bLen ? hunk.find((o) => o.t !== "-")!.bi + 1 : hunk[0]!.bi;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`, ...hunk.map((o) => o.t + o.line));
    k = end;
  }
  return out.join("\n");
}

/** Placeholder for values that must never leave the config (MCP server credentials). */
export const REDACTED = "<redacted>";

/** A copy of the raw config with every `supervisorMcpServers[].env` value redacted. */
export function redactConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(raw);
  if (Array.isArray(copy.supervisorMcpServers)) {
    for (const server of copy.supervisorMcpServers) {
      if (isObject(server) && isObject(server.env)) {
        server.env = Object.fromEntries(Object.keys(server.env).map((k) => [k, REDACTED]));
      }
    }
  }
  return copy;
}

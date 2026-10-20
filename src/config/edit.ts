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
  if (s.versionPolicy) parts.push(`versionPolicy: ${JSON.stringify(s.versionPolicy)}`);
  return `{ ${parts.join(", ")} }`;
}

/** Serializes the whole `runtimes:` block at the given base indentation. */
function serializeRuntimes(runtimes: Record<string, RuntimeSettings | undefined>, indent: string): string {
  const entries = Object.entries(runtimes).filter(
    (e): e is [string, RuntimeSettings] => Boolean(e[1] && (e[1].bin || e[1].version || e[1].versionPolicy)),
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

  const src = readFileSync(configPath, "utf8");
  const masked = maskNonCode(src);
  const m = /(^|\n)([^\S\n]*)runtimes[^\S\n]*:[^\S\n]*\{/.exec(masked);
  if (!m) throw new Error(`Could not find a \`runtimes:\` block in ${configPath}.`);
  const start = m.index + m[1]!.length + m[2]!.length;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(masked, open);
  if (close < 0) throw new Error(`Unbalanced braces in the \`runtimes:\` block in ${configPath}.`);
  const next = src.slice(0, start) + serializeRuntimes(runtimes, m[2]!) + src.slice(close + 1);
  writeFileSync(configPath, next, "utf8");
  return changed;
}

/** Serializes the whole `roles:` block at the given base indentation, one role per
 * line in the object's existing key order. */
function serializeRoles(roles: Roles, indent: string): string {
  const inner = indent + "  ";
  const lines = (Object.keys(roles) as (keyof Roles)[]).map((k) => `${inner}${k}: ${JSON.stringify(roles[k])},`);
  return `roles: {\n${lines.join("\n")}\n${indent}}`;
}

/**
 * Pins `role` to the model `key` in the config file, preserving the rest of the file
 * (comments, other blocks, indentation). The current roles are read back from the
 * parsed config and the one role is swapped, so untouched roles keep their pins; only
 * the `roles:` block is rewritten in place. Returns the role's previous key (equal to
 * `key` when nothing changed). Validation that `role`/`key` are legal lives with the
 * caller, which has the loaded config to check the model exists.
 */
export async function setRoleInConfig(configPath: string, role: keyof Roles, key: string): Promise<string> {
  const parsed = await loadParsedConfig(configPath);
  const previous = parsed.roles[role];
  const next: Roles = { ...parsed.roles, [role]: key };

  const src = readFileSync(configPath, "utf8");
  const masked = maskNonCode(src);
  const m = /(^|\n)([^\S\n]*)roles[^\S\n]*:[^\S\n]*\{/.exec(masked);
  if (!m) throw new Error(`Could not find a \`roles:\` block in ${configPath}.`);
  const start = m.index + m[1]!.length + m[2]!.length; // start of the `roles` keyword
  const open = m.index + m[0].length - 1; // index of the opening `{`
  const close = matchBrace(masked, open);
  if (close < 0) throw new Error(`Unbalanced braces in the \`roles:\` block in ${configPath}.`);

  const out = src.slice(0, start) + serializeRoles(next, m[2]!) + src.slice(close + 1);
  writeFileSync(configPath, out, "utf8");
  return previous;
}

/** Serializes a project's tech-stack metadata to a single-line object literal. */
function serializeMetadata(m: ProjectMetadata): string {
  const frameworks = m.frameworks.map((f) => JSON.stringify(f)).join(", ");
  return `{ language: ${JSON.stringify(m.language)}, frameworks: [${frameworks}] }`;
}

/** Serializes one project to a single-line object literal. */
function serializeProject(p: Project): string {
  const parts = [
    `name: ${JSON.stringify(p.name)}`,
    `path: ${JSON.stringify(p.path)}`,
    `description: ${JSON.stringify(p.description)}`,
  ];
  if (p.metadata) parts.push(`metadata: ${serializeMetadata(p.metadata)}`);
  return `{ ${parts.join(", ")} }`;
}

/** Serializes the whole `projects:` array at the given base indentation. */
function serializeProjects(projects: Project[], indent: string): string {
  if (projects.length === 0) return "projects: []";
  const inner = indent + "  ";
  const lines = projects.map((p) => `${inner}${serializeProject(p)},`);
  return `projects: [\n${lines.join("\n")}\n${indent}]`;
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
  const src = readFileSync(configPath, "utf8");
  const masked = maskNonCode(src);
  const m = /(^|\n)([^\S\n]*)projects[^\S\n]*:[^\S\n]*\[/.exec(masked);
  if (!m) throw new Error(`Could not find a \`projects:\` block in ${configPath}.`);
  const start = m.index + m[1]!.length + m[2]!.length; // start of the `projects` keyword
  const open = m.index + m[0].length - 1; // index of the opening `[`
  const close = matchDelimiter(masked, open, "[", "]");
  if (close < 0) throw new Error(`Unbalanced brackets in the \`projects:\` block in ${configPath}.`);
  const out = src.slice(0, start) + serializeProjects(next, m[2]!) + src.slice(close + 1);
  writeFileSync(configPath, out, "utf8");
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

/** Serializes one model to a single-line object literal. */
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
  return `{ ${parts.join(", ")} }`;
}

/** Serializes the whole `models:` array at the given base indentation. */
function serializeModels(models: Model[], indent: string): string {
  if (models.length === 0) return "models: []";
  const inner = indent + "  ";
  const lines = models.map((m) => `${inner}${serializeModel(m)},`);
  return `models: [\n${lines.join("\n")}\n${indent}]`;
}

/**
 * Rewrites the `models:` array in place with `next`, preserving the rest of the
 * file byte-for-byte (comments, other blocks, indentation). Mirrors
 * `writeProjectsBlock`.
 */
function writeModelsBlock(configPath: string, next: Model[]): void {
  const src = readFileSync(configPath, "utf8");
  const masked = maskNonCode(src);
  const m = /(^|\n)([^\S\n]*)models[^\S\n]*:[^\S\n]*\[/.exec(masked);
  if (!m) throw new Error(`Could not find a \`models:\` block in ${configPath}.`);
  const start = m.index + m[1]!.length + m[2]!.length; // start of the `models` keyword
  const open = m.index + m[0].length - 1; // index of the opening `[`
  const close = matchDelimiter(masked, open, "[", "]");
  if (close < 0) throw new Error(`Unbalanced brackets in the \`models:\` block in ${configPath}.`);
  const out = src.slice(0, start) + serializeModels(next, m[2]!) + src.slice(close + 1);
  writeFileSync(configPath, out, "utf8");
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

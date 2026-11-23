import { existsSync, statSync } from "node:fs";
import { CONFIG_PATH, expandHome } from "../paths";
import { ConfigSchema, type Model, type ResolvedRoles, type ResolvedPersona, type TackConfig } from "./schema";

/**
 * Loads and validates the user's config. The config file is a `.ts` module that
 * `export default`s a config object (Bun imports it natively). The import is keyed
 * by mtime because Bun caches modules by specifier: a command that edits the config
 * and then reloads it (e.g. `models sync`) would otherwise get the stale copy.
 */
export async function loadConfig(path = CONFIG_PATH): Promise<TackConfig> {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Run \`tack init\` to create one.`);
  }
  const mod = (await import(`${path}?v=${statSync(path).mtimeMs}`)) as { default?: unknown; config?: unknown };
  const raw = mod.default ?? mod.config;
  if (raw === undefined) {
    throw new Error(`Config at ${path} must \`export default\` a config object.`);
  }

  const parsed = ConfigSchema.parse(raw);

  // Normalize once so all consumers see ordered, distinct candidate keys.
  const roles = Object.fromEntries(
    Object.entries({ ...parsed.roles, readme: parsed.roles.readme ?? parsed.roles.supervisor }).map(([role, value]) => [role, [...new Set(Array.isArray(value) ? value : [value])]]),
  ) as ResolvedRoles;
  const byKey = new Map(parsed.models.map((m) => [m.key, m]));
  for (const [role, keys] of Object.entries(roles)) {
    for (const key of keys) {
      if (!byKey.has(key)) {
        const known = [...byKey.keys()].join(", ") || "(none)";
        throw new Error(`roles.${role} = "${key}" is not a defined model. Known: ${known}`);
      }
    }
  }

  const names = new Set<string>();
  const personas = parsed.personas.map((persona) => {
    if (names.has(persona.name)) throw new Error(`Duplicate persona name "${persona.name}".`);
    names.add(persona.name);
    const model = [...new Set(typeof persona.model === "string" ? [persona.model] : persona.model ?? [])];
    for (const key of model) {
      if (!byKey.has(key)) {
        throw new Error(`personas.${persona.name}.model = "${key}" is not a defined model. Known: ${[...byKey.keys()].join(", ") || "(none)"}`);
      }
    }
    return { ...persona, model };
  });

  if (parsed.jira?.watch.model && !byKey.has(parsed.jira.watch.model)) {
    throw new Error(`jira.watch.model = "${parsed.jira.watch.model}" is not a defined model. Known: ${[...byKey.keys()].join(", ") || "(none)"}`);
  }

  // `jira.mcpServer` must name a mounted server — a typo would otherwise surface only
  // as a silent "jira unavailable" on the dashboard, so fail loudly here instead.
  if (parsed.jira && !parsed.supervisorMcpServers.some((s) => s.name === parsed.jira!.mcpServer)) {
    const known = parsed.supervisorMcpServers.map((s) => s.name).join(", ") || "(none)";
    throw new Error(
      `jira.mcpServer = "${parsed.jira.mcpServer}" is not a supervisorMcpServers entry. Known: ${known}`,
    );
  }

  for (const project of parsed.projects) {
    if (project.boot?.recipe && !parsed.bootRecipes[project.boot.recipe])
      throw new Error(`projects.${project.name}.boot.recipe = "${project.boot.recipe}" is not a bootRecipes entry. Known: ${Object.keys(parsed.bootRecipes).join(", ") || "(none)"}`);
  }

  return {
    bootRecipes: parsed.bootRecipes,
    projects: parsed.projects.map((p) => ({ ...p, path: expandHome(p.path) })),
    models: parsed.models,
    roles,
    readme: {
      publisher: parsed.readme?.publisher ?? (parsed.runtimes.claude || parsed.models.some(m => m.runtime === "claude") || Bun.which("claude") ? "claude-artifact" : "local"),
      ...(parsed.readme?.confluence ? { confluence: parsed.readme.confluence } : {}),
      ...(parsed.readme?.googleDoc ? { googleDoc: parsed.readme.googleDoc } : {}),
    },
    personas,
    runtimes: {
      claude: expandBin(parsed.runtimes.claude),
      codex: expandBin(parsed.runtimes.codex),
    },
    readAllowlist: parsed.readAllowlist.map(expandHome),
    // Home-expand each server's command so a `~/bin/...` launcher resolves; args
    // are left verbatim (they're the server's own flags, not Tack-owned paths).
    supervisorMcpServers: parsed.supervisorMcpServers.map((s) => ({
      ...s,
      command: expandHome(s.command),
    })),
    prWatch: parsed.prWatch,
    baseCache: parsed.baseCache,
    dashboard: parsed.dashboard,
    agentReuse: parsed.agentReuse,
    autoOpenPrs: parsed.autoOpenPrs,
    autoLinkPrs: parsed.autoLinkPrs,
    draftPrs: parsed.draftPrs,
    jira: parsed.jira,
  };
}

/** Home-expands a runtime's `bin` path, if set. */
function expandBin(
  settings: { bin?: string; version?: string } | undefined,
): { bin?: string; version?: string } | undefined {
  if (!settings) return undefined;
  return { ...settings, bin: settings.bin ? expandHome(settings.bin) : undefined };
}

/** Resolves a model by its key, throwing a clear error if it isn't defined. */
export function resolveModel(config: TackConfig, key: string): Model {
  const model = config.models.find((m) => m.key === key);
  if (!model) {
    const known = config.models.map((m) => m.key).join(", ") || "(none)";
    throw new Error(`Unknown model "${key}". Defined: ${known}`);
  }
  return model;
}

/** Returns the distinct candidate keys for a functional role, in config order. */
export function roleModelKeys(config: TackConfig, role: keyof ResolvedRoles): string[] {
  return config.roles[role];
}

/** Picks uniformly among a role's models; a single candidate is always used. */
export function modelForRole(config: TackConfig, role: keyof ResolvedRoles, rng = Math.random): Model {
  const keys = roleModelKeys(config, role);
  return resolveModel(config, keys.length === 1 ? keys[0]! : keys[Math.floor(rng() * keys.length)]!);
}

/** Resolve a configured reviewer lens, with actionable typo feedback. */
export function resolvePersona(config: TackConfig, name: string): ResolvedPersona {
  const persona = config.personas.find((p) => p.name === name);
  if (!persona) throw new Error(`Unknown persona "${name}". Known: ${config.personas.map((p) => p.name).join(", ") || "(none)"}`);
  return persona;
}

/** Prefer another model's perspective without making a single-model setup unusable. */
export function modelForPersona(config: TackConfig, persona: ResolvedPersona,
  { avoidKey, rng = Math.random }: { avoidKey?: string | null; rng?: () => number } = {}): Model {
  const candidates = persona.model.length ? persona.model : roleModelKeys(config, "agent");
  const different = candidates.filter((key) => key !== avoidKey);
  const keys = different.length ? different : candidates;
  return resolveModel(config, keys.length === 1 ? keys[0]! : keys[Math.floor(rng() * keys.length)]!);
}

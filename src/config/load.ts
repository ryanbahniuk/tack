import { existsSync, statSync } from "node:fs";
import { CONFIG_PATH, expandHome } from "../paths";
import { ConfigSchema, type Model, type ResolvedRoles, type TackConfig } from "./schema";

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
    Object.entries(parsed.roles).map(([role, value]) => [role, [...new Set(Array.isArray(value) ? value : [value])]]),
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

  // `jira.mcpServer` must name a mounted server — a typo would otherwise surface only
  // as a silent "jira unavailable" on the dashboard, so fail loudly here instead.
  if (parsed.jira && !parsed.supervisorMcpServers.some((s) => s.name === parsed.jira!.mcpServer)) {
    const known = parsed.supervisorMcpServers.map((s) => s.name).join(", ") || "(none)";
    throw new Error(
      `jira.mcpServer = "${parsed.jira.mcpServer}" is not a supervisorMcpServers entry. Known: ${known}`,
    );
  }

  return {
    projects: parsed.projects.map((p) => ({ ...p, path: expandHome(p.path) })),
    models: parsed.models,
    roles,
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
    agentReuse: parsed.agentReuse,
    autoOpenPrs: parsed.autoOpenPrs,
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

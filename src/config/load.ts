import { existsSync, statSync } from "node:fs";
import { CONFIG_PATH, expandHome } from "../paths";
import { ConfigSchema, type Model, type TackConfig } from "./schema";

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

  // Every role must name a defined model, and codex models must carry pricing to
  // yield a cost — catch both at load time, not mid-run.
  const byKey = new Map(parsed.models.map((m) => [m.key, m]));
  for (const [role, key] of Object.entries(parsed.roles)) {
    if (!byKey.has(key)) {
      const known = [...byKey.keys()].join(", ") || "(none)";
      throw new Error(`roles.${role} = "${key}" is not a defined model. Known: ${known}`);
    }
  }

  return {
    projects: parsed.projects.map((p) => ({ ...p, path: expandHome(p.path) })),
    models: parsed.models,
    roles: parsed.roles,
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
    autoOpenPrs: parsed.autoOpenPrs,
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

/** Resolves the model pinned to a functional role. */
export function modelForRole(config: TackConfig, role: keyof TackConfig["roles"]): Model {
  return resolveModel(config, config.roles[role]);
}

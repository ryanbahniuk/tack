import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { TACK_HOME } from "../paths";
import type { RuntimeKind, TackConfig, VersionPolicy } from "../config/schema";

export interface ResolvedRuntime {
  kind: RuntimeKind;
  bin: string;
  version: string;
  pinned?: string;
  /** Effective policy applied to the pin (defaults to "warn" when unset). */
  policy: VersionPolicy;
  /** True when there's no pin, or the installed version satisfies it. */
  satisfied: boolean;
}

/** Default when a runtime doesn't set `versionPolicy`: advisory, never fatal, so a
 * self-updating CLI doesn't brick every run the moment it bumps itself. */
export const DEFAULT_VERSION_POLICY: VersionPolicy = "warn";

/** Cache `<bin> --version` so we don't re-spawn it for every agent. */
const versionCache = new Map<string, string>();

/** Directory Tack installs a pinned runtime version into, isolated per version so a
 * managed install never clobbers a system/global one. */
export function managedRuntimeDir(kind: RuntimeKind, version: string): string {
  return join(TACK_HOME, "runtimes", kind, version);
}

/** The binary a managed install exposes (npm/bun place package bins in `.bin`). */
export function managedRuntimeBin(kind: RuntimeKind, version: string): string {
  return join(managedRuntimeDir(kind, version), "node_modules", ".bin", kind);
}

/**
 * The binary Tack should invoke for a runtime, in priority order: an explicit
 * config `bin` override; else a Tack-managed install of the pinned version if
 * present; else the runtime name on PATH.
 */
export function runtimeBin(config: TackConfig, kind: RuntimeKind): string {
  const settings = config.runtimes[kind];
  if (settings?.bin) return settings.bin;
  if (settings?.version) {
    const managed = managedRuntimeBin(kind, settings.version);
    if (existsSync(managed)) return managed;
  }
  return kind;
}

/** Runs `<bin> --version` (cached) and returns its trimmed output. Throws a clear
 * error if the binary can't be executed. */
export function runtimeVersion(bin: string): string {
  const cached = versionCache.get(bin);
  if (cached !== undefined) return cached;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : (r.stderr || "non-zero exit").trim();
    throw new Error(`Cannot run runtime binary "${bin}": ${why}`);
  }
  const version = (r.stdout || "").trim();
  versionCache.set(bin, version);
  return version;
}

/** Remember which (kind, installed, pinned) mismatches we've already warned about,
 * so a session spinning up many agents prints the drift notice once, not per-agent. */
const warnedMismatches = new Set<string>();

/** Human-readable, color-free description of a pin drift and how to resolve it. */
function mismatchMessage(kind: RuntimeKind, bin: string, version: string, pinned: string): string {
  return (
    `${kind} runtime version drift: config pins "${pinned}" but "${bin} --version" reports "${version}". ` +
    `Re-pin with \`tack runtimes sync\` (adopt what's installed) or \`tack runtimes pin ${kind} <version>\`.`
  );
}

/**
 * Resolves a runtime's binary and checks it against any pinned version before it's
 * used. The pin is matched as a substring of `--version` output (whose format differs
 * per CLI), so `version: "2.1.261"` or `"0.147.0"` both work. How a mismatch is
 * handled is governed by the runtime's `versionPolicy` (default `"warn"`):
 *  - `"warn"`: log once to stderr and continue — the pin is advisory.
 *  - `"strict"`: throw, stopping the run (reproducible setups).
 *  - `"off"`: skip the check entirely.
 * stderr is used (never stdout) so this stays safe inside the MCP servers.
 */
export function resolveRuntime(config: TackConfig, kind: RuntimeKind): ResolvedRuntime {
  const bin = runtimeBin(config, kind);
  const version = runtimeVersion(bin);
  const pinned = config.runtimes[kind]?.version;
  const policy = config.runtimes[kind]?.versionPolicy ?? DEFAULT_VERSION_POLICY;
  const satisfied = !pinned || version.includes(pinned);

  if (pinned && !satisfied && policy !== "off") {
    const message = mismatchMessage(kind, bin, version, pinned);
    if (policy === "strict") throw new Error(message);
    const seen = `${kind}\u0000${version}\u0000${pinned}`;
    if (!warnedMismatches.has(seen)) {
      warnedMismatches.add(seen);
      console.warn(pc.yellow(`! ${message}`));
    }
  }

  return { kind, bin, version, pinned, policy, satisfied };
}

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TACK_HOME } from "../paths";
import type { RuntimeKind, TackConfig } from "../config/schema";

export interface ResolvedRuntime {
  kind: RuntimeKind;
  bin: string;
  version: string;
  pinned?: string;
}

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

/**
 * Resolves a runtime's binary and verifies it against any pinned version before
 * it's used. The pin is matched as a substring of `--version` output (whose format
 * differs per CLI), so `version: "2.1.261"` or `"0.147.0"` both work. A mismatch
 * throws — an unexpected CLI upgrade should stop the run, not silently change it.
 */
export function resolveRuntime(config: TackConfig, kind: RuntimeKind): ResolvedRuntime {
  const bin = runtimeBin(config, kind);
  const version = runtimeVersion(bin);
  const pinned = config.runtimes[kind]?.version;
  if (pinned && !version.includes(pinned)) {
    throw new Error(
      `${kind} runtime version mismatch: config pins "${pinned}" but "${bin} --version" reports "${version}". ` +
        `Update the pin or install the pinned version.`,
    );
  }
  return { kind, bin, version, pinned };
}

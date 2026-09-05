import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeKind, TackConfig } from "../config/schema";
import { managedRuntimeBin, managedRuntimeDir, runtimeVersion } from "./resolve";

/** npm packages that ship each runtime CLI. */
const PACKAGE: Record<RuntimeKind, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

export type EnsureAction =
  | "present" // already installed at the required version (or an unpinned binary is on PATH)
  | "installed" // Tack just installed the pinned version
  | "unpinned-missing" // no pin and no binary found — nothing installed
  | "mismatch" // an explicit `bin` override doesn't satisfy the pin
  | "failed";

export interface EnsureResult {
  kind: RuntimeKind;
  action: EnsureAction;
  bin?: string;
  version?: string;
  message?: string;
}

/**
 * Ensures a runtime is available, installing a pinned version transparently into a
 * Tack-managed directory if needed. Behavior by config:
 *  - explicit `bin`  → verified only (Tack never installs over a user-managed path).
 *  - pinned `version`→ ensured: reused if already present (managed or on PATH),
 *                       otherwise installed into `~/.tack/runtimes/<kind>/<version>`.
 *  - unpinned        → reported present if a binary is on PATH, else left to the user
 *                       (pin a version to have Tack manage it).
 */
export function ensureRuntimeInstalled(config: TackConfig, kind: RuntimeKind): EnsureResult {
  const settings = config.runtimes[kind];

  if (settings?.bin) {
    try {
      const version = runtimeVersion(settings.bin);
      if (settings.version && !version.includes(settings.version)) {
        return { kind, action: "mismatch", bin: settings.bin, version, message: `pins ${settings.version}` };
      }
      return { kind, action: "present", bin: settings.bin, version };
    } catch (err) {
      return { kind, action: "failed", message: (err as Error).message };
    }
  }

  const version = settings?.version;
  if (!version) {
    try {
      return { kind, action: "present", bin: kind, version: runtimeVersion(kind) };
    } catch {
      return { kind, action: "unpinned-missing" };
    }
  }

  // Pinned: reuse a managed install or a matching PATH binary before installing.
  const managed = managedRuntimeBin(kind, version);
  if (existsSync(managed)) {
    try {
      const v = runtimeVersion(managed);
      if (v.includes(version)) return { kind, action: "present", bin: managed, version: v };
    } catch {
      /* fall through to reinstall */
    }
  }
  try {
    const v = runtimeVersion(kind);
    if (v.includes(version)) return { kind, action: "present", bin: kind, version: v };
  } catch {
    /* not on PATH — install below */
  }

  try {
    installManaged(kind, version);
    return { kind, action: "installed", bin: managed, version: runtimeVersion(managed) };
  } catch (err) {
    return { kind, action: "failed", message: (err as Error).message };
  }
}

/** Installs `<package>@<version>` into an isolated Tack-managed directory via bun.
 * Uses a package manager (never a piped shell installer). Streams output so the
 * install is visible, not silent. */
function installManaged(kind: RuntimeKind, version: string): void {
  const dir = managedRuntimeDir(kind, version);
  mkdirSync(dir, { recursive: true });
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({ name: `tack-runtime-${kind}`, private: true }) + "\n");
  }
  const spec = `${PACKAGE[kind]}@${version}`;
  const r = spawnSync("bun", ["add", spec], { cwd: dir, stdio: "inherit", encoding: "utf8" });
  if (r.error) throw new Error(`bun add ${spec} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`bun add ${spec} exited with code ${r.status}`);
  if (!existsSync(managedRuntimeBin(kind, version))) {
    throw new Error(`installed ${spec} but no "${kind}" binary appeared in ${dir}/node_modules/.bin`);
  }
}

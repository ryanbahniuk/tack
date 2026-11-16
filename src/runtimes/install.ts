import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { RuntimeKind, RuntimeSettings, TackConfig } from "../config/schema";
import { forgetRuntimeVersion, managedRuntimeBin, managedRuntimeDir, runtimeVersion } from "./resolve";

/** npm packages that ship each runtime CLI. */
const PACKAGE: Record<RuntimeKind, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

export type EnsureAction =
  | "present" // already installed at the required version (or an unpinned binary is on PATH / already latest)
  | "installed" // Tack just installed the pinned version, or the latest release where none was
  | "upgraded" // Tack just moved an unpinned global install to a newer latest (see `previousVersion`)
  | "unpinned-missing" // no pin and no binary found — nothing installed
  | "mismatch" // an explicit `bin` override doesn't satisfy the pin
  | "failed";

export interface EnsureResult {
  kind: RuntimeKind;
  action: EnsureAction;
  bin?: string;
  version?: string;
  /** For "upgraded": the version that was there before. */
  previousVersion?: string;
  message?: string;
  /** A non-fatal problem worth surfacing (e.g. another copy shadows the install on PATH). */
  warning?: string;
}

/**
 * Ensures a runtime is available, installing a pinned version transparently into a
 * Tack-managed directory if needed. Behavior by config:
 *  - explicit `bin`  → verified only (Tack never installs over a user-managed path).
 *  - pinned `version`→ ensured: reused if already present (managed or on PATH),
 *                       otherwise installed into `~/.tack/runtimes/<kind>/<version>`.
 *  - unpinned        → reported present if a binary is on PATH, else "unpinned-missing"
 *                       (`tack runtimes install` fetches the latest; see `installRuntime`).
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

/**
 * How `tack runtimes install` treats a runtime, from its config alone:
 *  - "verify" → an explicit `bin` is user-managed; check it, never install over it.
 *  - "pinned" → a `version` pin; install it into `~/.tack/runtimes/<kind>/<version>`.
 *  - "latest" → unpinned (the starter default); install/upgrade the latest release
 *               globally with bun, so the PATH copy is current.
 */
export type InstallPlan = "verify" | "pinned" | "latest";

export function installPlanFor(settings: RuntimeSettings | undefined): InstallPlan {
  if (settings?.bin) return "verify";
  if (settings?.version) return "pinned";
  return "latest";
}

/** The bare version from `--version` output (`2.1.300 (Claude Code)`, `codex-cli
 * 0.147.0`), falling back to the trimmed text when it carries no semver. */
export function bareVersion(output: string): string {
  return output.match(/\d+\.\d+\.\d+[0-9A-Za-z.+-]*/)?.[0] ?? output.trim();
}

/** Classifies a latest-install from the versions seen before and after it. `null`
 * means "no binary". Pure, so the labelling is testable without installing. */
export function versionChange(
  before: string | null,
  after: string,
): { action: "installed" | "upgraded" | "present"; label: string } {
  const a = bareVersion(after);
  if (before === null) return { action: "installed", label: `installed ${a}` };
  const b = bareVersion(before);
  if (b === a) return { action: "present", label: `already latest ${a}` };
  return { action: "upgraded", label: `upgraded ${b} → ${a}` };
}

/** First executable named `name` across a PATH string, or null. */
export function resolveOnPath(name: string, pathEnv: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * A warning when the runtime on PATH isn't the one bun just installed — e.g. a
 * native installer's `~/.local/bin/claude` earlier on PATH would keep running the
 * old version. `sameDir` decides directory equality (realpath-aware in practice);
 * injectable so the rule is testable without a filesystem.
 */
export function shadowWarning(
  kind: RuntimeKind,
  onPath: string | null,
  bunBinDir: string,
  sameDir: (a: string, b: string) => boolean = (a, b) => a === b,
): string | null {
  const installed = join(bunBinDir, kind);
  if (onPath === null) {
    return `${installed} isn't on PATH — add ${bunBinDir} to PATH (e.g. \`export PATH="${bunBinDir}:$PATH"\`).`;
  }
  if (sameDir(dirname(onPath), bunBinDir)) return null;
  return (
    `\`${kind}\` on PATH resolves to ${onPath}, not bun's ${installed}, so the old copy still runs. ` +
    `Put ${bunBinDir} earlier on PATH (e.g. \`export PATH="${bunBinDir}:$PATH"\`) or remove ${onPath}.`
  );
}

/** bun's global bin directory (`bun pm bin -g`), with bun's documented default as
 * a fallback if the query fails. */
export function bunGlobalBinDir(): string {
  const r = spawnSync("bun", ["pm", "bin", "-g"], { encoding: "utf8" });
  const out = r.status === 0 ? (r.stdout || "").trim() : "";
  if (out) return out;
  return join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "bin");
}

/** `--version` of a binary, read fresh (bypassing the cache), or null if it can't run. */
function freshVersion(bin: string): string | null {
  forgetRuntimeVersion(bin);
  try {
    return runtimeVersion(bin);
  } catch {
    return null;
  }
}

function sameDirReal(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
}

/**
 * Installs or upgrades the latest release of an unpinned runtime globally with
 * bun (`bun add -g <pkg>@latest` — a package manager, never a piped shell
 * installer), streaming its output. Versions are read from bun's own global copy
 * when there is one, so a shadowing copy elsewhere on PATH can't mislabel the
 * result; that shadowing is reported as a `warning` instead.
 */
export function installLatestRuntime(kind: RuntimeKind): EnsureResult {
  const binDir = bunGlobalBinDir();
  const globalBin = join(binDir, kind);
  const versionOf = () => (existsSync(globalBin) ? freshVersion(globalBin) : freshVersion(kind));
  const before = versionOf();

  const spec = `${PACKAGE[kind]}@latest`;
  const r = spawnSync("bun", ["add", "-g", spec], { stdio: "inherit", encoding: "utf8" });
  if (r.error) return { kind, action: "failed", message: `bun add -g ${spec} failed: ${r.error.message}` };
  if (r.status !== 0) return { kind, action: "failed", message: `bun add -g ${spec} exited with code ${r.status}` };

  // Drop the PATH name's cached version too, so later resolution in this process
  // (e.g. models sync) sees the new binary.
  forgetRuntimeVersion(kind);
  const after = versionOf();
  if (after === null) {
    return { kind, action: "failed", message: `installed ${spec} but \`${globalBin} --version\` didn't run` };
  }
  const change = versionChange(before, after);
  return {
    kind,
    action: change.action,
    bin: existsSync(globalBin) ? globalBin : kind,
    version: after,
    previousVersion: change.action === "upgraded" && before ? before : undefined,
    message: change.label,
    warning: shadowWarning(kind, resolveOnPath(kind), binDir, sameDirReal) ?? undefined,
  };
}

/**
 * The `tack runtimes install` entry point for one runtime: verify an explicit
 * `bin`, ensure a pinned version (managed install), or fetch the latest release
 * for an unpinned runtime. See `installPlanFor`.
 */
export function installRuntime(config: TackConfig, kind: RuntimeKind): EnsureResult {
  return installPlanFor(config.runtimes[kind]) === "latest"
    ? installLatestRuntime(kind)
    : ensureRuntimeInstalled(config, kind);
}

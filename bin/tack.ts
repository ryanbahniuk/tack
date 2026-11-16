#!/usr/bin/env bun
import { decodePreflight } from "../src/agent/preflight";
import { followAgent } from "../src/cli/follow";
import { startRemoteReview } from "../src/session/review";
import { setPrFix } from "../src/session/pr-fix";
import { parseSupervisorCommand } from "../src/supervisor/command-prompt";
import { writeGuardDecision } from "../src/supervisor/write-guard";
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { tackBugSeed, writeTackBugReport } from "../src/session/bug-report";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_PATH, collapseHome, expandHome } from "../src/paths";
import { ensureConfigExists } from "../src/config/ensure";
import { STARTER_CONFIG } from "../src/config/starter";
import { loadConfig, modelForRole, resolveModel, roleModelKeys } from "../src/config/load";
import {
  addModelsToConfig,
  addProjectsToConfig,
  pinRuntimeInConfig,
  removeModelsFromConfig,
  removeProjectFromConfig,
  setModelsPricingInConfig,
  setRoleInConfig,
  setRuntimeVersionsInConfig,
  updateProjectInConfig,
} from "../src/config/edit";
import {
  approveSessionPlan,
  createSession,
  getSession,
  listAgents,
  listPendingAmendments,
  listSessionJiraTickets,
  listSessionPrs,
  listSessions,
  listSharedContext,
  sessionTotalCost,
  clearSessionAwaitingInputFor,
  setSessionAwaitingInput,
  setSessionAwaitingInputIfFree,
  setSupervisorTurnStartedAt,
} from "../src/db";
import { endsWithQuestion, finalAssistantText } from "../src/cli/question";
import { readArtifact } from "../src/artifacts/store";
import { sessionLive, sessionNeedsInput } from "../src/cli/liveness";
import { executeAgent } from "../src/agent/execute";
import { runAgentToCompletion, spawnSupervisorRunner } from "../src/agent/detached";
import { checkModelOffered } from "../src/runtimes/availability";
import {
  superviseInteractive,
  attachSupervisor,
  createSupervisorSession,
  writeSupervisorPrompt,
  runSupervisorToCompletion,
} from "../src/supervisor/supervise";
import { describeReconnect, parkReconnectedSupervisor, reconnectAllSessions, reconnectSession } from "../src/session/reconnect";
import { REFRESH_MESSAGE, isSessionStale, refreshAllStaleSessions, refreshBlockedReason, refreshSession } from "../src/session/refresh";
import { resolveEditTarget, worktreeEditSummary } from "../src/session/edit";
import { createManualWorkspace, resolveManualProject } from "../src/session/manual";
import { isApprovePrompt } from "../src/supervisor/approve-prompt";
import { summarizeProject } from "../src/projects/summarize";
import {
  archiveSession,
  deleteSession,
  stopSession,
  unarchiveSession,
} from "../src/session/lifecycle";
import { generateSessionTitle, spawnSessionTitler, titleFromFirstPrompt } from "../src/session/title";
import { RolesSchema } from "../src/config/schema";
import type { Model, Project, Roles } from "../src/config/schema";
import { runDashboard } from "../src/cli/dashboard";
import { startSpinner } from "../src/cli/spinner";
import { renderStreamEvent, type Pending } from "../src/cli/render";
import { captureViaEditor, openInEditor, openWorktreeInEditor } from "../src/util/editor";
import { runCoordinationServer } from "../src/mcp/coordination-server";
import { runSupervisorServer } from "../src/mcp/supervisor-server";
import { runPrWatcher, triggerPrWatch } from "../src/prwatch/watch";
import {
  ensureRuntimeInstalled,
  fetchPricingCatalog,
  pricingForModel,
  resolveRuntime,
  runtimeAuth,
  DEFAULT_VERSION_POLICY,
  MODEL_CATALOG,
  MODELS_DEV_URL,
  pickReplacement,
  selectRuntime,
  type EnsureResult,
} from "../src/runtimes";
import type { Pricing } from "../src/config/schema";
import type { RuntimeKind, TackConfig } from "../src/config/schema";

const usd = (n: number) => pc.green(`$${n.toFixed(4)}`);

const RUNTIME_KINDS: RuntimeKind[] = ["claude", "codex"];

/** `ensureConfigExists` + `loadConfig`, the opening move of most commands. */
async function requireConfig(): Promise<TackConfig> {
  ensureConfigExists();
  return loadConfig();
}

/** Validates a runtime name from the CLI, exiting with a clear error if unknown. */
function asRuntimeKind(name: string): RuntimeKind {
  if ((RUNTIME_KINDS as string[]).includes(name)) return name as RuntimeKind;
  console.error(pc.red(`Unknown runtime "${name}". Known: ${RUNTIME_KINDS.join(", ")}.`));
  process.exit(1);
}

/** Ensures the given runtimes are available, installing pinned versions
 * transparently. Prints a status line per runtime; returns false if any ended in
 * failure. Defaults to all runtimes (used by `tack init`). */
function ensureRuntimes(config: TackConfig, kinds: RuntimeKind[] = RUNTIME_KINDS): boolean {
  let ok = true;
  for (const kind of kinds) {
    const pin = config.runtimes[kind]?.version;
    if (pin && !isPresentAtManagedOrPath(config, kind, pin)) {
      console.log(pc.dim(`Installing ${kind} ${pin}…`));
    }
    const res = ensureRuntimeInstalled(config, kind);
    printEnsure(res);
    if (res.action === "failed" || res.action === "mismatch") ok = false;
  }
  return ok;
}

/** Cheap pre-check so we only print "Installing…" when an install will actually run. */
function isPresentAtManagedOrPath(config: TackConfig, kind: RuntimeKind, pin: string): boolean {
  try {
    return resolveRuntime(config, kind).version.includes(pin);
  } catch {
    return false;
  }
}

function printEnsure(res: EnsureResult): void {
  const label = pc.cyan(res.kind.padEnd(7));
  switch (res.action) {
    case "present":
      return console.log(`${label} ${pc.green("ready")}    ${pc.bold(res.bin ?? "")} ${pc.dim(res.version ?? "")}`);
    case "installed":
      return console.log(`${label} ${pc.green("installed")} ${pc.bold(res.bin ?? "")} ${pc.dim(res.version ?? "")}`);
    case "unpinned-missing":
      return console.log(`${label} ${pc.yellow("not found")} — install it, or pin a version in config so \`tack install\` fetches it`);
    case "mismatch":
      return console.log(`${label} ${pc.red("mismatch")} ${res.bin} ${pc.dim(res.version ?? "")} (${res.message})`);
    case "failed":
      return console.log(`${label} ${pc.red("failed")}   ${res.message ?? ""}`);
  }
}

const init = defineCommand({
  meta: { name: "init", description: "Scaffold config and ensure the pinned runtimes are installed" },
  async run() {
    if (existsSync(CONFIG_PATH)) {
      console.log(pc.yellow(`Config already exists at ${CONFIG_PATH}`));
    } else {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, STARTER_CONFIG, "utf8");
      console.log(`Wrote starter config to ${pc.cyan(CONFIG_PATH)}`);
    }
    const config = await loadConfig();
    console.log(pc.bold("\nRuntimes"));
    ensureRuntimes(config);

    // If we're inside a git repo, register it as a project so running `tack init`
    // in a repo is all it takes to start working on it.
    const root = gitRootOf(process.cwd());
    if (root) {
      console.log(pc.bold("\nProject"));
      await addProjects(config, [root]);
    }
  },
});

const runtimeInstall = defineCommand({
  meta: { name: "install", description: "Install a runtime's pinned version (or --all)" },
  args: {
    runtime: { type: "positional", required: false, description: "Runtime to install (claude | codex)" },
    all: { type: "boolean", description: "Install all configured runtimes" },
  },
  async run({ args }) {
    const config = await loadConfig();
    let kinds: RuntimeKind[];
    if (args.all) {
      kinds = RUNTIME_KINDS;
    } else if (args.runtime) {
      kinds = [asRuntimeKind(String(args.runtime))];
    } else {
      console.error(pc.red(`Specify a runtime (${RUNTIME_KINDS.join(" | ")}) or --all.`));
      return process.exit(1);
    }
    const ok = ensureRuntimes(config, kinds);
    if (!ok) process.exit(1);
  },
});

const runtimePin = defineCommand({
  meta: { name: "pin", description: "Pin a runtime to a version in the config file" },
  args: {
    runtime: { type: "positional", required: true, description: "Runtime to pin (claude | codex)" },
    version: { type: "positional", required: true, description: "Version to pin" },
  },
  async run({ args }) {
    ensureConfigExists();
    const kind = asRuntimeKind(String(args.runtime));
    const version = String(args.version);
    await pinRuntimeInConfig(CONFIG_PATH, kind, version);
    console.log(`Pinned ${pc.cyan(kind)} to ${pc.bold(version)} in ${pc.dim(CONFIG_PATH)}`);
    console.log(pc.dim(`Run \`tack runtimes install ${kind}\` to fetch it.`));
  },
});

const runtimeSync = defineCommand({
  meta: {
    name: "sync",
    description: "Re-pin runtimes to the versions currently installed (adopt drift)",
  },
  args: {
    runtime: { type: "positional", required: false, description: "Runtime to sync (defaults to all)" },
  },
  async run({ args }) {
    const config = await requireConfig();
    const kinds = args.runtime ? [asRuntimeKind(String(args.runtime))] : RUNTIME_KINDS;

    // Only re-pin runtimes that are actually pinned — syncing is about reconciling an
    // existing pin with reality, not minting one for an unpinned runtime.
    const versionByKind = new Map<RuntimeKind, string>();
    for (const kind of kinds) {
      if (!config.runtimes[kind]?.version) {
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.dim("unpinned — nothing to sync")}`);
        continue;
      }
      try {
        const r = resolveRuntime(config, kind);
        versionByKind.set(kind, r.version);
      } catch (err) {
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.red("unavailable")}  ${pc.dim((err as Error).message)}`);
      }
    }

    const changed = await setRuntimeVersionsInConfig(CONFIG_PATH, versionByKind);
    for (const [kind, version] of versionByKind) {
      const label = changed.includes(kind) ? pc.green(`pinned → ${version}`) : pc.dim(`already ${version}`);
      console.log(`${pc.cyan(kind.padEnd(7))} ${label}`);
    }
    if (changed.length > 0) console.log(pc.dim(`\nUpdated ${CONFIG_PATH}`));
  },
});

/** `pin X (policy)` / `unpinned`, the shared pin descriptor for list & doctor. */
function pinLabelFor(config: TackConfig, kind: RuntimeKind): string {
  const pin = config.runtimes[kind]?.version;
  if (!pin) return pc.dim("unpinned");
  const policy = config.runtimes[kind]?.versionPolicy ?? DEFAULT_VERSION_POLICY;
  return pc.dim(`pin ${pin} (${policy})`);
}

const runtimeList = defineCommand({
  meta: { name: "list", description: "List all runtimes and their status" },
  async run() {
    const config = await loadConfig();
    for (const kind of RUNTIME_KINDS) {
      const pinLabel = pinLabelFor(config, kind);
      try {
        const r = resolveRuntime(config, kind);
        // A pin can be present-but-unsatisfied now that drift is advisory (warn/off);
        // call that out distinctly from a clean "ready".
        const status = r.satisfied ? pc.green("ready")  : pc.yellow("drifted");
        console.log(`${pc.cyan(kind.padEnd(7))} ${status}   ${pinLabel}  ${pc.bold(r.bin)} ${pc.dim(r.version)}`);
      } catch (err) {
        const status = config.runtimes[kind]?.version ? pc.red("unavailable") : pc.yellow("not found");
        console.log(`${pc.cyan(kind.padEnd(7))} ${status}  ${pinLabel}  ${pc.dim((err as Error).message)}`);
      }
    }
  },
});

const doctor = defineCommand({
  meta: { name: "doctor", description: "Resolve runtime binaries and verify version pins" },
  async run() {
    const config = await loadConfig();
    for (const kind of RUNTIME_KINDS) {
      const pin = config.runtimes[kind]?.version;
      try {
        const r = resolveRuntime(config, kind);
        const ok = !pin
          ? pc.dim("unpinned")
          : r.satisfied
            ? pc.green(`pinned ${pin} ✓`)
            : pc.yellow(`drifted from ${pin} (policy: ${r.policy}) — \`tack runtimes sync\` to adopt ${r.version}`);
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.bold(r.bin)}  ${pc.dim(r.version)}  ${ok}`);
        // Resolving only proves the binary runs at the pinned version — not that it's
        // logged in. A quick credential-presence check turns a confusing mid-run auth
        // failure into an up-front nudge.
        const auth = runtimeAuth(kind);
        const authLabel =
          auth.state === "signed-in" ? pc.green(`✓ ${auth.detail}`) : pc.yellow(`? ${auth.detail}`);
        console.log(`${" ".padEnd(7)} ${pc.dim("auth")}  ${authLabel}`);
      } catch (err) {
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.red((err as Error).message)}`);
      }
    }

    // Role pins vs. what each login actually offers. A connected binary at the right
    // version can still reject a pinned model (a ChatGPT codex login doesn't offer
    // `gpt-5.6-sol`), and every agent on that role would then die with
    // `model_not_found`. Read-only: report, and point at `tack models sync` to fix.
    // Runtimes that can't list models (or a lookup that fails) are skipped silently.
    for (const role of ROLE_KEYS) {
      for (const key of roleModelKeys(config, role)) {
        const model = resolveModel(config, key);
        const r = checkModelOffered(config, model, { role });
        if (r.ok === false) console.log(pc.yellow(`! ${r.message}`));
      }
    }
  },
});

const sessionFollow = defineCommand({
  meta: { name: "follow", description: "Follow an agent's live transcript" },
  args: { agentId: { type: "positional", description: "Agent id", required: true } },
  async run({ args }) { await followAgent(args.agentId); },
});

// `default: "list"` makes bare `tack runtimes` run the list subcommand without
// double-printing (see the note on `projects`). `alias: "runtime"` accepts the
// singular spelling.
const runtimes = defineCommand({
  meta: { name: "runtimes", alias: "runtime", description: "Manage runtime CLIs (list, doctor, install, pin, sync)" },
  subCommands: { list: runtimeList, doctor, install: runtimeInstall, pin: runtimePin, sync: runtimeSync },
  default: "list",
});

/** Immediate subdirectories of `dir` that are git repositories. */
function gitReposIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, ".git")))
    .map((e) => join(dir, e.name))
    .sort();
}

/** The git repository root containing `dir`, or null if `dir` is not in a repo.
 * Uses `git rev-parse` so it works from a subdirectory and with worktrees. */
function gitRootOf(dir: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Summarizes each candidate repo and adds the not-yet-configured ones to the
 * config, skipping anything already present (by name or path). Prints per-repo
 * progress with a spinner and a final summary; returns the projects added. */
async function addProjects(config: TackConfig, candidates: string[]): Promise<Project[]> {
  const knownNames = new Set(config.projects.map((p) => p.name));
  const knownPaths = new Set(config.projects.map((p) => p.path));
  const entries: Project[] = [];
  for (const path of candidates) {
    const name = basename(path);
    if (knownNames.has(name) || knownPaths.has(path) || knownPaths.has(collapseHome(path))) {
      console.log(pc.dim(`skipped ${name}: already configured`));
      continue;
    }
    if (!existsSync(path)) {
      console.log(pc.dim(`skipped ${name}: ${path} does not exist`));
      continue;
    }
    const spin = startSpinner(`Scoping ${name}`);
    try {
      const { description, metadata } = await summarizeProject(config, path);
      spin.succeed("done");
      console.log(`  ${description}`);
      console.log(pc.dim(`  ${metadata.language} · ${metadata.frameworks.join(", ")}`));
      entries.push({ name, path: collapseHome(path), description, metadata });
      knownNames.add(name);
    } catch (err) {
      spin.fail("failed");
      console.log(pc.dim(`  ${(err as Error).message}`));
    }
  }

  if (entries.length === 0) {
    console.log(pc.dim("No projects added."));
    return [];
  }
  const added = await addProjectsToConfig(CONFIG_PATH, entries);
  console.log(`\nAdded ${pc.bold(String(added.length))} project(s) to ${pc.dim(CONFIG_PATH)}:`);
  for (const p of added) console.log(`  ${pc.bold(p.name)}  ${pc.dim(p.path)}`);
  return added;
}

/** If the current directory is inside a git repo that isn't configured yet,
 * summarize and register it, then return a config reflecting the addition — so
 * `tack session create`/`tack agent` work in a fresh repo without a separate `projects add`.
 * Already-configured repos (and non-repo directories) return the config as-is
 * with no output. */
async function ensureCwdProject(config: TackConfig): Promise<TackConfig> {
  const root = gitRootOf(process.cwd());
  if (!root) return config;
  const configured = config.projects.some(
    (p) => p.name === basename(root) || p.path === root || p.path === collapseHome(root),
  );
  if (configured) return config;
  console.log(pc.bold("Project"));
  const added = await addProjects(config, [root]);
  if (added.length === 0) return config;
  // Reload so the caller sees the freshly written project.
  return await loadConfig();
}

const projectsAdd = defineCommand({
  meta: { name: "add", description: "Add a project by path, auto-describing it with a summary model" },
  args: {
    path: { type: "positional", required: false, description: "Path to the repo to add" },
    all: { type: "boolean", description: "Add every git repo in the current directory" },
  },
  async run({ args }) {
    const config = await requireConfig();

    // Resolve the candidate repo paths: every git repo under the current directory
    // with `--all`, otherwise the single path the user named.
    let candidates: string[];
    if (args.all) {
      candidates = gitReposIn(process.cwd());
      if (candidates.length === 0) return console.log(pc.dim(`No git repos found in ${process.cwd()}.`));
    } else if (args.path) {
      candidates = [resolve(expandHome(String(args.path)))];
    } else {
      console.error(pc.red("Specify a path to add, or --all to add every git repo here."));
      return process.exit(1);
    }

    await addProjects(config, candidates);
  },
});

const projectsList = defineCommand({
  meta: { name: "list", description: "List configured projects" },
  async run() {
    const config = await loadConfig();
    if (config.projects.length === 0) return console.log(pc.dim("No projects configured."));
    for (const p of config.projects) {
      console.log(`${pc.bold(p.name)}  ${pc.dim(p.path)}`);
      console.log(`  ${p.description}`);
      if (p.metadata) console.log(pc.dim(`  ${p.metadata.language} · ${p.metadata.frameworks.join(", ")}`));
    }
  },
});

const projectsRefresh = defineCommand({
  meta: {
    name: "refresh",
    description: "Re-summarize configured project(s), updating description and metadata in place",
  },
  args: {
    project: { type: "positional", required: false, description: "Project name or path to refresh" },
    all: { type: "boolean", description: "Refresh every configured project" },
  },
  async run({ args }) {
    const config = await requireConfig();
    if (config.projects.length === 0) return console.log(pc.dim("No projects configured."));

    // Resolve which configured projects to refresh: all of them, or the single one
    // the user named (matched by name or home-expanded path).
    let targets: Project[];
    if (args.all) {
      targets = config.projects;
    } else if (args.project) {
      const key = String(args.project);
      const expanded = resolve(expandHome(key));
      const match = config.projects.find((p) => p.name === key || p.path === expanded);
      if (!match) {
        console.error(pc.red(`No configured project matches "${key}" (by name or path).`));
        return process.exit(1);
      }
      targets = [match];
    } else {
      console.error(pc.red("Specify a project name or path to refresh, or --all."));
      return process.exit(1);
    }

    let refreshed = 0;
    for (const project of targets) {
      if (!existsSync(project.path)) {
        console.log(pc.dim(`skipped ${project.name}: ${project.path} does not exist`));
        continue;
      }
      const spin = startSpinner(`Scoping ${project.name}`);
      try {
        const { description, metadata } = await summarizeProject(config, project.path);
        // Preserve name and the config's stored (home-collapsed) path; swap in the
        // freshly generated description + metadata.
        const updated: Project = { name: project.name, path: collapseHome(project.path), description, metadata };
        const previous = await updateProjectInConfig(CONFIG_PATH, updated);
        if (!previous) {
          spin.fail("failed");
          console.log(pc.dim(`  ${project.name} is no longer in the config`));
          continue;
        }
        spin.succeed("done");
        console.log(`  ${description}`);
        console.log(pc.dim(`  ${metadata.language} · ${metadata.frameworks.join(", ")}`));
        refreshed++;
      } catch (err) {
        spin.fail("failed");
        console.log(pc.dim(`  ${(err as Error).message}`));
      }
    }
    console.log(`\nRefreshed ${pc.bold(String(refreshed))} project(s) in ${pc.dim(CONFIG_PATH)}.`);
  },
});

const projectsRemove = defineCommand({
  meta: { name: "remove", description: "Remove a configured project by name or path" },
  args: {
    project: { type: "positional", required: true, description: "Project name or path to remove" },
  },
  async run({ args }) {
    ensureConfigExists();
    const removed = await removeProjectFromConfig(CONFIG_PATH, String(args.project));
    if (!removed) {
      console.error(pc.red(`No configured project matches "${args.project}" (by name or path).`));
      return process.exit(1);
    }
    console.log(`Removed ${pc.bold(removed.name)}  ${pc.dim(removed.path)} from ${pc.dim(CONFIG_PATH)}.`);
  },
});

// `default: "list"` makes bare `tack projects` run the list subcommand. citty
// runs a parent's own `run` even after dispatching to a subcommand, so listing
// here via `run` would double-print on `tack projects list`; a default avoids that.
const projects = defineCommand({
  meta: { name: "projects", alias: "project", description: "List, add, refresh, and remove configured projects" },
  subCommands: { list: projectsList, add: projectsAdd, refresh: projectsRefresh, remove: projectsRemove },
  default: "list",
});

/** The functional roles, in schema order — the set `tack roles set` accepts. */
const ROLE_KEYS = Object.keys(RolesSchema.shape) as (keyof Roles)[];

/** Prints the `Roles` section: each role → its candidate model keys. Shared by
 * `tack models list` and `tack roles list` so the two stay in lockstep. */
function printRoles(roles: TackConfig["roles"]): void {
  console.log(pc.bold("Roles"));
  for (const [role, keys] of Object.entries(roles)) {
    console.log(`  ${role.padEnd(11)} → ${pc.cyan(keys.join(" | "))}${keys.length > 1 ? pc.dim(" (random)") : ""}`);
  }
}

const modelsList = defineCommand({
  meta: { name: "list", description: "List configured models and role pins" },
  async run() {
    const config = await loadConfig();
    console.log(pc.bold("Models"));
    for (const m of config.models) {
      const price = m.pricing ? pc.dim(" (priced)") : m.runtime === "codex" ? pc.red(" (no pricing!)") : "";
      console.log(`  ${pc.cyan(m.key)}  ${pc.dim(`${m.runtime}:${m.id}`)}${m.effort ? pc.dim(` @${m.effort}`) : ""}${price}`);
    }
    printRoles(config.roles);
  },
});

const rolesList = defineCommand({
  meta: { name: "list", description: "List role pins (which model each role uses)" },
  async run() {
    const config = await loadConfig();
    printRoles(config.roles);
  },
});

const rolesSet = defineCommand({
  meta: { name: "set", description: "Set one or more candidate models for a role in the config file" },
  args: {
    role: { type: "positional", required: true, description: `Role to pin (${ROLE_KEYS.join(" | ")})` },
    model: { type: "positional", required: true, description: "Model key(s) from config, space- or comma-separated" },
  },
  async run({ args }) {
    const role = String(args.role);
    // Citty keeps ALL positional values in `_`, including the named role/model.
    const models = [...new Set(args._.slice(1).flatMap((value) => String(value).split(",")))];
    if (!ROLE_KEYS.includes(role as keyof Roles)) {
      console.error(pc.red(`Unknown role "${role}".`) + pc.dim(` Known roles: ${ROLE_KEYS.join(", ")}.`));
      process.exit(1);
    }
    const config = await loadConfig();
    for (const model of models) {
      if (!config.models.some((m) => m.key === model)) {
        const keys = config.models.map((m) => m.key).join(", ");
        console.error(pc.red(`Unknown model "${model}".`) + pc.dim(` Configured models: ${keys || "none"}.`));
        process.exit(1);
      }
    }
    const previous = await setRoleInConfig(CONFIG_PATH, role as keyof Roles, models.length === 1 ? models[0]! : models);
    const previousKeys = Array.isArray(previous) ? previous : [previous];
    const label = models.join(" | ");
    if (JSON.stringify(previousKeys) === JSON.stringify(models)) {
      console.log(pc.dim(`${role} already → ${label}`));
    } else {
      console.log(`${role.padEnd(11)} ${pc.dim(previousKeys.join(" | "))} → ${pc.cyan(label)}`);
    }
  },
});

const roles = defineCommand({
  meta: { name: "roles", alias: "role", description: "List role candidates; set one or more models for a role" },
  subCommands: { list: rolesList, set: rolesSet },
  default: "list",
});

/**
 * Fill codex-model pricing from models.dev into the config, printing progress and
 * results. Shared by `models sync` (which runs it automatically after seeding the
 * catalog) and the hidden `sync-pricing` back-compat command. Only codex models need
 * this — claude reports `total_cost_usd` directly — so by default we fill the codex
 * models missing pricing; `all` re-fetches every codex model. Throws if the
 * models.dev fetch fails so the caller can decide how loudly to react.
 */
async function fillCodexPricing(config: TackConfig, all: boolean): Promise<void> {
  const targets = config.models.filter((m) => m.runtime === "codex" && (all || !m.pricing));
  if (targets.length === 0) {
    console.log(
      pc.dim("No codex models need pricing. (Claude reports cost directly; pass --all to refresh anyway.)"),
    );
    return;
  }

  console.log(pc.dim(`Fetching pricing from ${MODELS_DEV_URL} …`));
  const catalog = await fetchPricingCatalog();

  const updates = new Map<string, Pricing>();
  const misses: string[] = [];
  for (const m of targets) {
    const p = pricingForModel(m, catalog);
    if (p) updates.set(m.key, p);
    else misses.push(`${m.key} (${m.id})`);
  }

  if (updates.size === 0) {
    console.log(pc.yellow(`No pricing found on models.dev for: ${misses.join(", ")}.`));
    console.log(pc.dim("Set pricing by hand in the config, or check the model id."));
    return;
  }

  const applied = await setModelsPricingInConfig(CONFIG_PATH, updates);
  console.log(`\nUpdated pricing for ${pc.bold(String(applied.length))} model(s) in ${pc.dim(CONFIG_PATH)}:`);
  for (const key of applied) {
    const p = updates.get(key)!;
    const fmt = (n: number | undefined) => (n === undefined ? "–" : String(n));
    console.log(
      `  ${pc.cyan(key)}  ${pc.dim(`in ${fmt(p.inputPer1M)} · out ${fmt(p.outputPer1M)} · cacheR ${fmt(p.cacheReadPer1M)} (USD per 1M)`)}`,
    );
  }
  if (misses.length) console.log(pc.dim(`\nNo match on models.dev for: ${misses.join(", ")} — set those by hand.`));
}

const modelsSync = defineCommand({
  meta: {
    name: "sync",
    // `refresh` is the historical name; keep it working as an alias so muscle memory
    // and scripts don't break, but `sync` is the one we surface — it matches
    // `runtimes sync` and now also folds in the pricing step.
    alias: "refresh",
    description:
      "Reconcile models with what the connected runtime CLIs offer (adding new ones, pruning ones the login can't use and re-pinning their roles), then fill codex pricing from models.dev",
  },
  args: {
    all: { type: "boolean", description: "Also re-fetch pricing for codex models that already have it" },
  },
  async run({ args }) {
    const config = await requireConfig();

    // 1) Gather the models each runtime that resolves to a working binary (honoring
    // any version pin) offers — an unavailable CLI contributes no models. A runtime
    // that can list models for the signed-in account is authoritative: that live
    // list is what "the models the connected CLIs allow" means, borrowing curated
    // catalog fields for ids the catalog knows. Otherwise fall back to the catalog.
    const candidates: Model[] = [];
    const offered = new Map<RuntimeKind, Model[]>();
    for (const kind of RUNTIME_KINDS) {
      let version: string;
      let bin: string;
      try {
        ({ version, bin } = resolveRuntime(config, kind));
      } catch (err) {
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.yellow("not connected")} ${pc.dim((err as Error).message)}`);
        continue;
      }
      const live = selectRuntime(kind).listModels?.(bin) ?? null;
      if (live) {
        const merged = live.map((m) => MODEL_CATALOG[kind].find((c) => c.id === m.id) ?? m);
        offered.set(kind, merged);
        candidates.push(...merged);
        console.log(
          `${pc.cyan(kind.padEnd(7))} ${pc.green("connected")} ${pc.dim(`${version} · ${merged.length} model(s) offered to this login`)}`,
        );
      } else {
        candidates.push(...MODEL_CATALOG[kind]);
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.green("connected")} ${pc.dim(`${version} · using Tack's catalog`)}`);
      }
    }

    // Skip candidates whose id is already configured under another key (e.g. a
    // hand-added `gpt-6.1-sol-high`) so sync doesn't duplicate them.
    const configuredIds = new Set(config.models.map((m) => `${m.runtime}:${m.id}`));
    const added = await addModelsToConfig(
      CONFIG_PATH,
      candidates.filter((c) => !configuredIds.has(`${c.runtime}:${c.id}`)),
    );
    if (added.length === 0) {
      console.log(pc.dim("\nNo new models to add — every offered model is already configured."));
    } else {
      console.log(`\nAdded ${pc.bold(String(added.length))} model(s) to ${pc.dim(CONFIG_PATH)}:`);
      for (const m of added) console.log(`  ${pc.cyan(m.key)}  ${pc.dim(`${m.runtime}:${m.id}`)}`);
    }

    // 2) Prune configured models an authoritative runtime no longer offers — the
    // login would reject them at run time (`model_not_found`). Any role pinned to one
    // is re-pinned first (the config must stay loadable between writes) to the best
    // replacement from the same provider; if there is none, the model is kept and
    // the user is told to re-pin by hand rather than leaving the role dangling.
    let current = await requireConfig();
    const stale = current.models.filter(
      (m) => offered.has(m.runtime) && !offered.get(m.runtime)!.some((o) => o.id === m.id),
    );
    const staleKeys = new Set(stale.map((m) => m.key));
    // Retained stale keys still cannot serve as replacements for other candidates.
    const allStaleKeys = new Set(staleKeys);
    for (const role of ROLE_KEYS) {
      let changed = false;
      const next = roleModelKeys(current, role).map((key) => {
        const pinned = stale.find((m) => m.key === key);
        if (!pinned) return key;
        // Rank the runtime's own offering (best-first) ahead of other configured models.
        const rank = (m: Model) => {
          const i = (offered.get(m.runtime) ?? []).findIndex((o) => o.id === m.id);
          return i < 0 ? Number.MAX_SAFE_INTEGER : i;
        };
        const pool = current.models
          .filter((m) => !allStaleKeys.has(m.key) && m.provider === pinned.provider)
          .sort((a, b) => rank(a) - rank(b));
        const replacement = pickReplacement(pinned, pool);
        if (!replacement) {
          staleKeys.delete(pinned.key);
          console.log(
            pc.red(`\n! roles.${role} includes ${pinned.key}, which ${pinned.runtime} no longer offers, and no other ${pinned.provider} model is configured.`) +
              pc.dim(`\n  Kept ${pinned.key}; re-pin with \`tack roles set ${role} <model>\`.`),
          );
          return key;
        }
        changed = true;
        console.log(
          pc.yellow(`\n! roles.${role} included ${pinned.key}, which ${pinned.runtime} no longer offers to this login.`) +
            `\n  Re-pinned ${role} ${pc.dim(pinned.key)} → ${pc.cyan(replacement.key)}` +
            pc.dim(` (change with \`tack roles set ${role} <model>\`)`),
        );
        return replacement.key;
      });
      if (changed) {
        const keys = [...new Set(next)];
        await setRoleInConfig(CONFIG_PATH, role, keys.length === 1 ? keys[0]! : keys);
        current = await requireConfig();
      }
    }
    const removed = await removeModelsFromConfig(CONFIG_PATH, staleKeys);
    if (removed.length > 0) {
      console.log(`\nRemoved ${pc.bold(String(removed.length))} model(s) no longer offered:`);
      for (const m of removed) console.log(`  ${pc.cyan(m.key)}  ${pc.dim(`${m.runtime}:${m.id}`)}`);
    }

    // 3) Fill codex pricing. Reload first so models added above are considered.
    const fresh = await requireConfig();
    try {
      await fillCodexPricing(fresh, Boolean(args.all));
    } catch (err) {
      // Pricing is best-effort here — a freshly seeded catalog is still useful
      // offline — so warn rather than fail the whole command.
      console.error(pc.red(`\nCould not fetch pricing: ${(err as Error).message}`));
    }
  },
});

// Folded into `models sync`; kept hidden so `tack models sync-pricing` and the
// `--all` escape hatch keep working for anyone who scripted them.
const modelsSyncPricing = defineCommand({
  meta: {
    name: "sync-pricing",
    hidden: true,
    description: "Fill codex model pricing from models.dev (folded into `models sync`; kept for back-compat)",
  },
  args: {
    all: { type: "boolean", description: "Refresh pricing for every codex model, not just those missing it" },
  },
  async run({ args }) {
    const config = await requireConfig();
    try {
      await fillCodexPricing(config, Boolean(args.all));
    } catch (err) {
      console.error(pc.red(`Could not fetch pricing: ${(err as Error).message}`));
      return process.exit(1);
    }
  },
});

// `default: "list"` makes bare `tack models` run the list subcommand without
// double-printing (see the note on `projects`).
const models = defineCommand({
  meta: { name: "models", alias: "model", description: "List configured models and role pins; sync from connected runtimes" },
  subCommands: { list: modelsList, sync: modelsSync, "sync-pricing": modelsSyncPricing },
  default: "list",
});

const requireSession = (id: string) => {
  if (!getSession(id)) {
    console.error(pc.red(`Unknown session "${id}".`));
    process.exit(1);
  }
};

const sessionApprove = defineCommand({
  meta: { name: "approve", description: "Approve a session's plan when the in-session approval prompt didn't appear" },
  args: { session: { type: "positional", description: "Session id" } },
  async run({ args }) {
    const id = String(args.session);
    requireSession(id);
    const approvedAt = getSession(id)!.plan_approved_at;
    if (approvedAt) {
      console.log(pc.dim(`Session ${id} was already approved at ${approvedAt}.`));
      return;
    }
    approveSessionPlan(id);
    console.log(pc.green(`Approved plan for ${id}. Go back to the session; the supervisor can now spawn agents.`));
  },
});

const archive = defineCommand({
  meta: { name: "archive", description: "Archive a session (hide from the default view)" },
  args: { session: { type: "positional", description: "Session id" } },
  async run({ args }) {
    requireSession(String(args.session));
    archiveSession(String(args.session));
    console.log(pc.dim(`archived ${args.session}`));
  },
});

const unarchive = defineCommand({
  meta: { name: "unarchive", description: "Restore an archived session" },
  args: { session: { type: "positional", description: "Session id" } },
  async run({ args }) {
    requireSession(String(args.session));
    const { resumedAgents } = unarchiveSession(String(args.session));
    console.log(pc.dim(`unarchived ${args.session} · resumed ${resumedAgents.length} agent(s)`));
    console.log(pc.dim(`Rejoin the supervisor with tack session resume ${args.session}`));
  },
});

const stop = defineCommand({
  meta: { name: "stop", description: "Stop a session and its agents" },
  args: { session: { type: "positional", description: "Session id" } },
  async run({ args }) {
    requireSession(String(args.session));
    stopSession(String(args.session));
    console.log(pc.dim(`stopped ${args.session}`));
  },
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete a session, its worktrees, and its artifacts" },
  args: { session: { type: "positional", description: "Session id" } },
  async run({ args }) {
    requireSession(String(args.session));
    deleteSession(String(args.session));
    console.log(pc.dim(`deleted ${args.session}`));
  },
});

const sessionsList = defineCommand({
  meta: { name: "list", description: "List sessions and their cost" },
  args: { all: { type: "boolean", description: "Include archived sessions" } },
  async run({ args }) {
    const rows = listSessions(Boolean(args.all));
    if (rows.length === 0) return console.log(pc.dim("No sessions yet."));
    for (const s of rows) {
      // Flag sessions waiting on the human — a plan to approve, or unread completed
      // agent work. Any session can be rejoined (`tack session resume`), so we no
      // longer surface an "attachable" tag; this is the state that actually needs you.
      const needsInput = sessionNeedsInput(s, listAgents(s.id));
      const tag = needsInput ? `  ${pc.yellow("◆ needs input")}` : "";
      console.log(`${pc.bold(s.id)}  ${pc.dim(s.status)}  ${usd(sessionTotalCost(s.id).total)}${tag}  ${s.title ? pc.dim(s.title) : ""}`);
    }
  },
});

const agent = defineCommand({
  meta: { name: "agent", description: "Spawn a single agent on a project (direct, no supervisor)" },
  args: {
    project: { type: "positional", description: "Project name from config" },
    prompt: { type: "positional", description: "Task for the agent" },
    model: { type: "string", description: "Model key (defaults to roles.agent; random pick when several are set)" },
  },
  async run({ args }) {
    const config = await ensureCwdProject(await loadConfig());
    const project = config.projects.find((p) => p.name === args.project);
    if (!project) {
      console.error(pc.red(`Unknown project "${args.project}". Run \`tack projects\`.`));
      process.exit(1);
    }
    const model = args.model ? resolveModel(config, args.model) : modelForRole(config, "agent");
    const session = createSession({ title: String(args.prompt).slice(0, 80) });
    // Stash the prompt so the background titler can replace the truncated title.
    writeSupervisorPrompt(session.id, String(args.prompt));
    spawnSessionTitler(session.id);
    console.log(`${pc.dim("session")} ${pc.bold(session.id)}  ${pc.dim(`${model.runtime}:${model.id}`)}`);

    const run = executeAgent({ session, project, model, prompt: String(args.prompt), config });
    const pending: Pending = { spinner: startSpinner("Thinking") };
    let step = await run.next();
    while (!step.done) {
      renderStreamEvent(step.value, pending);
      step = await run.next();
    }
    pending.spinner?.stop();
    const { ok, agent: row } = step.value;
    console.log(`\n${ok ? pc.green("done") : pc.red("failed")}  ${pc.cyan(row.id)}  ${usd(row.cost)}`);
  },
});

const GO_EDITOR_TEMPLATE = `<!-- Describe the problem for Tack to plan and coordinate agents on. -->
<!-- Markdown is fine: '#' is a heading, not a comment. Comment lines are ignored. -->
<!-- Save and close when you're done; leave this empty to abort. -->
`;

const GO_FOLLOWUP_TEMPLATE = `<!-- Follow up with the supervisor: a course correction, a new task, an answer. -->
<!-- It keeps its plan, spawned agents, and shared context from before. -->
<!-- Save and close when you're done; leave this empty to abort. -->
`;

const sessionCreate = defineCommand({
  meta: { name: "create", description: "Create a session: plan and coordinate agents for a problem" },
  args: {
    "tack-bug-from": { type: "string", description: "Report a Tack bug from this session in a new interactive session (interactive even with -b)" },
    "tack-bug-from-env": { type: "boolean", description: "Report a Tack bug from TACK_ATTACHED_SESSION (interactive even with -b)" },
    message: { type: "string", alias: "m", description: "Seed the first message inline (foreground) or the problem to solve (--background)" },
    background: { type: "boolean", alias: "b", description: "Run the supervisor headless & detached instead of interactively; watch it with `tack dashboard`" },
  },
  async run({ args }) {
    const bugSourceId = args["tack-bug-from"] ?? (args["tack-bug-from-env"] ? process.env.TACK_ATTACHED_SESSION : undefined);
    if (args["tack-bug-from-env"] && !bugSourceId) throw new Error("TACK_ATTACHED_SESSION is not set");
    if (bugSourceId !== undefined) requireSession(String(bugSourceId));
    const bugSource = bugSourceId !== undefined ? getSession(String(bugSourceId))! : undefined;
    // Bug reports always use the attended create lifecycle, including with -b.
    const background = Boolean(args.background) && !bugSource;
    const message = args.message !== undefined ? String(args.message).trim() : undefined;

    // Foreground (default) drops you into the runtime's own interactive TUI as the
    // supervisor — no editor round-trip, real scrollback. `--background` runs the
    // headless autonomous runner, which needs a seed prompt up front (via `-m` or
    // the editor). Continuing an existing session lives in `tack session resume`.
    if (background) return runBackground({ message });

    const config = await ensureCwdProject(await loadConfig());
    // A seed is optional interactively: `-m` sends the first message, otherwise you
    // land in an idle TUI and type it yourself.
    let prompt = message ?? "";
    if (bugSource) {
      let description = message;
      if (description === undefined) {
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        try {
          description = await terminal.question(`What went wrong in ${bugSource.id}? (optional, Enter to skip) `);
        } finally {
          terminal.close();
        }
      }
      const hasTack = config.projects.some(project => project.name === "tack");
      if (!hasTack) console.log(pc.yellow("Warning: no configured project is named tack."));
      prompt = tackBugSeed(bugSource.id, description, hasTack);
    }
    const session = createSupervisorSession(prompt, config);
    const model = resolveModel(config, session.supervisor_model!);
    if (bugSource) writeTackBugReport(session.id, bugSource);
    console.log(`${pc.dim("supervisor")} ${pc.bold(session.id)} ${pc.dim(`· ${model.key} (${model.runtime}:${model.id})`)}`);
    // Title from the seed now — before superviseInteractive blocks on the TUI. With
    // no seed, the prompt-submit hook titles it from the first human ask.
    if (prompt) {
      writeSupervisorPrompt(session.id, prompt);
      spawnSessionTitler(session.id);
    }

    const { detached } = await superviseInteractive({ session, prompt, resume: false, config });
    reportInteractiveOutcome(session.id, detached);
  },
});

const sessionRefresh = defineCommand({
  meta: { name: "refresh", description: "Refresh stale Tack processes; --all parks supervisors detached in tmux (without tmux, leaves them stopped for resume)" },
  args: {
    session: { type: "positional", required: false, description: "Session id (or use --all)" },
    all: { type: "boolean", description: "Refresh all stale active sessions" },
    force: { type: "boolean", description: "Allow refresh during a turn or pending plan approval" },
  },
  async run({ args }) {
    if (Boolean(args.all) === Boolean(args.session)) throw new Error("Pass a session id or --all");
    const config = await loadConfig();
    if (args.all) {
      for (const result of await refreshAllStaleSessions(config, { force: args.force })) {
        const id = result.session.id;
        if (result.status === "blocked") console.error(`${id}: refresh blocked: ${result.reason}`);
        else if (result.status === "error") {
          console.error(`${id}: ${result.error}`);
          process.exitCode = 1;
        } else console.log(`${id}: ${result.status === "refreshed" ? "refreshed" : "already current"}`);
      }
      return;
    }
    const sessions = [getSession(String(args.session))];
    for (const session of sessions) {
      if (!session) throw new Error(`Unknown session ${args.session}`);
      const result = await refreshSession(session.id, config, { force: args.force });
      if (result.blocked) {
        console.error(`${session.id}: refresh blocked: ${result.blocked}`);
        process.exitCode = 1;
        continue;
      }
      console.log(`${session.id}: ${result.refreshed ? "refreshed" : "already current"}`);
      if (result.refreshed) {
        if (!result.supervisor) {
          const attached = await attachSupervisor(session.id, config);
          if (attached.alive) { reportInteractiveOutcome(session.id, attached.detached); continue; }
        }
        const { detached } = await superviseInteractive({ session: getSession(session.id)!, prompt: REFRESH_MESSAGE, resume: true, config, park: false });
        reportInteractiveOutcome(session.id, detached);
      }
    }
  },
});

/** Recovery after sleep or a network drop: restart the supervisor even on current
 * code, revive agents the outage killed, restart a dead PR watcher, then park the
 * replacement supervisor detached in tmux and hand the terminal back. */
const sessionReconnect = defineCommand({
  meta: { name: "reconnect", description: "Recover a session after sleep or a lost connection; restarts the supervisor detached in tmux (--all for every active session)" },
  args: {
    session: { type: "positional", required: false, description: "Session id (or use --all)" },
    all: { type: "boolean", description: "Reconnect every active session" },
  },
  async run({ args }) {
    if (Boolean(args.all) === Boolean(args.session)) throw new Error("Pass a session id or --all");
    const config = await loadConfig();
    if (args.all) {
      for (const result of await reconnectAllSessions(config)) {
        const id = result.session.id;
        if (result.status === "error") {
          console.error(`${id}: ${result.error}`);
          process.exitCode = 1;
        } else {
          console.log(`${id}: ${describeReconnect(result)}${result.parked ? " · parked in tmux" : ""}`);
          if (result.failedAgents.length) process.exitCode = 1;
        }
      }
      return;
    }
    const id = String(args.session);
    requireSession(id);
    const result = await reconnectSession(id, config);
    if (!getSession(id)!.resume_ref) {
      console.log(pc.dim(`${id}: ${describeReconnect(result)}`));
      console.error(pc.red(`Session "${id}" has no resume handle yet — it never got far enough to follow up on.`));
      return process.exit(1);
    }
    // Unlike refresh, always relaunch: the user asked to reconnect this session,
    // so a supervisor that was already down comes back too.
    const park = await parkReconnectedSupervisor(id, config);
    console.log(`${id}: ${describeReconnect(result)}${park.parked ? " · parked in tmux" : ""}`);
    if (park.parked) {
      console.log(pc.dim(`Rejoin it with \`tack session resume ${id}\`.`));
      console.log(pc.dim("Watch work with `tack dashboard`."));
    } else if (park.reason === "no-tmux") {
      console.log(pc.dim(`tmux is unavailable, so the supervisor is stopped. Run \`tack session resume ${id}\` to start it.`));
    } else {
      console.error(pc.red(`Could not park the supervisor in tmux. Run \`tack session resume ${id}\` to start it.`));
      process.exitCode = 1;
    }
    if (result.failedAgents.length) process.exitCode = 1;
  },
});

const sessionResume = defineCommand({
  meta: {
    name: "resume",
    description: "Rejoin a running session (right where you left it), or resume a stopped one's conversation",
  },
  args: {
    session: { type: "positional", description: "Session id" },
    message: { type: "string", alias: "m", description: "Seed a message on resume (foreground) or the follow-up (--background)" },
    background: { type: "boolean", alias: "b", description: "Resume headless & detached instead of interactively" },
  },
  async run({ args }) {
    const id = String(args.session);
    requireSession(id);
    const message = args.message !== undefined ? String(args.message).trim() : undefined;

    // Headless follow-up: no human in the loop, so hand it to the background runner.
    if (args.background) return runBackground({ resumeId: id, message });

    const config = await loadConfig();

    let refreshedSupervisor = false;
    const before = getSession(id)!;
    const stale = isSessionStale(before);
    if (stale.stale) {
      const blocked = refreshBlockedReason(before);
      if (stale.supervisor && blocked) {
        console.log(pc.dim(`Running old Tack code (${blocked}); run tack session refresh ${id} once idle.`));
        if (stale.watcher) await refreshSession(id, config, { watcherOnly: true });
      } else {
        console.log(pc.dim(`Refreshing ${id} onto new Tack code…`));
        const result = await refreshSession(id, config, { watcherOnly: !stale.supervisor });
        refreshedSupervisor = result.refreshed && result.supervisor;
      }
    }

    // Prefer rejoining a live, parked session — that lands you back exactly where
    // you left it (e.g. a pending plan approval), which a transcript resume can't
    // reconstruct. Falls through when there's nothing live to rejoin.
    const attached = await attachSupervisor(id, config);
    if (attached.alive) return reportInteractiveOutcome(id, attached.detached);

    // Nothing live to rejoin — resume the conversation from its transcript, which
    // reloads the plan/agents/context but starts a fresh turn.
    const existing = getSession(id)!;
    if (!existing.resume_ref) {
      console.error(pc.red(`Session "${id}" has no resume handle yet — it never got far enough to follow up on.`));
      return process.exit(1);
    }
    const prompt = refreshedSupervisor ? [REFRESH_MESSAGE, message].filter(Boolean).join("\n\n") : message ?? "";
    console.log(`${pc.dim("supervisor")} ${pc.bold(existing.id)} ${pc.dim(`· ${existing.supervisor_model ?? "?"} (${existing.runtime ?? "?"})`)} ${pc.dim("· resuming")}`);
    const { detached } = await superviseInteractive({ session: existing, prompt, resume: true, config });
    reportInteractiveOutcome(id, detached);
  },
});

/**
 * Prints the outcome of an interactive supervisor turn. Detaching leaves it running
 * (rejoin with `resume`); a genuine exit reports final cost. Shared by `create`
 * (fresh) and `resume` (rejoin / transcript-resume) so their tails read identically.
 */
function reportInteractiveOutcome(id: string, detached: boolean): void {
  if (detached) {
    // Left running inside tmux — still on whatever it was doing (e.g. a pending plan
    // approval). Rejoin lands back exactly there; open another terminal to work in
    // parallel meanwhile.
    console.log(`\n${pc.yellow("supervisor detached")}  ${pc.bold(id)} ${pc.dim("· still running")}`);
    console.log(pc.dim(`Rejoin it with \`tack session resume ${id}\`.`));
    console.log(pc.dim(`Watch work and find PRs with \`tack dashboard\`.`));
    return;
  }
  console.log(`\n${pc.green("supervisor exited")}  ${pc.bold(id)}  ${usd(sessionTotalCost(id).total)}`);
  console.log(pc.dim(`Watch work and find PRs with \`tack dashboard\`.`));
  console.log(pc.dim(`Resume it with \`tack session resume ${id}\`.`));
}

/**
 * The headless, detached supervisor path (`--background`): unlike interactive, it
 * has no human in the loop, so it needs a seed prompt up front — from `-m` or the
 * editor. It spawns the runner and hands the terminal straight back.
 */
async function runBackground(opts: { resumeId?: string; message?: string }): Promise<void> {
  const { resumeId, message } = opts;
  let problem: string;
  if (message !== undefined) {
    if (!message) {
      console.error(pc.red("Empty problem. Pass a non-empty --message."));
      return process.exit(1);
    }
    problem = message;
  } else {
    try {
      problem = captureViaEditor(resumeId ? GO_FOLLOWUP_TEMPLATE : GO_EDITOR_TEMPLATE);
    } catch (err) {
      console.error(pc.red(`Could not open an editor: ${(err as Error).message}`));
      console.error(pc.dim("Set $EDITOR, or pass it inline with `-b -m \"…\"`."));
      return process.exit(1);
    }
    if (!problem) {
      console.error(pc.red(`Aborting: no ${resumeId ? "follow-up" : "problem"} entered.`));
      return process.exit(1);
    }
  }

  const config = await ensureCwdProject(await loadConfig());
  if (resumeId) {
    const existing = getSession(resumeId);
    if (!existing) {
      console.error(pc.red(`Unknown session "${resumeId}". List them with \`tack session list\`.`));
      return process.exit(1);
    }
    if (!existing.resume_ref) {
      console.error(pc.red(`Session "${resumeId}" has no resume handle yet — it never got far enough to follow up on.`));
      return process.exit(1);
    }
    // Headless: no human to approve the plan, so open the gate up front.
    approveSessionPlan(existing.id);
    writeSupervisorPrompt(existing.id, problem);
    const pid = spawnSupervisorRunner(existing.id, "resume");
    return printBackgroundHandoff(existing.id, pid);
  }
  const session = createSupervisorSession(problem, config);
  const model = resolveModel(config, session.supervisor_model!);
  console.log(`${pc.dim("supervisor")} ${pc.dim(`· ${model.key} (${model.runtime}:${model.id})`)}`);
  // Headless: no human to approve the plan, so open the gate up front.
  approveSessionPlan(session.id);
  writeSupervisorPrompt(session.id, problem);
  spawnSessionTitler(session.id);
  const pid = spawnSupervisorRunner(session.id, "fresh");
  return printBackgroundHandoff(session.id, pid);
}

/** Prints where a detached supervisor went and how to watch/follow it. */
function printBackgroundHandoff(sessionId: string, pid: number): void {
  console.log(`${pc.green("supervisor running in background")}  ${pc.bold(sessionId)}  ${pc.dim(`pid ${pid}`)}`);
  console.log(pc.dim(`Watch work and find PRs with \`tack dashboard\`.`));
  console.log(pc.dim(`Follow up with \`tack session resume ${sessionId}\`, or stop it with \`tack session stop ${sessionId}\`.`));
}

/** One-word PR state → glyph+color, matching the dashboard's vocabulary. */
function prStateLabel(state: string | null): string {
  switch (state) {
    case "merged":
      return pc.magenta("✔ merged");
    case "open":
      return pc.green("● open");
    case "draft":
      return pc.gray("◌ draft");
    case "closed":
      return pc.red("✖ closed");
    default:
      return pc.gray(state ?? "·");
  }
}

/** A ticket's status, colored by Jira's status category (stable across projects'
 * differing workflow names) — same vocabulary as the dashboard's ticket rows. */
function ticketStatusLabel(status: string | null, category: string | null): string {
  const label = status ?? "?";
  switch (category) {
    case "done":
      return pc.green(`✔ ${label}`);
    case "indeterminate":
      return pc.yellow(`● ${label}`);
    case "new":
      return pc.gray(`○ ${label}`);
    default:
      return pc.gray(`· ${label}`);
  }
}

const sessionShow = defineCommand({
  meta: {
    name: "show",
    description: "Show one session's agents, PRs, JIRA tickets, and cost (a scriptable, non-interactive view)",
  },
  args: { session: { type: "positional", description: "Session id" } },
  async run({ args }) {
    const id = String(args.session);
    requireSession(id);
    const s = getSession(id)!;
    const agents = listAgents(id);
    const prs = listSessionPrs(id);
    const tickets = listSessionJiraTickets(id);
    const cost = sessionTotalCost(id);

    const live = sessionLive(s) ? pc.green("● live") : pc.gray("○ idle");
    const needs = sessionNeedsInput(s, agents) ? `  ${pc.yellow("◆ needs input")}` : "";
    console.log(`${pc.bold(s.id)}  ${live}  ${pc.dim(s.status)}${needs}`);
    if (s.title) console.log(`  ${s.title}`);
    console.log(
      pc.dim(`  ${s.supervisor_model ?? "?"} (${s.runtime ?? "?"})  ·  ${s.created_at}`),
    );
    console.log(
      `  cost ${usd(cost.total)} ${pc.dim(`(supervisor ${cost.supervisor.toFixed(4)} + agents ${cost.agents.toFixed(4)})`)}`,
    );

    console.log(pc.bold(`\nAgents (${agents.length})`));
    if (agents.length === 0) console.log(pc.dim("  none yet"));
    for (const a of agents) {
      const alive = a.status === "running";
      const statusColor = alive ? pc.yellow : a.status === "done" ? pc.green : a.status === "failed" ? pc.red : pc.gray;
      console.log(
        a.kind === "manual"
          ? `  ${pc.cyan(a.id)}  ${pc.blue("manual".padEnd(8))} ${pc.dim("human workspace")}  ${usd(a.cost)}  ${pc.dim(a.project_name)}`
          : `  ${pc.cyan(a.id)}  ${statusColor(a.status.padEnd(8))} ${pc.dim(`${a.runtime}:${a.model}`)}  ${usd(a.cost)}  ${pc.dim(a.project_name)}`,
      );
      if (a.branch) console.log(pc.dim(`    ${a.branch}`));
    }

    console.log(pc.bold(`\nPRs (${prs.length})`));
    if (prs.length === 0) console.log(pc.dim("  none discovered"));
    for (const pr of prs) {
      console.log(`  ${pr.number ? `#${pr.number}` : "?"}  ${prStateLabel(pr.state)}  ${pc.dim(pr.url)}`);
    }

    // Shown as last refreshed by `tack dashboard` — this view is a cheap DB read and
    // deliberately doesn't spin up the Atlassian MCP server just to print.
    console.log(pc.bold(`\nTickets (${tickets.length})`));
    if (tickets.length === 0) console.log(pc.dim("  none linked"));
    for (const t of tickets) {
      const parts = [pc.cyan(t.key), ticketStatusLabel(t.status, t.status_category)];
      if (t.title) parts.push(firstLine(t.title, 80));
      if (t.url) parts.push(pc.dim(t.url));
      console.log(`  ${parts.join("  ")}`);
    }

    const pending = listPendingAmendments(id);
    if (pending.length > 0) {
      console.log(pc.bold(`\nPending amendments (${pending.length})`) + pc.dim("  — awaiting adjudication"));
      for (const am of pending) {
        console.log(`  ${pc.yellow(am.id)}  ${pc.dim(`by ${am.proposed_by}`)}`);
        console.log(`    ${firstLine(readArtifact(am.proposal_ref))}`);
      }
    }
  },
});

/** The first non-empty line of a body, truncated — a one-line preview for lists. */
function firstLine(body: string, max = 120): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const sessionContext = defineCommand({
  meta: {
    name: "context",
    description: "Show a session's shared contract (the cross-agent coordination context) and its version history",
  },
  args: {
    session: { type: "positional", description: "Session id" },
    all: { type: "boolean", description: "Print the body of every version, not just the latest" },
  },
  async run({ args }) {
    const id = String(args.session);
    requireSession(id);
    const versions = listSharedContext(id);
    if (versions.length === 0) {
      console.log(pc.dim("No shared context authored yet."));
    } else {
      console.log(pc.bold(`Shared contract for ${id}`) + pc.dim(`  · ${versions.length} version(s)`));
      if (args.all) {
        for (const v of versions) {
          console.log(pc.bold(`\n── v${v.version}`) + pc.dim(`  by ${v.authored_by} · ${v.created_at}`));
          console.log(readArtifact(v.body_ref).trimEnd());
        }
      } else {
        const latest = versions[versions.length - 1]!;
        console.log(pc.dim(`v${latest.version} · by ${latest.authored_by} · ${latest.created_at}  (--all for history)\n`));
        console.log(readArtifact(latest.body_ref).trimEnd());
        const older = versions.slice(0, -1);
        if (older.length > 0) {
          console.log(pc.dim(`\nEarlier: ${older.map((v) => `v${v.version} (${v.authored_by})`).join(", ")}`));
        }
      }
    }

    const pending = listPendingAmendments(id);
    if (pending.length > 0) {
      console.log(pc.bold(`\nPending amendments (${pending.length})`));
      for (const am of pending) {
        console.log(`  ${pc.yellow(am.id)}  ${pc.dim(`by ${am.proposed_by}`)}`);
        console.log(`    ${firstLine(readArtifact(am.proposal_ref))}`);
      }
      console.log(pc.dim(`\nThe supervisor adjudicates these automatically (surfaced to it via wait_for_agents).`));
    }
  },
});

const sessionRetitle = defineCommand({
  meta: {
    name: "retitle",
    description: "Regenerate a session's title with the summary model (from its shared contract or seed prompt)",
  },
  args: { session: { type: "positional", description: "Session id" } },
  async run({ args }) {
    const id = String(args.session);
    requireSession(id);
    const config = await loadConfig();
    const spin = startSpinner(`Titling ${id}`);
    try {
      const title = await generateSessionTitle(config, id);
      spin.succeed("done");
      console.log(`  ${title}`);
    } catch (err) {
      spin.fail("failed");
      console.error(pc.red((err as Error).message));
      process.exit(1);
    }
  },
});

const sessionEdit = defineCommand({
  meta: {
    name: "edit",
    description: "Open an agent's worktree in $VISUAL or $EDITOR, or create a manual workspace with --new [project]",
  },
  args: {
    session: { type: "positional", description: "Session id", required: true },
    // `--new` is a boolean so `--new --print-path` can't swallow the next flag as its
    // value; with it set, this positional names the project instead of an agent.
    agent: { type: "positional", description: "Agent id (required when several worktrees exist); with --new, the project", required: false },
    new: { type: "boolean", description: "Create a clean manual workspace (its own worktree) for a project and edit it" },
    force: { type: "boolean", description: "Allow editing a pending or running agent's worktree" },
    "print-path": { type: "boolean", description: "Print just the worktree path without opening an editor" },
  },
  async run({ args }) {
    const id = String(args.session);
    requireSession(id);
    let target: ReturnType<typeof resolveEditTarget>;
    if (args.new) {
      const config = await loadConfig();
      const resolved = resolveManualProject(config.projects.map(p => p.name), listAgents(id), args.agent);
      if (!resolved.ok) {
        console.error(pc.red(resolved.message));
        if (resolved.candidates.length) console.error(`Projects: ${resolved.candidates.join(", ")}`);
        return process.exit(1);
      }
      let created;
      try {
        created = createManualWorkspace(config, id, resolved.project);
      } catch (err) {
        console.error(pc.red(`Could not create a manual workspace: ${(err as Error).message}`));
        return process.exit(1);
      }
      // Status goes to stderr so `--print-path` stdout stays just the path.
      console.error(pc.dim(`Created manual workspace ${created.id} for ${resolved.project} on ${created.branch}`));
      target = { ok: true, agent: created, path: created.worktree_path! };
    } else {
      target = resolveEditTarget(listAgents(id), args.agent, existsSync, { force: args.force });
    }
    if (!target.ok) {
      console.error(pc.red(target.message));
      for (const a of target.candidates ?? [])
        console.error(`${a.id}  ${a.kind === "manual" ? "manual  " : ""}${a.project_name}  ${a.status}  ${a.branch ?? "(no branch)"}  ${a.worktree_path}`);
      return process.exit(1);
    }
    if (args["print-path"]) { console.log(target.path); return; }
    try {
      openWorktreeInEditor(target.path);
    } catch (err) {
      console.error(pc.red(`Could not open an editor: ${(err as Error).message}`));
      console.error(pc.dim("Set $VISUAL or $EDITOR."));
      return process.exit(1);
    }
    try {
      worktreeEditSummary(target.agent, listSessionPrs(id), target.path)
        .forEach((line, i) => console.log(i < 2 ? line : pc.dim(line)));
    } catch (err) {
      console.error(pc.red(`Could not summarize the worktree: ${(err as Error).message}`));
      process.exit(1);
    }
  },
});

const sessionReview = defineCommand({
  meta: { name: "review", description: "Start a persona review" },
  args: { session: { type: "positional" }, persona: { type: "positional", required: false }, prompt: { type: "string" }, model: { type: "string" } },
  async run({ args }) {
    const id = String(args.session); requireSession(id);
    const config = await loadConfig();
    if (!args.persona) {
      console.error(config.personas.length ? config.personas.map(p => `${p.name}: ${p.description}`).join("\n") : "No personas configured.");
      console.error("Specify a persona: tack session review <session> <persona>");
      process.exitCode = 1; return;
    }
    console.log(JSON.stringify(startRemoteReview(config, id, { persona: String(args.persona), prompt: args.prompt, model: args.model })));
  },
});
const sessionPrFix = defineCommand({
  meta: { name: "pr-fix", description: "Show or set session PR auto-fix" },
  args: { session: { type: "positional" }, state: { type: "positional", required: false } },
  async run({ args }) {
    const id = String(args.session); requireSession(id);
    if (args.state && args.state !== "on" && args.state !== "off") throw new Error("Expected on or off");
    if (args.state) await setPrFix(id, args.state === "on", await loadConfig());
    console.log(`PR auto-fix is ${getSession(id)!.pr_fix_enabled ? "on" : "off"} for ${id}.`);
  },
});

const sessionPollPrs = defineCommand({
  meta: { name: "poll-prs", description: "Ask a session's PR watcher to poll now" },
  args: { session: { type: "positional", description: "Session id" } },
  async run({ args }) {
    const id = String(args.session);
    requireSession(id);
    const result = await triggerPrWatch(id, await loadConfig());
    switch (result.kind) {
      case "disabled": console.log(pc.yellow("PR watch is disabled")); break;
      case "inactive": console.log(pc.yellow(`${id} is not active`)); break;
      case "no-open-prs": console.log(pc.dim(`${id} has no open PRs (statuses refreshed)`)); break;
      case "signalled":
      case "started":
        console.log(pc.green(`polling PRs for ${id} · ${result.kind} watcher pid ${result.pid}`));
        break;
    }
  },
});

// `default: "list"` makes bare `tack session` run the list subcommand.
// `alias: "sessions"` keeps the plural spelling working for `create`/`list`/
// `stop`/etc. (Bare `tack` routes to `create` instead — see `main` below.)
const session = defineCommand({
  meta: {
    name: "session",
    alias: "sessions",
    description: "Create sessions and manage them (resume, refresh, reconnect, show, edit, context, retitle, poll-prs, review, pr-fix, list, approve, archive, unarchive, stop, delete)",
  },
  subCommands: { follow: sessionFollow, create: sessionCreate, resume: sessionResume, refresh: sessionRefresh, reconnect: sessionReconnect, show: sessionShow, edit: sessionEdit, context: sessionContext, retitle: sessionRetitle, "poll-prs": sessionPollPrs, review: sessionReview, "pr-fix": sessionPrFix, list: sessionsList, approve: sessionApprove, archive, unarchive, stop, delete: del },
  default: "list",
});

const configPathCmd = defineCommand({
  meta: { name: "path", description: "Print the config file path" },
  run() {
    console.log(CONFIG_PATH);
  },
});

const configEdit = defineCommand({
  meta: { name: "edit", description: "Open the config in $EDITOR, then validate it" },
  async run() {
    ensureConfigExists();
    try {
      openInEditor(CONFIG_PATH);
    } catch (err) {
      console.error(pc.red(`Could not open an editor: ${(err as Error).message}`));
      console.error(pc.dim("Set $VISUAL or $EDITOR."));
      return process.exit(1);
    }
    // Validate right after editing so a typo surfaces now, not mid-run on the next
    // session — the same loud-at-load contract `loadConfig` already enforces.
    try {
      await loadConfig();
      console.log(pc.green("Config OK"));
    } catch (err) {
      console.error(pc.red(`Config has errors: ${(err as Error).message}`));
      console.error(pc.dim(`Fix them with \`tack config edit\`.`));
      process.exit(1);
    }
  },
});

// `default: "path"` makes bare `tack config` print the path (see the note on `projects`).
const config = defineCommand({
  meta: { name: "config", description: "Show or edit the Tack config file (path, edit)" },
  subCommands: { path: configPathCmd, edit: configEdit },
  default: "path",
});

const dashboard = defineCommand({
  meta: { name: "dashboard", description: "Live dashboard of all sessions, agents, and PRs" },
  async run() {
    await runDashboard();
  },
});

// citty has no native aliases; this hidden wrapper lets `tack dash` reuse the dashboard.
const dash = defineCommand({
  meta: { name: "dash", hidden: true, description: "Live dashboard of all sessions, agents, and PRs" },
  run: dashboard.run,
});

// Bare `tack` aliases `tack session create`. It can't just default to the
// `session` group — that defaults to `list`, and a group can't tell bare `tack`
// apart from an explicit `tack session`. So we point `main.default` at this
// hidden wrapper, which reuses `sessionCreate`'s args and run. `hidden` keeps a
// redundant top-level `create` out of the help listing.
const sessionCreateDefault = defineCommand({
  // The description mirrors `sessionCreate`'s; it's a literal rather than
  // `sessionCreate.meta.description` because citty types `.meta` as possibly-async,
  // so reaching into it here doesn't typecheck.
  meta: { name: "create", hidden: true, description: "Create a session: plan and coordinate agents for a problem" },
  args: sessionCreate.args,
  run: sessionCreate.run,
});

const main = defineCommand({
  meta: { name: "tack", description: "Runtime-neutral supervisor over Claude Code and Codex" },
  subCommands: {
    init,
    runtimes,
    projects,
    models,
    roles,
    config,
    session,
    create: sessionCreateDefault,
    agent,
    dashboard,
    dash,
  },
  // Bare `tack` (no subcommand) creates a session — `tack session create`.
  default: "create",
});

// Hidden subcommands (bypass citty). The MCP servers speak their protocol over
// stdout, so they must run with no banners or stray prints.
const hidden = process.argv[2];
if (hidden === "__mcp") {
  const [, , , sessionId, agentId] = process.argv;
  await runCoordinationServer(sessionId!, agentId!);
} else if (hidden === "__supervisor-mcp") {
  const [, , , sessionId] = process.argv;
  await runSupervisorServer(sessionId!);
} else if (hidden === "__run-agent") {
  const [, , , agentId] = process.argv;
  const config = await loadConfig();
  await runAgentToCompletion(agentId!, config, { resume: process.argv[4] === "--resume", preflight: decodePreflight(process.env.TACK_RUNNER_PREFLIGHT) });
} else if (hidden === "__run-supervisor") {
  const [, , , sessionId, mode] = process.argv;
  const config = await loadConfig();
  await runSupervisorToCompletion(sessionId!, mode === "resume" ? "resume" : "fresh", config);
} else if (hidden === "__watch-prs") {
  // The session's detached PR watcher (spawned by `spawnPrWatcher`): polls open PRs,
  // spawns fix agents, pushes + replies. Exits on its own when nothing is left to watch.
  const [, , , sessionId] = process.argv;
  const config = await loadConfig();
  await runPrWatcher(sessionId!, config);
  process.exit(0);
} else if (hidden === "__title-session") {
  // Detached auto-titler (spawnSessionTitler). Best-effort: stdio is title.runner.log,
  // so a failure is logged there and never surfaces to the session.
  const [, , , sessionId] = process.argv;
  try {
    const config = await loadConfig();
    await generateSessionTitle(config, sessionId!);
  } catch (err) {
    console.error(`title-session ${sessionId}: ${(err as Error).message}`);
  }
} else if (hidden === "__approve-prompt") {
  // Only the harness runs this on submitted prompts. Fail open so malformed input
  // or a missing session never interrupts ordinary chat or leaks junk to stdout.
  try {
    const sessionId = process.argv[3];
    const input = JSON.parse(await Bun.stdin.text());
    if (sessionId && typeof input?.prompt === "string") {
      setSupervisorTurnStartedAt(sessionId, new Date().toISOString());
      // The human replied, so an open question is answered. A pending plan keeps
      // its own lifecycle (elicitation / /approve), so only "question" clears here.
      clearSessionAwaitingInputFor(sessionId, "question");
    }
    if (sessionId && typeof input?.prompt === "string" && isApprovePrompt(input.prompt)) {
      approveSessionPlan(sessionId);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "The human approved the plan via /approve; plan_approved_at is set. Proceed to spawn agents.",
        },
      }));
    }
    const command = typeof input?.prompt === "string" ? parseSupervisorCommand(input.prompt) : null;
    if (sessionId && command) {
      let outcome: string;
      try {
        if (command.kind === "review") {
          if (!command.persona) throw new Error("Usage: /review <persona> [focus…]");
          const review = startRemoteReview(await loadConfig(), sessionId, { persona: command.persona, prompt: command.prompt });
          outcome = `Started review agent(s) ${review.reviews.map(r => r.agentId).join(", ")} for PR(s) ${review.reviews.map(r => `#${r.number}`).join(", ")}.`;
        } else {
          if (command.value && command.value !== "on" && command.value !== "off") throw new Error("Usage: /pr-fix [on|off]");
          if (!getSession(sessionId)) throw new Error(`Unknown session ${sessionId}`);
          if (command.value) await setPrFix(sessionId, command.value === "on", await loadConfig());
          outcome = `PR auto-fix is ${getSession(sessionId)!.pr_fix_enabled ? "on" : "off"}.`;
        }
      } catch (err) { outcome = `Command failed: ${(err as Error).message}`; }
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `${outcome} Already done by Tack; report it, don't redo it.` } }));
    }
    if (sessionId && typeof input?.prompt === "string") titleFromFirstPrompt(sessionId, input.prompt);
  } catch {
    // Approval and titling are best-effort; never block the human's prompt.
  }
  process.exit(0);
} else if (hidden === "__turn-end") {
  // Stop / idle_prompt hook. Always clears the turn flag; on Stop, a final message
  // that ends in a question also marks the session awaiting the human's answer.
  // Best-effort and silent: empty or malformed stdin just skips the question check.
  const sessionId = process.argv[3];
  try { if (sessionId) setSupervisorTurnStartedAt(sessionId, null); } catch { /* best-effort hook */ }
  try {
    const raw = await Bun.stdin.text();
    const input = raw.trim() ? JSON.parse(raw) : null;
    // idle_prompt (Notification) never touches the awaiting flag: it fires while
    // the human is still reading, and must not clear a question or plan.
    if (sessionId && input?.hook_event_name === "Stop") {
      const text = finalAssistantText(input);
      if (text && endsWithQuestion(text)) setSessionAwaitingInputIfFree(sessionId, "question");
    }
  } catch { /* best-effort hook */ }
  process.exit(0);
} else if (hidden === "__await-input") {
  // Silent PreToolUse / PostToolUse hook around the native question tool:
  // `__await-input <id> <reason>` marks the session awaiting (never overwriting a
  // different reason, e.g. a pending plan); `--clear` clears only that reason.
  // Prints nothing so it can't affect the tool's permission decision.
  try {
    const [, , , sessionId, reason, flag] = process.argv;
    if (sessionId && reason) {
      if (flag === "--clear") clearSessionAwaitingInputFor(sessionId, reason);
      else setSessionAwaitingInputIfFree(sessionId, reason);
    }
  } catch { /* best-effort hook; never block the question */ }
  process.exit(0);
} else if (hidden === "__guard-write") {
  let raw = "";
  try { raw = await Bun.stdin.text(); } catch { /* Empty input denies. */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...writeGuardDecision(raw, process.argv.slice(3)),
    },
  }));
} else if (hidden === "__await-plan") {
  // Mark the session awaiting the human's elicitation decision, without a prompt.
  const [, , , sessionId] = process.argv;
  setSessionAwaitingInput(sessionId!, "plan");
} else {
  await runMain(main);
}

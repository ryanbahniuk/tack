#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_PATH, collapseHome, expandHome } from "../src/paths";
import { STARTER_CONFIG } from "../src/config/starter";
import { loadConfig, modelForRole, resolveModel } from "../src/config/load";
import {
  addModelsToConfig,
  addProjectsToConfig,
  pinRuntimeInConfig,
  removeProjectFromConfig,
  updateProjectInConfig,
} from "../src/config/edit";
import { createSession, getSession, listSessions, sessionTotalCost } from "../src/db";
import { executeAgent } from "../src/agent/execute";
import { runAgentToCompletion, spawnSupervisorRunner } from "../src/agent/detached";
import {
  supervise,
  resumeSupervise,
  createSupervisorSession,
  writeSupervisorPrompt,
  runSupervisorToCompletion,
} from "../src/supervisor/supervise";
import { summarizeProject } from "../src/projects/summarize";
import {
  archiveSession,
  deleteSession,
  stopSession,
  unarchiveSession,
} from "../src/session/lifecycle";
import type { Model, Project } from "../src/config/schema";
import { runStable } from "../src/cli/stable";
import { startSpinner } from "../src/cli/spinner";
import { renderStreamEvent, type Pending } from "../src/cli/render";
import { captureViaEditor } from "../src/util/editor";
import { runCoordinationServer } from "../src/mcp/coordination-server";
import { runSupervisorServer } from "../src/mcp/supervisor-server";
import { ensureRuntimeInstalled, resolveRuntime, MODEL_CATALOG, type EnsureResult } from "../src/runtimes";
import type { RuntimeKind, TackConfig } from "../src/config/schema";

const usd = (n: number) => pc.green(`$${n.toFixed(4)}`);

const RUNTIME_KINDS: RuntimeKind[] = ["claude", "codex"];

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
    if (!existsSync(CONFIG_PATH)) {
      console.error(pc.red(`No config at ${CONFIG_PATH}. Run \`tack init\` first.`));
      return process.exit(1);
    }
    const kind = asRuntimeKind(String(args.runtime));
    const version = String(args.version);
    await pinRuntimeInConfig(CONFIG_PATH, kind, version);
    console.log(`Pinned ${pc.cyan(kind)} to ${pc.bold(version)} in ${pc.dim(CONFIG_PATH)}`);
    console.log(pc.dim(`Run \`tack runtimes install ${kind}\` to fetch it.`));
  },
});

const runtimeList = defineCommand({
  meta: { name: "list", description: "List all runtimes and their status" },
  async run() {
    const config = await loadConfig();
    for (const kind of RUNTIME_KINDS) {
      const pin = config.runtimes[kind]?.version;
      const pinLabel = pin ? pc.dim(`pin ${pin}`) : pc.dim("unpinned");
      try {
        const r = resolveRuntime(config, kind);
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.green("ready")}     ${pinLabel}  ${pc.bold(r.bin)} ${pc.dim(r.version)}`);
      } catch (err) {
        const status = pin ? pc.red("unavailable") : pc.yellow("not found");
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
        const ok = pin ? pc.green(`pinned ${pin} ✓`) : pc.dim("unpinned");
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.bold(r.bin)}  ${pc.dim(r.version)}  ${ok}`);
      } catch (err) {
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.red((err as Error).message)}`);
      }
    }
  },
});

const runtimes = defineCommand({
  meta: { name: "runtimes", description: "Manage runtime CLIs (list, doctor, install, pin)" },
  subCommands: { list: runtimeList, doctor, install: runtimeInstall, pin: runtimePin },
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
 * `tack go`/`tack agent` work in a fresh repo without a separate `projects add`.
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
    if (!existsSync(CONFIG_PATH)) {
      console.error(pc.red(`No config at ${CONFIG_PATH}. Run \`tack init\` first.`));
      return process.exit(1);
    }
    const config = await loadConfig();

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
    if (!existsSync(CONFIG_PATH)) {
      console.error(pc.red(`No config at ${CONFIG_PATH}. Run \`tack init\` first.`));
      return process.exit(1);
    }
    const config = await loadConfig();
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
    if (!existsSync(CONFIG_PATH)) {
      console.error(pc.red(`No config at ${CONFIG_PATH}. Run \`tack init\` first.`));
      return process.exit(1);
    }
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
  meta: { name: "projects", description: "List, add, refresh, and remove configured projects" },
  subCommands: { list: projectsList, add: projectsAdd, refresh: projectsRefresh, remove: projectsRemove },
  default: "list",
});

const modelsList = defineCommand({
  meta: { name: "list", description: "List configured models and role pins" },
  async run() {
    const config = await loadConfig();
    console.log(pc.bold("Models"));
    for (const m of config.models) {
      const price = m.pricing ? pc.dim(" (priced)") : m.runtime === "codex" ? pc.red(" (no pricing!)") : "";
      console.log(`  ${pc.cyan(m.key)}  ${pc.dim(`${m.runtime}:${m.id}`)}${m.effort ? pc.dim(` @${m.effort}`) : ""}${price}`);
    }
    console.log(pc.bold("Roles"));
    for (const [role, key] of Object.entries(config.roles)) {
      console.log(`  ${role.padEnd(11)} → ${pc.cyan(key)}`);
    }
  },
});

const modelsRefresh = defineCommand({
  meta: {
    name: "refresh",
    description: "Add catalog models offered by the connected runtime CLIs, skipping ones already configured",
  },
  async run() {
    if (!existsSync(CONFIG_PATH)) {
      console.error(pc.red(`No config at ${CONFIG_PATH}. Run \`tack init\` first.`));
      return process.exit(1);
    }
    const config = await loadConfig();

    // Gather catalog candidates from the runtimes that actually resolve to a
    // working binary (honoring any version pin) — an unavailable CLI contributes
    // no models. This is what "the models the connected CLIs allow" means.
    const candidates: Model[] = [];
    for (const kind of RUNTIME_KINDS) {
      try {
        const r = resolveRuntime(config, kind);
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.green("connected")} ${pc.dim(r.version)}`);
        candidates.push(...MODEL_CATALOG[kind]);
      } catch (err) {
        console.log(`${pc.cyan(kind.padEnd(7))} ${pc.yellow("not connected")} ${pc.dim((err as Error).message)}`);
      }
    }

    const added = await addModelsToConfig(CONFIG_PATH, candidates);
    if (added.length === 0) {
      console.log(pc.dim("\nNo new models to add — every catalog model is already configured."));
      return;
    }
    console.log(`\nAdded ${pc.bold(String(added.length))} model(s) to ${pc.dim(CONFIG_PATH)}:`);
    for (const m of added) console.log(`  ${pc.cyan(m.key)}  ${pc.dim(`${m.runtime}:${m.id}`)}`);
  },
});

// `default: "list"` makes bare `tack models` run the list subcommand without
// double-printing (see the note on `projects`).
const models = defineCommand({
  meta: { name: "models", description: "List configured models and role pins; refresh from connected runtimes" },
  subCommands: { list: modelsList, refresh: modelsRefresh },
  default: "list",
});

const requireSession = (id: string) => {
  if (!getSession(id)) {
    console.error(pc.red(`Unknown session "${id}".`));
    process.exit(1);
  }
};

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
    unarchiveSession(String(args.session));
    console.log(pc.dim(`unarchived ${args.session}`));
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
      console.log(`${pc.bold(s.id)}  ${pc.dim(s.status)}  ${usd(sessionTotalCost(s.id).total)}  ${s.title ? pc.dim(s.title) : ""}`);
    }
  },
});

// `default: "list"` makes bare `tack sessions` run the list subcommand without double-printing.
const sessions = defineCommand({
  meta: { name: "sessions", description: "List sessions and their cost; manage them (archive, unarchive, stop, delete)" },
  subCommands: { list: sessionsList, archive, unarchive, stop, delete: del },
  default: "list",
});

const agent = defineCommand({
  meta: { name: "agent", description: "Spawn a single agent on a project (direct, no supervisor)" },
  args: {
    project: { type: "positional", description: "Project name from config" },
    prompt: { type: "positional", description: "Task for the agent" },
    model: { type: "string", description: "Model name (defaults to roles.agent)" },
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

const go = defineCommand({
  meta: { name: "go", description: "Plan and coordinate agents for a problem" },
  args: {
    message: { type: "string", alias: "m", description: "The problem to solve, given inline instead of via the editor" },
    resume: { type: "string", alias: "r", description: "Follow up on an existing session id instead of starting a new one" },
    background: { type: "boolean", alias: "b", description: "Run the supervisor detached and return the terminal; watch it with `tack stable`" },
  },
  async run({ args }) {
    const resumeId = args.resume !== undefined ? String(args.resume) : undefined;
    const background = Boolean(args.background);
    // The problem comes from your editor by default; `-m/--message` supplies it
    // inline for scripting or quick one-liners.
    let problem: string;
    if (args.message !== undefined) {
      problem = String(args.message).trim();
      if (!problem) {
        console.error(pc.red("Empty problem. Pass a non-empty --message."));
        return process.exit(1);
      }
    } else {
      try {
        problem = captureViaEditor(resumeId ? GO_FOLLOWUP_TEMPLATE : GO_EDITOR_TEMPLATE);
      } catch (err) {
        console.error(pc.red(`Could not open an editor: ${(err as Error).message}`));
        console.error(pc.dim("Set $EDITOR, or pass the problem inline with `tack go -m \"…\"`."));
        return process.exit(1);
      }
      if (!problem) {
        console.error(pc.red(`Aborting: no ${resumeId ? "follow-up" : "problem"} entered.`));
        return process.exit(1);
      }
    }

    const config = await ensureCwdProject(await loadConfig());

    // Two postures: foreground streams the supervisor's planning to this terminal
    // under a spinner; `--background` detaches it and hands the terminal back,
    // with work watched via `tack stable`. Either way we print a header up front
    // naming the runtime+model that's planning.
    let run: ReturnType<typeof supervise>;
    if (resumeId) {
      const existing = getSession(resumeId);
      if (!existing) {
        console.error(pc.red(`Unknown session "${resumeId}". List them with \`tack sessions\`.`));
        return process.exit(1);
      }
      if (!existing.resume_ref) {
        console.error(pc.red(`Session "${resumeId}" has no resume handle yet — it never got far enough to follow up on.`));
        return process.exit(1);
      }
      console.log(`${pc.dim("supervisor")} ${pc.bold(existing.id)} ${pc.dim(`· ${existing.supervisor_model ?? "?"} (${existing.runtime ?? "?"})`)} ${pc.dim("· resuming")}`);
      if (background) {
        writeSupervisorPrompt(existing.id, problem);
        const pid = spawnSupervisorRunner(existing.id, "resume");
        return printBackgroundHandoff(existing.id, pid);
      }
      run = resumeSupervise(resumeId, problem, config);
    } else {
      const model = modelForRole(config, "supervisor");
      console.log(`${pc.dim("supervisor")} ${pc.dim(`· ${model.key} (${model.runtime}:${model.id})`)}`);
      if (background) {
        const session = createSupervisorSession(problem, config);
        writeSupervisorPrompt(session.id, problem);
        const pid = spawnSupervisorRunner(session.id, "fresh");
        return printBackgroundHandoff(session.id, pid);
      }
      run = supervise(problem, config);
    }

    const pending: Pending = { spinner: startSpinner("Thinking") };
    let step = await run.next();
    while (!step.done) {
      renderStreamEvent(step.value, pending);
      step = await run.next();
    }
    pending.spinner?.stop();

    const session = step.value;
    console.log(`\n${pc.green("supervisor done")}  ${pc.bold(session.id)}  ${usd(sessionTotalCost(session.id).total)}`);
    console.log(pc.dim(`Watch work and find PRs with \`tack stable\`.`));
    console.log(pc.dim(`Follow up with \`tack go --resume ${session.id}\`.`));
  },
});

/** Prints where a detached supervisor went and how to watch/follow it. */
function printBackgroundHandoff(sessionId: string, pid: number): void {
  console.log(`${pc.green("supervisor running in background")}  ${pc.bold(sessionId)}  ${pc.dim(`pid ${pid}`)}`);
  console.log(pc.dim(`Watch work and find PRs with \`tack stable\`.`));
  console.log(pc.dim(`Follow up with \`tack go --resume ${sessionId}\`, or stop it with \`tack sessions stop ${sessionId}\`.`));
}

const stable = defineCommand({
  meta: { name: "stable", description: "Live dashboard of all sessions, agents, and PRs" },
  async run() {
    await runStable();
  },
});

const main = defineCommand({
  meta: { name: "tack", description: "Runtime-neutral supervisor over Claude Code and Codex" },
  subCommands: {
    init,
    runtimes,
    projects,
    models,
    sessions,
    agent,
    go,
    stable,
  },
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
  await runAgentToCompletion(agentId!, config);
} else if (hidden === "__run-supervisor") {
  const [, , , sessionId, mode] = process.argv;
  const config = await loadConfig();
  await runSupervisorToCompletion(sessionId!, mode === "resume" ? "resume" : "fresh", config);
} else {
  await runMain(main);
}

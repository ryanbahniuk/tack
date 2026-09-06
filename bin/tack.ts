#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_PATH, collapseHome, expandHome } from "../src/paths";
import { STARTER_CONFIG } from "../src/config/starter";
import { loadConfig, modelForRole, resolveModel } from "../src/config/load";
import { addProjectsToConfig, pinRuntimeInConfig } from "../src/config/edit";
import { createSession, getSession, listSessions, sessionTotalCost } from "../src/db";
import { executeAgent } from "../src/agent/execute";
import { runAgentToCompletion } from "../src/agent/detached";
import { supervise } from "../src/supervisor/supervise";
import { summarizeProject } from "../src/projects/summarize";
import {
  archiveSession,
  deleteSession,
  stopSession,
  unarchiveSession,
} from "../src/session/lifecycle";
import type { Project } from "../src/config/schema";
import { runStable } from "../src/cli/stable";
import { runCoordinationServer } from "../src/mcp/coordination-server";
import { runSupervisorServer } from "../src/mcp/supervisor-server";
import { ensureRuntimeInstalled, resolveRuntime, type EnsureResult } from "../src/runtimes";
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

    // Skip anything already configured (by name or path) before spending on summaries.
    const knownNames = new Set(config.projects.map((p) => p.name));
    const knownPaths = new Set(config.projects.map((p) => p.path));
    const entries: Project[] = [];
    for (const path of candidates) {
      const name = basename(path);
      if (knownNames.has(name) || knownPaths.has(path)) {
        console.log(pc.dim(`skipped ${name}: already configured`));
        continue;
      }
      if (!existsSync(path)) {
        console.log(pc.dim(`skipped ${name}: ${path} does not exist`));
        continue;
      }
      process.stdout.write(pc.dim(`describing ${name}… `));
      try {
        const description = await summarizeProject(config, path);
        console.log(pc.green("done"));
        console.log(`  ${description}`);
        entries.push({ name, path: collapseHome(path), description });
        knownNames.add(name);
      } catch (err) {
        console.log(pc.red("failed"));
        console.log(pc.dim(`  ${(err as Error).message}`));
      }
    }

    if (entries.length === 0) return console.log(pc.dim("No projects added."));
    const added = await addProjectsToConfig(CONFIG_PATH, entries);
    console.log(`\nAdded ${pc.bold(String(added.length))} project(s) to ${pc.dim(CONFIG_PATH)}:`);
    for (const p of added) console.log(`  ${pc.bold(p.name)}  ${pc.dim(p.path)}`);
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
    }
  },
});

// `default: "list"` makes bare `tack projects` run the list subcommand. citty
// runs a parent's own `run` even after dispatching to a subcommand, so listing
// here via `run` would double-print on `tack projects list`; a default avoids that.
const projects = defineCommand({
  meta: { name: "projects", description: "List and add configured projects" },
  subCommands: { list: projectsList, add: projectsAdd },
  default: "list",
});

const models = defineCommand({
  meta: { name: "models", description: "List configured models and role pins" },
  async run() {
    const config = await loadConfig();
    console.log(pc.bold("Models"));
    for (const m of config.models) {
      const price = m.pricing ? pc.dim(" (priced)") : m.runtime === "codex" ? pc.red(" (no pricing!)") : "";
      console.log(`  ${pc.cyan(m.name)}  ${pc.dim(`${m.runtime}:${m.id}`)}${m.effort ? pc.dim(` @${m.effort}`) : ""}${price}`);
    }
    console.log(pc.bold("Roles"));
    for (const [role, name] of Object.entries(config.roles)) {
      console.log(`  ${role.padEnd(11)} → ${pc.cyan(name)}`);
    }
  },
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

const sessions = defineCommand({
  meta: { name: "sessions", description: "List sessions and their cost; manage them (archive, unarchive, stop, delete)" },
  args: { all: { type: "boolean", description: "Include archived sessions" } },
  subCommands: { archive, unarchive, stop, delete: del },
  async run({ args }) {
    const rows = listSessions(Boolean(args.all));
    if (rows.length === 0) return console.log(pc.dim("No sessions yet."));
    for (const s of rows) {
      console.log(`${pc.bold(s.id)}  ${pc.dim(s.status)}  ${usd(sessionTotalCost(s.id).total)}  ${s.title ? pc.dim(s.title) : ""}`);
    }
  },
});

const agent = defineCommand({
  meta: { name: "agent", description: "Spawn a single agent on a project (direct, no supervisor)" },
  args: {
    project: { type: "positional", description: "Project name from config" },
    prompt: { type: "positional", description: "Task for the agent" },
    model: { type: "string", description: "Model name (defaults to roles.agent)" },
  },
  async run({ args }) {
    const config = await loadConfig();
    const project = config.projects.find((p) => p.name === args.project);
    if (!project) {
      console.error(pc.red(`Unknown project "${args.project}". Run \`tack projects\`.`));
      process.exit(1);
    }
    const model = args.model ? resolveModel(config, args.model) : modelForRole(config, "agent");
    const session = createSession({ title: String(args.prompt).slice(0, 80) });
    console.log(`${pc.dim("session")} ${pc.bold(session.id)}  ${pc.dim(`${model.runtime}:${model.id}`)}`);

    const run = executeAgent({ session, project, model, prompt: String(args.prompt), config });
    let step = await run.next();
    while (!step.done) {
      const ev = step.value;
      if (ev.type === "text") process.stdout.write(ev.text);
      else if (ev.type === "tool_call") console.log(pc.dim(`\n· ${ev.tool}`));
      else if (ev.type === "cost") console.log(pc.dim(`\n[cost ${ev.usd.toFixed(4)} ${ev.source}]`));
      else if (ev.type === "error") console.error(pc.red(`\n! ${ev.message}`));
      step = await run.next();
    }
    const { ok, agent: row } = step.value;
    console.log(`\n${ok ? pc.green("done") : pc.red("failed")}  ${pc.cyan(row.id)}  ${usd(row.cost)}`);
  },
});

const go = defineCommand({
  meta: { name: "go", description: "Plan and coordinate agents for a problem" },
  args: { problem: { type: "positional", description: "The problem to solve" } },
  async run({ args }) {
    const config = await loadConfig();
    const run = supervise(String(args.problem), config);
    let step = await run.next();
    while (!step.done) {
      const ev = step.value;
      if (ev.type === "text") process.stdout.write(ev.text);
      else if (ev.type === "tool_call") console.log(pc.dim(`\n· ${ev.tool}`));
      else if (ev.type === "cost") console.log(pc.dim(`\n[cost ${ev.usd.toFixed(4)} ${ev.source}]`));
      else if (ev.type === "error") console.error(pc.red(`\n! ${ev.message}`));
      step = await run.next();
    }
    const session = step.value;
    console.log(`\n${pc.green("supervisor done")}  ${pc.bold(session.id)}  ${usd(sessionTotalCost(session.id).total)}`);
    console.log(pc.dim(`Watch work and find PRs with \`tack stable\`.`));
  },
});

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
} else {
  await runMain(main);
}

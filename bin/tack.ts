#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_PATH } from "../src/paths";
import { STARTER_CONFIG } from "../src/config/starter";
import { loadConfig, modelForRole, resolveModel } from "../src/config/load";
import {
  createSession,
  getSession,
  listAgents,
  listSessionPrs,
  listSessions,
  sessionTotalCost,
} from "../src/db";
import { executeAgent } from "../src/agent/execute";
import { runAgentToCompletion } from "../src/agent/detached";
import { supervise } from "../src/supervisor/supervise";
import { discoverSessionPrs } from "../src/projects/prs";
import {
  archiveSession,
  deleteSession,
  stopSession,
  unarchiveSession,
} from "../src/session/lifecycle";
import { runStable } from "../src/cli/stable";
import { runCoordinationServer } from "../src/mcp/coordination-server";
import { runSupervisorServer } from "../src/mcp/supervisor-server";
import { ensureRuntimeInstalled, resolveRuntime, type EnsureResult } from "../src/runtimes";
import type { RuntimeKind, TackConfig } from "../src/config/schema";

const usd = (n: number) => pc.green(`$${n.toFixed(4)}`);

const RUNTIME_KINDS: RuntimeKind[] = ["claude", "codex"];

/** Ensures both runtimes are available, installing pinned versions transparently.
 * Prints a status line per runtime; returns false if any ended in failure. */
function ensureRuntimes(config: TackConfig): boolean {
  let ok = true;
  for (const kind of RUNTIME_KINDS) {
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

const install = defineCommand({
  meta: { name: "install", description: "Ensure the pinned runtime versions are installed" },
  async run() {
    const config = await loadConfig();
    const ok = ensureRuntimes(config);
    if (!ok) process.exit(1);
  },
});

const projects = defineCommand({
  meta: { name: "projects", description: "List configured projects" },
  async run() {
    const config = await loadConfig();
    if (config.projects.length === 0) return console.log(pc.dim("No projects configured."));
    for (const p of config.projects) {
      console.log(`${pc.bold(p.name)}  ${pc.dim(p.path)}`);
      console.log(`  ${p.description}`);
    }
  },
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

const doctor = defineCommand({
  meta: { name: "doctor", description: "Resolve runtime binaries and verify version pins" },
  async run() {
    const config = await loadConfig();
    for (const kind of ["claude", "codex"] as RuntimeKind[]) {
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

const sessions = defineCommand({
  meta: { name: "sessions", description: "List sessions and their cost" },
  args: { all: { type: "boolean", description: "Include archived sessions" } },
  async run({ args }) {
    const rows = listSessions(Boolean(args.all));
    if (rows.length === 0) return console.log(pc.dim("No sessions yet."));
    for (const s of rows) {
      console.log(`${pc.bold(s.id)}  ${pc.dim(s.status)}  ${usd(sessionTotalCost(s.id).total)}  ${s.title ? pc.dim(s.title) : ""}`);
    }
  },
});

const ls = defineCommand({
  meta: { name: "ls", description: "Show sessions → agents → PRs" },
  args: { all: { type: "boolean", description: "Include archived sessions" } },
  async run({ args }) {
    const rows = listSessions(Boolean(args.all));
    if (rows.length === 0) return console.log(pc.dim("No sessions yet."));
    for (const s of rows) {
      console.log(`${pc.bold(s.id)}  ${pc.dim(s.status)}  ${usd(sessionTotalCost(s.id).total)}  ${s.title ?? ""}`);
      for (const a of listAgents(s.id))
        console.log(`  ├─ ${pc.cyan(a.id)} ${a.project_name} ${pc.dim(`${a.runtime}:${a.model}`)} ${statusColor(a.status)} ${usd(a.cost)}`);
      for (const pr of listSessionPrs(s.id))
        console.log(`  └─ PR ${pr.number ?? "?"} ${pc.dim(pr.state ?? "")} ${pc.underline(pr.url)}`);
    }
  },
});

function statusColor(status: string): string {
  if (status === "done") return pc.green(status);
  if (status === "failed") return pc.red(status);
  if (status === "running") return pc.yellow(status);
  return pc.dim(status);
}

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

const superviseCmd = defineCommand({
  meta: { name: "supervise", description: "Plan and coordinate agents for a problem" },
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
    console.log(pc.dim(`Watch work with \`tack stable\`; see PRs with \`tack prs ${session.id}\`.`));
  },
});

const stable = defineCommand({
  meta: { name: "stable", description: "Live dashboard of all sessions, agents, and PRs" },
  async run() {
    await runStable();
  },
});

const prs = defineCommand({
  meta: { name: "prs", description: "Discover and list a session's PRs" },
  args: { session: { type: "positional", description: "Session id" } },
  async run({ args }) {
    const config = await loadConfig();
    const res = discoverSessionPrs(config, String(args.session));
    if (res.ghMissing) console.log(pc.yellow("gh CLI not found — install it to discover PRs."));
    for (const pr of res.prs) console.log(`PR ${pr.number ?? "?"} ${pc.dim(pr.state ?? "")} ${pc.underline(pr.url)}`);
    for (const s of res.skipped) console.log(pc.dim(`skipped ${s.project}: ${s.reason}`));
    if (res.prs.length === 0 && !res.ghMissing) console.log(pc.dim("No PRs found for this session."));
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

const main = defineCommand({
  meta: { name: "tack", description: "Runtime-neutral supervisor over Claude Code and Codex" },
  subCommands: {
    init,
    install,
    projects,
    models,
    doctor,
    sessions,
    ls,
    agent,
    supervise: superviseCmd,
    stable,
    prs,
    archive,
    unarchive,
    stop,
    delete: del,
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

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { listAgents, type AgentRow } from "../db";
import type { Project, TackConfig } from "../config/schema";
import { runDir } from "../paths";
import { tmuxAvailable, tmuxHasSession, tmuxRunName, tmuxRunWindow, tmuxKillRun, tmuxAttachArgs, tmuxClientEnv } from "./tmux";
import { envRewrites, resolveRun, template, type RunSpec } from "./run-detect";

export interface RunApp { name: string; tree: string; agentId: string | null; branch: string | null; main: boolean; spec: RunSpec; port: number; url: string; pid?: number; tmuxWindow?: string; status: string; log: string; started_at: string; }
export interface RunState { sessionId: string; mode: "tmux" | "process"; apps: RunApp[]; status: string; }
const statePath = (id: string) => join(runDir(id), "run.json");
export function readRun(id: string): RunState | undefined { try { return JSON.parse(readFileSync(statePath(id), "utf8")); } catch { return undefined; } }
function save(state: RunState): void { mkdirSync(runDir(state.sessionId), { recursive: true }); writeFileSync(statePath(state.sessionId), JSON.stringify(state, null, 2)); }
function alive(pid?: number): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
export function runLive(state?: RunState, tmuxSessions?: ReadonlySet<string>): boolean { return !!state && state.status === "running" && (state.mode === "tmux" ? tmuxSessions ? tmuxSessions.has(tmuxRunName(state.sessionId)) : tmuxHasSession(tmuxRunName(state.sessionId)) : state.apps.some(a => alive(a.pid))); }
export function stopRun(id: string): void { try { const state = readRun(id); if (!state) return; if (state.mode === "tmux") tmuxKillRun(id); if (state.mode === "process") for (const app of state.apps) if (app.pid) try { process.kill(-app.pid, "SIGTERM"); } catch {} state.status = "stopped"; for (const a of state.apps) a.status = "stopped"; save(state); } catch {} }
export function selectTree(project: Project, agents: AgentRow[], overrides: string[]): { tree: string; agentId: string | null; branch: string | null; main: boolean } {
  const eligible = agents.filter(a => a.project_name === project.name && a.kind !== "review" && a.worktree_path && existsSync(a.worktree_path));
  const requested = overrides.map(id => agents.find(a => a.id === id)).filter((a): a is AgentRow => !!a && a.project_name === project.name);
  if (requested.length > 1) throw new Error(`Multiple agents selected for ${project.name}`);
  if (requested.length && !eligible.includes(requested[0]!)) throw new Error(`Agent ${requested[0]!.id} has no eligible worktree`);
  const a = requested[0] ?? eligible.sort((x,y) => y.created_at.localeCompare(x.created_at))[0];
  return a ? { tree: a.worktree_path!, agentId: a.id, branch: a.branch, main: false } : { tree: project.path, agentId: null, branch: null, main: true };
}
export function planRun(id: string, config: TackConfig, projects: string[] = [], agents: string[] = [], rows: AgentRow[] = listAgents(id)): RunApp[] {
  for (const agent of agents) if (!rows.some(a => a.id === agent)) throw new Error(`Unknown agent ${agent}`);
  const names = projects.length ? projects : [...new Set(rows.filter(a => a.kind !== "review" && a.worktree_path && existsSync(a.worktree_path)).map(a => a.project_name))];
  const apps: RunApp[] = []; const visited = new Set<string>();
  const visit = (name: string, required = false) => {
    if (visited.has(name)) return; visited.add(name);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === "." || name === "..") throw new Error(`Invalid project name for run: ${name}`);
    const p = config.projects.find(p => p.name === name); if (!p) throw new Error(`Unknown project ${name}`);
    const selected = selectTree(p, rows, agents); const spec = resolveRun(selected.tree, p.run, p.path);
    if (!spec) { if (required) throw new Error(`${name} is not bootable`); console.warn(`${name}: no Node dev/start script, Rails or Procfile web found; add a run block (docker-compose is not detected).`); return; }
    apps.push({ name, ...selected, spec, port: spec.port, url: "", status: "planned", log: join(runDir(id), `${name}.log`), started_at: "" });
    for (const dependency of spec.requires) visit(dependency, true);
  };
  names.forEach(n => visit(n, projects.length > 0)); return apps;
}
/** A main checkout belongs to the human; never copy into it or overwrite a file. */
export function copyRunFiles(app: RunApp, mainPath: string): void {
  if (app.main) return;
  for (const file of app.spec.copyFiles) {
    const source = resolve(mainPath, file);
    const dest = resolve(app.tree, file);
    if (!dest.startsWith(resolve(app.tree) + "/") || !source.startsWith(resolve(mainPath) + "/")) throw new Error(`Invalid copy path ${file}`);
    if (!existsSync(dest) && existsSync(source)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
    }
  }
}
export function setupHash(tree: string, inputs: string[]): string { const hash = createHash("sha256"); for (const p of inputs) { hash.update(p); try { hash.update(readFileSync(join(tree, p))); } catch { hash.update("<missing>"); } } return hash.digest("hex"); }
export function needsSetup(app: RunApp, previous: string | undefined, force = false): boolean { return !app.main && (force || previous !== setupHash(app.tree, app.spec.setupInputs) || !!app.spec.setupCheck && !existsSync(join(app.tree, app.spec.setupCheck))); }
export async function allocatePorts(preferred: number[], free: (port: number) => Promise<boolean> = portFree): Promise<number[]> { const used = new Set<number>(); const result: number[] = []; for (const p of preferred) { let n = p; while (n <= 65535 && (used.has(n) || !await free(n))) n++; if (n > 65535) throw new Error(`No free port at or above ${p}`); used.add(n); result.push(n); } return result; }
/** Probe both loopback families: an IPv6-only listener can own a port even when
 * IPv4 is free. Systems without IPv6 treat EADDRNOTAVAIL as an absent family. */
export async function portFree(port: number, probe: (port: number, host: string) => Promise<boolean> = bindProbe): Promise<boolean> {
  return await probe(port, "127.0.0.1") && await probe(port, "::1");
}
function bindProbe(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (host === "::1" && ["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"].includes(error.code ?? "")) resolve(true);
      else if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen({ port, host, ipv6Only: host === "::1" }, () => server.close(() => resolve(true)));
  });
}

/** Citty retains one value for a repeated option; preserve the original ordering. */
export function repeatedRunFlag(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === `--${flag}` && argv[i + 1] && !argv[i + 1]!.startsWith("--")) values.push(argv[++i]!);
    else if (arg.startsWith(`--${flag}=`)) values.push(arg.slice(flag.length + 3));
  }
  return values;
}
export function formatRunStatus(state: RunState | undefined, live: boolean): string {
  return state ? `${live ? "running" : "stopped"}\n${state.apps.map(a => `${a.name} · ${a.url} · ${a.status}`).join("\n")}` : "No run found.";
}
function tsLiteral(value: unknown, depth = 0): string {
  if (Array.isArray(value)) return `[${value.map(v => tsLiteral(v, depth + 1)).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    const indent = "  ".repeat(depth + 1);
    return `{\n${entries.map(([key, val]) => `${indent}${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${tsLiteral(val, depth + 1)},`).join("\n")}\n${"  ".repeat(depth)}}`;
  }
  return JSON.stringify(value);
}
export function formatRunConfig(app: RunApp): string {
  const { source, detectedBy, setupCheck, warnings, ...spec } = app.spec;
  return `// ${app.name} (${detectedBy ? `detected by ${detectedBy}` : source})\nrun: ${tsLiteral(spec)},`;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export async function bootRun(id: string, config: TackConfig, options: { projects?: string[]; agents?: string[]; setup?: boolean; restart?: boolean; print?: (line: string) => void } = {}): Promise<RunState> {
  const print = options.print ?? console.log; const existing = readRun(id);
  if (runLive(existing) && !options.restart) { existing!.apps.forEach(a => print(`${a.name} · ${a.url} · ${a.status}`)); return existing!; }
  if (existing && options.restart) stopRun(id);
  const apps = planRun(id, config, options.projects, options.agents); if (!apps.length) throw new Error("No bootable projects selected");
  const ports = await allocatePorts(apps.map(a => a.spec.port)); apps.forEach((a,i) => { a.port = ports[i]!; a.url = `http://localhost:${a.port}`; });
  const refs = Object.fromEntries(apps.map(a => [a.name, { port: a.port }]));
  // Validate every reference before starting any process.
  for (const app of apps) { const own = { port: app.port, tree: app.tree }; template(app.spec.command, own, refs); for (const value of Object.values(app.spec.env)) template(value, own, refs); }
  const state: RunState = { sessionId: id, mode: tmuxAvailable() ? "tmux" : "process", apps, status: "running" }; mkdirSync(runDir(id), { recursive: true });
  for (const a of apps) {
    const own = { port: a.port, tree: a.tree }; const command = template(a.spec.command, own, refs);
    print(`${a.name} · ${a.main ? "main checkout" : a.tree} · ${a.branch ?? "—"} · ${a.spec.source} · ${command} · ${a.port}`);
    a.spec.warnings.forEach(print);
    copyRunFiles(a, config.projects.find(p => p.name === a.name)!.path);
    const env = { ...envRewrites(a.tree, a.name, apps.map(x => ({ name: x.name, preferred: x.spec.port, port: x.port })), a.spec.env, print), ...a.spec.env, [a.spec.portEnv]: String(a.port) };
    for (const [key, value] of Object.entries(env)) env[key] = template(value, own, refs);
    if (a.main && a.spec.setupCheck && !existsSync(join(a.tree, a.spec.setupCheck))) print(`${a.name}: ${a.spec.setupCheck} missing in main checkout; setup skipped.`);
    const hashFile = join(runDir(id), `${a.name}-setup.json`); let hashes: Record<string,string> = {}; try { hashes = JSON.parse(readFileSync(hashFile, "utf8")); } catch {}
    const hash = setupHash(a.tree, a.spec.setupInputs); const setup = needsSetup(a, hashes[a.tree], options.setup);
    const ready = join(runDir(id), `${a.name}.started`); const failed = join(runDir(id), `${a.name}.failed`); for (const f of [ready, failed]) try { unlinkSync(f); } catch {}
    const setupCmd = setup && a.spec.setup.length ? `${a.spec.setup.map(c => `(${c})`).join(" && ")} && ` : "";
    const markHash = setup ? `printf %s ${quote(JSON.stringify({ ...hashes, [a.tree]: hash }))} > ${quote(hashFile)} && ` : "";
    const shell = `(${setupCmd}${markHash}touch ${quote(ready)} && exec env ${Object.entries(env).map(([k,v]) => `${k}=${quote(v)}`).join(" ")} sh -c ${quote(command)}) 2>&1 | tee -a ${quote(a.log)}; touch ${quote(failed)}`;
    a.started_at = new Date().toISOString(); a.status = "starting";
    if (state.mode === "tmux") { if (tmuxRunWindow(id, a.name, a.tree, shell, apps.indexOf(a) === 0)) a.tmuxWindow = a.name; else if (apps.indexOf(a) === 0) { state.mode = "process"; print("tmux could not start; using detached processes."); } else { stopRun(id); throw new Error(`Could not create tmux window for ${a.name}`); } }
    if (state.mode === "process") { const child = spawn("sh", ["-c", shell], { cwd: a.tree, detached: true, stdio: "ignore" }); child.unref(); a.pid = child.pid; }
    save(state);
  }
  await Promise.all(apps.map(async a => { const started = join(runDir(id), `${a.name}.started`), failed = join(runDir(id), `${a.name}.failed`); let deadline = 0; while (true) { if (existsSync(failed) || state.mode === "process" && !alive(a.pid) || state.mode === "tmux" && !tmuxHasSession(tmuxRunName(id))) break; if (existsSync(started)) { deadline ||= Date.now() + a.spec.readyTimeoutSeconds * 1000; try { await fetch(a.url + a.spec.readyPath, { signal: AbortSignal.timeout(1000) }); a.status = "ready"; break; } catch {} if (Date.now() >= deadline) break; } await new Promise(r => setTimeout(r, 500)); } if (a.status !== "ready") { a.status = "failed"; let tail = ""; try { tail = readFileSync(a.log, "utf8").split("\n").slice(-20).join("\n"); } catch {} print(`${a.name} failed · ${a.log}\n${tail}`); } else print(`${a.name} · ${a.url} · ready`); save(state); }));
  return state;
}
export function attachRun(id: string): void { if (!tmuxHasSession(tmuxRunName(id))) throw new Error("No tmux run session available"); spawnSync("tmux", tmuxAttachArgs(tmuxRunName(id)), { stdio: "inherit", env: tmuxClientEnv() }); }

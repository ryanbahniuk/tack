import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelForRole, resolveModel } from '../config/load';
import type { TackConfig } from '../config/schema';
import { LOGS_DIR, opsDir } from '../paths';
import { selectRuntime, resolveRuntime } from '../runtimes';
import type { RunOptions } from '../runtimes/types';
import { selfCommand } from '../process/self';
import { uuid } from '../util/id';
import { OPS_APPROVAL_TOOLS, OPS_MCP_NAME } from '../mcp/ops-server';
import { tmuxAvailable, tmuxHasSession, tmuxKillSession, tmuxEnsureSession, tmuxSessionName, tmuxSetStatusHint, tmuxAttachArgs, tmuxClientEnv } from '../session/tmux';

type State = { model: string; resumeRef?: string };
export function opsDecision(alive: boolean, resumeRef: string | undefined, restart: boolean): 'attach' | 'resume' | 'fresh' {
  return alive && !restart ? 'attach' : resumeRef ? 'resume' : 'fresh';
}
export function opsLaunchPlan(alive: boolean, resumeRef: string | undefined, restart: boolean) {
  return { kill: restart, decision: opsDecision(alive, resumeRef, restart) };
}
export function opsContext(): string {
  return 'You are the global Tack operations agent. Answer questions about current and historical Tack work using your introspection tools. Run lifecycle actions when asked. Never approve plans, send keys or messages into a session TUI, write config, spawn agents, or open PRs. New sessions you create wait for human plan approval in the dashboard. Answer questions about how Tack works using tack_cli_help for commands and flags, search_tack_docs and read_tack_docs with README for user-facing behavior including dashboard keys, config reference and troubleshooting, and SPEC for design and rationale. Use read_config to understand how this install is configured; the human makes config changes with tack config edit. Name the documentation section you relied on. When the docs and help do not cover something, say so rather than guessing about internals.';
}
export async function launchOps(config: TackConfig, restart = false): Promise<{ code: number; detached: boolean }> {
  const cwd = opsDir(), statePath = join(cwd, 'state.json');
  mkdirSync(cwd, { recursive: true });
  let state: State | undefined;
  try { state = JSON.parse(readFileSync(statePath, 'utf8')) as State; } catch { /* no previous conversation */ }
  const available = tmuxAvailable(), name = tmuxSessionName('ops');
  const plan = opsLaunchPlan(available && tmuxHasSession(name), state?.resumeRef, restart);
  const decision = plan.decision;
  if (plan.kill && available) tmuxKillSession('ops');
  let useTmux = decision === 'attach';
  let spec: ReturnType<ReturnType<typeof selectRuntime>['interactiveCommand']> | undefined;
  if (!useTmux) {
    const model = state ? resolveModel(config, state.model) : modelForRole(config, 'supervisor');
    const resumeRef = decision === 'resume' ? state?.resumeRef : model.runtime === 'claude' ? uuid() : undefined;
    state = { model: model.key, ...(resumeRef ? { resumeRef } : {}) };
    writeFileSync(statePath, JSON.stringify(state));
    const contextFile = join(cwd, 'context.md');
    writeFileSync(contextFile, opsContext());
    const runtime = selectRuntime(model.runtime), mcp = selfCommand(['__ops-mcp']);
    const opts: RunOptions = { prompt: '', cwd, model, bin: resolveRuntime(config, model.runtime).bin, readOnly: true, disallowShell: true, trustedDirs: [cwd], resume: decision === 'resume', sessionRef: resumeRef, contextFile, mcpServers: [{ name: OPS_MCP_NAME, ...mcp, ...(model.runtime === 'codex' ? { env: { TACK_OPS_GATED_DISABLED: '1' } } : {}) }], approvalTools: OPS_APPROVAL_TOOLS, approvalPrompt: 'Run this Tack action?', logPath: join(LOGS_DIR, 'ops', 'ops.log') };
    spec = runtime.interactiveCommand(opts);
    runtime.prepareInteractive?.(opts);
    useTmux = available && tmuxEnsureSession('ops', cwd, spec, 'tack ops');
  }
  if (useTmux) tmuxSetStatusHint('ops', 'tack ops');
  const command = useTmux ? ['tmux', ...tmuxAttachArgs(name)] : [spec!.command, ...spec!.args];
  const env = useTmux ? tmuxClientEnv() : { ...process.env, ...spec!.env };
  delete env.TACK_ATTACHED_SESSION;
  const proc = Bun.spawn(command, { cwd, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  return { code, detached: useTmux && tmuxHasSession(name) };
}

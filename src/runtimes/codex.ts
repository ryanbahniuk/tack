import type { AgentEvent, RunOptions, Runtime } from "./types";
import { streamJson } from "./proc";
import { costFromPricing, type TokenUsage } from "./pricing";

/**
 * Drives Codex headless: `codex exec --json`. Autonomous, unattended posture for a
 * worktree: `-a never -s workspace-write` (no approvals, writes confined to the
 * workspace). Codex reports tokens but NO dollar figure, so we accumulate the
 * final `token_count` usage and compute cost from the model's pricing table.
 *
 * The exact `--json` event schema varies across Codex builds (this targets an
 * internal ~0.15x build), so parsing is defensive: we scan each line for a session
 * id, a token-usage object, and agent text wherever they appear, rather than
 * binding to one nesting. Revisit against the pinned Codex version.
 */
export class CodexRuntime implements Runtime {
  readonly kind = "codex" as const;

  async *run(opts: RunOptions): AsyncIterable<AgentEvent> {
    const cmd = this.buildCmd(opts);
    let sawSession = false;
    let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let ok = true;
    let sawError = false;

    try {
      for await (const raw of streamJson(cmd, {
        cwd: opts.cwd,
        logPath: opts.logPath,
        signal: opts.signal,
      })) {
        const ev = raw as any;

        const sid = findSessionId(ev);
        if (!sawSession && sid) {
          sawSession = true;
          yield { type: "session", ref: sid };
        }

        const u = findUsage(ev);
        if (u) usage = u; // cumulative total; keep latest

        const text = findAgentText(ev);
        if (text) yield { type: "text", text };

        const tool = findToolCall(ev);
        if (tool) yield { type: "tool_call", tool: tool.name, input: tool.input };

        if (isError(ev)) {
          sawError = true;
          yield { type: "error", message: errorMessage(ev) };
        }
      }
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
      sawError = true;
    }

    yield {
      type: "usage",
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    };
    const usd = costFromPricing(opts.model.pricing, usage);
    if (usd !== null) yield { type: "cost", usd, source: "pricing" };
    ok = !sawError;
    yield { type: "done", ok };
  }

  private buildCmd(opts: RunOptions): string[] {
    const m = opts.model;
    const sandbox = opts.readOnly ? "read-only" : "workspace-write";
    const cmd = [opts.bin, "exec", "--json", "--skip-git-repo-check", "-m", m.id, "-a", "never", "-s", sandbox];
    if (m.effort) cmd.push("-c", `model_reasoning_effort=${m.effort}`);
    for (const dir of opts.addDirs ?? []) cmd.push("--add-dir", dir);
    // Codex has no per-run system-prompt flag; the one file-based hook is the
    // experimental instructions override (kept separate from the repo's AGENTS.md).
    if (opts.contextFile) cmd.push("-c", `experimental_instructions_file=${quote(opts.contextFile)}`);
    for (const s of opts.mcpServers ?? []) {
      cmd.push("-c", `mcp_servers.${s.name}.command=${quote(s.command)}`);
      cmd.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
    }
    // `codex exec resume <id>` is the continuation form; flags follow the subcommand.
    if (opts.resume && opts.sessionRef) {
      return [opts.bin, "exec", "resume", opts.sessionRef, ...cmd.slice(2), opts.prompt];
    }
    cmd.push(opts.prompt);
    return cmd;
  }
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

// --- Defensive field extraction across Codex event shapes -------------------

function findSessionId(ev: any): string | null {
  return (
    ev?.session_id ??
    ev?.id ??
    ev?.session_meta?.session_id ??
    ev?.msg?.session_id ??
    ev?.thread_id ??
    (ev?.type === "session_meta" ? ev?.session_id ?? ev?.id : null) ??
    null
  );
}

function findUsage(ev: any): TokenUsage | null {
  const info = ev?.info?.total_token_usage ?? ev?.msg?.info?.total_token_usage ?? ev?.total_token_usage;
  if (!info) return null;
  return {
    input: info.input_tokens ?? 0,
    output: info.output_tokens ?? 0,
    cacheRead: info.cached_input_tokens ?? 0,
    cacheWrite: info.cache_write_input_tokens ?? 0,
  };
}

function findAgentText(ev: any): string | null {
  if (ev?.msg?.type === "agent_message" && ev.msg.message) return String(ev.msg.message);
  const item = ev?.item ?? ev?.msg?.item;
  if (item?.type === "AgentMessage" && item.text) return String(item.text);
  return null;
}

function findToolCall(ev: any): { name: string; input?: unknown } | null {
  const item = ev?.item ?? ev?.msg?.item;
  if (item?.type === "CommandExecution") return { name: "shell", input: item.command };
  if (ev?.msg?.type === "exec_command_begin") return { name: "shell", input: ev.msg.command };
  return null;
}

function isError(ev: any): boolean {
  return ev?.type === "error" || ev?.msg?.type === "error";
}

function errorMessage(ev: any): string {
  return String(ev?.message ?? ev?.msg?.message ?? "codex error");
}

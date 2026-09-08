import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentEvent,
  InteractiveSpec,
  RecoverOptions,
  RecoveredUsage,
  RunOptions,
  Runtime,
} from "./types";
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
    let sawError = false;
    // Track whether any event we recognized came through and keep the last agent
    // message. The `--json` schema is version-fragile, so a build we can't parse —
    // or a run that crashed on startup (e.g. a denied macOS file-access prompt) —
    // streams nothing we understand; we use `sawActivity` to catch that below, and
    // `summary` so a codex agent's final message is captured as its output (claude
    // gets this from its `result` event; codex has no equivalent single field).
    let sawActivity = false;
    let summary = "";
    let exitCode = 0;

    try {
      const stream = streamJson(cmd, {
        cwd: opts.cwd,
        logPath: opts.logPath,
        signal: opts.signal,
      });
      let next = await stream.next();
      for (; !next.done; next = await stream.next()) {
        const ev = next.value as any;

        const sid = findSessionId(ev);
        if (!sawSession && sid) {
          sawSession = true;
          sawActivity = true;
          yield { type: "session", ref: sid };
        }

        const u = findUsage(ev);
        if (u) {
          usage = u; // cumulative total; keep latest
          sawActivity = true;
        }

        const text = findAgentText(ev);
        if (text) {
          summary = text; // keep latest agent message as the run's summary
          sawActivity = true;
          yield { type: "text", text };
        }

        const tool = findToolCall(ev);
        if (tool) {
          sawActivity = true;
          yield { type: "tool_call", tool: tool.name, input: tool.input };
        }

        if (isError(ev)) {
          sawError = true;
          yield { type: "error", message: errorMessage(ev) };
        }
      }
      exitCode = next.value ?? 0;
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

    // Surface silent failures rather than reporting a no-op run as success: a
    // non-zero exit is an outright failure, and a run that produced zero parseable
    // events almost always means the codex build's `--json` shape drifted from our
    // extractors (see the class doc-comment) or the process never really started.
    if (exitCode !== 0) {
      sawError = true;
      yield { type: "error", message: `codex exited with code ${exitCode}` };
    } else if (!sawActivity) {
      sawError = true;
      yield {
        type: "error",
        message:
          "codex produced no recognizable output — its --json schema may have drifted from Tack's parser, or the run was blocked before it started",
      };
    }

    yield { type: "done", ok: !sawError, summary: summary || undefined };
  }

  /**
   * The interactive counterpart to `run`: the real `codex` TUI with the same
   * read-only posture, mounted MCP servers, context override, and add-dirs. We
   * leave approvals interactive (no `-a never`) so a human is in the loop. NOTE:
   * codex is not the currently-exercised interactive runtime — claude is — so this
   * mirrors the tested `exec` flags but may need adjusting against a pinned build.
   */
  interactiveCommand(opts: RunOptions): InteractiveSpec {
    const m = opts.model;
    const flags = ["-m", m.id, "-s", opts.readOnly ? "read-only" : "workspace-write"];
    if (m.effort) flags.push("-c", `model_reasoning_effort=${m.effort}`);
    for (const dir of opts.addDirs ?? []) flags.push("--add-dir", dir);
    if (opts.contextFile) flags.push("-c", `experimental_instructions_file=${quote(opts.contextFile)}`);
    for (const s of opts.mcpServers ?? []) {
      flags.push("-c", `mcp_servers.${s.name}.command=${quote(s.command)}`);
      flags.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
    }
    const prompt = opts.prompt.trim() ? [opts.prompt] : [];
    // `codex resume <id>` continues a prior session; a fresh run omits it. Codex
    // can't pre-assign an id, so a fresh interactive run has no sessionRef.
    if (opts.resume && opts.sessionRef) {
      return { command: opts.bin, args: ["resume", opts.sessionRef, ...flags, ...prompt] };
    }
    return { command: opts.bin, args: [...flags, ...prompt] };
  }

  /**
   * Recover cumulative token usage from a codex rollout transcript
   * (`~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl`). We match by session id
   * when known, else fall back to the most recently modified rollout — codex can't
   * pre-assign an id, so an interactive run only learns it after the fact. Each
   * `token_count` event carries a cumulative `total_token_usage`; we keep latest.
   */
  recoverUsage(opts: RecoverOptions): RecoveredUsage | null {
    const file = this.findRollout(opts.sessionRef);
    if (!file) return null;
    let usage: RecoveredUsage | null = null;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("total_token_usage")) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const info =
        ev?.payload?.info?.total_token_usage ?? ev?.info?.total_token_usage ?? ev?.total_token_usage;
      if (!info) continue;
      usage = {
        input: info.input_tokens ?? 0,
        output: info.output_tokens ?? 0,
        cacheRead: info.cached_input_tokens ?? 0,
        cacheWrite: info.cache_write_input_tokens ?? 0,
      };
    }
    return usage;
  }

  /** The rollout file whose name contains `sessionRef`, or the newest one. */
  private findRollout(sessionRef?: string): string | null {
    const root = join(homedir(), ".codex", "sessions");
    if (!existsSync(root)) return null;
    let best: { path: string; mtime: number } | null = null;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.endsWith(".jsonl")) {
          if (sessionRef && e.name.includes(sessionRef)) return void (best = { path: p, mtime: Infinity });
          const mtime = statSync(p).mtimeMs;
          if (!best || mtime > best.mtime) best = { path: p, mtime };
        }
      }
    };
    walk(root);
    return best ? (best as { path: string }).path : null;
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

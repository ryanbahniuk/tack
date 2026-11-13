import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelSchema, type Model } from "../config/schema";
import { versionFromId } from "./catalog";
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
 * worktree via `--approve-for-me` — approvals are auto-reviewed inside a
 * workspace-write sandbox (writes confined to the workspace). This matters under a
 * managed-device profile: plain `codex exec` forces `approval_policy=never`, which
 * an MDM can disallow, leaving approval requests that exec mode can't answer and
 * silently rejecting every tool call (see `buildCmd`). Codex reports tokens but NO
 * dollar figure, so we accumulate the
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
    // The generic exit-code message is only a fallback: callers keep the LATEST
    // error, so emitting it after codex already said why (e.g. `model_not_found`)
    // would bury the real reason behind "exited with code 1".
    if (exitCode !== 0) {
      if (!sawError) yield { type: "error", message: `codex exited with code ${exitCode}` };
      sawError = true;
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
    flags.push(...contextFlags(opts.contextFile));
    for (const s of opts.mcpServers ?? []) {
      flags.push("-c", `mcp_servers.${s.name}.command=${quote(s.command)}`);
      flags.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
      for (const [k, v] of Object.entries(s.env ?? {}))
        flags.push("-c", `mcp_servers.${s.name}.env.${k}=${quote(v)}`);
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

  /**
   * The models this codex login can use, via `codex debug models`. That command
   * refreshes the catalog against the signed-in account — a ChatGPT login is offered
   * a different set than an API key (e.g. no `gpt-5.6-sol`) — which is exactly what
   * Tack's static catalog can't know. Only `visibility: "list"` entries are kept
   * (the rest are internal, like the auto-review model), ordered by codex's
   * `priority` so the picker's default comes first. It's a debug subcommand with an
   * unversioned shape, so any failure or surprise returns null (unknown) rather than
   * a partial list that would prune real models.
   */
  listModels(bin: string): Model[] | null {
    const r = spawnSync(bin, ["debug", "models"], { encoding: "utf8", timeout: 30_000 });
    if (r.error || r.status !== 0) return null;
    let entries: unknown;
    try {
      entries = JSON.parse(r.stdout)?.models;
    } catch {
      return null;
    }
    if (!Array.isArray(entries)) return null;
    const rank = (e: any) => (typeof e.priority === "number" ? e.priority : Number.MAX_SAFE_INTEGER);
    const models = entries
      .filter((e: any) => typeof e?.slug === "string" && e.slug && e.visibility === "list")
      .sort((a: any, b: any) => rank(a) - rank(b))
      .map((e: any): Model => {
        const effort = ModelSchema.shape.effort.safeParse(e.default_reasoning_level);
        return {
          key: e.slug,
          provider: "openai",
          name: typeof e.display_name === "string" && e.display_name ? e.display_name : e.slug,
          version: versionFromId(e.slug),
          runtime: "codex",
          id: e.slug,
          effort: effort.success ? effort.data : undefined,
        };
      });
    return models.length > 0 ? models : null;
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
    // Approval posture. Plain `codex exec` forces `approval_policy=never`, which a
    // managed-device (MDM) profile can forbid — it then downgrades to a stricter
    // policy whose approval requests exec mode can't service, so EVERY command and
    // edit is auto-rejected and the agent produces an empty diff. `--approve-for-me`
    // routes those approvals through automatic review inside a workspace-write
    // sandbox, which stays within the MDM-allowed set. It IMPLIES workspace-write
    // and refuses to coexist with `-s`, so we pass it instead of `-s workspace-write`
    // on the write path. The read-only supervisor/summary posture still needs an
    // explicit `-s read-only` (and isn't exercised on codex today — those roles run
    // on claude — so it keeps codex's original read-only sandbox flag).
    const posture = opts.readOnly ? ["-s", "read-only"] : ["--approve-for-me"];
    const cmd = [opts.bin, "exec", "--json", "--skip-git-repo-check", "-m", m.id, ...posture];
    if (m.effort) cmd.push("-c", `model_reasoning_effort=${m.effort}`);
    for (const dir of opts.addDirs ?? []) cmd.push("--add-dir", dir);
    cmd.push(...contextFlags(opts.contextFile));
    for (const s of opts.mcpServers ?? []) {
      cmd.push("-c", `mcp_servers.${s.name}.command=${quote(s.command)}`);
      cmd.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
      for (const [k, v] of Object.entries(s.env ?? {}))
        cmd.push("-c", `mcp_servers.${s.name}.env.${k}=${quote(v)}`);
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

/**
 * The `-c` flags that hand codex Tack's context file (kept separate from the repo's
 * AGENTS.md). Codex has no append-a-file hook: `model_instructions_file` — the
 * successor to the `experimental_instructions_file` this used to pass, which 0.16x
 * silently ignores — REPLACES codex's ~20KB base prompt (tool use, sandbox, editing
 * workflow), so pointing it at our file would gut the agent. `developer_instructions`
 * instead layers a developer message on top of the base prompt. The context itself
 * stays on disk (SPEC §4: long context never goes on the command line); we pass only
 * a short directive to read it first.
 */
function contextFlags(contextFile: string | undefined): string[] {
  if (!contextFile) return [];
  const directive =
    `Tack, the supervisor coordinating this run, wrote your operating context to ${contextFile}. ` +
    "Before doing anything else, read that file in full and follow it for the rest of the session.";
  return ["-c", `developer_instructions=${quote(directive)}`];
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

/** An item's type with case and underscores folded, so the PascalCase item types of
 * older builds (`AgentMessage`) and the snake_case of 0.16x (`agent_message`) match. */
function itemType(item: any): string {
  return String(item?.type ?? "").replace(/_/g, "").toLowerCase();
}

function findAgentText(ev: any): string | null {
  if (ev?.msg?.type === "agent_message" && ev.msg.message) return String(ev.msg.message);
  const item = ev?.item ?? ev?.msg?.item;
  if (itemType(item) === "agentmessage" && item.text) return String(item.text);
  return null;
}

function findToolCall(ev: any): { name: string; input?: unknown } | null {
  const item = ev?.item ?? ev?.msg?.item;
  if (itemType(item) === "commandexecution") return { name: "shell", input: item.command };
  if (ev?.msg?.type === "exec_command_begin") return { name: "shell", input: ev.msg.command };
  return null;
}

// `turn.failed` carries the fatal reason under `error.message`. Note `item.completed`
// items of type "error" are deliberately NOT errors: codex uses them for non-fatal
// warnings (e.g. "ignoring unrecognized configuration setting").
function isError(ev: any): boolean {
  return ev?.type === "error" || ev?.type === "turn.failed" || ev?.msg?.type === "error";
}

/**
 * The human-readable reason from an error event. API failures arrive as the raw
 * response body JSON-encoded into `message`
 * (`{"type":"error","status":400,"error":{"message":"The 'x' model is not supported…"}}`),
 * so unwrap that to its inner message when it parses.
 */
function errorMessage(ev: any): string {
  const raw = String(ev?.message ?? ev?.error?.message ?? ev?.msg?.message ?? "codex error");
  try {
    const body = JSON.parse(raw);
    const inner = body?.error?.message ?? body?.message;
    if (typeof inner === "string" && inner) return inner;
  } catch {
    // Not JSON — already a plain message.
  }
  return raw;
}

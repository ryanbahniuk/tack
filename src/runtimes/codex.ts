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
import { streamJson, type StreamExit } from "./proc";
import { costFromPricing, type TokenUsage } from "./pricing";

/**
 * Drives Codex headless: `codex exec --json` (verified against codex-cli 0.163.0).
 *
 * Posture: `--approve-for-me` on the write path — a workspace-write sandbox (writes
 * confined to the worktree + `--add-dir`s) whose approval requests are routed to
 * Codex's automatic reviewer instead of a human. That matters because exec mode has
 * no one to answer an approval: plain `codex exec` forces `approval_policy=never`,
 * which a managed-device (MDM) profile can forbid, and the stricter fallback policy
 * then silently rejects every command and edit (observed: "`Never` is not in the
 * allowed set [UnlessTrusted, OnRequest] (set by MDM …)"). Never the
 * `--dangerously-bypass-approvals-and-sandbox` escape hatch. Read-only runs get the
 * same auto-review approvals inside `-s read-only`. See `buildCmd`.
 *
 * Context: the session-scoped context file goes in BY PATH via
 * `-c model_instructions_file=…` (SPEC §4: long context never goes on the command
 * line). That key succeeded `experimental_instructions_file`, which current builds
 * ignore outright ("`experimental_instructions_file` is ignored"), so the context
 * silently never reached the model. Caveat: it REPLACES Codex's built-in model
 * instructions rather than appending like claude's `--append-system-prompt-file`;
 * the tools still carry their own definitions. The append alternative,
 * `developer_instructions`, takes inline text only (SPEC §12).
 *
 * Events: current builds emit `thread.started{thread_id}`, `turn.started`,
 * `item.started|updated|completed{item:{id,type,…}}` (types `agent_message`,
 * `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
 * `todo_list`, `error`, …), `turn.completed{usage}`, `turn.failed{error:{message}}`
 * and `error{message}`. The schema has drifted before (older builds emitted
 * `msg`-wrapped events, PascalCase item types and `total_token_usage`), so the
 * extractors below accept both and scan defensively rather than bind to one nesting.
 *
 * Cost: Codex reports tokens but NO dollar figure, so we compute it from the model's
 * pricing table (SPEC §5).
 */
export class CodexRuntime implements Runtime {
  readonly kind = "codex" as const;

  async *run(opts: RunOptions): AsyncIterable<AgentEvent> {
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
    let exit: StreamExit = { code: 0, stderrTail: "" };
    // The last fatal message codex reported in-stream, used to explain a non-zero
    // exit when stderr is empty (codex reports most failures as JSONL, not stderr).
    let lastFatal = "";

    try {
      const cmd = this.buildCmd(opts);
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
          // Latest wins. Legacy `total_token_usage` is a running total, and exec runs
          // one turn per invocation, so the single `turn.completed` is the run's usage
          // either way. Summing would double-count if a build reports running totals.
          usage = u;
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

        const fatal = fatalError(ev);
        if (fatal) {
          sawError = true;
          lastFatal = fatal;
          yield { type: "error", message: fatal };
        }
      }
      exit = next.value ?? exit;
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
    // non-zero exit is an outright failure (and carries codex's own explanation — a
    // rejected flag, a bad config value, auth — so it's the error we persist), and a
    // run that produced zero parseable events almost always means the codex build's
    // `--json` shape drifted from our extractors or the process never really started.
    if (exit.code !== 0) {
      sawError = true;
      const why = exit.stderrTail.trim() || lastFatal;
      yield { type: "error", message: `codex exited with code ${exit.code}${why ? `: ${why}` : ""}` };
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
   * sandbox, mounted MCP servers, context file, and add-dirs. Approvals stay
   * interactive (no `--approve-for-me`) so a human is in the loop. NOTE: codex is
   * not the currently-exercised interactive runtime — claude is — so this mirrors
   * the `exec` flags (all of which the 0.163 TUI also accepts) but is less tested.
   */
  interactiveCommand(opts: RunOptions): InteractiveSpec {
    const flags = [
      "-m",
      opts.model.id,
      "-s",
      opts.readOnly ? "read-only" : "workspace-write",
      ...sharedFlags(opts),
    ];
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
    // Approval posture (see the class doc): `--approve-for-me` implies
    // workspace-write and refuses to coexist with `-s`, so it replaces
    // `-s workspace-write` on the write path. The read-only posture (supervisor /
    // summary roles — not exercised on codex today, they run on claude) spells out
    // the same auto-review approvals by config, since bare `-s read-only` gets exec's
    // forced `approval_policy=never`, which the MDM rejects ("`Never` is not in the
    // allowed set [UnlessTrusted, OnRequest]"). `on-request` alone isn't enough —
    // exec still forces `never` unless the reviewer is `auto_review`.
    const posture = opts.readOnly
      ? ["-s", "read-only", "-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="auto_review"']
      : ["--approve-for-me"];
    const flags = ["--json", "--skip-git-repo-check", "-m", opts.model.id, ...posture, ...sharedFlags(opts)];
    // Continuation: `codex exec resume <id>` accepts only a subset of exec's flags
    // (no `--approve-for-me`, `-s` or `--add-dir` — it exits 2 on them), but exec's
    // own options may precede the subcommand, so the posture is identical either way.
    if (opts.resume && opts.sessionRef) {
      return [opts.bin, "exec", ...flags, "resume", opts.sessionRef, opts.prompt];
    }
    return [opts.bin, "exec", ...flags, opts.prompt];
  }
}

/** Flags common to `exec` and the TUI: effort, add-dirs, context, MCP servers. */
function sharedFlags(opts: RunOptions): string[] {
  const flags: string[] = [];
  if (opts.model.effort) flags.push("-c", `model_reasoning_effort=${tomlString(opts.model.effort)}`);
  for (const dir of opts.addDirs ?? []) flags.push("--add-dir", dir);
  // Codex has no system-prompt-file flag; this config key is the file-based hook
  // (see the class doc for its replace-not-append caveat).
  if (opts.contextFile) flags.push("-c", `model_instructions_file=${tomlString(opts.contextFile)}`);
  for (const s of opts.mcpServers ?? []) {
    flags.push("-c", `mcp_servers.${s.name}.command=${tomlString(s.command)}`);
    flags.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
    for (const [k, v] of Object.entries(s.env ?? {}))
      flags.push("-c", `mcp_servers.${s.name}.env.${k}=${tomlString(v)}`);
  }
  return flags;
}

/**
 * A TOML basic string for a `-c key=value` override (codex parses the value as
 * TOML). JSON's string escapes (`\"`, `\\`, `\uXXXX`, …) are all valid TOML, so this
 * is safe for quotes and Windows-style paths alike.
 */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

// --- Defensive field extraction across Codex event shapes -------------------
// Current shape first, then the older `msg`-wrapped / PascalCase shapes.

function findSessionId(ev: any): string | null {
  // No bare `ev.id` fallback: current builds put `id` on items (`item_0`, …), which
  // would be mistaken for the thread id. A real id is a string (a UUID today).
  const id =
    ev?.thread_id ??
    ev?.session_id ??
    ev?.session_meta?.session_id ??
    ev?.msg?.session_id ??
    (ev?.type === "session_meta" ? ev?.id ?? ev?.payload?.id : null);
  return typeof id === "string" && id ? id : null;
}

function findUsage(ev: any): TokenUsage | null {
  const info =
    (ev?.type === "turn.completed" ? ev.usage : null) ??
    ev?.info?.total_token_usage ??
    ev?.msg?.info?.total_token_usage ??
    ev?.total_token_usage;
  if (!info || typeof info !== "object") return null;
  return toTokenUsage(info);
}

/**
 * Codex token counts → Tack's disjoint buckets. Codex's `input_tokens` INCLUDES the
 * cached prompt tokens (OpenAI semantics), whereas `costFromPricing` bills `input`
 * and `cacheRead` separately, so the cached share is moved out of `input` rather
 * than charged twice. `output_tokens` already includes reasoning tokens.
 */
function toTokenUsage(info: any): TokenUsage {
  const input = Number(info.input_tokens) || 0;
  const cacheRead = Number(info.cached_input_tokens) || 0;
  return {
    input: Math.max(0, input - cacheRead),
    output: Number(info.output_tokens) || 0,
    cacheRead,
    cacheWrite: Number(info.cache_write_input_tokens) || 0,
  };
}

/** The event's item, only once it's finished (`item.completed`), or a legacy item. */
function completedItem(ev: any): any {
  if (typeof ev?.type === "string" && ev.type.startsWith("item.")) {
    return ev.type === "item.completed" ? ev.item : null;
  }
  return ev?.item ?? ev?.msg?.item ?? null;
}

function findAgentText(ev: any): string | null {
  if (ev?.msg?.type === "agent_message" && ev.msg.message) return String(ev.msg.message);
  const item = completedItem(ev);
  if ((item?.type === "agent_message" || item?.type === "AgentMessage") && item.text) return String(item.text);
  return null;
}

/**
 * A tool call, reported once when it STARTS (`item.started`) so the dashboard shows
 * live activity — current builds also emit `item.completed` for the same item,
 * which we skip to avoid double-counting. Items that only ever complete (a
 * `file_change`, which is applied atomically) are reported on completion.
 */
function findToolCall(ev: any): { name: string; input?: unknown } | null {
  if (ev?.msg?.type === "exec_command_begin") return { name: "shell", input: ev.msg.command };
  const isNew = typeof ev?.type === "string" && ev.type.startsWith("item.");
  if (isNew && ev.type !== "item.started" && ev.type !== "item.completed") return null;
  const item = ev?.item ?? ev?.msg?.item;
  if (!item) return null;
  const started = !isNew || ev.type === "item.started";
  switch (item.type) {
    case "command_execution":
    case "CommandExecution":
      return started ? { name: "shell", input: item.command } : null;
    case "mcp_tool_call":
      return started ? { name: `mcp__${item.server}__${item.tool}`, input: item.arguments } : null;
    case "web_search":
      return started ? { name: "web_search", input: item.query } : null;
    case "file_change":
      // `changes: [{path, kind}]`. Reported on completion, once the edit is applied.
      return ev.type === "item.completed" || !isNew
        ? { name: "edit", input: (item.changes ?? []).map((c: any) => c?.path).filter(Boolean) }
        : null;
  }
  return null;
}

/**
 * The message of an event that means the run failed, else null. Not every `error`
 * is fatal: codex streams transient `error{message:"Reconnecting... 2/5 (…)"}` while
 * it retries the model connection, and `item.completed{item:{type:"error"}}` for
 * warnings (an ignored config key, a transport fallback). Those stay in the log
 * only. A turn that really fails ends in `turn.failed` and a non-zero exit.
 */
function fatalError(ev: any): string | null {
  if (ev?.type === "turn.failed") return String(ev.error?.message ?? "codex turn failed");
  if (ev?.type === "error" || ev?.msg?.type === "error") {
    const message = String(ev?.message ?? ev?.msg?.message ?? "codex error");
    return /^Reconnecting\b/.test(message) ? null : message;
  }
  return null;
}

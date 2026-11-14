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
 * Context: codex has no append-a-file hook for the session-scoped context file.
 * `model_instructions_file` (the successor to `experimental_instructions_file`,
 * which 0.16x ignores outright) REPLACES Codex's whole base prompt, so instead a
 * short `developer_instructions` directive tells the agent to read the file — the
 * context itself stays on disk (SPEC §4). See `contextFlags`.
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
    // non-zero exit is an outright failure, and a run that produced zero parseable
    // events almost always means the codex build's `--json` shape drifted from our
    // extractors or the process never really started. The exit error is the one we
    // persist (callers keep the LATEST error), so it carries the reason: codex's own
    // in-stream fatal (e.g. `model_not_found`) when it gave one — a bare "exited with
    // code 1" after it would bury the real cause — else the stderr tail, which is
    // where a rejected flag, a bad config value or an auth failure shows up before
    // codex emits a single JSON line.
    if (exit.code !== 0) {
      sawError = true;
      const why = lastFatal || exit.stderrTail.trim();
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
  flags.push(...contextFlags(opts.contextFile));
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
  return ["-c", `developer_instructions=${tomlString(directive)}`];
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

/** An item's type with case and underscores folded, so the PascalCase item types of
 * older builds (`AgentMessage`) and the snake_case of 0.16x (`agent_message`) match. */
function itemType(item: any): string {
  return String(item?.type ?? "").replace(/_/g, "").toLowerCase();
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
  if (itemType(item) === "agentmessage" && item.text) return String(item.text);
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
  switch (itemType(item)) {
    case "commandexecution":
      return started ? { name: "shell", input: item.command } : null;
    case "mcptoolcall":
      return started ? { name: `mcp__${item.server}__${item.tool}`, input: item.arguments } : null;
    case "websearch":
      return started ? { name: "web_search", input: item.query } : null;
    case "filechange":
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
 * warnings (e.g. "ignoring unrecognized configuration setting", a transport
 * fallback). Those stay in the log only. A turn that really fails ends in
 * `turn.failed` (reason under `error.message`) and a non-zero exit.
 */
function fatalError(ev: any): string | null {
  if (ev?.type === "turn.failed") return errorMessage(ev.error?.message ?? "codex turn failed");
  if (ev?.type === "error" || ev?.msg?.type === "error") {
    const raw = String(ev?.message ?? ev?.msg?.message ?? "codex error");
    return /^Reconnecting\b/.test(raw) ? null : errorMessage(raw);
  }
  return null;
}

/**
 * The human-readable reason from an error message. API failures arrive as the raw
 * response body JSON-encoded into `message`
 * (`{"type":"error","status":400,"error":{"message":"The 'x' model is not supported…"}}`),
 * so unwrap that to its inner message when it parses.
 */
function errorMessage(message: unknown): string {
  const raw = String(message);
  try {
    const body = JSON.parse(raw);
    const inner = body?.error?.message ?? body?.message;
    if (typeof inner === "string" && inner) return inner;
  } catch {
    // Not JSON — already a plain message.
  }
  return raw;
}

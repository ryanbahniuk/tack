import type { Model, RuntimeKind } from "../config/schema";

/** What Tack hands a runtime to execute one agent turn in a worktree. */
export interface RunOptions {
  prompt: string;
  /** The worktree the agent runs in (its cwd + write scope). */
  cwd: string;
  model: Model;
  /** Resolved runtime binary (path or PATH name), honoring any config pin. */
  bin: string;
  /**
   * Resume handle. On a fresh run this is a pre-assigned id we want the runtime to
   * adopt (claude `--session-id`); on a continuation it's the id to resume. Codex
   * can't pre-assign, so on a fresh run it's ignored and the real id arrives as a
   * `session` event.
   */
  sessionRef?: string;
  /** Whether this invocation resumes an existing session vs starts a new one. */
  resume?: boolean;
  /**
   * A single session-scoped context file, injected BY PATH (never inline). The
   * supervisor merges all guidance into one file per agent; each adapter wires it
   * the way its CLI supports (claude `--append-system-prompt-file`, codex
   * `experimental_instructions_file`). Repo-checked-in CLAUDE.md/AGENTS.md are
   * left untouched — this is separate, Tack-owned context.
   */
  contextFile?: string;
  /**
   * MCP servers to mount for this run (each a `tack __…` subcommand). Agents get
   * the coordination server; the supervisor gets its own tool server. Each adapter
   * wires them the way its CLI expects.
   */
  mcpServers?: Array<{ name: string; command: string; args: string[] }>;
  /**
   * Read-only posture — for the supervisor, which only investigates and delegates,
   * never edits. Adapters translate to their CLI's read-only sandbox/permissions.
   */
  readOnly?: boolean;
  /**
   * Also forbid the shell (Bash) on top of `readOnly`. The delegate-only supervisor
   * sets this so it can't route around its no-write posture by shelling out to
   * create files — it plans through its MCP tools and the chat. Plain read-only
   * runs (e.g. project summarization) leave it off and keep Bash for investigation.
   */
  disallowShell?: boolean;
  /** Extra directories the run may read beyond its cwd (project roots, allowlist). */
  addDirs?: string[];
  /**
   * A command to run when the human approves the plan. The claude adapter wires it
   * as a PostToolUse hook on ExitPlanMode (which only fires on acceptance), so Tack
   * can flip the session's plan-approval gate that `spawn_agent` checks. Only the
   * attended read-only supervisor sets this; headless/agent runs omit it.
   */
  onPlanApproved?: { command: string; args: string[] };
  /** Raw runtime stdout is teed here for the dashboard's log view. */
  logPath: string;
  signal?: AbortSignal;
}

/** A spawn spec for an attended, terminal-owning runtime session. Unlike `run`
 * (headless JSON streaming), the interactive CLI takes over the TTY, so Tack just
 * hands back the argv/env to spawn with inherited stdio and awaits exit — there is
 * no event stream to parse. Cost is recovered afterwards from the transcript. */
export interface InteractiveSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Cumulative token usage recovered from a runtime's on-disk session transcript. */
export interface RecoveredUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Where an interactive session's transcript lives, so cost can be recovered. */
export interface RecoverOptions {
  /** The runtime session id. For claude this is pre-assigned; for codex it's
   * unknown up front, so adapters fall back to the newest transcript under `cwd`. */
  sessionRef?: string;
  /** The cwd the interactive session ran in (used to locate its transcript). */
  cwd: string;
}

/** Normalized events every runtime emits, so the supervisor stays runtime-agnostic. */
export type AgentEvent =
  | { type: "session"; ref: string } // runtime session id -> agents.resume_ref
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input?: unknown }
  | { type: "tool_result"; tool: string; ok: boolean; preview?: string }
  | {
      type: "usage";
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | { type: "cost"; usd: number; source: "runtime" | "pricing" } // cumulative; read latest
  | { type: "log"; message: string }
  | { type: "done"; ok: boolean; summary?: string }
  | { type: "error"; message: string };

export interface Runtime {
  readonly kind: RuntimeKind;
  /** Execute an agent turn (fresh, or a continuation when `opts.resume`). */
  run(opts: RunOptions): AsyncIterable<AgentEvent>;
  /**
   * Build the argv/env to launch this runtime's interactive TUI with the same
   * capability posture as `run` (read-only, mounted MCP servers, context file,
   * add-dirs, session/resume). The caller spawns it with inherited stdio; a
   * non-empty `opts.prompt` seeds the first message.
   */
  interactiveCommand(opts: RunOptions): InteractiveSpec;
  /**
   * Optional one-time prep run before the interactive TUI is spawned in `cwd`.
   * claude uses it to pre-record workspace trust for the freshly-created session
   * directory so its "trust this folder" dialog doesn't interrupt the start of
   * every interactive supervisor session. Headless `run` never needs this.
   */
  prepareInteractive?(cwd: string): void;
  /**
   * Recover cumulative token usage for an interactive session from the runtime's
   * on-disk transcript, so cost can be computed after the TUI exits. Returns null
   * when no transcript can be located.
   */
  recoverUsage(opts: RecoverOptions): RecoveredUsage | null;
}

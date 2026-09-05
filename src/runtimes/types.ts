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
  /** Extra directories the run may read beyond its cwd (project roots, allowlist). */
  addDirs?: string[];
  /** Raw runtime stdout is teed here for the dashboard's log view. */
  logPath: string;
  signal?: AbortSignal;
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
}

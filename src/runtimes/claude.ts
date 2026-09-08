import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Autonomous, unattended permission posture for agents running in an isolated
 * worktree: a classifier approves actions and anything that would prompt is
 * auto-denied (no human in the loop). `bypassPermissions` is deliberately NOT the
 * default — org-managed policy may forbid it and the worktree is the safety
 * boundary. Exposed here as the single knob if we later make it configurable.
 */
const PERMISSION_ARGS = ["--permission-mode", "auto", "--permission-prompts", "none"];

/**
 * OS-level read/write confinement for an autonomous worktree agent. The permission
 * classifier alone bounds only the in-process edit tools; a `cat`/`rg` in Bash (or
 * any subprocess it spawns) is unbounded and reads the whole filesystem — which is
 * how an agent wanders outside its worktree and trips a macOS TCC prompt. Claude's
 * built-in sandbox (Seatbelt on macOS, bubblewrap on Linux) is the only thing that
 * actually contains Bash, so we turn it on and confine reads to the working dirs.
 *
 * There is exactly one agent per worktree and `cwd` is that worktree, so with no
 * `--add-dir` the working set is the single worktree: reads AND writes both stay
 * inside it, matching the write boundary. `blockReadsOutsideWorkingDirectories`
 * covers the in-process Read/Grep/Glob tools too. `failIfUnavailable` +
 * `allowUnsandboxedCommands: false` make the boundary a hard gate for an unattended
 * run rather than a silent fallback (or a `dangerouslyDisableSandbox` retry).
 */
const AGENT_SANDBOX_SETTINGS = {
  sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
  permissions: { blockReadsOutsideWorkingDirectories: true },
};

/**
 * Drives Claude Code headless: `claude -p --output-format stream-json`. We inherit
 * every Claude feature for free (no SDK coupling) and read `total_cost_usd`
 * directly from the final result event, so cost is authoritative on this runtime.
 */
export class ClaudeRuntime implements Runtime {
  readonly kind = "claude" as const;

  async *run(opts: RunOptions): AsyncIterable<AgentEvent> {
    const cmd = this.buildCmd(opts);
    let sawSession = false;
    let ok = true;
    let summary = "";

    try {
      for await (const raw of streamJson(cmd, {
        cwd: opts.cwd,
        logPath: opts.logPath,
        signal: opts.signal,
        // Pass the prompt on stdin: with `-p` and a non-TTY stdin (always, when
        // spawned), this Claude CLI reads the prompt from stdin and ignores a
        // positional prompt arg, erroring intermittently otherwise.
        stdin: opts.prompt,
      })) {
        const ev = raw as any;
        if (!sawSession && typeof ev?.session_id === "string") {
          sawSession = true;
          yield { type: "session", ref: ev.session_id };
        }

        switch (ev?.type) {
          case "assistant": {
            for (const block of ev.message?.content ?? []) {
              if (block.type === "text" && block.text) yield { type: "text", text: block.text };
              else if (block.type === "tool_use")
                yield { type: "tool_call", tool: block.name, input: block.input };
            }
            break;
          }
          case "user": {
            for (const block of ev.message?.content ?? []) {
              if (block.type === "tool_result") {
                yield {
                  type: "tool_result",
                  tool: String(block.tool_use_id ?? "tool"),
                  ok: block.is_error !== true,
                  preview: previewOf(block.content),
                };
              }
            }
            break;
          }
          case "result": {
            const u = ev.usage ?? {};
            yield {
              type: "usage",
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite: u.cache_creation_input_tokens ?? 0,
            };
            if (typeof ev.total_cost_usd === "number")
              yield { type: "cost", usd: ev.total_cost_usd, source: "runtime" };
            ok = ev.subtype === "success" && ev.is_error !== true;
            summary = typeof ev.result === "string" ? ev.result : "";
            break;
          }
        }
      }
    } catch (err) {
      yield { type: "error", message: (err as Error).message };
      ok = false;
    }
    yield { type: "done", ok, summary };
  }

  /**
   * The interactive counterpart to `run`: the real `claude` TUI with the same
   * read-only supervisor posture (plan mode, no edit/subagent tools) and the same
   * mounted MCP servers, context, and add-dirs. We drop the headless `-p`
   * streaming flags (and `--permission-prompts none`) so a human is genuinely in
   * the loop, but keep the capability boundary identical: it can read and drive
   * the `tack-supervisor` tools, never edit code directly.
   */
  interactiveCommand(opts: RunOptions): InteractiveSpec {
    const m = opts.model;
    const args = ["--model", m.id];
    if (opts.readOnly) {
      args.push("--permission-mode", "plan");
      // With `disallowShell`, Bash is forbidden too so the supervisor can't route
      // around its no-write posture by shelling out (e.g. `echo … > plan.md`) — it
      // plans via its `tack-supervisor` tools and the chat, never by writing files.
      args.push("--disallowedTools", readOnlyDisallowed(opts));
      // Auto-allow the mounted Tack MCP servers so their read/coordinate calls don't
      // each raise a permission prompt — the ONE human gate we want is the plan
      // approval (ExitPlanMode), after which spawn_agent proceeds. `spawn_agent` is
      // still held before approval by its own plan-gate, not by a per-call prompt.
      for (const s of opts.mcpServers ?? []) args.push("--allowedTools", `mcp__${s.name}`);
    }
    if (m.effort) args.push("--effort", m.effort);
    if (opts.resume && opts.sessionRef) args.push("--resume", opts.sessionRef);
    else if (opts.sessionRef) args.push("--session-id", opts.sessionRef);
    for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
    if (opts.contextFile) args.push("--append-system-prompt-file", opts.contextFile);
    // A single --settings blob carrying the session's human gates, all wired as hooks:
    const settings: { hooks?: unknown } = {};
    // (1) Track the plan-approval decision through the session's lifecycle:
    //  - PreToolUse on ExitPlanMode fires when the plan is presented (before the human
    //    decides) → mark the session as awaiting input. This re-arms every iteration.
    //  - PostToolUse fires only after acceptance (rejection / "keep planning" never
    //    completes the tool), so it's an un-forgeable human signal the model can't
    //    self-trigger → flip the plan-approval gate and clear the awaiting flag.
    const preToolUse: unknown[] = [];
    const postToolUse: unknown[] = [];
    if (opts.onPlanPresented) {
      const command = shellJoin([opts.onPlanPresented.command, ...opts.onPlanPresented.args]);
      preToolUse.push({ matcher: "ExitPlanMode", hooks: [{ type: "command", command }] });
    }
    if (opts.onPlanApproved) {
      const command = shellJoin([opts.onPlanApproved.command, ...opts.onPlanApproved.args]);
      postToolUse.push({ matcher: "ExitPlanMode", hooks: [{ type: "command", command }] });
    }
    // (2) Gate the approval tools (e.g. open_pr) behind a per-call human ok. A
    // PreToolUse hook that returns an `ask` decision forces the prompt even though the
    // tool's MCP server is otherwise auto-allowed by the `--allowedTools mcp__<server>`
    // wildcard below — the model can't open a PR without the human okaying that call.
    // We use a hook (not a permissions `ask` rule) so the prompt carries our own
    // wording via `permissionDecisionReason` instead of the generic "requires
    // confirmation for this tool" line.
    if (opts.approvalTools?.length) {
      const reason = opts.approvalPrompt ?? "Approve this action?";
      const payload = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: reason,
        },
      });
      // The hook command just echoes the decision JSON on stdout for Claude to read.
      const command = shellJoin(["printf", "%s", payload]);
      for (const tool of opts.approvalTools) {
        preToolUse.push({ matcher: tool, hooks: [{ type: "command", command }] });
      }
    }
    const hooks: Record<string, unknown[]> = {};
    if (preToolUse.length) hooks.PreToolUse = preToolUse;
    if (postToolUse.length) hooks.PostToolUse = postToolUse;
    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
    const mcpServers: Record<string, { command: string; args: string[] }> = {};
    for (const s of opts.mcpServers ?? []) mcpServers[s.name] = { command: s.command, args: s.args };
    args.push("--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config");
    // A non-empty prompt seeds the first turn; an empty one drops the user straight
    // into an idle TUI to type their own opener.
    if (opts.prompt.trim()) args.push(opts.prompt);
    return { command: opts.bin, args };
  }

  /**
   * Pre-record workspace trust for `cwd` so the interactive TUI doesn't stop to
   * ask "trust this folder?" on launch. Claude shows that dialog the first time
   * it runs interactively in a directory it hasn't seen, and every supervisor
   * session gets a brand-new `~/.tack/supervisor/ses_<id>` cwd — so without this
   * it would prompt at the start of every session. Tack creates and owns these
   * directories, so we set the same per-project flag the dialog would write
   * (`~/.claude.json` -> `projects[cwd].hasTrustDialogAccepted`). Headless `-p`
   * runs skip the dialog entirely, so only the interactive path needs this.
   */
  prepareInteractive(cwd: string): void {
    const file = join(homedir(), ".claude.json");
    let config: any = {};
    if (existsSync(file)) {
      try {
        config = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // Corrupt/unreadable — don't clobber it; claude will handle the dialog.
        return;
      }
    }
    if (typeof config !== "object" || config === null) return;
    const projects = (config.projects ??= {});
    const entry = (projects[cwd] ??= {});
    if (entry.hasTrustDialogAccepted === true) return;
    entry.hasTrustDialogAccepted = true;
    writeFileSync(file, JSON.stringify(config, null, 2));
  }

  /**
   * Sum token usage across a claude session transcript. Claude Code stores one
   * JSONL per session at `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`
   * (cwd slug replaces `/` and `.` with `-`), with per-assistant-message `usage`
   * but no cost figure — so the caller applies pricing to what we return here.
   */
  recoverUsage(opts: RecoverOptions): RecoveredUsage | null {
    if (!opts.sessionRef) return null;
    const slug = opts.cwd.replace(/[/.]/g, "-");
    const file = join(homedir(), ".claude", "projects", slug, `${opts.sessionRef}.jsonl`);
    if (!existsSync(file)) return null;
    const usage: RecoveredUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let saw = false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const u = ev?.message?.usage;
      if (!u) continue;
      saw = true;
      // Per-message usage is additive across the whole conversation (each turn is a
      // fresh request), so we accumulate rather than keep-latest.
      usage.input += u.input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    }
    return saw ? usage : null;
  }

  private buildCmd(opts: RunOptions): string[] {
    const m = opts.model;
    const cmd = [opts.bin, "-p", "--output-format", "stream-json", "--verbose", "--model", m.id];
    // Read-only supervisor vs autonomous worktree agent. Read-only runs also
    // forbid the native subagent tool (named "Task" or "Agent" across CLI
    // versions): investigation delegates through Tack's own coordination MCP, so
    // a nested Claude subagent only adds a full extra agent loop of latency —
    // e.g. `tack projects refresh` spawning an Explore agent to read a README.
    if (opts.readOnly) {
      cmd.push("--permission-mode", "plan", "--permission-prompts", "none");
      // `disallowShell` also forbids Bash so a delegate-only run can't shell out to
      // write files; plain read-only runs keep Bash for read investigation.
      cmd.push("--disallowedTools", readOnlyDisallowed(opts));
    } else {
      cmd.push(...PERMISSION_ARGS);
      // Sandbox the worktree agent so Bash (and its subprocesses) can't read past
      // the worktree — the classifier only bounds the in-process edit tools.
      cmd.push("--settings", JSON.stringify(AGENT_SANDBOX_SETTINGS));
    }
    if (m.effort) cmd.push("--effort", m.effort);
    if (opts.resume && opts.sessionRef) cmd.push("--resume", opts.sessionRef);
    else if (opts.sessionRef) cmd.push("--session-id", opts.sessionRef);
    for (const dir of opts.addDirs ?? []) cmd.push("--add-dir", dir);
    if (opts.contextFile) cmd.push("--append-system-prompt-file", opts.contextFile);
    // Always mount exactly the servers Tack provides (an empty set when none) and
    // pass --strict-mcp-config so a run never inherits the user's global MCP
    // config from the filesystem. Otherwise a bare read-only run (e.g. project
    // summarization) picks up whatever third-party servers — datadog, slack — the
    // user has configured and wanders into them.
    const mcpServers: Record<string, { command: string; args: string[] }> = {};
    for (const s of opts.mcpServers ?? []) mcpServers[s.name] = { command: s.command, args: s.args };
    cmd.push("--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config");
    // The prompt is fed via stdin (see run()), not as a positional arg.
    return cmd;
  }
}

/**
 * The `--disallowedTools` list for a read-only run. We deliberately do NOT list
 * the native edit tools (Edit/Write/NotebookEdit): a read-only run is always in
 * `--permission-mode plan`, which already blocks every file edit — and does so
 * gracefully, intercepting the call and steering the model to ExitPlanMode.
 * Hard-disallowing those tools instead turns that graceful block into a jarring
 * "No such tool available: Write. Write is disabled for this session" error that
 * surfaces to the human right before the plan. So we only disallow what plan mode
 * does NOT cover: the subagent tools (named "Task" or "Agent" across CLI
 * versions), plus Bash when the caller forbids shelling out entirely.
 */
function readOnlyDisallowed(opts: RunOptions): string {
  const base = ["Task", "Agent"];
  if (opts.disallowShell) base.push("Bash");
  return base.join(",");
}

/** Joins a command + args into a single shell string (hook commands run via `sh
 * -c`), single-quoting each token so paths/args with spaces survive intact. */
function shellJoin(parts: string[]): string {
  return parts.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(" ");
}

function previewOf(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
        : "";
  return text.slice(0, 200);
}

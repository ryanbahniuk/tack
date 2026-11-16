import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { APPROVE_PROMPT_MARKER } from "../supervisor/approve-prompt";

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
   * read-only supervisor posture (with optional page-source writes) and mounted MCP
   * servers, context, and add-dirs. We drop the headless `-p` streaming flags (and
   * `--permission-prompts none`) so a human is genuinely in the loop, but keep the
   * delegation boundary: it can read and drive the `tack-supervisor`
   * tools, never edit code directly. Unlike the headless path it does NOT run in
   * `--permission-mode plan`: plan mode ends in Claude Code's native ExitPlanMode
   * menu, which no hook can relabel or replace. Instead edits are blocked by a
   * `permissions.deny` list, or a path guard when page drafts are enabled, in
   * `--settings`, and the plan is approved through Tack's
   * own `planApprovalTool` prompt.
   */
  interactiveCommand(opts: RunOptions): InteractiveSpec {
    const writableDirs = opts.readOnly ? opts.writableDirs ?? [] : [];
    // Never remove the blanket deny without the hook that replaces it: allow
    // rules alone cannot prevent writes outside their patterns after a prompt.
    if (writableDirs.length && !opts.writeGuard)
      throw new Error("Read-only writableDirs require a writeGuard command.");
    const m = opts.model;
    const args = ["--model", m.id];
    // A single --settings blob carrying the session's edit block and human gates.
    const settings: {
      permissions?: { deny?: string[]; allow?: string[]; ask?: string[] };
      hooks?: Record<string, unknown>;
    } = {};
    if (opts.readOnly) {
      // Pin the default mode explicitly so a user-level `defaultMode` (e.g. plan) can't
      // reintroduce the native ExitPlanMode menu, then block the native edit tools (and
      // plan mode itself) via deny rules rather than plan mode.
      args.push("--permission-mode", "default");
      settings.permissions = {
        deny: writableDirs.length
          ? INTERACTIVE_READONLY_DENY.filter((tool) => !["Edit", "Write", "MultiEdit"].includes(tool))
          : [...INTERACTIVE_READONLY_DENY],
      };
      // With `disallowShell`, Bash is forbidden too so the supervisor can't route
      // around its no-write posture by shelling out (e.g. `echo … > plan.md`) — it
      // plans via its `tack-supervisor` tools and the chat, never by writing files.
      args.push("--disallowedTools", readOnlyDisallowed(opts));
      // Auto-allow the mounted Tack MCP servers so their read/coordinate calls don't
      // each raise a permission prompt — the ONE human gate we want is the plan
      // approval (elicited by `planApprovalTool`), after
      // which spawn_agent proceeds. `spawn_agent` is still held before approval by
      // its own server-side plan-gate, not by a per-call prompt.
      // Layer (a) of four; see `supervisorAllowRules` for the remaining safeguards.
      for (const rule of supervisorAllowRules(opts)) args.push("--allowedTools", rule);
    }
    if (m.effort) args.push("--effort", m.effort);
    if (opts.resume && opts.sessionRef) args.push("--resume", opts.sessionRef);
    if (opts.resume && opts.sessionRef && opts.fork && supportsFork(opts.bin)) args.push("--fork-session");
    else if (!opts.resume && opts.sessionRef) args.push("--session-id", opts.sessionRef);
    for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
    if (opts.contextFile) args.push("--append-system-prompt-file", opts.contextFile);
    // Approval tools use PreToolUse ask hooks for their plain-language wording.
    // Settings ask rules back them up against the server-wide allow rules below.
    const preToolUse: unknown[] = [];
    if (writableDirs.length && opts.writeGuard) {
      const command = shellJoin([opts.writeGuard.command, ...opts.writeGuard.args]);
      preToolUse.push({
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command }],
      });
    }
    // (1) Mark the session awaiting input before the handler elicits a decision.
    if (opts.onPlanPresented && opts.planApprovalTool) {
      const command = shellJoin([opts.onPlanPresented.command, ...opts.onPlanPresented.args]);
      preToolUse.push({ matcher: opts.planApprovalTool, hooks: [{ type: "command", command }] });
    }
    // (2) Gate the approval tools (e.g. open_pr) behind a per-call human ok — the
    // model can't open a PR without the human okaying that call.
    // We use a hook so the prompt carries our own wording via
    // `permissionDecisionReason` instead of the generic "requires confirmation for
    // this tool" line; a permissions `ask` rule in (4) backs it up so the prompt is
    // guaranteed even against the server-wide allow rules.
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
    // (3) Hook-level auto-allow for the mounted servers' tools. The server-level
    // `--allowedTools mcp__<server>` rule above was observed NOT to be enough on its
    // own — `check_agents` still raised a prompt — so this hook is layer (b).
    // It too proved insufficient for `sync_projects` in plan mode; see (4).
    // Exclude approval tools so an allow decision never pre-empts their human gates.
    if (opts.readOnly && opts.mcpServers?.length) {
      const payload = JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      });
      const command = shellJoin(["printf", "%s", payload]);
      const gated = [...(opts.approvalTools ?? [])];
      for (const s of opts.mcpServers) {
        const matcher = autoAllowMatcher(s.name, gated);
        preToolUse.push({ matcher, hooks: [{ type: "command", command }] });
      }
    }
    // (4) The same server-wide allow as a settings `permissions.allow` rule —
    // auto-allow layer (c). `--allowedTools` plus the hook in (3) still let plan mode
    // prompt for `sync_projects` (then a tool without `readOnlyHint`), so we also
    // state the allow the way the TUI's own "Yes, and don't ask again" persists it:
    // as a settings rule. Layer (d) is that same rule pre-written to the session
    // cwd's `.claude/settings.local.json` by `prepareInteractive`.
    // The approval tools also get `permissions.ask` rules. Permission rules
    // resolve deny → ask → allow, so an `ask` rule beats every server-wide `allow`
    // above regardless of which source it came from — a guarantee that open_pr still
    // prompts that doesn't depend on how the `ask` hook in (2) ranks against rules.
    // The hook in (2) supplies the plain-language prompt wording.
    // (`supervisorAllowRules` is empty outside read-only; the `ask` rule follows
    // `approvalTools` wherever it's set, like its hook.)
    const allow = supervisorAllowRules(opts);
    // Claude's absolute path syntax is //Users/x/**, not /Users/x/** (which
    // is project-relative). Prefix the already-absolute dir with ONE extra slash.
    // https://code.claude.com/docs/en/permissions#read-and-edit
    for (const dir of writableDirs) {
      allow.push(`Write(/${dir}/**)`, `Edit(/${dir}/**)`);
    }
    const ask = [...new Set(opts.approvalTools ?? [])];
    if (allow.length || ask.length)
      settings.permissions = {
        ...settings.permissions,
        ...(allow.length ? { allow } : {}),
        ...(ask.length ? { ask } : {}),
      };
    if (preToolUse.length) settings.hooks = { PreToolUse: preToolUse };
    if (opts.onUserPrompt) {
      const command = shellJoin([opts.onUserPrompt.command, ...opts.onUserPrompt.args]);
      settings.hooks = {
        ...settings.hooks,
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
      };
    }
    if (opts.onTurnEnd) {
      const command = shellJoin([opts.onTurnEnd.command, ...opts.onTurnEnd.args]);
      // Esc interrupts don't fire Stop. Clear the turn flag on idle_prompt too,
      // so an interrupted supervisor doesn't look busy forever in the dashboard.
      settings.hooks = {
        ...settings.hooks,
        Stop: [{ hooks: [{ type: "command", command }] }],
        Notification: [{ matcher: "idle_prompt", hooks: [{ type: "command", command }] }],
      };
    }
    if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
    args.push(
      "--mcp-config",
      JSON.stringify({ mcpServers: mcpConfig(opts) }),
      "--strict-mcp-config",
    );
    // A non-empty prompt seeds the first turn; an empty one drops the user straight
    // into an idle TUI to type their own opener.
    if (opts.prompt.trim()) args.push(opts.prompt);
    return { command: opts.bin, args };
  }

  /**
   * One-time prep for the interactive TUI in `opts.cwd`, so nothing but Tack's own
   * human gates interrupts the session. Every supervisor session gets a brand-new,
   * Tack-owned `~/.tack/supervisor/ses_<id>` cwd, which claude has never seen:
   *
   *  - Workspace trust. Claude shows a "trust this folder?" dialog the first time it
   *    runs interactively in an unknown directory, so we set the same per-project
   *    flag the dialog would write (`~/.claude.json` ->
   *    `projects[cwd].hasTrustDialogAccepted`).
   *  - MCP auto-allow (read-only only). We write the mounted servers' allow rules to
   *    `<cwd>/.claude/settings.local.json` — exactly what a human picking "Yes, and
   *    don't ask again for … commands in <cwd>" on an MCP prompt would persist. This
   *    is layer (d) of the supervisor's auto-allow (see `interactiveCommand`): it's
   *    the shape claude's own UI produces, so it's the layer most likely to hold if
   *    the flag/hook/settings layers fall short again.
   *
   * Both writes merge into whatever is already there and never clobber a corrupt
   * file. Headless `-p` runs show neither dialog nor prompt, so only the
   * interactive path needs this.
   */
  prepareInteractive(opts: RunOptions): void {
    if (opts.onUserPrompt) {
      // The supervisor cwd is Tack-owned; refresh the command on resume as well.
      const commands = join(opts.cwd, ".claude", "commands");
      mkdirSync(commands, { recursive: true });
      writeFileSync(join(commands, "approve.md"), [
        "---",
        "description: Approve the supervisor's plan (use if the approval prompt didn't appear)",
        "---",
        "",
        APPROVE_PROMPT_MARKER,
        "The human has approved your plan via /approve. Proceed to spawn agents per the plan.",
        "",
      ].join("\n"));
    }
    recordWorkspaceTrust(opts.cwd);
    if (opts.readOnly) mergeLocalAllowRules(opts.cwd, supervisorAllowRules(opts));
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
    if (opts.resume && opts.sessionRef && opts.fork && supportsFork(opts.bin)) cmd.push("--fork-session");
    else if (!opts.resume && opts.sessionRef) cmd.push("--session-id", opts.sessionRef);
    for (const dir of opts.addDirs ?? []) cmd.push("--add-dir", dir);
    if (opts.contextFile) cmd.push("--append-system-prompt-file", opts.contextFile);
    // Always mount exactly the servers Tack provides (an empty set when none) and
    // pass --strict-mcp-config so a run never inherits the user's global MCP
    // config from the filesystem. Otherwise a bare read-only run (e.g. project
    // summarization) picks up whatever third-party servers — datadog, slack — the
    // user has configured and wanders into them.
    cmd.push("--mcp-config", JSON.stringify({ mcpServers: mcpConfig(opts) }), "--strict-mcp-config");
    // The prompt is fed via stdin (see run()), not as a positional arg.
    return cmd;
  }
}

/**
 * The server-wide permission rules (`mcp__<server>`, which covers every tool of
 * that server) that auto-allow the read-only supervisor's mounted MCP servers.
 * Empty outside read-only: agents run headless in auto mode and never prompt.
 *
 * The auto-allow is stated four ways because, in `--permission-mode plan`, layers
 * were observed to fall short one at a time: (a) `--allowedTools`, (b) a PreToolUse
 * `allow` hook, (c) a `permissions.allow` rule in the `--settings` blob, and (d) the
 * same rule pre-written to the session cwd's `.claude/settings.local.json` (see
 * `interactiveCommand` / `prepareInteractive`). Separately, the supervisor server
 * marks its genuinely read-only tools `readOnlyHint`. The interactive supervisor
 * now uses default mode with explicit edit denies, retaining these allow layers
 * so routine coordination tools stay prompt-free.
 * Gated tools are NOT carved out of these rules: their `permissions.ask` rule
 * outranks any allow rule (deny → ask → allow), and their `ask` hook supplies the
 * prompt wording.
 */
export function supervisorAllowRules(opts: RunOptions): string[] {
  if (!opts.readOnly) return [];
  return [...new Set((opts.mcpServers ?? []).map((s) => `mcp__${s.name}`))];
}

/** Sets `~/.claude.json` -> `projects[cwd].hasTrustDialogAccepted` (see
 * `prepareInteractive`). Leaves a corrupt/non-object file alone. */
function recordWorkspaceTrust(cwd: string): void {
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
  if (typeof config !== "object" || config === null || Array.isArray(config)) return;
  const projects = (config.projects ??= {});
  const entry = (projects[cwd] ??= {});
  if (entry.hasTrustDialogAccepted === true) return;
  entry.hasTrustDialogAccepted = true;
  writeFileSync(file, JSON.stringify(config, null, 2));
}

/**
 * Merges `rules` into `<cwd>/.claude/settings.local.json` -> `permissions.allow`,
 * deduped and preserving every existing key and entry. Bails without writing when
 * the file (or its `permissions` / `allow`) isn't the shape claude expects: it's
 * not ours to repair, and the other auto-allow layers still apply.
 */
function mergeLocalAllowRules(cwd: string, rules: readonly string[]): void {
  if (!rules.length) return;
  const dir = join(cwd, ".claude");
  const file = join(dir, "settings.local.json");
  let settings: any = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // corrupt — don't clobber
    }
  }
  const isObj = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(settings)) return;
  if (settings.permissions !== undefined && !isObj(settings.permissions)) return;
  const permissions = (settings.permissions ??= {});
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) return;
  const allow: unknown[] = (permissions.allow ??= []);
  const missing = rules.filter((r) => !allow.includes(r));
  if (!missing.length) return;
  allow.push(...missing);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * The interactive read-only supervisor's `permissions.deny` list. Without plan mode
 * (see `interactiveCommand`) nothing else stops the native edit tools, so they're
 * denied outright unless a writeGuard replaces the Edit/Write denies for page
 * drafts. ExitPlanMode/EnterPlanMode are denied too: plan approval goes
 * through Tack's own `planApprovalTool`, and letting the model enter plan mode would
 * bring back the native ExitPlanMode menu we're replacing.
 */
const INTERACTIVE_READONLY_DENY = ["Edit", "Write", "NotebookEdit", "ExitPlanMode", "EnterPlanMode"];

/**
 * The `--disallowedTools` list for a read-only run. We deliberately do NOT list
 * the native edit tools (Edit/Write/NotebookEdit) here: a headless read-only run is
 * in `--permission-mode plan`, which already blocks every file edit gracefully
 * (intercepting the call and steering the model back to planning), and the
 * interactive supervisor denies them via `INTERACTIVE_READONLY_DENY` in its
 * `--settings`. Hard-disallowing them instead surfaces a jarring "No such tool
 * available: Write. Write is disabled for this session" error to the human. So we
 * only disallow what neither covers: the subagent tools (named "Task" or "Agent"
 * across CLI versions), plus Bash when the caller forbids shelling out entirely.
 */
function readOnlyDisallowed(opts: RunOptions): string {
  const base = ["Task", "Agent"];
  if (opts.disallowShell) base.push("Bash");
  return base.join(",");
}

/**
 * The `mcpServers` map for claude's `--mcp-config` JSON, keyed by server name. We
 * emit `env` only when a server carries one so the common Tack-owned servers (which
 * don't) produce the same minimal `{command,args}` shape as before. Paired with
 * `--strict-mcp-config`, this is the complete set of servers a run sees — exactly
 * Tack's own plus whatever the user explicitly mounted (never the filesystem's).
 */
function mcpConfig(
  opts: RunOptions,
): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> =
    {};
  for (const s of opts.mcpServers ?? [])
    servers[s.name] = { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) };
  return servers;
}

/**
 * The PreToolUse matcher (a regex) that auto-allows every tool of MCP server
 * `server` except its approval tools. Claude names MCP tools
 * `mcp__<server>__<tool>`, so we anchor on that prefix — a different server's
 * same-named tool never matches — and carve the approval tools out with a
 * negative lookahead so they never receive an `allow` that could pre-empt their
 * `ask`. Approval tools belonging to other servers are irrelevant here and ignored.
 */
export function autoAllowMatcher(server: string, approvalTools: readonly string[]): string {
  const prefix = `mcp__${server}__`;
  const prefixRe = `^${escapeRegex(prefix)}`;
  const excluded = approvalTools
    .filter((t) => t.startsWith(prefix) && t.length > prefix.length)
    .map((t) => escapeRegex(t.slice(prefix.length)));
  if (!excluded.length) return `${prefixRe}.*`;
  return `${prefixRe}(?!(?:${excluded.join("|")})$).*`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// Older pins may lack forking; resuming the same ref still preserves context.
// Probe the CLI interface only, never its native conversation store.
const forkSupport = new Map<string, boolean>();
function supportsFork(bin: string): boolean {
  if (!forkSupport.has(bin)) {
    const help = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 5000 });
    forkSupport.set(bin, help.status === 0 && help.stdout.includes("--fork-session"));
  }
  return forkSupport.get(bin)!;
}

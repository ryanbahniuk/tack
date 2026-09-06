import type { AgentEvent, RunOptions, Runtime } from "./types";
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

  private buildCmd(opts: RunOptions): string[] {
    const m = opts.model;
    const cmd = [opts.bin, "-p", "--output-format", "stream-json", "--verbose", "--model", m.id];
    // Read-only supervisor vs autonomous worktree agent.
    if (opts.readOnly) {
      cmd.push("--permission-mode", "plan", "--permission-prompts", "none");
      cmd.push("--disallowedTools", "Edit,Write,NotebookEdit");
    } else {
      cmd.push(...PERMISSION_ARGS);
    }
    if (m.effort) cmd.push("--effort", m.effort);
    if (opts.resume && opts.sessionRef) cmd.push("--resume", opts.sessionRef);
    else if (opts.sessionRef) cmd.push("--session-id", opts.sessionRef);
    for (const dir of opts.addDirs ?? []) cmd.push("--add-dir", dir);
    if (opts.contextFile) cmd.push("--append-system-prompt-file", opts.contextFile);
    if (opts.mcpServers?.length) {
      const mcpServers: Record<string, { command: string; args: string[] }> = {};
      for (const s of opts.mcpServers) mcpServers[s.name] = { command: s.command, args: s.args };
      cmd.push("--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config");
    }
    // The prompt is fed via stdin (see run()), not as a positional arg.
    return cmd;
  }
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

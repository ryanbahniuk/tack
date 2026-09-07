import pc from "picocolors";
import type { AgentEvent } from "../runtimes";
import type { Spinner } from "./spinner";

/**
 * A one-line, human-readable summary of a tool call's arguments, so the live
 * stream reads as "· Bash git log --oneline" instead of a bare "· Bash" (which
 * is noise when the supervisor fires off a dozen shell probes in a row). Returns
 * undefined when there's nothing worth showing beyond the tool name.
 */
export function describeTool(tool: string, input: unknown): string | undefined {
  const arg = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  // The common shells and file tools carry one obvious argument each.
  const primary =
    str(arg.command) ?? // Bash
    str(arg.file_path) ?? // Read/Write/Edit
    str(arg.path) ??
    str(arg.pattern) ?? // Grep/Glob
    str(arg.url); // WebFetch

  // Tack's own supervisor tools: name the target so delegation is legible.
  if (tool === "spawn_agent") {
    const prompt = str(arg.prompt);
    return [str(arg.project), prompt && `"${firstLine(prompt)}"`].filter(Boolean).join(" ") || undefined;
  }
  if (tool === "read_agent_output") return str(arg.agentId);

  return primary ? firstLine(primary) : undefined;
}

/** First line of a value, trimmed and clipped so it never wraps the terminal. */
function firstLine(s: string, max = 80): string {
  const line = s.split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A mutable holder so a caller can hand its spinner to the renderer and have it
 * cleared (and forgotten) the moment the first visible event streams in. */
export interface Pending {
  spinner?: Spinner;
}

/**
 * Renders one streamed supervisor/agent event to the terminal. On the first
 * visible event it stops any pending spinner so the "working…" indicator gives
 * way cleanly to real content.
 */
export function renderStreamEvent(ev: AgentEvent, pending: Pending): void {
  const takeOver = () => {
    pending.spinner?.stop();
    pending.spinner = undefined;
  };
  switch (ev.type) {
    case "text":
      takeOver();
      process.stdout.write(ev.text);
      break;
    case "tool_call": {
      takeOver();
      const detail = describeTool(ev.tool, ev.input);
      console.log(pc.dim(`\n· ${ev.tool}${detail ? ` ${detail}` : ""}`));
      break;
    }
    case "cost":
      takeOver();
      console.log(pc.dim(`\n[cost ${ev.usd.toFixed(4)} ${ev.source}]`));
      break;
    case "error":
      takeOver();
      console.error(pc.red(`\n! ${ev.message}`));
      break;
  }
}

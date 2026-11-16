export const REVIEW_MARKER = "<!-- tack:review -->";
export const PR_FIX_MARKER = "<!-- tack:pr-fix -->";
export type SupervisorCommand = { kind: "review"; agentId?: string; persona?: string; prompt?: string } | { kind: "pr-fix"; value?: string };
export function parseSupervisorCommand(input: string): SupervisorCommand | null {
  const trimmed = input.trim();
  let kind: "review" | "pr-fix";
  let args: string;
  const match = /^\/(review|pr-fix)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match) { kind = match[1] as typeof kind; args = match[2] ?? ""; }
  else {
    const lines = input.split(/\r?\n/);
    const index = lines.findIndex(line => line.trim() === REVIEW_MARKER || line.trim() === PR_FIX_MARKER);
    if (index < 0) return null;
    kind = lines[index]!.trim() === REVIEW_MARKER ? "review" : "pr-fix";
    args = lines.slice(index + 1).join(" ").trim();
  }
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  return kind === "review" ? { kind, agentId: parts[0], persona: parts[1], prompt: parts.slice(2).join(" ") || undefined } : { kind, value: parts.join(" ") || undefined };
}

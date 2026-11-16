import { readFileSync } from "node:fs";

/** Trailing decoration that can follow a question mark without changing what the
 * sentence is: whitespace, markdown emphasis/inline code, and closing quotes or
 * brackets. Sentence punctuation (`.`, `!`, `:`) is deliberately NOT stripped —
 * it ends a non-question. */
const TRAILING_DECORATION = /[\s*_`"'”’»)\]}>]+$/u;

const FENCE_LINE = /^[ \t]*(```|~~~)/;

/** Drops fenced code blocks at the very end of the text, line by line: the last
 * line closes a fence, so remove back to (and including) its opening line. An
 * unmatched trailing fence just drops that one line. */
function stripTrailingFences(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  while (lines.length && FENCE_LINE.test(lines[lines.length - 1]!)) {
    let open = lines.length - 2;
    while (open >= 0 && !FENCE_LINE.test(lines[open]!)) open--;
    lines.length = open >= 0 ? open : lines.length - 1;
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  }
  return lines.join("\n");
}

/**
 * Whether a supervisor's final message ends by asking the human something — the
 * plain-text "◆ needs input" signal for attended sessions (see `__turn-end`).
 *
 * Deliberately conservative and predictable: a trailing code block is dropped
 * (it's material being shown, not the question), trailing emphasis / quotes /
 * brackets are ignored, and what's left must end in `?` (or the full-width `？`).
 * A question earlier in the message followed by more prose does not count.
 */
export function endsWithQuestion(text: string): boolean {
  // Drop trailing fenced blocks (possibly several) so code ending in `?` (a
  // ternary, a regex) never reads as a question.
  const s = stripTrailingFences(text).replace(TRAILING_DECORATION, "");
  return s.endsWith("?") || s.endsWith("？");
}

/** The text blocks of a Claude message `content` (string or block array). */
function messageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return parts.length ? parts.join("\n") : null;
}

/**
 * The last assistant text in a Claude JSONL transcript, or null when there is
 * none / the file can't be read. Assistant turns are entries with
 * `type: "assistant"` whose `message.content` holds `{type: "text"}` blocks;
 * tool-use-only entries are skipped. Malformed lines are ignored.
 */
export function lastAssistantText(transcriptPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "assistant") continue;
      const text = messageText(entry.message?.content);
      if (text?.trim()) return text;
    } catch {
      /* skip malformed lines */
    }
  }
  return null;
}

/**
 * The final assistant message for a Claude `Stop` hook payload: the payload's own
 * `last_assistant_message` when present, else the transcript at `transcript_path`.
 */
export function finalAssistantText(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const { last_assistant_message: last, transcript_path: path } = input as Record<string, unknown>;
  if (typeof last === "string") return last;
  if (typeof path === "string" && path) return lastAssistantText(path);
  return null;
}

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The editor command to launch, honoring $VISUAL then $EDITOR, falling back to
 * a sensible default per platform. Split on whitespace so values like
 * `code --wait` carry their flags through. */
export function editorCommand(env: NodeJS.ProcessEnv = process.env, hasVim: () => boolean = vimOnPath): string[] {
  const raw = env.VISUAL || env.EDITOR;
  if (raw && raw.trim()) return raw.trim().split(/\s+/);
  if (process.platform === "win32") return ["notepad"];
  // Prefer vim: on many systems `vi` is a minimal build (no directory browsing),
  // which matters now that worktree editing opens the editor on `.`.
  return hasVim() ? ["vim"] : ["vi"];
}

/** Whether `vim` resolves on PATH, checked through the shell's own lookup. */
function vimOnPath(): boolean {
  return spawnSync("sh", ["-c", "command -v vim"], { stdio: "ignore" }).status === 0;
}

/**
 * Opens the user's editor directly on an existing file (not a temp copy), waiting
 * for them to save and close. Unlike `captureViaEditor`, this edits the file in
 * place — used for `tack config edit`. Throws if no editor could be launched.
 */
export function openInEditor(path: string): void {
  const { command, args } = editorInvocation(path);
  execFileSync(command, args, { stdio: "inherit" });
}

/** Shared by synchronous CLI launches and the dashboard's asynchronous TTY handoff. */
export function editorInvocation(target: string): { command: string; args: string[] } {
  const [command, ...args] = editorCommand();
  return { command: command!, args: [...args, target] };
}

/** Root the editor at the worktree so directory browsing and editor shell commands
 * operate on the same tree the human selected, regardless of Tack's own cwd. */
export function openWorktreeInEditor(path: string): void {
  const { command, args } = editorInvocation(".");
  execFileSync(command, args, { cwd: path, stdio: "inherit" });
}

/** A whole line that is nothing but an HTML comment, e.g. `<!-- help -->`. We use
 * these as git-style comment lines: they render invisibly in Markdown (so `#`
 * stays a heading) and get stripped from the captured body. */
const COMMENT_LINE = /^\s*<!--.*-->\s*$/;

/**
 * Opens the user's editor on a temp Markdown file seeded with `template`, waits
 * for them to save and close, and returns the edited text with any full-line
 * HTML comments stripped (git-style, but Markdown-safe so `#` headings survive).
 * Returns the trimmed body, or "" if they saved nothing.
 *
 * Throws if no editor could be launched (e.g. a non-interactive shell with no
 * $EDITOR), so callers can fall back to requiring an inline message.
 */
export function captureViaEditor(template = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "tack-"));
  const file = join(dir, "PROMPT.md");
  writeFileSync(file, template, "utf8");
  try {
    const { command, args } = editorInvocation(file);
    execFileSync(command, args, { stdio: "inherit" });
    const raw = readFileSync(file, "utf8");
    return raw
      .split("\n")
      .filter((line) => !COMMENT_LINE.test(line))
      .join("\n")
      .trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

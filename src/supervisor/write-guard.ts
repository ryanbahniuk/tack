import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

type Canonicalize = (path: string, directory?: boolean) => string;
export type WriteDecision = {
  permissionDecision: "allow" | "deny";
  permissionDecisionReason: string;
};

/** Resolve existing ancestors, including /tmp and /var aliases on macOS. Walk
 * before collapsing `..`: a symlink followed by `..` refers to the target's parent,
 * not the link's parent. Missing tails are fine for new pages; dangling links and
 * all errors other than ENOENT fail closed. Allowed roots must already exist. */
export function canonicalWritePath(path: string, directory = false): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid absolute path");
  if (directory) {
    const real = realpathSync(path);
    if (!statSync(real).isDirectory()) throw new Error("Allowed root is not a directory");
    return real;
  }
  let current: string = sep;
  for (const segment of path.split(sep)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    try {
      current = realpathSync(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // realpath also reports ENOENT for a dangling link. Never treat that as a
      // harmless new file: its eventual target may be outside the writable root.
      try {
        lstatSync(next);
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
        current = next;
        continue;
      }
      throw new Error("Dangling symlink");
    }
  }
  return current;
}

/** Pure policy given a path resolver, kept separate from stdin/stdout and filesystem
 * access so hook failures cannot accidentally become an approval. */
export function decideWrite(input: unknown, allowedDirs: string[], canonicalize: Canonicalize): WriteDecision {
  const deny: WriteDecision = {
    permissionDecision: "deny",
    permissionDecisionReason: `The only writable directories are ${allowedDirs.join(", ") || "(none)"}; they are for publishable pages only, never plans, notes, contracts or code. Writes elsewhere are denied.`,
  };
  try {
    if (!input || typeof input !== "object" || !allowedDirs.length) return deny;
    const { cwd, tool_input } = input as { cwd?: unknown; tool_input?: unknown };
    if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return deny;
    if (!tool_input || typeof tool_input !== "object") return deny;
    const { file_path, notebook_path } = tool_input as { file_path?: unknown; notebook_path?: unknown };
    const path = file_path !== undefined ? file_path : notebook_path;
    if (typeof path !== "string" || !path.trim() || path.includes("\0")) return deny;
    // Do not use resolve/join here: both erase symlink/.. traversal before realpath.
    const target = canonicalize(isAbsolute(path) ? path : `${cwd}${sep}${path}`);
    const roots = allowedDirs.map((dir) => canonicalize(dir, true));
    if (roots.some((root) => {
      const tail = relative(root, target);
      return tail !== "" && tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
    })) return { permissionDecision: "allow", permissionDecisionReason: "Inside the publishable pages directory." };
  } catch {
    // Invalid paths, inaccessible ancestors and invalid allowed roots all deny.
  }
  return deny;
}

/** Parse hook stdin without letting malformed JSON escape to the CLI's stdout. */
export function writeGuardDecision(raw: string, allowedDirs: string[]): WriteDecision {
  let input: unknown;
  try { input = JSON.parse(raw); } catch { /* decideWrite denies undefined */ }
  return decideWrite(input, allowedDirs, canonicalWritePath);
}

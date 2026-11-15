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
 * all errors other than ENOENT fail closed. Configured roots must already exist;
 * the session scratchpad uses the same missing-tail walk as a new page. */
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
export function decideWrite(input: unknown, allowedDirs: string[], canonicalize: Canonicalize, scratchpadRoot?: string): WriteDecision {
  const deny: WriteDecision = {
    permissionDecision: "deny",
    permissionDecisionReason: `Write the page under ${allowedDirs.join(", ") || "(no configured directory)"} and publish again. These directories are for publishable pages only, never plans, notes, contracts or code. Writes elsewhere are denied unless inside this session's Claude scratchpad.`,
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
    if (scratchpadRoot) roots.push(canonicalize(scratchpadRoot));
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
export function writeGuardDecision(raw: string, allowedDirs: string[], opts: {
  env?: Pick<NodeJS.ProcessEnv, "CLAUDE_CODE_TMPDIR">;
  uid?: number | null;
} = {}): WriteDecision {
  let input: unknown;
  try {
    input = JSON.parse(raw);
    const { cwd, session_id } = (input ?? {}) as { cwd?: unknown; session_id?: unknown };
    const uid = opts.uid === undefined ? process.getuid?.() : opts.uid;
    if (uid != null && typeof cwd === "string" && isAbsolute(cwd) && !cwd.includes("\0")
      && typeof session_id === "string" && /^[A-Za-z0-9-]+$/.test(session_id)) {
      const tmpRoot = canonicalWritePath((opts.env ?? process.env).CLAUDE_CODE_TMPDIR || "/tmp", true);
      const scratchpadRoot = join(tmpRoot, `claude-${uid}`, cwd.replace(/[^A-Za-z0-9]/g, "-"), session_id, "scratchpad");
      return decideWrite(input, allowedDirs, canonicalWritePath, scratchpadRoot);
    }
    return decideWrite(input, allowedDirs, canonicalWritePath);
  } catch {
    // Parsing and scratchpad derivation failures must never grant a write.
    return decideWrite(undefined, allowedDirs, canonicalWritePath);
  }
}

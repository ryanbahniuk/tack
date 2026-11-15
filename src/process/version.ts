import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Exposed separately so hashing can be tested without resetting the process cache. */
export function codeVersionForEntry(entry: string, execPath = process.execPath): string {
  try {
    if (entry.startsWith("/$bunfs/")) {
      const stat = statSync(execPath);
      return `binary:${stat.size}:${stat.mtimeMs}`;
    }
    let root = dirname(realpathSync(entry));
    while (!existsSync(join(root, "package.json")) || !existsSync(join(root, "src")) || !existsSync(join(root, "bin"))) {
      const parent = dirname(root);
      if (parent === root) return "unknown";
      root = parent;
    }
    const files: string[] = [join(root, "package.json")];
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(item.name)) files.push(path);
      }
    };
    walk(join(root, "bin"));
    walk(join(root, "src"));
    const lock = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"].find(name => existsSync(join(root, name)));
    if (!lock) return "unknown";
    files.push(join(root, lock));
    const hash = createHash("sha256");
    for (const file of files.sort()) {
      const content = readFileSync(file);
      hash.update(`${relative(root, file)}\0${content.length}\0`);
      hash.update(content);
    }
    return hash.digest("hex");
  } catch {
    return "unknown";
  }
}
let cached: string | undefined;
/** Identity of the code loaded by this process, independent of the caller's cwd. */
export function currentCodeVersion(): string {
  return cached ??= codeVersionForEntry(Bun.main);
}

/** Missing stamps predate version tracking; unknown identities never force a restart. */
export function isCodeVersionStale(version: string | null, current = currentCodeVersion()): boolean {
  return current !== "unknown" && version !== "unknown" && version !== current;
}

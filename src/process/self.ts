/**
 * How to re-invoke *this* program, whether we're a compiled standalone binary or
 * running from source under `bun`. In a compiled binary `Bun.main` is a virtual
 * `/$bunfs/…` path and `execPath` is the real executable; from source `execPath`
 * is `bun` and the entry script must be passed as the first arg.
 */
export function selfInvocation(): { command: string; args: string[] } {
  const compiled = Bun.main.startsWith("/$bunfs/");
  return compiled
    ? { command: process.execPath, args: [] }
    : { command: process.execPath, args: [Bun.main] };
}

/** Builds a full `{command, args}` that runs this program with the given args. */
export function selfCommand(extra: string[]): { command: string; args: string[] } {
  const base = selfInvocation();
  return { command: base.command, args: [...base.args, ...extra] };
}

/** True if a process with this pid currently exists. */
export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

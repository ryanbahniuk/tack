/** Runs `cmd`, writing `text` to its stdin; resolves true only on a clean exit.
 *  Must not throw: a missing binary is just "this tool isn't available". */
export type ClipboardSpawner = (cmd: string[], text: string) => Promise<boolean>;

export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  spawn?: ClipboardSpawner;
}

/** Candidate clipboard writers in preference order. Linux has no single standard
 *  tool, so try Wayland first, then the two common X11 ones. */
export function clipboardCommands(platform: NodeJS.Platform): string[][] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip"]];
  return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

const bunSpawn: ClipboardSpawner = async (cmd, text) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    await proc.stdin.end();
    return (await proc.exited) === 0;
  } catch {
    return false; // ENOENT and friends: tool not installed
  }
};

/** Copies `text` to the system clipboard using the first tool that succeeds.
 *  Resolves false (never rejects) when none is available, so the caller can fall
 *  back to showing the text for a manual copy. */
export async function copyToClipboard(text: string, deps: ClipboardDeps = {}): Promise<boolean> {
  const spawn = deps.spawn ?? bunSpawn;
  for (const cmd of clipboardCommands(deps.platform ?? process.platform)) {
    try {
      if (await spawn(cmd, text)) return true;
    } catch {
      /* an injected spawner misbehaving still counts as "not this tool" */
    }
  }
  return false;
}

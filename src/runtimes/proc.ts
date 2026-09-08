import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";

export interface SpawnResult {
  /** Yields one parsed JSON object per newline-delimited stdout line. Non-JSON
   * lines are teed to the log but skipped. */
  lines: AsyncGenerator<unknown>;
}

/**
 * Spawns a streaming JSONL subprocess (a runtime CLI in `--json` / stream-json
 * mode), tees raw stdout+stderr to `logPath`, and yields parsed JSON objects.
 * The caller maps those to normalized `AgentEvent`s. Uses Bun.spawn so we get a
 * real streaming stdout without buffering the whole run.
 */
export async function* streamJson(
  cmd: string[],
  opts: {
    cwd: string;
    logPath: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    /** Fed to the child's stdin, then closed. Used to pass the prompt to CLIs
     * (e.g. Claude Code) that read it from stdin when stdin isn't a TTY. */
    stdin?: string;
  },
): AsyncGenerator<unknown, number> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const logFd = openSync(opts.logPath, "a");
  appendFileSync(logFd, `\n$ ${cmd.join(" ")}\n`);
  if (opts.stdin !== undefined) appendFileSync(logFd, `< ${opts.stdin}\n`);

  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    signal: opts.signal,
  });

  // Drain stderr into the log without blocking the stdout reader.
  const stderrDone = (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      appendFileSync(logFd, Buffer.from(chunk).toString("utf8"));
    }
  })();

  try {
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        appendFileSync(logFd, line + "\n");
        try {
          yield JSON.parse(line);
        } catch {
          // Non-JSON chatter — already logged, skip.
        }
      }
    }
    if (buf.trim()) {
      appendFileSync(logFd, buf + "\n");
      try {
        yield JSON.parse(buf);
      } catch {
        /* ignore */
      }
    }
    const code = await proc.exited;
    await stderrDone;
    // Returned as the generator's completion value so callers can distinguish a
    // clean run from a crash — a `for await` loop simply ignores it.
    return code;
  } finally {
    closeSync(logFd);
  }
}

import pc from "picocolors";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

/** A running spinner that can be resolved to a success or failure line. */
export interface Spinner {
  /** Clears the animation and prints the label followed by a green status. */
  succeed(status: string): void;
  /** Clears the animation and prints the label followed by a red status. */
  fail(status: string): void;
  /** Stops the animation and clears the line, printing nothing. Use when real
   * output is about to take over (e.g. the first streamed token). Idempotent. */
  stop(): void;
}

/**
 * Starts an in-place spinner rendering `{frame} {label}…` on the current line.
 * On a TTY the braille frame animates on an interval; otherwise the label is
 * printed once with no animation (so piped/CI output stays clean). Call
 * `succeed`/`fail` to stop the animation and finalize the line.
 */
export function startSpinner(label: string): Spinner {
  const tty = process.stdout.isTTY === true;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const render = () => {
    process.stdout.write(`\r${pc.cyan(FRAMES[frame])} ${pc.dim(`${label}…`)}`);
    frame = (frame + 1) % FRAMES.length;
  };

  if (tty) {
    process.stdout.write("\x1b[?25l"); // hide cursor
    render();
    timer = setInterval(render, INTERVAL_MS);
  } else {
    process.stdout.write(pc.dim(`${label}… `));
  }

  let stopped = false;
  const clear = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (tty) {
      process.stdout.write("\r\x1b[K"); // clear the animated line
      process.stdout.write("\x1b[?25h"); // restore cursor
    }
  };

  const finish = (status: string) => {
    if (stopped) return;
    clear();
    if (tty) process.stdout.write(pc.dim(`${label}… `));
    console.log(status);
  };

  return {
    succeed: (status) => finish(pc.green(status)),
    fail: (status) => finish(pc.red(status)),
    stop: clear,
  };
}

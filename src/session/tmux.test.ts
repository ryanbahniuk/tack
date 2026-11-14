import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfCommand } from "../process/self";
import { statusHintText, TMUX_NEW_SESSION_KEY, tmuxNewSessionBindingArgs, TMUX_TACK_BUG_KEY, tmuxTackBugBindingArgs } from "./tmux";

describe("tmux status hint", () => {
  test("shows detach, new session, and resume outside tmux", () => {
    expect(statusHintText("ses_abcd", "C-b", false)).toBe(
      " #[bold]tack#[default] ses_abcd  ·  detach: C-b d  ·  new session: C-b N  ·  tack bug: C-b B  ·  resume: tack session resume ses_abcd ",
    );
  });

  test("doubles a custom prefix for both shortcuts inside tmux", () => {
    expect(statusHintText("ses_abcd", "C-a", true)).toBe(
      " #[bold]tack#[default] ses_abcd  ·  detach: C-a C-a d  ·  new session: C-a C-a N  ·  tack bug: C-a C-a B  ·  resume: tack session resume ses_abcd ",
    );
  });
});

describe("tmux new-session binding", () => {
  test("uses capital N and targets Tack's dedicated server", () => {
    expect(TMUX_NEW_SESSION_KEY).toBe("N");
    expect(tmuxNewSessionBindingArgs({ command: "/usr/bin/tack", args: ["session", "create"] })).toEqual([
      "-L", "tack", "bind-key", "N", "detach-client", "-E", "'/usr/bin/tack' 'session' 'create'",
    ]);
  });

  test("quotes executable and script paths containing spaces and single quotes", () => {
    expect(tmuxNewSessionBindingArgs({
      command: "/opt/Ryan's tools/bun",
      args: ["/work/Ryan's project/bin/tack.ts", "session", "create"],
    })).toEqual([
      "-L", "tack", "bind-key", "N", "detach-client", "-E",
      "'/opt/Ryan'\\''s tools/bun' '/work/Ryan'\\''s project/bin/tack.ts' 'session' 'create'",
    ]);
  });

  test("accepts the current self command without needing a tmux server", () => {
    const invocation = selfCommand(["session", "create"]);
    const argv = tmuxNewSessionBindingArgs(invocation);
    const quoted = (arg: string) => "'" + arg.split("'").join("'\\''") + "'";
    expect(argv[6]).toBe([invocation.command, ...invocation.args].map(quoted).join(" "));
    expect(argv[6]).toEndWith("'session' 'create'");
  });
});


test("bug binding is server-wide and reads the attach client's session through the CLI", () => {
  expect(TMUX_TACK_BUG_KEY).toBe("B");
  expect(tmuxTackBugBindingArgs({ command: "/Ryan's tools/tack", args: ["session", "create", "--tack-bug-from-env"] })).toEqual([
    "-L", "tack", "bind-key", "B", "detach-client", "-E",
    "'/Ryan'\\''s tools/tack' 'session' 'create' '--tack-bug-from-env'",
  ]);
});


test("pane capture retries an explicit session pane target on Tack's socket", () => {
  const dir = mkdtempSync(join(tmpdir(), "tack-capture-test-"));
  try {
    const command = join(dir, "tmux");
    const log = join(dir, "argv");
    writeFileSync(command, `#!/bin/sh
printf '%s\\n' "$@" >> "$TACK_CAPTURE_ARGS"
for arg do target="$arg"; done
case "$target" in
  *:) echo "source pane evidence" ;;
  *) exit 1 ;;
esac
`);
    chmodSync(command, 0o755);
    const result = Bun.spawnSync([process.execPath, "-e", `import { tmuxCapturePane } from ${JSON.stringify(join(import.meta.dir, "tmux.ts"))}; process.stdout.write(tmuxCapturePane("ses_source", 75));`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TACK_HOME: dir, TACK_CAPTURE_ARGS: log },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("source pane evidence\n");
    const argv = readFileSync(log, "utf8").trim().split("\n");
    expect(argv).toEqual([
      "-L", "tack", "capture-pane", "-p", "-J", "-S", "-75", "-t", "=tack-ses_source",
      "-L", "tack", "capture-pane", "-p", "-J", "-S", "-75", "-t", "=tack-ses_source:",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

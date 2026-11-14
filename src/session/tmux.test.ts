import { describe, expect, test } from "bun:test";
import { selfCommand } from "../process/self";
import { statusHintText, TMUX_NEW_SESSION_KEY, tmuxNewSessionBindingArgs } from "./tmux";

describe("tmux status hint", () => {
  test("shows detach, new session, and resume outside tmux", () => {
    expect(statusHintText("ses_abcd", "C-b", false)).toBe(
      " #[bold]tack#[default] ses_abcd  ·  detach: C-b d  ·  new session: C-b N  ·  resume: tack session resume ses_abcd ",
    );
  });

  test("doubles a custom prefix for both shortcuts inside tmux", () => {
    expect(statusHintText("ses_abcd", "C-a", true)).toBe(
      " #[bold]tack#[default] ses_abcd  ·  detach: C-a C-a d  ·  new session: C-a C-a N  ·  resume: tack session resume ses_abcd ",
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

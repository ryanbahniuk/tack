import { spawnSync } from "node:child_process";
import { selfCommand } from "../process/self";
import type { InteractiveSpec } from "../runtimes/types";

/**
 * The interactive supervisor TUI is an ordinary foreground terminal process, so a
 * plan-approval prompt (or any live state) dies the moment you leave it — a plain
 * `--resume` reloads the transcript but lands you in a fresh turn, not back on the
 * pending prompt. To leave a session parked and return to it exactly as it was, we
 * run the TUI inside a tmux session Tack owns (`tack-<sessionId>`): detaching keeps
 * claude alive and still waiting, and `tack session attach` drops you back in.
 * Prefix N parks the current session and opens a new one: `detach-client -E`
 * replaces the attach client with `tack session create`, so its caller owns the
 * normal create lifecycle (DB row, tmux session, cost recovery, outcome report).
 *
 * tmux is optional. Without it the TUI still runs (spawned directly), you just
 * can't leave and come back.
 */

/**
 * Tack runs its supervisor sessions on a dedicated tmux server (its own socket)
 * rather than the user's default server. Sharing the default server means a user
 * who launched Tack from inside their own tmux ends up with two clients on one
 * server — a fragile arrangement where the inner attach gets spuriously detached
 * (e.g. an arrow key at a plan prompt bumps them back to the dashboard). A private
 * socket isolates Tack's sessions entirely: no cross-client contention, and Tack's
 * status-bar tweaks never touch the user's own sessions. Everything that talks to a
 * Tack session must go through `tmuxArgs` so it targets this server, not the default.
 */
const TMUX_SOCKET = "tack";

/** Capital N in the prefix table opens a new session on Tack's private server. */
export const TMUX_NEW_SESSION_KEY = "N";

/** argv (after the `tmux` binary) for a command on Tack's dedicated server: the
 * `-L <socket>` selector followed by the rest of the command. */
function tmuxArgs(...rest: string[]): string[] {
  return ["-L", TMUX_SOCKET, ...rest];
}

/** Build the binding from `selfCommand(["session", "create"])`. tmux passes -E
 * through sh -c, so quote every argument, including executable and script paths.
 * Replacing the client preserves the caller's normal child lifecycle while the
 * original supervisor stays parked in its existing tmux session. */
export function tmuxNewSessionBindingArgs(invocation: ReturnType<typeof selfCommand>): string[] {
  const command = [invocation.command, ...invocation.args]
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
  return tmuxArgs("bind-key", TMUX_NEW_SESSION_KEY, "detach-client", "-E", command);
}

/** Install or refresh the server-wide binding. Tack owns this server, so rebinding
 * is idempotent and never changes the user's own tmux keys. Best-effort so a
 * missing server or unsupported tmux option doesn't prevent attaching. */
export function tmuxBindNewSessionKey(): void {
  try {
    spawnSync("tmux", tmuxNewSessionBindingArgs(selfCommand(["session", "create"])), { stdio: "ignore" });
  } catch {
    /* tmux absent or server unavailable */
  }
}

/** tmux session name for a Tack supervisor session. Session ids are `ses_<hex>` —
 * free of the `.`/`:` that tmux reserves for window/pane targets — so they're safe
 * to use verbatim. */
export function tmuxSessionName(sessionId: string): string {
  return `tack-${sessionId}`;
}

/** Whether the `tmux` client is on PATH. */
export function tmuxAvailable(): boolean {
  try {
    return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Whether a tmux session with exactly this name currently exists. The `=` prefix
 * forces an exact-name match — tmux target lookups are prefix-based otherwise, so
 * `tack-ses_ab` would spuriously match `tack-ses_abcd`. */
export function tmuxHasSession(name: string): boolean {
  try {
    return spawnSync("tmux", tmuxArgs("has-session", "-t", `=${name}`), { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Ensure a detached tmux session exists for `sessionId` running `spec`, and paint
 * its status bar with detach, new-session and resume hints. Returns false if tmux
 * fails to create it (so the caller can fall back to a direct spawn). Idempotent: an existing
 * session is left running as-is — its status was set at creation.
 *
 * We create detached and attach separately (rather than one `new-session` that
 * attaches) because `new-session`'s trailing shell-command greedily swallows any
 * following `;`-chained `set-option` commands — there's no `--` terminator. Spec env
 * is applied with an `env` prefix on the pane command rather than tmux's `-e` (which
 * older tmux lacks, and which wouldn't reach a pane spawned by a running server).
 */
export function tmuxEnsureSession(sessionId: string, cwd: string, spec: InteractiveSpec): boolean {
  const name = tmuxSessionName(sessionId);
  if (tmuxHasSession(name)) return true;
  const envPrefix = spec.env
    ? ["env", ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`)]
    : [];
  const created = spawnSync(
    "tmux",
    tmuxArgs("new-session", "-d", "-s", name, "-c", cwd, ...envPrefix, spec.command, ...spec.args),
    { stdio: "ignore" },
  );
  if (created.status !== 0) return false;
  tmuxBindNewSessionKey();
  tmuxSetStatusHint(sessionId);
  return true;
}

/**
 * Kill the tmux session backing `sessionId`, if one exists. Idempotent and
 * best-effort: a missing session or absent tmux client is a no-op. Called when a
 * Tack session is archived or deleted, so no orphaned `tack-<id>` session is left
 * running in the background. The `=` prefix forces an exact-name match.
 */
export function tmuxKillSession(sessionId: string): void {
  const name = tmuxSessionName(sessionId);
  try {
    spawnSync("tmux", tmuxArgs("kill-session", "-t", `=${name}`), { stdio: "ignore" });
  } catch {
    /* tmux absent or session already gone */
  }
}

/** Whether we're running inside a tmux session already. When true, attaching to one
 * of our sessions nests tmux, so the prefix must be pressed twice to reach the inner
 * session — which the shortcut hints reflect. */
export function insideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

/**
 * Build the status hint for the current attach context. Nested tmux needs the
 * prefix doubled for both shortcuts to reach Tack's inner session. */
export function statusHintText(sessionId: string, prefix: string, nested: boolean): string {
  const keys = nested ? `${prefix} ${prefix}` : prefix;
  return ` #[bold]tack#[default] ${sessionId}  ·  detach: ${keys} d  ·  new session: ${keys} ${TMUX_NEW_SESSION_KEY}  ·  resume: tack session resume ${sessionId} `;
}

/**
 * Paint a session's status bar with detach, new-session and resume hints for the
 * current attach context: nested (inside tmux) needs the prefix doubled to reach the inner
 * session. Session-scoped (`-t <name>`), so it never touches the user's other tmux
 * sessions. Re-applied at each attach, since the same session can be reattached from
 * inside or outside tmux on different occasions. Refresh the binding too, so
 * rejoining a server started by an older Tack installs the shortcut.
 */
export function tmuxSetStatusHint(sessionId: string): void {
  tmuxBindNewSessionKey();
  const name = tmuxSessionName(sessionId);
  const prefix = tmuxPrefixKey();
  const hint = statusHintText(sessionId, prefix, insideTmux());
  const set = (option: string, value: string) =>
    spawnSync("tmux", tmuxArgs("set-option", "-t", name, option, value), { stdio: "ignore" });
  set("status", "on");
  set("status-left-length", "200");
  set("status-left", hint);
  // Clear the default right side (clock/host) so the hint isn't crowded.
  set("status-right", "");
}

/** The effective tmux prefix key (e.g. `C-b`), read from the server so a remapped
 * prefix shows correctly in the hint. Falls back to the tmux default if unreadable. */
export function tmuxPrefixKey(): string {
  try {
    const out = spawnSync("tmux", tmuxArgs("show-options", "-gv", "prefix"), { encoding: "utf8" });
    const key = out.status === 0 ? out.stdout.trim() : "";
    return key || "C-b";
  } catch {
    return "C-b";
  }
}

/** argv (after `tmux`) to attach to an existing session by exact name, on Tack's
 * dedicated server. */
export function tmuxAttachArgs(name: string): string[] {
  return tmuxArgs("attach-session", "-t", `=${name}`);
}

/**
 * A copy of `base` (defaulting to the current env) with tmux's client vars removed,
 * so an attach launched from *inside* an existing tmux session doesn't refuse to
 * nest ("sessions should be nested with care, unset $TMUX to force"). A no-op when
 * not already inside tmux. Used for the attach client, not the detached create
 * (which nests fine).
 */
export function tmuxClientEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

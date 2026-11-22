import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOGS_DIR } from "../paths";
import { clearSessionAwaitingInputFor, setSessionAwaitingInputIfFree } from "../db";

/** Awaiting reason for a native runtime permission dialog ("Do you want to proceed?"). */
export const PERMISSION_REASON = "permission";

/**
 * Per-session file that exists only while a permission dialog may be pending. The
 * all-tools PostToolUse clear checks it from `sh` so an ordinary tool call never
 * starts a full Tack process.
 */
export function permissionMarkerPath(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  return join(LOGS_DIR, sessionId, "permission-pending");
}

/** Flags the session awaiting a permission decision, never overwriting a plan or question. */
export function markPermissionPrompt(sessionId: string): void {
  const marker = permissionMarkerPath(sessionId);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "");
  setSessionAwaitingInputIfFree(sessionId, PERMISSION_REASON);
}

export function clearPermissionPrompt(sessionId: string): void {
  rmSync(permissionMarkerPath(sessionId), { force: true });
  clearSessionAwaitingInputFor(sessionId, PERMISSION_REASON);
}

/** Wraps `inner` so it runs only while the session's permission marker exists. */
export function guardOnPermissionMarker(
  sessionId: string,
  inner: { command: string; args: string[] },
): { command: string; args: string[] } {
  return {
    command: "sh",
    args: [
      "-c",
      '[ -e "$1" ] || exit 0; shift; exec "$@" >/dev/null',
      "sh",
      permissionMarkerPath(sessionId),
      inner.command,
      ...inner.args,
    ],
  };
}

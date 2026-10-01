import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeKind } from "../config/schema";

/**
 * A best-effort read of whether a runtime CLI looks logged in. We deliberately do
 * NOT run the CLI to probe auth: a headless `claude -p`/`codex exec` would cost
 * tokens and could hang, and the point of this check is a cheap `doctor` hint, not
 * a guarantee. So we look only for the credential files each CLI writes on login.
 *
 * Because macOS can keep claude's credentials in the Keychain (no file on disk), a
 * missing signal is reported as "unknown" with a nudge — never a hard "not signed
 * in" — so we don't cry wolf when the user is actually authenticated.
 */
export interface AuthStatus {
  state: "signed-in" | "unknown";
  /** A short human detail: an account email when we can read one, else a nudge. */
  detail: string;
}

export function runtimeAuth(kind: RuntimeKind): AuthStatus {
  return kind === "claude" ? claudeAuth() : codexAuth();
}

/** claude login writes `~/.claude/.credentials.json` (or stores creds in the macOS
 * Keychain) and records the account under `oauthAccount` in `~/.claude.json`. */
function claudeAuth(): AuthStatus {
  const email = readJson(join(homedir(), ".claude.json"))?.oauthAccount?.emailAddress;
  if (typeof email === "string" && email) return { state: "signed-in", detail: email };
  if (existsSync(join(homedir(), ".claude", ".credentials.json"))) {
    return { state: "signed-in", detail: "credentials present" };
  }
  return { state: "unknown", detail: "no stored credentials — run `claude login` if runs fail auth" };
}

/** codex login (API key or ChatGPT) writes `~/.codex/auth.json`. */
function codexAuth(): AuthStatus {
  if (existsSync(join(homedir(), ".codex", "auth.json"))) {
    return { state: "signed-in", detail: "credentials present" };
  }
  return { state: "unknown", detail: "no stored credentials — run `codex login` if runs fail auth" };
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

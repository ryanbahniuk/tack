import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR } from "../paths";

/**
 * Where a session's seed prompt is stashed: `LOGS_DIR/<id>/supervisor.prompt`. Two
 * readers share it — the detached `__run-supervisor` runner (which reads the prompt
 * it should run) and the auto-titler (which names the session from it). Lives in its
 * own leaf module so `src/session/title.ts` can write it without importing
 * `src/supervisor/supervise.ts`, which would close an import cycle through the
 * supervisor MCP server (supervise → supervisor-server → title).
 */
export function supervisorPromptPath(sessionId: string): string {
  return join(LOGS_DIR, sessionId, "supervisor.prompt");
}

/** Persists a session's seed prompt (see `supervisorPromptPath`). */
export function writeSupervisorPrompt(sessionId: string, prompt: string): void {
  mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
  writeFileSync(supervisorPromptPath(sessionId), prompt, "utf8");
}

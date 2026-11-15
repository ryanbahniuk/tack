import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR } from "../paths";

/** Single stash shared by detached runners and the session titler. */
export function supervisorPromptPath(sessionId: string): string {
  return join(LOGS_DIR, sessionId, "supervisor.prompt");
}

/** Persist a seed or first human prompt; use a file so long prompts stay off argv. */
export function writeSupervisorPrompt(sessionId: string, prompt: string): void {
  mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
  writeFileSync(supervisorPromptPath(sessionId), prompt, "utf8");
}

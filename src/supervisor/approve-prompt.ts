/** Shared by the command body and the hook matcher for expanded slash commands. */
export const APPROVE_PROMPT_MARKER = "<!-- tack:approve-plan -->";

/**
 * Current Claude Code docs say UserPromptSubmit receives custom commands as typed,
 * before expansion: https://code.claude.com/docs/en/hooks#userpromptsubmit-input
 * Also accept the command body's marker line for versions that pass expanded text.
 * This matcher belongs to the harness hook, never a model-callable approval tool.
 */
export function isApprovePrompt(prompt: string): boolean {
  return /^\/approve(?:\s|$)/.test(prompt.trim()) ||
    prompt.split(/\r?\n/).some((line) => line.trim() === APPROVE_PROMPT_MARKER);
}

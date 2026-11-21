import { readFileSync } from "node:fs";
import { collapseHome, USER_GUIDANCE_PATH } from "../paths";

/** The human chose launch-time injection; Tack never touches runtime-native stores. */
export function readUserGuidance(path = USER_GUIDANCE_PATH): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function userGuidanceSection(path = USER_GUIDANCE_PATH): string | null {
  const guidance = readUserGuidance(path);
  if (!guidance) return null;
  return [
    `## Your personal guidance (${collapseHome(path)})`,
    "These are the human's personal preferences for every run; follow them, but the Tack instructions above (role, coordination and finishing rules) and the repository's own CLAUDE.md / AGENTS.md take precedence where they conflict.",
    "",
    guidance,
  ].join("\n");
}

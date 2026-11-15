import { existsSync } from "node:fs";
import pc from "picocolors";
import { CONFIG_PATH } from "../paths";

/** Exits with the one "run tack init" message shared by every command that needs an
 * existing config, so the wording stays in a single place. */
export function ensureConfigExists(): void {
  if (!existsSync(CONFIG_PATH)) {
    console.error(pc.red(`No config at ${CONFIG_PATH}. Run \`tack init\` first.`));
    process.exit(1);
  }
}


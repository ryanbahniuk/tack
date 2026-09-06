import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { LOGS_DIR } from "../paths";
import type { TackConfig } from "../config/schema";
import { modelForRole } from "../config/load";
import { resolveRuntime, selectRuntime } from "../runtimes";

const PROMPT =
  "Investigate this repository (read its README, manifest files, and directory " +
  "structure) and describe what it is in a SINGLE concise sentence. This becomes a " +
  "project description used to route work, so name the domain and the primary " +
  "technology. Output only the sentence — no preamble, markdown, or quotes.";

/** Collapses whitespace and strips wrapping quotes so multi-line model output
 * becomes one clean config-ready sentence. */
function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.replace(/^["'`]|["'`]$/g, "").trim();
}

/**
 * Generates a one-line description of a repository by running the `summary`-role
 * model over it read-only. Used by `tack projects add` to auto-fill the
 * load-bearing `description` field. Throws if the model produces nothing.
 */
export async function summarizeProject(config: TackConfig, projectPath: string): Promise<string> {
  const model = modelForRole(config, "summary");
  const runtime = selectRuntime(model.runtime);
  const resolved = resolveRuntime(config, model.runtime); // verifies the version pin

  const logDir = join(LOGS_DIR, "summarize");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${basename(projectPath)}.log`);

  let out = "";
  let summary = "";
  for await (const ev of runtime.run({
    // Run read-only inside the repo so the model reads the right files directly.
    prompt: PROMPT,
    cwd: projectPath,
    model,
    bin: resolved.bin,
    readOnly: true,
    logPath,
  })) {
    if (ev.type === "text") out += ev.text;
    else if (ev.type === "done") summary = ev.summary ?? "";
    else if (ev.type === "error") throw new Error(ev.message);
  }

  const description = tidy(out || summary);
  if (!description) throw new Error(`The summary model returned no description for ${projectPath}.`);
  return description;
}

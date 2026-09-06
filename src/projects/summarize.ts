import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { LOGS_DIR } from "../paths";
import { ProjectMetadataSchema, type ProjectMetadata, type TackConfig } from "../config/schema";
import { modelForRole } from "../config/load";
import { resolveRuntime, selectRuntime } from "../runtimes";

const PROMPT =
  "Investigate this repository (read its README, manifest files, and directory " +
  "structure) and produce a JSON object describing it. Output ONLY the JSON object " +
  "— no preamble, markdown, code fences, or commentary. The object must have " +
  "exactly these keys:\n" +
  '- "description": a SINGLE concise sentence naming what the repo does and why it ' +
  "exists — its functionality and purpose only. Do NOT mention programming " +
  "languages or frameworks here.\n" +
  '- "language": the primary programming language the repo is written in, as a ' +
  'string (e.g. "TypeScript").\n' +
  '- "frameworks": an array of the 5-10 most prominent frameworks, libraries, or ' +
  "major tools the repo depends on, as strings.";

/** Collapses whitespace and strips wrapping quotes so multi-line model output
 * becomes one clean config-ready sentence. */
function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.replace(/^["'`]|["'`]$/g, "").trim();
}

/**
 * Extracts the JSON object from raw model output, tolerating stray prose or code
 * fences by slicing from the first `{` to the last `}`. Throws if no object is
 * present or it doesn't parse.
 */
function parseSummary(raw: string): { description: string; metadata: ProjectMetadata } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`The summary model did not return a JSON object. Got: ${tidy(raw).slice(0, 200)}`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error(`The summary model returned invalid JSON: ${(err as Error).message}`);
  }
  const record = obj as { description?: unknown };
  const description = typeof record.description === "string" ? tidy(record.description) : "";
  if (!description) throw new Error("The summary model returned no description.");
  const metadata = ProjectMetadataSchema.parse(obj);
  return { description, metadata };
}

/**
 * Generates a structured summary of a repository by running the `summary`-role
 * model over it read-only: a one-line `description` of its purpose plus tech-stack
 * `metadata` (primary language + top frameworks). Used by `tack projects add` to
 * auto-fill the load-bearing project fields. Throws if the model produces nothing.
 */
export async function summarizeProject(
  config: TackConfig,
  projectPath: string,
): Promise<{ description: string; metadata: ProjectMetadata }> {
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

  const raw = out || summary;
  if (!raw.trim()) throw new Error(`The summary model returned no output for ${projectPath}.`);
  return parseSummary(raw);
}

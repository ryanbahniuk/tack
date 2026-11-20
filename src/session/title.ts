import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR } from "../paths";
import type { TackConfig } from "../config/schema";
import { modelForRole } from "../config/load";
import { resolveRuntime, selectRuntime } from "../runtimes";
import { getSession, latestSharedContext, setSessionTitle } from "../db";
import { readArtifact } from "../artifacts/store";
import { selfInvocation } from "../process/self";
import { parseSupervisorCommand } from "../supervisor/command-prompt";
import { isApprovePrompt } from "../supervisor/approve-prompt";
import { supervisorPromptPath, writeSupervisorPrompt } from "../supervisor/prompt";
import { RESTART_MESSAGE } from "./refresh-message";
import { tidy } from "../projects/summarize";

/** How much source text the titler sends the model — a title needs the gist, not
 * the whole contract, and capping it keeps this cheap summary-model call cheap. */
const MAX_SOURCE_CHARS = 8000;
/** Hard ceiling on the stored title, whatever the model returns (the prompt asks
 * for ≤60; this guards list/dashboard layout against a model that ignores it). */
const MAX_TITLE_CHARS = 80;

const PROMPT_HEAD =
  "You are naming a coding session from its task text. Output ONLY a short " +
  "plain-English title for the session, at most 60 characters, in sentence case. " +
  "No quotes, no trailing period, no preamble, no markdown — just the title on a " +
  "single line.\n\nThe task text is between the markers below.\n\n";

/**
 * Capture an unseeded session's first human ask before the supervisor responds.
 * Set an instant stand-in, then refine it asynchronously; the first shared contract
 * refines it again later. Silent for hook stdout; callers must fail open on errors.
 * The injected spawner lets tests avoid launching a model process.
 */
export function titleFromFirstPrompt(
  sessionId: string,
  prompt: string,
  spawnTitler: (sessionId: string) => void = spawnSessionTitler,
): boolean {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.startsWith("/") || isApprovePrompt(prompt) || parseSupervisorCommand(prompt) || trimmed.startsWith(RESTART_MESSAGE)) return false;
  const session = getSession(sessionId);
  if (!session || session.title?.trim()) return false;
  const promptFile = supervisorPromptPath(sessionId);
  if (existsSync(promptFile) && readFileSync(promptFile, "utf8").trim()) return false;

  setSessionTitle(sessionId, trimmed.slice(0, MAX_TITLE_CHARS));
  writeSupervisorPrompt(sessionId, prompt);
  spawnTitler(sessionId);
  return true;
}

/**
 * The best text to name a session from: the latest shared contract (the
 * supervisor's distilled plan — sharper than the raw ask) when one exists, else the
 * seed prompt stashed at creation or the first human prompt saved by the hook.
 * Throws if the session has neither yet.
 */
function titleSource(sessionId: string): string {
  const contract = latestSharedContext(sessionId);
  const body = contract ? readArtifact(contract.body_ref).trim() : "";
  if (body) return body;
  const promptFile = supervisorPromptPath(sessionId);
  if (existsSync(promptFile)) {
    const prompt = readFileSync(promptFile, "utf8").trim();
    if (prompt) return prompt;
  }
  throw new Error(`Session ${sessionId} has no shared contract or stashed prompt to title it from yet.`);
}

/** Model output → one clean title line: collapse, first line, no trailing period, capped. */
function cleanTitle(raw: string): string {
  // `tidy` flattens newlines to spaces, so split on the raw output first to keep
  // only the first line, then tidy that.
  const first = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return tidy(first).replace(/\.+$/, "").trim().slice(0, MAX_TITLE_CHARS).trim();
}

/**
 * Generates a short title for a session with the `summary`-role model and writes it
 * to `sessions.title`, replacing the truncated-prompt stand-in (or the empty title
 * of a run without a captured prompt). Runs read-only with no shell, in the
 * session's log dir — it only reads the text it's handed, never a repo. Throws on
 * any failure; callers on the session/supervisor path go through
 * `spawnSessionTitler`, which keeps that best-effort. Its cost is deliberately not
 * added to the session's cost.
 */
export async function generateSessionTitle(config: TackConfig, sessionId: string): Promise<string> {
  const source = titleSource(sessionId).slice(0, MAX_SOURCE_CHARS);
  const model = modelForRole(config, "summary");
  const runtime = selectRuntime(model.runtime);
  const resolved = resolveRuntime(config, model.runtime); // verifies the version pin

  const cwd = join(LOGS_DIR, sessionId);
  mkdirSync(cwd, { recursive: true });

  let out = "";
  let summary = "";
  for await (const ev of runtime.run({
    prompt: `${PROMPT_HEAD}<<<TASK TEXT\n${source}\nTASK TEXT>>>`,
    cwd,
    model,
    bin: resolved.bin,
    readOnly: true,
    disallowShell: true,
    logPath: join(cwd, "title.log"),
  })) {
    if (ev.type === "text") out += ev.text;
    else if (ev.type === "done") summary = ev.summary ?? "";
    else if (ev.type === "error") throw new Error(ev.message);
  }

  const title = cleanTitle(out || summary);
  if (!title) throw new Error(`The summary model returned no title for session ${sessionId}.`);
  setSessionTitle(sessionId, title);
  return title;
}

/**
 * Fires off `tack __title-session <sessionId>` as a detached background process
 * (mirroring `spawnSupervisorRunner`), so titling never blocks session creation,
 * a prompt-submit hook, or a supervisor tool call. Best-effort end to end: a spawn
 * failure is swallowed here and a titling failure lands only in `title.runner.log`.
 * Prints nothing, so hook and MCP stdout stay reserved for their protocols.
 */
export function spawnSessionTitler(sessionId: string): void {
  try {
    mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
    const fd = openSync(join(LOGS_DIR, sessionId, "title.runner.log"), "a");
    const { command, args } = selfInvocation();
    const child = spawn(command, [...args, "__title-session", sessionId], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    // An async spawn error (e.g. ENOENT) arrives as an event; without a listener it
    // would crash the caller, which titling must never do.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort: a missing title is cosmetic; never fail the caller over it.
  }
}

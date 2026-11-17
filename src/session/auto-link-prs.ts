import type { TackConfig } from "../config/schema";
import { listSessionPrs } from "../db";
import { parseGithubPrUrl } from "../projects/prs";
import { isApprovePrompt } from "../supervisor/approve-prompt";
import { parseSupervisorCommand } from "../supervisor/command-prompt";
import { linkSessionPr } from "./link-pr";
import { RECONNECT_MESSAGE, REFRESH_MESSAGE } from "./refresh-message";

/**
 * Auto-linking: GitHub PR URLs the human pastes into a supervisor prompt are adopted
 * into the session (exactly as `link_pr` would) before the supervisor sees the turn,
 * instead of depending on the model to remember to call `link_pr`. Everything goes
 * through `linkSessionPr`, so this is local bookkeeping plus read-only `gh` calls —
 * nothing is written to GitHub — and a re-run on the same URL is harmless.
 */

/** More URLs than this in one message is a paste of a list, not "work on these". */
export const MAX_AUTO_LINK_URLS = 10;

// A URL candidate: stops at whitespace and at characters that delimit a URL in prose
// or markdown (`[x](url)`, `<url>`, quotes, backticks). Trailing sentence punctuation
// is stripped afterwards, since it can legitimately appear inside a URL.
const URL_CANDIDATE_RE = /https?:\/\/[^\s<>()[\]"'`]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?)\]>'"*_]+$/;

/**
 * Every GitHub PR URL in free text, normalized to `https://<host>/<owner>/<repo>/pull/<n>`
 * (sub-pages, queries and fragments dropped), deduped case-insensitively by
 * owner/repo/number in first-seen order, capped at `MAX_AUTO_LINK_URLS`. Other GitHub
 * URLs (issues, blobs, commits) are ignored.
 */
export function extractPrUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(URL_CANDIDATE_RE)) {
    const ref = parseGithubPrUrl(match[0].replace(TRAILING_PUNCT_RE, ""));
    if (!ref) continue;
    const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(`https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`);
    if (urls.length >= MAX_AUTO_LINK_URLS) break;
  }
  return urls;
}

/** Total time the prompt hook spends auto-linking before letting the turn proceed. */
export const AUTO_LINK_BUDGET_MS = 20_000;

/**
 * Whether a submitted prompt is the human's own words worth scanning for PR URLs:
 * not a slash command, `/approve` (or its expanded body), a `/review` / `/pr-fix`
 * command, or one of Tack's synthetic refresh/reconnect openers.
 */
export function autoLinkablePrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return !!trimmed && !trimmed.startsWith("/") && !isApprovePrompt(prompt) && !parseSupervisorCommand(prompt) &&
    !trimmed.startsWith(REFRESH_MESSAGE) && !trimmed.startsWith(RECONNECT_MESSAGE);
}

export interface AutoLinkOutcome {
  url: string;
  /** `owner/repo#n`, as the note names it. */
  ref: string;
  /** `already`: this session had opened or linked it before this message. */
  status: "linked" | "already" | "skipped";
  project?: string;
  title?: string;
  reason?: string;
}

export const AUTO_LINK_TIMEOUT_REASON = "timed out; call link_pr for it if it's needed";

/** `linkSessionPr`'s refusals, shortened for the note. Unknown errors keep their first line. */
function skipReason(message: string): string {
  if (/already merged/.test(message)) return "already merged";
  if (/is closed/.test(message)) return "closed";
  if (/from a fork/.test(message)) return "from a fork";
  if (/isn't a configured project/.test(message)) return "not a configured project";
  return message.split("\n")[0]!.trim() || "couldn't be linked";
}

function prKey(url: string): string | null {
  const ref = parseGithubPrUrl(url);
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase() : null;
}

const TIMEOUT = Symbol("timeout");

/**
 * Links each PR URL in `prompt` into the session, sequentially, and reports what
 * happened to each. Never throws. Once `deadlineMs` (an epoch-ms instant) passes, no
 * new link is started and a link still in flight stops being awaited; those URLs are
 * reported skipped with `AUTO_LINK_TIMEOUT_REASON`. `link` is injectable for tests.
 */
export async function autoLinkPromptPrs(input: {
  sessionId: string;
  config: Pick<TackConfig, "projects">;
  prompt: string;
  link?: typeof linkSessionPr;
  deadlineMs?: number;
}): Promise<AutoLinkOutcome[]> {
  const link = input.link ?? linkSessionPr;
  const outcomes: AutoLinkOutcome[] = [];
  let urls: string[];
  let linkedBefore: Set<string>;
  try {
    urls = extractPrUrls(input.prompt);
    if (!urls.length) return [];
    linkedBefore = new Set(
      listSessionPrs(input.sessionId).filter((p) => p.linked_at).map((p) => prKey(p.url)).filter((k): k is string => !!k),
    );
  } catch {
    return outcomes;
  }
  for (const url of urls) {
    const r = parseGithubPrUrl(url)!;
    const ref = `${r.owner}/${r.repo}#${r.number}`;
    const remaining = input.deadlineMs === undefined ? Infinity : input.deadlineMs - Date.now();
    if (remaining <= 0) {
      outcomes.push({ url, ref, status: "skipped", reason: AUTO_LINK_TIMEOUT_REASON });
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const attempt = link({ sessionId: input.sessionId, config: input.config, url });
      const result = remaining === Infinity
        ? await attempt
        : await Promise.race([attempt, new Promise<typeof TIMEOUT>((res) => { timer = setTimeout(() => res(TIMEOUT), remaining); })]);
      if (result === TIMEOUT) {
        attempt.catch(() => {}); // abandoned; don't let a late rejection go unhandled
        outcomes.push({ url, ref, status: "skipped", reason: AUTO_LINK_TIMEOUT_REASON });
        continue;
      }
      const already = !!result.alreadySessionPr || linkedBefore.has(ref.toLowerCase());
      outcomes.push({ url: result.url || url, ref, status: already ? "already" : "linked", project: result.project, title: result.title });
    } catch (err) {
      outcomes.push({ url, ref, status: "skipped", reason: skipReason((err as Error)?.message ?? String(err)) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return outcomes;
}

/** One linked PR for the note: `owner/repo#12 in project "x" ("title")`. */
function describe(o: AutoLinkOutcome): string {
  return `${o.ref}${o.project ? ` in project "${o.project}"` : ""}${o.title ? ` (${JSON.stringify(o.title)})` : ""}`;
}

/**
 * A compact plain-text note telling the supervisor what was auto-linked, how to work
 * on it, and what wasn't linked and why. Null when there's nothing to report.
 */
export function autoLinkNote(outcomes: AutoLinkOutcome[]): string | null {
  if (!outcomes.length) return null;
  const linked = outcomes.filter((o) => o.status !== "skipped");
  const skipped = outcomes.filter((o) => o.status === "skipped");
  const parts: string[] = [];
  if (linked.length) {
    parts.push(
      `Tack auto-linked PR URLs from the human's message: ${linked.map(describe).join(", ")}.`,
      "They're session PRs now: change them with fix_pr, never spawn_agent + open_pr.",
    );
  }
  if (skipped.length) {
    const list = skipped.map((o) => `${o.ref} (${o.reason ?? "couldn't be linked"})`).join(", ");
    parts.push(linked.length ? `Not linked: ${list}.` : `Tack didn't auto-link PR URLs from the human's message: ${list}.`);
  }
  return parts.join(" ");
}

/**
 * For runs with no UserPromptSubmit hook (headless/background supervisors and
 * attended non-claude TUIs): auto-links the prompt's PR URLs when `autoLinkPrs` is
 * on and returns the prompt with the note appended, so the supervisor learns what
 * was linked. Returns the prompt unchanged when there's nothing to do. Never throws.
 */
export async function promptWithAutoLinks(input: {
  sessionId: string;
  config: Pick<TackConfig, "projects" | "autoLinkPrs">;
  prompt: string;
  link?: typeof linkSessionPr;
}): Promise<string> {
  try {
    if (!input.config.autoLinkPrs || !autoLinkablePrompt(input.prompt) || !extractPrUrls(input.prompt).length) return input.prompt;
    const note = autoLinkNote(await autoLinkPromptPrs({ ...input, deadlineMs: Date.now() + AUTO_LINK_BUDGET_MS }));
    return note ? `${input.prompt}\n\n(${note})` : input.prompt;
  } catch {
    return input.prompt;
  }
}

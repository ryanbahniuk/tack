import { dirname } from "node:path";
import type { TackConfig } from "../config/schema";
import { resolveRuntime, selectRuntime } from "../runtimes";
import type { AgentEvent, RunOptions } from "../runtimes/types";

export type PublishRunner = (opts: RunOptions) => AsyncIterable<AgentEvent>;

/** The claude model for headless publish runs; any configured claude model works. */
export function publishModel(config: TackConfig) {
  return config.models.find(m => m.runtime === "claude") ?? { key: "artifact-publisher", provider: "anthropic", name: "Claude", version: "default", runtime: "claude" as const, id: "sonnet" };
}

/** Run a read-only, shell-less claude publish turn and return its final text. */
export async function runPublishTurn(config: TackConfig, file: string, prompt: string, opts: { allowTools: string[]; inheritUserMcp?: boolean; runner?: PublishRunner }): Promise<string> {
  const runtime = selectRuntime("claude");
  const bin = opts.runner ? "claude" : resolveRuntime(config, "claude").bin;
  let text = "", summary = "";
  for await (const ev of (opts.runner ?? ((o) => runtime.run(o)))({ prompt, cwd: dirname(file), model: publishModel(config), bin, readOnly: true, disallowShell: true, addDirs: [dirname(file)], logPath: `${file}.publish.log`, allowTools: opts.allowTools, ...(opts.inheritUserMcp ? { inheritUserMcp: true } : {}) })) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "done") summary = ev.summary ?? "";
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return text || summary;
}

export const PUBLISH_REPORT_INSTRUCTIONS = "Finish with exactly two final lines:\nPUBLISHED_URL: <url of the page>\nPRIVATE: yes|no|unverified";

/**
 * Parse a connector publish run's report: the last URL the destination owns, and
 * whether privacy was confirmed. Anything but an explicit `PRIVATE: yes` warns.
 */
export function parsePublishReport(text: string, owns: (url: string) => boolean): { url?: string; privacy: "yes" | "no" | "unverified" } {
  const urls = (text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []).map(u => u.replace(/[.,;:]+$/, "")).filter(owns);
  const marks = [...text.matchAll(/PRIVATE:\s*\**\s*(yes|no|unverified)\b/gi)];
  const privacy = (marks.at(-1)?.[1]?.toLowerCase() ?? "unverified") as "yes" | "no" | "unverified";
  return { url: urls.at(-1), privacy };
}

/** Turn a connector run's report into a `PublishResult`, or an actionable error. */
export function connectorResult(text: string, opts: { label: string; owns: (url: string) => boolean; file: string; hint: string }): { url: string; warning?: string } {
  const { url, privacy } = parsePublishReport(text, opts.owns);
  if (!url) throw new Error(`${opts.label} publisher returned no ${opts.label} URL; the local file remains at ${opts.file}. ${opts.hint}`);
  return privacy === "yes" ? { url } : { url, warning: `${opts.label} page at ${url} was published but its privacy is ${privacy === "no" ? "not private" : "unverified"}; check its sharing settings` };
}

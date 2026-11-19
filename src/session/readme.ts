import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentArtifactPath, writeSessionReadme, writeSessionReadmeDigest } from "../artifacts/store";
import { modelForRole } from "../config/load";
import type { TackConfig } from "../config/schema";
import { getSession, latestSharedContext, listAgents, listSessionJiraTickets, listSessionPrs, setSessionReadme, type SessionRow } from "../db";
import { LOGS_DIR } from "../paths";
import { selfInvocation } from "../process/self";
import { resolveRuntime, selectRuntime } from "../runtimes";
import type { AgentEvent, RunOptions } from "../runtimes/types";
import { selectPublisher } from "../publish";
import type { PagePublisher } from "../publish/types";
import { claudeReportTranscriptPath, extractReportTranscript, readReportFile, reportExcerpt } from "./bug-report";

export const README_PAGE_SPEC = `Create a self-contained README-style HTML page from ONLY the digest below. Never invent PRs, links or statuses. Label unfinished or unknown rollout steps next; omit sections rather than pad them.
Use an eyebrow, h1 and lede, concept or repo cards, diagrams or code explaining the mental model and technical approach, rollout phase cards with done/next/wait pills, a known trade-off warning callout, and a Pull requests table (Repo | PR | What it covers | Status + detail) followed by Status as of the digest date, and a footer. Use inline SVG diagrams with CSS tokens so they work in both themes.
Define CSS tokens on :root, dark overrides under @media (prefers-color-scheme: dark){:root:not([data-theme="light"])} and :root[data-theme="dark"]. Set an explicit body background, max-width about 860px, 16px side gutters, and no horizontal page scroll at phone widths. Google Fonts is the only permitted external stylesheet; no external scripts. The title element must have 2–4 words.
Output exactly one HTML document between <<<README_HTML and README_HTML>>> and nothing else.`;

/** Count changed lines per file without exposing patch contents. */
export function parseDiffStat(patch: string): string {
  const files = new Map<string, { add: number; del: number }>();
  let current: string | undefined, inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { current = line.match(/^diff --git a\/(.*?) b\/(.*)$/)?.[2]; inHunk = false; if (current) files.set(current, files.get(current) ?? { add: 0, del: 0 }); }
    else if (line.startsWith("@@")) inHunk = true;
    else if (current && inHunk && line.startsWith("+")) files.get(current)!.add++;
    else if (current && inHunk && line.startsWith("-")) files.get(current)!.del++;
  }
  return [...files].map(([name, n]) => `${name} +${n.add} -${n.del}`).join("\n");
}
const defaults = { read: readReportFile, agents: listAgents, contract: latestSharedContext, prs: listSessionPrs, tickets: listSessionJiraTickets, date: () => new Date().toISOString().slice(0, 10) };
export function buildSessionReadmeDigest(session: SessionRow, sources: Partial<typeof defaults> = {}): string {
  const src = { ...defaults, ...sources };
  const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
  const read = (path: string | null | undefined, tail = false) => path ? safe(() => src.read(path, tail), "") : "";
  const parts = ["# Session README digest"];
  const add = (title: string, body: string, cap: number, tail = false) => { if (body) parts.push(`## ${title}\n\n${reportExcerpt(body, cap, tail)}`); };
  add("Session", `Id: ${session.id}\nTitle: ${session.title ?? ""}\nStatus: ${session.status}\nCreated: ${session.created_at}\nUpdated: ${session.updated_at}\nSupervisor model/runtime: ${session.supervisor_model ?? ""} / ${session.runtime ?? ""}`, 1500);
  add("Seed prompt", read(join(LOGS_DIR, session.id, "supervisor.prompt")), 4000);
  const contract = safe(() => src.contract(session.id), null);
  if (contract) add(`Shared contract (v${contract.version})`, read(contract.body_ref), 7000);
  add("Jira tickets", safe(() => src.tickets(session.id), []).map(t => `${t.key} ${t.title ?? ""} ${t.status ?? ""} ${t.url ?? ""}`).join("\n"), 3000);
  const agents = safe(() => src.agents(session.id), []).slice(-25);
  add("Agents", agents.map(a => `### ${a.id}\nProject: ${a.project_name}\nKind: ${a.kind ?? "worker"}\nStatus: ${a.status}\nModel/runtime: ${a.model ?? ""} / ${a.runtime ?? ""}\nError: ${reportExcerpt(a.error ?? "", 250)}\nPrompt: ${reportExcerpt(read(a.prompt_ref ?? agentArtifactPath(session.id, a.id, "prompt")), 400)}\nOutput: ${reportExcerpt(read(a.output_ref ?? agentArtifactPath(session.id, a.id, "output"), true), 650, true)}\nDiff stat:\n${reportExcerpt(parseDiffStat(read(a.diff_ref ?? agentArtifactPath(session.id, a.id, "diff"))), 450)}`).join("\n\n"), 30000);
  add("Pull requests", safe(() => src.prs(session.id), []).slice(-30).map(p => `${p.title ?? ""}\nProject: ${p.project_name ?? ""}\nURL: ${p.url}\nState: ${p.state ?? "unknown"}\nMerged: ${p.merged_at ?? ""}\nHead: ${p.head_branch ?? ""}\nBody: ${reportExcerpt(read(p.body_ref), 1200)}`).join("\n\n"), 7000);
  const transcript = claudeReportTranscriptPath(session);
  if (transcript) add("Supervisor conversation tail", extractReportTranscript(read(transcript, true)), 6000, true);
  parts.push(`As of: ${src.date()}`);
  return parts.join("\n\n") + "\n";
}
export function extractReadmeHtml(raw: string): string {
  const marked = raw.match(/<<<README_HTML\s*([\s\S]*?)\s*README_HTML>>>/i);
  if (marked?.[1]?.trim()) return marked[1].trim();
  const html = raw.match(/(?:<!doctype\s+html\b[^>]*>|<html\b[^>]*>)[\s\S]*<\/html\s*>/i);
  if (html) return html[0];
  throw new Error("Author returned no HTML document");
}
export async function generateSessionReadme(config: TackConfig, sessionId: string, opts: { publish?: boolean; runAuthor?: (opts: RunOptions) => AsyncIterable<AgentEvent>; publisher?: PagePublisher } = {}): Promise<{ file: string; url?: string; publisher: string }> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const digest = buildSessionReadmeDigest(session);
  const digestFile = writeSessionReadmeDigest(sessionId, digest);
  const model = modelForRole(config, "readme");
  const runtime = selectRuntime(model.runtime);
  const bin = opts.runAuthor ? model.runtime : resolveRuntime(config, model.runtime).bin;
  mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
  let text = "", summary = "";
  for await (const ev of (opts.runAuthor ?? ((o) => runtime.run(o)))({ prompt: `${README_PAGE_SPEC}\n\n${digest}`, cwd: dirname(digestFile), model, bin, readOnly: true, disallowShell: true, logPath: join(LOGS_DIR, sessionId, "readme.log") })) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "done") summary = ev.summary ?? "";
    else if (ev.type === "error") throw new Error(ev.message);
  }
  const html = extractReadmeHtml(text || summary);
  const file = writeSessionReadme(sessionId, html);
  const publisher = opts.publisher ?? selectPublisher(config);
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || session.title || "Session README";
  const url = opts.publish === false ? undefined : (await publisher.publish({ file, title, description: `README for session ${sessionId}`, existingUrl: session.readme_url })).url;
  setSessionReadme(sessionId, { ref: file, url });
  return { file, url, publisher: publisher.kind };
}
/** Detached and best-effort, so the dashboard remains responsive. */
export function spawnSessionReadmer(sessionId: string): void {
  try {
    mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
    const fd = openSync(join(LOGS_DIR, sessionId, "readme.runner.log"), "a");
    const { command, args } = selfInvocation();
    const child = spawn(command, [...args, "__readme-session", sessionId], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.on("error", () => {}); child.unref();
  } catch { /* Best effort; failures are logged by the runner. */ }
}

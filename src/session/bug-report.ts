import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentArtifactPath } from "../artifacts/store";
import { latestSharedContext, listAgents, listSessionPrs, type SessionRow } from "../db";
import { LOGS_DIR, TACK_HOME } from "../paths";
import { tmuxCapturePane } from "./tmux";

/** Bound disk reads too: a live transcript or log can be many megabytes. A partial
 * first JSONL record is harmless (the parser skips it). */
export function readReportFile(path: string, tail = false): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, tail ? size - length : 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Best-effort evidence collection. */ }
    }
  }
}

/** Explicit character and line limits, including the omission marker. */
export function reportExcerpt(text: string, chars: number, tail = false, lines = 300): string {
  const rows = text.split("\n");
  const selected = (tail ? rows.slice(-lines) : rows.slice(0, lines)).join("\n");
  if (rows.length <= lines && selected.length <= chars) return selected;
  const marker = "\n[truncated]\n";
  return tail ? marker + selected.slice(-(chars - marker.length)) : selected.slice(0, chars - marker.length) + marker;
}

/** Same location convention as ClaudeRuntime.recoverUsage; no native session DB. */
export function claudeReportTranscriptPath(session: SessionRow, home = homedir(), tackHome = TACK_HOME): string | undefined {
  if (session.runtime !== "claude" || !session.resume_ref) return undefined;
  const slug = join(tackHome, "supervisor", session.id).replace(/[/.]/g, "-");
  return join(home, ".claude", "projects", slug, `${session.resume_ref}.jsonl`);
}

/** Extract conversation only; omit usage, thinking and other runtime bookkeeping. */
export function extractReportTranscript(jsonl: string): string {
  const messages: string[] = [];
  for (const line of jsonl.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "user" && event.type !== "assistant") continue;
      const content = event.message?.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        let text = "";
        if (block?.type === "text" && typeof block.text === "string") text = block.text;
        if (block?.type === "tool_use") text = `Tool call ${block.name} (${block.id}): ${JSON.stringify(block.input)}`;
        if (block?.type === "tool_result") text = `Tool result ${block.tool_use_id}${block.is_error ? " (error)" : ""}: ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`;
        if (text) messages.push(`${event.type}: ${reportExcerpt(text, 1500, false, 30)}`);
      }
    } catch {
      /* Incomplete or malformed records are expected in a live JSONL tail. */
    }
  }
  return reportExcerpt(messages.join("\n\n"), 12000, true);
}

const defaultSources = {
  read: readReportFile,
  agents: listAgents,
  contract: latestSharedContext,
  prs: listSessionPrs,
  capture: tmuxCapturePane,
};

function safely<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

/** Each section has its own budget, so large agent output cannot crowd out the
 * conversation or logs. Total is <45K characters (<180KB even with Unicode). */
export function buildTackBugReport(session: SessionRow, sources: Partial<typeof defaultSources> = {}): string {
  const src = { ...defaultSources, ...sources };
  const sections = ["# Tack bug report"];
  const add = (title: string, body: string, cap: number, tail = false) => {
    if (body) sections.push(`## ${title}\n\n${reportExcerpt(body, cap, tail)}`);
  };
  const read = (path: string, tail = false) => safely(() => src.read(path, tail), "");
  add("Source session", `Id: ${session.id}\nTitle: ${session.title ?? ""}\nStatus: ${session.status}\nModel/runtime: ${session.supervisor_model ?? ""} / ${session.runtime ?? ""}\nCreated: ${session.created_at}\nUpdated: ${session.updated_at}\nHeartbeat: ${session.heartbeat_at ?? ""}\nPlan approved: ${session.plan_approved_at ?? "not approved"}`, 2000);
  add("Original supervisor prompt", read(join(LOGS_DIR, session.id, "supervisor.prompt")), 4000);
  const contract = safely(() => src.contract(session.id), null);
  if (contract) add(`Shared contract (v${contract.version})`, read(contract.body_ref), 6000);
  const agents = safely(() => src.agents(session.id), []);
  const agentSections: string[] = [];
  // Bound count as well as bytes; newest agents usually carry the failure evidence.
  for (const agent of agents.slice(-20)) {
    const output = (agent.output_ref && read(agent.output_ref, true)) || read(agentArtifactPath(session.id, agent.id, "output"), true);
    agentSections.push(reportExcerpt(`### ${agent.id}\nProject: ${agent.project_name}\nStatus: ${agent.status}\nModel/runtime: ${agent.model ?? ""} / ${agent.runtime ?? ""}\nError: ${agent.error ?? ""}`, 800) + (output ? `\n\n${reportExcerpt(output, 2400, true, 80)}` : ""));
  }
  if (agents.length > 20) agentSections.unshift("[Earlier agents omitted]");
  add("Agents", agentSections.join("\n\n"), 14000);
  add("Session PRs", safely(() => src.prs(session.id), []).slice(-30).map(pr => reportExcerpt(`${pr.url} — ${pr.state ?? "unknown"} (${pr.project_name ?? ""})`, 400)).join("\n"), 2000);
  const transcriptPath = claudeReportTranscriptPath(session);
  const transcript = transcriptPath ? extractReportTranscript(read(transcriptPath, true)) : "";
  add(transcript ? "Supervisor conversation (tail)" : "Supervisor pane (tail)", transcript || safely(() => src.capture(session.id), ""), 12000, true);
  add("Supervisor log (tail)", read(join(LOGS_DIR, session.id, "supervisor.log"), true), 4000, true);
  return sections.join("\n\n") + "\n";
}

export function writeTackBugReport(newSessionId: string, source: SessionRow): string {
  const path = join(TACK_HOME, "supervisor", newSessionId, "tack-bug-report.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildTackBugReport(source), "utf8");
  return path;
}

/** Keep the seed small: it travels in tmux new-session argv. */
export function tackBugSeed(sourceId: string, description: string, hasTack: boolean): string {
  return `Diagnose and fix a bug in Tack itself (project tack). Source session: ${sourceId}.\nUser description:\n${description.trim() ? reportExcerpt(description, 2000, false, 20).split("\n").map(line => `> ${line}`).join("\n") : "> (skipped; infer the bug from the evidence)"}\nRead ./tack-bug-report.md first, then sync the tack project and proceed with the normal supervisor workflow.${hasTack ? "" : "\nWarning: no configured project is named tack; resolve that missing configuration before syncing."}`;
}

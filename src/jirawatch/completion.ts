import { parseDiffStat } from "../session/readme";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TackConfig } from "../config/schema";
import { modelForRole, resolveModel } from "../config/load";
import { resolveRuntime, selectRuntime } from "../runtimes";
import { LOGS_DIR } from "../paths";
import { latestSharedContext, listAgents, listSessionPrs, setJiraCheckResult, upsertSessionJiraTicket, type SessionPrRow, type SessionJiraTicketRow } from "../db";
import { readArtifact, writeJiraCheckArtifact } from "../artifacts/store";
import { addJiraComment, fetchJiraIssueDetail, transitionJiraIssueToDone } from "../projects/jira";

export function sessionPrsSettled(prs: Pick<SessionPrRow, "state">[]): boolean {
  return prs.length > 0 && prs.every(pr => pr.state === "merged" || pr.state === "closed") && prs.some(pr => pr.state === "merged");
}
export function completionMarker(prs: Pick<SessionPrRow, "state" | "merged_at">[]): string | null {
  return prs.filter(pr => pr.state === "merged" && pr.merged_at).map(pr => pr.merged_at!).sort().at(-1) ?? null;
}
export function completionDue(ticket: SessionJiraTicketRow, prs: SessionPrRow[], force = false): boolean {
  return ticket.status_category !== "done" && (force || (sessionPrsSettled(prs) && (!ticket.check_result || ticket.check_marker !== completionMarker(prs))));
}
export interface CompletionVerdict { key: string; done: boolean; confidence: "high" | "medium" | "low"; reason: string; unmet: string[] }
export function parseCompletionVerdict(raw: string, key: string): CompletionVerdict | null {
  const match = raw.match(/```json\s*([\s\S]*?)\s*```\s*$/i);
  if (!match) return null;
  try {
    const v = JSON.parse(match[1]!);
    if (v.key !== key || typeof v.done !== "boolean" || !["high", "medium", "low"].includes(v.confidence) || typeof v.reason !== "string" || !Array.isArray(v.unmet) || !v.unmet.every((x: unknown) => typeof x === "string")) return null;
    return v as CompletionVerdict;
  } catch { return null; }
}

async function runModel(config: TackConfig, sessionId: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const model = config.jira?.watch.model ? resolveModel(config, config.jira.watch.model) : modelForRole(config, "summary");
  const runtime = selectRuntime(model.runtime), resolved = resolveRuntime(config, model.runtime);
  const cwd = join(LOGS_DIR, sessionId);
  mkdirSync(cwd, { recursive: true });
  let out = "", summary = "";
  for await (const ev of runtime.run({ prompt, cwd, model, bin: resolved.bin, readOnly: true, disallowShell: true, signal, logPath: join(cwd, "jira-check.log") })) {
    if (ev.type === "text") out += ev.text;
    else if (ev.type === "done") summary = ev.summary ?? "";
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return out || summary;
}

const completionDeps = { fetch: fetchJiraIssueDetail, transition: transitionJiraIssueToDone, comment: addJiraComment };

export async function runCompletion(config: TackConfig, sessionId: string, ticket: SessionJiraTicketRow, options: { dryRun?: boolean; runner?: typeof runModel; deps?: typeof completionDeps; signal?: AbortSignal } = {}): Promise<void> {
  const prs = listSessionPrs(sessionId), marker = completionMarker(prs);
  const deps = options.deps ?? completionDeps;
  let raw = "", result = "error", reason = "Check failed";
  try {
    const detail = await deps.fetch(config, ticket.key);
    if (detail.statusCategory === "done") {
      upsertSessionJiraTicket({ sessionId, key: ticket.key, status: detail.status, statusCategory: "done" });
      result = "already_done"; reason = "Ticket is already done";
    } else {
      const contract = latestSharedContext(sessionId);
      const evidence = prs.map(p => `${p.title ?? ""} | ${p.state} | ${p.merged_at ?? ""} | ${p.url}\n${readArtifact(p.body_ref).slice(0, 6000)}`).join("\n\n").slice(0, 24000);
      const diffs = listAgents(sessionId).map(a => `${a.id}: ${parseDiffStat(readArtifact(a.diff_ref)).slice(0, 3000)}`).join("\n").slice(0, 12000);
      const prompt = `Judge whether this Jira ticket is complete based only on the evidence. Report not done if any acceptance criterion or explicit requirement is not clearly covered by merged work, any subtask is not Done, or the ticket scope exceeds this session. End with one fenced JSON block: {"key":"${ticket.key}","done":true,"confidence":"high|medium|low","reason":"...","unmet":[]}\n\nTicket:\n${JSON.stringify(detail).slice(0, 16000)}\n\nShared contract:\n${readArtifact(contract?.body_ref).slice(0, 16000)}\n\nPRs:\n${evidence}\n\nAgent diffs:\n${diffs}`;
      if (options.signal?.aborted) throw new Error("Jira check stopped");
      raw = await (options.runner ?? runModel)(config, sessionId, prompt, options.signal);
      const verdict = parseCompletionVerdict(raw, ticket.key);
      if (!verdict) throw new Error("Invalid model verdict");
      reason = verdict.unmet[0] ?? verdict.reason;
      const unfinished = detail.subtasks.find(s => s.statusCategory !== "done");
      if (unfinished) reason = `Subtask ${unfinished.key} is not Done`;
      if (!verdict.done || verdict.confidence !== "high" || unfinished) result = "not_done";
      else if (config.jira?.watch.mode !== "update" || options.dryRun) result = "would_update";
      else {
        if (options.signal?.aborted) throw new Error("Jira check stopped");
        const transition = await deps.transition(config, ticket.key);
        result = transition.kind;
        if (transition.kind === "updated") {
          upsertSessionJiraTicket({ sessionId, key: ticket.key, status: transition.status, statusCategory: "done" });
          if (config.jira.watch.comment && !options.signal?.aborted) await deps.comment(config, ticket.key, `## Marked done by Tack\n\n${verdict.reason}\n\n${prs.filter(p => p.state === "merged").map(p => `- ${p.url}`).join("\n")}\n\nSession: ${sessionId}`);
        }
      }
    }
  } catch (err) {
    if (options.signal?.aborted && result !== "updated") return;
    if (result !== "updated") result = "error";
    reason = (err as Error).message;
  }
  const ref = raw ? writeJiraCheckArtifact(sessionId, ticket.key, raw) : null;
  setJiraCheckResult(sessionId, ticket.key, result, reason, ref, marker);
}

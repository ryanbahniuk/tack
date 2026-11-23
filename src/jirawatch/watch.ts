import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { TackConfig } from "../config/schema";
import { claimJiraCheck, getDb, getSession, isSessionOpen, listSessionJiraTickets, listSessionPrs, releaseJiraCheck } from "../db";
import { closeJiraClient, refreshSessionJiraTickets } from "../projects/jira";
import { isAlive, selfInvocation } from "../process/self";
import { currentCodeVersion, currentConfigVersion } from "../process/version";
import { LOGS_DIR } from "../paths";
import { createWakeableSleep } from "../prwatch/watch";
import { completionDue, completionMarker, runCompletion } from "./completion";

export function spawnJiraWatcher(sessionId: string, config: TackConfig): number | null {
  const session = getSession(sessionId);
  if (!config.jira || config.jira.watch.mode === "off" || !session || !isSessionOpen(session) || !listSessionJiraTickets(sessionId).length || isAlive(session.jira_watch_pid)) return null;
  mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
  const fd = openSync(join(LOGS_DIR, sessionId, "jira-watch.log"), "a");
  const { command, args } = selfInvocation();
  const child = spawn(command, [...args, "__watch-jira", sessionId], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.on("error", () => {});
  child.unref();
  if (!child.pid) throw new Error("Failed to spawn Jira watcher");
  getDb().prepare(`UPDATE sessions SET jira_watch_pid = ? WHERE id = ?`).run(child.pid, sessionId);
  return child.pid;
}

export function triggerJiraWatch(sessionId: string, config: TackConfig): void {
  const session = getSession(sessionId);
  if (!config.jira || config.jira.watch.mode === "off" || !session || !isSessionOpen(session) || !listSessionJiraTickets(sessionId).length) return;
  if (session.jira_watch_pid && isAlive(session.jira_watch_pid)) {
    try { process.kill(session.jira_watch_pid, "SIGUSR1"); return; } catch {}
  }
  spawnJiraWatcher(sessionId, config);
}

export async function jiraWatchPass(sessionId: string, config: TackConfig, options: { force?: boolean; dryRun?: boolean; runner?: NonNullable<Parameters<typeof runCompletion>[3]>["runner"]; deps?: NonNullable<Parameters<typeof runCompletion>[3]>["deps"]; refresh?: typeof refreshSessionJiraTickets; signal?: AbortSignal } = {}): Promise<boolean> {
  if (!claimJiraCheck(sessionId)) return false;
  const claimedAt = getSession(sessionId)!.jira_check_claimed_at!;
  try {
    await (options.refresh ?? refreshSessionJiraTickets)(config, [sessionId]);
    const prs = listSessionPrs(sessionId);
    const checks = [{ name: "completion", due: completionDue, run: runCompletion }];
    for (const ticket of listSessionJiraTickets(sessionId)) {
      if (options.signal?.aborted) break;
      for (const check of checks) if (check.due(ticket, prs, options.force)) await check.run(config, sessionId, ticket, options);
    }
    return true;
  } finally { releaseJiraCheck(sessionId, claimedAt); }
}

export function jiraWatchFinished(sessionId: string, config: TackConfig): boolean {
  const session = getSession(sessionId), tickets = listSessionJiraTickets(sessionId), prs = listSessionPrs(sessionId);
  if (!session || !isSessionOpen(session) || !config.jira || config.jira.watch.mode === "off" || !tickets.length || tickets.every(t => t.status_category === "done")) return true;
  const marker = completionMarker(prs);
  return prs.every(p => p.state === "merged" || p.state === "closed") && tickets.filter(t => t.status_category !== "done").every(t => t.check_result && t.check_marker === marker);
}

export async function runJiraWatcher(sessionId: string, config: TackConfig): Promise<void> {
  const initial = getSession(sessionId);
  if (initial && initial.jira_watch_pid !== process.pid && isAlive(initial.jira_watch_pid)) return;
  getDb().prepare(`UPDATE sessions SET jira_watch_pid = ?, jira_watch_code_version = ?, jira_watch_config_version = ? WHERE id = ?`).run(process.pid, currentCodeVersion(), currentConfigVersion(), sessionId);
  const wait = createWakeableSleep();
  const abort = new AbortController();
  let stopped = false;
  const stop = () => { stopped = true; abort.abort(); void closeJiraClient(); wait.wake(); };
  const wake = () => wait.wake();
  process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGUSR1", wake);
  try {
    while (!stopped) {
      try {
        if (jiraWatchFinished(sessionId, config)) break;
        const session = getSession(sessionId);
        if (session?.jira_watch_pid !== process.pid && isAlive(session?.jira_watch_pid)) break;
        await jiraWatchPass(sessionId, config, { signal: abort.signal });
        if (jiraWatchFinished(sessionId, config)) break;
      } catch (err) { console.error(`Jira watch pass failed: ${(err as Error).message}`); }
      if (!stopped) await wait.sleep((config.jira?.watch.intervalSeconds ?? 300) * 1000);
    }
  } finally {
    process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGUSR1", wake);
    getDb().prepare(`UPDATE sessions SET jira_watch_pid = NULL WHERE id = ? AND jira_watch_pid = ?`).run(sessionId, process.pid);
    await closeJiraClient();
  }
}

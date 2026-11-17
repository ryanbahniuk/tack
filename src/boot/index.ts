import { existsSync } from "node:fs";
import type { TackConfig } from "../config/schema";
import { claimBootLink, finalizeBootLink, deleteOwnedBootLink, getBootLink, listAgents, listBootLinks, type BootLink } from "../db";
import { readArtifact, writeBootPlan } from "../artifacts/store";
import { buildPlan, resolveRecipe, type BootPlan } from "./recipe";
import { bootLogPath, processAlive, probe, runSteps, startRun, stopRun } from "./exec";
import { resolveBootTarget } from "./resolve";

export type BootOutcome = { project: string; status: "booted" | "failed" | "skipped" | "locked"; error?: string; holder?: string };
function teardown(row: BootLink): void {
  stopRun(row.pid);
  if (!row.plan_path) throw new Error("Stored boot plan is missing.");
  const plan = JSON.parse(readArtifact(row.plan_path)) as BootPlan;
  runSteps(plan, plan.down, row.log_path ?? bootLogPath(row.session_id, row.project_name));
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function bootSession(config: TackConfig, sessionId: string, opts: { projects?: string[]; agents?: Record<string, string>; steal?: boolean; onProgress?: (message: string) => void } = {}): BootOutcome[] {
  const agents = listAgents(sessionId);
  const requested = opts.projects?.length ? new Set(opts.projects) : null;
  const outcomes: BootOutcome[] = [];
  for (const name of requested ?? []) if (!config.projects.some(p => p.name === name)) outcomes.push({ project: name, status: "failed", error: `Unknown project ${name}.` });
  for (const project of config.projects) {
    if (requested ? !requested.has(project.name) : !agents.some(a => a.project_name === project.name && a.kind !== "pr_fix" && a.worktree_path && existsSync(a.worktree_path))) continue;
    if (!project.boot && !requested) { outcomes.push({ project: project.name, status: "skipped" }); continue; }
    opts.onProgress?.(`Booting ${project.name}...`);
    let row: BootLink | undefined;
    let claimed = false;
    try {
      const recipe = resolveRecipe(config, project);
      const target = resolveBootTarget(agents, project.name, opts.agents?.[project.name], existsSync);
      if (!target.ok) throw new Error(target.message);
      const plan = buildPlan(recipe, { project: project.name, path: target.path, session: sessionId, agent: target.agent.id, branch: target.agent.branch ?? "" });
      const planPath = writeBootPlan(sessionId, project.name, JSON.stringify(plan));
      const log = bootLogPath(sessionId, project.name);
      const now = new Date().toISOString();
      row = { lock: plan.lock, session_id: sessionId, agent_id: target.agent.id, project_name: project.name, worktree_path: target.path, pid: null, plan_path: planPath, log_path: log, status: "booting", error: null, started_at: now, updated_at: now };
      const claim = claimBootLink(row, !!opts.steal);
      if (!claim.claimed) { outcomes.push({ project: project.name, status: "locked", holder: claim.holder }); continue; }
      claimed = true;
      // The claim is committed before any shell command. Teardown remains best
      // effort because a stale or stolen process may already have disappeared.
      if (claim.previous) try { teardown(claim.previous); } catch (error) { opts.onProgress?.(`${project.name}: teardown: ${message(error)}`); }
      for (const old of listBootLinks(sessionId).filter(r => r.project_name === project.name && r.lock !== plan.lock)) {
        try { teardown(old); } catch (error) { opts.onProgress?.(`${project.name}: teardown: ${message(error)}`); }
        finally { deleteOwnedBootLink(old); }
      }
      runSteps(plan, plan.up, log, opts.onProgress);
      if (plan.run) opts.onProgress?.(`${project.name}: ${plan.run}`);
      row.pid = startRun(plan, log);
      row.status = "running"; row.updated_at = new Date().toISOString();
      if (!finalizeBootLink(row)) {
        const holder = getBootLink(row.lock)?.session_id;
        try { teardown(row); } catch (error) { opts.onProgress?.(`${project.name}: teardown: ${message(error)}`); }
        outcomes.push({ project: project.name, status: "locked", holder });
      } else outcomes.push({ project: project.name, status: "booted" });
    } catch (error) {
      if (row && claimed) {
        row.status = "failed"; row.error = message(error); row.updated_at = new Date().toISOString();
        if (!finalizeBootLink(row)) {
          const holder = getBootLink(row.lock)?.session_id;
          try { teardown(row); } catch (cleanupError) { opts.onProgress?.(`${project.name}: teardown: ${message(cleanupError)}`); }
          outcomes.push({ project: project.name, status: "locked", holder }); continue;
        }
      }
      outcomes.push({ project: project.name, status: "failed", error: message(error) });
    }
  }
  return outcomes;
}
export function unbootSession(_config: TackConfig | null, sessionId: string, opts: { projects?: string[] } = {}): BootOutcome[] {
  return listBootLinks(sessionId).filter(r => !opts.projects?.length || opts.projects.includes(r.project_name)).map(row => {
    try { teardown(row); return { project: row.project_name, status: "booted" as const }; }
    catch (error) { return { project: row.project_name, status: "failed" as const, error: message(error) }; }
    finally { deleteOwnedBootLink(row); }
  });
}
export function bootStatus(_config: TackConfig | null, sessionId: string) {
  return listBootLinks(sessionId).map(row => {
    const plan = row.plan_path ? JSON.parse(readArtifact(row.plan_path)) as BootPlan : null;
    return { ...row, url: plan?.url, alive: plan?.run ? processAlive(row.pid) : null, healthy: plan ? probe(plan, row.log_path ?? bootLogPath(sessionId, row.project_name)) : null };
  });
}

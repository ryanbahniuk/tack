import { existsSync } from "node:fs";
import type { TackConfig } from "../config/schema";
import { createManualAgent, listAgents, type AgentRow, type SessionPrRow } from "../db";
import { createWorktree, createManualPrWorktree, untrackedFiles, worktreeDiff } from "../worktree/worktree";
import { shortId } from "../util/id";

/**
 * Manual workspaces: a clean, session-scoped worktree a human edits by hand. Each
 * one is an `agents` row with `kind = "manual"` so it shows up wherever workers do
 * (check_agents, check_conflicts, open_pr, the dashboard), but it has no runtime
 * conversation — runners, resume and continue_agent all refuse it.
 */

/** Thrown wherever something would run a manual row as a runtime conversation. */
export const MANUAL_NOT_RUNNABLE =
  "is a manual workspace (the human's hand edits) with no agent conversation; it is never run, resumed or continued";

/** Projects a new manual workspace could target, in the order a chooser shows them:
 * projects this session's agents already work on first (the likely pick), then the
 * rest of the config. Session projects missing from the config are dropped — a
 * worktree needs the project's repo path. */
export function manualProjectCandidates(projects: string[], sessionAgents: Pick<AgentRow, "project_name">[]): string[] {
  return sessionFirst(projects, sessionProjects(projects, sessionAgents));
}

const sessionFirst = (projects: string[], fromSession: string[]) =>
  [...fromSession, ...projects.filter(p => !fromSession.includes(p))];

/** Distinct configured projects the session's agents use, in first-use order. */
function sessionProjects(projects: string[], sessionAgents: Pick<AgentRow, "project_name">[]): string[] {
  return [...new Set(sessionAgents.map(a => a.project_name))].filter(p => projects.includes(p));
}

export type ManualProjectResolution =
  | { ok: true; project: string }
  | { ok: false; message: string; candidates: string[] };

/**
 * Which project `tack session edit <session> --new [project]` targets. An explicit
 * name must be configured. Omitted resolves only when unambiguous — the only
 * configured project, or the only project the session's agents use — so the CLI
 * never silently forks a worktree off the wrong repo.
 */
export function resolveManualProject(
  projects: string[], sessionAgents: Pick<AgentRow, "project_name">[], requested: string | undefined,
): ManualProjectResolution {
  const fromSession = sessionProjects(projects, sessionAgents);
  const candidates = sessionFirst(projects, fromSession);
  if (requested !== undefined && requested !== "") {
    if (projects.includes(requested)) return { ok: true, project: requested };
    return { ok: false, message: `Unknown project "${requested}".`, candidates };
  }
  if (projects.length === 0) return { ok: false, message: "No projects are configured.", candidates };
  if (projects.length === 1) return { ok: true, project: projects[0]! };
  if (fromSession.length === 1) return { ok: true, project: fromSession[0]! };
  return { ok: false, message: "Several projects could host this workspace. Pass a project name.", candidates };
}

/**
 * Creates a manual workspace: a fresh `tack/<session>/<id>` worktree forked from the
 * up-to-date remote default branch (fork point pinned), then its `manual` row. The
 * worktree comes first so a failed fetch/checkout leaves no orphan row behind.
 */
export function createManualWorkspace(config: TackConfig, sessionId: string, projectName: string, pr?: SessionPrRow): AgentRow {
  const project = config.projects.find(p => p.name === projectName);
  if (!project) throw new Error(`Unknown project "${projectName}"`);
  if (pr) {
    if (pr.session_id !== sessionId || pr.project_name !== projectName || !pr.head_branch || !["open", "draft"].includes(pr.state ?? "")) throw new Error("PR is not an open session PR with a head branch");
    const existing = listAgents(sessionId).find(a => a.kind === "manual" && a.session_pr_id === pr.id && a.worktree_path && existsSync(a.worktree_path));
    if (existing) return existing;
  }
  const id = shortId("agt");
  const wt = pr ? createManualPrWorktree(project.path, sessionId, id, pr.head_branch!) : createWorktree(project.path, sessionId, id);
  return createManualAgent({ id, sessionId, projectName, worktreePath: wt.path, branch: wt.branch, diffBase: wt.base, sessionPrId: pr?.id });
}

/**
 * The live diff of a manual workspace against its fork point. Unlike a worker, a
 * manual row never "finishes", so there is no captured diff to read; this reads the
 * worktree as it is now. `git diff` can't see untracked files, so they're listed
 * separately (open_pr's commit would include them). Empty when nothing changed or the
 * worktree is gone.
 */
export function manualWorkspaceDiff(agent: AgentRow, repo: string): string {
  if (!agent.worktree_path || !agent.branch || !existsSync(agent.worktree_path)) return "";
  const diff = worktreeDiff({ repo, path: agent.worktree_path, branch: agent.branch, base: agent.diff_base ?? "HEAD" },
    agent.diff_base ?? undefined);
  const untracked = untrackedFiles(agent.worktree_path);
  return diff + (untracked.length ? `${diff ? "\n" : ""}# Untracked files (not yet committed):\n${untracked.map(f => `#   ${f}`).join("\n")}\n` : "");
}

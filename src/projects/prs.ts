import { spawnSync } from "node:child_process";
import type { TackConfig } from "../config/schema";
import { listAgents, listSessionPrs, upsertSessionPr, type SessionPrRow } from "../db";
import { sessionIdFromPrBranch } from "../worktree/worktree";

interface GhPr {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED
  headRefName: string;
}

export interface DiscoverResult {
  prs: SessionPrRow[];
  /** Project repos we couldn't query (no `gh`, not a GitHub remote, etc.). */
  skipped: Array<{ project: string; reason: string }>;
  ghMissing: boolean;
}

function ghAvailable(): boolean {
  return spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;
}

function ghPrList(repoPath: string): GhPr[] {
  const r = spawnSync(
    "gh",
    ["pr", "list", "--state", "all", "--limit", "200", "--json", "number,url,title,state,headRefName"],
    { cwd: repoPath, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "gh pr list failed").trim().split("\n")[0]);
  try {
    return JSON.parse(r.stdout || "[]") as GhPr[];
  } catch {
    return [];
  }
}

/**
 * Discovers the PRs a session produced by scanning the GitHub repos it touched for
 * branches following our `tack/pr/<sessionId>/…` nomenclature, then records each in
 * `session_prs`. Best-effort: repos without `gh`/a GitHub remote are reported in
 * `skipped`, not fatal.
 */
export function discoverSessionPrs(config: TackConfig, sessionId: string): DiscoverResult {
  const skipped: DiscoverResult["skipped"] = [];
  if (!ghAvailable()) return { prs: listSessionPrs(sessionId), skipped, ghMissing: true };

  // Which projects did this session touch, and via which agent (most recent wins)?
  const agentByProject = new Map<string, string>();
  for (const a of listAgents(sessionId)) agentByProject.set(a.project_name, a.id);

  for (const [projectName, agentId] of agentByProject) {
    const project = config.projects.find((p) => p.name === projectName);
    if (!project) {
      skipped.push({ project: projectName, reason: "no longer in config" });
      continue;
    }
    let prs: GhPr[];
    try {
      prs = ghPrList(project.path);
    } catch (err) {
      skipped.push({ project: projectName, reason: (err as Error).message });
      continue;
    }
    for (const pr of prs) {
      if (sessionIdFromPrBranch(pr.headRefName) !== sessionId) continue;
      upsertSessionPr({
        sessionId,
        url: pr.url,
        agentId,
        projectName,
        number: pr.number,
        title: pr.title,
        state: pr.state.toLowerCase(),
        headBranch: pr.headRefName,
      });
    }
  }

  return { prs: listSessionPrs(sessionId), skipped, ghMissing: false };
}

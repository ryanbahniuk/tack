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

export interface OpenPrInput {
  /** The project repo root (where `gh` runs and the branch is pushed from). */
  repoPath: string;
  /** The agent's internal worktree branch holding its commits. */
  localBranch: string;
  /** The `tack/pr/<sessionId>/<slug>` branch to push it to (discovery nomenclature). */
  prBranch: string;
  title: string;
  body: string;
  /** Base branch to target; omitted lets `gh` use the repo's default branch. */
  base?: string;
  draft?: boolean;
}

export interface OpenPrResult {
  url: string;
  number: number | null;
  headBranch: string;
}

/**
 * Opens a PR for an agent's committed work on the supervisor's behalf: pushes the
 * agent's worktree branch to the remote under the `tack/pr/<sessionId>/…`
 * nomenclature (so `discoverSessionPrs` can tie it back) and runs `gh pr create`.
 * The supervisor — not agents — owns this step, so it can summarize and get the
 * human's approval first. Throws with a one-line reason on failure to report.
 */
export function openSessionPr(input: OpenPrInput): OpenPrResult {
  if (!ghAvailable())
    throw new Error("`gh` CLI not found or not on PATH — cannot open a PR. Install and authenticate gh first.");
  const push = spawnSync(
    "git",
    ["push", "origin", `${input.localBranch}:refs/heads/${input.prBranch}`],
    { cwd: input.repoPath, encoding: "utf8" },
  );
  if (push.status !== 0) throw new Error(`git push failed: ${lastLine(push.stderr || push.stdout)}`);

  const args = ["pr", "create", "--head", input.prBranch, "--title", input.title, "--body", input.body];
  if (input.base) args.push("--base", input.base);
  if (input.draft) args.push("--draft");
  const create = spawnSync("gh", args, { cwd: input.repoPath, encoding: "utf8" });
  if (create.status !== 0) throw new Error(`gh pr create failed: ${lastLine(create.stderr || create.stdout)}`);

  const url = firstUrl(create.stdout ?? "");
  return { url, number: numberFromPrUrl(url), headBranch: input.prBranch };
}

function lastLine(s: string): string {
  return (s || "").trim().split("\n").filter(Boolean).pop() ?? "unknown error";
}

function firstUrl(out: string): string {
  return out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("http")) ?? out.trim();
}

function numberFromPrUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
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

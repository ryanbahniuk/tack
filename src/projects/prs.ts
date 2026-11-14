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
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
}

export interface DiscoverResult {
  prs: SessionPrRow[];
  /** Project repos we couldn't query (no `gh`, not a GitHub remote, etc.). */
  skipped: Array<{ project: string; reason: string }>;
  ghMissing: boolean;
}

// `gh` presence can't change mid-process, and this is about to be probed on every
// refresh tick (up to once/minute per dashboard) — memoize instead of re-spawning.
let ghAvailableCache: boolean | null = null;

function ghAvailable(): boolean {
  if (ghAvailableCache === null) {
    ghAvailableCache = spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;
  }
  return ghAvailableCache;
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

async function ghPrListAsync(repoPath: string): Promise<GhPr[]> {
  const proc = Bun.spawn(
    ["gh", "pr", "list", "--state", "all", "--limit", "200", "--json", "number,url,title,state,headRefName,mergeable"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error((stderr || stdout || "gh pr list failed").trim().split("\n")[0]);
  try {
    return JSON.parse(stdout || "[]") as GhPr[];
  } catch {
    return [];
  }
}

/**
 * Refreshes PR status for many sessions at once — the dashboard's background poll,
 * covering every currently-listed session with one `gh pr list` per distinct project
 * rather than one per session. Async end-to-end (`Bun.spawn`, not `spawnSync`) since
 * this runs on a timer inside the Ink render loop and must never block a frame.
 * Best-effort, same contract as before: a project missing from config or a failing
 * `gh` call lands in `skipped`, never throws.
 */
export async function refreshSessionPrs(config: TackConfig, sessionIds: string[]): Promise<DiscoverResult> {
  const skipped: DiscoverResult["skipped"] = [];
  const union = () => sessionIds.flatMap((id) => listSessionPrs(id));
  if (!ghAvailable()) return { prs: union(), skipped, ghMissing: true };

  // Which projects did each session touch, and via which agent (most recent wins)?
  // Inverted to project -> session -> agent so we can issue one `gh pr list` per
  // project and fan its results back out to whichever sessions own those branches.
  const sessionsByProject = new Map<string, Map<string, string>>();
  for (const sessionId of sessionIds) {
    for (const a of listAgents(sessionId)) {
      if (!sessionsByProject.has(a.project_name)) sessionsByProject.set(a.project_name, new Map());
      sessionsByProject.get(a.project_name)!.set(sessionId, a.id);
    }
  }

  for (const [projectName, agentBySession] of sessionsByProject) {
    const project = config.projects.find((p) => p.name === projectName);
    if (!project) {
      skipped.push({ project: projectName, reason: "no longer in config" });
      continue;
    }
    let prs: GhPr[];
    try {
      prs = await ghPrListAsync(project.path);
    } catch (err) {
      skipped.push({ project: projectName, reason: (err as Error).message });
      continue;
    }
    for (const pr of prs) {
      const sessionId = sessionIdFromPrBranch(pr.headRefName);
      if (!sessionId) continue;
      const agentId = agentBySession.get(sessionId);
      if (!agentId) continue; // not one of the sessions we were asked to refresh
      upsertSessionPr({
        sessionId,
        url: pr.url,
        agentId,
        projectName,
        number: pr.number,
        title: pr.title,
        state: pr.state.toLowerCase(),
        headBranch: pr.headRefName,
        mergeable: pr.mergeable ? pr.mergeable.toLowerCase() : null,
      });
    }
  }

  return { prs: union(), skipped, ghMissing: false };
}

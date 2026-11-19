import type { Project, TackConfig } from "../config/schema";
import {
  deleteLinkedSessionPr,
  getSessionPr,
  insertBaselinePrFeedback,
  listSessionPrs,
  markSessionPrLinked,
  prFeedbackSourceIds,
  setSessionPrStatus,
  upsertSessionPr,
  type SessionPrRow,
} from "../db";
import { writePrFeedbackArtifact } from "../artifacts/store";
import * as prs from "../projects/prs";
import { prFixBusy } from "../prwatch/watch";

/**
 * `link_pr` / `unlink_pr`: adopting an existing GitHub PR into a session — the PR
 * analog of `link_jira_ticket`. A linked PR is an ordinary `session_prs` row (with
 * `linked_at` set and no producing agent), so `check_prs`, `fix_pr`, the watcher and
 * the dashboard pick it up unchanged. Everything here is local bookkeeping plus
 * read-only `gh` calls: nothing is ever written to GitHub.
 */

export const LINK_PR_NEXT = "Use fix_pr with this PR to add changes; pass includeExisting: true to address existing comments. Don't open a new PR.";

export interface LinkPrResult {
  ok: true;
  pr: number;
  url: string;
  project: string;
  title: string;
  state: string;
  headBranch: string;
  baseBranch: string;
  /** History items recorded as already handled by this link (0 on a re-link). */
  baselined: number;
  baselineWarning?: string;
  /** The PR was opened by this session already; nothing was changed. */
  alreadySessionPr?: boolean;
  next: string;
}

/** A git remote URL's `owner/repo`, from the https, `ssh://` and scp-style
 * (`git@host:owner/repo.git`) forms; null for anything else (local paths, etc.). */
export function parseRemoteRepo(url: string): { owner: string; repo: string } | null {
  const u = url.trim();
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u) ??
    /^(?:[^@/\s]+@)?[^:/\s]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** `git remote get-url origin` in `repoPath`; rejects when there's no such remote. */
export async function originRemoteUrl(repoPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "remote", "get-url", "origin"], { cwd: repoPath, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0 || !out.trim()) throw new Error("no origin remote");
  return out.trim();
}

/**
 * The configured project whose GitHub repo is `owner/repo` (case-insensitive).
 * When `wanted` names a project it must be that one. Projects whose repo can't be
 * resolved (not a GitHub remote, gh offline) are skipped; if nothing matches the
 * error names the repo and says it isn't a configured project.
 *
 * Fast path first: each project's `origin` remote is parsed locally, because the
 * auto-link hook runs in a fresh process where `ghRepo`'s cache is empty and one
 * `gh repo view` per configured project would stall the human's prompt. Only
 * projects whose origin couldn't be read or parsed fall back to `ghRepo`. A project
 * whose origin parses to a different repo is not asked again: origin is where Tack
 * pushes (`pushBranch`), so it couldn't add to that PR's branch anyway.
 */
export async function resolveLinkProject(
  config: Pick<TackConfig, "projects">,
  ref: Pick<prs.GithubPrRef, "owner" | "repo">,
  wanted?: string,
  ghRepo: typeof prs.ghRepo = prs.ghRepo,
  remoteUrl: (repoPath: string) => Promise<string> = originRemoteUrl,
): Promise<Project> {
  const slug = `${ref.owner}/${ref.repo}`;
  const same = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase() === slug.toLowerCase();
  const candidates = wanted ? config.projects.filter((p) => p.name === wanted) : config.projects;
  if (wanted && candidates.length === 0) throw new Error(`"${wanted}" isn't a configured project.`);
  const remotes = await Promise.all(candidates.map(async (project) => {
    try {
      return parseRemoteRepo(await remoteUrl(project.path));
    } catch {
      return null;
    }
  }));
  const local = candidates.find((_, i) => remotes[i] && same(remotes[i]!.owner, remotes[i]!.repo));
  if (local) return local;
  for (const [i, project] of candidates.entries()) {
    if (remotes[i]) continue;
    let repo: { owner: string; name: string };
    try {
      repo = await ghRepo(project.path);
    } catch {
      continue;
    }
    if (same(repo.owner, repo.name)) return project;
  }
  throw new Error(
    wanted
      ? `Project "${wanted}" isn't the GitHub repo ${slug}.`
      : `${slug} isn't a configured project, so its PR can't be linked.`,
  );
}

/**
 * Records a PR's pre-existing feedback as handled (`not_applicable`, no reply) so
 * only feedback arriving after the link is acted on. Review threads are baselined
 * resolved or not, so un-resolving an old thread later doesn't resurrect it.
 * Skips ids already recorded (a re-link never re-baselines). Returns the count added.
 */
export async function baselinePrFeedback(
  sessionId: string,
  pr: Pick<SessionPrRow, "id" | "url">,
  project: Project,
  number: number,
  headSha: string | null,
): Promise<number> {
  const status = await prs.fetchPrStatus(project.path, number);
  const threads = (await prs.fetchReviewThreads(project.path, number)).map((t) => ({ ...t, isResolved: false }));
  const known = prFeedbackSourceIds(pr.id);
  const items = prs.normalizeFeedback(status, threads, known);
  const checks = await prs.fetchPrChecks(project.path, number);
  items.push(...prs.normalizeCiFailures(checks, status.headRefOid ?? headSha, known));
  let added = 0;
  for (const item of items) {
    if (insertBaselinePrFeedback({
      sessionPrId: pr.id,
      sourceId: item.sourceId,
      sourceKind: item.kind,
      author: item.author,
      authorIsBot: item.isBot,
      url: item.url,
      path: item.path ?? null,
      line: item.line ?? null,
      inReplyTo: item.inReplyTo ?? null,
      bodyRef: writePrFeedbackArtifact(sessionId, pr.id, item.sourceId, "body", item.body),
    })) added++;
  }
  return added;
}

/**
 * Adopts the PR at `url` into the session: parse → match a configured project →
 * `gh pr view` → refuse merged/closed and fork PRs (Tack pushes non-force to
 * `origin`, so it can only add to same-repo branches) → upsert the row, stamp
 * `linked_at` + `ready_promoted_at`, and baseline existing feedback. Idempotent.
 * The baseline is best-effort: a failure still links, with `baselineWarning`.
 */
export async function linkSessionPr(input: {
  sessionId: string;
  config: Pick<TackConfig, "projects">;
  url: string;
  project?: string;
}): Promise<LinkPrResult> {
  const ref = prs.parseGithubPrUrl(input.url);
  if (!ref)
    throw new Error(`"${input.url}" isn't a GitHub pull request URL (expected https://github.com/<owner>/<repo>/pull/<n>).`);
  const project = await resolveLinkProject(input.config, ref, input.project);
  const gh = await prs.fetchPrForLink(project.path, ref.number);
  const tag = `${ref.owner}/${ref.repo}#${ref.number}`;
  const ghState = gh.state.toLowerCase();
  if (ghState === "merged" || gh.mergedAt) throw new Error(`${tag} is already merged; there's nothing to add to it.`);
  if (ghState === "closed") throw new Error(`${tag} is closed; reopen it on GitHub first to link it.`);
  if (gh.isCrossRepository)
    throw new Error(`${tag} comes from a fork; Tack can only push to branches in ${ref.owner}/${ref.repo} itself.`);

  // Draft rows are stored as "draft" (gh reports OPEN + isDraft) — see pollPrStatus.
  const state = gh.isDraft ? "draft" : ghState;
  const mergeable = prs.toMergeable(gh.mergeable);
  // A PR this session opened itself is already tracked; marking it linked would
  // latch its readiness and make it unlinkable, so leave it as it is.
  const existing = listSessionPrs(input.sessionId).find((p) => p.url === gh.url);
  if (existing && !existing.linked_at) {
    return {
      ok: true, pr: gh.number, url: gh.url, project: project.name, title: gh.title, state,
      headBranch: gh.headRefName, baseBranch: gh.baseRefName, baselined: 0,
      alreadySessionPr: true, next: LINK_PR_NEXT,
    };
  }
  upsertSessionPr({
    sessionId: input.sessionId,
    url: gh.url,
    projectName: project.name,
    number: gh.number,
    title: gh.title,
    state,
    headBranch: gh.headRefName,
    mergeable,
  });
  const row = listSessionPrs(input.sessionId).find((p) => p.url === gh.url)!;
  setSessionPrStatus(row.id, {
    state, mergeable, baseBranch: gh.baseRefName, headSha: gh.headRefOid, title: gh.title,
  });
  markSessionPrLinked(row.id);

  let baselined = 0;
  let baselineWarning: string | undefined;
  try {
    baselined = await baselinePrFeedback(input.sessionId, row, project, gh.number, gh.headRefOid);
  } catch (err) {
    baselineWarning =
      `Linked, but recording the PR's existing feedback as already handled failed (${(err as Error).message}); ` +
      "the PR watcher may treat pre-existing comments or failing checks as new.";
  }
  return {
    ok: true,
    pr: gh.number,
    url: gh.url,
    project: project.name,
    title: gh.title,
    state,
    headBranch: gh.headRefName,
    baseBranch: gh.baseRefName,
    baselined,
    ...(baselineWarning ? { baselineWarning } : {}),
    next: LINK_PR_NEXT,
  };
}

/**
 * Removes a linked PR from the session. Only rows `link_pr` adopted (PRs Tack opened
 * stay), and never while a fix for it is running or awaiting its push/replies.
 * Local only — GitHub is untouched.
 */
export function unlinkSessionPr(pr: SessionPrRow): { ok: true; pr: number | null; url: string } {
  const tag = `PR #${pr.number ?? "?"}`;
  if (!pr.linked_at)
    throw new Error(`${tag} was opened by this session, not linked with link_pr, so it can't be unlinked.`);
  if (prFixBusy(pr.id))
    throw new Error(`A fix for ${tag} is still running or awaiting its push/replies; unlink it once that has finished.`);
  if (!deleteLinkedSessionPr(pr.id) && getSessionPr(pr.id)) throw new Error(`${tag} couldn't be unlinked.`);
  return { ok: true, pr: pr.number, url: pr.url };
}

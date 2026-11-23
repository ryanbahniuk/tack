import { spawnSync } from "node:child_process";
import type { Project, RuntimeKind, TackConfig } from "../config/schema";
import {
  listAgents,
  listSessionPrs,
  upsertSessionPr,
  type PrCiStatus,
  type PrFeedbackKind,
  type PrMergeable,
  type PrReviewStatus,
  type SessionPrRow,
} from "../db";
import { sessionIdFromPrBranch } from "../worktree/worktree";

interface GhPr {
  mergedAt?: string | null;
  mergeCommit?: { oid: string } | null;
  number: number;
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED
  headRefName: string;
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
}

/** Normalizes gh's mergeable string into the stored enum (null when absent). Shared
 * by the dashboard's discovery refresh and the PR watcher so both write the same values. */
export function toMergeable(v: string | null | undefined): PrMergeable | null {
  if (v === "MERGEABLE" || v === "CONFLICTING" || v === "UNKNOWN") return v;
  return v ? "UNKNOWN" : null;
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
  /** The Jira-named or `tack/pr/<sessionId>/<slug>` branch to push it to. */
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

/** Result of an async subprocess: exit code plus captured output. */
interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command asynchronously (`Bun.spawn`) and captures its output. Everything
 * PR watch does runs on a timer (the watcher loop, the dashboard's refresh), so it
 * must never block on `spawnSync`. Never throws for a non-zero exit — callers decide
 * — but a missing binary still surfaces as a rejected spawn, which callers catch.
 */
async function run(cmd: string[], cwd: string): Promise<ProcResult> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Runs `cmd`, returning stdout, or throwing a one-line reason on failure. */
async function runOk(cmd: string[], cwd: string, what: string): Promise<string> {
  const r = await run(cmd, cwd);
  if (r.code !== 0) throw new Error(`${what} failed: ${lastLine(r.stderr || r.stdout)}`);
  return r.stdout;
}

/**
 * Pushes a local branch to `refs/heads/<remoteBranch>` on origin — ALWAYS non-force.
 * Shared by `openSessionPr` (first push of an agent's work) and the PR watcher
 * (pushing a fix agent's commits onto an existing PR branch). A non-fast-forward
 * means someone else moved the PR branch since we forked; we report that back as a
 * rejection rather than overwrite their work. Never throws.
 */
export async function pushBranch(
  repoPath: string,
  localBranch: string,
  remoteBranch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await run(["git", "push", "origin", `${localBranch}:refs/heads/${remoteBranch}`], repoPath);
    if (r.code === 0) return { ok: true };
    return { ok: false, error: lastLine(r.stderr || r.stdout) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Opens a PR for an agent's committed work on the supervisor's behalf: pushes the
 * agent's worktree branch to the remote under a Jira-named or session-prefixed
 * name and runs `gh pr create`.
 * The supervisor — not agents — owns this step, so it can summarize and get the
 * human's approval first. Throws with a one-line reason on failure to report.
 */
export async function openSessionPr(input: OpenPrInput): Promise<OpenPrResult> {
  if (!ghAvailable())
    throw new Error("`gh` CLI not found or not on PATH — cannot open a PR. Install and authenticate gh first.");
  const push = await pushBranch(input.repoPath, input.localBranch, input.prBranch);
  if (!push.ok) throw new Error(`git push failed: ${push.error}`);

  const args = ["pr", "create", "--head", input.prBranch, "--title", input.title, "--body", input.body];
  if (input.base) args.push("--base", input.base);
  if (input.draft) args.push("--draft");
  const stdout = await runOk(["gh", ...args], input.repoPath, "gh pr create");

  const url = firstUrl(stdout);
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

/** A GitHub pull request URL, split into its parts (see `parseGithubPrUrl`). */
export interface GithubPrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

// `https://<host>/<owner>/<repo>/pull/<n>`, optionally followed by a sub-page
// (`/files`, `/commits`, `/checks`, …), a query, or a fragment. Any host is accepted
// so GitHub Enterprise URLs parse too; owner/repo use GitHub's name alphabet.
const GITHUB_PR_URL_RE =
  /^https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:\/[^?#\s]*)?(?:\?[^#\s]*)?(?:#\S*)?$/;

/** Parses a GitHub PR URL (`link_pr`'s input); null for anything else. */
export function parseGithubPrUrl(url: string): GithubPrRef | null {
  const m = GITHUB_PR_URL_RE.exec(url.trim());
  if (!m) return null;
  const number = Number(m[4]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { host: m[1]!.toLowerCase(), owner: m[2]!, repo: m[3]!.replace(/\.git$/, ""), number };
}

/** What `link_pr` needs to adopt an existing PR (`gh pr view`'s JSON). */
export interface LinkablePr {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  mergeable: string;
  mergedAt: string | null;
  isCrossRepository: boolean;
}

/** Fetches a PR's metadata for `link_pr`. Read-only; throws a one-line reason on failure. */
export async function fetchPrForLink(repoPath: string, number: number): Promise<LinkablePr> {
  const out = await runOk(
    ["gh", "pr", "view", String(number), "--json",
      "number,url,title,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergedAt,isCrossRepository"],
    repoPath,
    "gh pr view",
  );
  return JSON.parse(out) as LinkablePr;
}

async function ghPrListAsync(repoPath: string): Promise<GhPr[]> {
  const proc = Bun.spawn(
    ["gh", "pr", "list", "--state", "all", "--limit", "200", "--json", "number,url,title,state,headRefName,mergeable,mergedAt"],
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

/** Associate stored head branches with their sessions for a single project. */
export function sessionPrBranches(rows: SessionPrRow[], projectName: string): Map<string, string> {
  const branches = new Map<string, string>();
  for (const row of rows) {
    if (row.project_name === projectName && row.head_branch) branches.set(row.head_branch, row.session_id);
  }
  return branches;
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
  // The agent is only a best-effort guess used when a PR is first discovered (an
  // existing row keeps its real producing agent — see `upsertSessionPr`), and PR-fix
  // agents are skipped: they never produce a PR, they only amend an existing one.
  const sessionsByProject = new Map<string, Map<string, string>>();
  for (const sessionId of sessionIds) {
    for (const a of listAgents(sessionId)) {
      if (a.kind === "pr_fix") continue;
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
    const knownBranches = sessionPrBranches(union(), projectName);
    for (const pr of prs) {
      const sessionId = sessionIdFromPrBranch(pr.headRefName) ?? knownBranches.get(pr.headRefName);
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
        mergeable: toMergeable(pr.mergeable),
        mergedAt: pr.mergedAt,
      });
    }
  }

  return { prs: union(), skipped, ghMissing: false };
}

// ---------------------------------------------------------------------------
// PR watch: status, review threads, feedback normalization, replies
// ---------------------------------------------------------------------------

/**
 * The literal marker Tack puts in every reply it posts. Any comment containing it is
 * Tack's own and is never ingested as feedback — that's what keeps the watcher from
 * replying to itself in a loop.
 */
export const PR_WATCH_MARKER = "<!-- tack:pr-watch -->";

/** A GitHub actor as `gh` reports it (shape differs slightly between `gh pr view`
 * and GraphQL; every field is optional so either parses). */
export interface GhAuthor {
  login?: string;
  /** `gh pr view` marks bot authors this way on recent versions. */
  is_bot?: boolean;
  /** GraphQL: `Bot` for app/bot accounts. */
  __typename?: string;
}

/** An issue-level conversation comment from GraphQL (stable node id). */
export interface GhIssueComment {
  id: string;
  author?: GhAuthor | null;
  body?: string | null;
  url?: string | null;
  /** Hidden by a maintainer (outdated/spam/resolved) — not live feedback. */
  isMinimized?: boolean;
}

/** A submitted review from GraphQL (its summary body; inline
 * comments arrive separately as review threads). */
export interface GhReview {
  id: string;
  author?: GhAuthor | null;
  body?: string | null;
  state?: string | null;
  url?: string | null;
}

/** PR metadata from `gh pr view`, with conversation feedback from GraphQL. */
export interface PrStatus {
  mergedAt?: string | null;
  mergeCommit?: { oid: string } | null;
  state: string; // OPEN | MERGED | CLOSED
  isDraft?: boolean;
  mergeable: PrMergeable | string | null;
  mergeStateStatus?: string | null;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED, or empty when the repo requires no reviews. */
  reviewDecision?: string | null;
  baseRefName: string | null;
  headRefOid: string | null;
  headRefName: string | null;
  url: string;
  title: string | null;
  comments: GhIssueComment[];
  reviews: GhReview[];
}

export interface ReviewThreadComment {
  databaseId: number;
  author?: GhAuthor | null;
  body?: string | null;
  path?: string | null;
  line?: number | null;
  url?: string | null;
}

export interface ReviewThread {
  isResolved: boolean;
  comments: { nodes: ReviewThreadComment[] };
}

/** One normalized piece of PR feedback — the unit a fix agent decides on and Tack
 * replies to. `sourceId` is GitHub's id for the comment (review-thread comments use
 * the numeric databaseId, which the REST replies endpoint needs). CI ids include
 * the head SHA and workflow/check name so each head is handled once. */
export interface PrFeedbackItem {
  sourceId: string;
  kind: PrFeedbackKind;
  author: string;
  body: string;
  url: string;
  path?: string;
  line?: number;
  /** review_thread only: the thread's root comment id (what a reply attaches to). */
  inReplyTo?: string;
  /** Whether the author is a bot/app (bots are still included as feedback). */
  isBot?: boolean;
}

const PR_STATUS_FIELDS =
  "state,mergedAt,mergeCommit,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefOid,headRefName,url,title";

/** Fetches a PR's state, mergeability, refs, conversation comments, and reviews. */
export async function fetchPrStatus(repoPath: string, number: number): Promise<PrStatus> {
  const out = await runOk(
    ["gh", "pr", "view", String(number), "--json", PR_STATUS_FIELDS],
    repoPath,
    "gh pr view",
  );
  const raw = JSON.parse(out) as Partial<PrStatus>;
  const [comments, reviews] = await Promise.all([
    fetchConversationItems<GhIssueComment>(repoPath, number, "comments"),
    fetchConversationItems<GhReview>(repoPath, number, "reviews"),
  ]);
  return {
    state: raw.state ?? "OPEN",
    mergedAt: raw.mergedAt ?? null,
    mergeCommit: raw.mergeCommit ?? null,
    isDraft: raw.isDraft ?? false,
    mergeable: raw.mergeable ?? null,
    mergeStateStatus: raw.mergeStateStatus ?? null,
    reviewDecision: raw.reviewDecision ?? null,
    baseRefName: raw.baseRefName ?? null,
    headRefOid: raw.headRefOid ?? null,
    headRefName: raw.headRefName ?? null,
    url: raw.url ?? "",
    title: raw.title ?? null,
    comments,
    reviews,
  };
}

/** Checks on the PR head, shared by gh's JSON output and the GraphQL fallback. */
export interface PrCheck {
  name?: string | null;
  state?: string | null;
  bucket?: string | null;
  link?: string | null;
  workflow?: string | null;
  description?: string | null;
  completedAt?: string | null;
}

/**
 * Normal check outcomes exit 1 (failed) or 8 (pending); stdout is authoritative.
 * A PR with no checks also exits non-zero, with empty stdout and a "no (required)
 * checks reported" stderr; that is a real empty suite (green), not a fetch error.
 */
export async function fetchPrChecks(repoPath: string, number: number): Promise<PrCheck[]> {
  const result = await run([
    "gh", "pr", "checks", String(number), "--json",
    "name,state,bucket,link,workflow,description,completedAt",
  ], repoPath);
  if (result.stdout.trim() === "" && /no (required )?checks reported/i.test(result.stderr)) return [];
  if (!/unknown flag.*--json|unknown flag: json/i.test(result.stderr)) {
    return JSON.parse(result.stdout) as PrCheck[];
  }

  // Older gh versions lack checks --json. Page the rollup so a pending check past
  // the first hundred still prevents us from acting on a partially settled suite.
  const { owner, name } = await ghRepo(repoPath);
  const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { statusCheckRollup {
        contexts(first: 100, after: $cursor) {
          nodes {
            ... on CheckRun { name status conclusion detailsUrl completedAt
              checkSuite { workflowRun { workflow { name } } } }
            ... on StatusContext { context state targetUrl description }
          }
          pageInfo { hasNextPage endCursor }
        }
      } } } }
    } }
  }`;
  const checks: PrCheck[] = [];
  let cursor: string | null = null;
  do {
    const args = ["gh", "api", "graphql", "-f", `query=${query}`,
      "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const raw = JSON.parse((await run(args, repoPath)).stdout);
    if (raw.errors) throw new Error("gh statusCheckRollup returned GraphQL errors");
    const page = raw.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    for (const node of page?.nodes ?? []) {
      checks.push({
        name: node.name ?? node.context,
        state: node.status && node.status !== "COMPLETED" ? node.status : node.conclusion ?? node.state,
        link: node.detailsUrl ?? node.targetUrl,
        workflow: node.checkSuite?.workflowRun?.workflow?.name,
        description: node.description,
        completedAt: node.completedAt,
      });
    }
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return checks;
}

/** Shared check predicates keep CI ingestion and ready-for-review gating aligned. */
export function isPendingCheck(check: PrCheck): boolean {
  return check.bucket?.toLowerCase() === "pending" ||
    /^(PENDING|QUEUED|IN_PROGRESS|WAITING|REQUESTED|EXPECTED)$/i.test(check.state ?? "");
}

export function isFailingCheck(check: PrCheck): boolean {
  return /^(fail|cancel)$/i.test(check.bucket ?? "") ||
    /^(FAILURE|FAIL|ERROR|CANCELLED|CANCELED|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED|STALE)$/i.test(check.state ?? "");
}

/** Failing outranks pending so a red check shows before the rest of the suite settles. */
export function ciStatusFrom(checks: PrCheck[]): PrCiStatus {
  if (checks.some(isFailingCheck)) return "failing";
  if (checks.some(isPendingCheck)) return "pending";
  return checks.length > 0 ? "passing" : "none";
}

const REVIEW_DECISIONS: Record<string, PrReviewStatus> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

/** GitHub's reviewDecision is empty when no reviews are required, so fall back to
 * each author's latest verdict (reviews arrive oldest first). */
export function reviewStatusFrom(reviewDecision: string | null | undefined, reviews: GhReview[]): PrReviewStatus {
  const decided = REVIEW_DECISIONS[(reviewDecision ?? "").toUpperCase()];
  if (decided) return decided;
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const login = review.author?.login;
    const state = (review.state ?? "").toUpperCase();
    if (!login || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) continue;
    latest.set(login, state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return "none";
}

/** No checks is green; a failed fetch must be represented separately by callers. */
export function ciGreen(checks: PrCheck[]): boolean {
  return !checks.some((check) => isPendingCheck(check) || isFailingCheck(check));
}

/** Marks a draft ready; callers own retries and the durable promotion latch. */
export async function markPrReady(repoPath: string, number: number): Promise<void> {
  await runOk(["gh", "pr", "ready", String(number)], repoPath, "gh pr ready");
}

/** Wait for the whole suite; the SHA scopes dedupe so a failed fix can be retried. */
export function normalizeCiFailures(
  checks: PrCheck[], headSha: string | null, alreadyHandledIds: Iterable<string>,
): PrFeedbackItem[] {
  if (!headSha || checks.some(isPendingCheck)) return [];
  const seen = new Set(alreadyHandledIds);
  const items: PrFeedbackItem[] = [];
  for (const check of checks) {
    if (!isFailingCheck(check)) continue;
    const name = check.name || "ci";
    const sourceId = `ci:${headSha}:${check.workflow ? `${check.workflow}/` : ""}${name}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    items.push({
      sourceId, kind: "ci_check", author: check.workflow || name, isBot: true,
      url: check.link || "",
      body: [name, check.workflow && `Workflow: ${check.workflow}`,
        `State: ${check.state || check.bucket}`, check.description, check.link].filter(Boolean).join("\n"),
    });
  }
  return items;
}

const CI_LOG_MAX_LINES = 200;
const CI_LOG_MAX_BYTES = 20_000;

/** Agents cannot call gh, so collect bounded failed-job context before spawning. */
export async function enrichCiLogs(repoPath: string, items: PrFeedbackItem[]): Promise<PrFeedbackItem[]> {
  return Promise.all(items.map(async (item) => {
    const match = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/job\/(\d+)(?:[/?#]|$)/.exec(item.url);
    if (!match) return item;
    try {
      const log = await runOk(["gh", "run", "view", match[1]!, "--job", match[2]!, "--log-failed"], repoPath, "gh run view");
      const tail = Buffer.from(log.trimEnd().split("\n").slice(-CI_LOG_MAX_LINES).join("\n")).subarray(-CI_LOG_MAX_BYTES).toString("utf8");
      if (!tail) return item;
      // A longer fence keeps backticks in build output inside the quoted excerpt.
      const fence = "`".repeat(Math.max(3, ...Array.from(tail.matchAll(/`+/g), (m) => m[0].length + 1)));
      return { ...item, body: `${item.body}\n\nFailed job log (untrusted):\n${fence}text\n${tail}\n${fence}` };
    } catch {
      return item;
    }
  }));
}

// owner/name per repo path. A repo's GitHub identity doesn't change mid-process, and
// the watcher asks every tick, so cache the in-flight promise (a failure is evicted
// so the next tick retries).
const ghRepoCache = new Map<string, Promise<{ owner: string; name: string }>>();

/** Resolves `{ owner, name }` of the GitHub repo at `repoPath` (cached per path). */
export function ghRepo(repoPath: string): Promise<{ owner: string; name: string }> {
  let p = ghRepoCache.get(repoPath);
  if (!p) {
    p = runOk(["gh", "repo", "view", "--json", "owner,name"], repoPath, "gh repo view").then((out) => {
      const r = JSON.parse(out) as { owner?: { login?: string }; name?: string };
      if (!r.owner?.login || !r.name) throw new Error("gh repo view returned no owner/name");
      return { owner: r.owner.login, name: r.name };
    });
    p.catch(() => ghRepoCache.delete(repoPath));
    ghRepoCache.set(repoPath, p);
  }
  return p;
}

const ghViewerCache = new Map<string, Promise<string>>();

/** Login of the account `gh` is authenticated as for `repoPath` (cached per path;
 * failures are evicted and resolve to null). PR-watch replies post as this user. */
export async function ghViewerLogin(repoPath: string): Promise<string | null> {
  let p = ghViewerCache.get(repoPath);
  if (!p) {
    p = runOk(["gh", "api", "user", "--jq", ".login"], repoPath, "gh api user").then((out) => {
      const login = out.trim();
      if (!login) throw new Error("gh api user returned no login");
      return login;
    });
    ghViewerCache.set(repoPath, p);
  }
  try {
    return await p;
  } catch {
    if (ghViewerCache.get(repoPath) === p) ghViewerCache.delete(repoPath);
    return null;
  }
}

/** `gh pr view` omits actor types, so fetch conversation feedback through GraphQL.
 * Node ids match the old input exactly: changing them would re-ingest handled items.
 * Page each connection independently so busy PRs don't lose feedback after 100 items. */
async function fetchConversationItems<T>(
  repoPath: string,
  number: number,
  connection: "comments" | "reviews",
): Promise<T[]> {
  const { owner, name } = await ghRepo(repoPath);
  const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${connection}(first: 100, after: $cursor) {
          nodes { id author { login __typename } body url ${connection === "comments" ? "isMinimized" : "state"} }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const args = ["gh", "api", "graphql", "-f", `query=${query}`,
      "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const out = await runOk(args, repoPath, `gh api graphql (${connection})`);
    const raw = JSON.parse(out);
    const page = raw.data?.repository?.pullRequest?.[connection] as {
      nodes: T[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } | undefined;
    if (!page) throw new Error(`gh api graphql returned no ${connection}`);
    items.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 50) {
            nodes { databaseId author { login __typename } body path line url }
          }
        }
      }
    }
  }
}`;

/** Fetches a PR's inline review threads (with resolution state) via GraphQL — the
 * one piece `gh pr view --json` doesn't expose. */
export async function fetchReviewThreads(repoPath: string, number: number): Promise<ReviewThread[]> {
  const { owner, name } = await ghRepo(repoPath);
  const out = await runOk(
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ],
    repoPath,
    "gh api graphql (reviewThreads)",
  );
  const raw = JSON.parse(out) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: ReviewThread[] } } } };
  };
  return raw.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
}

function authorLogin(a: GhAuthor | null | undefined): string {
  return a?.login || "ghost";
}

const KNOWN_BOT_LOGINS = new Set([
  "cursor", "coderabbitai", "copilot-pull-request-reviewer", "copilot",
  "github-actions", "dependabot", "sonarcloud", "codecov",
]);

/** Bots are still feedback; detection only steers how Tack addresses them. The
 * login fallback also covers older persisted items without GitHub actor metadata. */
export function isBotAuthor(a: GhAuthor | null | undefined): boolean {
  if (!a) return false;
  return a.is_bot === true || a.__typename === "Bot" || /\[bot\]$/i.test(a.login ?? "")
    || KNOWN_BOT_LOGINS.has((a.login ?? "").replace(/\[bot\]$/i, "").toLowerCase());
}

const normalizeLogin = (value: string) => value.replace(/\[bot\]$/i, "").toLowerCase();

export function isAllowedAuthor(login: string | null | undefined, allowList: readonly string[]): boolean {
  if (!login) return false;
  const author = normalizeLogin(login);
  return allowList.some((entry) => normalizeLogin(entry) === author);
}

export function isSelfAuthor(author: string | null | undefined, viewerLogin: string | null | undefined): boolean {
  if (!author || !viewerLogin) return false;
  return normalizeLogin(author) === normalizeLogin(viewerLogin);
}

export function allowedAuthorsFor(config: { prWatch: Pick<TackConfig["prWatch"], "allowAuthors"> }, project: Project): string[] {
  return [...new Set([...(config.prWatch.allowAuthors ?? []), ...(project.prWatch?.allowAuthors ?? [])])];
}

/** Headings that open informational bot PR summaries (Cursor, CodeRabbit, Copilot).
 * Matched against the first visible line, case-insensitively. */
const BOT_SUMMARY_HEADINGS = [
  "pr summary", "summary by coderabbit", "pull request overview", "walkthrough",
];

/** First visible line: bot comments often start with multiline HTML metadata and
 * open with a markdown heading. */
function firstVisibleLine(body: string): string {
  return body.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .split("\n").map((line) => line.trim().replace(/^#+\s*/, "").trim())
    .find(Boolean) ?? "";
}

/** A bot's auto-generated PR summary describes the PR rather than asking for changes,
 * so feeding it to a fix agent only yields a useless "nothing to do" reply. Only
 * conversation-level bot posts qualify: inline threads do not qualify. */
export function isBotPrSummary(item: Pick<PrFeedbackItem, "kind" | "body" | "isBot">): boolean {
  if (!item.isBot || (item.kind !== "issue_comment" && item.kind !== "review")) return false;
  const first = firstVisibleLine(item.body).replace(/[*_`:]+/g, "").trim().toLowerCase();
  return BOT_SUMMARY_HEADINGS.some((h) => first === h || first.startsWith(`${h} `));
}

/**
 * The pure heart of PR watch input: turns a PR's raw comments into the list of NEW
 * feedback items a fix agent should consider. Includes:
 *  - every comment in an UNRESOLVED review thread (`review_thread`; resolved threads
 *    are settled and excluded),
 *  - reviews with a non-empty summary body (`review`; an empty body is just the
 *    envelope for inline comments, which arrive as threads),
 *  - conversation comments (`issue_comment`) that aren't minimized.
 * Only allowed authors are included; informational bot PR summaries are excluded (`isBotPrSummary`).
 * Anything containing `PR_WATCH_MARKER` (Tack's own replies) is dropped, as is any
 * sourceId already in `alreadyHandledIds` (ingested earlier).
 */
export function normalizeFeedback(
  status: Pick<PrStatus, "comments" | "reviews" | "url">,
  threads: ReviewThread[],
  alreadyHandledIds: Iterable<string>,
  allowAuthors: readonly string[],
): PrFeedbackItem[] {
  const seen = new Set(alreadyHandledIds);
  const out: PrFeedbackItem[] = [];
  const take = (item: PrFeedbackItem) => {
    if (!item.body.trim()) return;
    if (item.body.includes(PR_WATCH_MARKER)) return;
    if (isBotPrSummary(item) || !isAllowedAuthor(item.author, allowAuthors)) return;
    if (seen.has(item.sourceId)) return;
    seen.add(item.sourceId); // de-dupe within one pass too
    out.push(item);
  };

  for (const t of threads) {
    if (t.isResolved) continue;
    const nodes = t.comments?.nodes ?? [];
    const root = nodes[0];
    for (const c of nodes) {
      if (c.databaseId === undefined || c.databaseId === null) continue;
      take({
        sourceId: String(c.databaseId),
        kind: "review_thread",
        author: authorLogin(c.author),
        body: c.body ?? "",
        url: c.url ?? status.url,
        ...(c.path ? { path: c.path } : {}),
        ...(typeof c.line === "number" ? { line: c.line } : {}),
        ...(root ? { inReplyTo: String(root.databaseId) } : {}),
        isBot: isBotAuthor(c.author),
      });
    }
  }

  for (const r of status.reviews ?? []) {
    if (!r.id) continue;
    take({
      sourceId: r.id,
      kind: "review",
      author: authorLogin(r.author),
      body: r.body ?? "",
      url: r.url ?? status.url,
      isBot: isBotAuthor(r.author),
    });
  }

  for (const c of status.comments ?? []) {
    if (!c.id || c.isMinimized) continue;
    take({
      sourceId: c.id,
      kind: "issue_comment",
      author: authorLogin(c.author),
      body: c.body ?? "",
      url: c.url ?? status.url,
      isBot: isBotAuthor(c.author),
    });
  }

  return out;
}

/** Standard runtime attribution; runtimes without a standard footer stay unsigned. */
export function runtimeAttribution(runtime: RuntimeKind | null | undefined): string {
  return runtime === "claude" ? "🤖 Generated with [Claude Code](https://claude.com/claude-code)" : "";
}

/**
 * Composes the body of a Tack reply. Thread replies sit right under the comment, so
 * they're just the reply; conversation replies (`review` / `issue_comment`) address
 * the author and quote the original's first line so it's clear what's being answered.
 * Bots are quoted but not @-mentioned — mentioning a review bot typically summons it
 * to respond again, which would feed the watcher a fresh comment every tick.
 * Always ends with `PR_WATCH_MARKER` so Tack never ingests its own reply.
 */
export function buildReplyBody(input: {
  kind: PrFeedbackKind;
  author: string | null;
  isBot?: boolean;
  original: string;
  reply: string;
  /** Short sha of the pushed fix, when this item's fix reached the PR. */
  fixSha?: string | null;
  runtime?: RuntimeKind | null;
}): string {
  const parts: string[] = [];
  if (input.kind !== "review_thread") {
    const first = feedbackQuote(input.original, input.kind);
    const mention = input.author && !input.isBot && !isBotAuthor({ login: input.author });
    const who = input.author ? (mention ? `@${input.author}` : `**${input.author}**`) : "";
    if (who) parts.push(who);
    if (first) parts.push(`> ${first}`);
    if (parts.length) parts.push("");
  }
  parts.push(input.reply.trim());
  if (input.fixSha) parts.push("", `Fix: ${input.fixSha}`);
  const attribution = runtimeAttribution(input.runtime);
  if (attribution) parts.push("", attribution);
  return `${parts.join("\n")}\n${PR_WATCH_MARKER}`;
}

/** Quote only visible text: bot comments often start with multiline HTML metadata. */
export function feedbackQuote(original: string, kind?: PrFeedbackKind): string {
  if (kind === "ci_check") return `Failing check: ${original.split("\n")[0] || "ci"}`;
  return firstVisibleLine(original).slice(0, 200);
}

/** GitHub cannot thread conversation comments, review summaries or CI checks. Collect their
 * answers in one linked comment, mentioning each human at most once. */
export function buildConversationReplyBody(items: Array<{
  kind?: PrFeedbackKind;
  url: string;
  author: string | null;
  isBot?: boolean;
  original: string;
  reply: string;
  fixSha?: string | null;
}>, input: { runtime?: RuntimeKind | null } = {}): string {
  const mentioned = new Set<string>();
  const sections = items.map((item) => {
    const login = item.author;
    const key = login?.toLowerCase();
    const mention = item.kind !== "dependency_release" && login && key && !item.isBot && !isBotAuthor({ login }) && !mentioned.has(key);
    if (mention) mentioned.add(key);
    const who = item.kind === "dependency_release" ? "" : login ? (mention ? `@${login}` : `**${login}**`) : "";
    const quote = feedbackQuote(item.original, item.kind);
    return [
      `[${item.kind === "dependency_release" ? "Upstream release" : item.kind === "ci_check" ? quote : "Original feedback"}](${item.url})${who ? ` — ${who}` : ""}`,
      ...(quote && item.kind !== "ci_check" && item.kind !== "dependency_release" ? [`> ${quote}`] : []),
      "",
      item.reply.trim(),
      ...(item.fixSha ? ["", `Fix: ${item.fixSha}`] : []),
    ].join("\n");
  });
  const attribution = runtimeAttribution(input.runtime);
  return `${sections.join("\n\n---\n\n")}${attribution ? `\n\n${attribution}` : ""}\n${PR_WATCH_MARKER}`;
}

/** Replies inside a review thread (attached to the thread's root comment). Returns
 * the posted comment's html_url. */
export async function postReviewThreadReply(
  repoPath: string,
  number: number,
  rootCommentId: string,
  body: string,
): Promise<string | null> {
  const { owner, name } = await ghRepo(repoPath);
  const out = await runOk(
    [
      "gh",
      "api",
      "-X",
      "POST",
      `repos/${owner}/${name}/pulls/${number}/comments/${rootCommentId}/replies`,
      "-f",
      `body=${body}`,
    ],
    repoPath,
    "gh api (review reply)",
  );
  return htmlUrl(out);
}

/** Fetches and updates the live PR description. */
export async function fetchPrBody(repoPath: string, number: number): Promise<string> {
  const out = await runOk(["gh", "pr", "view", String(number), "--json", "body"], repoPath, "gh pr view");
  return (JSON.parse(out) as { body: string }).body ?? "";
}
export async function updatePrBody(repoPath: string, number: number, body: string): Promise<void> {
  const { owner, name } = await ghRepo(repoPath);
  await runOk(["gh", "api", "-X", "PATCH", `repos/${owner}/${name}/pulls/${number}`, "-f", `body=${body}`], repoPath, "gh api (PR description)");
}

/** Posts a PR conversation comment. Returns the posted comment's html_url. */
export async function postIssueComment(repoPath: string, number: number, body: string): Promise<string | null> {
  const { owner, name } = await ghRepo(repoPath);
  const out = await runOk(
    ["gh", "api", "-X", "POST", `repos/${owner}/${name}/issues/${number}/comments`, "-f", `body=${body}`],
    repoPath,
    "gh api (issue comment)",
  );
  return htmlUrl(out);
}

function htmlUrl(out: string): string | null {
  try {
    const v = JSON.parse(out) as { html_url?: string };
    return v.html_url ?? null;
  } catch {
    return null;
  }
}

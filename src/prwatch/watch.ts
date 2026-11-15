import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { LOGS_DIR } from "../paths";
import { isAlive, selfInvocation } from "../process/self";
import type { Model, Project, TackConfig } from "../config/schema";
import { modelForRole } from "../config/load";
import {
  assignPrFeedback,
  countPrFixRunsSince,
  getSession,
  getSessionPr,
  getAgent,
  getDb,
  insertPrFeedback,
  listAgentPrFeedback,
  listPrFixAgents,
  listSessionPrs,
  listUnassignedPrFeedback,
  markAgentPostFixed,
  markPrFeedbackHandled,
  prFeedbackSourceIds,
  releaseAgentPrFeedback,
  setAgentError,
  setAgentStatus,
  setAgentPid,
  setSessionPrStatus,
  setSessionPrWatchPid,
  setPrWatchCodeVersion,
  setPrWatchConfigVersion,
  type AgentRow,
  type AgentFixOutcome,
  type AgentStatus,
  type PrFeedbackRow,
  type PrMergeable,
  type SessionPrRow,
  type SessionRow,
} from "../db";
import { readArtifact, writePrFeedbackArtifact } from "../artifacts/store";
import { prepareAgent } from "../agent/execute";
import { spawnAgentRunner } from "../agent/detached";
import {
  buildReplyBody,
  buildConversationReplyBody,
  fetchPrStatus,
  fetchPrChecks,
  enrichCiLogs,
  normalizeCiFailures,
  fetchReviewThreads,
  normalizeFeedback,
  postIssueComment,
  postReviewThreadReply,
  pushBranch,
  toMergeable,
  type PrFeedbackItem,
  type PrStatus,
} from "../projects/prs";
import { commitWorktreeAsync, fastForwardPrWorktree, worktreeBase, worktreeHead } from "../worktree/worktree";
import { buildPrFixPrompt } from "./prompt";
import { currentCodeVersion, currentConfigVersion } from "../process/version";
import { nowIso } from "../util/id";

export { buildPrFixPrompt } from "./prompt";

/**
 * PR watch — the per-session background loop that keeps a session's open PRs
 * healthy after the supervisor opens them.
 *
 * One detached process per session (`tack __watch-prs <sessionId>`, pid in
 * `sessions.pr_watch_pid`) polls every `prWatch.intervalSeconds`, or out of cycle
 * when SIGUSR1 requests an early pass. Passes never overlap. For each PR that
 * isn't merged/closed it persists GitHub's status, and when there's NEW feedback
 * (review threads, review bodies, conversation comments — bots included), settled
 * failing CI checks (when `fixCi` is on), or a merge conflict, it spawns a `pr_fix` agent forked off the PR's head. When that agent
 * finishes, the watcher (never the agent) pushes its commits non-force onto the PR
 * branch and posts the agent's verdicts (threaded inline, batched in conversation).
 *
 * The supervisor can also start a fix run itself (`fix_pr`, for a conflict that
 * persists, a failed run, or follow-ups the human asked for). It goes through the
 * same `spawnPrFixAgent` / `prFixBusy` as a tick, and this loop post-fixes it like
 * any other. Supervisor runs are exempt from the automatic anti-loop cap and do
 * not count toward it.
 *
 * Invariants:
 *  - At most one fix agent per PR in flight; the next tick waits for it.
 *  - Every GitHub comment is ingested once (`pr_feedback` UNIQUE(pr, source)), and
 *    Tack's own replies carry `PR_WATCH_MARKER` so they're never ingested.
 *  - The post-fix step is latched per agent (`agents.post_fixed_at`) and per item
 *    (`pr_feedback.handled_at`), so a crash mid-step resumes without double-posting.
 *  - Automatic fix runs per PR are capped per rolling 24h (`maxFixRunsPerDay`),
 *    failures included; supervisor runs are exempt and do not count. Failed items
 *    are never retried automatically — no loops.
 *  - Every `gh`/git call is async and best-effort: a failure is logged and the loop
 *    carries on (next PR, next tick). Nothing throws out of the loop.
 */

/** A serial loop's interruptible wait. Wakes during work coalesce into one skipped wait. */
export function createWakeableSleep(): { sleep(ms: number): Promise<void>; wake(): void } {
  let pending = false;
  let resolveSleep: (() => void) | undefined;
  return {
    sleep(ms) {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          resolveSleep = undefined;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        resolveSleep = finish;
      });
    },
    wake() {
      if (resolveSleep) resolveSleep();
      else pending = true;
    },
  };
}
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE: ReadonlySet<AgentStatus> = new Set(["pending", "running"]);

type Log = (msg: string) => void;

/** Whether the watcher should still be looking at a PR (anything not merged/closed,
 * including drafts and rows whose state hasn't been polled yet). */
export function isWatchablePr(pr: Pick<SessionPrRow, "state">): boolean {
  return pr.state !== "merged" && pr.state !== "closed";
}

/**
 * Starts the session's PR watcher as a detached background process, mirroring
 * `spawnSupervisorRunner`: it outlives the caller (the supervisor's `open_pr`, or the
 * dashboard) and logs to `logs/<ses>/pr-watch.log`. A no-op (returns null) when PR
 * watch is disabled, the session isn't active, or a watcher is already alive.
 * Returns the new pid otherwise.
 */
export function spawnPrWatcher(sessionId: string, config: TackConfig): number | null {
  if (!config.prWatch.enabled) return null;
  const session = getSession(sessionId);
  if (!session || session.status !== "active") return null;
  if (isAlive(session.pr_watch_pid)) return null;

  mkdirSync(join(LOGS_DIR, sessionId), { recursive: true });
  const fd = openSync(join(LOGS_DIR, sessionId, "pr-watch.log"), "a");
  const { command, args } = selfInvocation();
  const child = spawn(command, [...args, "__watch-prs", sessionId], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`Failed to spawn PR watcher for session ${sessionId}`);
  setSessionPrWatchPid(sessionId, child.pid);
  return child.pid;
}

export type PrWatchTrigger =
  | { kind: "disabled" }
  | { kind: "inactive" }
  | { kind: "no-open-prs" }
  | { kind: "signalled"; pid: number }
  | { kind: "started"; pid: number };

/** Refresh watchable PR statuses first, then request an early watcher pass only
 * if any remain open. Poll failures retain stored state; watchPass guards apply. */
export async function triggerPrWatch(
  sessionId: string,
  config: TackConfig,
  deps = {
    isAlive,
    signal: (pid: number) => { process.kill(pid, "SIGUSR1"); },
    spawn: spawnPrWatcher,
    poll: (pr: SessionPrRow, project: Project): Promise<unknown> => pollPrStatus(pr.id, project.path, pr.number!),
  },
): Promise<PrWatchTrigger> {
  if (!config.prWatch.enabled) return { kind: "disabled" };
  const session = getSession(sessionId);
  if (!session || session.status !== "active") return { kind: "inactive" };
  await Promise.allSettled(listSessionPrs(sessionId).filter(isWatchablePr).map(async (pr) => {
    const project = config.projects.find((p) => p.name === pr.project_name);
    if (pr.number !== null && project) await deps.poll(pr, project);
  }));
  if (!listSessionPrs(sessionId).some(isWatchablePr)) return { kind: "no-open-prs" };
  if (session.pr_watch_pid && deps.isAlive(session.pr_watch_pid)) {
    try {
      deps.signal(session.pr_watch_pid);
      return { kind: "signalled", pid: session.pr_watch_pid };
    } catch {
      // The watcher may have exited between the liveness check and the signal.
    }
  }
  const pid = deps.spawn(sessionId, config);
  if (pid !== null) return { kind: "started", pid };
  // Another caller may have won the spawn race; wake that watcher instead.
  const winner = getSession(sessionId)?.pr_watch_pid;
  if (winner && deps.isAlive(winner)) {
    deps.signal(winner);
    return { kind: "signalled", pid: winner };
  }
  throw new Error(`Failed to start PR watcher for session ${sessionId}`);
}

/**
 * The `__watch-prs` entrypoint: loops one pass per interval until the session is
 * gone/archived or none of its PRs are open any more, then clears its pid. Each
 * pass is wrapped so one bad tick (gh down, auth expired) never kills the watcher.
 */
export async function runPrWatcher(sessionId: string, config: TackConfig): Promise<void> {
  const log: Log = (msg) => console.log(`[${nowIso()}] ${msg}`);

  // Self-dedupe: the dashboard and open_pr can race to spawn. Whoever finds a live
  // watcher that isn't itself steps aside.
  const initial = getSession(sessionId);
  if (initial && initial.pr_watch_pid !== process.pid && isAlive(initial.pr_watch_pid)) {
    log(`another watcher (pid ${initial.pr_watch_pid}) is running for ${sessionId}; exiting`);
    return;
  }
  setSessionPrWatchPid(sessionId, process.pid);
  setPrWatchCodeVersion(sessionId, currentCodeVersion());
  setPrWatchConfigVersion(sessionId, currentConfigVersion());

  const release = () => {
    try {
      if (getSession(sessionId)?.pr_watch_pid === process.pid) setSessionPrWatchPid(sessionId, null);
    } catch {
      /* session deleted underneath us */
    }
  };
  // stop/archive SIGTERM us; clear the pid on the way out so the next spawn is clean.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      log(`${sig} — exiting`);
      release();
      process.exit(0);
    });
  }

  const wait = createWakeableSleep();
  const requestPoll = () => {
    log("poll requested (SIGUSR1)");
    wait.wake();
  };
  process.on("SIGUSR1", requestPoll);

  const intervalMs = config.prWatch.intervalSeconds * 1000;
  log(`watching PRs for ${sessionId} every ${config.prWatch.intervalSeconds}s`);
  try {
    for (;;) {
      const session = getSession(sessionId);
      if (!session || session.status !== "active") {
        log("session gone or no longer active; exiting");
        break;
      }
      if (session.pr_watch_pid !== process.pid && isAlive(session.pr_watch_pid)) {
        log(`superseded by watcher pid ${session.pr_watch_pid}; exiting`);
        break;
      }
      if (!listSessionPrs(sessionId).some(isWatchablePr)) {
        log("no open PRs remain; exiting");
        break;
      }
      try {
        await watchPass(session, config, log);
      } catch (err) {
        log(`pass failed: ${(err as Error).message}`);
      }
      await wait.sleep(intervalMs);
    }
  } finally {
    process.off("SIGUSR1", requestPoll);
    release();
  }
}

/** One tick over every watchable PR in the session. Per-PR failures are isolated. */
async function watchPass(session: SessionRow, config: TackConfig, log: Log): Promise<void> {
  for (const pr of listSessionPrs(session.id).filter(isWatchablePr)) {
    try {
      await watchPr(session, pr, config, log);
    } catch (err) {
      log(`PR #${pr.number ?? "?"}: ${(err as Error).message}`);
    }
  }
}

async function watchPr(session: SessionRow, pr: SessionPrRow, config: TackConfig, log: Log): Promise<void> {
  const tag = `PR #${pr.number ?? "?"}`;
  const project = config.projects.find((p) => p.name === pr.project_name);
  if (!project) return log(`${tag}: project "${pr.project_name ?? "?"}" not in config; skipping`);
  if (pr.number === null) return log(`${tag}: no PR number recorded; skipping`);

  // 1. Poll and persist status.
  const { status, state, mergeable } = await pollPrStatus(pr.id, project.path, pr.number);

  // 2. Nothing to do on a finished PR.
  if (state === "merged" || state === "closed") return;

  // 3. One fix at a time per PR. A non-terminal fix agent whose runner died (crash,
  // reboot) would block the PR forever, so it's failed here and post-fixed below.
  const fixes = listPrFixAgents(pr.id);
  if (fixes.some((a) => ACTIVE.has(a.status) && isAlive(a.pid))) return;
  for (const a of fixes) {
    if (ACTIVE.has(a.status)) {
      setAgentError(a.id, "PR-fix runner exited before finishing");
      setAgentStatus(a.id, "failed");
      log(`${tag}: fix agent ${a.id} runner is gone; marked failed`);
    }
  }

  // 4. Finish any completed fix run that hasn't been pushed/replied yet.
  const unfinished = listPrFixAgents(pr.id).filter((a) => !ACTIVE.has(a.status) && !a.post_fixed_at);
  if (unfinished.length > 0) {
    for (const a of unfinished) await postFix(a, pr, project, config, log);
    return;
  }

  // 5. New feedback or a conflict → a fix run. UNKNOWN mergeability means GitHub is
  // still computing it; it's simply not a conflict yet and the next tick re-checks.
  const conflict = mergeable === "CONFLICTING";
  const threads = await fetchReviewThreads(project.path, pr.number);
  const fresh = normalizeFeedback(status, threads, prFeedbackSourceIds(pr.id));
  if (config.prWatch.fixCi) {
    try {
      const checks = await fetchPrChecks(project.path, pr.number);
      fresh.push(...await enrichCiLogs(project.path,
        normalizeCiFailures(checks, status.headRefOid, prFeedbackSourceIds(pr.id))));
    } catch (err) {
      log(`${tag}: fetching CI checks failed: ${(err as Error).message}`);
    }
  }
  // Items released back to pending (a rejected push / stopped run) also need a fix.
  const released = listUnassignedPrFeedback(pr.id);
  if (!conflict && fresh.length === 0 && released.length === 0) return;

  const cap = prFixCapReached(pr.id, config);
  if (cap.reached) {
    return log(
      `${tag}: ${fresh.length + released.length} item(s)${conflict ? " + conflict" : ""} waiting, but the daily cap ` +
        `(${config.prWatch.maxFixRunsPerDay} fix runs/24h) is reached; will retry later`,
    );
  }

  const { agent, items, continued, fallbackReason } = await spawnPrFixAgent(session, pr, project, config, {
    origin: "auto",
    conflict,
    baseBranch: status.baseRefName,
    title: status.title,
    fresh,
  });
  const ciCount = fresh.filter((f) => f.kind === "ci_check").length +
    released.filter((f) => f.source_kind === "ci_check").length;
  log(`${tag}: spawned fix agent ${agent.id} (${items} item(s), ${ciCount} CI item(s)${conflict ? ", merge conflict" : ""}); ${continued ? `continued ${continued}` : `fresh: ${fallbackReason}`}`);
}

/**
 * Polls one PR's live status from GitHub and persists it on the row (state,
 * mergeability, base, head, title), returning the raw status plus the lower-cased
 * state and normalized mergeability. A draft is stored as "draft" (the dashboard's
 * vocabulary); gh reports it as OPEN + isDraft, so `state` here stays "open". Shared
 * by the watcher's tick and `fix_pr` so both record what they acted on.
 */
export async function pollPrStatus(
  sessionPrId: string,
  repoPath: string,
  number: number,
): Promise<{ status: PrStatus; state: string; mergeable: PrMergeable | null }> {
  const status = await fetchPrStatus(repoPath, number);
  const state = status.state.toLowerCase();
  const mergeable = toMergeable(status.mergeable);
  setSessionPrStatus(sessionPrId, {
    state: state === "open" && status.isDraft ? "draft" : state,
    mergeable,
    baseBranch: status.baseRefName,
    headSha: status.headRefOid,
    title: status.title,
    mergedAt: status.mergedAt,
  });
  return { status, state, mergeable };
}

/**
 * Whether a PR already has a fix run that a new one would collide with — the "one
 * fix at a time per PR" invariant, shared by the watcher and the supervisor's
 * `fix_pr`. Busy means any fix agent that is still pending/running (alive or not: a
 * dead runner is failed and post-fixed by the watcher's next tick, and spawning
 * alongside it would fork off a head its post-fix is about to move) or any finished
 * one whose post-fix (push + replies) hasn't run yet.
 */
export function prFixBusy(sessionPrId: string): boolean {
  return listPrFixAgents(sessionPrId).some((a) => ACTIVE.has(a.status) || !a.post_fixed_at);
}

/**
 * The per-PR daily cap on automatic fix runs (`prWatch.maxFixRunsPerDay` over a
 * rolling 24h, failed runs and legacy NULL origins included). Supervisor `fix_pr`
 * runs are exempt and do not count toward this anti-loop budget.
 */
export function prFixCapReached(sessionPrId: string, config: TackConfig): { reached: boolean; runs: number } {
  const runs = countPrFixRunsSince(sessionPrId, new Date(Date.now() - DAY_MS).toISOString());
  return { reached: runs >= config.prWatch.maxFixRunsPerDay, runs };
}

/** Failed fixes never become a lineage head, including successful runtime runs
 * whose push was rejected. Legacy successful rows have no post-fix outcome. */
export function prLineageHead(pr: SessionPrRow): AgentRow | null {
  return listPrFixAgents(pr.id).reverse().find(a =>
    a.status === "done" && !["failed", "stopped", "push_rejected"].includes(a.fix_outcome ?? "")
  ) ?? (pr.agent_id ? getAgent(pr.agent_id) : null);
}

export async function prContinuationDecision(pr: SessionPrRow, model: Model, config: TackConfig, fresh = false):
  Promise<{ head: AgentRow; base: string } | { head: null; reason: string }> {
  const fallback = (reason: string) => ({ head: null, reason } as const);
  if (config.agentReuse?.enabled === false) return fallback("reuse disabled");
  if (fresh) return fallback("fresh requested");
  const head = prLineageHead(pr);
  if (!head) return fallback("no lineage head");
  if (head.status !== "done") return fallback("head is not done");
  if (!head.resume_ref) return fallback("missing resume_ref");
  if (head.runtime !== model.runtime) return fallback("runtime mismatch");
  const finished = Date.parse(head.finished_at ?? "");
  if (!Number.isFinite(finished) || Date.now() - finished > (config.agentReuse?.maxIdleHours ?? 24) * 3600_000)
    return fallback("idle window exceeded");
  if (!head.worktree_path || !head.branch || !existsSync(head.worktree_path)) return fallback("worktree missing");
  if (!pr.head_branch) return fallback("PR head branch missing");
  const result = await fastForwardPrWorktree(head.worktree_path, pr.head_branch);
  if ("reason" in result) return fallback(result.reason);
  return { head, base: result.base };
}

/**
 * Starts one `pr_fix` agent on a PR: the shared tail of the watcher's tick and the
 * supervisor's `fix_pr`. Records any `fresh` feedback (bodies to disk), hands the
 * agent every unassigned item on the PR (new ones plus any released back to
 * pending), builds its prompt, and launches it detached — continuing the eligible
 * lineage or forking fresh off the PR head. The watcher's
 * post-fix step later pushes and replies for it regardless of who spawned it.
 *
 * Callers poll first and own the automatic-cap guard; this also refuses stored
 * merged/closed PRs and claims the busy slot atomically before any async work.
 * `baseBranch`/`title` are the freshly polled values, falling back to the row's. Returns the agent and how many feedback
 * items it was given.
 */
export async function spawnPrFixAgent(
  session: SessionRow,
  pr: SessionPrRow,
  project: Project,
  config: TackConfig,
  opts: {
    origin: "auto" | "supervisor";
    conflict: boolean;
    baseBranch: string | null;
    title: string | null;
    fresh?: PrFeedbackItem[];
    model?: Model;
    guidance?: string;
    forceFresh?: boolean;
  },
): Promise<{ agent: AgentRow; items: number; continued: string | null; fallbackReason?: string }> {
  if (prFixBusy(pr.id)) throw new Error("A PR fix is already running or awaiting post-fix.");
  const model = opts.model ?? modelForRole(config, "agent");
  // Claim the PR before fetching: another process must not fast-forward this
  // worktree while its new runner is already modifying it.
  const { agent, rows } = getDb().transaction(() => {
    const current = getSessionPr(pr.id);
    if (current?.state === "merged" || current?.state === "closed") {
      throw new Error(`PR #${current.number} is ${current.state}; nothing to fix.`);
    }
    if (prFixBusy(pr.id)) throw new Error("A PR fix is already running or awaiting post-fix.");
    for (const item of opts.fresh ?? []) {
      insertPrFeedback({
        sessionPrId: pr.id,
        sourceId: item.sourceId,
        sourceKind: item.kind,
        author: item.author,
        authorIsBot: item.isBot,
        url: item.url,
        path: item.path ?? null,
        line: item.line ?? null,
        inReplyTo: item.inReplyTo ?? null,
        bodyRef: writePrFeedbackArtifact(session.id, pr.id, item.sourceId, "body", item.body),
      });
    }
    const rows = listUnassignedPrFeedback(pr.id);
    const prompt = buildPrFixPrompt({
      pr: { number: pr.number, title: opts.title ?? pr.title, url: pr.url, head_branch: pr.head_branch },
      conflict: opts.conflict,
      baseBranch: opts.baseBranch ?? pr.base_branch,
      items: rows.map((r) => feedbackItem(r, pr)),
      guidance: opts.guidance,
    });
    const agent = prepareAgent({
      session,
      project,
      model,
      prompt,
      kind: "pr_fix",
      sessionPrId: pr.id,
      fixOrigin: opts.origin,
    });
    assignPrFeedback(
      rows.map((r) => r.id),
      agent.id,
    );
    // The launcher owns this pending row during the bounded fetch. Watchers use
    // this pid to distinguish preparation from a dead detached runner.
    setAgentPid(agent.id, process.pid);
    return { agent, rows };
  }).immediate();
  try {
    const decision = await prContinuationDecision(pr, model, config, opts.forceFresh);
    if (decision.head) {
      getDb().prepare(`UPDATE agents SET continues_agent_id = ?, worktree_path = ?, branch = ?, resume_ref = ?, diff_base = ? WHERE id = ?`)
        .run(decision.head.id, decision.head.worktree_path, decision.head.branch, decision.head.resume_ref, decision.base, agent.id);
    }
    spawnAgentRunner(session.id, agent.id);
    return {
      agent: getAgent(agent.id)!, items: rows.length, continued: decision.head?.id ?? null,
      ...(decision.head ? {} : { fallbackReason: decision.reason }),
    };
  } catch (err) {
    setAgentError(agent.id, (err as Error).message);
    setAgentStatus(agent.id, "failed");
    throw err;
  }
}

/** Rehydrates a stored feedback row (body from disk) into the prompt's item shape. */
function feedbackItem(r: PrFeedbackRow, pr: SessionPrRow): PrFeedbackItem {
  return {
    sourceId: r.source_id,
    kind: r.source_kind,
    author: r.author ?? "ghost",
    body: readArtifact(r.body_ref),
    url: r.url ?? pr.url,
    ...(r.path ? { path: r.path } : {}),
    ...(r.line !== null ? { line: r.line } : {}),
    ...(r.in_reply_to ? { inReplyTo: r.in_reply_to } : {}),
    isBot: r.author_is_bot === 1,
  };
}

/**
 * The post-fix step for one finished fix agent: push its commits, then reply to each
 * item it reported on (conversation items share one comment). Items already
 * `handled_at` are skipped and the agent is latched with `post_fixed_at` at the end, so a crash midway resumes
 * cleanly on the next tick (re-pushing an already-pushed sha is a no-op).
 */
export async function postFix(
  agent: AgentRow,
  pr: SessionPrRow,
  project: Project,
  config: TackConfig,
  log: Log,
): Promise<void> {
  const tag = `PR #${pr.number ?? "?"} fix ${agent.id}`;
  const items = listAgentPrFeedback(agent.id);

  // Stopped by the human (session stop): nothing reached the PR, so hand its items
  // back for a later run rather than declaring them handled.
  if (agent.status === "stopped") {
    const n = releaseAgentPrFeedback(agent.id);
    markAgentPostFixed(agent.id, "stopped");
    return log(`${tag}: was stopped; released ${n} item(s) back to pending`);
  }

  // Failed: mark its items failed (terminal — never retried automatically, so a
  // comment that reliably breaks the agent can't loop), keep the error legible.
  if (agent.status === "failed") {
    for (const f of items) if (!f.handled_at) markPrFeedbackHandled(f.id, { decision: "failed" });
    if (!agent.error) setAgentError(agent.id, "PR fix run failed");
    markAgentPostFixed(agent.id, "failed");
    return log(`${tag}: failed; marked ${items.filter((f) => !f.handled_at).length} item(s) failed`);
  }

  // Done: push first, so replies can cite the commit that reached the PR.
  let pushedSha: string | null = null;
  let outcome: AgentFixOutcome = "no_changes";
  if (agent.worktree_path && agent.branch && pr.head_branch) {
    try {
      await commitWorktreeAsync(agent.worktree_path, `Tack: finalize PR fix ${agent.id}`);
    } catch (err) {
      log(`${tag}: safety-net commit failed: ${(err as Error).message}`);
    }
    const head = await worktreeHead(agent.worktree_path);
    const base = agent.diff_base ?? await worktreeBase(project.path, agent.branch);
    if (head && head !== base) {
      if (config.prWatch.autoPush) {
        const push = await pushBranch(project.path, agent.branch, pr.head_branch);
        if (!push.ok) {
          // Someone moved the PR branch since we forked (or the remote refused).
          // Never force: release the items so the next tick re-forks off the new head.
          const n = releaseAgentPrFeedback(agent.id);
          markAgentPostFixed(agent.id, "push_rejected");
          return log(`${tag}: push rejected (${push.error}); released ${n} item(s) to retry next tick`);
        }
        pushedSha = head;
        outcome = "pushed";
        log(`${tag}: pushed ${pushedSha.slice(0, 7)} to ${pr.head_branch}`);
      } else {
        outcome = "not_pushed";
        log(`${tag}: autoPush is off; commits left on ${agent.branch}`);
      }
    }
  }

  const conversation: PrFeedbackRow[] = [];
  for (const f of items) {
    if (f.handled_at) continue;
    // Never reported by the agent: declined, no reply (nothing to say on its behalf).
    if (f.decision === "pending" || !f.reply_ref) {
      markPrFeedbackHandled(f.id, { decision: f.decision === "pending" ? "declined" : undefined });
      continue;
    }
    if (!config.prWatch.reply) {
      markPrFeedbackHandled(f.id);
      continue;
    }
    // Empty declined replies have nothing to publish on the agent's behalf.
    if (f.decision === "declined" && !readArtifact(f.reply_ref).trim()) {
      markPrFeedbackHandled(f.id);
      continue;
    }
    if (f.source_kind !== "review_thread") {
      conversation.push(f);
      continue;
    }
    const body = buildReplyBody({
      kind: f.source_kind,
      author: f.author,
      isBot: f.author_is_bot === 1,
      original: readArtifact(f.body_ref),
      reply: readArtifact(f.reply_ref),
      fixSha: f.decision === "fixed" ? pushedSha?.slice(0, 7) : null,
    });
    try {
      const url =
        f.source_kind === "review_thread" && f.in_reply_to
          ? await postReviewThreadReply(project.path, pr.number!, f.in_reply_to, body)
          : await postIssueComment(project.path, pr.number!, body);
      markPrFeedbackHandled(f.id, { replyUrl: url });
    } catch (err) {
      // Best-effort: log and mark handled anyway — retrying a reply that may have
      // partially landed risks a duplicate, which is worse than a missing reply.
      log(`${tag}: reply to ${f.source_id} failed: ${(err as Error).message}`);
      markPrFeedbackHandled(f.id);
    }
  }
  if (conversation.length) {
    const body = buildConversationReplyBody(conversation.map((f) => ({
      kind: f.source_kind,
      url: f.url ?? pr.url,
      author: f.author,
      isBot: f.author_is_bot === 1,
      original: readArtifact(f.body_ref),
      reply: readArtifact(f.reply_ref),
      fixSha: f.decision === "fixed" ? pushedSha?.slice(0, 7) : null,
    })));
    let url: string | null = null;
    try {
      url = await postIssueComment(project.path, pr.number!, body);
    } catch (err) {
      // Same no-retry policy as thread replies: a failed request may have landed.
      log(`${tag}: conversation reply failed: ${(err as Error).message}`);
    }
    for (const f of conversation) markPrFeedbackHandled(f.id, { replyUrl: url });
  }
  markAgentPostFixed(agent.id, outcome, pushedSha ?? undefined);
  log(`${tag}: post-fix complete (${items.length} item(s))`);
}

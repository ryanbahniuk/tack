import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, modelForRole, resolveModel } from "../config/load";
import { getSession } from "../db";
import {
  addSharedContext,
  agentTouches,
  approveSessionPlan,
  getAgent,
  latestSharedContext,
  listAgents,
  listPendingAmendments,
  listPrFeedback,
  listPrFixAgents,
  listSessionPrs,
  prFeedbackSourceIds,
  resolveAmendment,
  unlinkSessionJiraTicket,
  upsertSessionJiraTicket,
  upsertSessionPr,
  type AgentStatus,
  type SessionPrRow,
} from "../db";
import { overlapWithSiblings, sessionFileCollisions } from "../supervisor/conflicts";
import {
  readArtifact,
  writeAmendmentArtifact,
  writeSharedContext,
} from "../artifacts/store";
import { prepareContinuation } from "../agent/continue";
import { prepareAgent } from "../agent/execute";
import { checkModelOffered } from "../runtimes/availability";
import { spawnAgentRunner } from "../agent/detached";
import { spawnSessionTitler } from "../session/title";
import { commitWorktreeAsync, sessionPrBranch, syncBranchWithBase, syncSnapshot } from "../worktree/worktree";
import { fetchReviewThreads, normalizeFeedback, openSessionPr } from "../projects/prs";
import {
  isWatchablePr,
  pollPrStatus,
  prFixBusy,
  prFixCapReached,
  spawnPrFixAgent,
  spawnPrWatcher,
  triggerPrWatch,
} from "../prwatch/watch";
import { JIRA_KEY_RE, jiraTicketUrl } from "../projects/jira";

const TERMINAL: AgentStatus[] = ["done", "failed", "stopped"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The MCP name this server is mounted under (see supervise.ts). */
export const SUPERVISOR_MCP_NAME = "tack-supervisor";

/**
 * Supervisor tools that must prompt the human on every call rather than riding the
 * server-wide auto-allow. Only used when `autoOpenPrs` is off: opening a PR is
 * outward-facing, so that mode keeps it behind an explicit per-call human ok even
 * after the plan is approved. The attended launcher hands these to the runtime as
 * `approvalTools`.
 */
export const SUPERVISOR_APPROVAL_TOOLS = [`mcp__${SUPERVISOR_MCP_NAME}__open_pr`];

/**
 * Plain-language wording for the `open_pr` approval prompt, handed to the runtime as
 * `approvalPrompt` so the human sees "Open a PR for this?" instead of the generic
 * MCP "requires confirmation for this tool" line.
 */
export const SUPERVISOR_APPROVAL_PROMPT = "Open a PR for this?";

/**
 * Plain-language wording for the plan-approval prompt. The attended claude
 * supervisor presents its plan by calling `request_plan_approval`, which a
 * PreToolUse hook gates behind an `ask` decision carrying this text — so the human
 * sees one plain approve/decline question instead of Claude Code's native
 * ExitPlanMode menu (auto-mode vs manually-approve-edits vs keep planning). That
 * menu can't be relabelled or overridden by a hook, and its edit-mode fork is
 * meaningless here: the supervisor never edits, and the agents it spawns always run
 * headless in auto mode (see PERMISSION_ARGS in the claude adapter).
 */
export const SUPERVISOR_PLAN_APPROVAL_PROMPT = "Proceed with implementation?";

/**
 * Fully-qualified name of the plan-approval tool, handed to the runtime as
 * `planApprovalTool` so its PreToolUse hook (the human prompt) matches exactly this
 * tool. Deliberately NOT in SUPERVISOR_APPROVAL_TOOLS: it gets its own hook, which
 * also marks the session as awaiting input.
 */
export const SUPERVISOR_PLAN_APPROVAL_TOOL = `mcp__${SUPERVISOR_MCP_NAME}__request_plan_approval`;

/**
 * The supervisor's tool server. The supervisor is itself a runtime session
 * (claude|codex) running read-only; these tools are how it plans, delegates to
 * agents, waits on them, reads their results, and adjudicates amendments — the
 * whole coordination loop, runtime-agnostic.
 */
export async function runSupervisorServer(sessionId: string): Promise<void> {
  const config = await loadConfig();
  const server = new McpServer({ name: "tack-supervisor", version: "1.0.0" });

  const requireSession = () => {
    const s = getSession(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    return s;
  };

  server.registerTool(
    "list_projects",
    {
      description: "List the projects available to work in, with their descriptions.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        config.projects.map((p) => ({
          name: p.name,
          description: p.description,
          language: p.metadata?.language,
          frameworks: p.metadata?.frameworks,
        })),
      ),
  );

  // Not plan-gated: syncing is read-only investigation prep (it never touches the
  // user's checkouts), and the supervisor needs it BEFORE it can form a plan.
  // `readOnlyHint` is honest here: its only writes are Tack-owned snapshot worktrees
  // under Tack state, never a user checkout or remote. Without the hint, claude's
  // plan mode prompted the human for it despite the server-wide auto-allow.
  server.registerTool(
    "sync_projects",
    {
      description:
        "Call this FIRST, with the projects the task affects, before reading any code. Fetches each project " +
        "and checks out its latest default branch into a read-only snapshot worktree, returning the path. " +
        "Investigate ONLY under the returned paths (never the projects' original checkouts). If another " +
        "project turns out to be relevant, sync it before reading it; on a follow-up, re-sync before " +
        "re-investigating so you read current code.",
      inputSchema: {
        projects: z.array(z.string()).min(1).describe("Project names from list_projects"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projects }) => {
      const names = [...new Set(projects)]; // a duplicate would race two syncs on one path
      const unknown = names.filter((n) => !config.projects.some((p) => p.name === n));
      if (unknown.length)
        throw new Error(
          `Unknown project(s): ${unknown.map((n) => `"${n}"`).join(", ")}. ` +
            `Valid projects: ${config.projects.map((p) => p.name).join(", ") || "(none configured)"}`,
        );
      const results = await Promise.all(
        names.map(async (name) => {
          const proj = config.projects.find((p) => p.name === name)!;
          const r = await syncSnapshot(proj.path, sessionId, proj.name);
          return {
            project: proj.name,
            ...r,
            ...(r.fetched
              ? {}
              : {
                  note:
                    r.ref === "HEAD"
                      ? "no usable origin default branch; snapshot is at the project's local HEAD"
                      : "fetch failed or timed out; snapshot is at the last-fetched commit",
                }),
          };
        }),
      );
      return text(results);
    },
  );

  server.registerTool(
    "set_shared_context",
    {
      description:
        "Author or update the shared contract all agents must follow (the cross-agent coordination context). " +
        "Call this before spawning agents, and again when the plan changes.",
      inputSchema: { body: z.string().describe("The full contract text (markdown).") },
    },
    async ({ body }) => {
      const version = ((latestVersion(sessionId) ?? 0) + 1);
      const ref = writeSharedContext(sessionId, version, body);
      addSharedContext({ sessionId, bodyRef: ref, authoredBy: "supervisor" });
      // The first contract is the best summary of what the session is about — title
      // (or retitle, if it came from the seed prompt) from it. Detached and silent,
      // so it neither blocks this tool call nor touches the MCP stdout.
      if (version === 1) spawnSessionTitler(sessionId);
      return text({ ok: true, version });
    },
  );

  server.registerTool(
    "request_plan_approval",
    {
      description:
        "Present your plan to the human for approval. Calling this shows them an approve/decline prompt " +
        "with your summary; it returns once they approve. If they decline, revise the plan per their " +
        "feedback and call this again. `spawn_agent` is blocked until the plan is approved.",
      inputSchema: {
        summary: z
          .string()
          .describe(
            "Short plan summary for the human: goal in one sentence, then one line per agent (project + " +
              "what it does), plus any real trade-off/risk.",
          ),
      },
    },
    // The `summary` arg is for the human (it's shown with the tool call they're asked
    // to approve); the handler doesn't need it. It only executes after the human
    // accepts the PreToolUse `ask` prompt (a decline never reaches it), so reaching it
    // is an un-forgeable approval signal the model can't self-trigger. Sessions with no such hook (background,
    // codex) are already approved up front, so this is then a harmless no-op.
    async () => {
      approveSessionPlan(sessionId);
      return text({ approved: true, note: "Plan approved — proceed to spawn agents." });
    },
  );

  server.registerTool(
    "spawn_agent",
    {
      description:
        "Delegate a task to a new agent in the given project. The agent runs autonomously in its own " +
        "worktree; prefer continue_agent for follow-ups on an existing agent's unit before its PR is open. " +
        "This returns immediately with the agent id. Use wait_for_agents to await completion.\n\n" +
        "Each agent becomes one PR, so default to ONE agent per project. Every agent branches from the " +
        "project's default branch, not a sibling's branch, so work that must happen in order within a project belongs " +
        "to a single agent.\n\n" +
        "Declare `touches` (the files/dirs this unit will modify) and `dependsOn` (agent ids that must finish " +
        "first) so Tack can coordinate parallel work: overlapping touch-sets in the same project are reported " +
        "back as a warning so you can fold the clashing units into one agent, and a dependent agent self-gates " +
        "until its prerequisites finish (use this to order work across projects). You can fan out every agent " +
        "at once with dependencies declared — they order themselves.\n\n" +
        "To change an already-open PR (a conflict, a failed fix run, a follow-up the human asked for), use " +
        "fix_pr to update the same PR branch. Do not use spawn_agent + open_pr for this: it creates a second PR.",
      inputSchema: {
        project: z.string().describe("Project name from list_projects"),
        prompt: z.string().describe("The task for the agent, self-contained"),
        model: z.string().optional().describe("Model key; defaults to roles.agent (picked at random when several are set)"),
        touches: z
          .array(z.string())
          .optional()
          .describe("Files/dirs this agent will modify (repo-relative), e.g. ['src/auth/', 'README.md']"),
        dependsOn: z
          .array(z.string())
          .optional()
          .describe("Agent ids that must reach a terminal state before this agent starts"),
      },
    },
    async ({ project, prompt, model, touches, dependsOn }) => {
      const session = requireSession();
      // Plan-gate: agents only run once the human has approved the plan (attended
      // claude sessions flip this via `request_plan_approval`; background and codex
      // sessions are pre-approved). Refuse until then so a spawn can't slip out
      // during planning.
      if (!session.plan_approved_at)
        throw new Error(
          "Plan not approved yet. Call `request_plan_approval` with your short plan summary and wait for " +
            "the human to accept it before spawning any agents. Don't ask the human to change or exit any " +
            "mode — the tool call is the approval. `spawn_agent` stays blocked until then. " +
            `If the human says they never saw an approval prompt, they can type \`/approve\` in the session or run \`tack session approve ${sessionId}\` themselves.`,
        );
      const proj = config.projects.find((p) => p.name === project);
      if (!proj) throw new Error(`Unknown project "${project}"`);
      const m = model ? resolveModel(config, model) : modelForRole(config, "agent");
      // Fail fast on a model the runtime's login doesn't offer (e.g. a codex model a
      // ChatGPT login rejects with `model_not_found`): refuse here, before a worktree
      // or agent row exists, rather than spawn an agent that's certain to die. Unknown
      // (can't list, lookup failed) never blocks.
      const offered = checkModelOffered(config, m, { role: model ? undefined : "agent" });
      if (offered.ok === false) throw new Error(`Refusing to spawn: ${offered.message}`);

      const siblings = listAgents(session.id);
      // Validate declared dependencies point at real agents in this session.
      const unknownDeps = (dependsOn ?? []).filter((id) => !siblings.some((s) => s.id === id));
      if (unknownDeps.length > 0)
        throw new Error(`Unknown dependsOn agent id(s): ${unknownDeps.join(", ")}`);

      // Warn (don't block) when this unit's declared touch-set overlaps a sibling in
      // the same project that hasn't finished — that work belongs to one agent, and the
      // supervisor must reconcile the pair before PRs. `dependsOn` wouldn't fix it:
      // every worktree forks from the project's default branch, so the later agent wouldn't see
      // the earlier one's changes and the two PRs would still collide. Only non-terminal siblings matter: a finished
      // agent's work is already captured and won't be edited concurrently.
      const overlap = touches?.length
        ? overlapWithSiblings(
            touches,
            siblings
              .filter((s) => s.project_name === project && !TERMINAL.includes(s.status))
              .map((s) => ({ id: s.id, touches: agentTouches(s) })),
          )
        : [];

      const agent = prepareAgent({ session, project: proj, model: m, prompt, touches, dependsOn });
      spawnAgentRunner(session.id, agent.id);
      return text({
        agentId: agent.id,
        project,
        model: m.name,
        runtime: m.runtime,
        dependsOn: dependsOn ?? [],
        ...(overlap.length
          ? {
              warning:
                "Declared touch-set overlaps unfinished sibling agent(s) in this project — their PRs will " +
                "likely collide. Overlapping work in one project belongs to a single agent; don't spawn more " +
                "like this. For these, run check_conflicts once they finish and reconcile any collision with a " +
                "continue_agent call on the owning agent before opening PRs. `dependsOn` won't help: every agent branches from the " +
                "project's default branch, not a sibling's branch.",
              overlaps: overlap,
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "continue_agent",
    {
      description:
        "Continue a done or failed agent's conversation in its existing worktree for follow-up work on its unit " +
        "before a PR is open, including reconciling its own work. Plan-gated like spawn_agent. " +
        "After a PR is open use fix_pr. Returns immediately with the same agent id.",
      inputSchema: {
        agentId: z.string(),
        prompt: z.string().min(1).describe("The next instruction for this conversation"),
        model: z.string().optional().describe("Optional model key on the same runtime"),
      },
    },
    async ({ agentId, prompt, model }) => {
      const agent = prepareContinuation(sessionId, agentId, prompt, config, model);
      spawnAgentRunner(sessionId, agent.id);
      return text({ agentId: agent.id, model: agent.model, runtime: agent.runtime });
    },
  );

  server.registerTool(
    "open_pr",
    {
      description:
        "Open a pull request for a finished agent's committed work. YOU own PRs — agents no longer open their " +
        "own. " +
        (config.autoOpenPrs
          ? "Call this on your own (don't ask the human) once the agents finish and check_conflicts is clean, " +
            "once per unit of work that produced changes. The human enabled autoOpenPrs as their explicit " +
            "authorization for you to commit, push, and open this PR, so no further confirmation is needed. "
          : "Only call this AFTER the agents finish, you've summarized what each did, and the human has " +
            "explicitly approved opening PRs. ") +
        "Commits anything the agent left uncommitted, merges the latest remote base, then pushes its worktree branch under the " +
        "tack/pr/<session>/<slug> nomenclature, and runs `gh pr create`; returns the PR url and baseSync. " +
        "A base conflict is aborted and handed to a pr_fix agent when PR watch and its guards allow it.",
      inputSchema: {
        agentId: z.string().describe("The finished agent whose committed work becomes the PR"),
        title: z.string().describe("PR title"),
        body: z.string().describe("PR description (markdown)"),
        slug: z.string().optional().describe("Short branch slug; derived from the title if omitted"),
        base: z.string().optional().describe("Base branch to target; defaults to the repo's default branch"),
        draft: z.boolean().optional().describe("Open as a draft PR"),
      },
    },
    async ({ agentId, title, body, slug, base, draft }) => {
      const session = requireSession();
      const a = getAgent(agentId);
      if (!a) throw new Error(`Unknown agent ${agentId}`);
      if (a.session_id !== sessionId) throw new Error(`Agent ${agentId} isn't part of this session`);
      if (!a.branch || !a.worktree_path)
        throw new Error(`Agent ${agentId} has no worktree yet — it hasn't run.`);
      // The diff is captured (against the fork point) when the agent finishes, so no
      // diff means there's nothing to push — fail legibly rather than letting `gh`
      // reject an empty branch, which matters most when PRs open unattended.
      if (!a.diff_ref) throw new Error(`Agent ${agentId} made no changes — there's nothing to open a PR for.`);
      const proj = config.projects.find((p) => p.name === a.project_name);
      if (!proj) throw new Error(`Unknown project "${a.project_name}"`);
      // Safety net: fold any changes the agent left uncommitted into its branch so
      // nothing is dropped from the PR (a push only carries commits).
      await commitWorktreeAsync(a.worktree_path, `Tack: finalize work for agent ${agentId}`);
      const baseSync: Awaited<ReturnType<typeof syncBranchWithBase>> & {
        prFixAgentId?: string;
        prFixSkipped?: string;
      } = await syncBranchWithBase(proj.path, a.branch, a.worktree_path, base);
      const pr = await openSessionPr({
        repoPath: proj.path,
        localBranch: a.branch,
        prBranch: sessionPrBranch(sessionId, slug ?? title),
        title,
        body,
        base,
        draft,
      });
      upsertSessionPr({
        sessionId,
        url: pr.url,
        agentId,
        projectName: a.project_name,
        number: pr.number,
        title,
        state: draft ? "draft" : "open",
        headBranch: pr.headBranch,
      });
      // A known local conflict needn't wait for GitHub's mergeability calculation
      // or the next watcher tick. Share its guards so retries cannot double-spawn
      // or bypass the per-PR budget; once open, repair failures are best-effort.
      if (baseSync.status === "conflict") {
        const prRow = listSessionPrs(sessionId).find((row) => row.url === pr.url);
        if (!config.prWatch.enabled) baseSync.prFixSkipped = "PR watch is disabled";
        else if (!session.plan_approved_at) baseSync.prFixSkipped = "Session plan is not approved";
        else if (!prRow || !isWatchablePr(prRow) || prRow.number === null || !prRow.head_branch)
          baseSync.prFixSkipped = "PR is not watchable or lacks its number/head branch";
        else if (prFixBusy(prRow.id)) baseSync.prFixSkipped = "A PR fix is already running or awaiting post-fix";
        else if (prFixCapReached(prRow.id, config).reached) baseSync.prFixSkipped = "PR fix daily cap reached";
        else {
          try {
            const { agent } = await spawnPrFixAgent(session, prRow, proj, config, {
              origin: "auto",
              conflict: true,
              baseBranch: baseSync.base,
              title,
            });
            baseSync.prFixAgentId = agent.id;
          } catch (err) {
            baseSync.prFixSkipped = `Could not start PR fix: ${(err as Error).message}`;
          }
        }
      }
      // Start (or keep) the session's PR watcher so review feedback and merge
      // conflicts on this PR get picked up automatically. Best-effort: the PR is
      // already open, so a watcher hiccup must not turn this into a tool error.
      try {
        spawnPrWatcher(sessionId, config); // no-op when disabled or already running
      } catch {
        /* the dashboard's refresh will retry starting it */
      }
      return text({
        ok: true, url: pr.url, number: pr.number, branch: pr.headBranch,
        prWatch: config.prWatch.enabled, baseSync,
      });
    },
  );

  server.registerTool(
    "fix_pr",
    {
      description:
        "Update an existing session PR: use this for any change to an open PR, including follow-ups the " +
        "human asked for (put them in `prompt`), a conflict that persists, or a failed fix run (pass `model` " +
        "to choose another model). Continues the eligible PR lineage automatically (returns continued/fallbackReason); " +
        "fresh: true forces a new conversation. The PR watcher pushes " +
        "its commits non-force onto the same PR branch and replies to review feedback when it finishes. " +
        "Do not use spawn_agent + open_pr to change an existing PR: that creates a second PR. The agent " +
        "automatically gets a merge step if GitHub reports a conflict and any pending review feedback. " +
        "Runs one fix at a time per PR: refuses while another fix is running or awaiting its push. " +
        "Supervisor fix_pr runs are not subject to the watcher's daily cap and do not count toward it. " +
        "Returns immediately with the agent id.",
      inputSchema: {
        fresh: z.boolean().optional().describe("Force a new conversation instead of continuing the eligible PR lineage"),
        pr: z
          .union([z.number().int(), z.string()])
          .describe("The session PR to fix: its number (18 or \"#18\") or its URL — see check_prs"),
        prompt: z
          .string()
          .optional()
          .describe("Extra guidance for the fix agent: what to change or why the last run failed"),
        model: z.string().optional().describe("Model key; defaults to roles.agent (picked at random when several are set)"),
      },
    },
    async ({ pr: ref, prompt, model, fresh: forceFresh }) => {
      const session = requireSession();
      // Same plan-gate as spawn_agent: a fix run is an agent run.
      if (!session.plan_approved_at)
        throw new Error(
          "Plan not approved yet. Present your plan to the human and let them accept it before starting any " +
            "agents. `fix_pr` stays blocked until then. " +
            `If the human says they never saw an approval prompt, they can type \`/approve\` in the session or run \`tack session approve ${sessionId}\` themselves.`,
        );
      const pr = resolveSessionPr(listSessionPrs(sessionId), ref);
      const tag = `PR #${pr.number ?? "?"}`;
      if (!isWatchablePr(pr)) throw new Error(`${tag} is ${pr.state}; there's nothing to fix.`);
      if (pr.number === null) throw new Error(`${tag} (${pr.url}) has no PR number recorded; can't fix it.`);
      if (!pr.head_branch)
        throw new Error(`${tag} has no head branch recorded, so a fix couldn't be pushed onto it.`);
      if (prFixBusy(pr.id))
        throw new Error(
          `A fix for ${tag} is already running or awaiting its push/replies. Use check_prs to follow it, and ` +
            "call fix_pr again once it has finished and been post-fixed.",
        );
      const m = model ? resolveModel(config, model) : modelForRole(config, "agent");
      // Same fail-fast as spawn_agent — the very failure fix_pr is often called to
      // recover from is a fix run that died on a model the login doesn't offer.
      const offered = checkModelOffered(config, m, { role: model ? undefined : "agent" });
      if (offered.ok === false)
        throw new Error(`Refusing to fix ${tag}: ${offered.message}. Pass \`model\` to pick one that is offered.`);

      const project = config.projects.find((p) => p.name === pr.project_name);
      if (!project) throw new Error(`${tag}'s project "${pr.project_name ?? "?"}" isn't in the config.`);

      // Poll live (and persist, as the watcher does) so the agent is told about the
      // conflict and base GitHub reports now, not at the last tick.
      const { status, state, mergeable } = await pollPrStatus(pr.id, project.path, pr.number);
      if (state === "merged" || state === "closed") throw new Error(`${tag} is ${state}; there's nothing to fix.`);
      const conflict = mergeable === "CONFLICTING";
      // Fold in feedback the watcher hasn't ingested yet so this run addresses it
      // too, rather than a second run right after. Best-effort: the fix still runs
      // on the conflict / guidance / already-pending items if gh can't list threads.
      let fresh: ReturnType<typeof normalizeFeedback> = [];
      try {
        const threads = await fetchReviewThreads(project.path, pr.number);
        fresh = normalizeFeedback(status, threads, prFeedbackSourceIds(pr.id));
      } catch {
        /* the watcher's next tick picks them up */
      }

      const { agent, items, continued, fallbackReason } = await spawnPrFixAgent(session, pr, project, config, {
        origin: "supervisor",
        conflict,
        baseBranch: status.baseRefName,
        title: status.title,
        fresh,
        model: m,
        guidance: prompt,
        forceFresh,
      });
      // The watcher owns the post-fix push + replies; make sure one is running.
      // Best-effort, like open_pr: the agent is already spawned.
      try {
        spawnPrWatcher(sessionId, config); // no-op when disabled or already running
      } catch {
        /* the dashboard's refresh will retry starting it */
      }
      const after = "Use wait_for_agents on it, then check_prs to see the result.";
      return text({
        agentId: agent.id,
        pr: pr.number,
        conflict,
        feedbackItems: items,
        continued,
        fallbackReason,
        model: m.name,
        note: !config.prWatch.enabled
          ? "PR watch is disabled (prWatch.enabled = false), so nothing will push this agent's commits onto " +
            `the PR; they'll stay on the agent's branch. ${after}`
          : config.prWatch.autoPush
            ? `When the agent finishes, the PR watcher pushes its commits onto ${pr.head_branch} and posts ` +
              `replies to any feedback. ${after}`
            : "prWatch.autoPush is off, so the agent's commits will stay on its own branch rather than being " +
              `pushed to ${pr.head_branch}. ${after}`,
      });
    },
  );

  server.registerTool(
    "check_prs",
    {
      description:
        "Snapshot of this session's pull requests as the PR watcher sees them: state, mergeability, " +
        "review feedback (pending, and handled with the decision + reply link), and the pr_fix agents Tack " +
        "spawned to address it. Tack handles PR feedback and merge conflicts automatically — use this to report " +
        "on it. Read-only by default; refresh updates PR statuses immediately and wakes or starts the watcher " +
        "only if PRs remain open. Feedback handling happens asynchronously in the watcher. For any change " +
        "to an open PR (human follow-ups, a persistent conflict, a failed run), call fix_pr to update the same PR branch.",
      inputSchema: { refresh: z.boolean().optional().default(false) },
      annotations: { readOnlyHint: false },
    },
    async ({ refresh }) => {
      requireSession();
      const pollTriggered = refresh ? await triggerPrWatch(sessionId, config) : undefined;
      const s = requireSession();
      return text({
        ...(pollTriggered ? { pollTriggered } : {}),
        watcherPid: s.pr_watch_pid,
        prWatchEnabled: config.prWatch.enabled,
        prs: listSessionPrs(sessionId).map((pr) => {
          const feedback = listPrFeedback(pr.id);
          const brief = (f: (typeof feedback)[number]) => ({
            sourceId: f.source_id,
            kind: f.source_kind,
            author: f.author,
            url: f.url,
            decision: f.decision,
            reply: f.reply_ref ? readArtifact(f.reply_ref) : undefined,
            replyUrl: f.reply_url,
            fixAgentId: f.fix_agent_id,
          });
          return {
            number: pr.number,
            url: pr.url,
            title: pr.title,
            state: pr.state,
            mergeable: pr.mergeable,
            baseBranch: pr.base_branch,
            headBranch: pr.head_branch,
            checkedAt: pr.checked_at,
            pendingFeedback: feedback.filter((f) => !f.handled_at).map(brief),
            handledFeedback: feedback.filter((f) => f.handled_at).map(brief),
            fixAgents: listPrFixAgents(pr.id).map((a) => ({
              id: a.id,
              status: a.status,
              cost: a.cost,
              error: a.error,
              postFixed: Boolean(a.post_fixed_at),
              outcome: a.fix_outcome,
              pushedSha: a.fix_pushed_sha,
            })),
          };
        }),
      });
    },
  );

  // Ticket tracking is local bookkeeping (a row in `session_jira_tickets`), never a
  // write to Jira — so unlike `open_pr` these ride the server-wide auto-allow and are
  // deliberately absent from SUPERVISOR_APPROVAL_TOOLS.
  server.registerTool(
    "link_jira_ticket",
    {
      description:
        "Link a JIRA ticket this session is working on (e.g. one named in the problem, or one you found via " +
        "the Atlassian MCP) so the human sees it beside the session's agents and PRs, with its live status. " +
        "Local tracking only — this NEVER creates, edits, comments on, or transitions anything in Jira. " +
        "Idempotent: re-linking updates the existing entry.",
      inputSchema: {
        key: z.string().describe("Ticket key, e.g. ABC-123"),
        agentId: z.string().optional().describe("The agent in this session working the ticket, if any"),
        title: z.string().optional().describe("Ticket summary, if you already know it (refreshed from Jira anyway)"),
        status: z.string().optional().describe("Ticket status name, if you already know it (refreshed from Jira anyway)"),
      },
    },
    async ({ key, agentId, title, status }) => {
      requireSession();
      const k = key.trim().toUpperCase();
      if (!JIRA_KEY_RE.test(k)) throw new Error(`"${key}" isn't a JIRA ticket key (expected e.g. ABC-123)`);
      if (agentId) {
        const a = getAgent(agentId);
        if (!a || a.session_id !== sessionId) throw new Error(`Agent ${agentId} isn't part of this session`);
      }
      const row = upsertSessionJiraTicket({
        sessionId,
        key: k,
        agentId,
        url: jiraTicketUrl(config, k),
        title,
        status,
      });
      return text({ ok: true, key: row.key, url: row.url });
    },
  );

  server.registerTool(
    "unlink_jira_ticket",
    {
      description:
        "Stop tracking a JIRA ticket on this session (e.g. linked by mistake). Local only — Jira is untouched.",
      inputSchema: { key: z.string().describe("Ticket key, e.g. ABC-123") },
    },
    async ({ key }) => {
      requireSession();
      const k = key.trim().toUpperCase();
      return text({ ok: true, key: k, removed: unlinkSessionJiraTicket(sessionId, k) });
    },
  );

  server.registerTool(
    "check_agents",
    {
      description: "Snapshot of this session's agents: status, model, cost (non-blocking).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(listAgents(sessionId).map(agentSummary)),
  );

  server.registerTool(
    "wait_for_agents",
    {
      description:
        "Block until the given agents (or all agents) reach a terminal state (done/failed/stopped), or the " +
        "timeout elapses. Returns their final status. Prefer this over polling check_agents.\n\n" +
        "This is also how the system routes amendments to you: if an agent proposes an amendment to the shared " +
        "contract while you wait, this returns early with `pendingAmendments` set (and done=false). Adjudicate " +
        "each with resolve_amendment (updating the shared context if you accept), then call wait_for_agents " +
        "again to keep waiting. Agents continue under the current contract meanwhile.",
      inputSchema: {
        agentIds: z.array(z.string()).optional().describe("Specific agents to await; omit for all"),
        timeoutSeconds: z.number().optional().describe("Max wait (default 1800)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ agentIds, timeoutSeconds }) => {
      const deadline = Date.now() + (timeoutSeconds ?? 1800) * 1000;
      while (Date.now() < deadline) {
        // Surface amendments first so a proposal is never missed: an agent that
        // proposes one keeps working under the current contract, so without this the
        // supervisor wouldn't see it until every agent finished. Returning early makes
        // the coordination loop itself drive resolution (the system orchestrates it).
        const pending = listPendingAmendments(sessionId);
        if (pending.length > 0) {
          return text({
            done: false,
            pendingAmendments: pending.map((am) => ({
              id: am.id,
              proposedBy: am.proposed_by,
              proposal: readArtifact(am.proposal_ref),
            })),
            agents: listAgents(sessionId)
              .filter((a) => !agentIds || agentIds.includes(a.id))
              .map(agentSummary),
            note:
              "An agent proposed an amendment to the shared contract. Adjudicate each with resolve_amendment " +
              "(revise the shared context if you accept), then call wait_for_agents again to keep waiting.",
          });
        }
        const agents = listAgents(sessionId).filter((a) => !agentIds || agentIds.includes(a.id));
        if (agents.length > 0 && agents.every((a) => TERMINAL.includes(a.status))) {
          return text({ done: true, agents: agents.map(agentSummary) });
        }
        await sleep(3000);
      }
      return text({ done: false, timedOut: true, agents: listAgents(sessionId).map(agentSummary) });
    },
  );

  server.registerTool(
    "read_agent_output",
    {
      description: "Read an agent's final result and a preview of its diff.",
      inputSchema: { agentId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ agentId }) => {
      const a = getAgent(agentId);
      if (!a) throw new Error(`Unknown agent ${agentId}`);
      const output = readArtifact(a.output_ref);
      const diff = readArtifact(a.diff_ref);
      return text({
        status: a.status,
        cost: a.cost,
        branch: a.branch,
        output: output || "(no textual output captured)",
        diffPreview: diff ? diff.split("\n").slice(0, 200).join("\n") : "(no diff)",
      });
    },
  );

  server.registerTool(
    "check_conflicts",
    {
      description:
        "Check for collisions across the session's agents BEFORE opening PRs: files that more than one agent " +
        "changed in the same project (a merge conflict waiting to happen across the N branches). Run this once " +
        "agents finish; if it reports collisions, resolve them with continue_agent on the owning agent before " +
        "opening pull requests. Empty means the branches touch disjoint files and should merge cleanly.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const collisions = sessionFileCollisions(listAgents(sessionId), config);
      return text({
        clean: collisions.length === 0,
        collisions,
      });
    },
  );

  server.registerTool(
    "list_amendments",
    {
      description: "Pending amendment proposals from agents, awaiting your adjudication.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        listPendingAmendments(sessionId).map((am) => ({
          id: am.id,
          proposedBy: am.proposed_by,
          proposal: readArtifact(am.proposal_ref),
        })),
      ),
  );

  server.registerTool(
    "resolve_amendment",
    {
      description:
        "Adjudicate a pending amendment. On accept you may supply revised shared-context text, which becomes " +
        "the new contract version.",
      inputSchema: {
        id: z.string(),
        decision: z.enum(["accept", "reject"]),
        note: z.string().optional(),
        newContext: z.string().optional().describe("Revised full contract (on accept)"),
      },
    },
    async ({ id, decision, note, newContext }) => {
      const resolutionRef = note ? writeAmendmentArtifact(sessionId, id, "resolution", note) : null;
      resolveAmendment(id, decision === "accept" ? "accepted" : "rejected", resolutionRef);
      if (decision === "accept" && newContext) {
        const version = (latestVersion(sessionId) ?? 0) + 1;
        const ref = writeSharedContext(sessionId, version, newContext);
        addSharedContext({ sessionId, bodyRef: ref, authoredBy: "supervisor" });
        return text({ ok: true, decision, newContextVersion: version });
      }
      return text({ ok: true, decision });
    },
  );

  await server.connect(new StdioServerTransport());
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function agentSummary(a: ReturnType<typeof listAgents>[number]) {
  return {
    id: a.id,
    ...(a.kind ? { kind: a.kind } : {}),
    project: a.project_name,
    status: a.status,
    model: a.model,
    runtime: a.runtime,
    cost: a.cost,
    branch: a.branch,
  };
}

/**
 * Resolves `fix_pr`'s `pr` argument against the session's PRs: an exact URL, or a
 * number (`18`, `"18"`, `"#18"`, or a PR URL's trailing number when the URL itself
 * isn't recorded). Errors name the session's PRs so the supervisor can retry, and a
 * number shared by PRs in two repos is refused as ambiguous rather than guessed.
 */
function resolveSessionPr(prs: SessionPrRow[], ref: number | string): SessionPrRow {
  const list = () =>
    prs.length ? prs.map((p) => `#${p.number ?? "?"} ${p.url}`).join("; ") : "(this session has no PRs)";
  const raw = typeof ref === "number" ? String(ref) : ref.trim();
  const byUrl = prs.find((p) => p.url.replace(/\/+$/, "") === raw.replace(/\/+$/, ""));
  if (byUrl) return byUrl;
  const num = /^#?(\d+)$/.exec(raw)?.[1] ?? /\/pull\/(\d+)\/?$/.exec(raw)?.[1];
  const matches = num ? prs.filter((p) => p.number === Number(num)) : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new Error(`PR number ${num} is ambiguous in this session; pass its URL. Session PRs: ${list()}`);
  throw new Error(`"${raw}" isn't a PR in this session. Session PRs: ${list()}`);
}

function latestVersion(sessionId: string): number | null {
  return latestSharedContext(sessionId)?.version ?? null;
}

# Tack — Specification & Design

Tack is a **runtime-neutral supervisor** that sits on top of coding-agent CLIs —
Claude Code (`claude`) and the Codex CLI (`codex`) — and coordinates parallel work
across projects. It plans, delegates to agents running in isolated git worktrees,
shares context between them, tracks cost and PRs, and gives you one dashboard of
everything in flight. It deliberately reimplements **none** of the agent loop that
those CLIs already provide.

This document is the source of truth for *why* Tack is built the way it is. Code
comments explain the local "how"; this explains the "why" and the shape of the
whole. `AGENTS.md` (contributor guide) points here.

---

## Positioning: the supervisor is the product

A class of tools looks superficially similar — "run many coding agents" — but they
solve a different half of the problem, and Tack should not try to out-build them on
theirs.

- **An agent *runtime* is plumbing.** Its job is to keep agent processes
  alive across restarts and disconnects, sync them across machines over SSH, and
  show liveness (working / blocked / idle). It wraps *any* CLI transparently and
  has no opinion about *what* the agents work on. The user is still the
  orchestrator: you open N terminals and tell each agent what to do.
- **Tack is a *supervisor* — a brain.** A persistent planning agent investigates,
  decomposes the work, and *delegates* units to agents, then reconciles their
  results into a set of **reviewable pull requests — one per unit of work**. The
  user describes an outcome; Tack decides how to fan it out. The deliverable is N
  PRs a human reviews and merges, not an auto-merged mega-change.

**The wedge is orchestration intelligence, not process persistence.** We compete
on the layer *above* the runtime, and deliberately cede the plumbing layer:

- **Lean into:**
  - **The planning / decomposition layer as the headline.** "Describe the outcome,
    I fan it out into N reviewable PRs," not "I keep your N agents alive." Tack
    decomposes and coordinates; a human still reviews and merges each PR.
  - **Cross-runtime *context sharing*.** A runtime wraps CLIs as opaque processes
    that can at most coordinate over a socket. Tack shares *context* between a
    Claude agent and a Codex agent working the same problem — pick the best model
    per unit of work and they still share what they learned. This is structurally
    impossible for a tool that never looks inside the loop.
  - **The accountability / ROI view.** Per-unit cost tracking and PR discovery
    reframe the tool from "are my agents alive?" to "what did this plan cost and
    what shipped?" — a manager's view, not just an operator's.
  - **Correctness of parallel work, not just liveness.** The unsolved pain in
    multi-agent coding is collision — merge conflicts, duplicated work, agents
    stepping on each other — not uptime. Isolated worktrees are the floor;
    conflict prediction and dependency ordering before dispatch are the ceiling,
    and they are squarely the supervisor's job.

- **Do not compete on:**
  - Multi-machine / SSH / "survives laptop sleep" persistence — a runtime's moat.
    Tack can ride *on top of* such a runtime rather than rebuild it.
  - Breadth of supported CLIs. Depth on two (Claude + Codex) with real
    context-sharing beats shallow support for twenty.

A runtime keeps the herd alive; Tack decides what the herd works on and turns the
results into reviewable PRs. That one-sentence distinction is something a runtime cannot claim without
rebuilding its whole architecture — and it is the reason every design decision
below favors the supervisor's intelligence over reimplementing the agent loop.

---

## 1. Goals & non-goals

**Goals**

- **Runtime-neutral.** A "model" is any model either CLI offers; a "runtime" is the
  CLI that model runs on (`claude` or `codex`). Tack treats both identically.
- **Transparent delegation.** Delegating to a runtime should "just work" and let us
  ride the CLIs' feature velocity. We will never reach or hold feature parity with
  them, so we don't try — we shell out and inherit whatever they ship.
- **Supervisor + Agents.** A persistent planning agent (the *supervisor*) spins up
  *agents* to do the work it plans and coordinates.
- **Isolated work.** All work happens in git worktrees Tack creates and coordinates.
- **Shared context** across agents, even across different runtimes.
- **Per-session cost tracking**, a **dashboard** of live work, **PR tracking**,
  and **user-configurable** behavior.
- **Version pinning** of each runtime CLI for reproducibility.

**Non-goals (for now)**

- No custom chat interface.
- No re-implementation of tools, permission systems, or agent loops.
- No Bedrock / open-weight models yet (not approved at Chime). Bedrock will become a
  third runtime when it lands; the model→runtime abstraction already anticipates it.

---

## 2. The central decision: how to integrate the runtimes

Three options were evaluated. **Tack shells out to the one-shot headless
entrypoints** (`claude -p --output-format stream-json`, `codex exec --json`) and
owns the pid/lifecycle/registry itself.

| | A. Headless subprocess (chosen) | B. Native background-agent managers | C. SDKs |
|---|---|---|---|
| Symmetric across both CLIs | ✅ both GA | ❌ Claude has `claude agents`; Codex only has the experimental `app-server` JSON-RPC | ⚠️ two different SDK shapes; no Codex Python SDK |
| Feature-velocity coupling | ✅ none — inherit whatever the CLI ships | ⚠️ couples to sockets/sqlite/protocol versions | ❌ reintroduces a parity treadmill |
| Cost data | ✅ `total_cost_usd` from Claude; tokens from both | ⚠️ registry has no cost; `--bg` isn't a `-p` run so it loses easy USD | ✅ typed usage |
| Worktree ownership | ✅ Tack owns it | ❌ `claude rm -w` fights Tack-owned worktrees | ✅ Tack owns it |

**Why A wins:** it's the only mechanism that is symmetric, GA-stable on both, and
zero-coupling, and it preserves Claude's authoritative cost figure. The native
background managers are asymmetric (Codex has no CLI equivalent, only an
experimental protocol) and would double the integration surface; the SDKs
reintroduce the version coupling we explicitly want to avoid.

**The reframe:** the valuable part of a "background agent manager" (a registry,
status, logs, resume, IPC) becomes something **Tack provides once, uniformly**, by
spawning GA headless subprocesses underneath each runtime (a detached supervisor
plus a pid-liveness registry).

*Escape hatch kept in mind, not built:* Claude's interactive `claude attach` is
genuinely unique. It could later be exposed as a Claude-only convenience; the
architecture is not built around it.

---

## 3. Object model

Two entities — the supervisor delegates directly to agents (there is no
intermediate "run" layer).

```
Session ──has many── Agent ──runs in── Worktree
   │                    │
   │                    └── backed by a Runtime (claude|codex) + Model
   │                    └── produces a Diff + (optionally) a PR
   └── the supervisor conversation; rolls up cost; owns shared context & PRs
```

- **Supervisor** — the persistent planning agent. Investigates read-only, plans,
  delegates, coordinates, reconciles. Runtime-neutral (pinned to a configured
  model). It never edits code itself.
- **Agent** — one worktree + one runtime process, driven to completion and
  resumable. Autonomous inside its worktree.
- **Runtime** — a thin adapter (`claude` | `codex`) implementing one streaming
  interface. Each model is bound to exactly one runtime in config.
- **Project** — config-driven `{ name, path, description, metadata? }`;
  `description` is load-bearing (the supervisor reasons over it to pick relevant
  repos). `metadata` carries auto-filled tech-stack facts (`language`,
  `frameworks`) the supervisor can also route on.
- **Session** — a supervisor invocation and everything it dispatches. Cost rolls up
  here (supervisor conversation + all its agents).
- **PR** — discovered via `gh` + branch-name convention, tied back to the session.

---

## 4. Context sharing (the crux)

Three runtime-neutral planes. **Repo-checked-in `CLAUDE.md` / `AGENTS.md` are left
untouched** — they belong to the repo. Tack layers its own context separately.

1. **Static / spawn-time.** The supervisor materializes a single **session-scoped
   context file per agent** (under `~/.tack/context/<sessionId>/`) and injects it
   **by path** — `claude --append-system-prompt-file`; for codex, a short `-c
   developer_instructions=…` directive to read the file first (codex's
   `model_instructions_file` would *replace* its base prompt, not add to it). Long
   context never goes on the command line.
2. **Live shared state.** Every agent's CLI mounts the **Tack coordination MCP
   server** (`tack __mcp <sessionId> <agentId>`), a standalone stdio MCP server
   backed by the shared SQLite DB. Tools: `read_shared_context`, `list_agents`,
   `propose_amendment`. Because it's the same DB, a `claude` agent and a `codex`
   agent share context identically. This is the cross-runtime bus.
3. **Handoff.** An agent's result/diff is written to the filesystem; the supervisor
   reads it (`read_agent_output`) and folds it into the next spawn's context. The
   CLIs' native session stores (`~/.claude/projects`, `~/.codex/sessions`) are never
   bridged — only their session *ids* are kept, to resume.

The supervisor has a *second* MCP server (`tack __supervisor-mcp <sessionId>`) with
the coordination tools it needs: `list_projects`, `sync_projects` (fetches the
affected projects and checks each default-branch tip out into a detached snapshot
worktree under `snapshots/<sessionId>/<project>` — the only project code the
supervisor reads), `set_shared_context`,
`request_plan_approval` (the attended plan gate, see §9),
`spawn_agent` (with `touches`/`dependsOn`), `continue_agent` (pre-PR follow-ups), `check_agents`, `wait_for_agents` (blocks
server-side so the planner doesn't burn tokens polling, and returns early with any
`pendingAmendments` so the system routes an agent's proposal back to the supervisor
to adjudicate), `check_conflicts`, `read_agent_output`, `list_amendments`,
`resolve_amendment`, plus the PR tools `open_pr`, `check_prs`, and `fix_pr` (a
`pr_fix` agent on an existing session PR's own branch — §11 PR watch). Amendment resolution is therefore orchestrated by the system,
not by the human — `tack dashboard` only surfaces pending amendments read-only.

---

## 5. Cost tracking

Two sources, reconciled behind one `AgentEvent`:

- **claude** reports `total_cost_usd` directly → recorded with `cost_source =
  "runtime"` (authoritative).
- **codex** reports **tokens only** → Tack computes USD from the model's `pricing`
  table (USD per 1M tokens) → `cost_source = "pricing"`. Codex models therefore
  **must** carry pricing to yield a cost.

`sessionTotalCost = supervisor conversation cost + Σ agent costs`, derived on read
so background agents stay authoritative for their own spend.

---

## 6. Version pinning & managed installs

Each runtime can be pinned in config:

```ts
runtimes: {
  claude: { version: "2.1.261" },                                  // advisory pin (warn on drift)
  codex:  { bin: "~/.local/bin/codex", version: "0.147.0", versionPolicy: "strict" },
}
```

**Resolution** (`src/runtimes/resolve.ts`) picks a binary in priority order: an
explicit `bin` override; else a Tack-managed install of the pinned version; else the
runtime name on PATH. The pinned `version` is checked against `<bin> --version`
(substring match, since formats differ) **before any run**. How a mismatch is handled
is governed by the runtime's `versionPolicy`:

- **`"warn"` (default)** — log one drift notice to stderr and continue. The pin is
  advisory, so a self-updating CLI (claude updates itself in the background) never
  bricks a run the moment it bumps. `tack runtimes sync` re-pins to what's installed.
- **`"strict"`** — a mismatch throws, stopping the run. For reproducible setups where
  an unexpected CLI upgrade must not silently change behavior.
- **`"off"`** — skip the check entirely.

Verification is cached per binary, and the warn notice is deduped per process so a
session spinning up many agents prints it once. The default is runtime-agnostic:
`versionPolicy` lives in the shared runtime settings, so every runtime (and any future
one, e.g. Bedrock) inherits the same behavior with no runtime-specific code.

**Transparent installs** (`src/runtimes/install.ts`). `tack init` and `tack runtimes install`
ensure the pinned versions are present. If a pinned version isn't already installed
(managed or on PATH), Tack installs it into an isolated, Tack-owned directory —
`~/.tack/runtimes/<kind>/<version>` — via a package manager (`bun add
@anthropic-ai/claude-code@<v>` / `@openai/codex@<v>`), never a piped shell
installer, and never over a global/system install. An explicit `bin` override is
verified only (Tack never installs over a user-managed path); an unpinned runtime is
reported present if on PATH, otherwise left to the user. `tack runtimes doctor`
reports resolution, drift, and pin status without changing anything; `tack runtimes
list` gives a status overview; and `tack runtimes sync` re-pins each runtime to the
version currently installed (the one-command fix after a background CLI upgrade).

---

## 7. Persistence & filesystem layout

State root is `~/.tack/` (override `TACK_HOME`). **The DB stores metadata and refs
only; all large text lives on the filesystem, referenced by path.**

```
~/.tack/
  config.ts                       # user config (plain `export default {…}` object)
  state.db                        # SQLite — metadata + *_ref paths only
  worktrees/<sessionId>/<agentId>/  # Tack-owned git worktrees
  snapshots/<sessionId>/<project>/  # detached default-branch snapshots the supervisor reads
  context/<sessionId>/*.md        # session-scoped context files (injected by path)
  artifacts/<sessionId>/<agentId>/{prompt,output,diff}.…   # DB *_ref targets
  artifacts/<sessionId>/shared-context/vN.md
  supervisor/<sessionId>/         # supervisor scratch cwd
  logs/<sessionId>/…              # normalized per-agent / supervisor logs
  runtimes/<kind>/<version>/      # Tack-managed pinned runtime installs
```

**Coexistence:** Tack uses distinct filenames (`config.ts`, `state.db`) under the
root, so it can share `~/.tack` with another CLI that uses that directory without
colliding on config or database.

### DB schema (SQLite, `state.db`)

```
sessions(id, title, supervisor_model, runtime, resume_ref,
         status[active|archived], cost, pid, heartbeat_at, created_at, updated_at,
         supervisor_code_version, pr_watch_code_version, supervisor_turn_started_at)

agents(id, session_id→sessions, project_name, worktree_path, branch,
       status[pending|running|done|failed|stopped], model, runtime, resume_ref, interrupted_at,
       cost, cost_source[runtime|pricing], tokens_input, tokens_output,
       cache_read, cache_write, pid, prompt_ref, output_ref, diff_ref,
       created_at, updated_at)

shared_context(session_id→sessions, version, body_ref, authored_by, created_at,
               PK(session_id, version))

amendments(id, session_id→sessions, proposed_by→agents, proposal_ref,
           status[pending|accepted|rejected], resolution_ref, created_at, resolved_at)

session_prs(id, session_id→sessions, agent_id, project_name, number, url, title,
            state, head_branch, mergeable, base_branch, head_sha, checked_at,
            created_at, updated_at, UNIQUE(session_id, url))

pr_feedback(id, session_pr_id→session_prs, source_id,
            source_kind[review_thread|review|issue_comment|ci_check], author, author_is_bot,
            url, path, line, in_reply_to, body_ref, fix_agent_id,
            decision[pending|fixed|declined|not_applicable|failed], reply_ref,
            reply_url, created_at, handled_at, UNIQUE(session_pr_id, source_id))

session_jira_tickets(id, session_id→sessions, agent_id, key, url, title, status,
                     status_category[new|indeterminate|done], created_at,
                     updated_at, UNIQUE(session_id, key))
```

`sessions` also carries `pr_watch_pid`; `agents` carries `kind` (NULL | `pr_fix` |
`review` | `manual` — see "Manual workspaces" below),
`session_pr_id`, `post_fixed_at`, `fix_outcome`, `fix_pushed_sha`, and
`continues_agent_id` (see §11 PR watch). Continuation prompt refs, start markers,
and per-fix diff baselines survive detached retries and archive restore. Because a
PR's `pr_fix` row is reused across fix runs, the agent's `post_fixed_at` /
`fix_outcome` / `fix_pushed_sha` / `fix_origin` describe its **latest** run; the
per-run history lives in `pr_fix_runs(id, agent_id→agents, session_pr_id, origin,
created_at, finished_at, outcome, pushed_sha)` — one row per fix spawn, finished
when post-fix latches (migration 19 backfilled one run per existing fix agent).

Any column that could hold a blob (`prompt`, `output`, `diff`, context/amendment
bodies) is a `*_ref` path, never inline text.

---

## 8. Runtime adapters

Every runtime normalizes to one streaming contract (`src/runtimes/types.ts`):

```ts
interface Runtime {
  readonly kind: "claude" | "codex";
  run(opts: RunOptions): AsyncIterable<AgentEvent>;
}
```

`AgentEvent` = `session | text | tool_call | tool_result | usage | cost | log |
done | error`. `RunOptions` carries the resolved `bin`, `model`, worktree `cwd`,
`sessionRef` (pre-assigned UUID for claude / captured for codex), `contextFile`,
`mcpServers[]`, `readOnly` (supervisor) and `addDirs` (extra read scope).

Adapter specifics, hidden behind the interface:

- **claude** (`src/runtimes/claude.ts`): `claude -p --output-format stream-json
  --verbose --model <id>`; autonomous agents use `--permission-mode auto
  --permission-prompts none`; the supervisor uses `--permission-mode plan
  --permission-prompts none --disallowedTools Edit,Write,NotebookEdit,Task,Agent,Bash`
  (Bash disallowed via `disallowShell` so a delegate-only run can't shell out to
  write files); MCP via inline `--mcp-config` JSON + `--strict-mcp-config`; cost from
  the final `result` event's `total_cost_usd`. The **interactive** supervisor
  does NOT use plan mode (its native `ExitPlanMode` menu can't be relabelled or
  overridden by a hook): it blocks edits via a `--settings` `permissions.deny` list
  (`Edit`, `Write`, `NotebookEdit`, `ExitPlanMode`, `EnterPlanMode`), auto-allows the
  mounted MCP servers through four layers (`--allowedTools mcp__<server>`, a
  PreToolUse `allow` hook, `permissions.allow` in `--settings`, and the same rule
  merged and deduped into the Tack-owned cwd's `.claude/settings.local.json`
  without clobbering existing or corrupt files), and wires a PreToolUse hook
  on `mcp__tack-supervisor__request_plan_approval` that runs `tack __await-plan <id>`
  — marking the session as awaiting input. The supervisor writes the full plan in chat
  before calling the tool with it; the dialog shows a prompt line and the full plan. The auto-allowed tool
  handler presents an MCP elicitation form with one optional
  "What would you change?" field. Submitting it blank approves and opens the `spawn_agent` gate;
  non-empty feedback returns keep-planning with that feedback for revision and
  another approval request, while cancellation asks the supervisor to clarify
  changes in chat. Both leave the plan unapproved.
  If the prompt never appears, the human can type `/approve` in the session or run
  `tack session approve <session>` themselves, then return to the session. Tack
  refreshes `.claude/commands/approve.md` on every attended Claude launch (including
  resume); a UserPromptSubmit hook recognizes the command or its expanded marker
  and opens the plan gate, adding context so the supervisor proceeds to spawn agents.
  Attended Claude sessions also provide `/review <persona> [focus…]`
  and `/pr-fix [on|off]`; Tack executes them in the prompt hook.
  Both escape hatches preserve the first approval timestamp and clear the
  awaiting-input flag; neither adds a supervisor-callable approval path. A plain
  chat "yes" is never approval.
  Follow-up questions also show "◆ needs input" (`awaiting_reason` `"question"`).
  A PreToolUse hook on Claude's native `AskUserQuestion` runs the silent
  `tack __await-input <id> question`, and a PostToolUse hook clears it with `--clear`
  once answered. Plain-text questions are caught at turn end (below). The next
  submitted prompt clears a question too. None of these paths overwrites or clears
  a pending `"plan"` flag, which keeps the lifecycle above, so only `"plan"` blocks
  `session refresh`.
  With `autoOpenPrs: false`, `open_pr` is excluded from the allow hook and backed
  by a `permissions.ask` rule; its ask hook supplies the prompt wording.
  Attended runs create `<TACK_HOME>/supervisor/<sessionId>/artifacts` for
  human-requested publishable page sources only (never plans, notes, contracts or
  code). `writableDirs` and a caller-built `writeGuard` command let Claude replace
  the blanket Edit/Write deny with absolute-path allows plus a PreToolUse
  `tack __guard-write <dir>...` hook. It realpaths roots and existing ancestors,
  denies malformed input and escapes, and permits only strict descendants. It also
  allows this Claude session's scratchpad at
  `<claudeTmpRoot>/claude-<uid>/<sanitizedCwd>/<session_id>/scratchpad`, derived from
  hook stdin (`cwd` with non-alphanumeric characters replaced by `-`, and a
  `session_id` matching `^[A-Za-z0-9-]+$`). The temp root is the realpath of
  `$CLAUDE_CODE_TMPDIR` or `/tmp`; without a process uid this allowance is skipped.
  The scratchpad may not exist yet, so its root uses the same symlink-safe
  ancestor walk as write targets. Page sources should still go in `artifacts`;
  refused writes must be redone there before publishing again. The
  parent cwd's `.claude` settings stay unwritable; Tack still adds only MCP
  allows to local settings. Publishing tools retain their normal permission flow. Headless
  runs keep the original no-write posture; Codex ignores the writable-dir options.
  The supervisor server also marks its read-only tools `readOnlyHint`, including
  `sync_projects`, whose only writes are Tack-owned snapshot worktrees.
- **codex** (`src/runtimes/codex.ts`): `codex exec --json --skip-git-repo-check -m
  <id> -a never -s <workspace-write|read-only>`; session id captured from
  `session_meta`; cost computed from the final `token_count` × pricing. Codex's
  `--json` schema is version-fragile (targets an internal ~0.15x build), so parsing
  is defensive — see the field-extraction helpers.

A shared streaming helper (`src/runtimes/proc.ts`) spawns the subprocess, tees raw
stdout/stderr to the log, and yields parsed JSON lines.

---

## 9. Execution flow

1. **`tack session create`** (also bare `tack`) creates a session and launches the supervisor
   runtime read-only, with only its session snapshot root (plus `readAllowlist`)
   granted as read dirs — never the user's checkouts — and the supervisor MCP
   server mounted. By default this is the runtime's own **interactive** TUI (Claude
   Code / Codex) with inherited stdio — same delegation posture (plus the Claude
   page-source exception in §8), so you chat with the supervisor directly and
   follow up with `--resume` in the same live session. Since the TUI
   owns the terminal there is no event stream to persist; cost is recovered from the
   runtime's transcript once it exits (claude sums per-message `usage` × pricing;
   codex reads its rollout's cumulative token count). `--background` keeps the
   headless, detached, streamed runner for unattended runs.
   When tmux is available, the interactive TUI runs in `tack-<sessionId>` on
   Tack's private server (`tmux -L tack`). `prefix d` detaches with the live state
   intact; `tack session resume <session>` reattaches. `prefix N` (capital N)
   runs `detach-client -E` with the shell-quoted Tack self command followed by
   `session create`. This replaces the attach client with a normal create child,
   preserving its full lifecycle (DB row, tmux session, cost recovery, outcome
   report) while the original supervisor stays parked. After the new session
   detaches or exits, control returns to the original caller; reporting the old
   session as detached is expected. The binding is refreshed on create and attach,
   and the status hint doubles the prefix for all shortcuts when nested inside
   another tmux. `prefix B` parks the session and opens a new interactive Tack
   bug-fix session (`session create --tack-bug-from-env`). Both attach paths set
   `TACK_ATTACHED_SESSION`: detach-client's `-E` does not expand tmux formats and
   executes in the attach client's environment, so the server-wide binding can
   identify its source. `--tack-bug-from <id>` also works outside tmux; `-m` skips
   the optional inline readline question. Bug reports stay interactive even with
   `-b`. A bounded digest (metadata, original prompt, contract, agents, PRs,
   conversation/pane tail and supervisor log) is written to the new supervisor's
   cwd as `tack-bug-report.md`, never passed in tmux argv. The short seed directs
   the supervisor to read it first, then sync project `tack`; missing configuration
   produces a warning in the terminal and seed. Without tmux, the supervisor runs
   directly without these shortcuts.
2. The supervisor picks the affected projects from their descriptions and calls
   `sync_projects` (best-effort, time-boxed fetch → detached checkout of
   `origin/<default>`, or HEAD with no origin), investigates those snapshots, calls
   `set_shared_context`, presents its plan, and
   gets the human's approval before any agent runs. `spawn_agent` is **plan-gated**:
   it refuses until the session's `plan_approved_at` is set. An attended claude
   session flips that gate when the human accepts the plan: the supervisor writes a
   full plan in chat before calling `request_plan_approval` with it. The
   dialog shows a prompt line and the full plan. A hook marks it awaiting input,
   and the handler elicits "What would you change?" — a blank submission approves,
   feedback keeps planning; cancellation also leaves the plan unapproved. Background runs (no human) and codex interactive sessions
   (which keep native per-tool approvals) are pre-approved up front. Once approved,
   each `spawn_agent` `prepareAgent`s (creates the row + prompt artifact) and launches
   a **detached** `tack __run-agent <agentId>` runner. Long-lived launchers check runtime version pins and model availability once per process and hand the result to the runner; missing or mismatched handoffs fall back to runner checks, and unknown model availability never blocks.
3. Each agent (`runAgent`) creates its worktree, materializes context, mounts the
   coordination server, runs its runtime autonomously, and persists usage/cost/refs
   as events stream; on completion it captures the worktree diff.
4. The supervisor `wait_for_agents`, `read_agent_output`, adjudicates amendments,
   runs `check_conflicts`, optionally spawns follow-ups, and finishes with a
   summary. It then opens **one PR per unit of work** (the deliverable — N reviewable
   PRs, see Positioning) in every affected repo, on `tack/pr/<sessionId>/<slug>`
   branches; agents only commit to their worktree, and `open_pr` folds in anything
   they left uncommitted. By default (`autoOpenPrs: true`) the supervisor opens them
   on its own once `check_conflicts` is clean — the human gate is review/merge of
   each PR, not permission to open it. The setting is presented to the supervisor
   as the human's explicit authorization to commit, push, and open PRs, so user-level
   "don't commit unless asked" rules count as already satisfied. With
   `autoOpenPrs: false` it asks first, and an attended claude session also forces a
   per-call confirmation on `open_pr`.
5. The `tack dashboard` dashboard discovers PRs via `gh`.

**Coordinating parallel work (the correctness layer).** The supervisor defaults to
**one agent per affected project** (so one PR per repo), splitting a project only
into genuinely independent units that each merit their own PR. Every worktree
forks from the project's remote default branch (`origin/HEAD`, else `origin/main` /
`origin/master`; a background refresher keeps its remote-tracking ref current, with a best-effort inline fetch when the cache is stale, missing, or disabled; local HEAD only when there is no usable origin). The `baseCache` defaults are enabled, a 120-second refresh interval, and a 600-second maximum age. Snapshot syncs also warm the cache,
so agent branches and their PRs start from current upstream code even when the
user's checkout is stale — and never from a sibling's branch — so ordered work within
one project must go to a single agent; a same-project `dependsOn` would wait but
never see its prerequisite's changes. `spawn_agent` takes an optional `touches`
(the files/dirs a unit will modify) and `dependsOn` (sibling agent ids that must
finish first, for ordering across projects). An overlapping touch-set in the same
project is reported back as a warning — a sign the split was wrong; a dependent
agent's detached runner **self-gates** on its prerequisites (polling the shared DB)
before it starts, so no separate scheduler is needed. `check_conflicts` reports files more than one
agent actually changed in the same project — a cross-branch merge collision to
resolve before opening PRs. This is the "conflict prediction + dependency ordering"
ceiling from Positioning; isolated worktrees remain the floor underneath it.

**Resilience.** A failed agent whose error looks transient (rate limit, overload,
network) is re-run by its runner with exponential backoff (`attempt` counts the
retries); non-transient failures are left failed with the reason recorded for the
dashboard. The agent's live `activity` (its latest tool call) is stamped as events
stream, so `tack dashboard` shows what each running agent is doing now.

`tack agent <project> "<task>"` runs a single agent inline (no supervisor) — the
quickest way to validate the runtime pipeline.

---

## 10. Config shape

```ts
export default ({
  projects: [{ name, path, description, metadata: { language, frameworks: [] } }],
  models: [
    { name: "opus", runtime: "claude", id: "opus", effort: "high" },
    { name: "gpt-5-codex", runtime: "codex", id: "gpt-5-codex",
      pricing: { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.125 } },
  ],
  roles: { supervisor: "opus", agent: ["gpt-5-codex", "opus"], summary: "sonnet" },
  runtimes: { claude: { version: "2.1.261" } },
  readAllowlist: [],
  supervisorMcpServers: [{ name, command, args: [], env: {} }],
  prWatch: { enabled: true, intervalSeconds: 300, autoReady: true, autoPush: true, reply: true, fixCi: true, maxFixRunsPerDay: 5 },
  autoOpenPrs: true,
  draftPrs: true,
  jira: { mcpServer: "Atlassian", siteUrl: "https://chime.atlassian.net", cloudId? },
});
```

`autoOpenPrs` (default `true`) lets the supervisor commit and open the session's
PRs without asking once the work is done — its prompts frame the setting as the
human's explicit authorization to commit, push, and open PRs, so user-level "don't
commit unless asked" rules count as satisfied; `false` restores the ask-first flow
with a per-call `open_pr` confirmation (§9).

`supervisorMcpServers` mounts extra MCP servers for the **supervisor only**, on top
of its `tack-supervisor` tools. Runs are `--strict-mcp-config`, so the supervisor
otherwise inherits none of the user's global/plugin MCP config — this is the opt-in
seam for giving it read access to an external source it must plan over (e.g. a
JIRA/Atlassian server so it can open a ticket named in the problem). A mounted
server's tools are auto-allowed under the read-only posture, so only servers the
user accepts (writes included) should be listed; agents do not receive them.

**Auth is inherited, not passed.** Tack spawns the runtime with the full parent
environment (`{ ...process.env, ...env }`), and the runtime spawns each MCP server
inheriting that in turn — so a mounted server sees the same `$HOME`/`$PATH` as the
user's own shell, and Tack never handles a token. Servers that cache their own
credentials in a user-global file therefore authenticate identically no matter who
launches them. This is how the Atlassian example works: the `chime-atlassian-mcp`
stdio proxy keeps OAuth tokens at `~/.cache/chime-atlassian-mcp/atlassian-mcp-tokens.json`
and auto-refreshes them, so the supervisor rides the *same* cache as the user's
normal Claude session. First-run OAuth uses an MCP elicitation prompt, which needs an
interactive client to answer — so the cache is seeded once (via the plugin or an
interactive `tack` supervisor), after which headless runs reuse the refresh token.

`jira` (optional) turns on **session ticket tracking — track only**: Tack never
creates, edits, or transitions a ticket. The supervisor links the keys a session
works on (`link_jira_ticket`, local state in `session_jira_tickets`), and Tack
refreshes their title/status by acting as an MCP *client* of the
`supervisorMcpServers` entry named by `mcpServer` — spawned with the same inherited
environment as above, so it rides that server's cached auth and handles no tokens.
`siteUrl` builds browse links (`<siteUrl>/browse/<KEY>`); `cloudId` falls back to
the server's `env.CONFLUENCE_CLOUD_ID`, then to `getAccessibleAtlassianResources`.
Refresh is best-effort: an unconfigured, unreachable, or not-yet-authenticated
server just leaves statuses stale (the dashboard says "jira unavailable"). Loading
fails if `mcpServer` doesn't name a configured server.

Every functional role (supervisor / agent / summary) accepts a model key or a
non-empty list, e.g. `agent: ["gpt-5-codex", "opus"]`. Loading normalizes each role
to distinct keys in config order and fails if any key is undefined. One key always
uses that model; several mean a uniform random pick whenever the role is resolved.
The supervisor pick is persisted at session creation and reused on resume; an
agent's pick is persisted at spawn. Summary calls pick each time.
`tack roles set <role> <model> [model...]` accepts space- or comma-separated keys;
listing shows multiple candidates with a `(random)` hint. Model sync replaces each
stale candidate independently and de-duplicates the result, keeping and warning
about any stale key with no replacement. Besides describing
projects, the summary model auto-generates session titles (from the first shared
contract, or the seed prompt) into `sessions.title`, best-effort and in the background.

---

## 11. Dashboard, PRs, lifecycle

- **`tack dashboard`** — an Ink dashboard: live Session → Agent → PR tree, pid-based
  liveness and a change-driven refresh loop. Live supervisors mid-turn show a cyan
  spinner and `working <elapsed>` badge, with a working count beside live in the
  header. Pending plan prompts show needs-input instead. The spinner ticks only
  while a session is working. Session keys: `j/k enter/o v m O p J c x a d z q`.
  At ≥140 columns it defaults to a 55% session list / 45% **Insights** split.
  `s` cycles split → list-only → full-screen Insights; narrow terminals start with
  the list and retain access to full-screen Insights. `[` / `]` select
  7d / 30d / 90d / 1y / all (default 30d). Resizes update the layout.
  Insights aggregates **all** sessions, including archived ones, into local calendar
  day/week/month buckets: sessions, agents (including PR-fix agents), PRs opened
  and merged, tickets linked and done, supervisor + agent tokens and cost, per-repo totals,
  absolute deltas vs. the previous equal-length period, and daily contributions.
  PR opening uses the link's `created_at`; merge uses GitHub's `mergedAt`, persisted
  as `session_prs.merged_at` (legacy merged rows fall back to `updated_at`). Ticket
  completion uses `updated_at` for current `done` rows as an approximation. Costs
  use creation dates; repo costs include agent spend only, sorted by agent count.
  Ranges include today through now; comparison uses the same local dates/time in
  the preceding period. A model table in split/full views shows sessions by
  `supervisor_model`, agents by `model` (including PR-fix), and their combined
  tokens and cost; NULL handles use "unknown". Tokens sum input, output, cache
  reads and cache writes, attributed to creation dates like cost, and excluded
  from contributions. Session token columns default to zero without backfill.
  Headless supervisor usage overwrites with the latest runtime figure, matching
  cost even on resume; interactive transcript recovery overwrites both with
  cumulative figures. Model rows sort by cost, tokens, agents, sessions, then name.
  Tables size to remaining rows or drop whole; narrow model tables stack fields.
  Full-screen Insights uses two columns with a repo table.
  Time series use block heights (▁▂▃▄▅▆▇█, · for zero), with shared scales for
  paired rows, full-word labels, totals and peaks when space allows, and dated
  axes with bucket units. Short series stretch by whole columns per bucket.
  Heatmap shades (░▒▓█) have weekday/date labels and a separate legend with the
  maximum per day; blanks mean out of range. Aligned KPIs show signed changes
  vs the previous period, preserving meaning without color. A grouped read every
  5s catches archived changes too; identical stats never trigger a repaint.
- **PRs** — `gh pr list` per touched repo, filtered to `tack/pr/<sessionId>/…`
  branches, upserted into `session_prs`. `O` opens the selected session's PRs.
- **JIRA tickets** — linked by the supervisor (`link_jira_ticket`/`unlink_jira_ticket`),
  stored in `session_jira_tickets`, and shown under the session's PRs (collapsed
  roll-up + per-ticket rows colored by status category) in `tack dashboard` and in
  `tack session show`. The dashboard refreshes status every 2 minutes via one long-lived
  Atlassian MCP client (`src/projects/jira.ts`); `P` polls now, sharing the
  background tick's in-flight guard so the two never overlap. `J` opens the session's
  tickets; `t` lists every ticket linked to any existing session, archived included
  and regardless of `z` (one `listAllSessionJiraTickets` join, read on the 1s tick only
  while the view is open). Open work comes first, newest link first within each status,
  one row per session, with the session's state; `f` (status), `a` (archived) and `/`
  (text) filter it, `g` jumps to the session (turning `z` on for an archived one) and
  `P` polls the filtered entries' sessions. Done is green, so it reads apart from
  merged-PR magenta.
  Track-only — never writes to Jira.
- **Lifecycle** — nested under `tack session`: `stop` (SIGTERM the session +
  agents + PR watcher), `archive`/`unarchive`, `delete` (kill pids, purge worktrees
  + artifacts, cascade DB rows). Archive stamps `agents.interrupted_at` only on
  running/pending agents before stopping them, then hides the session. Plain stop
  never stamps. Unarchive restores active status, clears each interruption stamp,
  and relaunches exactly those agents as pending (including dependency gating).
  A failed relaunch records the agent's error and continues restoring the rest.
  Restored agents with `resume_ref` continue the runtime conversation with a short
  continuation prompt: Claude uses `--resume`, Codex uses `exec … resume`.
  Without a handle they run the original prompt in the same worktree. Normal
  first runs stay fresh; continuation retries keep resuming the active conversation. Unarchive does not launch the
  supervisor: rejoin via `tack session resume <id>` or dashboard `enter/o`.
  Dashboard `a` archives immediately, confirms unarchive with the interrupted
  count, and reports the resumed count; `z` reveals archived sessions.

### Pre-PR agent continuation

`continue_agent({ agentId, prompt, model? })` is plan-gated like `spawn_agent`.
Prefer it for follow-ups or reconciliation on a unit an agent already owns; use
`spawn_agent` for new units. It reuses the same row, conversation and worktree.
Only done/failed agents in this session qualify; pending/running/stopped agents,
PR-fix rows, agents with an open/draft session PR (use `fix_pr`), missing resume
refs or worktrees, and cross-runtime model switches are refused. Same-runtime
model switches are allowed. Each next-turn prompt has its own artifact; the
original assignment remains intact. Output reflects the latest invocation,
the diff stays cumulative, and cost/usage accumulate with streaming updates
replacing only the current invocation's contribution. The active prompt persists
across interruption, unarchive and transient retry.

### Refresh onto updated Tack code or config

`session refresh <id>` gracefully exits a stale supervisor TUI (bounded `/exit`,
then tmux kill), recovers its cost, restarts a stale PR watcher if watchable PRs
remain, and resumes the same conversation. Agents are never stopped. `--all`
targets stale active sessions and parks replacement supervisors detached in tmux;
without tmux, supervisors stay stopped until the next resume. `--force` bypasses
the plan-approval, turn-marker, and live headless-runner guards. Dashboard `r`
asks y/N and hands off to resume; stale sessions show a `stale` badge.

Interactive `session resume` automatically refreshes stale idle processes before
reattaching. A blocked supervisor stays live with a notice to refresh once idle;
a stale watcher can still be refreshed independently. Refreshed supervisors get
a seed telling them tools/permissions may have changed and to re-run `sync_projects`.

`session reconnect <id>` (dashboard `w`) recovers from sleep or a network drop: it
always stops the supervisor (no mid-turn or pending-plan guard), revives agents
the outage killed, restarts a dead PR watcher, and relaunches the supervisor parked
in tmux with a reconnect seed. It never opens a foreground TUI, so the CLI returns
and the dashboard stays open; `session resume` attaches. Without tmux the
supervisor stays stopped until resume. `--all` parks only supervisors that were
running.

Code versions are memoized per process: content hashes of the entry script's Tack
source tree (`bin`/`src` TypeScript, package manifest and lockfile), including
uncommitted edits, or executable size/mtime for compiled Tack. Missing stamps on
live legacy processes count as stale; `unknown` versions never do. Watchers stamp
their own code and config versions at startup. Config versions are SHA-256 hashes
of `CONFIG_PATH` contents, read fresh on every check. A live component is stale when
either code or config differs; missing/unreadable config returns `unknown`.
Dashboard `C` opens config in `$VISUAL` / `$EDITOR` (fallback `vim`, else `vi`) in every layout,
even with no sessions. Unchanged config shows a notice; invalid edits retain the
previous config without refreshing sessions. Valid changes reload dashboard config
and use the same bulk refresh as `session refresh --all`, reporting refreshed,
blocked, and failed counts. Claude's prompt-submit hook stamps the best-effort
turn marker; Stop and Notification (`idle_prompt`) hooks clear it. The idle
notification covers Esc interruptions, which do not fire Stop. On Stop, `__turn-end` also
reads the hook's stdin on a best-effort basis. It takes the final assistant message
from `last_assistant_message`, falling back to the last assistant text in the JSONL
`transcript_path`. If that message ends in a question (`endsWithQuestion`, in
`src/cli/question.ts`), it marks the session awaiting input with reason `"question"`.
The detector ignores trailing fenced code, emphasis, closing quotes and brackets.
`idle_prompt` never touches the awaiting flag. Empty or invalid input only clears
the turn marker. Adapters without
these hooks leave it null. A live headless runner is always treated as busy.

### Worktree editing and manual workspaces

`tack session edit <session> [agent]` (`src/session/edit.ts`) opens an existing
worktree in `$VISUAL` / `$EDITOR` (fallback `vim`, else `vi`), rooted at the tree;
afterwards it prints the branch, Git status and, for an open PR, a push hint. It
observes only — never commits or pushes. Dashboard `v` → `e` prints the summary and opens a shell in the worktree; exit returns to the dashboard. Set `dashboard.shellAfterEdit: false` to skip the shell.

`--new [project]` (dashboard: `v` → `n`) creates a **manual workspace**
(`src/session/manual.ts`): a clean `tack/<session>/<id>` worktree from
`createWorktree` (fresh remote default branch, fork point pinned) recorded as an
`agents` row with `kind = 'manual'`, `status = 'done'`, no runtime/model/pid/
resume_ref/refs and zero cost. `finished_at` stays NULL so it never reads as unread
agent work. Omitted projects resolve only when unambiguous (one configured project,
or one project among the session's agents); the dashboard otherwise shows a chooser
with the session's projects first. When open session PRs exist, the chooser also offers each PR; `--new --pr <number>` selects one from the CLI. A linked workspace checks out the PR head on a same-named local branch tracking origin, and reuses an existing live workspace. A stale branch with unpushed commits is preserved and refused. The summary shows its PR, ahead/behind counts, push hint, and any in-flight fix warning. Humans commit and push these branches with git; `open_pr` refuses linked rows.

A manual row is the human's work, never a conversation: `runAgent`,
`runAgentToCompletion`, `spawnAgentRunner`, archive/unarchive, `continue_agent` and
`review_agent` all refuse or skip it. Everywhere else it is a worker:
`check_conflicts` includes it (uncached, since hand edits don't touch the row, and
counting untracked files), `read_agent_output` reads its diff live, `open_pr`
commits leftover edits then captures the diff before pushing, and `fix_pr` on its
PR falls back to a fresh `pr_fix` (no lineage to continue).

### PR watch

Once a session has open PRs, a detached watcher (`tack __watch-prs <session>`,
`src/prwatch/watch.ts`, pid in `sessions.pr_watch_pid`, log at
`logs/<ses>/pr-watch.log`) polls them every `prWatch.intervalSeconds`. `open_pr`
starts it; the dashboard refreshes PR status on mount and every
`prWatch.intervalSeconds`, restarting it for any active session with an open PR
and a dead watcher. It exits when the session is archived/gone or no PR is
open; `stop`/`archive` SIGTERM it.

Out-of-cycle polling is available through `tack session poll-prs <session>`, dashboard
`p`, or supervisor `check_prs` with `refresh: true` (read-only by default). These
refresh each watchable PR's status first, persisting merged/closed states immediately.
Only if any PRs remain open do they send SIGUSR1 to a live watcher or start a missing
one; feedback handling happens asynchronously. Per-PR refresh failures retain the
stored status and do not prevent other PRs from refreshing. SIGUSR1 interrupts its
sleep; requests during a pass coalesce into one immediate extra pass. Passes never overlap and all normal fix guards still apply.

The per-session auto-fix toggle defaults on. `tack session pr-fix <session> [on|off]`,
dashboard `F`, `/pr-fix [on|off]`, and the supervisor tool `set_pr_fix` expose it.
When off, the watcher continues polling, completing existing fixes and promoting
ready drafts, but does not record new feedback or spawn automatic fixes. Turning it
on wakes the watcher. Explicit `fix_pr` remains available.

Each pass, per PR: `gh pr view` → persist state/mergeable/base/head; skip merged or
closed; wait if a `pr_fix` agent is in flight; finish (post-fix) any fix agent that
completed; otherwise gather **new** feedback — unresolved review-thread comments,
non-empty review bodies, conversation comments, bots included, minus anything
already in `pr_feedback` or carrying the `<!-- tack:pr-watch -->` marker — and,
if there is any or `mergeable == CONFLICTING` (UNKNOWN = retry next tick), spawn a
fix run with origin `auto`, subject to `maxFixRunsPerDay` per PR per rolling
24h. The cap counts `pr_fix_runs`, not agent rows, so reusing one fix agent spends
budget on every run (failed automatic runs and legacy NULL-origin runs count;
supervisor `fix_pr` runs are exempt and do not count). The `open_pr` base-conflict hand-off also uses
origin `auto` and enforces this cap.

PRs opened through `open_pr` default to drafts: `draftPrs` (default true) forces
`--draft` even when its `draft` argument is false. With `draftPrs: false`, the
argument is honored. The tool persists the resulting state as draft or open.

With `prWatch.enabled` and `prWatch.autoReady` (both default true), the watcher
runs a readiness gate after gathering feedback and before spawning fixes. It calls
`gh pr ready` only for a draft with mergeability exactly MERGEABLE, no active or
awaiting-post-fix agent, no fresh/released feedback, and no stored pending/failed
decisions. Every non-CI feedback row must be handled with decision fixed, declined
or not_applicable and a `reply_ref`; silently declined unreported items do not
qualify. Current-head checks must all be settled and none failing/cancelled; zero
checks is green. Draft checks are fetched even with `fixCi: false`, sharing one
fetch with failure ingestion; fetch errors block readiness. A clean PR qualifies
without any prior fix run. On success the watcher latches
`session_prs.ready_promoted_at`, persists state open and logs it. The latch is never
cleared, so a human returning the PR to draft is respected. Promotion failures are
logged and retried next tick. Disable `autoReady` for manual promotion.

With `prWatch.fixCi` (default true), also fetch checks on the current PR head
using `gh pr checks --json` (GraphQL `statusCheckRollup` for older gh). Wait until
no check is pending before ingesting any failures; reviews and conflicts still
proceed while CI is pending. Failed, cancelled, timed-out and startup-failure checks
become `ci_check` feedback with source ids `ci:<headSha>:<workflow/name>`. The SHA
makes failures on a new head new items; unchanged heads never loop. Fetching checks
is best-effort and cannot block review/conflict handling. GitHub Actions failed-job
logs are collected by the watcher with `gh run view --job --log-failed`, capped at
the last 200 lines / 20KB, and stored in the feedback artifact, never in the DB.

Conversation comments and reviews come from paginated GraphQL connections with
`author { login __typename }`, retaining their existing node ids. Bot detection also
uses a case-insensitive known-login fallback, stripping any `[bot]` suffix.

The **fix agent** lineage (`spawnPrFixAgent`) prefers, in order:

1. **Reuse** — requeue the PR's latest `pr_fix` row in place, so the dashboard and
   `check_prs` show one fix agent per PR. Like `prepareContinuation`, it writes a
   new `continuation_prompt_ref` holding the fix prompt and sets the row pending
   (`continuation_started_at`, `finished_at`, `error` cleared; `model` set), clears
   the per-run `post_fixed_at` / `fix_outcome` / `fix_pushed_sha`, sets `fix_origin`
   to this run's origin and `diff_base` to the fast-forwarded PR head (so the run's
   diff and post-fix "anything new?" check cover only this run), and assigns the new
   feedback to the same id. The runner resumes the row's own `resume_ref` in its own
   worktree; cost and tokens accumulate on the row; the transcript gets a `resumed`
   marker per run.
2. **Continue** — a new `pr_fix` row forking the lineage head: the newest PR-fix run
   with a successful (non-failed/stopped/rejected) post-fix outcome, falling back to
   the PR owner. It stores `continues_agent_id`, reuses that head's cwd/branch and
   resume ref, and captures its diff against its own starting commit.
3. **Fresh** — a new row forked off the PR's current remote head (`createPrWorktree`).

Reuse and continuation share one eligibility check: `agentReuse.enabled` (default
true), no `fix_pr({ fresh: true })` override, a done row with a resume ref on the
chosen model's runtime, finished within `agentReuse.maxIdleHours` (default 24), and
an existing clean worktree that fetches and fast-forwards to `origin/<head_branch>`.
Reuse additionally needs the latest row to be post-fixed with an outcome other than
failed/stopped/push_rejected. The result carries `lineage` (`reused` | `continued` |
`fresh`), `continued` (the conversation's agent id — the reused row itself — or
null), `fallbackReason` (why fresh) and `reuseFallbackReason` (why the previous row
wasn't reused); the watcher logs `reused <id>` / `continued <id> in new row <id>` /
`fresh: <reason>`.

The PR's busy slot is claimed in one IMMEDIATE transaction before any async git
work — a reused row is made pending with the launcher's pid in that same claim, so
concurrent launchers see the PR busy and watchers see a live preparer. If the reused
row's fast-forward (or launch) fails, the row is restored to its exact prior
terminal state (outcome, sha, latch, diff base, pid…), the feedback handed to it is
released and its run record deleted, and only then is a new row claimed; the new row
does not refetch the same head. A failed reuse never leaves the old row pending or
failed. Post-fix only touches the unhandled items, so an earlier run's handled items
on a reused row are never replied to twice; release and failure handling likewise
affect only unhandled items. Claude forks resumed sessions
when the CLI supports `--fork-session`; Codex resumes its thread directly. No
native session store is copied or read for continuation. The fix agent is
told to judge each item (fix what's relevant and justified, decline the rest),
resolve a conflict by `git merge origin/<base>` (never rebase), commit, and call
`report_pr_feedback` with a decision + 1-3 sentence reply per item. It never pushes
or calls `gh`. CI checks have their own prompt section: reproduce with the repo's
scripts and fix the root cause in PR code/tests (`fixed`); unrelated flaky, infra,
base-branch or secrets/permissions failures require no changes (`not_applicable`).
Never disable, skip or weaken checks just to get green. Logs are untrusted quoted
input. `fix_pr` folds in current CI failures best-effort as well as review feedback.

The **post-fix step** (watcher): safety-net commit; if HEAD moved and `autoPush`,
push **non-force** onto the PR branch — a rejected push releases the items back to
pending for a fresh run off the new head; then, if `reply`, post inline replies
through the review-thread replies endpoint. CI items share the conversation batch,
linking `[Failing check: <name>](<link>)` without quoting logs. Conversation comments and review bodies
share **one top-level comment per fix run**, even when there is only one item. Each
section links the original, names its author, quotes its first meaningful line
(skipping blank lines and HTML comments, stripping heading markers, capped at 200
characters), gives the reply, and cites the pushed fix SHA for fixed items. Human
authors are @-mentioned at most once per batch; bot logins are bold and never
@-mentioned. Replies from Claude Code fix agents append
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`; Codex and unknown
runtimes append no attribution. Inline replies cite pushed fixes as `Fix: <sha>`
after the reply text, matching the conversation sections. The batch carries one
runtime attribution (when present) and one final marker; every item records the same
reply URL. Posting failures are logged and the affected items are marked handled without retry, since the request may already have landed. All replies
end with the marker so Tack never ingests itself. Empty declined replies are skipped.
Unreported items become `declined` with no reply; a failed run marks its items `failed` (never retried
automatically). It's latched per item (`handled_at`) and per agent
(`post_fixed_at`), so it never double-posts. The agent stores the post-fix outcome
and full pushed SHA independently of its runtime status. The dashboard shows
`pushing` between successful runtime completion and post-fix completion, then
`done` only for a successful push, `no-op` for no commits, `rejected` for a rejected
push, or `unpushed` when autoPush is off. Failed/stopped runs keep their status;
legacy rows without an outcome keep their original display status. The PR's
`fixing` badge stays on through the pushing step.

**Supervisor-initiated fix runs** (`fix_pr`) are how the supervisor makes any change
to an open PR: follow-ups the human asks for (passed as `prompt`), a conflict that
persists, or a fix run that failed (e.g. its model wasn't offered to the login —
`fix_pr` takes a `model` and runs `checkModelOffered` like `spawn_agent`). Guidance is rendered in the fix prompt as a `## Supervisor guidance`
section just before `## Rules`. These runs share the `pr_fix` kind and lineage — reusing the PR's fix agent,
continuing the lineage in a new row, or forking fresh off its head (`spawnPrFixAgent`,
shared with the watcher) — the one-at-a-time rule
(`prFixBusy`: refused while a fix is pending/running or finished but not yet
post-fixed), and the same watcher post-fix push + replies — `fix_pr` polls the PR
live, folds in any not-yet-ingested feedback, spawns the agent, and (re)starts the
watcher. These runs have origin `supervisor`: they are exempt from the watcher's
`maxFixRunsPerDay` cap and do not count toward it. Commits push onto the same PR
branch. `spawn_agent` + `open_pr` would instead create a second PR, so the
supervisor never uses them to change an existing one.

---

## 12. Known risks & future work

- **Codex event parsing** targets codex-cli 0.163's `exec --json` schema
  (`thread.started{thread_id}`, `item.started|completed{item:{type:"agent_message"|
  "command_execution"|"file_change"|"mcp_tool_call"|…}}`, `turn.completed{usage}`,
  `turn.failed{error}`, `error{message}`) and still accepts the older `msg`-wrapped /
  PascalCase / `total_token_usage` shapes; re-verify when you bump codex. Not every
  `error` is fatal: `error{"Reconnecting... n/5"}` is a transient retry and
  `item{type:"error"}` is a warning (e.g. an ignored config key). A run fails on
  `turn.failed`, any other `error`, or a non-zero exit, whose error reads
  `codex exited with code N: <reason>` — codex's in-stream fatal (API JSON
  unwrapped) if it gave one, else the stderr tail (`streamJson` keeps ~2KB of it).
  Codex's `input_tokens` includes cached tokens, so the cached share is moved to
  `cacheRead` rather than billed twice.
- **Codex approval posture.** `exec` forces `approval_policy=never`, which managed
  (MDM) devices can forbid ("`Never` is not in the allowed set [UnlessTrusted,
  OnRequest]"). Without a usable policy, every command and edit is rejected. Write
  runs use `--approve-for-me` (workspace-write sandbox plus Codex's automatic
  approval reviewer). Read-only runs use `-s read-only -c approval_policy="on-request"
  -c approvals_reviewer="auto_review"` (`on-request` alone is still forced to
  `never`). Never `--dangerously-bypass-approvals-and-sandbox`. `exec resume` rejects
  `--approve-for-me`/`-s`/`--add-dir`, so those flags precede the `resume` subcommand.
- **Codex context injection** is a `developer_instructions` directive to read the
  context file, so it relies on the agent actually reading it. The file-based
  alternative (`model_instructions_file`, née `experimental_instructions_file` —
  ignored as of codex 0.16x) replaces codex's whole base prompt, so don't switch
  back to it.
- **Bedrock** becomes a third runtime once approved (open-weight models); the
  model→runtime abstraction already anticipates it.
- The automated suite (`bun test`) covers pure logic only. The runner retries a failed *run* whose error looks
  transient (§9 Resilience), but a hard-*killed* agent process (SIGKILL, OOM) is
  still only marked dead via liveness, not auto-respawned. Retry re-runs in the
  worktree with a fresh runtime session, so it loses prior conversation context;
  resume-on-retry is future work.
- Overlap detection compares declared `touches` by exact/directory-prefix match, not
  full globs. Amendments are adjudicated by the supervisor (the system routes them to
  it via `wait_for_agents`); `tack dashboard` surfaces them read-only.
- Pricing can be synced from models.dev (folded into `tack models sync`) instead of
  hand-maintained; it's the one network call Tack makes and only on demand.
- The interactive `claude attach` escape hatch is unimplemented.

## 13. Personas

`personas` in `config.ts` defines optional reviewer lenses (`name`, `description`,
optional `model` key or non-empty list). Names are unique. Description gives the
reviewer instructions; omitted models use `roles.agent`. Reviews prefer a model
different from the author's when available; an explicit model overrides the choice.

Persona reviews start only when the human explicitly requests them, using
`tack session review`, dashboard session list `R`, `/review <persona>
[focus…]`, or the supervisor's `review_agent` tool. The supervisor reads finished
reviews, raises blocker/major findings to the human, and notes verdicts in PR bodies.
Opening a PR does not require a review.

Human-initiated reviews create one agent per open session PR, checking out the remote
head and pinning its merge base with the remote base branch. `review_agent` instead
reviews the author's local branch with its original baseline. In either case,
`git diff <base>` shows the work under review. Resume/retry reuses the worktree.
Reviewers may inspect, test and experiment, but never commit or open PRs. They call
`report_review` exactly once with a verdict (`approve`, `changes_requested`, or
`comment`), summary and findings (severity, optional file/line, title and detail).
The JSON artifact is referenced by `agents.review_ref`; `persona` and
`reviews_agent_id` identify its lens and author. Normal output remains `output_ref`.
Reviews can be continued for questions, are excluded from file collision checks,
and appear as `review:<persona>` with their reported verdict in the dashboard.

### Release-gated PR dependencies

A downstream PR can declare upstream session PRs with `awaitsRelease`. Tack infers a shared ecosystem and package from the worktrees, waits for each upstream merge and a containing stable GitHub release or tag, and queues a dependency-release feedback item for a PR fix. The fix uses the exact tagged version and the repository’s package tooling. Dependency fixes honor the session auto-fix switch and one-fix-at-a-time guard but are exempt from the automatic daily cap. Unresolved dependencies keep the watcher alive and block draft promotion; closed upstream PRs, a 24-hour release timeout, and failed fixes are recorded for inspection.

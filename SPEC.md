# Tack — Specification & Design

Tack is a **runtime-neutral supervisor** that sits on top of coding-agent CLIs —
Claude Code (`claude`) and the Codex CLI (`codex`) — and coordinates parallel work
across projects. It plans, delegates to agents running in isolated git worktrees,
shares context between them, tracks cost and PRs, and gives you one stable view of
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
- **Per-session cost tracking**, a **stable view** of live work, **PR tracking**,
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
the coordination tools it needs: `list_projects`, `set_shared_context`,
`spawn_agent` (with `touches`/`dependsOn`), `check_agents`, `wait_for_agents` (blocks
server-side so the planner doesn't burn tokens polling, and returns early with any
`pendingAmendments` so the system routes an agent's proposal back to the supervisor
to adjudicate), `check_conflicts`, `read_agent_output`, `list_amendments`,
`resolve_amendment`. Amendment resolution is therefore orchestrated by the system,
not by the human — `tack stable` only surfaces pending amendments read-only.

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

**Transparent installs** (`src/runtimes/install.ts`). `tack init` and `tack install`
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
         status[active|archived], cost, pid, heartbeat_at, created_at, updated_at)

agents(id, session_id→sessions, project_name, worktree_path, branch,
       status[pending|running|done|failed|stopped], model, runtime, resume_ref,
       cost, cost_source[runtime|pricing], tokens_input, tokens_output,
       cache_read, cache_write, pid, prompt_ref, output_ref, diff_ref,
       created_at, updated_at)

shared_context(session_id→sessions, version, body_ref, authored_by, created_at,
               PK(session_id, version))

amendments(id, session_id→sessions, proposed_by→agents, proposal_ref,
           status[pending|accepted|rejected], resolution_ref, created_at, resolved_at)

session_prs(id, session_id→sessions, agent_id, project_name, number, url, title,
            state, head_branch, created_at, updated_at, UNIQUE(session_id, url))

session_jira_tickets(id, session_id→sessions, agent_id, key, url, title, status,
                     status_category[new|indeterminate|done], created_at,
                     updated_at, UNIQUE(session_id, key))
```

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
  the final `result` event's `total_cost_usd`. The **interactive** supervisor also
  auto-allows the mounted MCP servers (`--allowedTools mcp__<server>`) and wires a
  `--settings` PostToolUse hook on `ExitPlanMode` — accepting the plan runs `tack
  __approve-plan <id>`, which opens the session's `spawn_agent` gate (see §9).
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
   runtime read-only, with project roots granted as read dirs and the supervisor MCP
   server mounted. By default this is the runtime's own **interactive** TUI (Claude
   Code / Codex) with inherited stdio — same capability posture (plan mode, no edit
   tools, only the `tack-supervisor` MCP tools), so you chat with the supervisor
   directly and follow up with `--resume` in the same live session. Since the TUI
   owns the terminal there is no event stream to persist; cost is recovered from the
   runtime's transcript once it exits (claude sums per-message `usage` × pricing;
   codex reads its rollout's cumulative token count). `--background` keeps the
   headless, detached, streamed runner for unattended runs.
2. The supervisor investigates, calls `set_shared_context`, presents its plan, and
   gets the human's approval before any agent runs. `spawn_agent` is **plan-gated**:
   it refuses until the session's `plan_approved_at` is set. An attended claude
   session flips that gate when the human accepts the plan (the `ExitPlanMode` hook →
   `tack __approve-plan`); background runs (no human) and codex interactive sessions
   (which keep native per-tool approvals) are pre-approved up front. Once approved,
   each `spawn_agent` `prepareAgent`s (creates the row + prompt artifact) and launches
   a **detached** `tack __run-agent <agentId>` runner.
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
   each PR, not permission to open it. With `autoOpenPrs: false` it asks first, and
   an attended claude session also forces a per-call confirmation on `open_pr`.
5. The `tack stable` dashboard discovers PRs via `gh`.

**Coordinating parallel work (the correctness layer).** The supervisor defaults to
**one agent per affected project** (so one PR per repo), splitting a project only
into genuinely independent units that each merit their own PR. Every worktree
forks from the project's HEAD — not from a sibling's branch — so ordered work within
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
stream, so `tack stable` shows what each running agent is doing now.

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
  roles: { supervisor: "opus", agent: "gpt-5-codex", summary: "sonnet" },
  runtimes: { claude: { version: "2.1.261" } },
  readAllowlist: [],
  supervisorMcpServers: [{ name, command, args: [], env: {} }],
  autoOpenPrs: true,
  jira: { mcpServer: "Atlassian", siteUrl: "https://chime.atlassian.net", cloudId? },
});
```

`autoOpenPrs` (default `true`) lets the supervisor commit and open the session's
PRs without asking once the work is done; `false` restores the ask-first flow with
a per-call `open_pr` confirmation (§9).

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

Every functional role (supervisor / agent / summary) is **pinned to a model by
name**; loading fails loudly if a role names an undefined model.

---

## 11. Stable view, PRs, lifecycle

- **`tack stable`** — an Ink dashboard: live Session → Agent → PR tree, pid-based
  liveness, refresh loop, keys `j/k x a d p z q`.
- **PRs** — `gh pr list` per touched repo, filtered to `tack/pr/<sessionId>/…`
  branches, upserted into `session_prs`. `O` opens the selected session's PRs.
- **JIRA tickets** — linked by the supervisor (`link_jira_ticket`/`unlink_jira_ticket`),
  stored in `session_jira_tickets`, and shown under the session's PRs (collapsed
  roll-up + per-ticket rows colored by status category) in `tack stable` and in
  `tack session show`. The dashboard refreshes status every 2 minutes via one long-lived
  Atlassian MCP client (`src/projects/jira.ts`); `J` opens the session's tickets.
  Track-only — never writes to Jira.
- **Lifecycle** — nested under `tack session`: `stop` (SIGTERM the session +
  agents), `archive`/`unarchive`, `delete` (kill pids, purge worktrees + artifacts,
  cascade DB rows).

---

## 12. Known risks & future work

- **Codex event parsing** is defensive against an internal build's `--json` schema;
  re-verify against the Codex version you pin.
- **Codex context injection** is a `developer_instructions` directive to read the
  context file, so it relies on the agent actually reading it. The file-based
  alternative (`model_instructions_file`, née `experimental_instructions_file` —
  ignored as of codex 0.16x) replaces codex's whole base prompt, so don't switch
  back to it.
- **Bedrock** becomes a third runtime once approved (open-weight models); the
  model→runtime abstraction already anticipates it.
- No automated test suite yet. The runner retries a failed *run* whose error looks
  transient (§9 Resilience), but a hard-*killed* agent process (SIGKILL, OOM) is
  still only marked dead via liveness, not auto-respawned. Retry re-runs in the
  worktree with a fresh runtime session, so it loses prior conversation context;
  resume-on-retry is future work.
- Overlap detection compares declared `touches` by exact/directory-prefix match, not
  full globs. Amendments are adjudicated by the supervisor (the system routes them to
  it via `wait_for_agents`); `tack stable` surfaces them read-only.
- Pricing can be synced from models.dev (folded into `tack models sync`) instead of
  hand-maintained; it's the one network call Tack makes and only on demand.
- The interactive `claude attach` escape hatch is unimplemented.

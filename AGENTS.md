# Contributing to Tack

Guidance for anyone — human or agent — working on **Tack itself**. For the full
architecture, design decisions, and rationale, read **[SPEC.md](./SPEC.md)**; this
file is the day-to-day contributor guide and points there for anything deeper.

## What Tack is (one line)

A runtime-neutral supervisor that drives Claude Code (`claude`) and the Codex CLI
(`codex`) as interchangeable "runtimes" to plan and coordinate parallel coding work
in isolated git worktrees. See SPEC.md §1–§3 for the model (Supervisor + Agents).

## Stack & setup

- **Bun + TypeScript.** React + Ink for the dashboard. `@modelcontextprotocol/sdk`
  for the MCP servers. `citty` for the CLI, `zod` for config, `picocolors` for
  output. No build step — Bun runs `.ts`/`.tsx` directly.

```bash
bun install
bun run typecheck        # tsc --noEmit — keep this green
bun run ./bin/tack.ts --help
TACK_HOME=$(mktemp -d)/tack bun run ./bin/tack.ts init   # scratch home for testing
```

Always run against a throwaway `TACK_HOME` when testing so you don't touch a real
`~/.tack`. Tack uses distinct filenames (`config.ts`, `state.db`) so it can share
the `~/.tack` root with another CLI without collision — don't reintroduce
collisions (SPEC §7).

## Repo layout

```
bin/tack.ts              CLI entry (citty) + hidden __mcp / __supervisor-mcp / __run-agent
src/config/              schema, load, starter template
src/boot/                session worktree boot recipes, execution, and locks
src/db/                  connection, migrate (schema), repositories, index
src/runtimes/            types (Runtime/AgentEvent), claude.ts, codex.ts, proc.ts, pricing.ts, pricing-sync.ts (models.dev), resolve.ts, install.ts
src/mcp/                 coordination-server.ts (agents), supervisor-server.ts (supervisor: spawn/continue/touches/dependsOn, check_conflicts)
src/agent/               execute.ts (prepare/run + activity/error), continue.ts (pre-PR continuation), detached.ts (background runner, dependency self-gate + retry)
src/supervisor/          supervise.ts (runner), context.ts (system context), conflicts.ts (overlap/collision detection), write-guard.ts (publishable-page write scope)
src/context/build.ts     per-agent context file
src/worktree/            session-scoped worktrees, background base cache, supervisor snapshots (syncSnapshot) + PR branch nomenclature
src/projects/            prs.ts (gh-based PR discovery + PR-watch fetch/normalize/reply), jira.ts (track-only ticket status via the Atlassian MCP), summarize.ts (auto-describe a repo)
src/prwatch/             watch.ts (per-session PR watcher: poll, spawn pr_fix agents, push + reply, promote drafts), prompt.ts
src/session/lifecycle.ts stop / archive / delete
src/session/edit.ts      worktree editor target resolution + post-edit Git summary
src/session/manual.ts    manual workspaces (kind "manual"): project resolution, creation, live diff
src/session/readme.ts    bounded session digest, README authoring and link management
src/publish/             pluggable local and Claude Artifact page publishers
src/session/review.ts    human-requested persona review startup
src/session/pr-fix.ts    session and per-PR auto-fix toggles
src/session/link-pr.ts   link_pr / unlink_pr: adopt an existing GitHub PR (baseline its feedback (fix_pr includeExisting reopens it), latch readiness)
src/session/auto-link-prs.ts  autoLinkPrs: link PR URLs from the human's messages (prompt hook / before launch)
src/session/refresh.ts   stale detection, refresh guards + supervisor/watcher restart
src/session/restart.ts user-initiated process restart + agent revive
src/process/version.ts   memoized identity of the running Tack source or binary
src/cli/                 dashboard.tsx (Ink dashboard), liveness.ts
src/artifacts/store.ts   refs → files (the DB only stores paths)
```

## Conventions (please keep)

- **Shell out; don't reimplement.** Integrate runtimes only via their headless
  CLIs. No SDKs, no reaching into their native session stores. This is the core
  bet — see SPEC §2.
- **DB holds refs, not blobs.** Anything large (prompts, outputs, diffs, context)
  goes through `src/artifacts/store.ts` and is referenced by path. Never add an
  inline-text column.
- **One normalized event stream.** All runtime output becomes `AgentEvent`
  (`src/runtimes/types.ts`). Keep the supervisor and dashboard runtime-agnostic —
  no `if (runtime === "claude")` outside the adapters.
- **Repo `CLAUDE.md`/`AGENTS.md` are sacred.** Tack injects its own context via
  session-scoped files by path; it must never write to a project's checked-in
  guidance files.
- **Comment the "why," match surrounding density.** Dense doc-comments explain
  intent and non-obvious decisions, as in the existing files.
- **Cost:** trust claude's `total_cost_usd`; compute codex from tokens × pricing.
  Codex models without pricing report no cost — keep that guardrail (SPEC §5).
- **Git:** never commit unless explicitly asked.

## Common extensions

- **Add a persona:** add `{ name, description, model? }` to `personas` in the user's
  `config.ts`. Reviews run only when the human explicitly requests one. Optional
  models default to `roles.agent`; reviews prefer a model different from the author.

- **Add a model:** add an entry to `models` in the user's `config.ts` (key,
  provider, name, version, runtime, id, optional effort/pricing) and assign roles to
  it. Each role accepts a key or non-empty list, e.g. `agent: ["gpt-6.1-sol", "opus-5"]`.
  Loading normalizes roles to distinct `string[]`; use `modelForRole` for a uniform
  random pick or `roleModelKeys` for membership. One key always uses that model.
  Supervisor picks persist for the session (including resume), agent picks persist
  at spawn, and summary calls pick each time. No code change. Codex models are discovered live: `tack models sync` adds
  what `codex debug models` reports for the signed-in account and prunes the rest
  (re-pinning affected roles). For claude, which can't list models, add it to
  `MODEL_CATALOG` (`src/runtimes/catalog.ts`) to make it discoverable — sync adds
  catalog models for whichever runtimes resolve to a working binary (and then
  fills codex pricing from models.dev). A runtime opts into live discovery by
  implementing `Runtime.listModels`. The same listing gates spawns:
  `checkModelOffered` (`src/runtimes/availability.ts`, cached per runtime per
  process) refuses `spawn_agent`, and makes `tack runtimes
  doctor` warn when a model isn't offered. Long-lived launchers hand their runtime/model preflight to detached runners; missing or mismatched handoffs fall back to the runner check. An unknown listing never blocks.
- **Add a runtime (e.g. Bedrock):** add the kind to `RuntimeKind`
  (`src/config/schema.ts`), implement `Runtime` in `src/runtimes/`, wire it in
  `selectRuntime` (`src/runtimes/index.ts`), handle its `bin`/version in
  `resolve.ts`, and add its install package to `PACKAGE` in `install.ts` (or make
  the install path a no-op if it isn't a package-manager install). Keep it behind
  the `AgentEvent` contract.
- **Edit config programmatically:** use `prepareConfigChange` / `commitConfigChange`
  (`src/config/mutate.ts`, behind `read_config` / `update_config`): segment paths,
  raw-authored edits, temp-file `loadConfig` validation, hash-checked atomic rename,
  and a denylist for anything that runs commands or widens access. Block writers in
  `src/config/edit.ts` rewrite one top-level property via `replaceTopLevelProperty`.
- **Add a supervisor capability:** add a tool to
  `src/mcp/supervisor-server.ts` and document it in the supervisor context
  (`src/supervisor/context.ts`).
- **Change the schema:** append a migration in `src/db/migrate.ts` (never edit an
  applied one) and update `src/db/repositories.ts`.

## PR readiness

`open_pr` forces drafts by default (`draftPrs: true`); false honors the tool's
`draft` argument. PR watch (`prWatch.enabled`, default true) auto-promotes once
with `prWatch.autoReady` (default true): mergeable, no busy fix or outstanding
feedback, explicit handled decisions/replies for non-CI items, and settled green
current-head CI. Drafts fetch checks even with `fixCi: false`; fetch failures block
promotion and zero checks is green. The durable `session_prs.ready_promoted_at`
latch respects a human's later return to draft. Keep readiness and CI ingestion
on the same pending/failing predicates; promotion failures retry next tick. Per-session
`pr_fix_enabled` controls automatic fix spawning independently of promotion; each
`session_prs.pr_fix_enabled` narrows it to one PR (effective = session && PR). Hold/unhold
touch only the session flag. The dashboard's `p` PR actions menu runs open/copy/poll/
review/auto-fix on all of a session's PRs or one.

## Testing & gotchas

- `bun test` runs the unit tests under `test/` (pure logic: PR-watch feedback
  normalization, fix prompts, migrations against an in-memory DB). Keep it and
  `bun run typecheck` green, and smoke-test the CLI + MCP handshakes against a
  scratch `TACK_HOME`.
- Live runs cost money and mutate repos — validate with `tack agent <project>
  "<small task>"` before `tack session create`.
- **Codex `--json` parsing is version-fragile** (targets an internal build); if you
  bump codex, re-check the field extractors in `src/runtimes/codex.ts`.
- MCP servers speak their protocol over **stdout** — the `__mcp` / `__supervisor-mcp`
  subcommands must emit nothing else there (they bypass citty for this reason).
- The interactive supervisor may draft publishable pages only under
  `<TACK_HOME>/supervisor/<sessionId>/artifacts` (preferred) or this Claude session's
  `<claudeTmpRoot>/claude-<uid>/<sanitizedCwd>/<session_id>/scratchpad`.
  `__guard-write` derives the scratchpad from hook stdin; the temp root is the
  realpath of `$CLAUDE_CODE_TMPDIR` or `/tmp`. The scratchpad may not exist yet.
  Keep its symlink/ancestor resolution fail-closed and the parent `.claude`
  settings unwritable. Publishing tools keep their normal permissions.

## Restarting sessions

`tack session restart <id>` (dashboard `r`) stops the supervisor even mid-turn or
with a pending plan, revives orphaned or transient-failed agents except manual and
`pr_fix` agents, and restarts dead or stale PR watchers when needed. The supervisor
is parked detached in tmux; without tmux it stays stopped until resume. `--all`
processes active sessions and parks only supervisors that were running. A pending
plan is re-presented. The `stale` badge identifies processes on older code or config.

Interactive `session resume` and dashboard config save retain guarded automatic
refresh of stale processes without reviving agents. Logic lives in
`src/session/restart.ts` and `src/session/refresh.ts`.

Release-gated dependencies use `open_pr` with `awaitsRelease` after opening the upstream PR. PR watch waits for a containing GitHub release or tag, queues an uncapped dependency fix, and blocks draft promotion while it waits. No package registry or configuration setting determines publication.

Session READMEs can be linked or unlinked with `tack session readme <id> --link <url>` / `--unlink` or supervisor tools `link_readme` / `unlink_readme`. Regeneration republishes into and overwrites the linked URL; `--no-publish` keeps the link.

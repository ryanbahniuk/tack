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
src/db/                  connection, migrate (schema), repositories, index
src/runtimes/            types (Runtime/AgentEvent), claude.ts, codex.ts, proc.ts, pricing.ts, pricing-sync.ts (models.dev), resolve.ts, install.ts
src/mcp/                 coordination-server.ts (agents), supervisor-server.ts (supervisor: spawn/touches/dependsOn, check_conflicts)
src/agent/               execute.ts (prepare/run + activity/error), detached.ts (background runner, dependency self-gate + retry)
src/supervisor/          supervise.ts (runner), context.ts (system context), conflicts.ts (overlap/collision detection)
src/context/build.ts     per-agent context file
src/worktree/            session-scoped worktrees + PR branch nomenclature
src/projects/            prs.ts (gh-based PR discovery), summarize.ts (auto-describe a repo)
src/session/lifecycle.ts stop / archive / delete
src/cli/                 stable.tsx (Ink dashboard), liveness.ts
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

- **Add a model:** add an entry to `models` in the user's `config.ts` (key,
  provider, name, version, runtime, id, optional effort/pricing) and pin roles to
  it. No code change. To make a model discoverable via `tack models sync`, also
  add it to `MODEL_CATALOG` (`src/runtimes/catalog.ts`) — sync adds catalog
  models for whichever runtimes resolve to a working binary (and then fills codex
  pricing from models.dev).
- **Add a runtime (e.g. Bedrock):** add the kind to `RuntimeKind`
  (`src/config/schema.ts`), implement `Runtime` in `src/runtimes/`, wire it in
  `selectRuntime` (`src/runtimes/index.ts`), handle its `bin`/version in
  `resolve.ts`, and add its install package to `PACKAGE` in `install.ts` (or make
  the install path a no-op if it isn't a package-manager install). Keep it behind
  the `AgentEvent` contract.
- **Add a supervisor capability:** add a tool to
  `src/mcp/supervisor-server.ts` and document it in the supervisor context
  (`src/supervisor/context.ts`).
- **Change the schema:** append a migration in `src/db/migrate.ts` (never edit an
  applied one) and update `src/db/repositories.ts`.

## Testing & gotchas

- No automated suite yet. At minimum keep `bun run typecheck` green and smoke-test
  the CLI + MCP handshakes against a scratch `TACK_HOME`.
- Live runs cost money and mutate repos — validate with `tack agent <project>
  "<small task>"` before `tack session create`.
- **Codex `--json` parsing is version-fragile** (targets an internal build); if you
  bump codex, re-check the field extractors in `src/runtimes/codex.ts`.
- MCP servers speak their protocol over **stdout** — the `__mcp` / `__supervisor-mcp`
  subcommands must emit nothing else there (they bypass citty for this reason).

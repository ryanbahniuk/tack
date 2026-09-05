# Tack

A **runtime-neutral supervisor** that drives Claude Code (`claude`) and the Codex
CLI (`codex`) as interchangeable "runtimes" to plan and coordinate parallel coding
work across projects. A persistent planning agent (the *supervisor*) investigates,
plans, and delegates units of work to *agents* — each running autonomously in its
own isolated git worktree, backed by whichever runtime/model you pin. Tack shares
context between agents (even across runtimes), tracks per-session cost, discovers
the PRs they open, and gives you one live view of everything in flight.

Tack deliberately reimplements **none** of the agent loop those CLIs provide — it
shells out to their headless entrypoints and inherits whatever they ship. See
[SPEC.md](./SPEC.md) for the full architecture and rationale, and
[AGENTS.md](./AGENTS.md) for the contributor guide.

## Prerequisites

- **[Bun](https://bun.sh)** — the runtime and package manager. No build step; Bun
  runs the `.ts`/`.tsx` sources directly.
- **[Claude Code](https://github.com/anthropics/claude-code)** (`claude`) and/or
  **[Codex CLI](https://github.com/openai/codex)** (`codex`) — the coding-agent
  runtimes Tack drives. You need at least the ones your config's roles point at.
  Tack can install pinned versions for you (see [Configure](#configure)), or you
  can supply them on your `PATH`.
- **[`gh`](https://cli.github.com)** (optional) — the GitHub CLI, used to discover
  the PRs agents open (`tack prs`, the dashboard). PR discovery is skipped if it's
  absent; everything else works without it.
- Authenticated `claude` and/or `codex` — Tack uses your existing CLI logins; it
  does not manage runtime credentials.

## Setup

```bash
# 1. Install dependencies
bun install

# 2. Scaffold ~/.tack/config.ts and install any pinned runtimes
bun run ./bin/tack.ts init

# 3. Confirm the CLI runs
bun run ./bin/tack.ts --help
```

`tack init` writes a starter config to `~/.tack/config.ts` (the state root; override
with the `TACK_HOME` env var) and ensures the pinned runtime versions are present.

### Optional: install `tack` on your PATH

`package.json` exposes a `tack` bin, so you can link it globally instead of typing
`bun run ./bin/tack.ts` every time:

```bash
bun link          # then invoke as: tack --help
```

The rest of this README uses the short `tack …` form.

## Configure

Edit `~/.tack/config.ts` — a plain TypeScript module that `export default`s a config
object. At minimum, add your **projects** so the supervisor knows what repos it can
reason over:

```ts
export default ({
  projects: [
    { name: "my-app", path: "~/Code/my-app", description: "What this repo is." },
  ],

  // A "model" names a runtime (claude | codex) + the id passed to that CLI.
  // Codex models MUST carry `pricing` (USD per 1M tokens) to report a cost —
  // Codex reports tokens only. Claude reports cost directly.
  models: [
    { name: "opus", runtime: "claude", id: "opus", effort: "high" },
    { name: "sonnet", runtime: "claude", id: "sonnet" },
    {
      name: "gpt-5-codex", runtime: "codex", id: "gpt-5-codex", effort: "medium",
      pricing: { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.125 },
    },
  ],

  // Every role is pinned to a model by name; loading fails loudly on an unknown name.
  roles: { supervisor: "opus", agent: "gpt-5-codex", summary: "sonnet" },

  // Pin runtime CLI versions for reproducibility (verified before every run).
  // `tack init` / `tack install` fetch a pinned-but-missing version into ~/.tack/runtimes/.
  runtimes: {
    // claude: { version: "2.1.261" },
    // codex: { bin: "~/.local/bin/codex", version: "0.147.0" },
  },

  readAllowlist: [],
});
```

The `description` field is load-bearing — the supervisor uses it to pick relevant
repos. Verify your setup at any time:

```bash
tack doctor      # resolve runtime binaries + verify version pins
tack projects    # list configured projects
tack models      # list models and role pins
```

## Usage

```bash
# Run a single agent on one project (no supervisor) — the quickest way to
# validate the runtime pipeline before spending on a full session.
tack agent my-app "Add a health-check endpoint"

# Plan and coordinate agents across projects for a larger problem.
tack supervise "Migrate all services off the deprecated auth client"

# Watch live work: Session → Agent → PR tree with cost and liveness.
tack stable

# Inspect and manage sessions.
tack sessions          # list sessions and cost
tack ls                # sessions → agents → PRs
tack prs <session>     # discover PRs a session opened
tack stop <session>    # stop a session and its agents
tack archive <session> # hide from the default view
tack delete <session>  # kill pids, purge worktrees + artifacts, cascade DB rows
```

Run `tack --help` (or `tack <command> --help`) for the full command list.

## Development

```bash
bun run typecheck   # tsc --noEmit — keep this green

# Always test against a throwaway state root so you never touch a real ~/.tack:
TACK_HOME=$(mktemp -d)/tack bun run ./bin/tack.ts init
```

There is no automated test suite yet. At minimum keep `bun run typecheck` green and
smoke-test the CLI against a scratch `TACK_HOME`. Live runs cost money and mutate
repos, so validate with `tack agent` before `tack supervise`. See
[AGENTS.md](./AGENTS.md) for conventions and common extension points.

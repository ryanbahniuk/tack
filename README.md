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
  the PRs agents open (via the `tack stable` dashboard). PR discovery is skipped if
  it's absent; everything else works without it.
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
    {
      name: "my-app", path: "~/Code/my-app", description: "What this repo is.",
      metadata: { language: "TypeScript", frameworks: ["React", "Bun"] },
    },
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
  // Pin from the CLI with `tack runtimes pin <runtime> <version>`; `tack init` /
  // `tack runtimes install` fetch a pinned-but-missing version into ~/.tack/runtimes/.
  runtimes: {
    // claude: { version: "2.1.261" },
    // codex: { bin: "~/.local/bin/codex", version: "0.147.0" },
  },

  readAllowlist: [],
});
```

The `description` field is load-bearing — the supervisor uses it to pick relevant
repos. `metadata` (`language` + top `frameworks`) lets it route on stack too. Let a
summary model write both for you instead of hand-authoring:

```bash
tack projects add ~/Code/my-app       # describe one repo and add it to the config
tack projects add --all               # add every git repo in the current directory
tack projects refresh my-app          # re-summarize a repo, updating it in place
tack projects refresh --all           # re-summarize every configured project
tack projects remove my-app           # drop a project (by name or path)
```

Verify your setup at any time:

```bash
tack runtimes list   # list runtimes and their status
tack runtimes doctor # resolve runtime binaries + verify version pins
tack projects       # list configured projects
tack models         # list models and role pins
```

Seed the `models` block instead of hand-authoring entries — `sync` adds every model
offered by a connected runtime CLI (skipping ones already configured) and then fills
codex pricing from models.dev in one step. For codex, "offered" means what your
signed-in account can actually use (`codex debug models`; a ChatGPT login and an API
key see different sets), so sync also **removes** configured codex models the login
can't run. A role pinned to a removed model is re-pinned — with a warning — to the
newest model of the same family from the same provider (e.g. `gpt-5.6-sol` →
`gpt-6.1-sol`), else that provider's top-ranked model. Claude has no such listing,
so claude models come from Tack's catalog and are never removed.

```bash
tack models sync          # reconcile models with the connected runtimes + fill codex pricing
```

Codex reports tokens only, so its models need a `pricing` table to report a cost.
Rather than hand-maintain USD rates that go stale, `tack models sync` fetches them
from [models.dev](https://models.dev) (a read-only network call, made only when you
run this; nothing of yours is sent) and fills any codex model missing pricing —
`--all` re-fetches them all. Claude models don't need it (the CLI reports cost
directly).

Manage the runtime CLIs from the command line instead of hand-editing the config:

```bash
tack runtimes pin claude 2.1.261      # write a version pin into ~/.tack/config.ts
tack runtimes install claude          # install one runtime's pinned version
tack runtimes install --all           # install every configured runtime
```

## Usage

```bash
# Run a single agent on one project (no supervisor) — the quickest way to
# validate the runtime pipeline before spending on a full session.
tack agent my-app "Add a health-check endpoint"

# Plan and coordinate agents across projects for a larger problem. Bare `tack`
# is shorthand for `tack session create`, which drops you into the supervisor
# runtime's own interactive chat (Claude Code / Codex) — read-only, delegating to
# agents through its tools. `-m` seeds the first message; `--resume` continues a
# session in the same live chat.
tack
tack session create -m "Migrate all services off the deprecated auth client"
tack session create --resume <session>          # follow up, in the chat

# Or run the supervisor headless & detached (no chat), watched via `tack stable`.
tack session create --background -m "Migrate all services off the deprecated auth client"

# Watch live work: Session → Agent → PR tree with cost and liveness.
tack stable

# Inspect and manage sessions.
tack session list                  # list sessions and cost
tack session show <session>        # agents, PRs, cost, and pending amendments
tack session context <session>     # the shared contract + version history (--all for bodies)
tack session stop <session>        # stop a session and its agents
tack session archive <session>     # hide from the default view
tack session delete <session>      # kill pids, purge worktrees + artifacts, cascade DB rows
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
repos, so validate with `tack agent` before `tack session create`. See
[AGENTS.md](./AGENTS.md) for conventions and common extension points.

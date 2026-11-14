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
  the PRs agents open (via the `tack dashboard` dashboard). PR discovery is skipped if
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

  // Each role accepts a model key or a non-empty list; unknown keys fail at load.
  // The summary model also auto-generates session titles (`tack session retitle <id>` to redo one).
  roles: { supervisor: "opus", agent: ["gpt-5-codex", "opus"], summary: "sonnet" },

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

A role with one key always uses that model. With several distinct keys, Tack picks
uniformly at random each time the role is resolved (duplicates are ignored).
Supervisor picks stay fixed for the session, including resumes; worker picks stay
fixed for the agent. Summary calls pick each time. Use
`tack roles set agent gpt-5-codex opus` (or `gpt-5-codex,opus`) to set a list;
`tack roles set agent gpt-5-codex` restores a single model.

The `description` field is load-bearing — the supervisor uses it to pick relevant
repos *before reading any code*: it syncs just those into fresh, Tack-owned snapshot
worktrees of the latest default branch and investigates there, never in your own
checkouts (which it doesn't touch). `metadata` (`language` + top `frameworks`) lets it route on stack too. Let a
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
tack runtimes doctor # resolve runtime binaries, verify version pins + role models the login offers
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

Tack also checks this before running anything: `spawn_agent` refuses (and a
detached agent fails immediately) when its model isn't offered to the codex login,
and `tack runtimes doctor` warns about any role pinned to such a model. Either way
the fix is `tack models sync`. If the login's model list can't be read, the check
is skipped rather than blocking.

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

# Or run the supervisor headless & detached (no chat), watched via `tack dashboard`.
tack session create --background -m "Migrate all services off the deprecated auth client"

# Watch live work: Session → Agent → PR tree with cost and liveness.
tack dashboard

# Inspect and manage sessions.
tack session list                  # list sessions and cost
tack session show <session>        # agents, PRs, cost, and pending amendments
tack session context <session>     # the shared contract + version history (--all for bodies)
tack session approve <session>     # approve a stuck plan (or type /approve in the Claude session)
tack session stop <session>        # stop a session and its agents
tack session archive <session>     # stop + hide, remembering interrupted agents
tack session unarchive <session>   # restore + resume interrupted agents
tack session resume <session>      # rejoin the supervisor
tack session delete <session>      # kill pids, purge worktrees + artifacts, cascade DB rows
```

`tack dashboard` defaults to a split view on terminals at least 140 columns wide:
work on the left, **Insights** on the right. Press `s` to cycle split → list-only →
full-screen Insights. Narrow terminals start with the list; `s` still opens Insights.
Press `[` / `]` to move through 7d, 30d, 90d, 1y, and all history (default: 30d).
The header shows the current layout and range. Existing session keys still work
in the list: `j/k`, `enter/o`, `v`, `m`, `n`, `O`, `J`, `c`, `x`, `a`, `d`, `z`, `q`.
Press `a` to archive/unarchive and `z` to show archived sessions. Archiving is
immediate; unarchiving asks for confirmation and resumes only the agents archive
interrupted. Agents with a runtime session handle continue their conversation;
others start with their original prompt in the same worktree. A plain `x`/`stop`
does not mark agents for restoration. Unarchive leaves the supervisor for you to
rejoin with `enter/o` or `tack session resume <session>`.

Insights includes archived sessions regardless of the list's `z` filter. It shows
sessions, agents, PRs opened/merged, tickets linked/done, cost, changes against the
previous equal-length period, top repos, and a contribution heatmap. Full-screen
Insights adds a per-repo table, sorted by agent count. Daily/weekly/monthly buckets
adapt to range and width; dates use local time. PR creation means first linked to
a session, and ticket completion is approximated by its last status refresh.
Costs include supervisor and agent spend; repo costs include agents only.
Monochrome glyphs preserve chart values without color. Charts refresh every five
seconds when their data changes; an idle dashboard does not repaint.

Run `tack --help` (or `tack <command> --help`) for the full command list.

With tmux installed, interactive supervisors stay live when you detach with
`prefix d`; use `tack session resume <session>` to reattach. Press `prefix N`
(capital N) to park the current supervisor and open a new Tack session with the
normal create lifecycle. Press `prefix B` (capital B) to park it and report a bug
in Tack itself in a new session, with a bounded digest of the source session.
Enter an optional description inline, or use
`tack session create --tack-bug-from <sessionId> -m "what went wrong"` from any terminal.
Bug reports always open interactively, including with `-b`. When nested inside your
own tmux, press the prefix twice before `d`, `N`, or `B`. The status bar shows the keys for your current attach context.

## Development

```bash
bun run typecheck   # tsc --noEmit — keep this green

# Always test against a throwaway state root so you never touch a real ~/.tack:
TACK_HOME=$(mktemp -d)/tack bun run ./bin/tack.ts init
```

Run `bun test` and keep `bun run typecheck` green, then
smoke-test the CLI against a scratch `TACK_HOME`. Live runs cost money and mutate
repos, so validate with `tack agent` before `tack session create`. See
[AGENTS.md](./AGENTS.md) for conventions and common extension points.

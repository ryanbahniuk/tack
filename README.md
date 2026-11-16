# Tack

Tack is a supervisor for coding agents. You describe a problem, and a persistent
planning agent (the **supervisor**) investigates your repos, proposes a plan, and,
once you approve it, delegates units of work to **agents**. Agents are Claude Code
(`claude`) or Codex (`codex`) runs, each in its own isolated git worktree, and
each unit of work becomes one reviewable PR. Tack shares a contract between agents,
tracks cost, watches the PRs it opens and gives you one live dashboard.

> *"Migrate every service off the deprecated auth client and open a PR per repo."*

Tack reimplements none of the agent loop. It shells out to the runtimes' headless
CLIs and inherits whatever they ship. See [SPEC.md](./SPEC.md) for the architecture
and [AGENTS.md](./AGENTS.md) for the contributor guide.

---

## Quickstart

### 1. Prerequisites

```bash
brew install oven-sh/bun/bun gh tmux uv
```

| Tool | Required? | What it enables |
| --- | --- | --- |
| [Bun](https://bun.sh) | **Required** | Runs Tack (no build step) and installs pinned runtimes. |
| `claude` (Claude Code) | **Required** for the default supervisor and summary roles | The supervisor and Claude-backed agents. |
| `codex` (Codex CLI) | Required for the starter's default `agent` role | Codex-backed agents. If you skip it, point `agent` at a Claude model (see below). |
| [`gh`](https://cli.github.com) | Strongly recommended | Opening PRs, discovering them and PR watch. Without it, PR status never updates. |
| `tmux` | Recommended | Detaching from a live supervisor and reattaching later, plus `prefix N` / `prefix B`. |
| `uv` (`uvx`) | Optional | Mounting the Atlassian MCP server for the supervisor ([Chime setup](#recommended-chime-setup)). |

Install and log in to the runtimes and GitHub. Tack uses your existing logins and
never manages credentials itself.

```bash
# Skip any runtime you already have on PATH
bun add -g @anthropic-ai/claude-code @openai/codex

claude          # log in once, then exit
codex login     # ChatGPT login or API key
gh auth login
```

### 2. Install Tack

```bash
git clone git@github.com:ryanbahniuk/tack.git
cd tack
bun install
bun link        # puts `tack` on your PATH (the rest of this README assumes it)
```

### 3. Initialise

```bash
tack init
```

`tack init` writes a starter config to `~/.tack/config.ts` (set `TACK_HOME` to use
another state root) and installs any pinned runtime versions. If you run it inside
a git repo, it also registers that repo as a project and describes it with the
summary model.

### 4. Add projects, sync models and check your setup

```bash
tack projects add ~/Code/my-app   # one repo; auto-writes description + metadata
tack projects add --all           # or: every git repo in the current directory

tack models sync                  # add models your logins offer, prune the rest, fill codex pricing
tack runtimes doctor              # binaries, version pins, auth and role models in one check
```

> **No Codex?** Run `tack roles set agent opus-5` so agents run on Claude.

### 5. First run: one cheap agent

```bash
tack agent my-app "Add a short CONTRIBUTING note about running tests"
```

This runs one agent directly (no supervisor) in its own worktree and streams its
output. It's the cheapest way to confirm the runtime pipeline works.

### 6. A real session

```bash
tack                 # same as `tack session create`
```

In another terminal:

```bash
tack dashboard
```

**What to expect:**

1. You land in the supervisor's own interactive chat (Claude Code or Codex). Describe
   the problem, or pass it up front with `tack -m "…"`.
2. The supervisor reads Tack-owned snapshots of the relevant repos and proposes a
   plan. An **approval prompt** appears. If it doesn't, type `/approve` in the chat
   or run `tack session approve <session>`.
3. Agents spawn in their own worktrees. You can watch them in `tack dashboard`, where
   cost, liveness and the Session → Agent → PR tree are shown.
4. When the work is done, the supervisor commits, pushes and opens **draft PRs**,
   one per unit of work, and PR watch takes over from there.

---

## Before your first session

- **This spends real money.** Every supervisor and agent run is billed to your
  runtime logins. You can see per-session cost in `tack dashboard` and
  `tack session list`.
- **Your own checkouts are never touched.** The supervisor investigates Tack-owned
  snapshot worktrees of each project's latest default branch, and each agent works
  in its own worktree on a `tack/<session>/<agent>` branch. Tack also never writes
  to a repo's `CLAUDE.md` or `AGENTS.md`.
- **PRs open without asking, by default.** With `autoOpenPrs: true`, the supervisor
  commits, pushes and opens draft PRs on its own. Set `autoOpenPrs: false` and it
  asks first, then confirms each PR before opening it.
- **PR watch acts on its own.** For every open PR it fixes review comments (bots
  included), failing CI and merge conflicts, pushes (never force) and replies on
  GitHub. Once a draft is addressed and green, it marks the PR ready. To turn this
  off, use these settings:
  - `prWatch.enabled: false`: no watcher at all.
  - `prWatch.fixCi: false`, `prWatch.reply: false`, `prWatch.autoPush: false` or
    `prWatch.autoReady: false`: turn off individual behaviours.
  - Per session: `tack session pr-fix <session> off`, dashboard `F`, or `/pr-fix off`.

---

## Recommended Chime setup

The supervisor runs with `--strict-mcp-config`, so it **does not inherit your
global Claude plugins or MCP servers**. To let it read Jira and Confluence (for
example, to open a ticket named in your problem), mount the Atlassian MCP server
in `~/.tack/config.ts`. This needs `uvx` (`brew install uv`).

```ts
supervisorMcpServers: [
  {
    name: "Atlassian",
    command: "uvx",
    args: ["--refresh", "--from", "git+ssh://git@github.com/1debit/chime-atlassian-mcp@main", "chime-atlassian-mcp"],
    env: { CONFLUENCE_CLOUD_ID: "a40b7113-0103-4597-b693-76b66e0a4614", CONFLUENCE_SITE_URL: "https://chime.atlassian.net" },
  },
],

// Track-only ticket status for each session (Tack never creates, edits or transitions tickets)
jira: { mcpServer: "Atlassian", siteUrl: "https://chime.atlassian.net" },
```

- **Auth:** Tack passes no tokens. The server inherits your environment and reuses
  the OAuth cache that the `chime-atlassian` plugin keeps at
  `~/.cache/chime-atlassian-mcp/`. Seed that cache once from an interactive client
  (the plugin, or an interactive Tack supervisor, which can answer the OAuth prompt).
  After that, headless runs reuse it. Never put tokens in `config.ts`.
- **Permissions:** a mounted server's tools are auto-allowed under the supervisor's
  read-only posture, including any write tools the server exposes. Only mount
  servers you're comfortable with it calling.
- **Tickets:** with `jira` set, the supervisor links the tickets a session works
  on. `tack dashboard` refreshes their status (press `J` to open them) and
  `tack session show` lists them. `cloudId` is optional and falls back to the
  server's `CONFLUENCE_CLOUD_ID`.

---

## Everyday use

### Sessions

```bash
tack                                        # create a session (interactive supervisor chat)
tack session create -m "Fix the flaky login test"   # seed the first message
tack session create -b -m "…"               # --background: headless + detached, plan auto-approved
tack session resume <session>               # rejoin a live supervisor, or resume a stopped one
tack session resume <session> -m "Also update the docs"   # resume with a message (-b for headless)
```

Bare `tack session` lists sessions. `sessions` is accepted as an alias.

| Command | What it does |
| --- | --- |
| `tack session list [--all]` | Sessions, status and cost; `◆ needs input` flags ones waiting on you. `--all` includes archived sessions. |
| `tack session show <session>` | Agents, PRs, Jira tickets, cost split and pending amendments. |
| `tack session context <session> [--all]` | The shared cross-agent contract (`--all` shows every version). |
| `tack session approve <session>` | Approve a plan when the in-chat prompt didn't appear. |
| `tack session follow <agentId>` | Stream an agent's live transcript. |
| `tack session poll-prs <session>` | Ask the PR watcher to poll now (starts or wakes it if PRs are open). |
| `tack session retitle <session>` | Regenerate the title with the summary model. |
| `tack session refresh <session> \| --all [--force]` | Move stale supervisor and watcher processes onto updated Tack code without stopping agents. |
| `tack session reconnect <session> \| --all` | After sleep or a lost connection: restart the supervisor (even mid-turn; a pending plan is re-presented), revive agents the outage killed, restart a dead PR watcher, then park the supervisor detached in tmux and hand the terminal back (attach with `resume`). Without tmux the supervisor stays stopped until `tack session resume`. `--all` covers every active session. |
| `tack session stop <session>` | Stop the session and its agents. |
| `tack session archive <session>` | Stop and hide it, remembering which agents were interrupted. |
| `tack session unarchive <session>` | Restore it and resume the interrupted agents (then rejoin with `resume`). |
| `tack session delete <session>` | Kill processes and purge worktrees, artifacts and DB rows. This can't be undone. |

`tack session resume` refreshes stale Tack processes automatically when the session
is idle. `refresh --all` parks the replacement supervisors detached in tmux;
without tmux they stay stopped until you resume them.

### tmux: detach, reattach, new session, bug report

With tmux installed, interactive supervisors run inside a Tack tmux server:

| Key | Action |
| --- | --- |
| `prefix d` | Detach and leave the supervisor running. Reattach with `tack session resume <session>`. |
| `prefix N` | Park this supervisor and open a new Tack session. |
| `prefix B` | Park it and open a new session that reports a **Tack bug**, with a bounded digest of this session. |

When you're nested inside your own tmux, press the prefix twice. The status bar
shows the right keys. From any terminal, `tack session create --tack-bug-from
<session> -m "what went wrong"` does the same as `prefix B`. Bug reports are always
interactive, even with `-b`.

### Dashboard

```bash
tack dashboard
```

The dashboard shows a live Session → Agent → PR tree with cost, liveness and PR
and ticket status. On terminals at least 140 columns wide it opens in split view,
with work on the left and **Insights** on the right.

| Key | Action |
| --- | --- |
| `j` / `k` | Move |
| `enter` / `o` | Open (rejoin) the selected session's supervisor |
| `c` | Create a new session |
| `v` | Agents picker: `enter`/`o`/`v` shows output (a live follow for running agents), `e` edits a worktree, `n` creates a manual workspace |
| `m` | View pending amendments (read-only) |
| `O` | Open the session's PRs in the browser |
| `J` | Open the session's Jira tickets in the browser |
| `p` | Poll PRs now |
| `R` | Start a persona review |
| `F` | Toggle PR auto-fix for the session |
| `r` | Refresh the session onto current Tack code (asks first) |
| `w` | Wake: reconnect a session broken by sleep or network loss (asks first). The supervisor is parked in tmux and the dashboard stays open; `enter` attaches |
| `x` | Stop (asks first) |
| `a` | Archive, or unarchive (asks first) |
| `d` | Delete (asks first) |
| `z` | Show or hide archived sessions |
| `C` | Edit the Tack config, then reload it and refresh stale sessions |
| `s` | Cycle layout: split → list-only → full-screen Insights |
| `[` / `]` | Insights range: 7d · 30d (default) · 90d · 1y · all |
| `q` | Quit |

Working supervisors show a spinner and elapsed turn time, a pending plan shows
`◆ needs input`, and sessions running older Tack code are marked `stale`.

<details>
<summary>Insights details</summary>

Insights covers archived sessions regardless of the `z` filter. It shows sessions,
agents, PRs opened and merged, tickets linked and done, tokens and cost, each with
the change against the previous equal-length period. It also shows top repos, a
contribution heatmap and a Models table (sessions, agents including PR-fix agents,
tokens and cost per model; missing models appear as "unknown"). Full-screen
Insights adds a per-repo table sorted by agent count.

- Buckets (daily, weekly or monthly) adapt to the range and terminal width, and
  dates use local time.
- "PR opened" means the PR was first linked to a session. "Ticket done" is
  approximated by its last status refresh.
- Costs include supervisor and agent spend; repo costs include agents only.
- Tokens include input, output, cache reads and cache writes, and follow each row's
  creation date. Historical supervisor tokens stay zero. New headless usage
  overwrites with the runtime's latest-run figure; interactive transcript recovery
  replaces both with cumulative figures. Tokens and cost don't count toward the
  heatmap.
- Charts use block heights (`▁▂▃▄▅▆▇█`, `·` for zero) with shared scales for paired
  series. Heatmap shades (`░▒▓█`) have their own legend, and blank cells fall
  outside the range. KPIs show signed changes without relying on colour.
- Charts refresh every five seconds when their data changes. An idle dashboard
  doesn't repaint.

</details>

### Editing worktrees and manual workspaces

```bash
tack session edit <session> [agent]          # open an agent's worktree in $VISUAL / $EDITOR (fallback vim, then vi)
tack session edit <session> [agent] --force  # allowed even if the agent is pending or running
tack session edit <session> --print-path     # just print the path
tack session edit <session> --new [project]  # create a clean manual workspace and open it
```

- You can omit the agent when the session has only one worktree. After you edit,
  Tack reports the branch and Git status and gives a push hint if one is needed.
  It never commits or pushes for you.
- A **manual workspace** is your own worktree on a fresh `tack/<session>/<id>` branch,
  forked from the up-to-date remote default branch. It never runs as an agent and
  costs nothing. The supervisor sees it in `check_agents` and `check_conflicts`, and
  opens a PR from it (committing your leftover edits) when you ask, or at wrap-up if
  it holds changes. Reopen it with `tack session edit <session> <id>`.
- You can omit the project when only one qualifies. In the dashboard, press `v`,
  then `e` to edit or `n` for a new workspace. Editing a running agent asks you
  to confirm with `y`.

### Persona reviews and PR auto-fix

Reviews run only when you ask. They need `personas` in your config
([configuration](#personas)).

```bash
tack session review <session>                    # list configured personas
tack session review <session> <persona> [--prompt "extra focus"] [--model <key>]
tack session pr-fix <session> [on|off]           # show or set PR auto-fix for this session
```

Each review starts one independent review agent per open session PR. In the
dashboard, use `R` (review) and `F` (auto-fix). In an attended Claude supervisor
chat, use `/review <persona> [focus…]` and `/pr-fix [on|off]`.

<details>
<summary>How PR watch handles PRs</summary>

- **Drafts and readiness.** With `draftPrs: true`, PRs open as drafts even when
  `open_pr` asks for a ready PR. With `prWatch.autoReady`, the watcher promotes a
  draft **once** it meets all of these conditions:
  - it is mergeable;
  - no fix is busy;
  - every non-CI item has an explicit handled reply;
  - CI on the current head has settled with no failures.

  Zero checks counts as green, and a failed check fetch defers promotion. If a human
  later moves the PR back to draft, Tack respects that.
- **Fixes.** New review feedback, failing CI on the PR head (`fixCi`) or a merge
  conflict spawns a `pr_fix` agent (from `roles.agent`). CI fixes wait for the suite
  to settle and include bounded GitHub Actions failure logs. Agents reproduce the
  failure locally and fix code or tests. Unrelated flaky or infrastructure failures
  are reported without changes. `maxFixRunsPerDay` caps automatic runs per PR per
  rolling 24h; failed runs count, and supervisor `fix_pr` runs are exempt. Bot
  PR-summary comments are ignored.
- **Agent reuse.** With `agentReuse.enabled`, a fix continues the PR's last agent
  conversation in its existing worktree when that agent finished within
  `maxIdleHours` on the same runtime. Otherwise a fresh agent starts.
- **Replies.** Inline review comments get a reply in their own thread. Replies to
  conversation comments and review summaries are batched into one top-level comment
  per fix run, which quotes and links each original and cites the pushed fixes. CI
  items join that batch as links to the failing checks, without quoting logs. Human
  authors are mentioned at most once, and bots never are.

</details>

---

## Configuration reference

The config lives at `~/.tack/config.ts`: a TypeScript module that `export default`s
an object. It is validated with zod at load, so mistakes fail loudly.

```bash
tack config            # print the path (same as `tack config path`)
tack config edit       # open it in $VISUAL / $EDITOR, then validate
```

A minimal config, mirroring the `tack init` starter:

```ts
export default ({
  projects: [
    {
      name: "my-app", path: "~/Code/my-app",
      description: "What this repo is and what lives in it.",
      metadata: { language: "TypeScript", frameworks: ["React", "Bun"] },
    },
  ],

  models: [
    { key: "opus-5", provider: "anthropic", name: "Opus", version: "5", runtime: "claude", id: "claude-opus-5", effort: "high" },
    { key: "sonnet-5", provider: "anthropic", name: "Sonnet", version: "5", runtime: "claude", id: "claude-sonnet-5" },
    {
      key: "gpt-6.1-sol", provider: "openai", name: "GPT-6.1 Sol", version: "6.1",
      runtime: "codex", id: "gpt-6.1-sol", effort: "medium",
      // placeholder rates: `tack models sync` fills real ones from models.dev
      pricing: { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.4, cacheWritePer1M: 5 },
    },
  ],

  // Roles reference model `key`s
  roles: { supervisor: "opus-5", agent: "gpt-6.1-sol", summary: "sonnet-5" },

  runtimes: {},
  readAllowlist: [],
  supervisorMcpServers: [],
  agentReuse: { enabled: true, maxIdleHours: 24 },
  prWatch: {},
  autoOpenPrs: true,
  draftPrs: true,
});
```

### Top-level keys

| Key | Default | Purpose |
| --- | --- | --- |
| `projects` | `[]` | Repos the supervisor can reason over. |
| `models` | `[]` | Models available to roles and personas. |
| `roles` | **required** | `supervisor`, `agent`, `summary`: model key(s). |
| `personas` | `[]` | Reviewer lenses for persona reviews. |
| `runtimes` | `{}` | Per-runtime `bin`, `version` and `versionPolicy`. |
| `readAllowlist` | `[]` | Extra read-only paths the supervisor may investigate beyond the project snapshots. |
| `supervisorMcpServers` | `[]` | Extra MCP servers mounted for the supervisor only. |
| `prWatch` | see below | Background PR polling and auto-fix. |
| `agentReuse` | `{ enabled: true, maxIdleHours: 24 }` | Continue a PR's previous agent conversation for fixes. |
| `baseCache` | `{ enabled: true, intervalSeconds: 120, maxAgeSeconds: 600 }` | Background refresh of project default branches, so agents start fast. |
| `autoOpenPrs` | `true` | Supervisor opens PRs without asking; `false` asks and confirms each one. |
| `draftPrs` | `true` | Force new PRs to draft; `false` honours `open_pr`'s `draft` argument. |
| `jira` | unset | `{ mcpServer, siteUrl, cloudId? }`: track-only ticket status. |

### Projects

```bash
tack projects                    # list (same as `tack projects list`)
tack projects add <path> | --all
tack projects refresh <name|path> | --all   # re-summarize description + metadata in place
tack projects remove <name|path>
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Used by `tack agent <project>` and in the dashboard. |
| `path` | yes | `~` is expanded. |
| `description` | yes | **This field is load-bearing.** The supervisor uses it to choose which repos to snapshot *before* reading any code. |
| `metadata` | no | `{ language, frameworks[] }`, used to route on tech stack. |

`projects add` and `projects refresh` have the summary model write `description`
and `metadata` for you. `tack agent` and `tack session create` also auto-register
the current git repo if it isn't configured yet.

### Models and roles

| Model field | Required | Notes |
| --- | --- | --- |
| `key` | yes | Stable handle that roles reference, version-qualified (e.g. `opus-5`). |
| `provider` / `name` / `version` | yes | Describe the model, e.g. `anthropic` / `Opus` / `5`. |
| `runtime` | yes | `claude` or `codex`. |
| `id` | yes | Passed to the CLI (`claude --model <id>` / `codex exec -m <id>`). |
| `effort` | no | `low` · `medium` · `high` · `xhigh` · `max`. |
| `pricing` | no | USD per 1M tokens (`inputPer1M`, `outputPer1M`, `cacheReadPer1M`, `cacheWritePer1M`). **Codex models need this to report a cost**; Claude reports cost directly. |

```bash
tack models                     # list models + role pins (same as `tack models list`)
tack models sync [--all]        # reconcile with connected runtimes, then fill codex pricing (alias: `refresh`)
tack roles                      # list role pins (same as `tack roles list`)
tack roles set agent gpt-6.1-sol opus-5   # several candidates (also: gpt-6.1-sol,opus-5)
tack roles set agent opus-5               # back to a single model
```

- **Role lists:** each role takes one key or a non-empty list, and unknown keys fail
  at load. With several distinct keys, Tack picks one uniformly at random:
  - supervisor picks are fixed for the session, including resumes;
  - agent picks are fixed when the agent spawns;
  - summary calls pick each time.

  The summary model also writes project descriptions and session titles.
- **`models sync`:** adds every model each connected runtime offers and skips ones
  already configured.
  - For codex, "offered" means what *your* login can use (`codex debug models`; a
    ChatGPT login and an API key see different sets). Sync also **removes** codex
    models the login can't run. Any role pinned to a removed model is re-pinned,
    with a warning, to the newest same-family model from that provider.
  - Claude can't list models, so Claude models come from Tack's catalog and are
    never removed.
  - Sync then fetches codex pricing from [models.dev](https://models.dev). This is
    a read-only call, and nothing of yours is sent. `--all` re-fetches pricing for
    every codex model.
- **Preflight:** an agent whose model the login doesn't offer is refused at spawn,
  and `tack runtimes doctor` warns about it. The fix is `tack models sync`. If the
  login's model list can't be read, the check is skipped.

### Runtimes

```bash
tack runtimes                    # list status (same as `tack runtimes list`; alias `runtime`)
tack runtimes doctor             # resolve binaries, check pins + drift, check auth, check role models
tack runtimes pin claude 2.1.261 # write a version pin
tack runtimes install claude     # install a pinned version (or --all)
tack runtimes sync [runtime]     # re-pin pinned runtimes to what's installed now (adopt drift)
```

```ts
runtimes: {
  claude: { version: "2.1.261" },                                        // advisory pin
  codex: { bin: "~/.local/bin/codex", version: "0.147.0", versionPolicy: "strict" },
},
```

| Field | Notes |
| --- | --- |
| `bin` | A specific executable. Defaults to the runtime name on `PATH`. Tack never installs over a `bin` you set. |
| `version` | Checked against `<bin> --version` before runs. A pinned-but-missing version is installed into `~/.tack/runtimes/` by `tack init` or `tack runtimes install`. |
| `versionPolicy` | What a mismatch does: `"warn"` (default) logs once and continues, so a self-updating claude never blocks; `"strict"` fails the run; `"off"` skips the check. |

### Personas

```ts
personas: [
  { name: "adversarial", description: "Strict adversarial reviewer. Assume the change is wrong; find concrete correctness and security failures.", model: "opus-5" },
  { name: "implementation", description: "Review implementation correctness, edge cases and test coverage.", model: ["opus-5", "gpt-6.1-sol"] },
],
```

PRs open as drafts by default (`draftPrs: true`), even when `open_pr` requests a
ready PR. Set `draftPrs: false` to honor the tool's `draft` argument. With
`prWatch.enabled` and `prWatch.autoReady` (both default true), the watcher promotes
a draft once it is mergeable, no fix is busy, all feedback is handled with explicit
replies, and CI on the current head is settled with no failures. Clean PRs qualify
without a fix run; zero checks counts as green. Failed check fetches defer promotion.
Tack promotes each PR only once, respecting a human's later move back to draft.
Set `prWatch.autoReady: false` to keep readiness manual.

PR-watch handles review feedback, merge conflicts and failing CI checks on the PR
head. CI fixes wait for the suite to settle and include bounded failed-job logs for
GitHub Actions. Agents reproduce failures locally and fix PR code/tests; unrelated
flaky or infrastructure failures are reported without changes. Set `prWatch.fixCi: false`
to disable CI fixes (enabled by default); draft readiness still checks CI.

PR-watch answers inline review feedback inside its review thread. Replies to
conversation comments and review summaries are combined into one top-level comment
per fix run, linking and quoting each original and citing pushed fixes.
CI replies join that batch as links to failing checks without quoting logs. Human authors
are mentioned at most once; bots are never mentioned. Set `prWatch.reply: false` to
disable replies.

### Edit an agent's worktree

Run `tack session edit <session> [agent]` to open a worktree in `$VISUAL`,
then `$EDITOR`, falling back to `vim` (or `vi` when vim isn't installed). Omit the
agent id when only one worktree exists. Pending or running agents require `--force`;
`--print-path` prints just the path for use with other tools. After editing, Tack
reports the branch and Git status with a push hint when needed. It never commits or
pushes automatically.

### Manual workspaces

Run `tack session edit <session> --new [project]` to get a clean worktree of your
own for the session — a fresh `tack/<session>/<id>` branch forked from the
up-to-date remote default branch, separate from every agent — and land in your
editor rooted at it. Omit the project when it's unambiguous (the only configured
project, or the only one the session's agents use); otherwise Tack lists the
candidates. `--new --print-path` creates the workspace and prints its path without
opening an editor. Reopen it later like any worktree: `tack session edit <session> <id>`.

A manual workspace is a row with kind `manual`: it never runs, resumes or continues
as an agent conversation, and costs nothing. The supervisor sees it in
`check_agents`, includes it in `check_conflicts`, and opens it as a PR with `open_pr`
(committing your leftover edits) when you ask, or at wrap-up when it holds changes.

In `tack dashboard`, press `v` to open the agents picker, then `e` to edit the
highlighted agent's worktree, or `n` to create a manual workspace (choosing a
project first when several qualify; the session's projects are listed first).
Editing a pending or running agent requires `y` confirmation; manual workspaces
open directly. The picker shows worktree paths so you can see which tree will open.

`tack dashboard` defaults to a split view on terminals at least 140 columns wide:
work on the left, **Insights** on the right. Press `s` to cycle split → list-only →
full-screen Insights. Narrow terminals start with the list; `s` still opens Insights.
Press `[` / `]` to move through 7d, 30d, 90d, 1y, and all history (default: 30d).
The header shows the current layout, range, and live/working session counts.
Working supervisors show a cyan spinner and elapsed turn time in their session row;
a pending plan prompt shows `◆ needs input` instead. Existing session keys still work
in the list: `j/k`, `enter/o`, `v`, `m`, `O`, `p` (poll PRs), `J` (open the session's tickets), `t`, `P`, `c`, `C`, `r`, `w`, `x`, `a`, `d`, `z`, `q`.
Press `t` for every Jira ticket linked to any session, archived ones included
whatever `z` says (open work first, newest link first, then done), with each
ticket's session and its state. `f` cycles the status filter (all, open, in progress,
to do, done), `a` hides or shows archived sessions, and `/` filters by ticket key or
title and session id or title (`enter` keeps it, `esc` clears it). `enter/o` opens the
ticket, `g` jumps to its session (showing archived sessions if needed), `esc/q` goes
back. `P` polls Jira now instead of waiting for the 2-minute refresh: from the list it
polls the sessions shown, from the tickets view the sessions of the filtered tickets.
Press `w` (wake) on a session that stopped working after the laptop slept or lost
its connection: after `y`, Tack restarts its supervisor (even mid-turn or with a plan
pending, which is re-presented), relaunches agents whose runner died or that failed
with a connection error, restarts a dead PR watcher, and parks the supervisor in
tmux while the dashboard stays open; `enter` attaches. Without tmux the supervisor
stays stopped until you resume it.
Press `C` in any layout to edit the Tack config in `$VISUAL` / `$EDITOR` (fallback `vim`, else `vi`).
After a valid change, Tack reloads config and refreshes stale active sessions, parking
supervisors in tmux (without tmux, resume starts them). Busy sessions wait for resume
or `r`; invalid config keeps the previous dashboard config and leaves sessions running.
Press `a` to archive/unarchive and `z` to show archived sessions. Archiving is
immediate; unarchiving asks for confirmation and resumes only the agents archive
interrupted. Agents with a runtime session handle continue their conversation;
others start with their original prompt in the same worktree. A plain `x`/`stop`
does not mark agents for restoration. Unarchive leaves the supervisor for you to
rejoin with `enter/o` or `tack session resume <session>`.

Insights includes archived sessions regardless of the list's `z` filter. It shows
sessions, agents, PRs opened/merged, tickets linked/done, tokens, cost, changes against the
previous equal-length period, top repos, and a contribution heatmap. Full-screen
Insights adds a per-repo table, sorted by agent count. Daily/weekly/monthly buckets
adapt to range and width; dates use local time. PR creation means first linked to
a session, and ticket completion is approximated by its last status refresh.
Costs include supervisor and agent spend; repo costs include agents only.
A Models table shows sessions, agents (including PR-fix agents), tokens and cost
per stored model handle; missing models appear as "unknown". Tokens include input,
output, cache reads and cache writes for supervisors and agents. Usage and cost
follow each row's creation date. Historical supervisor tokens remain zero; new
headless usage overwrites with the runtime's latest run figure, like cost, while
interactive transcript recovery replaces both with cumulative figures. Tokens
and cost do not count toward the contributions heatmap. The table appears in
split and full-screen views when space permits.
Time charts use block heights (▁▂▃▄▅▆▇█, · for zero), shared scales for paired
series, full-word labels, totals and peaks when space allows, and dated axes.
Short series stretch across the chart. Heatmap shades (░▒▓█) have weekday/date
labels and a separate intensity legend; blank cells are outside the range.
Aligned KPIs show signed changes vs the previous period without relying on color.
Charts refresh every five seconds when their data changes; an idle dashboard does
not repaint.

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
bun install
bun run typecheck                 # tsc --noEmit; keep it green
bun test                          # unit tests under test/
bun run ./bin/tack.ts --help      # run from source without bun link

# Always use a throwaway state root so you never touch a real ~/.tack:
TACK_HOME=$(mktemp -d)/tack bun run ./bin/tack.ts init
```

Live runs cost money and change repos, so validate with `tack agent <project>
"<small task>"` before `tack session create`. See [SPEC.md](./SPEC.md) for the
design and [AGENTS.md](./AGENTS.md) for conventions and extension points (adding a
model, runtime, persona or supervisor tool).

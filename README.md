# Tack

Tack is a coding agent multiplexer. It allows you to easily manage multiple processes across different coding agents. You describe a problem, and a persistent planning agent (the **supervisor**) investigates your repos, proposes a plan, and, once you approve it, delegates units of work to **agents**. Agents are run via one of many runtimes (e.g. Claude Code, Codex, etc) and Tack shares all context of your problem between them.

Through its integrations with GitHub and JIRA, Tack will track your work end to end. It will even auto-fix your GitHub PRs once CI or code review results come in. Tack reimplements none of the agent loop. It shells out to each runtimes and inherits whatever they ship. See [SPEC.md](./SPEC.md) for the architecture and [AGENTS.md](./AGENTS.md) for the contributor guide.

Tack is built on top of tmux and vim to give a terminal native environment.

---

## Quickstart

### 1. Prerequisites

```bash
brew install oven-sh/bun/bun gh tmux
```

| Tool | Required? | What it enables |
| --- | --- | --- |
| [Bun](https://bun.sh) | **Required** | Runs Tack (no build step) and installs the runtimes. |
| `claude` / `codex` | Installed by Tack (step 4) | The supervisor (Claude) and agents (Codex by default). |
| [`gh`](https://cli.github.com) | Strongly recommended | Opening PRs, discovering them and PR watch. Without it, PR status never updates. |
| `tmux` | Recommended | Detaching from a live supervisor and reattaching later. |

### 2. Install Tack

Homebrew's bun doesn't add its global bin to PATH. Add it for `tack` and the
runtimes installed in step 4 (use `~/.bashrc` for bash):

```bash
echo 'export PATH="$(bun pm bin -g):$PATH"' >> ~/.zshrc
source ~/.zshrc
git clone git@github.com:ryanbahniuk/tack.git
cd tack
bun install
bun link        # links `tack` into bun's global bin
which tack
```

### 3. Create the config

```bash
cd ~ && tack init
```

This writes a starter config to `~/.tack/config.ts` (set `TACK_HOME` to use another
state root).

### 4. Install the runtimes

```bash
tack runtimes install
```

This installs the latest Claude Code and Codex CLIs and syncs Tack's models with them. It needs the config from step 3 (`tack init`).

### 5. Log in

```bash
claude             # type /login, then exit
codex login        # ChatGPT login or API key
gh auth login

tack models sync   # match the models to what your logins offer
```

Tack uses your existing logins and never manages credentials itself.

### 6. Add projects

```bash
tack projects add ~/Code/my-app   # add a repo by path
tack projects add --all           # or every git repo in the current directory
```

Re-running `tack init` inside a repo also registers it. The summary model writes each project's description for you.

### 7. Check your setup

```bash
tack runtimes doctor   # binaries, version pins, auth and role models in one check
```

### 8. Your first session

Open the dashboard, then press `c` to create a new session:

```bash
tack dashboard
```

Prefer the CLI? `tack` (same as `tack session create`) or `tack -m "…"` does the same.

**What to expect:**

1. Pressing `c` puts you in the supervisor's own interactive chat (Claude Code or Codex). Describe the problem you are trying to solve.
2. The supervisor reads Tack-owned snapshots of the relevant repos and proposes a plan. An **approval prompt** appears. If it doesn't, type `/approve` in the chat or run `tack session approve <session>`.
3. Agents spawn in their own worktrees. Detach with `prefix d` or exit the chat to get back to the dashboard. Agents show up in its Session → Agent → PR tree with cost and liveness. Press `enter` or `o` on a session to rejoin its supervisor.
4. When the work is done, the supervisor commits, pushes and opens **draft PRs**, one per unit of work, and a PR watch process takes over from there.

---

## Before your first session

- **This spends real money.** Every supervisor and agent run is billed to your runtime logins. You can see per-session cost in `tack dashboard` and `tack session list`.
- **Your own checkouts are never touched.** The supervisor investigates Tack-owned snapshot worktrees of each project's latest default branch, and each agent works in its own worktree.
- **PRs open without asking, by default.** With `autoOpenPrs: true`, the supervisor commits, pushes and opens draft PRs on its own. Set `autoOpenPrs: false` and it asks first, then confirms each PR before opening it.
- **PR watch acts on its own.** For every open PR it fixes review comments (bots included), failing CI and merge conflicts, pushes and replies on GitHub. Once a draft is addressed and green, it marks the PR ready to review. To turn this off, use these settings:
  - `prWatch.enabled: false`: no watcher at all.
  - `prWatch.fixCi: false`, `prWatch.reply: false`, `prWatch.autoPush: false` or
    `prWatch.autoReady: false`: turn off individual behaviours.
  - Per session: `tack session pr-fix <session> off`, dashboard `F`, or `/pr-fix off`.

---

## Recommended Chime setup

The supervisor runs with `--strict-mcp-config`, so it **does not inherit your global Claude plugins or MCP servers**. To let it read Jira and Confluence (for example, to open a ticket named in your problem), mount the Atlassian MCP server in `~/.tack/config.ts`. This needs `uvx` (`brew install uv`).

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

- **Auth:** Tack passes no tokens. The server inherits your environment and reuses the OAuth cache that the `chime-atlassian` plugin keeps at `~/.cache/chime-atlassian-mcp/`. Seed that cache once from an interactive client (the plugin, or an interactive Tack supervisor, which can answer the OAuth prompt). After that, headless runs reuse it. Never put tokens in `config.ts`.
- **Permissions:** a mounted server's tools are auto-allowed under the supervisor's read-only posture, including any write tools the server exposes. Only mount servers you're comfortable with it calling.
- **Tickets:** with `jira` set, the supervisor links the tickets a session works on. `tack dashboard` refreshes their status every 2 minutes (`P` polls now, `J` opens a session's tickets, `t` lists every session's tickets, archived included) and `tack session show` lists them. `cloudId` is optional and falls back to the server's `CONFLUENCE_CLOUD_ID`.
- **Existing PRs:** paste a GitHub PR URL (in one of your configured projects) into any message to the supervisor and Tack adopts it into the session automatically (`autoLinkPrs`, default on), telling the supervisor what it linked; the supervisor calls `link_pr` only for URLs that weren't auto-linked, and never opens a second PR; follow-up changes go onto that PR's branch via `fix_pr`. Like ticket linking it's local bookkeeping (read-only `gh` calls, never a write to GitHub). Feedback and failing CI that predate the link count as already handled; use `fix_pr` with `includeExisting: true` to address existing comments. The watcher never auto-promotes a linked draft, and fork or merged/closed PRs are refused. `unlink_pr` drops one linked by mistake; the dashboard tags linked PRs `linked`.

---

## Everyday use

### Dashboard

The dashboard is the primary way to drive Tack.

```bash
tack dashboard
```

The dashboard shows a live Session → Agent → PR tree with cost, liveness and PR and ticket status. On terminals at least 140 columns wide it opens in split view, with work on the left and **Insights** on the right.

| Key | Action |
| --- | --- |
| `j` / `k` | Move |
| `enter` / `o` | Open (rejoin) the selected session's supervisor |
| `c` | Create a new session |
| `v` | Agents picker: `enter`/`o`/`v` shows output (a live follow for running agents), `e` edits a worktree, `n` creates a manual workspace |
| `m` | View pending amendments (read-only) |
| `O` | Open the session's PRs in the browser |
| `J` | Open the session's Jira tickets in the browser |
| `t` | Tickets view: every Jira ticket linked to any session, archived ones included whatever `z` says (open work first, newest link first), with its session and state. `f` cycles the status filter (all, open, in progress, to do, done), `a` hides or shows archived sessions, `/` filters by ticket key or title and session id or title (`enter` keeps it, `esc` clears it). `enter`/`o` opens a ticket, `g` jumps to its session (showing archived sessions if needed), `esc`/`q` goes back |
| `p` | Poll PRs now |
| `P` | Poll Jira now instead of waiting for the 2-minute refresh: from the list for the sessions shown, from the tickets view for the sessions of the filtered tickets |
| `R` | Start a persona review |
| `F` | Toggle PR auto-fix for the session |
| `r` | Restart a session when it is `stale` or broken after sleep or network loss. Restarts the supervisor (parked in tmux; `enter` attaches), revives dropped agents, and restarts a dead or stale PR watcher (asks first) |
| `x` | Stop (asks first) |
| `a` | Archive, or unarchive (asks first) |
| `h` | Toggle hold; on-hold sessions remain visible below other sessions and keep running |
| `d` | Delete (asks first) |
| `z` | Show or hide archived sessions |
| `C` | Edit the Tack config, then reload it and refresh stale sessions |
| `s` | Cycle layout: split → list-only → full-screen Insights |
| `[` / `]` | Insights range: 7d · 30d (default) · 90d · 1y · all |
| `q` | Quit |

Working supervisors show a spinner and elapsed turn time, a pending plan shows `◆ needs input`, and sessions running older Tack code are marked `stale` (press `r` to restart).

<details>
<summary>Insights details</summary>

Insights covers archived sessions regardless of the `z` filter. It shows sessions, agents, PRs opened and merged, tickets linked and done, tokens and cost, each with the change against the previous equal-length period. It also shows top repos, a contribution heatmap and a Models table (sessions, agents including PR-fix agents, tokens and cost per model; missing models appear as "unknown"). Full-screen Insights adds a per-repo table sorted by agent count.

- Buckets (daily, weekly or monthly) adapt to the range and terminal width, and dates use local time.
- "PR opened" means the PR was first linked to a session. "Ticket done" is approximated by its last status refresh.
- Costs include supervisor and agent spend; repo costs include agents only.
- Tokens include input, output, cache reads and cache writes, and follow each row's creation date. Historical supervisor tokens stay zero. New headless usage overwrites with the runtime's latest-run figure; interactive transcript recovery replaces both with cumulative figures. Tokens and cost don't count toward the heatmap.
- Charts use block heights (`▁▂▃▄▅▆▇█`, `·` for zero) with shared scales for paired series. Heatmap shades (`░▒▓█`) have their own legend, and blank cells fall outside the range. KPIs show signed changes without relying on colour.
- Charts refresh every five seconds when their data changes. An idle dashboard doesn't repaint.

</details>

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
| `tack session readme <session> [--no-publish] [--open]` | Generate a session README page; optionally keep it local or open it. |
| `tack session retitle <session>` | Regenerate the title with the summary model. |
| `tack session restart <session> \| --all` | Get a session healthy and current after a Tack update (`stale`), sleep, or a lost connection: restart the supervisor (even mid-turn; a pending plan is re-presented), revive dropped agents, restart a dead or stale PR watcher, then park the supervisor detached in tmux and hand the terminal back (attach with `resume`). Without tmux the supervisor stays stopped until `tack session resume`. `--all` covers every active session. `refresh` and `reconnect` remain available as deprecated aliases. |
| `tack session stop <session>` | Stop the session and its agents. |
| `tack session hold <session>` / `unhold <session>` | Organize a session on hold or return it to active without stopping work. |
| `tack session archive <session>` | Stop and hide it, remembering which agents were interrupted. |
| `tack session unarchive <session>` | Restore it and resume the interrupted agents (then rejoin with `resume`). |
| `tack session delete <session>` | Kill processes and purge worktrees, artifacts and DB rows. This can't be undone. |

`tack session resume` refreshes stale Tack processes automatically when the session
is idle. Dashboard config saves also refresh idle stale processes; without tmux,
replacement supervisors stay stopped until you resume them.

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
- **Agent reuse.** With `agentReuse.enabled`, later fixes on a PR reuse its existing
  fix agent — same agent id, same conversation and worktree — when its last run
  succeeded, finished within `maxIdleHours` on the same runtime, and its worktree
  fast-forwards to the PR head. Otherwise a new fix agent continues the PR's last
  successful conversation (the fix agent's or the PR author's) when it qualifies,
  or starts fresh. The daily cap counts runs, so reuse doesn't get around it.
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
  autoLinkPrs: true,
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
| `autoLinkPrs` | `true` | Adopt GitHub PR URLs from your messages into the session automatically; `false` leaves it to the supervisor's `link_pr`. |
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
| `name` | yes | Shown in the dashboard and used by the supervisor. |
| `path` | yes | `~` is expanded. |
| `description` | yes | **This field is load-bearing.** The supervisor uses it to choose which repos to snapshot *before* reading any code. |
| `metadata` | no | `{ language, frameworks[] }`, used to route on tech stack. |

`projects add` and `projects refresh` have the summary model write `description`
and `metadata` for you. `tack session create` also auto-registers the current git
repo if it isn't configured yet.

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
tack runtimes install [runtime]  # install claude + codex (or one), then sync models (--no-models skips)
tack runtimes pin claude 2.1.261 # write a version pin
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
| `bin` | A specific executable. Defaults to the runtime name on `PATH`. Tack never installs over a `bin` you set; `runtimes install` only verifies it. |
| `version` | Checked against `<bin> --version` before runs. Without a pin, `tack runtimes install` installs or upgrades the latest release globally (`bun add -g`). With one, it installs that version into `~/.tack/runtimes/` instead, as `tack init` does. |
| `versionPolicy` | What a mismatch does: `"warn"` (default) logs once and continues, so a self-updating claude never blocks; `"strict"` fails the run; `"off"` skips the check. |

### Personas

```ts
personas: [
  { name: "adversarial", description: "Strict adversarial reviewer. Assume the change is wrong; find concrete correctness and security failures.", model: "opus-5" },
  { name: "implementation", description: "Review implementation correctness, edge cases and test coverage.", model: ["opus-5", "gpt-6.1-sol"] },
],
```

`name` must be unique, and `description` holds the reviewer's instructions. `model`
is optional (a key or a list) and defaults to `roles.agent`. Reviews prefer a model
different from the author's when one is available.

### PR watch and PR settings

| Key | Default | Notes |
| --- | --- | --- |
| `prWatch.enabled` | `true` | `false` means a watcher never starts. |
| `prWatch.intervalSeconds` | `300` | Poll cadence for the watcher and the dashboard's PR refresh (min 60). |
| `prWatch.autoReady` | `true` | Promote drafts once feedback is addressed and CI is green. |
| `prWatch.autoPush` | `true` | Push fix commits (never force). |
| `prWatch.reply` | `true` | Reply on GitHub to each handled comment. |
| `prWatch.fixCi` | `true` | Also fix failing CI. Draft readiness still checks CI when this is `false`. |
| `prWatch.maxFixRunsPerDay` | `5` | Cap on automatic fix runs per PR per rolling 24h. |
| `agentReuse.enabled` / `maxIdleHours` | `true` / `24` | Reuse the PR's last agent conversation for fixes. |
| `autoOpenPrs` | `true` | See [Before your first session](#before-your-first-session). |
| `autoLinkPrs` | `true` | Auto-link PR URLs pasted into supervisor messages (read-only `gh`). |
| `draftPrs` | `true` | Force drafts. |

### `readAllowlist`, `supervisorMcpServers`, `jira`

- `readAllowlist: ["~/Code/shared-docs"]` gives the supervisor extra read-only
  directories.
- `supervisorMcpServers` entries take `{ name, command, args?, env? }`. These
  servers are mounted for the supervisor only; agents don't get them.
- `jira` takes `{ mcpServer, siteUrl, cloudId? }`. `mcpServer` names one of
  `supervisorMcpServers`, and `siteUrl` builds `<siteUrl>/browse/<KEY>` links.

See [Recommended Chime setup](#recommended-chime-setup) for a working example.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No plan approval prompt appears | Type `/approve` in the supervisor chat, or run `tack session approve <session>`. |
| Agent fails with `model_not_found`, or doctor warns that a model isn't offered | `tack models sync` (re-pins roles to models your login offers). |
| Agents fail because `codex` isn't installed | `tack runtimes install codex` and `codex login`, or `tack roles set agent opus-5`. |
| A runtime is outdated or `not found` | `tack runtimes install [runtime]` installs or upgrades it to the latest. A pinned runtime gets its pin. |
| `tack: command not found` after `bun link` (or `claude`/`codex` not found after `runtimes install`) | Add bun's global bin (`bun pm bin -g`) to PATH as in step 2. |
| `runtimes install` warns that PATH resolves elsewhere | Another copy (e.g. a native installer's `~/.local/bin/claude`) shadows bun's. Put bun's global bin (`bun pm bin -g`) earlier on PATH, or remove the other copy. |
| Version drift warning | `tack runtimes doctor` to see it; `tack runtimes sync` to adopt the installed version, or `tack runtimes install <runtime>` to restore the pin. |
| `mismatch` / run stops on version | That runtime has `versionPolicy: "strict"`. Sync, install the pin or relax the policy. |
| Auth failures mid-run | `tack runtimes doctor` shows auth state; run `claude` (then `/login`) or `codex login`, then `tack models sync`. |
| PRs aren't discovered and the dashboard says `gh not found` | Install `gh` and run `gh auth login`. |
| PRs look stale | `tack session poll-prs <session>` or dashboard `p`. |
| Session seems stuck or its supervisor exited | `tack session resume <session>`. |
| Session or agents died after the laptop slept or the network dropped | `tack session restart <session>` (or `--all`), or dashboard `r`. |
| `stale` badge after updating Tack | `tack session restart <session>` (or `--all`), or dashboard `r`. |
| `jira unavailable` in the dashboard | Check that the `supervisorMcpServers` entry runs (`uvx` on PATH) and its OAuth cache is seeded. |
| `J` says no Jira site is configured | Add a `jira` block with `siteUrl`. |
| `Config has errors` | `tack config edit`; the message names the failing key. |
| Detached and lost the supervisor | `tack session list`, then `tack session resume <session>`. |
| Editor won't open | Set `$VISUAL` or `$EDITOR`. |

---

## Development

```bash
bun install
bun run typecheck                 # tsc --noEmit; keep it green
bun test                          # unit tests under test/
bun run ./bin/tack.ts --help      # run from source without bun link

# Always use a throwaway state root so you never touch a real ~/.tack:
export TACK_HOME=$(mktemp -d)/tack
bun run ./bin/tack.ts init
```

Live runs cost money and change repos. Validate a change with a small session
first, such as `bun run ./bin/tack.ts -m "<small task>"` against that throwaway
`TACK_HOME`. See [SPEC.md](./SPEC.md) for the
design and [AGENTS.md](./AGENTS.md) for conventions and extension points (adding a
model, runtime, persona or supervisor tool).

Session worktrees can run configured applications with `tack session boot <session>`;
use `tack session boot-status <session>` to inspect them and `tack session unboot
<session>` to stop them. Define reusable `bootRecipes` and reference them from
project `boot` settings; see SPEC.md §11 for details.


Session READMEs are generated only when requested with `tack session readme` or the dashboard `D` key (after confirmation). `roles.readme` accepts a model key or non-empty list and defaults to `roles.supervisor`. Set `readme: { publisher: "local" }` to save locally, or `"claude-artifact"` to publish; the default uses Claude Artifact when Claude is configured or available, otherwise local. Publishing sends session information from the digest, including the contract, PR bodies and agent output excerpts, to claude.ai as a private artifact. Use `--no-publish` to keep the page local.

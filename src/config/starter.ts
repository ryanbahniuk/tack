/** The config scaffold written by `tack init`. Kept as a template string so the
 * generated file is a clean, user-editable TS module. */
export const STARTER_CONFIG = `// Tack config. \`roles\` pins each function to a model by \`key\`; \`models\` maps a
// model key to its provider/name/version, runtime (claude | codex), and the id
// passed to that CLI. Codex models must carry \`pricing\` (USD per 1M tokens) to
// get a cost, since Codex reports tokens only. Claude reports cost directly and
// ignores pricing.
export default ({
  projects: [
    // { name: "my-app", path: "~/Code/my-app", description: "What this repo is." },
  ],

  // Background refresh of project default branches.
  baseCache: { enabled: true, intervalSeconds: 120, maxAgeSeconds: 600 },

  models: [
    { key: "opus-5", provider: "anthropic", name: "Opus", version: "5", runtime: "claude", id: "claude-opus-5", effort: "high" },
    { key: "sonnet-5", provider: "anthropic", name: "Sonnet", version: "5", runtime: "claude", id: "claude-sonnet-5" },
    {
      key: "gpt-6.1-sol",
      provider: "openai",
      name: "GPT-6.1 Sol",
      version: "6.1",
      runtime: "codex",
      id: "gpt-6.1-sol",
      effort: "medium",
      // UNVERIFIED placeholder rates — run \`tack models sync\` to fill from models.dev
      pricing: { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.4, cacheWritePer1M: 5 },
    },
  ],

  // Roles accept one key or a non-empty list, e.g. agent: ["gpt-6.1-sol", "opus-5"].
  // Multiple distinct keys mean a uniform random pick per use; supervisor picks
  // persist for the session (including resume), worker picks for the agent.
  // Summary calls pick each time; a single key always uses that model.
  roles: {
    supervisor: "opus-5",
    agent: "gpt-6.1-sol",
    summary: "sonnet-5",
  },

  // Personas have a unique name and description (review instructions). Humans
  // explicitly request reviews. Optional model accepts a key or non-empty
  // list; omitted uses roles.agent. Reviews prefer a different model than the
  // author when a candidate is available, otherwise use the same model.
  // personas: [
  //   { name: "adversarial", description: "Strict adversarial reviewer. Assume the change is wrong; find concrete correctness and security failures.", model: "opus-5" },
  //   { name: "implementation", description: "Review implementation correctness, edge cases and test coverage with an independent perspective.", model: ["opus-5", "gpt-6.1-sol"] },
  //   { name: "design-standards", description: "Review user-facing changes against the project's design standards, accessibility and interaction conventions." },
  // ],

  // Pin the CLI runtimes. \`bin\` points at a specific executable (defaults to the
  // runtime name on PATH); \`version\` is checked against \`<bin> --version\` before any
  // run. \`versionPolicy\` decides what a mismatch does: "warn" (default) logs once and
  // continues — so a self-updating CLI like claude never blocks a run; "strict" turns
  // it back into a hard failure for reproducible setups; "off" skips the check.
  // Pin with \`tack runtimes pin <runtime> <version>\`; \`tack runtimes sync\` re-pins to
  // whatever's installed now. \`tack runtimes install\` installs/upgrades an unpinned
  // runtime to its latest release (\`bun add -g\`), fetches a pinned one into
  // ~/.tack/runtimes/ (as \`tack init\` also does), never installs over a \`bin\`, then
  // syncs models; \`tack runtimes doctor\` reports resolution and drift without changing anything.
  runtimes: {
    // claude: { version: "2.1.261" },                                  // advisory pin (warn on drift)
    // codex: { bin: "~/.local/bin/codex", version: "0.147.0", versionPolicy: "strict" },
  },

  readAllowlist: [],

  // Extra MCP servers mounted for the SUPERVISOR only, on top of Tack's own tools.
  // The supervisor inherits none of your global/plugin MCP config, so add a server
  // here when it must read an external source to plan — e.g. a JIRA/Atlassian server
  // so it can open a ticket named in the problem. Copy the block verbatim from the
  // tool's own .mcp.json. Mounted tools are auto-allowed under the read-only posture,
  // so only add servers you're fine with it calling (including any write tools).
  //
  // AUTH: Tack launches these servers as subprocesses that inherit your environment
  // ($HOME, $PATH, …) — it passes no tokens. A server that caches its own credentials
  // in a user-global file therefore authenticates identically no matter who launches
  // it. The example below mirrors Chime's chime-atlassian plugin: the proxy caches
  // OAuth tokens at ~/.cache/chime-atlassian-mcp/atlassian-mcp-tokens.json and
  // auto-refreshes them, so the supervisor rides the SAME cache as your normal Claude
  // session. Seed it once from an interactive client (the plugin, or an interactive
  // tack supervisor, which can answer the OAuth elicitation prompt); headless
  // supervisor runs then reuse the cached refresh token. Requires uvx on PATH (brew
  // install uv).
  supervisorMcpServers: [
    // {
    //   name: "Atlassian",
    //   command: "uvx",
    //   args: ["--refresh", "--from", "git+ssh://git@github.com/1debit/chime-atlassian-mcp@main", "chime-atlassian-mcp"],
    //   env: { CONFLUENCE_CLOUD_ID: "a40b7113-0103-4597-b693-76b66e0a4614", CONFLUENCE_SITE_URL: "https://chime.atlassian.net" },
    // },
  ],

  // PR watch: every session with open PRs polls them in the background. New review
  // comments (bots included), failing CI or a merge conflict spawn a fix agent (roles.agent) that
  // fixes what's warranted — or merges the base branch to resolve the conflict — and
  // then Tack pushes (never force) and replies to each comment explaining what it did.
  // \`maxFixRunsPerDay\` caps automatic (watcher) fix runs per PR per rolling 24h;
  // supervisor fix_pr runs are exempt. All fields optional.
  // Continue eligible PR conversations in their existing worktree.
  agentReuse: { enabled: true, maxIdleHours: 24 },

  prWatch: {
    // enabled: true,          // false = never start a watcher
    // intervalSeconds: 300,   // PR poll cadence for the watcher and tack dashboard (min 60)
    // autoReady: true,        // promote drafts once comments are addressed and CI is green
    // autoPush: true,         // push fix commits to the PR branch
    // reply: true,            // post a reply on each handled comment
    // fixCi: true, // also fix failing CI checks on the PR head
    // maxFixRunsPerDay: 5,
  },

  // When the work is done, the supervisor commits and opens one PR per unit of work
  // in every affected repo without asking (you still review and merge each). Set to
  // false to have it ask first and confirm each PR before it's opened.
  autoOpenPrs: true,
  // Force drafts even if open_pr requests ready; PR watch promotes when ready.
  draftPrs: true,

  // Optional session JIRA ticket tracking (track-only — Tack never creates, edits,
  // or transitions tickets). The supervisor links the tickets a session works on;
  // \`tack dashboard\` refreshes their status read-only through the server named by
  // \`mcpServer\` (one of supervisorMcpServers above, reusing its cached auth), and
  // \`siteUrl\` builds the browse links. \`cloudId\` is optional: it falls back to
  // that server's CONFLUENCE_CLOUD_ID env, then to asking the server.
  // jira: { mcpServer: "Atlassian", siteUrl: "https://chime.atlassian.net" },
});
`;


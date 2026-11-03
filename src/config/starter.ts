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

  models: [
    { key: "opus-5", provider: "anthropic", name: "Opus", version: "5", runtime: "claude", id: "claude-opus-5", effort: "high" },
    { key: "sonnet-5", provider: "anthropic", name: "Sonnet", version: "5", runtime: "claude", id: "claude-sonnet-5" },
    {
      key: "gpt-5.6-sol",
      provider: "openai",
      name: "GPT-5.6 Sol",
      version: "5.6",
      runtime: "codex",
      id: "gpt-5.6-sol",
      effort: "medium",
      pricing: { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.4, cacheWritePer1M: 5 },
    },
  ],

  roles: {
    supervisor: "opus-5",
    agent: "gpt-5.6-sol",
    summary: "sonnet-5",
  },

  // Pin the CLI runtimes. \`bin\` points at a specific executable (defaults to the
  // runtime name on PATH); \`version\` is checked against \`<bin> --version\` before any
  // run. \`versionPolicy\` decides what a mismatch does: "warn" (default) logs once and
  // continues — so a self-updating CLI like claude never blocks a run; "strict" turns
  // it back into a hard failure for reproducible setups; "off" skips the check.
  // Pin with \`tack runtimes pin <runtime> <version>\`; \`tack runtimes sync\` re-pins to
  // whatever's installed now. A pinned-but-missing version is fetched into
  // ~/.tack/runtimes/ by \`tack init\` / \`tack runtimes install\`; \`tack runtimes doctor\`
  // reports resolution and drift without changing anything.
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

  // When the work is done, the supervisor commits and opens one PR per unit of work
  // in every affected repo without asking (you still review and merge each). Set to
  // false to have it ask first and confirm each PR before it's opened.
  autoOpenPrs: true,
});
`;


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
});
`;


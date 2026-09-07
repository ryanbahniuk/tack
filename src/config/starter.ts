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
    { key: "opus", provider: "anthropic", name: "Opus", version: "5", runtime: "claude", id: "opus", effort: "high" },
    { key: "sonnet", provider: "anthropic", name: "Sonnet", version: "5", runtime: "claude", id: "sonnet" },
    {
      key: "gpt-5-codex",
      provider: "openai",
      name: "GPT-5 Codex",
      version: "5",
      runtime: "codex",
      id: "gpt-5-codex",
      effort: "medium",
      pricing: { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.125 },
    },
  ],

  roles: {
    supervisor: "opus",
    agent: "gpt-5-codex",
    summary: "sonnet",
  },

  // Pin the CLI runtimes. \`bin\` points at a specific executable (defaults to the
  // runtime name on PATH); \`version\` is verified against \`<bin> --version\` before
  // any run, so an unexpected CLI upgrade fails loudly. Pin from the CLI with
  // \`tack runtimes pin <runtime> <version>\`; when a pinned version isn't installed,
  // \`tack init\` / \`tack runtimes install\` fetch it into ~/.tack/runtimes/.
  // \`tack runtimes doctor\` reports resolution without changing anything.
  runtimes: {
    // claude: { version: "2.1.261" },
    // codex: { bin: "~/.local/bin/codex", version: "0.147.0" },
  },

  readAllowlist: [],
});
`;


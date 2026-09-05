/** The config scaffold written by `tack init`. Kept as a template string so the
 * generated file is a clean, user-editable TS module. */
export const STARTER_CONFIG = `// Tack config. \`roles\` pins each function to a model by name; \`models\` maps a
// model name to its runtime (claude | codex) and the id passed to that CLI.
// Codex models must carry \`pricing\` (USD per 1M tokens) to get a cost, since
// Codex reports tokens only. Claude reports cost directly and ignores pricing.
export default ({
  projects: [
    // { name: "my-app", path: "~/Code/my-app", description: "What this repo is." },
  ],

  models: [
    { name: "opus", runtime: "claude", id: "opus", effort: "high" },
    { name: "sonnet", runtime: "claude", id: "sonnet" },
    {
      name: "gpt-5-codex",
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
  // any run, so an unexpected CLI upgrade fails loudly. When a pinned version isn't
  // installed, \`tack init\` / \`tack install\` fetch it into ~/.tack/runtimes/.
  // \`tack doctor\` reports resolution without changing anything.
  runtimes: {
    // claude: { version: "2.1.261" },
    // codex: { bin: "~/.local/bin/codex", version: "0.147.0" },
  },

  readAllowlist: [],
});
`;


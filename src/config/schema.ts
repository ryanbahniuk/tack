import { z } from "zod";

/**
 * A runtime is the coding CLI Tack drives as a subprocess. Every model belongs to
 * exactly one runtime. Bedrock (for open-weight models) is intentionally absent
 * until Chime approves it — when it lands it becomes a third runtime here.
 */
export const RuntimeKind = z.enum(["claude", "codex"]);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

/**
 * Structured facts about a repo's tech stack, auto-filled by the summary model
 * alongside `description`. Kept separate from the prose description so the
 * supervisor can route on stack (`language`, `frameworks`) as well as purpose.
 */
export const ProjectMetadataSchema = z.object({
  /** The primary programming language the repo is written in, e.g. "TypeScript". */
  language: z.string().min(1),
  /** The 5-10 most prominent frameworks/libraries/tools used in the repo. */
  frameworks: z.array(z.string()).default([]),
});
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

export const ProjectSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  /** Load-bearing: the supervisor reasons over this to pick relevant repos. */
  description: z.string().min(1),
  /** Auto-filled tech-stack facts; optional so hand-authored configs stay valid. */
  metadata: ProjectMetadataSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Optional pricing in USD per 1M tokens, used to compute cost when the runtime
 * doesn't report a dollar figure. The `codex` runtime reports tokens only, so its
 * models MUST carry pricing to get a cost; the `claude` runtime reports
 * `total_cost_usd` directly and ignores this.
 */
export const PricingSchema = z.object({
  inputPer1M: z.number().nonnegative().optional(),
  outputPer1M: z.number().nonnegative().optional(),
  cacheReadPer1M: z.number().nonnegative().optional(),
  cacheWritePer1M: z.number().nonnegative().optional(),
});
export type Pricing = z.infer<typeof PricingSchema>;

/**
 * A model available to Tack. `key` is the stable handle referenced by roles, and
 * is version-qualified (e.g. `opus-5`) so multiple versions of one model coexist;
 * `provider`/`name`/`version` describe the model (e.g. "anthropic" / "Opus" / "5");
 * `id` is what we pass to the CLI (`claude --model <id>` / `codex exec -m <id>`).
 * `effort` maps to `--effort` (claude) / `-c model_reasoning_effort=` (codex).
 */
export const ModelSchema = z.object({
  key: z.string().min(1),
  provider: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  runtime: RuntimeKind,
  id: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  pricing: PricingSchema.optional(),
});
export type Model = z.infer<typeof ModelSchema>;

/**
 * Every functional role is pinned to a model by name. `supervisor` plans and
 * coordinates; `agent` is the default worker; `summary` is a cheap model for
 * chores like auto-describing a project from its README. All required so a
 * misconfiguration fails loudly at load rather than mid-run.
 */
export const RolesSchema = z.object({
  supervisor: z.string().min(1),
  agent: z.string().min(1),
  summary: z.string().min(1),
});
export type Roles = z.infer<typeof RolesSchema>;

/**
 * How Tack reacts when a runtime's installed `--version` doesn't satisfy its
 * `version` pin. Self-updating CLIs (claude updates itself in the background) drift
 * from an exact pin constantly, so a hard failure is hostile by default:
 *  - `"warn"` (default): log one notice and keep going — the pin is advisory.
 *  - `"strict"`: a mismatch throws, stopping the run. For reproducible setups where
 *    an unexpected CLI upgrade must not silently change behavior.
 *  - `"off"`: don't check the version at all.
 * Lives here (not in code) so the choice is per-runtime and every runtime inherits it.
 */
export const VersionPolicy = z.enum(["warn", "strict", "off"]);
export type VersionPolicy = z.infer<typeof VersionPolicy>;

/**
 * Per-runtime binary + version pin. `bin` points Tack at a specific CLI
 * executable (defaults to the runtime name on PATH); `version` is checked against
 * the binary's `--version` before any run, with `versionPolicy` deciding how a
 * mismatch is handled (default `"warn"` — advisory, not fatal).
 */
export const RuntimeSettingsSchema = z.object({
  bin: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  versionPolicy: VersionPolicy.optional(),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

export const RuntimesSchema = z
  .object({
    claude: RuntimeSettingsSchema.optional(),
    codex: RuntimeSettingsSchema.optional(),
  })
  .default({});
export type Runtimes = z.infer<typeof RuntimesSchema>;

/**
 * An extra MCP server to mount for the supervisor, beyond Tack's own tool server.
 * The supervisor runs with `--strict-mcp-config`, so it sees ONLY Tack's servers
 * plus whatever is listed here — it never inherits the user's global or plugin MCP
 * config from the filesystem. Use this to give the supervisor read access to an
 * external source it must reason over (e.g. a JIRA/Atlassian MCP server so it can
 * open a ticket named in the problem). `env` passes credentials/settings through to
 * the server process. NOTE: a mounted server's tools are auto-allowed under the
 * supervisor's read-only posture, so only mount servers whose use you accept —
 * including any write tools they expose.
 */
export const McpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/**
 * Session-scoped JIRA ticket tracking (track-only: Tack never writes to Jira). Tack
 * reads ticket title/status by acting as an MCP *client* of one of the
 * `supervisorMcpServers` — `mcpServer` names that entry — so it reuses whatever auth
 * that server already caches and never handles a token itself. `siteUrl` builds the
 * browse links (`<siteUrl>/browse/<KEY>`). `cloudId` is the Atlassian site id the
 * server's tools need; when omitted it falls back to the server's
 * `env.CONFLUENCE_CLOUD_ID`, then to asking the server
 * (`getAccessibleAtlassianResources`).
 */
export const JiraConfigSchema = z.object({
  mcpServer: z.string().min(1),
  siteUrl: z.string().min(1),
  cloudId: z.string().min(1).optional(),
});
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export const ConfigSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  models: z.array(ModelSchema).default([]),
  roles: RolesSchema,
  /** Per-runtime binary path + pinned version. */
  runtimes: RuntimesSchema,
  /** Extra read-only paths the supervisor may investigate beyond project roots. */
  readAllowlist: z.array(z.string()).default([]),
  /** Extra MCP servers mounted for the supervisor only (see `McpServerSchema`). */
  supervisorMcpServers: z.array(McpServerSchema).default([]),
  /**
   * When the session's work is done, the supervisor commits and opens one PR per
   * unit of work in every affected repo on its own (default) — the N reviewable PRs
   * are the deliverable, and a human still reviews and merges each. Set `false` to
   * put PR opening back behind the human: the supervisor asks first, and each
   * `open_pr` call raises a per-call confirmation in attended sessions.
   */
  autoOpenPrs: z.boolean().default(true),
  /** Optional JIRA ticket tracking via one of `supervisorMcpServers` (see `JiraConfigSchema`). */
  jira: JiraConfigSchema.optional(),
});

/** Shape accepted from a user's config file. */
export type TackConfigInput = z.input<typeof ConfigSchema>;

/** Fully resolved config used throughout the app (paths home-expanded). */
export interface TackConfig {
  projects: Project[];
  models: Model[];
  roles: Roles;
  runtimes: Runtimes;
  readAllowlist: string[];
  supervisorMcpServers: McpServer[];
  autoOpenPrs: boolean;
  jira?: JiraConfig;
}

/** Identity helper for config authoring: `export default defineConfig({...})`. */
export function defineConfig(input: TackConfigInput): TackConfigInput {
  return input;
}

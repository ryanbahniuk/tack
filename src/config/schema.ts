import { z } from "zod";

/**
 * A runtime is the coding CLI Tack drives as a subprocess. Every model belongs to
 * exactly one runtime. Bedrock (for open-weight models) is intentionally absent
 * until Chime approves it — when it lands it becomes a third runtime here.
 */
export const RuntimeKind = z.enum(["claude", "codex"]);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

export const ProjectSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  /** Load-bearing: the supervisor reasons over this to pick relevant repos. */
  description: z.string().min(1),
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
 * A model available to Tack. `name` is the stable handle referenced by roles;
 * `id` is what we pass to the CLI (`claude --model <id>` / `codex exec -m <id>`).
 * `effort` maps to `--effort` (claude) / `-c model_reasoning_effort=` (codex).
 */
export const ModelSchema = z.object({
  name: z.string().min(1),
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
 * Per-runtime binary + version pin. `bin` points Tack at a specific CLI
 * executable (defaults to the runtime name on PATH); `version` is verified against
 * the binary's `--version` before any run, so an unexpected CLI upgrade fails
 * loudly instead of silently changing behavior mid-project.
 */
export const RuntimeSettingsSchema = z.object({
  bin: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

export const RuntimesSchema = z
  .object({
    claude: RuntimeSettingsSchema.optional(),
    codex: RuntimeSettingsSchema.optional(),
  })
  .default({});
export type Runtimes = z.infer<typeof RuntimesSchema>;

export const ConfigSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  models: z.array(ModelSchema).default([]),
  roles: RolesSchema,
  /** Per-runtime binary path + pinned version. */
  runtimes: RuntimesSchema,
  /** Extra read-only paths the supervisor may investigate beyond project roots. */
  readAllowlist: z.array(z.string()).default([]),
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
}

/** Identity helper for config authoring: `export default defineConfig({...})`. */
export function defineConfig(input: TackConfigInput): TackConfigInput {
  return input;
}

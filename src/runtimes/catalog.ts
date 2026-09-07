import type { Model, RuntimeKind } from "../config/schema";

/**
 * The models each runtime CLI offers, keyed by runtime. Neither CLI exposes a
 * machine-readable "list models" command, so `tack models refresh` seeds the
 * config from this curated catalog — adding entries for whichever runtimes are
 * actually connected (resolve to a working binary). Keep it current as the CLIs
 * gain models; a model here is just a starting point the user can edit in place.
 *
 * `key` is the stable handle roles pin to. Claude reports `total_cost_usd`
 * directly, so its entries carry no `pricing`; Codex reports tokens only, so its
 * entries MUST carry `pricing` (USD per 1M tokens) to yield a cost (SPEC §5).
 */
export const MODEL_CATALOG: Record<RuntimeKind, Model[]> = {
  claude: [
    { key: "opus", provider: "anthropic", name: "Opus", version: "5", runtime: "claude", id: "opus", effort: "high" },
    { key: "sonnet", provider: "anthropic", name: "Sonnet", version: "5", runtime: "claude", id: "sonnet" },
    { key: "haiku", provider: "anthropic", name: "Haiku", version: "4.5", runtime: "claude", id: "haiku" },
    { key: "fable", provider: "anthropic", name: "Fable", version: "5", runtime: "claude", id: "fable" },
  ],
  codex: [
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
};

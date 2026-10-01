import type { Model, Pricing, RuntimeKind } from "../config/schema";

/**
 * The models each runtime CLI offers, keyed by runtime. Neither CLI exposes a
 * machine-readable "list models" command, so `tack models refresh` seeds the
 * config from this curated catalog — adding entries for whichever runtimes are
 * actually connected (resolve to a working binary). Keep it current as the CLIs
 * gain models; a model here is just a starting point the user can edit in place.
 *
 * `key` is the stable handle roles pin to, and is version-qualified (e.g.
 * `opus-5`) so multiple versions of the same model coexist as distinct keys. `id`
 * is the model's full versioned name (`claude-opus-5`), NOT a floating alias like
 * `opus` — an alias resolves to whatever the CLI currently calls latest (today
 * `opus` is Opus 4.8, not 5), which would defeat a version-pinned key.
 *
 * Codex reports tokens only, so its entries MUST carry `pricing` (USD per 1M
 * tokens) to yield a cost (SPEC §5) — `tack models sync-pricing` can fill these from
 * models.dev instead of hand-maintaining them. Claude headless reports `total_cost_usd`
 * directly, so pricing is not needed there — but interactive claude sessions emit
 * no cost, so we carry ESTIMATED pricing here purely as the fallback used to
 * recover an interactive session's cost from its transcript tokens. Edit these to
 * match current Anthropic rates; they don't affect headless cost.
 */
export const MODEL_CATALOG: Record<RuntimeKind, Model[]> = {
  claude: [
    { key: "opus-5", provider: "anthropic", name: "Opus", version: "5", runtime: "claude", id: "claude-opus-5", effort: "high", pricing: { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 } },
    { key: "opus-4.8", provider: "anthropic", name: "Opus", version: "4.8", runtime: "claude", id: "claude-opus-4-8", effort: "high", pricing: { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 } },
    { key: "sonnet-5", provider: "anthropic", name: "Sonnet", version: "5", runtime: "claude", id: "claude-sonnet-5", pricing: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 } },
    { key: "haiku-4.5", provider: "anthropic", name: "Haiku", version: "4.5", runtime: "claude", id: "claude-haiku-4-5", pricing: { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 } },
    { key: "fable-5", provider: "anthropic", name: "Fable", version: "5", runtime: "claude", id: "claude-fable-5", pricing: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 } },
  ],
  codex: [
    {
      key: "gpt-5.6-sol",
      provider: "openai",
      name: "GPT-5.6 Sol",
      version: "5.6",
      runtime: "codex",
      id: "gpt-5.6-sol",
      effort: "medium",
      // Short-context Standard rates; Tack's single-tier pricing can't express the
      // separate long-context tier the vendor also lists.
      pricing: { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.4, cacheWritePer1M: 5 },
    },
    {
      key: "gpt-5.6-terra",
      provider: "openai",
      name: "GPT-5.6 Terra",
      version: "5.6",
      runtime: "codex",
      id: "gpt-5.6-terra",
      effort: "medium",
      pricing: { inputPer1M: 2, outputPer1M: 12, cacheReadPer1M: 0.2, cacheWritePer1M: 2.5 },
    },
    {
      key: "gpt-5.6-luna",
      provider: "openai",
      name: "GPT-5.6 Luna",
      version: "5.6",
      runtime: "codex",
      id: "gpt-5.6-luna",
      effort: "medium",
      pricing: { inputPer1M: 0.2, outputPer1M: 1.2, cacheReadPer1M: 0.02, cacheWritePer1M: 0.25 },
    },
  ],
};

/**
 * Pricing for a model, preferring what the user configured and falling back to the
 * catalog entry (matched by runtime + id). Used to cost interactive sessions from
 * recovered tokens even when a model row (e.g. an older `tack models refresh` that
 * predates claude pricing) carries none.
 */
export function pricingFor(model: Model): Pricing | undefined {
  if (model.pricing) return model.pricing;
  return MODEL_CATALOG[model.runtime].find((m) => m.id === model.id)?.pricing;
}

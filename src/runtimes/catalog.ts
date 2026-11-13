import type { Model, Pricing, RuntimeKind } from "../config/schema";

/**
 * The models each runtime CLI offers, keyed by runtime. When a runtime can list its
 * own models for the signed-in account (`Runtime.listModels` — codex can, claude
 * can't), `tack models sync` uses that live list and only borrows a catalog entry's
 * curated fields (effort, pricing) for ids it recognizes. Otherwise sync seeds the
 * config from this catalog for whichever runtimes are actually connected (resolve
 * to a working binary). Keep it current as the CLIs gain models; a model here is
 * just a starting point the user can edit in place.
 *
 * `key` is the stable handle roles pin to, and is version-qualified (e.g.
 * `opus-5`) so multiple versions of the same model coexist as distinct keys. `id`
 * is the model's full versioned name (`claude-opus-5`), NOT a floating alias like
 * `opus` — an alias resolves to whatever the CLI currently calls latest (today
 * `opus` is Opus 4.8, not 5), which would defeat a version-pinned key.
 *
 * Codex reports tokens only, so its entries MUST carry `pricing` (USD per 1M
 * tokens) to yield a cost (SPEC §5) — `tack models sync` can fill these from
 * models.dev instead of hand-maintaining them. Claude headless reports `total_cost_usd`
 * directly, so pricing is not needed there — but interactive claude sessions emit
 * no cost, so we carry ESTIMATED pricing here purely as the fallback used to
 * recover an interactive session's cost from its transcript tokens. Edit these to
 * match current Anthropic rates; they don't affect headless cost.
 */
export const MODEL_CATALOG: Record<RuntimeKind, Model[]> = {
  claude: [
    { key: "opus-5.5", provider: "anthropic", name: "Opus", version: "5.5", runtime: "claude", id: "claude-opus-5-5", effort: "high", pricing: { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 } },
    { key: "opus-5", provider: "anthropic", name: "Opus", version: "5", runtime: "claude", id: "claude-opus-5", effort: "high", pricing: { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 } },
    { key: "opus-4.8", provider: "anthropic", name: "Opus", version: "4.8", runtime: "claude", id: "claude-opus-4-8", effort: "high", pricing: { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 } },
    { key: "sonnet-5", provider: "anthropic", name: "Sonnet", version: "5", runtime: "claude", id: "claude-sonnet-5", pricing: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 } },
    { key: "haiku-4.5", provider: "anthropic", name: "Haiku", version: "4.5", runtime: "claude", id: "claude-haiku-4-5", pricing: { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 } },
    { key: "fable-5", provider: "anthropic", name: "Fable", version: "5", runtime: "claude", id: "claude-fable-5", pricing: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 } },
  ],
  codex: [
    // Only IDs confirmed usable are listed. `codex debug models` (codex-cli 0.163.0)
    // shows the binary's bundled catalog, but being listed there doesn't mean a
    // ChatGPT account can use the model: `gpt-5.6-sol` is in it and was rejected
    // with `model_not_found`. `gpt-6.1-sol` is the model a ChatGPT-account
    // `codex exec` actually defaults to.
    {
      key: "gpt-6.1-sol",
      provider: "openai",
      name: "GPT-6.1 Sol",
      version: "6.1",
      runtime: "codex",
      id: "gpt-6.1-sol",
      effort: "medium",
      // UNVERIFIED placeholder rates — run `tack models sync` to fill from models.dev
      pricing: { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.4, cacheWritePer1M: 5 },
    },
  ],
};

/**
 * Pricing for a model, preferring what the user configured and falling back to the
 * catalog entry (matched by runtime + id). Used to cost interactive sessions from
 * recovered tokens even when a model row (e.g. an older `tack models sync` that
 * predates claude pricing) carries none.
 */
export function pricingFor(model: Model): Pricing | undefined {
  if (model.pricing) return model.pricing;
  return MODEL_CATALOG[model.runtime].find((m) => m.id === model.id)?.pricing;
}

/** An id token that is a bare version number (`5`, `6.1`), not part of the name. */
const VERSION_TOKEN = /^\d+(\.\d+)*$/;

/**
 * The version embedded in a model id (`gpt-6.1-sol` → `6.1`), for runtimes that
 * list models by id alone. Falls back to the id itself for unversioned names so the
 * config's required `version` is never empty.
 */
export function versionFromId(id: string): string {
  return id.split("-").find((t) => VERSION_TOKEN.test(t)) ?? id;
}

/**
 * A model's family: its id with version tokens dropped, so successive releases of
 * one tier compare equal (`gpt-5.6-sol` and `gpt-6.1-sol` → `gpt-sol`,
 * `claude-opus-4-8` → `claude-opus`).
 */
function modelFamily(id: string): string {
  return id
    .toLowerCase()
    .split("-")
    .filter((t) => !VERSION_TOKEN.test(t))
    .join("-");
}

/** Numeric comparison of dotted versions (`6.1` > `6` > `5.6`); non-numeric parts count as 0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The model a role should move to when the one it's pinned to is no longer offered.
 * Prefers the newest version of the same family — so `gpt-5.6-sol` upgrades to
 * `gpt-6.1-sol` rather than jumping tiers, keeping the cost/capability trade-off the
 * user picked — else the first of `pool`, which callers rank best-first. `pool`
 * should already exclude stale models and be narrowed to the stale model's provider.
 */
export function pickReplacement(stale: Model, pool: Model[]): Model | undefined {
  const family = modelFamily(stale.id);
  const sameFamily = pool.filter((m) => modelFamily(m.id) === family);
  if (sameFamily.length > 0) {
    return sameFamily.reduce((best, m) => (compareVersions(m.version, best.version) > 0 ? m : best));
  }
  return pool[0];
}

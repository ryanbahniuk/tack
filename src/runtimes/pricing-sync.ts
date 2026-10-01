import type { Model, Pricing } from "../config/schema";

/**
 * Pricing sync from models.dev — so codex models don't need a hand-maintained USD
 * table that silently goes stale (SPEC §5 requires codex models to carry pricing to
 * yield a cost). models.dev publishes a single machine-readable JSON catalog keyed
 * by provider → model, each with a `cost` object in USD per MILLION tokens — exactly
 * Tack's `Pricing` shape. This is the ONLY network call Tack makes, it's read-only
 * (a public GET, no credentials, nothing of the user's sent), and it only fires when
 * the user runs `tack models sync-pricing`. Pricing otherwise stays vendored/offline
 * in the catalog.
 */

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** The subset of a models.dev model entry we read. */
interface ModelsDevEntry {
  id?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}
type ModelsDevApi = Record<string, { models?: Record<string, ModelsDevEntry> }>;

/** Rounds to 6 decimals, dropping floating-point noise (e.g. 0.12500000000000003 →
 * 0.125) so a clean literal lands in the user's config. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Maps a models.dev `cost` block (USD per 1M tokens) to Tack's `Pricing`, or null
 * when it carries no usable rate. */
function toPricing(cost: ModelsDevEntry["cost"]): Pricing | null {
  if (!cost) return null;
  const pricing: Pricing = {};
  if (typeof cost.input === "number") pricing.inputPer1M = round(cost.input);
  if (typeof cost.output === "number") pricing.outputPer1M = round(cost.output);
  if (typeof cost.cache_read === "number") pricing.cacheReadPer1M = round(cost.cache_read);
  if (typeof cost.cache_write === "number") pricing.cacheWritePer1M = round(cost.cache_write);
  return Object.keys(pricing).length ? pricing : null;
}

/** Normalizes a model id for matching: lowercased, and the bare name after any
 * `provider/` prefix (models.dev ids look like `openai/gpt-5-codex`). */
function idKeys(id: string): string[] {
  const lower = id.toLowerCase();
  const bare = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  return bare === lower ? [lower] : [lower, bare];
}

/**
 * Fetches the models.dev catalog and returns a map from model id (both the full
 * `provider/id` and the bare id, lowercased) to `Pricing`. Throws on a network or
 * parse failure so the caller can report it rather than silently no-op.
 */
export async function fetchPricingCatalog(url = MODELS_DEV_URL): Promise<Map<string, Pricing>> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
  const data = (await res.json()) as ModelsDevApi;

  const byId = new Map<string, Pricing>();
  for (const provider of Object.values(data)) {
    const models = provider?.models;
    if (!models) continue;
    for (const [key, entry] of Object.entries(models)) {
      const pricing = toPricing(entry?.cost);
      if (!pricing) continue;
      for (const k of idKeys(key)) byId.set(k, pricing);
      if (typeof entry.id === "string") for (const k of idKeys(entry.id)) byId.set(k, pricing);
    }
  }
  return byId;
}

/** The pricing a fetched catalog has for a model, matched by its CLI `id`. */
export function pricingForModel(model: Model, catalog: Map<string, Pricing>): Pricing | undefined {
  for (const k of idKeys(model.id)) {
    const p = catalog.get(k);
    if (p) return p;
  }
  return undefined;
}

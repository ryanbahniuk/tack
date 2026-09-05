import type { Pricing } from "../config/schema";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Computes USD from token usage and a per-1M pricing table. Used for the `codex`
 * runtime, which reports tokens but no dollar figure. Missing rates count as 0,
 * so a partially-specified table still yields a (low-bound) estimate rather than
 * throwing. Returns null when there's no pricing at all — the caller records the
 * agent's cost as unknown rather than a misleading $0.
 */
export function costFromPricing(pricing: Pricing | undefined, usage: TokenUsage): number | null {
  if (!pricing) return null;
  const per = (n: number, rate: number | undefined) => (rate ? (n / 1_000_000) * rate : 0);
  return (
    per(usage.input, pricing.inputPer1M) +
    per(usage.output, pricing.outputPer1M) +
    per(usage.cacheRead, pricing.cacheReadPer1M) +
    per(usage.cacheWrite, pricing.cacheWritePer1M)
  );
}

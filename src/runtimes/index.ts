import type { RuntimeKind } from "../config/schema";
import { ClaudeRuntime } from "./claude";
import { CodexRuntime } from "./codex";
import type { Runtime } from "./types";

export * from "./types";
export { costFromPricing } from "./pricing";
export { MODEL_CATALOG, pricingFor } from "./catalog";
export { fetchPricingCatalog, pricingForModel, MODELS_DEV_URL } from "./pricing-sync";
export {
  resolveRuntime,
  runtimeBin,
  runtimeVersion,
  managedRuntimeBin,
  managedRuntimeDir,
  DEFAULT_VERSION_POLICY,
  type ResolvedRuntime,
} from "./resolve";
export { ensureRuntimeInstalled, type EnsureResult, type EnsureAction } from "./install";
export { runtimeAuth, type AuthStatus } from "./auth";

/** Picks the runtime implementation for a runtime kind. */
export function selectRuntime(kind: RuntimeKind): Runtime {
  switch (kind) {
    case "claude":
      return new ClaudeRuntime();
    case "codex":
      return new CodexRuntime();
  }
}

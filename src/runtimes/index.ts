import type { RuntimeKind } from "../config/schema";
import { ClaudeRuntime } from "./claude";
import { CodexRuntime } from "./codex";
import type { Runtime } from "./types";

export * from "./types";
export { costFromPricing } from "./pricing";
export {
  resolveRuntime,
  runtimeBin,
  runtimeVersion,
  managedRuntimeBin,
  managedRuntimeDir,
  type ResolvedRuntime,
} from "./resolve";
export { ensureRuntimeInstalled, type EnsureResult, type EnsureAction } from "./install";

/** Picks the runtime implementation for a runtime kind. */
export function selectRuntime(kind: RuntimeKind): Runtime {
  switch (kind) {
    case "claude":
      return new ClaudeRuntime();
    case "codex":
      return new CodexRuntime();
  }
}

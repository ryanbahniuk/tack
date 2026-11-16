import type { Model, RuntimeKind, TackConfig } from "../config/schema";
import { resolveRuntime } from "../runtimes/resolve";
import { checkModelOffered } from "../runtimes/availability";

export interface RunnerPreflight { modelKey: string; runtime: RuntimeKind; bin: string; version: string; modelOffered: true | "unknown" }
export function computePreflight(config: TackConfig, model: Model, role?: string): RunnerPreflight {
  const offered = checkModelOffered(config, model, { role });
  if (offered.ok === false) throw new Error(offered.message);
  const resolved = resolveRuntime(config, model.runtime);
  return { modelKey: model.key, runtime: model.runtime, bin: resolved.bin, version: resolved.version, modelOffered: offered.ok };
}
export const encodePreflight = (v: RunnerPreflight): string => Buffer.from(JSON.stringify(v)).toString("base64");
export function decodePreflight(value: string | undefined): RunnerPreflight | undefined {
  try {
    if (!value) return undefined;
    const v = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    if (typeof v.modelKey !== "string" || !v.modelKey || !["claude", "codex"].includes(v.runtime) || typeof v.bin !== "string" || !v.bin || typeof v.version !== "string" || (v.modelOffered !== true && v.modelOffered !== "unknown")) return undefined;
    return v;
  } catch { return undefined; }
}
export function usablePreflight(value: unknown, modelKey: string, runtime: RuntimeKind): value is RunnerPreflight {
  if (!value || typeof value !== "object") return false;
  const v = value as RunnerPreflight;
  return v.modelKey === modelKey && v.runtime === runtime && typeof v.bin === "string" && !!v.bin && typeof v.version === "string" && (v.modelOffered === true || v.modelOffered === "unknown");
}

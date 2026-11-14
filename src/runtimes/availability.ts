import type { Model, RuntimeKind, TackConfig } from "../config/schema";
import { selectRuntime } from "./index";
import { resolveRuntime } from "./resolve";

/**
 * Whether the signed-in runtime login actually offers a configured model — checked
 * BEFORE an agent spawns, so a role pinned to a model the login rejects (e.g.
 * `gpt-5.6-sol` on a ChatGPT codex login → `400 model_not_found`) fails fast with a
 * clear remediation instead of burning a run per agent and surfacing only in the log.
 *
 * `Runtime.listModels` is the single source of truth (the same one `tack models
 * sync` prunes against). Anything we can't determine — a runtime that can't list
 * models (claude), an unresolvable binary, a `codex debug models` failure — is
 * `"unknown"`, and callers must never block on unknown: this is a guardrail against a
 * known-bad pin, not a gate that a flaky debug subcommand can take down.
 */
export type ModelAvailability = { ok: true } | { ok: false; message: string } | { ok: "unknown" };

/** Lists the model ids a runtime's login offers, or null when unknown. Injectable so
 * tests can stub the (slow, account-dependent) live lookup. */
export type ModelLister = (config: TackConfig, kind: RuntimeKind) => string[] | null;

/** The live lookup: resolve the (version-pinned) binary, then ask the runtime. */
export const defaultModelLister: ModelLister = (config, kind) => {
  const runtime = selectRuntime(kind);
  if (!runtime.listModels) return null; // e.g. claude — can't list, so unknown
  try {
    const { bin } = resolveRuntime(config, kind);
    return runtime.listModels(bin)?.map((m) => m.id) ?? null;
  } catch {
    return null; // unresolvable binary / strict pin drift — not our call to block
  }
};

/** Per-process cache of each runtime's offering. `codex debug models` takes several
 * seconds, and a long-lived supervisor MCP server may check many spawns; the login's
 * offering doesn't change under a running session. Unknown (null) is cached too, so
 * a broken lookup isn't re-spawned on every check — it never blocks anyway. */
const offeredCache = new Map<RuntimeKind, string[] | null>();

/** Drops cached offerings (tests; or after the login changes). */
export function clearModelAvailabilityCache(): void {
  offeredCache.clear();
}

/** The remediation every not-offered path points at (contract: always `models sync`). */
export const MODELS_SYNC_HINT = "run `tack models sync` to prune it and re-pin roles";

/**
 * Checks that `model` is offered to its runtime's signed-in login. Pass `role` when
 * the model came from a role pin, so the message names what the user must re-pin.
 */
export function checkModelOffered(
  config: TackConfig,
  model: Model,
  opts: { role?: string; lister?: ModelLister } = {},
): ModelAvailability {
  const kind = model.runtime;
  let offered: string[] | null;
  if (offeredCache.has(kind)) {
    offered = offeredCache.get(kind)!;
  } else {
    try {
      offered = (opts.lister ?? defaultModelLister)(config, kind);
    } catch {
      offered = null;
    }
    offeredCache.set(kind, offered);
  }
  if (!offered) return { ok: "unknown" };
  if (offered.includes(model.id)) return { ok: true };
  const what = `model "${model.key}" (${kind}:${model.id})`;
  const subject = opts.role ? `role "${opts.role}" is pinned to ${what}, which` : what;
  return { ok: false, message: `${subject} is not offered to this ${kind} login — ${MODELS_SYNC_HINT}` };
}

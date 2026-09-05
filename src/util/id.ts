import { randomUUID } from "node:crypto";

/** ISO-8601 timestamp (UTC) used for all `created_at`/`updated_at` columns. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** A full RFC-4122 UUID — used where a runtime needs a valid UUID (e.g. the
 * pre-assigned `claude --session-id`). */
export function uuid(): string {
  return randomUUID();
}

/**
 * A short, prefixed, url/branch-safe id for our own entities, e.g. `ses_a1b2c3d4`
 * or `agt_9f8e7d6c`. Not a UUID — compact enough to read in the dashboard and to
 * embed in worktree paths and PR branch names.
 */
export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

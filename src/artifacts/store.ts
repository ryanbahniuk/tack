import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ARTIFACTS_DIR, CONTEXT_DIR } from "../paths";

/**
 * The DB stores only refs; the bytes live here. This module is the single place
 * that turns "a blob for session X / agent Y" into a stable filesystem path and
 * back, so the ref convention stays in one spot.
 */

function write(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}

/** Reads a ref written by this store; returns "" if the file is missing. */
export function readArtifact(ref: string | null | undefined): string {
  if (!ref) return "";
  try {
    return readFileSync(ref, "utf8");
  } catch {
    return "";
  }
}

/** The deterministic path an agent artifact lives at — the single place the naming
 * convention is encoded, so readers can reconstruct a ref even when the DB column is
 * empty (e.g. an agent written before `output_ref` was persisted). */
export function agentArtifactPath(
  sessionId: string,
  agentId: string,
  kind: "prompt" | "output" | "diff",
): string {
  const ext = kind === "diff" ? "patch" : "md";
  return join(ARTIFACTS_DIR, sessionId, agentId, `${kind}.${ext}`);
}

/** Writes an agent artifact (prompt/output/diff) and returns its ref path. */
export function writeAgentArtifact(
  sessionId: string,
  agentId: string,
  kind: "prompt" | "output" | "diff",
  body: string,
): string {
  return write(agentArtifactPath(sessionId, agentId, kind), body);
}

/** Writes a versioned shared-context body and returns its ref path. */
export function writeSharedContext(sessionId: string, version: number, body: string): string {
  return write(join(ARTIFACTS_DIR, sessionId, "shared-context", `v${version}.md`), body);
}

/** Writes an amendment proposal/resolution and returns its ref path. */
export function writeAmendmentArtifact(
  sessionId: string,
  amendmentId: string,
  kind: "proposal" | "resolution",
  body: string,
): string {
  return write(join(ARTIFACTS_DIR, sessionId, "amendments", `${amendmentId}.${kind}.md`), body);
}

/**
 * Materializes a session-scoped context file to be handed to a runtime BY PATH
 * (`--append-system-prompt-file` / codex base-instructions). Kept separate from
 * artifacts because these are the injection surface, not a durable record.
 */
export function writeContextFile(sessionId: string, name: string, body: string): string {
  return write(join(CONTEXT_DIR, sessionId, name), body);
}

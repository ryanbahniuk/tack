import { appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
  kind: "prompt" | "output" | "diff" | "review" | "transcript",
): string {
  const ext = kind === "diff" ? "patch" : kind === "review" ? "json" : "md";
  return join(ARTIFACTS_DIR, sessionId, agentId, `${kind}.${ext}`);
}

/** Writes an agent artifact (including structured JSON reviews) and returns its ref path. */
export function writeAgentArtifact(
  sessionId: string,
  agentId: string,
  kind: "prompt" | "output" | "diff" | "review" | "transcript",
  body: string,
): string {
  return write(agentArtifactPath(sessionId, agentId, kind), body);
}

/** Appends streamed content without replacing earlier turns. */
export function appendAgentArtifact(
  sessionId: string, agentId: string, kind: "prompt" | "output" | "diff" | "review" | "transcript", text: string,
): string {
  const path = agentArtifactPath(sessionId, agentId, kind);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text, "utf8");
  return path;
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
 * Writes a PR-watch feedback artifact — the ingested GitHub comment body, or the fix
 * agent's reply to it — and returns its ref path. Keyed by PR + GitHub source id
 * (sanitized; node ids are base64-ish) so the path is deterministic and known before
 * the `pr_feedback` row exists.
 */
export function writePrFeedbackArtifact(
  sessionId: string,
  sessionPrId: string,
  sourceId: string,
  kind: "body" | "reply",
  body: string,
): string {
  const safe = sourceId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return write(join(ARTIFACTS_DIR, sessionId, "pr-feedback", sessionPrId, `${safe}.${kind}.md`), body);
}

/** Writes the session's composed summary (see `src/session/summary.ts`) and returns its ref path. */
export function writeSessionSummary(sessionId: string, body: string): string {
  return write(join(ARTIFACTS_DIR, sessionId, "summary.md"), body);
}

/** Per-run PR description snapshots and proposals live with the fix agent. */
export function writePrDescription(sessionId: string, agentId: string, kind: "base" | "proposed", body: string): string {
  return write(join(ARTIFACTS_DIR, sessionId, agentId, `pr-description.${kind}.md`), body);
}
export function readPrDescription(sessionId: string, agentId: string, kind: "base" | "proposed"): string {
  return readArtifact(join(ARTIFACTS_DIR, sessionId, agentId, `pr-description.${kind}.md`));
}
export function clearPrDescription(sessionId: string, agentId: string, kind: "base" | "proposed"): void {
  rmSync(join(ARTIFACTS_DIR, sessionId, agentId, `pr-description.${kind}.md`), { force: true });
}

/** Writes the description body a session PR was opened with and returns its ref path. */
export function writeSessionPrBody(sessionId: string, sessionPrId: string, body: string): string {
  return write(join(ARTIFACTS_DIR, sessionId, "prs", `${sessionPrId}.body.md`), body);
}

/**
 * Materializes a session-scoped context file to be handed to a runtime BY PATH
 * (`--append-system-prompt-file` / codex base-instructions). Kept separate from
 * artifacts because these are the injection surface, not a durable record.
 */
export function writeContextFile(sessionId: string, name: string, body: string): string {
  return write(join(CONTEXT_DIR, sessionId, name), body);
}


/** Each follow-up is immutable; the original assignment remains available. */
export function writeContinuationPrompt(sessionId: string, agentId: string, turnId: string, body: string): string {
  return write(join(ARTIFACTS_DIR, sessionId, agentId, "turns", `${turnId}.md`), body);
}

/** Preserve the exact teardown procedure even if configuration changes. */
export function writeBootPlan(sessionId: string, project: string, body: string): string {
  return write(join(ARTIFACTS_DIR, sessionId, "boot", `${encodeURIComponent(project)}-${crypto.randomUUID()}.json`), body);
}

/** Persist the page and its bounded source separately from the database. */
export function writeSessionReadme(id: string, html: string): string {
  return write(join(ARTIFACTS_DIR, id, "readme", "readme.html"), html);
}
export function writeSessionReadmeDigest(id: string, digest: string): string {
  return write(join(ARTIFACTS_DIR, id, "readme", "digest.md"), digest);
}

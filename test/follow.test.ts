import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { appendAgentArtifact, agentArtifactPath } from "../src/artifacts/store";
import { isTerminalAgentStatus, readTranscript } from "../src/cli/follow";
import { agentViewTarget } from "../src/cli/dashboard";
import type { AgentRow } from "../src/db";

test("agent artifacts append across calls", () => {
  const session = `test-follow-${crypto.randomUUID()}`;
  const path = agentArtifactPath(session, "agent", "transcript");
  try {
    expect(appendAgentArtifact(session, "agent", "transcript", "first")).toBe(path);
    appendAgentArtifact(session, "agent", "transcript", " second");
    expect(readFileSync(path, "utf8")).toBe("first second");
  } finally { rmSync(join(path, "../.."), { recursive: true, force: true }); }
});

test("incremental reads preserve offsets and split UTF-8", () => {
  const dir = mkdtempSync(join(tmpdir(), "tack-follow-"));
  const path = join(dir, "transcript");
  const decoder = new StringDecoder("utf8");
  try {
    expect(readTranscript(path, 0, decoder).exists).toBe(false);
    writeFileSync(path, Buffer.from([0x61, 0xe2]));
    const first = readTranscript(path, 0, decoder);
    expect(first).toEqual({ text: "a", offset: 2, exists: true });
    appendFileSync(path, Buffer.from([0x86, 0x92]));
    const second = readTranscript(path, first.offset, decoder);
    expect(second).toEqual({ text: "→", offset: 4, exists: true });
    expect(readTranscript(path, second.offset, decoder).text).toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe("agent view resolution", () => {
  const agent = { id: "a", session_id: "s", kind: null, status: "running", output_ref: "/output" } as AgentRow;
  test("follows active agents and excludes manual workspaces", () => {
    expect(agentViewTarget(agent, () => false)).toEqual({ kind: "follow" });
    expect(agentViewTarget({ ...agent, status: "pending" }, () => false)).toEqual({ kind: "follow" });
    expect(agentViewTarget({ ...agent, kind: "manual" }, () => true)).toEqual({ kind: "none" });
  });
  test("pages final output then transcript, or reports none", () => {
    const done = { ...agent, status: "done" as const };
    expect(agentViewTarget(done, p => p === "/output")).toEqual({ kind: "page", ref: "/output" });
    const transcript = agentArtifactPath("s", "a", "transcript");
    expect(agentViewTarget(done, p => p === transcript)).toEqual({ kind: "page", ref: transcript });
    expect(agentViewTarget(done, () => false)).toEqual({ kind: "none" });
  });
  test("recognizes all terminal statuses", () => {
    for (const status of ["done", "failed", "stopped"] as const) expect(isTerminalAgentStatus(status)).toBe(true);
    for (const status of ["pending", "running"] as const) expect(isTerminalAgentStatus(status)).toBe(false);
  });
});

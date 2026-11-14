import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentArtifactPath } from "../artifacts/store";
import type { AgentRow, SessionRow, SessionPrRow, SharedContextRow } from "../db";
import { LOGS_DIR, TACK_HOME } from "../paths";
import { buildTackBugReport, claudeReportTranscriptPath, extractReportTranscript, readReportFile, reportExcerpt, tackBugSeed } from "./bug-report";

const session = {
  id: "ses_source", title: "Frozen dashboard", runtime: "claude", supervisor_model: "opus",
  resume_ref: "resume-id", status: "active", created_at: "created", updated_at: "updated",
  plan_approved_at: "approved", heartbeat_at: null,
} as SessionRow;
const fixture = readFileSync(join(import.meta.dir, "fixtures/bug-transcript.jsonl"), "utf8");
const empty = { agents: () => [], contract: () => null, prs: () => [], capture: () => "" };

describe("Tack bug report", () => {
  test("includes metadata, prompt, latest contract, agents with fallback, PRs, conversation and log", () => {
    const files = new Map([
      [join(LOGS_DIR, session.id, "supervisor.prompt"), "original task"],
      ["contract.md", "shared agreement"],
      [agentArtifactPath(session.id, "agt_one", "output"), "agent finished"],
      [claudeReportTranscriptPath(session)!, fixture],
      [join(LOGS_DIR, session.id, "supervisor.log"), "log evidence"],
    ]);
    const report = buildTackBugReport(session, {
      read: path => files.get(path) ?? "",
      agents: () => [{ id: "agt_one", project_name: "tack", status: "failed", model: "model", error: "failure" } as AgentRow],
      contract: () => ({ version: 3, body_ref: "contract.md" } as SharedContextRow),
      prs: () => [{ url: "https://example.com/pr/1", state: "OPEN" } as SessionPrRow],
      capture: () => { throw new Error("should not need fallback"); },
    });
    for (const value of ["ses_source", "Frozen dashboard", "opus / claude", "created", "updated", "approved", "original task", "Shared contract (v3)", "shared agreement", "agt_one", "failure", "agent finished", "https://example.com/pr/1", "OPEN", "Supervisor conversation", "The dashboard froze", "log evidence"]) expect(report).toContain(value);
  });

  test("uses the runtime's slug and resume_ref convention", () => {
    expect(claudeReportTranscriptPath(session, "/home/test", "/tmp/tack.home")).toBe("/home/test/.claude/projects/-tmp-tack-home-supervisor-ses_source/resume-id.jsonl");
    expect(claudeReportTranscriptPath({ ...session, runtime: "codex" })).toBeUndefined();
  });

  test("extracts JSONL text and tool summaries, skipping malformed records and thinking", () => {
    const text = extractReportTranscript(fixture);
    for (const value of ["user: The dashboard froze", "assistant: Checking", "Tool call list_agents (call1)", "Tool result call1 (error)", "database locked"]) expect(text).toContain(value);
    expect(text).not.toContain("private reasoning");
  });

  test("tolerates missing and unreadable data and falls back for either runtime", () => {
    const fail = () => { throw new Error("missing"); };
    expect(() => buildTackBugReport(session, { read: fail, agents: fail, contract: fail, prs: fail, capture: fail })).not.toThrow();
    expect(readReportFile("/nonexistent/tack-bug-file")).toBe("");
    for (const runtime of ["claude", "codex"] as const) {
      expect(buildTackBugReport({ ...session, runtime }, { ...empty, read: () => "", capture: () => "pane evidence" })).toContain("Supervisor pane (tail)\n\npane evidence");
    }
  });

  test("caps sections, individual tool blocks, lines and total UTF-8 size", () => {
    const huge = "😀".repeat(100000);
    const report = buildTackBugReport(session, {
      read: () => huge,
      agents: () => Array.from({ length: 100 }, (_, i) => ({ id: `agt_${i}`, error: huge } as AgentRow)),
      contract: () => ({ body_ref: "contract", version: 1 } as SharedContextRow),
      prs: () => Array.from({ length: 100 }, () => ({ url: huge } as SessionPrRow)),
      capture: () => huge,
    });
    expect(Buffer.byteLength(report)).toBeLessThan(190000);
    expect(report).toContain("[truncated]");
    expect(reportExcerpt("old\n".repeat(1000) + "new", 100, true, 3)).toEndWith("new");
    expect(reportExcerpt(huge, 100)).toHaveLength(100);
    expect(extractReportTranscript(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: huge }] } }))).toHaveLength(1511);
  });

  test("disk reads are bounded and preserve either end of a large artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "tack-report-test-"));
    try {
      const file = join(dir, "output");
      writeFileSync(file, "START" + "x".repeat(600000) + "END");
      expect(readReportFile(file)).toStartWith("START");
      expect(readReportFile(file)).toHaveLength(512 * 1024);
      expect(readReportFile(file, true)).toEndWith("END");
      expect(readReportFile(file, true)).toHaveLength(512 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("seed stays short, quotes description and references file plus missing project", () => {
    const seed = tackBugSeed("ses_source", "broken\nagain", false);
    expect(seed).toContain("> broken\n> again");
    expect(seed).toContain("./tack-bug-report.md first, then sync the tack project");
    expect(seed).toContain("no configured project is named tack");
    expect(tackBugSeed("ses_source", "", true)).toContain("infer the bug");
    expect(tackBugSeed("ses_source", "x".repeat(100000), true).length).toBeLessThan(3000);
    expect(claudeReportTranscriptPath(session)).toContain(join(TACK_HOME, "supervisor", session.id).replace(/[/.]/g, "-"));
  });
});

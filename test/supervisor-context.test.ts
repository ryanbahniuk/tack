import { describe, expect, mock, test } from "bun:test";
import type { TackConfig } from "../src/config/schema";

// buildSupervisorContext materializes its body to a file under TACK_HOME. Capture
// the body instead so the test stays pure (no filesystem, no real ~/.tack).
let written = "";
mock.module("../src/artifacts/store", () => ({
  writeContextFile: (_sessionId: string, _name: string, body: string) => {
    written = body;
    return "/dev/null";
  },
}));
const { buildSupervisorContext } = await import("../src/supervisor/context");

function context(autoOpenPrs: boolean): string {
  buildSupervisorContext("ses_test", { projects: [], autoOpenPrs } as unknown as TackConfig);
  return written;
}

describe("supervisor context: autoOpenPrs", () => {
  test("true frames the setting as the human's explicit authorization to commit/push/open PRs", () => {
    const body = context(true);
    expect(body).toContain("explicit, standing request for you to commit the agents' work");
    expect(body).toContain("is already satisfied by it");
  });

  test("false keeps the ask-first flow and carries no standing authorization", () => {
    const body = context(false);
    expect(body).toContain("ASK for their approval");
    expect(body).not.toContain("explicit, standing request");
    expect(body).not.toContain("already satisfied");
  });
});

describe("supervisor context: PR fixes", () => {
  test("points at fix_pr for changing an open PR, never a new agent/PR", () => {
    const body = context(true);
    expect(body).toContain("- `fix_pr` —");
    expect(body).toContain("when a PR stays conflicting");
    expect(body).toContain("asks for changes to an open PR, use `fix_pr`");
    expect(body).toContain("Never spawn a new agent or open a new PR");
    expect(body).toContain("whenever the human asks for changes");
    expect(body).toContain("Runs one fix per PR at a time; supervisor runs are not subject to");
    expect(body).toContain("the watcher's daily cap and do not count toward it");
    expect(body).not.toContain("only way");
    expect(body).not.toContain("shares the watcher's daily cap");
  });
});

describe("supervisor context: publishable pages", () => {
  test("without an artifacts dir preserves the original no-filesystem guidance", () => {
    const body = context(true);
    expect(body).toContain("You investigate read-only and never touch the filesystem yourself.");
    expect(body).toContain("Do not reach\nfor Edit, Write, NotebookEdit");
    expect(body).not.toContain("page/Artifact tool");
    buildSupervisorContext("ses_test", { projects: [], autoOpenPrs: true } as unknown as TackConfig, {});
    expect(written).toBe(body);
  });

  test("with an artifacts dir grants only requested pages and keeps delegation guidance", () => {
    buildSupervisorContext("ses_test", { projects: [], autoOpenPrs: true } as unknown as TackConfig,
      { artifactsDir: "/tmp/tack/supervisor/ses_test/artifacts" });
    expect(written).toContain("`/tmp/tack/supervisor/ses_test/artifacts`");
    expect(written).toContain("write its source with Write/Edit");
    expect(written).toContain("publish it with your page/Artifact tool");
    expect(written).toContain("instead of the scratchpad directory");
    expect(written).toContain("If a write is refused, rewrite\nthe page there and publish again");
    expect(written).toContain("never\nplans, notes, contracts or code");
    expect(written).toContain('Never tell the human you "can\'t write a file"');
    expect(written).not.toContain("never touch the filesystem yourself");
  });
});

describe("persona contexts", () => {
  test("supervisor review guidance appears only when configured", () => {
    expect(context(true)).not.toContain("persona");
    buildSupervisorContext("ses_test", { projects: [], autoOpenPrs: true,
      personas: [{ name: "strict", description: "Strict review", model: [] }] } as unknown as TackConfig);
    expect(written).toContain("list_personas");
    expect(written).toContain("review_agent");
    expect(written).toContain("blocker/major");
    expect(written).toContain("Note persona verdicts briefly in the PR body");
  });

  test("review context preserves persona instructions and reports without commits", async () => {
    const { buildAgentContext } = await import("../src/context/build");
    const description = "Strict reviewer.\n\n  Preserve this formatting verbatim.";
    buildAgentContext({ sessionId: "ses_test", agentId: "review", projectName: "test", kind: "review",
      persona: { name: "strict", description }, reviewedAgent: { id: "author", branch: "tack/ses/author", base: "abc123" },
      sharedContext: "The intended behavior.",
    });
    expect(written).toContain("## Your persona\n\n" + description);
    expect(written).toContain("git diff abc123");
    expect(written).toContain("report_review");
    expect(written).toContain("exactly once");
    expect(written).toContain("Do not commit");
    expect(written).not.toContain("commit ALL");
  });
});

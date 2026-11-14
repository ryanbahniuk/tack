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
    expect(body).toContain("never spawn a new agent or open a new PR");
  });
});

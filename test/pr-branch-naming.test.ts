import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jiraPrBranchName, sessionPrBranch, uniquePrBranch } from "../src/worktree/worktree";
import { sessionPrBranches } from "../src/projects/prs";
import type { SessionPrRow } from "../src/db";

describe("PR branch naming", () => {
  test("normalizes Jira descriptions and removes the ticket prefix", () => {
    expect(jiraPrBranchName("ABC-123", "ABC-123: Add widgets")).toBe("ABC-123_add_widgets");
    expect(jiraPrBranchName("ABC-123", "abc-123 - Export / Widgets!")).toBe("ABC-123_export_widgets");
    expect(jiraPrBranchName("ABC-123", "  $ Hello---World! ")).toBe("ABC-123_hello_world");
    expect(jiraPrBranchName("ABC-123", "abc-123: ")).toBe("ABC-123_change");
    expect(jiraPrBranchName("ABC-123", "alpha beta gamma delta epsilon zeta eta theta iota")).toBe("ABC-123_alpha_beta_gamma_delta_epsilon_zeta_eta");
    expect(sessionPrBranch("session", "Add widgets")).toBe("tack/pr/session/Add-widgets");
  });

  test("falls back to stored names when origin is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tack-branch-"));
    try {
      expect((await Bun.$`git init -q ${dir}`.quiet()).exitCode).toBe(0);
      expect(await uniquePrBranch(dir, "ABC-123_change", ["ABC-123_change", "ABC-123_change_2"])).toBe("ABC-123_change_3");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("maps stored heads only within the requested project", () => {
    const rows = [
      { session_id: "one", project_name: "app", head_branch: "ABC-123_change" },
      { session_id: "two", project_name: "other", head_branch: "XYZ-2_change" },
    ] as SessionPrRow[];
    expect([...sessionPrBranches(rows, "app")]).toEqual([["ABC-123_change", "one"]]);
  });
});

import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userGuidanceSection } from "../src/context/user-guidance";
import * as store from "../src/artifacts/store";
import { buildAgentContext } from "../src/context/build";

test("personal guidance is last for every agent kind and absent when missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tack-agent-guidance-"));
  const path = join(dir, "AGENTS.md");
  let written = "";
  const writer = spyOn(store, "writeContextFile").mockImplementation((_sessionId, _name, body) => {
    written = body;
    return "/dev/null";
  });
  try {
    for (const kind of ["agent", "pr_fix", "review"] as const) {
      const parts = { sessionId: "test", agentId: "test", projectName: "test", kind };
      buildAgentContext(parts, path);
      expect(written).not.toContain("## Your personal guidance");
      writeFileSync(path, "Personal preference");
      buildAgentContext(parts, path);
      expect(written.endsWith(userGuidanceSection(path) + "\n")).toBe(true);
      expect(written.indexOf("## Finishing up")).toBeLessThan(written.indexOf("## Your personal guidance"));
      rmSync(path);
    }
  } finally {
    writer.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

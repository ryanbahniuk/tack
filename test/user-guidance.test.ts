import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUserGuidance, userGuidanceSection } from "../src/context/user-guidance";

describe("personal guidance", () => {
  test("ignores missing, blank and unreadable paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "tack-guidance-"));
    try {
      const path = join(dir, "AGENTS.md");
      expect(readUserGuidance(path)).toBeNull();
      expect(userGuidanceSection(path)).toBeNull();
      writeFileSync(path, " \n\t");
      expect(readUserGuidance(path)).toBeNull();
      expect(userGuidanceSection(path)).toBeNull();
      expect(readUserGuidance(dir)).toBeNull();
      expect(userGuidanceSection(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads fresh content and preserves its interior formatting", () => {
    const dir = mkdtempSync(join(tmpdir(), "tack-guidance-"));
    try {
      const path = join(dir, "AGENTS.md");
      writeFileSync(path, "  First line\n\n  Indented line  \n");
      expect(readUserGuidance(path)).toBe("First line\n\n  Indented line");
      expect(userGuidanceSection(path)).toBe(`## Your personal guidance (${path})\nThese are the human's personal preferences for every run; follow them, but the Tack instructions above (role, coordination and finishing rules) and the repository's own CLAUDE.md / AGENTS.md take precedence where they conflict.\n\nFirst line\n\n  Indented line`);
      writeFileSync(path, "Updated");
      expect(readUserGuidance(path)).toBe("Updated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

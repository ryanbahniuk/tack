import { expect, test } from "bun:test";
import { parseSupervisorCommand, REVIEW_MARKER, PR_FIX_MARKER } from "../src/supervisor/command-prompt";
test("parses typed and expanded supervisor commands", () => {
  expect(parseSupervisorCommand("/review strict focus on races")).toEqual({ kind: "review", persona: "strict", prompt: "focus on races" });
  expect(parseSupervisorCommand(`${REVIEW_MARKER}\nstrict`)).toEqual({ kind: "review", persona: "strict", prompt: undefined });
  expect(parseSupervisorCommand(`${PR_FIX_MARKER}\noff`)).toEqual({ kind: "pr-fix", value: "off" });
  expect(parseSupervisorCommand("/pr-fix")).toEqual({ kind: "pr-fix", value: undefined });
  expect(parseSupervisorCommand("hello")).toBeNull();
});

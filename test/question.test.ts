import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endsWithQuestion, finalAssistantText, lastAssistantText } from "../src/cli/question";

describe("endsWithQuestion", () => {
  test("detects a trailing question through decoration", () => {
    for (const text of [
      "Should I split this into two agents?",
      "Plan below.\n\nWhich option do you prefer?  \n\n",
      "**Want me to proceed?**",
      "_Proceed?_",
      "Use `foo`?",
      'They asked "is this right?"',
      "(Or should we wait?)",
      "Ready?\n```ts\nconst x = a ? b : c;\n```",
      "Proceed?\n```\none\n```\n\n```\ntwo ?\n```\n",
      "続けますか？",
    ]) {
      expect(endsWithQuestion(text)).toBe(true);
    }
  });

  test("ignores statements, earlier questions, and code ending in ?", () => {
    for (const text of [
      "",
      "Done. All three agents finished.",
      "Should I proceed? I'll wait for the agents first.",
      "What next? Nothing — I'm done.",
      "Is this a question?!",
      "Is it?.",
      "Here's the regex:\n```\n/a?/\n```",
      "```\nwhy?\n```",
    ]) {
      expect(endsWithQuestion(text)).toBe(false);
    }
  });

  test("keeps prose between two code blocks", () => {
    expect(endsWithQuestion("```\na\n```\nShip it?\n```\nb\n```")).toBe(true);
  });
});

describe("final assistant text", () => {
  const dir = mkdtempSync(join(tmpdir(), "tack-question-"));
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Earlier." }] } }),
    "not json",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Which repo?" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "x" }] } }),
    JSON.stringify({ type: "system", subtype: "stop" }),
    "",
  ].join("\n"));

  test("reads the last assistant text from a JSONL transcript, skipping tool-only entries", () => {
    expect(lastAssistantText(transcript)).toBe("Which repo?");
    expect(lastAssistantText(join(dir, "missing.jsonl"))).toBeNull();
  });

  test("prefers last_assistant_message, else falls back to transcript_path", () => {
    expect(finalAssistantText({ last_assistant_message: "Done.", transcript_path: transcript })).toBe("Done.");
    expect(finalAssistantText({ transcript_path: transcript })).toBe("Which repo?");
    expect(finalAssistantText({})).toBeNull();
    expect(finalAssistantText(null)).toBeNull();
  });
});

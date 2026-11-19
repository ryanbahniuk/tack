import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createSession, getSession, migrate } from "../src/db";
import { buildSessionReadmeDigest, extractReadmeHtml, generateSessionReadme, parseDiffStat } from "../src/session/readme";
import { claudeArtifactPublisher, parseArtifactUrl } from "../src/publish/claude-artifact";
import { selectPublisher } from "../src/publish";
import type { TackConfig } from "../src/config/schema";
import { ClaudeRuntime } from "../src/runtimes/claude";

const model = { key: "a", provider: "test", name: "A", version: "1", runtime: "codex" as const, id: "a" };
const config = { models: [model], roles: { supervisor: ["a"], agent: ["a"], summary: ["a"], readme: ["a"] }, runtimes: {}, readme: { publisher: "local" } } as TackConfig;
const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-secret patch line\n+new secret patch line\n+another\n';
describe("session README", () => {
  test("diff stats never include patch lines", () => {
    expect(parseDiffStat(patch)).toBe("a.ts +2 -1");
  });
  test("digest includes bounded sources and no raw diff", () => {
    const session = createSession({ title: "Widget" });
    const agent = { id: "agent", project_name: "repo", kind: null, status: "done", model: "a", runtime: "codex", error: null, prompt_ref: "prompt", output_ref: "output", diff_ref: "diff" };
    const digest = buildSessionReadmeDigest(session, { agents: (() => Array(40).fill(agent)) as never, contract: (() => ({ version: 3, body_ref: "contract" })) as never, prs: (() => []) as never, tickets: (() => []) as never, read: (path) => path === "diff" ? patch : "x".repeat(100000), date: () => "2026-01-02" });
    expect(digest).toContain("Shared contract (v3)"); expect(digest).toContain("a.ts +2 -1");
    expect(digest).not.toContain("secret patch line"); expect(digest.length).toBeLessThan(60000); expect(digest).toContain("As of: 2026-01-02");
  });
  test("extracts marked or fallback HTML", () => {
    expect(extractReadmeHtml("hello <<<README_HTML\n<html></html>\nREADME_HTML>>>" )).toBe("<html></html>");
    expect(extractReadmeHtml("noise <!DOCTYPE html><html></HTML> end")).toBe("<!DOCTYPE html><html></HTML>");
    expect(() => extractReadmeHtml("none")).toThrow();
  });
  test("accepts only Claude artifact URLs", () => {
    expect(parseArtifactUrl("ARTIFACT_URL: https://claude.ai/public/artifacts/abc")).toBeUndefined();
    expect(parseArtifactUrl("https://claude.ai/artifact/abc")).toBe("https://claude.ai/artifact/abc");
    expect(parseArtifactUrl("https://evil.example/artifact/abc")).toBeUndefined();
  });
  test("publisher asks to update the existing artifact", async () => {
    let prompt = "";
    const publisher = claudeArtifactPublisher(config, async function* (opts) {
      prompt = opts.prompt;
      expect(opts.allowTools).toEqual(["Read", "Artifact"]);
      yield { type: "text", text: "ARTIFACT_URL: https://claude.ai/artifact/abc" };
    });
    expect((await publisher.publish({ file: "/tmp/readme.html", title: "Page", existingUrl: "https://claude.ai/artifact/abc" })).url).toBe("https://claude.ai/artifact/abc");
    expect(prompt).toContain('action: "read"'); expect(prompt).toContain("url: https://claude.ai/artifact/abc");
  });
  test("migration and publisher", () => {
    const db = new Database(":memory:"); migrate(db);
    const cols = (db.query("pragma table_info(sessions)").all() as { name: string }[]).map(x => x.name);
    expect(cols).toEqual(expect.arrayContaining(["readme_ref", "readme_url", "readme_at"])); db.close();
    expect(selectPublisher(config).kind).toBe("local");
    expect(selectPublisher({ ...config, readme: { publisher: "claude-artifact" } }).kind).toBe("claude-artifact");
  });
  test("Claude allows publishing tools while denying edits", () => {
    const runtime = new ClaudeRuntime() as unknown as { buildCmd(o: unknown): string[] };
    const cmd = runtime.buildCmd({ model, bin: "claude", cwd: "/tmp", logPath: "/tmp/a", readOnly: true, disallowShell: true, allowTools: ["Read", "Artifact"] });
    expect(cmd).toContain("default"); expect(cmd).toContain("Artifact"); expect(cmd.join(" ")).toContain("Bash,Edit,Write");
  });
  test("generates, publishes and persists; no-publish skips publisher", async () => {
    const session = createSession({ title: "Widget" }); let calls = 0;
    const publisher = { kind: "test", label: "Test", async publish() { calls++; return { url: "https://example.test/page" }; } };
    async function* runAuthor() { yield { type: "text" as const, text: "<<<README_HTML\n<html><title>Widget Work</title></html>\nREADME_HTML>>>" }; }
    const result = await generateSessionReadme(config, session.id, { runAuthor, publisher });
    expect(readFileSync(result.file, "utf8")).toContain("Widget Work"); expect(getSession(session.id)?.readme_url).toBe(result.url); expect(getSession(session.id)?.readme_ref).toBe(result.file);
    await generateSessionReadme(config, session.id, { runAuthor, publisher, publish: false }); expect(calls).toBe(1);
  });
});

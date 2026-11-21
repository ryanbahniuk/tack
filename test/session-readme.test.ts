import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createSession, getSession, migrate } from "../src/db";
import { buildSessionReadmeDigest, extractReadmeHtml, generateSessionReadme, linkSessionReadme, normalizeReadmeLink, unlinkSessionReadme, parseDiffStat } from "../src/session/readme";
import { claudeArtifactPublisher, parseArtifactUrl } from "../src/publish/claude-artifact";
import { selectPublisher } from "../src/publish";
import type { TackConfig } from "../src/config/schema";
import * as configLoad from "../src/config/load";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSupervisorServer } from "../src/mcp/supervisor-server";
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
  test("normalizes README links", () => {
    for (const url of ["https://claude.ai/artifact/abc", "https://claude.ai/code/artifact/12345678-1234-1234-1234-123456789abc", "https://example.com/page"]) expect(normalizeReadmeLink(`  ${url}  `)).toBe(url);
    for (const url of ["https://claude.ai/chat/abc", "file:///tmp/x.html", "javascript:alert(1)", "", "https://claude.ai/artifact/abc!extra"]) expect(() => normalizeReadmeLink(url)).toThrow();
  });
  test("links and unlinks README fields", () => {
    const session = createSession({ title: "Links" });
    expect(linkSessionReadme(session.id, "https://example.com/one")).toEqual({ url: "https://example.com/one", previousUrl: null });
    expect(linkSessionReadme(session.id, "https://example.com/two").previousUrl).toBe("https://example.com/one");
    expect(getSession(session.id)?.readme_ref).toBeNull(); expect(getSession(session.id)?.readme_at).toBeTruthy();
    expect(unlinkSessionReadme(session.id).removedUrl).toBe("https://example.com/two");
    const cleared = getSession(session.id)!;
    expect([cleared.readme_ref, cleared.readme_url, cleared.readme_at]).toEqual([null, null, null]);
    expect(unlinkSessionReadme(session.id).removedUrl).toBeNull();
    expect(() => linkSessionReadme("missing-session", "https://example.com")).toThrow("Session missing-session not found");
    expect(() => unlinkSessionReadme("missing-session")).toThrow("Session missing-session not found");
  });
  test("supervisor tools link and unlink the current session", async () => {
    const session = createSession({ title: "Tools" });
    const configSpy = spyOn(configLoad, "loadConfig").mockResolvedValue(config);
    const connect = spyOn(McpServer.prototype, "connect").mockResolvedValue();
    const register = spyOn(McpServer.prototype, "registerTool");
    try {
      await runSupervisorServer(session.id);
      const handler = (name: string) => register.mock.calls.find(c => c[0] === name)![2] as unknown as (args: unknown) => Promise<{ content: { text: string }[] }>;
      const linked = JSON.parse((await handler("link_readme")({ url: "https://example.com/page" })).content[0]!.text);
      expect(linked).toEqual({ ok: true, url: "https://example.com/page", previousUrl: null });
      expect(getSession(session.id)?.readme_url).toBe(linked.url);
      const unlinked = JSON.parse((await handler("unlink_readme")({})).content[0]!.text);
      expect(unlinked).toEqual({ ok: true, removedUrl: linked.url });
      expect(getSession(session.id)?.readme_url).toBeNull();
    } finally { register.mockRestore(); connect.mockRestore(); configSpy.mockRestore(); }
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
    const session = createSession({ title: "Widget" }); let calls = 0; let existingUrl: string | null | undefined;
    linkSessionReadme(session.id, "https://example.test/linked");
    const publisher = { kind: "local" as const, label: "Test", format: "html" as const, owns: (url: string) => url.startsWith("https://example.test/"), async publish(input: { existingUrl?: string | null }) { calls++; existingUrl = input.existingUrl; return { url: "https://example.test/page" }; } };
    async function* runAuthor() { yield { type: "text" as const, text: "<<<README_HTML\n<html><title>Widget Work</title></html>\nREADME_HTML>>>" }; }
    await generateSessionReadme(config, session.id, { runAuthor, publisher, publish: false });
    expect(getSession(session.id)?.readme_url).toBe("https://example.test/linked");
    const result = await generateSessionReadme(config, session.id, { runAuthor, publisher });
    expect(existingUrl).toBe("https://example.test/linked");
    expect(readFileSync(result.file, "utf8")).toContain("Widget Work"); expect(getSession(session.id)?.readme_url).toBe(result.url); expect(getSession(session.id)?.readme_ref).toBe(result.file);
    await generateSessionReadme(config, session.id, { runAuthor, publisher, publish: false }); expect(calls).toBe(1);
  });
});

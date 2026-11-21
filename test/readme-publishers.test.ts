import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ConfigSchema, type TackConfig } from "../src/config/schema";
import { createSession, getSession, setSessionReadme } from "../src/db";
import { publisherOwning, selectPublisher, selectReadmePublisher } from "../src/publish";
import { claudeArtifactPublisher } from "../src/publish/claude-artifact";
import { CONFLUENCE_TOOLS, confluencePrompt, confluencePublisher } from "../src/publish/confluence";
import { parsePublishReport } from "../src/publish/connector";
import { googleDocPrompt, googleDocPublisher } from "../src/publish/google-doc";
import { localPublisher } from "../src/publish/local";
import type { PagePublisher } from "../src/publish/types";
import type { AgentEvent, RunOptions } from "../src/runtimes/types";
import { ClaudeRuntime } from "../src/runtimes/claude";
import { extractReadmeMarkdown, generateSessionReadme, readmeArgsConflict, README_DOC_SPEC, README_PAGE_SPEC } from "../src/session/readme";

const model = { key: "a", provider: "test", name: "A", version: "1", runtime: "codex" as const, id: "a" };
const base = { models: [model], roles: { supervisor: ["a"], agent: ["a"], summary: ["a"], readme: ["a"] }, runtimes: {} } as unknown as TackConfig;
const withReadme = (readme: TackConfig["readme"]) => ({ ...base, readme }) as TackConfig;

const ARTIFACT = "https://claude.ai/artifact/abc";
const CONFLUENCE = "https://acme.atlassian.net/wiki/spaces/~me/pages/123/Widget+Work";
const GDOC = "https://docs.google.com/document/d/1AbC_d-e/edit";
const FILE = "file:///tmp/readme.html";

function recordingRunner(reply: string) {
  const calls: RunOptions[] = [];
  const runner = async function* (opts: RunOptions): AsyncIterable<AgentEvent> { calls.push(opts); yield { type: "text", text: reply }; };
  return { calls, runner };
}

describe("publisher ownership", () => {
  test("each destination owns only its own URLs", () => {
    const cfg = withReadme({ publisher: "local" });
    const owners = (url: string) => [claudeArtifactPublisher(cfg), confluencePublisher(cfg), googleDocPublisher(cfg), localPublisher].filter(p => p.owns(url)).map(p => p.kind);
    expect(owners(ARTIFACT)).toEqual(["claude-artifact"]);
    expect(owners(CONFLUENCE)).toEqual(["confluence"]);
    expect(owners(GDOC)).toEqual(["google-doc"]);
    expect(owners(FILE)).toEqual(["local"]);
    expect(owners("https://example.com/page")).toEqual([]);
    expect(owners("https://evil.example/acme.atlassian.net/wiki/x")).toEqual([]);
    expect(owners("https://docs.google.com/spreadsheets/d/abc")).toEqual([]);
  });
  test("destinations declare the format their author step must produce", () => {
    const cfg = withReadme({ publisher: "local" });
    expect([claudeArtifactPublisher(cfg), localPublisher, confluencePublisher(cfg), googleDocPublisher(cfg)].map(p => p.format)).toEqual(["html", "html", "markdown", "markdown"]);
  });
});

describe("publisher selection", () => {
  test("selectPublisher uses the override, else the configured default", () => {
    const cfg = withReadme({ publisher: "confluence" });
    expect(selectPublisher(cfg).kind).toBe("confluence");
    expect(selectPublisher(cfg, "google-doc").kind).toBe("google-doc");
    expect(selectPublisher(base).kind).toBe("claude-artifact");
  });
  test("refresh with no override keeps the destination that owns the current URL", () => {
    const cfg = withReadme({ publisher: "local" });
    expect(selectReadmePublisher(cfg, CONFLUENCE).kind).toBe("confluence");
    expect(selectReadmePublisher(cfg, GDOC).kind).toBe("google-doc");
    expect(publisherOwning(cfg, ARTIFACT)?.kind).toBe("claude-artifact");
  });
  test("refresh falls back to the default when no destination owns the current URL", () => {
    const cfg = withReadme({ publisher: "google-doc" });
    expect(selectReadmePublisher(cfg, "https://example.com/linked").kind).toBe("google-doc");
    expect(selectReadmePublisher(cfg, null).kind).toBe("google-doc");
  });
  test("an override switches destination even when another one owns the current URL", () => {
    expect(selectReadmePublisher(withReadme({ publisher: "local" }), CONFLUENCE, "google-doc").kind).toBe("google-doc");
  });
});

describe("generateSessionReadme destinations", () => {
  const htmlAuthor = async function* (): AsyncIterable<AgentEvent> { yield { type: "text", text: "<<<README_HTML\n<html><title>Html Page</title></html>\nREADME_HTML>>>" }; };
  const fakePublisher = (format: "html" | "markdown", owns: (url: string) => boolean, result: { url: string; warning?: string }) => {
    const inputs: { file: string; title: string; existingUrl?: string | null }[] = [];
    const publisher: PagePublisher = { kind: format === "html" ? "local" : "confluence", label: "Fake", format, owns, async publish(input) { inputs.push(input); return result; } };
    return { inputs, publisher };
  };

  test("markdown destinations get the doc spec, write readme.md and take the title from the first heading", async () => {
    const session = createSession({ title: "Fallback" });
    let prompt = "";
    const runAuthor = async function* (opts: RunOptions): AsyncIterable<AgentEvent> { prompt = opts.prompt; yield { type: "text", text: "<<<README_MD\n# Widget Work\n\nLede.\nREADME_MD>>>" }; };
    const { inputs, publisher } = fakePublisher("markdown", () => true, { url: CONFLUENCE });
    const result = await generateSessionReadme(base, session.id, { runAuthor, publisher });
    expect(prompt.startsWith(README_DOC_SPEC)).toBe(true);
    expect(result.file.endsWith("readme.md")).toBe(true);
    expect(readFileSync(result.file, "utf8")).toBe("# Widget Work\n\nLede.\n");
    expect(inputs[0]!.title).toBe("Widget Work");
    expect(getSession(session.id)?.readme_url).toBe(CONFLUENCE);
  });

  test("html destinations get the page spec and write readme.html", async () => {
    const session = createSession({});
    let prompt = "";
    const runAuthor = async function* (opts: RunOptions): AsyncIterable<AgentEvent> { prompt = opts.prompt; yield* htmlAuthor(); };
    const { inputs, publisher } = fakePublisher("html", () => true, { url: FILE });
    const result = await generateSessionReadme(base, session.id, { runAuthor, publisher });
    expect(prompt.startsWith(README_PAGE_SPEC)).toBe(true);
    expect(result.file.endsWith("readme.html")).toBe(true);
    expect(inputs[0]!.title).toBe("Html Page");
  });

  test("existingUrl is passed only when the chosen destination owns the session's URL", async () => {
    const session = createSession({});
    setSessionReadme(session.id, { ref: null, url: ARTIFACT });
    const owning = fakePublisher("html", (u) => u === ARTIFACT, { url: ARTIFACT });
    await generateSessionReadme(base, session.id, { runAuthor: htmlAuthor, publisher: owning.publisher });
    expect(owning.inputs[0]!.existingUrl).toBe(ARTIFACT);
    const foreign = fakePublisher("html", () => false, { url: FILE });
    await generateSessionReadme(base, session.id, { runAuthor: htmlAuthor, publisher: foreign.publisher });
    expect(foreign.inputs[0]!.existingUrl).toBeNull();
    expect(getSession(session.id)?.readme_url).toBe(FILE);
  });

  test("a publisher warning is returned while the URL is still saved", async () => {
    const session = createSession({});
    const { publisher } = fakePublisher("html", () => true, { url: FILE, warning: "privacy unverified" });
    const result = await generateSessionReadme(base, session.id, { runAuthor: htmlAuthor, publisher });
    expect(result.warning).toBe("privacy unverified");
    expect(getSession(session.id)?.readme_url).toBe(FILE);
  });

  test("publisherKind override picks that destination's format", async () => {
    const session = createSession({});
    const result = await generateSessionReadme(withReadme({ publisher: "confluence" }), session.id, { runAuthor: htmlAuthor, publisherKind: "local" });
    expect(result.publisher).toBe("local");
    expect(result.file.endsWith("readme.html")).toBe(true);
    expect(result.url).toStartWith("file://");
  });
});

describe("extractReadmeMarkdown", () => {
  test("returns the marked Markdown and rejects output without markers", () => {
    expect(extractReadmeMarkdown("chatter <<<README_MD\n# Title\n| a | b |\nREADME_MD>>> trailing")).toBe("# Title\n| a | b |\n");
    expect(() => extractReadmeMarkdown("# Title only, no markers")).toThrow("no Markdown");
    expect(() => extractReadmeMarkdown("<<<README_MD\n \nREADME_MD>>>")).toThrow();
  });
});

describe("publish report parsing", () => {
  const ownsConfluence = (u: string) => confluencePublisher(base).owns(u);
  test("takes the last owned URL and the PRIVATE flag", () => {
    const report = `Created ${CONFLUENCE.replace("123", "1")}.\nUpdated.\nPUBLISHED_URL: ${CONFLUENCE}\nPRIVATE: yes`;
    expect(parsePublishReport(report, ownsConfluence)).toEqual({ url: CONFLUENCE, privacy: "yes" });
  });
  test("ignores URLs the destination does not own and defaults privacy to unverified", () => {
    expect(parsePublishReport(`See https://example.com/x\nPUBLISHED_URL: https://example.com/y`, ownsConfluence)).toEqual({ url: undefined, privacy: "unverified" });
  });
});

describe("Confluence publisher", () => {
  test("runs with the named Atlassian tools only and inherits the user's MCP servers", async () => {
    const { calls, runner } = recordingRunner(`PUBLISHED_URL: ${CONFLUENCE}\nPRIVATE: yes`);
    const cfg = withReadme({ publisher: "confluence", confluence: { mcpServer: "atl" } });
    expect(await confluencePublisher(cfg, runner).publish({ file: "/tmp/r/readme.md", title: "Widget" })).toEqual({ url: CONFLUENCE });
    const opts = calls[0]!;
    expect(opts.allowTools).toEqual(["Read", ...CONFLUENCE_TOOLS.map(t => `mcp__atl__${t}`)]);
    expect(opts.allowTools).not.toContain("mcp__atl");
    expect([opts.inheritUserMcp, opts.readOnly, opts.disallowShell, opts.model.runtime]).toEqual([true, true, true, "claude"]);
  });
  test("defaults the server name to Atlassian", async () => {
    const { calls, runner } = recordingRunner(`PUBLISHED_URL: ${CONFLUENCE}\nPRIVATE: yes`);
    await confluencePublisher(base, runner).publish({ file: "/tmp/r/readme.md", title: "Widget" });
    expect(calls[0]!.allowTools).toContain("mcp__Atlassian__createConfluencePage");
  });
  test("prompt creates a private markdown page in the personal space by default", () => {
    const prompt = confluencePrompt(base, { file: "/tmp/r/readme.md", title: "Widget" });
    for (const s of ["isPrivate: true", 'contentFormat: "markdown"', 'status: "current"', "atlassianUserInfo", "personal space", "getAccessibleAtlassianResources", "PUBLISHED_URL:", "PRIVATE: yes|no|unverified"]) expect(prompt).toContain(s);
    expect(prompt).not.toContain("updateConfluencePage");
  });
  test("prompt honours site, spaceKey and parentId, and updates an existing page in place", () => {
    const cfg = withReadme({ publisher: "confluence", confluence: { site: "acme.atlassian.net", spaceKey: "ENG", parentId: "42" } });
    const prompt = confluencePrompt(cfg, { file: "/tmp/r/readme.md", title: "Widget", existingUrl: CONFLUENCE });
    for (const s of ["acme.atlassian.net", "key ENG", 'parentId: "42"', `updateConfluencePage`, CONFLUENCE]) expect(prompt).toContain(s);
    expect(prompt).not.toContain("personal space");
  });
  test("a report without PRIVATE: yes keeps the URL with a warning", async () => {
    const { runner } = recordingRunner(`PUBLISHED_URL: ${CONFLUENCE}\nPRIVATE: unverified`);
    const result = await confluencePublisher(base, runner).publish({ file: "/tmp/r/readme.md", title: "Widget" });
    expect(result.url).toBe(CONFLUENCE);
    expect(result.warning).toContain("unverified");
  });
  test("no Confluence URL is an error naming the local file and the mcpServer setting", async () => {
    const { runner } = recordingRunner("I could not find the Atlassian tools.");
    const err = await confluencePublisher(base, runner).publish({ file: "/tmp/r/readme.md", title: "Widget" }).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("/tmp/r/readme.md");
    expect((err as Error).message).toContain("readme.confluence.mcpServer");
  });
});

describe("Google Doc publisher", () => {
  test("allows the whole Drive server by default and inherits the user's MCP servers", async () => {
    const { calls, runner } = recordingRunner(`PUBLISHED_URL: ${GDOC}\nPRIVATE: yes`);
    expect(await googleDocPublisher(base, runner).publish({ file: "/tmp/r/readme.md", title: "Widget" })).toEqual({ url: GDOC });
    expect(calls[0]!.allowTools).toEqual(["Read", "mcp__claude_ai_Google_Drive"]);
    expect([calls[0]!.inheritUserMcp, calls[0]!.readOnly, calls[0]!.disallowShell]).toEqual([true, true, true]);
  });
  test("an explicit tools list replaces the server-wide allow", async () => {
    const { calls, runner } = recordingRunner(`PUBLISHED_URL: ${GDOC}\nPRIVATE: yes`);
    await googleDocPublisher(withReadme({ publisher: "google-doc", googleDoc: { mcpServer: "gd", tools: ["mcp__gd__create_doc"] } }), runner).publish({ file: "/tmp/r/readme.md", title: "Widget" });
    expect(calls[0]!.allowTools).toEqual(["Read", "mcp__gd__create_doc"]);
  });
  test("prompt asks for an unshared native doc, verifies permissions and reports both lines", () => {
    const prompt = googleDocPrompt(withReadme({ publisher: "google-doc", googleDoc: { folderId: "F1" } }), { file: "/tmp/r/readme.md", title: "Widget", existingUrl: GDOC });
    for (const s of ["native Google Doc", "not an uploaded .md file", "folder with id F1", "Never add", "owner is the only permission", GDOC, "PUBLISHED_URL:", "PRIVATE:"]) expect(prompt).toContain(s);
    expect(googleDocPrompt(base, { file: "/tmp/r/readme.md", title: "W" })).toContain("My Drive");
  });
  test("PRIVATE: no keeps the URL with a warning; no doc URL is an error naming the mcpServer setting", async () => {
    const shared = await googleDocPublisher(base, recordingRunner(`PUBLISHED_URL: ${GDOC}\nPRIVATE: no`).runner).publish({ file: "/tmp/r/readme.md", title: "W" });
    expect(shared.warning).toContain("not private");
    const err = await googleDocPublisher(base, recordingRunner("PUBLISHED_URL: https://drive.google.com/file/d/x").runner).publish({ file: "/tmp/r/readme.md", title: "W" }).catch(e => e as Error);
    expect((err as Error).message).toContain("readme.googleDoc.mcpServer");
    expect((err as Error).message).toContain("/tmp/r/readme.md");
  });
});

describe("Claude runtime MCP isolation", () => {
  const build = (extra: Partial<RunOptions>) => (new ClaudeRuntime() as unknown as { buildCmd(o: unknown): string[] }).buildCmd({ model, bin: "claude", cwd: "/tmp", logPath: "/tmp/a", readOnly: true, disallowShell: true, allowTools: ["Read"], ...extra });
  test("runs stay strictly isolated to Tack's MCP servers by default", () => {
    const cmd = build({});
    expect(cmd).toContain("--mcp-config");
    expect(cmd).toContain("--strict-mcp-config");
  });
  test("inheritUserMcp drops --strict-mcp-config so user connectors load, keeping the edit denies", () => {
    const cmd = build({ inheritUserMcp: true });
    expect(cmd).not.toContain("--strict-mcp-config");
    expect(cmd).toContain("--mcp-config");
    expect(cmd.join(" ")).toContain("Bash,Edit,Write");
  });
});

describe("config and CLI flags", () => {
  test("schema accepts every publisher and the connector settings", () => {
    const parsed = ConfigSchema.parse({ roles: { supervisor: "a", agent: "a", summary: "a" }, readme: { publisher: "google-doc", confluence: { site: "acme.atlassian.net", spaceKey: "ENG", parentId: "1", mcpServer: "atl" }, googleDoc: { folderId: "F", mcpServer: "gd", tools: ["mcp__gd__x"] } } });
    expect(parsed.readme?.publisher).toBe("google-doc");
    expect(parsed.readme?.confluence?.spaceKey).toBe("ENG");
    expect(parsed.readme?.googleDoc?.tools).toEqual(["mcp__gd__x"]);
    for (const publisher of ["claude-artifact", "confluence", "local"]) expect(ConfigSchema.safeParse({ roles: { supervisor: "a", agent: "a", summary: "a" }, readme: { publisher } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ roles: { supervisor: "a", agent: "a", summary: "a" }, readme: { publisher: "notion" } }).success).toBe(false);
  });
  test("--to validates the kind and cannot be combined with --link, --unlink or --no-publish", () => {
    expect(readmeArgsConflict({ to: "confluence" })).toBeUndefined();
    expect(readmeArgsConflict({ to: "notion" })).toContain("--to must be one of");
    expect(readmeArgsConflict({ to: "local", link: "https://x" })).toContain("--to can't be combined");
    expect(readmeArgsConflict({ to: "local", unlink: true })).toContain("--to can't be combined");
    expect(readmeArgsConflict({ to: "local", publish: false })).toContain("--to can't be combined");
    expect(readmeArgsConflict({ link: "https://x", unlink: true })).toContain("mutually exclusive");
  });
});

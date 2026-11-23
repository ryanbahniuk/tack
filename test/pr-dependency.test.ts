import { afterEach, describe, expect, test } from "bun:test";
import { inferPackage, tagVersion, findRelease, type GhRunner } from "../src/prwatch/dependency";
import { buildPrFixPrompt, readyToPromote } from "../src/prwatch/watch";

describe("release dependencies", () => {
  test("infers packages from matching manifests", () => {
    expect(inferPackage({ Gemfile: "" }, { "x.gemspec": "spec.name = 'chime-schemas'" })).toEqual({ ecosystem: "ruby", package: "chime-schemas" });
    expect(inferPackage({ Gemfile: "" }, { "x.gemspec": "" })?.package).toBe("x");
    expect(inferPackage({ "package.json": "{}" }, { "package.json": '{"name":"@a/b"}' })?.package).toBe("@a/b");
    expect(inferPackage({ "requirements.txt": "" }, { "pyproject.toml": '[project]\nname = "python-pkg"\nversion = "1"\n' })?.package).toBe("python-pkg");
    expect(inferPackage({ "go.mod": "" }, { "go.mod": "module example.org/pkg\n" })?.package).toBe("example.org/pkg");
    expect(inferPackage({ Gemfile: "" }, { "go.mod": "module x" })).toBeNull();
  });
  test("parses stable versions", () => {
    expect(tagVersion("foo-v1.2.3", "foo")).toBe("1.2.3");
    expect(tagVersion("foo/1.2", "foo")).toBe("1.2");
    expect(tagVersion("foo@v1.0", "foo")).toBe("1.0");
    expect(tagVersion("pre-1.0", "foo")).toBeNull();
    expect(tagVersion("v1.0-rc1", "foo")).toBeNull();
  });
  test("chooses the oldest containing stable prefixed release", async () => {
    const runner: GhRunner = async args => {
      if (args[0] === "release") return JSON.stringify([
        { tagName: "pkg-v1.2", createdAt: "2025-02-01", isDraft: false, isPrerelease: false },
        { tagName: "pkg-v1.1", createdAt: "2025-01-02", isDraft: false, isPrerelease: false },
        { tagName: "pkg-v1.0-rc1", createdAt: "2025-01-01", isPrerelease: true },
      ]);
      if (args[1]?.includes("/tags?")) return "[]";
      return JSON.stringify({ status: "ahead" });
    };
    expect(await findRelease("/tmp", "o/r", "abc", "2025-01-01", "pkg", runner)).toEqual({ tag: "pkg-v1.1", version: "1.1" });
  });
  test("renders dependency as instructions", () => {
    const p = buildPrFixPrompt({ pr: { number: 1, title: null, url: "https://example", head_branch: null }, conflict: false, baseBranch: null, items: [{ sourceId: "dep:x:1", kind: "dependency_release", author: "Tack", url: "", body: "Package: pkg\nVersion: 1" }] });
    expect(p).toContain("## Dependency release");
    expect(p).toContain("Package: pkg");
    expect(p).not.toContain("> Package: pkg");
    expect(p).toContain("never hand-edit a lockfile");
  });
  test("unresolved dependency blocks promotion", () => {
    expect(readyToPromote({ enabled: true, autoReady: true, isDraft: true, readyPromotedAt: null, mergeable: "MERGEABLE", prFixBusy: false, freshCount: 0, releasedCount: 0, feedback: [], checks: [], allowedAuthors: [], unresolvedDependencies: 1 })).toBe(false);
  });
});

test("migration creates unique dependency declarations", async () => {
  const { Database } = await import("bun:sqlite");
  const { migrate } = await import("../src/db/migrate");
  const db = new Database(":memory:");
  migrate(db);
  const columns = db.query("PRAGMA table_info(pr_dependencies)").all() as { name: string }[];
  expect(columns.map(c => c.name)).toContain("released_version");
  expect(columns.map(c => c.name)).toContain("feedback_id");
  db.close();
});

test("orders releases and tag-only candidates by their dates", async () => {
  const calls: string[] = [];
  const runner: GhRunner = async args => {
    const target = args[1] ?? ""; calls.push(target);
    if (args[0] === "release") return JSON.stringify([{ tagName: "pkg-v2.0", createdAt: "2025-03-01T00:00:00Z", isDraft: false, isPrerelease: false }]);
    if (target.includes("/tags?")) return JSON.stringify([{ name: "pkg-v1.0", commit: { sha: "tag-commit" } }]);
    if (target.includes("/commits/")) return JSON.stringify({ commit: { committer: { date: "2025-02-01T00:00:00Z" } } });
    return JSON.stringify({ status: "ahead" });
  };
  expect(await findRelease("/tmp", "o/r", "merge", "2025-01-01T00:00:00Z", "pkg", runner)).toEqual({ tag: "pkg-v1.0", version: "1.0" });
  expect(calls.some(c => c.includes("commits/tag-commit"))).toBe(true);
});

import { createSession, deleteSession, createAgent, upsertSessionPr, listSessionPrs, insertPrDependency, listPrDependencies, updatePrDependency, listPrFeedback, assignPrFeedback, recordPrFeedbackDecision, getAgent, setAgentStatus, getDb, countPrFixRunsSince, hasUnresolvedDependencies } from "../src/db";
import { watchDependencies, postFix, prFixCapReached } from "../src/prwatch/watch";
import { writePrFeedbackArtifact } from "../src/artifacts/store";
import { buildConversationReplyBody } from "../src/projects/prs";
import type { TackConfig, Project } from "../src/config/schema";

const dependencySessions: string[] = [];
afterEach(() => { for (const id of dependencySessions.splice(0)) deleteSession(id); });
function dependencyFixture() {
  const session = createSession({}); dependencySessions.push(session.id);
  upsertSessionPr({ sessionId: session.id, url: `https://github.com/a/up/pull/1`, number: 1, projectName: "up", state: "open" });
  upsertSessionPr({ sessionId: session.id, url: `https://github.com/a/down/pull/2`, number: 2, projectName: "down", state: "draft" });
  const prs = listSessionPrs(session.id);
  const upstream = prs.find(p => p.number === 1)!;
  const downstream = prs.find(p => p.number === 2)!;
  insertPrDependency(session.id, downstream.id, upstream.id, "ruby", "pkg");
  const config = { projects: [{ name: "up", path: "/tmp" }, { name: "down", path: "/tmp" }], prWatch: { maxFixRunsPerDay: 1, reply: false, autoPush: true } } as TackConfig;
  const dependency = () => listPrDependencies(session.id)[0]!;
  return { session, upstream, downstream, config, dependency };
}
function polling(state: string, release: { tag: string; version: string } | null = null) {
  return {
    poll: async () => ({ state, mergeable: null, status: { state: state.toUpperCase(), mergedAt: "2025-01-01T00:00:00Z", mergeCommit: { oid: "merge-sha" }, mergeable: null, baseRefName: null, headRefOid: null, headRefName: null, url: "", title: null, comments: [], reviews: [] } }),
    release: async () => release,
  };
}
test("merge, release and fixed post-fix transition once and unblock promotion", async () => {
  const f = dependencyFixture();
  await watchDependencies(f.session, f.config, () => {}, polling("merged"));
  expect(f.dependency()).toMatchObject({ status: "waiting_release", merge_sha: "merge-sha", merged_at: "2025-01-01T00:00:00Z" });
  const release = polling("merged", { tag: "pkg-v1.2", version: "1.2" });
  await watchDependencies(f.session, f.config, () => {}, release);
  await watchDependencies(f.session, f.config, () => {}, release);
  const dep = f.dependency();
  expect(dep).toMatchObject({ status: "bump_queued", release_tag: "pkg-v1.2", released_version: "1.2" });
  const rows = listPrFeedback(f.downstream.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: dep.feedback_id, source_kind: "dependency_release", source_id: `dep:${dep.id}:1.2` });
  const agent = createAgent({ sessionId: f.session.id, projectName: "down", kind: "pr_fix", sessionPrId: f.downstream.id, fixOrigin: "dependency" });
  assignPrFeedback([rows[0]!.id], agent.id);
  const ref = writePrFeedbackArtifact(f.session.id, f.downstream.id, rows[0]!.source_id, "reply", "Updated to 1.2.");
  recordPrFeedbackDecision(rows[0]!.id, "fixed", ref);
  setAgentStatus(agent.id, "done");
  await postFix(getAgent(agent.id)!, f.downstream, { path: "/tmp" } as Project, f.config, () => {});
  expect(f.dependency().status).toBe("bumped");
  expect(hasUnresolvedDependencies(f.session.id)).toBe(false);
  expect(readyToPromote({ enabled: true, autoReady: true, isDraft: true, readyPromotedAt: null, mergeable: "MERGEABLE", prFixBusy: false, freshCount: 0, releasedCount: 0, feedback: listPrFeedback(f.downstream.id), checks: [], allowedAuthors: [], unresolvedDependencies: 0 })).toBe(true);
  const text = buildConversationReplyBody([{ kind: "dependency_release", url: f.upstream.url, author: "Tack", original: "Ecosystem: ruby", reply: "Updated to 1.2." }]);
  expect(text).toContain("[Upstream release]"); expect(text).toContain("Updated to 1.2."); expect(text).not.toContain("@Tack");
});
test("closed upstream is abandoned and waiting release times out", async () => {
  const a = dependencyFixture(); await watchDependencies(a.session, a.config, () => {}, polling("closed"));
  expect(a.dependency().status).toBe("abandoned");
  const b = dependencyFixture(); updatePrDependency(b.dependency().id, { status: "waiting_release", merge_sha: "x", merged_at: "2020-01-01T00:00:00Z" });
  getDb().prepare("UPDATE pr_dependencies SET updated_at = ? WHERE id = ?").run("2020-01-01T00:00:00Z", b.dependency().id);
  await watchDependencies(b.session, b.config, () => {}, polling("merged"));
  expect(b.dependency().status).toBe("timed_out");
});
for (const verdict of ["failed", "declined"] as const) test(`${verdict} dependency run is failed`, async () => {
  const f = dependencyFixture();
  await watchDependencies(f.session, f.config, () => {}, polling("merged", { tag: "v1.0", version: "1.0" }));
  const row = listPrFeedback(f.downstream.id)[0]!;
  const agent = createAgent({ sessionId: f.session.id, projectName: "down", kind: "pr_fix", sessionPrId: f.downstream.id, fixOrigin: "dependency" });
  assignPrFeedback([row.id], agent.id);
  if (verdict === "declined") recordPrFeedbackDecision(row.id, "declined", writePrFeedbackArtifact(f.session.id, f.downstream.id, row.source_id, "reply", "Unavailable"));
  setAgentStatus(agent.id, verdict === "failed" ? "failed" : "done");
  await postFix(getAgent(agent.id)!, f.downstream, { path: "/tmp" } as Project, f.config, () => {});
  expect(f.dependency()).toMatchObject({ status: "failed", detail: expect.any(String) });
});
test("dependency runs do not count towards the auto cap", () => {
  const f = dependencyFixture();
  createAgent({ sessionId: f.session.id, projectName: "down", kind: "pr_fix", sessionPrId: f.downstream.id, fixOrigin: "dependency" });
  expect(countPrFixRunsSince(f.downstream.id, "2000-01-01")).toBe(0);
  expect(prFixCapReached(f.downstream.id, f.config).reached).toBe(false);
  createAgent({ sessionId: f.session.id, projectName: "down", kind: "pr_fix", sessionPrId: f.downstream.id, fixOrigin: "auto" });
  expect(prFixCapReached(f.downstream.id, f.config)).toEqual({ reached: true, runs: 1 });
});

test("queued dependency starts despite the automatic fix cap", async () => {
  const { spyOn } = await import("bun:test");
  const prs = await import("../src/projects/prs");
  const detached = await import("../src/agent/detached");
  const worktrees = await import("../src/worktree/worktree");
  const { ConfigSchema } = await import("../src/config/schema");
  const { markAgentPostFixed, listPrFixAgents } = await import("../src/db");
  const { watchPr } = await import("../src/prwatch/watch");
  const f = dependencyFixture();
  const model = { key: "test", id: "test", name: "Test", runtime: "codex", provider: "test", version: "1" } as const;
  const config = ConfigSchema.parse({ models: [model], projects: [{ name: "down", path: "/tmp", description: "Test" }], roles: { agent: "test", supervisor: "test", summary: "test" } });
  config.roles = { agent: ["test"], supervisor: ["test"], summary: ["test"] };
  config.prWatch.maxFixRunsPerDay = 1;
  const prior = createAgent({ sessionId: f.session.id, projectName: "down", kind: "pr_fix", sessionPrId: f.downstream.id, fixOrigin: "auto" });
  setAgentStatus(prior.id, "failed"); markAgentPostFixed(prior.id, "failed");
  await watchDependencies(f.session, f.config, () => {}, polling("merged", { tag: "v1.0", version: "1.0" }));
  const spies = [
    spyOn(prs, "fetchPrStatus").mockResolvedValue({ state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseRefName: "main", headRefOid: "sha", headRefName: "pr", url: f.downstream.url, title: "PR", comments: [], reviews: [] }),
    spyOn(prs, "fetchReviewThreads").mockResolvedValue([]),
    spyOn(detached, "spawnAgentRunner").mockReturnValue(123),
    spyOn(worktrees, "fastForwardPrWorktree").mockResolvedValue({ base: "head" }),
  ];
  try {
    expect(prFixCapReached(f.downstream.id, config).reached).toBe(true);
    await watchPr(f.session, f.downstream, config, () => {});
    expect(listPrFixAgents(f.downstream.id).some(a => a.fix_origin === "dependency")).toBe(true);
    expect(prFixCapReached(f.downstream.id, config)).toEqual({ reached: true, runs: 1 });
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); }
});

test("open_pr validates upstream declarations before opening a PR", async () => {
  const { spyOn } = await import("bun:test");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const config = await import("../src/config/load");
  const { runSupervisorServer } = await import("../src/mcp/supervisor-server");
  const { setAgentWorktree, setAgentRefs } = await import("../src/db");
  const root = mkdtempSync(join(tmpdir(), "tack-dependency-validation-"));
  const session = createSession({}); const other = createSession({}); dependencySessions.push(session.id, other.id);
  const downstream = createAgent({ sessionId: session.id, projectName: "down" });
  setAgentWorktree(downstream.id, root, "down"); setAgentRefs(downstream.id, { diffRef: "/diff" });
  const same = createAgent({ sessionId: session.id, projectName: "down" });
  const foreign = createAgent({ sessionId: other.id, projectName: "up" });
  const upstream = createAgent({ sessionId: session.id, projectName: "up" });
  setAgentWorktree(upstream.id, root, "up");
  const cfg = { projects: [{ name: "down", path: root }, { name: "up", path: root }], personas: [], prWatch: { enabled: false } } as TackConfig;
  const spies = [spyOn(config, "loadConfig").mockResolvedValue(cfg), spyOn(McpServer.prototype, "connect").mockResolvedValue()];
  const register = spyOn(McpServer.prototype, "registerTool");
  try {
    await runSupervisorServer(session.id);
    const handler = register.mock.calls.find(([name]) => name === "open_pr")![2] as unknown as (input: unknown) => Promise<unknown>;
    const call = (id: string) => handler({ agentId: downstream.id, title: "test", body: "test", awaitsRelease: [{ agentId: id }] });
    await expect(call(foreign.id)).rejects.toThrow("not in this session");
    await expect(call(same.id)).rejects.toThrow("different project");
    await expect(call(upstream.id)).rejects.toThrow("no session PR");
    upsertSessionPr({ sessionId: session.id, url: "https://github.com/a/up/pull/1", agentId: upstream.id, projectName: "up", number: 1, state: "open" });
    writeFileSync(join(root, "Gemfile"), "");
    await expect(call(upstream.id)).rejects.toThrow("Cannot infer a shared package");
  } finally { register.mockRestore(); for (const spy of spies.reverse()) spy.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("report_pr_feedback accepts dependency source IDs", async () => {
  const { spyOn } = await import("bun:test");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { runCoordinationServer } = await import("../src/mcp/coordination-server");
  const f = dependencyFixture(); await watchDependencies(f.session, f.config, () => {}, polling("merged", { tag: "v1.0", version: "1.0" }));
  const row = listPrFeedback(f.downstream.id)[0]!;
  const agent = createAgent({ sessionId: f.session.id, projectName: "down", kind: "pr_fix", sessionPrId: f.downstream.id });
  assignPrFeedback([row.id], agent.id);
  const connect = spyOn(McpServer.prototype, "connect").mockResolvedValue();
  const register = spyOn(McpServer.prototype, "registerTool");
  try {
    await runCoordinationServer(f.session.id, agent.id);
    const call = register.mock.calls.find(([name]) => name === "report_pr_feedback")!;
    const schema = (call[1] as any).inputSchema.items;
    const input = schema.parse([{ sourceId: row.source_id, decision: "fixed", reply: "Updated." }]);
    const handler = call[2] as unknown as (value: unknown) => Promise<unknown>;
    await handler({ items: input });
    expect(listPrFeedback(f.downstream.id)[0]!.decision).toBe("fixed");
  } finally { register.mockRestore(); connect.mockRestore(); }
});

test("skips prereleases and non-containing tags, and prefers package tags", async () => {
  const comparisons: string[] = [];
  const runner: GhRunner = async args => {
    const target = args[1] ?? "";
    if (args[0] === "release") return JSON.stringify([
      { tagName: "pkg-v0.9", createdAt: "2025-01-02T00:00:00Z", isDraft: false, isPrerelease: true },
      { tagName: "pkg-v1.0", createdAt: "2025-01-03T00:00:00Z", isDraft: false, isPrerelease: false },
      { tagName: "pkg-v1.1", createdAt: "2025-01-04T00:00:00Z", isDraft: false, isPrerelease: false },
      { tagName: "v0.8", createdAt: "2025-01-01T01:00:00Z", isDraft: false, isPrerelease: false },
    ]);
    if (target.includes("/tags?")) return JSON.stringify([{ name: "pre-1.0", commit: { sha: "pre" } }]);
    comparisons.push(target);
    return JSON.stringify({ status: target.endsWith("pkg-v1.0") ? "behind" : "ahead" });
  };
  expect(await findRelease("/tmp", "o/r", "sha", "2025-01-01T00:00:00Z", "pkg", runner)).toEqual({ tag: "pkg-v1.1", version: "1.1" });
  expect(comparisons).toHaveLength(2);
  expect(comparisons.every(c => !c.includes("0.9") && !c.includes("pre-"))).toBe(true);
});

test("post-fix publishes a useful dependency reply", async () => {
  const { spyOn } = await import("bun:test");
  const prs = await import("../src/projects/prs");
  const f = dependencyFixture();
  await watchDependencies(f.session, f.config, () => {}, polling("merged", { tag: "v1.0", version: "1.0" }));
  const row = listPrFeedback(f.downstream.id)[0]!;
  const agent = createAgent({ sessionId: f.session.id, projectName: "down", kind: "pr_fix", sessionPrId: f.downstream.id });
  assignPrFeedback([row.id], agent.id);
  recordPrFeedbackDecision(row.id, "fixed", writePrFeedbackArtifact(f.session.id, f.downstream.id, row.source_id, "reply", "Updated pkg to 1.0."));
  setAgentStatus(agent.id, "done");
  const post = spyOn(prs, "postIssueComment").mockResolvedValue("https://github.com/comment/1");
  try {
    await postFix(getAgent(agent.id)!, f.downstream, { path: "/tmp" } as Project, { ...f.config, prWatch: { ...f.config.prWatch, reply: true } }, () => {});
    const body = post.mock.calls[0]![2];
    expect(body).toContain("[Upstream release]"); expect(body).toContain("Updated pkg to 1.0.");
    expect(body).not.toContain("@Tack"); expect(body).toContain(prs.PR_WATCH_MARKER);
    expect(f.dependency().status).toBe("bumped");
  } finally { post.mockRestore(); }
});


test("description reporting is available only to fix agents and replaces the proposal", async () => {
  const { spyOn } = await import("bun:test");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { runCoordinationServer } = await import("../src/mcp/coordination-server");
  const { readPrDescription } = await import("../src/artifacts/store");
  const f = dependencyFixture();
  const fix = createAgent({ sessionId: f.session.id, projectName: "down", kind: "pr_fix", sessionPrId: f.downstream.id });
  const other = createAgent({ sessionId: f.session.id, projectName: "down" });
  const connect = spyOn(McpServer.prototype, "connect").mockResolvedValue();
  const register = spyOn(McpServer.prototype, "registerTool");
  try {
    await runCoordinationServer(f.session.id, other.id);
    expect(register.mock.calls.some(([name]) => name === "report_pr_description")).toBe(false);
    register.mockClear();
    await runCoordinationServer(f.session.id, fix.id);
    const call = register.mock.calls.find(([name]) => name === "report_pr_description")!;
    expect((call[1] as any).inputSchema.body.safeParse("").success).toBe(false);
    const handler = call[2] as unknown as (value: unknown) => Promise<unknown>;
    await handler({ body: "First" });
    await handler({ body: "Second" });
    expect(readPrDescription(f.session.id, fix.id, "proposed")).toBe("Second");
  } finally { register.mockRestore(); connect.mockRestore(); }
});

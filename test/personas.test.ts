import { afterEach, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, modelForPersona, resolvePersona } from "../src/config/load";
import { migrate } from "../src/db/migrate";
import { approveSessionPlan, createAgent, createSession, deleteSession, getAgent, getDb, setAgentReviewRef, setAgentRefs, setAgentStatus, setAgentWorktree, setAgentResumeRef } from "../src/db";
import { writeAgentArtifact } from "../src/artifacts/store";
import { agentDisplayStatus } from "../src/cli/liveness";
import { createReviewWorktree, ensureReviewWorktree, worktreeDiff } from "../src/worktree/worktree";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSupervisorServer } from "../src/mcp/supervisor-server";
import { runCoordinationServer } from "../src/mcp/coordination-server";
import { prepareContinuation } from "../src/agent/continue";
import * as configLoad from "../src/config/load";
import * as detached from "../src/agent/detached";
import * as availability from "../src/runtimes/availability";

const mocks: Array<{ mockRestore(): void }> = [];
const dirs: string[] = [];
const sessions: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "tack-personas-")); dirs.push(dir); return dir; }
afterEach(() => {
  for (const m of mocks.splice(0).reverse()) m.mockRestore();
  for (const id of sessions.splice(0)) deleteSession(id);
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
async function config(personas?: unknown) {
  const path = join(temp(), "config.ts");
  writeFileSync(path, "export default " + JSON.stringify({
    models: ["a", "b", "c"].map(key => ({ key, name: key, id: key, provider: "test", runtime: "codex", version: "1" })),
    roles: { supervisor: "a", agent: ["a", "b", "c"], summary: "a" }, personas,
  }));
  return loadConfig(path);
}

test("personas default empty and normalize strings, lists and omitted models", async () => {
  expect((await config()).personas).toEqual([]);
  const c = await config([
    { name: "strict", description: "Exact instructions", whenToUse: "Use for code; skip for docs", model: "a" },
    { name: "impl", description: "Check implementation", whenToUse: "Use for code; skip for docs", model: ["b", "a", "b"] },
    { name: "design", description: "Check design", whenToUse: "Use for code; skip for docs" },
  ]);
  expect(c.personas.map(p => p.model)).toEqual([["a"], ["b", "a"], []]);
  expect(resolvePersona(c, "strict").description).toBe("Exact instructions");
  expect(() => resolvePersona(c, "typo")).toThrow('Known: strict, impl, design');
});

test("legacy whenToUse is ignored", async () => {
  const c = await config([{ name: "legacy", description: "Review", whenToUse: "old rule" }, { name: "new", description: "Review" }]);
  expect(c.personas[0]).not.toHaveProperty("whenToUse");
});

test("persona validation identifies duplicate names and unknown model keys", async () => {
  await expect(config([{ name: "x", description: "x", whenToUse: "Use for code; skip for docs" }, { name: "x", description: "y", whenToUse: "Use for code; skip for docs" }]))
    .rejects.toThrow('Duplicate persona name "x"');
  await expect(config([{ name: "x", description: "x", whenToUse: "Use for code; skip for docs", model: ["a", "missing"] }]))
    .rejects.toThrow('personas.x.model = "missing" is not a defined model. Known: a, b, c');
  await expect(config([{ name: "x", description: "x", whenToUse: "Use for code; skip for docs", model: [] }])).rejects.toThrow();
});

test("review models prefer different candidates uniformly and fall back to author or roles.agent", async () => {
  const c = await config([{ name: "x", description: "x", whenToUse: "Use for code; skip for docs", model: ["a", "b", "c"] }]);
  const p = c.personas[0]!;
  expect(modelForPersona(c, p, { avoidKey: "a", rng: () => 0 }).key).toBe("b");
  expect(modelForPersona(c, p, { avoidKey: "a", rng: () => .5 }).key).toBe("c");
  expect(modelForPersona(c, { ...p, model: ["a"] }, { avoidKey: "a", rng: () => { throw Error("single"); } }).key).toBe("a");
  expect(modelForPersona(c, { ...p, model: [] }, { avoidKey: "b", rng: () => .99 }).key).toBe("c");
});

test("review migration is idempotent and report refs round trip", () => {
  const db = new Database(":memory:");
  migrate(db); migrate(db);
  const columns = db.query("PRAGMA table_info(agents)").all() as { name: string }[];
  for (const name of ["persona", "reviews_agent_id", "review_ref"]) expect(columns.map(c => c.name)).toContain(name);
  db.close();
  const session = createSession({}); sessions.push(session.id);
  const author = createAgent({ sessionId: session.id, projectName: "test" });
  const review = createAgent({ sessionId: session.id, projectName: "test", kind: "review", persona: "strict", reviewsAgentId: author.id });
  const report = { verdict: "approve", summary: "Looks good", findings: [] };
  const ref = writeAgentArtifact(session.id, review.id, "review", JSON.stringify(report));
  setAgentReviewRef(review.id, ref);
  const row = getAgent(review.id)!;
  expect(row.reviews_agent_id).toBe(author.id);
  expect(row.persona).toBe("strict");
  expect(JSON.parse(readFileSync(row.review_ref!, "utf8"))).toEqual(report);
  expect(agentDisplayStatus(row).label).toBe("approve");
});

test("review worktrees fork the local author head, preserve baseline and reuse experiments", () => {
  const repo = temp();
  function git(...args: string[]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status) throw Error(result.stderr);
    return result.stdout.trim();
  }
  git("init", "-b", "main"); git("config", "commit.gpgsign", "false"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  writeFileSync(join(repo, "file"), "base\n"); git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "author"); writeFileSync(join(repo, "file"), "review me\n"); git("commit", "-am", "author work");
  const head = git("rev-parse", "HEAD"); git("checkout", "main");
  const session = createSession({}); sessions.push(session.id);
  const tree = createReviewWorktree(repo, session.id, "review-test", "author", base);
  expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: tree.path, encoding: "utf8" }).stdout.trim()).toBe(head);
  expect(tree.base).toBe(base);
  expect(worktreeDiff(tree)).toContain("+review me");
  writeFileSync(join(tree.path, "file"), "experiment\n");
  expect(ensureReviewWorktree(repo, session.id, "review-test", "missing", "missing")).toEqual(tree);
  expect(readFileSync(join(tree.path, "file"), "utf8")).toBe("experiment\n");
  git("worktree", "remove", "--force", tree.path);
});

// Capture registered handlers as in agent-continuation tests; no runtimes are launched.
async function toolsFor(start: () => Promise<void>) {
  mocks.push(spyOn(McpServer.prototype, "connect").mockResolvedValue());
  const register = spyOn(McpServer.prototype, "registerTool"); mocks.push(register);
  await start();
  const handlers = new Map(register.mock.calls.map(c => [c[0], c[2]]));
  return async (name: string, args = {}) => {
    const handler = handlers.get(name) as unknown as (args: unknown) => Promise<{ content: { text: string }[] }>;
    return JSON.parse((await handler(args)).content[0]!.text);
  };
}

test("review tools validate targets, choose models, honor overrides and expose reports", async () => {
  const c = await config([{ name: "strict", description: "Find bugs", whenToUse: "Use for code; skip for docs", model: ["a", "b"] }]);
  c.projects = [{ name: "app", path: "/tmp", description: "App" }];
  const session = createSession({}); sessions.push(session.id);
  const author = createAgent({ sessionId: session.id, projectName: "app", model: "a", runtime: "codex" });
  setAgentStatus(author.id, "done"); setAgentWorktree(author.id, "/tmp", "author");
  getDb().run("UPDATE agents SET diff_base = 'base' WHERE id = ?", [author.id]);
  setAgentRefs(author.id, { diffRef: writeAgentArtifact(session.id, author.id, "diff", "diff"), outputRef: null });
  mocks.push(spyOn(configLoad, "loadConfig").mockResolvedValue(c));
  const spawn = spyOn(detached, "spawnAgentRunner").mockReturnValue(123); mocks.push(spawn);
  const offered = spyOn(availability, "checkModelOffered").mockReturnValue({ ok: true }); mocks.push(offered);
  const call = await toolsFor(() => runSupervisorServer(session.id));
  expect(await call("list_personas")).toEqual(c.personas);
  expect((await call("list_personas"))[0].whenToUse).toBeUndefined();
  const args = { agentId: author.id, persona: "strict" };
  await expect(call("review_agent", args)).rejects.toThrow("Plan not approved");
  approveSessionPlan(session.id);
  await expect(call("review_agent", { ...args, persona: "typo" })).rejects.toThrow("Unknown persona");
  await expect(call("review_agent", { ...args, agentId: "missing" })).rejects.toThrow("not in this session");
  setAgentStatus(author.id, "running");
  await expect(call("review_agent", args)).rejects.toThrow("must be done");
  setAgentStatus(author.id, "done");
  getDb().run("UPDATE agents SET kind = 'pr_fix' WHERE id = ?", [author.id]);
  await expect(call("review_agent", args)).rejects.toThrow("Only normal worker");
  getDb().run("UPDATE agents SET kind = NULL, diff_ref = NULL WHERE id = ?", [author.id]);
  await expect(call("review_agent", args)).rejects.toThrow("no diff");
  setAgentRefs(author.id, { diffRef: writeAgentArtifact(session.id, author.id, "diff", "diff"), outputRef: null });
  offered.mockReturnValueOnce({ ok: false, message: "not offered" });
  await expect(call("review_agent", args)).rejects.toThrow("not offered");
  expect(spawn).not.toHaveBeenCalled();
  const review = await call("review_agent", { ...args, prompt: "Focus on races" });
  expect(review).toMatchObject({ persona: "strict", model: "b", reviews: author.id });
  expect(getAgent(review.agentId)).toMatchObject({ kind: "review", persona: "strict", reviews_agent_id: author.id });
  expect(readFileSync(getAgent(review.agentId)!.prompt_ref!, "utf8")).toContain("Focus on races");
  const overridden = await call("review_agent", { ...args, model: "a" });
  expect(overridden.model).toBe("a");
  await expect(call("review_agent", { ...args, agentId: review.agentId })).rejects.toThrow("Only normal worker");
  await expect(call("open_pr", { agentId: review.agentId, title: "No", body: "No" })).rejects.toThrow("cannot open PRs");
  const report = { verdict: "changes_requested", summary: "Race", findings: [{ severity: "major", file: "app.ts", line: 3, title: "Race", detail: "Concurrent updates are lost." }] };
  const reportCall = await toolsFor(() => runCoordinationServer(session.id, review.agentId));
  expect(await reportCall("report_review", report)).toEqual({ ok: true });
  await expect(reportCall("report_review", report)).rejects.toThrow("already reported");
  expect((await call("read_agent_output", { agentId: review.agentId })).review).toEqual(report);
  const workerCall = await toolsFor(() => runCoordinationServer(session.id, author.id));
  await expect(workerCall("report_review", report)).rejects.toThrow("only available to review agents");
  // Follow-up questions retain both the review identity and its original report.
  setAgentWorktree(review.agentId, "/tmp", "review"); setAgentStatus(review.agentId, "done"); setAgentResumeRef(review.agentId, "conversation");
  const continued = prepareContinuation(session.id, review.agentId, "Explain the race", c);
  expect(continued.kind).toBe("review");
  expect(continued.review_ref).toBe(getAgent(review.agentId)!.review_ref);
});

test("open_pr does not require persona reviews", async () => {
  const prs = await import("../src/projects/prs");
  const worktree = await import("../src/worktree/worktree");
  const watch = await import("../src/prwatch/watch");
  const c = await config([{ name: "strict", description: "Find bugs", whenToUse: "Use for code; skip docs" }]);
  c.projects = [{ name: "app", path: "/tmp", description: "App" }];
  c.prWatch.enabled = false;
  const session = createSession({}); sessions.push(session.id);
  const author = createAgent({ sessionId: session.id, projectName: "app" });
  setAgentWorktree(author.id, "/tmp", "author");
  setAgentRefs(author.id, { diffRef: "/diff" });
  const open = spyOn(prs, "openSessionPr").mockResolvedValue({ url: "https://github.com/acme/app/pull/1", number: 1, headBranch: "pr" }); mocks.push(open);
  const commit = spyOn(worktree, "commitWorktreeAsync").mockResolvedValue(false); mocks.push(commit);
  mocks.push(spyOn(worktree, "syncBranchWithBase").mockResolvedValue({ status: "up_to_date", base: "main", fetched: true }));
  mocks.push(spyOn(watch, "spawnPrWatcher").mockReturnValue(null));
  mocks.push(spyOn(configLoad, "loadConfig").mockResolvedValue(c));
  const call = await toolsFor(() => runSupervisorServer(session.id));
  const args = { agentId: author.id, title: "  Change\nbehavior  ", body: "Details" };
  await call("open_pr", args);
  expect(commit).toHaveBeenCalledWith("/tmp", "Change behavior");
  expect(open.mock.calls.at(-1)![0].body).toBe("Details");
});

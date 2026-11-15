import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareContinuation } from "../src/agent/continue";
import { prepareAgent, runAgent } from "../src/agent/execute";
import { runAgentToCompletion } from "../src/agent/detached";
import * as detached from "../src/agent/detached";
import * as availability from "../src/runtimes/availability";
import * as resolution from "../src/runtimes/resolve";
import * as worktrees from "../src/worktree/worktree";
import { ClaudeRuntime } from "../src/runtimes/claude";
import { CodexRuntime } from "../src/runtimes/codex";
import type { AgentEvent, RunOptions } from "../src/runtimes/types";
import { ConfigSchema, type Model, type TackConfig } from "../src/config/schema";
import * as configLoad from "../src/config/load";
import { migrate } from "../src/db/migrate";
import {
  approveSessionPlan, createAgent, createSession, deleteSession, getAgent, getDb, listSessionPrs,
  markAgentPostFixed, setAgentCost, setAgentResumeRef, setAgentStatus, setAgentUsage, setAgentWorktree, upsertSessionPr,
} from "../src/db";
import { readArtifact } from "../src/artifacts/store";
import { prContinuationDecision, prLineageHead, spawnPrFixAgent } from "../src/prwatch/watch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSupervisorServer } from "../src/mcp/supervisor-server";

const mocks: Array<{ mockRestore(): void }> = [];
const sessions: string[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const m of mocks.splice(0).reverse()) m.mockRestore();
  for (const id of sessions.splice(0)) deleteSession(id);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const model: Model = { key: "test", id: "test", name: "Test", runtime: "codex", provider: "test", version: "1" };
const other: Model = { ...model, key: "other", runtime: "claude" };
function fixture() {
  const session = createSession({});
  sessions.push(session.id);
  approveSessionPlan(session.id);
  const project = { name: "app", path: "/tmp", description: "Test" };
  const config = ConfigSchema.parse({ models: [model, other], projects: [project], roles: { agent: "test", supervisor: "test", summary: "test" } }) as unknown as TackConfig;
  config.roles = { agent: ["test"], supervisor: ["test"], summary: ["test"] };
  const a = prepareAgent({ session, project, model, prompt: "Original assignment" });
  setAgentStatus(a.id, "done");
  setAgentResumeRef(a.id, "conversation");
  setAgentWorktree(a.id, "/tmp", "tack/test");
  mocks.push(spyOn(availability, "checkModelOffered").mockReturnValue({ ok: true }));
  upsertSessionPr({ sessionId: session.id, agentId: a.id, projectName: "app", number: 1,
    url: "https://example.com/pull/1", state: "closed", headBranch: "pr-branch" });
  const pr = listSessionPrs(session.id)[0]!;
  return { session, project, config, a: getAgent(a.id)!, pr };
}
function mockRuntime(seen: RunOptions[], events: AgentEvent[]) {
  mocks.push(spyOn(resolution, "resolveRuntime").mockReturnValue({ kind: "codex", bin: "codex", version: "test", policy: "off", satisfied: true }));
  mocks.push(spyOn(worktrees, "existingWorktree").mockReturnValue({ repo: "/tmp", path: "/tmp", branch: "tack/test", base: "base" }));
  mocks.push(spyOn(worktrees, "worktreeDiff").mockReturnValue(""));
  mocks.push(spyOn(CodexRuntime.prototype, "run").mockImplementation(async function* (opts: RunOptions) {
    seen.push(opts);
    yield* events;
  }));
}

test("continue_agent queues same row through the supervisor tool and preserves prompt artifacts", async () => {
  const { session, config, a } = fixture();
  mocks.push(spyOn(configLoad, "loadConfig").mockResolvedValue(config));
  mocks.push(spyOn(detached, "spawnAgentRunner").mockReturnValue(123));
  mocks.push(spyOn(McpServer.prototype, "connect").mockResolvedValue());
  const register = spyOn(McpServer.prototype, "registerTool"); mocks.push(register);
  await runSupervisorServer(session.id);
  const handler = register.mock.calls.find(c => c[0] === "continue_agent")![2] as unknown as
    (args: { agentId: string; prompt: string }) => Promise<unknown>;
  await handler({ agentId: a.id, prompt: "Follow up" });
  const first = getAgent(a.id)!;
  expect(first.status).toBe("pending");
  expect(readArtifact(first.prompt_ref)).toBe("Original assignment");
  expect(readArtifact(first.continuation_prompt_ref)).toBe("Follow up");
  setAgentStatus(a.id, "failed");
  prepareContinuation(session.id, a.id, "Try again", config);
  expect(getAgent(a.id)!.continuation_prompt_ref).not.toBe(first.continuation_prompt_ref);
  expect(readArtifact(first.continuation_prompt_ref)).toBe("Follow up");
});

for (const refusal of ["session", "pending", "running", "stopped", "pr_fix", "open", "draft", "resume", "worktree", "runtime", "plan"] as const) {
  test(`continue_agent refuses ${refusal} with remediation`, () => {
    const { session, config, a, pr } = fixture();
    let sessionId = session.id;
    const expected: Record<typeof refusal, string> = {
      session: "spawn_agent", pending: "wait_for_agents", running: "wait_for_agents", stopped: "wait_for_agents",
      pr_fix: "fix_pr", open: "fix_pr", draft: "fix_pr", resume: "spawn_agent",
      worktree: "spawn_agent", runtime: "spawn_agent", plan: "request_plan_approval",
    };
    if (refusal === "session") { const s = createSession({}); sessions.push(s.id); approveSessionPlan(s.id); sessionId = s.id; }
    if (["pending", "running", "stopped"].includes(refusal)) setAgentStatus(a.id, refusal as "pending");
    if (refusal === "pr_fix") getDb().run("UPDATE agents SET kind = 'pr_fix' WHERE id = ?", [a.id]);
    if (refusal === "open" || refusal === "draft") getDb().run("UPDATE session_prs SET state = ? WHERE id = ?", [refusal, pr.id]);
    if (refusal === "resume") getDb().run("UPDATE agents SET resume_ref = NULL WHERE id = ?", [a.id]);
    if (refusal === "worktree") setAgentWorktree(a.id, "/missing-continuation-worktree", "branch");
    if (refusal === "plan") getDb().run("UPDATE sessions SET plan_approved_at = NULL WHERE id = ?", [session.id]);
    expect(() => prepareContinuation(sessionId, a.id, "Next", config, refusal === "runtime" ? "other" : undefined))
      .toThrow(expected[refusal]);
    expect(getAgent(a.id)!.continuation_prompt_ref).toBeNull();
  });
}

test("continuation resumes with next turn; streaming totals add once per run, output is latest", async () => {
  const { session, config, a } = fixture();
  setAgentCost(a.id, 3, "pricing");
  setAgentUsage(a.id, { input: 100, output: 10, cacheRead: 20, cacheWrite: 30 });
  prepareContinuation(session.id, a.id, "Next turn", config);
  const seen: RunOptions[] = [];
  mockRuntime(seen, [
    { type: "session", ref: "child" },
    { type: "usage", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    { type: "usage", input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
    { type: "cost", usd: 1, source: "pricing" }, { type: "cost", usd: 2, source: "pricing" },
    { type: "done", ok: true, summary: "Latest" },
  ]);
  for await (const _ of runAgent(a.id, config)) {}
  expect(seen[0]).toMatchObject({ resume: true, fork: true, sessionRef: "conversation", prompt: "Next turn", cwd: "/tmp" });
  expect(getAgent(a.id)).toMatchObject({ cost: 5, tokens_input: 105, tokens_output: 16, cache_read: 27, cache_write: 38, resume_ref: "child" });
  expect(readArtifact(getAgent(a.id)!.output_ref)).toBe("Latest");
  for await (const _ of runAgent(a.id, config, { resume: true })) {}
  expect(seen[1]).toMatchObject({ resume: true, fork: false, sessionRef: "child" });
});

test("transient continuation retry keeps the conversation", async () => {
  const { session, config, a } = fixture();
  prepareContinuation(session.id, a.id, "Next", config);
  const seen: RunOptions[] = [];
  mockRuntime(seen, []);
  mocks.push(spyOn(CodexRuntime.prototype, "run").mockImplementation(async function* (opts: RunOptions): AsyncGenerator<AgentEvent> {
    seen.push(opts);
    yield { type: "session", ref: "child" };
    if (seen.length === 1) { yield { type: "error", message: "429 overloaded" }; yield { type: "done", ok: false }; }
    else yield { type: "done", ok: true };
  }));
  await runAgentToCompletion(a.id, config);
  expect(seen).toHaveLength(2);
  expect(seen[1]).toMatchObject({ resume: true, fork: false, sessionRef: "child" });
  expect(seen[1]!.prompt).not.toBe("Original assignment");
}, 15000);

for (const reason of ["eligible", "reuse disabled", "fresh requested", "head is not done", "runtime mismatch",
  "idle window exceeded", "dirty worktree", "non-fast-forwardable head", "missing resume_ref", "worktree missing"] as const) {
  test(`PR continuation decision: ${reason}`, async () => {
    const { config, a, pr } = fixture();
    if (reason === "reuse disabled") config.agentReuse.enabled = false;
    if (reason === "head is not done") setAgentStatus(a.id, "failed");
    if (reason === "missing resume_ref") getDb().run("UPDATE agents SET resume_ref = NULL WHERE id = ?", [a.id]);
    if (reason === "idle window exceeded") getDb().run("UPDATE agents SET finished_at = '2000-01-01T00:00:00Z' WHERE id = ?", [a.id]);
    if (reason === "worktree missing") setAgentWorktree(a.id, "/missing-continuation-worktree", "branch");
    mocks.push(spyOn(worktrees, "fastForwardPrWorktree").mockResolvedValue(
      reason === "dirty worktree" || reason === "non-fast-forwardable head" ? { reason } : { base: "start-sha" }));
    const result = await prContinuationDecision(pr, reason === "runtime mismatch" ? other : model, config, reason === "fresh requested");
    if (reason === "eligible") expect(result).toMatchObject({ head: { id: a.id }, base: "start-sha" });
    else expect(result).toEqual({ head: null, reason });
  });
}

test("lineage selection skips runtime and post-fix failures; continuation row reuses cwd with a per-run diff", async () => {
  const { session, project, config, a, pr } = fixture();
  const good = createAgent({ sessionId: session.id, projectName: "app", model: model.key, runtime: "codex", kind: "pr_fix", sessionPrId: pr.id });
  setAgentStatus(good.id, "done"); markAgentPostFixed(good.id, "pushed", "sha");
  setAgentResumeRef(good.id, "latest"); setAgentWorktree(good.id, "/tmp", "lineage-branch");
  for (const outcome of ["failed", "push_rejected"] as const) {
    const bad = createAgent({ sessionId: session.id, projectName: "app", kind: "pr_fix", sessionPrId: pr.id });
    setAgentStatus(bad.id, outcome === "failed" ? "failed" : "done"); markAgentPostFixed(bad.id, outcome);
  }
  expect(prLineageHead(pr)!.id).toBe(good.id);
  mocks.push(spyOn(worktrees, "fastForwardPrWorktree").mockResolvedValue({ base: "run-base" }));
  mocks.push(spyOn(detached, "spawnAgentRunner").mockReturnValue(123));
  const result = await spawnPrFixAgent(session, pr, project, config, { origin: "supervisor", conflict: false, baseBranch: "main", title: "PR" });
  expect(result.continued).toBe(good.id);
  expect(result.agent).toMatchObject({ continues_agent_id: good.id, resume_ref: "latest", worktree_path: "/tmp", branch: "lineage-branch", diff_base: "run-base", cost: 0 });
  expect(result.agent.id).not.toBe(a.id);
  const seen: RunOptions[] = []; mockRuntime(seen, [{ type: "done", ok: true }]);
  const diff = spyOn(worktrees, "worktreeDiff").mockReturnValue("only this run"); mocks.push(diff);
  for await (const _ of runAgent(result.agent.id, config)) {}
  expect(diff.mock.calls[0]![1]).toBe("run-base");
  expect(seen[0]).toMatchObject({ resume: true, fork: true, sessionRef: "latest", cwd: "/tmp" });
  expect(seen[0]!.prompt).toContain("PR");
});

test("runtime argv: Claude forks only when supported; Codex resume ignores fork", () => {
  const dir = mkdtempSync(join(tmpdir(), "tack-fork-")); dirs.push(dir);
  const bin = join(dir, "claude");
  writeFileSync(bin, "#!/bin/sh\necho --fork-session\n"); chmodSync(bin, 0o755);
  const opts: RunOptions = { bin, cwd: dir, prompt: "Next", model: other, resume: true, fork: true, sessionRef: "ref" };
  const cmd = (runtime: object, options: RunOptions) => (runtime as { buildCmd(o: RunOptions): string[] }).buildCmd(options);
  expect(cmd(new ClaudeRuntime(), opts)).toContain("--fork-session");
  expect(cmd(new ClaudeRuntime(), opts)).toContain("ref");
  const old = join(dir, "old"); writeFileSync(old, "#!/bin/sh\necho old\n"); chmodSync(old, 0o755);
  expect(cmd(new ClaudeRuntime(), { ...opts, bin: old })).not.toContain("--fork-session");
  const codex = cmd(new CodexRuntime(), { ...opts, model });
  expect(codex.slice(-3)).toEqual(["resume", "ref", "Next"]);
  expect(codex).toEqual(cmd(new CodexRuntime(), { ...opts, model, fork: false }));
});

test("v13 upgrades existing agents and applies idempotently; reuse config defaults", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    db.exec("ALTER TABLE agents DROP COLUMN continues_agent_id; ALTER TABLE agents DROP COLUMN continuation_prompt_ref; ALTER TABLE agents DROP COLUMN continuation_started_at; ALTER TABLE agents DROP COLUMN diff_base; DELETE FROM _migrations WHERE version >= 13;");
    migrate(db); migrate(db);
    expect((db.query("PRAGMA table_info(agents)").all() as { name: string }[]).map(c => c.name))
      .toContain("continues_agent_id");
    expect(ConfigSchema.parse({ roles: { agent: "x", supervisor: "x", summary: "x" } }).agentReuse)
      .toEqual({ enabled: true, maxIdleHours: 24 });
  } finally { db.close(); }
});

test("real Git: fast-forward lineage, push its branch to PR, reject dirty/diverged worktrees", async () => {
  const { session, project, config, a, pr } = fixture();
  const root = mkdtempSync(join(tmpdir(), "tack-lineage-git-")); dirs.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "origin.git");
  const peer = join(root, "peer");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", repo);
  const identity = (dir: string) => {
    git(dir, "config", "user.name", "Test"); git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "commit.gpgsign", "false");
  };
  identity(repo);
  git(repo, "commit", "--allow-empty", "-m", "Base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "HEAD:pr-branch");
  git(root, "clone", "--branch", "pr-branch", remote, peer);
  identity(peer);
  writeFileSync(join(peer, "upstream"), "remote change");
  git(peer, "add", "."); git(peer, "commit", "-m", "Remote change"); git(peer, "push");
  const remoteHead = git(peer, "rev-parse", "HEAD");
  setAgentWorktree(a.id, repo, "main");
  mocks.push(spyOn(detached, "spawnAgentRunner").mockReturnValue(123));
  const result = await spawnPrFixAgent(session, pr, { ...project, path: repo }, config,
    { origin: "supervisor", conflict: false, baseBranch: "main", title: "PR" });
  expect(result.continued).toBe(a.id);
  expect(result.agent.diff_base).toBe(remoteHead);
  expect(git(repo, "rev-parse", "HEAD")).toBe(remoteHead);
  writeFileSync(join(repo, "fix"), "fix");
  git(repo, "add", "."); git(repo, "commit", "-m", "Fix");
  const patch = worktrees.worktreeDiff({ repo, path: repo, branch: "main", base: "HEAD" }, result.agent.diff_base!);
  expect(patch).toContain("fix");
  expect(patch).not.toContain("remote change");
  setAgentStatus(result.agent.id, "done");
  config.prWatch.autoPush = true; config.prWatch.reply = false;
  const { postFix } = await import("../src/prwatch/watch");
  await postFix(getAgent(result.agent.id)!, pr, { ...project, path: repo }, config, () => {});
  expect(getAgent(result.agent.id)!.fix_outcome).toBe("pushed");
  expect(git(remote, "rev-parse", "refs/heads/pr-branch")).toBe(git(repo, "rev-parse", "HEAD"));
  writeFileSync(join(repo, "dirty"), "untracked");
  expect(await worktrees.fastForwardPrWorktree(repo, "pr-branch")).toEqual({ reason: "dirty worktree" });
  rmSync(join(repo, "dirty"));
  git(repo, "commit", "--allow-empty", "-m", "Private local commit");
  git(peer, "pull", "--ff-only");
  git(peer, "commit", "--allow-empty", "-m", "Other remote commit"); git(peer, "push");
  expect(await worktrees.fastForwardPrWorktree(repo, "pr-branch")).toEqual({ reason: "non-fast-forwardable head" });
});

test("archive before a continuation starts still sends its next turn and forks", async () => {
  const { session, config, a } = fixture();
  prepareContinuation(session.id, a.id, "New instruction", config);
  const seen: RunOptions[] = [];
  mockRuntime(seen, [{ type: "session", ref: "child" }, { type: "done", ok: true }]);
  await runAgentToCompletion(a.id, config, { resume: true });
  expect(seen[0]).toMatchObject({ resume: true, fork: true, prompt: "New instruction" });
});

test("continue_agent allows a model switch within the runtime", () => {
  const { session, config, a } = fixture();
  config.models.push({ ...model, key: "alternate", id: "alternate" });
  const result = prepareContinuation(session.id, a.id, "Next", config, "alternate");
  expect(result).toMatchObject({ id: a.id, model: "alternate", runtime: "codex", resume_ref: "conversation" });
});

test("a queued PR continuation reserves the lineage during its remote fetch", async () => {
  const { session, project, config, pr } = fixture();
  let release!: (value: { base: string }) => void;
  mocks.push(spyOn(worktrees, "fastForwardPrWorktree").mockImplementation(() =>
    new Promise(resolve => { release = resolve; })));
  mocks.push(spyOn(detached, "spawnAgentRunner").mockReturnValue(123));
  const opts = { origin: "supervisor", conflict: false, baseBranch: "main", title: "PR" } as const;
  const first = spawnPrFixAgent(session, pr, project, config, opts);
  await expect(spawnPrFixAgent(session, pr, project, config, opts)).rejects.toThrow("already running");
  release({ base: "base" });
  expect((await first).continued).not.toBeNull();
});

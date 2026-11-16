import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Model, type TackConfig } from "../src/config/schema";
import {
  approveSessionPlan, createAgent, createSession, deleteSession, getAgent, getSession, listInterruptedAgents,
  listSessionPrs, listPrFixAgents, markAgentInterrupted, upsertSessionPr, type AgentRow,
} from "../src/db";
import {
  createManualWorkspace, manualProjectCandidates, manualWorkspaceDiff, resolveManualProject,
} from "../src/session/manual";
import { resolveEditTarget, worktreeEditSummary } from "../src/session/edit";
import { sessionFileCollisions } from "../src/supervisor/conflicts";
import { prepareContinuation } from "../src/agent/continue";
import { runAgent } from "../src/agent/execute";
import { runAgentToCompletion, spawnAgentRunner } from "../src/agent/detached";
import { sessionNeedsInput } from "../src/cli/liveness";
import { prContinuationDecision, prLineageHead } from "../src/prwatch/watch";
import { changedFiles, createWorktree } from "../src/worktree/worktree";
import * as worktrees from "../src/worktree/worktree";
import * as configLoad from "../src/config/load";
import * as prs from "../src/projects/prs";
import * as watch from "../src/prwatch/watch";
import * as detached from "../src/agent/detached";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSupervisorServer } from "../src/mcp/supervisor-server";
import { editorCommand } from "../src/util/editor";

const projects = (...names: string[]) => names;
const onProject = (project_name: string) => ({ project_name });

describe("manual project resolution", () => {
  test("candidates list the session's projects first, then the rest of the config", () => {
    expect(manualProjectCandidates(projects("a", "b", "c"), [onProject("c"), onProject("c"), onProject("gone")]))
      .toEqual(["c", "a", "b"]);
  });
  test("an explicit project must be configured", () => {
    expect(resolveManualProject(projects("a", "b"), [], "b")).toEqual({ ok: true, project: "b" });
    expect(resolveManualProject(projects("a", "b"), [], "zzz"))
      .toMatchObject({ ok: false, message: 'Unknown project "zzz".', candidates: ["a", "b"] });
  });
  test("omitted resolves to the only configured project", () => {
    expect(resolveManualProject(projects("solo"), [onProject("other")], undefined)).toEqual({ ok: true, project: "solo" });
  });
  test("omitted resolves to the session's only project", () => {
    expect(resolveManualProject(projects("a", "b"), [onProject("b"), onProject("b")], undefined))
      .toEqual({ ok: true, project: "b" });
  });
  test("ambiguous or empty configs list candidates", () => {
    expect(resolveManualProject(projects("a", "b"), [], undefined))
      .toMatchObject({ ok: false, candidates: ["a", "b"] });
    expect(resolveManualProject(projects("a", "b", "c"), [onProject("a"), onProject("c")], undefined))
      .toMatchObject({ ok: false, candidates: ["a", "c", "b"] });
    expect(resolveManualProject([], [], undefined)).toMatchObject({ ok: false, message: "No projects are configured." });
  });
});

// --- git fixtures: a real repo with an origin, so createWorktree behaves as in use.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tack-manual-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
let n = 0;
function repoFixture(): string {
  const dir = join(scratch, `case-${++n}`);
  mkdirSync(dir);
  const origin = join(dir, "origin.git");
  git(["init", "--quiet", "--bare", "--initial-branch=main", origin], dir);
  const repo = join(dir, "project");
  git(["clone", "--quiet", origin, repo], dir);
  for (const [k, v] of [["user.name", "Tack Test"], ["user.email", "tack@example.invalid"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]])
    git(["config", k!, v!], repo);
  writeFileSync(join(repo, "shared.txt"), "initial\n");
  git(["add", "."], repo);
  git(["commit", "--quiet", "-m", "initial"], repo);
  git(["push", "--quiet", "origin", "main"], repo);
  git(["remote", "set-head", "origin", "main"], repo);
  return repo;
}

const model: Model = { key: "test", id: "test", name: "Test", runtime: "codex", provider: "test", version: "1" };
const sessions: string[] = [];
afterEach(() => { for (const id of sessions.splice(0)) deleteSession(id); });
function sessionFixture() {
  const repo = repoFixture();
  const session = createSession({});
  sessions.push(session.id);
  approveSessionPlan(session.id);
  const config = ConfigSchema.parse({
    models: [model], projects: [{ name: "app", path: repo, description: "Test" }],
    roles: { agent: "test", supervisor: "test", summary: "test" },
    personas: [{ name: "strict", description: "Find bugs", whenToUse: "Use for code; skip docs" }],
  }) as unknown as TackConfig;
  return { repo, session, config };
}

const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const m of mocks.splice(0).reverse()) m.mockRestore(); });

/** Captures the supervisor server's registered tool handlers (same harness as
 * test/personas.test.ts), with the push/gh and watcher side effects stubbed. */
async function supervisorTools(sessionId: string, config: TackConfig) {
  mocks.push(spyOn(configLoad, "loadConfig").mockResolvedValue(config));
  mocks.push(spyOn(McpServer.prototype, "connect").mockResolvedValue());
  mocks.push(spyOn(worktrees, "syncBranchWithBase").mockResolvedValue({ status: "up_to_date", base: "main", fetched: true }));
  mocks.push(spyOn(watch, "spawnPrWatcher").mockReturnValue(null));
  mocks.push(spyOn(detached, "spawnAgentRunner").mockReturnValue(123));
  const open = spyOn(prs, "openSessionPr").mockResolvedValue({ url: `https://github.com/acme/app/pull/${sessionId}`, number: 9, headBranch: "pr" });
  mocks.push(open);
  const register = spyOn(McpServer.prototype, "registerTool"); mocks.push(register);
  await runSupervisorServer(sessionId);
  const handlers = new Map(register.mock.calls.map(c => [c[0], c[2]]));
  const call = async (name: string, args = {}) => {
    const handler = handlers.get(name) as unknown as (args: unknown) => Promise<{ content: { text: string }[] }>;
    return JSON.parse((await handler(args)).content[0]!.text);
  };
  return { call, open };
}

describe("PR-linked manual workspaces", () => {
  function fixture() {
    const f = sessionFixture();
    git(["push", "origin", "main:refs/heads/feature"], f.repo);
    upsertSessionPr({ sessionId: f.session.id, projectName: "app", number: 123, url: "https://example.com/pull/123", state: "open", headBranch: "feature" });
    return { ...f, pr: listSessionPrs(f.session.id)[0]! };
  }
  test("tracks and pushes to the PR branch, and reuses the workspace", () => {
    const { repo, session, config, pr } = fixture();
    const a = createManualWorkspace(config, session.id, "app", pr);
    expect(createManualWorkspace(config, session.id, "app", pr).id).toBe(a.id);
    expect(git(["branch", "--show-current"], a.worktree_path!)).toBe("feature");
    expect(git(["rev-parse", "--abbrev-ref", "@{upstream}"], a.worktree_path!)).toBe("origin/feature");
    writeFileSync(join(a.worktree_path!, "shared.txt"), "edit\n");
    git(["commit", "-am", "edit"], a.worktree_path!);
    git(["push"], a.worktree_path!);
    expect(git(["rev-parse", "HEAD"], a.worktree_path!)).toBe(git(["rev-parse", "origin/feature"], repo));
    const summary = worktreeEditSummary(a, [pr], a.worktree_path!).join("\n");
    expect(summary).toContain("tracks PR #123");
    expect(summary).toContain("Ahead 0, behind 0");
    expect(summary).toContain("git push");
    expect(summary).not.toContain("open a PR");
    expect(listPrFixAgents(pr.id)).toEqual([]);
    expect(prLineageHead(pr)).toBeNull();
  });
  test("recreates a stale branch with no unpushed commits", () => {
    const { session, config, pr } = fixture();
    const a = createManualWorkspace(config, session.id, "app", pr);
    rmSync(a.worktree_path!, { recursive: true, force: true });
    const replacement = createManualWorkspace(config, session.id, "app", pr);
    expect(replacement.id).not.toBe(a.id);
    expect(git(["rev-parse", "--abbrev-ref", "@{upstream}"], replacement.worktree_path!)).toBe("origin/feature");
  });
  test("refuses a stale branch with unpushed commits", () => {
    const { session, config, pr } = fixture();
    const a = createManualWorkspace(config, session.id, "app", pr);
    writeFileSync(join(a.worktree_path!, "shared.txt"), "private\n");
    git(["commit", "-am", "private"], a.worktree_path!);
    rmSync(a.worktree_path!, { recursive: true, force: true });
    expect(() => createManualWorkspace(config, session.id, "app", pr)).toThrow("unpushed commits");
  });
  test("open_pr refuses the linked row", async () => {
    const { session, config, pr } = fixture();
    const a = createManualWorkspace(config, session.id, "app", pr);
    const { call } = await supervisorTools(session.id, config);
    await expect(call("open_pr", { agentId: a.id, title: "x", body: "x" })).rejects.toThrow("linked to PR #123");
  });
});

describe("supervisor tools on manual workspaces", () => {
  test("open_pr refuses a manual workspace with no changes", async () => {
    const { session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    const { call, open } = await supervisorTools(session.id, config);
    await expect(call("open_pr", { agentId: m.id, title: "Nothing", body: "x" })).rejects.toThrow("made no changes");
    expect(open).not.toHaveBeenCalled();
    expect(getAgent(m.id)!.diff_ref).toBeNull();
  });

  test("open_pr commits tracked and untracked edits and saves the diff", async () => {
    const { repo, session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    writeFileSync(join(m.worktree_path!, "shared.txt"), "human edit\n");
    writeFileSync(join(m.worktree_path!, "new.txt"), "brand new\n");
    const { call, open } = await supervisorTools(session.id, config);
    expect(await call("open_pr", { agentId: m.id, title: "Hand edits", body: "x" }))
      .toMatchObject({ ok: true, number: 9 });
    expect(open.mock.calls[0]![0]).toMatchObject({ localBranch: m.branch, repoPath: repo, body: "x" });
    await call("open_pr", { agentId: m.id, title: "Hand edits", body: "x", skipReview: "ignored" });
    expect(open.mock.calls[1]![0].body).toBe("x");
    expect(git(["status", "--porcelain"], m.worktree_path!)).toBe("");
    expect(git(["show", "--name-only", "--format=%s", "HEAD"], m.worktree_path!).split("\n"))
      .toEqual(["Hand edits", "", "new.txt", "shared.txt"]);
    const diff = readFileSync(getAgent(m.id)!.diff_ref!, "utf8");
    expect(diff).toContain("+human edit");
    expect(diff).toContain("+brand new");
    expect(listSessionPrs(session.id)[0]).toMatchObject({ agent_id: m.id, number: 9 });
  });

  test("read_agent_output returns the live diff, untracked files included", async () => {
    const { session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    const { call } = await supervisorTools(session.id, config);
    expect(await call("read_agent_output", { agentId: m.id })).toMatchObject({ kind: "manual", diffPreview: "(no diff)" });
    writeFileSync(join(m.worktree_path!, "shared.txt"), "human edit\n");
    writeFileSync(join(m.worktree_path!, "new.txt"), "new\n");
    const out = await call("read_agent_output", { agentId: m.id });
    expect(out.output).toContain("manual workspace");
    expect(out.diffPreview).toContain("+human edit");
    expect(out.diffPreview).toContain("#   new.txt");
  });

  test("review_agent refuses a manual workspace", async () => {
    const { session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    const { call } = await supervisorTools(session.id, config);
    await expect(call("review_agent", { agentId: m.id, persona: "strict" })).rejects.toThrow("manual-workspace rows cannot");
  });
});

test("changedFiles counts untracked files, so a same-named new file collides", () => {
  const { repo, session, config } = sessionFixture();
  const a = createWorktree(repo, session.id, "agt_untracked_a");
  const b = createWorktree(repo, session.id, "agt_untracked_b");
  for (const wt of [a, b]) writeFileSync(join(wt.path, "fresh.txt"), wt.path);
  expect(changedFiles(repo, a.branch, a.path)).toEqual(["fresh.txt"]);
  const row = (id: string, wt: typeof a): AgentRow =>
    ({ ...createAgent({ sessionId: session.id, projectName: "app" }), id, status: "done", worktree_path: wt.path, branch: wt.branch });
  expect(sessionFileCollisions([row("agt_untracked_a", a), row("agt_untracked_b", b)], config))
    .toEqual([{ project: "app", file: "fresh.txt", agents: ["agt_untracked_a", "agt_untracked_b"] }]);
});

describe("createManualWorkspace", () => {
  test("creates a done, runtime-less row on its own tack/<session>/<id> worktree", () => {
    const { repo, session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    expect(m).toMatchObject({
      kind: "manual", status: "done", runtime: null, model: null, pid: null, resume_ref: null,
      prompt_ref: null, output_ref: null, cost: 0, finished_at: null, project_name: "app",
      branch: `tack/${session.id}/${m.id}`,
    });
    expect(existsSync(m.worktree_path!)).toBe(true);
    expect(git(["rev-parse", "HEAD"], m.worktree_path!)).toBe(git(["rev-parse", "origin/main"], repo));
    expect(m.diff_base).toBe(git(["rev-parse", "origin/main"], repo));
    expect(() => createManualWorkspace(config, session.id, "nope")).toThrow('Unknown project "nope"');
  });

  test("never reads as unread work and is never marked interrupted", () => {
    const { session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    expect(sessionNeedsInput(getSession(session.id)!, [m])).toBe(false);
    markAgentInterrupted(m.id);
    expect(listInterruptedAgents(session.id)).toEqual([]);
  });

  test("diff is read live, including untracked files", () => {
    const { repo, session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    expect(manualWorkspaceDiff(m, repo)).toBe("");
    writeFileSync(join(m.worktree_path!, "shared.txt"), "human edit\n");
    writeFileSync(join(m.worktree_path!, "new.txt"), "new\n");
    const diff = manualWorkspaceDiff(m, repo);
    expect(diff).toContain("+human edit");
    expect(diff).toContain("#   new.txt");
  });

  test("check_conflicts includes manual rows, and sees fresh hand edits", () => {
    const { repo, session, config } = sessionFixture();
    const worker = createAgent({ sessionId: session.id, projectName: "app" });
    const wt = createWorktree(repo, session.id, worker.id);
    const workerRow: AgentRow = { ...worker, status: "done", worktree_path: wt.path, branch: wt.branch };
    writeFileSync(join(wt.path, "shared.txt"), "agent\n");
    const m = createManualWorkspace(config, session.id, "app");
    expect(sessionFileCollisions([workerRow, m], config)).toEqual([]);
    // Same rows (no updated_at change) — the edit alone must surface the collision.
    writeFileSync(join(m.worktree_path!, "shared.txt"), "human\n");
    expect(sessionFileCollisions([workerRow, m], config))
      .toEqual([{ project: "app", file: "shared.txt", agents: [worker.id, m.id].sort() }]);
  });

  test("edit summary points the human at open_pr", () => {
    const { session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    expect(worktreeEditSummary(m, [], m.worktree_path!).at(-1)).toContain(`open a PR for ${m.id}`);
  });
});

describe("manual rows are never executed", () => {
  test("continue_agent refuses with a clear error", () => {
    const { session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    expect(() => prepareContinuation(session.id, m.id, "keep going", config)).toThrow(/Manual workspaces .* can't be continued/);
    expect(getAgent(m.id)).toMatchObject({ status: "done", continuation_prompt_ref: null });
  });

  test("runners refuse before stamping a pid or touching status", async () => {
    const { session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    await expect(runAgentToCompletion(m.id, config)).rejects.toThrow(/manual workspace/);
    await expect(runAgent(m.id, config).next()).rejects.toThrow(/manual workspace/);
    expect(() => spawnAgentRunner(session.id, m.id)).toThrow(/manual workspace/);
    expect(getAgent(m.id)).toMatchObject({ status: "done", pid: null, runtime: null });
  });

  test("fix_pr on a PR opened from a manual workspace falls back to a fresh fix", async () => {
    const { session, config } = sessionFixture();
    const m = createManualWorkspace(config, session.id, "app");
    upsertSessionPr({ sessionId: session.id, agentId: m.id, projectName: "app", number: 7,
      url: "https://example.com/pull/7", state: "open", headBranch: "tack/pr/x" });
    const pr = listSessionPrs(session.id)[0]!;
    expect(await prContinuationDecision(pr, model, config))
      .toEqual({ head: null, reason: "manual workspace has no conversation" });
  });
});

describe("edit target with manual rows", () => {
  const base = createAgent({ sessionId: createSession({}).id, projectName: "test" });
  const manual = (overrides: Partial<AgentRow> = {}): AgentRow =>
    ({ ...base, id: "agt_manual", kind: "manual", status: "done", worktree_path: "/tree", branch: "b", ...overrides });
  const exists = (p: string) => p === "/tree";
  test("reopens by id and auto-picks a sole manual workspace", () => {
    const m = manual();
    expect(resolveEditTarget([m], m.id, exists)).toEqual({ ok: true, agent: m, path: "/tree" });
    expect(resolveEditTarget([m], undefined, exists)).toEqual({ ok: true, agent: m, path: "/tree" });
  });
  test("never asks for the running override", () => {
    const m = manual({ status: "running" });
    expect(resolveEditTarget([m], m.id, exists)).toMatchObject({ ok: true });
  });
  test("counts toward ambiguity like any worktree", () => {
    expect(resolveEditTarget([manual(), manual({ id: "agt_other", kind: null })], undefined, exists))
      .toMatchObject({ ok: false, reason: "ambiguous" });
  });
});

test("editor fallback prefers vim, else vi, after $VISUAL/$EDITOR", () => {
  if (process.platform === "win32") return;
  expect(editorCommand({ VISUAL: "code --wait", EDITOR: "nano" }, () => true)).toEqual(["code", "--wait"]);
  expect(editorCommand({ EDITOR: "nano" }, () => true)).toEqual(["nano"]);
  expect(editorCommand({}, () => true)).toEqual(["vim"]);
  expect(editorCommand({}, () => false)).toEqual(["vi"]);
});

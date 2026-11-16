import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Model, type TackConfig } from "../src/config/schema";
import {
  approveSessionPlan, createAgent, createSession, deleteSession, getAgent, getSession, listInterruptedAgents,
  listSessionPrs, markAgentInterrupted, upsertSessionPr, type AgentRow,
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
import { prContinuationDecision } from "../src/prwatch/watch";
import { createWorktree } from "../src/worktree/worktree";
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
  }) as unknown as TackConfig;
  return { repo, session, config };
}

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
